// src/controllers/healthController.js — Health, heartbeat, and app config handlers

'use strict';

const config = require('../config');
const adminConfigService = require('../services/adminConfigService');
const sessionService = require('../services/sessionService');

/**
 * GET /api/app_config — Combined app configuration for the client.
 */
function getAppConfig(req, res) {
    const appConfig = adminConfigService.loadConfig();
    res.json({
        app_version: appConfig.app_version,
        update_dialog: appConfig.update_dialog,
        notifications: adminConfigService.getActiveNotifications(),
        maintenance: appConfig.maintenance,
    });
}

/**
 * GET /api/notifications
 */
function getNotifications(req, res) {
    res.json(adminConfigService.getActiveNotifications());
}

/**
 * GET /api/update_dialog
 */
function getUpdateDialog(req, res) {
    const appConfig = adminConfigService.loadConfig();
    res.json(appConfig.update_dialog);
}

/**
 * GET /api/app_version — Legacy endpoint.
 */
function getAppVersion(req, res) {
    const appConfig = adminConfigService.loadConfig();
    res.json({ latest_version: appConfig.app_version.latest });
}

/**
 * GET /api/show_update_dialog_command — Legacy endpoint.
 */
function getShowUpdateDialogCommand(req, res) {
    const appConfig = adminConfigService.loadConfig();
    res.json({ show_dialog: appConfig.update_dialog.enabled });
}

/**
 * GET /health
 */
function healthCheck(req, res) {
    const appConfig = adminConfigService.loadConfig();
    res.json({
        status: appConfig.maintenance.enabled ? 'maintenance' : 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: appConfig.app_version.latest,
        r2_bucket: config.R2.BUCKET_NAME,
        maintenance: appConfig.maintenance.enabled,
        online_users: sessionService.getOnlineCount(),
    });
}

/**
 * POST /api/heartbeat
 */
function heartbeat(req, res) {
    const { device_id, platform, app_version, event, details } = req.body;

    if (!device_id) {
        return res.status(400).json({ error: 'device_id is required' });
    }

    const result = sessionService.processHeartbeat({
        device_id,
        platform,
        app_version,
        event,
        details,
    });

    res.json(result);
}

module.exports = {
    getAppConfig,
    getNotifications,
    getUpdateDialog,
    getAppVersion,
    getShowUpdateDialogCommand,
    healthCheck,
    heartbeat,
};
