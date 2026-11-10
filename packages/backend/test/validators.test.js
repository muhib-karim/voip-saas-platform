import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagination, toMoney, escapeLike, isE164, isUuid, isRefreshToken } from '../src/utils/validators.js';

test('parsePagination clamps limit and page and ignores junk', () => {
    assert.deepEqual(parsePagination({}), { page: 1, limit: 20 });
    assert.deepEqual(parsePagination({ page: '3', limit: '50' }), { page: 3, limit: 50 });
    assert.deepEqual(parsePagination({ page: '-4', limit: '1000000' }), { page: 1, limit: 100 });
    assert.deepEqual(parsePagination({ page: 'abc', limit: '2.5' }), { page: 1, limit: 20 });
    assert.deepEqual(parsePagination({ page: ['1', '2'], limit: { $gt: 0 } }), { page: 1, limit: 20 });
    assert.deepEqual(parsePagination({ limit: '0' }, { defaultLimit: 50, maxLimit: 100 }), { page: 1, limit: 1 });
});

test('toMoney accepts positive amounts with at most two decimals', () => {
    assert.equal(toMoney(5), '5.00');
    assert.equal(toMoney(0.01), '0.01');
    assert.equal(toMoney(19.99), '19.99');
    assert.equal(toMoney(0.1 + 0.2), '0.30');
});

test('toMoney rejects everything else', () => {
    for (const bad of [0, -1, 5.555, NaN, Infinity, '5', null, undefined, [5], 1e12]) {
        assert.equal(toMoney(bad), null, String(bad));
    }
});

test('escapeLike neutralises LIKE wildcards', () => {
    assert.equal(escapeLike('100%_off\\'), '100\\%\\_off\\\\');
});

test('format checks reject non-strings', () => {
    assert.equal(isE164('+14155550123'), true);
    assert.equal(isE164('14155550123'), false);
    assert.equal(isE164(['+14155550123']), false);
    assert.equal(isUuid('3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b'), true);
    assert.equal(isUuid({ toString: () => '3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b' }), false);
    assert.equal(isRefreshToken('a'.repeat(128)), true);
    assert.equal(isRefreshToken('a'.repeat(127)), false);
    assert.equal(isRefreshToken({ a: 1 }), false);
});
