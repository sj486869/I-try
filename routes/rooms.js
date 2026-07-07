const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

/**
 * Watch Together — WebSocket Room Manager
 *
 * Protocol:
 *   Client → Server:
 *     { type: "join",    roomId: string, name: string }
 *     { type: "create",  name: string }          → server creates room, returns roomId
 *     { type: "play",    time: number }
 *     { type: "pause",   time: number }
 *     { type: "seek",    time: number }
 *     { type: "video",   videoId: string, videoUrl: string, videoName: string, time: number }
 *     { type: "chat",    msg: string }
 *     { type: "ping" }
 *
 *   Server → Client:
 *     { type: "room_created", roomId: string, isHost: true }
 *     { type: "joined",       roomId: string, participants: Participant[], currentVideo?, currentTime, isPlaying }
 *     { type: "participant_joined", participant: Participant }
 *     { type: "participant_left",   participantId: string, name: string }
 *     { type: "play",    time: number, from: string }
 *     { type: "pause",   time: number, from: string }
 *     { type: "seek",    time: number, from: string }
 *     { type: "video",   videoId, videoUrl, videoName, time, from: string }
 *     { type: "chat",    msg: string, from: string, name: string, timestamp: string }
 *     { type: "error",   message: string }
 *     { type: "pong" }
 *     { type: "host_changed", hostId: string, hostName: string }
 */

// Rooms: Map<roomId, Room>
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcastToRoom(roomId, message, excludeWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const data = JSON.stringify(message);
  room.participants.forEach(p => {
    if (p.ws !== excludeWs && p.ws.readyState === 1 /* OPEN */) {
      p.ws.send(data);
    }
  });
}

function broadcastToAll(roomId, message) {
  broadcastToRoom(roomId, message, null);
}

function getParticipantList(room) {
  return room.participants.map(p => ({
    id: p.id,
    name: p.name,
    isHost: p.id === room.hostId,
  }));
}

function setupWebSocket() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    let currentRoomId = null;
    let clientName = 'Guest';

    console.log(`[WS] Client connected: ${clientId}`);

    ws.on('message', (rawData) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      switch (msg.type) {

        // ── Create Room ──────────────────────────────────────────────────────────
        case 'create': {
          const roomId = generateRoomId();
          clientName = msg.name || 'Host';

          rooms.set(roomId, {
            roomId,
            hostId: clientId,
            participants: [{
              id: clientId,
              name: clientName,
              ws,
            }],
            currentVideo: null,
            currentTime: 0,
            isPlaying: false,
            createdAt: Date.now(),
          });

          currentRoomId = roomId;
          console.log(`[WS] Room created: ${roomId} by ${clientName}`);

          ws.send(JSON.stringify({
            type: 'room_created',
            roomId,
            isHost: true,
            participants: [{ id: clientId, name: clientName, isHost: true }],
          }));
          break;
        }

        // ── Join Room ────────────────────────────────────────────────────────────
        case 'join': {
          const { roomId, name } = msg;
          const room = rooms.get(roomId);

          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: `Room "${roomId}" not found` }));
            return;
          }

          clientName = name || 'Guest';
          currentRoomId = roomId;

          room.participants.push({ id: clientId, name: clientName, ws });
          console.log(`[WS] ${clientName} joined room ${roomId}`);

          // Tell the joiner about the current state
          ws.send(JSON.stringify({
            type: 'joined',
            roomId,
            isHost: false,
            participants: getParticipantList(room),
            currentVideo: room.currentVideo,
            currentTime: room.currentTime,
            isPlaying: room.isPlaying,
          }));

          // Tell everyone else
          broadcastToRoom(roomId, {
            type: 'participant_joined',
            participant: { id: clientId, name: clientName, isHost: false },
          }, ws);
          break;
        }

        // ── Play ─────────────────────────────────────────────────────────────────
        case 'play': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          // Only host can control (or remove restriction for collaborative mode)
          room.isPlaying = true;
          room.currentTime = msg.time ?? room.currentTime;

          broadcastToRoom(currentRoomId, {
            type: 'play',
            time: room.currentTime,
            from: clientName,
          }, ws);
          break;
        }

        // ── Pause ────────────────────────────────────────────────────────────────
        case 'pause': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          room.isPlaying = false;
          room.currentTime = msg.time ?? room.currentTime;

          broadcastToRoom(currentRoomId, {
            type: 'pause',
            time: room.currentTime,
            from: clientName,
          }, ws);
          break;
        }

        // ── Seek ─────────────────────────────────────────────────────────────────
        case 'seek': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          room.currentTime = msg.time ?? 0;

          broadcastToRoom(currentRoomId, {
            type: 'seek',
            time: room.currentTime,
            from: clientName,
          }, ws);
          break;
        }

        // ── Change Video ─────────────────────────────────────────────────────────
        case 'video': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          room.currentVideo = {
            videoId: msg.videoId,
            videoUrl: msg.videoUrl,
            videoName: msg.videoName,
          };
          room.currentTime = msg.time ?? 0;
          room.isPlaying = false;

          broadcastToRoom(currentRoomId, {
            type: 'video',
            videoId: msg.videoId,
            videoUrl: msg.videoUrl,
            videoName: msg.videoName,
            time: 0,
            from: clientName,
          }, ws);
          break;
        }

        // ── Chat ─────────────────────────────────────────────────────────────────
        case 'chat': {
          if (!currentRoomId) return;

          broadcastToAll(currentRoomId, {
            type: 'chat',
            msg: msg.msg,
            from: clientId,
            name: clientName,
            timestamp: new Date().toISOString(),
          });
          break;
        }

        // ── Ping ─────────────────────────────────────────────────────────────────
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Client disconnected: ${clientId} (${clientName})`);

      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;

      // Remove from room
      room.participants = room.participants.filter(p => p.id !== clientId);

      if (room.participants.length === 0) {
        // Empty room — clean up
        rooms.delete(currentRoomId);
        console.log(`[WS] Room ${currentRoomId} deleted (empty)`);
        return;
      }

      // If host left, assign new host
      if (room.hostId === clientId && room.participants.length > 0) {
        room.hostId = room.participants[0].id;
        broadcastToAll(currentRoomId, {
          type: 'host_changed',
          hostId: room.hostId,
          hostName: room.participants[0].name,
        });
        console.log(`[WS] New host in ${currentRoomId}: ${room.participants[0].name}`);
      }

      broadcastToAll(currentRoomId, {
        type: 'participant_left',
        participantId: clientId,
        name: clientName,
      });
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error for ${clientId}:`, err.message);
    });
  });

  // Heartbeat: clean up stale connections every 30s
  setInterval(() => {
    rooms.forEach((room, roomId) => {
      room.participants = room.participants.filter(p => {
        if (p.ws.readyState !== 1) {
          console.log(`[WS] Removing stale connection from room ${roomId}`);
          return false;
        }
        return true;
      });

      if (room.participants.length === 0) {
        rooms.delete(roomId);
        console.log(`[WS] Cleaned up empty room ${roomId}`);
      }
    });
  }, 30000);

  console.log('[WS] Watch Together WebSocket server ready at /watch-together');
  return wss;
}

module.exports = { setupWebSocket };
