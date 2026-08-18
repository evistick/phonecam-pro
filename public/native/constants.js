/**
 * constants.js — Shared configuration for PhoneCam Pro
 */

const PHONECAM = {
    // App info
    APP_NAME: 'PhoneCam Pro',
    VERSION: '1.0.0',

    // WebRTC ICE Servers
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ],

    // Resolution presets
    RESOLUTIONS: {
        '480p':  { width: 854,  height: 480,  label: '480p SD' },
        '720p':  { width: 1280, height: 720,  label: '720p HD' },
        '1080p': { width: 1920, height: 1080, label: '1080p Full HD' },
        '4k':    { width: 3840, height: 2160, label: '4K Ultra HD' }
    },

    // FPS presets
    FPS_OPTIONS: [15, 30, 60],

    // Video filters
    FILTERS: {
        none:       { label: 'Normal',        css: 'none' },
        grayscale:  { label: 'B&N',           css: 'grayscale(100%)' },
        sepia:      { label: 'Sepia',         css: 'sepia(100%)' },
        vintage:    { label: 'Vintage',       css: 'sepia(50%) contrast(1.2) brightness(0.9)' },
        contrast:   { label: 'Alto Contraste',css: 'contrast(1.8) brightness(1.1)' },
        invert:     { label: 'Negativo',      css: 'invert(100%)' },
        warm:       { label: 'Cálido',        css: 'sepia(30%) saturate(1.4) brightness(1.05)' },
        cool:       { label: 'Frío',          css: 'saturate(0.8) hue-rotate(180deg) brightness(1.05)' },
        blur:       { label: 'Desenfoque',    css: 'blur(2px)' },
        saturate:   { label: 'Saturado',      css: 'saturate(2.5)' }
    },

    // Bitrate presets (kbps)
    BITRATE: {
        low:    500,
        medium: 1500,
        high:   4000,
        ultra:  8000
    },

    // Socket events
    EVENTS: {
        // Connection
        JOIN_ROOM:       'join-room',
        ROOM_JOINED:     'room-joined',
        PEER_JOINED:     'peer-joined',
        PEER_LEFT:       'peer-left',

        // WebRTC signaling
        OFFER:           'offer',
        ANSWER:          'answer',
        ICE_CANDIDATE:   'ice-candidate',

        // Camera controls (desktop -> mobile)
        CAMERA_SWITCH:   'camera-switch',
        FLASH_TOGGLE:    'flash-toggle',
        ZOOM_CHANGE:     'zoom-change',
        EXPOSURE_CHANGE: 'exposure-change',
        FOCUS_CHANGE:    'focus-change',
        WB_CHANGE:       'wb-change',
        RESOLUTION_CHANGE: 'resolution-change',
        FPS_CHANGE:      'fps-change',
        FILTER_CHANGE:   'filter-change',
        BRIGHTNESS_CHANGE: 'brightness-change',
        CONTRAST_CHANGE: 'contrast-change',
        SATURATION_CHANGE: 'saturation-change',
        MIC_TOGGLE:      'mic-toggle',
        MIC_GAIN:        'mic-gain',
        ORIENTATION_CHANGE: 'orientation-change',

        // Status updates (mobile -> desktop)
        CAMERA_STATUS:   'camera-status',
        STATS_UPDATE:    'stats-update',
        BATTERY_STATUS:  'battery-status',
        CAPABILITIES:    'capabilities'
    },

    // Reconnection
    RECONNECT: {
        MAX_ATTEMPTS: 10,
        BASE_DELAY: 1000,
        MAX_DELAY: 30000
    }
};

// Export for both browser and Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PHONECAM;
}
