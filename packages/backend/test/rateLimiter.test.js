import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, resetRateLimitMemory } from '../src/middleware/rateLimiter.js';

function fakeRes() {
    return {
        headers: {},
        statusCode: null,
        body: null,
        set(h, v) { if (typeof h === 'object') Object.assign(this.headers, h); else this.headers[h] = v; return this; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

async function hit(limiter, ip = '192.0.2.1') {
    const res = fakeRes();
    let nextCalled = false;
    await limiter({ ip }, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

beforeEach(() => resetRateLimitMemory());

test('skip() bypasses the limiter entirely', async () => {
    const limiter = createRateLimiter({ skip: () => true });
    const { res, nextCalled } = await hit(limiter);
    assert.equal(nextCalled, true);
    assert.deepEqual(res.headers, {});
});

// No Redis client is initialised in tests. The limiter used to treat that as
// "zero requests so far" and let everything through.
test('without Redis the limit is still enforced, from process memory', async () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });

    for (let i = 1; i <= 3; i++) {
        const { res, nextCalled } = await hit(limiter);
        assert.equal(nextCalled, true, `request ${i} should pass`);
        assert.equal(res.headers['X-RateLimit-Limit'], 3);
        assert.equal(res.headers['X-RateLimit-Remaining'], 3 - i);
    }

    const { res, nextCalled } = await hit(limiter);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['X-RateLimit-Remaining'], 0);
    assert.ok(res.headers['Retry-After'] >= 1 && res.headers['Retry-After'] <= 60);
    assert.ok(res.body.retryAfter >= 1);
});

test('each client has its own window', async () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
    assert.equal((await hit(limiter, '192.0.2.1')).nextCalled, true);
    assert.equal((await hit(limiter, '192.0.2.1')).nextCalled, false);
    assert.equal((await hit(limiter, '192.0.2.2')).nextCalled, true);
});

test('limiters with different prefixes do not share counters', async () => {
    const a = createRateLimiter({ max: 1, windowMs: 60_000, keyPrefix: 'rl:a:' });
    const b = createRateLimiter({ max: 1, windowMs: 60_000, keyPrefix: 'rl:b:' });
    assert.equal((await hit(a)).nextCalled, true);
    assert.equal((await hit(b)).nextCalled, true);
    assert.equal((await hit(a)).nextCalled, false);
});

test('the window resets once it has elapsed', async () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 40 });
    assert.equal((await hit(limiter)).nextCalled, true);
    assert.equal((await hit(limiter)).nextCalled, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await hit(limiter)).nextCalled, true);
});

test('the reset header is a valid timestamp inside the window', async () => {
    const limiter = createRateLimiter({ max: 5, windowMs: 60_000 });
    const before = Date.now();
    const { res } = await hit(limiter);
    const reset = Date.parse(res.headers['X-RateLimit-Reset']);
    assert.ok(reset > before && reset <= before + 61_000);
});
