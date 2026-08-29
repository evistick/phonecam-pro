const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winControls', {
    minimize: () => ipcRenderer.send('win-minimize'),
    toggleMaximize: () => ipcRenderer.send('win-maximize-toggle'),
    close: () => ipcRenderer.send('win-close'),
    onMaximized: (cb) => {
        ipcRenderer.on('win-maximized-changed', (_event, maximized) => cb(maximized));
    }
});