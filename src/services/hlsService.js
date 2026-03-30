// src/services/hlsService.js — HLS transcoding with adaptive bitrate streaming
// Converts MP4 → multi-quality HLS, stores segments in R2, serves via CDN.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');
const r2Service = require('./r2Service');
const { ffmpeg } = require('../utils/ffmpeg');
const { createLogger } = require('../utils/logger');
const { MIME_TYPES } = require('../constants');

const log = createLogger('HLS');

// Progress entries older than this are auto-pruned
const PROGRESS_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

class HLSService {
    constructor() {
        this.queue = [];
        this.processing = new Set();
        this.progress = new Map();   // filename → { percent, status, qualities, updatedAt }
        this.failed = new Map();
        this.maxConcurrent = config.HLS.MAX_CONCURRENT;

        // Periodically prune stale progress entries
        this._pruneInterval = setInterval(() => this._pruneProgress(), 30 * 60 * 1000);
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    async queueVideo(filename, videoUrl, options = {}) {
        const force = options.force || false;

        if (this.processing.has(filename)) {
            log.info(`Already processing: ${filename}`);
            return { status: 'processing', filename };
        }
        if (this.queue.some(j => j.filename === filename)) {
            log.info(`Already queued: ${filename}`);
            return { status: 'queued', filename };
        }

        if (!force) {
            const exists = await this.hasHLS(filename);
            if (exists) {
                log.info(`Already complete, skipping: ${filename}`);
                this.progress.set(filename, {
                    percent: 100,
                    status: 'done',
                    qualities: options.qualities || Object.keys(config.HLS.QUALITIES),
                    updatedAt: Date.now(),
                });
                return { status: 'done', filename, url: this.getHlsUrl(filename) };
            }
        }

        this.queue.push({ filename, videoUrl, options });
        log.info(`Queued: ${filename} (queue size: ${this.queue.length})`);
        this._processQueue();
        return { status: 'queued', filename };
    }

    async transcodeToHLS(filename, videoUrl, options = {}) {
        const qualityNames = options.qualities || Object.keys(config.HLS.QUALITIES);
        const basename = filename.replace(/\.[^/.]+$/, '');
        const tmpDir = path.join(os.tmpdir(), `hls_${basename}_${Date.now()}`);

        log.info(`Starting transcode: ${filename} → ${qualityNames.join(', ')}`);
        this._setProgress(filename, 0, 'transcoding', qualityNames);

        try {
            fs.mkdirSync(tmpDir, { recursive: true });
            for (const q of qualityNames) {
                fs.mkdirSync(path.join(tmpDir, q), { recursive: true });
            }

            for (let i = 0; i < qualityNames.length; i++) {
                const qualityName = qualityNames[i];
                const qualityCfg = config.HLS.QUALITIES[qualityName];
                if (!qualityCfg) {
                    log.warn(`Unknown quality "${qualityName}", skipping`);
                    continue;
                }

                const percent = Math.round((i / qualityNames.length) * 70);
                this._setProgress(filename, percent, `transcoding_${qualityName}`, qualityNames);
                await this._transcodeQuality(videoUrl, tmpDir, qualityName, qualityCfg);
                log.info(`Quality ${qualityName} done for ${filename}`);
            }

            this._setProgress(filename, 72, 'writing_master', qualityNames);
            this._writeMasterPlaylist(tmpDir, qualityNames);

            this._setProgress(filename, 75, 'uploading', qualityNames);
            await this._uploadHLSToR2(tmpDir, filename);

            const masterUrl = this.getHlsUrl(filename);
            this._setProgress(filename, 100, 'done', qualityNames);
            log.info(`Complete: ${filename} → ${masterUrl}`);
            return masterUrl;
        } finally {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                log.debug(`Cleaned up temp dir: ${tmpDir}`);
            } catch (e) {
                log.warn(`Failed to clean up temp dir:`, e.message);
            }
        }
    }

    async hasHLS(filename) {
        const basename = filename.replace(/\.[^/.]+$/, '');
        try {
            await r2Service.headObject(`hls/${basename}/master.m3u8`);
            return true;
        } catch {
            return false;
        }
    }

    getHlsUrl(filename) {
        if (!config.R2.PUBLIC_URL) return null;
        const basename = filename.replace(/\.[^/.]+$/, '');
        return `${config.R2.PUBLIC_URL}/hls/${basename}/master.m3u8`;
    }

    getProgress(filename) {
        return this.progress.get(filename) || { percent: 0, status: 'not_started', qualities: [] };
    }

    getStatus() {
        const progress = {};
        for (const [k, v] of this.progress) progress[k] = v;

        return {
            currently_processing: Array.from(this.processing),
            queue_size: this.queue.length,
            queued: this.queue.map(j => j.filename),
            failed_count: this.failed.size,
            failed: Object.fromEntries(this.failed),
            progress,
        };
    }

