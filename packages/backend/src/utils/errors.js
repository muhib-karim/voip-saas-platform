/**
 * Error with an HTTP status whose message is safe to show to the client.
 * Anything that is not an HttpError is treated as an internal failure and is
 * never echoed back (see middleware/errorHandler.js).
 */
export class HttpError extends Error {
    constructor(status, message, { code, details } = {}) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.expose = true;
        if (code) this.code = code;
        if (details) this.details = details;
    }
}

export function httpError(status, message, options) {
    return new HttpError(status, message, options);
}

/** Postgres unique-violation check, optionally for one named constraint. */
export function isUniqueViolation(err, constraint) {
    return Boolean(err) && err.code === '23505' && (!constraint || err.constraint === constraint);
}
