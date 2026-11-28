/*
 * 整个音乐窗口的「外形指纹」：真 music.html + 假预加载接口，打开后记录
 *   - app 上有哪些属性、哪些是方法（谁装上了什么）
 *   - 每个舞台模式进入后舞台根节点和 body 上的类
 *   - 页面报错
 * 重构前后各跑一次、diff 两份输出，就能看出装配或舞台外观有没有变。
 *
 *   node tests/music-window-bench/surface.cjs [--root=<另一份检出>] [--out=<file.json>]
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));

const FAKE = () => {
    const tracks = Array.from({ length: 60 }, (_, i) => ({
        path: 'D:\\Music\\album' + (i % 6) + '\\t' + i + '.flac', title: '曲目 ' + (i + 1), artist: 'Artist ' + (i % 9),
        album: 'Album ' + (i % 6), duration: 200, sampleRate: 44100, bitsPerSample: 16, codec: 'FLAC', lossless: true
    }));
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null, volume: 0.8 };
    const fns = {
        getMusicPlaylist: async () => tracks,
        getCustomPlaylists: async () => [],
        getMusicState: async () => ({ status: 'success', state: { ...state } }),
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [],
        listWebdavServers: async () => [],
        musicLoad: async (t) => { state.file_path = t && t.path; return { status: 'success', state: { ...state } }; },
        getMusicLyrics: async () => null, fetchMusicLyrics: async () => null,
        musicRendererReady: () => { window.__ready = true; }
    };
    window.electronAPI = new Proxy({}, {
        get: (_, key) => {
            if (typeof key !== 'string') return undefined;
            if (key.startsWith('on')) return () => () => {};
            return (...a) => (fns[key] || (async () => ({ status: 'success' })))(...a);
        }
    });
    // 拿到 app：首页模块在 init 里调 MusicArchive.init(app)
    let archive;
    Object.defineProperty(window, 'MusicArchive', {
        configurable: true,
        get: () => archive,
        set: (v) => { archive = v && { ...v, init: (app) => { window.__app = app; return v.init(app); } }; }
    });
};

(async () => {
    const server = await require('../music-stage-bench/serve.cjs')(ROOT);
    const url = `http://127.0.0.1:${server.address().port}/Musicmodules/music.html`;
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.addInitScript(FAKE);
    await page.goto(url, { timeout: 120000, waitUntil: 'commit' });
    await page.waitForFunction(() => window.__ready && window.__app, null, { timeout: 120000 });
    await page.waitForTimeout(3000);
    const appShape = await page.evaluate(() => Object.fromEntries(Object.keys(window.__app).sort().map((k) => {
        const v = window.__app[k];
        // 只分「方法」和「数据」：数据的具体类型随连接、计时器等运行时状态变（ws 连没连上），比较时是噪声
        return [k, typeof v === 'function' ? 'function' : 'data'];
    })));
    // 底栏面板各页的结构（标签、类名、data-act），拆底栏文件时比对用
    const dockShape = () => page.evaluate(async () => {
        const dock = window.__app.musicDock;
        if (!dock?.openPanel) return null;
        const shape = (node) => [...node.querySelectorAll('*')].map((n) => n.tagName.toLowerCase()
            + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).sort().join('.') : '')
            + (n.dataset?.act ? `[${n.dataset.act}]` : '')).join(' ');
        const out = {};
        for (const tab of ['封面', '歌词', '控制', '播放列表', '声音']) {
            dock.openPanel(tab);
            await new Promise((r) => setTimeout(r, 60));
            const pnl = document.querySelector('#music-dock-root .md-pnl');
            out[tab] = pnl ? shape(pnl) : null;
        }
        dock.closePanel?.();
        return out;
    });
    const dock = { library: await dockShape() };
    const modes = await page.evaluate(() => [...document.querySelectorAll('[data-stage-mode]')].map((b) => b.dataset.stageMode)
        .filter((v, i, a) => a.indexOf(v) === i));
    const stage = {};
    await page.evaluate(() => window.__app.stageHost.enter?.());
    await page.waitForTimeout(800);
    for (const id of modes) {
        try { await page.evaluate((m) => window.__app.stageHost.setMode(m), id); } catch (e) { errors.push(`setMode(${id}): ${String(e).split("\n")[0]}`); }
        await page.waitForTimeout(400);
        stage[id] = await page.evaluate(() => {
            const root = document.querySelector('.music-stage');
            const keep = (list) => [...list].filter((c) => /^(stage-|music-stage-scene)/.test(c)).sort();
            // 边框频谱：每边一条画布，画过之后有尺寸
            const edges = [...document.querySelectorAll('.music-stage-edge-spectrum canvas')];
            return { root: keep(root?.classList || []), body: keep(document.body.classList), edges: edges.length, edgesSized: edges.filter((c) => c.width > 1).length > 0 };
        });
    }
    dock.stage = await dockShape();
    const out = { appShape, stage, dock, errors };
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.log(`app 属性 ${Object.keys(appShape).length} 个，舞台 ${modes.length} 个，页面报错 ${errors.length} 个`);
    errors.slice(0, 5).forEach((e) => console.log('  ' + e));
    await browser.close();
    server.close();
})().catch((e) => { console.error(e); process.exit(1); });
