// server.js - Cloudflare R2 Video Streaming Server (Clean - No Thumbnails)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { query, validationResult } = require('express-validator');
const fs = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const ffmpeg = require('fluent-ffmpeg');
const { execSync } = require('child_process');

// Try to use system FFmpeg first (more stable for streaming), fallback to npm package
let ffmpegPath, ffprobePath;
try {
    // Check if system ffmpeg exists
    execSync('which ffmpeg', { stdio: 'ignore' });
    execSync('which ffprobe', { stdio: 'ignore' });
    ffmpegPath = 'ffmpeg';
    ffprobePath = 'ffprobe';
    console.log('[FFmpeg] Using system FFmpeg');
} catch {
    // Fallback to npm package
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    ffprobePath = require('@ffprobe-installer/ffprobe').path;
    console.log('[FFmpeg] Using npm package FFmpeg');
}
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);


const app = express();

// --- Server Configuration ---
const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';

// --- Security Middleware ---
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json()); // Parse JSON bodies for heartbeat endpoint
app.use(morgan('combined'));

// --- Rate Limiting ---
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    // Disable trust proxy to avoid X-Forwarded-For errors
    skip: () => false,
});
app.use('/api/', apiLimiter);
app.use('/thumbnails', express.static(path.join(process.cwd(), "cache", "thumbnails")));

// --- R2 Configuration ---
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'your-account-id';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'your-access-key-id';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'your-secret-access-key';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'anime-videos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || null;

const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// --- Local Cache ---
const CACHE_DIR = path.join(process.cwd(), "cache");
const METADATA_FILE = path.join(CACHE_DIR, "metadata.json");
const THUMBNAIL_DIR = path.join(CACHE_DIR, "thumbnails");
const ADMIN_CONFIG_FILE = path.join(CACHE_DIR, "admin_config.json");
const ACTIVITY_LOG_FILE = path.join(CACHE_DIR, "activity_log.json");
const SESSIONS_FILE = path.join(CACHE_DIR, "sessions.json");

// --- Admin API Key (set in .env or use default for development) ---
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'inupoi-admin-2024';

// --- User Activity Tracking ---
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes inactive = offline
const ACTIVITY_LOG_MAX = 1000; // Max activity log entries
const activeSessions = new Map(); // deviceId -> session data
let activityLog = []; // Recent activity history
let dailyStats = {
    date: new Date().toISOString().split('T')[0],
    peak_online: 0,
    total_sessions: 0,
    unique_devices: new Set()
};

// --- Load persisted activity data ---
const loadActivityData = () => {
    try {
        if (fs.existsSync(ACTIVITY_LOG_FILE)) {
            activityLog = JSON.parse(fs.readFileSync(ACTIVITY_LOG_FILE, 'utf8'));
        }
        if (fs.existsSync(SESSIONS_FILE)) {
            const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            // Restore sessions that are still valid
            const now = Date.now();
            for (const [deviceId, session] of Object.entries(sessions)) {
                if (now - new Date(session.lastSeen).getTime() < SESSION_TIMEOUT_MS) {
                    activeSessions.set(deviceId, session);
                }
            }
            console.log(`Restored ${activeSessions.size} active sessions`);
        }
    } catch (error) {
        console.error('Error loading activity data:', error.message);
    }
};

const saveActivityData = () => {
    try {
        fs.writeFileSync(ACTIVITY_LOG_FILE, JSON.stringify(activityLog, null, 2));
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(activeSessions), null, 2));
    } catch (error) {
        console.error('Error saving activity data:', error.message);
    }
};

// Save activity data periodically (every 30 seconds)
setInterval(saveActivityData, 30000);

// --- Admin Auth Middleware ---
const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-admin-key'] || req.query.api_key;
    if (apiKey !== ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Invalid or missing admin API key.' });
    }
    next();
};

// --- Log Activity Helper ---
const logActivity = (deviceId, event, details = {}) => {
    const entry = {
        timestamp: new Date().toISOString(),
        device_id: deviceId,
        event,
        details
    };
    activityLog.unshift(entry); // Add to beginning
    if (activityLog.length > ACTIVITY_LOG_MAX) {
        activityLog = activityLog.slice(0, ACTIVITY_LOG_MAX);
    }
};

// --- Update Daily Stats ---
const updateDailyStats = () => {
    const today = new Date().toISOString().split('T')[0];
    if (dailyStats.date !== today) {
        // Reset for new day
        dailyStats = {
            date: today,
            peak_online: 0,
            total_sessions: 0,
            unique_devices: new Set()
        };
    }
    const currentOnline = activeSessions.size;
    if (currentOnline > dailyStats.peak_online) {
        dailyStats.peak_online = currentOnline;
    }
};


// --- Default Admin Config ---
const DEFAULT_ADMIN_CONFIG = {
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
};

