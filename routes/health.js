// routes/health.js - Health and config endpoints

const express = require('express');
const router = express.Router();
const config = require('../config');
const adminConfigService = require('../services/adminConfigService');
const sessionService = require('../services/sessionService');

// Combined app config endpoint
router.get('/api/app_config', (req, res) => {
    const appConfig = adminConfigService.loadConfig();

    res.json({
        app_version: appConfig.app_version,
        update_dialog: appConfig.update_dialog,
        notifications: adminConfigService.getActiveNotifications(),
        maintenance: appConfig.maintenance
    });
});

// Notifications endpoint
router.get('/api/notifications', (req, res) => {
    res.json(adminConfigService.getActiveNotifications());
});

// Update dialog endpoint
router.get('/api/update_dialog', (req, res) => {
    const appConfig = adminConfigService.loadConfig();
    res.json(appConfig.update_dialog);
});

// Legacy endpoints (backward compatibility)
router.get('/api/app_version', (req, res) => {
    const appConfig = adminConfigService.loadConfig();
    res.json({ latest_version: appConfig.app_version.latest });
});

router.get('/api/show_update_dialog_command', (req, res) => {
    const appConfig = adminConfigService.loadConfig();
    res.json({ show_dialog: appConfig.update_dialog.enabled });
});

// Health check
router.get('/health', (req, res) => {
    const appConfig = adminConfigService.loadConfig();
    res.json({
        status: appConfig.maintenance.enabled ? 'maintenance' : 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: appConfig.app_version.latest,
        r2_bucket: config.R2.BUCKET_NAME,
        maintenance: appConfig.maintenance.enabled,
        online_users: sessionService.getOnlineCount()
    });
});

// Heartbeat - client sends this to stay online
router.post('/api/heartbeat', (req, res) => {
    const { device_id, platform, app_version, event, details } = req.body;

    if (!device_id) {
        return res.status(400).json({ error: 'device_id is required' });
    }

    const result = sessionService.processHeartbeat({
        device_id,
        platform,
        app_version,
        event,
        details
    });

    res.json(result);
});

module.exports = router;
