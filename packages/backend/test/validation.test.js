import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, schemas, sanitize, trimStrings } from '../src/middleware/validation.js';

function run(middleware, req) {
    let statusCode = null;
    let body = null;
    let nextCalled = false;
    const res = {
        status(code) { statusCode = code; return this; },
        json(payload) { body = payload; return this; }
    };
    middleware(req, res, () => { nextCalled = true; });
    return { statusCode, body, nextCalled, req };
}

test('register schema accepts a well-formed payload', () => {
    const result = run(validate(schemas.register), {
        body: { email: 'user@example.com', password: 'correct-horse', firstName: 'Ada', lastName: 'Lovelace' }
    });
    assert.equal(result.nextCalled, true);
});

test('register schema reports every invalid field', () => {
    const result = run(validate(schemas.register), {
        body: { email: 'bad', password: 'short' }
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error, 'Validation failed');
    assert.deepEqual(result.body.details, [
        'email is invalid',
        'password is invalid',
        'firstName is required',
        'lastName is required'
    ]);
});

test('purchaseNumber schema requires an E.164 phone number', () => {
    const v = validate(schemas.purchaseNumber);
    assert.equal(run(v, { body: { phoneNumber: '+14155550123' } }).nextCalled, true);
    assert.equal(run(v, { body: { phoneNumber: '0123' } }).statusCode, 400);
    assert.equal(run(v, { body: { phoneNumber: 'call-me' } }).statusCode, 400);
});

test('topUp schema enforces the $5-$1000 range', () => {
    const v = validate(schemas.topUp);
    assert.equal(run(v, { body: { amount: 5 } }).nextCalled, true);
    assert.equal(run(v, { body: { amount: 1000 } }).nextCalled, true);
    assert.equal(run(v, { body: { amount: 4.99 } }).statusCode, 400);
    assert.equal(run(v, { body: { amount: 1001 } }).statusCode, 400);
    assert.equal(run(v, { body: { amount: 'lots' } }).statusCode, 400);
});

test('optional fields are skipped when absent', () => {
    const result = run(validate(schemas.updateProfile), { body: { firstName: 'Ada' } });
    assert.equal(result.nextCalled, true);
});

test('uuidParam schema validates route params', () => {
    const v = validate(schemas.uuidParam);
    assert.equal(run(v, { params: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } }).nextCalled, true);
    assert.equal(run(v, { params: { id: 'nope' } }).statusCode, 400);
});

test('sanitize drops fields that are not allow-listed', () => {
    const result = run(sanitize(['email', 'password']), {
        body: { email: 'a@b.co', password: 'pw', isAdmin: true }
    });
    assert.equal(result.nextCalled, true);
    assert.deepEqual(result.req.body, { email: 'a@b.co', password: 'pw' });
});

test('trimStrings trims string values and leaves others alone', () => {
    const result = run(trimStrings, { body: { email: '  a@b.co  ', amount: 10 } });
    assert.equal(result.nextCalled, true);
    assert.deepEqual(result.req.body, { email: 'a@b.co', amount: 10 });
});

// JSON bodies can carry arrays and objects where a string is expected. The
// format rules used RegExp.test(), which coerces: ['a@b.co'] passed as an email
// and the handler then crashed calling .toLowerCase() on an array.
test('format rules reject values that are not strings', () => {
    const register = (overrides) => run(validate(schemas.register), {
        body: { email: 'user@example.com', password: 'correct-horse', firstName: 'Ada', lastName: 'Lovelace', ...overrides }
    });
    assert.equal(register({ email: ['user@example.com'] }).statusCode, 400);
    assert.equal(register({ email: { toString: () => 'user@example.com' } }).statusCode, 400);
    assert.equal(register({ password: 1234567890 }).statusCode, 400);
    assert.equal(register({ firstName: ['Ada'] }).statusCode, 400);

    assert.equal(run(validate(schemas.login), { body: { email: 'user@example.com', password: 12345678 } }).statusCode, 400);
    assert.equal(run(validate(schemas.login), { body: { email: 'user@example.com', password: { $ne: '' } } }).statusCode, 400);
    assert.equal(run(validate(schemas.purchaseNumber), { body: { phoneNumber: ['+14155550123'] } }).statusCode, 400);
    assert.equal(run(validate(schemas.uuidParam), { params: { id: ['3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b'] } }).statusCode, 400);
});

test('an over-long email is rejected', () => {
    const email = `${'a'.repeat(250)}@example.com`;
    assert.equal(run(validate(schemas.login), { body: { email, password: 'x' } }).statusCode, 400);
});

test('avatarUrl must be an https URL', () => {
    const update = (avatarUrl) => run(validate(schemas.updateProfile), { body: { avatarUrl } });
    assert.equal(update('https://example.com/a.png').nextCalled, true);
    assert.equal(update('http://example.com/a.png').statusCode, 400);
    assert.equal(update('javascript:alert(1)').statusCode, 400);
    assert.equal(update('data:text/html;base64,AAAA').statusCode, 400);
    assert.equal(update(`https://example.com/${'a'.repeat(3000)}`).statusCode, 400);
});
