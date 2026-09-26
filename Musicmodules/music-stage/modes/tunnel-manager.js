(function (global) {
    'use strict';

    const U = global.MusicStageModeUtils;
    const R = global.MusicStageRuntime;
    if (!U || !R) throw new Error('MusicStage utilities must load before tunnel-manager.js');

    const { clamp, seededRandom } = R;

    const smooth = (value) => {
        const p = clamp(value);
        return p * p * (3 - 2 * p);
    };

    const easeOutCubic = (value) => {
        const p = clamp(value);
        return 1 - Math.pow(1 - p, 3);
    };

    const easeInCubic = (value) => {
        const p = clamp(value);
        return p * p * p;
    };

    const create = (container, services) => {
        const mode = U.makeModeBase('tunnel', '隧图', container, services);
        const fallback = U.createElement('div', 'tunnel-fallback');
        const fallbackLine = U.createElement('div', 'tunnel-fallback-line');
        const fallbackSub = U.createElement('div', 'stage-translation tunnel-fallback-sub');
        fallback.append(fallbackLine, fallbackSub);
        mode.root.appendChild(fallback);

        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let T = null;
        let scene = null;
        let camera = null;
        let renderer = null;
        let world = null;
        let initialized = false;
        let fallbackMode = false;
        let initializing = null;
        let latest = null;
        let source = null;
        let identity = '';
        let width = 1;
        let height = 1;
        let lastTime = null;
        let paletteKey = '';

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
                // 简洁深邃的冷石墨背景，与纸墨与机芯的石墨板相呼应
                const initialBg = new T.Color('#14181d');
                scene.background = initialBg;
                scene.fog = new T.FogExp2(initialBg, 0.00055);

                camera = new T.PerspectiveCamera(48, 1, 0.1, 3600);
                camera.position.set(0, 0, 0);

                renderer = new T.WebGLRenderer({
                    antialias: true,
                    alpha: false,
                    powerPreference: 'high-performance'
                });
                renderer.outputColorSpace = T.SRGBColorSpace;
                renderer.toneMapping = T.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.12;
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
        mode.resize = () => {
            resize();
            if (latest && initialized) update(latest);
        };
        const baseConfig = mode.updateConfig;
        mode.updateConfig = (config) => {
            baseConfig(config);
            resize();
            if (latest && initialized) update(latest);
        };
        mode.updateTheme = () => {
            if (latest && initialized) update(latest);
        };
        const resume = mode.resume;
        mode.resume = () => {
            resume();
            lastTime = null;
            if (latest) update(latest);
        };
        mode.getDebugSnapshot = () => ({
            initialized,
            fallbackMode,
            distance: world?.distance || 0,
            currentSpeed: world?.currentSpeed || 0,
            cameraPos: camera?.position?.toArray() || null,
            activeLine: latest?.activeLine?.fullText || null
        });
        mode.scope.add(() => {
            disposeGraphics();
            latest = source = null;
        });

        resize();
        void initialize();
        return mode;
    };

    /**
     * 点阵与几何体生成助手
     */
    const createModelGenerators = (T) => {
        // 1. 巨大星球（斐波那契球面点阵）
        const generatePlanet = (radius, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const offset = 2 / count;
            const increment = Math.PI * (3 - Math.sqrt(5));
            for (let i = 0; i < count; i += 1) {
                const y = (i * offset - 1) + (offset / 2);
                const r = Math.sqrt(Math.max(0, 1 - y * y));
                const phi = i * increment;
                const jitter = 0.985 + rand() * 0.03;
                pos[i * 3] = Math.cos(phi) * r * radius * jitter;
                pos[i * 3 + 1] = y * radius * jitter;
                pos[i * 3 + 2] = Math.sin(phi) * r * radius * jitter;
            }
            return pos;
        };

        // 2. 倾斜星环点阵（同心光晕粒子带）
        const generateRing = (innerRadius, outerRadius, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            for (let i = 0; i < count; i += 1) {
                const angle = rand() * Math.PI * 2;
                const rRatio = Math.pow(rand(), 0.72);
                const r = innerRadius + rRatio * (outerRadius - innerRadius);
                const thickness = (rand() - 0.5) * 0.45;
                pos[i * 3] = Math.cos(angle) * r;
                pos[i * 3 + 1] = thickness;
                pos[i * 3 + 2] = Math.sin(angle) * r;
            }
            return pos;
        };

        // 3. 远空环形空间站（Endurance 轴向环架）
        const generateStation = (radius, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const modules = 12;
            for (let i = 0; i < count; i += 1) {
                const choose = rand();
                if (choose < 0.64) {
                    const modIdx = Math.floor(rand() * modules);
                    const baseAngle = (modIdx / modules) * Math.PI * 2;
                    const spread = (rand() - 0.5) * 0.24;
                    const r = radius + (rand() - 0.5) * 2.0;
                    pos[i * 3] = Math.cos(baseAngle + spread) * r;
                    pos[i * 3 + 1] = Math.sin(baseAngle + spread) * r;
                    pos[i * 3 + 2] = (rand() - 0.5) * 1.8;
                } else if (choose < 0.88) {
                    const spoke = Math.floor(rand() * 4);
                    const spokeAngle = (spoke / 4) * Math.PI * 2;
                    const spokeDist = rand() * radius;
                    pos[i * 3] = Math.cos(spokeAngle) * spokeDist;
                    pos[i * 3 + 1] = Math.sin(spokeAngle) * spokeDist;
                    pos[i * 3 + 2] = (rand() - 0.5) * 0.5;
                } else {
                    const r = rand() * 3.5;
                    const angle = rand() * Math.PI * 2;
                    pos[i * 3] = Math.cos(angle) * r;
                    pos[i * 3 + 1] = Math.sin(angle) * r;
                    pos[i * 3 + 2] = (rand() - 0.5) * 6.5;
                }
            }
            return pos;
        };

        // 4. 巨型战巡母舰（Behemoth Cruiser：巨大机身横穿下方视野）
        const generateFlagship = (scale, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            for (let i = 0; i < count; i += 1) {
                const part = rand();
                if (part < 0.48) {
                    // 主舰体大型楔形龙骨
                    const u = rand();
                    const halfSpan = (1 - Math.pow(u, 1.4)) * 32 * scale;
                    const x = (rand() - 0.5) * 2 * halfSpan;
                    const y = (1 - Math.abs(x) / (halfSpan + 0.01)) * (rand() - 0.5) * 5.5 * scale;
                    const z = (u - 0.5) * 54 * scale;
                    pos[i * 3] = x;
                    pos[i * 3 + 1] = y;
                    pos[i * 3 + 2] = z;
                } else if (part < 0.78) {
                    // 上层舰桥、装甲折角与雷达脊线
                    const t = rand();
                    const x = (rand() - 0.5) * 8 * scale;
                    const y = 2.5 * scale + (rand() - 0.5) * 3.2 * scale;
                    const z = (t - 0.5) * 24 * scale;
                    pos[i * 3] = x;
                    pos[i * 3 + 1] = y;
                    pos[i * 3 + 2] = z;
                } else {
                    // 舰尾巨型推进引擎阵列与等离子尾迹
                    const engX = ((Math.floor(rand() * 4) - 1.5) * 6.5) * scale;
                    const x = engX + (rand() - 0.5) * 1.5;
                    const y = (rand() - 0.5) * 2.0;
                    const z = 27 * scale + rand() * 22 * scale;
                    pos[i * 3] = x;
                    pos[i * 3 + 1] = y;
                    pos[i * 3 + 2] = z;
                }
            }
            return pos;
        };

        // 5. 敏捷侦察穿梭机（Scout Craft）
        const generateScout = (scale, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            for (let i = 0; i < count; i += 1) {
                const u = rand();
                const halfSpan = (1 - u) * 7.5 * scale;
                const x = (rand() - 0.5) * 2 * halfSpan;
                const y = (rand() - 0.5) * 1.8 * scale;
                const z = (u - 0.5) * 13 * scale;
                pos[i * 3] = x;
                pos[i * 3 + 1] = y;
                pos[i * 3 + 2] = z;
            }
            return pos;
        };

        return {
            generatePlanet,
            generateRing,
            generateStation,
            generateFlagship,
            generateScout
        };
    };

    /**
     * 核心隧图三维世界构建
     */
    const createTunnelWorld = (T, scene, app) => {
        const root = new T.Group();
        scene.add(root);

        const modelGen = createModelGenerators(T);

        // ==========================
        // 1. 稀疏深空星尘（Cosmic Dust & Sparse Stars）- 只保留少数作为深空点缀
        // ==========================
        const starCount = 260; // 削减至 260 颗，确保深空极度干净、空旷与留白
        const starPos = new Float32Array(starCount * 3);
        const starBase = new Float32Array(starCount * 3);
        const starSizes = new Float32Array(starCount);
        const starSeeds = new Float32Array(starCount * 3);
        const starRand = seededRandom('tunnel-sparse-stars-v4');

        const TUNNEL_LENGTH = 2400;
        for (let i = 0; i < starCount; i += 1) {
            const angle = starRand() * Math.PI * 2;
            const radius = 25 + Math.pow(starRand(), 1.2) * 140;
            const z = -starRand() * TUNNEL_LENGTH;
            starBase[i * 3] = Math.cos(angle) * radius;
            starBase[i * 3 + 1] = Math.sin(angle) * radius * 0.58;
            starBase[i * 3 + 2] = z;

            starPos[i * 3] = starBase[i * 3];
            starPos[i * 3 + 1] = starBase[i * 3 + 1];
            starPos[i * 3 + 2] = z;

            starSizes[i] = 0.9 + starRand() * 1.8;
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
                travelSpeed: { value: 1 },
                pixelRatio: { value: 1 }
            },
            vertexShader: `
                attribute float aSize;
                attribute vec3 aSeed;
                uniform float travelSpeed;
                uniform float pixelRatio;
                varying float vAlpha;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp(aSize * pixelRatio * 260.0 / depth, 1.0, 22.0);
                    
                    float nearFade = smoothstep(12.0, 45.0, depth);
                    float farFade = 1.0 - smoothstep(1500.0, 2400.0, depth);
                    vAlpha = nearFade * farFade * (0.2 + aSeed.x * 0.45);
                }
            `,
            fragmentShader: `
                uniform vec3 tint;
                varying float vAlpha;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 6.0);
                    gl_FragColor = vec4(tint * core, core * vAlpha);
                }
            `
        });

        const starPoints = new T.Points(starGeo, starMat);
        starPoints.frustumCulled = false;
        root.add(starPoints);

        // ==========================
        // 2. 电影级空间分镜构图：巨物穿梭感与天体色差群
        // ==========================
        // 槽位构图设定：
        // 槽 0：画面下方掠过的超巨型战巡母舰（Behemoth Dreadnought / Flagship）
        // 槽 1：画面左上方孤悬的深空点阵星球（Giant Planet - 深灰冰青）
        // 槽 2：环绕或掠过的薄星环（Planetary Rings - 琥珀微金）
        // 槽 3：远空倾斜环形空间站（Orbital Ring Station - 冷白工业骨架）
        // 槽 4：右下近景护航巡航舰（Cruiser / Scout）
        // 槽 5：中远景第二星球
        const ENTITY_SLOTS = 6;
        const POINTS_PER_ENTITY = 1400;
        const totalEntityPoints = ENTITY_SLOTS * POINTS_PER_ENTITY;

        const entityPositions = new Float32Array(totalEntityPoints * 3);
        const entityTargets = new Float32Array(totalEntityPoints * 3);
        const entityColors = new Float32Array(totalEntityPoints * 3);
        const entitySeeds = new Float32Array(totalEntityPoints * 3);
        const entitySizes = new Float32Array(totalEntityPoints);

        const templates = {
            flagship: modelGen.generateFlagship(1.0, POINTS_PER_ENTITY, 'seed-flagship'),
            planet: modelGen.generatePlanet(28, POINTS_PER_ENTITY, 'seed-planet'),
            rings: modelGen.generateRing(32, 56, POINTS_PER_ENTITY, 'seed-rings'),
            station: modelGen.generateStation(22, POINTS_PER_ENTITY, 'seed-station'),
            scout: modelGen.generateScout(1.8, POINTS_PER_ENTITY, 'seed-scout')
        };

        const entityGeo = new T.BufferGeometry();
        entityGeo.setAttribute('position', new T.BufferAttribute(entityPositions, 3).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aTarget', new T.BufferAttribute(entityTargets, 3).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aColor', new T.BufferAttribute(entityColors, 3).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aSeed', new T.BufferAttribute(entitySeeds, 3).setUsage(T.DynamicDrawUsage));
        entityGeo.setAttribute('aSize', new T.BufferAttribute(entitySizes, 1).setUsage(T.DynamicDrawUsage));

        const entityMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                pixelRatio: { value: 1 },
                time: { value: 0 }
            },
            vertexShader: `
                attribute vec3 aTarget;
                attribute vec3 aColor;
                attribute vec3 aSeed;
                attribute float aSize;
                uniform float pixelRatio;
                uniform float time;
                varying vec3 vColor;
                varying float vAlpha;
                void main() {
                    // aSeed.y 代表当前粒子的凝聚成型度 (cohesion)
                    float cohesion = clamp(aSeed.y, 0.0, 1.0);
                    // 远方是离散星雾，快逼近眼前时迅速吸附咬合到目标骨架模型
                    vec3 currentPos = mix(position, aTarget, cohesion);

                    // 空间星尘微扰
                    currentPos.y += sin(time * 0.9 + aSeed.x * 12.0) * (1.0 - cohesion) * 0.5;

                    vec4 mv = modelViewMatrix * vec4(currentPos, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp((aSize + cohesion * 0.7) * pixelRatio * 320.0 / depth, 1.0, 36.0);
                    
                    // 掠过镜头身后迅速消散
                    float nearFade = smoothstep(10.0, 42.0, depth);
                    float farFade = 1.0 - smoothstep(1800.0, 2400.0, depth);
                    vAlpha = nearFade * farFade * (0.2 + cohesion * 0.8);
                    vColor = aColor;
                }
            `,
            fragmentShader: `
                varying vec3 vColor;
                varying float vAlpha;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 6.5);
                    float halo = exp(-r * 2.2) * 0.35;
                    gl_FragColor = vec4(vColor * (core * 1.5 + halo), (core + halo) * vAlpha);
                }
            `
        });

        const entityPoints = new T.Points(entityGeo, entityMat);
        entityPoints.frustumCulled = false;
        root.add(entityPoints);

        // 分镜槽位初始配置：紧凑交错分布，确保刚进入即有前景巨舰，深空随时有天体交替巡航
        const slotConfigs = [
            // 0: 近景下方折跃战巡母舰（一进入舞台即在眼前沉稳滑过，巨物穿梭感！）
            { type: 'flagship', initialZ: -140, x: 0, y: -24, rotX: 0.1, rotY: 0, rotZ: 0, scale: 1.0, seed: 'slot-behemoth' },
            // 1: 中景左上方孤悬的深空冰青星球（从容自转）
            { type: 'planet', initialZ: -420, x: -36, y: 16, rotX: 0.2, rotY: 0.15, rotZ: -0.08, scale: 1.0, seed: 'slot-planet-1' },
            // 2: 偏右上倾斜掠过的微金星环
            { type: 'rings', initialZ: -680, x: 32, y: 12, rotX: 0.72, rotY: 0.35, rotZ: 0.25, scale: 1.0, seed: 'slot-rings-1' },
            // 3: 远空倾斜环形空间站
            { type: 'station', initialZ: -940, x: 24, y: -12, rotX: 0.45, rotY: 0.2, rotZ: 0.3, scale: 1.0, seed: 'slot-station' },
            // 4: 下方偏右护航侦察巡航机
            { type: 'scout', initialZ: -1200, x: 20, y: -16, rotX: -0.05, rotY: 0.08, rotZ: 0.05, scale: 1.0, seed: 'slot-scout' },
            // 5: 深远方右侧第二星球
            { type: 'planet', initialZ: -1460, x: 38, y: 20, rotX: 0.1, rotY: -0.1, rotZ: 0.05, scale: 0.85, seed: 'slot-planet-2' }
        ];

        // ==========================
        // 3. 歌词空间迎面拉近穿梭与纯净实心咬合凝聚
        // ==========================
        const LYRIC_PARTICLE_CAP = 3000;
        const lyricParticlePos = new Float32Array(LYRIC_PARTICLE_CAP * 3);
        const lyricParticleTarget = new Float32Array(LYRIC_PARTICLE_CAP * 3);
        const lyricParticleSeeds = new Float32Array(LYRIC_PARTICLE_CAP * 3);
        const lyricParticleColors = new Float32Array(LYRIC_PARTICLE_CAP * 3);

        const lyricGeo = new T.BufferGeometry();
        lyricGeo.setAttribute('position', new T.BufferAttribute(lyricParticlePos, 3).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aTarget', new T.BufferAttribute(lyricParticleTarget, 3).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aSeed', new T.BufferAttribute(lyricParticleSeeds, 3).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aColor', new T.BufferAttribute(lyricParticleColors, 3).setUsage(T.DynamicDrawUsage));

        const lyricParticleMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                tint: { value: new T.Color('#f2f0e9') },
                pixelRatio: { value: 1 },
                cohesion: { value: 0 },
                disperse: { value: 0 },
                time: { value: 0 },
                opacity: { value: 1 }
            },
            vertexShader: `
                attribute vec3 aTarget;
                attribute vec3 aSeed;
                attribute vec3 aColor;
                uniform float pixelRatio;
                uniform float cohesion;
                uniform float disperse;
                uniform float time;
                varying vec3 vColor;
                varying float vAlpha;
                void main() {
                    // 入场：从深空发散点云迅速聚拢到字符实体骨架
                    vec3 pos = mix(position, aTarget, cohesion);

                    // 离场：加速冲破镜头向后扩散消散
                    if (disperse > 0.001) {
                        pos.z += disperse * (50.0 + aSeed.z * 140.0);
                        pos.x += (aSeed.x - 0.5) * disperse * 42.0;
                        pos.y += (aSeed.y - 0.5) * disperse * 28.0;
                    }

                    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float depth = max(0.1, -mv.z);
                    gl_PointSize = clamp((1.6 + cohesion * 0.9) * pixelRatio * 320.0 / depth, 1.0, 26.0);
                    
                    float nearFade = smoothstep(4.0, 18.0, depth);
                    vAlpha = nearFade * (0.25 + cohesion * 0.75) * (1.0 - disperse * 0.9);
                    vColor = aColor;
                }
            `,
            fragmentShader: `
                uniform vec3 tint;
                uniform float opacity;
                varying vec3 vColor;
                varying float vAlpha;
                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r = dot(p, p);
                    if (r > 1.0) discard;
                    float core = exp(-r * 7.5);
                    float halo = exp(-r * 2.2) * 0.35;
                    gl_FragColor = vec4(mix(tint, vColor, 0.5) * (core * 1.5 + halo), (core + halo) * vAlpha * opacity);
                }
            `
        });

        const lyricPoints = new T.Points(lyricGeo, lyricParticleMat);
        lyricPoints.frustumCulled = false;
        root.add(lyricPoints);

        // 实体实心文字平面：纯净高对比度，无描边，边缘干净利落
        const textCanvas = document.createElement('canvas');
        textCanvas.width = 2048;
        textCanvas.height = 512;
        const textCtx = textCanvas.getContext('2d');

        const textTexture = new T.CanvasTexture(textCanvas);
        textTexture.generateMipmaps = false;
        textTexture.minFilter = T.LinearFilter;
        textTexture.magFilter = T.LinearFilter;

        const solidPlaneGeo = new T.PlaneGeometry(58, 14.5);
        const solidPlaneMat = new T.MeshBasicMaterial({
            map: textTexture,
            transparent: true,
            depthWrite: false,
            blending: T.NormalBlending,
            opacity: 0
        });

        const solidTextMesh = new T.Mesh(solidPlaneGeo, solidPlaneMat);
        solidTextMesh.position.set(0, 0, -36);
        root.add(solidTextMesh);

        let currentLineKey = '';
        let currentLineIndex = 0;
        let lineStartTime = 0;
        let lineEndTime = 1;
        let activePointCount = 0;
        let lyricRollAngle = 0;
        let currentActiveLine = null;
        let currentFrame = null;

        let totalTravelDistance = 0;
        let cruiseSpeed = 1.0;
        let stagePalette = {};

