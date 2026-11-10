import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDbTest, createUser, balanceOf } from '../helpers.js';

const ctx = await setupDbTest();
const { skip, db } = ctx;
const walletService = ctx.enabled ? (await import('../../src/services/wallet.service.js')).default : null;

after(() => ctx.cleanup());

const settle = (promises) => Promise.allSettled(promises);
const fulfilled = (results) => results.filter((r) => r.status === 'fulfilled');
const ledger = async (user, type) => {
    const wallet = await db('wallets').where({ user_id: user.id }).first('id');
    const query = db('transactions').where({ wallet_id: wallet.id });
    return type ? query.where({ type }) : query;
};

test('two concurrent debits cannot both spend the same balance', { skip }, async () => {
    const user = await createUser(db, { balance: 10 });

    const results = await settle([
        walletService.deductFunds(user.id, 8, { description: 'first', referenceType: 'test' }),
        walletService.deductFunds(user.id, 8, { description: 'second', referenceType: 'test' })
    ]);

    assert.equal(fulfilled(results).length, 1, 'exactly one debit succeeds');
    const rejected = results.find((r) => r.status === 'rejected');
    assert.equal(rejected.reason.status, 400);
    assert.equal(rejected.reason.code, 'INSUFFICIENT_FUNDS');
    assert.equal(await balanceOf(db, user), 2);
    assert.equal((await ledger(user, 'debit')).length, 1, 'the failed debit left no ledger row');
});

test('many concurrent debits stop exactly at zero', { skip }, async () => {
    const user = await createUser(db, { balance: 10 });

    const results = await settle(
        Array.from({ length: 25 }, () => walletService.deductFunds(user.id, 1, { description: 'x', referenceType: 'test' }))
    );

    assert.equal(fulfilled(results).length, 10);
    assert.equal(await balanceOf(db, user), 0);
    assert.equal((await ledger(user, 'debit')).length, 10);
});

test('concurrent credits all land', { skip }, async () => {
    const user = await createUser(db, { balance: 0 });

    await Promise.all(Array.from({ length: 10 }, () => walletService.addFunds(user.id, 1, { description: 'credit' })));

    assert.equal(await balanceOf(db, user), 10);
    assert.equal((await ledger(user, 'credit')).length, 10);
});

test('mixed concurrent credits and debits add up', { skip }, async () => {
    const user = await createUser(db, { balance: 50 });

    await Promise.all([
        ...Array.from({ length: 8 }, () => walletService.addFunds(user.id, 2.5, {})),
        ...Array.from({ length: 8 }, () => walletService.deductFunds(user.id, 1.25, { description: 'x', referenceType: 'test' }))
    ]);

    assert.equal(await balanceOf(db, user), 60);
});

test('an idempotency key is applied once, even under concurrency', { skip }, async () => {
    const user = await createUser(db, { balance: 0 });
    const key = `test:${user.id}`;

    const results = await Promise.all(
        Array.from({ length: 6 }, () => walletService.addFunds(user.id, 25, { idempotencyKey: key }))
    );

    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert.equal(results.filter((r) => r.duplicate).length, 5);
    assert.equal(await balanceOf(db, user), 25);
    assert.equal((await ledger(user)).length, 1);
});

test('every ledger row records the balance it produced', { skip }, async () => {
    const user = await createUser(db, { balance: 0 });

    const credit = await walletService.addFunds(user.id, 20, {});
    const debit = await walletService.deductFunds(user.id, 7.5, { description: 'x', referenceType: 'test' });

    assert.equal(credit.balance, 20);
    assert.equal(credit.transaction.balanceAfter, 20);
    assert.equal(debit.balance, 12.5);
    assert.equal(debit.transaction.balanceAfter, 12.5);
});

test('cents are exact: 0.10 added three times is 0.30', { skip }, async () => {
    const user = await createUser(db, { balance: 0 });
    for (let i = 0; i < 3; i++) await walletService.addFunds(user.id, 0.1, {});
    assert.equal(await balanceOf(db, user), 0.3);
});

test('a debit joins the caller\'s transaction and rolls back with it', { skip }, async () => {
    const user = await createUser(db, { balance: 10 });

    await assert.rejects(
        db.transaction(async (trx) => {
            await walletService.deductFunds(user.id, 4, { description: 'x', referenceType: 'test' }, trx);
            throw new Error('caller failed after the debit');
        }),
        /caller failed/
    );

    assert.equal(await balanceOf(db, user), 10);
    assert.equal((await ledger(user)).length, 0);
});

test('allowNegative records a charge the balance cannot cover', { skip }, async () => {
    const user = await createUser(db, { balance: 0.01 });

    const result = await walletService.deductFunds(user.id, 0.03, {
        description: 'call', referenceType: 'call', allowNegative: true
    });

    assert.equal(result.balance, -0.02);
    await assert.rejects(
        walletService.deductFunds(user.id, 0.01, { description: 'x', referenceType: 'test' }),
        { status: 400 }
    );
});

test('amounts that are not positive money are refused', { skip }, async () => {
    const user = await createUser(db, { balance: 10 });

    for (const bad of [0, -5, 1.005, NaN, Infinity, '5', null]) {
        await assert.rejects(walletService.addFunds(user.id, bad, {}), { status: 400 }, `credit ${bad}`);
        await assert.rejects(
            walletService.deductFunds(user.id, bad, { description: 'x', referenceType: 'test' }),
            { status: 400 },
            `debit ${bad}`
        );
    }
    assert.equal(await balanceOf(db, user), 10);
});

test('a user without a wallet gets a 404, not a silent no-op', { skip }, async () => {
    const missing = '3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b';
    await assert.rejects(walletService.addFunds(missing, 5, {}), { status: 404 });
    await assert.rejects(walletService.deductFunds(missing, 5, { description: 'x', referenceType: 'test' }), { status: 404 });
});

test('the schema allows only one wallet per user', { skip }, async () => {
    const user = await createUser(db, { balance: 0 });
    await assert.rejects(db('wallets').insert({ user_id: user.id, balance: 0 }), { code: '23505' });
});
