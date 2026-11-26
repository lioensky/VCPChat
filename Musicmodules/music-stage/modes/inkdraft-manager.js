/*
 * 墨痕（inkdraft）：概念化的实验歌词动画。歌词是墨——字形、字周围的晕和墨团画进同一张场里，
 * 切阈值显影，所以字和墨团挨近了会连起来；纸面有半调网点和砂纸颗粒，字外面一笔一笔冒出演算纸
 * 上的线稿（轨道、晶格、粒子图、演算草稿……）。画面靠剪辑动：一句歌词编成几个镜头，切点卡在词
 * 开唱上（全景、特写、跟字、微距、倾斜、留白远景、拉远、冲镜），镜头永远正对纸面，镜头里只极慢
 * 地蠕动。墨团不往下滴，像对撞实验那样撞开，碎片沿螺旋甩出去。
 *
 * 画面只由播放时间决定（不积分），拖进度、暂停都对。每段（一句歌词或一段间奏）准备一次：
 * 两张 2D 画布（主图：R 字形、G 线稿、B 半调层；编号图：R 字的编号、G 线稿笔序）传成纹理，
 * 之后每帧画三遍（逐字层、平滑场、主遍），由 PixiJS 的渲染器画，见 inkdraft-pixi.js。
 *
 * 负载：默认每秒 30 帧（节能 24、极致 60），绘制缓冲按像素预算，暂停且输入不变时不画。
 */
