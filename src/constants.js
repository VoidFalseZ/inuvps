// src/constants.js — Shared constants

'use strict';

/** Directory names relative to project root */
const DIRS = {
    CACHE: 'cache',
    THUMBNAILS: 'cache/thumbnails',
    CHAT_UPLOADS: 'cache/chat_uploads',
    PUBLIC: 'public',
};

/** Cache file names (inside DIRS.CACHE) */
const DATA_FILES = {
    METADATA: 'metadata.json',
    ADMIN_CONFIG: 'admin_config.json',
    ACTIVITY_LOG: 'activity_log.json',
    SESSIONS: 'sessions.json',
    CHAT_HISTORY: 'chat_history.json',
};

/** Supported video file extensions */
const VIDEO_EXTENSIONS = ['.mp4'];

/** Supported thumbnail extensions (checked in order) */
const THUMBNAIL_EXTENSIONS = ['.png', '.jpg'];

/** MIME type mappings */
const MIME_TYPES = {
    HLS_PLAYLIST: 'application/vnd.apple.mpegurl',
    HLS_SEGMENT: 'video/MP2T',
    VIDEO_MP4: 'video/mp4',
};

module.exports = {
    DIRS,
    DATA_FILES,
    VIDEO_EXTENSIONS,
    THUMBNAIL_EXTENSIONS,
    MIME_TYPES,
};
