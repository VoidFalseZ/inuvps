require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const { query, validationResult } = require('express-validator');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// --- Configuration ---
const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'anime-videos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const APP_VERSION = process.env.APP_VERSION || '1.0.1';
const SHOW_UPDATE_DIALOG = process.env.SHOW_UPDATE_DIALOG === 'true';

// --- Local Cache ---
const CACHE_DIR = path.join(process.cwd(), 'cache');
const METADATA_FILE = path.join(CACHE_DIR, 'metadata.json');
const THUMBNAIL_DIR = path.join(CACHE_DIR, 'thumbnails');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`Created directory: ${CACHE_DIR}`);
}
if (!fs.existsSync(THUMBNAIL_DIR)) {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
    console.log(`Created directory: ${THUMBNAIL_DIR}`);
}

// --- S3Client Setup ---
const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
    }
});

// --- Helper Functions ---

async function listR2Videos() {
    console.log('Fetching videos from R2...');
    try {
        let isTruncated = true;
        let continuationToken = undefined;
        let videos = [];

        while (isTruncated) {
            const command = new ListObjectsV2Command({
                Bucket: R2_BUCKET_NAME,
                ContinuationToken: continuationToken
            });
            const response = await s3Client.send(command);

            if (response.Contents) {
                const mp4Files = response.Contents.filter(item => item.Key.endsWith('.mp4'));
                mp4Files.forEach(item => {
                    videos.push({
                        filename: item.Key.split('/').pop(),
                        key: item.Key,
                        lastModified: item.LastModified,
                        size: item.Size
                    });
                });
            }

            isTruncated = response.IsTruncated;
            continuationToken = response.NextContinuationToken;
        }

        return videos;
    } catch (error) {
        console.error('Error listing R2 videos:', error);
        return [];
    }
}

async function getSignedVideoUrl(key, expiresIn = 3600) {
    if (R2_PUBLIC_URL) {
        return `${R2_PUBLIC_URL.replace(/\/$/, '')}/${encodeURIComponent(key)}`;
    }

    try {
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key
        });
        return await getSignedUrl(s3Client, command, { expiresIn });
    } catch (error) {
        console.error(`Error generating signed URL for ${key}:`, error);
        return null;
    }
}

