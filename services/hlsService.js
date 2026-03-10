// services/hlsService.js - HLS transcoding with adaptive bitrate streaming
// Converts MP4 videos to HLS format with multiple quality renditions,
// stores segments in R2, and serves via CDN for mobile-friendly adaptive streaming.

const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const { execSync } = require('child_process');
const config = require('../config');
const r2Service = require('./r2Service');

// ─── FFmpeg Setup (mirrors thumbnailService.js pattern) ──────────────────────

let ffmpegPath, ffprobePath;
try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    execSync('which ffprobe', { stdio: 'ignore' });
    ffmpegPath = 'ffmpeg';
    ffprobePath = 'ffprobe';
    console.log('[HLS] Using system FFmpeg');
} catch {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    ffprobePath = require('@ffprobe-installer/ffprobe').path;
    console.log('[HLS] Using npm package FFmpeg');
}
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ─── HLS Service Class ────────────────────────────────────────────────────────

class HLSService {
    constructor() {
        this.queue = [];           // Pending transcode jobs
        this.processing = new Set();  // Currently active filenames
        this.progress = new Map(); // filename -> { percent, status, qualities }
        this.failed = new Map();   // filename -> { error, failedAt }
        this.maxConcurrent = config.HLS.MAX_CONCURRENT;
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    /**
     * Queue a video for HLS transcoding (non-blocking).
     * Skips if already done or in progress.
     * @param {string} filename - Original MP4 filename (e.g. "video.mp4")
     * @param {string} videoUrl - Accessible URL of the video (from R2)
     * @param {object} options  - { qualities?: string[], force?: boolean }
     */
    async queueVideo(filename, videoUrl, options = {}) {
        const force = options.force || false;

        // Avoid re-queuing
        if (this.processing.has(filename)) {
            console.log(`[HLS] Already processing: ${filename}`);
            return { status: 'processing', filename };
        }
        if (this.queue.some(j => j.filename === filename)) {
            console.log(`[HLS] Already queued: ${filename}`);
            return { status: 'queued', filename };
        }

        // Check if HLS already exists in R2 (unless forcing)
        if (!force) {
            const exists = await this.hasHLS(filename);
            if (exists) {
                console.log(`[HLS] Already complete, skipping: ${filename}`);
                this.progress.set(filename, { percent: 100, status: 'done', qualities: options.qualities || Object.keys(config.HLS.QUALITIES) });
                return { status: 'done', filename, url: this.getHlsUrl(filename) };
            }
        }

        this.queue.push({ filename, videoUrl, options });
        console.log(`[HLS] Queued: ${filename} (queue size: ${this.queue.length})`);
        this._processQueue();
        return { status: 'queued', filename };
    }

    /**
     * Transcode one video to HLS with multiple quality renditions.
     * Creates a temp dir, runs FFmpeg per quality, writes master.m3u8, then uploads.
     * @param {string} filename
     * @param {string} videoUrl
     * @param {object} options
     * @returns {Promise<string>} Public URL to master.m3u8
     */
    async transcodeToHLS(filename, videoUrl, options = {}) {
        const qualityNames = options.qualities || Object.keys(config.HLS.QUALITIES);
        const basename = filename.replace(/\.[^/.]+$/, ''); // strip extension
        const tmpDir = path.join(os.tmpdir(), `hls_${basename}_${Date.now()}`);

        console.log(`[HLS] Starting transcode: ${filename} -> ${qualityNames.join(', ')}`);
        this.progress.set(filename, { percent: 0, status: 'transcoding', qualities: qualityNames });

        try {
            // Create temp directory tree
            fs.mkdirSync(tmpDir, { recursive: true });
            for (const q of qualityNames) {
                fs.mkdirSync(path.join(tmpDir, q), { recursive: true });
            }

            // Transcode each quality (sequential — avoids thrashing CPU/memory)
            for (let i = 0; i < qualityNames.length; i++) {
                const qualityName = qualityNames[i];
                const qualityCfg = config.HLS.QUALITIES[qualityName];
                if (!qualityCfg) {
                    console.warn(`[HLS] Unknown quality "${qualityName}", skipping`);
                    continue;
                }

                const percent = Math.round((i / qualityNames.length) * 70); // 0–70% for transcode
                this.progress.set(filename, { percent, status: `transcoding_${qualityName}`, qualities: qualityNames });

                await this._transcodeQuality(videoUrl, tmpDir, qualityName, qualityCfg);
                console.log(`[HLS] Quality ${qualityName} done for ${filename}`);
            }

            // Write master playlist (HLS spec: sorted by bandwidth ascending)
            this.progress.set(filename, { percent: 72, status: 'writing_master', qualities: qualityNames });
            this._writeMasterPlaylist(tmpDir, qualityNames);

            // Upload all HLS files to R2
            this.progress.set(filename, { percent: 75, status: 'uploading', qualities: qualityNames });
            await this.uploadHLSToR2(tmpDir, filename);

            const masterUrl = this.getHlsUrl(filename);
            this.progress.set(filename, { percent: 100, status: 'done', qualities: qualityNames });
            console.log(`[HLS] Complete: ${filename} -> ${masterUrl}`);

            return masterUrl;
        } finally {
            // Always clean up temp directory
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                console.log(`[HLS] Cleaned up temp dir: ${tmpDir}`);
            } catch (e) {
                console.warn(`[HLS] Failed to clean up temp dir ${tmpDir}:`, e.message);
            }
        }
    }

