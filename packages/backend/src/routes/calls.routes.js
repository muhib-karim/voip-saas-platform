import { Router } from 'express';
import telnyxService from '../services/telnyx.service.js';
import cdrService, { CDR_DIRECTIONS, CDR_STATUSES } from '../services/cdr.service.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimiters } from '../middleware/rateLimiter.js';
import { E164_RE, parsePagination } from '../utils/validators.js';

const router = Router();

const E164_MESSAGE = 'must be a phone number in E.164 format, for example +14155550123';

const callSchema = {
    body: {
        from: { type: 'string', required: true, pattern: E164_RE, patternMessage: `from ${E164_MESSAGE}` },
        to: { type: 'string', required: true, pattern: E164_RE, patternMessage: `to ${E164_MESSAGE}` }
    }
};

const historySchema = {
    query: {
        page: { type: 'string' },
        limit: { type: 'string' },
        direction: { type: 'string', enum: CDR_DIRECTIONS },
        status: { type: 'string', enum: CDR_STATUSES },
        startDate: { type: 'isoDate' },
        endDate: { type: 'isoDate' }
    }
};

const statsSchema = {
    query: {
        period: { type: 'string', pattern: /^\d{1,3}d?$/, patternMessage: 'period must be a number of days, for example 30d' }
    }
};

const callIdSchema = {
    params: {
        id: { type: 'string', required: true, maxLength: 255 }
    }
};

/**
 * GET /api/calls/token
 * Get WebRTC token for softphone
 */
router.get('/token', authenticate, async (req, res, next) => {
    try {
        const token = await telnyxService.generateWebRTCToken(req.user.userId);
        res.json(token);
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/calls
 * Initiate an outbound call
 */
router.post('/', authenticate, rateLimiters.expensive, validate(callSchema), async (req, res, next) => {
    try {
        const { from, to } = req.body;
        const { didNumberId, ...call } = await telnyxService.initiateCall(req.user.userId, { from, to });

        // Log call initiation. A webhook may already have created the row; this
        // attaches the user to it either way.
        await cdrService.recordCall({
            callId: call.callId,
            telnyxCallControlId: call.callId,
            userId: req.user.userId,
            didNumberId,
            direction: 'outbound',
            fromNumber: from,
            toNumber: to,
            startTime: new Date()
        });

        res.status(201).json(call);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/calls/history
 * Get call history (CDR)
 */
router.get('/history', authenticate, validate(historySchema), async (req, res, next) => {
    try {
        const { direction, status, startDate, endDate } = req.query;
        const result = await cdrService.getUserCDR(req.user.userId, {
            ...parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 }),
            direction,
            status,
            startDate,
            endDate
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/calls/stats
 * Get call statistics
 */
router.get('/stats', authenticate, validate(statsSchema), async (req, res, next) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.period) || 30, 1), 365);
        const stats = await cdrService.getCallStats(req.user.userId, { days });
        res.json(stats);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/calls/:id
 * Get one of the caller's own calls by ID
 */
router.get('/:id', authenticate, validate(callIdSchema), async (req, res, next) => {
    try {
        const cdr = await cdrService.getCDRByCallId(req.params.id, req.user.userId);
        if (!cdr) {
            return res.status(404).json({ error: 'Call not found' });
        }
        res.json(cdr);
    } catch (error) {
        next(error);
    }
});

export default router;
