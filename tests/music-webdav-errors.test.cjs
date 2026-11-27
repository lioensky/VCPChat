// WebDAV 浏览、测试连接、扫描出错时，给人看的是原因，不是引擎回的英文。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function load() {
    const dom = new JSDOM(`<!doctype html><body><div id="servers"></div><div id="files"></div><div id="crumb"></div><p id="status"></p></body>`, { runScripts: 'outside-only' });
    for (const f of ['Musicmodules/music-player.js', 'Musicmodules/music-error-text.js', 'Musicmodules/music-webdav.js']) dom.window.eval(fs.readFileSync(f, 'utf8'));
    const doc = dom.window.document;
    const app = { stripAudioExtension: (s) => s, renderPlaylist() {}, updateAllCount() {} };
    dom.window.setupWebDav(app);
    Object.assign(app, {
        webdavServerList: doc.getElementById('servers'), webdavFileList: doc.getElementById('files'), webdavBreadcrumb: doc.getElementById('crumb'),
        webdavServers: [{ id: 's1', name: 'NAS', url: 'http://nas' }]
    });
    app.activeWebDavServer = app.webdavServers[0];
    return { dom, app, doc };
}

test('browsing with a wrong password says the account is wrong', async () => {
    const { dom, app, doc } = load();
    app.api = { listWebdavDirectory: async () => ({ status: 'error', message: 'HTTP error: Server returned 401 Unauthorized' }) };
    await app.browseWebDav('/music');
    const text = doc.getElementById('files').textContent;
    assert.match(text, /账号或密码不对/);
    assert.doesNotMatch(text, /HTTP error|Unauthorized/);
    dom.window.close();
});

test('a folder that is gone and a server that does not answer read as such', async () => {
    const { dom, app, doc } = load();
    app.api = { listWebdavDirectory: async () => ({ status: 'error', message: 'HTTP error: Server returned 404 Not Found' }) };
    await app.browseWebDav('/old');
    assert.match(doc.getElementById('files').textContent, /没有这个文件夹/);
    app.api = { listWebdavDirectory: async () => { throw new Error("Error invoking remote method 'webdav-list-directory': Error: connect ECONNREFUSED 127.0.0.1:43789"); } };
    await app.browseWebDav('/m');
    const text = doc.getElementById('files').textContent;
    assert.doesNotMatch(text, /加载中/, 'a thrown call does not leave the list on loading');
    assert.doesNotMatch(text, /ECONNREFUSED|invoking/);
    dom.window.close();
});

test('the reason helper keeps Chinese messages and hides English internals', () => {
    const { dom, app } = load();
    assert.equal(app.webdavReason('WebDAV 服务器已删除或不存在', 'x'), 'WebDAV 服务器已删除或不存在');
    assert.equal(app.webdavReason('HTTP error: Server returned 403 Forbidden', 'x'), 'WebDAV 服务器拒绝了访问');
    assert.equal(app.webdavReason('XML parse error: bad tag', '服务器没有响应'), '服务器没有响应');
    assert.equal(app.webdavReason('', '服务器没有响应'), '服务器没有响应');
    dom.window.close();
});

test('a server that refuses the connection says so plainly, and the folder can be retried in place', async () => {
    const { dom, app, doc } = load();
    let calls = 0;
    app.api = { listWebdavDirectory: async () => { calls++; throw new Error("Error invoking remote method 'webdav-list-directory': Error: connect ECONNREFUSED 192.168.1.5:5005"); } };
    await app.browseWebDav('/m');
    const text = doc.getElementById('files').textContent;
    assert.match(text, /连不上服务器，检查网络或 WebDAV 地址/);
    assert.doesNotMatch(text, /：.*：/, 'one reason, not two stacked with colons');
    const retry = doc.querySelector('#files .webdav-retry-btn');
    assert.ok(retry, 'a retry button is offered');
    app.api.listWebdavDirectory = async () => { calls++; return { status: 'success', entries: [{ name: 'a.flac', href: '/m/a.flac', isDir: false }] }; };
    retry.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls, 2);
    assert.doesNotMatch(doc.getElementById('files').textContent, /打不开/);
    dom.window.close();
});

test('a WebDAV request that fails inside Node ("fetch failed") is about the server, not the audio engine', () => {
    const { dom, app } = load();
    assert.equal(app.webdavReason("Error invoking remote method 'webdav-list-directory': TypeError: fetch failed", 'x'), '连不上服务器，检查网络或 WebDAV 地址');
    dom.window.close();
});

