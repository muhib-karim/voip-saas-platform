import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { setupTestEnv, signAccessToken, TEST_JWT_SECRET } from './helpers.js';

// These tests exercise the HTTP layer only: every request below is answered by
// middleware (auth, validation, rate limiting, 404) before any database or
// third-party call is made, so no Postgres/Redis/Telnyx/Stripe is required.
setupTestEnv();
const { default: app } = await import('../src/app.js');
const { default: db } = await import('../src/config/database.js');
const { resetRateLimitMemory } = await import('../src/middleware/rateLimiter.js');

beforeEach(() => resetRateLimitMemory());
after(() => db.destroy());

const token = signAccessToken;

test('GET /health reports ok', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)));
});

test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Not found', path: '/api/does-not-exist' });
});

test('security headers are set by helmet', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
});

test('API responses carry rate-limit headers', async () => {
    const res = await request(app).get('/api/wallet');
    assert.equal(res.headers['x-ratelimit-limit'], '100');
});

for (const [method, path] of [
    ['get', '/api/wallet'],
    ['get', '/api/numbers'],
    ['get', '/api/calls/history'],
    ['get', '/api/auth/me']
]) {
    test(`${method.toUpperCase()} ${path} requires a bearer token`, async () => {
        const res = await request(app)[method](path);
        assert.equal(res.status, 401);
        assert.equal(res.body.message, 'No token provided');
    });
}

