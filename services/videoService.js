// services/videoService.js - Video details and processing with in-memory caching

const path = require('path');
const crypto = require('crypto');
const r2Service = require('./r2Service');
const metadataService = require('./metadataService');
const thumbnailService = require('./thumbnailService');
const { extractTitleAndEpisode, getBaseFilename } = require('../utils/fileParser');
const { formatDateTime } = require('../utils/helpers');
const config = require('../config');

// ─── In-Memory Video Details Cache ───────────────────────────────────────────
// This is the critical performance optimization. Instead of rebuilding video
// details on every API request (which involves N thumbnail checks + N URL
// generations), we cache the fully-built result for VIDEO_DETAILS_CACHE_TTL_MS.

const detailsCache = {
    // Full video list (with URLs) - key: 'all', value: { data, timestamp, etag }
    full: null,
    // Lightweight list (no URLs) - key: 'light', value: { data, timestamp, etag }
    light: null,
    // Series list - key: 'series', value: { data, timestamp, etag }
    series: null,
};

function isCacheValid(entry) {
    return entry && entry.data && (Date.now() - entry.timestamp) < config.VIDEO_DETAILS_CACHE_TTL_MS;
}

function generateETag(data) {
    const hash = crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
    return `"${hash}"`;
}

/**
 * Invalidate all video details caches.
 * Call this when metadata/thumbnails are updated by admin.
 */
function invalidateDetailsCache() {
    detailsCache.full = null;
    detailsCache.light = null;
    detailsCache.series = null;
    console.log('[VideoService] Details cache invalidated');
}

/**
 * Background cache refresh — keeps caches warm even with zero traffic.
 * This prevents cold-start delays after overnight inactivity.
 */
async function refreshCacheInBackground() {
    try {
        const start = Date.now();
        console.log('[VideoService] Background cache refresh starting...');

        // Force-refresh R2 list first
        await r2Service.listVideos(true);

        // Rebuild light cache (no URLs — fast)
        const metadata = metadataService.loadMetadata();
        const videoFiles = await r2Service.listVideos();

        const lightData = (await Promise.all(
            videoFiles.map(file => getVideoDetails(file, metadata, { skipUrl: true }))
        )).filter(Boolean);

        lightData.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

        detailsCache.light = {
            data: lightData,
            timestamp: Date.now(),
            etag: generateETag(lightData)
        };

        // Also rebuild series cache from the light data
        const seriesInfo = new Map();
        for (const video of lightData) {
            if (video && video.series_title) {
                const { series_title, last_modified, description, thumbnail_url, episode_number } = video;
                if (!seriesInfo.has(series_title)) {
                    seriesInfo.set(series_title, {
                        count: 0, last_modified: '1970-01-01 00:00:00',
                        description: 'No description available.',
                        thumbnail_url: null, first_episode: Infinity
                    });
                }
                const cur = seriesInfo.get(series_title);
                cur.count++;
                const epNum = episode_number !== null ? episode_number : Infinity;
                if (epNum < cur.first_episode && thumbnail_url) {
                    cur.thumbnail_url = thumbnail_url;
                    cur.first_episode = epNum;
                }
                if (new Date(last_modified) > new Date(cur.last_modified)) {
                    cur.last_modified = last_modified;
                    cur.description = description;
                }
            }
        }

        const seriesResult = Array.from(seriesInfo.entries()).map(([title, info]) => ({
            series_title: title,
            video_count: info.count,
            thumbnail_url: info.thumbnail_url,
            last_modified: info.last_modified,
            description: info.description
        }));
        seriesResult.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

        detailsCache.series = {
            data: seriesResult,
            timestamp: Date.now(),
            etag: generateETag(seriesResult)
        };

        const elapsed = Date.now() - start;
        console.log(`[VideoService] Background cache refresh done: ${lightData.length} videos, ${seriesResult.length} series in ${elapsed}ms`);
    } catch (error) {
        console.error('[VideoService] Background cache refresh failed:', error.message);
    }
}

/**
 * Warm up the video details cache on server startup.
 * Called once from server.js to ensure first request is fast.
 */
async function warmVideoDetailsCache() {
    console.log('[VideoService] Warming video details cache...');
    await refreshCacheInBackground();
    console.log('[VideoService] Video details cache warmed successfully');
}

/**
 * Start periodic background cache refresh.
 * Call once from server.js after startup.
 * @param {number} intervalMs - Refresh interval (default: 4 minutes)
 */
function startBackgroundRefresh(intervalMs = 4 * 60 * 1000) {
    setInterval(() => {
        refreshCacheInBackground();
    }, intervalMs);
    console.log(`[VideoService] Background cache refresh scheduled every ${intervalMs / 1000}s`);
}