(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    const Figures = global.MusicStageInkFigures;
    if (!Utils || !Runtime || !Figures) throw new Error('MusicStageModeUtils, MusicStageRuntime and MusicStageInkFigures must load before inkdraft-manager.js');
    // 渲染器和 Pixi 到建舞台时才取（纯函数的测试不需要它们）
    const pixiParts = () => ({ PIXI: global.PIXI, Effects: global.MusicStagePixiEffects, InkPixi: global.MusicStageInkPixi });

    const { clamp, seededRandom, splitGraphemes, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const ID_SCALE = 0.5;
    const MAX_BLOBS = 48;
    const MAX_RINGS = 4;
    const MAX_ACCENT = 5;
    const MAX_CLOUDS = 6;
    const MAX_GLYPHS = 255;
    const TAU = Math.PI * 2;
    // 画质三档，一档一档拉开（极致是满血）：
    //   ratio   画面按每个 CSS 像素几个缓冲像素画（上限 native 个像素；不到 1 就是画小了再放大，字边、网点会软）
    //   smooth  平滑场（墨团、冲击环、灰墨团、云、流场）的分辨率是画面的几分之一（上限 pixels 个像素）
    //   detail  纸纹压印、线稿细节层、墨点飞溅、颗粒每秒跳 6 格；节能档都不要，颗粒和纸纹不动
    const TIERS = Object.freeze({
        ultimate: Object.freeze({ fps: 60, ratio: 2, native: 5.2e6, smooth: 1, pixels: 3.0e6, detail: true }),
        standard: Object.freeze({ fps: 30, ratio: 1, native: 2.4e6, smooth: 0.5, pixels: 0.8e6, detail: true }),
        'energy-saving': Object.freeze({ fps: 24, ratio: 0.7, native: 1.2e6, smooth: 0.34, pixels: 0.3e6, detail: false })
    });
    const tierOf = quality => TIERS[quality] || TIERS.standard;
    const REST_PART = 20;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const V_ROTATE = /[ー～〜—―…‥\-–_()（）「」『』【】〈〉《》［］\[\]]/;
    const V_SMALL = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/;
    const V_PUNCT = /[、。，．,.]/;
    const CREDIT = /^(作词|作詞|作曲|编曲|編曲|词|詞|曲|编|制作人|监制|混音|母带|和声|吉他|贝斯|鼓|演唱|原唱|Lyrics?|Lyricist|Compose[rd]?|Composition|Arrange[rd]?|Arrangement|Producer|Vocals?|Mix(?:ing)?|Master(?:ing)?)\s*(by)?\s*[:：]/i;
    const KANJI = /[\p{Script=Han}々〆ヶ]/u;
    const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
    // 歌词里写在括号里的注音「海鳴(うみな)り」：括号和假名拿掉，记在前面那串汉字的第一个字上，排字时小字注在汉字上面
    const takeRuby = (glyphs) => {
        const out = [];
        for (let i = 0; i < glyphs.length; i += 1) {
            const g = glyphs[i];
            if ((g.text === '(' || g.text === '（') && out.length && KANJI.test(out[out.length - 1].text)) {
                let j = i + 1, kana = '';
                while (j < glyphs.length && KANA.test(glyphs[j].text)) { kana += glyphs[j].text; j += 1; }
                if (kana && j < glyphs.length && (glyphs[j].text === ')' || glyphs[j].text === '）')) {
                    let k = out.length - 1;
                    while (k > 0 && KANJI.test(out[k - 1].text) && !out[k - 1].rubyAt && out.length - k < 4) k -= 1;
                    out[k].ruby = kana;
                    out[k].rubyCount = out.length - k;
                    for (let m = k; m < out.length; m += 1) out[m].rubyAt = true;
                    out[out.length - 1].end = Math.max(out[out.length - 1].end, glyphs[j].end);
                    i = j;
                    continue;
                }
            }
            out.push(g);
        }
        return out;
    };
    const wordSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

    const smooth = (a, b, x) => {
        const t = clamp((x - a) / (b - a), 0, 1);
        return t * t * (3 - 2 * t);
    };
    const hexRgb = (hex, fallback) => {
        const value = String(hex || '').trim();
        const match = /^#?([0-9a-f]{6})$/i.exec(value);
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const pickWeighted = (random, entries) => {
        const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
        let roll = random() * total;
        for (const [value, weight] of entries) {
            roll -= weight;
            if (roll <= 0) return value;
        }
        return entries[entries.length - 1][0];
    };
    const formatTime = (seconds) => {
        const s = Math.max(0, seconds || 0);
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
    };

    /* ───────────────────────── 段落（cue） ───────────────────────── */

    // 一首歌编成首尾相接的段：每句歌词一段；句间超过 4 秒的空当、前奏、尾奏是间奏段，
    // 长间奏切成二十来秒一段。没有歌词的整首都是间奏段，曲名在第一段上。
    const buildCues = (lines, duration) => {
        const cues = [];
        const pushRest = (start, end, title = false) => {
            if (!(end > start + 0.05)) return;
            const length = end - start;
            const parts = length > 36 ? Math.max(2, Math.round(length / REST_PART)) : 1;
            for (let i = 0; i < parts; i += 1) {
                cues.push({ kind: 'rest', start: start + length * i / parts, end: start + length * (i + 1) / parts, title: title && i === 0 });
            }
        };
        // 「作词 : xxx」「作曲 : xxx」这种署名行不当歌词唱：收起来，写在开场歌名那一页的角上（像书的版权页）
        const credits = [];
        const sung = lines.filter((line) => {
            if (!readableText(line.fullText)) return false;
            if (CREDIT.test(String(line.fullText).trim())) { credits.push(String(line.fullText).trim().replace(/\s*[:：]\s*/, ' : ')); return false; }
            return true;
        });
        const tail = Math.max(Number(duration) || 0, 0);
        if (!sung.length) {
            pushRest(0, Math.max(tail, 720), true);
            return cues;
        }
        if (sung[0].startTime > 3) pushRest(0, sung[0].startTime, true);
        sung.forEach((line, i) => {
            const next = sung[i + 1];
            const lineEnd = Math.max(line.endTime, line.vocalEndTime || 0);
            const nextStart = next ? next.startTime : Infinity;
            const start = line.startTime;
            if (nextStart - lineEnd > 4) {
                cues.push({ kind: 'line', start, end: lineEnd + 1.2, line, number: i + 1 });
                if (next) pushRest(lineEnd + 1.2, nextStart, false);
                else pushRest(lineEnd + 1.2, Math.max(tail, lineEnd + 1.2 + REST_PART), false);
            } else {
                cues.push({ kind: 'line', start, end: nextStart, line, number: i + 1 });
            }
        });
        if (cues.length && cues[0].start > 0) cues[0].start = 0;
        if (credits.length && cues[0]?.title) cues[0].credits = credits.slice(0, 6);
        markKeywords(cues, sung);
        markChorus(cues);
        return cues;
    };

    // 关键词：在歌里不同的句子里反复出现的词（意象），每句最多挑两个上强调色；
    // 一句里没有这样的词时，有一半的机会挑这句最长的实词。
    const STOP = new Set(['的', '了', '着', '过', '是', '在', '有', '不', '也', '就', '都', '和', '与', '把', '被', '这', '那', '一个', '我们', '你们', '他们', '自己', '没有', '什么', '怎么', '还是', '只是', '就是', '可是', '如果', '因为', '所以', '已经', 'the', 'and', 'that', 'this', 'with', 'from', 'your', 'have', 'will', 'what', 'when', 'just', 'into', 'like', 'been', 'were', 'they', 'there', 'their', 'about', 'would', 'could']);
    const plainWord = text => String(text || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const wordsOf = (text) => {
        const raw = String(text || '');
        const list = wordSegmenter
            ? Array.from(wordSegmenter.segment(raw)).filter(seg => seg.isWordLike !== false).map(seg => seg.segment)
            : raw.split(/\s+/);
        return list.map(plainWord).filter(Boolean);
    };
    const contentWord = w => !STOP.has(w) && (CJK.test(w) ? Array.from(w).length >= 2 : w.length >= 4);
    const markKeywords = (cues, sung) => {
        const seen = new Set();
        const freq = new Map();
        sung.forEach((line) => {
            const k = plainWord(line.fullText);
            if (!k || seen.has(k)) return;
            seen.add(k);
            new Set(wordsOf(line.fullText).filter(contentWord)).forEach(w => freq.set(w, (freq.get(w) || 0) + 1));
        });
        cues.forEach((cue) => {
            if (cue.kind !== 'line') return;
            const words = Array.from(new Set(wordsOf(cue.line.fullText).filter(contentWord)));
            const ranked = words.map(w => ({ w, f: freq.get(w) || 0 })).sort((a, b) => b.f - a.f || b.w.length - a.w.length);
            const motif = ranked.filter(r => r.f >= 2).slice(0, 2).map(r => r.w);
            if (motif.length) cue.keys = motif;
            else if (ranked.length && seededRandom(`inkdraft:key:${plainWord(cue.line.fullText)}`)() < 0.5) {
                cue.keys = [ranked.slice().sort((a, b) => b.w.length - a.w.length)[0].w];
            } else cue.keys = [];
        });
    };
    // 副歌：歌词自己标了的算；没标的（多数 LRC 都没标）看重复——同一句唱了两次以上就是副歌，
    // 夹在两句副歌中间的一两句也算进去。连着的副歌句是一段，记下这是第几段、哪句是进段的第一句；
    // 重复的那几句记下原文，排版和线稿按原文取随机数，每次唱到都是同一版（像绘本里的复句），镜头每次不同。
    const markChorus = (cues) => {
        const lines = cues.filter(c => c.kind === 'line');
        const counts = new Map();
        lines.forEach((c) => { const k = plainWord(c.line.fullText); if (k.length >= 3) counts.set(k, (counts.get(k) || 0) + 1); });
        const repeated = c => (counts.get(plainWord(c.line.fullText)) || 0) >= 2;
        const flagged = lines.map(c => Boolean(c.line.isChorus) || repeated(c));
        lines.forEach((c, i) => {
            if (flagged[i]) return;
            const before = flagged.slice(Math.max(0, i - 2), i).some(Boolean);
            const after = flagged.slice(i + 1, i + 3).some(Boolean);
            if (before && after && (flagged[i - 1] || flagged[i + 1])) c.bridged = true;
        });
        let section = 0;
        let last = null;
        cues.forEach((c) => {
            if (c.kind !== 'line') { last = c; return; }
            const i = lines.indexOf(c);
            c.chorus = flagged[i] || Boolean(c.bridged);
            if (c.chorus) {
                if (!last || !last.chorus) { section += 1; c.chorusEntry = true; }
                c.chorusSection = section;
                if (repeated(c)) c.motif = plainWord(c.line.fullText);
            }
            last = c;
        });
        lines.forEach((c) => { if (c.chorus) c.lastChorus = c.chorusSection === section; });
    };
    const findCue = (cues, time) => {
        let low = 0, high = cues.length - 1, result = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (time >= cues[mid].start) { result = mid; low = mid + 1; } else high = mid - 1;
        }
        return result;
    };

    /* ───────────────────────── 排版 ───────────────────────── */

    // 一句歌词的字（带演唱时刻），按词切成单元（空格是分隔，标点粘在前一个词后面）。
    const glyphUnits = (cue, title) => {
        let glyphs;
        if (cue.kind === 'line') {
            glyphs = takeRuby(buildGlyphTimeline(cue.line).map(g => ({ text: g.text, start: g.startTime, end: g.endTime })));
        } else if (cue.title && title) {
            glyphs = splitGraphemes(title).map((text, i) => ({ text, start: cue.start + 0.4 + i * 0.06, end: cue.start + 0.7 + i * 0.06 }));
        } else glyphs = [];
        const text = glyphs.map(g => g.text).join('');
        const breaks = new Set();
        const wordLike = new Map();
        if (wordSegmenter && text) {
            for (const seg of wordSegmenter.segment(text)) {
                breaks.add(seg.index);
                wordLike.set(seg.index, seg.isWordLike !== false);
            }
        }
        const units = [];
        let offset = 0;
        let current = null;
        glyphs.forEach((g) => {
            const space = !g.text.trim();
            if (space) { current = null; offset += g.text.length; return; }
            // 标点（不像词的段）粘在前一个词后面
            if (!current || (breaks.has(offset) && wordLike.get(offset) !== false)) {
                current = { glyphs: [], start: g.start, end: g.end };
                units.push(current);
            }
            current.glyphs.push(g);
            current.end = Math.max(current.end, g.end);
            offset += g.text.length;
        });
        // 超长的西文词（没有空格的长串）切成十来个字母一段：不然它一个词就是一整行，
        // 字号被压到最小也装不下、冲出画面；切开的段之间几乎不留空，读起来还是一个词
        const out = [];
        units.forEach((u) => {
            const n = u.glyphs.length;
            if (n <= 13 || u.glyphs.some(g => CJK.test(g.text))) { out.push(u); return; }
            const parts = Math.ceil(n / 10);
            const per = Math.ceil(n / parts);
            for (let i = 0; i < n; i += per) {
                const gs = u.glyphs.slice(i, i + per);
                out.push({ glyphs: gs, start: gs[0].start, end: Math.max(...gs.map(g => g.end)), joins: i + per < n });
            }
        });
        return out;
    };

    // 量一个单元在 100px 字号下的宽度。
    const measureUnits = (ctx, units, fontFor) => {
        units.forEach((unit) => {
            unit.cjk = unit.glyphs.some(g => CJK.test(g.text));
            ctx.font = fontFor(100, unit.cjk);
            unit.glyphs.forEach((g) => { g.w100 = ctx.measureText(g.text).width; });
            unit.w100 = unit.glyphs.reduce((sum, g) => sum + g.w100, 0);
        });
    };

    // 把单元排进若干行，每行字数尽量均匀。
    const splitRows = (units, rows) => {
        const total = units.reduce((sum, u) => sum + u.glyphs.length, 0);
        const result = [];
        let row = [];
        let count = 0;
        units.forEach((unit, i) => {
            const target = total * (result.length + 1) / rows;
            row.push(unit);
            count += unit.glyphs.length;
            const remainingRows = rows - result.length - 1;
            const remainingUnits = units.length - i - 1;
            if (remainingRows > 0 && count >= target - unit.glyphs.length / 2 && remainingUnits >= remainingRows) {
                result.push(row); row = [];
            }
        });
        if (row.length) result.push(row);
        return result;
    };

    // 构图：齐行（每行放大到一样宽，海报排法）、阶梯、主词、竖排、散置。返回字在世界坐标里的位置。
    const composeText = (units, W, H, random, fontScale, cjkShare) => {
        const n = units.reduce((sum, u) => sum + u.glyphs.length, 0);
        if (!n) return { style: 'none', placed: [] };
        const longest = units.reduce((best, u) => (u.glyphs.length > best.glyphs.length ? u : best), units[0]);
        const choices = [['rows', 0.34], ['stair', 0.2]];
        if (units.length >= 2 && longest.glyphs.length >= 2) choices.push(['hero', 0.2]);
        if (cjkShare > 0.6 && n <= 16 && n >= 3) choices.push(['column', 0.16]);
        if (units.length >= 3) choices.push(['scatter', 0.1]);
        const style = pickWeighted(random, choices);
        const lineH = (cjk) => (cjk ? 1.14 : 1.06);
        const placed = [];
        const place = (unit, x, baseline, size) => {
            let cursor = x;
            unit.glyphs.forEach((g) => {
                const w = g.w100 * size / 100;
                placed.push({ g, unit, x: cursor, baseline, size, w });
                cursor += w;
            });
            return cursor;
        };
        const gap = 0.28;
        // 单元后面留的空：汉字 0.12，西文词 0.28，切开的长词段之间几乎不留
        const unitGap = u => (u.cjk ? 0.12 : u.joins ? 0.02 : gap);
        const rowWidth100 = row => row.reduce((sum, u, i) => sum + u.w100 + (i < row.length - 1 ? unitGap(u) * 100 : 0), 0);
        const maxSize = H * 0.3 * fontScale;
        const minSize = H * 0.05;

        if (style === 'column') {
            const glyphs = units.flatMap(u => u.glyphs.map(g => ({ g, unit: u })));
            const cols = Math.max(1, Math.ceil(n / (n > 10 ? 6 : 5)));
            const perCol = Math.ceil(n / cols);
            const size = clamp(Math.min(H * 0.6 / perCol, W * 0.5 / cols / 1.25) * fontScale, minSize, maxSize);
            glyphs.forEach(({ g, unit }, i) => {
                const col = Math.floor(i / perCol);
                const row = i % perCol;
                const x = (cols - 1 - col) * size * 1.3 + (size - g.w100 * size / 100) / 2;
                const entry = { g, unit, x, baseline: (row + 0.88) * size * 1.08, size, w: g.w100 * size / 100 };
                // 竖排的规矩：长音、波浪线、括号转 90 度；小假名往右上靠；句读点放在格子右上角
                if (V_ROTATE.test(g.text)) entry.rot = Math.PI / 2;
                else if (V_SMALL.test(g.text)) { entry.x += size * 0.1; entry.baseline -= size * 0.1; }
                else if (V_PUNCT.test(g.text)) { entry.x += size * 0.5; entry.baseline -= size * 0.58; }
                placed.push(entry);
            });
            return { style, placed };
        }
        if (style === 'hero') {
            const heroIndex = units.indexOf(longest);
            const heroSize = clamp(W * 0.52 / longest.w100 * 100 * fontScale, minSize, H * 0.34 * fontScale);
            const small = clamp(heroSize * 0.3, minSize * 0.7, heroSize * 0.5);
            let baseline = 0;
            const before = units.slice(0, heroIndex);
            const after = units.slice(heroIndex + 1);
            if (before.length) {
                splitRows(before, Math.max(1, Math.ceil(before.reduce((s, u) => s + u.glyphs.length, 0) / 14))).forEach((row) => {
                    baseline += small * lineH(row[0].cjk);
                    let x = 0;
                    row.forEach((u) => { x = place(u, x, baseline, small) + small * unitGap(u); });
                });
                baseline += small * 0.3;
            }
            baseline += heroSize * 0.92;
            place(longest, 0, baseline, heroSize);
            baseline += heroSize * 0.12;
            if (after.length) {
                splitRows(after, Math.max(1, Math.ceil(after.reduce((s, u) => s + u.glyphs.length, 0) / 14))).forEach((row) => {
                    baseline += small * lineH(row[0].cjk);
                    let x = heroSize * 0.04;
                    row.forEach((u) => { x = place(u, x, baseline, small) + small * unitGap(u); });
                });
            }
            return { style, placed };
        }
        // 汉字一行三四个字（Folia 也是这样摞成几行）：一句摞成两三行，字能大一倍，整块方正好构图
        const target = cjkShare > 0.5 ? (n <= 4 ? n : 2.8 + random() * 1.4) : (n <= 12 ? n : 9 + random() * 4);
        const rowsCount = clamp(Math.round(n / target), 1, 4);
        const rows = splitRows(units, rowsCount);
        const widthTarget = W * (0.52 + random() * 0.14);
        const sizes = rows.map(row => clamp(widthTarget / rowWidth100(row) * 100 * fontScale, minSize, maxSize));
        if (style === 'stair' || style === 'scatter') {
            const common = Math.min(...sizes) * (style === 'scatter' ? 1 : 0.96);
            let baseline = 0;
            const step = rows.length > 1 ? Math.max(common * 0.8, (widthTarget - Math.max(...rows.map(r => rowWidth100(r) * common / 100))) / (rows.length - 1)) : 0;
            rows.forEach((row, r) => {
                const size = style === 'scatter' ? common * (0.7 + random() * 0.6) : common;
                baseline += size * lineH(row[0].cjk);
                let x = style === 'scatter' ? random() * widthTarget * 0.35 : r * step;
                row.forEach((u) => { x = place(u, x, baseline, size) + size * unitGap(u); });
            });
            return { style, placed };
        }
        let baseline = 0;
        rows.forEach((row, r) => {
            const size = sizes[r];
            baseline += size * (r ? lineH(row[0].cjk) : 0.9);
            const width = rowWidth100(row) * size / 100;
            let x = (widthTarget - width) / 2;
            row.forEach((u) => { x = place(u, x, baseline, size) + size * unitGap(u); });
            baseline += size * 0.08;
        });
        return { style: 'rows', placed };
    };

    // 歌词里的意象 → 线稿：有对应的就让这一句的第一张图用它
    // 这首歌用哪套意象：设置里指定了就用指定的；自动时按歌定一套（同一首歌每次一样），演算纸多一点
    const sceneFor = (key, wanted) => {
        const scenes = Figures.SCENES;
        if (wanted && scenes[wanted]) return wanted;
        const r = seededRandom(`inkdraft:scene:${key}`)();
        const pool = [['notebook', 0.2], ['rail', 0.1], ['sea', 0.1], ['night', 0.1], ['city', 0.1], ['flora', 0.1], ['letters', 0.1], ['weather', 0.1], ['score', 0.1]];
        let acc = 0;
        for (const [name, w] of pool) { acc += w; if (r < acc) return name; }
        return 'notebook';
    };

    /* ───────────────────────── 逐字图集 ───────────────────────── */

    // 每个字在 2D 画布上单独画一次，取透明度做两遍模糊，存成一格两个通道：
    //   紧的（只糊一两个像素）：放大后切阈值，边还是干净的，和距离场一个道理，大特写不用更大的图；
    //   宽的（糊一圈）：字周围的一团。开唱时墨先是这一团、很快收成字形；没唱到的字和唱过的字周围的网点也从它来。
    // 字是一个个四边形按屏幕原生像素画进墨场的（不再整句烤进一张世界图里再放大），所以边不会被放糊、也不会被邻字的编号框切掉。
    // 模糊自己算（三遍盒式模糊近似高斯），结果和画布的 filter 无关。
    const GLYPH_EM = 96;
    const GLYPH_PAD = 37;
    const GLYPH_CELL = GLYPH_EM + GLYPH_PAD * 2;
    const GLYPH_BASE = 0.86;
    const TIGHT_R = 1;
    const WIDE_R = 8;
    // 笔画密的字（汉字、假名、谚文）宽的那团淡一些：墨是切阈值切出来的，本来就比字形胖一圈，团太浓笔画会糊到一起
    const WIDE_GAIN = 1.5;
    const DENSE_WIDE = 0.6;
    // 字重：细的一档。墨切出来比字形胖一圈，细字切完正好；粗字一胖，密的笔画就糊成一团
    const INK_WEIGHT = 300;
    const GLYPH_FLOATS = 12;
    // 图集里注记的字前面带这个（同一个字，歌词和注记是两种字体）
    const NOTE_PREFIX = '\u0001';
    // 图集里飞溅的墨点：前缀后面是种子（0–5），形状按种子画
    const SPLAT_PREFIX = '\u0002';
    const SPLAT_KINDS = 6;

    // 一摊溅开的墨：中间一块不圆的墨，往外甩几道越来越细的墨线、线头一颗墨珠，再散几颗小点
    const drawSplat = (ctx, seed) => {
        const random = seededRandom(`inkdraft:splat:${seed}`);
        const c = GLYPH_CELL / 2;
        const core = GLYPH_EM * (0.13 + random() * 0.05);
        ctx.beginPath();
        const n = 22;
        for (let i = 0; i <= n; i += 1) {
            const a = (i % n) / n * Math.PI * 2;
            const r = core * (0.72 + random() * 0.5);
            const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.fill();
        // 甩出去的墨线都朝 +x 那边（墨是朝一个方向甩出去的）；摆的时候转到背离字的方向
        const bias = 0;
        const streaks = 5 + Math.floor(random() * 5);
        for (let i = 0; i < streaks; i += 1) {
            const a = bias + (random() - 0.5) * (i < 3 ? 0.9 : 2.4);
            const len = GLYPH_EM * (0.28 + random() * 0.42);
            const w0 = core * (0.32 + random() * 0.25);
            const ca = Math.cos(a), sa = Math.sin(a);
            const px = -sa, py = ca;
            const ex = c + ca * len, ey = c + sa * len;
            ctx.beginPath();
            ctx.moveTo(c + px * w0, c + py * w0);
            ctx.quadraticCurveTo(c + ca * len * 0.5 + px * w0 * 0.3, c + sa * len * 0.5 + py * w0 * 0.3, ex, ey);
            ctx.quadraticCurveTo(c + ca * len * 0.5 - px * w0 * 0.3, c + sa * len * 0.5 - py * w0 * 0.3, c - px * w0, c - py * w0);
            ctx.fill();
            const bead = 1.5 + random() * 3.2;
            const gap = bead + 1 + random() * 5;
            ctx.beginPath();
            ctx.arc(c + ca * (len + gap), c + sa * (len + gap), bead, 0, Math.PI * 2);
            ctx.fill();
        }
        const dots = 6 + Math.floor(random() * 8);
        const limit = GLYPH_CELL / 2 - 6;
        for (let i = 0; i < dots; i += 1) {
            const a = bias + (random() - 0.5) * 2.8;
            const r = core * 1.6 + random() * (limit - core * 1.6);
            ctx.beginPath();
            ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 0.8 + random() * random() * 3.6, 0, Math.PI * 2);
            ctx.fill();
        }
    };

    const blurLines = (src, dst, r, step, lineStep) => {
        const win = r * 2 + 1;
        for (let line = 0; line < GLYPH_CELL; line += 1) {
            const base = line * lineStep;
            let sum = 0;
            for (let i = 0; i <= r; i += 1) sum += src[base + i * step];
            for (let i = 0; i < GLYPH_CELL; i += 1) {
                dst[base + i * step] = sum / win;
                const add = i + r + 1, drop = i - r;
                if (add < GLYPH_CELL) sum += src[base + add * step];
                if (drop >= 0) sum -= src[base + drop * step];
            }
        }
    };
    const boxBlur = (buf, tmp, r) => {
        for (let pass = 0; pass < 3; pass += 1) {
            blurLines(buf, tmp, r, 1, GLYPH_CELL);
            blurLines(tmp, buf, r, GLYPH_CELL, 1);
        }
    };

    const createGlyphSource = () => {
        const canvas = document.createElement('canvas');
        canvas.width = GLYPH_CELL; canvas.height = GLYPH_CELL;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const n = GLYPH_CELL * GLYPH_CELL;
        const tight = new Float32Array(n), wide = new Float32Array(n), tmp = new Float32Array(n);
        const cells = new Map();
        return {
            clear() { cells.clear(); },
            cell(char, family) {
                const note = char.startsWith(NOTE_PREFIX);
                const splat = char.startsWith(SPLAT_PREFIX);
                if (note) char = char.slice(NOTE_PREFIX.length);
                const key = splat ? char : `${note ? 'note' : family}|${char}`;
                const hit = cells.get(key);
                if (hit) return hit;
                ctx.clearRect(0, 0, GLYPH_CELL, GLYPH_CELL);
                ctx.font = note ? `italic 500 ${GLYPH_EM}px ${Figures.NOTE_FONT}` : `${INK_WEIGHT} ${GLYPH_EM}px ${family}`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'alphabetic';
                ctx.fillStyle = '#fff';
                if (splat) drawSplat(ctx, char.slice(SPLAT_PREFIX.length));
                else ctx.fillText(char, GLYPH_CELL / 2, GLYPH_PAD + GLYPH_EM * GLYPH_BASE);
                const px = ctx.getImageData(0, 0, GLYPH_CELL, GLYPH_CELL).data;
                for (let i = 0; i < n; i += 1) { tight[i] = px[i * 4 + 3] / 255; wide[i] = tight[i]; }
                boxBlur(tight, tmp, TIGHT_R);
                boxBlur(wide, tmp, WIDE_R);
                const gain = !note && !splat && CJK.test(char) ? WIDE_GAIN * DENSE_WIDE : WIDE_GAIN;
                const out = new Uint8Array(n * 2);
                for (let i = 0; i < n; i += 1) {
                    out[i * 2] = Math.round(Math.min(1, tight[i]) * 255);
                    out[i * 2 + 1] = Math.round(Math.min(1, wide[i] * gain) * 255);
                }
                if (cells.size > 400) cells.clear();
                cells.set(key, out);
                return out;
            }
        };
    };
    // 第一次用时才建（测试里没有 document）
    let glyphSourceInstance = null;
    const glyphSource = {
        clear() { glyphSourceInstance?.clear(); },
        cell(char, family) { glyphSourceInstance = glyphSourceInstance || createGlyphSource(); return glyphSourceInstance.cell(char, family); }
    };

    // 一句的字拼成一张两通道图集（R 紧、G 宽），同一个字只占一格；返回每个字那一格的 uv 框（左、上、右、下）
    const buildAtlas = (chars, family) => {
        const unique = Array.from(new Set(chars));
        const cols = Math.max(1, Math.min(16, Math.ceil(Math.sqrt(unique.length))));
        const rows = Math.max(1, Math.ceil(unique.length / cols));
        const width = cols * GLYPH_CELL, height = rows * GLYPH_CELL;
        const data = new Uint8Array(width * height * 2);
        const rects = new Map();
        unique.forEach((char, order) => {
            const col = order % cols, row = Math.floor(order / cols);
            const cell = glyphSource.cell(char, family);
            for (let y = 0; y < GLYPH_CELL; y += 1) {
                data.set(cell.subarray(y * GLYPH_CELL * 2, (y + 1) * GLYPH_CELL * 2), ((row * GLYPH_CELL + y) * width + col * GLYPH_CELL) * 2);
            }
            rects.set(char, [col / cols, row / rows, (col + 1) / cols, (row + 1) / rows]);
        });
        return { data, width, height, rects };
    };

    /* ───────────────────────── 一段的准备 ───────────────────────── */

    const rectsOverlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    const unionBox = (boxes) => boxes.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])],
        [Infinity, Infinity, -Infinity, -Infinity]);

    const prepareCue = (cue, index, ctx) => {
        const { W, H, aspect, family, settings, trackKey, title, mainCanvas, idsCanvas } = ctx;
        const cueSeed = `inkdraft:${trackKey}:${index}:${cue.kind}:${cue.start.toFixed(2)}`;
        // 重复的副歌句：版式和线稿按原文取数，每次一样；镜头另取一串数，每次不同
        const random = seededRandom(cue.motif ? `inkdraft:${trackKey}:motif:${cue.motif}` : cueSeed);
        const shotRandom = cue.motif ? seededRandom(`${cueSeed}:shots`) : random;
        // 字都用细的一档（INK_WEIGHT）：墨切阈值后比字形胖一圈，细字切完正好
        const fontFor = size => `${INK_WEIGHT} ${size.toFixed(1)}px ${family}`;
        const main = mainCanvas.getContext('2d', { alpha: false });
        const ids = idsCanvas.getContext('2d', { alpha: false });
        main.globalCompositeOperation = 'source-over';
        ids.globalCompositeOperation = 'source-over';
        main.fillStyle = '#000'; main.fillRect(0, 0, W, H);
        ids.fillStyle = '#000'; ids.fillRect(0, 0, idsCanvas.width, idsCanvas.height);

        // 字
        const units = glyphUnits(cue, title);
        measureUnits(main, units, fontFor);
        const total = units.reduce((s, u) => s + u.glyphs.length, 0);
        const cjkShare = total ? units.reduce((s, u) => s + u.glyphs.filter(g => CJK.test(g.text)).length, 0) / total : 0;
        // 副歌字大一号，最后一段副歌再大一点
        const chorusScale = cue.chorus ? (cue.lastChorus ? 1.22 : 1.14) : 1;
        const composed = composeText(units, W, H, random, settings.fontScale * chorusScale, cjkShare);
        let placed = composed.placed;
        let textBox = null;
        if (placed.length) {
            const raw = unionBox(placed.map(p => [p.x, p.baseline - p.size * 0.88, p.x + p.w, p.baseline + p.size * 0.2]));
            const bw = raw[2] - raw[0], bh = raw[3] - raw[1];
            const fit = Math.min(1, (W * 0.62) / bw, (H * 0.56) / bh);
            const cx = W * (0.5 + (random() - 0.5) * 0.12);
            const cy = H * (0.5 + (random() - 0.5) * 0.1);
            placed = placed.map(p => ({
                ...p,
                x: cx + (p.x - (raw[0] + bw / 2)) * fit,
                baseline: cy + (p.baseline - (raw[1] + bh / 2)) * fit,
                size: p.size * fit,
                w: p.w * fit
            }));
            placed.forEach((p) => { p.box = [p.x, p.baseline - p.size * 0.88, p.x + p.w, p.baseline + p.size * 0.2]; });
            textBox = unionBox(placed.map(p => p.box));
        }
        // 注音（Folia 没有）：小字假名排在那串汉字正上方，和汉字同时出现；不参与取景
        const rubies = [];
        placed.forEach((p, i) => {
            if (!p.g.ruby) return;
            let last = p;
            for (let k = 1; k < (p.g.rubyCount || 1); k += 1) { const q = placed[i + k]; if (q && q.baseline === p.baseline) last = q; }
            const chars = splitGraphemes(p.g.ruby);
            const rs = p.size * 0.32;
            main.font = fontFor(rs);
            const ws = chars.map(c => main.measureText(c).width);
            const total = ws.reduce((a, b) => a + b, 0);
            const runW = last.x + last.w - p.x;
            const track = chars.length > 1 ? Math.max(0, (runW - total) / chars.length) : 0;
            let x = p.x + (runW - total - track * (chars.length - 1)) / 2;
            const baseline = p.baseline - p.size * 0.92;
            chars.forEach((c, k) => {
                const r = { g: { text: c, start: p.g.start, end: Math.max(p.g.end, last.g.end) }, unit: p.unit, x, baseline, size: rs, w: ws[k] };
                r.box = [r.x, baseline - rs * 0.88, r.x + r.w, baseline + rs * 0.2];
                rubies.push(r);
                x += ws[k] + track;
            });
        });
        if (rubies.length) textBox = unionBox([textBox, ...rubies.map(r => r.box)]);
        // 字形还烤进 R 通道一份：只给换句时上一句的残影、墨漫的口子用；这一句的字由逐字层按屏幕像素画。
        // 逐字层：每个字一个实例（世界里那一格的中心、边长、种子；开唱、唱完、是不是关键词；图集里的 uv 框）
        main.textBaseline = 'alphabetic';
        main.fillStyle = 'rgb(255,0,0)';
        main.globalCompositeOperation = 'lighter';
        const keys = new Set(cue.keys || []);
        // 逐字层的实例先记下（世界里那一格的中心、边长、转角；开唱、唱完、关键词、是不是注记；图集里的字），注记排好以后一起建图集
        const glyphEntries = [];
        // 同样模糊半径的一串字（一行字多半同样大）先不带模糊、按半浓度画进草稿，整串模糊一次、叠两遍回来（见 Figures.softLayer），
        // 不用每个字开一层滤镜
        const soft = Figures.softLayer(main);
        soft.ctx.save();
        soft.ctx.globalCompositeOperation = 'lighter';
        soft.ctx.fillStyle = 'rgb(128,0,0)';
        soft.ctx.textBaseline = 'alphabetic';
        let softBlur = '', softBox = null;
        const flushSoft = () => {
            if (softBox) Figures.flushSoft(main, soft, softBox, softBlur, 2);
            softBox = null;
        };
        placed.concat(rubies).forEach((p) => {
            const blur = `blur(${Math.max(0.8, p.size * 0.02).toFixed(2)}px)`;
            if (blur !== softBlur) { flushSoft(); softBlur = blur; }
            soft.ctx.font = fontFor(p.size);
            soft.ctx.fillText(p.g.text, p.x, p.baseline);
            // 字可能伸出排版框（斜体、长撇）：框外再留一个字高，加上模糊的三倍半径
            const pad = p.size + Math.max(0.8, p.size * 0.02) * 3 + 4;
            const b = [p.x - pad, p.baseline - p.size - pad, p.x + p.w + pad, p.baseline + pad];
            softBox = softBox ? [Math.min(softBox[0], b[0]), Math.min(softBox[1], b[1]), Math.max(softBox[2], b[2]), Math.max(softBox[3], b[3])] : b;
            const s = p.size / GLYPH_EM;
            glyphEntries.push({
                key: p.g.text, cx: p.x + p.w / 2, cy: p.baseline - (GLYPH_PAD + GLYPH_EM * GLYPH_BASE) * s + GLYPH_CELL * s / 2,
                cell: GLYPH_CELL * s, rot: p.rot || 0, start: p.g.start, end: p.g.end,
                kw: keys.size && keys.has(plainWord(p.unit?.glyphs.map(g => g.text).join(''))) ? 1 : 0, note: 0
            });
        });
        flushSoft();
        soft.ctx.restore();
        main.globalCompositeOperation = 'source-over';
        // 飞溅的墨点（Folia 没有）：关键词落笔、或者拖长的那个字，墨甩出去一摊——一块墨、几道甩出去的细线、线头的墨珠、几颗散点。
        // 每句最多两摊，按字边的像素画（图集里一格），关键词溅出来的是强调色
        if (settings.spatter && cue.kind === 'line') {
            // 单独一串随机数：开关这一项，别的东西摆的位置不变
            const random = seededRandom(`inkdraft:spatter:${trackKey}:${index}:${cue.start.toFixed(2)}`);
            const lyric = glyphEntries.slice();
            const picks = [];
            lyric.forEach((e, i) => {
                const next = lyric[i + 1];
                const kwTail = e.kw && (!next || !next.kw || next.start - e.end > 0.05);
                const held = e.end - e.start >= 0.75;
                if (kwTail || (held && random() < 0.45)) picks.push(e);
            });
            picks.sort((a, b) => (b.kw - a.kw) || ((b.end - b.start) - (a.end - a.start)));
            picks.slice(0, 2).forEach((e) => {
                // 溅在字旁边的空处：试几个方向，墨点那一摊（按半径 0.8 字高算）不能碰到任何一个字的框；都碰到就不溅
                const size = e.cell * GLYPH_EM / GLYPH_CELL;
                const scale = 0.7 + random() * 0.3;
                const reach = size * 0.8 * scale;
                const first = random() * TAU;
                let a = null;
                for (let k = 0; k < 12 && a === null; k += 1) {
                    const t = first + k * TAU / 12;
                    const px = e.cx + Math.cos(t) * size * 0.85, py = e.cy + Math.sin(t) * size * 0.85;
                    const box = [px - reach * 0.55, py - reach * 0.55, px + reach * 0.55, py + reach * 0.55];
                    if (!placed.some(p => rectsOverlap(box, p.box))) a = t;
                }
                if (a === null) return;
                glyphEntries.push({
                    key: SPLAT_PREFIX + Math.floor(random() * SPLAT_KINDS), cx: e.cx + Math.cos(a) * size * 0.85, cy: e.cy + Math.sin(a) * size * 0.85,
                    cell: e.cell * scale, rot: a, start: e.start + 0.04, end: cue.end, kw: e.kw, note: 2
                });
            });
        }

        // 单元的框（镜头、强调色墨团用）
        const unitBoxes = units.map((unit) => {
            const boxes = placed.filter(p => p.unit === unit).map(p => p.box);
            return boxes.length ? { unit, box: unionBox(boxes), size: Math.max(...placed.filter(p => p.unit === unit).map(p => p.size)) } : null;
        }).filter(Boolean);

        // 全景：把字框进画面，字周围留白。
        const wideH = textBox
            ? clamp(Math.max((textBox[3] - textBox[1]) / 0.8, (textBox[2] - textBox[0]) / aspect / 0.86), H * 0.4, H)
            : H * 0.92;
        const wideC = textBox ? [(textBox[0] + textBox[2]) / 2, (textBox[1] + textBox[3]) / 2] : [W / 2, H / 2];
        const wideRect = [wideC[0] - wideH * aspect / 2, wideC[1] - wideH / 2, wideC[0] + wideH * aspect / 2, wideC[1] + wideH / 2];

        // 空着的大格：线稿和墨团摆在这里。
        const cols = aspect > 1.4 ? 4 : 3;
        const rowsN = aspect > 1.4 ? 3 : 4;
        // 全景把字撑满了：线稿摆在全景的边上和外面（一半露在画里），拉远、留白远景时整个看得见
        const spill = [(wideRect[2] - wideRect[0]) * 0.28, (wideRect[3] - wideRect[1]) * 0.3];
        const region = cue.kind === 'rest' ? [W * 0.06, H * 0.06, W * 0.94, H * 0.94]
            : [Math.max(0, wideRect[0] - spill[0]), Math.max(0, wideRect[1] - spill[1]), Math.min(W, wideRect[2] + spill[0]), Math.min(H, wideRect[3] + spill[1])];
        const cw = (region[2] - region[0]) / cols, ch = (region[3] - region[1]) / rowsN;
        const inflated = textBox ? [textBox[0] - H * 0.03, textBox[1] - H * 0.03, textBox[2] + H * 0.03, textBox[3] + H * 0.03] : null;
        const cells = [];
        for (let r = 0; r < rowsN; r += 1) for (let c = 0; c < cols; c += 1) {
            const rect = [region[0] + c * cw, region[1] + r * ch, region[0] + (c + 1) * cw, region[1] + (r + 1) * ch];
            if (rect[0] < 0 || rect[1] < 0 || rect[2] > W || rect[3] > H) continue;
            if (inflated && rectsOverlap(rect, inflated)) continue;
            cells.push(rect);
        }
        for (let i = cells.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            [cells[i], cells[j]] = [cells[j], cells[i]];
        }

        // 半调层：背景纹样 + 垫在字后面的一张大图（粗线，只进网点）。
        const scene = Figures.SCENES[ctx.scene] || Figures.SCENES.notebook;
        const backdrop = pickWeighted(random, scene.backdrops);
        main.globalCompositeOperation = 'lighter';
        // 纸底：一层很淡的格子（信笺、乐谱是横线），压在所有纹样下面，画面暗处不再是空的。
        // 单独一串随机数：加这一层不改别的东西的位置
        if (backdrop !== 'graph' && backdrop !== 'ruled') {
            const g = seededRandom(`inkdraft:ground:${trackKey}:${index}`);
            const lined = ctx.scene === 'letters' || ctx.scene === 'score';
            const step = H / (lined ? 14 : 16 + Math.floor(g() * 6));
            main.save();
            main.translate(W / 2, H / 2);
            main.rotate((g() - 0.5) * 0.08);
            // 线要比网点格宽，网点才连成一道虚线格；太细会被网点漏掉
            main.strokeStyle = 'rgb(0,0,68)';
            main.lineWidth = Math.max(2, H * 0.0036);
            main.beginPath();
            for (let y = -H; y < H; y += step) { main.moveTo(-W, y); main.lineTo(W, y); }
            if (!lined) for (let x = -W; x < W; x += step) { main.moveTo(x, -H); main.lineTo(x, H); }
            main.stroke();
            main.restore();
        }
        if (backdrop === 'band') {
            const y = (textBox ? (textBox[1] + textBox[3]) / 2 : H / 2) + (random() - 0.5) * H * 0.2;
            // 色带：一道边是直的、略斜的网点带（版面里压的那一道灰），不是渐变的雾
            const half = H * (0.1 + random() * 0.08);
            main.save();
            main.translate(W / 2, y);
            main.rotate((random() - 0.5) * 0.12);
            main.fillStyle = `rgb(0,0,${Math.round(70 + random() * 30)})`;
            main.filter = `blur(${(H * 0.002).toFixed(1)}px)`;
            main.fillRect(-W, -half, W * 2, half * 2);
            main.filter = 'none';
            main.restore();
        } else if (backdrop === 'graph') {
            main.strokeStyle = 'rgb(0,0,72)';
            main.lineWidth = Math.max(1, H * 0.0015);
            const step = H / 18;
            main.beginPath();
            for (let x = (W % step) / 2; x < W; x += step) { main.moveTo(x, 0); main.lineTo(x, H); }
            for (let y = (H % step) / 2; y < H; y += step) { main.moveTo(0, y); main.lineTo(W, y); }
            main.stroke();
        } else if (backdrop === 'arcs') {
            main.strokeStyle = 'rgb(0,0,84)';
            main.lineWidth = H * 0.006;
            const ox = random() < 0.5 ? 0 : W, oy = random() < 0.5 ? 0 : H;
            main.beginPath();
            for (let r = H * 0.2; r < W * 1.2; r += H * 0.07) { main.moveTo(ox + r, oy); main.arc(ox, oy, r, 0, TAU); }
            main.stroke();
        } else if (backdrop === 'sleepers') {
            // 枕木：一道斜穿画面的轨道，两根钢轨、一排粗的枕木
            const y = (textBox ? (textBox[1] + textBox[3]) / 2 : H / 2) + (random() < 0.5 ? -1 : 1) * H * (0.18 + random() * 0.1);
            main.save();
            main.translate(W / 2, y);
            main.rotate((random() - 0.5) * 0.3);
            main.fillStyle = 'rgb(0,0,82)';
            main.strokeStyle = 'rgb(0,0,96)';
            const gauge = H * 0.09, tie = H * 0.022, gap = H * 0.06;
            for (let x = -W; x < W; x += gap) main.fillRect(x, -gauge * 0.95, tie, gauge * 1.9);
            main.lineWidth = H * 0.009;
            main.beginPath();
            main.moveTo(-W, -gauge * 0.6); main.lineTo(W, -gauge * 0.6);
            main.moveTo(-W, gauge * 0.6); main.lineTo(W, gauge * 0.6);
            main.stroke();
            main.restore();
        } else if (backdrop === 'swell') {
            // 涌浪：一排平行的浪线，越往下越密
            main.strokeStyle = 'rgb(0,0,80)';
            main.lineWidth = H * 0.006;
            const k = TAU / (W * (0.18 + random() * 0.1));
            const phase = random() * TAU;
            main.beginPath();
            for (let i = 0; i < 14; i += 1) {
                const y0 = H * (0.1 + Math.pow(i / 13, 0.8) * 0.95);
                const amp = H * (0.01 + i * 0.002);
                for (let x = 0; x <= W; x += 8) {
                    const y = y0 + Math.sin(x * k + phase + i * 0.9) * amp;
                    if (x) main.lineTo(x, y); else main.moveTo(x, y);
                }
            }
            main.stroke();
        } else if (backdrop === 'trails') {
            // 星轨：围着画外一点转的一段段弧，长短不一
            main.strokeStyle = 'rgb(0,0,88)';
            main.lineWidth = H * 0.004;
            main.lineCap = 'round';
            const ox = W * (random() < 0.5 ? -0.1 : 1.1), oy = H * (-0.2 - random() * 0.3);
            const span = 0.18 + random() * 0.12;
            for (let i = 0; i < 70; i += 1) {
                const r = H * (0.3 + random() * 1.6);
                const a = random() * TAU;
                main.beginPath();
                main.arc(ox, oy, r, a, a + span * (0.5 + random()));
                main.stroke();
            }
        } else if (backdrop === 'blocks') {
            // 街区：斜着的一张路网，路是粗的灰带，街区是留白
            main.save();
            main.translate(W / 2, H / 2);
            main.rotate((random() - 0.5) * 0.6);
            main.strokeStyle = 'rgb(0,0,78)';
            main.lineWidth = H * 0.018;
            const bx = H * (0.22 + random() * 0.1), by = H * (0.16 + random() * 0.08);
            main.beginPath();
            for (let x = -W; x < W; x += bx) { main.moveTo(x, -W); main.lineTo(x, W); }
            for (let y = -W; y < W; y += by) { main.moveTo(-W, y); main.lineTo(W, y); }
            main.stroke();
            main.lineWidth = H * 0.04;
            main.beginPath(); main.moveTo(-W, by * 0.5); main.lineTo(W, by * 0.5); main.stroke();
            main.restore();
        } else if (backdrop === 'stems') {
            // 草茎：从画面底下长上来的几根弯的茎，有的带一片叶
            main.strokeStyle = 'rgb(0,0,84)';
            main.lineWidth = H * 0.007;
            main.lineCap = 'round';
            for (let i = 0; i < 9; i += 1) {
                const x0 = W * random(), lean = (random() - 0.5) * W * 0.25, top = H * (0.05 + random() * 0.5);
                main.beginPath();
                main.moveTo(x0, H * 1.05);
                main.quadraticCurveTo(x0 + lean * 0.2, (H + top) / 2, x0 + lean, top);
                main.stroke();
                if (random() < 0.6) {
                    const ly = (H + top) / 2, lx = x0 + lean * 0.35;
                    main.beginPath();
                    main.ellipse(lx + H * 0.04, ly, H * 0.05, H * 0.016, -0.6, 0, TAU);
                    main.stroke();
                }
            }
        } else if (backdrop === 'ruled') {
            // 信纸的横格和一道页边线
            main.strokeStyle = 'rgb(0,0,74)';
            main.lineWidth = Math.max(1, H * 0.0022);
            const step = H / 14, off = random() * step;
            main.beginPath();
            for (let y = off; y < H; y += step) { main.moveTo(0, y); main.lineTo(W, y); }
            main.stroke();
            main.strokeStyle = 'rgb(0,0,92)';
            main.lineWidth = H * 0.004;
            const mx = W * (0.08 + random() * 0.08);
            main.beginPath(); main.moveTo(mx, 0); main.lineTo(mx, H); main.stroke();
        } else if (backdrop === 'radial') {
            // 放射的赤经线：从画外的天极放出来的一束直线
            main.strokeStyle = 'rgb(0,0,72)';
            main.lineWidth = Math.max(1, H * 0.002);
            const ox = W * (0.2 + random() * 0.6), oy = -H * 0.3;
            main.beginPath();
            for (let i = 0; i < 24; i += 1) { const a = i / 24 * Math.PI; main.moveTo(ox, oy); main.lineTo(ox + Math.cos(a) * W * 2, oy + Math.sin(a) * W * 2); }
            for (let r = H * 0.6; r < W * 1.6; r += H * 0.22) { main.moveTo(ox + r, oy); main.arc(ox, oy, r, 0, Math.PI); }
            main.stroke();
        }
        main.globalCompositeOperation = 'source-over';
        if (settings.figures) {
            // 垫在字后面的大图：粗线、只进网点，浓到网点刚好相连（全景里字占满画面时，看得见的主要是它）
            const tonePen = Figures.createPen(main, null, ID_SCALE, { tone: true, lineWidth: H * 0.026, toneLevel: 0.64, soft: H * 0.004 });
            Figures.drawFigure(tonePen, scene.tone[Math.floor(random() * scene.tone.length)],
                wideC[0], wideC[1], H * (0.36 + random() * 0.1), (random() - 0.5) * 0.4, random);
            // 多数段再垫一张小一点的，偏到一边、露一半在画外
            if (random() < 0.75) {
                const side = random() < 0.5 ? -1 : 1;
                Figures.drawFigure(tonePen, scene.tone[Math.floor(random() * scene.tone.length)],
                    wideC[0] + side * W * (0.3 + random() * 0.12), wideC[1] + (random() - 0.5) * H * 0.4, H * (0.22 + random() * 0.08), random() * TAU, random);
            }
            tonePen.flush();
        }

        // 版面零件（规线、裁切标记、行号、时间码）和线稿，一笔一笔冒出来。
        const notes = [];
        const penWidth = Math.max(2, H * 0.0068);
        const pen = Figures.createPen(main, ids, ID_SCALE, { lineWidth: penWidth, soft: H * 0.002, fringe: H * 0.018, startOrder: 1, notes });
        if (textBox) {
            const pad = H * 0.035;
            const [x0, y0, x1, y1] = [textBox[0] - pad, textBox[1] - pad, textBox[2] + pad, textBox[3] + pad];
            pen.place(0, 0, 1, 0);
            const mark = H * 0.022;
            pen.segments([[[x0 - mark, y0], [x0 - mark * 0.3, y0]], [[x0, y0 - mark], [x0, y0 - mark * 0.3]],
                [[x1 + mark * 0.3, y1], [x1 + mark, y1]], [[x1, y1 + mark * 0.3], [x1, y1 + mark]]]);
            if (random() < 0.7) pen.line([[x0, y1 + pad * 0.6], [x0 + (x1 - x0) * (0.4 + random() * 0.6), y1 + pad * 0.6]]);
            pen.place(x0, y0 - H * 0.03, H, 0);
            pen.note(cue.kind === 'line' ? scene.mark(cue.number, random) : scene.interlude, 0, 0, 0.018, 'left');
            pen.place(x1, y1 + H * 0.045, H, 0);
            pen.note(formatTime(cue.start), 0, 0, 0.016, 'right');
            // 署名行（作词、作曲……）排在歌名下面左边，一行一行跟着笔出来
            // 下面放不下（竖排的歌名很高）就排在字块右边
            const creditList = cue.credits || [];
            const below = y1 + H * (0.085 + creditList.length * 0.03) < H * 0.94;
            creditList.forEach((line, i) => {
                if (below) pen.place(x0, y1 + H * (0.085 + i * 0.03), H, 0);
                else pen.place(x1 + H * 0.05, y0 + H * (0.06 + i * 0.03), H, 0);
                pen.note(line, 0, 0, 0.017, 'left');
            });
            // 时间轴括号：字块左边一道竖括号，每个词开唱的位置一格刻度，括号顶上记段号
            if (cue.kind === 'line' && unitBoxes.length > 1 && random() < 0.6) {
                const bx = x0 - pad * 0.9;
                const hook = pad * 0.5;
                pen.place(0, 0, 1, 0);
                pen.line([[bx + hook, y0], [bx, y0], [bx, y1], [bx + hook, y1]]);
                const span = Math.max(0.1, cue.end - cue.start);
                pen.segments(unitBoxes.map((u) => {
                    const y = y0 + (y1 - y0) * clamp((u.unit.start - cue.start) / span, 0, 1);
                    return [[bx - hook * 0.5, y], [bx + hook * 0.35, y]];
                }));
                pen.dot(bx, y0 + (y1 - y0) * (0.15 + random() * 0.5), pad * 0.32);
                pen.place(bx - hook * 0.6, y0 - H * 0.018, H, 0);
                pen.note(`${String(cue.number).padStart(2, '0')} / ${formatTime(cue.start).slice(0, 5)}`, 0, 0, 0.016, 'right');
            }
        }
        const figures = [];
        const usedKinds = [];
        if (settings.figures) {
            const want = cue.kind === 'rest' ? 4 + Math.floor(random() * 3) : Math.min(4, Math.max(1, Math.round(cells.length * (0.35 + random() * 0.2))));
            cells.slice(0, want).forEach((rect) => {
                const r = Math.min(rect[2] - rect[0], rect[3] - rect[1]) * (0.36 + random() * 0.1) * settings.figureScale;   // 大一些，边上可以压到字（Folia 的图也是这样压着字）
                // 线稿从这首歌的意象场景里挑；同一句不重复
                const pool = scene.kinds.filter(k => !usedKinds.includes(k));
                const kind = (pool.length ? pool : scene.kinds)[Math.floor(random() * (pool.length || scene.kinds.length))];
                usedKinds.push(kind);
                const fx = (rect[0] + rect[2]) / 2 + (random() - 0.5) * (rect[2] - rect[0]) * 0.15;
                const fy = (rect[1] + rect[3]) / 2 + (random() - 0.5) * (rect[3] - rect[1]) * 0.15;
                // 笔宽跟着图的大小：大图用原来的笔，小图细一些（常见的图 r≈0.1H，笔宽约原来的七成）
                pen.setWidth(clamp(r * 0.045, penWidth * 0.55, penWidth) * (cue.kind === 'rest' ? 0.72 : 1));
                const frot = (random() - 0.5) * 0.35;
                const order0 = pen.order;
                Figures.drawFigure(pen, kind, fx, fy, r, frot, random);
                const order1 = pen.order;
                // 细节层（Folia 没有）：很细的辅助线——一段虚线构造圆、一个对位十字。
                // 线细到远景里被图的 mip 平均掉、切不过阈值，自己就淡没了；推近才看得清（不用另算远近）
                // 节能档不画这一层，但随机数照样取，构图和别的档一样
                {
                    const drawDetail = settings.figureDetail !== false;
                    if (drawDetail) pen.setWidth(Math.max(1, penWidth * 0.32));
                    if (drawDetail) pen.place(fx, fy, r, frot);
                    const a0 = random() * TAU, span = 1.2 + random() * 1.6;
                    const arc = [];
                    for (let k = 0; k < 18; k += 2) {
                        const t0 = a0 + span * k / 18, t1 = a0 + span * (k + 1) / 18;
                        arc.push([[Math.cos(t0) * 1.14, Math.sin(t0) * 1.14], [Math.cos(t1) * 1.14, Math.sin(t1) * 1.14]]);
                    }
                    if (drawDetail) pen.segments(arc);
                    // 对位十字：只两道细线（带小圈、排线的版本在远景里会糊成白点，不要）
                    const cxr = (random() < 0.5 ? -1 : 1) * 1.05, cyr = (random() < 0.5 ? -1 : 1) * 0.95;
                    if (drawDetail) pen.segments([[[cxr - 0.18, cyr], [cxr + 0.18, cyr]], [[cxr, cyr - 0.18], [cxr, cyr + 0.18]]]);
                }
                figures.push({ x: fx, y: fy, r, o0: order0, o1: order1 });
            });
        }
        pen.flush();
        const strokes = Math.max(1, pen.order - 1);
        const length = cue.end - cue.start;
        const strokeStep = clamp(length * 0.6 / strokes, 0.04, 0.2);
        const strokeStart = cue.start + 0.12;
        // 每张线稿从哪一刻开始画、哪一刻画完（间奏的镜头跟着笔走）
        figures.forEach((f) => { f.t0 = strokeStart + (f.o0 - 1) * strokeStep; f.t1 = strokeStart + (f.o1 - 1) * strokeStep; });

        // 注记一个字一个字排开，到它那一笔的时刻出现（和线稿同一支笔）
        main.save();
        notes.forEach((n) => {
            main.font = `italic 500 ${n.size.toFixed(1)}px ${Figures.NOTE_FONT}`;
            const chars = Array.from(n.text);
            const widths = chars.map(c => main.measureText(c).width);
            const total = widths.reduce((sum, w) => sum + w, 0);
            let x = n.align === 'left' ? 0 : n.align === 'right' ? -total : -total / 2;
            const c = Math.cos(n.rot), sn = Math.sin(n.rot);
            const sc = n.size / GLYPH_EM;
            // 竖直方向锚点是字的中线：基线在中线下面 0.35 字高
            const dy = n.size * 0.35 - (GLYPH_PAD + GLYPH_EM * GLYPH_BASE) * sc + GLYPH_CELL * sc / 2;
            chars.forEach((ch, i) => {
                const lx = x + widths[i] / 2;
                x += widths[i];
                if (!ch.trim()) return;
                glyphEntries.push({
                    key: NOTE_PREFIX + ch, cx: n.x + lx * c - dy * sn, cy: n.y + lx * sn + dy * c, cell: GLYPH_CELL * sc, rot: n.rot,
                    start: strokeStart + (n.order - 1) * strokeStep, end: cue.end, kw: 0, note: 1
                });
            });
        });
        main.restore();
        const atlas = buildAtlas(glyphEntries.map(e => e.key), family);
        const glyphInst = new Float32Array(glyphEntries.length * GLYPH_FLOATS);
        glyphEntries.forEach((e, i) => {
            const o = i * GLYPH_FLOATS;
            glyphInst.set([e.cx, e.cy, e.cell, e.rot, e.start, e.end, e.kw, e.note], o);
            glyphInst.set(atlas.rects.get(e.key), o + 8);
        });

        // 墨团：一个大墨团带几颗小墨滴，摆在空格里（线稿没占的那些）；对撞；压在词上的强调色墨团。
        const freeCells = cells.slice(figures.length);
        const massCell = freeCells[0] || cells[0];
        const mass = massCell ? {
            x: (massCell[0] + massCell[2]) / 2, y: (massCell[1] + massCell[3]) / 2,
            r: Math.min(massCell[2] - massCell[0], massCell[3] - massCell[1]) * (0.12 + random() * 0.05),
            sats: Array.from({ length: 3 + Math.floor(random() * 2) }, () => ({
                orbit: 1.6 + random() * 0.9, speed: (0.12 + random() * 0.22) * (random() < 0.5 ? -1 : 1),
                phase: random() * TAU, size: 0.16 + random() * 0.16
            }))
        } : null;
        // 字块的尺度：一个字高（em）和字块的半宽半高，下面几样墨都按它摆
        const tb = textBox || [W * 0.36, H * 0.4, W * 0.64, H * 0.6];
        const tcx = (tb[0] + tb[2]) / 2, tcy = (tb[1] + tb[3]) / 2;
        const halfW = (tb[2] - tb[0]) / 2, halfH = (tb[3] - tb[1]) / 2;
        const em = placed.length ? Math.max(...placed.map(p => p.size)) : H * 0.1;
        const reach = Math.max(halfW, halfH, em * 2);
        const drift = (ax, ay) => ({ ax, ay, w1: 0.06 + random() * 0.1, w2: 0.06 + random() * 0.1, p1: random() * TAU, p2: random() * TAU });
        // 第二个墨团（小一些，也带墨滴），摆在另一个空格里
        const massCell2 = freeCells[1];
        const mass2 = massCell2 && random() < 0.75 ? {
            x: (massCell2[0] + massCell2[2]) / 2, y: (massCell2[1] + massCell2[3]) / 2,
            r: Math.min(massCell2[2] - massCell2[0], massCell2[3] - massCell2[1]) * (0.07 + random() * 0.05),
            sats: Array.from({ length: 2 + Math.floor(random() * 2) }, () => ({
                orbit: 1.5 + random() * 0.8, speed: (0.1 + random() * 0.2) * (random() < 0.5 ? -1 : 1),
                phase: random() * TAU, size: 0.18 + random() * 0.14
            }))
        } : null;
        // 网点云：几团盖过小半个画面的灰，摆在字块四周、极慢地漂（只进网点，不是墨）
        const clouds = Array.from({ length: cue.kind === 'rest' ? 5 : 4 }, () => {
            const a = random() * TAU, d = reach * (0.35 + random() * 1.4);
            return {
                x: tcx + Math.cos(a) * d * (halfW / reach + 0.6), y: tcy + Math.sin(a) * d * (halfH / reach + 0.6),
                r: reach * (0.55 + random() * 0.85), level: 0.45 + random() * 0.45,
                ...drift(reach * (0.08 + random() * 0.25), reach * (0.08 + random() * 0.2))
            };
        });
        // 贴着字块四边的小墨滴：离字半个到一个字高，慢慢漂
        const drops = cue.kind === 'line' ? Array.from({ length: 3 + Math.floor(random() * 3) }, () => {
            const side = Math.floor(random() * 4), along = random() * 2 - 1, out = em * (0.35 + random() * 0.55);
            return {
                x: side < 2 ? tcx + along * halfW : tcx + (side === 2 ? -1 : 1) * (halfW + out),
                y: side < 2 ? tcy + (side === 0 ? -1 : 1) * (halfH + out) : tcy + along * halfH,
                r: em * (0.07 + random() * 0.13), ...drift(em * (0.1 + random() * 0.35), em * (0.1 + random() * 0.35))
            };
        }) : [];
        // 漂在字上的灰墨团：盖住一两个字的大小，在字块里慢慢游；显影时墨压在它上面，字照样读得出
        const drifters = Array.from({ length: (cue.kind === 'line' ? 1 : 2) + (random() < 0.55 ? 1 : 0) }, () => ({
            x: tcx + (random() * 1.8 - 0.9) * halfW, y: tcy + (random() * 1.8 - 0.9) * halfH,
            r: em * (0.55 + random() * 0.45) * (cue.kind === 'line' ? 1 : 1.6),
            ...drift(Math.min(halfW, em * 1.5) * (0.3 + random() * 0.6), Math.min(halfH, em * 1.2) * (0.2 + random() * 0.4))
        }));
        const collisions = [];
        if (settings.collisions) {
            const spots = freeCells.slice(1).concat(cells);
            const times = [];
            if (cue.kind === 'line') {
                const candidates = unitBoxes.map(u => u.unit.start).filter(t => t > cue.start + 1 && t < cue.end - 1.2);
                if (candidates.length) times.push(candidates[Math.floor(random() * candidates.length)]);
                if (length > 9 && candidates.length > 3) times.push(candidates[candidates.length - 1]);
            } else {
                for (let t = cue.start + 2 + random() * 2; t < cue.end - 1.5; t += 4 + random() * 3) times.push(t);
            }
            times.forEach((t, i) => {
                const spot = spots[i % Math.max(1, spots.length)];
                if (!spot) return;
                const size = Math.min(spot[2] - spot[0], spot[3] - spot[1]);
                collisions.push({
                    t, x: (spot[0] + spot[2]) / 2, y: (spot[1] + spot[3]) / 2,
                    angle: random() * TAU, dist: size * 0.42, r: size * 0.07, spin: random() < 0.5 ? -1.7 : 1.7,
                    fragments: 6 + Math.floor(random() * 3)
                });
            });
        }
        const accents = [];
        unitBoxes.forEach((u) => {
            if (accents.length >= 3 || u.unit.end - u.unit.start < 0.45 || random() > 0.36) return;
            const w = u.box[2] - u.box[0], h = u.box[3] - u.box[1];
            accents.push({ start: u.unit.start, end: u.unit.end, x: (u.box[0] + u.box[2]) / 2 + (random() - 0.5) * w * 0.2,
                y: (u.box[1] + u.box[3]) / 2 + (random() - 0.5) * h * 0.15, r: Math.max(w, h) * 0.42 });
        });

        // 镜头的取景表
        // 进这一段的转场：多数直接硬切；进副歌那一句是「开墨」——整屏先是墨，从正中炸开一个口子，
        // 冲镜落到第一个字上，头一个镜头反相（白字黑底）；副歌里面多漫墨、冲镜
        const transition = index === 0 ? 'cut' : cue.chorusEntry ? 'burst' : pickWeighted(shotRandom, cue.chorus
            ? [['flood', 2], ['smash', 2.5], ['ink', 1], ['cut', 2.5], ['sweep', 1.5]]
            : [['cut', 4.5], ['ink', 1.4], ['flood', 1.2], ['smash', 1], ['sweep', 1.6]]);
        const shots = planShots(cue, { placed, unitBoxes, wideH, wideC, textBox, figures, W, H, aspect, sceneKey: ctx.scene }, shotRandom, settings, transition);
        return {
            index, cue, atlas, glyphInst, glyphCount: glyphEntries.length, shots, mass, mass2, clouds, drops, drifters, collisions, accents,
            strokeStart, strokeStep,
            transition,
            flood: transition === 'burst' ? [0.5, 0.5] : [0.2 + random() * 0.6, 0.25 + random() * 0.5],
            // 扫笔方向：多半横着扫，斜一点；左右随机
            sweep: [(random() - 0.5) * 0.6 + (random() < 0.5 ? 0 : Math.PI), random() * 40],
            sparks: placed.slice(0, MAX_GLYPHS).map((p, i) => ({
                t: p.g.start, x: (p.box[0] + p.box[2]) / 2, y: (p.box[1] + p.box[3]) / 2, s: p.size,
                a: random() * TAU, spin: (i % 2 ? 1 : -1) * (2.2 + random() * 1.4)
            })),
            beats: unitBoxes.map(u => ({ t: u.unit.start, x: (u.box[0] + u.box[2]) / 2, y: (u.box[1] + u.box[3]) / 2,
                r: Math.max(u.box[2] - u.box[0], u.box[3] - u.box[1]) * 0.62 })),
            style: composed.style, backdrop
        };
    };

    /* ───────────────────────── 分镜 ───────────────────────── */

    // 跟字的取景：从一个字开始，把后面装得下的字一起框进来；正在唱的字跑出这一框就硬切到下一框。
    const buildFrames = (placed, viewH, aspect) => {
        const frames = [];
        const viewW = viewH * aspect;
        let current = null;
        placed.forEach((p) => {
            if (current) {
                const u = unionBox([current.box, p.box]);
                if (u[2] - u[0] <= viewW * 0.84 && u[3] - u[1] <= viewH * 0.8) { current.box = u; return; }
            }
            current = { start: p.g.start, box: p.box.slice() };
            frames.push(current);
        });
        frames.forEach((f) => { f.c = [(f.box[0] + f.box[2]) / 2, (f.box[1] + f.box[3]) / 2]; });
        return frames;
    };
    const frameAt = (frames, t) => {
        let pick = frames[0];
        for (const f of frames) { if (f.start <= t) pick = f; else break; }
        return pick;
    };

    // 每种机位自己的滚转和偏心范围：大特写斜得最狠（字斜着撑出画面），倾斜镜头次之，其余只歪一点点。
    const shotPose = (type, random) => {
        const span = (lo, hi) => lo + random() * (hi - lo);
        const sign = () => (random() < 0.5 ? -1 : 1);
        switch (type) {
            case 'macro': return { roll: sign() * span(0.25, 0.6), off: [span(-0.12, 0.12), span(-0.12, 0.12)] };
            case 'dutch': return { roll: sign() * span(0.2, 0.4), off: [span(-0.1, 0.1), 0] };
            case 'close': return { roll: span(-0.07, 0.07), off: [span(-0.08, 0.08), span(-0.05, 0.05)] };
            case 'far': return { roll: span(-0.04, 0.04), off: [sign() * span(0.18, 0.3), sign() * span(0.1, 0.22)] };
            case 'figure': return { roll: sign() * span(0.08, 0.3), off: [span(-0.1, 0.1), span(-0.1, 0.1)] };
            case 'reveal': return { roll: sign() * span(0.05, 0.15), off: [0, 0] };
            case 'follow': return { roll: span(-0.03, 0.03), off: [0, 0] };
            case 'pullback': return { roll: span(-0.1, 0.1), off: [0, 0] };
            case 'crash': return { roll: span(-0.12, 0.12), off: [0, 0] };
            default: return { roll: span(-0.05, 0.05), off: [0, 0] };
        }
    };
    const SCREEN_ANGLES = [0.26, 0.52, 0.79, 1.31];
    // 一句开头多半就近看第一个字（Folia 换句也是直接落在第一个字上）；不再用远景开句——开句时线稿还没画，远景是一片空
    const FIRST_SHOT = [['wide', 0.9], ['close', 3], ['dutch', 1.5], ['follow', 2.2]];
    const SWEEP_BEFORE = 0.2, SWEEP_AFTER = 0.42;
    const MIDDLE_SHOT = [['close', 3], ['follow', 2], ['macro', 1.6], ['dutch', 1.5], ['wide', 1.6], ['far', 0.6]];
    // 切点：按节奏均分（一句大约 2.6 秒一刀，副歌密一些），再吸到最近的词开唱时刻上
    const planCuts = (start, end, count, onsets) => {
        const cuts = [];
        const spacing = (end - start) / count;
        for (let i = 1; i < count; i += 1) {
            const ideal = start + spacing * i;
            const near = onsets.reduce((best, o) => (Math.abs(o - ideal) < Math.abs(best - ideal) ? o : best), Infinity);
            const at = Math.abs(near - ideal) <= spacing * 0.4 ? near : ideal;
            const previous = cuts.length ? cuts[cuts.length - 1] : start;
            if (at - previous >= 0.6 && end - at >= 0.6) cuts.push(at);
        }
        return cuts;
    };

    const planShots = (cue, scene, random, settings, transition = 'cut') => {
        const { placed, unitBoxes, wideH, wideC, figures, W, H, aspect, sceneKey } = scene;
        const maxSize = placed.length ? Math.max(...placed.map(p => p.size)) : H * 0.1;
        const closeH = clamp(maxSize * 2.5, H * 0.16, wideH * 0.72);
        const close = buildFrames(placed, closeH, aspect);
        // 跟词：一个词一框（大特写对准的词唱完以后也用它一个词一个词地跳）
        const words = unitBoxes.map((u) => {
            const w = u.box[2] - u.box[0], h = u.box[3] - u.box[1];
            return { start: u.unit.start, c: [(u.box[0] + u.box[2]) / 2, (u.box[1] + u.box[3]) / 2], h: clamp(Math.max(h * 1.45, w / aspect * 1.45), H * 0.1, wideH) };
        }).sort((x, y) => x.start - y.start);
        const shots = [];
        const length = cue.end - cue.start;
        const cuts = settings.cameraCuts && !settings.reducedMotion;
        const chorus = cue.kind === 'line' && Boolean(cue.chorus);
        // 反相镜头的多少看意象：星夜多（黑底白线像夜空），信笺少（信纸是白的）
        const negScale = { night: 1.7, sea: 1.2, city: 1.1, letters: 0.5, flora: 0.8 }[sceneKey] ?? 1;
        const negChance = settings.negativeShots ? Math.min(0.55, (chorus ? 0.34 : 0.2) * negScale) : 0;
        let inverted = 0;
        let previous = '';
        const push = (start, type, first) => {
            // 先取随机数再判断：开关反相不改后面取到的数，机位不跟着变
            const roll = random();
            const neg = (!first && inverted < 2 && roll < negChance) || (first && transition === 'burst' && settings.negativeShots);
            inverted = neg ? inverted + 1 : 0;
            const pose = shotPose(type, random);
            let angle = SCREEN_ANGLES[Math.floor(random() * SCREEN_ANGLES.length)];
            if (shots.length && angle === shots[shots.length - 1].angle) angle = SCREEN_ANGLES[(SCREEN_ANGLES.indexOf(angle) + 1) % SCREEN_ANGLES.length];
            const shot = { start, type, drift: [random() - 0.5, random() - 0.5], roll: pose.roll, off: pose.off, neg, angle };
            if (type === 'macro' && placed.length) {
                // 大特写只框住镜头开头正在唱的那个字的一部分：字斜着撑出画面
                let p = placed[0];
                placed.forEach((q) => { if (q.g.start <= start + 0.05 && q.g.start >= p.g.start) p = q; });
                shot.anchor = { start: p.unit?.start ?? p.g.start, c: [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2], h: p.size * 0.74 };
            }
            shots.push(shot);
            previous = type;
            return shot;
        };
        const sketchable = cue.kind === 'rest' && !cue.title && cuts && figures.length >= 2;
        if (sketchable) {
            // 间奏是一场写生（Folia 的间奏只是停在全景上）：镜头跟着笔，一张图开画时推到它跟前，
            // 看它一笔一笔画出来、慢慢推近；每画完两张拉回全景交代一次；都画完以后在细节和全景之间换，
            // 最后一个镜头留给全景，等下一句进来
            const order = figures.slice().sort((x, y) => x.t0 - y.t0);
            let t = cue.start;
            push(t, 'wide', true);
            t = Math.max(t + 1.6, order[0].t0 - 0.25);
            order.forEach((f, i) => {
                if (t >= cue.end - 2) return;
                const shot = push(t, 'figure', false);
                shot.fig = f;
                shot.push = [3.3, 2.3];
                const next = order[i + 1];
                const done = Math.max(f.t1 + 0.6, t + 2.2);
                t = next ? Math.max(done, Math.min(next.t0 - 0.25, t + 4.5)) : done;
                if (i % 2 === 1 && next && t < cue.end - 4) { push(t, 'wide', false); t += 2.2; }
            });
            let k = 0;
            while (t < cue.end - 3.5) {
                if (k % 2 === 0) {
                    const shot = push(t, 'figure', false);
                    shot.fig = figures[Math.floor(random() * figures.length)];
                    shot.push = [1.6, 1.15];   // 推得很近：细辅助线、注记这时候才看得清
                } else push(t, k % 4 === 3 ? 'far' : 'wide', false);
                t += 2.6 + random() * 1.6;
                k += 1;
            }
            if (t < cue.end - 0.8) push(t, 'wide', false);
        } else if (cue.kind === 'rest') {
            let t = cue.start;
            let k = 0;
            while (t < cue.end - 0.5) {
                // 开场那段（带歌名）一直让歌名在画里：全景和近景交替，不切去只拍线稿（Folia 开场也是大字压着图）
                const titled = cue.title && placed.length;
                const fig = !titled && figures.length && cuts && k % 2 === 1 ? figures[Math.floor(random() * figures.length)] : null;
                const shot = push(t, fig ? 'figure' : titled ? (k % 2 === 1 ? 'close' : 'wide') : (k % 3 === 2 ? 'far' : 'wide'), k === 0);
                shot.fig = fig;
                t += 4.5 + random() * 3.5;
                k += 1;
                if (!cuts) break;
            }
        } else if (!cuts || !placed.length) {
            push(cue.start, 'wide', true);
        } else {
            // 副歌切得密：一般 1.4 倍，最后一段副歌 1.7 倍
            const density = chorus ? (cue.lastChorus ? 1.7 : 1.4) : 1;
            const count = Math.max(1, Math.min(8, Math.round(length * density / 2.6)));
            const onsets = unitBoxes.map(u => u.unit.start).filter(o => o > cue.start + 0.6 && o < cue.end - 0.6);
            const edges = [cue.start, ...planCuts(cue.start, cue.end, count, onsets), cue.end];
            edges.slice(0, -1).forEach((start, i) => {
                const end = edges[i + 1];
                if (i === 0 && (transition === 'smash' || transition === 'burst')) { push(start, 'crash', true); return; }
                let weights = i === 0 ? FIRST_SHOT : MIDDLE_SHOT;
                // 一句的最后一个镜头够长时多半拉远，把整句和周围的墨交代出来
                if (i > 0 && i === edges.length - 2 && end - start >= 1.4) weights = weights.concat([['pullback', 5]]);
                if (chorus) weights = weights.map(([n, w]) => [n, w + (n === 'macro' ? 1.5 : n === 'dutch' ? 1 : 0)]);
                // 移镜（Folia 没有）：从旁边那张线稿慢慢滑到正在唱的字上；镜头够长、这句有线稿时才用
                if (i > 0 && figures.length && end - start >= 1.8) weights = weights.concat([['reveal', 1.4]]);
                const pool = weights.filter(([n]) => n !== previous);
                const shot = push(start, pickWeighted(random, pool.length ? pool : weights), i === 0);
                if (shot.type === 'reveal') shot.fig = figures[0];   // 第一张线稿最先画完，移镜开始时它已经在纸上
            });
        }
        const starts = unitBoxes.map(u => u.unit.start).sort((x, y) => x - y);
        shots.forEach((shot, i) => {
            shot.end = shots[i + 1]?.start ?? cue.end;
            if (shot.type === 'pullback') {
                const inside = starts.filter(st => st > shot.start + 0.3 && st < shot.end - 0.3);
                shot.steps = inside.length >= 3 ? [shot.start, ...inside.slice(0, 2)] : [0, 1, 2].map(k => shot.start + (shot.end - shot.start) * k / 3);
            }
        });
        return { shots, closeH, close, words, wideH, wideC, W, H };
    };

    // 某一刻的机位：中心、取景高度（世界像素）、滚转。机位只在开唱、跳档的时刻上跳，镜头里只极慢地蠕动。
    const viewAt = (plan, t) => {
        const { shots, closeH, close, wideH, wideC, H } = plan;
        const words = plan.words || [];
        let shot = shots[0];
        for (const s of shots) { if (s.start <= t) shot = s; else break; }
        if (!shot) return { c: wideC, h: wideH, roll: 0, neg: false, shot: 'wide' };
        let c = wideC, h = wideH;
        let roll = shot.roll || 0;
        const u = clamp((t - shot.start) / Math.max(0.5, shot.end - shot.start), 0, 1);
        const closeFrame = close.length ? frameAt(close, t) : null;
        const word = words.length ? frameAt(words, t) : null;
        switch (shot.type) {
            case 'far': h = Math.min(wideH * 1.85, H * 1.15); break;
            case 'dutch': h = wideH * 1.04; break;
            case 'close': if (closeFrame) { c = closeFrame.c; h = closeH; } break;
            case 'follow': if (word) { c = word.c; h = word.h; } break;
            case 'macro': {
                const a = shot.anchor;
                if (word && a && word.start > a.start + 1e-3) {
                    // 对准的词唱完了：换成特写一个词一个词地跳，斜度收掉大半
                    c = word.c; h = word.h * 0.92; roll *= 0.12;
                } else if (a) { c = a.c; h = a.h; roll += 0.03 * (u - 0.5); } else if (closeFrame) { c = closeFrame.c; h = closeH; }
                break;
            }
            case 'pullback': {
                const step = (shot.steps || []).filter(st => st <= t).length;
                const k = clamp((step - 1) / 2, 0, 1);
                const from = closeFrame ? closeFrame.c : wideC;
                c = [from[0] + (wideC[0] - from[0]) * k, from[1] + (wideC[1] - from[1]) * k];
                h = closeH + (wideH * 1.25 - closeH) * k;
                break;
            }
            case 'crash': {
                // 冲镜：从很远处连跳三格，落到第一个词上
                const jumps = Math.min(3, Math.floor((t - shot.start) / 0.16));
                const k = jumps / 3;
                const to = closeFrame ? closeFrame.c : wideC;
                c = [wideC[0] + (to[0] - wideC[0]) * k, wideC[1] + (to[1] - wideC[1]) * k];
                h = wideH * 2.6 + (closeH - wideH * 2.6) * k;
                break;
            }
            case 'figure': if (shot.fig) {
                c = [shot.fig.x, shot.fig.y];
                // 间奏跟笔的镜头：整个镜头里慢慢推近，滚转也一点点转
                if (shot.push) { h = shot.fig.r * (shot.push[0] + (shot.push[1] - shot.push[0]) * smooth(0, 1, u)); roll += 0.05 * (u - 0.5); }
                else h = shot.fig.r * 2.6;
            } break;
            case 'reveal': {
                // 先在线稿上停一下，再匀加速、匀减速地滑到字上，滚转一路收平
                const to = closeFrame ? closeFrame.c : wideC;
                const toH = closeFrame ? closeH : wideH;
                if (shot.fig) {
                    const k = smooth(0.3, 0.85, u);
                    c = [shot.fig.x + (to[0] - shot.fig.x) * k, shot.fig.y + (to[1] - shot.fig.y) * k];
                    h = shot.fig.r * 2.8 + (toH - shot.fig.r * 2.8) * k;
                    roll *= 1 - k;
                } else { c = to; h = toH; }
                break;
            }
            default: break;
        }
        // 一个镜头从头到尾只推近 3.5%
        h *= 1 - 0.035 * u;
        const off = shot.off || [0, 0];
        // 顶上是模式栏、底下是播放条：取景中心放在两者之间（比屏幕正中略高）
        c = [c[0] - off[0] * h + shot.drift[0] * h * 0.04 * u, c[1] - off[1] * h + shot.drift[1] * h * 0.04 * u + h * 0.035];
        return { c, h, roll, neg: shot.neg, shot: shot.type, angle: shot.angle };
    };

    // 某一刻的墨团（世界像素：x, y, 半径, 强度）和冲击环。
    const wander = (d, local) => [Math.sin(local * d.w1 + d.p1) * d.ax, Math.sin(local * d.w2 + d.p2) * d.ay];
    const blobsAt = (cue, t, out, rings, accentsOut, bass, beatAge = Infinity, cloudsOut = null) => {
        let n = 0;
        const push = (x, y, r, s = 1) => { if (n < MAX_BLOBS && r > 0.5) { out[n * 4] = x; out[n * 4 + 1] = y; out[n * 4 + 2] = r; out[n * 4 + 3] = s; n += 1; } };
        const local = t - cue.cue.start;
        const appear = smooth(0, 0.8, local);
        [cue.mass, cue.mass2].forEach((m, k) => {
            if (!m) return;
            const breath = 1 + 0.05 * Math.sin(local * 0.7 + k * 2.1) + bass * 0.06;
            push(m.x, m.y, m.r * breath * appear);
            m.sats.forEach((s) => {
                const a = s.phase + local * s.speed;
                push(m.x + Math.cos(a) * m.r * s.orbit, m.y + Math.sin(a) * m.r * s.orbit * 0.8, m.r * s.size * appear);
            });
        });
        (cue.drops || []).forEach((d) => {
            const [ox, oy] = wander(d, local);
            push(d.x + ox, d.y + oy, d.r * appear * (1 + bass * 0.08));
        });
        if (cloudsOut) {
            cloudsOut.fill(0);
            (cue.clouds || []).slice(0, MAX_CLOUDS).forEach((c, i) => {
                const [ox, oy] = wander(c, local);
                cloudsOut[i * 4] = c.x + ox; cloudsOut[i * 4 + 1] = c.y + oy;
                cloudsOut[i * 4 + 2] = c.r * (1 + bass * 0.05); cloudsOut[i * 4 + 3] = c.level * smooth(0, 1.2, local);
            });
        }
        rings.fill(0);
        let ringCount = 0;
        cue.collisions.forEach((c) => {
            const tau = t - c.t;
            if (tau < -1.6 || tau > 2.6) return;
            const dx = Math.cos(c.angle), dy = Math.sin(c.angle);
            if (tau < 0) {
                const d = c.dist * (tau / -1.6) ** 2;
                push(c.x - dx * d, c.y - dy * d, c.r);
                push(c.x + dx * d, c.y + dy * d, c.r);
                return;
            }
            if (tau < 0.9) push(c.x, c.y, c.r * 1.5 * (1 - tau / 0.9));
            if (ringCount < MAX_RINGS && tau < 1.6) {
                rings[ringCount * 4] = c.x; rings[ringCount * 4 + 1] = c.y;
                rings[ringCount * 4 + 2] = c.dist * 1.05 * (1 - Math.exp(-tau * 2.4));
                rings[ringCount * 4 + 3] = c.r * 0.22 * (1 - tau / 1.6);
                ringCount += 1;
            }
            const spread = 1 - Math.exp(-tau * 1.8);
            const fade = 1 - tau / 2.6;
            for (let k = 0; k < c.fragments; k += 1) {
                const a = c.angle + k * TAU / c.fragments + c.spin * spread;
                const rr = c.dist * 1.15 * spread;
                push(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr, c.r * 0.34 * fade);
                const back = 1 - Math.exp(-Math.max(0, tau - 0.2) * 1.8);
                const ab = c.angle + k * TAU / c.fragments + c.spin * back;
                push(c.x + Math.cos(ab) * c.dist * 1.15 * back, c.y + Math.sin(ab) * c.dist * 1.15 * back, c.r * 0.14 * fade);
            }
        });
        // 词开唱：字块外扩一道细墨环
        (cue.beats || []).forEach((b) => {
            const tau = t - b.t;
            if (ringCount >= MAX_RINGS || tau < 0 || tau > 0.9) return;
            rings[ringCount * 4] = b.x; rings[ringCount * 4 + 1] = b.y;
            rings[ringCount * 4 + 2] = b.r * (0.9 + 0.55 * (1 - Math.exp(-tau * 4)));
            rings[ringCount * 4 + 3] = b.r * 0.018 * (1 - tau / 0.9);
            ringCount += 1;
        });
        // 鼓点：墨团外一圈冲击环
        if (cue.mass && beatAge < 0.7 && ringCount < MAX_RINGS) {
            const m = cue.mass;
            rings[ringCount * 4] = m.x; rings[ringCount * 4 + 1] = m.y;
            rings[ringCount * 4 + 2] = m.r * (1.05 + beatAge * 1.6);
            rings[ringCount * 4 + 3] = m.r * 0.06 * (1 - beatAge / 0.7);
            ringCount += 1;
        }
        // 唱到的字甩出一对螺旋墨点，后面拖两颗小点
        (cue.sparks || []).forEach((sp) => {
            const tau = t - sp.t;
            if (tau < 0 || tau > 1.5 || n >= MAX_BLOBS - 6) return;
            for (let side = 0; side < 2; side += 1) {
                for (let k = 0; k < 3; k += 1) {
                    const tk = Math.max(0, tau - k * 0.07);
                    const reach = sp.s * (0.45 + 1.5 * (1 - Math.exp(-tk * 2.2)));
                    const ang = sp.a + side * Math.PI + sp.spin * tk;
                    const r = sp.s * (k ? 0.022 : 0.04) * (1 - tau / 1.5);
                    push(sp.x + Math.cos(ang) * reach, sp.y + Math.sin(ang) * reach * 0.8, r, 1.4);
                }
            }
        });
        let a = 0;
        accentsOut.fill(0);
        (cue.drifters || []).forEach((d) => {
            if (a >= MAX_ACCENT) return;
            const [ox, oy] = wander(d, local);
            accentsOut[a * 4] = d.x + ox; accentsOut[a * 4 + 1] = d.y + oy; accentsOut[a * 4 + 2] = d.r * appear * (1 + bass * 0.05); accentsOut[a * 4 + 3] = 1;
            a += 1;
        });
        cue.accents.forEach((acc) => {
            if (a >= MAX_ACCENT) return;
            const grow = smooth(acc.start - 0.05, acc.start + 0.3, t) * (1 - smooth(acc.end + 0.2, acc.end + 0.8, t));
            if (grow <= 0.001) return;
            accentsOut[a * 4] = acc.x; accentsOut[a * 4 + 1] = acc.y; accentsOut[a * 4 + 2] = acc.r * grow; accentsOut[a * 4 + 3] = 1;
            a += 1;
        });
        return { blobs: n, accents: a };
    };

    // 画面外的墨团：着色器里离得比 √500 倍半径还远的墨团本来就不算（见 SMOOTH_FRAG），
    // 离这一镜看得到的整块都那么远的，先在这里拿掉，省得每个像素再去比一遍。保持原来的顺序，结果逐位一样
    const cullBlobs = (buf, count, view, aspect) => {
        const reach = view.h * (0.5 * Math.hypot(aspect, 1) + 0.05);   // 画面外接圆 + 流场推开的余量
        let n = 0;
        for (let i = 0; i < count; i += 1) {
            const o = i * 4;
            const d = Math.hypot(buf[o] - view.c[0], buf[o + 1] - view.c[1]) - reach;
            if (d > 0 && d * d > buf[o + 2] * buf[o + 2] * 520) continue;
            if (n !== i) { buf[n * 4] = buf[o]; buf[n * 4 + 1] = buf[o + 1]; buf[n * 4 + 2] = buf[o + 2]; buf[n * 4 + 3] = buf[o + 3]; }
            n += 1;
        }
        return n;
    };

    /* ───────────────────────── GL ───────────────────────── */

    // 一个盖住全屏的三角形：顶点 (-1,-1)、(3,-1)、(-1,3)
    const VERT = `#version 300 es
in vec2 aPosition;
void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
    // 逐字层：每个字一个四边形，按镜头投到屏幕上，画进墨场（半浮点离屏图，加法混合）。
    // 墨场 R 是字的墨、G 是网点的浓淡、B 是关键词的墨。
    const GLYPH_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec4 iA;  // 那一格的中心 x, y（世界像素），边长，转角
layout(location = 1) in vec4 iB;  // 开唱、唱完、关键词、是不是注记
layout(location = 2) in vec4 iR;  // 图集 uv 框：左、上、右、下
layout(location = 3) in vec2 aPosition;  // 四边形的角：±1
uniform vec4 uView;
uniform float uAspect;
uniform float uTime;
uniform float uPop;
out vec2 vUv;
out vec4 vT;
void main() {
    vec2 corner = aPosition * 0.5 + 0.5;
    float dt = uTime - iB.x;
    float on = step(0.0, dt);
    // 开唱的一下鼓起来、慢慢收回；还没唱到的略小一点
    float scale = mix(0.94, 1.0 + uPop * 0.18 * exp(-max(dt, 0.0) * 2.2), on);
    // 飞溅的墨点：一下甩开（0.1 秒从小到满）
    if (iB.w > 1.5) scale = on * (1.0 - 0.55 * uPop * exp(-max(dt, 0.0) * 30.0));
    vec2 off = (corner - 0.5) * iA.z * scale;
    float rc = cos(iA.w), rs = sin(iA.w);
    vec2 w = iA.xy + vec2(off.x * rc - off.y * rs, off.x * rs + off.y * rc);
    vec2 d = w - uView.xy;
    float c = cos(uView.w), s = sin(uView.w);
    vec2 q = vec2(d.x * c + d.y * s, -d.x * s + d.y * c);
    vec2 p = vec2(q.x / (uAspect * uView.z), -q.y / uView.z);
    gl_Position = vec4(p * 2.0, 0.0, 1.0);
    vUv = vec2(mix(iR.x, iR.z, corner.x), mix(iR.y, iR.w, corner.y));
    vT = iB;
}`;
    const GLYPH_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
