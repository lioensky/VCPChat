'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscriptions = new Map();

contextBridge.exposeInMainWorld('bladeGame', Object.freeze({
    submitMove: moveKey => ipcRenderer.invoke('blade-game:submit-move', moveKey),

    findAvatar: maidName => ipcRenderer.invoke('blade-game:find-avatar', maidName),

    minimize: () => ipcRenderer.send('blade-game:window:minimize'),

    toggleMaximize: () => ipcRenderer.send('blade-game:window:toggle-maximize'),

    close: () => ipcRenderer.send('blade-game:window:close'),

    onMaximizedChanged: callback => {
        if (typeof callback !== 'function') return () => {};

        const listener = (_event, maximized) => callback(Boolean(maximized));
        ipcRenderer.on('blade-game:window:maximized-changed', listener);
        subscriptions.set(callback, listener);

        return () => {
            ipcRenderer.removeListener('blade-game:window:maximized-changed', listener);
            subscriptions.delete(callback);
        };
    },
}));

window.addEventListener('beforeunload', () => {
    for (const listener of subscriptions.values()) {
        ipcRenderer.removeListener('blade-game:window:maximized-changed', listener);
    }
    subscriptions.clear();
}, { once: true });