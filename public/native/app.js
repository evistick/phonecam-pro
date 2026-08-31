/**
 * app.js — PhoneCam Pro Mobile Client (iPhone & Android)
 * Live camera QR scanning with auto-connect, WebRTC 1080p 60fps streaming & full controls
 */

(function () {
    'use strict';

    // ─── State ──────────────────────────────────────────────
    const state = {
        socket: null,
        rtc: null,
        rtcs: {}, // multi-peer: peerId -> PhoneCamRTC
        knownPeers: new Set(),
        roomId: null,
        serverUrl: null,
        stream: null,
        scannerStream: null,
        isScanning: false,
        scanAnimationId: null,
        audioContext: null,
        gainNode: null,
facingMode: 'environment', // 'user' or 'environment'
        flashOn: false,
        micOn: true,
        rawVideoTrack: null,
        currentResolution: '1080p',
        currentFPS: 60,
        currentFilter: 'none',
        brightness: 100,
        contrast: 100,
        saturation: 100,
        zoom: 1,
        capabilities: null,
        reconnecting: false,
        statsVisible: false,
        settingsVisible: false,
        orientation: 'auto', // 'auto' | 'portrait' | 'landscape'
        blackout: false,
        beautyOn: false,
        scanRetryTimer: null,
        camRetryTimer: null,
        beautyConfig: { on: false, smooth: 85, glow: 62, sharp: 45, faceMode: true }
    };

    // ─── DOM Elements ───────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const connectScreen = $('#connect-screen');
    const cameraScreen = $('#camera-screen');
    const scannerContainer = $('#scanner-container');
    const manualContainer = $('#manual-container');
    const scannerVideo = $('#scanner-video');
    const scannerCanvas = $('#scanner-canvas');
    const roomInput = $('#room-input');
    const connectBtn = $('#connect-btn');
    const connectStatus = $('#connect-status');
    const localVideo = $('#local-video');
    const connectionIndicator = $('#connection-indicator');
    const connectionLabel = $('#connection-label');
    const batteryLevel = $('#battery-level');
    const resolutionLabel = $('#resolution-label');
    const statsOverlay = $('#stats-overlay');
    const settingsPanel = $('#settings-panel');
    const beautyToggle = $('#beauty-toggle');
    const beautySliders = $('#beauty-sliders');
    const beautySmooth = $('#beauty-smooth');
    const beautyGlow = $('#beauty-glow');
    const beautySharp = $('#beauty-sharp');
    const quickBeautyBtn = $('#btn-quick-beauty');

    // ─── Initialize ─────────────────────────────────────────
    const LAST_ROOM_KEY = 'phonecam-last-room';

    function init() {
        // Pre-fill saved server IP in manual mode
        const savedServer = localStorage.getItem('phonecam-server');
        const serverInput = document.getElementById('server-input');
        if (savedServer && serverInput) {
            serverInput.value = savedServer.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        }

        const params = new URLSearchParams(window.location.search);
        const roomFromUrl = params.get('room');

        if (roomFromUrl) {
            roomInput.value = roomFromUrl;
            state.roomId = roomFromUrl.toUpperCase();
            connect();
        } else if (savedServer && savedRoom()) {
            // Auto-reconnect: misma IP del PC y última sala que ya se usaron
            showStatus('Reconectando a la sala anterior…', '');
            connect(savedRoom());
        } else {
            // Start real-time QR scanner on mobile screen
            startQRScanner();
        }

        // Event listeners
        connectBtn.addEventListener('click', () => connect());
        roomInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') connect();
        });
        roomInput.addEventListener('input', () => {
            roomInput.value = roomInput.value.toUpperCase();
        });

        // Switch between Scanner and Manual Code
        $('#btn-toggle-manual').addEventListener('click', () => {
            stopQRScanner();
            scannerContainer.style.display = 'none';
            manualContainer.style.display = 'block';
        });

        $('#btn-back-scanner').addEventListener('click', () => {
            manualContainer.style.display = 'none';
            scannerContainer.style.display = 'flex';
            startQRScanner();
        });

        // Camera controls
        $('#btn-switch-camera').addEventListener('click', switchCamera);
        $('#btn-flash').addEventListener('click', toggleFlash);
        $('#btn-mic').addEventListener('click', toggleMic);
        $('#btn-stats').addEventListener('click', toggleStats);
        $('#btn-settings').addEventListener('click', toggleSettings);
        $('#btn-close-settings').addEventListener('click', () => toggleSettings(false));
        $('#btn-disconnect').addEventListener('click', disconnect);

        // Liquid-glass UI: tap the camera to hide/reveal controls; tap scrim to close settings
        $('#video-container').addEventListener('click', () => {
            if (!state.settingsVisible) document.body.classList.toggle('ui-hidden');
        });
        $('#settings-scrim').addEventListener('click', () => toggleSettings(false));

        // Resolution buttons
        document.querySelectorAll('#resolution-group .toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#resolution-group .toggle-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                changeResolution(btn.dataset.value);
            });
        });

        // FPS buttons
        document.querySelectorAll('#fps-group .toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#fps-group .toggle-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                changeFPS(parseInt(btn.dataset.value));
            });
        });

        // Filter buttons
        document.querySelectorAll('#filter-group .filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#filter-group .filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyFilter(btn.dataset.value);
            });
        });

        // Beauty on-device toggle
        beautyToggle.addEventListener('click', () => {
            applyBeautyConfig({ on: !state.beautyConfig.on });
            syncBeautyUI();
            emitBeautyToPC();
        });

        // Quick beauty on/off in the camera bar (dual with PC)
        quickBeautyBtn.addEventListener('click', () => {
            applyBeautyConfig({ on: !state.beautyConfig.on });
            syncBeautyUI();
            emitBeautyToPC();
        });

        // Beauty sliders
        beautySmooth.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#beauty-smooth-value').textContent = val + '%';
            applyBeautyConfig({ smooth: val });
            emitBeautyToPC();
        });

        beautyGlow.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#beauty-glow-value').textContent = val + '%';
            applyBeautyConfig({ glow: val });
            emitBeautyToPC();
        });

        beautySharp.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#beauty-sharp-value').textContent = val + '%';
            applyBeautyConfig({ sharp: val });
            emitBeautyToPC();
        });

        syncBeautyUI();

        // Orientation buttons
        document.querySelectorAll('#orientation-group .toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#orientation-group .toggle-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyOrientation(btn.dataset.value);
            });
        });

        // Blackout toggle
        $('#btn-blackout').addEventListener('click', toggleBlackout);
        $('#blackout-overlay').addEventListener('click', toggleBlackout);

        // iOS: getUserMedia requiere un toque del usuario para mostrar el prompt de permiso.
        // Si el intento inicial (sin gesto) se queda sin frames, el usuario toca y reintenta.
        $('#scan-retry-btn').addEventListener('click', () => {
            stopQRScanner();
            hideScanRetry();
            startQRScanner();
        });
        $('#cam-retry-btn').addEventListener('click', () => {
            hideCamRetry();
            if (state.stream) { try { state.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* noop */ } }
            state.stream = null;
            startCamera();
        });
        if (localVideo) localVideo.addEventListener('loadeddata', hideCamRetry);

        // Sliders
        $('#zoom-slider').addEventListener('input', (e) => {
            state.zoom = parseFloat(e.target.value);
            $('#zoom-value').textContent = state.zoom.toFixed(1) + 'x';
            applyZoom();
        });

        $('#exposure-slider').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            $('#exposure-value').textContent = val.toFixed(1);
            applyExposure(val);
        });

        $('#brightness-slider').addEventListener('input', (e) => {
            state.brightness = parseInt(e.target.value);
            $('#brightness-value').textContent = state.brightness + '%';
            applyVideoFilters();
        });

        $('#contrast-slider').addEventListener('input', (e) => {
            state.contrast = parseInt(e.target.value);
            $('#contrast-value').textContent = state.contrast + '%';
            applyVideoFilters();
        });

        $('#saturation-slider').addEventListener('input', (e) => {
            state.saturation = parseInt(e.target.value);
            $('#saturation-value').textContent = state.saturation + '%';
            applyVideoFilters();
        });

        $('#gain-slider').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            $('#gain-value').textContent = val + '%';
            applyMicGain(val / 100);
        });

        monitorBattery();
        document.addEventListener('dblclick', (e) => e.preventDefault());
    }

    // ─── Real-Time QR Scanner ───────────────────────────────
    // iOS/WKWebView: getUserMedia necesita un gesto del usuario para mostrar el
    // prompt de permiso. Si el arranque (sin gesto) no produce frames, se ofrece
    // un botón de toque que reintenta la cámara.
    function hideScanRetry() {
        const ov = $('#scan-retry-overlay');
        if (ov) ov.style.display = 'none';
        if (state.scanRetryTimer) {
            clearTimeout(state.scanRetryTimer);
            state.scanRetryTimer = null;
        }
    }

    function showScanRetry(msg) {
        const lb = $('#scan-retry-msg');
        if (lb) lb.textContent = msg || 'Toca para activar la cámara';
        const ov = $('#scan-retry-overlay');
        if (ov) ov.style.display = 'flex';
    }

    function hideCamRetry() {
        const ov = $('#cam-retry-overlay');
        if (ov) ov.style.display = 'none';
        if (state.camRetryTimer) {
            clearTimeout(state.camRetryTimer);
            state.camRetryTimer = null;
        }
    }

    function showCamRetry(msg) {
        const lb = $('#cam-retry-msg');
        if (lb) lb.textContent = msg || 'Toca para activar la cámara';
        const ov = $('#cam-retry-overlay');
        if (ov) ov.style.display = 'flex';
    }

    async function startQRScanner() {
        if (state.isScanning) return;
        state.isScanning = true;
        hideScanRetry();
        if (state.scanAnimationId) {
            cancelAnimationFrame(state.scanAnimationId);
            state.scanAnimationId = null;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });

            // Si lo cancelaron mientras esperábamos el permiso, no usar el stream.
            if (!state.isScanning) {
                try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* noop */ }
                return;
            }
            if (state.scannerStream) {
                try { state.scannerStream.getTracks().forEach(t => t.stop()); } catch (e) { /* noop */ }
            }
            state.scannerStream = stream;

            scannerVideo.srcObject = state.scannerStream;
            scannerVideo.setAttribute('playsinline', 'true');
            await scannerVideo.play();

            scanQRCodeFrame();

            // Si el permiso aún no se concedió (sin gesto), la cámara no entrega frames:
            // ofrecer un botón para reintentar con un toque.
            state.scanRetryTimer = setTimeout(() => {
                if (scannerVideo.readyState < scannerVideo.HAVE_ENOUGH_DATA) {
                    showScanRetry('Toca para activar la cámara y escanear el QR');
                }
            }, 2200);
        } catch (err) {
            console.warn('Scanner camera error:', err);
            // Mantener la pantalla del escáner y reintentar con un toque.
            // La opción de código manual sigue disponible debajo.
            showScanRetry('Se necesita el permiso de la cámara para escanear el QR');
        }
    }

    function stopQRScanner() {
        state.isScanning = false;
        hideScanRetry();
        if (state.scanAnimationId) {
            cancelAnimationFrame(state.scanAnimationId);
            state.scanAnimationId = null;
        }
        if (state.scannerStream) {
            state.scannerStream.getTracks().forEach(t => t.stop());
            state.scannerStream = null;
        }
    }

    function scanQRCodeFrame() {
        if (!state.isScanning) return;

        if (scannerVideo.readyState === scannerVideo.HAVE_ENOUGH_DATA) {
            hideScanRetry();
            const canvas = scannerCanvas;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            canvas.width = scannerVideo.videoWidth;
            canvas.height = scannerVideo.videoHeight;

            ctx.drawImage(scannerVideo, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            if (typeof jsQR !== 'undefined') {
                const code = jsQR(imageData.data, imageData.width, imageData.height, {
                    inversionAttempts: 'attemptBoth'
                });

                if (code && code.data) {
                    console.log('🎯 QR Code detected:', code.data);
                    handleScannedQR(code.data);
                    return;
                }
            }
        }

        state.scanAnimationId = requestAnimationFrame(scanQRCodeFrame);
    }

    function handleScannedQR(data) {
        // Haptic feedback & audio beep
        if ('vibrate' in navigator) {
            navigator.vibrate([80, 40, 80]);
        }

        stopQRScanner();

        let targetRoom = data.trim();
        let targetHost = null;

        // Check if QR contains full URL
        try {
            if (data.startsWith('http://') || data.startsWith('https://')) {
                const url = new URL(data);
                const roomParam = url.searchParams.get('room');
                if (roomParam) {
                    targetRoom = roomParam.toUpperCase();
                }
                // Force plain HTTP (port 3001) for the native app: no TLS cert hassle
                targetHost = `http://${url.hostname}:3001`;
            }
        } catch (e) {}

        state.roomId = targetRoom.toUpperCase();
        roomInput.value = state.roomId;

        if (targetHost) {
            // Connect directly to the server from the QR code (no web navigation)
            state.serverUrl = targetHost;
            localStorage.setItem('phonecam-server', targetHost);
            connect();
            return;
        }

        connect();
    }

    // ─── Connection ─────────────────────────────────────────
    function normalize(server) {
        server = server.trim();
        if (!server) return null;
        if (!server.startsWith('http://') && !server.startsWith('https://')) {
            server = 'http://' + server;
        }
        if (!/:\d+/.test(server.split('://')[1])) {
            server += ':3001';
        }
        return server.replace(/\/+$/, '');
    }

    // ─── Device identity (para "buscar dispositivos en la red") ─
    function deviceMeta() {
        const ua = navigator.userAgent;
        let model = 'iPhone';
        if (/iPad/.test(ua)) model = 'iPad';
        else if (/iPod/.test(ua)) model = 'iPod';
        else if (/Android/i.test(ua)) model = 'Android';
        let os = '';
        const iosM = ua.match(/OS (\d+)(?:_(\d+))?/);
        if (iosM) os = 'iOS ' + iosM[1] + '.' + (iosM[2] || '0');
        else { const am = ua.match(/Android (\d+(?:\.\d+)?)/); if (am) os = 'Android ' + am[1]; }
        return {
            name: model,
            model: os ? (model + ' (' + os + ')') : model,
            platform: /Android/i.test(ua) ? 'android' : 'ios'
        };
    }

    function getDeviceId() {
        let id = null;
        try { id = localStorage.getItem('phonecam-device-id'); } catch (e) { /* noop */ }
        if (!id) {
            id = 'dev-' + Math.random().toString(36).slice(2, 10);
            try { localStorage.setItem('phonecam-device-id', id); } catch (e) { /* noop */ }
        }
        return id;
    }

    function registerDevice() {
        if (!state.socket || !state.roomId) return;
        const m = deviceMeta();
        state.socket.emit('register-device', {
            deviceId: getDeviceId(),
            name: m.name,
            model: m.model,
            platform: m.platform,
            native: /Capacitor|Cordova|ionic/i.test(navigator.userAgent)
        });
    }

    // ─── Last-room auto-reconnect ───────────────────────────
    function savedRoom() {
        try { return (localStorage.getItem(LAST_ROOM_KEY) || '').trim().toUpperCase(); } catch (e) { return null; }
    }

    function connect(explicitRoom) {
        stopQRScanner();

        const room = (explicitRoom || roomInput.value || state.roomId || '').trim().toUpperCase();
        if (!room) {
            showStatus('Ingresa el código de sala', 'error');
            return;
        }

        // Native app: use server from QR or saved, or manual IP input
        let serverUrl = state.serverUrl;
        if (!serverUrl) {
            const manualIp = document.getElementById('server-input')?.value.trim();
            if (manualIp) {
                serverUrl = normalize(manualIp);
            } else {
                serverUrl = localStorage.getItem('phonecam-server') || null;
            }
        }

        if (!serverUrl) {
            showStatus('Primero escanea el QR o ingresa la IP del PC', 'error');
            return;
        }

        localStorage.setItem('phonecam-server', serverUrl);
        state.serverUrl = serverUrl;

        state.roomId = room;
        showStatus('Conectando...', '');
        connectBtn.disabled = true;
        try { localStorage.setItem(LAST_ROOM_KEY, room); } catch (e) { /* noop */ }

        state.socket = io(serverUrl, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: PHONECAM.RECONNECT.MAX_ATTEMPTS,
            reconnectionDelay: PHONECAM.RECONNECT.BASE_DELAY
        });

        state.socket.on('connect', () => {
            console.log('🔌 Socket connected');
            registerDevice();
            state.socket.emit('join-room', { room: state.roomId, role: 'mobile' }, (response) => {
                if (response.error) {
                    showStatus('Sala no encontrada. Verifica el código.', 'error');
                    connectBtn.disabled = false;
                    return;
                }
                showStatus('Conectado, iniciando cámara...', 'success');
                startCamera();
                registerDevice();
            });
        });

        state.socket.on('connect_error', () => {
            showStatus('Error de conexión al servidor', 'error');
            connectBtn.disabled = false;
            // Back to the scanner so the user can retry
            manualContainer.style.display = 'none';
            scannerContainer.style.display = 'flex';
            startQRScanner();
        });

        state.socket.on('disconnect', () => {
            updateConnectionUI('disconnected');
            if (!state.reconnecting) {
                showStatus('Desconectado del servidor', 'error');
            }
        });

        state.socket.on('reconnect_attempt', () => {
            state.reconnecting = true;
            updateConnectionUI('connecting');
        });

        state.socket.on('reconnect', () => {
            state.reconnecting = false;
            state.socket.emit('join-room', { room: state.roomId, role: 'mobile' }, () => {
                if (state.stream) {
                    initWebRTC();
                }
                registerDevice();
            });
        });

        state.socket.on('select-device', (data) => {
            if (!state.stream) startCamera();
        });

        state.socket.on('peer-joined', (data) => {
            if (data.role === 'desktop' || data.role === 'monitor') {
                console.log('🖥️ Peer joined:', data.id);
                state.knownPeers.add(data.id);
                if (state.stream) {
                    addPeer(data.id);
                }
            }
        });

        state.socket.on('peer-left', (data) => {
            if (data.role === 'desktop' || data.role === 'monitor') {
                state.knownPeers.delete(data.id);
                removePeer(data.id);
            }
        });

        setupRemoteControls();
    }

    // ─── Camera ─────────────────────────────────────────────
    async function startCamera() {
        try {
            const res = PHONECAM.RESOLUTIONS[state.currentResolution];
            const constraints = {
                video: {
                    facingMode: state.facingMode,
                    width: { ideal: res.width },
                    height: { ideal: res.height },
                    frameRate: { ideal: state.currentFPS }
                },
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            };

            state.stream = await navigator.mediaDevices.getUserMedia(constraints);
            localVideo.srcObject = state.stream;
            try { await localVideo.play(); } catch (e) { /* noop */ }

            connectScreen.classList.remove('active');
            cameraScreen.classList.add('active');

            hideCamRetry();
            state.camRetryTimer = setTimeout(() => {
                if (localVideo && !localVideo.videoWidth) {
                    showCamRetry('Toca para activar la cámara');
                }
            }, 2200);

            detectCapabilities();

            const videoTrack = state.stream.getVideoTracks()[0];
            state.rawVideoTrack = videoTrack;
            const settings = videoTrack.getSettings();
            resolutionLabel.textContent = `${settings.width}x${settings.height}`;

            setupAudioProcessing();
            initWebRTC();

            if (state.beautyConfig.on) await startBeauty();

        } catch (err) {
            console.error('Camera error:', err);
            showStatus('Error al acceder a la cámara: ' + err.message, 'error');
            connectBtn.disabled = false;
        }
    }

    // ─── Camera Capabilities ────────────────────────────────
    function detectCapabilities() {
        const videoTrack = state.stream.getVideoTracks()[0];
        if (!videoTrack) return;

        const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
        state.capabilities = caps;

        if (caps.zoom) {
            $('#zoom-group').style.display = 'block';
            const slider = $('#zoom-slider');
            slider.min = caps.zoom.min;
            slider.max = caps.zoom.max;
            slider.step = caps.zoom.step || 0.1;
        }

        if (caps.exposureCompensation) {
            $('#exposure-group').style.display = 'block';
            const slider = $('#exposure-slider');
            slider.min = caps.exposureCompensation.min;
            slider.max = caps.exposureCompensation.max;
            slider.step = caps.exposureCompensation.step || 0.1;
        }

        if (state.socket) {
            state.socket.emit('capabilities', {
                zoom: !!caps.zoom,
                torch: !!caps.torch,
                exposure: !!caps.exposureCompensation,
                focusMode: caps.focusMode || [],
                whiteBalanceMode: caps.whiteBalanceMode || [],
                facingMode: caps.facingMode || []
            });
        }
    }

    // ─── WebRTC ─────────────────────────────────────────────
    // Multiple peers supported: one PhoneCamRTC per receiver
    // (desktop panel + OBS browser source can be connected at once)
    function addPeer(peerId) {
        if (state.rtcs[peerId]) return;

        const rtc = new PhoneCamRTC('mobile', state.socket, state.roomId, peerId);
        rtc.createPeerConnection();

        rtc.onConnectionStateChange = (connState) => {
            updateConnectionUI(connState);
        };

        rtc.onStats = (stats) => {
            updateStatsUI(stats);
            if (state.socket) {
                state.socket.emit('stats-update', stats);
            }
        };

        state.rtcs[peerId] = rtc;
        rtc.addStreamAndOffer(state.stream);
    }

    function removePeer(peerId) {
        const rtc = state.rtcs[peerId];
        if (rtc) {
            rtc.close();
            delete state.rtcs[peerId];
        }
        if (Object.keys(state.rtcs).length === 0) {
            updateConnectionUI('disconnected');
        }
    }

    function initWebRTC() {
        if (!state.stream) return;
        // Ensure we have a peer connection for every known peer
        if (state.knownPeers.size > 0) {
            state.knownPeers.forEach(peerId => addPeer(peerId));
        } else if (Object.keys(state.rtcs).length === 0) {
            addPeer(null);
        }
    }

    // ─── Audio Processing ───────────────────────────────────
    function setupAudioProcessing() {
        try {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = state.audioContext.createMediaStreamSource(state.stream);
            state.gainNode = state.audioContext.createGain();
            state.gainNode.gain.value = 1.0;

            const destination = state.audioContext.createMediaStreamDestination();
            source.connect(state.gainNode);
            state.gainNode.connect(destination);

            const processedAudioTrack = destination.stream.getAudioTracks()[0];
            const originalAudioTrack = state.stream.getAudioTracks()[0];
            if (originalAudioTrack && processedAudioTrack) {
                state.stream.removeTrack(originalAudioTrack);
                state.stream.addTrack(processedAudioTrack);
            }
        } catch (e) {
            console.warn('Audio processing not available:', e);
        }
    }

    // ─── Camera Controls ────────────────────────────────────
    async function switchCamera() {
        state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';

        const beautyReset = state.beautyOn;
        if (beautyReset) {
            const rawV = PhoneCamBeauty.stop();
            if (rawV && rawV.readyState !== 'ended') rawV.stop();
            state.beautyOn = false;
        }

        state.stream.getTracks().forEach(track => track.stop());

        const res = PHONECAM.RESOLUTIONS[state.currentResolution];
        try {
            state.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: state.facingMode,
                    width: { ideal: res.width },
                    height: { ideal: res.height },
                    frameRate: { ideal: state.currentFPS }
                },
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });

            localVideo.srcObject = state.stream;
            detectCapabilities();
            setupAudioProcessing();

            for (const rtc of Object.values(state.rtcs)) {
                if (rtc && rtc.peerConnection) {
                    const videoTrack = state.stream.getVideoTracks()[0];
                    const audioTrack = state.stream.getAudioTracks()[0];
                    await rtc.replaceVideoTrack(videoTrack);
                    if (audioTrack) await rtc.replaceAudioTrack(audioTrack);
                }
            }

            state.rawVideoTrack = state.stream.getVideoTracks()[0];
            const settings = state.stream.getVideoTracks()[0].getSettings();
            resolutionLabel.textContent = `${settings.width}x${settings.height}`;

            state.flashOn = false;
            updateFlashUI();
            applyVideoFilters();

            if (beautyReset) await startBeauty();
        } catch (err) {
            console.error('Switch camera error:', err);
        }
    }

    // ─── On-device Beauty (iPhone) ──────────────────────────
    async function startBeauty() {
        if (state.beautyOn || !state.stream) return;
        const rawStream = state.stream;
        const rawV = rawStream.getVideoTracks()[0];
        if (!rawV) return;
        const cfg = state.beautyConfig;
        const track = await PhoneCamBeauty.start({
            rawStream: rawStream,
            fps: Math.min(30, state.currentFPS),
            vendorBase: 'vendor/mediapipe/',
            smooth: cfg.smooth,
            glow: cfg.glow,
            sharp: cfg.sharp,
            faceMode: cfg.faceMode
        });
        if (!track) return;
        const audioTracks = rawStream.getAudioTracks();
        state.rawVideoTrack = rawV;
        rawStream.removeTrack(rawV);
        state.stream = new MediaStream([track, ...audioTracks]);
        state.beautyOn = true;
        localVideo.srcObject = state.stream;
        for (const rtc of Object.values(state.rtcs)) {
            if (rtc && rtc.peerConnection) await rtc.replaceVideoTrack(track);
        }
    }

    function stopBeauty() {
        if (!state.beautyOn) return;
        const processedStream = state.stream;
        const audioTracks = processedStream ? processedStream.getAudioTracks() : [];
        const rawV = PhoneCamBeauty.stop();
        state.rawVideoTrack = rawV || state.rawVideoTrack;
        state.beautyOn = false;
        state.stream = new MediaStream([...(rawV ? [rawV] : []), ...audioTracks]);
        localVideo.srcObject = state.stream;
        for (const rtc of Object.values(state.rtcs)) {
            if (rtc && rtc.peerConnection && rawV) rtc.replaceVideoTrack(rawV);
        }
    }

    function applyBeautyConfig(cfg) {
        state.beautyConfig = Object.assign({}, state.beautyConfig, cfg);
        if (cfg.on && !state.beautyOn) {
            startBeauty();
        } else if (!cfg.on && state.beautyOn) {
            stopBeauty();
        } else if (state.beautyOn) {
            PhoneCamBeauty.configure(state.beautyConfig);
        }
    }

    function syncBeautyUI() {
        const cfg = state.beautyConfig;
        beautyToggle.classList.toggle('active', !!cfg.on);
        beautyToggle.textContent = cfg.on ? 'Activado' : 'Desactivado';
        if (quickBeautyBtn) quickBeautyBtn.classList.toggle('active', !!cfg.on);
        beautySliders.style.display = cfg.on ? 'block' : 'none';
        beautySmooth.value = cfg.smooth;
        beautyGlow.value = cfg.glow;
        beautySharp.value = cfg.sharp;
        $('#beauty-smooth-value').textContent = cfg.smooth + '%';
        $('#beauty-glow-value').textContent = cfg.glow + '%';
        $('#beauty-sharp-value').textContent = cfg.sharp + '%';
        beautySmooth.disabled = !cfg.on;
        beautyGlow.disabled = !cfg.on;
        beautySharp.disabled = !cfg.on;
    }

    function emitBeautyToPC() {
        if (!state.socket) return;
        const cfg = state.beautyConfig;
        state.socket.emit('beauty-config', { on: cfg.on, smooth: cfg.smooth, glow: cfg.glow, sharp: cfg.sharp });
    }

    function toggleFlash() {
        const track = state.rawVideoTrack || state.stream?.getVideoTracks()[0];
        if (!track) return;

        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (!caps.torch) {
            console.warn('Flash not supported on this lens');
            return;
        }

        state.flashOn = !state.flashOn;
        track.applyConstraints({
            advanced: [{ torch: state.flashOn }]
        }).catch(e => console.warn('Flash error:', e));

        updateFlashUI();

        if (state.socket) {
            state.socket.emit('camera-status', { flash: state.flashOn });
        }
    }

    function updateFlashUI() {
        const btn = $('#btn-flash');
        const icon = $('#flash-icon');
        if (state.flashOn) {
            btn.classList.add('flash-on');
            icon.textContent = '💡';
        } else {
            btn.classList.remove('flash-on');
            icon.textContent = '⚡';
        }
    }

    function toggleMic() {
        state.micOn = !state.micOn;
        const audioTracks = state.stream?.getAudioTracks();
        if (audioTracks) {
            audioTracks.forEach(track => track.enabled = state.micOn);
        }

        const btn = $('#btn-mic');
        const icon = $('#mic-icon');
        if (state.micOn) {
            btn.classList.add('active');
            icon.textContent = '🎤';
        } else {
            btn.classList.remove('active');
            icon.textContent = '🔇';
        }
    }

    function toggleStats() {
        state.statsVisible = !state.statsVisible;
        statsOverlay.classList.toggle('hidden', !state.statsVisible);
        $('#btn-stats').classList.toggle('active', state.statsVisible);
    }

    function toggleSettings(force) {
        const show = typeof force === 'boolean' ? force : !state.settingsVisible;
        state.settingsVisible = show;
        settingsPanel.classList.toggle('hidden', !show);
        $('#settings-scrim').classList.toggle('hidden', !show);
        $('#btn-settings').classList.toggle('active', show);
    }

    async function changeResolution(preset) {
        state.currentResolution = preset;
        const res = PHONECAM.RESOLUTIONS[preset];

        const track = state.rawVideoTrack || state.stream?.getVideoTracks()[0];
        if (!track) return;

        try {
            await track.applyConstraints({
                width: { ideal: res.width },
                height: { ideal: res.height }
            });

            const settings = track.getSettings();
            resolutionLabel.textContent = `${settings.width}x${settings.height}`;
        } catch (e) {
            console.warn('Resolution change error:', e);
        }

        if (state.socket) {
            state.socket.emit('camera-status', { resolution: preset });
        }
    }

    async function changeFPS(fps) {
        state.currentFPS = fps;

        const track = state.rawVideoTrack || state.stream?.getVideoTracks()[0];
        if (!track) return;

        try {
            await track.applyConstraints({
                frameRate: { ideal: fps }
            });
        } catch (e) {
            console.warn('FPS change error:', e);
        }

        if (state.socket) {
            state.socket.emit('camera-status', { fps });
        }
    }

    function applyFilter(filterName) {
        state.currentFilter = filterName;
        const filterDef = PHONECAM.FILTERS[filterName];
        if (filterDef) {
            localVideo.style.filter = filterDef.css === 'none' ? '' : filterDef.css;
        }
        applyVideoFilters();

        if (state.socket) {
            state.socket.emit('filter-change', { filter: filterName });
        }
    }

    function applyVideoFilters() {
        const filterDef = PHONECAM.FILTERS[state.currentFilter] || PHONECAM.FILTERS.none;
        let cssFilter = filterDef.css === 'none' ? '' : filterDef.css;

        const adjustments = [];
        if (state.brightness !== 100) adjustments.push(`brightness(${state.brightness / 100})`);
        if (state.contrast !== 100) adjustments.push(`contrast(${state.contrast / 100})`);
        if (state.saturation !== 100) adjustments.push(`saturate(${state.saturation / 100})`);

        localVideo.style.filter = [cssFilter, ...adjustments].filter(Boolean).join(' ') || 'none';
    }

    function applyOrientation(mode) {
        state.orientation = mode;
        document.querySelectorAll('#orientation-group .toggle-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.value === mode);
        });

        let rotation = 0;
        if (mode === 'portrait') rotation = 90;
        else if (mode === 'landscape') rotation = 0;

        const orientationClass = mode === 'portrait' ? 'orient-portrait' : 'orient-landscape';
        localVideo.classList.remove('orient-portrait', 'orient-landscape');
        if (mode !== 'auto') {
            localVideo.classList.add(orientationClass);
        }

        if (state.socket) {
            state.socket.emit('camera-status', { orientation: mode });
        }
    }

    function toggleBlackout() {
        state.blackout = !state.blackout;
        const overlay = $('#blackout-overlay');
        const btn = $('#btn-blackout');
        if (state.blackout) {
            overlay.style.display = 'flex';
            btn.classList.add('active');
            btn.textContent = '☀️ Reactivar pantalla';
            if (navigator.wakeLock) {
                navigator.wakeLock.request('screen').catch(() => {});
            }
        } else {
            overlay.style.display = 'none';
            btn.classList.remove('active');
            btn.textContent = '🌙 Pantalla negra (sigue transmitiendo)';
        }
        if (state.socket) {
            state.socket.emit('camera-status', { blackout: state.blackout });
        }
    }

    async function applyZoom() {
        const track = state.rawVideoTrack || state.stream?.getVideoTracks()[0];
        if (!track) return;

        try {
            await track.applyConstraints({
                advanced: [{ zoom: state.zoom }]
            });
        } catch (e) {
            console.warn('Zoom error:', e);
        }
    }

    async function applyExposure(value) {
        const track = state.rawVideoTrack || state.stream?.getVideoTracks()[0];
        if (!track) return;

        try {
            await track.applyConstraints({
                advanced: [{ exposureCompensation: value }]
            });
        } catch (e) {
            console.warn('Exposure error:', e);
        }
    }

    function applyMicGain(value) {
        if (state.gainNode) {
            state.gainNode.gain.value = value;
        }
    }

    // ─── Remote Controls (from Desktop) ─────────────────────
    function setupRemoteControls() {
        state.socket.on('camera-switch', () => switchCamera());
        state.socket.on('flash-toggle', () => toggleFlash());
        state.socket.on('mic-toggle', () => toggleMic());

        state.socket.on('zoom-change', (data) => {
            state.zoom = data.value;
            $('#zoom-slider').value = data.value;
            $('#zoom-value').textContent = data.value.toFixed(1) + 'x';
            applyZoom();
        });

        state.socket.on('resolution-change', (data) => {
            document.querySelectorAll('#resolution-group .toggle-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.value === data.value);
            });
            changeResolution(data.value);
        });

        state.socket.on('fps-change', (data) => {
            document.querySelectorAll('#fps-group .toggle-btn').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.value) === data.value);
            });
            changeFPS(data.value);
        });

        state.socket.on('filter-change', (data) => {
            document.querySelectorAll('#filter-group .filter-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.value === data.filter);
            });
            applyFilter(data.filter);
        });

        state.socket.on('brightness-change', (data) => {
            state.brightness = data.value;
            $('#brightness-slider').value = data.value;
            $('#brightness-value').textContent = data.value + '%';
            applyVideoFilters();
        });

        state.socket.on('contrast-change', (data) => {
            state.contrast = data.value;
            $('#contrast-slider').value = data.value;
            $('#contrast-value').textContent = data.value + '%';
            applyVideoFilters();
        });

        state.socket.on('saturation-change', (data) => {
            state.saturation = data.value;
            $('#saturation-slider').value = data.value;
            $('#saturation-value').textContent = data.value + '%';
            applyVideoFilters();
        });

        state.socket.on('mic-gain', (data) => {
            applyMicGain(data.value);
            $('#gain-slider').value = data.value * 100;
            $('#gain-value').textContent = Math.round(data.value * 100) + '%';
        });

        state.socket.on('orientation-change', (data) => {
            applyOrientation(data.value);
        });

        state.socket.on('beauty-config', (data) => {
            applyBeautyConfig(data);
            syncBeautyUI();
        });
    }

    // ─── Battery Monitor ────────────────────────────────────
    async function monitorBattery() {
        try {
            if ('getBattery' in navigator) {
                const battery = await navigator.getBattery();
                const update = () => {
                    const level = Math.round(battery.level * 100);
                    const charging = battery.charging;
                    batteryLevel.textContent = level + '%';
                    $('#battery-icon').textContent = charging ? '🔌' : (level > 20 ? '🔋' : '🪫');

                    if (state.socket) {
                        state.socket.emit('battery-status', { level, charging });
                    }
                };
                battery.addEventListener('levelchange', update);
                battery.addEventListener('chargingchange', update);
                update();
            }
        } catch (e) {
            batteryLevel.textContent = 'N/A';
        }
    }

    // ─── UI Updates ─────────────────────────────────────────
    function updateConnectionUI(connState) {
        document.body.classList.remove('ui-hidden');
        connectionIndicator.className = 'indicator';
        switch (connState) {
            case 'connected':
                connectionIndicator.classList.add('connected');
                connectionLabel.textContent = 'Conectado';
                break;
            case 'connecting':
            case 'new':
                connectionIndicator.classList.add('connecting');
                connectionLabel.textContent = 'Conectando...';
                break;
            default:
                connectionIndicator.classList.add('disconnected');
                connectionLabel.textContent = 'Desconectado';
        }
    }

    function updateStatsUI(stats) {
        if (!state.statsVisible) return;
        $('#stat-resolution').textContent = stats.video.width ?
            `${stats.video.width}×${stats.video.height}` : '--';
        $('#stat-fps').textContent = stats.video.fps ? Math.round(stats.video.fps) : '--';
        $('#stat-bitrate').textContent = stats.video.bitrate ?
            `${stats.video.bitrate} kbps` : '--';
        $('#stat-latency').textContent = stats.connection.rtt ?
            `${stats.connection.rtt} ms` : '--';
    }

    function showStatus(msg, type) {
        connectStatus.textContent = msg;
        connectStatus.className = 'status-msg ' + (type || '');
        // Also show on the scanner screen so the user gets feedback
        const scannerStatus = document.getElementById('scanner-status');
        if (scannerStatus) {
            scannerStatus.textContent = msg;
            scannerStatus.className = 'status-msg ' + (type || '');
        }
    }

    function disconnect() {
        Object.values(state.rtcs).forEach(rtc => rtc.close());
        if (state.socket) state.socket.disconnect();
        if (state.beautyOn) { try { PhoneCamBeauty.stop(); } catch (e) { /* noop */ } state.beautyOn = false; }
        if (state.rawVideoTrack) { try { state.rawVideoTrack.stop(); } catch (e) { /* noop */ } state.rawVideoTrack = null; }
        if (state.stream) state.stream.getTracks().forEach(t => t.stop());
        if (state.audioContext) state.audioContext.close();

        state.stream = null;
        state.rtcs = {};
        state.knownPeers.clear();
        state.socket = null;
        try { localStorage.removeItem(LAST_ROOM_KEY); } catch (e) { /* noop */ }

        cameraScreen.classList.remove('active');
        connectScreen.classList.add('active');
        connectBtn.disabled = false;
        showStatus('Desconectado', '');

        // Re-enable scanner
        manualContainer.style.display = 'none';
        scannerContainer.style.display = 'flex';
        startQRScanner();
    }

    // ─── Keep Awake & Lifecycle ─────────────────────────────
    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                await navigator.wakeLock.request('screen');
                console.log('🔒 Wake lock active');
            }
        } catch (e) {}
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            requestWakeLock();
            if (state.stream) {
                const videoTrack = state.stream.getVideoTracks()[0];
                if (videoTrack && videoTrack.readyState === 'ended') {
                    startCamera();
                }
            }
        }
    });

    document.addEventListener('DOMContentLoaded', () => {
        init();
        requestWakeLock();
    });

})();
