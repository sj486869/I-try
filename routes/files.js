const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

/**
 * GET /files
 * List all uploaded files with metadata.
 * Optional query: ?type=video|image|audio|document
 */
router.get('/', (req, res) => {
  const storageDir = req.storageDir;
  const typeFilter = req.query.type;

  try {
    const metaFiles = fs.readdirSync(storageDir).filter(f => f.endsWith('.json'));
    let files = metaFiles.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(storageDir, f), 'utf8'));
      } catch {
        return null;
      }
    }).filter(Boolean);

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