uniform float uTime;
uniform float uReveal;
uniform float uCss;      // 一个 CSS 像素是多少个屏幕像素
uniform float uBleed;    // 洇墨的强度（0 = 关）
uniform float uWobble;   // 手写的抖（0 = 关）
in vec2 vUv;
in vec4 vT;
out vec4 outColor;
float h21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
    // 手写的抖：字形在图集里被一层低频噪声推一推（按图集像素算，抖动钉在字上，镜头动它不游），
    // 笔画边不再是印刷体那样一条光滑的线（Folia 的字边也是抖的，这里抖得更慢、更像笔压不匀）
    vec2 tsz = vec2(textureSize(uAtlas, 0));
    vec2 q = vUv * tsz;
    vec2 wob = (vec2(vn(q * 0.035), vn(q * 0.035 + 17.3)) - 0.5) * 4.0 + (vec2(vn(q * 0.16 + 5.1), vn(q * 0.16 + 31.7)) - 0.5) * 1.3;
    vec2 g = texture(uAtlas, vUv + wob * uWobble / tsz).rg;
    float dt = uTime - vT.x;
    float on = step(0.0, dt);
    float age = max(dt, 0.0);
    // 墨凝出来：先是一团（宽通道），很快收紧成字形（紧通道）
    float set = on * (1.0 - exp(-age * 4.5));
    float bulge = on * exp(-age * 1.5);
    float ink = g.r * set + g.g * (bulge * 1.25 + 0.3 * set);
    // 洇墨（Folia 没有）：唱过的字在纸上慢慢洇开——墨顺着纸的纤维往外渗，纤维是一个方向拉长的噪声，
    // 所以渗出去的是一丝一丝的毛刺，不是均匀变胖；只在字边那一圈（宽通道里）发生，两三秒后停住
    vec2 cp = gl_FragCoord.xy / uCss;
    vec2 fp = vec2(cp.x * 0.94 + cp.y * 0.34, -cp.x * 0.34 + cp.y * 0.94);
    float fibre = vn(fp * vec2(0.05, 0.55)) * 0.65 + vn(fp * vec2(0.11, 1.3) + 17.0) * 0.35;
    float bleed = uBleed * on * smoothstep(0.3, 3.2, age) * smoothstep(0.42, 0.95, fibre);
    ink += g.g * bleed * 0.55 * (1.0 - g.r);
    // 没唱到的字只是一层网点的影子；唱过的字周围留一圈网点
    float tone = (g.r * (1.0 - set) * 0.85 + g.g * (0.3 + 0.45 * set)) * uReveal;
    // 注记到时候直接出现：细的墨字，没有那一团；周围一圈淡网点，和线两边的毛边一样
    if (vT.w > 1.5) {
        // 溅开的墨：一下就是实的，边上沾一点网点；也会洇
        ink = g.r * on * 1.15 + g.g * bleed * 0.4 * (1.0 - g.r);
        tone = min(0.4, g.g * 0.8) * on;
    } else if (vT.w > 0.5) {
        ink = g.r * on * 1.12;
        tone = min(0.55, g.g * 1.6) * on;
    }
    outColor = vec4(ink * (1.0 - vT.z), tone, ink * vT.z, 0.0);
}`;
    // 低分辨率那一遍：墨团的场、冲击环、强调色墨团、网点云（都平滑，放大不糊）。存的时候缩一下，八位的图也装得下
    const SMOOTH_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uMain;
uniform sampler2D uIds;
uniform sampler2D uGlyphF;
uniform sampler2D uSmooth;
uniform float uFlowT;
uniform float uKeywords;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform vec2 uWorld;
uniform vec2 uIdSize;
uniform vec4 uView;      // cx, cy, h, roll
uniform vec4 uPrevView;  // cx, cy, h, roll
uniform float uPrevFade; // 0 = 不画上一段
uniform float uAspect;
uniform float uTime;
uniform vec2 uStroke;    // 第一笔的时刻、笔间隔
uniform float uTone;
uniform vec4 uBlobs[${MAX_BLOBS}];
uniform int uBlobCount;
uniform vec4 uAccent[${MAX_ACCENT}];
uniform int uAccentCount;
uniform vec4 uRings[${MAX_RINGS}];
uniform vec4 uClouds[${MAX_CLOUDS}];
uniform vec3 uBlobCol;
uniform float uDotPx;
uniform float uDotAngle;
uniform vec4 uFlood;     // 屏幕 x, y, 半径, 0 = 不漫
uniform float uSmash;    // 0..1 上一段碎开
uniform float uCloud;    // 墨云浓度
uniform float uExit;     // 段尾：字向外散开
uniform float uFlow;
uniform float uGrainStep;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uAccentCol;
uniform vec3 uDot;
uniform float uNeg;
uniform float uHalftone;
uniform float uGrain;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outWarp;

// 不带 sin 的散列（在大整数坐标上也不出条纹）
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
${Utils.NOISE_GLSL}
vec2 worldAt(vec4 view, vec2 suv) {
    vec2 p = suv - 0.5;
    vec2 q = vec2(p.x * uAspect, -p.y) * view.z;
    float c = cos(view.w), s = sin(view.w);
    return view.xy + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
}
// 流场：按屏幕算（大特写也不会把字推出一大截），每秒跳 8 格（uFlowT 是取整过的时间）。一层大的慢慢推，一层小的抖
vec2 warped() {
    vec2 suv = gl_FragCoord.xy / uRes;
    vec2 p = vec2(suv.x * uAspect, suv.y);
    vec2 warp = (vec2(vnoise(p * 3.2 + vec2(0.0, uFlowT * 0.16)), vnoise(p * 3.2 + vec2(17.3, -uFlowT * 0.13))) - 0.5) * 0.024
        + (vec2(vnoise(p * 9.0 + vec2(uFlowT * 0.3, 3.0)), vnoise(p * 9.0 + vec2(31.7, -uFlowT * 0.27))) - 0.5) * 0.007;
    warp.x /= uAspect;
    return suv + warp;
}

void main() {
    vec2 suv = warped();
    vec2 w = worldAt(uView, suv);
    vec2 wp = w;
    float field = 0.0;
    for (int i = 0; i < ${MAX_BLOBS}; i++) {
        if (i >= uBlobCount) break;
        vec4 b = uBlobs[i];
        vec2 d = wp - b.xy;
        float dd = dot(d, d);
        // 远处的墨团贡献不到 0.2%，不算
        if (dd > b.z * b.z * 500.0) continue;
        field += b.z * b.z / (dd + 1.0) * b.w;
    }
    float ring = 0.0;
    for (int i = 0; i < ${MAX_RINGS}; i++) {
        vec4 r = uRings[i];
        if (r.w <= 0.0) continue;
        float d = (length(wp - r.xy) - r.z) / r.w;
        ring += exp(-d * d) * 0.9;
    }
    // 灰墨团：有边的融球（中间高、到半轴边上平滑落到 0），挨近了连成一片；边被低频噪声推得不圆，像泼上去的。
    // 阈值以上那块是 0.55 倍半轴，所以半轴取 r / 0.55，看上去和原来一样大。周围一圈只进网点（halo）。
    float accent = 0.0;
    float accentHalo = 0.0;
    for (int i = 0; i < ${MAX_ACCENT}; i++) {
        if (i >= uAccentCount) break;
        vec4 b = uAccent[i];
        float R = b.z / 0.55;
        vec2 d = wp - b.xy;
        // 边被噪声推开最多 0.24 倍半轴：再远的像素这一团是 0，不用取噪声
        if (dot(d, d) > R * R * 1.5625) continue;
        vec2 wob = vec2(vnoise(wp / (R * 0.45) + float(i) * 7.3), vnoise(wp / (R * 0.45) + 31.0 - float(i) * 3.1)) - 0.5;
        vec2 q = (d + wob * R * 0.34) / R;
        float kk = max(0.0, 1.0 - dot(q, q));
        accent += kk * kk * kk * 1.45;
        accentHalo += kk * kk * 0.55;
    }

    float k = uWorld.y;
    float cl = vnoise(wp / (k * 0.42) + uFlow * 0.08) * 0.62 + vnoise(wp / (k * 0.17) - uFlow * 0.11) * 0.38;
    // 网点云：几团大的灰慢慢漂，中间浓、边上平滑落到没有，挨近了连成一片
    float cloudT = 0.0;
    for (int i = 0; i < ${MAX_CLOUDS}; i++) {
        vec4 c = uClouds[i];
        if (c.w <= 0.0) continue;
        vec2 d = (wp - c.xy) / c.z;
        float q = max(0.0, 1.0 - dot(d, d));
        cloudT += q * q * c.w;
    }
    // 网点云最浓也只到圆点刚好分开（0.55），远看是一片网点，不糊成一块带喷枪边的平灰
    float clouds = max(max(min(cloudT, 0.55), smoothstep(0.5, 0.95, cl) * 0.55), min(accentHalo, 0.5));
    outColor = vec4(field * 0.25, ring * 0.5, accent * 0.25, clouds);
    // 流场也是平滑的：这里算好，原生分辨率那一遍只取一次（存成 0.5 为零点、±0.05 的范围）
    outWarp = vec4((suv - gl_FragCoord.xy / uRes) * 10.0 + 0.5, 0.0, 1.0);
}`;
    const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uMain;
