(function (global) {
    'use strict';

    /*
     * 信号：一只横躺的 ∞ 形管环，管身是分节的陶瓷套管，节与节之间箍着铜环，两个圈的外侧开窗露出铜线圈；
     * 管顶嵌一道发光的槽，低音一来就有一团光沿着槽跑一圈。环下面是 48 段对称的频谱条（低频在中间），
     * 再往下是正在唱的那句和它的翻译（或者换成最近一分钟的电平历史）。整页像一台信号监视器。
     *
     * 画法：一个全屏三角形。∞ 由两段直管（在中间交叉，「\」那根在上面）和两段 270° 多的圆弧组成，
     * 每个像素按解析式求到各段的距离、沿管的位置和偏向哪一侧，再按圆管的法线打光；光团、频谱、
     * 电平历史都是 uniform。暂停时不画。
     */
    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before signal-manager.js');
    const { clamp, createElement } = Utils;
    const { resolveSupplementalText, readableText } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    const BANDS = 48;
    const HIST = 120;          // 电平历史：一分钟，每半秒一格
    const MAX_PULSES = 8;

    // ∞ 的中线：两个半径 1 的圆，圆心在 ±D，由过原点的两条公切线连起来
    const D = 1.42, R = 1, TR = 0.35;
    const PHI = Math.asin(R / D);
    const HALF = D * Math.cos(PHI);              // 原点到切点
    const ARC = R * (Math.PI + 2 * PHI);         // 每个圈走过的弧长
    const LOOP = 4 * HALF + 2 * ARC;             // 一整圈的长度
    const WIDTH = 2 * (D + R) + 2 * TR;          // 外缘总宽
    const HEIGHT = 2 * (R + TR);

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

    // 环所在平面绕 x、y 轴各转一点，从屏幕坐标反查平面坐标的 3×3 矩阵（按列给 GL）
    const CAMERA = 6;
    const planeMatrix = (ax, ay, out) => {
        const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
        // R = Ry · Rx
        const a0 = CAMERA * cy, a1 = CAMERA * sy * sx;
        const a4 = CAMERA * cx;
        const a6 = -sy, a7 = cy * sx, a8 = CAMERA;
        const invDet = 1 / (a0 * a4 * a8);
        // 行主序 inv → 列主序（a2 = a3 = a5 = 0）
        out[0] = (a4 * a8) * invDet;
        out[1] = 0;
        out[2] = (-a4 * a6) * invDet;
        out[3] = (-a1 * a8) * invDet;
        out[4] = (a0 * a8) * invDet;
        out[5] = (a1 * a6 - a0 * a7) * invDet;
        out[6] = 0;
        out[7] = 0;
        out[8] = (a0 * a4) * invDet;
        return out;
    };
    const applyPlane = (m, x, y) => {
        const hx = m[0] * x + m[3] * y + m[6], hy = m[1] * x + m[4] * y + m[7], hz = m[2] * x + m[5] * y + m[8];
        return [hx / hz, hy / hz];
    };

    // 副歌：整句歌词在歌里出现两次以上
    const normLine = line => String(line?.fullText || '').replace(/[\s，。、,.!?！？…~～'"“”‘’()（）-]/g, '').toLowerCase();
    const chorusSet = (lines) => {
        const counts = new Map();
        (lines || []).forEach((line) => { const k = normLine(line); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
        return new Set([...counts].filter(([, n]) => n >= 2).map(([k]) => k));
    };

    /* ───────────────────────── 中线 ───────────────────────── */

    // 沿中线走 u（0..LOOP）到达的点：原点 →「/」右上 → 右圈顺时针 →「\」穿过原点到左上 → 左圈逆时针 →「/」回原点
    const pointAt = (u) => {
        let s = ((u % LOOP) + LOOP) % LOOP;
        const c = Math.cos(PHI), n = Math.sin(PHI);
        if (s < HALF) return [s * c, s * n];
        s -= HALF;
        if (s < ARC) { const a = Math.PI / 2 + PHI - s / R; return [D + R * Math.cos(a), R * Math.sin(a)]; }
        s -= ARC;
        if (s < 2 * HALF) { const k = s - HALF; return [HALF * c - (k + HALF) * c, -HALF * n + (k + HALF) * n]; }
        s -= 2 * HALF;
        if (s < ARC) { const a = Math.PI / 2 - PHI + s / R; return [-D + R * Math.cos(a), R * Math.sin(a)]; }
        s -= ARC;
        return [-HALF * c + s * c, -HALF * n + s * n];
    };

    // 频谱：48 段，按对数取样（低频段占得少一点）
    const bandIndex = (i, length) => Math.min(length - 1, Math.floor(Math.pow(i / BANDS, 1.7) * length * 0.9));

    /* ───────────────────────── GL ───────────────────────── */

    const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uCentre;     // 环心（像素，y 朝上）
uniform float uK;         // 每单位多少像素
uniform float uTime;
uniform float uEnergy;
uniform float uLight;
uniform vec3 uField;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec3 uBody;
uniform vec4 uPulse[${MAX_PULSES}];   // 头的位置、长度（都按 LOOP 计）、亮度
uniform int uPulseCount;
uniform float uBands[${BANDS}];
uniform vec4 uStrip;      // 中线 y、半宽、最大高度、开关（像素）
uniform float uHist[${HIST}];
uniform vec4 uHistBox;    // 中线 y、半宽、半高、开关
uniform vec4 uBox;        // 括号框：左、下、右、上（像素）
uniform float uGrain;
uniform mat3 uPlane;      // 屏幕 → 环所在平面（环轻轻侧倾时的透视）
uniform vec3 uLightP;     // 平面坐标里的光向
uniform float uKick;      // 鼓点闪一下，很快衰减
uniform float uCharge;    // 副歌时整只环充能
uniform vec3 uRipple;     // 从交叉点外扩的波纹：年龄、强度、副歌加宽
uniform float uPeaks[${BANDS}];
uniform float uGrainStep;
out vec4 outColor;

const float PI = 3.14159265;
const float TAU = 6.2831853;
const float D = ${D.toFixed(4)};
const float R = ${R.toFixed(4)};
const float TR = ${TR.toFixed(4)};
const float PHI = ${PHI.toFixed(6)};
const float HALF = ${HALF.toFixed(6)};
const float ARC = ${ARC.toFixed(6)};
const float LOOP = ${LOOP.toFixed(6)};

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// 到一段的距离、沿管的位置、偏向（带符号）、偏向那一侧的方向
struct Hit { float d; float u; float side; vec2 n; float arc; };

Hit seg(vec2 p, vec2 a, vec2 b, float u0) {
    vec2 ab = b - a;
    float len = length(ab);
    float t = clamp(dot(p - a, ab) / (len * len), 0.0, 1.0);
    vec2 c = a + ab * t;
    vec2 n = vec2(-ab.y, ab.x) / len;
    float side = dot(p - c, n);
    // 直段的 arc 记成 -(1 + 段内位置)，好在着色时知道离交叉点多远
    return Hit(length(p - c), mod(u0 + t * len, LOOP), side, n, -1.0 - t * len);
}

Hit arc(vec2 p, vec2 c, float a0, float dir, float u0) {
    vec2 v = p - c;
    float ang = atan(v.y, v.x);
    float rel = dir > 0.0 ? mod(ang - a0, TAU) : mod(a0 - ang, TAU);
    float span = PI + 2.0 * PHI;
    float r = length(v);
    if (rel > span) return Hit(1e3, 0.0, 0.0, vec2(0.0, 1.0), -1.0);
    return Hit(abs(r - R), u0 + rel * R, r - R, v / max(r, 1e-4), rel / span);
}

Hit nearest(Hit a, Hit b) { if (a.d < b.d) return a; return b; }

// 光团：沿槽从头往后渐暗
float pulseAt(float u) {
    float e = 0.0;
    for (int i = 0; i < ${MAX_PULSES}; i++) {
        if (i >= uPulseCount) break;
        vec4 p = uPulse[i];
        float behind = mod(p.x * LOOP - u, LOOP);
        float len = p.y * LOOP;
        if (behind < len) e += p.z * pow(1.0 - behind / len, 1.4);
        float ahead = mod(u - p.x * LOOP, LOOP);
        e += p.z * exp(-ahead * ahead * 400.0) * 0.6;
    }
    return e;
}

// 管上箍铜套的位置：线圈窗两头，直段在交叉点两边各一道
const float W0 = 0.13, W1 = 0.4, W2 = 0.6, W3 = 0.87;
float collarAt(Hit h) {
    float w = 0.022;
    float d;
    if (h.arc >= 0.0) {
        float a = h.arc * ARC;
        d = min(min(abs(a - W0 * ARC), abs(a - W1 * ARC)), min(abs(a - W2 * ARC), abs(a - W3 * ARC)));
    } else {
        float pos = -h.arc - 1.0;
        d = min(abs(abs(pos - HALF) - 0.62), abs(pos - 0.05));
    }
    return smoothstep(w + 0.006, w - 0.006, d);
}
float windowAt(Hit h) {
    if (h.arc < 0.0) return 0.0;
    float a = h.arc;
    float e = 0.022 / ARC;
    return smoothstep(W0 + e, W0 + e + 0.004, a) * smoothstep(W1 - e, W1 - e - 0.004, a)
         + smoothstep(W2 + e, W2 + e + 0.004, a) * smoothstep(W3 - e, W3 - e - 0.004, a);
}

vec3 shadeTube(Hit h, float energy) {
    float collar = collarAt(h);
    float rad = TR + 0.02 * collar;
    float s = clamp(h.side / rad, -1.0, 1.0);
    vec3 n = normalize(vec3(h.n * s, sqrt(max(0.0, 1.0 - s * s))));
    vec3 L = uLightP;
    float ndl = dot(n, L);
    float diff = max(ndl, 0.0);
    float wrap = max((ndl + 0.35) / 1.35, 0.0);
    vec3 Hv = normalize(L + vec3(0.0, 0.0, 1.0));
    float ndh = max(dot(n, Hv), 0.0);
    float spec = pow(ndh, 18.0);
    float sheen = pow(ndh, 4.0);
    float rim = pow(1.0 - n.z, 2.5);
    vec3 copper = vec3(0.78, 0.46, 0.26);
    float e = pulseAt(h.u);
    vec3 glowHue = mix(uAccent, vec3(1.0, 0.52, 0.2), 0.55);
    float boost = 1.0 + 0.9 * uKick + 0.45 * uCharge;

    // 陶瓷管身：哑光，柔一点的高光，边上一圈暗
    vec3 col = uBody * (0.22 + 0.95 * wrap) + vec3(1.0, 0.97, 0.94) * (spec * mix(0.16, 0.3, uLight) + sheen * 0.05);
    col *= 1.0 - rim * mix(0.55, 0.25, uLight);

    // 线圈窗：一节玻璃套，里面一根密绕的铜弹簧，中间穿着发光的芯
    float win = windowAt(h);
    if (win > 0.0) {
        vec3 glass = uField * mix(0.55, 0.9, uLight) + uBody * 0.08;
        float along = h.u * 34.0;
        float sr = 0.56;
        float inSpring = smoothstep(sr + 0.04, sr - 0.02, abs(s));
        float depth = sqrt(max(0.0, 1.0 - (s / sr) * (s / sr)));
        float frontW = smoothstep(0.3, 0.1, abs(fract(along + 0.22 * s / sr) - 0.5));
        float backW = smoothstep(0.3, 0.12, abs(fract(along - 0.22 * s / sr) - 0.5));
        vec3 wire = copper * (0.28 + 0.9 * depth * (0.5 + 0.5 * diff)) + vec3(1.0, 0.82, 0.62) * pow(depth, 6.0) * 0.55;
        vec3 inside = glass;
        float core = smoothstep(0.16, 0.05, abs(s));
        inside = mix(inside, glowHue * ((0.45 + 0.3 * energy) * boost + 1.4 * e), core * 0.9);
        inside = mix(inside, wire * 0.32, backW * inSpring);
        inside = mix(inside, wire, frontW * inSpring);
        // 玻璃：边缘的反光和一道斜着的高光
        inside += vec3(1.0) * (pow(abs(s), 6.0) * 0.3 + smoothstep(0.06, 0.0, abs(s + 0.78)) * 0.12 + smoothstep(0.05, 0.0, abs(s - 0.8)) * 0.05);
        col = mix(col, inside, win);
    }

    // 发光槽：管顶一道凹槽，槽唇压暗
    float groove = smoothstep(0.17, 0.12, abs(s)) * (1.0 - win);
    float lip = (smoothstep(0.24, 0.17, abs(s)) - smoothstep(0.17, 0.12, abs(s))) * (1.0 - win);
    float coreG = smoothstep(0.1, 0.0, abs(s));
    vec3 glowC = glowHue * ((0.42 + 0.3 * energy) * boost + 1.5 * e) + vec3(1.0, 0.92, 0.8) * clamp(e - 0.35, 0.0, 1.0) * coreG;
    col *= 1.0 - lip * 0.5;
    col = mix(col, mix(glowHue * 0.25, glowC, 0.35 + 0.65 * coreG), groove);

    // 铜套：比管身略粗，两边各一道暗缝
    vec3 brass = copper * (0.1 + 0.62 * wrap) + vec3(1.0, 0.86, 0.7) * pow(ndh, 40.0) * 0.75;
    brass *= 1.0 - rim * 0.5;
    brass += vec3(1.0, 0.78, 0.55) * uKick * 0.22 * (1.0 - rim);
    col = mix(col, brass, collar);
    // 铜套两边的细缝
    float edge = collar * (1.0 - collar) * 4.0;
    col *= 1.0 - edge * 0.55;
    return col;
}

void main() {
    vec2 frag = gl_FragCoord.xy;
    float breath = 1.0 + 0.006 * uEnergy;
    vec2 q = (frag - uCentre) / (uK * breath);
    vec3 hp = uPlane * vec3(q, 1.0);
    vec2 p = hp.xy / hp.z;
    float aa = 1.2 / (uK * hp.z);

    vec3 col = uField;
    // 底：中间略亮，四角压暗，细网格
    vec2 uv = frag / uRes;
    col *= 1.0 + mix(0.12, 0.04, uLight) * exp(-dot(q, q) * 0.12);
    vec2 g = abs(fract(frag / (uK * 0.5)) - 0.5);
    col = mix(col, uInk, (1.0 - smoothstep(0.0, 1.0 / (uK * 0.5), min(g.x, g.y))) * mix(0.018, 0.03, uLight));

    const float C_PHI = ${Math.cos(PHI).toFixed(7)}, S_PHI = ${Math.sin(PHI).toFixed(7)};
    vec2 t2up = vec2(HALF * C_PHI, HALF * S_PHI), t2dn = vec2(HALF * C_PHI, -HALF * S_PHI);
    vec2 t1up = vec2(-HALF * C_PHI, HALF * S_PHI), t1dn = vec2(-HALF * C_PHI, -HALF * S_PHI);

    // 波纹：换句和鼓点时从交叉点往外扩一圈细线（环后面）
    if (uRipple.y > 0.0) {
        float rr = uRipple.x * (3.4 + 1.2 * uRipple.z);
        float dr = abs(length(p * vec2(0.62, 1.0)) - rr);
        float wv = 0.012 + 0.02 * uRipple.z;
        col += mix(uAccent, vec3(1.0, 0.55, 0.22), 0.5) * exp(-dr * dr / (wv * wv)) * uRipple.y * (1.0 - smoothstep(0.4, 1.0, uRipple.x)) * mix(0.35, 0.2, uLight);
    }
    // 环外面的像素（大半个画面）不用算管子
    if (abs(p.x) < D + R + TR + 0.45 && abs(p.y) < R + TR + 0.6) {
    Hit back = nearest(nearest(seg(p, t1dn, t2up, 3.0 * HALF + 2.0 * ARC), arc(p, vec2(D, 0.0), PI / 2.0 + PHI, -1.0, HALF)), arc(p, vec2(-D, 0.0), PI / 2.0 - PHI, 1.0, 3.0 * HALF + ARC));
    Hit front = seg(p, t2dn, t1up, HALF + ARC);
    float crossing = smoothstep(1.0, 0.6, length(p));
    float dmin = min(back.d, front.d);
    // 影子和光晕只落在管子外面，管身盖住的像素不用算
    if (dmin > TR - 2.0 * aa) {
        // 影子：整只环往右下偏一点、软一点
        vec2 qs = p - vec2(0.08, -0.22);
        Hit sb = nearest(nearest(seg(qs, t1dn, t2up, 3.0 * HALF + 2.0 * ARC), arc(qs, vec2(D, 0.0), PI / 2.0 + PHI, -1.0, HALF)), arc(qs, vec2(-D, 0.0), PI / 2.0 - PHI, 1.0, 3.0 * HALF + ARC));
        Hit sf = seg(qs, t2dn, t1up, HALF + ARC);
        float sd = min(sb.d, sf.d);
        col *= 1.0 - smoothstep(TR + 0.28, TR - 0.1, sd) * mix(0.55, 0.16, uLight);
        // 远处的光晕：光团把附近照亮一点
        if (dmin < TR + 0.45) {
            Hit h = nearest(back, front);
            float halo = exp(-max(h.d - TR, 0.0) / 0.09) * step(TR, h.d);
            col += uAccent * pulseAt(h.u) * halo * mix(0.22, 0.12, uLight);
        }
    }
    bool frontCovers = front.d < TR - aa && (front.d < back.d || crossing > 0.0);
    float rb = TR + 0.02 * collarAt(back);
    if (back.d < rb + aa && !frontCovers) col = mix(col, shadeTube(back, uEnergy), smoothstep(rb + aa, rb - aa, back.d));
    // 上面那根在交叉处压着下面那根：先描一圈缝，再画它
    float gap = 0.07;
    if (front.d < TR + gap && (front.d < back.d || crossing > 0.0)) {
        float ring = smoothstep(TR + gap + aa, TR + gap - aa, front.d) * crossing;
        col = mix(col, uField * mix(0.4, 0.8, uLight), ring * step(back.d, TR + aa));
        float rf = TR + 0.02 * collarAt(front);
        if (front.d < rf + aa) col = mix(col, shadeTube(front, uEnergy), smoothstep(rf + aa, rf - aa, front.d));
    }
    }

    // 频谱条：48 段对称，低频在中间
    if (uStrip.w > 0.5) {
        float dx = abs(frag.x - uCentre.x);
        float dy = abs(frag.y - uStrip.x);
        if (dx < uStrip.y && dy < uStrip.z + 5.0) {
            float cell = dx / uStrip.y * float(${BANDS});
            int b = int(cell);
            float v = uBands[b];
            float h = max(v * uStrip.z, 1.0);
            float bar = step(fract(cell), 0.56) * step(dy, h);
            float pk = uPeaks[b] * uStrip.z + 3.0;
            float cap = step(fract(cell), 0.56) * step(abs(dy - pk), 0.75) * step(0.04, uPeaks[b]) * step(v + 0.03, uPeaks[b]);
            vec3 bc = mix(uInk * 0.42, mix(uAccent, vec3(1.0, 0.52, 0.2), 0.55), step(0.62, v));
            col = mix(col, bc, bar * mix(0.8, 0.5, uLight));
            col = mix(col, mix(uAccent, vec3(1.0, 0.55, 0.22), 0.5), cap * 0.75);
            col = mix(col, uInk, (1.0 - smoothstep(0.0, 1.0, dy)) * 0.18 * step(0.56, fract(cell)));
        }
    }

    // 电平历史：最近一分钟，新的在右边
    if (uHistBox.w > 0.5) {
        float dx = frag.x - (uCentre.x - uHistBox.y);
        float dy = abs(frag.y - uHistBox.x);
        if (dx >= 0.0 && dx < uHistBox.y * 2.0 && dy < uHistBox.z + 2.0) {
            float cell = dx / (uHistBox.y * 2.0) * float(${HIST});
            int b = int(cell);
            float v = uHist[b];
            float h = v < 0.0 ? 1.0 : max(v * uHistBox.z, 1.0);
            float bar = step(fract(cell), 0.5) * step(dy, h);
            vec3 bc = v < 0.0 ? uInk * 0.2 : mix(uInk * 0.7, uAccent, step(0.82, v));
            col = mix(col, bc, bar * 0.85);
        }
    }

    // 括号框和四角的十字
    {
        float L = 16.0, w = 1.0;
        vec2 lo = uBox.xy, hi = uBox.zw;
        float br = 0.0;
        for (int i = 0; i < 4; i++) {
            vec2 cpt = vec2(i == 0 || i == 3 ? lo.x : hi.x, i < 2 ? lo.y : hi.y);
            vec2 dir = vec2(i == 0 || i == 3 ? 1.0 : -1.0, i < 2 ? 1.0 : -1.0);
            vec2 d = (frag - cpt) * dir;
            br = max(br, step(0.0, d.x) * step(d.x, L) * step(abs(d.y), w * 0.5 + 0.5));
            br = max(br, step(0.0, d.y) * step(d.y, L) * step(abs(d.x), w * 0.5 + 0.5));
        }
        col = mix(col, mix(uInk, mix(uAccent, vec3(1.0, 0.55, 0.22), 0.5), uCharge), br * (0.35 + 0.35 * uCharge + 0.3 * uKick));
        vec2 m = vec2(max(28.0, uRes.x * 0.03), max(28.0, uRes.y * 0.04));
        vec2 cr = abs(vec2(frag.x < uRes.x * 0.5 ? frag.x - m.x : frag.x - (uRes.x - m.x), frag.y < uRes.y * 0.5 ? frag.y - m.y : frag.y - (uRes.y - m.y)));
        float cross = (step(cr.x, 0.6) * step(cr.y, 6.0) + step(cr.y, 0.6) * step(cr.x, 6.0));
        col = mix(col, uInk, clamp(cross, 0.0, 1.0) * 0.25);
    }

    vec2 v = uv - 0.5;
    col *= 1.0 - dot(v, v) * mix(0.5, 0.18, uLight);
    if (uGrain > 0.0) col += (hash12(floor(frag / 1.5) + uGrainStep * 11.0) - 0.5) * 0.03 * uGrain;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default'
        });
        if (!gl) return null;
        const { program, uniforms } = Utils.compileProgram(gl, VERT, FRAG, 'signal');
        return { gl, program, uniforms, vao: gl.createVertexArray() };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('signal', '信号', container, services);
        const canvas = createElement('canvas', 'signal-canvas');
        const kicker = createElement('div', 'signal-kicker', '信号');
        const label = createElement('div', 'signal-label');
        label.innerHTML = '<i></i><span>信号监视</span><b>实时</b>';
        const lyric = createElement('div', 'signal-lyric');
        const line = createElement('div', 'signal-line');
        // 两个槽轮流用：新句从下面滑进来，旧句往上退
        const slots = [createElement('span', 'signal-slot'), createElement('span', 'signal-slot')];
        line.append(...slots);
        let slot = 0;
        const badge = () => label.querySelector('b');
        const rule = createElement('div', 'signal-rule');
        const ruleFill = createElement('i', 'signal-rule-fill');
        rule.append(ruleFill);
        const translation = createElement('div', 'stage-translation signal-translation');
        lyric.append(line, rule, translation);
        const notice = createElement('div', 'signal-notice');
        notice.hidden = true;
        mode.root.append(canvas, label, kicker, lyric, notice);

        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，信号画不出来，请换一个舞台';
        }
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const bands = new Float32Array(BANDS);
        const hist = new Float32Array(HIST).fill(-1);
        const pulseBuf = new Float32Array(MAX_PULSES * 4);
        let pulses = [];
        let cool = 0;
        let energy = 0;
        let lastOnsets = -1;
        let lastT = null;
        let histAt = 0;
        let histTrack = '';
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let colours = null;
        let caption = '';
        let lastLine = '';
        let lastTranslation = '';
        let lastRule = '';
        let lostContext = false;
        let kick = 0;
        let charge = 0;
        let inter = 0;
        let ripple = { age: 1, str: 0, wide: 0 };
        let lastLineKey = null;
        let chorusFor = null;
        let chorus = new Set();
        const peaks = new Float32Array(BANDS);
        const peakVel = new Float32Array(BANDS);
        const plane = new Float32Array(9);
        const stats = { draws: 0, pulses: 0 };

        const settings = () => {
            const tuning = mode.config.modes?.signal || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                panel: ['lyrics', 'history', 'off'].includes(tuning.panel) ? tuning.panel : 'lyrics',
                showSpectrum: tuning.showSpectrum !== false,
                pulseRate: clamp(tuning.pulseRate ?? 1, 0, 2),
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                grain: clamp(tuning.grain ?? 0.3, 0, 1),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: global.MusicStageRuntime.isReducedMotion(reducedMotion),
                quality: mode.config.quality || 'standard'
            };
        };

        const readColours = () => {
            const p = services?.app?.stagePalette || {};
            const light = Boolean(p.light);
            const bg = hexRgb(p.background, light ? [0.95, 0.94, 0.9] : [0.09, 0.1, 0.11]);
            colours = {
                light,
                field: light ? mixRgb(bg, [0.93, 0.92, 0.89], 0.4) : mixRgb(bg, [0.045, 0.045, 0.05], 0.7),
                ink: hexRgb(p.ink, light ? [0.1, 0.11, 0.12] : [0.95, 0.94, 0.9]),
                accent: hexRgb(p.accent, [0.95, 0.5, 0.12]),
                // 管身：深色主题是哑光深灰陶瓷，浅色主题是米白陶瓷
                body: light ? [0.8, 0.78, 0.75] : [0.3, 0.28, 0.27]
            };
            mode.root.style.setProperty('--signal-field', `rgb(${colours.field.map(v => Math.round(v * 255)).join(',')})`);
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

        // 光团：低音来时放一团（至少保持两团在跑），越响跑得越快；暂停时不动
        const stepPulses = (frame, dt, s) => {
            const audio = frame.audio || {};
            const playing = frame.isPlaying && !s.reducedMotion;
            const power = clamp((audio.power || 0) * s.audioReactivity, 0, 1);
            energy += (power - energy) * (1 - Math.exp(-dt * 4));
            cool -= dt;
            const onset = Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets;
            if (Number.isFinite(audio.onsets)) lastOnsets = audio.onsets;
            if (playing && onset) {
                kick = Math.max(kick, 0.5 + 0.5 * clamp((audio.bass || 0) * 1.6, 0, 1));
                if (ripple.age > 0.55) ripple = { age: 0, str: 0.45, wide: 0 };
            }
            kick *= Math.exp(-dt * 7);
            // 换句：从交叉点放两团快的光，波纹扩一圈
            const active = frame.activeLine;
            const key = active ? `${active.startTime}|${active.fullText}` : null;
            if (key !== lastLineKey) {
                if (key && lastLineKey !== null && playing && s.pulseRate > 0) {
                    pulses.push({ p: 0, v: 0.16, len: 0.07, a: 1.1, fast: true });
                    pulses.push({ p: 0.5, v: 0.16, len: 0.07, a: 1.1, fast: true });
                    ripple = { age: 0, str: 1, wide: chorus.has(normLine(active)) ? 1 : 0 };
                }
                lastLineKey = key;
            }
            if (frame.isPlaying) ripple.age = Math.min(1, ripple.age + dt / 1.6);
            if (frame.lines !== chorusFor) { chorusFor = frame.lines; chorus = chorusSet(frame.lines); }
            const inChorus = active && chorus.has(normLine(active)) ? 1 : 0;
            charge += (inChorus - charge) * (1 - Math.exp(-dt * 2.5));
            inter += ((active ? 0 : 1) - inter) * (1 - Math.exp(-dt * 0.8));
            if (playing && s.pulseRate > 0 && ((onset && cool <= 0) || pulses.length < 2)) {
                pulses.push({ p: Math.random(), v: (0.035 + 0.05 * Math.random()) * s.pulseRate, len: 0.05 + 0.05 * energy, a: 0.6 + 0.5 * clamp((audio.bass || 0) * 1.5, 0, 1) });
                cool = 0.38 / Math.max(0.3, s.pulseRate);
            }
            for (let i = 0; i < pulses.length; i += 1) {
                if (!playing) break;
                const p = pulses[i];
                p.p = (p.p + p.v * dt * (1 + 2.2 * energy)) % 1;
                p.a *= Math.pow(p.fast ? 0.35 : 0.86, dt);
            }
            let write = 0;
            for (let i = 0; i < pulses.length; i += 1) {
                if (pulses[i].a > 0.08) pulses[write++] = pulses[i];
            }
            pulses.length = write;
            if (pulses.length > 7) pulses.splice(0, pulses.length - 7);
            stats.pulses = pulses.length;
            // 频谱：上去快、下来慢
            const spectrum = audio.spectrum || [];
            for (let i = 0; i < BANDS; i += 1) {
                const raw = spectrum.length ? clamp(Number(spectrum[bandIndex(i, spectrum.length)]) || 0, 0, 1) : 0;
                const v = clamp(raw * (0.8 + 0.4 * s.audioReactivity), 0, 1);
                const rate = v > bands[i] ? 24 : 5;
                if (frame.isPlaying) bands[i] += (v - bands[i]) * (1 - Math.exp(-dt * rate));
                // 峰值小帽：顶上去停一下再往下掉
                if (bands[i] >= peaks[i]) { peaks[i] = bands[i]; peakVel[i] = -0.35; }
                else if (frame.isPlaying) { peakVel[i] += dt * 2.2; if (peakVel[i] > 0) peaks[i] = Math.max(bands[i], peaks[i] - peakVel[i] * dt); }
            }
            // 电平历史：每半秒记一格；换歌清空
            const id = frame.track?.path || frame.track?.title || '';
            if (id !== histTrack) { histTrack = id; hist.fill(-1); histAt = frame.playbackTime; }
            if (frame.isPlaying) {
                while (frame.playbackTime - histAt >= 0.5) {
                    hist.copyWithin(0, 1);
                    hist[HIST - 1] = clamp(power * 1.25, 0, 1);
                    histAt += 0.5;
                }
                if (frame.playbackTime < histAt - 1) histAt = frame.playbackTime;
            }
        };

        const draw = (frame, s = settings()) => {
            if (!glState || lostContext) return;
            const { gl, program, uniforms: u, vao } = glState;
            const t = frame.playbackTime;
            const now = (frame.now ?? performance.now()) / 1000;
            const dt = lastT === null ? 0 : clamp(now - lastT, 0, 0.1);
            lastT = now;
            stepPulses(frame, dt, s);

            const W = canvas.width, H = canvas.height;
            const k = Math.min(W * 0.46 / WIDTH, H * 0.4 / HEIGHT);
            const cx = W / 2, cy = H * (1 - 0.385);
            gl.viewport(0, 0, W, H);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            gl.uniform2f(u.uRes, W, H);
            gl.uniform2f(u.uCentre, cx, cy);
            gl.uniform1f(u.uK, k);
            gl.uniform1f(u.uTime, t);
            gl.uniform1f(u.uEnergy, s.reducedMotion ? 0 : energy);
            gl.uniform1f(u.uLight, colours.light ? 1 : 0);
            gl.uniform3fv(u.uField, colours.field);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform3fv(u.uBody, colours.body);
            pulseBuf.fill(0);
            const pulseCount = Math.min(MAX_PULSES, pulses.length);
            for (let i = 0; i < pulseCount; i += 1) {
                const p = pulses[i];
                const o = i * 4;
                pulseBuf[o] = p.p; pulseBuf[o + 1] = p.len; pulseBuf[o + 2] = p.a;
            }
            gl.uniform4fv(u.uPulse, pulseBuf);
            gl.uniform1i(u.uPulseCount, pulseCount);
            gl.uniform1fv(u.uBands, bands);
            const stripY = H * (1 - 0.66);
            gl.uniform4f(u.uStrip, stripY, Math.min(W * 0.2, k * 2.2), H * 0.024, s.showSpectrum ? 1 : 0);
            gl.uniform1fv(u.uHist, hist);
            gl.uniform4f(u.uHistBox, H * (1 - 0.755), Math.min(W * 0.3, k * 3.2), H * 0.03, s.panel === 'history' ? 1 : 0);
            const mx = WIDTH / 2 * k + H * 0.05, myTop = HEIGHT / 2 * k + H * 0.05;
            gl.uniform4f(u.uBox, cx - mx, s.showSpectrum ? stripY - H * 0.05 : cy - myTop, cx + mx, cy + myTop);
            gl.uniform1fv(u.uPeaks, peaks);
            // 环慢慢侧倾：角度只跟播放时间走；间奏时摆得大一点
            const sway = s.reducedMotion ? 0 : 1;
            const ax = sway * (0.09 + 0.15 * inter) * Math.sin(t * 0.17 + 0.6);
            const ay = sway * (0.13 + 0.2 * inter) * Math.sin(t * 0.11 + 2.1);
            gl.uniformMatrix3fv(u.uPlane, false, planeMatrix(ax, ay, plane));
            const lx = -0.45 + ay * 0.9, ly = 0.65 - ax * 0.9, lz = 0.62;
            const ln = Math.hypot(lx, ly, lz);
            gl.uniform3f(u.uLightP, lx / ln, ly / ln, lz / ln);
            gl.uniform1f(u.uKick, s.reducedMotion ? 0 : kick);
            gl.uniform1f(u.uCharge, charge);
            gl.uniform3f(u.uRipple, ripple.age, s.reducedMotion || ripple.age >= 1 ? 0 : ripple.str, ripple.wide);
            gl.uniform1f(u.uGrain, s.grain);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            stats.draws += 1;
        };

        const restart = (el, cls) => {
            el.classList.remove('is-in', 'is-out');
            void el.offsetWidth;
            el.classList.add(cls);
        };
        const firstStart = frame => {
            const lines = frame.lines || [];
            for (const l of lines) if (readableText(l.fullText)) return l.startTime;
            return Infinity;
        };
        let lastChorus = null;
        const updateOverlay = (frame, s = settings()) => {
            const next = `信号 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const active = frame.activeLine;
            const isChorus = Boolean(active && chorus.has(normLine(active)));
            if (isChorus !== lastChorus) {
                lastChorus = isChorus;
                mode.root.classList.toggle('is-chorus', isChorus);
                const b = badge();
                if (b) b.textContent = isChorus ? '副歌' : '实时';
            }
            const show = s.panel === 'lyrics';
            if (lyric.hidden !== !show) lyric.hidden = !show;
            if (!show) return;
            let text = active && readableText(active.fullText) ? String(active.fullText).trim() : '';
            // 第一句之前：监视窗里先打出歌名
            let title = false;
            if (!text && (frame.playbackTime || 0) < firstStart(frame) && frame.track?.title) { text = String(frame.track.title).replace(/\.(mp3|flac|wav|m4a|ogg|aac|ape|opus)$/i, '').trim(); title = true; }
            if (text !== lastLine) {
                const prev = slots[slot];
                if (lastLine) restart(prev, 'is-out');
                slot = 1 - slot;
                const cur = slots[slot];
                cur.textContent = text;
                cur.classList.toggle('is-title', title);
                if (text) restart(cur, 'is-in'); else cur.classList.remove('is-in', 'is-out');
                lastLine = text;
            }
            const tr = s.showTranslation && active ? resolveSupplementalText(active) : '';
            if (tr !== lastTranslation) { lastTranslation = tr; translation.textContent = tr; translation.hidden = !tr; }
            const progress = text && !title ? clamp(frame.lineProgress || 0, 0, 1) : 0;
            const r = (Math.round(progress * 200) / 200).toString();
            if (r !== lastRule) { lastRule = r; ruleFill.style.transform = `scaleX(${r})`; }
        };


        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latestFrame = frame;
            if (!colours) readColours();
            const s = settings();
            updateOverlay(frame, s);
            if (!glState || lostContext || !Runtime.programsReady(glState.gl, redraw)) return;
            const aim = 1000 / (FPS[s.quality] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (!frame.isPlaying) lastT = null;
            if (!frame.isPlaying && still.same(frame, `${canvas.width}x${canvas.height}`)) return;
            if (frame.isPlaying) still.invalidate();
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            draw(frame, s);
        };

        const applyScale = () => mode.root.style.setProperty('--signal-scale', String(settings().fontScale));
        applyScale();
        const redraw = () => { still.invalidate(); lastDraw = -Infinity; if (latestFrame) mode.updateFrame(latestFrame); };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); applyScale(); resize(); readColours(); redraw(); };
        mode.resize = () => { resize(); redraw(); };
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; lastT = null; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { readColours(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), ready: !glState || lostContext || stats.draws > 0 || Runtime.programsFailed(glState.gl),
            draws: stats.draws, pulses: stats.pulses, buffer: `${canvas.width}x${canvas.height}`
        });

        const onLost = (event) => { event.preventDefault(); lostContext = true; Runtime.cancelPrograms(glState?.gl); };
        const onRestored = () => { try { glState = createGl(canvas); lostContext = false; redraw(); } catch (error) { console.error(error); } };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            if (glState) {
                const { gl } = glState;
                Runtime.cancelPrograms(gl);
                gl.deleteProgram(glState.program);
                gl.deleteVertexArray(glState.vao);
                Runtime.releaseWebGLContext(gl);
            }
            glState = null;
        });

        resize();
        return mode;
    };

    global.MusicStageSignalManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ pointAt, bandIndex, planeMatrix, applyPlane, chorusSet, normLine, LOOP, HALF, ARC, D, R, PHI })
    });
})(window);
