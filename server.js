// server.js - Clean entry point with compression & performance middleware
// This replaces the legacy monolith with the modular route structure.

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Server: SocketIOServer } = require('socket.io');

const config = require('./config');
const { mountRoutes } = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const chatService = require('./services/chatService');
const sessionService = require('./services/sessionService');
const thumbnailService = require('./services/thumbnailService');
const r2Service = require('./services/r2Service');
const videoService = require('./services/videoService');

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

// ─── Socket.io ───────────────────────────────────────────────────────────────

const io = new SocketIOServer(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

chatService.initSocketHandlers(io);

// ─── Middleware Stack ────────────────────────────────────────────────────────

// 1. Security headers
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false
}));

// 2. CORS
app.use(cors());

// 3. HTTP Compression (critical for mobile data performance)
//    Compresses JSON API responses ~10-20x smaller.
//    Videos are excluded via the filter function.
app.use(compression({
    level: 6,  // Good balance of speed vs compression ratio
    threshold: 1024,  // Don't compress responses < 1KB
    filter: (req, res) => {
        // Skip compression for video streams
        if (req.headers['x-no-compression']) return false;
        if (req.path.startsWith('/video/')) return false;
        if (res.getHeader('Content-Type') && String(res.getHeader('Content-Type')).includes('video/')) return false;
        return compression.filter(req, res);
    }
}));

// 4. Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 5. Response time logging
app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6;  // ms
        if (elapsed > 500) {
            console.warn(`[SLOW] ${req.method} ${req.path} — ${elapsed.toFixed(0)}ms (status: ${res.statusCode})`);
        } else if (req.path.startsWith('/api/')) {
            console.log(`[Perf] ${req.method} ${req.path} — ${elapsed.toFixed(0)}ms`);
        }
    });
    next();
});

// 6. Request logging (combined format for production)
app.use(morgan('combined'));

// 7. Rate limiting (API routes only)
const limiter = rateLimit({
    windowMs: config.RATE_LIMIT.WINDOW_MS,
    max: config.RATE_LIMIT.MAX_REQUESTS,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
});
app.set('trust proxy', false);
app.use('/api/', limiter);

// ─── Static Files ────────────────────────────────────────────────────────────

// Thumbnails with long cache (they are versioned with ?v=mtime)
app.use('/thumbnails', express.static(
    path.join(process.cwd(), 'cache', 'thumbnails'),
    { maxAge: '7d', immutable: true }
));

// Public files (admin UI, etc.)
app.use(express.static(path.join(process.cwd(), 'public')));

// ─── Routes ──────────────────────────────────────────────────────────────────

mountRoutes(app);

// ─── Error Handling ──────────────────────────────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── Server Start ────────────────────────────────────────────────────────────

async function startServer() {
    // Warm up caches before accepting traffic
    console.log('═══════════════════════════════════════════════');
    console.log('       InuPoi VPS Server — Starting...');
    console.log('═══════════════════════════════════════════════');

    // Warm R2 video list cache
    await r2Service.warmCache();

    // Warm video details + series cache (so first request is instant)
    await videoService.warmVideoDetailsCache();

    // Start background cache refresh every 4 minutes (keeps caches hot 24/7)
    videoService.startBackgroundRefresh();

    // Start auto-generating missing thumbnails (background)
    thumbnailService.autoGenerateMissing();

    // Start periodic thumbnail auto-generation
    setInterval(() => {
        thumbnailService.autoGenerateMissing();
    }, config.THUMBNAIL.AUTO_INTERVAL_MS);

    // Start periodic session cleanup
    setInterval(() => {
        sessionService.cleanupInactiveSessions();
        chatService.pruneOldMessages();
    }, 60 * 1000);

    // Start listening
    server.listen(config.PORT, config.HOST, () => {
        console.log('═══════════════════════════════════════════════');
        console.log(`  Server running on http://${config.HOST}:${config.PORT}`);
        console.log(`  R2 Bucket: ${config.R2.BUCKET_NAME}`);
        console.log(`  CDN URL: ${config.R2.PUBLIC_URL || 'not configured'}`);
        console.log(`  Compression: enabled (level 6)`);
        console.log(`  R2 Cache TTL: ${config.R2_CACHE_TTL_MS / 1000}s`);
        console.log(`  Video Cache TTL: ${config.VIDEO_DETAILS_CACHE_TTL_MS / 1000}s`);
        console.log(`  API Cache-Control: ${config.API_CACHE_MAX_AGE}s`);
        console.log(`  Health: http://${config.HOST}:${config.PORT}/health`);
        console.log('═══════════════════════════════════════════════');
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
