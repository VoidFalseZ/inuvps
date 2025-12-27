// server.js - Cloudflare R2 Version

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { query, validationResult } = require('express-validator');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { promisify } = require('util');
const { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();

// --- Server Configuration ---
const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const THUMBNAIL_WIDTH = process.env.THUMBNAIL_WIDTH || 320;
const THUMBNAIL_HEIGHT = process.env.THUMBNAIL_HEIGHT || 240;

// --- Security Middleware ---
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin for video/thumbnails
    contentSecurityPolicy: false // Disable CSP for video streaming
}));
app.use(cors());
app.use(morgan('combined')); // HTTP request logging

// --- Rate Limiting ---
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// --- R2 Configuration ---
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'your-account-id';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'your-access-key-id';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'your-secret-access-key';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'anime-videos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || null; // Optional: jika pakai custom domain

const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// --- Local File and Directory Paths (untuk metadata dan thumbnail cache) ---
const CACHE_DIR = path.join(process.cwd(), "cache");
const THUMBNAIL_CACHE_DIR = path.join(CACHE_DIR, "thumbnails");
const METADATA_FILE = path.join(CACHE_DIR, "metadata.json");
const SERIES_METADATA_FILE = path.join(CACHE_DIR, "series_metadata.json");

// --- App Version and Dialog Control Flags ---
const LATEST_APP_VERSION = process.env.APP_VERSION || "1.0.1";
const SHOW_UPDATE_DIALOG_COMMAND = process.env.SHOW_UPDATE_DIALOG === 'true';

// Ensure directories exist on startup
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAIL_CACHE_DIR)) fs.mkdirSync(THUMBNAIL_CACHE_DIR, { recursive: true });


// --- R2 Helper Functions ---

// List semua video files dari R2
async function listR2Videos() {
    const command = new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: '',
    });

    try {
        const response = await s3Client.send(command);
        const videoFiles = (response.Contents || [])
            .filter(item => item.Key.endsWith('.mp4') && !item.Key.includes('/thumbnails/'))
            .map(item => ({
                filename: path.basename(item.Key),
                key: item.Key,
                lastModified: item.LastModified,
                size: item.Size
            }));
        return videoFiles;
    } catch (error) {
        console.error('Error listing R2 videos:', error);
        return [];
    }
}

// Get metadata dari R2 object
async function getR2ObjectMetadata(key) {
    const command = new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
    });

    try {
        const response = await s3Client.send(command);
        return {
            lastModified: response.LastModified,
            contentLength: response.ContentLength,
            contentType: response.ContentType
        };
    } catch (error) {
        console.error(`Error getting metadata for ${key}:`, error);
        return null;
    }
}

// Generate signed URL untuk video streaming
async function getSignedVideoUrl(key, expiresIn = 3600) {
    // Jika pakai public URL, return langsung
    if (R2_PUBLIC_URL) {
        return `${R2_PUBLIC_URL}/${key}`;
    }

    // Jika private, generate signed URL
    const command = new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
    });

    try {
        const url = await getSignedUrl(s3Client, command, { expiresIn });
        return url;
    } catch (error) {
        console.error(`Error generating signed URL for ${key}:`, error);
        return null;
    }
}

// Download file dari R2 ke local (untuk thumbnail generation)
async function downloadFromR2(key, localPath) {
    const command = new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
    });

    try {
        const response = await s3Client.send(command);
        const stream = response.Body;
        const writeStream = fs.createWriteStream(localPath);

        return new Promise((resolve, reject) => {
            stream.pipe(writeStream);
            writeStream.on('finish', () => resolve(true));
            writeStream.on('error', reject);
        });
    } catch (error) {
        console.error(`Error downloading from R2: ${key}`, error);
        return false;
    }
}

// --- Metadata Handling Functions ---

const loadMetadata = () => {
    if (fs.existsSync(METADATA_FILE)) {
        try {
            const data = fs.readFileSync(METADATA_FILE, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.warn(`Warning: ${METADATA_FILE} is empty or malformed. Returning empty object.`);
            return {};
        }
    }
    return {};
};

const saveMetadata = (metadata) => {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 4), 'utf-8');
};

