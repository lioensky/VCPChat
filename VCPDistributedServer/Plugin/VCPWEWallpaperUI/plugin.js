/**
 * VCPWEWallpaperUI - Wallpaper Engine 壁纸前端插件
 *
 * pluginType: renderer | 由 frontend-plugin-loader.js 注入聊天窗口
 *
 * 结构：
 *   §1 播放器内核     移植自 VChatDynamicWallpaper (by 辉宝)：状态机/失败跳过/断点续播
 *                     三种呈现形态：video 视频层 / web iframe 层 / image 静态兜底层
 *   §2 WE 数据源      fetch service 插件的 inventory（替换原 IPC 选目录）
 *   §3 网格选择器     预览图 + 标题 + 形态徽章 + 过滤 + 搜索 + 分页（弹层）
 *   §4 控制面板       chat-actions 紧凑面板：壁纸库/播放/静音/音量/显隐/轮播/下一张
 *   §4.5 轮播          按当前过滤范围在可动态呈现的壁纸间定时轮换
 *   §5 互斥协调       与辉宝插件单向抑制（同层 video 二选一）
 *   §6 registry 暴露  供 VCPGlass 等插件联动 {active, kind, pause}
 */
(() => {
    'use strict';

    const ID = 'vcp-we-wallpaper-ui';
    if (window.VCPFrontendPlugins?.get(ID)) return;

    /* ═══════════════ §0 常量与状态 ═══════════════ */

    const STORE_KEY = 'vcpWeWallpaper.settings.v1';
    const DEFAULT_SERVER_BASE = 'http://127.0.0.1:5974';
    const PAGE_SIZE = 24;                       // 选择器每页卡片数

    /** 轮播可选间隔（分钟）。点按钮循环切换，比塞一个输入框更省地方。 */
    const ROTATE_STEPS = [1, 5, 15, 30, 60];

    /** web 壁纸载入超时（毫秒）。超时未 load 视为白屏，自动降级回 preview。 */
    const WEB_LOAD_TIMEOUT_MS = 8000;

    const DEFAULTS = {
        enabled: false,          // 总开关（默认关，用户首次选壁纸后自动开）
        wallpaperId: '',         // 当前壁纸 id（目录名，跨重启稳定）
        wallpaperKind: 'video',  // 'video' 视频层 | 'web' iframe 层 | 'image' 静态兜底层
        playing: true,
        muted: true,
        volume: 0.5,
        currentTime: 0,          // 断点续播
        visible: true,           // 背景层显隐（不关播放）
        serverBase: DEFAULT_SERVER_BASE,
        filterType: 'video',     // 选择器记忆
        panelCollapsed: true,
        rotate: false,           // 轮播开关
        rotateMinutes: 5         // 轮播间隔（分钟），取值来自 ROTATE_STEPS
    };

    const state = { ...DEFAULTS, inventory: null, inventoryError: '', switching: false };

    let video;               // <video id="vcp-we-wallpaper-video"> z-index:-1
    let imageLayer;          // <div id="vcp-we-wallpaper-image"> 静态兜底层，同 z-index:-1
    let webFrame;            // <iframe id="vcp-we-wallpaper-web"> 真动态 web 壁纸层
    let panel;               // chat-actions 控制面板
    let pickerOverlay;       // 全屏网格选择器
    let rotateTimer;         // 轮播计时器
    let webLoadTimer;        // web 壁纸白屏超时计时器
    /** 已降级为静态的 web 壁纸 id 集合（本次会话内不再重试 iframe）。 */
    const webFallbackIds = new Set();

    /* ═══════════════ §1 播放器内核（移植自辉宝，微调命名与持久化字段） ═══════════════ */

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
            Object.assign(state, {
                enabled: saved.enabled === true,
                wallpaperId: typeof saved.wallpaperId === 'string' ? saved.wallpaperId : '',
                wallpaperKind: ['video', 'web', 'image'].includes(saved.wallpaperKind)
                    ? saved.wallpaperKind : 'video',
                playing: saved.playing !== false,
                muted: saved.muted !== false,
                volume: Number.isFinite(saved.volume) ? saved.volume : 0.5,
                currentTime: Number.isFinite(saved.currentTime) ? saved.currentTime : 0,
                visible: saved.visible !== false,
                serverBase: typeof saved.serverBase === 'string' ? saved.serverBase : DEFAULT_SERVER_BASE,
                filterType: saved.filterType || 'video',
                panelCollapsed: saved.panelCollapsed !== false,
                rotate: saved.rotate === true,
                rotateMinutes: ROTATE_STEPS.includes(saved.rotateMinutes)
                    ? saved.rotateMinutes : 5
            });
        } catch { /* 损坏的存储按默认处理 */ }
    }

    function saveSettings() {
        localStorage.setItem(STORE_KEY, JSON.stringify({
            enabled: state.enabled,
            wallpaperId: state.wallpaperId,
            wallpaperKind: state.wallpaperKind,
            playing: state.playing,
            muted: state.muted,
            volume: state.volume,
            currentTime: state.currentTime,
            visible: state.visible,
            serverBase: state.serverBase,
            filterType: state.filterType,
            panelCollapsed: state.panelCollapsed,
            rotate: state.rotate,
            rotateMinutes: state.rotateMinutes
        }));
    }

    function capturePlayback() {
        if (!video || !Number.isFinite(video.currentTime)) return;
        state.currentTime = Math.max(0, video.currentTime);
    }

    /** 当前壁纸对象（inventory 已加载时）。 */
    function currentWallpaper() {
        return state.inventory?.wallpapers?.find(w => w.id === state.wallpaperId) || null;
    }

    /**
     * 判定一个壁纸在聊天窗口里能以什么形态呈现：
     *   'video' → <video> 硬解播放
     *   'web'   → iframe 隔离渲染真实 HTML 壁纸（service 端目录托管 + WE API 垫片；
     *             需要 main.html 的 frame-src 放通 127.0.0.1:5974）
     *   'image' → 静态兜底，用 preview 大图铺底
     *             （scene 封在私有 scene.pkg 里无法渲染；web 白屏降级后也走这里）
     *   null    → 三条路都走不通，彻底不可用
     */
    function resolveKind(wp) {
        if (!wp) return null;
        if (wp.type === 'video' && wp.playable) return 'video';
        // 本次会话内已确认白屏的 web 壁纸不再重试 iframe，直接静态
        if (wp.type === 'web' && wp.web && !webFallbackIds?.has(wp.id)) return 'web';
        if (wp.preview) return 'image';
        return null;
    }

    function applyVisibility({ resume = false } = {}) {
        const kind = resolveKind(currentWallpaper());
        const active = Boolean(state.enabled && state.visible && kind);
        document.body.classList.toggle('vcp-we-wallpaper-visible', active);

        if (imageLayer) imageLayer.style.display = active && kind === 'image' ? 'block' : 'none';
        if (webFrame) webFrame.style.display = active && kind === 'web' ? 'block' : 'none';
        if (!video) return;

        const videoActive = active && kind === 'video';
        video.style.display = videoActive ? 'block' : 'none';
        if (!videoActive && !video.paused) {
            video.pause();
        } else if (videoActive && resume && state.playing && video.paused) {
            video.play().catch(() => {});
        }
        if (active) suppressHunbao();
    }

    /** 释放视频解码资源——非视频形态期间不该留一个 <video> 在后台占显存。 */
    function releaseVideo() {
        if (!video) return;
        video.pause();
        video.removeAttribute('src');
        try { video.load(); } catch { /* 忽略 */ }
    }

    /** 卸下 iframe 内容（web → 其他形态切换时必须做，否则壁纸脚本继续跑满 CPU）。 */
    function releaseWeb() {
        if (webLoadTimer) { clearTimeout(webLoadTimer); webLoadTimer = null; }
        if (webFrame) webFrame.removeAttribute('src');
    }

    /* ── 窗口不可见时挂起动态图层 ──────────────────────────────
     * 最小化到托盘 / 切到别的窗口后，视频仍会满帧硬解、web 壁纸的 rAF 仍在跑，
     * 白烧 GPU 与内存却没人看。这里在 visibilitychange 上挂起两者，
     * 回到前台再恢复。用户主动按「隐藏背景」时不擅自恢复。
     */
    let suspendedWebSrc = '';
    let suspendedByHide = false;

    function suspendForHidden() {
        if (suspendedByHide) return;
        suspendedByHide = true;
        if (video && !video.paused) {
            capturePlayback();          // 先记进度，恢复时才能接上
            video.pause();
        }
        const src = webFrame?.getAttribute('src');
        if (src) {
            suspendedWebSrc = src;
            releaseWeb();
        }
    }

    function resumeFromHidden() {
        if (!suspendedByHide) return;
        suspendedByHide = false;
        const src = suspendedWebSrc;
        suspendedWebSrc = '';
        // 总开关关了或用户主动隐藏了背景，就停在挂起状态，别自作主张
        if (!state.enabled || !state.visible) return;

        const kind = resolveKind(currentWallpaper());
        if (kind === 'video' && state.playing) {
            video?.play().catch(() => {});
        } else if (kind === 'web' && src && webFrame) {
            // 挂起前已成功载入过，无需再走一遍白屏超时判定
            webFrame.dataset.loaded = '1';
            webFrame.src = src;
        }
    }

    function onVisibilityChange() {
        if (document.hidden) suspendForHidden();
        else resumeFromHidden();
    }

    /** 静态兜底：把壁纸自带的 preview 大图铺成背景。 */
    function showImageWallpaper(wallpaper) {
        if (!wallpaper?.preview) return false;
        releaseVideo();
        releaseWeb();
        state.wallpaperId = wallpaper.id;
        state.wallpaperKind = 'image';
        state.enabled = true;
        state.currentTime = 0;
        if (imageLayer) {
            imageLayer.style.backgroundImage = `url("${state.serverBase + wallpaper.preview}")`;
        }
        applyVisibility();
        saveSettings();
        updatePanel();
        return true;
    }

    /**
     * 真动态 web 壁纸：把 service 端托管的入口页装进 iframe。
     *
     * 白屏保护：壁纸依赖外网资源或用了我们没垫的 WE API 时可能永远不 load。
     * 因此设一个超时，超时未 load 就把它记入 webFallbackIds 并降级为 preview 静态图，
     * 保证主人不会对着一片空白发懵。
     */
    function showWebWallpaper(wallpaper) {
        if (!wallpaper?.web || !webFrame) return false;
        releaseVideo();
        if (webLoadTimer) clearTimeout(webLoadTimer);

        state.wallpaperId = wallpaper.id;
        state.wallpaperKind = 'web';
        state.enabled = true;
        state.currentTime = 0;
        if (imageLayer) imageLayer.style.backgroundImage = '';
        webFrame.dataset.loaded = '0';          // 换页必须清零，否则沿用上一张的成功标记
        webFrame.src = state.serverBase + wallpaper.web;

        webLoadTimer = setTimeout(() => {
            webLoadTimer = null;
            // load 事件已到过则 dataset.loaded 为 '1'，此处不再降级
            if (webFrame?.dataset.loaded === '1') return;
            webFallbackIds.add(wallpaper.id);
            console.warn(`[VCPWEWallpaperUI] web 壁纸「${wallpaper.title}」载入超时，降级为静态预览`);
            if (wallpaper.preview) showImageWallpaper(wallpaper);
        }, WEB_LOAD_TIMEOUT_MS);

        applyVisibility();
        saveSettings();
        updatePanel();
        return true;
    }

    /** 统一入口：按壁纸能力分派到 video / web / image 三种呈现形态。 */
    function selectWallpaper(wallpaper, { autoplay = true, startTime = 0 } = {}) {
        const kind = resolveKind(wallpaper);
        if (kind === 'video') return playWallpaper(wallpaper, { autoplay, startTime });
        if (kind === 'web') return showWebWallpaper(wallpaper);
        if (kind === 'image') return showImageWallpaper(wallpaper);
        return false;
    }

    /** 播放指定视频壁纸。 */
    function playWallpaper(wallpaper, { startTime = 0, autoplay = true } = {}) {
        if (!wallpaper?.playable || wallpaper.type !== 'video' || state.switching) return false;
        state.switching = true;
        state.wallpaperId = wallpaper.id;
        state.wallpaperKind = 'video';
        state.enabled = true;
        state.currentTime = Math.max(0, startTime);
        state.playing = Boolean(autoplay);

        releaseWeb();
        if (imageLayer) imageLayer.style.backgroundImage = '';
        video.src = state.serverBase + wallpaper.media;
        const restoreTime = () => {
            if (!Number.isFinite(state.currentTime) || state.currentTime <= 0) return;
            try {
                video.currentTime = Math.min(state.currentTime,
                    Number.isFinite(video.duration) ? video.duration : state.currentTime);
            } catch { /* seek 时机未到则忽略 */ }
        };
        video.addEventListener('loadedmetadata', restoreTime, { once: true });
        video.load();
        restoreTime();
        state.switching = false;
        applyVisibility();
        saveSettings();
        updatePanel();
        if (state.playing) {
            video.play().catch(() => { state.playing = false; saveSettings(); });
        }
        return true;
    }

    /** 重启后按持久化的 wallpaperId 恢复（动态/静态都恢复）。 */
    function restoreSelection() {
        if (!state.enabled || !state.wallpaperId) return;
        fetchInventory().then(() => {
            selectWallpaper(currentWallpaper(), {
                startTime: state.currentTime,
                autoplay: state.playing
            });
        }).catch(() => { /* service 未启动时静默 */ });
    }

    /* ═══════════════ §2 WE 数据源 ═══════════════ */

    async function fetchInventory({ force = false } = {}) {
        if (state.inventory && !force) return state.inventory;
        // force 时带上 refresh=1：service 端 inventory 有 5 分钟缓存，
        // 不打这个参数的话新订阅的壁纸最多要等一个 TTL 才出现。
        const url = `${state.serverBase}/vcp-we-wallpaper/inventory${force ? '?refresh=1' : ''}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
            const err = res.status === 503
                ? '未找到 Wallpaper Engine 安装（请确认 Steam 与 WE 已安装）'
                : `inventory 请求失败 (HTTP ${res.status})——请确认分布式服务器已开启且 VCPWEWallpaper 插件已启用`;
            state.inventoryError = err;
            throw new Error(err);
        }
        state.inventory = await res.json();
        state.inventoryError = '';
        return state.inventory;
    }

    /* ═══════════════ §3 网格选择器（过滤 + 搜索 + 分页） ═══════════════ */

    const TYPE_LABELS = { video: '视频', web: '网页', scene: '场景', application: '应用' };
    const pickerState = { page: 1, hintUntil: 0 };

    function openPicker() {
        closePicker();
        pickerState.page = 1;
        pickerState.hintUntil = 0;
        pickerOverlay = document.createElement('div');
        pickerOverlay.id = 'vcp-we-wallpaper-picker';
        pickerOverlay.innerHTML = `
            <div class="vwp-picker-dialog" role="dialog" aria-label="选择 Wallpaper Engine 壁纸">
                <div class="vwp-picker-head">
                    <span class="vwp-picker-title">Wallpaper Engine 壁纸库</span>
                    <span class="vwp-picker-count"></span>
                    <div class="vwp-picker-filters">
                        <button data-filter="video">视频</button>
                        <button data-filter="web">网页</button>
                        <button data-filter="scene">场景</button>
                        <button data-filter="all">全部</button>
                    </div>
                    <input class="vwp-picker-search" type="search" placeholder="搜索标题…">
                    <button class="vwp-picker-refresh" title="重新扫描壁纸库（新订阅的壁纸在此刷新）">${icons.refresh}</button>
                    <button class="vwp-picker-close" title="关闭 (Esc)">✕</button>
                </div>
                <div class="vwp-picker-status"></div>
                <div class="vwp-picker-grid"></div>
                <div class="vwp-picker-foot">
                    <button class="vwp-page-btn" data-page="prev" title="上一页">‹ 上一页</button>
                    <span class="vwp-page-info"></span>
                    <button class="vwp-page-btn" data-page="next" title="下一页">下一页 ›</button>
                </div>
            </div>`;
        document.body.appendChild(pickerOverlay);

        pickerOverlay.addEventListener('click', (e) => {
            if (e.target === pickerOverlay) closePicker();
        });
        pickerOverlay.querySelector('.vwp-picker-close').addEventListener('click', closePicker);
        pickerOverlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closePicker();
        });

        const grid = pickerOverlay.querySelector('.vwp-picker-grid');
        const statusEl = pickerOverlay.querySelector('.vwp-picker-status');
        const countEl = pickerOverlay.querySelector('.vwp-picker-count');
        const searchEl = pickerOverlay.querySelector('.vwp-picker-search');
        const pagePrev = pickerOverlay.querySelector('[data-page="prev"]');
        const pageNext = pickerOverlay.querySelector('[data-page="next"]');
        const pageInfo = pickerOverlay.querySelector('.vwp-page-info');
        const filterBtns = pickerOverlay.querySelectorAll('.vwp-picker-filters button');
        const refreshBtn = pickerOverlay.querySelector('.vwp-picker-refresh');

        refreshBtn.addEventListener('click', async () => {
            refreshBtn.classList.add('busy');
            refreshBtn.disabled = true;
            setHint('正在重新扫描 Wallpaper Engine 库…', true);
            const before = state.inventory?.total ?? 0;
            try {
                const inv = await fetchInventory({ force: true });
                pickerState.page = 1;
                renderGrid();
                const delta = (inv.total ?? 0) - before;
                setHint(delta > 0 ? `已刷新，新增 ${delta} 张壁纸`
                    : delta < 0 ? `已刷新，减少 ${-delta} 张壁纸`
                    : '已刷新，壁纸数量无变化');
            } catch (err) {
                setHint(`刷新失败：${err.message}`);
            } finally {
                refreshBtn.classList.remove('busy');
                refreshBtn.disabled = false;
            }
        });

        filterBtns.forEach(btn => btn.addEventListener('click', () => {
            state.filterType = btn.dataset.filter;
            pickerState.page = 1;
            saveSettings();
            renderGrid();
        }));
        searchEl.addEventListener('input', () => { pickerState.page = 1; renderGrid(); });
        pagePrev.addEventListener('click', () => { if (pickerState.page > 1) { pickerState.page--; renderGrid(); grid.scrollTop = 0; } });
        pageNext.addEventListener('click', () => {
            const total = totalPages();
            if (pickerState.page < total) { pickerState.page++; renderGrid(); grid.scrollTop = 0; }
        });
        searchEl.focus();

        function visibleItems() {
            const list = state.inventory?.wallpapers || [];
            const q = searchEl.value.trim().toLowerCase();
            return list.filter(w => {
                if (q && !(w.title || '').toLowerCase().includes(q)) return false;
                if (state.filterType === 'all') return true;
                return w.type === state.filterType;
            });
        }
        function totalPages() { return Math.max(1, Math.ceil(visibleItems().length / PAGE_SIZE)); }

        /** 提示条：带 3 秒保护期，避免被下一次 renderGrid 立即清空。 */
        function setHint(text, sticky = false) {
            statusEl.textContent = text;
            statusEl.classList.toggle('hint', Boolean(text));
            pickerState.hintUntil = sticky ? Infinity : Date.now() + 3000;
        }

        function renderGrid() {
            filterBtns.forEach(b => b.classList.toggle('on', b.dataset.filter === state.filterType));

            if (!state.inventory) {
                grid.innerHTML = '';
                pageInfo.textContent = '';
                if (Date.now() > pickerState.hintUntil) {
                    statusEl.textContent = state.inventoryError || '正在加载库存…';
                }
                pagePrev.disabled = pageNext.disabled = true;
                return;
            }

            const items = visibleItems();
            const pages = totalPages();
            if (pickerState.page > pages) pickerState.page = pages;
            const start = (pickerState.page - 1) * PAGE_SIZE;
            const slice = items.slice(start, start + PAGE_SIZE);

            countEl.textContent = `${items.length} / ${state.inventory.total}`;
            pagePrev.disabled = pickerState.page <= 1;
            pageNext.disabled = pickerState.page >= pages;
            pageInfo.textContent = pages > 1 ? `第 ${pickerState.page} / ${pages} 页` : '';

            if (Date.now() > pickerState.hintUntil) {
                statusEl.textContent = '';
                statusEl.classList.remove('hint');
            }

            grid.innerHTML = '';
            const frag = document.createDocumentFragment();
            for (const w of slice) {
                // div 而非 button：button 的格式化上下文与 line-clamp 有兼容怪癖，
                // 且 div 让徽章 flex-shrink:0 生效，彻底根治标签被裁断问题。
                const card = document.createElement('div');
                card.role = 'button';
                card.tabIndex = 0;
                card.className = 'vwp-card' + (w.id === state.wallpaperId ? ' current' : '');
                card.title = w.title;
                const kind = resolveKind(w);
                const typeName = TYPE_LABELS[w.type] || w.type;
                const badgeText = kind === 'video' ? '视频 · 动态'
                    : kind === 'web' ? '网页 · 动态'
                    : kind === 'image' ? `${typeName} · 静态`
                    : `${typeName} · 不可用`;
                card.innerHTML = `
                    <span class="vwp-card-thumb" style="background-image:url('${w.preview ? state.serverBase + w.preview : ''}')">${w.preview ? '' : '<span class="vwp-thumb-empty">无预览</span>'}</span>
                    <span class="vwp-card-name"></span>
                    <span class="vwp-card-badge vwp-badge-${kind || 'none'}">${badgeText}</span>`;
                card.querySelector('.vwp-card-name').textContent = w.title;

                const pick = () => {
                    if (kind === 'video' || kind === 'web') {
                        selectWallpaper(w, { autoplay: true });
                        closePicker();
                        return;
                    }
                    if (kind === 'image') {
                        // 静态兜底：不关闭弹窗，让主人看到提示并能继续挑
                        selectWallpaper(w);
                        renderGrid();
                        const why = w.type === 'web'
                            ? '该网页壁纸此前载入超时，已降级'
                            : '3D 场景壁纸无法在聊天窗口动态渲染';
                        setHint(`已应用「${w.title}」的静态预览图 —— ${why}`);
                        return;
                    }
                    setHint(`「${w.title}」既无可播放视频也无预览图，无法使用`);
                };
                card.addEventListener('click', pick);
                card.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
                });
                frag.appendChild(card);
            }
            grid.appendChild(frag);
        }

        renderGrid();
        fetchInventory().then(renderGrid).catch(() => renderGrid());
    }

    function closePicker() {
        pickerOverlay?.remove();
        pickerOverlay = null;
    }

    /* ═══════════════ §3.5 轮播 ═══════════════ */

    /**
     * 轮播候选：当前过滤范围内所有"能动态呈现"的壁纸（video + web）。
     * 静态兜底图不参与轮播——一张不动的图轮换只会莫名闪烁。
     */
    function rotatePool() {
        const list = state.inventory?.wallpapers || [];
        const pool = list.filter(w => {
            const k = resolveKind(w);
            if (k !== 'video' && k !== 'web') return false;
            if (state.filterType === 'all') return true;
            return w.type === state.filterType;
        });
        // 过滤器选中的类别没有动态候选时，退回全部动态壁纸，避免轮播静默失效
        return pool.length > 0
            ? pool
            : list.filter(w => ['video', 'web'].includes(resolveKind(w)));
    }

    /** 切到下一张（手动点击与定时器共用）。 */
    function rotateNext({ manual = false } = {}) {
        const pool = rotatePool();
        if (pool.length === 0) return false;
        const at = pool.findIndex(w => w.id === state.wallpaperId);
        const next = pool[(at + 1) % pool.length];
        // 单张时手动点击也重播一次，给出"确实响应了"的反馈
        if (pool.length === 1 && !manual && next.id === state.wallpaperId) return false;
        const ok = selectWallpaper(next, { autoplay: true });
        if (ok && state.rotate) scheduleRotate();   // 手动切换后重置计时
        return ok;
    }

    function scheduleRotate() {
        if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
        if (!state.rotate) return;
        const ms = Math.max(1, state.rotateMinutes) * 60 * 1000;
        rotateTimer = setInterval(() => {
            if (!state.enabled || document.hidden) return;   // 窗口不可见时不浪费切换
            rotateNext();
        }, ms);
    }

    /* ═══════════════ §4 控制面板（chat-actions 插槽，全图标化） ═══════════════ */

    /* 图标统一规格：viewBox 24 / stroke 1.8 / 16px，线条风格与 VCPChat 原生按钮一致 */
    const icons = {
        grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></svg>',
        library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="m7 15 4.2-4.2a1 1 0 0 1 1.4 0L16 14"/><circle cx="15.2" cy="9.2" r="1.3"/><path d="M21 15.5 18 13l-3 2.5"/></svg>',
        play: '<svg data-icon="play" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
        pause: '<svg data-icon="pause" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="7" y="5" width="3.4" height="14" rx="1"/><rect x="13.6" y="5" width="3.4" height="14" rx="1"/></svg>',
        volume: '<svg data-icon="volume" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5.5 6.5 9H3.5v6h3L11 18.5z" fill="currentColor" stroke="none"/><path d="M14.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M17 7a7 7 0 0 1 0 10"/><path d="M19.5 4.8a10.5 10.5 0 0 1 0 14.4"/></svg>',
        mute: '<svg data-icon="mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5.5 6.5 9H3.5v6h3L11 18.5z" fill="currentColor" stroke="none"/><path d="m15 9.5 5 5"/><path d="m20 9.5-5 5"/></svg>',
        visible: '<svg data-icon="visible" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
        hidden: '<svg data-icon="hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.4 10.4 0 0 1 12 19.5c-6 0-9.5-7.5-9.5-7.5a17.4 17.4 0 0 1 4.06-4.94M9.9 5.24A9.9 9.9 0 0 1 12 4.5c6 0 9.5 7.5 9.5 7.5a17.5 17.5 0 0 1-2.16 3.19"/><path d="m14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m3 3 18 18"/></svg>',
        /* 轮播：环形箭头。开启时整体高亮（.on），右键循环切换间隔 */
        rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4.5v4h4"/><path d="M4 12.5a8 8 0 0 0 13.7 5.2L20 15.5"/><path d="M20 19.5v-4h-4"/></svg>',
        /* 下一张：跳到下一首式的双三角 */
        next: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 5.5v13l8-6.5z"/><rect x="15.5" y="5.5" width="2.6" height="13" rx="1"/></svg>',
        /* 重新扫描：单向回旋箭头，与轮播的双向环形区分开 */
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="15" height="15" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.5V10h-5.5"/></svg>'
    };

    let playIcon, pauseIcon, volumeIcon, muteIcon, visibleIcon, hiddenIcon, volumeSlider;
    let rotateBtn;

    function buildPanel() {
        const actions = document.querySelector('.chat-actions');
        if (!actions) return;
        panel = document.createElement('div');
        panel.id = 'vcp-we-wallpaper-panel';
        panel.className = state.panelCollapsed ? 'collapsed' : '';
        panel.innerHTML = `
            <button type="button" class="header-button vwp-toggle" data-action="collapse" title="WE 壁纸控制（点击展开 / 右键打开壁纸库）">${icons.grid}</button>
            <div class="vwp-controls">
                <button type="button" class="vwp-ctrl" data-action="picker" title="打开壁纸库">${icons.library}</button>
                <button type="button" class="vwp-ctrl" data-action="play" title="暂停/播放">${icons.pause}${icons.play}</button>
                <button type="button" class="vwp-ctrl" data-action="mute" title="静音/取消静音">${icons.volume}${icons.mute}</button>
                <button type="button" class="vwp-ctrl" data-action="visible" title="显示/隐藏背景（不停止播放）">${icons.visible}${icons.hidden}</button>
                <button type="button" class="vwp-ctrl vwp-rotate" data-action="rotate">${icons.rotate}</button>
                <button type="button" class="vwp-ctrl" data-action="next" title="下一张壁纸">${icons.next}</button>
                <div class="vwp-volume"><input type="range" min="0" max="1" step="0.05" value="${state.volume}"></div>
            </div>`;
        actions.appendChild(panel);

        playIcon = panel.querySelector('[data-icon="play"]');
        pauseIcon = panel.querySelector('[data-icon="pause"]');
        volumeIcon = panel.querySelector('[data-icon="volume"]');
        muteIcon = panel.querySelector('[data-icon="mute"]');
        visibleIcon = panel.querySelector('[data-icon="visible"]');
        hiddenIcon = panel.querySelector('[data-icon="hidden"]');
        volumeSlider = panel.querySelector('.vwp-volume input');
        rotateBtn = panel.querySelector('[data-action="rotate"]');

        panel.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'collapse') {
                state.panelCollapsed = !state.panelCollapsed;
                panel.classList.toggle('collapsed', state.panelCollapsed);
                saveSettings();
            } else if (action === 'picker') {
                openPicker();
            } else if (action === 'play') {
                if (!state.enabled) return;
                state.playing = video.paused;
                saveSettings();
                if (state.playing) video.play().catch(() => { state.playing = false; saveSettings(); });
                else video.pause();
                updatePanel();
            } else if (action === 'mute') {
                state.muted = !state.muted;
                video.muted = state.muted;
                saveSettings();
                updatePanel();
            } else if (action === 'visible') {
                state.visible = !state.visible;
                applyVisibility({ resume: state.visible });
                saveSettings();
                updatePanel();
            } else if (action === 'rotate') {
                state.rotate = !state.rotate;
                saveSettings();
                scheduleRotate();
                updatePanel();
            } else if (action === 'next') {
                if (!rotateNext({ manual: true })) {
                    console.warn('[VCPWEWallpaperUI] 当前范围内没有可轮播的动态壁纸。');
                }
            }
        });
        panel.querySelector('[data-action="collapse"]').addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openPicker();
        });
        // 右键轮播按钮：在 ROTATE_STEPS 里循环下一档间隔，省掉一个输入框
        rotateBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const at = ROTATE_STEPS.indexOf(state.rotateMinutes);
            state.rotateMinutes = ROTATE_STEPS[(at + 1) % ROTATE_STEPS.length];
            saveSettings();
            scheduleRotate();
            updatePanel();
        });
        volumeSlider.addEventListener('input', (e) => {
            state.volume = Number(e.target.value);
            video.volume = state.volume;
            state.muted = state.volume === 0;
            video.muted = state.muted;
            saveSettings();
            updatePanel();
        });

        video.addEventListener('play', () => { state.playing = true; saveSettings(); updatePanel(); });
        video.addEventListener('pause', () => { capturePlayback(); saveSettings(); updatePanel(); });
        video.addEventListener('timeupdate', capturePlayback);
        video.addEventListener('error', () => {
            if (!state.enabled || state.switching) return;
            console.warn('[VCPWEWallpaperUI] 当前壁纸播放失败，可在壁纸库中更换。');
        });
        window.addEventListener('beforeunload', () => { capturePlayback(); saveSettings(); });
        updatePanel();
    }

    function updatePanel() {
        if (!panel) return;

        // 静态兜底态下，播放/静音/音量三个控件没有意义，直接隐藏
        const kind = resolveKind(currentWallpaper()) || state.wallpaperKind;
        const isVideo = kind === 'video';
        panel.querySelectorAll('[data-action="play"], [data-action="mute"]').forEach(btn => {
            btn.style.display = isVideo ? '' : 'none';
        });
        const volumeBox = panel.querySelector('.vwp-volume');
        if (volumeBox) volumeBox.style.display = isVideo ? '' : 'none';

        const playing = video && !video.paused && !video.ended && Boolean(video.src);
        if (playIcon) playIcon.style.display = playing ? 'none' : '';
        if (pauseIcon) pauseIcon.style.display = playing ? '' : 'none';
        if (volumeIcon) volumeIcon.style.display = state.muted || state.volume === 0 ? 'none' : '';
        if (muteIcon) muteIcon.style.display = state.muted || state.volume === 0 ? '' : 'none';
        if (visibleIcon) visibleIcon.style.display = state.visible ? '' : 'none';
        if (hiddenIcon) hiddenIcon.style.display = state.visible ? 'none' : '';
        if (volumeSlider) {
            volumeSlider.value = String(state.volume);
            volumeSlider.style.backgroundSize = `${state.volume * 100}% 100%`;
        }
        if (rotateBtn) {
            rotateBtn.classList.toggle('on', state.rotate);
            rotateBtn.title = state.rotate
                ? `轮播已开启：每 ${state.rotateMinutes} 分钟换一张（左键关闭 / 右键调间隔）`
                : `轮播已关闭（左键开启 / 右键调间隔，当前 ${state.rotateMinutes} 分钟）`;
        }
    }

    /* ═══════════════ §5 互斥协调（与辉宝插件） ═══════════════ */

    let hunbaoSuppressed = false;

    function suppressHunbao() {
        const hunbao = window.VCPFrontendPlugins?.get('vchat-dynamic-wallpaper');
        if (!hunbao || hunbaoSuppressed) return;
        hunbaoSuppressed = true;
        try {
            if (hunbao.state) {
                hunbao.state.enabled = false;      // 只改内存态，不动其 localStorage
                hunbao.state.wallpaperVisible = false;
            }
            hunbao.applyVisibility?.();
        } catch (e) { console.warn('[VCPWEWallpaperUI] 暂停辉宝壁纸失败', e); }
    }

    /* ═══════════════ §6 启动 / registry / destroy ═══════════════ */

    function create() {
        imageLayer = document.createElement('div');
        imageLayer.id = 'vcp-we-wallpaper-image';
        document.body.prepend(imageLayer);

        // web 壁纸层：iframe 提供独立文档/全局环境，壁纸自带的 body/* 选择器与
        // jQuery 之类的全局污染都被隔在里面，碰不到聊天窗口。
        webFrame = document.createElement('iframe');
        webFrame.id = 'vcp-we-wallpaper-web';
        webFrame.setAttribute('tabindex', '-1');
        webFrame.setAttribute('aria-hidden', 'true');
        webFrame.dataset.loaded = '0';
        webFrame.addEventListener('load', () => {
            if (!webFrame.getAttribute('src')) return;   // removeAttribute 触发的空 load 不算成功
            webFrame.dataset.loaded = '1';
            if (webLoadTimer) { clearTimeout(webLoadTimer); webLoadTimer = null; }
        });
        document.body.prepend(webFrame);

        video = document.createElement('video');
        video.id = 'vcp-we-wallpaper-video';
        video.playsInline = true;
        // 壁纸必须无缝循环：HTML5 video 默认播完停在最后一帧，会让背景"死掉"。
        // 这与轮播是两套机制——loop 管单张无限重播，轮播管到点换下一张。
        video.loop = true;
        // preload 默认 auto，Chromium 会尽量把整个文件缓冲进内存。
        // 实测本机视频壁纸平均 76MB、最大 205MB，auto 就是几百 MB 的白花。
        // metadata 只取时长/尺寸，播放时按 Range 流式取，画面表现无差别。
        video.preload = 'metadata';
        video.muted = state.muted;
        video.volume = state.volume;
        document.body.prepend(video);
        document.addEventListener('visibilitychange', onVisibilityChange);
        buildPanel();
        restoreSelection();
        scheduleRotate();
    }

    function pause() { video?.pause(); }
    function resume() { if (state.enabled && state.playing) video?.play().catch(() => {}); }

    function destroy() {
        capturePlayback();
        saveSettings();
        if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
        if (webLoadTimer) { clearTimeout(webLoadTimer); webLoadTimer = null; }
        document.removeEventListener('visibilitychange', onVisibilityChange);
        document.body.classList.remove('vcp-we-wallpaper-visible');
        closePicker();
        video?.remove();
        imageLayer?.remove();
        webFrame?.remove();
        panel?.remove();
        video = null; imageLayer = null; webFrame = null; panel = null; rotateBtn = null;
    }

    loadSettings();
    create();
    window.VCPFrontendPlugins?.register(ID, {
        destroy,
        pause,
        resume,
        openPicker,
        next: () => rotateNext({ manual: true }),
        setRotate(on) { state.rotate = Boolean(on); saveSettings(); scheduleRotate(); updatePanel(); },
        state,
        get active() { return document.body.classList.contains('vcp-we-wallpaper-visible'); },
        get kind() { return resolveKind(currentWallpaper()); }
    });
})();
