// server.js - Cloudflare R2 Video Streaming Server (Clean - No Thumbnails)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { query, validationResult } = require('express-validator');
const fs = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();

// --- Server Configuration ---
const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';

// --- Security Middleware ---
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false
}));
app.use(cors());
app.use(morgan('combined'));

// --- Rate Limiting ---
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);
app.use('/thumbnails', express.static(path.join(process.cwd(), "cache", "thumbnails")));

// --- R2 Configuration ---
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'your-account-id';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'your-access-key-id';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'your-secret-access-key';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'anime-videos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || null;

const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// --- Local Cache ---
const CACHE_DIR = path.join(process.cwd(), "cache");
const METADATA_FILE = path.join(CACHE_DIR, "metadata.json");
const THUMBNAIL_DIR = path.join(CACHE_DIR, "thumbnails");

// --- App Version ---
const LATEST_APP_VERSION = process.env.APP_VERSION || "1.0.1";
const SHOW_UPDATE_DIALOG_COMMAND = process.env.SHOW_UPDATE_DIALOG === 'true';

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAIL_DIR)) fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

// --- R2 Helper Functions ---

async function listR2Videos() {
    const command = new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: '',
    });

    try {
        const response = await s3Client.send(command);
        const videoFiles = (response.Contents || [])
            .filter(item => item.Key.endsWith('.mp4'))
            .map(item => ({
                filename: path.basename(item.Key),
                key: item.Key,
                lastModified: item.LastModified,
                size: item.Size
            }));
        return videoFiles;
    } catch (error) {
        console.error('Error listing R2 videos:', error.message);
        return [];
    }
}

async function getSignedVideoUrl(key, expiresIn = 3600) {
    if (R2_PUBLIC_URL) {
        return `${R2_PUBLIC_URL}/${key}`;
    }

    const command = new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
    });

    try {
        return await getSignedUrl(s3Client, command, { expiresIn });
    } catch (error) {
        console.error(`Error generating signed URL for ${key}:`, error.message);
        return null;
    }
}

// --- Metadata Functions ---

const loadMetadata = () => {
    if (fs.existsSync(METADATA_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
        } catch {
            return {};
        }
    }
    return {};
};

const saveMetadata = (metadata) => {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 4), 'utf-8');
};


// --- Thumbnail Generation ---

const generatingThumbnails = new Set();

async function generateThumbnail(videoKey, outputFilename) {
    const outputPath = path.join(THUMBNAIL_DIR, outputFilename);
    const publicPath = `/thumbnails/${outputFilename}`;

    // Check if thumbnail already exists
    if (fs.existsSync(outputPath)) {
        return publicPath;
    }

    // Check if already generating
    if (generatingThumbnails.has(outputFilename)) {
        console.log(`Thumbnail generation already in progress for: ${outputFilename}`);
        return null;
    }

    generatingThumbnails.add(outputFilename);

    try {
        const videoUrl = await getSignedVideoUrl(videoKey, 300); // 5 min expiry
        if (!videoUrl) return null;

        return new Promise((resolve) => {
            console.log(`Generating thumbnail for: ${outputFilename}`);
            ffmpeg(videoUrl)
                .screenshots({
                    timestamps: ['20%'], // Take shot at 20% mark
                    filename: outputFilename,
                    folder: THUMBNAIL_DIR,
                    size: '320x180' // Standard thumbnail size
                })
                .on('end', () => {
                    console.log(`Thumbnail generated: ${outputFilename}`);
                    resolve(publicPath);
                })
                .on('error', (err) => {
                    console.error(`Error generating thumbnail for ${outputFilename}:`, err.message);
                    resolve(null);
                });
        });
    } catch (error) {
        console.error(`Error in generateThumbnail wrapper for ${outputFilename}:`, error.message);
        return null;
    } finally {
        generatingThumbnails.delete(outputFilename);
    }
}

// --- Filename Parsing ---

const extractTitleAndEpisode = (filename) => {
    const baseName = path.parse(filename).name;

    // Try pattern: SeriesName--EpisodeNumber (e.g., "ReZero--22_720p")
    let match = baseName.match(/^(.+?)--(\d+)/);
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
    return { seriesTitle: baseName.replace(/[._]/g, ' ').trim(), episodeNumber: null };
};

// --- Get Video Details ---

const getVideoDetails = async (videoFile, metadata) => {
    const { filename, key, lastModified } = videoFile;
    const fileMtime = new Date(lastModified).toISOString().replace('T', ' ').substring(0, 19);

    let fileMetadata = metadata[filename] || {};
    let { display_title, episode_number, series_title, description } = fileMetadata;
    description = description || "No description available.";

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
        saveMetadata(metadata);
    }

    const videoUrl = await getSignedVideoUrl(key);

    // DISABLED: Thumbnail generation causes ffprobe crashes on VPS
    // const thumbnailFilename = `${filename.replace(/\.[^/.]+$/, "")}.jpg`;
    // const thumbnailPath = path.join(THUMBNAIL_DIR, thumbnailFilename);
    let thumbnailUrl = null;

    // if (fs.existsSync(thumbnailPath)) {
    //     thumbnailUrl = `/thumbnails/${thumbnailFilename}`;
    // } else {
    //     // Trigger generation in background without awaiting
    //     generateThumbnail(key, thumbnailFilename);
    // }

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
};

