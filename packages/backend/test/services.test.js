import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { setupTestEnv } from './helpers.js';

setupTestEnv();
const { default: cdrService } = await import('../src/services/cdr.service.js');
const { default: ratesService } = await import('../src/services/rates.service.js');
const { default: authService } = await import('../src/services/auth.service.js');

test('cdr.calculateDuration returns whole seconds and never goes negative', () => {
    assert.equal(cdrService.calculateDuration('2024-01-01T00:00:00Z', '2024-01-01T00:01:30.900Z'), 90);
    assert.equal(cdrService.calculateDuration('2024-01-01T00:01:00Z', '2024-01-01T00:00:00Z'), 0);
    assert.equal(cdrService.calculateDuration(null, '2024-01-01T00:00:00Z'), 0);
});

test('cdr.calculateCost bills outbound per started minute and inbound for free', () => {
    assert.equal(cdrService.calculateCost(0, 'outbound'), 0);
    assert.equal(cdrService.calculateCost(1, 'outbound'), 0.01);
    assert.equal(cdrService.calculateCost(60, 'outbound'), 0.01);
    assert.ok(Math.abs(cdrService.calculateCost(61, 'outbound') - 0.02) < 1e-9);
    assert.equal(cdrService.calculateCost(3600, 'inbound'), 0);
});

test('cdr.formatCDR maps database columns to the API shape', () => {
    const formatted = cdrService.formatCDR({
        id: 'abc',
        call_id: 'call-1',
        direction: 'outbound',
        from_number: '+14155550100',
        to_number: '+442071838750',
        status: 'completed',
        start_time: 's',
        answer_time: 'a',
        end_time: 'e',
        duration_seconds: 42,
        cost: '0.0100',
        hangup_cause: 'normal_clearing',
        recording_url: null
    });
    assert.equal(formatted.callId, 'call-1');
    assert.equal(formatted.toNumber, '+442071838750');
    assert.equal(formatted.cost, 0.01);
    assert.equal(cdrService.formatCDR({ cost: null }).cost, 0);
});

test('rates.estimateCallCost adds connection fee and rounds to cents', async (t) => {
    t.mock.method(ratesService, 'getRate', async () => ({
        countryCode: 'GB', numberType: 'mobile', ratePerMinute: 0.05, connectionFee: 0.015, billingIncrement: 60
    }));
    const estimate = await ratesService.estimateCallCost('gb', 3, 'mobile');
    assert.equal(estimate.estimatedDuration, 3);
    assert.equal(estimate.connectionFee, 0.015);
    assert.ok(Math.abs(estimate.perMinuteCost - 0.15) < 1e-9);
    assert.equal(estimate.totalCost, 0.17);
});

test('auth.generateAccessToken issues a 15-minute access JWT', () => {
    const token = authService.generateAccessToken({ id: 'user-1', email: 'u@example.com' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    assert.equal(decoded.userId, 'user-1');
    assert.equal(decoded.email, 'u@example.com');
    assert.equal(decoded.type, 'access');
    assert.equal(decoded.exp - decoded.iat, 15 * 60);
});

test('auth.generateRefreshToken returns a random token and its sha256 hash', async () => {
    const a = await authService.generateRefreshToken();
    const b = await authService.generateRefreshToken();
    assert.match(a.refreshToken, /^[0-9a-f]{128}$/);
    assert.notEqual(a.refreshToken, b.refreshToken);
    assert.equal(a.refreshTokenHash, crypto.createHash('sha256').update(a.refreshToken).digest('hex'));
});
