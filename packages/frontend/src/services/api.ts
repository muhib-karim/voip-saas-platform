import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

// Create axios instance
const api = axios.create({
    baseURL: '/api',
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
    },
    withCredentials: true, // Send cookies for refresh token
});

/** Error thrown for failed API calls; keeps the HTTP status alongside the message. */
export class ApiError extends Error {
    status?: number;
    code?: string;

    constructor(message: string, status?: number, code?: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

// A 401 from these endpoints is an answer ("wrong password", "no session"),
// not an expired access token. Refreshing in response to them is what used to
// send the client into an endless refresh loop.
const AUTH_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];
const isAuthEndpoint = (url?: string) => AUTH_ENDPOINTS.some((path) => (url ?? '').startsWith(path));

let refreshInFlight: Promise<string> | null = null;
let authFailureHandler: (() => void) | null = null;

/** Called once when the session cannot be refreshed (the auth store logs the user out). */
export function setAuthFailureHandler(handler: (() => void) | null): void {
    authFailureHandler = handler;
}

export function setAccessToken(token: string | null): void {
    if (token) {
        api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
        delete api.defaults.headers.common['Authorization'];
    }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestRefresh(attempt = 0): Promise<string> {
    try {
        const response = await api.post<{ accessToken: string }>('/auth/refresh');
        return response.data.accessToken;
    } catch (err) {
        // 409: another tab rotated the refresh token a moment ago and the new
        // cookie is already set. One retry picks it up.
        if (attempt === 0 && err instanceof ApiError && err.status === 409) {
            await wait(250);
            return requestRefresh(1);
        }
        throw err;
    }
}

/**
 * Get a new access token using the refresh cookie.
 *
 * Single flight: however many requests discover an expired token at the same
 * moment, only one refresh is sent and they all wait for it. The server
 * rotates the refresh token on every use, so parallel refreshes would
 * invalidate each other.
 */
export function refreshAccessToken(): Promise<string> {
    if (!refreshInFlight) {
        refreshInFlight = requestRefresh()
            .then((token) => {
                setAccessToken(token);
                return token;
            })
            .finally(() => {
                refreshInFlight = null;
            });
    }
    return refreshInFlight;
}

// Request interceptor
api.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        // Log requests in development
        if (import.meta.env.DEV) {
            console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`);
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

// Response interceptor
api.interceptors.response.use(
    (response) => response,
    async (error: AxiosError<{ error?: string; message?: string; code?: string }>) => {
        const originalRequest = error.config as RetriableConfig | undefined;
        const status = error.response?.status;

        // Expired access token: refresh once, then replay the request.
        if (status === 401 && originalRequest && !originalRequest._retry && !isAuthEndpoint(originalRequest.url)) {
            originalRequest._retry = true;

            let accessToken: string;
            try {
                accessToken = await refreshAccessToken();
            } catch (refreshError) {
                // The session is gone. Let the app show the login screen.
                authFailureHandler?.();
                return Promise.reject(refreshError);
            }

            originalRequest.headers['Authorization'] = `Bearer ${accessToken}`;
            return api(originalRequest);
        }

        // Format error message
        const errorMessage = error.response?.data?.message
            || error.response?.data?.error
            || error.message
            || 'An unexpected error occurred';

        // Log errors in development
        if (import.meta.env.DEV) {
            console.error('[API Error]', errorMessage, error.response?.data);
        }

        return Promise.reject(new ApiError(errorMessage, status, error.response?.data?.code));
    }
);

export default api;
