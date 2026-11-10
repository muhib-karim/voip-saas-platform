import Telnyx from 'telnyx';
import db from '../config/database.js';
import config from '../config/index.js';
import walletService from './wallet.service.js';
import cdrService, { CALL_RATE_PER_MINUTE } from './cdr.service.js';
import { httpError, HttpError, isUniqueViolation } from '../utils/errors.js';
import { logger } from '../middleware/errorHandler.js';

// Telnyx limits for time_limit_secs on a call leg.
const MIN_CALL_SECONDS = 60;
const MAX_CALL_SECONDS = 14400;

const WEBHOOK_TOLERANCE_SECONDS = 300;

const LIVE_NUMBER_INDEX = 'did_numbers_phone_number_live_unique';

class TelnyxService {
    constructor() {
        // Exposed so tests can stub individual API calls.
        this.client = Telnyx(config.telnyxApiKey);
    }

    /**
     * Verify a Telnyx webhook (Ed25519 over "<timestamp>|<raw body>") and
     * return the parsed event. Throws when the signature is missing or wrong,
     * when the timestamp is more than five minutes from now (replay), or when
     * no public key is configured: an unverifiable webhook is never trusted.
     */
    verifyWebhook(rawBody, signatureHeader, timestampHeader) {
        if (!config.telnyxPublicKey) {
            throw httpError(503, 'Telnyx webhook verification is not configured');
        }
        if (typeof rawBody !== 'string' || rawBody === '' || typeof signatureHeader !== 'string' || !signatureHeader) {
            throw httpError(400, 'Invalid webhook signature');
        }
        if (typeof timestampHeader !== 'string' || !/^\d{1,12}$/.test(timestampHeader)) {
            throw httpError(400, 'Invalid webhook signature');
        }
        const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestampHeader));
        if (age > WEBHOOK_TOLERANCE_SECONDS) {
            throw httpError(400, 'Webhook timestamp is outside the allowed window');
        }

        try {
            return this.client.webhooks.constructEvent(
                rawBody,
                signatureHeader,
                timestampHeader,
                config.telnyxPublicKey,
                WEBHOOK_TOLERANCE_SECONDS
            );
        } catch {
            throw httpError(400, 'Invalid webhook signature');
        }
    }

    /**
     * Search available DID numbers
     */
    async searchNumbers({ countryCode = 'US', areaCode, contains, type = 'local', limit = 20 }) {
        try {
            const searchParams = {
                filter: {
                    country_code: countryCode,
                    phone_number_type: type,
                    limit
                }
            };

            if (areaCode) {
                searchParams.filter.national_destination_code = areaCode;
            }

            if (contains) {
                searchParams.filter.phone_number = { contains };
            }

            const response = await this.client.availablePhoneNumbers.list(searchParams);

            return response.data.map(num => ({
                phoneNumber: num.phone_number,
                region: num.region_information?.[0]?.region_name,
                type: num.phone_number_type,
                monthlyRate: parseFloat(num.cost_information?.monthly_cost || '1.00'),
                setupRate: parseFloat(num.cost_information?.upfront_cost || '0.00'),
                features: num.features || []
            }));
        } catch (error) {
            logger.error('Telnyx search error', { message: error.message });
            throw httpError(502, 'Failed to search phone numbers');
        }
    }

    /**
     * Purchase a DID number.
     *
     * Reserve first, then buy:
     *   1. one transaction inserts the number as "pending" and debits setup +
     *      first month. A number someone else holds, or a wallet that cannot
     *      cover it, rolls the whole thing back before Telnyx is contacted.
     *   2. order from Telnyx.
     *   3. mark the number active, or on failure release it and refund.
     */
    async purchaseNumber(userId, phoneNumber) {
        const monthlyCost = 1.00; // Telnyx typical cost
        const setupCost = 0.00;
        const total = setupCost + monthlyCost;

        let reserved;
        try {
            reserved = await db.transaction(async (trx) => {
                const [did] = await trx('did_numbers')
                    .insert({
                        user_id: userId,
                        phone_number: phoneNumber,
                        telnyx_number_id: 'pending',
                        country_code: phoneNumber.startsWith('+1') ? 'US' : 'XX',
                        type: 'local',
                        monthly_cost: monthlyCost,
                        setup_cost: setupCost,
                        status: 'pending'
                    })
                    .returning('*');

                await walletService.deductFunds(userId, total, {
                    description: `DID purchase: ${phoneNumber}`,
                    referenceType: 'did_purchase',
                    referenceId: did.id
                }, trx);

                return did;
            });
        } catch (error) {
            if (isUniqueViolation(error, LIVE_NUMBER_INDEX)) {
                throw httpError(409, 'This number is already in use');
            }
            if (error instanceof HttpError && error.code === 'INSUFFICIENT_FUNDS') {
                throw httpError(400, 'Insufficient wallet balance', { code: 'INSUFFICIENT_FUNDS' });
            }
            throw error;
        }

        let order;
        try {
            const orderResponse = await this.client.numberOrders.create({
                phone_numbers: [{ phone_number: phoneNumber }],
                connection_id: config.telnyxSipConnectionId
            });
            order = orderResponse.data;
        } catch (error) {
            logger.error('Telnyx purchase error', { message: error.message });
            await this.#cancelReservation(userId, reserved, total);
            throw httpError(502, 'Failed to purchase phone number');
        }

        const purchasedNumber = order?.phone_numbers?.[0] || {};
        const [didNumber] = await db('did_numbers')
            .where({ id: reserved.id })
            .update({
                status: 'active',
                telnyx_number_id: purchasedNumber.id || order?.id || 'unknown',
                purchased_at: db.fn.now()
            })
            .returning('*');

        return {
            id: didNumber.id,
            phoneNumber: didNumber.phone_number,
            monthlyCost: parseFloat(didNumber.monthly_cost),
            status: didNumber.status,
            purchasedAt: didNumber.purchased_at
        };
    }

    /** Undo a reservation whose Telnyx order failed: free the number and refund. */
    async #cancelReservation(userId, reserved, amount) {
        await db.transaction(async (trx) => {
            await trx('did_numbers')
                .where({ id: reserved.id })
                .update({ status: 'released', user_id: null });

            await walletService.addFunds(userId, amount, {
                type: 'refund',
                description: `Refund: DID purchase failed (${reserved.phone_number})`,
                referenceType: 'did_purchase',
                referenceId: reserved.id
            }, trx);
        });
    }

    /**
     * Get user's DID numbers
     */
    async getUserNumbers(userId) {
        const numbers = await db('did_numbers')
            .where({ user_id: userId, status: 'active' })
            .orderBy('purchased_at', 'desc');

        return numbers.map(num => ({
            id: num.id,
            phoneNumber: num.phone_number,
            countryCode: num.country_code,
            region: num.region,
            type: num.type,
            monthlyCost: parseFloat(num.monthly_cost),
            status: num.status,
            purchasedAt: num.purchased_at
        }));
    }

    /**
     * Release a DID number
     */
    async releaseNumber(userId, numberId) {
        const number = await db('did_numbers')
            .where({ id: numberId, user_id: userId, status: 'active' })
            .first();

        if (!number) {
            throw httpError(404, 'Number not found');
        }

        try {
            // Release from Telnyx
            await this.client.phoneNumbers.del(number.telnyx_number_id);
        } catch (error) {
            logger.error('Telnyx release error', { message: error.message, numberId });
            // Continue with database update even if Telnyx fails
        }

        // Update database
        await db('did_numbers')
            .where({ id: numberId, user_id: userId })
            .update({
                status: 'released',
                user_id: null
            });

        return { message: 'Number released successfully' };
    }

    /**
     * Generate WebRTC token for user
     */
    async generateWebRTCToken(userId) {
        try {
            // Check if user has credentials
            let credentials = await db('webrtc_credentials')
                .where({ user_id: userId, active: true })
                .first();

            if (!credentials) {
                // Create new Telnyx credential
                const credResponse = await this.client.telephonyCredentials.create({
                    connection_id: config.telnyxSipConnectionId,
                    name: `user-${userId}`,
                    tag: userId
                });

                const [newCred] = await db('webrtc_credentials')
                    .insert({
                        user_id: userId,
                        telnyx_credential_id: credResponse.data.id,
                        sip_username: credResponse.data.sip_username
                    })
                    .returning('*');

                credentials = newCred;
            }

            // Generate JWT token
            const tokenResponse = await this.client.telephonyCredentials.createToken(
                credentials.telnyx_credential_id
            );

            return {
                token: tokenResponse.data,
                sipUsername: credentials.sip_username
            };
        } catch (error) {
            logger.error('WebRTC token error', { message: error.message });
            throw httpError(502, 'Failed to generate WebRTC credentials');
        }
    }

    /**
     * Initiate outbound call.
     *
     * A call's cost is only known when it ends, so exposure is limited up
     * front: the wallet must cover a minute, Telnyx is told to end the call
     * when the balance would run out, and a user may only have a few calls
     * open at once.
     */
    async initiateCall(userId, { from, to }) {
        // Verify user owns the 'from' number
        const userNumber = await db('did_numbers')
            .where({ user_id: userId, phone_number: from, status: 'active' })
            .first();

        if (!userNumber) {
            throw httpError(403, 'You do not own this phone number');
        }

        const balance = await walletService.getBalance(userId);
        if (balance < CALL_RATE_PER_MINUTE) {
            throw httpError(400, 'Insufficient wallet balance to place a call', { code: 'INSUFFICIENT_FUNDS' });
        }

        const openCalls = await cdrService.countOpenOutboundCalls(userId);
        if (openCalls >= config.maxConcurrentCalls) {
            throw httpError(429, 'Too many calls in progress');
        }

        const affordableSeconds = Math.floor(balance / CALL_RATE_PER_MINUTE + 1e-9) * 60;
        const timeLimitSecs = Math.min(Math.max(affordableSeconds, MIN_CALL_SECONDS), MAX_CALL_SECONDS);

        let response;
        try {
            response = await this.client.calls.create({
                connection_id: config.telnyxSipConnectionId,
                from: from,
                to: to,
                webhook_url: `${config.backendUrl}/api/webhooks/telnyx/call`,
                time_limit_secs: timeLimitSecs
            });
        } catch (error) {
            logger.error('Call initiation error', { message: error.message });
            throw httpError(502, 'Failed to initiate call');
        }

        return {
            callId: response.data.call_control_id,
            callLegId: response.data.call_leg_id,
            didNumberId: userNumber.id,
            from,
            to,
            status: 'initiated'
        };
    }
}

export default new TelnyxService();
