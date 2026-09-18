'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

const chartAPI = Object.freeze({
    listCharts: () => ipcRenderer.invoke('chart:list'),
    getChartSnapshot: chartId => ipcRenderer.invoke('chart:get-snapshot', chartId),
    getInitialChartId: () => ipcRenderer.invoke('chart:get-initial-selection'),
    getFloatingCharts: () => ipcRenderer.invoke('chart:floating-state'),
    detachChart: chartId => ipcRenderer.invoke('chart:detach', chartId),
    dockChart: chartId => ipcRenderer.invoke('chart:dock', chartId),
    focusFloatingChart: chartId => ipcRenderer.invoke('chart:focus-floating', chartId),
    togglePin: () => ipcRenderer.invoke('chart:toggle-pin'),
    onFloatingChanged: callback => subscribe('chart:floating-changed', callback),
    readDataSource: request => ipcRenderer.invoke('chart:read-data-source', request),
    deleteChart: request => ipcRenderer.invoke('chart:delete', request),
    openChartInCanvas: request => ipcRenderer.invoke('chart:open-in-canvas', request),
    getCurrentTheme: () => ipcRenderer.invoke('get-current-theme'),

    reportRuntimeStatus: payload => ipcRenderer.send('chart:runtime-status', payload),
    reportRuntimeError: payload => ipcRenderer.send('chart:runtime-error', payload),
    reportRuntimeEvent: payload => ipcRenderer.send('chart:runtime-event', payload),
    reportDiagnostics: payload => ipcRenderer.send('chart:diagnostics', payload),
    windowReady: payload => ipcRenderer.send('window-lifecycle:ready', {
        appId: 'chart-workbench',
        ...payload,
    }),

    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    toggleMaximizeWindow: () => ipcRenderer.send('maximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),
    openDevTools: () => ipcRenderer.send('open-dev-tools'),

    onChartChanged: callback => subscribe('chart:changed', callback),
    onSelectChart: callback => subscribe('chart:select', callback),
    onRequestDiagnostics: callback => subscribe('chart:request-diagnostics', callback),
    onThemeUpdated: callback => subscribe('theme-updated', callback),
});

contextBridge.exposeInMainWorld('chartAPI', chartAPI);