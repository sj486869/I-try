# WebOS Video Media Server

A standalone Node.js server for streaming large video files and enabling **Watch Together** synchronized viewing.

## Features

- 🎬 **HTTP Range Streaming** — Seek anywhere in a 1GB, 10GB, or larger file instantly
- 📤 **Chunked Upload** — Upload files of any size without browser limits
- 👥 **Watch Together** — WebSocket-based synchronized playback rooms
- 💬 **Real-time Chat** — Chat while watching together
- 🔐 **Optional Auth** — Bearer token for secure access
- 🌍 **CORS Support** — Configurable for any frontend origin

---

## Quick Start

### 1. Install dependencies

```bash
cd video-server
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env as needed
```

### 3. Start the server

```bash
npm start
# Server running at http://0.0.0.0:3001
```

For development with auto-restart:
```bash
npm run dev
```

---

## Deployment

### On Your PC (LAN Access)

```bash
npm start
# Frontend connects to http://YOUR_LOCAL_IP:3001
```

Find your local IP: `ipconfig` (Windows) or `ip addr` (Linux)

### On a VPS (Ubuntu/Debian)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone or copy the video-server folder
# Install dependencies
npm install

# Run with PM2 (auto-restart, survives reboots)
npm install -g pm2
pm2 start server.js --name webos-video-server
pm2 startup
pm2 save
```

### On AWS EC2

```bash
# Same as VPS setup above
# Open port 3001 in your Security Group (inbound TCP)
# Use your EC2 Public IP or domain in WebOS Settings
```

### With Nginx Reverse Proxy (recommended for production)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # WebSocket support for Watch Together
    location /watch-together {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    # HTTP streaming
    location / {
        proxy_pass http://localhost:3001;
        proxy_buffering off;
        proxy_set_header Range $http_range;
        proxy_set_header Host $host;
    }
}
```

---

## API Reference

### Health Check
```
GET /health
→ { status, uptime, storage: { files, totalSize, totalSizeHuman } }
```

### Upload a Video
```
POST /upload
Content-Type: multipart/form-data
Field: file

→ { status: "complete", fileId, filename, size, streamUrl }
```

### Chunked Upload (large files)
```
POST /upload
Headers:
  X-File-Id: <uuid>           # Same ID for all chunks
  X-Chunk-Index: 0,1,2,...    # Zero-based chunk index
  X-Total-Chunks: <N>         # Total number of chunks
  X-Original-Name: video.mp4  # Original filename
Content-Type: multipart/form-data
Field: file (chunk data)

Last chunk → { status: "complete", fileId, filename, size, streamUrl }
Other chunks → { status: "chunk_received", chunksRemaining }
```

### Stream a Video
```
GET /stream/:fileId
Supports Range header for seeking

→ 206 Partial Content (range request)
→ 200 OK (full file)
```

### List Files
```
GET /files
GET /files?type=video

→ { files: [...], total }
```

### Delete a File
```
DELETE /files/:fileId
→ { message: "File deleted successfully" }
```

### Watch Together (WebSocket)
```
WS ws://your-server:3001/watch-together

Client sends:
  { type: "create", name: "Your Name" }
  → Server: { type: "room_created", roomId: "ABC123", isHost: true }

  { type: "join", roomId: "ABC123", name: "Friend" }
  → Server: { type: "joined", roomId, participants, currentVideo, currentTime, isPlaying }

  { type: "play",  time: 42.3 }
  { type: "pause", time: 42.3 }
  { type: "seek",  time: 120.0 }
  { type: "video", videoId, videoUrl, videoName, time: 0 }
  { type: "chat",  msg: "Hello!" }
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `STORAGE_DIR` | `./storage/videos` | Where files are stored |
| `AUTH_TOKEN` | _(empty)_ | Optional bearer token |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |

---

## Connecting in WebOS

1. Open WebOS → **Settings** → **Media Server**
2. Enter your server URL (e.g., `http://192.168.1.100:3001` or `http://your-vps.com:3001`)
3. Click **Test** — should show ✅ Connected
4. Open **Watch Together** app to start a room
