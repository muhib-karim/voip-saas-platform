import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User, AuthState, LoginCredentials, RegisterData } from '@/types';
import api, { refreshAccessToken, setAccessToken, setAuthFailureHandler } from '@/services/api';

interface AuthStore extends AuthState {
    // Actions
    login: (credentials: LoginCredentials) => Promise<void>;
    register: (data: RegisterData) => Promise<void>;
    logout: () => Promise<void>;
    refreshToken: () => Promise<boolean>;
    updateUser: (user: Partial<User>) => void;
    setLoading: (loading: boolean) => void;
    checkAuth: () => Promise<void>;
}

const signedOut = { user: null, accessToken: null, isAuthenticated: false, isLoading: false };

export const useAuthStore = create<AuthStore>()(
    persist(
        (set, get) => ({
            // Initial state
            user: null,
            accessToken: null,
            isAuthenticated: false,
            isLoading: true,

            // Login
            login: async (credentials) => {
                set({ isLoading: true });
                try {
                    const response = await api.post<{ user: User; accessToken: string }>(
                        '/auth/login',
                        credentials
                    );
                    const { user, accessToken } = response.data;

                    // Set token for future requests
                    setAccessToken(accessToken);
                    set({
                        user,
                        accessToken,
                        isAuthenticated: true,
                        isLoading: false,
                    });
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },

            // Register
            register: async (data) => {
                set({ isLoading: true });
                try {
                    const response = await api.post<{ user: User; accessToken: string }>(
                        '/auth/register',
                        data
                    );
                    const { user, accessToken } = response.data;

                    setAccessToken(accessToken);
                    set({
                        user,
                        accessToken,
                        isAuthenticated: true,
                        isLoading: false,
                    });
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },

            // Logout
            logout: async () => {
                try {
                    await api.post('/auth/logout');
                } catch {
                    // Continue with logout even if API fails
                }

                setAccessToken(null);
                set(signedOut);
            },

            // Refresh token
            refreshToken: async () => {
                try {
                    const accessToken = await refreshAccessToken();
                    set({ accessToken, isAuthenticated: true });
                    return true;
                } catch {
                    // The refresh cookie is missing, expired or revoked.
                    setAccessToken(null);
                    set(signedOut);
                    return false;
                }
            },

            // Update user
            updateUser: (userData) => {
                set((state) => ({
                    user: state.user ? { ...state.user, ...userData } : null,
                }));
            },

            // Set loading
            setLoading: (loading) => {
                set({ isLoading: loading });
            },

            // Restore the session on app load.
            //
            // The access token is never written to storage, so a reload starts
            // without one. If this browser was signed in (a user is persisted),
            // the HttpOnly refresh cookie is exchanged for a fresh access token.
            checkAuth: async () => {
                if (!get().user) {
                    set({ isLoading: false, isAuthenticated: false });
                    return;
                }

                set({ isLoading: true });
                const restored = await get().refreshToken();
                if (!restored) return;

                set({ isLoading: false });
                try {
                    const response = await api.get<User>('/auth/me');
                    set({ user: response.data });
                } catch {
                    // Keep the persisted user; a failing profile call is not a logout.
                }
            },
        }),
        {
            name: 'voip-auth',
            version: 2,
            storage: createJSONStorage(() => localStorage),
            // Only the profile is persisted. The access token lives in memory:
            // anything in localStorage can be read by injected script.
            partialize: (state) => ({
                user: state.user,
            }),
            // Version 1 stored the access token; drop it on upgrade.
            migrate: (persisted) => ({
                user: (persisted as { user?: User | null } | null)?.user ?? null,
            }),
        }
    )
);

// When a request finds the session can no longer be refreshed, sign out so
// the router shows the login page (no full-page reload).
setAuthFailureHandler(() => {
    setAccessToken(null);
    useAuthStore.setState(signedOut);
});

export default useAuthStore;
