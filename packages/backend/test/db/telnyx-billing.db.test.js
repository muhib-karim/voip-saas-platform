import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { setupDbTest, createUser, balanceOf, createTelnyxSigner } from '../helpers.js';

const signer = createTelnyxSigner();
const ctx = await setupDbTest({ TELNYX_PUBLIC_KEY: signer.publicKeyBase64 });
const { skip, db } = ctx;
const app = ctx.enabled ? (await import('../../src/app.js')).default : null;
const cdrService = ctx.enabled ? (await import('../../src/services/cdr.service.js')).default : null;
const { resetRateLimitMemory } = ctx.enabled ? await import('../../src/middleware/rateLimiter.js') : {};

beforeEach(() => resetRateLimitMemory?.());
after(() => ctx.cleanup());

const FAR_END = '+442079460123';
let sequence = 0;

/** A user who owns one active number. */
async function userWithNumber(balance = 10) {
    const user = await createUser(db, { balance });
    sequence += 1;
    const phoneNumber = `+1415555${String(100 + (sequence % 100)).padStart(4, '0')}`;
    const [did] = await db('did_numbers')
        .insert({ user_id: user.id, phone_number: phoneNumber, telnyx_number_id: `num-${sequence}`, status: 'active' })
        .returning('*');
    return { user, phoneNumber, did };
}

const newCallId = () => `v3:${crypto.randomBytes(12).toString('hex')}`;
const at = (base, offsetSeconds) => new Date(base.getTime() + offsetSeconds * 1000).toISOString();

/** Deliver one signed Telnyx event; path defaults to the URL used for outbound calls. */
function send(eventType, payload, occurredAt = new Date().toISOString(), path = '/api/webhooks/telnyx/call') {
    const body = JSON.stringify({
        data: { record_type: 'event', event_type: eventType, id: crypto.randomUUID(), occurred_at: occurredAt, payload },
        meta: { attempt: 1 }
    });
    return request(app).post(path).set('Content-Type', 'application/json').set(signer.sign(body)).send(body);
}

const cdrRow = (callId) => db('cdr').where({ call_id: callId }).first();
const callDebits = async (user) => {
    const wallet = await db('wallets').where({ user_id: user.id }).first('id');
    return db('transactions').where({ wallet_id: wallet.id, type: 'debit', reference_type: 'call' });
};

/** Outbound call placed through the API: the route records it with its owner. */
async function placedCall(user, from, startTime = new Date()) {
    const callId = newCallId();
    await cdrService.recordCall({
        callId, telnyxCallControlId: callId, userId: user.id, direction: 'outbound', fromNumber: from, toNumber: FAR_END, startTime
    });
    return callId;
}

const outbound = (callId, from, extra = {}) => ({ call_control_id: callId, direction: 'outgoing', from, to: FAR_END, ...extra });

test('an answered outbound call is billed once, from the event timestamps', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = await placedCall(user, phoneNumber, start);

    assert.equal((await send('call.initiated', outbound(callId, phoneNumber), at(start, 0))).status, 200);
    assert.equal((await send('call.ringing', outbound(callId, phoneNumber), at(start, 2))).status, 200);
    assert.equal((await send('call.answered', outbound(callId, phoneNumber), at(start, 10))).status, 200);
    assert.equal((await send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'normal_clearing' }), at(start, 135))).status, 200);

    const row = await cdrRow(callId);
    assert.equal(row.status, 'completed');
    assert.equal(row.duration_seconds, 125, 'answer to hangup, not webhook arrival times');
    assert.equal(parseFloat(row.cost), 0.03, '125 s is three started minutes');
    assert.ok(row.billed_at);
    assert.equal(await balanceOf(db, user), 9.97);

    const debits = await callDebits(user);
    assert.equal(debits.length, 1);
    assert.equal(debits[0].reference_id, row.id);
    assert.equal(debits[0].idempotency_key, `call:${row.id}`);
});

test('a duplicate call.hangup does not bill the call again', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = await placedCall(user, phoneNumber, start);
    await send('call.answered', outbound(callId, phoneNumber), at(start, 5));

    const hangup = () => send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'normal_clearing' }), at(start, 65));
    const responses = [await hangup(), await hangup(), await hangup()];

    assert.deepEqual(responses.map((r) => r.status), [200, 200, 200]);
    assert.equal((await callDebits(user)).length, 1);
    assert.equal(await balanceOf(db, user), 9.99);
});

