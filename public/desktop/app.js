/**
 * app.js — PhoneCam Pro Desktop Client
 * Handles video reception, recording, screenshots, overlays, and OBS integration
 */

(function () {
    'use strict';

    // ─── State ──────────────────────────────────────────────
    const state = {
        socket: null,
        rtc: null,
        roomId: null,
        remoteStream: null,
        mediaRecorder: null,
        recordedChunks: [],
        recording: false,
        recordStartTime: null,
        recordTimerInterval: null,
        mirrorH: false,
        mirrorV: false,
        gridVisible: false,
        overlayTextVisible: false,
        overlayTimestampVisible: false,
        timestampInterval: null,
        chromaKey: false,
        theme: 'dark',
        micOn: true,
        flashOn: false,
        vcamActive: false,
        vcamTimer: null,
        vcamCanvas: null,
        vcamCtx: null,
        vcamW: 0,
        vcamH: 0,
        smooth: 0,
        glow: 0,
        sharp: 0,
        devices: [],
        activeDeviceId: null,
        smoothCanvas: null,
        smoothCtx: null,
        currentFilter: 'none',
        faceMode: true,
        beautyEnabled: true,
        faceLoading: false,
        landmarker: null,
        faceLms: false,
        land: null,
        landPrev: null,
        landTarget: null,
        landT0: 0,
        landDur: 55,
        lastHit: 0,
        detCanvas: null,
        detCtx: null,
        detTs: 0,
        lastDet: 0,
        smoothLayer: null,
        smoothLayerCtx: null,
        maskCanvas: null,
        maskCtx: null,
        maskBlur: null,
        maskBlurCtx: null,
        previewRAF: null,
        dest: 'pc',
        audioCtx: null,
        audioAnalyser: null,
        audioRAF: null,
        audioMuted: false,
        audioSens: 50,
        audioPeaks: []
    };

    // ─── DOM Elements ───────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const connectPanel = $('#connect-panel');
    const videoPanel = $('#video-panel');
    const remoteVideo = $('#remote-video');
    const qrImage = $('#qr-image');
    const qrLoading = $('#qr-loading');
    const roomCode = $('#room-code');
    const mobileUrl = $('#mobile-url');
    const connectionBadge = $('#connection-badge');
    const connectionText = $('#connection-text');
    const deviceListEl = $('#device-list');
    const recordingIndicator = $('#recording-indicator');
    const recTimer = $('#rec-timer');
    const audioCanvas = $('#audio-canvas');
    const audioLevelText = $('#audio-level');
    const audioBadge = $('#audio-badge');
    const audioPeakText = $('#audio-peak');

    // ─── Initialize ─────────────────────────────────────────
    function init() {
        // Floating window layout
        initWindows();

        // Connect to server
        state.socket = io({
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000
        });

        state.socket.on('connect', () => {
            console.log('🔌 Connected to server');
            createRoom();
        });

        state.socket.on('disconnect', () => {
            updateConnectionBadge('disconnected');
        });

        // Peer events
state.socket.on('peer-joined', (data) => {
            if (data.role === 'mobile') {
                console.log('📱 Mobile peer joined');
                updateConnectionBadge('connecting');
                showToast('📱 Tel�fono conectado, iniciando stream...', 'success');
                if (state.dest === 'phone') emitBeautyConfig();
            }
        });

        state.socket.on('peer-left', (data) => {
            if (data.role === 'mobile') {
                console.log('📱 Mobile peer left');
                updateConnectionBadge('disconnected');
                showVideoPanel(false);
                state.remoteStream = null;
                teardownAudioMonitor();
                if (state.vcamActive) {
                    stopVirtualCamera(false);
                }
                showToast('📱 Teléfono desconectado', 'error');
            }
        });

        // Status updates from mobile
        state.socket.on('stats-update', updateStats);
        state.socket.on('battery-status', updateBattery);
        state.socket.on('capabilities', updateCapabilities);
        state.socket.on('camera-status', updateCameraStatus);
        state.socket.on('filter-change', (data) => {
            const filterDef = PHONECAM.FILTERS[data.filter];
            if (filterDef) {
                state.currentFilter = data.filter;
                $('#d-filter-select').value = data.filter;
                applyPreviewFilter();
            }
        });

        // Syncing panel when beauty is changed from the iPhone (on-device)
        state.socket.on('beauty-config', (data) => {
            if (typeof data.on === 'boolean') {
                state.beautyEnabled = data.on;
                $('#d-beauty-check').checked = data.on;
                $('#d-beauty-label').textContent = data.on ? 'Activado' : 'Desactivado';
                $('#d-smooth').disabled = !data.on;
                $('#d-glow').disabled = !data.on;
                $('#d-sharp').disabled = !data.on;
                if (!data.on) stopPreviewLoop();
            }
            if (typeof data.smooth === 'number') {
                state.smooth = data.smooth;
                const s = $('#d-smooth');
                s.value = data.smooth;
                $('#d-smooth-val').textContent = data.smooth + '%';
                const smin = parseFloat(s.min) || 0;
                const smax = parseFloat(s.max) || 100;
                s.style.setProperty('--p', (Math.min(100, Math.max(0, (data.smooth - smin) / (smax - smin) * 100))) + '%');
            }
            if (typeof data.glow === 'number') {
                state.glow = data.glow;
                const g = $('#d-glow');
                g.value = data.glow;
                $('#d-glow-val').textContent = data.glow + '%';
                const gmin = parseFloat(g.min) || 0;
                const gmax = parseFloat(g.max) || 100;
                g.style.setProperty('--p', (Math.min(100, Math.max(0, (data.glow - gmin) / (gmax - gmin) * 100))) + '%');
            }
            if (typeof data.sharp === 'number') {
                state.sharp = data.sharp;
                const sh = $('#d-sharp');
                sh.value = data.sharp;
                $('#d-sharp-val').textContent = data.sharp + '%';
                const shmin = parseFloat(sh.min) || 0;
                const shmax = parseFloat(sh.max) || 100;
                sh.style.setProperty('--p', (Math.min(100, Math.max(0, (data.sharp - shmin) / (shmax - shmin) * 100))) + '%');
            }
        });

        // Device discovery (devices visible in this room / same network)
        state.socket.on('device-list', (data) => {
            state.devices = data.devices || [];
            renderDevices();
        });

        state.socket.on('device-selected', (data) => {
            if (state.activeDeviceId === data.deviceId) return;
            state.activeDeviceId = data.deviceId;
            renderDevices();
        });

        // Setup WebRTC signaling
        setupWebRTC();

        // UI Event listeners
        setupUIControls();

        // New room button
        $('#btn-new-room').addEventListener('click', createRoom);

        // Theme
        const savedTheme = localStorage.getItem('phonecam-theme') || 'dark';
        setTheme(savedTheme);

        // Window caption controls (embedded in the macOS-style header)
        initWindowControls();
    }

    // ─── Room Management ────────────────────────────────────
    function createRoom() {
        state.socket.emit('create-room', async (response) => {
            state.roomId = response.roomId;
            roomCode.textContent = response.roomId;
            console.log('🏠 Room created:', response.roomId);

            // Fetch QR code
            try {
                const res = await fetch(`/api/qrcode/${response.roomId}`);
                const data = await res.json();

                qrImage.src = data.qr;
                qrImage.style.display = 'block';
                qrLoading.style.display = 'none';
                mobileUrl.textContent = data.url;
            } catch (err) {
                console.error('QR code error:', err);
                qrLoading.querySelector('span').textContent = 'Error al generar QR';
            }

            // Setup WebRTC for this room
            setupWebRTC();

            // Seed the device list (already connected phones in this room)
            state.devices = [];
            renderDevices();
            try {
                const devRes = await fetch(`/api/devices/${state.roomId}`);
                const devData = await devRes.json();
                state.devices = devData.devices || [];
                renderDevices();
            } catch (err) {
                console.error('Device list error:', err);
            }
        });
    }

    // ─── Device Discovery ────────────────────────────────────
    function renderDevices() {
        if (!deviceListEl) return;
        if (!state.devices.length) {
            deviceListEl.innerHTML = '<div class="device-empty">Sin dispositivos todavía. Escanea el QR con tu teléfono.</div>';
            return;
        }
        deviceListEl.innerHTML = '';
        state.devices.forEach(dev => {
            const item = document.createElement('div');
            item.className = 'device-item' + (state.activeDeviceId === dev.deviceId ? ' selected' : '');
            const bat = typeof dev.battery === 'number' ? ' · Batería ' + dev.battery + '%' : '';
            const badge = dev.streaming
                ? '<span class="device-badge streaming">● EN USO</span>'
                : '<span class="device-badge">Conectado</span>';
            item.innerHTML =
                '<span class="device-icon">📱</span>' +
                '<div class="device-info">' +
                '<div class="device-name"></div>' +
                '<div class="device-meta"></div>' +
                '</div>' + badge;
            item.querySelector('.device-name').textContent = dev.name || 'iPhone';
            item.querySelector('.device-meta').textContent = (dev.model || '') + (dev.native ? '· App' : '· Web') + bat;
            item.addEventListener('click', () => {
                state.activeDeviceId = dev.deviceId;
                renderDevices();
                state.socket.emit('select-device', { deviceId: dev.deviceId });
                showToast('📱 Usando ' + (dev.name || 'tu teléfono') + ' como cámara', 'success');
            });
            deviceListEl.appendChild(item);
        });
    }

    // ─── WebRTC ─────────────────────────────────────────────
    function setupWebRTC() {
        // Clean previous connection
        if (state.rtc) {
            state.rtc.close();
        }

        if (!state.roomId) return;

        state.rtc = new PhoneCamRTC('desktop', state.socket, state.roomId);
        state.rtc.createPeerConnection();

        state.rtc.onRemoteStream = (stream) => {
            console.log('📺 Remote stream received');
            state.remoteStream = stream;
            remoteVideo.srcObject = stream;
            showVideoPanel(true);
            updateConnectionBadge('connected');
            startAudioMonitor();
        };

        state.rtc.onConnectionStateChange = (connState) => {
            if (connState === 'connected') {
                updateConnectionBadge('connected');
            } else if (connState === 'disconnected' || connState === 'failed') {
                updateConnectionBadge('disconnected');
            } else {
                updateConnectionBadge('connecting');
            }
        };

        state.rtc.onStats = (stats) => {
            updateStats(stats);
        };
    }

    // ─── Virtual Camera (PhoneCam Pro device) ────────────────
    // The desktop captures the remote stream, converts RGBA -> NV12
    // and feeds it to the server, which writes it to the DirectShow
    // filter's shared-memory queue. The device then appears as
    // "PhoneCam Pro" in Teams, Zoom, Meet, etc. — just like Camo.
    const VCAM_MAX_W = 1280;
    const VCAM_MAX_H = 720;
    const VCAM_FPS = 30;

    function vcamStatus(msg, type) {
        const el = $('#vcam-status');
        if (el) {
            el.textContent = msg;
            el.className = 'obs-status ' + (type || '');
        }
    }

    function rgbaToNv12(src, w, h) {
        const total = (w * h * 3) / 2;
        const yuv = new Uint8Array(total);
        const yPlane = w * h;
        let o = 0;
        // Luma (BT.601 full-range integer math)
        for (let y = 0; y < h; y++) {
            const rowOff = y * w * 4;
            for (let x = 0; x < w; x++) {
                const i = rowOff + x * 4;
                const r = src[i], g = src[i + 1], b = src[i + 2];
                let yv = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                yuv[o] = yv > 255 ? 255 : yv;
                o++;
            }
        }
        // Chroma (2x2 average, interleaved U/V)
        let p = yPlane;
        for (let y = 0; y < h; y += 2) {
            const rowA = y * w * 4;
            const rowB = (y + 1) * w * 4;
            for (let x = 0; x < w; x += 2) {
                let r = 0, g = 0, b = 0;
                const iA0 = rowA + x * 4, iA1 = iA0 + 4;
                const iB0 = rowB + x * 4, iB1 = iB0 + 4;
                r = src[iA0] + src[iA1] + src[iB0] + src[iB1];
                g = src[iA0 + 1] + src[iA1 + 1] + src[iB0 + 1] + src[iB1 + 1];
                b = src[iA0 + 2] + src[iA1 + 2] + src[iB0 + 2] + src[iB1 + 2];
                r >>= 2; g >>= 2; b >>= 2;
                yuv[p] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                yuv[p + 1] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                p += 2;
            }
        }
        return yuv;
    }

    async function toggleVirtualCamera() {
        if (state.vcamActive) {
            stopVirtualCamera(true);
            return;
        }
        if (!state.remoteStream || !remoteVideo.videoWidth) {
            showToast('📱 Conecta tu teléfono primero', 'error');
            return;
        }

        const btn = $('#btn-vcam');
        btn.disabled = true;
        try {
            // Cap to 720p for performance; keep dimensions even (NV12 requirement)
            const srcW = remoteVideo.videoWidth;
            const srcH = remoteVideo.videoHeight;
            const scale = Math.min(1, VCAM_MAX_W / srcW, VCAM_MAX_H / srcH);
            const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
            const h = Math.max(2, Math.round((srcH * scale) / 2) * 2);

            vcamStatus('Preparando cámara virtual...', 'working');

            const res = await fetch('/api/virtualcam', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ w, h, fps: VCAM_FPS })
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error || 'Error al iniciar la cámara virtual');
            }

            state.vcamActive = true;
            state.vcamW = w;
            state.vcamH = h;

            // Offscreen canvas for capture
            if (!state.vcamCanvas) {
                state.vcamCanvas = document.createElement('canvas');
                state.vcamCtx = state.vcamCanvas.getContext('2d');
            }
            state.vcamCanvas.width = w;
            state.vcamCanvas.height = h;

            const interval = Math.max(16, Math.round(1000 / VCAM_FPS));
            state.vcamTimer = setInterval(() => {
if (!state.vcamActive || !state.remoteStream) return;
                state.vcamCtx.drawImage(remoteVideo, 0, 0, w, h);
                if (state.beautyEnabled && state.smooth > 0) {
                    detectFaces(state.vcamCanvas);
                    if (state.faceLms && buildSmoothLayer(state.vcamCanvas, w, h)) {
                        paintSmooth(state.vcamCtx);
                    }
                } else {
                    smoothSkin(state.vcamCtx, w, h);
                }
                const img = state.vcamCtx.getImageData(0, 0, w, h);
                const nv12 = rgbaToNv12(img.data, w, h);
                state.socket.emit('vcam-frame', nv12.buffer, (ack) => {
                    if (ack && !ack.ok) {
                        stopVirtualCamera(false);
                    }
                });
            }, interval);

            btn.innerHTML = '⏹️ Detener cámara virtual';
            btn.classList.add('active');
            vcamStatus(
                '✅ Cámara virtual activa (' + w + 'x' + h + '). Selecciona "PhoneCam Pro" en Teams/Zoom/Meet.',
                'success'
            );
            showToast('🎥 Cámara virtual iniciada', 'success');
        } catch (err) {
            console.error('Virtual camera error:', err);
            vcamStatus('❌ ' + err.message, 'error');
        } finally {
            btn.disabled = false;
        }
    }

    function stopVirtualCamera(showMsg) {
        state.vcamActive = false;
        if (state.vcamTimer) {
            clearInterval(state.vcamTimer);
            state.vcamTimer = null;
        }
        fetch('/api/virtualcam/stop', { method: 'POST' }).catch(() => {});

        const btn = $('#btn-vcam');
        if (btn) {
            btn.innerHTML = '🎥 Activar cámara virtual';
            btn.classList.remove('active');
        }
        vcamStatus('Cámara virtual detenida. Selecciona "PhoneCam Pro" en tu app de videollamada.', '');
        if (showMsg) {
            showToast('⏹️ Cámara virtual detenida', 'error');
        }
    }

    // ─── Skin Smoothing ─────────────────────────────────────
    function smoothAlpha() {
        return 0.25 + (state.smooth / 100) * 0.5;
    }

    function emitBeautyConfig() {
        state.socket.emit('beauty-config', {
            on: state.beautyEnabled,
            smooth: state.smooth,
            glow: state.glow,
            sharp: state.sharp,
            faceMode: true
        });
    }

    function applyPreviewFilter() {
        const def = PHONECAM.FILTERS[state.currentFilter];
        let css = def && def.css !== 'none' ? def.css : '';
        remoteVideo.style.filter = css;
    }

    function smoothSkin(ctx, w, h) {
        if (!state.beautyEnabled || !state.smooth || !w || !h) return;
        const sw = Math.max(64, Math.round(w / 4));
        const sh = Math.max(36, Math.round(h / 4));
        if (!state.smoothCanvas) {
            state.smoothCanvas = document.createElement('canvas');
            state.smoothCtx = state.smoothCanvas.getContext('2d');
        }
        if (state.smoothCanvas.width !== sw || state.smoothCanvas.height !== sh) {
            state.smoothCanvas.width = sw;
            state.smoothCanvas.height = sh;
        }
        const sctx = state.smoothCtx;
        sctx.filter = 'blur(' + Math.max(1, Math.round(w / 800)) + 'px)';
        sctx.drawImage(ctx.canvas, 0, 0, sw, sh);
        sctx.filter = 'none';
        ctx.save();
        ctx.globalAlpha = 0.25 + (state.smooth / 100) * 0.5;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(state.smoothCanvas, 0, 0, w, h);
        ctx.globalAlpha = 1;
        if (state.glow > 0) {
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.06 + (state.glow / 100) * 0.13;
            ctx.drawImage(state.smoothCanvas, 0, 0, w, h);
        }
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.05;
        ctx.drawImage(state.smoothCanvas, 0, 0, w, h);
        ctx.restore();
    }

    // ─── Face-Aware Smoothing ───────────────────────────────
    async function ensureFaceDetector() {
        if (state.landmarker) return true;
        if (state.faceLoading) return false;
        state.faceLoading = true;
        showToast('⏳ Cargando detector facial…', '');
        try {
            const vision = await import('./vendor/mediapipe/vision_bundle.mjs');
            const files = await vision.FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
            state.landmarker = await vision.FaceLandmarker.createFromOptions(files, {
                baseOptions: {
                    modelAssetPath: './vendor/mediapipe/face_landmarker.task',
                    delegate: 'CPU'
                },
                runningMode: 'VIDEO',
                numFaces: 2
            });
            showToast('✅ Detector facial listo', 'success');
            return true;
        } catch (err) {
            console.error('Face detector load failed:', err);
            showToast('❌ No se pudo cargar el detector facial', 'error');
            state.faceMode = true;
            applyPreviewFilter();
            return false;
        } finally {
            state.faceLoading = false;
        }
    }

    function convexHull(pts) {
        pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lower = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) {
            const p = pts[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    function detectFaces(source) {
        const w = source.videoWidth || source.width;
        const h = source.videoHeight || source.height;
        if (!state.landmarker || !w || !h) return;
        const dw = 224;
        const dh = Math.max(30, Math.round(dw * h / w));
        if (!state.detCanvas) {
            state.detCanvas = document.createElement('canvas');
            state.detCtx = state.detCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (state.detCanvas.width !== dw || state.detCanvas.height !== dh) {
            state.detCanvas.width = dw;
            state.detCanvas.height = dh;
        }
        state.detCtx.drawImage(source, 0, 0, dw, dh);
        try {
            const res = state.landmarker.detectForVideo(state.detCanvas, state.detTs += 33);
            const arr = res.faceLandmarks || [];
            if (arr.length) {
                const target = arr.map(lms => lms.map(p => ({ x: p.x, y: p.y })));
                state.landPrev = state.land || target;
                state.landTarget = target;
                state.land = null;
                state.lastHit = performance.now();
                state.landT0 = state.lastHit;
                state.faceLms = true;
            }
        } catch (err) {
            console.warn('detectForVideo error:', err);
        }
    }

    function getLands() {
        const now = performance.now();
        if (!state.landTarget) return null;
        if (now - state.lastHit > 130) {
            state.landTarget = null;
            state.landPrev = null;
            state.land = null;
            state.faceLms = false;
            return null;
        }
        // Near-instant tracking: very short snap so the mask glues to the face
        const prog = Math.min(1, (now - state.landT0) / state.landDur);
        const ease = 1 - Math.pow(1 - prog, 3);
        const t = state.landTarget, p = state.landPrev || t;
        const out = t.map((face, fi) => {
            const pf = p[fi] || face;
            return face.map((pt, i) => {
                const pp = pf[i] || pt;
                return { x: pp.x + (pt.x - pp.x) * ease, y: pp.y + (pt.y - pp.y) * ease };
            });
        });
        state.land = out;
        return out;
    }

    // Canonical MediaPipe Face Mesh index groups (468-pt topology)
    const FACE_HOLES = [
        { idxs: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], margin: 1.7 },
        { idxs: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398], margin: 1.7 },
        { idxs: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46], margin: 1.45 },
        { idxs: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276], margin: 1.45 },
        { idxs: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 185, 40, 39, 37, 0, 267, 269, 270, 409, 415, 310, 311, 312, 13, 82, 81, 42, 183, 78], margin: 1.4 },
        { idxs: [1, 2, 98, 327, 4, 5, 197, 195, 168], margin: 1.75 }
    ];

    function expandPoly(pts, f) {
        let cx = 0, cy = 0;
        for (const p of pts) { cx += p[0]; cy += p[1]; }
        cx /= pts.length; cy /= pts.length;
        return pts.map(p => [cx + (p[0] - cx) * f, cy + (p[1] - cy) * f]);
    }

    function fillPoly(ctx, poly, sx, sy) {
        ctx.beginPath();
        for (let i = 0; i < poly.length; i++) {
            const px = poly[i][0] * sx, py = poly[i][1] * sy;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
    }

    // --- Delaunay triangulation (Bowyer-Watson) over the 478 face landmarks ---
    const meshTriCache = {};

    function delaunay(pts) {
        const n = pts.length;
        const EPS = 1e-9;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let i = 0; i < n; i++) {
            const p = pts[i];
            if (p.x < minx) minx = p.x;
            if (p.y < miny) miny = p.y;
            if (p.x > maxx) maxx = p.x;
            if (p.y > maxy) maxy = p.y;
        }
        const dx = (maxx - minx) || 1, dy = (maxy - miny) || 1;
        const dmax = Math.max(dx, dy) * 10;
        const midx = (minx + maxx) / 2, midy = (miny + maxy) / 2;
        const P = pts.concat([
            { x: midx - dmax, y: midy - dmax },
            { x: midx, y: midy + dmax },
            { x: midx + dmax, y: midy - dmax }
        ]);
        let tris = [{ a: n, b: n + 1, c: n + 2 }];
        const inCirc = (a, b, c, p) => {
            const ax = P[a].x, ay = P[a].y, bx = P[b].x, by = P[b].y, cx = P[c].x, cy = P[c].y;
            const px = p.x, py = p.y;
            const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
            if (Math.abs(d) < 1e-12) return false;
            const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
            const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
            const r2 = (ux - ax) * (ux - ax) + (uy - ay) * (uy - ay);
            return (ux - px) * (ux - px) + (uy - py) * (uy - py) <= r2 + EPS;
        };
        for (let i = 0; i < n; i++) {
            const p = P[i];
            const bad = [], next = [];
            for (const t of tris) {
                if (inCirc(t.a, t.b, t.c, p)) bad.push(t); else next.push(t);
            }
            const edges = new Map();
            const key = (e1, e2) => e1 < e2 ? e1 + '_' + e2 : e2 + '_' + e1;
            for (const t of bad) {
                for (const [e1, e2] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
                    const k = key(e1, e2);
                    if (edges.has(k)) { const v = edges.get(k); v.c += 1; if (v.c >= 2) edges.delete(k); }
                    else edges.set(k, { c: 1, e1, e2 });
                }
            }
            for (const [k, v] of edges) next.push({ a: v.e1, b: v.e2, c: i });
            tris = next;
        }
        const out = [];
        for (const t of tris) {
            if (t.a < n && t.b < n && t.c < n) out.push([t.a, t.b, t.c]);
        }
        return out;
    }

    function inPoly(px, py, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    function buildSmoothLayer(source, w, h) {
        const lands = getLands();
        if (!lands) return false;
        const sw = Math.max(64, Math.round(w / 4));
        const sh = Math.max(36, Math.round(h / 4));
        if (!state.smoothCanvas) {
            state.smoothCanvas = document.createElement('canvas');
            state.smoothCtx = state.smoothCanvas.getContext('2d');
        }
        if (state.smoothCanvas.width !== sw || state.smoothCanvas.height !== sh) {
            state.smoothCanvas.width = sw;
            state.smoothCanvas.height = sh;
        }
        if (!state.smoothLayer) {
            state.smoothLayer = document.createElement('canvas');
            state.smoothLayerCtx = state.smoothLayer.getContext('2d');
        }
        if (state.smoothLayer.width !== w || state.smoothLayer.height !== h) {
            state.smoothLayer.width = w;
            state.smoothLayer.height = h;
        }
        const mw = Math.round(w / 3), mh = Math.round(h / 3);
        if (!state.maskCanvas) {
            state.maskCanvas = document.createElement('canvas');
            state.maskCtx = state.maskCanvas.getContext('2d');
        }
        if (state.maskCanvas.width !== mw || state.maskCanvas.height !== mh) {
            state.maskCanvas.width = mw;
            state.maskCanvas.height = mh;
        }

        let sfilter = 'blur(' + Math.max(1, Math.round(w / 800)) + 'px)';
        const sctx = state.smoothCtx;
        sctx.filter = sfilter;
        sctx.drawImage(source, 0, 0, sw, sh);
        sctx.filter = 'none';

        const lctx = state.smoothLayerCtx;
        lctx.clearRect(0, 0, w, h);
        lctx.imageSmoothingEnabled = true;
        lctx.drawImage(state.smoothCanvas, 0, 0, w, h);

        // Mask = real triangular skin mesh (Delaunay over landmarks), holes excluded by topology
        const m = state.maskCtx;
        m.clearRect(0, 0, mw, mh);
        m.filter = 'none';
        m.fillStyle = '#fff';
        for (const lms of lands) {
            const cnt = lms.length;
            if (!(cnt in meshTriCache)) meshTriCache[cnt] = delaunay(lms);
            const tris = meshTriCache[cnt];
            const oval = expandPoly(convexHull(lms.map(p => [p.x, p.y])), 1.05);
            const feats = [];
            for (const f of FACE_HOLES) {
                if (!f.idxs.every(i => i < cnt)) continue;
                feats.push(expandPoly(convexHull(f.idxs.map(i => [lms[i].x, lms[i].y])), 1.3));
            }
            for (const t of tris) {
                const a = lms[t[0]], b = lms[t[1]], c = lms[t[2]];
                const e1 = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
                const e2 = (a.x - c.x) * (a.x - c.x) + (a.y - c.y) * (a.y - c.y);
                const e3 = (b.x - c.x) * (b.x - c.x) + (b.y - c.y) * (b.y - c.y);
                if (e1 > 0.08 || e2 > 0.08 || e3 > 0.08) continue;
                const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
                if (!inPoly(cx, cy, oval)) continue;
                let skip = false;
                for (const f of feats) {
                    if (inPoly(a.x, a.y, f) || inPoly(b.x, b.y, f) || inPoly(c.x, c.y, f)) { skip = true; break; }
                }
                if (skip) continue;
                fp3(m, a, b, c, mw, mh);
            }
        }

        // Single-pass feather of the whole mask (brushes the triangle edges softly)
        if (!state.maskBlur) {
            state.maskBlur = document.createElement('canvas');
            state.maskBlurCtx = state.maskBlur.getContext('2d');
        }
        if (state.maskBlur.width !== mw || state.maskBlur.height !== mh) {
            state.maskBlur.width = mw;
            state.maskBlur.height = mh;
        }
        const mb = state.maskBlurCtx;
        mb.clearRect(0, 0, mw, mh);
        mb.filter = 'blur(' + Math.max(3, Math.round(mh / 40)) + 'px)';
        mb.drawImage(state.maskCanvas, 0, 0);
        mb.filter = 'none';
        m.clearRect(0, 0, mw, mh);
        m.drawImage(state.maskBlur, 0, 0);

        lctx.globalCompositeOperation = 'destination-in';
        lctx.drawImage(state.maskCanvas, 0, 0, w, h);
        lctx.globalCompositeOperation = 'source-over';
        return true;
    }

    function fp3(ctx, a, b, c, sx, sy) {
        ctx.beginPath();
        ctx.moveTo(a.x * sx, a.y * sy);
        ctx.lineTo(b.x * sx, b.y * sy);
        ctx.lineTo(c.x * sx, c.y * sy);
        ctx.closePath();
        ctx.fill();
    }

    function paintSmooth(ctx) {
        ctx.save();
        ctx.globalAlpha = smoothAlpha();
        ctx.drawImage(state.smoothLayer, 0, 0);
        ctx.globalAlpha = 1;
        if (state.glow > 0) {
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.04 + (state.glow / 100) * 0.13;
            ctx.drawImage(state.smoothLayer, 0, 0);
        }
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.06;
        ctx.drawImage(state.smoothLayer, 0, 0);
        ctx.restore();
    }

    function drawFaceOverlay() {
        const vw = remoteVideo.videoWidth, vh = remoteVideo.videoHeight;
        const ov = $('#face-overlay');
        if (!vw || !vh || !state.beautyEnabled || state.smooth <= 0) {
            ov.style.display = 'none';
            return;
        }
        detectFaces(remoteVideo);
        const wrap = $('#video-wrapper');
        const r = wrap.getBoundingClientRect();
        const sc = Math.min(r.width / vw, r.height / vh);
        const dwid = Math.round(vw * sc), dhei = Math.round(vh * sc);
        ov.style.display = 'block';
        ov.style.left = ((r.width - dwid) / 2) + 'px';
        ov.style.top = ((r.height - dhei) / 2) + 'px';
        ov.style.width = dwid + 'px';
        ov.style.height = dhei + 'px';
        if (ov.width !== vw || ov.height !== vh) { ov.width = vw; ov.height = vh; }
        const octx = ov.getContext('2d');
        octx.clearRect(0, 0, vw, vh);
        if (state.faceLms && buildSmoothLayer(remoteVideo, vw, vh)) {
            paintSmooth(octx);
        }
    }

    function startPreviewLoop() {
        if (state.previewRAF || !state.beautyEnabled || state.smooth <= 0) return;
        ensureFaceDetector().then((ok) => {
            if (!ok) return;
            if (state.previewRAF) return;
            if (!state.beautyEnabled || state.smooth <= 0) return;
            const loop = () => {
                drawFaceOverlay();
                state.previewRAF = requestAnimationFrame(loop);
            };
            state.previewRAF = requestAnimationFrame(loop);
        });
    }

    function stopPreviewLoop() {
        if (state.previewRAF) {
            cancelAnimationFrame(state.previewRAF);
            state.previewRAF = null;
        }
        const ov = $('#face-overlay');
        if (ov) ov.style.display = 'none';
    }

    // ─── Audio Visualizer (remote mic) ──────────────────────
    function startAudioMonitor() {
        if (state.audioRAF) return;
        if (!state.remoteStream) return;
        try {
            if (!state.audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                state.audioCtx = new AC();
            }
            if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
            if (!state.audioAnalyser) {
                const src = state.audioCtx.createMediaStreamSource(state.remoteStream);
                const analyser = state.audioCtx.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0.75;
                src.connect(analyser);
                state.audioAnalyser = analyser;
            }
            const loop = () => {
                const analyser = state.audioAnalyser;
                if (!analyser || !audioCanvas) { state.audioRAF = null; return; }
                drawAudioVisualizer(analyser);
                state.audioRAF = requestAnimationFrame(loop);
            };
            state.audioRAF = requestAnimationFrame(loop);
            if (audioBadge) audioBadge.textContent = '📡 EN VIVO';
        } catch (err) {
            console.warn('Audio visualizer error:', err);
            if (audioBadge) audioBadge.textContent = '⛔ ERROR';
        }
    }

    function stopAudioMonitor() {
        if (state.audioRAF) {
            cancelAnimationFrame(state.audioRAF);
            state.audioRAF = null;
        }
        if (audioBadge) audioBadge.textContent = 'Sin señal';
        if (audioLevelText) audioLevelText.textContent = '--';
        if (audioPeakText) audioPeakText.textContent = '--';
        if (audioCanvas) {
            const c = audioCanvas;
            const ctx = c.getContext('2d');
            ctx.clearRect(0, 0, c.width, c.height);
        }
    }

    function setAudioMuted(muted) {
        state.audioMuted = muted;
        if (remoteVideo) remoteVideo.muted = muted;
        const btn = $('#btn-audio-mute');
        if (btn) {
            btn.classList.toggle('active', muted);
            btn.innerHTML = muted ? '<span>🔇</span> Sonido' : '<span>🔊</span> Sonido';
        }
    }

    function drawAudioVisualizer(analyser) {
        if (!audioCanvas) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = audioCanvas.clientWidth || 260;
        const cssH = audioCanvas.clientHeight || 90;
        const W = Math.round(cssW * dpr);
        const H = Math.round(cssH * dpr);
        if (audioCanvas.width !== W || audioCanvas.height !== H) {
            audioCanvas.width = W;
            audioCanvas.height = H;
        }
        const ctx = audioCanvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        if (state.audioMuted || !state.remoteStream) {
            ctx.fillStyle = 'rgba(127,127,127,0.55)';
            ctx.font = (Math.round(11 * dpr)) + 'px JetBrains Mono, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(state.audioMuted ? 'MUTE' : 'SIN SEÑAL', W / 2, H / 2);
            return;
        }

        const fft = analyser.frequencyBinCount;
        const data = new Uint8Array(fft);
        analyser.getByteTimeDomainData(data);

        const sens = (state.audioSens || 50) / 100;
        const gain = 3.2 + sens * 18;

        // Level meter + peak
        let peak = 0;
        for (let i = 0; i < fft; i++) {
            const v = (data[i] - 128) / 128;
            const a = Math.abs(v);
            if (a > peak) peak = a;
        }
        state.audioPeaks = state.audioPeaks || [];
        state.audioPeaks.push(peak);
        if (state.audioPeaks.length > 12) state.audioPeaks.shift();
        const smoothPeak = state.audioPeaks.reduce((s, v) => s + v, 0) / state.audioPeaks.length;

        if (audioLevelText) {
            audioLevelText.textContent = (smoothPeak * 100).toFixed(0) + '%';
            audioLevelText.style.color = smoothPeak > 0.75 ? 'var(--danger)' : (smoothPeak > 0.4 ? 'var(--warning)' : 'var(--success)');
        }
        if (audioPeakText) audioPeakText.textContent = smoothPeak > 0.02 ? (smoothPeak * 100).toFixed(0) + '%' : '--';

        // Waveform
        const cols = 80;
        const step = Math.max(1, Math.floor(fft / cols));
        const bw = W / cols;
        const midY = H / 2;
        ctx.strokeStyle = 'var(--accent)';
        ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
        ctx.beginPath();
        for (let i = 0; i <= cols; i++) {
            let v = 0;
            for (let k = 0; k < step; k++) {
                const idx = i * step + k;
                if (idx < fft) v += (data[idx] - 128) / 128;
            }
            v /= step;
            const x = i * bw + bw / 2;
            const y = midY - v * midY * Math.min(1.6, gain / 2);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Bars (frequency-style, mirrored)
        const bars = Math.min(cols, 40);
        const barStep = Math.floor(fft / bars);
        const grad = ctx.createLinearGradient(0, H, 0, 0);
        grad.addColorStop(0, 'var(--success)');
        grad.addColorStop(0.6, 'var(--warning)');
        grad.addColorStop(1, 'var(--danger)');
        ctx.fillStyle = grad;
        for (let i = 0; i < bars; i++) {
            let v = 0;
            for (let k = 0; k < barStep; k++) {
                const idx = i * barStep + k;
                if (idx < fft) v += Math.abs((data[idx] - 128) / 128);
            }
            v /= barStep;
            const h = Math.min(H, v * H * Math.min(2.4, gain / 1.6));
            const x = i * (W / bars) + 1;
            ctx.fillRect(x, H - h, Math.max(1, W / bars - 2), h);
        }
    }

    function initAudioControls() {
        const enable = $('#btn-audio-enable');
        const mute = $('#btn-audio-mute');
        const sens = $('#audio-sens');

        if (enable) {
            enable.addEventListener('click', () => {
                if (state.audioRAF) {
                    stopAudioMonitor();
                    return;
                }
                if (!state.remoteStream) {
                    showToast('Conecta primero tu teléfono', 'error');
                    return;
                }
                startAudioMonitor();
            });
        }
        if (mute) {
            mute.addEventListener('click', () => {
                setAudioMuted(!state.audioMuted);
            });
        }
        if (sens) {
            sens.addEventListener('input', () => {
                state.audioSens = parseInt(sens.value) || 50;
                $('#audio-sens-val').textContent = state.audioSens + '%';
                fillSlider(sens);
            });
        }
        setAudioMuted(false);
    }

    function teardownAudioMonitor() {
        stopAudioMonitor();
        if (state.audioAnalyser) state.audioAnalyser = null;
    }

    // ─── UI Controls ────────────────────────────────────────
    function setupUIControls() {
        // macOS slider: paint the filled portion via a CSS custom property
        const fillSlider = (el) => {
            const min = parseFloat(el.min) || 0;
            const max = parseFloat(el.max) || 100;
            const val = parseFloat(el.value) || 0;
            const pct = clampNum((val - min) / (max - min) * 100, 0, 100);
            el.style.setProperty('--p', pct + '%');
        };

        // Theme toggle
        $('#btn-theme').addEventListener('click', () => {
            setTheme(state.theme === 'dark' ? 'light' : 'dark');
        });

        // Copy buttons
        $('#btn-copy-code').addEventListener('click', () => {
            copyToClipboard(roomCode.textContent);
            showToast('📋 Código copiado', 'success');
        });

        $('#btn-copy-url').addEventListener('click', () => {
            copyToClipboard(mobileUrl.textContent);
            showToast('📋 URL copiada', 'success');
        });

        // Virtual camera toggle
        $('#btn-vcam').addEventListener('click', toggleVirtualCamera);

        // Video controls
        $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
        $('#btn-pip').addEventListener('click', togglePiP);
        $('#btn-mirror-h').addEventListener('click', () => toggleMirror('h'));
        $('#btn-mirror-v').addEventListener('click', () => toggleMirror('v'));
        $('#btn-screenshot').addEventListener('click', takeScreenshot);
        $('#btn-record').addEventListener('click', toggleRecording);
        $('#btn-grid').addEventListener('click', toggleGrid);

        // Camera remote controls
        $('#d-btn-switch').addEventListener('click', () => {
            state.socket.emit('camera-switch');
        });

        $('#d-btn-flash').addEventListener('click', () => {
            state.flashOn = !state.flashOn;
            state.socket.emit('flash-toggle');
            const btn = $('#d-btn-flash');
            btn.classList.toggle('flash-on', state.flashOn);
            btn.innerHTML = state.flashOn ? '<span>💡</span> Flash' : '<span>⚡</span> Flash';
        });

        $('#d-btn-mic').addEventListener('click', () => {
            state.micOn = !state.micOn;
            state.socket.emit('mic-toggle');
            const btn = $('#d-btn-mic');
            btn.classList.toggle('active', state.micOn);
            btn.innerHTML = state.micOn ? '<span>🎤</span> Mic' : '<span>🔇</span> Mic';
        });

        // Resolution buttons
        document.querySelectorAll('#d-res-group button').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#d-res-group button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.socket.emit('resolution-change', { value: btn.dataset.value });
            });
        });

        // FPS buttons
        document.querySelectorAll('#d-fps-group button').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#d-fps-group button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.socket.emit('fps-change', { value: parseInt(btn.dataset.value) });
            });
        });

        // Orientation buttons
        document.querySelectorAll('#d-orientation-group button').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#d-orientation-group button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.socket.emit('orientation-change', { value: btn.dataset.value });
            });
        });

        // Filter select
        $('#d-filter-select').addEventListener('change', (e) => {
            const filterName = e.target.value;
            state.socket.emit('filter-change', { filter: filterName });
            const filterDef = PHONECAM.FILTERS[filterName];
            if (filterDef) {
                state.currentFilter = filterName;
                applyPreviewFilter();
            }
        });

        // Sliders
        $('#d-brightness').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-brightness-val').textContent = val + '%';
            fillSlider(e.target);
            state.socket.emit('brightness-change', { value: val });
        });

        $('#d-contrast').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-contrast-val').textContent = val + '%';
            fillSlider(e.target);
            state.socket.emit('contrast-change', { value: val });
        });

        $('#d-saturation').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-saturation-val').textContent = val + '%';
            fillSlider(e.target);
            state.socket.emit('saturation-change', { value: val });
        });

        // Skin smoothing
        $('#d-smooth').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-smooth-val').textContent = val + '%';
            fillSlider(e.target);
            state.smooth = val;
            applyPreviewFilter();
            if (state.smooth > 0 && state.beautyEnabled) startPreviewLoop();
            if (state.smooth === 0) stopPreviewLoop();
            if (state.dest === 'phone') emitBeautyConfig();
        });

        // Skin brightening
        $('#d-glow').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-glow-val').textContent = val + '%';
            fillSlider(e.target);
            state.glow = val;
            applyPreviewFilter();
            if (state.dest === 'phone') emitBeautyConfig();
        });

        // Skin sharpness (fine detail, restores texture over the smoothing)
        $('#d-sharp').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-sharp-val').textContent = val + '%';
            fillSlider(e.target);
            state.sharp = val;
            if (state.dest === 'phone') emitBeautyConfig();
        });

        // Beauty on/off toggle
        $('#d-beauty-check').addEventListener('change', (e) => {
            state.beautyEnabled = e.target.checked;
            const lbl = $('#d-beauty-label');
            $('#d-smooth').disabled = !state.beautyEnabled;
            $('#d-glow').disabled = !state.beautyEnabled;
            $('#d-sharp').disabled = !state.beautyEnabled;
            lbl.textContent = state.beautyEnabled ? 'Activado' : 'Desactivado';
            const qb = $('#btn-beauty-quick');
            if (qb) qb.classList.toggle('active', state.beautyEnabled);
            if (state.beautyEnabled) {
                if (state.smooth > 0) startPreviewLoop();
            } else {
                stopPreviewLoop();
            }
            if (state.dest === 'phone') emitBeautyConfig();
        });

        // Quick beauty toggle in the video toolbar
        const qbBtn = $('#btn-beauty-quick');
        if (qbBtn) {
            qbBtn.addEventListener('click', () => {
                $('#d-beauty-check').checked = !state.beautyEnabled;
                $('#d-beauty-check').dispatchEvent(new Event('change'));
                showToast(state.beautyEnabled ? '✨ Belleza del PC activada' : 'Belleza del PC desactivada', '');
            });
            // Reflect availability when the stream connects
            state.socket.on('peer-joined', (data) => {
                if (data.role === 'mobile') qbBtn.style.display = 'inline-flex';
            });
            state.socket.on('peer-left', (data) => {
                if (data.role === 'mobile') qbBtn.style.display = 'none';
            });
        }

        // Processing destination: PC (local) or iPhone (on-device)
        document.querySelectorAll('#d-dest-group button').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.classList.contains('active')) return;
                document.querySelectorAll('#d-dest-group button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.dest = btn.dataset.value;
                if (state.dest === 'phone') {
                    if (state.previewRAF) stopPreviewLoop();
                    emitBeautyConfig();
                } else {
                    state.socket.emit('beauty-config', { on: false });
                    if (state.smooth > 0 && state.beautyEnabled) {
                        startPreviewLoop();
                    } else {
                        applyPreviewFilter();
                    }
                }
            });
        });

        // Overlays
        $('#d-overlay-text').addEventListener('input', (e) => {
            const text = e.target.value;
            const overlay = $('#overlay-text');
            if (text) {
                overlay.textContent = text;
                overlay.style.display = 'block';
            } else {
                overlay.style.display = 'none';
            }
        });

        $('#d-overlay-timestamp').addEventListener('change', (e) => {
            const overlay = $('#overlay-timestamp');
            if (e.target.checked) {
                overlay.style.display = 'block';
                state.timestampInterval = setInterval(() => {
                    overlay.textContent = new Date().toLocaleString();
                }, 1000);
                overlay.textContent = new Date().toLocaleString();
            } else {
                overlay.style.display = 'none';
                if (state.timestampInterval) {
                    clearInterval(state.timestampInterval);
                }
            }
        });

        $('#d-chroma-key').addEventListener('change', (e) => {
            state.chromaKey = e.target.checked;
            remoteVideo.classList.toggle('chroma-key', state.chromaKey);
            if (state.chromaKey) {
                remoteVideo.style.backgroundColor = '#00ff00';
            } else {
                remoteVideo.style.backgroundColor = '#000';
            }
        });

        // Audio panel controls (visualizer + mute + sensibilidad)
        initAudioControls();
    }

    // ─── Video Controls ─────────────────────────────────────
    function toggleFullscreen() {
        const wrapper = $('#video-wrapper');
        if (!document.fullscreenElement) {
            wrapper.requestFullscreen().catch(err => console.warn(err));
            $('#btn-fullscreen').classList.add('active');
        } else {
            document.exitFullscreen();
            $('#btn-fullscreen').classList.remove('active');
        }
    }

    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) {
            $('#btn-fullscreen').classList.remove('active');
        }
    });

    async function togglePiP() {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                $('#btn-pip').classList.remove('active');
            } else {
                await remoteVideo.requestPictureInPicture();
                $('#btn-pip').classList.add('active');
            }
        } catch (err) {
            console.warn('PiP error:', err);
            showToast('Picture-in-Picture no disponible', 'error');
        }
    }

    function toggleMirror(axis) {
        const ov = $('#face-overlay');
        if (axis === 'h') {
            state.mirrorH = !state.mirrorH;
            remoteVideo.classList.toggle('mirror-h', state.mirrorH);
            if (ov) ov.classList.toggle('mirror-h', state.mirrorH);
            $('#btn-mirror-h').classList.toggle('active', state.mirrorH);
        } else {
            state.mirrorV = !state.mirrorV;
            remoteVideo.classList.toggle('mirror-v', state.mirrorV);
            if (ov) ov.classList.toggle('mirror-v', state.mirrorV);
            $('#btn-mirror-v').classList.toggle('active', state.mirrorV);
        }
    }

    function toggleGrid() {
        state.gridVisible = !state.gridVisible;
        $('#grid-overlay').style.display = state.gridVisible ? 'block' : 'none';
        $('#btn-grid').classList.toggle('active', state.gridVisible);
    }

    // ─── Screenshot ─────────────────────────────────────────
    function takeScreenshot() {
        if (!state.remoteStream) return;

        const canvas = document.createElement('canvas');
        canvas.width = remoteVideo.videoWidth;
        canvas.height = remoteVideo.videoHeight;
        const ctx = canvas.getContext('2d');

        // Apply mirror transforms if active
        if (state.mirrorH || state.mirrorV) {
            ctx.translate(
                state.mirrorH ? canvas.width : 0,
                state.mirrorV ? canvas.height : 0
            );
            ctx.scale(
                state.mirrorH ? -1 : 1,
                state.mirrorV ? -1 : 1
            );
        }

        ctx.drawImage(remoteVideo, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (state.beautyEnabled && state.smooth > 0) {
            detectFaces(canvas);
            if (state.faceLms && buildSmoothLayer(canvas, canvas.width, canvas.height)) {
                paintSmooth(ctx);
            }
        } else {
            smoothSkin(ctx, canvas.width, canvas.height);
        }

        // Download
        const link = document.createElement('a');
        link.download = `phonecam-${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();

        showToast('📷 Captura guardada', 'success');

        // Flash effect
        const flash = document.createElement('div');
        flash.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: white; z-index: 9999; pointer-events: none;
            animation: screenshot-flash 0.3s ease-out forwards;
        `;
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 300);
    }

    // Add screenshot flash animation
    const flashStyle = document.createElement('style');
    flashStyle.textContent = `
        @keyframes screenshot-flash {
            0% { opacity: 0.8; }
            100% { opacity: 0; }
        }
    `;
    document.head.appendChild(flashStyle);

    // ─── Recording ──────────────────────────────────────────
    function toggleRecording() {
        if (state.recording) {
            stopRecording();
        } else {
            startRecording();
        }
    }

    function startRecording() {
        if (!state.remoteStream) return;

        state.recordedChunks = [];

        const options = { mimeType: 'video/webm;codecs=vp9,opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = 'video/webm;codecs=vp8,opus';
        }
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = 'video/webm';
        }

        try {
            state.mediaRecorder = new MediaRecorder(state.remoteStream, options);
        } catch (e) {
            showToast('Error al iniciar grabación', 'error');
            return;
        }

        state.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                state.recordedChunks.push(event.data);
            }
        };

        state.mediaRecorder.onstop = () => {
            const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `phonecam-${Date.now()}.webm`;
            link.href = url;
            link.click();
            URL.revokeObjectURL(url);
            showToast('🎬 Grabación guardada', 'success');
        };

        state.mediaRecorder.start(1000); // Collect data every second
        state.recording = true;
        state.recordStartTime = Date.now();

        // UI
        recordingIndicator.style.display = 'flex';
        $('#btn-record').classList.add('active');
        $('#btn-record').innerHTML = '⏹️';

        // Timer
        state.recordTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - state.recordStartTime) / 1000);
            const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const sec = String(elapsed % 60).padStart(2, '0');
            recTimer.textContent = `${min}:${sec}`;
        }, 1000);
    }

    function stopRecording() {
        if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
            state.mediaRecorder.stop();
        }

        state.recording = false;
        recordingIndicator.style.display = 'none';
        $('#btn-record').classList.remove('active');
        $('#btn-record').innerHTML = '⏺️';

        if (state.recordTimerInterval) {
            clearInterval(state.recordTimerInterval);
        }
    }

    // ─── Stats & Status Updates ─────────────────────────────
    function updateStats(stats) {
        if (!stats) return;

        const resolution = stats.video.width
            ? `${stats.video.width}×${stats.video.height}`
            : '--';
        const fps = stats.video.fps ? Math.round(stats.video.fps) : '--';
        const bitrate = stats.video.bitrate
            ? (stats.video.bitrate > 1000
                ? (stats.video.bitrate / 1000).toFixed(1) + ' Mbps'
                : stats.video.bitrate + ' kbps')
            : '--';
        const latency = stats.connection.rtt ? stats.connection.rtt + ' ms' : '--';

        $('#d-stat-resolution').textContent = resolution;
        $('#d-stat-fps').textContent = fps;
        $('#d-stat-bitrate').textContent = bitrate;
        $('#d-stat-latency').textContent = latency;

        const connType = stats.connection.candidateType;
        if (connType) {
            const typeMap = {
                'host': 'LAN',
                'srflx': 'Internet',
                'relay': 'TURN Relay',
                'prflx': 'P2P'
            };
            $('#d-stat-connection').textContent = typeMap[connType] || connType;
        }
    }

    function updateBattery(data) {
        if (!data) return;
        const icon = data.charging ? '🔌' : (data.level > 20 ? '🔋' : '🪫');
        $('#d-stat-battery').textContent = `${icon} ${data.level}%`;
    }

    function updateCapabilities(caps) {
        console.log('📱 Camera capabilities:', caps);
    }

    function updateCameraStatus(status) {
        if (status.flash !== undefined) {
            state.flashOn = status.flash;
            const btn = $('#d-btn-flash');
            btn.classList.toggle('flash-on', state.flashOn);
            btn.innerHTML = state.flashOn ? '<span>💡</span> Flash' : '<span>⚡</span> Flash';
        }

        if (status.resolution) {
            document.querySelectorAll('#d-res-group button').forEach(b => {
                b.classList.toggle('active', b.dataset.value === status.resolution);
            });
        }

        if (status.fps) {
            document.querySelectorAll('#d-fps-group button').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.value) === status.fps);
            });
        }

        if (status.orientation) {
            document.querySelectorAll('#d-orientation-group button').forEach(b => {
                b.classList.toggle('active', b.dataset.value === status.orientation);
            });
        }
    }

    // ─── Theme ──────────────────────────────────────────────
    function setTheme(theme) {
        state.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('phonecam-theme', theme);
        $('#btn-theme').textContent = theme === 'dark' ? '🌙' : '☀️';
    }

    // ─── UI Helpers ─────────────────────────────────────────
    function showVideoPanel(show) {
        connectPanel.style.display = show ? 'none' : 'block';
        videoPanel.style.display = show ? 'block' : 'none';
        saveLayout();
    }

    function updateConnectionBadge(status) {
        connectionBadge.className = 'badge ' + status;
        const labels = {
            connected: 'Conectado',
            connecting: 'Conectando...',
            disconnected: 'Sin conexión'
        };
        connectionText.textContent = labels[status] || status;
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).catch(() => {
            // Fallback
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        });
    }

    function showToast(message, type) {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type || ''}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ─── Keyboard Shortcuts ─────────────────────────────────
    document.addEventListener('keydown', (e) => {
        // Only when not typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'f':
            case 'F':
                e.preventDefault();
                toggleFullscreen();
                break;
            case 'p':
            case 'P':
                e.preventDefault();
                togglePiP();
                break;
            case 's':
            case 'S':
                e.preventDefault();
                takeScreenshot();
                break;
            case 'r':
            case 'R':
                e.preventDefault();
                toggleRecording();
                break;
            case 'g':
            case 'G':
                e.preventDefault();
                toggleGrid();
                break;
            case 'm':
            case 'M':
                e.preventDefault();
                toggleMirror('h');
                break;
        }
    });

    // ─── Start ──────────────────────────────────────────────
    // ─── Window Management ─────────────────────────────────
    const LAYOUT_KEY = 'phonecam-layout';
    const LAYOUT_VER_KEY = 'phonecam-layout-v';
    const LAYOUT_VER = 4;

    function getWindowArea() {
        const main = document.getElementById('main');
        if (main) {
            const r = main.getBoundingClientRect();
            return { w: r.width, h: r.height };
        }
        const header = document.getElementById('header');
        const hh = header ? header.offsetHeight : 0;
        return { w: window.innerWidth, h: window.innerHeight - hh };
    }

    function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function applyRect(el, r, rect) {
        const isVideo = el.id === 'video-panel';
        const minW = isVideo ? 360 : 240;
        const minH = isVideo ? 200 : 90;
        const maxW = isVideo ? Math.max(minW, Math.floor(rect.width / 2)) : Math.max(minW, rect.width - 16);
        const maxH = isVideo ? Math.max(minH, Math.floor(rect.height / 2)) : Math.max(minH, rect.height - 16);
        const w = clampNum(r.w, minW, maxW);
        const hExplicit = !!r.h;
        let h;
        if (hExplicit) {
            h = clampNum(r.h, minH, maxH);
        } else if (isVideo) {
            h = Math.round(w * 9 / 16);
        } else {
            h = el.offsetHeight || 60;
        }
        const x = clampNum(r.x, 8, Math.max(8, rect.width - w - 8));
        const y = clampNum(r.y, 8, Math.max(8, rect.height - h - 8));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.width = w + 'px';
        if (hExplicit) el.style.height = h + 'px';
        else el.style.height = '';
    }

    function defaultLayout() {
        const area = getWindowArea();
        const pad = 8;
        const gap = 8;
        const cols = 4;
        const panelW = clampNum(Math.floor((area.w - pad * 2 - gap * (cols - 1)) / cols), 280, 500);
        const colX = (i) => Math.round(pad + i * (panelW + gap));
        const assign = (id, x, y, w, h) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.left = Math.round(x) + 'px';
            el.style.top = Math.round(y) + 'px';
            el.style.width = Math.round(w) + 'px';
            if (h) el.style.height = Math.round(h) + 'px';
            else el.style.height = '';
        };

        // Conectar: centrado arriba (mantiene su propio ancho).
        const cp = document.getElementById('connect-panel');
        const cw = clampNum((cp && cp.offsetWidth > 260 ? cp.offsetWidth : 400), 320, Math.min(430, area.w - pad * 2));
        const cLeft = Math.max(8, Math.round((area.w - cw) / 2));
        const cTop = 10;
        if (cp) {
            cp.style.width = cw + 'px';
            cp.style.left = cLeft + 'px';
            cp.style.top = cTop + 'px';
            cp.style.height = '';
        }

        // Columnas inferiores: mide el alto natural de los bloques para que
        // (Cámara+Monitor) y (VCam+Overlays) encajen dentro del área sin pasarse.
        const colIds = ['camera-ctrl-panel', 'image-ctrl-panel', 'beauty-panel', 'vcam-panel', 'stats-panel', 'overlay-panel', 'audio-panel'];
        for (const id of colIds) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.style.width = panelW + 'px';
            el.style.height = '';
        }
        const hOf = (id) => {
            const el = document.getElementById(id);
            return el ? (el.offsetHeight || 0) : 0;
        };
        const cameraH = hOf('camera-ctrl-panel');
        const statsH = hOf('stats-panel');
        const vcamH = hOf('vcam-panel');
        const overlayH = hOf('overlay-panel');
        const audioH = hOf('audio-panel');
        const colSpan = Math.max(cameraH + gap + statsH, vcamH + gap + overlayH + gap + audioH);

        let rowTop = Math.min(655, area.h - pad - colSpan);
        rowTop = clampNum(rowTop, 0, Math.max(0, area.h - pad - 240));

        // Video: centrado arriba y bien grande; su borde inferior toca justo
        // el borde superior de la fila de cuadros de abajo (rowTop).
        let vpH = Math.max(200, rowTop - cTop - gap);
        let vpw = Math.round(vpH * 16 / 9);
        if (vpw > area.w - pad * 2) {
            vpw = area.w - pad * 2;
            vpH = Math.round(vpw * 9 / 16);
        }
        const vLeft = Math.max(8, Math.round((area.w - vpw) / 2));
        assign('video-panel', vLeft, cTop, vpw, vpH);

        assign('camera-ctrl-panel', colX(0), rowTop, panelW, null);
        assign('image-ctrl-panel', colX(1), rowTop, panelW, area.h - pad - rowTop);
        assign('beauty-panel', colX(2), rowTop, panelW, area.h - pad - rowTop);
        assign('vcam-panel', colX(3), rowTop, panelW, null);
        assign('stats-panel', colX(0), rowTop + cameraH + gap, panelW, null);
        assign('overlay-panel', colX(3), rowTop + vcamH + gap, panelW, null);
        assign('audio-panel', colX(3), rowTop + vcamH + overlayH + gap * 2, panelW, null);
    }

    function saveLayout() {
        const out = {};
        document.querySelectorAll('.win').forEach(el => {
            const w = parseFloat(el.style.width) || 0;
            if (!w) return;
            out[el.id] = {
                x: parseFloat(el.style.left) || 0,
                y: parseFloat(el.style.top) || 0,
                w: w,
                h: el.style.height ? (parseFloat(el.style.height) || 0) : null
            };
        });
        try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(out)); } catch (e) {}
        try { localStorage.setItem(LAYOUT_VER_KEY, String(LAYOUT_VER)); } catch (e) {}
    }

    function loadLayout() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch (e) {}
        let useSaved = !!saved;
        if (useSaved) {
            try { useSaved = localStorage.getItem(LAYOUT_VER_KEY) === String(LAYOUT_VER); } catch (e) { useSaved = false; }
            if (!useSaved) {
                try { localStorage.removeItem(LAYOUT_KEY); } catch (e) {}
                saved = null;
            }
        }
        defaultLayout();
        if (!useSaved) {
            saveLayout();
            return;
        }
        const rect = document.getElementById('main').getBoundingClientRect();
        document.querySelectorAll('.win').forEach(el => {
            const r = saved && saved[el.id];
            if (!r || !r.w) return;
            if (el.id === 'connect-panel') {
                el.style.width = clampNum(r.w, 320, Math.max(320, rect.width - 16)) + 'px';
                if (r.h) el.style.height = r.h + 'px';
                else el.style.height = '';
            } else if (el.id === 'video-panel') {
                el.style.width = clampNum(r.w, 360, Math.max(360, Math.floor(rect.width / 2))) + 'px';
                if (r.h) el.style.height = Math.min(r.h, Math.floor(rect.height / 2)) + 'px';
                else el.style.height = '';
            } else {
                el.style.width = clampNum(r.w, 240, Math.max(240, rect.width - 16)) + 'px';
                if (r.h) el.style.height = r.h + 'px';
                else el.style.height = '';
            }
        });
        const cp = document.getElementById('connect-panel');
        const sr = saved && saved['connect-panel'];
        if (cp && sr && sr.w) {
            cp.style.left = clampNum(sr.x || 0, 8, Math.max(8, rect.width - cp.offsetWidth - 8)) + 'px';
            cp.style.top = clampNum(sr.y || 0, 8, Math.max(8, rect.height - cp.offsetHeight - 8)) + 'px';
        } else {
            centerConnectPanel();
        }
        saveLayout();
    }

    function centerConnectPanel() {
        const cp = document.getElementById('connect-panel');
        if (!cp || cp.style.display === 'none') return;
        const main = document.getElementById('main').getBoundingClientRect();
        const maxW = Math.max(300, main.width - 2 * (260 + 16));
        const w = clampNum(cp.offsetWidth || 400, Math.min(320, maxW), maxW);
        cp.style.width = w + 'px';
        const h = cp.offsetHeight || 420;
        cp.style.left = Math.max(8, Math.round((main.width - w) / 2)) + 'px';
        cp.style.top = Math.max(8, Math.round((main.height - h) / 2)) + 'px';
    }

    // Reactive tiling: on drop the windows auto-arrange into two columns
    // (video on one side, control panels stacked on the other), always inside #main.
    function autoArrange(animated) {
        const mainEl = document.getElementById('main');
        const rect = mainEl.getBoundingClientRect();
        const pad = 8;
        const wins = Array.from(document.querySelectorAll('.win')).filter(el => {
            if (!el.id || el.id === 'connect-panel') return false;
            if (el.style.display === 'none') return false;
            if (!el.offsetWidth && !el.offsetHeight) return false;
            return true;
        });
        if (wins.length) {
            if (animated) {
                mainEl.classList.add('arranging');
                setTimeout(() => mainEl.classList.remove('arranging'), 240);
            }
            const videoEl = document.getElementById('video-panel');
            const videoOn = videoEl && wins.indexOf(videoEl) !== -1;

            const place = (el, x, y, w) => {
                el.style.left = Math.round(x) + 'px';
                el.style.top = Math.round(y) + 'px';
                if (w) el.style.width = Math.round(w) + 'px';
            };

            let vw = 0, vh = 0, colX = pad, colBand = rect.width - pad * 2;
            if (videoOn) {
                vw = clampNum(parseFloat(videoEl.style.width) || Math.min(800, rect.width - pad * 2 - 320), 360, Math.max(360, Math.min(Math.floor(rect.width / 2) - pad, rect.width - pad * 2 - 240)));
                vh = clampNum(parseFloat(videoEl.style.height) || (vw * 9 / 16), 120, Math.max(120, Math.min(Math.floor(rect.height / 2) - pad, rect.height - pad * 2)));
                videoEl.style.height = vh + 'px';
                const videoRight = (parseFloat(videoEl.style.left) || pad) > (rect.width - vw) / 2;
                if (videoRight) {
                    colX = pad;
                    colBand = rect.width - pad * 2 - vw - pad;
                    place(videoEl, rect.width - pad - vw, pad, vw);
                } else {
                    colX = pad + vw + pad;
                    colBand = rect.width - pad * 2 - vw - pad;
                    place(videoEl, pad, pad, vw);
                }
            }

            const items = [];
            wins.sort((a, b) => {
                const ay = parseFloat(a.style.top) || 0, by = parseFloat(b.style.top) || 0;
                const ax = parseFloat(a.style.left) || 0, bx = parseFloat(b.style.left) || 0;
                return ay - by || ax - bx;
            });
            for (const el of wins) {
                if (el === videoEl) continue;
                const lo = Math.min(240, Math.max(120, colBand));
                const w = clampNum(parseFloat(el.style.width) || 260, lo, Math.max(lo, colBand));
                el.style.width = w + 'px';
                el.style.height = '';
                items.push({ el, w, h: el.offsetHeight || 90 });
            }

            // Pack the panels into columns that always fit inside the container:
            // one column at natural width when it fits vertically, otherwise
            // narrower columns (min 260px after CSS min-width), but never wider
            // than the space at hand.
            const availH = rect.height - pad * 2;
            const measure = (it, w) => {
                if (it.w !== w || !it.h) {
                    it.el.style.width = w + 'px';
                    it.h = it.el.offsetHeight || 90;
                    it.w = w;
                }
            };
            const colTotalW = (cols) =>
                cols.reduce((s, col) => s + Math.max(...col.items.map(i => i.w)), 0) + (cols.length - 1) * pad;
            const packItems = (band) => {
                let best = null;
                for (let c = 1; c <= items.length; c++) {
                    const colW = clampNum(Math.floor((band - (c - 1) * pad) / c), 260, 480);
                    if (c * colW + (c - 1) * pad > band) break;
                    for (const it of items) measure(it, colW);
                    const colsTry = [];
                    for (let i = 0; i < c; i++) colsTry.push({ items: [], h: 0 });
                    let overflow = false;
                    for (const it of items) {
                        let k = colsTry.findIndex(col => col.h + it.h + pad <= availH);
                        if (k === -1) { k = 0; overflow = true; }
                        colsTry[k].items.push(it);
                        colsTry[k].h += it.h + pad;
                    }
                    best = { cols: colsTry, colW };
                    if (!overflow) return best;
                }
                return best;
            };
            // Band-filling variant: stops when a panel no longer fits, so the
            // remainder can flow into the next free band.
            const packItemsBand = (list, band, capH) => {
                let best = null;
                for (let c = 1; c <= list.length; c++) {
                    const colW = clampNum(Math.floor((band - (c - 1) * pad) / c), 260, 480);
                    if (c * colW + (c - 1) * pad > band) break;
                    for (const it of list) measure(it, colW);
                    const colsTry = [];
                    for (let i = 0; i < c; i++) colsTry.push({ items: [], h: 0 });
                    let used = 0;
                    for (const it of list) {
                        const k = colsTry.findIndex(col => col.h + it.h + pad <= capH);
                        if (k === -1) break;
                        colsTry[k].items.push(it);
                        colsTry[k].h += it.h + pad;
                        used++;
                    }
                    best = { cols: colsTry, colW, used };
                    if (used === list.length) break;
                }
                if (best) for (const it of list) measure(it, best.colW);
                return best;
            };
            const placeCols = (cols, x0, y0) => {
                let x = x0;
                for (const col of cols) {
                    const cw = Math.max(...col.items.map(i => i.w));
                    let y = y0 || pad;
                    for (const it of col.items) {
                        place(it.el, x, y, it.w);
                        y += it.h + pad;
                    }
                    x += cw + pad;
                }
            };

            if (videoOn) {
                let pack = packItems(colBand);
                if (pack) {
                    // If several columns are needed but they don't fit horizontally,
                    // shrink the video to make room, then re-pack.
                    if (pack.cols.length > 1 && colTotalW(pack.cols) > colBand) {
                        const vw2 = clampNum(vw - (colTotalW(pack.cols) - colBand), 360, vw);
                        const newBand = rect.width - pad * 2 - vw2 - pad;
                        if (newBand > pad) {
                            const re = packItems(newBand);
                            if (re && colTotalW(re.cols) <= newBand) {
                                vw = vw2;
                                const videoRight = (parseFloat(videoEl.style.left) || pad) > (rect.width - vw) / 2;
                                colX = videoRight ? pad : pad + vw + pad;
                                videoEl.style.height = Math.round(clampNum(vw * 9 / 16, 120, Math.max(120, Math.min(Math.floor(rect.height / 2) - pad, rect.height - pad * 2)))) + 'px';
                                if (videoRight) place(videoEl, rect.width - pad - vw, pad, vw);
                                else place(videoEl, pad, pad, vw);
                                pack = re;
                            }
                        }
                    }
                    placeCols(pack.cols, colX);
                }
            } else {
                // The connect panel floats wherever it is: pack the control panels
                // into the free bands on either side of it (and below it when the
                // window is narrow) instead of overlapping it.
                const cp = document.getElementById('connect-panel');
                const cpOn = cp && cp.style.display !== 'none' && cp.offsetWidth;
                let allPlaced = false;
                if (cpOn) {
                    const cr = cp.getBoundingClientRect();
                    const cpl = cr.left - rect.left, cpr = cr.right - rect.left;
                    const cpb = cr.bottom - rect.top;
                    const bands = [];
                    if (cpl - pad * 2 >= 80) bands.push({ x: pad, y: pad, w: cpl - pad * 2, h: rect.height - pad * 2 });
                    if (rect.width - cpr - pad * 2 >= 80) bands.push({ x: cpr + pad, y: pad, w: rect.width - cpr - pad * 2, h: rect.height - pad * 2 });
                    const depth = rect.height - cpb - pad * 2;
                    if (depth >= 80) bands.push({ x: pad, y: cpb + pad, w: rect.width - pad * 2, h: depth });
                    bands.sort((a, b) => b.w - a.w || b.h - a.h);
                    let remaining = items.slice();
                    for (const band of bands) {
                        if (!remaining.length) break;
                        const pack = packItemsBand(remaining, band.w, band.h);
                        if (!pack || !pack.used) continue;
                        placeCols(pack.cols, band.x, band.y);
                        remaining = remaining.slice(pack.used);
                    }
                    if (!remaining.length) allPlaced = true;
                }
                if (!allPlaced) {
                    // Not enough room to keep the floating panel clear: dock it
                    // top-center and tile the controls below (the area scrolls).
                    if (cpOn) {
                        const dockW = cp.offsetWidth || 300;
                        place(cp, Math.max(8, Math.round((rect.width - dockW) / 2)), pad, dockW);
                        const pack = packItemsBand(items, rect.width - pad * 2, rect.height - pad * 2);
                        if (pack && pack.used) placeCols(pack.cols, pad, pad + (cp.offsetHeight || 420) + pad);
                    } else {
                        const pack = packItems(colBand);
                        if (pack) placeCols(pack.cols, pad);
                    }
                }
            }
        }
    }

    function raiseWin(el) {
        document.querySelectorAll('.win').forEach(w => w.classList.remove('z-top'));
        el.classList.add('z-top');
    }

    // Free-placement collision resolution: keeps the user's positions, but any
    // overlapping window is pushed gently out of the way (always inside #main).
    function resolveOverlaps(animated) {
        const mainEl = document.getElementById('main');
        const rect = mainEl.getBoundingClientRect();
        const pad = 8;
        const els = Array.from(document.querySelectorAll('.win')).filter(el => {
            if (el.style.display === 'none') return false;
            if (!el.offsetWidth && !el.offsetHeight) return false;
            return true;
        });
        if (els.length < 2) return;
        const boxes = els.map(el => {
            const r = el.getBoundingClientRect();
            return { el, x: r.left - rect.left, y: r.top - rect.top, w: el.offsetWidth, h: el.offsetHeight };
        });
        for (const b of boxes) {
            b.x = clampNum(b.x, pad, Math.max(pad, rect.width - b.w - pad));
            b.y = clampNum(b.y, pad, Math.max(pad, rect.height - b.h - pad));
        }
        const pushOut = (mover, fixed) => {
            const ox = Math.min(mover.x + mover.w, fixed.x + fixed.w) - Math.max(mover.x, fixed.x);
            const oy = Math.min(mover.y + mover.h, fixed.y + fixed.h) - Math.max(mover.y, fixed.y);
            if (ox <= 0 || oy <= 0) return false;
            const dx = (ox < oy) ? ox : 0;
            const dy = dx === 0 ? oy : 0;
            const acx = fixed.x + fixed.w / 2, bcx = mover.x + mover.w / 2;
            const acy = fixed.y + fixed.h / 2, bcy = mover.y + mover.h / 2;
            let nx = mover.x, ny = mover.y;
            if (dx) nx = mover.x + (bcx >= acx ? dx : -dx);
            else ny = mover.y + (bcy >= acy ? dy : -dy);
            nx = clampNum(nx, pad, Math.max(pad, rect.width - mover.w - pad));
            ny = clampNum(ny, pad, Math.max(pad, rect.height - mover.h - pad));
            if (nx !== mover.x || ny !== mover.y) {
                mover.x = nx;
                mover.y = ny;
                return true;
            }
            return false;
        };
        for (let pass = 0; pass < 10; pass++) {
            let moved = false;
            for (let i = 0; i < boxes.length; i++) {
                for (let j = i + 1; j < boxes.length; j++) {
                    const a = boxes[i], b = boxes[j];
                    if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) <= 0) continue;
                    if (Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) <= 0) continue;
                    let mover = (pass % 2 === 0) ? b : a;
                    if (a.el.id === 'connect-panel') mover = b;
                    else if (b.el.id === 'connect-panel') mover = a;
                    if (pushOut(mover, mover === a ? b : a)) moved = true;
                }
            }
            if (!moved) break;
        }
        if (animated) {
            mainEl.classList.add('arranging');
            setTimeout(() => mainEl.classList.remove('arranging'), 340);
        }
        for (const b of boxes) {
            b.el.style.left = Math.round(b.x) + 'px';
            b.el.style.top = Math.round(b.y) + 'px';
        }
    }