// ─── Video Detail Builder ────────────────────────────────────────────────────

/**
 * Get detailed information for a video file
 */
async function getVideoDetails(videoFile, metadata = null, options = {}) {
    const { skipUrl = false } = options;

    if (!metadata) {
        metadata = metadataService.loadMetadata();
    }

    const { filename, key, lastModified } = videoFile;
    const fileMtime = formatDateTime(lastModified);

    let fileMetadata = metadata[filename] || {};
    let { display_title, episode_number, series_title, description } = fileMetadata;
    description = description || "No description available.";

    // Override series_title if in [3D] folder
    if (key && (key.startsWith('[3D]/') || key.includes('/[3D]/'))) {
        if (series_title && !series_title.toLowerCase().includes('3d')) {
            series_title = `${series_title} [3D]`;
        }
    }

    let metadataUpdated = false;
    if (!display_title || !series_title) {
        const extracted = extractTitleAndEpisode(filename);
        if (!series_title) { series_title = extracted.seriesTitle; metadataUpdated = true; }
        if (!display_title) { display_title = extracted.seriesTitle; metadataUpdated = true; }
        if (episode_number === undefined || episode_number === null) {
            episode_number = extracted.episodeNumber;
            metadataUpdated = true;
        }
    }

    if (metadataUpdated) {
        metadata[filename] = { display_title, episode_number, series_title, description };
        metadataService.saveMetadata(metadata);
    }

    let videoUrl = null;
    if (!skipUrl) {
        videoUrl = await r2Service.getSignedVideoUrl(key);
    }

    // Check for existing thumbnails
    let thumbnailUrl = thumbnailService.exists(filename);

    // Lazy thumbnail generation if not exists (only if we are not skipping heavy ops)
    if (!thumbnailUrl && !skipUrl) {
        const baseFilename = getBaseFilename(filename);
        thumbnailService.generateThumbnail(key, `${baseFilename}.png`).then(generatedUrl => {
            if (generatedUrl) {
                console.log(`[Thumbnail] Generated for: ${baseFilename}`);
            }
        }).catch(err => {
            console.error(`[Thumbnail] Error generating for ${baseFilename}:`, err.message);
        });
    }

    return {
        filename,
        url: videoUrl || `/video/${filename}`,
        thumbnail_url: thumbnailUrl,
        last_modified: fileMtime,
        display_title,
        episode_number,
        series_title,
        description
    };
}

// ─── Cached Data Fetchers ────────────────────────────────────────────────────

/**
 * Get all videos - with in-memory caching for the lightweight version.
 * The full list (with URLs) is also cached separately.
 */
async function getAllVideos(options = {}) {
    const { series_title: seriesFilter, skipUrl = false } = options;

    // Backward compatibility for string argument
    const filter = typeof options === 'string' ? options : seriesFilter;

    // Try to use cached data for the base list
    const cacheKey = skipUrl ? 'light' : 'full';

    let allVideosData;

    if (isCacheValid(detailsCache[cacheKey]) && !filter) {
        // Return cached data directly for unfiltered requests
        allVideosData = detailsCache[cacheKey].data;
    } else if (isCacheValid(detailsCache.light) && filter) {
        // For filtered requests, use the cached light list to filter
        allVideosData = detailsCache.light.data;
    } else {
        // Cache miss - rebuild
        const metadata = metadataService.loadMetadata();
        const videoFiles = await r2Service.listVideos();

        allVideosData = (await Promise.all(
            videoFiles.map(file => getVideoDetails(file, metadata, { skipUrl }))
        )).filter(Boolean);

        // Sort by last_modified for the cached version (general order)
        allVideosData.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

        // Cache the result
        detailsCache[cacheKey] = {
            data: allVideosData,
            timestamp: Date.now(),
            etag: generateETag(allVideosData)
        };

        console.log(`[VideoService] Built and cached ${cacheKey} list: ${allVideosData.length} videos`);
    }

    if (filter) {
        let filtered = allVideosData.filter(v =>
            v.series_title && v.series_title.toLowerCase() === filter.toLowerCase()
        );
        // Sort by episode number for series view
        filtered.sort((a, b) => {
            const epA = a.episode_number !== null ? a.episode_number : Infinity;
            const epB = b.episode_number !== null ? b.episode_number : Infinity;
            return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
        });
        return filtered;
    }

    return allVideosData;
}

/**
 * Get paginated videos - uses lightweight cache for filter/sort, then hydrates page
 */
