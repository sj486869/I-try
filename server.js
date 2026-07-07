require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { setupWebSocket } = require('./routes/rooms');

const app = express();
const server = http.createServer(app);

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage', 'videos');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const AUTH_TOKEN = process.env.AUTH_TOKEN || null; // Optional bearer token

// Ensure storage dir exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  console.log(`📁 Created storage directory: ${STORAGE_DIR}`);
}

// ─── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'X-File-Id', 'X-Chunk-Index', 'X-Total-Chunks', 'X-Original-Name', 'X-User-Id', 'X-User-Role'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
}));

app.use(express.json());

// Optional auth middleware
const authMiddleware = (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Inject storage dir into every request
app.use((req, _res, next) => {
  req.storageDir = STORAGE_DIR;
  next();
});

// ─── Routes ─────────────────────────────────────────────────────────────────────
const streamRouter = require('./routes/stream');
const uploadRouter = require('./routes/upload');
const filesRouter = require('./routes/files');
const workspaceRouter = require('./routes/workspace');
const downloadRouter = require('./routes/download');

// Services
const { setupTelegramBot } = require('./services/telegramBot');

// Initialize Telegram Bot
setupTelegramBot(STORAGE_DIR);

app.use('/stream', authMiddleware, streamRouter);
app.use('/upload', authMiddleware, uploadRouter);
app.use('/files', authMiddleware, filesRouter);
app.use('/workspace', authMiddleware, workspaceRouter);
app.use('/download', authMiddleware, downloadRouter);

// ─── Health Check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const storageFiles = fs.readdirSync(STORAGE_DIR).filter(f => !f.endsWith('.json'));
  const totalSize = storageFiles.reduce((acc, f) => {
    try { return acc + fs.statSync(path.join(STORAGE_DIR, f)).size; }
    catch { return acc; }
  }, 0);

  res.json({
    status: 'healthy',
    service: 'WebOS Video Media Server',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    storage: {
      path: STORAGE_DIR,
      files: storageFiles.length,
      totalSize,
      totalSizeHuman: formatBytes(totalSize),
    },
    features: {
      streaming: true,
      chunkedUpload: true,
      watchTogether: true,
      maxFileSizeLimit: 'none (stream to disk)',
    },
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'WebOS Video Media Server',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      stream: 'GET /stream/:fileId',
      upload: 'POST /upload',
      files: 'GET /files',
      fileInfo: 'GET /files/:fileId',
      deleteFile: 'DELETE /files/:fileId',
      watchTogether: 'WS /watch-together',
    },
  });
});

// ─── WebSocket — Watch Together & PTY ──────────────────────────────────────
const wssRooms = setupWebSocket();
const { setupPtyWebSocket } = require('./routes/pty');
const wssPty = setupPtyWebSocket(STORAGE_DIR);

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;

  if (pathname === '/watch-together') {
    wssRooms.handleUpgrade(request, socket, head, (ws) => {
      wssRooms.emit('connection', ws, request);
    });
  } else if (pathname === '/pty') {
    wssPty.handleUpgrade(request, socket, head, (ws) => {
      wssPty.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('┌────────────────────────────────────────────┐');
  console.log('│   WebOS Video Media Server  v1.0.0         │');
  console.log('├────────────────────────────────────────────┤');
  console.log(`│  HTTP  ➜  http://${HOST}:${PORT}            `);
  console.log(`│  WS    ➜  ws://${HOST}:${PORT}/watch-together`);
  console.log(`│  Storage: ${STORAGE_DIR}`);
  console.log('└────────────────────────────────────────────┘');
  console.log('');
  if (AUTH_TOKEN) {
    console.log(`🔐 Auth token is SET — include: Authorization: Bearer ${AUTH_TOKEN}`);
  } else {
    console.log('⚠️  No AUTH_TOKEN set — server is open. Set AUTH_TOKEN in .env for production.');
  }
  console.log('');
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = { app, server };