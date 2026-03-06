require('dotenv').config();
const https = require('https');
const http = require('http');

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const opts = new URL(url);
        opts.method = 'HEAD';
        opts.headers = headers;
        const req = mod.request(opts, (res) => {
            resolve({ status: res.statusCode, headers: res.headers });
        });
        req.on('error', reject);
        req.end();
    });
}

function httpGetBody(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function main() {
    console.log('=== CDN Video Streaming Diagnostics ===\n');

    // 1. Get a video URL from the API
    console.log('[1] Fetching video list from API...');
    const apiData = await httpGetBody('https://api.justadev.site/api/videos?page=1&limit=1');
    const video = apiData.data[0];
    console.log('  Video:', video.filename);
    console.log('  URL:', video.url);

    const videoUrl = video.url;

    // 2. Test HEAD request (no range) on CDN
    console.log('\n[2] HEAD request to CDN (no range)...');
    try {
        const head = await httpGet(videoUrl);
        console.log('  Status:', head.status);
        console.log('  Content-Type:', head.headers['content-type']);
        console.log('  Content-Length:', head.headers['content-length']);
        console.log('  Accept-Ranges:', head.headers['accept-ranges']);
        console.log('  Cache-Control:', head.headers['cache-control']);
        console.log('  CF-Cache-Status:', head.headers['cf-cache-status']);
        console.log('  CF-Ray:', head.headers['cf-ray']);

        const sizeBytes = parseInt(head.headers['content-length'] || '0');
        console.log('  File Size:', (sizeBytes / 1024 / 1024).toFixed(2) + ' MB');

        if (!head.headers['accept-ranges']) {
            console.log('\n  ⚠️  WARNING: No Accept-Ranges header! Range requests may not work!');
        }
        if (head.headers['cf-cache-status'] === 'MISS' || head.headers['cf-cache-status'] === 'DYNAMIC') {
            console.log('\n  ⚠️  WARNING: CF-Cache-Status is', head.headers['cf-cache-status']);
            console.log('     This means Cloudflare is NOT caching the video!');
            console.log('     Every request goes back to R2 origin = slow!');
        }
    } catch (err) {
        console.log('  ERROR:', err.message);
    }

    // 3. Test range request 
    console.log('\n[3] HEAD request with Range: bytes=0-1...');
    try {
        const range = await httpGet(videoUrl, { 'Range': 'bytes=0-1' });
        console.log('  Status:', range.status, range.status === 206 ? '✅ Partial Content' : '❌ Not Partial');
        console.log('  Content-Range:', range.headers['content-range']);
        console.log('  CF-Cache-Status:', range.headers['cf-cache-status']);
    } catch (err) {
        console.log('  ERROR:', err.message);
    }

    // 4. Test the VPS proxy route
    console.log('\n[4] HEAD request to VPS /video/ route...');
    try {
        const vps = await httpGet(`https://api.justadev.site/video/${encodeURIComponent(video.filename)}`);
        console.log('  Status:', vps.status, vps.status === 302 || vps.status === 301 ? '(Redirect)' : '');
        console.log('  Location:', vps.headers['location'] || '(none)');
    } catch (err) {
        console.log('  ERROR:', err.message);
    }

    console.log('\n=== Diagnosis ===');
    console.log('If CF-Cache-Status is DYNAMIC or MISS, Cloudflare is not caching video.');
    console.log('This means every byte must be fetched from R2 origin, which is slower.');
    console.log('Fix: Add a Cloudflare Cache Rule for cdn.inupoi.site to cache video/mp4 files.');
}

main().catch(console.error);
