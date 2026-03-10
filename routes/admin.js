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
const hlsService = require('../services/hlsService');
const metadataService = require('../services/metadataService');

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
        // Invalidate video details cache so new thumbnail shows immediately
        videoService.invalidateDetailsCache();
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
            // Invalidate video details cache so new thumbnail shows immediately
            videoService.invalidateDetailsCache();
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
            // Invalidate video details cache
            videoService.invalidateDetailsCache();
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

// ─── HLS ROUTES ───────────────────────────────────────────────────────────────

// Get HLS transcoding status
router.get('/hls/status', (req, res) => {
    res.json(hlsService.getStatus());
});

// Get HLS progress for a specific video
router.get('/hls/progress/:filename', (req, res) => {
    const { filename } = req.params;
    res.json({ filename, ...hlsService.getProgress(filename) });
});

// Queue a specific video for HLS transcoding
router.post('/hls/transcode', async (req, res) => {
    try {
        const { filename, qualities, force } = req.body;

        if (!filename) {
            return res.status(400).json({ success: false, error: 'filename is required' });
        }

        const videoFile = await videoService.findByFilename(filename);
        if (!videoFile) {
            return res.status(404).json({ success: false, error: 'Video not found: ' + filename });
        }

        const videoUrl = await r2Service.getSignedVideoUrl(videoFile.key, 7200); // 2h — transcode takes time
        if (!videoUrl) {
            return res.status(500).json({ success: false, error: 'Failed to get video URL' });
        }

        const result = await hlsService.queueVideo(filename, videoUrl, {
            qualities: qualities || null,
            force: !!force
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Admin] HLS transcode error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Queue ALL videos that don't yet have HLS versions
router.post('/hls/transcode-all', async (req, res) => {
    try {
        const { qualities, force } = req.body;
        const videoFiles = await r2Service.listVideos();

        let queued = 0;
        let skipped = 0;
        let alreadyDone = 0;
        const errors = [];

        for (const file of videoFiles) {
            // Check if already done (unless force)
            if (!force) {
                const exists = await hlsService.hasHLS(file.filename);
                if (exists) {
                    alreadyDone++;
                    continue;
                }
            }

            // Skip videos that are already in the queue or being processed
            const status = hlsService.getStatus();
            if (status.currently_processing.includes(file.filename) ||
                status.queued.includes(file.filename)) {
                skipped++;
                continue;
            }

            try {
                const videoUrl = await r2Service.getSignedVideoUrl(file.key, 7200);
                if (videoUrl) {
                    await hlsService.queueVideo(file.filename, videoUrl, { qualities, force: !!force });
                    queued++;
                }
            } catch (err) {
                errors.push({ filename: file.filename, error: err.message });
            }
        }

        res.json({
            success: true,
            total_videos: videoFiles.length,
            queued,
            already_done: alreadyDone,
            skipped,
            errors
        });
    } catch (error) {
        console.error('[Admin] HLS transcode-all error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

