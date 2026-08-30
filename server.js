/**
 * server.js — PhoneCam Pro Server
 * HTTPS + Socket.IO signaling server with QR code generation
 */

const express = require('express');
const https = require('https');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Get local IP ──────────────────────────────────────────────
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
        }
    }
    return ips.length ? ips : ['127.0.0.1'];
}

function getLocalIP() {
    return getLocalIPs()[0];
}

const LOCAL_IP = getLocalIP();

// ─── SSL Certificates ──────────────────────────────────────────
let server;
const certPath = path.join(__dirname, 'certs', 'server.cert');
const keyPath = path.join(__dirname, 'certs', 'server.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
    server = https.createServer(options, app);
    console.log('🔒 HTTPS mode enabled');
} else {
    // Generate certs on the fly
    try {
        const selfsigned = require('selfsigned');
        const attrs = [{ name: 'commonName', value: 'PhoneCam Pro' }];
        const opts = {
            keySize: 2048,
            days: 365,
            algorithm: 'sha256',
            extensions: [
                {
                    name: 'subjectAltName',
                    altNames: [
                        { type: 2, value: 'localhost' },
                        { type: 7, ip: '127.0.0.1' },
                        { type: 7, ip: LOCAL_IP }
                    ]
                }
            ]
        };
        const pems = selfsigned.generate(attrs, opts);

        // Save for reuse
        const certDir = path.join(__dirname, 'certs');
        if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });
        fs.writeFileSync(keyPath, pems.private);
        fs.writeFileSync(certPath, pems.cert);

        server = https.createServer({ key: pems.private, cert: pems.cert }, app);
        console.log('🔐 Generated self-signed certificates');
    } catch (e) {
        console.log('⚠️  Running in HTTP mode (camera access may not work on mobile)');
        server = http.createServer(app);
    }
}

// ─── Socket.IO ─────────────────────────────────────────────────
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e8 // 100MB for large frames
});

// HTTP fallback server (for the native iPhone app: no TLS needed on LAN)
const HTTP_PORT = parseInt(process.env.HTTP_PORT || 3001, 10);
const httpFallbackServer = http.createServer(app);
const ioHttp = new Server(httpFallbackServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e8
});

// ─── Static Files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Routes ────────────────────────────────────────────────────

// Desktop UI (default)
app.get('/', (req, res) => {
    res.redirect('/desktop/');
});

// Mobile UI
app.get('/mobile/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mobile', 'index.html'));
});

// Desktop UI
app.get('/desktop/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'desktop', 'index.html'));
});

// OBS clean view
app.get('/obs/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'obs', 'index.html'));
});