test('simultaneous duplicate hangups bill once', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = await placedCall(user, phoneNumber, start);
    await send('call.answered', outbound(callId, phoneNumber), at(start, 5));

    const responses = await Promise.all(Array.from({ length: 6 }, () =>
        send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'normal_clearing' }), at(start, 65))));

    assert.ok(responses.every((r) => r.status === 200));
    assert.equal((await callDebits(user)).length, 1);
    assert.equal(await balanceOf(db, user), 9.99);
});

test('hangup arriving before answered is still billed, once', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = await placedCall(user, phoneNumber, start);

    await send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'normal_clearing' }), at(start, 190));
    assert.equal((await callDebits(user)).length, 0, 'not billable until we know it was answered');

    await send('call.answered', outbound(callId, phoneNumber), at(start, 10));
    await send('call.answered', outbound(callId, phoneNumber), at(start, 10));

    const row = await cdrRow(callId);
    assert.equal(row.status, 'completed');
    assert.equal(row.duration_seconds, 180);
    assert.equal((await callDebits(user)).length, 1);
    assert.equal(await balanceOf(db, user), 9.97);
});

test('a call that was never answered costs nothing', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = await placedCall(user, phoneNumber, start);

    await send('call.ringing', outbound(callId, phoneNumber), at(start, 2));
    const res = await send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'originator_cancel' }), at(start, 32));

    assert.equal(res.status, 200);
    const row = await cdrRow(callId);
    assert.equal(row.status, 'missed');
    assert.equal(row.answer_time, null);
    assert.equal(row.duration_seconds, 0);
    assert.equal(parseFloat(row.cost), 0);
    assert.equal(row.billed_at, null);
    assert.equal((await callDebits(user)).length, 0);
    assert.equal(await balanceOf(db, user), 10);
});

test('Telnyx hangup causes outside the stored set are mapped, not rejected', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const expectations = { originator_cancel: 'no_answer', user_busy: 'user_busy', timeout: 'no_answer', some_new_cause: 'other' };

    for (const [sent, stored] of Object.entries(expectations)) {
        const callId = await placedCall(user, phoneNumber);
        const res = await send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: sent }));
        assert.equal(res.status, 200, sent);
        assert.equal((await cdrRow(callId)).hangup_cause, stored, sent);
    }

    const busy = await placedCall(user, phoneNumber);
    await send('call.hangup', outbound(busy, phoneNumber, { hangup_cause: 'user_busy' }));
    assert.equal((await cdrRow(busy)).status, 'busy');
});

test('later events do not reset the duration or move the status backwards', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = await placedCall(user, phoneNumber, start);
    await send('call.answered', outbound(callId, phoneNumber), at(start, 5));
    await send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'normal_clearing' }), at(start, 80));

    await send('call.recording.saved', { call_control_id: callId, recording_urls: { mp3: 'https://example.com/rec.mp3' } }, at(start, 90));
    await send('call.ringing', outbound(callId, phoneNumber), at(start, 2));
    await send('call.initiated', outbound(callId, phoneNumber), at(start, 0));

    const row = await cdrRow(callId);
    assert.equal(row.duration_seconds, 75);
    assert.equal(row.status, 'completed');
    assert.equal(row.recording_url, 'https://example.com/rec.mp3');
    assert.equal((await callDebits(user)).length, 1);
});

test('a late "ringing" does not undo "answered"', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const callId = await placedCall(user, phoneNumber);

    await send('call.answered', outbound(callId, phoneNumber));
    await send('call.ringing', outbound(callId, phoneNumber));

    assert.equal((await cdrRow(callId)).status, 'answered');
});

test('webhooks that arrive before the API has recorded the call still bill its owner', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = newCallId();

    // The whole call happens before POST /api/calls gets to write its row.
    await send('call.initiated', outbound(callId, phoneNumber), at(start, 0));
    await send('call.answered', outbound(callId, phoneNumber), at(start, 4));
    await send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'normal_clearing' }), at(start, 64));

    const row = await cdrRow(callId);
    assert.equal(row.user_id, user.id, 'owner found from the caller ID');
    assert.equal((await callDebits(user)).length, 1);

    // The route's own insert then finds the call already settled and changes nothing.
    await cdrService.recordCall({
        callId, userId: user.id, direction: 'outbound', fromNumber: phoneNumber, toNumber: FAR_END, startTime: new Date()
    });
    const after = await cdrRow(callId);
    assert.equal(after.status, 'completed');
    assert.equal(after.duration_seconds, 60);
    assert.equal((await callDebits(user)).length, 1);
    assert.equal(await balanceOf(db, user), 9.99);
});

