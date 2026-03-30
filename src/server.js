// src/server.js — HTTP server, Socket.io, startup, and graceful shutdown

'use strict';

const http = require('http');
const { Server: SocketIOServer } = require('socket.io');

const { createApp } = require('./app');
const config = require('./config');
const { createLogger } = require('./utils/logger');

// Services
const chatService = require('./services/chatService');
const sessionService = require('./services/sessionService');
const thumbnailService = require('./services/thumbnailService');
const r2Service = require('./services/r2Service');
const videoService = require('./services/videoService');
const metadataService = require('./services/metadataService');
const hlsService = require('./services/hlsService');

const log = createLogger('Server');

// ─── Create App & Server ─────────────────────────────────────────────────────

const app = createApp();
const server = http.createServer(app);

// ─── Socket.io ───────────────────────────────────────────────────────────────

const io = new SocketIOServer(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

chatService.initSocketHandlers(io);

// ─── Interval Handles (for cleanup on shutdown) ──────────────────────────────

const intervals = [];

// ─── Startup ─────────────────────────────────────────────────────────────────

async function startServer() {
    log.info('═══════════════════════════════════════════════');
    log.info('       InuPoi VPS Server — Starting...');
    log.info('═══════════════════════════════════════════════');

    // Warm caches
    await r2Service.warmCache();
    await videoService.warmVideoDetailsCache();

    // Start background refresh
    videoService.startBackgroundRefresh();

    // Auto-generate missing thumbnails
    thumbnailService.autoGenerateMissing();
    intervals.push(setInterval(() => {
        thumbnailService.autoGenerateMissing();
    }, config.THUMBNAIL.AUTO_INTERVAL_MS));

    // Periodic session cleanup + chat prune
    intervals.push(setInterval(() => {
        sessionService.cleanupInactiveSessions();
        chatService.pruneOldMessages();
    }, 60 * 1000));

    // Start listening
    server.listen(config.PORT, config.HOST, () => {
        log.info('═══════════════════════════════════════════════');
        log.info(`  Server running on http://${config.HOST}:${config.PORT}`);
        log.info(`  Environment: ${config.NODE_ENV}`);
        log.info(`  R2 Bucket: ${config.R2.BUCKET_NAME}`);
        log.info(`  CDN URL: ${config.R2.PUBLIC_URL || 'not configured'}`);
        log.info(`  Compression: enabled (level 6)`);
        log.info(`  R2 Cache TTL: ${config.R2_CACHE_TTL_MS / 1000}s`);
        log.info(`  Video Cache TTL: ${config.VIDEO_DETAILS_CACHE_TTL_MS / 1000}s`);
        log.info(`  API Cache-Control: ${config.API_CACHE_MAX_AGE}s`);
        log.info(`  Health: http://${config.HOST}:${config.PORT}/health`);
        log.info('═══════════════════════════════════════════════');
    });

    // Keep-alive tuning for mobile clients
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info(`${signal} received — starting graceful shutdown...`);

    // 1. Stop accepting new connections
    server.close(() => {
        log.info('HTTP server closed');
    });

    // 2. Clear all intervals
    for (const id of intervals) clearInterval(id);
    videoService.stopBackgroundRefresh();
    hlsService.destroy();

    // 3. Close Socket.io
    io.close(() => {
        log.info('Socket.io closed');
    });

    // 4. Flush pending writes
    try {
        await Promise.all([
            metadataService.flush(),
            chatService.flush(),
            sessionService.flush(),
        ]);
        log.info('All pending writes flushed');
    } catch (err) {
        log.error('Error flushing data:', err.message);
    }

    log.info('Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Unhandled Errors ────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
    log.error('Uncaught exception:', err.message);
    log.error(err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', reason);
});

// ─── Start ───────────────────────────────────────────────────────────────────

startServer().catch(err => {
    log.error('Failed to start server:', err.message);
    process.exit(1);
});
