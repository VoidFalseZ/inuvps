// src/routes/index.js — Route aggregator

'use strict';

const healthRoutes = require('./healthRoutes');
const videoRoutes = require('./videoRoutes');
const adminRoutes = require('./adminRoutes');
const chatRoutes = require('./chatRoutes');

/**
 * Mount all routes on the Express app.
 * @param {import('express').Application} app
 */
function mountRoutes(app) {
    app.use(healthRoutes);
    app.use(videoRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/chat', chatRoutes);
}

module.exports = { mountRoutes };
