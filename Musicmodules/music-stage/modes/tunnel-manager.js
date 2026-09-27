(function (global) {
    'use strict';

    const U = global.MusicStageModeUtils;
    const R = global.MusicStageRuntime;
    if (!U || !R) throw new Error('MusicStage utilities must load before tunnel-manager.js');

    const { clamp, seededRandom } = R;

    const smooth = (v) => { const p = clamp(v); return p * p * (3 - 2 * p); };
    const easeOutCubic = (v) => { const p = clamp(v); return 1 - Math.pow(1 - p, 3); };
    const easeInCubic = (v) => { const p = clamp(v); return p * p * p; };
    const easeOutQuart = (v) => { const p = clamp(v); return 1 - Math.pow(1 - p, 4); };
    const lerp = (a, b, t) => a + (b - a) * t;

    const create = (container, services) => {
        const mode = U.makeModeBase('tunnel', '隧图', container, services);
        const fallback = U.createElement('div', 'tunnel-fallback');
        const fallbackLine = U.createElement('div', 'tunnel-fallback-line');
        const fallbackSub = U.createElement('div', 'stage-translation tunnel-fallback-sub');
        fallback.append(fallbackLine, fallbackSub);
        mode.root.appendChild(fallback);

        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let T = null, scene = null, camera = null, renderer = null, world = null;
        let initialized = false, fallbackMode = false, initializing = null;
        let latest = null, source = null, identity = '';
        let width = 1, height = 1, lastTime = null, paletteKey = '';
        // Keep the track clock as the single source of truth.  This makes seeks,
        // pause/resume and replay land on the same shot instead of inheriting
        // whatever distance happened to be accumulated before the seek.

        const tuning = () => ({
            ...(mode.config.modes?.tunnel || {}),
            animationIntensity: mode.config.animationIntensity ?? 1,
            reducedMotion: Boolean(reduced?.matches),
            quality: mode.config.quality
        });

        const renderFallback = (frame) => {
            fallback.hidden = false;
            const line = frame.activeLine;
            const key = line ? `${line.index}:${line.startTime}:${line.fullText}` : '';
            if (fallbackLine.dataset.key !== key) {
                fallbackLine.dataset.key = key;
                fallbackLine.replaceChildren();
                if (line) U.renderWords(fallbackLine, frame, 'tunnel-fallback-word');
                else fallbackLine.textContent = frame.track?.title || '等待进入隧图空间';
                fallbackSub.textContent = R.resolveSupplementalText(line);
            }
            U.updateWords(Array.from(fallbackLine.children), frame.wordStates || []);
        };

        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            if (!renderer || !camera) return;
            const cap = mode.config.quality === 'energy-saving' ? 1 : mode.config.quality === 'ultimate' ? 2 : 1.5;
            const dpr = Math.min(cap, global.devicePixelRatio || 1);
            renderer.setPixelRatio(dpr);
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            world?.resize?.(width, height, dpr);
        };

        const disposeGraphics = () => {
            world?.destroy?.();
            world = null;
            if (renderer) {
                renderer.dispose?.();
                renderer.forceContextLoss?.();
                renderer.domElement?.remove();
                renderer = null;
            }
            camera = null;
            scene = null;
            initialized = false;
        };

        const update = (frame) => {
            if (mode.destroyed || mode.suspended) return;
            latest = frame;
            if (!initialized) {
                renderFallback(frame);
                if (!fallbackMode) void initialize();
                return;
            }

            const nextIdentity = frame.track?.path || frame.track?.title || 'tunnel-track';
            if (source !== frame.lines || identity !== nextIdentity) {
                source = frame.lines;
                identity = nextIdentity;
                lastTime = null;
                world?.reset?.(frame.lines || [], identity);
            }

            const settings = tuning();
            const stagePal = services?.app?.stagePalette || {};
            const nextPalette = JSON.stringify(stagePal);
            if (nextPalette !== paletteKey) {
                paletteKey = nextPalette;
                world?.setPalette?.(stagePal);
            }

            const time = R.finiteNumber(frame.playbackTime);
            const dt = lastTime === null ? 0 : time - lastTime;
            const seeking = lastTime === null || dt < -0.1 || dt > 0.5;
            const live = frame.isPlaying && dt > 0 && !settings.reducedMotion;
            const reactivity = clamp(settings.audioReactivity ?? 1, 0, 2);

            const audio = live
                ? {
                    power: clamp(frame.audio.power) * reactivity,
                    bass: clamp(frame.audio.bass) * reactivity,
                    vocal: clamp(frame.audio.vocal) * reactivity,
                    treble: clamp(frame.audio.treble) * reactivity
                }
                : { power: 0, bass: 0, vocal: 0, treble: 0 };

            world.update(time, frame, settings, {
                seek: seeking,
                playing: live,
                dt: seeking ? 0.016 : Math.max(0.001, Math.min(0.08, dt)),
                ...audio
            }, camera);

            fallback.hidden = true;
            renderer.render(scene, camera);
            lastTime = time;
        };

        const initialize = () => {
            if (initializing) return initializing;
            initializing = Promise.resolve().then(async () => {
                T = global.THREE || await import('../../../vendor/three.module.js');
                if (mode.destroyed) return;

                scene = new T.Scene();
                const initialBg = new T.Color('#0a0d11');
                scene.background = initialBg;
                scene.fog = new T.FogExp2(initialBg, 0.00038);

                camera = new T.PerspectiveCamera(56, 1, 0.1, 4600);
                camera.position.set(0, 0, 0);

                renderer = new T.WebGLRenderer({
                    antialias: true,
                    alpha: false,
                    powerPreference: 'high-performance'
                });
                renderer.outputColorSpace = T.SRGBColorSpace;
                renderer.toneMapping = T.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.06;
                renderer.domElement.className = 'tunnel-canvas';
                mode.root.insertBefore(renderer.domElement, fallback);

                mode.scope.listen(renderer.domElement, 'webglcontextlost', (event) => {
                    event.preventDefault();
                    fallbackMode = true;
                    disposeGraphics();
                    if (latest) renderFallback(latest);
                });

                world = createTunnelWorld(T, scene, services?.app);
                initialized = true;
                resize();
                world.setPalette(services?.app?.stagePalette || {});
                if (latest) update(latest);
            }).catch((error) => {
                disposeGraphics();
                fallbackMode = true;
                if (!mode.destroyed) {
                    console.warn('[MusicStage:Tunnel] WebGL 加载失败，启用降级：', error);
                    if (latest) renderFallback(latest);
                }
            });
            return initializing;
        };

        mode.updateFrame = update;
        mode.resize = () => { resize(); if (latest && initialized) update(latest); };
        const baseConfig = mode.updateConfig;
        mode.updateConfig = (config) => { baseConfig(config); resize(); if (latest && initialized) update(latest); };
        mode.updateTheme = () => { if (latest && initialized) update(latest); };
        const resume = mode.resume;
        mode.resume = () => { resume(); lastTime = null; if (latest) update(latest); };
        mode.getDebugSnapshot = () => ({
            initialized,
            fallbackMode,
            distance: world?.distance || 0,
            currentSpeed: world?.currentSpeed || 0,
            cameraPos: camera?.position?.toArray() || null,
            activeLine: latest?.activeLine?.fullText || null
        });
        mode.scope.add(() => { disposeGraphics(); latest = source = null; });

        resize();
        void initialize();
        return mode;
    };

    /* =====================================================
     * 点阵模型生成器 —— 极简笔触描绘巨大天体
     * 每个模型带 shade 通道，标识子结构以便材质着色分级
     * ===================================================== */
    const createModelGenerators = () => {

        // 巨型行星：斐波那契球面 + 纬向暗纹 + 极冠辉点
        // shade: 0=纬线暗纹 1=主体表面 2=极冠辉点
        const generatePlanet = (radius, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const shade = new Float32Array(count);
            const golden = Math.PI * (3 - Math.sqrt(5));
            const latBands = [-0.52, -0.18, 0.22, 0.55];
            for (let i = 0; i < count; i += 1) {
                const u = rand();
                if (u < 0.10) {
                    const pole = rand() < 0.5 ? 1 : -1;
                    const theta = rand() * Math.PI * 2;
                    const capR = radius * (0.10 + rand() * 0.30);
                    pos[i * 3] = Math.cos(theta) * capR;
                    pos[i * 3 + 1] = pole * Math.sqrt(Math.max(0, radius * radius - capR * capR)) * (0.995 + rand() * 0.01);
                    pos[i * 3 + 2] = Math.sin(theta) * capR;
                    shade[i] = 2;
                } else if (u < 0.24) {
                    const lat = latBands[Math.floor(rand() * latBands.length)] + (rand() - 0.5) * 0.03;
                    const rr = Math.sqrt(Math.max(0, 1 - lat * lat)) * radius;
                    const theta = rand() * Math.PI * 2;
                    pos[i * 3] = Math.cos(theta) * rr;
                    pos[i * 3 + 1] = lat * radius;
                    pos[i * 3 + 2] = Math.sin(theta) * rr;
                    shade[i] = 0;
                } else {
                    const k = i + 0.5;
                    const y = 1 - (k / count) * 2;
                    const r = Math.sqrt(Math.max(0, 1 - y * y));
                    const phi = k * golden;
                    const jitter = 0.99 + rand() * 0.02;
                    pos[i * 3] = Math.cos(phi) * r * radius * jitter;
                    pos[i * 3 + 1] = y * radius * jitter;
                    pos[i * 3 + 2] = Math.sin(phi) * r * radius * jitter;
                    shade[i] = 1;
                }
            }
            return { pos, shade };
        };

        // 行星环：三段剖面 + 卡西尼缝
        // shade: 0=内亮带 1=中带 2=外散晕
        const generateRing = (innerRadius, outerRadius, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const shade = new Float32Array(count);
            const span = outerRadius - innerRadius;
            for (let i = 0; i < count; i += 1) {
                const u = rand();
                let r;
                if (u < 0.40) { r = innerRadius + span * rand() * 0.30; shade[i] = 0; }
                else if (u < 0.70) { r = innerRadius + span * (0.34 + rand() * 0.28); shade[i] = 1; }
                else { r = innerRadius + span * (0.66 + Math.pow(rand(), 1.7) * 0.34); shade[i] = 2; }
                const theta = rand() * Math.PI * 2;
                const thick = (rand() - 0.5) * (shade[i] === 2 ? 1.1 : 0.30);
                pos[i * 3] = Math.cos(theta) * r;
                pos[i * 3 + 1] = thick;
                pos[i * 3 + 2] = Math.sin(theta) * r;
            }
            return { pos, shade };
        };

        // 环形空间站：12 模块外环 + 4 辐条 + 中轴龙骨 + 航行灯
        // shade: 0=骨架辐条 1=舱体模块 2=航行灯 3=中轴
        const generateStation = (radius, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const shade = new Float32Array(count);
            for (let i = 0; i < count; i += 1) {
                const u = rand();
                if (u < 0.46) {
                    const modIdx = Math.floor(rand() * 12);
                    const a = (modIdx / 12) * Math.PI * 2 + (rand() - 0.5) * 0.30;
                    const r = radius + (rand() - 0.5) * 2.4;
                    pos[i * 3] = Math.cos(a) * r;
                    pos[i * 3 + 1] = Math.sin(a) * r;
                    pos[i * 3 + 2] = (rand() - 0.5) * 2.2;
                    shade[i] = 1;
                } else if (u < 0.70) {
                    const spoke = Math.floor(rand() * 4);
                    const a = (spoke / 4) * Math.PI * 2;
                    const d = rand() * radius * 0.94;
                    pos[i * 3] = Math.cos(a) * d;
                    pos[i * 3 + 1] = Math.sin(a) * d;
                    pos[i * 3 + 2] = (rand() - 0.5) * 0.5;
                    shade[i] = 0;
                } else if (u < 0.90) {
                    const r = Math.pow(rand(), 0.6) * 3.0;
                    const a = rand() * Math.PI * 2;
                    pos[i * 3] = Math.cos(a) * r;
                    pos[i * 3 + 1] = Math.sin(a) * r;
                    pos[i * 3 + 2] = (rand() - 0.5) * 10.0;
                    shade[i] = 3;
                } else {
                    const a = rand() * Math.PI * 2;
                    pos[i * 3] = Math.cos(a) * radius;
                    pos[i * 3 + 1] = Math.sin(a) * radius;
                    pos[i * 3 + 2] = (rand() - 0.5) * 2.2;
                    shade[i] = 2;
                }
            }
            return { pos, shade };
        };

        // 母舰：楔形龙骨 + 舰桥塔 + 脊线 + 引擎阵 + 等离子尾焰
        // shade: 0=舰体 1=舰桥/脊线 2=引擎喷口 3=尾焰流光
        const generateFlagship = (scale, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const shade = new Float32Array(count);
            for (let i = 0; i < count; i += 1) {
                const u = rand();
                if (u < 0.40) {
                    // 楔形主龙骨
                    const v = rand();
                    const halfSpan = (1 - Math.pow(v, 1.5)) * 36 * scale;
                    pos[i * 3] = (rand() - 0.5) * 2 * halfSpan;
                    pos[i * 3 + 1] = (rand() - 0.5) * (1 - Math.abs(pos[i * 3]) / (halfSpan + 0.01)) * 6.5 * scale;
                    pos[i * 3 + 2] = (v - 0.5) * 64 * scale;
                    // Cool bow facets make the direction readable against the
                    // warm engine bank at the opposite end.
                    shade[i] = pos[i * 3 + 2] < -22 * scale && rand() < 0.42 ? 1 : 0;
                } else if (u < 0.58) {
                    // 舰桥塔 + 双脊线
                    if (rand() < 0.5) {
                        // 舰桥塔（前 1/3 处隆起的指挥岛）
                        const w = rand();
                        pos[i * 3] = (rand() - 0.5) * 6.5 * scale * (1 - w * 0.5);
                        pos[i * 3 + 1] = (2.0 + w * 5.5) * scale;
                        pos[i * 3 + 2] = (-18 + w * 14 + (rand() - 0.5) * 3) * scale;
                    } else {
                        // 双脊线
                        const side = rand() < 0.5 ? -1 : 1;
                        pos[i * 3] = side * (4.5 + rand() * 1.5) * scale;
                        pos[i * 3 + 1] = (1.2 + rand() * 1.4) * scale;
                        pos[i * 3 + 2] = (rand() - 0.5) * 48 * scale;
                    }
                    shade[i] = 1;
                } else if (u < 0.78) {
                    // 引擎喷口阵列（4 具，尾部分布）
                    const eng = Math.floor(rand() * 4) - 1.5;
                    pos[i * 3] = eng * 7.2 * scale + (rand() - 0.5) * 2.4;
                    pos[i * 3 + 1] = (rand() - 0.5) * 2.6;
                    pos[i * 3 + 2] = (30 + rand() * 4.5) * scale;
                    shade[i] = 2;
                } else {
                    // 等离子尾焰（明确位于舰艉，向右侧拉长）
                    const t = Math.pow(rand(), 1.4);
                    const eng = Math.floor(rand() * 4) - 1.5;
                    const spread = 1 + t * 3.2;
                    pos[i * 3] = eng * 7.2 * scale * spread * 0.4 + (rand() - 0.5) * 2.0 * spread;
                    pos[i * 3 + 1] = (rand() - 0.5) * 2.0 * spread;
                    pos[i * 3 + 2] = (34 + t * 62) * scale;
                    shade[i] = 3;
                }
            }
            // The camera looks down the tunnel axis. Rotate the generated
            // hull into screen space so the audience reads a broad carrier
            // silhouette. Negative screen-X is the bow; positive screen-X
            // carries the engine bank and exhaust.
            for (let i = 0; i < count; i += 1) {
                const idx = i * 3;
                const x = pos[idx];
                pos[idx] = pos[idx + 2] * 0.82;
                pos[idx + 1] *= 1.65;
                pos[idx + 2] = x * 0.72;
            }
            return { pos, shade };
        };

        // 侦察机：锐利三角翼 + 双引擎
        // shade: 0=机翼 1=机身 2=引擎
        const generateScout = (scale, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const shade = new Float32Array(count);
            for (let i = 0; i < count; i += 1) {
                const u = rand();
                if (u < 0.55) {
                    const v = rand();
                    const halfSpan = (1 - v) * 8.5 * scale;
                    pos[i * 3] = (rand() - 0.5) * 2 * halfSpan;
                    pos[i * 3 + 1] = (rand() - 0.5) * 1.4 * scale;
                    pos[i * 3 + 2] = (v - 0.5) * 14 * scale;
                    shade[i] = 0;
                } else if (u < 0.82) {
                    pos[i * 3] = (rand() - 0.5) * 2.2 * scale;
                    pos[i * 3 + 1] = (rand() - 0.5) * 1.6 * scale;
                    pos[i * 3 + 2] = (rand() - 0.5) * 15 * scale;
                    shade[i] = 1;
                } else {
                    const side = rand() < 0.5 ? -1 : 1;
                    pos[i * 3] = side * (2.2 + rand() * 0.8) * scale;
                    pos[i * 3 + 1] = (rand() - 0.5) * 0.8;
                    pos[i * 3 + 2] = (7 + rand() * 4) * scale;
                    shade[i] = 2;
                }
            }
            return { pos, shade };
        };

        return { generatePlanet, generateRing, generateStation, generateFlagship, generateScout };
    };

    /* =====================================================
     * 隧图世界 —— 深空的极简与庞大
     * ===================================================== */
    const createTunnelWorld = (T, scene, app) => {
        const root = new T.Group();
        scene.add(root);

        const modelGen = createModelGenerators();
        const TUNNEL_LENGTH = 3200;

        /* ---------- 1. 深空星场：双层视差，极简留白 ---------- */
        const STAR_FAR = 420;   // 远景细星
        const STAR_NEAR = 90;   // 近景亮星（大而稀）
        const starCount = STAR_FAR + STAR_NEAR;
        const starPos = new Float32Array(starCount * 3);
        const starBase = new Float32Array(starCount * 3);
        const starSizes = new Float32Array(starCount);
        const starSeeds = new Float32Array(starCount * 3);
        const starRand = seededRandom('tunnel-stars-v6');

        for (let i = 0; i < starCount; i += 1) {
            const near = i >= STAR_FAR;
            const angle = starRand() * Math.PI * 2;
            const radius = near
                ? 18 + Math.pow(starRand(), 1.1) * 120
                : 40 + Math.pow(starRand(), 0.8) * 320;
            const z = -starRand() * TUNNEL_LENGTH;
            starBase[i * 3] = Math.cos(angle) * radius;
            starBase[i * 3 + 1] = Math.sin(angle) * radius * (near ? 0.62 : 0.85);
            starBase[i * 3 + 2] = z;
            starPos[i * 3] = starBase[i * 3];
            starPos[i * 3 + 1] = starBase[i * 3 + 1];
            starPos[i * 3 + 2] = z;
            starSizes[i] = near ? 1.8 + starRand() * 2.6 : 0.7 + starRand() * 1.4;
            starSeeds[i * 3] = starRand();
            starSeeds[i * 3 + 1] = starRand();
            starSeeds[i * 3 + 2] = starRand();
        }

        const starGeo = new T.BufferGeometry();
        starGeo.setAttribute('position', new T.BufferAttribute(starPos, 3).setUsage(T.DynamicDrawUsage));
        starGeo.setAttribute('aSize', new T.BufferAttribute(starSizes, 1));
        starGeo.setAttribute('aSeed', new T.BufferAttribute(starSeeds, 3));

        const starMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                tint: { value: new T.Color('#8fa4b3') },
                time: { value: 0 },
                stretch: { value: 0 },
                pixelRatio: { value: 1 }
            },
            vertexShader: `
                attribute float aSize;
                attribute vec3 aSeed;
                uniform float time;
                uniform float pixelRatio;
                varying float vAlpha;
                varying float vTwinkle;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp(aSize * pixelRatio * 300.0 / depth, 1.0, 26.0);
                    float nearFade = smoothstep(14.0, 55.0, depth);
                    float farFade = 1.0 - smoothstep(1600.0, 2500.0, depth);
                    // 每颗星独立节律的缓慢闪烁
                    vTwinkle = 0.72 + 0.28 * sin(time * (0.4 + aSeed.y * 1.2) + aSeed.x * 40.0);
                    vAlpha = nearFade * farFade * (0.18 + aSeed.x * 0.5) * vTwinkle;
                }
            `,
            fragmentShader: `
                uniform vec3 tint;
                varying float vAlpha;
                varying float vTwinkle;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 7.0);
                    float halo = exp(-r * 2.4) * 0.3 * vTwinkle;
                    gl_FragColor = vec4(tint * (core * 1.4 + halo), (core + halo) * vAlpha);
                }
            `
        });
        const starPoints = new T.Points(starGeo, starMat);
        starPoints.frustumCulled = false;
        root.add(starPoints);

        /* ---------- 1.5. 同心点阵门框：把视线锁回中心轴 ---------- */
        const PORTAL_COUNT = 6;
        const PORTAL_DOTS = 144;
        const portalPos = new Float32Array(PORTAL_COUNT * PORTAL_DOTS * 3);
        const portalBase = new Float32Array(PORTAL_COUNT * PORTAL_DOTS * 3);
        const portalSeed = new Float32Array(PORTAL_COUNT * PORTAL_DOTS);
        const portalRand = seededRandom('tunnel-portals-v1');
        for (let ring = 0; ring < PORTAL_COUNT; ring += 1) {
            const radius = 15 + ring * 20;
            const z = -58 - ring * 330;
            for (let i = 0; i < PORTAL_DOTS; i += 1) {
                const a = (i / PORTAL_DOTS) * Math.PI * 2;
                const wobble = (portalRand() - 0.5) * 0.7;
                const idx = (ring * PORTAL_DOTS + i) * 3;
                portalBase[idx] = Math.cos(a) * (radius + wobble);
                portalBase[idx + 1] = Math.sin(a) * (radius + wobble) * 0.72;
                portalBase[idx + 2] = z + (portalRand() - 0.5) * 2.0;
                portalPos[idx] = portalBase[idx];
                portalPos[idx + 1] = portalBase[idx + 1];
                portalPos[idx + 2] = portalBase[idx + 2];
                portalSeed[ring * PORTAL_DOTS + i] = portalRand();
            }
        }
        const portalGeo = new T.BufferGeometry();
        portalGeo.setAttribute('position', new T.BufferAttribute(portalPos, 3).setUsage(T.DynamicDrawUsage));
        portalGeo.setAttribute('aSeed', new T.BufferAttribute(portalSeed, 1));
        const portalMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: { tint: { value: new T.Color('#d5c2a7') }, time: { value: 0 }, pixelRatio: { value: 1 }, audioPulse: { value: 0 } },
            vertexShader: `
                attribute float aSeed;
                uniform float pixelRatio;
                uniform float time;
                uniform float audioPulse;
                varying float vAlpha;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp(pixelRatio * (2.2 + aSeed * 1.5) * 260.0 / depth, 1.0, 7.0);
                    vAlpha = (0.46 + aSeed * 0.42) * (0.88 + 0.12 * sin(time * 0.35 + aSeed * 20.0)) * (1.0 + audioPulse * 0.65);
                }
            `,
            fragmentShader: `
                uniform vec3 tint;
                varying float vAlpha;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 9.0);
                    gl_FragColor = vec4(tint * (0.75 + core), core * vAlpha);
                }
            `
        });
        const portalPoints = new T.Points(portalGeo, portalMat);
        portalPoints.frustumCulled = false;
        root.add(portalPoints);

        // A readable foreground gate: the distant dot rings sell depth, while
        // this crisp ellipse gives the lyric a clear stage to perform on.
        const heroGate = new T.Group();
        heroGate.position.z = -42;
        const heroGateMaterials = [];
        const heroGateGeometries = [];
        for (let g = 0; g < 4; g += 1) {
            const start = g * Math.PI * 0.5 + 0.16;
            const curve = new T.EllipseCurve(0, 0, 27, 14, start, start + Math.PI * 0.5 - 0.32, false, 0);
            const points = curve.getPoints(96).map((p) => new T.Vector3(p.x, p.y, 0));
            const geometry = new T.BufferGeometry().setFromPoints(points);
            const material = new T.LineBasicMaterial({
                color: new T.Color('#f2a900'),
                transparent: true,
                opacity: 0.30 - g * 0.025,
                blending: T.AdditiveBlending,
                depthWrite: false
            });
            const line = new T.LineLoop(geometry, material);
            line.rotation.z = g % 2 ? 0.025 : -0.018;
            heroGate.add(line);
            heroGateGeometries.push(geometry);
            heroGateMaterials.push(material);
        }
        root.add(heroGate);

        /* ---------- 1.75. 航道骨架：让镜头真的“穿过”空间 ---------- */
        const RAIL_COUNT = 6;
        const RAIL_DOTS = 180;
        const railPos = new Float32Array(RAIL_COUNT * RAIL_DOTS * 3);
        const railBase = new Float32Array(RAIL_COUNT * RAIL_DOTS * 3);
        const railSeed = new Float32Array(RAIL_COUNT * RAIL_DOTS);
        const railRand = seededRandom('tunnel-rails-v3');
        for (let r = 0; r < RAIL_COUNT; r += 1) {
            const angle = (r / RAIL_COUNT) * Math.PI * 2;
            for (let i = 0; i < RAIL_DOTS; i += 1) {
                const idx = (r * RAIL_DOTS + i) * 3;
                const z = -24 - (i / RAIL_DOTS) * TUNNEL_LENGTH;
                const wobble = (railRand() - 0.5) * 1.2;
                railBase[idx] = Math.cos(angle) * (22 + wobble);
                railBase[idx + 1] = Math.sin(angle) * (14 + wobble * 0.6);
                railBase[idx + 2] = z;
                railPos[idx] = railBase[idx];
                railPos[idx + 1] = railBase[idx + 1];
                railPos[idx + 2] = z;
                railSeed[r * RAIL_DOTS + i] = railRand();
            }
        }
        const railGeo = new T.BufferGeometry();
        railGeo.setAttribute('position', new T.BufferAttribute(railPos, 3).setUsage(T.DynamicDrawUsage));
        railGeo.setAttribute('aSeed', new T.BufferAttribute(railSeed, 1));
        const railMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: { tint: { value: new T.Color('#6f8790') }, time: { value: 0 }, pixelRatio: { value: 1 }, pulse: { value: 0 } },
            vertexShader: `
                attribute float aSeed;
                uniform float time;
                uniform float pixelRatio;
                uniform float pulse;
                varying float vAlpha;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp(pixelRatio * (1.2 + aSeed * 1.6) * 190.0 / depth, 1.0, 8.0);
                    float wave = 0.72 + 0.28 * sin(time * 0.9 + aSeed * 24.0);
                    vAlpha = smoothstep(8.0, 55.0, depth) * (1.0 - smoothstep(1300.0, 2700.0, depth)) * wave * (0.42 + pulse * 0.36);
                }
            `,
            fragmentShader: `
                uniform vec3 tint;
                varying float vAlpha;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 8.0);
                    gl_FragColor = vec4(tint * (0.7 + core), core * vAlpha);
                }
            `
        });
        const railPoints = new T.Points(railGeo, railMat);
        railPoints.frustumCulled = false;
        root.add(railPoints);

        /* ---------- 2. 超空间光条：音频驱动的速度残影 ---------- */
        const STREAK_COUNT = 220;
        const streakPos = new Float32Array(STREAK_COUNT * 3);
        const streakBase = new Float32Array(STREAK_COUNT * 3);
        const streakSeeds = new Float32Array(STREAK_COUNT * 3);
        const streakSizes = new Float32Array(STREAK_COUNT);
        const streakRand = seededRandom('tunnel-streaks-v2');
        for (let i = 0; i < STREAK_COUNT; i += 1) {
            const angle = streakRand() * Math.PI * 2;
            const radius = 14 + Math.pow(streakRand(), 1.3) * 90;
            streakBase[i * 3] = Math.cos(angle) * radius;
            streakBase[i * 3 + 1] = Math.sin(angle) * radius * 0.7;
            streakBase[i * 3 + 2] = -streakRand() * TUNNEL_LENGTH;
            streakSeeds[i * 3] = streakRand();
            streakSeeds[i * 3 + 1] = streakRand();
            streakSeeds[i * 3 + 2] = streakRand();
            streakSizes[i] = 0.8 + streakRand() * 1.4;
        }
        const streakGeo = new T.BufferGeometry();
        streakGeo.setAttribute('position', new T.BufferAttribute(streakPos, 3).setUsage(T.DynamicDrawUsage));
        streakGeo.setAttribute('aSeed', new T.BufferAttribute(streakSeeds, 3));
        streakGeo.setAttribute('aSize', new T.BufferAttribute(streakSizes, 1));
        const streakMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                tint: { value: new T.Color('#cfd8dd') },
                pixelRatio: { value: 1 },
                stretch: { value: 0 }  // 0..1 速度拉伸强度
            },
            vertexShader: `
                attribute vec3 aSeed;
                attribute float aSize;
                uniform float pixelRatio;
                uniform float stretch;
                varying float vAlpha;
                void main() {
                    // 速度拉伸：沿视线方向把点向后拖成光条
                    vec3 p = position;
                    p.z -= stretch * (30.0 + aSeed.y * 90.0);
                    vec4 mv = modelViewMatrix * vec4(p, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp(aSize * pixelRatio * 240.0 / depth, 0.5, 8.0);
                    float nearFade = smoothstep(10.0, 40.0, depth);
                    float farFade = 1.0 - smoothstep(1500.0, 2400.0, depth);
                    vAlpha = nearFade * farFade * stretch * (0.25 + aSeed.x * 0.4);
                }
            `,
            fragmentShader: `
                uniform vec3 tint;
                varying float vAlpha;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 5.0);
                    gl_FragColor = vec4(tint * core, core * vAlpha);
                }
            `
        });
        const streakPoints = new T.Points(streakGeo, streakMat);
        streakPoints.frustumCulled = false;
        root.add(streakPoints);

        /* ---------- 3. 低频冲击波脉冲环 ---------- */
        const PULSE_COUNT = 3;
        const pulseMeshes = [];
        const pulseGeo = new T.RingGeometry(0.96, 1.0, 96);
        for (let i = 0; i < PULSE_COUNT; i += 1) {
            const m = new T.Mesh(pulseGeo, new T.MeshBasicMaterial({
                color: new T.Color('#f2a900'),
                transparent: true,
                opacity: 0,
                side: T.DoubleSide,
                depthWrite: false,
                blending: T.AdditiveBlending
            }));
            m.visible = false;
            root.add(m);
            pulseMeshes.push({ mesh: m, age: 99, life: 1.4 });
        }
        let pulseCursor = 0;
        let bassSmooth = 0;
        let prevBass = 0;

        /* ---------- 4. 天体槽位 ---------- */
        const ENTITY_SLOTS = 6;
        const POINTS_PER_ENTITY = 2400;
        const totalEntityPoints = ENTITY_SLOTS * POINTS_PER_ENTITY;

        const entityPositions = new Float32Array(totalEntityPoints * 3);
        const entityTargets = new Float32Array(totalEntityPoints * 3);
        const entityColors = new Float32Array(totalEntityPoints * 3);
        const entitySeeds = new Float32Array(totalEntityPoints * 3);
        const entitySizes = new Float32Array(totalEntityPoints);
        const entityShade = new Float32Array(totalEntityPoints);

        const templates = {
            flagship: modelGen.generateFlagship(1.0, POINTS_PER_ENTITY, 'seed-flagship-v2'),
            planet: modelGen.generatePlanet(30, POINTS_PER_ENTITY, 'seed-planet-v2'),
            rings: modelGen.generateRing(34, 62, POINTS_PER_ENTITY, 'seed-rings-v2'),
            station: modelGen.generateStation(38, POINTS_PER_ENTITY, 'seed-station-v3'),
            scout: modelGen.generateScout(2.0, POINTS_PER_ENTITY, 'seed-scout-v2')
        };

        const entityGeo = new T.BufferGeometry();
        entityGeo.setAttribute('position', new T.BufferAttribute(entityPositions, 3).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aTarget', new T.BufferAttribute(entityTargets, 3).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aColor', new T.BufferAttribute(entityColors, 3).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aSeed', new T.BufferAttribute(entitySeeds, 3).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aSize', new T.BufferAttribute(entitySizes, 1).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aShade', new T.BufferAttribute(entityShade, 1).setUsage(T.DynamicDrawUsage));

        const entityMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                pixelRatio: { value: 1 },
                time: { value: 0 },
                breath: { value: 0 },
                audioPulse: { value: 0 }
            },
            vertexShader: `
                attribute vec3 aTarget;
                attribute vec3 aColor;
                attribute vec3 aSeed;
                attribute float aSize;
                attribute float aShade;
                uniform float pixelRatio;
                uniform float time;
                uniform float breath;
                uniform float audioPulse;
                varying vec3 vColor;
                varying float vAlpha;
                varying float vLight;
                void main() {
                    float cohesion = clamp(aSeed.y, 0.0, 1.0);
                    vec3 currentPos = mix(position, aTarget, cohesion);
                    // 凝聚后的有机微呼吸
                    currentPos += normalize(currentPos - aTarget + vec3(0.001)) * sin(time * 1.4 + aSeed.x * 20.0) * breath * cohesion * 0.35;
                    currentPos += normalize(aTarget - currentPos + vec3(0.001)) * sin(time * 2.8 + aSeed.z * 31.0) * audioPulse * cohesion * 0.42;
                    // 未凝聚时的缓慢漂浮
                    currentPos.y += sin(time * 0.7 + aSeed.x * 12.0) * (1.0 - cohesion) * 0.8;
                    // 球面法线光照 + 边缘辉光，让点阵行星保留体积感。
                    // aTarget 含有整条航道的 z 深度；只取横截面构造稳定的局部法线，避免深度把光照压扁。
                    vec3 localNormal = normalize(vec3(aTarget.x * 0.08, aTarget.y * 0.08, 1.0));
                    float lambert = 0.5 + 0.5 * dot(localNormal, normalize(vec3(-0.55, 0.72, 0.85)));
                    float rim = pow(1.0 - max(0.0, dot(localNormal, vec3(0.0, 0.0, 1.0))), 2.4);
                    vLight = clamp(lambert * 0.82 + rim * 0.42 + (aShade < 0.5 ? 0.08 : 0.0), 0.22, 1.35);
                    vec4 mv = modelViewMatrix * vec4(currentPos, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp((aSize + cohesion * (0.8 + audioPulse * 0.22)) * pixelRatio * 340.0 / depth, 1.0, 40.0);
                    float nearFade = smoothstep(12.0, 50.0, depth);
                    float farFade = 1.0 - smoothstep(1900.0, 2500.0, depth);
                    vAlpha = nearFade * farFade * (0.12 + cohesion * 0.88) * (1.0 + audioPulse * 0.16);
                    vColor = aColor;
                }
            `,
            fragmentShader: `
                varying vec3 vColor;
                varying float vAlpha;
                varying float vLight;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 7.0);
                    float halo = exp(-r * 2.2) * 0.32;
                    float edge = smoothstep(1.0, 0.08, r);
                    gl_FragColor = vec4(vColor * (core * 1.75 + halo) * vLight, (core + halo) * vAlpha * edge);
                }
            `
        });
        const entityPoints = new T.Points(entityGeo, entityMat);
        entityPoints.frustumCulled = false;
        root.add(entityPoints);

        // 分镜槽位：构图遵循「三分法 + 巨大体量对比」
        const slotConfigs = [
            // 0 近景下方：母舰缓缓横穿（开场即在）
            { type: 'flagship', initialZ: -300, x: -18, y: -17, rotSpeed: 0.018, rotPhase: 0, scale: 1.85 },
            // 1 中景左上：冰青行星
            { type: 'planet', initialZ: -760, x: -42, y: 22, rotSpeed: 0.042, rotPhase: 1.2, scale: 0.92 },
            // 2 右上：琥珀星环
            { type: 'rings', initialZ: -1120, x: 42, y: 8, rotSpeed: 0.055, rotPhase: 2.4, scale: 0.92 },
            // 3 远空：环形空间站
            { type: 'station', initialZ: -760, x: 34, y: -10, rotSpeed: 0.032, rotPhase: 3.1, scale: 1.55 },
            // 4 右下近景：侦察护航机
            { type: 'scout', initialZ: -1820, x: 18, y: -20, rotSpeed: 0.075, rotPhase: 4.0, scale: 0.82 },
            // 5 深远：第二行星
            { type: 'planet', initialZ: -2260, x: 48, y: 28, rotSpeed: 0.034, rotPhase: 5.3, scale: 0.78 }
        ];
        // 环带预设倾角
        const slotTilt = [
            { x: 0.06, z: 0.0 },
            { x: 0.18, z: -0.10 },
            { x: 0.72, z: 0.28 },
            { x: 0.48, z: 0.32 },
            { x: -0.06, z: 0.06 },
            { x: 0.12, z: 0.04 }
        ];

        /* ---------- 5. 歌词点阵 + 实心文字 ---------- */
        const LYRIC_PARTICLE_CAP = 3400;
        const lyricParticlePos = new Float32Array(LYRIC_PARTICLE_CAP * 3);
        const lyricParticleTarget = new Float32Array(LYRIC_PARTICLE_CAP * 3);
        const lyricParticleSeeds = new Float32Array(LYRIC_PARTICLE_CAP * 3);
        const lyricParticleColors = new Float32Array(LYRIC_PARTICLE_CAP * 3);
        const lyricParticleWord = new Float32Array(LYRIC_PARTICLE_CAP); // 所属 word 索引

        const lyricGeo = new T.BufferGeometry();
        lyricGeo.setAttribute('position', new T.BufferAttribute(lyricParticlePos, 3).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aTarget', new T.BufferAttribute(lyricParticleTarget, 3).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aSeed', new T.BufferAttribute(lyricParticleSeeds, 3).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aColor', new T.BufferAttribute(lyricParticleColors, 3).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aWord', new T.BufferAttribute(lyricParticleWord, 1).setUsage(T.DynamicDrawUsage));

        // 逐字进度材质：aWord + uniform 数组驱动声波涟漪
        const MAX_WORDS = 24;
        const wordProgressArray = new Float32Array(MAX_WORDS);
        const lyricParticleMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                tint: { value: new T.Color('#f2a900') },
                pixelRatio: { value: 1 },
                cohesion: { value: 0 },
                disperse: { value: 0 },
                time: { value: 0 },
                opacity: { value: 1 },
                wordProgress: { value: wordProgressArray }
            },
            vertexShader: `
                attribute vec3 aTarget;
                attribute vec3 aSeed;
                attribute vec3 aColor;
                attribute float aWord;
                uniform float pixelRatio;
                uniform float cohesion;
                uniform float disperse;
                uniform float time;
                uniform float wordProgress[${MAX_WORDS}];
                varying vec3 vColor;
                varying float vAlpha;
                varying float vGlow;
                void main() {
                    vec3 pos = mix(position, aTarget, cohesion);
                    if (disperse > 0.001) {
                        pos.z += disperse * (60.0 + aSeed.z * 160.0);
                        pos.x += (aSeed.x - 0.5) * disperse * 55.0;
                        pos.y += (aSeed.y - 0.5) * disperse * 36.0;
                    }
                    // 逐字声波涟漪：已唱出的字粒子外扩脉冲
                    int wi = int(aWord + 0.5);
                    float wp = (wi >= 0 && wi < ${MAX_WORDS}) ? wordProgress[wi] : 0.0;
                    float ripple = sin(wp * 3.14159) * cohesion;
                    pos.xy += normalize(aTarget.xy + vec2(0.001)) * ripple * 0.55;
                    vGlow = ripple;
                    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp((1.7 + cohesion * 0.9 + ripple * 0.8) * pixelRatio * 340.0 / depth, 1.0, 28.0);
                    float nearFade = smoothstep(4.0, 18.0, depth);
                    vAlpha = nearFade * (0.22 + cohesion * 0.78) * (1.0 - disperse * 0.9);
                    vColor = aColor + vec3(ripple * 0.45);
                }
            `,
            fragmentShader: `
                uniform vec3 tint;
                uniform float opacity;
                varying vec3 vColor;
                varying float vAlpha;
                varying float vGlow;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 7.5);
                    float halo = exp(-r * 2.2) * (0.32 + vGlow * 0.5);
                    gl_FragColor = vec4(mix(tint, vColor, 0.55) * (core * 1.5 + halo), (core + halo) * vAlpha * opacity);
                }
            `
        });
        const lyricPoints = new T.Points(lyricGeo, lyricParticleMat);
        lyricPoints.frustumCulled = false;
        root.add(lyricPoints);

        // 实心文字平面
        const textCanvas = document.createElement('canvas');
        textCanvas.width = 2048;
        textCanvas.height = 512;
        const textCtx = textCanvas.getContext('2d', { willReadFrequently: true });
        const textTexture = new T.CanvasTexture(textCanvas);
        textTexture.generateMipmaps = false;
        textTexture.minFilter = T.LinearFilter;
        textTexture.magFilter = T.LinearFilter;

        const solidPlaneGeo = new T.PlaneGeometry(50, 12.5);
        const solidPlaneMat = new T.MeshBasicMaterial({
            map: textTexture,
            transparent: true,
            depthWrite: false,
            blending: T.NormalBlending,
            opacity: 0
        });
        const solidTextMesh = new T.Mesh(solidPlaneGeo, solidPlaneMat);
        solidTextMesh.position.set(0, 0, -34);
        root.add(solidTextMesh);

        // 舞台状态
        let currentLineKey = '';
        let lineStartTime = 0;
        let lineEndTime = 1;
        let activePointCount = 0;
        let lyricRollAngle = 0;
        let currentActiveLine = null;
        let currentFrame = null;

        let totalTravelDistance = 0;
        let cruiseSpeed = 1.0;
        let stagePalette = {};
        let fovCurrent = 56;
        let cameraRoll = 0;

        const setting = (settings, key, fallback) => {
            const value = Number(settings?.[key]);
            return Number.isFinite(value) ? value : fallback;
        };

        const deterministicTravel = (time, settings) => {
            const speed = clamp(setting(settings, 'cameraSpeed', 1), 0.15, 3);
            const motion = clamp(setting(settings, 'motionAmount', 1), 0, 2);
            // A small eased surge at every lyric boundary gives the camera a
            // musical phrase without making the result depend on frame count.
            const lines = currentFrame?.lines || [];
            let distance = Math.max(0, time) * 18 * speed;
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i];
                const start = Number(line?.startTime);
                if (!Number.isFinite(start) || start > time) continue;
                const next = Number(lines[i + 1]?.startTime);
                const gap = Number.isFinite(next) ? Math.max(0.25, next - start) : 3.5;
                const age = clamp((time - start) / gap);
                distance += smooth(age) * 10 * speed * (0.35 + motion * 0.25);
            }
            return distance;
        };

        function parseThemeColors() {
            const accent = stagePalette.accent || '#F2A900';
            const secondary = stagePalette.secondary || '#76BFAE';
            const ink = stagePalette.ink || '#F2F0E9';
            const muted = stagePalette.muted || '#A7AFB1';
            const danger = '#E06C5F';
            return {
                accent: new T.Color(accent),
                secondary: new T.Color(secondary),
                ink: new T.Color(ink),
                muted: new T.Color(muted),
                danger: new T.Color(danger),
                accentHex: accent,
                secondaryHex: secondary,
                inkHex: ink
            };
        }

        // 天体配色：尊重 shade 子结构
        function applyEntityPalette() {
            const colors = parseThemeColors();
            const colorsArr = entityGeo.attributes.aColor.array;
            for (let s = 0; s < ENTITY_SLOTS; s += 1) {
                const slot = slotConfigs[s];
                const tmpl = templates[slot.type];
                const offset = s * POINTS_PER_ENTITY;
                for (let p = 0; p < POINTS_PER_ENTITY; p += 1) {
                    const gi = offset + p;
                    const pi = gi * 3;
                    const sh = tmpl.shade[p];
                    entityShade[gi] = sh;
                    let c;
                    if (slot.type === 'flagship') {
                        if (sh === 3) { // 尾焰：琥珀金渐消
                            c = colors.accent;
                        } else if (sh === 2) { // 引擎喷口：朱砂红
                            c = colors.danger;
                        } else if (sh === 1) { // 舰桥/脊线：松石信号灯
                            c = colors.secondary;
                        } else { // 舰体：骨白
                            c = colors.ink;
                        }
                        const dim = sh === 3 ? 0.9 : 1.0;
                        colorsArr[pi] = c.r * dim; colorsArr[pi + 1] = c.g * dim; colorsArr[pi + 2] = c.b * dim;
                    } else if (slot.type === 'planet') {
                        if (sh === 2) { // 极冠辉点：亮松石
                            colorsArr[pi] = colors.secondary.r * 1.25;
                            colorsArr[pi + 1] = colors.secondary.g * 1.25;
                            colorsArr[pi + 2] = colors.secondary.b * 1.25;
                        } else if (sh === 0) { // 纬线暗纹：深松石
                            colorsArr[pi] = colors.secondary.r * 0.5;
                            colorsArr[pi + 1] = colors.secondary.g * 0.55;
                            colorsArr[pi + 2] = colors.secondary.b * 0.6;
                        } else { // 主体表面
                            colorsArr[pi] = colors.secondary.r * 0.85;
                            colorsArr[pi + 1] = colors.secondary.g * 0.92;
                            colorsArr[pi + 2] = colors.secondary.b;
                        }
                    } else if (slot.type === 'rings') {
                        if (sh === 0) { // 内亮带：亮琥珀
                            colorsArr[pi] = colors.accent.r * 1.3; colorsArr[pi + 1] = colors.accent.g * 1.3; colorsArr[pi + 2] = colors.accent.b * 1.3;
                        } else if (sh === 1) { // 中带：琥珀
                            colorsArr[pi] = colors.accent.r; colorsArr[pi + 1] = colors.accent.g; colorsArr[pi + 2] = colors.accent.b;
                        } else { // 外散晕：暗琥珀
                            colorsArr[pi] = colors.accent.r * 0.55; colorsArr[pi + 1] = colors.accent.g * 0.55; colorsArr[pi + 2] = colors.accent.b * 0.55;
                        }
                    } else if (slot.type === 'station') {
                        if (sh === 2) { // 航行灯：朱砂
                            c = colors.danger;
                        } else if (sh === 3) { // 中轴：琥珀
                            c = colors.accent;
                        } else if (sh === 1) { // 舱体：骨白
                            c = colors.ink;
                        } else { // 辐条骨架：金属灰
                            c = colors.muted;
                        }
                        colorsArr[pi] = c.r; colorsArr[pi + 1] = c.g; colorsArr[pi + 2] = c.b;
                    } else {
                        // 侦察机
                        if (sh === 2) { c = colors.danger; }
                        else if (sh === 1) { c = colors.accent; }
                        else { c = colors.secondary; }
                        colorsArr[pi] = c.r; colorsArr[pi + 1] = c.g; colorsArr[pi + 2] = c.b;
                    }
                }
            }
            entityGeo.attributes.aColor.needsUpdate = true;
            entityGeo.attributes.aShade.needsUpdate = true;
        }

        // 歌词文字栅格化（含逐字粒子归属）
        function rasterizeLyric(line, frame) {
            const fullText = line?.fullText || '';
            const subText = R.resolveSupplementalText(line) || '';
            const lineIdx = line?.index ?? 0;
            const colors = parseThemeColors();

            const sign = (lineIdx % 2 === 0) ? 1 : -1;
            lyricRollAngle = sign * ((lineIdx % 2 === 0) ? 0.085 : 0.068);

            textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
            textCtx.textBaseline = 'middle';
            textCtx.font = '900 82px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
            textCtx.fillStyle = colors.accentHex;
            textCtx.fillText(fullText, 140, 200);
            if (subText) {
                textCtx.font = '500 32px "Microsoft YaHei", "PingFang SC", sans-serif';
                textCtx.fillStyle = colors.secondaryHex;
                textCtx.fillText(subText, 144, 282);
            }
            textTexture.needsUpdate = true;

            // 逐字粒子归属：用 wordStates 在 canvas 上按字测量宽度定位
            const words = frame?.wordStates || [];
            const wordRanges = []; // 每字 canvas x 范围
            let cursorX = 140;
            const measureFont = textCtx.font;
            textCtx.font = '900 82px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
            const fullWidth = Math.max(1, textCtx.measureText(fullText).width);
            if (words.length && fullText) {
                for (let w = 0; w < words.length; w += 1) {
                    const wText = words[w]?.text || '';
                    const wWidth = textCtx.measureText(wText).width;
                    wordRanges.push({ start: cursorX, end: cursorX + wWidth });
                    cursorX += wWidth;
                }
            }
            textCtx.font = measureFont;

            const imgData = textCtx.getImageData(0, 0, textCanvas.width, textCanvas.height).data;
            const stride = 5;
            const points = [];
            const W = textCanvas.width, H = textCanvas.height;
            for (let y = 0; y < H; y += stride) {
                for (let x = 0; x < W; x += stride) {
                    const alpha = imgData[(y * W + x) * 4 + 3];
                    if (alpha > 85) {
                        const worldX = (x / W - 0.5) * 58;
                        const worldY = (0.5 - y / H) * 14.5;
                        // 判断所属字（仅主歌词区 y<260）
                        let wi = -1;
                        if (y < 250 && wordRanges.length) {
                            for (let w = 0; w < wordRanges.length; w += 1) {
                                if (x >= wordRanges[w].start && x < wordRanges[w].end) { wi = Math.min(w, MAX_WORDS - 1); break; }
                            }
                        }
                        points.push({ x: worldX, y: worldY, word: wi });
                    }
                }
            }

            const rand = seededRandom(`lyric-scatter-${lineIdx}-${fullText}`);
            activePointCount = Math.min(points.length, LYRIC_PARTICLE_CAP);
            const cAccent = colors.accent;
            const cSecondary = colors.secondary;
            for (let i = 0; i < LYRIC_PARTICLE_CAP; i += 1) {
                const target = points[i % Math.max(1, points.length)] || { x: 0, y: 0, word: -1 };
                lyricParticleTarget[i * 3] = target.x;
                lyricParticleTarget[i * 3 + 1] = target.y;
                lyricParticleTarget[i * 3 + 2] = 0;

                const scatterDist = 20 + rand() * 50;
                lyricParticlePos[i * 3] = target.x + (rand() - 0.5) * scatterDist * 1.6;
                lyricParticlePos[i * 3 + 1] = target.y + (rand() - 0.5) * scatterDist;
                lyricParticlePos[i * 3 + 2] = -160 - rand() * 360;

                lyricParticleSeeds[i * 3] = rand();
                lyricParticleSeeds[i * 3 + 1] = rand();
                lyricParticleSeeds[i * 3 + 2] = rand();
                lyricParticleWord[i] = target.word;

                // 主文琥珀金，译文松石
                const cc = target.y < 0.5 ? cAccent : cSecondary;
                lyricParticleColors[i * 3] = cc.r;
                lyricParticleColors[i * 3 + 1] = cc.g;
                lyricParticleColors[i * 3 + 2] = cc.b;
            }

            lyricParticleMat.uniforms.wordProgress.value.fill(0);
            lyricGeo.setDrawRange(0, activePointCount);
            lyricGeo.attributes.position.needsUpdate = true;
            lyricGeo.attributes.aTarget.needsUpdate = true;
            lyricGeo.attributes.aSeed.needsUpdate = true;
            lyricGeo.attributes.aColor.needsUpdate = true;
            lyricGeo.attributes.aWord.needsUpdate = true;
        }

        // 可读阶段的逐字动画由 Canvas 完成；粒子材质不再承担歌词跳动。
        function animateCanvasLyric(line, frame, settings) {
            if (!line) return;
            const fullText = line.fullText || '';
            const subText = R.resolveSupplementalText(line) || '';
            const colors = parseThemeColors();
            const words = frame?.wordStates || [];
            textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);
            textCtx.textBaseline = 'middle';
            textCtx.font = '900 82px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';

            if (!words.length) {
                textCtx.fillStyle = colors.accentHex;
                textCtx.fillText(fullText, 140, 200);
            } else {
                let x = 140;
                for (const word of words) {
                    const label = word?.text || '';
                    const amount = clamp(word?.progress ?? 0);
                    const width = textCtx.measureText(label).width;
                    const pulse = settings.reducedMotion ? 0 : Math.sin(amount * Math.PI);
                    const bounce = pulse * 15;
                    const scale = 1 + pulse * 0.08;
                    textCtx.save();
                    textCtx.translate(x + width * 0.5, 200 - bounce);
                    textCtx.scale(scale, scale);
                    textCtx.translate(-(x + width * 0.5), -(200 - bounce));
                    textCtx.fillStyle = amount > 0.04 ? colors.accentHex : colors.inkHex;
                    textCtx.fillText(label, x, 200 - bounce);
                    textCtx.restore();
                    x += width;
                }
            }
            if (subText) {
                textCtx.font = '500 32px "Microsoft YaHei", "PingFang SC", sans-serif';
                textCtx.fillStyle = colors.secondaryHex;
                textCtx.fillText(subText, 144, 282);
            }
            textTexture.needsUpdate = true;
        }

        function setPalette(palette) {
            stagePalette = palette || {};
            const bg = stagePalette.background || '#0a0d11';
            const colors = parseThemeColors();
            const bgColor = new T.Color(bg);
            // 深空压暗背景，保证黑场
            bgColor.multiplyScalar(0.55);
            if (scene?.background?.copy) scene.background.copy(bgColor);
            else if (scene) scene.background = bgColor;
            if (scene?.fog?.color?.copy) scene.fog.color.copy(bgColor);

            if (starMat?.uniforms?.tint?.value?.copy) starMat.uniforms.tint.value.copy(colors.muted);
            if (streakMat?.uniforms?.tint?.value?.copy) streakMat.uniforms.tint.value.copy(colors.ink);
            if (portalMat?.uniforms?.tint?.value?.copy) portalMat.uniforms.tint.value.copy(colors.accent);
            if (railMat?.uniforms?.tint?.value?.copy) railMat.uniforms.tint.value.copy(colors.secondary);
            heroGateMaterials.forEach((material, index) => material.color.copy(colors.accent).offsetHSL(index * 0.015, 0, 0));
            if (lyricParticleMat?.uniforms?.tint?.value?.copy) lyricParticleMat.uniforms.tint.value.copy(colors.accent);
            pulseMeshes.forEach((p) => p.mesh.material.color.copy(colors.accent));

            applyEntityPalette();
            if (currentActiveLine) rasterizeLyric(currentActiveLine, currentFrame);
        }

        const reset = () => {
            currentLineKey = '';
            currentActiveLine = null;
            currentFrame = null;
            totalTravelDistance = 0;
            cruiseSpeed = 1.0;
            cameraRoll = 0;
            pulseMeshes.forEach((p) => { p.age = 99; p.mesh.visible = false; });
        };

        const update = (time, frame, settings, audioState, cameraInstance) => {
            const dt = audioState.dt;
            const live = audioState.playing;
            currentFrame = frame || currentFrame;
            currentActiveLine = frame?.activeLine || null;

            if (audioState.seek) {
                totalTravelDistance = deterministicTravel(time, settings);
                cruiseSpeed = 1.0;
                cameraRoll = 0;
            }

            const activeLine = frame.activeLine;
            currentActiveLine = activeLine || null;
            currentFrame = frame || null;
            const nextKey = activeLine ? `${activeLine.index}:${activeLine.startTime}:${activeLine.fullText}` : '';

            if (nextKey !== currentLineKey) {
                currentLineKey = nextKey;
                lineStartTime = activeLine?.startTime ?? time;
                lineEndTime = Math.max(lineStartTime + 0.6, activeLine?.endTime ?? (lineStartTime + 4));
                if (activeLine) rasterizeLyric(activeLine, frame);
                else {
                    activePointCount = 0;
                    lyricGeo.setDrawRange(0, 0);
                    solidPlaneMat.opacity = 0;
                }
            }
            if (activeLine) animateCanvasLyric(activeLine, frame, settings);

            const duration = Math.max(0.6, lineEndTime - lineStartTime);
            const age = time - lineStartTime;
            const progress = clamp(age / duration);

            /* ----- 镜头推进：三段落权威轨道 ----- */
            let speedMod = 1.0;
            if (activeLine) {
                const entrance = 1.05 - 0.42 * easeOutQuart(clamp(progress / 0.22));
                const exit = 0.42 + 0.82 * easeInCubic(clamp((progress - 0.78) / 0.22));
                speedMod = progress < 0.78 ? entrance : exit;
            } else {
                speedMod = 0.82;
            }

            const baseSpeed = (settings.cameraSpeed ?? 1) * (settings.motionAmount ?? 1) * (settings.animationIntensity ?? 1);
            const instantSpeed = baseSpeed * speedMod * (settings.reducedMotion ? 0 : 1);
            cruiseSpeed += (instantSpeed - cruiseSpeed) * (1 - Math.exp(-dt * 7.5));

            if (live) {
                // Do not integrate this value: the same playback time must
                // always produce the same world position, even after a seek.
                totalTravelDistance = deterministicTravel(time, settings);
            }

            // 音频平滑
            bassSmooth += (audioState.bass - bassSmooth) * (1 - Math.exp(-dt * 10));

            /* ----- 低频冲击波检测 ----- */
            if (live && bassSmooth > 0.55 && bassSmooth - prevBass > 0.18) {
                const p = pulseMeshes[pulseCursor % PULSE_COUNT];
                pulseCursor += 1;
                p.age = 0;
                p.mesh.visible = true;
            }
            prevBass = bassSmooth;

            const colors = parseThemeColors();
            pulseMeshes.forEach((p) => {
                if (!p.mesh.visible) return;
                p.age += dt;
                const t = p.age / p.life;
                if (t >= 1) { p.mesh.visible = false; p.mesh.material.opacity = 0; return; }
                const scale = 4 + easeOutCubic(t) * 90;
                p.mesh.scale.set(scale, scale, 1);
                p.mesh.position.set(0, 0, -50 - easeOutCubic(t) * 60);
                p.mesh.material.opacity = (1 - t) * 0.32;
            });
            heroGate.visible = settings.starfield !== false;
            heroGate.rotation.z = Math.sin(time * 0.16) * 0.018 + cameraRoll * 0.35;
            const gatePulse = 0.16 + bassSmooth * 0.22 + (activeLine ? Math.sin(clamp(progress) * Math.PI) * 0.16 : 0);
            heroGateMaterials.forEach((material, index) => {
                material.opacity = Math.max(0.03, gatePulse - index * 0.035);
            });

            /* ----- 镜头：电影式漂移 + FOV 呼吸 ----- */
            const motionPower = clamp(setting(settings, 'motionAmount', 1), 0, 2)
                * clamp(setting(settings, 'animationIntensity', 1), 0, 2);
            const breath = clamp(setting(settings, 'cameraBreath', 0.5), 0, 2);
            const shake = clamp(setting(settings, 'cameraShake', 1), 0, 2);
            const driftTime = time * 0.14;
            const driftX = (Math.sin(driftTime * 0.42) * 0.72 + Math.cos(driftTime * 0.23) * 0.35) * breath;
            const driftY = (Math.cos(driftTime * 0.34) * 0.48 + Math.sin(driftTime * 0.19) * 0.22) * breath;
            const driftRoll = Math.sin(driftTime * 0.17) * 0.004 * breath;
            const shakeX = Math.sin(time * 17.0) * bassSmooth * 0.22 * shake;
            const shakeY = Math.cos(time * 19.0) * bassSmooth * 0.16 * shake;
            const pathPhase = totalTravelDistance * 0.012;
            const pathX = Math.sin(pathPhase * 0.73) * 1.8 + Math.sin(pathPhase * 0.19) * 0.8;
            const pathY = Math.cos(pathPhase * 0.51) * 1.1;

            cameraInstance.position.x = pathX * motionPower * 0.45 + driftX * motionPower + shakeX;
            cameraInstance.position.y = pathY * motionPower * 0.35 + (driftY + bassSmooth * 0.4 * shake) * motionPower + shakeY;
            cameraInstance.position.z = 0;

            const lookX = pathX * motionPower * 0.72 + Math.sin(driftTime * 0.32) * 0.55 * motionPower;
            const lookY = pathY * motionPower * 0.56 + Math.cos(driftTime * 0.28) * 0.42 * motionPower;
            cameraInstance.lookAt(lookX, lookY, -300);
            cameraRoll = driftRoll * motionPower + bassSmooth * 0.002 * Math.sin(time * 0.8);
            cameraInstance.rotation.z = cameraRoll;

            // FOV 呼吸：随速度与低频缓慢张开
            const fovTarget = 54 + clamp(cruiseSpeed - 0.8, 0, 1.3) * 5 * motionPower + bassSmooth * 2.5 * shake;
            fovCurrent += (fovTarget - fovCurrent) * (1 - Math.exp(-dt * 2.2));
            cameraInstance.fov = fovCurrent;
            cameraInstance.updateProjectionMatrix();

            /* ----- 星场流动 ----- */
            starMat.uniforms.time.value = time;
            starPoints.visible = settings.starfield !== false;
            portalPoints.visible = settings.starfield !== false;
            railPoints.visible = settings.starfield !== false;
            streakPoints.visible = settings.starfield !== false && !settings.reducedMotion;
            const starPosArr = starGeo.attributes.position.array;
            for (let i = 0; i < starCount; i += 1) {
                const idx = i * 3;
                const baseZ = starBase[idx + 2];
                const parallax = i >= STAR_FAR ? 1.0 : 0.45; // 远星慢，近星快
                let z = (baseZ + totalTravelDistance * parallax) % TUNNEL_LENGTH;
                if (z > 0) z -= TUNNEL_LENGTH;
                starPosArr[idx + 2] = z;
            }
            starGeo.attributes.position.needsUpdate = true;

            // 门框随航行缓慢后退，维持“穿过一层层同心空间”的节奏。
            portalMat.uniforms.time.value = time;
            const lyricPulse = activeLine ? Math.sin(clamp(progress) * Math.PI) * 0.75 : 0;
            const portalPulse = Math.max(bassSmooth, lyricPulse);
            portalMat.uniforms.audioPulse.value += (portalPulse - portalMat.uniforms.audioPulse.value) * (1 - Math.exp(-dt * 8));
            const portalTravel = totalTravelDistance * 0.22;
            const portalArr = portalGeo.attributes.position.array;
            for (let i = 0; i < portalPos.length / 3; i += 1) {
                const idx = i * 3;
                let z = (portalBase[idx + 2] + portalTravel) % TUNNEL_LENGTH;
                if (z > 0) z -= TUNNEL_LENGTH;
                portalArr[idx] = portalBase[idx];
                portalArr[idx + 1] = portalBase[idx + 1];
                portalArr[idx + 2] = z;
            }
            portalGeo.attributes.position.needsUpdate = true;

            railMat.uniforms.time.value = time;
            railMat.uniforms.pulse.value += (bassSmooth - railMat.uniforms.pulse.value) * (1 - Math.exp(-dt * 7));
            const railArr = railGeo.attributes.position.array;
            const railTravel = totalTravelDistance * 0.42;
            for (let i = 0; i < railBase.length / 3; i += 1) {
                const idx = i * 3;
                let z = (railBase[idx + 2] + railTravel) % TUNNEL_LENGTH;
                if (z > 0) z -= TUNNEL_LENGTH;
                const bend = Math.sin((z + totalTravelDistance) * 0.006) * motionPower * 1.8;
                railArr[idx] = railBase[idx] + bend;
                railArr[idx + 1] = railBase[idx + 1] + Math.cos((z + totalTravelDistance) * 0.004) * motionPower * 1.1;
                railArr[idx + 2] = z;
            }
            railGeo.attributes.position.needsUpdate = true;

            /* ----- 超空间光条 ----- */
            const stretchTarget = live ? clamp((cruiseSpeed - 0.9) * 0.55 + bassSmooth * 0.35, 0, 1) : 0;
            streakMat.uniforms.stretch.value += (stretchTarget - streakMat.uniforms.stretch.value) * (1 - Math.exp(-dt * 5));
            const streakPosArr = streakGeo.attributes.position.array;
            const streakDist = totalTravelDistance * 1.55; // 光条比星更快
            for (let i = 0; i < STREAK_COUNT; i += 1) {
                const idx = i * 3;
                let z = (streakBase[idx + 2] + streakDist) % TUNNEL_LENGTH;
                if (z > 0) z -= TUNNEL_LENGTH;
                streakPosArr[idx] = streakBase[idx];
                streakPosArr[idx + 1] = streakBase[idx + 1];
                streakPosArr[idx + 2] = z;
            }
            streakGeo.attributes.position.needsUpdate = true;

            /* ----- 天体槽位 ----- */
            entityMat.uniforms.time.value = time;
            entityMat.uniforms.breath.value = bassSmooth * 0.8;
            entityMat.uniforms.audioPulse.value = clamp(bassSmooth * 1.25 + audioState.vocal * 0.22, 0, 1);
            const showPlanets = settings.showPlanets !== false;
            const showRings = settings.showRings !== false;
            const showShips = settings.showShips !== false;
            const showStations = settings.showStations !== false;
            entityPoints.visible = showPlanets || showRings || showShips || showStations;

            const objPositions = entityGeo.attributes.position.array;
            const objTargets = entityGeo.attributes.aTarget.array;
            const objSeedsArr = entityGeo.attributes.aSeed.array;
            const objSizesArr = entityGeo.attributes.aSize.array;

            // 天体相对星场更快，接近镜头前才完成凝结。
            const entityTravelDist = totalTravelDistance * 0.72;
            const CELESTIAL_CYCLE = 1750;

            for (let s = 0; s < ENTITY_SLOTS; s += 1) {
                const slot = slotConfigs[s];
                const slotVisible = slot.type === 'planet' ? showPlanets
                    : slot.type === 'rings' ? showRings
                        : slot.type === 'flagship' || slot.type === 'scout' ? showShips
                            : showStations;
                const tilt = slotTilt[s];
                let depth = (slot.initialZ + entityTravelDist) % CELESTIAL_CYCLE;
                if (depth > 0) depth -= CELESTIAL_CYCLE;

                const tmpl = templates[slot.type];

                // 凝聚生命周期：远方成雾 → 逼近凝聚 → 黄金展示 → 掠过消散
                let cohesion = 0;
                if (depth < -260) cohesion = 0;
                else if (depth < -92) cohesion = easeOutCubic((depth + 260) / 168);
                else if (depth < -28) cohesion = 1.0;
                else cohesion = smooth(-depth / 28);

                // 自转 + 预设倾角
                const rotA = time * slot.rotSpeed + slot.rotPhase
                    + bassSmooth * Math.sin(time * 1.7 + s * 0.9) * 0.18;
                const cosY = Math.cos(rotA), sinY = Math.sin(rotA);
                const cosX = Math.cos(tilt.x), sinX = Math.sin(tilt.x);
                const cosZ = Math.cos(tilt.z), sinZ = Math.sin(tilt.z);

                const offset = s * POINTS_PER_ENTITY;

                for (let p = 0; p < POINTS_PER_ENTITY; p += 1) {
                    const pi = (offset + p) * 3;
                    if (!slotVisible) {
                        objPositions[pi] = 0;
                        objPositions[pi + 1] = 0;
                        objPositions[pi + 2] = 99999;
                        objTargets[pi] = 0;
                        objTargets[pi + 1] = 0;
                        objTargets[pi + 2] = 99999;
                        objSeedsArr[pi + 1] = 0;
                        continue;
                    }
                    const tx0 = tmpl.pos[p * 3] * slot.scale;
                    const ty0 = tmpl.pos[p * 3 + 1] * slot.scale;
                    const tz0 = tmpl.pos[p * 3 + 2] * slot.scale;

                    // Y 自转
                    let rx = tx0 * cosY - tz0 * sinY;
                    let rz = tx0 * sinY + tz0 * cosY;
                    let ry = ty0;
                    // X 倾角
                    const ry2 = ry * cosX - rz * sinX;
                    const rz2 = ry * sinX + rz * cosX;
                    ry = ry2; rz = rz2;
                    // Z 微倾
                    const rx2 = rx * cosZ - ry * sinZ;
                    const ry3 = rx * sinZ + ry * cosZ;
                    rx = rx2; ry = ry3;

                    const fx = slot.x + rx;
                    const fy = slot.y + ry;
                    const fz = depth + rz;

                    objTargets[pi] = fx;
                    objTargets[pi + 1] = fy;
                    objTargets[pi + 2] = fz;

                    const randSeed = (p * 0.23 + s * 0.71) % 1;
                    const stationMist = slot.type === 'station' ? 1.55 : 1.0;
                    const scatterR = (1 - cohesion) * stationMist * (24.0 + randSeed * 58.0);
                    const phase = time * (0.32 + randSeed * 0.24) + p * 0.071 + s * 1.7 + bassSmooth * 0.55;
                    const curl = Math.sin(phase) * 0.55 + Math.cos(phase * 0.63) * 0.35;
                    objPositions[pi] = fx + (Math.sin(p * 2.1 + phase) + curl) * scatterR;
                    objPositions[pi + 1] = fy + (Math.cos(p * 1.7 + phase * 0.8) - curl * 0.55) * scatterR;
                    objPositions[pi + 2] = fz + (randSeed - 0.5 + Math.sin(phase * 0.7) * 0.18) * scatterR * 1.3;

                    objSeedsArr[pi] = randSeed;
                    objSeedsArr[pi + 1] = cohesion;

                    const sh = entityShade[offset + p];
                    objSizesArr[offset + p] =
                        slot.type === 'flagship' ? (sh === 3 ? 2.0 : sh === 2 ? 1.9 : 1.5) :
                        slot.type === 'planet' ? (sh === 2 ? 2.4 : sh === 0 ? 1.4 : 1.9) :
                        slot.type === 'rings' ? (sh === 0 ? 1.8 : sh === 2 ? 1.0 : 1.4) :
                        slot.type === 'station' ? (sh === 2 ? 1.7 : 1.3) :
                        (sh === 2 ? 1.8 : 1.3);
                }
            }

            entityGeo.attributes.position.needsUpdate = true;
            entityGeo.attributes.aTarget.needsUpdate = true;
            entityGeo.attributes.aSeed.needsUpdate = true;
            entityGeo.attributes.aSize.needsUpdate = true;

            /* ----- 歌词三段相位 ----- */
            if (activeLine && activePointCount > 0) {
                // 文字是空间中的固定展板，不随镜头向前划出；只有粒子在它周围完成聚散。
                const lyricZ = -34;
                let cohesionPhase = 0;
                let dispersePhase = 0;

                const holdRatio = clamp(setting(settings, 'textHoldRatio', 0.32), 0, 0.8);
                const dissolveAmount = clamp(setting(settings, 'dissolveAmount', 0.72), 0, 1);
                const pause = clamp(setting(settings, 'pauseDuration', 0.9), 0, 3);
                const holdStart = 0.78 + Math.min(0.14, pause * 0.035);
                const holdEnd = Math.min(0.98, holdStart + 0.12 + holdRatio * 0.08);

                if (progress < 0.10) {
                    cohesionPhase = smooth(progress / 0.10);
                } else if (progress < holdStart) {
                    cohesionPhase = 1.0;
                } else {
                    const p = (progress - holdStart) / Math.max(0.04, 1 - holdStart);
                    cohesionPhase = 1.0;
                    dispersePhase = smooth(p) * dissolveAmount;
                }

                lyricParticleMat.uniforms.cohesion.value = cohesionPhase;
                lyricParticleMat.uniforms.disperse.value = dispersePhase;
                lyricParticleMat.uniforms.time.value = time;

                // 逐字动画由 Canvas 文字层负责；粒子层保持纯粹的凝结/消散。
                const wpArr = lyricParticleMat.uniforms.wordProgress.value;
                for (let w = 0; w < MAX_WORDS; w += 1) {
                    wpArr[w] = 0;
                }

                // 两种文字严格交接：先看粒子字，粒子退场后才显示实心字，避免重影。
                // 结成后交给 2D Canvas 阅读；文字退场后才把控制权交回粒子消散。
                // 在歌词段落开头立即交接，给演唱留下完整的可读时间。
                const solidIn = smooth(clamp((progress - 0.055) / 0.105));
                const solidOut = progress <= holdEnd ? 1 : 1 - smooth(clamp((progress - holdEnd) / Math.max(0.04, 0.16 - holdRatio * 0.08)));
                const solidOpacity = solidIn * solidOut * (settings.reducedMotion ? 0.9 : 1.0);
                solidPlaneMat.opacity = solidOpacity * (settings.reducedMotion ? 0.9 : 1.0);

                let lyricParticleAlpha = 0;
                if (progress < 0.04) {
                    lyricParticleAlpha = 0.90;
                } else if (progress < 0.16) {
                    // 与 2D 文字短距离交叉淡化，避免闪断。
                    lyricParticleAlpha = 0.90 * (1 - smooth((progress - 0.04) / 0.12));
                } else if (progress <= holdStart) {
                    lyricParticleAlpha = 0;
                } else {
                    // 实体文字渐隐后，粒子消散动画接手。
                    lyricParticleAlpha = smooth(clamp((progress - holdStart) / Math.max(0.04, 1 - holdStart))) * dissolveAmount;
                }
                lyricParticleMat.uniforms.opacity.value = lyricParticleAlpha;

                solidTextMesh.rotation.z = lyricRollAngle;
                lyricPoints.rotation.z = lyricRollAngle;

                const lyricFloatX = Math.sin(time * 0.28) * 0.45;
                const lyricFloatY = Math.cos(time * 0.23) * 0.3 + bassSmooth * 0.25;
                solidTextMesh.position.set(lyricFloatX, lyricFloatY, lyricZ);
                lyricPoints.position.set(lyricFloatX, lyricFloatY, lyricZ);

                solidPlaneMat.color.set('#ffffff');
            } else {
                solidPlaneMat.opacity = 0;
            }
        };

        return {
            get distance() { return totalTravelDistance; },
            get currentSpeed() { return cruiseSpeed; },
            reset,
            setPalette,
            update,
            resize(w, h, ratio) {
                starMat.uniforms.pixelRatio.value = ratio;
                portalMat.uniforms.pixelRatio.value = ratio;
                railMat.uniforms.pixelRatio.value = ratio;
                streakMat.uniforms.pixelRatio.value = ratio;
                entityMat.uniforms.pixelRatio.value = ratio;
                lyricParticleMat.uniforms.pixelRatio.value = ratio;
            },
            destroy() {
                scene.remove(root);
                [starGeo, portalGeo, railGeo, streakGeo, entityGeo, lyricGeo, solidPlaneGeo, pulseGeo, ...heroGateGeometries].forEach((g) => g?.dispose?.());
                [starMat, portalMat, railMat, streakMat, entityMat, lyricParticleMat, solidPlaneMat].forEach((m) => m?.dispose?.());
                heroGateMaterials.forEach((m) => m.dispose?.());
                pulseMeshes.forEach((p) => p.mesh.material.dispose());
                textTexture?.dispose?.();
            }
        };
    };

    global.MusicStageTunnelManager = Object.freeze({ create });
})(window);
