(function (global) {
    'use strict';

    /*
     * 群唱：歌词变成一个群聊。每句是群里某个人发的一条消息，按唱的进度一个字一个字打出来；
     * 开唱前那人「正在输入…」；间奏是一条语音消息，波形跟着音乐跳；副歌（整句出现两次以上的）
     * 大家一起唱，消息下面叠着几个人的回声；唱完的消息偶尔有人点个赞。
     * 全部是 DOM，不用画布；每帧只动正在打字的那条和语音波形。
     */

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before groupchat-manager.js');
    const { clamp, createElement } = Utils;
    const { resolveSupplementalText, readableText, buildGlyphTimeline, hashString, splitGraphemes } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const KEEP_ROWS = 16;            // DOM 里最多留几行
    const TYPING_LEAD = 0.9;         // 开唱前多久显示「正在输入」
    const VOICE_GAP = 4.5;           // 两句之间空这么久就发一条语音
    const BARS = 28;                 // 语音波形的格数
    const BAR_WEIGHTS = Float32Array.from({ length: BARS }, (_, i) => {
        const mirror = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
        return Math.pow(1 - mirror, 1.6) * 0.6;
    });

    // 群成员：名字和头像颜色（色相）。「我」在右边。
    const MEMBERS = Object.freeze([
        { name: '阿澈', hue: 205 },
        { name: '小满', hue: 340 },
        { name: '栗子', hue: 28 },
        { name: '七七', hue: 150 },
        { name: '老周', hue: 262 }
    ]);
    const ME = Object.freeze({ name: '我', hue: -1, me: true });
    const REACTIONS = Object.freeze(['♥', '＋1', '☆', '哈', '♪']);
    // 长间奏里有人回一个表情：用发的人自己的脸做的表情包（label 给读屏）
    const STICKERS = Object.freeze([
        { eyes: 'happy', mouth: 'open', prop: 'notes', label: '开心地唱' },
        { eyes: 'heart', mouth: 'cat', prop: 'heart', label: '喜欢' },
        { eyes: 'star', mouth: 'open', prop: 'sparkle', label: '好听' },
        { eyes: 'closed', mouth: 'o', prop: 'zzz', label: '听睡着了' },
        { eyes: 'wink', mouth: 'cat', prop: 'notes', label: '眨眼' },
        { eyes: 'happy', mouth: 'cat', prop: 'sweat', label: '嘿嘿' }
    ]);
    const STICKER_GAP = 9;

    // 群唱头像和表情：每个人一张自己画的简约二次元小像（SVG）。照贴图式 Q 版头像的画法：
    // 一种描线色、平涂色块、不加渐变；圆脸软下巴，眼睛是偏下、分得开的深色竖椭圆，只点一颗大高光；
    // 头发是几大块（后发 + 三四撮刘海）加一道月牙高光；不画鼻子。发型、发色、瞳色各不同，
    // 老周戴眼镜、我戴耳机。表情换眼睛、嘴和小道具
    const LOOKS = Object.freeze({
        '阿澈': { hair: 'messy', hairCol: '#33405e', skin: '#ffe6d8', eye: '#3a6fb8', bg: 205, ahoge: true },
        '小满': { hair: 'long', hairCol: '#6b3646', skin: '#ffe9de', eye: '#b44a6c', bg: 340 },
        '栗子': { hair: 'bun', hairCol: '#9a5a30', skin: '#ffe4d2', eye: '#a8641e', bg: 28 },
        '七七': { hair: 'twin', hairCol: '#24312f', skin: '#ffeae0', eye: '#2a8b80', bg: 150 },
        '老周': { hair: 'part', hairCol: '#45454e', skin: '#f6dcc9', eye: '#5b4032', bg: 262, glasses: true },
        '我': { hair: 'short', hairCol: '#2e2e36', skin: '#ffe5d6', eye: '#4d5390', bg: -1, phones: true }
    });
    const tint = (hex, t) => {
        const n = parseInt(hex.slice(1), 16);
        const ch = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(t >= 0 ? v + (255 - v) * t : v * (1 + t)));
        return `rgb(${ch.join(',')})`;
    };
    const LINE = '#4a3038';
    const SW = 0.75;
    // 刘海：从左鬓角起，几撮圆一点的发束往右排，tips = [[尖 x, 尖 y], ...]，发根在 rootY
    const bangs = (tips, rootY, left = 11.2, right = 36.8, sideY = 27) => {
        let d = `M${left} ${sideY} C${left - 1.4} 14.5 16.8 8.6 24 8.6 C31.2 8.6 ${right + 1.4} 14.5 ${right} ${sideY}`;
        const pts = tips.slice().sort((a, b) => b[0] - a[0]);
        let x0 = right;
        pts.forEach(([x, y], i) => {
            const next = pts[i + 1];
            const rx = next ? (x + next[0]) / 2 : left;
            d += ` Q${((x0 + x) / 2 + 0.8).toFixed(1)} ${(y - 0.6).toFixed(1)} ${x} ${y}`;
            d += ` Q${(x - 0.8).toFixed(1)} ${(y - 0.6).toFixed(1)} ${rx.toFixed(1)} ${next ? rootY : sideY}`;
            x0 = rx;
        });
        return d + ' Z';
    };
    const HAIR = {
        messy: {
            back: c => `<path d="M10.6 30 C8.4 14 16 7.6 24 7.6 C32 7.6 39.6 14 37.4 30 Z" fill="${c}" stroke="${LINE}" stroke-width="${SW}"/>`,
            front: bangs([[14.6, 25], [19.6, 22.2], [25, 23.8], [30.4, 22], [34.6, 25.4]], 18.4)
        },
        long: {
            back: c => `<path d="M10.4 24 C9 11 39 11 37.6 24 L39.6 41 Q35.4 43.6 32 41 L32 30 L16 30 L16 41 Q12.6 43.6 8.4 41 Z" fill="${c}" stroke="${LINE}" stroke-width="${SW}"/>`,
            front: bangs([[12.8, 32], [18.6, 22.6], [24.4, 23.6], [30, 22.4], [35.2, 32]], 18, 11, 37, 33)
        },
        bun: {
            back: c => `<circle cx="24" cy="8.6" r="5.8" fill="${c}" stroke="${LINE}" stroke-width="${SW}"/><path d="M10.8 28 C9 13 39 13 37.2 28 Z" fill="${c}" stroke="${LINE}" stroke-width="${SW}"/>`,
            // 往一边扫的刘海
            front: bangs([[14.4, 25.6], [20.2, 21.8], [27.4, 22.4], [33.8, 24.6]], 17.6)
        },
        twin: {
            back: c => `<path d="M10.2 19 C3.6 21.6 3.2 33 6.4 41 Q9.4 38.4 10.4 32.6 Q11.4 26.6 12.4 22.4 Z M37.8 19 C44.4 21.6 44.8 33 41.6 41 Q38.6 38.4 37.6 32.6 Q36.6 26.6 35.6 22.4 Z" fill="${c}" stroke="${LINE}" stroke-width="${SW}"/><path d="M10.8 27 C9 13 39 13 37.2 27 Z" fill="${c}" stroke="${LINE}" stroke-width="${SW}"/>`,
            // 齐刘海，两边垂到脸颊
            front: 'M11 31 C9.6 14.6 16.8 8.6 24 8.6 C31.2 8.6 38.4 14.6 37 31 L34.8 31 L34.6 22.4 L13.4 22.4 L13.2 31 Z',
            extra: () => `<circle cx="10.8" cy="19.8" r="1.9" fill="#ff8fab" stroke="${LINE}" stroke-width="0.6"/><circle cx="37.2" cy="19.8" r="1.9" fill="#ff8fab" stroke="${LINE}" stroke-width="0.6"/>`
        },
        part: {
            back: c => `<path d="M10.8 27 C9 13 39 13 37.2 27 Z" fill="${c}" stroke="${LINE}" stroke-width="${SW}"/>`,
            // 三七分，额前一大块斜过去
            front: 'M11.2 26 C9.8 14 16.8 8.6 24 8.6 C31.2 8.6 38.2 14 36.8 26 Q36 20.6 32.6 17.8 Q26 21.6 19 18.6 Q15.6 21.4 14 25.2 Q12.4 24 11.2 26 Z'
        },
        short: {
            back: c => `<path d="M10.8 28 C9 13 39 13 37.2 28 Z" fill="${c}" stroke="${LINE}" stroke-width="${SW}"/>`,
            front: bangs([[14.4, 24.6], [20, 22.4], [25.6, 23.6], [31.2, 22.2], [34.8, 24.8]], 18.2)
        }
    };
    // 眼睛：深色竖椭圆，下半一块瞳色，一颗大高光 + 一个小点；上面一道粗睫毛线
    const EX = [18.8, 29.2], EY = 28.6;
    const eyeOpen = (cx, L) => `<ellipse cx="${cx}" cy="${EY}" rx="2.15" ry="2.9" fill="${tint(L.eye, -0.55)}"/>`
        + `<ellipse cx="${cx}" cy="${EY + 1.25}" rx="1.55" ry="1.35" fill="${L.eye}"/>`
        + `<circle cx="${(cx - 0.75).toFixed(2)}" cy="${EY - 1.1}" r="0.95" fill="#fff"/><circle cx="${(cx + 0.85).toFixed(2)}" cy="${EY + 1.5}" r="0.38" fill="#fff"/>`
        + `<path d="M${cx - 2.7} ${EY - 2.2} Q${cx} ${EY - 4.1} ${cx + 2.7} ${EY - 2.2}" stroke="${LINE}" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;
    const arcs = (k, w = 1.2) => `<path d="M${EX[0] - 2.4} ${EY} Q${EX[0]} ${EY + k} ${EX[0] + 2.4} ${EY} M${EX[1] - 2.4} ${EY} Q${EX[1]} ${EY + k} ${EX[1] + 2.4} ${EY}" stroke="${LINE}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
    const heartAt = cx => `<path d="M${cx} ${EY + 2.4} L${cx - 2.4} ${EY - 0.2} A1.25 1.25 0 0 1 ${cx} ${EY - 1.9} A1.25 1.25 0 0 1 ${cx + 2.4} ${EY - 0.2} Z" fill="#ef5480" stroke="${LINE}" stroke-width="0.5"/>`;
    const starAt = cx => `<path d="M${cx} ${EY - 2.8} L${cx + 0.8} ${EY - 0.8} L${cx + 2.8} ${EY - 0.6} L${cx + 1.2} ${EY + 0.7} L${cx + 1.8} ${EY + 2.7} L${cx} ${EY + 1.6} L${cx - 1.8} ${EY + 2.7} L${cx - 1.2} ${EY + 0.7} L${cx - 2.8} ${EY - 0.6} L${cx - 0.8} ${EY - 0.8} Z" fill="#ffc83d" stroke="${LINE}" stroke-width="0.5" stroke-linejoin="round"/>`;
    const EYES = {
        open: L => `<g class="gcf-eyes">${eyeOpen(EX[0], L)}${eyeOpen(EX[1], L)}</g>`,
        happy: () => arcs(-2.6, 1.3),
        closed: () => arcs(1.8, 1.1),
        wink: L => `${eyeOpen(EX[0], L)}<path d="M${EX[1] - 2.4} ${EY} Q${EX[1]} ${EY - 2.6} ${EX[1] + 2.4} ${EY}" stroke="${LINE}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`,
        heart: () => heartAt(EX[0]) + heartAt(EX[1]),
        star: () => starAt(EX[0]) + starAt(EX[1])
    };
    const MC = '#8c3440';
    const MOUTH = {
        smile: `<path class="gcf-m-smile" d="M22.8 33.6 Q24 34.6 25.2 33.6" stroke="${LINE}" stroke-width="0.75" fill="none" stroke-linecap="round"/>`,
        sing: `<path class="gcf-m-smile" d="M22.8 33.6 Q24 34.6 25.2 33.6" stroke="${LINE}" stroke-width="0.75" fill="none" stroke-linecap="round"/><path class="gcf-m-open" d="M22.5 33.3 L25.5 33.3 Q25.3 35.9 24 35.9 Q22.7 35.9 22.5 33.3 Z" fill="${MC}" stroke="${LINE}" stroke-width="0.5" stroke-linejoin="round"/>`,
        open: `<path d="M22 33 L26 33 Q25.7 36.6 24 36.6 Q22.3 36.6 22 33 Z" fill="${MC}" stroke="${LINE}" stroke-width="0.55" stroke-linejoin="round"/><path d="M22.9 35.4 Q24 34.6 25.1 35.4 Q24.8 36.3 24 36.3 Q23.2 36.3 22.9 35.4 Z" fill="#f2848c"/>`,
        cat: `<path d="M22 33.4 Q23 34.6 24 33.6 Q25 34.6 26 33.4" stroke="${LINE}" stroke-width="0.75" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
        o: `<ellipse cx="24" cy="34.2" rx="1" ry="1.2" fill="${MC}" stroke="${LINE}" stroke-width="0.5"/>`
    };
    const PROPS = {
        heart: `<path d="M40 14 L36.4 10.4 A2.2 2.2 0 0 1 40 7.6 A2.2 2.2 0 0 1 43.6 10.4 Z" fill="#ef5480" stroke="${LINE}" stroke-width="0.6"/>`,
        notes: `<path d="M38 6 L44 4.6 L44 11.6 A1.8 1.5 0 1 1 42.6 10.2 L42.6 7.2 L39.4 8 L39.4 13 A1.8 1.5 0 1 1 38 11.6 Z" fill="currentColor"/>`,
        sparkle: `<path d="M41 4 L42 8 L46 9 L42 10 L41 14 L40 10 L36 9 L40 8 Z" fill="#ffc83d"/><path d="M6 8 L6.6 10.4 L9 11 L6.6 11.6 L6 14 L5.4 11.6 L3 11 L5.4 10.4 Z" fill="#ffc83d"/>`,
        zzz: `<text x="35" y="12" font-size="7" font-weight="700" fill="currentColor" font-family="sans-serif">z</text><text x="40" y="7" font-size="5" font-weight="700" fill="currentColor" font-family="sans-serif">z</text>`,
        sweat: `<path d="M37.4 17.6 Q39.6 21.6 38.2 23.4 Q36.2 24.2 35.8 22.2 Q36 20.2 37.4 17.6 Z" fill="#9ad8ff" stroke="${LINE}" stroke-width="0.5"/>`
    };
    const faceCache = new Map();
    const face = (name, { eyes = 'open', mouth = 'sing', prop = null, bg = true } = {}) => {
        const key = `${name}|${eyes}|${mouth}|${prop || ''}|${bg ? 1 : 0}`;
        const hit = faceCache.get(key);
        if (hit !== undefined) return hit;
        const L = LOOKS[name] || LOOKS['阿澈'];
        const hair = HAIR[L.hair];
        const c = L.hairCol;
        const bgFill = L.bg < 0 ? 'var(--stage-accent, #e0a030)' : `hsl(${L.bg} 42% 82%)`;
        const shirt = `hsl(${L.bg < 0 ? 40 : L.bg} 30% 46%)`;
        const body = `<path d="M8 48 C9 42.4 15 40 24 40 C33 40 39 42.4 40 48 Z" fill="${shirt}" stroke="${LINE}" stroke-width="${SW}"/>`
            + `<path d="M21.6 37 L21.6 40.6 Q24 42 26.4 40.6 L26.4 37 Z" fill="${tint(L.skin, -0.1)}"/>`;
        const head = `<path d="M11.6 25 C11.6 16.6 17 12.4 24 12.4 C31 12.4 36.4 16.6 36.4 25 C36.4 32.4 31 38.4 24 38.4 C17 38.4 11.6 32.4 11.6 25 Z" fill="${L.skin}" stroke="${LINE}" stroke-width="${SW}"/>`
            + `<ellipse cx="15.6" cy="32" rx="2.2" ry="1.25" fill="#ff8a96" opacity="0.38"/><ellipse cx="32.4" cy="32" rx="2.2" ry="1.25" fill="#ff8a96" opacity="0.38"/>`;
        const frontPath = hair.front;
        const front = `<path d="${frontPath}" fill="${c}" stroke="${LINE}" stroke-width="${SW}" stroke-linejoin="round"/>`;
        // 一道月牙高光
        const shine = `<path d="M15.8 16.4 Q24 11 32.2 16.4 Q24 13.6 15.8 16.4 Z" fill="${tint(c, 0.38)}"/>`;
        const ahoge = L.ahoge ? `<path d="M24.4 8.8 Q25 4 29.6 3.8 Q26.6 5.4 26.2 9 Z" fill="${c}" stroke="${LINE}" stroke-width="0.6" stroke-linejoin="round"/>` : '';
        const glasses = L.glasses ? `<g fill="none" stroke="${LINE}" stroke-width="0.8"><rect x="15" y="25.2" width="7.6" height="6.4" rx="2.2"/><rect x="25.4" y="25.2" width="7.6" height="6.4" rx="2.2"/><path d="M22.6 27.4 L25.4 27.4"/></g>` : '';
        const phones = L.phones ? `<path d="M9.8 26 C9.4 10.4 38.6 10.4 38.2 26" stroke="${LINE}" stroke-width="2.4" fill="none"/><path d="M9.8 26 C9.4 10.4 38.6 10.4 38.2 26" stroke="#3a3a44" stroke-width="1.4" fill="none"/><rect x="7" y="22.8" width="5" height="8.4" rx="2.4" fill="#3a3a44" stroke="${LINE}" stroke-width="${SW}"/><rect x="36" y="22.8" width="5" height="8.4" rx="2.4" fill="#3a3a44" stroke="${LINE}" stroke-width="${SW}"/>` : '';
        const svg = `<svg class="gcf" viewBox="0 0 48 48" aria-hidden="true">${bg ? `<circle cx="24" cy="24" r="24" fill="${bgFill}"/>` : ''}`
            + `${hair.back(c)}${body}${head}${EYES[eyes](L)}${MOUTH[mouth]}${front}${shine}${ahoge}${hair.extra ? hair.extra(c) : ''}${glasses}${phones}${prop ? PROPS[prop] : ''}</svg>`;
        faceCache.set(key, svg);
        return svg;
    };
           // 间奏长过这么久，语音之后再来一个表情

    const unit = (...parts) => (hashString(parts.join('|')) >>> 0) / 4294967295;
    const normLine = line => String(line?.fullText || '').replace(/[\s，。、,.!?！？…~～'"“”‘’()（）-]/g, '').toLowerCase();
    const compactLength = text => splitGraphemes(String(text || '').replace(/\s/g, '')).length;
    const fmt = (seconds) => {
        const s = Math.max(0, Math.round(seconds));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    /* ───────────────────────── 编排（纯函数，同一首歌每次都一样） ───────────────────────── */

    const buildThread = (lines, title, duration) => {
        const sung = (lines || []).filter(line => readableText(line.fullText));
        const messages = [{ kind: 'system', start: 0, text: title ? `《${title}》 群聊 · ${MEMBERS.length + 1} 人` : `群聊 · ${MEMBERS.length + 1} 人` }];
        const counts = new Map();
        sung.forEach((line) => { const k = normLine(line); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
        let last = null;
        let leftCursor = 0;
        let sinceStamp = 0;
        sung.forEach((line, i) => {
            const prev = sung[i - 1];
            const prevEnd = prev ? Math.max(prev.endTime, prev.vocalEndTime || 0) : 0;
            const gap = line.startTime - prevEnd;
            // 间奏：发一条语音，长度就是这段间奏
            if (gap > VOICE_GAP) {
                const start = prev ? prevEnd + 0.6 : Math.min(1.2, line.startTime * 0.25);
                const end = line.startTime - TYPING_LEAD - 0.2;
                if (end - start > 2) {
                    const who = MEMBERS[Math.floor(unit('voice', i, line.startTime) * MEMBERS.length)];
                    messages.push({ kind: 'voice', start, end, sender: who, side: 'left' });
                    last = null;
                    if (end - start > STICKER_GAP) {
                        const others = MEMBERS.filter(m => m !== who);
                        const from = others[Math.floor(unit('sticker-who', i) * others.length)];
                        messages.push({
                            kind: 'sticker', start: start + (end - start) * 0.55, sender: from, side: 'left',
                            sticker: STICKERS[Math.floor(unit('sticker', i, line.startTime) * STICKERS.length)]
                        });
                    }
                }
            }
            // 隔一阵插一个时间戳
            sinceStamp += 1;
            if (i > 0 && (gap > VOICE_GAP || sinceStamp >= 9)) {
                messages.push({ kind: 'system', start: line.startTime - TYPING_LEAD - 0.05, text: fmt(line.startTime), stamp: true });
                sinceStamp = 0;
            }
            const chorus = (counts.get(normLine(line)) || 0) >= 2;
            const short = compactLength(line.fullText) <= 8;
            let sender;
            if ((i + 1) % 4 === 0) sender = ME;
            else if (short && last && unit('carry', i, line.startTime) < 0.55) sender = last;
            else if (unit('side', i, line.startTime) < 0.22) sender = ME;
            else {
                // 不连着两句换回同一个人：从下一个开始轮
                const step = 1 + Math.floor(unit('who', i, line.startTime) * 2);
                leftCursor = (leftCursor + step) % MEMBERS.length;
                sender = MEMBERS[leftCursor];
            }
            const others = MEMBERS.filter(m => m !== sender);
            const echoes = chorus
                ? others.slice().sort((a, b) => unit('echo', i, a.name) - unit('echo', i, b.name)).slice(0, 2 + Math.floor(unit('n', i) * 2))
                : [];
            const roll = unit('react', i, line.startTime);
            const reaction = chorus
                ? { mark: '♪', count: echoes.length + 1 }
                : roll < 0.24 ? { mark: REACTIONS[Math.floor(unit('mark', i) * 4)], count: 1 + Math.floor(unit('cnt', i) * 3) } : null;
            messages.push({
                kind: 'line', start: line.startTime, line, sender, side: sender.me ? 'right' : 'left', chorus, echoes, reaction,
                index: i, continued: last === sender
            });
            last = sender;
        });
        const lastLine = sung[sung.length - 1];
        // 没有歌词：整首歌是一条语音，群里就听着
        if (!lastLine && duration > 6) {
            messages.push({ kind: 'voice', start: 1.2, end: duration - 1.5, sender: MEMBERS[0], side: 'left', whole: true });
        }
        if (lastLine) {
            const end = Math.max(lastLine.endTime, lastLine.vocalEndTime || 0) + 1.5;
            if (!(duration > 0) || end < duration) messages.push({ kind: 'system', start: end, text: '— 曲终 · 群聊结束 —' });
        }
        messages.sort((a, b) => a.start - b.start);
        return messages;
    };

    // 最后一条已经出现的消息（start ≤ t）
    const messageIndexAt = (messages, t) => {
        let lo = 0, hi = messages.length - 1, found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (messages[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return found;
    };

    // 开唱前「正在输入」的那一条
    const typingAt = (messages, t) => {
        const i = messageIndexAt(messages, t) + 1;
        for (let k = i; k < messages.length && k < i + 3; k += 1) {
            const m = messages[k];
            if (m.kind === 'line') return m.start - t <= TYPING_LEAD ? m : null;
            if (m.kind === 'voice') return null;
        }
        return null;
    };

    const avatarStyle = (sender) => sender.me
        ? ''
        : `--gc-h:${sender.hue}`;

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('groupchat', '群唱', container, services);
        const head = createElement('header', 'gc-head');
        head.innerHTML = '<i class="gc-back">‹</i><div class="gc-title"><b></b><span></span></div><div class="gc-level"><i></i><i></i><i></i><i></i></div>';
        const headTitle = head.querySelector('b');
        const headSub = head.querySelector('span');
        const levels = Array.from(head.querySelectorAll('.gc-level > i'));
        const viewport = createElement('div', 'gc-viewport');
        const list = createElement('div', 'gc-list');
        viewport.append(list);
        const kicker = createElement('div', 'gc-kicker', '群唱');
        mode.root.append(head, viewport, kicker);
        const cardInset = Utils.watchCardInset(mode.root);
        mode.scope.add(() => cardInset.destroy());

        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let messages = [];
        let threadFor = null;
        let shownUpTo = -1;        // 已经放进 DOM 的最后一条消息
        let rows = [];             // { message, el, text, glyphs, shown, tr }
        let typingRow = null;
        let typingFor = null;
        let paused = false;
        let latest = null;
        let lastDraw = -Infinity;
        let lastOnsets = -1;
        let caption = '';
        let sub = '';
        let lastT = -Infinity;
        let voiceRow = null;
        const stats = { rebuilds: 0, rows: 0 };

        const settings = () => {
            const tuning = mode.config.modes?.groupchat || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                voiceNotes: tuning.voiceNotes !== false,
                echoes: tuning.echoes !== false,
                reactions: tuning.reactions !== false,
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: global.MusicStageRuntime.isReducedMotion(reducedMotion)
            };
        };
        const applyScale = () => mode.root.style.setProperty('--gc-scale', String(settings().fontScale));
        applyScale();

        // 头像：每人一张自己的小脸；眨眼错开（每人不同的延迟），正在唱的那句的人张嘴
        const avatar = (sender, cls = 'gc-avatar') => {
            const a = createElement('div', `${cls}${sender.me ? ' is-me' : ''}`);
            a.innerHTML = face(sender.me ? '我' : sender.name);
            a.title = sender.name;
            a.style.cssText = `${avatarStyle(sender)};--gc-blink:${(-unit('blink', sender.name) * 5).toFixed(2)}s`;
            return a;
        };

        // 一条消息的 DOM；past 为真时整句直接显示完（拖进度、刚切进来时用）
        const makeRow = (message, past, s) => {
            if (message.kind === 'system') {
                const el = createElement('div', `gc-row gc-system${message.stamp ? ' is-stamp' : ''}`);
                el.append(createElement('span', '', message.text));
                return { message, el };
            }
            const el = createElement('div', `gc-row is-${message.side}`);
            if (message.kind === 'sticker') {
                el.classList.add('is-sticker');
                el.append(avatar(message.sender));
                const body = createElement('div', 'gc-body');
                const sticker = createElement('div', 'gc-sticker');
                sticker.innerHTML = face(message.sender.name, { ...message.sticker, bg: false });
                sticker.setAttribute('role', 'img');
                sticker.setAttribute('aria-label', message.sticker.label);
                body.append(createElement('div', 'gc-name', message.sender.name), sticker);
                el.append(body);
                return { message, el };
            }
            if (message.continued) el.classList.add('is-continued');
            el.append(avatar(message.sender));
            const body = createElement('div', 'gc-body');
            if (!message.sender.me && !message.continued) body.append(createElement('div', 'gc-name', message.sender.name));
            const bubble = createElement('div', 'gc-bubble');
            body.append(bubble);
            el.append(body);
            if (message.kind === 'voice') {
                el.classList.add('is-voice');
                bubble.innerHTML = '<i class="gc-play"></i><div class="gc-wave"></div><span class="gc-dur"></span>';
                const wave = bubble.querySelector('.gc-wave');
                const bars = [];
                for (let i = 0; i < BARS; i += 1) {
                    const b = createElement('i');
                    // 没在播的时候：一条固定的、看着像语音的波形
                    const rest = 0.25 + 0.55 * Math.abs(Math.sin(i * 1.7 + message.start)) * (0.6 + 0.4 * unit('bar', message.start, i));
                    b.style.transform = `scaleY(${rest.toFixed(3)})`;
                    b.dataset.rest = rest.toFixed(3);
                    wave.append(b);
                    bars.push(b);
                }
                bubble.querySelector('.gc-dur').textContent = message.whole ? fmt(message.end - message.start) : `${Math.max(1, Math.round(message.end - message.start))}″`;
                if (message.whole) body.append(createElement('div', 'gc-meta', '这首没有歌词 · 一起听'));
                return { message, el, bars, played: 0 };
            }
            if (message.chorus) el.classList.add('is-chorus');
            const text = createElement('div', 'gc-text');
            bubble.append(text);
            const glyphs = buildGlyphTimeline(message.line);
            let tr = null;
            const supplemental = s.showTranslation ? resolveSupplementalText(message.line) : '';
            if (supplemental) {
                tr = createElement('div', 'gc-tr', supplemental);
                bubble.append(tr);
            }
            const row = { message, el, text, glyphs, shown: 0, tr, bubble, body, meta: null };
            if (message.chorus && s.echoes && message.echoes.length) {
                const echo = createElement('div', 'gc-echo');
                const stack = createElement('div', 'gc-stack');
                message.echoes.forEach(m => stack.append(avatar(m, 'gc-mini')));
                echo.append(stack, createElement('span', '', `${message.echoes.length} 人一起唱`));
                body.append(echo);
                row.echo = echo;
                if (past) echo.classList.add('is-on');
            }
            if (past) {
                text.textContent = message.line.fullText;
                row.shown = glyphs.length;
                el.classList.add('is-past');
                finish(row, s, false);
            } else {
                if (tr) tr.classList.add('is-waiting');
                el.classList.add('is-active');
            }
            return row;
        };

        // 唱完：补上点赞、已读
        const finish = (row, s, animate) => {
            if (row.done) return;
            row.done = true;
            const m = row.message;
            if (row.tr) row.tr.classList.remove('is-waiting');
            const parts = [];
            if (s.reactions && m.reaction) {
                const chip = createElement('span', 'gc-chip', `${m.reaction.mark} ${m.reaction.count}`);
                if (animate && s.live) chip.classList.add('is-pop');
                parts.push(chip);
            }
            if (m.side === 'right') parts.push(createElement('span', 'gc-read', `${2 + (m.index % 4)} 人已读`));
            parts.push(createElement('span', 'gc-time', fmt(m.start)));
            if (parts.length) {
                const meta = createElement('div', 'gc-meta');
                meta.append(...parts);
                row.body.append(meta);
                row.meta = meta;
            }
        };

        const trim = () => {
            while (rows.length > KEEP_ROWS) rows.shift().el.remove();
        };

        // 新行进来时整列往上滑：先把列表往下挪出新行的高度，再过渡回 0
        const pushRow = (row, animate) => {
            const before = list.offsetHeight;
            if (typingRow) list.insertBefore(row.el, typingRow.el); else list.append(row.el);
            rows.push(row);
            if (!animate) return;
            const delta = list.offsetHeight - before;
            row.el.classList.add('is-enter');
            if (delta > 0) {
                list.style.transition = 'none';
                list.style.transform = `translateY(${delta}px)`;
                void list.offsetHeight;
                list.style.transition = '';
                list.style.transform = '';
            }
        };

        const rebuild = (index, s, t) => {
            stats.rebuilds += 1;
            list.replaceChildren();
            rows = [];
            typingRow = null;
            typingFor = null;
            voiceRow = null;
            const from = Math.max(0, index - KEEP_ROWS + 1);
            for (let k = from; k <= index; k += 1) {
                const m = messages[k];
                const live = k === index && (m.kind === 'line' || m.kind === 'voice');
                const row = makeRow(m, !live, s);
                pushRow(row, false);
                if (m.kind === 'voice' && t < m.end) voiceRow = row;
            }
            shownUpTo = index;
        };

        const setTyping = (message, t) => {
            if (typingFor === message) return;
            if (typingRow) { typingRow.el.remove(); typingRow = null; }
            typingFor = message;
            if (!message) return;
            const el = createElement('div', `gc-row gc-typing is-${message.side}`);
            el.append(avatar(message.sender));
            const bubble = createElement('div', 'gc-bubble');
            bubble.innerHTML = '<i></i><i></i><i></i>';
            el.append(bubble);
            typingRow = { el };
            const before = list.offsetHeight;
            list.append(el);
            const delta = list.offsetHeight - before;
            if (delta > 0 && Number.isFinite(t)) {
                list.style.transition = 'none';
                list.style.transform = `translateY(${delta}px)`;
                void list.offsetHeight;
                list.style.transition = '';
                list.style.transform = '';
            }
        };

        const revealRow = (row, t, s) => {
            if (!row.glyphs || row.done) return;
            let count = 0;
            while (count < row.glyphs.length && row.glyphs[count].startTime <= t + 0.02) count += 1;
            if (count < row.shown) {
                row.text.replaceChildren();
                row.shown = 0;
            }
            if (count > row.shown) {
                const frag = global.document.createDocumentFragment();
                for (let i = row.shown; i < count; i += 1) {
                    const span = createElement('span', s.reducedMotion || !s.live ? '' : 'is-new', row.glyphs[i].text);
                    frag.append(span);
                }
                row.text.append(frag);
                row.shown = count;
            }
            const line = row.message.line;
            const end = Math.max(line.endTime, line.vocalEndTime || 0);
            if (row.echo && t >= line.startTime + 0.35) row.echo.classList.add('is-on');
            if (count >= row.glyphs.length && t >= end - 0.05) {
                row.el.classList.remove('is-active');
                row.el.classList.add('is-past');
                finish(row, s, true);
            }
        };

        const updateVoice = (row, frame, s) => {
            const m = row.message;
            const t = frame.playbackTime;
            const live = t >= m.start && t < m.end;
            row.el.classList.toggle('is-playing', live && frame.isPlaying);
            const played = clamp((t - m.start) / Math.max(0.1, m.end - m.start), 0, 1);
            const cut = Math.floor(played * BARS);
            if (cut !== row.played) {
                row.bars.forEach((b, i) => b.classList.toggle('is-played', i < cut));
                row.played = cut;
            }
            if (!live) {
                if (row.wasLive) row.bars.forEach(b => {
                    const tr = `scaleY(${b.dataset.rest})`;
                    if (b._tr !== tr) { b._tr = tr; b.style.transform = tr; }
                });
                row.wasLive = false;
                return;
            }
            row.wasLive = true;
            const spec = frame.audio?.spectrum || [];
            const n = spec.length;
            for (let i = 0; i < row.bars.length; i += 1) {
                const b = row.bars[i];
                const v = n ? clamp(Number(spec[Math.floor(BAR_WEIGHTS[i] * n)]) || 0, 0, 1) : 0;
                const h = clamp(0.14 + v * 1.1 * s.audioReactivity, 0.12, 1);
                const tr = `scaleY(${h.toFixed(3)})`;
                if (b._tr !== tr) { b._tr = tr; b.style.transform = tr; }
            }
        };

        const updateHeader = (frame, typing, s) => {
            const title = String(frame.track?.title || '').trim() || '群唱';
            const next = `《${title}》`;
            if (next !== caption) { caption = next; headTitle.textContent = next; }
            let subtitle;
            if (typing) subtitle = `${typing.sender.me ? '我' : typing.sender.name} 正在输入…`;
            else if (voiceRow && frame.playbackTime < voiceRow.message.end && frame.playbackTime >= voiceRow.message.start) subtitle = `${voiceRow.message.sender.name} 的语音 · 播放中`;
            else if (frame.lyricsEstimated) subtitle = `${MEMBERS.length + 1} 人 · 纯文本歌词，按时长铺开`;
            else subtitle = `${MEMBERS.length + 1} 人 · ${Utils.lineCounter(frame)}`;
            if (subtitle !== sub) { sub = subtitle; headSub.textContent = subtitle; head.classList.toggle('is-typing', Boolean(typing)); }
            // 右上角的电平小格
            const a = frame.audio || {};
            const vals = [a.bass, a.lowMid, a.vocal, a.treble];
            levels.forEach((el, i) => {
                const v = frame.isPlaying && !s.reducedMotion ? clamp((Number(vals[i]) || 0) * 1.3 * s.audioReactivity, 0.08, 1) : 0.15;
                const tr = `scaleY(${v.toFixed(2)})`;
                if (el._tr !== tr) { el._tr = tr; el.style.transform = tr; }
            });
        };

        const step = (frame) => {
            const s = settings();
            s.live = Boolean(frame.isPlaying);
            mode.root.classList.toggle('is-live', s.live && !s.reducedMotion);
            const t = frame.playbackTime || 0;
            const key = `${frame.track?.path || frame.track?.title || ''}|${Math.round(frame.duration || 0)}`;
            if (!threadFor || threadFor.lines !== frame.lines || threadFor.key !== key) {
                messages = buildThread(frame.lines, String(frame.track?.title || '').trim(), frame.duration);
                threadFor = { lines: frame.lines, key };
                shownUpTo = -2;
            }
            const index = messageIndexAt(messages, t);
            // 往回拖、或者一下跳过好几条：整列重排；正常播放：一条一条加
            if (index < shownUpTo || index > shownUpTo + 2 || t < lastT - 0.5) rebuild(index, s, t);
            else {
                while (shownUpTo < index) {
                    shownUpTo += 1;
                    const m = messages[shownUpTo];
                    // 刚建好对话、第一条还没到（index = -1）时 shownUpTo 会走到 -1：没有这条消息，跳过
                    if (!m) continue;
                    for (let i = 0; i < rows.length; i += 1) {
                        const r = rows[i];
                        if (!r.glyphs || r.done) continue;
                        r.text.textContent = r.message.line.fullText;
                        r.shown = r.glyphs.length;
                        r.el.classList.remove('is-active');
                        r.el.classList.add('is-past');
                        finish(r, s, true);
                    }
                    if (typingFor === m) { typingRow?.el.remove(); typingRow = null; typingFor = null; }
                    const row = makeRow(m, false, s);
                    pushRow(row, !s.reducedMotion && s.live);
                    if (m.kind === 'voice') voiceRow = row;
                }
                trim();
            }
            lastT = t;
            stats.rows = rows.length;

            const typing = typingAt(messages, t);
            setTyping(typing, frame.isPlaying && !s.reducedMotion ? t : NaN);
            rows.forEach((row) => { if (row.glyphs && !row.done) revealRow(row, t, s); });
            if (voiceRow) {
                if (!s.voiceNotes) voiceRow.el.hidden = true;
                else { voiceRow.el.hidden = false; updateVoice(voiceRow, frame, s); }
            }
            updateHeader(frame, typing, s);

            // 鼓点：正在唱的那条轻轻一跳
            const audio = frame.audio || {};
            const onset = Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets;
            if (Number.isFinite(audio.onsets)) lastOnsets = audio.onsets;
            if (onset && frame.isPlaying && !s.reducedMotion) {
                const active = rows.find(r => r.glyphs && !r.done);
                if (active) {
                    if (typeof active.bubble.animate === 'function') {
                        active.bubble.animate(
                            [{ transform: 'scale(1)' }, { transform: 'scale(1.025)', offset: 0.4 }, { transform: 'scale(1)' }],
                            { duration: 220, easing: 'ease-out' }
                        );
                    } else {
                        active.bubble.classList.remove('is-thump');
                        void active.bubble.offsetWidth;
                        active.bubble.classList.add('is-thump');
                    }
                }
            }
            const chorusNow = rows.some(r => r.message.chorus && !r.done);
            mode.root.classList.toggle('is-chorus', chorusNow);
            const cap = `群唱 · ${Utils.lineCounter(frame)}`;
            if (cap !== kicker.textContent) kicker.textContent = cap;
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latest = frame;
            const aim = 1000 / (FPS[mode.config.quality || 'standard'] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (!frame.isPlaying && frame.playbackTime === lastT && threadFor && threadFor.lines === frame.lines) return;
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            step(frame);
        };

        const refresh = () => { lastDraw = -Infinity; shownUpTo = -2; threadFor = null; if (latest) mode.updateFrame(latest); };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); applyScale(); refresh(); };
        mode.resize = () => cardInset.measure();
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); lastDraw = -Infinity; if (latest) mode.updateFrame(latest); };
        mode.updateTheme = () => {};
        mode.scope.listen(global, 'music-motion-change', refresh);
        mode.scope.add(() => {
            rows = [];
            messages = [];
            threadFor = null;
            typingRow = null;
            typingFor = null;
            voiceRow = null;
            latest = null;
        });
        mode.getDebugSnapshot = () => ({ initialized: true, messages: messages.length, rows: stats.rows, rebuilds: stats.rebuilds });
        return mode;
    };

    global.MusicStageGroupchatManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ buildThread, messageIndexAt, typingAt, MEMBERS, ME, TYPING_LEAD })
    });
})(window);
