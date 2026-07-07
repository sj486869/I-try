const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');

function syncRawFiles(storageDir) {
  const allFiles = fs.readdirSync(storageDir);
  
  // Find all tracked storedNames
  const trackedNames = new Set();
  const jsonFiles = allFiles.filter(f => f.endsWith('.json'));
  for (const jf of jsonFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(storageDir, jf), 'utf8'));
      if (meta.storedName) trackedNames.add(meta.storedName);
    } catch (e) {
      // ignore invalid json
    }
  }

  const rawFiles = allFiles.filter(f => !f.endsWith('.json') && !f.includes('.chunk.') && !trackedNames.has(f));
  
  for (const rawFile of rawFiles) {
    // Create metadata for this untracked file
    const stat = fs.statSync(path.join(storageDir, rawFile));
    if (stat.isDirectory()) continue;
    
    const safeFileId = uuidv4(); // Generate a safe ID just in case
    
    const ext = path.extname(rawFile).toLowerCase().replace('.', '');
    let fileType = 'other';
    if (['jpg','jpeg','png','gif','bmp','webp','svg'].includes(ext)) fileType = 'image';
    else if (['mp4','avi','mkv','mov','wmv','flv','webm','m4v','ts'].includes(ext)) fileType = 'video';
    else if (['mp3','wav','flac','aac','wma','ogg','m4a'].includes(ext)) fileType = 'audio';
    else if (['pdf','doc','docx','txt','xlsx','xls','ppt','pptx'].includes(ext)) fileType = 'document';

    const meta = {
      fileId: safeFileId,
      originalName: rawFile,
      storedName: rawFile,
      fileType,
      mimeType: mime.lookup(rawFile) || 'application/octet-stream',
      size: stat.size,
      uploadedAt: stat.mtime.toISOString(),
      ownerId: null,
      visibility: 'public', // Make terminal downloads public by default so they can see them
      sharedWith: []
    };
    
    fs.writeFileSync(path.join(storageDir, `${safeFileId}.json`), JSON.stringify(meta, null, 2));
  }
}

/**
 * GET /files
 * List all uploaded files with metadata.
 * Optional query: ?type=video|image|audio|document
 */
