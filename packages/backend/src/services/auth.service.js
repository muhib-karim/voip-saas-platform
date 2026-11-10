import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../config/database.js';
import config from '../config/index.js';
import { httpError, isUniqueViolation } from '../utils/errors.js';

// A refresh token that was rotated this recently and is presented again is
// treated as a benign race (two tabs refreshing at once), not as theft.
const ROTATION_GRACE_SECONDS = 10;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Lazily computed hash used to spend the same bcrypt time on unknown emails
// as on known ones, so response time does not reveal which emails exist.
let dummyHashPromise = null;
const getDummyHash = () => {
    dummyHashPromise ??= bcrypt.hash(crypto.randomBytes(16).toString('hex'), config.bcryptRounds);
    return dummyHashPromise;
};

class AuthService {
    /**
     * Register a new user
     */
    async register({ email, password, firstName, lastName }) {
        const normalizedEmail = email.toLowerCase();

        // Check if user exists
        const existingUser = await db('users').where({ email: normalizedEmail }).first();
        if (existingUser) {
            throw httpError(400, 'Email already registered');
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

        // Create user with transaction
        let user;
        try {
            user = await db.transaction(async (trx) => {
                // Insert user
                const [newUser] = await trx('users')
                    .insert({
                        email: normalizedEmail,
                        password_hash: passwordHash,
                        first_name: firstName,
                        last_name: lastName
                    })
                    .returning(['id', 'email', 'first_name', 'last_name', 'created_at']);

                // Create wallet for user
                await trx('wallets').insert({
                    user_id: newUser.id,
                    balance: 0,
                    currency: 'USD'
                });

                return newUser;
            });
        } catch (error) {
            // Two registrations for the same email at once: the unique index decides.
            if (isUniqueViolation(error)) {
                throw httpError(400, 'Email already registered');
            }
            throw error;
        }

        // Generate tokens
        const accessToken = this.generateAccessToken(user);
        const { refreshToken, refreshTokenHash } = await this.generateRefreshToken();

        // Store refresh token
        await this.storeRefreshToken(user.id, refreshTokenHash);

        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name
            },
            accessToken,
            refreshToken
        };
    }

    /**
     * Login user
     */
    async login({ email, password, deviceInfo, ipAddress }) {
        // Find user
        const user = await db('users').where({ email: email.toLowerCase() }).first();

        // Always run one bcrypt comparison, whether or not the email exists.
        const isValidPassword = await bcrypt.compare(password, user ? user.password_hash : await getDummyHash());
        if (!user || !isValidPassword) {
            throw httpError(401, 'Invalid email or password');
        }

        // Generate tokens
        const accessToken = this.generateAccessToken(user);
        const { refreshToken, refreshTokenHash } = await this.generateRefreshToken();

        // Store refresh token with device info
        await this.storeRefreshToken(user.id, refreshTokenHash, deviceInfo, ipAddress);

        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                avatarUrl: user.avatar_url
            },
            accessToken,
            refreshToken
        };
    }

    /**
     * Exchange a refresh token for a new access token and a new refresh token.
     *
     * Rotation is a single atomic claim: `UPDATE ... WHERE revoked = false`
     * succeeds for exactly one caller, so one token can never be redeemed
     * twice. The replacement stays in the same family.
     *
     * A token that has already been rotated or revoked and shows up again
     * means it leaked: the whole family is revoked. The one exception is a
     * token rotated a few seconds ago (two tabs refreshing together), which
     * gets a 409 and no other consequence.
     */
    async refreshTokens(refreshToken, deviceInfo, ipAddress) {
        const refreshTokenHash = hashToken(refreshToken);

        const rotated = await db.transaction(async (trx) => {
            const [claimed] = await trx('refresh_tokens')
                .where({ token_hash: refreshTokenHash, revoked: false })
                .where('expires_at', '>', trx.fn.now())
                .update({ revoked: true, revoked_at: trx.fn.now(), revoked_reason: 'rotated' })
                .returning(['id', 'user_id', 'family_id']);

            if (!claimed) return null;

            const user = await trx('users').where({ id: claimed.user_id }).first();
            if (!user) return null;

            const next = await this.generateRefreshToken();
            await this.storeRefreshToken(user.id, next.refreshTokenHash, deviceInfo, ipAddress, {
                familyId: claimed.family_id,
                trx
            });

            return { user, refreshToken: next.refreshToken };
        });

        if (rotated) {
            return {
                accessToken: this.generateAccessToken(rotated.user),
                refreshToken: rotated.refreshToken
            };
        }

        // Nothing was claimed. Work out why, using the database clock.
        const existing = await db('refresh_tokens')
            .where({ token_hash: refreshTokenHash })
            .select(
                'family_id',
                'revoked',
                db.raw(`(revoked_reason = 'rotated' AND revoked_at > now() - interval '${ROTATION_GRACE_SECONDS} seconds') AS just_rotated`)
            )
            .first();

        if (existing?.revoked) {
            if (existing.just_rotated) {
                throw httpError(409, 'Refresh already in progress', { code: 'REFRESH_CONFLICT' });
            }

            await db('refresh_tokens')
                .where({ family_id: existing.family_id, revoked: false })
                .update({ revoked: true, revoked_at: db.fn.now(), revoked_reason: 'reuse' });

            throw httpError(401, 'Invalid or expired refresh token', { code: 'TOKEN_REUSED' });
        }

        throw httpError(401, 'Invalid or expired refresh token');
    }

    /**
     * Logout - revoke refresh token
     */
    async logout(refreshToken) {
        if (!refreshToken) return { message: 'Logged out' };

        await db('refresh_tokens')
            .where({ token_hash: hashToken(refreshToken), revoked: false })
            .update({ revoked: true, revoked_at: db.fn.now(), revoked_reason: 'logout' });

        return { message: 'Logged out successfully' };
    }

    /**
     * Logout from all devices
     */
    async logoutAll(userId) {
        await db('refresh_tokens')
            .where({ user_id: userId, revoked: false })
            .update({ revoked: true, revoked_at: db.fn.now(), revoked_reason: 'logout' });

        return { message: 'Logged out from all devices' };
    }

    /**
     * Get user profile
     */
    async getProfile(userId) {
        const user = await db('users')
            .select('id', 'email', 'first_name', 'last_name', 'phone_number',
                'email_verified', 'phone_verified', 'avatar_url', 'timezone', 'created_at')
            .where({ id: userId })
            .first();

        if (!user) {
            throw httpError(404, 'User not found');
        }

        // Get wallet balance
        const wallet = await db('wallets')
            .select('balance', 'currency')
            .where({ user_id: userId })
            .first();

        // Get DID numbers count
        const didCount = await db('did_numbers')
            .where({ user_id: userId, status: 'active' })
            .count('id as count')
            .first();

        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phoneNumber: user.phone_number,
            emailVerified: user.email_verified,
            phoneVerified: user.phone_verified,
            avatarUrl: user.avatar_url,
            timezone: user.timezone,
            createdAt: user.created_at,
            wallet: wallet ? {
                balance: parseFloat(wallet.balance),
                currency: wallet.currency
            } : null,
            stats: {
                didNumbers: parseInt(didCount?.count || 0)
            }
        };
    }

    /**
     * Update user profile
     */
    async updateProfile(userId, { firstName, lastName, phoneNumber, timezone, avatarUrl }) {
        const updateData = {
            updated_at: db.fn.now()
        };

        if (firstName !== undefined) updateData.first_name = firstName;
        if (lastName !== undefined) updateData.last_name = lastName;
        if (phoneNumber !== undefined) updateData.phone_number = phoneNumber;
        if (timezone !== undefined) updateData.timezone = timezone;
        if (avatarUrl !== undefined) updateData.avatar_url = avatarUrl;

        const [user] = await db('users')
            .where({ id: userId })
            .update(updateData)
            .returning(['id', 'email', 'first_name', 'last_name', 'phone_number', 'avatar_url', 'timezone']);

        if (!user) {
            throw httpError(404, 'User not found');
        }

        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phoneNumber: user.phone_number,
            avatarUrl: user.avatar_url,
            timezone: user.timezone
        };
    }

    /**
     * Change password
     */
    async changePassword(userId, { currentPassword, newPassword }) {
        const user = await db('users').where({ id: userId }).first();
        if (!user) {
            throw httpError(404, 'User not found');
        }

        const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isValidPassword) {
            throw httpError(400, 'Current password is incorrect');
        }

        const newPasswordHash = await bcrypt.hash(newPassword, config.bcryptRounds);

        await db('users')
            .where({ id: userId })
            .update({
                password_hash: newPasswordHash,
                updated_at: db.fn.now()
            });

        // Revoke all refresh tokens for security
        await this.logoutAll(userId);

        return { message: 'Password updated successfully' };
    }

    /**
     * Get active sessions
     */
    async getActiveSessions(userId) {
        const sessions = await db('refresh_tokens')
            .where({ user_id: userId, revoked: false })
            .where('expires_at', '>', new Date())
            .select('id', 'device_info', 'ip_address', 'created_at')
            .orderBy('created_at', 'desc');

        return sessions.map(s => ({
            id: s.id,
            deviceInfo: s.device_info,
            ipAddress: s.ip_address,
            createdAt: s.created_at
        }));
    }

    /**
     * Revoke a specific session
     */
    async revokeSession(userId, sessionId) {
        await db('refresh_tokens')
            .where({ id: sessionId, user_id: userId, revoked: false })
            .update({ revoked: true, revoked_at: db.fn.now(), revoked_reason: 'logout' });

        return { message: 'Session revoked' };
    }

    /**
     * Generate short-lived access token (JWT_EXPIRES_IN, 15 minutes by default)
     */
    generateAccessToken(user) {
        return jwt.sign(
            {
                userId: user.id,
                email: user.email,
                type: 'access'
            },
            config.jwtSecret,
            {
                algorithm: 'HS256',
                expiresIn: config.jwtExpiresIn,
                issuer: config.jwtIssuer,
                audience: config.jwtAudience
            }
        );
    }

    /**
     * Generate long-lived refresh token (REFRESH_TOKEN_EXPIRES_IN, 7 days by default)
     */
    async generateRefreshToken() {
        const refreshToken = crypto.randomBytes(64).toString('hex');
        return { refreshToken, refreshTokenHash: hashToken(refreshToken) };
    }

    /**
     * Store refresh token in database.
     * Without a familyId the database starts a new family (a new login).
     */
    async storeRefreshToken(userId, tokenHash, deviceInfo = null, ipAddress = null, { familyId, trx } = {}) {
        const row = {
            user_id: userId,
            token_hash: tokenHash,
            // Both columns are bounded; a long User-Agent must not fail the login.
            device_info: typeof deviceInfo === 'string' ? deviceInfo.slice(0, 255) : null,
            ip_address: typeof ipAddress === 'string' ? ipAddress.slice(0, 45) : null,
            expires_at: new Date(Date.now() + config.refreshTokenTtlMs)
        };
        if (familyId) row.family_id = familyId;

        await (trx || db)('refresh_tokens').insert(row);
    }

    /**
     * Delete refresh tokens that have expired (run periodically).
     * Revoked-but-unexpired rows are kept: they are how a replayed token is
     * recognised.
     */
    async cleanupExpiredTokens() {
        const deleted = await db('refresh_tokens')
            .where('expires_at', '<', new Date())
            .del();

        return { deleted };
    }

    /**
     * Legacy: Generate token (for backward compatibility)
     * @deprecated Use generateAccessToken instead
     */
    generateToken(user) {
        return this.generateAccessToken(user);
    }
}

export default new AuthService();
