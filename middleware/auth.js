// middleware/auth.js - Admin authentication middleware

const config = require('../config');

/**
 * Admin authentication middleware
 * Checks for valid API key in header or query param
 */
function adminAuth(req, res, next) {
    const apiKey = req.headers['x-admin-key'] || req.query.api_key;

    if (apiKey !== config.ADMIN_API_KEY) {
        return res.status(401).json({
            error: 'Unauthorized. Invalid or missing admin API key.'
        });
    }

    next();
}

module.exports = { adminAuth };
