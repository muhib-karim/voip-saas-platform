import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { setupDbTest } from '../helpers.js';

const ctx = await setupDbTest();
const { skip, db } = ctx;
const app = ctx.enabled ? (await import('../../src/app.js')).default : null;
const authService = ctx.enabled ? (await import('../../src/services/auth.service.js')).default : null;
const { resetRateLimitMemory } = ctx.enabled ? await import('../../src/middleware/rateLimiter.js') : {};

beforeEach(() => resetRateLimitMemory?.());
after(() => ctx.cleanup());

const PASSWORD = 'correct-horse-battery';
const newEmail = () => `auth-${crypto.randomBytes(6).toString('hex')}@example.com`;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Pull the refresh token out of a Set-Cookie header (null when absent or cleared). */
function refreshCookie(res) {
    const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith('refreshToken='));
    if (!header) return null;
    const value = header.split(';')[0].slice('refreshToken='.length);
    return value || null;
}
const setsRefreshCookie = (res) => (res.headers['set-cookie'] || []).some((c) => c.startsWith('refreshToken='));

async function registerUser(email = newEmail()) {
    const res = await request(app).post('/api/auth/register').send({ email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' });
    assert.equal(res.status, 201);
    return { email, userId: res.body.user.id, accessToken: res.body.accessToken, refreshToken: refreshCookie(res) };
}

const refresh = (token) => request(app).post('/api/auth/refresh').set('Cookie', `refreshToken=${token}`);
const liveTokens = (userId) => db('refresh_tokens').where({ user_id: userId, revoked: false });

/** Make a revoked token look like it was rotated a while ago, outside the grace window. */
const ageRevocation = (token) => db('refresh_tokens')
    .where({ token_hash: sha256(token) })
    .update({ revoked_at: db.raw("now() - interval '1 minute'") });

test('register issues an access token and an HttpOnly refresh cookie', { skip }, async () => {
    const res = await request(app).post('/api/auth/register').send({ email: newEmail(), password: PASSWORD, firstName: 'A', lastName: 'B' });

    assert.equal(res.status, 201);
    assert.ok(res.body.accessToken);
    assert.equal(res.body.refreshToken, undefined, 'the refresh token is never in the body');
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('refreshToken='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(refreshCookie(res), /^[0-9a-f]{128}$/);
});

test('refresh rotates the token: the old one stops working, the new one works', { skip }, async () => {
    const user = await registerUser();

    const first = await refresh(user.refreshToken);
    assert.equal(first.status, 200);
    const rotated = refreshCookie(first);
    assert.ok(rotated && rotated !== user.refreshToken);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${first.body.accessToken}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.email, user.email);

    assert.equal((await refresh(rotated)).status, 200);
    assert.equal((await liveTokens(user.userId)).length, 1);
});

test('one refresh token cannot be redeemed twice concurrently', { skip }, async () => {
    const user = await registerUser();

    const responses = await Promise.all([refresh(user.refreshToken), refresh(user.refreshToken), refresh(user.refreshToken)]);
    const statuses = responses.map((r) => r.status).sort();

    assert.deepEqual(statuses, [200, 409, 409], 'exactly one caller gets a new token');
    assert.equal((await liveTokens(user.userId)).length, 1, 'only one live token exists afterwards');

    // The losers must not clear the cookie the winner has just been given.
    for (const loser of responses.filter((r) => r.status === 409)) {
        assert.equal(setsRefreshCookie(loser), false);
        assert.equal(loser.body.code, 'REFRESH_CONFLICT');
    }

    const winner = responses.find((r) => r.status === 200);
    assert.equal((await refresh(refreshCookie(winner))).status, 200, 'the winner\'s session carries on');
});

test('replaying a rotated token revokes the whole session family', { skip }, async () => {
    const user = await registerUser();
    const first = await refresh(user.refreshToken);
    const second = await refresh(refreshCookie(first));
    const current = refreshCookie(second);
    await ageRevocation(user.refreshToken);

    // Someone presents the original, long-rotated token again.
    const replay = await refresh(user.refreshToken);

    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'TOKEN_REUSED');
    assert.match(replay.headers['set-cookie'].find((c) => c.startsWith('refreshToken=')), /^refreshToken=;/, 'cookie cleared');
    assert.equal((await liveTokens(user.userId)).length, 0);
    assert.equal((await refresh(current)).status, 401, 'the newest token in that family is dead too');
});

test('reuse in one session does not log out the user\'s other devices', { skip }, async () => {
    const user = await registerUser();
    const otherDevice = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const otherToken = refreshCookie(otherDevice);

    await refresh(user.refreshToken);
    await ageRevocation(user.refreshToken);
    assert.equal((await refresh(user.refreshToken)).status, 401);

    assert.equal((await refresh(otherToken)).status, 200);
});

test('an expired refresh token is rejected', { skip }, async () => {
    const user = await registerUser();
    await db('refresh_tokens').where({ token_hash: sha256(user.refreshToken) }).update({ expires_at: new Date(Date.now() - 1000) });

    const res = await refresh(user.refreshToken);

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid or expired refresh token');
});

test('an unknown refresh token is rejected', { skip }, async () => {
    const res = await refresh(crypto.randomBytes(64).toString('hex'));
    assert.equal(res.status, 401);
});

test('logout revokes the refresh token', { skip }, async () => {
    const user = await registerUser();

    const out = await request(app).post('/api/auth/logout').set('Cookie', `refreshToken=${user.refreshToken}`);

    assert.equal(out.status, 200);
    assert.notEqual((await refresh(user.refreshToken)).status, 200);
    assert.equal((await liveTokens(user.userId)).length, 0);
});

test('changing the password revokes every session', { skip }, async () => {
    const user = await registerUser();
    const second = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });

    const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });

    assert.equal(res.status, 200);
    assert.equal((await liveTokens(user.userId)).length, 0);
    assert.notEqual((await refresh(refreshCookie(second))).status, 200);
    assert.equal((await request(app).post('/api/auth/login').send({ email: user.email, password: 'a-brand-new-password' })).status, 200);
});

