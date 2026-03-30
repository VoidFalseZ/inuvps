// src/services/videoService.js — Video details and caching layer

'use strict';

const crypto = require('crypto');
const r2Service = require('./r2Service');
const metadataService = require('./metadataService');
const thumbnailService = require('./thumbnailService');
const hlsService = require('./hlsService');
const { extractTitleAndEpisode, getBaseFilename } = require('../utils/fileParser');
const { formatDateTime } = require('../utils/helpers');
const { createLogger } = require('../utils/logger');
const config = require('../config');

const log = createLogger('Video');

// ─── Three-Tier In-Memory Cache ──────────────────────────────────────────────

const detailsCache = {
    full: null,   // { data, timestamp, etag }
    light: null,
    series: null,
};

function isCacheValid(entry) {
    return entry && entry.data && (Date.now() - entry.timestamp) < config.VIDEO_DETAILS_CACHE_TTL_MS;
}

function generateETag(data) {
    return `"${crypto.createHash('md5').update(JSON.stringify(data)).digest('hex')}"`;
}

function invalidateDetailsCache() {
    detailsCache.full = null;
    detailsCache.light = null;
    detailsCache.series = null;
    log.info('Details cache invalidated');
}

// ─── Video Detail Builder ────────────────────────────────────────────────────

async function getVideoDetails(videoFile, metadata = null, options = {}) {
    const { skipUrl = false } = options;

    if (!metadata) metadata = metadataService.loadMetadata();

    const { filename, key, lastModified } = videoFile;
    const fileMtime = formatDateTime(lastModified);

    let fileMetadata = metadata[filename] || {};
    let { display_title, episode_number, series_title, description } = fileMetadata;
    description = description || 'No description available.';

    // [3D] folder override
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

    let thumbnailUrl = thumbnailService.exists(filename);

    // Lazy thumbnail generation
    if (!thumbnailUrl && !skipUrl) {
        const baseFilename = getBaseFilename(filename);
        thumbnailService.generateThumbnail(key, `${baseFilename}.png`).catch(err => {
            log.error(`Thumbnail error for ${baseFilename}:`, err.message);
        });
    }

    return {
        filename,
        url: videoUrl || `/video/${filename}`,
        hls_url: hlsService.getHlsUrl(filename),
        thumbnail_url: thumbnailUrl,
        last_modified: fileMtime,
        display_title,
        episode_number,
        series_title,
        description,
    };
}

// ─── Series Builder (shared by cache refresh + getSeriesList) ────────────────

