const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// 手动推进的时钟：提示层里的延迟、自动消失、倒计时都靠它来测。
function fakeClock(window) {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    const add = (fn, ms, repeat) => { const id = nextId++; timers.set(id, { fn, at: now + Math.max(0, ms || 0), ms, repeat }); return id; };
    window.setTimeout = (fn, ms) => add(fn, ms, false);
    window.setInterval = (fn, ms) => add(fn, ms, true);
    window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
    window.requestAnimationFrame = (fn) => add(fn, 16, false);
    window.Date.now = () => now;
    return {
        advance(ms) {
            const end = now + ms;
            for (;;) {
                let due = null;
                for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
                if (!due) break;
                const [id, t] = due;
                now = t.at;
                if (t.repeat) t.at += t.ms; else timers.delete(id);
                t.fn();
            }
            now = end;
        }
    };
}

function setup() {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const clock = fakeClock(window);
    window.eval(read('Musicmodules/music-dock/music-dock-icons.js'));
    window.eval(read('Musicmodules/music-dock/music-toast.js'));
    const doc = window.document;
    const visible = () => [...doc.querySelectorAll('.mtst:not(.mtst-out)')];
    return { window, doc, clock, toast: window.MusicToast, visible };
}

test('toasts stack up to three, update in place by id and expire', () => {
    const { clock, toast, visible, doc } = setup();
    toast.show('一');
    toast.show({ id: 'scan', kind: 'progress', message: '正在扫描 1 / 10', progress: 0.1 });
    const msgNode = doc.querySelector('[data-key="scan"] .mtst-msg');
    const barFill = doc.querySelector('[data-key="scan"] .mtst-bar span');
    const iconSvg = doc.querySelector('[data-key="scan"] .mtst-ic svg');
    toast.show({ id: 'scan', message: '正在扫描 5 / 10', progress: 0.5 });
    assert.equal(visible().length, 2);
    assert.equal(doc.querySelector('[data-key="scan"] .mtst-msg'), msgNode, 'progress-only update reuses message node without innerHTML rebuild');
    assert.equal(doc.querySelector('[data-key="scan"] .mtst-bar span'), barFill, 'progress-only update reuses bar fill node');
    assert.equal(doc.querySelector('[data-key="scan"] .mtst-ic svg'), iconSvg, 'progress-only update keeps spinner SVG intact');
    assert.equal(msgNode.textContent, '正在扫描 5 / 10');
    assert.match(barFill.getAttribute('style'), /scaleX\(0\.5\)/);
    toast.show('二');
    toast.show('三');
    assert.equal(visible().length, 3, 'oldest is pushed out');
    assert.ok(!visible().some((el) => el.textContent.includes('一')));
    clock.advance(4100);
    assert.deepEqual(visible().map((el) => el.dataset.key), ['scan'], 'info toasts expire, progress stays');
    toast.dismiss('scan');
    assert.equal(visible().length, 0);
});

test('delay hides work that finishes quickly', () => {
    const { clock, toast, visible } = setup();
    const t = toast.show({ id: 'load', kind: 'progress', message: '加载中', delay: 300 });
    clock.advance(200);
    t.close();
    clock.advance(500);
    assert.equal(visible().length, 0);
    toast.show({ id: 'load2', kind: 'progress', message: '加载中', delay: 300 });
    clock.advance(320);
    assert.equal(visible().length, 1);
});

test('skip countdown runs once, pauses on hover and can be pressed early', () => {
    const { window, clock, toast, visible } = setup();
    let skipped = 0;
    toast.show({ id: 'playback', kind: 'error', message: '加载失败：坏文件', action: { label: '跳过', countdown: 5, run: () => { skipped++; } } });
    clock.advance(20);
    const el = visible()[0];
    assert.equal(el.getAttribute('role'), 'alert');
    assert.equal(el.querySelector('.mtst-act').textContent, '跳过 5');
    clock.advance(2000);
    assert.equal(el.querySelector('.mtst-act').textContent, '跳过 3');
    el.dispatchEvent(new window.Event('pointerenter'));
    clock.advance(10000);
    assert.equal(skipped, 0, 'hover holds the countdown');
    el.dispatchEvent(new window.Event('pointerleave'));
    clock.advance(3100);
    assert.equal(skipped, 1);
    assert.equal(visible().length, 0);

    toast.show({ kind: 'error', message: '加载失败', action: { label: '跳过', countdown: 5, run: () => { skipped++; } } });
    visible()[0].querySelector('.mtst-act').click();
    clock.advance(10000);
    assert.equal(skipped, 2, 'pressing early runs it once, the timer does not run it again');
});

