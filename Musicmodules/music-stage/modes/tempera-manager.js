(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    if (!Utils) throw new Error('MusicStageModeUtils must load before tempera-manager.js');

    const { clamp, seededRandom, splitGraphemes, getLineKey, renderWords, updateWords, resolveAccent, makeModeBase, createElement } = Utils;

    const createPalette = (accent, random) => {
        const hue = Math.round((Math.atan2(accent.g - 128, accent.r - 128) * 180 / Math.PI + 360) % 360);
        return {
            primary: `hsl(${hue} 72% ${24 + Math.round(random() * 13)}%)`,
            secondary: `hsl(${(hue + 38) % 360} 64% ${18 + Math.round(random() * 12)}%)`,
            accent: `rgb(${accent.r}, ${accent.g}, ${accent.b})`,
            paper: `hsl(${(hue + 12) % 360} 26% ${8 + Math.round(random() * 7)}%)`
        };
    };

    const createManager = (container, services) => {
        const mode = makeModeBase('tempera', '凝彩', container, services);
        const stageContainer = createElement('div', 'tempera-stage-container');
        stageContainer.style.position = 'absolute';
        stageContainer.style.inset = '0';
        stageContainer.style.overflow = 'hidden';
        mode.root.append(stageContainer);

        const kicker = createElement('div', 'tempera-kicker', 'TEMPERA / PIXI MG DIRECTOR');
        const translation = createElement('div', 'stage-translation tempera-translation');
        mode.root.append(kicker, translation);

        let renderedKey = '';
        let paused = false;

        let latestFrame = null;
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const getTuning = () => ({
            ...mode.config.modes?.tempera,
            palette: services?.app?.stagePalette,
            animationIntensity: mode.config.animationIntensity ?? 1,
            quality: mode.config.quality,
            reducedMotion: Boolean(reducedMotion?.matches)
        });

        // 实例化 Pixi.js 凝彩高级导演
        const director = global.TemperaPixiDirector ? new global.TemperaPixiDirector(stageContainer) : null;
        if (director) {
            director.init().then(() => {
                if (!mode.destroyed && latestFrame) mode.updateFrame(latestFrame);
            }).catch(err => {
                console.error('[TemperaPixiDirector] init error:', err);
                if (!mode.destroyed) translation.textContent = '图形引擎初始化失败，请切换其他舞台模式';
                director.destroy();
            });
        }

        const resize = () => {
            director?.resize();
        };

        const renderLine = (frame) => {
            const key = getLineKey(frame.activeLine);
            if (key === renderedKey) return;
            renderedKey = key;

            translation.textContent = frame.activeLine?.translation || frame.activeLine?.romanization || '';
            const accent = resolveAccent(services?.app);
            const tuning = getTuning();
            const trackKey = frame.track?.path || frame.track?.title || '';
            director?.buildShot(frame.activeLine, `${trackKey}:${key}`, accent, tuning);
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            if (latestFrame?.lines !== frame.lines || latestFrame?.track !== frame.track) renderedKey = '';
            latestFrame = frame;
            resize();
            renderLine(frame);
            const tuning = getTuning();
            director?.update(frame, tuning);
            mode.root.style.setProperty('--stage-vocal', Number(frame.audio?.vocal || 0).toFixed(4));
        };

        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => {
            const before = mode.config.modes?.tempera || {};
            const after = config.modes?.tempera || {};
            const rebuild = ['fontScale', 'shotFlow', 'colorMode', 'lyricLayout', 'phraseLength'].some(key => before[key] !== after[key]);
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

    global.MusicStageTemperaManager = Object.freeze({ create: createManager });
})(window);