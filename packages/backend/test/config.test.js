import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers.js';

setupTestEnv();
const { loadConfig, ConfigError, parseDuration } = await import('../src/config/index.js');

// A complete, valid production environment. Each test removes or breaks one thing.
const productionEnv = (overrides = {}) => ({
    NODE_ENV: 'production',
    JWT_SECRET: 'k'.repeat(48),
    DATABASE_URL: 'postgresql://app@db.internal:5432/voip',
    STRIPE_SECRET_KEY: 'stripe-key-for-config-test',
    STRIPE_WEBHOOK_SECRET: 'stripe-webhook-key-for-config-test',
    TELNYX_API_KEY: 'telnyx-key-for-config-test',
    TELNYX_PUBLIC_KEY: 'telnyx-public-key-for-config-test',
    TELNYX_SIP_CONNECTION_ID: '1234567890',
    FRONTEND_URL: 'https://app.example.com',
    BACKEND_URL: 'https://api.example.com',
    ...overrides
});

const problemsOf = (env) => {
    try {
        loadConfig(env);
        return [];
    } catch (error) {
        assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`);
        return error.problems;
    }
};

test('a complete production environment loads', () => {
    const config = loadConfig(productionEnv());
    assert.equal(config.isProduction, true);
    assert.equal(config.jwtSecret, 'k'.repeat(48));
});

test('production refuses to start without JWT_SECRET (no built-in fallback)', () => {
    const problems = problemsOf(productionEnv({ JWT_SECRET: undefined }));
    assert.deepEqual(problems, ['JWT_SECRET is required']);
});

test('production rejects the placeholder secrets this repo has published', () => {
    for (const published of ['dev-secret-change-in-production', 'your-super-secret-jwt-key-change-in-production']) {
        const problems = problemsOf(productionEnv({ JWT_SECRET: published }));
        assert.equal(problems.length, 1, published);
        assert.match(problems[0], /JWT_SECRET/);
    }
});

test('production rejects a short JWT secret', () => {
    assert.deepEqual(problemsOf(productionEnv({ JWT_SECRET: 'short-secret' })), [
        'JWT_SECRET must be at least 32 characters'
    ]);
});

test('production requires every payment, telephony and database setting', () => {
    for (const name of [
        'DATABASE_URL',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'TELNYX_API_KEY',
        'TELNYX_PUBLIC_KEY',
        'TELNYX_SIP_CONNECTION_ID',
        'FRONTEND_URL',
        'BACKEND_URL'
    ]) {
        assert.deepEqual(problemsOf(productionEnv({ [name]: undefined })), [`${name} is required`]);
    }
});

test('production requires https URLs', () => {
    assert.deepEqual(problemsOf(productionEnv({ FRONTEND_URL: 'http://app.example.com' })), [
        'FRONTEND_URL must be an https:// URL'
    ]);
});

test('every problem is reported at once', () => {
    const problems = problemsOf({ NODE_ENV: 'production' });
    assert.equal(problems.length, 9);
});

test('outside production a missing JWT_SECRET becomes a random per-process key', () => {
    const a = loadConfig({ NODE_ENV: 'development' });
    const b = loadConfig({ NODE_ENV: 'development' });
    assert.match(a.jwtSecret, /^[0-9a-f]{96}$/);
    assert.notEqual(a.jwtSecret, b.jwtSecret);
    assert.notEqual(a.jwtSecret, 'dev-secret-change-in-production');
});

test('NODE_ENV defaults to development and documented settings are honoured', () => {
    const config = loadConfig({
        JWT_EXPIRES_IN: '5m',
        REFRESH_TOKEN_EXPIRES_IN: '2d',
        BCRYPT_ROUNDS: '11',
        RATE_LIMIT_WINDOW_MS: '60000',
        RATE_LIMIT_MAX_REQUESTS: '250',
        TRUST_PROXY: '2',
        DB_SCHEMA: 'tenant_a'
    });
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.jwtExpiresIn, '5m');
    assert.equal(config.refreshTokenTtlMs, 2 * 24 * 60 * 60 * 1000);
    assert.equal(config.bcryptRounds, 11);
    assert.equal(config.rateLimitWindowMs, 60000);
    assert.equal(config.rateLimitMax, 250);
    assert.equal(config.trustProxy, 2);
    assert.equal(config.dbSchema, 'tenant_a');
});

test('defaults: 15-minute access tokens, 7-day refresh tokens, bcrypt cost 12, one trusted proxy', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    assert.equal(config.jwtExpiresIn, '15m');
    assert.equal(config.refreshTokenTtlMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(config.bcryptRounds, 12);
    assert.equal(config.trustProxy, 1);
    assert.equal(config.maxConcurrentCalls, 2);
});

test('production never accepts a weak bcrypt cost', () => {
    assert.equal(loadConfig(productionEnv({ BCRYPT_ROUNDS: '4' })).bcryptRounds, 10);
});

test('parseDuration understands s/m/h/d and falls back on junk', () => {
    assert.equal(parseDuration('90s', 1), 90000);
    assert.equal(parseDuration('15m', 1), 900000);
    assert.equal(parseDuration('2h', 1), 7200000);
    assert.equal(parseDuration('7d', 1), 604800000);
    assert.equal(parseDuration('30', 1), 30000);
    assert.equal(parseDuration('soon', 1234), 1234);
    assert.equal(parseDuration(undefined, 1234), 1234);
});