test('the dock routes playback failures and scan progress through the toast layer', () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div class="track-title">A</div><div class="track-artist"></div><div class="album-art"></div>
        <span class="current-time">0:00</span><span class="duration">0:00</span>
        <button id="mode-btn"></button><input id="volume-slider" type="range" min="0" max="1" step="0.01" value="0.5">
        <ul id="playlist"></ul><div id="music-dock-root"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    const clock = fakeClock(window);
    window.eval(read('Musicmodules/music-app-hooks.js'));
    for (const f of ['music-dock-icons.js', 'music-toast.js', 'music-dock-palette.js', 'music-dock-queue.js', 'music-dock-stage-settings.js', 'music-dock.js']) window.eval(read(`Musicmodules/music-dock/${f}`));
    const doc = window.document;
    const scan = {};
    const calls = [];
    const notices = [];
    const app = {
        playlist: [{ path: 'a', title: 'A' }, { path: 'b', title: 'B' }],
        currentTrackIndex: 0, isPlaying: false, playModes: ['repeat'], currentPlayMode: 0,
        trackTitle: doc.querySelector('.track-title'), trackArtist: doc.querySelector('.track-artist'), albumArt: doc.querySelector('.album-art'),
        currentTimeEl: doc.querySelector('.current-time'), durationEl: doc.querySelector('.duration'), modeBtn: doc.getElementById('mode-btn'),
        volumeSlider: doc.getElementById('volume-slider'), playlistEl: doc.getElementById('playlist'),
        showPlaybackNotice: (m) => notices.push(m),
        nextTrack() { calls.push('next'); },
        api: {
            onMusicScanStart: (fn) => { scan.start = fn; },
            onMusicScanProgress: (fn) => { scan.progress = fn; },
            onMusicScanComplete: (fn) => { scan.complete = fn; }
        }
    };
    const dock = window.initMusicDock(app);
    try {
        app.showPlaybackNotice('播放失败：音频引擎没有响应');
        assert.deepEqual(notices, ['播放失败：音频引擎没有响应'], 'old notice still runs');
        clock.advance(20);
        const err = doc.querySelector('.mtst-error');
        assert.ok(err);
        assert.equal(err.querySelector('.mtst-msg').textContent, '播放失败：音频引擎没有响应');
        // 加载失败的提示（带「跳过」）由播放器自己出，底栏不再补第二条。
        app.cancelFailureSkip = () => {};
        app.showPlaybackNotice('加载失败：解码错误');
        clock.advance(20);
        assert.equal(doc.querySelectorAll('.mtst-error').length, 1);
        assert.equal(doc.querySelector('.mtst-error .mtst-msg').textContent, '播放失败：音频引擎没有响应');
        assert.deepEqual(calls, []);

        scan.start();
        scan.progress({ current: 3, total: 12 });
        clock.advance(400);
        assert.equal(doc.querySelector('.mtst-progress .mtst-msg').textContent, '正在扫描 3 / 12');
        scan.complete({ tracks: [1, 2, 3], folderPath: 'C:/Music' });
        clock.advance(20);
        assert.equal(doc.querySelector('.mtst-success .mtst-msg').textContent, '扫描完成，这个文件夹里有 3 首');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('fresh toast avoids forced offsetWidth reflow and ignores rAF if closed immediately', () => {
    const { window, doc, clock, toast } = setup();
    let offsetReads = 0;
    const origDesc = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() { offsetReads += 1; return origDesc?.get ? origDesc.get.call(this) : 0; }
    });
    try {
        const quick = toast.show({ id: 'quick', message: '闪现' });
        const quickEl = doc.querySelector('[data-key="quick"]');
        quick.close();
        clock.advance(20);
        assert.equal(quickEl.classList.contains('mtst-in'), false, 'closed toast must not gain mtst-in on stale rAF');

        toast.show({ id: 'fresh', message: '新建提示' });
        assert.equal(offsetReads, 0, 'fresh toast mount triggers zero forced offsetWidth reflows');
        const el = doc.querySelector('[data-key="fresh"]');
        assert.ok(el.classList.contains('mtst-evap'), 'evaporation class is still armed on mount');
        toast.show({ id: 'fresh', message: '延长提示', duration: 5000 });
        assert.equal(offsetReads, 0, 're-arming an active evaporating toast avoids forced offsetWidth reflow');
        assert.equal(el.classList.contains('mtst-evap'), false, 're-arming removes mtst-evap before next rAF');
        clock.advance(20);
        assert.equal(el.classList.contains('mtst-evap'), true, 're-arming restores mtst-evap on next animation frame');
        // Hovering during pending evapRaf cancels re-arm
        toast.show({ id: 'fresh', message: '再次延长', duration: 5000 });
        el.dispatchEvent(new window.Event('pointerenter'));
        clock.advance(20);
        assert.equal(el.classList.contains('mtst-evap'), false, 'hovering before evapRaf fires keeps mtst-evap cleared');
    } finally {
        if (origDesc) Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', origDesc);
        window.close();
    }
});