// --- Load Admin Config ---
const loadAdminConfig = () => {
    try {
        if (fs.existsSync(ADMIN_CONFIG_FILE)) {
            const data = fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8');
            return { ...DEFAULT_ADMIN_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        console.error('Error loading admin config:', error.message);
    }
    return DEFAULT_ADMIN_CONFIG;
};

// --- Save Default Admin Config if not exists ---
const initAdminConfig = () => {
    if (!fs.existsSync(ADMIN_CONFIG_FILE)) {
        fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(DEFAULT_ADMIN_CONFIG, null, 2));
        console.log('Created default admin_config.json');
    }
};

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAIL_DIR)) fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
initAdminConfig();
loadActivityData(); // Restore persisted sessions and activity log

// --- R2 Helper Functions ---

// --- R2 Video List Cache ---
const r2Cache = {
    videos: null,
    lastFetched: 0,
    ttlMs: 60 * 1000, // 60 seconds cache TTL
};

async function listR2Videos(forceRefresh = false) {
    const now = Date.now();

    // Return cached data if still valid
    if (!forceRefresh && r2Cache.videos && (now - r2Cache.lastFetched) < r2Cache.ttlMs) {
        return r2Cache.videos;
    }

    const command = new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: '',
    });

    try {
        const response = await s3Client.send(command);
        const videoFiles = (response.Contents || [])
            .filter(item => item.Key.endsWith('.mp4'))
            .map(item => ({
                filename: path.basename(item.Key),
                key: item.Key,
                lastModified: item.LastModified,
                size: item.Size
            }));

        // Update cache
        r2Cache.videos = videoFiles;
        r2Cache.lastFetched = now;
        console.log(`[R2 Cache] Refreshed video list: ${videoFiles.length} videos`);

        return videoFiles;
    } catch (error) {
        console.error('Error listing R2 videos:', error.message);
        // Return stale cache if available on error
        if (r2Cache.videos) {
            console.log('[R2 Cache] Returning stale cache due to error');
            return r2Cache.videos;
        }
        return [];
    }
}

async function getSignedVideoUrl(key, expiresIn = 3600) {
    if (R2_PUBLIC_URL) {
        return `${R2_PUBLIC_URL}/${key}`;
    }

    const command = new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
    });

    try {
        return await getSignedUrl(s3Client, command, { expiresIn });
    } catch (error) {
        console.error(`Error generating signed URL for ${key}:`, error.message);
        return null;
    }
}

// --- Metadata Functions ---

const loadMetadata = () => {
    if (fs.existsSync(METADATA_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
        } catch {
            return {};
        }
    }
    return {};
};

const saveMetadata = (metadata) => {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 4), 'utf-8');
};


// --- Thumbnail Generation ---

const generatingThumbnails = new Set();
const MAX_CONCURRENT_THUMBNAILS = 2; // Limit concurrent generations to protect VPS

async function generateThumbnail(videoKey, outputFilename) {
    const outputPath = path.join(THUMBNAIL_DIR, outputFilename);
    const publicPath = `/thumbnails/${outputFilename}`;

    // Check if thumbnail already exists
    if (fs.existsSync(outputPath)) {
        return publicPath;
    }

    // Check if already generating
    if (generatingThumbnails.has(outputFilename)) {
        console.log(`Thumbnail generation already in progress for: ${outputFilename}`);
        return null;
    }

    // Limit concurrent generations to protect VPS resources
    if (generatingThumbnails.size >= MAX_CONCURRENT_THUMBNAILS) {
        console.log(`Thumbnail generation queue full, skipping: ${outputFilename}`);
        return null;
    }

    generatingThumbnails.add(outputFilename);

    try {
        const videoUrl = await getSignedVideoUrl(videoKey, 300); // 5 min expiry
        if (!videoUrl) return null;


        return new Promise((resolve) => {
            console.log(`Generating thumbnail for: ${outputFilename}`);
            ffmpeg(videoUrl)
                .screenshots({
                    timestamps: ['20%'], // Take shot at 20% mark
                    filename: outputFilename,
                    folder: THUMBNAIL_DIR,
                    size: '320x180' // Standard thumbnail size
                })
                .on('end', () => {
                    console.log(`Thumbnail generated: ${outputFilename}`);
                    resolve(publicPath);
                })
                .on('error', (err) => {
                    console.error(`Error generating thumbnail for ${outputFilename}:`, err.message);
                    resolve(null);
                });
        });
    } catch (error) {
        console.error(`Error in generateThumbnail wrapper for ${outputFilename}:`, error.message);
        return null;
    } finally {
        generatingThumbnails.delete(outputFilename);
    }
}

// --- Filename Parsing ---

