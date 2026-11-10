import Stripe from 'stripe';
import db from '../config/database.js';
import config from '../config/index.js';
import walletService from './wallet.service.js';
import { httpError } from '../utils/errors.js';
import { isUuid, toMoney } from '../utils/validators.js';
import { logger } from '../middleware/errorHandler.js';

const stripe = new Stripe(config.stripeSecretKey);

export const MIN_TOPUP = 5;
export const MAX_TOPUP = 1000;

class BillingService {
    /**
     * Get or create Stripe customer for user
     */
    async getOrCreateStripeCustomer(userId) {
        // Check if customer exists
        let stripeCustomer = await db('stripe_customers')
            .where({ user_id: userId })
            .first();

        if (stripeCustomer) {
            return stripeCustomer.stripe_customer_id;
        }

        // Get user details
        const user = await db('users').where({ id: userId }).first();
        if (!user) {
            throw httpError(404, 'User not found');
        }

        // Create Stripe customer
        const customer = await stripe.customers.create({
            email: user.email,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || undefined,
            metadata: {
                userId: user.id
            }
        });

        // Save customer ID
        await db('stripe_customers').insert({
            user_id: userId,
            stripe_customer_id: customer.id
        });

        return customer.id;
    }

    /**
     * Create checkout session for wallet top-up
     */
    async createTopupCheckout(userId, { amount }) {
        const fixed = toMoney(amount);
        if (!fixed || amount < MIN_TOPUP || amount > MAX_TOPUP) {
            throw httpError(400, `Top-up amount must be between $${MIN_TOPUP} and $${MAX_TOPUP}`);
        }

        const customerId = await this.getOrCreateStripeCustomer(userId);

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Wallet Top-up',
                            description: `Add $${fixed} to your VoIP wallet`
                        },
                        unit_amount: Math.round(amount * 100) // Stripe uses cents
                    },
                    quantity: 1
                }
            ],
            metadata: {
                userId,
                type: 'topup',
                amount: fixed
            },
            success_url: `${config.frontendUrl}/wallet?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${config.frontendUrl}/wallet?canceled=true`
        });

        return {
            sessionId: session.id,
            url: session.url
        };
    }

    /**
     * Credit the wallet for a completed Checkout session.
     *
     * Safe to call any number of times for the same payment: the credit is
     * keyed on the payment, so Stripe's retries and duplicate deliveries are
     * no-ops. The amount comes from what Stripe actually collected
     * (amount_total), never from metadata, and only once the session is paid.
     *
     * @returns {{ credited: boolean, reason?: string }}
     */
    async handlePaymentSuccess(session) {
        const metadata = session?.metadata || {};

        if (metadata.type !== 'topup') {
            return { credited: false, reason: 'not_a_topup' };
        }
        if (session.mode !== 'payment' || session.payment_status !== 'paid') {
            return { credited: false, reason: 'not_paid' };
        }
        if (String(session.currency || '').toLowerCase() !== 'usd') {
            return { credited: false, reason: 'unsupported_currency' };
        }
        if (!isUuid(metadata.userId)) {
            return { credited: false, reason: 'invalid_user' };
        }
        if (!Number.isInteger(session.amount_total) || session.amount_total <= 0) {
            return { credited: false, reason: 'invalid_amount' };
        }

        const amount = session.amount_total / 100;
        const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null;

        const result = await walletService.addFunds(metadata.userId, amount, {
            stripePaymentId: paymentIntent,
            description: `Stripe payment - $${amount.toFixed(2)}`,
            referenceType: 'topup',
            idempotencyKey: `stripe:${paymentIntent || session.id}`
        });

        if (result.duplicate) {
            logger.info('Stripe payment already credited', { session: session.id });
            return { credited: false, reason: 'duplicate' };
        }
        return { credited: true };
    }

    /**
     * Get payment history from Stripe
     */
    async getPaymentHistory(userId, { limit = 10 }) {
        const customerId = await this.getOrCreateStripeCustomer(userId);

        const paymentIntents = await stripe.paymentIntents.list({
            customer: customerId,
            limit
        });

        return paymentIntents.data.map(pi => ({
            id: pi.id,
            amount: pi.amount / 100,
            currency: pi.currency.toUpperCase(),
            status: pi.status,
            createdAt: new Date(pi.created * 1000)
        }));
    }

    /**
     * Verify Stripe webhook signature (needs the raw request body)
     */
    constructWebhookEvent(payload, signature) {
        return stripe.webhooks.constructEvent(
            payload,
            signature,
            config.stripeWebhookSecret
        );
    }

    /**
     * Create payment method setup intent
     */
    async createSetupIntent(userId) {
        const customerId = await this.getOrCreateStripeCustomer(userId);

        const setupIntent = await stripe.setupIntents.create({
            customer: customerId,
            payment_method_types: ['card']
        });

        return {
            clientSecret: setupIntent.client_secret
        };
    }

    /**
     * List saved payment methods
     */
    async listPaymentMethods(userId) {
        const customerId = await this.getOrCreateStripeCustomer(userId);

        const paymentMethods = await stripe.paymentMethods.list({
            customer: customerId,
            type: 'card'
        });

        return paymentMethods.data.map(pm => ({
            id: pm.id,
            brand: pm.card.brand,
            last4: pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear: pm.card.exp_year
        }));
    }
}

export default new BillingService();