test('toast setPosition updates inline CSS vars on .mtst-layer and same-kind progress update keeps DOM intact', () => {
    const { window, doc, toast } = setup();
    try {
        toast.setPosition(520, 480);
        toast.show({ id: 'scan', kind: 'progress', message: '正在扫描 1 / 100', progress: 0.01 });
        const layer = doc.querySelector('.mtst-layer');
        assert.equal(layer.style.getPropertyValue('--md-toast-x'), '520px');
        assert.equal(layer.style.getPropertyValue('--md-toast-max'), '480px');
        toast.setPosition(400, 360);
        assert.equal(layer.style.getPropertyValue('--md-toast-x'), '400px');
        assert.equal(layer.style.getPropertyValue('--md-toast-max'), '360px');

        const msgNode = doc.querySelector('[data-key="scan"] .mtst-msg');
        const iconSvg = doc.querySelector('[data-key="scan"] .mtst-ic svg');
        // 即使再次传入相同的 kind: 'progress'，也不应销毁重建 DOM 与 SVG
        toast.show({ id: 'scan', kind: 'progress', message: '正在扫描 50 / 100', progress: 0.5 });
        assert.equal(doc.querySelector('[data-key="scan"] .mtst-msg'), msgNode, 'same-kind update preserves message node');
        assert.equal(doc.querySelector('[data-key="scan"] .mtst-ic svg'), iconSvg, 'same-kind update preserves icon SVG');
        assert.equal(msgNode.textContent, '正在扫描 50 / 100');
    } finally {
        window.close();
    }
});

