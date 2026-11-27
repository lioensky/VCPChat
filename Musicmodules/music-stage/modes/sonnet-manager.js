(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    if (!Utils) throw new Error('MusicStageModeUtils must load before sonnet-manager.js');

    const { clamp, seededRandom, getLineKey, renderWords, updateWords, resolveAccent, makeModeBase, createElement } = Utils;
    const { resolveSupplementalText } = global.MusicStageRuntime;

    const createManager = (container, services) => {
        const mode = makeModeBase('sonnet', '商籁', container, services);
        const stageContainer = createElement('div', 'sonnet-stage-container');
        stageContainer.style.position = 'absolute';
        stageContainer.style.inset = '0';
        stageContainer.style.overflow = 'hidden';
        mode.root.append(stageContainer);

        const eyebrow = createElement('div', 'sonnet-eyebrow', '商籁');
        const translation = createElement('div', 'stage-translation sonnet-translation');
        const hud = createElement('div', 'sonnet-hud');
        mode.root.append(eyebrow, translation, hud);

        let renderedKey = '';
        let paused = false;
        const still = Utils.createStillGate();

        let latestFrame = null;
        let lastPalRef = undefined, lastPalJson = 'null';
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const getTuning = () => ({
            ...mode.config.modes?.sonnet,
            palette: services?.app?.stagePalette,
            animationIntensity: mode.config.animationIntensity ?? 1,
            quality: mode.config.quality,
            reducedMotion: global.MusicStageRuntime.isReducedMotion(reducedMotion)
        });

        // 实例化 Pixi.js 商籁高级图形导演
        const director = global.SonnetPixiDirector ? new global.SonnetPixiDirector(stageContainer, {
            canvasAntialias: !global.MusicStagePixiEffects.lensOn(mode.config, 'sonnet')
        }) : null;
        if (director) {
            director.init().then(() => {
                if (!mode.destroyed && latestFrame) mode.updateFrame(latestFrame);
            }).catch(err => {
                console.error('[SonnetPixiDirector] init error:', err);
                if (!mode.destroyed) translation.textContent = '图形引擎初始化失败，请切换其他舞台模式';
                director.destroy();
            });
        }

        const resize = () => {
            director?.resize();
        };

        const buildScene = (currentFrame) => {
            const key = getLineKey(currentFrame.activeLine);
            renderedKey = key;
            const accent = resolveAccent(services?.app);
            translation.textContent = resolveSupplementalText(currentFrame.activeLine);
            const trackKey = currentFrame.track?.path || currentFrame.track?.title || '';
            director?.buildShot(currentFrame.activeLine, `${trackKey}:${key}`, accent, getTuning());
        };

        mode.updateFrame = (currentFrame) => {
            if (mode.destroyed || paused) return;
            const changed = latestFrame?.lines !== currentFrame.lines || latestFrame?.track !== currentFrame.track;
            latestFrame = currentFrame;
            resize();
            const key = getLineKey(currentFrame.activeLine);
            if (key !== renderedKey || changed) buildScene(currentFrame);

            const tuning = getTuning();
            const caption = Utils.lineCounter(currentFrame);
            if (hud.textContent !== caption) hud.textContent = caption;
            // Paused and nothing changed: the canvas already shows this frame.
            if (!currentFrame.isPlaying) {
                const pal = tuning.palette ?? null;
                if (pal !== lastPalRef) { lastPalRef = pal; lastPalJson = JSON.stringify(pal); }
                if (still.same(currentFrame, `${Boolean(director?.initialized)}|${director?.width}x${director?.height}|${lastPalJson}|${tuning.reducedMotion}`)) return;
            } else still.invalidate();
            director?.update(currentFrame, tuning);
        };

        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => {
            const before = mode.config.modes?.sonnet || {};
            const after = config.modes?.sonnet || {};
            const rebuild = ['fontScale', 'shotFlow', 'lyricLayout', 'phraseLength'].some(key => before[key] !== after[key]);
            updateConfig(config);
            if (rebuild) renderedKey = '';
            still.invalidate();
            if (latestFrame) mode.updateFrame(latestFrame);
        };
        mode.getDebugSnapshot = () => director?.getDebugSnapshot() || { initialized: false };
        mode.resize = resize;
        mode.suspend = () => {
            paused = true;
            mode.root.classList.add('is-suspended');
        };
        mode.resume = () => {
            paused = false;
            still.invalidate();
            mode.root.classList.remove('is-suspended');
        };
        mode.updateTheme = () => {
            renderedKey = '';
            still.invalidate();
        };
        mode.scope.add(() => {
            director?.destroy();
        });

        resize();
        return mode;
    };

    global.MusicStageSonnetManager = Object.freeze({ create: createManager });
})(window);