uniform sampler2D uIds;
uniform sampler2D uGlyphF;
uniform sampler2D uSmooth;
uniform float uFlowT;
uniform float uKeywords;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform vec2 uWorld;
uniform vec2 uIdSize;
uniform vec4 uView;      // cx, cy, h, roll
uniform vec4 uPrevView;  // cx, cy, h, roll
uniform float uPrevFade; // 0 = 不画上一段
uniform float uAspect;
uniform float uTime;
uniform vec2 uStroke;    // 第一笔的时刻、笔间隔
uniform float uTone;
uniform vec4 uBlobs[${MAX_BLOBS}];
uniform int uBlobCount;
uniform vec4 uAccent[${MAX_ACCENT}];
uniform int uAccentCount;
uniform vec4 uRings[${MAX_RINGS}];
uniform vec4 uClouds[${MAX_CLOUDS}];
uniform vec3 uBlobCol;
uniform float uDotPx;
uniform float uDotAngle;
uniform vec4 uSweep;     // 扫笔：进度 0..1、方向、种子、0 = 不扫
uniform vec4 uFlood;     // 屏幕 x, y, 半径, 0 = 不漫
uniform float uSmash;    // 0..1 上一段碎开
uniform float uCloud;    // 墨云浓度
uniform float uExit;     // 段尾：字向外散开
uniform float uFlow;
uniform float uGrainStep;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uAccentCol;
uniform vec3 uDot;
uniform float uNeg;
uniform float uHalftone;
uniform float uGrain;
out vec4 outColor;