test('Batch 53: toast caches DOM refs on progress updates, fluid marker caches SVG attrs, and low-power CSS drops blur filters', () => {
    const { window, doc, clock, toast, visible } = setup();
    try {
        toast.show({ id: 'p', kind: 'progress', message: '1 / 10', progress: 0.1 });
        const el = doc.querySelector('[data-key="p"]');
        let qsCalls = 0;
        const origQs = el.querySelector.bind(el);
        el.querySelector = (...args) => { qsCalls += 1; return origQs(...args); };
        toast.show({ id: 'p', message: '2 / 10', progress: 0.2 });
        toast.show({ id: 'p', message: '3 / 10', progress: 0.3 });
        assert.equal(qsCalls, 0, 'cached toast msg/bar refs avoid querySelector on progress updates');
        assert.equal(el.textContent.includes('3 / 10'), true);
        window.dispatchEvent(new window.Event('beforeunload'));
        assert.equal(visible().length, 0, 'beforeunload clears active toasts');

        // Verify music-fluid-marker caches static SVG rect attributes across animation frames
        window.eval(read('Musicmodules/music-dock/music-fluid-marker.js'));
        const box = doc.createElement('div');
        Object.defineProperty(box, 'clientHeight', { value: 40 });
        Object.defineProperty(box, 'scrollWidth', { value: 400 });
        doc.body.appendChild(box);
        const marker = window.createMusicFluidMarker(box, { axis: 'x', thickness: 4 });
        marker.moveTo({ start: 10, end: 50 }, { instant: true });
        const headRect = box.querySelector('svg rect');
        let yWrites = 0;
        let hWrites = 0;
        const origSetAttr = headRect.setAttribute.bind(headRect);
        headRect.setAttribute = (name, val) => {
            if (name === 'y') yWrites += 1;
            if (name === 'height') hWrites += 1;
            return origSetAttr(name, val);
        };
        marker.moveTo({ start: 80, end: 120 }, { instant: true });
        marker.moveTo({ start: 140, end: 180 }, { instant: true });
        assert.equal(yWrites, 0, 'constant cross-axis y attribute is not rewritten on horizontal marker moves');
        assert.equal(hWrites, 0, 'constant thickness height attribute is not rewritten on horizontal marker moves');
        marker.destroy();

        const drawerCss = read('Musicmodules/music-dock/music-dock-drawer.css');
        assert.match(drawerCss, /#music-dock-root\.md-fl-low \.md-cmd-box[\s\S]*filter:\s*none/, 'low-power mode disables animated blur filters on palette/toast/tabs');
        void clock;
    } finally {
        window.close();
    }
});

test('Batch 67: toast.clear() removes active and exiting toasts immediately and cancels pending exit timers', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const doc = window.document;
    let nextId = 1;
    const activeTimers = new Set();
    window.setTimeout = (fn) => { const id = nextId++; activeTimers.add(id); return id; };
    window.clearTimeout = (id) => { activeTimers.delete(id); };
    window.setInterval = () => nextId++;
    window.clearInterval = () => {};
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
    try {
        window.eval(read('Musicmodules/music-dock/music-dock-icons.js'));
        window.eval(read('Musicmodules/music-dock/music-toast.js'));
        const t1 = window.MusicToast.show({ id: 'a', message: '一' });
        window.MusicToast.show({ id: 'b', message: '二' });
        t1.close(); // enters 320ms exit animation
        assert.ok(doc.querySelector('[data-key="a"].mtst-out'), 'closing toast enters mtst-out transition');
        assert.ok(activeTimers.size >= 1, 'exit timer is pending before clear()');

        window.MusicToast.clear();
        assert.equal(doc.querySelectorAll('.mtst').length, 0, 'clear() removes both active and exiting toasts immediately');
        assert.equal(activeTimers.size, 0, 'clear() cancels all pending exit and lifetime timers');
    } finally {
        window.close();
    }
});

test('Batch 72: MusicToast deduplicates unchanged clamped progress bar transform writes', () => {
    const { window, doc, toast } = setup();
    try {
        toast.show({ id: 'dl', kind: 'progress', message: '下载 50%', progress: 0.5 });
        const bar = doc.querySelector('[data-key="dl"] .mtst-bar > span');
        assert.ok(bar);
        let transformWrites = 0;
        let currentTransform = bar.style.transform;
        Object.defineProperty(bar.style, 'transform', {
            configurable: true,
            get() { return currentTransform; },
            set(v) { transformWrites += 1; currentTransform = v; }
        });
        toast.show({ id: 'dl', kind: 'progress', message: '下载 50%', progress: 0.5 });
        toast.show({ id: 'dl', kind: 'progress', message: '下载 50%', progress: 0.50001 });
        assert.equal(transformWrites, 0, 'unchanged progress skips redundant bar transform writes');
        toast.show({ id: 'dl', kind: 'progress', message: '下载 75%', progress: 0.75 });
        assert.equal(transformWrites, 1, 'meaningful progress change updates bar transform once');
        assert.equal(currentTransform, 'scaleX(0.75)');
    } finally {
        window.close();
    }
});

