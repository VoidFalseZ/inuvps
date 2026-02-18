// server.js - Cloudflare R2 Video Streaming Server (Modular Entry Point)

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Load configuration
const config = require('./config');

// Load services
const chatService = require('./services/chatService');
const sessionService = require('./services/sessionService');
const thumbnailService = require('./services/thumbnailService');

// Load routes
const { mountRoutes } = require('./routes');

// Load error handlers
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

// --- Express App Setup ---
const app = express();
const server = http.createServer(app);

// --- Socket.io Setup ---
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
chatService.initSocketHandlers(io);

// --- Security Middleware ---
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false
}));
app.use(cors());

// --- Compression (skip for video streams) ---
const shouldCompress = (req, res) => {
    if (req.headers['x-no-compression'] || req.path.includes('/video/')) {
        return false;
    }
    return compression.filter(req, res);
};
app.use(compression({ filter: shouldCompress }));

// --- Body Parsing ---
app.use(express.json());

// --- Logging ---
app.use(morgan('combined'));

// --- Rate Limiting ---
const apiLimiter = rateLimit({
    windowMs: config.RATE_LIMIT.WINDOW_MS,
    max: config.RATE_LIMIT.MAX_REQUESTS,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    skip: () => false
});
app.use('/api/', apiLimiter);

// --- Static Files ---
app.use('/thumbnails', express.static(path.join(process.cwd(), 'cache', 'thumbnails'), {
    maxAge: '7d',
    immutable: true
}));
app.use('/chat_uploads', express.static(chatService.CHAT_UPLOADS_DIR, { maxAge: '7d' }));

// --- Mount All Routes ---
mountRoutes(app);

// --- Error Handlers ---
app.use(errorHandler);
app.use(notFoundHandler);

// --- Start Server ---
server.listen(config.PORT, config.HOST, () => {
    console.log(` Server is running at http://${config.HOST}:${config.PORT}`);
    console.log(` R2 Bucket: ${config.R2.BUCKET_NAME}`);
    console.log(` R2 Endpoint: ${config.R2.ENDPOINT}`);
    console.log(` Health check: http://${config.HOST}:${config.PORT}/health`);

    // Auto-trigger thumbnail generation on startup
    setTimeout(async () => {
        console.log('[Thumbnail Auto] Starting automatic thumbnail generation...');
        await thumbnailService.autoGenerateMissing();
    }, 5000);
});

// --- Periodic Tasks ---

// Session cleanup (every minute)
setInterval(() => {
    sessionService.cleanupInactiveSessions();
}, 60000);

// Save session data (every 30 seconds)
setInterval(() => {
    sessionService.saveActivityData();
}, 30000);

// Chat history cleanup (every hour)
setInterval(() => {
    chatService.pruneOldMessages();
}, 60 * 60 * 1000);

// Automatic thumbnail generation (every 10 minutes)
setInterval(() => {
    console.log('[Thumbnail Auto] Periodic check starting...');
    thumbnailService.autoGenerateMissing();
}, config.THUMBNAIL.AUTO_INTERVAL_MS);