const extractTitleAndEpisode = (filename) => {
    const baseName = path.parse(filename).name;

    // Try pattern: SeriesName--EpisodeNumber (e.g., "ReZero--22_720p" or "ReZero--25_End_720p")
    let match = baseName.match(/^(.+?)--(\d+)/);
    if (match) {
        return {
            seriesTitle: match[1].replace(/[._]/g, ' ').trim(),
            episodeNumber: parseInt(match[2], 10)
        };
    }

    // Try pattern: SeriesName E/EP/Episode Number (e.g., "ReZero E22" or "ReZero-Episode-22")
    match = baseName.match(/(.+?)[-._ ](?:E|EP|Episode)[-._ ]?(\d+)/i);
    if (match) {
        return {
            seriesTitle: match[1].replace(/[._]/g, ' ').trim(),
            episodeNumber: parseInt(match[2], 10)
        };
    }

    // Fallback: use entire basename as series title
    return { seriesTitle: baseName.replace(/[._]/g, ' ').trim(), episodeNumber: null };
};

// --- Get Video Details ---

const getVideoDetails = async (videoFile, metadata) => {
    const { filename, key, lastModified } = videoFile;
    const fileMtime = new Date(lastModified).toISOString().replace('T', ' ').substring(0, 19);

    let fileMetadata = metadata[filename] || {};
    let { display_title, episode_number, series_title, description } = fileMetadata;
    description = description || "No description available.";

    let metadataUpdated = false;
    if (!display_title || !series_title) {
        const extracted = extractTitleAndEpisode(filename);
        if (!series_title) { series_title = extracted.seriesTitle; metadataUpdated = true; }
        if (!display_title) { display_title = extracted.seriesTitle; metadataUpdated = true; }
        if (episode_number === undefined || episode_number === null) {
            episode_number = extracted.episodeNumber;
            metadataUpdated = true;
        }
    }

    if (metadataUpdated) {
        metadata[filename] = { display_title, episode_number, series_title, description };
        saveMetadata(metadata);
    }

    const videoUrl = await getSignedVideoUrl(key);

    // Check for existing thumbnails (both .png and .jpg)
    const baseFilename = filename.replace(/\.[^/.]+$/, "");
    let thumbnailUrl = null;

    const pngPath = path.join(THUMBNAIL_DIR, `${baseFilename}.png`);
    const jpgPath = path.join(THUMBNAIL_DIR, `${baseFilename}.jpg`);

    if (fs.existsSync(pngPath)) {
        thumbnailUrl = `/thumbnails/${baseFilename}.png`;
    } else if (fs.existsSync(jpgPath)) {
        thumbnailUrl = `/thumbnails/${baseFilename}.jpg`;
    } else {
        // Lazy thumbnail generation: generate once on first access (fire-and-forget)
        // This runs in background and doesn't block the response
        generateThumbnail(key, `${baseFilename}.png`).then(generatedUrl => {
            if (generatedUrl) {
                console.log(`[Thumbnail] Generated for: ${baseFilename}`);
            }
        }).catch(err => {
            console.error(`[Thumbnail] Error generating for ${baseFilename}:`, err.message);
        });
    }

    return {
        filename,
        url: videoUrl || `/video/${filename}`,
        thumbnail_url: thumbnailUrl,
        last_modified: fileMtime,
        display_title,
        episode_number,
        series_title,
        description
    };
};

// --- API Routes ---

// Combined app config endpoint
app.get('/api/app_config', (req, res) => {
    const config = loadAdminConfig();

    // Filter out expired notifications
    const now = new Date();
    const activeNotifications = (config.notifications || []).filter(n => {
        if (!n.enabled) return false;
        if (n.expires && new Date(n.expires) < now) return false;
        return true;
    });

    res.json({
        app_version: config.app_version,
        update_dialog: config.update_dialog,
        notifications: activeNotifications,
        maintenance: config.maintenance
    });
});

// Notifications endpoint
app.get('/api/notifications', (req, res) => {
    const config = loadAdminConfig();
    const now = new Date();

    const activeNotifications = (config.notifications || []).filter(n => {
        if (!n.enabled) return false;
        if (n.expires && new Date(n.expires) < now) return false;
        return true;
    });

    res.json(activeNotifications);
});

// Update dialog endpoint
app.get('/api/update_dialog', (req, res) => {
    const config = loadAdminConfig();
    res.json(config.update_dialog);
});

// Legacy endpoints (backward compatibility)
app.get('/api/app_version', (req, res) => {
    const config = loadAdminConfig();
    res.json({ latest_version: config.app_version.latest });
});

app.get('/api/show_update_dialog_command', (req, res) => {
    const config = loadAdminConfig();
    res.json({ show_dialog: config.update_dialog.enabled });
});

app.get('/health', (req, res) => {
    const config = loadAdminConfig();
    res.json({
        status: config.maintenance.enabled ? 'maintenance' : 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: config.app_version.latest,
        r2_bucket: R2_BUCKET_NAME,
        maintenance: config.maintenance.enabled,
        online_users: activeSessions.size
    });
});

// --- User Activity Endpoints ---