test('wrong password and unknown email are indistinguishable, and both run bcrypt', { skip }, async (t) => {
    const user = await registerUser();
    const compare = t.mock.method(bcrypt, 'compare');

    const wrongPassword = await request(app).post('/api/auth/login').send({ email: user.email, password: 'not-the-password' });
    const unknownEmail = await request(app).post('/api/auth/login').send({ email: newEmail(), password: 'not-the-password' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.deepEqual(wrongPassword.body, unknownEmail.body);
    assert.deepEqual(wrongPassword.body, { error: 'Unauthorized', message: 'Invalid email or password' });
    assert.equal(compare.mock.callCount(), 2, 'one comparison per attempt, user or no user');
});

test('a very long User-Agent does not break login', { skip }, async () => {
    const user = await registerUser();

    const res = await request(app)
        .post('/api/auth/login')
        .set('User-Agent', 'x'.repeat(600))
        .send({ email: user.email, password: PASSWORD });

    assert.equal(res.status, 200);
});

test('registering an existing email is a 400, also when two requests race', { skip }, async () => {
    const email = newEmail();
    const body = { email, password: PASSWORD, firstName: 'A', lastName: 'B' };

    const [a, b] = await Promise.all([
        request(app).post('/api/auth/register').send(body),
        request(app).post('/api/auth/register').send(body)
    ]);
    const again = await request(app).post('/api/auth/register').send(body);

    assert.deepEqual([a.status, b.status].sort(), [201, 400]);
    assert.equal(again.status, 400);
    assert.equal(again.body.message, 'Email already registered');
    assert.equal((await db('users').where({ email })).length, 1);
});

test('a user can only revoke their own sessions', { skip }, async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const [aliceSession] = await liveTokens(alice.userId);

    const res = await request(app)
        .delete(`/api/auth/sessions/${aliceSession.id}`)
        .set('Authorization', `Bearer ${bob.accessToken}`);

    assert.equal(res.status, 200);
    assert.equal((await liveTokens(alice.userId)).length, 1, 'Alice is still logged in');

    await request(app).delete(`/api/auth/sessions/${aliceSession.id}`).set('Authorization', `Bearer ${alice.accessToken}`);
    assert.equal((await liveTokens(alice.userId)).length, 0);
});

test('cleanup removes expired tokens but keeps revoked ones as reuse evidence', { skip }, async () => {
    const user = await registerUser();
    await refresh(user.refreshToken); // rotates: original is now revoked but not expired
    const expired = await registerUser();
    await db('refresh_tokens').where({ user_id: expired.userId }).update({ expires_at: new Date(Date.now() - 1000) });

    await authService.cleanupExpiredTokens();

    assert.equal((await db('refresh_tokens').where({ token_hash: sha256(user.refreshToken) })).length, 1);
    assert.equal((await db('refresh_tokens').where({ user_id: expired.userId })).length, 0);
});

test('the access token from login carries pinned algorithm and claims', { skip }, async () => {
    const user = await registerUser();
    const [header, payload] = user.accessToken.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url')));

    assert.equal(header.alg, 'HS256');
    assert.equal(payload.type, 'access');
    assert.equal(payload.userId, user.userId);
    assert.equal(payload.iss, 'voip-saas-api');
    assert.equal(payload.aud, 'voip-saas-clients');
    assert.equal(payload.exp - payload.iat, 15 * 60);
});
