/*
 * 町景：各模块共用的着色器片段和伪光照。
 *
 * 场景里不放 three 的真点光。招牌、巷灯、窗灯把自己的光写进同一组
 * uniform（最多 MAX_LIGHTS 个），各材质按距离衰减自己加。雾走 three 的
 * scene.fog，自定义材质带上 fog 片段即可。
 */
(function (global) {
    'use strict';

    const MAX_LIGHTS = 32;

    const createLightUniforms = (T) => ({
        uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new T.Vector3(0, -999, 0)) },
        uLightCol: { value: Array.from({ length: MAX_LIGHTS }, () => new T.Vector3()) },
        uLightRad: { value: new Float32Array(MAX_LIGHTS) },
        // 1 = 雾里画光晕，0 = 不画（light.halo === false，比如贴着屏幕的补光）。
        uLightHalo: { value: new Float32Array(MAX_LIGHTS).fill(1) },
        uLightCount: { value: 0 },
        uTime: { value: 0 },
        uRain: { value: 0 },
        uWet: { value: 0 },
        // 夜空和地面反光，半球环境光的两端。
        uSky: { value: new T.Color(0x3a4c66) },
        uGround: { value: new T.Color(0x4a3330) },
        // 城市本身的光污染：越近地面越暖。
        uGlow: { value: new T.Color(0xff8a52) },
        uGlowStrength: { value: 0.35 }
    });

    // 把各模块 lights() 的结果按与相机的距离挑最近、最亮的写进 uniform。
    const gatherLights = (uniforms, groups, camera) => {
        const all = [];
        const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
        groups.forEach(list => (list || []).forEach(light => {
            if (!light || !light.position) return;
            const [x, y, z] = light.position;
            const d = Math.hypot(x - cx, y - cy, z - cz);
            const strength = (light.intensity ?? 1) * (light.radius ?? 8);
            all.push({ light, score: strength / (1 + d * 0.05) });
        }));
        all.sort((a, b) => b.score - a.score);
        const n = Math.min(MAX_LIGHTS, all.length);
        for (let i = 0; i < MAX_LIGHTS; i += 1) {
            const pos = uniforms.uLightPos.value[i];
            const col = uniforms.uLightCol.value[i];
            if (i >= n) { pos.set(0, -999, 0); col.set(0, 0, 0); uniforms.uLightRad.value[i] = 1; continue; }
            const { light } = all[i];
            if (uniforms.uLightHalo) uniforms.uLightHalo.value[i] = light.halo === false ? 0 : 1;
            const k = (light.intensity ?? 1) * (light.flickerValue ?? 1);
            pos.set(light.position[0], light.position[1], light.position[2]);
            col.set(light.color[0] * k, light.color[1] * k, light.color[2] * k);
            uniforms.uLightRad.value[i] = light.radius ?? 8;
        }
        uniforms.uLightCount.value = n;
        return n;
    };

    const GLSL_COMMON = /* glsl */`
        float kwHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float kwHash1(float n){ return fract(sin(n) * 43758.5453123); }
        float kwNoise(vec2 p){
            vec2 i = floor(p), f = fract(p);
            float a = kwHash(i), b = kwHash(i + vec2(1.0, 0.0));
            float c = kwHash(i + vec2(0.0, 1.0)), d = kwHash(i + vec2(1.0, 1.0));
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }
        float kwFbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * kwNoise(p); p *= 2.03; a *= 0.5; } return v; }
    `;

    // 依赖 GLSL_COMMON。worldPos、法线、反照率 → 夜里看到的颜色（不含自发光）。
    const GLSL_LIGHTS = /* glsl */`
        #define KW_MAX_LIGHTS ${MAX_LIGHTS}
        uniform vec3 uLightPos[KW_MAX_LIGHTS];
        uniform vec3 uLightCol[KW_MAX_LIGHTS];
        uniform float uLightRad[KW_MAX_LIGHTS];
        uniform int uLightCount;
        uniform vec3 uSky;
        uniform vec3 uGround;
        uniform float uTime;
        uniform float uRain;
        uniform float uWet;
        uniform vec3 uGlow;
        uniform float uGlowStrength;
        // 材质可以在 main 里改：窄巷、天井里看不到街上的光，地面暖光要压下去。
        float kwGlowScale = 1.0;
        vec3 kwLight(vec3 p, vec3 n, vec3 albedo, float rough){
            float up = n.y * 0.5 + 0.5;
            vec3 col = albedo * mix(uGround, uSky, up) * 1.1;
            // 街上霓虹和店铺灯从下往上打的一层暖光，楼越高越弱。
            col += albedo * uGlow * uGlowStrength * kwGlowScale * exp(-max(p.y, 0.0) / 14.0) * (0.6 + 0.4 * (1.0 - abs(n.y)));
            for (int i = 0; i < KW_MAX_LIGHTS; i++) {
                if (i >= uLightCount) break;
                vec3 d = uLightPos[i] - p;
                float dist = length(d);
                float r = uLightRad[i];
                float fall = max(0.0, 1.0 - dist / r);
                fall *= fall;
                float lam = max(0.0, dot(n, d / max(dist, 1e-3))) * 0.8 + 0.2;
                col += albedo * uLightCol[i] * fall * lam;
            }
            return col;
        }
    `;

    global.MusicStageKowloonShared = Object.freeze({
        MAX_LIGHTS, createLightUniforms, gatherLights, GLSL_COMMON, GLSL_LIGHTS
    });
})(typeof window !== 'undefined' ? window : globalThis);