// Magnetic snapping: near edges (or the center) of the app area or of sibling
// windows, the dragged window snaps to alignment (like macOS window movement).
function snapDrag(x, y, el, main) {
        const w = el.offsetWidth, h = el.offsetHeight;
        const T = 16;
        let sx = x, sy = y;
        const edgeX = [8, main.width - w - 8, Math.round((main.width - w) / 2)];
        for (const ex of edgeX) if (Math.abs(ex - x) <= T) { sx = ex; break; }
        const edgeY = [8, main.height - h - 8, Math.round((main.height - h) / 2)];
        for (const ey of edgeY) if (Math.abs(ey - y) <= T) { sy = ey; break; }
        document.querySelectorAll('.win').forEach(ob => {
            if (ob === el || !ob.id || ob.style.display === 'none' || !ob.offsetWidth) return;
            const r = ob.getBoundingClientRect();
            const ol = r.left - main.left, ot = r.top - main.top;
            const vertHit = y < ot + r.height + T && y + h > ot - T;
            if (vertHit) {
                const tx = [ol - w - 8, ol, ol + r.width + 8, ol + Math.round((r.width - w) / 2)];
                for (const t of tx) if (Math.abs(t - x) <= T) { sx = t; break; }
            }
            const horizHit = x < ol + r.width + T && x + w > ol - T;
            if (horizHit) {
                const ty = [ot - h - 8, ot, ot + r.height + 8, ot + Math.round((r.height - h) / 2)];
                for (const t of ty) if (Math.abs(t - y) <= T) { sy = t; break; }
            }
        });
        sx = clampNum(sx, 8, Math.max(8, main.width - w - 8));
        sy = clampNum(sy, 8, Math.max(8, main.height - h - 8));
        return { x: sx, y: sy };
    }

    function bindWindowDrag(el) {
        const handle = el.querySelector('.ctrl-header, .window-bar');
        if (!handle) return;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button, select, input, textarea, a, label')) return;
            e.preventDefault();
            document.getElementById('main').classList.remove('arranging');
            raiseWin(el);
            const rect = el.getBoundingClientRect();
            const mainEl = document.getElementById('main');
            const mainRect = mainEl.getBoundingClientRect();
            const dx = e.clientX - rect.left;
            const dy = e.clientY - rect.top;
            let moved = false;
            try { handle.setPointerCapture(e.pointerId); } catch (err) {}
            document.body.classList.add('dragging');
            el.classList.add('win-dragging');
            const onMove = (ev) => {
                if (Math.abs(ev.clientX - e.clientX) > 4 || Math.abs(ev.clientY - e.clientY) > 4) moved = true;
                if (!moved) return;
                const bx = clampNum(ev.clientX - dx - mainRect.left, 8, mainRect.width - el.offsetWidth - 8);
                const by = clampNum(ev.clientY - dy - mainRect.top, 8, mainRect.height - el.offsetHeight - 8);
                const s = snapDrag(bx, by, el, mainRect);
                el.style.left = s.x + 'px';
                el.style.top = s.y + 'px';
            };
            const onUp = () => {
                document.body.classList.remove('dragging');
                el.classList.remove('win-dragging');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
                if (moved) {
                    resolveOverlaps(true);
                    saveLayout();
                }
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
    }

    function bindWindowResize(el) {
        const resizer = el.querySelector('.win-resizer');
        if (!resizer) return;
        resizer.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.getElementById('main').classList.remove('arranging');
            raiseWin(el);
            const startW = el.offsetWidth;
            const startH = el.offsetHeight;
            const left = parseFloat(el.style.left) || 0;
            const top = parseFloat(el.style.top) || 0;
            const minW = el.id === 'video-panel' ? 360 : 240;
            const minH = el.id === 'video-panel' ? 200 : 90;
            const px = e.clientX, py = e.clientY;
            const isVideo = el.id === 'video-panel';
            const mainRect = document.getElementById('main').getBoundingClientRect();
            const maxW = isVideo
                ? Math.max(minW, Math.floor(mainRect.width / 2))
                : mainRect.width - left - 8;
            const maxH = isVideo
                ? Math.max(minH, Math.floor(mainRect.height / 2))
                : mainRect.height - top - 8;
            try { resizer.setPointerCapture(e.pointerId); } catch (err) {}
            document.body.classList.add('resizing');
            el.classList.add('win-resizing');
            const onMove = (ev) => {
                const w = clampNum(startW + (ev.clientX - px), minW, maxW);
                const h = clampNum(startH + (ev.clientY - py), minH, maxH);
                el.style.width = w + 'px';
                el.style.height = h + 'px';
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                try { resizer.releasePointerCapture(e.pointerId); } catch (err) {}
                document.body.classList.remove('resizing');
                el.classList.remove('win-resizing');
                resolveOverlaps(true);
                saveLayout();
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
    }

    function initWindowControls() {
        const wc = window.winControls || null;
        const btnMin = document.getElementById('btn-win-min');
        const btnMax = document.getElementById('btn-win-max');
        const btnClose = document.getElementById('btn-win-close');
        const MAX_GLYPH = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>';
        const RESTORE_GLYPH = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/><rect x="2" y="2" width="7" height="7" fill="rgba(127,127,127,0.35)" stroke="currentColor"/></svg>';
        const applyMaxState = (maximized) => {
            if (btnMax) {
                btnMax.innerHTML = maximized ? RESTORE_GLYPH : MAX_GLYPH;
                btnMax.title = maximized ? 'Restaurar' : 'Maximizar';
            }
        };
        if (btnMin) {
            btnMin.addEventListener('click', (e) => { e.preventDefault(); if (wc) wc.minimize(); });
        }
        if (btnMax) {
            btnMax.addEventListener('click', (e) => { e.preventDefault(); if (wc) wc.toggleMaximize(); });
        }
        if (btnClose) {
            btnClose.addEventListener('click', (e) => { e.preventDefault(); if (wc) wc.close(); else window.close(); });
        }
        if (wc && wc.onMaximized) wc.onMaximized(applyMaxState);
        const header = document.getElementById('header');
        if (header) {
            header.addEventListener('dblclick', (e) => {
                if (e.target.closest('button, a, input, select, textarea, label')) return;
                if (wc) wc.toggleMaximize();
            });
        }
    }

    function initWindows() {
        loadLayout();
        document.querySelectorAll('.win').forEach(el => {
            bindWindowDrag(el);
            bindWindowResize(el);
        });
        window.addEventListener('resize', () => {
            const cr = document.getElementById('main').getBoundingClientRect();
            document.querySelectorAll('.win').forEach(el => {
                if (el.style.display === 'none') return;
                el.style.left = clampNum(parseFloat(el.style.left) || 8, 8, Math.max(8, cr.width - el.offsetWidth - 8)) + 'px';
                el.style.top = clampNum(parseFloat(el.style.top) || 8, 8, Math.max(8, cr.height - el.offsetHeight - 8)) + 'px';
            });
            saveLayout();
        });
        const resetBtn = document.getElementById('btn-reset-layout');
        if (resetBtn) resetBtn.addEventListener('click', () => {
            try { localStorage.removeItem(LAYOUT_KEY); } catch (e) {}
            try { localStorage.removeItem(LAYOUT_VER_KEY); } catch (e) {}
            defaultLayout();
            saveLayout();
        });
    }

    document.addEventListener('DOMContentLoaded', init);

})();