// Heartbeat - client sends this every 30 seconds to stay online
app.post('/api/heartbeat', (req, res) => {
    const { device_id, platform, app_version, event, details } = req.body;

    if (!device_id) {
        return res.status(400).json({ error: 'device_id is required' });
    }

    const now = new Date();
    const isNewSession = !activeSessions.has(device_id);

    // Update or create session
    const session = activeSessions.get(device_id) || {
        deviceId: device_id,
        platform: platform || 'unknown',
        appVersion: app_version || 'unknown',
        firstSeen: now.toISOString(),
        currentActivity: null,
        currentVideo: null
    };

    session.lastSeen = now.toISOString();
    session.platform = platform || session.platform;
    session.appVersion = app_version || session.appVersion;

    // Track video watching
    if (event === 'video_play' && details?.video) {
        session.currentActivity = 'watching';
        session.currentVideo = details.video;
    } else if (event === 'video_pause' || event === 'video_stop') {
        session.currentActivity = 'browsing';
        session.currentVideo = null;
    } else if (event === 'app_open' || event === 'app_resume') {
        session.currentActivity = 'browsing';
    } else if (event === 'app_background') {
        session.currentActivity = 'background';
    }

    activeSessions.set(device_id, session);

    // Log activity event
    if (event) {
        logActivity(device_id, event, details || {});
    } else if (isNewSession) {
        logActivity(device_id, 'session_start', { platform, app_version });
        dailyStats.total_sessions++;
        dailyStats.unique_devices.add(device_id);
    }

    updateDailyStats();

    res.json({
        success: true,
        server_time: now.toISOString(),
        session_active: true
    });
});

// Clean up inactive sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [deviceId, session] of activeSessions.entries()) {
        if (now - new Date(session.lastSeen).getTime() > SESSION_TIMEOUT_MS) {
            logActivity(deviceId, 'session_timeout', {});
            activeSessions.delete(deviceId);
        }
    }
}, 60000); // Check every minute

// --- Admin Monitoring Endpoints ---

// Get online users list
app.get('/api/admin/users/online', adminAuth, (req, res) => {
    const now = Date.now();
    const users = [];

    for (const [deviceId, session] of activeSessions.entries()) {
        const onlineDuration = Math.floor((now - new Date(session.firstSeen).getTime()) / 60000);
        users.push({
            device_id: deviceId,
            platform: session.platform,
            app_version: session.appVersion,
            last_seen: session.lastSeen,
            first_seen: session.firstSeen,
            online_duration_minutes: onlineDuration,
            current_activity: session.currentActivity || 'idle',
            current_video: session.currentVideo
        });
    }

    // Sort by last seen (most recent first)
    users.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

    res.json({
        online_count: users.length,
        users
    });
});

// Get user statistics
app.get('/api/admin/users/stats', adminAuth, (req, res) => {
    const platformBreakdown = {};
    const versionBreakdown = {};
    let watchingCount = 0;

    for (const session of activeSessions.values()) {
        platformBreakdown[session.platform] = (platformBreakdown[session.platform] || 0) + 1;
        versionBreakdown[session.appVersion] = (versionBreakdown[session.appVersion] || 0) + 1;
        if (session.currentActivity === 'watching') {
            watchingCount++;
        }
    }

    res.json({
        current_online: activeSessions.size,
        currently_watching: watchingCount,
        peak_today: dailyStats.peak_online,
        total_sessions_today: dailyStats.total_sessions,
        unique_devices_today: dailyStats.unique_devices.size,
        platform_breakdown: platformBreakdown,
        version_breakdown: versionBreakdown,
        date: dailyStats.date
    });
});

// Get activity log
app.get('/api/admin/activity/log', adminAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const eventFilter = req.query.event; // Optional filter by event type

    let filtered = activityLog;
    if (eventFilter) {
        filtered = activityLog.filter(a => a.event === eventFilter);
    }

    res.json({
        total: activityLog.length,
        showing: Math.min(limit, filtered.length),
        activities: filtered.slice(0, limit)
    });
});

// --- Admin Config Management ---

// Get current admin config
app.get('/api/admin/config', adminAuth, (req, res) => {
    res.json(loadAdminConfig());
});

