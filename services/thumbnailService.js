// services/thumbnailService.js - Thumbnail generation with retry logic

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { execSync } = require('child_process');
const config = require('../config');
const r2Service = require('./r2Service');
const { delay } = require('../utils/helpers');
const { getBaseFilename } = require('../utils/fileParser');

// Configure FFmpeg paths
let ffmpegPath, ffprobePath;
try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    execSync('which ffprobe', { stdio: 'ignore' });
    ffmpegPath = 'ffmpeg';
    ffprobePath = 'ffprobe';
    console.log('[FFmpeg] Using system FFmpeg');
} catch {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    ffprobePath = require('@ffprobe-installer/ffprobe').path;
    console.log('[FFmpeg] Using npm package FFmpeg');
}
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Directories
const THUMBNAIL_DIR = path.join(process.cwd(), 'cache', 'thumbnails');
if (!fs.existsSync(THUMBNAIL_DIR)) {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

// State
const generatingThumbnails = new Set();
const failedThumbnails = new Map();
const thumbnailQueue = [];
let isProcessingQueue = false;

/**
 * Check if a failed thumbnail can be retried
 */
function canRetryThumbnail(filename) {
    const failed = failedThumbnails.get(filename);
    if (!failed) return true;

    if (Date.now() - failed.lastAttempt > config.THUMBNAIL.FAILED_COOLDOWN_MS) {
        failedThumbnails.delete(filename);
        return true;
    }

    if (failed.attempts >= config.THUMBNAIL.MAX_RETRY_ATTEMPTS) {
        return false;
    }

    return true;
}

/**
 * Single thumbnail generation attempt
 */
async function generateThumbnailAttempt(videoUrl, outputFilename, attemptNum) {
    const outputPath = path.join(THUMBNAIL_DIR, outputFilename);
    const publicPath = `/thumbnails/${outputFilename}`;

    return new Promise((resolve, reject) => {
        console.log(`[Thumbnail] Attempt ${attemptNum}/${config.THUMBNAIL.MAX_RETRY_ATTEMPTS} for: ${outputFilename}`);

        ffmpeg(videoUrl)
            .on('start', (cmd) => {
                console.log(`[FFmpeg] Started: ${cmd.substring(0, 100)}...`);
            })
            .on('end', () => {
                console.log(`[Thumbnail] Successfully generated: ${outputFilename}`);
                resolve(publicPath);
            })
            .on('error', (err) => {
                console.error(`[Thumbnail] Attempt ${attemptNum} failed for ${outputFilename}:`, err.message);
                reject(err);
            })
            .inputOptions(['-ss 30', '-t 1'])
            .outputOptions(['-vframes 1', '-q:v 2', '-vf scale=320:180'])
            .output(outputPath)
            .run();
    });
}

/**
 * Main thumbnail generation with retry logic
 */
async function generateThumbnail(videoKey, outputFilename) {
    const outputPath = path.join(THUMBNAIL_DIR, outputFilename);
    const publicPath = `/thumbnails/${outputFilename}`;

    // Check if thumbnail already exists
    if (fs.existsSync(outputPath)) {
        return publicPath;
    }

    if (!canRetryThumbnail(outputFilename)) {
        const failed = failedThumbnails.get(outputFilename);
        console.log(`[Thumbnail] Skipping ${outputFilename} - in cooldown (${failed.attempts} failed attempts)`);
        return null;
    }

    if (generatingThumbnails.has(outputFilename)) {
        console.log(`[Thumbnail] Already in progress: ${outputFilename}`);
        return null;
    }

    if (generatingThumbnails.size >= config.THUMBNAIL.MAX_CONCURRENT) {
        if (!thumbnailQueue.some(job => job.outputFilename === outputFilename)) {
            thumbnailQueue.push({ videoKey, outputFilename });
            console.log(`[Thumbnail] Queued: ${outputFilename} (queue size: ${thumbnailQueue.length})`);
        }
        return null;
    }

    generatingThumbnails.add(outputFilename);

    try {
        const videoUrl = await r2Service.getSignedVideoUrl(videoKey, 600);
        if (!videoUrl) {
            console.error(`[Thumbnail] Failed to get signed URL for: ${outputFilename}`);
            return null;
        }

        let lastError = null;
        const existingFailed = failedThumbnails.get(outputFilename);
        const startAttempt = existingFailed ? existingFailed.attempts + 1 : 1;

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
                    error: err.message
                });

                if (attempt < config.THUMBNAIL.MAX_RETRY_ATTEMPTS) {
                    const backoffMs = config.THUMBNAIL.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                    console.log(`[Thumbnail] Retrying in ${backoffMs}ms...`);
                    await delay(backoffMs);
                }
            }
        }

        console.error(`[Thumbnail] All ${config.THUMBNAIL.MAX_RETRY_ATTEMPTS} attempts failed for ${outputFilename}:`, lastError?.message);
        return null;
    } catch (error) {
        console.error(`[Thumbnail] Fatal error for ${outputFilename}:`, error.message);
        failedThumbnails.set(outputFilename, {
            attempts: config.THUMBNAIL.MAX_RETRY_ATTEMPTS,
            lastAttempt: Date.now(),
            error: error.message
        });
        return null;
    } finally {
        generatingThumbnails.delete(outputFilename);
        processQueue();
    }
}

