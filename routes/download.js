const express = require('express');
const { downloadVideo } = require('../services/downloader');

const router = express.Router();

/**
 * POST /download
 * Body: { url: string }
 */
router.post('/', async (req, res) => {
  const { url, destination } = req.body;
  const storageDir = req.storageDir;

  if (!url) {
    return res.status(400).json({ error: 'Missing url in request body.' });
  }

  try {
    await downloadVideo(url, storageDir, destination || 'local');
    res.json({ success: true, message: 'Download complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