// Update admin config
app.post('/api/admin/config', adminAuth, (req, res) => {
    try {
        const currentConfig = loadAdminConfig();
        const updatedConfig = { ...currentConfig, ...req.body };
        fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(updatedConfig, null, 2));
        res.json({ success: true, config: updatedConfig });
    } catch (error) {
        console.error('Error saving admin config:', error.message);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// --- Admin Dashboard UI ---

// Admin Login Page
app.get('/admin', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>InuPoi Admin Login</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .login-container {
                background: rgba(255, 255, 255, 0.05);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 40px;
                width: 100%;
                max-width: 400px;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }
            h1 {
                color: #fff;
                text-align: center;
                margin-bottom: 10px;
                font-size: 28px;
            }
            .subtitle {
                color: #888;
                text-align: center;
                margin-bottom: 30px;
            }
            .form-group {
                margin-bottom: 20px;
            }
            label {
                display: block;
                color: #aaa;
                margin-bottom: 8px;
                font-size: 14px;
            }
            input {
                width: 100%;
                padding: 14px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 10px;
                background: rgba(0, 0, 0, 0.3);
                color: #fff;
                font-size: 16px;
                transition: border-color 0.3s;
            }
            input:focus {
                outline: none;
                border-color: #4CAF50;
            }
            button {
                width: 100%;
                padding: 14px;
                background: linear-gradient(135deg, #4CAF50, #45a049);
                border: none;
                border-radius: 10px;
                color: #fff;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                transition: transform 0.2s, box-shadow 0.2s;
            }
            button:hover {
                transform: translateY(-2px);
                box-shadow: 0 5px 20px rgba(76, 175, 80, 0.4);
            }
            .error {
                background: rgba(244, 67, 54, 0.2);
                border: 1px solid #f44336;
                color: #f44336;
                padding: 12px;
                border-radius: 8px;
                margin-bottom: 20px;
                text-align: center;
                display: none;
            }
            .logo { font-size: 48px; text-align: center; margin-bottom: 10px; }
        </style>
    </head>
    <body>
        <div class="login-container">
            <div class="logo">🎬</div>
            <h1>InuPoi Admin</h1>
            <p class="subtitle">Enter your admin API key to continue</p>
            <div class="error" id="error"></div>
            <form id="loginForm">
                <div class="form-group">
                    <label for="apiKey">Admin API Key</label>
                    <input type="password" id="apiKey" placeholder="Enter your API key" required>
                </div>
                <button type="submit">Login</button>
            </form>
        </div>
        <script>
            document.getElementById('loginForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const apiKey = document.getElementById('apiKey').value;
                const errorDiv = document.getElementById('error');
                
                try {
                    const res = await fetch('/api/admin/config?api_key=' + encodeURIComponent(apiKey));
                    if (res.ok) {
                        sessionStorage.setItem('adminApiKey', apiKey);
                        window.location.href = '/admin/dashboard';
                    } else {
                        errorDiv.textContent = 'Invalid API key';
                        errorDiv.style.display = 'block';
                    }
                } catch (err) {
                    errorDiv.textContent = 'Connection error';
                    errorDiv.style.display = 'block';
                }
            });
        </script>
    </body>
    </html>
    `);
});

// Admin Dashboard Page
app.get('/admin/dashboard', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>InuPoi Admin Dashboard</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: #0f0f1a;
                color: #fff;
                min-height: 100vh;
            }
            .header {
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                padding: 20px 30px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .header h1 { font-size: 24px; }
            .header .status { display: flex; gap: 20px; align-items: center; }
            .online-badge {
                background: #4CAF50;
                padding: 8px 16px;
                border-radius: 20px;
                font-weight: 600;
                font-size: 14px;
            }
            .logout-btn {
                background: rgba(244, 67, 54, 0.2);
                border: 1px solid #f44336;
                color: #f44336;
                padding: 8px 16px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
            }
            .container { padding: 30px; max-width: 1400px; margin: 0 auto; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px; }
            .card {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 16px;
                padding: 24px;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .card h2 {
                font-size: 16px;
                color: #888;
                margin-bottom: 16px;
                text-transform: uppercase;
                letter-spacing: 1px;
            }
            .stat-value { font-size: 48px; font-weight: 700; color: #4CAF50; }
            .stat-label { color: #666; margin-top: 5px; }
            .form-group { margin-bottom: 16px; }
            .form-group label { display: block; color: #aaa; margin-bottom: 6px; font-size: 14px; }
            .form-group input, .form-group textarea, .form-group select {
                width: 100%;
                padding: 12px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 8px;
                background: rgba(0, 0, 0, 0.3);
                color: #fff;
                font-size: 14px;
            }
            .form-group textarea { min-height: 80px; resize: vertical; }
            .toggle {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .toggle input[type="checkbox"] {
                width: 50px;
                height: 26px;
                appearance: none;
                background: #333;
                border-radius: 13px;
                position: relative;
                cursor: pointer;
            }
            .toggle input[type="checkbox"]::before {
                content: '';
                position: absolute;
                width: 22px;
                height: 22px;
                background: #fff;
                border-radius: 50%;
                top: 2px;
                left: 2px;
                transition: 0.3s;
            }
            .toggle input[type="checkbox"]:checked {
                background: #4CAF50;
            }
            .toggle input[type="checkbox"]:checked::before {
                left: 26px;
            }
            .btn {
                padding: 12px 24px;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                transition: transform 0.2s;
            }
            .btn:hover { transform: translateY(-2px); }
            .btn-primary { background: #4CAF50; color: #fff; }
            .btn-danger { background: #f44336; color: #fff; }
            .user-list { max-height: 400px; overflow-y: auto; }
            .user-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                margin-bottom: 8px;
            }
            .user-info { flex: 1; }
            .user-id { font-family: monospace; font-size: 12px; color: #888; }
            .user-activity {
                padding: 4px 10px;
                border-radius: 12px;
                font-size: 12px;
                font-weight: 600;
            }
            .activity-watching { background: #4CAF50; color: #fff; }
            .activity-browsing { background: #2196F3; color: #fff; }
            .activity-idle { background: #666; color: #fff; }
            .toast {
                position: fixed;
                bottom: 20px;
                right: 20px;
                padding: 16px 24px;
                border-radius: 8px;
                color: #fff;
                font-weight: 600;
                z-index: 1000;
                animation: slideIn 0.3s ease;
            }
            .toast-success { background: #4CAF50; }
            .toast-error { background: #f44336; }
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            .section-title {
                font-size: 20px;
                margin-bottom: 20px;
                padding-bottom: 10px;
                border-bottom: 1px solid rgba(255,255,255,0.1);
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🎬 InuPoi Admin Dashboard</h1>
            <div class="status">
                <div class="online-badge" id="onlineCount">0 Online</div>
                <button class="logout-btn" onclick="logout()">Logout</button>
            </div>
        </div>
        
        <div class="container">
            <!-- Stats Grid -->
            <div class="grid">
                <div class="card">
                    <h2>Current Online</h2>
                    <div class="stat-value" id="statOnline">0</div>
                    <div class="stat-label">Active users right now</div>
                </div>
                <div class="card">
                    <h2>Watching Videos</h2>
                    <div class="stat-value" id="statWatching">0</div>
                    <div class="stat-label">Currently streaming</div>
                </div>
                <div class="card">
                    <h2>Peak Today</h2>
                    <div class="stat-value" id="statPeak">0</div>
                    <div class="stat-label">Maximum concurrent users</div>
                </div>
                <div class="card">
                    <h2>Total Videos</h2>
                    <div class="stat-value" id="statVideos">0</div>
                    <div class="stat-label">In R2 bucket</div>
                </div>
            </div>

            <!-- Config Section -->
            <h2 class="section-title">⚙️ App Configuration</h2>
            <div class="grid">
                <div class="card">
                    <h2>App Version</h2>
                    <div class="form-group">
                        <label>Latest Version</label>
                        <input type="text" id="latestVersion" placeholder="1.0.3">
                    </div>
                    <div class="form-group">
                        <label>Minimum Version</label>
                        <input type="text" id="minimumVersion" placeholder="1.0.0">
                    </div>
                    <div class="form-group toggle">
                        <input type="checkbox" id="forceUpdate">
                        <label>Force Update</label>
                    </div>
                </div>

                <div class="card">
                    <h2>Update Dialog</h2>
                    <div class="form-group toggle">
                        <input type="checkbox" id="updateEnabled">
                        <label>Show Update Dialog</label>
                    </div>
                    <div class="form-group">
                        <label>Title</label>
                        <input type="text" id="updateTitle" placeholder="Update Available">
                    </div>
                    <div class="form-group">
                        <label>Message</label>
                        <textarea id="updateMessage" placeholder="A new version is available!"></textarea>
                    </div>
                    <div class="form-group">
                        <label>Update URL</label>
                        <input type="text" id="updateUrl" placeholder="https://...">
                    </div>
                </div>

                <div class="card">
                    <h2>Maintenance Mode</h2>
                    <div class="form-group toggle">
                        <input type="checkbox" id="maintenanceEnabled">
                        <label>Enable Maintenance</label>
                    </div>
                    <div class="form-group">
                        <label>Maintenance Message</label>
                        <textarea id="maintenanceMessage" placeholder="Server is under maintenance..."></textarea>
                    </div>
                </div>
            </div>

            <button class="btn btn-primary" onclick="saveConfig()" style="margin-bottom: 30px;">💾 Save Configuration</button>

            <!-- Online Users Section -->
            <h2 class="section-title">👥 Online Users</h2>
            <div class="card">
                <div class="user-list" id="userList">
                    <p style="color: #666;">Loading users...</p>
                </div>
            </div>
        </div>

        <script>
            const apiKey = sessionStorage.getItem('adminApiKey');
            if (!apiKey) {
                window.location.href = '/admin';
            }

            function api(endpoint) {
                return fetch(endpoint + (endpoint.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(apiKey));
            }

            function apiPost(endpoint, data) {
                return fetch(endpoint + '?api_key=' + encodeURIComponent(apiKey), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
            }

            function showToast(message, type = 'success') {
                const toast = document.createElement('div');
                toast.className = 'toast toast-' + type;
                toast.textContent = message;
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 3000);
            }

            function logout() {
                sessionStorage.removeItem('adminApiKey');
                window.location.href = '/admin';
            }

            async function loadStats() {
                try {
                    const [statsRes, videosRes] = await Promise.all([
                        api('/api/admin/users/stats'),
                        api('/api/videos')
                    ]);
                    const stats = await statsRes.json();
                    const videos = await videosRes.json();

                    document.getElementById('statOnline').textContent = stats.current_online;
                    document.getElementById('statWatching').textContent = stats.currently_watching;
                    document.getElementById('statPeak').textContent = stats.peak_today;
                    document.getElementById('statVideos').textContent = videos.length;
                    document.getElementById('onlineCount').textContent = stats.current_online + ' Online';
                } catch (err) {
                    console.error('Failed to load stats:', err);
                }
            }

            async function loadConfig() {
                try {
                    const res = await api('/api/admin/config');
                    const config = await res.json();

                    document.getElementById('latestVersion').value = config.app_version?.latest || '';
                    document.getElementById('minimumVersion').value = config.app_version?.minimum || '';
                    document.getElementById('forceUpdate').checked = config.app_version?.force_update || false;

                    document.getElementById('updateEnabled').checked = config.update_dialog?.enabled || false;
                    document.getElementById('updateTitle').value = config.update_dialog?.title || '';
                    document.getElementById('updateMessage').value = config.update_dialog?.message || '';
                    document.getElementById('updateUrl').value = config.update_dialog?.update_url || '';

                    document.getElementById('maintenanceEnabled').checked = config.maintenance?.enabled || false;
                    document.getElementById('maintenanceMessage').value = config.maintenance?.message || '';
                } catch (err) {
                    console.error('Failed to load config:', err);
                }
            }

            async function saveConfig() {
                const config = {
                    app_version: {
                        latest: document.getElementById('latestVersion').value,
                        minimum: document.getElementById('minimumVersion').value,
                        force_update: document.getElementById('forceUpdate').checked
                    },
                    update_dialog: {
                        enabled: document.getElementById('updateEnabled').checked,
                        title: document.getElementById('updateTitle').value,
                        message: document.getElementById('updateMessage').value,
                        update_url: document.getElementById('updateUrl').value
                    },
                    maintenance: {
                        enabled: document.getElementById('maintenanceEnabled').checked,
                        message: document.getElementById('maintenanceMessage').value
                    }
                };

                try {
                    const res = await apiPost('/api/admin/config', config);
                    if (res.ok) {
                        showToast('Configuration saved successfully!');
                    } else {
                        showToast('Failed to save configuration', 'error');
                    }
                } catch (err) {
                    showToast('Error saving configuration', 'error');
                }
            }

            async function loadUsers() {
                try {
                    const res = await api('/api/admin/users/online');
                    const data = await res.json();
                    const userList = document.getElementById('userList');

                    if (data.users.length === 0) {
                        userList.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No users online</p>';
                        return;
                    }

                    userList.innerHTML = data.users.map(user => {
                        const activityClass = user.current_activity === 'watching' ? 'activity-watching' :
                                            user.current_activity === 'browsing' ? 'activity-browsing' : 'activity-idle';
                        return \`
                            <div class="user-item">
                                <div class="user-info">
                                    <strong>\${user.platform || 'Unknown'}</strong> • v\${user.app_version || '?'}
                                    <div class="user-id">\${user.device_id.substring(0, 20)}...</div>
                                    \${user.current_video ? '<div style="color: #4CAF50; font-size: 12px;">📺 ' + user.current_video + '</div>' : ''}
                                </div>
                                <span class="user-activity \${activityClass}">\${user.current_activity || 'idle'}</span>
                            </div>
                        \`;
                    }).join('');
                } catch (err) {
                    console.error('Failed to load users:', err);
                }
            }

            // Initial load
            loadStats();
            loadConfig();
            loadUsers();

            // Auto-refresh every 10 seconds
            setInterval(() => {
                loadStats();
                loadUsers();
            }, 10000);
        </script>
    </body>
    </html>
    `);
});