function buildSeriesFromVideos(allVideoDetails) {
    const seriesInfo = new Map();

    for (const video of allVideoDetails) {
        if (!video?.series_title) continue;

        const { series_title, last_modified, description, thumbnail_url, episode_number } = video;

        if (!seriesInfo.has(series_title)) {
            seriesInfo.set(series_title, {
                count: 0,
                last_modified: '1970-01-01 00:00:00',
                description: 'No description available.',
                thumbnail_url: null,
                first_episode: Infinity,
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

    const result = Array.from(seriesInfo.entries()).map(([title, info]) => ({
        series_title: title,
        video_count: info.count,
        thumbnail_url: info.thumbnail_url,
        last_modified: info.last_modified,
        description: info.description,
    }));

    result.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    return result;
}

// ─── Background Cache Refresh ────────────────────────────────────────────────

let refreshIntervalId = null;

async function refreshCacheInBackground() {
    try {
        const start = Date.now();
        log.info('Background cache refresh starting...');

        await r2Service.listVideos(true);

        const metadata = metadataService.loadMetadata();
        const videoFiles = await r2Service.listVideos();

        const lightData = (await Promise.all(
            videoFiles.map(file => getVideoDetails(file, metadata, { skipUrl: true }))
        )).filter(Boolean);

        lightData.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

        detailsCache.light = {
            data: lightData,
            timestamp: Date.now(),
            etag: generateETag(lightData),
        };

        // Also build series cache
        const seriesResult = buildSeriesFromVideos(lightData);
        detailsCache.series = {
            data: seriesResult,
            timestamp: Date.now(),
            etag: generateETag(seriesResult),
        };

        log.info(`Background refresh done: ${lightData.length} videos, ${seriesResult.length} series in ${Date.now() - start}ms`);
    } catch (error) {
        log.error('Background cache refresh failed:', error.message);
    }
}

async function warmVideoDetailsCache() {
    log.info('Warming video details cache...');
    await refreshCacheInBackground();
    log.info('Video details cache warmed');
}

function startBackgroundRefresh(intervalMs = config.BACKGROUND_REFRESH_INTERVAL_MS) {
    refreshIntervalId = setInterval(() => refreshCacheInBackground(), intervalMs);
    log.info(`Background refresh scheduled every ${intervalMs / 1000}s`);
}

function stopBackgroundRefresh() {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
        log.info('Background refresh stopped');
    }
}

// ─── Cached Data Fetchers ────────────────────────────────────────────────────

async function getAllVideos(options = {}) {
    const { series_title: seriesFilter, skipUrl = false } = options;
    const filter = typeof options === 'string' ? options : seriesFilter;
    const cacheKey = skipUrl ? 'light' : 'full';

    let allVideosData;

    if (isCacheValid(detailsCache[cacheKey]) && !filter) {
        allVideosData = detailsCache[cacheKey].data;
    } else if (isCacheValid(detailsCache.light) && filter) {
        allVideosData = detailsCache.light.data;
    } else {
        const metadata = metadataService.loadMetadata();
        const videoFiles = await r2Service.listVideos();

        allVideosData = (await Promise.all(
            videoFiles.map(file => getVideoDetails(file, metadata, { skipUrl }))
        )).filter(Boolean);

        allVideosData.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

        detailsCache[cacheKey] = {
            data: allVideosData,
            timestamp: Date.now(),
            etag: generateETag(allVideosData),
        };

        log.info(`Built and cached ${cacheKey} list: ${allVideosData.length} videos`);
    }

    if (filter) {
        let filtered = allVideosData.filter(v =>
            v.series_title && v.series_title.toLowerCase() === filter.toLowerCase()
        );
        filtered.sort((a, b) => {
            const epA = a.episode_number !== null ? a.episode_number : Infinity;
            const epB = b.episode_number !== null ? b.episode_number : Infinity;
            return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
        });
        return filtered;
    }

    return allVideosData;
}

async function getPaginatedVideos(page = 1, limit = 20, seriesFilter = null) {
    let allVideos = await getAllVideos({ skipUrl: true });

    if (seriesFilter) {
        allVideos = allVideos.filter(v =>
            v.series_title && v.series_title.toLowerCase() === seriesFilter.toLowerCase()
        );
        allVideos.sort((a, b) => {
            const epA = a.episode_number !== null ? a.episode_number : Infinity;
            const epB = b.episode_number !== null ? b.episode_number : Infinity;
            return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
        });
    }

    const total = allVideos.length;
    const startIndex = (page - 1) * limit;
    const paginatedItems = allVideos.slice(startIndex, startIndex + limit);

    // Hydrate only the page with signed URLs
    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();
    const videoFileMap = new Map(videoFiles.map(f => [f.filename, f]));

    const hydratedItems = await Promise.all(
        paginatedItems.map(v => {
            const file = videoFileMap.get(v.filename);
            return getVideoDetails(file, metadata, { skipUrl: false });
        })
    );

    return {
        data: hydratedItems,
        pagination: {
            current_page: Number(page),
            total_pages: Math.ceil(total / limit),
            total_items: total,
            items_per_page: Number(limit),
        },
    };
}

async function getSeriesList() {
    if (isCacheValid(detailsCache.series)) {
        return detailsCache.series.data;
    }

    const allVideoDetails = await getAllVideos({ skipUrl: true });
    const result = buildSeriesFromVideos(allVideoDetails);

    detailsCache.series = {
        data: result,
        timestamp: Date.now(),
        etag: generateETag(result),
    };

    log.info(`Built and cached series list: ${result.length} series`);
    return result;
}

async function searchVideos(query) {
    const searchQuery = (query || '').toLowerCase();
    const allVideos = await getAllVideos({ skipUrl: true });

    const filteredVideos = allVideos.filter(video => {
        const searchText = `${video.filename} ${video.display_title} ${video.series_title} ${video.description}`.toLowerCase();
        return searchText.includes(searchQuery);
    });

    // Hydrate results using O(1) Map lookup (fix from original O(n) .find())
    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();
    const videoFileMap = new Map(videoFiles.map(f => [f.filename, f]));

    const hydratedResults = await Promise.all(
        filteredVideos.slice(0, 50).map(v => {
            const file = videoFileMap.get(v.filename);
            return getVideoDetails(file, metadata, { skipUrl: false });
        })
    );

    hydratedResults.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    return hydratedResults;
}

async function findByFilename(filename) {
    const videoFiles = await r2Service.listVideos();
    return videoFiles.find(f => f.filename === filename);
}

function getCacheETag(cacheKey) {
    return detailsCache[cacheKey]?.etag || null;
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
    startBackgroundRefresh,
    stopBackgroundRefresh,
};
