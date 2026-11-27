// Musicmodules/music-stats-view.js
// 听歌统计（命令面板「听歌统计」，或 Ctrl+K 输入 tongji）：
//   听了多久、几次、几天，一天里几点听得最多，最常听的歌 / 歌手 / 专辑。可切近 7 天、近 30 天、近一年、全部。
// 数据全来自 music-stats.js（本机记录，不上传）。点歌直接放，点歌手、专辑跳到目录里那一组。
// 外观沿用音乐窗口自己的对话框（.dialog-overlay > .dialog.glass-panel），打开合上的液体动作由流体套件接管。
(function (global) {
    'use strict';

    const RANGES = [[7, '近 7 天'], [30, '近 30 天'], [365, '近一年'], [0, '全部']];
    const RANGE_KEY = 'musicStatsRange';
    const TOP = 5;

    const norm = (s) => String(s || '').trim().toLowerCase();
    const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const firstArtist = (t) => String((t && t.artist) || '').split(/\s*(?:\/|,|，|、|&|;|feat\.?|ft\.)\s*/)[0].trim();

    // 秒 → 「3 小时 12 分」「45 分」「不到 1 分」
    const formatDuration = (sec) => {
        const m = Math.floor((Number(sec) || 0) / 60);
        if (m < 1) return '不到 1 分';
        const h = Math.floor(m / 60);
        return h ? `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分`;
    };
    // 和 app.fileUrl 一样：路径里的空格、#、?、'、% 都要编码，否则断图
    const fileUrl = (path) => {
        const p = String(path || '').replace(/\\/g, '/');
        if (!p) return '';
        if (/^[a-z][a-z0-9+.-]{2,}:\/\//i.test(p)) return p;
        return 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p).replace(/[?#']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    };
    const coverUrls = (t) => {
        if (!t) return [];
        const out = [];
        if (t.albumArt) out.push(fileUrl(t.albumArt));
        const p = String(t.path || '').replace(/\\/g, '/');
        const cut = p.lastIndexOf('/');
        if (cut > 0 && !/^[a-z][a-z0-9+.-]{2,}:\/\//i.test(p)) for (const name of ['cover.jpg', 'folder.jpg', 'cover.png']) out.push(fileUrl(p.slice(0, cut) + '/' + name));
        return out;
    };
    // 听歌日历：最近 weeks 周，一列一周（周一在上），今天所在那周是最后一列。
    // daily: { 'YYYY-MM-DD': 秒 } → [[{ key, seconds, level, future }...7] ...]；level 0–4 按当天听了多久（20 分 / 1 小时 / 2 小时分档）
    const pad2 = (n) => String(n).padStart(2, '0');
    const keyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const levelOf = (sec) => (sec <= 0 ? 0 : sec < 1200 ? 1 : sec < 3600 ? 2 : sec < 7200 ? 3 : 4);
    const calendarWeeks = (daily, today = new Date(), weeks = 53) => {
        const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const monday = new Date(end);
        monday.setDate(end.getDate() - ((end.getDay() + 6) % 7));
        const start = new Date(monday);
        start.setDate(monday.getDate() - (weeks - 1) * 7);
        const out = [];
        for (let w = 0; w < weeks; w++) {
            const col = [];
            for (let d = 0; d < 7; d++) {
                const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
                const key = keyOf(day);
                const seconds = Number(daily?.[key]) || 0;
                col.push({ key, seconds, level: levelOf(seconds), future: day > end, month: day.getMonth(), date: day.getDate() });
            }
            out.push(col);
        }
        return out;
    };
    // 连续听歌的最长天数（一天听满 1 分钟才算）
    const longestStreak = (daily) => {
        const keys = Object.keys(daily || {}).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && daily[k] >= 60).sort();
        let best = 0, run = 0, prev = null;
        for (const k of keys) {
            const [y, m, d] = k.split('-').map(Number);
            const t = new Date(y, m - 1, d).getTime();
            run = prev !== null && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
            best = Math.max(best, run);
            prev = t;
        }
        return best;
    };

    const hourName = (h) => {
        const part = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
        const n = h < 5 ? h : h % 12 === 0 ? 12 : h % 12;
        return `${part} ${n} 点`;
    };

    // 把 summary 里按次数排的歌合成歌手、专辑榜（纯函数，测试用）
    function rank(summary, library) {
        const lib = library || [];
        const byPath = new Map();
        for (let i = 0; i < lib.length; i += 1) {
            const p = lib[i]?.path;
            if (p) byPath.set(normPath(p), i);
        }
        const songs = [];
        const artists = new Map();
        const albums = new Map();
        for (const row of summary.tracks || []) {
            const index = byPath.get(normPath(row.path));
            if (index === undefined) continue;
            const t = library[index];
            songs.push({ index, track: t, plays: row.plays });
            const a = firstArtist(t);
            if (a) {
                const k = norm(a);
                const had = artists.get(k) || { name: a, plays: 0, index };
                had.plays += row.plays;
                artists.set(k, had);
            }
            if (t.album) {
                const k = norm(t.album) + '\n' + norm(a);
                const had = albums.get(k) || { name: t.album, artist: a, plays: 0, index };
                had.plays += row.plays;
                albums.set(k, had);
            }
        }
        const top = (m) => [...m.values()].sort((x, y) => y.plays - x.plays).slice(0, TOP);
        return { songs: songs.slice(0, TOP), artists: top(artists), albums: top(albums) };
    }

    function setupMusicStatsView(app) {
        if (!app || app.openStatsView) return;
        const doc = global.document;
        let overlay = null;
        let previousFocus = null;
        let openRaf = 0;
        let closeTimer = 0;
        let closingOverlay = null;
        let range = 30;
        const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
        try { const v = Number(global.localStorage?.getItem(RANGE_KEY)); if (RANGES.some(([d]) => d === v)) range = v; } catch (e) { /* 默认 30 天 */ }

        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const title = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t.title || '') : String(t.title || '')) || '未知标题';
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
            const o = overlay;
            overlay = null;
            global.removeEventListener('keydown', onKey, true);
            o.classList.remove('visible');
            if (isImmediate) o.remove();
            else {
                closingOverlay = o;
                closeTimer = setTimeout(() => { closeTimer = 0; if (closingOverlay === o) closingOverlay = null; o.remove(); }, 320);
            }
            const back = previousFocus;
            previousFocus = null;
            if (!isImmediate && back && back.isConnected && typeof back.focus === 'function') {
                try { back.focus({ preventScroll: true }); } catch (e) { /* 还不回去就算了 */ }
            }
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

        /*
         * 排行里每行带一张小封面：曲目自带的封面（扫描时存下的内嵌封面）优先，没有就试同目录的 cover.jpg / folder.jpg；
         * 都没有时留一块底色。歌手用他最常听那首的封面，裁成圆的。
         */
        const cover = (t, round) => {
            const box = el('span', round ? 'mstats-art round' : 'mstats-art');
            box.setAttribute('aria-hidden', 'true');
            const tries = coverUrls(t);
            if (!tries.length) return box;
            const img = new Image();
            img.alt = '';
            img.decoding = 'async';
            img.loading = 'lazy';
            let k = 0;
            img.onerror = () => { if (++k < tries.length) img.src = tries[k]; else img.remove(); };
            img.src = tries[0];
            box.appendChild(img);
            return box;
        };
        const list = (heading, rows, render) => {
            const box = el('section', 'mstats-top');
            box.appendChild(el('h4', '', heading));
            if (!rows.length) { box.appendChild(el('p', 'mstats-none', '—')); return box; }
            const ol = el('ol');
            rows.forEach((row) => {
                const li = el('li');
                const btn = el('button', 'mstats-row');
                btn.type = 'button';
                const [main, sub, run, art, round] = render(row);
                btn.appendChild(cover(art, round));
                btn.appendChild(el('span', 'mstats-name', main));
                if (sub) btn.appendChild(el('span', 'mstats-sub', sub));
                btn.appendChild(el('span', 'mstats-count', `${row.plays} 次`));
                btn.addEventListener('click', () => { close(); run(); });
                li.appendChild(btn);
                ol.appendChild(li);
            });
            box.appendChild(ol);
            return box;
        };

        const render = () => {
            if (!overlay) return;
            const body = overlay.querySelector('.mstats-body');
            body.innerHTML = '';
            overlay.querySelectorAll('.mstats-range button').forEach((b) => {
                const on = Number(b.dataset.days) === range;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            const stats = app.musicStats;
            const s = stats && typeof stats.summary === 'function' ? stats.summary({ days: range }) : null;
            if (!s || (!s.seconds && !s.plays)) {
                body.appendChild(el('p', 'mstats-empty', range ? '这段时间还没有听歌记录。' : '还没有听歌记录。'));
                // 这段时间没有、但以前有：给个直达「全部」的按钮，别让人以为记录丢了
                const all = range ? stats?.summary?.({ days: 0 }) : null;
                if (all && (all.seconds || all.plays)) {
                    const more = el('button', 'minfo-btn mstats-more', `看全部记录（${all.plays} 次）`);
                    more.type = 'button';
                    more.addEventListener('click', () => { const b = overlay?.querySelector('.mstats-range button[data-days="0"]'); if (b) b.click(); else { range = 0; render(); } });
                    body.appendChild(more);
                }
                body.appendChild(el('p', 'mstats-note', '一首歌放到一半（或满 4 分钟）算听了一次；记录只存在这台电脑上。'));
                return;
            }
            const totals = el('div', 'mstats-totals');
            [[formatDuration(s.seconds), '听歌时长'], [`${s.plays}`, '听完的歌（次）'], [`${s.activeDays}`, '有听歌的天数']].forEach(([v, k]) => {
                const cell = el('div', 'mstats-total');
                cell.appendChild(el('strong', '', v));
                cell.appendChild(el('span', '', k));
                totals.appendChild(cell);
            });
            body.appendChild(totals);

            const max = Math.max(...s.hours);
            if (max > 0) {
                const peak = s.hours.indexOf(max);
                const chart = el('section', 'mstats-hours');
                chart.appendChild(el('h4', '', `一天里最常在${hourName(peak)}听`));
                const bars = el('div', 'mstats-bars');
                bars.setAttribute('role', 'img');
                bars.setAttribute('aria-label', `24 小时听歌分布，最多在 ${peak} 点`);
                s.hours.forEach((v, h) => {
                    const bar = el('i', h === peak ? 'peak' : '');
                    bar.style.setProperty('--h', `${Math.max(v > 0 ? 6 : 2, Math.round((v / max) * 100))}%`);
                    bar.title = `${h}:00–${h + 1}:00　${formatDuration(v)}`;
                    bars.appendChild(bar);
                });
                chart.appendChild(bars);
                const axis = el('div', 'mstats-axis');
                ['0', '6', '12', '18', '24'].forEach((t) => axis.appendChild(el('span', '', t)));
                chart.appendChild(axis);
                body.appendChild(chart);
            }

            // 近一年、全部：画一张听歌日历（最近 53 周），看哪段时间听得多
            if ((range === 0 || range >= 365) && s.daily && Object.keys(s.daily).length) {
                const weeks = calendarWeeks(s.daily);
                const cal = el('section', 'mstats-cal');
                const listened = weeks.flat().filter((c) => c.seconds >= 60).length;
                const streak = longestStreak(s.daily);
                cal.appendChild(el('h4', '', `最近一年有 ${listened} 天在听歌${streak > 1 ? `，最长连着听了 ${streak} 天` : ''}`));
                const months = el('div', 'mstats-cal-months');
                months.setAttribute('aria-hidden', 'true');
                weeks.forEach((col, w) => {
                    const first = col.find((c) => c.date === 1 && !c.future);
                    const label = el('span', '', first && w < weeks.length - 1 ? `${first.month + 1}月` : '');
                    months.appendChild(label);
                });
                cal.appendChild(months);
                const grid = el('div', 'mstats-cal-grid');
                grid.setAttribute('role', 'img');
                grid.setAttribute('aria-label', `听歌日历：最近一年有 ${listened} 天在听歌`);
                const gridFrag = doc.createDocumentFragment();
                for (const col of weeks) {
                    for (const c of col) {
                        const cell = el('i', c.future ? 'future' : `l${c.level}`);
                        if (!c.future) cell.title = `${c.key}　${c.seconds ? '听了 ' + formatDuration(c.seconds) : '没听'}`;
                        gridFrag.appendChild(cell);
                    }
                }
                grid.appendChild(gridFrag);
                cal.appendChild(grid);
                const legend = el('div', 'mstats-cal-legend');
                legend.appendChild(el('span', '', '少'));
                for (let l = 0; l <= 4; l++) legend.appendChild(el('i', `l${l}`));
                legend.appendChild(el('span', '', '多'));
                cal.appendChild(legend);
                body.appendChild(cal);
            }

            const r = rank(s, app.playlist || []);
            const tops = el('div', 'mstats-tops');
            const lib = app.playlist || [];
            tops.appendChild(list('最常听的歌', r.songs, (row) => [title(row.track), firstArtist(row.track), () => app.loadTrack?.(row.index), row.track]));
            tops.appendChild(list('最常听的歌手', r.artists, (row) => [row.name, '', () => app.goToGroup?.(row.index, 'artist'), lib[row.index], true]));
            tops.appendChild(list('最常听的专辑', r.albums, (row) => [row.name, row.artist, () => app.goToGroup?.(row.index, 'album'), lib[row.index]]));
            body.appendChild(tops);
            if (!range && s.since) body.appendChild(el('p', 'mstats-note', `听歌时长从 ${s.since} 开始记；次数包括更早的记录。`));
        };

        app.openStatsView = () => {
            if (overlay) return;
            flushClosing();
            previousFocus = doc.activeElement;
            overlay = el('div', 'dialog-overlay music-stats-dialog');
            const dialog = el('div', 'dialog glass-panel mstats');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'mstats-title');
            const head = el('header', 'mstats-head');
            const h = el('h3', '', '听歌统计');
            h.id = 'mstats-title';
            head.appendChild(h);
            const seg = el('div', 'mstats-range');
            seg.setAttribute('role', 'group');
            seg.setAttribute('aria-label', '时间范围');
            RANGES.forEach(([d, label]) => {
                const b = el('button', '', label);
                b.type = 'button';
                b.dataset.days = String(d);
                b.addEventListener('click', () => {
                    if (range === d) return;
                    range = d;
                    try { global.localStorage?.setItem(RANGE_KEY, String(d)); } catch (e) { /* 只是偏好 */ }
                    render();
                });
                seg.appendChild(b);
            });
            head.appendChild(seg);
            const x = el('button', 'mstats-close', '×');
            x.type = 'button';
            x.setAttribute('aria-label', '关闭');
            x.addEventListener('click', () => close());
            head.appendChild(x);
            dialog.appendChild(head);
            dialog.appendChild(el('div', 'mstats-body'));
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
                opening.querySelector('.mstats-range button.active')?.focus({ preventScroll: true });
            }) || 0;
        };
        app.closeStatsView = close;
    }

    // 命令面板直接调这个：第一次用时才装上
    const open = (app) => { setupMusicStatsView(app); app?.openStatsView?.(); };
    const exported = { setupMusicStatsView, open, rank, formatDuration, hourName, coverUrls, calendarWeeks, longestStreak };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.setupMusicStatsView = setupMusicStatsView;
    global.MusicStatsView = exported;
})(typeof window !== 'undefined' ? window : globalThis);
