const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Render injects PORT dynamically; fallback to 8080 locally
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'SANDHAN_AVANT_SECRET_KEY_2026';

// Master In-Memory License Store (Can be backed by PostgreSQL or MongoDB later)
const licenses = new Map([
  ['SANDHAN-JIO-001', { boundHwId: null, active: true, customer: 'Field Tech 1' }],
  ['SANDHAN-JIO-002', { boundHwId: null, active: true, customer: 'Field Tech 2' }],
  ['SANDHAN-CERAGON-DEMO', { boundHwId: null, active: true, customer: 'NOC Test Link' }]
]);

// Active Sessions: SessionId -> { mobileWs, passcode, ipProfile, desktopWs }
const sessions = new Map();

// 1. HTTP Server for Health Checks & Hardware DRM Activation
const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Render Root Health Check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ONLINE', service: 'Sandhan Relay Engine' }));
  }

  // Device Activation Endpoint
  if (req.method === 'POST' && req.url === '/api/v1/activate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { license_key, hardware_id } = JSON.parse(body);
        const record = licenses.get(license_key);

        if (!record || !record.active) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'License key is invalid or inactive.' }));
        }

        // 1 License per physical mobile hardware lock
        if (record.boundHwId === null) {
          record.boundHwId = hardware_id;
          console.log(`[LICENSE] Bound ${license_key} to hardware ID: ${hardware_id}`);
        } else if (record.boundHwId !== hardware_id) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'License locked to another phone.' }));
        }

        // Issue cryptographically signed token valid for 14 days
        const token = jwt.sign({ key: license_key, hwId: hardware_id }, JWT_SECRET, { expiresIn: '14d' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'SUCCESS', signed_token: token }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed payload.' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// 2. WebSocket Relay Server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let userRole = null;
  let currentSessionId = null;

  // Render Proxy Keep-Alive Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // --- MOBILE FIELD APP REGISTRATION ---
      if (msg.type === 'MOBILE_REGISTER') {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          const lic = licenses.get(decoded.key);
          if (!lic || lic.boundHwId !== decoded.hwId) {
            ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'Hardware mismatch.' }));
            return ws.close();
          }

          userRole = 'MOBILE';
          currentSessionId = Math.floor(100000000 + Math.random() * 900000000).toString();
          const passcode = Math.floor(1000 + Math.random() * 9000).toString();

          sessions.set(currentSessionId, {
            mobileWs: ws,
            passcode: passcode,
            ipProfile: msg.ipProfile,
            desktopWs: null
          });

          ws.send(JSON.stringify({
            type: 'SESSION_CREATED',
            sessionId: currentSessionId,
            passcode: passcode
          }));
          console.log(`[SESSION] Created ${currentSessionId} for Profile: ${msg.ipProfile}`);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'Invalid or expired token.' }));
          ws.close();
        }
      }

      // --- DESKTOP NOC CLIENT CONNECT ---
      if (msg.type === 'DESKTOP_CONNECT') {
        const session = sessions.get(msg.sessionId);
        if (!session || session.passcode !== msg.passcode) {
          return ws.send(JSON.stringify({ type: 'CONNECT_FAILED', error: 'Invalid Partner ID or Passcode.' }));
        }

        userRole = 'DESKTOP';
        currentSessionId = msg.sessionId;
        session.desktopWs = ws;

        ws.send(JSON.stringify({
          type: 'CONNECTED',
          ipProfile: session.ipProfile
        }));

        session.mobileWs.send(JSON.stringify({ type: 'ENGINEER_CONNECTED' }));
        console.log(`[PAIR] Session ${currentSessionId} paired to Desktop.`);
      }

      // --- DUPLEX STREAM RELAY ---
      if (msg.type === 'STREAM_DATA') {
        const session = sessions.get(currentSessionId);
        if (!session) return;

        if (userRole === 'MOBILE' && session.desktopWs && session.desktopWs.readyState === WebSocket.OPEN) {
          session.desktopWs.send(JSON.stringify({ type: 'STREAM_DATA', payload: msg.payload }));
        } else if (userRole === 'DESKTOP' && session.mobileWs && session.mobileWs.readyState === WebSocket.OPEN) {
          session.mobileWs.send(JSON.stringify({ type: 'STREAM_DATA', payload: msg.payload }));
        }
      }
    } catch (e) {
      console.error('Relay error:', e);
    }
  });

  ws.on('close', () => {
    if (currentSessionId && sessions.has(currentSessionId)) {
      const session = sessions.get(currentSessionId);
      if (userRole === 'MOBILE') {
        if (session.desktopWs) session.desktopWs.send(JSON.stringify({ type: 'SESSION_TERMINATED' }));
        sessions.delete(currentSessionId);
      } else if (userRole === 'DESKTOP') {
        if (session.mobileWs) session.mobileWs.send(JSON.stringify({ type: 'ENGINEER_DISCONNECTED' }));
        session.desktopWs = null;
      }
    }
  });
});

// Periodic ping every 25 seconds to prevent Render proxy from dropping idle connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, () => {
  console.log(`Sandhan Server active on port ${PORT}`);
});