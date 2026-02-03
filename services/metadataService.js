// services/metadataService.js - Video metadata management

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(process.cwd(), 'cache');
const METADATA_FILE = path.join(CACHE_DIR, 'metadata.json');

// In-memory cache
let metadataCache = null;

/**
 * Load metadata from file (with caching)
 * @returns {Object} Metadata object
 */
function loadMetadata() {
    if (metadataCache) {
        return metadataCache;
    }

    if (fs.existsSync(METADATA_FILE)) {
        try {
            metadataCache = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
            return metadataCache;
        } catch {
            metadataCache = {};
            return metadataCache;
        }
    }
    metadataCache = {};
    return metadataCache;
}

/**
 * Save metadata to file and update cache
 * @param {Object} metadata - Metadata to save
 */
function saveMetadata(metadata) {
    metadataCache = metadata;

    // Ensure cache directory exists
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 4), 'utf-8');
}

/**
 * Update metadata for a specific file
 * @param {string} filename - Video filename
 * @param {Object} data - Metadata to merge
 */
function updateMetadata(filename, data) {
    const metadata = loadMetadata();
    metadata[filename] = { ...metadata[filename], ...data };
    saveMetadata(metadata);
}

/**
 * Invalidate metadata cache
 */
function invalidateCache() {
    metadataCache = null;
}

module.exports = {
    loadMetadata,
    saveMetadata,
    updateMetadata,
    invalidateCache
};
