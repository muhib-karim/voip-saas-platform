// Deterministic, offline configuration for tests. Must run before src/ modules
// are imported, because src/config reads process.env at import time.
export const TEST_JWT_SECRET = 'test-only-jwt-secret';

export function setupTestEnv() {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_placeholder';
    process.env.TELNYX_API_KEY = 'test-placeholder';
}