/**
 * Process thumbnail queue
 */
async function processQueue() {
    if (isProcessingQueue || thumbnailQueue.length === 0) return;
    if (generatingThumbnails.size >= config.THUMBNAIL.MAX_CONCURRENT) return;

    isProcessingQueue = true;

    while (thumbnailQueue.length > 0 && generatingThumbnails.size < config.THUMBNAIL.MAX_CONCURRENT) {
        const job = thumbnailQueue.shift();
        if (job) {
            generateThumbnail(job.videoKey, job.outputFilename).catch(err => {
                console.error(`[Queue] Error processing ${job.outputFilename}:`, err.message);
            });
        }
        await delay(100);
    }

    isProcessingQueue = false;
}

/**
 * Get thumbnail status for admin
 */
function getStatus() {
    return {
        currently_generating: Array.from(generatingThumbnails),
        queue_size: thumbnailQueue.length,
        queued: thumbnailQueue.map(j => j.outputFilename),
        failed_count: failedThumbnails.size,
        failed: Object.fromEntries(failedThumbnails)
    };
}

/**
 * Clear failed thumbnails
 */
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
 * Check if thumbnail exists for a filename
 */
function exists(filename) {
    const baseFilename = getBaseFilename(filename);
    const pngPath = path.join(THUMBNAIL_DIR, `${baseFilename}.png`);
    const jpgPath = path.join(THUMBNAIL_DIR, `${baseFilename}.jpg`);

    if (fs.existsSync(pngPath)) return `/thumbnails/${baseFilename}.png`;
    if (fs.existsSync(jpgPath)) return `/thumbnails/${baseFilename}.jpg`;
    return null;
}

/**
 * Auto-generate missing thumbnails
 */
async function autoGenerateMissing() {
    try {
        const videoFiles = await r2Service.listVideos();

        let queued = 0;
        let existing = 0;
        let skipped = 0;

        for (const file of videoFiles) {
            const baseFilename = getBaseFilename(file.filename);
            const pngPath = path.join(THUMBNAIL_DIR, `${baseFilename}.png`);
            const jpgPath = path.join(THUMBNAIL_DIR, `${baseFilename}.jpg`);

            if (fs.existsSync(pngPath) || fs.existsSync(jpgPath)) {
                existing++;
                continue;
            }

            if (!canRetryThumbnail(`${baseFilename}.png`)) {
                skipped++;
                continue;
            }

            if (!thumbnailQueue.some(job => job.outputFilename === `${baseFilename}.png`)) {
                thumbnailQueue.push({ videoKey: file.key, outputFilename: `${baseFilename}.png` });
                queued++;
            }
        }

        console.log(`[Thumbnail Auto] Videos: ${videoFiles.length}, Existing: ${existing}, Queued: ${queued}, Skipped: ${skipped}`);

        if (queued > 0) {
            processQueue();
        }

        return { total: videoFiles.length, existing, queued, skipped };
    } catch (error) {
        console.error('[Thumbnail Auto] Error:', error.message);
        return { error: error.message };
    }
}

module.exports = {
    generateThumbnail,
    processQueue,
    getStatus,
    clearFailed,
    exists,
    autoGenerateMissing,
    canRetryThumbnail,
    THUMBNAIL_DIR
};
