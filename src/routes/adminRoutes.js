// src/routes/adminRoutes.js — Admin API routes (protected by adminAuth)

'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { adminAuth } = require('../middleware/auth');
const adminCtrl = require('../controllers/adminController');

// Multer for thumbnail uploads (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    },
});

// All admin routes require authentication
router.use(adminAuth);

// ── User / Session ───────────────────────────────────────────────────────────
router.get('/users/online', adminCtrl.getOnlineUsers);
router.get('/users/stats', adminCtrl.getUserStats);
router.get('/activity/log', adminCtrl.getActivityLog);

// ── Thumbnails ───────────────────────────────────────────────────────────────
router.get('/thumbnails/status', adminCtrl.getThumbnailStatus);
router.get('/thumbnails/manager', adminCtrl.serveThumbnailManager);
router.post('/thumbnails/upload', upload.single('thumbnail'), adminCtrl.uploadThumbnail);
router.post('/thumbnails/regenerate-at', adminCtrl.regenerateThumbnailAtTimestamp);
router.post('/thumbnails/delete', adminCtrl.deleteThumbnail);
router.post('/thumbnails/clear-failed', adminCtrl.clearFailedThumbnails);
router.post('/thumbnails/regenerate', adminCtrl.regenerateAllThumbnails);

// ── Chat ─────────────────────────────────────────────────────────────────────
router.get('/chat/manager', adminCtrl.serveChatManager);
router.get('/chat/messages', adminCtrl.getChatMessages);
router.post('/chat/delete', adminCtrl.deleteChatMessage);
router.post('/chat/send', adminCtrl.sendChatMessage);

// ── HLS ──────────────────────────────────────────────────────────────────────
router.get('/hls/status', adminCtrl.getHlsStatus);
router.get('/hls/progress/:filename', adminCtrl.getHlsProgress);
router.post('/hls/transcode', adminCtrl.transcodeVideo);
router.post('/hls/transcode-all', adminCtrl.transcodeAllVideos);

module.exports = router;
