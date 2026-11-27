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
            const list = [current, ...up.manual, ...(app.currentFilteredTracks ? up.context : [])].filter((t) => t && t.path);
            const paths = [...new Set(list.map((t) => t.path))];
            if (!paths.length) return;
            const d = new Date();
            const pad = (n) => String(n).padStart(2, '0');
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
            const rows = [];
            let y = 0;
            const push = (row, h) => { row.top = y; row.h = h; y += h; rows.push(row); };
            // 播放过的（Apple Music 的「历史」、Spotify 的「最近播放」）：在正在放的上面，打开时先看到正在放的，往上翻才看到
            const history = typeof app.getHistory === 'function' ? app.getHistory(30) : [];
            if (history.length && current) {
                push({ type: 'head', label: '播放过的', count: history.length }, QUEUE_HEAD_H);
                history.forEach((track) => push({ type: 'hist', track }, QUEUE_ROW_H));
            }
            if (current) push({ type: 'now', track: current }, QUEUE_ROW_H);
            rows.nowTop = current ? y - QUEUE_ROW_H : 0;
            if (up.manual.length) {
                push({ type: 'head', label: '接下来播放', count: up.manual.length, clear: true }, QUEUE_HEAD_H);
                rows.manualStart = rows.length;
                up.manual.forEach((track, i) => push({ type: 'manual', i, track }, QUEUE_ROW_H));
                rows.manualEnd = rows.length;
            } else {
                rows.manualStart = rows.manualEnd = 0;
            }
            if (up.context.length) {
                const mode = playMode();
                const radio = app.radio && app.radio.list === app.currentFilteredTracks ? app.radio.label : '';
                const name = radio || (app.playbackSourceName ? app.playbackSourceName() : app.filteredPlaylistSource?.name) || (app.currentFilteredTracks ? '当前列表' : '全部曲目');
                const label = mode === 'shuffle' ? `随机 · ${name}` : mode === 'repeat-one' ? '单曲循环' : `接着播放 · ${name}`;
                push({ type: 'head', label, count: up.context.length }, QUEUE_HEAD_H);
                up.context.forEach((track) => push({ type: 'ctx', track }, QUEUE_ROW_H));
            }
            rows.total = y;
            state.queueRows = rows;
            return rows;
        }

        const queueRowHtml = (row, k, current) => {
            const style = `top:${row.top}px;height:${row.h - 2}px`;
            if (row.type === 'head') {
                return `<div class="md-qhd" role="presentation" style="${style}"><span>${escapeHtml(row.label)}</span><em>${row.count}</em>`
                    + (row.clear ? '<span class="md-g"></span><button class="md-qclr" type="button" data-qact="clear">清空</button>' : '') + '</div>';
            }
            const dur = queueDuration(row.track);
            const text = `<span class="md-qi-tx"><b>${escapeHtml(trackTitle(row.track))}</b><span>${escapeHtml(trackArtist(row.track))}</span></span>`
                + (dur && row.type !== 'now' ? `<span class="md-qdur">${dur}</span>` : '');
            if (row.type === 'now') {
                return `<div class="md-qi md-cur md-now" role="listitem" style="${style}">${text}<span class="md-g"></span><span class="md-qtag">正在播放</span></div>`;
            }
            if (row.type === 'manual') {
                return `<div class="md-qi md-man" role="listitem" data-k="${k}" data-qi="${row.i}" style="${style}">`
                    + `<span class="md-qgrip" title="拖动排序" aria-hidden="true">${icon('grip-vertical', 14)}</span>`
                    + `<button class="md-qplay" type="button" data-qact="play" aria-label="现在播放 ${escapeHtml(trackTitle(row.track))}">${text}</button>`
                    + `<button class="md-qx" type="button" data-qact="remove" aria-label="从队列移除" title="从队列移除">${icon('x', 14)}</button></div>`;
            }
            if (row.type === 'hist') {
                return `<div class="md-qi md-hist" role="listitem" data-k="${k}" style="${style}">`
                    + `<button class="md-qplay" type="button" data-qact="play" aria-label="再放一次 ${escapeHtml(trackTitle(row.track))}">${text}</button>`
                    + `<button class="md-qx md-qnext" type="button" data-qact="next" aria-label="下一首播放" title="下一首播放">${icon('list-plus', 15)}</button></div>`;
            }
            return `<div class="md-qi${row.track === current ? ' md-cur' : ''}" role="listitem" data-k="${k}" style="${style}">`
                + `<button class="md-qplay" type="button" data-qact="play" aria-label="播放 ${escapeHtml(trackTitle(row.track))}">${text}</button>`
                + `<button class="md-qx md-qnext" type="button" data-qact="next" aria-label="下一首播放" title="下一首播放">${icon('list-plus', 15)}</button></div>`;
        };

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
            const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = String(sec % 60).padStart(2, '0');
            return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
        };
        function renderQueueWindow(scroller, force = false) {
            if (state.queueDrag?.active) return; // 拖动时别重建行
            const rows = state.queueRows || [];
            const top = scroller.scrollTop - QUEUE_ROW_H * 4;
            const bottom = scroller.scrollTop + (scroller.clientHeight || 300) + QUEUE_ROW_H * 4;
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
            if (!force && scroller.dataset.window === key) return;
            scroller.dataset.window = key;
            const current = currentTrack();
            // 手动队列的行总是全画出来，拖动排序时才有地方让位。
            const keep = new Set();
            for (let k = first; k < last; k++) keep.add(k);
            if (rows.length < 400 && rows.manualEnd > rows.manualStart) {
                for (let k = rows.manualStart; k < rows.manualEnd; k++) keep.add(k);
            }
            scroller.firstElementChild.innerHTML = [...keep].sort((a, b) => a - b).map((k) => queueRowHtml(rows[k], k, current)).join('');
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
        const queueSig = () => [currentTrack()?.path, app.currentFilteredTracks, app.currentFilteredTracks?.length,
            app.filteredPlaylistSource, app.playbackSourceName?.(), app.radio?.list, app.isPlaying === true, document.body.classList.contains('light-theme')];
        const prebuiltFresh = () => Boolean(prebuilt) && performance.now() - prebuilt.at < 8000
            && queueSig().every((value, index) => value === prebuilt.sig[index]);
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
            renderBody();
        }

        // 拖动排序：按住超过 4px 才算拖；其他行 140ms 让位；靠近上下边 32px 自动滚动。
        let abortActiveDrag = null;
        cleanups.push(() => { if (abortActiveDrag) abortActiveDrag(); });
        function onQueuePointerDown(event) {
            const rowEl = event.target.closest('.md-man');
            if (!rowEl || event.button !== 0 || event.target.closest('.md-qx')) return;
            event.preventDefault(); // 拖动时别选中文字
            if (abortActiveDrag) abortActiveDrag();
            const scroller = event.currentTarget;
            const from = Number(rowEl.dataset.qi);
            const manualEls = [...scroller.querySelectorAll('.md-man')];
            state.queueDrag = { from, to: from, startY: event.clientY, startScroll: scroller.scrollTop, y: event.clientY, lastDy: NaN, active: false, rowEl, manualEls, scroller, raf: 0, moved: false, pointerId: event.pointerId ?? null, rect: null };
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
                d.to = Math.max(0, Math.min(n - 1, d.from + Math.round(dy / QUEUE_ROW_H)));
                d.rowEl.style.transform = `translateY(${dy}px)`;
                for (const node of d.manualEls) {
                    if (node === d.rowEl) continue;
                    const i = Number(node.dataset.qi);
                    let shift = 0;
                    if (d.from < d.to && i > d.from && i <= d.to) shift = -QUEUE_ROW_H;
                    if (d.from > d.to && i < d.from && i >= d.to) shift = QUEUE_ROW_H;
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
                abortActiveDrag = null;
            };
            const up = (e) => {
                const d = state.queueDrag;
                if (!d) { detachDrag(); return; }
                if (d.pointerId != null && e?.pointerId != null && e.pointerId !== d.pointerId) return;
                detachDrag();
                if (d.raf) cancelAnimationFrame(d.raf);
                const { active, from: f, to } = d;
                state.queueDrag = active ? { active: false, suppressClick: true } : null;
                scroller.classList.remove('md-qdragging');
                if (active) {
                    if (f !== to) app.queueMove?.(f, to);
                    rerenderQueue();
                    setTimeout(() => { if (state.queueDrag?.suppressClick) state.queueDrag = null; }, 0);
                }
            };
            abortActiveDrag = () => {
                detachDrag();
                const d = state.queueDrag;
                if (d?.raf) cancelAnimationFrame(d.raf);
                state.queueDrag = null;
                scroller.classList.remove('md-qdragging');
            };
            document.addEventListener('pointermove', move, true);
            document.addEventListener('pointerup', up, true);
            document.addEventListener('pointercancel', up, true);
        }

        function onQueueAction(target) {
            if (state.queueDrag?.suppressClick) { state.queueDrag = null; return; }
            const act = target.dataset.qact;
            if (act === 'clear') { app.queueClear?.(); return; }
            const rowEl = target.closest('[data-k]');
            const row = rowEl && state.queueRows?.[Number(rowEl.dataset.k)];
            if (!row) return;
            const index = app.playlist.indexOf(row.track);
            if (act === 'remove' && row.type === 'manual') { app.queueRemove?.(row.i); return; }
            if (act === 'next') {
                if (app.queuePlayNext?.(row.track)) global.MusicToast?.show({ id: 'queue', kind: 'success', message: `下一首播放：${trackTitle(row.track)}` });
                return;
            }
            if (act === 'play' && index !== -1) {
                // 点手动队列里的歌：现在就放它，并把它从队列里拿掉。
                if (row.type === 'manual') app.queueRemove?.(row.i);
                app.loadTrack?.(index);
            }
        }

        return {
            saveQueueAsPlaylist, buildQueueRows, renderQueueWindow, schedulePrebuild, prebuiltFresh,
            dropPrebuilt: () => { prebuilt = null; },
            rerenderQueue, onQueuePointerDown, onQueueAction
        };
    }

    global.MusicDockQueue = { create };
})(window);
