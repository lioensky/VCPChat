// Musicmodules/music-m3u.js
// 歌单和别的播放器互通：导出成 .m3u8、从 .m3u / .m3u8 导入成新歌单。
// 入口：命令面板（「导出歌单「名字」」「导入歌单」），以及把 .m3u / .m3u8 文件直接拖进窗口。
// 从外面拖文件进窗口时显示整窗落点提示（.music-drop-hint，样式在 music-stats-view.css）。
// 导入时按路径对上曲库（Windows 路径不分大小写）；不在曲库但文件还在的，顺手加进曲库；文件不在了的只计数提示。
//
// 对外：app.m3u = { importFile(path?), exportPlaylist(pl), commands() }；纯函数 matchEntries / uniqueName 供测试。

(function (global) {
    'use strict';

    const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
    // 和主进程扫描器（musicLibraryScanner SUPPORTED_FORMATS）一致
    const SUPPORTED = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a']);
    const extOf = (name) => { const m = /\.([a-z0-9]{1,6})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

    // entries: [{ path, exists }]，library: [{ path }] → { paths, toAdd, missing }
    const matchEntries = (entries, library) => {
        const byPath = new Map();
        for (const t of library || []) if (t && t.path) byPath.set(norm(t.path), t.path);
        const paths = [];
        const toAdd = [];
        const seen = new Set();
        let missing = 0;
        for (const e of entries || []) {
            if (!e || !e.path) continue;
            const key = norm(e.path);
            if (seen.has(key)) continue;
            const hit = byPath.get(key);
            if (hit) { seen.add(key); paths.push(hit); }
            else if (e.exists) { seen.add(key); paths.push(e.path); toAdd.push(e.path); }
            else missing++;
        }
        return { paths, toAdd, missing };
    };

    // 和已有歌单重名时加「 (2)」「 (3)」
    const uniqueName = (name, lists) => {
        const base = String(name || '').trim() || '导入的歌单';
        const taken = new Set((lists || []).map((p) => String(p && p.name || '')));
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
            const pl = { id: Date.now().toString(), name: uniqueName(res.name, lists()), tracks: paths };
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
            const byPath = new Map((app.playlist || []).map((t) => [t.path, t]));
            const tracks = (pl.tracks || []).map((p) => {
                const t = byPath.get(p);
                return t ? { path: t.path, title: t.title || '', artist: t.artist || '', duration: Number(t.duration) || 0 } : { path: p };
            }).filter((t) => typeof t.path === 'string' && !/^[a-z][a-z0-9+.-]+:\/\//i.test(t.path)); // 云端（WebDAV）的歌别的播放器打不开
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

        const commands = () => [
            { id: 'm3u-import', group: '歌单', icon: 'list-music', title: '导入歌单（.m3u8 / .m3u）', desc: '把别的播放器导出的歌单变成这里的歌单；也可以直接把文件拖进窗口', words: 'import m3u m3u8 playlist 导入 歌单 daoru gedan', run: () => importFile() },
            ...lists().filter((pl) => pl && (pl.tracks || []).length).map((pl) => ({
                id: `m3u-export:${pl.id}`, group: '歌单', icon: 'list-music', title: `导出歌单「${pl.name || '未命名歌单'}」`,
                desc: `${pl.tracks.length} 首，存成 .m3u8，别的播放器也能打开`, words: `export m3u m3u8 playlist 导出 歌单 daochu gedan ${pl.name || ''}`,
                run: () => exportPlaylist(pl)
            }))
        ];

        // 拖进来的文件里有曲库收不了的格式（.ape、.wma、图片、压缩包…）时说一声：以前松手后什么也不发生，不知道是没加上还是还在扫
        const noteUnsupported = (files, dirs = 0) => {
            const odd = files.filter((f) => { const ext = extOf(f.name); return ext && !SUPPORTED.has(ext) && !/^m3u8?$/.test(ext); });
            if (!odd.length) return;
            const kinds = [...new Set(odd.map((f) => extOf(f.name).toUpperCase()))].slice(0, 4).join('、');
            const all = odd.length === files.length && !dirs;
            toast(all
                ? `拖进来的${odd.length > 1 ? ` ${odd.length} 个` : ''}文件曲库收不了（${kinds}）。能加的格式：FLAC、MP3、WAV、OGG、M4A，或者整个文件夹`
                : `有 ${odd.length} 个文件曲库收不了（${kinds}），跳过了；其余的正在加进曲库`, { kind: all ? 'error' : 'info', duration: 6000 });
        };

        // 拖进来的 .m3u / .m3u8：当歌单导入（music.js 那边把音频文件加进曲库，歌单文件它会忽略）
        const doc = global.document;
        if (doc && typeof api().getPathForFile === 'function') {
            // 从资源管理器拖文件进来时整个窗口给个落点提示（以前拖进来什么反应都没有，不知道能不能放）
            let hint = null;
            let depth = 0;
            const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
            const showHint = () => {
                if (!hint) {
                    hint = doc.createElement('div');
                    hint.className = 'music-drop-hint';
                    hint.setAttribute('aria-hidden', 'true');
                    hint.innerHTML = '<div class="music-drop-hint-card"><b>松开，加进曲库</b><span>歌曲和文件夹加进曲库；.m3u / .m3u8 歌单导入成新歌单</span></div>';
                    doc.body.appendChild(hint);
                }
                global.requestAnimationFrame?.(() => { if (hint && depth > 0) hint.classList.add('visible'); });
            };
            // 保险：拖着悬停时 dragover 每几十毫秒来一次；停了大半秒还没来（按了 Esc、拖到别的窗口没收到 dragleave）就收起，提示不会卡在屏幕上
            let idle = 0;
            const hideHint = () => { depth = 0; clearTimeout(idle); if (hint) hint.classList.remove('visible'); };
            doc.addEventListener('dragenter', (event) => { if (!isFileDrag(event)) return; depth++; showHint(); }, true);
            doc.addEventListener('dragover', (event) => { if (!isFileDrag(event)) return; clearTimeout(idle); idle = setTimeout(hideHint, 700); }, true);
            doc.addEventListener('dragleave', (event) => { if (!isFileDrag(event)) return; depth = Math.max(0, depth - 1); if (!depth) hideHint(); }, true);
            doc.addEventListener('dragend', hideHint, true);
            global.addEventListener?.('blur', hideHint);
            doc.addEventListener('drop', hideHint, true);
            doc.addEventListener('drop', (event) => {
                // 文件夹名也可能带点（「Vol.1」）：用 webkitGetAsEntry 认出文件夹，只看真正的文件
                if (isFileDrag(event)) {
                    const items = Array.from(event.dataTransfer?.items || []);
                    const plain = items.length
                        ? items.map((it) => { let e = null; try { e = it.webkitGetAsEntry?.(); } catch (x) { e = null; } return e && e.isDirectory ? null : it.getAsFile?.(); }).filter(Boolean)
                        : Array.from(event.dataTransfer?.files || []);
                    const dirs = items.length - plain.length;
                    noteUnsupported(plain, dirs);
                }
                const files = Array.from(event.dataTransfer?.files || []).filter((f) => /\.m3u8?$/i.test(f.name || ''));
                if (!files.length) return;
                for (const f of files) {
                    let p = '';
                    try { p = api().getPathForFile(f); } catch (e) { p = ''; }
                    if (p) importFile(p);
                }
            });
        }

        app.m3u = { importFile, exportPlaylist, commands };
    }

    const exported = { setupMusicM3u, matchEntries, uniqueName };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicM3u = exported;
})(typeof window !== 'undefined' ? window : globalThis);
