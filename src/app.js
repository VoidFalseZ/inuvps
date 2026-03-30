// src/app.js — Express application factory
// Creates and configures the Express app without starting the server.
// This separation enables clean testing and flexible startup.

'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');

const config = require('./config');
const { mountRoutes } = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { requestId } = require('./middleware/requestId');

/**
 * Create and configure the Express application.
 * @returns {import('express').Application}
 */
function createApp() {
    const app = express();

    // ─── 1. Request ID ───────────────────────────────────────────────────────
    app.use(requestId);

    // ─── 2. Security headers ─────────────────────────────────────────────────
    app.use(helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        contentSecurityPolicy: false,
    }));

    // ─── 3. CORS ─────────────────────────────────────────────────────────────
    app.use(cors());

    // ─── 4. HTTP Compression ─────────────────────────────────────────────────
    app.use(compression({
        level: 6,
        threshold: 1024,
        filter: (req, res) => {
            if (req.headers['x-no-compression']) return false;
            if (req.path.startsWith('/video/')) return false;
            if (res.getHeader('Content-Type') &&
                String(res.getHeader('Content-Type')).includes('video/')) return false;
            return compression.filter(req, res);
        },
    }));

    // ─── 5. Body parsing ─────────────────────────────────────────────────────
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // ─── 6. Response time logging ────────────────────────────────────────────
    app.use((req, res, next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
            if (elapsed > 500) {
                console.warn(`[SLOW] ${req.method} ${req.path} — ${elapsed.toFixed(0)}ms (status: ${res.statusCode})`);
            } else if (req.path.startsWith('/api/')) {
                console.log(`[Perf] ${req.method} ${req.path} — ${elapsed.toFixed(0)}ms`);
            }
        });
        next();
    });

    // ─── 7. Request logging ──────────────────────────────────────────────────
    app.use(morgan(config.NODE_ENV === 'production' ? 'combined' : 'dev'));

    // ─── 8. Rate limiting (API routes only) ──────────────────────────────────
    const limiter = rateLimit({
        windowMs: config.RATE_LIMIT.WINDOW_MS,
        max: config.RATE_LIMIT.MAX_REQUESTS,
        message: { error: 'Too many requests, please try again later.' },
        standardHeaders: true,
        legacyHeaders: false,
        validate: { xForwardedForHeader: false },
    });
    app.set('trust proxy', false);
    app.use('/api/', limiter);

    // ─── 9. Static files ─────────────────────────────────────────────────────

    // Thumbnails with long cache (versioned via ?v=mtime)
    app.use('/thumbnails', express.static(
        path.resolve(__dirname, '..', 'cache', 'thumbnails'),
        { maxAge: '7d', immutable: true }
    ));

    // Chat uploads
    app.use('/chat_uploads', express.static(
        path.resolve(__dirname, '..', 'cache', 'chat_uploads')
    ));

    // Public files (admin UI, etc.)
    app.use(express.static(path.resolve(__dirname, '..', 'public')));

    // ─── 10. Routes ──────────────────────────────────────────────────────────
    mountRoutes(app);

    // ─── 11. Error handling ──────────────────────────────────────────────────
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };
