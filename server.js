const WebSocket = require('ws');
const http = require('http');

// Create an HTTP server so Render can perform health checks and pre-warm requests
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sandhan Relay Server is Online\n');
});

// Attach the WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server });

// Map to store active field device sessions: ID -> { ws, pass, nocWs }
const fieldSessions = new Map();

wss.on('connection', (ws) => {
    let registeredId = null;

    ws.on('message', (message) => {
        try {
            // Check if the message is raw binary data (TCP/HTTP tunnel traffic)
            if (Buffer.isBuffer(message)) {
                if (ws.targetPeer && ws.targetPeer.readyState === WebSocket.OPEN) {
                    ws.targetPeer.send(message);
                }
                return;
            }

            // Otherwise, parse incoming JSON control messages
            const data = JSON.parse(message.toString());

            // 1. Field Mobile App Registration
            if (data.type === 'register' && data.role === 'field') {
                registeredId = data.id;
                fieldSessions.set(registeredId, {
                    ws: ws,
                    pass: data.pass,
                    nocWs: null
                });
                console.log(`[Field Connected] ID: ${registeredId}`);
                ws.send(JSON.stringify({ status: 'registered', id: registeredId }));
            }

            // 2. Windows NOC App Connection Request
            else if (data.type === 'connect' && data.role === 'noc') {
                const session = fieldSessions.get(data.id);
                
                if (session && session.pass === data.pass) {
                    // Link Windows NOC WebSocket with Mobile Field WebSocket
                    session.nocWs = ws;
                    ws.targetPeer = session.ws;
                    session.ws.targetPeer = ws;

                    console.log(`[Bridge Established] NOC linked to Field ID: ${data.id}`);
                    ws.send(JSON.stringify({ status: 'connected', message: 'Bridge active' }));
                } else {
                    console.log(`[Auth Failed] Invalid ID or Passcode for ID: ${data.id}`);
                    ws.send(JSON.stringify({ error: 'Connection rejected: Invalid Sandhan ID or Passcode.' }));
                    ws.close();
                }
            }
        } catch (err) {
            console.error('[Error handling message]:', err);
        }
    });

    ws.on('close', () => {
        if (registeredId) {
            const session = fieldSessions.get(registeredId);
            if (session && session.nocWs) {
                session.nocWs.close();
            }
            fieldSessions.delete(registeredId);
            console.log(`[Field Disconnected] ID: ${registeredId}`);
        } else if (ws.targetPeer) {
            // If NOC disconnects, notify field peer
            ws.targetPeer.targetPeer = null;
            ws.targetPeer = null;
            console.log('[NOC Disconnected]');
        }
    });

    ws.on('error', (err) => {
        console.error('[WebSocket Error]:', err);
    });
});

// Bind to Render's dynamic port or default to 10000
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Sandhan Relay Server running on port ${PORT}`);
});