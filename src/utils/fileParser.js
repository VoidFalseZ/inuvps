// src/utils/fileParser.js — Filename parsing utilities

'use strict';

const path = require('path');

/**
 * Extract series title and episode number from a video filename.
 * Supports patterns:
 *   - "SeriesName--22_720p.mp4"       → { seriesTitle: "SeriesName", episodeNumber: 22 }
 *   - "SeriesName E22.mp4"            → { seriesTitle: "SeriesName", episodeNumber: 22 }
 *   - "SeriesName-Episode-22.mp4"     → { seriesTitle: "SeriesName", episodeNumber: 22 }
 *   - "StandaloneVideo.mp4"           → { seriesTitle: "StandaloneVideo", episodeNumber: null }
 *
 * @param {string} filename
 * @returns {{ seriesTitle: string, episodeNumber: number|null }}
 */
function extractTitleAndEpisode(filename) {
    const baseName = path.parse(filename).name;

    // Pattern 1: SeriesName--EpisodeNumber (e.g. "ReZero--22_720p")
    let match = baseName.match(/^(.+?)--(\d+)/);
    if (match) {
        return {
            seriesTitle: match[1].replace(/[._]/g, ' ').trim(),
            episodeNumber: parseInt(match[2], 10),
        };
    }

    // Pattern 2: SeriesName E/EP/Episode Number (e.g. "ReZero E22")
    match = baseName.match(/(.+?)[-._ ](?:E|EP|Episode)[-._ ]?(\d+)/i);
    if (match) {
        return {
            seriesTitle: match[1].replace(/[._]/g, ' ').trim(),
            episodeNumber: parseInt(match[2], 10),
        };
    }

    // Fallback: entire basename as title
    return {
        seriesTitle: baseName.replace(/[._]/g, ' ').trim(),
        episodeNumber: null,
    };
}

/**
 * Strip the file extension from a filename.
 * @param {string} filename
 * @returns {string}
 */
function getBaseFilename(filename) {
    return filename.replace(/\.[^/.]+$/, '');
}

module.exports = {
    extractTitleAndEpisode,
    getBaseFilename,
};
