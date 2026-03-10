// config/index.js - Centralized configuration

require('dotenv').config();

module.exports = {
    // Server
    PORT: parseInt(process.env.PORT, 10) || 8000,
    HOST: process.env.HOST || '0.0.0.0',

    // Admin
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'inupoi-admin-2024',

    // R2 Storage
    R2: {
        ACCOUNT_ID: process.env.R2_ACCOUNT_ID || 'your-account-id',
        ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || 'your-access-key-id',
        SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || 'your-secret-access-key',
        BUCKET_NAME: process.env.R2_BUCKET_NAME || 'anime-videos',
        PUBLIC_URL: process.env.R2_PUBLIC_URL || null,
        get ENDPOINT() {
            return `https://${this.ACCOUNT_ID}.r2.cloudflarestorage.com`;
        }
    },

    // Session & Activity
    SESSION_TIMEOUT_MS: 5 * 60 * 1000,           // 5 minutes
    ACTIVITY_LOG_MAX: 1000,

    // Thumbnail Generation
    THUMBNAIL: {
        MAX_CONCURRENT: 2,
        MAX_RETRY_ATTEMPTS: 3,
        RETRY_DELAY_MS: 2000,
        FAILED_COOLDOWN_MS: 30 * 60 * 1000,      // 30 minutes
        AUTO_INTERVAL_MS: 10 * 60 * 1000         // 10 minutes
    },

    // HLS Transcoding
    HLS: {
        MAX_CONCURRENT: 2,                        // Max simultaneous transcode jobs
        SEGMENT_DURATION: 6,                      // Seconds per .ts segment
        KEYFRAME_INTERVAL: 48,                    // 2s at 24fps
        PRESET: 'veryfast',                       // FFmpeg speed preset
        QUALITIES: {
            '360p': { width: 640, height: 360, videoBitrate: '800k', audioBitrate: '64k' },
            '480p': { width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k' },
            '720p': { width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k' }
        }
    },

    // Chat
    CHAT: {
        MAX_AGE_MS: 24 * 60 * 60 * 1000,         // 24 hours
        UPLOAD_SIZE_LIMIT: 5 * 1024 * 1024       // 5MB
    },

    // R2 Cache TTL
    R2_CACHE_TTL_MS: 5 * 60 * 1000,              // 5 minutes

    // Video details cache TTL
    VIDEO_DETAILS_CACHE_TTL_MS: 5 * 60 * 1000,   // 5 minutes

    // HTTP Cache-Control max-age for API responses (seconds)
    API_CACHE_MAX_AGE: 120,                      // 2 minutes

    // Rate Limiting
    RATE_LIMIT: {
        WINDOW_MS: 15 * 60 * 1000,
        MAX_REQUESTS: 1000
    },

    // Default Admin Config
    DEFAULT_ADMIN_CONFIG: {
        app_version: {
            latest: "1.0.2",
            minimum: "1.0.0",
            force_update: false
        },
        update_dialog: {
            enabled: false,
            title: "Update Available",
            message: "A new version of InuPoi is available!",
            update_url: ""
        },
        notifications: [],
        maintenance: {
            enabled: false,
            message: "Server is under maintenance. Please try again later."
        }
    }
};
