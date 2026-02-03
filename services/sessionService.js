// services/sessionService.js - User activity tracking

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getTodayString } = require('../utils/helpers');

const CACHE_DIR = path.join(process.cwd(), 'cache');
const ACTIVITY_LOG_FILE = path.join(CACHE_DIR, 'activity_log.json');
const SESSIONS_FILE = path.join(CACHE_DIR, 'sessions.json');

// State
const activeSessions = new Map();
let activityLog = [];
let dailyStats = {
    date: getTodayString(),
    peak_online: 0,
    total_sessions: 0,
    unique_devices: new Set()
};

/**
 * Load persisted activity data
 */
function loadActivityData() {
    try {
        if (fs.existsSync(ACTIVITY_LOG_FILE)) {
            activityLog = JSON.parse(fs.readFileSync(ACTIVITY_LOG_FILE, 'utf8'));
        }
        if (fs.existsSync(SESSIONS_FILE)) {
            const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            const now = Date.now();
            for (const [deviceId, session] of Object.entries(sessions)) {
                if (now - new Date(session.lastSeen).getTime() < config.SESSION_TIMEOUT_MS) {
                    activeSessions.set(deviceId, session);
                }
            }
            console.log(`Restored ${activeSessions.size} active sessions`);
        }
    } catch (error) {
        console.error('Error loading activity data:', error.message);
    }
}

/**
 * Save activity data to files
 */
function saveActivityData() {
    try {
        fs.writeFileSync(ACTIVITY_LOG_FILE, JSON.stringify(activityLog, null, 2));
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(activeSessions), null, 2));
    } catch (error) {
        console.error('Error saving activity data:', error.message);
    }
}

/**
 * Log an activity event
 */
function logActivity(deviceId, event, details = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        device_id: deviceId,
        event,
        details
    };
    activityLog.unshift(entry);
    if (activityLog.length > config.ACTIVITY_LOG_MAX) {
        activityLog = activityLog.slice(0, config.ACTIVITY_LOG_MAX);
    }
}

/**
 * Update daily statistics
 */
function updateDailyStats() {
    const today = getTodayString();
    if (dailyStats.date !== today) {
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
}

/**
 * Process a heartbeat from a client
 */
function processHeartbeat(data) {
    const { device_id, platform, app_version, event, details } = data;
    const now = new Date();
    const isNewSession = !activeSessions.has(device_id);

    let session = activeSessions.get(device_id) || {
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

    if (event) {
        logActivity(device_id, event, details || {});
    } else if (isNewSession) {
        logActivity(device_id, 'session_start', { platform, app_version });
        dailyStats.total_sessions++;
        dailyStats.unique_devices.add(device_id);
    }

    updateDailyStats();

    return {
        success: true,
        server_time: now.toISOString(),
        session_active: true
    };
}

/**
 * Clean up inactive sessions
 */
function cleanupInactiveSessions() {
    const now = Date.now();
    for (const [deviceId, session] of activeSessions.entries()) {
        if (now - new Date(session.lastSeen).getTime() > config.SESSION_TIMEOUT_MS) {
            logActivity(deviceId, 'session_timeout', {});
            activeSessions.delete(deviceId);
        }
    }
}

/**
 * Get online users list
 */
function getOnlineUsers() {
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

    users.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

    return {
        online_count: users.length,
        users
    };
}

/**
 * Get user statistics
 */
function getStats() {
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

    return {
        current_online: activeSessions.size,
        currently_watching: watchingCount,
        peak_today: dailyStats.peak_online,
        total_sessions_today: dailyStats.total_sessions,
        unique_devices_today: dailyStats.unique_devices.size,
        platform_breakdown: platformBreakdown,
        version_breakdown: versionBreakdown,
        date: dailyStats.date
    };
}

/**
 * Get activity log
 */
function getActivityLog(limit = 50, eventFilter = null) {
    let filtered = activityLog;
    if (eventFilter) {
        filtered = activityLog.filter(a => a.event === eventFilter);
    }

    return {
        total: activityLog.length,
        showing: Math.min(limit, filtered.length),
        activities: filtered.slice(0, limit)
    };
}

/**
 * Get current online count
 */
function getOnlineCount() {
    return activeSessions.size;
}

// Load data on module init
loadActivityData();

module.exports = {
    loadActivityData,
    saveActivityData,
    logActivity,
    updateDailyStats,
    processHeartbeat,
    cleanupInactiveSessions,
    getOnlineUsers,
    getStats,
    getActivityLog,
    getOnlineCount
};
