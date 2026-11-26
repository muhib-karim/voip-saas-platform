/**
 * Small, dependency-free input helpers shared by routes and services.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** E.164 with a mandatory leading "+". */
export const E164_RE = /^\+[1-9]\d{6,14}$/;
/** Refresh tokens are 64 random bytes, hex encoded. */
export const REFRESH_TOKEN_RE = /^[0-9a-f]{128}$/;

export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
export const isE164 = (value) => typeof value === 'string' && E164_RE.test(value);
export const isRefreshToken = (value) => typeof value === 'string' && REFRESH_TOKEN_RE.test(value);

/**
 * Linear-time email check (avoids regex backtracking). Enforces RFC 5321 max
 * length (254), no whitespace, one "@", and a non-empty dotted domain.
 */
export function isEmail(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 254 || /\s/.test(value)) {
        return false;
    }
    const at = value.indexOf('@');
    if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
    const domain = value.slice(at + 1);
    const dot = domain.indexOf('.');
    return dot > 0 && !domain.endsWith('.') && domain.split('.').every(Boolean);
}

/**
 * Parse ?page=&limit= into safe integers. Bad or missing values fall back to
 * the defaults and limit is clamped, so user input can never produce a huge
 * LIMIT, a negative OFFSET or NaN.
 */
export function parsePagination(query = {}, { defaultLimit = 20, maxLimit = 100, maxPage = 100000 } = {}) {
    const toInt = (value) => {
        if (typeof value !== 'string' && typeof value !== 'number') return NaN;
        const n = Number(value);
        return Number.isInteger(n) ? n : NaN;
    };
    const page = toInt(query.page);
    const limit = toInt(query.limit);
    return {
        page: Number.isNaN(page) ? 1 : Math.min(Math.max(page, 1), maxPage),
        limit: Number.isNaN(limit) ? defaultLimit : Math.min(Math.max(limit, 1), maxLimit)
    };
}

/**
 * Turn a money value into a fixed 2-decimal string for SQL arithmetic.
 * Returns null when the value is not a finite positive amount with at most
 * two decimal places.
 */
export function toMoney(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    const cents = Math.round(value * 100);
    if (Math.abs(value * 100 - cents) > 1e-6) return null;
    if (cents <= 0 || cents > 99999999) return null;
    return (cents / 100).toFixed(2);
}

/** Escape %, _ and \ so user text can be used inside a LIKE pattern. */
export function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
