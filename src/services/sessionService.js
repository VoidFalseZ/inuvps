// src/services/sessionService.js — User activity tracking (async I/O)

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { getTodayString } = require('../utils/helpers');
const { createLogger } = require('../utils/logger');
const { DIRS, DATA_FILES } = require('../constants');

const log = createLogger('Session');

const CACHE_DIR = path.resolve(__dirname, '..', '..', DIRS.CACHE);
const ACTIVITY_LOG_FILE = path.join(CACHE_DIR, DATA_FILES.ACTIVITY_LOG);
const SESSIONS_FILE = path.join(CACHE_DIR, DATA_FILES.SESSIONS);

// ─── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map();
let activityLog = [];
let dailyStats = {
    date: getTodayString(),
    peak_online: 0,
    total_sessions: 0,
    unique_devices: new Set(),
};

let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2000;

// ─── Persistence ─────────────────────────────────────────────────────────────

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
            log.info(`Restored ${activeSessions.size} active sessions`);
        }
    } catch (error) {
        log.error('Failed to load activity data:', error.message);
    }
}

function saveActivityData() {
    if (saveTimer) clearTimeout(saveTimer);

    saveTimer = setTimeout(async () => {
        try {
            await fsp.mkdir(CACHE_DIR, { recursive: true });
            await Promise.all([
                fsp.writeFile(ACTIVITY_LOG_FILE, JSON.stringify(activityLog, null, 2), 'utf8'),
                fsp.writeFile(SESSIONS_FILE, JSON.stringify(Object.fromEntries(activeSessions), null, 2), 'utf8'),
            ]);
            log.debug('Activity data saved');
        } catch (error) {
            log.error('Failed to save activity data:', error.message);
        }
    }, SAVE_DEBOUNCE_MS);
}

async function flush() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        try {
            await Promise.all([
                fsp.writeFile(ACTIVITY_LOG_FILE, JSON.stringify(activityLog, null, 2), 'utf8'),
                fsp.writeFile(SESSIONS_FILE, JSON.stringify(Object.fromEntries(activeSessions), null, 2), 'utf8'),
            ]);
            log.info('Activity data flushed to disk');
        } catch (error) {
            log.error('Flush failed:', error.message);
        }
    }
}

// ─── Activity Logging ────────────────────────────────────────────────────────

function logActivity(deviceId, event, details = {}) {
    activityLog.unshift({
        timestamp: new Date().toISOString(),
        device_id: deviceId,
        event,
        details,
    });
    if (activityLog.length > config.ACTIVITY_LOG_MAX) {
        activityLog = activityLog.slice(0, config.ACTIVITY_LOG_MAX);
    }
}

function updateDailyStats() {
    const today = getTodayString();
    if (dailyStats.date !== today) {
        dailyStats = {
            date: today,
            peak_online: 0,
            total_sessions: 0,
            unique_devices: new Set(),
        };
    }
    const currentOnline = activeSessions.size;
    if (currentOnline > dailyStats.peak_online) {
        dailyStats.peak_online = currentOnline;
    }
}

// ─── Heartbeat Processing ────────────────────────────────────────────────────

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
        currentVideo: null,
    };

    session.lastSeen = now.toISOString();
    session.platform = platform || session.platform;
    session.appVersion = app_version || session.appVersion;

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
    saveActivityData();

    return {
        success: true,
        server_time: now.toISOString(),
        session_active: true,
    };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupInactiveSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [deviceId, session] of activeSessions.entries()) {
        if (now - new Date(session.lastSeen).getTime() > config.SESSION_TIMEOUT_MS) {
            logActivity(deviceId, 'session_timeout', {});
            activeSessions.delete(deviceId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        saveActivityData();
        log.debug(`Cleaned up ${cleaned} inactive sessions`);
    }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

function getOnlineUsers() {
    const now = Date.now();
    const users = [];

    for (const [deviceId, session] of activeSessions.entries()) {
        users.push({
            device_id: deviceId,
            platform: session.platform,
            app_version: session.appVersion,
            last_seen: session.lastSeen,
            first_seen: session.firstSeen,
            online_duration_minutes: Math.floor((now - new Date(session.firstSeen).getTime()) / 60000),
            current_activity: session.currentActivity || 'idle',
            current_video: session.currentVideo,
        });
    }

    users.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

    return { online_count: users.length, users };
}

function getStats() {
    const platformBreakdown = {};
    const versionBreakdown = {};
    let watchingCount = 0;

    for (const session of activeSessions.values()) {
        platformBreakdown[session.platform] = (platformBreakdown[session.platform] || 0) + 1;
        versionBreakdown[session.appVersion] = (versionBreakdown[session.appVersion] || 0) + 1;
        if (session.currentActivity === 'watching') watchingCount++;
    }

    return {
        current_online: activeSessions.size,
        currently_watching: watchingCount,
        peak_today: dailyStats.peak_online,
        total_sessions_today: dailyStats.total_sessions,
        unique_devices_today: dailyStats.unique_devices.size,
        platform_breakdown: platformBreakdown,
        version_breakdown: versionBreakdown,
        date: dailyStats.date,
    };
}

function getActivityLog(limit = 50, eventFilter = null) {
    let filtered = activityLog;
    if (eventFilter) {
        filtered = activityLog.filter(a => a.event === eventFilter);
    }

    return {
        total: activityLog.length,
        showing: Math.min(limit, filtered.length),
        activities: filtered.slice(0, limit),
    };
}

function getOnlineCount() {
    return activeSessions.size;
}

// Load on module init
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
    getOnlineCount,
    flush,
};
