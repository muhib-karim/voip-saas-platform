import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDbTest, createUser, signAccessToken } from '../helpers.js';

const ctx = await setupDbTest();
const { skip, db } = ctx;
const app = ctx.enabled ? (await import('../../src/app.js')).default : null;
const cdrService = ctx.enabled ? (await import('../../src/services/cdr.service.js')).default : null;
const { resetRateLimitMemory } = ctx.enabled ? await import('../../src/middleware/rateLimiter.js') : {};

beforeEach(() => resetRateLimitMemory?.());
after(() => ctx.cleanup());

const as = (user) => ({ Authorization: `Bearer ${signAccessToken({ userId: user.id, email: user.email, type: 'access' })}` });

async function callFor(user, callId) {
    await cdrService.recordCall({
        callId, userId: user.id, direction: 'outbound', fromNumber: '+14155550101', toNumber: '+442079460123', startTime: new Date()
    });
    await db('cdr').where({ call_id: callId }).update({ recording_url: 'https://example.com/private-recording.mp3' });
}

test('GET /api/calls/:id returns the caller\'s own call', { skip }, async () => {
    const alice = await createUser(db);
    await callFor(alice, 'v3:alice-own-call');

    const res = await request(app).get('/api/calls/v3:alice-own-call').set(as(alice));

    assert.equal(res.status, 200);
    assert.equal(res.body.toNumber, '+442079460123');
});

test('GET /api/calls/:id does not return another user\'s call', { skip }, async () => {
    const alice = await createUser(db);
    const bob = await createUser(db);
    await callFor(alice, 'v3:alice-private-call');

    const res = await request(app).get('/api/calls/v3:alice-private-call').set(as(bob));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Call not found' });
    assert.ok(!JSON.stringify(res.body).includes('private-recording'));
});

test('a call that belongs to nobody yet is not readable by anyone', { skip }, async () => {
    const bob = await createUser(db);
    await db('cdr').insert({ call_id: 'v3:ownerless-call', direction: 'outbound', start_time: new Date() });

    assert.equal((await request(app).get('/api/calls/v3:ownerless-call').set(as(bob))).status, 404);
});

test('call history and stats only include the caller\'s own calls', { skip }, async () => {
    const alice = await createUser(db);
    const bob = await createUser(db);
    await callFor(alice, 'v3:alice-history-1');
    await callFor(alice, 'v3:alice-history-2');
    await callFor(bob, 'v3:bob-history-1');

    const history = await request(app).get('/api/calls/history').set(as(bob));
    const stats = await request(app).get('/api/calls/stats').set(as(bob));

    assert.equal(history.status, 200);
    assert.deepEqual(history.body.records.map((r) => r.callId), ['v3:bob-history-1']);
    assert.equal(stats.body.totalCalls, 1);
});

test('a user cannot release or list another user\'s number', { skip }, async () => {
    const alice = await createUser(db);
    const bob = await createUser(db);
    const [number] = await db('did_numbers')
        .insert({ user_id: alice.id, phone_number: '+14155550142', telnyx_number_id: 'num-alice', status: 'active' })
        .returning('*');

    const release = await request(app).delete(`/api/numbers/${number.id}`).set(as(bob));
    const list = await request(app).get('/api/numbers').set(as(bob));

    assert.equal(release.status, 404);
    assert.deepEqual(list.body.numbers, []);
    assert.equal((await db('did_numbers').where({ id: number.id }).first()).status, 'active');
});

test('wallet endpoints only ever show the caller\'s wallet', { skip }, async () => {
    const alice = await createUser(db, { balance: 42 });
    const bob = await createUser(db, { balance: 1 });

    const res = await request(app).get('/api/wallet').set(as(bob));

    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 1);
    assert.notEqual(res.body.balance, 42);
    assert.ok(alice.id !== bob.id);
});
