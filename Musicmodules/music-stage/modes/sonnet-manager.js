(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    if (!Utils) throw new Error('MusicStageModeUtils must load before sonnet-manager.js');

    const { clamp, seededRandom, getLineKey, renderWords, updateWords, resolveAccent, makeModeBase, createElement } = Utils;

    const createManager = (container, services) => {
        const mode = makeModeBase('sonnet', '商籁', container, services);
        const frame = createElement('div', 'sonnet-frame');
        const guide = createElement('div', 'sonnet-guide');
        const giant = createElement('div', 'sonnet-giant');
        const scene = createElement('article', 'sonnet-scene');
        const eyebrow = createElement('div', 'sonnet-eyebrow', 'SONNET / EDITORIAL LYRIC SYSTEM');
        const line = createElement('div', 'sonnet-line');
        const translation = createElement('div', 'stage-translation sonnet-translation');
        const shadow = createElement('div', 'sonnet-shadow');
        const hud = createElement('div', 'sonnet-hud');
        scene.append(eyebrow, shadow, line, translation);
        mode.root.append(frame, guide, giant, scene, hud);

        let renderedKey = '';
        let wordElements = [];
        let paused = false;
        let seedRandom = seededRandom('sonnet');
        let width = 0;
        let height = 0;

        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
        };

        const buildScene = (currentFrame) => {
            const key = getLineKey(currentFrame.activeLine);
            renderedKey = key;
            seedRandom = seededRandom(`sonnet:${key}`);
            const accent = resolveAccent(services?.app);
            mode.root.style.setProperty('--sonnet-accent-rgb', `${accent.r}, ${accent.g}, ${accent.b}`);
            mode.root.style.setProperty('--sonnet-angle', `${(seedRandom() * 8 - 4).toFixed(2)}deg`);
            mode.root.style.setProperty('--sonnet-offset-x', `${(seedRandom() * 12 - 6).toFixed(2)}vw`);
            mode.root.style.setProperty('--sonnet-offset-y', `${(seedRandom() * 10 - 5).toFixed(2)}vh`);
            giant.textContent = currentFrame.activeLine?.fullText || 'SONNET';
            shadow.textContent = currentFrame.previousLine?.fullText || '';
            hud.textContent = `FRAME ${String(Math.max(0, currentFrame.currentLineIndex + 1)).padStart(2, '0')}  /  AUDIO ${Math.round((currentFrame.audio?.power || 0) * 100)}%`;

            if (!currentFrame.activeLine) {
                line.textContent = '等待音乐';
                line.classList.add('is-empty');
                translation.textContent = '';
                wordElements = [];
            } else {
                line.classList.remove('is-empty');
                wordElements = renderWords(line, currentFrame, 'sonnet-word');
                translation.textContent = currentFrame.activeLine.translation || currentFrame.activeLine.romanization || '';
            }

            guide.replaceChildren();
            const guideCount = 4 + Math.floor(seedRandom() * 4);
            for (let index = 0; index < guideCount; index += 1) {
                const marker = createElement('i', 'sonnet-guide-mark');
                marker.style.setProperty('--guide-position', `${10 + seedRandom() * 80}%`);
                marker.style.setProperty('--guide-delay', `${index * 90}ms`);
                guide.appendChild(marker);
            }

            scene.classList.remove('is-entering');
            void scene.offsetWidth;
            scene.classList.add('is-entering');
        };

        mode.updateFrame = (currentFrame) => {
            if (mode.destroyed || paused) return;
            resize();
            const key = getLineKey(currentFrame.activeLine);
            if (key !== renderedKey) buildScene(currentFrame);
            else updateWords(wordElements, currentFrame.wordStates);

            const tuning = mode.config.modes?.sonnet || {};
            const intensity = Number(mode.config.animationIntensity) || 1;
            const progress = clamp(currentFrame.lineProgress || 0);
            const power = Number(currentFrame.audio?.power) || 0;
            const camera = (progress - 0.5) * -2.2 * (Number(tuning.cameraIntensity) || 1) * intensity;
            scene.style.transform = `translate3d(${camera.toFixed(2)}vw, ${Math.sin(progress * Math.PI) * -1.1}vh, 0) rotate(var(--sonnet-angle, 0deg)) scale(${(0.98 + power * 0.025).toFixed(4)})`;
            giant.style.transform = `translate3d(${(camera * -0.42).toFixed(2)}vw, 0, 0) rotate(${(seedRandom() * 2 - 1).toFixed(2)}deg)`;
            mode.root.style.setProperty('--sonnet-progress', progress.toFixed(4));
            mode.root.style.setProperty('--sonnet-power', power.toFixed(4));
            mode.root.style.setProperty('--sonnet-typography-motion', String(Number(tuning.typographyMotion) || 1));
            mode.root.classList.toggle('sonnet-hide-guide', tuning.guideLines === false);
            mode.root.classList.toggle('sonnet-hide-background', tuning.showBackground === false);
            mode.root.classList.toggle('sonnet-hide-decor', tuning.showDecor === false);
            mode.root.classList.toggle('sonnet-post-process-off', tuning.postProcess === false);
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
            wordElements = [];
            frame.replaceChildren();
            guide.replaceChildren();
        });

        resize();
        return mode;
    };

    global.MusicStageSonnetManager = Object.freeze({ create: createManager });
})(window);