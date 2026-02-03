// services/adminConfigService.js - Admin configuration management

const fs = require('fs');
const path = require('path');
const config = require('../config');

const CACHE_DIR = path.join(process.cwd(), 'cache');
const ADMIN_CONFIG_FILE = path.join(CACHE_DIR, 'admin_config.json');

// In-memory cache
let adminConfigCache = null;

/**
 * Load admin config with caching
 * @returns {Object} Admin config object
 */
function loadConfig() {
    if (adminConfigCache) {
        return adminConfigCache;
    }

    try {
        if (fs.existsSync(ADMIN_CONFIG_FILE)) {
            const data = fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8');
            adminConfigCache = { ...config.DEFAULT_ADMIN_CONFIG, ...JSON.parse(data) };
            return adminConfigCache;
        }
    } catch (error) {
        console.error('Error loading admin config:', error.message);
    }

    adminConfigCache = config.DEFAULT_ADMIN_CONFIG;
    return adminConfigCache;
}

/**
 * Save admin config and update cache
 * @param {Object} newConfig - Config to save
 */
function saveConfig(newConfig) {
    adminConfigCache = newConfig;

    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(newConfig, null, 2));
}

/**
 * Invalidate admin config cache
 */
function invalidateCache() {
    adminConfigCache = null;
}

/**
 * Initialize default config if not exists
 */
function initConfig() {
    if (!fs.existsSync(ADMIN_CONFIG_FILE)) {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(config.DEFAULT_ADMIN_CONFIG, null, 2));
        console.log('Created default admin_config.json');
    }
}

/**
 * Get active notifications (filtering expired ones)
 * @returns {Array} Active notifications
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
    getActiveNotifications
};
