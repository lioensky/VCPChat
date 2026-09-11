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

    const THREE_MODULE_PATH = '../../../node_modules/three/build/three.module.js';

    // 空间步长与视距常数（参考 Folia cameraPath）
    const STEP_DISTANCE = 8.5; // 每行歌词之间的 3D 前进距离
    const HERO_DISTANCE = 5.8; // 相机与当前焦点歌词的跟随距离
    const CAMERA_LIFT = 0.65;  // 相机相对焦点的高度提升
    const LINES_AHEAD = 4;     // 向前方深处渲染的歌词行数
    const LINES_BEHIND = 2;    // 向后方退去渲染的歌词行数

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
        let particleField = null;
        let particlePositions = null;
        let animationFrame = 0;
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
    const restingColor = new THREE.Color(0.88, 0.92, 0.98);

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
        mesh.position.set(currentX + advanceW / 2, 0, 0);
        lineGroup.add(mesh);

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
                blending: THREE.AdditiveBlending,
                side: THREE.DoubleSide
            }));
            glowMesh = new THREE.Mesh(geometry, glowMat);
            glowMesh.position.set(currentX + advanceW / 2, 0, -0.01);
            lineGroup.add(glowMesh);
        }

        unitMeshes.push({
            mesh,
            mat: material,
            glowMesh,
            glowMat,
            word: w,
            accentColor,
            restingColor
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
                color: new THREE.Color(0.75, 0.85, 0.98),
                depthWrite: false,
                side: THREE.DoubleSide
            }));
            const tMesh = new THREE.Mesh(tGeo, tMat);
            tMesh.position.set(0, -0.75, 0);
            lineGroup.add(tMesh);
        }
    }

    return { group: lineGroup, units: unitMeshes };
};

        /**
         * 沿 3D 飞行轨迹创建壮观的背景星尘长廊（隧道点云）
         */
        const createCorridorParticles = (frames) => {
            if (!THREE || !scene || !frames.length) return;
            if (particleField) {
                scene.remove(particleField);
                particleField.geometry?.dispose();
                particleField.material?.dispose();
            }

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
                blending: THREE.AdditiveBlending
            }));

            particleField = new THREE.Points(geometry, material);
            scene.add(particleField);
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
                    scene.fog = new THREE.Fog(0x05070f, 10, 48);

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

            // 歌曲切换时重构 3D 长廊轨迹
            if (trackId !== currentTrackPath || pathFrames.length !== lines.length) {
                currentTrackPath = trackId;
                pathFrames = buildDioramaPath(lines.length, trackId);
                // 清理旧行与旧纹理
                lineNodes.forEach(node => {
                    corridorGroup.remove(node.group);
                });
                lineNodes.clear();
                createCorridorParticles(pathFrames);
            }

            const currentIdx = Math.max(0, Math.min(lines.length - 1, frame.currentLineIndex >= 0 ? frame.currentLineIndex : 0));
            const activeLine = lines[currentIdx];
            const activeFrame = pathFrames[currentIdx] || pathFrames[0];
            const nextFrame = pathFrames[Math.min(pathFrames.length - 1, currentIdx + 1)] || activeFrame;

            // 行内播放时间推进度 (0 ~ 1)
            const duration = Math.max(0.1, (activeLine?.endTime || 5) - (activeLine?.startTime || 0));
            const lineProgress = clamp(((frame.playbackTime || 0) - (activeLine?.startTime || 0)) / duration, 0, 1);

            // ==========================================
            // 核心：相机沿 3D 路径持续穿梭飞行 (Flythrough)
            // ==========================================
            const tuning = mode.config.modes?.diorama || {};
            const speed = Number(tuning.cameraSpeed) || 1.0;
            const motion = Number(tuning.motionAmount) || 1.0;

            // 当前正在唱的位置沿着贝塞尔/切线向下一行推进
            const currentFocalPos = vlerp(activeFrame.position, nextFrame.position, lineProgress * 0.45);
            const currentForward = vlerp(activeFrame.forward, nextFrame.forward, lineProgress);
            const currentRight = activeFrame.right;
            const currentUp = activeFrame.up;

            // 随着行内进度，相机带有呼吸弧线运镜（避免机械式纯直线，模拟手持摄影机）
            const sway = Math.sin(lineProgress * Math.PI) * 0.8 * motion;
            const bob = Math.cos(lineProgress * Math.PI * 2) * 0.3 * motion;

            // 相机目标位置：跟随在当前焦点歌词的后方 HERO_DISTANCE，加上高度升力与运镜晃动
            const targetCamPos = {
                x: currentFocalPos.x - currentForward.x * HERO_DISTANCE + currentRight.x * sway,
                y: currentFocalPos.y - currentForward.y * HERO_DISTANCE + currentUp.y * (CAMERA_LIFT + bob),
                z: currentFocalPos.z - currentForward.z * HERO_DISTANCE
            };

            // 相机目标焦点：注视当前歌词稍前方
            const targetLookAt = {
                x: currentFocalPos.x + currentForward.x * 3.5,
                y: currentFocalPos.y + currentUp.y * 0.2,
                z: currentFocalPos.z + currentForward.z * 3.5
            };

            // 平滑相机追焦 (Critically damped lerp)
            cameraFollow.pos = vlerp(cameraFollow.pos, targetCamPos, 0.08 * speed);
            cameraFollow.look = vlerp(cameraFollow.look, targetLookAt, 0.1 * speed);

            camera.position.set(cameraFollow.pos.x, cameraFollow.pos.y, cameraFollow.pos.z);
            camera.lookAt(cameraFollow.look.x, cameraFollow.look.y, cameraFollow.look.z);

            // ==========================================
            // 窗口化更新前后的 3D 歌词实体
            // ==========================================
            const minLine = Math.max(0, currentIdx - LINES_BEHIND);
            const maxLine = Math.min(lines.length - 1, currentIdx + LINES_AHEAD);

            // 回收超出视野的歌词
            lineNodes.forEach((node, idx) => {
                if (idx < minLine || idx > maxLine) {
                    corridorGroup.remove(node.group);
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
                    if (node) corridorGroup.remove(node.group);
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
                        corridorGroup.add(node.group);
                        lineNodes.set(i, node);
                    }
                }

                // 逐词实时高亮与透明度更新
                if (node) {
                    const offset = i - currentIdx;
                    // 距离当前唱段越远，透明度越低，沉入背景雾气中平滑过渡
                    const baseOpacity = isCurrent ? 1.0 : offset > 0 ? (0.45 / (offset * 1.2)) : 0.22;
                    node.units.forEach((u, unitIdx) => {
                        const wordState = frame.wordStates?.[unitIdx];
                        if (isCurrent && wordState) {
                            const isWordActive = wordState.status === 'active';
                            const isWordPassed = wordState.status === 'passed';
                            u.mat.opacity = isWordActive ? 1.0 : (isWordPassed ? 0.88 : 0.42);
                            if (isWordActive) {
                                const p = wordState.progress || 0;
                                u.mesh.scale.setScalar(1.0 + p * 0.12);
                                u.mat.color.copy(u.accentColor);
                                if (u.glowMat) {
                                    u.glowMat.opacity = 0.85 + (frame.audio?.vocal || 0) * 0.4;
                                }
                            } else if (isWordPassed) {
                                u.mesh.scale.setScalar(1.0);
                                u.mat.color.copy(u.accentColor);
                                if (u.glowMat) {
                                    u.glowMat.opacity = 0.15;
                                }
                            } else {
                                u.mesh.scale.setScalar(1.0);
                                u.mat.color.copy(u.restingColor);
                                if (u.glowMat) {
                                    u.glowMat.opacity = 0;
                                }
                            }
                        } else {
                            u.mat.opacity = baseOpacity;
                            u.mesh.scale.setScalar(1.0);
                            if (u.glowMat) u.glowMat.opacity = 0;
                        }
                    });
                }
            }

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

        const frameLoop = () => {
            if (destroyed) return;
            if (!suspended && lastFrame) updateFrameVisuals(lastFrame);
            animationFrame = global.requestAnimationFrame(frameLoop);
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
            currentTrackPath = ''; // 触发颜色与长廊重构
            textureCache.clear();
        };

        mode.scope.add(() => {
            destroyed = true;
            global.cancelAnimationFrame(animationFrame);
            if (particleField) {
                scene?.remove(particleField);
            }
            lineNodes.forEach(node => {
                corridorGroup?.remove(node.group);
            });
            lineNodes.clear();
            textureCache.forEach(rec => rec.texture?.dispose?.());
            textureCache.clear();
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
        animationFrame = global.requestAnimationFrame(frameLoop);
        void initializeThree();
        return mode;
    };

    global.MusicStageDioramaManager = Object.freeze({ create: createManager });
})(window);