// Musicmodules/music-m3u.js
// 歌单和别的播放器互通：导出成 .m3u8、从 .m3u / .m3u8 导入成新歌单。
// 入口：命令面板（「导出歌单「名字」」「导入歌单」），以及把 .m3u / .m3u8 文件直接拖进窗口。
// 从外面拖文件进窗口时显示整窗落点提示（.music-drop-hint，样式在 music-stats-view.css）。
// 导入时按路径对上曲库（Windows 路径不分大小写）；不在曲库但文件还在的，顺手加进曲库；文件不在了的只计数提示。
//
// 对外：app.m3u = { importFile(path?), exportPlaylist(pl), commands() }；纯函数 matchEntries / uniqueName 供测试。

(function (global) {
    'use strict';

    const SLASH_RE = /\//g;
    const EXT_RE = /\.([a-z0-9]{1,6})$/i;
    const SCHEME_RE = /^[a-z][a-z0-9+.-]+:\/\//i;
    const M3U_EXT_RE = /^m3u8?$/;
    const M3U_NAME_RE = /\.m3u8?$/i;
    const norm = (p) => {
        const s = typeof p === 'string' ? p : String(p || '');
        return (s.indexOf('/') !== -1 ? s.replace(SLASH_RE, '\\') : s).toLowerCase();
    };
    // 和主进程扫描器（musicLibraryScanner SUPPORTED_FORMATS）一致
    const SUPPORTED = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a']);
    const extOf = (name) => {
        const s = String(name || '');
        if (s.indexOf('.') === -1) return '';
        const m = EXT_RE.exec(s);
        return m ? m[1].toLowerCase() : '';
    };

    // entries: [{ path, exists }]，library: [{ path }] → { paths, toAdd, missing }
    const matchEntries = (entries, library) => {
        const list = entries || [];
        const lib = library || [];
        const entryKeys = new Array(list.length);
        const wanted = new Map();
        for (let i = 0; i < list.length; i += 1) {
            const e = list[i];
            if (!e || !e.path) continue;
            const k = norm(e.path);
            entryKeys[i] = k;
            if (!wanted.has(k)) wanted.set(k, null);
        }
        let remaining = wanted.size;
        if (remaining > 0 && lib.length > 0) {
            // 倒序遍历保持与原全量 Map 同名后项覆盖语义一致，匹配齐即提前退出
            for (let i = lib.length - 1; i >= 0; i -= 1) {
                const t = lib[i];
                if (!t || !t.path) continue;
                const k = norm(t.path);
                if (wanted.get(k) === null) {
                    wanted.set(k, t.path);
                    if (--remaining === 0) break;
                }
            }
        }
        const paths = [];
        const toAdd = [];
        const seen = new Set();
        let missing = 0;
        for (let i = 0; i < list.length; i += 1) {
            const e = list[i];
            if (!e || !e.path) continue;
            const k = entryKeys[i];
            if (seen.has(k)) continue;
            const hit = wanted.get(k);
            if (hit) { seen.add(k); paths.push(hit); }
            else if (e.exists) { seen.add(k); paths.push(e.path); toAdd.push(e.path); }
            else missing++;
        }
        return { paths, toAdd, missing };
    };

    const uniqueId = (lists) => {
        const taken = new Set();
        for (let i = 0; lists && i < lists.length; i += 1) taken.add(String(lists[i] && lists[i].id || ''));
        let id = Date.now();
        while (taken.has(String(id))) id += 1;
        return String(id);
    };
    const uniqueName = (name, lists) => {
        const base = String(name || '').trim() || '导入的歌单';
        const taken = new Set();
        for (let i = 0; lists && i < lists.length; i += 1) taken.add(String(lists[i] && lists[i].name || ''));
        if (!taken.has(base)) return base;
        for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
    };

    function setupMusicM3u(app) {
        if (!app || app.m3u) return;
        const api = () => app.api || {};
        if (typeof api().importMusicM3u !== 'function' || typeof api().exportMusicM3u !== 'function') return;
        const lists = () => (Array.isArray(app.customPlaylists) ? app.customPlaylists : (app.customPlaylists = []));
        const toast = (message, extra = {}) => { try { global.MusicToast?.show?.({ message, ...extra }); } catch (e) { /* 没有提示层 */ } };
        const refreshViews = () => {
            try { app.saveCustomPlaylists?.(); } catch (e) { /* 存不了也先在界面上生效 */ }
            try { app.archiveView?.refresh?.(); } catch (e) { /* 档案页没开 */ }
            if (app.currentSidebarView === 'playlists') { try { app.renderSidebarContent?.('playlists'); } catch (e) { /* 旧侧栏 */ } }
        };

        const importFile = async (path) => {
            let res;
            try { res = await api().importMusicM3u(path ? { path } : {}); } catch (e) { res = { ok: false, message: String(e && e.message || e) }; }
            if (!res || !res.ok) {
                if (res && !res.canceled) toast(`导入歌单失败：${res.message || '读不了这个文件'}`, { kind: 'error' });
                return null;
            }
            const { paths, toAdd, missing } = matchEntries(res.entries, app.playlist);
            const lost = missing + (Number(res.skipped) || 0);
            if (!paths.length) {
                toast(res.entries?.length || lost ? `「${res.name}」里的 ${lost} 首在这台电脑上都找不到，没有导入` : `「${res.name}」是空的，没有导入`, { kind: 'error', duration: 6000 });
                return null;
            }
            const pl = { id: uniqueId(lists()), name: uniqueName(res.name, lists()), tracks: paths };
            lists().push(pl);
            refreshViews();
            if (toAdd.length) { try { api().addMusicPaths?.(toAdd)?.catch?.(() => {}); } catch (e) { /* 曲库之后自己会扫到 */ } }
            const notes = [];
            if (toAdd.length) notes.push(`${toAdd.length} 首原来不在曲库里，已一并加进来`);
            if (lost) notes.push(`${lost} 首找不到文件，跳过了`);
            toast(`已导入歌单「${pl.name}」：${paths.length} 首${notes.length ? '。' + notes.join('；') : ''}`, {
                kind: 'success',
                duration: notes.length ? 7000 : 4500,
                action: { label: '撤销', run: () => { const at = lists().indexOf(pl); if (at !== -1) { lists().splice(at, 1); refreshViews(); } } }
            });
            return pl;
        };

        const exportPlaylist = async (pl) => {
            if (!pl) return null;
            const rawTracks = pl.tracks || [];
            const lib = app.playlist || [];
            const normKeys = new Array(rawTracks.length);
            const matched = new Map();
            for (let i = 0; i < rawTracks.length; i += 1) {
                const k = norm(rawTracks[i]);
                normKeys[i] = k;
                if (!matched.has(k)) matched.set(k, null);
            }
            let remaining = matched.size;
            if (remaining > 0 && lib.length > 0) {
                for (let i = 0; i < lib.length; i += 1) {
                    const t = lib[i];
                    if (!t || !t.path) continue;
                    const k = norm(t.path);
                    if (matched.get(k) === null) {
                        matched.set(k, t);
                        if (--remaining === 0) break;
                    }
                }
            }
            const tracks = [];
            for (let i = 0; i < rawTracks.length; i += 1) {
                const p = rawTracks[i];
                const t = matched.get(normKeys[i]);
                const path = t ? t.path : p;
                if (typeof path !== 'string' || (path.indexOf('://') !== -1 && SCHEME_RE.test(path))) continue; // 云端（WebDAV）的歌别的播放器打不开
                tracks.push(t ? { path, title: t.title || '', artist: t.artist || '', duration: Number(t.duration) || 0 } : { path });
            }
            if (!tracks.length) { toast(`「${pl.name}」里没有本机的歌，没什么可导出的`, { kind: 'error' }); return null; }
            let res;
            try { res = await api().exportMusicM3u({ name: pl.name || '', tracks }); } catch (e) { res = { ok: false, message: String(e && e.message || e) }; }
            if (!res || !res.ok) {
                if (res && !res.canceled) toast(`导出失败：${res.message || '写不进去'}`, { kind: 'error' });
                return null;
            }
            const skipped = (pl.tracks || []).length - tracks.length;
            // 导出完给个「在文件夹中显示」：存到哪了一眼看到，拖给别的播放器、发给别人都顺手
            const reveal = res.file && typeof api().showMusicInFolder === 'function'
                ? { label: '在文件夹中显示', run: () => { Promise.resolve(api().showMusicInFolder({ path: res.file })).catch(() => {}); } }
                : undefined;
            toast(`已导出「${pl.name}」：${tracks.length} 首${skipped > 0 ? `（${skipped} 首云端的歌没写进去）` : ''}`, { kind: 'success', duration: reveal ? 6000 : undefined, action: reveal });
            return res.file;
        };

        const commands = () => {
            const out = [
                { id: 'm3u-import', group: '歌单', icon: 'list-music', title: '导入歌单（.m3u8 / .m3u）', desc: '把别的播放器导出的歌单变成这里的歌单；也可以直接把文件拖进窗口', words: 'import m3u m3u8 playlist 导入 歌单 daoru gedan', run: () => importFile() }
            ];
            const pls = lists();
            for (let i = 0; i < pls.length; i += 1) {
                const pl = pls[i];
                if (!pl || !pl.tracks || !pl.tracks.length) continue;
                out.push({
                    id: `m3u-export:${pl.id}`, group: '歌单', icon: 'list-music', title: `导出歌单「${pl.name || '未命名歌单'}」`,
                    desc: `${pl.tracks.length} 首，存成 .m3u8，别的播放器也能打开`, words: `export m3u m3u8 playlist 导出 歌单 daochu gedan ${pl.name || ''}`,
                    run: () => exportPlaylist(pl)
                });
            }
            return out;
        };

        // 拖进来的文件里有曲库收不了的格式（.ape、.wma、图片、压缩包…）时说一声：以前松手后什么也不发生，不知道是没加上还是还在扫
        const noteUnsupported = (files, dirs = 0) => {
            let oddCount = 0;
            const kindList = [];
            const seenKinds = new Set();
            for (let i = 0; i < files.length; i += 1) {
                const ext = extOf(files[i].name);
                if (!ext || SUPPORTED.has(ext) || M3U_EXT_RE.test(ext)) continue;
                oddCount += 1;
                if (kindList.length < 4) {
                    const up = ext.toUpperCase();
                    if (!seenKinds.has(up)) { seenKinds.add(up); kindList.push(up); }
                }
            }
            if (!oddCount) return;
            const kinds = kindList.join('、');
            const all = oddCount === files.length && !dirs;
            toast(all
                ? `拖进来的${oddCount > 1 ? ` ${oddCount} 个` : ''}文件曲库收不了（${kinds}）。能加的格式：FLAC、MP3、WAV、OGG、M4A，或者整个文件夹`
                : `有 ${oddCount} 个文件曲库收不了（${kinds}），跳过了；其余的正在加进曲库`, { kind: all ? 'error' : 'info', duration: 6000 });
        };

        // 拖进来的 .m3u / .m3u8：当歌单导入（music.js 那边把音频文件加进曲库，歌单文件它会忽略）
        const doc = global.document;
        if (doc && typeof api().getPathForFile === 'function') {
            // 从资源管理器拖文件进来时整个窗口给个落点提示（以前拖进来什么反应都没有，不知道能不能放）
            let hint = null;
            let depth = 0;
            const isFileDrag = (event) => {
                const types = event.dataTransfer?.types;
                if (!types) return false;
                if (typeof types.includes === 'function') return types.includes('Files');
                if (typeof types.contains === 'function') return types.contains('Files');
                for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
                return false;
            };
            let hintRaf = 0;
            const showHint = () => {
                if (!hint) {
                    hint = doc.createElement('div');
                    hint.className = 'music-drop-hint';
                    hint.setAttribute('aria-hidden', 'true');
                    const card = doc.createElement('div');
                    card.className = 'music-drop-hint-card';
                    const b = doc.createElement('b');
                    b.textContent = '松开，加进曲库';
                    const span = doc.createElement('span');
                    span.textContent = '歌曲和文件夹加进曲库；.m3u / .m3u8 歌单导入成新歌单';
                    card.append(b, span);
                    hint.appendChild(card);
                    doc.body.appendChild(hint);
                }
                if (hintRaf) global.cancelAnimationFrame?.(hintRaf);
                hintRaf = global.requestAnimationFrame?.(() => { hintRaf = 0; if (hint && depth > 0) hint.classList.add('visible'); }) || 0;
            };
            // 保险：拖着悬停时 dragover 每几十毫秒来一次；停了大半秒还没来（按了 Esc、拖到别的窗口没收到 dragleave）就收起，提示不会卡在屏幕上
            let idle = 0;
            let lastDragOverAt = 0;
            const hideHint = () => {
                depth = 0;
                lastDragOverAt = 0;
                clearTimeout(idle); idle = 0;
                if (hintRaf) { global.cancelAnimationFrame?.(hintRaf); hintRaf = 0; }
                if (hint) hint.classList.remove('visible');
            };
            const onDragEnter = (event) => { if (!isFileDrag(event)) return; if (++depth === 1) showHint(); };
            const onDragOver = (event) => {
                if (!isFileDrag(event)) return;
                const now = Date.now();
                if (idle && now - lastDragOverAt < 150) return;
                lastDragOverAt = now;
                clearTimeout(idle);
                idle = setTimeout(hideHint, 700);
            };
            const onDragLeave = (event) => { if (!isFileDrag(event)) return; depth = Math.max(0, depth - 1); if (!depth) hideHint(); };
            const onDrop = (event) => {
                // 文件夹名也可能带点（「Vol.1」）：用 webkitGetAsEntry 认出文件夹，只看真正的文件
                const dt = event.dataTransfer;
                const rawFiles = dt?.files;
                if (isFileDrag(event)) {
                    const items = dt?.items;
                    const plain = [];
                    let dirs = 0;
                    if (items && items.length) {
                        for (let i = 0; i < items.length; i += 1) {
                            const it = items[i];
                            let entry = null;
                            try { entry = it.webkitGetAsEntry?.(); } catch (x) { entry = null; }
                            if (entry && entry.isDirectory) { dirs += 1; continue; }
                            const f = it.getAsFile?.();
                            if (f) plain.push(f);
                        }
                    } else if (rawFiles) {
                        for (let i = 0; i < rawFiles.length; i += 1) plain.push(rawFiles[i]);
                    }
                    noteUnsupported(plain, dirs);
                }
                if (!rawFiles || !rawFiles.length) return;
                for (let i = 0; i < rawFiles.length; i += 1) {
                    const f = rawFiles[i];
                    const name = f && f.name ? String(f.name) : '';
                    if (!name || name.indexOf('.') === -1 || !M3U_NAME_RE.test(name)) continue;
                    let p = '';
                    try { p = api().getPathForFile(f); } catch (e) { p = ''; }
                    if (p) importFile(p);
                }
            };
            doc.addEventListener('dragenter', onDragEnter, true);
            doc.addEventListener('dragover', onDragOver, true);
            doc.addEventListener('dragleave', onDragLeave, true);
            doc.addEventListener('dragend', hideHint, true);
            global.addEventListener?.('blur', hideHint);
            doc.addEventListener('drop', hideHint, true);
            doc.addEventListener('drop', onDrop);
            global.addEventListener?.('beforeunload', () => {
                hideHint();
                if (hint) { hint.remove(); hint = null; }
                doc.removeEventListener('dragenter', onDragEnter, true);
                doc.removeEventListener('dragover', onDragOver, true);
                doc.removeEventListener('dragleave', onDragLeave, true);
                doc.removeEventListener('dragend', hideHint, true);
                global.removeEventListener?.('blur', hideHint);
                doc.removeEventListener('drop', hideHint, true);
                doc.removeEventListener('drop', onDrop);
            }, { once: true });
        }

        app.m3u = { importFile, exportPlaylist, commands };
    }

    const exported = { setupMusicM3u, matchEntries, uniqueName };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicM3u = exported;
})(typeof window !== 'undefined' ? window : globalThis);