router.get('/', async (req, res) => {
  const storageDir = req.storageDir;
  const typeFilter = req.query.type;

  try {
    let files = [];
    
    // 1. Fetch Local Files
    syncRawFiles(storageDir);
    const metaFiles = fs.readdirSync(storageDir).filter(f => f.endsWith('.json'));
    const localFiles = metaFiles.map(f => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(storageDir, f), 'utf8'));
        parsed.source = 'media-server-local';
        return parsed;
      } catch {
        return null;
      }
    }).filter(Boolean);
    files.push(...localFiles);

    // 2. Fetch B2 Files
    if (process.env.B2_BUCKET_NAME && process.env.B2_BUCKET_NAME !== 'REPLACE_ME_WITH_BUCKET_NAME') {
      try {
        const { listVideosFromB2 } = require('../services/s3');
        const s3Files = await listVideosFromB2();
        const cloudFiles = s3Files.map(item => {
          const rawFile = item.name;
          const ext = path.extname(rawFile).toLowerCase().replace('.', '');
          let fileType = 'other';
          if (['jpg','jpeg','png','gif','bmp','webp','svg'].includes(ext)) fileType = 'image';
          else if (['mp4','avi','mkv','mov','wmv','flv','webm','m4v','ts'].includes(ext)) fileType = 'video';
          else if (['mp3','wav','flac','aac','wma','ogg','m4a'].includes(ext)) fileType = 'audio';
          else if (['pdf','doc','docx','txt','xlsx','xls','ppt','pptx'].includes(ext)) fileType = 'document';

          return {
            fileId: rawFile, // In B2, the file ID is just the key name
            originalName: rawFile,
            storedName: rawFile,
            fileType,
            mimeType: mime.lookup(rawFile) || 'application/octet-stream',
            size: item.size,
            uploadedAt: item.lastModified ? new Date(item.lastModified).toISOString() : new Date().toISOString(),
            ownerId: null,
            visibility: 'public',
            sharedWith: [],
            source: 'media-server-b2'
          };
        });
        files.push(...cloudFiles);
      } catch (err) {
        console.error('Failed to list B2 files:', err);
      }
    }

    const userId = req.query.userId;
    const role = req.query.role;

    // Filter files based on permissions
    files = files.filter(f => {
      if (role === 'admin') return true;
      if (f.ownerId === userId) return true;
      if (f.visibility === 'public') return true;
      if (f.sharedWith && Array.isArray(f.sharedWith)) {
        return f.sharedWith.some(share => typeof share === 'string' ? share === userId : share.userId === userId);
      }
      return false;
    });

    if (typeFilter) {
      files = files.filter(f => f.fileType === typeFilter);
    }

    // Sort by upload date descending
    files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    // Add computed fields
    files = files.map(f => ({
      ...f,
      streamUrl: `/stream/${f.fileId}`,
      sizeHuman: formatBytes(f.size),
    }));

    res.json({ files, total: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /files/:fileId
 * Get metadata for a specific file.
 */
router.get('/:fileId', (req, res) => {
  const { fileId } = req.params;
  const metaPath = path.join(req.storageDir, `${fileId}.json`);

  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    res.json({ ...meta, streamUrl: `/stream/${fileId}`, sizeHuman: formatBytes(meta.size) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read metadata' });
  }
});

/**
 * DELETE /files/:fileId
 * Delete a file and its metadata.
 */
router.delete('/:fileId', (req, res) => {
  const { fileId } = req.params;
  const userId = req.query.userId || req.headers['x-user-id'];
  const role = req.query.role || req.headers['x-user-role'];
  
  const storageDir = req.storageDir;
  const metaPath = path.join(storageDir, `${fileId}.json`);

  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    
    // Check delete permission
    let canDelete = false;
    if (role === 'admin') canDelete = true;
    else if (meta.ownerId === userId) canDelete = true;
    else if (meta.sharedWith && Array.isArray(meta.sharedWith)) {
      const share = meta.sharedWith.find(s => typeof s === 'object' ? s.userId === userId : s === userId);
      if (share && typeof share === 'object' && share.canEdit) {
        canDelete = true;
      }
    }
    
    if (!canDelete) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to delete this file' });
    }

    const filePath = path.join(storageDir, meta.storedName);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    fs.unlinkSync(metaPath);

    res.json({ message: 'File deleted successfully', fileId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /files/stats/summary
 * Storage statistics.
 */
router.get('/stats/summary', (req, res) => {
  const storageDir = req.storageDir;
  try {
    syncRawFiles(storageDir);
    const metaFiles = fs.readdirSync(storageDir).filter(f => f.endsWith('.json'));
    let files = metaFiles.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(storageDir, f), 'utf8')); }
      catch { return null; }
    }).filter(Boolean);

    const userId = req.query.userId;
    const role = req.query.role;

    files = files.filter(f => {
      if (role === 'admin') return true;
      if (f.ownerId === userId) return true;
      if (f.visibility === 'public') return true;
      if (f.sharedWith && Array.isArray(f.sharedWith)) {
        return f.sharedWith.some(share => typeof share === 'string' ? share === userId : share.userId === userId);
      }
      return false;
    });

    const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);
    const byType = {};
    files.forEach(f => {
      byType[f.fileType] = (byType[f.fileType] || 0) + 1;
    });

    res.json({
      totalFiles: files.length,
      totalSize,
      totalSizeHuman: formatBytes(totalSize),
      byType,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /files/:fileId/permissions
 * Update visibility and shared users
 */
router.put('/:fileId/permissions', express.json(), (req, res) => {
  const { fileId } = req.params;
  const { visibility, sharedWith } = req.body;
  const storageDir = req.storageDir;
  const metaPath = path.join(storageDir, `${fileId}.json`);

  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (visibility !== undefined) meta.visibility = visibility;
    if (sharedWith !== undefined) meta.sharedWith = sharedWith;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ message: 'Permissions updated successfully', meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