// 统一主题色彩解析
function parseThemeColors() {
    const accent = stagePalette.accent || '#F2A900'; // 琥珀金/警示黄（主歌词、星环）
    const secondary = stagePalette.secondary || '#76BFAE'; // 铜绿/松石（星球、译文、信号点）
    const ink = stagePalette.ink || '#F2F0E9'; // 骨白（母舰骨架、空间站）
    const muted = stagePalette.muted || '#A7AFB1'; // 次级金属灰（星尘、护航机）
    const danger = '#E06C5F'; // 警示朱砂红（推进引擎尾喷火）
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

// 根据 themes.css 精确配置每个天体的专属色调（提前声明，杜绝 TDZ 引用错误）
function applyEntityPalette() {
    const colors = parseThemeColors();
    const colorsArr = entityGeo.attributes.aColor.array;

    for (let s = 0; s < ENTITY_SLOTS; s += 1) {
        const slot = slotConfigs[s];
        const offsetStart = s * POINTS_PER_ENTITY * 3;

        for (let p = 0; p < POINTS_PER_ENTITY; p += 1) {
            const pi = offsetStart + p * 3;

            if (slot.type === 'flagship') {
                // 巨舰：工业石墨骨白(--primary-text) + 铜绿信号灯(--success-color) + 尾喷火(--danger-color / --highlight-text)
                if (p % 16 === 0) {
                    colorsArr[pi] = colors.danger.r;
                    colorsArr[pi + 1] = colors.danger.g;
                    colorsArr[pi + 2] = colors.danger.b;
                } else if (p % 8 === 0) {
                    colorsArr[pi] = colors.secondary.r;
                    colorsArr[pi + 1] = colors.secondary.g;
                    colorsArr[pi + 2] = colors.secondary.b;
                } else {
                    colorsArr[pi] = colors.ink.r;
                    colorsArr[pi + 1] = colors.ink.g;
                    colorsArr[pi + 2] = colors.ink.b;
                }
            } else if (slot.type === 'planet') {
                // 星球：松石铜绿(--quoted-text / --success-color) + 冰灰大气
                if (p % 3 === 0) {
                    colorsArr[pi] = colors.secondary.r * 1.05;
                    colorsArr[pi + 1] = colors.secondary.g * 1.05;
                    colorsArr[pi + 2] = colors.secondary.b * 1.05;
                } else {
                    colorsArr[pi] = colors.secondary.r * 0.75;
                    colorsArr[pi + 1] = colors.secondary.g * 0.85;
                    colorsArr[pi + 2] = colors.secondary.b * 0.95;
                }
            } else if (slot.type === 'rings') {
                // 星环：耀眼琥珀金(--highlight-text)微尘环带，与铜绿星球形成冷暖对冲！
                colorsArr[pi] = colors.accent.r;
                colorsArr[pi + 1] = colors.accent.g;
                colorsArr[pi + 2] = colors.accent.b;
            } else if (slot.type === 'station') {
                // 空间站：工业骨白(--primary-text) + 金属灰(--secondary-text)
                if (p % 6 === 0) {
                    colorsArr[pi] = colors.secondary.r;
                    colorsArr[pi + 1] = colors.secondary.g;
                    colorsArr[pi + 2] = colors.secondary.b;
                } else {
                    colorsArr[pi] = colors.ink.r;
                    colorsArr[pi + 1] = colors.ink.g;
                    colorsArr[pi + 2] = colors.ink.b;
                }
            } else {
                // 护航侦察机：松石铜绿机翼 + 琥珀金座舱光
                if (p % 5 === 0) {
                    colorsArr[pi] = colors.accent.r;
                    colorsArr[pi + 1] = colors.accent.g;
                    colorsArr[pi + 2] = colors.accent.b;
                } else {
                    colorsArr[pi] = colors.secondary.r;
                    colorsArr[pi + 1] = colors.secondary.g;
                    colorsArr[pi + 2] = colors.secondary.b;
                }
            }
        }
    }
    entityGeo.attributes.aColor.needsUpdate = true;
}

// 纯净实心文字排版：主文本使用高亮琥珀金，变成文字的粒子也是琥珀金，完全一致！
function rasterizeLyric(line, frame) {
    const fullText = line?.fullText || '';
    const subText = R.resolveSupplementalText(line) || '';
    const lineIdx = line?.index ?? 0;
    currentLineIndex = lineIdx;

    const colors = parseThemeColors();

    // 水平交叉微滚转角：偶数句顺时针 (+5.8°)，奇数句逆时针 (-4.6°)
    const sign = (lineIdx % 2 === 0) ? 1 : -1;
    const magnitude = (lineIdx % 2 === 0) ? 0.101 : 0.080;
    lyricRollAngle = sign * magnitude;

    textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);

    // 1. 主歌词：主题高光琥珀金，高对比度实心呈现
    textCtx.font = '900 82px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
    textCtx.fillStyle = colors.accentHex;
    textCtx.textBaseline = 'middle';
    textCtx.fillText(fullText, 140, 200);

    // 2. 译文 / 补充文本：典雅铜绿/松石副阶
    if (subText) {
        textCtx.font = '500 32px "Microsoft YaHei", "PingFang SC", sans-serif';
        textCtx.fillStyle = colors.secondaryHex;
        textCtx.fillText(subText, 144, 280);
    }

    textTexture.needsUpdate = true;

    // 3. 点阵提取与粒子颜色赋值：变成文本的粒子严格使用与主歌词完全一致的琥珀金色！
    const imgData = textCtx.getImageData(0, 0, textCanvas.width, textCanvas.height).data;
    const stride = 6;
    const points = [];
    const W = textCanvas.width;
    const H = textCanvas.height;

    for (let y = 0; y < H; y += stride) {
        for (let x = 0; x < W; x += stride) {
            const alpha = imgData[(y * W + x) * 4 + 3];
            if (alpha > 85) {
                const worldX = (x / W - 0.5) * 58;
                const worldY = (0.5 - y / H) * 14.5;
                points.push({ x: worldX, y: worldY });
            }
        }
    }

    const rand = seededRandom(`lyric-scatter-${lineIdx}-${fullText}`);
    activePointCount = Math.min(points.length, LYRIC_PARTICLE_CAP);

    const cAccent = colors.accent;
    for (let i = 0; i < LYRIC_PARTICLE_CAP; i += 1) {
        const target = points[i % Math.max(1, points.length)] || { x: 0, y: 0 };
        lyricParticleTarget[i * 3] = target.x;
        lyricParticleTarget[i * 3 + 1] = target.y;
        lyricParticleTarget[i * 3 + 2] = 0;

        // 初始深空发散态
        const scatterDist = 18 + rand() * 42;
        lyricParticlePos[i * 3] = target.x + (rand() - 0.5) * scatterDist * 1.5;
        lyricParticlePos[i * 3 + 1] = target.y + (rand() - 0.5) * scatterDist;
        lyricParticlePos[i * 3 + 2] = -140 - rand() * 320;

        lyricParticleSeeds[i * 3] = rand();
        lyricParticleSeeds[i * 3 + 1] = rand();
        lyricParticleSeeds[i * 3 + 2] = rand();

        // 核心修复：汇聚成文本的粒子，其颜色就是主歌词的琥珀金！色调100%浑然一体！
        lyricParticleColors[i * 3] = cAccent.r;
        lyricParticleColors[i * 3 + 1] = cAccent.g;
        lyricParticleColors[i * 3 + 2] = cAccent.b;
    }

    lyricGeo.setDrawRange(0, activePointCount);
    lyricGeo.attributes.position.needsUpdate = true;
    lyricGeo.attributes.aTarget.needsUpdate = true;
    lyricGeo.attributes.aSeed.needsUpdate = true;
    lyricGeo.attributes.aColor.needsUpdate = true;
};
        function setPalette(palette) {
            stagePalette = palette || {};
            const bg = stagePalette.background || '#14181d';
            const colors = parseThemeColors();

            const bgColor = new T.Color(bg);
            if (scene?.background?.copy) scene.background.copy(bgColor);
            else if (scene) scene.background = bgColor;
            if (scene?.fog?.color?.copy) scene.fog.color.copy(bgColor);

            // 装饰星尘使用次级工业灰
            if (starMat?.uniforms?.tint?.value?.copy) {
                starMat.uniforms.tint.value.copy(colors.muted);
            }
            // 歌词粒子的统一基调着色：与主文本同为琥珀金
            if (lyricParticleMat?.uniforms?.tint?.value?.copy) {
                lyricParticleMat.uniforms.tint.value.copy(colors.accent);
            }

            // 刷新天体对象的固有色
            applyEntityPalette();
            // 如果有正在显示的歌词，刷新其贴图与粒子色彩
            if (currentActiveLine) {
                rasterizeLyric(currentActiveLine, currentFrame);
            }
        }

        const reset = (lines, newIdentity) => {
            currentLineKey = '';
            currentActiveLine = null;
            currentFrame = null;
            totalTravelDistance = 0;
            cruiseSpeed = 1.0;
        };

        const update = (time, frame, settings, audioState, cameraInstance) => {
            const dt = audioState.dt;
            const live = audioState.playing;

            const activeLine = frame.activeLine;
            currentActiveLine = activeLine || null;
            currentFrame = frame || null;
            const nextKey = activeLine ? `${activeLine.index}:${activeLine.startTime}:${activeLine.fullText}` : '';

            if (nextKey !== currentLineKey) {
                currentLineKey = nextKey;
                lineStartTime = activeLine?.startTime ?? time;
                lineEndTime = Math.max(lineStartTime + 0.6, activeLine?.endTime ?? (lineStartTime + 4));
                if (activeLine) {
                    rasterizeLyric(activeLine, frame);
                } else {
                    activePointCount = 0;
                    lyricGeo.setDrawRange(0, 0);
                    solidPlaneMat.opacity = 0;
                }
            }

            const duration = Math.max(0.6, lineEndTime - lineStartTime);
            const age = time - lineStartTime;
            const progress = clamp(age / duration);

            // 镜头推进曲线：飞驰逼近 => 优雅停驻漂移 => 破空脱离
            let speedMod = 1.0;
            if (activeLine) {
                if (progress < 0.28) {
                    speedMod = 1.6 - 1.1 * easeOutCubic(progress / 0.28);
                } else if (progress < 0.85) {
                    speedMod = 0.42; // 平稳沉浸区
                } else {
                    const p = (progress - 0.85) / 0.15;
                    speedMod = 0.42 + 1.8 * easeInCubic(p);
                }
            } else {
                speedMod = 1.35;
            }

            const baseSpeed = (settings.cameraSpeed ?? 1) * (settings.motionAmount ?? 1)
                * (settings.animationIntensity ?? 1);
            const instantSpeed = baseSpeed * speedMod * (settings.reducedMotion ? 0 : 1);
            cruiseSpeed += (instantSpeed - cruiseSpeed) * (1 - Math.exp(-dt * 8));

            // 空间累计距离推进：沉稳星际穿梭航速
            if (live) {
                totalTravelDistance += cruiseSpeed * dt * 32;
            }

            // ==========================
            // 2. 摄像机极其平稳深邃的深空漂流（无高频抖动！）
            // ==========================
            const motionPower = (settings.motionAmount ?? 1) * (settings.animationIntensity ?? 1);
            // 8~12 秒长周期超平滑浮游呼吸，消除所有机械高频抖动
            const driftTime = time * 0.16;
            const driftX = Math.sin(driftTime) * 2.2 + Math.cos(driftTime * 0.58) * 1.0;
            const driftY = Math.cos(driftTime * 0.82) * 1.5 + Math.sin(driftTime * 0.44) * 0.6;

            cameraInstance.position.x = driftX * motionPower;
            cameraInstance.position.y = (driftY + audioState.bass * 0.25) * motionPower;
            cameraInstance.position.z = 0;

            const lookX = Math.sin(driftTime * 0.75) * 1.4 * motionPower;
            const lookY = Math.cos(driftTime * 0.62) * 1.1 * motionPower;
            cameraInstance.lookAt(lookX, lookY, -240);

            // ==========================
            // 3. 稀疏星尘朝迎面飞掠
            // ==========================
            starMat.uniforms.travelSpeed.value = cruiseSpeed;

            const starPosArr = starGeo.attributes.position.array;
            for (let i = 0; i < starCount; i += 1) {
                const idx = i * 3;
                const baseZ = starBase[idx + 2];
                const currentZ = (baseZ + totalTravelDistance) % TUNNEL_LENGTH;
                const z = currentZ > 0 ? currentZ - TUNNEL_LENGTH : currentZ;
                starPosArr[idx] = starBase[idx];
                starPosArr[idx + 1] = starBase[idx + 1];
                starPosArr[idx + 2] = z;
            }
            starGeo.attributes.position.needsUpdate = true;

            // ==========================
            // 4. 空间分镜物体群：远方点云 -> 快逼近前凝聚成形 -> 掠过镜头消散
            // ==========================
            const objPositions = entityGeo.attributes.position.array;
            const objTargets = entityGeo.attributes.aTarget.array;
            const objSeedsArr = entityGeo.attributes.aSeed.array;
            const objColorsArr = entityGeo.attributes.aColor.array;
            const objSizesArr = entityGeo.attributes.aSize.array;

            entityMat.uniforms.time.value = time;

            // 天体推进：周期设为 1600，速度与星尘保持自然视差比（0.45x），保证全曲持续交替巡航
            const entityTravelDist = totalTravelDistance * 0.45;
            const CELESTIAL_CYCLE = 1600;

            for (let s = 0; s < ENTITY_SLOTS; s += 1) {
                const slot = slotConfigs[s];
                const currentZ = (slot.initialZ + entityTravelDist) % CELESTIAL_CYCLE;
                const depth = currentZ > 0 ? currentZ - CELESTIAL_CYCLE : currentZ;

                const tmpl = templates[slot.type] || templates.flagship;

                // 物理生命周期优化：
                // 远方（depth < -850）保持微幅散离；
                // 逼近阶段（-850 到 -520）迅速向心吸附聚拢（快速成型，不再拖沓！）；
                // 黄金观赏区（-520 到 -35）始终呈现完全凝聚定型的清晰点阵实体模型；
                // 掠过镜头（depth > -35）平滑淡出消散。
                let cohesion = 0;
                if (depth < -850) {
                    cohesion = 0.0;
                } else if (depth < -520) {
                    const p = (depth + 850) / 330;
                    cohesion = easeOutCubic(p);
                } else if (depth < -35) {
                    cohesion = 1.0;
                } else {
                    cohesion = smooth((-depth) / 35);
                }

                // 旋转姿态更新
                const rotTime = time * 0.14 + s * 1.2;
                const cosR = Math.cos(rotTime * 0.5 + slot.rotY);
                const sinR = Math.sin(rotTime * 0.5 + slot.rotY);

                const offsetStart = s * POINTS_PER_ENTITY * 3;
                const offsetSeed = s * POINTS_PER_ENTITY * 3;

                for (let p = 0; p < POINTS_PER_ENTITY; p += 1) {
                    const pi = offsetStart + p * 3;
                    const si = offsetSeed + p * 3;

                    const tx0 = tmpl[p * 3] * slot.scale;
                    const ty0 = tmpl[p * 3 + 1] * slot.scale;
                    const tz0 = tmpl[p * 3 + 2] * slot.scale;

                    const rx = tx0 * cosR - tz0 * sinR;
                    const rz = tx0 * sinR + tz0 * cosR;

                    const finalTargetX = slot.x + rx;
                    const finalTargetY = slot.y + ty0;
                    const finalTargetZ = depth + rz;

                    objTargets[pi] = finalTargetX;
                    objTargets[pi + 1] = finalTargetY;
                    objTargets[pi + 2] = finalTargetZ;

                    // 关键修复：消除过度弥散！
                    // 远方的散离幅度从 75 米大幅缩小到微幅量子扰动（6 米以内），保证远方即能识别点阵轮廓，并在逼近后迅速严密咬合！
                    const randSeed = (p * 0.23 + s) % 1;
                    const scatterR = (1 - cohesion) * (3.5 + randSeed * 4.5);
                    objPositions[pi] = finalTargetX + Math.sin(p * 2.1) * scatterR;
                    objPositions[pi + 1] = finalTargetY + Math.cos(p * 1.7) * scatterR;
                    objPositions[pi + 2] = finalTargetZ + (randSeed - 0.5) * scatterR * 1.2;

                    objSeedsArr[si] = randSeed;
                    objSeedsArr[si + 1] = cohesion;

                    objSizesArr[s * POINTS_PER_ENTITY + p] = slot.type === 'flagship' ? 1.6 : slot.type === 'planet' ? 2.0 : 1.3;
                }
            }

            entityGeo.attributes.position.needsUpdate = true;
            entityGeo.attributes.aTarget.needsUpdate = true;
            entityGeo.attributes.aSeed.needsUpdate = true;
            entityGeo.attributes.aColor.needsUpdate = true;
            entityGeo.attributes.aSize.needsUpdate = true;

            // ==========================
            // 5. 歌词空间迎面拉近、向心凝聚成实心文字与破空消散
            // ==========================
            if (activeLine && activePointCount > 0) {
                let lyricZ = -36;
                let cohesionPhase = 0;
                let dispersePhase = 0;

                if (progress < 0.28) {
                    // 1. 从远方深空呼啸拉近到眼前停驻面 (-320 -> -36)
                    const p = progress / 0.28;
                    lyricZ = -320 + (320 - 36) * easeOutCubic(p);
                    // 逼近眼前时迅速向心凝聚咬合
                    cohesionPhase = smooth(p);
                    dispersePhase = 0;
                } else if (progress < 0.85) {
                    // 2. 停驻展示区：点阵完全凝固为实心实体文字，极度平稳
                    const p = (progress - 0.28) / (0.85 - 0.28);
                    lyricZ = -36 + p * 2.5; // 平缓推进浮游
                    cohesionPhase = 1.0;
                    dispersePhase = 0;
                } else {
                    // 3. 句末破空加速脱离：飞速穿透视点消散在身后
                    const p = (progress - 0.85) / 0.15;
                    lyricZ = -33.5 + easeInCubic(p) * 58.0;
                    cohesionPhase = 1.0;
                    dispersePhase = smooth(p);
                }

                lyricParticleMat.uniforms.cohesion.value = cohesionPhase;
                lyricParticleMat.uniforms.disperse.value = dispersePhase;
                lyricParticleMat.uniforms.time.value = time;

                // 彻底消除文字与点阵重影毛边：
                // 1. 实心文字在凝聚收拢到 0.45 时开始清晰显现，并在 progress >= 0.28 完全定型接管
                const solidOpacity = clamp((cohesionPhase - 0.45) / 0.45) * (1.0 - dispersePhase * 1.15);
                solidPlaneMat.opacity = solidOpacity * (settings.reducedMotion ? 0.9 : 1.0);

                // 2. 粒子透明度与实心文字平滑交接：
                // 入场：粒子向心汇聚，在实心文字成型时粒子同步淡出（1.0 -> 0.0）；
                // 停驻期间：粒子完全隐退（opacity = 0），只保留纯净高对比度的实心文本，绝无重影与毛边描边！
                // 离场阶段：实心文字淡出，粒子重新接管并爆发消散向后飞掠
                let lyricParticleAlpha = 0;
                if (progress < 0.28) {
                    lyricParticleAlpha = 1.0 - smooth(Math.max(0, (cohesionPhase - 0.45) / 0.45));
                } else if (progress > 0.85) {
                    lyricParticleAlpha = dispersePhase;
                } else {
                    lyricParticleAlpha = 0.0;
                }
                lyricParticleMat.uniforms.opacity.value = lyricParticleAlpha;

                // 水平微交叉滚转姿态
                solidTextMesh.rotation.z = lyricRollAngle;
                lyricPoints.rotation.z = lyricRollAngle;

                // 随低频平稳浮游微动
                const lyricFloatX = Math.sin(time * 0.3) * 0.4;
                const lyricFloatY = Math.cos(time * 0.25) * 0.25;

                solidTextMesh.position.set(lyricFloatX, lyricFloatY, lyricZ);
                lyricPoints.position.set(lyricFloatX, lyricFloatY, lyricZ);

                // 保持实心文字颜色稳定恒定，其色彩已在 Canvas 内部渲染为高光琥珀金，材质保持纯白滤镜，绝不跳色闪白
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
                entityMat.uniforms.pixelRatio.value = ratio;
                lyricParticleMat.uniforms.pixelRatio.value = ratio;
            },
            destroy() {
                scene.remove(root);
                [starGeo, entityGeo, lyricGeo, solidPlaneGeo].forEach((g) => g?.dispose?.());
                [starMat, entityMat, lyricParticleMat, solidPlaneMat].forEach((m) => m?.dispose?.());
                textTexture?.dispose?.();
            }
        };
    };

    global.MusicStageTunnelManager = Object.freeze({ create });
})(window);