require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { downloadVideo } = require('./downloader');
const path = require('path');
const fs = require('fs');

let client = null;

async function setupTelegramBot(storageDir) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  
  if (!token || !apiId || !apiHash) {
    console.log('[TelegramBot] Missing TELEGRAM_BOT_TOKEN, TELEGRAM_API_ID, or TELEGRAM_API_HASH. Bot will not start.');
    return;
  }

  // Load session from string if available (helps prevent re-auth spam)
  const sessionString = process.env.TELEGRAM_SESSION || '';
  const stringSession = new StringSession(sessionString);

  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({
      botAuthToken: token,
    });
    console.log('[TelegramBot] Connected to MTProto API successfully!');
    
    // Process new messages
    client.addEventHandler(async (event) => {
      const message = event.message;
      const chatId = message.chatId;
      const text = message.message || "";
      
      // Helper to edit message safely
      async function updateStatus(replyToMsgId, newText) {
        try {
            await client.editMessage(chatId, { message: replyToMsgId, text: newText });
        } catch (e) {
            console.error("Failed to edit message", e.message);
        }
      }

      // 1. Check if media exists
      if (message.media) {
        const fileExt = '.mp4'; // Fallback
        const fileName = `telegram_media_${Date.now()}${fileExt}`;
        const destPath = path.join(storageDir, fileName);
        
        let statusMsg;
        try {
           statusMsg = await client.sendMessage(chatId, { message: `⏳ Received file. Bypassing 20MB limit and downloading directly via MTProto...`});
        } catch(e) { return; }

        try {
          let lastEditTime = Date.now();
          await client.downloadMedia(message, {
            outputFile: destPath,
            progressCallback: async (downloaded, total) => {
              // Throttle edits to once every 2 seconds
              if (Date.now() - lastEditTime > 2000) {
                lastEditTime = Date.now();
                const percentage = total ? Math.round((downloaded / total) * 100) : '?';
                const downloadedMB = (downloaded / (1024*1024)).toFixed(1);
                const totalMB = total ? (total / (1024*1024)).toFixed(1) : '?';
                // Fire and forget edit
                client.editMessage(chatId, { message: statusMsg.id, text: `⏳ Downloading... ${percentage}% (${downloadedMB}MB / ${totalMB}MB)` }).catch(()=>{});
              }
            }
          });
          
          if (process.env.B2_BUCKET_NAME && process.env.B2_BUCKET_NAME !== 'REPLACE_ME_WITH_BUCKET_NAME') {
            await updateStatus(statusMsg.id, `⏳ Uploading to Backblaze B2...`);
            const { uploadFileToB2 } = require('./s3');
            await uploadFileToB2(destPath, fileName);
            fs.unlinkSync(destPath);
          }
          
          await updateStatus(statusMsg.id, `✅ **Download complete!**\nFile is now available in your WebOS File Manager.`);
        } catch (err) {
          await updateStatus(statusMsg.id, `❌ **Failed to download file.**\nError: ${err.message}`);
        }
        return;
      }

      // 2. Check if URL exists
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = text.match(urlRegex);

      if (urls && urls.length > 0) {
        const url = urls[0];
        
        let statusMsg;
        try {
           statusMsg = await client.sendMessage(chatId, { message: `⏳ Detected link: ${url}\nStarting extraction and download...` });
        } catch(e) { return; }
        
        try {
          await downloadVideo(url, storageDir);
          await updateStatus(statusMsg.id, `✅ **Download complete!**\nThe video from the link has been saved to the Media Server.`);
        } catch (err) {
          await updateStatus(statusMsg.id, `❌ **Failed to download the video.**\nReason: ${err.message}`);
        }
      } else if (text.startsWith('/start')) {
        await client.sendMessage(chatId, { message: 'Welcome to your WebOS Downloader Bot! 🚀\n\n✅ UPGRADED TO MTProto API\n\nYou can now upload HUGE files (up to 2GB) and I will download them straight to your media server! You can also send links as usual.' });
      }
    }, new NewMessage({}));
  } catch (err) {
    console.error('[TelegramBot] Failed to start client:', err);
  }
}

module.exports = { setupTelegramBot };
