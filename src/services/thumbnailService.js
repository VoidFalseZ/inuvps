// src/services/thumbnailService.js — Thumbnail generation with queue, retry, and cache

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const r2Service = require('./r2Service');
const { delay } = require('../utils/helpers');
const { getBaseFilename } = require('../utils/fileParser');
const { ffmpeg } = require('../utils/ffmpeg');
const { createLogger } = require('../utils/logger');
const { DIRS, THUMBNAIL_EXTENSIONS } = require('../constants');

const log = createLogger('Thumbnail');

// ─── Directories ─────────────────────────────────────────────────────────────

const THUMBNAIL_DIR = path.resolve(__dirname, '..', '..', DIRS.THUMBNAILS);
fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

// ─── State ───────────────────────────────────────────────────────────────────

const generatingThumbnails = new Set();
const failedThumbnails = new Map();
const thumbnailQueue = [];
let isProcessingQueue = false;

// In-memory URL cache: baseFilename → { url, cachedAt }
const thumbnailCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function setCacheEntry(baseFilename, url) {
    thumbnailCache.set(baseFilename, { url, cachedAt: Date.now() });
}

/**
 * Warm the thumbnail URL cache from disk on startup.
 */
function warmCache() {
    try {
        const files = fs.readdirSync(THUMBNAIL_DIR);
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (!THUMBNAIL_EXTENSIONS.includes(ext)) continue;
            const baseFilename = path.basename(file, ext);
            const filePath = path.join(THUMBNAIL_DIR, file);
            const mtime = Math.floor(fs.statSync(filePath).mtimeMs);
            setCacheEntry(baseFilename, `/thumbnails/${file}?v=${mtime}`);
        }
        log.info(`Warmed cache with ${thumbnailCache.size} entries`);
    } catch (err) {
        log.error('Warm failed:', err.message);
    }
}

// Warm on module load
warmCache();

// ─── Retry Logic ─────────────────────────────────────────────────────────────

function canRetryThumbnail(filename) {
    const failed = failedThumbnails.get(filename);
    if (!failed) return true;

    if (Date.now() - failed.lastAttempt > config.THUMBNAIL.FAILED_COOLDOWN_MS) {
        failedThumbnails.delete(filename);
        return true;
    }

    return failed.attempts < config.THUMBNAIL.MAX_RETRY_ATTEMPTS;
}

// ─── Generation ──────────────────────────────────────────────────────────────

function generateThumbnailAttempt(videoUrl, outputFilename, attemptNum) {
    const outputPath = path.join(THUMBNAIL_DIR, outputFilename);
    const baseFilename = path.basename(outputFilename, path.extname(outputFilename));

    return new Promise((resolve, reject) => {
        log.info(`Attempt ${attemptNum}/${config.THUMBNAIL.MAX_RETRY_ATTEMPTS} for: ${outputFilename}`);

        ffmpeg(videoUrl)
            .on('end', () => {
                log.info(`Generated: ${outputFilename}`);
                const mtime = Math.floor(fs.statSync(outputPath).mtimeMs);
                const url = `/thumbnails/${outputFilename}?v=${mtime}`;
                setCacheEntry(baseFilename, url);
                resolve(url);
            })
            .on('error', (err) => {
                log.error(`Attempt ${attemptNum} failed for ${outputFilename}:`, err.message);
                reject(err);
            })
            .inputOptions(['-ss 30', '-t 1'])
            .outputOptions(['-vframes 1', '-q:v 2', '-vf scale=320:180'])
            .output(outputPath)
            .run();
    });
}

