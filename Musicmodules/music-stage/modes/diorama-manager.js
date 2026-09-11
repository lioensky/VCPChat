(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    if (!Utils) throw new Error('MusicStageModeUtils must load before diorama-manager.js');

    const {
        clamp,
        seededRandom,
        splitGraphemes,
        getLineKey,
        renderWords,
        updateWords,
        resolveAccent,
        makeModeBase,
        createElement
    } = Utils;

    // 与 music.html 使用同一份随应用发布的 Three.js，避免 node_modules 与 vendor 版本分裂。
    const THREE_MODULE_PATH = '../../../vendor/three.module.js';

    // 空间步长与视距常数（参考 Folia cameraPath）
    // 空间步长与视距常数：进一步增大距离，消除怼脸感，留足纵深视野
    const STEP_DISTANCE = 11.5; // 每行歌词之间的 3D 前进距离（加大距离以配合更远镜头推进行程）
    const HERO_DISTANCE = 12.4; // 略微拉远初始视距，给交错倾斜的歌词留出边缘空间
    const CAMERA_LIFT = 0.95;   // 稍抬高相机视角，俯瞰歌词长廊更具宏阔感
    const LINES_AHEAD = 4;      // 向前方深处渲染的歌词行数
    const LINES_BEHIND = 1;     // 向后方保留行数缩减为 1，加速已唱完歌词离场

    // 高分辨率文字光栅化常量（参考 Folia dioramaTextRaster: 128px 高清纹理配合各向异性过滤与 mipmap，彻底告别模糊与锯齿）
    const RASTER_FONT_PX = 144;
    const LINE_FONT_WORLD_SIZE = 0.85; // 3D 空间中的文字世界尺寸
    const WORLD_PER_PX = LINE_FONT_WORLD_SIZE / RASTER_FONT_PX;

    // 3D 向量简易计算
    const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
    const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
    const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
    const vnorm = (a) => {
        const len = Math.hypot(a.x, a.y, a.z) || 1;
        return { x: a.x / len, y: a.y / len, z: a.z / len };
    };
    const vcross = (a, b) => ({
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x
    });
    const lerp = (a, b, t) => a + (b - a) * t;
    const vlerp = (a, b, t) => ({
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t)
    });

    /**
     * 构建多层次主题色调色板（主警示/高光色、松石冷色、钛金暖色、微光冷白）
     */
    const getThemePalette = (services, THREE) => {
        const theme = services?.app?.stagePalette || {};
        const accent = resolveAccent(services?.app);
        const colorPrimary = new THREE.Color(`rgb(${accent.r}, ${accent.g}, ${accent.b})`);
        const colorSecondary = new THREE.Color(theme.secondary || '#76bfae');
        const colorTertiary = new THREE.Color(theme.tertiary || '#76bfae');
        const colorHighlight = new THREE.Color(theme.ink || '#f2f0e9');

        return { colorPrimary, colorSecondary, colorTertiary, colorHighlight };
    };

    /**
     * 生成整首歌曲的 3D 蜿蜒飞行路径（仿照 Folia 的 buildDioramaPath）
     */
    const buildDioramaPath = (count, seedStr = 'diorama') => {
        let baseHash = 0;
        for (let i = 0; i < String(seedStr).length; i++) {
            baseHash = (baseHash * 31 + String(seedStr).charCodeAt(i)) % 100000;
        }
        const total = Math.max(count, 1);
        const positions = [];
        let cur = v3(0, 0, 0);

        for (let i = 0; i <= total; i++) {
            positions.push({ ...cur });
            const yaw = 0.42 * (Math.sin(i * 0.25 + baseHash * 0.02) * 0.65 + Math.sin(i * 0.12 + 1.2) * 0.35);
            const pitch = 0.22 * Math.sin(i * 0.18 + baseHash * 0.03 + 0.6);
            const cp = Math.cos(pitch);
            const dir = {
                x: Math.sin(yaw) * cp,
                y: Math.sin(pitch),
                z: -Math.cos(yaw) * cp // 向 -Z 轴前方飞行
            };
            cur = {
                x: cur.x + dir.x * STEP_DISTANCE,
                y: cur.y + dir.y * STEP_DISTANCE,
                z: cur.z + dir.z * STEP_DISTANCE
            };
        }

        const frames = [];
        const WORLD_UP = v3(0, 1, 0);
        for (let i = 0; i < total; i++) {
            const forward = vnorm(vsub(positions[i + 1], positions[i]));
            const right = vnorm(vcross(forward, WORLD_UP));
            const up = vnorm(vcross(right, forward));
            frames.push({
                position: positions[i],
                forward,
                right,
                up
            });
        }
        return frames;
    };

    const createManager = (container, services) => {
        const mode = makeModeBase('diorama', '镜台', container, services);
        const fallback = createElement('div', 'diorama-fallback');
        const fallbackLine = createElement('div', 'diorama-fallback-line');
        const fallbackTranslation = createElement('div', 'stage-translation diorama-fallback-translation');
        fallback.append(fallbackLine, fallbackTranslation);
        mode.root.appendChild(fallback);

        let THREE = null;
        let scene = null;
        let camera = null;
        let renderer = null;
        let corridorGroup = null;
        let liquidField = null;
        let liquidBlobs = [];
        let geometryField = null;
        let floatingGlyphs = [];
        let ribbonField = null;
        let ribbonMaterials = [];
        let vectorDecor = null;
        let vectorDecorNodes = [];
        let particleField = null;
        let particlePositions = null;
        let destroyed = false;
        let suspended = false;
        let initialized = false;
        let width = 0;
        let height = 0;
        let lastFrame = null;
        let pathFrames = [];
        let currentTrackPath = '';
        let fallbackMode = false;
        let initializationPromise = null;
        let renderedKey = null;

        // 缓存各行的 3D 渲染对象
        // Map<lineIndex, { group, units: [{ mesh, mat, state }], lineMesh, lineMat, key }>
        const lineNodes = new Map();

        // 纹理缓存 Map<textKey, { texture, width, height }>
        const textureCache = new Map();

        // 平滑相机状态
        const cameraFollow = {
            pos: v3(0, 0, 10),
            look: v3(0, 0, 0),
            targetPos: v3(0, 0, 10),
            targetLook: v3(0, 0, 0)
        };

        const resources = {
            geometries: new Set(),
            materials: new Set(),
            textures: new Set()
        };

        const remember = (set, res) => {
            if (res) set.add(res);
            return res;
        };

        // 歌词行拥有自己的 geometry/material；纹理由跨行缓存共享，
        // 因此行离开活动窗口时只释放前两者，绝不误释放仍在使用的纹理。
        const disposeLineNode = (node) => {
            if (!node) return;
            corridorGroup?.remove(node.group);
            const geometries = new Set();
            const materials = new Set();
            node.group?.traverse?.(object => {
                if (object.geometry) geometries.add(object.geometry);
                const material = object.material;
                if (Array.isArray(material)) material.forEach(entry => materials.add(entry));
                else if (material) materials.add(material);
            });
            geometries.forEach(geometry => {
                geometry.dispose?.();
                resources.geometries.delete(geometry);
            });
            materials.forEach(material => {
                material.dispose?.();
                resources.materials.delete(material);
            });
        };

        const clearLineNodes = () => {
            lineNodes.forEach(disposeLineNode);
            lineNodes.clear();
        };

        // Only call after clearLineNodes(): active line materials may share these
        // textures, so all material references must be released before disposal.
        const clearTextureCache = () => {
            textureCache.forEach(record => {
                record.texture?.dispose?.();
                resources.textures.delete(record.texture);
            });
            textureCache.clear();
        };

        // 装饰重建时立即释放共享几何与材质，避免切歌后一直留到模式销毁。
        const disposeDecorField = (field) => {
            if (!field) return;
            scene.remove(field);
            const geometries = new Set();
            const materials = new Set();
            field.traverse(obj => {
                if (obj.geometry) geometries.add(obj.geometry);
                if (obj.material) materials.add(obj.material);
            });
            geometries.forEach(geo => {
                geo.dispose();
                resources.geometries.delete(geo);
            });
            materials.forEach(mat => {
                mat.dispose();
                resources.materials.delete(mat);
            });
        };

        const resize = () => {
            if (!mode.root.isConnected) return;
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            if (renderer && camera) {
                renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
                renderer.setSize(width, height, false);
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
            }
        };
/**
 * 高清文字光栅化器：纯白底图在 GPU 上通过材质颜色染色，开启各向异性过滤与三线性抗锯齿
 */
const createTextTexture = (text, isGlow = false) => {
    const key = `${text}__${isGlow ? 'glow' : 'base'}`;
    if (textureCache.has(key)) return textureCache.get(key);

    const canvas = document.createElement('canvas');
    const font = `bold ${RASTER_FONT_PX}px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.font = font;
    const metrics = ctx.measureText(text);
    const advancePx = Math.max(1, Math.ceil(metrics.width));
    const pad = Math.ceil(RASTER_FONT_PX * 0.3);
    const w = advancePx + pad * 2;
    const h = Math.ceil(RASTER_FONT_PX * 1.5);
    canvas.width = w;
    canvas.height = h;

    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (isGlow) {
        // 柔和辉光外晕层
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = RASTER_FONT_PX * 0.22;
        ctx.fillText(text, w / 2, h / 2);
        ctx.fillText(text, w / 2, h / 2);
    } else {
        // 锐利本体层（纯白高精度绘制，由材质负责着色）
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, w / 2, h / 2);
    }

    const texture = remember(resources.textures, new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace || '';
    // 消除走样锯齿的关键：三线性过滤与高质量各向异性
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (renderer?.capabilities?.getMaxAnisotropy) {
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    }

    const record = { texture, canvasWidth: w, canvasHeight: h, advancePx };
    textureCache.set(key, record);
    return record;
};

/**
 * 构建单行歌词在 3D 空间的平面（包含逐词拆分与清晰平滑渲染）
 */
const buildLineMesh = (lineData, lineIdx, isCurrent) => {
    if (!THREE || !lineData || !lineData.fullText) return null;
    const lineGroup = new THREE.Group();
    const words = (lineData.words && lineData.words.length > 0)
        ? lineData.words
        : splitGraphemes(lineData.fullText).map((text, idx) => ({
            text,
            startTime: lineData.startTime + idx * 0.2,
            endTime: lineData.startTime + (idx + 1) * 0.2
        }));

    const unitMeshes = [];
    const accent = resolveAccent(services?.app);
    const accentColor = new THREE.Color(`rgb(${accent.r}, ${accent.g}, ${accent.b})`);
    const restingColor = new THREE.Color(services?.app?.stagePalette?.ink || '#f2f0e9');

    // 预计算总宽度
    let totalWidth = 0;
    const unitViews = words.map(w => {
        const view = createTextTexture(w.text || ' ', false);
        const glowView = isCurrent ? createTextTexture(w.text || ' ', true) : null;
        const unitW = (view?.canvasWidth || 100) * WORLD_PER_PX;
        const unitH = (view?.canvasHeight || 100) * WORLD_PER_PX;
        const advanceW = (view?.advancePx || 80) * WORLD_PER_PX;
        totalWidth += advanceW;
        return { w, view, glowView, unitW, unitH, advanceW };
    });

    let currentX = -totalWidth / 2;
    unitViews.forEach(({ w, view, glowView, unitW, unitH, advanceW }, unitIdx) => {
        if (!view) return;
        const geometry = remember(resources.geometries, new THREE.PlaneGeometry(unitW, unitH));
        
        // 使用独立组包装每个字词，使文字本体与辉光层保持严格同轴等比缩放，杜绝内外错位叠放
        const unitGroup = new THREE.Group();
        // 逐词深度错落：不同字词轻微前后、上下、旋转，形成官方镜台式层叠纵深。
        const depth = Math.sin(unitIdx * 1.73 + lineIdx * 0.61) * 0.32;
        const staggerY = Math.cos(unitIdx * 1.31 + lineIdx) * 0.12;
        unitGroup.position.set(currentX + advanceW / 2, staggerY, depth);
        unitGroup.rotation.z = Math.sin(unitIdx * 0.9 + lineIdx) * 0.035;
        lineGroup.add(unitGroup);

        // 1. 本体材质
        const material = remember(resources.materials, new THREE.MeshBasicMaterial({
            map: view.texture,
            transparent: true,
            opacity: isCurrent ? 0.95 : 0.32,
            color: isCurrent ? accentColor.clone() : restingColor.clone(),
            depthWrite: false,
            side: THREE.DoubleSide
        }));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(0, 0, 0);
        unitGroup.add(mesh);

        // 2. 当前行专属辉光层（AdditiveBlending）
        let glowMesh = null;
        let glowMat = null;
        if (isCurrent && glowView) {
            glowMat = remember(resources.materials, new THREE.MeshBasicMaterial({
                map: glowView.texture,
                transparent: true,
                opacity: 0,
                color: accentColor.clone(),
                depthWrite: false,
                blending: services?.app?.stagePalette?.light ? THREE.NormalBlending : THREE.AdditiveBlending,
                side: THREE.DoubleSide
            }));
            glowMesh = new THREE.Mesh(geometry, glowMat);
            glowMesh.position.set(0, 0, -0.005);
            unitGroup.add(glowMesh);
        }

        unitMeshes.push({
            group: unitGroup,
            mesh,
            mat: material,
            glowMesh,
            glowMat,
            word: w,
            accentColor,
            restingColor,
            localX: currentX + advanceW / 2
        });
        currentX += advanceW;
    });

    // 翻译文本平面（置于主歌词下方）
    if (lineData.translation) {
        const transView = createTextTexture(lineData.translation, false);
        if (transView) {
            const tw = transView.canvasWidth * WORLD_PER_PX * 0.65;
            const th = transView.canvasHeight * WORLD_PER_PX * 0.65;
            const tGeo = remember(resources.geometries, new THREE.PlaneGeometry(tw, th));
            const tMat = remember(resources.materials, new THREE.MeshBasicMaterial({
                map: transView.texture,
                transparent: true,
                opacity: isCurrent ? 0.68 : 0.22,
                color: new THREE.Color(services?.app?.stagePalette?.muted || '#a7afb1'),
                depthWrite: false,
                side: THREE.DoubleSide
            }));
            const tMesh = new THREE.Mesh(tGeo, tMat);
            tMesh.position.set(0, -0.75, 0);
            lineGroup.add(tMesh);
        }
    }

    return { group: lineGroup, units: unitMeshes, totalWidth };
};

        /**
         * 沿 3D 飞行轨迹创建壮观的背景星尘长廊（隧道点云）
         */
        const createCorridorParticles = (frames) => {
            if (!THREE || !scene || !frames.length) return;
            disposeDecorField(particleField);

            const pointsPerLine = 38;
            const totalPoints = frames.length * pointsPerLine;
            particlePositions = new Float32Array(totalPoints * 3);
            const accent = resolveAccent(services?.app);

            frames.forEach((f, lineIdx) => {
                const rnd = seededRandom(`dust:${lineIdx}`);
                for (let p = 0; p < pointsPerLine; p++) {
                    const idx = (lineIdx * pointsPerLine + p) * 3;
                    const radius = 3.5 + rnd() * 6.5; // 隧道半径环绕
                    const angle = rnd() * Math.PI * 2;
                    const offsetZ = (rnd() - 0.5) * STEP_DISTANCE;

                    // 沿路径切线向外环状扩散
                    const localX = Math.cos(angle) * radius;
                    const localY = Math.sin(angle) * radius;

                    particlePositions[idx] = f.position.x + f.right.x * localX + f.up.x * localY + f.forward.x * offsetZ;
                    particlePositions[idx + 1] = f.position.y + f.right.y * localX + f.up.y * localY + f.forward.y * offsetZ;
                    particlePositions[idx + 2] = f.position.z + f.right.z * localX + f.up.z * localY + f.forward.z * offsetZ;
                }
            });

            const geometry = remember(resources.geometries, new THREE.BufferGeometry());
            geometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
            const material = remember(resources.materials, new THREE.PointsMaterial({
                color: new THREE.Color(`rgb(${accent.r}, ${accent.g}, ${accent.b})`),
                size: 0.048,
                transparent: true,
                opacity: 0.45,
                depthWrite: false,
                blending: services?.app?.stagePalette?.light ? THREE.NormalBlending : THREE.AdditiveBlending
            }));

            particleField = new THREE.Points(geometry, material);
            scene.add(particleField);
        };

        /**
         * 高级 3D 拟态液体流变体 Shader (果冻/有机水银质感 + Fresnel 彩虹折射 + 波动形变)
         */
        const liquidVertexShader = `
            uniform float uTime;
            uniform float uEnergy;
            uniform float uDistortion;
            uniform float uMorph;
            uniform float uRing;
            varying vec3 vNormal;
            varying vec3 vWorldPosition;
            varying vec3 vViewPosition;
            varying float vDisplacement;
        
            vec3 liquidSurface(vec2 coord) {
                float a = coord.x * 6.28318530718;
                vec3 p;
                vec3 n;
                if (uRing > 0.5) {
                    float b = coord.y * 6.28318530718;
                    // 留下极细的中心孔，避免角环闭合处法线退化和表面自交。
                    float major = mix(0.50, 0.86, uMorph);
                    float tube = mix(0.47, 0.28, uMorph);
                    n = vec3(cos(b) * cos(a), cos(b) * sin(a), sin(b));
                    p = vec3(major * cos(a), major * sin(a), 0.0) + tube * n;
                    p *= 1.0 + 0.045 * sin(a * 3.0 + uTime * 0.3);
                } else {
                    float b = coord.y * 3.14159265359;
                    n = vec3(-cos(a) * sin(b), -cos(b), sin(a) * sin(b));
                    p = n * length(position);
                }
                float wave1 = sin(p.x * 1.4 + uTime * 0.7) * cos(p.y * 1.2 + uTime * 0.6);
                float wave2 = sin(p.z * 1.5 - uTime * 0.5) * cos(p.x * 1.1 + uTime * 0.8);
                float disp = (wave1 + wave2) * (0.045 + uEnergy * 0.035) * uDistortion;
                return p + n * disp;
            }

            void main() {
                vec3 p = liquidSurface(uv);
                // 对连续参数曲面求切线，而非对屏幕三角面求导，插值后高光保持平滑。
                vec2 sampleUv = vec2(uv.x, clamp(uv.y, 0.001, 0.999));
                vec3 tangentU = liquidSurface(sampleUv + vec2(0.0005, 0.0))
                              - liquidSurface(sampleUv - vec2(0.0005, 0.0));
                vec3 tangentV = liquidSurface(sampleUv + vec2(0.0, 0.0005))
                              - liquidSurface(sampleUv - vec2(0.0, 0.0005));
                vec3 smoothNormal = normalize(cross(tangentU, tangentV));
                vec4 world = modelMatrix * vec4(p, 1.0);
                vWorldPosition = world.xyz;
                vNormal = normalize(normalMatrix * smoothNormal);
                vDisplacement = length(p) - length(position);
        
                vec4 mvPosition = viewMatrix * world;
                vViewPosition = -mvPosition.xyz;
                gl_Position = projectionMatrix * mvPosition;
            }
        `;
        
        const liquidFragmentShader = `
            uniform float uTime;
            uniform float uEnergy;
            uniform vec3 uColorA;
            uniform vec3 uColorB;
            uniform vec3 uColorC;
            uniform float uOpacity;
            varying vec3 vNormal;
            varying vec3 vWorldPosition;
            varying vec3 vViewPosition;
            varying float vDisplacement;
        
            void main() {
                vec3 N = normalize(vNormal);
                vec3 V = normalize(vViewPosition);
        
                // 菲涅尔边缘光 (Fresnel)
                float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.8);
                
                // 伪高光反射
                vec3 lightDir = normalize(vec3(0.6, 0.8, 0.5));
                vec3 H = normalize(lightDir + V);
                float spec = pow(max(dot(N, H), 0.0), 32.0);
        
                // 流变三色渐变
                float flowCoord = dot(vWorldPosition, vec3(0.25, 0.35, 0.15)) + uTime * 0.18 + vDisplacement * 2.0;
                float mixT = 0.5 + 0.5 * sin(flowCoord);
                vec3 liquidColor = mix(uColorA, uColorB, mixT);
                liquidColor = mix(liquidColor, uColorC, fresnel * 0.85);
        
                // 高光与清透边缘加强（水银/水晶通透感：中心高度透光，边缘由于折射呈现晶莹菲涅尔光泽）
                liquidColor = mix(liquidColor * 0.65, uColorC, fresnel * 0.35);
                liquidColor += vec3(spec * 0.42 + fresnel * 0.12);
        
                // 增强透明感：中心基底保持极高通透（低不透明度），主要由边缘轮廓和高光反射表达形体
                float alpha = clamp(uOpacity * (0.16 + fresnel * 0.95 + spec * 0.6 + uEnergy * 0.15), 0.0, 0.82);
                gl_FragColor = vec4(liquidColor, alpha);
            }
        `;
        
        const makeLiquidMaterial = (colorA, colorB, colorC, opacity, distortion = 1.0) => remember(
            resources.materials,
            new THREE.ShaderMaterial({
                uniforms: {
                    uTime: { value: 0 },
                    uEnergy: { value: 0 },
                    uDistortion: { value: distortion },
                    uMorph: { value: 0 },
                    uRing: { value: 0 },
                    uColorA: { value: colorA.clone() },
                    uColorB: { value: colorB.clone() },
                    uColorC: { value: colorC.clone() },
                    uOpacity: { value: opacity }
                },
                vertexShader: liquidVertexShader,
                fragmentShader: liquidFragmentShader,
                transparent: true,
                depthWrite: false,
                side: THREE.FrontSide,
                blending: THREE.NormalBlending
            })
        );
        
        /**
         * 动态 3D 发光流动光轨 Shader（带彗星式跑光/能量流束）
         */
        const ribbonVertexShader = `
            uniform float uTime;
            varying float vUvX;
            varying vec3 vWorldPosition;
            void main() {
                vUvX = uv.x;
                vec4 world = modelMatrix * vec4(position, 1.0);
                vWorldPosition = world.xyz;
                gl_Position = projectionMatrix * viewMatrix * world;
            }
        `;
        
        const ribbonFragmentShader = `
            uniform float uTime;
            uniform float uEnergy;
            uniform vec3 uColor;
            varying float vUvX;
            varying vec3 vWorldPosition;
        
            void main() {
                // 沿轨道流动的光束脉冲 (Comet trail) - 显著放缓流动速度（从 0.85 降至 0.18），如月光般缓慢从容地游走
                float speed = 0.18;
                float flow1 = fract(vUvX * 2.5 - uTime * speed);
                float beam1 = pow(flow1, 6.0) * 1.5;
        
                float flow2 = fract(vUvX * 4.0 + uTime * (speed * 0.7) + 0.5);
                float beam2 = pow(flow2, 8.0) * 1.1;
        
                // 更加空灵透明的流光丝线，跑光束更柔和高雅
                float glow = 0.05 + (beam1 + beam2) * 0.5 + uEnergy * 0.16;
                vec3 finalColor = mix(uColor, vec3(1.0), (beam1 + beam2) * 0.4);
                gl_FragColor = vec4(finalColor, glow * 0.42);
            }
        `;
        
        /**
         * 1. 视区附近的七颗液体，其中三颗以不同周期舒展为有机环。
         */
        const createLiquidBlobs = (frames) => {
            if (!THREE || !scene || !frames.length) return;
            disposeDecorField(liquidField);
            liquidField = new THREE.Group();
            liquidBlobs = [];
            
            const palette = getThemePalette(services, THREE);
        
            // 数量略增，大小错落；不再把少量水滴摊到整首歌曲的不可见远处。
            const totalBlobs = 7;
            const ringGeometry = remember(resources.geometries, new THREE.TorusGeometry(0.86, 0.28, 32, 64));
            const geoTemplates = [
                remember(resources.geometries, new THREE.SphereGeometry(0.9, 64, 48)),
                remember(resources.geometries, new THREE.SphereGeometry(1.15, 64, 48)),
                remember(resources.geometries, new THREE.SphereGeometry(1.4, 64, 48))
            ];
        
            for (let i = 0; i < totalBlobs; i++) {
                const rnd = seededRandom(`liquid-hero:${currentTrackPath}:${i}`);
                const isRing = i % 2 === 1;
                const geo = isRing ? ringGeometry : geoTemplates[i % geoTemplates.length];
                const handedness = (i % 2 === 0) ? 1 : -1;
                const progressOffset = i / totalBlobs;
                
                // 各流变体使用调色板的不同层次（主色、副色、辅助色交替），制造丰富着色
                const colA = (i % 2 === 0) ? palette.colorPrimary : palette.colorSecondary;
                const colB = (i % 3 === 0) ? palette.colorTertiary : (i % 2 === 0 ? palette.colorSecondary : palette.colorPrimary);
                const colC = palette.colorHighlight;
        
                // 大幅增加晶莹通透度：base opacity 控制在 0.25 左右
                const material = makeLiquidMaterial(colA, colB, colC, 0.22 + rnd() * 0.08, 0.6 + rnd() * 0.4);
        
                material.uniforms.uRing.value = isRing ? 1 : 0;

                const mesh = new THREE.Mesh(geo, material);
                mesh.frustumCulled = false;
                mesh.renderOrder = 3;
                liquidField.add(mesh);
        
                liquidBlobs.push({
                    mesh,
                    material,
                    handedness,
                    progressOffset,
                    radius: 3.4 + rnd() * 1.8,
                    phase: rnd() * Math.PI * 2,
                    driftSpeed: 0.035 + rnd() * 0.025,
                    morphSpeed: 0.12 + rnd() * 0.045,
                    baseScale: 0.72 + rnd() * 0.5
                });
            }
            scene.add(liquidField);
        };
        
        /**
         * 2. 空间 3D 线框矢量悬浮几何体（十字准星、旋转线框正方形、线框三角形、几何环）
         */
        const createFloatingGeometry = (frames) => {
            if (!THREE || !scene || !frames.length) return;
            disposeDecorField(geometryField);
            geometryField = new THREE.Group();
            floatingGlyphs = [];
        
            const palette = getThemePalette(services, THREE);
        
            // 每段约三个符号，避免原先总数上限 28 导致长歌曲几乎没有装饰。
            const glyphCount = Math.max(18, Math.min(384, Math.ceil(frames.length * 3)));
            for (let i = 0; i < glyphCount; i++) {
                const rnd = seededRandom(`glyph:${currentTrackPath}:${i}`);
                const type = i % 4; // 0: 十字架, 1: 线框正方形, 2: 线框三角形, 3: 几何环
                const frameIdx = Math.floor((i / glyphCount) * (frames.length - 1));
                const f = frames[frameIdx] || frames[0];
                const nextF = frames[Math.min(frames.length - 1, frameIdx + 1)] || f;
        
                const subP = rnd();
                const pos = vlerp(f.position, nextF.position, subP);
                const right = f.right;
                const up = f.up;
        
                // 三档大小和亮度独立于形状轮换，散布上下两侧，中央留白。
                const layer = Math.floor(i / 4) % 3;
                const side = rnd() > 0.5 ? 1 : -1;
                const lateralDist = side * (3.0 + rnd() * 4.8);
                const verticalDist = (rnd() - 0.5) * 9.0;
        
                let obj = null;
                const group = new THREE.Group();
        
                // 颜色分层：主警示黄/朱砂红、松石绿、金属辅助色、冷白
                const glyphColor = (i % 4 === 0) ? palette.colorPrimary
                                : (i % 4 === 1) ? palette.colorSecondary
                                : (i % 4 === 2) ? palette.colorHighlight
                                : palette.colorTertiary;
        
                if (type === 0) {
                    // 3D 粗细十字标 (Crosshair)
                    const s = 0.5 + rnd() * 0.4;
                    const lineGeo = remember(resources.geometries, new THREE.BufferGeometry());
                    const verts = new Float32Array([
                        -s, 0, 0,   s, 0, 0,
                        0, -s, 0,   0, s, 0,
                        0, 0, -s * 0.25, 0, 0, s * 0.25
                    ]);
                    lineGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
                    const lineMat = remember(resources.materials, new THREE.LineBasicMaterial({
                        color: glyphColor,
                        transparent: true,
                        opacity: 0.45 + rnd() * 0.25,
                        blending: services?.app?.stagePalette?.light ? THREE.NormalBlending : THREE.AdditiveBlending
                    }));
                    obj = new THREE.LineSegments(lineGeo, lineMat);
                } else if (type === 1) {
                    // 线框正方形 / 菱形
                    const s = 0.65 + rnd() * 0.45;
                    const sourceGeo = new THREE.PlaneGeometry(s, s);
                    const boxGeo = remember(resources.geometries, new THREE.EdgesGeometry(sourceGeo));
                    sourceGeo.dispose();
                    const boxMat = remember(resources.materials, new THREE.LineBasicMaterial({
                        color: glyphColor,
                        transparent: true,
                        opacity: 0.4 + rnd() * 0.25,
                        blending: services?.app?.stagePalette?.light ? THREE.NormalBlending : THREE.AdditiveBlending
                    }));
                    obj = new THREE.LineSegments(boxGeo, boxMat);
                } else if (type === 2) {
                    // 线框正三角形
                    const r = 0.6 + rnd() * 0.35;
                    const sourceGeo = new THREE.CircleGeometry(r, 3);
                    const triGeo = remember(resources.geometries, new THREE.EdgesGeometry(sourceGeo));
                    sourceGeo.dispose();
                    const triMat = remember(resources.materials, new THREE.LineBasicMaterial({
                        color: glyphColor,
                        transparent: true,
                        opacity: 0.42 + rnd() * 0.25,
                        blending: services?.app?.stagePalette?.light ? THREE.NormalBlending : THREE.AdditiveBlending
                    }));
                    obj = new THREE.LineSegments(triGeo, triMat);
                } else {
                    // 线框双环
                    const r = 0.75 + rnd() * 0.45;
                    const ringGeo = remember(resources.geometries, new THREE.RingGeometry(r, r + 0.035, 32));
                    const ringMat = remember(resources.materials, new THREE.MeshBasicMaterial({
                        color: glyphColor,
                        transparent: true,
                        opacity: 0.32 + rnd() * 0.2,
                        side: THREE.DoubleSide,
                        blending: services?.app?.stagePalette?.light ? THREE.NormalBlending : THREE.AdditiveBlending
                    }));
                    obj = new THREE.Mesh(ringGeo, ringMat);
                }
        
                obj.material.depthWrite = false;
                obj.material.opacity *= [0.85, 0.55, 0.3][layer];
                group.add(obj);
                // 少量嵌套轮廓：偏轴小十字、双框、内三角和双环，避免机械复制。
                if (i % 3 === 0) {
                    const echo = obj.clone();
                    echo.material = remember(resources.materials, obj.material.clone());
                    echo.material.opacity *= 0.42;
                    echo.scale.setScalar(type === 0 ? 0.32 : 0.66);
                    echo.position.set(type === 0 ? 0.65 : 0.08, 0.1, -0.16);
                    echo.rotation.z = type === 1 ? Math.PI / 4 : 0.12;
                    group.add(echo);
                }
                group.position.set(
                    pos.x + right.x * lateralDist + up.x * verticalDist,
                    pos.y + right.y * lateralDist + up.y * verticalDist,
                    pos.z + right.z * lateralDist + up.z * verticalDist
                );
                group.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
        
                geometryField.add(group);
                floatingGlyphs.push({
                    group,
                    obj,
                    baseRotation: group.rotation.clone(),
                    basePosition: group.position.clone(),
                    baseOpacity: obj.material.opacity,
                    rotSpeed: {
                        x: (rnd() - 0.5) * 0.035,
                        y: (rnd() - 0.5) * 0.045,
                        z: (rnd() - 0.5) * 0.03
                    },
                    baseScale: [1.15, 0.8, 0.48][layer] * (0.85 + rnd() * 0.35),
                    phase: rnd() * Math.PI * 2
                });
            }
        
            scene.add(geometryField);
        };
        
        /**
         * 3. 动态穿梭流光导轨（有流动脉冲的 3D 双螺旋光轨线条）
         */
        const createFlowingRibbons = (frames) => {
            if (!THREE || !scene || frames.length < 2) return;
            disposeDecorField(ribbonField);
            ribbonField = new THREE.Group();
            ribbonMaterials = [];
        
            const palette = getThemePalette(services, THREE);
        
            [1, -1].forEach((handedness, strandIdx) => {
                const points = [];
                const rnd = seededRandom(`ribbon:${currentTrackPath}:${strandIdx}`);
                const phase = rnd() * Math.PI * 2;
        
                frames.forEach((f, idx) => {
                    const t = idx / Math.max(1, frames.length - 1);
                    const angle = phase + handedness * t * Math.PI * 8.0;
                    const r = 2.4 + Math.sin(t * 12.0 + phase) * 0.6;
                    const upShift = Math.cos(t * 16.0 + phase) * 0.8;
                    points.push(new THREE.Vector3(
                        f.position.x + f.right.x * Math.cos(angle) * r + f.up.x * upShift,
                        f.position.y + f.right.y * Math.cos(angle) * r + f.up.y * upShift,
                        f.position.z + f.right.z * Math.cos(angle) * r + f.up.z * upShift
                    ));
                });
        
                const curve = new THREE.CatmullRomCurve3(points);
                curve.curveType = 'centripetal';
                // 极细光轨丝线：管径从 0.045 细化至 0.018，打造轻盈若现的纤细流光
                const tubeGeo = remember(resources.geometries, new THREE.TubeGeometry(
                    curve, Math.max(36, frames.length * 6), 0.018, 6, false
                ));
        
                const mat = remember(resources.materials, new THREE.ShaderMaterial({
                    uniforms: {
                        uTime: { value: 0 },
                        uEnergy: { value: 0 },
                        // 导轨双线使用主色与松石副色交织
                        uColor: { value: strandIdx === 0 ? palette.colorPrimary : palette.colorSecondary }
                    },
                    vertexShader: ribbonVertexShader,
                    fragmentShader: ribbonFragmentShader,
                    transparent: true,
                    depthWrite: false,
                    blending: services?.app?.stagePalette?.light ? THREE.NormalBlending : THREE.AdditiveBlending
                }));
        
                const mesh = new THREE.Mesh(tubeGeo, mat);
                mesh.frustumCulled = false;
                ribbonField.add(mesh);
                ribbonMaterials.push(mat);
            });
        
            scene.add(ribbonField);
        };
        
        /**
         * 4. 增强版 2D 矢量屏幕 HUD（带鲜明角标十字、雷达圆盘与扫描刻度）
         */
        const createVectorDecor = () => {
            if (vectorDecor) vectorDecor.remove();
            vectorDecorNodes = [];
            vectorDecor = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            vectorDecor.classList.add('diorama-vector-decor');
            vectorDecor.setAttribute('viewBox', '0 0 1000 1000');
            vectorDecor.setAttribute('preserveAspectRatio', 'xMidYMid slice');
            vectorDecor.setAttribute('aria-hidden', 'true');
        
            const add = (tag, attrs) => {
                const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
                Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
                vectorDecor.appendChild(node);
                vectorDecorNodes.push(node);
                return node;
            };
        
            // 精炼 2D 界面：减少画面杂乱元素，保留四角视窗标和两个极度轻巧的雷达环
            add('path', { class: 'diorama-hud-bracket', d: 'M 45 75 L 45 45 L 75 45' });
            add('path', { class: 'diorama-hud-bracket', d: 'M 925 45 L 955 45 L 955 75' });
            add('path', { class: 'diorama-hud-bracket', d: 'M 955 925 L 955 955 L 925 955' });
            add('path', { class: 'diorama-hud-bracket', d: 'M 75 955 L 45 955 L 45 925' });
        
            // 少量呼吸小十字
            add('path', { class: 'diorama-hud-cross', d: 'M 50 492 v 16 M 42 500 h 16' });
            add('path', { class: 'diorama-hud-cross', d: 'M 950 492 v 16 M 942 500 h 16' });
        
            // 纯粹的轻量转盘
            add('circle', { class: 'diorama-hud-circle-dashed', cx: '120', cy: '200', r: '36' });
            add('circle', { class: 'diorama-hud-circle-dashed', cx: '880', cy: '800', r: '42' });
        
            // 细致对角刻度线
            add('line', { class: 'diorama-hud-gridline', x1: '20', y1: '500', x2: '160', y2: '500' });
            add('line', { class: 'diorama-hud-gridline', x1: '840', y1: '500', x2: '980', y2: '500' });
        
            mode.root.insertBefore(vectorDecor, fallback);
        };
        
        const updateVectorDecor = (frame, energy) => {
            if (!vectorDecor) return;
            const time = (frame.now || 0) * 0.001;
            // 带有随音频呼吸的细微微动与透明度提升
            vectorDecor.style.opacity = String(Math.min(1, 0.65 + energy * 0.35));
            vectorDecorNodes.forEach((node, index) => {
                const pulse = 0.7 + Math.sin(time * 1.2 + index * 0.4) * 0.2 + energy * 0.3;
                node.style.opacity = String(Math.max(0.3, Math.min(1.0, pulse)));
            });
        };
        const initializeThree = async () => {
            if (initializationPromise) return initializationPromise;
            initializationPromise = Promise.resolve().then(async () => {
                if (global.THREE) {
                    return global.THREE;
                }
                return import(THREE_MODULE_PATH);
            })
                .then((module) => {
                    if (destroyed) return;
                    THREE = module && (module.Scene ? module : (module.default || global.THREE));
                    if (!THREE || !THREE.Scene) {
                        throw new Error('THREE runtime not available');
                    }
                    scene = new THREE.Scene();
                    // 空间雾化：远处如深邃星际长廊，从雾中浮现，唱过后渐隐
                    scene.fog = new THREE.Fog(services?.app?.stagePalette?.background || '#171a1d', 10, 48);

                    camera = new THREE.PerspectiveCamera(54, 1, 0.1, 100);
                    camera.position.set(0, 1, 10);

                    renderer = new THREE.WebGLRenderer({
                        antialias: true,
                        alpha: true,
                        powerPreference: 'high-performance',
                        precision: 'highp'
                    });
                    renderer.outputColorSpace = THREE.SRGBColorSpace || '';
                    renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
                    renderer.setClearColor(0x000000, 0);
                    renderer.domElement.className = 'diorama-canvas';
                    mode.root.insertBefore(renderer.domElement, fallback);

                    corridorGroup = new THREE.Group();
                    scene.add(corridorGroup);
                    createVectorDecor();

                    initialized = true;
                    fallback.hidden = true;
                    resize();

                    if (lastFrame) updateFrameVisuals(lastFrame);
                })
                .catch((err) => {
                    console.warn('[MusicStage:Diorama] Three.js 加载失败，启用 DOM 优雅降级：', err);
                    fallbackMode = true;
                    initialized = false;
                });
            return initializationPromise;
        };

        /**
         * 随着音乐播放，更新多行 3D 歌词长廊与相机飞行穿梭
         */
        const updateFrameVisuals = (frame) => {
            if (!initialized || !renderer || !scene || !camera || suspended) return;

            const trackId = frame.track?.path || frame.track?.title || 'track';
            const lines = frame.lines || [];
            if (!lines.length) return;

            // 歌曲切换时重构 3D 长廊轨迹。先释放引用纹理的材质，
            // 再释放跨行纹理缓存，避免连续切歌累积上一曲的 CanvasTexture。
            if (trackId !== currentTrackPath || pathFrames.length !== lines.length) {
                currentTrackPath = trackId;
                pathFrames = buildDioramaPath(lines.length, trackId);
                clearLineNodes();
                clearTextureCache();
                createCorridorParticles(pathFrames);
                createLiquidBlobs(pathFrames);
                createFloatingGeometry(pathFrames);
                createFlowingRibbons(pathFrames);
            }

            const currentIdx = Math.max(0, Math.min(lines.length - 1, frame.currentLineIndex >= 0 ? frame.currentLineIndex : 0));
            const activeLine = lines[currentIdx];
            const activeFrame = pathFrames[currentIdx] || pathFrames[0];
            const nextFrame = pathFrames[Math.min(pathFrames.length - 1, currentIdx + 1)] || activeFrame;

            // 计算当前行到下一行之间的连续推进度：
            // 当这行唱完、下一行到来前（间奏/空档），让相机继续自然向前飞行并穿过当前行，让唱过的歌词从镜头后方移出视界
            const nextLine = lines[currentIdx + 1];
            const startTime = activeLine?.startTime || 0;
            const declaredEndTime = activeLine?.endTime || (startTime + 5);
            const timedWords = (activeLine?.words || []).filter(word =>
                String(word.text || '').trim() && Number.isFinite(word.endTime) && word.endTime > startTime);
            const endTime = timedWords.length
                ? Math.min(declaredEndTime, Math.max(...timedWords.map(word => word.endTime)))
                : declaredEndTime;
            const nextStartTime = nextLine ? (nextLine.startTime || endTime) : (endTime + 4);
            const currentTime = frame.playbackTime || 0;

            let interLineProgress = 0;
            if (currentTime < endTime) {
                // 正在唱这一行：从 0 推进到 0.72，相机保持在歌词前方追焦
                const duration = Math.max(0.1, endTime - startTime);
                const p = clamp((currentTime - startTime) / duration, 0, 1);
                interLineProgress = p * 0.72;
            } else {
                // 本句已唱完，下一句到来前：从 0.72 继续向前平滑飞跃到 1.0
                const gap = Math.max(0.1, nextStartTime - endTime);
                const p = clamp((currentTime - endTime) / gap, 0, 1);
                interLineProgress = 0.72 + p * 0.28;
            }

            // ==========================================
            // 核心：相机沿 3D 路径持续穿梭飞行 (Flythrough)
            // ==========================================
            const tuning = mode.config.modes?.diorama || {};
            const speed = Number(tuning.cameraSpeed) || 1.0;
            const motion = Number(tuning.motionAmount) || 1.0;

            // 计算当前唱词光标（Word-by-Word）在歌词行中的横向位置偏移：
            // 让镜头跟随当前唱到的字词进行横向追焦（Tracking Shot），看完整句歌词
            let wordCursorX = 0;
            const currentNode = lineNodes.get(currentIdx);
            if (currentNode && currentNode.units.length > 0 && currentTime < endTime) {
                const activeWordIdx = frame.activeWordIndex;
                if (activeWordIdx >= 0 && currentNode.units[activeWordIdx]) {
                    const unit = currentNode.units[activeWordIdx];
                    const nextUnit = currentNode.units[activeWordIdx + 1];
                    const p = frame.wordProgress || 0;
                    const uX = unit.localX || 0;
                    const nextX = nextUnit ? (nextUnit.localX || uX) : uX;
                    // 平滑跟随当前字并向下一个字过渡
                    wordCursorX = lerp(uX, nextX, p);
                } else {
                    // 没有逐字时间戳时，根据行内进度从最左平滑横移到最右
                    const totalW = currentNode.totalWidth || 0;
                    const lineP = clamp((currentTime - startTime) / Math.max(0.1, endTime - startTime), 0, 1);
                    wordCursorX = (-totalW / 2 + totalW * lineP) * 0.65;
                }
            }
            // 间奏阶段光标归中，平滑向下一行对准
            if (currentTime >= endTime) {
                const fadeGap = clamp((interLineProgress - 0.72) / 0.28, 0, 1);
                wordCursorX = lerp(wordCursorX, 0, fadeGap);
            }

            // 当前正在唱/穿梭的位置沿着切线向下一行持续前进
            const currentFocalPos = vlerp(activeFrame.position, nextFrame.position, interLineProgress);
            const currentForward = vlerp(activeFrame.forward, nextFrame.forward, interLineProgress);
            const currentRight = activeFrame.right;
            const currentUp = activeFrame.up;

            // 镜头横向稳定追轨：镜头拉远后整行歌词尽收眼底，大幅削减逐字偏移系数（从 0.62 降至 0.18），消除字词间拉扯感
            const cursorTrackingOffset = wordCursorX * 0.18;

            // 消除晃荡感：将模拟手持摄影机的摇晃大幅弱化（从 0.4/0.2 降为极其平稳的 0.08/0.04），呈电影导轨（Dolly Track）般稳健运镜
            const sway = Math.sin(interLineProgress * Math.PI) * 0.08 * motion;
            const bob = Math.cos(interLineProgress * Math.PI * 2) * 0.04 * motion;

            // 句尾仍保留至少 8.8 的轴向阅读距离，避免推进把歌词从远景推成贴脸特写。
            // 间奏也延续同一距离函数，不在结束瞬间跳变；旧歌词由独立离场动画退出。
            const focalAdvance = vsub(currentFocalPos, activeFrame.position);
            const forwardLength = Math.hypot(currentForward.x, currentForward.y, currentForward.z) || 1;
            const axialAdvance = (
                focalAdvance.x * currentForward.x +
                focalAdvance.y * currentForward.y +
                focalAdvance.z * currentForward.z
            ) / forwardLength;
            const followDistance = Math.max(HERO_DISTANCE, (8.8 + axialAdvance) / forwardLength);
            const targetCamPos = {
                x: currentFocalPos.x - currentForward.x * followDistance + currentRight.x * (cursorTrackingOffset + sway),
                y: currentFocalPos.y - currentForward.y * followDistance + currentUp.y * (CAMERA_LIFT + bob),
                z: currentFocalPos.z - currentForward.z * followDistance
            };

            // 相机注视点：保持向前视准，注视点横向微调大幅收敛，避免视角双重晃动
            const targetLookAt = {
                x: currentFocalPos.x + currentForward.x * 4.5 + currentRight.x * (cursorTrackingOffset * 0.25),
                y: currentFocalPos.y + currentUp.y * 0.15,
                z: currentFocalPos.z + currentForward.z * 4.5
            };

            // 增强相机阻尼与缓动过渡（通过适度降低每帧插值权重至 0.048，获得丝滑从容的重力阻尼感）
            cameraFollow.pos = vlerp(cameraFollow.pos, targetCamPos, 0.048 * speed);
            cameraFollow.look = vlerp(cameraFollow.look, targetLookAt, 0.055 * speed);

            camera.position.set(cameraFollow.pos.x, cameraFollow.pos.y, cameraFollow.pos.z);
            camera.lookAt(cameraFollow.look.x, cameraFollow.look.y, cameraFollow.look.z);

            // ==========================================
            // 窗口化更新前后的 3D 歌词实体
            // ==========================================
            const minLine = Math.max(0, currentIdx - LINES_BEHIND);
            const maxLine = Math.min(lines.length - 1, currentIdx + LINES_AHEAD);

            // 回收超出视野的歌词及其独占 GPU 资源。
            lineNodes.forEach((node, idx) => {
                if (idx < minLine || idx > maxLine) {
                    disposeLineNode(node);
                    lineNodes.delete(idx);
                }
            });

            // 挂载/更新窗口内的歌词
            for (let i = minLine; i <= maxLine; i++) {
                const lineData = lines[i];
                const pFrame = pathFrames[i];
                if (!lineData || !pFrame) continue;

                const isCurrent = (i === currentIdx);
                const lineKey = `${i}__${lineData.fullText}__${isCurrent}`;
                let node = lineNodes.get(i);

                if (!node || node.key !== lineKey) {
                    if (node) disposeLineNode(node);
                    const built = buildLineMesh(lineData, i, isCurrent);
                    if (built) {
                        node = { ...built, key: lineKey };
                        // 定位到 3D 轨迹上
                        node.group.position.set(pFrame.position.x, pFrame.position.y, pFrame.position.z);
                        // 面向相机前进方向（面向后方来的镜头）
                        node.group.quaternion.setFromRotationMatrix(
                            new THREE.Matrix4().makeBasis(
                                new THREE.Vector3(pFrame.right.x, pFrame.right.y, pFrame.right.z),
                                new THREE.Vector3(pFrame.up.x, pFrame.up.y, pFrame.up.z),
                                new THREE.Vector3(-pFrame.forward.x, -pFrame.forward.y, -pFrame.forward.z)
                            )
                        );
                        // 水平行与轻斜行穿插，少量较大倾角形成交错，而非每行强制组成 X。
                        // 固定种子保证高亮重建、回放和拖动进度时角度一致。
                        const tiltRandom = seededRandom(`line-tilt:${currentTrackPath}:${i}`);
                        const tiltSign = i % 2 === 0 ? 1 : -1;
                        const tiltAmount = tiltRandom() < 0.25 ? 0 : Math.pow(tiltRandom(), 1.5);
                        const lineTilt = tiltSign * tiltAmount * Math.PI / 15; // 0°～12°
                        node.group.rotateZ(lineTilt);
                        node.group.rotateY(tiltSign * 0.075 * tiltAmount);
                        corridorGroup.add(node.group);
                        lineNodes.set(i, node);
                    }
                }

                // 逐词实时高亮与透明度更新
                if (node) {
                    const offset = i - currentIdx;
                    // 确保播放结束的歌词彻底离开画面：
                    // 1. 若当前行已唱完，在进入下一行的间奏推进期（0.72~1.0）加速淡出至 0.0，杜绝残留在广角镜头边缘
                    const isPassedCurrent = isCurrent && (currentTime >= endTime);
                    // 离场使用实际秒数，不再把淡出拉长到整个间奏。
                    const exitDuration = Math.min(1.1, Math.max(0.25, nextStartTime - endTime));
                    const exitProgress = isPassedCurrent
                        ? clamp((currentTime - endTime) / exitDuration, 0, 1)
                        : 0;
                    const exitEase = exitProgress * exitProgress * (3 - 2 * exitProgress);
                    const currentFadeOut = 1 - exitEase;
                    // 整组包括翻译越过镜头后方，倒退寻址时恢复原位。
                    const exitDistance = (HERO_DISTANCE + STEP_DISTANCE + 6) * exitEase;
                    node.group.position.set(
                        pFrame.position.x - pFrame.forward.x * exitDistance,
                        pFrame.position.y - pFrame.forward.y * exitDistance,
                        pFrame.position.z - pFrame.forward.z * exitDistance
                    );
                    node.group.visible = offset >= 0 && currentFadeOut > 0;
                    node.group.children.forEach(child => {
                        if (child.isMesh && child.material) {
                            child.material.opacity = (isCurrent ? 0.68 : 0.22) * currentFadeOut;
                        }
                    });
                    
                    // 2. 过去的歌词（offset < 0）迅速消隐至 0，绝不阻挡远距离镜头的景深穿透
                    let baseOpacity = 0.0;
                    if (isCurrent) {
                        baseOpacity = 0.92 * currentFadeOut;
                    } else if (offset > 0) {
                        // 前方歌词在深处雾气中若隐若现
                        baseOpacity = 0.42 / (offset * 1.35);
                    } else {
                        // 已经完全唱过去的上一行歌词：随着向后飞驰彻底隐没
                        baseOpacity = 0.0;
                    }

                    node.units.forEach((u, unitIdx) => {
                        const wordState = frame.wordStates?.[unitIdx];
                        if (isCurrent && wordState && !isPassedCurrent) {
                            const isWordActive = wordState.status === 'active';
                            const isWordPassed = wordState.status === 'passed';
                            u.mat.opacity = isWordActive ? 1.0 : (isWordPassed ? 0.88 : 0.42);
                            if (isWordActive) {
                                const p = wordState.progress || 0;
                                u.group.scale.setScalar(1.0 + p * 0.06);
                                u.mat.color.copy(u.accentColor);
                                if (u.glowMat) {
                                    u.glowMat.opacity = 0.85 + (frame.audio?.vocal || 0) * 0.4;
                                }
                            } else if (isWordPassed) {
                                u.group.scale.setScalar(1.0);
                                u.mat.color.copy(u.accentColor);
                                if (u.glowMat) {
                                    u.glowMat.opacity = 0.15;
                                }
                            } else {
                                u.group.scale.setScalar(1.0);
                                u.mat.color.copy(u.restingColor);
                                if (u.glowMat) {
                                    u.glowMat.opacity = 0;
                                }
                            }
                        } else {
                            u.mat.opacity = baseOpacity;
                            u.group.scale.setScalar(1.0);
                            if (u.glowMat) u.glowMat.opacity = 0;
                        }
                    });
                }
            }

            // ==========================================
            // 1. 稀疏 3D 巨型有机流变体：沿走廊双螺旋悠然巡游漂浮
            // ==========================================
            const timeSec = (frame.now || 0) * 0.001;
            const audio = frame.audio || {};
            const energy = Number(audio.bass || 0) * 0.65 + Number(audio.vocal || 0) * 0.35;

            if (liquidBlobs.length && pathFrames.length) {
                liquidBlobs.forEach((blob, bIdx) => {
                    // 固定世界单位的局部景深，不随歌曲长度加速，也没有取模回跳。
                    const depth = -1.5 + blob.progressOffset * 23
                        + Math.sin(timeSec * blob.driftSpeed + blob.phase) * 1.4;
                    const corePos = vadd(currentFocalPos, vscale(currentForward, depth));
                    const coreRight = currentRight;
                    const coreUp = currentUp;

                    const angle = blob.phase + timeSec * blob.driftSpeed * blob.handedness;
                    const spiralX = Math.cos(angle) * blob.radius;
                    const spiralY = Math.sin(angle) * blob.radius;

                    blob.mesh.position.set(
                        corePos.x + coreRight.x * spiralX + coreUp.x * spiralY,
                        corePos.y + coreRight.y * spiralX + coreUp.y * spiralY,
                        corePos.z + coreRight.z * spiralX + coreUp.z * spiralY
                    );

                    // 极其舒缓的自转与呼吸
                    const pulse = blob.baseScale * (1.0 + energy * 0.06 + Math.sin(timeSec * 0.25 + bIdx) * 0.04);
                    blob.mesh.scale.set(
                        pulse * (1.0 + Math.sin(timeSec * 0.22 + bIdx) * 0.12),
                        pulse * (1.0 + Math.cos(timeSec * 0.19 + bIdx) * 0.1),
                        pulse * (1.0 + Math.sin(timeSec * 0.27 + bIdx) * 0.08)
                    );
                    // 按时间求值，重复更新同一帧不会额外加速。
                    blob.mesh.rotation.set(
                        blob.phase * 0.2 + timeSec * 0.025,
                        blob.phase + timeSec * 0.035 * blob.handedness,
                        Math.sin(timeSec * 0.08 + blob.phase) * 0.18
                    );

                    const morph = clamp((Math.sin(timeSec * blob.morphSpeed + blob.phase) + 0.25) / 1.15, 0, 1);
                    blob.material.uniforms.uMorph.value = morph * morph * (3 - 2 * morph);
                    blob.material.uniforms.uTime.value = timeSec * 0.45 + blob.phase;
                    blob.material.uniforms.uEnergy.value = energy;
                });
            }

            // ==========================================
            // 2. 空间悬浮 3D 几何（十字、线框正方、三角形、圆环）：旋转与呼吸
            // ==========================================
            if (floatingGlyphs.length) {
                floatingGlyphs.forEach((g) => {
                    g.group.rotation.set(
                        g.baseRotation.x + timeSec * g.rotSpeed.x,
                        g.baseRotation.y + timeSec * g.rotSpeed.y,
                        g.baseRotation.z + timeSec * g.rotSpeed.z
                    );
                    g.group.position.y = g.basePosition.y + Math.sin(timeSec * 0.18 + g.phase) * 0.18;
                    const scalePulse = g.baseScale * (1.0 + energy * 0.06 + Math.sin(timeSec * 0.35 + g.phase) * 0.04);
                    g.group.scale.setScalar(scalePulse);
                    g.obj.material.opacity = g.baseOpacity * (0.88 + Math.sin(timeSec * 0.28 + g.phase) * 0.12);
                });
            }

            // ==========================================
            // 3. 动态穿梭流光导轨（有流动能量光束的线条）：随时间前进
            // ==========================================
            if (ribbonMaterials.length) {
                ribbonMaterials.forEach((mat) => {
                    mat.uniforms.uTime.value = timeSec;
                    mat.uniforms.uEnergy.value = energy;
                });
            }

            // 4. 更新 2D 矢量 HUD 响应
            updateVectorDecor(frame, energy);

            // ==========================================
            // 星尘粒子响应与空间穿行光效
            // ==========================================
            if (particleField) {
                const audio = frame.audio || {};
                const reactivity = Number(tuning.audioReactivity) || 1.0;
                particleField.material.opacity = 0.25 + (audio.bass || 0) * 0.45 * reactivity;
                particleField.material.size = 0.045 + (audio.treble || 0) * 0.04 * reactivity;
            }

            renderer.render(scene, camera);
        };

        const renderFallback = (frame) => {
            if (!fallbackMode && initialized) return;
            const key = getLineKey(frame.activeLine);
            if (key !== renderedKey) {
                renderedKey = key;
                if (frame.activeLine) {
                    renderWords(fallbackLine, frame, 'diorama-word');
                    fallbackTranslation.textContent = frame.activeLine.translation || frame.activeLine.romanization || '';
                } else {
                    fallbackLine.textContent = '等待音乐';
                    fallbackTranslation.textContent = '';
                }
            }
            fallback.hidden = false;
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed) return;
            lastFrame = frame;
            renderFallback(frame);
            if (!initialized && !fallbackMode) void initializeThree();
            if (initialized && !suspended) updateFrameVisuals(frame);
        };

        mode.resize = resize;
        mode.suspend = () => {
            suspended = true;
            mode.root.classList.add('is-suspended');
        };
        mode.resume = () => {
            suspended = false;
            mode.root.classList.remove('is-suspended');
            if (lastFrame) updateFrameVisuals(lastFrame);
        };
        mode.updateTheme = () => {
            if (!THREE || !scene) return;
            const theme = services?.app?.stagePalette || {};
            scene.fog?.color.set(theme.background || '#171a1d');

            // Rebuild the small active lyric window from the same absolute frame.
            // This releases all cached CanvasTextures without resetting camera/timing,
            // and guarantees every rebuilt material uses the new theme blending/color.
            clearLineNodes();
            clearTextureCache();
            createCorridorParticles(pathFrames);
            createLiquidBlobs(pathFrames);
            createFloatingGeometry(pathFrames);
            createFlowingRibbons(pathFrames);
            if (lastFrame && !suspended) updateFrameVisuals(lastFrame);
        };

        mode.scope.add(() => {
            destroyed = true;
            if (particleField) {
                scene?.remove(particleField);
            }
            if (liquidField) {
                scene?.remove(liquidField);
                liquidBlobs = [];
            }
            if (geometryField) {
                scene?.remove(geometryField);
                floatingGlyphs = [];
            }
            if (ribbonField) {
                scene?.remove(ribbonField);
                ribbonMaterials = [];
            }
            if (vectorDecor) {
                vectorDecor.remove();
                vectorDecor = null;
            }
            vectorDecorNodes = [];
            clearLineNodes();
            clearTextureCache();
            resources.geometries.forEach(res => res.dispose?.());
            resources.materials.forEach(res => res.dispose?.());
            resources.textures.forEach(res => res.dispose?.());
            resources.geometries.clear();
            resources.materials.clear();
            resources.textures.clear();
            renderer?.dispose?.();
            renderer?.forceContextLoss?.();
            renderer?.domElement?.remove();
            scene = null;
            camera = null;
            renderer = null;
            corridorGroup = null;
            particleField = null;
        });

        resize();
        void initializeThree();
        return mode;
    };

    global.MusicStageDioramaManager = Object.freeze({ create: createManager });
})(window);