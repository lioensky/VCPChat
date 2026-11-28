(function (global) {
    'use strict';
    /*
     * The walled city's signs and screens: neon blades and fascia boards,
     * lightboxes, rooftop billboards on their steel frames, the big lyric
     * screen on the south face, the tall screens beside it and in the alley,
     * the LED tickers, and small advert screens.
     *
     * Everything is painted once into a sign atlas (two layers: the unlit
     * surface and the light it gives off) and merged into a handful of meshes:
     *   hardware  boards, boxes, brackets, frames (opaque, lit by the scene)
     *   glow      the light layer, 3 cm proud of each face (additive)
     *   screens   every LED screen, one shader, regions of one lyric canvas
     * Flicker, ignition and beat are computed per sign on the CPU each frame
     * and handed to the shaders as small uniform arrays, so lights() reports
     * exactly what the reflections should show.
     */

    // ---------- deterministic helpers -------------------------------------

    const hashString = text => {
        let h = 2166136261 >>> 0;
        const s = String(text);
        for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    };
    const mulberry = seed => {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };
    const rngFor = (ctx, key) => {
        const made = ctx?.rand?.(key);
        return typeof made === 'function' ? made : mulberry(hashString(key));
    };
    const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
    const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
    const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];
    const take = (random, pool, fallback) => pool.length ? pool.splice(Math.floor(random() * pool.length), 1)[0] : pick(random, fallback);
    const graphemeSegmenter = global.Intl?.Segmenter ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;
    const graphemes = text => {
        const s = String(text || '');
        if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(s), x => x.segment);
        return Array.from(s);
    };
    const isWide = ch => /[⺀-鿿豈-﫿＀-￯　-〿가-힯]/.test(ch);
    // A smooth value noise in time: the same in every frame for the same input.
    const noise1 = (x, seed) => {
        const i = Math.floor(x), f = x - i;
        const h = n => { const v = Math.sin((n + seed * 131.7) * 12.9898) * 43758.5453; return v - Math.floor(v); };
        const u = f * f * (3 - 2 * f);
        return h(i) * (1 - u) + h(i + 1) * u;
    };
    const vec = v => {
        if (!v) return [0, 0, 0];
        if (Array.isArray(v)) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
        return [Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0];
    };
    const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
    const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const hexRgb = hex => {
        const h = String(hex || '#ffffff').replace('#', '');
        const n = parseInt(h.length === 3 ? h.replace(/./g, c => c + c) : h.slice(0, 6), 16) || 0;
        return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    };
    const rgbCss = (c, k = 1) => `rgb(${Math.round(clamp(c[0] * k) * 255)},${Math.round(clamp(c[1] * k) * 255)},${Math.round(clamp(c[2] * k) * 255)})`;
    const lum = c => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

    // ---------- what the signs say -----------------------------------------
    // Trades of a crowded block, old and new. Invented names only.

    const VERTICAL_SHOPS = [
        ['義肢工房', 'PROSTHETICS'], ['神經科診所', 'NEURO CLINIC'], ['牙科醫務所', 'DENTIST'], ['跌打醫館'],
        ['金鋪', 'GOLD'], ['大押'], ['電器維修', 'REPAIRS'], ['麻雀耍樂'], ['夜總會', 'NIGHT CLUB'],
        ['桑拿浴室', 'SAUNA'], ['和平賓館', 'HOTEL'], ['海鮮酒家'], ['藥房', 'PHARMACY'], ['義眼驗配', 'OPTIC'],
        ['晶片回收', 'CHIP BUY'], ['電腦網絡'], ['理髮'], ['鐘錶行'], ['涼茶'], ['照相沖印'], ['腦機接駁', 'LINK-UP'],
        ['數據清洗'], ['光纖專門'], ['新華旅店', 'INN'], ['算命'], ['中西藥行'], ['夜市'], ['義體保養', 'MAINT'],
        ['大華戲院', 'CINEMA'], ['老字號燒味']
    ];
    const HORIZONTAL_SHOPS = [
        ['冰室', 'CAFE'], ['茶餐廳'], ['燒臘飯店'], ['網吧', 'NET 24H'], ['卡拉OK'], ['車仔麵'], ['雲吞麵家'],
        ['電子遊戲機', 'GAME CENTRE'], ['當舖'], ['五金'], ['士多'], ['點心'], ['錄像帶出租', 'VIDEO'], ['神經同步', 'SYNC'],
        ['記憶修復', 'MEMORY'], ['晶片專門'], ['電器'], ['洗衣'], ['海味'], ['義體零件', 'PARTS'], ['24小時'],
        ['龍鳳酒樓'], ['士多啤梨'], ['電訊', 'TELECOM']
    ];
    // Rooftop billboards: invented brands.
    const ROOF_BRANDS = [
        ['鳳凰義體', 'PHOENIX CYBERNETICS'], ['大東電機', 'DAITO ELECTRIC'], ['萬象網絡', 'OMNINET'],
        ['恒星電訊', 'STELLAR TEL'], ['新紀元', 'NEO ERA'], ['金龍銀行', 'GOLDEN DRAGON BANK'],
        ['龍城', 'DRAGON CITY'], ['東方電子', 'ORIENT ELECTRONICS'], ['九龍', 'KOWLOON'], ['極光汽水', 'AURORA SODA']
    ];
    const AD_SLOGANS = [
        ['萬象網絡', 'ALWAYS CONNECTED'], ['鳳凰義體', 'REBUILD YOURSELF'], ['極光汽水', 'ICE COLD'],
        ['恒星電訊', '5G · 6G · 7G'], ['新紀元', 'TOMORROW TODAY'], ['大東電機', 'SINCE 1962']
    ];
    // Neon colours of a wet night: cyan, magenta, amber, green, red, violet, cold white.
    const NEON = ['#2ef2ff', '#ff3fae', '#ffb02e', '#3dff8a', '#ff3b3b', '#a77bff', '#e8f4ff', '#ff6a1f'];
    // The night leans cold: cyan, magenta, violet and ice white come up most.
    const NEON_COLD = ['#2ef2ff', '#30e0ff', '#ff3fae', '#ff2fd0', '#a77bff', '#e8f4ff', '#5a8cff'];
    const neonPick = random => random() < 0.68 ? pick(random, NEON_COLD) : pick(random, NEON);
    // Copy for the hologram banners: made-up firms and slogans, read top to bottom.
    const HOLO_COPY = [
        ['義體診所', 'CYBER LIMBS', '24H'], ['電腦接駁', 'NEURAL LINK', 'v9.2'], ['記憶備份', 'MEMORY BACKUP', '99.9%'],
        ['萬象網絡', 'OMNINET', '7G'], ['極光汽水', 'AURORA SODA', 'ICE'], ['鳳凰義體', 'PHOENIX', 'NEW'],
        ['量子銀行', 'QUANTUM BANK', '0.0%'], ['不夜城', 'NIGHT NEVER ENDS', '∞'], ['新紀元', 'NEO ERA', '2099'],
        ['夢工場', 'DREAM WORKS LTD', 'VR'], ['龍城藥房', 'DRAGON PHARMA', 'Rx'], ['電子神社', 'E-SHRINE', '祈']
    ];
    const BOXES = [
        ['#f2ead8', '#c41f25'], ['#ffd21f', '#161616'], ['#d61f26', '#fff1d0'], ['#1b62c9', '#ffffff'],
        ['#119a55', '#ffffff'], ['#f7f7f2', '#1a3fa0'], ['#1a1a1a', '#ffcf3a'], ['#7a1fd6', '#ffffff'],
        ['#0d2a4a', '#5ff0ff'], ['#1a1030', '#ff5ad0'], ['#e8f6ff', '#0b4fa8'], ['#0a1a22', '#9fe8ff']
    ];
    const FONTS = {
        heavy: '"Microsoft JhengHei","Microsoft YaHei","PingFang TC","Noto Sans CJK TC","WenQuanYi Zen Hei",sans-serif',
        brush: '"DFKai-SB","BiauKai","KaiTi","STKaiti","Noto Serif CJK TC","WenQuanYi Zen Hei",serif',
        ming: '"MingLiU","PMingLiU","SimSun","Noto Serif CJK TC","WenQuanYi Zen Hei",serif',
        latin: '"Bahnschrift","DIN Condensed","Arial Narrow","Helvetica Neue",Arial,sans-serif',
        lyric: '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif'
    };

    // ---------- canvas -------------------------------------------------------

    const makeCanvas = (w, h) => {
        if (typeof OffscreenCanvas === 'function' && !global.document) return new OffscreenCanvas(w, h);
        const c = global.document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
    };

    // Shelf packing, tallest first. Returns rects in input order.
    const pack = (sizes, width, pad) => {
        const order = sizes.map((s, i) => ({ ...s, i })).sort((a, b) => b.h - a.h);
        const rects = new Array(sizes.length);
        let x = pad, y = pad, row = 0;
        for (const s of order) {
            if (x + s.w + pad > width) { x = pad; y += row + pad; row = 0; }
            rects[s.i] = { x, y, w: s.w, h: s.h };
            x += s.w + pad;
            row = Math.max(row, s.h);
        }
        return { rects, height: y + row + pad };
    };

    // ---------- sign design --------------------------------------------------
    // A sign spec is everything the painter and the builder need, chosen once
    // from the slot and the seed.

    const designSign = (slot, index, random, pools) => {
        // In the alleys a flat board is seen edge-on; most hang out over the walk instead.
        const kind = slot._alleyW && slot.kind === 'flat' && random() < 0.75 ? 'blade' : slot.kind || 'flat';
        const tilt = random() < 0.08 ? (random() - 0.5) * 0.09 : 0;
        if (kind === 'roof') {
            const [cn, en] = take(random, pools.roof, ROOF_BRANDS);
            // A few are the skyline's big frames: wide neon on deep steel, some tubes long dead.
            const mega = slot._street && random() < 0.45 || !slot._street && random() < 0.12;
            const span = mega ? 17 + random() * 7 : Math.max(6, Math.min(14, (Number(slot.width) || 8) * 1.4));
            const neon = mega || random() < 0.6;
            const color = neonPick(random), box = pick(random, BOXES);
            const chars = graphemes(cn).length;
            const dead = [];
            if (neon && random() < (mega ? 0.7 : 0.25)) dead.push(Math.floor(random() * chars));
            if (mega && random() < 0.35) dead.push(Math.floor(random() * chars));
            return {
                mega,
                index, kind, text: cn, caption: en, vertical: false,
                style: neon ? 'neon' : 'box', font: random() < 0.5 ? 'heavy' : 'brush',
                color, border: neonPick(random), box,
                width: span, height: span * (mega ? 0.3 + random() * 0.08 : 0.26 + random() * 0.12), depth: mega ? 0.8 : 0.5,
                lift: mega ? 2.6 + random() * 2.2 : 1.2 + random() * 1.4, bulbs: !neon && random() < 0.5, dead, tubes: true, tilt: 0,
                gain: neon ? 1.6 / (0.55 + lum(hexRgb(color)) * 0.9) : 0.95 / (0.6 + lum(hexRgb(box[0])) * 0.6),
                broken: mega ? (random() < 0.5 ? 0.45 : 0) : random() < 0.12 ? 0.5 : 0, beat: Math.floor(random() * 3)
            };
        }
        const blade = kind === 'blade';
        const shop = kind === 'shop';
        const vertical = blade ? random() < 0.72 : shop ? false : random() < 0.12;
        const pool = vertical ? pools.vertical : pools.horizontal;
        const [text, caption] = take(random, pool, vertical ? VERTICAL_SHOPS : HORIZONTAL_SHOPS);
        const chars = graphemes(text).length;
        const style = random() < 0.08 ? 'dead' : random() < (slot._alleyW ? 0.75 : 0.58) ? 'neon' : 'box';
        let width, height;
        if (vertical) {
            width = blade ? 1.1 + random() * 0.8 : 1.2 + random() * 0.6;
            height = Math.min(9, chars * width * (0.85 + random() * 0.25) + (caption ? 0.9 : 0.4));
        } else {
            height = blade ? 1.1 + random() * 0.7 : shop ? 0.8 + random() * 0.45 : 1.0 + random() * 0.9;
            width = Math.min(blade ? 5.5 : shop ? Math.max(2, (Number(slot.width) || 2.05) * (1.6 + random() * 1.2)) : 9, chars * height * (0.82 + random() * 0.3) + (caption ? 0 : 0.5));
            if (caption && !blade) height += 0.35;
        }
        // Out on the street the boards run bigger, to be read across the way.
        if (slot._street && !slot._alleyW && !shop) {
            const k = 1.15 + random() * 0.15;
            width *= k; height *= k;
        }
        if (slot._alleyW) {
            // Leave the alley passable: a blade reaches at most two fifths across.
            if (blade) {
                const reach = Math.max(0.5, slot._alleyW * 0.42 - 0.35);
                const k = Math.min(1, reach / width);
                width *= k; if (!vertical) height = Math.max(0.5, height * Math.max(0.7, k));
            }
            height = Math.min(height, vertical ? 4.6 : 1.4);
        }
        const dead = [];
        if (style === 'neon' && random() < 0.35) dead.push(Math.floor(random() * chars));
        const color = neonPick(random), box = pick(random, BOXES);
        return {
            index, kind, text, caption, vertical, style,
            font: style === 'box' ? pick(random, ['heavy', 'heavy', 'ming', 'brush']) : pick(random, ['heavy', 'brush', 'brush', 'ming']),
            color, border: random() < 0.55 ? null : neonPick(random), box,
            width, height, depth: blade ? 0.32 : 0.22, lift: 0,
            bulbs: style === 'box' && random() < 0.22, dead, tubes: true, tilt,
            // Pale tubes and white boxes would read as blots; they burn a little lower.
            gain: style === 'neon' ? 1.45 / (0.55 + lum(hexRgb(color)) * 0.9) : style === 'box' ? 0.6 / (0.6 + lum(hexRgb(box[0])) * 0.6) : 0,
            broken: style === 'neon' ? (random() < 0.3 ? 0.35 + random() * 0.5 : 0) : (random() < 0.08 ? 0.3 : 0),
            beat: Math.floor(random() * 3), phone: style === 'box' && !vertical && random() < 0.5
        };
    };

    // ---------- painting -----------------------------------------------------
    // base: what the sign looks like unlit (lit by the street).
    // emit: the light it gives off (black where none).
    // mask: R = tube channel (0 steady, 1..16 a tube that can fail on its own,
    //       250 a chase bulb with its phase in G).

    const grime = (g, r, random, strength) => {
        // Streaks down from the top edge and bolts, speckle, darkened rim.
        g.save();
        g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
        const rim = g.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
        rim.addColorStop(0, `rgba(20,14,8,${0.35 * strength})`);
        rim.addColorStop(0.15, 'rgba(0,0,0,0)');
        rim.addColorStop(0.85, 'rgba(0,0,0,0)');
        rim.addColorStop(1, `rgba(40,22,10,${0.45 * strength})`);
        g.fillStyle = rim; g.fillRect(r.x, r.y, r.w, r.h);
        const streaks = 4 + Math.floor(r.w / 40);
        for (let i = 0; i < streaks; i += 1) {
            const x = r.x + random() * r.w, len = r.h * (0.2 + random() * 0.8), w = 1 + random() * Math.max(2, r.w * 0.012);
            const s = g.createLinearGradient(x, r.y, x, r.y + len);
            s.addColorStop(0, `rgba(${90 + random() * 40},${50 + random() * 20},20,${0.35 * strength})`);
            s.addColorStop(1, 'rgba(60,30,10,0)');
            g.fillStyle = s; g.fillRect(x, r.y, w, len);
        }
        const dots = Math.floor(r.w * r.h / 660 * strength);
        for (let pass = 0; pass < 2; pass += 1) {
            g.fillStyle = pass === 0 ? 'rgba(0,0,0,0.17)' : 'rgba(120,90,60,0.17)';
            const count = dots >> 1;
            for (let i = 0; i < count; i += 1) {
                g.fillRect(r.x + random() * r.w, r.y + random() * r.h, 1.5 + random() * 2.5, 1.5 + random() * 2.5);
            }
        }
        g.restore();
    };
    const bolts = (g, r, s) => {
        const d = Math.max(2, s * 0.035);
        g.fillStyle = '#4a4744';
        g.beginPath();
        const pts = [[0.04, 0.06], [0.96, 0.06], [0.04, 0.94], [0.96, 0.94]];
        for (let i = 0; i < 4; i += 1) {
            const x = r.x + r.w * pts[i][0], y = r.y + r.h * pts[i][1];
            g.moveTo(x + d, y); g.arc(x, y, d, 0, Math.PI * 2);
        }
        g.fill();
        g.fillStyle = 'rgba(110,60,25,0.5)';
        for (let i = 0; i < 4; i += 1) {
            g.fillRect(r.x + r.w * pts[i][0] - d * 0.4, r.y + r.h * pts[i][1], d * 0.8, d * 6);
        }
    };

    // Lay out glyph cells for a sign's main text inside the area (vertical or not).
    const cells = (text, area, vertical) => {
        const list = graphemes(text);
        const n = Math.max(1, list.length);
        // Latin runs in a vertical sign are set sideways as one cell.
        const out = [];
        if (vertical) {
            const step = area.h / n;
            list.forEach((ch, i) => out.push({ ch, x: area.x, y: area.y + i * step, w: area.w, h: step }));
        } else {
            const step = area.w / n;
            list.forEach((ch, i) => out.push({ ch, x: area.x + i * step, y: area.y, w: step, h: area.h }));
        }
        return out;
    };

    const fitFontPx = (g, ch, family, w, h, weight = 700) => {
        // CJK full-width glyphs are ~1em square; skipping measureText avoids hundreds of
        // DirectWrite font lookups, and 8px quantization lets signs share rasterized glyph caches.
        if (ch.length === 1 && isWide(ch)) {
            const raw = Math.floor(Math.min(w * 0.92, h * 0.86));
            return Math.max(8, (raw + 4) & ~7);
        }
        let px = Math.floor(Math.min(w, h) * 0.86);
        px = Math.max(8, (px + 4) & ~7);
        g.font = `${weight} ${px}px ${family}`;
        const mw = g.measureText(ch).width || px;
        if (mw > w * 0.92) px = Math.max(8, (Math.floor(px * w * 0.92 / mw) + 4) & ~7);
        return px;
    };
    const fitFont = (g, ch, family, w, h, weight = 800) => `${weight} ${fitFontPx(g, ch, family, w, h, weight)}px ${family}`;

    // Uses DirectWrite/Skia glyph atlas via fillText (strokeText on CJK tessellates Bezier outlines
    // and stalls texSubImage2D for 2+ seconds on 256 signs).
    const paintTube = (g, cell, family, color, width, core, px, halo) => {
        const size = px || fitFontPx(g, cell.ch, family, cell.w, cell.h, 700);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2 + cell.h * 0.02;
        g.font = `700 ${size}px ${family}`;
        if (halo) {
            const d = Math.max(1.5, width * 0.68);
            g.fillStyle = halo;
            g.fillText(cell.ch, cx - d, cy);
            g.fillText(cell.ch, cx + d, cy);
            g.fillText(cell.ch, cx, cy - d);
            g.fillText(cell.ch, cx, cy + d);
        }
        g.fillStyle = color;
        g.fillText(cell.ch, cx, cy);
        if (core) {
            g.font = `300 ${size}px ${family}`;
            g.fillStyle = core;
            g.fillText(cell.ch, cx, cy);
        }
    };

    const paintNeonSign = (L, spec, r, random) => {
        const { base, emit, mask } = L;
        const s = Math.min(r.w, r.h);
        const color = hexRgb(spec.color);
        const borderColor = hexRgb(spec.border || spec.color);
        const dead = spec.style === 'dead';
        // Board: dark enamel over sheet steel, a little colour of its own.
        base.fillStyle = rgbCss(mixRgb([0.07, 0.07, 0.08], color, 0.08)); base.fillRect(r.x, r.y, r.w, r.h);
        base.strokeStyle = '#2b2a29'; base.lineWidth = Math.max(2, s * 0.03); base.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        bolts(base, r, s);
        const pad = s * 0.12;
        const capH = spec.caption ? (spec.vertical ? r.w * 0.55 : r.h * 0.22) : 0;
        const area = spec.vertical
            ? { x: r.x + pad, y: r.y + pad, w: r.w - pad * 2, h: r.h - pad * 2 - capH }
            : { x: r.x + pad, y: r.y + pad, w: r.w - pad * 2, h: r.h - pad * 2 - capH };
        const list = cells(spec.text, area, spec.vertical);
        const tubeW = Math.max(2, Math.min(area.w, area.h) * (spec.vertical ? 0.07 : 0.06) * (spec.vertical ? 1 : list.length > 4 ? 0.8 : 1));
        const family = FONTS[spec.font] || FONTS.heavy;
        const sizes = new Array(list.length);
        for (let i = 0; i < list.length; i += 1) sizes[i] = fitFontPx(emit, list[i].ch, family, list[i].w, list[i].h, 600);
        // Unlit glass and its shadow on the board.
        const unlitGlass = rgbCss(mixRgb([0.42, 0.42, 0.44], color, 0.35));
        base.save(); base.translate(tubeW * 0.5, tubeW * 0.6);
        for (let i = 0; i < list.length; i += 1) paintTube(base, list[i], family, 'rgba(0,0,0,0.55)', tubeW * 1.1, null, sizes[i]);
        base.restore();
        for (let i = 0; i < list.length; i += 1) paintTube(base, list[i], family, unlitGlass, tubeW, null, sizes[i]);
        // Border tube (double for some).
        const border = (ctx, style, w) => {
            ctx.strokeStyle = style; ctx.lineWidth = w; ctx.lineJoin = 'round';
            const inset = pad * 0.45;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, pad * 0.4);
            else ctx.rect(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2);
            ctx.stroke();
        };
        border(base, rgbCss(mixRgb([0.4, 0.4, 0.42], borderColor, 0.3)), tubeW * 0.7);
        grime(base, r, random, 0.8);
        if (dead) return;
        // Light: concentric translucent halo + crisp tube + near-white core.
        const rgbaCss = (c, a) => `rgba(${Math.round(clamp(c[0]) * 255)},${Math.round(clamp(c[1]) * 255)},${Math.round(clamp(c[2]) * 255)},${a})`;
        const col1 = rgbCss(color, 1), haloCol = rgbaCss(color, 0.24), coreCol = rgbCss(mixRgb(color, [1, 1, 1], 0.72));
        for (let i = 0; i < list.length; i += 1) {
            if (spec.dead.includes(i)) continue;
            paintTube(emit, list[i], family, col1, tubeW, coreCol, sizes[i], haloCol);
        }
        border(emit, rgbaCss(borderColor, 0.22), tubeW * 1.9);
        border(emit, rgbaCss(borderColor, 0.42), tubeW * 1.25);
        border(emit, rgbCss(borderColor, 0.95), tubeW * 0.7);
        border(emit, rgbCss(mixRgb(borderColor, [1, 1, 1], 0.6)), tubeW * 0.26);
        // A wash of the tube's colour over the board: neon lights its own sign.
        const wash = emit.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, 0, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) * 0.7);
        wash.addColorStop(0, rgbCss(color, 0.16)); wash.addColorStop(1, rgbCss(color, 0.03));
        emit.globalCompositeOperation = 'lighter'; emit.fillStyle = wash; emit.fillRect(r.x, r.y, r.w, r.h);
        emit.globalCompositeOperation = 'source-over';
        // Caption: small Latin in a second colour.
        if (spec.caption) paintCaption(L, spec, r, capH, pad, borderColor, true);
        // Each glyph is its own tube: tubes of a failing sign fail one by one.
        list.forEach((cell, i) => {
            mask.fillStyle = `rgb(${1 + (spec.index * 5 + i) % 16},0,0)`;
            mask.fillRect(Math.floor(cell.x / 2) - 1, Math.floor(cell.y / 2) - 1, Math.ceil(cell.w / 2) + 2, Math.ceil(cell.h / 2) + 2);
        });
    };

    const paintCaption = (L, spec, r, capH, pad, color, neon) => {
        const { base, emit } = L;
        const vertical = spec.vertical;
        const room = vertical ? capH * 0.95 : r.w - pad * 2;
        let px = vertical ? r.w * 0.36 : capH * 0.78;
        emit.font = `700 ${px}px ${FONTS.latin}`;
        const mw = emit.measureText(spec.caption).width;
        if (mw > room) px *= room / mw;
        const font = `700 ${px}px ${FONTS.latin}`;
        const draw = (ctx, fill, glow) => {
            ctx.save();
            if (vertical) {
                ctx.translate(r.x + r.w / 2, r.y + r.h - pad - capH / 2);
                ctx.rotate(-Math.PI / 2);
            } else ctx.translate(r.x + r.w / 2, r.y + r.h - pad * 0.8 - capH / 2);
            ctx.font = font;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            if (glow) {
                const d = Math.max(1, px * 0.09);
                ctx.fillStyle = glow;
                ctx.fillText(spec.caption, -d, 0);
                ctx.fillText(spec.caption, d, 0);
                ctx.fillText(spec.caption, 0, -d);
                ctx.fillText(spec.caption, 0, d);
            }
            ctx.fillStyle = fill; ctx.fillText(spec.caption, 0, 0);
            ctx.restore();
        };
        if (neon) {
            draw(base, rgbCss(mixRgb([0.35, 0.35, 0.36], color, 0.3)));
            draw(emit, rgbCss(mixRgb(color, [1, 1, 1], 0.4)), `rgba(${Math.round(clamp(color[0]) * 255)},${Math.round(clamp(color[1]) * 255)},${Math.round(clamp(color[2]) * 255)},0.38)`);
        } else {
            draw(base, rgbCss(color));
            draw(emit, rgbCss(color, 0.9));
        }
    };

    const paintBoxSign = (L, spec, r, random) => {
        const { base, emit, mask } = L;
        const [bg, ink] = spec.box;
        const bgc = hexRgb(bg), inkc = hexRgb(ink);
        const s = Math.min(r.w, r.h);
        // Unlit acrylic: the face's colour, a little grey; aluminium frame.
        base.fillStyle = rgbCss(mixRgb(bgc, [0.5, 0.5, 0.5], 0.25), 0.8); base.fillRect(r.x, r.y, r.w, r.h);
        const frame = Math.max(3, s * 0.05);
        base.strokeStyle = '#8b8d90'; base.lineWidth = frame; base.strokeRect(r.x + frame / 2, r.y + frame / 2, r.w - frame, r.h - frame);
        const pad = s * 0.14;
        const phoneH = spec.phone ? r.h * 0.2 : 0;
        const capH = spec.caption ? (spec.vertical ? r.w * 0.5 : r.h * 0.2) : 0;
        const area = { x: r.x + pad, y: r.y + pad, w: r.w - pad * 2, h: r.h - pad * 2 - capH - phoneH };
        const list = cells(spec.text, area, spec.vertical);
        const family = FONTS[spec.font] || FONTS.heavy;
        const fonts = new Array(list.length);
        for (let i = 0; i < list.length; i += 1) fonts[i] = fitFont(emit, list[i].ch, family, list[i].w, list[i].h, 900);
        const write = (ctx, style) => {
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = style;
            for (let i = 0; i < list.length; i += 1) {
                const cell = list[i];
                ctx.font = fonts[i];
                ctx.fillText(cell.ch, cell.x + cell.w / 2, cell.y + cell.h / 2 + cell.h * 0.03);
            }
        };
        write(base, rgbCss(inkc, 0.85));
        if (spec.phone) {
            base.font = `700 ${phoneH * 0.6}px ${FONTS.latin}`; base.textAlign = 'center'; base.fillStyle = rgbCss(inkc, 0.8);
            base.fillText(`TEL ${3 + Math.floor(random() * 6)}${Math.floor(100 + random() * 899)} ${Math.floor(1000 + random() * 8999)}`, r.x + r.w / 2, r.y + r.h - pad * 0.7 - phoneH * 0.35);
        }
        grime(base, r, random, 1);
        if (spec.style === 'dead') return;
        // Lit: fluorescent tubes behind the acrylic show as soft bands.
        const g = emit.createLinearGradient(r.x, r.y, r.x + (spec.vertical ? r.w : 0), r.y + (spec.vertical ? 0 : r.h));
        const tubes = spec.vertical ? 2 : 3;
        for (let i = 0; i <= tubes * 2; i += 1) g.addColorStop(i / (tubes * 2), rgbCss(bgc, i % 2 ? 0.95 : 0.68));
        emit.fillStyle = g; emit.fillRect(r.x + frame, r.y + frame, r.w - frame * 2, r.h - frame * 2);
        const v = emit.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, s * 0.2, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) * 0.75);
        v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.45)');
        emit.fillStyle = v; emit.fillRect(r.x, r.y, r.w, r.h);
        // Vinyl letters: light ink lets light through, dark ink blocks it.
        write(emit, lum(inkc) > 0.5 ? rgbCss(inkc, 1) : rgbCss(inkc, 0.05));
        if (spec.caption) paintCaption(L, spec, { ...r, h: r.h - phoneH }, capH, pad, lum(inkc) > 0.5 ? inkc : [0.05, 0.05, 0.05], false);
        // A bulb chase round some boards.
        if (spec.bulbs) {
            const step = Math.max(8, s * 0.12);
            const perimeter = [];
            for (let x = r.x + step / 2; x < r.x + r.w; x += step) { perimeter.push([x, r.y + frame / 2]); }
            for (let y = r.y + step / 2; y < r.y + r.h; y += step) { perimeter.push([r.x + r.w - frame / 2, y]); }
            for (let x = r.x + r.w - step / 2; x > r.x; x -= step) { perimeter.push([x, r.y + r.h - frame / 2]); }
            for (let y = r.y + r.h - step / 2; y > r.y; y -= step) { perimeter.push([r.x + frame / 2, y]); }
            const rad = Math.max(1.5, step * 0.18);
            const drawBulbs = (ctx, radius) => {
                ctx.beginPath();
                for (let i = 0; i < perimeter.length; i += 1) {
                    const [x, y] = perimeter[i];
                    ctx.moveTo(x + radius, y);
                    ctx.arc(x, y, radius, 0, Math.PI * 2);
                }
                ctx.fill();
            };
            base.fillStyle = '#cfc8b8';
            drawBulbs(base, rad);
            emit.fillStyle = 'rgba(255,179,71,0.22)';
            drawBulbs(emit, rad * 2.3);
            emit.fillStyle = 'rgba(255,179,71,0.45)';
            drawBulbs(emit, rad * 1.55);
            emit.fillStyle = '#fff1c4';
            drawBulbs(emit, rad);
            for (let phase = 0; phase < 3; phase += 1) {
                mask.fillStyle = `rgb(250,${phase * 85},0)`;
                for (let i = phase; i < perimeter.length; i += 3) {
                    const [x, y] = perimeter[i];
                    mask.fillRect(Math.floor((x - rad * 2) / 2), Math.floor((y - rad * 2) / 2), Math.ceil(rad * 2) + 1, Math.ceil(rad * 2) + 1);
                }
            }
        }
    };

    // Small advert slides for the little screens: bold invented brands.
    const paintAd = (L, slogan, r, random, i) => {
        const { base, emit } = L;
        base.fillStyle = '#050608'; base.fillRect(r.x, r.y, r.w, r.h);
        const a = hexRgb(NEON[i % NEON.length]), b = hexRgb(NEON[(i + 3) % NEON.length]);
        const g = emit.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
        g.addColorStop(0, rgbCss(a, 0.5)); g.addColorStop(1, rgbCss(b, 0.25));
        emit.fillStyle = g; emit.fillRect(r.x, r.y, r.w, r.h);
        // A motif: rings, a chevron stack or a grid horizon.
        emit.save();
        emit.strokeStyle = rgbCss(mixRgb(a, [1, 1, 1], 0.4)); emit.lineWidth = Math.max(2, r.h * 0.02);
        const cx = r.x + r.w * 0.78, cy = r.y + r.h * 0.45;
        if (i % 3 === 0) for (let k = 1; k < 5; k += 1) { emit.beginPath(); emit.arc(cx, cy, r.h * 0.09 * k, 0, Math.PI * 2); emit.stroke(); }
        else if (i % 3 === 1) for (let k = 0; k < 4; k += 1) { emit.beginPath(); const y = r.y + r.h * (0.2 + k * 0.14); emit.moveTo(cx - r.h * 0.2, y); emit.lineTo(cx, y + r.h * 0.1); emit.lineTo(cx + r.h * 0.2, y); emit.stroke(); }
        else { for (let k = 0; k < 7; k += 1) { emit.beginPath(); emit.moveTo(r.x + r.w * 0.55, r.y + r.h * (0.5 + k * 0.07)); emit.lineTo(r.x + r.w, r.y + r.h * (0.5 + k * 0.07)); emit.stroke(); } }
        emit.restore();
        emit.textAlign = 'left'; emit.textBaseline = 'middle';
        emit.font = `900 ${r.h * 0.34}px ${FONTS.heavy}`;
        emit.fillStyle = '#ffffff'; emit.fillText(slogan[0], r.x + r.w * 0.06, r.y + r.h * 0.4, r.w * 0.66);
        emit.font = `700 ${r.h * 0.13}px ${FONTS.latin}`;
        emit.fillStyle = rgbCss(mixRgb(b, [1, 1, 1], 0.5)); emit.fillText(slogan[1], r.x + r.w * 0.06, r.y + r.h * 0.74, r.w * 0.66);
    };

    // Steel for box sides, brackets and frames; a darker patch for truss.
    const paintMetal = (L, r, random, tone) => {
        const { base } = L;
        base.fillStyle = tone; base.fillRect(r.x, r.y, r.w, r.h);
        for (let i = 0; i < r.w * r.h / 30; i += 1) {
            base.fillStyle = random() < 0.6 ? `rgba(110,55,20,${0.1 + random() * 0.25})` : `rgba(0,0,0,${0.1 + random() * 0.2})`;
            base.fillRect(r.x + random() * r.w, r.y + random() * r.h, 1 + random() * 4, 1 + random() * 8);
        }
    };

    // ---------- geometry ----------------------------------------------------

    const createBuilder = () => {
        const pos = [], nor = [], uv = [], info = [], idx = [], tags = [];
        // Each quad remembers who it belongs to, so the sandbox view can drop
        // whole pieces: 0 always drawn, n > 0 sign n-1, -1 not in the sandbox,
        // -2 only in the sandbox.
        let tag = 0;
        const quad = (p0, p1, p2, p3, n, uvr, inf) => {
            tags.push(tag);
            // p0 bottom-left, p1 bottom-right, p2 top-right, p3 top-left; uvr = [u0,v0,u1,v1].
            const base = pos.length / 3;
            [p0, p1, p2, p3].forEach(p => pos.push(p[0], p[1], p[2]));
            for (let i = 0; i < 4; i += 1) nor.push(n[0], n[1], n[2]);
            uv.push(uvr[0], uvr[1], uvr[2], uvr[1], uvr[2], uvr[3], uvr[0], uvr[3]);
            for (let i = 0; i < 4; i += 1) info.push(inf[0], inf[1], inf[2], inf[3]);
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        // An oriented box: centre c, unit axes r (right), u (up), f (front), half sizes.
        const box = (c, r, u, f, hw, hh, hd, faceUv, sideUv, inf, faces = 'all') => {
            const P = (sx, sy, sz) => add(add(add(c, r, sx * hw), u, sy * hh), f, sz * hd);
            const mf = scale(f, -1), mr = scale(r, -1), mu = scale(u, -1);
            if (faces === 'all' || faces.includes('front')) quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), f, faceUv, inf);
            if (faces === 'all' || faces.includes('back')) quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), mf, faces.includes('backFace') ? faceUv : sideUv, inf);
            quad(P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), r, sideUv, inf);
            quad(P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), mr, sideUv, inf);
            quad(P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1), u, sideUv, inf);
            quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), mu, sideUv, inf);
        };
        // A thin bar between two points (for brackets, truss, conduits).
        const bar = (a, b, t, sideUv, inf) => {
            const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const len = Math.hypot(d[0], d[1], d[2]) || 1e-3;
            const f = norm(d);
            const helper = Math.abs(f[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
            const r = norm(cross(helper, f)), u = cross(f, r);
            box([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], r, u, f, t / 2, t / 2, len / 2, sideUv, sideUv, inf, ['front', 'back']);
        };
        const geometry = T => {
            const g = new T.BufferGeometry();
            g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
            g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
            g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
            g.setAttribute('info', new T.Float32BufferAttribute(info, 4));
            g.setIndex(idx);
            g.computeBoundingSphere();
            g.userData.tags = tags.slice(); g.userData.fullIndex = idx.slice();
            return g;
        };
        return { quad, box, bar, geometry, setTag(t) { tag = t; }, get triangles() { return idx.length / 3; } };
    };

    // ---------- shaders -----------------------------------------------------

    const FOG_V = '#include <fog_pars_vertex>';
    const HARDWARE_VS = `
        attribute vec4 info;varying vec2 vUv;varying vec3 vN,vW;varying float vSelf;
        ${FOG_V}
        void main(){vUv=uv;vN=normalize(mat3(modelMatrix)*normal);
            vec4 w=modelMatrix*vec4(position,1.0);vW=w.xyz;vSelf=info.z;
            vec4 mvPosition=viewMatrix*w;gl_Position=projectionMatrix*mvPosition;
            #include <fog_vertex>
        }`;
    const hardwareFs = shared => `
        uniform sampler2D baseMap;uniform vec3 ambient,keyColor,keyDir,skyColor;uniform float wet;
        varying vec2 vUv;varying vec3 vN,vW;varying float vSelf;
        ${shared ? shared.GLSL_COMMON + shared.GLSL_LIGHTS : ''}
        #include <fog_pars_fragment>
        void main(){vec3 base=texture2D(baseMap,vUv).rgb;base=base*base;
            vec3 n=normalize(vN);vec3 v=normalize(cameraPosition-vW);
            ${shared ? `vec3 lit=kwLight(vW,n,base,0.6);float wetness=uWet;vec3 sky=uSky;`
                : `float key=max(dot(n,normalize(keyDir)),0.0);float up=n.y*0.5+0.5;
            vec3 lit=base*(ambient*(0.55+0.45*up)+keyColor*key);float wetness=wet;vec3 sky=skyColor;`}
            // Wet steel: a soft sheen of the sky's glow at grazing angles.
            float f=pow(max(1.0-max(dot(n,v),0.0),0.0),4.0);
            vec3 col=lit+(sky*0.5+skyColor*0.5)*f*wetness*0.12;
            gl_FragColor=vec4(col,1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            #include <fog_fragment>
        }`;
    const GLOW_VS = `
        attribute vec4 info;uniform vec4 levels[64];varying vec2 vUv;varying float vLevel,vGain;varying vec2 vSign;
        ${FOG_V}
        void main(){vUv=uv;int i=int(info.x+0.5);vLevel=levels[i/4][i-(i/4)*4];vGain=info.y;vSign=info.xw;
            vec4 mvPosition=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mvPosition;
            #include <fog_vertex>
        }`;
    const GLOW_FS = `
        uniform sampler2D emitMap,maskMap;uniform vec4 tubes[4];uniform float time,chase,halo,atlasSize;
        varying vec2 vUv;varying float vLevel,vGain;varying vec2 vSign;
        #include <fog_pars_fragment>
        void main(){vec3 e=texture2D(emitMap,vUv).rgb;e*=e;
            vec2 m=texture2D(maskMap,vUv).rg*255.0;float k=vLevel;
            if(m.x>240.0){k*=step(0.5,fract(m.y/255.0+chase));}
            else if(m.x>0.5){int t=int(m.x+0.5)-1;k*=tubes[t/4][t-(t/4)*4];}
            // Halo is the soft part of the light layer; the energy tier, with no
            // bloom pass, leans on it harder.
            float soft=1.0-smoothstep(0.15,0.5,max(e.r,max(e.g,e.b)));
            vec3 col=e*k*vGain*(1.0+soft*halo);
            // Far off, a tube is thinner than a pixel and the mip average is mostly
            // black board; lift it so a distant sign still reads as lit.
            float cover=max(fwidth(vUv.x),fwidth(vUv.y))*atlasSize;
            col*=1.0+clamp(log2(max(cover,1.0))*0.55,0.0,2.2);
            gl_FragColor=vec4(col,1.0);
            #ifdef USE_FOG
            #ifdef FOG_EXP2
            float fogFactor=1.0-exp(-fogDensity*fogDensity*vFogDepth*vFogDepth);
            #else
            float fogFactor=smoothstep(fogNear,fogFar,vFogDepth);
            #endif
            gl_FragColor.rgb*=1.0-fogFactor*0.85;
            #endif
        }`;
    // Screens: role 0 main lyric, 1 tall lyric, 2 ticker, 3 advert.
    const SCREEN_VS = `
        attribute vec4 info;attribute vec4 region;varying vec2 vUv,vLocal;varying vec4 vInfo,vRegion;varying vec3 vW,vN;
        ${FOG_V}
        void main(){vLocal=uv;vInfo=info;vRegion=region;vUv=region.xy+uv*region.zw;
            vN=normalize(mat3(modelMatrix)*normal);vec4 w=modelMatrix*vec4(position,1.0);vW=w.xyz;
            vec4 mvPosition=viewMatrix*w;gl_Position=projectionMatrix*mvPosition;
            #include <fog_vertex>
        }`;
    const SCREEN_FS = `
        uniform sampler2D lyricMap,adMap;uniform vec3 sung,rest,trans,amber,deep;
        uniform float time,level,progress,vprogress,age,idle,ticker,tickerSpan,beat,energy,grid,subpixel,wet,rain;
        uniform vec3 sky;
        varying vec2 vUv,vLocal;varying vec4 vInfo,vRegion;varying vec3 vW,vN;
        #include <fog_pars_fragment>
        float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        void main(){
            float role=vInfo.x;vec2 cells=vInfo.yz;float seed=vInfo.w;
            vec2 cell0=vLocal*cells;
            float aa0=fwidth(cell0.x);
            float near0=1.0-smoothstep(0.3,0.7,aa0);
            // Rain on the cover glass: beads, and a few drops running down that
            // wipe a trail. Each bends the lamps behind it like a small lens.
            float wetG=clamp(wet,0.0,1.0)*(1.0-smoothstep(0.35,0.9,aa0));
            vec2 dc=cell0/4.0;vec2 di=floor(dc);vec2 df=fract(dc)-0.5;
            float runs=step(h(vec2(di.x,seed+2.0)),0.28);
            float head=fract(h(vec2(di.x,seed+1.0))-time*(0.02+0.05*h(vec2(di.x,seed+4.0))))*cells.y/4.0;
            float rx=(h(vec2(di.x,seed+6.0))-0.5)*0.35;
            float above=dc.y-head;
            float trail=runs*step(0.0,above)*step(above,4.0+6.0*h(vec2(di.x,seed+8.0)));
            vec2 off=vec2(h(di+3.1+seed),h(di+5.7+seed))-0.5;
            float rad=mix(0.16,0.34,h(di+9.3+seed))*step(h(di+seed*7.0),0.2+0.2*rain)*(1.0-trail);
            vec2 dv=df-off*0.45;float bead=smoothstep(rad,rad*0.75,length(dv*vec2(1.0,0.85)))*step(0.01,rad);
            vec2 rv=vec2(df.x-rx,above*0.5);float runner=runs*smoothstep(0.3,0.24,length(rv*vec2(1.0,0.75)));
            float streak=trail*smoothstep(0.07,0.02,abs(df.x-rx))*0.5;
            vec2 dn=runner>bead?rv/0.3:dv/max(rad,0.01);
            float lens=max(bead,runner)*wetG;
            vec2 cell=cell0-dn*lens*1.6+vec2(streak*wetG*0.6,0.0);
            vec2 id=floor(cell);vec2 f=fract(cell)-0.5;
            // The picture is sampled once per LED: the board is a grid of lamps.
            vec2 luv=(id+0.5)/cells;
            // Line change: torn rows, colour split, a wipe from the left.
            float g=role<1.5?clamp(1.0-age/0.5,0.0,1.0):0.0;
            float row=floor(luv.y*cells.y/6.0);
            float tear=g*(h(vec2(row,floor(time*24.0)))-0.5)*0.12*step(0.55,h(vec2(row*1.7,floor(time*12.0))));
            vec2 suv=luv+vec2(tear,0.0);
            vec3 col=vec3(0.0);
            if(role<1.5){
                vec2 ruv=vRegion.xy+clamp(suv,0.0,1.0)*vRegion.zw;
                vec4 t=texture2D(lyricMap,ruv);
                float split=g*0.006;
                float tr=texture2D(lyricMap,ruv+vec2(split,0.0)).r,tb=texture2D(lyricMap,ruv-vec2(split,0.0)).r;
                float p=role<0.5?progress:vprogress;
                float done=step(t.g,p-0.0001)*step(0.002,t.g+t.r*0.0);
                float near=smoothstep(0.06,0.0,abs(t.g-p))*step(0.001,p);
                vec3 ink=mix(rest,sung,max(done,idle))+sung*near*0.25;
                col=ink*t.r+trans*t.b;
                col.r+=(tr-t.r)*g*1.5;col.b+=(tb-t.r)*g*1.5;
                // Signal switch: a band of snow rolls through with the tear.
                float band=smoothstep(0.12,0.0,abs(fract(luv.y*1.3-age*3.0)-0.5)-0.3);
                col+=vec3(h(id+floor(time*30.0)))*band*g*0.5;
                float wipe=age/0.45;float front=luv.x-wipe;
                col*=step(front,0.0);col+=sung*smoothstep(0.03,0.0,abs(front))*step(age,0.45)*1.4;
                // Behind the words: a dim drifting wash; in breaks, a slow scan graphic.
                vec2 q=luv-0.5;
                float sweep=0.5+0.5*sin(q.x*5.0+q.y*2.0-time*0.6+seed);
                vec3 bg=deep*(0.05+0.08*sweep)*(1.0+energy*0.8)*(0.15+0.85*idle);
                float rr=length(q*vec2(1.8,1.0));
                float rings=smoothstep(0.08,0.0,abs(fract(rr*4.0-time*0.18)-0.5)-0.4);
                float bars=step(0.5,fract(q.y*cells.y/8.0))*smoothstep(0.35,0.0,abs(fract(q.x*0.5+time*0.05)-0.5));
                bg+=sung*(rings*0.04+bars*0.025)*idle*step(0.001,idle-0.02);
                col+=bg*(1.0-t.r);
            }else if(role<2.5){
                vec2 ruv=vRegion.xy+vec2(fract(suv.x*tickerSpan+ticker),suv.y)*vRegion.zw;
                col=amber*texture2D(lyricMap,ruv).r*1.6+amber*0.03;
            }else{
                // Adverts: hold, then a blocky dissolve to the next slide.
                float slides=4.0;float tt=time/7.0+seed*3.1;float s=floor(tt);float ph=fract(tt);
                float blk=h(floor(luv*vec2(12.0,6.0))+s);
                float pickNext=step(blk,smoothstep(0.85,1.0,ph));
                float slide=mod(s+pickNext+floor(seed*5.0),slides);
                vec2 a=vec2(mod(slide,2.0),floor(slide/2.0));
                vec2 auv=vRegion.xy+(a+luv)*vRegion.zw;
                col=texture2D(adMap,auv).rgb;col*=col;col*=1.3;
                col*=0.85+0.15*sin(luv.y*cells.y*0.5-time*30.0);
            }
            // The lamp itself: round, with RGB sub-pixels up close.
            float d=length(f);
            float aa=fwidth(cell.x);
            float lamp=mix(smoothstep(0.46,0.3,d)*1.9,1.0,smoothstep(0.25,0.7,aa*grid));
            vec3 sub=vec3(step(-0.5,f.x)*step(f.x,-0.17),step(-0.17,f.x)*step(f.x,0.17),step(0.17,f.x));
            sub=mix(vec3(1.0),sub*3.0,subpixel*(1.0-smoothstep(0.08,0.3,aa)));
            col*=lamp*sub;
            col+=vec3(0.006,0.007,0.01)*(1.0-lamp*0.5);
            // The board is built from 16x16 modules, each a touch off in
            // brightness and tint, with thin seams; a few lamps are dead or stuck.
            vec2 mid=floor(id/16.0);
            col*=mix(vec3(1.0),(0.93+0.1*h(mid+seed))*(1.0+(vec3(h(mid+1.3),h(mid+2.7),h(mid+4.1))-0.5)*0.07),step(role,1.5));
            vec2 mf=fract(cell/16.0);vec2 me=min(mf,1.0-mf)*16.0;
            col*=1.0-0.75*smoothstep(0.14,0.04,min(me.x,me.y))*near0;
            float dp=h(id*1.37+seed);
            col*=mix(1.0,step(0.0025,dp),near0);
            col=mix(col,max(col,vec3(0.5,0.05,0.02)*step(dp,0.0035)*step(0.0025,dp)),near0);
            // Interlaced rows and the darker band a camera catches on an LED board.
            col*=1.0-0.06*mod(id.y+floor(time*30.0),2.0)*near0*step(role,1.5);
            col*=1.0-0.18*smoothstep(0.1,0.0,abs(fract(vLocal.y*0.7-time*0.23)-0.5)-0.38);
            // A refresh band rolls down the big boards.
            col*=1.0+0.08*smoothstep(0.02,0.0,abs(fract(vLocal.y+time*0.31)-0.5)-0.47)*step(role,1.5);
            col*=level;
            // Drops: dark rims, a bright fleck of the sky on top, a lit run trail.
            float rimD=smoothstep(0.55,1.0,length(dn))*lens;
            col*=1.0-0.55*rimD;
            vec2 sp=dn-vec2(-0.3,0.45);
            col+=(sky*0.8+vec3(0.12)+col*0.6)*smoothstep(0.26,0.06,length(sp))*lens*0.45;
            col+=sky*streak*wetG*0.25;
            // Cover glass: Fresnel reflection of the night sky, wetter = glossier.
            vec3 n=normalize(vN);vec3 v=normalize(cameraPosition-vW);
            float fr=0.03+0.97*pow(1.0-max(dot(n,v),0.0),5.0);
            float sheen=0.6+0.4*smoothstep(0.2,0.9,vLocal.y+vLocal.x*0.3);
            col+=sky*fr*(0.35+0.5*wet)*sheen;
            // Steel lip around the glass: catches spill from the lamps and the rain.
            vec2 eg=min(cell0,cells-cell0);float e=min(eg.x,eg.y);
            float lip=smoothstep(0.85,0.7,e)*near0;
            float top=smoothstep(0.85,0.7,cells.y-cell0.y);
            float glint=step(0.965,h(floor(cell0*vec2(1.0,1.0))+floor(time*7.0+h(floor(cell0))*7.0)))*wet;
            float bead2=smoothstep(0.35,0.1,length(vec2(fract(cell0.x*0.5)-0.5,(cell0.y-0.35)*1.4)))*step(cell0.y,0.85);
            vec3 metal=vec3(0.015)+sky*(0.2+0.6*top)*(0.3+0.7*wet)+sung*level*0.05*(1.0-top)
                +(sky+vec3(0.6))*glint*0.8+(sky*0.8+sung*0.15)*bead2*wet*0.8;
            col=mix(col,metal,lip);
            gl_FragColor=vec4(col,1.0);
            #ifdef USE_FOG
            #ifdef FOG_EXP2
            float fogFactor=1.0-exp(-fogDensity*fogDensity*vFogDepth*vFogDepth);
            #else
            float fogFactor=smoothstep(fogNear,fogFar,vFogDepth);
            #endif
            gl_FragColor.rgb=mix(gl_FragColor.rgb,fogColor*0.3,fogFactor*0.6);
            #endif
        }`;

    // ---------- lyric canvas -------------------------------------------------
    // Masks only: R = glyphs, G = sung order (0..1 across the line), B = the
    // translation. The screens colour them.
    const LYRIC_W = 2048, LYRIC_H = 1024;
    const REGIONS = {
        main: { x: 0, y: 0, w: 1536, h: 854 },
        tall: { x: 1536, y: 0, w: 512, h: 896 },
        ticker: { x: 0, y: 900, w: 2048, h: 112 }
    };
    const regionUv = r => [r.x / LYRIC_W, 1 - (r.y + r.h) / LYRIC_H, r.w / LYRIC_W, r.h / LYRIC_H];

    // Split a line's words over rows without breaking a word.
    const layoutRows = (g, words, font, maxW, maxRows) => {
        g.font = font;
        const space = g.measureText(' ').width;
        const rows = [[]];
        let w = 0;
        words.forEach((word, i) => {
            const text = word.text;
            const ww = g.measureText(text).width;
            const lead = w > 0 && !isWide(text[0] || '') && !isWide(words[i - 1]?.text?.slice(-1) || '') ? space : 0;
            if (w > 0 && w + lead + ww > maxW && rows.length < maxRows) { rows.push([]); w = 0; }
            const cur = rows[rows.length - 1];
            const gap = w > 0 && !isWide(text[0] || '') && !isWide(words[i - 1]?.text?.slice(-1) || '') ? space : 0;
            cur.push({ i, text, x: w + gap, w: ww });
            w += gap + ww;
            cur.width = w;
        });
        return rows;
    };

    const wordsOf = lyric => {
        if (Array.isArray(lyric?.words) && lyric.words.length) return lyric.words.map(w => ({ text: String(w.text ?? '') })).filter(w => w.text.length);
        const line = lyric?.line;
        const text = typeof line === 'string' ? line : String(line?.text ?? line?.fullText ?? '');
        return graphemes(text).map(ch => ({ text: ch }));
    };
    const lineText = lyric => {
        const line = lyric?.line;
        if (!line) return '';
        if (typeof line === 'string') return line;
        return String(line.text ?? line.fullText ?? line.original ?? wordsOf(lyric).map(w => w.text).join(''));
    };

    // The canvas is half the layout's size: the boards have fewer lamps than that.
    const LYRIC_SCALE = 0.5;
    const paintLyric = (g, lyric, song, big = false) => {
        g.save();
        g.setTransform(LYRIC_SCALE, 0, 0, LYRIC_SCALE, 0, 0);
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = '#000'; g.fillRect(0, 0, LYRIC_W, LYRIC_H);
        g.globalCompositeOperation = 'lighter';
        g.textBaseline = 'middle';
        const words = lyric?.line ? wordsOf(lyric) : [];
        const n = Math.max(1, words.length);
        const main = REGIONS.main;
        // Seen small from far off (the sandbox view), the line alone, as big and heavy as fits.
        const translation = big ? '' : String(lyric?.translation || '').trim();
        const transH = translation ? 120 : 0;
        // Main board: biggest size that fits in at most three rows.
        if (words.length) {
            let px = 300, rows;
            const maxW = main.w * 0.9;
            for (; px > 70; px -= 10) {
                rows = layoutRows(g, words, `900 ${px}px ${FONTS.lyric}`, maxW, 3);
                const tooWide = rows.some(r => r.width > maxW);
                if (!tooWide && rows.length * px * 1.18 <= main.h - transH - (big ? 20 : 60)) break;
            }
            g.font = `900 ${px}px ${FONTS.lyric}`;
            const lineH = px * 1.18;
            const top = main.y + (main.h - transH - rows.length * lineH) / 2 + lineH / 2;
            rows.forEach((row, ri) => {
                const x0 = main.x + (main.w - row.width) / 2;
                const y = top + ri * lineH;
                row.forEach(cell => {
                    // Sung order: a ramp across the word's own cell.
                    const g0 = cell.i / n, g1 = (cell.i + 1) / n;
                    const ramp = g.createLinearGradient(x0 + cell.x, 0, x0 + cell.x + cell.w, 0);
                    ramp.addColorStop(0, `rgb(0,${Math.round(g0 * 255)},0)`);
                    ramp.addColorStop(1, `rgb(0,${Math.round(g1 * 255)},0)`);
                    g.fillStyle = ramp;
                    g.fillRect(Math.round(x0 + cell.x), y - lineH / 2, Math.max(1, Math.round(x0 + cell.x + cell.w) - Math.round(x0 + cell.x)), lineH);
                    g.fillStyle = '#ff0000';
                    g.fillText(cell.text, x0 + cell.x, y);
                    if (big) { g.strokeStyle = '#ff0000'; g.lineWidth = px * 0.04; g.lineJoin = 'round'; g.strokeText(cell.text, x0 + cell.x, y); }
                });
            });
            if (translation) {
                let tp = 72;
                g.font = `600 ${tp}px ${FONTS.lyric}`;
                const tw = g.measureText(translation).width;
                if (tw > maxW) { tp = Math.max(30, tp * maxW / tw); g.font = `600 ${tp}px ${FONTS.lyric}`; }
                g.fillStyle = '#0000ff'; g.textAlign = 'center';
                g.fillText(translation, main.x + main.w / 2, main.y + main.h - transH / 2 - 30, maxW);
                g.textAlign = 'left';
            }
        } else {
            // A break: the title card.
            const title = String(song?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '') || '九龍';
            const artist = String(song?.artist || '');
            let px = 180;
            g.font = `900 ${px}px ${FONTS.lyric}`;
            const tw = g.measureText(title).width;
            if (tw > main.w * 0.85) { px = Math.max(60, px * main.w * 0.85 / tw); g.font = `900 ${px}px ${FONTS.lyric}`; }
            g.textAlign = 'center'; g.fillStyle = '#ff0000';
            g.fillText(title, main.x + main.w / 2, main.y + main.h * 0.44);
            if (artist) { g.font = `600 70px ${FONTS.lyric}`; g.fillStyle = '#0000ff'; g.fillText(artist, main.x + main.w / 2, main.y + main.h * 0.7, main.w * 0.8); }
            g.textAlign = 'left';
        }
        // Tall board: the same line set down the column.
        const tall = REGIONS.tall;
        const glyphs = [];
        words.forEach((w, wi) => graphemes(w.text).forEach((ch, ci, all) => glyphs.push({ ch, wi, frac0: ci / all.length, frac1: (ci + 1) / all.length })));
        const vis = glyphs.filter(x => x.ch.trim());
        if (vis.length) {
            const latin = vis.filter(x => !isWide(x.ch)).length > vis.length * 0.5;
            if (latin) {
                // Latin runs read sideways, as on a tall shop sign.
                g.save();
                g.translate(tall.x + tall.w / 2, tall.y + tall.h / 2); g.rotate(Math.PI / 2);
                let px = 150; const text = words.map(w => w.text).join(' ');
                g.font = `900 ${px}px ${FONTS.lyric}`;
                const tw = g.measureText(text).width;
                if (tw > tall.h * 0.92) { px = Math.max(40, px * tall.h * 0.92 / tw); g.font = `900 ${px}px ${FONTS.lyric}`; }
                const total = g.measureText(text).width;
                let x = -total / 2;
                words.forEach((w, wi) => {
                    const ww = g.measureText(w.text).width;
                    const ramp = g.createLinearGradient(x, 0, x + ww, 0);
                    ramp.addColorStop(0, `rgb(0,${Math.round(wi / n * 255)},0)`); ramp.addColorStop(1, `rgb(0,${Math.round((wi + 1) / n * 255)},0)`);
                    g.fillStyle = ramp; g.fillRect(Math.round(x), -px * 0.6, Math.round(ww + g.measureText(' ').width), px * 1.2);
                    g.fillStyle = '#ff0000'; g.fillText(w.text, x, 0);
                    x += ww + g.measureText(' ').width;
                });
                g.restore();
            } else {
                const cols = vis.length > 9 ? 2 : 1;
                const per = Math.ceil(vis.length / cols);
                const step = Math.min(tall.h * 0.92 / per, tall.w * 0.86 / cols);
                g.font = `900 ${Math.floor(step * 0.9)}px ${FONTS.lyric}`;
                g.textAlign = 'center';
                vis.forEach((x, k) => {
                    const c = Math.floor(k / per), r = k % per;
                    // Read right to left across columns, top to bottom down each.
                    const cx = tall.x + tall.w / 2 + (cols === 2 ? (c === 0 ? step * 0.55 : -step * 0.55) : 0);
                    const cy = tall.y + (tall.h - per * step) / 2 + (r + 0.5) * step;
                    const g0 = (x.wi + x.frac0) / n, g1 = (x.wi + x.frac1) / n;
                    const ramp = g.createLinearGradient(0, cy - step / 2, 0, cy + step / 2);
                    ramp.addColorStop(0, `rgb(0,${Math.round(g0 * 255)},0)`); ramp.addColorStop(1, `rgb(0,${Math.round(g1 * 255)},0)`);
                    g.fillStyle = ramp; g.fillRect(Math.round(cx - step / 2), Math.round(cy - step / 2), Math.round(step), Math.round(step));
                    g.fillStyle = '#ff0000'; g.fillText(x.ch, cx, cy);
                });
                g.textAlign = 'left';
            }
        }
        // Ticker: the translation, else the next line, else the song.
        const tk = REGIONS.ticker;
        const next = String(lyric?.next?.text || '').trim();
        const tickerText = words.length && (next || translation) ? [next && `NEXT ▸ ${next}`, translation && `◆ ${translation}`].filter(Boolean).join('   ') : `♪ ${String(song?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '')}${song?.artist ? ' — ' + song.artist : ''}   ◆   九龍城寨   ◆   通宵營業`;
        g.font = `700 ${tk.h * 0.8}px ${FONTS.lyric}`;
        g.fillStyle = '#ff0000';
        const tw = g.measureText(tickerText + '      ').width;
        const span = Math.max(1, Math.ceil(tk.w / tw));
        for (let i = 0; i < span; i += 1) g.fillText(tickerText, tk.x + i * tw, tk.y + tk.h / 2, tw);
        g.restore();
        return { glyphCount: n };
    };

    // Where a sign will stand, as a world box (with its bracket), for clash tests.
    const bladeSide = slot => ((Number(slot.col) || 0) + (Number(slot.floor) || 0)) % 2 ? 1 : -1;
    const boxOf = spec => {
        const slot = spec.slot;
        const n = norm(vec(slot.normal || [0, 0, 1])), t = norm(vec(slot.tangent || cross([0, 1, 0], n)));
        let p = vec(slot.pos);
        let ht, hn, hu = spec.height / 2;
        if (spec.kind === 'blade') {
            p = add(add(p, t, (Number(slot.width) || 2.05) / 2 * bladeSide(slot)), n, (0.35 + spec.width) / 2);
            p[1] += spec.rise || 0;
            ht = 0.25; hn = (0.35 + spec.width) / 2;
        } else if (spec.kind === 'roof') {
            p = add(p, n, -1.2); p[1] += spec.lift + spec.height / 2;
            ht = spec.width / 2; hn = 1.4; hu = spec.height / 2 + spec.lift / 2;
        } else {
            if (slot.kind === 'shop') p[1] = Math.max(p[1], 2.9 + spec.height / 2);
            p = add(p, n, 0.3); ht = spec.width / 2; hn = 0.35;
        }
        const ext = k => Math.abs(t[k]) * ht + Math.abs(n[k]) * hn + (k === 1 ? hu : 0);
        return { min: [p[0] - ext(0), p[1] - ext(1), p[2] - ext(2)], max: [p[0] + ext(0), p[1] + ext(1), p[2] + ext(2)] };
    };
    const overlaps = (a, b, pad = 0.12) => [0, 1, 2].every(k => a.min[k] < b.max[k] + pad && b.min[k] < a.max[k] + pad);

    // ---------- choosing slots ------------------------------------------------
    // The layout offers thousands of places a sign could hang. Take the ones the
    // cameras see: the street faces first (low floors densest, a few up high),
    // the main alleys next, little elsewhere; keep them from crowding.
    // The gate into the main alley and the market under it: no signs there.
    const gateOf = layout => layout.GATE || { x: -14, z: 61.2, width: 7.2, height: 8.2, keepOut: { x0: -28, x1: -1, z0: 50, z1: 64, y1: 9 } };
    const inGate = (layout, p, above = 0) => {
        const k = gateOf(layout).keepOut;
        return !!k && p[0] > k.x0 && p[0] < k.x1 && p[2] > k.z0 && p[2] < k.z1 && p[1] < k.y1 + above;
    };
    // The space in front of the main lyric screen stays empty: nothing may stand
    // between it and the cameras that look at it, from any side.
    const screenKeep = layout => {
        const sc = (layout.SCREENS || []).find(s => s.primary);
        if (!sc) return null;
        const w = Number(sc.size?.[0] ?? sc.width ?? 18), h = Number(sc.size?.[1] ?? sc.height ?? 10), c = sc.center;
        return { min: [c[0] - w / 2 - 4, c[1] - h / 2 - 9, c[2] - 0.3], max: [c[0] + w / 2 + 4, c[1] + h / 2 + 5, c[2] + 40] };
    };
    const chooseSlots = (layout, max, random, hot = []) => {
        const all = [];
        (layout.facades || []).forEach(facade => (facade.slots || []).forEach(slot => {
            if (slot.use !== 'sign') return;
            const fk = String(facade.kind || slot.facadeKind || '');
            const street = fk === 'street' || fk === '';
            const alley = /^alley:(A|B)$/.test(fk) ? 2 : /^alley/.test(fk) ? 1 : 0;
            const floor = Number(slot.floor) || 0;
            const alleyId = /^alley:(.+)$/.exec(fk)?.[1];
            const alleyW = alleyId ? (layout.ALLEYS || []).find(a => a.id === alleyId)?.w || 2 : 0;
            // Alleys are roofed over above the third floor: their signs hang low.
            if (alleyId && floor > 2) return;
            if (inGate(layout, vec(slot.pos), 1.5)) return;
            const nrm = vec(slot.normal || facade.normal);
            // The cameras mostly look at the south and east faces.
            const facing = nrm[2] > 0.5 ? 1.7 : nrm[0] > 0.5 ? 1.35 : 0.45;
            let score = street ? 3 * facing : alley === 2 ? 2.2 : alley ? 1.1 : 0.25;
            if (slot.kind === 'roof') score = (street ? 3.2 : 1.6) * facing;
            else if (street) score *= floor <= 1 ? 1.1 : floor <= 9 ? 1 : 0.7;
            else score *= floor <= 1 ? 1.25 : floor <= 5 ? 1 : floor <= 9 ? 0.55 : 0.3;
            score *= 0.6 + random() * 0.8;
            if (alleyId && slot.kind === 'blade') score *= 1.4;
            // Where the walking cameras pass, the alley should be thick with signs.
            const p = vec(slot.pos);
            const near = alleyId && hot.some(h => Math.hypot(h[0] - p[0], h[2] - p[2]) < 20);
            if (near) score *= 3;
            all.push({ slot: { ...slot, _street: street, _alley: alley, _alleyW: alleyW, _hot: near }, score });
        }));
        all.sort((a, b) => b.score - a.score);
        // Shares: the south street face, the east one, the two main alleys, the rest.
        const bucket = x => {
            const n = vec(x.slot.normal);
            // Rooftop billboards across the whole roofscape, facing the high camera.
            if (x.slot.kind === 'roof') return 4;
            if (x.slot._hot) return 5;
            if (x.slot._street) return n[2] > 0.5 ? 0 : n[0] > 0.5 ? 1 : 3;
            return x.slot._alley === 2 ? 2 : 3;
        };
        const quota = (hot.length ? [0.27, 0.13, 0.12, 0.05, 0.12, 0.31] : [0.36, 0.17, 0.24, 0.09, 0.14, 0]).map(q => Math.round(q * max));
        const picked = [];
        // Round the main screen the street signs keep further apart, so each reads.
        const screens = layout.SCREENS || [];
        const nearScreen = s => screens.some(sc => sc.primary && Math.hypot(vec(s.pos)[0] - sc.center[0], (vec(s.pos)[1] - sc.center[1]) * 0.7) < 26 && Math.abs(vec(s.pos)[2] - sc.center[2]) < 3);
        const minGap = s => s.kind === 'roof' ? 11 : s._street ? (nearScreen(s) ? 5.2 : 2.7) : 2.6;
        const taken = [0, 0, 0, 0, 0, 0];
        const tryTake = (slot, b) => {
            const p = vec(slot.pos);
            const gap = minGap(slot);
            if (picked.some(q => { const o = vec(q.pos); return Math.hypot(o[0] - p[0], (o[1] - p[1]) * 0.8, o[2] - p[2]) < Math.max(gap, minGap(q)); })) return;
            picked.push(slot); taken[b] += 1;
        };
        for (const x of all) { const b = bucket(x); if (taken[b] < quota[b] && picked.length < max) tryTake(x.slot, b); }
        // Fill what a share could not use with the best of the rest.
        for (const x of all) { if (picked.length >= max) break; if (!picked.includes(x.slot)) tryTake(x.slot, bucket(x)); }
        return picked;
    };

    // Hologram banners hang in the air off the street faces and stand on masts
    // above the roofs. Kept apart, clear of the main screen, high enough that
    // the street keeps its own light.
    const chooseHoloAds = (layout, count, random) => {
        const screens = (layout.SCREENS || []).filter(sc => sc.primary);
        const face = [], roof = [];
        (layout.facades || []).forEach(facade => (facade.slots || []).forEach(slot => {
            const fk = String(facade.kind || slot.facadeKind || '');
            if (fk !== 'street' && fk !== '') return;
            const n = vec(slot.normal || facade.normal);
            if (!(n[2] > 0.5 || n[0] > 0.5)) return;
            const floor = Number(slot.floor) || 0;
            const p = vec(slot.pos);
            if (screens.some(sc => Math.hypot(p[0] - sc.center[0], p[1] - sc.center[1], p[2] - sc.center[2]) < 24)) return;
            if (inGate(layout, p, 16)) return;
            if (slot.kind === 'roof' && slot.use === 'sign') roof.push({ slot, n, p, score: random() * (n[2] > 0.5 ? 1.3 : 1) });
            else if (floor >= 4 && floor <= 12 && (slot.use === 'sign' || slot.use === 'free')) face.push({ slot, n, p, score: random() * (n[2] > 0.5 ? 1.25 : 1) });
        }));
        const picked = [];
        const far = (p, gap) => picked.every(q => Math.hypot(q.p[0] - p[0], (q.p[1] - p[1]) * 0.5, q.p[2] - p[2]) > gap);
        const nRoof = Math.round(count * 0.35);
        roof.sort((a, b) => b.score - a.score).forEach(x => { if (picked.length < nRoof && far(x.p, 34)) picked.push({ ...x, roof: true }); });
        face.sort((a, b) => b.score - a.score).forEach(x => { if (picked.length < count && far(x.p, 20)) picked.push({ ...x, roof: false }); });
        const keep = screenKeep(layout);
        const clear = a => {
            if (!keep) return true;
            const lo = a.bottom - (a.roof ? 4.8 : 3.4), hi = a.bottom + a.height, e = a.width / 2 + 0.5;
            const box = { min: [a.centre[0] - e, lo, a.centre[2] - e], max: [a.centre[0] + e, hi, a.centre[2] + e] };
            const foot = { min: [Math.min(a.foot[0], a.centre[0]) - 0.5, lo, Math.min(a.foot[2], a.centre[2]) - 0.5], max: [Math.max(a.foot[0], a.centre[0]) + 0.5, lo + 1, Math.max(a.foot[2], a.centre[2]) + 0.5] };
            return !overlaps(box, keep, 0) && !overlaps(foot, keep, 0);
        };
        return picked.map((x, i) => {
            const r0 = norm(cross([0, 1, 0], x.n));
            if (x.roof) {
                const width = 7 + random() * 5, height = width * (3.4 + random() * 1.1);
                const bottom = x.p[1] + 5 + random() * 6;
                return { roof: true, foot: x.p, normal: x.n, right: r0, centre: [x.p[0], bottom + height / 2, x.p[2]], width, height, bottom, copy: i, seed: random() };
            }
            const width = 4 + random() * 2.6, height = width * (3.6 + random() * 1.0);
            const bottom = Math.max(7, x.p[1] - height * (0.25 + random() * 0.2));
            // Half stand out square from the wall like blades, half float flat in front of it.
            const blade = random() < 0.5;
            const normal = blade ? r0 : x.n;
            const out = blade ? width / 2 + 1.6 : 4.5 + random() * 1.5;
            const base = add(x.p, x.n, out);
            return { roof: false, blade, foot: x.p, wall: x.n, normal, right: norm(cross([0, 1, 0], normal)), centre: [base[0], bottom + height / 2, base[2]], width, height, bottom, copy: i, seed: random() };
        }).filter(clear);
    };

    // ---------- the module ---------------------------------------------------

    const create = (T, ctx = {}) => {
        const scene = ctx.scene;
        const layout = ctx.layout || {};
        let tier = ctx.tier || { name: 'standard', lens: true, samples: 0 };
        let options = { flicker: true, ...(ctx.options || {}) };
        const seed = layout.seed ?? ctx.seed ?? 'kowloon';
        const random = rngFor(ctx, `kowloon:signs:${seed}`);
        const disposables = [];
        const group = new T.Group();
        group.name = 'KowloonSigns';
        scene?.add(group);

        // --- slots → specs
        const pools = { vertical: VERTICAL_SHOPS.slice(), horizontal: HORIZONTAL_SHOPS.slice(), roof: ROOF_BRANDS.slice() };
        const MAX_SIGNS = (tier.name === 'energy-saving' ? 140 : 256);
        const rigs = (ctx.alley?.cameraRigs?.() || ctx.cameraRigs || []);
        const hot = rigs.filter(r => /^alley|^street-enter/.test(r.id) && r.id !== 'alley-rise').flatMap(r => r.points || []);
        const chosen = chooseSlots(layout, MAX_SIGNS + 8, random, hot);
        // A few of the street's flat places carry small advert screens instead.
        const adScreens = [];
        for (let i = chosen.length - 1; i >= 0 && adScreens.length < 8; i -= 1) {
            const slot = chosen[i];
            if (!slot._street || slot.kind !== 'flat' || (Number(slot.floor) || 0) < 2) continue;
            chosen.splice(i, 1);
            const w = 3.2 + random() * 2.2, h = w * (0.5 + random() * 0.15);
            adScreens.push({ id: `ad${adScreens.length}`, center: add(vec(slot.pos), vec(slot.normal), 0.5), normal: slot.normal, size: [w, h] });
        }
        const keepBox = screenKeep(layout);
        // The gate's name board: four characters of neon in the frame the alley builds.
        const gate = gateOf(layout);
        const plaque = gate.plaque || { center: [gate.x, 5.05, gate.z + 0.26], width: 2.6, height: 0.9 };
        const plaqueSlot = { pos: vec(plaque.center), normal: vec(plaque.normal || [0, 0, 1]), tangent: [1, 0, 0], kind: 'flat', use: 'sign', floor: 1, width: plaque.width, _gate: true };
        const specs = [plaqueSlot].concat(chosen.slice(0, MAX_SIGNS - 1)).map((slot, i) => {
            if (slot._gate) {
                const base = designSign({ ...slot, kind: 'flat' }, i, random, { vertical: [], horizontal: [], roof: [] });
                return { ...base, kind: 'flat', text: '城寨夜市', caption: 'NIGHT MARKET', vertical: false, style: 'neon', font: 'brush',
                    color: '#ff3fae', border: '#2ef2ff', width: plaque.width * 0.94, height: plaque.height * 0.9, depth: 0.1, dead: [], broken: 0, bulbs: false, tilt: 0, rise: 0,
                    gain: 1.45 / (0.55 + lum(hexRgb('#ff3fae')) * 0.9), slot };
            }
            const spec = designSign(slot, i, random, pools);
            // Signs on the street faces are seen from far off: some run many floors.
            const floor = Number(slot.floor) || 0;
            if (slot._street && slot.kind === 'blade' && spec.vertical && floor >= 2 && floor <= 6 && random() < 0.55) {
                const chars = graphemes(spec.text).length;
                spec.width = 2.0 + random() * 1.2;
                spec.height = Math.min(18, chars * spec.width * 1.05 + (spec.caption ? 1.6 : 0.6));
                // Grows up the face from its floor.
                spec.rise = spec.height / 2 - 1.2;
                spec.gain *= 1.15;
            }
            // Street level (shutters, stalls, awnings to 2.7 m) belongs to the alley.
            if (slot.kind !== 'shop' && slot.kind !== 'roof') {
                const bottom = vec(slot.pos)[1] + (spec.rise || 0) - spec.height / 2;
                if (bottom < 2.9) spec.rise = (spec.rise || 0) + 2.9 - bottom;
            }
            return { ...spec, slot };
        }).filter(spec => !keepBox || !overlaps(boxOf(spec), keepBox, 0)).filter((spec, i, all) => {
            // Signs must not run through one another: keep the earlier (better
            // placed) of any two whose boxes meet.
            const box = boxOf(spec);
            spec._box = box;
            return !all.slice(0, i).some(o => o._kept !== false && o._box && overlaps(o._box, box, spec.slot._street && o.slot._street ? 0.7 : 0.12)) || (spec._kept = false);
        }).map((spec, i) => ({ ...spec, index: i }));

        // --- atlas
        const energy = tier.name === 'energy-saving';
        const ATLAS = energy ? 1024 : 2048;
        // A little short of square keeps the light layer and its mips under ~20 MB.
        const ATLAS_H = energy ? 1024 : 1792;
        const adSlides = 4;
                // Pixels per metre: as many as fit. Huge signs are seen from far off and
        // get fewer; alley signs, seen up close, get more.
        const weight = x => x.kind === 'roof' ? 0.55 : x.height > 8 || x.width > 8 ? 0.7 : x.slot._alley ? 1.35 : 1;
        const sizes = d => [
            ...specs.map(x => ({ w: Math.max(16, Math.round(x.width * d * weight(x))), h: Math.max(16, Math.round(x.height * d * weight(x))) })),
            { w: Math.round(ATLAS * 0.25), h: Math.round(ATLAS * 0.25 * 0.42 * 2) }, // ads: 2×2 slides
            { w: 64, h: 64 }, { w: 64, h: 64 }
        ];
        let lo = 4, hi = energy ? 90 : 180, packed = pack(sizes(lo), ATLAS, 4);
        for (let k = 0; k < 14; k += 1) {
            const mid = (lo + hi) / 2, tryPack = pack(sizes(mid), ATLAS, 4);
            if (tryPack.height <= ATLAS_H) { lo = mid; packed = tryPack; } else hi = mid;
        }
        let density = lo;
        // Only the light layer needs full resolution; paint the unlit surface
        // and the tube-channel mask straight at a quarter instead of full size + shrink.
        // Software 2D backing avoids flushing thousands of Skia GPU clip/gradient/text ops inside texSubImage2D.
        const sw = { willReadFrequently: true };
        const baseSmall = makeCanvas(ATLAS / 4, ATLAS_H / 4), emit = makeCanvas(ATLAS, ATLAS_H), maskSmall = makeCanvas(ATLAS / 4, ATLAS_H / 4);
        const L = { base: baseSmall.getContext('2d', sw), emit: emit.getContext('2d', sw), mask: maskSmall.getContext('2d', sw) };
        L.base.setTransform(0.25, 0, 0, 0.25, 0, 0);
        L.mask.setTransform(0.5, 0, 0, 0.5, 0, 0);
        L.base.fillStyle = '#101010'; L.base.fillRect(0, 0, ATLAS, ATLAS_H);
        L.emit.fillStyle = '#000'; L.emit.fillRect(0, 0, ATLAS, ATLAS_H);
        L.mask.fillStyle = '#000'; L.mask.fillRect(0, 0, ATLAS / 2, ATLAS_H / 2);
        const paintRandom = rngFor(ctx, `kowloon:paint:${seed}`);
        specs.forEach((spec, i) => {
            const r = packed.rects[i];
            spec.rect = r;
            if (spec.style === 'box') paintBoxSign(L, spec, r, paintRandom);
            else paintNeonSign(L, spec, r, paintRandom);
        });
        const adRect = packed.rects[specs.length];
        const slideW = adRect.w / 2, slideH = adRect.h / 2;
        for (let k = 0; k < adSlides; k += 1) {
            paintAd(L, AD_SLOGANS[(k + Math.floor(paintRandom() * 6)) % AD_SLOGANS.length],
                { x: adRect.x + (k % 2) * slideW, y: adRect.y + Math.floor(k / 2) * slideH, w: slideW, h: slideH }, paintRandom, k);
        }
        const metalRect = packed.rects[specs.length + 1], darkRect = packed.rects[specs.length + 2];
        paintMetal(L, metalRect, paintRandom, '#3b3836');
        paintMetal(L, darkRect, paintRandom, '#1c1b1a');
        const uvOf = (r, inset = 0.5) => [(r.x + inset) / ATLAS, 1 - (r.y + r.h - inset) / ATLAS_H, (r.x + r.w - inset) / ATLAS, 1 - (r.y + inset) / ATLAS_H];
        const metalUv = uvOf(metalRect, 4), darkUv = uvOf(darkRect, 4);

        const texture = (canvas, nearest) => {
            const t = new T.CanvasTexture(canvas);
            if (nearest) { t.minFilter = T.NearestFilter; t.magFilter = T.NearestFilter; t.generateMipmaps = false; }
            else { t.anisotropy = energy ? 2 : 8; }
            t.needsUpdate = true;
            disposables.push(t);
            return t;
        };
        const baseTex = texture(baseSmall), emitTex = texture(emit), maskTex = texture(maskSmall, true);
        baseTex.generateMipmaps = false; baseTex.minFilter = T.LinearFilter;

        // --- geometry
        const hw = createBuilder(), glow = createBuilder();
        const UP = [0, 1, 0];
        const lightSources = [];
        specs.forEach(spec => {
            const slot = spec.slot;
            const n = norm(vec(slot.normal || [0, 0, 1]));
            const tangent = norm(vec(slot.tangent || cross(UP, n)));
            let p = vec(slot.pos);
            const bay = Number(slot.width) || 2.05;
            // Blades hang at the joint between bays, clear of the air-conditioners
            // and cages that sit mid-bay.
            if (spec.kind === 'blade') p = add(p, tangent, bay / 2 * bladeSide(slot));
            if (spec.rise) p = add(p, UP, spec.rise);
            // Shop fascias sit above the awnings and shutters (street level is the alley's).
            if (slot.kind === 'shop') p = [p[0], Math.max(p[1], 2.9 + spec.height / 2), p[2]];
            const info = [spec.index, spec.gain, 0, spec.beat];
            hw.setTag(spec.index + 1); glow.setTag(spec.index + 1);
            const faceUv = uvOf(spec.rect);
            let c, r, u, f;
            // Up may lean a touch on a few old signs.
            const lean = spec.tilt;
            if (spec.kind === 'blade') {
                // Sticks straight out of the wall; read from up and down the street.
                f = tangent; u = norm(add(UP, n, lean)); r = norm(cross(u, f));
                const out = 0.35 + spec.width / 2;
                c = add(add(p, n, out), UP, 0);
                hw.box(c, r, u, f, spec.width / 2, spec.height / 2, spec.depth / 2, faceUv, metalUv, info, ['front', 'back', 'backFace']);
                // The back face reads mirrored unless its U runs the other way.
                const back = (sx, sy) => add(add(add(c, r, sx * spec.width / 2), u, sy * spec.height / 2), f, -spec.depth / 2 - 0.03);
                const front = (sx, sy) => add(add(add(c, r, sx * spec.width / 2), u, sy * spec.height / 2), f, spec.depth / 2 + 0.03);
                glow.quad(front(-1, -1), front(1, -1), front(1, 1), front(-1, 1), f, faceUv, info);
                // Seen from behind, the start of the text sits on the other side.
                glow.quad(back(1, -1), back(-1, -1), back(-1, 1), back(1, 1), scale(f, -1), faceUv, info);
                // Brackets: two arms from the wall, a stay up to the wall above, a conduit down.
                const top = spec.height / 2, bot = -spec.height / 2;
                [top - 0.15, bot + 0.15].forEach(dy => hw.bar(add(add(p, UP, dy), n, 0.02), add(add(c, UP, dy), n, spec.width / 2 - 0.05), 0.08, metalUv, info));
                hw.bar(add(add(c, UP, top), n, spec.width / 2 - 0.1), add(add(p, UP, top + Math.min(2.2, spec.width * 1.1)), n, 0.03), 0.03, darkUv, info);
                hw.bar(add(add(p, UP, bot + 0.3), tangent, spec.depth), add(add(p, UP, bot - 2.6), tangent, spec.depth), 0.05, darkUv, info);
                // A ballast box on top of neon signs.
                if (spec.style === 'neon') hw.box(add(add(c, UP, top + 0.14), n, -spec.width * 0.25), r, UP, f, 0.22, 0.12, 0.12, darkUv, darkUv, info);
            } else if (spec.kind === 'roof') {
                f = n; r = cross(UP, f); u = UP;
                c = add(add(p, UP, spec.lift + spec.height / 2), n, -0.6);
                hw.box(c, r, u, f, spec.width / 2, spec.height / 2, spec.depth / 2, faceUv, metalUv, info, ['front', 'back']);
                const fp = (sx, sy, sz) => add(add(add(c, r, sx * spec.width / 2), u, sy * spec.height / 2), f, sz);
                glow.quad(fp(-1, -1, spec.depth / 2 + 0.03), fp(1, -1, spec.depth / 2 + 0.03), fp(1, 1, spec.depth / 2 + 0.03), fp(-1, 1, spec.depth / 2 + 0.03), f, faceUv, info);
                // Steel frame: posts, chords, cross braces, a catwalk and floodlights.
                const posts = Math.max(3, Math.round(spec.width / (spec.mega ? 2.0 : 2.6)));
                const bottomY = p[1], frontZ = -spec.depth / 2 - 0.25, backZ = -spec.depth / 2 - 2.2;
                for (let k = 0; k < posts; k += 1) {
                    const sx = -1 + 2 * k / (posts - 1);
                    const at = (z, y) => add(add(add(c, r, sx * spec.width / 2 * 0.96), f, z), UP, y - c[1]);
                    hw.bar(at(frontZ, bottomY), at(frontZ, c[1] + spec.height / 2), 0.16, darkUv, info);
                    hw.bar(at(backZ, bottomY), at(frontZ, c[1] + spec.height / 2 - 0.3), 0.12, darkUv, info);
                    hw.bar(at(backZ, bottomY), at(frontZ, bottomY), 0.1, darkUv, info);
                    if (k < posts - 1) {
                        const sx2 = -1 + 2 * (k + 1) / (posts - 1);
                        const at2 = (z, y) => add(add(add(c, r, sx2 * spec.width / 2 * 0.96), f, z), UP, y - c[1]);
                        hw.bar(at(frontZ, bottomY + 0.2), at2(frontZ, c[1] - spec.height / 2), 0.07, darkUv, info);
                        hw.bar(at(frontZ, c[1] - spec.height / 2), at2(frontZ, bottomY + 0.2), 0.07, darkUv, info);
                    }
                }
                [bottomY + 0.2, c[1] - spec.height / 2 - 0.05, c[1] + spec.height / 2].forEach(y =>
                    hw.bar(add(add(add(c, r, -spec.width / 2), f, frontZ), UP, y - c[1]), add(add(add(c, r, spec.width / 2), f, frontZ), UP, y - c[1]), 0.12, darkUv, info));
                if (spec.mega) {
                    // Deep frames: horizontal stringers across the back, a second
                    // bracing plane and a service ladder up one leg.
                    for (let k = 1; k < 4; k += 1) {
                        const y = c[1] - spec.height / 2 + spec.height * k / 4;
                        hw.bar(add(add(add(c, r, -spec.width / 2), f, -spec.depth / 2 - 0.12), UP, y - c[1]), add(add(add(c, r, spec.width / 2), f, -spec.depth / 2 - 0.12), UP, y - c[1]), 0.09, darkUv, info);
                    }
                    for (let k = 0; k < posts - 1; k += 1) {
                        const s0 = -1 + 2 * k / (posts - 1), s1 = -1 + 2 * (k + 1) / (posts - 1);
                        const at = (sx, y) => add(add(add(c, r, sx * spec.width / 2 * 0.96), f, -spec.depth / 2 - 0.12), UP, y - c[1]);
                        hw.bar(at(s0, c[1] - spec.height / 2), at(s1, c[1] + spec.height / 2), 0.05, darkUv, info);
                    }
                    const leg = add(add(c, r, -spec.width / 2 * 0.96), f, frontZ - 0.25);
                    for (const side of [-0.22, 0.22]) hw.bar([leg[0] + r[0] * side, bottomY, leg[2] + r[2] * side], [leg[0] + r[0] * side, c[1] + spec.height / 2, leg[2] + r[2] * side], 0.04, metalUv, info);
                    for (let y = bottomY + 0.3; y < c[1] + spec.height / 2; y += 0.35) hw.bar([leg[0] - r[0] * 0.22, y, leg[2] - r[2] * 0.22], [leg[0] + r[0] * 0.22, y, leg[2] + r[2] * 0.22], 0.03, metalUv, info);
                }
                // Catwalk under the face and lamps reaching out over it.
                hw.box(add(add(c, f, 0.55), UP, -spec.height / 2 - 0.08), r, UP, f, spec.width / 2, 0.04, 0.45, darkUv, darkUv, info);
                const lamps = Math.max(2, Math.round(spec.width / 4));
                for (let k = 0; k < lamps; k += 1) {
                    const sx = -1 + 2 * (k + 0.5) / lamps;
                    const foot = add(add(c, r, sx * spec.width / 2 * 0.9), UP, -spec.height / 2 - 0.1);
                    const head = add(foot, f, 1.1);
                    hw.bar(add(foot, f, 0.1), head, 0.05, darkUv, info);
                    hw.box(head, r, UP, f, 0.18, 0.1, 0.12, darkUv, darkUv, info);
                }
            } else {
                // Fascia board flat on the wall, on short standoffs.
                f = n; r = norm(cross(UP, f)); u = norm(add(UP, r, lean));
                c = add(p, n, 0.12 + spec.depth / 2);
                hw.box(c, r, u, f, spec.width / 2, spec.height / 2, spec.depth / 2, faceUv, metalUv, info, ['front']);
                const fp = (sx, sy) => add(add(add(c, r, sx * spec.width / 2), u, sy * spec.height / 2), f, spec.depth / 2 + 0.03);
                glow.quad(fp(-1, -1), fp(1, -1), fp(1, 1), fp(-1, 1), f, faceUv, info);
                hw.bar(add(add(c, r, spec.width / 2 + 0.1), UP, 0), add(add(add(p, r, spec.width / 2 + 0.25), UP, -3.2), n, 0.03), 0.05, darkUv, info);
            }
            if (spec.gain > 0) {
                const col = spec.style === 'box' ? hexRgb(spec.box[0]) : hexRgb(spec.color);
                lightSources.push({ spec, position: add(c, f, spec.kind === 'blade' ? 0 : 0.6), color: col, base: spec.width * spec.height * spec.gain });
            }
        });

        const Shared = ctx.lightUniforms ? global.MusicStageKowloonShared : null;
        const sharedFog = T.UniformsLib?.fog || {};
        const fogUniforms = () => T.UniformsUtils ? T.UniformsUtils.clone(sharedFog) : {};
        const hardwareMat = new T.ShaderMaterial({
            name: 'kowloon:signs:hardware', fog: true,
            uniforms: { ...fogUniforms(), baseMap: { value: baseTex }, ambient: { value: new T.Color(0.09, 0.08, 0.12) },
                keyColor: { value: new T.Color(0.22, 0.12, 0.2) }, keyDir: { value: new T.Vector3(0.3, 0.6, 0.7) },
                skyColor: { value: new T.Color(0.25, 0.18, 0.35) }, wet: { value: 1 } },
            vertexShader: HARDWARE_VS, fragmentShader: hardwareFs(Shared)
        });
        // The shared night light: the same uniform objects, so the manager's
        // updates reach this material too.
        if (Shared && ctx.lightUniforms) Object.assign(hardwareMat.uniforms, ctx.lightUniforms);
        const levelArray = Array.from({ length: 64 }, () => new T.Vector4(1, 1, 1, 1));
        const tubeArray = Array.from({ length: 4 }, () => new T.Vector4(1, 1, 1, 1));
        const glowMat = new T.ShaderMaterial({
            name: 'kowloon:signs:glow', fog: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
            uniforms: { ...fogUniforms(), emitMap: { value: emitTex }, maskMap: { value: maskTex }, levels: { value: levelArray },
                tubes: { value: tubeArray }, time: { value: 0 }, chase: { value: 0 }, halo: { value: energy ? 1.4 : 0.5 }, atlasSize: { value: ATLAS } },
            vertexShader: GLOW_VS, fragmentShader: GLOW_FS
        });
        disposables.push(hardwareMat, glowMat);
        const meshes = [];
        const addMesh = (builder, material, name, order) => {
            if (!builder.triangles) return null;
            const geometry = builder.geometry(T);
            disposables.push(geometry);
            const mesh = new T.Mesh(geometry, material);
            mesh.name = name; mesh.renderOrder = order; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
            mesh.frustumCulled = false;
            group.add(mesh); meshes.push(mesh);
            return mesh;
        };
        addMesh(hw, hardwareMat, 'Signs/hardware', 0);
        addMesh(glow, glowMat, 'Signs/glow', 2);

        // --- screens
        const lyricCanvas = makeCanvas(LYRIC_W * LYRIC_SCALE, LYRIC_H * LYRIC_SCALE);
        const lyricCtx = lyricCanvas.getContext('2d');
        const lyricTex = texture(lyricCanvas);
        // Sampled once per lamp: no mip chain needed.
        lyricTex.generateMipmaps = false; lyricTex.minFilter = T.LinearFilter;
        lyricTex.anisotropy = 1;
        const sb = createBuilder();
        const regionAttr = [];
        const screenList = [];
        const addScreen = (s, role) => {
            const centre = vec(s.center || s.pos || s.position);
            const n = norm(vec(s.normal || [0, 0, 1]));
            const r = norm(cross(UP, n));
            const w = Number(s.width ?? s.size?.[0]) || 8, h = Number(s.height ?? s.size?.[1]) || 5;
            const reg = role === 0 ? REGIONS.main : role === 1 ? REGIONS.tall : role === 2 ? REGIONS.ticker : null;
            const regionVec = reg ? regionUv(reg)
                : [adRect.x / ATLAS, 1 - (adRect.y + adRect.h) / ATLAS_H, slideW / ATLAS, slideH / ATLAS_H];
            // One LED per ~5 cm on the big boards, coarser on small ones.
            const pitch = role === 2 ? 0.022 : role === 3 ? 0.035 : 0.055;
            const cols = Math.max(24, Math.round(w / pitch)), rows = Math.max(12, Math.round(h / pitch));
            const info = [role, cols, rows, screenList.length * 1.37 + 0.2];
            const c = add(centre, n, 0.02);
            const P = (sx, sy) => add(add(c, r, sx * w / 2), UP, sy * h / 2);
            sb.quad(P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), n, [0, 0, 1, 1], info);
            for (let k = 0; k < 4; k += 1) regionAttr.push(...regionVec);
            // Housing: a deep steel case, a bezel, vents and a service ladder on the big ones.
            const bez = Math.max(0.12, Math.min(w, h) * 0.025);
            const hInfo = [0, 0, 0, 0];
            hw.box(add(centre, n, -0.45), r, UP, n, w / 2 + bez, h / 2 + bez, 0.45, darkUv, darkUv, hInfo, ['back']);
            hw.box(add(add(centre, UP, h / 2 + bez / 2), n, 0.04), r, UP, n, w / 2 + bez, bez / 2, 0.1, metalUv, metalUv, hInfo);
            hw.box(add(add(centre, UP, -h / 2 - bez / 2), n, 0.04), r, UP, n, w / 2 + bez, bez / 2, 0.1, metalUv, metalUv, hInfo);
            hw.box(add(add(centre, r, w / 2 + bez / 2), n, 0.04), r, UP, n, bez / 2, h / 2, 0.1, metalUv, metalUv, hInfo);
            hw.box(add(add(centre, r, -w / 2 - bez / 2), n, 0.04), r, UP, n, bez / 2, h / 2, 0.1, metalUv, metalUv, hInfo);
            screenList.push({ role, centre, normal: n, width: w, height: h });
        };
        hw.setTag(0); glow.setTag(0);
        const screens = (layout.SCREENS || layout.screens || []).concat(adScreens);
        screens.forEach(s => {
            const kind = String(s.role || s.kind || s.id || '');
            const w = Number(s.width ?? s.size?.[0]), h = Number(s.height ?? s.size?.[1]);
            const role = /ticker/.test(kind) ? 2 : /^ad/.test(kind) ? 3 : (s.primary || /main/.test(kind)) ? 0 : h > w ? 1 : 0;
            addScreen(s, role);
        });
        // Every big lyric board carries an LED ticker under it.
        screenList.filter(s => s.role === 0).forEach(s => {
            if (screens.some(x => /ticker/.test(String(x.role || x.kind || x.id || '')))) return;
            const r = norm(cross(UP, s.normal));
            sb.quad(...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => add(add(add(s.centre, s.normal, 0.05), r, sx * s.width / 2), UP, -s.height / 2 - 0.55 + sy * 0.32)),
                s.normal, [0, 0, 1, 1], [2, Math.round(s.width / 0.022), 29, 9.1]);
            for (let k = 0; k < 4; k += 1) regionAttr.push(...regionUv(REGIONS.ticker));
            hw.box(add(add(s.centre, s.normal, -0.15), UP, -s.height / 2 - 0.55), norm(cross(UP, s.normal)), UP, s.normal, s.width / 2 + 0.1, 0.4, 0.2, darkUv, darkUv, [0, 0, 0, 0]);
        });
        // Holograms: a projector on the ground throws the next line up into the
        // air, turned toward where people walk. One over the street, one in each
        // main alley.
        const holoSpots = [
            { pos: [-26, 0, 65.4], normal: norm([0.25, 0, 1]), width: 9, height: 2.6, lift: 6.5 },
            { pos: [-34, 0, 0], normal: [1, 0, 0], width: 2.0, height: 0.75, lift: 2.5 },
            { pos: [-14, 0, 22], normal: [0, 0, 1], width: 1.8, height: 0.7, lift: 2.4 }
        ];
        const hb = createBuilder();
        holoSpots.forEach((h, k) => {
            const n = norm(h.normal), r = norm(cross(UP, n));
            const c = add(h.pos, UP, h.lift + h.height / 2);
            const P = (sx, sy) => add(add(c, r, sx * h.width / 2), UP, sy * h.height / 2);
            hb.quad(P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), n, [0, 0, 1, 1], [k, h.width, h.height, 0]);
            // Back side too: the light shows from both ways, mirrored.
            hb.quad(P(1, -1), P(-1, -1), P(-1, 1), P(1, 1), scale(n, -1), [0, 0, 1, 1], [k, h.width, h.height, 1]);
            // The projector: a squat box on a stand, its lens towards the panel.
            const foot = vec(h.pos);
            const big = h.width > 4;
            hw.box(add(foot, UP, big ? 0.5 : 0.35), r, UP, n, big ? 0.6 : 0.22, big ? 0.5 : 0.35, big ? 0.6 : 0.22, darkUv, metalUv, [0, 0, 0, 0]);
            hw.box(add(foot, UP, big ? 1.1 : 0.78), r, UP, n, big ? 0.35 : 0.14, 0.08, big ? 0.35 : 0.14, metalUv, metalUv, [0, 0, 0, 0]);
        });
        // Hologram banners: tall translucent sheets of light in the air, each
        // thrown up by a projector on an arm off the wall or a mast on the roof.
        const holoAds = chooseHoloAds(layout, tier.name === 'energy-saving' ? 8 : tier.name === 'ultimate' ? 20 : 16, random);
        const ab = createBuilder();
        // Some banners carry the sung line whenever the main screen is out of shot.
        const roofPath = layout.CAMERA?.roof;
        const toPath = a => {
            if (!roofPath?.from || !roofPath?.to) return 0;
            const A = vec(roofPath.from), B = vec(roofPath.to), d = [B[0] - A[0], B[2] - A[2]];
            const t = Math.max(0, Math.min(1, ((a.centre[0] - A[0]) * d[0] + (a.centre[2] - A[2]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1)));
            return Math.hypot(A[0] + d[0] * t - a.centre[0], A[2] + d[1] * t - a.centre[2]);
        };
        // Every roof banner (the roof pass sees several at once), two off the walls.
        const lyricBanners = new Set([...holoAds.filter(a => a.roof).sort((a, b) => toPath(a) - toPath(b)), ...holoAds.filter(a => !a.roof).slice(0, 2)]);
        // The sandbox view cuts out one block (x -30..38, z 8..72) and frames it
        // to about 60 m: banners that tower past that, or that a cut would slice,
        // sit that view out, and one lyric banner stands by the block's south-east
        // corner in their place.
        const SBX = { x0: -30, x1: 38, z0: 8, z1: 72, top: 60 };
        const cutBy = (lo, hi, at) => lo < at && hi > at;
        const sbAds = [{ sandboxOnly: true, roof: false, lyric: true, normal: norm([0.64, 0, 0.77]), right: norm(cross(UP, norm([0.64, 0, 0.77]))),
            centre: [33.8, 33, 63.5], width: 7, height: 42, bottom: 12, seed: 0.37, foot: [33.8, 0, 63.5] }];
        holoAds.concat(sbAds).forEach((a, i) => {
            const e = a.width / 2;
            const sliced = cutBy(a.centre[0] - e, a.centre[0] + e, SBX.x0) || cutBy(a.centre[0] - e, a.centre[0] + e, SBX.x1) || cutBy(a.centre[2] - e, a.centre[2] + e, SBX.z0) || cutBy(a.centre[2] - e, a.centre[2] + e, SBX.z1);
            a.sbHidden = !a.sandboxOnly && (a.bottom + a.height > SBX.top || sliced);
            const t = a.sandboxOnly ? -2 : a.sbHidden ? -1 : 0;
            ab.setTag(t); hw.setTag(a.sandboxOnly ? 0 : t);
            const n = a.normal, r = a.right;
            const P = (sx, sy) => add(add(a.centre, r, sx * a.width / 2), UP, sy * a.height / 2);
            const inf = [(a.lyric || lyricBanners.has(a) ? 20 : 0) + i % 4, a.seed + (i % 2) * 10, a.width, a.height];
            ab.quad(P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), n, [0, 0, 1, 1], inf);
            // The light fans up from the lens to the sheet's foot.
            const lens = add(a.centre, UP, -a.height / 2 - (a.roof ? 4 : 2.6));
            const fan = (sx, dir) => add(add(a.centre, dir, sx * a.width / 2), UP, -a.height / 2);
            const beamInf = [10 + (i % 4), a.seed + (i % 2) * 10, a.width, a.height];
            [r, n].forEach(dir => {
                const e = 0.12;
                ab.quad(add(lens, dir, -e), add(lens, dir, e), fan(1, dir), fan(-1, dir), cross(dir, UP), [0, 0, 1, 1], beamInf);
            });
            // Hardware: the projector, and what holds it up.
            if (a.sandboxOnly) return;
            hw.box(add(lens, UP, -0.25), r, UP, n, 0.35, 0.25, 0.35, darkUv, metalUv, [0, 0, 0, 0]);
            if (a.roof) {
                const top = add(lens, UP, -0.5);
                hw.bar(a.foot, top, 0.22, metalUv, [0, 0, 0, 0]);
                hw.bar(add(a.foot, r, -1.6), add(top, r, -0.2), 0.08, metalUv, [0, 0, 0, 0]);
                hw.bar(add(a.foot, r, 1.6), add(top, r, 0.2), 0.08, metalUv, [0, 0, 0, 0]);
            } else {
                const wallAt = [a.foot[0], lens[1] - 0.4, a.foot[2]];
                hw.bar(wallAt, add(lens, UP, -0.4), 0.12, metalUv, [0, 0, 0, 0]);
                hw.bar(add(wallAt, UP, -1.8), add(lens, UP, -0.5), 0.07, metalUv, [0, 0, 0, 0]);
            }
        });
        ab.setTag(0); hw.setTag(0);
        // Rebuild the hardware mesh now that screen housings are in it.
        meshes.forEach(m => { if (m.name === 'Signs/hardware') { group.remove(m); m.geometry.dispose(); } });
        meshes.splice(meshes.findIndex(m => m.name === 'Signs/hardware'), 1);
        addMesh(hw, hardwareMat, 'Signs/hardware', 0);
        const screenMat = new T.ShaderMaterial({
            name: 'kowloon:signs:screens', fog: true,
            uniforms: { ...fogUniforms(), lyricMap: { value: lyricTex }, adMap: { value: emitTex },
                sung: { value: new T.Color(2.4, 1.1, 2.0) }, rest: { value: new T.Color(0.6, 0.62, 0.68) },
                trans: { value: new T.Color(0.2, 0.9, 1.1) }, amber: { value: new T.Color(1.4, 0.55, 0.08) },
                deep: { value: new T.Color(0.05, 0.08, 0.2) },
                time: { value: 0 }, level: { value: 1 }, progress: { value: 0 }, vprogress: { value: 0 }, age: { value: 9 },
                idle: { value: 1 }, ticker: { value: 0 }, tickerSpan: { value: 1 }, beat: { value: 0 }, energy: { value: 0 },
                grid: { value: 1 }, subpixel: { value: tier.name === 'ultimate' ? 1 : 0 },
                // Same objects as the shared lights, so the alley's rain drives the glass.
                wet: ctx.lightUniforms?.uWet || { value: 0.7 }, rain: ctx.lightUniforms?.uRain || { value: 0.4 },
                sky: ctx.lightUniforms?.uSky || { value: new T.Color(0x3a4c66) } },
            vertexShader: SCREEN_VS, fragmentShader: SCREEN_FS, extensions: { derivatives: true }
        });
        disposables.push(screenMat);
        if (sb.triangles) {
            const geometry = sb.geometry(T);
            geometry.setAttribute('region', new T.Float32BufferAttribute(regionAttr, 4));
            disposables.push(geometry);
            const mesh = new T.Mesh(geometry, screenMat);
            mesh.name = 'Signs/screens'; mesh.renderOrder = 1; mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
            group.add(mesh); meshes.push(mesh);
        }


        const holoCanvas = makeCanvas(1024, 320);
        const holoCtx = holoCanvas.getContext('2d');
        const holoTex = texture(holoCanvas);
        holoTex.generateMipmaps = false; holoTex.minFilter = T.LinearFilter;
        const holoMat = new T.ShaderMaterial({
            name: 'kowloon:signs:holo', fog: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.FrontSide,
            uniforms: { ...fogUniforms(), map: { value: holoTex }, time: { value: 0 }, age: { value: 9 }, level: { value: 1 },
                tint: { value: new T.Color(0.25, 0.85, 1.0) }, edge: { value: new T.Color(1.0, 0.3, 0.75) } },
            vertexShader: `attribute vec4 info;varying vec2 vUv;varying vec4 vInfo;varying vec3 vW;
                ${FOG_V}
                void main(){vUv=uv;vInfo=info;vec4 w=modelMatrix*vec4(position,1.0);vW=w.xyz;
                    vec4 mvPosition=viewMatrix*w;gl_Position=projectionMatrix*mvPosition;
                    #include <fog_vertex>
                }`,
            fragmentShader: `uniform sampler2D map;uniform float time,age,level;uniform vec3 tint,edge;
                varying vec2 vUv;varying vec4 vInfo;varying vec3 vW;
                #include <fog_pars_fragment>
                float h(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
                void main(){
                    vec2 uv=vUv;if(vInfo.w>0.5)uv.x=1.0-uv.x;
                    float id=vInfo.x;
                    // Forming: rows arrive with jitter, then settle; the beam wobbles a little always.
                    float form=smoothstep(0.0,0.6,age);
                    float row=floor(uv.y*60.0);
                    float jit=(h(vec2(row,floor(time*20.0)+id))-0.5)*(1.0-form)*0.25+sin(time*1.7+uv.y*9.0+id)*0.002;
                    float wipe=step(uv.y,form*1.2);
                    vec2 s=uv+vec2(jit,0.0);
                    float txt=texture2D(map,s).r;
                    float ab=texture2D(map,s+vec2(0.004,0.0)).r;
                    float scan=0.6+0.4*sin(uv.y*vInfo.z*90.0-time*6.0);
                    float frame=max(smoothstep(0.03,0.0,min(uv.x,1.0-uv.x)),smoothstep(0.05,0.0,min(uv.y,1.0-uv.y)));
                    float fill=0.05+0.04*sin(time*0.9+id);
                    float flick=0.85+0.15*step(0.08,h(vec2(floor(time*14.0),id)));
                    vec3 col=tint*(txt*1.3*scan+fill)+edge*(ab-txt)*0.6*max(0.0,ab-txt)+tint*frame*0.35;
                    col*=wipe*flick*level;
                    gl_FragColor=vec4(col,1.0);
                    #ifdef USE_FOG
                    #ifdef FOG_EXP2
                    float fogFactor=1.0-exp(-fogDensity*fogDensity*vFogDepth*vFogDepth);
                    #else
                    float fogFactor=smoothstep(fogNear,fogFar,vFogDepth);
                    #endif
                    gl_FragColor.rgb*=1.0-fogFactor*0.85;
                    #endif
                }`
        });
        disposables.push(holoMat);
        if (hb.triangles) {
            const geometry = hb.geometry(T);
            disposables.push(geometry);
            const mesh = new T.Mesh(geometry, holoMat);
            mesh.name = 'Signs/holo'; mesh.renderOrder = 3; mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
            group.add(mesh); meshes.push(mesh);
        }
        // Banner art: four columns, two slides each (top row, bottom row).
        // Masks only: R = the big copy, G = linework, B = the faint panel.
        const HA_W = energy ? 512 : 1024, HA_H = HA_W * 2, HC = HA_W / 4, HR = HA_H / 2;
        const haCanvas = makeCanvas(HA_W, HA_H);
        const paintHoloAds = () => {
            const g = haCanvas.getContext('2d', { willReadFrequently: true });
            const k = HC / 256;
            g.fillStyle = '#000'; g.fillRect(0, 0, HA_W, HA_H);
            g.globalCompositeOperation = 'lighter';
            const used = holoAds.length ? holoAds.slice(0, 4).map(a => HOLO_COPY[Math.floor(a.seed * HOLO_COPY.length) % HOLO_COPY.length]) : [];
            while (used.length < 4) used.push(HOLO_COPY[used.length]);
            used.forEach(([cn, en, tag], c) => {
                for (let row = 0; row < 2; row += 1) {
                    g.save();
                    g.translate(c * HC, row * HR); g.scale(k, k);
                    // Panel: a faint fill, brighter at the foot where the light comes in.
                    const pg = g.createLinearGradient(0, 0, 0, 1024);
                    pg.addColorStop(0, 'rgba(0,0,90,1)'); pg.addColorStop(1, 'rgba(0,0,200,1)');
                    g.fillStyle = pg; g.fillRect(4, 4, 248, 1016);
                    // Frame with corner brackets.
                    g.strokeStyle = '#00ff00'; g.lineWidth = 3; g.strokeRect(10, 10, 236, 1004);
                    g.lineWidth = 8;
                    [[10, 10, 1, 1], [246, 10, -1, 1], [10, 1014, 1, -1], [246, 1014, -1, -1]].forEach(([x, y, sx, sy]) => {
                        g.beginPath(); g.moveTo(x, y + sy * 46); g.lineTo(x, y); g.lineTo(x + sx * 46, y); g.stroke();
                    });
                    g.fillStyle = '#ff0000'; g.textAlign = 'center'; g.textBaseline = 'middle';
                    const chars = graphemes(cn);
                    if (row === 0) {
                        // Copy stacked down the sheet, a barcode on top, a ring emblem under.
                        for (let b = 0; b < 18; b += 1) g.fillRect(36 + b * 10, 34, (b * 7) % 3 + 2, 44);
                        const px = Math.min(196, 640 / chars.length);
                        g.font = `900 ${px}px ${FONTS.heavy}`;
                        chars.forEach((ch, j) => g.fillText(ch, 128, 110 + px * (j + 0.5), 230));
                        g.strokeStyle = '#00ff00'; g.lineWidth = 5;
                        g.beginPath(); g.arc(128, 880, 70, 0, Math.PI * 2); g.stroke();
                        for (let a = 0; a < 12; a += 1) { g.beginPath(); g.arc(128, 880, 88, a * Math.PI / 6, a * Math.PI / 6 + 0.32); g.stroke(); }
                        g.font = `700 54px ${FONTS.latin}`; g.fillStyle = '#ff0000'; g.fillText(tag, 128, 882, 120);
                        g.save(); g.translate(232, 520); g.rotate(Math.PI / 2);
                        g.font = `600 22px ${FONTS.latin}`; g.fillStyle = '#00ff00'; g.fillText(en.toUpperCase(), 0, 0, 900); g.restore();
                    } else {
                        // One huge character in rings, the tag, the name in small type.
                        g.strokeStyle = '#00ff00'; g.lineWidth = 4;
                        [118, 100].forEach(rad => { g.beginPath(); g.arc(128, 300, rad, 0, Math.PI * 2); g.stroke(); });
                        for (let a = 0; a < 24; a += 1) { const t = a * Math.PI / 12; g.beginPath(); g.moveTo(128 + Math.cos(t) * 104, 300 + Math.sin(t) * 104); g.lineTo(128 + Math.cos(t) * 116, 300 + Math.sin(t) * 116); g.stroke(); }
                        g.font = `900 170px ${FONTS.brush}`; g.fillText(chars[0], 128, 306, 200);
                        g.font = `800 86px ${FONTS.latin}`; g.fillText(tag, 128, 520, 220);
                        g.font = `700 30px ${FONTS.latin}`;
                        en.toUpperCase().split(' ').forEach((w, j) => g.fillText(w, 128, 620 + j * 38, 220));
                        // Hex grid band and chevrons rising.
                        g.strokeStyle = '#00ff00'; g.lineWidth = 2;
                        for (let y = 0; y < 4; y += 1) for (let x = 0; x < 7; x += 1) {
                            const cx = 30 + x * 33 + (y % 2) * 16, cy = 780 + y * 28;
                            g.beginPath();
                            for (let v = 0; v <= 6; v += 1) { const t = v * Math.PI / 3 + Math.PI / 6; g[v ? 'lineTo' : 'moveTo'](cx + Math.cos(t) * 14, cy + Math.sin(t) * 14); }
                            g.stroke();
                        }
                        g.lineWidth = 7;
                        for (let v = 0; v < 3; v += 1) { const y = 960 - v * 26; g.beginPath(); g.moveTo(96, y); g.lineTo(128, y - 18); g.lineTo(160, y); g.stroke(); }
                    }
                    g.restore();
                }
            });
            g.globalCompositeOperation = 'source-over';
        };
        paintHoloAds();
        const haTex = texture(haCanvas);
        haTex.minFilter = T.LinearMipmapLinearFilter; haTex.generateMipmaps = true;
        const holoAdMat = new T.ShaderMaterial({
            name: 'kowloon:signs:holo-ads', fog: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
            uniforms: { ...fogUniforms(), map: { value: haTex }, time: { value: 0 }, level: { value: 1 },
                lyricMap: { value: lyricTex }, tallRegion: { value: new T.Vector4(...regionUv(REGIONS.tall)) },
                lyricMode: { value: 0 }, vprogress: { value: 0 }, age: { value: 9 },
                cyan: { value: new T.Color(0.2, 0.95, 1.15) }, magenta: { value: new T.Color(1.15, 0.22, 0.85) } },
            vertexShader: `attribute vec4 info;varying vec2 vUv;varying vec4 vInfo;
                ${FOG_V}
                void main(){vUv=uv;vInfo=info;vec4 w=modelMatrix*vec4(position,1.0);
                    vec4 mvPosition=viewMatrix*w;gl_Position=projectionMatrix*mvPosition;
                    #include <fog_vertex>
                }`,
            fragmentShader: `uniform sampler2D map,lyricMap;uniform vec4 tallRegion;uniform float time,level,lyricMode,vprogress,age;uniform vec3 cyan,magenta;
                varying vec2 vUv;varying vec4 vInfo;
                #include <fog_pars_fragment>
                float h(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
                void main(){
                    float role=floor(vInfo.x/10.0);float column=mod(vInfo.x,10.0);float seed=vInfo.y;vec2 size=vInfo.zw;
                    float pinkish=step(5.0,seed);
                    vec3 main=mix(cyan,magenta,pinkish),other=mix(magenta,cyan,pinkish);
                    float win=floor(time*12.0);
                    // Now and then the feed drops a frame: the sheet blinks out or slips.
                    float drop=step(h(vec2(win,seed*13.0)),0.02);
                    vec3 col;
                    float lyr=step(1.5,role)*lyricMode;
                    if(role>0.5&&role<1.5){
                        float a=1.0-abs(vUv.x*2.0-1.0);a=a*a*a;
                        a*=smoothstep(0.0,0.2,vUv.y)*(0.3+0.7*vUv.y);
                        col=main*a*0.07*(0.85+0.15*sin(time*17.0+seed*40.0))*(1.0-drop*0.8);
                    }else{
                        float period=7.0+5.0*fract(seed*3.7);
                        float tt=time/period+seed*5.0;float slide=mod(floor(tt),2.0);float into=fract(tt)*period;
                        float sw=1.0-smoothstep(0.0,0.4,into);
                        // In lyric mode a new line arrives with one tear.
                        float glitch=max(mix(sw,1.0-smoothstep(0.0,0.45,age),lyr),drop);
                        vec2 uv=vUv;
                        // Read the right way round from either side.
                        if(!gl_FrontFacing)uv.x=1.0-uv.x;
                        float row=floor(uv.y*56.0);
                        uv.x+=sin(time*2.1+uv.y*13.0+seed*9.0)*0.004
                            +(h(vec2(row,win+seed))-0.5)*0.16*glitch*step(0.55,h(vec2(row*3.1,win)));
                        uv.y=fract(uv.y+drop*0.08*(h(vec2(win,seed+1.0))-0.5));
                        uv=clamp(uv,vec2(0.002),vec2(0.998));
                        float ca=0.0015+glitch*0.006;
                        col=vec3(0.0);
                        if(lyr<0.999){
                            vec2 auv=vec2((column+uv.x)*0.25,(1.0-slide)*0.5+uv.y*0.5);
                            vec4 t=texture2D(map,auv);
                            float tl=texture2D(map,auv-vec2(ca,0.0)).r,tr=texture2D(map,auv+vec2(ca,0.0)).r;
                            col=main*t.r*1.1+other*t.g*0.75+main*t.b*0.07;
                            col+=magenta*max(tl-t.r,0.0)*0.6+cyan*max(tr-t.r,0.0)*0.6;
                        }
                        if(lyr>0.001){
                            // The tall screen's column of the line, cropped to the sheet.
                            vec2 q=tallRegion.xy+vec2(0.5+(uv.x-0.5)*0.5,uv.y)*tallRegion.zw;
                            vec4 l=texture2D(lyricMap,q);
                            float le=texture2D(lyricMap,q-vec2(ca*0.6,0.0)).r,re=texture2D(lyricMap,q+vec2(ca*0.6,0.0)).r;
                            float sung=step(l.g,vprogress-0.0001)*step(0.001,vprogress);
                            vec3 ink=mix(main*0.75,mix(main,vec3(1.0),0.55)*1.25,sung);
                            vec3 lc=ink*l.r+magenta*max(le-l.r,0.0)*0.5+cyan*max(re-l.r,0.0)*0.5;
                            float fr=max(smoothstep(0.035,0.02,min(uv.x,1.0-uv.x)),smoothstep(0.012,0.006,min(uv.y,1.0-uv.y)));
                            lc+=other*fr*0.5+main*0.035;
                            col=mix(col,lc,lyr);
                        }
                        // Scanlines, faded out where they would be finer than a pixel.
                        float lines=size.y*4.0;
                        float sl=0.62+0.38*sin((vUv.y*lines-time*1.3)*6.2832);
                        sl=mix(sl,0.81,smoothstep(0.2,0.55,fwidth(vUv.y*lines)));
                        col*=sl;
                        // A brighter band climbs the sheet.
                        col*=1.0+0.7*smoothstep(0.05,0.0,abs(fract(vUv.y*0.5-time*0.12+seed)-0.5)-0.44);
                        col+=main*h(floor(vUv*size*6.0)+floor(time*30.0))*glitch*0.3;
                        float ed=smoothstep(0.0,0.03,min(vUv.x,1.0-vUv.x))*smoothstep(0.0,0.015,min(vUv.y,1.0-vUv.y));
                        col*=ed*(0.8+0.35*(1.0-vUv.y));
                        col*=1.0-drop*step(0.5,h(vec2(win,seed+5.0)))*0.9;
                        col*=0.92+0.08*sin(time*53.0+seed*30.0);
                    }
                    gl_FragColor=vec4(col*level,1.0);
                    #ifdef USE_FOG
                    #ifdef FOG_EXP2
                    float fogFactor=1.0-exp(-fogDensity*fogDensity*vFogDepth*vFogDepth);
                    #else
                    float fogFactor=smoothstep(fogNear,fogFar,vFogDepth);
                    #endif
                    gl_FragColor.rgb*=1.0-fogFactor*0.7;
                    #endif
                }`,
            extensions: { derivatives: true }
        });
        disposables.push(holoAdMat);
        if (ab.triangles) {
            const geometry = ab.geometry(T);
            disposables.push(geometry);
            const mesh = new T.Mesh(geometry, holoAdMat);
            mesh.name = 'Signs/holo-ads'; mesh.renderOrder = 3; mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
            group.add(mesh); meshes.push(mesh);
        }
        let holoKey = null, holoAt = 0, holoChorus = 0, lastShot = null;
        const paintHolo = text => {
            const g = holoCtx;
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 320);
            if (!text) return;
            let px = 150;
            g.font = `800 ${px}px ${FONTS.lyric}`;
            const w = g.measureText(text).width;
            if (w > 940) { px = Math.max(48, px * 940 / w); g.font = `800 ${px}px ${FONTS.lyric}`; }
            g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ff0000';
            g.fillText(text, 512, 170, 980);
            g.font = `700 34px ${FONTS.latin}`; g.fillText('NEXT ▸', 512, 48);
        };
        // --- per-frame state
        const levels = new Float32Array(256).fill(0);
        const tubes = new Float32Array(16).fill(1);
        const igniteAt = specs.map(() => 0.15 + random() * 2.4);
        const tubeSeed = Array.from({ length: 16 }, () => random() * 100);
        let palette = ctx.palette || {};
        // Sandbox view: drop what the cuts would slice, swap the banners.
        let sandboxBox = null;
        const sbHiddenSigns = new Set();
        const applySandbox = box => {
            sandboxBox = box || null;
            sbHiddenSigns.clear();
            if (box) specs.forEach(spec => {
                const b = spec._box || boxOf(spec);
                if (cutBy(b.min[0], b.max[0], box.x0) || cutBy(b.min[0], b.max[0], box.x1) || cutBy(b.min[2], b.max[2], box.z0) || cutBy(b.min[2], b.max[2], box.z1)) sbHiddenSigns.add(spec.index);
            });
            meshes.forEach(mesh => {
                const g = mesh.geometry, tags = g.userData.tags, full = g.userData.fullIndex;
                if (!tags) return;
                const out = [];
                for (let q = 0; q < tags.length; q += 1) {
                    const t = tags[q];
                    const show = t === 0 ? true : t > 0 ? !(box && sbHiddenSigns.has(t - 1)) : t === -1 ? !box : !!box;
                    if (show) for (let k = 0; k < 6; k += 1) out.push(full[q * 6 + k]);
                }
                g.setIndex(out);
            });
        };
        let started = null, lyricKey = null, changedAt = -9, song = {}, glyphs = 1, tickerPos = 0;
        let night = 1, chorusGlow = 0, awake = 0, lastWall = 0, held = null, firstFrame = true;
        const setPalette = p => {
            palette = p || {};
            const accent = hexRgb(palette.accent || '#ff3fae');
            const secondary = hexRgb(palette.secondary || '#2ef2ff');
            // Sung text runs hot so the bloom catches it; rest is a cool grey.
            // The brightest channel sits at the bloom threshold: lit, not smeared.
            const peak = Math.max(0.05, ...accent);
            const hot = mixRgb(accent, [1, 1, 1], 0.18);
            screenMat.uniforms.sung.value.setRGB(...scale(hot, 1.25 / Math.max(0.05, ...hot)));
            const tpeak = Math.max(0.05, ...secondary);
            screenMat.uniforms.trans.value.setRGB(...scale(mixRgb(secondary, [1, 1, 1], 0.25), 0.8 / tpeak));
            screenMat.uniforms.deep.value.setRGB(...scale(mixRgb(accent, [0.1, 0.12, 0.3], 0.6), 0.35));
            night = palette.light ? 0.6 : 1;
            holoMat.uniforms.tint.value.setRGB(...scale(mixRgb(secondary, [0.3, 0.9, 1], 0.5), 0.9));
            holoMat.uniforms.edge.value.setRGB(...accent);
            hardwareMat.uniforms.skyColor.value.setRGB(...scale(mixRgb(accent, [0.3, 0.25, 0.4], 0.6), 0.5));
            lyricKey = null;
        };
        setPalette(palette);

        // One sign's brightness now: ignition, failing tubes, beat.
        const signLevel = (spec, i, t, audio, awakeFor) => {
            if (spec.gain <= 0) return 0;
            const age = awakeFor - igniteAt[i];
            if (age < 0) return 0;
            let k = 1;
            if (age < 0.9) {
                // Striking: a few stutters before it holds.
                const s = noise1(age * 38, spec.index + 3.1);
                k = age < 0.75 ? (s > 0.55 ? 0.9 : 0.05) : 1;
            }
            if (options.flicker !== false && spec.broken > 0) {
                const window = noise1(t * 0.35, spec.index * 7.7);
                if (window > 1 - spec.broken * 0.45) {
                    const buzz = noise1(t * 31, spec.index * 1.9);
                    k *= buzz > 0.45 ? 0.95 : 0.08;
                }
            }
            k *= 0.96 + 0.04 * Math.sin(t * 7.3 + spec.index * 2.1);
            const beatBoost = audio ? (audio.impact || 0) * (spec.beat === Math.floor(t * 0.5) % 3 ? 0.35 : 0.08) : 0;
            return k * (1 + beatBoost + chorusGlow * 0.12) * night;
        };

        // When the last chorus began (from the whole song when the manager gives
        // it, so a seek lands right; else from the live edge).
        let strikeLines = null, strikeTimes = [], wasChorus = false, liveStrike = -1e9;
        let flashOn = false, flashCount = 0;
        const strikeSince = (state, pt) => {
            if (Array.isArray(state.lines) && state.lines.length) {
                if (state.lines !== strikeLines) {
                    strikeLines = state.lines;
                    strikeTimes = state.lines.filter((l, i) => l?.isChorus && !state.lines[i - 1]?.isChorus).map(l => l.startTime).filter(Number.isFinite);
                }
                for (let i = strikeTimes.length - 1; i >= 0; i -= 1) if (strikeTimes[i] <= pt) return { since: pt - strikeTimes[i], start: strikeTimes[i] };
                return { since: -1, start: 0 };
            }
            const chorus = Boolean(state.lyric?.isChorus);
            if (chorus && !wasChorus) liveStrike = Number.isFinite(state.lyric?.start) ? state.lyric.start : pt;
            wasChorus = chorus;
            return { since: pt - liveStrike, start: liveStrike };
        };

        const update = (state = {}) => {
            const t = Number(state.time) || 0;
            // The street wakes on the wall clock: a paused song or a seek back
            // must not leave it dark.
            const wall = (global.performance?.now?.() ?? Date.now()) / 1000;
            if (started === null) { started = wall; lastWall = wall; }
            const realDt = Math.min(0.1, Math.max(0, wall - lastWall));
            lastWall = wall;
            awake = wall - started;
            const still = Boolean(state.options?.reducedMotion);
            const local = still ? 60 : Math.max(awake, 0) + (t % 600);
            const audio = state.audio || {};
            // A sung line stays up a little after it ends; longer gaps show the title card.
            let lyric = state.lyric || null;
            const pt = Number(state.playbackTime ?? t) || 0;
            if (lyric?.line) { held = lyric; held._completed = false; }
            else if (held && Number.isFinite(held.end) && pt >= held.start && pt - held.end < 2.6) {
                if (!held._completed) {
                    held = { ...held, words: (held.words || []).map(w => ({ ...w, progress: 1 })), progress: 1, _completed: true };
                }
                lyric = state.lyric?.next && state.lyric.next !== held.next ? { ...held, next: state.lyric.next } : held;
            } else held = null;
            chorusGlow += ((lyric?.isChorus || lyric?.line?.isChorus ? 1 : 0) - chorusGlow) * Math.min(1, realDt * 2);
            
            // Signs.
            for (let i = 0; i < specs.length; i += 1) levels[i] = signLevel(specs[i], i, local, audio, still ? 60 : awake);
            // Lightning at the top of a chorus: the surge knocks a sign or two out
            // for a blink, then they come back over-bright and stutter.
            // Prefer the alley's own flash so both hit on the same frame; fall back
            // to working out the chorus starts ourselves.
            const flash = typeof ctx.alley?.flash === 'function' ? Number(ctx.alley.flash()) : NaN;
            if (Number.isFinite(flash)) {
                if (flash > 0.08 && !flashOn) flashCount += 1;
                flashOn = flash > 0.08;
                if (flashOn && !still && state.options?.lightning !== false && specs.length) {
                    const h = hashString(`strike:${flashCount}`);
                    levels[h % specs.length] *= 0.1 + Math.min(1, flash) * 1.8;
                    if (flash > 0.3) levels[(h >>> 9) % specs.length] *= 0.05;
                }
            }
            const strike = Number.isFinite(flash) ? { since: -1 } : strikeSince(state, pt);
            if (strike.since >= 0 && strike.since < 1.2 && !still && state.options?.lightning !== false && specs.length) {
                const h = hashString(`strike:${strike.start.toFixed(2)}`);
                const hits = [h % specs.length, (h >>> 9) % specs.length];
                const x = strike.since;
                const k = x < 0.03 ? 1 : x < 0.14 ? 0.04 : x < 0.22 ? 1.9 : x < 0.32 ? 0.15 : x < 0.42 ? 1.3 : x < 0.5 ? 0.3 : 1;
                hits.forEach((i, n) => { if (n === 0 || x > 0.1) levels[i] *= n === 0 ? k : (x < 0.3 ? 0.05 : 1); });
            }
            for (let i = 0; i < 64; i += 1) levelArray[i].set(levels[i * 4], levels[i * 4 + 1], levels[i * 4 + 2], levels[i * 4 + 3]);
            for (let k = 0; k < 16; k += 1) {
                // One tube in a few drops out for a moment now and then.
                const w = noise1(local * 0.21, tubeSeed[k]);
                tubes[k] = options.flicker !== false && w > 0.86 ? (noise1(local * 26, tubeSeed[k] + 9) > 0.5 ? 1 : 0.1) : 1;
            }
            for (let k = 0; k < 4; k += 1) tubeArray[k].set(tubes[k * 4], tubes[k * 4 + 1], tubes[k * 4 + 2], tubes[k * 4 + 3]);
            glowMat.uniforms.time.value = local % 1000;
            glowMat.uniforms.chase.value = (local * (1.6 + chorusGlow * 1.4)) % 1;
            // Screens.
            const key = lyric?.line ? `${lyric.key ?? lineText(lyric)}` : `card:${song.title || ''}`;
            if (state.song || state.track) song = state.song || state.track;
            if (key !== lyricKey) {
                lyricKey = key;
                glyphs = paintLyric(lyricCtx, lyric, song, !!sandboxBox).glyphCount;
                lyricTex.needsUpdate = true;
                // The switch plays out on the wall clock, so a paused song still shows its line.
                changedAt = wall;
                tickerPos = 0;
            }
            const u = screenMat.uniforms;
            if (firstFrame) { u.idle.value = lyric?.line ? 0 : 1; firstFrame = false; }
            let p = 0;
            if (lyric?.line) {
                const words = Array.isArray(lyric.words) ? lyric.words : [];
                if (words.length) {
                    let done = 0;
                    for (const w of words) {
                        const pr = Number.isFinite(w.progress) ? w.progress : 0;
                        if (pr >= 1) done += 1; else { done += clamp(pr); break; }
                    }
                    p = done / Math.max(1, words.length);
                } else p = clamp(Number(lyric.progress) || 0);
            }
            u.progress.value = p; u.vprogress.value = p;
            // Paused, the stage may not draw again: show the line whole, not mid-switch.
            u.age.value = still || state.isPlaying === false ? 9 : Math.max(0, wall - changedAt);
            u.idle.value += ((lyric?.line ? 0 : 1) - u.idle.value) * Math.min(1, realDt * 1.5);
            u.time.value = local % 1000;
            tickerPos = (tickerPos + realDt * 0.045 * (1 + chorusGlow * 0.5)) % 1;
            u.ticker.value = tickerPos;
            u.tickerSpan.value = 1;
            u.energy.value += ((audio.energy || 0) - u.energy.value) * 0.2;
            u.level.value = night * (0.85 + 0.15 * smooth(0, 1.2, local));
            // Hologram: the line after this one; in breaks, the song.
            const nextText = String(lyric?.next?.text || '').trim() || (lyric?.line ? '' : String(song?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, ''));
            if (nextText !== holoKey) { holoKey = nextText; paintHolo(nextText); holoTex.needsUpdate = true; holoAt = wall; }
            holoMat.uniforms.time.value = local % 1000;
            holoAdMat.uniforms.time.value = still ? 3.3 : local % 1000;
            // Out of sight of the main screen, the lyric banners take the line up.
            const shotId = String(state.shot || '');
            const mainInShot = !shotId || /^(street|screen|iso|diorama|facade|crane|hero)/.test(shotId);
            const ha = holoAdMat.uniforms;
            const wantLyric = !mainInShot && lyric?.line ? 1 : 0;
            // A cut switches at once; otherwise it fades.
            const cut = shotId !== lastShot; lastShot = shotId;
            ha.lyricMode.value += (wantLyric - ha.lyricMode.value) * (still || cut ? 1 : Math.min(1, realDt * 4));
            ha.vprogress.value = p;
            ha.age.value = u.age.value;
            const chorus = state.phase ? state.phase === 'chorus' : !!lyric?.isChorus;
            holoChorus += ((chorus ? 1 : 0) - holoChorus) * Math.min(1, realDt * 2);
            ha.level.value = night * (palette.light ? 0.5 : 1) * (1 + 0.25 * holoChorus);
            holoMat.uniforms.age.value = still || state.isPlaying === false ? 9 : wall - holoAt;
            holoMat.uniforms.level.value = night * (nextText ? 1 : 0.25);
            if (glyphs < 0) u.progress.value = 0;
        };

        const bigScreens = screenList.filter(s => s.role !== 3).map(s => ({
            position: add(add(s.centre, s.normal, 5.5), UP, -Math.min(3, s.height * 0.3)),
            color: [0, 0, 0],
            intensityScale: Math.min(2.8, Math.sqrt(s.width * s.height) * 0.21),
            intensity: 0,
            radius: Math.max(s.width, s.height) * 1.4,
            flicker: 1,
            flickerValue: 1,
            halo: false
        }));
        const allAds = holoAds.concat(sbAds).map((a, i) => ({
            ad: a,
            light: {
                position: add(a.centre, UP, -a.height * 0.25),
                color: i % 2 ? [1, 0.3, 0.8] : [0.25, 0.85, 1],
                intensityScale: a.roof ? 0.9 : 0.6,
                intensity: 0,
                radius: Math.min(14, a.height * 0.45),
                flicker: 1,
                flickerValue: 1,
                halo: false
            }
        }));
        const rankedPool = lightSources.map(l => ({
            l,
            v: 0,
            light: {
                position: l.position,
                color: l.color,
                intensityScale: Math.min(4, Math.sqrt(l.spec.width * l.spec.height)) * (l.spec.style === 'box' ? 0.4 : 0.6),
                intensity: 0,
                radius: Math.min(10, Math.max(l.spec.width, l.spec.height) * 1.2 + 1.5),
                flicker: 1,
                flickerValue: 1
            }
        }));
        const sortRankedDesc = (a, b) => b.v - a.v;
        const lightsOut = [];
        const lights = () => {
            lightsOut.length = 0;
            const c = screenMat.uniforms.sung.value;
            const screenLv = screenMat.uniforms.level.value;
            const sr = Math.min(1, c.r * 0.6 + 0.2);
            const sg = Math.min(1, c.g * 0.6 + 0.2);
            const sb = Math.min(1, c.b * 0.6 + 0.3);
            for (let i = 0; i < bigScreens.length; i += 1) {
                const entry = bigScreens[i];
                entry.color[0] = sr; entry.color[1] = sg; entry.color[2] = sb;
                entry.intensity = screenLv * entry.intensityScale;
                lightsOut.push(entry);
            }
            const adLv = holoAdMat.uniforms.level.value;
            for (let i = 0; i < allAds.length; i += 1) {
                const item = allAds[i];
                if (sandboxBox ? item.ad.sbHidden : item.ad.sandboxOnly) continue;
                item.light.intensity = adLv * item.light.intensityScale;
                lightsOut.push(item.light);
            }
            for (let i = 0; i < rankedPool.length; i += 1) {
                const item = rankedPool[i];
                item.v = item.l.base * (levels[item.l.spec.index] || 0);
            }
            rankedPool.sort(sortRankedDesc);
            const invNight = 1 / Math.max(0.01, night);
            for (let i = 0; i < rankedPool.length && lightsOut.length < 32; i += 1) {
                const item = rankedPool[i];
                const idx = item.l.spec.index;
                if (sandboxBox && sbHiddenSigns.has(idx)) continue;
                const k = levels[idx] || 0;
                item.light.intensity = k * item.light.intensityScale;
                item.light.flicker = k * invNight;
                lightsOut.push(item.light);
            }
            return lightsOut;
        };

        const setTier = next => {
            tier = next || tier;
            glowMat.uniforms.halo.value = tier.name === 'energy-saving' ? 1.4 : tier.lens === false ? 1.2 : 0.5;
            screenMat.uniforms.subpixel.value = tier.name === 'ultimate' ? 1 : 0;
        };
        setTier(tier);
        applySandbox(null);

        return {
            group,
            update,
            setPalette,
            setTier,
            setOptions(o) { options = { ...options, ...(o || {}) }; },
            setSandbox(box) { applySandbox(box); lyricKey = null; },
            lights,
            materials: [hardwareMat, glowMat, screenMat, holoMat, holoAdMat],
            dispose() {
                scene?.remove(group);
                disposables.forEach(d => d.dispose?.());
                disposables.length = 0;
            },
            stats() {
                return {
                    signDrawCalls: meshes.length,
                    signTriangles: meshes.reduce((s, m) => s + (m.geometry.index ? m.geometry.index.count / 3 : 0), 0),
                    signs: specs.length, screens: screenList.length, atlas: ATLAS, density: Math.round(density),
                    textureBytes: Math.round(ATLAS * ATLAS_H * 4 * 4 / 3 + ATLAS * ATLAS_H / 16 * 4 * 2 + LYRIC_W * LYRIC_H * LYRIC_SCALE ** 2 * 4 + HA_W * HA_H * 4 * 4 / 3)
                };
            },
            // For tests and the look-dev page.
            _levels: levels, _specs: specs, _canvases: { base: baseSmall, emit, mask: maskSmall, lyric: lyricCanvas }
        };
    };

    const api = { create, _test: { chooseSlots, chooseHoloAds, designSign, hashString, mulberry, layoutRows, wordsOf, graphemes, REGIONS, VERTICAL_SHOPS, HORIZONTAL_SHOPS, ROOF_BRANDS } };
    global.MusicStageKowloonSigns = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
