import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDbTest, createUser, balanceOf, signAccessToken, fictionalUsNumber } from '../helpers.js';

const ctx = await setupDbTest({ BACKEND_URL: 'https://api.example.com' });
const { skip, db } = ctx;
const app = ctx.enabled ? (await import('../../src/app.js')).default : null;
const telnyxService = ctx.enabled ? (await import('../../src/services/telnyx.service.js')).default : null;
const { resetRateLimitMemory } = ctx.enabled ? await import('../../src/middleware/rateLimiter.js') : {};

beforeEach(() => resetRateLimitMemory?.());
after(() => ctx.cleanup());

const as = (user) => ({ Authorization: `Bearer ${signAccessToken({ userId: user.id, email: user.email, type: 'access' })}` });
const FAR_END = '+442079460123';

const ledger = async (user) => {
    const wallet = await db('wallets').where({ user_id: user.id }).first('id');
    return db('transactions').where({ wallet_id: wallet.id }).orderBy('created_at');
};
const numberRows = (phoneNumber) => db('did_numbers').where({ phone_number: phoneNumber });

/** Stub the Telnyx number order; returns the mock so calls can be counted. */
const stubOrder = (t, impl) => t.mock.method(telnyxService.client.numberOrders, 'create', impl || (async ({ phone_numbers }) => ({
    data: { id: 'order-1', phone_numbers: [{ id: 'telnyx-number-1', phone_number: phone_numbers[0].phone_number }] }
})));

const purchase = (user, phoneNumber) => request(app).post('/api/numbers/purchase').set(as(user)).send({ phoneNumber });

// ---- Number purchase ---------------------------------------------------------

test('buying a number charges the wallet and activates the number', { skip }, async (t) => {
    const user = await createUser(db, { balance: 5 });
    const phoneNumber = fictionalUsNumber();
    const order = stubOrder(t);

    const res = await purchase(user, phoneNumber);

    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'active');
    assert.equal(order.mock.callCount(), 1);
    assert.equal(await balanceOf(db, user), 4, 'setup + first month');

    const [number] = await numberRows(phoneNumber);
    assert.equal(number.status, 'active');
    assert.equal(number.user_id, user.id);
    assert.equal(number.telnyx_number_id, 'telnyx-number-1');

    const [debit] = await ledger(user);
    assert.equal(debit.type, 'debit');
    assert.equal(debit.reference_type, 'did_purchase');
    assert.equal(debit.reference_id, number.id);
});

test('with too little balance nothing is ordered from Telnyx', { skip }, async (t) => {
    const user = await createUser(db, { balance: 0.5 });
    const phoneNumber = fictionalUsNumber();
    const order = stubOrder(t);

    const res = await purchase(user, phoneNumber);

    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Insufficient wallet balance');
    assert.equal(order.mock.callCount(), 0, 'the platform must not buy a number the user cannot pay for');
    assert.equal(await balanceOf(db, user), 0.5);
    assert.equal((await numberRows(phoneNumber)).length, 0, 'no reservation left behind');
});

test('when Telnyx refuses the order the user is refunded and the number is freed', { skip }, async (t) => {
    const user = await createUser(db, { balance: 5 });
    const phoneNumber = fictionalUsNumber();
    stubOrder(t, async () => { throw new Error('Telnyx says: number no longer available (internal detail)'); });

    const res = await purchase(user, phoneNumber);

    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'Bad Gateway', message: 'Failed to purchase phone number' });
    assert.equal(await balanceOf(db, user), 5);

    const rows = await ledger(user);
    assert.deepEqual(rows.map((r) => r.type), ['debit', 'refund']);
    assert.equal(parseFloat(rows[0].amount), parseFloat(rows[1].amount));

    const [number] = await numberRows(phoneNumber);
    assert.equal(number.status, 'released');
    assert.equal(number.user_id, null);

    // And the number can be bought again afterwards.
    stubOrder(t);
    assert.equal((await purchase(user, phoneNumber)).status, 201);
});

test('a number that someone already holds cannot be bought again', { skip }, async (t) => {
    const alice = await createUser(db, { balance: 5 });
    const bob = await createUser(db, { balance: 5 });
    const phoneNumber = fictionalUsNumber();
    const order = stubOrder(t);

    assert.equal((await purchase(alice, phoneNumber)).status, 201);
    const second = await purchase(bob, phoneNumber);

    assert.equal(second.status, 409);
    assert.equal(second.body.message, 'This number is already in use');
    assert.equal(order.mock.callCount(), 1, 'no second Telnyx order');
    assert.equal(await balanceOf(db, bob), 5, 'the loser is not charged');
});

test('two users racing for one number: exactly one gets it and pays', { skip }, async (t) => {
    const alice = await createUser(db, { balance: 5 });
    const bob = await createUser(db, { balance: 5 });
    const phoneNumber = fictionalUsNumber();
    const order = stubOrder(t);

    const [a, b] = await Promise.all([purchase(alice, phoneNumber), purchase(bob, phoneNumber)]);

    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(order.mock.callCount(), 1);
    assert.equal((await balanceOf(db, alice)) + (await balanceOf(db, bob)), 9);
    assert.equal((await numberRows(phoneNumber)).filter((n) => n.status !== 'released').length, 1);
});

