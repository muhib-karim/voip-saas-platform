/**
 * Data-integrity constraints for the wallet, numbers, calls, rates and
 * refresh tokens. Nothing here deletes rows: where existing data would break a
 * new constraint the migration stops and says what to reconcile.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    // ---- Guards -----------------------------------------------------------
    const problems = [];

    const { rows: [{ n: orphanWallets }] } = await knex.raw(
        'SELECT count(*)::int AS n FROM wallets WHERE user_id IS NULL'
    );
    if (orphanWallets > 0) problems.push(`${orphanWallets} wallet row(s) have no user_id`);

    const { rows: [{ n: duplicateWallets }] } = await knex.raw(
        'SELECT count(*)::int AS n FROM (SELECT user_id FROM wallets WHERE user_id IS NOT NULL GROUP BY user_id HAVING count(*) > 1) d'
    );
    if (duplicateWallets > 0) problems.push(`${duplicateWallets} user(s) have more than one wallet`);

    const { rows: [{ n: duplicateNumbers }] } = await knex.raw(
        "SELECT count(*)::int AS n FROM (SELECT phone_number FROM did_numbers WHERE status <> 'released' GROUP BY phone_number HAVING count(*) > 1) d"
    );
    if (duplicateNumbers > 0) problems.push(`${duplicateNumbers} phone number(s) are held by more than one non-released row`);

    const { rows: [{ n: duplicateRates }] } = await knex.raw(
        'SELECT count(*)::int AS n FROM (SELECT country_code FROM calling_rates GROUP BY country_code HAVING count(*) > 1) d'
    );
    if (duplicateRates > 0) problems.push(`${duplicateRates} country code(s) have more than one calling_rates row; set number_type by hand first`);

    if (problems.length > 0) {
        throw new Error(`Cannot apply integrity migration until this is reconciled:\n  - ${problems.join('\n  - ')}`);
    }

    // ---- wallets: one per user, balance always a number -------------------
    await knex.raw('UPDATE wallets SET balance = 0 WHERE balance IS NULL');
    await knex.raw('ALTER TABLE wallets ALTER COLUMN balance SET DEFAULT 0, ALTER COLUMN balance SET NOT NULL, ALTER COLUMN user_id SET NOT NULL');
    await knex.raw('ALTER TABLE wallets ADD CONSTRAINT wallets_user_id_unique UNIQUE (user_id)');

    // ---- transactions: idempotency key ------------------------------------
    // A plain unique index on stripe_payment_id / reference_id would fail to
    // build on the duplicate rows the old code could create, so the key is a
    // new nullable column. The earliest row per payment or call claims it and
    // any later duplicates keep NULL so they can be reviewed by hand.
    await knex.raw('ALTER TABLE transactions ADD COLUMN idempotency_key text');
    await knex.raw(`
        UPDATE transactions t SET idempotency_key = 'stripe:' || t.stripe_payment_id
        FROM (
            SELECT DISTINCT ON (stripe_payment_id) id FROM transactions
            WHERE stripe_payment_id IS NOT NULL AND type = 'credit'
            ORDER BY stripe_payment_id, created_at, id
        ) earliest
        WHERE t.id = earliest.id
    `);
    await knex.raw(`
        UPDATE transactions t SET idempotency_key = 'call:' || t.reference_id
        FROM (
            SELECT DISTINCT ON (reference_id) id FROM transactions
            WHERE reference_type = 'call' AND reference_id IS NOT NULL AND type = 'debit'
            ORDER BY reference_id, created_at, id
        ) earliest
        WHERE t.id = earliest.id
    `);
    await knex.raw('ALTER TABLE transactions ADD CONSTRAINT transactions_idempotency_key_unique UNIQUE (idempotency_key)');

    // ---- did_numbers: "pending" reservations, one live owner per number ----
    await knex.raw('ALTER TABLE did_numbers DROP CONSTRAINT did_numbers_status_check');
    await knex.raw("ALTER TABLE did_numbers ADD CONSTRAINT did_numbers_status_check CHECK (status IN ('active', 'suspended', 'released', 'pending'))");
    await knex.raw("CREATE UNIQUE INDEX did_numbers_phone_number_live_unique ON did_numbers (phone_number) WHERE status <> 'released'");

    // ---- cdr: settlement marker -------------------------------------------
    await knex.raw('ALTER TABLE cdr ADD COLUMN billed_at timestamptz');
    // Calls the old code already completed must not become billable again.
    await knex.raw("UPDATE cdr SET billed_at = COALESCE(end_time, created_at, now()) WHERE status = 'completed'");

    // ---- calling_rates: columns the rates service has always queried -------
    await knex.raw("ALTER TABLE calling_rates ADD COLUMN number_type varchar(20) NOT NULL DEFAULT 'landline'");
    await knex.raw('ALTER TABLE calling_rates ADD COLUMN billing_increment integer NOT NULL DEFAULT 60');
    await knex.raw('ALTER TABLE calling_rates ADD COLUMN active boolean NOT NULL DEFAULT true');
    await knex.raw('ALTER TABLE calling_rates ADD CONSTRAINT calling_rates_country_code_number_type_unique UNIQUE (country_code, number_type)');

    // ---- refresh_tokens: rotation families --------------------------------
    // gen_random_uuid() is volatile, so every existing row gets its own family.
    await knex.raw('ALTER TABLE refresh_tokens ADD COLUMN family_id uuid NOT NULL DEFAULT gen_random_uuid()');
    await knex.raw('ALTER TABLE refresh_tokens ADD COLUMN revoked_at timestamptz');
    // Why a token was revoked: 'rotated', 'logout', 'reuse'. Only a rotation
    // gets the short grace period for two tabs refreshing at once.
    await knex.raw('ALTER TABLE refresh_tokens ADD COLUMN revoked_reason varchar(20)');
    await knex.raw('UPDATE refresh_tokens SET revoked = false WHERE revoked IS NULL');
    await knex.raw('ALTER TABLE refresh_tokens ALTER COLUMN revoked SET NOT NULL');
    await knex.raw('CREATE INDEX refresh_tokens_family_id_index ON refresh_tokens (family_id)');
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    await knex.raw('DROP INDEX IF EXISTS refresh_tokens_family_id_index');
    await knex.raw('ALTER TABLE refresh_tokens ALTER COLUMN revoked DROP NOT NULL');
    await knex.raw('ALTER TABLE refresh_tokens DROP COLUMN revoked_reason, DROP COLUMN revoked_at, DROP COLUMN family_id');

    await knex.raw('ALTER TABLE calling_rates DROP CONSTRAINT calling_rates_country_code_number_type_unique');
    await knex.raw('ALTER TABLE calling_rates DROP COLUMN active, DROP COLUMN billing_increment, DROP COLUMN number_type');

    await knex.raw('ALTER TABLE cdr DROP COLUMN billed_at');

    // A predicate index is not a table constraint, so it is dropped as an index.
    await knex.raw('DROP INDEX IF EXISTS did_numbers_phone_number_live_unique');
    // The old CHECK has no "pending"; an unfinished reservation is not a live number.
    await knex.raw("UPDATE did_numbers SET status = 'released', user_id = NULL WHERE status = 'pending'");
    await knex.raw('ALTER TABLE did_numbers DROP CONSTRAINT did_numbers_status_check');
    await knex.raw("ALTER TABLE did_numbers ADD CONSTRAINT did_numbers_status_check CHECK (status IN ('active', 'suspended', 'released'))");

    await knex.raw('ALTER TABLE transactions DROP CONSTRAINT transactions_idempotency_key_unique');
    await knex.raw('ALTER TABLE transactions DROP COLUMN idempotency_key');

    await knex.raw('ALTER TABLE wallets DROP CONSTRAINT wallets_user_id_unique');
    await knex.raw('ALTER TABLE wallets ALTER COLUMN user_id DROP NOT NULL, ALTER COLUMN balance DROP NOT NULL');
}
