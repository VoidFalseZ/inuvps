// routes/videos.js - Video streaming and listing routes

const express = require('express');
const router = express.Router();
const { query, validationResult } = require('express-validator');
const config = require('../config');
const r2Service = require('../services/r2Service');
const videoService = require('../services/videoService');

// Home page with video list
router.get('/', async (req, res) => {
    const videoFiles = await r2Service.listVideos();

    if (videoFiles.length === 0) {
        return res.status(404).send("No videos found in R2 bucket.");
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
});

// Get all videos API
router.get('/api/videos', async (req, res) => {
    const { series_title, page, limit } = req.query;

    if (page && limit) {
        const result = await videoService.getPaginatedVideos(page, limit, series_title);
        res.json(result);
    } else {
        // Fallback to legacy structure (array) but optimize internally if possible
        // Passing series_title as object property to support new signature
        const options = series_title ? { series_title } : {};
        const videos = await videoService.getAllVideos(options);
        res.json(videos);
    }
});

// Get all series
router.get('/api/series', async (req, res) => {
    const series = await videoService.getSeriesList();
    res.json(series);
});

// Get videos by series title
router.get('/api/series/:series_title', async (req, res) => {
    const { series_title } = req.params;
    const videos = await videoService.getAllVideos(series_title);
    res.json(videos);
});

// Search videos
router.get('/api/search',
    query('q').optional().isString().trim().escape(),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const videos = await videoService.searchVideos(req.query.q);
            res.json(videos);
        } catch (error) {
            next(error);
        }
    }
);

// Stream video by filename
router.get('/video/:filename', async (req, res) => {
    const { filename } = req.params;
    const videoFile = await videoService.findByFilename(filename);

    if (!videoFile) {
        return res.status(404).send('File not found');
    }

    // Redirect to public URL if configured
    if (config.R2.PUBLIC_URL) {
        return res.redirect(`${config.R2.PUBLIC_URL}/${videoFile.key}`);
    }

    try {
        const response = await r2Service.getObject(videoFile.key);
        const contentLength = response.ContentLength;
        const range = req.headers.range;

        // Disable compression for video streaming
        req.headers['x-no-compression'] = '1';

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : contentLength - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${contentLength}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            });

            const rangeResponse = await r2Service.getObject(videoFile.key, `bytes=${start}-${end}`);
            rangeResponse.Body.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': contentLength,
                'Content-Type': 'video/mp4',
            });
            response.Body.pipe(res);
        }
    } catch (error) {
        console.error('Error streaming video:', error.message);
        res.status(500).send('Error streaming video');
    }
});

module.exports = router;
