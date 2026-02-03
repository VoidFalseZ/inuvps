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
async function getVideoDetails(videoFile, metadata = null) {
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

    const videoUrl = await r2Service.getSignedVideoUrl(key);

    // Check for existing thumbnails
    let thumbnailUrl = thumbnailService.exists(filename);

    // Lazy thumbnail generation if not exists
    if (!thumbnailUrl) {
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
 * Get all videos with optional series filter
 */
async function getAllVideos(seriesFilter = null) {
    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();

    let allVideosData = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(Boolean);

    if (seriesFilter) {
        allVideosData = allVideosData.filter(v =>
            v.series_title && v.series_title.toLowerCase() === seriesFilter.toLowerCase()
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
 * Get series list with aggregated info
 */
async function getSeriesList() {
    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();

    const allVideoDetails = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(Boolean);

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
    const metadata = metadataService.loadMetadata();
    const videoFiles = await r2Service.listVideos();

    const allVideoDetails = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(Boolean);

    const filteredVideos = allVideoDetails.filter(video => {
        const searchText = `${video.filename} ${video.display_title} ${video.series_title} ${video.description}`.toLowerCase();
        return searchText.includes(searchQuery);
    });

    filteredVideos.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    return filteredVideos;
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
    getSeriesList,
    searchVideos,
    findByFilename
};
