import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load the repo-root .env regardless of the working directory. Tests set their
// own environment and must never pick up a developer's .env.
if (process.env.NODE_ENV !== 'test') {
    dotenv.config({ path: path.resolve(here, '../../../../.env') });
}

const MIN_JWT_SECRET_LENGTH = 32;

// Values that have appeared in this repo's code, docs or CI. A deployment
// that still uses one of them is running with a publicly known signing key.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
    'dev-secret-change-in-production',
    'your-super-secret-jwt-key-change-in-production',
    'test-secret',
    'test-only-jwt-secret',
    'changeme',
    'change-me',
    'secret'
]);

const DURATION_UNITS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

/** Parse "15m", "7d", "3600s" or a bare number of seconds into milliseconds. */
export function parseDuration(value, fallbackMs) {
    if (value === undefined || value === null || value === '') return fallbackMs;
    const match = /^(\d+)\s*([smhd])?$/.exec(String(value).trim());
    if (!match) return fallbackMs;
    return Number(match[1]) * DURATION_UNITS[match[2] || 's'];
}

function parseInteger(value, fallback, { min, max } = {}) {
    const n = Number(value);
    if (value === undefined || value === '' || !Number.isInteger(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
}

/** Express "trust proxy" setting: a hop count, a boolean, or a subnet list. */
function parseTrustProxy(value) {
    if (value === undefined || value === '') return 1;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return /^\d+$/.test(value) ? Number(value) : value;
}

function isHttpsUrl(value) {
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}

export class ConfigError extends Error {
    constructor(problems) {
        super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

/**
 * Build the config from an environment object. In production every secret and
 * URL must be supplied explicitly; nothing falls back to a built-in default.
 */
export function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const problems = [];

    let jwtSecret = env.JWT_SECRET;
    if (isProduction) {
        if (!jwtSecret) {
            problems.push('JWT_SECRET is required');
        } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
            problems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
        } else if (KNOWN_PLACEHOLDER_SECRETS.has(jwtSecret)) {
            problems.push('JWT_SECRET is a published placeholder value');
        }

        for (const name of [
            'DATABASE_URL',
            'STRIPE_SECRET_KEY',
            'STRIPE_WEBHOOK_SECRET',
            'TELNYX_API_KEY',
            'TELNYX_PUBLIC_KEY',
            'TELNYX_SIP_CONNECTION_ID'
        ]) {
            if (!env[name]) problems.push(`${name} is required`);
        }

        for (const name of ['FRONTEND_URL', 'BACKEND_URL']) {
            if (!env[name]) problems.push(`${name} is required`);
            else if (!isHttpsUrl(env[name])) problems.push(`${name} must be an https:// URL`);
        }
    } else if (!jwtSecret) {
        // No shared default: each process gets its own key, so a token minted
        // against one developer's machine is worthless anywhere else.
        jwtSecret = crypto.randomBytes(48).toString('hex');
    }

    if (problems.length > 0) {
        throw new ConfigError(problems);
    }

    return Object.freeze({
        // Server
        port: parseInteger(env.PORT, 5000, { min: 1, max: 65535 }),
        nodeEnv,
        isProduction,
        trustProxy: parseTrustProxy(env.TRUST_PROXY),

        // Database
        databaseUrl: env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/voip_saas',
        dbSchema: env.DB_SCHEMA || null,

        // Auth
        jwtSecret,
        jwtExpiresIn: env.JWT_EXPIRES_IN || '15m',
        jwtIssuer: 'voip-saas-api',
        jwtAudience: 'voip-saas-clients',
        refreshTokenTtlMs: parseDuration(env.REFRESH_TOKEN_EXPIRES_IN, 7 * DURATION_UNITS.d),
        bcryptRounds: parseInteger(env.BCRYPT_ROUNDS, 12, { min: isProduction ? 10 : 4, max: 15 }),

        // Rate limiting (general API limiter)
        rateLimitWindowMs: parseInteger(env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, { min: 1000 }),
        rateLimitMax: parseInteger(env.RATE_LIMIT_MAX_REQUESTS, 100, { min: 1 }),

        // Calls
        maxConcurrentCalls: parseInteger(env.MAX_CONCURRENT_CALLS, 2, { min: 1, max: 50 }),

        // Telnyx
        telnyxApiKey: env.TELNYX_API_KEY,
        telnyxPublicKey: env.TELNYX_PUBLIC_KEY,
        telnyxSipConnectionId: env.TELNYX_SIP_CONNECTION_ID,

        // Stripe
        stripeSecretKey: env.STRIPE_SECRET_KEY,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,

        // URLs
        frontendUrl: env.FRONTEND_URL || 'http://localhost:3000',
        backendUrl: env.BACKEND_URL || 'http://localhost:5000',

        // Redis
        redisUrl: env.REDIS_URL || 'redis://localhost:6379'
    });
}

export default loadConfig(process.env);
