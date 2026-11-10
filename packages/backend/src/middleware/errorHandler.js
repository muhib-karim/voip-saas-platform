import winston from 'winston';
import config from '../config/index.js';
import { HttpError } from '../utils/errors.js';

const logger = winston.createLogger({
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    silent: config.nodeEnv === 'test',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

const STATUS_LABELS = {
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    502: 'Bad Gateway',
    503: 'Service Unavailable'
};

const BODY_PARSER_MESSAGES = {
    'entity.parse.failed': 'Malformed JSON in request body',
    'entity.too.large': 'Request body is too large',
    'encoding.unsupported': 'Unsupported content encoding',
    'charset.unsupported': 'Unsupported charset'
};

/**
 * Decide what the client may see.
 *
 * - HttpError: raised on purpose by our code, message is safe to return.
 * - body-parser style errors (expose + 4xx): fixed wording, never the
 *   parser's own message, which can quote the request body.
 * - Stripe SDK errors: generic payment error.
 * - everything else: a generic 500. The real message and stack are logged and
 *   never sent, in any environment.
 */
export function toClientError(err) {
    if (err instanceof HttpError) {
        const body = {
            error: STATUS_LABELS[err.status] || 'Error',
            message: err.message
        };
        if (err.code) body.code = err.code;
        if (err.details) body.details = err.details;
        return { status: err.status, body };
    }

    const status = err?.status || err?.statusCode;
    if (err?.expose === true && Number.isInteger(status) && status >= 400 && status < 500) {
        return {
            status,
            body: {
                error: STATUS_LABELS[status] || 'Bad Request',
                message: BODY_PARSER_MESSAGES[err.type] || STATUS_LABELS[status] || 'Bad Request'
            }
        };
    }

    if (typeof err?.type === 'string' && err.type.startsWith('Stripe')) {
        return {
            status: 502,
            body: {
                error: 'Payment Error',
                message: 'The payment provider could not process this request'
            }
        };
    }

    return {
        status: 500,
        body: {
            error: 'Internal Server Error',
            message: 'An unexpected error occurred'
        }
    };
}

export const errorHandler = (err, req, res, next) => {
    const { status, body } = toClientError(err);

    logger.log(status >= 500 ? 'error' : 'warn', 'Request failed', {
        status,
        message: err?.message,
        stack: status >= 500 ? err?.stack : undefined,
        path: req.path,
        method: req.method
    });

    if (res.headersSent) {
        return next(err);
    }

    res.status(status).json(body);
};

export { logger };
