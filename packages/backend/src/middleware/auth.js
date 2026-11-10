import jwt from 'jsonwebtoken';
import config from '../config/index.js';

const VERIFY_OPTIONS = {
    // Pinned: a token signed with any other algorithm is rejected even if the
    // signature would verify against the same secret.
    algorithms: ['HS256'],
    issuer: config.jwtIssuer,
    audience: config.jwtAudience
};

/**
 * Verify an access token and its claims. Throws a jsonwebtoken error.
 */
export function verifyAccessToken(token) {
    const decoded = jwt.verify(token, config.jwtSecret, VERIFY_OPTIONS);

    if (
        typeof decoded !== 'object' ||
        decoded.type !== 'access' ||
        typeof decoded.userId !== 'string' ||
        decoded.userId === '' ||
        typeof decoded.exp !== 'number'
    ) {
        throw new jwt.JsonWebTokenError('invalid token claims');
    }

    return decoded;
}

function bearerToken(req) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return null;
    return authHeader.slice('Bearer '.length).trim() || null;
}

export const authenticate = (req, res, next) => {
    const token = bearerToken(req);

    if (!token) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'No token provided'
        });
    }

    try {
        req.user = verifyAccessToken(token);
        next();
    } catch (error) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: error.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token'
        });
    }
};

export const optionalAuth = (req, res, next) => {
    const token = bearerToken(req);

    if (token) {
        try {
            req.user = verifyAccessToken(token);
        } catch {
            // Ignore auth errors for optional auth
        }
    }

    next();
};
