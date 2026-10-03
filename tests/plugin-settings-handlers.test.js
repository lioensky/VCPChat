'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createTrustedMainSender } = require('./helpers/trusted-main-sender.cjs');
const handlers = new Map();
let disconnects = 0, reads = 0;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
    if (request === '../services/pluginSettingsService' && parent.filename.endsWith('pluginSettingsHandlers.js')) return { createPluginSettingsService: () => ({ list: async () => { reads++; return []; }, disconnect: () => { disconnects++; } }) };
    return originalLoad.call(this, request, parent, isMain);
};
const { initialize } = require('../modules/ipc/pluginSettingsHandlers');
Module._load = originalLoad;
test('only the application top-level window can read config or issue plugin mutations', async () => {
    const trusted = createTrustedMainSender();
    Object.setPrototypeOf(trusted.mainWindow, EventEmitter.prototype);
    EventEmitter.call(trusted.mainWindow);
    initialize({ mainWindow: trusted.mainWindow, settingsManager: {} });
    const invalid = [createTrustedMainSender('PluginManagerModules/plugin-manager.html').event,
        createTrustedMainSender().event,
        { sender: trusted.sender, senderFrame: { url: trusted.sender.getURL(), detached: false } },
        { senderFrame: { url: 'https://example.org/' } }];
    for (const [channel, handler] of handlers) {
        for (const event of invalid) assert.equal((await handler(event, { category: 'local' })).success, false, channel);
    }
    assert.equal(reads, 0);
    assert.equal((await handlers.get('plugin-settings:list')(trusted.event, { category: 'local' })).success, true);
    assert.equal(reads, 1);
    trusted.sender.emit('did-start-navigation', {}, 'https://example.org', false, false); assert.equal(disconnects, 0);
    trusted.sender.emit('did-start-navigation', {}, trusted.sender.getURL(), false, true); assert.equal(disconnects, 1);
    trusted.mainWindow.emit('closed'); assert.equal(disconnects, 2);
});