// QR Code API
app.get('/api/qrcode/:room', async (req, res) => {
    const room = req.params.room;
    // Use the HTTP port for the QR: native app connects without TLS hassle
    const url = `http://${LOCAL_IP}:${HTTP_PORT}/mobile/?room=${room}`;
    try {
        const qrDataUrl = await QRCode.toDataURL(url, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
        });
        res.json({ qr: qrDataUrl, url });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

// Server info API
app.get('/api/info', (req, res) => {
    const protocol = server instanceof https.Server ? 'https' : 'http';
    res.json({
        ip: LOCAL_IP,
        ips: getLocalIPs(),
        port: PORT,
        protocol,
        httpPort: HTTP_PORT,
        version: '1.2.0'
    });
});

// ─── Virtual Camera (PhoneCam Pro DirectShow filter) ─────────
// Feeds the "PhoneCam Pro" virtual camera (obs-virtualsource.dll)
// through the OBSVirtualCamVideo shared-memory queue. The vcam-feed
// helper creates the queue and writes NV12 frames received on stdin.
const VCAM_PATH = path.join(__dirname, 'vcam-feed', 'vcam-feed.exe');
let vcam = { active: false, proc: null, w: 0, h: 0, fps: 0 };

function startVcam(w, h, fps) {
    if (vcam.active) {
        return { ok: false, error: 'La cámara virtual ya está activa' };
    }
    if (!fs.existsSync(VCAM_PATH)) {
        return { ok: false, error: 'vcam-feed.exe no encontrado' };
    }
    const proc = spawn(VCAM_PATH, ['--w', String(w), '--h', String(h), '--fps', String(fps)], {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true
    });
    proc.stderr.on('data', (d) => console.log('[vcam] ' + String(d).trim()));
    proc.on('exit', (code) => {
        console.log(`[vcam] feeder exited (${code})`);
        if (vcam.proc === proc) {
            vcam.active = false;
            vcam.proc = null;
        }
    });
    proc.on('error', (err) => {
        console.error('[vcam] feeder error:', err);
        if (vcam.proc === proc) {
            vcam.active = false;
            vcam.proc = null;
        }
    });
    vcam = { active: true, proc, w, h, fps };
    console.log(`[vcam] started ${w}x${h} @${fps}fps`);
    return { ok: true };
}

function stopVcam() {
    if (!vcam.active || !vcam.proc) {
        vcam.active = false;
        return;
    }
    const proc = vcam.proc;
    vcam.active = false;
    vcam.proc = null;
    try { proc.stdin.end(); } catch { /* already closed */ }
    // Fallback kill if the feeder doesn't exit on EOF within 2s
    setTimeout(() => {
        try { proc.kill(); } catch { /* already gone */ }
    }, 2000);
    console.log('[vcam] stopped');
}

app.post('/api/virtualcam', (req, res) => {
    try {
        const { w, h, fps } = req.body || {};
        if (!w || !h || !fps) {
            return res.status(400).json({ error: 'Faltan parámetros (w, h, fps)' });
        }
        const result = startVcam(w, h, fps);
        if (!result.ok) {
            return res.status(500).json({ error: result.error });
        }
        res.json({ ok: true, device: 'PhoneCam Pro', w, h, fps });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/virtualcam/stop', (req, res) => {
    stopVcam();
    res.json({ ok: true });
});

// Virtual camera status
app.get('/api/virtualcam/status', (req, res) => {
    res.json({ active: vcam.active, w: vcam.w, h: vcam.h, fps: vcam.fps, device: 'PhoneCam Pro' });
});

// Room management
app.get('/api/devices/:room', (req, res) => {
    const room = rooms.get(req.params.room);
    if (!room || !room.devices) {
        return res.json({ devices: [] });
    }
    res.json({ devices: Array.from(room.devices.values()) });
});

// ─── Room Management ───────────────────────────────────────────
const rooms = new Map();

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
}

// ─── Socket.IO Events ──────────────────────────────────────────
function attachSocketHandlers(socketServer) {
    // Relay room events to BOTH socket servers (HTTPS desktop + HTTP app),
    // so signaling crosses between peers connected on different instances.
    const otherServer = socketServer === io ? ioHttp : io;
    function relay(roomId, event, data, sender) {
        if (!roomId) return;
        const payload = { ...data, from: sender.id };
        if (payload.to && payload.to !== sender.id) {
            // Targeted signaling (multi-receiver): send only to that peer
            sender.to(payload.to).emit(event, payload);
            otherServer.to(payload.to).emit(event, payload);
            return;
        }
        sender.to(roomId).emit(event, payload);
        otherServer.to(roomId).emit(event, payload);
    }

    function relayToRoom(roomId, event, data, sender, excludedIds) {
        if (!roomId) return;
        const payload = { ...data, from: sender ? sender.id : null };
        sender.to(roomId).emit(event, payload);
        otherServer.to(roomId).emit(event, payload);
    }

    // Broadcast to every socket in the room on BOTH servers (works even after sender disconnects)
    function emitRoom(roomId, event, data) {
        if (!roomId) return;
        socketServer.to(roomId).emit(event, data);
        otherServer.to(roomId).emit(event, data);
    }

    function findDevice(devices, socketId) {
        for (const [devId, dev] of devices) {
            if (dev.socketId === socketId) return dev;
        }
        return null;
    }

    function broadcastDevices(room, sender) {
        if (!room || !room.devices) return;
        const list = Array.from(room.devices.values());
        socketServer.to(room.id).emit('device-list', { devices: list });
        otherServer.to(room.id).emit('device-list', { devices: list });
    }

socketServer.on('connection', (socket) => {
    console.log(`📱 Client connected: ${socket.id}`);
    let currentRoom = null;
    let clientRole = null;

    // Create a new room
    socket.on('create-room', (callback) => {
        const roomId = generateRoomId();
        rooms.set(roomId, {
            id: roomId,
            desktops: [socket.id],
            mobile: null,
            devices: new Map(),
            created: Date.now()
        });
        currentRoom = roomId;
        clientRole = 'desktop';
        socket.join(roomId);
        console.log(`🏠 Room created: ${roomId} by ${socket.id}`);
        if (typeof callback === 'function') {
            callback({ roomId, ip: LOCAL_IP, port: PORT });
        }
    });

    // Join existing room
    socket.on('join-room', (data, callback) => {
        const roomId = data.room;
        const role = data.role || 'mobile';

        if (!rooms.has(roomId)) {
            if (typeof callback === 'function') {
                callback({ error: 'Room not found' });
            }
            return;
        }

        const room = rooms.get(roomId);
        if (role === 'desktop' || role === 'monitor') {
            if (!room.desktops) room.desktops = [];
            room.desktops.push(socket.id);
        }
        if (role === 'mobile') {
            room.mobile = socket.id;
        }
        currentRoom = roomId;
        clientRole = role;
        socket.join(roomId);

        console.log(`📲 ${role} joined room: ${roomId}`);

        // Notify the other peers (cross-server)
        relay(roomId, 'peer-joined', { role, id: socket.id }, socket);

        // Notify the joiner about existing peers (multi-receiver support)
        if (room.desktops) {
            room.desktops.forEach(deskId => {
                if (deskId !== socket.id) {
                    socket.emit('peer-joined', { role: 'desktop', id: deskId });
                }
            });
        }

        if (typeof callback === 'function') {
            callback({ success: true, roomId });
        }

        // Fresh device list for the joined peer
        const joinedRoom = rooms.get(roomId);
        if (role === 'mobile' && joinedRoom && joinedRoom.devices && joinedRoom.devices.size) {
            broadcastDevices(joinedRoom, socket);
        }
    });

    // Mobile devices announce themselves so the desktop can list them
    // ("buscar dispositivos conectados a la red")
    socket.on('register-device', (data) => {
        if (!currentRoom || clientRole !== 'mobile') return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        if (!room.devices) room.devices = new Map();
        room.devices.set(data.deviceId || socket.id, {
            deviceId: data.deviceId || socket.id,
            socketId: socket.id,
            name: data.name || 'iPhone',
            model: data.model || '',
            platform: data.platform || 'ios',
            native: !!data.native,
            battery: null,
            streaming: false,
            connectedAt: Date.now()
        });
        broadcastDevices(room, socket);
        console.log(`📱 Device registered in ${currentRoom}: ${data.name || 'iPhone'}`);
    });

    socket.on('select-device', (data) => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || !room.devices) return;
        if (!room.devices.has(data.deviceId)) return;
        relay(currentRoom, 'select-device', { deviceId: data.deviceId }, socket);
        socketServer.to(currentRoom).emit('device-selected', { deviceId: data.deviceId, from: 'desktop' });
        otherServer.to(currentRoom).emit('device-selected', { deviceId: data.deviceId, from: 'desktop' });
    });

    // WebRTC signaling: Offer
    socket.on('offer', (data) => {
        relay(data.room, 'offer', { sdp: data.sdp, from: socket.id }, socket);
    });

    // WebRTC signaling: Answer
    socket.on('answer', (data) => {
        relay(data.room, 'answer', { sdp: data.sdp, from: socket.id }, socket);
    });

    // WebRTC signaling: ICE Candidate
    socket.on('ice-candidate', (data) => {
        relay(data.room, 'ice-candidate', { candidate: data.candidate, from: socket.id }, socket);
    });

    // Camera control relay (desktop -> mobile)
    const controlEvents = [
        'camera-switch', 'flash-toggle', 'zoom-change', 'exposure-change',
        'focus-change', 'wb-change', 'resolution-change', 'fps-change',
        'filter-change', 'brightness-change', 'contrast-change',
        'saturation-change', 'mic-toggle', 'mic-gain', 'orientation-change',
        'beauty-config'

    ];

    controlEvents.forEach(event => {
        socket.on(event, (data) => {
            relay(currentRoom, event, data, socket);
        });
    });

    // Status relay (mobile -> desktop)
    const statusEvents = [
        'camera-status', 'stats-update', 'battery-status', 'capabilities'
    ];

    statusEvents.forEach(event => {
        socket.on(event, (data) => {
            relay(currentRoom, event, data, socket);
            if (clientRole !== 'mobile') return;
            const room = currentRoom ? rooms.get(currentRoom) : null;
            if (!room || !room.devices) return;
            const dev = findDevice(room.devices, socket.id);
            if (!dev) return;
            if (event === 'battery-status' && data && typeof data.level === 'number') {
                dev.battery = data.level;
            }
            if (event === 'stats-update') {
                dev.streaming = true;
            }
            broadcastDevices(room, socket);
        });
    });

    // Virtual camera frame feed (desktop -> vcam-feed.exe stdin)
    socket.on('vcam-frame', (data, cb) => {
        if (!vcam.active || !vcam.proc) {
            if (typeof cb === 'function') cb({ ok: false, error: 'vcam inactive' });
            return;
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const frameSize = vcam.w * vcam.h * 1.5;
        if (buf.length !== frameSize) {
            if (typeof cb === 'function') cb({ ok: false, error: 'bad frame size' });
            return;
        }
        // Backpressure: drop frames if the consumer can't keep up
        let dropped = false;
        if (vcam.proc.stdin.writableLength > frameSize * 3) {
            dropped = true;
        } else {
            vcam.proc.stdin.write(buf);
        }
        if (typeof cb === 'function') cb({ ok: true, dropped });
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
        // If a mobile or desktop peer leaves, the stream is gone: stop the camera
        if (clientRole === 'mobile' || clientRole === 'desktop') {
            stopVcam();
        }
        if (currentRoom) {
            relay(currentRoom, 'peer-left', { role: clientRole, id: socket.id }, socket);

            // Clean up room if the main desktop leaves
            if (clientRole === 'desktop') {
                const room = rooms.get(currentRoom);
                if (room && room.desktops) {
                    room.desktops = room.desktops.filter(id => id !== socket.id);
                }
                rooms.delete(currentRoom);
                console.log(`🗑️  Room deleted: ${currentRoom}`);
            } else if (clientRole === 'monitor') {
                const room = rooms.get(currentRoom);
                if (room && room.desktops) {
                    room.desktops = room.desktops.filter(id => id !== socket.id);
                }
            } else if (clientRole === 'mobile' && rooms.has(currentRoom)) {
                const room = rooms.get(currentRoom);
                room.mobile = null;
                if (room.devices) {
                    for (const [devId, dev] of room.devices) {
                        if (dev.socketId === socket.id) room.devices.delete(devId);
                    }
                    broadcastDevices(room, socket);
                }
            }
        }
    });
});
}

attachSocketHandlers(io);
attachSocketHandlers(ioHttp);

// ─── Cleanup old rooms periodically ────────────────────────────
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    for (const [id, room] of rooms) {
        if (now - room.created > maxAge) {
            rooms.delete(id);
            console.log(`🗑️  Expired room cleaned: ${id}`);
        }
    }
}, 60 * 60 * 1000);

