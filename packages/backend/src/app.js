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

// Trust proxy for accurate IP addresses behind load balancer
app.set('trust proxy', 1);

// Body parsing - raw for webhooks (Stripe needs raw body)
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' })); // Limit body size
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Request logging
app.use((req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`, {
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

// Apply standard rate limiting to all API routes
app.use('/api/', rateLimiters.api);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/numbers', numbersRoutes);
app.use('/api/calls', callsRoutes);
app.use('/api/rates', ratesRoutes);
app.use('/api/webhooks', rateLimiters.webhook, webhooksRoutes);

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
