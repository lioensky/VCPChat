// Musicmodules/music-track-file.js
// 曲目右键菜单的两项文件相关操作：
// 「在文件夹中显示」：打开资源管理器并选中这个文件（整理文件、改标签、找同专辑其他文件时用）；云端（WebDAV）的歌藏起这一项。
// 「歌曲信息」：格式、采样率、位深、码率、大小、改动时间、听过几次、文件位置，一个对话框里看全（命令面板里也有，看正在放的这首）。

(function (global) {
    'use strict';

    const isLocal = (p) => typeof p === 'string' && p !== '' && !/^[a-z][a-z0-9+.-]+:\/\//i.test(p);

    const pad2 = (n) => String(n).padStart(2, '0');
    const clock = (sec) => {
        const s = Math.round(Number(sec) || 0);
        if (s <= 0) return '';
        const h = Math.floor(s / 3600);
        return h ? `${h}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`;
    };
    const day = (ms) => {
        const d = new Date(Number(ms));
        return Number.isFinite(d.getTime()) && Number(ms) > 0 ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '';
    };
    const size = (bytes) => {
        const b = Number(bytes);
        if (!(b > 0)) return '';
        return b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
    };
    const extOf = (p) => { const m = /\.([a-z0-9]{1,5})$/i.exec(String(p || '').split(/[?#]/)[0]); return m ? m[1].toUpperCase() : ''; };

    // 对话框里的每一行 [标签, 内容]；没有的信息不列（旧曲库没有采样率这些字段）
    const describeTrack = (track, stat) => {
        const t = track || {};
        const rows = [];
        const push = (k, v) => { if (v !== undefined && v !== null && String(v) !== '') rows.push([k, String(v)]); };
        push('歌手', t.artist);
        push('专辑', t.album);
        if (t.albumArtist && t.albumArtist !== t.artist) push('专辑歌手', t.albumArtist);
        const disc = Number(t.discNo) > 0 ? Number(t.discNo) : 0;
        const no = Number(t.trackNo) > 0 ? Number(t.trackNo) : 0;
        push('曲目', no ? (disc ? `第 ${disc} 碟 · 第 ${no} 首` : `第 ${no} 首`) : '');
        push('年份', Number(t.year) > 0 ? String(t.year) : '');
        push('流派', t.genre);
        const fmt = extOf(t.path);
        const codec = t.codec && String(t.codec).toUpperCase() !== fmt ? String(t.codec) : '';
        push('格式', [fmt, codec, t.lossless === true ? '无损' : t.lossless === false ? '有损' : ''].filter(Boolean).join(' · '));
        const sr = Number(t.sampleRate);
        const ch = Number(t.numberOfChannels);
        push('规格', [
            sr > 0 ? `${(sr / 1000).toFixed(sr % 1000 ? 1 : 0)} kHz` : '',
            t.bitsPerSample ? `${t.bitsPerSample} bit` : '',
            ch === 1 ? '单声道' : ch === 2 ? '立体声' : ch > 2 ? `${ch} 声道` : '',
            Number(t.bitrate) > 0 ? `${Math.round(t.bitrate / 1000)} kbps` : ''
        ].filter(Boolean).join(' · '));
        push('时长', clock(t.duration));
        push('大小', size(t.size));
        push('改动时间', day(t.mtimeMs));
        if (stat && (stat.plays || stat.skips)) {
            push('听过', [`${stat.plays || 0} 次`, stat.last ? `上次 ${day(stat.last)}` : '', stat.skips ? `跳过 ${stat.skips} 次` : ''].filter(Boolean).join(' · '));
        } else if (stat !== undefined) {
            push('听过', '还没听过');
        }
        // 云端地址里的中文是 %E6%AD%8C 这种，显示时还原成字（复制路径仍然复制原样）
        let where = t.path;
        if (!isLocal(where) && typeof where === 'string') { try { where = decodeURI(where); } catch (e) { /* 不是合法编码就原样 */ } }
        push('位置', where);
        return rows;
    };

    function setupMusicTrackFile(app) {
        if (!app || app.showTrackInFolder) return;
        const doc = global.document;
        if (typeof app.api?.showMusicInFolder !== 'function') return;
        const toast = (message) => { try { global.MusicToast?.show?.({ kind: 'error', message }); } catch (e) { /* 没有提示层 */ } };

        app.showTrackInFolder = async (ref) => {
            const track = typeof ref === 'number' ? app.playlist?.[ref] : ref;
            if (!track || !isLocal(track.path)) { toast('云端的歌没有本机文件'); return false; }
            let res;
            try { res = await app.api.showMusicInFolder({ path: track.path }); } catch (e) { res = { ok: false, message: String(e && e.message || e) }; }
            if (!res || !res.ok) { toast(res?.message || '打不开文件所在的文件夹'); return false; }
            return true;
        };

        // 歌曲信息对话框（样式借听歌统计那套 .mstats）
        let overlay = null;
        let previousFocus = null;
        let copyTimer = 0;
        const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
        const close = () => {
            if (!overlay) return;
            const o = overlay;
            overlay = null;
            if (copyTimer) { clearTimeout(copyTimer); copyTimer = 0; }
            global.removeEventListener('keydown', onKey, true);
            o.classList.remove('visible');
            setTimeout(() => o.remove(), 320);
            const back = previousFocus;
            previousFocus = null;
            if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch (e) { /* 还不回去就算了 */ } }
        };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
        app.openTrackInfo = (ref) => {
            if (!doc || overlay) return;
            const track = ref && typeof ref === 'object' ? ref : app.playlist?.[typeof ref === 'number' ? ref : app.currentTrackIndex];
            if (!track) { try { global.MusicToast?.show?.({ message: '先放一首歌再看信息' }); } catch (e) { /* 没有提示层 */ } return; }
            let stat;
            try { stat = app.musicStats?.get ? (app.musicStats.get(track) || null) : undefined; } catch (e) { stat = undefined; }
            previousFocus = doc.activeElement;
            const cur = el('div', 'dialog-overlay music-stats-dialog');
            overlay = cur;
            const dialog = el('div', 'dialog glass-panel mstats minfo');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'minfo-title');
            const head = el('header', 'mstats-head');
            const name = (app.stripAudioExtension ? app.stripAudioExtension(track.title || '') : String(track.title || '')) || '未知标题';
            const h = el('h3', 'minfo-title', name);
            h.id = 'minfo-title';
            h.title = name;
            head.appendChild(h);
            const x = el('button', 'mstats-close', '×');
            x.type = 'button';
            x.setAttribute('aria-label', '关闭');
            x.addEventListener('click', close);
            head.appendChild(x);
            dialog.appendChild(head);
            const dl = el('dl', 'minfo-list');
            for (const [k, v] of describeTrack(track, stat)) {
                dl.appendChild(el('dt', '', k));
                dl.appendChild(el('dd', k === '位置' ? 'minfo-path' : '', v));
            }
            dialog.appendChild(dl);
            const actions = el('div', 'minfo-actions');
            if (isLocal(track.path)) {
                const show = el('button', 'minfo-btn', '在文件夹中显示');
                show.type = 'button';
                show.addEventListener('click', () => app.showTrackInFolder(track));
                actions.appendChild(show);
            }
            const copy = el('button', 'minfo-btn', '复制路径');
            copy.type = 'button';
            copy.addEventListener('click', () => {
                const writeText = global.navigator?.clipboard?.writeText;
                if (typeof writeText !== 'function') { copy.textContent = '复制失败'; return; }
                Promise.resolve(writeText.call(global.navigator.clipboard, String(track.path || '')))
                    .then(() => {
                        if (!copy.isConnected) return;
                        copy.textContent = '已复制';
                        clearTimeout(copyTimer);
                        copyTimer = setTimeout(() => { copyTimer = 0; if (copy.isConnected) copy.textContent = '复制路径'; }, 1600);
                    })
                    .catch(() => { if (copy.isConnected) copy.textContent = '复制失败'; });
            });
            actions.appendChild(copy);
            dialog.appendChild(actions);
            cur.appendChild(dialog);
            cur.addEventListener('mousedown', (e) => { if (e.target === cur) close(); });
            doc.body.appendChild(cur);
            global.addEventListener('keydown', onKey, true);
            global.requestAnimationFrame?.(() => { if (overlay === cur) cur.classList.add('visible'); });
            try { x.focus({ preventScroll: true }); } catch (e) { /* 没关系 */ }
            return close;
        };

        const menu = app.contextMenu;
        if (!menu || !doc || menu.querySelector('[data-action="show-in-folder"]')) return;
        const info = doc.createElement('div');
        info.className = 'context-menu-item';
        info.dataset.action = 'track-info';
        info.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg><span>歌曲信息</span>';
        info.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.remove('visible');
            app.openTrackInfo(app.contextMenuTrackIndex);
        });
        const item = doc.createElement('div');
        item.className = 'context-menu-item';
        item.dataset.action = 'show-in-folder';
        item.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>在文件夹中显示</span>';
        const anchor = menu.querySelector('[data-action="get-lyrics"]');
        if (anchor && anchor.parentNode === menu) menu.insertBefore(item, anchor.nextSibling); else menu.appendChild(item);
        menu.insertBefore(info, item.nextSibling);
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.remove('visible');
            app.showTrackInFolder(app.contextMenuTrackIndex);
        });
        // 菜单每次打开时看一眼：云端的歌没有这一项
        const sync = () => {
            if (!menu.classList.contains('visible')) return;
            const hide = !isLocal(app.playlist?.[app.contextMenuTrackIndex]?.path);
            if (item.hidden !== hide) item.hidden = hide;
        };
        if (typeof global.MutationObserver === 'function') new global.MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['class'] });
    }

    const exported = { setupMusicTrackFile, isLocal, describeTrack };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicTrackFile = exported;
})(typeof window !== 'undefined' ? window : globalThis);
