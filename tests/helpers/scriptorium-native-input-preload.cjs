'use strict';

require('../../preloads/docx.js');
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('testBrowserInput', {
    insertText: text => ipcRenderer.invoke('test:insert-text', text),
});