const loadSeriesMetadata = () => {
    if (fs.existsSync(SERIES_METADATA_FILE)) {
        try {
            const data = fs.readFileSync(SERIES_METADATA_FILE, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.warn(`Warning: ${SERIES_METADATA_FILE} is empty or malformed. Returning empty object.`);
            return {};
        }
    }
    return {};
};

const saveSeriesMetadata = (seriesMetadata) => {
    fs.writeFileSync(SERIES_METADATA_FILE, JSON.stringify(seriesMetadata, null, 4), 'utf-8');
};

// --- Filename Parsing Functions ---

const extractEpisodeNumber = (filename) => {
    const match = filename.match(/E(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
};

const extractTitleAndEpisode = (filename) => {
    const baseName = path.parse(filename).name;
    const match = baseName.match(/(.+?)[-._ ](?:E|EP|Episode)[-._ ]?(\d+)/i);
    if (match) {
        const seriesTitle = match[1].replace(/[._]/g, ' ').trim();
        const episodeNumber = parseInt(match[2], 10);
        return { seriesTitle, episodeNumber };
    }
    return { seriesTitle: baseName.replace(/[._]/g, ' ').trim(), episodeNumber: null };
};

// --- Thumbnail Generation ---

const generateThumbnail = (videoPath, thumbnailPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: ['00:00:05.000'],
                filename: path.basename(thumbnailPath),
                folder: path.dirname(thumbnailPath),
                size: `${THUMBNAIL_WIDTH}x${THUMBNAIL_HEIGHT}`
            })
            .on('end', () => {
                console.log(`Thumbnail generated for ${path.basename(videoPath)} at ${thumbnailPath}`);
                resolve(true);
            })
            .on('error', (err) => {
                console.error(`Error generating thumbnail for ${path.basename(videoPath)}: ${err.message}`);
                reject(false);
            });
    });
};

// --- Background Thumbnail Generation ---

let thumbnailGenerationInProgress = false;
let thumbnailGenerationQueue = [];

// Generate thumbnail for a single video using signed URL (no full download needed)
const generateThumbnailForVideo = async (videoFile) => {
    const { filename, key } = videoFile;
    const thumbnailFilename = `${path.parse(filename).name}.png`;
    const thumbnailCachePath = path.join(THUMBNAIL_CACHE_DIR, thumbnailFilename);

    // Skip if thumbnail already exists
    if (fs.existsSync(thumbnailCachePath)) {
        return { filename, status: 'exists' };
    }

    try {
        // Get signed URL for the video (valid for 1 hour)
        const signedUrl = await getSignedVideoUrl(key, 3600);
        if (!signedUrl) {
            throw new Error('Could not generate signed URL');
        }

        console.log(`[Thumbnail] Generating thumbnail from stream: ${filename}`);

        // Use FFmpeg to read directly from signed URL - only fetches first few seconds
        await new Promise((resolve, reject) => {
            ffmpeg(signedUrl)
                .inputOptions([
                    '-ss', '5',           // Seek to 5 seconds
                    '-t', '1'             // Only read 1 second of video
                ])
                .outputOptions([
                    '-vframes', '1',      // Extract only 1 frame
                    '-vf', `scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:force_original_aspect_ratio=decrease,pad=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:(ow-iw)/2:(oh-ih)/2`
                ])
                .output(thumbnailCachePath)
                .on('end', () => {
                    console.log(`[Thumbnail] Generated: ${filename}`);
                    resolve(true);
                })
                .on('error', (err) => {
                    console.error(`[Thumbnail] FFmpeg error for ${filename}: ${err.message}`);
                    reject(err);
                })
                .run();
        });

        return { filename, status: 'generated' };
    } catch (error) {
        console.error(`[Thumbnail] Failed for ${filename}:`, error.message);
        return { filename, status: 'failed', error: error.message };
    }
};

