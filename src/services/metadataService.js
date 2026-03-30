// src/services/metadataService.js — Video metadata persistence (async I/O)

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createLogger } = require('../utils/logger');
const { DIRS, DATA_FILES } = require('../constants');

const log = createLogger('Metadata');

const CACHE_DIR = path.resolve(__dirname, '..', '..', DIRS.CACHE);
const METADATA_FILE = path.join(CACHE_DIR, DATA_FILES.METADATA);

// ─── In-Memory Cache ─────────────────────────────────────────────────────────

let metadataCache = null;

// Debounce write: if multiple saves happen within 500ms, only the last one is written
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 500;

/**
 * Load metadata from file (with in-memory caching).
 * @returns {Object}
 */
function loadMetadata() {
    if (metadataCache) return metadataCache;

    if (fs.existsSync(METADATA_FILE)) {
        try {
            metadataCache = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
            return metadataCache;
        } catch {
            log.warn('Corrupted metadata file, starting fresh');
            metadataCache = {};
            return metadataCache;
        }
    }

    metadataCache = {};
    return metadataCache;
}

/**
 * Save metadata to file asynchronously (debounced).
 * Updates the in-memory cache immediately, writes to disk after a short delay.
 * @param {Object} metadata
 */
function saveMetadata(metadata) {
    metadataCache = metadata;

    if (saveTimer) clearTimeout(saveTimer);

    saveTimer = setTimeout(async () => {
        try {
            await fsp.mkdir(CACHE_DIR, { recursive: true });
            await fsp.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 4), 'utf-8');
            log.debug('Metadata saved to disk');
        } catch (error) {
            log.error('Failed to save metadata:', error.message);
        }
    }, SAVE_DEBOUNCE_MS);
}

/**
 * Update metadata for a single file (merge).
 * @param {string} filename
 * @param {Object} data
 */
function updateMetadata(filename, data) {
    const metadata = loadMetadata();
    metadata[filename] = { ...metadata[filename], ...data };
    saveMetadata(metadata);
}

/**
 * Flush any pending writes immediately (for graceful shutdown).
 */
async function flush() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        try {
            await fsp.mkdir(CACHE_DIR, { recursive: true });
            if (metadataCache) {
                await fsp.writeFile(METADATA_FILE, JSON.stringify(metadataCache, null, 4), 'utf-8');
                log.info('Metadata flushed to disk');
            }
        } catch (error) {
            log.error('Failed to flush metadata:', error.message);
        }
    }
}

/**
 * Invalidate the in-memory cache.
 */
function invalidateCache() {
    metadataCache = null;
}

module.exports = {
    loadMetadata,
    saveMetadata,
    updateMetadata,
    invalidateCache,
    flush,
};
