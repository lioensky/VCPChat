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

        // 实例化 Pixi.js 商籁高级图形导演
        const director = global.SonnetPixiDirector ? new global.SonnetPixiDirector(stageContainer) : null;
        if (director) {
            director.init().catch(err => console.error('[SonnetPixiDirector] init error:', err));
        }

        const resize = () => {
            director?.resize();
        };

        const buildScene = (currentFrame) => {
            const key = getLineKey(currentFrame.activeLine);
            renderedKey = key;
            const accent = resolveAccent(services?.app);
            translation.textContent = currentFrame.activeLine?.translation || currentFrame.activeLine?.romanization || '';
            director?.buildShot(currentFrame.activeLine, key, accent);
        };

        mode.updateFrame = (currentFrame) => {
            if (mode.destroyed || paused) return;
            resize();
            const key = getLineKey(currentFrame.activeLine);
            if (key !== renderedKey) buildScene(currentFrame);

            const tuning = mode.config.modes?.sonnet || {};
            director?.update(currentFrame, tuning);

            const power = Number(currentFrame.audio?.power) || 0;
            hud.textContent = `FRAME ${String(Math.max(0, currentFrame.currentLineIndex + 1)).padStart(2, '0')}  /  AUDIO ${Math.round(power * 100)}%`;
        };

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