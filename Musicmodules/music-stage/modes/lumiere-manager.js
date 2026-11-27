/*
 * 绘光（lumiere）：舞台光式的歌词 PV。暗场里有体积光束、烟雾和浮尘，歌词被光照到才亮；
 * 唱到的字点亮，光扫过时字边泛出光晕。每段（约四句）换一套光位：顶光、百叶窗隙、棱镜分光、
 * 双追光、水波焦散、萤尘，段与段之间熄灯再亮。
 *
 * 和墨痕、雾笺一样：每句准备一次字形纹理（R 字形、G 字编号），每帧一个全屏三角形，
 * 光、烟、尘都是着色器按时间算的。默认每秒 30 帧（节能 24、极致 60），暂停且输入不变时不画。
 */
(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before lumiere-manager.js');

    const { clamp, seededRandom, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const BLOOM = 0.5;   // 泛光强度（见 Utils.createSharpText）
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const MAX_BEAMS = 5;
    const MAX_SPARKS = 6;
    const RIGS = Object.freeze(['zenith', 'lattice', 'prism', 'stage', 'caustic', 'motes']);
    const RIG_ID = Object.freeze({ zenith: 0, lattice: 1, prism: 2, stage: 3, caustic: 4, motes: 5 });
    const SECTION_LINES = 4;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const hsl = (h, s, l) => {
        const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
        return [f(0), f(8), f(4)];
    };

    /* ───────────────────────── 段落：每句一段，每四句换一套光位 ───────────────────────── */

    const buildCues = (lines, duration, seedKey) => {
        const sung = lines.filter(line => readableText(line.fullText));
        const cues = [];
        const rest = (start, end, title) => { if (end > start + 0.05) cues.push({ kind: 'rest', start, end, title }); };
        if (!sung.length) { rest(0, Math.max(Number(duration) || 0, 720), true); }
        else {
            if (sung[0].startTime > 2) rest(0, sung[0].startTime, true);
            sung.forEach((line, i) => {
                const next = sung[i + 1];
                const lineEnd = Math.max(line.endTime, line.vocalEndTime || 0);
                const nextStart = next ? next.startTime : Infinity;
                if (nextStart - lineEnd > 4) {
                    cues.push({ kind: 'line', start: line.startTime, end: lineEnd + 1.2, line, number: i + 1 });
                    rest(lineEnd + 1.2, next ? nextStart : Math.max(Number(duration) || 0, lineEnd + 30), false);
                } else cues.push({ kind: 'line', start: line.startTime, end: nextStart, line, number: i + 1 });
            });
            cues[0].start = 0;
        }
        // 光位：间奏自成一段；歌词每四句一段（遇到间奏重新数）
        let section = -1;
        let count = SECTION_LINES;
        let previousRig = '';
        cues.forEach((cue, i) => {
            if (cue.kind === 'rest' || count >= SECTION_LINES) {
                section += 1;
                count = 0;
                const random = seededRandom(`lumiere:${seedKey}:section:${section}`);
                const options = cue.kind === 'rest' ? ['motes', 'zenith', 'caustic'] : RIGS.filter(r => r !== previousRig);
                cue.rig = options[Math.floor(random() * options.length)];
                cue.sectionStart = true;
                cue.seed = random() * 100;
                cue.flash = section > 0 && random() < 0.5;
                previousRig = cue.rig;
            } else {
                cue.rig = cues[i - 1].rig;
                cue.seed = cues[i - 1].seed;
            }
            cue.section = section;
            cue.focusPull = !cue.sectionStart && cue.kind === 'line' && seededRandom(`lumiere:${seedKey}:focus:${i}`)() < 0.5;
            if (cue.kind === 'line') count += 1;
        });
        return cues;
    };
    const findCue = (cues, t) => {
        let low = 0, high = cues.length - 1, result = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (t >= cues[mid].start) { result = mid; low = mid + 1; } else high = mid - 1;
        }
        return result;
    };

    // 某一刻某套光位的光束：起点（屏幕 0..1，y 朝上）、方向角、半角、强度、颜色。全由时间算。
    const beamsAt = (rig, seed, t, colours, out, colourOut) => {
        let n = 0;
        const push = (x, y, angle, half, power, colour) => {
            if (n >= MAX_BEAMS) return;
            out[n * 4] = x; out[n * 4 + 1] = y; out[n * 4 + 2] = angle; out[n * 4 + 3] = half;
            colourOut[n * 4] = colour[0] * power; colourOut[n * 4 + 1] = colour[1] * power; colourOut[n * 4 + 2] = colour[2] * power; colourOut[n * 4 + 3] = power;
            n += 1;
        };
        const r = seededRandom(`beams:${rig}:${seed.toFixed(3)}`);
        const sway = (k, speed = 0.11, amp = 0.05) => Math.sin(t * speed + seed + k * 1.7) * amp;
        const down = -Math.PI / 2;
        switch (rig) {
            case 'zenith': {
                const count = 1 + Math.floor(r() * 3);
                for (let k = 0; k < count; k += 1) {
                    const x = count === 1 ? 0.5 : 0.25 + k * 0.5 / (count - 1);
                    push(x + sway(k, 0.07, 0.03), 1.25, down + (x - 0.5) * 0.25 + sway(k + 3, 0.09, 0.04), 0.12 + r() * 0.05, k === Math.floor(count / 2) ? 1.1 : 0.75, colours.warm);
                }
                break;
            }
            case 'lattice': {
                const fromLeft = r() < 0.5;
                push(fromLeft ? -0.25 : 1.25, 1.15, (fromLeft ? -0.62 : -2.52) + sway(0, 0.05, 0.03), 0.24, 1.0, colours.warm);
                break;
            }
            case 'prism': {
                const ox = 0.5 + sway(0, 0.06, 0.08);
                for (let k = 0; k < 5; k += 1) {
                    const h = (0.98 + k * 0.17 + t * 0.004) % 1;
                    push(ox, 1.2, down + (k - 2) * 0.2 + sway(k, 0.08, 0.03), 0.05, 0.85, hsl(h, 0.85, 0.62));
                }
                break;
            }
            case 'stage': {
                push(-0.05, 1.12, -0.95 + sway(0, 0.23, 0.22), 0.1, 1.1, colours.accent);
                push(1.05, 1.12, -2.19 + sway(2, 0.19, 0.22), 0.1, 1.1, colours.cool);
                push(0.5, 1.3, down + sway(4, 0.13, 0.12), 0.08, 0.6, colours.warm);
                break;
            }
            case 'caustic':
                push(0.5 + sway(0, 0.05, 0.05), 1.3, down, 0.3, 0.75, colours.cool);
                break;
            default:
                push(0.5 + sway(0, 0.04, 0.1), 1.3, down + sway(1, 0.05, 0.08), 0.22, 0.55, colours.warm);
                break;
        }
        return n;
    };

    /* ───────────────────────── GL ───────────────────────── */

    const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
    const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uText;
uniform sampler2D uGlyph;
uniform sampler2D uPrevText;
uniform vec2 uRes;
uniform vec2 uTextSize;
uniform float uTime;
uniform float uLocal;
uniform float uPrevFade;
uniform float uZoom;
uniform float uPrevZoom;
uniform int uRig;
uniform float uSeed;
uniform vec4 uBeam[${MAX_BEAMS}];
uniform vec4 uBeamCol[${MAX_BEAMS}];
uniform int uBeamCount;
uniform float uLights;     // 熄灯、亮灯（0..1）
uniform float uSmoke;
uniform float uDust;
uniform float uPower;
uniform vec3 uField;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uWaiting;
uniform vec4 uSpark[${MAX_SPARKS}];  // 屏幕 uv、大小、强度：唱到的字边上闪一颗星芒
uniform int uSparkCount;
uniform vec4 uFlare;     // 光源屏幕位置、强度、闪白
uniform float uBokeh;
uniform float uFocus;     // 焦点拉：新句从虚到实（0 = 实）
uniform float uStarfall;  // 片头星落
uniform float uLodBias;   // 字形纹理按屏幕像素，比原来 1600 宽多出来的 mip 级数
${Utils.SPLIT_OUT_GLSL}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}
${Utils.NOISE_GLSL}

