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
        const canvas = createElement('canvas', 'tempera-canvas');
        const field = createElement('div', 'tempera-field');
        const shot = createElement('article', 'tempera-shot');
        const kicker = createElement('div', 'tempera-kicker', 'TEMPERA / LIVE COMPOSITION');
        const line = createElement('div', 'tempera-line');
        const translation = createElement('div', 'stage-translation tempera-translation');
        const decor = createElement('div', 'tempera-decor');
        shot.append(kicker, line, translation);
        mode.root.append(canvas, field, shot, decor);

        const context = canvas.getContext('2d');
        let wordElements = [];
        let renderedKey = '';
        let palette = createPalette(resolveAccent(services?.app), seededRandom('tempera'));
        let width = 0;
        let height = 0;
        let paused = false;

        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const dpr = Math.min(2, global.devicePixelRatio || 1);
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            context?.setTransform(dpr, 0, 0, dpr, 0, 0);
        };

        const renderDecor = (frame) => {
            if (!context) return;
            context.clearRect(0, 0, width, height);
            const audio = frame.audio || {};
            const intensity = Number(mode.config.animationIntensity) || 1;
            const breathing = Number(mode.config.modes?.tempera?.cameraIntensity) || 1;
            const pulse = (0.8 + (audio.bass || 0) * 0.25 * intensity * breathing);
            const gradient = context.createRadialGradient(
                width * (0.48 + (audio.lowMid || 0) * 0.08),
                height * 0.42,
                0,
                width * 0.5,
                height * 0.5,
                Math.max(width, height) * 0.78
            );
            gradient.addColorStop(0, palette.primary);
            gradient.addColorStop(0.52, palette.secondary);
            gradient.addColorStop(1, palette.paper);
            context.fillStyle = gradient;
            context.fillRect(0, 0, width, height);

            context.save();
            context.globalAlpha = 0.2 + (audio.treble || 0) * 0.22;
            context.strokeStyle = palette.accent;
            context.lineWidth = 1;
            const spacing = Math.max(14, Math.min(30, width / 58));
            for (let x = -height; x < width + height; x += spacing) {
                context.beginPath();
                context.moveTo(x, 0);
                context.lineTo(x + height, height);
                context.stroke();
            }
            context.restore();

            mode.root.style.setProperty('--tempera-pulse', pulse.toFixed(3));
            mode.root.style.setProperty('--tempera-accent', palette.accent);
        };

        const renderLine = (frame) => {
            const key = getLineKey(frame.activeLine);
            if (key === renderedKey) {
                if (frame.activeLine) updateWords(wordElements, frame.wordStates);
                return;
            }

            renderedKey = key;
            const random = seededRandom(`tempera:${key}`);
            palette = createPalette(resolveAccent(services?.app), random);
            mode.root.style.setProperty('--tempera-angle', `${Math.round(random() * 24 - 12)}deg`);
            mode.root.style.setProperty('--tempera-offset-x', `${Math.round(random() * 22 - 11)}vw`);
            mode.root.style.setProperty('--tempera-offset-y', `${Math.round(random() * 18 - 9)}vh`);
            decor.replaceChildren();

            Array.from({ length: 7 }, (_, index) => {
                const mark = createElement('i', 'tempera-mark');
                mark.style.left = `${8 + random() * 84}%`;
                mark.style.top = `${10 + random() * 76}%`;
                mark.style.width = `${30 + random() * 180}px`;
                mark.style.transform = `rotate(${random() * 160 - 80}deg)`;
                mark.style.animationDelay = `${index * 80}ms`;
                decor.appendChild(mark);
            });

            if (!frame.activeLine) {
                line.textContent = '等待音乐';
                line.classList.add('is-empty');
                translation.textContent = '';
                wordElements = [];
            } else {
                line.classList.remove('is-empty');
                wordElements = renderWords(line, frame, 'tempera-word');
                translation.textContent = frame.activeLine.translation || frame.activeLine.romanization || '';
            }

            shot.classList.remove('is-entering');
            void shot.offsetWidth;
            shot.classList.add('is-entering');
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            resize();
            renderLine(frame);
            renderDecor(frame);

            const tuning = mode.config.modes?.tempera || {};
            const progress = clamp(frame.lineProgress || 0);
            const scale = 0.97 + (frame.audio?.bass || 0) * 0.028 * (Number(tuning.cameraIntensity) || 1);
            shot.style.transform = `translate3d(calc(-50% + ${((progress - 0.5) * -2.8).toFixed(2)}vw), calc(-50% + ${Math.sin(progress * Math.PI) * -1.8}vh), 0) rotate(var(--tempera-angle, 0deg)) scale(${scale.toFixed(4)})`;
            mode.root.classList.toggle('tempera-no-blocks', tuning.showBlocks === false);
            mode.root.classList.toggle('tempera-no-decor', tuning.showDecor === false);
            mode.root.classList.toggle('tempera-no-inversion', tuning.textInversion === false);
            mode.root.style.setProperty('--tempera-progress', progress.toFixed(4));
            mode.root.style.setProperty('--stage-vocal', Number(frame.audio?.vocal || 0).toFixed(4));
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
            context?.clearRect(0, 0, width, height);
            canvas.width = 1;
            canvas.height = 1;
            wordElements = [];
        });

        resize();
        return mode;
    };

    global.MusicStageTemperaManager = Object.freeze({ create: createManager });
})(window);