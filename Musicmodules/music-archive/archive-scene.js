/*
 * 曲目档案阵列的 3D 场景：一排排立着的档案卡，选中的那张抬起，同一列跟着起伏。
 * 只画视野里的 9 列 × 32 行，卡片用实例化网格一次画完，滚到哪里就把这一池卡片
 * 重新摆到哪里（阵列在两个方向循环），所以曲库有几千首也只有这 288 张卡。
 *
 * 依赖全局 THREE（vendor/three.min.js）。不读播放器状态，由 archive-view.js 驱动。
 *
 * 着色与几何按 Rhine-Music-Database（MIT，Copyright (c) 2026 LBEILC）的源码改写，
 * 许可证全文和逐项对照见 Musicmodules/README.md「其他第三方参考与许可证」。
 */
(function (global) {
    'use strict';

    const LANES_HALF = 4;          // 视野里左右各 4 列
    const ROWS_BEFORE = 16;        // 选中行前后共 32 行
    const ROWS_AFTER = 16;
    const POOL = (LANES_HALF * 2 + 1) * (ROWS_BEFORE + ROWS_AFTER);
    const COLUMN_SPACING = 5.2;
    const ROW_SPACING = 0.62;
    const CARD_W = 5, CARD_H = 3.7, CARD_D = 0.34;
    const BASE_Y = -4.6;
    const DIST = 140;
    const AIM = Object.freeze([-1.091, -0.045, 0.481]);
    const YAW = 59 * Math.PI / 180;
    const ELEV = 19 * Math.PI / 180;

    /*
     * 画质档位，和歌词舞台的三档对齐：帧率上限、阴影、抗锯齿、像素比上限。
     * 静止（2 秒没有操作、相机停稳）后只剩待机起伏和正在播放的轻跳，三档都降到 12 帧；
     * 像素比最高 1.5（高分屏上 2 倍像素要多画 78% 的像素，卡片边缘看不出区别）。
     */
    const IDLE_AFTER = 2000;
    const TIERS = Object.freeze({
        'energy-saving': Object.freeze({ fps: 30, idleFps: 12, shadows: false, shadowSize: 0, antialias: false, maxDpr: 1 }),
        standard: Object.freeze({ fps: 60, idleFps: 12, shadows: true, shadowSize: 1024, antialias: true, maxDpr: 1.5 }),
        ultimate: Object.freeze({ fps: 0, idleFps: 12, shadows: true, shadowSize: 2048, antialias: true, maxDpr: 1.5 })
    });
    const tierOf = (quality) => TIERS[quality] || TIERS.standard;

    /*
     * 两套主题的整体外观，数值照参考播放器：底色、远处淡进去的雾色、色调映射的曝光、雾的起止（相对镜头距离）。
     * 雾色按原样当作线性值用（参考实现就是这么混的）；底色是纸色（#eae5e1 / #11181b）按各自曝光反算回
     * 色调映射前的值，取出卡片、镜头抬高露出背景时，背景正好是页面的纸色。
     * tag / tagInk / tagRing 是取出卡片时卡面说明文字用的。
     */
    const LIGHTING = Object.freeze({
        light: { bg: [1.7461, 1.4294, 1.231], fog: [0.918, 0.898, 0.882], exposure: 0.76, theme: 0, fogNear: 5, fogFar: 25, sticker: ['#faf8f4', 'rgba(38,40,40,.86)', 'rgba(70,66,60,.22)'], tag: '#ece6dc', tagInk: 'rgba(52,54,54,.78)', tagRing: 'rgba(60,55,48,.55)', etch: 'rgba(110,104,96,.6)', etchHi: 'rgba(255,253,249,.85)', mat: ['#ffffff', 0.5], fit: ['#cfc4b6', '#67625d'] },
        dark: { bg: [0.017, 0.0237, 0.0269], fog: [0.06, 0.075, 0.08], exposure: 0.98, theme: 1, fogNear: 1, fogFar: 16, sticker: ['#3a4448', 'rgba(228,231,224,.84)', 'rgba(220,226,222,.18)'], tag: '#2c363b', tagInk: 'rgba(224,227,220,.75)', tagRing: 'rgba(220,226,222,.45)', etch: 'rgba(214,220,218,.3)', etchHi: 'rgba(0,0,0,.35)', mat: ['#c9cfcf', 0.18], fit: ['#85765a', '#9aa0a1'] }
    });

    /* ACES 色调映射曲线部分的反函数：给定映射后的值，求映射前的值（和 three 的 ACESFilmicToneMapping 同一组系数） */
    const rrtInverse = (y) => {
        y = Math.min(0.995, Math.max(0, y));
        const qa = 1 - 0.983729 * y, qb = 0.0245786 - 0.4329510 * y, qc = -(0.000090537 + 0.238081 * y);
        return (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
    };
    /* 六个朝向（+x +y +z -x -y -z）各自正中的底色亮度，浅色六个在前、深色六个在后；着色器里给倒角混色用 */
    const toLinear = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    const radianceOf = (c) => c.map((v) => rrtInverse(toLinear(v)) * 0.6 / 1.02);
    const FACE_CENTERS = (() => {
        const side = [0.9275, 0.9075, 0.8675], top = [0.965, 0.95, 0.925], wide = [0.78, 0.695, 0.58];
        const nSide = [0.285, 0.295, 0.295], nTop = [0.36, 0.37, 0.37], nWide = [0.2, 0.211, 0.214];
        return [side, top, wide, side, side, wide, nSide, nTop, nWide, nSide, nSide, nWide].map(radianceOf);
    })();

    /*
     * 卡盒着色不用实时灯光。参考播放器把卡盒的明暗离线烘成贴图：端面乳白、宽面从下往上由暖棕过渡到
     * 象牙白、四边一圈提亮，再加选中卡里五个暖光点照到自己和周围几排卡的光。这里按同一组公式
     * 直接在着色器里算，省掉贴图。颜色先给「最终显示出来的 sRGB 值」，再反算回色调映射前的亮度，
     * 所以屏幕上看到的就是这里写的颜色（浅色主题的曝光 0.76 再统一压一点）。
     * 局部坐标：原点在卡底边中点，宽 5、高 3.7，面板正面 z = 0.206。
     */
    const CARD_VERT = `
#include <common>
#include <fog_pars_vertex>
uniform mat4 uGlowInv;
varying vec3 vLocal;
varying vec3 vObjN;
varying vec3 vEmit;
varying vec3 vEmitN;
varying vec3 vWorld;
varying vec3 vWorldN;
varying vec2 vState;
void main() {
    mat4 m = modelMatrix;
#ifdef USE_INSTANCING
    m = m * instanceMatrix;
#endif
    vec4 world = m * vec4(position, 1.0);
    vec3 wn = normalize(mat3(m) * normal);
    vLocal = position;
    vObjN = normal;
    vEmit = (uGlowInv * world).xyz;
    vEmitN = mat3(uGlowInv) * wn;
    vWorld = world.xyz;
    vWorldN = wn;
#ifdef USE_INSTANCING_COLOR
    vState = instanceColor.rg;
#else
    vState = vec2(0.0);
#endif
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`;
    const CARD_FRAG = `
#include <common>
#include <fog_pars_fragment>
// 取出端详用象牙白方案（B）；去掉这一行就是照参考的玻璃 + 暖棕内衬（A）
#define HERO_IVORY
uniform float uLightOn;
uniform float uHero;
uniform float uQuality;   // 选中卡的装配件显现进度 smooth(lift / 0.4)
uniform float uSeeThrough;
uniform vec3 uCenter[12];
varying vec3 vLocal;
varying vec3 vObjN;
varying vec3 vEmit;
varying vec3 vEmitN;
varying vec3 vWorld;
varying vec3 vWorldN;
varying vec2 vState;
const vec3 WARM = vec3(1.0, 0.72, 0.38);
float toLinear(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
// 目标显示值 → 色调映射前的亮度（只反算 ACES 的曲线部分，和参考实现的烘焙一致，按曝光 1.02 算）
vec3 radiance(vec3 c) {
    vec3 y = min(vec3(toLinear(c.r), toLinear(c.g), toLinear(c.b)), 0.995);
    vec3 qa = 1.0 - 0.983729 * y, qb = 0.0245786 - 0.4329510 * y, qc = -(0.000090537 + 0.238081 * y);
    return (-qb + sqrt(qb * qb - 4.0 * qa * qc)) / (2.0 * qa) * (0.6 / 1.02);
}
// 0 +x、1 +y、2 +z、3 -x、4 -y、5 -z
int faceOf(vec3 d) {
    vec3 a = abs(d);
    if (a.x > a.z) return a.x > a.y ? (d.x > 0.0 ? 0 : 3) : (d.y > 0.0 ? 1 : 4);
    return a.z > a.y ? (d.z > 0.0 ? 2 : 5) : (d.y > 0.0 ? 1 : 4);
}
vec3 faceAxis(int f) {
    return f == 0 ? vec3(1.0, 0.0, 0.0) : f == 1 ? vec3(0.0, 1.0, 0.0) : f == 2 ? vec3(0.0, 0.0, 1.0)
        : f == 3 ? vec3(-1.0, 0.0, 0.0) : f == 4 ? vec3(0.0, -1.0, 0.0) : vec3(0.0, 0.0, -1.0);
}
vec2 surfaceUv(int face, vec3 p) {
    vec2 uv = vec2((p.x + 2.5) / 5.0, p.y / 3.7);
    if (face == 0 || face == 3) uv.x = (p.z + 0.25) / 0.5;
    else if (face == 1 || face == 4) uv.y = (p.z + 0.25) / 0.5;
    return clamp(uv, 0.0, 1.0);
}
// rgb：这一面的底色（亮度）；a：选中时左侧那条柔光的强度
vec4 faceSample(int face, vec2 uv, float dark) {
    float x = uv.x * 5.0 - 2.5, y = uv.y * 3.7;
    if (face == 0 || face == 3) x = face == 0 ? 2.5 : -2.5;
    else if (face == 1 || face == 4) y = face == 1 ? 3.7 : 0.0;
    float border = exp(-min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) / 0.025);
    vec3 day;
    if (face == 2 || face == 5) day = mix(vec3(0.70, 0.60, 0.46) + uv.y * vec3(0.16, 0.19, 0.24), vec3(0.94, 0.91, 0.85), border * 0.65);
    else if (face == 1) day = vec3(0.965, 0.95, 0.925);
    else day = vec3(0.90, 0.875, 0.825) + uv.y * vec3(0.055, 0.065, 0.085);
    // 深色不照搬参考的青灰：中性石墨灰，宽面下深上浅，端面和顶面亮一档，四边一圈细亮边
    vec3 night;
    if (face == 2 || face == 5) night = mix(vec3(0.165, 0.175, 0.178) + uv.y * vec3(0.07, 0.072, 0.072), vec3(0.33, 0.34, 0.34), border * 0.6);
    else if (face == 1) night = vec3(0.36, 0.37, 0.37);
    else night = vec3(0.27, 0.28, 0.28) + uv.y * vec3(0.03, 0.03, 0.03);
    float band = smoothstep(0.08, 0.5, y) * (1.0 - smoothstep(3.25, 3.67, y));
    float glow = (0.55 * exp(-abs(x + 2.22) / 0.48) + 0.05) * band;
    vec3 c = dark <= 0.0 ? radiance(day) : dark >= 1.0 ? radiance(night) : mix(radiance(day), radiance(night), dark);
    return vec4(c, glow);
}
// 倒角的朝向：按法线在三个面之间混色，再加一处很窄的柔和高光（左上前方）
vec4 normalResponse(vec3 n, float dark) {
    vec3 a = abs(n);
    int fx = n.x >= 0.0 ? 0 : 3, fy = n.y >= 0.0 ? 1 : 4, fz = n.z >= 0.0 ? 2 : 5;
    int primary = a.x >= a.y && a.x >= a.z ? fx : a.y >= a.z ? fy : fz;
    vec3 w = n * n;
    w /= w.x + w.y + w.z;
    vec3 blended = w.x * mix(uCenter[fx], uCenter[fx + 6], dark) + w.y * mix(uCenter[fy], uCenter[fy + 6], dark)
        + w.z * mix(uCenter[fz], uCenter[fz + 6], dark);
    vec3 response = min(vec3(4.0), blended / max(mix(uCenter[primary], uCenter[primary + 6], dark), vec3(0.0001)));
    float highlight = 0.18 * pow(max(0.0, dot(n, vec3(-0.48, 0.80, 0.36))), 24.0) * mix(1.0, 0.25, dark);
    return vec4(response, highlight);
}
// 选中卡里的五个暖光点（左侧竖排三个强、中间两个弱）照到 p 点（选中卡局部坐标）的光，
// 每隔一张卡衰减 22%，朝背光一侧也透一些（磨砂散射）。参考实现里这是一张低分辨率的三维光场贴图。
vec3 field(vec3 p, vec3 n, float soft) {
    if (abs(p.x) > 9.0 || abs(p.z) > 7.0) return vec3(0.0);
    p.y = clamp(p.y, -0.4, 4.8);
    float layer = pow(0.78, min(max(abs(p.z) / 0.62 - 0.35, 0.0), 12.0));
    // 先估上限：五个光点合起来最多 3.44 / (0.30 + 到光点包围盒距离²)，乘层衰减后小于 0.0015 就不算了
    // （0.0015 的线性亮度经过色调映射不到 1/255，画面上看不出差别）。阵列远处的大部分像素在这里就退出了
    vec3 q = p - clamp(p, vec3(-2.22, 0.60, 0.08), vec3(1.10, 2.75, 0.08));
    if (3.44 * layer / (0.30 + soft + dot(q, q)) < 0.0015) return vec3(0.0);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 5; i++) {
        vec3 e = i == 0 ? vec3(-2.22, 0.60, 0.08) : i == 1 ? vec3(-2.22, 1.65, 0.08) : i == 2 ? vec3(-2.22, 2.75, 0.08)
            : i == 3 ? vec3(-0.9, 1.8, 0.08) : vec3(1.1, 1.8, 0.08);
        vec3 o = e - p;
        float d2 = dot(o, o);
        float c = dot(n, o * inversesqrt(max(d2, 0.04)));
        float scatter = 0.82 * (0.26 + 0.74 * pow(max(-c, 0.0), 0.65));
        float power = i < 3 ? 0.85 : 0.28;
        float I = power * (max(c, 0.0) * 0.28 + scatter) / (0.30 + soft + d2);
        sum += I * WARM * exp(-vec3(0.32, 0.90, 2.5) * 0.12 / max(abs(c), 0.22));
    }
    return min(sum * layer, vec3(4.0));
}
void main() {
    float dark = vState.x;
    float selected = step(0.5, vState.y);
    float hero = selected * uHero;          // 取出端详的进度，只在选中卡上非零
    vec3 n = normalize(vObjN);
    int face = faceOf(n);
    vec4 baked = faceSample(face, surfaceUv(face, vLocal), dark);
    // 托盘正面只在面板的圆孔、缺口里露出来：浏览时按顶面亮色画（孔看着是浅色小圆点），
    // 端详时换成固定螺丝的钛灰（参考 RhiScene.cpp musicDraws：Titanium_Fasteners 固定成暗色）
    bool socket = face == 2 && vLocal.z < 0.2;
    if (socket) {
        // 选中卡（参考播放器的焦点卡）多画两样装配件，随抬起 smooth(lift/0.4) 显现：
        // 左上缺口里的索引片 Index_Inlay（浅色基色 0.67/0.53/0.40，深色 #c6a36b），圆孔里的螺钉 Titanium_Fasteners。
        // 颜色按参考截图里这两处的实际亮度取（索引片灰褐、螺钉略暗于卡面），不搬原版贴图。
        float q = selected * uQuality;
        bool notch = vLocal.x < -2.0 && vLocal.y > 3.4;
        // 缺口按参考截图：里面和面板同一个色调（看下去是一道浅浅的凹槽，只靠边上的暗线显形），不是一块更白的方片
        vec3 browse = notch ? faceSample(2, surfaceUv(2, vec3(vLocal.xy, 0.206)), dark).rgb * 0.97 : mix(uCenter[1], uCenter[7], dark);
        vec3 part = notch ? radiance(mix(vec3(0.78, 0.73, 0.66), vec3(0.62, 0.52, 0.36), dark))
                          : radiance(mix(vec3(0.70, 0.67, 0.63), vec3(0.58, 0.61, 0.62), dark));
        // 孔和缺口底下是空心盒子（参考 Ivory_Edges 只是一圈外框）：靠面板边的那一侧落进阴影，
        // 浏览时看着是一个有深度的凹孔（左侧一道暗月牙），不是平贴的白点
        float pit;
        if (notch) {
            pit = max(smoothstep(0.06, 0.0, vLocal.x + 2.284), smoothstep(0.05, 0.0, vLocal.y - 3.476) * 0.7);
        } else {
            vec2 hc = vLocal.x > 0.0 ? vec2(2.389, 3.526) : vec2(-2.335, 0.14);
            vec2 d = (vLocal.xy - hc) / 0.082;
            pit = smoothstep(0.35, 0.95, length(d)) * smoothstep(0.15, -0.65, d.x + 0.35 * d.y);
        }
        browse *= 1.0 - mix(0.5, 0.35, dark) * pit;
        baked.rgb = mix(browse, part, q);
        // 端详：螺钉换成钛灰（象牙白卡面上暗色螺钉像个黑洞），索引片保留
        if (!notch) baked.rgb = mix(baked.rgb, radiance(mix(vec3(0.43, 0.45, 0.46), vec3(0.55, 0.57, 0.58), dark)), hero);
    }
    vec4 nr = normalResponse(n, dark);
    // 深色里暖光只留三分之一（不照搬参考：参考深色下光场和浅色同强度，大片琥珀色压在暗底上显脏）
    float glowGain = mix(1.0, 0.32, dark);
    // 端详时镜头贴得很近：光场放散，免得卡面上一颗颗光斑（参考是低分辨率三维光场三线性采样，本身就是糊的）
    float soft = hero * 0.45;
    vec3 fieldHere = field(vEmit, faceAxis(faceOf(normalize(vEmitN))), soft) * uLightOn * glowGain;
    // opticalSurface.frag 壳体分支：baked * normalResponse + highlight + 光场 + 选中自发光
    vec3 shell = baked.rgb * nr.rgb + nr.a + fieldHere + WARM * baked.a * selected * uLightOn * glowGain;
    vec3 color = shell;
    bool plateFront = face == 2 && vLocal.z > 0.15;
    if (selected > 0.5 && plateFront) {
        // 选中卡的面板半透，透出后面贴着光源的内衬板（Optical_Diffuser，z = -0.038）。
        // 浏览：面板不透明度 0.62（RhiScene.cpp musicDraws opacity），透 38%；
        vec4 inner = faceSample(2, surfaceUv(2, vec3(vLocal.xy, -0.038)), dark);
        vec3 innerColor = inner.rgb + (field(vec3(vEmit.xy, -0.038), vec3(0.0, 0.0, 1.0), soft) + WARM * inner.a) * uLightOn * glowGain;
        color = mix(shell, innerColor, uSeeThrough);
#ifdef HERO_IVORY
        // 端详（方案 B）：内衬换成干净的象牙白，光场只留一成五
        vec3 ivory = mix(uCenter[1], uCenter[7], dark) * mix(0.97, 0.8, dark);
        vec3 heroFront = ivory + (innerColor - inner.rgb) * 0.15;
#else
        // 端详（方案 A，照参考）：面板走玻璃分支（opticalSurface.frag flags 3 + hero），
        // 几乎全透，看到的是内衬板；玻璃只加掠射角反光、轮廓亮边和一条主光高光
        vec3 heroFront = innerColor;
#endif
        color = mix(color, heroFront, hero);
    } else if (selected > 0.5 && !socket) {
        // 端详时托盘（Ivory_Edges，flags 4 + hero）：材料色 + 光场，不用烘焙图集
        vec3 edgeColor = mix(vec3(0.941, 0.906, 0.875), vec3(0.408, 0.447, 0.467) * 0.75, dark) + fieldHere;
        color = mix(color, edgeColor, hero);
    }
    if (hero > 0.0) {
        // keyLight()：正上方略偏前一束主光，漫反射 0.55 + 0.45·N·L，高光指数 mix(20, 90, gloss)
        vec3 wn = normalize(vWorldN);
        const vec3 KEY = vec3(0.0, 0.5477, 0.8367);
        vec3 v = normalize(cameraPosition - vWorld);
        float ndl = max(dot(wn, KEY), 0.0);
        float gloss = plateFront ? 0.6 : 0.35;
        float spec = pow(max(dot(wn, normalize(KEY + v)), 0.0), mix(20.0, 90.0, gloss)) * mix(0.18, 0.85, gloss);
        vec3 lit = color * (0.55 + 0.45 * ndl) + spec;
        if (plateFront) {
            // 玻璃层：clearGlass = tint·0.06 + 雾色·(0.04 + 0.95·fresnel) + 高光 + sheen·0.85 + 亮边·0.55，
            // 不透明度 0.06 + rim·1.3 + fresnel·0.35
            float ndv = clamp(dot(wn, v), 0.0, 1.0);
            float fresnel = pow(1.0 - ndv, 5.0);
            float rim = pow(1.0 - ndv, 2.2);
            vec3 tint = mix(vec3(1.0, 0.992, 0.98), vec3(0.384, 0.42, 0.439), dark);
            float gspec = pow(max(dot(wn, normalize(KEY + v)), 0.0), 90.0) * 1.2;
            vec3 glass = tint * 0.06 + fogColor * (0.04 + 0.95 * fresnel) + gspec + mix(tint, vec3(1.0), 0.3) * (0.10 + 1.15 * rim) * 0.85
                + smoothstep(0.55, 0.98, rim) * 0.55;
            lit = mix(lit, glass, clamp(0.06 + rim * 1.3 + fresnel * 0.35, 0.0, 0.92));
        }
        color = mix(color, lit, hero);
    }
    gl_FragColor = vec4(color, 1.0);
#include <fog_fragment>
}`;

    const smoother = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * t * (10 + t * (-15 + 6 * t)); };
    const bell = (x, w) => Math.exp(-0.5 * (x / w) * (x / w));

    /* 选中行两侧的隆起：越靠近选中行越高，远处略低于基线。形状固定，不随时间变。 */
    const settlingWave = (d) => {
        const age = 1.51 - Math.abs(d) * 0.065;
        const env = Math.max(-0.42, 2.15 - 0.17 * (Math.sqrt(d * d + 1) - 1));
        const rise = smoother(age / 0.62);
        const ring = age > 0 ? Math.sin(age * 5.1) * Math.exp(-age * 1.3) : 0;
        return env * (rise + 0.18 * ring * smoother(age / 0.16));
    };
    const columnStrength = (lane, focus) => 0.25 + 0.75 * bell(lane - focus, 0.55);
    const idleWave = (row, lane, t) => 0.075 * Math.sin(t * Math.PI * 2 / 8 + row * 0.3 - lane * 0.45)
        + 0.027 * Math.sin(t * Math.PI * 2 / 13 - row * 0.17 + lane * 0.3);
    /* 换选中时从新位置荡开的一圈波纹 */
    const selectionWave = (distance, age) => {
        if (age < 0 || age > 3.2) return 0;
        return 0.8 * smoother(age / 0.2) * Math.exp(-age * 1.15) * Math.cos((distance - age * 8) * 0.58) * bell(distance - age * 8, 3.4);
    };
    /* 临界阻尼弹簧，rate 越大越快到位 */
    const damp = (s, target, rate, dt) => {
        const d = s.v - target;
        const imp = s.vel + rate * d;
        const dec = Math.exp(-rate * dt);
        s.v = target + (d + imp * dt) * dec;
        s.vel = (s.vel - rate * imp * dt) * dec;
    };

    /* 圆角盒：细分的盒子把每个顶点推到圆角上。法线顺带算好，不需要 uv。 */
    const roundedBox = (THREE, width, height, depth, segments, radius) => {
        const seg = segments * 2 + 1;
        radius = Math.min(width / 2, height / 2, depth / 2, radius);
        const box = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg).toNonIndexed();
        box.deleteAttribute('uv');
        const pos = box.attributes.position.array;
        const nor = box.attributes.normal.array;
        const half = [width / 2 - radius, height / 2 - radius, depth / 2 - radius];
        const halfSeg = 0.5 / seg;
        for (let i = 0; i < pos.length; i += 3) {
            let nx = pos[i], ny = pos[i + 1], nz = pos[i + 2];
            const sx = Math.sign(nx), sy = Math.sign(ny), sz = Math.sign(nz);
            nx -= sx * halfSeg; ny -= sy * halfSeg; nz -= sz * halfSeg;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len; ny /= len; nz /= len;
            pos[i] = half[0] * sx + nx * radius;
            pos[i + 1] = half[1] * sy + ny * radius;
            pos[i + 2] = half[2] * sz + nz * radius;
            nor[i] = nx; nor[i + 1] = ny; nor[i + 2] = nz;
        }
        box.attributes.position.needsUpdate = true;
        box.attributes.normal.needsUpdate = true;
        return box;
    };

    /*
     * 卡盒模型，尺寸照参考播放器的卡盒量的：后面一个象牙色托盘，正面压一块 0.032 厚的面板，
     * 面板四边一道小倒角，左上角缺一个口（插索引卡的槽），右上和左下各开一个小圆孔（固定扣的位置）。
     * 两块合成一个几何体，只有位置和法线。
     */
    const cassetteGeometry = (THREE) => {
        const tray = roundedBox(THREE, 4.986, 3.68, 0.32, 3, 0.022);   // 外框圆角照参考模型量的 0.018–0.035，取 0.022
        tray.translate(0, 1.85, 0.03);            // z -0.13 … 0.19
        const B = 0.012;                          // 面板倒角
        const shape = new THREE.Shape();
        const x0 = -2.5 + B, x1 = 2.5 - B, y0 = B, y1 = 3.7 - B;
        const n0 = -2.284 - B, n1 = -2.034 + B, ny = 3.475 - B;
        shape.moveTo(x0, y0); shape.lineTo(x1, y0); shape.lineTo(x1, y1); shape.lineTo(n1, y1);
        shape.lineTo(n1, ny); shape.lineTo(n0, ny); shape.lineTo(n0, y1); shape.lineTo(x0, y1); shape.closePath();
        for (const [cx, cy] of [[2.389, 3.526], [-2.335, 0.14]]) {
            const hole = new THREE.Path();
            hole.absarc(cx, cy, 0.082 + B, 0, Math.PI * 2, true);
            shape.holes.push(hole);
        }
        const plate = new THREE.ExtrudeGeometry(shape, { depth: 0.032 - 2 * B, bevelEnabled: true, bevelThickness: B, bevelSize: B, bevelSegments: 2, curveSegments: 14 });
        plate.translate(0, 0, 0.174 + B);         // z 0.174 … 0.206
        const parts = [tray, plate.index ? plate.toNonIndexed() : plate];
        const count = parts.reduce((n, g) => n + g.attributes.position.count, 0);
        const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
        let o = 0;
        for (const g of parts) {
            pos.set(g.attributes.position.array, o);
            nor.set(g.attributes.normal.array, o);
            o += g.attributes.position.count * 3;
        }
        tray.dispose(); plate.dispose(); parts[1].dispose();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        return geo;
    };

    /*
     * 选中那张卡才装的小零件（参考播放器同样只给焦点卡画）：左上缺口里一块平嵌的索引片，
     * 两个圆孔里各一颗平头十字螺钉（头半径 0.06、四周一圈小圆边，比孔小一圈露出孔沿）。
     * 合成一个几何体一次画完；顶点色分三组（索引片 / 螺钉 / 十字槽），换主题时只改颜色。
     */
    const FITTING_INLAY = 0, FITTING_SCREW = 1, FITTING_SLOT = 2;
    const fittingsGeometry = (THREE) => {
        const parts = [];
        const inlay = new THREE.BoxGeometry(0.25, 0.224, 0.004);
        inlay.translate(-2.159, 3.588, 0.204);
        parts.push([inlay, FITTING_INLAY]);
        const profile = [[0, 0.206], [0.05, 0.206], [0.056, 0.204], [0.059, 0.199], [0.06, 0.192], [0.058, 0.186]]
            .map(([r, z]) => new THREE.Vector2(r, z));
        for (const [cx, cy] of [[2.389, 3.526], [-2.335, 0.14]]) {
            const head = new THREE.LatheGeometry(profile, 28);
            head.rotateX(Math.PI / 2);         // 车床绕 y 轴转，转到朝 +z
            head.translate(cx, cy, 0);
            // 轮廓按半径从里往外排，车床算出的法线朝里（所以面也是反的、要双面画）：法线翻回朝外，端详打主光时钉帽才是亮面
            const hn = head.attributes.normal.array;
            for (let i = 0; i < hn.length; i++) hn[i] = -hn[i];
            parts.push([head, FITTING_SCREW]);
            for (const a of [0.23, 0.23 + Math.PI / 2]) {   // 十字槽：两条细长的深色条，略斜
                const slot = new THREE.PlaneGeometry(0.07, 0.013);
                slot.rotateZ(a);
                slot.translate(cx, cy, 0.2065);
                parts.push([slot, FITTING_SLOT]);
            }
        }
        const flat = parts.map(([g, k]) => [g.index ? g.toNonIndexed() : g, k]);
        const count = flat.reduce((n, [g]) => n + g.attributes.position.count, 0);
        const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), kind = new Uint8Array(count);
        let o = 0;
        for (const [g, k] of flat) {
            pos.set(g.attributes.position.array, o * 3);
            nrm.set(g.attributes.normal.array, o * 3);
            kind.fill(k, o, o + g.attributes.position.count);
            o += g.attributes.position.count;
        }
        for (const [g] of parts) g.dispose();
        for (const [g] of flat) g.dispose();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));   // 端详时打主光要用
        // 十字槽是凹进去的，主光高光照不进槽底：槽不加高光，否则和钉帽一样亮、十字就没了
        geo.setAttribute('keySpec', new THREE.BufferAttribute(Float32Array.from(kind, (k) => (k === FITTING_SLOT ? 0 : 1)), 1));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
        geo.userData.kind = kind;
        return geo;
    };

    const create = (options) => {
        const THREE = global.THREE;
        if (!THREE) throw new Error('THREE is not loaded');
        const host = options.host;
        const tier = tierOf(options.quality);
        const reducedMotion = () => Boolean(options.reducedMotion && options.reducedMotion());

        const canvas = document.createElement('canvas');
        canvas.className = 'archive-canvas';
        host.appendChild(canvas);

        /*
         * 走后期时场景画进自己的 4 倍多重采样渲染目标，画布上只画一个铺满全屏的三角形：
         * 画布本身的多重采样和深度、模板缓冲完全用不上，每帧却要多解析一遍整屏（2880×1620 时约 150 MB 显存带宽）。
         * 这时画布不开抗锯齿、不要深度和模板，画面逐像素不变。
         */
        const wantPost = tier.antialias;
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: tier.antialias && !wantPost, depth: !wantPost, stencil: false, powerPreference: 'high-performance', alpha: false });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;

        const scene = new THREE.Scene();

        const camera = new THREE.PerspectiveCamera(3, 16 / 9, 5, 300);

        /*
         * 卡盒：一个实例化网格画完全部卡。每张卡的实例颜色只当参数用：r = 主题（0 浅 1 深，翻主题时逐张过渡），
         * g = 是否选中（选中卡里的暖光、半透面板只在这张上算）。
         */
        const glowUniforms = {
            uGlowInv: { value: new THREE.Matrix4() },
            uLightOn: { value: 0 },
            uHero: { value: 0 },
            uQuality: { value: 0 },
            uSeeThrough: { value: 0.38 },
            uCenter: { value: FACE_CENTERS.map((c) => new THREE.Vector3(c[0], c[1], c[2])) }
        };
        const FRONT = 0.206;           // 面板正面的 z
        const cassetteMat = new THREE.ShaderMaterial({
            uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
            vertexShader: CARD_VERT,
            fragmentShader: CARD_FRAG,
            fog: true
        });
        Object.assign(cassetteMat.uniforms, glowUniforms);
        const cards = new THREE.InstancedMesh(cassetteGeometry(THREE), cassetteMat, POOL);
        cards.frustumCulled = false;
        scene.add(cards);
        const layers = [cards];
        const TINTED = [[cards, 'card']];
        const tint = { card: new THREE.Color(1, 0, 0) };
        const paintUniform = () => {
            for (const [mesh, part] of TINTED) {
                for (let i = 0; i < POOL; i++) mesh.setColorAt(i, tint[part]);
                mesh.instanceColor.needsUpdate = true;
            }
        };
        paintUniform();
        let accentIdx = -1;
        const accentTmp = new THREE.Color();

        // ---- 卡面标题：只给相机附近几列看得见的卡贴，贴片池循环复用 ----
        // 每张贴片一块小画布，换卡时只重画这一块；一帧最多重画几块，避免滚动时卡顿。
        // 字色压得比 HUD 淡，免得和浮在上面的说明文字抢
        const LABEL_LANES = tier.shadows ? 1 : 0;          // 省电档只贴当前这一列
        const LABEL_ROWS = [-8, 10];
        const LABEL_POOL = (LABEL_LANES * 2 + 1) * (LABEL_ROWS[1] - LABEL_ROWS[0] + 1);
        const LABEL_DRAWS_PER_FRAME = 8;
        const LABEL_W = 3.5, LABEL_H = 0.26;
        const labelGeo = new THREE.PlaneGeometry(LABEL_W, LABEL_H);
        labelGeo.translate(0.2, 3.5, FRONT + 0.004);
        const labelInk = { ink: 'rgba(224,227,220,.86)', muted: 'rgba(166,176,177,.8)' };
        const labels = Array.from({ length: LABEL_POOL }, () => {
            const c = document.createElement('canvas');
            c.width = 768; c.height = 58;
            const tex = new THREE.CanvasTexture(c);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
            const mesh = new THREE.Mesh(labelGeo, mat);
            mesh.visible = false;
            scene.add(mesh);
            return { mesh, canvas: c, tex, mat, cell: null, drawn: null };
        });
        let labelFor = null;                 // (lane, row) => { key, title, code } | null
        let labelEpoch = 0;                  // 主题、字体、数据变了就加一，旧的画面全部作废
        const drawLabel = (L, info) => {
            const g = L.canvas.getContext('2d');
            g.clearRect(0, 0, 768, 58);
            g.textBaseline = 'middle';
            g.font = '500 20px ' + fontStack;
            const code = String(info.code || '');
            const codeW = code ? g.measureText(code).width : 0;
            g.fillStyle = labelInk.muted;
            if (code) g.fillText(code, 768 - 8 - codeW, 30);
            g.font = '500 30px ' + fontStack;
            g.fillStyle = labelInk.ink;
            let title = String(info.title || '');
            const room = 768 - 16 - codeW - 36;
            if (g.measureText(title).width > room) {
                // 二分找能放下的最长前缀（原来逐字删，长标题一张要量上百次，翻列时一帧画 8 张会卡一下）
                let lo = 1, hi = title.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi + 1) >> 1;
                    if (g.measureText(title.slice(0, mid) + '…').width > room) hi = mid - 1; else lo = mid;
                }
                title = title.slice(0, lo) + '…';
            }
            g.fillText(title, 8, 31);
            L.tex.needsUpdate = true;
            L.drawn = info.key + '#' + labelEpoch;
        };
        const labelWanted = new Map();
        const wantSpare = [];   // 贴标题的格子信息每帧复用，不每帧新建对象
        // 'lane:row' 键字符串缓存：每帧要查几百次，不再每次拼新字符串
        const cellKeys = new Map();
        const cellKey = (lane, row) => {
            const n = lane * 100003 + row;
            let k = cellKeys.get(n);
            if (k === undefined) {
                if (cellKeys.size > 8192) cellKeys.clear();
                k = lane + ':' + row;
                cellKeys.set(n, k);
            }
            return k;
        };
        let labelsPending = false;
        const placeLabels = () => {
            labelsPending = false;
            const free = [];
            for (const L of labels) {
                if (L.cell && labelWanted.has(L.cell)) continue;
                L.cell = null;
                free.push(L);
            }
            const taken = new Set();
            for (const L of labels) if (L.cell) taken.add(L.cell);
            for (const [cell] of labelWanted) {
                if (taken.has(cell)) continue;
                // 优先用之前就画着这张卡的贴片，省得重画
                const want = labelWanted.get(cell).info;
                let k = free.findIndex((L) => L.drawn === want.key + '#' + labelEpoch);
                if (k === -1) k = free.length - 1;
                if (k < 0) break;
                const L = free.splice(k, 1)[0];
                L.cell = cell;
            }
            let draws = 0;
            for (const L of labels) {
                const w = L.cell ? labelWanted.get(L.cell) : null;
                if (!w || (detailOn && artMat.map && L.cell === target.lane + ':' + target.row)) { L.mesh.visible = false; continue; }
                if (L.drawn !== w.info.key + '#' + labelEpoch) {
                    if (draws >= LABEL_DRAWS_PER_FRAME) { L.mesh.visible = false; labelsPending = true; continue; }
                    drawLabel(L, w.info);
                    draws++;
                }
                L.mesh.position.set(w.x, w.y, w.z);
                L.mesh.rotation.set(w.tilt || 0, w.turn || 0, 0);   // 跟卡一起顺着坡度微倾、一起转回正面
                if (underMask(w)) { L.mesh.visible = false; continue; }
                // 当前列的标题实一些，左右邻列淡一些（邻列离相机更近，不压低会比当前列还显眼）
                L.mat.opacity = w.li === 0 ? 1 : 0.5;
                L.mesh.visible = true;
            }
        };
        // 目录和歌词投在画面上的区域：落在里面的卡不贴标题，免得和浮字叠在一起
        let labelMasks = [];
        const projA = new THREE.Vector3(), projB = new THREE.Vector3();
        const underMask = (w) => {
            if (!labelMasks.length) return false;
            projA.set(w.x + 0.2 - LABEL_W / 2, w.y + 3.5, w.z + FRONT).project(camera);
            projB.set(w.x + 0.2 + LABEL_W / 2, w.y + 3.5, w.z + FRONT).project(camera);
            const x0 = (Math.min(projA.x, projB.x) + 1) / 2 * W, x1 = (Math.max(projA.x, projB.x) + 1) / 2 * W;
            const y0 = (1 - Math.max(projA.y, projB.y)) / 2 * H, y1 = (1 - Math.min(projA.y, projB.y)) / 2 * H;
            return labelMasks.some((r) => x1 > r.left && x0 < r.right && y1 > r.top && y0 < r.bottom);
        };
        /* rects：画布像素坐标 { left, top, right, bottom } */
        const setLabelMask = (rects) => { labelMasks = Array.isArray(rects) ? rects : []; invalidate(); };
        const setLabeler = (fn) => { labelFor = typeof fn === 'function' ? fn : null; labelEpoch++; invalidate(); };
        const refreshLabels = () => { labelEpoch++; invalidate(); };

        let lighting = LIGHTING.dark;
        let fontStack = 'sans-serif';

        /*
         * 主题翻色。整体（背景、雾、地面、灯光）用 0.85 秒缓动过去；卡片按到原点的距离依次翻，
         * 每张 0.58 秒，最远的晚 0.6 秒起步，1.18 秒后全部落定。中途再换一次，每张卡从它当时的颜色接着翻。
         */
        const GLOBAL_DUR = 0.85, CARD_DUR = 0.58, MAX_DELAY = 0.6, WAVE_TOTAL = 1.18;
        const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
        const nowS = () => performance.now() / 1000;
        const rawColor = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
        const lookOf = (l) => ({ bg: rawColor(l.bg), fog: rawColor(l.fog), exposure: l.exposure, theme: l.theme, fogNear: l.fogNear, fogFar: l.fogFar });
        const COLOR_KEYS = ['bg', 'fog'];
        const NUM_KEYS = ['exposure', 'theme', 'fogNear', 'fogFar'];
        /*
         * 后期，照参考播放器的最后一步：场景先画进一张半浮点的离屏图，再用一个全屏三角形做
         * 「离焦柔化 → 色调映射 → 纸色压边」。柔化是 3×3 二项核（中心 4、上下左右 2、对角 1），
         * 采样半径随离画面 52% 高度那条带的距离从 1 像素加到 7 像素，越往上下越虚；
         * 之后上半截、下沿、四角往纸色压（浅色、深色各一套比例）。取出详情时柔化和压边都收掉。
         * 省电档不走这一步，直接画到屏幕。
         */
        const post = { on: wantPost && typeof renderer.setRenderTarget === 'function', rt: null, scene: null, camera: null, mat: null, exposure: { value: 1 } };
        if (post.on) {
            post.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
            post.mat = new THREE.ShaderMaterial({
                uniforms: {
                    tColor: { value: post.rt.texture },
                    uTexel: { value: new THREE.Vector2(1, 1) },
                    uTheme: { value: 1 },
                    uShade: { value: 0 },
                    uScale: { value: new THREE.Vector2(1, 1) }
                },
                vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
                fragmentShader: `uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uTheme;
uniform float uShade;
uniform vec2 uScale;
varying vec2 vUv;
// 镜头快速移动时场景只画到渲染目标左下角一块（见 render 处），这里按比例取样，并且不读出那块范围
vec3 tap(vec2 uv) { return texture2D(tColor, clamp(uv, vec2(0.0), uScale - 0.5 * uTexel)).rgb; }
void main() {
    float down = 1.0 - vUv.y;   // 从画面顶边往下量
    float keep = 1.0 - uShade;
    float away = smoothstep(0.05, 0.48, abs(down - 0.52));
    vec2 t = uTexel * (1.0 + 6.0 * away * keep) * uScale;
    vec2 uv = vUv * uScale;
    vec3 c = tap(uv) * 4.0;
    c += 2.0 * (tap(uv + vec2(t.x, 0.0)) + tap(uv - vec2(t.x, 0.0)) + tap(uv + vec2(0.0, t.y)) + tap(uv - vec2(0.0, t.y)));
    c += tap(uv + t) + tap(uv - t) + tap(uv + vec2(t.x, -t.y)) + tap(uv + vec2(-t.x, t.y));
    gl_FragColor = vec4(c / 16.0, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    vec3 paper = mix(vec3(222.0, 219.0, 215.0), vec3(17.0, 24.0, 27.0), uTheme) / 255.0;
    float top = mix(0.72 * (1.0 - clamp(down / 0.5, 0.0, 1.0)), 0.82 * (1.0 - clamp(down / 0.36, 0.0, 1.0)), uTheme);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(vec3(224.0, 221.0, 216.0) / 255.0, paper, uTheme), top * keep);
    float bottom = mix(0.72, 0.84, uTheme) * (1.0 - clamp((1.0 - down) / 0.35, 0.0, 1.0));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, paper, bottom * keep);
    vec2 p = vec2(vUv.x, down);
    float radius = length((p - vec2(0.42, 0.47)) / vec2(0.58, 0.53)) * 0.70711;
    float darkRadius = length((p - vec2(0.48, 0.48)) / vec2(0.58, 0.53)) * 0.70711;
    float edge = mix(0.19 * clamp((radius - 0.32) / 0.53, 0.0, 1.0), 0.48 * clamp((darkRadius - 0.42) / 0.48, 0.0, 1.0), uTheme);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, paper, edge * keep);
}`,
                depthTest: false,
                depthWrite: false
            });
            const tri = new THREE.BufferGeometry();
            tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
            tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
            const quad = new THREE.Mesh(tri, post.mat);
            quad.frustumCulled = false;
            post.scene = new THREE.Scene();
            post.scene.add(quad);
            post.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            host.classList.add('archive-post-atmos');   // 压边在着色器里做了，页面上那层 CSS 渐变就不用再盖
        }
        /* 封面贴片不该被色调映射改色：走后期时先把颜色反算回去，映射之后正好是原图 */
        const keepColors = (mat) => {
            if (!post.on) return mat;
            mat.onBeforeCompile = (sh) => {
                sh.uniforms.uKeepExposure = post.exposure;
                sh.fragmentShader = `uniform float uKeepExposure;
vec3 archiveUntone(vec3 y) {
    // ACES 输入、输出矩阵的逆，事先算好（逐像素调用 inverse() 太贵）
    const mat3 IN_INV = mat3(vec3(1.764741, -0.147028, -0.036337), vec3(-0.675778, 1.160252, -0.162436), vec3(-0.088963, -0.013224, 1.198773));
    const mat3 OUT_INV = mat3(vec3(0.643038, 0.059269, 0.005962), vec3(0.311187, 0.931436, 0.063929), vec3(0.045775, 0.009295, 0.930118));
    vec3 v = clamp(OUT_INV * y, 0.0, 0.995);
    vec3 qa = 1.0 - 0.983729 * v, qb = 0.0245786 - 0.4329510 * v, qc = -(0.000090537 + 0.238081 * v);
    v = (-qb + sqrt(qb * qb - 4.0 * qa * qc)) / (2.0 * qa);
    return max(IN_INV * v, 0.0) * 0.6 / max(uKeepExposure, 0.01);
}
` + sh.fragmentShader.replace('#include <colorspace_fragment>', 'gl_FragColor.rgb = archiveUntone(gl_FragColor.rgb);\n#include <colorspace_fragment>');
            };
            mat.customProgramCacheKey = () => 'archive-keep-colors';
            return mat;
        };
        for (const L of labels) keepColors(L.mat);
        const look = lookOf(LIGHTING.dark);
        let lookFade = null;   // { from, to, t0 }
        const fogBase = { near: look.fogNear, far: look.fogFar };
        scene.background = look.bg.clone();
        scene.fog = new THREE.Fog(look.fog.clone(), DIST + look.fogNear, DIST + look.fogFar);
        const applyLook = (L) => {
            scene.background.copy(L.bg);
            scene.fog.color.copy(L.fog);
            fogBase.near = L.fogNear; fogBase.far = L.fogFar;
            scene.fog.near = DIST + L.fogNear; scene.fog.far = DIST + L.fogFar;
            post.exposure.value = L.exposure;
            if (post.on) post.mat.uniforms.uTheme.value = L.theme;
            renderer.toneMappingExposure = L.exposure;
        };
        const lookAt = (fade, T) => {
            const k = smooth((T - fade.t0) / GLOBAL_DUR);
            const out = {};
            for (const c of COLOR_KEYS) out[c] = fade.from[c].clone().lerp(fade.to[c], k);
            for (const n of NUM_KEYS) out[n] = fade.from[n] + (fade.to[n] - fade.from[n]) * k;
            return out;
        };

        let waves = [];        // { to: { card }, lane, row, t0 }
        const waveK = (w, lane, row, T) => smooth((T - w.t0 - Math.min(MAX_DELAY, Math.abs(row - w.row) * 0.034 + Math.abs(lane - w.lane) * 0.11)) / CARD_DUR);
        const colorAt = (part, lane, row, T, k, out) => {
            if (k < 0) return out.copy(tint[part]);
            const w = waves[k];
            const s = waveK(w, lane, row, T);
            if (s >= 1) return out.copy(w.to[part]);
            colorAt(part, lane, row, w.t0, k - 1, out);   // 这一波开始时它是什么颜色
            return s > 0 ? out.lerp(w.to[part], s) : out;
        };
        const themeBusy = () => Boolean(lookFade || waves.length);

        /* colors: { font, labelInk, labelMuted }（卡盒和底色按参考播放器固定，不读颜色令牌），dark: 是否深色，wave: { lane, row } 翻色原点 */
        const setTheme = (colors, dark, { wave = null } = {}) => {
            lighting = dark ? LIGHTING.dark : LIGHTING.light;
            fontStack = colors.font || fontStack;
            labelInk.ink = colors.labelInk || (dark ? 'rgba(224,227,220,.62)' : 'rgba(8,10,8,.58)');
            labelInk.muted = colors.labelMuted || (dark ? 'rgba(166,176,177,.55)' : 'rgba(98,95,88,.6)');
            labelEpoch++;
            drawEtch();
            paintFittings();
            stickerKey = '';
            frameMat.color.set(lighting.mat[0]);
            const to = lookOf(lighting);
            accentIdx = -1;
            const parts = { card: new THREE.Color(lighting.theme, 0, 0) };
            const T = nowS();
            if (!wave || reducedMotion()) {
                lookFade = null; waves = [];
                Object.assign(look, to);
                applyLook(look);
                Object.assign(tint, parts);
                paintUniform();
            } else {
                const from = lookFade ? lookAt(lookFade, T) : { ...look };
                lookFade = { from, to, t0: T };
                if (waves.length >= 3) { Object.assign(tint, waves[0].to); waves.shift(); }
                waves.push({ to: parts, lane: wave.lane, row: wave.row, t0: T });
            }
            invalidate();
        };
        const stepTheme = (T) => {
            if (lookFade) {
                if (T - lookFade.t0 >= GLOBAL_DUR) { Object.assign(look, lookFade.to); lookFade = null; applyLook(look); }
                else applyLook(lookAt(lookFade, T));
            }
            if (waves.length && T - waves[waves.length - 1].t0 >= WAVE_TOTAL) {
                Object.assign(tint, waves[waves.length - 1].to);
                waves = [];
                paintUniform();
                accentIdx = -1;   // 整片重刷会把选中卡的记号也刷掉，下一帧重新打上
            }
        };

        // ---- 取出卡的卡面：封面与标题随卡片升起淡入 ----
        const COVER_SIZE = 2.9;
        const coverGeo = new THREE.PlaneGeometry(COVER_SIZE, COVER_SIZE);
        coverGeo.translate(0.78, 1.86, FRONT + 0.008);
        const frameGeo = new THREE.PlaneGeometry(COVER_SIZE + 0.12, COVER_SIZE + 0.12);
        frameGeo.translate(0.78, 1.86, FRONT + 0.005);
        const coverMat = (extra) => keepColors(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, ...extra }));
        const frameMat = coverMat({ color: '#ffffff' });
        const artMat = coverMat({ polygonOffset: false });   // 浏览时也会隐约露出，深度偏移在掠射角下会透过前排卡
        const captionGeo = new THREE.PlaneGeometry(1.54, 2.32);
        captionGeo.translate(-1.54, 1.36, FRONT + 0.009);
        const captionCanvas = document.createElement('canvas');
        captionCanvas.width = 256;
        captionCanvas.height = 386;
        const captionMap = new THREE.CanvasTexture(captionCanvas);
        captionMap.colorSpace = THREE.SRGBColorSpace;
        const captionMat = coverMat({ map: captionMap });
        const captionMesh = new THREE.Mesh(captionGeo, captionMat);
        const coverGroup = new THREE.Group();
        const frameMesh = new THREE.Mesh(frameGeo, frameMat);
        const artMesh = new THREE.Mesh(coverGeo, artMat);
        artMesh.renderOrder = 2;
        /*
         * 取出时卡面上的细线：沿四边一圈带折角的走线、角上的十字定位标、右下一个小地球和短横、
         * 底边一行小字。颜色很淡，只在卡片升起后和封面一起淡入；换主题时重画。
         */
        const etchGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
        etchGeo.translate(0, CARD_H / 2, FRONT + 0.003);
        const etchCanvas = document.createElement('canvas');
        etchCanvas.width = 1280;
        etchCanvas.height = 948;
        const etchMap = new THREE.CanvasTexture(etchCanvas);
        etchMap.colorSpace = THREE.SRGBColorSpace;
        etchMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        const etchMat = coverMat({ map: etchMap });
        const etchMesh = new THREE.Mesh(etchGeo, etchMat);
        const drawEtch = () => {
            const g = etchCanvas.getContext('2d');
            const S = 256;
            const X = (u) => (u + CARD_W / 2) * S, Y = (v) => (CARD_H - v) * S;
            g.clearRect(0, 0, etchCanvas.width, etchCanvas.height);
            g.strokeStyle = lighting.etch;
            g.fillStyle = lighting.etch;
            g.lineWidth = 2.6;
            g.lineJoin = 'round';
            // 压在面板下面的刻线（参考播放器 Case_Engraving + Highlight）：一道细槽配一道错开的亮边，看着是压出来的，不是印上去的
            const trace = (pts) => { g.beginPath(); pts.forEach(([u, v], i) => (i ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v)))); g.stroke(); };
            const path = (pts) => {
                g.save(); g.translate(1.6, 1.6); g.strokeStyle = lighting.etchHi; trace(pts); g.restore();
                trace(pts);
            };
            const arc = (u, v, r, a0, a1) => {
                for (const [dx, col] of [[1.6, lighting.etchHi], [0, lighting.etch]]) {
                    g.strokeStyle = col; g.beginPath(); g.arc(X(u) + dx, Y(v) + dx, r * S, a0, a1); g.stroke();
                }
            };
            // 外圈：四角斜切，上边和左边各有一处台阶
            path([[-2.2, 3.5], [-0.4, 3.5], [-0.3, 3.4], [0.5, 3.4], [0.6, 3.5], [2.22, 3.5]]);   // 右上角让出螺钉外的环
            path([[2.32, 3.35], [2.32, 0.32], [2.2, 0.2], [-2.2, 0.2], [-2.32, 0.32], [-2.32, 1.2], [-2.24, 1.28], [-2.24, 2.6], [-2.32, 2.68], [-2.32, 3.38], [-2.2, 3.5]]);
            // 内圈的半截走线：从左上沿左边下来，转到底边
            path([[-1.98, 3.26], [-2.1, 3.14], [-2.1, 0.55], [-1.95, 0.4], [-1.2, 0.4]]);
            path([[1.6, 3.26], [2.1, 3.26], [2.1, 2.7]]);
            // 两颗螺钉外面各绕一圈压出来的环（右上两道，左下一道 C 形）
            arc(2.389, 3.526, 0.115, 0, Math.PI * 2);
            arc(2.389, 3.526, 0.15, Math.PI * 0.55, Math.PI * 1.95);
            arc(-2.335, 0.14, 0.125, -Math.PI * 0.45, Math.PI * 0.95);
            g.strokeStyle = lighting.etch;
            const cross = (u, v) => { path([[u - 0.07, v], [u + 0.07, v]]); path([[u, v - 0.07], [u, v + 0.07]]); };
            cross(2.05, 3.05); cross(-1.95, 3.05); cross(2.05, 0.42); cross(-1.75, 0.6);
            // 右下的小地球和短横
            g.strokeStyle = lighting.etch;
            const cx = X(1.98), cy = Y(0.92), r = 0.15 * S;
            g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
            g.beginPath(); g.ellipse(cx, cy, r * 0.45, r, 0, 0, Math.PI * 2); g.stroke();
            path([[1.83, 0.92], [2.13, 0.92]]);
            g.fillRect(X(1.9), Y(0.62), 0.16 * S, 4);
            g.font = `400 26px ${fontStack}`;
            g.textBaseline = 'alphabetic';
            g.fillText('MUSIC ARCHIVE', X(-1.15), Y(0.27));
            // 左边台阶里一行竖排模压字（位置照参考播放器 Moulded_Lettering，字是我们自己的）：从上往下读，压出来的凹字配亮边
            // 字高、长度照原版比例（原版这行字高约 0.1、长约 1.2），收进我们台阶里两道刻线中间（x −2.24…−2.1，y 1.28…2.6）
            g.save();
            g.translate(X(-2.17), Y(2.49));
            g.rotate(Math.PI / 2);
            const word = 'MUSIC ARCHIVE', capPx = 0.082 * S, longPx = 1.1 * S;
            g.textBaseline = 'alphabetic';
            if ('letterSpacing' in g) g.letterSpacing = '0px';
            g.font = `500 40px ${fontStack}`;
            const cap40 = g.measureText('M').actualBoundingBoxAscent || 29;
            let size = 40 * capPx / cap40;
            g.font = `500 ${size.toFixed(1)}px ${fontStack}`;
            let w = g.measureText(word).width;
            if (w > longPx) { size *= longPx / w; g.font = `500 ${size.toFixed(1)}px ${fontStack}`; w = longPx; }
            if ('letterSpacing' in g) g.letterSpacing = `${((longPx - w) / (word.length - 1)).toFixed(1)}px`;
            const base = size * cap40 / 40 / 2;   // 字身竖直居中在两道线中间
            g.fillStyle = lighting.etchHi; g.fillText(word, 1.6, base - 1.6);
            g.fillStyle = lighting.etch; g.fillText(word, 0, base);
            g.restore();
            etchMap.needsUpdate = true;
        };
        coverGroup.add(frameMesh, artMesh, captionMesh);
        coverGroup.visible = false;
        scene.add(coverGroup);
        // 选中卡的索引片和螺钉（颜色按参考播放器截图里和卡面的明暗比例取）
        const fittingsGeo = fittingsGeometry(THREE);
        const fittingsMat = keepColors(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide }));
        {
            // 取出端详时参考播放器给索引片、螺钉也打同一束主光（keyLight，gloss 0.15）；浏览时不打
            const untone = fittingsMat.onBeforeCompile;
            fittingsMat.onBeforeCompile = (sh, r) => {
                sh.uniforms.uKeyHero = glowUniforms.uHero;
                sh.uniforms.uFitQ = glowUniforms.uQuality;
                sh.vertexShader = 'attribute float keySpec;\nvarying float vKeySpec;\nvarying vec3 vKeyN;\nvarying vec3 vKeyW;\n' + sh.vertexShader.replace('#include <project_vertex>',
                    '#include <project_vertex>\nvKeySpec = keySpec;\nvKeyW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvKeyN = mat3(modelMatrix) * normal;');
                sh.fragmentShader = 'uniform float uKeyHero;\nuniform float uFitQ;\nvarying float vKeySpec;\nvarying vec3 vKeyN;\nvarying vec3 vKeyW;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `// 参考播放器非实例部件（flags 2）按 quality 做抖动显现：卡抬起时一点点长出来，不是一下子贴上
    if (uFitQ <= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;
    if (uKeyHero > 0.0) {
        vec3 kn = normalize(vKeyN);
        const vec3 KEY = vec3(0.0, 0.5477, 0.8367);
        vec3 kv = normalize(cameraPosition - vKeyW);
        float kspec = pow(max(dot(kn, normalize(KEY + kv)), 0.0), 30.5) * 0.2805 * vKeySpec;
        outgoingLight = mix(outgoingLight, outgoingLight * (0.55 + 0.45 * max(dot(kn, KEY), 0.0)) + kspec, uKeyHero);
    }
    #include <opaque_fragment>`);
                if (untone) untone(sh, r);
            };
            fittingsMat.customProgramCacheKey = () => 'archive-fittings-key';
        }
        const fittings = new THREE.Mesh(fittingsGeo, fittingsMat);
        fittings.matrixAutoUpdate = false;
        fittings.visible = false;
        scene.add(fittings);
        // 刻线跟着选中卡一直在（参考播放器只给焦点卡画 Case_Engraving，浏览时也画），不再等取出才淡入
        fittings.add(etchMesh);
        // 左上角的小标签纸（参考播放器焦点卡 Printed_Label 那块：x −1.855…−0.865，y 2.835…3.245）：曲名、歌手、一行小字，比卡面白一档
        const stickerGeo = new THREE.PlaneGeometry(0.99, 0.41);
        stickerGeo.translate(-1.36, 3.04, FRONT + 0.006);
        const stickerCanvas = document.createElement('canvas');
        stickerCanvas.width = 512;
        stickerCanvas.height = 212;
        const stickerMap = new THREE.CanvasTexture(stickerCanvas);
        stickerMap.colorSpace = THREE.SRGBColorSpace;
        stickerMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        // 标签纸本身就离面板 0.006，不再做深度偏移：偏移在掠射角下很大，浏览时会透过前一排卡露出来
        const stickerMat = coverMat({ map: stickerMap, polygonOffset: false });
        const stickerMesh = new THREE.Mesh(stickerGeo, stickerMat);
        stickerMesh.visible = false;
        fittings.add(stickerMesh);
        // 标签纸跟着当前选中格走（浏览时也在），曲名取卡面标题；歌手只有取出过这首、知道是谁时才写，否则写时长
        let stickerInfo = { title: '', artist: '' };
        let coverInfo = { title: '', artist: '' };
        let stickerKey = '';
        let coverPath = '', targetPath = '';   // 封面是哪首（setCover 的 key 第一项是路径）、选中格是哪首（标题 key 是「序号:路径」）
        const syncSticker = () => {
            const at = `${target.lane},${target.row},${labelEpoch},${coverPath}`;
            if (at === stickerKey) return;
            stickerKey = at;
            const info = labelFor ? labelFor(target.lane, target.row) : null;
            targetPath = info && typeof info.key === 'string' ? info.key.slice(info.key.indexOf(':') + 1) : '';
            const no = info && typeof info.key === 'string' ? parseInt(info.key, 10) : NaN;   // 标题 key 是「序号:路径」，序号从 0 起
            stickerInfo = info ? { title: info.title || '', artist: (coverPath && coverPath === targetPath && coverInfo.artist) || info.code || '', no: Number.isFinite(no) ? String(no + 1).padStart(3, '0') : '' } : { title: '', artist: '' };
            drawSticker();
        };
        const drawSticker = () => {
            const title = String(stickerInfo.title || '').trim(), artist = String(stickerInfo.artist || '').trim();
            stickerMesh.visible = Boolean(title);
            if (!title) return;
            const g = stickerCanvas.getContext('2d'), Wc = stickerCanvas.width, Hc = stickerCanvas.height;
            const [paper, ink, rule] = lighting.sticker;
            g.clearRect(0, 0, Wc, Hc);
            g.fillStyle = paper;
            g.fillRect(0, 0, Wc, Hc);
            g.strokeStyle = rule; g.lineWidth = 2;
            g.strokeRect(1, 1, Wc - 2, Hc - 2);
            const fit = (text, maxW) => {
                if (g.measureText(text).width <= maxW) return text;
                let t = text;
                while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
                return t + '…';
            };
            g.fillStyle = ink;
            g.textBaseline = 'alphabetic';
            if ('letterSpacing' in g) g.letterSpacing = '0px';
            g.font = `650 34px ${fontStack}`;
            g.fillText(fit(title, Wc - 48), 24, 60);
            g.font = `500 25px ${fontStack}`;
            g.fillText(fit(artist, Wc - 48), 24, 104);
            g.fillStyle = rule;
            g.fillRect(24, 132, Wc - 48, 2);
            g.fillStyle = ink;
            g.globalAlpha = 0.62;
            g.font = `500 18px ${fontStack}`;
            if ('letterSpacing' in g) g.letterSpacing = '3px';
            // 照参考那行「档案 / 编号」：编号是这首在目录里的序号
            g.fillText(stickerInfo.no ? `MUSIC ARCHIVE / ${stickerInfo.no}` : 'MUSIC ARCHIVE', 24, 176);
            g.globalAlpha = 1;
            if ('letterSpacing' in g) g.letterSpacing = '0px';
            stickerMap.needsUpdate = true;
        };
        const paintFittings = () => {
            const c = [new THREE.Color(lighting.fit[0]), new THREE.Color(lighting.fit[1]), new THREE.Color(lighting.fit[1]).multiplyScalar(0.62)];
            const kind = fittingsGeo.userData.kind, col = fittingsGeo.attributes.color.array;
            for (let i = 0; i < kind.length; i++) { const k = c[kind[i]]; col[i * 3] = k.r; col[i * 3 + 1] = k.g; col[i * 3 + 2] = k.b; }
            fittingsGeo.attributes.color.needsUpdate = true;
        };
        paintFittings();
        let coverKey = '';
        const freeCoverTex = () => {
            artMat.map?.dispose();
            artMat.map = null;
        };
        const drawCaption = ({ title = '', artist = '', format = '', bitrate = '' }, showTitle) => {
            const ctx = captionCanvas.getContext('2d');
            ctx.clearRect(0, 0, captionCanvas.width, captionCanvas.height);
            ctx.fillStyle = lighting.tagInk;
            const fields = [['格式', format], ['码率', bitrate]].filter(([, value]) => value);
            fields.forEach(([label, value], i) => {
                const x = 6 + i * 126;
                ctx.font = `400 20px ${fontStack}`;
                ctx.globalAlpha = 0.78;
                ctx.fillText(label, x, 46);
                ctx.globalAlpha = 1;
                ctx.font = `600 23px ${fontStack}`;
                ctx.fillText(value, x, 79, fields.length === 1 ? 244 : 116);
            });
            if (showTitle) {
                ctx.font = `700 33px ${fontStack}`;
                const letters = Array.from(title.trim());
                for (let y = 166; y <= 250 && letters.length; y += 42) {
                    let end = 1;
                    while (end < letters.length && ctx.measureText(letters.slice(0, end + 1).join('')).width <= 236) end++;
                    if (end < letters.length && y < 250) {
                        const space = letters.slice(0, end).lastIndexOf(' ');
                        if (space > 0) end = space + 1;
                    }
                    const line = letters.splice(0, end).join('').trim();
                    ctx.fillText(line + (y === 250 && letters.length ? '…' : ''), 6, y, 244);
                }
                ctx.font = `500 22px ${fontStack}`;
                ctx.fillText(artist, 6, 306, 244);
            }
            captionMap.needsUpdate = true;
        };
        // 还没有可用的封面时，用写有曲名和歌手的卡面。
        const setCover = (key, source, info = {}) => {
            if (key === coverKey && artMat.map) return;
            coverKey = key;
            freeCoverTex();
            coverInfo = { title: info.title || '', artist: info.artist || '' };
            try { coverPath = String(JSON.parse(key)[0] || ''); } catch (e) { coverPath = ''; }
            captionMesh.visible = Boolean(source || info.format || info.bitrate);
            if (captionMesh.visible) drawCaption(info, Boolean(source));
            let img = source;
            if (!img) {
                const c = document.createElement('canvas');
                c.width = c.height = 512;
                const g = c.getContext('2d');
                g.fillStyle = lighting.tag;
                g.fillRect(0, 0, 512, 512);
                g.strokeStyle = lighting.tagRing;
                g.lineWidth = 2;
                g.strokeRect(28, 28, 456, 456);
                g.fillStyle = lighting.tagInk;
                g.textBaseline = 'alphabetic';
                const fit = (text, size, weight, maxW) => {
                    g.font = `${weight} ${size}px ${fontStack}`;
                    let s = String(text || '');
                    if (g.measureText(s).width <= maxW) return s;
                    while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
                    return s + '…';
                };
                g.fillText(fit(info.title || '', 46, 700, 420), 52, 400);
                g.fillText(fit(info.artist || '', 24, 500, 420), 52, 446);
                g.beginPath(); g.arc(436, 82, 14, 0, Math.PI * 2); g.stroke();
                img = c;
            }
            const texture = img instanceof HTMLCanvasElement ? new THREE.CanvasTexture(img) : new THREE.Texture(img);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
            texture.needsUpdate = true;
            artMat.map = texture;
            artMat.needsUpdate = true;
            invalidate();
        };

        // ---- 状态 ----
        const target = { lane: 0, row: 0 };
        const camLane = { v: 0, vel: 0 }, camRow = { v: 0, vel: 0 }, shoulder = { v: 0, vel: 0 }, focus = { v: 0, vel: 0 }, lift = { v: 0.4, vel: 0 };
        // 第一次出现时整片档案从雾里沿行方向滑进来（参考播放器 m_reveal：按 2.8 跟到 1，entryZ = −28·(1 − reveal)，
        // 选中卡的抬起也乘 reveal）。减少动态时直接到位。
        let reveal = reducedMotion() ? 1 : 0;
        let liftGoal = 0.4;   // 选中卡抬起的高度；进播放页前会再抬高一些
        /*
         * 取出：选中卡从列里抬到 DETAIL_LIFT，镜头推近到它正面、把它放进目录与歌词之间，卡面上显出封面。
         * 镜头推近的进度直接由抬起高度算（卡升到哪，镜头推到哪），这样中途收回也不会两边脱节。
         */
        const DETAIL_LIFT = 4.05;
        const DETAIL_DIR = new THREE.Vector3(-0.277, 0.238, 0.931).normalize();
        let detailOn = false;
        let detailK = 0;               // 0 浏览 → 1 取出（镜头）
        const inspect = { v: 0, vel: 0, goal: 0 };   // 取出后拖动转卡（绕竖轴），松手转回正面
        const returning = new Map();   // 'lane:row' → { v, vel }，换选中时旧卡从当时的高度落回去，一格只留一份
        const pulses = [];
        const hoverLifts = new Map();
        let hovered = null;
        let playing = null;          // { lane, row } 正在播放那张卡（同列轻微跳动）
        let isPlaying = false;
        let idleGain = 0;
        let bounceGain = 1;            // 正在放的那一列轻跳的幅度，取出端详时收到 0
        let lastInput = performance.now();
        let lastPointer = 0;          // 鼠标移动带视差，也算没静止（但不打断待机起伏）
        let frames = 0;
        const pointer = { x: 0, y: 0 };      // 镜头视差用的指针位置
        const pointerAim = { x: 0, y: 0 };   // 指针实际在哪；取出端详时先记着，不动镜头
        const cellAt = new Int32Array(POOL * 2);
        const dummy = new THREE.Object3D();
        const view = new THREE.Vector3(-Math.sin(YAW) * Math.cos(ELEV), Math.sin(ELEV), Math.cos(YAW) * Math.cos(ELEV));
        const aim = new THREE.Vector3(AIM[0], AIM[1], AIM[2]);
        let W = 1, H = 1;
        let pxPerUnit = 200;           // 对焦处一个世界单位在屏幕上多少物理像素（判断「还看得出在动」用）
        let liftRate = 8;
        let dirty = true;
        const invalidate = () => { dirty = true; };

        let sized = '';
        const resize = (width, height) => {
            // 页面 class 一变视图就会重排一次，尺寸多半没变：这时不再重设画布宽高
            // （给 canvas.width 赋值，哪怕同一个数，也会让浏览器丢掉并重建整块绘图缓冲）
            const key = Math.max(1, width) + 'x' + Math.max(1, height) + '@' + Math.min(global.devicePixelRatio || 1, tier.maxDpr);
            if (key === sized) { invalidate(); return; }
            sized = key;
            W = Math.max(1, width); H = Math.max(1, height);
            renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, tier.maxDpr));
            renderer.setSize(W, H, false);
            if (post.on) {
                const dpr = renderer.getPixelRatio();
                const px = { x: Math.max(1, Math.floor(W * dpr)), y: Math.max(1, Math.floor(H * dpr)) };
                post.rt.setSize(px.x, px.y);
                post.px = px;
                post.mat.uniforms.uTexel.value.set(1 / px.x, 1 / px.y);
            }
            camera.aspect = W / H;
            // 高度方向固定看到 7.33 个单位；窗口比 16:9 窄时改为保宽度
            const span = Math.max(7.33, 7.33 * (16 / 9) / camera.aspect);
            camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(span / (2 * DIST)));
            camera.updateProjectionMatrix();
            invalidate();
        };

        const select = (lane, row, { pulse = true } = {}) => {
            if (lane === target.lane && row === target.row) return;
            if (pulse && !reducedMotion()) pulses.push({ lane, row, t: performance.now() / 1000 });
            // 旧卡从当时的高度落回去，不瞬间掉下（参考播放器 NativeScene::select：抬起高于 0.0001 就进归位队列）
            if (lift.v > 0.0001 && !reducedMotion()) returning.set(target.lane + ':' + target.row, { v: lift.v, vel: 0, rot: inspect.v, hold: detailOn, lane: target.lane, row: target.row });
            // 选回一张还在落的卡：从它当时的高度和角度接着走，不先掉到底再升起
            const back = returning.get(lane + ':' + row);
            returning.delete(lane + ':' + row);
            target.lane = lane; target.row = row;
            lift.v = back ? back.v : 0; lift.vel = 0;
            inspect.v = back ? back.rot || 0 : 0; inspect.vel = inspect.goal = 0;
            lastInput = performance.now();
            invalidate();
        };
        /*
         * 拖动整片档案：参考播放器 NativeSceneInput.cpp 的 moveArchive / dragProjection。
         * hold() 直接把镜头放在给定的（可带小数的）格坐标上，unhold() 交回弹簧，从当时的位置和速度接着走。
         * dragAxes() 给出选中卡中心附近「卡片整体移动一列 / 一行」在画布上对应的像素向量，外面据此把指针位移反解成格数。
         */
        let held = null;
        const hold = (lane, row, vl = 0, vr = 0) => {
            held = { lane, row, vl, vr };
            lastInput = performance.now();
            invalidate();
        };
        const unhold = () => { if (held) { held = null; invalidate(); } };
        const camAt = () => ({ lane: camLane.v, row: camRow.v });
        const dragAxes = () => {
            const c = new THREE.Vector3((target.lane - camLane.v) * COLUMN_SPACING, BASE_Y + 1.85, (target.row - camRow.v) * ROW_SPACING - 2.17);
            const px = (v) => { v.project(camera); return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H }; };
            const o = px(c.clone());
            const l = px(c.clone().add(new THREE.Vector3(COLUMN_SPACING, 0, 0)));
            const r = px(c.clone().add(new THREE.Vector3(0, 0, ROW_SPACING)));
            return { lane: { x: l.x - o.x, y: l.y - o.y }, row: { x: r.x - o.x, y: r.y - o.y } };
        };
        /* 不带动画直接跳到某格（第一次打开、数据重建） */
        const jump = (lane, row) => {
            held = null;
            target.lane = lane; target.row = row;
            camLane.v = focus.v = lane; camRow.v = shoulder.v = row;
            camLane.vel = camRow.vel = shoulder.vel = focus.vel = 0;
            lift.v = detailOn ? DETAIL_LIFT : liftGoal; lift.vel = 0;
            pulses.length = 0;
            returning.clear();
            snapCardAim = true;
            invalidate();
        };

        const targetPos = new THREE.Vector3();
        const glowMat4 = new THREE.Matrix4();
        const cardAim = new THREE.Vector3();
        let snapCardAim = true;
        let fitQ = 0;   // 选中卡的 quality = smooth(lift / 0.4)：倾斜收平、装配件和刻线显现都用它
        let pulseGain = 1;
        const camDir = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3(), detailAim = new THREE.Vector3(), camAim = new THREE.Vector3();
        const WORLD_UP = new THREE.Vector3(0, 1, 0);
        const lerp = (a, b, k) => a + (b - a) * k;
        /* 把卡片放进 HUD 留出的矩形，以宽高较紧的一边决定取景。 */
        let detailRoom = null;
        let targetRoom = null;
        const placeCamera = (reduced) => {
            const k = detailK;
            const aspect = W / H;
            const room = detailRoom || { left: 0, right: W, top: 0, bottom: H };
            const roomWidth = Math.max(1, room.right - room.left);
            const roomHeight = Math.max(1, room.bottom - room.top);
            const browseSpan = Math.max(7.33, 7.33 * (16 / 9) / aspect);
            const detailSpan = Math.max(6.8, CARD_W * 1.14 * H / roomWidth, CARD_H * 1.24 * H / roomHeight);
            const viewSpan = lerp(browseSpan, detailSpan, k);
            pxPerUnit = H * renderer.getPixelRatio() / viewSpan;
            const distance = lerp(DIST, 72, k);
            camDir.copy(view).lerp(DETAIL_DIR, k).normalize();
            camAim.copy(aim);
            if (k > 0) {
                camRight.crossVectors(WORLD_UP, camDir).normalize();
                camUp.crossVectors(camDir, camRight).normalize();
                const anchorX = (room.left + room.right) / (2 * W);
                const anchorY = (room.top + room.bottom) / (2 * H);
                const pixelScale = H / viewSpan;
                detailAim.copy(cardAim);
                detailAim.y += CARD_H / 2;
                detailAim.addScaledVector(camRight, (0.5 - anchorX) * W / pixelScale);
                detailAim.addScaledVector(camUp, (anchorY - 0.5) * H / pixelScale);
                camAim.lerp(detailAim, k);
            }
            camera.position.copy(camAim).addScaledVector(camDir, distance);
            if (!reduced) {
                // 参考播放器 NativeSceneCamera.cpp：横屏取出端详也保留整幅视差（指针那时已冻结，镜头不会跟着晃），
                // 只有竖屏才随推近消掉；原来按 0.25 收，推近途中镜头会自己漂一段
                const par = 0.12 * (aspect < 1 ? 1 - k : 1);
                camera.position.x += pointer.x * par; camera.position.y -= pointer.y * par;
            }
            camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(viewSpan / (2 * distance)));
            camera.updateProjectionMatrix();
            camera.lookAt(camAim);
            camera.updateMatrixWorld();
            scene.fog.near = distance + lerp(fogBase.near, -1, k);
            scene.fog.far = distance + lerp(fogBase.far, 12, k);
        };
        const placeCover = (targetVisible) => {
            const appear = targetVisible && artMat.map ? smooth((lift.v - 1.2) / 1.6) : 0;
            // 参考播放器浏览时选中卡的半透面板后面隐约透出唱片；我们透出封面，按面板透光 0.38 再打个折
            const through = targetVisible && artMat.map && coverPath && coverPath === targetPath ? 0.22 * fitQ : 0;
            const show = Math.max(appear, through) > 0.001;
            coverGroup.visible = show;
            if (!show) return;
            coverGroup.position.copy(targetPos);
            coverGroup.rotation.set(0, inspect.v, 0);
            frameMat.opacity = lighting.mat[1] * appear;
            artMat.opacity = Math.max(appear, through);
            captionMat.opacity = appear;
        };
        const setDetailRoom = (bounds) => {
            if (targetRoom && Object.keys(bounds).every((edge) => Math.abs(bounds[edge] - targetRoom[edge]) < 0.5)) return;
            targetRoom = bounds;
            detailRoom ??= { ...bounds };
            invalidate();
        };
        const setDetail = (on) => {
            on = Boolean(on);
            if (on === detailOn) return;
            detailOn = on;
            if (!on) inspect.goal = 0;
            lastInput = performance.now();
            invalidate();
        };
        /* 取出后拖动转卡：delta 是弧度；release 后转回正面 */
        const turn = (delta, release = false) => {
            if (!detailOn) return;
            if (release) inspect.goal = 0;
            else inspect.goal = Math.max(-0.8, Math.min(0.8, inspect.goal + delta));   // 参考播放器：±0.8 弧度
            invalidate();
        };
        /* 取出的卡在画面上的范围（画布像素），给 HUD 判断点没点在卡上 */
        const detailRect = () => {
            if (!detailOn) return null;
            const pts = [[-CARD_W / 2, 0], [CARD_W / 2, 0], [-CARD_W / 2, CARD_H], [CARD_W / 2, CARD_H]].map(([x, y]) => {
                projA.set(targetPos.x + x, targetPos.y + y, targetPos.z + CARD_D / 2).project(camera);
                return [(projA.x + 1) / 2 * W, (1 - projA.y) / 2 * H];
            });
            const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
            return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
        };

        /*
         * 着色器先在后台编译好再开始画（KHR_parallel_shader_compile）。卡盒着色器很长，Windows 上第一次编译
         * 能卡住界面几百毫秒；这里编译期间不画，打开音乐页时其余界面照常响应，第一帧出来时已经编好。
         * 取出时才用到的封面材质、卡面标题也一起预先编译（临时挂一张 1×1 的白图、临时显示），之后第一次取出不再卡一下。
         */
        let shadersReady = typeof renderer.compileAsync !== 'function';
        if (!shadersReady) {
            const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
            white.needsUpdate = true;
            const borrowMap = !artMat.map;
            if (borrowMap) { artMat.map = white; artMat.needsUpdate = true; }
            const shown = [coverGroup, fittings, labels[0]?.mesh].filter(Boolean);
            const was = shown.map((o) => o.visible);
            shown.forEach((o) => { o.visible = true; });
            const jobs = [renderer.compileAsync(scene, camera)];
            if (post.on) jobs.push(renderer.compileAsync(post.scene, post.camera));
            shown.forEach((o, i) => { o.visible = was[i]; });
            const done = () => {
                if (borrowMap && artMat.map === white) { artMat.map = null; artMat.needsUpdate = true; }
                white.dispose();
                shadersReady = true;
                invalidate();
            };
            Promise.all(jobs).then(done, done);
        }
        let lastStep = performance.now();
        /* 推进一帧。返回这帧是否还在动（给外面决定要不要降帧/停画）。 */
        const step = (now) => {
            if (!shadersReady) { lastStep = now; return { moving: true, idle: false, animated: true }; }
            const dt = Math.min((now - lastStep) / 1000, 0.05);
            lastStep = now;
            const T = now / 1000;
            const reduced = reducedMotion();
            let roomMoving = false;
            if (targetRoom) {
                const mix = reduced ? 1 : 1 - Math.exp(-dt * 10);
                for (const edge of Object.keys(targetRoom)) {
                    const to = targetRoom[edge];
                    if (Math.abs(detailRoom[edge] - to) < 0.5) detailRoom[edge] = to;
                    else {
                        detailRoom[edge] = lerp(detailRoom[edge], to, mix);
                        roomMoving = !reduced;
                    }
                }
            }
            const rate = reduced ? 9 : 3.7;
            if (held) {
                // 按住拖动或松手滑行时镜头位置由外面给（参考播放器 m_dragTrack / m_momentum）
                camLane.v = held.lane; camRow.v = held.row; camLane.vel = held.vl; camRow.vel = held.vr;
            } else {
                damp(camLane, target.lane, rate, dt);
                damp(camRow, target.row, rate, dt);
            }
            // 参考播放器 NativeSceneUpdate.cpp：肩部隆起 5、列聚焦 4，都比镜头（3.7）先到位一点
            damp(shoulder, target.row, reduced ? rate : 5, dt);
            damp(focus, target.lane, reduced ? rate : 4, dt);
            // 取出用慢一点的弹簧（约一秒到位），平时的选中抬起保持干脆
            liftRate = reduced ? 40 : detailOn || lift.v > 1 ? 4.2 : 8;
            if (reveal < 1) { reveal += (1 - reveal) * (reduced ? 1 : 1 - Math.exp(-dt * 2.8)); if (1 - reveal < 0.0005) reveal = 1; }
            // 放回时卡若还转着：先在原高度转回正面再落下（参考播放器 returnY：m_rotation 回到 0 之前 lift 不动）
            if (!detailOn && inspect.v !== 0 && lift.v > liftGoal) lift.vel = 0;
            else {
                // 浏览时旁边（同列 5 行内）还有一张转着、等着转正的旧卡，新卡先不升，免得两张卡在半空叠在一起（参考播放器同一规则）
                let aligning = false;
                for (const r of returning.values()) if (r.hold && r.rot && r.lane === target.lane && Math.abs(r.row - target.row) < 5) { aligning = true; break; }
                damp(lift, detailOn ? DETAIL_LIFT : aligning ? 0 : liftGoal * reveal, liftRate, dt);
            }   // 浏览时 8：比镜头（3.7）快一点先探出来，但不再「啪」地弹起
            for (const [k, r] of returning) {
                // 落回原位用与帧率无关的指数衰减（参考播放器 SceneLifetimePolicy.h returningLiftStep，速率 4.5）
                // 取出时换下的、还转着的卡：先转回正面再落（参考播放器 returning actor 的 returnY）
                if (!(r.hold && r.rot)) r.v *= Math.exp(-dt * (reduced ? 35 : 4.5));
                r.vel = 0;
                // 转着看的卡被换下时边落边转回正面（参考播放器 returning actor 的 returnStep，速率 7）
                r.rot = Math.abs(r.rot || 0) <= 0.001 ? 0 : r.rot * Math.exp(-dt * (reduced ? 35 : 7));
                if (Math.abs(r.v) < 0.002 && !r.rot) returning.delete(k);
            }
            {
                // 镜头进度跟着抬起高度走；取出期间换卡（新卡从低处升起）镜头不退回去
                const fromLift = detailOn ? smoother((lift.v - 0.8) / 2.4) : smoother((lift.v - 0.7) / (DETAIL_LIFT - 0.7));   // 参考 SceneMotion::smooth 是五次的
                const goal = detailOn ? Math.max(fromLift, Math.min(detailK, 1)) : fromLift;
                detailK = reduced ? goal : detailK + (goal - detailK) * (1 - Math.exp(-dt * 2.8));   // 镜头推近的跟随速度，参考播放器 blend 2.8
                if (Math.abs(detailK - goal) < 0.0005) detailK = goal;
                if (!detailOn && detailK < 0.001) detailK = 0;
                // 转卡：按住时朝目标角按 2.8 跟过去，松手后按 7 指数回正（参考播放器 m_rotation / returnAngleStep）
                if (inspect.goal !== 0) inspect.v += (inspect.goal - inspect.v) * (1 - Math.exp(-dt * (reduced ? 35 : 2.8)));
                else { inspect.v *= Math.exp(-dt * (reduced ? 35 : 7)); if (Math.abs(inspect.v) <= 0.001) inspect.v = 0; }
                inspect.vel = 0;
            }
            stepTheme(T);
            const tinting = waves.length > 0;
            const tmpC = tinting ? (stepTheme.c || (stepTheme.c = new THREE.Color())) : null;
            // 静止后的缓慢起伏只在播放时才有：暂停时没有东西在动，画面停住，外面的帧循环也就不再排下一帧
            // 取出端详时背景不起伏、正在放的那一列也不跳（参考播放器：m_targetDetail == 0 且 m_detail < 0.01 才起伏），
            // 卡停稳后整个场景就不再画
            const idleTarget = !reduced && isPlaying && !detailOn && detailK < 0.01 && now - lastInput > 2500 ? 1 : 0;
            bounceGain += ((detailOn ? 0 : 1) - bounceGain) * (reduced ? 1 : 1 - Math.exp(-dt * 4));
            if (bounceGain < 0.001) bounceGain = 0;
            idleGain += (idleTarget - idleGain) * (reduced ? 1 : 1 - Math.exp(-dt * (idleTarget ? 0.8 : 4)));   // 参考播放器：起伏 0.8 慢慢起、4 收；有操作时也是淡出，不清零
            if (!idleTarget && idleGain < 0.002) idleGain = 0;
            for (let k = pulses.length - 1; k >= 0; k--) if (T - pulses[k].t > 3.3) pulses.splice(k, 1);

            // 取出端详时换曲目不再在背景里荡波纹（参考播放器 m_pulseGain：取出时按 8 收到 0）
            pulseGain += ((detailOn ? 0 : 1) - pulseGain) * (reduced ? 1 : 1 - Math.exp(-dt * 8));
            if (pulseGain < 0.001) { pulseGain = 0; pulses.length = 0; }   // 看不见的波纹不再让画面一直画
            // 整片档案的起伏高度：肩部隆起 × 列聚焦 + 待机起伏 + 换选中的波纹（参考播放器 ArchiveField::sample）
            const fieldAt = (row, lane) => {
                let h = settlingWave(row - shoulder.v) * columnStrength(lane, focus.v);
                if (idleGain > 0.001) h += idleWave(row, lane, T) * idleGain;
                if (pulses.length) {
                    let rip = 0;
                    for (const p of pulses) rip += selectionWave(Math.hypot(row - p.row, (lane - p.lane) * 2.2), T - p.t);
                    h += Math.max(-0.6, Math.min(0.6, rip)) * pulseGain;
                }
                return h;
            };
            const baseLane = Math.round(camLane.v);
            const baseRow = Math.round(camRow.v);
            for (const w of labelWanted.values()) wantSpare.push(w);
            labelWanted.clear();
            fitQ = smoother(lift.v / 0.4);
            let i = 0, targetIdx = -1;
            for (let li = -LANES_HALF; li <= LANES_HALF; li++) {
                let upper = fieldAt(baseRow + ROWS_AFTER - 0.5, baseLane + li);   // 行从后往前走，这一行的下半格就是上一行的上半格，复用省掉三分之一的采样
                for (let ri = ROWS_AFTER - 1; ri >= -ROWS_BEFORE; ri--) {   // 近处的行先画：深度测试挡掉后面被遮住的像素，复杂的卡盒着色只算看得见的
                    const lane = baseLane + li;
                    const row = baseRow + ri;
                    let f = fieldAt(row, lane);
                    // 卡顺着起伏的坡度前后微倾（参考播放器 NativeSceneUpdate.cpp：slope × 0.024 × (1 − 取出进度)）
                    const lower = fieldAt(row - 0.5, lane);
                    const tilt = (upper - lower) * 0.024 * (1 - detailK);
                    upper = lower;
                    if (isPlaying && playing && !reduced && bounceGain > 0 && lane === playing.lane) {
                        const dd = Math.abs(row - playing.row);
                        if (dd < 8) f += 0.06 * Math.abs(Math.sin(T * 6.1 + row * 1.3)) * (1 - dd / 8) * bounceGain;
                    }
                    const hl = hoverLifts.size ? hoverLifts.get(cellKey(lane, row)) || 0 : 0;   // 没有悬停的卡时不为每张卡拼字符串
                    let y = BASE_Y + f + hl;
                    const isTarget = lane === target.lane && row === target.row;
                    if (isTarget) y += lift.v;
                    let backRot = 0;
                    let backQ = 0;
                    if (!isTarget && returning.size) { const r = returning.get(cellKey(lane, row)); if (r) { y += r.v; backRot = r.rot || 0; backQ = smoother(r.v / 0.4); } }
                    dummy.position.set((lane - camLane.v) * COLUMN_SPACING, y, (row - camRow.v) * ROW_SPACING - 2.17 - 28 * (1 - reveal));
                    // 参考播放器：坡度倾斜 × (1 − quality)，quality = smooth(lift / 0.4)；落回中的卡也一样，抬着时不跟坡度晃
                    dummy.rotation.x = tilt * (1 - (isTarget ? fitQ : backQ));
                    dummy.rotation.y = isTarget ? inspect.v : backRot;
                    if (isTarget) { targetPos.copy(dummy.position); targetIdx = i; }
                    // 贴标题的范围按选中格算（不按还在飞的相机），当前列就是选中的那一列
                    const dl = lane - target.lane, dr = row - target.row;
                    if (labelFor && dl >= -LABEL_LANES && dl <= LABEL_LANES && dr >= LABEL_ROWS[0] && dr <= LABEL_ROWS[1]) {
                        const info = labelFor(lane, row);
                        if (info) {
                            const w = wantSpare.pop() || {};
                            w.info = info; w.li = dl; w.x = dummy.position.x; w.y = y; w.z = dummy.position.z; w.tilt = dummy.rotation.x; w.turn = dummy.rotation.y;
                            labelWanted.set(cellKey(lane, row), w);
                        }
                    }
                    dummy.updateMatrix();
                    if (isTarget) { fittings.matrix.copy(dummy.matrix); fittings.matrixWorldNeedsUpdate = true; }
                    for (const layer of layers) layer.setMatrixAt(i, dummy.matrix);
                    if (tinting) {
                        for (const [mesh, part] of TINTED) mesh.setColorAt(i, colorAt(part, lane, row, T, waves.length - 1, tmpC));
                    }
                    cellAt[i * 2] = lane;
                    cellAt[i * 2 + 1] = row;
                    i++;
                }
            }
            for (const [k, v] of hoverLifts) {
                const goal = hovered === k ? 0.28 : 0;   // 悬停的卡探出 0.28，按 14 的指数趋近（参考播放器同值）
                const nv = v + (goal - v) * (reduced ? 1 : 1 - Math.exp(-dt * 14));
                if (Math.abs(nv) < 0.001 && goal === 0) hoverLifts.delete(k); else hoverLifts.set(k, nv);
            }
            if (hovered && !hoverLifts.has(hovered)) hoverLifts.set(hovered, 0.0001);
            for (const layer of layers) layer.instanceMatrix.needsUpdate = true;
            if (tinting) for (const [mesh] of TINTED) mesh.instanceColor.needsUpdate = true;
            // 选中卡在实例参数里打个记号（g = 1），着色器只在这张卡上算内部暖光和半透面板
            if (tinting || targetIdx !== accentIdx) {
                if (accentIdx >= 0 && accentIdx !== targetIdx && !tinting) cards.setColorAt(accentIdx, tint.card);
                if (targetIdx >= 0) {
                    if (tinting) cards.getColorAt(targetIdx, accentTmp); else accentTmp.copy(tint.card);
                    accentTmp.g = 1;
                    cards.setColorAt(targetIdx, accentTmp);
                }
                accentIdx = targetIdx;
                cards.instanceColor.needsUpdate = true;
            }

            // 选中格可以一帧跳过好几张卡，镜头的瞄准点随画面平滑移动。
            const targetVisible = targetIdx >= 0;
            if (targetVisible) syncSticker();
            if (targetVisible) {
                if (snapCardAim || reduced || detailK < 0.001) cardAim.copy(targetPos);
                else cardAim.lerp(targetPos, 1 - Math.exp(-dt * 10));
                snapCardAim = false;
            }
            if (!detailOn && detailK >= 0.001 && (pointer.x !== pointerAim.x || pointer.y !== pointerAim.y)) {
                const f = reduced ? 1 : 1 - Math.exp(-dt * 5);
                pointer.x += (pointerAim.x - pointer.x) * f; pointer.y += (pointerAim.y - pointer.y) * f;
            } else if (!detailOn && detailK < 0.001) { pointer.x = pointerAim.x; pointer.y = pointerAim.y; }
            placeCamera(reduced);
            placeCover(targetVisible);
            fittings.visible = targetVisible;
            placeLabels();
            // 选中卡的暖光跟着卡走；看不到选中卡时关掉
            if (targetVisible) {
                glowMat4.makeRotationY(inspect.v).setPosition(targetPos);
                glowUniforms.uGlowInv.value.copy(glowMat4).invert();
            }
            glowUniforms.uLightOn.value = targetVisible ? 1 : 0;
            glowUniforms.uHero.value = detailK;
            glowUniforms.uQuality.value = fitQ;
            etchMat.opacity = fitQ;
            stickerMat.opacity = fitQ;
            // 取出端详时面板透得少一些：卡面上压着封面，内衬的光斑透出来会显脏
            glowUniforms.uSeeThrough.value = 0.38;
            if (post.on) {
                post.mat.uniforms.uShade.value = detailK;
                /*
                 * 镜头在两列/两行之间滑得快的那一段，画面本来就在动、看不清细节，场景只按 0.67 倍边长画
                 * （约一半像素），由后期放大。滑到慢下来（速度低于 0.25 格/秒）就回到全分辨率，
                 * 停稳的那一帧和之后的静止画面都是全分辨率，和原来一样。
                 * 取出/收回时卡飞得最快、镜头推进还不到一半的那一段也这样画；推进过半以后封面变大、
                 * 柔化收掉，就回到全分辨率，端详时的封面一直是清晰的。
                 * 参考播放器同样是降渲染比例再放大（RenderModePolicy.h 的 renderPercent 50–200%）。
                 */
                const speed = Math.abs(camLane.vel) + Math.abs(camRow.vel);
                const gliding = detailK < 0.001 && !detailOn && speed > 0.25;
                const flying = detailK < 0.5 && Math.abs(lift.vel) > 1.5;
                const s = !reduced && post.px && (gliding || flying) ? 0.67 : 1;
                const px = post.px || { x: 1, y: 1 };
                const vw = Math.max(1, Math.round(px.x * s)), vh = Math.max(1, Math.round(px.y * s));
                post.rt.viewport.set(0, 0, vw, vh);
                post.rt.scissor.set(0, 0, vw, vh);
                post.rt.scissorTest = s < 1;
                post.mat.uniforms.uScale.value.set(vw / px.x, vh / px.y);
                post.lowRes = s < 1;
                renderer.setRenderTarget(post.rt);
                renderer.render(scene, camera);
                renderer.setRenderTarget(null);
                renderer.render(post.scene, post.camera);
            } else {
                renderer.render(scene, camera);
            }
            dirty = false;
            frames++;

            // 播放时的缓慢起伏、轻跳让选中卡一直在小幅移动，镜头瞄准点永远差一点点；
            // 差得很少（不到 0.05）就算到位，不然静止画面会一直按满帧画。
            const aimMoving = detailK > 0.001 && targetVisible && cardAim.distanceToSquared(targetPos) > 0.0025;
            // 行方向按屏幕像素算：剩下没走完的距离（位置差 + 速度/速率）不到半个像素就停。原来按 0.001 行、
            // 速度 0.001 行/秒判，最后约半秒都在画一帧挪零点几像素的画面（参考播放器也是位移不变才休眠）。
            const rowRest = (Math.abs(camRow.v - target.row) + Math.abs(camRow.vel) / 3.7) * ROW_SPACING * pxPerUnit;
            const settled = reveal === 1 && !roomMoving && !aimMoving && Math.abs(camLane.v - target.lane) < 0.001 && rowRest < 0.5
                && (Math.abs(lift.v - (detailOn ? DETAIL_LIFT : liftGoal)) + Math.abs(lift.vel) / liftRate) * pxPerUnit < 0.5 && !returning.size
                && Math.abs(detailK - (detailOn ? 1 : 0)) < 0.001 && Math.abs(inspect.v - inspect.goal) < 0.001
                && !themeBusy() && Math.abs(camLane.vel) < 0.001
                && !pulses.length && hoverLifts.size <= (hovered ? 1 : 0) && !labelsPending;
            return {
                moving: !settled,
                idle: now - Math.max(lastInput, lastPointer) > IDLE_AFTER,
                animated: !settled || idleGain > 0.001 || (isPlaying && playing && !reduced && bounceGain > 0)
            };
        };

        // ---- 拾取：每张卡当作轴对齐的盒子求交，比逐三角形快得多 ----
        const ray = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const boxMin = new THREE.Vector3(), boxMax = new THREE.Vector3(), hit = new THREE.Vector3();
        const tmpBox = new THREE.Box3();
        const m4 = new THREE.Matrix4();
        const pick = (clientX, clientY, rect) => {
            ndc.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
            ray.setFromCamera(ndc, camera);
            let best = null;
            let bestDist = Infinity;
            for (let i = 0; i < POOL; i++) {
                cards.getMatrixAt(i, m4);
                const x = m4.elements[12], y = m4.elements[13], z = m4.elements[14];
                boxMin.set(x - CARD_W / 2, y, z - CARD_D / 2 + 0.02);
                boxMax.set(x + CARD_W / 2, y + CARD_H, z + CARD_D / 2 + 0.02);
                tmpBox.set(boxMin, boxMax);
                if (ray.ray.intersectBox(tmpBox, hit)) {
                    const d = hit.distanceToSquared(ray.ray.origin);
                    if (d < bestDist) { bestDist = d; best = i; }
                }
            }
            return best === null ? null : { lane: cellAt[best * 2], row: cellAt[best * 2 + 1] };
        };

        const setHover = (cell) => {
            const k = cell ? cell.lane + ':' + cell.row : null;
            if (k === hovered) return;
            hovered = k;   // 减少动态时也探出，只是直接到位不带过渡（参考播放器 m_reduced 下 next = target）
            invalidate();
        };
        /*
         * 照参考播放器 NativeSceneUpdate.cpp：只有能浏览（没取出卡）时指针才带动镜头视差。
         * 卡取出端详时晃鼠标不再整帧重画；放回的过渡里（本来就在逐帧画）视差再缓缓跟上指针，不跳。
         */
        const setPointer = (x, y) => {
            pointerAim.x = x; pointerAim.y = y; lastPointer = performance.now();
            if (detailOn || reducedMotion()) return;
            if (detailK < 0.001) { pointer.x = x; pointer.y = y; }
            invalidate();
        };
        const setPlaying = (cell, playingNow) => {
            const same = (cell && playing && cell.lane === playing.lane && cell.row === playing.row) || (!cell && !playing);
            if (same && playingNow === isPlaying) return;
            playing = cell; isPlaying = Boolean(playingNow);
            invalidate();
        };
        const touch = () => { lastInput = performance.now(); };   // 起伏不清零，按 4 淡出（参考播放器），一碰键盘不会整片一下子跳平
        /* 选中卡的抬起高度，不传回到默认 0.4 */
        const raise = (amount) => {
            const goal = Number.isFinite(amount) ? amount : 0.4;
            if (goal === liftGoal) return;
            liftGoal = goal;
            invalidate();
        };

        const dispose = () => {
            for (const layer of layers) { layer.geometry.dispose(); layer.dispose?.(); }
            for (const m of [cassetteMat, frameMat, artMat, captionMat, etchMat, stickerMat]) m.dispose();
            if (post.on) { post.rt.dispose(); post.mat.dispose(); post.scene.children[0].geometry.dispose(); host.classList.remove('archive-post-atmos'); }
            freeCoverTex(); fittingsGeo.dispose(); fittingsMat.dispose(); coverGeo.dispose(); frameGeo.dispose(); captionGeo.dispose(); captionMap.dispose(); etchGeo.dispose(); etchMap.dispose(); stickerGeo.dispose(); stickerMap.dispose();
            for (const L of labels) { L.tex.dispose(); L.mat.dispose(); }
            labelGeo.dispose();
            renderer.dispose();
            renderer.forceContextLoss?.();
            canvas.remove();
        };

        return {
            canvas,
            tier,
            resize, setTheme, select, jump, step, pick, setHover, setPointer, setPlaying, touch, raise, setLabeler, setLabelMask, refreshLabels, dispose,
            setDetail, setDetailRoom, setCover, turn, detailRect, hold, unhold, camAt, dragAxes,
            get detail() { return detailOn; },
            get dirty() { return dirty; },
            get target() { return { ...target }; },
            get themeBusy() { return themeBusy(); },
            debug: () => ({ cam: { lane: Math.round(camLane.v * 1000) / 1000, row: Math.round(camRow.v * 1000) / 1000 }, target: { ...target }, frames, dpr: renderer.getPixelRatio(), labels: labels.filter((L) => L.mesh.visible).length, labelLanes: [...new Set(labels.filter((L) => L.mesh.visible).map((L) => Number(L.cell.split(':')[0])))].sort((x, y) => x - y), waves: waves.length, fading: Boolean(lookFade), bg: scene.background.getHexString(), lift: Math.round(lift.v * 100) / 100, liftVel: Math.round(lift.vel * 100) / 100, lowRes: Boolean(post.lowRes), detail: Math.round(detailK * 1000) / 1000, returning: returning.size, pool: POOL, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs?.length || 0 })
        };
    };

    const api = Object.freeze({ create, TIERS, IDLE_AFTER, tierOf, POOL, settlingWave, selectionWave });
    global.MusicArchiveScene = api;
})(typeof window !== 'undefined' ? window : globalThis);
