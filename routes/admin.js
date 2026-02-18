// routes/admin.js - Admin API routes

const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { adminAuth } = require('../middleware/auth');
const sessionService = require('../services/sessionService');
const thumbnailService = require('../services/thumbnailService');
const chatService = require('../services/chatService');
const r2Service = require('../services/r2Service');
const { getBaseFilename } = require('../utils/fileParser');

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

// =============================================
// CHAT ADMIN ROUTES
// =============================================

// Get full chat history
router.get('/chat', (req, res) => {
    res.json(chatService.getHistory());
});

// Delete a chat message by ID (broadcasts chat_delete via socket.io)
router.delete('/chat/:id', (req, res) => {
    const { id } = req.params;
    const deleted = chatService.deleteMessage(id);
    if (deleted) {
        res.json({ success: true, id });
    } else {
        res.status(404).json({ error: 'Message not found' });
    }
});

// Send a message as Admin (secure server-side isAdmin flag)
router.post('/chat/send', (req, res) => {
    const { text, image } = req.body;
    if (!text && !image) {
        return res.status(400).json({ error: 'text or image is required' });
    }

    const message = chatService.addMessage({
        id: Date.now().toString(),
        text: text || '',
        image: image || null,
        sender: 'Admin',
        isAdmin: true,
        timestamp: new Date().toISOString()
    });

    // Broadcast to all connected clients via socket.io
    const io = chatService.getIo();
    if (io) {
        io.emit('chat_message', message);
    }

    res.json({ success: true, message });
});

// =============================================
// THUMBNAIL ADMIN ROUTES
// =============================================

// List all existing thumbnails
router.get('/thumbnails/list', (req, res) => {
    res.json(thumbnailService.listThumbnails());
});

// Regenerate thumbnail at a specific timestamp
router.post('/thumbnails/regenerate-at', async (req, res) => {
    const { filename, timestamp } = req.body;
    if (!filename || timestamp === undefined) {
        return res.status(400).json({ error: 'filename and timestamp are required' });
    }

    try {
        const videoFiles = await r2Service.listVideos();
        const videoFile = videoFiles.find(f => getBaseFilename(f.filename) === getBaseFilename(filename));
        if (!videoFile) {
            return res.status(404).json({ error: 'Video not found in R2' });
        }

        const baseFilename = getBaseFilename(filename);
        const outputFilename = `${baseFilename}.png`;
        const newUrl = await thumbnailService.regenerateThumbnailAt(videoFile.key, outputFilename, parseFloat(timestamp));

        if (newUrl) {
            res.json({ success: true, url: newUrl });
        } else {
            res.status(500).json({ error: 'Thumbnail regeneration failed' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload a custom thumbnail image
const thumbnailStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, thumbnailService.THUMBNAIL_DIR),
    filename: (req, file, cb) => {
        const { filename } = req.body;
        if (!filename) return cb(new Error('filename is required'));
        const baseFilename = getBaseFilename(filename);
        cb(null, `${baseFilename}.png`);
    }
});
const uploadThumbnail = multer({ storage: thumbnailStorage, limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/thumbnails/upload', uploadThumbnail.single('thumbnail'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No thumbnail file provided' });
    }
    const stats = fs.statSync(req.file.path);
    const url = `/thumbnails/${req.file.filename}?v=${Math.floor(stats.mtimeMs)}`;
    res.json({ success: true, url });
});

// Delete a thumbnail
router.delete('/thumbnails/:filename', (req, res) => {
    const { filename } = req.params;
    const deleted = thumbnailService.deleteThumbnail(filename);
    if (deleted) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Thumbnail not found' });
    }
});

module.exports = router;
