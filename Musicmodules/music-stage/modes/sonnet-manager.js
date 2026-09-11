(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    if (!Utils) throw new Error('MusicStageModeUtils must load before sonnet-manager.js');

    const { clamp, seededRandom, getLineKey, renderWords, updateWords, resolveAccent, makeModeBase, createElement } = Utils;

    const createManager = (container, services) => {
        const mode = makeModeBase('sonnet', '商籁', container, services);
        const stageContainer = createElement('div', 'sonnet-stage-container');
        stageContainer.style.position = 'absolute';
        stageContainer.style.inset = '0';
        stageContainer.style.overflow = 'hidden';
        mode.root.append(stageContainer);

        const eyebrow = createElement('div', 'sonnet-eyebrow', 'SONNET / PIXI MOTION GRAPHICS');
        const translation = createElement('div', 'stage-translation sonnet-translation');
        const hud = createElement('div', 'sonnet-hud');
        mode.root.append(eyebrow, translation, hud);

        let renderedKey = '';
        let paused = false;

        let latestFrame = null;
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const getTuning = () => ({
            ...mode.config.modes?.sonnet,
            palette: services?.app?.stagePalette,
            animationIntensity: mode.config.animationIntensity ?? 1,
            quality: mode.config.quality,
            reducedMotion: Boolean(reducedMotion?.matches)
        });

        // 实例化 Pixi.js 商籁高级图形导演
        const director = global.SonnetPixiDirector ? new global.SonnetPixiDirector(stageContainer) : null;
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
            translation.textContent = currentFrame.activeLine?.translation || currentFrame.activeLine?.romanization || '';
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
            director?.update(currentFrame, tuning);

            const power = Number(currentFrame.audio?.power) || 0;
            hud.textContent = `FRAME ${String(Math.max(0, currentFrame.currentLineIndex + 1)).padStart(2, '0')}  /  AUDIO ${Math.round(power * 100)}%`;
        };

        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => {
            const before = mode.config.modes?.sonnet || {};
            const after = config.modes?.sonnet || {};
            const rebuild = ['fontScale', 'shotFlow', 'lyricLayout', 'phraseLength'].some(key => before[key] !== after[key]);
            updateConfig(config);
            if (rebuild) renderedKey = '';
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
            mode.root.classList.remove('is-suspended');
        };
        mode.updateTheme = () => {
            renderedKey = '';
        };
        mode.scope.add(() => {
            director?.destroy();
        });

        resize();
        return mode;
    };

    global.MusicStageSonnetManager = Object.freeze({ create: createManager });
})(window);