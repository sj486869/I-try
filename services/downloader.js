const path = require('path');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);
const { uploadFileToB2 } = require('./s3');

// ── MIME type → extension map ──────────────────────────────────────────────────
const MIME_EXT_MAP = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
  'video/quicktime': '.mov', 'video/x-msvideo': '.avi', 'video/mpeg': '.mpeg',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/webm': '.webm', 'audio/flac': '.flac', 'audio/aac': '.aac',
  'audio/x-m4a': '.m4a', 'audio/mp4': '.m4a',
  'application/zip': '.zip', 'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z', 'application/x-tar': '.tar',
  'application/gzip': '.gz', 'application/x-bzip2': '.bz2',
  'application/pdf': '.pdf', 'application/octet-stream': '',
  'application/vnd.android.package-archive': '.apk',
  'application/x-xapk': '.xapk',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg',
  'text/plain': '.txt', 'text/html': '.html',
};

function getExtFromMime(mime) {
  if (!mime) return '';
  const base = mime.split(';')[0].trim().toLowerCase();
  return MIME_EXT_MAP[base] || '';
}

// ── Get a clean filename from URL path ────────────────────────────────────────
function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const base = path.basename(decodeURIComponent(parsed.pathname));
    if (base && base.includes('.') && base.length < 200) return base;
  } catch (_) {}
  return null;
}

// ── Sanitize filename ─────────────────────────────────────────────────────────
function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 200);
}

// ── B2 Upload + cleanup ───────────────────────────────────────────────────────
async function _uploadAndCleanup(localPath, originalFilename, destination) {
  const isB2 = destination === 'b2' &&
    process.env.B2_BUCKET_NAME &&
    process.env.B2_BUCKET_NAME !== 'REPLACE_ME_WITH_BUCKET_NAME';

  if (isB2) {
    console.log(`[Downloader] Uploading to B2: ${originalFilename}`);
    await uploadFileToB2(localPath, originalFilename);
    console.log(`[Downloader] B2 Upload done, removing local: ${localPath}`);
    fs.unlinkSync(localPath);
  } else {
    const finalPath = path.join(path.dirname(localPath), originalFilename);
    if (localPath !== finalPath && !fs.existsSync(finalPath)) {
      fs.renameSync(localPath, finalPath);
    }
    console.log(`[Downloader] Saved locally: ${finalPath}`);
  }
}

