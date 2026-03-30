// src/middleware/auth.js — Admin authentication middleware (hardened)

'use strict';

const config = require('../config');
const { timingSafeEqual } = require('../utils/helpers');
const { createLogger } = require('../utils/logger');

const log = createLogger('Auth');

/**
 * Admin authentication middleware.
 * Validates the API key from the `x-admin-key` header only.
 * Uses constant-time comparison to prevent timing attacks.
 */
function adminAuth(req, res, next) {
    const apiKey = req.headers['x-admin-key'];

    if (!apiKey) {
        log.warn(`Unauthenticated admin access attempt: ${req.method} ${req.path} from ${req.ip}`);
        return res.status(401).json({
            error: 'Unauthorized. Missing admin API key in x-admin-key header.',
        });
    }

    if (!timingSafeEqual(apiKey, config.ADMIN_API_KEY)) {
        log.warn(`Invalid admin key attempt: ${req.method} ${req.path} from ${req.ip}`);
        return res.status(401).json({
            error: 'Unauthorized. Invalid admin API key.',
        });
    }

    next();
}

module.exports = { adminAuth };
