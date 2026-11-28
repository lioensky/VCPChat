(function (global) {
    'use strict';

    /*
     * 回环：一圈斜着的椭圆轨道，歌词一字一字排在轨道上。唱到的字总是转到最前面（椭圆下沿），
     * 最大、最亮；唱过的字往左转到后面去，没唱的字从右边转过来。后半圈的字小而淡，像隔着轨道看过去。
     * 换句时上一句往外散开淡出。
     *
     * 画法：一个全屏三角形画底色、轨道线和轴线；字是一批四边形（每字六个顶点），位置在 CPU 上按
     * 椭圆算好、按远近排序后用 uniform 数组传进去，字形来自一张 16×16 格的字图（每句画一次）。
     */
    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before orbit-manager.js');
    const { clamp, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 2, ultimate: 2 });
    // 泛光：轨道、正在唱的字和副歌闪光的亮部向外晕开（浅色主题不做，底色本来就亮）
    const BLOOM = 0.55;
    const KNEE = [0.5, 0.3];
    const MAX_GLYPHS = 64;
    const CELL = 128;
    const GRID = 16;
    const FRONT = -Math.PI / 2;
    const SPAN = 0.84; // 一句最多占轨道的多少
    const FADE = 0.6;

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    // 副歌：歌词里出现两次以上的句子（歌词自己标了 isChorus 的也算）
    const normLine = line => String(line?.fullText || line?.original || '').replace(/[\s，。、,.!?！？…~～'"“”‘’()（）-]/g, '').toLowerCase();
    const chorusSet = (lines) => {
        const counts = new Map();
        (lines || []).forEach((line) => { const k = normLine(line); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
        return new Set([...counts].filter(([, n]) => n >= 2).map(([k]) => k));
    };

    /* ───────────────────────── 轨道 ───────────────────────── */

    const sungLines = lines => (lines || []).filter(line => readableText(line.fullText));
    const lineIndexAt = (sung, t) => {
        let low = 0, high = sung.length - 1, result = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (t >= sung[mid].startTime) { result = mid; low = mid + 1; } else high = mid - 1;
        }
        return result;
    };

    // 每个字中心在这句里的位置（字图像素，沿轨道量）
    const arcLayout = (advances) => {
        const centres = [];
        let at = 0;
        advances.forEach((a, i) => {
            if (i > 0) at += a / 2;
            centres.push(at);
            at += a / 2;
        });
        return { centres, span: at };
    };

    // 椭圆按屏幕上的弧长（再除以透视缩放）查角度：两头不挤，前排的大字也不挤
    const TABLE = 360;
    const ellipseTable = (A, B, out) => {
        let length = 0;
        out[0] = 0;
        for (let i = 1; i <= TABLE; i += 1) {
            const a0 = FRONT + ((i - 1) / TABLE) * Math.PI * 2;
            const a1 = FRONT + (i / TABLE) * Math.PI * 2;
            const m = (a0 + a1) / 2;
            // 按透视缩放折算：前排的字大，走同样的「字数」要多走一段
            length += Math.hypot(A * Math.sin(m), B * Math.cos(m)) * (1 + 0.36 * Math.sin(m)) * (a1 - a0);
            out[i] = length;
        }
        return length;
    };
    // 从最前点沿轨道走 d（可正可负）到的角度
    const thetaAlong = (table, perimeter, d) => {
        let x = d % perimeter;
        if (x < 0) x += perimeter;
        let low = 0, high = TABLE;
        while (high - low > 1) { const mid = (low + high) >> 1; if (table[mid] <= x) low = mid; else high = mid; }
        const f = (x - table[low]) / Math.max(1e-9, table[high] - table[low]);
        return FRONT + ((low + f) / TABLE) * Math.PI * 2;
    };

    // 此刻唱到第几个字（带小数）：字开始时为 i，字结束时为 i+1；还没开唱时为负
    const singingPosition = (glyphs, t) => {
        if (!glyphs.length) return 0;
        if (t < glyphs[0].start) return -clamp((glyphs[0].start - t) / 0.6, 0, 1) * 0.6;
        for (let i = 0; i < glyphs.length; i += 1) {
            const g = glyphs[i];
            const end = Math.max(g.end, g.start + 0.05);
            if (t < end) return i + clamp((t - g.start) / (end - g.start), 0, 1);
            const next = glyphs[i + 1];
            if (next && t < next.start) return i + 1;
        }
        return glyphs.length;
    };
    // 唱到第 g 个字时，轨道转了多少：让第 g 个字的位置正好在最前
    const arcAt = (centres, g) => {
        if (!centres.length) return 0;
        if (g <= 0) return centres[0] + g * (centres[1] !== undefined ? centres[1] - centres[0] : 0.2);
        const i = Math.min(centres.length - 1, Math.floor(g));
        const next = centres[i + 1] ?? centres[i] + (centres[i] - (centres[i - 1] ?? centres[i] - 0.2));
        return centres[i] + (next - centres[i]) * (g - i);
    };
    // 轨道上角度 θ 的点：屏幕坐标（相对圆心，单位是屏幕高）、远近 z（-1 最近，1 最远）、透视缩放
    const project = (theta, A, B, roll) => {
        const x = Math.cos(theta) * A;
        const y = Math.sin(theta) * B;
        const z = Math.sin(theta);
        const s = 1 / (1 + 0.36 * z);
        const c = Math.cos(roll), sn = Math.sin(roll);
        return { x: x * c - y * sn, y: x * sn + y * c, z, s };
    };

    /* ───────────────────────── GL ───────────────────────── */

    const FIELD_VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
    const FIELD_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uCentre;
uniform vec2 uAxes;      // 椭圆半轴（屏幕高）
uniform float uRoll;
uniform float uSpin;
uniform float uAxis;
uniform float uGlow;
uniform float uLight;
uniform vec3 uField;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uBeat;
uniform float uChorus;
uniform float uTime;
uniform float uNebula;
uniform float uChange;
out vec4 outColor;

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

${Utils.NOISE_GLSL}

// 打光：暗房间，一块左上的暖色柔光箱（慢慢挪一点，高光会沿环走），右边一条冷色灯带，下面一点强调色反光
const vec3 TOP_DIR = vec3(0.152349, 0.761745, -0.629709);
vec3 keyDir() {
    float a = -0.5 + 0.18 * sin(uTime * 0.05);
    return normalize(vec3(sin(a) * 0.8, 0.62, 0.72));
}
vec3 studio(vec3 r, vec3 kDir) {
    vec3 c = mix(uField * 0.7 + vec3(0.03), uField * 0.9 + vec3(0.12), uLight) * (0.55 + 0.45 * r.y);
    // 头顶后方一大块柔光：倾斜的环面大多把它反过来，环身因此是亮的
    float top = smoothstep(0.55, 0.92, dot(r, TOP_DIR));
    c += vec3(1.0, 0.9, 0.74) * top * 1.15;
    float kd = dot(r, kDir);
    float key = smoothstep(0.82, 0.96, kd);
    c += vec3(1.0, 0.93, 0.82) * key * 2.4;
    c += vec3(1.0, 0.95, 0.88) * smoothstep(0.35, 0.95, kd) * 0.2;
    float strip = (1.0 - smoothstep(0.03, 0.12, abs(r.x - 0.72))) * smoothstep(-0.3, 0.4, r.y);
    c += vec3(0.72, 0.84, 1.0) * strip * 0.9;
    float stripL = (1.0 - smoothstep(0.02, 0.1, abs(r.x + 0.8))) * smoothstep(-0.5, 0.2, r.y);
    c += vec3(1.0, 0.88, 0.7) * stripL * 0.5;
    c += uAccent * smoothstep(0.0, -0.8, r.y) * 0.3;
    return c;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / uRes.y;
    vec2 p = vec2(uv.x * aspect, uv.y);
    float aa = 1.5 / uRes.y;

    // 底：中间稍亮，带一点强调色的雾
    vec2 d0 = p - uCentre;
    vec3 col = uField * (1.0 + mix(0.35, 0.06, uLight) * exp(-dot(d0, d0) * 3.0));
    col += uAccent * mix(0.05, 0.03, uLight) * exp(-dot(d0 - vec2(0.0, -0.1), d0 - vec2(0.0, -0.1)) * 6.0);

    // 远处：很淡的星尘和两缕慢慢转的星云
    if (uNebula > 0.0) {
        float ca = cos(uTime * 0.01), sa = sin(uTime * 0.01);
        vec2 np = vec2(d0.x * ca - d0.y * sa, d0.x * sa + d0.y * ca) * 2.2;
        np += vec2(vnoise(np * 1.5 + 3.0), vnoise(np * 1.5 - 4.0)) * 0.8;
        float neb = vnoise(np * 2.0 + uTime * 0.02) * 0.6 + vnoise(np * 5.0 - uTime * 0.03) * 0.4;
        neb = smoothstep(0.5, 0.95, neb) * smoothstep(0.9, 0.2, length(d0));
        col += mix(uAccent, uInk, 0.6) * neb * mix(0.05, 0.03, uLight) * uNebula * (1.0 + uChorus * 1.5);
        vec2 sc = floor(gl_FragCoord.xy / 2.0);
        float star = step(0.997, hash12(sc)) * (0.5 + 0.5 * sin(uTime * 1.7 + hash12(sc + 3.0) * 30.0));
        col = mix(col, uInk, star * mix(0.3, 0.2, uLight) * uNebula);
    }
    // 副歌：轨道外一圈更宽的光
    col += uAccent * uChorus * mix(0.08, 0.04, uLight) * exp(-dot(d0, d0) * 2.2);

    // 转回轨道自己的坐标
    float cr = cos(uRoll), sr = sin(uRoll);
    vec2 q = vec2(d0.x * cr + d0.y * sr, -d0.x * sr + d0.y * cr);
    float theta = atan(q.y / uAxes.y, q.x / uAxes.x);
    float depth = sin(theta);
    float front = 0.5 - depth * 0.5;
    // 圆环所在平面：倾角 i，屏幕上半轴 B = A·cos i；R 是环上这一点朝外的方向，N 是环面法线（朝观众）
    float ci = clamp(uAxes.y / max(uAxes.x, 1e-4), 0.05, 1.0), si = sqrt(1.0 - ci * ci);
    vec3 R = vec3(cos(theta), sin(theta) * ci, -sin(theta) * si);
    vec3 N = vec3(0.0, si, ci);
    vec2 toScreen = vec2(cr, sr);
    float persp = 0.75 + front * 0.5;

    // 两道金属环：外环黄铜、内环钢；圆截面打光，外环面上刻着跟着转的刻度。
    // 环、轴、中心球、小珠互相基本不重叠：先挑出这个像素最上面的那个面，最后只打一次光
    vec3 brass = mix(vec3(0.95, 0.76, 0.42), uAccent, 0.22);
    vec3 sN = vec3(0.0, 0.0, 1.0), sF0 = brass, sBase = vec3(0.0);
    float sA = 0.0, sDim = 1.0, sLip = 0.0, sTop = 0.0;   // sTop：0 环后半、1 轴、2 环前半、3 小珠
    for (int k = 0; k < 2; k++) {
        float scale = k == 0 ? 1.0 : 0.82;
        vec2 ax = uAxes * scale;
        float e = length(q / ax);
        // 到椭圆的近似真实距离（不再用短半轴量，两侧不会变粗）
        float d = (e - 1.0) * e / max(length(q / (ax * ax)), 1e-4);
        float hw = (k == 0 ? 0.0062 : 0.0032) * persp * (1.0 + uChange * 0.15);
        float cover = (1.0 - smoothstep(hw - aa * 0.5, hw + aa * 0.5, abs(d))) * (k == 0 ? 1.0 : 0.85) * (0.55 + front * 0.45);
        // 光晕留一点，换句和低音时亮
        float glow = exp(-d * d / (0.0004 + uGlow * 0.0006 + uChange * 0.0012));
        col += uAccent * glow * (k == 0 ? 1.0 : 0.45) * (0.18 + front * 0.6) * (0.03 + uGlow * 0.1) * (1.0 - uLight * 0.5);
        if (k == 0) {
            float g2 = exp(-d * d / (0.0016 + uGlow * 0.002 + uChange * 0.004));
            col += uAccent * g2 * (0.18 + front * 0.6) * (0.04 + uGlow * 0.1 + uChange * 0.08) * (1.0 - uLight * 0.5);
        }
        if (cover > sA) {
            float u = clamp(d / hw, -1.0, 1.0);
            // 车床纹：沿环方向的细槽，只轻轻扰动法线；环细到一两个像素时把截面压平，免得掠射反光闪成虚线
            float groove = sin(floor((u + 1.0) * 9.0) * 12.9898 + float(k) * 4.0) * 0.5;
            float uu = clamp(u + groove * 0.12, -1.0, 1.0) * clamp(hw / (3.0 * aa), 0.4, 1.0);
            sN = R * uu + N * sqrt(max(1.0 - uu * uu, 0.0));
            sN.xy = vec2(sN.x * toScreen.x - sN.y * toScreen.y, sN.x * toScreen.y + sN.y * toScreen.x);
            sF0 = k == 0 ? brass : vec3(0.66, 0.68, 0.72);
            sA = cover;
            sTop = depth > 0.0 ? 0.0 : 2.0;
            // 两边收进去一点暗边，像圆管的轮廓
            sDim = 0.55 + 0.45 * smoothstep(1.0, 0.7, abs(u));
            sLip = 0.0;
            if (k == 0) {
                // 刻度：72 格、每 6 格一道长刻，凹进去（暗槽 + 一侧亮边）
                float a = (theta - uSpin) / 6.2832 * 72.0;
                float f = fract(a) - 0.5;
                float major = 1.0 - step(0.01, mod(floor(a + 0.5), 6.0));
                float arc = 6.2832 * length(uAxes) * 0.7 / 72.0;     // 每格在屏幕上的大致弧长
                float wTick = (major > 0.5 ? 0.0012 : 0.0006) * persp;
                float reach = major > 0.5 ? 0.62 : 0.3;
                float inBand = 1.0 - smoothstep(reach, reach + 0.12, abs(u));
                float notch = (1.0 - smoothstep(wTick, wTick + aa, abs(f) * arc)) * inBand;
                float lip = (1.0 - smoothstep(0.0, wTick + aa, abs(f * arc + wTick * 1.6))) * inBand;
                sDim *= mix(1.0, 0.28, notch * (major > 0.5 ? 0.85 : 0.45));
                sLip = lip * 0.25 * (1.0 - notch);
            }
        }
    }

    // 轴：一根抛光的细钢杆穿过圆心，中间套一颗小球；环的后半圈在杆后面，前半圈在杆前面
    if (uAxis > 0.5) {
        vec2 dir = vec2(-sr, cr);
        float along = dot(d0, dir);
        float perpS = dir.x * d0.y - dir.y * d0.x;
        float reach = 0.46 + uBeat * 0.08 + uChorus * 0.06;
        float hw = 0.0024;
        float cover = (1.0 - smoothstep(hw - aa * 0.5, hw + aa * 0.5, abs(perpS))) * (1.0 - smoothstep(0.1, reach, abs(along))) * 0.85;
        float rb = 0.014;
        float sc = 1.0 - smoothstep(rb - aa, rb + aa, length(d0));
        bool over = sTop < 1.5;
        if (sc > 0.0 && (over || sc > sA)) {
            vec2 v = d0 / rb;
            sN = vec3(v, sqrt(max(1.0 - dot(v, v), 0.0)));
            sF0 = brass; sA = sc; sTop = 1.0; sDim = 1.0; sLip = 0.0; sBase = vec3(0.0);
        } else if (cover > 0.0 && (over || cover > sA)) {
            float u = clamp(perpS / hw, -1.0, 1.0) * 0.7;
            vec2 side = vec2(dir.y, -dir.x);
            sN = vec3(-side * u, sqrt(max(1.0 - u * u, 0.0)));
            sF0 = vec3(0.62, 0.64, 0.67); sA = cover; sTop = 1.0; sLip = 0.0;
            sDim = 1.0 + uBeat * 0.4;
            sBase = mix(uInk, uField, uLight) * 0.12;
        }
    }

    // 轨道上几颗慢慢转的小珠：上釉的彩珠，盖在最上面
    vec3 kDir = vec3(0.0);
    bool hasKDir = false;
    {
        float a = theta - uSpin;
        float idx = floor(a / 6.2832 * 7.0 + 0.5);
        float tc = uSpin + idx * 6.2832 / 7.0;
        vec2 cq = vec2(cos(tc), sin(tc)) * uAxes;
        float fb = 0.5 - sin(tc) * 0.5;
        float rb = 0.0075 * (0.75 + fb * 0.5);
        vec2 v = (q - cq) / rb;
        float r2 = dot(v, v);
        float cover = (1.0 - smoothstep(1.0 - aa / rb, 1.0 + aa / rb, sqrt(r2))) * (0.6 + fb * 0.4);
        if (cover > 0.0) {
            kDir = keyDir();
            hasKDir = true;
            sN = vec3(v, sqrt(max(1.0 - r2, 0.0)));
            sN.xy = vec2(sN.x * toScreen.x - sN.y * toScreen.y, sN.x * toScreen.y + sN.y * toScreen.x);
            sBase = uAccent * (0.18 + 0.82 * max(dot(sN, kDir), 0.0));
            sF0 = vec3(0.04); sA = max(sA * (1.0 - cover), cover); sTop = 3.0; sDim = 1.3; sLip = 0.0;
        }
    }
    if (sA > 0.0) {
        if (!hasKDir) kDir = keyDir();
        sN = normalize(sN);
        vec3 r = reflect(vec3(0.0, 0.0, -1.0), sN);
        vec3 F = sF0 + (1.0 - sF0) * pow(1.0 - max(sN.z, 0.0), 5.0);
        vec3 env = studio(r, kDir);
        vec3 lit = sTop > 2.5 ? sBase + F * env * sDim
                              : (F * env + sF0 * mix(0.05, 0.12, uLight)) * sDim + sF0 * sLip + sBase;
        col = mix(col, lit, sA);
    }
    // 鼓点：从轨道向外推出一圈细光环
    if (uBeat > 0.01) {
        float sc = 1.0 + (1.0 - uBeat) * 0.45;
        float e = length(q / (uAxes * sc));
        float dist = abs(e - 1.0) * uAxes.y * sc;
        col += mix(uInk, uAccent, 0.5) * exp(-dist * dist / 0.00002) * uBeat * uBeat * 0.4;
    }

    vec2 v = uv - 0.5;
    col *= 1.0 - dot(v, v) * mix(0.6, 0.2, uLight);
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // 每个字一个四边形：uA = (x, y, 字高, 旋转)，uB = (格子编号, 不透明度, 正在唱, 已唱)
    const GLYPH_VERT = `#version 300 es
precision highp float;
uniform vec4 uA[${MAX_GLYPHS}];
uniform vec4 uB[${MAX_GLYPHS}];
uniform int uCount;
uniform vec2 uRes;
out vec2 vTex;
out vec3 vInfo;
out float vBlur;
out vec2 vLocal;
void main() {
    int g = gl_VertexID / 6;
    int k = gl_VertexID - g * 6;
    if (g >= uCount || uB[g].y <= 0.001) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vTex = vec2(0.0); vInfo = vec3(0.0); vBlur = 0.0; vLocal = vec2(0.0); return; }
    vec2 corner = vec2(k == 1 || k == 2 || k == 4 ? 1.0 : 0.0, k == 2 || k == 4 || k == 5 ? 1.0 : 0.0);
    vec4 a = uA[g];
    vec4 b = uB[g];
    vec2 local = (corner - 0.5) * a.z * 1.3;
    float c = cos(a.w), s = sin(a.w);
    vec2 pos = a.xy + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    float aspect = uRes.x / uRes.y;
    gl_Position = vec4(pos.x / aspect * 2.0 - 1.0, pos.y * 2.0 - 1.0, 0.0, 1.0);
    float cell = floor(b.x);
    vBlur = fract(b.x) / 0.9;
    vec2 cellXY = vec2(mod(cell, ${GRID}.0), floor(cell / ${GRID}.0));
    vec2 inCell = vec2(corner.x, 1.0 - corner.y);
    vTex = (cellXY + inCell) / ${GRID}.0;
    vInfo = b.yzw;
    vLocal = corner - 0.5;
}`;
    const GLYPH_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uWaiting;
uniform float uChorusLine; // 0..1 这一句是副歌（重复出现的句子）
uniform float uHalo;       // 字自带光晕的强度：有泛光时只留一点，外圈交给泛光
in vec2 vTex;
in vec3 vInfo;
in float vBlur;
in vec2 vLocal;
out vec4 outColor;
void main() {
    float alpha = vInfo.x;
    // vInfo.y = 正在唱 + 起字闪光（大于 1 的部分）
    float singing = min(vInfo.y, 1.0);
    float flash = max(vInfo.y - 1.0, 0.0);
    float sung = vInfo.z;
    // 景深：轨道后半圈的字虚一点
    float m = textureLod(uAtlas, vTex, vBlur * 1.8).r * (1.0 + vBlur * 0.25);
    if (m <= 0.001 && singing <= 0.001) discard;
    // 光晕取字图的模糊层，到四边形边上淡到 0，免得切出方块；未在唱的字不采样模糊层
    float halo = 0.0;
    float wide = 0.0;
    if (singing > 0.001) {
        float fall = smoothstep(0.5, 0.32, max(abs(vLocal.x), abs(vLocal.y)));
        halo = textureLod(uAtlas, vTex, 3.0).r * fall * uHalo;
        // 副歌：外面再套一圈更大的光晕，字心发白（像相机闪光）
        if (uChorusLine > 0.01) wide = textureLod(uAtlas, vTex, 4.3).r * uChorusLine * fall * uHalo;
    }
    vec3 col = mix(uInk, uAccent, singing);
    float body = m * mix(uWaiting, 1.0, max(sung, singing));
    float a = clamp(body + halo * singing * (0.6 + flash) + wide * singing * 0.55, 0.0, 1.0) * alpha;
    vec3 c = mix(col, uAccent, (1.0 - step(0.02, m)) * singing);
    c = mix(c, uInk, clamp(m * singing * (0.4 * uChorusLine + flash * 0.6), 0.0, 0.75));
    outColor = vec4(c * a, a);
}`;

    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default'
        });
        if (!gl) return null;
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        const texture = () => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const slots = Array.from({ length: 3 }, () => ({ atlas: texture(), key: null, used: 0, line: null }));
        return {
            gl, field: Utils.compileProgram(gl, FIELD_VERT, FIELD_FRAG, 'orbit:field'), glyph: Utils.compileProgram(gl, GLYPH_VERT, GLYPH_FRAG, 'orbit:glyph'),
            vao: gl.createVertexArray(), slots,
            scene: Utils.createTarget(gl), over: Utils.createTarget(gl),
            bloom: Utils.createBloom(gl, { label: 'orbit' })
        };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('orbit', '回环', container, services);
        const canvas = createElement('canvas', 'orbit-canvas');
        const kicker = createElement('div', 'orbit-kicker', '回环');
        const translation = createElement('div', 'stage-translation orbit-translation');
        const notice = createElement('div', 'orbit-notice');
        notice.hidden = true;
        mode.root.append(canvas, kicker, translation, notice);
        const atlas = document.createElement('canvas');
        atlas.width = CELL * GRID;
        atlas.height = CELL * GRID;

        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，回环画不出来，请换一个舞台';
        }
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const bufA = new Float32Array(MAX_GLYPHS * 4);
        const bufB = new Float32Array(MAX_GLYPHS * 4);
        const prevBufA = new Float32Array(MAX_GLYPHS * 4);
        const prevBufB = new Float32Array(MAX_GLYPHS * 4);
        const arcTable = new Float32Array(TABLE + 1);
        let sung = [];
        let sungFor = null;
        let paused = false;
        let low = [1, 1];
        let latestFrame = null;
        let lastDraw = -Infinity;
        let colours = null;
        let caption = '';
        let lastTranslation = '';
        let lostContext = false;
        let idleHandle = 0;
        let glow = 0;
        let chorus = 0;
        let lastOnsets = -1;
        let beatTime = -Infinity;
        let chorusFor = null;
        let chorusKeys = new Set();
        const stats = { builds: 0, buildMs: 0, draws: 0, index: -2, glyphs: 0 };

        const settings = () => {
            const tuning = mode.config.modes?.orbit || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                tilt: clamp(tuning.tilt ?? 0.3, 0.15, 0.6),
                roll: clamp(tuning.roll ?? -12, -30, 30),
                axisLine: tuning.axisLine !== false,
                nebula: clamp(tuning.nebula ?? 1, 0, 2),
                waitingOpacity: clamp(tuning.waitingOpacity ?? 0.3, 0, 1),
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
                field: light ? mixRgb(bg, [0.96, 0.95, 0.92], 0.3) : mixRgb(bg, [0.03, 0.035, 0.05], 0.6),
                ink: hexRgb(p.ink, light ? [0.1, 0.12, 0.12] : [0.95, 0.94, 0.9]),
                accent: hexRgb(p.accent, [0.95, 0.66, 0])
            };
            mode.root.style.setProperty('--orbit-field', `rgb(${colours.field.map(v => Math.round(v * 255)).join(',')})`);
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            // 画面（星云、轨道）按像素预算画在小图上再放大；字按屏幕原生像素画，边缘才清楚
            const size = Utils.sharpSizes(w, h, PIXELS[quality] || PIXELS.standard, RATIO[quality] || 2);
            low = [size.lw, size.lh];
            if (canvas.width !== size.nw || canvas.height !== size.nh) { canvas.width = size.nw; canvas.height = size.nh; still.invalidate(); }
        };

        const ensureLines = (frame) => {
            if (sungFor === frame.lines) return;
            sung = sungLines(frame.lines);
            sungFor = frame.lines;
            glState?.slots.forEach((slot) => { slot.key = null; });
            Utils.loadLyricFont(frame.lines, [700], () => { if (mode.destroyed) return; glState?.slots.forEach((slot) => { slot.key = null; }); redraw(); }, frame.track?.title || '');
        };

        let cachedFamily = '';
        const family = () => {
            if (!cachedFamily) cachedFamily = global.getComputedStyle?.(mode.root).fontFamily || 'system-ui, sans-serif';
            return cachedFamily;
        };

        // 一句的字图：每格一个字；记下每个字的宽度和时刻
        const slotFor = (index, build = true) => {
            if (!glState) return null;
            const key = `${index}|${sung.length}`;
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            let glyphs;
            if (index >= 0 && index < sung.length) {
                glyphs = buildGlyphTimeline(sung[index]).map(g => ({ text: g.text, start: g.startTime, end: g.endTime }));
            } else {
                const title = String(latestFrame?.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '');
                glyphs = Array.from(title).map((text, i) => ({ text, start: 0.4 + i * 0.08, end: 0.5 + i * 0.08 }));
            }
            // 空格并进前一个字的宽度，不占格子
            const ctx = atlas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, atlas.width, atlas.height);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const size = 88;
            ctx.font = `700 ${size}px ${family()}`;
            const items = [];
            glyphs.forEach((g) => {
                const width = ctx.measureText(g.text).width;
                if (!g.text.trim()) { if (items.length) items[items.length - 1].advance += width; return; }
                if (items.length >= Math.min(MAX_GLYPHS, GRID * GRID)) return;
                const cell = items.length;
                const cx = (cell % GRID) * CELL + CELL / 2;
                const cy = Math.floor(cell / GRID) * CELL + CELL / 2;
                ctx.fillText(g.text, cx, cy + size * 0.04);
                items.push({ cell, advance: Math.max(width, size * 0.42) + size * 0.12, start: g.start, end: g.end });
            });
            const layout = arcLayout(items.map(item => item.advance));
            const { gl } = glState;
            const busy = new Set([stats.index, stats.index - 1].map(i => `${i}|${sung.length}`));
            const slot = glState.slots.filter(sl => !busy.has(sl.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.atlas);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
            gl.generateMipmap(gl.TEXTURE_2D);
            slot.key = key;
            slot.used = performance.now();
            slot.line = { items, centres: layout.centres };
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        const cancelIdle = () => {
            if (!idleHandle) return;
            (global.cancelIdleCallback || global.clearTimeout)(idleHandle);
            idleHandle = 0;
        };

        const scheduleNext = (index) => {
            if (idleHandle || paused || !glState || index + 1 >= sung.length || slotFor(index + 1, false)) return;
            const run = () => { idleHandle = 0; if (!mode.destroyed && !paused && !lostContext) slotFor(index + 1, true); };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        const placePool = Array.from({ length: MAX_GLYPHS }, () => ({
            z: 0, a0: 0, a1: 0, a2: 0, a3: 0, b0: 0, b1: 0, b2: 0, b3: 0
        }));
        const placeList = [];
        const sortByZDesc = (p, q) => q.z - p.z;
        let lastArcA = -1, lastArcB = -1, lastPerimeter = 0;

        // 把一句的字排上轨道，写进 outA/outB 的 [from, …)，返回写了几个
        const place = (line, t, geo, fade, from, rest, chorusAmt = 0, outA = bufA, outB = bufB) => {
            const { items, centres } = line;
            const itemCount = items.length;
            const g = rest ? itemCount : singingPosition(items, t);
            const turn = arcAt(centres, g - 0.5);
            const span = itemCount ? centres[itemCount - 1] - centres[0] + items[0].advance : 1;
            // 字图像素换成轨道长度（已按透视折算）；太长的句子整体收紧
            const baseUnit = geo.size * 1.06 / 88;
            const unit = Math.min(baseUnit, geo.perimeter * SPAN / span);
            // 收紧了字距，字也跟着缩，不然长句的字会叠在一起
            const shrink = unit / baseUnit;
            const outward = rest ? (1 - fade) * 0.06 : 0;
            const outScale = 1 + outward;
            const restAngle = rest ? -0.25 * (1 - fade) : 0;
            const staggerScale = chorusAmt * geo.size * shrink * (0.06 + geo.power * 0.12);
            const sizeShrink = geo.size * shrink;
            const limit = Math.min(itemCount, MAX_GLYPHS);
            placeList.length = 0;
            for (let i = 0; i < limit; i += 1) {
                const item = items[i];
                const theta = thetaAlong(geo.table, geo.perimeter, (centres[i] - turn) * unit) + restAngle;
                const pt = project(theta, geo.A, geo.B, geo.roll);
                const singing = !rest && t >= item.start - 0.05 && t < Math.max(item.end, item.start + 0.2) + 0.3 ? 1 - smooth(item.end, item.end + 0.3, t) : 0;
                const sungAmount = t >= item.start ? 1 : 0;
                // 起字的一下闪光：前 40% 的时长里光晕放大再收回
                const charP = (t - item.start) / Math.max(0.05, item.end - item.start);
                const flash = !rest && !geo.still && charP >= 0 && charP < 0.4 ? Math.pow(1 - charP / 0.4, 2) * 0.65 : 0;
                // 副歌：单双字上下错开，随低音起伏
                const stagger = staggerScale * pt.s * (i % 2 ? -1 : 1);
                const back = smooth(-0.2, 1, pt.z);
                const alpha = fade * (1 - back * 0.72);
                // 字跟着轨道的切线稍微转一点，最多 ±15°
                let rot = Math.atan2(Math.cos(theta) * geo.B, -Math.sin(theta) * geo.A) + geo.roll;
                while (rot > Math.PI / 2) rot -= Math.PI;
                while (rot < -Math.PI / 2) rot += Math.PI;
                rot = clamp(rot, -0.26, 0.26);
                const entry = placePool[i];
                entry.z = pt.z;
                entry.a0 = geo.cx + pt.x * outScale;
                entry.a1 = geo.cy + pt.y * outScale + stagger;
                entry.a2 = sizeShrink * pt.s * (1 + singing * 0.12);
                entry.a3 = rot;
                entry.b0 = item.cell + clamp(back, 0, 1) * 0.9;
                entry.b1 = alpha;
                entry.b2 = singing + flash * singing;
                entry.b3 = sungAmount;
                placeList.push(entry);
            }
            placeList.sort(sortByZDesc);
            let n = 0;
            for (let i = 0; i < placeList.length; i += 1) {
                const k = from + n;
                if (k >= MAX_GLYPHS) break;
                const entry = placeList[i];
                const o = k * 4;
                outA[o] = entry.a0; outA[o + 1] = entry.a1; outA[o + 2] = entry.a2; outA[o + 3] = entry.a3;
                outB[o] = entry.b0; outB[o + 1] = entry.b1; outB[o + 2] = entry.b2; outB[o + 3] = entry.b3;
                n += 1;
            }
            return n;
        };

        const drawGlyphs = (slot, count, chorusLine = 0, waitingOpacity = 0.3, aBuf = bufA, bBuf = bufB) => {
            if (!count) return;
            const { gl, glyph } = glState;
            const u = glyph.uniforms;
            gl.useProgram(glyph.program);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.atlas); gl.uniform1i(u.uAtlas, 0);
            gl.uniform4fv(u.uA, aBuf);
            gl.uniform4fv(u.uB, bBuf);
            gl.uniform1i(u.uCount, count);
            gl.uniform2f(u.uRes, canvas.width, canvas.height);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform1f(u.uWaiting, waitingOpacity);
            gl.uniform1f(u.uChorusLine, chorusLine);
            gl.uniform1f(u.uHalo, colours.light || !BLOOM ? 1 : 0.35);
            gl.drawArrays(gl.TRIANGLES, 0, count * 6);
        };

        const draw = (frame, s = settings()) => {
            if (!glState || lostContext) return;
            const { gl, field, vao } = glState;
            const t = frame.playbackTime;
            const index = lineIndexAt(sung, t);
            const slot = slotFor(index, true);
            if (!slot) return;
            stats.index = index;
            const startedAt = index >= 0 ? sung[index].startTime : 0;
            const since = t - startedAt;
            const prev = index >= 0 && since < FADE ? slotFor(index - 1, false) : null;
            const aspect = canvas.width / canvas.height;
            const A = Math.min(0.62 * aspect, 0.78) * 0.62;
            const B = A * s.tilt;
            if (A !== lastArcA || B !== lastArcB) {
                lastArcA = A;
                lastArcB = B;
                lastPerimeter = ellipseTable(A, B, arcTable);
            }
            const geo = {
                cx: aspect / 2, cy: 0.53, A, B, roll: s.roll * Math.PI / 180,
                size: 0.06 * s.fontScale, table: arcTable, perimeter: lastPerimeter
            };
            const audio = frame.audio || {};
            const bass = clamp((audio.bass || 0) * s.audioReactivity, 0, 1.5);
            geo.power = s.reducedMotion ? 0 : clamp(bass, 0, 1);
            geo.still = s.reducedMotion;
            if (frame.lines !== chorusFor) { chorusFor = frame.lines; chorusKeys = chorusSet(frame.lines); }
            const isChorus = (line) => Boolean(line && (line.isChorus || chorusKeys.has(normLine(line))));
            const chorusNow = index >= 0 && isChorus(sung[index]) ? smooth(0, 0.5, since) : 0;
            const chorusPrev = index > 0 && isChorus(sung[index - 1]) ? 1 : 0;
            glow = frame.isPlaying ? Math.max(bass, glow * 0.86) : glow;

            const { scene, over, bloom } = glState;
            scene.bind(low[0], low[1]);
            gl.bindVertexArray(vao);
            gl.disable(gl.BLEND);
            const u = field.uniforms;
            gl.useProgram(field.program);
            Utils.bindNoise(gl, field.uniforms.uNoise, 1);
            gl.uniform2f(u.uRes, low[0], low[1]);
            gl.uniform2f(u.uCentre, geo.cx, geo.cy);
            gl.uniform2f(u.uAxes, geo.A, geo.B);
            gl.uniform1f(u.uRoll, geo.roll);
            // 换句时轨道上的点快转一段再慢下来，轨道亮一下
            const change = index >= 0 ? Math.exp(-since * 3) : 0;
            gl.uniform1f(u.uSpin, s.reducedMotion ? 0 : t * 0.12 + 0.8 * (Math.max(index, 0) + 1 - change));
            gl.uniform1f(u.uChange, s.reducedMotion ? 0 : change);
            gl.uniform1f(u.uAxis, s.axisLine ? 1 : 0);
            gl.uniform1f(u.uGlow, glow);
            if (Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets) {
                if (lastOnsets >= 0 && frame.isPlaying) beatTime = t;
                lastOnsets = audio.onsets;
            }
            const energy = clamp(((audio.energy || 0) - 0.55) * 2.2 * s.audioReactivity, 0, 1);
            chorus += (energy - chorus) * 0.08;
            gl.uniform1f(u.uBeat, !s.reducedMotion && t >= beatTime ? Math.exp(-(t - beatTime) * 4) * Math.min(1, s.audioReactivity) : 0);
            gl.uniform1f(u.uChorus, s.reducedMotion ? 0 : chorus);
            gl.uniform1f(u.uTime, s.reducedMotion ? 0 : t);
            gl.uniform1f(u.uNebula, s.nebula);
            gl.uniform1f(u.uLight, colours.light ? 1 : 0);
            gl.uniform3fv(u.uField, colours.field);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            const grainStep = s.reducedMotion ? 0 : Math.floor(t * 6) % 64;
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            const fadeIn = index >= 0 ? smooth(-0.1, 0.35, since) : smooth(0, 0.8, t);
            const hasPrev = Boolean(prev?.line);
            const prevCount = hasPrev ? place(prev.line, t, geo, 1 - smooth(0, FADE, since), 0, true, s.reducedMotion ? 0 : chorusPrev, prevBufA, prevBufB) : 0;
            const curCount = place(slot.line, t, geo, fadeIn, 0, false, s.reducedMotion ? 0 : chorusNow, bufA, bufB);
            stats.glyphs = curCount;
            const drawText = () => {
                gl.bindVertexArray(vao);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                if (hasPrev) drawGlyphs(prev, prevCount, chorusPrev, s.waitingOpacity, prevBufA, prevBufB);
                drawGlyphs(slot, curCount, chorusNow, s.waitingOpacity, bufA, bufB);
                gl.disable(gl.BLEND);
            };
            // 泛光的种子：字也在小图上画一遍（透明底），和画面合起来取亮部
            const strength = colours.light ? 0 : BLOOM * (1 + glow * 0.5 + chorusNow * 0.6);
            let bloomTex = null;
            if (strength > 0) {
                over.bind(Math.max(1, low[0] >> 2), Math.max(1, low[1] >> 2));
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                drawText();
                bloomTex = bloom.run(scene, over, KNEE, 2);
            }
            bloom.present(scene, bloomTex, canvas.width, canvas.height, { bloom: strength, grain: s.grain, grainStep });
            drawText();
            stats.draws += 1;
            scheduleNext(index);
        };

        const updateOverlay = (frame, s = settings()) => {
            const next = `回环 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const text = s.showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latestFrame = frame;
            if (!colours) readColours();
            const s = settings();
            ensureLines(frame);
            updateOverlay(frame, s);
            if (!glState || lostContext || !Runtime.programsReady(glState.gl, redraw)) return;
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
            initialized: Boolean(glState), lines: sung.length, index: stats.index, glyphs: stats.glyphs,
            builds: stats.builds, buildMs: stats.buildMs, draws: stats.draws, buffer: `${canvas.width}x${canvas.height}`
        });

        const onLost = (event) => { event.preventDefault(); lostContext = true; Runtime.cancelPrograms(glState?.gl); };
        const onRestored = () => { try { glState = createGl(canvas); lostContext = false; redraw(); } catch (error) { console.error(error); } };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            cancelIdle();
            if (glState) {
                const { gl } = glState;
                Runtime.cancelPrograms(gl);
                glState.slots.forEach((slot) => gl.deleteTexture(slot.atlas));
                gl.deleteProgram(glState.field.program);
                gl.deleteProgram(glState.glyph.program);
                glState.scene.dispose();
                glState.over.dispose();
                glState.bloom.dispose();
                gl.deleteVertexArray(glState.vao);
                Runtime.releaseWebGLContext(gl);
            }
            glState = null;
            atlas.width = atlas.height = 0;
        });

        resize();
        return mode;
    };

    global.MusicStageOrbitManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ arcLayout, singingPosition, arcAt, project, lineIndexAt, ellipseTable, thetaAlong, TABLE })
    });
})(window);