app.get('/', async (req, res) => {
    const videoFiles = await listR2Videos();

    if (videoFiles.length === 0) {
        return res.status(404).send("No videos found in R2 bucket.");
    }

    videoFiles.sort((a, b) => b.lastModified - a.lastModified);

    const fileListItems = videoFiles.map((file, index) => `
        <li>
          <strong>${index + 1}.</strong>
          <a href="/video/${file.filename}">${file.filename}</a>
          <br><small>Last Modified: ${file.lastModified.toISOString().replace('T', ' ').substring(0, 19)}</small>
        </li>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Available Videos</title>
        <style>
            body { font-family: sans-serif; background-color: #1a1a1a; color: #f0f0f0; margin: 20px; }
            h1 { color: #e0e0e0; }
            ul { list-style: none; padding: 0; }
            li { background-color: #2a2a2a; margin-bottom: 10px; padding: 10px; border-radius: 8px; }
            a { color: #4CAF50; text-decoration: none; }
            small { color: #888; }
        </style>
    </head>
    <body>
        <h1>Available Videos (from R2)</h1>
        <ul>${fileListItems}</ul>
    </body>
    </html>
    `);
});

app.get('/api/videos', async (req, res) => {
    const metadata = loadMetadata();
    const videoFiles = await listR2Videos();

    let allVideosData = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(Boolean);

    const { series_title } = req.query;
    if (series_title) {
        allVideosData = allVideosData.filter(v =>
            v.series_title && v.series_title.toLowerCase() === series_title.toLowerCase()
        );
        // Sort by episode number for series view
        allVideosData.sort((a, b) => {
            const epA = a.episode_number !== null ? a.episode_number : Infinity;
            const epB = b.episode_number !== null ? b.episode_number : Infinity;
            return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
        });
    } else {
        // Sort by last_modified for general list
        allVideosData.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    }

    res.json(allVideosData);
});