// ─── Start Server ──────────────────────────────────────────────
function startServer(cb) {
    // Always listen on the HTTP fallback port for the native app
    httpFallbackServer.listen(HTTP_PORT, '0.0.0.0', () => {
        console.log(`🌐 HTTP app server listening on :${HTTP_PORT}`);
    });

    if (server.listening) {
        if (cb) cb();
        return server;
    }
    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`ℹ️ Puerto ${PORT} ya está en uso. Conectando...`);
            if (cb) cb();
        } else {
            console.error('Server error:', err);
        }
    });
    server.listen(PORT, '0.0.0.0', () => {
        const protocol = server instanceof https.Server ? 'https' : 'http';
        console.log('');
        console.log('╔══════════════════════════════════════════════════╗');
        console.log('║          📸 PhoneCam Pro v1.0.0                 ║');
        console.log('╠══════════════════════════════════════════════════╣');
        console.log(`║  🖥️  Desktop: ${protocol}://${LOCAL_IP}:${PORT}/desktop/`);
        console.log(`║  📱 Mobile:  ${protocol}://${LOCAL_IP}:${PORT}/mobile/`);
        console.log(`║  🎬 OBS:     ${protocol}://${LOCAL_IP}:${PORT}/obs/`);
        console.log('╠══════════════════════════════════════════════════╣');
        console.log(`║  🌐 Local IP: ${LOCAL_IP}`);
        console.log(`║  🔌 HTTPS:   :${PORT}   HTTP (app): :${HTTP_PORT}`);
        console.log('╚══════════════════════════════════════════════════╝');
        console.log('');
        if (cb) cb();
    });
    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = {
    startServer,
    server,
    LOCAL_IP,
    PORT,
    getProtocol: () => (server instanceof https.Server ? 'https' : 'http')
};

