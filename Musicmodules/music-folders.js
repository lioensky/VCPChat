// Musicmodules/music-folders.js
// 「曲库文件夹」对话框：曲库从哪些文件夹来、各有几首，能打开、能整个移出曲库（磁盘上的文件不动），能加新文件夹、立即重扫。
// 以前加过的文件夹看不到也去不掉，只能一首首右键移除。入口在命令面板（「曲库文件夹」）。
// 加过的文件夹（主进程 music_folders.json）列在前面，曲库里其余的歌按所在位置归并成几处「其他位置」一起列出。
//
// 对外：app.openLibraryFolders()；纯函数 folderRows / underDir 供测试。

(function (global) {
    'use strict';

    const key = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const underDir = (file, dir) => { const f = key(file); const d = key(dir); return f === d || f.startsWith(d + '\\'); };
    const parentOf = (dir) => { const s = String(dir).replace(/[\\/]+$/, ''); const at = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return at > 0 ? s.slice(0, at) : ''; };
    // 盘符根（D:）或只有一层的路径不再往上并：「D:\」整个盘当一处没意义
    const depth = (dir) => String(dir).split(/[\\/]+/).filter(Boolean).length;
    const isLocal = (p) => typeof p === 'string' && p !== '' && !/^[a-z][a-z0-9+.-]+:\/\//i.test(p);

    // → [{ path, count, remembered, exists }]：加过的在前（按原顺序），其他位置按歌数从多到少
    // 几万首、几千个散落文件夹也要快：路径的比较键都先算好，包含关系按「往上找祖先」查表，不两两比较。
    const ancestors = (k) => { const out = []; for (let at = k.lastIndexOf('\\'); at > 0; at = k.lastIndexOf('\\', at - 1)) out.push(k.slice(0, at)); return out; };
    const folderRows = (remembered, tracks) => {
        const rows = (remembered || []).map((f) => ({ path: f.path || f, count: 0, remembered: true, exists: f.exists !== false }));
        const rowKeys = rows.map((r) => key(r.path));
        const others = new Map();
        const homeOf = new Map(); // 上级目录键 → 归到哪个加过的文件夹（-1 = 都不是）
        for (const t of tracks || []) {
            const p = t && t.path;
            if (!isLocal(p) || t.isRemote) continue;
            const dir = parentOf(p);
            const dk = key(dir || p);
            let home = homeOf.get(dk);
            if (home === undefined) {
                home = rowKeys.findIndex((rk) => dk === rk || dk.startsWith(rk + '\\'));
                homeOf.set(dk, home);
            }
            if (home !== -1) { rows[home].count++; continue; }
            if (!dir) continue;
            const had = others.get(dk);
            if (had) had.count++; else others.set(dk, { path: dir, count: 1, k: dk });
        }
        // 同一个上级下面有两个以上文件夹的，并成上级（D:\\Music\\歌手A、D:\\Music\\歌手B → D:\\Music），直到不再变
        const byKey = others; // 键 → 条目
        for (let changed = true; changed;) {
            changed = false;
            const byParent = new Map();
            for (const e of byKey.values()) {
                const up = parentOf(e.path);
                if (!up || depth(up) < 2) continue;
                const k = key(up);
                if (!byParent.has(k)) byParent.set(k, { path: up, k, kids: [] });
                byParent.get(k).kids.push(e);
            }
            for (const { path, k, kids } of byParent.values()) {
                if (kids.length < 2) continue;
                const merged = { path, k, count: kids.reduce((n, e) => n + e.count, 0) };
                for (const e of kids) byKey.delete(e.k);
                // 已有的上级本身（歌直接放在上级里）也并进来
                const self = byKey.get(k);
                if (self) merged.count += self.count;
                byKey.set(k, merged);
                changed = true;
            }
            // 被别的条目包含的（上级并出来以后）也收进去：往上找最外层的那个
            for (const e of [...byKey.values()]) {
                if (!byKey.has(e.k)) continue;
                const outerKey = ancestors(e.k).reverse().find((a) => byKey.has(a));
                if (outerKey) { byKey.get(outerKey).count += e.count; byKey.delete(e.k); changed = true; }
            }
        }
        const list = [...byKey.values()].sort((a, b) => b.count - a.count);
        return rows.concat(list.map((e) => ({ path: e.path, count: e.count, remembered: false, exists: true })));
    };

    function setupMusicFolders(app) {
        if (!app || app.openLibraryFolders) return;
        const doc = global.document;
        const call = (payload) => (typeof app.api?.musicLibraryFolders === 'function' ? app.api.musicLibraryFolders(payload) : Promise.resolve({ ok: false, message: '这一版还不能管理曲库文件夹' }));
        if (!doc || typeof app.api?.musicLibraryFolders !== 'function') return;
        const toast = (message, extra = {}) => { try { global.MusicToast?.show?.({ message, ...extra }); } catch (e) { /* 没有提示层 */ } };
        const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
        const refreshViews = () => {
            if (Array.isArray(app.currentFilteredTracks) && app.playlistViewSource) app.renderPlaylist?.(app.currentFilteredTracks);
            else app.renderPlaylist?.();
            try { app.renderSidebarContent?.(app.currentSidebarView); } catch (e) { /* 旧视图 */ }
            try { app.archiveView?.refresh?.(); } catch (e) { /* 档案页没开 */ }
            app.refreshPreload?.();
            try { doc.dispatchEvent(new CustomEvent('music-queue-change')); } catch (e) { /* 旧内核 */ }
        };

        let overlay = null;
        let previousFocus = null;
        // 开着的时候曲库变了（加文件夹、重扫、后台同步在扫）就跟着刷新歌数，不用关掉再开
        let watchTimer = 0;
        let seen = null;
        const libraryMark = () => { const l = app.playlist || []; return `${l.length}:${l[0]?.path || ''}:${l[l.length - 1]?.path || ''}`; };
        const close = () => {
            if (!overlay) return;
            const o = overlay;
            overlay = null;
            global.removeEventListener('keydown', onKey, true);
            clearInterval(watchTimer);
            o.classList.remove('visible');
            setTimeout(() => o.remove(), 320);
            const back = previousFocus;
            previousFocus = null;
            if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch (e) { /* 还不回去就算了 */ } }
        };
        // MusicDialog 的确认框开着时 Esc 和焦点归它
        const onKey = (e) => {
            if (doc.querySelector('.dialog-overlay.music-dialog')) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
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
            }
        };

        // 把这个文件夹下的歌从曲库拿掉（正在放的那首留着），然后让主进程忘掉这个文件夹
        const removeFolder = async (row) => {
            const ok = global.MusicDialog?.confirm
                ? await global.MusicDialog.confirm({ title: '把这个文件夹移出曲库？', message: `「${row.path}」里的 ${row.count} 首会从曲库里拿掉${row.remembered ? '，之后也不再自动同步' : ''}。磁盘上的文件不会删除。`, confirmText: '移出曲库', danger: true })
                : true;
            if (!ok) return;
            const current = app.playlist?.[app.currentTrackIndex] || null;
            const rowKey = key(row.path);
            const rowPrefix = rowKey + '\\';
            const inRow = (p) => { const f = key(p); return f === rowKey || f.startsWith(rowPrefix); };
            const drop = new Set((app.playlist || []).filter((t) => t && t !== current && isLocal(t.path) && inRow(t.path)));
            const keptPlaying = current && isLocal(current.path) && inRow(current.path);
            if (drop.size) {
                app.playlist = app.playlist.filter((t) => !drop.has(t));
                if (current) app.currentTrackIndex = Math.max(0, app.playlist.indexOf(current));
                if (Array.isArray(app.currentFilteredTracks)) app.currentFilteredTracks = app.currentFilteredTracks.filter((t) => !drop.has(t));
                if (Array.isArray(app.manualQueue) && app.manualQueue.length) {
                    for (const t of drop) {
                        let at;
                        while ((at = app.manualQueue.indexOf(t)) !== -1) {
                            const prevLen = app.manualQueue.length;
                            app.queueRemove?.(at);
                            if (app.manualQueue.length >= prevLen) break;
                        }
                    }
                }
                try { await app.saveLibrary?.(); } catch (e) { /* 存盘失败另有提示 */ }
                refreshViews();
            }
            // 只有「自动同步」的文件夹才需要让主进程忘掉；「其他位置」本来就不在同步列表里
            if (row.remembered) {
                const res = await call({ op: 'forget', path: row.path }).catch((e) => ({ ok: false, message: String(e && e.message || e) }));
                if (!res || !res.ok) toast(`文件夹没能从同步列表里去掉：${res?.message || ''}`, { kind: 'error' });
            }
            const gone = [...drop];
            toast(`已把「${row.path}」移出曲库：${drop.size} 首${keptPlaying ? '（正在放的那首留着）' : ''}`, {
                kind: 'success',
                duration: 7000,
                // 撤销：把拿掉的歌原样放回曲库（播放统计、歌单都还对得上），自动同步的文件夹再加回同步列表
                action: { label: '撤销', run: async () => {
                    const have = new Set((app.playlist || []).map((t) => key(t && t.path)));
                    const back = gone.filter((t) => !have.has(key(t.path)));
                    if (back.length) {
                        app.playlist = (app.playlist || []).concat(back);
                        try { await app.saveLibrary?.(); } catch (e) { /* 存盘失败另有提示 */ }
                        refreshViews();
                    }
                    if (row.remembered && typeof app.api?.addMusicPaths === 'function') { try { app.api.addMusicPaths([row.path])?.catch?.(() => {}); } catch (e) { /* 下次扫描会补上 */ } }
                    render();
                } }
            });
            render();
        };

        const render = async () => {
            if (!overlay) return;
            const body = overlay.querySelector('.mfold-body');
            const res = await call({ op: 'list' }).catch(() => null);
            if (!overlay) return;
            const rows = folderRows(res && res.ok ? res.folders : [], app.playlist);
            body.innerHTML = '';
            if (!rows.length) {
                body.appendChild(el('p', 'mstats-empty', '曲库里还没有本机文件夹。点下面的「添加文件夹」，或者直接把文件夹拖进窗口。'));
                return;
            }
            const ul = el('ul', 'mfold-list');
            const frag = doc.createDocumentFragment();
            for (const row of rows) {
                const li = el('li', 'mfold-row' + (row.exists ? '' : ' missing'));
                const text = el('div', 'mfold-text');
                const p = el('span', 'mfold-path', row.path);
                p.title = row.path;
                text.appendChild(p);
                const meta = [`${row.count} 首`, row.remembered ? '自动同步' : '其他位置', row.exists ? '' : '找不到这个文件夹（拔掉的盘？）'].filter(Boolean).join(' · ');
                text.appendChild(el('span', 'mfold-meta', meta));
                li.appendChild(text);
                const acts = el('div', 'mfold-acts');
                if (row.exists) {
                    const open = el('button', 'minfo-btn', '打开');
                    open.type = 'button';
                    open.addEventListener('click', async () => {
                        const r = await call({ op: 'open', path: row.path }).catch(() => null);
                        if (!r || !r.ok) toast(r?.message || '打不开这个文件夹', { kind: 'error' });
                    });
                    acts.appendChild(open);
                }
                const rm = el('button', 'minfo-btn mfold-remove', '移出曲库');
                rm.type = 'button';
                rm.addEventListener('click', () => removeFolder(row));
                acts.appendChild(rm);
                li.appendChild(acts);
                frag.appendChild(li);
            }
            ul.appendChild(frag);
            body.appendChild(ul);
        };

        app.openLibraryFolders = () => {
            if (overlay) return;
            previousFocus = doc.activeElement;
            overlay = el('div', 'dialog-overlay music-stats-dialog');
            const dialog = el('div', 'dialog glass-panel mstats minfo mfold');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'mfold-title');
            const head = el('header', 'mstats-head');
            const h = el('h3', '', '曲库文件夹');
            h.id = 'mfold-title';
            head.appendChild(h);
            const x = el('button', 'mstats-close', '×');
            x.type = 'button';
            x.setAttribute('aria-label', '关闭');
            x.addEventListener('click', close);
            head.appendChild(x);
            dialog.appendChild(head);
            dialog.appendChild(el('p', 'mfold-lead', '「自动同步」的文件夹里新增、删掉、改过的歌会自动更新到曲库。移出曲库不会删除磁盘上的文件。'));
            const body = el('div', 'mfold-body');
            body.appendChild(el('p', 'mstats-empty', '正在读取…'));
            dialog.appendChild(body);
            const actions = el('div', 'minfo-actions');
            const rescan = el('button', 'minfo-btn', '立即重新扫描');
            rescan.type = 'button';
            rescan.addEventListener('click', async () => {
                const r = await call({ op: 'rescan' }).catch(() => null);
                toast(r && r.ok ? '已开始在后台对一遍磁盘，有变化会自动更新' : (r?.message || '没能开始扫描'), { kind: r && r.ok ? 'success' : 'error' });
            });
            actions.appendChild(rescan);
            if (typeof app.api?.addMusicFolder === 'function') {
                const add = el('button', 'minfo-btn', '添加文件夹');
                add.type = 'button';
                add.addEventListener('click', async () => { try { await app.api.addMusicFolder(); } catch (e) { /* 取消了 */ } render(); });
                actions.appendChild(add);
            }
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
            doc.body.appendChild(overlay);
            global.addEventListener('keydown', onKey, true);
            global.requestAnimationFrame?.(() => overlay && overlay.classList.add('visible'));
            try { x.focus({ preventScroll: true }); } catch (e) { /* 没关系 */ }
            seen = libraryMark();
            watchTimer = setInterval(() => { if (doc.hidden) return; const m = libraryMark(); if (m !== seen) { seen = m; render(); } }, 1500);
            watchTimer?.unref?.(); // node 测试里不拖住进程
            render();
        };
    }

    const exported = { setupMusicFolders, folderRows, underDir };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicFolders = exported;
})(typeof window !== 'undefined' ? window : globalThis);
