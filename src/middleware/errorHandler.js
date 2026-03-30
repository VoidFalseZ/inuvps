// src/middleware/errorHandler.js — Centralized error handling

'use strict';

const config = require('../config');
const { createLogger } = require('../utils/logger');

const log = createLogger('Error');

/**
 * Global error handler middleware.
 * In development: returns full error message and stack.
 * In production: returns generic message to prevent info leakage.
 */
function errorHandler(err, req, res, _next) {
    const status = err.status || err.statusCode || 500;
    const requestId = req.id || 'unknown';

    log.error(`[${requestId}] ${req.method} ${req.path} — ${err.message}`);
    if (config.NODE_ENV !== 'production') {
        log.error(err.stack);
    }

    const response = {
        error: status >= 500 ? 'Internal server error' : err.message,
        request_id: requestId,
    };

    if (config.NODE_ENV !== 'production') {
        response.message = err.message;
        response.stack = err.stack;
    }

    res.status(status).json(response);
}

/**
 * 404 Not Found handler — must be the last route.
 */
function notFoundHandler(req, res) {
    res.status(404).json({
        error: 'Not found',
        path: req.originalUrl,
    });
}

module.exports = { errorHandler, notFoundHandler };
