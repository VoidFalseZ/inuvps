# Changelog

## 2025-12-27 - VPS Migration & Bug Fixes

### New VPS Setup
- **New VPS IP**: `31.97.48.130` (Ubuntu 22.04)
- **Old VPS IP**: `202.10.34.229` (deprecated)
- **Domain**: `api.justaweeb.site` → `31.97.48.130`

### SSL/HTTPS Configuration
- Installed Nginx as reverse proxy on port 80/443
- Configured Let's Encrypt SSL certificate via certbot
- Auto-renewal enabled

### Bug Fixes

#### 1. Thumbnail Not Appearing
**Problem**: Thumbnails existed as `.png` but code only checked for `.jpg`
**Solution**: Updated `server.js` to check for both extensions
**File**: `server.js` (lines 243-258)
```javascript
const pngPath = path.join(THUMBNAIL_DIR, `${baseFilename}.png`);
const jpgPath = path.join(THUMBNAIL_DIR, `${baseFilename}.jpg`);
if (fs.existsSync(pngPath)) {
    thumbnailUrl = `/thumbnails/${baseFilename}.png`;
} else if (fs.existsSync(jpgPath)) {
    thumbnailUrl = `/thumbnails/${baseFilename}.jpg`;
}
```

#### 2. Episode Sorting Incorrect (25, 24, 23... instead of 1, 2, 3...)
**Problem**: `/api/videos?series_title=X` sorted by date, not episode number
**Solution**: Added episode-based sorting when filtering by series
**File**: `server.js` (lines 335-350)
```javascript
if (series_title) {
    allVideosData = allVideosData.filter(v => ...);
    allVideosData.sort((a, b) => {
        const epA = a.episode_number !== null ? a.episode_number : Infinity;
        const epB = b.episode_number !== null ? b.episode_number : Infinity;
        return epA !== epB ? epA - epB : a.filename.localeCompare(b.filename);
    });
}
```

#### 3. Corrupted Metadata Cache
**Problem**: `cache/metadata.json` had wrong `series_title` values (full filename instead of parsed title)
**Solution**: Deleted `cache/metadata.json` to regenerate fresh data
**Command**: `rm cache/metadata.json && pm2 restart inuvps`

#### 4. Rate Limiter Error
**Problem**: `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` due to proxy misconfiguration
**Solution**: Disabled trust proxy in rate-limit config
**File**: `server.js` (lines 35-43)

### Previous Session Fixes (VPS Crash)

#### FFprobe Segmentation Fault
**Problem**: 500 errors caused by `ffprobe` memory crashes when generating thumbnails
**Solution**: Disabled automatic thumbnail generation (manual upload only)
**Impact**: Thumbnails must be manually uploaded to `cache/thumbnails/`

## Git Commits
- `808f8ab` - fix: enable thumbnail serving for both .png and .jpg files
- `bdfe065` - fix: improve episode sorting
- `d700793` - hotfix: fix series API and rate limiter configuration
- `ecf8c03` - hotfix: disable thumbnail generation
