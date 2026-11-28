// Musicmodules/music-dock/music-dock.js
// 音乐窗口底栏：左下“正在播放”药丸、底部中间的进度胶囊（悬停展开、快捷行）、
// 右下面板把手和统一面板（封面 / 歌词 / 控制 / 播放列表 / 声音）。
// 主界面和舞台共用这一条底栏。
//
// 约定：
// - 只读 app 上的状态、只调 app 上已有的播放方法（playTrack / pauseTrack / seekTo / loadTrack ...），
//   不改 music-player.js 的竞态处理；旧的按钮和滑块留在 DOM 里，音量照旧经由 #volume-slider 发给引擎。
// - 状态变化靠 MutationObserver 和少量事件得知，不每帧轮询；进度只在播放时每 250ms 刷一次。
// - 颜色全部来自 music-theme/music-tokens.css 的 --md-* / --mt-* 变量。
(function (global) {
    'use strict';

    const ICONS = global.MusicDockIcons || {};

    // 胶囊尺寸弹簧（刚度 280、阻尼 24、质量 1）和悬停时序（展开 20ms、收起 100ms、快捷行停留 250ms）。
    const HOVER_EXPAND_MS = 20;
    const HOVER_COLLAPSE_MS = 100;
    const QUICK_DWELL_MS = 250;
    const PROGRESS_TICK_MS = 250;
    const PROGRESS_INSET = 0.06;
    const QUEUE_ROW_H = 48;
    const SAFE_BOTTOM_PX = 96;
    const COMPACT_BELOW = 640;

    const TABS = Object.freeze(['封面', '歌词', '控制', '播放列表', '声音']);
    const MODE_LABELS = Object.freeze({ repeat: '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' });
    const MODE_ICONS = Object.freeze({ repeat: 'repeat', 'repeat-one': 'repeat-1', shuffle: 'shuffle' });

    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

    const icon = (name, size = 16, options = {}) => (
        `<svg class="md-i" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"`
        + ` fill="${options.fill || 'none'}" stroke="currentColor" stroke-width="${options.strokeWidth || 2}"`
        + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`
    );

    // 底栏用两位分钟（00:00）；一小时以上补上小时（1:02:03），和队列、列表里同一首的时长写法一致，不写成 62:03
    const formatClock = (seconds) => {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const two = (n) => `${n < 10 ? '0' : ''}${n}`;
        return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
    };

    // 和 music-utils 的 app.fileUrl 一样：路径里的空格、#、?、'、% 都要编码，否则封面断图
    const fileUrl = (path) => {
        if (!path) return '';
        const p = String(path).replace(/\\/g, '/');
        return 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p).replace(/[?#']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    };

    function initMusicDock(app) {
        const host = document.getElementById('music-dock-root');
        if (!host || !app) return null;

        // 在注入整套底栏 DOM 之前预读一次主题高亮色，避免首次 syncFluid 刚写完 host.innerHTML 就 getComputedStyle 触发全页样式重算
        let bootAccentRaw = null;
        let bootAccentLight = false;
        try {
            bootAccentRaw = getComputedStyle(document.documentElement).getPropertyValue('--highlight-text');
            bootAccentLight = document.body.classList.contains('light-theme');
        } catch (_) { bootAccentRaw = null; }

        const cleanups = [];
        const listen = (target, type, handler, options) => {
            target.addEventListener(type, handler, options);
            cleanups.push(() => target.removeEventListener(type, handler, options));
        };
        const timers = new Set();
        const later = (fn, ms) => {
            const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
            timers.add(id);
            return id;
        };
        const cancel = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };

        host.innerHTML = `
<div class="md-dock"><div class="md-dock-in">
  <div class="md-quick" id="music-dock-quick"><div class="md-quick-in"><div class="md-quick-g" role="toolbar" aria-label="快捷操作">
    <button class="md-slot md-qb" type="button" data-q="queue" aria-label="播放列表" title="播放列表">${icon('list-music', 17)}</button>
    <button class="md-slot md-qb md-like" type="button" data-md="like" aria-label="喜欢" aria-pressed="false" title="喜欢（L）" hidden>${icon('heart', 17)}</button>
    <button class="md-slot md-qb" type="button" data-q="fx" aria-label="音效设置" title="音效设置">${icon('sliders-horizontal', 17)}</button>
    <button class="md-slot md-qb md-vslot" type="button" data-md="vol" aria-label="静音"></button>
  </div></div></div>
  <div class="md-cap">
    <div class="md-trk" role="slider" aria-label="播放进度" tabindex="0"><div class="md-fill"></div><div class="md-kn-rail"><div class="md-kn"></div></div><span class="md-seek-tip" data-md="seek-tip" aria-hidden="true"></span></div>
    <button class="md-pb" type="button" data-md="play" aria-label="播放"></button>
    <div class="md-ttl"><div class="md-tnav">
      <div class="md-zone md-l"><button class="md-arw" type="button" data-md="prev" aria-label="上一首">${icon('chevron-left', 15, { strokeWidth: 2.4 })}</button></div>
      <div class="md-zone md-r"><button class="md-arw" type="button" data-md="next" aria-label="下一首">${icon('chevron-right', 15, { strokeWidth: 2.4 })}</button></div>
      <div class="md-txt"><div class="md-cur"><span data-md="title"></span></div><div class="md-pv"><span data-md="preview"></span></div></div>
      <div class="md-sub"><span data-md="artist"></span><span class="md-tms"><span class="md-tm" data-md="t1"></span> / <span class="md-tm" data-md="t2"></span></span></div>
    </div></div>
    <div class="md-slots">
      <button class="md-slot md-sleep" type="button" data-md="sleep" hidden>${icon('moon', 14)}<span data-md="sleep-t"></span></button>
      <button class="md-slot" type="button" data-md="mode"></button>
      <button class="md-slot md-stage-slot" type="button" data-md="stage" aria-label="歌词舞台" aria-pressed="false" title="进入歌词舞台">${icon('sparkle', 18)}</button>
      <button class="md-slot md-more" type="button" data-md="more" aria-label="更多操作" title="播放列表、喜欢、音效、音量" aria-expanded="false" aria-controls="music-dock-quick">${icon('ellipsis', 18)}</button>
      <button class="md-slot md-pnl-slot" type="button" data-md="panel" aria-label="打开面板" aria-expanded="false" aria-controls="music-dock-panel" title="面板：封面、歌词、控制、播放列表、声音">${icon('settings-2', 18)}</button>
    </div>
  </div>
  <div class="md-vrail" role="slider" tabindex="-1" aria-label="音量" aria-valuemin="0" aria-valuemax="100" aria-hidden="true"><i class="md-vfill"></i></div>
</div></div>
<div class="md-hdl"><button type="button" data-md="handle" aria-label="打开面板" aria-expanded="false" aria-controls="music-dock-panel" title="设置">
  <span class="md-sw md-g">${icon('settings-2', 20)}</span><span class="md-sw md-x">${icon('x', 20)}</span>
</button><span class="md-hdl-tip" id="music-dock-playhead-tip" data-md="hdl-tip"></span></div>
<section class="md-pnl" id="music-dock-panel" role="dialog" aria-label="播放面板" aria-hidden="true">
  <div class="md-hd">
    <div class="md-hd-cv"></div>
    <div class="md-hd-tx"><b data-md="p-title"></b><span data-md="p-artist"></span></div>
    <button class="md-ib md-m md-hd-act" type="button" data-md="share" aria-label="分享当前音频" title="分享当前音频">${icon('share-2', 17)}</button>
  </div>
  <div class="md-body"><div class="md-hr"></div><div class="md-tab" data-md="body" id="music-dock-panel-body" role="tabpanel"></div>
    <div class="md-ext" data-md="ext" hidden>
      <section class="md-grp md-stage-only" data-md="tune-sec" aria-labelledby="music-dock-tune-title">
        <div class="md-grp-h"><b id="music-dock-tune-title" data-md="tune-title"></b><span data-md="tune-hint"></span></div>
        <div class="md-stage-in md-tune" data-md="tune-slot"></div>
        <button class="md-fold" type="button" data-md="tune-more" aria-expanded="false" hidden></button>
      </section>
      <section class="md-grp md-play-grp" data-md="play-sec" aria-label="播放" hidden>
        <div class="md-grp-h"><b>播放</b></div>
        <div class="md-fx-sc md-moved" data-md="play-slot"></div>
      </section>
      <div class="md-tab md-tab2" data-md="body2"></div>
      <div class="md-fx-sc md-moved" data-md="disp-slot"></div>
      <div class="md-stage-in md-stage-only" data-md="common-slot"></div>
      <section class="md-grp md-adv">
        <button class="md-fold md-fold-h" type="button" data-md="adv-toggle" aria-expanded="false" aria-controls="music-dock-adv"><span>更多</span>${icon('chevron-down', 14)}</button>
        <div class="md-adv-in" id="music-dock-adv" data-md="adv-body" hidden>
          <div class="md-grp-k md-stage-only">出现在快速切换里的舞台</div>
          <div class="md-stage-in md-stage-only" data-md="array-slot"></div>
          <div class="md-adv-acts" data-md="adv-acts"></div>
        </div>
      </section>
    </div>
    <div class="md-fx-sc md-fx-in" data-md="fx-scroll" hidden><div class="md-fx-h md-fx-out"><span class="md-fx-n">01</span><b>输出</b></div></div>
  </div>
  <div class="md-dockrow"><div class="md-seg md-seg-l" data-md="tabs" role="tablist" aria-label="面板页签"></div></div>
</section>
<div class="md-drbg" aria-hidden="true"></div>
`;

        const $ = (sel) => host.querySelector(sel);
        const $$ = (sel) => Array.from(host.querySelectorAll(sel));
        const md = Object.create(null);
        for (const n of host.querySelectorAll('[data-md]')) if (!md[n.dataset.md]) md[n.dataset.md] = n;
        const el = {
            dock: $('.md-dock'), dockIn: $('.md-dock-in'), quick: $('.md-quick'), quickGroup: $('.md-quick-g'),
            cap: $('.md-cap'), tnav: $('.md-tnav'), cur: $('.md-cur'), pv: $('.md-pv'),
            vrail: $('.md-vrail'), vfill: $('.md-vfill'), hdl: $('.md-hdl'), pnl: $('.md-pnl'), pCover: $('.md-hd-cv'),
            tracks: $$('.md-trk'), t1: $$('[data-md="t1"]'), t2: $$('[data-md="t2"]'),
            more: md.more, like: md.like, sleep: md.sleep, sleepT: md['sleep-t'],
            play: md.play, prev: md.prev, next: md.next, title: md.title, preview: md.preview, artist: md.artist,
            panelSlot: md.panel, hdlTip: md['hdl-tip'], seekTip: md['seek-tip'],
            modeSlot: md.mode, stageSlot: md.stage, volSlot: md.vol, handle: md.handle,
            pTitle: md['p-title'], pArtist: md['p-artist'], share: md.share, body: md.body, tabs: md.tabs,
            ext: md.ext, body2: md.body2, playSec: md['play-sec'], playSlot: md['play-slot'], dispSlot: md['disp-slot'],
            tuneSec: md['tune-sec'], tuneTitle: md['tune-title'], tuneHint: md['tune-hint'], tuneSlot: md['tune-slot'], tuneMore: md['tune-more'],
            commonSlot: md['common-slot'], advToggle: md['adv-toggle'], advBody: md['adv-body'], arraySlot: md['array-slot'], advActs: md['adv-acts'],
            fxScroll: md['fx-scroll']
        };

        const state = {
            hover: false,
            expanded: false,
            panelOpen: false,
            tab: '控制',
            scenesOpen: false,
            sleepOpen: false,
            tuneAll: false,
            dragging: null,
            lastTimeText: '',
            lastDurText: '',
            lyricIndex: -2,
            lyricsSource: null,
            queueSource: null,
            queueLength: -1,
            trackKey: '',
            volOpen: false,
            volDrag: false,
            destroyed: false
        };
        let expandTimer = null;
        let collapseTimer = null;
        let dwellTimer = null;
        let progressTimer = null;

        document.body.style.setProperty('--music-dock-safe-bottom', `${SAFE_BOTTOM_PX}px`);
        document.body.classList.add('music-dock-on');

        // ───────── 读状态 ─────────
        const currentTrack = () => app.playlist?.[app.currentTrackIndex] || null;
        const activeList = () => app.currentFilteredTracks || app.playlist || [];
        const playMode = () => app.playModes?.[app.currentPlayMode] || 'repeat';
        const stageActive = () => app.isStageActive === true || document.body.classList.contains('music-stage-active');
        const duration = () => Math.max(0, Number(app.lastKnownDuration) || 0);
        const currentTime = () => {
            if (state.dragging) return state.dragging.time;
            const base = Number(app.lastKnownCurrentTime) || 0;
            const elapsed = app.isPlaying && app.lastStateUpdateTime && !app.isTrackLoading
                ? (Date.now() - app.lastStateUpdateTime) / 1000
                : 0;
            const d = duration();
            const t = base + elapsed;
            return d > 0 ? Math.min(d, Math.max(0, t)) : Math.max(0, t);
        };
        const trackTitle = (track) => track ? (app.stripAudioExtension?.(track.title) || track.title || '未知标题') : '未选择歌曲';
        const trackArtist = (track) => track ? (track.artist || '未知艺术家') : '';
        const coverUrl = (track) => track?.albumArt ? fileUrl(track.albumArt) : '';

        // 「降低动态」统一读音乐窗口的设置（跟随系统 / 开 / 关）；没有这个模块时才退回系统设置。
        const systemReduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const reducedMotion = {
            get matches() { return global.MusicMotion ? global.MusicMotion.reduced() : Boolean(systemReduced?.matches); }
        };
        if (!global.MusicMotion && systemReduced) {
            const syncBodyClass = () => document.body.classList.toggle('music-reduce-motion', systemReduced.matches);
            syncBodyClass();
            listen(systemReduced, 'change', syncBodyClass);
        }

        // ───────── 流体层 ─────────
        // 播放条是一块会变状态的物质：播放过的部分凝固成实心玻璃，没播的部分是雾，凝固的边界就是进度；
        // 暂停时整条化成雾，鼠标移上来（关注）又凝固。面板关着时白环收在播放条右端的面板按钮里，
        // 打开面板时飞到右下角当关闭键。音量从播放条里像水滴一样分裂上去。
        // 舞台的「性能档位」选节能时不跑流体层，播放条退成不透明的实色。
        // 播放条玻璃里透出的颜色跟着主题走：平时取 VCPChat 当前主题的强调色（--highlight-text），
        // 舞台换了自定义主题就取舞台的；有自己固定色调的舞台（镜台黄昏、隧图深空、町景霓虹）用各自的颜色。
        // 强调色太灰（单色主题）时退回默认的暖橙。深浅两套各自调亮度，保证上面的字看得清。
        const SCENE_GLOW = {
            light: {
                diorama: ['#ef7b3f', '#f6cdb0', '#ffffff'],
                tunnel: ['#4fa597', '#cfe9e2', '#ffffff'],
                kowloon: ['#e0629f', '#bfe2ea', '#ffffff']
            },
            dark: {
                diorama: ['#e06a30', '#6e4733', '#45403b'],
                tunnel: ['#46a593', '#3c5853', '#3d4441'],
                kowloon: ['#d24a8d', '#2f5a6a', '#3b3e46']
            }
        };
        const FALLBACK_ACCENT = [217, 119, 63];
        const colorProbe = document.createElement('i');
        colorProbe.hidden = true;
        const readRgb = (value) => {
            const text = String(value || '').trim();
            if (!text) return null;
            // 纯 JS 解析 #hex 与 rgb()/rgba()，避免经 colorProbe 写入样式并触发 getComputedStyle 重算
            if (text.charCodeAt(0) === 35) {
                if (text.length === 7 && /^#[0-9a-f]{6}$/i.test(text)) {
                    const n = parseInt(text.slice(1), 16);
                    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
                }
                if (text.length === 4 && /^#[0-9a-f]{3}$/i.test(text)) {
                    const r = parseInt(text[1], 16), g = parseInt(text[2], 16), b = parseInt(text[3], 16);
                    return [r * 17, g * 17, b * 17];
                }
            } else if (text.startsWith('rgb')) {
                const direct = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i.exec(text);
                if (direct) return [Number(direct[1]), Number(direct[2]), Number(direct[3])];
            }
            colorProbe.style.color = '';
            colorProbe.style.color = text;
            if (!colorProbe.style.color) return null;
            if (!colorProbe.isConnected) host.appendChild(colorProbe);
            const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(getComputedStyle(colorProbe).color || '');
            return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
        };
        const rgbToHsl = ([r, g, b]) => {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const l = (max + min) / 2;
            if (max === min) return [0, 0, l];
            const d = max - min;
            const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            return [h / 6, s, l];
        };
        const hslToRgb = ([h, s, l]) => {
            if (!s) return [l * 255, l * 255, l * 255];
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            const f = (t) => {
                t = (t + 1) % 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
        };
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
        const hex = (rgb) => `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
        const glowFromAccent = (accent, light) => {
            let [h, s, l] = rgbToHsl(accent || FALLBACK_ACCENT);
            if (s < 0.12) [h, s, l] = rgbToHsl(FALLBACK_ACCENT);
            if (light) {
                const a = hslToRgb([h, clamp(s, 0.5, 0.85), clamp(l, 0.6, 0.68)]);
                return [hex(a), hex(mix(a, [255, 255, 255], 0.7)), '#ffffff'];
            }
            const a = hslToRgb([h, clamp(s, 0.45, 0.8), clamp(l, 0.5, 0.58)]);
            return [hex(a), hex(mix(a, [70, 64, 59], 0.68)), hex(mix(a, [64, 63, 62], 0.92))];
        };
        const themeAccent = () => {
            const stageRoot = document.getElementById('music-stage');
            if (stageActive() && stageRoot?.classList.contains('stage-theme-custom')) {
                bootAccentRaw = null;
                const custom = readRgb(getComputedStyle(stageRoot).getPropertyValue('--highlight-text'));
                if (custom) return custom;
            }
            if (bootAccentRaw !== null) {
                const raw = bootAccentRaw;
                bootAccentRaw = null;
                if (document.body.classList.contains('light-theme') === bootAccentLight) {
                    return readRgb(raw);
                }
            }
            return readRgb(getComputedStyle(document.documentElement).getPropertyValue('--highlight-text'));
        };
        const dockLight = () => {
            const classes = document.body.classList;
            if (stageActive()) {
                if (classes.contains('music-stage-light')) return true;
                if (classes.contains('music-stage-dark')) return false;
            }
            return classes.contains('light-theme');
        };
        const currentGlow = (light = dockLight()) => {
            const mode = stageActive() ? app.stageHost?.modeId : null;
            const custom = stageActive() && document.getElementById('music-stage')?.classList.contains('stage-theme-custom');
            return (!custom && SCENE_GLOW[light ? 'light' : 'dark'][mode]) || glowFromAccent(themeAccent(), light);
        };
        const lowQuality = () => global.MusicStageConfig?.get?.()?.quality === 'energy-saving';
        let fluid = null;
        let lastRange = ''; // 上次推给流体层的进度区间
        let lastShiftStr = '';
        let lastMistPad = '';
        const applyShiftProp = (v) => {
            const targets = [el.dock, el.hdl, fluid?.svg, fluid?.mist];
            for (let i = 0; i < targets.length; i += 1) {
                const node = targets[i];
                if (!node) continue;
                if (v && v !== '0px') node.style.setProperty('--md-shift', v);
                else node.style.removeProperty('--md-shift');
            }
        };
        const syncFluid = () => {
            const want = typeof global.createMusicDockFluid === 'function' && !lowQuality();
            if (want && !fluid) {
                fluid = global.createMusicDockFluid({
                    host,
                    bar: el.cap,
                    ring: el.hdl,
                    reduced: () => Boolean(global.MusicMotion ? global.MusicMotion.reduced() : reducedMotion.matches)
                });
                if (lastMistPad) fluid?.setMistPad?.(lastMistPad);
                if (lastShiftStr && lastShiftStr !== '0px') {
                    fluid?.svg?.style?.setProperty('--md-shift', lastShiftStr);
                    fluid?.mist?.style?.setProperty('--md-shift', lastShiftStr);
                }
            } else if (!want && fluid) {
                fluid.destroy();
                fluid = null;
                el.hdl.style.transform = '';
            }
            // 先读主题色再切 md-fl-* / md-light 类，避免写类后立刻 getComputedStyle 触发全页样式重算，
            // 并把全部样式变更合并到 fluid.layout() 之前的一次排版里。
            syncGlow();
            host.classList.toggle('md-fl-on', Boolean(fluid));
            host.classList.toggle('md-fl-low', !fluid);
            document.body.classList.toggle('music-fl-low', !fluid);
            host.classList.toggle('md-q-ultimate', global.MusicStageConfig?.get?.()?.quality === 'ultimate');
            if (fluid) {
                // 先完成全部类与状态写入，再连续执行只读测量与 fluid.layout()，最后统一写入进度区间，避免双连环强制重排。
                fluid.setHidden(document.hidden === true);
                fluid.setRingDocked(!state.panelOpen);
                syncSolid();
                syncRing();
                lastRange = '';
                cachedRange = null;
                const measured = measureProgressRange();
                fluid.layout();
                applyProgressRange(measured);
                renderProgress();
            }
        };
        // 节能档没有流体层：把同一套颜色混进实心播放条的进度底色和快捷胶囊的描边里。
        let lastGlowKey = '';
        let lastGlowLight = null;
        const syncGlow = () => {
            const light = dockLight();
            // 先读主题色再切 md-light 类，避免写类后立刻 getComputedStyle 触发全页样式重算
            const colors = currentGlow(light);
            const key = colors.join();
            host.classList.toggle('md-light', light);
            if (key !== lastGlowKey || light !== lastGlowLight) {
                const a = readRgb(colors[0]) || FALLBACK_ACCENT;
                host.style.setProperty('--md-fl-low-fill', hex(mix(a, light ? [247, 242, 238] : [43, 41, 39], light ? 0.62 : 0.55)));
                host.style.setProperty('--md-fl-tint', colors[0]);
                // 提示层挂在 body 上，也要拿到同一个颜色。
                document.body.style.setProperty('--md-fl-tint', colors[0]);
            }
            if (fluid && (key !== lastGlowKey || !fluid.glowSet)) { fluid.setGlow(colors); fluid.glowSet = true; }
            lastGlowKey = key;
            lastGlowLight = light;
        };
        let lastSolid = null, lastTip = null, lastPH = null;
        const syncSolid = () => {
            const solid = app.isPlaying === true || state.hover || state.dragging !== null;
            if (solid !== lastSolid) host.classList.toggle('md-vapor', !(lastSolid = solid));
            fluid?.setSolid(solid); fluid?.setPlaying?.(app.isPlaying === true);
            const held = state.dragging?.fromRing === true || state.ringKbd === true, ph = !state.panelOpen;
            fluid?.setRingFocus?.(state.ringHover === true || held, held);
            const tip = ph && (state.ringHover === true || held);
            if (tip !== lastTip) el.hdl.classList.toggle('md-tip', lastTip = tip);
            if (ph !== lastPH) {
                lastPH = ph;
                const h = el.handle;
                if (ph) { h.setAttribute('aria-describedby', 'music-dock-playhead-tip'); h.title = '播放头：拖动或按左右方向键跳转，点一下打开面板'; }
                else { h.removeAttribute('aria-describedby'); h.title = '关闭面板（Esc）'; }
            }
        };
        const animateCapsule = () => { fluid?.layout(); };

        const shouldExpand = () => state.hover
            || state.dragging !== null
            || (!app.isPlaying && !app.isTrackLoading && duration() > 0 && currentTime() > 0);
        // 白环：面板关着时是播放头（跟着进度走，可拖，点一下开面板）；面板开着时飞到右下角当关闭键。
        // 以前备选的 fixed / hover / drop 摆法去掉了；旧的 localStorage musicDockRingMode 不再读。
        const ringMode = 'playhead';
        const syncRing = () => {
            if (!fluid) return;
            if (fluid.ringMode !== ringMode) fluid.setRingMode(ringMode);
            fluid.setRingHover(state.hover || state.dragging !== null);
        };
        const syncExpanded = () => {
            syncSolid();
            syncRing();
            const next = shouldExpand();
            if (next === state.expanded) return;
            state.expanded = next;
            el.cap.classList.toggle('md-ex', next);
            cachedRange = null;
        };

        // ───────── 进度 ─────────
        // 进度不从播放键底下开始：0% 落在曲名左缘，100% 在右边那组按钮前面，进度细轨就画在这一段的下沿。
        // 曲名和按钮位置只在窗口尺寸、胶囊展开/收窄、右侧槽位增减时变化；缓存结果，避免播放时每 250ms 触发 3 次同步回流。
        const capTxt = el.cap.querySelector('.md-txt');
        const capSlots = el.cap.querySelector('.md-slots');
        const trackParts = el.tracks.map((trk) => ({
            trk, fill: trk.firstElementChild, knob: trk.querySelector('.md-kn-rail'), lastEdge: '', lastNow: ''
        }));
        let cachedRange = null;
        if (typeof ResizeObserver === 'function') {
            const capRo = new ResizeObserver(() => { cachedRange = null; });
            capRo.observe(el.cap);
            cleanups.push(() => capRo.disconnect());
        }
        const measureProgressRange = () => {
            const cap = el.cap.getBoundingClientRect();
            const txt = capTxt?.getBoundingClientRect();
            const slots = capSlots?.getBoundingClientRect();
            let a = PROGRESS_INSET;
            let b = 1 - PROGRESS_INSET;
            if (cap.width > 0 && txt && txt.width > 0) a = Math.min(0.45, Math.max(PROGRESS_INSET, (txt.left - cap.left) / cap.width));
            if (cap.width > 0 && slots && slots.width > 0) b = Math.max(a + 0.2, Math.min(b, (slots.left - 14 - cap.left) / cap.width));
            return { a, b, valid: cap.width > 0 };
        };
        const applyProgressRange = ({ a, b, valid }) => {
            const key = `${a.toFixed(4)}:${b.toFixed(4)}`;
            if (key !== lastRange) {
                lastRange = key;
                fluid?.setProgressRange(a, b);
                for (const trk of el.tracks) { trk.style.setProperty('--md-a', a.toFixed(4)); trk.style.setProperty('--md-b', b.toFixed(4)); }
            }
            const pair = [a, b];
            if (valid) cachedRange = pair;
            return pair;
        };
        const progressRange = (fresh = false) => {
            if (!fresh && cachedRange) return cachedRange;
            return applyProgressRange(measureProgressRange());
        };
        // 胶囊里的总时长点一下换成剩余时间（−03:12），再点换回；记在 localStorage musicDockRemain。
        let remainMode = false;
        try { remainMode = global.localStorage?.getItem('musicDockRemain') === '1'; } catch (e) {}
        const renderProgress = () => {
            const d = duration();
            const t = currentTime();
            const fraction = d > 0 ? Math.min(1, t / d) : 0;
            // 进度边界从曲名左缘走到 94%（音量键前），和流体层、拖动反算用同一个区间。
            const [a, b] = progressRange();
            const edge = a + fraction * (b - a);
            const edgeText = edge.toFixed(5);
            const knobText = `translateX(${(edge * 100).toFixed(3)}%)`;
            const nowText = String(Math.round(t));
            for (const part of trackParts) {
                if (part.lastEdge !== edgeText) {
                    part.lastEdge = edgeText;
                    part.fill.style.transform = `scaleX(${edgeText})`;
                    part.trk.style.setProperty('--md-edge', edgeText);
                    part.knob.style.transform = knobText;
                }
                if (part.lastNow !== nowText) {
                    part.lastNow = nowText;
                    part.trk.setAttribute('aria-valuenow', nowText);
                }
            }
            fluid?.setProgress(fraction);
            const timeText = formatClock(t);
            const totalText = formatClock(d);
            const tipText = `${timeText} / ${totalText}`;
            if (el.hdlTip && state.lastTipText !== tipText) { state.lastTipText = tipText; el.hdlTip.textContent = tipText; }
            const durText = remainMode && d > 0 ? `−${formatClock(Math.max(0, d - t))}` : totalText;
            if (timeText !== state.lastTimeText) {
                state.lastTimeText = timeText;
                for (const node of el.t1) node.textContent = timeText;
            }
            if (durText !== state.lastDurText) {
                state.lastDurText = durText;
                for (const node of el.t2) node.textContent = durText;
                const max = String(Math.round(d));
                for (const trk of el.tracks) if (trk.getAttribute('aria-valuemax') !== max) trk.setAttribute('aria-valuemax', max);
            }
            if (state.panelOpen && state.tab === '歌词') syncLyricHighlight();
        };
        const progressLoop = () => {
            progressTimer = null;
            if (state.destroyed) return;
            renderProgress();
            if (app.isPlaying && !document.hidden) progressTimer = later(progressLoop, PROGRESS_TICK_MS);
        };
        const kickProgress = () => {
            if (progressTimer) cancel(progressTimer);
            progressTimer = null;
            progressLoop();
            syncExpanded();
        };

        const seekFromPointer = (trk, clientX, rect = null) => {
            const box = rect || trk.getBoundingClientRect();
            const d = duration();
            if (!(d > 0) || box.width <= 0) return null;
            // 按 renderProgress 同一个区间反算（起点是曲名左缘，终点在音量键前）。
            const [a, b] = progressRange();
            const fraction = Math.min(1, Math.max(0, ((clientX - box.left) / box.width - a) / (b - a)));
            return fraction * d;
        };
        for (const trk of el.tracks) {
            // 进度条是独立的一条细轨（贴在播放条下沿，从歌名左缘到右边按钮前）：
            // 按下就跳到那里、按住拖动跟手，松手才真正跳；悬停时轨道变粗，指针上方显示那一点的时间。
            // 它不和面板开关共用任何东西，面板开着也照样能拖。
            const paintTip = (clientX, preRect = null) => {
                // 单次读取 trk.getBoundingClientRect() 并返回计算出的时间，避免悬停/拖动每帧 2-3 次同步重排
                const rect = preRect || trk.getBoundingClientRect();
                const time = seekFromPointer(trk, clientX, rect);
                if (time === null || !el.seekTip) { trk.classList.remove('md-tipon'); return null; }
                el.seekTip.textContent = formatClock(time);
                el.seekTip.style.left = `${Math.round(clientX - rect.left)}px`;
                trk.classList.add('md-tipon');
                return time;
            };
            listen(trk, 'pointerdown', (event) => {
                if (event.button !== 0) return;
                const rect = trk.getBoundingClientRect();
                const time = seekFromPointer(trk, event.clientX, rect);
                if (time === null) return;
                event.preventDefault();
                event.stopPropagation();
                trk.setPointerCapture?.(event.pointerId);
                state.dragging = { time, trk, pointerId: event.pointerId };
                trk.classList.add('md-held');
                paintTip(event.clientX, rect);
                syncExpanded();
                renderProgress();
            });
            listen(trk, 'pointermove', (event) => {
                let time = null;
                if (event.pointerType !== 'touch' || state.dragging) time = paintTip(event.clientX);
                if (!state.dragging || state.dragging.trk !== trk) return;
                if (time === null) time = seekFromPointer(trk, event.clientX);
                if (time === null) return;
                state.dragging.time = time;
                renderProgress();
            });
            listen(trk, 'pointerleave', () => { if (!state.dragging) trk.classList.remove('md-tipon'); });
            const finish = (event, commit) => {
                trk.releasePointerCapture?.(event.pointerId);
                if (!state.dragging || state.dragging.trk !== trk) return;
                const { time } = state.dragging;
                state.dragging = null;
                trk.classList.remove('md-held');
                if (!trk.matches(':hover')) trk.classList.remove('md-tipon');
                if (commit) app.seekTo?.(time);
                kickProgress();
            };
            listen(trk, 'pointerup', (event) => finish(event, true));
            listen(trk, 'pointercancel', (event) => finish(event, false));
            listen(trk, 'click', (event) => event.stopPropagation());
            listen(trk, 'keydown', (event) => {
                const d = duration();
                if (!(d > 0)) return;
                const step = event.shiftKey ? 15 : 5;
                let target = null;
                if (event.key === 'ArrowLeft') target = currentTime() - step;
                else if (event.key === 'ArrowRight') target = currentTime() + step;
                else if (event.key === 'Home') target = 0;
                else if (event.key === 'End') target = Math.max(0, d - 1);
                if (target === null) return;
                event.preventDefault();
                app.seekTo?.(Math.min(d, Math.max(0, target)));
                kickProgress();
            });
        }

        // ───────── 胶囊悬停与快捷行 ─────────
        // 快捷行从播放条右端的「更多」上方长出来：指针停在「更多」上，或者点它、键盘聚焦到它，就展开；
        // 指针离开底栏、按 Esc、点别处就收回去。点过「更多」算钉住，指针离开也不收。
        let quickPinned = false;
        const setQuick = (show, { pin = false } = {}) => {
            show = Boolean(show);
            quickPinned = show && (pin || quickPinned);
            if (el.quick.classList.contains('md-show') === show) return;
            el.quick.classList.toggle('md-show', show);
            el.more.setAttribute('aria-expanded', String(show));
            el.more.classList.toggle('md-on', show);
            if (!show && state.volOpen) setVolumeOpen(false);
            fluid?.setQuick(show, show ? el.quickGroup.getBoundingClientRect() : null);
            if (show && !state.panelOpen) schedulePrebuild();
        };
        // ───────── 定时关闭 ─────────
        // 逻辑在 music-sleep.js（app.sleepTimer）；这里只画入口：控制页第三块开关、展开的时长选项、底栏上的剩余时间。
        // 接口不在时什么都不出现。提示条由 music-sleep.js 自己弹，这里不重复。
        const SLEEP_CHOICES = Object.freeze([['off', '关'], ['15', '15 分钟'], ['30', '30 分钟'], ['45', '45 分钟'], ['60', '60 分钟'], ['90', '90 分钟'], ['track', '播完这首']]);
        const sleepAvailable = () => typeof app.sleepTimer?.state === 'function';
        const sleepState = () => { try { return app.sleepTimer.state() || { mode: 'off' }; } catch (e) { return { mode: 'off' }; } };
        const sleepClock = (sec) => {
            const s = Math.max(0, Math.round(Number(sec) || 0));
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const r = s % 60;
            return h ? `${h}:${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r}` : `${m}:${r < 10 ? '0' : ''}${r}`;
        };
        const sleepText = (st) => st.mode === 'time' ? `${sleepClock(st.remaining)} 后停` : st.mode === 'track' ? '播完这首停' : '定时关闭';
        const sleepTileHtml = () => {
            const st = sleepState();
            const on = st.mode !== 'off';
            return `<button class="md-tile${on ? ' md-lit' : ''}" type="button" data-act="sleep-pick" aria-expanded="${state.sleepOpen}" aria-controls="music-dock-sleep" aria-label="定时关闭：${on ? sleepText(st) : '关'}">`
                + `<span class="md-ti">${icon('moon', 18)}</span><span class="md-slp-v">${sleepText(st)}</span></button>`;
        };
        const sleepChipsHtml = () => {
            const st = sleepState();
            const cur = st.mode === 'track' ? 'track' : st.mode === 'off' ? 'off' : '';
            return `<div class="md-slp" id="music-dock-sleep" role="group" aria-label="定时关闭">${SLEEP_CHOICES.map(([v, label]) => (
                `<button class="md-chip${v === cur ? ' md-lit' : ''}" type="button" data-act="sleep-set" data-v="${v}" aria-pressed="${v === cur}">${label}</button>`
            )).join('')}</div>`;
        };
        // 倒计时只改文字，不重画整页（不打断正在点的东西）
        const paintSleep = () => {
            if (!el.sleep || !sleepAvailable()) return;
            const st = sleepState();
            const on = st.mode !== 'off';
            if (el.sleep.hidden !== !on) { el.sleep.hidden = !on; cachedRange = null; }
            if (on) {
                const text = st.mode === 'time' ? sleepClock(st.remaining) : '本曲';
                if (el.sleepT.textContent !== text) el.sleepT.textContent = text;
                el.sleep.title = `${sleepText(st)}：点一下调整`;
                el.sleep.setAttribute('aria-label', `定时关闭，${sleepText(st)}`);
            }
            const tile = el.body.querySelector('[data-act="sleep-pick"]');
            if (tile) {
                tile.classList.toggle('md-lit', on);
                const v = tile.querySelector('.md-slp-v');
                if (v && v.textContent !== sleepText(st)) v.textContent = sleepText(st);
            }
            const chips = el.body.querySelector('.md-slp');
            if (chips) {
                const cur = st.mode === 'track' ? 'track' : st.mode === 'off' ? 'off' : '';
                chips.querySelectorAll('[data-v]').forEach((b) => { const lit = b.dataset.v === cur; b.classList.toggle('md-lit', lit); b.setAttribute('aria-pressed', String(lit)); });
            }
        };
        if (el.sleep) {
            listen(document, 'music-sleep-change', paintSleep);
            listen(el.sleep, 'click', (event) => {
                // 底栏上的剩余时间：点一下打开控制页，时长选项直接展开
                event.stopPropagation();
                openPanel('控制');
                state.sleepOpen = true;
                renderBody();
                const chips = el.body.querySelector('.md-slp');
                if (chips) global.MusicFluid?.bud(chips, el.sleep, { duration: 460 });
            });
        }

        // ───────── 喜欢 ─────────
        // 心形：喜欢的接口在（music-likes.js）才显示。点一下切换，点亮时像一滴液体鼓起来、外面荡开一圈；
        // 别处（档案菜单、快捷键）改了喜欢，靠 music-like-change 同步。
        const likeAvailable = () => typeof app.isLiked === 'function' && typeof app.toggleLike === 'function';
        let lastLike = '';
        const paintLike = () => {
            if (!el.like) return;
            const ok = likeAvailable(), track = currentTrack(), liked = Boolean(ok && track && app.isLiked(track));
            const sig = `${+ok}${+Boolean(track)}${+liked}`;
            if (sig === lastLike) return;
            lastLike = sig;
            const b = el.like;
            if (b.hidden !== !ok) b.hidden = !ok;
            if (!ok) return;
            b.disabled = !track;
            b.classList.toggle('md-liked', liked);
            b.setAttribute('aria-pressed', String(liked));
            b.setAttribute('aria-label', liked ? '取消喜欢' : '喜欢');
            b.title = liked ? '取消喜欢（L）' : '喜欢（L）';
        };
        let likePopRaf = 0, slideRaf = 0, bootRaf = 0, volRef = null;
        const cRaf = (id) => { if (id) global.cancelAnimationFrame?.(id); };
        const toggleCurrentLike = () => {
            const track = currentTrack();
            if (!track || !likeAvailable()) return;
            const willLike = !app.isLiked(track);
            app.toggleLike(track);
            paintLike();
            if (willLike && !document.body.classList.contains('music-reduce-motion')) {
                cRaf(likePopRaf); likePopRaf = 0;
                if (el.like.classList.contains('md-like-pop')) {
                    el.like.classList.remove('md-like-pop');
                    likePopRaf = requestAnimationFrame(() => { likePopRaf = 0; if (!state.destroyed) el.like.classList.add('md-like-pop'); });
                } else el.like.classList.add('md-like-pop');
            }
        };
        if (el.like) {
            listen(el.like, 'click', (event) => { event.stopPropagation(); toggleCurrentLike(); });
            listen(el.like, 'animationend', () => el.like.classList.remove('md-like-pop'));
            listen(document, 'music-like-change', paintLike);
        }

        listen(el.more, 'pointerenter', (event) => {
            if (event.pointerType === 'touch') return;
            if (!dwellTimer) dwellTimer = later(() => { dwellTimer = null; setQuick(true); }, QUICK_DWELL_MS);
        });
        listen(el.more, 'pointerleave', () => { cancel(dwellTimer); dwellTimer = null; });
        listen(el.more, 'click', (event) => {
            event.stopPropagation();
            cancel(dwellTimer); dwellTimer = null;
            const open = el.quick.classList.contains('md-show');
            if (open && quickPinned) setQuick(false); else setQuick(true, { pin: true });
        });
        listen(el.more, 'keydown', (event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            setQuick(true, { pin: true });
            el.quickGroup.querySelector('button')?.focus();
        });
        listen(el.quick, 'keydown', (event) => {
            if (event.key !== 'Escape' || state.volOpen) return;
            event.stopPropagation();
            setQuick(false);
            el.more.focus();
        });
        listen(document, 'pointerdown', (event) => {
            if (!quickPinned) return;
            const t = event.target;
            if (el.quick.contains(t) || el.more.contains(t) || el.vrail.contains(t)) return;
            setQuick(false);
        });
        listen(el.cap, 'pointerenter', (event) => {
            if (event.pointerType === 'touch') return;
            cancel(collapseTimer); collapseTimer = null;
            if (!state.hover && !expandTimer) {
                expandTimer = later(() => {
                    expandTimer = null;
                    state.hover = true;
                    syncExpanded();
                }, HOVER_EXPAND_MS);
            }
        });
        listen(el.cap, 'pointermove', (event) => {
            if (event.pointerType === 'touch') return;
            fluid?.pointer(event.clientX);
        });
        listen(el.cap, 'pointerleave', () => fluid?.pointer(null));
        // 指针在底栏上时，窗口即使没有焦点（比如刚从别的窗口移过来）也让流体层照常播过渡，悬停不会一下跳变。
        let attendTimer = null;
        listen(el.dockIn, 'pointerenter', () => { cancel(attendTimer); attendTimer = null; fluid?.setAttended?.(true); });
        listen(el.dockIn, 'pointerleave', () => {
            cancel(attendTimer);
            attendTimer = later(() => { attendTimer = null; fluid?.setAttended?.(false); }, 2500);
        });
        listen(el.dockIn, 'pointerleave', () => {
            cancel(expandTimer); expandTimer = null;
            cancel(dwellTimer); dwellTimer = null;
            if (!quickPinned && !state.volDrag) setQuick(false);
            if (!state.hover || collapseTimer) return;
            collapseTimer = later(() => {
                collapseTimer = null;
                state.hover = false;
                syncExpanded();
            }, HOVER_COLLAPSE_MS);
        });
        const remainTitle = () => (remainMode ? '点一下换回总时长' : '点一下换成剩余时间');
        for (const node of el.t2) {
            node.style.cursor = 'pointer';
            node.title = remainTitle();
            listen(node, 'click', (event) => {
                event.stopPropagation();
                remainMode = !remainMode;
                try { global.localStorage?.setItem('musicDockRemain', remainMode ? '1' : '0'); } catch (e) {}
                for (const n of el.t2) n.title = remainTitle();
                renderProgress();
            });
        }
        // 右键胶囊（按钮以外）：档案页里飞到正在播放的那首、目录滚到那一行；舞台里或经典视图里不拦，照旧。
        listen(el.cap, 'contextmenu', (event) => {
            if (event.target.closest('button') || stageActive() || el.cap.classList.contains('md-notrack')) return;
            const view = app.archiveView;
            if (!view || view.mode !== 'archive' || typeof view.locatePlaying !== 'function') return;
            event.preventDefault();
            event.stopPropagation();
            view.locatePlaying();
        });
        // 点播放条空白处不再进舞台（不直观，容易误触）；进舞台走右边的舞台按钮。

        const quickActions = { queue: () => openPanel('播放列表'), fx: () => openSheet() };
        const renderQuick = () => {};
        listen(el.quickGroup, 'click', (event) => {
            const button = event.target.closest('[data-q]');
            if (!button) return;
            event.stopPropagation();
            setQuick(false);
            quickActions[button.dataset.q]?.();
        });

        // ───────── 播放按钮、切歌、两个槽位 ─────────
        const renderPlay = () => {
            const p = app.isPlaying === true, on = p ? '1' : '0';
            if (el.play.dataset.on === on) return;
            el.play.innerHTML = p ? icon('pause', 20, { fill: 'currentColor' }) : `<span class="md-play-nudge">${icon('play', 20, { fill: 'currentColor' })}</span>`;
            el.play.setAttribute('aria-label', p ? '暂停' : '播放');
            el.play.dataset.on = on;
        };
        listen(el.play, 'click', (event) => {
            event.stopPropagation();
            // 加载中按「想不想播」切换，和主按钮、舞台空格一致。
            if (app.toggleTransport) app.toggleTransport();
            else if (app.isPlaying) app.pauseTrack?.();
            else app.playTrack?.();
        });

        // 歌名那一行只在调音量时借位显示「音量 55%」；以前悬停左右两边会换成上一首 / 下一首的名字（「回到开头」），
        // 读起来像歌名变了，去掉了。
        const showPreview = (track, label) => {
            el.tnav.classList.toggle('md-previewing', Boolean(track || label));
            if (label) el.preview.textContent = label;
            else if (track) el.preview.textContent = trackTitle(track);
        };
        // 放了 3 秒以上时「上一首」先回到本曲开头（播放器的规则），按钮提示照实说。
        const prevRestarts = () => app.prevRestarts?.() === true;
        listen(el.prev, 'pointerenter', () => { el.prev.title = prevRestarts() ? '回到本曲开头（再按一次是上一首）' : '上一首'; });
        el.prev.title = '上一首';
        el.next.title = '下一首';

        const slideTitle = (dir) => {
            if (reducedMotion?.matches) return;
            const s = el.cur.style;
            s.transition = 'none'; s.transform = `translateX(${dir * 12}px)`; s.opacity = '0';
            cRaf(slideRaf);
            slideRaf = requestAnimationFrame(() => { slideRaf = 0; if (!state.destroyed) s.transition = s.transform = s.opacity = ''; });
        };
        listen(el.prev, 'click', (event) => { event.stopPropagation(); showPreview(null); if (!prevRestarts()) slideTitle(-1); app.prevTrack?.(); });
        listen(el.next, 'click', (event) => { event.stopPropagation(); showPreview(null); slideTitle(1); app.nextTrack?.(); });

        const cycleMode = () => {
            if (typeof app.setPlayMode === 'function') app.setPlayMode((app.currentPlayMode || 0) + 1);
            else app.modeBtn?.click();
        };
        const renderMode = () => {
            const m = playMode(), b = el.modeSlot;
            if (b.dataset.mode === m) return;
            b.dataset.mode = m;
            b.innerHTML = icon(MODE_ICONS[m] || 'repeat', 18);
            b.classList.toggle('md-on', m !== 'repeat');
            b.setAttribute('aria-label', MODE_LABELS[m] || '播放模式');
            b.title = MODE_LABELS[m] || '播放模式';
        };
        listen(el.modeSlot, 'click', (event) => { event.stopPropagation(); cycleMode(); });

        const toggleStage = () => app.stageHost?.toggle?.();
        listen(el.stageSlot, 'click', (event) => { event.stopPropagation(); toggleStage(); });
        // 胶囊右侧的音量：悬停时滚轮调（一格 5%，触控板按累计距离算），单击静音 / 恢复。
        let wheelAcc = 0;
        let vtipTimer = null;
        // 调的时候在歌名那一行借位显示「音量 55%」，停手 0.9 秒后换回歌名（胶囊会裁掉外面的气泡）。
        const flashVolume = () => {
            const v = readVolume();
            el.volSlot.classList.add('md-vshow');
            el.preview.textContent = v > 0.001 ? `音量 ${Math.round(v * 100)}%` : '已静音';
            el.tnav.classList.add('md-previewing');
            cancel(vtipTimer);
            vtipTimer = later(() => {
                vtipTimer = null;
                el.volSlot.classList.remove('md-vshow');
                el.tnav.classList.remove('md-previewing');
            }, 900);
        };
        listen(el.volSlot, 'click', (event) => { event.stopPropagation(); toggleMute(); flashVolume(); });
        // 悬停音量键一会儿（或者在上面滚轮）：音量像一滴水从播放条里分裂上去，里面是一根竖着的音量条，可以拖。
        let volOpenTimer = null;
        let volCloseTimer = null;
        const placeRail = () => {
            const slot = el.volSlot.getBoundingClientRect();
            const box = el.dockIn.getBoundingClientRect();
            const bar = el.cap.getBoundingClientRect();
            if (!slot.width) return;
            el.vrail.style.left = `${Math.round(slot.left + slot.width / 2 - box.left)}px`;
            el.vrail.style.bottom = `${Math.round(box.bottom - Math.min(bar.top, slot.top - 4) + 16)}px`;
        };
        const setVolumeOpen = (open) => {
            cancel(volOpenTimer); volOpenTimer = null;
            if (open) { cancel(volCloseTimer); volCloseTimer = null; }
            if (state.volOpen === open) return;
            state.volOpen = open;
            if (open) placeRail();
            host.classList.toggle('md-vopen', open);
            el.vrail.setAttribute('aria-hidden', String(!open));
            el.vrail.tabIndex = open ? 0 : -1;
            el.volSlot.setAttribute('aria-expanded', String(open));
            fluid?.setVolumeOpen(open);
        };
        const scheduleVolumeClose = () => {
            if (volCloseTimer || state.volDrag) return;
            volCloseTimer = later(() => { volCloseTimer = null; setVolumeOpen(false); }, 600);
        };
        listen(el.volSlot, 'pointerenter', (event) => {
            if (event.pointerType === 'touch') return;
            cancel(volCloseTimer); volCloseTimer = null;
            if (!state.volOpen && !volOpenTimer) volOpenTimer = later(() => setVolumeOpen(true), 280);
        });
        listen(el.volSlot, 'pointerleave', () => { cancel(volOpenTimer); volOpenTimer = null; if (state.volOpen) scheduleVolumeClose(); });
        listen(el.vrail, 'pointerenter', () => { cancel(volCloseTimer); volCloseTimer = null; });
        listen(el.vrail, 'pointerleave', () => scheduleVolumeClose());
        const volumeFromRail = (clientY) => {
            const rect = el.vrail.getBoundingClientRect();
            if (!(rect.height > 0)) return readVolume();
            return Math.round(Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height)) * 100) / 100;
        };
        listen(el.vrail, 'pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            el.vrail.setPointerCapture?.(event.pointerId);
            state.volDrag = true;
            setVolume(volumeFromRail(event.clientY));
            flashVolume();
        });
        listen(el.vrail, 'pointermove', (event) => {
            if (!state.volDrag) return;
            setVolume(volumeFromRail(event.clientY));
            flashVolume();
        });
        const endVolDrag = (event) => {
            if (!state.volDrag) return;
            state.volDrag = false;
            el.vrail.releasePointerCapture?.(event.pointerId);
            if (!el.vrail.matches(':hover') && !el.volSlot.matches(':hover')) scheduleVolumeClose();
        };
        listen(el.vrail, 'pointerup', endVolDrag);
        listen(el.vrail, 'pointercancel', endVolDrag);
        listen(el.vrail, 'keydown', (event) => {
            const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 0.05 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -0.05 : 0;
            if (event.key === 'Escape') { setVolumeOpen(false); el.volSlot.focus(); event.stopPropagation(); return; }
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            setVolume(Math.round((readVolume() + delta) * 100) / 100);
            flashVolume();
        });
        listen(el.vrail, 'click', (event) => event.stopPropagation());
        listen(el.volSlot, 'wheel', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setVolumeOpen(true);
            const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 400 : 1;
            wheelAcc += (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
            const steps = Math.trunc(wheelAcc / 100); // 鼠标滚轮一格约 100px
            if (!steps) return;
            wheelAcc -= steps * 100;
            setVolume(Math.round((readVolume() - steps * 0.05) * 100) / 100);
            flashVolume();
        }, { passive: false });

        const renderStage = (skipGlow = false) => {
            const inStage = stageActive();
            host.classList.toggle('md-in-stage', inStage);
            if (!inStage) state.scenesOpen = false;
            el.stageSlot.classList.toggle('md-on', inStage);
            el.stageSlot.setAttribute('aria-pressed', String(inStage));
            el.stageSlot.title = inStage ? '离开歌词舞台' : '进入歌词舞台';
            if (!skipGlow) syncGlow();
            renderQuick();
            if (state.panelOpen && state.tab === '控制') renderBody();
        };

        // ───────── 曲目信息 ─────────
        let lastTrkSig = '', lastCv = null;
        const setT = (n, v) => { if (n.textContent !== v) n.textContent = v; };
        const renderTrack = () => {
            const track = currentTrack(), title = trackTitle(track), artist = trackArtist(track), cover = coverUrl(track), key = track?.path || '';
            paintLike(); paintSleep();
            const sig = `${key}\0${title}\0${artist}\0${cover}\0${+Boolean(track)}`;
            if (sig === lastTrkSig && key === state.trackKey) return;
            lastTrkSig = sig;
            setT(el.title, title); setT(el.artist, artist); setT(el.pTitle, title); setT(el.pArtist, artist);
            el.cap.classList.toggle('md-notrack', !track);
            if (cover !== lastCv) {
                lastCv = cover;
                el.pCover.innerHTML = cover ? '' : icon('music', 18);
                el.pCover.style.backgroundImage = cover ? `url("${cover.replace(/"/g, '%22')}")` : '';
            }
            if (key !== state.trackKey) {
                if (state.trackKey) { fluid?.split(); fluid?.dropRing(); }
                state.trackKey = key;
                if (state.noticeTrackKey && state.noticeTrackKey !== key) { global.MusicToast?.dismiss('playback'); state.noticeTrackKey = ''; }
                state.lyricIndex = -2;
                if (state.panelOpen) renderBody();
            }
        };
        listen(el.share, 'click', () => {
            if (app.shareCurrentTrack) app.shareCurrentTrack();
            else if (app.pendingTrackPath) app.api?.shareMusicTrack?.(app.pendingTrackPath);
        });

        // ───────── 音量 ─────────
        const readVolume = () => {
            const v = parseFloat(app.volumeSlider?.value);
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
        };
        function volumeIcon(v = readVolume()) {
            return v <= 0.001 ? 'volume-x' : v < 0.5 ? 'volume-1' : 'volume-2';
        }
        // 静音前的音量记下来（也存一份，重启后再点也能恢复到原来的大小）。
        const MUTE_KEY = 'musicDockVolumeBeforeMute';
        let volumeBeforeMute = (() => {
            try { const v = parseFloat(global.localStorage.getItem(MUTE_KEY)); return v > 0.001 && v <= 1 ? v : 1; } catch (error) { return 1; }
        })();
        const toggleMute = () => {
            const v = readVolume();
            if (v > 0.001) {
                volumeBeforeMute = v;
                try { global.localStorage.setItem(MUTE_KEY, String(v)); } catch (error) {}
                setVolume(0);
            } else setVolume(volumeBeforeMute || 1);
        };
        const setVolume = (value) => {
            const slider = app.volumeSlider;
            if (!slider) return;
            const v = Math.min(1, Math.max(0, value));
            slider.value = String(Math.round(v * 100) / 100);
            // 走旧滑块的 input 处理：节流发给引擎、同步舞台、保存设置都在那里。
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            renderVolume();
        };
        let lastVRail = '', lastVSlot = '';
        const renderVolume = () => {
            const v = readVolume(), pct = Math.round(v * 100), muted = v <= 0.001, name = volumeIcon(v);
            if (!volRef?.row.isConnected) {
                const row = el.body.querySelector('.md-vol'), q = (s) => row.querySelector(s);
                volRef = row ? { row, fill: q('.md-sld-fill'), kn: q('.md-sld-kn'), pct: q('.md-pct'), sld: q('.md-sld'), btn: q('[data-act="mute"]') } : null;
            }
            if (volRef) {
                const { fill, kn, pct: pe, sld, btn } = volRef;
                fill.style.transform = `scaleX(${v})`;
                kn.style.left = `calc(${v} * (100% - 16px))`;
                pe.textContent = `${pct}%`;
                sld.setAttribute('aria-valuenow', String(pct));
                if (btn.dataset.icon !== name) { btn.dataset.icon = name; btn.innerHTML = icon(name, 17); }
            }
            if (el.vfill) {
                const vs = v.toFixed(3), rk = `${vs}|${pct}|${+muted}`;
                if (rk !== lastVRail) {
                    lastVRail = rk;
                    el.vfill.style.transform = `scaleY(${vs})`;
                    el.vrail.setAttribute('aria-valuenow', String(pct));
                    el.vrail.setAttribute('aria-valuetext', muted ? '已静音' : `${pct}%`);
                }
            }
            if (el.volSlot) {
                const sk = `${name}|${pct}|${+muted}`, b = el.volSlot;
                if (sk !== lastVSlot) {
                    lastVSlot = sk;
                    if (b.dataset.icon !== name) { b.dataset.icon = name; b.innerHTML = icon(name, 18); }
                    b.setAttribute('aria-label', muted ? '取消静音' : `静音（音量 ${pct}%）`);
                    b.title = muted ? '已静音：点一下恢复（M）' : `音量 ${pct}%：滚轮调节，点一下静音（M）`;
                }
            }
        };

        // ───────── 面板 ─────────
        const segment = (attrs, options, activeIndex, extraClass = '') => (
            `<div class="md-seg ${extraClass}" ${attrs}><i class="md-mk"></i>${options.map((option, index) => (
                `<button type="button" class="${index === activeIndex ? 'md-on' : ''}" data-i="${index}"${option.aria ? ` aria-label="${option.aria}"` : ''}><span>${option.html}</span></button>`
            )).join('')}</div>`
        );
        const placeMarks = (root) => {
            const segs = root.querySelectorAll('.md-seg');
            if (!segs.length) return;
            // 先集中量全部 .md-seg 的几何位置，再统一写样式/触发滑块，避免读→写→读交替造成多次强制同步重排
            const jobs = [];
            for (const seg of segs) {
                const on = seg.querySelector('button.md-on');
                const mark = seg.querySelector('.md-mk');
                if (!on || !mark) continue;
                // 底部页签的标记是字下面一道短线，只跟字一样宽
                const label = seg.closest('.md-dockrow') ? on.querySelector('span') : null;
                const lw = label ? label.offsetWidth : 0;
                const to = lw
                    ? { left: on.offsetLeft + label.offsetLeft + lw * 0.2, width: lw * 0.6 }
                    : { left: on.offsetLeft, width: on.offsetWidth };
                jobs.push({ mark, to, key: `md-seg:${seg.dataset.act || seg.dataset.md || ''}` });
            }
            for (let i = 0; i < jobs.length; i += 1) {
                const { mark, to, key } = jobs[i];
                if (global.MusicFluid?.slide && key !== 'md-seg:') global.MusicFluid.slide(mark, to, { key });
                else { mark.style.left = `${to.left}px`; mark.style.width = `${to.width}px`; }
            }
        };

        const stageModes = () => global.MusicStageConfig?.modes || [];
        const currentStageMode = () => {
            const id = app.stageHost?.modeId;
            return stageModes().find((mode) => mode.id === id) || stageModes()[0] || null;
        };

        const facts = () => {
            const track = currentTrack();
            const ext = (track?.path || '').split('.').pop();
            const rows = [
                ['来源', track ? (/^https?:/i.test(track.path || '') ? '云端' : '本地文件') : '—'],
                ['格式', track ? [ext && ext.length <= 5 ? ext.toUpperCase() : '', track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : ''].filter(Boolean).join(' · ') || '—' : '—']
            ];
            return rows;
        };

        // 歌词页顶上一行：翻译开关、偏移 −0.5 / 当前值（点一下归零）/ +0.5。
        const lyricOffsetText = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} 秒`;
        function lyricsBar(lines) {
            const hasTranslation = lines.some((line) => line && line.translation);
            const on = app.lyricsTranslation !== false;
            const offset = Number(app.lyricOffset) || 0;
            const offsetOk = typeof app.shiftLyrics === 'function';
            return `<div class="md-qh md-lyrh"><b>歌词</b><span class="md-g"></span>`
                + (typeof app.setLyricsTranslation === 'function'
                    ? `<button class="md-chip${on ? ' md-lit' : ''}" type="button" data-act="lyr-tr" aria-pressed="${on}"${hasTranslation ? '' : ' disabled'} title="${hasTranslation ? (on ? '隐藏翻译' : '显示翻译') : '这首歌没有翻译'}">${icon('languages', 14)}<span>翻译</span></button>`
                    : '')
                + (offsetOk
                    ? `<span class="md-off" role="group" aria-label="歌词偏移">`
                        + `<button class="md-ib md-s" type="button" data-act="lyr-off" data-d="-0.5" aria-label="歌词提前 0.5 秒" title="歌词提前 0.5 秒">${icon('minus', 14)}</button>`
                        + `<button class="md-offv${offset ? ' md-lit' : ''}" type="button" data-act="lyr-off0" title="${offset ? '点一下归零' : '歌词偏移'}" aria-label="歌词偏移 ${lyricOffsetText(offset)}${offset ? '，点一下归零' : ''}">${lyricOffsetText(offset)}</button>`
                        + `<button class="md-ib md-s" type="button" data-act="lyr-off" data-d="0.5" aria-label="歌词推后 0.5 秒" title="歌词推后 0.5 秒">${icon('plus', 14)}</button>`
                        + '</span>'
                    : '')
                + '</div>';
        }

        let pendingQueueScroll = null;
        function renderBody(deferQueueScroll = false) {
            pendingQueueScroll = null;
            queuePage.dropPrebuilt();
            const existingScroller = el.body.querySelector('.md-ql');
            const keepScroll = state.tab === '播放列表' && existingScroller ? existingScroller.scrollTop : null;
            if (existingScroller) queuePage.recycleScroller?.(existingScroller);
            const tab = state.tab;
            let html = '';
            if (tab === '控制') {
                const v = readVolume();
                const mode = playMode();
                const inStage = stageActive();
                const scene = inStage ? currentStageMode() : null;
                html += `<div class="md-vol"><button class="md-ib md-m" type="button" data-act="mute" data-icon="${volumeIcon(v)}" aria-label="静音">${icon(volumeIcon(v), 17)}</button>`
                    + `<div class="md-sld" role="slider" tabindex="0" aria-label="音量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v * 100)}"><span class="md-sld-tr"><i class="md-sld-fill" style="transform:scaleX(${v})"></i></span><span class="md-sld-kn" style="left:calc(${v} * (100% - 16px))"></span></div>`
                    + `<span class="md-pct">${Math.round(v * 100)}%</span></div>`;
                const sleepOn = sleepAvailable();
                const tileCount = 1 + Number(inStage) + Number(sleepOn);
                html += `<div class="md-tiles md-tiles-${tileCount}">`
                    + `<button class="md-tile${mode !== 'repeat' ? ' md-lit' : ''}" type="button" data-act="mode"><span class="md-ti">${icon(MODE_ICONS[mode] || 'repeat', 18)}</span><span>${MODE_LABELS[mode] || '播放模式'}</span></button>`
                    + (inStage ? `<button class="md-tile md-lit" type="button" data-act="stage" aria-pressed="true"><span class="md-ti">${icon('sparkle', 18)}</span><span>歌词舞台</span></button>` : '')
                    + (sleepOn ? sleepTileHtml() : '')
                    + '</div>' + (sleepOn && state.sleepOpen ? sleepChipsHtml() : '');
                if (scene) {
                    html += '<div class="md-sep"></div>';
                    // 舞台一行：左右箭头直接换；点中间在原地展开全部舞台（不再进子页）。
                    const open = state.scenesOpen;
                    html += `<div class="md-mode"><div class="md-rw"><button class="md-st" type="button" data-act="scene-step" data-d="-1" aria-label="上一个舞台">${icon('chevron-left', 14)}</button>`
                        + `<button class="md-mid${open ? ' md-open' : ''}" type="button" data-act="scene-pick" aria-expanded="${open}" aria-controls="music-dock-scenes" title="选择舞台"><span class="md-in"><span class="md-pic">${icon('clapperboard', 16)}</span>`
                        + `<span class="md-mid-tx"><span class="md-cap2">舞台</span><span class="md-val"><span>${escapeHtml(scene.label)}</span>${icon('chevron-down', 13)}</span></span></span></button>`
                        + `<button class="md-st" type="button" data-act="scene-step" data-d="1" aria-label="下一个舞台">${icon('chevron-right', 14)}</button></div>`;
                    if (open) {
                        html += `<div class="md-scn" id="music-dock-scenes" role="listbox" aria-label="选择舞台">${stageModes().map((m) => (
                            `<button class="md-scn-b${m === scene ? ' md-on' : ''}" type="button" role="option" aria-selected="${m === scene}" data-mode="${m.id}" title="${escapeHtml(m.description || '')}">${escapeHtml(m.label)}</button>`
                        )).join('')}</div>`;
                    }
                    html += '</div>';
                }
            } else if (tab === '播放列表') {
                const rows = buildQueueRows();
                const upcoming = Number.isFinite(rows.upcoming)
                    ? rows.upcoming
                    : rows.filter((r) => r.type === 'manual' || r.type === 'ctx').length;
                // 队列来自哪一组（全部曲目 / 某个歌单 / 某位歌手…），原来写在首页页脚，挪到这里
                const source = String((typeof app.playbackSourceName === 'function' && app.playbackSourceName()) || app.queueSourceName || (upcoming ? '全部曲目' : '')).trim();
                html += `<div class="md-qh"><b>播放队列</b><span>${upcoming}</span>`
                    + (source ? `<span class="md-qsrc" title="这个队列来自：${escapeHtml(source)}">来自 ${escapeHtml(source)}</span>` : '')
                    + '<span class="md-g"></span>'
                    + (rows.length > 1 ? `<button class="md-ib" type="button" data-act="q-save" aria-label="把队列存为歌单" title="把队列存为歌单">${icon('list-plus', 15)}</button>` : '')
                    + `<button class="md-ib md-s${playMode() === 'shuffle' ? ' md-lit' : ''}" type="button" data-act="shuffle" aria-label="随机播放" title="随机播放">${icon('shuffle', 15)}</button></div>`
                    + (rows.length ? `<div class="md-ql" role="list"><div class="md-ql-sizer" style="height:${rows.total}px"></div></div>` : '<p class="md-empty">队列是空的。在首页添加音乐文件夹，点一首歌就会排进来。</p>');
            } else if (tab === '封面') {
                const cover = coverUrl(currentTrack());
                html += cover
                    ? `<div class="md-bigcv"><img src="${escapeHtml(cover)}" alt="封面" decoding="async"></div>`
                    : `<div class="md-bigcv md-empty-cv">${icon('disc-3', 48, { strokeWidth: 1.4 })}</div>`;
            } else if (tab === '歌词') {
                const lines = Array.isArray(app.currentLyrics) ? app.currentLyrics : [];
                html += lyricsBar(lines);
                html += lines.length
                    ? `<div class="md-lyrl">${lines.map((line, index) => `<p data-i="${index}" data-time="${Number(line.time) || 0}">${escapeHtml(line.text || line.original || '') || '&nbsp;'}`
                        + `${line.translation ? `<small class="md-tr">${escapeHtml(line.translation)}</small>` : ''}</p>`).join('')}</div>`
                    : '<p class="md-empty">这首歌还没有歌词。</p>';
                state.lyricsSource = app.currentLyrics;
                state.lyricIndex = -2;
            } else {
                // 声音页：上面两行是这首歌的来源和格式，下面直接是全部输出与音效设置（原来的「音效设置」子页并进来了）。
                html += `<dl class="md-facts md-facts-in">${facts().map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
            }
            el.body.innerHTML = html;
            renderExt(tab === '控制');
            syncMoved(tab === '控制');
            syncFx(tab === '声音');
            if (state.panelOpen && tab !== '播放列表' && tab !== '封面' && tab !== '歌词') {
                placeMarks(el.body);
                if (tab === '控制') placeMarks(el.body2);
            }
            if (tab === '播放列表') {
                state.queueSource = activeList();
                state.queueLength = state.queueSource.length;
                const scroller = el.body.querySelector('.md-ql');
                if (scroller) {
                    const initTop = keepScroll != null ? keepScroll : Math.max(0, (state.queueRows?.nowTop || 0) - QUEUE_HEAD_H);
                    // 先把可见队列行一次性写完，再滚动（打开面板时留到 focus 之后复用同一次排版，避免连触两次整页重排）。
                    renderQueueWindow(scroller, false, { top: initTop, height: 0 });
                    if (initTop > 0) {
                        if (deferQueueScroll) pendingQueueScroll = { scroller, top: initTop };
                        else scroller.scrollTop = initTop;
                    }
                    scroller.addEventListener('scroll', () => { if (state.panelOpen) renderQueueWindow(scroller); }, { passive: true });
                    scroller.addEventListener('pointerdown', onQueuePointerDown);
                }
            }
            if (tab === '歌词') syncLyricHighlight(true);
        }

        // ───────── 播放队列页 ─────────
        // 一张表里三段：正在播放 → 手动队列（可拖动排序、移除、清空）→ 接下来会放的上下文
        // （随机时就是洗好的真实顺序）。上下文可能有上千首：只画看得见的那几行。
        const QUEUE_HEAD_H = 36;
        // 这一页的代码在 music-dock-queue.js；外框和切页在下面的 renderBody。
        const queuePage = global.MusicDockQueue.create({
            app, state, el, cleanups, listen, renderBody,
            currentTrack, activeList, playMode, trackTitle, trackArtist,
            escapeHtml, icon, QUEUE_ROW_H, QUEUE_HEAD_H
        });
        const {
            saveQueueAsPlaylist, buildQueueRows, renderQueueWindow, schedulePrebuild, prebuiltFresh,
            rerenderQueue, onQueuePointerDown, onQueueAction
        } = queuePage;

        function syncLyricHighlight(force = false) {
            const box = el.body.querySelector('.md-lyrl');
            if (!box) {
                if (state.lyricsSource !== app.currentLyrics && Array.isArray(app.currentLyrics) && app.currentLyrics.length) renderBody();
                return;
            }
            if (state.lyricsSource !== app.currentLyrics) { renderBody(); return; }
            // 当前句按进度自己算：首页（档案页）开着时经典歌词那套动画循环是停的，app.currentLyricIndex 不会往前走
            let index = typeof app.lyricIndexAt === 'function' ? app.lyricIndexAt(currentTime()) : (Number.isInteger(app.currentLyricIndex) ? app.currentLyricIndex : -1);
            // 暂停着打开（比如重开窗口停在 0:08）时歌词模块不更新当前行，这里按进度自己找一次，不然一行都不亮
            if (index < 0 && !app.isPlaying && typeof app.lyricIndexAt === 'function' && currentTime() > 0) {
                const at = app.lyricIndexAt(currentTime());
                if (Number.isInteger(at)) index = at;
            }
            if (!force && index === state.lyricIndex) return;
            box.querySelector('p.md-on')?.classList.remove('md-on');
            state.lyricIndex = index;
            const line = index >= 0 ? box.children[index] : null;
            if (!line) return;
            line.classList.add('md-on');
            // 当前那一行背后有一滴玻璃，换行时像液体往下流过去（共用套件的 slide，竖着走）
            if (global.MusicFluid?.slide) {
                let drop = box.querySelector(':scope > .md-lyr-drop');
                if (!drop) { drop = document.createElement('i'); drop.className = 'md-lyr-drop'; drop.setAttribute('aria-hidden', 'true'); box.appendChild(drop); }
                global.MusicFluid.slide(drop, { top: line.offsetTop, height: line.offsetHeight }, { key: 'md-lyrics', axis: 'y', lead: 200, trail: 420 });
            }
            const scroller = el.pnl;
            const target = line.offsetTop - scroller.clientHeight / 2 + line.offsetHeight / 2;
            if (typeof scroller.scrollTo === 'function') {
                scroller.scrollTo({ top: Math.max(0, target), behavior: force || reducedMotion?.matches ? 'auto' : 'smooth' });
            } else scroller.scrollTop = Math.max(0, target);
        }

        let tabBtns = null;
        const renderTabs = (marks = true) => {
            if (!tabBtns || !el.tabs.firstChild) {
                el.tabs.innerHTML = '<i class="md-mk"></i>' + TABS.map((t, i) => `<button type="button" role="tab" aria-controls="music-dock-panel-body" data-i="${i}"><span>${t}</span></button>`).join('');
                tabBtns = el.tabs.querySelectorAll('button[data-i]');
            }
            for (let i = 0; i < TABS.length; i += 1) {
                const b = tabBtns[i], on = TABS[i] === state.tab;
                if (b._on !== on) { b._on = on; b.classList.toggle('md-on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
            }
            if (marks) placeMarks(el.pnl);
        };
        listen(el.tabs, 'click', (event) => {
            const button = event.target.closest('button[data-i]');
            if (!button) return;
            state.tab = TABS[Number(button.dataset.i)] || '控制';
            closePop();
            el.pnl.scrollTop = 0;
            el.ext.parentElement.scrollTop = 0;
            renderTabs();
            renderBody();
        });

        // 页签按 tablist 的习惯：Tab 只停在选中的那个，左右方向键 / Home / End 切换并把焦点带过去。
        listen(el.tabs, 'keydown', (event) => {
            const cur = TABS.indexOf(state.tab);
            const next = event.key === 'ArrowRight' ? (cur + 1) % TABS.length
                : event.key === 'ArrowLeft' ? (cur - 1 + TABS.length) % TABS.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
            if (next < 0 || !event.target.closest('button[data-i]')) return;
            event.preventDefault();
            event.stopPropagation();
            state.tab = TABS[next];
            closePop();
            el.pnl.scrollTop = 0;
            el.ext.parentElement.scrollTop = 0;
            renderTabs();
            renderBody();
            el.tabs.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
        });

        const onBodyClick = (event) => {
            const target = event.target.closest('[data-qact], [data-act], [data-q], [data-mode], .md-lyrl p, .md-seg button');
            if (!target) return;
            const motionSeg = target.closest('.md-seg[data-act="motion"]');
            if (motionSeg && target.matches('button[data-i]')) {
                const pref = global.MusicMotion?.PREFERENCES?.[Number(target.dataset.i)];
                if (pref) global.MusicMotion.set(pref.value);
                renderBody();
                return;
            }
            const seg = target.closest('.md-seg[data-act="theme"]');
            if (seg && target.matches('button[data-i]')) {
                const light = target.dataset.i === '0';
                app.applyTheme?.(light ? 'light' : 'dark');
                app.stageHost?.updateTheme?.();
                renderBody();
                return;
            }
            if (target.matches('.md-lyrl p')) {
                const time = Number(target.dataset.time);
                if (Number.isFinite(time)) { app.seekTo?.(Math.max(0, time)); kickProgress(); }
                return;
            }
            if (target.dataset.qact !== undefined) { onQueueAction(target); return; }
            const act = target.dataset.act;
            if (act === 'mode') { cycleMode(); }
            else if (act === 'stage') { toggleStage(); }
            else if (act === 'intro') { closePanel(); global.MusicIntro?.replay?.(); }
            else if (act === 'lyr-tr') { app.setLyricsTranslation?.(app.lyricsTranslation === false); renderBody(); }
            else if (act === 'lyr-off') { app.shiftLyrics?.(Number(target.dataset.d) || 0); renderBody(); }
            else if (act === 'lyr-off0') { app.setLyricOffset?.(0); renderBody(); }
            else if (act === 'q-save') saveQueueAsPlaylist();
            else if (act === 'shuffle') { app.setPlayMode?.(playMode() === 'shuffle' ? 'repeat' : 'shuffle'); }
            else if (act === 'mute') {
                toggleMute();
            } else if (act === 'scene-step') {
                const modes = stageModes();
                const cur = modes.indexOf(currentStageMode());
                const next = modes[(cur + Number(target.dataset.d) + modes.length) % modes.length];
                if (next) app.stageHost?.setMode?.(next.id);
                syncGlow();
                renderBody();
            } else if (act === 'sleep-pick') {
                state.sleepOpen = !state.sleepOpen;
                renderBody();
                const pick = el.body.querySelector('[data-act="sleep-pick"]');
                pick?.focus({ preventScroll: true });
                const chips = state.sleepOpen && el.body.querySelector('.md-slp');
                if (chips && pick) global.MusicFluid?.bud(chips, pick, { duration: 400 });
            } else if (act === 'sleep-set') {
                const v = target.dataset.v;
                if (v === 'off') app.sleepTimer?.cancel?.();
                else if (v === 'track') app.sleepTimer?.setTrackEnd?.();
                else app.sleepTimer?.set?.(Number(v));
                state.sleepOpen = false;
                renderBody();
                el.body.querySelector('[data-act="sleep-pick"]')?.focus({ preventScroll: true });
            } else if (act === 'scene-pick') {
                state.scenesOpen = !state.scenesOpen;
                renderBody();
                const pick = el.body.querySelector('[data-act="scene-pick"]');
                pick?.focus({ preventScroll: true });
                // 展开的舞台格子从「舞台」那颗按钮里长出来（共用套件；降低动态、节能档时只淡入）
                const grid = state.scenesOpen && el.body.querySelector('.md-scn');
                if (grid && pick) global.MusicFluid?.bud(grid, pick, { duration: 420 });
            } else if (target.dataset.mode && target.closest('.md-scn')) {
                app.stageHost?.setMode?.(target.dataset.mode);
                syncGlow();
                renderBody();
                el.body.querySelector('.md-scn-b.md-on')?.focus({ preventScroll: true });
            }
        };
        listen(el.body, 'click', onBodyClick);
        listen(el.ext, 'click', onBodyClick);

        // 音量滑块：按下即跳到指针位置，拖动跟手，键盘左右 5%。
        listen(el.body, 'pointerdown', (event) => {
            const slider = event.target.closest('.md-sld');
            if (!slider || event.button !== 0) return;
            event.preventDefault();
            slider.setPointerCapture?.(event.pointerId);
            slider.classList.add('md-held');
            let cachedRect = slider.getBoundingClientRect();
            const apply = (clientX) => {
                if (!cachedRect || cachedRect.width <= 0) cachedRect = slider.getBoundingClientRect();
                setVolume((clientX - cachedRect.left - 8) / Math.max(1, cachedRect.width - 16));
            };
            apply(event.clientX);
            const move = (ev) => apply(ev.clientX);
            const up = () => {
                slider.classList.remove('md-held');
                slider.removeEventListener('pointermove', move);
                slider.removeEventListener('pointerup', up);
                slider.removeEventListener('pointercancel', up);
            };
            slider.addEventListener('pointermove', move);
            slider.addEventListener('pointerup', up);
            slider.addEventListener('pointercancel', up);
        });
        listen(el.body, 'keydown', (event) => {
            if (!event.target.matches('.md-sld')) return;
            const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -0.05
                : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 0.05 : 0;
            if (!delta) return;
            event.preventDefault();
            setVolume(readVolume() + delta);
        });

        // 目录和歌词同时打开时，播放条与中间卡片共用一条中线。只有目录或抽屉时，仍按它的边界让位。
        const DRAWER_W = 400;
        const LIST_BAR_MAX = 600;   // 目录开着时播放条最长到这里，比平时短一截
        const LIST_GAP = 24;        // 和目录右缘之间留的空
        const DRAWER_LYRICS_GAP = 12;   // 抽屉顶开歌词时，文字左侧本身还有内边距。
        const archiveEdges = (vw) => {
            if (vw < COMPACT_BELOW || stageActive() || app.archiveView?.mode !== 'archive') return null;
            const view = document.getElementById('music-archive-view');
            if (!view) return null;
            const hud = view.querySelector('.archive-hud');
            if (!hud || !hud.offsetWidth) return null;
            hookHud(hud);
            const list = hud.classList.contains('list-open') ? hud.querySelector('.archive-list:not([hidden])') : null;
            const lyrics = hud.classList.contains('lyrics-open') && !hud.classList.contains('tiny')
                ? hud.querySelector('.archive-lyrics') : null;
            // 用布局位置避开目录和歌词的入场动画，再按 HUD 的缩放换算到窗口坐标。
            const rect = hud.getBoundingClientRect();
            const scale = rect.width / hud.offsetWidth;
            return {
                listRight: list ? rect.left + (list.offsetLeft + list.offsetWidth) * scale : 0,
                lyricsLeft: lyrics ? rect.left + lyrics.offsetLeft * scale : 0
            };
        };
        // 目录开合、进出舞台、首页和经典视图来回切：都要重新排播放条。合到下一帧一起算。
        let shiftFrame = 0;
        const queueShift = () => {
            if (shiftFrame || state.destroyed) return;
            shiftFrame = requestAnimationFrame(() => { shiftFrame = 0; if (!state.destroyed) syncShift(); });
        };
        let hookedHud = null;
        let hudObserver = null;
        function hookHud(hud) {
            if (!hud || hud === hookedHud) return;
            hookedHud = hud;
            hudObserver?.disconnect();
            hudObserver = new MutationObserver(queueShift);
            hudObserver.observe(hud, { attributes: true, attributeFilter: ['class', 'style'] });
        }
        cleanups.push(() => { cancelAnimationFrame(shiftFrame); hudObserver?.disconnect(); hudObserver = null; document.body.classList.remove('music-dock-beside-list', 'music-dock-beside-lyrics', 'music-drawer-open'); });
        let roomRight = 0;
        let widthTimer = 0;
        const followWidth = () => {
            // 宽度有 CSS 过渡；流体层跟随实际宽度变化更新，连续稳定后提前结束循环
            if (!fluid) return;
            cancelAnimationFrame(widthTimer);
            const noAnim = document.hidden || Boolean(global.MusicMotion ? global.MusicMotion.reduced() : reducedMotion.matches)
                || document.body.classList.contains('music-reduce-motion');
            if (noAnim) {
                widthTimer = requestAnimationFrame(() => {
                    widthTimer = 0;
                    if (!state.destroyed) fluid.layout();
                });
                return;
            }
            const end = performance.now() + 560;
            let prevW = -1;
            let steady = 0;
            const step = () => {
                if (state.destroyed || document.hidden) { widthTimer = 0; return; }
                const w = el.cap.offsetWidth;
                if (Math.abs(w - prevW) >= 0.5) {
                    prevW = w;
                    steady = 0;
                    fluid.layout();
                } else {
                    steady++;
                }
                if (steady < 4 && performance.now() < end && !state.destroyed) {
                    widthTimer = requestAnimationFrame(step);
                } else {
                    widthTimer = 0;
                    if (!state.destroyed && steady < 4) fluid.layout();
                }
            };
            widthTimer = requestAnimationFrame(step);
        };
        let mistLayoutRaf = 0;
        const scheduleFluidLayout = () => {
            if (!fluid || mistLayoutRaf || state.destroyed) return;
            mistLayoutRaf = requestAnimationFrame(() => {
                mistLayoutRaf = 0;
                if (!state.destroyed) fluid?.layout();
            });
        };
        cleanups.push(() => { cancelAnimationFrame(widthTimer); cancelAnimationFrame(mistLayoutRaf); mistLayoutRaf = 0; });
        const syncShift = (preEdges) => {
            const vw = global.innerWidth || 0;
            const natural = Math.min(640, Math.max(0, vw - 32)); // 和 CSS 的 --md-bar-w 同一个算式
            const open = state.panelOpen && vw >= COMPACT_BELOW;
            const { listRight = 0, lyricsLeft = 0 } = (preEdges !== undefined ? preEdges : archiveEdges(vw)) || {};
            const edge = listRight > 0 && listRight < vw * 0.5 ? listRight : 0;
            const betweenPanes = listRight > 0 && lyricsLeft > listRight;
            const lo = edge ? edge + LIST_GAP : 12;
            const lyricsClearance = open ? DRAWER_LYRICS_GAP : LIST_GAP;
            const drawerEdge = open ? vw - DRAWER_W - LIST_GAP : vw - (edge ? LIST_GAP : 12);
            // 分栏较紧时，让播放条稍往左，避免整条歌词栏为它让出底部空间。
            let room = open && lyricsLeft ? Math.min(drawerEdge, lyricsLeft - lyricsClearance) : drawerEdge;
            // 目录和抽屉都开着、中间连最短的播放条（280）都放不下（如 960 宽）：抽屉底边抬到播放条上面，
            // 播放条从抽屉下面过，只给右下角的关闭小环让出位置。不这样的话歌名和按钮会压在抽屉底部的页签上。
            const raise = open && !betweenPanes && room - lo < 280;
            if (raise) room = vw - 72;
            host.classList.toggle('md-raise', raise);
            const span = room - lo;
            let barW = natural;
            let left = vw / 2 - natural / 2;
            if (betweenPanes) {
                const center = (listRight + lyricsLeft) / 2;
                barW = Math.max(280, Math.min(natural, LIST_BAR_MAX, lyricsLeft - listRight - 2 * LIST_GAP));
                left = Math.max(12, Math.min(center - barW / 2, room - barW));
            } else if (edge) {
                // 只打开目录时，放在剩下那段的正中。
                barW = Math.max(280, Math.min(natural, LIST_BAR_MAX, span));
                left = span >= barW ? lo + (span - barW) / 2 : lo;
            } else if (open) {
                // 只有抽屉：窗口不够宽、让位以后会被挤出左边，就把播放条收窄（最窄 280）
                if (natural > room - 12) barW = Math.max(280, room - 12);
                // 左缘至少留 12px；实在放不下（窗口很窄）就让抽屉盖住右端，不往左边挤出去。
                left = vw / 2 - barW / 2 + Math.max(12 - (vw / 2 - barW / 2), Math.min(0, room - (vw / 2 + barW / 2)));
            }
            const resized = barW < natural - 0.5;
            const squeezed = resized && barW < 520;               // 太短才收掉「下一首」
            const barTarget = el.dock || host;
            const was = barTarget.style.getPropertyValue('--md-bar-w');
            const now = resized ? `${Math.round(barW)}px` : '';
            host.classList.toggle('md-squeeze', squeezed);
            if (was !== now) {
                if (resized) barTarget.style.setProperty('--md-bar-w', now); else barTarget.style.removeProperty('--md-bar-w');
                cachedRange = null;
                followWidth();
            }
            document.body.classList.toggle('music-dock-beside-list', betweenPanes ? left >= listRight : Boolean(edge));
            const lyricsGap = lyricsLeft - left - barW;
            document.body.classList.toggle('music-dock-beside-lyrics', lyricsGap >= lyricsClearance - 0.5);
            const mistRoom = betweenPanes ? Math.min(left - listRight, lyricsGap) : left - edge;
            const mistPad = betweenPanes || edge ? `${Math.round(Math.max(0, mistRoom))}px` : '';
            const mistChanged = lastMistPad !== mistPad;
            if (mistChanged) {
                lastMistPad = mistPad;
                fluid?.setMistPad?.(mistPad);
            }
            // 首页按抽屉占掉的宽度重排（archive-view 的 resize 读 roomRight），区块让开，不被抽屉盖住
            roomRight = open ? DRAWER_W : 0;
            document.body.classList.toggle('music-drawer-open', open);
            const shift = vw > 0 && barW ? left - (vw / 2 - barW / 2) : 0;
            // 直接把 --md-shift 写到实际平移的 4 个元素上（而非 #music-dock-root），避免继承链触发抽屉/音效/命令面板 365+ 节点样式重算
            const shiftStr = `${Math.round(shift)}px`;
            if (shiftStr !== lastShiftStr) {
                lastShiftStr = shiftStr;
                applyShiftProp(shiftStr);
            }
            // 等 --md-bar-w / mistPad / --md-shift 全部写完后在下一帧重排流体层，避免写完立刻 getComputedStyle 同步回流
            if (mistChanged) scheduleFluidLayout();
            // 提示层挂在 body 上：跟着播放条的中心走，宽度不伸进抽屉。
            const cx = vw / 2 + shift;
            const rightLimit = (open ? vw - DRAWER_W : vw) - 8;
            const maxW = Math.max(200, 2 * Math.min(cx - 8, rightLimit - cx));
            if (vw > 0) placeToasts(Math.round(cx), Math.round(maxW));
        };
        // 直接更新 .mtst-layer 自身行内变量，避免每次开关抽屉重写 <style> 触发整页样式表失效重算。
        let toastPos = null;
        let toastSheet = '';
        const placeToasts = (x, w) => {
            if (typeof global.MusicToast?.setPosition === 'function') {
                global.MusicToast.setPosition(x, w);
                return;
            }
            const text = `.mtst-layer{--md-toast-x:${x}px;--md-toast-max:${w}px}`;
            if (text === toastSheet) return;
            toastSheet = text;
            if (!toastPos || !toastPos.isConnected) {
                toastPos = document.createElement('style');
                toastPos.dataset.md = 'toast-pos';
                document.head.appendChild(toastPos);
            }
            toastPos.textContent = text;
        };
        cleanups.push(() => { toastPos?.remove(); toastPos = null; toastSheet = ''; });
        let panelReturn = null;
        let openMarksRaf = 0;
        cleanups.push(() => { if (openMarksRaf) { cancelAnimationFrame(openMarksRaf); openMarksRaf = 0; } });
        // 开关面板时会用脚本挪焦点；用鼠标开关的不该亮出焦点框（还回去的那颗按钮上会出现一个粗框），只有键盘操作才显示
        let lastKeyboard = false;
        const markInput = (kbd) => { lastKeyboard = kbd; document.documentElement.classList.toggle('md-pointer-mode', !kbd); };
        listen(document, 'keydown', (event) => { if (event.key === 'Tab' || event.key.startsWith('Arrow') || event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') markInput(true); }, true);
        listen(document, 'pointerdown', () => markInput(false), true);
        cleanups.push(() => document.documentElement.classList.remove('md-pointer-mode'));
        function openPanel(tab) {
            if (tab) { state.tab = tab; closePop(); }
            if (!state.panelOpen) {
                // 先在任何 DOM 写入前量好档案页左右边界，避免写完 md-open 再读 hud.getBoundingClientRect 触发强制重排
                const preEdges = archiveEdges(global.innerWidth || 0);
                // 焦点进抽屉（落在当前页签上）；记住是从哪里打开的，关的时候还回去。
                const from = document.activeElement;
                panelReturn = from && from !== document.body && !el.pnl.contains(from) ? from : el.handle;
                state.panelOpen = true;
                el.pnl.classList.add('md-open');
                el.pnl.setAttribute('aria-hidden', 'false');
                // 先在 body 与 dock 仍干净时聚焦并滚动队列，再切外部类避免强制整页布局
                renderTabs(false);
                el.tabs.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true, focusVisible: lastKeyboard });
                if (!(state.tab === '播放列表' && prebuiltFresh())) renderBody(true);
                queuePage.dropPrebuilt();
                if (pendingQueueScroll) { const p = pendingQueueScroll; pendingQueueScroll = null; if (p.scroller.isConnected && p.top > 0) p.scroller.scrollTop = p.top; }
                el.hdl.classList.add('md-open');
                el.handle.setAttribute('aria-expanded', 'true'); el.handle.setAttribute('aria-label', '关闭面板');
                el.panelSlot.setAttribute('aria-expanded', 'true'); el.panelSlot.classList.add('md-on');
                host.classList.add('md-panel-open');
                fluid?.setRingDocked(false); syncShift(preEdges); syncSolid();
                if (openMarksRaf) cancelAnimationFrame(openMarksRaf);
                openMarksRaf = requestAnimationFrame(() => {
                    openMarksRaf = 0;
                    if (state.panelOpen && !state.destroyed) placeMarks(el.tabs.parentElement || el.pnl);
                });
                return;
            }
            renderTabs();
            renderBody();
        }
        function closePanel() {
            if (!state.panelOpen) return;
            if (openMarksRaf) { cancelAnimationFrame(openMarksRaf); openMarksRaf = 0; }
            const preEdges = archiveEdges(global.innerWidth || 0);
            // 在修改 body/host/panel 类之前把焦点还给目标（此时排版仍是干净的），避免写完 body 类立刻 focus() 触发整页强制样式重算
            const active = document.activeElement;
            const returnTarget = active && (el.pnl.contains(active) || active === el.handle)
                ? (panelReturn && panelReturn.isConnected ? panelReturn : el.panelSlot)
                : null;
            panelReturn = null;
            if (returnTarget) returnTarget.focus?.({ preventScroll: true, focusVisible: lastKeyboard });
            state.panelOpen = false;
            closePop();
            syncFx(false);
            syncMoved(false);
            el.pnl.classList.remove('md-open');
            el.pnl.setAttribute('aria-hidden', 'true');
            el.hdl.classList.remove('md-open');
            el.handle.setAttribute('aria-expanded', 'false');
            el.handle.setAttribute('aria-label', '打开面板');
            el.panelSlot.setAttribute('aria-expanded', 'false');
            el.panelSlot.classList.remove('md-on');
            host.classList.remove('md-panel-open');
            fluid?.setRingDocked(true);
            syncShift(preEdges);
            if (returnTarget && document.activeElement !== returnTarget) {
                returnTarget.focus?.({ preventScroll: true, focusVisible: lastKeyboard });
            }
            syncSolid();
        }
        function togglePanel() { if (state.panelOpen) closePanel(); else openPanel(); }
        // 面板关着：白环是播放头（下面这段）；面板开着：白环飞到右下角当关闭键，进度改由条下沿的细轨拖。
        // 播放条右端还有一个面板按钮，暂停时播放头沉下去也能打开面板。
        listen(el.panelSlot, 'click', (event) => { event.stopPropagation(); togglePanel(); });
        // 播放头模式下白环就是播放头：按住横向拖动超过 4px 就是拖进度，松手跳过去；不拖就是普通点击（开关面板）。
        {
            let pending = null;
            let swallow = false;
            const trk = el.tracks[0];
            listen(el.handle, 'pointerdown', (event) => {
                if (event.button !== 0 || ringMode !== 'playhead' || state.panelOpen || !trk) return;
                pending = { x: event.clientX, pointerId: event.pointerId };
                el.handle.setPointerCapture?.(event.pointerId);
            });
            listen(el.handle, 'pointermove', (event) => {
                if (!pending) return;
                if (!state.dragging && Math.abs(event.clientX - pending.x) > 4) {
                    const time = seekFromPointer(trk, event.clientX);
                    if (time === null) { pending = null; return; }
                    state.dragging = { time, trk, pointerId: pending.pointerId, fromRing: true };
                    syncExpanded();
                }
                if (!state.dragging || state.dragging.trk !== trk) return;
                const time = seekFromPointer(trk, event.clientX);
                if (time === null) return;
                state.dragging.time = time;
                renderProgress();
            });
            const finish = (event, commit) => {
                el.handle.releasePointerCapture?.(event.pointerId);
                const was = pending;
                pending = null;
                if (!was || !state.dragging || state.dragging.trk !== trk) return;
                const { time } = state.dragging;
                state.dragging = null;
                syncExpanded();
                swallow = true;
                if (commit) app.seekTo?.(time);
                kickProgress();
            };
            listen(el.handle, 'pointerup', (event) => finish(event, true));
            // 指针移到播放头上：放大成完整的环，上方显示当前时间，看得出它是播放头、可以拖。
            listen(el.handle, 'pointerenter', () => { state.ringHover = true; syncSolid(); });
            listen(el.handle, 'pointerleave', () => { state.ringHover = false; syncSolid(); });
            // 键盘：Tab 能走到播放头；左右方向键每次跳 5 秒，回车/空格照常开面板。
            listen(el.handle, 'focus', () => { state.ringKbd = el.handle.matches(':focus-visible'); syncSolid(); });
            listen(el.handle, 'blur', () => { state.ringKbd = false; syncSolid(); });
            listen(el.handle, 'keydown', (event) => {
                if (ringMode !== 'playhead' || state.panelOpen) return;
                const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                const d = duration();
                // 带修饰键的方向键留给全局快捷键（Shift + 方向键是上一首 / 下一首）。
                if (!dir || !(d > 0) || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
                event.preventDefault();
                event.stopPropagation();
                state.ringKbd = true;
                app.seekTo?.(Math.min(d, Math.max(0, currentTime() + dir * 5)));
                kickProgress();
            });
            listen(el.handle, 'pointercancel', (event) => finish(event, false));
            // 指针停在播放头上滚轮：一格跳 5 秒（往上是往后），触控板按累计距离算；只认播放头，别处滚轮不碰进度。
            // 停手 0.3 秒或换方向就清零累计，免得上一回剩下的零头吞掉下一格。
            let seekWheelAcc = 0;
            let seekWheelAt = -1e9;
            listen(el.handle, 'wheel', (event) => {
                if (ringMode !== 'playhead' || state.panelOpen || state.dragging) return;
                const d = duration();
                if (!(d > 0)) return;
                event.preventDefault();
                event.stopPropagation();
                const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 400 : 1;
                const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
                if (event.timeStamp - seekWheelAt > 300 || Math.sign(delta) !== Math.sign(seekWheelAcc)) seekWheelAcc = 0;
                seekWheelAt = event.timeStamp;
                seekWheelAcc += delta;
                const steps = Math.trunc(seekWheelAcc / 100);
                if (!steps) return;
                seekWheelAcc -= steps * 100;
                state.ringHover = true;
                syncSolid();
                app.seekTo?.(Math.min(Math.max(0, d - 0.5), Math.max(0, currentTime() - steps * 5)));
                kickProgress();
            }, { passive: false });
            listen(el.handle, 'click', (event) => {
                if (swallow) { swallow = false; event.stopImmediatePropagation(); return; }
                togglePanel();
            });
        }


        // ───────── 舞台设置：直接排在控制页里 ─────────
        // 原来舞台控制舱里的三块（当前舞台的专属设置、全局输出、演出阵列）和「恢复出厂编排」各自搬到控制页对应的位置
        // （appendChild，不重建），舞台宿主绑在上面的事件和引用都还在；原来的抽屉外壳和舞台右上角的入口按钮由 CSS 隐藏。
        // 控制页自上而下：音量 → 播放模式 / 歌词舞台 → 舞台（原地展开全部舞台）→ 这个舞台的设置 → 显示（所有舞台共用）→ 更多。
        // 这一段的代码在 music-dock-stage-settings.js。
        const stageSettings = global.MusicDockStageSettings.create({
            state, el, cleanups, listen, openPanel,
            stageActive, currentStageMode, segment, escapeHtml, icon
        });
        const { renderExt, openStageSettings } = stageSettings;
        function closePop() { state.scenesOpen = false; state.sleepOpen = false; }

        // 声音页：原来的音效卡片整块搬进来（appendChild，不重建），离开这一页或关掉面板时放回原处，事件和引用都不变。
        const dspCard = document.querySelector('.settings-container');
        const dspHome = dspCard ? { parent: dspCard.parentNode, next: dspCard.nextSibling } : null;
        let fxIn = false;
        // 声音页不用 display:none 藏：那样每次切过来都要把整张音效卡（四百来个元素）重算样式、重新排版。
        // 首页（档案页）盖住音效卡原来的位置时，卡就留在抽屉里「停着」（md-fx-park：content-visibility:hidden，
        // 不占地方但保住排版），切到声音页只是把它亮出来。经典视图要用原处的卡，才送回去。
        const archiveOn = () => document.body.classList.contains('music-archive-on');
        function syncFx(show) {
            show = Boolean(show && dspCard && state.panelOpen);
            const park = !show && Boolean(dspCard) && archiveOn();
            el.fxScroll.hidden = !show && !park;
            el.fxScroll.classList.toggle('md-fx-park', park);
            const inDrawer = show || park;
            if (inDrawer === fxIn) return;
            fxIn = inDrawer;
            if (inDrawer) el.fxScroll.appendChild(dspCard);
            else if (dspHome?.parent) dspHome.parent.insertBefore(dspCard, dspHome.next && dspHome.next.parentNode === dspHome.parent ? dspHome.next : null);
        }
        // 音效卡里有三个开关和声音无关：「放完接着放相似的歌」归到控制页新开的「播放」组，「桌面歌词」「旧版界面（原版）」
        // 归到「显示」组。控制页开着时把这三行原样搬进来（appendChild，id、事件、设置键都不变），离开控制页或关面板就放回原处，
        // 所以经典视图里的音效卡照旧完整；抽屉声音页里由 CSS 不再显示这三行。
        // var：renderBody 可能在这里之前就被调用（预画），那时还没收集到这三行，直接跳过即可。
        var movedRows = [['autoplay-switch', 'play'], ['desktop-lyrics-switch', 'disp'], ['legacy-ui-switch', 'disp']]
            .map(([id, where]) => {
                const item = document.getElementById(id)?.closest('.setting-item');
                return item ? { item, where, parent: item.parentNode, next: item.nextSibling } : null;
            }).filter(Boolean);
        var movedIn = false;
        function syncMoved(show) {
            if (!movedRows) return;
            show = Boolean(show && state.panelOpen);
            if (show === movedIn) return;
            movedIn = show;
            for (const row of movedRows) {
                if (show) (row.where === 'play' ? el.playSlot : el.dispSlot).appendChild(row.item);
                else if (row.parent) row.parent.insertBefore(row.item, row.next && row.next.parentNode === row.parent ? row.next : null);
            }
            el.playSec.hidden = !(show && movedRows.some((row) => row.where === 'play'));
        }
        cleanups.push(() => syncMoved(false));
        // 「音效设置」原来是抽屉里的子页，现在就是声音页；这两个名字留给命令面板和外面的调用。
        function openSheet() { openPanel('声音'); }
        function closeSheet() { syncFx(false); }

        listen(document, 'pointerdown', (event) => {
            const t = event.target;
            if (t.closest?.('.md-cmd')) return;
            if (state.panelOpen && !el.pnl.contains(t) && !el.hdl.contains(t)
                && !t.closest?.('.custom-select-dropdown, select, option, [data-q="fx"]')
                && !el.quick.contains(t) && !t.closest?.('.md-cap')) closePanel();
        }, true);
        listen(document, 'keydown', (event) => {
            if (event.key !== 'Escape' || event.target?.closest?.('.md-cmd') || palette?.isOpen) return;
            if (state.sleepOpen && !state.scenesOpen) { closePop(); renderBody(); el.body.querySelector('[data-act="sleep-pick"]')?.focus({ preventScroll: true }); event.stopPropagation(); }
            else if (state.scenesOpen) { closePop(); renderBody(); el.body.querySelector('[data-act="scene-pick"]')?.focus({ preventScroll: true }); event.stopPropagation(); }
            else if (state.panelOpen) { closePanel(); el.handle.focus(); event.stopPropagation(); }
        }, true);
        // 抽屉开着时 Tab 在抽屉里转一圈（内容 → 页签 → 关闭钮 → 回到内容）。
        // 页签排在抽屉最后，以前从页签再按 Tab 就跑到抽屉后面的档案页去了，抽屉还开着，焦点却看不见。
        const panelStops = () => {
            const inPanel = [...el.pnl.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
                .filter((n) => n.tabIndex >= 0 && !n.disabled && !n.closest('[hidden], [inert], [aria-hidden="true"]')
                    && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
            return el.handle && el.handle.getClientRects().length ? inPanel.concat(el.handle) : inPanel;
        };
        listen(document, 'keydown', (event) => {
            if (event.key !== 'Tab' || event.defaultPrevented || !state.panelOpen || event.altKey || event.ctrlKey || event.metaKey) return;
            const active = document.activeElement;
            if (!active || !(el.pnl.contains(active) || el.hdl.contains(active))) return;
            const stops = panelStops();
            if (!stops.length) return;
            const at = stops.indexOf(active);
            const next = at === -1 ? stops[0] : stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
            event.preventDefault();
            next.focus({ preventScroll: false });
        });

        // ───────── 状态订阅 ─────────
        const observers = [];
        const observe = (target, options, fn) => {
            if (!target) return;
            const observer = new MutationObserver(fn);
            observer.observe(target, options);
            observers.push(observer);
        };
        // 进出舞台、切换首页或经典视图时，重新计算播放条的位置。
        observe(document.getElementById('music-archive-view'), { attributes: true, attributeFilter: ['class'] }, queueShift);
        queueShift();
        if (dspCard) syncFx(false);
        let lastPlaying = null, lastStage = null, lastTheme = document.body.classList.contains('light-theme');
        const bodyLayoutKey = () => { const c = document.body.classList; return (c.contains('music-stage-active') ? 1 : 0) | (c.contains('music-archive-on') ? 2 : 0) | (c.contains('music-stage-entering') ? 4 : 0); };
        let lastBodyLayout = bodyLayoutKey();
        // 主题文件换了（样式表重新加载、换了 href）或舞台换了自定义主题：颜色跟着换。
        let glowTimer = 0;
        const queueGlow = () => {
            if (glowTimer) { clearTimeout(glowTimer); timers.delete(glowTimer); }
            const id = setTimeout(() => { timers.delete(id); glowTimer = 0; syncGlow(); }, 60);
            glowTimer = id;
            timers.add(id);
        };
        const isThemeNode = (n) => n && (n.tagName === 'LINK' || (n.tagName === 'STYLE' && !n.dataset?.md));
        observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] }, (recs) => {
            for (const r of recs) {
                if (r.type === 'attributes' ? r.target?.tagName === 'LINK' : r.target === document.head && [...r.addedNodes, ...r.removedNodes].some(isThemeNode)) { queueGlow(); return; }
            }
        });
        listen(document, 'load', (event) => { if (event.target?.tagName === 'LINK') queueGlow(); }, true);
        const stageRootEl = document.getElementById('music-stage');
        if (stageRootEl) {
            const STAGE_CLS = ['stage-theme-custom', 'stage-theme-light', 'stage-theme-dark', 'stage-night', 'stage-scene-3d', 'stage-opaque', 'is-visible'];
            const stageGlowKey = () => { let m = 0, c = stageRootEl.classList; for (let i = 0; i < 7; i += 1) if (c.contains(STAGE_CLS[i])) m |= 1 << i; return m; };
            let lastStageGlow = stageGlowKey();
            observe(stageRootEl, { attributes: true, attributeFilter: ['class'] }, () => {
                const next = stageGlowKey();
                if (next === lastStageGlow) return;
                lastStageGlow = next;
                queueGlow();
            });
        }
        // 离选中项越远的舞台页签越淡，切换舞台时也更新播放条配色。
        const switcher = stageRootEl?.querySelector('.music-stage-mode-switcher');
        if (switcher) {
            const syncStageTabDistances = () => {
                const buttons = Array.from(switcher.querySelectorAll('[data-stage-mode]'));
                const activeIndex = buttons.findIndex((button) => button.getAttribute('aria-pressed') === 'true');
                buttons.forEach((button, index) => {
                    const distance = activeIndex < 0 ? 4 : Math.min(4, Math.abs(index - activeIndex));
                    button.dataset.mdDist = String(distance);
                });
            };
            observe(switcher, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed'] }, () => {
                syncStageTabDistances();
                queueGlow();
            });
            syncStageTabDistances();
        }
        // 合并原三条 document.body class 监听，仅在布局相关类变化时才触发 queueShift/syncFx
        observe(document.body, { attributes: true, attributeFilter: ['class'] }, () => {
            const nextLayout = bodyLayoutKey();
            if (nextLayout !== lastBodyLayout) {
                lastBodyLayout = nextLayout;
                queueShift();
                if (dspCard && !(state.panelOpen && state.tab === '声音')) syncFx(false);
            }
            const playing = app.isPlaying === true;
            if (playing !== lastPlaying) { lastPlaying = playing; renderPlay(); kickProgress(); }
            const inStage = stageActive();
            if (inStage !== lastStage) { lastStage = inStage; renderStage(); }
            const light = document.body.classList.contains('light-theme');
            const themeChanged = light !== lastTheme;
            if (themeChanged || dockLight() !== host.classList.contains('md-light')) syncGlow();
            if (themeChanged) {
                lastTheme = light;
                if (state.panelOpen && state.tab === '控制') renderBody();
            }
        });
        // 标题、歌手、封面都由播放器写到旧卡片上；跟着它们变。
        observe(app.trackTitle, { childList: true, characterData: true, subtree: true }, renderTrack);
        observe(app.trackArtist, { childList: true, characterData: true, subtree: true }, renderTrack);
        observe(app.albumArt, { attributes: true, attributeFilter: ['style'] }, renderTrack);
        // 暂停时的跳转和引擎校准只改旧进度文字；这里跟着刷新一次。
        observe(app.currentTimeEl, { childList: true, characterData: true, subtree: true }, kickProgress);
        observe(app.durationEl, { childList: true, characterData: true, subtree: true }, kickProgress);
        observe(app.modeBtn, { attributes: true, attributeFilter: ['title'] }, () => {
            renderMode();
            if (state.panelOpen && (state.tab === '控制' || state.tab === '播放列表')) renderBody();
        });
        if (app.volumeSlider) listen(app.volumeSlider, 'input', renderVolume);
        // 列表增删、筛选、换歌后，打开着的播放列表页跟着重画。
        observe(app.playlistEl, { childList: true }, () => {
            if (!state.panelOpen || state.tab !== '播放列表') return;
            rerenderQueue();
        });
        // 手动队列增删、排序后跟着重画。
        listen(document, 'music-queue-change', rerenderQueue);
        listen(document, 'music-queue-source-change', () => { queuePage.dropPrebuilt(); if (state.panelOpen && state.tab === '播放列表') renderBody(); });
        listen(global, 'music-motion-change', () => { if (state.panelOpen && state.tab === '控制') renderBody(); });
        let queueClassRaf = 0;
        cleanups.push(() => { if (queueClassRaf) { cancelAnimationFrame(queueClassRaf); queueClassRaf = 0; } });
        observe(app.playlistEl, { subtree: true, attributes: true, attributeFilter: ['class'] }, () => {
            if (!state.panelOpen || state.tab !== '播放列表' || queueClassRaf) return;
            queueClassRaf = requestAnimationFrame(() => {
                queueClassRaf = 0;
                if (state.destroyed || !state.panelOpen || state.tab !== '播放列表') return;
                const scroller = el.body.querySelector('.md-ql');
                if (scroller) renderQueueWindow(scroller, true);
            });
        });
        // 省电：窗口看不见时流体层整个停下，失焦时不跑动画帧（状态变化直接落位）。
        const syncPower = () => {
            fluid?.setHidden?.(document.hidden === true);
            fluid?.setSuspended?.(typeof document.hasFocus === 'function' && !document.hasFocus());
        };
        listen(document, 'visibilitychange', () => { syncPower(); if (!document.hidden) kickProgress(); });
        listen(global, 'blur', syncPower);
        listen(global, 'focus', syncPower);
        listen(global, 'resize', () => {
            cachedRange = null;
            syncShift();
            animateCapsule();
            if (state.volOpen) placeRail();
            if (state.panelOpen) placeMarks(el.pnl);
        });

        // ───────── 全窗口键位 ─────────
        // 在 document 的捕获阶段统一处理，处理了就 preventDefault，档案页等后面的监听看到就不再重复处理。
        // 焦点在输入框里时单键一律不管（打字优先）；有弹窗开着时也不管。
        // 档案页显示时方向键留给它选歌，快进快退只在舞台和经典视图里用 ←/→；
        // 档案页里直接打字就是检索，所以 M 和 ? 这类单字符也留给它。
        const KEYMAP = [
            ['空格', '播放 / 暂停（按住不会连续切换）'],
            ['← / →', '快退 / 快进 5 秒（档案页里方向键用来选歌）'],
            ['Shift + ← / →', '上一首 / 下一首'],
            ['Ctrl + ↑ / ↓', '音量 +5% / −5%'],
            ['M', '静音 / 恢复（档案页里是打字检索）'],
            ['L', '喜欢 / 取消喜欢当前这首（档案页里是打字检索）'],
            ['Ctrl + K', '搜索：歌、歌单，也能输入操作'],
            ['Ctrl + L', '档案页里定位当前播放（右键底栏胶囊也行）'],
            ['Alt + ↑ / ↓', '档案页歌单里把选中的歌上移 / 下移一位'],
            ['Delete', '档案页歌单里移除选中的歌（可撤销）'],
            ['Ctrl + Enter', '档案页里把选中的歌插到下一首播放'],
            ['Ctrl + Shift + Enter', '档案页里把选中的歌加到队列末尾'],
            ['/', '档案页里打开检索'],
            ['字母 / 数字', '档案页里直接打字就是检索目录'],
            ['?', '打开这张快捷键表（档案页里用 Ctrl + K 搜「快捷键」）'],
            ['Esc', '关闭面板、搜索或这张表']
        ];
        const typingTarget = (t) => Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')));
        const modalOpen = () => [app.playlistDialog, app.playlistEditModal, app.lyricsFetchModal].some((m) => m?.classList?.contains('visible'))
            || document.body.classList.contains('music-intro-playing');
        const archiveShown = () => !stageActive() && !document.body.classList.contains('music-stage-active')
            && app.archiveView?.mode === 'archive';
        let helpEl = null;
        const helpOpen = () => Boolean(helpEl && !helpEl.hidden);
        let helpFrom = null;
        const closeHelp = () => {
            if (!helpOpen()) return;
            // 合上时流回最后按下的地方（点了关闭就流回那颗按钮），键盘关就流回打开时那一点
            const snap = global.MusicFluid?.snapshot(helpEl.querySelector('.md-keys-box'));
            helpEl.classList.remove('md-open');
            helpEl.hidden = true;
            if (snap) global.MusicFluid.melt(snap, global.MusicFluid.recentPress() || helpFrom, { duration: 300 });
        };
        const openHelp = () => {
            if (!helpEl) {
                helpEl = document.createElement('div');
                helpEl.className = 'md-keys';
                helpEl.innerHTML = `<div class="md-keys-scrim" data-keys="close"></div>`
                    + `<section class="md-keys-box" role="dialog" aria-modal="true" aria-label="快捷键" tabindex="-1">`
                    + `<header><b>快捷键</b><button class="md-ib md-m" type="button" data-keys="close" aria-label="关闭">${icon('x', 16)}</button></header>`
                    + `<dl>${KEYMAP.map(([k, v]) => `<dt>${k.split(' ').map((part) => (/^[+/]$/.test(part) ? `<i>${part}</i>` : `<kbd>${escapeHtml(part)}</kbd>`)).join('')}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`
                    + `<footer>焦点在输入框里时，单个按键只用来打字。</footer></section>`;
                host.appendChild(helpEl);
                helpEl.addEventListener('click', (event) => { if (event.target.closest('[data-keys="close"]')) closeHelp(); });
            }
            closePop(); setQuick(false);
            helpEl.hidden = false;
            const box = helpEl.querySelector('.md-keys-box');
            if (global.MusicFluid?.enabled()) {
                // 从按下的那一点（键盘打开时从底栏中间）长出来：先让面板直接落到最终位置，量好了再交给液体去画
                box.style.transition = 'none';
                helpEl.classList.add('md-open');
                void box.offsetWidth;
                box.style.transition = '';
                const from = global.MusicFluid.recentPress() || { x: global.innerWidth / 2, y: global.innerHeight - 60 };
                helpFrom = from;
                global.MusicFluid.bud(box, from, { duration: 480 });
            } else {
                requestAnimationFrame(() => helpEl.classList.add('md-open'));
            }
            box.focus({ preventScroll: true });
        };
        const seekBy = (delta) => {
            const d = duration();
            if (!(d > 0)) return;
            app.seekTo?.(Math.min(Math.max(0, d - 0.5), Math.max(0, currentTime() + delta)));
            kickProgress();
        };
        let spaceHeld = false;
        listen(document, 'keyup', (event) => { if (event.code === 'Space') spaceHeld = false; }, true);
        listen(global, 'blur', () => { spaceHeld = false; });
        listen(document, 'keydown', (event) => {
            if (event.defaultPrevented || state.destroyed) return;
            const t = event.target;
            if (t?.closest?.('.md-cmd')) return; // 命令面板自己处理
            if (helpOpen()) {
                if (event.key === 'Escape' || event.key === '?') { event.preventDefault(); event.stopPropagation(); closeHelp(); }
                return;
            }
            if (typingTarget(t) || modalOpen()) return;
            const key = event.key;
            const mod = event.ctrlKey || event.metaKey;
            const take = () => { event.preventDefault(); event.stopPropagation(); };

            if (event.code === 'Space' && !mod && !event.altKey) {
                // 焦点在按钮上时空格就是按那个按钮，不再额外切一次
                if (t?.closest?.('button, [role="button"], a[href], [role="slider"]')) return;
                take();
                if (event.repeat || spaceHeld) return; // 按住不连发
                spaceHeld = true;
                if (app.toggleTransport) app.toggleTransport();
                else if (app.isPlaying) app.pauseTrack?.(); else app.playTrack?.();
                return;
            }
            if (event.altKey) return;
            if (mod && !event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
                take();
                setVolume(Math.round((readVolume() + (key === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100);
                flashVolume();
                return;
            }
            if (mod) return;
            if (event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
                take();
                if (event.repeat) return;
                showPreview(null);
                if (key !== 'ArrowLeft' || !prevRestarts()) slideTitle(key === 'ArrowLeft' ? -1 : 1);
                if (key === 'ArrowLeft') app.prevTrack?.(); else app.nextTrack?.();
                return;
            }
            if (!event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
                if (archiveShown()) return; // 档案页里留给选歌
                if (t?.closest?.('[role="slider"], [role="tablist"], .md-seg, .md-ql')) return;
                take();
                seekBy(key === 'ArrowLeft' ? -5 : 5);
                return;
            }
            if (key.length === 1 && archiveShown()) return; // 档案页里单字符是打字检索
            if ((key === 'm' || key === 'M') && !event.repeat) {
                take();
                toggleMute();
                flashVolume();
                return;
            }
            if ((key === 'l' || key === 'L') && !event.repeat && likeAvailable() && currentTrack()) {
                take();
                toggleCurrentLike();
                return;
            }
            if (key === '?') { take(); openHelp(); }
        }, true);

        // ───────── 命令面板 ─────────
        const palette = typeof global.createMusicDockPalette === 'function'
            ? global.createMusicDockPalette(app, {
                host, icon, escapeHtml, trackTitle, trackArtist,
                openPanel, openSheet, toggleStage, cycleMode, setVolume, readVolume, toggleMute, openHelp,
                closeOthers: () => { closePop(); setQuick(false); }
            })
            : null;

        // ───────── 提示层：播放失败、扫描进度 ─────────
        // 原来这些只写在经典视图的码率字段里，档案页和舞台里看不到；现在同时走全窗口提示层。
        const toast = global.MusicToast;
        if (toast) {
            const unwrapNotice = global.MusicAppHooks.wrap(app, 'showPlaybackNotice', 'dock', (baseNotice) => (message) => {
                baseNotice(message);
                if (state.destroyed) return;
                const text = String(message || '');
                // 加载失败由播放器自己出提示（带「跳过」和连续失败的处理），这里不再重复一条。
                if (/^加载(失败|超时)/.test(text) && typeof app.cancelFailureSkip === 'function') return;
                state.noticeTrackKey = state.trackKey;
                toast.show({ id: 'playback', kind: 'error', message: text });
            });
            if (unwrapNotice) cleanups.push(unwrapNotice);
            const bridge = app.api;
            // 扫描结束的那句话。扫描本身失败时以前也说「扫描完成，没有找到音乐文件」，
            // 像是文件夹空了；读不出来的文件也一声不吭地少了。
            const scanOutcomeToast = (data) => {
                if (data && data.failed) {
                    const reason = (global.MusicErrorText || ((m, f) => f))(data.error, '').replace(/^：/, '');
                    return { kind: 'error', message: `扫描没有完成${reason ? `（${reason}）` : ''}，曲库保持原样` };
                }
                const count = Array.isArray(data) ? data.length : (Array.isArray(data?.tracks) ? data.tracks.length : 0);
                const unread = Number(data?.stats?.failed) || 0;
                const skipped = unread ? `，另有 ${unread} 个文件读不出来（可能损坏或格式不支持），已跳过` : '';
                if (!count) return { kind: unread ? 'error' : 'success', message: unread ? `扫描完成，没有读出音乐文件${skipped}` : '扫描完成，没有找到音乐文件' };
                return { kind: 'success', message: `扫描完成，这个文件夹里有 ${count} 首${skipped}` };
            };
            app.scanOutcomeToast = scanOutcomeToast;
            if (bridge?.onMusicScanProgress) {
                const offStart = bridge.onMusicScanStart?.(() => {
                    if (!state.destroyed) toast.show({ id: 'scan', kind: 'progress', message: '正在扫描音乐文件夹…', delay: 300 });
                });
                const offProg = bridge.onMusicScanProgress((data) => {
                    if (state.destroyed) return;
                    const total = Number(data?.total) || 0;
                    const current = Number(data?.current) || 0;
                    toast.show({ id: 'scan', kind: 'progress', message: total ? `正在扫描 ${current} / ${total}` : '正在扫描音乐文件夹…', progress: total ? current / total : undefined });
                });
                const offDone = bridge.onMusicScanComplete?.((data) => {
                    if (state.destroyed) return;
                    toast.dismiss('scan');
                    toast.show(scanOutcomeToast(data));
                });
                for (const off of [offStart, offProg, offDone]) {
                    if (typeof off === 'function') cleanups.push(off);
                }
            }
        }

        // ───────── 首次渲染 ─────────
        renderTrack();
        renderPlay();
        renderMode();
        renderStage(true);
        renderQuick();
        renderVolume();
        state.expanded = shouldExpand();
        el.cap.classList.toggle('md-ex', state.expanded);
        syncFluid();
        const stageFluidKey = (cfg) => (cfg ? `${cfg.quality}|${cfg.themeMode}|${cfg.themeFile}|${cfg.themeVariant}` : '');
        let lastStageFluidKey = stageFluidKey(global.MusicStageConfig?.get?.());
        if (global.MusicStageConfig?.subscribe) {
            cleanups.push(global.MusicStageConfig.subscribe((next) => {
                const key = stageFluidKey(next || global.MusicStageConfig?.get?.());
                if (key === lastStageFluidKey) return;
                lastStageFluidKey = key;
                syncFluid();
            }));
        }
        // 字体和布局稳定后再量一次（流体层要对齐按钮的真实位置）。
        bootRaf = requestAnimationFrame(() => { bootRaf = 0; if (!state.destroyed) animateCapsule(); });
        // 预热抽屉：窗口空下来以后，在藏着的抽屉里把当前页签画一遍。第一次打开时样式规则和排版都已经算过一回，
        // 不会比以后每次都慢一大截。真打开时照常重画，这里画的东西不会被直接拿来用。
        const warmIdleIds = new Set();
        const warmTimer = setTimeout(() => {
            const run = () => { if (!state.panelOpen && !state.destroyed) renderBody(); };
            // 停着的音效卡从来没排过版（content-visibility:hidden 从一开始就跳过了它），第一次切到声音页要把
            // 六七百个元素的样式和排版一口气算完。空闲时让它短暂「可见」一次把这些算掉，再收回去：之后停着也留着结果。
            const warmFx = () => {
                if (state.destroyed || !el.fxScroll.classList.contains('md-fx-park')) return;
                el.fxScroll.classList.add('md-fx-warm');
                void el.fxScroll.firstElementChild?.getBoundingClientRect();
                el.fxScroll.classList.remove('md-fx-warm');
            };
            const idle = (fn) => {
                if (typeof global.requestIdleCallback !== 'function') { fn(); return; }
                let id = 0;
                id = global.requestIdleCallback(() => { warmIdleIds.delete(id); fn(); }, { timeout: 4000 });
                warmIdleIds.add(id);
            };
            idle(() => { run(); idle(warmFx); });
        }, 2500);
        cleanups.push(() => {
            cRaf(likePopRaf); cRaf(slideRaf); cRaf(bootRaf);
            clearTimeout(warmTimer);
            for (const id of warmIdleIds) global.cancelIdleCallback?.(id);
            warmIdleIds.clear();
        });
        kickProgress();
        lastPlaying = app.isPlaying === true;
        lastStage = stageActive();
        lastTheme = document.body.classList.contains('light-theme');

        const api = {
            openPanel,
            closePanel,
            openSheet,
            closeSheet,
            openPalette: (text) => palette?.open(text),
            openShortcuts: () => openHelp(),
            openStageSettings,
            get stageSettingsOpen() { return stageActive() && state.panelOpen && state.tab === '控制'; },
            get soundSettingsOpen() { return state.panelOpen && state.tab === '声音'; },
            get tab() { return state.tab; },
            /** 右边抽屉占掉的窗口宽度（px），关着是 0；首页据此重排 */
            get roomRight() { return roomRight; },
            get glowColors() { return currentGlow(); },
            get ringMode() { return ringMode; },
            closePalette: () => palette?.close(),
            get panelOpen() { return state.panelOpen; },
            get expanded() { return state.expanded; },
            destroy() {
                if (state.destroyed) return;
                state.destroyed = true;
                closeSheet();
                palette?.destroy();
                helpEl?.remove();
                global.MusicToast?.clear();
                for (const id of timers) clearTimeout(id);
                timers.clear();
                fluid?.destroy();
                fluid = null;
                observers.forEach((observer) => observer.disconnect());
                cleanups.splice(0).forEach((fn) => fn());
                document.body.classList.remove('music-dock-on');
                delete app.openMusicControls;
                document.body.style.removeProperty('--music-dock-safe-bottom');
                global.removeEventListener('beforeunload', api.destroy);
                host.innerHTML = '';
            }
        };
        app.musicDock = api;
        // 给窗口里别的入口用（比如档案页的按钮）：直接打开到某一段。section：'stage' 舞台设置，'sound' 声音，其余是控制页顶部。
        app.openMusicControls = (section) => {
            if (section === 'sound' || section === 'acoustic') openPanel('声音');
            else if (section === 'stage') openStageSettings();
            else openPanel('控制');
        };
        global.addEventListener('beforeunload', api.destroy, { once: true });
        return api;
    }

    global.initMusicDock = initMusicDock;
})(window);
