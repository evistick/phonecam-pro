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
        flashOn: false
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
    const obsUrl = $('#obs-url');
    const connectionBadge = $('#connection-badge');
    const connectionText = $('#connection-text');
    const recordingIndicator = $('#recording-indicator');
    const recTimer = $('#rec-timer');

    // ─── Initialize ─────────────────────────────────────────
    function init() {
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
                showToast('📱 Teléfono conectado, iniciando stream...', 'success');
            }
        });

        state.socket.on('peer-left', (data) => {
            if (data.role === 'mobile') {
                console.log('📱 Mobile peer left');
                updateConnectionBadge('disconnected');
                showVideoPanel(false);
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
                remoteVideo.style.filter = filterDef.css === 'none' ? '' : filterDef.css;
                $('#d-filter-select').value = data.filter;
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

        // Load OBS URL
        updateOBSUrl();
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

                updateOBSUrl();
            } catch (err) {
                console.error('QR code error:', err);
                qrLoading.querySelector('span').textContent = 'Error al generar QR';
            }

            // Setup WebRTC for this room
            setupWebRTC();
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

    // ─── OBS Virtual Camera (automatic) ────────────────────
    // Uses the OBS WebSocket API (v5, port 4455) to create a Browser Source
    // with the clean video URL and start the Virtual Camera, which appears
    // as a video input device ("OBS Virtual Camera") in Teams, Zoom, etc.
    const OBS_WS_URL = 'ws://127.0.0.1:4455';
    const OBS_INPUT_NAME = 'PhoneCam Pro Webcam';
    let obsSocket = null;
    let obsRequestId = 0;
    let obsPending = new Map();
    let obsIdentified = false;

    function obsStatus(msg, type) {
        const el = $('#obs-status');
        if (el) {
            el.textContent = msg;
            el.className = 'obs-status ' + (type || '');
        }
    }

    function obsRequest(requestType, requestData) {
        return new Promise((resolve, reject) => {
            if (!obsSocket || obsSocket.readyState !== WebSocket.OPEN) {
                reject(new Error('OBS WebSocket no conectado'));
                return;
            }
            const id = String(++obsRequestId);
            obsPending.set(id, { resolve, reject });
            obsSocket.send(JSON.stringify({
                op: 6, // Request
                d: {
                    requestType,
                    requestId: id,
                    requestData: requestData || {}
                }
            }));
        });
    }

    function connectOBS() {
        return new Promise((resolve, reject) => {
            obsSocket = new WebSocket(OBS_WS_URL);

            obsSocket.onopen = () => {
                obsSocket.send(JSON.stringify({
                    op: 1, // Identify
                    d: { rpcVersion: 1 }
                }));
            };

            obsSocket.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.op === 2) { // Hello
                    // Wait for identify; server replies with Identified (op 2 response?)
                }
                if (msg.op === 7) { // RequestResponse
                    const d = msg.d;
                    const pending = obsPending.get(d.requestId);
                    if (pending) {
                        obsPending.delete(d.requestId);
                        if (d.requestStatus && d.requestStatus.result === false) {
                            pending.reject(new Error(d.requestStatus.comment || d.requestType + ' falló'));
                        } else {
                            pending.resolve(d.responseData || {});
                        }
                    }
                }
                if (msg.op === 2 && msg.d && msg.d.negotiatedRpcVersion !== undefined) {
                    obsIdentified = true;
                    resolve();
                }
            };

            obsSocket.onerror = () => {
                reject(new Error('No se pudo conectar a OBS (ws://127.0.0.1:4455)'));
            };

            obsSocket.onclose = () => {
                obsIdentified = false;
                obsPending.forEach(p => p.reject(new Error('OBS desconectado')));
                obsPending.clear();
            };
        });
    }

    async function startOBSVirtualCamera() {
        const btn = $('#btn-obs-virtual');
        btn.disabled = true;

        try {
            obsStatus('Conectando con OBS en el puerto 4455...', 'working');
            await connectOBS();
            obsStatus('Conectado. Creando fuente de video...', 'working');

            const urlText = obsUrl.textContent;
            if (!urlText || urlText === '--') {
                throw new Error('Primero crea la sala (código QR)');
            }

            // Find the current scene name (don't assume "Escena")
            const sceneInfo = await obsRequest('GetCurrentProgramScene', {});
            const sceneName = (sceneInfo && sceneInfo.currentProgramSceneName) || 'Escena';

            // Try to create the Browser Source (fails if it already exists)
            try {
                await obsRequest('CreateInput', {
                    sceneName,
                    inputName: OBS_INPUT_NAME,
                    inputKind: 'browser_source',
                    inputSettings: {
                        url: urlText,
                        width: 1920,
                        height: 1080,
                        fps: 60,
                        shutdown: false,
                        reroute_audio: false,
                        controls: false
                    }
                });
            } catch (e) {
                // Input may already exist — update its settings instead
                await obsRequest('SetInputSettings', {
                    inputName: OBS_INPUT_NAME,
                    inputSettings: {
                        url: urlText,
                        width: 1920,
                        height: 1080,
                        fps: 60,
                        shutdown: false,
                        reroute_audio: false,
                        controls: false
                    }
                });
            }

            // Start the virtual camera output
            try {
                await obsRequest('StartVirtualCam');
            } catch (e) {
                // Might already be running — check status
                const status = await obsRequest('GetVirtualCamStatus');
                if (!status.outputActive) {
                    throw e;
                }
            }

            obsStatus('✅ Cámara virtual ACTIVA. Selecciona "OBS Virtual Camera" en Teams/Zoom/Meet.', 'success');
            showToast('🎥 Cámara virtual iniciada en OBS', 'success');
        } catch (err) {
            console.error('OBS error:', err);
            obsStatus(
                '❌ ' + err.message + ' — ¿Está OBS abierto y con WebSocket activado? ' +
                '(OBS → Tools → WebSocket Server Settings → "Enable WebSocket Server", puerto 4455)',
                'error'
            );
        } finally {
            btn.disabled = false;
        }
    }

    // ─── UI Controls ────────────────────────────────────────
    function setupUIControls() {
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

        $('#btn-copy-obs').addEventListener('click', () => {
            copyToClipboard(obsUrl.textContent);
            showToast('📋 URL OBS copiada', 'success');
        });

        // OBS Virtual Camera (automatic)
        $('#btn-obs-virtual').addEventListener('click', startOBSVirtualCamera);

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
                remoteVideo.style.filter = filterDef.css === 'none' ? '' : filterDef.css;
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
        if (axis === 'h') {
            state.mirrorH = !state.mirrorH;
            remoteVideo.classList.toggle('mirror-h', state.mirrorH);
            $('#btn-mirror-h').classList.toggle('active', state.mirrorH);
        } else {
            state.mirrorV = !state.mirrorV;
            remoteVideo.classList.toggle('mirror-v', state.mirrorV);
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

    function updateOBSUrl() {
        const protocol = window.location.protocol;
        const host = window.location.hostname;
        const port = window.location.port;
        const room = state.roomId || '------';
        const url = `${protocol}//${host}${port ? ':' + port : ''}/obs/?room=${room}`;
        obsUrl.textContent = url;
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
    document.addEventListener('DOMContentLoaded', init);

})();
