// src/utils/ffmpeg.js — Shared FFmpeg/FFprobe path detection
// Single source of truth — used by both thumbnailService and hlsService.

'use strict';

const { execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const { createLogger } = require('./logger');

const log = createLogger('FFmpeg');

let ffmpegPath;
let ffprobePath;

/**
 * Detect FFmpeg/FFprobe using the platform-appropriate command.
 * Falls back to npm-installed binaries if not found on PATH.
 */
function detectPaths() {
    // Determine the correct lookup command for the current platform
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';

    try {
        execSync(`${lookupCmd} ffmpeg`, { stdio: 'ignore' });
        execSync(`${lookupCmd} ffprobe`, { stdio: 'ignore' });
        ffmpegPath = 'ffmpeg';
        ffprobePath = 'ffprobe';
        log.info('Using system FFmpeg');
    } catch {
        ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
        ffprobePath = require('@ffprobe-installer/ffprobe').path;
        log.info('Using npm-packaged FFmpeg');
    }

    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
}

// Run detection once on module load
detectPaths();

module.exports = {
    ffmpeg,
    ffmpegPath,
    ffprobePath,
};
