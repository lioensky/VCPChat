(function (global) {
    'use strict';

    /*
     * 印象：把这首歌的封面重画成一幅印象派油画，挂在画廊墙上。
     * 开场时一笔一笔铺上去；每到一段（间奏之后、副歌开始）画里的光就换一个时辰：清晨、正午、黄昏、夜，
     * 同一幅画画四遍；鼓点时水面一样的光圈从画心荡开，画上有细碎的光斑跟着音乐闪；
     * 画下面是一道跟着频谱起伏的线。歌词在右边，像展签一样一句一句往上走。
     *
     * 油画只在换封面时画一次（离屏 768²，带 mipmap），每帧只做合成：取样、调色、光斑。
     */

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before impression-manager.js');
    const { clamp, createElement } = Utils;
    const { resolveSupplementalText, readableText, buildGlyphTimeline } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    const PAINT = 768;          // 油画离屏图的边长
    const BANDS = 32;
    const SECTION_GAP = 4.5;
    const REVEAL_SECONDS = 4.2;

    // 四个时辰的光：暗部往哪偏（lift）、亮部乘什么（gain）、饱和、亮度、光斑颜色、夜
    const PHASES = Object.freeze([
        { name: '清晨', lift: [0.5, 0.52, 0.78], gain: [1.0, 0.95, 1.04], sat: 0.78, bright: 1.06, fleck: [1.0, 0.92, 0.95], night: 0 },
        { name: '正午', lift: [0.3, 0.32, 0.28], gain: [1.06, 1.04, 0.96], sat: 1.12, bright: 1.1, fleck: [1.0, 1.0, 0.9], night: 0 },
        { name: '黄昏', lift: [0.55, 0.25, 0.5], gain: [1.2, 0.86, 0.6], sat: 1.2, bright: 0.96, fleck: [1.0, 0.72, 0.4], night: 0 },
        { name: '夜', lift: [0.08, 0.14, 0.4], gain: [0.48, 0.58, 0.95], sat: 0.62, bright: 0.66, fleck: [1.0, 0.82, 0.45], night: 1 }
    ]);

    const fileUrl = (path) => {
        if (!path) return '';
        if (/^(https?|file|data|blob):/i.test(String(path))) return String(path);
        const p = String(path).replace(/\\/g, '/');
        return 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p).replace(/[?#']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    };
    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const normLine = line => String(line?.fullText || '').replace(/[\s，。、,.!?！？…~～'"“”‘’()（）-]/g, '').toLowerCase();

    // 段落分界：长间奏之后、副歌（整句出现两次以上）开头。返回每段开始的时刻（升序）
    const buildSections = (lines) => {
        const sung = (lines || []).filter(line => readableText(line.fullText));
        const counts = new Map();
        sung.forEach((line) => { const k = normLine(line); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
        const isChorus = line => (counts.get(normLine(line)) || 0) >= 2;
        const starts = [];
        sung.forEach((line, i) => {
            const prev = sung[i - 1];
            if (!prev) { starts.push(line.startTime); return; }
            const gap = line.startTime - Math.max(prev.endTime, prev.vocalEndTime || 0);
            const turn = isChorus(line) && !isChorus(prev);
            if (gap > SECTION_GAP || turn) {
                // 相邻两个分界太近（< 8 秒）就不再换
                if (line.startTime - starts[starts.length - 1] >= 8) starts.push(line.startTime);
            }
        });
        return { starts, isChorus };
    };
    const sectionAt = (starts, t) => {
        let n = 0;
        for (const s of starts) { if (s <= t) n += 1; else break; }
        return Math.max(0, n - 1);
    };

    /* ───────────────────────── GL ───────────────────────── */

    const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    // 一次性：把封面画成油画（各向的 Kuwahara 平涂 + 顺着笔势的笔触 + 厚涂高光），alpha 放落笔顺序
    const PAINT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uCover;
uniform vec4 uCrop;       // 封面里取哪一块正方形：起点、大小（uv）
uniform float uSize;
out vec4 outColor;
${Utils.NOISE_GLSL}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash1(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
vec3 tap(vec2 uv, float lod) { return textureLod(uCover, uCrop.xy + clamp(uv, 0.0, 1.0) * uCrop.zw, lod).rgb; }

void main() {
    vec2 uv = gl_FragCoord.xy / uSize;
    float px = 1.0 / uSize;
    // 笔势：沿着边走（梯度的垂直方向）；平的地方用一片慢慢转的旋涡
    float e = 2.0 * px;
    float gx = luma(tap(uv + vec2(e, 0.0), 1.5)) - luma(tap(uv - vec2(e, 0.0), 1.5));
    float gy = luma(tap(uv + vec2(0.0, e), 1.5)) - luma(tap(uv - vec2(0.0, e), 1.5));
    float strength = length(vec2(gx, gy));
    float swirl = (vnoise(uv * 2.2) - 0.5) * 1.8 + (vnoise(uv * 6.0 + 11.0) - 0.5) * 0.6;
    float ang = mix(swirl, atan(gy, gx) + 1.5708, smoothstep(0.02, 0.09, strength));
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 nor = vec2(-dir.y, dir.x);

    // 四个扇区各取 3×3，挑方差最小的那块的平均色（顺着笔势拉长）
    vec3 best = vec3(0.0);
    float wsum = 0.0;
    for (int k = 0; k < 4; k++) {
        vec2 sx = (k == 0 || k == 3) ? dir : -dir;
        vec2 sy = (k < 2) ? nor : -nor;
        vec3 m = vec3(0.0), m2 = vec3(0.0);
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 3; j++) {
                vec2 o = (sx * (float(i) * 4.2) + sy * (float(j) * 2.2)) * px;
                vec3 c = tap(uv + o, 1.2);
                m += c; m2 += c * c;
            }
        }
        m /= 9.0; m2 /= 9.0;
        float v = dot(abs(m2 - m * m), vec3(1.0));
        float w = 1.0 / (1.0 + pow(v * 220.0, 2.0));
        best += m * w; wsum += w;
    }
    vec3 col = best / wsum;

    // 笔触：画面上撒一层错开的格点，每个格点是一笔短笔：方向取它所在处的笔势，颜色取它中心的颜色，
    // 再各自偏一点色（印象派的「并置色」）。每个像素看周围 5×5 个格点，落在谁的笔里就用谁的颜色，
    // 几笔重叠时按各自的先后（随机）叠。笔里有鬃毛细纹，上沿朝光处亮一点。
    vec2 pix = uv * uSize;
    const float GRID = 9.0;
    vec2 base = floor(pix / GRID);
    float bestP = -1.0;
    vec3 dabCol = col;
    float stroke = 0.0;
    for (int j = -2; j <= 2; j++) {
        for (int i = -2; i <= 2; i++) {
            vec2 g = base + vec2(float(i), float(j));
            float h1 = hash1(dot(g, vec2(12.9898, 78.233)));
            float h2 = hash1(dot(g, vec2(39.346, 11.135)) + 3.1);
            vec2 centre = (g + 0.5 + (vec2(h1, h2) - 0.5) * 0.9) * GRID;
            vec2 cuv = centre / uSize;
            float ex = 3.0 / uSize;
            float ga = luma(tap(cuv + vec2(ex, 0.0), 2.2)) - luma(tap(cuv - vec2(ex, 0.0), 2.2));
            float gb = luma(tap(cuv + vec2(0.0, ex), 2.2)) - luma(tap(cuv - vec2(0.0, ex), 2.2));
            float sw = (vnoise(cuv * 2.2) - 0.5) * 1.8 + (vnoise(cuv * 6.0 + 11.0) - 0.5) * 0.6 + (h1 - 0.5) * 0.35;
            float a = mix(sw, atan(gb, ga) + 1.5708, smoothstep(0.015, 0.07, length(vec2(ga, gb))));
            vec2 d1 = vec2(cos(a), sin(a)), d2 = vec2(-d1.y, d1.x);
            vec2 rel = pix - centre;
            vec2 loc = vec2(dot(rel, d1), dot(rel, d2));
            float hl = 11.0 + h2 * 7.0, hw = 3.6 + h1 * 2.0;
            vec2 k = vec2(max(abs(loc.x) - (hl - hw), 0.0), loc.y);
            float dist = length(k) / hw;
            if (dist < 1.0) {
                float prio = hash1(h1 * 51.0 + h2 * 17.0);
                if (prio > bestP) {
                    bestP = prio;
                    vec3 c2 = tap(cuv, 1.6);
                    c2 += (vec3(hash1(prio * 91.0), hash1(prio * 37.0 + 1.0), hash1(prio * 53.0 + 2.0)) - 0.5) * 0.14;
                    float bristle = 0.9 + 0.1 * sin(loc.y / hw * 9.0 + prio * 40.0);
                    float lit = smoothstep(0.2, 0.7, loc.y / hw) * smoothstep(1.0, 0.75, loc.y / hw) * max(0.15, dot(d2, normalize(vec2(-0.5, 0.8))));
                    float edge = smoothstep(1.0, 0.7, dist);
                    dabCol = mix(dabCol, c2 * bristle + vec3(1.0, 0.97, 0.9) * lit * 0.12, edge);
                    stroke = prio;
                }
            }
        }
    }
    col = dabCol;
    // 印象派：颜色略收几档、饱和推一点
    float l = luma(col);
    col = mix(vec3(l), col, 1.22);

    // 落笔顺序：大块先、细处后，同一笔一起出现
    float order = clamp(0.55 * vnoise(uv * 3.0) + 0.3 * stroke + 0.15 * vnoise(uv * 19.0), 0.0, 1.0);
    outColor = vec4(clamp(col, 0.0, 1.0), order);
}`;

    const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform sampler2D uPaint;
uniform sampler2D uPrev;   // 上一首的画：新画就画在它上面
uniform float uHasPrev;
uniform vec4 uLamp;       // 画灯：中心 x、灯杆 y、半宽（像素）、亮度
uniform float uTreble;
uniform vec3 uWall;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec3 uPrimed;
uniform float uLight;
uniform vec4 uRect;       // 画布：左、下、边长、画框宽（像素，y 朝上）
uniform float uReveal;    // 落笔进度 0..1.1
uniform float uTime;
uniform float uEnergy;
uniform vec2 uRipple;     // 鼓点光圈：年龄、强度
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uSat;
uniform float uBright;
uniform vec3 uFleck;
uniform float uNight;
uniform float uFlecks;
uniform float uFrame;
uniform float uBands[${BANDS}];
uniform vec4 uCurve;      // 线的基线 y、左、右、最大高度
uniform float uGrain;
uniform float uGrainStep;
out vec4 outColor;
${Utils.NOISE_GLSL}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// 金属反射的是什么：暗的展厅，画灯在正上方（一条暖的亮带），左上远处一点天光。r 是反射方向（z 朝看的人）
float gallery(vec3 r) {
    float room = mix(0.08, 0.26, uLight) + 0.06 * smoothstep(-0.5, 0.8, r.y);
    float lamp = exp(-pow((r.y - 0.72) / 0.13, 2.0)) * smoothstep(0.75, 0.1, abs(r.x)) * 2.2 * (0.35 + 0.65 * uLamp.w);
    float sky = smoothstep(0.75, 0.95, dot(r, vec3(-0.55, 0.5, 0.67))) * 0.7;
    return room + lamp + sky;
}
vec3 gilt(vec3 F0, vec3 n, float env) {
    float fres = pow(1.0 - max(n.z, 0.0), 5.0);
    // 金箔不是镜子：一半是镜面反射，一半是被画灯从上面照亮的漫射（朝上的面亮）
    float lampK = 0.35 + 0.65 * uLamp.w;
    vec3 diffuse = F0 * (mix(0.12, 0.3, uLight) + 0.42 * max(0.0, dot(n, normalize(vec3(0.0, 0.8, 0.6)))) * lampK);
    return (F0 + (1.0 - F0) * fres) * env * 0.75 + diffuse;
}
vec3 grade(vec3 c) {
    c *= uBright;
    float l = luma(c);
    c = mix(vec3(l), c, uSat);
    c = c * uGain + uLift * (1.0 - c) * 0.34;
    return c;
}

void main() {
    vec2 frag = gl_FragCoord.xy;
    vec2 uv = frag / uRes;
    // 墙：同一幅画放大、糊开、压暗，像画挂在被它映亮的墙上。颜色慢慢流动（取样位置被几道慢慢变的正弦波推着走，
    // 也把最糊那一级贴图的方块揉开；全用算术，不多取贴图）
    vec2 bgUv = 0.5 + (uv - 0.5) * vec2(1.0, uRes.y / uRes.x) * 0.9;
    vec2 flow = vec2(sin(uv.y * 3.1 + uTime * 0.05 + sin(uv.x * 2.3 - uTime * 0.03) * 1.4),
                     cos(uv.x * 2.7 - uTime * 0.04 + sin(uv.y * 1.9 + uTime * 0.02) * 1.4)) * 0.5;
    bgUv += flow * 0.12;
    vec3 bg = grade(textureLod(uPaint, bgUv, 5.5).rgb);
    if (uHasPrev > 0.5 && uReveal < 1.05) bg = mix(grade(textureLod(uPrev, bgUv, 5.5).rgb), bg, smoothstep(0.0, 1.0, uReveal));
    vec3 col = mix(uWall, bg * mix(0.5, 1.0, uLight), mix(0.55, 0.3, uLight));
    // 墙面：灯照到的地方明暗有一点起伏（像刷过的墙）
    float plaster = flow.x * flow.y * 0.8;
    // 画灯往下打，墙上画框上沿那一圈也被照到一点
    vec2 sp = (frag - vec2(uLamp.x, uLamp.y - uLamp.z * 0.5)) / vec2(uLamp.z * 2.6, uLamp.z * 1.6);
    float spill = exp(-dot(sp, sp)) * uLamp.w;
    col *= 1.0 + plaster * (0.08 + spill * 0.16) * mix(1.0, 0.6, uLight);
    col += vec3(1.0, 0.86, 0.62) * spill * mix(0.06, 0.025, uLight);
    col *= 1.0 - mix(0.55, 0.22, uLight) * dot(uv - 0.5, uv - 0.5);

    vec2 lo = uRect.xy;
    float size = uRect.z, fw = uRect.w * uFrame;
    vec2 p = (frag - lo) / size;
    vec2 c = p - 0.5;
    // 画框的影子
    {
        vec2 d = abs(c - vec2(0.018, -0.03)) - 0.5 - fw / size;
        float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
        col *= 1.0 - (1.0 - smoothstep(0.0, 0.07, sd)) * mix(0.55, 0.28, uLight);
    }
    // 画下面的线：频谱起伏
    if (frag.x > uCurve.y && frag.x < uCurve.z && frag.y < uCurve.x + uCurve.w + 4.0 && frag.y > uCurve.x - 2.0) {
        float f = (frag.x - uCurve.y) / (uCurve.z - uCurve.y) * float(${BANDS} - 1);
        int i = int(f);
        float v = mix(uBands[i], uBands[min(i + 1, ${BANDS} - 1)], smoothstep(0.0, 1.0, fract(f)));
        float edge = 1.0 - smoothstep(0.0, 0.08, abs(f / float(${BANDS} - 1) - 0.5) - 0.42);
        float h = uCurve.x + v * uCurve.w * edge;
        float under = step(frag.y, h) * smoothstep(uCurve.x - 1.0, h, frag.y);
        vec3 lc = mix(uInk, uAccent, 0.55);
        col = mix(col, lc, under * 0.16 + (1.0 - smoothstep(0.0, 1.3, abs(frag.y - h))) * 0.55 * edge);
    }

    vec2 ac = abs(c);
    float inCanvas = step(max(ac.x, ac.y), 0.5);
    if (inCanvas > 0.5) {
        // 画面：笔触随音乐轻轻「呼吸」
        vec2 wob = (vec2(vnoise(p * 34.0 + uTime * 0.35), vnoise(p * 34.0 - uTime * 0.31 + 7.0)) - 0.5) * 0.0018 * (1.0 + 1.5 * uEnergy);
        vec4 paint = texture(uPaint, p + wob);
        vec3 pc = grade(paint.rgb);
        // 光斑：画上细碎的、横着的小光块，跟音乐闪；夜里变成灯
        if (uFlecks > 0.0) {
            vec2 g = p * vec2(34.0, 48.0);
            vec2 cell = floor(g);
            float hcell = hash12(cell);
            float bright = mix(smoothstep(0.35, 0.8, luma(paint.rgb)), 1.0 - smoothstep(0.15, 0.5, luma(paint.rgb)), uNight);
            float tw = pow(0.5 + 0.5 * sin(uTime * (0.8 + 2.2 * hcell) + hcell * 40.0), 6.0);
            vec2 d = (fract(g) - 0.5) * vec2(1.0, 2.4);
            float fleck = exp(-dot(d, d) * 26.0) * tw * step(mix(0.8, 0.9, uNight), hcell) * bright * (0.35 + 1.4 * uEnergy) * uFlecks;
            pc += uFleck * fleck * 0.55;
        }
        // 鼓点：光圈从画心荡开
        if (uRipple.y > 0.0) {
            float dr = abs(length(c) - uRipple.x * 0.75);
            pc *= 1.0 + exp(-dr * dr * 700.0) * uRipple.y * 0.22 * (1.0 - uRipple.x);
        }
        // 厚涂：笔触是有厚度的颜料，按亮度差出起伏，画灯从正上方斜着打下来——笔触朝上的那一沿亮、
        // 背光的一沿暗，凸起的地方上光油一点细的反光；整幅画上面亮、往下慢慢暗（灯在画框上沿）
        {
            float e = 1.3 / size;
            float h0 = luma(paint.rgb);
            float hx = luma(texture(uPaint, p + wob + vec2(e, 0.0)).rgb) - h0;
            float hy = luma(texture(uPaint, p + wob + vec2(0.0, e)).rgb) - h0;
            vec3 n = normalize(vec3(-hx * 5.0, -hy * 5.0, 1.0));
            vec3 L = normalize(vec3((uLamp.x - frag.x) / size * 0.5, 1.1, 0.7));
            float lampK = mix(0.35, 1.0, uLamp.w);
            float relief = 1.0 + (dot(n, L) - L.z) * 1.4 * lampK;
            float varnish = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0) * smoothstep(0.02, 0.12, length(vec2(hx, hy)) * 5.0);
            float fall = mix(1.0, 0.8 + 0.34 * exp(-(1.0 - p.y) * 2.2), lampK);
            pc = pc * relief * fall + vec3(1.0, 0.92, 0.8) * varnish * 0.22 * lampK;
        }
        // 布纹
        pc *= 1.0 + (sin(frag.x * 2.1) * sin(frag.y * 2.1)) * 0.018;
        // 没落笔的地方：打过底的画布上只有炭笔线稿
        if (uReveal < 1.05) {
            float e = 2.5 / size;
            float lx = luma(textureLod(uPaint, p + vec2(e, 0.0), 1.5).rgb) - luma(textureLod(uPaint, p - vec2(e, 0.0), 1.5).rgb);
            float ly = luma(textureLod(uPaint, p + vec2(0.0, e), 1.5).rgb) - luma(textureLod(uPaint, p - vec2(0.0, e), 1.5).rgb);
            float sketch = smoothstep(0.05, 0.2, length(vec2(lx, ly)));
            vec3 primed = uPrimed * (1.0 + (sin(frag.x * 2.1) * sin(frag.y * 2.1)) * 0.02);
            // 换歌：没落到笔的地方还是上一幅画，炭笔线稿淡淡地压在上面
            if (uHasPrev > 0.5) primed = grade(texture(uPrev, p).rgb) * (1.0 + (sin(frag.x * 2.1) * sin(frag.y * 2.1)) * 0.018);
            primed = mix(primed, primed * 0.45, sketch * smoothstep(0.0, 0.25, uReveal) * mix(0.8, 0.4, uHasPrev));
            float m = 1.0 - smoothstep(uReveal - 0.07, uReveal, paint.a);
            pc = mix(primed, pc, m);
        }
        // 画布边缘一圈很浅的暗
        pc *= 1.0 - smoothstep(0.42, 0.5, max(ac.x, ac.y)) * 0.12;
        col = pc;
    } else if (fw > 0.5) {
        // 画框：一圈有线脚的描金框。从里往外：斜的金衬条、一道串珠、一条凹的槽、圆的上沿、往外落下去的深色木边。
        // 每段的斜率给出法线，金按展厅的反射打光（画灯在正上方，上边框的上沿最亮）；四个角是 45° 斜接，有一条细缝。
        float out_ = max(ac.x, ac.y) - 0.5;
        float t = out_ * size / fw;
        if (t < 1.0) {
            bool horiz = ac.y > ac.x;
            vec2 dirOut = horiz ? vec2(0.0, sign(c.y)) : vec2(sign(c.x), 0.0);
            vec2 dirAlong = vec2(dirOut.y, -dirOut.x);
            float along = (horiz ? c.x : c.y) * size;
            vec2 slope2;      // 法线的倾斜：朝外方向、沿边方向
            float ao = 1.0;
            float wood = 0.0;
            if (t < 0.14) { slope2 = vec2(0.9, 0.0); ao = 0.7 + 0.3 * t / 0.14; }
            else if (t < 0.26) {
                // 串珠：沿着边一颗颗的小圆珠
                float u = (t - 0.14) / 0.12 * 2.0 - 1.0;
                float v = fract(along / (fw * 0.12)) * 2.0 - 1.0;
                float rr = u * u + v * v;
                slope2 = rr < 1.0 ? vec2(-u, -v) * 1.6 / sqrt(max(1.0 - rr, 0.05)) * 0.5 : vec2(0.0);
                ao = rr < 1.0 ? 1.0 : 0.5;
            }
            else if (t < 0.6) { float u = (t - 0.26) / 0.34; slope2 = vec2((u - 0.5) * 2.6, 0.0); ao = 0.62 + 0.38 * abs(u - 0.5) * 2.0; }
            else if (t < 0.84) { float u = (t - 0.6) / 0.24; slope2 = vec2((0.5 - u) * 3.0, 0.0); }
            else { slope2 = vec2(-1.2, 0.0); wood = 1.0; ao = 0.85; }
            vec3 n = normalize(vec3(-dirOut * slope2.x - dirAlong * slope2.y, 1.0));
            // 展厅的反射只算一次，金、胶泥、木头共用
            float env = gallery(reflect(vec3(0.0, 0.0, -1.0), n));
            vec3 fc = gilt(vec3(1.0, 0.78, 0.4), n, env) * ao;
            // 描金磨掉的地方露出底下的红色胶泥（只在圆的上沿、很少）
            float worn = smoothstep(0.55, 0.98, sin(along * 0.11) * sin(along * 0.037 + 1.7) * sin(t * fw * 0.5 + along * 0.013)) * step(0.6, t) * step(t, 0.84);
            fc = mix(fc, vec3(0.42, 0.14, 0.09) * (0.3 + env * 0.6), worn * 0.45);
            vec3 woodCol = vec3(0.1, 0.065, 0.045) * (0.6 + env * 0.8);
            woodCol *= 1.0 + sin(along * 0.05 + sin(t * 20.0 + along * 0.011) * 2.0) * 0.12;
            fc = mix(fc, woodCol, wood);
            // 斜接缝
            fc *= 1.0 - (1.0 - smoothstep(0.0, 1.2, abs(ac.x - ac.y) * size)) * 0.5;
            col = mix(col, fc, 1.0 - smoothstep(0.96, 1.0, t));
        }
    }
    // 画灯：画框上方一支铜灯，往下打一束暖光；光里有灰尘慢慢飘，高音亮时闪一下
    vec2 q = frag - uLamp.xy;
    float hw = uLamp.z;
    // 只在灯和它的光照得到的那一块里算
    if (uLamp.w > 0.0 && q.y > -hw * 3.6 && q.y < hw * 0.3 && abs(q.x) < hw * 1.05 + max(-q.y, 0.0) * 0.62 + 4.0) {
        float down = -q.y;
        float spread = hw * 1.05 + max(down, 0.0) * 0.62;
        float cone = smoothstep(spread, spread * 0.45, abs(q.x)) * smoothstep(-hw * 0.08, hw * 0.3, down) * exp(-max(down, 0.0) / (hw * 2.8));
        vec3 warm = vec3(1.0, 0.86, 0.62);
        col += (col * 0.42 + warm * mix(0.05, 0.02, uLight)) * cone * uLamp.w;
        if (cone > 0.015 && down < hw * 2.8) {
            // 灰尘：光束切成格子，一格最多一粒，格子整体慢慢往下飘——每个像素只看自己那一格
            float c = hw * 0.2;
            vec2 bq = vec2(q.x, down + uTime * c * 0.12);
            vec2 cell = floor(bq / c);
            float h1 = hash12(cell + 3.7), h2 = hash12(cell + 9.1), h3 = hash12(cell + 17.3);
            vec2 mp = (cell + 0.2 + 0.6 * vec2(h1, h2)) * c + vec2(sin(uTime * (0.3 + h3) + h1 * 20.0) * c * 0.15, 0.0);
            vec2 m = mp - bq;
            float r = 0.9 + 1.4 * h3;
            float tw = 0.55 + 0.45 * sin(uTime * (1.3 + 2.0 * h1) + h2 * 30.0);
            float dust = step(0.78, h3 * 0.5 + h1 * 0.5) * exp(-dot(m, m) / (r * r)) * tw;
            col += warm * dust * cone * (0.55 + 1.6 * uTreble) * uLamp.w * mix(1.0, 0.35, uLight);
        }
        // 灯罩：一根细铜管，下沿是发光的缝；两根短臂接到画框上
        vec2 bd = abs(q - vec2(0.0, hw * 0.07)) - vec2(hw, hw * 0.055);
        float bar = length(max(bd, 0.0)) + min(max(bd.x, bd.y), 0.0);
        float arm = max(abs(abs(q.x) - hw * 0.55) - 1.2, max(q.y - hw * 0.05, -q.y - hw * 0.42));
        // 灯罩是一根圆铜管、臂是两根细圆杆：按截面的法线照展厅打光
        // （管和杆只打一次光：哪个近用哪个的截面法线）
        float onBar = step(bar, arm);
        float v = clamp((q.y - hw * 0.07) / (hw * 0.055), -1.0, 1.0);
        float va = clamp((abs(q.x) - hw * 0.55) / 1.6, -1.0, 1.0);
        vec3 nl = onBar > 0.5 ? vec3(0.0, v, sqrt(max(0.0, 1.0 - v * v))) : vec3(va, 0.0, sqrt(max(0.0, 1.0 - va * va)));
        vec3 brass = gilt(vec3(0.92, 0.72, 0.42), nl, gallery(reflect(vec3(0.0, 0.0, -1.0), nl))) * mix(0.85, 1.0, onBar);
        col = mix(col, brass, 1.0 - smoothstep(0.0, 1.2, min(arm, bar)));
        col += warm * exp(-pow(max(abs(q.x) - hw * 0.92, 0.0) / 3.0, 2.0) - pow((q.y - hw * 0.015) / 1.6, 2.0)) * 0.7 * uLamp.w;
    }
    if (uGrain > 0.0) col += (hash12(floor(frag / 1.5) + uGrainStep * 11.0) - 0.5) * 0.035 * uGrain;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    const compile = (gl, type, src) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`[impression] shader: ${gl.getShaderInfoLog(shader)}`);
        return shader;
    };
    const link = (gl, frag) => {
        const program = gl.createProgram();
        const vs = compile(gl, gl.VERTEX_SHADER, VERT);
        const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[impression] link: ${gl.getProgramInfoLog(program)}`);
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i += 1) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
        }
        return { program, uniforms };
    };
    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
        if (!gl) return null;
        const paint = link(gl, PAINT_FRAG);
        const main = link(gl, FRAG);
        const makeTex = () => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const cover = makeTex();
        // 两张画轮流用：换歌时旧画留着，新画落笔前露出来
        const sheets = [0, 1].map(() => {
            const tex = makeTex();
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PAINT, PAINT, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            return { tex, fbo };
        });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { gl, paint, main, cover, sheets, cur: 0, hasPrev: false, vao: gl.createVertexArray() };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('impression', '印象', container, services);
        const canvas = createElement('canvas', 'impression-canvas');
        const rail = createElement('div', 'impression-rail');
        const track = createElement('div', 'impression-track');
        rail.append(track);
        const label = createElement('div', 'impression-label');
        label.innerHTML = '<b></b><span class="impression-artist"></span><span class="impression-medium"></span>';
        const labelTitle = label.querySelector('b');
        const labelArtist = label.querySelector('.impression-artist');
        const labelMedium = label.querySelector('.impression-medium');
        const kicker = createElement('div', 'impression-kicker', '印象');
        const notice = createElement('div', 'impression-notice');
        notice.hidden = true;
        mode.root.append(canvas, rail, label, kicker, notice);
        const card = Utils.watchOverlay(mode.root);
        mode.scope.add(() => card.destroy());

        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，画不出来，请换一个舞台';
        }
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const bands = new Float32Array(BANDS);
        const grade = { lift: [...PHASES[0].lift], gain: [...PHASES[0].gain], sat: PHASES[0].sat, bright: PHASES[0].bright, fleck: [...PHASES[0].fleck], night: 0 };
        let colours = null;
        let paused = false;
        let latest = null;
        let lastDraw = -Infinity;
        let lastT = null;
        let lostContext = false;
        let coverUrl = null;
        let painted = false;
        let paintedAt = 0;     // 墙上时钟：开始落笔的时刻（秒）
        let energy = 0;
        let treble = 0;
        let lastOnsets = -1;
        let ripple = { age: 1, str: 0 };
        let sectionsFor = null;
        let sections = { starts: [], isChorus: () => false };
        let railFor = null;
        let railRows = [];
        let currentRow = -1;
        let glyphs = [];
        let sung = -1;
        let caption = '';
        let phaseIndex = -1;
        let labelKey = '';
        const stats = { draws: 0, paints: 0 };

        const settings = () => {
            const tuning = mode.config.modes?.impression || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                flecks: clamp(tuning.flecks ?? 1, 0, 2),
                frame: tuning.frame !== false,
                timeOfDay: tuning.timeOfDay !== false,
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                grain: clamp(tuning.grain ?? 0.3, 0, 1),
                lamp: clamp(tuning.lamp ?? 1, 0, 1.5),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: global.MusicStageRuntime.isReducedMotion(reducedMotion)
            };
        };
        const applyScale = () => mode.root.style.setProperty('--impression-scale', String(settings().fontScale));
        applyScale();

        const readColours = () => {
            const p = services?.app?.stagePalette || {};
            const light = Boolean(p.light);
            const bg = hexRgb(p.background, light ? [0.94, 0.93, 0.9] : [0.08, 0.08, 0.09]);
            colours = {
                light,
                wall: light ? mixRgb(bg, [0.93, 0.91, 0.87], 0.5) : mixRgb(bg, [0.06, 0.055, 0.05], 0.6),
                ink: hexRgb(p.ink, light ? [0.12, 0.11, 0.1] : [0.95, 0.94, 0.9]),
                accent: hexRgb(p.accent, [0.9, 0.7, 0.4]),
                primed: light ? [0.95, 0.93, 0.88] : [0.86, 0.83, 0.76]
            };
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            const dpr = Math.min(RATIO[quality] || 1.5, global.devicePixelRatio || 1);
            const scale = Math.min(dpr, Math.sqrt((PIXELS[quality] || PIXELS.standard) / (w * h)));
            const bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale));
            if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; still.invalidate(); }
        };

        // 封面 → 油画：只在换封面时做一次
        const paintCover = (image) => {
            if (!glState || lostContext) return;
            const { gl, paint, cover, vao } = glState;
            // 已经有一幅了：换到另一张上画，旧的那张留作底
            if (painted) { glState.cur = 1 - glState.cur; glState.hasPrev = true; }
            const { tex: target, fbo } = glState.sheets[glState.cur];
            // 太大的图先缩到 1024 以内
            let source = image;
            let scratchCanvas = null;
            const longest = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height) || 1;
            if (longest > 1024) {
                const k = 1024 / longest;
                const c2 = global.document.createElement('canvas');
                c2.width = Math.max(1, Math.round((image.naturalWidth || image.width) * k));
                c2.height = Math.max(1, Math.round((image.naturalHeight || image.height) * k));
                c2.getContext('2d').drawImage(image, 0, 0, c2.width, c2.height);
                source = c2;
                scratchCanvas = c2;
            }
            const iw = source.naturalWidth || source.width, ih = source.naturalHeight || source.height;
            gl.bindTexture(gl.TEXTURE_2D, cover);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            if (scratchCanvas) { scratchCanvas.width = scratchCanvas.height = 0; scratchCanvas = null; }
            gl.generateMipmap(gl.TEXTURE_2D);
            const side = Math.min(iw, ih);
            const crop = [(iw - side) / 2 / iw, (ih - side) / 2 / ih, side / iw, side / ih];
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.viewport(0, 0, PAINT, PAINT);
            gl.useProgram(paint.program);
            gl.bindVertexArray(vao);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, cover);
            gl.uniform1i(paint.uniforms.uCover, 0);
            Utils.bindNoise(gl, paint.uniforms.uNoise, 1);
            gl.uniform4f(paint.uniforms.uCrop, ...crop);
            gl.uniform1f(paint.uniforms.uSize, PAINT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.bindTexture(gl.TEXTURE_2D, target);
            gl.generateMipmap(gl.TEXTURE_2D);
            painted = true;
            paintedAt = performance.now() / 1000;
            stats.paints += 1;
            still.invalidate();
        };

        const loadCover = (frame) => {
            const light = Boolean(services?.app?.stagePalette?.light);
            const url = fileUrl(frame.track?.albumArt) || `../assets/${light ? 'musiclight.jpeg' : 'musicdark.jpeg'}`;
            if (url === coverUrl) return;
            coverUrl = url;
            const image = new global.Image();
            image.decoding = 'async';
            image.onload = () => { if (coverUrl === url && !mode.destroyed) paintCover(image); };
            image.onerror = () => {
                if (coverUrl !== url || mode.destroyed) return;
                const fallback = `../assets/${light ? 'musiclight.jpeg' : 'musicdark.jpeg'}`;
                if (url !== fallback) { coverUrl = null; image.onerror = null; image.src = fallback; coverUrl = fallback; }
            };
            image.src = url;
        };

        /* 歌词轨：整首歌一列，当前句在中间，逐字从淡墨变实 */
        const buildRail = (frame, s) => {
            track.replaceChildren();
            railRows = [];
            currentRow = -1;
            const lines = frame.lines || [];
            lines.forEach((line, i) => {
                if (!readableText(line.fullText)) return;
                const row = createElement('div', 'impression-line');
                const text = createElement('div', 'impression-text', String(line.fullText).trim());
                row.append(text);
                const tr = s.showTranslation ? resolveSupplementalText(line) : '';
                if (tr) row.append(createElement('div', 'impression-tr', tr));
                if (sections.isChorus(line)) row.classList.add('is-chorus');
                track.append(row);
                railRows.push({ index: i, row, text, line });
            });
            railFor = { lines: frame.lines, translation: s.showTranslation };
        };
        const placeRail = (k, animate) => {
            const item = railRows[k];
            if (!item) return;
            const top = item.row.offsetTop + item.row.offsetHeight / 2;
            const centre = rail.clientHeight * 0.42;
            if (!animate) {
                track.style.transition = 'none';
                track.style.transform = `translateY(${(centre - top).toFixed(1)}px)`;
                void track.offsetHeight;
                track.style.transition = '';
            } else track.style.transform = `translateY(${(centre - top).toFixed(1)}px)`;
        };
        const updateRail = (frame, s) => {
            if (!railFor || railFor.lines !== frame.lines || railFor.translation !== s.showTranslation) buildRail(frame, s);
            const index = frame.currentLineIndex;
            let k = railRows.findIndex(r => r.index === index);
            if (k < 0) {
                // 间奏：停在下一句前面
                const t = frame.playbackTime || 0;
                k = railRows.findIndex(r => r.line.startTime > t) - 0.5;
                if (k < -0.5) k = railRows.length - 0.5;
            }
            if (k !== currentRow) {
                const jump = Math.abs(k - currentRow) > 2 || currentRow < 0;
                const prev = railRows[currentRow];
                if (prev) {
                    prev.row.classList.remove('is-current');
                    prev.row.classList.add('is-past');
                    prev.text.textContent = String(prev.line.fullText).trim();
                }
                // 离当前句越远越淡、越糊；还没唱的比唱过的亮一点
                railRows.forEach((r, i) => {
                    r.row.classList.toggle('is-past', i < k);
                    r.row.classList.toggle('is-near', Math.abs(i - k) <= 1.5 && i !== k);
                    r.row.style.setProperty('--d', String(Math.min(6, Math.max(1, Math.round(Math.abs(i - k))))));
                });
                currentRow = k;
                const item = railRows[k];
                glyphs = [];
                sung = -1;
                if (item) {
                    item.row.classList.add('is-current');
                    glyphs = buildGlyphTimeline(item.line);
                    item.text.replaceChildren(...glyphs.map(g => createElement('span', '', g.text)));
                    placeRail(k, !jump && frame.isPlaying && !s.reducedMotion);
                } else if (Number.isInteger(Math.floor(k))) {
                    const a = railRows[Math.floor(k)], b = railRows[Math.ceil(k)];
                    if (a || b) {
                        const ref = b || a;
                        const top = ref.row.offsetTop + (b ? -12 : ref.row.offsetHeight + 12);
                        track.style.transform = `translateY(${(rail.clientHeight * 0.42 - top).toFixed(1)}px)`;
                    }
                }
            }
            const item = railRows[currentRow];
            if (item && glyphs.length) {
                const t = frame.playbackTime || 0;
                let n = 0;
                while (n < glyphs.length && glyphs[n].startTime <= t) n += 1;
                const spans = item.text.children;
                if (n !== sung) {
                    for (let i = 0; i < spans.length; i += 1) spans[i].classList.toggle('is-sung', i < n);
                    sung = n;
                }
                // 刚唱到的字亮一下，唱完一会儿再慢慢退回去（亮起快、退下慢）
                const glow = frame.isPlaying && !s.reducedMotion;
                for (let i = 0; i < n && i < spans.length; i += 1) {
                    const on = glow && t < glyphs[i].endTime + 0.9;
                    if (spans[i].classList.contains('is-glow') !== on) spans[i].classList.toggle('is-glow', on);
                }
            }
        };

        const updateLabel = (frame, phase) => {
            const title = String(frame.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg|aac|ape|opus)$/i, '').trim() || '无题';
            const artist = String(frame.track?.artist || '').trim() || '佚名';
            const key = `${title}|${artist}|${phase}`;
            if (key !== labelKey) {
                labelKey = key;
                labelTitle.textContent = `《${title}》`;
                labelArtist.textContent = artist;
                labelMedium.textContent = `布面油画 · ${phase}`;
            }
            const cap = `印象 · ${Utils.lineCounter(frame)}`;
            if (cap !== caption) { caption = cap; kicker.textContent = cap; }
        };

        const stepState = (frame, dt, s) => {
            const audio = frame.audio || {};
            const playing = frame.isPlaying && !s.reducedMotion;
            const power = clamp((audio.power || 0) * s.audioReactivity, 0, 1);
            energy += (power - energy) * (1 - Math.exp(-dt * 4));
            const hi = clamp((audio.treble || 0) * 1.4 * s.audioReactivity, 0, 1);
            treble += (hi - treble) * (1 - Math.exp(-dt * (hi > treble ? 14 : 3)));
            const onset = Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets;
            if (Number.isFinite(audio.onsets)) lastOnsets = audio.onsets;
            if (playing && onset && ripple.age > 0.45) ripple = { age: 0, str: 0.55 + 0.45 * clamp((audio.bass || 0) * 1.5, 0, 1) };
            if (frame.isPlaying) ripple.age = Math.min(1, ripple.age + dt / 1.4);
            const spectrum = audio.spectrum || [];
            for (let i = 0; i < BANDS; i += 1) {
                const raw = spectrum.length ? clamp(Number(spectrum[Math.min(spectrum.length - 1, Math.floor(Math.pow(i / BANDS, 1.6) * spectrum.length * 0.85))]) || 0, 0, 1) : 0;
                const v = clamp(raw * (0.7 + 0.5 * s.audioReactivity), 0, 1);
                if (frame.isPlaying) bands[i] += (v - bands[i]) * (1 - Math.exp(-dt * (v > bands[i] ? 18 : 4)));
            }
            // 时辰：每段换一个，光慢慢转过去（约 3 秒）
            if (frame.lines !== sectionsFor) { sectionsFor = frame.lines; sections = buildSections(frame.lines); railFor = null; }
            const idx = s.timeOfDay ? sectionAt(sections.starts, frame.playbackTime || 0) % PHASES.length : 1;
            const target = PHASES[idx];
            // 暂停时拖进度：直接到位；播放中：慢慢转过去
            const k = phaseIndex < 0 || s.reducedMotion || !frame.isPlaying ? 1 : 1 - Math.exp(-dt * 0.9);
            phaseIndex = idx;
            for (let i = 0; i < 3; i += 1) {
                grade.lift[i] += (target.lift[i] - grade.lift[i]) * k;
                grade.gain[i] += (target.gain[i] - grade.gain[i]) * k;
                grade.fleck[i] += (target.fleck[i] - grade.fleck[i]) * k;
            }
            grade.sat += (target.sat - grade.sat) * k;
            grade.bright += (target.bright - grade.bright) * k;
            grade.night += (target.night - grade.night) * k;
            return target.name;
        };

        const draw = (frame, s) => {
            const { gl, main, vao } = glState;
            const tex = glState.sheets[glState.cur].tex;
            const prevTex = glState.sheets[1 - glState.cur].tex;
            const t = frame.playbackTime || 0;
            const W = canvas.width, H = canvas.height;
            let size = Math.min(H * 0.6, W * 0.4);
            let fw = Math.max(10, size * 0.075);
            let x0 = W * 0.33 - size / 2;
            const y0 = H * 0.5 - size / 2 + H * 0.02;
            // 窄窗口：画让开左上角的档案卡，也不压到右边的歌词
            const box = card.box;
            if (box && (box.bottom + 1) / 2 * H < y0 + size + fw * 2 + size * 0.2) {
                const minX = (box.right + 1) / 2 * W + fw + W * 0.025;
                if (x0 < minX) {
                    x0 = minX;
                    const room = W * 0.56 - x0 - fw;
                    if (size > room) { size = Math.max(H * 0.25, room); fw = Math.max(10, size * 0.075); }
                }
            }
            const reveal = s.reducedMotion ? 1.2 : clamp((performance.now() / 1000 - paintedAt) / REVEAL_SECONDS, 0, 1.2) * 1.1;
            gl.viewport(0, 0, W, H);
            gl.useProgram(main.program);
            gl.bindVertexArray(vao);
            const u = main.uniforms;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(u.uPaint, 0);
            Utils.bindNoise(gl, u.uNoise, 1);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, prevTex);
            gl.uniform1i(u.uPrev, 2);
            gl.uniform1f(u.uHasPrev, glState.hasPrev ? 1 : 0);
            const lampOn = s.lamp * (0.75 + 0.5 * grade.night) * (1 + 0.12 * (s.reducedMotion ? 0 : energy));
            gl.uniform4f(u.uLamp, x0 + size / 2, y0 + size + fw + size * 0.085, size * 0.21, s.frame ? lampOn : 0);
            gl.uniform1f(u.uTreble, s.reducedMotion ? 0 : treble);
            gl.uniform2f(u.uRes, W, H);
            gl.uniform3fv(u.uWall, colours.wall);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform3fv(u.uPrimed, colours.primed);
            gl.uniform1f(u.uLight, colours.light ? 1 : 0);
            gl.uniform4f(u.uRect, x0, y0, size, fw);
            gl.uniform1f(u.uReveal, painted ? reveal : 0);
            gl.uniform1f(u.uTime, s.reducedMotion ? 0 : t);
            gl.uniform1f(u.uEnergy, s.reducedMotion ? 0 : energy);
            gl.uniform2f(u.uRipple, ripple.age, s.reducedMotion || ripple.age >= 1 ? 0 : ripple.str);
            gl.uniform3fv(u.uLift, grade.lift);
            gl.uniform3fv(u.uGain, grade.gain);
            gl.uniform1f(u.uSat, grade.sat);
            gl.uniform1f(u.uBright, grade.bright);
            gl.uniform3fv(u.uFleck, grade.fleck);
            gl.uniform1f(u.uNight, grade.night);
            gl.uniform1f(u.uFlecks, s.reducedMotion ? 0 : s.flecks);
            gl.uniform1f(u.uFrame, s.frame ? 1 : 0);
            gl.uniform1fv(u.uBands, bands);
            gl.uniform4f(u.uCurve, y0 - fw - H * 0.075, x0 - fw, x0 + size + fw, H * 0.05);
            gl.uniform1f(u.uGrain, s.grain);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            stats.draws += 1;
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latest = frame;
            if (!colours) readColours();
            const s = settings();
            const aim = 1000 / (FPS[mode.config.quality || 'standard'] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            const revealing = painted && !s.reducedMotion && performance.now() / 1000 - paintedAt < REVEAL_SECONDS * 1.25;
            if ((frame.isPlaying || revealing) && now - lastDraw < aim - 3) return;
            loadCover(frame);
            const wall = now / 1000;
            const dt = lastT === null ? 0 : clamp(wall - lastT, 0, 0.1);
            lastT = frame.isPlaying ? wall : null;
            const phase = stepState(frame, dt, s);
            updateRail(frame, s);
            updateLabel(frame, phase);
            if (!glState || lostContext) return;
            if (!revealing && !frame.isPlaying && still.same(frame, `${canvas.width}x${canvas.height}|${stats.paints}|${phase}`)) return;
            if (frame.isPlaying || revealing) still.invalidate();
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            draw(frame, s);
        };

        const redraw = () => { still.invalidate(); lastDraw = -Infinity; if (latest) mode.updateFrame(latest); };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); applyScale(); railFor = null; resize(); redraw(); };
        mode.resize = () => { card.measure(); resize(); if (railRows[currentRow]) placeRail(currentRow, false); redraw(); };
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; lastT = null; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { readColours(); coverUrl = null; redraw(); };
        mode.getDebugSnapshot = () => ({ initialized: Boolean(glState), draws: stats.draws, paints: stats.paints, buffer: `${canvas.width}x${canvas.height}` });

        const onLost = (event) => { event.preventDefault(); lostContext = true; };
        const onRestored = () => {
            try { glState = createGl(canvas); lostContext = false; coverUrl = null; painted = false; redraw(); } catch (error) { console.error(error); }
        };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            if (glState) {
                const { gl } = glState;
                gl.deleteProgram(glState.paint.program);
                gl.deleteProgram(glState.main.program);
                gl.deleteTexture(glState.cover);
                glState.sheets.forEach(({ tex, fbo }) => { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); });
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
            glState = null;
        });

        resize();
        return mode;
    };

    global.MusicStageImpressionManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ buildSections, sectionAt, PHASES, fileUrl })
    });
})(window);
