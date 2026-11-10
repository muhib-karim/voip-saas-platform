import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers.js';

setupTestEnv();
const { errorHandler, toClientError } = await import('../src/middleware/errorHandler.js');
const { httpError } = await import('../src/utils/errors.js');

function respond(err) {
    const res = {
        statusCode: null,
        body: null,
        headersSent: false,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
    errorHandler(err, { path: '/api/test', method: 'GET' }, res, () => {});
    return res;
}

test('a client error raised on purpose keeps its status, label and message', () => {
    const res = respond(httpError(401, 'Invalid email or password'));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized', message: 'Invalid email or password' });
});

test('error codes and details are passed through for HttpErrors', () => {
    const res = respond(httpError(400, 'Insufficient funds', { code: 'INSUFFICIENT_FUNDS' }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INSUFFICIENT_FUNDS');
});

test('an unexpected error never exposes its message, whatever NODE_ENV is', () => {
    const sqlError = new Error('select * from "did_numbers" where "id" = $1 - invalid input syntax for type uuid: "x"');
    const res = respond(sqlError);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal Server Error', message: 'An unexpected error occurred' });
    assert.ok(!JSON.stringify(res.body).includes('did_numbers'));
});

test('a bare status on an unknown error is not trusted to make it client-visible', () => {
    const err = new Error('connection string: postgresql://user:pw@host/db');
    err.status = 400;
    const res = respond(err);
    assert.equal(res.statusCode, 500);
    assert.ok(!JSON.stringify(res.body).includes('postgresql'));
});

test('malformed JSON is a 400 with fixed wording, not the parser message', () => {
    const err = new SyntaxError('Unexpected token } in JSON at position 17 near {"password":"hunter2"}');
    Object.assign(err, { status: 400, statusCode: 400, expose: true, type: 'entity.parse.failed' });
    const res = respond(err);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Bad Request', message: 'Malformed JSON in request body' });
});

test('an oversized body is a 413', () => {
    const err = Object.assign(new Error('request entity too large'), { status: 413, expose: true, type: 'entity.too.large' });
    assert.equal(respond(err).statusCode, 413);
});

test('Stripe SDK errors become a generic payment error', () => {
    const err = Object.assign(new Error('No such customer: cus_internal_id'), { type: 'StripeInvalidRequestError', statusCode: 400 });
    const { status, body } = toClientError(err);
    assert.equal(status, 502);
    assert.equal(body.error, 'Payment Error');
    assert.ok(!body.message.includes('cus_internal_id'));
});

test('provider failures raised by services are a 502 with a safe message', () => {
    const res = respond(httpError(502, 'Failed to initiate call'));
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: 'Bad Gateway', message: 'Failed to initiate call' });
});
