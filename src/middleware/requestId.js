// src/middleware/requestId.js — Inject a unique request ID for traceability

'use strict';

const crypto = require('crypto');

/**
 * Middleware that generates a short unique ID for every request.
 * Attaches to `req.id` and echoes back in the `X-Request-Id` response header.
 */
function requestId(req, res, next) {
    const id = crypto.randomBytes(8).toString('hex');
    req.id = id;
    res.set('X-Request-Id', id);
    next();
}

module.exports = { requestId };
