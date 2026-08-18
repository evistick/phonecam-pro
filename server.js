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
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Get local IP ──────────────────────────────────────────────
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
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
    const protocol = server instanceof https.Server ? 'https' : 'http';
    const url = `${protocol}://${LOCAL_IP}:${PORT}/mobile/?room=${room}`;
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
        port: PORT,
        protocol,
        version: '1.0.0'
    });
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
io.on('connection', (socket) => {
    console.log(`📱 Client connected: ${socket.id}`);
    let currentRoom = null;
    let clientRole = null;

    // Create a new room
    socket.on('create-room', (callback) => {
        const roomId = generateRoomId();
        rooms.set(roomId, {
            id: roomId,
            desktop: socket.id,
            mobile: null,
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
        room[role] = socket.id;
        currentRoom = roomId;
        clientRole = role;
        socket.join(roomId);

        console.log(`📲 ${role} joined room: ${roomId}`);

        // Notify the other peer
        socket.to(roomId).emit('peer-joined', { role, id: socket.id });

        if (typeof callback === 'function') {
            callback({ success: true, roomId });
        }
    });

    // WebRTC signaling: Offer
    socket.on('offer', (data) => {
        socket.to(data.room).emit('offer', { sdp: data.sdp, from: socket.id });
    });

    // WebRTC signaling: Answer
    socket.on('answer', (data) => {
        socket.to(data.room).emit('answer', { sdp: data.sdp, from: socket.id });
    });

    // WebRTC signaling: ICE Candidate
    socket.on('ice-candidate', (data) => {
        socket.to(data.room).emit('ice-candidate', { candidate: data.candidate, from: socket.id });
    });

    // Camera control relay (desktop -> mobile)
    const controlEvents = [
        'camera-switch', 'flash-toggle', 'zoom-change', 'exposure-change',
        'focus-change', 'wb-change', 'resolution-change', 'fps-change',
        'filter-change', 'brightness-change', 'contrast-change',
        'saturation-change', 'mic-toggle', 'mic-gain', 'orientation-change'
    ];

    controlEvents.forEach(event => {
        socket.on(event, (data) => {
            if (currentRoom) {
                socket.to(currentRoom).emit(event, data);
            }
        });
    });

    // Status relay (mobile -> desktop)
    const statusEvents = [
        'camera-status', 'stats-update', 'battery-status', 'capabilities'
    ];

    statusEvents.forEach(event => {
        socket.on(event, (data) => {
            if (currentRoom) {
                socket.to(currentRoom).emit(event, data);
            }
        });
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
        if (currentRoom) {
            socket.to(currentRoom).emit('peer-left', { role: clientRole, id: socket.id });

            // Clean up room if desktop leaves
            if (clientRole === 'desktop') {
                rooms.delete(currentRoom);
                console.log(`🗑️  Room deleted: ${currentRoom}`);
            } else if (clientRole === 'mobile' && rooms.has(currentRoom)) {
                const room = rooms.get(currentRoom);
                room.mobile = null;
            }
        }
    });
});

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
        console.log(`║  🔌 Port:     ${PORT}`);
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