test('one user double-clicking "buy" pays once', { skip }, async (t) => {
    const user = await createUser(db, { balance: 5 });
    const phoneNumber = fictionalUsNumber();
    stubOrder(t);

    const [a, b] = await Promise.all([purchase(user, phoneNumber), purchase(user, phoneNumber)]);

    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(await balanceOf(db, user), 4);
});

test('the purchase limiter is applied to the route', { skip }, async (t) => {
    const user = await createUser(db, { balance: 0 });
    stubOrder(t);

    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await purchase(user, fictionalUsNumber())).status);

    assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429, 429]);
});

test('releasing a number only works for its owner while it is active', { skip }, async (t) => {
    const user = await createUser(db, { balance: 5 });
    const phoneNumber = fictionalUsNumber();
    stubOrder(t);
    const del = t.mock.method(telnyxService.client.phoneNumbers, 'del', async () => ({}));
    const bought = await purchase(user, phoneNumber);

    const first = await request(app).delete(`/api/numbers/${bought.body.id}`).set(as(user));
    const again = await request(app).delete(`/api/numbers/${bought.body.id}`).set(as(user));

    assert.equal(first.status, 200);
    assert.equal(again.status, 404);
    assert.equal(del.mock.callCount(), 1);
});

// ---- Placing calls -----------------------------------------------------------

async function userWithNumber(balance) {
    const user = await createUser(db, { balance });
    const phoneNumber = fictionalUsNumber();
    await db('did_numbers').insert({ user_id: user.id, phone_number: phoneNumber, telnyx_number_id: 'n', status: 'active' });
    return { user, phoneNumber };
}

let callCounter = 0;
const stubCalls = (t) => t.mock.method(telnyxService.client.calls, 'create', async () => {
    callCounter += 1;
    return { data: { call_control_id: `v3:placed-${callCounter}`, call_leg_id: `leg-${callCounter}` } };
});

const dial = (user, from, to = FAR_END) => request(app).post('/api/calls').set(as(user)).send({ from, to });

test('a call cannot be placed with an empty wallet', { skip }, async (t) => {
    const { user, phoneNumber } = await userWithNumber(0);
    const create = stubCalls(t);

    const res = await dial(user, phoneNumber);

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INSUFFICIENT_FUNDS');
    assert.equal(create.mock.callCount(), 0);
});

test('a call is limited to the time the balance can pay for', { skip }, async (t) => {
    const { user, phoneNumber } = await userWithNumber(0.05);
    const create = stubCalls(t);

    const res = await dial(user, phoneNumber);

    assert.equal(res.status, 201);
    assert.equal(res.body.didNumberId, undefined, 'internal ids are not returned');
    const args = create.mock.calls[0].arguments[0];
    assert.equal(args.time_limit_secs, 300, 'five cents buys five minutes');
    assert.equal(args.from, phoneNumber);
    assert.equal(args.to, FAR_END);
    assert.equal(args.webhook_url, 'https://api.example.com/api/webhooks/telnyx/call');

    const row = await db('cdr').where({ call_id: res.body.callId }).first();
    assert.equal(row.user_id, user.id);
    assert.equal(row.direction, 'outbound');
    assert.equal(row.status, 'initiated');
});

test('the time limit never exceeds Telnyx\'s four-hour maximum', { skip }, async (t) => {
    const { user, phoneNumber } = await userWithNumber(500);
    const create = stubCalls(t);

    await dial(user, phoneNumber);

    assert.equal(create.mock.calls[0].arguments[0].time_limit_secs, 14400);
});

test('a user can only have a limited number of calls open at once', { skip }, async (t) => {
    const { user, phoneNumber } = await userWithNumber(10);
    const create = stubCalls(t);

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await dial(user, phoneNumber)).status);

    assert.deepEqual(statuses, [201, 201, 429]);
    assert.equal(create.mock.callCount(), 2);

    // Once a call has ended there is room again.
    const open = await db('cdr').where({ user_id: user.id }).first('id');
    await db('cdr').where({ id: open.id }).update({ end_time: new Date() });
    assert.equal((await dial(user, phoneNumber)).status, 201);
});

test('a user cannot dial from a number they do not own', { skip }, async (t) => {
    const { phoneNumber } = await userWithNumber(10);
    const stranger = await createUser(db, { balance: 10 });
    const create = stubCalls(t);

    const res = await dial(stranger, phoneNumber);

    assert.equal(res.status, 403);
    assert.equal(create.mock.callCount(), 0);
});

test('a Telnyx failure when dialling is a 502 with no internal detail', { skip }, async (t) => {
    const { user, phoneNumber } = await userWithNumber(10);
    t.mock.method(telnyxService.client.calls, 'create', async () => { throw new Error('upstream exploded: api key rejected'); });

    const res = await dial(user, phoneNumber);

    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'Bad Gateway', message: 'Failed to initiate call' });
});
