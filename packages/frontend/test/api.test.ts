import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import api, { ApiError, refreshAccessToken, setAccessToken, setAuthFailureHandler } from '../src/services/api';

type Reply = { status: number; data?: unknown };
type Seen = { url: string; authorization?: string };

/**
 * Replace the network with a function. Every request is recorded so tests can
 * assert exactly which calls were made, and in which order.
 */
function mockServer(reply: (config: InternalAxiosRequestConfig, seen: Seen[]) => Reply | Promise<Reply>) {
    const seen: Seen[] = [];
    api.defaults.adapter = async (config) => {
        seen.push({ url: String(config.url), authorization: config.headers?.Authorization as string | undefined });
        const { status, data } = await reply(config, seen);
        const response = { data, status, statusText: String(status), headers: {}, config };
        if (status >= 200 && status < 300) return response;
        throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, null, response);
    };
    return seen;
}

const urls = (seen: Seen[]) => seen.map((s) => s.url);
const count = (seen: Seen[], url: string) => seen.filter((s) => s.url === url).length;

beforeEach(() => {
    setAccessToken(null);
    setAuthFailureHandler(null);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('401 handling', () => {
    it('reports a failed login once and does not try to refresh', async () => {
        // This used to recurse: every 401, including the one from /auth/refresh
        // itself, started another refresh.
        const seen = mockServer(() => ({ status: 401, data: { error: 'Unauthorized', message: 'Invalid email or password' } }));

        const failure = await api.post('/auth/login', { email: 'a@example.com', password: 'wrong' }).catch((e) => e);

        expect(urls(seen)).toEqual(['/auth/login']);
        expect(failure).toBeInstanceOf(ApiError);
        expect(failure.message).toBe('Invalid email or password');
        expect(failure.status).toBe(401);
    });

    it('does not refresh in response to a failed refresh, register or logout', async () => {
        for (const path of ['/auth/refresh', '/auth/register', '/auth/logout']) {
            const seen = mockServer(() => ({ status: 401, data: { error: 'Refresh token required' } }));
            await api.post(path).catch(() => undefined);
            expect(urls(seen)).toEqual([path]);
        }
    });

    it('refreshes an expired access token once and replays the request with the new token', async () => {
        setAccessToken('expired-token');
        const seen = mockServer((config) => {
            if (config.url === '/auth/refresh') return { status: 200, data: { accessToken: 'fresh-token' } };
            return config.headers.Authorization === 'Bearer fresh-token'
                ? { status: 200, data: { balance: 12.5 } }
                : { status: 401, data: { message: 'Token expired' } };
        });

        const response = await api.get('/wallet');

        expect(response.data).toEqual({ balance: 12.5 });
        expect(urls(seen)).toEqual(['/wallet', '/auth/refresh', '/wallet']);
        expect(seen[2].authorization).toBe('Bearer fresh-token');
        expect(api.defaults.headers.common['Authorization']).toBe('Bearer fresh-token');
    });

    it('sends one refresh for many simultaneous 401s', async () => {
        // The server rotates the refresh token on every use: parallel
        // refreshes would invalidate each other and end the session.
        setAccessToken('expired-token');
        const seen = mockServer(async (config) => {
            if (config.url === '/auth/refresh') {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return { status: 200, data: { accessToken: 'fresh-token' } };
            }
            return config.headers.Authorization === 'Bearer fresh-token'
                ? { status: 200, data: { ok: true } }
                : { status: 401, data: { message: 'Token expired' } };
        });

        const responses = await Promise.all([
            api.get('/wallet'), api.get('/numbers'), api.get('/calls/history'), api.get('/auth/me'), api.get('/calls/stats'),
        ]);

        expect(responses.every((r) => r.status === 200)).toBe(true);
        expect(count(seen, '/auth/refresh')).toBe(1);
        expect(seen).toHaveLength(11);
    });

    it('gives up after one replay instead of looping', async () => {
        const seen = mockServer((config) =>
            config.url === '/auth/refresh'
                ? { status: 200, data: { accessToken: 'fresh-token' } }
                : { status: 401, data: { message: 'Invalid token' } });

        const failure = await api.get('/wallet').catch((e) => e);

        expect(urls(seen)).toEqual(['/wallet', '/auth/refresh', '/wallet']);
        expect(failure.status).toBe(401);
    });

    it('signals the app when the session cannot be refreshed', async () => {
        const onAuthFailure = vi.fn();
        setAuthFailureHandler(onAuthFailure);
        const seen = mockServer(() => ({ status: 401, data: { message: 'Invalid or expired refresh token' } }));

        const failure = await api.get('/wallet').catch((e) => e);

        expect(urls(seen)).toEqual(['/wallet', '/auth/refresh']);
        expect(onAuthFailure).toHaveBeenCalledTimes(1);
        expect(failure.message).toBe('Invalid or expired refresh token');
    });

    it('does not treat other errors as an expired session', async () => {
        const onAuthFailure = vi.fn();
        setAuthFailureHandler(onAuthFailure);
        const seen = mockServer(() => ({ status: 400, data: { error: 'Validation Error', message: 'Insufficient funds' } }));

        const failure = await api.post('/numbers/purchase', {}).catch((e) => e);

        expect(urls(seen)).toEqual(['/numbers/purchase']);
        expect(failure.message).toBe('Insufficient funds');
        expect(onAuthFailure).not.toHaveBeenCalled();
    });
});

describe('refreshAccessToken', () => {
    it('retries once when another tab has just rotated the token (409)', async () => {
        const seen = mockServer((_config, all) =>
            count(all, '/auth/refresh') === 1
                ? { status: 409, data: { message: 'Refresh already in progress', code: 'REFRESH_CONFLICT' } }
                : { status: 200, data: { accessToken: 'fresh-token' } });

        await expect(refreshAccessToken()).resolves.toBe('fresh-token');
        expect(count(seen, '/auth/refresh')).toBe(2);
    });

    it('stops after one 409 retry', async () => {
        const seen = mockServer(() => ({ status: 409, data: { message: 'Refresh already in progress' } }));

        await expect(refreshAccessToken()).rejects.toMatchObject({ status: 409 });
        expect(count(seen, '/auth/refresh')).toBe(2);
    });

    it('can be used again after a failure', async () => {
        let healthy = false;
        mockServer(() => (healthy ? { status: 200, data: { accessToken: 'fresh-token' } } : { status: 401, data: {} }));

        await expect(refreshAccessToken()).rejects.toBeInstanceOf(ApiError);
        healthy = true;
        await expect(refreshAccessToken()).resolves.toBe('fresh-token');
    });
});
