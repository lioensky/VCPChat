(function (global) {
    'use strict';
    const U = global.MusicStageModeUtils;
    const R = global.MusicStageRuntime;
    const create = (container, services) => {
        const mode = U.makeModeBase('diorama', '镜台', container, services);
        const fallback = U.createElement('div', 'diorama-fallback');
        const fallbackLine = U.createElement('div', 'diorama-fallback-line');
        const translation = U.createElement('div', 'stage-translation diorama-fallback-translation');
        fallback.append(fallbackLine, translation);
        const letterbox = U.createElement('div', 'diorama-letterbox');
        letterbox.setAttribute('aria-hidden', 'true');
        mode.root.append(fallback, letterbox);
        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let T, scene, camera, renderer, world, lyrics, optics, events;
        let initialized = false, fallbackMode = false, initializing = null;
        let latest = null, source = null, identity = null, timeline = null, track = null;
        let compiledDuration = null, optionsKey = '', paletteKey = '', pose = null;
        let width = 1, height = 1, lastTime = null;
        let pendingOptions = null, pendingSince = 0, settleTimer = 0, builtSettings = {}, rebuilds = 0;
        let contextRetries = 0, contextTimer = 0, lastContextLoss = 0;
        // Something other than the clock changed since the last drawn frame.
        let dirty = true, canvasSmoothing = null;
        const cap = U.createFrameCap();
        const Optics = () => global.MusicStageDioramaOptics;
        const wantsCanvasSmoothing = () => !(Optics()?.active(mode.config) ?? false);
        const onset = R.createAudioOnset();
        const audio = { energy: 0, impact: 0, vocal: 0, spectrum: new Float32Array(24) };
        const palette = () => services?.app?.stagePalette || {};
        const dayLens = {};
        const options = () => ({
            ...(mode.config.modes?.diorama || {}),
            animationIntensity: mode.config.animationIntensity ?? 1,
            reducedMotion: Boolean(reduced?.matches), aspect: width / height, quality: mode.config.quality
        });
        const renderFallback = frame => {
            fallback.hidden = false;
            const key = U.getLineKey(frame.activeLine);
            if (fallbackLine.dataset.key !== key) {
                fallbackLine.dataset.key = key;
                if (frame.activeLine) U.renderWords(fallbackLine, frame, 'diorama-word');
                else fallbackLine.textContent = frame.track?.title || '等待音乐';
                translation.textContent = R.resolveSupplementalText(frame.activeLine);
            }
            U.updateWords(Array.from(fallbackLine.children), frame.wordStates || []);
        };
        const renderScale = U.createRenderScale();
        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            if (!renderer) return;
            renderer.setPixelRatio(renderScale.ratio(mode.config.quality, width, height));
            renderer.setSize(width, height, false);
            world?.setPixelRatio?.(renderer.getPixelRatio());
            events?.setViewport?.(height * renderer.getPixelRatio());
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        };
        const disposeGraphics = () => {
            lyrics?.destroy();
            world?.destroy();
            optics?.destroy();
            events?.destroy();
            lyrics = world = optics = events = null;
            renderer?.dispose();
            renderer?.forceContextLoss();
            renderer?.domElement.remove();
            renderer = camera = scene = null;
            initialized = false;
            dirty = true;
            // A rebuilt stage starts with empty layers: compile the journey into them again.
            timeline = null;
            paletteKey = '';
        };
        // A lost context (driver reset, sleep, remote desktop) is usually
        // temporary. Show the text fallback, then rebuild on a fresh canvas a
        // few times before settling for the fallback.
        const recoverContext = () => {
            const now = Date.now();
            if (now - lastContextLoss > 60000) contextRetries = 0;
            lastContextLoss = now;
            console.warn(`[MusicStage:Diorama] WebGL context lost (retry ${contextRetries} of 3)`);
            fallbackMode = true;
            disposeGraphics();
            if (latest) renderFallback(latest);
            if (mode.destroyed || contextRetries >= 3) return;
            global.clearTimeout(contextTimer);
            contextTimer = global.setTimeout(() => {
                contextTimer = 0;
                if (mode.destroyed || initialized) return;
                fallbackMode = false;
                initializing = null;
                void initialize();
            }, 800 * 2 ** contextRetries++);
        };
        // Settings that force the journey, lyric layout and events to be rebuilt.
        const REBUILD_KEYS = ['cameraSpeed', 'motionAmount', 'animationIntensity', 'reducedMotion',
            'cameraCuts', 'aspect', 'lyricCarrier', 'showTranslation', 'fireworks',
            'narrativeStations', 'stationIntensity'];
        const update = (frame, force = false) => {
            if (mode.destroyed || mode.suspended) return;
            latest = frame;
            if (!initialized) {
                renderFallback(frame);
                if (!fallbackMode) void initialize();
                return;
            }
            // Paused with nothing changed: the last picture is still right, so
            // the GPU can rest. Playing: no more often than the tier's rate.
            const still = !frame.isPlaying && lastTime !== null
                && R.finiteNumber(frame.playbackTime) === lastTime;
            if (!force && !dirty && (still || !cap.take(performance.now(), mode.config.quality))) return;
            dirty = false;
            const nextIdentity = frame.track?.path || frame.track?.title || 'last-train';
            const nextDuration = R.finiteNumber(frame.duration, R.finiteNumber(frame.track?.duration));
            const settings = options();
            const nextOptions = JSON.stringify(REBUILD_KEYS.map(key => settings[key]));
            const nextPalette = JSON.stringify(palette());
            let recompile = false;
            if (!timeline || source !== frame.lines || identity !== nextIdentity || U.durationChanged(compiledDuration, nextDuration)) {
                source = frame.lines;
                identity = nextIdentity;
                compiledDuration = nextDuration;
                timeline = global.MusicStageDioramaDirector.compile({
                    lines: frame.lines || [], trackId: identity, duration: nextDuration,
                    beatTimes: frame.track?.beatTimes
                });
                recompile = true;
                onset.reset();
                lastTime = null;
            }
            if (nextPalette !== paletteKey) {
                world.setPalette(palette());
                paletteKey = nextPalette;
                recompile = true;
            }
            // A slider drag or a window resize changes these many times a second.
            // Rebuild once the value has settled; until then keep performing with
            // the values the current journey was built for.
            let hold = false;
            if (!recompile && nextOptions !== optionsKey) {
                const now = performance.now();
                if (pendingOptions !== nextOptions) { pendingOptions = nextOptions; pendingSince = now; }
                hold = now - pendingSince < 180;
                if (hold) {
                    for (const key of REBUILD_KEYS) settings[key] = builtSettings[key];
                    // Paused stages still get frames, but do not rely on it.
                    global.clearTimeout(settleTimer);
                    settleTimer = global.setTimeout(() => { if (latest && !mode.destroyed) update(latest, true); }, 200);
                }
            }
            if (recompile || nextOptions !== optionsKey && !hold) {
                track = global.MusicStageDioramaCamera.createTrack(timeline, settings.cameraSpeed ?? 1, settings);
                lyrics.reset(timeline, track, settings, palette());
                events.reset(timeline, track, settings);
                optionsKey = nextOptions;
                pendingOptions = null;
                builtSettings = settings;
                rebuilds++;
            }
            const time = R.finiteNumber(frame.playbackTime);
            const dt = lastTime === null ? 0 : time - lastTime;
            const seek = lastTime === null || dt < 0 || dt > 0.5;
            // Freeze all live modulation, not just the camera, on repeated or paused frames.
            if (seek || frame.isPlaying && dt > 0) {
                const live = onset.update(frame);
                const gain = R.clamp(settings.audioReactivity ?? 1, 0, 2);
                audio.energy = live.energy * gain;
                audio.impact = live.impact * gain;
                const target = R.clamp(frame.audio?.vocal) * gain;
                audio.vocal = seek ? target : audio.vocal
                    + (target - audio.vocal) * (1 - Math.exp(-dt * (target > audio.vocal ? 16 : 5)));
                const spectrum = frame.audio?.spectrum || [];
                for (let i = 0; i < audio.spectrum.length; i++) {
                    const count = audio.spectrum.length;
                    const from = Math.floor((Math.pow(1 + spectrum.length, i / count) - 1));
                    const to = Math.min(spectrum.length, Math.max(from + 1,
                        Math.ceil(Math.pow(1 + spectrum.length, (i + 1) / count) - 1)));
                    let peak = 0, sum = 0;
                    for (let bin = from; bin < to; bin++) {
                        const amplitude = R.clamp(spectrum[bin] || 0);
                        peak = Math.max(peak, amplitude);
                        sum += amplitude * amplitude;
                    }
                    const level = 0.6 * peak + 0.4 * Math.sqrt(sum / Math.max(1, to - from));
                    const value = R.clamp(Math.pow(Math.max(0, level - 0.008), 0.6) * 1.65 * gain);
                    const rate = value > audio.spectrum[i] ? 24 : 6;
                    audio.spectrum[i] = seek ? value : audio.spectrum[i]
                        + (value - audio.spectrum[i]) * (1 - Math.exp(-dt * rate));
                }
            } else onset.update(frame);
            pose = global.MusicStageDioramaCamera.pose(timeline, track, time, settings);
            camera.position.set(pose.position.x, pose.position.y, pose.position.z);
            camera.up.set(0, 1, 0);
            camera.lookAt(pose.look.x, pose.look.y, pose.look.z);
            camera.rotateZ(pose.roll);
            if (camera.fov !== pose.fov) {
                camera.fov = pose.fov;
                camera.updateProjectionMatrix();
            }
            // Cabin window foreground: derived from gaze vs. track heading, never from history.
            world.updateCabin?.(camera, pose, track, width / height, mode.config);
            world.update(timeline, track, pose, settings.reducedMotion ? 0 : time, mode.config, audio);
            // Exposure: analytic chapter swell + low-frequency breathing (frozen on pause).
            const moving = !settings.reducedMotion && (settings.motionAmount ?? 1) > 0
                && (settings.animationIntensity ?? 1) > 0;
            const swell = moving ? (timeline.accentAt?.(time) ?? 0) : 0;
            const breath = moving ? R.clamp(audio.energy) * 0.05 : 0;
            // The saloon is lit from its own ceiling and sits a little lower.
            renderer.toneMappingExposure = 1.15 * (1 + swell * 0.12 + breath) * (1 - 0.2 * (pose.cabinView || 0));
            const bars = settings.letterbox !== false && settings.geometryMode !== 'corridor'
                ? Math.max(0, (height - width / 2.39) / 2) * (1 - pose.state.openness * 0.75) : 0;
            // Lyrics stay clear of the frame edge and of the letterbox bars.
            lyrics.update(time, settings, audio, camera, { x: 0.94, y: Math.max(0.5, 0.95 - 2 * bars / height) });
            events.update(time, settings, mode.config.quality, palette(), audio);
            letterbox.style.setProperty('--diorama-bar', `${bars}px`);
            fallback.hidden = true;
            if (frame.isPlaying && renderScale.tick(performance.now(), cap.aim(mode.config.quality))) resize();
            renderer.info.reset();
            world.renderReflection(renderer, camera);
            // By day the paper-white sky is brighter than the lens's usual
            // threshold, and its veil would wash thin dark lyric strokes pale.
            // Only what is brighter than the paper may bloom.
            // Inside the saloon the lens is told so: the strips carry the light there.
            const tuned = mode.config.modes?.diorama || {};
            const lens = Object.assign(dayLens, tuned, {
                threshold: palette().light ? 1.4 : tuned.threshold ?? 0.82, cabin: pose.cabinView || 0 });
            if (optics) optics.render(renderer, scene, camera, settings.reducedMotion ? 0 : time, mode.config, lens);
            else renderer.render(scene, camera);
            lastTime = time;
        };
        const initialize = () => {
            if (initializing) return initializing;
            initializing = Promise.resolve().then(async () => {
                if (!global.MusicStageDioramaDirector || !global.MusicStageDioramaCamera
                    || !global.MusicStageDioramaWorld || !global.MusicStageDioramaLyrics
                    || !global.MusicStageDioramaEvents) {
                    throw new Error('Diorama performance modules are unavailable');
                }
                T = global.THREE || await import('../../../vendor/three.module.js');
                if (mode.destroyed) return;
                scene = new T.Scene();
                camera = new T.PerspectiveCamera(48, 1, 0.1, 1800);
                // Layer 1 = cabin foreground: seen by the viewer, excluded from the mirror pass.
                camera.layers.enable(1);
                canvasSmoothing = wantsCanvasSmoothing();
                renderer = new T.WebGLRenderer({ antialias: canvasSmoothing, alpha: false, powerPreference: 'high-performance' });
                // Checking every program's log reads back from the GPU process and stalls.
                renderer.debug.checkShaderErrors = false;
                renderer.outputColorSpace = T.SRGBColorSpace;
                renderer.toneMapping = T.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.15;
                renderer.info.autoReset = false;
                renderer.domElement.className = 'diorama-canvas';
                mode.root.insertBefore(renderer.domElement, fallback);
                const canvas = renderer.domElement;
                mode.scope.listen(canvas, 'webglcontextlost', event => {
                    event.preventDefault();
                    // Disposing the renderer loses its context on purpose.
                    if (renderer?.domElement !== canvas) return;
                    recoverContext();
                });
                world = global.MusicStageDioramaWorld.create(T, scene);
                lyrics = global.MusicStageDioramaLyrics.create(T, scene);
                events = global.MusicStageDioramaEvents.create(T, scene);
                optics = global.MusicStageDioramaOptics?.create(T);
                resize();
                // The environment map has to be in place before the warm-up, or every
                // standard material recompiles the first time it appears.
                world.prepareEnvironment?.(renderer);
                // The lens draws the scene offscreen; without it only the water pass does.
                await U.precompile(T, renderer, scene, camera, { canvas: canvasSmoothing, offscreen: true });
                if (mode.destroyed || !renderer) return;
                initialized = true;
                dirty = true;
                if (latest) update(latest, true);
            }).catch(error => {
                disposeGraphics();
                fallbackMode = true;
                if (!mode.destroyed) {
                    console.warn('[MusicStage:Diorama] 使用文字降级：', error);
                    if (latest) renderFallback(latest);
                }
            });
            return initializing;
        };
        mode.updateFrame = frame => update(frame);
        mode.resize = () => { resize(); if (latest && initialized) update(latest, true); };
        const baseConfig = mode.updateConfig;
        mode.updateConfig = config => {
            baseConfig(config);
            // The canvas is antialiased only when the lens is off; that is fixed
            // when the context is made, so a change of tier rebuilds it.
            if (initialized && canvasSmoothing !== wantsCanvasSmoothing()) {
                disposeGraphics();
                initializing = null;
                void initialize();
                return;
            }
            resize();
            if (latest) update(latest, true);
        };
        mode.updateTheme = () => { if (latest) update(latest, true); };
        const resume = mode.resume;
        mode.resume = () => { resume(); cap.reset(); if (latest) update(latest, true); };
        // The layers hold nothing to describe until shaders are warm and the first frame has run.
        mode.getDebugSnapshot = () => ({
            initialized, fallbackMode, rebuilds,
            ...(initialized ? { ...world?.snapshot(), ...lyrics?.snapshot(), ...events?.snapshot(camera) } : null),
            camera: camera?.position.toArray(), quaternion: camera?.quaternion.toArray(),
            act: pose?.state.act, rig: pose?.rig, distance: pose?.distance,
            acts: timeline?.acts.map(a => ({ kind: a.kind, start: a.start, end: a.end })),
            cutsCount: timeline?.cuts.length || 0, rhythmSource: timeline?.rhythmSource,
            pixelRatio: renderer?.getPixelRatio(), renderScale: renderScale.factor,
            drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles,
            geometries: renderer?.info.memory.geometries, textures: renderer?.info.memory.textures,
            programs: renderer?.info.programs?.length, canvasSmoothing,
            signSpectrum: Array.from(audio.spectrum)
        });
        mode.scope.add(() => {
            global.clearTimeout(settleTimer);
            global.clearTimeout(contextTimer);
            disposeGraphics();
            latest = source = timeline = track = null;
        });
        resize();
        void initialize();
        return mode;
    };
    global.MusicStageDioramaManager = Object.freeze({ create });
})(window);