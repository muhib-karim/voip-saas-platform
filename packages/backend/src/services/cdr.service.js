import db from '../config/database.js';
import walletService from './wallet.service.js';
import { HttpError } from '../utils/errors.js';
import { logger } from '../middleware/errorHandler.js';

/** Flat outbound price until per-destination billing exists. */
export const CALL_RATE_PER_MINUTE = 0.01;

/** Values the cdr.hangup_cause CHECK constraint accepts. */
export const HANGUP_CAUSES = ['normal_clearing', 'user_busy', 'no_answer', 'call_rejected', 'network_error', 'other'];

export const CDR_STATUSES = ['initiated', 'ringing', 'answered', 'completed', 'missed', 'busy', 'failed'];
export const CDR_DIRECTIONS = ['inbound', 'outbound'];

// Telnyx sends many more causes than the schema stores. Map the common ones
// and fall back to "other" instead of failing the insert.
const HANGUP_CAUSE_ALIASES = {
    normal_clearing: 'normal_clearing',
    user_busy: 'user_busy',
    busy: 'user_busy',
    no_answer: 'no_answer',
    timeout: 'no_answer',
    originator_cancel: 'no_answer',
    call_rejected: 'call_rejected',
    rejected: 'call_rejected',
    network_error: 'network_error',
    network_out_of_order: 'network_error'
};

// A call only moves forward through these; a late or replayed webhook must
// not drag it back (for example "ringing" arriving after "answered").
const STATUS_RANK = { initiated: 0, ringing: 1, answered: 2, completed: 3, missed: 3, busy: 3, failed: 3 };

export function normalizeHangupCause(cause) {
    if (typeof cause !== 'string' || cause === '') return 'other';
    return HANGUP_CAUSE_ALIASES[cause.toLowerCase()] || 'other';
}

function terminalStatus(row) {
    if (row.answer_time) return 'completed';
    if (row.hangup_cause === 'user_busy') return 'busy';
    if (row.hangup_cause === 'network_error') return 'failed';
    return 'missed';
}

