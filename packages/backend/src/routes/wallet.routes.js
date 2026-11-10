import { Router } from 'express';
import walletService from '../services/wallet.service.js';
import billingService, { MIN_TOPUP, MAX_TOPUP } from '../services/billing.service.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { parsePagination } from '../utils/validators.js';

const router = Router();

const topupSchema = {
    body: {
        amount: { type: 'number', required: true, min: MIN_TOPUP, max: MAX_TOPUP, maxDecimals: 2 }
    }
};

const transactionsSchema = {
    query: {
        page: { type: 'string' },
        limit: { type: 'string' },
        type: { type: 'string', enum: ['credit', 'debit', 'refund'] }
    }
};

/**
 * GET /api/wallet
 * Get wallet balance and info
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const wallet = await walletService.getWallet(req.user.userId);
        res.json(wallet);
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/wallet/topup
 * Create Stripe checkout session for topping up wallet
 */
router.post('/topup', authenticate, validate(topupSchema), async (req, res, next) => {
    try {
        const { amount } = req.body;
        const checkout = await billingService.createTopupCheckout(req.user.userId, { amount });
        res.json(checkout);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/wallet/transactions
 * Get transaction history
 */
router.get('/transactions', authenticate, validate(transactionsSchema), async (req, res, next) => {
    try {
        const result = await walletService.getTransactions(req.user.userId, {
            ...parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 }),
            type: req.query.type
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/wallet/payment-methods
 * List saved payment methods
 */
router.get('/payment-methods', authenticate, async (req, res, next) => {
    try {
        const methods = await billingService.listPaymentMethods(req.user.userId);
        res.json({ paymentMethods: methods });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/wallet/setup-payment
 * Create setup intent for saving payment method
 */
router.post('/setup-payment', authenticate, async (req, res, next) => {
    try {
        const result = await billingService.createSetupIntent(req.user.userId);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

export default router;
