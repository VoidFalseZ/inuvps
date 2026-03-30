// src/services/r2Service.js — Cloudflare R2 storage operations

'use strict';

const path = require('path');
const {
    S3Client,
    GetObjectCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
    PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const { createLogger } = require('../utils/logger');

const log = createLogger('R2');

// ─── S3 Client ───────────────────────────────────────────────────────────────

const s3Client = new S3Client({
    region: 'auto',
    endpoint: config.R2.ENDPOINT,
    credentials: {
        accessKeyId: config.R2.ACCESS_KEY_ID,
        secretAccessKey: config.R2.SECRET_ACCESS_KEY,
    },
});

// ─── In-Memory Video List Cache ──────────────────────────────────────────────

const cache = {
    videos: null,
    lastFetched: 0,
};

/**
 * List all MP4 videos from the R2 bucket, with TTL-based caching.
 * @param {boolean} forceRefresh
 * @returns {Promise<Array<{filename: string, key: string, lastModified: Date, size: number}>>}
 */
async function listVideos(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && cache.videos && (now - cache.lastFetched) < config.R2_CACHE_TTL_MS) {
        return cache.videos;
    }

    try {
        let isTruncated = true;
        let continuationToken;
        const allContents = [];

        while (isTruncated) {
            const response = await s3Client.send(new ListObjectsV2Command({
                Bucket: config.R2.BUCKET_NAME,
                Prefix: '',
                ContinuationToken: continuationToken,
            }));

            if (response.Contents) {
                allContents.push(...response.Contents);
            }

            isTruncated = response.IsTruncated;
            continuationToken = response.NextContinuationToken;
        }

        const videoFiles = allContents
            .filter(item => item.Key.endsWith('.mp4'))
            .map(item => ({
                filename: path.basename(item.Key),
                key: item.Key,
                lastModified: item.LastModified,
                size: item.Size,
            }));

        cache.videos = videoFiles;
        cache.lastFetched = now;
        log.info(`Refreshed video list: ${videoFiles.length} videos (TTL: ${config.R2_CACHE_TTL_MS / 1000}s)`);

        return videoFiles;
    } catch (error) {
        log.error('Failed to list videos:', error.message);
        if (cache.videos) {
            log.warn('Returning stale cache due to error');
            return cache.videos;
        }
        return [];
    }
}

/**
 * Warm the cache on startup.
 */
async function warmCache() {
    try {
        log.info('Warming cache on startup...');
        await listVideos(true);
        log.info('Cache warmed successfully');
    } catch (error) {
        log.error('Failed to warm cache:', error.message);
    }
}

/**
 * Get a signed URL for an R2 object, or use public CDN URL if configured.
 * @param {string} key
 * @param {number} expiresIn — seconds
 * @returns {Promise<string|null>}
 */
async function getSignedVideoUrl(key, expiresIn = 3600) {
    if (config.R2.PUBLIC_URL) {
        return `${config.R2.PUBLIC_URL}/${key}`;
    }

    try {
        const command = new GetObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: key,
            ResponseCacheControl: 'public, max-age=86400',
        });
        return await getSignedUrl(s3Client, command, { expiresIn });
    } catch (error) {
        log.error(`Signed URL generation failed for ${key}:`, error.message);
        return null;
    }
}

/**
 * Get an object from R2.
 * @param {string} key
 * @param {string} [range] — Optional byte range (e.g. 'bytes=0-1024')
 * @returns {Promise<Object>}
 */
async function getObject(key, range = null) {
    const params = { Bucket: config.R2.BUCKET_NAME, Key: key };
    if (range) params.Range = range;
    return s3Client.send(new GetObjectCommand(params));
}

/**
 * HEAD an object without downloading the body.
 * @param {string} key
 * @returns {Promise<Object>}
 */
async function headObject(key) {
    return s3Client.send(new HeadObjectCommand({
        Bucket: config.R2.BUCKET_NAME,
        Key: key,
    }));
}

/**
 * Upload an object to R2.
 * @param {string} key
 * @param {Buffer|import('stream').Readable} body
 * @param {string} contentType
 * @returns {Promise<Object>}
 */
async function putObject(key, body, contentType) {
    return s3Client.send(new PutObjectCommand({
        Bucket: config.R2.BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
    }));
}

/**
 * Invalidate the video list cache.
 */
function invalidateCache() {
    cache.videos = null;
    cache.lastFetched = 0;
}

module.exports = {
    s3Client,
    listVideos,
    getSignedVideoUrl,
    getObject,
    headObject,
    putObject,
    invalidateCache,
    warmCache,
};
