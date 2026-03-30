// src/controllers/adminController.js — Admin CRUD operation handlers

'use strict';

const path = require('path');
const sessionService = require('../services/sessionService');
const thumbnailService = require('../services/thumbnailService');
const chatService = require('../services/chatService');
const videoService = require('../services/videoService');
const r2Service = require('../services/r2Service');
const hlsService = require('../services/hlsService');
const { getBaseFilename } = require('../utils/fileParser');
const { createLogger } = require('../utils/logger');

const log = createLogger('Admin');

// ─── User / Session ──────────────────────────────────────────────────────────

function getOnlineUsers(req, res) {
    res.json(sessionService.getOnlineUsers());
}

function getUserStats(req, res) {
    res.json(sessionService.getStats());
}

function getActivityLog(req, res) {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const eventFilter = req.query.event;
    res.json(sessionService.getActivityLog(limit, eventFilter));
}

// ─── Thumbnails ──────────────────────────────────────────────────────────────

function getThumbnailStatus(req, res) {
    res.json(thumbnailService.getStatus());
}

function serveThumbnailManager(req, res) {
    res.sendFile(path.resolve(__dirname, '..', '..', 'public', 'admin', 'thumbnail-manager.html'));
}

function uploadThumbnail(req, res) {
    try {
        const { filename } = req.body;

        if (!filename) {
            return res.status(400).json({ success: false, error: 'filename is required' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'thumbnail image file is required' });
        }

        const thumbnailPath = thumbnailService.saveCustomThumbnail(filename, req.file.buffer, req.file.mimetype);

        videoService.invalidateDetailsCache();
        chatService.getIo()?.emit('thumbnail_updated', { filename, thumbnail_url: thumbnailPath });

        res.json({
            success: true,
            message: `Custom thumbnail saved for: ${filename}`,
            thumbnail_url: thumbnailPath,
        });
    } catch (error) {
        log.error('Thumbnail upload error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

async function regenerateThumbnailAtTimestamp(req, res) {
    try {
        const { filename, timestamp_seconds } = req.body;

        if (!filename) {
            return res.status(400).json({ success: false, error: 'filename is required' });
        }

        const timestamp = parseInt(timestamp_seconds, 10);
        if (isNaN(timestamp) || timestamp < 0) {
            return res.status(400).json({ success: false, error: 'timestamp_seconds must be a non-negative number' });
        }

        const videoFile = await videoService.findByFilename(filename);
        if (!videoFile) {
            return res.status(404).json({ success: false, error: `Video not found: ${filename}` });
        }

        const thumbnailPath = await thumbnailService.generateAtTimestamp(videoFile.key, filename, timestamp);

        if (thumbnailPath) {
            videoService.invalidateDetailsCache();
            chatService.getIo()?.emit('thumbnail_updated', { filename, thumbnail_url: thumbnailPath });
            res.json({
                success: true,
                message: `Thumbnail regenerated at ${timestamp}s for: ${filename}`,
                thumbnail_url: thumbnailPath,
            });
        } else {
            res.status(500).json({
                success: false,
                error: `Failed to generate thumbnail at ${timestamp}s for: ${filename}`,
            });
        }
    } catch (error) {
        log.error('Thumbnail regenerate-at error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

function deleteThumbnail(req, res) {
    try {
        const { filename } = req.body;

        if (!filename) {
            return res.status(400).json({ success: false, error: 'filename is required' });
        }

        const result = thumbnailService.deleteThumbnail(filename);

        if (result.deleted) {
            videoService.invalidateDetailsCache();
            chatService.getIo()?.emit('thumbnail_updated', { filename, thumbnail_url: null });
            res.json({ success: true, message: `Thumbnail deleted for: ${filename}` });
        } else {
            res.status(404).json({ success: false, error: `No thumbnail found for: ${filename}` });
        }
    } catch (error) {
        log.error('Thumbnail delete error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

function clearFailedThumbnails(req, res) {
    const { filename } = req.body;
    const result = thumbnailService.clearFailed(filename);
    res.json({ success: true, ...result });
}

async function regenerateAllThumbnails(req, res) {
    const videoFiles = await r2Service.listVideos();

    let queued = 0, skipped = 0, existing = 0;

    for (const file of videoFiles) {
        const baseFilename = getBaseFilename(file.filename);

        if (thumbnailService.exists(file.filename)) { existing++; continue; }
        if (!thumbnailService.canRetryThumbnail(`${baseFilename}.png`)) { skipped++; continue; }

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
        current_status: thumbnailService.getStatus(),
    });
}

// ─── Chat ────────────────────────────────────────────────────────────────────

function serveChatManager(req, res) {
    res.sendFile(path.resolve(__dirname, '..', '..', 'public', 'admin', 'chat-manager.html'));
}

function getChatMessages(req, res) {
    res.json({ success: true, messages: chatService.getHistory() });
}

function deleteChatMessage(req, res) {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const deleted = chatService.deleteMessage(id);
    if (deleted) {
        res.json({ success: true, message: `Message deleted: ${id}` });
    } else {
        res.status(404).json({ success: false, error: `Message not found: ${id}` });
    }
}

function sendChatMessage(req, res) {
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
}

// ─── HLS ─────────────────────────────────────────────────────────────────────

function getHlsStatus(req, res) {
    res.json(hlsService.getStatus());
}

function getHlsProgress(req, res) {
    const { filename } = req.params;
    res.json({ filename, ...hlsService.getProgress(filename) });
}

async function transcodeVideo(req, res) {
    try {
        const { filename, qualities, force } = req.body;

        if (!filename) {
            return res.status(400).json({ success: false, error: 'filename is required' });
        }

        const videoFile = await videoService.findByFilename(filename);
        if (!videoFile) {
            return res.status(404).json({ success: false, error: `Video not found: ${filename}` });
        }

        const videoUrl = await r2Service.getSignedVideoUrl(videoFile.key, 7200);
        if (!videoUrl) {
            return res.status(500).json({ success: false, error: 'Failed to get video URL' });
        }

        const result = await hlsService.queueVideo(filename, videoUrl, {
            qualities: qualities || null,
            force: !!force,
        });

        res.json({ success: true, ...result });
    } catch (error) {
        log.error('HLS transcode error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

async function transcodeAllVideos(req, res) {
    try {
        const { qualities, force } = req.body;
        const videoFiles = await r2Service.listVideos();

        let queued = 0, skipped = 0, alreadyDone = 0;
        const errors = [];

        for (const file of videoFiles) {
            if (!force) {
                const exists = await hlsService.hasHLS(file.filename);
                if (exists) { alreadyDone++; continue; }
            }

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
            errors,
        });
    } catch (error) {
        log.error('HLS transcode-all error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

module.exports = {
    // User / Session
    getOnlineUsers,
    getUserStats,
    getActivityLog,
    // Thumbnails
    getThumbnailStatus,
    serveThumbnailManager,
    uploadThumbnail,
    regenerateThumbnailAtTimestamp,
    deleteThumbnail,
    clearFailedThumbnails,
    regenerateAllThumbnails,
    // Chat
    serveChatManager,
    getChatMessages,
    deleteChatMessage,
    sendChatMessage,
    // HLS
    getHlsStatus,
    getHlsProgress,
    transcodeVideo,
    transcodeAllVideos,
};
