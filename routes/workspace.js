const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const WORKSPACE_DIR = path.join(__dirname, '..', 'workspace');

// Ensure workspace directory exists
if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

// ─── Helper: Validate Path ───
const getSafePath = (userPath) => {
  if (!userPath) return WORKSPACE_DIR;
  const safePath = path.normalize(userPath).replace(/^(\.\.[\/\\])+/, '');
  return path.join(WORKSPACE_DIR, safePath);
};

// ─── API: Get Workspace Tree ───
router.get('/tree', (req, res) => {
  const getTree = (dirPath, relativePath = '') => {
    const result = [];
    if (!fs.existsSync(dirPath)) return result;
    
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = fs.statSync(fullPath);
      const itemRelativePath = path.join(relativePath, item).replace(/\\/g, '/');
      
      if (stat.isDirectory()) {
        result.push({
          type: 'folder',
          name: item,
          path: itemRelativePath,
          children: getTree(fullPath, itemRelativePath),
        });
      } else {
        result.push({
          type: 'file',
          name: item,
          path: itemRelativePath,
          size: stat.size,
          lastModified: stat.mtime,
        });
      }
    }
    return result;
  };

  try {
    const tree = getTree(WORKSPACE_DIR);
    res.json({ tree });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API: Read File ───
router.get('/file', (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'Path is required' });
  
  const safePath = getSafePath(filePath);
  if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'File not found' });
  if (fs.statSync(safePath).isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
  
  try {
    const content = fs.readFileSync(safePath, 'utf8');
    res.send(content);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API: Create / Update File ───
router.post('/file', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Path is required' });
  
  const safePath = getSafePath(filePath);
  
  try {
    // Ensure parent directory exists
    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    fs.writeFileSync(safePath, content || '');
    res.json({ success: true, path: filePath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API: Create Folder ───
router.post('/folder', (req, res) => {
  const { path: folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'Path is required' });
  
  const safePath = getSafePath(folderPath);
  
  try {
    if (!fs.existsSync(safePath)) {
      fs.mkdirSync(safePath, { recursive: true });
    }
    res.json({ success: true, path: folderPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API: Delete File/Folder ───
router.delete('/path', (req, res) => {
  const { path: targetPath } = req.query;
  if (!targetPath) return res.status(400).json({ error: 'Path is required' });
  
  const safePath = getSafePath(targetPath);
  if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'Path not found' });
  
  try {
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      fs.rmSync(safePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(safePath);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API: Rename File/Folder ───
router.post('/rename', (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath are required' });
  
  const safeOldPath = getSafePath(oldPath);
  const safeNewPath = getSafePath(newPath);
  
  if (!fs.existsSync(safeOldPath)) return res.status(404).json({ error: 'Path not found' });
  
  try {
    fs.renameSync(safeOldPath, safeNewPath);
    res.json({ success: true, path: newPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API: Execute Code (Node.js) ───
router.post('/run', (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Path is required' });
  
  const safePath = getSafePath(filePath);
  if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'File not found' });
  
  if (!filePath.endsWith('.js') && !filePath.endsWith('.py')) {
    return res.status(400).json({ error: 'Only .js and .py files are supported for execution right now.' });
  }
  
  const cmd = filePath.endsWith('.py') ? `python "${safePath}"` : `node "${safePath}"`;
  
  // Run
  exec(cmd, { timeout: 10000, cwd: WORKSPACE_DIR }, (error, stdout, stderr) => {
    res.json({
      stdout,
      stderr,
      error: error ? error.message : null,
      code: error ? error.code : 0
    });
  });
});

// ─── API: Generic Terminal Command ───
router.post('/terminal', (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Command is required' });
  
  exec(command, { timeout: 15000, cwd: WORKSPACE_DIR }, (error, stdout, stderr) => {
    res.json({
      stdout,
      stderr,
      error: error ? error.message : null,
      code: error ? error.code : 0
    });
  });
});

module.exports = router;
