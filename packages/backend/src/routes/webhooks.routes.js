import { Router } from 'express';
import billingService from '../services/billing.service.js';
import cdrService from '../services/cdr.service.js';
import telnyxService from '../services/telnyx.service.js';
import db from '../config/database.js';
import { HttpError } from '../utils/errors.js';
import { logger } from '../middleware/errorHandler.js';

const router = Router();

/**
 * POST /api/webhooks/stripe
 * Handle Stripe webhooks. The body is the raw Buffer (see app.js): the
 * signature is computed over the exact bytes Stripe sent.
 */
router.post('/stripe', async (req, res) => {
    let event;
    try {
        event = billingService.constructWebhookEvent(req.body, req.headers['stripe-signature']);
    } catch (error) {
        logger.warn('Stripe webhook rejected', { reason: error.message });
        return res.status(400).json({ error: 'Invalid signature' });
    }

    try {
        logger.info('Stripe webhook received', { type: event.type, id: event.id });

        switch (event.type) {
            case 'checkout.session.completed': {
                const outcome = await billingService.handlePaymentSuccess(event.data.object);
                logger.info('Stripe checkout processed', { id: event.id, ...outcome });
                break;
            }

            case 'payment_intent.succeeded':
                logger.info('Payment succeeded', { id: event.data.object.id });
                break;

            case 'payment_intent.payment_failed':
                logger.error('Payment failed', { id: event.data.object.id });
                break;

            default:
                logger.info('Unhandled Stripe event', { type: event.type });
        }

        res.json({ received: true });
    } catch (error) {
        // Non-2xx makes Stripe retry; the credit is idempotent, so that is safe.
        logger.error('Stripe webhook processing failed', { id: event.id, message: error.message, stack: error.stack });
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

const parseOccurredAt = (value) => {
    const date = typeof value === 'string' ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : new Date();
};

/**
 * Work out whose call this is from the numbers in the event. Inbound calls
 * belong to the owner of the called number, outbound calls to the owner of
 * the caller ID (initiateCall only lets a user dial from a number they own).
 */
async function identifyCall(payload) {
    if (payload.direction !== 'incoming' && payload.direction !== 'outgoing') {
        return null;
    }
    const direction = payload.direction === 'incoming' ? 'inbound' : 'outbound';
    const fromNumber = typeof payload.from === 'string' ? payload.from.slice(0, 50) : null;
    const toNumber = typeof payload.to === 'string' ? payload.to.slice(0, 50) : null;
    const ownNumber = direction === 'inbound' ? toNumber : fromNumber;

    const did = ownNumber
        ? await db('did_numbers').where({ phone_number: ownNumber, status: 'active' }).first('id', 'user_id')
        : null;

    return {
        direction,
        fromNumber,
        toNumber,
        userId: did?.user_id || null,
        didNumberId: did?.id || null
    };
}

/**
 * POST /api/webhooks/telnyx and /api/webhooks/telnyx/call
 * Handle Telnyx call webhooks. Every request must carry a valid Ed25519
 * signature; the handler itself tolerates duplicated and out-of-order events.
 */
async function handleTelnyxWebhook(req, res) {
    let envelope;
    try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
        envelope = telnyxService.verifyWebhook(
            rawBody,
            req.get('telnyx-signature-ed25519'),
            req.get('telnyx-timestamp')
        );
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 400;
        logger.warn('Telnyx webhook rejected', { reason: error.message });
        return res.status(status).json({ error: status === 503 ? 'Webhook verification unavailable' : 'Invalid signature' });
    }

    try {
        const event = envelope?.data;
        const eventType = event?.event_type;
        const payload = event?.payload;
        const callId = payload?.call_control_id;

        logger.info('Telnyx webhook received', { type: eventType, id: event?.id });

        if (!payload || typeof callId !== 'string' || callId === '' || callId.length > 255) {
            return res.json({ received: true });
        }

        switch (eventType) {
            case 'call.initiated':
            case 'call.ringing':
            case 'call.answered':
            case 'call.hangup':
            case 'call.recording.saved': {
                const cdr = await cdrService.applyEvent({
                    callId,
                    eventType,
                    occurredAt: parseOccurredAt(event.occurred_at),
                    identity: await identifyCall(payload),
                    hangupCause: payload.hangup_cause,
                    recordingUrl: typeof payload.recording_urls?.mp3 === 'string' ? payload.recording_urls.mp3 : undefined
                });
                if (!cdr) {
                    logger.warn('Telnyx event for an unknown call', { type: eventType, id: event?.id });
                }
                break;
            }

            default:
                logger.info('Unhandled Telnyx event', { type: eventType });
        }

        res.json({ received: true });
    } catch (error) {
        logger.error('Telnyx webhook processing failed', { message: error.message, stack: error.stack });
        res.status(500).json({ error: 'Webhook processing failed' });
    }
}

router.post(['/telnyx', '/telnyx/call'], handleTelnyxWebhook);

export default router;
