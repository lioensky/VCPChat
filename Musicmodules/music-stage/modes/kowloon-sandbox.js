/*
 * 町景：沙盒截面。把城寨切出一块放在底座上当模型看：
 *   - 切面上补「剖开的楼」：楼板、隔墙、一间间亮着灯的房间、楼梯间和管井；
 *   - 地面以下是底座：路面、结构板、管线层、地铁隧道、土层、岩层，最下面一圈托盘；
 *   - 盒子以外的东西（远景、天空、其余街区）在着色器里按世界坐标裁掉。
 *
 * 裁切不改各模块的几何：给场景里每个材质补一小段着色器，用片元的世界坐标
 * 判断在不在盒子里。关掉时 kwSbOn=0，只多一次比较。
 */
(function (global) {
    'use strict';

    // 切哪一块：主屏、牌楼和南面外街都在里面；东、西、北三刀都切在楼身上。
    const BOX = Object.freeze({ x0: -30, x1: 38, z0: 8, z1: 72, depth: 14, rim: 2.6, trim: 1.3 });
    const MAIN_RE = /void\s+main\s*\(\s*(?:void)?\s*\)\s*\{/;

    // main() 的右花括号位置；找不到返回 -1。
    const mainEnd = (src) => {
        const m = MAIN_RE.exec(src);
        if (!m) return -1;
        let depth = 1;
        for (let i = m.index + m[0].length; i < src.length; i += 1) {
            const c = src[i];
            if (c === '{') depth += 1;
            else if (c === '}') { depth -= 1; if (depth === 0) return i; }
        }
        return -1;
    };
    const PARS = '\nuniform float kwSbOn;uniform vec4 kwSbBox;varying vec4 vKwSb;\n';
    const patchVertex = (src) => {
        const end = mainEnd(src);
        if (end < 0 || src.includes('vKwSb')) return null;
        const body = src.slice(0, end) + '\nif(kwSbOn>0.5)vKwSb=kwSbInv*gl_Position;\n' + src.slice(end);
        return body.replace(MAIN_RE, m => `${PARS}uniform mat4 kwSbInv;\n${m}`);
    };
    const patchFragment = (src) => {
        if (!MAIN_RE.test(src) || src.includes('vKwSb')) return null;
        return src.replace(MAIN_RE, m => `${PARS}${m}
            if(kwSbOn>0.5){vec3 kwQ=vKwSb.xyz/vKwSb.w;
                if(kwQ.x<kwSbBox.x||kwQ.x>kwSbBox.y||kwQ.z<kwSbBox.z||kwQ.z>kwSbBox.w)discard;}`);
    };

    const create = (T, ctx) => {
        const { scene, layout } = ctx;
        const FLOOR = layout.FLOOR;
        const owned = [];
        const keep = (o) => { owned.push(o); return o; };
        const on = { value: 0 };
        const inv = { value: new T.Matrix4() };
        const box = { value: new T.Vector4(BOX.x0, BOX.x1, BOX.z0, BOX.z1) };
        // 高架和列车贴着南边那一刀，给它们的盒子往外让一米，桥面不会被削掉半边。
        const boxRail = { value: new T.Vector4(BOX.x0, BOX.x1, BOX.z0, BOX.z1 + 1.0) };
        const uniformsFor = (m) => ({ kwSbOn: on, kwSbInv: inv, kwSbBox: m.userData?.kwSandboxBox === 'rail' ? boxRail : box });

        /* ---------------- 给全场材质补裁切 ---------------- */
        const patched = new WeakSet();
        const patchMaterial = (m) => {
            if (!m || patched.has(m) || m.userData?.kwSandboxFree) return;
            patched.add(m);
            if (m.isShaderMaterial) {
                const v = patchVertex(m.vertexShader), f = patchFragment(m.fragmentShader);
                if (!v || !f) return;
                m.vertexShader = v; m.fragmentShader = f;
                Object.assign(m.uniforms, uniformsFor(m));
                m.needsUpdate = true;
                return;
            }
            const before = m.onBeforeCompile;
            const key = m.customProgramCacheKey();
            m.onBeforeCompile = (shader, renderer) => {
                if (before) before.call(m, shader, renderer);
                const v = patchVertex(shader.vertexShader), f = patchFragment(shader.fragmentShader);
                if (!v || !f) return;
                shader.vertexShader = v; shader.fragmentShader = f;
                Object.assign(shader.uniforms, uniformsFor(m));
            };
            m.customProgramCacheKey = () => `${key}|kwSb`;
            m.needsUpdate = true;
        };
        let scanAt = -Infinity;
        const scan = (force) => {
            const now = global.performance?.now?.() ?? Date.now();
            if (!force && now - scanAt < 1000) return;
            scanAt = now;
            scene.traverse(o => {
                if (!o.material) return;
                (Array.isArray(o.material) ? o.material : [o.material]).forEach(patchMaterial);
            });
        };

        /* ---------------- 切面：剖开的楼 ---------------- */
        const group = new T.Group();
        group.name = 'kowloon-sandbox';
        group.visible = false;
        const quads = { position: [], aUv: [], aInfo: [], aBasis: [], index: [] };
        // 一块竖着的面：a→b 是沿墙方向（从外面看从左到右），法线朝外。
        const quad = (out, a, b, y0, y1, normal, info) => {
            const base = out.position.length / 3;
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
            [[a, y0, 0], [b, y0, len], [b, y1, len], [a, y1, 0]].forEach(([p, y, u]) => {
                out.position.push(p[0], y, p[1]);
                out.aUv.push(u, y);
                out.aInfo.push(len, info[0], info[1], info[2]);
                out.aBasis.push(tx, tz, normal[0], normal[1]);
            });
            out.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        const seedOf = (n) => ((n >>> 0) % 9973) / 9973 * 61.7 + 1.3;
        const E = 0.02;
        const solids = layout.lots.filter(l => l.height > 0).map(l => ({ ...l, y0: 0, y1: l.height, s: seedOf(l.seed) }))
            .concat((layout.bridges || []).map((b, i) => ({ ...b, s: seedOf(layout.hash ? 7717 * (i + 3) : i * 7717 + 11), bridge: true })));
        solids.forEach(l => {
            const z0 = Math.max(l.z0, BOX.z0), z1 = Math.min(l.z1, BOX.z1);
            const x0 = Math.max(l.x0, BOX.x0), x1 = Math.min(l.x1, BOX.x1);
            const info = [l.y1, l.y0, l.s];
            if (z1 - z0 > 0.2) {
                if (l.x0 < BOX.x1 - E && l.x1 > BOX.x1 + E) quad(quads, [BOX.x1, z1], [BOX.x1, z0], l.y0, l.y1, [1, 0], info);
                if (l.x0 < BOX.x0 - E && l.x1 > BOX.x0 + E) quad(quads, [BOX.x0, z0], [BOX.x0, z1], l.y0, l.y1, [-1, 0], info);
            }
            if (x1 - x0 > 0.2 && l.z0 < BOX.z0 - E && l.z1 > BOX.z0 + E) quad(quads, [x1, BOX.z0], [x0, BOX.z0], l.y0, l.y1, [0, -1], info);
        });
        const geometryOf = (q) => {
            const g = keep(new T.BufferGeometry());
            g.setAttribute('position', new T.Float32BufferAttribute(q.position, 3));
            g.setAttribute('aUv', new T.Float32BufferAttribute(q.aUv, 2));
            g.setAttribute('aInfo', new T.Float32BufferAttribute(q.aInfo, 4));
            g.setAttribute('aBasis', new T.Float32BufferAttribute(q.aBasis, 4));
            g.setIndex(q.index);
            return g;
        };
        const COMMON = global.MusicStageKowloonShared.GLSL_COMMON;
        const VERT = /* glsl */`
            attribute vec2 aUv; attribute vec4 aInfo; attribute vec4 aBasis;
            varying vec2 vUv; varying vec4 vInfo; varying vec4 vBasis; varying vec3 vWorld;
            void main(){
                vUv = aUv; vInfo = aInfo; vBasis = aBasis;
                vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
                gl_Position = projectionMatrix * viewMatrix * w;
            }`;
        const sectionUniforms = {
            uTime: ctx.lightUniforms.uTime, uView: { value: new T.Vector3(0, -0.5, -0.86) },
            uPulse: { value: 0 }, uAccent: { value: new T.Color('#f2a900') }, uDay: { value: 0 }
        };
        const capMat = keep(new T.ShaderMaterial({
            uniforms: sectionUniforms,
            vertexShader: VERT,
            fragmentShader: /* glsl */`
                uniform float uTime, uPulse, uDay; uniform vec3 uView, uAccent;
                varying vec2 vUv; varying vec4 vInfo; varying vec4 vBasis; varying vec3 vWorld;
                ${COMMON}
                const float FLOOR = ${FLOOR.toFixed(3)};
                // 剖开的混凝土：浅灰，带一点骨料和斜纹，和夜色里的楼身分得开。
                vec3 cutConcrete(vec2 p){
                    float n = kwNoise(p * 9.0) * 0.5 + kwNoise(p * 31.0) * 0.5;
                    float hatch = smoothstep(0.42, 0.5, abs(fract((p.x + p.y) * 3.2) - 0.5));
                    return vec3(0.25, 0.245, 0.235) * (0.72 + n * 0.36) * (1.0 - hatch * 0.16);
                }
                void main(){
                    float len = vInfo.x, top = vInfo.y, base = vInfo.z, seed = vInfo.w;
                    float u = vUv.x, y = vUv.y;
                    // 开间：整面墙均分成 3 米上下的格子。
                    float cols = max(1.0, floor(len / 3.3 + 0.5));
                    float cw = len / cols;
                    float col = floor(u / cw), fl = floor((y - base) / FLOOR + 1e-3);
                    float cx = u - col * cw, cy = (y - base) - fl * FLOOR;
                    float wall = 0.11, slab = 0.2;
                    bool solid = cy < slab || cx < wall || cx > cw - wall
                        || u < 0.26 || u > len - 0.26 || y > top - 0.3;
                    vec3 colr;
                    float h = kwHash(vec2(col * 7.13 + seed, fl * 3.71 + seed * 1.7));
                    float hc = kwHash(vec2(col * 5.3 + seed * 2.1, 9.7));
                    if (solid) {
                        colr = cutConcrete(vec2(u, y));
                        // 楼板里一排钢筋头。
                        if (cy < slab) colr = mix(colr, vec3(0.09, 0.07, 0.06), smoothstep(0.035, 0.02, length(vec2(fract(u * 3.0) - 0.5, (cy - slab * 0.5) * 3.0))));
                        colr *= 0.9 + uDay * 0.5;
                    } else {
                        // 视线进到房间里：和后墙、侧墙、地板、天花哪个先碰上。
                        vec3 d = vec3(dot(uView.xz, vBasis.xy), uView.y, -dot(uView.xz, vBasis.zw));
                        d.z = max(d.z, 0.05);
                        float depth = 1.7 + kwHash(vec2(col + seed, fl + 3.3)) * 0.9;
                        float x0 = wall, x1 = cw - wall, y0 = slab, y1 = FLOOR;
                        float tx = d.x > 0.0 ? (x1 - cx) / d.x : (x0 - cx) / min(d.x, -1e-4);
                        float ty = d.y > 0.0 ? (y1 - cy) / d.y : (y0 - cy) / min(d.y, -1e-4);
                        float tz = depth / d.z;
                        float t = min(tx, min(ty, tz));
                        vec3 p = vec3(cx, cy, 0.0) + d * t;
                        // 这间房是什么：楼梯间、管井，还是住人的。
                        bool stair = hc < 0.09, shaft = !stair && hc < 0.15;
                        // 灯：暖黄灯泡、冷白日光灯、电视蓝光、霓虹，还有没亮灯的。
                        vec3 lamp = vec3(1.0, 0.62, 0.3); float power = 1.0;
                        if (h < 0.2) { lamp = vec3(0.62, 0.86, 1.0); power = 0.9; }
                        else if (h < 0.3) { lamp = vec3(0.3, 0.5, 1.0); power = 0.45 + 0.3 * kwNoise(vec2(uTime * 7.0 + h * 40.0, h * 9.0)); }
                        else if (h < 0.38) { lamp = h < 0.34 ? vec3(1.0, 0.16, 0.55) : vec3(0.15, 0.9, 1.0); power = 0.8 + uPulse * 0.6; }
                        else if (h < 0.58) { power = 0.06; }
                        if (stair) { lamp = vec3(0.7, 0.9, 0.85); power = 0.55; }
                        if (shaft) { lamp = uAccent; power = 0.2; }
                        vec3 lp = vec3(cw * 0.5, y1 - 0.25, depth * 0.45);
                        float fall = 1.0 / (1.0 + dot(p - lp, p - lp) * 0.55);
                        // 墙角暗一点。
                        float ao = smoothstep(0.0, 0.5, min(min(p.x - x0, x1 - p.x), min(p.y - y0, y1 - p.y) + 0.15) + (depth - p.z) * 0.5);
                        // 墙面颜色：石灰绿、米黄、旧蓝、瓷砖白。
                        float hw = kwHash(vec2(col * 3.3 + seed, fl * 8.1));
                        vec3 paint = hw < 0.3 ? vec3(0.3, 0.38, 0.32) : hw < 0.6 ? vec3(0.44, 0.39, 0.3) : hw < 0.8 ? vec3(0.26, 0.32, 0.4) : vec3(0.44, 0.44, 0.42);
                        vec3 surf = paint;
                        float glow = 0.0;
                        if (t == tz) {
                            vec2 q = vec2(p.x - x0, p.y - y0) / vec2(x1 - x0, y1 - y0);
                            // 墙裙。
                            surf = mix(paint * 0.55, paint, step(0.38, q.y));
                            if (stair) {
                                // 楼梯：两跑斜线加休息平台。
                                surf = vec3(0.3, 0.32, 0.31);
                                surf = mix(surf, vec3(0.08), smoothstep(0.05, 0.02, abs(q.y - (q.x < 0.5 ? q.x : 1.0 - q.x) - 0.02)));
                                surf = mix(surf, vec3(0.08), smoothstep(0.03, 0.01, abs(q.y - (q.x < 0.5 ? q.x : 1.0 - q.x) - 0.36)) * 0.7);
                            } else if (shaft) {
                                // 管井：一排竖管，几根线缆发着光。
                                float k = fract(q.x * 6.0);
                                float pipe = smoothstep(0.5, 0.2, abs(k - 0.5));
                                float id = floor(q.x * 6.0);
                                surf = mix(vec3(0.07), vec3(0.2, 0.19, 0.17) * (0.6 + pipe), pipe);
                                float live = step(0.6, kwHash(vec2(id + seed, col)));
                                float run = fract(y * 0.18 - uTime * (0.25 + 0.2 * kwHash(vec2(id, seed))));
                                glow = live * pipe * (0.25 + smoothstep(0.9, 1.0, run) * 2.0 * (1.0 + uPulse));
                                lamp = mix(uAccent, vec3(0.2, 0.9, 1.0), step(0.5, kwHash(vec2(id * 3.1, seed))));
                            } else {
                                // 门、窗、搁板、月历。
                                float door = step(abs(q.x - (0.22 + hw * 0.5)), 0.13) * step(q.y, 0.74);
                                surf = mix(surf, paint * 0.28, door);
                                float shelf = step(0.72, hw) * step(abs(q.y - 0.62), 0.02) * step(abs(q.x - 0.72), 0.2);
                                surf = mix(surf, vec3(0.1, 0.07, 0.05), shelf);
                                float cal = step(hw, 0.45) * step(abs(q.x - 0.84), 0.06) * step(abs(q.y - 0.6), 0.11);
                                surf = mix(surf, vec3(0.7, 0.12, 0.1), cal);
                            }
                        } else if (t == ty) {
                            if (d.y < 0.0) { vec2 g = abs(fract(p.xz * 2.2) - 0.5); surf = vec3(0.3, 0.27, 0.24) * (0.8 + 0.2 * step(0.46, max(g.x, g.y))); }
                            else { surf = vec3(0.5); glow = power * 2.2 * smoothstep(0.5, 0.42, abs(p.x - cw * 0.5)) * smoothstep(0.1, 0.06, abs(p.z - depth * 0.45)); }
                        } else surf = paint * 0.8;
                        colr = surf * lamp * power * (0.1 + 2.3 * fall) * (0.45 + 0.55 * ao) + lamp * glow;
                        // 房间中间一层家具和人的剪影。
                        if (!stair && !shaft) {
                            float zf = depth * (0.35 + 0.3 * hw);
                            float tf = zf / d.z;
                            if (tf < t) {
                                vec3 f = vec3(cx, cy, 0.0) + d * tf;
                                vec2 q = vec2(f.x - x0, f.y - y0);
                                float w = x1 - x0, mask = 0.0;
                                float kind = kwHash(vec2(col * 1.7 + seed * 3.0, fl * 2.9));
                                if (kind < 0.3) {
                                    // 上下铺。
                                    float bx = step(abs(q.x - w * 0.36), w * 0.3);
                                    mask = bx * (step(abs(q.y - 0.45), 0.07) + step(abs(q.y - 1.5), 0.06));
                                    mask += step(abs(abs(q.x - w * 0.36) - w * 0.3), 0.035) * step(q.y, 1.9);
                                } else if (kind < 0.6) {
                                    // 桌子和凳子。
                                    mask = step(abs(q.x - w * 0.6), w * 0.22) * step(abs(q.y - 0.76), 0.04);
                                    mask += step(abs(abs(q.x - w * 0.6) - w * 0.2), 0.03) * step(q.y, 0.76);
                                    mask += step(abs(q.x - w * 0.2), 0.16) * step(q.y, 0.45);
                                } else if (kind < 0.8) {
                                    // 柜子、叠起来的箱子。
                                    mask = step(abs(q.x - w * 0.25), w * 0.17) * step(q.y, 1.7);
                                    mask += step(abs(q.x - w * 0.7), w * 0.14) * step(q.y, 0.9);
                                }
                                // 有人在：站着或坐着的一个影子。
                                float who = kwHash(vec2(col * 9.1 + seed, fl * 4.3));
                                if (who < 0.34 && power > 0.1) {
                                    float px = w * (0.3 + 0.5 * fract(who * 17.0));
                                    float tall = who < 0.2 ? 1.62 : 1.15;
                                    float body = smoothstep(0.2, 0.17, abs(q.x - px)) * step(q.y, tall - 0.22) * step(0.0, q.y);
                                    float head = smoothstep(0.13, 0.11, length(q - vec2(px, tall - 0.1)));
                                    mask += body + head;
                                }
                                colr = mix(colr, colr * 0.07 + vec3(0.012, 0.012, 0.014), clamp(mask, 0.0, 1.0));
                            }
                        }
                        colr += paint * uDay * 0.12;
                    }
                    // 墙和楼板的切口描一道深线，像剖面图。
                    gl_FragColor = vec4(colr, 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        capMat.userData.kwSandboxFree = true;
        const caps = new T.Mesh(geometryOf(quads), capMat);
        caps.name = 'kowloon-sandbox-sections';
        caps.frustumCulled = false;
        group.add(caps);

        /* ---------------- 底座：地面以下的分层 ---------------- */
        const base = { position: [], aUv: [], aInfo: [], aBasis: [], index: [] };
        const D = BOX.depth;
        // info: [面的种类 0 侧面 / 1 托盘侧面 / 2 托盘顶面, 是不是东西向的切面, 0]
        quad(base, [BOX.x0, BOX.z1], [BOX.x1, BOX.z1], -D, 0, [0, 1], [0, 0, 0]);
        quad(base, [BOX.x1, BOX.z1], [BOX.x1, BOX.z0], -D, 0, [1, 0], [0, 1, 0]);
        quad(base, [BOX.x1, BOX.z0], [BOX.x0, BOX.z0], -D, 0, [0, -1], [0, 0, 0]);
        quad(base, [BOX.x0, BOX.z0], [BOX.x0, BOX.z1], -D, 0, [-1, 0], [0, 1, 0]);
        const R = BOX.rim, TR = BOX.trim;
        const tx0 = BOX.x0 - R, tx1 = BOX.x1 + R, tz0 = BOX.z0 - R, tz1 = BOX.z1 + R;
        quad(base, [tx0, tz1], [tx1, tz1], -D - TR, -D, [0, 1], [1, 0, 0]);
        quad(base, [tx1, tz1], [tx1, tz0], -D - TR, -D, [1, 0], [1, 0, 0]);
        quad(base, [tx1, tz0], [tx0, tz0], -D - TR, -D, [0, -1], [1, 0, 0]);
        quad(base, [tx0, tz0], [tx0, tz1], -D - TR, -D, [-1, 0], [1, 0, 0]);
        // 托盘顶面。
        {
            const b = base.position.length / 3;
            [[tx0, tz1], [tx1, tz1], [tx1, tz0], [tx0, tz0]].forEach(([x, z]) => {
                base.position.push(x, -D, z); base.aUv.push(x, z); base.aInfo.push(0, 2, 0, 0); base.aBasis.push(1, 0, 0, 0);
            });
            base.index.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
        const baseMat = keep(new T.ShaderMaterial({
            uniforms: { ...sectionUniforms, uBox: { value: new T.Vector4(BOX.x0, BOX.x1, BOX.z0, BOX.z1) } },
            vertexShader: VERT,
            fragmentShader: /* glsl */`
                uniform float uTime, uPulse, uDay; uniform vec3 uAccent; uniform vec4 uBox;
                varying vec2 vUv; varying vec4 vInfo; varying vec4 vBasis; varying vec3 vWorld;
                ${COMMON}
                float ring(vec2 p, float r, float w){ return smoothstep(w, w * 0.4, abs(length(p) - r)); }
                void main(){
                    float kind = vInfo.y;
                    vec3 c;
                    if (kind > 1.5) {
                        // 托盘顶面：深色金属，贴着底座一圈细光。
                        float dx = max(uBox.x - vWorld.x, vWorld.x - uBox.y), dz = max(uBox.z - vWorld.z, vWorld.z - uBox.w);
                        float edge = max(dx, dz);
                        c = vec3(0.028, 0.03, 0.034) * (0.8 + 0.4 * kwNoise(vWorld.xz * 6.0));
                        c += uAccent * (0.5 + uPulse * 0.6) * smoothstep(0.5, 0.0, edge) * 0.55;
                        c += uAccent * 0.9 * smoothstep(0.16, 0.06, abs(edge - 1.7));
                    } else if (kind > 0.5) {
                        c = vec3(0.03, 0.032, 0.036) * (0.7 + 0.5 * kwNoise(vec2(vUv.x * 2.0, vUv.y * 9.0)));
                        c += uAccent * 0.5 * smoothstep(0.05, 0.02, abs(vUv.y + ${(D + 0.35).toFixed(2)}));
                    } else {
                        // 沿墙的世界坐标，四个面在转角对得上。
                        float s = vBasis.x != 0.0 ? vWorld.x : vWorld.z;
                        float d = -vUv.y;
                        float wob = (kwNoise(vec2(s * 0.09, 3.0)) - 0.5) * 1.6 + (kwNoise(vec2(s * 0.5, 7.0)) - 0.5) * 0.3;
                        // 从上到下：路面、结构板、回填层（管线都在这）、黏土、岩层。
                        if (d < 0.22) c = vec3(0.05, 0.052, 0.058) + vec3(0.1) * smoothstep(0.05, 0.0, d);
                        else if (d < 0.95) {
                            c = vec3(0.12, 0.118, 0.114) * (0.75 + 0.3 * kwNoise(vec2(s, d) * 12.0));
                            c = mix(c, vec3(0.08, 0.06, 0.05), smoothstep(0.05, 0.03, length(vec2(fract(s * 2.5) - 0.5, (d - 0.6) * 2.5))));
                        } else if (d < 5.2 + wob) {
                            float g = kwNoise(vec2(s, d) * 5.0) * 0.6 + kwNoise(vec2(s, d) * 21.0) * 0.4;
                            c = vec3(0.06, 0.05, 0.042) * (0.6 + 0.8 * g);
                            c = mix(c, vec3(0.11, 0.105, 0.1), step(0.83, kwNoise(vec2(s, d) * 3.3)) * 0.5);
                        } else if (d < 9.4 + wob * 1.4) {
                            float band = kwNoise(vec2(s * 0.3, d * 2.2 + wob));
                            c = mix(vec3(0.062, 0.042, 0.034), vec3(0.09, 0.066, 0.05), band) * (0.8 + 0.3 * kwNoise(vec2(s, d) * 14.0));
                        } else {
                            float crack = smoothstep(0.03, 0.0, abs(fract((s * 0.6 + d * 0.9) * 0.37 + kwNoise(vec2(s, d) * 0.4) * 0.6) - 0.5));
                            c = vec3(0.045, 0.048, 0.056) * (0.7 + 0.5 * kwNoise(vec2(s * 0.7, d * 2.3))) * (1.0 - crack * 0.5);
                        }
                        // 桩：从结构板往下打进岩层。
                        float pile = step(abs(fract(s / 8.4 + 0.3) - 0.5) * 8.4, 0.38) * step(0.95, d) * step(d, 10.6 + kwHash(vec2(floor(s / 8.4 + 0.3), 2.0)) * 2.0);
                        c = mix(c, vec3(0.085, 0.084, 0.08) * (0.8 + 0.25 * kwNoise(vec2(s * 8.0, d * 2.0))), pile);
                        // 管线：每 7 米一组，水管、电缆排管。
                        float cell = floor(s / 7.0), hs = kwHash(vec2(cell, 4.4));
                        vec2 pp = vec2(s - (cell + 0.25 + hs * 0.5) * 7.0, d - (1.7 + kwHash(vec2(cell, 8.8)) * 2.4));
                        float pr = 0.28 + hs * 0.3;
                        c = mix(c, vec3(0.02), step(length(pp), pr));
                        c = mix(c, hs < 0.5 ? vec3(0.4, 0.22, 0.1) : vec3(0.14, 0.3, 0.34), ring(pp, pr, 0.09));
                        vec2 dq = vec2(s - (cell + 0.72) * 7.0, d - 1.55);
                        if (kwHash(vec2(cell, 1.1)) < 0.6 && abs(dq.x) < 0.62 && abs(dq.y) < 0.36) {
                            vec2 k = fract(dq * vec2(3.2, 4.2)) - 0.5;
                            float live = step(0.45, kwHash(floor(dq * vec2(3.2, 4.2)) + cell));
                            c = vec3(0.16, 0.16, 0.155);
                            c = mix(c, vec3(0.01), step(length(k), 0.3));
                            c += mix(uAccent, vec3(0.2, 0.9, 1.0), step(0.5, hs)) * live * smoothstep(0.2, 0.05, length(k)) * (0.9 + uPulse * 1.2);
                        }
                        // 南面外街底下一条隧道，东西两个切面上各露一个口。
                        if (vInfo.z > 0.5) {
                            vec2 tq = vec2(vWorld.z - 66.0, d - 7.4);
                            float r = length(tq);
                            if (r < 3.1) {
                                c = vec3(0.16, 0.157, 0.15) * (0.8 + 0.3 * kwNoise(tq * 9.0));
                                if (r < 2.7) {
                                    float lit = smoothstep(2.7, 0.4, r);
                                    c = vec3(0.006, 0.007, 0.009) + vec3(1.0, 0.72, 0.4) * 0.03 * lit;
                                    // 轨面、两侧的灯带。
                                    c = mix(c, vec3(0.05), step(1.75, tq.y));
                                    c += vec3(0.5, 0.95, 1.0) * smoothstep(0.12, 0.03, length(vec2(abs(tq.x) - 2.2, tq.y + 0.5))) * (1.4 + uPulse);
                                    c += vec3(1.0, 0.6, 0.25) * smoothstep(0.1, 0.02, length(vec2(abs(tq.x) - 0.72, tq.y - 1.7))) * 0.8;
                                }
                            }
                        } else {
                            // 南北两个面上是顺着隧道方向的，露一条排水箱涵。
                            vec2 bq = vec2(s - (uBox.x + (uBox.y - uBox.x) * 0.3), d - 4.2);
                            if (abs(bq.x) < 1.5 && abs(bq.y) < 1.1) {
                                c = vec3(0.2, 0.2, 0.19);
                                if (abs(bq.x) < 1.25 && abs(bq.y) < 0.85) {
                                    c = vec3(0.014, 0.018, 0.02);
                                    float water = step(0.35, bq.y);
                                    c = mix(c, vec3(0.03, 0.2, 0.19) * (0.8 + 0.4 * sin(bq.x * 9.0 + uTime * 2.0)), water);
                                }
                            }
                        }
                        // 地面线：一条亮边，把上面的街和下面的土分开。
                        c += vec3(0.5, 0.52, 0.56) * smoothstep(0.07, 0.0, d) * 0.25;
                        c *= 1.0 + uDay * 0.8;
                    }
                    gl_FragColor = vec4(c, 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        baseMat.userData.kwSandboxFree = true;
        const plinth = new T.Mesh(geometryOf(base), baseMat);
        plinth.name = 'kowloon-sandbox-plinth';
        plinth.frustumCulled = false;
        group.add(plinth);

        /* ---------------- 背景：一块干净的暗色幕布 ---------------- */
        const backdropMat = keep(new T.ShaderMaterial({
            uniforms: { uTop: { value: new T.Color('#070a10') }, uBottom: { value: new T.Color('#141a24') }, uGlow: { value: new T.Color('#3a2412') } },
            depthTest: false, depthWrite: false,
            vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,1.0,1.0);}',
            fragmentShader: /* glsl */`
                uniform vec3 uTop, uBottom, uGlow; varying vec2 vUv;
                void main(){
                    vec3 c = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
                    // 模型背后一团很淡的城市光。
                    float g = exp(-dot((vUv - vec2(0.5, 0.56)) * vec2(1.5, 2.1), (vUv - vec2(0.5, 0.56)) * vec2(1.5, 2.1)) * 3.0);
                    c += uGlow * g * 0.55;
                    c *= 1.0 - 0.35 * dot(vUv - 0.5, vUv - 0.5) * 2.0;
                    gl_FragColor = vec4(c, 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        backdropMat.userData.kwSandboxFree = true;
        const backdrop = new T.Mesh(keep(new T.PlaneGeometry(2, 2)), backdropMat);
        backdrop.name = 'kowloon-sandbox-backdrop';
        backdrop.frustumCulled = false;
        backdrop.renderOrder = -1000;
        group.add(backdrop);
        scene.add(group);

        const forward = new T.Vector3();
        let active = false;
        return {
            box: BOX,
            get active() { return active; },
            // 每帧：开关、相机矩阵、切面房间用的视线方向。
            update(enabled, camera, state) {
                active = Boolean(enabled);
                on.value = active ? 1 : 0;
                group.visible = active;
                if (!active) return;
                scan(false);
                inv.value.copy(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
                camera.getWorldDirection(forward);
                sectionUniforms.uView.value.copy(forward);
                sectionUniforms.uPulse.value = Math.min(1, (state?.audio?.energy || 0) * 0.6 + (state?.audio?.impact || 0) * 0.5);
            },
            setPalette(palette = {}) {
                sectionUniforms.uAccent.value.set(palette.accent || '#f2a900');
                sectionUniforms.uDay.value = palette.light ? 1 : 0;
                backdropMat.uniforms.uTop.value.set(palette.light ? '#8c949c' : '#070a10');
                backdropMat.uniforms.uBottom.value.set(palette.light ? '#b9bdc0' : '#141a24');
                backdropMat.uniforms.uGlow.value.set(palette.light ? '#30302c' : '#3a2412');
            },
            scan: () => scan(true),
            stats: () => ({ sandbox: active, sandboxSections: quads.index.length / 6 }),
            dispose() {
                scene.remove(group);
                owned.forEach(o => o.dispose?.());
            }
        };
    };

    const api = Object.freeze({ create, BOX, patchVertex, patchFragment });
    global.MusicStageKowloonSandbox = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