// --- API Routes ---

app.get('/api/app_version', (req, res) => {
    res.json({ latest_version: LATEST_APP_VERSION });
});

app.get('/api/show_update_dialog_command', (req, res) => {
    res.json({ show_dialog: SHOW_UPDATE_DIALOG_COMMAND });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: LATEST_APP_VERSION,
        r2_bucket: R2_BUCKET_NAME
    });
});

app.get('/', async (req, res) => {
    const videoFiles = await listR2Videos();

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

app.get('/api/videos', async (req, res) => {
    const metadata = loadMetadata();
    const videoFiles = await listR2Videos();

    let allVideosData = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(Boolean);

    allVideosData.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

    const { series_title } = req.query;
    if (series_title) {
        allVideosData = allVideosData.filter(v =>
            v.series_title && v.series_title.toLowerCase() === series_title.toLowerCase()
        );
    }

    res.json(allVideosData);
});

app.get('/api/series', async (req, res) => {
    const metadata = loadMetadata();
    const seriesInfo = new Map();
    const videoFiles = await listR2Videos();

    const allVideoDetails = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(Boolean);

    for (const video of allVideoDetails) {
        if (video && video.series_title) {
            const { series_title, last_modified, description } = video;
            if (!seriesInfo.has(series_title)) {
                seriesInfo.set(series_title, {
                    count: 0,
                    last_modified: '1970-01-01 00:00:00',
                    description: "No description available."
                });
            }

            const currentSeries = seriesInfo.get(series_title);
            currentSeries.count++;

            if (new Date(last_modified) > new Date(currentSeries.last_modified)) {
                currentSeries.last_modified = last_modified;
                currentSeries.description = description;
            }
        }
    }

    let result = Array.from(seriesInfo.entries()).map(([title, info]) => ({
        series_title: title,
        video_count: info.count,
        thumbnail_url: `/thumbnails/${info.series_title.replace(/\s+/g, '_')}_cover.jpg`, // Placeholder logic if we wanted series covers
        last_modified: info.last_modified,
        description: info.description
    }));

    result.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

    res.json(result);
});

app.get('/api/series/:series_title', async (req, res) => {
    const { series_title } = req.params;
    const metadata = loadMetadata();
    const videoFiles = await listR2Videos();

    let seriesVideosData = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(v =>
        v && v.series_title && v.series_title.toLowerCase() === series_title.toLowerCase()
    );

    seriesVideosData.sort((a, b) => {
        const epA = a.episode_number !== null ? a.episode_number : Infinity;
        const epB = b.episode_number !== null ? b.episode_number : Infinity;
        return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
    });

    res.json(seriesVideosData);
});

app.get('/api/search',
    query('q').optional().isString().trim().escape(),
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const searchQuery = (req.query.q || '').toLowerCase();
            const metadata = loadMetadata();
            const videoFiles = await listR2Videos();

            const allVideoDetails = (await Promise.all(
                videoFiles.map(file => getVideoDetails(file, metadata))
            )).filter(Boolean);

            const filteredVideos = allVideoDetails.filter(video => {
                const searchText = `${video.filename} ${video.display_title} ${video.series_title} ${video.description}`.toLowerCase();
                return searchText.includes(searchQuery);
            });

            filteredVideos.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
            res.json(filteredVideos);
        } catch (error) {
            next(error);
        }
    });

// --- Video Streaming Route ---

app.get('/video/:filename', async (req, res) => {
    const { filename } = req.params;
    const videoFiles = await listR2Videos();
    const videoFile = videoFiles.find(f => f.filename === filename);

    if (!videoFile) {
        return res.status(404).send('File not found');
    }

    if (R2_PUBLIC_URL) {
        return res.redirect(`${R2_PUBLIC_URL}/${videoFile.key}`);
    }

    try {
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: videoFile.key,
        });

        const response = await s3Client.send(command);
        const contentLength = response.ContentLength;
        const range = req.headers.range;

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

            const rangeCommand = new GetObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: videoFile.key,
                Range: `bytes=${start}-${end}`
            });
            const rangeResponse = await s3Client.send(rangeCommand);
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

// --- Error Handlers ---

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(err.status || 500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// --- Start Server ---

app.listen(PORT, HOST, () => {
    console.log(` Server is running at http://${HOST}:${PORT}`);
    console.log(` R2 Bucket: ${R2_BUCKET_NAME}`);
    console.log(` R2 Endpoint: https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    console.log(` Health check: http://${HOST}:${PORT}/health`);
});