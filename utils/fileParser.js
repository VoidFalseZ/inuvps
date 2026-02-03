// utils/fileParser.js - Filename parsing utilities

const path = require('path');

/**
 * Extract title and episode number from a filename
 * @param {string} filename - Video filename
 * @returns {Object} { seriesTitle, episodeNumber }
 */
function extractTitleAndEpisode(filename) {
    const baseName = path.parse(filename).name;

    // Try pattern: SeriesName--EpisodeNumber (e.g., "ReZero--22_720p" or "ReZero--25_End_720p")
    let match = baseName.match(/^(.+?)--(\\d+)/);
    if (match) {
        return {
            seriesTitle: match[1].replace(/[._]/g, ' ').trim(),
            episodeNumber: parseInt(match[2], 10)
        };
    }

    // Try pattern: SeriesName E/EP/Episode Number (e.g., "ReZero E22" or "ReZero-Episode-22")
    match = baseName.match(/(.+?)[-._ ](?:E|EP|Episode)[-._ ]?(\d+)/i);
    if (match) {
        return {
            seriesTitle: match[1].replace(/[._]/g, ' ').trim(),
            episodeNumber: parseInt(match[2], 10)
        };
    }

    // Fallback: use entire basename as series title
    return {
        seriesTitle: baseName.replace(/[._]/g, ' ').trim(),
        episodeNumber: null
    };
}

/**
 * Get base filename without extension
 * @param {string} filename - Filename with extension
 * @returns {string} Filename without extension
 */
function getBaseFilename(filename) {
    return filename.replace(/\.[^/.]+$/, '');
}

module.exports = {
    extractTitleAndEpisode,
    getBaseFilename
};
