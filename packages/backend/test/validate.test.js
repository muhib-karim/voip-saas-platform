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
