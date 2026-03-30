// src/controllers/videoController.js — Video listing, streaming, and HLS handlers

'use strict';

const config = require('../config');
const r2Service = require('../services/r2Service');
const videoService = require('../services/videoService');
const hlsService = require('../services/hlsService');
const { createLogger } = require('../utils/logger');

const log = createLogger('VideoCtrl');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setCacheHeaders(res, maxAge = config.API_CACHE_MAX_AGE) {
    res.set('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`);
    res.set('Vary', 'Accept-Encoding');
}

function handleETag(req, res) {
    const etag = videoService.getCacheETag('light');
    if (etag) {
        res.set('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
            res.status(304).end();
            return true; // 304 sent
        }
    }
    return false;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * GET / — HTML video listing page
 */
async function indexPage(req, res) {
    const videoFiles = await r2Service.listVideos();

    if (videoFiles.length === 0) {
        return res.status(404).send('No videos found in R2 bucket.');
    }

    videoFiles.sort((a, b) => b.lastModified - a.lastModified);

    const fileListItems = videoFiles.map((file, index) => `
        <li>
          <strong>${index + 1}.</strong>
          <a href="/video/${file.filename}">${file.filename}</a>
          <br><small>Last Modified: ${file.lastModified.toISOString().replace('T', ' ').substring(0, 19)}</small>
        </li>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Available Videos</title>
        <style>
            body { font-family: sans-serif; background-color: #1a1a1a; color: #f0f0f0; margin: 20px; }
            h1 { color: #e0e0e0; }
            ul { list-style: none; padding: 0; }
            li { background-color: #2a2a2a; margin-bottom: 10px; padding: 10px; border-radius: 8px; }
            a { color: #4CAF50; text-decoration: none; }
            small { color: #888; }
        </style>
    </head>
    <body>
        <h1>Available Videos (from R2)</h1>
        <ul>${fileListItems}</ul>
    </body>
    </html>
    `);
}

/**
 * GET /api/videos — Get all videos (with optional pagination & series filter)
 */
async function getVideos(req, res) {
    const { series_title, page, limit } = req.query;

    setCacheHeaders(res);

    if (page && limit) {
        const result = await videoService.getPaginatedVideos(page, limit, series_title);

        const etag = videoService.getCacheETag('light');
        if (etag) {
            const pageEtag = `"${etag.replace(/"/g, '')}-p${page}-l${limit}"`;
            res.set('ETag', pageEtag);
            if (req.headers['if-none-match'] === pageEtag) {
                return res.status(304).end();
            }
        }

        return res.json(result);
    }

    const options = series_title ? { series_title } : {};
    const videos = await videoService.getAllVideos(options);

    if (handleETag(req, res)) return;

    res.json(videos);
}

/**
 * GET /api/series — Get all series with aggregated info
 */
async function getSeries(req, res) {
    setCacheHeaders(res);

    const series = await videoService.getSeriesList();

    const etag = videoService.getCacheETag('series');
    if (etag) {
        res.set('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }
    }

    res.json(series);
}

/**
 * GET /api/series/:series_title — Get videos by series title
 */
async function getSeriesByTitle(req, res) {
    setCacheHeaders(res);
    const videos = await videoService.getAllVideos(req.params.series_title);
    res.json(videos);
}

/**
 * GET /api/search?q= — Search videos
 */
async function searchVideos(req, res, next) {
    try {
        setCacheHeaders(res, 60);
        const videos = await videoService.searchVideos(req.query.q);
        res.json(videos);
    } catch (error) {
        next(error);
    }
}

/**
 * GET /video/:filename — Stream or redirect to CDN
 */
async function streamVideo(req, res) {
    const { filename } = req.params;
    const videoFile = await videoService.findByFilename(filename);

    if (!videoFile) {
        return res.status(404).send('File not found');
    }

    // CDN redirect path
    if (config.R2.PUBLIC_URL) {
        res.set('Cache-Control', 'public, max-age=3600');
        return res.redirect(`${config.R2.PUBLIC_URL}/${videoFile.key}`);
    }

    // Direct streaming path
    try {
        const metadata = await r2Service.headObject(videoFile.key);
        const contentLength = metadata.ContentLength;
        const range = req.headers.range;

        req.headers['x-no-compression'] = '1';

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const MAX_CHUNK_SIZE = 2 * 1024 * 1024;
            const requestedEnd = parts[1] ? parseInt(parts[1], 10) : contentLength - 1;
            const end = Math.min(start + MAX_CHUNK_SIZE - 1, requestedEnd, contentLength - 1);
            const chunksize = end - start + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${contentLength}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
                'Cache-Control': 'public, max-age=86400',
            });

            const rangeResponse = await r2Service.getObject(videoFile.key, `bytes=${start}-${end}`);
            rangeResponse.Body.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': contentLength,
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=86400',
            });
            const response = await r2Service.getObject(videoFile.key);
            response.Body.pipe(res);
        }
    } catch (error) {
        log.error('Streaming error:', error.message);
        res.status(500).send('Error streaming video');
    }
}

/**
 * GET /api/hls/:filename — Get HLS manifest URL
 */
async function getHlsStatus(req, res) {
    const { filename } = req.params;

    const progress = hlsService.getProgress(filename);
    if (progress.status === 'done') {
        return res.json({ available: true, hls_url: hlsService.getHlsUrl(filename), status: progress });
    }

    try {
        const exists = await hlsService.hasHLS(filename);
        if (exists) {
            return res.json({ available: true, hls_url: hlsService.getHlsUrl(filename), status: progress });
        }
        return res.json({ available: false, hls_url: null, status: progress });
    } catch (error) {
        log.error(`HLS check failed for ${filename}:`, error.message);
        res.status(500).json({ error: 'Failed to check HLS status' });
    }
}

module.exports = {
    indexPage,
    getVideos,
    getSeries,
    getSeriesByTitle,
    searchVideos,
    streamVideo,
    getHlsStatus,
};