class CDRService {
    /**
     * Record that a call exists (from the API route or a call.initiated
     * webhook), then settle it if it is already finished.
     *
     * Whichever of the two arrives second only fills in what is still missing:
     * a webhook that beat the route's insert has no user, and the route's
     * insert must be able to attach one without touching the call's progress.
     */
    async recordCall(call) {
        return db.transaction(async (trx) => {
            await this.#ensure(trx, call);
            const row = await trx('cdr').where({ call_id: call.callId }).forUpdate().first();
            return this.formatCDR(await this.#settle(trx, row));
        });
    }

    /**
     * Apply one Telnyx call event.
     *
     * Telnyx does not guarantee order or exactly-once delivery, so this never
     * assumes a previous event was seen: each event records the fact it
     * carries (first write wins) and the call is settled as soon as the facts
     * needed for billing are all present, whichever event completes them.
     *
     * @returns the CDR, or null when the call is unknown and the event does
     *          not carry enough to create it.
     */
    async applyEvent({ callId, eventType, occurredAt, identity, hangupCause, recordingUrl }) {
        return db.transaction(async (trx) => {
            if (identity?.direction) {
                await this.#ensure(trx, { callId, startTime: occurredAt, ...identity });
            }

            // Row lock: concurrent webhooks for the same call run one at a time.
            const row = await trx('cdr').where({ call_id: callId }).forUpdate().first();
            if (!row) return null;

            const patch = {};
            const advance = (status) => {
                if (STATUS_RANK[status] > STATUS_RANK[row.status]) patch.status = status;
            };

            switch (eventType) {
                case 'call.ringing':
                    advance('ringing');
                    break;
                case 'call.answered':
                    if (!row.answer_time) patch.answer_time = occurredAt;
                    advance('answered');
                    break;
                case 'call.hangup':
                    if (!row.end_time) patch.end_time = occurredAt;
                    if (!row.hangup_cause) patch.hangup_cause = normalizeHangupCause(hangupCause);
                    break;
                case 'call.recording.saved':
                    if (recordingUrl) patch.recording_url = recordingUrl;
                    break;
                default:
                    break;
            }

            if (Object.keys(patch).length > 0) {
                await trx('cdr').where({ id: row.id }).update(patch);
            }

            return this.formatCDR(await this.#settle(trx, { ...row, ...patch }));
        });
    }

    /**
     * Insert the call, or fill in identity columns that are still empty.
     * Never a bare upsert: status, times and cost belong to applyEvent/settle.
     */
    async #ensure(trx, call) {
        const { callId, telnyxCallControlId, userId, didNumberId, direction, fromNumber, toNumber, startTime } = call;

        await trx('cdr')
            .insert({
                call_id: callId,
                telnyx_call_control_id: telnyxCallControlId || callId,
                user_id: userId || null,
                did_number_id: didNumberId || null,
                direction,
                from_number: fromNumber || null,
                to_number: toNumber || null,
                status: 'initiated',
                start_time: startTime || new Date()
            })
            .onConflict('call_id')
            .merge({
                // The earliest time anyone saw the call. A late event can create
                // the row with its own timestamp before call.initiated arrives.
                start_time: trx.raw('LEAST(cdr.start_time, excluded.start_time)'),
                user_id: trx.raw('COALESCE(cdr.user_id, excluded.user_id)'),
                did_number_id: trx.raw('COALESCE(cdr.did_number_id, excluded.did_number_id)'),
                from_number: trx.raw('COALESCE(cdr.from_number, excluded.from_number)'),
                to_number: trx.raw('COALESCE(cdr.to_number, excluded.to_number)'),
                telnyx_call_control_id: trx.raw('COALESCE(cdr.telnyx_call_control_id, excluded.telnyx_call_control_id)')
            });
    }

    /**
     * Finish a call once it has ended, and bill it exactly once.
     *
     * Runs under the row lock taken by the caller. billed_at is the claim: it
     * is set in the same transaction as the wallet debit, so a duplicate
     * hangup, a retry, or the answered event arriving after the hangup can
     * each reach this point without charging twice or not at all.
     */
    async #settle(trx, row) {
        if (!row || !row.end_time) return row;

        const answered = Boolean(row.answer_time);
        const patch = {};

        const status = terminalStatus(row);
        if (row.status !== status) patch.status = status;

        const duration = answered ? this.calculateDuration(row.answer_time, row.end_time) : 0;
        if (row.duration_seconds !== duration) patch.duration_seconds = duration;

        // Only answered calls cost anything, and only once we know whose call it is.
        const billable = answered && !row.billed_at && (row.direction === 'inbound' || row.user_id);
        if (billable) {
            const cost = this.calculateCost(duration, row.direction);
            patch.cost = cost;
            patch.billed_at = trx.fn.now();

            if (cost > 0) {
                try {
                    await walletService.deductFunds(row.user_id, cost, {
                        description: `Call to ${row.to_number} (${Math.ceil(duration / 60)} min)`,
                        referenceType: 'call',
                        referenceId: row.id,
                        idempotencyKey: `call:${row.id}`,
                        allowNegative: true
                    }, trx);
                } catch (error) {
                    if (!(error instanceof HttpError)) throw error;
                    // No wallet to charge. Keep the call facts and leave it
                    // unbilled so it can be settled once that is fixed.
                    logger.error('Call could not be billed', { callId: row.call_id, reason: error.message });
                    delete patch.cost;
                    delete patch.billed_at;
                }
            }
        }

        if (Object.keys(patch).length === 0) return row;

        const [updated] = await trx('cdr').where({ id: row.id }).update(patch).returning('*');
        return updated;
    }

