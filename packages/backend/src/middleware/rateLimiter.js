import config from '../config/index.js';
import { cache } from '../config/redis.js';

/**
 * In-process fallback counters, used whenever Redis is unavailable so that a
 * Redis outage degrades rate limiting to per-process instead of turning it off.
 */
const memoryStore = new Map();
const MEMORY_STORE_MAX_KEYS = 50000;

function pruneMemoryStore(now) {
    for (const [key, entry] of memoryStore) {
        if (entry.resetAt <= now) memoryStore.delete(key);
    }
    // Still full of live windows: drop the oldest entries rather than grow.
    if (memoryStore.size >= MEMORY_STORE_MAX_KEYS) {
        let excess = memoryStore.size - MEMORY_STORE_MAX_KEYS + 1;
        for (const key of memoryStore.keys()) {
            if (excess-- <= 0) break;
            memoryStore.delete(key);
        }
    }
}

function memoryHit(key, windowMs, now = Date.now()) {
    let entry = memoryStore.get(key);
    if (!entry || entry.resetAt <= now) {
        if (memoryStore.size >= MEMORY_STORE_MAX_KEYS) pruneMemoryStore(now);
        entry = { count: 0, resetAt: now + windowMs };
        memoryStore.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
}

/** Clear the in-process counters (tests). */
export function resetRateLimitMemory() {
    memoryStore.clear();
}

/**
 * Fixed-window rate limiter. Counts in Redis when it is reachable and in
 * process memory when it is not; it never fails open.
 */
export function createRateLimiter(options = {}) {
    const {
        windowMs = 15 * 60 * 1000,  // 15 minutes
        max = 100,                    // Max requests per window
        keyPrefix = 'rl:',
        message = 'Too many requests, please try again later',
        keyGenerator = (req) => req.ip,
        skip = () => false,
        handler = null
    } = options;

    const windowSeconds = Math.ceil(windowMs / 1000);

    return async (req, res, next) => {
        // Skip if configured to skip this request
        if (skip(req)) {
            return next();
        }

        const key = `${keyPrefix}${keyGenerator(req)}`;
        const now = Date.now();

        const redisHit = await cache.hit(key, windowSeconds);
        const { count, resetAt } = redisHit
            ? { count: redisHit.count, resetAt: now + redisHit.ttlSeconds * 1000 }
            : memoryHit(key, windowMs, now);

        const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));

        // Set rate limit headers
        res.set({
            'X-RateLimit-Limit': max,
            'X-RateLimit-Remaining': Math.max(0, max - count),
            'X-RateLimit-Reset': new Date(resetAt).toISOString()
        });

        if (count > max) {
            res.set('Retry-After', retryAfter);

            if (handler) {
                return handler(req, res, next);
            }

            return res.status(429).json({
                error: message,
                retryAfter
            });
        }

        next();
    };
}

/**
 * Pre-configured rate limiters for different endpoints
 */
export const rateLimiters = {
    // Strict limiter for credential endpoints (prevent brute force)
    auth: createRateLimiter({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 10,                   // 10 attempts
        keyPrefix: 'rl:auth:',
        message: 'Too many login attempts. Please try again in 15 minutes.'
    }),

    // Token refresh: frequent for legitimate clients (every tab, every 15
    // minutes), so looser than login but still bounded.
    refresh: createRateLimiter({
        windowMs: 15 * 60 * 1000,
        max: 60,
        keyPrefix: 'rl:refresh:',
        message: 'Too many token refresh attempts. Please try again later.'
    }),

    // Standard API limiter
    api: createRateLimiter({
        windowMs: config.rateLimitWindowMs,
        max: config.rateLimitMax,
        keyPrefix: 'rl:api:'
    }),

    // Limiter for expensive operations (number search, placing calls)
    expensive: createRateLimiter({
        windowMs: 60 * 1000,       // 1 minute
        max: 10,
        keyPrefix: 'rl:expensive:',
        message: 'Rate limit exceeded for this operation'
    }),

    // Webhook limiter (more permissive for Stripe/Telnyx)
    webhook: createRateLimiter({
        windowMs: 60 * 1000,
        max: 500,
        keyPrefix: 'rl:webhook:'
    }),

    // DID purchase limiter (prevent abuse)
    didPurchase: createRateLimiter({
        windowMs: 60 * 60 * 1000,  // 1 hour
        max: 5,                     // 5 purchases per hour
        keyPrefix: 'rl:did:',
        message: 'Purchase limit reached. Please try again later.'
    })
};

export default rateLimiters;
