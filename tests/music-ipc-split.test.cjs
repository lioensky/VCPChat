// 从 musicHandlers.js 拆出去的两组 IPC：引擎设置、WebDAV。核对拆出来后取用外部状态的几处。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerMusicEngineHandlers } = require('../modules/ipc/musicEngineHandlers');
const { registerMusicWebdavHandlers } = require('../modules/ipc/musicWebdavHandlers');

const fakeIpc = () => { const h = new Map(); return { h, ipcMain: { handle: (c, f) => h.set(c, f) } }; };

test('engine handlers forward to the engine and read IR presets from their folder', async () => {
    const { h, ipcMain } = fakeIpc();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-'));
    for (const f of ['hall.wav', 'room.FLAC', 'notes.txt']) fs.writeFileSync(path.join(dir, f), '');
    const calls = [];
    const parent = { id: 'music-window' };
    let dialogParent;
    registerMusicEngineHandlers({
        ipcMain,
        dialog: { showOpenDialog: async (w) => { dialogParent = w; return { canceled: false, filePaths: ['C:/ir.wav'] }; } },
        audioEngineApi: async (...a) => { calls.push(a); return { status: 'success' }; },
        webdavManager: { credentialsForTrack: () => ({ username: 'u', password: 'p' }) },
        getDialogWindow: () => parent,
        irPresetDir: dir
    });
    assert.deepEqual((await h.get('music-list-ir-presets')()).sort(), ['hall', 'room']);
    assert.equal(await h.get('music-get-ir-preset-path')({}, 'room'), path.join(dir, 'room.FLAC'));
    assert.equal(await h.get('select-ir-file')(), 'C:/ir.wav');
    assert.equal(dialogParent, parent);
    await h.get('music-set-channels')({}, { balance: 0.2 });
    await h.get('music-queue-next')({}, { path: 'https://nas/a.flac', serverId: 's1' });
    assert.deepEqual(calls, [['/set_channels', 'POST', { balance: 0.2 }], ['/queue_next', 'POST', { path: 'https://nas/a.flac', username: 'u', password: 'p' }]]);
});

test('webdav handlers fill credentials, report scan progress to the music window and record the loading song', async () => {
    const { h, ipcMain } = fakeIpc();
    const sent = [];
    let info = null;
    const win = { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } };
    const webdav = {
        getServerCredentials: () => ({ url: 'https://nas/dav', username: 'u', password: 'p' }),
        scanAudioFiles: async (config, progress) => { progress(3); return { status: 'success', tracks: [], config }; },
        configureAndLoad: async (config) => ({ status: 'success', config })
    };
    registerMusicWebdavHandlers({ ipcMain, webdavManager: webdav, getMusicWindow: () => win, setCurrentSongInfo: (v) => { info = v; } });
    const scanned = await h.get('webdav-scan-audio')({}, { serverId: 's1' });
    assert.equal(scanned.config.password, 'p');
    assert.deepEqual(sent, [['webdav-scan-progress', { count: 3 }]]);
    const loaded = await h.get('webdav-load-track')({}, { url: 'https://nas/dav/x.flac?t=1', serverId: 's1' });
    assert.equal(loaded.config.username, 'u');
    assert.deepEqual(info, { title: 'x.flac', artist: '未知艺术家', album: '未知专辑' });
});
