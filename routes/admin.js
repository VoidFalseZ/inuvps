// routes/admin.js - Admin API routes

const express = require('express');
const router = express.Router();
const { adminAuth } = require('../middleware/auth');
const sessionService = require('../services/sessionService');
const thumbnailService = require('../services/thumbnailService');
const { getBaseFilename } = require('../utils/fileParser');
const r2Service = require('../services/r2Service');

// Apply admin auth to all routes in this router
router.use(adminAuth);

// Get online users list
router.get('/users/online', (req, res) => {
    res.json(sessionService.getOnlineUsers());
});

// Get user statistics
router.get('/users/stats', (req, res) => {
    res.json(sessionService.getStats());
});

// Get activity log
router.get('/activity/log', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const eventFilter = req.query.event;
    res.json(sessionService.getActivityLog(limit, eventFilter));
});

// Get thumbnail generation status
router.get('/thumbnails/status', (req, res) => {
    res.json(thumbnailService.getStatus());
});

// Clear failed thumbnails (allow retry)
router.post('/thumbnails/clear-failed', (req, res) => {
    const { filename } = req.body;
    const result = thumbnailService.clearFailed(filename);
    res.json({ success: true, ...result });
});

// Trigger thumbnail regeneration for all videos without thumbnails
router.post('/thumbnails/regenerate', async (req, res) => {
    const videoFiles = await r2Service.listVideos();

    let queued = 0;
    let skipped = 0;
    let existing = 0;

    for (const file of videoFiles) {
        const baseFilename = getBaseFilename(file.filename);

        // Check if thumbnail exists
        if (thumbnailService.exists(file.filename)) {
            existing++;
            continue;
        }

        if (!thumbnailService.canRetryThumbnail(`${baseFilename}.png`)) {
            skipped++;
            continue;
        }

        // This will queue if at capacity
        thumbnailService.generateThumbnail(file.key, `${baseFilename}.png`);
        queued++;
    }

    // Process queue
    thumbnailService.processQueue();

    res.json({
        success: true,
        total_videos: videoFiles.length,
        existing_thumbnails: existing,
        queued_for_generation: queued,
        skipped_in_cooldown: skipped,
        current_status: thumbnailService.getStatus()
    });
});

module.exports = router;
