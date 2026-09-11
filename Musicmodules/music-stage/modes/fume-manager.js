(function (global) {
    'use strict';

    // Native adaptation of Folia VisualizerFume's article / focus / print / hold pipeline (AGPL-3.0).
    // Deterministic newspaper packing with measured glyph coordinates and absolute-time camera flights.
    const U = global.MusicStageModeUtils;
    const R = global.MusicStageRuntime;
    const { clamp, seededRandom, splitGraphemes, resolveAccent, makeModeBase, createElement } = U;
    const value = (v, fallback, min = 0, max = 2) => clamp(Number.isFinite(Number(v)) ? Number(v) : fallback, min, max);
    const ease = v => { const t = clamp(v); return t * t * t * (t * (t * 6 - 15) + 10); };

    const createManager = (container, services) => {
        const mode = makeModeBase('fume', '浮名', container, services);
        const canvas = createElement('canvas', 'fume-canvas');
        const world = createElement('div', 'fume-article-world');
        const translation = createElement('div', 'stage-translation fume-article-subtitle');
        const heading = createElement('div', 'fume-article-heading');
        const empty = createElement('div', 'fume-article-empty', '等待歌词');
        mode.root.append(canvas, world, heading, translation, empty);
        const context = canvas.getContext('2d');
        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const mounted = new Map();
        let blocks = [], lines = null, trackKey = '', shapeKey = '';
        let width = 0, height = 0, pixelRatio = 0;
        let latestFrame = null, paused = false, dirty = true;
        let cameraY = 0, cameraX = 0, cameraScale = 1;
        let paperWidth = 1, paperHeight = 1;
        let shapes = [];
        const tuning = () => mode.config.modes?.fume || {};
        const intensity = () => reduced?.matches ? 0 : value(mode.config.animationIntensity, 1);

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const budget = mode.config.quality === 'energy-saving' ? 1280 * 720 : 1920 * 1080 * 1.5;
            const dpr = Math.min(2, global.devicePixelRatio || 1, Math.sqrt(budget / (w * h)));
            if (w !== width || h !== height) dirty = true;
            if (w === width && h === height && dpr === pixelRatio) return;
            width = w; height = h; pixelRatio = dpr;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            context?.setTransform(dpr, 0, 0, dpr, 0, 0);
        };

        const compile = () => {
            mounted.forEach(entry => entry.element.remove());
            mounted.clear();
            const t = tuning();
            const heroScale = value(t.heroScale, 1, 0.82, 1.32);
            const spacing = value(t.articleSpacing, 1, 0.65, 1.6);
            const columns = width < 600 ? 2 : width < 1100 ? 3 : 4;
            const columnWidth = clamp(width * 0.42, 260, 460);
            const gap = 18 * spacing;
            paperWidth = columns * columnWidth + (columns - 1) * gap;
            const skyline = Array(columns).fill(0);
            blocks = (lines || []).map((line, index) => {
                const length = splitGraphemes(line.fullText).filter(char => char.trim()).length;
                const hero = length > 0 && (Boolean(line.isChorus) || (length <= 28 && index % 6 === 0));
                return {
                    line, index, x: 0, y: 0, height: 1,
                    width: hero ? columnWidth * 2 + gap : columnWidth,
                    span: hero ? 2 : 1,
                    fontSize: (hero ? 42 : 26) * (hero ? heroScale : 1),
                    hero, glyphLayout: [],
                    order: R.hashString(`${trackKey}:${index}:${line.fullText}`)
                };
            });
            // Measure one block at a time using the same DOM and styles as the resident view.
            // Only numeric geometry survives compilation; detached glyph nodes are not cached.
            const order = [...blocks].sort((a, b) => a.order - b.order || a.index - b.index);
            order.forEach(block => {
                let column = 0, top = Infinity;
                for (let c = 0; c <= columns - block.span; c++) {
                    const candidate = Math.max(...skyline.slice(c, c + block.span));
                    if (candidate < top) { column = c; top = candidate; }
                }
                block.x = column * (columnWidth + gap);
                block.y = top;
                const entry = mountBlock(block, true);
                block.height = Math.max(1, entry.element.offsetHeight);
                // offset coordinates are independent of any ancestor camera transform.
                block.glyphLayout = entry.glyphs.map(glyph => ({
                    start: glyph.start, end: glyph.end, char: glyph.char,
                    x: entry.text.offsetLeft + glyph.span.offsetLeft + glyph.span.offsetWidth * 0.5,
                    y: entry.text.offsetTop + glyph.span.offsetTop + glyph.span.offsetHeight * 0.5
                }));
                entry.element.remove();
                for (let c = column; c < column + block.span; c++) skyline[c] = top + block.height + gap;
            });
            paperHeight = Math.max(1, ...skyline);
            dirty = false;
        };

        const mountBlock = (block, measuring = false) => {
            const element = createElement('article', `fume-article-block${block.hero ? ' is-hero' : ''}`);
            const number = createElement('div', 'fume-article-number', `${String(block.index + 1).padStart(3, '0')} / ${block.hero ? 'VERSE' : 'TEXT'}`);
            const text = createElement('div', 'fume-article-text');
            element.style.width = `${block.width}px`;
            text.style.fontSize = `${block.fontSize}px`;
            element.append(number, text);
            const glyphs = [];
            (block.line.resolvedWords || []).forEach(word => {
                const chars = splitGraphemes(word.text);
                chars.forEach((char, index) => {
                    const span = createElement('span', 'fume-print-glyph', char);
                    const start = word.startTime + (word.endTime - word.startTime) * index / Math.max(1, chars.length);
                    const end = word.startTime + (word.endTime - word.startTime) * (index + 1) / Math.max(1, chars.length);
                    glyphs.push({ span, start, end, char });
                    text.appendChild(span);
                });
            });
            element.style.left = `${block.x}px`;
            element.style.top = `${block.y}px`;
            if (measuring) element.style.visibility = 'hidden';
            world.appendChild(element);
            const entry = { element, text, number, glyphs };
            if (!measuring) mounted.set(block.index, entry);
            return entry;
        };

        const syncWindow = (index, fromIndex) => {
            const wanted = new Set([index, fromIndex]);
            const overscan = 100 / cameraScale;
            const left = cameraX - width * 0.5 / cameraScale - overscan;
            const right = cameraX + width * 0.5 / cameraScale + overscan;
            const top = cameraY - height * 0.44 / cameraScale - overscan;
            const bottom = cameraY + height * 0.56 / cameraScale + overscan;
            blocks.forEach(b => {
                if (b.x + b.width >= left && b.x <= right && b.y + b.height >= top && b.y <= bottom) wanted.add(b.index);
            });
            mounted.forEach((entry, i) => {
                if (!wanted.has(i)) { entry.element.remove(); mounted.delete(i); }
            });
            wanted.forEach(i => { if (!mounted.has(i)) mountBlock(blocks[i]); });
        };

        const focusAt = (block, time, stepped = false) => {
            const glyphs = block.glyphLayout;
            const scale = clamp(Math.min(width, height) * 0.09 / block.fontSize, 0.9, 2);
            if (!glyphs.length) return { x: block.x + block.width / 2, y: block.y + block.height / 2, scale };
            // Binary search the actual measured reading head, including whitespace timings.
            let low = 0, high = glyphs.length - 1, index = 0;
            while (low <= high) {
                const middle = (low + high) >> 1;
                if (glyphs[middle].start <= time) { index = middle; low = middle + 1; }
                else high = middle - 1;
            }
            const a = glyphs[index], b = glyphs[Math.min(index + 1, glyphs.length - 1)];
            const interval = b.start - a.start;
            const blend = stepped || interval <= 0 ? 0 : clamp((time - a.start) / interval);
            return { x: block.x + a.x + (b.x - a.x) * blend, y: block.y + a.y + (b.y - a.y) * blend, scale };
        };

        const readingFocus = (block, time, stepped) => {
            if (stepped || intensity() === 0) return focusAt(block, time, true);
            const glyphs = block.glyphLayout;
            if (!glyphs.length) return focusAt(block, time);
            // Sum continuous displacement ramps instead of resampling a discontinuous index.
            // Quintic ramps have zero endpoint velocity/acceleration, including duplicate timings.
            // No frame-history state: pause, reverse seek and direct seek evaluate the same curve.
            let x = glyphs[0].x, y = glyphs[0].y;
            for (let i = 1; i < glyphs.length; i++) {
                const a = glyphs[i - 1], b = glyphs[i];
                const dx = b.x - a.x, dy = b.y - a.y;
                const wraps = Math.abs(dy) > block.fontSize * 0.5;
                const interval = Math.max(0, b.start - a.start);
                const screenDistance = Math.hypot(dx, dy)
                    * clamp(Math.min(width, height) * 0.09 / block.fontSize, 0.9, 2);
                // A long-word line return must not finish within a single synthetic glyph.
                const window = wraps
                    ? clamp(0.65 + screenDistance / 1400, 0.65, 1.25)
                    : clamp(interval + 0.22, 0.28, 0.65);
                const center = wraps ? b.start : (a.start + b.start) * 0.5;
                const progress = ease((time - center + window * 0.5) / window);
                x += dx * progress;
                y += dy * progress;
            }
            const scale = clamp(Math.min(width, height) * 0.09 / block.fontSize, 0.9, 2);
            return { x: block.x + x, y: block.y + y, scale };
        };

        const overview = () => ({
            x: paperWidth / 2, y: paperHeight / 2,
            scale: Math.max(0.04, Math.min(width * 0.82 / paperWidth, height * 0.6 / paperHeight, 0.85))
        });
        const interpolate = (a, b, p) => ({
            x: a.x + (b.x - a.x) * p,
            y: a.y + (b.y - a.y) * p,
            scale: a.scale + (b.scale - a.scale) * p
        });
        const resolveCamera = (index, time) => {
            const block = blocks[index];
            const stepped = tuning().cameraMode === 'stepped';
            const target = readingFocus(block, time, stepped);
            if (intensity() === 0) return target;
            const previous = blocks[Math.max(0, index - 1)];
            const speed = value(tuning().cameraSpeed, 1, 0.55, 1.85);
            const from = index === 0 ? overview() : readingFocus(previous, block.line.startTime, stepped);
            const entry = readingFocus(block, block.line.startTime, stepped);
            const distance = Math.hypot(entry.x - from.x, entry.y - from.y);
            const duration = Math.min(
                Math.max(0.05, (block.line.endTime - block.line.startTime) * 0.42),
                clamp(0.65 + distance / Math.max(width, height) * 0.35, 0.65, 1.8) / speed
            );
            const p = ease((time - block.line.startTime) / duration);
            const pose = interpolate(from, target, p);
            // A smooth zoom-out bridge reveals the page while crossing distant columns.
            const loft = clamp(distance * Math.max(from.scale, target.scale) / Math.min(width, height) - 0.8, 0, 1);
            pose.scale *= 1 - Math.sin(p * Math.PI) ** 2 * loft * 0.45;
            const last = blocks[blocks.length - 1];
            if (index === blocks.length - 1 && time >= last.line.endTime) {
                return interpolate(readingFocus(last, last.line.endTime, stepped), overview(), ease((time - last.line.endTime) / 2.4));
            }
            return pose;
        };

        const rebuildShapes = () => {
            const accent = resolveAccent(services?.app);
            const key = `${trackKey}:${accent.r}:${accent.g}:${accent.b}`;
            if (shapeKey === key) return;
            shapeKey = key;
            const random = seededRandom(`fume-world:${trackKey}`);
            shapes = Array.from({ length: 28 }, (_, index) => ({
                kind: index % 4, band: ['bass', 'lowMid', 'mid', 'treble'][index % 4],
                x: random(), y: random(), size: 0.015 + random() * 0.08,
                phase: random() * Math.PI * 2, speed: (random() - 0.5) * 0.05,
                color: `rgb(${accent.r},${accent.g},${accent.b})`
            }));
        };

        const drawBackground = frame => {
            if (!context) return;
            context.clearRect(0, 0, width, height);
            const t = tuning();
            if (t.geometricBackground === false || value(t.backgroundOpacity, 0.5, 0, 1) === 0) return;
            const strength = intensity();
            const detail = value(t.backgroundDetail, 0.6, 0, 1);
            const breeze = value(t.backgroundMotion, 1) * strength;
            const count = mode.config.quality === 'energy-saving' ? 12 : shapes.length;
            for (let index = 0; index < count; index += 1) {
                const shape = shapes[index];
                const energy = value(frame.audio?.[shape.band], 0, 0, 1) * strength;
                const size = shape.size * Math.min(width, height) * (1 + energy * 0.25);
                const y = ((shape.y * height - cameraY * 0.12) % (height * 1.4) + height * 1.4) % (height * 1.4) - height * 0.2;
                context.save();
                const x = ((shape.x * width - cameraX * 0.1) % (width * 1.4) + width * 1.4) % (width * 1.4) - width * 0.2;
                const drift = Math.sin(frame.playbackTime * 0.18 * breeze + shape.phase) * 8 * Math.min(1, breeze);
                context.translate(x, y + drift);
                context.rotate(shape.phase + frame.playbackTime * shape.speed * breeze);
                context.globalAlpha = 0.08 + energy * 0.12;
                context.strokeStyle = shape.color;
                context.lineWidth = 1;
                context.beginPath();
                if (shape.kind === 0) context.arc(0, 0, size, 0, Math.PI * 1.7);
                else if (shape.kind === 1) context.rect(-size, -size, size * 2, size * 2);
                else if (shape.kind === 2) {
                    context.moveTo(-size, 0); context.lineTo(size, 0);
                    context.moveTo(0, -size); context.lineTo(0, size);
                } else {
                    context.moveTo(0, -size); context.lineTo(size, 0);
                    context.lineTo(0, size); context.lineTo(-size, 0); context.closePath();
                }
                context.stroke();
                if (detail > 0 && (shape.kind === 0 || shape.kind === 1)) {
                    context.globalAlpha = (0.045 + energy * 0.08) * detail;
                    context.lineWidth = 0.6;
                    context.beginPath();
                    if (shape.kind === 0) {
                        context.arc(0, 0, size * 0.82, Math.PI * 0.25, Math.PI * 1.5);
                    } else {
                        context.rect(-size * 0.8, -size * 0.8, size * 1.6, size * 1.6);
                    }
                    context.stroke();
                    if (shape.kind === 0) {
                        const phase = shape.phase + frame.playbackTime * 0.25 * breeze;
                        context.globalAlpha = (0.2 + energy * 0.25) * detail;
                        context.fillStyle = shape.color;
                        context.beginPath();
                        context.arc(Math.cos(phase) * size, Math.sin(phase) * size, 1.5 + energy, 0, Math.PI * 2);
                        context.fill();
                    }
                }
                context.restore();
            }
        };

        mode.updateFrame = frame => {
            if (mode.destroyed || paused) return;
            latestFrame = frame;
            resize();
            const nextTrackKey = frame.track?.path || frame.track?.title || '';
            if (lines !== frame.lines || trackKey !== nextTrackKey) {
                lines = frame.lines; trackKey = nextTrackKey; dirty = true;
            }
            if (dirty) compile();
            rebuildShapes();
            const t = tuning();
            const time = frame.playbackTime;
            const index = Math.max(0, Math.min(blocks.length - 1, frame.currentLineIndex));
            const block = blocks[index];
            const previous = blocks[Math.max(0, index - 1)];
            empty.hidden = Boolean(block);
            empty.textContent = frame.track ? '纯音乐 / 暂无歌词' : '等待音乐';
            if (block) {
                const pose = resolveCamera(index, time);
                cameraX = pose.x; cameraY = pose.y; cameraScale = pose.scale;
                syncWindow(index, Math.max(0, index - 1));
                world.style.transform = `translate3d(${width * 0.5 - cameraX * cameraScale}px,${height * 0.44 - cameraY * cameraScale}px,0) scale(${cameraScale})`;
                const songDuration = (lines[lines.length - 1]?.endTime || 0) - (lines[0]?.startTime || 0);
                const holdRatio = value(t.textHoldRatio, 0.35, 0, 1);
                const hold = holdRatio >= 1 ? Infinity : clamp(songDuration * holdRatio, 2.4, 130);
                mounted.forEach((entry, i) => {
                    const b = blocks[i];
                    const current = i === index && time >= b.line.startTime;
                    const passed = time >= b.line.endTime;
                    const dim = passed ? ease((time - b.line.endTime) / hold) : 0;
                    entry.element.style.opacity = String(current ? 1 : passed ? 0.58 - dim * 0.45 : 0.13);
                    entry.element.classList.toggle('is-current', current);
                    // Keep measured geometry stable when hiding the decorative header.
                    entry.number.style.visibility = t.hidePrintSymbols === true ? 'hidden' : 'visible';
                    entry.glyphs.forEach(glyph => {
                        const progress = clamp((time - glyph.start) / Math.max(0.04, glyph.end - glyph.start));
                        const printed = time >= glyph.start;
                        const active = printed && time < glyph.end;
                        glyph.span.style.opacity = printed ? '1' : '0.22';
                        glyph.span.style.setProperty('--print-progress', `${progress * 100}%`);
                        glyph.span.style.setProperty('--print-pulse', String(active && intensity() > 0 ? Math.sin(progress * Math.PI) : 0));
                        glyph.span.classList.toggle('is-printing', active);
                        glyph.span.classList.toggle('is-printed', printed);
                    });
                });
                translation.textContent = frame.activeLine?.translation || frame.activeLine?.romanization || '';
                heading.textContent = `FUME / ${String(index + 1).padStart(3, '0')} — ${String(blocks.length).padStart(3, '0')}`;
            } else {
                translation.textContent = '';
                heading.textContent = 'FUME / INSTRUMENTAL';
                cameraX = cameraY = 0;
            }
            canvas.style.opacity = String(value(t.backgroundOpacity, 0.5, 0, 1));
            mode.root.style.setProperty('--fume-glow-intensity', String(value(t.glow, 1)));
            mode.root.classList.toggle('stage-hide-fume-background', t.geometricBackground === false);
            mode.root.classList.toggle('fume-hide-print-symbols', t.hidePrintSymbols === true);
            drawBackground(frame);
        };

        const updateConfig = mode.updateConfig;
        mode.updateConfig = config => {
            const before = tuning();
            const after = config.modes?.fume || {};
            if (['heroScale', 'articleSpacing'].some(key => before[key] !== after[key])) dirty = true;
            updateConfig(config);
            if (latestFrame) mode.updateFrame(latestFrame);
        };
        mode.resize = () => { resize(); if (latestFrame) mode.updateFrame(latestFrame); };
        mode.suspend = () => { paused = true; };
        mode.resume = () => { paused = false; if (latestFrame) mode.updateFrame(latestFrame); };
        mode.updateTheme = () => { shapeKey = ''; dirty = true; };
        mode.scope.listen(document.fonts, 'loadingdone', () => {
            dirty = true;
            if (latestFrame) mode.updateFrame(latestFrame);
        });
        mode.scope.add(() => {
            mounted.clear(); blocks = []; shapes = []; lines = null; latestFrame = null;
            canvas.width = canvas.height = 1;
        });
        resize();
        return mode;
    };
    global.MusicStageFumeManager = Object.freeze({ create: createManager });
})(window);