// 光照：每束光是一个锥，越远越散越暗；百叶窗把锥切成条，焦散在光里织网
vec3 lightAt(vec2 p, float aspect, out float total) {
    vec3 col = vec3(0.0);
    total = 0.0;
    for (int i = 0; i < ${MAX_BEAMS}; i++) {
        if (i >= uBeamCount) break;
        vec4 b = uBeam[i];
        vec2 o = vec2(b.x * aspect, b.y);
        vec2 d = vec2(cos(b.z), sin(b.z));
        vec2 v = p - o;
        float along = dot(v, d);
        if (along <= 0.0) continue;
        float perp = d.x * v.y - d.y * v.x;
        float ang = abs(atan(perp, along));
        if (ang >= b.w * 1.35) continue;
        // 锥边软一些（舞台灯打在烟里不是硬边），中心不爆白
        float cone = smoothstep(b.w * 1.35, 0.0, ang);
        cone *= cone;
        float fall = 1.0 / (1.0 + along * along * 0.35);
        // 光里的放射细纹：灯的反光碗和镜片不完美，光束里有从灯口散开的明暗细条（按角度的一维噪声，纯算术）
        float ra = ang / max(b.w, 0.01) * 9.0 * sign(perp) + float(i) * 13.7 + uSeed * 5.0;
        float rf = fract(ra), ri = floor(ra);
        float rn = mix(fract(sin(ri * 78.233) * 43758.55), fract(sin((ri + 1.0) * 78.233) * 43758.55), rf * rf * (3.0 - 2.0 * rf));
        float ra2 = ra * 2.7 + 3.1;
        float rf2 = fract(ra2), ri2 = floor(ra2);
        float rn2 = mix(fract(sin(ri2 * 41.7) * 23421.6), fract(sin((ri2 + 1.0) * 41.7) * 23421.6), rf2 * rf2 * (3.0 - 2.0 * rf2));
        float rays = 0.62 + 0.55 * (rn * 0.65 + rn2 * 0.35) * smoothstep(0.0, 0.25, along);
        // 灯口附近更亮更集中（亮芯），锥边带一点冷色的色散
        float core = smoothstep(b.w * 0.55, 0.0, ang) * exp(-along * 1.6);
        float rim = smoothstep(b.w * 0.5, b.w * 1.0, ang) * cone;
        float k = (cone * rays + core * 0.6) * fall * 0.75;
        col += uBeamCol[i].rgb * rim * fall * vec3(-0.05, 0.02, 0.12) * 0.9;
        if (uRig == 1) {
            // 百叶：沿光束横向切成条，条随距离变宽
            float stripes = smoothstep(0.35, 0.55, fract(perp / (along * 0.06 + 0.02) + uSeed));
            k *= 0.25 + stripes * 0.95;
        }
        col += uBeamCol[i].rgb * k;
        total += uBeamCol[i].a * k;
    }
    if (uRig == 4 && total > 0.0005) {
        // 焦散：两层扭过的网格，亮的地方是细线
        vec2 q = p * 3.2 + vec2(uTime * 0.05, uTime * 0.03);
        vec2 w = vec2(vnoise(q + uSeed), vnoise(q * 1.3 - uSeed)) * 1.8;
        float c1 = abs(sin((q.x + w.x) * 3.1) * sin((q.y + w.y) * 2.7));
        float caustic = pow(1.0 - c1, 6.0);
        col *= 0.55 + caustic * 1.4;
        total *= 0.55 + caustic * 1.4;
    }
    return col;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / uRes.y;
    vec2 p = vec2(uv.x * aspect, uv.y);

    float total;
    vec3 light = lightAt(p, aspect, total) * uLights * (0.85 + uPower * 0.3);
    // 烟：慢慢翻滚的两层噪点，只有被光照到才看得见
    // 烟用一层慢噪声把坐标扭开再取样：大团之间有拉长、卷起来的细缕，不是均匀的一团团
    vec2 sp = p * 2.2 + vec2(uTime * 0.03, -uTime * 0.012);
    float warp = vnoise(sp * 0.6 - vec2(uTime * 0.02, 0.0) + 9.0);
    vec2 sw = sp + vec2(warp * 1.6, -warp * 0.9);
    float body = vnoise(sw);
    float wisp = vnoise(vec2(sw.x * 1.4 + sw.y * 2.2, sw.y * 4.8 - sw.x) + 5.0);
    float smoke = body * 0.6 + wisp * 0.4;
    float strands = smoothstep(0.35, 0.75, wisp) * smoothstep(0.25, 0.6, body);
    vec3 air = light * (0.1 + smoke * 0.4 * uSmoke + strands * 0.3 * uSmoke);
    // 字挡光：从这一点朝主光的灯口走几步，路上碰到字（取模糊过的字形），烟里就留下一道字的影子，
    // 像光从字后面穿过来。只算第一束光，五次等距取样都走糊的那一级贴图（影子边是软的，不加抖动免得出颗粒）
    if (uBeamCount > 0 && total > 0.0005) {
        vec2 o = vec2(uBeam[0].x * aspect, uBeam[0].y);
        vec2 toO = o - p;
        float len = length(toO);
        float occ = 0.0;
        for (int j = 0; j < 5; j++) {
            float f = 0.02 + float(j) * 0.065;
            vec2 sp2 = p + toO * min(f, 0.6) * min(1.0, 0.9 / max(len, 0.001));
            vec2 st = (vec2(sp2.x / aspect, 1.0 - sp2.y) - 0.5) / uZoom + 0.5;
            occ = max(occ, textureLod(uText, st, 3.5 + uLodBias).r * (1.0 - float(j) * 0.14));
        }
        air *= 1.0 - smoothstep(0.05, 0.55, occ) * 0.7 * uLights;
    }
    // 浮尘：一格一粒，慢慢飘，只在光里亮
    if (uDust > 0.0 && total > 0.0005) {
        vec2 grid = vec2(aspect * 44.0, 44.0);
        vec2 dp = uv + vec2(uTime * 0.004, uTime * 0.007);
        vec2 cell = floor(dp * grid);
        vec2 h = hash22(cell);
        vec2 centre = (cell + 0.5 + (h - 0.5) * 0.8 + vec2(sin(uTime * 0.5 + h.x * 6.3), cos(uTime * 0.4 + h.y * 6.3)) * 0.12) / grid;
        float dist = length((dp - centre) * vec2(aspect, 1.0)) * 44.0;
        float mote = smoothstep(0.08 + h.y * 0.06, 0.0, dist) * step(0.7, h.x);
        air += light * mote * 1.6 * uDust;
    }

    // 底色里也有一层慢慢翻的烟，中间亮四角暗
    float vig = 1.12 - length((uv - 0.5) * vec2(1.0, 1.25)) * 0.75;
    vec3 col = uField * (0.78 + smoke * 0.5) * vig + air;

    // 背景层：上一句的空心大字、下一句的小字，只在光里隐约看得见
    {
        vec2 tb = (vec2(uv.x, 1.0 - uv.y) - 0.5) / (uZoom * 0.985) + 0.5;
        float bg = texture(uText, tb).b;
        col += (uInk * 0.05 + light * 0.5) * bg;
    }

    // 字：纹理坐标（y 朝下），整句慢慢推近。这一遍按低分辨率算三种颜色：没有字、被这一句的字盖住、
    // 被上一句的字盖住；字的覆盖率在合成那一遍按屏幕像素重新取样
    vec2 tc = vec2(uv.x, 1.0 - uv.y);
    vec2 t1 = (tc - 0.5) / uZoom + 0.5;
    float lit = clamp(total, 0.0, 1.6);
    vec3 cText, cPrev;
    {
        float halo = textureLod(uText, t1, 3.5 + uFocus + uLodBias).r;
        int gid = int(texelFetch(uText, clamp(ivec2(t1 * uTextSize), ivec2(0), ivec2(uTextSize) - 1), 0).g * 255.0 + 0.5);
        float reveal = 0.0;
        float singing = 0.0;
        if (gid > 0) {
            vec2 se = texelFetch(uGlyph, ivec2(gid, 0), 0).xy;
            reveal = smoothstep(se.x - 0.12, se.x + 0.12, uTime);
            // 虚着的时候字框里没有清楚的笔画，按字框上色会糊成一块金色方块：对焦完成前不上唱到的颜色
            singing = smoothstep(se.x - 0.1, se.x + 0.05, uTime) * (1.0 - smoothstep(se.y, se.y + 0.5, uTime)) * (1.0 - uFocus) * (1.0 - uFocus);
        }
        float body = uWaiting * (1.0 - reveal) + reveal * (0.8 + lit * 0.5);
        vec3 ink = mix(uInk, mix(uInk, light / max(total, 0.001), 0.3), clamp(lit, 0.0, 1.0));
        // 字压在光上要读得清：字周围的光和烟压暗一圈（光越亮压得越多），字本身比光亮
        col *= 1.0 - clamp(halo * (0.25 + lit * 0.35), 0.0, 0.6);
        // 唱过的字自己也发一点白光（光外也看得出字在亮）。正在唱的那个字的大光晕交给泛光：
        // 原来按字框乘一层大模糊，字框的边会露出一块方形的金色
        vec3 glowAdd = (light * 0.9 + uAccent * singing * 0.3) * halo * reveal * 0.55 + uInk * halo * reveal * 0.16;
        cText = mix(col, ink * (0.82 + lit * 0.75), clamp(body, 0.0, 1.0)) + uAccent * singing * 0.35 + glowAdd;
        col += glowAdd;
    }
    cPrev = col;
    if (uPrevFade > 0.0) {
        vec2 t0 = (tc - 0.5) / uPrevZoom + 0.5;
        float h0 = textureLod(uPrevText, t0, 3.5 + uLodBias).r;
        vec3 ink = uInk * (0.6 + lit * 0.7);
        // 旧句化成光散开：往上飘一点、变淡
        cPrev = mix(col, ink, uPrevFade * (0.42 + lit * 0.75));
        vec3 haze = light * h0 * uPrevFade * 0.8;
        col += haze; cText += haze; cPrev += haze;
    }
    vec3 extra = vec3(0.0);
    // 星芒：十字细芒 + 一点核
    for (int i = 0; i < ${MAX_SPARKS}; i++) {
        if (i >= uSparkCount) break;
        vec4 s = uSpark[i];
        vec2 d = (uv - s.xy) * vec2(aspect, 1.0) / s.z;
        // 十字芒两条臂之外、离核较远的地方，三项加起来都不到 1/500
        if (min(abs(d.x), abs(d.y)) > 0.1 && dot(d, d) > 0.4) continue;
        float core = exp(-dot(d, d) * 60.0);
        float cross = exp(-abs(d.x) * 70.0) * exp(-abs(d.y) * 3.5) + exp(-abs(d.y) * 70.0) * exp(-abs(d.x) * 3.5);
        float diag = (exp(-abs(d.x - d.y) * 90.0) + exp(-abs(d.x + d.y) * 90.0)) * exp(-length(d) * 9.0) * 0.4;
        extra += mix(uInk, uAccent, 0.25) * (core * 1.4 + cross * 0.55 + diag) * s.w;
    }
    // 光源：亮核、横向拉长的光条、十字芒，对面一圈鬼影
    if (uFlare.z > 0.0) {
        vec2 fd = (uv - uFlare.xy) * vec2(aspect, 1.0);
        float r = length(fd);
        vec3 fc = mix(vec3(1.0, 0.9, 0.72), uAccent, 0.15);
        float glow = exp(-r * r * 900.0) * 1.6 + exp(-r * 9.0) * 0.22;
        float streak = exp(-abs(fd.y) * 260.0) * exp(-abs(fd.x) * 2.2) * 0.5;
        float star = (exp(-abs(fd.x) * 400.0) * exp(-abs(fd.y) * 14.0) + exp(-abs(fd.y) * 400.0) * exp(-abs(fd.x) * 14.0)) * 0.6;
        vec2 gp = (vec2(1.0) - uFlare.xy - uv) * vec2(aspect, 1.0);
        float ghost = smoothstep(0.012, 0.0, abs(length(gp) - 0.07)) * 0.12 + exp(-dot(gp, gp) * 400.0) * 0.08;
        extra += fc * (glow + streak + star + ghost) * uFlare.z;
    }
    // 前景散景：几团很大、很虚的光斑从镜头前飘过
    if (uBokeh > 0.0) {
        for (int i = 0; i < 5; i++) {
            float fi = float(i);
            vec2 c = vec2(fract(0.17 + fi * 0.31 + uTime * (0.006 + fi * 0.002) + uSeed * 0.1), fract(0.73 + fi * 0.47 + sin(uTime * 0.05 + fi) * 0.08));
            vec2 d = (uv - c) * vec2(aspect, 1.0);
            float rad = 0.06 + fract(fi * 0.618) * 0.07;
            float dl = length(d);
            if (dl >= rad) continue;
            float disc = smoothstep(rad, rad * 0.82, dl);
            float rim = smoothstep(rad * 0.75, rad, dl) * disc;
            extra += (light * 0.12 + uInk * 0.012) * (disc + rim * 0.8) * uBokeh;
        }
    }
    extra += vec3(1.0, 0.95, 0.88) * uFlare.w;
    // 片头：几十颗星拖着光尾从上往下落
    if (uStarfall > 0.0) {
        for (int i = 0; i < 24; i++) {
            float fi = float(i);
            float h1 = hash12(vec2(fi, 1.7)), h2 = hash12(vec2(fi, 8.3));
            float speed = 0.25 + h2 * 0.35;
            vec2 head = vec2(h1 * aspect, 1.15 - fract(uLocal * speed + h2) * 1.4);
            vec2 d = p - head;
            if (abs(d.x) > 0.035 || d.y < -0.035 || d.y > 0.2) continue;
            float along = d.y;
            float tail = smoothstep(0.18, 0.0, along) * step(0.0, along) * exp(-abs(d.x) * 900.0);
            float core = exp(-dot(d, d) * 9000.0);
            extra += mix(uInk, uAccent, h1 * 0.5) * (tail * 0.35 + core * 1.2) * uStarfall;
        }
    }
    vec2 v = uv - 0.5;
    float edge = 1.0 - dot(v, v) * 0.8;
    outBase = vec4(clamp((col + extra) * edge, 0.0, 1.0), 1.0);
    outText = vec4(clamp((cText + extra) * edge, 0.0, 1.0), 1.0);
    outPrev = vec4(clamp((cPrev + extra) * edge, 0.0, 1.0), 1.0);
}`;

    // 合成那一遍：按屏幕像素重新取样字形，和低分辨率那一遍用同样的推近、对焦虚化
    const COVERAGE = `
