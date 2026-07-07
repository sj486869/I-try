const { WebSocketServer } = require('ws');
const os = require('os');
const pty = require('node-pty');

function setupPtyWebSocket(storageDir) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    console.log('[PTY] Client connected');

    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    
    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: storageDir || process.env.HOME || process.cwd(),
        env: process.env
      });
    } catch (err) {
      console.error('[PTY] Error spawning pty:', err);
      ws.close();
      return;
    }

    // Send data from pty to websocket
    ptyProcess.onData((data) => {
      if (ws.readyState === 1) { // OPEN
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    ptyProcess.onExit(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'exit' }));
        ws.close();
      }
    });

    // Receive data from websocket and send to pty
    ws.on('message', (msg) => {
      try {
        const payload = JSON.parse(msg.toString());
        if (payload.type === 'data') {
          ptyProcess.write(payload.data);
        } else if (payload.type === 'resize') {
          ptyProcess.resize(payload.cols, payload.rows);
        }
      } catch (err) {
        console.error('[PTY] Invalid message format', err);
      }
    });

    ws.on('close', () => {
      console.log('[PTY] Client disconnected');
      ptyProcess.kill();
    });
  });

  return wss;
}

module.exports = { setupPtyWebSocket };
