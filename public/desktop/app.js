/**
 * app.js â€” PhoneCam Pro Desktop Client
 * Handles video reception, recording, screenshots, overlays, and OBS integration
 */

(function () {
    'use strict';

    // â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        smoothCanvas: null,
        smoothCtx: null,
        currentFilter: 'none',
        faceMode: false,
        faceLoading: false,
        landmarker: null,
        faceLms: false,
        land: null,
        landPrev: null,
        landTarget: null,
        landT0: 0,
        landDur: 140,
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
        previewRAF: null
    };

    // â”€â”€â”€ DOM Elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const recordingIndicator = $('#recording-indicator');
    const recTimer = $('#rec-timer');

    // â”€â”€â”€ Initialize â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function init() {
        // Connect to server
        state.socket = io({
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000
        });

        state.socket.on('connect', () => {
            console.log('ðŸ”Œ Connected to server');
            createRoom();
        });

        state.socket.on('disconnect', () => {
            updateConnectionBadge('disconnected');
        });

        // Peer events
        state.socket.on('peer-joined', (data) => {
            if (data.role === 'mobile') {
                console.log('ðŸ“± Mobile peer joined');
                updateConnectionBadge('connecting');
                showToast('ðŸ“± TelÃ©fono conectado, iniciando stream...', 'success');
            }
        });

        state.socket.on('peer-left', (data) => {
            if (data.role === 'mobile') {
                console.log('ðŸ“± Mobile peer left');
                updateConnectionBadge('disconnected');
                showVideoPanel(false);
                if (state.vcamActive) {
                    stopVirtualCamera(false);
                }
                showToast('ðŸ“± TelÃ©fono desconectado', 'error');
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

        // Setup WebRTC signaling
        setupWebRTC();

        // UI Event listeners
        setupUIControls();

        // New room button
        $('#btn-new-room').addEventListener('click', createRoom);

        // Theme
        const savedTheme = localStorage.getItem('phonecam-theme') || 'dark';
        setTheme(savedTheme);
    }

    // â”€â”€â”€ Room Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function createRoom() {
        state.socket.emit('create-room', async (response) => {
            state.roomId = response.roomId;
            roomCode.textContent = response.roomId;
            console.log('ðŸ  Room created:', response.roomId);

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
        });
    }

    // â”€â”€â”€ WebRTC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function setupWebRTC() {
        // Clean previous connection
        if (state.rtc) {
            state.rtc.close();
        }

        if (!state.roomId) return;

        state.rtc = new PhoneCamRTC('desktop', state.socket, state.roomId);
        state.rtc.createPeerConnection();

        state.rtc.onRemoteStream = (stream) => {
            console.log('ðŸ“º Remote stream received');
            state.remoteStream = stream;
            remoteVideo.srcObject = stream;
            showVideoPanel(true);
            updateConnectionBadge('connected');
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

    // â”€â”€â”€ Virtual Camera (PhoneCam Pro device) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // The desktop captures the remote stream, converts RGBA -> NV12
    // and feeds it to the server, which writes it to the DirectShow
    // filter's shared-memory queue. The device then appears as
    // "PhoneCam Pro" in Teams, Zoom, Meet, etc. â€” just like Camo.
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
            showToast('ðŸ“± Conecta tu telÃ©fono primero', 'error');
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

            vcamStatus('Preparando cÃ¡mara virtual...', 'working');

            const res = await fetch('/api/virtualcam', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ w, h, fps: VCAM_FPS })
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error || 'Error al iniciar la cÃ¡mara virtual');
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
if (state.faceMode && state.smooth > 0) {
                        if (performance.now() - state.lastDet >= 120) {
                            state.lastDet = performance.now();
                            detectFaces(state.vcamCanvas);
                        }
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

            btn.innerHTML = 'â¹ï¸ Detener cÃ¡mara virtual';
            btn.classList.add('active');
            vcamStatus(
                'âœ… CÃ¡mara virtual activa (' + w + 'x' + h + '). Selecciona "PhoneCam Pro" en Teams/Zoom/Meet.',
                'success'
            );
            showToast('ðŸŽ¥ CÃ¡mara virtual iniciada', 'success');
        } catch (err) {
            console.error('Virtual camera error:', err);
            vcamStatus('âŒ ' + err.message, 'error');
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
            btn.innerHTML = 'ðŸŽ¥ Activar cÃ¡mara virtual';
            btn.classList.remove('active');
        }
        vcamStatus('CÃ¡mara virtual detenida. Selecciona "PhoneCam Pro" en tu app de videollamada.', '');
        if (showMsg) {
            showToast('â¹ï¸ CÃ¡mara virtual detenida', 'error');
        }
    }

    // â”€â”€â”€ Skin Smoothing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function smoothAlpha() {
        return 0.25 + (state.smooth / 100) * 0.5;
    }

    function applyPreviewFilter() {
        const def = PHONECAM.FILTERS[state.currentFilter];
        let css = def && def.css !== 'none' ? def.css : '';
        if (state.smooth > 0 && !state.faceMode) {
            const s = state.smooth / 100;
            const g = state.glow / 100;
            css += (css ? ' ' : '') + 'blur(' + (s * 2).toFixed(2) + 'px) brightness(' + (1 + s * 0.05 + g * 0.12).toFixed(3) + ')';
        }
        remoteVideo.style.filter = css;
    }

    function smoothSkin(ctx, w, h) {
        if (!state.smooth || !w || !h) return;
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

    // â”€â”€â”€ Face-Aware Smoothing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async function ensureFaceDetector() {
        if (state.landmarker) return true;
        if (state.faceLoading) return false;
        state.faceLoading = true;
        showToast('â³ Cargando detector facialâ€¦', '');
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
            showToast('âœ… Detector facial listo', 'success');
            return true;
        } catch (err) {
            console.error('Face detector load failed:', err);
            showToast('âŒ No se pudo cargar el detector facial', 'error');
            document.querySelectorAll('#d-face-mode-group button').forEach(b => {
                b.classList.toggle('active', b.dataset.value === 'frame');
            });
            state.faceMode = false;
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
        const dw = 288;
        const dh = Math.max(36, Math.round(dw * h / w));
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
        if (now - state.lastHit > 400) {
            state.landTarget = null;
            state.landPrev = null;
            state.land = null;
            state.faceLms = false;
            return null;
        }
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
        const mw = Math.round(w / 2), mh = Math.round(h / 2);
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
        mb.filter = 'blur(' + Math.max(6, Math.round(h / 40)) + 'px)';
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
        if (!vw || !vh || !state.faceMode || state.smooth <= 0) {
            ov.style.display = 'none';
            return;
        }
        if (performance.now() - state.lastDet >= 120) {
            state.lastDet = performance.now();
            detectFaces(remoteVideo);
        }
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
        if (!state.previewRAF && state.faceMode && state.smooth > 0) {
            const loop = () => {
                drawFaceOverlay();
                state.previewRAF = requestAnimationFrame(loop);
            };
            state.previewRAF = requestAnimationFrame(loop);
        }
    }

    function stopPreviewLoop() {
        if (state.previewRAF) {
            cancelAnimationFrame(state.previewRAF);
            state.previewRAF = null;
        }
        const ov = $('#face-overlay');
        if (ov) ov.style.display = 'none';
    }

    // â”€â”€â”€ UI Controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function setupUIControls() {
        // Theme toggle
        $('#btn-theme').addEventListener('click', () => {
            setTheme(state.theme === 'dark' ? 'light' : 'dark');
        });

        // Copy buttons
        $('#btn-copy-code').addEventListener('click', () => {
            copyToClipboard(roomCode.textContent);
            showToast('ðŸ“‹ CÃ³digo copiado', 'success');
        });

        $('#btn-copy-url').addEventListener('click', () => {
            copyToClipboard(mobileUrl.textContent);
            showToast('ðŸ“‹ URL copiada', 'success');
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
            btn.innerHTML = state.flashOn ? '<span>ðŸ’¡</span> Flash' : '<span>âš¡</span> Flash';
        });

        $('#d-btn-mic').addEventListener('click', () => {
            state.micOn = !state.micOn;
            state.socket.emit('mic-toggle');
            const btn = $('#d-btn-mic');
            btn.classList.toggle('active', state.micOn);
            btn.innerHTML = state.micOn ? '<span>ðŸŽ¤</span> Mic' : '<span>ðŸ”‡</span> Mic';
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
            state.socket.emit('brightness-change', { value: val });
        });

        $('#d-contrast').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-contrast-val').textContent = val + '%';
            state.socket.emit('contrast-change', { value: val });
        });

        $('#d-saturation').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-saturation-val').textContent = val + '%';
            state.socket.emit('saturation-change', { value: val });
        });

        // Skin smoothing
        $('#d-smooth').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-smooth-val').textContent = val + '%';
            state.smooth = val;
            applyPreviewFilter();
            if (state.smooth > 0 && state.faceMode) startPreviewLoop();
            if (state.smooth === 0) stopPreviewLoop();
        });

        // Skin brightening
        $('#d-glow').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#d-glow-val').textContent = val + '%';
            state.glow = val;
            applyPreviewFilter();
        });

        // Face mode
        document.querySelectorAll('#d-face-mode-group button').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (btn.classList.contains('active')) return;
                if (btn.dataset.value === 'face') {
                    const ok = await ensureFaceDetector();
                    if (!ok) return;
                    state.faceMode = true;
                    startPreviewLoop();
                } else {
                    state.faceMode = false;
                    state.faceLms = false;
                    state.land = state.landPrev = state.landTarget = null;
                    stopPreviewLoop();
                }
                document.querySelectorAll('#d-face-mode-group button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyPreviewFilter();
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
    }

    // â”€â”€â”€ Video Controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€â”€ Screenshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        if (state.faceMode && state.smooth > 0) {
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

        showToast('ðŸ“· Captura guardada', 'success');

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

    // â”€â”€â”€ Recording â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            showToast('Error al iniciar grabaciÃ³n', 'error');
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
            showToast('ðŸŽ¬ GrabaciÃ³n guardada', 'success');
        };

        state.mediaRecorder.start(1000); // Collect data every second
        state.recording = true;
        state.recordStartTime = Date.now();

        // UI
        recordingIndicator.style.display = 'flex';
        $('#btn-record').classList.add('active');
        $('#btn-record').innerHTML = 'â¹ï¸';

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
        $('#btn-record').innerHTML = 'âºï¸';

        if (state.recordTimerInterval) {
            clearInterval(state.recordTimerInterval);
        }
    }

    // â”€â”€â”€ Stats & Status Updates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function updateStats(stats) {
        if (!stats) return;

        const resolution = stats.video.width
            ? `${stats.video.width}Ã—${stats.video.height}`
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
        const icon = data.charging ? 'ðŸ”Œ' : (data.level > 20 ? 'ðŸ”‹' : 'ðŸª«');
        $('#d-stat-battery').textContent = `${icon} ${data.level}%`;
    }

    function updateCapabilities(caps) {
        console.log('ðŸ“± Camera capabilities:', caps);
    }

    function updateCameraStatus(status) {
        if (status.flash !== undefined) {
            state.flashOn = status.flash;
            const btn = $('#d-btn-flash');
            btn.classList.toggle('flash-on', state.flashOn);
            btn.innerHTML = state.flashOn ? '<span>ðŸ’¡</span> Flash' : '<span>âš¡</span> Flash';
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

    // â”€â”€â”€ Theme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function setTheme(theme) {
        state.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('phonecam-theme', theme);
        $('#btn-theme').textContent = theme === 'dark' ? 'ðŸŒ™' : 'â˜€ï¸';
    }

    // â”€â”€â”€ UI Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function showVideoPanel(show) {
        connectPanel.style.display = show ? 'none' : 'block';
        videoPanel.style.display = show ? 'block' : 'none';
    }

    function updateConnectionBadge(status) {
        connectionBadge.className = 'badge ' + status;
        const labels = {
            connected: 'Conectado',
            connecting: 'Conectando...',
            disconnected: 'Sin conexiÃ³n'
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

    // â”€â”€â”€ Keyboard Shortcuts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    document.addEventListener('DOMContentLoaded', init);

})();
