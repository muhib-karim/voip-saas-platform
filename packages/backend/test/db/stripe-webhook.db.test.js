import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import Stripe from 'stripe';
import { setupDbTest, createUser, balanceOf, TEST_STRIPE_WEBHOOK_SECRET } from '../helpers.js';

const ctx = await setupDbTest();
const { skip, db } = ctx;
const app = ctx.enabled ? (await import('../../src/app.js')).default : null;
const { resetRateLimitMemory } = ctx.enabled ? await import('../../src/middleware/rateLimiter.js') : {};

beforeEach(() => resetRateLimitMemory?.());
after(() => ctx.cleanup());

const stripe = new Stripe('sk_test_dummy');
const unique = () => crypto.randomBytes(8).toString('hex');

/** A checkout.session.completed event as Stripe would send it. */
function checkoutEvent(user, overrides = {}) {
    const id = unique();
    return {
        id: `evt_test_${id}`,
        object: 'event',
        type: 'checkout.session.completed',
        data: {
            object: {
                id: `cs_test_${id}`,
                object: 'checkout.session',
                mode: 'payment',
                payment_status: 'paid',
                currency: 'usd',
                amount_total: 2500,
                payment_intent: `pi_test_${id}`,
                metadata: { userId: user.id, type: 'topup', amount: '25.00' },
                ...overrides
            }
        }
    };
}

/** Sign and deliver an event exactly as Stripe does (signature over the raw body). */
function deliver(event) {
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_STRIPE_WEBHOOK_SECRET });
    return request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(payload);
}

const credits = async (user) => {
    const wallet = await db('wallets').where({ user_id: user.id }).first('id');
    return db('transactions').where({ wallet_id: wallet.id, type: 'credit' });
};

test('a paid checkout credits the wallet with the amount Stripe collected', { skip }, async () => {
    const user = await createUser(db);
    const event = checkoutEvent(user);

    const res = await deliver(event);

    assert.equal(res.status, 200);
    assert.equal(await balanceOf(db, user), 25);
    const [row] = await credits(user);
    assert.equal(row.stripe_payment_id, event.data.object.payment_intent);
    assert.equal(row.idempotency_key, `stripe:${event.data.object.payment_intent}`);
    assert.equal(parseFloat(row.balance_after), 25);
});

test('the same event delivered again does not credit twice', { skip }, async () => {
    const user = await createUser(db);
    const event = checkoutEvent(user);

    const first = await deliver(event);
    const second = await deliver(event);
    const third = await deliver(event);

    assert.deepEqual([first.status, second.status, third.status], [200, 200, 200]);
    assert.equal(await balanceOf(db, user), 25);
    assert.equal((await credits(user)).length, 1);
});

test('simultaneous deliveries of one event credit once', { skip }, async () => {
    const user = await createUser(db);
    const event = checkoutEvent(user);

    const responses = await Promise.all(Array.from({ length: 6 }, () => deliver(event)));

    assert.ok(responses.every((r) => r.status === 200));
    assert.equal(await balanceOf(db, user), 25);
    assert.equal((await credits(user)).length, 1);
});

test('a second event for the same payment (new event id) still credits once', { skip }, async () => {
    const user = await createUser(db);
    const event = checkoutEvent(user);
    const sameSessionNewEvent = { ...event, id: `evt_test_${unique()}` };

    await deliver(event);
    await deliver(sameSessionNewEvent);

    assert.equal(await balanceOf(db, user), 25);
});

test('two different payments are both credited', { skip }, async () => {
    const user = await createUser(db);

    await deliver(checkoutEvent(user, { amount_total: 1000 }));
    await deliver(checkoutEvent(user, { amount_total: 550 }));

    assert.equal(await balanceOf(db, user), 15.5);
    assert.equal((await credits(user)).length, 2);
});

test('an unpaid session is acknowledged but not credited', { skip }, async () => {
    const user = await createUser(db);

    const res = await deliver(checkoutEvent(user, { payment_status: 'unpaid' }));

    assert.equal(res.status, 200);
    assert.equal(await balanceOf(db, user), 0);
});

test('the credit comes from amount_total, never from metadata', { skip }, async () => {
    const user = await createUser(db);

    await deliver(checkoutEvent(user, { amount_total: 500, metadata: { userId: user.id, type: 'topup', amount: '999' } }));

    assert.equal(await balanceOf(db, user), 5);
});

test('sessions that are not a paid USD top-up are ignored', { skip }, async () => {
    const user = await createUser(db);

    for (const overrides of [
        { mode: 'setup' },
        { currency: 'eur' },
        { amount_total: 0 },
        { amount_total: null },
        { metadata: { userId: user.id, type: 'subscription' } },
        { metadata: { userId: 'not-a-uuid', type: 'topup' } },
        { metadata: null }
    ]) {
        const res = await deliver(checkoutEvent(user, overrides));
        assert.equal(res.status, 200, JSON.stringify(overrides));
    }
    assert.equal(await balanceOf(db, user), 0);
});

test('a session without a payment intent is keyed on the session id', { skip }, async () => {
    const user = await createUser(db);
    const event = checkoutEvent(user, { payment_intent: null });

    await deliver(event);
    await deliver(event);

    assert.equal(await balanceOf(db, user), 25);
    const [row] = await credits(user);
    assert.equal(row.idempotency_key, `stripe:${event.data.object.id}`);
});

test('a processing failure is a 500 with a generic body, so Stripe retries', { skip }, async () => {
    // A well-formed user id with no wallet behind it.
    const ghost = { id: crypto.randomUUID() };

    const res = await deliver(checkoutEvent(ghost));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Webhook processing failed' });
});

test('an event with a bad signature never reaches the wallet', { skip }, async () => {
    const user = await createUser(db);
    const payload = JSON.stringify(checkoutEvent(user));
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_some_other_secret' });

    const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(payload);

    assert.equal(res.status, 400);
    assert.equal(await balanceOf(db, user), 0);
});

test('a signed event older than the tolerance is rejected (replay)', { skip }, async () => {
    const user = await createUser(db);
    const payload = JSON.stringify(checkoutEvent(user));
    const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: TEST_STRIPE_WEBHOOK_SECRET,
        timestamp: Math.floor(Date.now() / 1000) - 3600
    });

    const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(payload);

    assert.equal(res.status, 400);
    assert.equal(await balanceOf(db, user), 0);
});
