// Deterministic, offline configuration for tests. Must run before src/ modules
// are imported, because src/config reads process.env at import time.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

export const TEST_JWT_SECRET = 'test-only-jwt-secret';
export const TEST_JWT_ISSUER = 'voip-saas-api';
export const TEST_JWT_AUDIENCE = 'voip-saas-clients';
export const TEST_STRIPE_WEBHOOK_SECRET = 'whsec_test_placeholder';

const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export function setupTestEnv(overrides = {}) {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = TEST_STRIPE_WEBHOOK_SECRET;
    process.env.TELNYX_API_KEY = 'test-placeholder';
    process.env.BCRYPT_ROUNDS = '4';
    Object.assign(process.env, overrides);
}

/** Sign an access token the way the app does; override anything to forge a bad one. */
export function signAccessToken(
    payload = { userId: 'user-1', email: 'u@example.com', type: 'access' },
    options = {}
) {
    const merged = {
        algorithm: 'HS256',
        expiresIn: '15m',
        issuer: TEST_JWT_ISSUER,
        audience: TEST_JWT_AUDIENCE,
        ...options
    };
    // Passing `{ expiresIn: undefined }` (or issuer/audience) drops that claim.
    for (const key of Object.keys(merged)) {
        if (merged[key] === undefined) delete merged[key];
    }
    return jwt.sign(payload, TEST_JWT_SECRET, merged);
}

/**
 * Generate an Ed25519 key pair and return what Telnyx would give you (the
 * base64 public key) plus a function that signs a webhook body like Telnyx.
 */
export function createTelnyxSigner() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    // The last 32 bytes of the SPKI encoding are the raw Ed25519 public key.
    const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

    const sign = (body, timestamp = Math.floor(Date.now() / 1000)) => ({
        'telnyx-timestamp': String(timestamp),
        'telnyx-signature-ed25519': crypto
            .sign(null, Buffer.from(`${timestamp}|${body}`, 'utf8'), privateKey)
            .toString('base64')
    });

    return { publicKeyBase64, sign };
}

/**
 * DB-backed tests run only when TEST_DATABASE_URL points at a PostgreSQL
 * server. CI sets REQUIRE_DB_TESTS=1 so a missing database fails the run
 * instead of quietly skipping the tests that cover money and tokens.
 */
export function dbTestsEnabled() {
    if (process.env.TEST_DATABASE_URL) return true;
    if (process.env.REQUIRE_DB_TESTS === '1') {
        throw new Error('REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set');
    }
    return false;
}

export const DB_SKIP_REASON = 'TEST_DATABASE_URL is not set (start Postgres and export it to run DB tests)';

/**
 * Create a private schema for one test file, run every migration into it and
 * point the app at it (DATABASE_URL + DB_SCHEMA). Call before importing src/.
 *
 * Test files run in separate processes, so schema creation is serialised with
 * an advisory lock; after that each file only ever touches its own schema.
 *
 * @returns {{ schema: string, drop: () => Promise<void> }}
 */
export async function createTestSchema(envOverrides = {}) {
    const { default: knex } = await import('knex');
    const connection = process.env.TEST_DATABASE_URL;
    const schema = `t_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;

    const admin = knex({ client: 'pg', connection, pool: { min: 1, max: 1 } });
    try {
        await admin.transaction(async (trx) => {
            await trx.raw('SELECT pg_advisory_xact_lock(727274)');
            // Installed once in "public" so no test schema owns the extension.
            await trx.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public');
            await trx.raw(`CREATE SCHEMA "${schema}"`);
        });
    } finally {
        await admin.destroy();
    }

    const migrator = knex({ client: 'pg', connection, searchPath: [schema, 'public'], pool: { min: 1, max: 1 } });
    try {
        await migrator.migrate.latest({ directory: migrationsDirectory });
    } finally {
        await migrator.destroy();
    }

    setupTestEnv({ DATABASE_URL: connection, DB_SCHEMA: schema, ...envOverrides });

    return {
        schema,
        async drop() {
            const cleaner = knex({ client: 'pg', connection, pool: { min: 1, max: 1 } });
            try {
                await cleaner.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            } finally {
                await cleaner.destroy();
            }
        }
    };
}

let userCounter = 0;

/** Insert a user with a wallet; every call gets a unique email. */
export async function createUser(db, { balance = 0 } = {}) {
    userCounter += 1;
    const email = `user${userCounter}-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const [user] = await db('users')
        .insert({ email, password_hash: 'not-a-real-hash', first_name: 'Test', last_name: 'User' })
        .returning('*');
    await db('wallets').insert({ user_id: user.id, balance, currency: 'USD' });
    return user;
}

export async function balanceOf(db, user) {
    const wallet = await db('wallets').where({ user_id: user.id }).first('balance');
    return parseFloat(wallet.balance);
}

/** Reserved-for-fiction numbers only (US 555-01xx, UK 020 7946 0xxx). */
let numberCounter = 0;
export function fictionalUsNumber() {
    numberCounter = (numberCounter + 1) % 100;
    const area = 200 + Math.floor(Math.random() * 700);
    return `+1${area}55501${String(numberCounter).padStart(2, '0')}`;
}

/**
 * One-call setup for a DB-backed test file:
 *
 *   const ctx = await setupDbTest();
 *   test('...', { skip: ctx.skip }, async () => { ... });
 *
 * When enabled, the app's own knex instance is returned as ctx.db and is
 * closed (and the schema dropped) by ctx.cleanup().
 */
export async function setupDbTest(envOverrides = {}) {
    if (!dbTestsEnabled()) {
        return { enabled: false, skip: DB_SKIP_REASON, db: null, cleanup: async () => {} };
    }

    const schema = await createTestSchema(envOverrides);
    const { default: db } = await import('../src/config/database.js');

    return {
        enabled: true,
        skip: false,
        db,
        schema: schema.schema,
        async cleanup() {
            await db.destroy();
            await schema.drop();
        }
    };
}
