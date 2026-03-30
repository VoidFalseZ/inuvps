// src/services/adminConfigService.js — Admin configuration management (async I/O)

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { createLogger } = require('../utils/logger');
const { DIRS, DATA_FILES } = require('../constants');

const log = createLogger('AdminConfig');

const CACHE_DIR = path.resolve(__dirname, '..', '..', DIRS.CACHE);
const ADMIN_CONFIG_FILE = path.join(CACHE_DIR, DATA_FILES.ADMIN_CONFIG);

// ─── In-Memory Cache ─────────────────────────────────────────────────────────

let adminConfigCache = null;

/**
 * Load admin config with in-memory caching.
 * @returns {Object}
 */
function loadConfig() {
    if (adminConfigCache) return adminConfigCache;

    try {
        if (fs.existsSync(ADMIN_CONFIG_FILE)) {
            const data = fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8');
            adminConfigCache = { ...config.DEFAULT_ADMIN_CONFIG, ...JSON.parse(data) };
            return adminConfigCache;
        }
    } catch (error) {
        log.error('Failed to load config:', error.message);
    }

    adminConfigCache = { ...config.DEFAULT_ADMIN_CONFIG };
    return adminConfigCache;
}

/**
 * Save admin config (async) and update the in-memory cache.
 * @param {Object} newConfig
 */
async function saveConfig(newConfig) {
    adminConfigCache = newConfig;

    try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        await fsp.writeFile(ADMIN_CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
        log.info('Config saved');
    } catch (error) {
        log.error('Failed to save config:', error.message);
    }
}

/**
 * Invalidate the in-memory cache.
 */
function invalidateCache() {
    adminConfigCache = null;
}

/**
 * Initialize config file with defaults if it doesn't exist.
 */
function initConfig() {
    if (!fs.existsSync(ADMIN_CONFIG_FILE)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(
            ADMIN_CONFIG_FILE,
            JSON.stringify(config.DEFAULT_ADMIN_CONFIG, null, 2),
            'utf8'
        );
        log.info('Created default admin_config.json');
    }
}

/**
 * Get active (non-expired, enabled) notifications.
 * @returns {Array}
 */
function getActiveNotifications() {
    const adminConfig = loadConfig();
    const now = new Date();

    return (adminConfig.notifications || []).filter(n => {
        if (!n.enabled) return false;
        if (n.expires && new Date(n.expires) < now) return false;
        return true;
    });
}

// Initialize on module load
initConfig();

module.exports = {
    loadConfig,
    saveConfig,
    invalidateCache,
    initConfig,
    getActiveNotifications,
};
