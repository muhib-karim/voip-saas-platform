import { Router } from 'express';
import telnyxService from '../services/telnyx.service.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimiters } from '../middleware/rateLimiter.js';
import { E164_RE } from '../utils/validators.js';

const router = Router();

const searchSchema = {
    query: {
        countryCode: { type: 'string', pattern: /^[A-Za-z]{2}$/, patternMessage: 'countryCode must be a 2-letter country code' },
        areaCode: { type: 'string', pattern: /^\d{1,6}$/, patternMessage: 'areaCode must be 1 to 6 digits' },
        contains: { type: 'string', pattern: /^\d{1,10}$/, patternMessage: 'contains must be 1 to 10 digits' },
        type: { type: 'string', enum: ['local', 'toll_free', 'mobile'] },
        limit: { type: 'string', pattern: /^\d{1,3}$/, patternMessage: 'limit must be a number' }
    }
};

const purchaseSchema = {
    body: {
        phoneNumber: {
            type: 'string',
            required: true,
            pattern: E164_RE,
            patternMessage: 'phoneNumber must be in E.164 format, for example +14155550123'
        }
    }
};

const numberIdSchema = {
    params: {
        id: { type: 'uuid', required: true }
    }
};

/**
 * GET /api/numbers/search
 * Search available DID numbers
 */
router.get('/search', authenticate, rateLimiters.expensive, validate(searchSchema), async (req, res, next) => {
    try {
        const { countryCode, areaCode, contains, type, limit } = req.query;
        const numbers = await telnyxService.searchNumbers({
            countryCode: (countryCode || 'US').toUpperCase(),
            areaCode,
            contains,
            type: type || 'local',
            limit: Math.min(Math.max(parseInt(limit) || 20, 1), 50)
        });
        res.json({ numbers });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/numbers
 * Get user's DID numbers
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const numbers = await telnyxService.getUserNumbers(req.user.userId);
        res.json({ numbers });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/numbers/purchase
 * Purchase a DID number
 */
router.post('/purchase', authenticate, rateLimiters.didPurchase, validate(purchaseSchema), async (req, res, next) => {
    try {
        const { phoneNumber } = req.body;
        const result = await telnyxService.purchaseNumber(req.user.userId, phoneNumber);
        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/numbers/:id
 * Release a DID number
 */
router.delete('/:id', authenticate, validate(numberIdSchema), async (req, res, next) => {
    try {
        const result = await telnyxService.releaseNumber(req.user.userId, req.params.id);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

export default router;
