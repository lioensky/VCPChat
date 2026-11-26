// Musicmodules/music-dupes.js
// 整理重复的歌（命令面板「整理重复的歌」）：同一首歌在曲库里有好几个文件时（复制了一份文件夹、flac 和 mp3 各一份、
// 专辑和合辑里各一份），列出来，每组标出要留的那份（本机、无损、规格最高），一键把其余的从曲库移除。
// 只是不在播放器里显示，磁盘上的文件不删；歌单、喜欢里指向被移除文件的，改指向留下的那份。可以撤销。
// 判断「同一首」：歌名（去扩展名）+ 歌手相同；没有歌手标签的，歌名 + 时长（秒）+ 文件大小都一样才算（完全相同的拷贝）。
(function (global) {
    'use strict';

    const radio = () => global.MusicRadioUtils || (typeof require === 'function' ? require('./music-radio.js') : {});
    const AUDIO_EXT = /\.(flac|mp3|wav|m4a|aac|ogg|opus|ape|wv|alac|aiff?|dsf|dff|wma)$/i;
    const norm = (s) => String(s || '').trim().toLowerCase();
    const isRemote = (t) => Boolean(t && (t.isRemote || /^https?:\/\//i.test(String(t.path || ''))));

    function dupeKey(t) {
        const k = radio().recordingKey ? radio().recordingKey(t) : '';
        if (k) return k;
        const title = norm(String((t && t.title) || '').replace(AUDIO_EXT, ''));
        const dur = Math.round(Number(t && t.duration) || 0);
        const size = Number(t && t.size) || 0;
        return title && dur && size ? `${title}\n#${dur}\n#${size}` : '';
    }

    // 找出重复的组：[{ keep, extra: [...] }]，组内按留哪份排好；按多余文件数从多到少不重要，按曲库顺序
    function findDuplicates(library) {
        const rank = radio().versionRank || (() => 0);
        const groups = new Map();
        for (const t of library || []) {
            if (!t || !t.path) continue;
            const k = dupeKey(t);
            if (!k) continue;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(t);
        }
        const out = [];
        for (const list of groups.values()) {
            if (list.length < 2) continue;
            const sorted = list.slice().sort((a, b) => rank(b) - rank(a));
            out.push({ keep: sorted[0], extra: sorted.slice(1) });
        }
        return out;
    }

    const spec = (t) => {
        const ext = (String(t.path).match(/\.([a-z0-9]+)$/i) || [])[1];
        const parts = [ext ? ext.toUpperCase() : ''];
        if (t.bitsPerSample && t.sampleRate) parts.push(`${t.bitsPerSample}/${(t.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')}`);
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
        const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
        const title = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t.title || '') : String(t.title || '')) || '未知标题';
        const toast = (message, action) => { try { global.MusicToast?.show?.({ message, action, duration: action ? 10000 : undefined }); } catch (e) { /* 没有提示层 */ } };

        const close = () => {
            if (!overlay) return;
            const o = overlay; overlay = null;
            global.removeEventListener('keydown', onKey, true);
            o.classList.remove('visible');
            setTimeout(() => o.remove(), 320);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) e.stopPropagation();
        };

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
            const drop = new Set();
            for (const g of groups) for (const t of g.extra) {
                if (t === current) continue; // 正在放的这份先留着
                drop.add(t);
                replace.set(t.path, g.keep.path);
            }
            if (!drop.size) return null;
            const beforeLibrary = app.playlist;
            const beforeFiltered = app.currentFilteredTracks;
            const beforeLists = JSON.stringify(app.customPlaylists || []);
            app.playlist = app.playlist.filter((t) => !drop.has(t));
            if (current) app.currentTrackIndex = Math.max(0, app.playlist.indexOf(current));
            if (Array.isArray(app.currentFilteredTracks)) app.currentFilteredTracks = app.currentFilteredTracks.filter((t) => !drop.has(t));
            let listsChanged = false;
            for (const pl of app.customPlaylists || []) {
                if (!pl || !Array.isArray(pl.tracks)) continue;
                const seen = new Set();
                const next = [];
                for (const p of pl.tracks) {
                    const q = replace.get(p) || p;
                    if (q !== p) listsChanged = true;
                    if (seen.has(q)) { listsChanged = true; continue; }
                    seen.add(q);
                    next.push(q);
                }
                pl.tracks = next;
            }
            app.saveLibrary?.();
            if (listsChanged) app.saveCustomPlaylists?.();
            refreshViews();
            return () => {
                const current2 = app.playlist?.[app.currentTrackIndex] || null;
                const kept = new Set(app.playlist);
                // 撤销期间又加进来的歌也留着
                app.playlist = beforeLibrary.filter((t) => drop.has(t) || kept.has(t)).concat(app.playlist.filter((t) => !beforeLibrary.includes(t)));
                if (current2) app.currentTrackIndex = Math.max(0, app.playlist.indexOf(current2));
                if (Array.isArray(beforeFiltered)) app.currentFilteredTracks = beforeFiltered;
                if (listsChanged) { try { app.customPlaylists = JSON.parse(beforeLists); app.saveCustomPlaylists?.(); } catch (e) { /* 歌单保持现状 */ } }
                app.saveLibrary?.();
                refreshViews();
            };
        };

        const render = () => {
            const body = overlay.querySelector('.mdupes-body');
            body.innerHTML = '';
            const groups = findDuplicates(app.playlist || []);
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
            const MAX = 200;
            groups.slice(0, MAX).forEach((g) => {
                const li = el('li', 'mdupes-group');
                const head = el('div', 'mdupes-title');
                head.appendChild(el('span', 'mstats-name', title(g.keep)));
                if (g.keep.artist) head.appendChild(el('span', 'mstats-sub', g.keep.artist));
                li.appendChild(head);
                [g.keep, ...g.extra].forEach((t, i) => {
                    const row = el('div', `mdupes-file${i === 0 ? ' keep' : ''}`);
                    row.appendChild(el('span', 'mdupes-badge', i === 0 ? '留下' : '移除'));
                    row.appendChild(el('span', 'mdupes-spec', spec(t)));
                    const where = el('span', 'mdupes-path', folderOf(t));
                    where.title = t.path;
                    row.appendChild(where);
                    li.appendChild(row);
                });
                ul.appendChild(li);
            });
            body.appendChild(ul);
            if (groups.length > MAX) body.appendChild(el('p', 'mstats-note', `还有 ${groups.length - MAX} 组没列出来，移除时一起处理。`));
        };

        app.openDupesView = () => {
            if (overlay) return;
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
            x.addEventListener('click', close);
            head.appendChild(x);
            dialog.appendChild(head);
            dialog.appendChild(el('div', 'mdupes-body'));
            const actions = el('div', 'dialog-actions');
            const cancel = el('button', 'dialog-btn cancel', '关闭');
            cancel.type = 'button';
            cancel.addEventListener('click', close);
            const go = el('button', 'dialog-btn confirm mdupes-remove', '移除多余的文件');
            go.type = 'button';
            go.addEventListener('click', () => {
                const groups = findDuplicates(app.playlist || []);
                const undo = removeExtras(groups);
                close();
                if (!undo) { toast('没有可以移除的文件（正在放的那份先留着）'); return; }
                const n = groups.reduce((k, g) => k + g.extra.length, 0);
                toast(`已从曲库移除 ${n} 个重复文件（磁盘上的没删）`, { label: '撤销', run: () => { undo(); toast('已恢复'); } });
            });
            actions.appendChild(cancel);
            actions.appendChild(go);
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
            doc.body.appendChild(overlay);
            global.addEventListener('keydown', onKey, true);
            render();
            requestAnimationFrame(() => { if (!overlay) return; overlay.classList.add('visible'); (go.hidden ? cancel : go).focus({ preventScroll: true }); });
        };
        app.findDuplicateTracks = () => findDuplicates(app.playlist || []);
    }

    const open = (app) => { setupMusicDupes(app); app?.openDupesView?.(); };
    const exported = { setupMusicDupes, open, findDuplicates, dupeKey };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicDupes = exported;
})(typeof window !== 'undefined' ? window : globalThis);