test('Batch 98: MusicToast caches lastMessage to skip DOM textContent getter reads on same-message progress updates', () => {
    const { window, doc, toast } = setup();
    try {
        toast.show({ id: 'scan', kind: 'progress', message: '正在扫描…', progress: 0.1 });
        const msgEl = doc.querySelector('[data-key="scan"] .mtst-msg');
        assert.ok(msgEl);
        let msgReads = 0;
        let msgWrites = 0;
        const textDesc = Object.getOwnPropertyDescriptor(window.Node.prototype, 'textContent');
        Object.defineProperty(msgEl, 'textContent', {
            configurable: true,
            get() { msgReads += 1; return textDesc.get.call(this); },
            set(v) { msgWrites += 1; return textDesc.set.call(this, v); }
        });

        toast.show({ id: 'scan', kind: 'progress', message: '正在扫描…', progress: 0.4 });
        toast.show({ id: 'scan', kind: 'progress', message: '正在扫描…', progress: 0.8 });
        assert.equal(msgReads, 0, 'cached lastMessage avoids DOM textContent getter reads');
        assert.equal(msgWrites, 0, 'identical message skips textContent writes');

        toast.show({ id: 'scan', kind: 'progress', message: '扫描完成', progress: 1 });
        assert.equal(msgReads, 0, 'changed message updates without reading DOM textContent');
        assert.equal(msgWrites, 1, 'changed message writes textContent once');
        assert.equal(textDesc.get.call(msgEl), '扫描完成');
    } finally {
        window.close();
    }
});

test('Batch 110: MusicToast caches SVG icon markup across repeated toasts without altering rendered icons', () => {
    const { window, doc, toast } = setup();
    try {
        toast.show({ id: 't1', kind: 'success', message: '第一条' });
        toast.show({ id: 't2', kind: 'success', message: '第二条' });
        toast.show({ id: 't3', kind: 'error', message: '出错了' });
        const ic1 = doc.querySelector('[data-key="t1"] .mtst-ic').innerHTML;
        const ic2 = doc.querySelector('[data-key="t2"] .mtst-ic').innerHTML;
        const ic3 = doc.querySelector('[data-key="t3"] .mtst-ic').innerHTML;
        assert.equal(ic1, ic2, 'same kind/size toast renders identical cached SVG');
        assert.notEqual(ic1, ic3, 'distinct kind renders distinct SVG');
        assert.ok(ic1.includes('width="16"') && ic3.includes('width="16"'));
    } finally {
        window.close();
    }
});

