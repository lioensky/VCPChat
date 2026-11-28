// Musicmodules/music-dupes.js
// 整理重复的歌（命令面板「整理重复的歌」）：同一首歌在曲库里有好几个文件时（复制了一份文件夹、flac 和 mp3 各一份、
// 专辑和合辑里各一份），列出来，每组标出要留的那份（本机、无损、规格最高），一键把其余的从曲库移除。
// 只是不在播放器里显示，磁盘上的文件不删；歌单、喜欢里指向被移除文件的，改指向留下的那份。可以撤销。
// 判断「同一首」：歌名（去扩展名）+ 歌手相同；没有歌手标签的，歌名 + 时长（秒）+ 文件大小都一样才算（完全相同的拷贝）。
(function (global) {
    'use strict';

    const radio = () => global.MusicRadioUtils || (typeof require === 'function' ? require('./music-radio.js') : {});
    const AUDIO_EXT = /\.(flac|mp3|wav|m4a|aac|ogg|opus|ape|wv|alac|aiff?|dsf|dff|wma)$/i;
    const BSLASH_RE = /\\/g;
    const HTTP_URL_RE = /^https?:\/\//i;
    const EXT_RE = /\.([a-z0-9]+)$/i;
    const TRAILING_ZERO_RE = /\.0$/;
    const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
    const norm = (s) => String(s || '').trim().toLowerCase();
    const normPath = (p) => String(p || '').replace(BSLASH_RE, '/').toLowerCase();
    const isRemote = (t) => Boolean(t && (t.isRemote || HTTP_URL_RE.test(String(t.path || ''))));

    function dupeKey(t, recKeyFn) {
        const fn = recKeyFn !== undefined ? recKeyFn : radio().recordingKey;
        const k = fn ? fn(t) : '';
        if (k) return k;
        const title = norm(String((t && t.title) || '').replace(AUDIO_EXT, ''));
        const dur = Math.round(Number(t && t.duration) || 0);
        const size = Number(t && t.size) || 0;
        return title && dur && size ? `${title}\n#${dur}\n#${size}` : '';
    }

    // 找出重复的组：[{ keep, extra: [...] }]，组内按留哪份排好；按多余文件数从多到少不重要，按曲库顺序
    function findDuplicates(library) {
        const r = radio();
        const rank = r.versionRank || (() => 0);
        const recKey = r.recordingKey || null;
        const groups = new Map();
        for (const t of library || []) {
            if (!t || !t.path) continue;
            const k = dupeKey(t, recKey);
            if (!k) continue;
            let list = groups.get(k);
            if (!list) { list = []; groups.set(k, list); }
            list.push(t);
        }
        const out = [];
        for (const list of groups.values()) {
            if (list.length < 2) continue;
            list.sort((a, b) => rank(b) - rank(a));
            out.push({ keep: list[0], extra: list.slice(1) });
        }
        return out;
    }

    const spec = (t) => {
        const ext = (String(t.path).match(EXT_RE) || [])[1];
        const parts = [ext ? ext.toUpperCase() : ''];
        if (t.bitsPerSample && t.sampleRate) parts.push(`${t.bitsPerSample}/${(t.sampleRate / 1000).toFixed(1).replace(TRAILING_ZERO_RE, '')}`);
        else if (t.bitrate) parts.push(`${Math.round(t.bitrate / 1000)}k`);
        if (isRemote(t)) parts.push('WebDAV');
        return parts.filter(Boolean).join(' · ');
    };
    const folderOf = (t) => {
        const p = String(t.path || '');
        const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
        return i > 0 ? p.slice(0, i) : p;
    };

    function setupMusicDupes(app) {
        if (!app || app.openDupesView) return;
        const doc = global.document;
        let overlay = null;
        let previousFocus = null;
        let openRaf = 0;
        let closeTimer = 0;
        let closingOverlay = null;
        let cachedGroups = null;
        let cachedPlaylist = null;
        let cachedPlaylistLen = -1;
        const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
        const title = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t.title || '') : String(t.title || '')) || '未知标题';
        const toast = (message, action) => { try { global.MusicToast?.show?.({ message, action, duration: action ? 10000 : undefined }); } catch (e) { /* 没有提示层 */ } };
        const flushClosing = () => {
            if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
            if (closingOverlay) { const prev = closingOverlay; closingOverlay = null; prev.remove(); }
        };

        const close = (immediate = false) => {
            const isImmediate = immediate === true;
            if (!overlay) {
                if (isImmediate) flushClosing();
                return;
            }
            if (openRaf && typeof global.cancelAnimationFrame === 'function') { global.cancelAnimationFrame(openRaf); openRaf = 0; }
            flushClosing();
            const o = overlay; overlay = null;
            cachedGroups = null; cachedPlaylist = null; cachedPlaylistLen = -1;
            global.removeEventListener('keydown', onKey, true);
            o.dataset.closing = '1';
            o.classList.remove('visible');
            if (isImmediate) o.remove();
            else {
                closingOverlay = o;
                closeTimer = setTimeout(() => { closeTimer = 0; if (closingOverlay === o) closingOverlay = null; o.remove(); }, 320);
            }
            const back = previousFocus;
            previousFocus = null;
            if (!isImmediate && back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch (e) { /* 还不回去就算了 */ } }
        };
        const onKey = (e) => {
            if (doc.querySelector('.dialog-overlay.music-dialog:not([data-closing])')) return;
            if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Tab' && overlay) {
                const focusables = [...overlay.querySelectorAll('button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])')];
                if (focusables.length) {
                    const first = focusables[0], last = focusables[focusables.length - 1];
                    const active = doc.activeElement;
                    if (e.shiftKey ? (active === first || !overlay.contains(active)) : (active === last || !overlay.contains(active))) {
                        e.preventDefault();
                        (e.shiftKey ? last : first).focus({ preventScroll: true });
                    }
                }
                return;
            }
            if (NAV_KEYS.has(e.key)) { e.stopPropagation(); return; }
            if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) e.stopPropagation();
        };
        global.addEventListener?.('beforeunload', () => close(true), { once: true });

        const refreshViews = () => {
            if (Array.isArray(app.currentFilteredTracks) && app.playlistViewSource) app.renderPlaylist?.(app.currentFilteredTracks);
            else app.renderPlaylist?.();
            try { app.renderSidebarContent?.(app.currentSidebarView); } catch (e) { /* 旧视图 */ }
            app.archiveView?.refresh?.();
            app.refreshPreload?.();
            try { doc.dispatchEvent(new CustomEvent('music-queue-change')); } catch (e) { /* 旧内核 */ }
        };

        // 把多余的文件移出曲库；歌单里指向它们的改成指向留下的那份。返回撤销函数。
        const removeExtras = (groups) => {
            const current = app.playlist?.[app.currentTrackIndex] || null;
            const replace = new Map(); // 被移除的路径 → 留下的路径
            const replaceTrack = new Map(); // 被移除的曲目对象 → 留下的曲目对象
            const drop = new Set();
            for (const g of groups) for (const t of g.extra) {
                if (t === current) continue; // 正在放的这份先留着
                drop.add(t);
                replace.set(normPath(t.path), g.keep.path);
                replaceTrack.set(t, g.keep);
            }
            if (!drop.size) return null;
            const beforeLibrary = app.playlist;
            const beforeFiltered = app.currentFilteredTracks;
            const beforeQueue = Array.isArray(app.manualQueue) ? app.manualQueue.slice() : null;
            const beforeLists = [];
            app.playlist = app.playlist.filter((t) => !drop.has(t));
            if (current) app.currentTrackIndex = Math.max(0, app.playlist.indexOf(current));
            if (Array.isArray(app.currentFilteredTracks)) app.currentFilteredTracks = app.currentFilteredTracks.filter((t) => !drop.has(t));
            if (Array.isArray(app.manualQueue) && app.manualQueue.length) {
                const seenQ = new Set();
                const nextQ = [];
                let queueChanged = false;
                for (const item of app.manualQueue) {
                    const mapped = replaceTrack.get(item) || item;
                    if (mapped !== item) queueChanged = true;
                    if (drop.has(mapped) || seenQ.has(mapped)) { queueChanged = true; continue; }
                    seenQ.add(mapped);
                    nextQ.push(mapped);
                }
                if (queueChanged) {
                    app.manualQueue.length = 0;
                    app.manualQueue.push(...nextQ);
                }
            }
            let listsChanged = false;
            let likedChanged = false;
            for (const pl of app.customPlaylists || []) {
                if (!pl || !Array.isArray(pl.tracks)) continue;
                const seen = new Set();
                const next = [];
                let plChanged = false;
                for (const p of pl.tracks) {
                    const q = replace.get(normPath(p)) || p;
                    const qk = normPath(q);
                    if (q !== p) { listsChanged = true; plChanged = true; }
                    if (seen.has(qk)) { listsChanged = true; plChanged = true; continue; }
                    seen.add(qk);
                    next.push(q);
                }
                if (plChanged) {
                    beforeLists.push([pl, pl.tracks]);
                    pl.tracks = next;
                    if (String(pl.id) === 'liked') likedChanged = true;
                }
            }
            app.saveLibrary?.();
            if (listsChanged) app.saveCustomPlaylists?.();
            if (likedChanged) { try { doc.dispatchEvent(new CustomEvent('music-like-change', { detail: { tracks: [...drop], liked: true } })); } catch (e) { /* 旧内核 */ } }
            refreshViews();
            return {
                count: drop.size,
                undo: () => {
                    const current2 = app.playlist?.[app.currentTrackIndex] || null;
                    const kept = new Set(app.playlist);
                    const beforeSet = new Set(beforeLibrary);
                    // 撤销期间又加进来的歌也留着
                    app.playlist = beforeLibrary.filter((t) => drop.has(t) || kept.has(t)).concat(app.playlist.filter((t) => !beforeSet.has(t)));
                    if (current2) app.currentTrackIndex = Math.max(0, app.playlist.indexOf(current2));
                    if (Array.isArray(beforeFiltered)) app.currentFilteredTracks = beforeFiltered;
                    if (Array.isArray(beforeQueue) && Array.isArray(app.manualQueue)) {
                        app.manualQueue.length = 0;
                        app.manualQueue.push(...beforeQueue);
                    }
                    if (listsChanged) {
                        for (const [pl, origTracks] of beforeLists) pl.tracks = origTracks;
                        try { app.saveCustomPlaylists?.(); } catch (e) { /* 歌单保持现状 */ }
                    }
                    if (likedChanged) { try { doc.dispatchEvent(new CustomEvent('music-like-change', { detail: { tracks: [...drop], liked: true } })); } catch (e) { /* 旧内核 */ } }
                    app.saveLibrary?.();
                    refreshViews();
                }
            };
        };

        const render = () => {
            const body = overlay.querySelector('.mdupes-body');
            body.innerHTML = '';
            const list = app.playlist || [];
            const groups = findDuplicates(list);
            cachedGroups = groups;
            cachedPlaylist = list;
            cachedPlaylistLen = list.length;
            const extra = groups.reduce((n, g) => n + g.extra.length, 0);
            const action = overlay.querySelector('.mdupes-remove');
            if (!groups.length) {
                body.appendChild(el('p', 'mstats-empty', '曲库里没有重复的歌。'));
                body.appendChild(el('p', 'mstats-note', '歌名和歌手相同（或歌名、时长、大小都一样）的几个文件算同一首。'));
                action.hidden = true;
                return;
            }
            action.hidden = false;
            action.textContent = `移除多余的 ${extra} 个文件`;
            body.appendChild(el('p', 'mdupes-lead', `${groups.length} 首歌各有不止一个文件。每组留下标着「留下」的那份（本机文件、无损、规格高的优先），其余从曲库移除；磁盘上的文件不会删，歌单会改指向留下的那份。`));
            const ul = el('ul', 'mdupes-list');
            const frag = doc.createDocumentFragment();
            const MAX = 200;
            const shown = Math.min(groups.length, MAX);
            const appendFileRow = (li, t, isKeep) => {
                const row = el('div', isKeep ? 'mdupes-file keep' : 'mdupes-file');
                row.appendChild(el('span', 'mdupes-badge', isKeep ? '留下' : '移除'));
                row.appendChild(el('span', 'mdupes-spec', spec(t)));
                const where = el('span', 'mdupes-path', folderOf(t));
                where.title = t.path;
                row.appendChild(where);
                li.appendChild(row);
            };
            for (let gi = 0; gi < shown; gi += 1) {
                const g = groups[gi];
                const li = el('li', 'mdupes-group');
                const head = el('div', 'mdupes-title');
                head.appendChild(el('span', 'mstats-name', title(g.keep)));
                if (g.keep.artist) head.appendChild(el('span', 'mstats-sub', g.keep.artist));
                li.appendChild(head);
                appendFileRow(li, g.keep, true);
                for (let ei = 0; ei < g.extra.length; ei += 1) appendFileRow(li, g.extra[ei], false);
                frag.appendChild(li);
            }
            ul.appendChild(frag);
            body.appendChild(ul);
            if (groups.length > MAX) body.appendChild(el('p', 'mstats-note', `还有 ${groups.length - MAX} 组没列出来，移除时一起处理。`));
        };

        app.openDupesView = () => {
            if (overlay) return;
            flushClosing();
            previousFocus = doc.activeElement;
            overlay = el('div', 'dialog-overlay music-stats-dialog music-dupes-dialog');
            const dialog = el('div', 'dialog glass-panel mstats mdupes');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'mdupes-title');
            const head = el('header', 'mstats-head');
            const h = el('h3', '', '整理重复的歌');
            h.id = 'mdupes-title';
            head.appendChild(h);
            const x = el('button', 'mstats-close', '×');
            x.type = 'button';
            x.setAttribute('aria-label', '关闭');
            x.addEventListener('click', () => close());
            head.appendChild(x);
            dialog.appendChild(head);
            dialog.appendChild(el('div', 'mdupes-body'));
            const actions = el('div', 'dialog-actions');
            const cancel = el('button', 'dialog-btn cancel', '关闭');
            cancel.type = 'button';
            cancel.addEventListener('click', () => close());
            const go = el('button', 'dialog-btn confirm mdupes-remove', '移除多余的文件');
            go.type = 'button';
            go.addEventListener('click', () => {
                const list = app.playlist || [];
                const groups = (cachedGroups && cachedPlaylist === list && cachedPlaylistLen === list.length)
                    ? cachedGroups
                    : findDuplicates(list);
                const removed = removeExtras(groups);
                close();
                if (!removed) { toast('没有可以移除的文件（正在放的那份先留着）'); return; }
                toast(`已从曲库移除 ${removed.count} 个重复文件（磁盘上的没删）`, { label: '撤销', run: () => { removed.undo(); toast('已恢复'); } });
            });
            actions.appendChild(cancel);
            actions.appendChild(go);
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
            doc.body.appendChild(overlay);
            global.addEventListener('keydown', onKey, true);
            render();
            const opening = overlay;
            openRaf = global.requestAnimationFrame?.(() => {
                openRaf = 0;
                if (overlay !== opening) return;
                opening.classList.add('visible');
                (go.hidden ? cancel : go).focus({ preventScroll: true });
            }) || 0;
        };
        app.findDuplicateTracks = () => findDuplicates(app.playlist || []);
    }

    const open = (app) => { setupMusicDupes(app); app?.openDupesView?.(); };
    const exported = { setupMusicDupes, open, findDuplicates, dupeKey };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicDupes = exported;
})(typeof window !== 'undefined' ? window : globalThis);
