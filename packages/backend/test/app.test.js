import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { setupTestEnv, TEST_JWT_SECRET } from './helpers.js';

// These tests exercise the HTTP layer only: every request below is answered by
// middleware (auth, validation, rate limiting, 404) before any database or
// third-party call is made, so no Postgres/Redis/Telnyx/Stripe is required.
setupTestEnv();
const { default: app } = await import('../src/app.js');
const { default: db } = await import('../src/config/database.js');

after(() => db.destroy());

const token = (payload = { userId: 'user-1', email: 'u@example.com', type: 'access' }, opts = { expiresIn: '15m' }) =>
    jwt.sign(payload, TEST_JWT_SECRET, opts);

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
    const expired = token({ userId: 'user-1', exp: Math.floor(Date.now() / 1000) - 60 }, {});
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
