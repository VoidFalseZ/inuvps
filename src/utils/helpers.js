// src/utils/helpers.js — Shared helper functions

'use strict';

/**
 * Delay execution for specified milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format a Date or ISO string to 'YYYY-MM-DD HH:MM:SS'.
 * @param {Date|string} date
 * @returns {string}
 */
function formatDateTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Check if a timestamp is older than a specified age.
 * @param {string|Date} timestamp
 * @param {number} maxAgeMs — Maximum age in milliseconds
 * @returns {boolean}
 */
function isOlderThan(timestamp, maxAgeMs) {
    return Date.now() - new Date(timestamp).getTime() > maxAgeMs;
}

/**
 * Get today's date as 'YYYY-MM-DD'.
 * @returns {string}
 */
function getTodayString() {
    return new Date().toISOString().split('T')[0];
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;

    const crypto = require('crypto');
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = {
    delay,
    formatDateTime,
    isOlderThan,
    getTodayString,
    timingSafeEqual,
};
