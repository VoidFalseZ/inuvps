// src/routes/healthRoutes.js — Health, config, and heartbeat routes

'use strict';

const express = require('express');
const router = express.Router();
const healthCtrl = require('../controllers/healthController');

router.get('/api/app_config', healthCtrl.getAppConfig);
router.get('/api/notifications', healthCtrl.getNotifications);
router.get('/api/update_dialog', healthCtrl.getUpdateDialog);

// Legacy endpoints (backward compatibility)
router.get('/api/app_version', healthCtrl.getAppVersion);
router.get('/api/show_update_dialog_command', healthCtrl.getShowUpdateDialogCommand);

router.get('/health', healthCtrl.healthCheck);
router.post('/api/heartbeat', healthCtrl.heartbeat);

module.exports = router;