    /**
     * Upload all .m3u8 and .ts files from a local HLS output directory to R2.
     * @param {string} localPath - Root temp directory containing quality subdirs + master.m3u8
     * @param {string} filename  - Original video filename (e.g. "video.mp4")
     */
    async uploadHLSToR2(localPath, filename) {
        const basename = filename.replace(/\.[^/.]+$/, '');
        const r2Prefix = `hls/${basename}`;
        const files = this._walkDir(localPath);

        console.log(`[HLS] Uploading ${files.length} files to R2 under ${r2Prefix}/`);

        let uploaded = 0;
        for (const filePath of files) {
            const relPath = path.relative(localPath, filePath).replace(/\\/g, '/');
            const r2Key = `${r2Prefix}/${relPath}`;
            const ext = path.extname(filePath).toLowerCase();

            const contentType = ext === '.m3u8'
                ? 'application/vnd.apple.mpegurl'
                : 'video/MP2T'; // .ts segments

            const body = fs.readFileSync(filePath);
            await r2Service.putObject(r2Key, body, contentType);
            uploaded++;

            if (uploaded % 10 === 0) {
                const uploadPercent = 75 + Math.round((uploaded / files.length) * 25);
                this.progress.set(filename, {
                    percent: Math.min(uploadPercent, 99),
                    status: 'uploading',
                    qualities: this.progress.get(filename)?.qualities || []
                });
            }
        }

        console.log(`[HLS] Uploaded ${uploaded} files for ${filename}`);
    }

