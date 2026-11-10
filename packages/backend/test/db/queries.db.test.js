import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDbTest, createUser, signAccessToken } from '../helpers.js';

const ctx = await setupDbTest();
const { skip, db } = ctx;
const app = ctx.enabled ? (await import('../../src/app.js')).default : null;
const walletService = ctx.enabled ? (await import('../../src/services/wallet.service.js')).default : null;
const ratesService = ctx.enabled ? (await import('../../src/services/rates.service.js')).default : null;
const { resetRateLimitMemory } = ctx.enabled ? await import('../../src/middleware/rateLimiter.js') : {};

beforeEach(() => resetRateLimitMemory?.());
after(() => ctx.cleanup());

const as = (user) => ({ Authorization: `Bearer ${signAccessToken({ userId: user.id, email: user.email, type: 'access' })}` });

// These three list endpoints used to fail on PostgreSQL: the count query kept
// its ORDER BY, which is not allowed on an ungrouped aggregate.

test('GET /api/wallet/transactions lists and paginates', { skip }, async () => {
    const user = await createUser(db);
    for (let i = 1; i <= 5; i++) await walletService.addFunds(user.id, i, { description: `credit ${i}` });
    await walletService.deductFunds(user.id, 2, { description: 'debit', referenceType: 'test' });

    const all = await request(app).get('/api/wallet/transactions').set(as(user));
    assert.equal(all.status, 200);
    assert.equal(all.body.pagination.total, 6);
    assert.equal(all.body.transactions.length, 6);

    const page = await request(app).get('/api/wallet/transactions?limit=2&page=2').set(as(user));
    assert.equal(page.status, 200);
    assert.equal(page.body.transactions.length, 2);
    assert.deepEqual(page.body.pagination, { page: 2, limit: 2, total: 6, totalPages: 3 });

    const debits = await request(app).get('/api/wallet/transactions?type=debit').set(as(user));
    assert.equal(debits.body.pagination.total, 1);
    assert.equal(debits.body.transactions[0].type, 'debit');
});

test('pagination input is clamped instead of reaching the database raw', { skip }, async () => {
    const user = await createUser(db);
    await walletService.addFunds(user.id, 5, {});

    for (const query of ['limit=100000000', 'limit=-5', 'page=-1', 'limit=abc&page=xyz', 'page=1e9']) {
        const res = await request(app).get(`/api/wallet/transactions?${query}`).set(as(user));
        assert.equal(res.status, 200, query);
        assert.ok(res.body.pagination.limit >= 1 && res.body.pagination.limit <= 100, query);
        assert.ok(res.body.pagination.page >= 1, query);
    }
});

test('GET /api/calls/history lists, filters and paginates', { skip }, async () => {
    const user = await createUser(db);
    const base = Date.now() - 3_600_000;
    await db('cdr').insert([
        { call_id: 'q-1', user_id: user.id, direction: 'outbound', status: 'completed', start_time: new Date(base) },
        { call_id: 'q-2', user_id: user.id, direction: 'inbound', status: 'missed', start_time: new Date(base + 60_000) },
        { call_id: 'q-3', user_id: user.id, direction: 'outbound', status: 'completed', start_time: new Date(base + 120_000) }
    ]);

    const all = await request(app).get('/api/calls/history').set(as(user));
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.records.map((r) => r.callId), ['q-3', 'q-2', 'q-1'], 'newest first');
    assert.equal(all.body.pagination.total, 3);

    const outbound = await request(app).get('/api/calls/history?direction=outbound&status=completed&limit=1').set(as(user));
    assert.equal(outbound.body.pagination.total, 2);
    assert.equal(outbound.body.records.length, 1);

    const since = await request(app)
        .get(`/api/calls/history?startDate=${encodeURIComponent(new Date(base + 30_000).toISOString())}`)
        .set(as(user));
    assert.equal(since.body.pagination.total, 2);
});

test('GET /api/calls/stats aggregates over the requested period', { skip }, async () => {
    const user = await createUser(db);
    await db('cdr').insert([
        { call_id: 's-1', user_id: user.id, direction: 'outbound', status: 'completed', start_time: new Date(), duration_seconds: 90, cost: 0.02 },
        { call_id: 's-2', user_id: user.id, direction: 'inbound', status: 'missed', start_time: new Date(), duration_seconds: 0, cost: 0 },
        { call_id: 's-old', user_id: user.id, direction: 'outbound', status: 'completed', start_time: new Date(Date.now() - 40 * 86_400_000), duration_seconds: 600, cost: 0.1 }
    ]);

    const month = await request(app).get('/api/calls/stats').set(as(user));
    assert.equal(month.status, 200);
    assert.deepEqual(month.body, {
        totalCalls: 2, totalDuration: 90, totalCost: 0.02, inboundCalls: 1, outboundCalls: 1, missedCalls: 1, averageDuration: 45
    });

    const quarter = await request(app).get('/api/calls/stats?period=90d').set(as(user));
    assert.equal(quarter.body.totalCalls, 3);
});

// The rates service queried number_type, active and billing_increment, which
// no migration created, so every rates endpoint failed.

test('rates can be seeded twice without duplicates', { skip }, async () => {
    await ratesService.seedDefaultRates();
    await ratesService.seedDefaultRates();

    const [{ count }] = await db('calling_rates').count();
    assert.equal(parseInt(count), 20);
});

test('GET /api/rates lists and searches', { skip }, async () => {
    await ratesService.seedDefaultRates();

    const all = await request(app).get('/api/rates?limit=5');
    assert.equal(all.status, 200);
    assert.equal(all.body.pagination.total, 20);
    assert.equal(all.body.rates.length, 5);

    const search = await request(app).get('/api/rates?q=united');
    assert.equal(search.status, 200);
    assert.deepEqual([...new Set(search.body.rates.map((r) => r.countryCode))].sort(), ['GB', 'US']);
});

test('LIKE wildcards in a rates search are literal', { skip }, async () => {
    await ratesService.seedDefaultRates();

    assert.equal((await request(app).get('/api/rates?q=%25')).body.pagination.total, 0);
    assert.equal((await request(app).get('/api/rates?q=_')).body.pagination.total, 0);
});

test('GET /api/rates/:countryCode returns that country\'s rates', { skip }, async () => {
    await ratesService.seedDefaultRates();

    const res = await request(app).get('/api/rates/gb');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rates.map((r) => `${r.numberType}:${r.ratePerMinute}`).sort(), ['landline:0.02', 'mobile:0.05']);
    assert.equal(res.body.rates[0].billingIncrement, 60);
});

test('POST /api/rates/estimate prices a call from the stored rate', { skip }, async () => {
    await ratesService.seedDefaultRates();

    const res = await request(app).post('/api/rates/estimate').send({ countryCode: 'GB', duration: 3, numberType: 'mobile' });

    assert.equal(res.status, 200);
    assert.equal(res.body.rate.ratePerMinute, 0.05);
    assert.equal(res.body.totalCost, 0.15);

    const unknown = await request(app).post('/api/rates/estimate').send({ countryCode: 'ZZ', duration: 2 });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.totalCost, 0.1, 'default rate for a country with no row');
});
