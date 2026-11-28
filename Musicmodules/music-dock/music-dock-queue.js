// Musicmodules/music-dock/music-dock-queue.js
// 底栏面板「播放列表」页：一张表里三段——正在播放 → 手动队列（可拖动排序、移除、清空）→ 接下来会放的上下文
// （随机时就是洗好的真实顺序）。上下文可能有上千首：只画看得见的那几行。还有「把队列存为歌单」和
// 打开面板前的预渲染。
//
// 从 music-dock.js 拆出来，代码原样搬过来；和底栏共用的状态（state、el）和小工具通过 create(ctx) 传进来。
// 页面本身的外框和切页仍由 music-dock.js 的 renderBody 负责。
(function (global) {
    'use strict';

    function create(ctx) {
        const {
            app, state, el, cleanups, listen, renderBody,
            currentTrack, activeList, playMode, trackTitle, trackArtist,
            escapeHtml, icon, QUEUE_ROW_H, QUEUE_HEAD_H
        } = ctx;

        // 「把队列存为歌单」（Spotify、Feishin 都有）：正在放的 + 接下来播放 + 接着播放的这一组；
        // 整个曲库顺序播放时只存正在放的和手动排的，不把整库存进去
        function saveQueueAsPlaylist() {
            const current = currentTrack();
            const up = typeof app.getUpNext === 'function' ? app.getUpNext(2000) : { manual: [], context: [] };
            const seen = new Set();
            const paths = [];
            const addTrack = (t) => {
                if (t && t.path && !seen.has(t.path)) {
                    seen.add(t.path);
                    paths.push(t.path);
                }
            };
            addTrack(current);
            for (let i = 0; i < up.manual.length; i += 1) addTrack(up.manual[i]);
            if (app.currentFilteredTracks) {
                for (let i = 0; i < up.context.length; i += 1) addTrack(up.context[i]);
            }
            if (!paths.length) return;
            const d = new Date();
            const pad = (n) => (n < 10 ? `0${n}` : String(n));
            const pl = { id: 'q' + Date.now(), name: `队列 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`, tracks: paths };
            if (!Array.isArray(app.customPlaylists)) app.customPlaylists = [];
            app.customPlaylists.push(pl);
            const refresh = () => {
                try { app.saveCustomPlaylists?.(); } catch (e) { /* 存不了也先在界面上生效 */ }
                try { app.archiveView?.refresh?.(); } catch (e) { /* 档案页没开 */ }
                if (app.currentSidebarView === 'playlists') { try { app.renderSidebarContent?.('playlists'); } catch (e) { /* 旧侧栏 */ } }
            };
            refresh();
            global.MusicToast?.show?.({
                message: `已存为歌单「${pl.name}」：${paths.length} 首`,
                action: { label: '撤销', run: () => { const at = app.customPlaylists.indexOf(pl); if (at !== -1) { app.customPlaylists.splice(at, 1); refresh(); } } }
            });
        }

        function buildQueueRows() {
            const current = currentTrack();
            const up = typeof app.getUpNext === 'function'
                ? app.getUpNext(2000)
                : { manual: [], context: activeList().filter((t) => t !== current) };
            // 播放过的（Apple Music 的「历史」、Spotify 的「最近播放」）：在正在放的上面，打开时先看到正在放的，往上翻才看到
            const history = typeof app.getHistory === 'function' ? app.getHistory(30) : [];
            const histLen = history.length && current ? history.length : 0;
            const manList = up.manual;
            const manLen = manList.length;
            const ctxList = up.context;
            const ctxLen = ctxList.length;
            const totalRows = (histLen ? histLen + 1 : 0) + (current ? 1 : 0)
                + (manLen ? manLen + 1 : 0) + (ctxLen ? ctxLen + 1 : 0);
            const rows = new Array(totalRows);
            let outIdx = 0;
            let y = 0;
            if (histLen) {
                rows[outIdx++] = { type: 'head', label: '播放过的', count: histLen, top: y, h: QUEUE_HEAD_H };
                y += QUEUE_HEAD_H;
                for (let i = 0; i < histLen; i += 1) {
                    rows[outIdx++] = { type: 'hist', track: history[i], top: y, h: QUEUE_ROW_H };
                    y += QUEUE_ROW_H;
                }
            }
            if (current) {
                rows[outIdx++] = { type: 'now', track: current, top: y, h: QUEUE_ROW_H };
                y += QUEUE_ROW_H;
            }
            rows.nowTop = current ? y - QUEUE_ROW_H : 0;
            if (manLen) {
                rows[outIdx++] = { type: 'head', label: '接下来播放', count: manLen, clear: true, top: y, h: QUEUE_HEAD_H };
                y += QUEUE_HEAD_H;
                rows.manualStart = outIdx;
                for (let i = 0; i < manLen; i += 1) {
                    rows[outIdx++] = { type: 'manual', i, track: manList[i], top: y, h: QUEUE_ROW_H };
                    y += QUEUE_ROW_H;
                }
                rows.manualEnd = outIdx;
            } else {
                rows.manualStart = rows.manualEnd = 0;
            }
            if (ctxLen) {
                const mode = playMode();
                const radio = app.radio && app.radio.list === app.currentFilteredTracks ? app.radio.label : '';
                const name = radio || (app.playbackSourceName ? app.playbackSourceName() : app.filteredPlaylistSource?.name) || (app.currentFilteredTracks ? '当前列表' : '全部曲目');
                const label = mode === 'shuffle' ? `随机 · ${name}` : mode === 'repeat-one' ? '单曲循环' : `接着播放 · ${name}`;
                rows[outIdx++] = { type: 'head', label, count: ctxLen, top: y, h: QUEUE_HEAD_H };
                y += QUEUE_HEAD_H;
                for (let i = 0; i < ctxLen; i += 1) {
                    rows[outIdx++] = { type: 'ctx', track: ctxList[i], top: y, h: QUEUE_ROW_H };
                    y += QUEUE_ROW_H;
                }
            }
            rows.total = y;
            rows.upcoming = manLen + ctxLen;
            state.queueRows = rows;
            return rows;
        }

        // 复用队列行 DOM 节点与原型模板（含内置 SVG 图标），避免首次打开或滚动时重复建树与解析 SVG
        const iconTplCache = new Map();
        const cloneIconInto = (target, name, size) => {
            const k = `${name}:${size}`;
            let tpl = iconTplCache.get(k);
            if (!tpl) {
                tpl = document.createElement('span');
                tpl.innerHTML = icon(name, size);
                iconTplCache.set(k, tpl);
            }
            const first = tpl.firstChild;
            if (first && !first.nextSibling) {
                const clone = first.cloneNode(true);
                if (target.firstChild && !target.firstChild.nextSibling) target.replaceChild(clone, target.firstChild);
                else { target.textContent = ''; target.appendChild(clone); }
                return;
            }
            target.textContent = '';
            for (let n = first; n; n = n.nextSibling) target.appendChild(n.cloneNode(true));
        };
        let manualProto = null;
        let trackProto = null;
        const ROW_INNER_H = QUEUE_ROW_H - 2;
        const getManualProto = () => {
            if (manualProto) return manualProto;
            const root = document.createElement('div');
            root.setAttribute('role', 'listitem');
            root.className = 'md-qi md-man';
            root.style.height = `${ROW_INNER_H}px`;
            const gripEl = document.createElement('span');
            gripEl.className = 'md-qgrip';
            gripEl.title = '拖动排序';
            gripEl.setAttribute('aria-hidden', 'true');
            cloneIconInto(gripEl, 'grip-vertical', 14);
            const tx = document.createElement('span');
            tx.className = 'md-qi-tx';
            tx.append(document.createElement('b'), document.createElement('span'));
            const durEl = document.createElement('span');
            durEl.className = 'md-qdur';
            const playBtn = document.createElement('button');
            playBtn.className = 'md-qplay';
            playBtn.type = 'button';
            playBtn.dataset.qact = 'play';
            playBtn.append(tx, durEl);
            const actBtn = document.createElement('button');
            actBtn.className = 'md-qx';
            actBtn.type = 'button';
            actBtn.dataset.qact = 'remove';
            actBtn.setAttribute('aria-label', '从队列移除');
            actBtn.title = '从队列移除';
            cloneIconInto(actBtn, 'x', 14);
            root.append(gripEl, playBtn, actBtn);
            manualProto = root;
            return root;
        };
        const getTrackProto = () => {
            if (trackProto) return trackProto;
            const root = document.createElement('div');
            root.setAttribute('role', 'listitem');
            root.className = 'md-qi';
            root.style.height = `${ROW_INNER_H}px`;
            const tx = document.createElement('span');
            tx.className = 'md-qi-tx';
            tx.append(document.createElement('b'), document.createElement('span'));
            const durEl = document.createElement('span');
            durEl.className = 'md-qdur';
            const playBtn = document.createElement('button');
            playBtn.className = 'md-qplay';
            playBtn.type = 'button';
            playBtn.dataset.qact = 'play';
            playBtn.append(tx, durEl);
            const actBtn = document.createElement('button');
            actBtn.className = 'md-qx md-qnext';
            actBtn.type = 'button';
            actBtn.dataset.qact = 'next';
            actBtn.setAttribute('aria-label', '下一首播放');
            actBtn.title = '下一首播放';
            cloneIconInto(actBtn, 'list-plus', 15);
            root.append(playBtn, actBtn);
            trackProto = root;
            return root;
        };
        const POOL_MAX = 64;
        const pools = { head: [], now: [], manual: [], track: [] };
        const kindOf = (row) => (row.type === 'head' ? 'head' : row.type === 'now' ? 'now' : row.type === 'manual' ? 'manual' : 'track');
        const createSlot = (kind) => {
            if (kind === 'head') {
                const root = document.createElement('div');
                root.className = 'md-qhd';
                root.setAttribute('role', 'presentation');
                const labelEl = document.createElement('span');
                const countEl = document.createElement('em');
                const spacerEl = document.createElement('span');
                spacerEl.className = 'md-g';
                const clearBtn = document.createElement('button');
                clearBtn.className = 'md-qclr';
                clearBtn.type = 'button';
                clearBtn.dataset.qact = 'clear';
                clearBtn.textContent = '清空';
                root.append(labelEl, countEl);
                return { kind, el: root, labelEl, countEl, spacerEl, clearBtn, hasClear: false, lastTop: NaN, lastH: NaN, lastLabel: null, lastCount: null, k: -1 };
            }
            if (kind === 'now') {
                const root = document.createElement('div');
                root.setAttribute('role', 'listitem');
                root.className = 'md-qi md-cur md-now';
                const tx = document.createElement('span');
                tx.className = 'md-qi-tx';
                const titleEl = document.createElement('b');
                const artistEl = document.createElement('span');
                tx.append(titleEl, artistEl);
                const spacerEl = document.createElement('span');
                spacerEl.className = 'md-g';
                const tagEl = document.createElement('span');
                tagEl.className = 'md-qtag';
                tagEl.textContent = '正在播放';
                root.append(tx, spacerEl, tagEl);
                return { kind, el: root, titleEl, artistEl, lastTop: NaN, lastH: NaN, lastTitle: null, lastArtist: null, k: -1 };
            }
            if (kind === 'manual') {
                const root = getManualProto().cloneNode(true);
                const playBtn = root.children[1];
                const tx = playBtn.firstChild;
                const durEl = playBtn.lastChild;
                return { kind, el: root, playBtn, titleEl: tx.firstChild, artistEl: tx.lastChild, durEl, hasDur: true, lastTop: NaN, lastH: ROW_INNER_H, lastTitle: null, lastArtist: null, lastDur: '', lastAria: '', lastK: '', lastQi: '', k: -1 };
            }
            const root = getTrackProto().cloneNode(true);
            const playBtn = root.children[0];
            const tx = playBtn.firstChild;
            const durEl = playBtn.lastChild;
            return { kind, el: root, playBtn, titleEl: tx.firstChild, artistEl: tx.lastChild, durEl, hasDur: true, lastTop: NaN, lastH: ROW_INNER_H, lastTitle: null, lastArtist: null, lastDur: '', lastAria: '', lastK: '', lastCls: 'md-qi', k: -1 };
        };
        const acquireSlot = (kind) => (pools[kind].length ? pools[kind].pop() : createSlot(kind));
        const releaseSlot = (slot) => {
            if (!slot) return;
            slot.k = -1;
            const list = pools[slot.kind];
            if (list && list.length < POOL_MAX) list.push(slot);
        };
        const recycleScroller = (scroller) => {
            const sizer = scroller?.firstElementChild;
            const mounted = sizer?._qMounted;
            if (!Array.isArray(mounted) || !mounted.length) return;
            for (let i = 0; i < mounted.length; i += 1) releaseSlot(mounted[i]);
            mounted.length = 0;
        };
        const hydrateSlot = (slot, row, k, current) => {
            const h = row.h - 2;
            if (slot.lastTop !== row.top) { slot.lastTop = row.top; slot.el.style.top = `${row.top}px`; }
            if (slot.lastH !== h) { slot.lastH = h; slot.el.style.height = `${h}px`; }
            slot.k = k;
            if (slot.kind === 'head') {
                const label = String(row.label ?? '');
                if (slot.lastLabel !== label) { slot.lastLabel = label; slot.labelEl.textContent = label; }
                const countStr = String(row.count ?? '');
                if (slot.lastCount !== countStr) { slot.lastCount = countStr; slot.countEl.textContent = countStr; }
                const wantClear = Boolean(row.clear);
                if (wantClear && !slot.hasClear) {
                    slot.el.append(slot.spacerEl, slot.clearBtn);
                    slot.hasClear = true;
                } else if (!wantClear && slot.hasClear) {
                    slot.spacerEl.remove();
                    slot.clearBtn.remove();
                    slot.hasClear = false;
                }
                return slot.el;
            }
            const title = String(trackTitle(row.track) ?? '');
            const artist = String(trackArtist(row.track) ?? '');
            if (slot.lastTitle !== title) { slot.lastTitle = title; slot.titleEl.textContent = title; }
            if (slot.lastArtist !== artist) { slot.lastArtist = artist; slot.artistEl.textContent = artist; }
            if (slot.kind === 'now') return slot.el;

            const kStr = String(k);
            if (slot.lastK !== kStr) { slot.lastK = kStr; slot.el.dataset.k = kStr; }
            const dur = queueDuration(row.track);
            if (dur) {
                if (slot.lastDur !== dur) { slot.lastDur = dur; slot.durEl.textContent = dur; }
                if (!slot.hasDur) { slot.durEl.hidden = false; slot.hasDur = true; }
            } else if (slot.hasDur) {
                slot.durEl.hidden = true;
                slot.hasDur = false;
            }
            if (slot.kind === 'manual') {
                const qiStr = String(row.i);
                if (slot.lastQi !== qiStr) { slot.lastQi = qiStr; slot.el.dataset.qi = qiStr; }
                if (slot.el.style.transform) slot.el.style.transform = '';
                slot.el._qShift = 0;
                const aria = `现在播放 ${title}`;
                if (slot.lastAria !== aria) { slot.lastAria = aria; slot.playBtn.setAttribute('aria-label', aria); }
                return slot.el;
            }
            const isHist = row.type === 'hist';
            const cls = isHist ? 'md-qi md-hist' : (row.track === current ? 'md-qi md-cur' : 'md-qi');
            if (slot.lastCls !== cls) { slot.lastCls = cls; slot.el.className = cls; }
            const aria = `${isHist ? '再放一次' : '播放'} ${title}`;
            if (slot.lastAria !== aria) { slot.lastAria = aria; slot.playBtn.setAttribute('aria-label', aria); }
            return slot.el;
        };
        cleanups.push(() => {
            iconTplCache.clear();
            manualProto = null;
            trackProto = null;
            pools.head.length = 0;
            pools.now.length = 0;
            pools.manual.length = 0;
            pools.track.length = 0;
        });

        // 队列每行右边的时长：曲目自带的优先；没带的用档案页记下的（播放过一次就有，存在本机同一个键里）
        let qDurs = null, qDursRaw = null, qDursAt = 0;
        const queueDuration = (t) => {
            let sec = Number(t?.duration) > 0 ? Number(t.duration) : 0;
            if (!sec && t?.path) {
                const now = performance.now();
                if (!qDurs || now - qDursAt > 5000) {
                    try {
                        const raw = localStorage.getItem('musicArchiveDurations') || '';
                        if (raw !== qDursRaw) {
                            qDursRaw = raw;
                            qDurs = raw ? (JSON.parse(raw) || {}) : {};
                        } else if (!qDurs) qDurs = {};
                    } catch (e) { qDurs = {}; }
                    qDursAt = now;
                }
                sec = Number(qDurs[t.path]) || 0;
            }
            sec = Math.round(sec);
            if (!(sec > 0)) return '';
            if (sec < 3600) {
                const m = (sec / 60) | 0;
                const s = sec - m * 60;
                return `${m}:${s < 10 ? '0' : ''}${s}`;
            }
            const h = (sec / 3600) | 0;
            const rem = sec - h * 3600;
            const m = (rem / 60) | 0;
            const s = rem - m * 60;
            return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
        };
        let cachedQueueH = 0;
        listen(global, 'resize', () => { cachedQueueH = 0; });
        function renderQueueWindow(scroller, force = false, known = null) {
            if (state.queueDrag?.active) return; // 拖动时别重建行
            const hasKnown = Boolean(known && typeof known.top === 'number');
            // 抽屉已关闭时跳过延迟到达的 scroll 事件，避免触发隐藏容器的强制排版
            if (!state.panelOpen && !hasKnown) return;
            const rows = state.queueRows || [];
            const scrollTop = hasKnown ? known.top : scroller.scrollTop;
            let vh = hasKnown
                ? (known.height || cachedQueueH)
                : ((force ? 0 : cachedQueueH) || scroller.clientHeight || cachedQueueH);
            if (vh > 0) {
                if (!hasKnown) cachedQueueH = vh;
            } else {
                vh = hasKnown ? (global.innerHeight ? Math.max(300, global.innerHeight - 160) : 480) : 300;
            }
            const top = scrollTop - QUEUE_ROW_H * 4;
            const bottom = scrollTop + vh + QUEUE_ROW_H * 4;
            let lo = 0, hi = rows.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (rows[mid].top + rows[mid].h < top) lo = mid + 1; else hi = mid;
            }
            const first = lo;
            lo = first; hi = rows.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (rows[mid].top < bottom) lo = mid + 1; else hi = mid;
            }
            const last = lo;
            const key = `${first}:${last}:${app.currentTrackIndex}:${rows.length}`;
            if (!force && scroller._qWinKey === key) return;
            scroller._qWinKey = key;
            const sizer = scroller.firstElementChild;
            if (!sizer) return;
            const current = currentTrack();
            // 手动队列的行总是全画出来，拖动排序时才有地方让位；两段区间本身有序，直接按升序收集索引。
            const indices = [];
            const keepManual = rows.length < 400 && rows.manualEnd > rows.manualStart;
            if (!keepManual || (rows.manualStart >= first && rows.manualEnd <= last)) {
                for (let k = first; k < last; k++) indices.push(k);
            } else {
                const mStart = rows.manualStart, mEnd = rows.manualEnd;
                const pushRange = (a, b) => { for (let k = a; k < b; k++) indices.push(k); };
                if (mEnd <= first) {
                    pushRange(mStart, mEnd);
                    pushRange(first, last);
                } else if (last <= mStart) {
                    pushRange(first, last);
                    pushRange(mStart, mEnd);
                } else {
                    pushRange(Math.min(first, mStart), Math.max(last, mEnd));
                }
            }
            const prevMounted = Array.isArray(sizer._qMounted) ? sizer._qMounted : [];
            const byK = new Map();
            for (let i = 0; i < prevMounted.length; i += 1) {
                const slot = prevMounted[i];
                if (slot.k >= 0 && !byK.has(slot.k)) byK.set(slot.k, slot);
                else releaseSlot(slot);
            }
            const nextSlots = new Array(indices.length);
            for (let i = 0; i < indices.length; i += 1) {
                const k = indices[i];
                const wantKind = kindOf(rows[k]);
                const hit = byK.get(k);
                if (hit && hit.kind === wantKind) {
                    byK.delete(k);
                    nextSlots[i] = hit;
                }
            }
            for (const leftover of byK.values()) {
                leftover.el.remove();
                releaseSlot(leftover);
            }
            for (let i = 0; i < indices.length; i += 1) {
                const k = indices[i];
                const row = rows[k];
                let slot = nextSlots[i];
                if (!slot) {
                    slot = acquireSlot(kindOf(row));
                    nextSlots[i] = slot;
                }
                hydrateSlot(slot, row, k, current);
            }
            if (!sizer.firstElementChild) {
                if (nextSlots.length) {
                    const frag = document.createDocumentFragment();
                    for (let i = 0; i < nextSlots.length; i += 1) frag.appendChild(nextSlots[i].el);
                    sizer.appendChild(frag);
                }
            } else {
                let cursor = sizer.firstElementChild;
                for (let i = 0; i < nextSlots.length; i += 1) {
                    const node = nextSlots[i].el;
                    if (cursor === node) {
                        cursor = cursor.nextElementSibling;
                    } else {
                        sizer.insertBefore(node, cursor);
                    }
                }
                while (cursor) {
                    const next = cursor.nextElementSibling;
                    cursor.remove();
                    cursor = next;
                }
            }
            sizer._qMounted = nextSlots;
        }

        // 预先画好播放列表页：点开「更多」以后，在空闲时把队列页先画进（还藏着的）抽屉里，
        // 真点「播放列表」时抽屉只需要滑出来。画好以后歌、列表或队列变了就作废，照常重画。
        let prebuilt = null;
        let prebuildTimer = 0;
        let prebuildIdleId = 0;
        const cancelPrebuild = () => {
            clearTimeout(prebuildTimer);
            prebuildTimer = 0;
            if (prebuildIdleId && typeof global.cancelIdleCallback === 'function') {
                global.cancelIdleCallback(prebuildIdleId);
            }
            prebuildIdleId = 0;
        };
        const queueSig = () => ({
            path: currentTrack()?.path,
            filtered: app.currentFilteredTracks,
            filteredLen: app.currentFilteredTracks?.length,
            source: app.filteredPlaylistSource,
            sourceName: app.playbackSourceName?.(),
            radio: app.radio?.list,
            playing: app.isPlaying === true,
            light: document.body.classList.contains('light-theme')
        });
        const prebuiltFresh = () => {
            if (!prebuilt || performance.now() - prebuilt.at >= 8000) return false;
            const s = prebuilt.sig;
            return s.path === currentTrack()?.path
                && s.filtered === app.currentFilteredTracks
                && s.filteredLen === app.currentFilteredTracks?.length
                && s.source === app.filteredPlaylistSource
                && s.sourceName === app.playbackSourceName?.()
                && s.radio === app.radio?.list
                && s.playing === (app.isPlaying === true)
                && s.light === document.body.classList.contains('light-theme');
        };
        const schedulePrebuild = () => {
            cancelPrebuild();
            // 等「更多」那组按钮展开的动画走完再画，别把卡顿挪到展开动画里。
            prebuildTimer = setTimeout(() => {
                prebuildTimer = 0;
                const run = () => {
                    prebuildIdleId = 0;
                    if (state.panelOpen || state.destroyed || !el.quick.classList.contains('md-show') || prebuiltFresh()) return;
                    const was = state.tab;
                    state.tab = '播放列表';
                    renderBody();
                    state.tab = was;
                    prebuilt = { sig: queueSig(), at: performance.now() };
                };
                if (typeof global.requestIdleCallback === 'function') prebuildIdleId = global.requestIdleCallback(run, { timeout: 200 });
                else run();
            }, 320);
        };
        cleanups.push(cancelPrebuild);
        listen(document, 'music-queue-change', () => { prebuilt = null; });

        function rerenderQueue() {
            if (!state.panelOpen || state.tab !== '播放列表' || state.queueDrag?.active) return;
            const scroller = el.body.querySelector('.md-ql');
            const head = el.body.querySelector('.md-qh');
            if (!scroller || !head) { renderBody(); return; }
            const rows = buildQueueRows();
            const hasSaveBtn = Boolean(head.querySelector('[data-act="q-save"]'));
            const source = String((typeof app.playbackSourceName === 'function' && app.playbackSourceName()) || app.queueSourceName || (rows.upcoming ? '全部曲目' : '')).trim();
            const srcEl = head.querySelector('.md-qsrc');
            if (!rows.length || hasSaveBtn !== (rows.length > 1) || Boolean(srcEl) !== Boolean(source)) {
                renderBody();
                return;
            }
            prebuilt = null;
            const countEl = head.querySelector(':scope > span');
            const upStr = String(rows.upcoming);
            if (countEl && countEl.textContent !== upStr) countEl.textContent = upStr;
            if (srcEl) {
                const srcText = `来自 ${source}`;
                if (srcEl.textContent !== srcText) {
                    srcEl.textContent = srcText;
                    srcEl.title = `这个队列来自：${source}`;
                }
            }
            const shuffleBtn = head.querySelector('[data-act="shuffle"]');
            const wantShuffle = playMode() === 'shuffle';
            if (shuffleBtn && shuffleBtn.classList.contains('md-lit') !== wantShuffle) {
                shuffleBtn.classList.toggle('md-lit', wantShuffle);
            }
            state.queueSource = activeList();
            state.queueLength = state.queueSource.length;
            const sizer = scroller.firstElementChild;
            const nextH = `${rows.total}px`;
            if (sizer && sizer.style.height !== nextH) sizer.style.height = nextH;
            renderQueueWindow(scroller, true);
        }

        // 拖动排序：按住超过 4px 才算拖；其他行 140ms 让位；靠近上下边 32px 自动滚动。
        let abortActiveDrag = null;
        let suppressClickTimer = 0;
        const clearSuppressTimer = () => {
            if (suppressClickTimer) { clearTimeout(suppressClickTimer); suppressClickTimer = 0; }
        };
        cleanups.push(() => { clearSuppressTimer(); if (abortActiveDrag) abortActiveDrag(); });
        function onQueuePointerDown(event) {
            const rowEl = event.target?.closest?.('.md-man');
            if (!rowEl || event.button !== 0 || event.target?.closest?.('.md-qx')) return;
            event.preventDefault(); // 拖动时别选中文字
            if (abortActiveDrag) abortActiveDrag();
            const scroller = event.currentTarget;
            const from = Number(rowEl.dataset.qi);
            const manualList = scroller.querySelectorAll('.md-man');
            const manualEls = new Array(manualList.length);
            const manualIndices = new Array(manualList.length);
            for (let i = 0; i < manualList.length; i += 1) {
                manualEls[i] = manualList[i];
                manualIndices[i] = Number(manualList[i].dataset.qi);
            }
            state.queueDrag = { from, to: from, lastTo: from, startY: event.clientY, startScroll: scroller.scrollTop, y: event.clientY, lastDy: NaN, active: false, rowEl, manualEls, manualIndices, scroller, raf: 0, moved: false, pointerId: event.pointerId ?? null, rect: null };
            const inScrollEdge = (d) => d.rect && (d.y < d.rect.top + 32 || d.y > d.rect.bottom - 32);
            const stepAutoScroll = () => {
                const d = state.queueDrag;
                if (!d || !d.active || !inScrollEdge(d)) { if (d) d.raf = 0; return; }
                const prevScroll = scroller.scrollTop;
                if (d.y < d.rect.top + 32) scroller.scrollTop -= 6;
                else if (d.y > d.rect.bottom - 32) scroller.scrollTop += 6;
                if (scroller.scrollTop !== prevScroll) layoutDrag();
                d.raf = requestAnimationFrame(stepAutoScroll);
            };
            const move = (e) => {
                const d = state.queueDrag;
                if (!d || (d.pointerId != null && e.pointerId != null && e.pointerId !== d.pointerId)) return;
                d.y = e.clientY;
                if (!d.active && Math.abs(e.clientY - d.startY) < 4) return;
                if (!d.active) {
                    d.active = true;
                    d.moved = true;
                    rowEl.classList.add('md-qdrag');
                    scroller.classList.add('md-qdragging');
                    d.rect = scroller.getBoundingClientRect();
                }
                if (inScrollEdge(d)) {
                    if (!d.raf) d.raf = requestAnimationFrame(stepAutoScroll);
                } else if (d.raf) {
                    cancelAnimationFrame(d.raf);
                    d.raf = 0;
                }
                layoutDrag();
            };
            const layoutDrag = () => {
                const d = state.queueDrag;
                if (!d?.active) return;
                const dy = (d.y - d.startY) + (scroller.scrollTop - d.startScroll);
                if (dy === d.lastDy) return;
                d.lastDy = dy;
                const n = d.manualEls.length;
                const nextTo = Math.max(0, Math.min(n - 1, d.from + Math.round(dy / QUEUE_ROW_H)));
                d.to = nextTo;
                d.rowEl.style.transform = `translateY(${dy}px)`;
                if (nextTo === d.lastTo) return;
                d.lastTo = nextTo;
                for (let idx = 0; idx < n; idx += 1) {
                    const node = d.manualEls[idx];
                    if (node === d.rowEl) continue;
                    const i = d.manualIndices[idx];
                    let shift = 0;
                    if (d.from < nextTo && i > d.from && i <= nextTo) shift = -QUEUE_ROW_H;
                    if (d.from > nextTo && i < d.from && i >= nextTo) shift = QUEUE_ROW_H;
                    if (node._qShift !== shift) {
                        node._qShift = shift;
                        node.style.transform = shift ? `translateY(${shift}px)` : '';
                    }
                }
            };
            const detachDrag = () => {
                document.removeEventListener('pointermove', move, true);
                document.removeEventListener('pointerup', up, true);
                document.removeEventListener('pointercancel', up, true);
                global.removeEventListener?.('blur', onBlur);
                abortActiveDrag = null;
            };
            const resetDragDom = (d) => {
                scroller.classList.remove('md-qdragging');
                if (!d) return;
                d.rowEl?.classList.remove('md-qdrag');
                if (d.rowEl) d.rowEl.style.transform = '';
                if (Array.isArray(d.manualEls)) {
                    for (const node of d.manualEls) {
                        node.style.transform = '';
                        node._qShift = 0;
                    }
                }
            };
            const up = (e) => {
                const d = state.queueDrag;
                if (!d) { detachDrag(); return; }
                if (d.pointerId != null && e?.pointerId != null && e.pointerId !== d.pointerId) return;
                detachDrag();
                if (d.raf) cancelAnimationFrame(d.raf);
                const { active, from: f, to } = d;
                state.queueDrag = active ? { active: false, suppressClick: true } : null;
                resetDragDom(d);
                if (active) {
                    if (f !== to) app.queueMove?.(f, to);
                    rerenderQueue();
                    clearSuppressTimer();
                    suppressClickTimer = setTimeout(() => {
                        suppressClickTimer = 0;
                        if (state.queueDrag?.suppressClick) state.queueDrag = null;
                    }, 0);
                }
            };
            const onBlur = () => { if (abortActiveDrag) abortActiveDrag(); };
            abortActiveDrag = () => {
                detachDrag();
                clearSuppressTimer();
                const d = state.queueDrag;
                if (d?.raf) cancelAnimationFrame(d.raf);
                state.queueDrag = null;
                resetDragDom(d);
            };
            document.addEventListener('pointermove', move, true);
            document.addEventListener('pointerup', up, true);
            document.addEventListener('pointercancel', up, true);
            global.addEventListener?.('blur', onBlur);
        }

        function onQueueAction(target) {
            if (state.queueDrag?.suppressClick) { state.queueDrag = null; return; }
            const act = target.dataset.qact;
            if (act === 'clear') { app.queueClear?.(); return; }
            const rowEl = target.closest('[data-k]');
            const row = rowEl && state.queueRows?.[Number(rowEl.dataset.k)];
            if (!row) return;
            if (act === 'remove' && row.type === 'manual') { app.queueRemove?.(row.i); return; }
            if (act === 'next') {
                if (app.queuePlayNext?.(row.track)) global.MusicToast?.show({ id: 'queue', kind: 'success', message: `下一首播放：${trackTitle(row.track)}` });
                return;
            }
            if (act === 'play') {
                const index = app.playlist.indexOf(row.track);
                if (index === -1) return;
                // 点手动队列里的歌：现在就放它，并把它从队列里拿掉。
                if (row.type === 'manual') app.queueRemove?.(row.i);
                app.loadTrack?.(index);
            }
        }

        return {
            saveQueueAsPlaylist, buildQueueRows, renderQueueWindow, recycleScroller, schedulePrebuild, prebuiltFresh,
            dropPrebuilt: () => { prebuilt = null; },
            rerenderQueue, onQueuePointerDown, onQueueAction
        };
    }

    global.MusicDockQueue = { create };
})(window);
