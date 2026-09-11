(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    if (!Utils) throw new Error('MusicStageModeUtils must load before fume-manager.js');

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

    const createManager = (container, services) => {
        const mode = makeModeBase('fume', '浮名', container, services);
        const canvas = createElement('canvas', 'fume-canvas');
        const world = createElement('div', 'fume-world');
        const paper = createElement('article', 'fume-paper');
        const meta = createElement('div', 'fume-meta', 'FUME / CONTINUOUS TEXT WORLD');
        const previous = createElement('div', 'fume-context fume-before');
        const hero = createElement('div', 'fume-hero');
        const translation = createElement('div', 'stage-translation fume-translation');
        const following = createElement('div', 'fume-context fume-after');
        paper.append(meta, previous, hero, translation, following);
        world.appendChild(paper);
        mode.root.append(canvas, world);

        const context = canvas.getContext('2d');
        let wordElements = [];
        let renderedKey = '';
        let width = 0;
        let height = 0;
        let shapes = [];
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

        const rebuildShapes = (key) => {
            const random = seededRandom(`fume:${key}`);
            const accent = resolveAccent(services?.app);
            const colors = [
                `${accent.r},${accent.g},${accent.b}`,
                '255,255,255',
                `${Math.min(255, accent.r + 60)},${Math.min(255, accent.g + 40)},${Math.min(255, accent.b + 20)}`
            ];
            shapes = Array.from({ length: 26 }, (_, index) => ({
                kind: ['ring', 'square', 'cross', 'diamond'][index % 4],
                band: ['bass', 'lowMid', 'mid', 'treble'][index % 4],
                x: 0.04 + random() * 0.92,
                y: 0.08 + random() * 0.84,
                size: 0.012 + random() * (index < 8 ? 0.11 : 0.04),
                rotation: random() * Math.PI,
                speed: (random() - 0.5) * 0.00012,
                alpha: 0.035 + random() * 0.14,
                color: colors[index % colors.length]
            }));
        };

        const drawBackground = (frame) => {
            if (!context) return;
            context.clearRect(0, 0, width, height);
            const audio = frame.audio || {};
            const gradient = context.createRadialGradient(
                width * (0.34 + (audio.lowMid || 0) * 0.18),
                height * 0.42,
                0,
                width * 0.5,
                height * 0.5,
                Math.max(width, height) * 0.78
            );
            gradient.addColorStop(0, `rgba(70,120,220,${0.08 + (audio.vocal || 0) * 0.12})`);
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            context.fillStyle = gradient;
            context.fillRect(0, 0, width, height);

            const intensity = Number(mode.config.animationIntensity) || 1;
            shapes.forEach((shape) => {
                const energy = Number(audio[shape.band]) || 0;
                const size = shape.size * Math.min(width, height) * (0.8 + energy * 0.55);
                context.save();
                context.translate(shape.x * width, shape.y * height);
                context.rotate(shape.rotation + frame.now * shape.speed * intensity);
                context.strokeStyle = `rgba(${shape.color},${shape.alpha * (0.55 + energy * 1.8)})`;
                context.lineWidth = 0.7 + energy * 1.4;
                context.shadowColor = `rgba(${shape.color},${0.16 + energy * 0.32})`;
                context.shadowBlur = 4 + energy * 10;
                context.beginPath();
                if (shape.kind === 'ring') context.arc(0, 0, size, 0.2, Math.PI * 1.82);
                else if (shape.kind === 'square') context.rect(-size, -size, size * 2, size * 2);
                else if (shape.kind === 'cross') {
                    context.moveTo(-size, 0);
                    context.lineTo(size, 0);
                    context.moveTo(0, -size);
                    context.lineTo(0, size);
                } else {
                    context.moveTo(0, -size);
                    context.lineTo(size, 0);
                    context.lineTo(0, size);
                    context.lineTo(-size, 0);
                    context.closePath();
                }
                context.stroke();
                context.restore();
            });
        };

        const rebuildArticle = (frame) => {
            const key = getLineKey(frame.activeLine);
            renderedKey = key;
            rebuildShapes(key);
            previous.textContent = frame.previousLine?.fullText || '';
            following.textContent = (frame.nextLines || []).slice(0, 3).map((line) => line.fullText).join('  /  ');
            if (!frame.activeLine) {
                hero.textContent = '等待音乐';
                translation.textContent = '';
                wordElements = [];
            } else {
                wordElements = renderWords(hero, frame, 'fume-word');
                translation.textContent = frame.activeLine.translation || frame.activeLine.romanization || '';
            }
            paper.classList.remove('is-entering');
            void paper.offsetWidth;
            paper.classList.add('is-entering');
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            resize();
            if (getLineKey(frame.activeLine) !== renderedKey) rebuildArticle(frame);
            else updateWords(wordElements, frame.wordStates);

            drawBackground(frame);
            const tuning = mode.config.modes?.fume || {};
            const intensity = Number(mode.config.animationIntensity) || 1;
            const progress = clamp(frame.lineProgress || 0);
            const speed = Number(tuning.cameraSpeed) || 1;
            const cameraProgress = tuning.cameraMode === 'stepped'
                ? Math.round(progress * 8) / 8
                : progress;
            const x = (cameraProgress - 0.5) * -4.8 * speed * intensity;
            const y = Math.sin(cameraProgress * Math.PI) * -2.3 * speed * intensity;
            const scale = 1 + (Number(frame.audio?.bass) || 0) * 0.018 * intensity;
            world.style.transform = `translate3d(${x.toFixed(2)}vw, ${y.toFixed(2)}vh, 0) scale(${scale.toFixed(4)})`;
            mode.root.style.setProperty('--fume-background-opacity', String(Number(tuning.backgroundOpacity) || 0.5));
            mode.root.style.setProperty('--fume-glow-intensity', String(Number(tuning.glow) || 1));
            mode.root.style.setProperty('--fume-hero-scale', String(Number(tuning.heroScale) || 1));
            mode.root.classList.toggle('stage-hide-fume-background', tuning.geometricBackground === false);
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
            shapes = [];
            wordElements = [];
        });

        resize();
        return mode;
    };

    global.MusicStageFumeManager = Object.freeze({ create: createManager });
})(window);