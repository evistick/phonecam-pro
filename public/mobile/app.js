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
        roomId: null,
        serverUrl: null,
        stream: null,
        scannerStream: null,
        isScanning: false,
        scanAnimationId: null,
        knownPeers: new Set(),
        audioContext: null,
        gainNode: null,
        facingMode: 'environment', // 'user' or 'environment'
        flashOn: false,
        micOn: true,
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
        beautyConfig: { on: false, smooth: 70, glow: 50, faceMode: true }
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

    // ─── Initialize ─────────────────────────────────────────
    function init() {
        const params = new URLSearchParams(window.location.search);
        const roomFromUrl = params.get('room');

        if (roomFromUrl) {
            roomInput.value = roomFromUrl;
            state.roomId = roomFromUrl.toUpperCase();
            connect();
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
    async function startQRScanner() {
        if (state.isScanning) return;
        state.isScanning = true;

        try {
            state.scannerStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });

            scannerVideo.srcObject = state.scannerStream;
            scannerVideo.setAttribute('playsinline', 'true');
            await scannerVideo.play();

            scanQRCodeFrame();
        } catch (err) {
            console.warn('Scanner camera error:', err);
            // Fallback to manual code entry
            scannerContainer.style.display = 'none';
            manualContainer.style.display = 'block';
            showStatus('Acceso a cámara requerido para escanear QR', 'error');
        }
    }

    function stopQRScanner() {
        state.isScanning = false;
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
                targetHost = url.origin;
            }
        } catch (e) {}

        state.roomId = targetRoom.toUpperCase();
        roomInput.value = state.roomId;

        if (targetHost && targetHost !== window.location.origin) {
            // Redirect to the server from the QR code
            window.location.href = `${targetHost}/mobile/?room=${state.roomId}`;
            return;
        }

        connect();
    }

    // ─── Connection ─────────────────────────────────────────
    function connect(explicitRoom) {
        stopQRScanner();

        const room = (explicitRoom || roomInput.value || state.roomId || '').trim().toUpperCase();
        if (!room) {
            showStatus('Ingresa el código de sala', 'error');
            return;
        }

        state.roomId = room;
        showStatus('Conectando...', '');
        connectBtn.disabled = true;

        state.socket = io({
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: PHONECAM.RECONNECT.MAX_ATTEMPTS,
            reconnectionDelay: PHONECAM.RECONNECT.BASE_DELAY
        });

        state.socket.on('connect', () => {
            console.log('🔌 Socket connected');
            state.socket.emit('join-room', { room: state.roomId, role: 'mobile' }, (response) => {
                if (response.error) {
                    showStatus('Sala no encontrada. Verifica el código.', 'error');
                    connectBtn.disabled = false;
                    return;
                }
                showStatus('Conectado, iniciando cámara...', 'success');
                startCamera();
            });
        });

        state.socket.on('connect_error', () => {
            showStatus('Error de conexión al servidor', 'error');
            connectBtn.disabled = false;
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
            });
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

            connectScreen.classList.remove('active');
            cameraScreen.classList.add('active');

            detectCapabilities();

            const videoTrack = state.stream.getVideoTracks()[0];
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

    function toggleFlash() {
        const track = state.stream?.getVideoTracks()[0];
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

        const track = state.stream?.getVideoTracks()[0];
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

        const track = state.stream?.getVideoTracks()[0];
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
        const track = state.stream?.getVideoTracks()[0];
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
        const track = state.stream?.getVideoTracks()[0];
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
            vendorBase: '/shared/vendor/mediapipe/',
            smooth: cfg.smooth,
            glow: cfg.glow,
            faceMode: cfg.faceMode
        });
        if (!track) return;
        const audioTracks = rawStream.getAudioTracks();
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
        beautySliders.style.display = cfg.on ? 'block' : 'none';
        beautySmooth.value = cfg.smooth;
        beautyGlow.value = cfg.glow;
        $('#beauty-smooth-value').textContent = cfg.smooth + '%';
        $('#beauty-glow-value').textContent = cfg.glow + '%';
        beautySmooth.disabled = !cfg.on;
        beautyGlow.disabled = !cfg.on;
    }

    function emitBeautyToPC() {
        if (!state.socket) return;
        const cfg = state.beautyConfig;
        state.socket.emit('beauty-config', { on: cfg.on, smooth: cfg.smooth, glow: cfg.glow });
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
    }

    function disconnect() {
        Object.values(state.rtcs).forEach(rtc => rtc.close());
        if (state.socket) state.socket.disconnect();
        if (state.stream) state.stream.getTracks().forEach(t => t.stop());
        if (state.audioContext) state.audioContext.close();

        state.stream = null;
        state.rtcs = {};
        state.socket = null;

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