uniform sampler2D uText;
uniform sampler2D uPrevText;
uniform float uZoom;
uniform float uPrevZoom;
uniform float uFocus;
uniform float uPrevFade;
uniform float uLodBias;
vec4 coverage(vec2 uv) {
    vec2 tc = vec2(uv.x, 1.0 - uv.y);
    float r = textureLod(uText, (tc - 0.5) / uZoom + 0.5, uFocus * (4.5 + uLodBias)).r * (1.0 - uFocus * 0.7);
    float r0 = 0.0;
    if (uPrevFade > 0.0) {
        float lod = (1.0 - uPrevFade) * (4.0 + uLodBias) * step(0.001, uFocus);
        r0 = textureLod(uPrevText, (tc - 0.5) / uPrevZoom + 0.5, lod).r;
    }
#ifndef SHARP_SEED
    r = 0.0;   // 这一句的字由逐字层画；泛光取亮部时仍算进去
#endif
    return vec4(r, r0, 0.0, 0.0);
}`;
    const HOME = `
uniform float uZoom;
vec2 home(vec2 t) {
    vec2 tc = (t - 0.5) * uZoom + 0.5;
    return vec2(tc.x, 1.0 - tc.y);
}`;

    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default'
        });
        if (!gl) return null;
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`[lumiere] shader: ${gl.getShaderInfoLog(shader)}`);
            return shader;
        };
        const program = gl.createProgram();
        const vs = compile(gl.VERTEX_SHADER, VERT);
        const fs = compile(gl.FRAGMENT_SHADER, FRAG);
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[lumiere] link: ${gl.getProgramInfoLog(program)}`);
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i += 1) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
        }
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        const texture = (filter, mip) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const slots = Array.from({ length: 3 }, () => ({ text: texture(gl.LINEAR, true), glyph: texture(gl.NEAREST, false), key: null, used: 0 }));
        const sharp = Utils.createSharpText(gl, { label: 'lumiere', coverage: COVERAGE });
        const glyphs = Utils.createGlyphLayer(gl, { label: 'lumiere', home: HOME });
        return { gl, program, uniforms, vao: gl.createVertexArray(), slots, sharp, glyphs, glyphData: new Float32Array(256 * Utils.GLYPH_FLOATS) };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('lumiere', '绘光', container, services);
        const canvas = createElement('canvas', 'lumiere-canvas');
        const kicker = createElement('div', 'lumiere-kicker', '绘光');
        const translation = createElement('div', 'stage-translation lumiere-translation');
        const notice = createElement('div', 'lumiere-notice');
        notice.hidden = true;
        // 取景框：四角、两侧准星、顶上两段虚线
        const viewfinder = createElement('div', 'lumiere-viewfinder');
        viewfinder.setAttribute('aria-hidden', 'true');
        ['tl', 'tr', 'bl', 'br', 'cl', 'cr', 'dl', 'dr'].forEach(k => viewfinder.append(createElement('i', `vf-${k}`)));
        // 片尾字幕卡：最后一段间奏里亮起曲名和歌手
        const credits = createElement('div', 'lumiere-credits');
        const creditsTitle = createElement('div', 'lumiere-credits-title');
        const creditsArtist = createElement('div', 'lumiere-credits-artist');
        credits.append(createElement('i'), creditsTitle, creditsArtist, createElement('i'));
        credits.setAttribute('aria-hidden', 'true');
        let creditsOn = false;
        mode.root.append(canvas, viewfinder, kicker, translation, credits, notice);
        const textCanvas = document.createElement('canvas');

        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，绘光画不出来，请换一个舞台';
        }
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const beamBuffer = new Float32Array(MAX_BEAMS * 4);
        const beamColours = new Float32Array(MAX_BEAMS * 4);
        const sparkBuffer = new Float32Array(MAX_SPARKS * 4);
        let lastOnsets = -1;
        let beatTime = -Infinity;
        let cues = [];
        let cuesFor = null;
        let world = { W: 0, H: 0 };
        let low = [1, 1];
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let colours = null;
        let caption = '';
        let lastTranslation = '';
        let lostContext = false;
        let idleHandle = 0;
        const stats = { builds: 0, buildMs: 0, draws: 0, cue: -1, rig: '' };

        const settings = () => {
            const tuning = mode.config.modes?.lumiere || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                smoke: clamp(tuning.smoke ?? 1, 0, 2),
                dust: clamp(tuning.dust ?? 1, 0, 2),
                waitingOpacity: clamp(tuning.waitingOpacity ?? 0.22, 0, 1),
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                grain: clamp(tuning.grain ?? 0.4, 0, 1),
                flare: clamp(tuning.flare ?? 1, 0, 2),
                bokeh: clamp(tuning.bokeh ?? 1, 0, 2),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: global.MusicStageRuntime.isReducedMotion(reducedMotion),
                quality: mode.config.quality || 'standard'
            };
        };

        // 暗场。浅色主题也是暗场（光要在暗处才看得见），只把底色往主题那边带一点。
        const readColours = () => {
            const p = services?.app?.stagePalette || {};
            const bg = hexRgb(p.background, [0.09, 0.1, 0.11]);
            const accent = hexRgb(p.accent, [0.95, 0.66, 0]);
            const secondary = hexRgb(p.secondary, [0.46, 0.75, 0.68]);
            const light = Boolean(p.light);
            colours = {
                field: light ? mixRgb(bg, [0.1, 0.095, 0.09], 0.86) : mixRgb(bg, [0.115, 0.108, 0.098], 0.8),   // 暗棕灰的放映厅，不是纯黑
                ink: [0.96, 0.94, 0.9],
                accent,
                warm: [1.0, 0.9, 0.74],
                cool: mixRgb(secondary, [0.8, 0.9, 1.0], 0.35)
            };
            mode.root.style.setProperty('--lumiere-field', `rgb(${colours.field.map(v => Math.round(v * 255)).join(',')})`);
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            // 画布和字形纹理按屏幕原生像素，光和烟按像素预算的低分辨率算（见 Utils.createSharpText）
            const size = Utils.sharpSizes(w, h, PIXELS[quality] || PIXELS.standard);
            low = [size.lw, size.lh];
            if (canvas.width !== size.nw || canvas.height !== size.nh) { canvas.width = size.nw; canvas.height = size.nh; still.invalidate(); }
            const W = Math.min(4096, size.nw);
            const H = Math.min(4096, size.nh);
            if (W !== world.W || H !== world.H) {
                world = { W, H };
                textCanvas.width = world.W; textCanvas.height = world.H;
                glState?.slots.forEach((slot) => { slot.key = null; });
            }
        };

        const trackKey = frame => frame.track?.path || frame.track?.title || '';
        const ensureCues = (frame) => {
            const key = `${trackKey(frame)}|${Math.round(frame.duration || 0)}`;
            if (cuesFor && cuesFor.lines === frame.lines && cuesFor.key === key) return;
            cues = buildCues(frame.lines || [], frame.duration, key);
            cuesFor = { lines: frame.lines, key };
            glState?.slots.forEach((slot) => { slot.key = null; });
            Utils.loadLyricFont(frame.lines, [500], () => { if (mode.destroyed) return; glState?.slots.forEach((slot) => { slot.key = null; }); redraw(); }, `${frame.track?.title || ''}${frame.track?.artist || ''}`);
        };

        let cachedFamily = '';
        const family = () => {
            if (!cachedFamily) cachedFamily = global.getComputedStyle?.(mode.root).fontFamily || 'system-ui, sans-serif';
            return cachedFamily;
        };

        // 一句的字形图：居中成几行，同一个字号；G 是字编号（字框）
        const slotFor = (index, build = true, s = settings()) => {
            if (!glState || index < 0 || index >= cues.length) return null;
            const key = `${cuesFor?.key}|${index}|${world.W}x${world.H}|${s.fontScale}`;
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            const cue = cues[index];
            const { W, H } = world;
            const ctx = textCanvas.getContext('2d', { alpha: false });
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);
            let glyphs = [];
            if (cue.kind === 'line') glyphs = buildGlyphTimeline(cue.line).map(g => ({ text: g.text, start: g.startTime, end: g.endTime }));
            else if (cue.title) {
                const title = String(latestFrame?.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '');
                glyphs = Array.from(title).map((text, i) => ({ text, start: cue.start + 0.8 + i * 0.07, end: cue.start + 1.2 + i * 0.07 }));
            }
            const data = new Float32Array(256 * 4);
            const placedGlyphs = [];
            const random = seededRandom(`lumiere:${cuesFor?.key}:${index}:layout`);
            const font = (size) => `500 ${size.toFixed(1)}px ${family()}`;
            // 背景层（B 通道）：上一句的大号空心字回声，下一句的小字预告；都只在光里隐约可见
            const textOf = c => (c && c.kind === 'line' && readableText(c.line.fullText) ? String(c.line.fullText).trim() : '');
            const echo = textOf(cues[index - 1]);
            if (echo && cue.kind === 'line') {
                ctx.save();
                const echoSize = H * (0.34 + random() * 0.12);
                ctx.translate(random() < 0.5 ? W * 0.62 : W * 0.04, H * (0.2 + random() * 0.5));
                ctx.rotate((random() - 0.5) * 0.5);
                ctx.globalCompositeOperation = 'lighter';
                ctx.strokeStyle = 'rgb(0,0,255)';
                ctx.lineWidth = Math.max(2, echoSize * 0.012);
                ctx.font = font(echoSize, CJK.test(echo));
                ctx.strokeText(Array.from(echo).slice(0, 8).join(''), 0, 0);
                ctx.restore();
            }
            if (glyphs.length) {
                const visible = glyphs.filter(g => g.text.trim()).length;
                const cjk = glyphs.filter(g => CJK.test(g.text)).length > visible / 2;
                // 按词分主次：重点词大一号，虚词小一号，词与词上下错开一点；整句收在画面中间。
                // 基准字高 0.085 屏高，字距 0.04 字号；放不下先整体缩到 0.8，再折成两行（中文短句也可竖排两列）。
                const words = Utils.wordPlan(glyphs, `lumiere:${cuesFor?.key}:${index}`);
                const hero = H * 0.085 * s.fontScale * (cue.kind === 'rest' ? 0.8 : 1);
                const track = 0.04;
                const advance = (g, size) => { ctx.font = font(size); return ctx.measureText(g.text).width + size * track; };
                const wordWidth = (w, size) => glyphs.slice(w.from, w.to).reduce((sum, g) => sum + advance(g, size * w.scale), 0);
                const band = { w: W * 0.74, h: H * 0.56 };
                const vertical = cjk && cue.kind === 'line' && visible <= 12 && random() < 0.3;
                cue.layout = vertical ? 'column' : 'row';
                const solid = words.filter(w => w.text.trim());
                // 把词分成 1 或 2 组（行 / 列），两组长度尽量接近
                const split = (measure, limit) => {
                    const total = words.reduce((sum, w) => sum + measure(w), 0);
                    if (total <= limit || solid.length < 2) return { groups: [words], fit: Math.min(1, limit / total) };
                    if (total * 0.8 <= limit) return { groups: [words], fit: limit / total };
                    let best = null, acc = 0;
                    words.forEach((w, i) => {
                        acc += measure(w);
                        if (i === words.length - 1) return;
                        const diff = Math.abs(total - 2 * acc);
                        if (!best || diff < best.diff) best = { at: i + 1, diff };
                    });
                    const groups = [words.slice(0, best.at), words.slice(best.at)].map(g => g.filter((w, k, arr) => w.text.trim() || (k > 0 && k < arr.length - 1)));
                    const widest = Math.max(...groups.map(g => g.reduce((sum, w) => sum + measure(w), 0)));
                    return { groups, fit: Math.min(1, limit / widest) };
                };
                const items = [];
                if (vertical) {
                    // 竖排：一列一列从右往左，每个字居中在列心；词之间留半个字
                    const colHeight = w => (w.to - w.from) * hero * w.scale * (1 + track) + hero * 0.12;
                    const { groups, fit } = split(colHeight, band.h);
                    const size0 = hero * fit;
                    const pitch = size0 * 1.6;
                    groups.forEach((group, ci) => {
                        const height = group.reduce((sum, w) => sum + colHeight(w) * fit, 0);
                        let y = H * 0.46 - height / 2;
                        const cx = W / 2 + ((groups.length - 1) / 2 - ci) * pitch;
                        group.forEach((w) => {
                            const size = size0 * w.scale;
                            glyphs.slice(w.from, w.to).forEach((g) => {
                                if (!g.text.trim()) { y += size * 0.5; return; }
                                ctx.font = font(size);
                                const gw = ctx.measureText(g.text).width;
                                items.push({ g, x: cx - gw / 2 + w.jag * size0, baseline: y + size * 0.88, size });
                                y += size * (1 + track);
                            });
                            y += size0 * 0.12;
                        });
                    });
                } else {
                    const { groups, fit } = split(w => wordWidth(w, hero), band.w);
                    const size0 = hero * fit;
                    const pitch = size0 * 1.6;
                    groups.forEach((group, ri) => {
                        const width = group.reduce((sum, w) => sum + wordWidth(w, size0), 0);
                        let x = (W - width) / 2;
                        // 同一行的字按字身中线对齐（大字小字都居中在一条线上），再加各自的错落
                        const mid = H * 0.46 + (ri - (groups.length - 1) / 2) * pitch;
                        group.forEach((w) => {
                            const size = size0 * w.scale;
                            glyphs.slice(w.from, w.to).forEach((g) => {
                                const adv = advance(g, size);
                                if (g.text.trim()) items.push({ g, x, baseline: mid + size * 0.36 + w.jag * size0, size });
                                x += adv;
                            });
                        });
                    });
                }
                // 句子整体略斜，像打在墙上的投影
                const tilt = 0;
                const cos = Math.cos(tilt), sin = Math.sin(tilt);
                ctx.save();
                ctx.translate(W / 2, H / 2); ctx.rotate(tilt); ctx.translate(-W / 2, -H / 2);
                let id = 0;
                items.forEach(({ g, x, baseline, size }) => {
                    ctx.font = font(size, CJK.test(g.text));
                    const w = ctx.measureText(g.text).width;
                    id = Math.min(255, id + 1);
                    ctx.globalCompositeOperation = 'lighten';
                    ctx.fillStyle = `rgb(0,${id},0)`;
                    const gx = Math.floor(x - 2), gy = Math.floor(baseline - size * 0.95), gw = Math.ceil(w + 4), gh = Math.ceil(size * 1.2);
                    ctx.fillRect(gx, gy, gw, gh);
                    const padG = size * 0.1;
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.fillStyle = 'rgb(255,0,0)';
                    ctx.fillText(g.text, x, baseline);
                    data[id * 4] = g.start;
                    data[id * 4 + 1] = g.end;
                    const cx = x + w / 2 - W / 2, cy = baseline - size * 0.35 - H / 2;
                    placedGlyphs.push({
                        x: (W / 2 + cx * cos - cy * sin) / W, y: (H / 2 + cx * sin + cy * cos) / H, size: size / H, w: w / W, start: g.start, end: g.end,
                        id, px: size, box: [(gx - padG) / W, (gy - padG) / H, (gx + gw + padG) / W, (gy + gh + padG) / H]
                    });
                });
                ctx.restore();
            }
            // 下一句的小字预告，放在这句下面偏一侧
            const preview = textOf(cues[index + 1]);
            if (preview && cue.kind === 'line' && random() < 0.65) {
                const size = H * 0.04;
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = 'rgb(0,0,200)';
                ctx.font = font(size, CJK.test(preview));
                ctx.translate(W * (0.5 + (random() - 0.3) * 0.25), H * (0.72 + random() * 0.06));
                ctx.rotate((random() - 0.5) * 0.12);
                ctx.fillText(Array.from(preview).slice(0, 24).join(''), 0, 0);
                ctx.restore();
            }
            const { gl } = glState;
            const busy = new Set([stats.cue, stats.cue - 1].map(i => `${cuesFor?.key}|${i}|${world.W}x${world.H}|${s.fontScale}`));
            const slot = glState.slots.filter(sl => !busy.has(sl.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.text);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.bindTexture(gl.TEXTURE_2D, slot.glyph);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, data);
            slot.key = key;
            slot.glyphs = placedGlyphs;
            // 这一句的字怎么进场、唱到时怎么动（绘光偏安静：升起、弹出、盖章、滑入；唱到时胀一下或闪一下）
            const pick = seededRandom(`lumiere:${cuesFor?.key}:${index}:glyphs`);
            slot.enter = cue.kind === 'line' ? ['rise', 'pop', 'stamp', 'slide'][Math.floor(pick() * 4)] : 'rise';
            slot.sing = ['swell', 'flash', 'bounce'][Math.floor(pick() * 3)];
            slot.used = performance.now();
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        const cancelIdle = () => {
            if (!idleHandle) return;
            (global.cancelIdleCallback || global.clearTimeout)(idleHandle);
            idleHandle = 0;
        };

        const scheduleNext = (index, s = settings()) => {
            if (idleHandle || paused || !glState || index + 1 >= cues.length || slotFor(index + 1, false, s)) return;
            const run = () => { idleHandle = 0; if (!mode.destroyed && !paused && !lostContext) slotFor(index + 1, true); };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        const draw = (frame, s = settings()) => {
            if (!glState || lostContext) return;
            const { gl, program, uniforms: u, vao } = glState;
            const t = frame.playbackTime;
            const index = findCue(cues, t);
            const cue = cues[index];
            const slot = slotFor(index, true, s);
            if (!cue || !slot) return;
            stats.cue = index;
            stats.rig = cue.rig;
            const local = t - cue.start;
            // 换光位时熄灯再亮：段首 0.5 秒亮起，段尾 0.35 秒熄
            const nextCue = cues[index + 1];
            const sectionEnds = !nextCue || nextCue.sectionStart;
            const lights = (cue.sectionStart && !cue.flash ? smooth(0, 0.6, local) : 1) * (sectionEnds ? 1 - smooth(cue.end - 0.4, cue.end, t) * 0.85 : 1);
            const beams = beamsAt(cue.rig, cue.seed, t, colours, beamBuffer, beamColours);
            const prev = index > 0 && local < 0.4 ? slotFor(index - 1, false, s) : null;
            const prevFade = prev ? 1 - smooth(0, 0.4, local) : 0;
            const zoom = 1 + clamp(local / Math.max(1, cue.end - cue.start), 0, 1) * 0.045;
            const prevCue = cues[index - 1];
            const prevZoom = prevCue ? 1.045 + local * 0.06 : 1;
            const audio = frame.audio || {};
            if (Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets) {
                if (lastOnsets >= 0 && frame.isPlaying) beatTime = t;
                lastOnsets = audio.onsets;
            }
            const beat = t >= beatTime ? Math.exp(-(t - beatTime) * 6) * s.audioReactivity : 0;
            // 唱到的字：字右上角闪一颗星芒，0.7 秒收掉
            let sparks = 0;
            sparkBuffer.fill(0);
            if (!s.reducedMotion) {
                const gs = slot.glyphs || [];
                for (let gi = 0; gi < gs.length; gi += 1) {
                    const g = gs[gi];
                    const tau = t - g.start;
                    if (tau < -0.05 || tau > 0.7 || sparks >= MAX_SPARKS) continue;
                    const sx = (g.x + g.w * 0.45 - 0.5) * zoom + 0.5;
                    const sy = 1 - ((g.y - g.size * 0.45 - 0.5) * zoom + 0.5);
                    sparkBuffer[sparks * 4] = sx; sparkBuffer[sparks * 4 + 1] = sy;
                    sparkBuffer[sparks * 4 + 2] = g.size * 2.4;
                    sparkBuffer[sparks * 4 + 3] = Math.sin(clamp((tau + 0.05) / 0.75, 0, 1) * Math.PI) * 0.9;
                    sparks += 1;
                }
            }
            // 光源点：第一束光的出发点拉回画面角上
            let flareX = 0, flareY = 0, flareA = 0;
            if (beams > 0 && cue.rig !== 'caustic' && cue.rig !== 'motes') {
                flareX = clamp(beamBuffer[0], 0.07, 0.93);
                flareY = 0.9;
                flareA = (0.55 + beat * 0.5) * lights * s.flare;
            }
            // 段首闪光切：一半的段落从一片白里亮起来，另一半熄灯再亮
            const flash = cue.sectionStart && cue.flash && !s.reducedMotion ? Math.pow(1 - smooth(0, 0.35, local), 2) * 0.85 : 0;

            const { sharp } = glState;
            sharp.begin(low[0], low[1]);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.text); gl.uniform1i(u.uText, 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, slot.glyph); gl.uniform1i(u.uGlyph, 1);
            gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, (prev || slot).text); gl.uniform1i(u.uPrevText, 2);
            Utils.bindNoise(gl, u.uNoise, 3);
            gl.uniform2f(u.uRes, low[0], low[1]);
            gl.uniform2f(u.uTextSize, world.W, world.H);
            const lodBias = Math.log2(world.W / 1600);
            gl.uniform1f(u.uLodBias, lodBias);
            gl.uniform1f(u.uTime, t);
            gl.uniform1f(u.uLocal, local);
            gl.uniform1f(u.uPrevFade, prevFade);
            gl.uniform1f(u.uZoom, s.reducedMotion ? 1 : zoom);
            gl.uniform1f(u.uPrevZoom, s.reducedMotion ? 1 : prevZoom);
            gl.uniform1i(u.uRig, RIG_ID[cue.rig] ?? 0);
            gl.uniform1f(u.uSeed, cue.seed % 10);
            gl.uniform4fv(u.uBeam, beamBuffer);
            gl.uniform4fv(u.uBeamCol, beamColours);
            gl.uniform1i(u.uBeamCount, beams);
            gl.uniform1f(u.uLights, lights);
            gl.uniform1f(u.uSmoke, s.smoke);
            gl.uniform1f(u.uDust, s.dust);
            gl.uniform1f(u.uPower, clamp(((audio.power || 0) * 0.6 + (audio.bass || 0) * 0.4) * s.audioReactivity, 0, 1.5));
            gl.uniform3fv(u.uField, colours.field);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform1f(u.uWaiting, s.waitingOpacity);
            gl.uniform4fv(u.uSpark, sparkBuffer);
            gl.uniform1i(u.uSparkCount, sparks);
            gl.uniform4f(u.uFlare, flareX, flareY, flareA, flash);
            gl.uniform1f(u.uBokeh, s.reducedMotion ? 0 : s.bokeh);
            // 焦点拉：段内换句时新句从虚到实，旧句跟着虚掉（每段约一半的句子用）
            const focus = !s.reducedMotion && cue.focusPull && local < 0.55 ? 1 - smooth(0, 0.55, local) : 0;
            gl.uniform1f(u.uFocus, focus);
            gl.uniform1f(u.uStarfall, !s.reducedMotion && cue.kind === 'rest' && cue.title ? smooth(0, 1.2, local) * (1 - smooth(cue.end - 1.5, cue.end, t)) : 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            sharp.finish(canvas.width, canvas.height, { grain: s.grain, grainStep: s.reducedMotion ? 0 : Math.floor(t * 6) % 64, bloom: BLOOM * (1 + beat * 0.4), knee: [0.62, 0.3] }, (c, unit) => {
                gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, slot.text); gl.uniform1i(c.uText, unit);
                gl.activeTexture(gl.TEXTURE0 + unit + 1); gl.bindTexture(gl.TEXTURE_2D, (prev || slot).text); gl.uniform1i(c.uPrevText, unit + 1);
                gl.uniform1f(c.uZoom, s.reducedMotion ? 1 : zoom);
                gl.uniform1f(c.uPrevZoom, s.reducedMotion ? 1 : prevZoom);
                gl.uniform1f(c.uFocus, focus);
                gl.uniform1f(c.uPrevFade, prevFade);
                gl.uniform1f(c.uLodBias, lodBias);
            });
            // 逐字层：每个字按自己的入场和唱到的动作画在合成好的画面上
            {
                const data = glState.glyphData;
                let n = 0;
                const list = slot.glyphs || [];
                const stagger = Math.min(0.05, 0.6 / Math.max(1, list.length));
                list.forEach((g, i) => {
                    if (!g.box || n >= 256) return;
                    const pose = Utils.glyphPose(slot.enter, t - cue.start - i * stagger, slot.sing, t - g.start, s.reducedMotion);
                    if (pose[4] <= 0.001) return;
                    const o = n * Utils.GLYPH_FLOATS;
                    data.set(g.box, o);
                    data[o + 4] = g.x; data[o + 5] = g.y; data[o + 6] = g.id; data[o + 7] = g.px;
                    data[o + 8] = pose[0] * g.px; data[o + 9] = pose[1] * g.px; data[o + 10] = pose[2]; data[o + 11] = pose[3];
                    data[o + 12] = pose[4]; data[o + 13] = pose[5]; data[o + 14] = 0; data[o + 15] = 0;
                    data[o + 16] = 0; data[o + 17] = 0; data[o + 18] = 0; data[o + 19] = 0;
                    n += 1;
                });
                glState.glyphs.draw(data, n, (c) => {
                    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.text); gl.uniform1i(c.uText, 0);
                    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sharp.textLayer); gl.uniform1i(c.uTextLayer, 1);
                    gl.uniform2f(c.uTextSize, world.W, world.H);
                    gl.uniform1f(c.uLod, focus > 0 ? focus * (4.5 + lodBias) : -1);
                    gl.uniform1f(c.uFade, 1 - focus * 0.7);
                    gl.uniform1f(c.uZoom, s.reducedMotion ? 1 : zoom);
                });
                stats.glyphs = n;
            }
            stats.draws += 1;
            scheduleNext(index, s);
        };

        const updateOverlay = (frame, s = settings()) => {
            const next = `绘光 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const ci = cues.length > 1 ? findCue(cues, frame.playbackTime) : -1;
            const outro = ci === cues.length - 1 && cues[ci]?.kind === 'rest' && frame.playbackTime - cues[ci].start > 1.2;
            if (outro !== creditsOn) {
                creditsOn = outro;
                if (outro) {
                    creditsTitle.textContent = String(frame.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '');
                    creditsArtist.textContent = String(frame.track?.artist || '');
                }
                credits.classList.toggle('is-on', outro);
            }
            const text = s.showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latestFrame = frame;
            if (!colours) readColours();
            const s = settings();
            ensureCues(frame);
            updateOverlay(frame, s);
            if (!glState) return;
            const aim = 1000 / (FPS[s.quality] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (!frame.isPlaying && still.same(frame, `${canvas.width}x${canvas.height}|${stats.builds}`)) return;
            if (frame.isPlaying) still.invalidate();
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            draw(frame, s);
        };

        const redraw = () => { still.invalidate(); lastDraw = -Infinity; if (latestFrame) mode.updateFrame(latestFrame); };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); cachedFamily = ''; resize(); readColours(); redraw(); };
        mode.resize = () => { resize(); redraw(); };
        mode.suspend = () => { paused = true; cancelIdle(); mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { cachedFamily = ''; readColours(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), cues: cues.length, cue: stats.cue, rig: stats.rig,
            builds: stats.builds, buildMs: stats.buildMs, draws: stats.draws, buffer: `${canvas.width}x${canvas.height}`, effects: `${low[0]}x${low[1]}`
        });

        const onLost = (event) => { event.preventDefault(); lostContext = true; };
        const onRestored = () => { try { glState = createGl(canvas); lostContext = false; redraw(); } catch (error) { console.error(error); } };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            cancelIdle();
            if (glState) {
                const { gl } = glState;
                glState.slots.forEach((slot) => { gl.deleteTexture(slot.text); gl.deleteTexture(slot.glyph); });
                gl.deleteProgram(glState.program);
                glState.sharp.dispose();
                glState.glyphs.dispose();
                gl.deleteVertexArray(glState.vao);
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
            glState = null;
            textCanvas.width = textCanvas.height = 0;
        });

        resize();
        return mode;
    };

    global.MusicStageLumiereManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ buildCues, findCue, beamsAt })
    });
})(window);
