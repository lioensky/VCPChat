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
        let lyricGroup = null;
        let particleField = null;
        let fogMaterial = null;
        let resizeObserver = null;
        let animationFrame = 0;
        let destroyed = false;
        let suspended = false;
        let initialized = false;
        let renderedKey = '';
        let wordMeshes = [];
        let lastFrame = null;
        let width = 0;
        let height = 0;
        let fallbackWordElements = [];
        let fallbackMode = false;
        let initializationPromise = null;

        const resources = {
            geometries: new Set(),
            materials: new Set(),
            textures: new Set()
        };

        const remember = (set, resource) => {
            if (resource) set.add(resource);
            return resource;
        };

        const resolveColor = (value, fallbackValue = 0xffffff) => {
            if (!THREE) return fallbackValue;
            if (typeof value === 'number') return value;
            const color = resolveAccent(services?.app);
            return new THREE.Color(`rgb(${color.r}, ${color.g}, ${color.b})`).getHex();
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

        const clearLyrics = () => {
            wordMeshes.forEach(({ mesh }) => {
                lyricGroup?.remove(mesh);
                mesh.geometry?.dispose?.();
                mesh.material?.dispose?.();
            });
            wordMeshes = [];
            lyricGroup?.clear?.();
        };

        const createTextTexture = (text, fontSize, color) => {
            const canvas = document.createElement('canvas');
            const dpr = Math.min(2, global.devicePixelRatio || 1);
            const font = `700 ${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
            const context = canvas.getContext('2d');
            if (!context) return null;
            context.font = font;
            const measured = Math.max(32, Math.ceil(context.measureText(text).width + fontSize * 0.8));
            canvas.width = Math.ceil(measured * dpr);
            canvas.height = Math.ceil(fontSize * 1.8 * dpr);
            context.scale(dpr, dpr);
            context.font = font;
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillStyle = color;
            context.shadowColor = color;
            context.shadowBlur = fontSize * 0.18;
            context.fillText(text, measured / 2, fontSize * 0.82);
            const texture = remember(resources.textures, new THREE.CanvasTexture(canvas));
            texture.colorSpace = THREE.SRGBColorSpace;
            return { texture, width: measured, height: fontSize * 1.8 };
        };

        const rebuildLyrics = (frame) => {
            if (!initialized || !lyricGroup) return;
            clearLyrics();
            renderedKey = getLineKey(frame.activeLine);
            if (!frame.activeLine) return;

            const tuning = mode.config.modes?.diorama || {};
            const fontSize = Math.max(28, Math.min(88, height * 0.09));
            const accent = resolveAccent(services?.app);
            const primary = `rgb(${accent.r}, ${accent.g}, ${accent.b})`;
            const random = seededRandom(`diorama:${renderedKey}`);
            const words = frame.wordStates?.length
                ? frame.wordStates
                : splitGraphemes(frame.activeLine.fullText).map((text) => ({
                    text,
                    status: 'waiting',
                    progress: 0
                }));

            words.forEach((state, index) => {
                const view = createTextTexture(state.text || ' ', fontSize, primary);
                if (!view) return;
                const geometry = remember(resources.geometries, new THREE.PlaneGeometry(
                    view.width / 46,
                    view.height / 46
                ));
                const material = remember(resources.materials, new THREE.MeshBasicMaterial({
                    map: view.texture,
                    transparent: true,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                    opacity: 0.18
                }));
                const mesh = new THREE.Mesh(geometry, material);
                const spread = (index - (words.length - 1) / 2) * Math.min(1.18, 12 / Math.max(words.length, 1));
                mesh.position.set(
                    spread + (random() - 0.5) * 0.35,
                    (random() - 0.5) * 0.28,
                    -index * 0.12
                );
                mesh.rotation.set((random() - 0.5) * 0.18, (random() - 0.5) * 0.24, (random() - 0.5) * 0.12);
                mesh.userData.index = index;
                lyricGroup.add(mesh);
                wordMeshes.push({ mesh, state });
            });
            lyricGroup.position.set(0, 0.05, -2.2);
            lyricGroup.scale.setScalar(Number(tuning.motionAmount) || 1);
        };

        const createParticles = () => {
            if (!THREE || !scene) return;
            const count = mode.config.quality === 'energy-saving' ? 260 : mode.config.quality === 'ultimate' ? 900 : 520;
            const positions = new Float32Array(count * 3);
            const random = seededRandom(`diorama-particles:${services?.app?.currentTrackIndex || 0}`);
            for (let index = 0; index < count; index += 1) {
                positions[index * 3] = (random() - 0.5) * 18;
                positions[index * 3 + 1] = (random() - 0.5) * 10;
                positions[index * 3 + 2] = -random() * 18;
            }
            const geometry = remember(resources.geometries, new THREE.BufferGeometry());
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const accent = resolveAccent(services?.app);
            const material = remember(resources.materials, new THREE.PointsMaterial({
                color: new THREE.Color(`rgb(${accent.r}, ${accent.g}, ${accent.b})`),
                size: 0.035,
                transparent: true,
                opacity: 0.54,
                depthWrite: false
            }));
            particleField = new THREE.Points(geometry, material);
            scene.add(particleField);
        };

        const initializeThree = async () => {
            if (initializationPromise) return initializationPromise;
            initializationPromise = import(THREE_MODULE_PATH)
                .then((module) => {
                    if (destroyed) return;
                    THREE = module;
                    scene = new THREE.Scene();
                    scene.fog = new THREE.FogExp2(0x050810, 0.055);
                    camera = new THREE.PerspectiveCamera(54, 1, 0.1, 100);
                    camera.position.set(0, 0, 5.8);

                    renderer = new THREE.WebGLRenderer({
                        antialias: true,
                        alpha: true,
                        powerPreference: 'high-performance'
                    });
                    renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
                    renderer.setClearColor(0x000000, 0);
                    renderer.domElement.className = 'diorama-canvas';
                    mode.root.insertBefore(renderer.domElement, fallback);
                    lyricGroup = new THREE.Group();
                    scene.add(lyricGroup);
                    createParticles();
                    initialized = true;
                    fallback.hidden = true;
                    resize();
                    if (lastFrame) rebuildLyrics(lastFrame);
                })
                .catch((error) => {
                    console.warn('[MusicStage:Diorama] Three.js initialization failed; using fallback.', error);
                    fallbackMode = true;
                    initialized = false;
                });
            return initializationPromise;
        };

        const renderFallback = (frame) => {
            if (!fallbackMode && initialized) return;
            const key = getLineKey(frame.activeLine);
            if (key !== renderedKey) {
                renderedKey = key;
                if (frame.activeLine) {
                    fallbackWordElements = renderWords(fallbackLine, frame, 'diorama-word');
                    fallbackTranslation.textContent = frame.activeLine.translation || frame.activeLine.romanization || '';
                } else {
                    fallbackLine.textContent = '等待音乐';
                    fallbackTranslation.textContent = '';
                    fallbackWordElements = [];
                }
            } else {
                updateWords(fallbackWordElements, frame.wordStates);
            }
            fallback.hidden = false;
        };

        const updateThree = (frame) => {
            if (!initialized || !renderer || !scene || !camera || suspended) return;
            const tuning = mode.config.modes?.diorama || {};
            const progress = clamp(Number(frame.lineProgress) || 0);
            const audio = frame.audio || {};
            const intensity = Number(mode.config.animationIntensity) || 1;
            const speed = Number(tuning.cameraSpeed) || 1;
            const reactivity = Number(tuning.audioReactivity) || 1;
            const motion = Number(tuning.motionAmount) || 1;

            if (getLineKey(frame.activeLine) !== renderedKey) rebuildLyrics(frame);

            const now = Number(frame.playbackTime) || 0;
            const targetX = Math.sin(progress * Math.PI * 2) * 0.42 * motion;
            const targetY = Math.sin(progress * Math.PI) * 0.22 * motion;
            camera.position.x += (targetX - camera.position.x) * 0.045 * speed;
            camera.position.y += (targetY - camera.position.y) * 0.045 * speed;
            camera.lookAt(0, 0, -2);

            if (lyricGroup) {
                lyricGroup.rotation.y = Math.sin(now * 0.32) * 0.14 * motion;
                lyricGroup.rotation.x = Math.sin(now * 0.21) * 0.055 * motion;
                lyricGroup.position.z = -2.2 - (audio.lowMid || 0) * 0.35 * intensity;
                lyricGroup.scale.setScalar((Number(tuning.motionAmount) || 1) * (1 + (audio.bass || 0) * 0.08 * reactivity));
            }

            wordMeshes.forEach(({ mesh, state }, index) => {
                const current = frame.wordStates?.[index] || state;
                const progressValue = clamp(Number(current?.progress) || 0);
                const waiting = current?.status === 'waiting';
                const passed = current?.status === 'passed';
                mesh.material.opacity = waiting ? 0.08 : passed ? 0.64 : 0.78 + progressValue * 0.22;
                mesh.position.z = -index * 0.12 + (current?.status === 'active' ? Math.sin(now * 2.5) * 0.04 : 0);
                mesh.scale.setScalar(0.88 + progressValue * 0.16 + (current?.status === 'active' ? (audio.vocal || 0) * 0.12 : 0));
            });

            if (particleField) {
                particleField.visible = tuning.showParticles !== false;
                particleField.rotation.y = now * 0.018 * speed;
                particleField.rotation.x = Math.sin(now * 0.17) * 0.08;
                particleField.material.opacity = 0.28 + (audio.treble || 0) * 0.42 * reactivity;
                particleField.material.size = 0.028 + (audio.power || 0) * 0.035 * reactivity;
            }

            renderer.render(scene, camera);
        };

        const frameLoop = () => {
            if (destroyed) return;
            if (!suspended && lastFrame) updateThree(lastFrame);
            animationFrame = global.requestAnimationFrame(frameLoop);
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed) return;
            lastFrame = frame;
            renderFallback(frame);
            if (!initialized && !fallbackMode) void initializeThree();
            if (initialized && !suspended) updateThree(frame);
        };

        mode.resize = resize;
        mode.suspend = () => {
            suspended = true;
            renderer?.setAnimationLoop?.(null);
            mode.root.classList.add('is-suspended');
        };
        mode.resume = () => {
            suspended = false;
            mode.root.classList.remove('is-suspended');
            if (lastFrame) updateThree(lastFrame);
        };
        mode.updateTheme = () => {
            renderedKey = '';
            if (lastFrame && initialized) rebuildLyrics(lastFrame);
        };

        mode.scope.add(() => {
            destroyed = true;
            global.cancelAnimationFrame(animationFrame);
            resizeObserver?.disconnect();
            resizeObserver = null;
            clearLyrics();
            particleField?.parent?.remove(particleField);
            resources.geometries.forEach((resource) => resource.dispose?.());
            resources.materials.forEach((resource) => resource.dispose?.());
            resources.textures.forEach((resource) => resource.dispose?.());
            resources.geometries.clear();
            resources.materials.clear();
            resources.textures.clear();
            renderer?.dispose?.();
            renderer?.forceContextLoss?.();
            renderer?.domElement?.remove();
            scene = null;
            camera = null;
            renderer = null;
            lyricGroup = null;
            particleField = null;
            fallbackWordElements = [];
        });

        resize();
        animationFrame = global.requestAnimationFrame(frameLoop);
        void initializeThree();
        return mode;
    };

    global.MusicStageDioramaManager = Object.freeze({ create: createManager });
})(window);