// middleware/errorHandler.js - Centralized error handling

/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, next) {
    console.error('Unhandled error:', err.message);
    res.status(err.status || 500).json({ error: 'Internal server error' });
}

/**
 * 404 Not Found handler
 */
function notFoundHandler(req, res) {
    res.status(404).json({ error: 'Not found' });
}

module.exports = {
    errorHandler,
    notFoundHandler
};
