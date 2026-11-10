import db from '../config/database.js';
import { httpError } from '../utils/errors.js';
import { toMoney } from '../utils/validators.js';

const formatTransaction = (t) => ({
    id: t.id,
    type: t.type,
    amount: parseFloat(t.amount),
    description: t.description,
    referenceType: t.reference_type,
    referenceId: t.reference_id,
    balanceAfter: t.balance_after === null || t.balance_after === undefined ? null : parseFloat(t.balance_after),
    createdAt: t.created_at
});

/** Run fn inside the caller's transaction, or open one. */
const withTransaction = (trx, fn) => (trx ? fn(trx) : db.transaction(fn));

function requireAmount(amount) {
    const fixed = toMoney(amount);
    if (!fixed) {
        throw httpError(400, 'Amount must be a positive number with at most two decimal places');
    }
    return fixed;
}

class WalletService {
    /**
     * Get wallet by user ID
     */
    async getWallet(userId) {
        const wallet = await db('wallets')
            .where({ user_id: userId })
            .first();

        if (!wallet) {
            throw httpError(404, 'Wallet not found');
        }

        return {
            id: wallet.id,
            balance: parseFloat(wallet.balance),
            currency: wallet.currency,
            createdAt: wallet.created_at
        };
    }

    /**
     * Add funds to a wallet.
     *
     * The balance is changed with a single `balance = balance + ?` statement,
     * never read into JavaScript and written back, so concurrent credits
     * cannot overwrite each other.
     *
     * With an idempotencyKey the ledger row is inserted first; if that key was
     * already used nothing else happens and `duplicate: true` is returned.
     *
     * @param trx optional knex transaction to join
     */
    async addFunds(userId, amount, options = {}, trx = null) {
        const { stripePaymentId, description, referenceType = 'topup', referenceId, idempotencyKey, type = 'credit' } = options;
        const fixed = requireAmount(amount);

        return withTransaction(trx, async (tx) => {
            const wallet = await tx('wallets').where({ user_id: userId }).first('id');
            if (!wallet) {
                throw httpError(404, 'Wallet not found');
            }

            const insert = tx('transactions').insert({
                wallet_id: wallet.id,
                type,
                amount: fixed,
                description: description || 'Wallet top-up',
                stripe_payment_id: stripePaymentId || null,
                reference_type: referenceType,
                reference_id: referenceId || null,
                idempotency_key: idempotencyKey || null
            });

            const inserted = idempotencyKey
                ? await insert.onConflict('idempotency_key').ignore().returning('*')
                : await insert.returning('*');

            if (inserted.length === 0) {
                // Same key seen before: the money has already been credited.
                const current = await tx('wallets').where({ id: wallet.id }).first('balance');
                return { duplicate: true, balance: parseFloat(current.balance), transaction: null };
            }

            const [updated] = await tx('wallets')
                .where({ id: wallet.id })
                .update({
                    balance: tx.raw('balance + ?', [fixed]),
                    updated_at: tx.fn.now()
                })
                .returning('balance');

            const [transaction] = await tx('transactions')
                .where({ id: inserted[0].id })
                .update({ balance_after: updated.balance })
                .returning('*');

            return {
                duplicate: false,
                balance: parseFloat(updated.balance),
                transaction: formatTransaction(transaction)
            };
        });
    }

    /**
     * Deduct funds from a wallet.
     *
     * The check and the deduction are one statement
     * (`... SET balance = balance - ? WHERE balance >= ?`), so two concurrent
     * debits cannot both pass a balance check that only one of them can
     * afford.
     *
     * allowNegative is for charges whose amount is only known after the fact
     * (a finished call). Those are always recorded, even if the balance goes
     * below zero.
     *
     * @param trx optional knex transaction to join
     */
    async deductFunds(userId, amount, options = {}, trx = null) {
        const { description, referenceType, referenceId, idempotencyKey, allowNegative = false } = options;
        const fixed = requireAmount(amount);

        return withTransaction(trx, async (tx) => {
            let update = tx('wallets').where({ user_id: userId });
            if (!allowNegative) {
                update = update.where('balance', '>=', fixed);
            }

            const [updated] = await update
                .update({
                    balance: tx.raw('balance - ?', [fixed]),
                    updated_at: tx.fn.now()
                })
                .returning(['id', 'balance']);

            if (!updated) {
                const exists = await tx('wallets').where({ user_id: userId }).first('id');
                if (!exists) {
                    throw httpError(404, 'Wallet not found');
                }
                throw httpError(400, 'Insufficient funds', { code: 'INSUFFICIENT_FUNDS' });
            }

            const [transaction] = await tx('transactions')
                .insert({
                    wallet_id: updated.id,
                    type: 'debit',
                    amount: fixed,
                    description,
                    reference_type: referenceType,
                    reference_id: referenceId || null,
                    idempotency_key: idempotencyKey || null,
                    balance_after: updated.balance
                })
                .returning('*');

            return {
                balance: parseFloat(updated.balance),
                transaction: formatTransaction(transaction)
            };
        });
    }

    /**
     * Current balance as a number (0 when the user has no wallet).
     */
    async getBalance(userId, trx = null) {
        const wallet = await (trx || db)('wallets').where({ user_id: userId }).first('balance');
        return wallet ? parseFloat(wallet.balance) : 0;
    }

    /**
     * Check if user has sufficient balance.
     * Advisory only: use deductFunds for anything that must not overspend.
     */
    async hasSufficientBalance(userId, amount) {
        const wallet = await db('wallets').where({ user_id: userId }).first('balance');
        if (!wallet) return false;
        return parseFloat(wallet.balance) >= amount;
    }

    /**
     * Get transaction history
     */
    async getTransactions(userId, { page = 1, limit = 20, type } = {}) {
        const wallet = await db('wallets').where({ user_id: userId }).first('id');

        if (!wallet) {
            throw httpError(404, 'Wallet not found');
        }

        let query = db('transactions').where({ wallet_id: wallet.id });

        if (type) {
            query = query.where({ type });
        }

        // Count without ORDER BY: Postgres rejects ordering an aggregate by a
        // column that is not grouped.
        const [{ count }] = await query.clone().count();

        const transactions = await query
            .select('*')
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(limit)
            .offset((page - 1) * limit);

        return {
            transactions: transactions.map(formatTransaction),
            pagination: {
                page,
                limit,
                total: parseInt(count),
                totalPages: Math.ceil(parseInt(count) / limit)
            }
        };
    }
}

export default new WalletService();
