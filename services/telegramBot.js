require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { downloadFile } = require('./downloader');
const path = require('path');
const fs = require('fs');

let client = null;

const isB2Configured = () =>
  process.env.B2_BUCKET_NAME && process.env.B2_BUCKET_NAME !== 'REPLACE_ME_WITH_BUCKET_NAME';

const MIME_MAP = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
  'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/flac': '.flac',
  'audio/aac': '.aac', 'audio/x-m4a': '.m4a', 'audio/mp4': '.m4a',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'application/zip': '.zip', 'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z', 'application/pdf': '.pdf',
  'application/vnd.android.package-archive': '.apk',
  'application/x-xapk': '.xapk',
};

function getFileInfo(media) {
  let fileExt = '.bin';
  let originalName = null;
  const doc = media.document || media.photo;
  if (!doc) return { fileExt, originalName };
  const mimeType = doc.mimeType || '';
  fileExt = MIME_MAP[mimeType] || ('.' + (mimeType.split('/')[1] || 'bin'));
  if (doc.attributes) {
    for (const attr of doc.attributes) {
      if (attr.fileName) {
        originalName = attr.fileName;
        fileExt = path.extname(attr.fileName) || fileExt;
        break;
      }
    }
  }
  return { fileExt, originalName };
}

// ── Start client with FloodWait auto-retry ─────────────────────────────────────
async function startClientWithRetry(token) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await client.start({ botAuthToken: token });
      console.log('[TelegramBot] Connected to MTProto API!');
      return true;
    } catch (err) {
      // Telegram flood wait — must wait N seconds before retrying
      if (err.errorMessage === 'FLOOD' || err.seconds) {
        const waitSec = (err.seconds || 60) + 5;
        console.warn(`[TelegramBot] FloodWait (attempt ${attempt}/${MAX_RETRIES}): waiting ${waitSec}s before retry...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      console.error(`[TelegramBot] Start error (attempt ${attempt}):`, err.message);
      if (attempt === MAX_RETRIES) return false;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return false;
}

async function setupTelegramBot(storageDir) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!token || !apiId || !apiHash) {
    console.log('[TelegramBot] Missing credentials. Bot will not start.');
    return;
  }

  const stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');

  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
  });

  const connected = await startClientWithRetry(token);
  if (!connected) {
    console.error('[TelegramBot] Could not connect after retries. Bot will not run.');
    return;
  }

  client.addEventHandler(async (event) => {
    const message = event.message;
    const chatId = message.chatId;
    const text = message.message || '';

    async function updateStatus(msgId, newText) {
      try { await client.editMessage(chatId, { message: msgId, text: newText }); }
      catch (e) { console.error('Edit failed:', e.message); }
    }

    // ── Detect WebPage link preview (NOT a real downloadable file) ───────────
    const isWebPagePreview = message.media && (
      message.media.className === 'MessageMediaWebPage' ||
      message.media._ === 'messageMediaWebPage' ||
      message.media.webpage !== undefined
    );

    // ── 1. Real Telegram file (document/video/audio/photo) ───────────────────
    if (message.media && !isWebPagePreview) {
      const destination = isB2Configured() ? 'b2' : 'local';
      const destLabel = destination === 'b2' ? '☁️ Backblaze B2' : '💾 Local Storage';

      let statusMsg;
      try {
        statusMsg = await client.sendMessage(chatId, {
          message: `⏳ File received! Downloading via MTProto (4 workers) → ${destLabel}...`
        });
      } catch (e) { return; }

      let destPath = null;
      try {
        if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

        const { fileExt, originalName } = getFileInfo(message.media);
        const safeName = originalName
          ? originalName.replace(/[\\/:*?"<>|]/g, '_')
          : `telegram_media_${Date.now()}${fileExt}`;
        const fileName = `${Date.now()}_${safeName}`;
        destPath = path.join(storageDir, fileName);

        let lastEditTime = Date.now();
        let lastBytes = 0;
        const speedSamples = [];

        // Stream directly to disk — no RAM limit (outputFile = streaming)
        await client.downloadMedia(message, {
          outputFile: destPath,
          workers: 4,
          progressCallback: async (downloaded, total) => {
            const now = Date.now();
            if (now - lastEditTime > 2500) {
              const elapsed = (now - lastEditTime) / 1000;
              const bytesDiff = Number(downloaded) - lastBytes;
              const speedMBs = (bytesDiff / elapsed / (1024 * 1024)).toFixed(1);
              speedSamples.push(parseFloat(speedMBs));
              if (speedSamples.length > 5) speedSamples.shift();
              const avgSpeed = (speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length).toFixed(1);
              lastEditTime = now;
              lastBytes = Number(downloaded);

              const pct = total ? Math.round((Number(downloaded) / Number(total)) * 100) : '?';
              const dlMB = (Number(downloaded) / (1024 * 1024)).toFixed(1);
              const totalMB = total ? (Number(total) / (1024 * 1024)).toFixed(1) : '?';
              const eta = total && parseFloat(avgSpeed) > 0
                ? Math.round((Number(total) - Number(downloaded)) / (parseFloat(avgSpeed) * 1024 * 1024))
                : null;
              const etaStr = eta ? ` • ETA: ${eta}s` : '';

              client.editMessage(chatId, {
                message: statusMsg.id,
                text: `⏳ Downloading... ${pct}%\n${dlMB}MB / ${totalMB}MB\n🚀 Speed: ${avgSpeed} MB/s${etaStr}`
              }).catch(() => {});
            }
          }
        });

        // gramjs may rename file with extension — find actual saved file
        let actualPath = destPath;
        if (!fs.existsSync(destPath)) {
          const dir = fs.readdirSync(storageDir);
          const ts = path.basename(destPath).split('_')[0];
          const found = dir.find(f => f.startsWith(ts));
          if (found) {
            actualPath = path.join(storageDir, found);
          } else {
            throw new Error('File not found on disk after download.');
          }
        }

        const fileSizeMB = (fs.statSync(actualPath).size / (1024 * 1024)).toFixed(1);
        const finalName = path.basename(actualPath);
        console.log(`[TelegramBot] Downloaded: ${finalName} (${fileSizeMB}MB)`);

        if (destination === 'b2') {
          await updateStatus(statusMsg.id, `⏳ Uploading ${fileSizeMB}MB to ☁️ Backblaze B2...`);
          const { uploadFileToB2 } = require('./s3');
          await uploadFileToB2(actualPath, finalName);
          fs.unlinkSync(actualPath);
          await updateStatus(statusMsg.id,
            `✅ Done! (${fileSizeMB}MB)\n☁️ B2: \`${finalName}\`\nOpen File Manager → B2 tab.`
          );
        } else {
          await updateStatus(statusMsg.id,
            `✅ Done! (${fileSizeMB}MB)\nSaved: \`${finalName}\`\n⚠️ Render storage is temporary — set up B2 for permanent storage.`
          );
        }
      } catch (err) {
        console.error('[TelegramBot] Download error:', err.message);
        if (destPath && fs.existsSync(destPath)) {
          try { fs.unlinkSync(destPath); } catch (_) {}
        }
        await updateStatus(statusMsg.id, `❌ Download failed.\nReason: ${err.message}`);
      }
      return;
    }

    // ── 2. URL / Link (MediaFire, YouTube, direct links, etc.) ──────────────
    const urlsFromText = text.match(/(https?:\/\/[^\s]+)/g) || [];
    const webpageUrl = (isWebPagePreview && message.media?.webpage?.url) || null;
    const urlToDownload = urlsFromText[0] || webpageUrl;

    if (urlToDownload) {
      const destination = isB2Configured() ? 'b2' : 'local';
      const destLabel = destination === 'b2' ? '☁️ Backblaze B2' : '💾 Local Storage';

      let statusMsg;
      try {
        statusMsg = await client.sendMessage(chatId, {
          message: `⏳ Downloading from link → ${destLabel}...\n${urlToDownload}`
        });
      } catch (e) { return; }

      try {
        const result = await downloadFile(urlToDownload, storageDir, destination);
        await updateStatus(statusMsg.id,
          `✅ Download complete!\n📁 \`${result.filename || 'done'}\`\nSaved to ${destLabel}. Open File Manager to see it.`
        );
      } catch (err) {
        await updateStatus(statusMsg.id, `❌ Download failed.\nReason: ${err.message}`);
      }

    } else if (text.startsWith('/start')) {
      const b2Status = isB2Configured()
        ? '✅ Backblaze B2 — permanent cloud storage!'
        : '⚠️ B2 not configured — files are temporary on Render.';
      await client.sendMessage(chatId, {
        message: `🚀 *WebOS Universal Downloader*\n\n📦 *What I can do:*\n• Send any file → MTProto download (no size limit, 4x parallel speed!)\n• Send any link (MediaFire, YouTube, direct URL) → downloaded to server\n\n🗄️ *Storage:* ${b2Status}\n\nJust send a file or paste any link!`
      });
    }
  }, new NewMessage({}));
}

module.exports = { setupTelegramBot };