async function generateThumbnail(videoKey, outputFilename) {
    const outputPath = path.join(THUMBNAIL_DIR, outputFilename);

    if (fs.existsSync(outputPath)) {
        return `/thumbnails/${outputFilename}`;
    }

    if (!canRetryThumbnail(outputFilename)) {
        const failed = failedThumbnails.get(outputFilename);
        log.debug(`Skipping ${outputFilename} — in cooldown (${failed.attempts} failures)`);
        return null;
    }

    if (generatingThumbnails.has(outputFilename)) {
        log.debug(`Already in progress: ${outputFilename}`);
        return null;
    }

    if (generatingThumbnails.size >= config.THUMBNAIL.MAX_CONCURRENT) {
        if (!thumbnailQueue.some(job => job.outputFilename === outputFilename)) {
            thumbnailQueue.push({ videoKey, outputFilename });
            log.debug(`Queued: ${outputFilename} (queue size: ${thumbnailQueue.length})`);
        }
        return null;
    }

    generatingThumbnails.add(outputFilename);

    try {
        const videoUrl = await r2Service.getSignedVideoUrl(videoKey, 600);
        if (!videoUrl) {
            log.error(`Failed to get signed URL for: ${outputFilename}`);
            return null;
        }

        const existingFailed = failedThumbnails.get(outputFilename);
        const startAttempt = existingFailed ? existingFailed.attempts + 1 : 1;
        let lastError = null;

        for (let attempt = startAttempt; attempt <= config.THUMBNAIL.MAX_RETRY_ATTEMPTS; attempt++) {
            try {
                const result = await generateThumbnailAttempt(videoUrl, outputFilename, attempt);
                failedThumbnails.delete(outputFilename);
                return result;
            } catch (err) {
                lastError = err;
                failedThumbnails.set(outputFilename, {
                    attempts: attempt,
                    lastAttempt: Date.now(),
                    error: err.message,
                });
                if (attempt < config.THUMBNAIL.MAX_RETRY_ATTEMPTS) {
                    const backoffMs = config.THUMBNAIL.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                    log.info(`Retrying in ${backoffMs}ms...`);
                    await delay(backoffMs);
                }
            }
        }

        log.error(`All attempts failed for ${outputFilename}:`, lastError?.message);
        return null;
    } catch (error) {
        log.error(`Fatal error for ${outputFilename}:`, error.message);
        failedThumbnails.set(outputFilename, {
            attempts: config.THUMBNAIL.MAX_RETRY_ATTEMPTS,
            lastAttempt: Date.now(),
            error: error.message,
        });
        return null;
    } finally {
        generatingThumbnails.delete(outputFilename);
        processQueue();
    }
}

// ─── Queue Processing ────────────────────────────────────────────────────────

async function processQueue() {
    if (isProcessingQueue || thumbnailQueue.length === 0) return;
    if (generatingThumbnails.size >= config.THUMBNAIL.MAX_CONCURRENT) return;

    isProcessingQueue = true;

    while (thumbnailQueue.length > 0 && generatingThumbnails.size < config.THUMBNAIL.MAX_CONCURRENT) {
        const job = thumbnailQueue.shift();
        if (job) {
            generateThumbnail(job.videoKey, job.outputFilename).catch(err => {
                log.error(`Queue error for ${job.outputFilename}:`, err.message);
            });
        }
        await delay(100);
    }

    isProcessingQueue = false;
}

// ─── Status & Admin ──────────────────────────────────────────────────────────

function getStatus() {
    return {
        currently_generating: Array.from(generatingThumbnails),
        queue_size: thumbnailQueue.length,
        queued: thumbnailQueue.map(j => j.outputFilename),
        failed_count: failedThumbnails.size,
        failed: Object.fromEntries(failedThumbnails),
    };
}

function clearFailed(filename = null) {
    if (filename) {
        failedThumbnails.delete(filename);
        return { cleared: filename };
    }
    const count = failedThumbnails.size;
    failedThumbnails.clear();
    return { cleared_count: count };
}

/**
 * Check if a thumbnail exists for a given video filename.
 * Returns the URL (with cache-busting mtime) or null.
 * @param {string} filename
 * @returns {string|null}
 */
function exists(filename) {
    const baseFilename = getBaseFilename(filename);

    // Check in-memory cache
    const cached = thumbnailCache.get(baseFilename);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached.url;
    }

    // Disk check (at most once per 60s per file)
    for (const ext of THUMBNAIL_EXTENSIONS) {
        const filePath = path.join(THUMBNAIL_DIR, `${baseFilename}${ext}`);
        if (fs.existsSync(filePath)) {
            const mtime = Math.floor(fs.statSync(filePath).mtimeMs);
            const url = `/thumbnails/${baseFilename}${ext}?v=${mtime}`;
            setCacheEntry(baseFilename, url);
            return url;
        }
    }

    return null;
}