test('a token signed with the wrong secret is rejected', async () => {
    const forged = jwt.sign({ userId: 'user-1' }, 'some-other-secret');
    const res = await request(app).get('/api/wallet').set('Authorization', `Bearer ${forged}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid token');
});

test('an expired token is reported as expired', async () => {
    const expired = token({ userId: 'user-1', type: 'access', exp: Math.floor(Date.now() / 1000) - 60 }, { expiresIn: undefined });
    const res = await request(app).get('/api/wallet').set('Authorization', `Bearer ${expired}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Token expired');
});

test('POST /api/wallet/topup rejects amounts below the $5 minimum', async () => {
    const res = await request(app)
        .post('/api/wallet/topup')
        .set('Authorization', `Bearer ${token()}`)
        .send({ amount: 2 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Validation Error');
});

test('POST /api/calls requires from and to numbers', async () => {
    const res = await request(app)
        .post('/api/calls')
        .set('Authorization', `Bearer ${token()}`)
        .send({ to: '+14155550123' });
    assert.equal(res.status, 400);
    assert.equal(res.body.details[0].field, 'from');
});

test('GET /api/numbers/search rejects an unknown number type', async () => {
    const res = await request(app)
        .get('/api/numbers/search?type=satellite')
        .set('Authorization', `Bearer ${token()}`);
    assert.equal(res.status, 400);
});

test('POST /api/auth/register validates the payload before touching the database', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'nope' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Validation failed');
});

test('POST /api/rates/estimate requires a country code', async () => {
    const res = await request(app).post('/api/rates/estimate').send({ duration: 3 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Country code is required');
});

test('Stripe webhooks with an invalid signature are rejected', async () => {
    const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', 't=1,v1=deadbeef')
        .send(JSON.stringify({ type: 'checkout.session.completed' }));
    assert.equal(res.status, 400);
});

// ---- JWT handling ----------------------------------------------------------

// An authenticated route whose validation fails right after the auth guard:
// 400 means the token was accepted, 401 means it was not, and no database is
// involved either way.
const authedGet = (bearer) => request(app).delete('/api/numbers/not-a-uuid').set('Authorization', `Bearer ${bearer}`);

test('a well-formed access token gets past the auth guard', async () => {
    const res = await authedGet(token());
    assert.equal(res.status, 400);
});

test('tokens signed with another HMAC algorithm are rejected', async () => {
    for (const algorithm of ['HS384', 'HS512']) {
        const res = await authedGet(token(undefined, { algorithm }));
        assert.equal(res.status, 401, algorithm);
        assert.equal(res.body.message, 'Invalid token');
    }
});

test('unsigned (alg: none) tokens are rejected', async () => {
    const unsigned = jwt.sign({ userId: 'user-1', type: 'access' }, null, { algorithm: 'none' });
    assert.equal((await authedGet(unsigned)).status, 401);
});

test('a token that is not an access token is rejected', async () => {
    assert.equal((await authedGet(token({ userId: 'user-1', type: 'refresh' }))).status, 401);
    assert.equal((await authedGet(token({ userId: 'user-1' }))).status, 401);
});

test('a token without a user id is rejected', async () => {
    assert.equal((await authedGet(token({ type: 'access' }))).status, 401);
    assert.equal((await authedGet(token({ userId: 42, type: 'access' }))).status, 401);
});

test('a token without an expiry is rejected', async () => {
    const res = await authedGet(token({ userId: 'user-1', type: 'access' }, { expiresIn: undefined }));
    assert.equal(res.status, 401);
});

test('tokens for another issuer or audience are rejected', async () => {
    assert.equal((await authedGet(token(undefined, { issuer: 'someone-else' }))).status, 401);
    assert.equal((await authedGet(token(undefined, { audience: 'another-app' }))).status, 401);
    const bare = jwt.sign({ userId: 'user-1', type: 'access' }, TEST_JWT_SECRET, { expiresIn: '15m' });
    assert.equal((await authedGet(bare)).status, 401);
});

// ---- Input validation: each of these used to reach the database or crash ----

test('register rejects a non-string email instead of crashing', async () => {
    const res = await request(app).post('/api/auth/register').send({
        email: ['someone@example.com'], password: 'long-enough-password', firstName: 'A', lastName: 'B'
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.details, ['email is invalid']);
});

test('login rejects a non-string password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'someone@example.com', password: 12345678 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.details, ['password is invalid', 'password is invalid']);
});

test('refresh treats a malformed token as missing', async () => {
    for (const refreshToken of [{ a: 1 }, ['x'], 12345, 'not-a-token', 'a'.repeat(127)]) {
        const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
        assert.equal(res.status, 401, JSON.stringify(refreshToken));
        assert.equal(res.body.error, 'Refresh token required');
    }
});

test('cookie-based refresh and logout reject cross-site origins', async () => {
    const tok = 'a'.repeat(128);
    for (const path of ['/api/auth/refresh', '/api/auth/logout']) {
        const byFetchSite = await request(app)
            .post(path)
            .set('Cookie', `refreshToken=${tok}`)
            .set('Sec-Fetch-Site', 'cross-site');
        assert.equal(byFetchSite.status, 403, `${path} Sec-Fetch-Site`);

        const byOrigin = await request(app)
            .post(path)
            .set('Cookie', `refreshToken=${tok}`)
            .set('Origin', 'https://evil.example');
        assert.equal(byOrigin.status, 403, `${path} Origin`);
    }
});

test('non-UUID ids are rejected before any query runs', async () => {
    const auth = { Authorization: `Bearer ${token()}` };
    const numbers = await request(app).delete('/api/numbers/not-a-uuid').set(auth);
    assert.equal(numbers.status, 400);
    assert.equal(numbers.body.details[0].field, 'id');

    const sessions = await request(app).delete('/api/auth/sessions/xyz').set(auth);
    assert.equal(sessions.status, 400);
});

test('POST /api/calls requires E.164 numbers', async () => {
    const auth = { Authorization: `Bearer ${token()}` };
    for (const body of [
        { from: '+14155550100', to: '4155550123' },
        { from: 'anonymous', to: '+14155550123' },
        { from: '+14155550100', to: ['+14155550123'] },
        { from: '+14155550100', to: '+1415555012345678' }
    ]) {
        const res = await request(app).post('/api/calls').set(auth).send(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.body.error, 'Validation Error');
    }
});

test('POST /api/numbers/purchase requires an E.164 number', async () => {
    const res = await request(app)
        .post('/api/numbers/purchase')
        .set('Authorization', `Bearer ${token()}`)
        .send({ phoneNumber: "+1415555'; DROP TABLE users;--" });
    assert.equal(res.status, 400);
});

test('POST /api/wallet/topup enforces the maximum and two decimal places', async () => {
    const auth = { Authorization: `Bearer ${token()}` };
    for (const amount of [1000.01, 1e12, 5.555, '25', null, [25]]) {
        const res = await request(app).post('/api/wallet/topup').set(auth).send({ amount });
        assert.equal(res.status, 400, JSON.stringify(amount));
    }
});

test('list endpoints reject unknown filter values', async () => {
    const auth = { Authorization: `Bearer ${token()}` };
    for (const url of [
        '/api/calls/history?status=exploded',
        '/api/calls/history?direction=sideways',
        '/api/calls/history?startDate=yesterday-ish',
        '/api/calls/history?status[]=completed',
        '/api/calls/stats?period=forever',
        '/api/wallet/transactions?type=gift',
        '/api/numbers/search?countryCode=USA1',
        '/api/numbers/search?limit=lots'
    ]) {
        const res = await request(app).get(url).set(auth);
        assert.equal(res.status, 400, url);
    }
});

test('rates endpoints validate their input', async () => {
    assert.equal((await request(app).post('/api/rates/estimate').send({ countryCode: 44 })).status, 400);
    assert.equal((await request(app).post('/api/rates/estimate').send({ countryCode: 'GB', duration: -3 })).status, 400);
    assert.equal((await request(app).post('/api/rates/estimate').send({ countryCode: 'GB', duration: '3' })).status, 400);
    assert.equal((await request(app).post('/api/rates/estimate').send({ countryCode: 'GB', numberType: 'satellite' })).status, 400);
    assert.equal((await request(app).get('/api/rates/G%27B')).status, 400);
    assert.equal((await request(app).get('/api/rates?q[]=a')).status, 400);
});

test('malformed JSON is a 400, not a 500', async () => {
    const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email": "a@example.com", ');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Bad Request', message: 'Malformed JSON in request body' });
});

// ---- Rate limiting ----------------------------------------------------------

test('login attempts are limited even though Redis is not running', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
        // Invalid payload: answered by validation, so no database is needed.
        statuses.push((await request(app).post('/api/auth/login').send({ email: 'nope' })).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
    assert.deepEqual(statuses.slice(10), [429, 429]);
});

test('webhooks are not counted against the general API limit', async () => {
    const send = () => request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', 't=1,v1=deadbeef')
        .send('{}');

    let last;
    for (let i = 0; i < 105; i++) last = await send();

    assert.equal(last.status, 400, 'request 105 is still answered by the handler, not a 429');
    assert.equal(last.headers['x-ratelimit-limit'], '500');

    // The API limiter has not been consumed by those webhook calls.
    const api = await request(app).get('/api/wallet');
    assert.equal(api.headers['x-ratelimit-limit'], '100');
    assert.equal(api.headers['x-ratelimit-remaining'], '99');
});

// ---- Webhooks ---------------------------------------------------------------

test('Stripe webhook errors do not echo internal messages', async () => {
    const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', 't=1,v1=deadbeef')
        .send(JSON.stringify({ type: 'checkout.session.completed' }));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid signature' });
});

test('Telnyx webhooks are refused when no public key is configured', async () => {
    // This process has no TELNYX_PUBLIC_KEY: nothing can be verified, so nothing is trusted.
    for (const path of ['/api/webhooks/telnyx', '/api/webhooks/telnyx/call']) {
        const res = await request(app)
            .post(path)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify({ data: { event_type: 'call.hangup', payload: { call_control_id: 'x' } } }));
        assert.equal(res.status, 503, path);
    }
});
