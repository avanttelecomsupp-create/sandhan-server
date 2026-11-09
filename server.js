const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sandhan Relay Server is Online\n');
});

const wss = new WebSocket.Server({ server });

// Active Field Sessions: ID -> { ws, pass, nocWs }
const fieldSessions = new Map();

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let registeredId = null;

    ws.on('message', (message, isBinary) => {
        try {
            // Try parsing as JSON control frame first
            const text = message.toString('utf8');
            if (!isBinary && text.trim().startsWith('{')) {
                const data = JSON.parse(text);

                // 1. Field Mobile App Registration (supports 'register', 'host', or 'field' actions)
                const msgType = (data.type || data.action || '').toLowerCase();
                const msgRole = (data.role || '').toLowerCase();
                const cleanId = String(data.id || data.sandhanId || '').replace(/\s+/g, '');
                const cleanPass = String(data.pass || data.passcode || '').trim();

                if ((msgType === 'register' || msgRole === 'field' || msgType === 'host') && cleanId) {
                    registeredId = cleanId;
                    fieldSessions.set(registeredId, {
                        ws: ws,
                        pass: cleanPass,
                        nocWs: null
                    });
                    console.log(`[Field Registered] ID: ${registeredId} | Pass: ${cleanPass}`);
                    ws.send(JSON.stringify({ status: 'registered', id: registeredId }));
                    return;
                }

                // 2. Windows NOC App Connection Request
                if (msgType === 'connect' || msgRole === 'noc') {
                    const session = fieldSessions.get(cleanId);

                    if (session && session.ws.readyState === WebSocket.OPEN && session.pass === cleanPass) {
                        session.nocWs = ws;
                        ws.targetPeer = session.ws;
                        session.ws.targetPeer = ws;

                        console.log(`[Bridge Established] NOC linked to Field ID: ${cleanId}`);
                        ws.send(JSON.stringify({ status: 'connected', message: 'Bridge active' }));
                        session.ws.send(JSON.stringify({ status: 'noc_connected', id: cleanId }));
                    } else {
                        console.log(`[Auth Rejected] Requested ID: ${cleanId} | Active IDs: ${Array.from(fieldSessions.keys()).join(', ')}`);
                        ws.send(JSON.stringify({
                            status: 'error',
                            error: `Invalid Sandhan ID (${cleanId}) or Passcode, or Field Bridge is offline.`
                        }));
                        // Delay close slightly so Windows finishes reading the error message cleanly
                        setTimeout(() => {
                            if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Auth Rejected');
                        }, 500);
                    }
                    return;
                }
            }

            // 3. Otherwise, forward raw tunnel traffic (HTTP/TCP packets) to linked peer
            if (ws.targetPeer && ws.targetPeer.readyState === WebSocket.OPEN) {
                ws.targetPeer.send(message, { binary: isBinary });
            }
        } catch (err) {
            // If JSON parse fails, treat as raw tunnel data and forward to peer
            if (ws.targetPeer && ws.targetPeer.readyState === WebSocket.OPEN) {
                ws.targetPeer.send(message, { binary: isBinary });
            }
        }
    });

    ws.on('close', () => {
        if (registeredId) {
            const session = fieldSessions.get(registeredId);
            if (session && session.nocWs && session.nocWs.readyState === WebSocket.OPEN) {
                session.nocWs.close(1000, 'Field Disconnected');
            }
            fieldSessions.delete(registeredId);
            console.log(`[Field Disconnected] ID: ${registeredId}`);
        } else if (ws.targetPeer) {
            ws.targetPeer.targetPeer = null;
            ws.targetPeer = null;
            console.log('[NOC Disconnected]');
        }
    });

    ws.on('error', (err) => {
        console.error('[WebSocket Error]:', err.message);
    });
});

// Ping all clients every 25 seconds so Render never drops idle connections
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 25000);

wss.on('close', () => clearInterval(interval));

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Sandhan Relay Server running on port ${PORT}`);
});