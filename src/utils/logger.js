// src/utils/logger.js — Structured console logger with levels and component tags
// Replaces scattered console.log/error calls with a consistent interface.

'use strict';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Format a log timestamp (ISO without milliseconds for readability).
 * @returns {string}
 */
function timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Create a logger scoped to a component name.
 * @param {string} component — e.g. 'R2', 'Thumbnail', 'HLS', 'Chat'
 * @returns {{ debug, info, warn, error }}
 */
function createLogger(component) {
    const tag = `[${component}]`;

    return {
        debug(...args) {
            if (currentLevel <= LOG_LEVELS.debug) {
                console.debug(`${timestamp()} DEBUG ${tag}`, ...args);
            }
        },

        info(...args) {
            if (currentLevel <= LOG_LEVELS.info) {
                console.log(`${timestamp()}  INFO ${tag}`, ...args);
            }
        },

        warn(...args) {
            if (currentLevel <= LOG_LEVELS.warn) {
                console.warn(`${timestamp()}  WARN ${tag}`, ...args);
            }
        },

        error(...args) {
            if (currentLevel <= LOG_LEVELS.error) {
                console.error(`${timestamp()} ERROR ${tag}`, ...args);
            }
        },
    };
}

module.exports = { createLogger };