// ── MediaFire link extractor ──────────────────────────────────────────────────
async function resolveMediafireUrl(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    const html = await res.text();

    // Pattern 1: Standard download URL
    const p1 = html.match(/href="(https:\/\/download\d*\.mediafire\.com\/[^"]+)"/);
    if (p1) { console.log('[Downloader] MediaFire: Pattern 1 matched'); return p1[1]; }

    // Pattern 2: aria-label download button
    const p2 = html.match(/aria-label="Download file"[^>]+href="([^"]+)"/);
    if (p2) { console.log('[Downloader] MediaFire: Pattern 2 matched'); return p2[1]; }

    // Pattern 3: JSON data in page
    const p3 = html.match(/"downloadUrl"\s*:\s*"([^"]+)"/);
    if (p3) { console.log('[Downloader] MediaFire: Pattern 3 matched'); return p3[1].replace(/\\/g, ''); }

    // Pattern 4: data-url attribute
    const p4 = html.match(/data-url="(https:\/\/[^"]*mediafire[^"]+)"/);
    if (p4) { console.log('[Downloader] MediaFire: Pattern 4 matched'); return p4[1]; }

    // Pattern 5: Any download.mediafire.com URL
    const p5 = html.match(/(https?:\/\/download\d*\.mediafire\.com[^\s"'<>]+)/);
    if (p5) { console.log('[Downloader] MediaFire: Pattern 5 matched'); return p5[1]; }

    // Pattern 6: Try the direct download endpoint
    const fileId = url.match(/\/file\/([^/]+)\//)?.[1];
    if (fileId) {
      const directUrl = `https://www.mediafire.com/file/${fileId}`;
      console.log('[Downloader] MediaFire: Trying direct endpoint');
      return directUrl;
    }

    console.error('[Downloader] MediaFire: No pattern matched in HTML');
  } catch (e) {
    console.error('[Downloader] MediaFire resolve failed:', e.message);
  }
  return null;
}

// ── Direct HTTP downloader (supports any file type) ───────────────────────────
async function directDownload(url, storageDir, destination) {
  // Check for MediaFire and resolve the real URL
  let finalUrl = url;
  if (url.includes('mediafire.com')) {
    console.log('[Downloader] Resolving MediaFire URL...');
    const resolved = await resolveMediafireUrl(url);
    if (resolved) {
      finalUrl = resolved;
    } else {
      throw new Error('Could not extract MediaFire direct download link from the page.');
    }
  }

  const res = await fetch(finalUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`Server returned HTTP ${res.status} for download.`);

  // ── Determine filename ──────────────────────────────────────────────────────
  let filename = null;

  // 1. From Content-Disposition header
  const disposition = res.headers.get('content-disposition');
  if (disposition) {
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) filename = decodeURIComponent(utf8Match[1]);
    else {
      const nameMatch = disposition.match(/filename="?([^";\n]+)"?/i);
      if (nameMatch) filename = nameMatch[1].trim();
    }
  }

  // 2. From final redirected URL
  if (!filename) filename = filenameFromUrl(res.url);

  // 3. From original URL
  if (!filename) filename = filenameFromUrl(finalUrl);

  // 4. Fallback with MIME-based extension
  if (!filename) {
    const contentType = res.headers.get('content-type') || '';
    const ext = getExtFromMime(contentType) || '.bin';
    filename = `download_${uuidv4().slice(0, 8)}${ext}`;
  }

  // Ensure no path traversal
  filename = sanitize(path.basename(filename));

  // If still no extension, try to guess from content-type
  if (!path.extname(filename)) {
    const ct = res.headers.get('content-type') || '';
    const ext = getExtFromMime(ct);
    if (ext) filename += ext;
  }

  const tempPath = path.join(storageDir, `TMP_${uuidv4().slice(0, 8)}_${filename}`);
  console.log(`[Downloader] Streaming download → ${filename}`);

  await streamPipeline(res.body, fs.createWriteStream(tempPath));

  if (!fs.existsSync(tempPath)) throw new Error('File not written to disk!');
  const stats = fs.statSync(tempPath);
  if (stats.size === 0) {
    fs.unlinkSync(tempPath);
    throw new Error('Downloaded file is empty (0 bytes).');
  }

  await _uploadAndCleanup(tempPath, filename, destination);
  console.log(`[Downloader] Done: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  return { success: true, filename, size: stats.size };
}

// ── Main download function ────────────────────────────────────────────────────
// Tries yt-dlp first (for YouTube/social media), then falls back to direct download
async function downloadFile(url, storageDir, destination = 'local') {
  // For clearly non-video hosting URLs, skip yt-dlp immediately
  const skipYtdlp = /\.(zip|rar|7z|tar|gz|bz2|apk|xapk|exe|pdf|iso|img|dmg|deb|rpm)(\?.*)?$/i.test(url) ||
    url.includes('mediafire.com') ||
    url.includes('drive.google.com') ||
    url.includes('dropbox.com') ||
    url.includes('mega.nz') ||
    url.includes('1drv.ms') ||
    url.includes('4shared.com') ||
    url.includes('zippyshare.com');

  if (!skipYtdlp) {
    try {
      console.log(`[Downloader] Trying yt-dlp for: ${url}`);
      const id = uuidv4().slice(0, 8);
      const prefix = `TMP_${id}_`;
      const outputTemplate = path.join(storageDir, `${prefix}%(title)s.%(ext)s`);

      const ytdlOptions = {
        output: outputTemplate,
        noWarnings: true,
        preferFreeFormats: true,
        format: 'best',
      };

      // If user provided cookies.txt to bypass YouTube's 'Sign in to confirm you are not a bot'
      const cookiesPath = path.join(__dirname, '..', 'cookies.txt');
      if (fs.existsSync(cookiesPath)) {
        ytdlOptions.cookies = cookiesPath;
        // When using cookies, we must use web clients. Removing mobile clients.
        ytdlOptions.extractorArgs = 'youtube:player_client=web,tv';
        console.log(`[Downloader] Using cookies.txt for yt-dlp authentication`);
      } else {
        // Try multiple clients to bypass generic 429 when no cookies are available
        ytdlOptions.extractorArgs = 'youtube:player_client=ios,android,web';
      }

      await youtubedl(url, ytdlOptions);

      const files = fs.readdirSync(storageDir);
      const downloaded = files.find(f => f.startsWith(prefix));
      if (downloaded) {
        const fullPath = path.join(storageDir, downloaded);
        const originalFilename = sanitize(downloaded.replace(prefix, ''));
        await _uploadAndCleanup(fullPath, originalFilename, destination);
        console.log(`[Downloader] yt-dlp success: ${originalFilename}`);
        return { success: true, filename: originalFilename };
      } else {
        throw new Error('yt-dlp succeeded but file was not found on disk.');
      }
    } catch (err) {
      console.error(`[Downloader] yt-dlp failed:`, err.message);
      
      // If it's a known video platform, do not fallback to direct HTTP (it will just return HTML or 429)
      if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('instagram.com') || url.includes('tiktok.com')) {
        throw new Error(`Video extraction failed. YouTube/Platform might be blocking the request or restricting it (e.g. 429 Too Many Requests). Details: ${err.message.split('\n')[0]}`);
      }
      
      console.log(`[Downloader] Falling back to direct download...`);
    }
  }

  // Direct download fallback (or primary for non-video files)
  console.log(`[Downloader] Using direct download for: ${url}`);
  return directDownload(url, storageDir, destination);
}

// Keep old export name for backward compatibility
module.exports = { downloadFile, downloadVideo: downloadFile };
