import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';

const STORAGE_KEY = 'voip-auth';
const USER = {
    id: '3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    emailVerified: false,
    phoneVerified: false,
    timezone: 'UTC',
    createdAt: '2026-01-01T00:00:00.000Z',
};
// A recognisable stand-in; if it ever shows up in storage the test fails.
const ACCESS_TOKEN = 'access-token-that-must-stay-in-memory';

type Reply = { status: number; data?: unknown };

/** Load fresh copies of the store and API client (the store hydrates at import). */
async function loadStore(reply: (config: InternalAxiosRequestConfig) => Reply) {
    vi.resetModules();
    const { default: api } = await import('../src/services/api');
    const { useAuthStore } = await import('../src/store/authStore');
    const seen: string[] = [];
    api.defaults.adapter = async (config) => {
        seen.push(String(config.url));
        const { status, data } = reply(config);
        const response = { data, status, statusText: String(status), headers: {}, config };
        if (status >= 200 && status < 300) return response;
        throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, null, response);
    };
    return { api, useAuthStore, seen };
}

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');

beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('auth store persistence', () => {
    it('keeps the access token in memory and never writes it to localStorage', async () => {
        const { api, useAuthStore } = await loadStore(() => ({ status: 200, data: { user: USER, accessToken: ACCESS_TOKEN } }));

        await useAuthStore.getState().login({ email: USER.email, password: 'a-long-password' });

        expect(useAuthStore.getState().accessToken).toBe(ACCESS_TOKEN);
        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(api.defaults.headers.common['Authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);

        expect(stored().state).toEqual({ user: USER });
        expect(JSON.stringify(localStorage)).not.toContain(ACCESS_TOKEN);
    });

    it('does the same after registration', async () => {
        const { useAuthStore } = await loadStore(() => ({ status: 201, data: { user: USER, accessToken: ACCESS_TOKEN } }));

        await useAuthStore.getState().register({ email: USER.email, password: 'a-long-password', firstName: 'Ada', lastName: 'Lovelace' });

        expect(JSON.stringify(localStorage)).not.toContain(ACCESS_TOKEN);
    });

    it('drops an access token left in storage by an older version', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { user: USER, accessToken: ACCESS_TOKEN }, version: 0 }));

        const { useAuthStore } = await loadStore(() => ({ status: 401 }));

        expect(useAuthStore.getState().accessToken).toBeNull();
        expect(useAuthStore.getState().user).toEqual(USER);
        expect(JSON.stringify(localStorage)).not.toContain(ACCESS_TOKEN);
    });
});

describe('restoring a session on load', () => {
    it('exchanges the refresh cookie for a new access token when a user is remembered', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { user: USER }, version: 2 }));
        const { useAuthStore, seen } = await loadStore((config) =>
            config.url === '/auth/refresh'
                ? { status: 200, data: { accessToken: ACCESS_TOKEN } }
                : { status: 200, data: { ...USER, firstName: 'Augusta' } });

        await useAuthStore.getState().checkAuth();

        expect(seen).toEqual(['/auth/refresh', '/auth/me']);
        expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isLoading: false, accessToken: ACCESS_TOKEN });
        expect(useAuthStore.getState().user?.firstName).toBe('Augusta');
        expect(JSON.stringify(localStorage)).not.toContain(ACCESS_TOKEN);
    });

    it('makes no request at all for a visitor who was never signed in', async () => {
        const { useAuthStore, seen } = await loadStore(() => ({ status: 401 }));

        await useAuthStore.getState().checkAuth();

        expect(seen).toEqual([]);
        expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false });
    });

    it('signs the user out when the refresh cookie is no longer valid', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { user: USER }, version: 2 }));
        const { useAuthStore, seen } = await loadStore(() => ({ status: 401, data: { message: 'Invalid or expired refresh token' } }));

        await useAuthStore.getState().checkAuth();

        expect(seen).toEqual(['/auth/refresh']);
        expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, isAuthenticated: false, isLoading: false });
        expect(stored().state).toEqual({ user: null });
    });
});

describe('ending a session', () => {
    it('logout clears the token, the user and the default header', async () => {
        const { api, useAuthStore } = await loadStore((config) =>
            config.url === '/auth/login' ? { status: 200, data: { user: USER, accessToken: ACCESS_TOKEN } } : { status: 200, data: {} });
        await useAuthStore.getState().login({ email: USER.email, password: 'a-long-password' });

        await useAuthStore.getState().logout();

        expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, isAuthenticated: false });
        expect(api.defaults.headers.common['Authorization']).toBeUndefined();
        expect(stored().state).toEqual({ user: null });
    });

    it('a request that finds the session gone signs the user out without a page reload', async () => {
        const { api, useAuthStore } = await loadStore((config) =>
            config.url === '/auth/login' ? { status: 200, data: { user: USER, accessToken: ACCESS_TOKEN } } : { status: 401, data: {} });
        await useAuthStore.getState().login({ email: USER.email, password: 'a-long-password' });
        const href = window.location.href;

        await api.get('/wallet').catch(() => undefined);

        expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, isAuthenticated: false });
        expect(window.location.href).toBe(href);
    });
});