app.get('/api/series', async (req, res) => {
    const metadata = loadMetadata();
    const seriesInfo = new Map();
    const videoFiles = await listR2Videos();

    const allVideoDetails = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(Boolean);

    for (const video of allVideoDetails) {
        if (video && video.series_title) {
            const { series_title, last_modified, description, thumbnail_url, episode_number } = video;
            if (!seriesInfo.has(series_title)) {
                seriesInfo.set(series_title, {
                    count: 0,
                    last_modified: '1970-01-01 00:00:00',
                    description: "No description available.",
                    thumbnail_url: null,
                    first_episode: Infinity
                });
            }

            const currentSeries = seriesInfo.get(series_title);
            currentSeries.count++;

            // Use thumbnail from the lowest episode number (first episode) as series cover
            const epNum = episode_number !== null ? episode_number : Infinity;
            if (epNum < currentSeries.first_episode && thumbnail_url) {
                currentSeries.thumbnail_url = thumbnail_url;
                currentSeries.first_episode = epNum;
            }

            if (new Date(last_modified) > new Date(currentSeries.last_modified)) {
                currentSeries.last_modified = last_modified;
                currentSeries.description = description;
            }
        }
    }

    let result = Array.from(seriesInfo.entries()).map(([title, info]) => ({
        series_title: title,
        video_count: info.count,
        thumbnail_url: info.thumbnail_url,
        last_modified: info.last_modified,
        description: info.description
    }));

    result.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

    res.json(result);
});

