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
        const onset = R.createAudioOnset();
        const audio = { energy: 0, impact: 0, vocal: 0, spectrum: new Float32Array(24) };
        const palette = () => services?.app?.stagePalette || {};
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
        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            if (!renderer) return;
            const quality = mode.config.quality;
            const cap = quality === 'energy-saving' ? 1 : quality === 'ultimate' ? 2 : 1.5;
            renderer.setPixelRatio(Math.min(cap, global.devicePixelRatio || 1));
            renderer.setSize(width, height, false);
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
        };
        const update = frame => {
            if (mode.destroyed || mode.suspended) return;
            latest = frame;
            if (!initialized) {
                renderFallback(frame);
                if (!fallbackMode) void initialize();
                return;
            }
            const nextIdentity = frame.track?.path || frame.track?.title || 'last-train';
            const nextDuration = R.finiteNumber(frame.duration, R.finiteNumber(frame.track?.duration));
            const settings = options();
            const nextOptions = JSON.stringify([
                settings.cameraSpeed, settings.motionAmount, settings.animationIntensity,
                settings.reducedMotion, settings.cameraCuts, settings.aspect,
                settings.lyricCarrier, settings.showTranslation, settings.fireworks,
                settings.narrativeStations, settings.stationIntensity
            ]);
            const nextPalette = JSON.stringify(palette());
            let recompile = false;
            if (!timeline || source !== frame.lines || identity !== nextIdentity || compiledDuration !== nextDuration) {
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
            if (recompile || nextOptions !== optionsKey) {
                track = global.MusicStageDioramaCamera.createTrack(timeline, settings.cameraSpeed ?? 1, settings);
                lyrics.reset(timeline, track, settings, palette());
                events.reset(timeline, track, settings);
                optionsKey = nextOptions;
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
            world.update(timeline, track, pose, settings.reducedMotion ? 0 : time, mode.config, audio);
            lyrics.update(time, settings, audio, camera);
            events.update(time, settings, mode.config.quality, palette(), audio);
            const bars = settings.letterbox !== false && settings.geometryMode !== 'corridor'
                ? Math.max(0, (height - width / 2.39) / 2) * (1 - pose.state.openness * 0.75) : 0;
            letterbox.style.setProperty('--diorama-bar', `${bars}px`);
            fallback.hidden = true;
            renderer.info.reset();
            world.renderReflection(renderer, camera);
            if (optics) optics.render(renderer, scene, camera, settings.reducedMotion ? 0 : time, mode.config);
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
                renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
                renderer.outputColorSpace = T.SRGBColorSpace;
                renderer.toneMapping = T.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.15;
                renderer.info.autoReset = false;
                renderer.domElement.className = 'diorama-canvas';
                mode.root.insertBefore(renderer.domElement, fallback);
                mode.scope.listen(renderer.domElement, 'webglcontextlost', event => {
                    event.preventDefault();
                    fallbackMode = true;
                    disposeGraphics();
                    if (latest) renderFallback(latest);
                });
                world = global.MusicStageDioramaWorld.create(T, scene);
                lyrics = global.MusicStageDioramaLyrics.create(T, scene);
                events = global.MusicStageDioramaEvents.create(T, scene);
                optics = global.MusicStageDioramaOptics?.create(T);
                initialized = true;
                resize();
                if (latest) update(latest);
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
        mode.updateFrame = update;
        mode.resize = () => { resize(); if (latest && initialized) update(latest); };
        const baseConfig = mode.updateConfig;
        mode.updateConfig = config => {
            baseConfig(config);
            resize();
            if (latest) update(latest);
        };
        mode.updateTheme = () => { if (latest) update(latest); };
        const resume = mode.resume;
        mode.resume = () => { resume(); if (latest) update(latest); };
        mode.getDebugSnapshot = () => ({
            initialized, fallbackMode, ...world?.snapshot(), ...lyrics?.snapshot(), ...events?.snapshot(camera),
            camera: camera?.position.toArray(), quaternion: camera?.quaternion.toArray(),
            act: pose?.state.act, rig: pose?.rig, distance: pose?.distance,
            acts: timeline?.acts.map(a => ({ kind: a.kind, start: a.start, end: a.end })),
            cutsCount: timeline?.cuts.length || 0, rhythmSource: timeline?.rhythmSource,
            drawCalls: renderer?.info.render.calls, geometries: renderer?.info.memory.geometries,
            textures: renderer?.info.memory.textures,
            signSpectrum: Array.from(audio.spectrum)
        });
        mode.scope.add(() => { disposeGraphics(); latest = source = timeline = track = null; });
        resize();
        void initialize();
        return mode;
    };
    global.MusicStageDioramaManager = Object.freeze({ create });
})(window);