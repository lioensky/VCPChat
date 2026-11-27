// Musicmodules/desktop-lyrics/desktop-lyrics.js
// 桌面歌词条本身：收音乐窗口送来的「这一行 / 下一行 / 进度」，自己按进度填色；悬停出工具条。
// 只在播放、而且这一行还没填满时跑动画帧；暂停或填满就停。

(function () {
    'use strict';

    const api = window.utilityAPI || window.electronAPI;
    const $ = (id) => document.getElementById(id);
    const cur = $('cur');
    const next = $('next');
    const body = document.body;

    let snap = null;       // 最近一份状态
    let words = null;      // 当前行每个字：{ el, s, e }
    let lineSpan = null;   // 没有逐字时间时整句的起止
    let lineKey = '';
    let lastNextText = '';
    let frame = 0;
    let size = 34;
    let locked = false;
    const reducedMq = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;

    const send = (cmd, value) => { try { api?.sendDesktopLyricsCommand?.(cmd, value); } catch (e) { /* 主进程没有这个接口 */ } };
    const now = () => (snap ? snap.position + (snap.playing ? (Date.now() - snap.at) / 1000 : 0) : 0);
    const pct = (t, s, e) => (t >= e ? 100 : t <= s ? 0 : ((t - s) / Math.max(0.05, e - s)) * 100);

    const wordSpan = (text) => {
        const el = document.createElement('span');
        el.className = 'w';
        el.textContent = text;
        el.dataset.t = text;
        return el;
    };

    const render = () => {
        body.classList.toggle('playing', Boolean(snap && snap.playing));
        body.classList.toggle('paused', Boolean(snap && !snap.playing));
        const play = $('play');
        play.title = snap && snap.playing ? '暂停' : '播放';
        play.setAttribute('aria-label', play.title);

        const line = snap && snap.line;
        const key = snap ? [snap.path, snap.index, line && line.text].join('\u0001') : '';
        if (key !== lineKey) {
            lineKey = key;
            cur.textContent = '';
            cur.classList.remove('idle', 'swap');
            words = null;
            lineSpan = null;
            if (line && line.text) {
                if (Array.isArray(line.words) && line.words.length) {
                    const frag = document.createDocumentFragment();
                    words = line.words.map((w) => {
                        const el = wordSpan(w.text);
                        frag.appendChild(el);
                        return { el, s: w.s, e: w.e, last: '' };
                    });
                    cur.appendChild(frag);
                } else {
                    // 整句按到下一句的时间填（最长 8 秒，免得长间奏前的一句填得太慢）
                    const s = line.time;
                    const nextAt = snap.next ? snap.next.time : s + 4;
                    const el = wordSpan(line.text);
                    cur.appendChild(el);
                    lineSpan = { el, s, e: s + Math.min(8, Math.max(0.6, nextAt - s)), last: '' };
                }
            } else {
                // 间奏、前奏或没有歌词：显示歌名
                cur.classList.add('idle');
                cur.textContent = snap && snap.title ? (snap.artist ? `${snap.title} — ${snap.artist}` : snap.title) : '没有在放的歌';
            }
            // fit() 读取宽度正好完成一次布局刷新，随后再加 swap 重启动画，避免两次连续强制重排
            fit();
            if (line && line.text && !reducedMq?.matches) cur.classList.add('swap');
        }
        const nx = snap && snap.next;
        const nextText = (line && line.tr ? line.tr : nx ? nx.text : '') || (snap && !snap.hasLyrics && snap.path ? '这首歌没有歌词' : '');
        if (nextText !== lastNextText) {
            lastNextText = nextText;
            next.textContent = nextText;
        }
        paint();
    };

    const paint = () => {
        const t = now();
        let moving = false;
        if (words) {
            for (const w of words) {
                const f = pct(t, w.s, w.e);
                const val = f.toFixed(1) + '%';
                if (val !== w.last) {
                    w.last = val;
                    w.el.style.setProperty('--f', val);
                }
                if (f < 100) moving = true;
            }
        } else if (lineSpan) {
            const f = pct(t, lineSpan.s, lineSpan.e);
            const val = f.toFixed(1) + '%';
            if (val !== lineSpan.last) {
                lineSpan.last = val;
                lineSpan.el.style.setProperty('--f', val);
            }
            moving = f < 100;
        }
        cancelAnimationFrame(frame);
        frame = 0;
        if (moving && snap && snap.playing && !document.hidden) frame = requestAnimationFrame(paint);
    };

    // 一行太长就把字缩小到放得下（不低于设定字号的 60%）
    const fit = () => {
        cur.style.fontSize = '';
        const room = cur.clientWidth;
        const need = cur.scrollWidth;
        if (room > 0 && need > room) cur.style.fontSize = Math.max(size * 0.6, (size * room) / need).toFixed(1) + 'px';
    };

    const applyPrefs = (p) => {
        if (!p) return;
        if (Number.isFinite(p.size)) {
            size = p.size;
            document.documentElement.style.setProperty('--dl-size', size + 'px');
        }
        locked = p.locked === true;
        body.classList.toggle('locked', locked);
        const lock = $('lock');
        lock.title = locked ? '解锁：可以拖动、点按钮' : '锁定：鼠标穿过歌词，点不到它';
        lock.setAttribute('aria-label', locked ? '解锁' : '锁定');
        fit();
    };

    // ---- 交互 ----
    document.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-cmd]');
        if (!b) return;
        const cmd = b.dataset.cmd;
        if (cmd === 'toggle') send(snap && snap.playing ? 'pause' : 'play');
        else if (cmd === 'smaller') send('size', size - 2);
        else if (cmd === 'bigger') send('size', size + 2);
        else if (cmd === 'lock') send('lock', !locked);
        else send(cmd);
    });
    // 悬停：锁定时鼠标事件是穿透转发来的，只用来露出锁形按钮；移到锁上才临时接收点击
    const enter = () => { if (!body.classList.contains('hover')) body.classList.add('hover'); };
    document.addEventListener('mouseenter', enter);
    document.addEventListener('mousemove', enter, { passive: true });
    document.addEventListener('mouseleave', () => { body.classList.remove('hover'); if (locked) send('hover', false); });
    $('lock').addEventListener('mouseenter', () => { if (locked) send('hover', true); });
    $('lock').addEventListener('mouseleave', () => { if (locked) send('hover', false); });
    document.addEventListener('wheel', (e) => { if (!locked && e.ctrlKey) send('size', size + (e.deltaY < 0 ? 2 : -2)); }, { passive: true });
    document.addEventListener('visibilitychange', paint);
    let fitRaf = 0;
    window.addEventListener('resize', () => {
        if (fitRaf) return;
        fitRaf = requestAnimationFrame(() => { fitRaf = 0; fit(); });
    });
    const unsubState = api?.onDesktopLyricsState?.((s) => { if (s && typeof s === 'object') { snap = s; render(); } });
    const unsubPrefs = api?.onDesktopLyricsPrefs?.(applyPrefs);
    window.addEventListener('beforeunload', () => {
        cancelAnimationFrame(frame); frame = 0;
        if (fitRaf) { cancelAnimationFrame(fitRaf); fitRaf = 0; }
        try { if (typeof unsubState === 'function') unsubState(); } catch (e) { /* noop */ }
        try { if (typeof unsubPrefs === 'function') unsubPrefs(); } catch (e) { /* noop */ }
    }, { once: true });
    render();

    window.__desktopLyrics = { debug: () => ({ key: lineKey, cur: cur.textContent, next: next.textContent, words: words ? words.map((w) => w.el.style.getPropertyValue('--f')) : null, locked, size }) };
})();
