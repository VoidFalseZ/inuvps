// utils/helpers.js - Shared helper functions

/**
 * Delay execution for specified milliseconds
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise} Resolves after delay
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format ISO date to readable string (YYYY-MM-DD HH:MM:SS)
 * @param {Date|string} date - Date to format
 * @returns {string} Formatted date string
 */
function formatDateTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Check if a timestamp is older than specified age
 * @param {string|Date} timestamp - Timestamp to check
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {boolean} True if timestamp is older than maxAge
 */
function isOlderThan(timestamp, maxAgeMs) {
    const time = new Date(timestamp).getTime();
    return Date.now() - time > maxAgeMs;
}

/**
 * Get today's date as YYYY-MM-DD string
 * @returns {string} Today's date
 */
function getTodayString() {
    return new Date().toISOString().split('T')[0];
}

module.exports = {
    delay,
    formatDateTime,
    isOlderThan,
    getTodayString
};