    /**
     * Get CDR list for user
     */
    async getUserCDR(userId, { page = 1, limit = 20, direction, status, startDate, endDate } = {}) {
        let query = db('cdr').where({ user_id: userId });

        if (direction) {
            query = query.where({ direction });
        }

        if (status) {
            query = query.where({ status });
        }

        if (startDate) {
            query = query.where('start_time', '>=', new Date(startDate));
        }

        if (endDate) {
            query = query.where('start_time', '<=', new Date(endDate));
        }

        // Count without ORDER BY (Postgres rejects it on an ungrouped aggregate).
        const [{ count }] = await query.clone().count();

        const cdrs = await query
            .select('*')
            .orderBy('start_time', 'desc')
            .orderBy('id', 'desc')
            .limit(limit)
            .offset((page - 1) * limit);

        return {
            records: cdrs.map(this.formatCDR),
            pagination: {
                page,
                limit,
                total: parseInt(count),
                totalPages: Math.ceil(parseInt(count) / limit)
            }
        };
    }

    /**
     * Get one of the user's CDRs by call ID. Scoped by owner: a call ID that
     * belongs to someone else is indistinguishable from one that does not exist.
     */
    async getCDRByCallId(callId, userId) {
        if (!userId) return null;
        const cdr = await db('cdr').where({ call_id: callId, user_id: userId }).first();
        return cdr ? this.formatCDR(cdr) : null;
    }

    /**
     * Number of the user's outbound calls that have started but not ended.
     * Calls older than Telnyx's 4-hour maximum are ignored, so a call whose
     * hangup was never delivered cannot block the user forever.
     */
    async countOpenOutboundCalls(userId) {
        const [{ count }] = await db('cdr')
            .where({ user_id: userId, direction: 'outbound' })
            .whereNull('end_time')
            .where('start_time', '>', db.raw("now() - interval '4 hours'"))
            .count();
        return parseInt(count);
    }

    /**
     * Get call statistics for user
     */
    async getCallStats(userId, { days = 30 } = {}) {
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const stats = await db('cdr')
            .where({ user_id: userId })
            .where('start_time', '>=', startDate)
            .select(
                db.raw('COUNT(*) as total_calls'),
                db.raw('SUM(duration_seconds) as total_duration'),
                db.raw('SUM(cost) as total_cost'),
                db.raw("COUNT(CASE WHEN direction = 'inbound' THEN 1 END) as inbound_calls"),
                db.raw("COUNT(CASE WHEN direction = 'outbound' THEN 1 END) as outbound_calls"),
                db.raw("COUNT(CASE WHEN status = 'missed' THEN 1 END) as missed_calls")
            )
            .first();

        const totalCalls = parseInt(stats.total_calls) || 0;
        const totalDuration = parseInt(stats.total_duration) || 0;

        return {
            totalCalls,
            totalDuration,
            totalCost: parseFloat(stats.total_cost) || 0,
            inboundCalls: parseInt(stats.inbound_calls) || 0,
            outboundCalls: parseInt(stats.outbound_calls) || 0,
            missedCalls: parseInt(stats.missed_calls) || 0,
            averageDuration: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0
        };
    }

    /**
     * Calculate duration in seconds
     */
    calculateDuration(startTime, endTime) {
        if (!startTime || !endTime) return 0;
        const start = new Date(startTime);
        const end = new Date(endTime);
        return Math.max(0, Math.floor((end - start) / 1000));
    }

    /**
     * Calculate call cost based on duration
     * Default: $0.01 per started minute for outbound, free for inbound
     */
    calculateCost(durationSeconds, direction) {
        if (direction === 'inbound') return 0;
        const minutes = Math.ceil(durationSeconds / 60);
        // Work in cents so the result is exact to two decimals.
        return Math.round(minutes * CALL_RATE_PER_MINUTE * 100) / 100;
    }

    /**
     * Format CDR for API response
     */
    formatCDR(cdr) {
        if (!cdr) return null;
        return {
            id: cdr.id,
            callId: cdr.call_id,
            direction: cdr.direction,
            fromNumber: cdr.from_number,
            toNumber: cdr.to_number,
            status: cdr.status,
            startTime: cdr.start_time,
            answerTime: cdr.answer_time,
            endTime: cdr.end_time,
            durationSeconds: cdr.duration_seconds,
            cost: parseFloat(cdr.cost) || 0,
            hangupCause: cdr.hangup_cause,
            recordingUrl: cdr.recording_url
        };
    }
}

export default new CDRService();