async function getPaginatedVideos(page = 1, limit = 20, seriesFilter = null) {
    // 1. Get lightweight details from cache for ALL videos to filter/sort
    let allVideos = await getAllVideos({ skipUrl: true });

    // 2. Filter
    if (seriesFilter) {
        allVideos = allVideos.filter(v =>
            v.series_title && v.series_title.toLowerCase() === seriesFilter.toLowerCase()
        );
        // Sort by episode for series
        allVideos.sort((a, b) => {
            const epA = a.episode_number !== null ? a.episode_number : Infinity;
            const epB = b.episode_number !== null ? b.episode_number : Infinity;
            return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
        });
    }
    // Note: allVideos already sorted by last_modified from cache

    // 3. Paginate
    const total = allVideos.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = allVideos.slice(startIndex, endIndex);

    // 4. Hydrate only the page items with signed URLs
    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();

    const hydratedItems = await Promise.all(
        paginatedItems.map(async (v) => {
            const file = videoFiles.find(f => f.filename === v.filename);
            return getVideoDetails(file, metadata, { skipUrl: false });
        })
    );

    return {
        data: hydratedItems,
        pagination: {
            current_page: Number(page),
            total_pages: Math.ceil(total / limit),
            total_items: total,
            items_per_page: Number(limit)
        }
    };
}

/**
 * Get series list with aggregated info - cached
 */
async function getSeriesList() {
    // Check series cache
    if (isCacheValid(detailsCache.series)) {
        return detailsCache.series.data;
    }

    // Use getAllVideos with skipUrl: true for performance (leverages its own cache)
    const allVideoDetails = await getAllVideos({ skipUrl: true });

    const seriesInfo = new Map();

    for (const video of allVideoDetails) {
        if (video && video.series_title) {
            const { series_title, last_modified, description, thumbnail_url, episode_number } = video;

            if (!seriesInfo.has(series_title)) {
                seriesInfo.set(series_title, {
                    count: 0,
                    last_modified: '1970-01-01 00:00:00',
                    description: "No description available.",
                    thumbnail_url: null,
                    first_episode: Infinity
                });
            }

            const currentSeries = seriesInfo.get(series_title);
            currentSeries.count++;

            const epNum = episode_number !== null ? episode_number : Infinity;
            if (epNum < currentSeries.first_episode && thumbnail_url) {
                currentSeries.thumbnail_url = thumbnail_url;
                currentSeries.first_episode = epNum;
            }

            if (new Date(last_modified) > new Date(currentSeries.last_modified)) {
                currentSeries.last_modified = last_modified;
                currentSeries.description = description;
            }
        }
    }

    let result = Array.from(seriesInfo.entries()).map(([title, info]) => ({
        series_title: title,
        video_count: info.count,
        thumbnail_url: info.thumbnail_url,
        last_modified: info.last_modified,
        description: info.description
    }));

    result.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

    // Cache the result
    detailsCache.series = {
        data: result,
        timestamp: Date.now(),
        etag: generateETag(result)
    };

    console.log(`[VideoService] Built and cached series list: ${result.length} series`);
    return result;
}

/**
 * Search videos by query - uses cached light list
 */
async function searchVideos(query) {
    const searchQuery = (query || '').toLowerCase();

    // Get lightweight list from cache
    const allVideos = await getAllVideos({ skipUrl: true });

    const filteredVideos = allVideos.filter(video => {
        const searchText = `${video.filename} ${video.display_title} ${video.series_title} ${video.description}`.toLowerCase();
        return searchText.includes(searchQuery);
    });

    // Hydrate results (up to 50 to prevent overload)
    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();

    const hydratedResults = await Promise.all(
        filteredVideos.slice(0, 50).map(async (v) => {
            const file = videoFiles.find(f => f.filename === v.filename);
            return getVideoDetails(file, metadata, { skipUrl: false });
        })
    );

    hydratedResults.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    return hydratedResults;
}

/**
 * Find video by filename
 */
async function findByFilename(filename) {
    const videoFiles = await r2Service.listVideos();
    return videoFiles.find(f => f.filename === filename);
}

/**
 * Get the ETag for a cache entry (for HTTP 304 support)
 */
function getCacheETag(cacheKey) {
    const entry = detailsCache[cacheKey];
    if (entry && entry.etag) {
        return entry.etag;
    }
    return null;
}

module.exports = {
    getVideoDetails,
    getAllVideos,
    getPaginatedVideos,
    getSeriesList,
    searchVideos,
    findByFilename,
    invalidateDetailsCache,
    getCacheETag,
    warmVideoDetailsCache,
    startBackgroundRefresh
};
