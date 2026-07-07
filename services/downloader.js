const path = require('path');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);
const { uploadFileToB2 } = require('./s3');

async function _uploadAndCleanup(localPath, originalFilename, destination) {
  if (destination === 'b2' && process.env.B2_BUCKET_NAME && process.env.B2_BUCKET_NAME !== 'REPLACE_ME_WITH_BUCKET_NAME') {
    try {
      console.log(`[Downloader] Uploading to Backblaze B2: ${originalFilename}`);
      await uploadFileToB2(localPath, originalFilename);
      console.log(`[Downloader] B2 Upload complete, deleting local file: ${localPath}`);
      fs.unlinkSync(localPath);
    } catch (e) {
      console.error(`[Downloader] Failed to upload to B2:`, e);
      // Leave file locally if upload failed so we don't lose data
    }
  } else {
    // Keep locally. Check if it has a prefix and rename it if needed.
    const finalPath = path.join(path.dirname(localPath), originalFilename);
    if (localPath !== finalPath) {
      fs.renameSync(localPath, finalPath);
    }
    console.log(`[Downloader] Kept file locally: ${finalPath}`);
  }
}

async function downloadVideo(url, storageDir, destination) {
  try {
    const id = uuidv4().slice(0, 8);
    const prefix = `B2_TMP_${id}_`;
    const outputTemplate = path.join(storageDir, `${prefix}%(title)s.%(ext)s`);

    await youtubedl(url, {
      output: outputTemplate,
      noWarnings: true,
      preferFreeFormats: true,
      format: 'best',
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      ]
    });

    // Find the downloaded file
    const files = fs.readdirSync(storageDir);
    const downloadedFile = files.find(f => f.startsWith(prefix));
    
    if (downloadedFile) {
      const fullPath = path.join(storageDir, downloadedFile);
      const originalFilename = downloadedFile.replace(prefix, '');
      await _uploadAndCleanup(fullPath, originalFilename, destination);
    }

    console.log(`[Downloader] Successfully processed yt-dlp: ${url}`);
    return { success: true, url };
  } catch (err) {
    console.error(`[Downloader] yt-dlp failed for ${url}. Attempting direct fallback...`);
    
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });
      
      if (!res.ok) throw new Error(`Direct request failed with status ${res.status}`);
      
      let filename = 'downloaded_video_' + uuidv4().slice(0, 8) + '.mp4';
      const disposition = res.headers.get('content-disposition');
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match && match[1]) filename = match[1];
      } else {
        try {
          const parsedUrl = new URL(url);
          const basename = path.basename(decodeURIComponent(parsedUrl.pathname));
          if (basename && basename.includes('.')) filename = basename;
        } catch(e) {}
      }

      const destPath = path.join(storageDir, filename);
      await streamPipeline(res.body, fs.createWriteStream(destPath));
      
      await _uploadAndCleanup(destPath, filename, destination);

      console.log(`[Downloader] Successfully processed direct fallback for ${filename}`);
      return { success: true, url, filename };

    } catch (fallbackErr) {
      console.error(`[Downloader] Direct fallback also failed:`, fallbackErr);
      let errMsg = err.message || 'Unknown error';
      if (errMsg.includes('Command failed with exit code')) {
        const stderrMatch = errMsg.match(/ERROR: (.*)/);
        if (stderrMatch) errMsg = stderrMatch[1];
      }
      throw new Error(`Failed to download video. Reason: ${errMsg}`);
    }
  }
}

module.exports = { downloadVideo };
