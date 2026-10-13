import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/middleware/rateLimiter.js';

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

test('skip() bypasses the limiter entirely', async () => {
    const limiter = createRateLimiter({ skip: () => true });
    const res = fakeRes();
    let nextCalled = false;
    await limiter({ ip: '1.2.3.4' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.deepEqual(res.headers, {});
});

test('without Redis the limiter fails open but still sets headers', async () => {
    // No Redis client is initialised in tests, so cache.incr() returns 0.
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
    const res = fakeRes();
    let nextCalled = false;
    await limiter({ ip: '1.2.3.4' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.headers['X-RateLimit-Limit'], 3);
    assert.equal(res.headers['X-RateLimit-Remaining'], 3);
    assert.ok(!Number.isNaN(Date.parse(res.headers['X-RateLimit-Reset'])));
});
