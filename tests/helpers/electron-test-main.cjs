'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

try {
    const data = process.env.VCP_ELECTRON_TEST_DATA;
    const entry = process.env.VCP_ELECTRON_TEST_ENTRY;
    if (!data || !entry) throw new Error('Electron test requires an isolated data directory and entry');
    const session = path.join(data, 'session');
    fs.mkdirSync(session, { recursive: true });
    app.setPath('userData', data);
    app.setPath('sessionData', session);
    app.setAppLogsPath(path.join(data, 'logs'));
    require(entry);
} catch (error) {
    console.error('[ElectronTestBootstrap]', error);
    app.exit(1);
}