test('Batch 116: toast DOM build, desktop-lyrics playing poll skip, webdav collator/type=button, output device-sig/fallbackSeq, fluid-marker, modal-focus & likes', async () => {
    // 1. MusicToast renders via cached SVG clones & direct DOM construction without innerHTML on toast element
    {
        const { window, doc, toast } = setup();
        try {
            let innerWrites = 0;
            const desc = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML');
            Object.defineProperty(window.Element.prototype, 'innerHTML', {
                configurable: true,
                get() { return desc.get.call(this); },
                set(v) {
                    if (this.classList && this.classList.contains('mtst')) innerWrites += 1;
                    return desc.set.call(this, v);
                }
            });
            try {
                toast.show({ id: 'b116', kind: 'progress', message: '缓存图标', progress: 0.25, action: { label: '取消', run() {} } });
                assert.equal(innerWrites, 0, 'toast render builds DOM via cached SVG clones without innerHTML on toast root');
                const root = doc.querySelector('[data-key="b116"]');
                assert.ok(root.querySelector('.mtst-ic svg.mtst-i'));
                assert.ok(root.querySelector('.mtst-x svg.mtst-i'));
                assert.equal(root.querySelector('.mtst-act').textContent, '取消');
                assert.match(root.querySelector('.mtst-bar > span').style.transform, /scaleX\(0\.25\)/);
            } finally {
                Object.defineProperty(window.Element.prototype, 'innerHTML', desc);
            }
        } finally {
            window.close();
        }
    }

    // 2. music-desktop-lyrics playing poll skips snapshot/publish on same line within RESYNC_MS, publishes on line advance
    {
        const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
        const { window } = dom;
        try {
            let nowMs = 10000;
            let pollFn = null;
            const sent = [];
            window.Date.now = () => nowMs;
            window.setInterval = (fn) => { pollFn = fn; return 1; };
            window.clearInterval = () => {};
            window.eval(read('Musicmodules/music-desktop-lyrics.js'));
            const lines = [
                { time: 0, text: 'Line 1', translation: '行一' },
                { time: 5, text: 'Line 2', translation: '行二' }
            ];
            const app = {
                playlist: [{ path: 'C:\\a.flac', title: 'A', artist: 'X' }],
                currentTrackIndex: 0,
                isPlaying: true,
                lastKnownCurrentTime: 1,
                lastStateUpdateTime: nowMs,
                currentLyrics: lines,
                lyricsTranslation: true,
                api: {
                    toggleDesktopLyrics: async (v) => v,
                    publishDesktopLyrics: (snap) => sent.push(snap)
                }
            };
            window.setupMusicDesktopLyrics(app);
            await app.desktopLyrics.toggle(true);
            assert.equal(sent.length, 1);
            assert.equal(sent[0].index, 0);
            // Advance 500ms within same line -> fast-path skips publish
            nowMs += 500;
            pollFn();
            assert.equal(sent.length, 1, 'same-line playing poll skips redundant snapshot & IPC');
            // Advance to t=5.5s (Line 2) -> publishes line change
            nowMs += 4000;
            pollFn();
            assert.equal(sent.length, 2, 'line advance breaks out of fast-path and publishes');
            assert.equal(sent[1].index, 1);
            window.dispatchEvent(new window.Event('beforeunload'));
        } finally {
            window.close();
        }
    }

    // 3. music-output skips DOM rebuild when device signature unchanged & drops stale fallback check
    {
        const dom = new JSDOM('<!doctype html><body><select id="dev"></select><p id="output-fallback-note" hidden></p></body>', { runScripts: 'outside-only' });
        const { window } = dom;
        try {
            window.eval(read('Musicmodules/music-output.js'));
            const sel = window.document.getElementById('dev');
            const app = {
                deviceSelect: sel,
                currentDeviceId: 3,
                wasapiSwitch: { checked: true },
                api: {
                    getMusicDevices: async () => ({ status: 'success', devices: { preferred: [{ id: 3, name: 'DAC' }], other: [] } }),
                    getMusicState: null
                }
            };
            window.setupOutput(app);
            await app.populateDeviceList();
            const firstOpt = sel.options[1];
            assert.equal(sel.value, '3');
            await app.populateDeviceList();
            assert.equal(sel.options[1], firstOpt, 'unchanged device list preserves existing <option> DOM nodes');

            // Stale checkOutputFallbackSoon reply ignored
            const pending = [];
            app.api.getMusicState = () => new Promise((r) => pending.push(r));
            app.checkOutputFallbackSoon(0);
            await new Promise((r) => setTimeout(r, 15));
            app.checkOutputFallbackSoon(0);
            await new Promise((r) => setTimeout(r, 15));
            assert.equal(pending.length, 2);
            pending[1]({ status: 'success', state: { output_fallback: [] } });
            await new Promise((r) => setTimeout(r, 0));
            pending[0]({ status: 'success', state: { output_fallback: ['device'] } });
            await new Promise((r) => setTimeout(r, 0));
            assert.equal(window.document.getElementById('output-fallback-note').hidden, true, 'stale fallback response ignored');
            window.dispatchEvent(new window.Event('beforeunload'));
        } finally {
            window.close();
        }
    }

    // 4. music-webdav button type="button" + safe prefix strip + collator sort
    {
        const dom = new JSDOM('<!doctype html><body><div id="s"></div><div id="f"></div><div id="b"></div></body>', { runScripts: 'outside-only' });
        const { window } = dom;
        try {
            window.eval(read('Musicmodules/music-webdav.js'));
            const browsed = [];
            const app = {
                webdavServerList: window.document.getElementById('s'),
                webdavFileList: window.document.getElementById('f'),
                webdavBreadcrumb: window.document.getElementById('b'),
                webdavServers: [{ id: '1', name: 'NAS', url: 'https://nas.local' }],
                activeWebDavServer: { id: '1', name: 'NAS', url: 'https://nas.local' },
                api: {
                    listWebdavDirectory: async () => ({
                        status: 'success',
                        entries: [
                            { name: 'b.flac', href: '/b.flac', isDir: false },
                            { name: 'a.flac', href: '/a.flac', isDir: false },
                            { name: 'Dir', href: 'https://nas.local/Dir/', isDir: true }
                        ]
                    })
                }
            };
            window.setupWebDav(app);
            app.renderWebDavServerList();
            assert.equal(window.document.querySelector('.webdav-server-remove').getAttribute('type'), 'button');
            await app.browseWebDav('/');
            const names = [...window.document.querySelectorAll('.webdav-file-name')].map((n) => n.textContent);
            assert.deepEqual(names, ['Dir', 'a.flac', 'b.flac']);
            const origBrowse = app.browseWebDav;
            app.browseWebDav = (p) => browsed.push(p);
            window.document.querySelector('.webdav-file-item.is-dir').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
            assert.deepEqual(browsed, ['/Dir']);
            app.browseWebDav = origBrowse;
        } finally {
            window.close();
        }
    }

    // 5. music-fluid-marker skips redundant cross-axis setAttribute across glides; music-likes toggles without mutating cached Set
    {
        const dom = new JSDOM('<!doctype html><body><div id="bar"></div></body>', { runScripts: 'outside-only' });
        const { window } = dom;
        try {
            window.eval(read('Musicmodules/music-dock/music-fluid-marker.js'));
            const bar = window.document.getElementById('bar');
            Object.defineProperty(bar, 'clientHeight', { value: 36, configurable: true });
            Object.defineProperty(bar, 'scrollWidth', { value: 400, configurable: true });
            const marker = window.createMusicFluidMarker(bar, { axis: 'x', thickness: 4 });
            const svg = bar.querySelector('svg.mfm');
            let heightWrites = 0;
            const origSetAttr = svg.setAttribute.bind(svg);
            svg.setAttribute = (k, v) => { if (k === 'height') heightWrites += 1; return origSetAttr(k, v); };
            marker.moveTo({ start: 10, end: 80 }, { instant: true });
            marker.moveTo({ start: 120, end: 210 }, { instant: true });
            marker.moveTo({ start: 230, end: 310 }, { instant: true });
            assert.equal(heightWrites, 1, 'x-axis marker writes unchanged cross-axis height attribute only once');
            marker.destroy();

            window.eval(read('Musicmodules/music-likes.js'));
            const t1 = { path: 'C:\\1.flac', title: '1' };
            const t2 = { path: 'C:\\2.flac', title: '2' };
            const lApp = { playlist: [t1, t2], customPlaylists: [] };
            window.setupMusicLikes(lApp);
            assert.equal(lApp.toggleLike(t1, { quiet: true }), true);
            assert.equal(lApp.isLiked(t1), true);
            assert.equal(lApp.toggleLike([t1, t2, t2], { quiet: true }), true);
            assert.deepEqual(Array.from(lApp.likedPlaylist().tracks), ['C:\\2.flac', 'C:\\1.flac']);
            assert.equal(lApp.toggleLike(t1, { quiet: true }), false);
            assert.deepEqual(Array.from(lApp.likedPlaylist().tracks), ['C:\\2.flac']);
        } finally {
            window.close();
        }
    }
});