    /**
     * Stop periodic cleanups (for graceful shutdown).
     */
    destroy() {
        if (this._pruneInterval) {
            clearInterval(this._pruneInterval);
            this._pruneInterval = null;
        }
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    _setProgress(filename, percent, status, qualities) {
        this.progress.set(filename, { percent, status, qualities, updatedAt: Date.now() });
    }

    _pruneProgress() {
        const now = Date.now();
        let pruned = 0;
        for (const [filename, entry] of this.progress) {
            if (entry.status === 'done' && (now - entry.updatedAt) > PROGRESS_MAX_AGE_MS) {
                this.progress.delete(filename);
                pruned++;
            }
        }
        if (pruned > 0) log.debug(`Pruned ${pruned} stale progress entries`);
    }

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
                    `-g ${KEYFRAME_INTERVAL}`,
                    `-sc_threshold 0`,
                    `-c:a aac`,
                    `-b:a ${audioBitrate}`,
                    `-ac 2`,
                    `-f hls`,
                    `-hls_time ${SEGMENT_DURATION}`,
                    `-hls_list_size 0`,
                    `-hls_segment_filename ${segmentPattern}`,
                    `-hls_flags independent_segments`,
                ])
                .output(playlistPath)
                .on('start', cmd => log.debug(`${qualityName}: ${cmd.substring(0, 120)}...`))
                .on('progress', p => {
                    if (p.percent && !isNaN(p.percent)) {
                        log.debug(`${qualityName}: ${p.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => resolve())
                .on('error', err => {
                    log.error(`${qualityName} error:`, err.message);
                    reject(err);
                })
                .run();
        });
    }

    _writeMasterPlaylist(tmpDir, qualityNames) {
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

        const sorted = [...qualityNames].sort((a, b) => {
            const bwA = parseInt(config.HLS.QUALITIES[a]?.videoBitrate || '0');
            const bwB = parseInt(config.HLS.QUALITIES[b]?.videoBitrate || '0');
            return bwA - bwB;
        });

        for (const qualityName of sorted) {
            const q = config.HLS.QUALITIES[qualityName];
            if (!q) continue;

            const videoBw = parseInt(q.videoBitrate) * 1000;
            const audioBw = parseInt(q.audioBitrate) * 1000;
            const totalBw = videoBw + audioBw;

            lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${totalBw},RESOLUTION=${q.width}x${q.height},CODECS="avc1.42e01e,mp4a.40.2",NAME="${qualityName}"`);
            lines.push(`${qualityName}/playlist.m3u8`);
        }

        const masterPath = path.join(tmpDir, 'master.m3u8');
        fs.writeFileSync(masterPath, lines.join('\n') + '\n', 'utf8');
        log.info(`Master playlist written`);
    }

    async _uploadHLSToR2(localPath, filename) {
        const basename = filename.replace(/\.[^/.]+$/, '');
        const r2Prefix = `hls/${basename}`;
        const files = this._walkDir(localPath);

        log.info(`Uploading ${files.length} files to R2 under ${r2Prefix}/`);

        let uploaded = 0;
        for (const filePath of files) {
            const relPath = path.relative(localPath, filePath).replace(/\\/g, '/');
            const r2Key = `${r2Prefix}/${relPath}`;
            const ext = path.extname(filePath).toLowerCase();

            const contentType = ext === '.m3u8'
                ? MIME_TYPES.HLS_PLAYLIST
                : MIME_TYPES.HLS_SEGMENT;

            const body = fs.readFileSync(filePath);
            await r2Service.putObject(r2Key, body, contentType);
            uploaded++;

            if (uploaded % 10 === 0) {
                const uploadPercent = 75 + Math.round((uploaded / files.length) * 25);
                this._setProgress(filename, Math.min(uploadPercent, 99), 'uploading',
                    this.progress.get(filename)?.qualities || []);
            }
        }

        log.info(`Uploaded ${uploaded} files for ${filename}`);
    }

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

    async _processQueue() {
        while (this.queue.length > 0 && this.processing.size < this.maxConcurrent) {
            const job = this.queue.shift();
            if (!job) break;

            this.processing.add(job.filename);
            log.info(`Starting job: ${job.filename} (active: ${this.processing.size}/${this.maxConcurrent})`);

            this.transcodeToHLS(job.filename, job.videoUrl, job.options)
                .then(() => this.failed.delete(job.filename))
                .catch(err => {
                    log.error(`Job failed: ${job.filename}:`, err.message);
                    this.failed.set(job.filename, { error: err.message, failedAt: new Date().toISOString() });
                    this._setProgress(job.filename, 0, 'failed', job.options.qualities || []);
                })
                .finally(() => {
                    this.processing.delete(job.filename);
                    log.info(`Job finished: ${job.filename} (active: ${this.processing.size})`);
                    this._processQueue();
                });
        }
    }
}

// Export singleton
const hlsService = new HLSService();
module.exports = hlsService;
