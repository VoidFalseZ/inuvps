// src/routes/videoRoutes.js — Video listing, streaming, and HLS routes

'use strict';

const express = require('express');
const router = express.Router();
const videoCtrl = require('../controllers/videoController');
const { validate, query } = require('../middleware/validate');

// HTML video listing page
router.get('/', videoCtrl.indexPage);

// API endpoints
router.get('/api/videos', videoCtrl.getVideos);
router.get('/api/series', videoCtrl.getSeries);
router.get('/api/series/:series_title', videoCtrl.getSeriesByTitle);

router.get('/api/search',
    validate([query('q').optional().isString().trim().escape()]),
    videoCtrl.searchVideos
);

// Video streaming (direct or CDN redirect)
router.get('/video/:filename', videoCtrl.streamVideo);

// HLS manifest check
router.get('/api/hls/:filename', videoCtrl.getHlsStatus);

module.exports = router;
