import { Router } from 'express';
import ratesService, { NUMBER_TYPES } from '../services/rates.service.js';
import { optionalAuth } from '../middleware/auth.js';
import { parsePagination } from '../utils/validators.js';

const router = Router();

const COUNTRY_CODE_RE = /^[A-Za-z]{2,3}$/;
const isCountryCode = (value) => typeof value === 'string' && COUNTRY_CODE_RE.test(value);

/**
 * GET /api/rates
 * Search calling rates
 */
router.get('/', optionalAuth, async (req, res, next) => {
    try {
        const { q } = req.query;
        if (q !== undefined && (typeof q !== 'string' || q.length > 100)) {
            return res.status(400).json({ error: 'q must be a string of at most 100 characters' });
        }

        const result = await ratesService.searchRates(q, parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 }));
        res.json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/rates/:countryCode
 * Get rates for a specific country
 */
router.get('/:countryCode', optionalAuth, async (req, res, next) => {
    try {
        if (!isCountryCode(req.params.countryCode)) {
            return res.status(400).json({ error: 'Invalid country code' });
        }

        const rates = await ratesService.getRatesByCountry(req.params.countryCode);
        res.json({ rates });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/rates/estimate
 * Estimate call cost
 */
router.post('/estimate', optionalAuth, async (req, res, next) => {
    try {
        const { countryCode, duration = 1, numberType = 'landline' } = req.body || {};

        if (countryCode === undefined || countryCode === null || countryCode === '') {
            return res.status(400).json({ error: 'Country code is required' });
        }
        if (!isCountryCode(countryCode)) {
            return res.status(400).json({ error: 'Invalid country code' });
        }
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 1440) {
            return res.status(400).json({ error: 'duration must be a number of minutes between 0 and 1440' });
        }
        if (!NUMBER_TYPES.includes(numberType)) {
            return res.status(400).json({ error: `numberType must be one of: ${NUMBER_TYPES.join(', ')}` });
        }

        const estimate = await ratesService.estimateCallCost(countryCode, duration, numberType);
        res.json(estimate);
    } catch (error) {
        next(error);
    }
});

export default router;
