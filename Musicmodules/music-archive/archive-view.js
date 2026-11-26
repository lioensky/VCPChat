/*
 * 曲目档案阵列主视图：把曲库摆成 3D 档案卡阵列，文字浮在场景上。
 * 一张卡一首歌，一列一个歌单。选中、切列、检索都在这里；点「ACCESS FILE」
 * 用播放器现有的 loadTrack 播放并进入歌词舞台（播放页），Esc 退出舞台就回到这里。
 *
 * 只通过 app 上已有的函数和字段与播放器打交道：playlist、customPlaylists、
 * currentTrackIndex、isPlaying、loadTrack、playTrack、pauseTrack、renderPlaylist、
 * showContextMenu、stageHost。
 */
(function (global) {
    'use strict';

    const Model = global.MusicArchiveModel;
    const SceneLib = global.MusicArchiveScene;
    const VIEW_KEY = 'musicArchiveView';
    const LAYOUT_KEY = 'musicArchiveLayout';   // 档案页里用哪种视图：array（3D 档案阵列）/ wall（封面墙）/ grid（分节网格）
    const LAYOUTS = ['array', 'wall', 'table', 'grid'];
    const DESIGN_W = 1920, DESIGN_H = 1080;
    // 窗口再矮，界面也不缩到这个比例以下（小字 11px 缩完还有 10px 左右）；矮窗口改成少显示，不是缩小
    const MIN_SCALE = 0.9;
    const SCRIPT_BASE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    // 和 music-utils 的 app.fileUrl 一样：路径里的空格、#、?、'、% 都要编码，否则封面断图
    const fileUrl = (path) => {
        if (!path) return '';
        const p = String(path).replace(/\\/g, '/');
        return 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p).replace(/[?#']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    };

    const TEMPLATE = `
        <div class="archive-atmos" aria-hidden="true"></div>
        <div class="archive-grain" data-ref="grain" aria-hidden="true"></div>
        <div class="archive-tip" data-ref="tip" aria-hidden="true"><b></b><span></span></div>
        <div class="archive-keys" data-ref="keys" role="dialog" aria-label="快捷键" hidden><div class="archive-keys-head"><span class="archive-tiny">KEYS</span><b>快捷键</b><button type="button" data-act="keys" aria-label="关闭">×</button></div><dl><dt>↑ ↓</dt><dd>上一首 / 下一首</dd><dt>← →</dt><dd>换一组</dd><dt>PgUp PgDn</dt><dd>跳 10 首</dd><dt>Home End</dt><dd>这一组的第一首 / 最后一首</dd><dt>Enter</dt><dd>播放选中（Shift+Enter 直接进舞台）</dd><dt>空格</dt><dd>播放 / 暂停</dd><dt>/ 或直接打字</dt><dd>检索</dd><dt>Ctrl+L</dt><dd>回到正在播放</dd><dt>Shift+R</dt><dd>随机抽取</dd><dt>Shift+F10</dt><dd>选中曲目的菜单</dd><dt>Esc</dt><dd>收起 / 停下</dd></dl><p class="archive-keys-wall">封面墙 / 网格里：方向键按位置走，单击展开大卡、双击播放，PgUp PgDn 在网格里翻页，拖动或滚轮平移</p><p>再按 ? 或 Esc 关闭</p></div>
        <div class="archive-hud" data-ref="hud">
            <nav class="archive-nav" data-ref="nav">
                <button type="button" data-act="list" data-ref="listBtn" title="显示或收起左侧目录" aria-pressed="false"><span class="archive-glyph-list" aria-hidden="true"></span> 目录</button>
                <button type="button" data-act="search" title="检索曲目（/，或直接打字）"><span class="archive-glyph-search" aria-hidden="true"></span> 检索 <span class="archive-key" aria-hidden="true">/</span></button>
                <button type="button" data-act="save" title="选中曲目的操作：播放、下一首、加入歌单、转到歌手……（Shift+F10）" aria-haspopup="menu"><svg class="archive-glyph-stage" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="18.5" cy="12" r="1.9" fill="currentColor"/></svg> 操作</button>
                <button type="button" data-act="lyrics" data-ref="lyricsBtn" title="显示或收起右侧歌词" aria-pressed="false">歌词</button>
                <span class="archive-layouts" data-ref="layouts"><span class="archive-glyph-layout" aria-hidden="true"><i></i><i></i><i></i></span><select class="archive-layout-select" aria-label="视图" title="换一种看法"><option value="array">阵列</option><option value="wall">封面墙</option><option value="table">平放</option><option value="grid">网格</option><option value="classic">经典列表</option></select></span>
                <button type="button" data-act="controls" title="音效、舞台与播放设置">设置 <span aria-hidden="true">↗</span></button>
                <button type="button" data-act="stage" title="进入歌词舞台（Shift+Enter 播放选中并进舞台；回到正在播放用 Ctrl+L）"><svg class="archive-glyph-stage" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6c.55 4.9 4.5 8.85 9.4 9.4-4.9.55-8.85 4.5-9.4 9.4-.55-4.9-4.5-8.85-9.4-9.4 4.9-.55 8.85-4.5 9.4-9.4Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg> 进入舞台</button>
            </nav>
            <div class="archive-empty" role="status">
                <h2 data-ref="emptyTitle">曲库是空的</h2>
                <p data-ref="emptyText"></p>
                <div class="archive-scan-bar" aria-hidden="true"><i data-ref="scanBar"></i></div>
                <button type="button" data-act="add-local">添加音乐文件夹 <span aria-hidden="true">→</span></button>
                <button type="button" data-act="add-cloud">从云端导入 <span aria-hidden="true">→</span></button>
            </div>
            <div class="archive-bottom">
                <div class="archive-counter"><div class="archive-lanes" data-ref="lanes"><button type="button" data-act="lane-prev" title="上一组（←）" aria-label="上一组">←</button><button type="button" class="archive-lanes-name" data-act="list" title="打开目录，看全部分组"><span class="archive-tiny" data-ref="laneN"></span><b data-ref="laneName"></b></button><button type="button" data-act="lane-next" title="下一组（→）" aria-label="下一组">→</button></div><span class="archive-tiny">这一组里的位置</span><div><span data-ref="selN" class="archive-roll"></span><i>/</i><span class="archive-count-total" data-ref="selT"></span></div><div class="archive-ruler" data-ref="ruler"><button type="button" data-act="row-prev" title="上一首（↑）" aria-label="上一首">↑</button><div class="archive-ruler-track" data-ref="rulerTrack" role="slider" tabindex="-1" aria-label="这一组里的位置：按住拖动跳到别的曲目"><i class="archive-ruler-at" data-ref="rulerAt" aria-hidden="true"></i><b class="archive-ruler-tip" data-ref="rulerTip" aria-hidden="true"></b></div><button type="button" data-act="row-next" title="下一首（↓）" aria-label="下一首">↓</button></div></div>
                <footer class="archive-footer"><span class="archive-status" role="status"><i class="archive-status-light"></i> <span data-ref="status"></span></span><span>曲库 <span data-ref="files">0</span> 首</span></footer>
            </div>
        </div>`;

    const init = (app, options = {}) => {
        const root = options.root || document.getElementById('music-archive-view');
        if (!root || !Model || !SceneLib || app.archiveView) return null;
        root.innerHTML = TEMPLATE;
        const refs = {};
        root.querySelectorAll('[data-ref]').forEach((el) => { refs[el.dataset.ref] = el; });
        const returnBtn = document.getElementById('music-archive-return');

        // 降低动态：读设置里的统一开关（跟随系统 / 开 / 关）；没有那个模块时退回系统设置
        const reducedQuery = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
        const reducedMotion = () => {
            const m = global.MusicMotion;
            if (m && typeof m.reduced === 'function') return Boolean(m.reduced());
            return Boolean(reducedQuery && reducedQuery.matches);
        };
        // 样式只认 body.music-reduce-motion；统一开关不在时由这里按系统设置挂上
        const syncMotionClass = () => { if (!global.MusicMotion) document.body.classList.toggle('music-reduce-motion', reducedMotion()); };
        syncMotionClass();
        const stageConfig = global.MusicStageConfig;
        const quality = () => (stageConfig && stageConfig.get && stageConfig.get().quality) || 'standard';

        const state = {
            columns: [],
            sig: '',
            lane: 0,
            row: 0,
            playedLane: 0,           // 最近一次从哪一列开始播放
            mode: 'archive',
            layout: 'array',
            scene: null,
            raf: 0,
            wait: 0,                 // 低帧率时两帧之间用定时器等，不每个显示帧都醒一次
            lastDraw: 0,
            activity: { animated: true, idle: false },
            destroyed: false,
            coverCache: new Map(),
            dirCovers: new Map(),
            playingKey: '',
            dataRefs: { playlist: null, length: -1, playlists: null, plSig: '' }
        };

        // ---------- 数据 ----------
        const tracks = () => (Array.isArray(app.playlist) ? app.playlist : []);
        const column = () => state.columns.length ? state.columns[Model.wrap(state.lane, state.columns.length)] : null;
        const selectedIndex = () => Model.cellTrack(state.columns, state.lane, state.row);
        const selectedTrack = () => tracks()[selectedIndex()] || null;
        const playlistsSig = () => (app.customPlaylists || []).map((p) => (p && p.id) + ':' + (p && p.tracks ? p.tracks.length : 0) + ':' + (p && p.name)).join('|');

        let listTimer = 0;
        /*
         * 「曲库为空」要等一等再说：窗口刚打开时曲库还在读（通常几百毫秒），这时不显示空状态和添加入口，免得每次启动闪一下；
         * 过了这段时间还是没有歌才显示。大曲库分片重建期间（已经知道有歌，只是还没排好）也不显示，左下角写 LOADING。
         */
        const BOOT_HOLD = 1500;
        const bootUntil = performance.now() + BOOT_HOLD;
        let bootTimer = 0;
        const applyEmpty = (preparing = false) => {
            const empty = !preparing && tracks().length === 0;
            const holding = preparing || (empty && performance.now() < bootUntil && !root.classList.contains('is-scanning'));
            root.classList.toggle('is-empty', empty && !holding);
            root.classList.toggle('is-loading', holding);
            if (holding && refs.status && !root.classList.contains('is-scanning')) refs.status.textContent = preparing ? '正在整理 ' + tracks().length + ' 首曲目' : '正在读取曲库';
            else if (!holding && refs.status && /^正在(读取|整理)/.test(refs.status.textContent)) refs.status.textContent = '';
            clearTimeout(bootTimer);
            if (holding && !preparing) bootTimer = setTimeout(() => { if (!state.destroyed) applyEmpty(); }, Math.max(0, bootUntil - performance.now()) + 20);
        };
        const rebuild = ({ keep = true, track = -1, reindex = true, prepared = null, laterList = false, steady = false } = {}) => {
            // 曲库从空变成有歌（启动时异步读进来）：直接落到正在播放的那首
            if (state.dataRefs.length <= 0) keep = false;
            const keepId = keep && column() ? column().id : null;
            const keepKind = keep && column() ? column().kind : null;
            let keepIndex = keep ? selectedIndex() : track;
            // 选中的那首按路径认：曲库变了以后（扫描途中追加、扫完重排）下标会变，路径不会
            if (keep && state.selPath) {
                const k = pathIndex().get(Model.normalizePath(state.selPath));
                if (k !== undefined) keepIndex = k;
            }
            if (state.dataRefs.length <= 0) steady = false;
            const firstData = state.dataRefs.length <= 0 && tracks().length > 0;
            // 只换排序时曲库没变，检索索引（拼音、罗马音）不用重建
            if (prepared && prepared.index && prepared.list === app.playlist && prepared.index.size === tracks().length) searchIndex = prepared.index;
            else if (reindex || !searchIndex || searchIndex.size !== tracks().length) rebuildIndex();
            const columns = buildColumns(prepared);
            state.columns = columns;
            state.sig = Model.signature(columns);
            state.dataRefs = { playlist: app.playlist, length: tracks().length, playlists: app.customPlaylists, plSig: playlistsSig() };

            let lane = 0, row = 0;
            const placed = tracks().length ? restorePlace(columns) : null;
            const byId = !placed && keepId ? columns.findIndex((c) => c.id === keepId) : -1;
            if (placed) {
                lane = placed.lane; row = placed.row;
            } else if (byId !== -1) {
                lane = byId;
                const r = keepIndex >= 0 ? columns[byId].items.indexOf(keepIndex) : -1;
                row = r !== -1 ? r : Math.min(state.row, Math.max(0, columns[byId].items.length - 1));
            } else {
                // 原来那一列没了（歌变多以后首字母列会拆开或改名）：先在同一类的列里找这首歌
                let at = null;
                if (keepKind && keepIndex >= 0) {
                    const l = columns.findIndex((c) => c.kind === keepKind && c.items.includes(keepIndex));
                    if (l !== -1) at = { lane: l, row: columns[l].items.indexOf(keepIndex) };
                }
                at = at || Model.locate(columns, keepIndex >= 0 ? keepIndex : app.currentTrackIndex, 0);
                if (at) { lane = at.lane; row = at.row; }
            }
            state.lane = lane;
            state.row = row;
            const col0 = columns[lane];
            if (col0 && col0.items.length) focusByColumn.set(col0.id, Model.wrap(row, col0.items.length));
            state.scene?.jump(lane, row);
            state.scene?.refreshLabels?.();
            applyEmpty();
            refs.files.textContent = String(tracks().length);
            if (firstData && !pendingPlace && !placed) { placeSettled = true; followUntil.t = performance.now() + 4000; }
            renderHud();
            updatePlaying(true);
            // 大曲库分片重建时，目录（两万行的分组和排序）放到下一片再排
            if (laterList && list) { clearTimeout(listTimer); listTimer = setTimeout(() => { listTimer = 0; if (state.destroyed) return; list.rebuild({ steady }); syncList(steady); }, 0); }
            else { clearTimeout(listTimer); listTimer = 0; list?.rebuild({ steady }); syncList(steady); }
            schedulePlace();
        };

        /*
         * 上次的位置：视图（档案页、经典视图、播放页）、选中的列和那张卡，重启后回到原位，不自动播放。
         * 曲库、歌单、拼音表都是启动后陆续到的：曲库到了之后最多等 5 秒，等到那一列出现再落位；
         * 用户先动了就不再恢复。播放器自己恢复上次那首（不播放），这里只读它的 currentTrackIndex。
         */
        const PLACE_KEY = 'musicArchivePlace';
        const PLACE_WAIT = 5000;
        let pendingPlace = null;
        try {
            const p = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null');
            if (p && typeof p === 'object') pendingPlace = p;
        } catch (e) { pendingPlace = null; }
        let placeDeadline = 0;
        let placeSettled = false;     // 已经落过位（或放弃了），之后才记新的位置
        const followUntil = { t: 0 }; // 没有记录时：启动后几秒内选中跟着播放器恢复的那首走
        const settlePlace = ({ stage = false } = {}) => {
            const p = pendingPlace;
            pendingPlace = null;
            placeSettled = true;
            if (stage && p && p.stage) {
                // 上次停在播放页：曲库到了、当前那首在，就回到播放页（不播放）
                setTimeout(() => {
                    if (state.destroyed || !tracks()[app.currentTrackIndex]) return;
                    if (app.stageHost && !app.stageHost.active) { try { app.stageHost.enter(); } catch (e) { /* 舞台没准备好就留在这里 */ } }
                }, 0);
            }
        };
        const restorePlace = (columns) => {
            if (!pendingPlace) return null;
            const now = performance.now();
            if (!placeDeadline) placeDeadline = now + PLACE_WAIT;
            const p = pendingPlace;
            const lane = typeof p.col === 'string' ? columns.findIndex((c) => c.id === p.col) : -1;
            const want = typeof p.path === 'string' ? Model.normalizePath(p.path) : '';
            const indexOfPath = want ? tracks().findIndex((t) => Model.normalizePath(t && t.path) === want) : -1;
            let at = null;
            if (lane !== -1) {
                const items = columns[lane].items;
                const r = indexOfPath >= 0 ? items.indexOf(indexOfPath) : -1;
                at = { lane, row: r !== -1 ? r : Math.max(0, Math.min(items.length - 1, Number(p.row) || 0)) };
            } else if (indexOfPath >= 0) {
                at = Model.locate(columns, indexOfPath, 0);
            }
            if ((at && lane !== -1) || now > placeDeadline) settlePlace({ stage: true });
            return at;
        };
        const savePlace = () => {
            if (!placeSettled || !state.columns.length || !tracks().length) return;
            const col = column();
            const t = selectedTrack();
            const place = {
                mode: state.mode,
                stage: document.body.classList.contains('music-stage-active'),
                col: col ? col.id : null,
                row: col && col.items.length ? Model.wrap(state.row, col.items.length) : 0,
                path: t ? t.path : null
            };
            try { localStorage.setItem(PLACE_KEY, JSON.stringify(place)); } catch (e) { /* 只是记住 */ }
        };
        let placeTimer = 0;
        const schedulePlace = () => { clearTimeout(placeTimer); placeTimer = setTimeout(savePlace, 400); };

        /*
         * 阵列的列：曲库够大时「全部曲目」按首字母拆成 A、B…あ行…0–9、其他几列（歌少的相邻字母合并），
         * 前面有数据时加「最近播放」「收藏」；后面是歌单和专辑。
         */
        const LETTER_SPLIT_MIN = 40;
        const LETTER_MIN_SIZE = 4;
        let letterOf = null;          // 首字母 → 列 id
        const favoritePaths = () => (Array.isArray(app.favoriteTracks) ? app.favoriteTracks : []).map((t) => (typeof t === 'string' ? t : t && t.path)).filter(Boolean);
        // 路径（归一化后）→ 曲库下标，同一份曲库只建一次；建列、最近播放、收藏都用它
        let pathMemo = { list: null, n: -1, map: new Map() };
        const pathIndex = () => {
            if (pathMemo.list !== app.playlist || pathMemo.n !== tracks().length) pathMemo = { list: app.playlist, n: tracks().length, map: Model.pathIndex(tracks()) };
            return pathMemo.map;
        };
        /* 算出各列和「首字母 → 列」的对照，不改任何状态（分片重建时可以提前算好） */
        const computeColumns = (index) => {
            const base = Model.buildColumns(tracks(), app.customPlaylists, { indexByPath: pathIndex() });
            let letters0 = null;
            // 「全部曲目」用全局顺序（和目录一致），不用扫描顺序
            const spec = sortSpecFor(index);
            if (spec) base[0].items = IndexLib.sortedIndices(index, base[0].items, spec);
            const n = tracks().length;
            if (n < LETTER_SPLIT_MIN || !spec) return { columns: base, letterOf: null };
            const letters = IndexLib.groupColumns(index, base[0].items, { minSize: LETTER_MIN_SIZE, spec });
            letters0 = new Map();
            for (const c of letters) for (const g of c.groups) letters0.set(g, c.id);
            const front = [];
            // 每日推荐（按听歌记录和喜欢挑的 30 首，一天内固定）：放在最前面一列，和最近播放、收藏一样是一组卡
            const daily = dailyIndices();
            if (daily.length) front.push({ id: 'daily', kind: 'daily', name: '每日推荐', ref: 'DAILY', items: daily });
            const recent = recentIndices();
            if (recent.length) front.push({ id: 'recent', kind: 'recent', name: '最近播放', ref: 'RECENT FILES', items: recent });
            const fav = favoritePaths();
            if (fav.length) {
                const byPath = pathIndex();
                const items = fav.map((p) => byPath.get(Model.normalizePath(p))).filter((i) => i !== undefined);
                if (items.length) front.push({ id: 'favorite', kind: 'favorite', name: '收藏', ref: 'SAVED FILES', items });
            }
            return { columns: [...front, ...letters, ...base.slice(1)], letterOf: letters0 };
        };
        const dailyIndices = () => {
            let mix = [];
            try { mix = typeof app.dailyMix === 'function' ? app.dailyMix() || [] : []; } catch (e) { mix = []; }
            if (!mix.length) return [];
            const byPath = pathIndex();
            return mix.map((t) => byPath.get(Model.normalizePath(t && t.path))).filter((i) => i !== undefined);
        };
        // 每日推荐跨天、换一批都会换：批号也算进列的指纹
        const dailyKey = () => (typeof app.dailyMix !== 'function' ? '' : typeof app.dailyMixKey === 'function' ? app.dailyMixKey() : new Date().toISOString().slice(0, 10));
        const columnsKey = () => dailyKey() + '\n' + sortMode + '\n' + playlistsSig() + '\n' + recentPaths.join('|') + '\n' + favoritePaths().join('|');
        const buildColumns = (prepared = null) => {
            const out = prepared && prepared.cols && prepared.colsKey === columnsKey() && prepared.index === searchIndex ? prepared.cols : computeColumns(searchIndex);
            letterOf = out.letterOf;
            return out.columns;
        };
        const columnOfGroup = (g) => (letterOf && letterOf.get(g)) || 'all';

        /*
         * 扫描曲库的过程：主进程先报总数、再逐首报进度、扫完才把曲目一次交过来，
         * 所以这里显示的是进度（空曲库时占中间的位置，有歌时写在左下角状态里），阵列在扫完那一刻换上新曲库。
         */
        const EMPTY_TEXT = '曲库里还没有歌曲。添加本地文件夹或从云端导入后，这里会按首字母和歌单排成档案阵列。';
        const scan = { active: false, current: 0, total: 0, timer: 0 };
        const renderScan = () => {
            root.classList.toggle('is-scanning', scan.active);
            const total = scan.total;
            // 不补零（0437 这种是装饰写法）；数字等宽，跳动时宽度不变
            const progress = total ? Math.max(0, Math.round(scan.current)) + ' / ' + total : '';
            refs.emptyTitle.textContent = scan.active ? '正在扫描曲库' : '曲库是空的';
            refs.emptyText.textContent = scan.active
                ? (total ? '正在读取曲目信息 ' + progress + '，读完后这里会排成档案阵列。' : '正在查找音乐文件…')
                : EMPTY_TEXT;
            refs.scanBar.style.transform = `scaleX(${total ? Math.min(1, scan.current / total) : 0})`;
            if (scan.active) refs.status.textContent = total ? '扫描中 ' + progress : '正在查找音乐文件';
            else if (!scan.timer) refs.status.textContent = '';
        };
        const setScan = (next) => {
            Object.assign(scan, next);
            renderScan();
            if (root.classList.contains('is-loading') && tracks().length === 0) applyEmpty();
        };
        const scanDone = (data) => {
            const got = Array.isArray(data) ? data.length : (data && Array.isArray(data.tracks) ? data.tracks.length : 0);
            clearTimeout(scan.timer);
            setScan({ active: false });
            refs.status.textContent = got ? '扫描完成，共 ' + got + ' 首' : '扫描完成，没有找到音乐文件';
            scan.timer = setTimeout(() => { scan.timer = 0; renderScan(); }, 4000);
        };
        let growTimer = 0;
        const scanOff = [
            app.api?.onMusicScanStart?.((data) => setScan({ active: true, current: 0, total: Number(data && data.total) || 0 })),
            app.api?.onMusicScanProgress?.((data) => setScan({ active: true, current: Number(data && data.current) || 0, total: Number(data && data.total) || scan.total })),
            app.api?.onMusicScanComplete?.(scanDone),
            // 扫描途中播放器会把新读到的曲目一批批接到曲库末尾：阵列和目录跟着长（歌多时隔久一点再排）。
            // 旧的主进程不发这个事件，那就和以前一样扫完一次换上。
            app.api?.onMusicScanBatch?.(() => {
                if (growTimer) return;
                growTimer = setTimeout(() => { growTimer = 0; if (!state.destroyed && isShown() && dataChanged()) rebuildSoon(); }, tracks().length > 5000 ? 1500 : 500);
            })
        ];
        renderScan();

        const dataChanged = () => {
            const d = state.dataRefs;
            return d.playlist !== app.playlist || d.length !== tracks().length || d.playlists !== app.customPlaylists || d.plSig !== playlistsSig();
        };

        // ---------- HUD ----------
        const rollTo = (el, str) => {
            if (el.childElementCount !== str.length) {
                el.innerHTML = [...str].map(() => `<span class="d"><span>${'0123456789'.split('').map((n) => `<b>${n}</b>`).join('')}</span></span>`).join('');
            }
            [...el.children].forEach((c, i) => {
                const s = c.firstChild;
                const next = `translateY(-${(+str[i] || 0) * 1.1}em)`;
                if (s.style.transform !== next) s.style.transform = next;
            });
        };

        const renderHud = () => {
            const col = column();
            if (!col) return;
            const count = col.items.length;
            const r = count ? Model.wrap(state.row, count) : 0;
            const index = selectedIndex();
            const t = tracks()[index];
            state.selPath = t ? t.path : null;
            const hasTrack = Boolean(t);
            const layoutChanged = refs.hud.classList.contains('has-track') !== hasTrack;
            refs.hud.classList.toggle('has-track', hasTrack);
            if (layoutChanged) syncSceneLayout();
            const digits = Math.max(2, String(count).length);
            rollTo(refs.selN, pad(count ? r + 1 : 0, digits));
            refs.selT.textContent = pad(count, digits);
            renderRuler(col, count, r);
            renderLanes(col);
            syncCard();
            flat()?.sync();
        };

        /*
         * 索引标尺（借鉴 RhinE 档案页阵列下方的刻度尺）：一组里的曲目摊成一排细刻线，
         * 多于刻线数时每根代表相等的一段；当前位置是一根高的强调色刻线。
         * 悬停在上面显示那一格的曲名，按住左右拖动一路选过去，松手停下；两头的 ↑ ↓ 逐首走。
         */
        /* 分组切换（借鉴 RhinE 阵列下方的「← SHELF 04 / 31  名称 →」）：目录收起时也知道自己在哪一组、能换组 */
        const renderLanes = (col) => {
            const n = state.columns.length;
            if (!refs.lanes) return;
            refs.lanes.hidden = n < 2;
            if (n < 2) return;
            const d = Math.max(2, String(n).length);
            refs.laneN.textContent = `组 ${pad(Model.wrap(state.lane, n) + 1, d)} / ${pad(n, d)}`;
            refs.laneName.textContent = col.name || '';
        };
        const RULER_TICKS = 32;
        let rulerKey = '';
        const rulerTicks = (count) => Math.min(count, RULER_TICKS);
        const renderRuler = (col, count, r) => {
            const el = refs.ruler;
            if (!el) return;
            el.hidden = count < 2;
            if (count < 2) return;
            const n = rulerTicks(count);
            const key = col.id + ':' + count;
            if (key !== rulerKey) {
                rulerKey = key;
                refs.rulerTrack.style.setProperty('--ticks', n);
                // 刻线用真元素画：HUD 整体缩放后，1px 的重复渐变会有几根被吃掉
                refs.rulerTrack.querySelectorAll('.archive-ruler-tick').forEach((x) => x.remove());
                const frag = document.createDocumentFragment();
                for (let i = 0; i < n; i++) { const t = document.createElement('s'); t.className = 'archive-ruler-tick'; t.style.left = ((i + 0.5) / n * 100).toFixed(3) + '%'; frag.appendChild(t); }
                refs.rulerTrack.insertBefore(frag, refs.rulerAt);
                refs.rulerTrack.setAttribute('aria-valuemin', '1');
                refs.rulerTrack.setAttribute('aria-valuemax', String(count));
            }
            // 刻线 i 管 [i*count/n, (i+1)*count/n) 这几首；位置线按所在那一段的中点放
            const tick = Math.min(n - 1, Math.floor(r * n / count));
            refs.rulerAt.style.setProperty('--at', ((tick + 0.5) / n).toFixed(4));
            refs.rulerTrack.setAttribute('aria-valuenow', String(r + 1));
        };
        const rulerRowAt = (clientX) => {
            const col = column();
            const count = col ? col.items.length : 0;
            if (count < 2) return -1;
            const box = refs.rulerTrack.getBoundingClientRect();
            const f = Math.min(0.9999, Math.max(0, (clientX - box.left) / Math.max(1, box.width)));
            const n = rulerTicks(count);
            const tick = Math.floor(f * n);
            // 一根刻线代表好几首时，按刻线内的位置细分，拖动时能走到每一首
            return Math.min(count - 1, Math.floor((tick + (f * n - tick)) * count / n));
        };
        const rulerTipAt = (clientX) => {
            const row = rulerRowAt(clientX);
            const col = column();
            const t = row >= 0 && col ? tracks()[col.items[row]] : null;
            if (!t) { refs.rulerTip.classList.remove('on'); refs.rulerTrack.classList.remove('hovering'); return; }
            // 悬停的那一格先亮一根细线（借鉴 RhinE 刻度尺的 hoverTick），松手或点下去才真的选过去
            const hn = rulerTicks(col.items.length);
            refs.rulerTrack.style.setProperty('--hover', ((Math.min(hn - 1, Math.floor(row * hn / col.items.length)) + 0.5) / hn).toFixed(4));
            refs.rulerTrack.classList.add('hovering');
            const box = refs.rulerTrack.getBoundingClientRect();
            refs.rulerTip.textContent = pad(row + 1, Math.max(2, String(col.items.length).length)) + '  ' + (Model.stripExtension(t.title) || '未知标题');
            // HUD 整体按设计稿缩放过：屏幕像素换回标尺自己的像素
            const k = refs.rulerTrack.offsetWidth / Math.max(1, box.width);
            refs.rulerTip.style.left = Math.round(Math.min(box.width, Math.max(0, clientX - box.left)) * k) + 'px';
            refs.rulerTip.classList.add('on');
        };
        const bindRuler = () => {
            const track = refs.rulerTrack;
            if (!track) return;
            let dragging = false;
            track.addEventListener('pointermove', (e) => {
                rulerTipAt(e.clientX);
                if (dragging) { const row = rulerRowAt(e.clientX); if (row >= 0) goRow(row, { pulse: false }); }
            });
            track.addEventListener('pointerleave', () => { if (!dragging) { refs.rulerTip.classList.remove('on'); track.classList.remove('hovering'); } });
            track.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                dragging = true;
                track.setPointerCapture?.(e.pointerId);
                track.classList.add('drag');
                stopInertia();
                const row = rulerRowAt(e.clientX);
                if (row >= 0) goRow(row);
            });
            const end = (e) => {
                if (!dragging) return;
                dragging = false;
                track.classList.remove('drag');
                track.releasePointerCapture?.(e.pointerId);
                if (e.type === 'pointercancel' || !track.matches(':hover')) refs.rulerTip.classList.remove('on');
            };
            track.addEventListener('pointerup', end);
            track.addEventListener('pointercancel', end);
        };


        // 档案号和列表、舞台用同一套（按路径算的稳定编号）；没有那套时退回曲库序号
        const fileNumber = (t, index) => {
            const specs = global.MusicTrackSpecs;
            const n = specs && typeof specs.fileNumber === 'function' ? specs.fileNumber(t) : '';
            if (n) return /^TRK/i.test(n) ? n : 'TRK-' + n;
            return 'TRK-' + Model.fileCode(index);
        };

        /*
         * 封面：只给选中的那张加载，停稳 120ms 后再取，同时预取前后两首。
         * 曲库里带了封面（内嵌封面扫描时已存成文件）就用它；没有的话试同目录下常见的封面图（cover / folder / front），
         * 每个目录只试一次。图片缓存最多 64 张、目录结果最多 256 条；读不出来的就保留写有曲名的卡面。
         */
        const COVER_NAMES = ['cover.jpg', 'folder.jpg', 'cover.png', 'front.jpg', 'folder.png', 'Cover.jpg', 'Folder.jpg'];
        const dirOf = (t) => {
            const p = String((t && t.path) || '');
            if (!p || /^[a-z][a-z0-9+.-]{2,}:\/\//i.test(p)) return ''; // 远程曲目没有本地目录
            const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
            return cut > 0 ? p.slice(0, cut) : '';
        };
        const capped = (map, key, value, max) => {
            map.set(key, value);
            if (map.size > max) map.delete(map.keys().next().value);
            return value;
        };
        const probeDir = (dir) => {
            const entry = capped(state.dirCovers, dir, { url: null }, 256);
            let k = 0;
            const next = () => {
                if (k >= COVER_NAMES.length) { entry.url = ''; return; }
                const url = fileUrl(dir + '/' + COVER_NAMES[k++]);
                const img = new Image();
                img.decoding = 'async';
                img.onload = () => {
                    entry.url = url;
                    capped(state.coverCache, url, { img, ok: true }, 64);
                    const t = selectedTrack();
                    if (t && !t.albumArt && dirOf(t) === dir) syncCard();
                    flat()?.coverFound();
                };
                img.onerror = next;
                img.src = url;
            };
            next();
        };
        const coverOf = (t, probe = false) => {
            if (!t) return '';
            if (t.albumArt) return fileUrl(t.albumArt);
            const dir = dirOf(t);
            if (!dir) return '';
            const known = state.dirCovers.get(dir);
            if (known) return known.url || '';
            if (probe) probeDir(dir);
            return '';
        };
        const COVER_MAX = 512;
        const shrinkCover = (entry) => {
            const img = entry.img;
            const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
            if (Math.max(w, h) <= COVER_MAX || typeof global.createImageBitmap !== 'function') return Promise.resolve();
            const k = COVER_MAX / Math.max(w, h);
            const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
            return global.createImageBitmap(img, { resizeWidth: cw, resizeHeight: ch, resizeQuality: 'high' }).then((bmp) => {
                const c = document.createElement('canvas');
                c.width = cw; c.height = ch;
                c.getContext('2d').drawImage(bmp, 0, 0);
                bmp.close?.();
                entry.small = c;
            }).catch(() => { /* 缩不了就用原图 */ });
        };
        const preload = (url) => {
            if (!url || state.coverCache.has(url)) return;
            const img = new Image();
            img.decoding = 'async';
            const entry = { img, ok: null };
            img.onload = () => {
                // 大封面先在后台缩成最长边 512（卡面贴图就是 512）再交给场景：原图画进贴图后，解码出来的整张图
                // 会跟着缓存里的图片对象一直留着。缩好之前和以前加载中一样显示曲名卡面。
                shrinkCover(entry).then(() => {
                    entry.ok = true;
                    if (!state.destroyed && coverOf(selectedTrack()) === url) syncCard();
                });
            };
            img.onerror = () => { entry.ok = false; };
            img.src = url;
            capped(state.coverCache, url, entry, 64);
        };
        let cardExpanded = true;
        /*
         * 借鉴 RhinE「鼠标不动、档案在它下面移动后重新找一次指着的那张」：键盘、标尺、滚轮换了选中后，
         * 镜头停稳时按鼠标最后的位置重新判一次悬停，高亮不会还挂在原来那张卡上。只改悬停和光标，不弹提示。
         */
        let lastPtr = null, rehoverTimer = 0;
        let picking = false;   // 随机抽取正在跑（pick 在后面才声明，select 里用这个）
        const rehover = () => {
            rehoverTimer = 0;
            const sc = state.scene;
            if (!lastPtr || !sc || !sc.canvas || wheelBrowsing || turning || (plane && plane.active)) return;
            const rect = sc.canvas.getBoundingClientRect();
            const d = sc.detailRect && sc.detailRect();
            const x = lastPtr.x - rect.left, y = lastPtr.y - rect.top;
            if (d && x >= d.left && x <= d.right && y >= d.top && y <= d.bottom) return;
            const c = sc.pick(lastPtr.x, lastPtr.y, rect);
            sc.setHover(c);
            const browsing = !cardExpanded && !sc.detail;
            sc.canvas.style.cursor = c && Model.cellTrack(state.columns, c.lane, c.row) >= 0 ? 'pointer' : browsing ? 'grab' : '';
            kick();
        };
        const rehoverSoon = () => {
            if (!lastPtr) return;
            clearTimeout(rehoverTimer);
            rehoverTimer = setTimeout(rehover, reducedMotion() ? 0 : 420);
        };
        let wheelBrowsing = false;
        const syncCard = () => {
            if (!state.scene || state.destroyed) return;
            const t = selectedTrack();
            const expanded = Boolean(t) && cardExpanded && !wheelBrowsing;
            state.scene.setDetail(expanded);
            kick();
            if (!expanded) return;
            const url = coverOf(t, true);
            preload(url);
            const entry = state.coverCache.get(url);
            const title = Model.stripExtension(t.title) || '未知标题';
            const artist = t.artist || '';
            const specs = global.MusicTrackSpecs;
            const format = specs?.format(t) || '';
            const bitrate = specs?.bitrate(t) || '';
            const key = JSON.stringify([t.path, title, artist, format, bitrate, entry?.ok ? url : '', document.body.classList.contains('light-theme')]);
            state.scene.setCover(key, entry?.ok ? (entry.small || entry.img) : null, { title, artist, format, bitrate });
        };
        const setCardExpanded = (on) => {
            cardExpanded = on;
            syncCard();
        };

        // ---------- 选中与播放 ----------
        /*
         * 选中移动的速度：供外部动效使用。
         * onMotion(fn) 每次换选中回调 fn({ axis: 'row' | 'lane', velocity, fraction })，
         * velocity 按最近 160ms 的移动估算（行或列/秒，有符号），fraction 是在这一列里的位置（0..1）。
         */
        const motionListeners = new Set();
        let motionSamples = [];
        const emitMotion = (dLane, dRow) => {
            if (!motionListeners.size) return;
            const t = performance.now();
            motionSamples.push([t, dLane, dRow]);
            motionSamples = motionSamples.filter((x) => t - x[0] <= 160);
            const span = Math.max(0.06, (t - motionSamples[0][0]) / 1000);
            const sum = motionSamples.reduce((a, x) => [a[0] + x[1], a[1] + x[2]], [0, 0]);
            const axis = dLane ? 'lane' : 'row';
            const col = column();
            const count = col ? col.items.length : 0;
            const info = { axis, velocity: (axis === 'lane' ? sum[0] : sum[1]) / span, fraction: count > 1 ? Model.wrap(state.row, count) / (count - 1) : 0 };
            for (const fn of motionListeners) { try { fn(info); } catch (e) { /* 外面的动效出错不影响选中 */ } }
        };
        const select = (lane, row, { pulse = true } = {}) => {
            if (!state.columns.length) return;
            if (pendingPlace && tracks().length) settlePlace();
            followUntil.t = 0;
            if (lane === state.lane && row === state.row) return;
            const dLane = lane - state.lane, dRow = row - state.row;
            state.lane = lane;
            state.row = row;
            emitMotion(dLane, dRow);
            refs.tip.classList.remove('on');
            const col = column();
            if (col && col.items.length) focusByColumn.set(col.id, Model.wrap(row, col.items.length));
            state.scene?.select(lane, row, { pulse });
            renderHud();
            // 随机抽取跑着时左侧目录先不跟（借鉴 RhinE：抽取途中资料面板不动，落定才显示）：
            // 每一跳都换分组、滚列表又费又晃，停下或被打断时再一次对齐
            if (!picking) syncList();
            schedulePlace();
            kick();
            rehoverSoon();
        };

        /* 每一列记住上次停在第几首：换列回来时回到那一首（第一次进某列时保持行号） */
        const focusByColumn = new Map();
        const stepLane = (dl, opts) => {
            const n = state.columns.length;
            if (!n || !dl) return;
            const lane = state.lane + dl;
            const col = state.columns[Model.wrap(lane, n)];
            const remembered = col ? focusByColumn.get(col.id) : undefined;
            let row = state.row;
            if (col && col.items.length && remembered !== undefined) {
                const m = col.items.length;
                row = remembered + m * Math.round((state.row - remembered) / m);
            }
            select(lane, row, opts);
        };
        const fmtDur = (sec) => {
            sec = Math.round(Number(sec) || 0);
            if (!(sec > 0)) return '';
            const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
            return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(x);
        };
        const trackDuration = (t) => (Number(t && t.duration) > 0 ? Number(t.duration) : durationOf(t));
        /* 整个曲库按当前排序的顺序（就是阵列里从左到右、从上到下看到的顺序） */
        const libraryOrder = () => {
            const letters = state.columns.filter((c) => c.kind === 'letter');
            if (letters.length) return letters.flatMap((c) => c.items);
            const all = state.columns.find((c) => c.kind === 'all');
            return all ? all.items : tracks().map((_, i) => i);
        };
        /*
         * 设队列并播放：播放器有统一点播入口（playFromContext）就走它，
         * 之后换排序时能用 reorderContext 跟着换顺序；没有时退回直接设 currentFilteredTracks。
         */
        const startQueue = (items, index, source, name) => {
            const list = items.map((i) => tracks()[i]).filter(Boolean);
            state.playedLane = state.lane;
            setQueueName(name);
            if (typeof app.playFromContext === 'function') {
                app.playFromContext(list, index, { source, origin: 'archive' });
                return;
            }
            const whole = list.length === tracks().length && list.every((t, i) => t === tracks()[i]);
            app.currentFilteredTracks = whole ? null : list;
            app.filteredPlaylistSource = source;
            try { app.renderPlaylist?.(app.currentFilteredTracks); } catch (e) { /* 旧列表只是同步显示，失败不影响播放 */ }
            app.loadTrack(index, true);
        };
        /* 换了排序：正在放的还是从档案页点的整个曲库，就换成新顺序，不打断播放 */
        const followSort = () => {
            if (typeof app.reorderContext !== 'function' || !app.contextFrom?.('archive')) return;
            app.reorderContext(libraryOrder().map((i) => tracks()[i]).filter(Boolean), 'archive');
        };

        const playSelected = ({ stage = false, group = null, resume = !group } = {}) => {
            const col = column();
            const index = selectedIndex();
            if (!col || index < 0) return;
            const already = index === app.currentTrackIndex && (app.isPlaying || app.playIntent);
            if (!already && resume && index === app.currentTrackIndex && app.playTrack) {
                app.playTrack();
            } else if (!already && group && group.items.includes(index)) {
                // 从目录的某一组点播（歌手、专辑、最近、检索结果）：队列就是看到的这一组
                startQueue(group.items, index, { type: 'archive-group', name: group.name }, group.name);
            } else if (!already) {
                // 播放队列跟着所在的列走，按阵列里看到的顺序：
                // 按首字母（或排序方式）拆开的列，队列是整个曲库按当前排序接着放；其他列是这一列的曲目
                const source = col.kind === 'playlist' ? { type: 'playlist', name: col.name, id: col.playlistId }
                    : col.kind === 'album' ? { type: 'album', name: col.name } : null;
                const whole = col.kind === 'letter' || col.kind === 'all';
                startQueue(whole ? libraryOrder() : col.items, index, source, whole ? '全部曲目' : col.name);
            }
            setCardExpanded(true);
            updatePlaying();
            if (stage && app.stageHost && !app.stageHost.active) app.stageHost.enter();
        };

        const goToPlaying = () => {
            const at = Model.locate(state.columns, app.currentTrackIndex, Model.wrap(state.playedLane, state.columns.length || 1));
            if (!at) return;
            const n = state.columns.length;
            const lane = at.lane + n * Math.round((state.lane - at.lane) / n);
            const m = state.columns[at.lane].items.length;
            const row = at.row + m * Math.round((state.row - at.row) / m);
            select(lane, row);
        };

        // 正在播放那张卡：在当前视野里找最近的一格
        const updatePlaying = (force = false) => {
            const key = app.currentTrackIndex + ':' + Boolean(app.isPlaying) + ':' + Boolean(app.playIntent) + ':' + state.sig;
            if (!force && key === state.playingKey) return;
            state.playingKey = key;
            // 还没放过歌时底栏不写「正在播放 全部曲目」（没有在播放的东西）
            const queueEl = refs.queue?.parentElement;
            if (queueEl) queueEl.hidden = !tracks()[app.currentTrackIndex];
            // 跟着在听：选中停在正在放的那首时，播放器换到下一首（自动接下一首、底栏的上一首/下一首），
            // 选中和目录跟过去，歌词面板留着；在看别的歌时不打扰
            flat()?.sync();
            const prevPlaying = state.playingIndex;
            state.playingIndex = app.currentTrackIndex;
            if (prevPlaying !== undefined && prevPlaying !== app.currentTrackIndex
                && selectedIndex() === prevPlaying && tracks()[app.currentTrackIndex]) {
                goToPlaying();
            }
            // 启动时播放器晚一点才恢复上次那首：用户还没动过，就直接落到那张卡（不飞过去）
            if (!pendingPlace && followUntil.t && performance.now() < followUntil.t && selectedIndex() !== app.currentTrackIndex) {
                const at0 = Model.locate(state.columns, app.currentTrackIndex, 0);
                if (at0) {
                    state.lane = at0.lane; state.row = at0.row;
                    state.scene?.jump(at0.lane, at0.row);
                    renderHud();
                    syncList();
                }
            }
            const at = Model.locate(state.columns, app.currentTrackIndex, Model.wrap(state.playedLane, state.columns.length || 1));
            let cell = null;
            if (at) {
                const n = state.columns.length, m = state.columns[at.lane].items.length;
                cell = { lane: at.lane + n * Math.round((state.lane - at.lane) / n), row: at.row + m * Math.round((state.row - at.row) / m) };
            }
            state.scene?.setPlaying(cell, app.isPlaying);
            list?.setPlaying(app.currentTrackIndex);
            syncLyrics();
            if (recordRecent()) {
                if (letterOf) queueMicrotask(() => { if (!state.destroyed) rebuild(); });
                else if (list && list.kind === 'recent') list.rebuild();
            }
            kick();
        };

        // ---------- 目录列表与检索索引 ----------
        const IndexLib = global.MusicArchiveIndex;
        const ListLib = global.MusicArchiveList;
        const pinyinCache = new Map();
        let pinyinFn = null; // 同一份拼音表始终是同一个函数，条目缓存靠它判断拼音有没有变
        const pinyinOf = () => {
            const lib = global.pinyinPro;
            if (!lib || typeof lib.pinyin !== 'function') return null;
            if (pinyinFn && pinyinFn.lib === lib) return pinyinFn;
            pinyinFn = (c) => {
                if (!pinyinCache.has(c)) {
                    let p = '';
                    try { p = lib.pinyin(c, { toneType: 'none' }); } catch (e) { p = ''; }
                    pinyinCache.set(c, p);
                }
                return pinyinCache.get(c);
            };
            pinyinFn.lib = lib;
            return pinyinFn;
        };
        let searchIndex = null;
        const entryCache = new Map();
        const rebuildIndex = () => { searchIndex = IndexLib ? IndexLib.createIndex(tracks(), { pinyin: pinyinOf(), cache: entryCache }) : null; };

        /*
         * 曲库整体变了（读进来、扫完、拼音表到了）之后的重建。大曲库的检索条目（拼音、罗马音）是最慢的一步，
         * 先分片算进缓存（每片最多 8ms，片与片之间让出线程，输入不被卡住），算完再一次重建；
         * 小曲库或者缓存已经是热的（只多了几首歌）就当场重建。
         */
        const WARM_ABOVE = 1500;
        let warming = null;
        const rebuildSoon = () => {
            const list = tracks();
            if (!IndexLib || !IndexLib.warm || list.length <= WARM_ABOVE) { warming = null; rebuild({ steady: true }); return; }
            if (warming && warming.list === app.playlist && warming.n === list.length) return;
            const job = warming = { list: app.playlist, n: list.length, at: 0, pinyin: pinyinOf() };
            if (state.dataRefs.length <= 0) applyEmpty(true); // 从空到有：先把空状态收起来
            const later = () => setTimeout(slice, 0);
            const slice = () => {
                if (state.destroyed || warming !== job) return;
                if (job.list !== app.playlist || job.n !== tracks().length) { warming = null; rebuildSoon(); return; }
                // 一片只做一件事：算条目（可能要很多片）→ 建索引 → 排名次（可能几片）→ 重建阵列 → 目录（rebuild 里再排一片）
                if (job.at !== -1) {
                    job.at = IndexLib.warm(tracks(), { pinyin: job.pinyin, cache: entryCache, from: job.at, budgetMs: 8 });
                    return later();
                }
                if (!job.index) {
                    job.index = IndexLib.createIndex(tracks(), { pinyin: job.pinyin, cache: entryCache });
                    job.sort = IndexLib.prepareSort ? IndexLib.prepareSort(job.index, sortMode) : () => true;
                    return later();
                }
                if (!job.sort(8)) return later();
                if (!job.cols) { job.colsKey = columnsKey(); job.cols = computeColumns(job.index); return later(); }
                warming = null;
                rebuild({ prepared: job, laterList: true, steady: true });
            };
            slice();
        };

        /* 排序方式（标题、歌手、时长、添加时间）：阵列的列、目录、队列都跟着它；记在本机 */
        const SORT_KEY = 'musicArchiveSort';
        let sortMode = 'title';
        try { sortMode = localStorage.getItem(SORT_KEY) || 'title'; } catch (e) { sortMode = 'title'; }
        if (!IndexLib || !IndexLib.SORTS || !IndexLib.SORTS.includes(sortMode)) sortMode = 'title';
        const sortSpecFor = (index) => (IndexLib && index && IndexLib.sortSpec
            ? IndexLib.sortSpec(index, { mode: sortMode, tracks: tracks(), durationOf: (t) => durationOf(t) }) : null);
        const sortSpec = () => sortSpecFor(searchIndex);
        const setSort = (mode) => {
            if (!IndexLib || !IndexLib.SORTS.includes(mode) || mode === sortMode) return;
            sortMode = mode;
            try { localStorage.setItem(SORT_KEY, mode); } catch (e) { /* 只是记住 */ }
            // 按新顺序重排：选中的那首留在选中，换到它在新排法里的那一列
            const keepIndex = selectedIndex();
            rebuild({ keep: false, track: keepIndex, reindex: false });
            followSort();
        };
        // 拼音表按需加载（项目已有的依赖），加载好之后重建索引，汉字才能按拼音检索和分组
        const loadPinyin = () => {
            if (global.pinyinPro || options.pinyinSrc === false) return;
            const src = options.pinyinSrc || (SCRIPT_BASE ? new URL('../../node_modules/pinyin-pro/dist/index.js', SCRIPT_BASE).href : '');
            if (!src) return;
            const tag = document.createElement('script');
            tag.src = src;
            tag.async = true;
            tag.onload = () => { if (!state.destroyed) rebuildSoon(); }; // 汉字有了拼音，分组和检索都要重算
            tag.onerror = () => { /* 没有拼音表就只按原文检索 */ };
            document.head.appendChild(tag);
        };

        // 最近播放：记路径，最多 60 首，存在本机
        const RECENT_KEY = 'musicArchiveRecent';
        let recentPaths = [];
        try { recentPaths = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((p) => typeof p === 'string'); } catch (e) { recentPaths = []; }
        const recentIndices = () => {
            const byPath = pathIndex();
            return recentPaths.map((p) => byPath.get(Model.normalizePath(p))).filter((i) => i !== undefined);
        };
        let lastRecorded = null;
        const recordRecent = () => {
            const t = tracks()[app.currentTrackIndex];
            if (!t || !t.path || !app.isPlaying || t.path === lastRecorded) return false;
            lastRecorded = t.path;
            recentPaths = [t.path, ...recentPaths.filter((p) => p !== t.path)].slice(0, 60);
            try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentPaths)); } catch (e) { /* 只是方便 */ }
            return true;
        };

        // 曲目没带时长时，播放过一次就记下来（按路径，存在本机），目录里能显示
        const DURATION_KEY = 'musicArchiveDurations';
        let durations = {};
        try { durations = JSON.parse(localStorage.getItem(DURATION_KEY) || '{}') || {}; } catch (e) { durations = {}; }
        const durationOf = (t) => (t && t.path && durations[t.path]) || 0;
        const recordDuration = () => {
            const t = tracks()[app.currentTrackIndex];
            const d = Number(app.lastKnownDuration);
            if (!t || !t.path || Number(t.duration) > 0 || !(d > 0) || Math.abs((durations[t.path] || 0) - d) < 1) return;
            durations[t.path] = Math.round(d);
            const keys = Object.keys(durations);
            if (keys.length > 4000) for (const k of keys.slice(0, keys.length - 4000)) delete durations[k];
            try { localStorage.setItem(DURATION_KEY, JSON.stringify(durations)); } catch (e) { /* 只是方便 */ }
            list?.rebuild();
        };

        let list = null;
        let playlistsChanged = () => {};
        let lyrics = null;
        let wall = null;            // 封面墙（archive-wall.js），没有那个文件时只有档案阵列
        let grid = null;            // 分节网格（archive-grid.js）
        let table = null;           // 平放（封面墙倒下去的那一版）
        const flat = () => (state.layout === 'wall' ? wall : state.layout === 'table' ? table : state.layout === 'grid' ? grid : null);
        const wantLyrics = (on) => {
            on = Boolean(on);
            if (on === Boolean(state.lyricsOn)) return;
            state.lyricsOn = on;
            refs.hud.classList.toggle('lyrics-open', on);
            refs.lyricsBtn?.setAttribute('aria-pressed', String(on));
            if (lastInset) resize();
            else {
                syncLyrics();
                syncSceneLayout();
            }
        };
        /* 一级入口：原来的控制参数（声学处理、舞台、播放）。播放器给了入口就用它的；没有就回经典视图把声学处理展开 */
        const openControls = (section) => {
            if (typeof app.openMusicControls === 'function') { app.openMusicControls(section); return; }
            if (app.musicDock && typeof app.musicDock.openPanel === 'function') { app.musicDock.openPanel('控制'); return; }
            setMode('classic', { persist: false });
            const drawer = document.getElementById('acoustic-drawer');
            const toggle = drawer && drawer.querySelector('.acoustic-drawer-toggle');
            if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
            drawer?.scrollIntoView?.({ block: 'nearest' });
            toggle?.focus?.();
        };
        const syncLyrics = () => {
            if (!lyrics) return;
            lyrics.setAllowed(state.lyricsOn && isShown() && !document.body.classList.contains('music-stage-active'));
            lyrics.sync();
        };
        const LIST_KEY = 'musicArchiveList';
        let listPref = null;
        try { listPref = localStorage.getItem(LIST_KEY); } catch (e) { listPref = null; }
        const listOpen = () => refs.hud.classList.contains('list-open');
        const setListOpen = (open, { persist = true } = {}) => {
            if (!list) return;
            refs.hud.classList.toggle('list-open', open);
            list.el.hidden = !open;
            refs.listBtn?.setAttribute('aria-pressed', String(open));
            if (persist) { listPref = open ? '1' : '0'; try { localStorage.setItem(LIST_KEY, listPref); } catch (e) { /* 只是记住 */ } }
            if (open) { list.render(); syncList(); }
            // 设置抽屉开着时目录开合会换档（见 resize 里的 midBeside）
            if (lastInset) resize(); else syncSceneLayout();
        };
        const applyListDefault = () => setListOpen(listPref !== '0', { persist: false });

        /* 列表选中某首：在对应的列里找到它，相机飞过去 */
        const goToTrack = (i, ctx, { pulse = true } = {}) => {
            const n = state.columns.length;
            if (!n || i < 0) return;
            let lane = ctx ? state.columns.findIndex((c) => c.id === ctx) : -1;
            let row = lane >= 0 ? state.columns[lane].items.indexOf(i) : -1;
            if (row < 0) {
                const at = Model.locate(state.columns, i, Model.wrap(state.lane, n));
                if (!at) return;
                lane = at.lane; row = at.row;
            }
            const m = state.columns[lane].items.length;
            const nearLane = lane + n * Math.round((state.lane - lane) / n);
            const nearRow = row + m * Math.round((state.row - row) / m);
            fromList = true;
            select(nearLane, nearRow, { pulse });
            fromList = false;
        };
        let fromList = false;
        const syncList = (quiet = false) => {
            if (!list || fromList || !listOpen()) return;
            const col = column();
            list.reveal(selectedIndex(), col ? col.id : null, { quiet: quiet === true });
        };

        const playIndex = (i, ctx, playback) => {
            goToTrack(i, ctx, { pulse: false });
            if (selectedIndex() !== i) return;
            playSelected(playback);
        };
        /*
         * 随机抽取：选择框先跨列跑过去，再沿列往下走、越走越慢，停在随机的一首上，取出并播放。
         * 跑的途中用户任何操作（按键、点击、滚轮）都会停下，停在当时那一格，不播放。
         * 降低动态时直接落到那一首。
         */
        const pick = { timers: [], on: false };
        const pickStop = () => {
            if (!pick.on) return;
            pick.on = false;
            picking = false;
            pick.timers.forEach(clearTimeout);
            pick.timers = [];
            refs.pickBtn?.classList.remove('running');
            setCardExpanded(true);
            syncList();
        };
        const randomPick = () => {
            if (pick.on || !state.columns.length) return;
            const order = libraryOrder();
            const cur = selectedIndex();
            const pool = order.length > 1 ? order.filter((i) => i !== cur) : order;
            if (!pool.length) return;
            const target = pool[Math.floor(Math.random() * pool.length)];
            const n = state.columns.length;
            const at = Model.locate(state.columns, target, Model.wrap(state.lane, n));
            if (!at) return;
            const lane1 = at.lane + n * Math.round((state.lane - at.lane) / n);
            const m = state.columns[at.lane].items.length;
            // 先算出到那一列时会停在第几行（换列会回到记住的位置），再从那里往目标走
            const remembered = focusByColumn.get(state.columns[at.lane].id);
            const startRow = lane1 === state.lane ? state.row
                : remembered !== undefined ? remembered + m * Math.round((state.row - remembered) / m) : state.row;
            const row1 = at.row + m * Math.round((startRow - at.row) / m);
            const steps = [];
            let t = 0;
            if (reducedMotion()) {
                steps.push({ t, lane: lane1, row: row1 });
            } else {
                const dl = lane1 - state.lane, hops = Math.min(Math.abs(dl), 8);
                for (let h = 1; h <= hops; h++) steps.push({ t: t += 110, lane: state.lane + Math.round(dl * h / hops), row: null });
                const dr = row1 - startRow, N = Math.min(Math.abs(dr), 12);
                let last = startRow;
                for (let j = 1; j <= N; j++) {
                    const r = startRow + Math.round(dr * (1 - Math.pow(1 - j / N, 2))); // 缓出：最后几步最短、最慢
                    if (r === last) continue;
                    steps.push({ t: t += 60 + 240 * Math.pow(j / N, 2), lane: lane1, row: r });
                    last = r;
                }
                if (last !== row1 || !steps.length) steps.push({ t: t += 100, lane: lane1, row: row1 });
            }
            pick.on = true;
            picking = true;
            refs.pickBtn?.classList.add('running');
            setCardExpanded(false);
            for (const s of steps) {
                pick.timers.push(setTimeout(() => {
                    if (!pick.on || state.destroyed) return;
                    if (s.row === null) stepLane(s.lane - state.lane);
                    else select(s.lane, s.row);
                    state.scene?.touch?.();
                }, s.t));
            }
            pick.timers.push(setTimeout(() => {
                if (!pick.on || state.destroyed) return;
                pick.on = false;
                picking = false;
                pick.timers = [];
                refs.pickBtn?.classList.remove('running');
                if (selectedIndex() !== target) select(lane1, row1);
                syncList();
                setCardExpanded(true);
                playSelected();
            }, t + (reducedMotion() ? 0 : 450)));
        };
        /* 底部显示正在放的这一组（队列）叫什么 */
        /* 正在放的这一组（队列）叫什么：首页不再单独写一行，交给底栏面板的「播放列表」页头显示（app.queueSourceName） */
        const setQueueName = (name) => {
            if (refs.queue) refs.queue.textContent = name || '全部曲目';
            app.queueSourceName = name || '全部曲目';
            try { document.dispatchEvent(new CustomEvent('music-queue-source-change')); } catch (e) { /* 只是提示刷新 */ }
        };
        /* 定位当前播放：相机飞到那张卡，目录滚到那一行并居中 */
        const locatePlaying = () => {
            goToPlaying();
            if (list && listOpen()) {
                if (list.kind !== 'all' && !list.query) list.setKind('all');
                const col = column();
                list.reveal(app.currentTrackIndex, col ? col.id : null, { center: true });
            }
        };

        /* 键盘打开选中卡的右键菜单（Shift+F10、菜单键）：菜单出现在当前行或导航旁边，方向键可以在菜单里移动 */
        const openMenuForSelected = () => {
            const index = selectedIndex();
            if (index < 0 || typeof app.showContextMenu !== 'function') return;
            const anchor = (listOpen() && list.el.querySelector('.archive-list-row.on')) || refs.listBtn;
            const rect = anchor.getBoundingClientRect();
            const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : anchor;
            // 先在档案页里发一次 contextmenu，播放器据此知道菜单是从档案页打开的（决定「移除」的范围）
            anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
            app.contextMenuTrackIndex = index;
            app.showContextMenu(rect.left, rect.bottom + 8);
            ListLib?.menuKeyboard?.(app, { restore: back });
        };
        const composing = (e) => e.isComposing || e.key === 'Process' || e.keyCode === 229;
        const typeIntoSearch = (e) => {
            if (!list || composing(e) || typeof e.key !== 'string') return false;
            // 只接可见的单个字符；空格留给播放暂停
            if ([...e.key].length !== 1 || /\s/.test(e.key) || /[\u0000-\u001f\u007f]/.test(e.key)) return false;
            e.preventDefault();
            stopInertia();
            if (!listOpen()) setListOpen(true, { persist: false });
            list.typeInto(e.key);
            return true;
        };
        const openSearch = () => {
            if (!list) return;
            if (!listOpen()) setListOpen(true);
            list.focusSearch();
        };


        // ---------- 视图切换（档案页 / 经典视图） ----------
        const isShown = () => state.mode === 'archive';
        // 进播放页的过场里（music-stage-entering，最多 1.1 秒）舞台还没盖上来，继续画让选中卡的上浮看得见；
        // 开场动画（music-intro-playing）是一层不透明全屏层，期间不画
        let enteringSince = 0;
        let layoutJob = null;     // 换视图过场里「盖上」那一段：{ layout }，盖满时换成它（见 sweepToLayout）
        const renderAllowed = () => {
            // 换视图的纸正在盖上来时，3D 阵列停在最后一帧不再画，把这几帧让给过场
            if (!isShown() || state.destroyed || document.hidden || state.layout !== 'array' || layoutJob) return false;
            const body = document.body.classList;
            if (body.contains('music-intro-playing')) return false;
            if (!body.contains('music-stage-active')) return true;
            return body.contains('music-stage-entering') && performance.now() - enteringSince < 1100;
        };
        const shouldRender = () => Boolean(state.scene) && renderAllowed();

        const setMode = (mode, { persist = true } = {}) => {
            state.mode = mode === 'classic' ? 'classic' : 'archive';
            const on = state.mode === 'archive';
            root.hidden = !on;
            document.body.classList.toggle('music-archive-on', on);
            document.body.classList.toggle('music-archive-off', !on);
            app.isArchiveActive = on;
            if (persist) { try { localStorage.setItem(VIEW_KEY, state.mode); } catch (e) { /* 只是记住上次的视图 */ } schedulePlace(); }
            if (on) {
                app.destroyAmbientPixi?.();
                ensureScene();
                resize();
                if (dataChanged()) rebuildSoon();
                updatePlaying(true);
                kick();
                flat()?.show(true);
                syncWallRoom();
            } else {
                wall?.show(false);
                table?.show(false);
                grid?.show(false);
                if (!app.isStageActive) originalCreateAmbient?.();
                app.visualizerCanvas && (app.visualizerCanvas.width = app.visualizerCanvas.clientWidth);
            }
            syncLyrics();
        };

        // 档案页显示时，旧界面的背景声纹不需要画
        const originalCreateAmbient = app.createAmbientPixi;
        const unwrapAmbient = global.MusicAppHooks.wrap(app, 'createAmbientPixi', 'archive', (base) => (...args) => (app.isArchiveActive ? undefined : base(...args)));

        // ---------- 场景与渲染循环 ----------
        const readTheme = () => {
            const cs = getComputedStyle(document.body);
            const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
            return {
                colors: {
                    paper: v('--ar-paper', '#11181b'),
                    card: v('--ar-card', '#3b4448'),
                    floor: v('--ar-floor', '#192125'),
                    badge: v('--ar-badge', '#5d676b'),
                    groove: v('--ar-groove', '#4a5559'),
                    accent: v('--ar-accent', '#c8a15a'),
                    font: v('--mt-font-archive', 'sans-serif')
                },
                dark: !document.body.classList.contains('light-theme')
            };
        };
        /* wave: true 时从当前选中格起一圈圈翻色（运行中切主题用）；第一次建场景直接换 */
        const applyTheme = ({ wave = false } = {}) => {
            if (!state.scene) return;
            const th = readTheme();
            state.scene.setTheme(th.colors, th.dark, wave && isShown() ? { wave: { lane: state.lane, row: state.row } } : {});
            syncCard();
            kick();
        };
        /* 进播放页的过场期间（body.music-stage-entering）选中卡多抬一点；外部也可以直接调 raise(高度) */
        const raise = (amount) => { state.scene?.raise(amount); kick(); };
        const syncEntering = () => {
            const on = document.body.classList.contains('music-stage-entering');
            if (on) enteringSince = performance.now();
            raise(on ? 0.9 : undefined);
        };

        let sceneQuality = null;
        const ensureScene = () => {
            if (state.scene && sceneQuality === quality()) return;
            const prev = state.scene;
            const keepTarget = prev ? prev.target : { lane: state.lane, row: state.row };
            if (prev) prev.dispose();
            try {
                state.scene = (options.sceneLib || SceneLib).create({ host: root, quality: quality(), reducedMotion });
            } catch (e) {
                console.warn('[MusicArchive] 3D 场景创建失败，只显示文字：', e);
                state.scene = null;
                return;
            }
            sceneQuality = quality();
            refs.hud.classList.toggle('low-power', sceneQuality === 'energy-saving');
            root.insertBefore(state.scene.canvas, root.firstChild);
            bindCanvas(state.scene.canvas);
            // 卡面标题：近处几张卡印曲名和档案号
            state.scene.setLabeler?.((lane, row) => {
                const index = Model.cellTrack(state.columns, lane, row);
                const t = index >= 0 ? tracks()[index] : null;
                if (!t) return null;
                return { key: index + ':' + (t.path || ''), title: Model.stripExtension(t.title) || '未知标题', code: fmtDur(trackDuration(t)) };
            });
            applyTheme();
            resize();
            state.scene.jump(keepTarget.lane, keepTarget.row);
            updatePlaying(true);
        };

        const TINY_W = 760, DRAWER_TINY_W = 840, NARROW_W = 1300, MID_W = 1720;
        const hudScale = (h) => Math.max(h / DESIGN_H, MIN_SCALE);
        // 右侧设置抽屉开着时，首页让出它占的那一条：整层按剩下的宽度重新排版（宽窄分档也按剩下的宽度算），
        // 标题、导航、说明块、封面、资料卡都挪到抽屉左边，不被盖住。用排版位置量，不受抽屉滑入的 transform 影响。
        const drawerInset = (w) => {
            // 底栏自己算好了让位宽度就用它的
            const given = Number(app.musicDock?.roomRight);
            if (Number.isFinite(given) && app.musicDock && 'roomRight' in app.musicDock) return given > 0 && given < w * 0.6 ? Math.round(given) : 0;
            const pnl = document.querySelector('#music-dock-root .md-pnl');
            if (!pnl || !pnl.classList.contains('md-open') || !pnl.offsetWidth) return 0;
            let left = 0;
            for (let el = pnl; el; el = el.offsetParent) left += el.offsetLeft;
            const inset = Math.round(root.getBoundingClientRect().right - left);
            // 窄窗口里抽屉铺满整个窗口：那时不让位，照原样被盖住
            return inset > 0 && inset < w * 0.6 ? inset : 0;
        };
        let lastInset = 0;
        const resize = () => {
            const full = root.clientWidth || global.innerWidth;
            const inset = drawerInset(full);
            lastInset = inset;
            const w = full - inset;
            const h = root.clientHeight || global.innerHeight;
            const sc = hudScale(h);
            refs.hud.classList.toggle('beside-drawer', inset > 0);
            refs.hud.style.width = (w / sc) + 'px';
            refs.hud.style.height = (h / sc) + 'px';
            refs.hud.style.transform = `scale(${sc})`;
            refs.hud.classList.toggle('short', h / sc < 900);
            // 设置抽屉让位后用中等宽度的搜索栏布局。
            const midBeside = inset > 0 && listOpen() && w / sc >= 900 && w / sc < NARROW_W;
            refs.hud.classList.toggle('narrow', w / sc < NARROW_W && !midBeside);
            refs.hud.classList.toggle('mid', (w / sc >= NARROW_W && w / sc < MID_W) || midBeside);
            refs.hud.classList.toggle('squeeze', midBeside);
            // 抽屉和歌词同时打开时，提前切到上下布局，给卡片留出足够的宽度。
            const tinyWidth = inset && listOpen() && state.lyricsOn ? DRAWER_TINY_W : TINY_W;
            refs.hud.classList.toggle('tiny', w / sc < tinyWidth);
            const safe = parseFloat(getComputedStyle(document.body).getPropertyValue('--music-dock-safe-bottom')) || 0;
            refs.hud.style.setProperty('--archive-dock-lift', Math.round(safe / sc) + 'px');
            state.scene?.resize(full, h);
            syncLyrics();
            syncSceneLayout();
            kick();
        };
        // 用目录、歌词和设置抽屉之间的可用空间给抽出的卡片构图。
        const syncSceneLayout = () => {
            syncWallRoom();
            const scene = state.scene;
            if (!scene || !isShown()) return;
            const sc = hudScale(root.clientHeight || global.innerHeight);
            const stacked = refs.hud.classList.contains('tiny') && listOpen() && refs.hud.classList.contains('has-track');
            const listWidth = listOpen() && !stacked ? list.el.offsetWidth : 0;
            const lyricsVisible = lyrics && !lyrics.el.hidden;
            const paneRight = state.lyricsOn && lyrics ? lyrics.el.offsetLeft : refs.hud.clientWidth;
            const safe = parseFloat(refs.hud.style.getPropertyValue('--archive-dock-lift')) || 0;
            const bottom = stacked ? list.el.offsetTop - 8 : refs.hud.clientHeight - safe - 76;
            scene.setDetailRoom({
                left: (listWidth + 22) * sc,
                right: (paneRight - 22) * sc,
                top: (refs.nav.offsetTop + refs.nav.offsetHeight + 18) * sc,
                bottom: bottom * sc
            });
            const masks = [];
            if (listOpen()) {
                const el = list.el;
                masks.push({ left: 0, right: el.offsetWidth * sc, top: el.offsetTop * sc, bottom: (el.offsetTop + el.offsetHeight) * sc });
            }
            if (lyricsVisible) {
                const el = lyrics.el;
                masks.push({ left: el.offsetLeft * sc, right: (el.offsetLeft + el.offsetWidth) * sc,
                    top: el.offsetTop * sc, bottom: (el.offsetTop + el.offsetHeight) * sc });
            }
            scene.setLabelMask(masks);
            kick();
        };

        const frame = (now) => {
            state.raf = 0;
            if (!shouldRender()) return;
            const tier = state.scene.tier;
            // 静止 2 秒后降到 12 帧；一有新输入（场景被标脏）这一帧立刻画，不等下一个 12 帧的格
            const fps = state.activity.idle && !state.activity.moving ? tier.idleFps : tier.fps;
            const aim = fps ? 1000 / fps : 0;
            if (!aim || state.scene.dirty || now - state.lastDraw >= aim - 3) {
                state.lastDraw = now;
                state.activity = state.scene.step(now);
            }
            if (!state.activity.animated && !state.scene.dirty) return;
            // 12 帧待机（或 30 帧档）时，下一帧还早就先睡到快到点再要显示帧，
            // 免得 60/144Hz 屏上每个显示帧都把页面叫醒一次只为了判断「还没到」。
            const wait = aim ? aim - (now - state.lastDraw) : 0;
            if (!state.scene.dirty && wait > 20) state.wait = setTimeout(wake, wait - 8);
            else state.raf = requestAnimationFrame(frame);
        };
        const wake = () => { state.wait = 0; kick(); };
        const kick = () => {
            if (state.wait) { clearTimeout(state.wait); state.wait = 0; }
            if (!state.raf && shouldRender()) state.raf = requestAnimationFrame(frame);
        };

        // ---------- 输入 ----------
        let pendingPick = null;
        let pickRaf = 0;
        let turning = null;
        /* 鼠标指着的卡（不是选中那张）：在指针旁边写出曲名和歌手，远处的卡也能认出是哪首 */
        const showTip = (c, at) => {
            const index = c && !(c.lane === state.lane && c.row === state.row) ? Model.cellTrack(state.columns, c.lane, c.row) : -1;
            const t = index >= 0 ? tracks()[index] : null;
            if (!t || !at) { refs.tip.classList.remove('on'); return; }
            refs.tip.firstChild.textContent = Model.stripExtension(t.title) || '未知标题';
            refs.tip.lastChild.textContent = [t.artist, fmtDur(trackDuration(t))].filter(Boolean).join(' · ');
            const base = root.getBoundingClientRect();
            refs.tip.style.transform = `translate(${Math.round(at.x - base.left + 16)}px, ${Math.round(at.y - base.top + 18)}px)`;
            refs.tip.classList.add('on');
        };
        let turned = false;
        let canvasPlayIndex = -1;
        /*
         * 按住空白处拖动整片档案，松手后带惯性滑行、再吸附到最近的一张卡。
         * 照参考播放器 SceneDrag.cpp：移动超过 10 像素才算拖；释放速度取最近 120 毫秒的采样，
         * 反向移动时重新取样，松手前 80 毫秒没动就不带速度；滑行摩擦 2.4，速度低于 0.6 格/秒
         * 时按「当前位置 + 速度/摩擦」取最近的格子，用 10 的弹簧吸过去；起手速度低于 0.75 直接吸附。
         */
        let plane = null;        // 按住中：{ x0, y0, lane0, row0, inv, active, samples, dir, lastMove, pointerId }
        let momentum = null;     // 松手后：{ lane: {v, vel, phase, target}, row: {...}, t }
        let momentumRaf = 0;
        const nearestCell = (lane, row) => [Math.floor(lane + 0.5), Math.floor(row + 0.5)];
        const followPlane = (lane, row, vl = 0, vr = 0) => {
            state.scene?.hold(lane, row, vl, vr);
            const [l, r] = nearestCell(lane, row);
            if (l !== state.lane || r !== state.row) select(l, r, { pulse: false });
            kick();
        };
        const stopMomentum = () => {
            if (momentumRaf) cancelAnimationFrame(momentumRaf);
            momentumRaf = 0;
            if (!momentum) return;
            momentum = null;
            state.scene?.unhold();
            kick();
        };
        const axisStart = (v, vel) => ({ v, vel, phase: Math.abs(vel) >= 0.75 ? 'coast' : 'snap', target: Math.floor(v + 0.5) });
        const axisStep = (a, dt, coasting) => {
            const FRICTION = 2.4;
            if (coasting) {
                const decay = Math.exp(-FRICTION * dt);
                a.v += a.vel * (1 - decay) / FRICTION;
                a.vel *= decay;
                if (Math.abs(a.vel) < 0.6) { a.target = Math.floor(a.v + a.vel / FRICTION + 0.5); a.phase = 'snap'; }
            } else if (a.phase === 'snap') {
                const rate = 10, d = a.v - a.target, imp = a.vel + rate * d, dec = Math.exp(-rate * dt);
                a.v = a.target + (d + imp * dt) * dec;
                a.vel = (a.vel - rate * imp * dt) * dec;
                if (Math.abs(a.v - a.target) < 0.0001 && Math.abs(a.vel) < 0.005) { a.v = a.target; a.vel = 0; a.phase = 'idle'; }
            }
        };
        const coast = (now) => {
            momentumRaf = 0;
            if (!momentum || state.destroyed || !isShown()) { stopMomentum(); return; }
            const dt = Math.min(0.25, Math.max(0, (now - momentum.t) / 1000));
            momentum.t = now;
            const coasting = momentum.lane.phase === 'coast' || momentum.row.phase === 'coast';
            axisStep(momentum.lane, dt, coasting);
            axisStep(momentum.row, dt, coasting);
            followPlane(momentum.lane.v, momentum.row.v, momentum.lane.vel, momentum.row.vel);
            if (momentum.lane.phase === 'idle' && momentum.row.phase === 'idle') { stopMomentum(); return; }
            momentumRaf = requestAnimationFrame(coast);
        };
        const releaseVelocity = (p, t) => {
            const S = p.samples;
            if (reducedMotion() || !S.length || t - p.lastMove > 80) return [0, 0];
            const a = S[0], b = S[S.length - 1];
            if (b.t - a.t < 8) return [0, 0];
            const k = 1000 / (b.t - a.t);
            return [(b.lane - a.lane) * k, (b.row - a.row) * k];
        };
        const bindCanvas = (canvas) => {
            canvas.addEventListener('pointermove', (e) => {
                lastPtr = { x: e.clientX, y: e.clientY };
                const rect = canvas.getBoundingClientRect();
                state.scene?.setPointer((e.clientX - rect.left) / rect.width - 0.5, (e.clientY - rect.top) / rect.height - 0.5);   // 照原版 ±0.5
                if (plane && (e.buttons & 1)) {
                    const dx = e.clientX - plane.x0, dy = e.clientY - plane.y0;
                    if (!plane.active && Math.hypot(dx, dy) < 10) return;
                    if (!plane.active) {
                        if (!plane.inv) { plane = null; return; }
                        plane.active = true;
                        turned = true;   // 拖过就不再当成点击
                        pendingPick = null;
                        state.scene?.setHover(null);
                        showTip(null);
                        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到捕获也能拖 */ }
                        canvas.style.cursor = 'grabbing';
                    }
                    const k = plane.scale;
                    const px = dx * k, py = dy * k;
                    // 卡片跟着指针走，镜头往反方向退
                    const lane = plane.lane0 - (px * plane.inv.a + py * plane.inv.b);
                    const row = plane.row0 - (px * plane.inv.c + py * plane.inv.d);
                    const t = e.timeStamp;
                    const mx = e.clientX - plane.px, my = e.clientY - plane.py;
                    if (Math.hypot(mx, my) > 1e-9) {
                        if (mx * plane.dir[0] + my * plane.dir[1] < 0) plane.samples = plane.samples.slice(-1);
                        plane.dir = [mx, my];
                        plane.lastMove = t;
                    }
                    plane.px = e.clientX; plane.py = e.clientY;
                    const last = plane.samples[plane.samples.length - 1];
                    if (last && last.t === t) { last.lane = lane; last.row = row; } else plane.samples.push({ lane, row, t });
                    plane.samples = plane.samples.filter((p) => t - p.t <= 120).slice(-32);
                    followPlane(lane, row);
                    return;
                }
                if (turning) {
                    const dx = e.clientX - turning.x;
                    turning.x = e.clientX;
                    if (Math.abs(e.clientX - turning.x0) > 4) turned = true;
                    state.scene?.turn(dx * 0.004);   // 参考播放器每像素 0.004 弧度
                    kick();
                    return;
                }
                if (wheelBrowsing || onDetailCard(e)) {
                    pendingPick = null;
                    state.scene?.setHover(null);
                    showTip(null);
                    canvas.style.cursor = wheelBrowsing ? '' : 'grab';
                    return;
                }
                pendingPick = { x: e.clientX, y: e.clientY, rect };
                if (!pickRaf) {
                    pickRaf = requestAnimationFrame(() => {
                        pickRaf = 0;
                        if (!pendingPick || !state.scene) return;
                        const c = state.scene.pick(pendingPick.x, pendingPick.y, pendingPick.rect);
                        state.scene.setHover(c);
                        showTip(c, pendingPick);
                        // 卡上是手指；卡已放回时空白处显示「可抓」，提示能按住拖动整片档案（参考播放器 m_cursor = "grab"）
                        const browsing = !cardExpanded && !state.scene.detail;
                        canvas.style.cursor = c && Model.cellTrack(state.columns, c.lane, c.row) >= 0 ? 'pointer' : browsing ? 'grab' : '';
                    });
                }
                kick();
            });
            canvas.addEventListener('pointerleave', () => { lastPtr = null; clearTimeout(rehoverTimer); pendingPick = null; state.scene?.setHover(null); showTip(null); kick(); });
            // 取出时按住卡左右拖可以转着看，松手转回正面；按在卡外面（没拖）就把卡放回去
            const onDetailCard = (e) => {
                const r = state.scene?.detailRect();
                const rect = canvas.getBoundingClientRect();
                return Boolean(r) && e.clientX - rect.left >= r.left && e.clientX - rect.left <= r.right && e.clientY - rect.top >= r.top && e.clientY - rect.top <= r.bottom;
            };
            canvas.addEventListener('pointerdown', (e) => {
                turned = false;
                if (e.button === 0 && !onDetailCard(e)) {
                    // 滑行中按下：停住（这次按下不算点击），并从停住的位置开始新一次拖动
                    if (momentum) { turned = true; stopMomentum(); }
                    plane = null;
                    if (cardExpanded || wheelBrowsing || !state.scene || state.scene.detail) return;
                    const ax = state.scene.dragAxes();
                    const det = ax.lane.x * ax.row.y - ax.row.x * ax.lane.y;
                    const area = Math.hypot(ax.lane.x, ax.lane.y) * Math.hypot(ax.row.x, ax.row.y);
                    const cam = state.scene.camAt();
                    const rect = canvas.getBoundingClientRect();
                    plane = {
                        x0: e.clientX, y0: e.clientY, px: e.clientX, py: e.clientY,
                        lane0: cam.lane, row0: cam.row, active: false,
                        scale: rect.width ? canvas.clientWidth / rect.width : 1,
                        inv: Number.isFinite(area) && area > 0 && Math.abs(det) > area * 0.001
                            ? { a: ax.row.y / det, b: -ax.row.x / det, c: -ax.lane.y / det, d: ax.lane.x / det } : null,
                        samples: [{ lane: cam.lane, row: cam.row, t: e.timeStamp }], dir: [0, 0], lastMove: -1e9
                    };
                    return;
                }
                if (e.button !== 0 || !onDetailCard(e)) return;
                turning = { x: e.clientX, x0: e.clientX };
                try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到捕获也能拖 */ }
                canvas.style.cursor = 'grabbing';
            });
            const endTurn = () => {
                if (!turning) return;
                turning = null;
                state.scene?.turn(0, true);
                canvas.style.cursor = '';
                kick();
            };
            const endPlane = (e, cancelled) => {
                if (!plane) return;
                const p = plane;
                plane = null;
                canvas.style.cursor = '';
                if (!p.active) return;
                const last = p.samples[p.samples.length - 1];
                const [vl, vr] = cancelled ? [0, 0] : releaseVelocity(p, e.timeStamp);
                momentum = { lane: axisStart(last.lane, vl), row: axisStart(last.row, vr), t: performance.now() };
                if (!momentumRaf) momentumRaf = requestAnimationFrame(coast);
            };
            canvas.addEventListener('pointerup', (e) => { endPlane(e, false); endTurn(); });
            canvas.addEventListener('pointercancel', (e) => { endPlane(e, true); endTurn(); });
            // 点卡取出，点空白收回；两种构图都留在同一个曲库页面。
            canvas.addEventListener('click', (e) => {
                if (e.detail > 1) return;
                canvasPlayIndex = -1;
                if (turned) return;
                const c = state.scene?.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());
                canvasPlayIndex = c ? Model.cellTrack(state.columns, c.lane, c.row) : -1;
                if (canvasPlayIndex < 0) {
                    setCardExpanded(false);
                    return;
                }
                select(c.lane, c.row);
                setCardExpanded(true);
            });
            canvas.addEventListener('dblclick', () => {
                if (canvasPlayIndex >= 0 && canvasPlayIndex === selectedIndex()) playSelected();
            });
            canvas.addEventListener('contextmenu', (e) => {
                const featured = onDetailCard(e);
                const c = featured ? null : state.scene?.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());
                const index = featured ? selectedIndex() : c ? Model.cellTrack(state.columns, c.lane, c.row) : -1;
                if (index < 0) return;
                e.preventDefault();
                if (c) select(c.lane, c.row);
                app.contextMenuTrackIndex = index;
                app.showContextMenu?.(e.clientX, e.clientY);
            });
        };

        const wheelRows = Model.createWheel(60);
        const wheelLanes = Model.createWheel(90);
        // 列里跳到第几首（0 起），保持在当前视野附近那一圈
        const goRow = (target, opts) => {
            const col = column();
            const count = col ? col.items.length : 0;
            if (!count) return;
            const current = Model.wrap(state.row, count);
            if (target !== current) select(state.lane, state.row + (target - current), opts);
        };
        // 滚轮惯性：松手后按衰减的速度再走几格
        const inertia = Model.createInertia();
        let inertiaTimer = 0, inertiaRaf = 0;
        const finishWheel = () => {
            if (!wheelBrowsing) return;
            wheelBrowsing = false;
            syncCard();
            rehoverSoon();
        };
        const stopInertia = () => {
            inertia.stop();
            clearTimeout(inertiaTimer);
            inertiaTimer = 0;
            cancelAnimationFrame(inertiaRaf);
            inertiaRaf = 0;
            finishWheel();
        };
        const glide = (now) => {
            inertiaRaf = 0;
            if (state.destroyed || !isShown()) { stopInertia(); return; }
            const n = inertia.tick(now / 1000);
            if (n) { state.scene?.touch(); select(state.lane, state.row + n, { pulse: false }); }
            if (inertia.active) inertiaRaf = requestAnimationFrame(glide);
            else if (!inertiaTimer) finishWheel();
        };
        const releaseWheel = () => {
            inertiaTimer = 0;
            if (inertia.release(performance.now() / 1000)) {
                if (!inertiaRaf) inertiaRaf = requestAnimationFrame(glide);
            } else {
                finishWheel();
            }
        };

        root.addEventListener('wheel', (e) => {
            if (e.target !== state.scene?.canvas || (!e.deltaX && !e.deltaY)) return;
            e.preventDefault();
            if (momentum) stopMomentum();
            const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const delta = horizontal && !e.shiftKey ? e.deltaX : e.deltaY;
            const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
            const notch = Model.isWheelNotch(e, global.devicePixelRatio);
            const accumulate = horizontal ? wheelLanes : wheelRows;
            const n = notch ? Math.sign(delta) : accumulate(delta * unit, e.timeStamp);
            if (n && !wheelBrowsing) {
                wheelBrowsing = true;
                pendingPick = null;
                state.scene.setHover(null);
                showTip(null);
                syncCard();
            }
            if (!wheelBrowsing) return;

            state.scene.touch();
            if (horizontal || !notch || reducedMotion()) inertia.stop();
            else if (n) inertia.push(n, performance.now() / 1000);
            if (horizontal) stepLane(n, { pulse: false });
            else if (n) select(state.lane, state.row + n, { pulse: false });
            clearTimeout(inertiaTimer);
            inertiaTimer = setTimeout(releaseWheel, 160);
        }, { passive: false });

        // 借鉴 RhinE「在排名上滚轮换排」：滚轮停在分组名上换组、停在标尺上逐首走，不必先挪到场景里
        const wheelLaneName = Model.createWheel(60);
        const wheelRuler = Model.createWheel(60);
        const onHudWheel = (e) => {
            const onLanes = refs.lanes && refs.lanes.contains(e.target);
            const onRuler = !onLanes && refs.ruler && refs.ruler.contains(e.target);
            if (!onLanes && !onRuler) return;
            const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            if (!delta) return;
            e.preventDefault();
            const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
            const n = Model.isWheelNotch(e, global.devicePixelRatio)
                ? Math.sign(delta)
                : (onLanes ? wheelLaneName : wheelRuler)(delta * unit, e.timeStamp);
            if (!n) return;
            if (onLanes) stepLane(Math.sign(n));
            else select(state.lane, state.row + n);
        };
        root.addEventListener('wheel', onHudWheel, { passive: false });

        root.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (btn) {
                switch (btn.dataset.act) {
                    case 'search': openSearch(); break;
                    case 'list': setListOpen(!listOpen()); break;
                    case 'pick': randomPick(); break;
                    case 'row-prev': select(state.lane, state.row - 1); break;
                    case 'row-next': select(state.lane, state.row + 1); break;
                    case 'lane-prev': stepLane(-1); break;
                    case 'keys': toggleKeys(false); break;
                    case 'lane-next': stepLane(1); break;
                    case 'now': locatePlaying(); break;
                    case 'stage': if (app.stageHost && !app.stageHost.active) { try { app.stageHost.enter(); } catch (e) { /* 舞台没准备好就留在这里 */ } } break;
                    case 'lyrics': wantLyrics(!state.lyricsOn); break;
                    case 'controls': openControls(); break;
                    case 'classic': setMode('classic'); break;
                    case 'layout': setLayout(btn.dataset.layout); break;
                    case 'add-local': document.getElementById('add-folder-btn')?.click(); break;
                    case 'add-cloud': document.getElementById('add-webdav-btn')?.click(); break;
                    case 'save': {
                        const index = selectedIndex();
                        if (index < 0) break;
                        // 菜单开着时再点按钮就是收起（不然会先被点外面关掉、又马上重新长一次）
                        const menu = app.contextMenu || document.getElementById('track-context-menu');
                        if (menu && menu.classList.contains('visible') && btn.getAttribute('aria-expanded') === 'true') {
                            menu.classList.remove('visible');
                            break;
                        }
                        const r = btn.getBoundingClientRect();
                        app.contextMenuTrackIndex = index;
                        if (menu) menu.__mfAnchor = btn;
                        app.showContextMenu?.(r.left, r.bottom + 8);
                        ListLib?.menuKeyboard?.(app, { restore: btn });
                        break;
                    }
                    default: break;
                }
                e.stopPropagation();
                return;
            }
        });
        // 「随机抽取」放在顶栏「操作」菜单里（只在从那个按钮打开时出现，右键单曲时不出现），Shift+R 照旧
        const ctxMenu = app.contextMenu || document.getElementById('track-context-menu');
        let pickItem = null, unhookPick = null;
        if (ctxMenu && global.MusicAppHooks) {
            pickItem = document.createElement('div');
            pickItem.className = 'context-menu-item';
            pickItem.dataset.action = 'archive-pick';
            pickItem.title = '选择框在列间跑一段，停在哪首就取出来播放（Shift+R）';
            pickItem.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="9" r="1.6" fill="currentColor"/><circle cx="15" cy="15" r="1.6" fill="currentColor"/><circle cx="15" cy="9" r="1.6" fill="currentColor"/><circle cx="9" cy="15" r="1.6" fill="currentColor"/></svg><span>随机抽取</span>';
            pickItem.style.display = 'none';
            pickItem.addEventListener('click', (e) => {
                e.stopPropagation();
                ctxMenu.classList.remove('visible');
                randomPick();
            });
            ctxMenu.insertBefore(pickItem, ctxMenu.firstChild);
            unhookPick = global.MusicAppHooks.before(app, 'showContextMenu', 'archive-pick', () => {
                const fromNav = !!ctxMenu.__mfAnchor && refs.nav?.contains(ctxMenu.__mfAnchor);
                pickItem.style.display = fromNav ? '' : 'none';
            });
        }
        // 别让档案页的点击把右键菜单立刻关掉
        root.addEventListener('mousedown', () => { stopInertia(); state.scene?.touch(); });
        returnBtn?.addEventListener('click', () => setMode('archive'));

        // 借鉴 RhinE 的按键说明：按 ? 摊开一张快捷键卡，Esc / 再按 ? / 点别处收起
        const keysOpen = () => Boolean(refs.keys && !refs.keys.hidden);
        const toggleKeys = (on = !keysOpen()) => {
            if (!refs.keys) return;
            refs.keys.hidden = !on;
            if (on && !reducedMotion()) refs.keys.animate([{ opacity: 0, transform: 'translate(-50%, calc(-50% + 6px))' }, { opacity: 1, transform: 'translate(-50%, -50%)' }], { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
        };
        const onKeysOutside = (e) => { if (keysOpen() && !refs.keys.contains(e.target)) toggleKeys(false); };
        document.addEventListener('pointerdown', onKeysOutside, true);
        const modalOpen = () => Boolean(document.querySelector('#lyrics-fetch-modal.visible, #playlist-dialog.visible, #playlist-edit-modal.visible, .music-modal-overlay.visible, .dialog-overlay.visible, #track-context-menu.visible'));
        const onKeyDown = (e) => {
            if (momentum && isShown()) stopMomentum();
            if (pick.on && isShown()) { pickStop(); if (e.key === 'Escape') { e.preventDefault(); return; } }
            if (!isShown() || app.isStageActive || document.body.classList.contains('music-stage-active') || e.defaultPrevented) return;
            // Ctrl+L 定位当前播放（输入框里也能用）
            if (!modalOpen() && (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); locatePlaying(); return; }
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
            if (modalOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
            if (keysOpen() && (e.key === 'Escape' || e.key === '?')) { e.preventDefault(); toggleKeys(false); return; }
            if (e.key === '?') { e.preventDefault(); toggleKeys(true); return; }
            stopInertia();
            const fl = flat();
            if (fl && fl.on) {
                // 封面墙 / 网格：方向键按位置走，Esc 收起展开的大卡
                if (/^(Arrow|Page)/.test(e.key) && fl.step(e.key)) { e.preventDefault(); return; }
                if (e.key === 'Escape' && fl.collapse()) { e.preventDefault(); return; }
            }
            const next = Model.step({ lane: state.lane, row: state.row }, e.key);
            if (next) {
                e.preventDefault();
                state.scene?.touch();
                if (next.lane !== state.lane) stepLane(next.lane - state.lane);
                else select(next.lane, next.row);
                return;
            }
            if (e.key === 'Enter') {
                if (tag === 'BUTTON' && e.target.closest('#music-archive-view')) return;
                e.preventDefault(); playSelected({ stage: e.shiftKey }); return;
            }
            if (e.key === '/') { e.preventDefault(); openSearch(); return; }
            if (e.shiftKey && e.code === 'KeyR') { e.preventDefault(); randomPick(); return; }
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openMenuForSelected(); return; }
            // 直接打字：打开目录、聚焦检索框并带入这个字（不用先按 /）。
            // 输入法正在组字（isComposing / Process / 229）时不抢，让输入法把字交给它自己的输入框
            if (typeIntoSearch(e)) return;
            if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                const col = column();
                if (col && col.items.length) goRow(e.key === 'Home' ? 0 : col.items.length - 1);
                return;
            }
            if (e.code === 'Space' && tag !== 'BUTTON') {
                e.preventDefault();
                if (app.toggleTransport) app.toggleTransport();
                else app.isPlaying ? app.pauseTrack?.() : app.playTrack?.();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        bindRuler();
        // 随机抽取跑着时，点哪里、滚轮都先停下（抽取按钮自己除外：再点一下不会重来）
        const onPickInterrupt = (e) => {
            if (!pick.on) return;
            if (e.type === 'pointerdown' && e.target && e.target.closest && e.target.closest('[data-act="pick"]')) return;
            pickStop();
        };
        document.addEventListener('pointerdown', onPickInterrupt, true);
        document.addEventListener('wheel', onPickInterrupt, { capture: true, passive: true });
        // ---------- 外部状态 ----------
        const onResize = () => { resize(); syncGrain(); };
        global.addEventListener('resize', onResize);
        /*
         * 浅色/深色切换时的扫描带（借鉴 RhinE 换色时横扫整窗的那一道扫描线）：颜色先换好，
         * 再有一条带横向扫描线的窄带从左扫到右，右边缘是一根强调色扫描头，扫过就散。
         * 启动时第一次定主题不扫；降低动态时不扫；窗口在后台时不扫。
         */
        let modeLight = document.body.classList.contains('light-theme');
        const modeReadyAt = performance.now() + 1500;
        let modeSweepEl = null;
        const modeSweep = () => {
            if (reducedMotion() || document.hidden || performance.now() < modeReadyAt) return;
            modeSweepEl?.remove();
            const cs = getComputedStyle(root);
            const el = document.createElement('div');
            el.className = 'archive-mode-sweep';
            el.setAttribute('aria-hidden', 'true');
            el.style.setProperty('--sweep-ink', cs.getPropertyValue('--ar-ink').trim() || 'currentColor');
            el.style.setProperty('--sweep-accent', cs.getPropertyValue('--ar-accent').trim() || 'currentColor');
            el.innerHTML = '<i></i>';
            document.body.appendChild(el);
            modeSweepEl = el;
            const band = el.firstChild;
            const w = global.innerWidth || 1600;
            const bw = Math.round(Math.min(260, Math.max(160, w * 0.12)));
            band.style.width = bw + 'px';
            const anim = band.animate?.([{ transform: `translateX(${-bw}px)` }, { transform: `translateX(${w}px)` }],
                { duration: Math.round(Math.min(760, 420 + w * 0.12)), easing: 'cubic-bezier(.45, 0, .2, 1)', fill: 'forwards' });
            const done = () => { if (modeSweepEl === el) modeSweepEl = null; el.remove(); };
            if (anim) anim.onfinish = anim.oncancel = done; else setTimeout(done, 0);
        };
        const modeObserver = new MutationObserver(() => {
            const light = document.body.classList.contains('light-theme');
            if (light === modeLight) return;
            modeLight = light;
            modeSweep();
        });
        modeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        /*
         * 颗粒质感（借鉴 RhinE 的 grain）：一块无缝噪点小图平铺在场景上、HUD 下面，按设备像素 1:1。
         * 深色时是白色噪点（只把黑底提亮），浅色时是黑色噪点（只把纸面压暗），平均只差两三级灰，
         * 让大面积的纸色和黑底不那么像塑料。图只生成一次，静止不动，不占每帧开销。
         */
        const GRAIN_TILE = 160;
        const grainTiles = {};
        const grainTile = (light) => {
            const k = light ? 'light' : 'dark';
            if (grainTiles[k] !== undefined) return grainTiles[k];
            let url = '';
            try {
                const c = document.createElement('canvas');
                c.width = c.height = GRAIN_TILE;
                const g = c.getContext('2d');
                const img = g.createImageData(GRAIN_TILE, GRAIN_TILE);
                const v = light ? 0 : 255;
                // 固定种子：每次打开颗粒一样，不会一闪
                let seed = 0x2f6b1d;
                const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 100000) / 100000; };
                for (let i = 0; i < img.data.length; i += 4) {
                    const r = rnd();
                    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
                    img.data[i + 3] = Math.round(r * r * r * (light ? 13 : 11));
                }
                g.putImageData(img, 0, 0);
                url = c.toDataURL('image/png');
            } catch (e) { url = ''; }
            grainTiles[k] = url;
            return url;
        };
        const syncGrain = () => {
            const el = refs.grain;
            if (!el) return;
            const url = grainTile(document.body.classList.contains('light-theme'));
            el.style.backgroundImage = url ? `url("${url}")` : 'none';
            el.style.backgroundSize = (GRAIN_TILE / (global.devicePixelRatio || 1)) + 'px';
        };
        syncGrain();
        const grainObserver = new MutationObserver(syncGrain);
        grainObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        const onVisibility = () => { if (!document.hidden) { state.lastDraw = 0; kick(); } };
        document.addEventListener('visibilitychange', onVisibility);
        // 主题（light-theme）、舞台进出（music-stage-active）、底栏高度（body 上的变量）都挂在 body 上
        let lastBodyClass = document.body.className;
        // body 的 style 每次切歌都会变（底栏按封面取的色调），只有底栏高度变了才影响版面
        const dockSafe = () => document.body.style.getPropertyValue('--music-dock-safe-bottom');
        let lastDockSafe = dockSafe();
        const bodyObserver = new MutationObserver(() => {
            const cls = document.body.className;
            const classChanged = cls !== lastBodyClass;
            const safe = dockSafe();
            const safeChanged = safe !== lastDockSafe;
            lastDockSafe = safe;
            const themeChanged = cls.includes('light-theme') !== lastBodyClass.includes('light-theme');
            const stageChanged = cls.includes('music-stage-active') !== lastBodyClass.includes('music-stage-active');
            const enteringChanged = cls.includes('music-stage-entering') !== lastBodyClass.includes('music-stage-entering');
            lastBodyClass = cls;
            if (themeChanged) applyTheme({ wave: true });
            if (enteringChanged) syncEntering();
            if (stageChanged) savePlace();
            if (stageChanged && !cls.includes('music-stage-active') && isShown()) {
                // 从播放页回来：旧界面的背景声纹不要重新起来
                app.destroyAmbientPixi?.();
                updatePlaying(true);
                goToPlaying();
            }
            // 档案页没显示时不排版：经典视图下每次切歌都会走到这里，强制一次样式计算和布局。
            // 切回档案页时 setMode 会重新 resize。
            if (isShown() && (classChanged || safeChanged)) resize();
            kick();
        });
        bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        // 设置抽屉开合：抽屉的 class 一变就看让位宽度变没变，变了才重排
        const dockRoot = document.getElementById('music-dock-root');
        let drawerFrame = 0;
        const drawerObserver = dockRoot ? new MutationObserver((records) => {
            if (!records.some((r) => r.target.classList?.contains('md-pnl')) || drawerFrame) return;
            drawerFrame = requestAnimationFrame(() => {
                drawerFrame = 0;
                if (state.destroyed || !isShown()) return;
                if (drawerInset(root.clientWidth || global.innerWidth) !== lastInset) resize();
            });
        }) : null;
        drawerObserver?.observe(dockRoot, { subtree: true, attributes: true, attributeFilter: ['class'] });
        const unsubscribeQuality = stageConfig && stageConfig.subscribe ? stageConfig.subscribe(() => { if (isShown()) { ensureScene(); kick(); } }) : null;
        const onMotion = () => {
            syncMotionClass();
            if (reducedMotion()) stopInertia();
            state.scene?.touch();
            kick();
        };
        reducedQuery?.addEventListener?.('change', onMotion);
        const offMotion = global.MusicMotion && typeof global.MusicMotion.onChange === 'function' ? global.MusicMotion.onChange(onMotion) : null;

        const clockTimer = setInterval(() => {
            if (!isShown()) return;
            if (dataChanged()) rebuildSoon();
            updatePlaying();
            recordDuration();
            syncLyrics();
        }, 1000);

        const destroy = () => {
            if (state.destroyed) return;
            clearTimeout(placeTimer);
            savePlace();
            state.destroyed = true;
            clearInterval(clockTimer);
            drawerObserver?.disconnect();
            cancelAnimationFrame(drawerFrame);
            clearTimeout(scan.timer);
            clearTimeout(bootTimer);
            clearTimeout(listTimer);
            clearTimeout(growTimer);
            scanOff.forEach((off) => { if (typeof off === 'function') off(); });
            stopInertia();
            lyrics?.destroy();
            list?.closeBatchMenu?.();
            list?.endPress?.();
            list?.destroyDrop?.();
            if (state.raf) cancelAnimationFrame(state.raf);
            state.raf = 0;
            clearTimeout(state.wait);
            state.wait = 0;
            document.removeEventListener('keydown', onKeyDown);
            clearTimeout(rehoverTimer);
            document.removeEventListener('pointerdown', onKeysOutside, true);
            grainObserver.disconnect();
            modeObserver.disconnect(); modeSweepEl?.remove();
            pick.timers.forEach(clearTimeout); pick.on = false;
            document.removeEventListener('pointerdown', onPickInterrupt, true);
            document.removeEventListener('wheel', onPickInterrupt, { capture: true });
            document.removeEventListener('visibilitychange', onVisibility);
            global.removeEventListener('resize', onResize);
            bodyObserver.disconnect();
            if (typeof unsubscribeQuality === 'function') unsubscribeQuality();
            if (typeof offMotion === 'function') offMotion();
            reducedQuery?.removeEventListener?.('change', onMotion);
            state.scene?.dispose();
            state.scene = null;
            if (unwrapAmbient) unwrapAmbient();
            if (typeof unhookPick === 'function') unhookPick();
            pickItem?.remove();
        };
        // 关窗、刷新、离开页面时都彻底停掉：取消渲染循环和计时器，释放 WebGL 上下文（forceContextLoss），
        // 不让已经关掉的页面还在占用显卡或软件渲染。beforeunload 不一定触发（比如直接关进程），pagehide 兜底
        global.addEventListener('beforeunload', destroy, { once: true });
        global.addEventListener('pagehide', destroy, { once: true });

        // 目录换分类时，阵列跟到对应的列。
        const LIST_KIND_COLS = { playlist: ['playlist'], album: ['album'], recent: ['daily', 'recent'], all: ['letter', 'all'] };
        const followListKind = (kind) => {
            const want = LIST_KIND_COLS[kind];
            const n = state.columns.length;
            // 歌手等没有对应列的分类可以在目录里独立浏览。
            if (!want || !n || !state.columns.some((c) => want.includes(c.kind))) return;
            const cur = column();
            if (cur && want.includes(cur.kind)) return;
            let target = -1;
            // 回到「全部」：跳到选中那首所在的字母列，没有就第一列字母
            const sel = selectedIndex();
            if (kind === 'all' && sel >= 0) target = state.columns.findIndex((c) => want.includes(c.kind) && c.items.includes(sel));
            if (target < 0) target = state.columns.findIndex((c) => want.includes(c.kind));
            if (target < 0) return;
            stepLane(target - Model.wrap(state.lane, n));
        };
        // 歌单改过（加歌、改名、新建）：目录和阵列重排；正在放的歌单改了名，底栏「正在播放」后面的名字跟着改
        playlistsChanged = () => {
            warming = null; rebuild({ steady: true });
            const playing = app.filteredPlaylistSource;
            if (playing && playing.type === 'playlist' && app.playbackSourceName) setQueueName(app.playbackSourceName(playing));
        };
        if (ListLib && IndexLib) {
            list = ListLib.create({
                host: refs.hud,
                app,
                reducedMotion,
                Index: IndexLib,
                getIndex: () => searchIndex,
                getSpec: sortSpec,
                getSort: () => sortMode,
                onSort: setSort,
                getRecent: recentIndices, durationOf,
                columnOfGroup,
                fileNumber: (t, i) => fileNumber(t, i),
                onPlaylistsChanged: () => playlistsChanged(),
                onLibraryChanged: () => { warming = null; rebuild({ steady: true }); },
                onResults: (q, _count, first) => {
                    // 有结果时阵列跟到第一条结果，免得还停在检索前那首
                    if (q && first && first.i !== selectedIndex()) goToTrack(first.i, first.ctx, { pulse: false });
                },
                onKind: (kind) => followListKind(kind),
                onPick: (i, ctx) => {
                    goToTrack(i, ctx);
                    setCardExpanded(true);
                    flat()?.sync({ expand: true });
                },
                onPlay: (i, ctx, o) => playIndex(i, ctx, o)
            });
            // 搜索、分类、曲目排在右侧导航之前，Tab 顺序和界面布局一致。
            const listEl = refs.hud.querySelector(':scope > .archive-list');
            if (listEl) refs.hud.prepend(listEl);
        }
        // 右侧滚动歌词（档案页打开歌词时显示）
        const LyricsLib = global.MusicArchiveLyrics;
        lyrics = LyricsLib ? LyricsLib.create({
            host: refs.hud, app, reducedMotion,
            onChange: syncSceneLayout
        }) : null;
        loadPinyin();

        // ---------- 封面墙（第二种视图） ----------
        const WallLib = global.MusicArchiveWall;
        /* 墙上放哪些歌：和档案阵列里这一列一样；按首字母拆开的列就是整个曲库按当前排序 */
        const wallItems = () => {
            const col = column();
            if (!col) return { key: '', ids: [] };
            const whole = col.kind === 'letter' || col.kind === 'all';
            return whole ? { key: 'library:' + sortMode + ':' + state.sig, ids: libraryOrder(), name: '全部曲目' } : { key: col.id + ':' + state.sig, ids: col.items, name: col.name };
        };
        /*
         * 墙和网格上点的那首落在哪一列：墙上放的是整个曲库时，落到它所在的首字母列；
         * 不指定的话会落到最前面含有它的列（每日推荐、最近播放），墙就跟着换成那一组了
         */
        const flatContext = (i) => {
            const col = column();
            if (!col) return null;
            if (col.items.includes(i)) return col.id;
            if (col.kind !== 'letter' && col.kind !== 'all') return null;
            const home = state.columns.find((c) => (c.kind === 'letter' || c.kind === 'all') && c.items.includes(i));
            return home ? home.id : null;
        };
        const wallOpts = {
            host: root,
            before: refs.hud,
            items: wallItems,
            track: (i) => tracks()[i],
            cover: (t) => coverOf(t, true),
            selected: selectedIndex,
            playing: () => ({ index: tracks()[app.currentTrackIndex] ? app.currentTrackIndex : -1, active: Boolean(app.isPlaying || app.playIntent) }),
            meta: (t, i) => ({
                title: (t && Model.stripExtension(t.title)) || '未知标题',
                artist: (t && t.artist) || '',
                album: (t && t.album) || '',
                code: t ? fileNumber(t, i) : '',
                duration: fmtDur(trackDuration(t))
            }),
            pick: (i) => {
                goToTrack(i, flatContext(i), { pulse: false });
                syncList();
            },
            play: (i, { stage = false } = {}) => playIndex(i, flatContext(i), { stage }),
            menu: (i, x, y, restore) => {
                if (typeof app.showContextMenu !== 'function') return;
                app.contextMenuTrackIndex = i;
                app.showContextMenu(x, y);
                ListLib?.menuKeyboard?.(app, { restore: restore || refs.layouts.querySelector("[aria-pressed=\"true\"]") });
            },
            // 展开大卡里的进度条：读播放器上次报的时间，播放中按经过的时间往前推
            progress: () => {
                const d = Math.max(0, Number(app.lastKnownDuration) || 0);
                const base = Number(app.lastKnownCurrentTime) || 0;
                const run = app.isPlaying && app.lastStateUpdateTime && !app.isTrackLoading ? (Date.now() - app.lastStateUpdateTime) / 1000 : 0;
                const t = Math.max(0, base + run);
                return { t: d ? Math.min(d, t) : t, d };
            },
            seek: (t) => app.seekTo?.(t),
            transport: (act) => {
                if (act === 'toggle') { if (app.toggleTransport) app.toggleTransport(); else if (app.isPlaying) app.pauseTrack?.(); else app.playTrack?.(); }
                else if (act === 'prev') app.prevTrack?.();
                else if (act === 'next') app.nextTrack?.();
            },
            lyrics: () => (Array.isArray(app.currentLyrics) ? app.currentLyrics : []),
            reducedMotion
        };
        wall = WallLib ? WallLib.create(wallOpts) : null;
        table = WallLib ? WallLib.create({ ...wallOpts, tilt: true }) : null;
        if (table) table.el.addEventListener('wheel', (e) => e.stopPropagation());
        if (wall) wall.el.addEventListener('wheel', (e) => e.stopPropagation());
        /* 网格按节排：整个曲库时一节一个首字母列，其他列就是一节 */
        const gridSections = () => {
            const col = column();
            if (!col) return { key: '', list: [] };
            const whole = col.kind === 'letter' || col.kind === 'all';
            if (!whole) return { key: col.id + ':' + state.sig, list: [{ id: col.id, name: col.name, ids: col.items }] };
            const letters = state.columns.filter((c) => c.kind === 'letter');
            const list = letters.length ? letters.map((c) => ({ id: c.id, name: c.name, ids: c.items })) : [{ id: 'all', name: '全部曲目', ids: libraryOrder() }];
            return { key: 'library:' + sortMode + ':' + state.sig, list };
        };
        const GridLib = global.MusicArchiveGrid;
        grid = GridLib && wall ? GridLib.create({
            host: root, before: refs.hud, sections: gridSections,
            track: (i) => tracks()[i], cover: (t) => coverOf(t, true), selected: selectedIndex,
            playing: wallOpts.playing, meta: wallOpts.meta, pick: wallOpts.pick, play: wallOpts.play, menu: wallOpts.menu, reducedMotion
        }) : null;
        /* 墙只占目录、歌词、导航和页脚之间的空地：按它们实际的位置量（HUD 整体有缩放） */
        function syncWallRoom() {
            const fl = flat();
            if (!fl || !fl.on) return;
            const box = root.getBoundingClientRect();
            const hud = refs.hud.getBoundingClientRect();
            const listEl = list && listOpen() ? list.el : null;
            const lr = listEl && listEl.offsetWidth ? listEl.getBoundingClientRect() : null;
            const stacked = refs.hud.classList.contains('tiny');
            const lyr = lyrics && !lyrics.el.hidden && state.lyricsOn ? lyrics.el.getBoundingClientRect() : null;
            const nav = refs.nav.getBoundingClientRect();
            // 页脚（正在播放 · 经典视图）那一行在底栏上方，墙停在它上面
            const foot = refs.hud.querySelector('.archive-footer')?.getBoundingClientRect();
            const gutter = Math.max(24, Math.round(hud.width * 0.022));
            const left = lr && !stacked ? lr.right - box.left + gutter * 0.6 : gutter;
            const right = (lyr ? lyr.left - box.left - gutter * 0.6 : hud.right - box.left - gutter);
            const top = nav.bottom - box.top + 14;
            const bottomEdge = foot && foot.height ? foot.top - box.top - 16 : box.height - 90;
            const bottom = lr && stacked ? Math.min(bottomEdge, lr.top - box.top - 10) : bottomEdge;
            fl.setRoom({ left, top, width: right - left, height: bottom - top });
        }
        /*
         * 换视图的过场，分两段：
         *   盖上：纸色面板从左边推进来把画面盖满（前缘一道强调色扫描头），旧视图一点点被遮住；
         *   换：盖满的那一刻才真正换视图——3D 阵列重新开画、封面墙/网格建格子解封面，最重的这一两帧都在纸后面，看不到卡顿；
         *   揭开：等两帧画完，面板往右滑走，左缘扫描头身后拖一段细扫描线，新视图从左到右露出来（封面墙/网格的格子跟着扫描线翻过来）。
         * 盖的过程只动 transform，跑在合成线程上，主线程忙也不掉帧。连点：还没盖满就只改目标，盖满后换成最后点的那个。
         * 降低动态、窗口在后台时直接换。
         */
        let layoutSweepEl = null;
        /* 视图切换是一个下拉框（音乐窗口里的 <select> 会被 music-fluid-select 换成主程序同款的选项卡片），这里只同步它的值 */
        const layoutSelect = refs.layouts.querySelector('.archive-layout-select');
        const markLayoutButtons = (layout) => { if (layoutSelect && layoutSelect.value !== layout) layoutSelect.value = layout; };
        // 「经典列表」也在这个菜单里（原来是页脚单独一个按钮）：选它就切到经典视图，菜单里仍然记着当前的首页布局。
        layoutSelect?.addEventListener('change', () => {
            if (layoutSelect.value === 'classic') { layoutSelect.value = state.layout; setMode('classic'); return; }
            setLayout(layoutSelect.value);
        });
        const revealSweep = (el, w) => {
            el.classList.remove('is-covering');
            // 纸盖着时新视图的翻入动画是暂停的（layout-holding），揭开这一刻一起放，和扫描线对得上
            root.classList.remove('layout-holding');
            root.classList.add('layout-revealing');
            const anim = el.firstChild.animate?.([{ transform: 'translateX(0)' }, { transform: `translateX(${w + 90}px)` }],
                { duration: Math.round(Math.min(720, 380 + w * 0.16)), easing: 'cubic-bezier(.5, 0, .2, 1)', fill: 'forwards' });
            const done = () => { if (layoutSweepEl === el) { layoutSweepEl = null; root.classList.remove('layout-revealing'); } el.remove(); };
            if (anim) anim.onfinish = anim.oncancel = done; else done();
        };
        const sweepToLayout = (layout) => {
            if (reducedMotion() || document.hidden || !isShown() || !refs.hud) { applyLayout(layout, true); return; }
            markLayoutButtons(layout);
            if (layoutJob) { layoutJob.layout = layout; return; }
            layoutSweepEl?.remove();
            root.classList.remove('layout-revealing');
            const el = document.createElement('div');
            el.className = 'archive-layout-sweep is-covering';
            el.setAttribute('aria-hidden', 'true');
            el.innerHTML = '<i></i>';
            root.insertBefore(el, refs.hud);
            layoutSweepEl = el;
            const w = root.clientWidth || global.innerWidth || 1600;
            const job = layoutJob = { layout };
            const swap = () => {
                if (layoutJob !== job) return;
                layoutJob = null;
                if (layoutSweepEl !== el || !el.isConnected) { root.classList.remove('layout-holding'); applyLayout(job.layout, true); return; }
                el.dataset.full = '1';
                root.classList.add('layout-holding');
                applyLayout(job.layout, true);
                // 盖着等两帧：新视图第一帧（最重的那帧）画完再揭开
                requestAnimationFrame(() => requestAnimationFrame(() => { if (layoutSweepEl === el) revealSweep(el, w); }));
            };
            const anim = el.firstChild.animate?.([{ transform: `translateX(${-w - 4}px)` }, { transform: 'translateX(0)' }],
                { duration: Math.round(Math.min(300, 170 + w * 0.06)), easing: 'cubic-bezier(.6, 0, .4, 1)', fill: 'forwards' });
            if (anim) { anim.onfinish = swap; anim.oncancel = swap; } else swap();
        };
        const applyLayout = (layout, persist) => {
            if (!LAYOUTS.includes(layout) || (layout === 'wall' && !wall) || (layout === 'table' && !table) || (layout === 'grid' && !grid)) layout = 'array';
            state.layout = layout;
            const flatOn = layout !== 'array';
            root.classList.toggle('layout-wall', layout === 'wall');
            root.classList.toggle('layout-table', layout === 'table');
            root.classList.toggle('layout-grid', layout === 'grid');
            root.classList.toggle('layout-flat', flatOn);
            markLayoutButtons(layout);
            if (persist) { try { localStorage.setItem(LAYOUT_KEY, state.layout); } catch (e) { /* 只是记住 */ } }
            wall?.show(layout === 'wall' && isShown());
            table?.show(layout === 'table' && isShown());
            grid?.show(layout === 'grid' && isShown());
            if (flatOn) { syncWallRoom(); flat()?.sync(); } else { state.lastDraw = 0; kick(); }
        };
        const setLayout = (layout, { persist = true } = {}) => {
            const target = layoutJob ? layoutJob.layout : state.layout;
            if (persist && target !== layout && LAYOUTS.includes(layout)) sweepToLayout(layout);
            else if (!layoutJob) applyLayout(layout, persist);
        };
        try { const l = localStorage.getItem(LAYOUT_KEY); state.layout = LAYOUTS.includes(l) ? l : 'array'; } catch (e) { /* 默认档案阵列 */ }

        let initialMode = 'archive';
        try { initialMode = localStorage.getItem(VIEW_KEY) || 'archive'; } catch (e) { /* 默认档案页 */ }
        rebuild({ keep: false });
        setMode(initialMode, { persist: false });
        setLayout(state.layout, { persist: false });
        applyListDefault();

        const api = {
            show: () => setMode('archive'),
            showClassic: () => setMode('classic'),
            refresh: () => { warming = null; rebuild(); },
            refreshSoon: () => rebuildSoon(),
            select,
            playSelected,
            get scene() { return state.scene; },
            openSearch,
            setListOpen,
            setSort,
            get sort() { return sortMode; },
            onMotion: (fn) => { motionListeners.add(fn); return () => motionListeners.delete(fn); },
            raise,
            setThemeWave: () => applyTheme({ wave: true }),
            locatePlaying,
            get list() { return list; },
            destroy,
            get mode() { return state.mode; },
            get layout() { return state.layout; },
            setLayout,
            get wall() { return wall; },
            get grid() { return grid; },
            debug: () => ({
                mode: state.mode, layout: state.layout, wall: wall ? wall.debug() : null, grid: grid ? grid.debug() : null, lane: state.lane, row: state.row, columns: state.columns.map((c) => ({ id: c.id, n: c.items.length })),
                selected: selectedIndex(), rendering: Boolean(state.raf || state.wait), allowed: renderAllowed(), scene: state.scene?.debug() || null,
                lyrics: lyrics ? lyrics.debug() : null, lyricsOn: Boolean(state.lyricsOn)
            })
        };
        app.archiveView = api;
        return api;
    };

    global.MusicArchive = Object.freeze({ init });
})(window);
