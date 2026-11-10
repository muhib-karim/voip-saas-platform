import axios from 'axios';

// Set EXPO_PUBLIC_API_URL to your own backend, including the /api path, for
// example https://api.example.com/api. Expo inlines EXPO_PUBLIC_* at build
// time. There is deliberately no hosted default: credentials are only ever
// sent to a server you chose.
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:5000/api';

const api = axios.create({
    baseURL: API_URL,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
    },
});

// Request interceptor
api.interceptors.request.use(
    (config) => {
        if (__DEV__) {
            console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`);
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// Response interceptor
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const errorMessage =
            error.response?.data?.message ||
            error.response?.data?.error ||
            error.message ||
            'An unexpected error occurred';

        if (__DEV__) {
            console.error('[API Error]', errorMessage);
        }

        return Promise.reject(new Error(errorMessage));
    }
);

export default api;
