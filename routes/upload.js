const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

const router = express.Router();

/**
 * POST /upload
 *
 * Chunked file upload. Files are streamed directly to disk.
 * No memory buffering — supports files of ANY size (1GB, 2GB, 100GB+).
 *
 * Supports two modes:
 *   1. Single upload: Send entire file in one request
 *   2. Chunked upload: Send chunks with X-Chunk-Index + X-Total-Chunks headers
 */

// Storage engine — stream directly to disk
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    cb(null, req.storageDir);
  },
  filename: (_req, file, cb) => {
    // Temp name for chunked uploads, final name for single uploads
    const tempName = `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}_${file.originalname}`;
    cb(null, tempName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: Infinity, // No limit — stream to disk
  },
});

/**
 * Single or final-chunk upload
 * POST /upload
 * Body: multipart/form-data with field "file"
 * Optional headers:
 *   X-File-Id: <uuid>        — for chunked uploads, use same ID for all chunks
 *   X-Chunk-Index: <number>  — 0-based chunk index
 *   X-Total-Chunks: <number> — total number of chunks
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided. Use field name: "file"' });
    }

    const storageDir = req.storageDir;
    const chunkIndex = req.headers['x-chunk-index'];
    const totalChunks = req.headers['x-total-chunks'];
    const fileId = req.headers['x-file-id'] || uuidv4();
    let originalName = req.headers['x-original-name'] || req.file.originalname;
    // Decode if needed (if it contains percent encoding from frontend)
    try { originalName = decodeURIComponent(originalName); } catch (e) {}
    const ownerId = req.headers['x-user-id'] || req.body.userId || null;

    if (chunkIndex !== undefined && totalChunks !== undefined) {
      // ── Chunked upload mode ──────────────────────────────────────────────────
      const chunkIdx = parseInt(chunkIndex, 10);
      const total = parseInt(totalChunks, 10);

      // Move chunk to a numbered temp file
      const chunkPath = path.join(storageDir, `${fileId}.chunk.${chunkIdx}`);
      fs.renameSync(req.file.path, chunkPath);

      if (chunkIdx < total - 1) {
        // More chunks to come
        return res.json({
          status: 'chunk_received',
          fileId,
          chunkIndex: chunkIdx,
          totalChunks: total,
          chunksRemaining: total - chunkIdx - 1,
        });
      }

      // Last chunk received — assemble file
      // Keep original name (santized to prevent path traversal)
      const storedName = path.basename(originalName);
      const finalPath = path.join(storageDir, storedName);
      const writeStream = fs.createWriteStream(finalPath);

      for (let i = 0; i < total; i++) {
        const cPath = path.join(storageDir, `${fileId}.chunk.${i}`);
        const data = fs.readFileSync(cPath);
        writeStream.write(data);
        fs.unlinkSync(cPath); // Clean up chunk
      }

      writeStream.end();

      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const stat = fs.statSync(finalPath);
      
      if (req.query.destination === 'b2' && process.env.B2_BUCKET_NAME && process.env.B2_BUCKET_NAME !== 'REPLACE_ME_WITH_BUCKET_NAME') {
        const { uploadFileToB2 } = require('../services/s3');
        await uploadFileToB2(finalPath, storedName);
        fs.unlinkSync(finalPath); // Delete local temp file

        return res.json({
          status: 'complete',
          fileId: storedName, // In B2, the file ID is the key
          filename: originalName,
          size: stat.size,
          sizeHuman: formatBytes(stat.size),
          mimeType: req.file.mimetype || mime.lookup(originalName) || 'application/octet-stream',
          uploadedAt: new Date().toISOString(),
          streamUrl: `/stream/${storedName}`,
        });
      } else {
        const meta = createMeta(fileId, originalName, storedName, stat.size, req.file.mimetype, ownerId);
        saveMeta(storageDir, fileId, meta);

        return res.json({
          status: 'complete',
          fileId,
          filename: originalName,
          size: stat.size,
          sizeHuman: formatBytes(stat.size),
          mimeType: meta.mimeType,
          uploadedAt: meta.uploadedAt,
          streamUrl: `/stream/${fileId}`,
        });
      }

    } else {
      // ── Single upload mode ────────────────────────────────────────────────────
      const ext = path.extname(originalName) || path.extname(req.file.originalname);
      // Keep original name (santized to prevent path traversal)
      const storedName = path.basename(originalName);
      const finalPath = path.join(storageDir, storedName);

      fs.renameSync(req.file.path, finalPath);

      const stat = fs.statSync(finalPath);
      const mimeType = req.file.mimetype || mime.lookup(originalName) || 'application/octet-stream';

      if (req.query.destination === 'b2' && process.env.B2_BUCKET_NAME && process.env.B2_BUCKET_NAME !== 'REPLACE_ME_WITH_BUCKET_NAME') {
        const { uploadFileToB2 } = require('../services/s3');
        await uploadFileToB2(finalPath, storedName);
        fs.unlinkSync(finalPath); // Delete local temp file

        return res.json({
          status: 'complete',
          fileId: storedName, // In B2, the file ID is the key
          filename: originalName,
          size: stat.size,
          sizeHuman: formatBytes(stat.size),
          mimeType,
          uploadedAt: new Date().toISOString(),
          streamUrl: `/stream/${storedName}`,
        });
      } else {
        const meta = createMeta(fileId, originalName, storedName, stat.size, mimeType, ownerId);
        saveMeta(storageDir, fileId, meta);

        return res.json({
          status: 'complete',
          fileId,
          filename: originalName,
          size: stat.size,
          sizeHuman: formatBytes(stat.size),
          mimeType,
          uploadedAt: meta.uploadedAt,
          streamUrl: `/stream/${fileId}`,
        });
      }
    }
  } catch (err) {
    console.error('Upload error:', err);
    // Clean up temp file if it exists
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

function createMeta(fileId, originalName, storedName, size, mimeType, ownerId) {
  const ext = path.extname(originalName).toLowerCase().replace('.', '');
  let fileType = 'other';
  if (['jpg','jpeg','png','gif','bmp','webp','svg'].includes(ext)) fileType = 'image';
  else if (['mp4','avi','mkv','mov','wmv','flv','webm','m4v','ts'].includes(ext)) fileType = 'video';
  else if (['mp3','wav','flac','aac','wma','ogg','m4a'].includes(ext)) fileType = 'audio';
  else if (['pdf','doc','docx','txt','xlsx','xls','ppt','pptx'].includes(ext)) fileType = 'document';

  return {
    fileId,
    originalName,
    storedName,
    fileType,
    mimeType: mimeType || mime.lookup(originalName) || 'application/octet-stream',
    size,
    uploadedAt: new Date().toISOString(),
    ownerId: ownerId || null,
    visibility: 'private',
    sharedWith: []
  };
}

function saveMeta(storageDir, fileId, meta) {
  const metaPath = path.join(storageDir, `${fileId}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