function loadMetadata() {
    try {
        if (fs.existsSync(METADATA_FILE)) {
            const data = fs.readFileSync(METADATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading metadata:', error);
    }
    return {};
}

function saveMetadata(metadata) {
    try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving metadata:', error);
    }
}

const generatingThumbnails = new Set();

async function generateThumbnail(videoKey, outputFilename) {
    const outputPath = path.join(THUMBNAIL_DIR, outputFilename);
    const publicPath = `/thumbnails/${outputFilename}`;

    if (fs.existsSync(outputPath)) {
        return publicPath;
    }

    const lockKey = `${videoKey}_${outputFilename}`;
    if (generatingThumbnails.has(lockKey)) {
        return null;
    }

    generatingThumbnails.add(lockKey);
    console.log(`Generating thumbnail for ${videoKey} to ${outputFilename}`);

    try {
        const videoUrl = await getSignedVideoUrl(videoKey, 300);
        if (!videoUrl) {
            generatingThumbnails.delete(lockKey);
            return null;
        }

        return await new Promise((resolve) => {
            ffmpeg(videoUrl)
                .on('end', () => {
                    console.log(`Successfully generated thumbnail: ${outputFilename}`);
                    generatingThumbnails.delete(lockKey);
                    resolve(publicPath);
                })
                .on('error', (err) => {
                    console.error(`Error generating thumbnail for ${videoKey}:`, err);
                    generatingThumbnails.delete(lockKey);
                    resolve(null);
                })
                .screenshots({
                    timestamps: ['20%'],
                    filename: outputFilename,
                    folder: THUMBNAIL_DIR,
                    size: '320x180'
                });
        });
    } catch (err) {
        console.error(`Exception in generateThumbnail for ${videoKey}:`, err);
        generatingThumbnails.delete(lockKey);
        return null;
    }
}

function extractTitleAndEpisode(filename) {
    const baseName = filename.replace(/\.[^/.]+$/, "");

    // Pattern 1: SeriesName--EpisodeNumber (e.g. "ReZero--22_720p")
    let match = baseName.match(/^(.*?)--(\d+)(?:_.*)?$/);
    if (match) {
        return {
            seriesTitle: match[1].replace(/-/g, ' ').trim(),
            episodeNumber: parseInt(match[2], 10)
        };
    }

    // Pattern 2: SeriesName E/EP/Episode Number (e.g. "ReZero-Episode-22")
    match = baseName.match(/^(.*?)(?:-|_|\s)+(?:E|EP|Episode)(?:-|_|\s)*(\d+)(?:_.*)?$/i);
    if (match) {
        return {
            seriesTitle: match[1].replace(/-/g, ' ').trim(),
            episodeNumber: parseInt(match[2], 10)
        };
    }

    // Fallback
    return {
        seriesTitle: baseName.replace(/-/g, ' ').trim(),
        episodeNumber: null
    };
}

async function getVideoDetails(videoFile, metadata) {
    const baseData = extractTitleAndEpisode(videoFile.filename);

    let fileMeta = metadata[videoFile.filename];
    let isUpdated = false;

    if (!fileMeta) {
        fileMeta = {
            display_title: baseData.episodeNumber !== null ? `${baseData.seriesTitle} - Episode ${baseData.episodeNumber}` : baseData.seriesTitle,
            episode_number: baseData.episodeNumber,
            series_title: baseData.seriesTitle,
            description: ""
        };
        metadata[videoFile.filename] = fileMeta;
        isUpdated = true;
    }

    if (isUpdated) {
        saveMetadata(metadata);
    }

    const basename = videoFile.filename.replace(/\.[^/.]+$/, "");
    let thumbnailUrl = null;

    if (fs.existsSync(path.join(THUMBNAIL_DIR, `${basename}.png`))) {
        thumbnailUrl = `/thumbnails/${basename}.png`;
    } else if (fs.existsSync(path.join(THUMBNAIL_DIR, `${basename}.jpg`))) {
        thumbnailUrl = `/thumbnails/${basename}.jpg`;
    } else {
        // Trigger thumbnail generation in the background
        generateThumbnail(videoFile.key, `${basename}.png`).catch(err => console.error(err));
    }

    const url = await getSignedVideoUrl(videoFile.key);

    return {
        filename: videoFile.filename,
        url: url,
        thumbnail_url: thumbnailUrl,
        last_modified: videoFile.lastModified,
        display_title: fileMeta.display_title,
        episode_number: fileMeta.episode_number,
        series_title: fileMeta.series_title,
        description: fileMeta.description || ""
    };
}

// --- Middleware ---
const app = express();

app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false
}));

app.use(cors());
app.use(morgan('combined'));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
});

app.set('trust proxy', false);
app.use('/api/', limiter); // Apply to API routes

// --- Static Files ---
app.use('/thumbnails', express.static(THUMBNAIL_DIR));

// --- API Routes ---

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: APP_VERSION,
        r2_bucket: R2_BUCKET_NAME
    });
});

