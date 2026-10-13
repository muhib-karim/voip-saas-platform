import config from './config/index.js';
import { initRedis } from './config/redis.js';
import { logger } from './middleware/errorHandler.js';
import app from './app.js';

// Initialize Redis (non-blocking)
initRedis().catch(err => {
    logger.warn('Redis initialization failed, continuing without cache:', err.message);
});

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
    logger.info(`${signal} received. Starting graceful shutdown...`);

    // Close server
    server.close(async () => {
        logger.info('HTTP server closed');

        // Close database connections, Redis, etc.
        try {
            const { getRedis } = await import('./config/redis.js');
            const redis = getRedis();
            if (redis) await redis.quit();

            const db = (await import('./config/database.js')).default;
            await db.destroy();

            logger.info('All connections closed');
            process.exit(0);
        } catch (err) {
            logger.error('Error during shutdown:', err);
            process.exit(1);
        }
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
};

// Start server
const PORT = config.port;

const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`Frontend URL: ${config.frontendUrl}`);
});

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

export default app;