test('malformed percent-encoding in WebDAV paths and filenames renders without throwing URIError', async () => {
    const { dom, app, doc } = load();
    app.api = {
        listWebdavDirectory: async () => ({
            status: 'success',
            entries: [
                { name: '100% Pure', href: '/100% Pure/', isDir: true },
                { name: 'song%ZZ.flac', href: '/100% Pure/song%ZZ.flac', isDir: false }
            ]
        })
    };
    await app.browseWebDav('/100% Pure/bad%2G');
    const crumbs = [...doc.querySelectorAll('#crumb .webdav-crumb')].map((el) => el.textContent);
    assert.deepEqual(crumbs, ['NAS', '100% Pure', 'bad%2G']);
    const items = [...doc.querySelectorAll('#files .webdav-file-name')].map((el) => el.textContent);
    assert.deepEqual(items, ['100% Pure', 'song%ZZ.flac']);
    dom.window.close();
});

test('WebDAV confirm button prevents double submit and server switch ignores stale scan results', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="modal"><div id="servers"></div><div id="files"></div><div id="crumb"></div>
            <button id="scan">扫描</button><button id="import" disabled>导入</button>
        </div>
        <div id="dialog">
            <input id="webdav-server-name" value="NAS 2" />
            <input id="webdav-server-url" value="http://nas2" />
            <input id="webdav-server-username" value="u" />
            <input id="webdav-server-password" value="p" />
            <p id="status"></p>
            <button id="confirm">确定</button>
        </div>
    </body>`, { runScripts: 'outside-only' });
    for (const f of ['Musicmodules/music-player.js', 'Musicmodules/music-error-text.js', 'Musicmodules/music-webdav.js']) {
        dom.window.eval(fs.readFileSync(f, 'utf8'));
    }
    const doc = dom.window.document;
    let resolveAdd;
    let addCalls = 0;
    let resolveScan;
    let progressCb = null;
    const app = {
        stripAudioExtension: (s) => s,
        renderPlaylist() {},
        updateAllCount() {},
        webdavModal: doc.getElementById('modal'),
        webdavServerDialog: doc.getElementById('dialog'),
        webdavServerList: doc.getElementById('servers'),
        webdavFileList: doc.getElementById('files'),
        webdavBreadcrumb: doc.getElementById('crumb'),
        webdavDialogStatus: doc.getElementById('status'),
        webdavDialogConfirm: doc.getElementById('confirm'),
        webdavScanBtn: doc.getElementById('scan'),
        webdavImportBtn: doc.getElementById('import'),
        webdavServers: [{ id: 's1', name: 'NAS 1', url: 'http://nas1' }],
        webdavScannedTracks: [],
        api: {
            addWebdavServer: () => { addCalls += 1; return new Promise((r) => { resolveAdd = r; }); },
            onWebdavScanProgress: (fn) => { progressCb = fn; return () => { progressCb = null; }; },
            scanWebdavAudio: () => new Promise((r) => { resolveScan = r; })
        }
    };
    app.activeWebDavServer = app.webdavServers[0];
    dom.window.setupWebDav(app);
    app.setupWebDavHandlers();

    app.webdavDialogConfirm.click();
    app.webdavDialogConfirm.click();
    assert.equal(addCalls, 1, 'second click while saving is ignored');
    assert.equal(app.webdavDialogConfirm.disabled, true);
    resolveAdd({ id: 's2', name: 'NAS 2', url: 'http://nas2' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(app.webdavDialogConfirm.disabled, false);
    assert.equal(app.webdavServers.length, 2);

    app.webdavScanBtn.click();
    app.activeWebDavServer = app.webdavServers[1];
    app.webdavScanBtn.textContent = '扫描全部音频';
    progressCb?.({ count: 9 });
    assert.equal(app.webdavScanBtn.textContent, '扫描全部音频', 'stale progress from old server does not overwrite label');
    resolveScan({ status: 'success', tracks: [{ path: 'http://nas1/a.flac', title: 'A' }] });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(app.webdavScannedTracks, [], 'stale scan completion does not overwrite new server state');
    assert.equal(app.webdavImportBtn.disabled, true);
    dom.window.close();
});

test('WebDAV browse drops stale server replies, test prevents double click, backdrop closes dialog, and import refreshes archive + toast', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="modal"><div id="servers"></div><div id="files"></div><div id="crumb"></div>
            <button id="scan">扫描</button><button id="import">导入</button>
        </div>
        <div id="dialog" class="active">
            <input id="webdav-server-name" value="NAS 2" />
            <input id="webdav-server-url" value="http://nas2" />
            <input id="webdav-server-username" value="u" />
            <input id="webdav-server-password" value="p" />
            <p id="status"></p>
            <button id="test">测试</button>
            <button id="confirm">确定</button>
        </div>
    </body>`, { runScripts: 'outside-only' });
    for (const f of ['Musicmodules/music-player.js', 'Musicmodules/music-error-text.js', 'Musicmodules/music-webdav.js']) {
        dom.window.eval(fs.readFileSync(f, 'utf8'));
    }
    const doc = dom.window.document;
    const toasts = [];
    dom.window.MusicToast = { show: (o) => toasts.push(o) };
    const browseResolvers = [];
    let testCalls = 0;
    let resolveTest;
    let archiveRefreshes = 0;
    let queueEvents = 0;
    doc.addEventListener('music-queue-change', () => { queueEvents += 1; });
    const s1 = { id: 's1', name: 'NAS 1', url: 'http://nas1' };
    const s2 = { id: 's2', name: 'NAS 2', url: 'http://nas2' };
    const app = {
        playlist: [],
        stripAudioExtension: (s) => s,
        renderPlaylist() {},
        updateAllCount() {},
        saveLibrary() {},
        archiveView: { refresh() { archiveRefreshes += 1; } },
        webdavModal: doc.getElementById('modal'),
        webdavServerDialog: doc.getElementById('dialog'),
        webdavServerList: doc.getElementById('servers'),
        webdavFileList: doc.getElementById('files'),
        webdavBreadcrumb: doc.getElementById('crumb'),
        webdavDialogStatus: doc.getElementById('status'),
        webdavDialogTest: doc.getElementById('test'),
        webdavDialogConfirm: doc.getElementById('confirm'),
        webdavScanBtn: doc.getElementById('scan'),
        webdavImportBtn: doc.getElementById('import'),
        webdavServers: [s1, s2],
        activeWebDavServer: s1,
        webdavScannedTracks: [{ path: 'http://nas2/song.flac', title: 'Song' }],
        api: {
            listWebdavDirectory: () => new Promise((r) => browseResolvers.push(r)),
            testWebdavConnection: () => { testCalls += 1; return new Promise((r) => { resolveTest = r; }); }
        }
    };
    dom.window.setupWebDav(app);
    app.webdavServers = [s1, s2];
    app.activeWebDavServer = s1;
    app.webdavScannedTracks = [{ path: 'http://nas2/song.flac', title: 'Song' }];
    app.setupWebDavHandlers();

    // 1. 切服务器时旧服务器同路径的目录回包不能覆盖新服务器列表
    const p1 = app.browseWebDav('/music');
    app.activeWebDavServer = s2;
    const p2 = app.browseWebDav('/music');
    browseResolvers[1]({ status: 'success', entries: [{ name: 'b.flac', href: '/music/b.flac', isDir: false }] });
    await p2;
    browseResolvers[0]({ status: 'success', entries: [{ name: 'a.flac', href: '/music/a.flac', isDir: false }] });
    await p1;
    assert.deepEqual([...doc.querySelectorAll('#files .webdav-file-name')].map((n) => n.textContent), ['b.flac']);

    // 2. 测试连接防重入 + 点遮罩关弹窗
    app.webdavDialogTest.click();
    app.webdavDialogTest.click();
    assert.equal(testCalls, 1, 'second click while testing is ignored');
    assert.equal(app.webdavDialogTest.disabled, true);
    resolveTest({ status: 'success', message: '连接成功' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(app.webdavDialogTest.disabled, false);
    assert.equal(doc.getElementById('status').textContent, '连接成功');
    app.webdavServerDialog.click();
    assert.equal(app.webdavServerDialog.classList.contains('active'), false, 'clicking dialog backdrop closes it');

    // 3. 导入刷新档案页、派发队列变更事件并显示提示
    app.webdavImportBtn.click();
    assert.equal(app.playlist.length, 1);
    assert.equal(archiveRefreshes, 1, 'import refreshes archiveView');
    assert.equal(queueEvents, 1, 'import dispatches music-queue-change');
    assert.equal(toasts.at(-1)?.kind, 'success');
    dom.window.close();
});

test('browseWebDav("/") keeps root audio files (including .wma) while skipping the root self entry', async () => {
    const { dom, app, doc } = load();
    try {
        app.api = {
            listWebdavDirectory: async () => ({
                status: 'success',
                entries: [
                    { name: '', href: '/', isDir: true },
                    { name: 'Albums', href: '/Albums/', isDir: true },
                    { name: 'song.flac', href: '/song.flac', isDir: false },
                    { name: 'track.wma', href: '/track.wma', isDir: false },
                    { name: 'readme.txt', href: '/readme.txt', isDir: false }
                ]
            })
        };
        await app.browseWebDav('/');
        const names = [...doc.querySelectorAll('#files .webdav-file-name')].map((n) => n.textContent);
        const audioNames = [...doc.querySelectorAll('#files .webdav-file-item.is-audio .webdav-file-name')].map((n) => n.textContent);
        assert.deepEqual(names, ['Albums', 'readme.txt', 'song.flac', 'track.wma']);
        assert.deepEqual(audioNames, ['song.flac', 'track.wma']);
    } finally {
        dom.window.close();
    }
});
