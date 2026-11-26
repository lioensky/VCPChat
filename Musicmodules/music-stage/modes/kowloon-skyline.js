/*
 * 町景：城寨背后的天际线。
 *
 * 几座几百米高的巨型塔楼半埋在金色烟霾里，远处几根烧着火炬的烟囱往上冒烟，
 * 天上有飞行器拖着探照光慢慢穿过。都离得很远，只求剪影和光，面数压得很低。
 * 由 kowloon-city.js 创建并转发 update / lights / dispose。
 */
(function (global) {
    'use strict';

    // 巨构塔楼：底面中心、底半径、总高、层数。都在城寨北面和两侧，iso 和街景机位往北看时压在背后。
    const TOWERS = [
        { x: -260, z: -420, r: 46, h: 380, tiers: 6, seed: 0.13 },
        { x: 120, z: -560, r: 58, h: 460, tiers: 7, seed: 0.41 },
        { x: 430, z: -330, r: 40, h: 320, tiers: 5, seed: 0.67 },
        { x: -560, z: -180, r: 36, h: 290, tiers: 5, seed: 0.29 },
        { x: 640, z: 40, r: 34, h: 260, tiers: 4, seed: 0.83 },
        { x: -120, z: -760, r: 70, h: 520, tiers: 8, seed: 0.55 }
    ];
    // 烟囱：东北边的工业区。
    const STACKS = [
        { x: 520, z: -520, r: 9, h: 190 },
        { x: 575, z: -470, r: 7, h: 160 },
        { x: -470, z: -560, r: 8, h: 175 }
    ];
    const CRAFT = 6;

    const create = (T, ctx) => {
        const { scene } = ctx;
        const shared = ctx.lightUniforms;
        const disposables = [];
        const keep = (x) => { disposables.push(x); return x; };
        const group = new T.Group();
        group.name = 'kowloon-skyline';
        scene.add(group);
        // 远景自己算雾：场景的指数雾到几百米外已经全白，塔楼会整座消失。
        const fogColor = { value: new T.Color(0x3a2a1c) };
        const hazeColor = { value: new T.Color(0xc9893f) };

        // ---------- 巨构塔楼 ----------
        // 每层是一个八角柱，往上收分；层间一道外挑的檐，下面四片扶壁，顶上一根尖塔。
        const parts = [];
        const push = (g, tower, part) => {
            const n = g.attributes.position.count;
            g.setAttribute('aTower', new T.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) =>
                [tower.x, tower.z, tower.seed, part][i % 4]), 4));
            if (g.index) g = g.toNonIndexed();
            parts.push(g);
        };
        TOWERS.forEach(tw => {
            let y = 0, r = tw.r;
            for (let i = 0; i < tw.tiers; i += 1) {
                const th = tw.h * (i === 0 ? 0.26 : 0.6 / (tw.tiers - 1)) * (0.9 + ((tw.seed * 7 + i * 0.37) % 1) * 0.2);
                const r1 = r * 0.86;
                const body = new T.CylinderGeometry(r1, r, th, 8, 1, true);
                body.rotateY(Math.PI / 8);
                body.translate(tw.x, y + th / 2, tw.z);
                push(body, tw, 0);
                // 檐：外挑一圈，角上微微翘起。
                const eave = new T.CylinderGeometry(r1 * 1.18, r1 * 1.02, Math.max(2.5, th * 0.04), 8, 1, false);
                eave.rotateY(Math.PI / 8);
                eave.translate(tw.x, y + th, tw.z);
                push(eave, tw, 1);
                if (i < 2) {
                    for (let k = 0; k < 4; k += 1) {
                        const a = k * Math.PI / 2 + Math.PI / 4;
                        const fin = new T.BoxGeometry(r * 0.32, th * 0.92, 3);
                        fin.translate(r * 0.95, th * 0.46, 0);
                        fin.rotateY(a);
                        fin.translate(tw.x, y, tw.z);
                        push(fin, tw, 2);
                    }
                }
                y += th;
                r = r1 * 0.82;
            }
            const spire = new T.ConeGeometry(r * 0.7, tw.h - y + 40, 8, 1, true);
            spire.rotateY(Math.PI / 8);
            spire.translate(tw.x, y + (tw.h - y + 40) / 2, tw.z);
            push(spire, tw, 3);
            tw.top = y + (tw.h - y + 40);
        });
        // 中间层：城寨和巨构之间一圈一两百米高的巨型楼块，压得很暗，只有稀疏的窗，
        // 把近处的城寨和远处的塔楼隔出层次。
        for (let i = 0; i < 16; i += 1) {
            if (i % 3 === 2) continue;
            const h1 = (Math.sin(i * 12.9898) * 43758.5453) % 1, h2 = (Math.sin(i * 78.233) * 12543.123) % 1;
            const a = Math.PI * (1.02 + (i + Math.abs(h1) * 0.6) / 16 * 0.96);
            const r = 210 + Math.abs(h2) * 130;
            const x = Math.cos(a) * r * 1.5, z = Math.sin(a) * r - 40;
            const w = 34 + Math.abs(h1) * 30, d = 26 + Math.abs(h2) * 20, h = 70 + Math.abs(h1 * h2) * 4 * 55;
            const block = new T.BoxGeometry(w, h, d);
            block.translate(x, h / 2, z);
            push(block, { x, z, seed: Math.abs(h1) }, 4);
            // 顶上再退一级。
            const cap = new T.BoxGeometry(w * 0.6, h * 0.18, d * 0.7);
            cap.translate(x + w * 0.1, h + h * 0.09, z);
            push(cap, { x, z, seed: Math.abs(h2) }, 4);
        }
        // 合并（全是非索引几何，直接拼）。
        const merged = (() => {
            const names = ['position', 'normal', 'aTower'];
            const out = new T.BufferGeometry();
            names.forEach(name => {
                const size = parts[0].attributes[name].itemSize;
                const total = parts.reduce((s, g) => s + g.attributes[name].count, 0);
                const arr = new Float32Array(total * size);
                let o = 0;
                parts.forEach(g => { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; });
                out.setAttribute(name, new T.Float32BufferAttribute(arr, size));
            });
            parts.forEach(g => g.dispose());
            out.computeBoundingSphere();
            return keep(out);
        })();
        const towerMat = keep(new T.ShaderMaterial({
            side: T.DoubleSide,
            uniforms: { uTime: shared.uTime, uFog: fogColor, uHaze: hazeColor, uSky: shared.uSky, uFlash: { value: 0 } },
            vertexShader: /* glsl */`
                attribute vec4 aTower;
                varying vec3 vWorld; varying vec3 vNormal; varying vec4 vTower;
                void main(){
                    vec4 w = modelMatrix * vec4(position, 1.0);
                    vWorld = w.xyz; vNormal = normalize(mat3(modelMatrix) * normal); vTower = aTower;
                    gl_Position = projectionMatrix * viewMatrix * w;
                }`,
            fragmentShader: /* glsl */`
                uniform float uTime; uniform vec3 uFog; uniform vec3 uHaze; uniform vec3 uSky; uniform float uFlash;
                varying vec3 vWorld; varying vec3 vNormal; varying vec4 vTower;
                float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
                void main(){
                    vec3 n = normalize(vNormal);
                    vec2 d = vWorld.xz - vTower.xy;
                    float ang = atan(d.y, d.x);
                    float around = ang * length(d);
                    float part = floor(vTower.w + 0.5);
                    float seed = vTower.z;
                    // 底色：很暗的铁灰，朝下的面被城市的光从下面照成暖色。
                    vec3 col = vec3(0.025, 0.026, 0.03);
                    vec3 glow = vec3(0.0);
                    float under = clamp(-n.y, 0.0, 1.0);
                    col += uHaze * 0.12 * under * exp(-vWorld.y / 220.0);
                    // 侧面：竖向窗带和每层的横线，零星的亮窗，金色为主，少数冷青。
                    float blocky = step(3.5, part);
                    if (blocky > 0.5) around = abs(n.x) > 0.5 ? vWorld.z : vWorld.x;
                    if (part < 0.5 || blocky > 0.5) {
                        float bay = floor(around / 4.0);
                        float fl = floor(vWorld.y / 4.2);
                        vec2 cell = vec2(fract(around / 4.0), fract(vWorld.y / 4.2));
                        float strip = step(0.25, cell.x) * step(cell.x, 0.75) * step(0.2, cell.y) * step(cell.y, 0.8);
                        float band = step(0.82, h21(vec2(floor(bay / 3.0), seed * 91.0)));
                        float lit = step(0.9 - band * 0.45 * (1.0 - blocky) + blocky * 0.075, h21(vec2(bay, fl + seed * 37.0)));
                        float cool = step(0.86, h21(vec2(bay * 1.7, fl * 0.3 + seed)));
                        vec3 win = mix(vec3(1.0, 0.62, 0.25), vec3(0.3, 0.9, 1.0), cool);
                        glow += win * strip * lit * mix(1.0, 0.55, blocky) * step(abs(n.y), 0.5);
                        // 竖向灯带：每隔几个开间一根从下往上的细光条，慢慢流动。
                        float rib = 1.0 - smoothstep(0.0, 0.06, abs(fract(around / 24.0 + seed) - 0.5) * 2.0 - 0.94);
                        float flow = 0.55 + 0.45 * sin(vWorld.y * 0.05 - uTime * 0.8 + seed * 20.0);
                        glow += vec3(1.0, 0.55, 0.2) * rib * flow * 0.4 * (1.0 - blocky);
                    } else if (part < 1.5) {
                        // 檐口一圈灯，像一串小灯笼。
                        float bead = step(0.6, fract(around / 3.0));
                        glow += vec3(1.0, 0.5, 0.18) * bead * 1.2 * step(0.0, n.y + 0.5);
                    } else if (part > 2.5) {
                        // 尖塔：几道细的金色横线，像镂空的塔刹。
                        glow += vec3(1.0, 0.6, 0.25) * step(0.93, fract(vWorld.y / 9.0)) * 0.8;
                    }
                    col += uSky * uFlash * 0.4;
                    // 远景雾：按距离和高度。低处埋在被城市光照亮的金色烟霾里，高处是暗下来的夜空。
                    float dist = length(vWorld - cameraPosition);
                    float f = 1.0 - exp(-dist * 0.0021);
                    float low = exp(-max(vWorld.y, 0.0) / 120.0);
                    // 雾色不能太黑：被城市光照着的烟霾本身是亮的。
                    vec3 fogC = max(uFog, uHaze * 0.12);
                    vec3 haze = mix(fogC, uHaze * 0.32, low * 0.85);
                    col = mix(col, haze, clamp(f * (0.35 + 0.5 * low), 0.0, 0.8));
                    // 自发光穿得过雾：只按距离淡一点，低处再被烟霾吃掉一些。
                    col += glow * exp(-dist * 0.0011) * (1.0 - 0.6 * low);
                    gl_FragColor = vec4(col, 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const towers = new T.Mesh(merged, towerMat);
        towers.name = 'kowloon-megatowers';
        towers.frustumCulled = false;
        towers.layers.set(3);
        group.add(towers);

        // ---------- 烟囱、火炬、烟柱 ----------
        const stackGeo = keep(new T.CylinderGeometry(1, 1.25, 1, 12, 1, true));
        stackGeo.translate(0, 0.5, 0);
        const stackMat = keep(new T.ShaderMaterial({
            uniforms: { uFog: fogColor, uHaze: hazeColor, uTime: shared.uTime },
            vertexShader: /* glsl */`
                varying vec3 vWorld; varying float vY;
                void main(){
                    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
                    vWorld = w.xyz; vY = position.y;
                    gl_Position = projectionMatrix * viewMatrix * w;
                }`,
            fragmentShader: /* glsl */`
                uniform vec3 uFog; uniform vec3 uHaze; uniform float uTime;
                varying vec3 vWorld; varying float vY;
                void main(){
                    vec3 col = vec3(0.03, 0.028, 0.026);
                    // 红白相间的警示环，顶上被火光照亮。
                    float ring = step(0.5, fract(vY * 7.0)) * step(0.72, vY);
                    col = mix(col, vec3(0.12, 0.03, 0.02), ring);
                    float flick = 0.75 + 0.25 * sin(uTime * 9.0 + vWorld.x) * sin(uTime * 5.3);
                    col += vec3(1.0, 0.45, 0.12) * smoothstep(0.82, 1.0, vY) * 0.6 * flick;
                    float dist = length(vWorld - cameraPosition);
                    float low = exp(-max(vWorld.y, 0.0) / 120.0);
                    col = mix(col, mix(max(uFog, uHaze * 0.12), uHaze * 0.6, low * 0.85), clamp((1.0 - exp(-dist * 0.0021)) * (0.45 + 0.5 * low), 0.0, 0.9));
                    gl_FragColor = vec4(col, 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const stacks = new T.InstancedMesh(stackGeo, stackMat, STACKS.length);
        const m4 = new T.Matrix4();
        STACKS.forEach((s, i) => stacks.setMatrixAt(i, m4.compose(new T.Vector3(s.x, 0, s.z), new T.Quaternion(), new T.Vector3(s.r, s.h, s.r))));
        stacks.name = 'kowloon-stacks';
        stacks.frustumCulled = false;
        stacks.layers.set(3);
        group.add(stacks);

        // 火炬和烟：每根烟囱一串朝相机的面片。第 0 片是火，其余是往上飘、慢慢散开的烟。
        const PUFFS = 14;
        const smokeGeo = keep(new T.InstancedBufferGeometry());
        smokeGeo.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
        smokeGeo.setIndex([0, 1, 2, 1, 3, 2]);
        const smokeBase = [], smokeIdx = [];
        STACKS.forEach((s, si) => { for (let i = 0; i < PUFFS; i += 1) { smokeBase.push(s.x, s.h, s.z, s.r); smokeIdx.push(i, si); } });
        smokeGeo.setAttribute('aBase', new T.InstancedBufferAttribute(new Float32Array(smokeBase), 4));
        smokeGeo.setAttribute('aIdx', new T.InstancedBufferAttribute(new Float32Array(smokeIdx), 2));
        smokeGeo.instanceCount = STACKS.length * PUFFS;
        const smokeMat = keep(new T.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: { uTime: shared.uTime, uFog: fogColor, uHaze: hazeColor },
            vertexShader: /* glsl */`
                attribute vec4 aBase; attribute vec2 aIdx;
                uniform float uTime;
                varying vec2 vUv; varying float vAge; varying float vFire; varying float vSeed;
                void main(){
                    float i = aIdx.x;
                    vFire = step(i, 0.5);
                    vSeed = fract(aIdx.y * 0.37 + i * 0.131);
                    // 每片烟循环上升：年龄 0→1，越老越高、越大、越淡，往西北被风吹偏。
                    float age = fract(uTime * 0.025 + i / ${PUFFS - 1}.0 + aIdx.y * 0.31);
                    vAge = mix(age, 0.0, vFire);
                    vec3 p = aBase.xyz;
                    float size = aBase.w * mix(1.6 + 6.0 * vAge, 1.4, vFire);
                    p += vec3(-0.6, 1.0, -0.25) * vAge * 220.0 * (1.0 - vFire);
                    p.y += vFire * aBase.w * 1.1;
                    vec4 mv = viewMatrix * vec4(p, 1.0);
                    float flick = 1.0 + vFire * 0.25 * sin(uTime * 13.0 + aIdx.y * 4.0);
                    mv.xy += position.xy * size * flick * vec2(1.0, mix(1.0, 1.7, vFire));
                    vUv = position.xy;
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: /* glsl */`
                uniform float uTime; uniform vec3 uFog; uniform vec3 uHaze;
                varying vec2 vUv; varying float vAge; varying float vFire; varying float vSeed;
                void main(){
                    float r = length(vUv);
                    if (r > 1.0) discard;
                    if (vFire > 0.5) {
                        float core = 1.0 - smoothstep(0.0, 1.0, length(vUv * vec2(1.4, 0.8) + vec2(0.0, 0.25)));
                        vec3 c = mix(vec3(1.0, 0.35, 0.06), vec3(1.0, 0.85, 0.5), core * core);
                        gl_FragColor = vec4(c * 2.2, core);
                        return;
                    }
                    float a = (1.0 - smoothstep(0.2, 1.0, r)) * (1.0 - vAge) * 0.32 * smoothstep(0.0, 0.08, vAge);
                    // 刚冒出来的烟被底下的火照成橙色，越往上越接近烟霾的颜色。
                    vec3 c = mix(vec3(0.9, 0.38, 0.12) * 0.8, max(uFog, uHaze * 0.12) * 1.3 + uHaze * 0.12, smoothstep(0.0, 0.35, vAge));
                    gl_FragColor = vec4(c, a);
                }`
        }));
        const smoke = new T.Mesh(smokeGeo, smokeMat);
        smoke.name = 'kowloon-smoke';
        smoke.frustumCulled = false;
        smoke.renderOrder = 3;
        smoke.layers.set(3);
        group.add(smoke);

        // ---------- 飞行器 ----------
        // 各自绕城寨兜一个倾斜的椭圆，机腹一道探照光往前下方扫，扫到的楼面靠 lights() 打亮。
        const craft = Array.from({ length: CRAFT }, (_, i) => ({
            cx: (i % 3 - 1) * 90, cz: -60 - (i % 2) * 120,
            ax: 220 + i * 40, az: 140 + (i * 37) % 90,
            y: 70 + (i * 23) % 70, speed: (0.018 + i * 0.004) * (i % 2 ? 1 : -1), phase: i * 1.7,
            beam: i % 2 === 0
        }));
        const bodyGeo = (() => {
            const hull = new T.BoxGeometry(3.2, 1.6, 9);
            const wing = new T.BoxGeometry(9, 0.3, 2.4);
            wing.translate(0, 0.2, -1);
            const pod = new T.CylinderGeometry(0.9, 0.9, 1.2, 8);
            const pods = [pod.clone().translate(-4.6, 0.2, -1), pod.clone().translate(4.6, 0.2, -1)];
            const g = mergeAll(T, [hull, wing, ...pods]);
            [hull, wing, pod, ...pods].forEach(x => x.dispose());
            return keep(g);
        })();
        const bodyMat = keep(new T.MeshBasicMaterial({ color: 0x0b0c10 }));
        const bodies = new T.InstancedMesh(bodyGeo, bodyMat, CRAFT);
        bodies.name = 'kowloon-craft';
        bodies.frustumCulled = false;
        group.add(bodies);
        // 机身灯：每架 3 点（左红、右绿、机腹白闪）。
        const navGeo = keep(new T.BufferGeometry());
        const navPos = new Float32Array(CRAFT * 3 * 3);
        const navCol = new Float32Array(CRAFT * 3 * 3);
        for (let i = 0; i < CRAFT; i += 1) navCol.set([2.6, 0.3, 0.2, 0.3, 2.6, 0.7, 2.6, 2.6, 2.4], i * 9);
        navGeo.setAttribute('position', new T.BufferAttribute(navPos, 3));
        navGeo.setAttribute('color', new T.BufferAttribute(navCol, 3));
        const navMat = keep(new T.PointsMaterial({ size: 3.6, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
        const nav = new T.Points(navGeo, navMat);
        nav.frustumCulled = false;
        nav.layers.set(3);
        group.add(nav);
        // 探照光柱：一端开口的锥，沿长度渐隐，加法混合。
        const beamGeo = keep(new T.CylinderGeometry(0.4, 9, 1, 16, 1, true));
        beamGeo.translate(0, -0.5, 0);
        const beamMat = keep(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
            uniforms: { uRain: shared.uRain },
            vertexShader: /* glsl */`
                varying float vT; varying vec3 vN; varying vec3 vV;
                void main(){
                    vT = -position.y;
                    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
                    vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
                    vV = normalize(w.xyz - cameraPosition);
                    gl_Position = projectionMatrix * viewMatrix * w;
                }`,
            fragmentShader: /* glsl */`
                uniform float uRain;
                varying float vT; varying vec3 vN; varying vec3 vV;
                void main(){
                    float edge = pow(1.0 - abs(dot(normalize(vN), vV)), 1.5);
                    float a = (1.0 - vT) * (1.0 - vT) * (0.35 + 0.65 * (1.0 - edge)) * (0.07 + 0.06 * uRain);
                    gl_FragColor = vec4(vec3(0.75, 0.9, 1.0) * a, 1.0);
                }`
        }));
        const beamCount = craft.filter(c => c.beam).length;
        const beams = new T.InstancedMesh(beamGeo, beamMat, beamCount);
        beams.name = 'kowloon-beams';
        beams.frustumCulled = false;
        beams.renderOrder = 4;
        beams.layers.set(3);
        group.add(beams);

        // ---------- 高架轨道和列车 ----------
        // 南街南沿架着一条单线高架，贴着对面那排矮楼。列车每隔几十秒带着一串窗灯从镜头前驶过，
        // 给街景和正立面机位一层会动的前景；在街上往上看，桥面正好压在画面上沿。
        const S = global.MusicStageKowloonShared;
        const RAIL = { z: 70.8, y: 9.4, width: 3.2, x0: -330, x1: 330, span: 18 };
        const railParts = [];
        const rbox = (w, h, d, x, y, z) => { const g = new T.BoxGeometry(w, h, d); g.translate(x, y, z); railParts.push(g); };
        rbox(RAIL.x1 - RAIL.x0, 0.55, RAIL.width, 0, RAIL.y - 0.28, RAIL.z);
        // 两侧的护栏和线槽。
        rbox(RAIL.x1 - RAIL.x0, 0.9, 0.12, 0, RAIL.y + 0.45, RAIL.z - RAIL.width / 2);
        rbox(RAIL.x1 - RAIL.x0, 0.9, 0.12, 0, RAIL.y + 0.45, RAIL.z + RAIL.width / 2);
        rbox(RAIL.x1 - RAIL.x0, 0.18, 0.5, 0, RAIL.y - 0.7, RAIL.z + RAIL.width / 2 + 0.25);
        for (let x = RAIL.x0; x <= RAIL.x1; x += RAIL.span) {
            // 桥墩在南侧，不占街面；上面一根挑梁托着桥面，再往上是接触网的门架。
            rbox(0.8, RAIL.y - 0.55, 0.8, x, (RAIL.y - 0.55) / 2, RAIL.z + 1.1);
            rbox(1.0, 0.7, RAIL.width + 0.8, x, RAIL.y - 0.9, RAIL.z);
            rbox(0.16, 5.2, 0.16, x, RAIL.y + 2.6, RAIL.z + RAIL.width / 2 + 0.1);
            rbox(0.12, 0.12, RAIL.width, x, RAIL.y + 5.0, RAIL.z);
        }
        rbox(RAIL.x1 - RAIL.x0, 0.04, 0.04, 0, RAIL.y + 4.7, RAIL.z);
        const railGeo = keep(mergeAll(T, railParts));
        railParts.forEach(g => g.dispose());
        const litVertex = (instanced) => /* glsl */`
            varying vec3 vWorld; varying vec3 vNormal; varying vec3 vLocal;
            #include <fog_pars_vertex>
            void main(){
                mat4 m = modelMatrix${instanced ? ' * instanceMatrix' : ''};
                vec4 w = m * vec4(position, 1.0);
                vWorld = w.xyz; vNormal = normalize(mat3(m) * normal); vLocal = position;
                vec4 mvPosition = viewMatrix * w;
                gl_Position = projectionMatrix * mvPosition;
                #include <fog_vertex>
            }`;
        const railMat = keep(new T.ShaderMaterial({
            fog: true,
            uniforms: Object.assign(T.UniformsUtils.clone(T.UniformsLib.fog), shared),
            vertexShader: litVertex(false),
            fragmentShader: /* glsl */`
                ${S.GLSL_COMMON}
                ${S.GLSL_LIGHTS}
                varying vec3 vWorld; varying vec3 vNormal; varying vec3 vLocal;
                #include <fog_pars_fragment>
                void main(){
                    vec3 n = normalize(vNormal);
                    // 旧钢梁：深灰绿的漆，接缝和锈水。
                    float g = kwFbm(vWorld.xy * vec2(0.8, 2.5) + vWorld.z);
                    vec3 alb = mix(vec3(0.11, 0.13, 0.13), vec3(0.2, 0.12, 0.07), smoothstep(0.55, 0.8, g));
                    alb *= 0.75 + 0.25 * step(0.04, fract(vWorld.x / 2.0));
                    alb *= 1.0 - uWet * 0.3;
                    // 桥底背光，压得很暗，只留一点被街灯扫到的边。
                    alb *= n.y < -0.5 ? 0.18 : 0.38;
                    kwGlowScale = 0.3;
                    vec3 col = kwLight(vWorld, n, alb, 0.7);
                    gl_FragColor = vec4(col, 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    #include <fog_fragment>
                }`
        }));
        // 沙盒截面裁切时，高架和列车的盒子往南多让一米（见 kowloon-sandbox.js）。
        railMat.userData.kwSandboxBox = 'rail';
        const rail = new T.Mesh(railGeo, railMat);
        rail.name = 'kowloon-rail';
        rail.frustumCulled = false;
        group.add(rail);

        const CARS = 5, CAR_LEN = 15, CAR_GAP = 0.8;
        const carGeo = keep(new T.BoxGeometry(CAR_LEN, 2.9, 2.5));
        const carMat = keep(new T.ShaderMaterial({
            fog: true,
            uniforms: Object.assign(T.UniformsUtils.clone(T.UniformsLib.fog), shared),
            vertexShader: litVertex(true),
            fragmentShader: /* glsl */`
                ${S.GLSL_COMMON}
                ${S.GLSL_LIGHTS}
                varying vec3 vWorld; varying vec3 vNormal; varying vec3 vLocal;
                #include <fog_pars_fragment>
                void main(){
                    vec3 n = normalize(vNormal);
                    vec2 uv = vec2(vLocal.x / ${CAR_LEN.toFixed(1)} + 0.5, vLocal.y / 2.9 + 0.5);
                    // 车身：暗银灰，腰线一道橙色。
                    vec3 alb = mix(vec3(0.2, 0.21, 0.22), vec3(0.75, 0.3, 0.08), step(0.3, uv.y) * step(uv.y, 0.36));
                    vec3 col = kwLight(vWorld, n, alb, 0.5);
                    float side = step(0.5, abs(n.z));
                    // 侧窗：一排亮着冷白灯的窗，窗间有立柱，车门处窗更高。
                    float cellX = fract(uv.x * 9.0);
                    float win = step(0.5, uv.y) * step(uv.y, 0.82) * step(0.08, cellX) * step(cellX, 0.92) * step(0.03, uv.x) * step(uv.x, 0.97);
                    // 车里的人影：窗下半截有些暗块。
                    float head = step(0.6, kwHash(vec2(floor(uv.x * 27.0), 3.0))) * step(uv.y, 0.66);
                    vec3 inside = vec3(0.85, 0.95, 1.0) * (1.6 - head * 1.1);
                    col = mix(col, inside, win * side);
                    // 车头车尾：端面的灯。
                    float endFace = step(0.5, abs(n.x));
                    float lamp = endFace * (1.0 - smoothstep(0.1, 0.22, length(vec2(abs(vLocal.z) - 0.8, vLocal.y + 0.7))));
                    col += vec3(1.0, 0.9, 0.7) * lamp * 4.0;
                    gl_FragColor = vec4(col, 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    #include <fog_fragment>
                }`
        }));
        carMat.userData.kwSandboxBox = 'rail';
        const cars = new T.InstancedMesh(carGeo, carMat, CARS);
        cars.name = 'kowloon-train';
        cars.frustumCulled = false;
        group.add(cars);
        const TRAIN = { period: 38, speed: 24 };
        const trainLights = [];

        const tmp = { p: new T.Vector3(), q: new T.Quaternion(), s: new T.Vector3(1, 1, 1), m: new T.Matrix4(),
            fwd: new T.Vector3(), up: new T.Vector3(0, 1, 0), dir: new T.Vector3(), e: new T.Euler() };
        const beamLights = [];
        let flash = 0;

        const update = (state) => {
            const t = state.time || 0;
            if (scene.fog) fogColor.value.copy(scene.fog.color);
            // 烟霾颜色跟着城市地面暖光走，再提一点亮度。
            if (shared.uGlow) hazeColor.value.copy(shared.uGlow.value).multiplyScalar(0.8);
            flash = ctx.alley?.flash?.() || 0;
            towerMat.uniforms.uFlash.value = flash;
            beamLights.length = 0;
            let b = 0;
            craft.forEach((c, i) => {
                const a = t * c.speed + c.phase;
                const x = c.cx + Math.cos(a) * c.ax, z = c.cz + Math.sin(a) * c.az;
                const y = c.y + Math.sin(a * 2.0 + i) * 8;
                const vx = -Math.sin(a) * c.ax * c.speed, vz = Math.cos(a) * c.az * c.speed;
                tmp.p.set(x, y, z);
                tmp.fwd.set(vx, 0, vz).normalize();
                tmp.q.setFromUnitVectors(new T.Vector3(0, 0, 1), tmp.fwd);
                // 转弯时侧倾。
                tmp.e.set(0, 0, -Math.sign(c.speed) * 0.25);
                tmp.q.multiply(new T.Quaternion().setFromEuler(tmp.e));
                tmp.m.compose(tmp.p, tmp.q, tmp.s);
                bodies.setMatrixAt(i, tmp.m);
                const side = new T.Vector3(1, 0, 0).applyQuaternion(tmp.q);
                navPos.set([x - side.x * 4.6, y, z - side.z * 4.6, x + side.x * 4.6, y, z + side.z * 4.6,
                    x, y - 1.2 - (Math.floor(t * 1.4 + i) % 2) * 400, z], i * 9);
                if (c.beam) {
                    // 光柱往前下方，左右慢慢扫。
                    const sweep = Math.sin(t * 0.35 + i * 2.1) * 0.5;
                    tmp.dir.copy(tmp.fwd).applyAxisAngle(tmp.up, sweep).multiplyScalar(0.55).add(new T.Vector3(0, -1, 0)).normalize();
                    const len = Math.min(220, (y - 4) / Math.max(0.2, -tmp.dir.y));
                    const qb = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, -1, 0), tmp.dir);
                    tmp.m.compose(tmp.p, qb, new T.Vector3(1 + len * 0.012, len, 1 + len * 0.012));
                    beams.setMatrixAt(b, tmp.m);
                    b += 1;
                    // 光柱落点：只有落在城寨附近才算一盏灯。
                    const hit = tmp.p.clone().addScaledVector(tmp.dir, len * 0.8);
                    if (Math.abs(hit.x) < 140 && Math.abs(hit.z) < 110) {
                        beamLights.push({ position: [hit.x, Math.max(hit.y, 20), hit.z], color: [0.75, 0.9, 1.0], intensity: 1.6, radius: 40, halo: false });
                    }
                }
            });
            // 列车：每个周期开过一趟，单双数趟方向相反。
            trainLights.length = 0;
            const pass = Math.floor(t / TRAIN.period), tt = t - pass * TRAIN.period;
            const dir = pass % 2 ? -1 : 1;
            const head = (dir > 0 ? RAIL.x0 : RAIL.x1) + dir * tt * TRAIN.speed;
            for (let i = 0; i < CARS; i += 1) {
                const x = head - dir * (i * (CAR_LEN + CAR_GAP) + CAR_LEN / 2);
                tmp.m.makeTranslation(x, RAIL.y + 1.75, RAIL.z);
                cars.setMatrixAt(i, tmp.m);
                // 车窗的光洒在对面楼和街上。
                if (i % 2 === 0 && Math.abs(x) < 130) trainLights.push({ position: [x, RAIL.y + 1.6, RAIL.z - 2.2], color: [0.8, 0.92, 1.0], intensity: 1.1, radius: 16, halo: false });
            }
            cars.instanceMatrix.needsUpdate = true;
            bodies.instanceMatrix.needsUpdate = true;
            beams.instanceMatrix.needsUpdate = true;
            navGeo.attributes.position.needsUpdate = true;
        };

        return {
            group,
            update,
            lights: () => beamLights.concat(trainLights),
            rail: RAIL,
            stats: () => ({ megaTowers: TOWERS.length, stacks: STACKS.length, craft: CRAFT, trainCars: CARS }),
            towers: TOWERS,
            dispose() {
                scene.remove(group);
                disposables.forEach(d => d.dispose());
            }
        };
    };

    // 小的合并：各部件先转成非索引，再把 position/normal 拼起来。
    const mergeAll = (T, geos) => {
        const list = geos.map(g => (g.index ? g.toNonIndexed() : g));
        const out = new T.BufferGeometry();
        ['position', 'normal'].forEach(name => {
            const total = list.reduce((s, g) => s + g.attributes[name].array.length, 0);
            const arr = new Float32Array(total);
            let o = 0;
            list.forEach(g => { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; });
            out.setAttribute(name, new T.Float32BufferAttribute(arr, 3));
        });
        list.forEach((g, i) => { if (g !== geos[i]) g.dispose(); });
        return out;
    };

    global.MusicStageKowloonSkyline = Object.freeze({ create, TOWERS, STACKS });
})(typeof window !== 'undefined' ? window : globalThis);
