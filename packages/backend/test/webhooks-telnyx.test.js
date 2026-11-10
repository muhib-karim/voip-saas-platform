import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupTestEnv, createTelnyxSigner } from './helpers.js';

// Offline: every request here is either rejected before the handler runs, or
// carries an event type the handler ignores, so no database is needed. The
// DB-backed behaviour of signed call events is in test/db/telnyx-billing.db.test.js.
const signer = createTelnyxSigner();
setupTestEnv({ TELNYX_PUBLIC_KEY: signer.publicKeyBase64 });

const { default: app } = await import('../src/app.js');
const { default: db } = await import('../src/config/database.js');
const { resetRateLimitMemory } = await import('../src/middleware/rateLimiter.js');

beforeEach(() => resetRateLimitMemory());
after(() => db.destroy());

const event = (eventType = 'call.dtmf.received') => JSON.stringify({
    data: {
        record_type: 'event',
        event_type: eventType,
        id: '0ccc7b54-4df3-4bca-a65a-3da1ecc777f0',
        occurred_at: new Date().toISOString(),
        payload: { call_control_id: 'v3:test-call', digit: '1' }
    },
    meta: { attempt: 1 }
});

const post = (path, body, headers = {}) =>
    request(app).post(path).set('Content-Type', 'application/json').set(headers).send(body);

test('a correctly signed webhook is accepted', async () => {
    const body = event();
    const res = await post('/api/webhooks/telnyx', body, signer.sign(body));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true });
});

test('the /telnyx/call URL given to Telnyx for outbound calls answers', async () => {
    // This path used to recurse until the stack overflowed and never respond.
    const body = event();
    const res = await post('/api/webhooks/telnyx/call', body, signer.sign(body)).timeout(5000);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true });
});

test('an unsigned webhook is rejected', async () => {
    for (const path of ['/api/webhooks/telnyx', '/api/webhooks/telnyx/call']) {
        const res = await post(path, event('call.hangup'));
        assert.equal(res.status, 400, path);
        assert.deepEqual(res.body, { error: 'Invalid signature' });
    }
});

test('a signature from a different key is rejected', async () => {
    const body = event('call.hangup');
    const res = await post('/api/webhooks/telnyx', body, createTelnyxSigner().sign(body));
    assert.equal(res.status, 400);
});

test('a valid signature does not cover a modified body', async () => {
    const headers = signer.sign(event('call.dtmf.received'));
    const res = await post('/api/webhooks/telnyx', event('call.hangup'), headers);
    assert.equal(res.status, 400);
});

test('a valid signature does not cover a modified timestamp', async () => {
    const body = event();
    const headers = signer.sign(body);
    headers['telnyx-timestamp'] = String(Number(headers['telnyx-timestamp']) + 1);
    assert.equal((await post('/api/webhooks/telnyx', body, headers)).status, 400);
});

test('a correctly signed but old webhook is rejected (replay)', async () => {
    const body = event();
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const res = await post('/api/webhooks/telnyx', body, signer.sign(body, tenMinutesAgo));
    assert.equal(res.status, 400);
});

test('a webhook dated in the future is rejected', async () => {
    const body = event();
    const tenMinutesAhead = Math.floor(Date.now() / 1000) + 600;
    assert.equal((await post('/api/webhooks/telnyx', body, signer.sign(body, tenMinutesAhead))).status, 400);
});

test('a non-numeric timestamp is rejected', async () => {
    const body = event();
    const headers = { ...signer.sign(body), 'telnyx-timestamp': 'now' };
    assert.equal((await post('/api/webhooks/telnyx', body, headers)).status, 400);
});

test('the signature is checked against the raw bytes, whatever the content type', async () => {
    const body = event();
    const res = await request(app)
        .post('/api/webhooks/telnyx')
        .set('Content-Type', 'text/plain')
        .set(signer.sign(body))
        .send(body);
    assert.equal(res.status, 200);
});
