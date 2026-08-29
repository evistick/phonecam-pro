/**
 * main.js — PhoneCam Pro Electron Desktop Application
 * Embeds the Node.js server and provides a native Windows desktop experience
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const { startServer, PORT, getProtocol, LOCAL_IP } = require('./server');

// Prevent Windows GPU process crashes on various hardware configurations
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

// Ignore self-signed HTTPS certificate warnings in the desktop app
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

let mainWindow = null;
let isAlwaysOnTop = false;

const iconPath = path.join(__dirname, 'assets', 'icon.png');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 850,
        minWidth: 960,
        minHeight: 620,
        frame: false,
        backgroundColor: '#08081a',
        title: 'PhoneCam Pro',
        icon: iconPath,
        autoHideMenuBar: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            allowRunningInsecureContent: true
        }
    });

    mainWindow.maximize();

    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('win-maximized-changed', true);
    });
    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('win-maximized-changed', false);
    });
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('win-maximized-changed', mainWindow.isMaximized());
    });

    const protocol = getProtocol();
    const appUrl = `${protocol}://localhost:${PORT}/desktop/`;

    mainWindow.loadURL(appUrl);

    // Auto grant media permissions
    mainWindow.webContents.session.setPermissionCheckHandler(() => true);
    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => callback(true));

    // Build Desktop Application Menu
    const menuTemplate = [
        {
            label: 'PhoneCam Pro',
            submenu: [
                {
                    label: '📱 Abrir versión Móvil en navegador',
                    click: () => {
                        shell.openExternal(`${protocol}://${LOCAL_IP}:${PORT}/mobile/`);
                    }
                },
                {
                    label: '🎬 Abrir fuente OBS en navegador',
                    click: () => {
                        shell.openExternal(`${protocol}://localhost:${PORT}/obs/`);
                    }
                },
                { type: 'separator' },
                {
                    label: '📌 Fijar ventana siempre visible (Always on Top)',
                    type: 'checkbox',
                    checked: isAlwaysOnTop,
                    click: (item) => {
                        isAlwaysOnTop = item.checked;
                        mainWindow.setAlwaysOnTop(isAlwaysOnTop);
                    }
                },
                { type: 'separator' },
                {
                    label: '❌ Salir',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => {
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'Ver',
            submenu: [
                { role: 'reload', label: '🔄 Recargar' },
                { role: 'forceReload', label: '⚡ Recargar forzado' },
                { role: 'toggleDevTools', label: '🛠️ Herramientas de desarrollador' },
                { type: 'separator' },
                { role: 'resetZoom', label: '🔍 Tamaño normal' },
                { role: 'zoomIn', label: '🔍+ Aumentar zoom' },
                { role: 'zoomOut', label: '🔍- Reducir zoom' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '⛶ Pantalla completa' }
            ]
        },
        {
            label: 'Ayuda',
            submenu: [
                {
                    label: '📖 Ver Guía y Atajos',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'PhoneCam Pro — Atajos y Ayuda',
                            message: 'Atajos de teclado en el visor:\n\n' +
                                '• F: Pantalla Completa\n' +
                                '• P: Picture-in-Picture\n' +
                                '• S: Captura de Pantalla instantánea (PNG)\n' +
                                '• R: Iniciar / Detener Grabación de Video\n' +
                                '• G: Mostrar / Ocultar Guías de Composición\n' +
                                '• M: Modo Espejo Horizontal\n\n' +
                                'Integración con OBS Studio:\n' +
                                '1. Añade una fuente tipo "Navegador" en OBS.\n' +
                                '2. Pega la URL generada en el panel de PhoneCam Pro.\n' +
                                '3. Haz clic en "Iniciar cámara virtual" en OBS.',
                            buttons: ['Entendido']
                        });
                    }
                },
                {
                    label: '🌐 Información de Red',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'Información de Red',
                            message: `IP Local: ${LOCAL_IP}\nPuerto: ${PORT}\nProtocolo: ${protocol.toUpperCase()}\n\nURL Móvil: ${protocol}://${LOCAL_IP}:${PORT}/mobile/`,
                            buttons: ['Cerrar']
                        });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Ignore certificate errors globally in Electron session
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true);
});

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    // App Lifecycle
    app.whenReady().then(() => {
        startServer(() => {
            createWindow();
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
}

// ─── Window controls (embedded Windows caption buttons) ──────
ipcMain.on('win-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.on('win-maximize-toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('win-close', () => {
    if (mainWindow) mainWindow.close();
});