function deleteThumbnail(filename) {
    const baseFilename = getBaseFilename(filename);

    for (const ext of THUMBNAIL_EXTENSIONS) {
        const filePath = path.join(THUMBNAIL_DIR, `${baseFilename}${ext}`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            thumbnailCache.delete(baseFilename);
            log.info(`Deleted: ${baseFilename}${ext}`);
            return { deleted: true, path: filePath };
        }
    }

    log.debug(`No thumbnail found to delete for ${baseFilename}`);
    return { deleted: false, path: null };
}

function saveCustomThumbnail(filename, buffer, mimeType) {
    const baseFilename = getBaseFilename(filename);
    const ext = mimeType && mimeType.includes('png') ? '.png' : '.jpg';
    deleteThumbnail(filename);
    const outputPath = path.join(THUMBNAIL_DIR, `${baseFilename}${ext}`);
    fs.writeFileSync(outputPath, buffer);
    const stats = fs.statSync(outputPath);
    const url = `/thumbnails/${baseFilename}${ext}?v=${Math.floor(stats.mtimeMs)}`;
    setCacheEntry(baseFilename, url);
    log.info(`Custom thumbnail saved: ${baseFilename}${ext}`);
    return url;
}

async function generateAtTimestamp(videoKey, filename, timestampSeconds) {
    const baseFilename = getBaseFilename(filename);
    const outputFilename = `${baseFilename}.png`;
    const outputPath = path.join(THUMBNAIL_DIR, outputFilename);

    deleteThumbnail(filename);

    try {
        const videoUrl = await r2Service.getSignedVideoUrl(videoKey, 600);
        if (!videoUrl) {
            log.error(`Failed to get signed URL for: ${filename}`);
            return null;
        }

        return new Promise((resolve, reject) => {
            log.info(`Generating at ${timestampSeconds}s for: ${outputFilename}`);

            ffmpeg(videoUrl)
                .on('end', () => {
                    log.info(`Generated at ${timestampSeconds}s: ${outputFilename}`);
                    const stats = fs.statSync(outputPath);
                    const url = `/thumbnails/${outputFilename}?v=${Math.floor(stats.mtimeMs)}`;
                    setCacheEntry(baseFilename, url);
                    resolve(url);
                })
                .on('error', (err) => {
                    log.error(`Failed at ${timestampSeconds}s for ${outputFilename}:`, err.message);
                    reject(err);
                })
                .inputOptions([`-ss ${timestampSeconds}`, '-t 1'])
                .outputOptions(['-vframes 1', '-q:v 2', '-vf scale=320:180'])
                .output(outputPath)
                .run();
        });
    } catch (error) {
        log.error(`Error at timestamp for ${filename}:`, error.message);
        return null;
    }
}

async function autoGenerateMissing() {
    try {
        const videoFiles = await r2Service.listVideos();
        let queued = 0, existing = 0, skipped = 0;

        for (const file of videoFiles) {
            const baseFilename = getBaseFilename(file.filename);
            let found = false;

            for (const ext of THUMBNAIL_EXTENSIONS) {
                if (fs.existsSync(path.join(THUMBNAIL_DIR, `${baseFilename}${ext}`))) {
                    found = true;
                    break;
                }
            }

            if (found) { existing++; continue; }
            if (!canRetryThumbnail(`${baseFilename}.png`)) { skipped++; continue; }

            if (!thumbnailQueue.some(job => job.outputFilename === `${baseFilename}.png`)) {
                thumbnailQueue.push({ videoKey: file.key, outputFilename: `${baseFilename}.png` });
                queued++;
            }
        }

        log.info(`Auto: ${videoFiles.length} total, ${existing} existing, ${queued} queued, ${skipped} skipped`);

        if (queued > 0) processQueue();

        return { total: videoFiles.length, existing, queued, skipped };
    } catch (error) {
        log.error('Auto-generate error:', error.message);
        return { error: error.message };
    }
}

module.exports = {
    generateThumbnail,
    processQueue,
    getStatus,
    clearFailed,
    exists,
    deleteThumbnail,
    saveCustomThumbnail,
    generateAtTimestamp,
    autoGenerateMissing,
    canRetryThumbnail,
    THUMBNAIL_DIR,
};
