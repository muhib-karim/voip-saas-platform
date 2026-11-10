import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import config from './config/index.js';
import { errorHandler, logger } from './middleware/errorHandler.js';
import { rateLimiters } from './middleware/rateLimiter.js';

// Routes
import authRoutes from './routes/auth.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import numbersRoutes from './routes/numbers.routes.js';
import callsRoutes from './routes/calls.routes.js';
import ratesRoutes from './routes/rates.routes.js';
import webhooksRoutes from './routes/webhooks.routes.js';

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false
}));

app.use(cors({
    origin: config.frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Cookie parser for refresh tokens
app.use(cookieParser());

// Number of proxies in front of the app (TRUST_PROXY). Rate limits are keyed
// on req.ip, so this must match the real deployment: too high and clients
// can spoof X-Forwarded-For, too low and every user shares the proxy's IP.
app.set('trust proxy', config.trustProxy);

// Body parsing. Webhooks keep the raw bytes: both Stripe and Telnyx sign the
// exact body they sent, and a re-serialised JSON object would not verify.
app.use('/api/webhooks', express.raw({ type: () => true, limit: '1mb' }));
app.use(express.json({ limit: '10kb' })); // Limit body size
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Request logging
app.use((req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        // originalUrl, not req.path: by the time the response finishes,
        // req.path is relative to whichever router handled the request.
        const path = req.originalUrl.split('?')[0];
        logger.info(`${req.method} ${path} ${res.statusCode} ${duration}ms`, {
            ip: req.ip,
            userAgent: req.get('User-Agent')?.substring(0, 100),
            userId: req.user?.userId
        });
    });

    next();
});

// Health check (no rate limiting)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0'
    });
});

// Webhooks are mounted before the general API limiter and have their own:
// Stripe and Telnyx deliver from a handful of addresses, and a 429 here is a
// lost payment or an unbilled call.
app.use('/api/webhooks', rateLimiters.webhook, webhooksRoutes);

// Apply standard rate limiting to all other API routes
app.use('/api/', rateLimiters.api);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/numbers', numbersRoutes);
app.use('/api/calls', callsRoutes);
app.use('/api/rates', ratesRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Error handler
app.use(errorHandler);

export default app;
