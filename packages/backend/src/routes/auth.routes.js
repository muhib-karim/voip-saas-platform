import { Router } from 'express';
import authService from '../services/auth.service.js';
import { validate, schemas, trimStrings } from '../middleware/validation.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimiters } from '../middleware/rateLimiter.js';
import config from '../config/index.js';
import { isRefreshToken } from '../utils/validators.js';

const router = Router();

const REFRESH_COOKIE = 'refreshToken';

// Attributes must match between set and clear, or the browser keeps the cookie.
const refreshCookieBase = () => ({
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict'
});

const setRefreshCookie = (res, token) =>
    res.cookie(REFRESH_COOKIE, token, { ...refreshCookieBase(), maxAge: config.refreshTokenTtlMs });

const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, refreshCookieBase());

// Cookie first (browsers), body second (clients without a cookie jar).
// Anything that is not a well-formed token is treated as absent.
const readRefreshToken = (req) => {
    const candidate = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
    return isRefreshToken(candidate) ? candidate : null;
};

// Defense-in-depth CSRF check for routes that read the refreshToken cookie.
const verifyCookieOrigin = (req, res, next) => {
    if (!req.cookies?.[REFRESH_COOKIE]) return next();
    const fetchSite = req.get('Sec-Fetch-Site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        return res.status(403).json({ error: 'Cross-site cookie request blocked' });
    }
    const origin = req.get('Origin');
    if (origin) {
        const allowed = new Set([config.frontendUrl, config.backendUrl].map((u) => new URL(u).origin));
        if (!allowed.has(origin)) {
            return res.status(403).json({ error: 'Cross-site cookie request blocked' });
        }
    }
    next();
};

// Apply string trimming to all routes
router.use(trimStrings);

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register',
    rateLimiters.auth,
    validate(schemas.register),
    async (req, res, next) => {
        try {
            const result = await authService.register(req.body);

            // Set refresh token as HTTP-only cookie
            setRefreshCookie(res, result.refreshToken);

            res.status(201).json({
                user: result.user,
                accessToken: result.accessToken
            });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login',
    rateLimiters.auth,
    validate(schemas.login),
    async (req, res, next) => {
        try {
            const deviceInfo = req.get('User-Agent');
            const ipAddress = req.ip;

            const result = await authService.login({
                ...req.body,
                deviceInfo,
                ipAddress
            });

            // Set refresh token as HTTP-only cookie
            setRefreshCookie(res, result.refreshToken);

            res.json({
                user: result.user,
                accessToken: result.accessToken
            });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', rateLimiters.refresh, verifyCookieOrigin, async (req, res, next) => {
    try {
        const refreshToken = readRefreshToken(req);

        if (!refreshToken) {
            return res.status(401).json({ error: 'Refresh token required' });
        }

        const deviceInfo = req.get('User-Agent');
        const ipAddress = req.ip;

        const result = await authService.refreshTokens(refreshToken, deviceInfo, ipAddress);

        // Update refresh token cookie
        setRefreshCookie(res, result.refreshToken);

        res.json({
            accessToken: result.accessToken
        });
    } catch (error) {
        // 409 means another request rotated this token a moment ago and has
        // just set the new cookie; clearing it here would log that client out.
        if (error.status !== 409) {
            clearRefreshCookie(res);
        }
        next(error);
    }
});

/**
 * POST /api/auth/logout
 * Logout user (revoke refresh token)
 */
router.post('/logout', verifyCookieOrigin, async (req, res, next) => {
    try {
        await authService.logout(readRefreshToken(req));

        clearRefreshCookie(res);
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/auth/logout-all
 * Logout from all devices
 */
router.post('/logout-all', authenticate, async (req, res, next) => {
    try {
        await authService.logoutAll(req.user.userId);
        clearRefreshCookie(res);
        res.json({ message: 'Logged out from all devices' });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/auth/me
 * Get current user profile
 */
router.get('/me', authenticate, async (req, res, next) => {
    try {
        const profile = await authService.getProfile(req.user.userId);
        res.json(profile);
    } catch (error) {
        next(error);
    }
});

/**
 * PATCH /api/auth/profile
 * Update user profile
 */
router.patch('/profile',
    authenticate,
    validate(schemas.updateProfile),
    async (req, res, next) => {
        try {
            const { firstName, lastName, phoneNumber, timezone, avatarUrl } = req.body;
            const result = await authService.updateProfile(req.user.userId, {
                firstName,
                lastName,
                phoneNumber,
                timezone,
                avatarUrl
            });
            res.json(result);
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /api/auth/change-password
 * Change password
 */
router.post('/change-password',
    authenticate,
    rateLimiters.auth,
    validate(schemas.changePassword),
    async (req, res, next) => {
        try {
            const { currentPassword, newPassword } = req.body;
            const result = await authService.changePassword(req.user.userId, {
                currentPassword,
                newPassword
            });

            // Clear cookies after password change (forces re-login)
            clearRefreshCookie(res);
            res.json(result);
        } catch (error) {
            next(error);
        }
    }
);

/**
 * GET /api/auth/sessions
 * Get active sessions
 */
router.get('/sessions', authenticate, async (req, res, next) => {
    try {
        const sessions = await authService.getActiveSessions(req.user.userId);
        res.json({ sessions });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/auth/sessions/:id
 * Revoke a specific session
 */
router.delete('/sessions/:id', authenticate, validate(schemas.uuidParam), async (req, res, next) => {
    try {
        await authService.revokeSession(req.user.userId, req.params.id);
        res.json({ message: 'Session revoked' });
    } catch (error) {
        next(error);
    }
});

export default router;
