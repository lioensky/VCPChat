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

test('Batch 48 main-process edge guards: IR non-string, WebDAV query slash & destroyed webContents, M3U safeFileName, translate fenced JSON & cooldown reset', async () => {
    const { h, ipcMain } = fakeIpc();
    const sent = [];
    let info = null;
    const win = { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: (...a) => sent.push(a) } };
    registerMusicEngineHandlers({
        ipcMain,
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        audioEngineApi: async () => ({ status: 'success' }),
        webdavManager: {},
        getDialogWindow: () => null,
        irPresetDir: os.tmpdir()
    });
    assert.equal(await h.get('music-get-ir-preset-path')({}, null), null);
    assert.equal(await h.get('music-get-ir-preset-path')({}, 123), null);

    registerMusicWebdavHandlers({
        ipcMain,
        webdavManager: {
            scanAudioFiles: async (config, progress) => { progress(5); return { status: 'success', tracks: [{ path: 'a' }] }; },
            configureAndLoad: async () => ({ status: 'success' })
        },
        getMusicWindow: () => win,
        setCurrentSongInfo: (v) => { info = v; }
    });
    await h.get('webdav-scan-audio')({}, { url: 'https://nas/dav' });
    assert.equal(sent.length, 0, 'destroyed webContents receives no scan progress');
    await h.get('webdav-load-track')({}, { url: 'https://nas/dav/%E6%AD%8C.flac?next=/a/b#frag/c' });
    assert.equal(info.title, '歌.flac', 'URL filename strips query and hash before splitting slashes');

    const { safeFileName } = require('../modules/ipc/musicM3u');
    assert.equal(safeFileName('CON'), '_CON');
    assert.equal(safeFileName('lpt1.txt'), '_lpt1.txt');
    assert.equal(safeFileName('歌单...  '), '歌单');
    assert.equal(safeFileName('...'), '歌单');

    const { parseTranslations, createLyricsTranslator } = require('../modules/musicLyricsTranslate');
    assert.deepEqual(
        parseTranslations('说明 [1]: 译文如下\n```json\n["第一句", "第二句"]\n```', 2),
        ['第一句', '第二句'],
        'parseTranslations prefers fenced JSON array when prose precedes it with brackets'
    );

    let callCount = 0;
    const translator = createLyricsTranslator({
        getSettings: async () => ({ vcpServerUrl: 'http://127.0.0.1:6005/v1/chatvcp/completions', topicSummaryModel: 'test-model' }),
        getCacheDir: () => null,
        fetchImpl: async () => {
            callCount++;
            if (callCount === 1) return { ok: false, status: 500 };
            return { ok: true, json: async () => ({ choices: [{ message: { content: '["你好"]' } }] }) };
        }
    });
    const first = await translator.translate({ lines: ['Hello'] });
    assert.equal(first.status, 'error');
    const forced = await translator.translate({ lines: ['Hello'], force: true });
    assert.equal(forced.status, 'success');
    const afterForced = await translator.translate({ lines: ['Hello'] });
    assert.equal(afterForced.status, 'success', 'successful forced translation clears stale failure cooldown');
});