    /**
     * Check if a complete HLS version exists for a video (master.m3u8 in R2).
     * @param {string} filename
     * @returns {Promise<boolean>}
     */
    async hasHLS(filename) {
        const basename = filename.replace(/\.[^/.]+$/, '');
        const key = `hls/${basename}/master.m3u8`;
        try {
            await r2Service.headObject(key);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get the CDN URL for a video's HLS master playlist.
     * Returns null if R2_PUBLIC_URL is not configured.
     * @param {string} filename
     * @returns {string|null}
     */
    getHlsUrl(filename) {
        if (!config.R2.PUBLIC_URL) return null;
        const basename = filename.replace(/\.[^/.]+$/, '');
        return `${config.R2.PUBLIC_URL}/hls/${basename}/master.m3u8`;
    }

    /**
     * Get transcoding progress for a given video.
     * @param {string} filename
     * @returns {{ percent: number, status: string, qualities: string[] }}
     */
    getProgress(filename) {
        return this.progress.get(filename) || { percent: 0, status: 'not_started', qualities: [] };
    }

    /**
     * Get overall service status (queue, active jobs, failed).
     * @returns {object}
     */
    getStatus() {
        const progress = {};
        for (const [k, v] of this.progress) progress[k] = v;

        return {
            currently_processing: Array.from(this.processing),
            queue_size: this.queue.length,
            queued: this.queue.map(j => j.filename),
            failed_count: this.failed.size,
            failed: Object.fromEntries(this.failed),
            progress
        };
    }

    // ─── Internal Helpers ──────────────────────────────────────────────────────

    /**
     * Transcode video to a single quality using fluent-ffmpeg.
     * Generates {quality}/playlist.m3u8 and {quality}/segment_NNN.ts files.
     */
    _transcodeQuality(videoUrl, tmpDir, qualityName, qualityCfg) {
        const { width, height, videoBitrate, audioBitrate } = qualityCfg;
        const { SEGMENT_DURATION, KEYFRAME_INTERVAL, PRESET } = config.HLS;

        const outputDir = path.join(tmpDir, qualityName);
        const playlistPath = path.join(outputDir, 'playlist.m3u8');
        const segmentPattern = path.join(outputDir, 'segment_%03d.ts');

        return new Promise((resolve, reject) => {
            ffmpeg(videoUrl)
                .outputOptions([
                    `-vf scale=${width}:${height}`,
                    `-c:v libx264`,
                    `-preset ${PRESET}`,
                    `-b:v ${videoBitrate}`,
                    `-maxrate ${videoBitrate}`,
                    `-bufsize ${parseInt(videoBitrate) * 2}k`,
                    `-g ${KEYFRAME_INTERVAL}`,           // GOP size = keyframe interval
                    `-sc_threshold 0`,                   // No scene-change keyframes
                    `-c:a aac`,
                    `-b:a ${audioBitrate}`,
                    `-ac 2`,                             // Force stereo
                    `-f hls`,
                    `-hls_time ${SEGMENT_DURATION}`,
                    `-hls_list_size 0`,                  // Keep all segments in playlist
                    `-hls_segment_filename ${segmentPattern}`,
                    `-hls_flags independent_segments`,
                ])
                .output(playlistPath)
                .on('start', cmd => console.log(`[HLS FFmpeg] ${qualityName}: ${cmd.substring(0, 120)}...`))
                .on('progress', p => {
                    // Progress events fire but percent can be NaN for stream inputs — just log it
                    if (p.percent && !isNaN(p.percent)) {
                        console.log(`[HLS FFmpeg] ${qualityName}: ${p.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => resolve())
                .on('error', err => {
                    console.error(`[HLS FFmpeg] ${qualityName} error:`, err.message);
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Write the HLS master playlist that references all quality renditions.
     * Renditions are listed from lowest to highest bandwidth per HLS spec.
     */
    _writeMasterPlaylist(tmpDir, qualityNames) {
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

        // Sort quality names by bandwidth ascending
        const sorted = [...qualityNames].sort((a, b) => {
            const bwA = parseInt(config.HLS.QUALITIES[a]?.videoBitrate || '0');
            const bwB = parseInt(config.HLS.QUALITIES[b]?.videoBitrate || '0');
            return bwA - bwB;
        });

        for (const qualityName of sorted) {
            const q = config.HLS.QUALITIES[qualityName];
            if (!q) continue;

            const videoBw = parseInt(q.videoBitrate) * 1000;   // k -> bps
            const audioBw = parseInt(q.audioBitrate) * 1000;
            const totalBw = videoBw + audioBw;

            lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${totalBw},RESOLUTION=${q.width}x${q.height},CODECS="avc1.42e01e,mp4a.40.2",NAME="${qualityName}"`);
            lines.push(`${qualityName}/playlist.m3u8`);
        }

        const masterPath = path.join(tmpDir, 'master.m3u8');
        fs.writeFileSync(masterPath, lines.join('\n') + '\n', 'utf8');
        console.log(`[HLS] Master playlist written: ${masterPath}`);
    }

    /**
     * Recursively list all files in a directory (only .m3u8 and .ts).
     */
    _walkDir(dir) {
        const results = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...this._walkDir(fullPath));
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (ext === '.m3u8' || ext === '.ts') {
                    results.push(fullPath);
                }
            }
        }
        return results;
    }

    /**
     * Internal queue processor — pulls jobs from queue respecting maxConcurrent.
     */
    async _processQueue() {
        while (this.queue.length > 0 && this.processing.size < this.maxConcurrent) {
            const job = this.queue.shift();
            if (!job) break;

            this.processing.add(job.filename);
            console.log(`[HLS] Starting job: ${job.filename} (active: ${this.processing.size}/${this.maxConcurrent})`);

            this.transcodeToHLS(job.filename, job.videoUrl, job.options)
                .then(() => {
                    this.failed.delete(job.filename);
                })
                .catch(err => {
                    console.error(`[HLS] Job failed: ${job.filename}:`, err.message);
                    this.failed.set(job.filename, { error: err.message, failedAt: new Date().toISOString() });
                    this.progress.set(job.filename, { percent: 0, status: 'failed', qualities: job.options.qualities || [] });
                })
                .finally(() => {
                    this.processing.delete(job.filename);
                    console.log(`[HLS] Job finished: ${job.filename} (active: ${this.processing.size})`);
                    // Process next item in queue
                    this._processQueue();
                });
        }
    }
}

// Export a singleton instance
const hlsService = new HLSService();
module.exports = hlsService;
