import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/middleware/validate.js';

// Runs the middleware against a fake request and reports what happened.
function run(schema, req) {
    let statusCode = null;
    let body = null;
    let nextCalled = false;
    const res = {
        status(code) { statusCode = code; return this; },
        json(payload) { body = payload; return this; }
    };
    validate(schema)({ body: {}, query: {}, params: {}, ...req }, res, () => { nextCalled = true; });
    return { statusCode, body, nextCalled };
}

test('passes a valid body through to next()', () => {
    const result = run(
        { body: { amount: { type: 'number', required: true, min: 5 } } },
        { body: { amount: 10 } }
    );
    assert.equal(result.nextCalled, true);
    assert.equal(result.statusCode, null);
});

test('rejects a missing required field with 400', () => {
    const result = run({ body: { phoneNumber: { type: 'string', required: true } } }, { body: {} });
    assert.equal(result.nextCalled, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error, 'Validation Error');
    assert.deepEqual(result.body.details, [
        { field: 'phoneNumber', location: 'body', message: 'phoneNumber is required' }
    ]);
});

test('treats an empty string as missing for required fields', () => {
    const result = run({ body: { to: { type: 'string', required: true } } }, { body: { to: '' } });
    assert.equal(result.statusCode, 400);
});

test('enforces numeric type and minimum value', () => {
    const schema = { body: { amount: { type: 'number', required: true, min: 5 } } };

    const wrongType = run(schema, { body: { amount: '10' } });
    assert.equal(wrongType.statusCode, 400);
    assert.match(wrongType.body.details[0].message, /must be of type number/);

    const tooSmall = run(schema, { body: { amount: 2 } });
    assert.equal(tooSmall.statusCode, 400);
    assert.match(tooSmall.body.details[0].message, /must be at least 5/);
});

test('validates enum values in the query string', () => {
    const schema = { query: { type: { type: 'string', enum: ['local', 'toll_free', 'mobile'] } } };
    assert.equal(run(schema, { query: { type: 'mobile' } }).nextCalled, true);

    const bad = run(schema, { query: { type: 'satellite' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.details[0].location, 'query');
});

test('validates email format and string length', () => {
    const schema = { body: { email: { type: 'email', required: true }, name: { type: 'string', minLength: 2, maxLength: 4 } } };
    assert.equal(run(schema, { body: { email: 'a@b.co', name: 'abc' } }).nextCalled, true);

    const bad = run(schema, { body: { email: 'not-an-email', name: 'abcdef' } });
    assert.equal(bad.statusCode, 400);
    const messages = bad.body.details.map(d => d.message);
    assert.ok(messages.includes('email must be a valid email address'));
    assert.ok(messages.includes('name must be at most 4 characters'));
});

test('validates uuid params', () => {
    const schema = { params: { id: { type: 'uuid', required: true } } };
    assert.equal(run(schema, { params: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } }).nextCalled, true);
    assert.equal(run(schema, { params: { id: '123' } }).statusCode, 400);
});

test('ignores optional fields that are absent', () => {
    const schema = { query: { areaCode: { type: 'string' }, limit: { type: 'string' } } };
    assert.equal(run(schema, { query: {} }).nextCalled, true);
});

test('enforces a maximum and a number of decimal places', () => {
    const schema = { body: { amount: { type: 'number', required: true, min: 5, max: 1000, maxDecimals: 2 } } };
    assert.equal(run(schema, { body: { amount: 1000 } }).nextCalled, true);
    assert.equal(run(schema, { body: { amount: 19.99 } }).nextCalled, true);
    assert.equal(run(schema, { body: { amount: 1000.01 } }).statusCode, 400);
    assert.equal(run(schema, { body: { amount: 5.555 } }).statusCode, 400);
    assert.equal(run(schema, { body: { amount: Infinity } }).statusCode, 400);
});

test('a pattern never matches a non-string, even one that stringifies to a match', () => {
    const schema = { body: { to: { type: 'string', required: true, pattern: /^\+[1-9]\d{6,14}$/ } } };
    assert.equal(run(schema, { body: { to: '+14155550123' } }).nextCalled, true);
    assert.equal(run(schema, { body: { to: ['+14155550123'] } }).statusCode, 400);
    assert.equal(run(schema, { body: { to: { toString: () => '+14155550123' } } }).statusCode, 400);
    assert.equal(run(schema, { body: { to: 14155550123 } }).statusCode, 400);
});

test('validates ISO dates and rejects non-string uuids', () => {
    const dates = { query: { startDate: { type: 'isoDate' } } };
    assert.equal(run(dates, { query: { startDate: '2026-01-31T10:00:00Z' } }).nextCalled, true);
    assert.equal(run(dates, { query: { startDate: 'last tuesday' } }).statusCode, 400);
    assert.equal(run(dates, { query: { startDate: ['2026-01-31'] } }).statusCode, 400);

    const ids = { params: { id: { type: 'uuid', required: true } } };
    assert.equal(run(ids, { params: { id: ['3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b'] } }).statusCode, 400);
});

test('a missing body or query object is treated as empty', () => {
    const schema = { body: { phoneNumber: { type: 'string', required: true } } };
    assert.equal(run(schema, { body: undefined }).statusCode, 400);
});

test('type failure stops length and email checks from reading array/object lengths', () => {
    const schema = {
        body: {
            email: { type: 'email', required: true },
            name: { type: 'string', minLength: 2, maxLength: 4 },
            amount: { type: 'number', min: 1, max: 10 }
        }
    };
    const arr = run(schema, {
        body: { email: ['a@b.co'], name: ['ab', 'cd', 'ef'], amount: [5] }
    });
    assert.equal(arr.statusCode, 400);
    assert.deepEqual(arr.body.details.map((d) => d.message), [
        'email must be of type email',
        'name must be of type string',
        'amount must be of type number'
    ]);

    const objLen = run(schema, { body: { email: { length: 10 }, name: { length: 3 }, amount: { valueOf: () => 5 } } });
    assert.equal(objLen.statusCode, 400);
    assert.equal(objLen.body.details.length, 3);
});

test('email validation rejects huge ReDoS-shaped strings linearly', () => {
    const schema = { body: { email: { type: 'email', required: true } } };
    const start = performance.now();
    const res = run(schema, { body: { email: `${'a'.repeat(50000)}@${'b'.repeat(50000)}` } });
    assert.equal(res.statusCode, 400);
    assert.ok(performance.now() - start < 50);
});