// Process thumbnail generation queue
const processThumbnailQueue = async () => {
    if (thumbnailGenerationInProgress || thumbnailGenerationQueue.length === 0) {
        return;
    }

    thumbnailGenerationInProgress = true;
    console.log(`[Thumbnail] Starting queue processing. ${thumbnailGenerationQueue.length} videos pending.`);

    while (thumbnailGenerationQueue.length > 0) {
        const videoFile = thumbnailGenerationQueue.shift();
        const result = await generateThumbnailForVideo(videoFile);
        console.log(`[Thumbnail] ${result.filename}: ${result.status}`);

        // Small delay between processing to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    thumbnailGenerationInProgress = false;
    console.log(`[Thumbnail] Queue processing complete.`);
};

// Scan all videos and queue thumbnail generation for missing ones
const queueMissingThumbnails = async () => {
    console.log('[Thumbnail] Scanning for missing thumbnails...');

    const videoFiles = await listR2Videos();
    let queued = 0;
    let existing = 0;

    for (const videoFile of videoFiles) {
        const thumbnailFilename = `${path.parse(videoFile.filename).name}.png`;
        const thumbnailCachePath = path.join(THUMBNAIL_CACHE_DIR, thumbnailFilename);

        if (!fs.existsSync(thumbnailCachePath)) {
            thumbnailGenerationQueue.push(videoFile);
            queued++;
        } else {
            existing++;
        }
    }

    console.log(`[Thumbnail] Found ${existing} existing, ${queued} queued for generation.`);

    // Start processing if there are items in queue
    if (queued > 0) {
        processThumbnailQueue();
    }

    return { existing, queued, total: videoFiles.length };
};

// --- Helper Function to Get Video Details (Modified for R2) ---

const getVideoDetails = async (videoFile, metadata) => {
    const { filename, key, lastModified } = videoFile;
    const fileMtime = new Date(lastModified).toISOString().replace('T', ' ').substring(0, 19);

    let fileMetadata = metadata[filename] || {};
    let { display_title, episode_number, series_title, description } = fileMetadata;
    description = description || "No description available.";

    let metadataUpdated = false;
    if (!display_title || !series_title) {
        const { seriesTitle: extractedSeriesTitle, episodeNumber: extractedEpisodeNumber } = extractTitleAndEpisode(filename);
        if (!series_title) {
            series_title = extractedSeriesTitle;
            metadataUpdated = true;
        }
        if (!display_title) {
            display_title = extractedSeriesTitle;
            metadataUpdated = true;
        }
        if (episode_number === undefined || episode_number === null) {
            episode_number = extractedEpisodeNumber;
            metadataUpdated = true;
        }
    }

    if (metadataUpdated) {
        metadata[filename] = { display_title, episode_number, series_title, description };
        saveMetadata(metadata);
    }

    // Thumbnail handling - only use existing thumbnails, don't generate on-demand
    const thumbnailFilename = `${path.parse(filename).name}.png`;
    const thumbnailCachePath = path.join(THUMBNAIL_CACHE_DIR, thumbnailFilename);
    const thumbnailR2Key = `videos/thumbnails/${thumbnailFilename}`;

    let thumbnail_url = null;

    // First, try to get thumbnail from R2 with a signed URL
    const thumbnailMeta = await getR2ObjectMetadata(thumbnailR2Key);
    if (thumbnailMeta) {
        // Generate signed URL for R2 thumbnail
        thumbnail_url = await getSignedVideoUrl(thumbnailR2Key, 86400); // 24 hour expiry
    } else if (fs.existsSync(thumbnailCachePath)) {
        // Use local cache if available
        thumbnail_url = `/thumbnails/${thumbnailFilename}`;
    }
    // If no thumbnail exists, leave as null - background queue will generate it

    // Generate signed URL untuk video
    const videoUrl = await getSignedVideoUrl(key);

    return {
        filename,
        url: videoUrl || `/video/${filename}`,
        thumbnail_url,
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

// --- Health Check Endpoint ---
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

    const htmlTemplate = `
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
            a:hover { text-decoration: underline; }
            small { color: #888; }
        </style>
    </head>
    <body>
        <h1>Available Videos (from R2)</h1>
        <ul>${fileListItems}</ul>
    </body>
    </html>
    `;
    res.send(htmlTemplate);
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
        allVideosData = allVideosData.filter(v => v.series_title && v.series_title.toLowerCase() === series_title.toLowerCase());
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
            const { series_title, thumbnail_url, last_modified, description } = video;
            if (!seriesInfo.has(series_title)) {
                seriesInfo.set(series_title, {
                    count: 0,
                    thumbnail_url: null,
                    last_modified: '1970-01-01 00:00:00',
                    description: "No description available."
                });
            }

            const currentSeries = seriesInfo.get(series_title);
            currentSeries.count++;
            if (!currentSeries.thumbnail_url) {
                currentSeries.thumbnail_url = thumbnail_url;
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

    res.json(result);
});

app.get('/api/series/:series_title', async (req, res) => {
    const { series_title } = req.params;
    const metadata = loadMetadata();
    const videoFiles = await listR2Videos();

    let seriesVideosData = (await Promise.all(
        videoFiles.map(file => getVideoDetails(file, metadata))
    )).filter(v => v && v.series_title && v.series_title.toLowerCase() === series_title.toLowerCase());

    seriesVideosData.sort((a, b) => {
        const epA = a.episode_number !== null ? a.episode_number : Infinity;
        const epB = b.episode_number !== null ? b.episode_number : Infinity;
        if (epA !== epB) {
            return epA - epB;
        }
        return a.filename.localeCompare(b.filename);
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

// --- Thumbnail Generation API ---

// Get thumbnail generation status
app.get('/api/thumbnails/status', (req, res) => {
    res.json({
        in_progress: thumbnailGenerationInProgress,
        queue_length: thumbnailGenerationQueue.length,
        cache_dir: THUMBNAIL_CACHE_DIR
    });
});

// Trigger thumbnail generation for all missing thumbnails
app.post('/api/thumbnails/generate', async (req, res) => {
    try {
        const result = await queueMissingThumbnails();
        res.json({
            success: true,
            message: `Thumbnail generation started`,
            ...result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// List all cached thumbnails
app.get('/api/thumbnails/list', (req, res) => {
    try {
        const files = fs.readdirSync(THUMBNAIL_CACHE_DIR);
        const thumbnails = files.filter(f => f.endsWith('.png')).map(f => ({
            filename: f,
            url: `/thumbnails/${f}`
        }));
        res.json({
            count: thumbnails.length,
            thumbnails
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Static File Serving ---

app.use('/thumbnails', express.static(THUMBNAIL_CACHE_DIR));

// --- Video Streaming Route (Modified for R2) ---

app.get('/video/:filename', async (req, res) => {
    const { filename } = req.params;
    const videoFiles = await listR2Videos();
    const videoFile = videoFiles.find(f => f.filename === filename);

    if (!videoFile) {
        return res.status(404).send('File not found');
    }

    // Jika pakai public URL, redirect saja
    if (R2_PUBLIC_URL) {
        const publicUrl = `${R2_PUBLIC_URL}/${videoFile.key}`;
        return res.redirect(publicUrl);
    }

    // Jika private, streaming via signed URL atau proxy
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

            // Get range dari R2
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
        console.error('Error streaming video:', error);
        res.status(500).send('Error streaming video');
    }
});

// --- Global Error Handler ---
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// --- 404 Handler ---
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// --- Start Server ---

app.listen(PORT, HOST, async () => {
    console.log(`✅ Server is running at http://${HOST}:${PORT}`);
    console.log(`📦 R2 Bucket: ${R2_BUCKET_NAME}`);
    console.log(`🔗 R2 Endpoint: https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    console.log(`🩺 Health check: http://${HOST}:${PORT}/health`);

    // Start background thumbnail generation
    console.log('\n🖼️  Starting automatic thumbnail generation...');
    try {
        await queueMissingThumbnails();
    } catch (error) {
        console.error('Error starting thumbnail generation:', error.message);
    }
});