app.get('/api/series/:series_title', async (req, res) => {
    const { series_title } = req.params;
    const metadata = loadMetadata();
    const videoFiles = await listR2Videos();

    let seriesVideosData = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(v =>
        v && v.series_title && v.series_title.toLowerCase() === series_title.toLowerCase()
    );

    seriesVideosData.sort((a, b) => {
        const epA = a.episode_number !== null ? a.episode_number : Infinity;
        const epB = b.episode_number !== null ? b.episode_number : Infinity;
        return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
    });

    res.json(seriesVideosData);
});

app.get('/api/search',
    query('q').optional().isString().trim().escape(),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const searchQuery = (req.query.q || '').toLowerCase();
            const metadata = loadMetadata();
            const videoFiles = await listR2Videos();

            const allVideoDetails = (await Promise.all(
                videoFiles.map(file => getVideoDetails(file, metadata))
            )).filter(Boolean);

            const filteredVideos = allVideoDetails.filter(video => {
                const searchText = `${video.filename} ${video.display_title} ${video.series_title} ${video.description}`.toLowerCase();
                return searchText.includes(searchQuery);
            });

            filteredVideos.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
            res.json(filteredVideos);
        } catch (error) {
            next(error);
        }
    });

// --- Video Streaming Route ---

app.get('/video/:filename', async (req, res) => {
    const { filename } = req.params;
    const videoFiles = await listR2Videos();
    const videoFile = videoFiles.find(f => f.filename === filename);

    if (!videoFile) {
        return res.status(404).send('File not found');
    }

    if (R2_PUBLIC_URL) {
        return res.redirect(`${R2_PUBLIC_URL}/${videoFile.key}`);
    }

    try {
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: videoFile.key,
        });

        const response = await s3Client.send(command);
        const contentLength = response.ContentLength;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : contentLength - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${contentLength}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            });

            const rangeCommand = new GetObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: videoFile.key,
                Range: `bytes=${start}-${end}`
            });
            const rangeResponse = await s3Client.send(rangeCommand);
            rangeResponse.Body.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': contentLength,
                'Content-Type': 'video/mp4',
            });
            response.Body.pipe(res);
        }
    } catch (error) {
        console.error('Error streaming video:', error.message);
        res.status(500).send('Error streaming video');
    }
});

// --- Error Handlers ---

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(err.status || 500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// --- Start Server ---

app.listen(PORT, HOST, () => {
    console.log(` Server is running at http://${HOST}:${PORT}`);
    console.log(` R2 Bucket: ${R2_BUCKET_NAME}`);
    console.log(` R2 Endpoint: https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    console.log(` Health check: http://${HOST}:${PORT}/health`);
});