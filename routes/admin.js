// routes/admin.js - Admin API routes

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { adminAuth } = require('../middleware/auth');
const sessionService = require('../services/sessionService');
const thumbnailService = require('../services/thumbnailService');
const chatService = require('../services/chatService');
const videoService = require('../services/videoService');
const { getBaseFilename } = require('../utils/fileParser');
const r2Service = require('../services/r2Service');

// Multer for thumbnail uploads (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    }
});

// Apply admin auth to all routes in this router
router.use(adminAuth);

// ─── USER / SESSION ROUTES ────────────────────────────────────────────────────

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

// ─── THUMBNAIL ROUTES ─────────────────────────────────────────────────────────

// Get thumbnail generation status
router.get('/thumbnails/status', (req, res) => {
    res.json(thumbnailService.getStatus());
});

// Serve thumbnail manager HTML page
router.get('/thumbnails/manager', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'admin', 'thumbnail-manager.html'));
});

// Upload a custom thumbnail image
router.post('/thumbnails/upload', upload.single('thumbnail'), (req, res) => {
    try {
        console.log('[Admin] Upload request - body:', req.body);
        console.log('[Admin] Upload request - file:', req.file ? 'present' : 'missing');

        const { filename } = req.body;

        if (!filename) {
            console.error('[Admin] Upload failed: filename missing');
            return res.status(400).json({ success: false, error: 'filename is required' });
        }
        if (!req.file) {
            console.error('[Admin] Upload failed: file missing');
            return res.status(400).json({ success: false, error: 'thumbnail image file is required' });
        }

        console.log('[Admin] Processing upload for:', filename);
        const thumbnailPath = thumbnailService.saveCustomThumbnail(
            filename,
            req.file.buffer,
            req.file.mimetype
        );

        console.log('[Admin] Upload successful:', thumbnailPath);
        // Notify all clients to refresh thumbnails
        chatService.getIo()?.emit('thumbnail_updated', { filename, thumbnail_url: thumbnailPath });
        res.json({
            success: true,
            message: 'Custom thumbnail saved for: ' + filename,
            thumbnail_url: thumbnailPath
        });
    } catch (error) {
        console.error('[Admin] Thumbnail upload error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Regenerate thumbnail at a custom timestamp
router.post('/thumbnails/regenerate-at', async (req, res) => {
    try {
        console.log('[Admin] Regenerate-at request:', req.body);
        const { filename, timestamp_seconds } = req.body;

        if (!filename) {
            return res.status(400).json({ success: false, error: 'filename is required' });
        }

        const timestamp = parseInt(timestamp_seconds, 10);
        if (isNaN(timestamp) || timestamp < 0) {
            return res.status(400).json({ success: false, error: 'timestamp_seconds must be a non-negative number' });
        }

        console.log('[Admin] Looking for video:', filename);
        const videoFile = await videoService.findByFilename(filename);
        if (!videoFile) {
            console.error('[Admin] Video not found:', filename);
            return res.status(404).json({ success: false, error: 'Video not found: ' + filename });
        }

        console.log('[Admin] Video found:', videoFile.key);
        console.log('[Admin] Generating thumbnail at', timestamp, 'seconds');

        const thumbnailPath = await thumbnailService.generateAtTimestamp(
            videoFile.key,
            filename,
            timestamp
        );

        console.log('[Admin] Generation result:', thumbnailPath);

        if (thumbnailPath) {
            // Notify all clients to refresh thumbnails
            chatService.getIo()?.emit('thumbnail_updated', { filename, thumbnail_url: thumbnailPath });
            res.json({
                success: true,
                message: 'Thumbnail regenerated at ' + timestamp + 's for: ' + filename,
                thumbnail_url: thumbnailPath
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to generate thumbnail at ' + timestamp + 's for: ' + filename
            });
        }
    } catch (error) {
        console.error('[Admin] Thumbnail regenerate-at error:', error.message);
        console.error(error.stack);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete a specific thumbnail
router.post('/thumbnails/delete', (req, res) => {
    try {
        const { filename } = req.body;

        if (!filename) {
            return res.status(400).json({ success: false, error: 'filename is required' });
        }

        console.log('[Admin] Delete request for:', filename);
        const result = thumbnailService.deleteThumbnail(filename);
        console.log('[Admin] Delete result:', result);

        if (result.deleted) {
            // Notify all clients to refresh thumbnails
            chatService.getIo()?.emit('thumbnail_updated', { filename, thumbnail_url: null });
            res.json({ success: true, message: 'Thumbnail deleted for: ' + filename });
        } else {
            res.status(404).json({ success: false, error: 'No thumbnail found for: ' + filename });
        }
    } catch (error) {
        console.error('[Admin] Thumbnail delete error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
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

        if (thumbnailService.exists(file.filename)) {
            existing++;
            continue;
        }

        if (!thumbnailService.canRetryThumbnail(`${baseFilename}.png`)) {
            skipped++;
            continue;
        }

        thumbnailService.generateThumbnail(file.key, `${baseFilename}.png`);
        queued++;
    }

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

// ─── CHAT ROUTES ──────────────────────────────────────────────────────────────

// Serve chat manager HTML page
router.get('/chat/manager', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'admin', 'chat-manager.html'));
});

// Get all chat messages
router.get('/chat/messages', (req, res) => {
    res.json({ success: true, messages: chatService.getHistory() });
});

// Delete a chat message by ID
router.post('/chat/delete', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const deleted = chatService.deleteMessage(id);
    if (deleted) {
        res.json({ success: true, message: 'Message deleted: ' + id });
    } else {
        res.status(404).json({ success: false, error: 'Message not found: ' + id });
    }
});

// Send a message as Admin
router.post('/chat/send', (req, res) => {
    const { text, image } = req.body;
    if (!text && !image) {
        return res.status(400).json({ success: false, error: 'text or image is required' });
    }

    const message = chatService.addMessage({
        id: Date.now().toString(),
        text: text || '',
        image: image || null,
        sender: 'Admin',
        isAdmin: true,
        timestamp: new Date().toISOString(),
    });

    chatService.broadcastMessage(message);
    res.json({ success: true, message });
});

module.exports = router;

