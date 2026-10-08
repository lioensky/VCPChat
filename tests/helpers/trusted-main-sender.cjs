'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
function createTrustedMainSender(page = 'main.html') {
    const sender = new EventEmitter();
    const url = pathToFileURL(path.resolve(__dirname, '../..', page)).href;
    sender.mainFrame = { url, detached: false };
    sender.getURL = () => url;
    sender.getType = () => 'window';
    sender.isDestroyed = () => false;
    return { sender, event: { sender, senderFrame: sender.mainFrame }, mainWindow: { webContents: sender } };
}
module.exports = { createTrustedMainSender };
