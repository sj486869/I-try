const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const router = express.Router();

/**
 * GET /stream/:fileId
 *
 * HTTP Range-based video streaming.
 * Supports partial content (206) for seeking without re-downloading.
 * Works with files of ANY size — nothing is buffered in memory.
 */
router.get('/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const storageDir = req.storageDir;

  let meta = null;
  let filePath = null;
  let existsLocally = false;

  // 1. Try to load metadata if it exists
  const metaPath = path.join(storageDir, `${fileId}.json`);
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      filePath = path.join(storageDir, meta.storedName);
      if (fs.existsSync(filePath)) {
        existsLocally = true;
      }
    } catch (e) {
      console.error('Failed to parse meta:', e);
    }
  }

  // 2. If no meta, maybe fileId IS the raw filename
  if (!existsLocally) {
    const rawPath = path.join(storageDir, fileId);
    if (fs.existsSync(rawPath) && !fs.statSync(rawPath).isDirectory()) {
      existsLocally = true;
      filePath = rawPath;
      meta = { 
        storedName: fileId, 
        originalName: fileId, 
        mimeType: mime.lookup(fileId) || 'application/octet-stream' 
      };
    }
  }

  // 3. If not found locally, try B2
  if (!existsLocally) {
    if (process.env.B2_BUCKET_NAME && process.env.B2_BUCKET_NAME !== 'REPLACE_ME_WITH_BUCKET_NAME') {
      try {
        const { getPresignedVideoUrl } = require('../services/s3');
        const presignedUrl = await getPresignedVideoUrl(fileId); // fileId is the S3 key
        return res.redirect(presignedUrl);
      } catch (e) {
        console.error('[Stream] S3 Presigned URL error:', e);
        return res.status(500).json({ error: 'Failed to stream from S3' });
      }
    } else {
      return res.status(404).json({ error: 'Video file not found on disk or B2 not configured' });
    }
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = meta.mimeType || mime.lookup(meta.originalName) || 'video/mp4';

  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    // ── Partial Content (206) ──────────────────────────────────────────────────
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).set({
        'Content-Range': `bytes */${fileSize}`,
      }).end();
      return;
    }

    const chunkSize = end - start + 1;

    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache',
    });

    const stream = fs.createReadStream(filePath, { start, end, highWaterMark: 2 * 1024 * 1024 });
    stream.pipe(res);

    stream.on('error', (err) => {
      console.error(`Stream error for ${fileId}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
    });

  } else {
    // ── Full File ──────────────────────────────────────────────────────────────
    res.status(200).set({
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });

    const stream = fs.createReadStream(filePath, { highWaterMark: 2 * 1024 * 1024 });
    stream.pipe(res);

    stream.on('error', (err) => {
      console.error(`Stream error for ${fileId}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
    });
  }
});

module.exports = router;