// 不带 sin 的散列（在大整数坐标上也不出条纹）
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
${Utils.NOISE_GLSL}
vec2 worldAt(vec4 view, vec2 suv) {
    vec2 p = suv - 0.5;
    vec2 q = vec2(p.x * uAspect, -p.y) * view.z;
    float c = cos(view.w), s = sin(view.w);
    return view.xy + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
}
// 流场：按屏幕算（大特写也不会把字推出一大截），每秒跳 8 格（uFlowT 是取整过的时间）。一层大的慢慢推，一层小的抖
vec2 warped() {
    vec2 suv = gl_FragCoord.xy / uRes;
    vec2 p = vec2(suv.x * uAspect, suv.y);
    vec2 warp = (vec2(vnoise(p * 3.2 + vec2(0.0, uFlowT * 0.16)), vnoise(p * 3.2 + vec2(17.3, -uFlowT * 0.13))) - 0.5) * 0.024
        + (vec2(vnoise(p * 9.0 + vec2(uFlowT * 0.3, 3.0)), vnoise(p * 9.0 + vec2(31.7, -uFlowT * 0.27))) - 0.5) * 0.007;
    warp.x /= uAspect;
    return suv + warp;
}

uniform sampler2D uWarp;
uniform sampler2D uPaperTex;
uniform float uPaperGrain;
uniform float uBeat;
uniform float uPress;    // 压印的深浅：浅色纸 1，深色 0.5，关了纸纹 0
void main() {
    vec2 suv = gl_FragCoord.xy / uRes + (texture(uWarp, gl_FragCoord.xy / uRes).rg - 0.5) * 0.1;
    vec2 w = worldAt(uView, suv);
    // 这一句的字：逐字层画好的墨场（R 墨、G 网点浓淡、B 关键词的墨）
    vec4 gf = texture(uGlyphF, suv);
    float gInk = gf.r + gf.b;
    float kwShare = gf.b / max(gInk, 0.0001) * uKeywords;
    vec2 uv = w / uWorld;
    bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
    vec4 m = inside ? texture(uMain, uv) : vec4(0.0);
    vec2 haloRG = inside ? textureLod(uMain, uv, 4.0).rg : vec2(0.0);
    vec4 idv = inside ? texelFetch(uIds, min(ivec2(uv * uIdSize), ivec2(uIdSize) - 1), 0) : vec4(0.0);
    float so = floor(idv.g * 255.0 + 0.5);

    float lineOn = so > 0.5 ? smoothstep(0.0, 0.12, uTime - (uStroke.x + (so - 1.0) * uStroke.y)) : 0.0;
    float lineInk = m.g * lineOn;

    vec2 wp = w;
    // 墨团的场、冲击环、强调色墨团、网点云：都是平滑的，在低分辨率那一遍算好（uSmooth），这里按屏幕取
    vec4 sm = texture(uSmooth, gl_FragCoord.xy / uRes);
    float field = sm.r * 4.0;
    float ring = sm.g * 2.0;
    float accent = sm.b * 4.0;

    float k = uWorld.y;
    // 阈值被噪点搅过：墨边是纸上洇出来的毛边，按屏幕像素算（不跟镜头放大，不会啃出大缺口），也不跟时间跳。
    // 只用连续的噪声（两层），不用逐像素的散列——那种是一圈椒盐点，放大看像数码噪点，不像墨
    vec2 px = gl_FragCoord.xy / max(uRes.y / 900.0, 0.5);
    float rough = ((vnoise(px * 0.45) - 0.5) * 0.16 + (vnoise(px * 0.7 + 11.0) - 0.5) * 0.08) * (0.5 + uGrain);
    float F = gInk + lineInk * 1.1 + field * 0.5 + ring;
    float thr = 0.5 + rough;
    // 段尾硬切之前，字从边上一块块散掉，散的方向朝外
    if (uExit > 0.0) thr += uExit * (0.25 + vnoise(wp / (k * 0.03)) * 0.9 + length(gl_FragCoord.xy / uRes - 0.5) * 0.8);
    // 边的软硬只有一个像素：按 F 在屏幕上的变化率算，大特写和小字都是干净的一刀
    float edgeW = max(fwidth(F), 0.0001) * 0.75;
    float a = smoothstep(thr - edgeW, thr + edgeW, F);
    // 灰墨团的边和字一样：切阈值、被噪点搅过、一个像素宽的抗锯齿，不再是喷枪那样一圈散开的雾
    float aW = max(fwidth(accent), 0.0001) * 0.75;
    float aA = smoothstep(0.5 + rough - aW, 0.5 + rough + aW, accent);

    // 半调：网点格在世界里（跟着镜头放大），网点大小随浓淡
    vec2 sp = gl_FragCoord.xy / uRes - 0.5;
    // 墨云：大尺度的浓淡，每秒跳 8 格地翻涌；四角压暗；字周围的晕、墨团的场也算进浓淡
    float vig = smoothstep(0.4, 0.85, length(sp * vec2(1.0, 0.8)));
    float T = m.b * uTone + clamp(field * 0.18, 0.0, 0.35) * smoothstep(0.2, 0.0, a);
    T = max(T, sm.a * uCloud);
    // 线稿两边一圈网点：线不是干干净净浮在纸上的，跟着这一笔一起出现
    T = max(T, clamp(haloRG.g * 2.6, 0.0, 0.6) * lineOn * smoothstep(0.3, 0.0, a));
    T = max(T, vig * 0.6 * uCloud);
    // 字周围的网点：没唱到的字的影子、唱过的字周围那一圈、墨边阈值以下的那一截（Folia 隐喻的做法）
    T = max(T, clamp(gf.g * 0.9 + gInk * 0.5, 0.0, 1.0));
    // 网点格钉在屏幕上（7 个 CSS 像素一格，大特写也不会放出一颗颗大圆片），每个镜头换一个网角
    float ca = cos(uDotAngle), sa = sin(uDotAngle);
    vec2 sf = gl_FragCoord.xy / uDotPx;
    vec2 g = vec2(sf.x * ca - sf.y * sa, sf.x * sa + sf.y * ca) / 7.0;
    float dist = length(fract(g) - 0.5);
    // 最浓的地方圆点也只是刚好相连，留着格子间的纸
    // 网点跟着低音呼吸：鼓点上来时圆点胀一点（Folia 的网点不动）
    float radius = sqrt(clamp(T, 0.0, 1.0)) * 0.6 * (1.0 + uBeat * 0.14);
    float dots = (1.0 - smoothstep(radius - 0.13, radius + 0.13, dist)) * uHalftone * step(0.012, T);

    vec3 paper = mix(uPaper, uInk, uNeg);
    vec3 ink = mix(uInk, uPaper, uNeg);
    vec3 col = paper;
    col = mix(col, uDot, dots * 0.85);
    col = mix(col, uBlobCol, aA);
    // 灰墨团盖着还没唱到的字：字的网点影子压在它上面，照样看得见
    col = mix(col, mix(uBlobCol, ink, 0.45), dots * aA * smoothstep(0.3, 0.8, gf.g));
    // 关键词的字身用强调色
    vec3 inkK = mix(ink, uAccentCol, kwShare);
    // 墨最后画：灰墨团漂到字上时，字压在它上面照样读得出来。
    // 积墨（Folia 没有）：墨干的时候往笔画边上走，边上一窄圈浓、中间稍淡，像真墨水写在纸上
    float pool = 1.0 - smoothstep(0.0, 0.2, F - thr);
    float body = smoothstep(0.15, 0.6, F - thr);
    vec3 inkPooled = clamp(inkK + (inkK - paper) * 0.14 * pool - (inkK - paper) * 0.07 * body, 0.0, 1.0);
    col = mix(col, inkPooled, a);
    // 压印（Folia 没有）：字像是压进纸里的——右下边的纸上一线阴影，左上边一线亮
    if (uPress > 0.0 && gInk + gf.g > 0.01) {
        vec2 po = vec2(2.0, -2.0) * max(uDotPx, 0.5) / uRes;
        vec4 gA = texture(uGlyphF, suv - po);
        vec4 gB = texture(uGlyphF, suv + po);
        float sh = smoothstep(0.25, 0.75, gA.r + gA.b) * (1.0 - smoothstep(0.25, 0.75, gInk));
        float hi = smoothstep(0.25, 0.75, gB.r + gB.b) * (1.0 - smoothstep(0.25, 0.75, gInk));
        float outside = 1.0 - a;
        col *= 1.0 - sh * outside * 0.2 * uPress;
        col += hi * outside * 0.07 * uPress;
    }

    if (uPrevFade > 0.0) {
        vec2 wq = worldAt(uPrevView, suv);
        // 碎开：屏幕切成不规则的块，每块沿自己的方向飞散，一块块消失
        vec2 cell = floor(gl_FragCoord.xy / uRes.y * 5.0 + vnoise(gl_FragCoord.xy / uRes.y * 3.0) * 1.6);
        float h = hash12(cell);
        if (uSmash > 0.0) {
            vec2 dir = normalize(vec2(hash12(cell + 7.1), hash12(cell + 3.3)) - 0.5 + sp * 1.5);
            wq -= dir * uSmash * uSmash * k * (0.25 + h * 0.5);
        }
        vec2 uq = wq / uWorld;
        if (all(greaterThanEqual(uq, vec2(0.0))) && all(lessThanEqual(uq, vec2(1.0)))) {
            vec4 pm = texture(uPrev, uq);
            float ph = textureLod(uPrev, uq, 4.0).r;
            float Fp = pm.r + pm.g * 1.1;
            float breakUp = (vnoise(wq / (k * 0.05)) - 0.5) * 0.9;
            float tp = uSmash > 0.0 ? 0.5 + rough + step(1.0 - uSmash * 1.15, h) * 9.0
                                    : 0.5 + rough + uPrevFade * 1.1 + breakUp * uPrevFade;
            float pw = max(fwidth(Fp), 0.0001) * 0.75;
            float ap = smoothstep(tp - pw, tp + pw, Fp);
            col = mix(col, ink, ap * (1.0 - a));
        }
    }

    if (uFlood.w > 0.0) {
        // 墨漫：整屏是墨，从一点开一个毛边的口子，口子里是新的一段；口子边上一圈网点
        vec2 fp = (gl_FragCoord.xy / uRes - uFlood.xy) * vec2(uAspect, 1.0);
        float edge = length(fp) - uFlood.z + (vnoise(fp * 9.0 + uFlow) - 0.5) * 0.12 + (vnoise(fp * 40.0) - 0.5) * 0.03;
        float inked = smoothstep(-0.004, 0.004, edge);
        float band = (1.0 - smoothstep(0.0, 0.09, abs(edge + 0.05))) * (1.0 - inked);
        col = mix(col, ink, max(inked, band * dots));
    }
    if (uSweep.w > 0.0) {
        // 扫笔：一笔干刷横扫过画面（前三分之一笔头扫过去盖满，换句就在笔下面发生），
        // 后三分之二笔里的墨干了，飞白从起笔那头开始一条条裂开，新的一句从裂缝里露出来
        vec2 sp = (gl_FragCoord.xy / uRes - 0.5) * vec2(uAspect, 1.0);
        vec2 sd = vec2(cos(uSweep.y), sin(uSweep.y));
        float along = dot(sp, sd);
        float across = dot(sp, vec2(-sd.y, sd.x));
        float span = 0.5 * uAspect + 0.35;
        float u = uSweep.x;
        float head = mix(-span, span + 0.1, clamp(u / 0.32, 0.0, 1.0));
        float headEdge = head - along + (vnoise(vec2(across * 7.0, uSweep.z)) - 0.5) * 0.16
                       + (vnoise(vec2(across * 38.0, uSweep.z + 3.0)) - 0.5) * 0.05;
        float inStroke = smoothstep(-0.004, 0.004, headEdge);
        // 鬃毛：沿着笔走向拉长的条纹，粗细两层
        float bristle = vnoise(vec2(across * 90.0, along * 1.6 + uSweep.z)) * 0.6
                      + vnoise(vec2(across * 16.0, along * 0.7 + uSweep.z * 2.0)) * 0.4;
        float dryT = clamp((u - 0.32) / 0.68, 0.0, 1.0);
        // 起笔那头先干；笔头附近本来就有一点飞白
        float dry = 0.1 + dryT * 1.2 + (span - along) / (2.0 * span) * dryT * 0.35 + smoothstep(0.25, 0.0, headEdge) * 0.35;
        float sw = max(fwidth(bristle), 0.002);
        float cover = inStroke * smoothstep(dry - sw, dry + sw, bristle);
        // 笔里墨的浓淡跟着鬃毛走一点
        col = mix(col, mix(ink, paper, (1.0 - bristle) * 0.18), cover);
    }
    // 颗粒按 CSS 像素算：画面按原生分辨率画了，颗粒大小不跟着屏幕像素密度变
    vec2 cssPx = gl_FragCoord.xy / max(uDotPx, 0.5);
    float gr = hash12(floor(cssPx / 1.5) + uGrainStep * 17.0) - 0.5;
    float fibre = vnoise(cssPx / 3.0 + uGrainStep * 5.0) - 0.5;
    // 墨里的颗粒压一半：墨是一层实的，不像砂纸
    col *= 1.0 + (gr * 0.44 * (1.0 - a * 0.6) + fibre * 0.2) * uGrain;
    // 纸纹：纤维、绒、帘纹，钉在屏幕上不动（沸腾的只是上面那层颗粒）；墨里也透一点——干的墨盖不住纸的纤维
    float pt = texture(uPaperTex, cssPx / 256.0).r - 0.5;
    float pk = uPaperGrain * (1.0 - a * 0.55);
    col = col * (1.0 + pt * 0.26 * pk) + pt * 0.035 * pk;
    // 杂点：纸上是墨色的点，墨里是纸色的点（印刷没压实的地方）
    float speck = step(0.988, hash12(floor(cssPx / 2.2) + uGrainStep * 3.7 + 0.5));
    col = mix(col, mix(ink, paper, a), speck * 0.55 * (1.0 - a * 0.7) * min(uGrain * 2.0, 1.0));
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // 纸纹（Folia 没有）：一块 256 见方、四边接得上的纸——几百根长短不一的纤维（多数比纸亮，少数暗）、
    // 一层很淡的绒（低频的起伏）、横的帘纹和竖的链纹（抄纸帘子留下的），按 CSS 像素平铺、不随时间跳。
    // 只算一次（一张 64KB 的图），画面里只多取一次图。
    const PAPER_TILE = 256;
    const makePaperTile = () => {
        const N = PAPER_TILE;
        const random = seededRandom('inkdraft:paper');
        const v = new Float32Array(N * N);
        const add = (x, y, k) => {
            const xi = ((Math.floor(x) % N) + N) % N, yi = ((Math.floor(y) % N) + N) % N;
            v[yi * N + xi] += k;
        };
        for (let f = 0; f < 420; f += 1) {
            let x = random() * N, y = random() * N;
            let a = random() * Math.PI * 2;
            const turn = (random() - 0.5) * 0.08;
            const len = 8 + random() * random() * 110;
            const k = (random() < 0.72 ? 1 : -0.9) * (0.35 + random() * 0.65);
            for (let t = 0; t < len; t += 0.5) {
                add(x, y, k * 0.6);
                add(x - Math.sin(a), y + Math.cos(a), k * 0.25);
                x += Math.cos(a) * 0.5; y += Math.sin(a) * 0.5;
                a += turn + (random() - 0.5) * 0.06;
            }
        }
        const G = 16;
        const grid = Float32Array.from({ length: G * G }, () => random() - 0.5);
        for (let y = 0; y < N; y += 1) {
            for (let x = 0; x < N; x += 1) {
                const gx = x / N * G, gy = y / N * G;
                const x0 = Math.floor(gx), y0 = Math.floor(gy);
                const fx = gx - x0, fy = gy - y0;
                const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
                const at = (i, j) => grid[((j + G) % G) * G + ((i + G) % G)];
                const felt = (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
                const laid = Math.cos(y / 4 * Math.PI * 2) * 0.12;
                const cd = ((x % 64) + 64) % 64 - 32;
                const chain = Math.exp(-cd * cd / 3) * 0.35;
                v[y * N + x] = v[y * N + x] * 0.55 + felt * 0.7 + laid + chain;
            }
        }
        const out = new Uint8Array(N * N);
        for (let i = 0; i < N * N; i += 1) out[i] = Math.max(0, Math.min(255, Math.round(128 + v[i] * 64)));
        return out;
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('inkdraft', '墨痕', container, services);
        const crop = createElement('div', 'inkdraft-crop');
        crop.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < 4; i += 1) crop.append(createElement('i'));
        const kicker = createElement('div', 'inkdraft-kicker', '墨痕');
        const timecode = createElement('div', 'inkdraft-timecode', '00:00');
        const translation = createElement('div', 'stage-translation inkdraft-translation');
        const notice = createElement('div', 'inkdraft-notice');
        notice.hidden = true;
        mode.root.append(crop, kicker, timecode, translation, notice);

        const mainCanvas = document.createElement('canvas');
        const idsCanvas = document.createElement('canvas');
        // 渲染器（inkdraft-pixi.js）：Pixi 的应用备好之后才有，见下面的 boot
        let glState = null;
        let pixiApp = null;
        const buffer = { w: 1, h: 1 };
        const fail = () => {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，墨痕画不出来，请换一个舞台';
        };

        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const blobBuffer = new Float32Array(MAX_BLOBS * 4);
        const ringBuffer = new Float32Array(MAX_RINGS * 4);
        let lastOnsets = -1;
        let beatTime = -Infinity;
        const accentBuffer = new Float32Array(MAX_ACCENT * 4);
        const cloudBuffer = new Float32Array(MAX_CLOUDS * 4);
        let cues = [];
        let cuesFor = null;
        let world = { W: 0, H: 0, aspect: 0 };
        let size = { w: 0, h: 0 };
        let smoothSize = [1, 1];
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let idleHandle = 0;
        let palette = null;
        let caption = '';
        let lastTimecode = '';
        let lastTranslation = '';
        let lostContext = false;
        const stats = { builds: 0, buildMs: 0, draws: 0, lastShot: '', cue: -1 };

        const settings = () => {
            const tuning = mode.config.modes?.inkdraft || {};
            return {
                cameraCuts: tuning.cameraCuts !== false,
                figures: tuning.figures !== false,
                collisions: tuning.collisions !== false,
                inkFlip: Boolean(tuning.inkFlip),
                negativeShots: tuning.negativeShots !== false,
                halftone: clamp(tuning.halftone ?? 0.8, 0, 1),
                grain: clamp(tuning.grain ?? 0.5, 0, 1),
                cloud: clamp(tuning.cloud ?? 0.75, 0, 1),
                keywords: tuning.keywords !== false,
                bleed: tuning.inkBleed !== false,
                spatter: tuning.inkSpatter !== false && tierOf(mode.config.quality).detail,
                figureDetail: tierOf(mode.config.quality).detail,
                wobble: tuning.inkWobble === false ? 0 : 1,
                scene: typeof tuning.inkScene === 'string' ? tuning.inkScene : 'auto',
                paper: tuning.paperTexture === false ? 0 : 1,
                detail: tierOf(mode.config.quality).detail,
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                waitingOpacity: clamp(tuning.waitingOpacity ?? 0.35, 0, 1),
                showTranslation: tuning.showTranslation !== false,
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                figureScale: clamp(tuning.objectDensity ?? 1, 0.25, 2) > 1 ? 1.1 : 1,
                reducedMotion: Boolean(reducedMotion?.matches),
                quality: mode.config.quality || 'standard'
            };
        };

        const readPalette = () => {
            const p = services?.app?.stagePalette || {};
            const light = Boolean(p.light);
            let paper = hexRgb(p.background, light ? [0.95, 0.94, 0.9] : [0.09, 0.1, 0.11]);
            let ink = hexRgb(p.ink, light ? [0.1, 0.12, 0.12] : [0.95, 0.94, 0.91]);
            const accent = hexRgb(p.accent, [0.95, 0.66, 0]);
            if (settings().inkFlip) [paper, ink] = [ink, paper];
            // 网点：纸和墨之间偏纸的一档，和墨分得开
            // 浅色纸上同样的比例看着淡得多（亮处眼睛不敏感）：浅色主题网点和墨团都再往墨那边挪一点
            const paperLight = paper.reduce((a, v) => a + v, 0) / 3 > 0.5;
            const dot = paper.map((v, i) => v + (ink[i] - v) * (paperLight ? 0.52 : 0.42));
            // 漂在字上的墨团：纸和墨之间的一档灰（像印刷压的第二道专色）
            const blob = paper.map((v, i) => v + (ink[i] - v) * (paperLight ? 0.47 : 0.36));
            palette = { paper, ink, accent, dot, blob, paperLight };
            const css = (rgb, alpha = 1) => `rgba(${rgb.map(v => Math.round(v * 255)).join(',')},${alpha})`;
            mode.root.style.setProperty('--inkdraft-paper', css(paper));
            mode.root.style.setProperty('--inkdraft-mark', css(ink, 0.62));
        };

        const fontFamily = () => {
            const family = global.getComputedStyle?.(mode.root).fontFamily || '';
            return family || Utils.STAGE_FONT;
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            const tier = tierOf(quality);
            const dpr = Math.min(tier.ratio, global.devicePixelRatio || 1);
            // 画面（字边、网点、颗粒）按这一档的像素密度画，上限 tier.native；平滑的场再按 tier.smooth 缩、上限 tier.pixels
            const scale = Math.min(dpr, Math.sqrt(tier.native / (w * h)));
            const bw = Math.max(1, Math.round(w * scale));
            const bh = Math.max(1, Math.round(h * scale));
            const smoothScale = Math.min(scale * tier.smooth, Math.sqrt(tier.pixels / (w * h)));
            smoothSize = [Math.max(1, Math.round(w * smoothScale)), Math.max(1, Math.round(h * smoothScale))];
            if (glState) {
                // 渲染器按「CSS 大小 × 每个 CSS 像素几个缓冲像素」算画布
                if (glState.resize(w, h, bw / w)) still.invalidate();
                buffer.w = glState.width; buffer.h = glState.height;
            } else { buffer.w = bw; buffer.h = bh; }
            size = { w, h };
            const aspect = w / h;
            if (!world.aspect || Math.abs(aspect / world.aspect - 1) > 0.04) {
                const W = aspect >= 1 ? 2048 : Math.round(2048 * aspect);
                const H = Math.min(2048, Math.round(W / aspect));
                world = { W, H, aspect: W / H };
                mainCanvas.width = W; mainCanvas.height = H;
                idsCanvas.width = Math.ceil(W * ID_SCALE); idsCanvas.height = Math.ceil(H * ID_SCALE);
                glState?.resetCanvases();
            }
        };

        const trackKey = frame => frame.track?.path || frame.track?.title || '';
        const ensureCues = (frame) => {
            const key = `${trackKey(frame)}|${Math.round(frame.duration || 0)}`;
            if (cuesFor && cuesFor.lines === frame.lines && cuesFor.key === key) return;
            cues = buildCues(frame.lines || [], frame.duration);
            cuesFor = { lines: frame.lines, key };
            glState?.slots.forEach((slot) => { slot.key = null; slot.data = null; });
            // 字体分片还没下载完：下载完把字图作废重画（字宽变了，分镜也要重排）
            Utils.loadLyricFont(frame.lines, [INK_WEIGHT], () => { glyphSource.clear(); glState?.slots.forEach((slot) => { slot.key = null; slot.data = null; }); redraw(); }, frame.track?.title || '');
        };

        // 只有会改变纹理和分镜的设置进键；网点、颗粒、配色这些只是着色器参数。
        const slotKey = (index) => {
            const s = settings();
            return `${cuesFor?.key}|${index}|${world.W}x${world.H}|${s.fontScale}|${s.figures}|${s.collisions}|${s.cameraCuts}|${s.negativeShots}|${s.figureScale}|${s.reducedMotion}|${s.spatter}|${s.figureDetail}|${s.scene}`;
        };
        const slotFor = (index, build = true) => {
            if (!glState || index < 0 || index >= cues.length) return null;
            const key = slotKey(index);
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            const current = latestFrame;
            const data = prepareCue(cues[index], index, {
                W: world.W, H: world.H, aspect: world.aspect, family: fontFamily(), settings: settings(),
                trackKey: trackKey(current || {}), title: String(current?.track?.title || '').replace(/\.(flac|mp3|wav|m4a|ogg|opus|ape|aac|wma|alac|dsf)$/i, ''),   // 没有标签时标题是文件名，去掉扩展名
                prevCue: cues[index - 1] || null,
                scene: sceneFor(trackKey(current || {}), settings().scene),
                mainCanvas, idsCanvas
            });
            // 最久没用的槽，但不动正在画的这一段和上一段
            const busy = new Set([stats.cue, stats.cue - 1].map(i => (i >= 0 ? slotKey(i) : '')));
            const slot = glState.slots.filter(s => !busy.has(s.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            glState.fill(slot, mainCanvas, idsCanvas, data);
            data.atlas = { width: data.atlas.width, height: data.atlas.height };
            slot.key = key;
            slot.data = data;
            slot.used = performance.now();
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        // 下一段在空闲时备好，换句时不卡。
        const scheduleNext = (index) => {
            if (idleHandle || !glState || index + 1 >= cues.length || slotFor(index + 1, false)) return;
            const run = () => {
                idleHandle = 0;
                if (!mode.destroyed && !lostContext) slotFor(index + 1, true);
            };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        const draw = (frame) => {
            if (!glState || lostContext) return;
            const width = buffer.w, height = buffer.h;
            const t = frame.playbackTime;
            const index = findCue(cues, t);
            const slot = slotFor(index, true);
            if (!slot) return;
            const data = slot.data;
            stats.cue = index;
            const view = viewAt(data.shots, t);
            stats.lastShot = view.shot;
            const s = settings();
            const audio = frame.audio || {};
            const bass = clamp((audio.bass || 0) * s.audioReactivity, 0, 1.5);
            if (Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets) {
                if (lastOnsets >= 0 && frame.isPlaying && s.audioReactivity > 0) beatTime = t;
                lastOnsets = audio.onsets;
            }
            const beatAge = t >= beatTime ? t - beatTime : Infinity;
            const counts = blobsAt(data, t, blobBuffer, ringBuffer, accentBuffer, bass, s.reducedMotion ? Infinity : beatAge, cloudBuffer);
            counts.blobs = cullBlobs(blobBuffer, counts.blobs, view, width / height);

            let prevFade = 0;
            let prevSlot = null;
            let prevView = null;
            const since = t - data.cue.start;
            let smash = 0;
            // 墨化 0.38 秒就收（再长，上一句的碎笔会在新字周围飘太久）；碎开 0.5 秒
            const prevLen = data.transition === 'ink' ? 0.38 : 0.5;
            if ((data.transition === 'ink' || data.transition === 'smash') && since < prevLen && index > 0) {
                prevSlot = slotFor(index - 1, false);
                if (prevSlot) {
                    prevFade = smooth(0, prevLen, since) * 0.999 + 0.001;
                    prevView = viewAt(prevSlot.data.shots, data.cue.start - 0.001);
                    if (data.transition === 'smash') smash = clamp(since / 0.5, 0.001, 1);
                }
            }
            // 开墨比墨漫慢一点、口子从正中开，开到一半网点跟着鼓一下
            const floodLen = data.transition === 'burst' ? 0.85 : 0.6;
            const flooding = (data.transition === 'flood' || data.transition === 'burst') && since >= 0 && since < floodLen && !s.reducedMotion;
            const floodR = flooding ? 1.9 * (1 - Math.pow(1 - since / floodLen, 2.4)) : 0;

            const put = (target, ...values) => { for (let i = 0; i < values.length; i += 1) target[i] = values[i]; };
            // 逐字层的参数
            if (data.glyphCount) {
                const gu = glState.glyphUniforms;
                put(gu.uView, view.c[0], view.c[1], view.h, view.roll);
                gu.uAspect = width / height;
                gu.uTime = t;
                gu.uPop = s.reducedMotion ? 0 : 1;
                const local0 = t - data.cue.start;
                gu.uReveal = Math.min(1, s.waitingOpacity / 0.35) * smooth(0, 0.35, local0);
                gu.uCss = height / Math.max(1, size.h);
                gu.uBleed = s.bleed ? 1 : 0;
                gu.uWobble = s.wobble;
            }
            // 平滑场和主遍共用的参数（uRes、uAspect 每遍不同，渲染器自己填；墨团那几个数组就是 blobBuffer 它们本身）
            const u = glState.uniforms;
            put(u.uWorld, world.W, world.H);
            put(u.uIdSize, idsCanvas.width, idsCanvas.height);
            put(u.uView, view.c[0], view.c[1], view.h, view.roll);
            if (prevView) put(u.uPrevView, prevView.c[0], prevView.c[1], prevView.h, prevView.roll);
            u.uPrevFade = prevSlot ? prevFade : 0;
            u.uTime = t;
            put(u.uStroke, data.strokeStart, data.strokeStep);
            const local = t - data.cue.start;
            u.uTone = smooth(0.05, 0.9, local);
            u.uBlobCount = counts.blobs;
            u.uAccentCount = counts.accents;
            u.uBlobCol.set(palette.blob);
            u.uDotPx = height / Math.max(1, size.h);
            u.uDotAngle = view.angle ?? 0.26;
            put(u.uFlood, data.flood[0], data.flood[1], floodR, flooding ? 1 : 0);
            u.uSmash = smash;
            // 扫笔跨在换句上：换句前 0.2 秒笔头进画，换句后 0.4 秒飞白裂开
            let sweepU = -1, sweepP = null;
            const nextData = cues[index + 1] ? slotFor(index + 1, false)?.data : null;
            if (!s.reducedMotion) {
                if (data.transition === 'sweep' && since >= 0 && since < SWEEP_AFTER) { sweepU = (SWEEP_BEFORE + since) / (SWEEP_BEFORE + SWEEP_AFTER); sweepP = data.sweep; }
                else if (nextData?.transition === 'sweep' && t > nextData.cue.start - SWEEP_BEFORE) {
                    sweepU = (t - nextData.cue.start + SWEEP_BEFORE) / (SWEEP_BEFORE + SWEEP_AFTER); sweepP = nextData.sweep;
                }
            }
            put(u.uSweep, sweepU, sweepP ? sweepP[0] : 0, sweepP ? sweepP[1] : 0, sweepP ? 1 : 0);
            u.uCloud = s.cloud;
            const exiting = !s.reducedMotion && (!nextData || nextData.transition === 'cut') && data.cue.kind === 'line';
            u.uExit = exiting ? smooth(data.cue.end - 0.45, data.cue.end, t) : 0;
            // 流场每秒跳 8 格、颗粒每秒 6 格：手绘动画那种「沸腾」，不是连续流动
            const flowStep = s.reducedMotion ? 0 : Math.floor(t * 8);
            u.uFlow = flowStep * 0.13;
            u.uFlowT = flowStep / 8;
            u.uGrainStep = s.reducedMotion || !s.detail ? 0 : Math.floor(t * 6) % 64;
            u.uPaper.set(palette.paper);
            u.uInk.set(palette.ink);
            u.uAccentCol.set(palette.accent);
            u.uKeywords = s.keywords ? 1 : 0;
            u.uDot.set(palette.dot);
            u.uNeg = view.neg ? 1 : 0;
            u.uHalftone = s.halftone;
            u.uGrain = s.grain;
            u.uPaperGrain = s.paper;
            u.uPress = s.paper && s.detail ? (palette.paperLight ? 1 : 0.5) : 0;
            const burstKick = data.transition === 'burst' && since >= 0 && since < 0.9 ? Math.sin(Math.PI * since / 0.9) : 0;
            u.uBeat = s.reducedMotion ? 0 : Math.min(1, bass * 0.6 + (beatAge < 0.25 ? (1 - beatAge / 0.25) * 0.5 : 0) + burstKick);
            // 三遍：逐字层进墨场、低分辨率的平滑场、原生像素的主遍
            glState.render(slot, prevSlot, smoothSize);
            stats.draws += 1;
            scheduleNext(index);
        };

        const updateOverlay = (frame) => {
            const next = `墨痕 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const tc = formatTime(frame.playbackTime).slice(0, 5);
            if (tc !== lastTimecode) { lastTimecode = tc; timecode.textContent = tc; }
            const text = settings().showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latestFrame = frame;
            if (!palette) readPalette();
            ensureCues(frame);
            updateOverlay(frame);
            if (!glState) return;
            const quality = mode.config.quality || 'standard';
            const aim = 1000 / tierOf(quality).fps;
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (still.same(frame, `${buffer.w}x${buffer.h}|${stats.builds}`)) return;
            lastDraw = aim && now - lastDraw < aim * 2 ? lastDraw + aim : now;
            draw(frame);
        };

        const redraw = () => {
            still.invalidate();
            lastDraw = -Infinity;
            if (latestFrame) mode.updateFrame(latestFrame);
        };

        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => {
            updateConfig(config);
            resize();
            readPalette();
            redraw();
        };
        mode.resize = () => { resize(); redraw(); };
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { readPalette(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), cues: cues.length, cue: stats.cue, shot: stats.lastShot,
            builds: stats.builds, buildMs: stats.buildMs, draws: stats.draws,
            buffer: `${buffer.w}x${buffer.h}`, renderer: 'pixi', world: `${world.W}x${world.H}`,
            style: glState?.slots.find(s => s.data?.index === stats.cue)?.data?.style
        });

        // 上下文丢了由 Pixi 自己恢复；两张画布是各段共用的，恢复后每段都得重画重传
        const onLost = () => { lostContext = true; };
        const onRestored = () => { lostContext = false; glState?.resetCanvases(); redraw(); };
        const boot = async () => {
            const { PIXI, Effects, InkPixi } = pixiParts();
            if (!PIXI || !Effects || !InkPixi) { fail(); return; }
            let app = null;
            try {
                // 画布不透明（整张纸都是自己画的，合成时不用和底下混）。舞台关掉后渲染器停放一会儿，
                // 很快又进墨痕时上下文和编译好的着色器直接接着用（见 createApplication）
                app = await Effects.createApplication(PIXI, {
                    backgroundAlpha: 1,
                    backgroundColor: 0x000000,
                    preference: 'webgl',
                    autoStart: false,
                    antialias: false,
                    resolution: Math.min(2, global.devicePixelRatio || 1),
                    autoDensity: true
                });
                if (mode.destroyed) { Effects.releaseApplication(app); return; }
                app.stop();
                const made = InkPixi.create(PIXI, app, {
                    vertex: VERT, fragment: FRAG, smoothFragment: SMOOTH_FRAG, glyphVertex: GLYPH_VERT, glyphFragment: GLYPH_FRAG,
                    glyphFloats: GLYPH_FLOATS,
                    limits: { blobs: MAX_BLOBS, rings: MAX_RINGS, accents: MAX_ACCENT, clouds: MAX_CLOUDS },
                    buffers: { blobs: blobBuffer, rings: ringBuffer, accents: accentBuffer, clouds: cloudBuffer },
                    paperTile: { size: PAPER_TILE, data: makePaperTile() }
                });
                if (!made) { Effects.releaseApplication(app); fail(); return; }
                pixiApp = app;
                glState = made;
                made.canvas.className = 'inkdraft-canvas';
                made.canvas.addEventListener('webglcontextlost', onLost);
                made.canvas.addEventListener('webglcontextrestored', onRestored);
                mode.root.prepend(made.canvas);
                resize();
                redraw();
            } catch (error) {
                console.error(error);
                if (app && !pixiApp) Effects.releaseApplication(app);
                fail();
            }
        };
        mode.scope.add(() => {
            if (idleHandle) (global.cancelIdleCallback || global.clearTimeout)(idleHandle);
            if (glState) {
                glState.canvas.removeEventListener('webglcontextlost', onLost);
                glState.canvas.removeEventListener('webglcontextrestored', onRestored);
                glState.canvas.removeAttribute('class');
                try { glState.destroy(); } catch (error) { console.warn('[inkdraft] cleanup failed:', error); }
            }
            glState = null;
            if (pixiApp) pixiParts().Effects.releaseApplication(pixiApp);
            pixiApp = null;
        });

        resize();
        boot();
        return mode;
    };

    global.MusicStageInkdraftManager = Object.freeze({
        create: createManager,
        // 给测试用的纯函数
        _test: Object.freeze({ buildCues, findCue, glyphUnits, composeText, viewAt, blobsAt })
    });
})(window);
