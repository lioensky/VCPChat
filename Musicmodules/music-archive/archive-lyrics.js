/*
 * 档案页右侧的滚动歌词：和左侧档案目录同一套排版（字浮在场景上、不做面板、从右边缘向左渐隐的纸色柔光），
 * 正在唱的一行用目录选中行的记号（小方块 + 一条细线）标出，跟着播放进度往上滚。
 * 歌词来自播放器已经取好的 app.currentLyrics（{ time, text | original, translation }），
 * 进度用 app.lastKnownCurrentTime + 距 lastStateUpdateTime 的时间估算，不另取歌词、不碰播放器。
 * 点一行跳到那一句（app.seekTo），暂停着就接着播。
 * 有逐字时间（line.words）的歌，正在唱的那一行逐字填色（像 Apple Music）；滚轮可以自己往前往后翻，
 * 翻的时候先不跟着跑，停手 3 秒后再滑回正在唱的那一行。
 * 正在放的歌没有歌词时（等上一会儿，免得歌词还在取的时候闪一下）只留栏头和一行说明，带「获取歌词」入口；
 * 这时不占右侧的版面，封面照旧用大图。
 */
(function (global) {
    'use strict';

    const LINE_H = 52;           // 只有原文的一行
    const LINE_H_TR = 74;        // 带译文的一行
    const ANCHOR = 0.34;         // 当前行停在可视高度的这个位置
    const TICK_MS = 200;
    const FOLLOW_AFTER = 3000;   // 手动滚过歌词后，停手这么久再回到跟随
    const NONE_AFTER = 2500;     // 换歌后这么久还没有歌词，才说「没有歌词」

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const textOf = (line) => String((line && (line.text || line.original || line.fullText)) || '').trim();
    /* 这一行有能用的逐字时间才返回（每个字都有起止时间、拼起来和整行一样），否则按整行显示 */
    const wordsOf = (line) => {
        const words = line && Array.isArray(line.words) ? line.words : null;
        if (!words || words.length < 2) return null;
        if (!words.every((w) => w && typeof w.text === 'string' && Number.isFinite(w.startTime) && Number.isFinite(w.endTime) && w.endTime >= w.startTime)) return null;
        return words.map((w) => w.text).join('').trim() === textOf(line).replace(/\s+/g, ' ').trim() || words.map((w) => w.text).join('').replace(/\s+/g, '') === textOf(line).replace(/\s+/g, '') ? words : null;
    };

    /* 第几行在唱：最后一个 time <= t 的行；都还没到就是 -1 */
    const lineAt = (lines, t) => {
        let lo = 0, hi = lines.length - 1, at = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if ((Number(lines[mid].time) || 0) <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return at;
    };

    const TEMPLATE = `
        <div class="archive-lyrics-head"><span>歌词</span><i>／</i><b data-y="title"></b><button type="button" class="archive-lyrics-chip" data-y="chip" hidden></button><button type="button" class="archive-lyrics-desk" data-y="desk" hidden aria-pressed="false" title="在桌面上显示歌词（切到别的程序也能看到）">桌面歌词</button></div>
        <div class="archive-lyrics-viewport" data-y="viewport"><div class="archive-lyrics-track" data-y="track"></div></div>
        <button type="button" class="archive-lyrics-back" data-y="back" data-dir="up" tabindex="-1" title="不等它自己滑回，马上回到正在唱的那一句">回到当前句 <i aria-hidden="true"></i></button>
        <div class="archive-lyrics-index" data-y="index" aria-label="歌词进度：指针移上去看那一句，点一下跳过去"></div>
        <div class="archive-lyrics-none" data-y="none"><span data-y="noneText">这首歌还没有歌词</span><button type="button" data-y="fetch">获取歌词 <i aria-hidden="true">→</i></button></div>`;

    /*
     * opts: { host, app, reducedMotion(), onChange() }
     * 返回 { el, sync(), tick(), setAllowed(on), destroy(), debug() }
     */
    const create = ({ host, app, reducedMotion = () => false, onChange = null }) => {
        const el = document.createElement('section');
        el.className = 'archive-lyrics';
        el.setAttribute('aria-label', '歌词');
        el.hidden = true;
        el.innerHTML = TEMPLATE;
        host.appendChild(el);
        const r = {};
        el.querySelectorAll('[data-y]').forEach((n) => { r[n.dataset.y] = n; });

        const state = { source: null, lines: [], offsets: [], index: -2, shown: false, allowed: true, timer: 0, path: null, none: false, nonePath: null, nonePending: null, noneTimer: 0, shift: 0, manual: 0, manualTimer: 0, words: null };

        const tracks = () => (Array.isArray(app.playlist) ? app.playlist : []);
        const current = () => tracks()[app.currentTrackIndex] || null;
        const now = () => {
            const base = Number(app.lastKnownCurrentTime) || 0;
            if (!app.isPlaying || !app.lastStateUpdateTime) return base;
            return base + Math.max(0, Date.now() - app.lastStateUpdateTime) / 1000;
        };

        const build = () => {
            const src = Array.isArray(app.currentLyrics) ? app.currentLyrics : [];
            state.source = app.currentLyrics;
            state.lines = src.filter((l) => l && textOf(l));
            state.offsets = [];
            let y = 0;
            r.track.innerHTML = state.lines.map((l, k) => {
                state.offsets.push(y);
                const tr = String(l.translation || '').trim();
                y += tr ? LINE_H_TR : LINE_H;
                const words = wordsOf(l);
                const body = words ? words.map((w) => `<span class="w">${esc(w.text)}</span>`).join('') : esc(textOf(l));
                return `<p data-k="${k}"${tr ? ' class="tr"' : ''}><b${words ? ' class="ww"' : ''}>${body}</b>${tr ? `<em>${esc(tr)}</em>` : ''}</p>`;
            }).join('');
            // 纯文本歌词（没有时间轴）：照 RhinE 静静摆出来，不高亮、不跟随，滚轮从第一行往下翻
            const plain = !state.lines.length && Array.isArray(app.currentLyricsPlainLines) && app.currentLyricsPlainLines.length
                ? app.currentLyricsPlainLines : null;
            state.plain = plain;
            el.classList.toggle('plain', Boolean(plain));
            if (plain) {
                const canFetch = typeof app.openLyricsFetchModal === 'function';
                r.track.innerHTML = '<p class="plain-note"><em>没有时间轴 · 滚轮翻看</em>'
                    + (canFetch ? '<button type="button" class="plain-fetch">换一份带时间轴的 <i aria-hidden="true">→</i></button>' : '') + '</p>'
                    + plain.map((text) => `<p class="plain"><b>${esc(text)}</b></p>`).join('');
                clearTimeout(state.manualTimer);
                state.manualTimer = 0;
                state.manual = 0;
                state.shift = 0;
            }
            buildIndex();
            fitSoon();
            state.index = -2;
            state.words = null;
            const t = current();
            state.path = t ? t.path : null;
            r.title.textContent = t ? String(t.title || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '') : '';
            paintChip();
        };
        /* 标题旁的小标签（借鉴 RhinE 歌词页的状态标签）：这份歌词是逐字、逐句还是纯文本，带不带译文；点它换一份 */
        const paintChip = () => {
            if (!r.chip) return;
            const n = state.lines.length;
            let text = '';
            if (n) {
                const ww = state.lines.some((l) => wordsOf(l));
                const tr = state.lines.some((l) => String(l.translation || '').trim());
                text = (ww ? '逐字' : '逐句') + (tr ? ' · 译' : '');
            } else if (state.plain) text = '纯文本';
            r.chip.hidden = !text;
            r.chip.textContent = text;
            const canFetch = typeof app.openLyricsFetchModal === 'function';
            r.chip.disabled = !canFetch;
            r.chip.title = (text === '纯文本' ? '这份歌词没有时间轴' : text.startsWith('逐字') ? '这份歌词带逐字时间' : '这份歌词按句对时间')
                + (text.includes('译') ? '，带译文' : '') + (canFetch ? '。点一下换一份' : '');
        };

        /*
         * 歌词行索引（借鉴 RhinE 歌词页右侧的行索引）：一行歌词一格（太长的歌按相等的几行一格，最多 48 格），
         * 唱过的偏实、正在唱的一格用强调色，没唱到的很淡；点一格跳到那一段的第一行。
         */
        /*
         * 长句缩字（借鉴 RhinE「长句缩小到放得下，不截断」）：放不下的一行先把字号缩到放得下，
         * 最多缩到 72%，再长才用省略号。按正在唱时的粗字重留 5% 余量，换歌、改窗口宽度时重算；
         * 先统一读宽度、再统一写，不来回触发排版。
         */
        const FIT_MIN = 0.72;
        let fitRaf = 0;
        const fitLines = () => {
            fitRaf = 0;
            // 原文和译文各算各的（译文行 <em> 同样先缩字再省略）
            const nodes = [...r.track.querySelectorAll('p:not(.plain-note) > b, p:not(.plain-note) > em')];
            const need = nodes.map((b) => {
                const prev = b.style.getPropertyValue('--fit');
                if (prev) b.style.removeProperty('--fit');
                const avail = b.clientWidth, full = b.scrollWidth;
                return avail > 0 && full > avail ? Math.max(FIT_MIN, Math.floor(avail / (full * 1.05) * 100) / 100) : 1;
            });
            nodes.forEach((b, k) => { if (need[k] < 1) b.style.setProperty('--fit', String(need[k])); });
        };
        const fitSoon = () => { if (!fitRaf) fitRaf = requestAnimationFrame(fitLines); };

        /*
         * 歌词进度条（原来一行一格的密刻度太小、点不准）：一根细竖线，唱过的一段实一点，正在唱的位置一道强调色短横；
         * 指针移上去出现一道细线和那一句的预览（时间 + 原文），点一下跳过去。平时淡，指针进歌词栏才清楚。
         */
        const buildIndex = () => {
            const n = state.lines.length;
            state.indexN = n;
            state.indexAt = -2;
            r.index.hidden = n < 4;
            r.index.innerHTML = n < 4 ? '' : '<span class="rail"></span><span class="fill"></span><span class="cur"></span><span class="hov"></span><span class="tip"><b></b><span></span></span>';
            r.index.classList.remove('hovering');
        };
        const paintIndex = (k) => {
            const n = state.indexN || 0;
            if (n < 4) return;
            if (k === state.indexAt) return;
            state.indexAt = k;
            r.index.style.setProperty('--at', String(k < 0 ? 0 : k / (n - 1)));
            r.index.classList.toggle('started', k >= 0);
        };
        const clock = (t) => { t = Math.max(0, Math.floor(Number(t) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
        const indexAtY = (y) => {
            const n = state.indexN || 0;
            const box = r.index.getBoundingClientRect();
            if (n < 4 || !(box.height > 0)) return -1;
            return Math.round(Math.min(1, Math.max(0, (y - box.top) / box.height)) * (n - 1));
        };
        r.index.addEventListener('pointermove', (e) => {
            const k = indexAtY(e.clientY);
            if (k < 0) return;
            const line = state.lines[k];
            r.index.classList.add('hovering');
            r.index.style.setProperty('--hv', String(k / ((state.indexN || 1) - 1)));
            const tip = r.index.querySelector('.tip');
            if (tip && tip.dataset.k !== String(k)) {
                tip.dataset.k = String(k);
                tip.firstChild.textContent = clock(line && line.time);
                tip.lastChild.textContent = textOf(line);
            }
        });
        r.index.addEventListener('pointerleave', () => r.index.classList.remove('hovering'));
        r.index.addEventListener('click', (e) => {
            const k = indexAtY(e.clientY);
            if (k >= 0) r.track.children[k]?.click();
        });

        const show = (on) => {
            if (on === state.shown) return;
            state.shown = on;
            el.hidden = !(on || state.none);
            if (on) { state.index = -2; tick(); }
            schedule();
            onChange?.();
        };

        /* 播放器换了歌词（或换了歌）就重建；有歌词才显示 */
        const sync = () => {
            const t = current();
            if (app.currentLyrics !== state.source || (t ? t.path : null) !== state.path) build();
            const has = state.lines.length > 0 || Boolean(state.plain);
            if (has) setNone(false);
            show(state.allowed && has);
            syncNone();
        };

        /* 没有歌词的说明：在播放（或者已经显示着、只是暂停了）而且等够了才出现 */
        const setNone = (on) => {
            if (on === state.none) return;
            state.none = on;
            if (!on) { clearTimeout(state.noneRefresh); state.noneRefresh = 0; el.classList.remove('searching'); }
            el.classList.toggle('none', on);
            el.hidden = !(state.shown || on);
            onChange?.();
        };
        /*
         * 说明写什么（借鉴 RhinE 把「还在找」「没找到」「找到了但用不了」分开说，还在找时用中性色）：
         * 网上还在找就写「正在找歌词…」、不给按钮，找完再自己换成结果；纯文本歌词写没有时间轴。
         */
        const searching = () => app.lyricsLoadingToken != null && app.lyricsLoadingToken === app.lyricsRequestToken;
        const paintNone = () => {
            clearTimeout(state.noneRefresh);
            state.noneRefresh = 0;
            const busy = searching();
            el.classList.toggle('searching', busy);
            r.fetch.hidden = busy || typeof app.openLyricsFetchModal !== 'function';
            r.noneText.textContent = busy ? '正在找歌词…'
                : app.currentLyricsPlain > 0 ? `这份歌词没有时间轴（${app.currentLyricsPlain} 行），跟不上歌` : '这首歌还没有歌词';
            r.fetch.firstChild.textContent = app.currentLyricsPlain > 0 ? '换一份 ' : '获取歌词 ';
            if (busy) state.noneRefresh = setTimeout(() => { if (state.none) paintNone(); }, 800);
        };
        const wantNone = () => {
            const t = current();
            if (!state.allowed || !t || !t.path || state.lines.length || state.plain) return null;
            return app.isPlaying || state.nonePath === t.path ? t.path : null;
        };
        const syncNone = () => {
            const path = wantNone();
            if (path && state.none && state.nonePath === path) return;
            if (path && state.nonePending === path) return;
            clearTimeout(state.noneTimer);
            state.noneTimer = 0;
            state.nonePending = path;
            setNone(false);
            if (!path) return;
            state.noneTimer = setTimeout(() => {
                state.noneTimer = 0;
                state.nonePending = null;
                if (wantNone() !== path) return;
                state.nonePath = path;
                paintNone();
                setNone(true);
            }, NONE_AFTER);
        };
        // 桌面歌词开关（music-desktop-lyrics.js 提供；没有就不显示）
        const syncDesk = () => {
            const d = app.desktopLyrics;
            r.desk.hidden = !(d && d.available);
            r.desk.setAttribute('aria-pressed', String(Boolean(d && d.on)));
        };
        r.desk.addEventListener('click', () => { app.desktopLyrics?.toggle?.(); });
        document.addEventListener('music-desktop-lyrics-change', syncDesk);
        setTimeout(syncDesk, 0);
        r.chip?.addEventListener('click', () => {
            if (typeof app.openLyricsFetchModal === 'function') app.openLyricsFetchModal(app.currentTrackIndex);
        });
        r.fetch.addEventListener('click', () => {
            if (typeof app.openLyricsFetchModal === 'function') app.openLyricsFetchModal(app.currentTrackIndex);
        });

        /* 正在唱的那一行逐字填色：唱过的填满，正在唱的那个字用 CSS 过渡按剩余时长填，暂停时停在当前比例 */
        /*
         * 没有逐字时间的歌：正在唱那一行上方的细线跟着这一句的进度从左往右填成强调色，到下一句开始时填满
         * （借鉴 RhinE 歌词条「一根细线填到下一句」）。每次刷新（200ms）只改一个变量，过渡补成连续的。
         */
        let lpNode = null;
        const paintLineProgress = (t, hasWords) => {
            const k = state.index;
            const node = !hasWords && k >= 0 ? r.track.children[k] : null;
            if (lpNode && lpNode !== node) { lpNode.style.removeProperty('--lp'); lpNode.classList.remove('lp'); }
            lpNode = node;
            if (!node) return;
            const start = Number(state.lines[k].time) || 0;
            const next = state.lines[k + 1];
            const end = next ? Number(next.time) || 0 : start + 6;
            const f = end > start ? Math.min(1, Math.max(0, (t - start) / (end - start))) : 1;
            node.classList.add('lp');
            node.style.setProperty('--lp', (f * 100).toFixed(1) + '%');
        };
        const paintWords = (t) => {
            const k = state.index;
            const line = k >= 0 ? state.lines[k] : null;
            const words = line && wordsOf(line);
            const node = words ? r.track.children[k]?.querySelector('b.ww') : null;
            paintLineProgress(t, Boolean(node));
            if (!node) { state.words = null; return; }
            const spans = node.children;
            const playing = Boolean(app.isPlaying);
            for (let j = 0; j < words.length && j < spans.length; j++) {
                const w = words[j], span = spans[j];
                const want = t >= w.endTime ? 'sung' : t >= w.startTime ? (playing ? 'singing' : 'held') : '';
                if (span.dataset.st === want) continue;
                span.dataset.st = want;
                span.className = want ? 'w ' + want : 'w';
                if (want === 'singing') span.style.setProperty('--d', Math.max(0, w.endTime - t).toFixed(2) + 's');
                if (want === 'held') span.style.setProperty('--p', Math.round(100 * (t - w.startTime) / Math.max(0.01, w.endTime - w.startTime)) + '%');
            }
            state.words = node;
        };
        const place = (animate = true) => {
            // 歌曲末尾保留一点渐隐空间，让前面的歌词填满余下的可视区域。
            const max = Math.max(0, r.track.offsetHeight - r.viewport.clientHeight + 16);
            const y = Math.max(0, Math.min(max, state.shift + state.manual));
            r.track.style.transition = !animate || reducedMotion() ? 'none' : '';
            r.track.style.transform = `translateY(${-y}px)`;
        };
        const updateShift = () => {
            const y = state.offsets[state.index] || 0;
            const height = r.viewport.clientHeight;
            const row = r.track.children[state.index];
            const rowBottom = row ? row.offsetTop + row.offsetHeight : 0;
            state.shift = Math.max(0, y - height * ANCHOR, rowBottom - height + 16);
        };
        const tick = () => {
            if (!state.shown) return;
            const t = now();
            const k = lineAt(state.lines, t);
            if (k !== state.index) {
                const prev = r.track.querySelector('p.on');
                prev?.classList.remove('on');
                prev?.querySelectorAll('.w[data-st]').forEach((n) => { n.className = 'w'; delete n.dataset.st; });
                state.index = k;
                const node = k >= 0 ? r.track.children[k] : null;
                node?.classList.add('on');
                paintIndex(k);
                updateShift();
                if (!state.manualTimer) place();
            }
            paintWords(t);
        };

        let fitWidth = 0;
        const resizeObserver = new ResizeObserver(() => {
            const w = r.viewport.clientWidth;
            if (w && w !== fitWidth) { fitWidth = w; fitSoon(); }
            if (!state.shown) return;
            const previousShift = state.shift;
            updateShift();
            if (state.manualTimer) state.manual += previousShift - state.shift;
            place(false);
        });
        resizeObserver.observe(r.viewport);

        // 滚轮自己翻歌词：先不跟随，停手 3 秒后滑回正在唱的那一行（不让档案页把滚轮当成切歌）
        r.viewport.addEventListener('wheel', (e) => {
            if (!state.shown || (!state.lines.length && !state.plain)) return;
            e.preventDefault();
            e.stopPropagation();
            const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
            if (state.plain) {
                // 纯文本：翻到哪停在哪，不自己滑回
                const max = Math.max(0, r.track.offsetHeight - r.viewport.clientHeight + 16);
                state.manual = Math.max(0, Math.min(max, state.manual + e.deltaY * unit));
                place(false);
                return;
            }
            state.manual += e.deltaY * unit;
            state.manual = Math.max(-state.shift, state.manual);
            if (r.back) r.back.dataset.dir = state.manual > 0 ? 'up' : 'down';
            el.classList.add('browsing');
            place(false);
            clearTimeout(state.manualTimer);
            state.manualTimer = setTimeout(() => {
                state.manualTimer = 0;
                state.manual = 0;
                el.classList.remove('browsing');
                place();
            }, FOLLOW_AFTER);
        }, { passive: false });

        // 只在显示着、而且在播放时走表（暂停时停在原处）
        const schedule = () => {
            const want = state.shown && Boolean(app.isPlaying);
            if (want && !state.timer) state.timer = setInterval(tick, TICK_MS);
            else if (!want && state.timer) { clearInterval(state.timer); state.timer = 0; }
        };

        /* 滚轮翻看时（5 秒后自己滑回）下方出现「回到当前句」：点一下马上回去 */
        r.back?.addEventListener('click', () => {
            clearTimeout(state.manualTimer);
            state.manualTimer = 0;
            state.manual = 0;
            el.classList.remove('browsing');
            place();
        });
        r.track.addEventListener('click', (e) => {
            // 纯文本歌词顶上的「换一份带时间轴的」：打开获取歌词
            if (e.target.closest('.plain-fetch')) {
                if (typeof app.openLyricsFetchModal === 'function') app.openLyricsFetchModal(app.currentTrackIndex);
                return;
            }
            const p = e.target.closest('p[data-k]');
            const line = p && state.lines[Number(p.dataset.k)];
            if (!line || typeof app.seekTo !== 'function') return;
            const t = Number(line.time) || 0;
            app.seekTo(t);
            app.lastKnownCurrentTime = t;
            app.lastStateUpdateTime = Date.now();
            // 暂停着点一句：从这句接着播（和主流播放器一样），加载中不发
            if (!app.isPlaying && !app.isTrackLoading && typeof app.playTrack === 'function') app.playTrack();
            clearTimeout(state.manualTimer);
            state.manualTimer = 0;
            state.manual = 0;
            el.classList.remove('browsing');
            state.index = -2;
            tick();
        });

        return {
            el,
            sync: () => { sync(); schedule(); tick(); },
            tick,
            setAllowed: (on) => { state.allowed = Boolean(on); sync(); },
            get shown() { return state.shown; },
            destroy: () => { resizeObserver.disconnect(); cancelAnimationFrame(fitRaf); if (state.timer) clearInterval(state.timer); state.timer = 0; clearTimeout(state.noneTimer); clearTimeout(state.noneRefresh); clearTimeout(state.manualTimer); el.remove(); },
            debug: () => ({ shown: state.shown, none: state.none, lines: state.lines.length, index: state.index, ticking: Boolean(state.timer) })
        };
    };

    global.MusicArchiveLyrics = Object.freeze({ create, lineAt, wordsOf });
})(window);
