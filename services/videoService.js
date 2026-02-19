// services/videoService.js - Video details and processing

const path = require('path');
const r2Service = require('./r2Service');
const metadataService = require('./metadataService');
const thumbnailService = require('./thumbnailService');
const { extractTitleAndEpisode, getBaseFilename } = require('../utils/fileParser');
const { formatDateTime } = require('../utils/helpers');

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

/**
 * Get all videos with optional filters
 */
async function getAllVideos(options = {}) {
    const { series_title: seriesFilter, skipUrl = false } = options;

    // Backward compatibility for string argument
    const filter = typeof options === 'string' ? options : seriesFilter;

    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();

    let allVideosData = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata, { skipUrl }))
    )).filter(Boolean);

    if (filter) {
        allVideosData = allVideosData.filter(v =>
            v.series_title && v.series_title.toLowerCase() === filter.toLowerCase()
        );
        // Sort by episode number for series view
        allVideosData.sort((a, b) => {
            const epA = a.episode_number !== null ? a.episode_number : Infinity;
            const epB = b.episode_number !== null ? b.episode_number : Infinity;
            return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
        });
    } else {
        // Sort by last_modified for general list
        allVideosData.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    }

    return allVideosData;
}

/**
 * Get paginated videos
 */
async function getPaginatedVideos(page = 1, limit = 20, seriesFilter = null) {
    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();

    // 1. First, get lightweight details (no signed URLs) for ALL videos to filter/sort
    let allVideos = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata, { skipUrl: true }))
    )).filter(Boolean);

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
    } else {
        // Sort by date for main list
        allVideos.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    }

    // 3. Paginate
    const total = allVideos.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = allVideos.slice(startIndex, endIndex);

    // 4. Hydrate only the page items with signed URLs
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
 * Get series list with aggregated info
 */
async function getSeriesList() {
    // Use getAllVideos with skipUrl: true for performance
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

    return result;
}

/**
 * Search videos by query
 */
async function searchVideos(query) {
    const searchQuery = (query || '').toLowerCase();

    // Get lightweight list first
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

module.exports = {
    getVideoDetails,
    getAllVideos,
    getPaginatedVideos,
    getSeriesList,
    searchVideos,
    findByFilename
};
