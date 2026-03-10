// services/r2Service.js - Cloudflare R2 storage operations

const path = require('path');
const { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');

// Initialize S3 Client for R2
const s3Client = new S3Client({
    region: 'auto',
    endpoint: config.R2.ENDPOINT,
    credentials: {
        accessKeyId: config.R2.ACCESS_KEY_ID,
        secretAccessKey: config.R2.SECRET_ACCESS_KEY,
    },
});

// Video list cache
const cache = {
    videos: null,
    lastFetched: 0
};

/**
 * List all videos from R2 bucket with caching
 * @param {boolean} forceRefresh - Force refresh cache
 * @returns {Promise<Array>} Array of video objects
 */
async function listVideos(forceRefresh = false) {
    const now = Date.now();

    // Return cached data if still valid
    if (!forceRefresh && cache.videos && (now - cache.lastFetched) < config.R2_CACHE_TTL_MS) {
        return cache.videos;
    }

    try {
        let isTruncated = true;
        let continuationToken = undefined;
        const allContents = [];

        // Paginate through all objects (S3 returns max 1000 per request)
        while (isTruncated) {
            const command = new ListObjectsV2Command({
                Bucket: config.R2.BUCKET_NAME,
                Prefix: '',
                ContinuationToken: continuationToken,
            });

            const response = await s3Client.send(command);

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
                size: item.Size
            }));

        // Update cache
        cache.videos = videoFiles;
        cache.lastFetched = now;
        console.log(`[R2 Cache] Refreshed video list: ${videoFiles.length} videos (TTL: ${config.R2_CACHE_TTL_MS / 1000}s)`);

        return videoFiles;
    } catch (error) {
        console.error('Error listing R2 videos:', error.message);
        // Return stale cache if available on error
        if (cache.videos) {
            console.log('[R2 Cache] Returning stale cache due to error');
            return cache.videos;
        }
        return [];
    }
}

/**
 * Warm the video list cache on startup
 */
async function warmCache() {
    try {
        console.log('[R2 Cache] Warming cache on startup...');
        await listVideos(true);
        console.log('[R2 Cache] Cache warmed successfully');
    } catch (error) {
        console.error('[R2 Cache] Failed to warm cache:', error.message);
    }
}

/**
 * Get a signed URL for a video or use public URL if configured
 * @param {string} key - R2 object key
 * @param {number} expiresIn - URL expiration in seconds
 * @returns {Promise<string|null>} Signed URL or null on error
 */
async function getSignedVideoUrl(key, expiresIn = 3600) {
    if (config.R2.PUBLIC_URL) {
        return `${config.R2.PUBLIC_URL}/${key}`;
    }

    const command = new GetObjectCommand({
        Bucket: config.R2.BUCKET_NAME,
        Key: key,
        // Tell R2 to include Cache-Control to allow CDN/browser caching
        ResponseCacheControl: 'public, max-age=86400',
    });

    try {
        return await getSignedUrl(s3Client, command, { expiresIn });
    } catch (error) {
        console.error(`Error generating signed URL for ${key}:`, error.message);
        return null;
    }
}

/**
 * Get an object from R2
 * @param {string} key - R2 object key
 * @param {string} range - Optional byte range
 * @returns {Promise<Object>} S3 response object
 */
async function getObject(key, range = null) {
    const params = {
        Bucket: config.R2.BUCKET_NAME,
        Key: key,
    };

    if (range) {
        params.Range = range;
    }

    return s3Client.send(new GetObjectCommand(params));
}

/**
 * Get an object's metadata from R2 without downloading the body
 * @param {string} key - R2 object key
 * @returns {Promise<Object>} S3 response object with metadata
 */
async function headObject(key) {
    const params = {
        Bucket: config.R2.BUCKET_NAME,
        Key: key,
    };
    return s3Client.send(new HeadObjectCommand(params));
}

/**
 * Upload an object to R2
 * @param {string} key - R2 object key (path in bucket)
 * @param {Buffer|Readable} body - File content
 * @param {string} contentType - MIME type
 * @returns {Promise<Object>} S3 response
 */
async function putObject(key, body, contentType) {
    const params = {
        Bucket: config.R2.BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
    };
    return s3Client.send(new PutObjectCommand(params));
}

/**
 * Invalidate the video list cache
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
    warmCache
};
