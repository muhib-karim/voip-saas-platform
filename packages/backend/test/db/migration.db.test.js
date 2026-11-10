import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { dbTestsEnabled, DB_SKIP_REASON } from '../helpers.js';

// Exercises the integrity migration itself: forwards, backwards, forwards
// again, and against the kind of rows the old code could leave behind.
const enabled = dbTestsEnabled();
const skip = enabled ? false : DB_SKIP_REASON;
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const INTEGRITY = '20261110000001_integrity_and_billing.js';

const schemas = [];
const instances = [];

/** A fresh schema with only the two original migrations applied. */
async function legacyDatabase() {
    const schema = `m_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    const admin = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL, pool: { min: 1, max: 1 } });
    await admin.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(727274)');
        await trx.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public');
        await trx.raw(`CREATE SCHEMA "${schema}"`);
    });
    await admin.destroy();
    schemas.push(schema);

    const db = knex({
        client: 'pg',
        connection: process.env.TEST_DATABASE_URL,
        searchPath: [schema, 'public'],
        pool: { min: 1, max: 2 },
        migrations: { directory }
    });
    instances.push(db);
    await db.migrate.up();
    await db.migrate.up();
    return { db, schema };
}

after(async () => {
    for (const db of instances) await db.destroy();
    if (!enabled) return;
    const admin = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL, pool: { min: 1, max: 1 } });
    for (const schema of schemas) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
});

const columns = async (db, schema, table) => {
    const { rows } = await db.raw(
        'SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
        [schema, table]
    );
    return Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
};

const newUser = async (db) => {
    const [user] = await db('users').insert({ email: `${crypto.randomUUID()}@example.com`, password_hash: 'x' }).returning('*');
    return user;
};

test('the migration applies, rolls back and applies again', { skip }, async () => {
    const { db, schema } = await legacyDatabase();

    await db.migrate.up();
    let wallets = await columns(db, schema, 'wallets');
    assert.equal(wallets.balance, 'NO');
    assert.equal(wallets.user_id, 'NO');
    assert.ok('idempotency_key' in await columns(db, schema, 'transactions'));
    assert.ok('billed_at' in await columns(db, schema, 'cdr'));
    assert.ok('family_id' in await columns(db, schema, 'refresh_tokens'));
    assert.ok('number_type' in await columns(db, schema, 'calling_rates'));

    await db.migrate.down();
    wallets = await columns(db, schema, 'wallets');
    assert.equal(wallets.balance, 'YES');
    assert.ok(!('idempotency_key' in await columns(db, schema, 'transactions')));
    assert.ok(!('billed_at' in await columns(db, schema, 'cdr')));
    assert.ok(!('family_id' in await columns(db, schema, 'refresh_tokens')));
    assert.ok(!('number_type' in await columns(db, schema, 'calling_rates')));

    await db.migrate.up();
    assert.equal(await db.migrate.currentVersion(), INTEGRITY.split('_')[0]);
});

test('existing duplicate ledger rows do not block the migration and are left for review', { skip }, async () => {
    const { db } = await legacyDatabase();
    const user = await newUser(db);
    const [wallet] = await db('wallets').insert({ user_id: user.id, balance: 50 }).returning('*');

    // What the old Stripe handler left behind when an event was delivered twice.
    await db('transactions').insert([
        { wallet_id: wallet.id, type: 'credit', amount: 25, stripe_payment_id: 'pi_legacy_dup', reference_type: 'topup', created_at: new Date('2026-01-01T10:00:00Z') },
        { wallet_id: wallet.id, type: 'credit', amount: 25, stripe_payment_id: 'pi_legacy_dup', reference_type: 'topup', created_at: new Date('2026-01-01T10:00:05Z') },
        { wallet_id: wallet.id, type: 'credit', amount: 10, stripe_payment_id: 'pi_legacy_single', reference_type: 'topup' }
    ]);

    // And what a duplicated call.hangup left behind.
    const [call] = await db('cdr')
        .insert({ user_id: user.id, call_id: 'legacy-call', direction: 'outbound', status: 'completed', start_time: new Date('2026-01-02T10:00:00Z'), end_time: new Date('2026-01-02T10:05:00Z') })
        .returning('*');
    await db('transactions').insert([
        { wallet_id: wallet.id, type: 'debit', amount: 0.05, reference_type: 'call', reference_id: call.id, created_at: new Date('2026-01-02T10:05:00Z') },
        { wallet_id: wallet.id, type: 'debit', amount: 0.05, reference_type: 'call', reference_id: call.id, created_at: new Date('2026-01-02T10:05:03Z') }
    ]);
    await db('cdr').insert({ user_id: user.id, call_id: 'legacy-open', direction: 'outbound', status: 'answered', start_time: new Date() });

    await db.migrate.up();

    const stripeRows = await db('transactions').where({ stripe_payment_id: 'pi_legacy_dup' }).orderBy('created_at');
    assert.equal(stripeRows[0].idempotency_key, 'stripe:pi_legacy_dup', 'the earliest row owns the key');
    assert.equal(stripeRows[1].idempotency_key, null, 'the duplicate is kept, unkeyed, for reconciliation');
    assert.equal((await db('transactions').where({ stripe_payment_id: 'pi_legacy_single' }).first()).idempotency_key, 'stripe:pi_legacy_single');

    const callRows = await db('transactions').where({ reference_type: 'call' }).orderBy('created_at');
    assert.equal(callRows[0].idempotency_key, `call:${call.id}`);
    assert.equal(callRows[1].idempotency_key, null);

    assert.ok((await db('cdr').where({ call_id: 'legacy-call' }).first()).billed_at, 'already-completed calls cannot be billed again');
    assert.equal((await db('cdr').where({ call_id: 'legacy-open' }).first()).billed_at, null);
    assert.equal((await db('transactions').where({ wallet_id: wallet.id })).length, 5, 'no rows were deleted');
});

test('a wallet with a NULL balance becomes zero', { skip }, async () => {
    const { db } = await legacyDatabase();
    const user = await newUser(db);
    await db('wallets').insert({ user_id: user.id, balance: null });

    await db.migrate.up();

    assert.equal(parseFloat((await db('wallets').where({ user_id: user.id }).first()).balance), 0);
});

test('existing refresh tokens each start their own family', { skip }, async () => {
    const { db } = await legacyDatabase();
    const user = await newUser(db);
    await db('refresh_tokens').insert([
        { user_id: user.id, token_hash: 'legacy-a', expires_at: new Date(Date.now() + 86_400_000) },
        { user_id: user.id, token_hash: 'legacy-b', expires_at: new Date(Date.now() + 86_400_000), revoked: true }
    ]);

    await db.migrate.up();

    const rows = await db('refresh_tokens').where({ user_id: user.id });
    assert.equal(new Set(rows.map((r) => r.family_id)).size, 2);
});

test('the migration refuses to guess when a user has two wallets', { skip }, async () => {
    const { db, schema } = await legacyDatabase();
    const user = await newUser(db);
    await db('wallets').insert([{ user_id: user.id, balance: 5 }, { user_id: user.id, balance: 7 }]);

    await assert.rejects(db.migrate.up(), /1 user\(s\) have more than one wallet/);

    // Transactional: nothing was half-applied and no wallet was removed.
    assert.ok(!('idempotency_key' in await columns(db, schema, 'transactions')));
    assert.equal((await db('wallets').where({ user_id: user.id })).length, 2);
});

test('the migration refuses to guess when a number has two live owners', { skip }, async () => {
    const { db } = await legacyDatabase();
    const [a, b] = [await newUser(db), await newUser(db)];
    await db('did_numbers').insert([
        { user_id: a.id, phone_number: '+14155550177', telnyx_number_id: 'x', status: 'active' },
        { user_id: b.id, phone_number: '+14155550177', telnyx_number_id: 'y', status: 'suspended' }
    ]);

    await assert.rejects(db.migrate.up(), /held by more than one non-released row/);
});

test('rolling back releases unfinished number reservations', { skip }, async () => {
    const { db } = await legacyDatabase();
    await db.migrate.up();
    const user = await newUser(db);
    await db('did_numbers').insert({ user_id: user.id, phone_number: '+14155550178', telnyx_number_id: 'pending', status: 'pending' });

    await db.migrate.down();

    const row = await db('did_numbers').where({ phone_number: '+14155550178' }).first();
    assert.equal(row.status, 'released');
    assert.equal(row.user_id, null);
});
