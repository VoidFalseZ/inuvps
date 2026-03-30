// src/config/env.js — Environment variable validation
// Validates all required env vars at startup. Fails fast with clear errors.

'use strict';

require('dotenv').config();

/**
 * Read an env var, returning a default if not set.
 * @param {string} key
 * @param {*} defaultValue — if undefined, the var is required
 * @returns {string}
 */
function env(key, defaultValue) {
    const value = process.env[key];
    if (value !== undefined && value !== '') return value;
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${key}`);
}

/**
 * Read an env var as an integer.
 * @param {string} key
 * @param {number} defaultValue
 * @returns {number}
 */
function envInt(key, defaultValue) {
    const raw = env(key, defaultValue !== undefined ? String(defaultValue) : undefined);
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) {
        throw new Error(`Environment variable ${key} must be an integer, got: "${raw}"`);
    }
    return parsed;
}

/**
 * Read an env var as a boolean ('true'/'1' = true, everything else = false).
 * @param {string} key
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function envBool(key, defaultValue = false) {
    const raw = env(key, String(defaultValue));
    return raw === 'true' || raw === '1';
}

module.exports = { env, envInt, envBool };
