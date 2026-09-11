(function (global) {
    'use strict';

    const Runtime = global.MusicStageRuntime;
    if (!Runtime) throw new Error('MusicStageRuntime must be loaded before music-stage-modes.js');

    const { clamp, hashString, seededRandom, splitGraphemes, DisposableScope } = Runtime;

    const createElement = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };

    const lineKey = (line) => line ? `${line.index}:${line.startTime}:${line.fullText}` : 'empty';

    const setWordVisualState = (element, state, index) => {
        const progress = clamp(state?.progress || 0);
        element.style.setProperty('--stage-word-progress', `${(progress * 100).toFixed(2)}%`);
        element.style.setProperty('--stage-word-order', String(index));
        element.classList.toggle('is-active', state?.status === 'active');
        element.classList.toggle('is-passed', state?.status === 'passed');
        element.classList.toggle('is-waiting', state?.status === 'waiting');
    };

    const createTimedWord = (state, index, className = '') => {
        const word = createElement('span', `stage-word ${className}`.trim(), state.text);
        word.dataset.wordIndex = String(index);
        setWordVisualState(word, state, index);
        return word;
    };

    const updateTimedWords = (wordElements, wordStates) => {
        wordElements.forEach((element, index) => {
            setWordVisualState(element, wordStates[index], index);
        });
    };

    const buildLineWords = (container, frame, className = '') => {
        const fragment = document.createDocumentFragment();
        const wordElements = frame.wordStates.map((state, index) => {
            const word = createTimedWord(state, index, className);
            fragment.appendChild(word);
            return word;
        });
        container.replaceChildren(fragment);
        return wordElements;
    };

    const makeModeBase = (id, label, container, services) => {
        const scope = new DisposableScope();
        const root = createElement('section', `music-stage-mode music-stage-mode-${id}`);
        root.dataset.mode = id;
        container.appendChild(root);
        let destroyed = false;

        return {
            id,
            label,
            root,
            scope,
            services,
            get destroyed() { return destroyed; },
            resize() {},
            updateTheme() {},
            destroy() {
                if (destroyed) return;
                destroyed = true;
                scope.destroy();
                root.remove();
            }
        };
    };

    const createLuminousMode = (container, services) => {
        const mode = makeModeBase('luminous', '流光', container, services);
        const aura = createElement('div', 'luminous-aura');
        const line = createElement('div', 'luminous-line');
        const translation = createElement('div', 'stage-translation luminous-translation');
        const previous = createElement('div', 'luminous-context luminous-context-previous');
        const next = createElement('div', 'luminous-context luminous-context-next');
        mode.root.append(aura, previous, line, next, translation);

        let renderedKey = '';
        let layoutSeed = '';
        let wordElements = [];

        mode.updateFrame = (frame) => {
            if (mode.destroyed) return;
            const key = lineKey(frame.activeLine);
            if (key !== renderedKey) {
                renderedKey = key;
                line.classList.remove('is-entering');
                void line.offsetWidth;
                line.classList.add('is-entering');

                if (!frame.activeLine) {
                    line.textContent = '等待音乐';
                    line.classList.add('is-empty');
                    translation.textContent = '';
                    wordElements = [];
                } else {
                    line.classList.remove('is-empty');
                    wordElements = buildLineWords(line, frame, 'luminous-word');
                    translation.textContent = frame.activeLine.translation || frame.activeLine.romanization || '';
                }

                previous.textContent = frame.previousLine?.fullText || '';
                next.textContent = frame.nextLines[0]?.fullText || '';
                layoutSeed = `${key}:${frame.viewport.width}:${frame.viewport.height}`;
                const random = seededRandom(layoutSeed);
                wordElements.forEach((word, index) => {
                    const calm = frame.wordStates.length > 12 ? 0.55 : 1;
                    word.style.setProperty('--word-x', `${((random() - 0.5) * 44 * calm).toFixed(1)}px`);
                    word.style.setProperty('--word-y', `${((random() - 0.5) * 34 * calm).toFixed(1)}px`);
                    word.style.setProperty('--word-rotate', `${((random() - 0.5) * 9 * calm).toFixed(2)}deg`);
                    word.style.setProperty('--word-scale', (1.04 + random() * 0.2).toFixed(3));
                    word.style.setProperty('--word-delay', `${Math.min(index * 28, 260)}ms`);
                });
            } else if (frame.activeLine) {
                updateTimedWords(wordElements, frame.wordStates);
            }

            const vocal = frame.audio.vocal;
            const bass = frame.audio.bass;
            mode.root.style.setProperty('--stage-vocal', vocal.toFixed(4));
            mode.root.style.setProperty('--stage-bass', bass.toFixed(4));
            aura.style.transform = `translate3d(-50%, -50%, 0) scale(${(0.88 + bass * 0.2).toFixed(3)})`;
            line.style.setProperty('--line-progress', frame.lineProgress.toFixed(4));
        };

        return mode;
    };

    const groupPartitaWords = (frame) => {
        const states = frame.wordStates;
        if (!states.length) return [];
        const totalChars = states.reduce((sum, state) => sum + splitGraphemes(state.text).length, 0);
        const targetGroups = clamp(Math.round(totalChars / 5), 2, 6);
        const groups = Array.from({ length: targetGroups }, () => []);
        let cursor = 0;
        states.forEach((state, index) => {
            groups[cursor].push({ state, index });
            if (
                groups[cursor].reduce((sum, entry) => sum + splitGraphemes(entry.state.text).length, 0) >= Math.ceil(totalChars / targetGroups)
                && cursor < groups.length - 1
            ) cursor += 1;
        });
        return groups.filter((group) => group.length);
    };

    const createPartitaMode = (container, services) => {
        const mode = makeModeBase('partita', '云阶', container, services);
        const grid = createElement('div', 'partita-grid');
        const eyebrow = createElement('div', 'partita-eyebrow', 'LYRIC / SEQUENCE');
        const translation = createElement('div', 'stage-translation partita-translation');
        mode.root.append(eyebrow, grid, translation);

        let renderedKey = '';
        let wordElements = [];

        mode.updateFrame = (frame) => {
            if (mode.destroyed) return;
            const key = lineKey(frame.activeLine);
            if (key !== renderedKey) {
                renderedKey = key;
                grid.replaceChildren();
                wordElements = [];
                if (!frame.activeLine) {
                    grid.appendChild(createElement('div', 'partita-empty', '等待音乐'));
                    translation.textContent = '';
                    return;
                }

                const random = seededRandom(`partita:${key}`);
                const groups = groupPartitaWords(frame);
                const fragment = document.createDocumentFragment();
                groups.forEach((group, groupIndex) => {
                    const block = createElement('div', 'partita-block');
                    block.style.setProperty('--block-order', String(groupIndex));
                    block.style.setProperty('--block-offset', `${((random() - 0.5) * 9).toFixed(2)}vh`);
                    block.style.setProperty('--block-angle', `${((random() - 0.5) * 3).toFixed(2)}deg`);
                    const marker = createElement('span', 'partita-marker', String(groupIndex + 1).padStart(2, '0'));
                    const text = createElement('div', 'partita-block-text');
                    group.forEach(({ state, index }) => {
                        const word = createTimedWord(state, index, 'partita-word');
                        wordElements[index] = word;
                        text.appendChild(word);
                    });
                    block.append(marker, text);
                    fragment.appendChild(block);
                });
                grid.appendChild(fragment);
                translation.textContent = frame.activeLine.translation || '';
            } else if (frame.activeLine) {
                updateTimedWords(wordElements, frame.wordStates);
            }

            mode.root.style.setProperty('--stage-power', frame.audio.power.toFixed(4));
            mode.root.style.setProperty('--partita-progress', frame.lineProgress.toFixed(4));
        };

        return mode;
    };

    let measureCanvas = null;
    const measureText = (text, font) => {
        measureCanvas ||= document.createElement('canvas');
        const context = measureCanvas.getContext('2d');
        if (!context) return String(text).length * 32;
        context.font = font;
        return context.measureText(String(text)).width;
    };

    const buildCadenzaComposition = (frame) => {
        const lines = [
            frame.previousLine,
            frame.activeLine,
            ...frame.nextLines.slice(0, 2)
        ].filter(Boolean);
        const width = Math.max(480, frame.viewport.width * 0.78);
        const height = Math.max(320, frame.viewport.height * 0.66);
        const random = seededRandom(`cadenza:${lineKey(frame.activeLine)}:${Math.round(width)}`);
        let cursorY = height * 0.16;

        return lines.map((entry, sequence) => {
            const isActive = entry.index === frame.currentLineIndex;
            const fontSize = isActive
                ? clamp(width / Math.max(8, splitGraphemes(entry.fullText).length * 0.82), 42, 88)
                : clamp(width / Math.max(14, splitGraphemes(entry.fullText).length), 22, 42);
            const font = `${isActive ? 700 : 540} ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
            const measured = measureText(entry.fullText, font);
            const xRange = Math.max(0, width - Math.min(measured, width));
            const x = sequence % 2 === 0 ? random() * xRange * 0.35 : xRange * (0.58 + random() * 0.35);
            const y = cursorY;
            cursorY += fontSize * (isActive ? 1.72 : 1.42);
            return { entry, sequence, isActive, fontSize, x, y, width, height };
        });
    };

    const createCadenzaMode = (container, services) => {
        const mode = makeModeBase('cadenza', '心象', container, services);
        const viewport = createElement('div', 'cadenza-viewport');
        const composition = createElement('div', 'cadenza-composition');
        const axis = createElement('div', 'cadenza-axis');
        const title = createElement('div', 'cadenza-title', 'MINDSCAPE');
        viewport.append(axis, composition);
        mode.root.append(title, viewport);

        let renderedKey = '';
        let renderedSize = '';
        let wordElements = [];

        mode.updateFrame = (frame) => {
            if (mode.destroyed) return;
            const key = lineKey(frame.activeLine);
            const sizeKey = `${Math.round(frame.viewport.width / 40)}:${Math.round(frame.viewport.height / 40)}`;
            if (key !== renderedKey || sizeKey !== renderedSize) {
                renderedKey = key;
                renderedSize = sizeKey;
                wordElements = [];
                const layout = buildCadenzaComposition(frame);
                const fragment = document.createDocumentFragment();

                if (!layout.length) {
                    fragment.appendChild(createElement('div', 'cadenza-empty', '等待音乐'));
                } else {
                    layout.forEach((item) => {
                        const line = createElement('div', `cadenza-line ${item.isActive ? 'is-current' : ''}`);
                        line.dataset.lineIndex = String(item.entry.index);
                        line.style.left = `${item.x}px`;
                        line.style.top = `${item.y}px`;
                        line.style.fontSize = `${item.fontSize}px`;
                        if (item.isActive) {
                            frame.wordStates.forEach((state, index) => {
                                const word = createTimedWord(state, index, 'cadenza-word');
                                wordElements[index] = word;
                                line.appendChild(word);
                            });
                        } else {
                            line.textContent = item.entry.fullText;
                        }
                        fragment.appendChild(line);
                    });
                }
                composition.replaceChildren(fragment);
            } else {
                updateTimedWords(wordElements, frame.wordStates);
            }

            const active = composition.querySelector('.cadenza-line.is-current');
            if (active) {
                const drift = (frame.lineProgress - 0.5) * -46;
                composition.style.transform = `translate3d(${drift.toFixed(2)}px, ${(frame.audio.lowMid * -10).toFixed(2)}px, 0)`;
            }
            mode.root.style.setProperty('--stage-vocal', frame.audio.vocal.toFixed(4));
        };

        mode.resize = () => {
            renderedSize = '';
        };

        return mode;
    };

    const drawFumeShape = (context, shape, frame, width, height) => {
        const band = frame.audio[shape.band] || 0;
        const scale = 0.86 + band * 0.52;
        const rotation = shape.rotation + frame.now * shape.speed;
        context.save();
        context.translate(shape.x * width, shape.y * height);
        context.rotate(rotation);
        context.scale(scale, scale);
        context.strokeStyle = `rgba(${shape.color}, ${shape.alpha * (0.55 + band * 1.5)})`;
        context.lineWidth = shape.lineWidth;
        context.shadowColor = `rgba(${shape.color}, ${0.15 + band * 0.3})`;
        context.shadowBlur = shape.kind === 'spark' ? 12 : 3;
        context.beginPath();
        const size = shape.size * Math.min(width, height);
        if (shape.kind === 'ring') {
            context.arc(0, 0, size, shape.gap, shape.gap + Math.PI * 1.72);
        } else if (shape.kind === 'square') {
            context.rect(-size, -size, size * 2, size * 2);
        } else if (shape.kind === 'cross') {
            context.moveTo(-size, 0);
            context.lineTo(size, 0);
            context.moveTo(0, -size);
            context.lineTo(0, size);
        } else {
            context.moveTo(0, -size);
            context.lineTo(size * 0.2, -size * 0.2);
            context.lineTo(size, 0);
            context.lineTo(size * 0.2, size * 0.2);
            context.lineTo(0, size);
            context.lineTo(-size * 0.2, size * 0.2);
            context.lineTo(-size, 0);
            context.lineTo(-size * 0.2, -size * 0.2);
            context.closePath();
        }
        context.stroke();
        context.restore();
    };

    const resolveFumePalette = (app) => {
        const accent = app?.visualizerColor || { r: 121, g: 216, b: 255 };
        const mixWithWhite = (amount) => [
            Math.round(accent.r + (255 - accent.r) * amount),
            Math.round(accent.g + (255 - accent.g) * amount),
            Math.round(accent.b + (255 - accent.b) * amount)
        ].join(',');
        return {
            accent: `${accent.r},${accent.g},${accent.b}`,
            soft: mixWithWhite(0.38),
            ink: mixWithWhite(0.78)
        };
    };

    const buildFumeShapes = (seed, palette) => {
        const random = seededRandom(seed);
        const kinds = ['ring', 'square', 'cross', 'spark'];
        const bands = ['bass', 'lowMid', 'vocal', 'treble'];
        const colors = [palette.accent, palette.soft, palette.ink];
        return Array.from({ length: 24 }, (_, index) => ({
            kind: kinds[index % kinds.length],
            band: bands[index % bands.length],
            x: 0.06 + random() * 0.88,
            y: 0.08 + random() * 0.84,
            size: 0.018 + random() * (index < 8 ? 0.18 : 0.055),
            rotation: random() * Math.PI,
            speed: (random() - 0.5) * 0.00008,
            gap: random() * Math.PI * 2,
            alpha: 0.04 + random() * 0.17,
            lineWidth: 0.6 + random() * 1.4,
            color: colors[index % colors.length]
        }));
    };

    const createFumeMode = (container, services) => {
        const mode = makeModeBase('fume', '浮名', container, services);
        const canvas = createElement('canvas', 'fume-canvas');
        const world = createElement('div', 'fume-world');
        const paper = createElement('article', 'fume-paper');
        const meta = createElement('div', 'fume-meta', 'FUME / TYPOGRAPHIC MOTION');
        const hero = createElement('div', 'fume-hero');
        const translation = createElement('div', 'stage-translation fume-translation');
        const before = createElement('div', 'fume-context fume-before');
        const after = createElement('div', 'fume-context fume-after');
        paper.append(meta, before, hero, translation, after);
        world.appendChild(paper);
        mode.root.append(canvas, world);

        const context = canvas.getContext('2d');
        let renderedKey = '';
        let paletteSignature = '';
        let wordElements = [];
        let shapes = buildFumeShapes('fume', resolveFumePalette(services.app));
        let canvasWidth = 0;
        let canvasHeight = 0;

        const resizeCanvas = (frame) => {
            const width = Math.max(1, mode.root.clientWidth);
            const height = Math.max(1, mode.root.clientHeight);
            const dpr = frame?.viewport?.dpr || Math.min(2, global.devicePixelRatio || 1);
            const pixelWidth = Math.floor(width * dpr);
            const pixelHeight = Math.floor(height * dpr);
            if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
                canvas.width = pixelWidth;
                canvas.height = pixelHeight;
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
            }
            canvasWidth = width;
            canvasHeight = height;
            context?.setTransform(dpr, 0, 0, dpr, 0, 0);
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed) return;
            resizeCanvas(frame);
            const key = lineKey(frame.activeLine);
            const color = services.app?.visualizerColor || { r: 121, g: 216, b: 255 };
            const nextPaletteSignature = `${color.r}:${color.g}:${color.b}`;
            if (key !== renderedKey || nextPaletteSignature !== paletteSignature) {
                renderedKey = key;
                paletteSignature = nextPaletteSignature;
                shapes = buildFumeShapes(`fume:${key}`, resolveFumePalette(services.app));
                before.textContent = frame.previousLine?.fullText || '';
                after.textContent = frame.nextLines.map((line) => line.fullText).join('  /  ');
                if (frame.activeLine) {
                    wordElements = buildLineWords(hero, frame, 'fume-word');
                    translation.textContent = frame.activeLine.translation || '';
                } else {
                    hero.textContent = '等待音乐';
                    translation.textContent = '';
                    wordElements = [];
                }
                paper.classList.remove('is-entering');
                void paper.offsetWidth;
                paper.classList.add('is-entering');
            } else if (frame.activeLine) {
                updateTimedWords(wordElements, frame.wordStates);
            }

            if (context) {
                context.clearRect(0, 0, canvasWidth, canvasHeight);
                const gradient = context.createRadialGradient(
                    canvasWidth * (0.35 + frame.audio.lowMid * 0.2),
                    canvasHeight * 0.44,
                    0,
                    canvasWidth * 0.5,
                    canvasHeight * 0.5,
                    Math.max(canvasWidth, canvasHeight) * 0.72
                );
                gradient.addColorStop(0, `rgba(80, 130, 220, ${0.06 + frame.audio.vocal * 0.1})`);
                gradient.addColorStop(1, 'rgba(0,0,0,0)');
                context.fillStyle = gradient;
                context.fillRect(0, 0, canvasWidth, canvasHeight);
                shapes.forEach((shape) => drawFumeShape(context, shape, frame, canvasWidth, canvasHeight));
            }

            const cameraX = (frame.lineProgress - 0.5) * -4.5;
            const cameraY = Math.sin(frame.lineProgress * Math.PI) * -2.2;
            world.style.transform = `translate3d(${cameraX.toFixed(2)}vw, ${cameraY.toFixed(2)}vh, 0) scale(${(1 + frame.audio.bass * 0.018).toFixed(4)})`;
            mode.root.style.setProperty('--stage-vocal', frame.audio.vocal.toFixed(4));
        };

        mode.resize = () => {
            canvasWidth = 0;
            canvasHeight = 0;
        };

        mode.scope.add(() => {
            if (context) context.clearRect(0, 0, canvas.width, canvas.height);
            canvas.width = 1;
            canvas.height = 1;
            shapes = [];
        });

        return mode;
    };

    const directedModes = Object.freeze([
        { id: 'luminous', label: '流光', create: createLuminousMode },
        { id: 'partita', label: '云阶', create: createPartitaMode },
        { id: 'cadenza', label: '心象', create: createCadenzaMode },
        { id: 'fume', label: '浮名', create: createFumeMode }
    ]);

    const resolveStarbornSegment = (frame) => {
        if (!frame.activeLine) return {
            key: 'empty',
            startIndex: -1,
            lines: []
        };

        /*
         * 每个有效歌词行都是一次导演决策点。分析时仍带入下一行作为上下文，
         * 但 key 只跟随当前行变化，因此不会被固定双行分组拖慢转场。
         */
        const currentLine = frame.activeLine;
        const nextLine = frame.nextLines.find((line) => line.fullText.trim());
        const lines = [currentLine, nextLine].filter(Boolean);
        const trackIdentity = frame.track?.path || frame.track?.title || 'unknown-track';
        return {
            key: `${trackIdentity}:${lineKey(currentLine)}`,
            startIndex: frame.currentLineIndex,
            lines
        };
    };

    const chooseStarbornMode = (frame, segment, previousModeId = '', recentModeIds = []) => {
        if (!segment.lines.length) return directedModes[0];

        const text = segment.lines.map((line) => line.fullText).join(' ');
        const charCount = splitGraphemes(text).filter((char) => char.trim()).length;
        const timedWordCount = segment.lines.reduce((total, line) => total + (line.words?.length || 0), 0);
        const duration = segment.lines.reduce(
            (total, line) => total + Math.max(0.2, line.endTime - line.startTime),
            0
        );
        const hasTranslation = segment.lines.some((line) => line.translation);
        const expressiveMarks = (text.match(/[!?！？…—]/g) || []).length;
        const pace = timedWordCount / Math.max(1, duration);
        const random = seededRandom(`starborn:${segment.key}`);
        const rotation = hashString(segment.key) % directedModes.length;
        const scores = {
            luminous: random() * 0.42 + frame.audio.vocal * 1.05 + frame.audio.bass * 0.72,
            partita: random() * 0.42 + Math.min(1.4, pace * 0.48) + Math.min(0.7, timedWordCount * 0.035),
            cadenza: random() * 0.42 + expressiveMarks * 0.28 + (1 - frame.audio.power) * 0.66,
            fume: random() * 0.42 + Math.min(1.15, charCount / 34) + (hasTranslation ? 0.48 : 0)
        };

        if (charCount <= 18) scores.luminous += 0.48;
        if (charCount >= 34) scores.fume += 0.58;
        if (timedWordCount >= 10) scores.partita += 0.42;
        if (expressiveMarks >= 2) scores.cadenza += 0.38;

        // 保留可复现的歌曲发展轨迹，并对最近使用过的舞台施加冷却。
        scores[directedModes[rotation].id] += 0.44;
        recentModeIds.forEach((modeId, recency) => {
            if (scores[modeId] !== undefined) scores[modeId] -= recency === 0 ? 0.72 : 0.34;
        });

        /*
         * 当前模式硬排除：只要进入新的有效歌词行，星诞就必然换景。
         * “智能”负责从其余三种中选最适合的，而不是决定是否换景。
         */
        const candidates = directedModes.filter((entry) => entry.id !== previousModeId);
        return candidates
            .map((entry) => ({ ...entry, score: scores[entry.id] }))
            .sort((left, right) => right.score - left.score)[0] || directedModes[0];
    };

    const STARBORN_TRANSITION_LOCK_SECONDS = 4;

    const createStarbornMode = (container, services) => {
        const mode = makeModeBase('starborn', '星诞', container, services);
        const directorCue = createElement('div', 'starborn-director-cue');
        const transitionBurst = createElement('div', 'starborn-transition-burst');
        directorCue.setAttribute('aria-hidden', 'true');
        transitionBurst.setAttribute('aria-hidden', 'true');
        mode.root.append(directorCue, transitionBurst);

        let childMode = null;
        let childLayer = null;
        let segmentKey = '';
        let pendingSegment = null;
        let directedModeId = '';
        let transitionCount = 0;
        let lastTransitionPlaybackTime = Number.NEGATIVE_INFINITY;
        let trackIdentity = '';
        const recentModeIds = [];

        const mountDirectedMode = (entry, frame) => {
            const previousChild = childMode;
            const previousLayer = childLayer;
            childLayer = createElement('div', 'starborn-performance-layer is-entering');
            const enteringLayer = childLayer;
            childLayer.dataset.directedMode = entry.id;
            mode.root.appendChild(childLayer);
            childMode = entry.create(childLayer, services);
            directedModeId = entry.id;
            transitionCount += 1;
            recentModeIds.unshift(entry.id);
            recentModeIds.splice(2);
            directorCue.textContent = `STAR BORN · ${String(transitionCount).padStart(2, '0')} / ${entry.label}`;
            mode.root.dataset.directedMode = entry.id;
            mode.root.dataset.transitionCount = String(transitionCount);
            lastTransitionPlaybackTime = frame.playbackTime;
            pendingSegment = null;
            childMode.updateFrame?.(frame);

            directorCue.classList.remove('is-switching');
            transitionBurst.classList.remove('is-active');
            void transitionBurst.offsetWidth;
            directorCue.classList.add('is-switching');
            transitionBurst.classList.add('is-active');
            requestAnimationFrame(() => enteringLayer.classList.remove('is-entering'));
            if (previousLayer) {
                previousLayer.classList.add('is-leaving');
                mode.scope.timeout(() => {
                    previousChild?.destroy?.();
                    previousLayer.remove();
                }, 520);
            }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed) return;
            const segment = resolveStarbornSegment(frame);
            const nextTrackIdentity = frame.track?.path || frame.track?.title || 'unknown-track';
            const trackChanged = nextTrackIdentity !== trackIdentity;
            const playbackJumpedBackward = frame.playbackTime < lastTransitionPlaybackTime - 0.25;

            if (trackChanged) {
                trackIdentity = nextTrackIdentity;
                segmentKey = '';
                pendingSegment = null;
                lastTransitionPlaybackTime = Number.NEGATIVE_INFINITY;
                recentModeIds.length = 0;
            } else if (playbackJumpedBackward) {
                // 回退拖动后从当前位置重新计算锁，避免旧时间戳令转场长期失效。
                lastTransitionPlaybackTime = Number.NEGATIVE_INFINITY;
            }

            if (segment.key !== segmentKey) {
                segmentKey = segment.key;
                pendingSegment = segment;
            }

            const lockElapsed = frame.playbackTime - lastTransitionPlaybackTime;
            const canTransition = !childMode
                || trackChanged
                || playbackJumpedBackward
                || lockElapsed >= STARBORN_TRANSITION_LOCK_SECONDS;

            if (pendingSegment && canTransition) {
                const selection = chooseStarbornMode(
                    frame,
                    pendingSegment,
                    directedModeId,
                    recentModeIds
                );
                mountDirectedMode(selection, frame);
                return;
            }

            /*
             * 时间锁内继续让当前舞台渲染最新歌词；若连续经过多个短句，
             * pendingSegment 会被最新歌词覆盖，解锁后只演出仍在播放的内容。
             */
            childMode?.updateFrame?.(frame);
        };

        mode.resize = (viewport) => childMode?.resize?.(viewport);
        mode.updateTheme = (theme) => childMode?.updateTheme?.(theme);
        mode.suspend = () => childMode?.suspend?.();
        mode.resume = () => childMode?.resume?.();
        mode.scope.add(() => {
            childMode?.destroy?.();
            childMode = null;
            childLayer = null;
        });

        return mode;
    };

    const registry = new Map([
        ...directedModes.map((entry) => [entry.id, entry]),
        ['starborn', { id: 'starborn', label: '星诞', create: createStarbornMode }]
    ]);

    global.MusicStageModes = Object.freeze({
        ids: Object.freeze(Array.from(registry.keys())),
        entries: Object.freeze(Array.from(registry.values())),
        get(id) {
            return registry.get(id) || registry.get('luminous');
        },
        create(id, container, services) {
            return this.get(id).create(container, services);
        }
    });
})(window);