app.get('/', async (req, res) => {
    try {
        const videos = await listR2Videos();
        let html = `<!DOCTYPE html><html><head><title>Video List</title></head><body><h1>Available Videos</h1><ul>`;
        for (const v of videos) {
            html += `<li><a href="/video/${encodeURIComponent(v.filename)}">${v.filename}</a></li>`;
        }
        html += `</ul></body></html>`;
        res.send(html);
    } catch (error) {
        console.error('Error rendering index:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/api/app_version', (req, res) => {
    res.json({ latest_version: APP_VERSION });
});

app.get('/api/show_update_dialog_command', (req, res) => {
    res.json({ show_dialog: SHOW_UPDATE_DIALOG });
});

app.get('/api/videos', async (req, res) => {
    try {
        const filterSeries = req.query.series_title;
        const r2Videos = await listR2Videos();
        const metadata = loadMetadata();

        let detailedVideos = await Promise.all(r2Videos.map(v => getVideoDetails(v, metadata)));

        if (filterSeries) {
            detailedVideos = detailedVideos.filter(v => v.series_title && v.series_title.toLowerCase() === filterSeries.toLowerCase());
            detailedVideos.sort((a, b) => {
                const epA = a.episode_number !== null ? a.episode_number : Infinity;
                const epB = b.episode_number !== null ? b.episode_number : Infinity;
                if (epA !== epB) return epA - epB;
                return new Date(b.last_modified) - new Date(a.last_modified);
            });
        } else {
            detailedVideos.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
        }

        res.json(detailedVideos);
    } catch (error) {
        console.error("Error in /api/videos:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/api/series', async (req, res) => {
    try {
        const r2Videos = await listR2Videos();
        const metadata = loadMetadata();

        const detailedVideos = await Promise.all(r2Videos.map(v => getVideoDetails(v, metadata)));
        const seriesMap = new Map();

        for (const video of detailedVideos) {
            if (!video.series_title) continue;

            if (!seriesMap.has(video.series_title)) {
                seriesMap.set(video.series_title, {
                    series_title: video.series_title,
                    video_count: 0,
                    last_modified: video.last_modified,
                    description: video.description
                });
            }

            const series = seriesMap.get(video.series_title);
            series.video_count++;
            if (new Date(video.last_modified) > new Date(series.last_modified)) {
                series.last_modified = video.last_modified;
            }
        }

        const seriesList = Array.from(seriesMap.values());
        seriesList.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));

        res.json(seriesList);
    } catch (error) {
        console.error("Error in /api/series:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/api/series/:series_title', async (req, res) => {
    try {
        const seriesTitle = req.params.series_title;
        const r2Videos = await listR2Videos();
        const metadata = loadMetadata();

        let detailedVideos = await Promise.all(r2Videos.map(v => getVideoDetails(v, metadata)));
        detailedVideos = detailedVideos.filter(v => v.series_title && v.series_title.toLowerCase() === seriesTitle.toLowerCase());

        detailedVideos.sort((a, b) => {
            const epA = a.episode_number !== null ? a.episode_number : Infinity;
            const epB = b.episode_number !== null ? b.episode_number : Infinity;
            return epA !== epB ? epA - epB : new Date(b.last_modified) - new Date(a.last_modified);
        });

        res.json(detailedVideos);
    } catch (error) {
        console.error("Error in /api/series/:series_title:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/api/search', [
    query('q').trim().escape()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const q = (req.query.q || '').toLowerCase();
        if (!q) {
            return res.json([]);
        }

        const r2Videos = await listR2Videos();
        const metadata = loadMetadata();

        const detailedVideos = await Promise.all(r2Videos.map(v => getVideoDetails(v, metadata)));

        const results = detailedVideos.filter(v =>
            v.filename.toLowerCase().includes(q) ||
            (v.display_title && v.display_title.toLowerCase().includes(q)) ||
            (v.series_title && v.series_title.toLowerCase().includes(q)) ||
            (v.description && v.description.toLowerCase().includes(q))
        );

        results.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
        res.json(results);
    } catch (error) {
        console.error("Error in /api/search:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/video/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const r2Videos = await listR2Videos();
        const videoFile = r2Videos.find(v => v.filename === filename);

        if (!videoFile) {
            return res.status(404).json({ error: "Video not found" });
        }

        if (R2_PUBLIC_URL) {
            return res.redirect(`${R2_PUBLIC_URL.replace(/\/$/, '')}/${encodeURIComponent(videoFile.key)}`);
        }

        const commandParams = {
            Bucket: R2_BUCKET_NAME,
            Key: videoFile.key
        };

        const range = req.headers.range;
        if (range) {
            commandParams.Range = range;
        }

        const command = new GetObjectCommand(commandParams);
        const s3Response = await s3Client.send(command);

        if (s3Response.ContentRange) {
            res.status(206);
            res.set('Content-Range', s3Response.ContentRange);
        } else {
            res.status(200);
        }

        res.set({
            'Content-Length': s3Response.ContentLength,
            'Content-Type': s3Response.ContentType || 'video/mp4',
            'Accept-Ranges': 'bytes'
        });

        s3Response.Body.pipe(res);

    } catch (error) {
        if (error.name === 'NoSuchKey') {
            res.status(404).json({ error: "Video not found in bucket" });
        } else {
            console.error("Error serving video:", error);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
});

// --- Error Handling ---

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint Not Found' });
});

app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

// --- Server Start ---

app.listen(PORT, HOST, () => {
    console.log(`Server currently running on http://${HOST}:${PORT}`);
    console.log(`R2 Bucket in use: ${R2_BUCKET_NAME}`);
    console.log(`Health Check available at: http://${HOST}:${PORT}/health`);
});
