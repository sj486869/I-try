const express = require('express');
const { downloadFile } = require('../services/downloader');

const router = express.Router();

/**
 * POST /download
 * Body: { url: string, destination?: 'local' | 'b2' }
 * Downloads any file type: zip, rar, apk, mp3, mp4, pdf, etc.
 */
router.post('/', async (req, res) => {
  const { url, destination } = req.body;
  const storageDir = req.storageDir;

  if (!url) {
    return res.status(400).json({ error: 'Missing url in request body.' });
  }

  try {
    const result = await downloadFile(url, storageDir, destination || 'local');
    res.json({ success: true, message: 'Download complete', filename: result.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