test('a call whose owner is only known later is billed when the owner is attached', { skip }, async () => {
    const user = await createUser(db, { balance: 10 });
    const unknownCallerId = '+12125550199';
    const start = new Date(Date.now() - 600_000);
    const callId = newCallId();

    await send('call.initiated', outbound(callId, unknownCallerId), at(start, 0));
    await send('call.answered', outbound(callId, unknownCallerId), at(start, 4));
    await send('call.hangup', outbound(callId, unknownCallerId, { hangup_cause: 'normal_clearing' }), at(start, 64));

    const before = await cdrRow(callId);
    assert.equal(before.user_id, null);
    assert.equal(before.billed_at, null, 'nobody to charge yet');

    await cdrService.recordCall({
        callId, userId: user.id, direction: 'outbound', fromNumber: unknownCallerId, toNumber: FAR_END, startTime: new Date()
    });

    const after = await cdrRow(callId);
    assert.equal(after.user_id, user.id);
    assert.ok(after.billed_at);
    assert.equal(after.start_time.toISOString(), before.start_time.toISOString(), 'existing facts are not overwritten');
    assert.equal(await balanceOf(db, user), 9.99);
});

test('an inbound call is recorded for the owner of the called number and is free', { skip }, async () => {
    const { user, phoneNumber, did } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = newCallId();
    const inbound = (extra = {}) => ({ call_control_id: callId, direction: 'incoming', from: FAR_END, to: phoneNumber, ...extra });

    await send('call.initiated', inbound(), at(start, 0), '/api/webhooks/telnyx');
    await send('call.answered', inbound(), at(start, 3), '/api/webhooks/telnyx');
    await send('call.hangup', inbound({ hangup_cause: 'normal_clearing' }), at(start, 303), '/api/webhooks/telnyx');

    const row = await cdrRow(callId);
    assert.equal(row.direction, 'inbound');
    assert.equal(row.user_id, user.id);
    assert.equal(row.did_number_id, did.id);
    assert.equal(row.status, 'completed');
    assert.equal(row.duration_seconds, 300);
    assert.equal(parseFloat(row.cost), 0);
    assert.equal(await balanceOf(db, user), 10);
});

test('a call charge is recorded even when it takes the balance below zero', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(0.01);
    const start = new Date(Date.now() - 600_000);
    const callId = await placedCall(user, phoneNumber, start);

    await send('call.answered', outbound(callId, phoneNumber), at(start, 0));
    await send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'normal_clearing' }), at(start, 170));

    assert.equal(await balanceOf(db, user), -0.02);
    assert.equal((await callDebits(user)).length, 1);
});

test('an unsigned event changes nothing', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const callId = newCallId();

    const res = await request(app)
        .post('/api/webhooks/telnyx')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ data: { event_type: 'call.initiated', payload: { call_control_id: callId, direction: 'incoming', from: FAR_END, to: phoneNumber } } }));

    assert.equal(res.status, 400);
    assert.equal(await cdrRow(callId), undefined);
    assert.equal(await balanceOf(db, user), 10);
});

test('an event for a call nobody knows, with nothing to identify it, is acknowledged and ignored', { skip }, async () => {
    const callId = newCallId();
    const res = await send('call.hangup', { call_control_id: callId, hangup_cause: 'normal_clearing' });
    assert.equal(res.status, 200);
    assert.equal(await cdrRow(callId), undefined);
});

test('a missing or malformed occurred_at falls back to the arrival time', { skip }, async () => {
    const { user, phoneNumber } = await userWithNumber(10);
    const callId = await placedCall(user, phoneNumber);

    const res = await send('call.answered', outbound(callId, phoneNumber), 'not-a-date');

    assert.equal(res.status, 200);
    const row = await cdrRow(callId);
    assert.ok(Math.abs(new Date(row.answer_time).getTime() - Date.now()) < 60_000);
});

test('a row created by a late event still ends up with the call\'s real start time', { skip }, async () => {
    const { phoneNumber } = await userWithNumber(10);
    const start = new Date(Date.now() - 600_000);
    const callId = newCallId();

    // The hangup is the first thing we hear about this call...
    await send('call.hangup', outbound(callId, phoneNumber, { hangup_cause: 'normal_clearing' }), at(start, 90));
    // ...and call.initiated is delivered afterwards.
    await send('call.initiated', outbound(callId, phoneNumber), at(start, 0));

    const row = await cdrRow(callId);
    assert.equal(row.start_time.toISOString(), at(start, 0));
    assert.equal(row.end_time.toISOString(), at(start, 90));
});
