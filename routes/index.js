// routes/index.js - Route aggregator

const healthRoutes = require('./health');
const videoRoutes = require('./videos');
const adminRoutes = require('./admin');
const chatRoutes = require('./chat');

/**
 * Mount all routes on the Express app
 * @param {Express.Application} app - Express app instance
 */
function mountRoutes(app) {
    // Health, config, and heartbeat endpoints
    app.use(healthRoutes);

    // Video streaming and listing
    app.use(videoRoutes);

    // Admin API endpoints
    app.use('/api/admin', adminRoutes);

    // Chat endpoints
    app.use('/api/chat', chatRoutes);
}

module.exports = { mountRoutes };
