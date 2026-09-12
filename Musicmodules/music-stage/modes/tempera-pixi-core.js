(function (global) {
    'use strict';

    // 核心几何与网点算法 (纯算法，无 DOM)
    const TAU = Math.PI * 2;
    const Effects = global.MusicStagePixiEffects;
    const mix = (from, to, amount) => from + (to - from) * amount;
    const clamp = (val, min = 0, max = 1) => Math.min(max, Math.max(min, val));

    const parseColor = (color) => {
        if (!color) return { r: 255, g: 255, b: 255 };
        if (color.startsWith('#')) {
            const hex = color.slice(1);
            if (hex.length === 3) {
                return {
                    r: parseInt(hex[0] + hex[0], 16),
                    g: parseInt(hex[1] + hex[1], 16),
                    b: parseInt(hex[2] + hex[2], 16)
                };
            }
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16)
            };
        }
        const m = color.match(/rgba?\(([^)]+)\)/);
        if (m) {
            const [r, g, b] = m[1].split(',').map(Number);
            return { r, g, b };
        }
        return { r: 255, g: 255, b: 255 };
    };

    const mixColors = (from, to, amount) => {
        const c1 = parseColor(from);
        const c2 = parseColor(to);
        const a = clamp(amount, 0, 1);
        const r = Math.round(mix(c1.r, c2.r, a));
        const g = Math.round(mix(c1.g, c2.g, a));
        const b = Math.round(mix(c1.b, c2.b, a));
        return `rgb(${r}, ${g}, ${b})`;
    };

    const rectPolygon = (x, y, w, h) => [x, y, x + w, y, x + w, y + h, x, y + h];
    const diamondPolygon = (cx, cy, rx, ry) => [cx, cy - ry, cx + rx, cy, cx, cy + ry, cx - rx, cy];

    const buildHatchLines = (polygon, angle, spacing) => {
        if (polygon.length < 6 || spacing <= 0) return [];
        const xs = [], ys = [];
        for (let i = 0; i < polygon.length; i += 2) {
            xs.push(polygon[i]);
            ys.push(polygon[i + 1]);
        }
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const diagonal = Math.hypot(maxX - minX, maxY - minY);
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const px = -dy;
        const py = dx;
        const steps = Math.min(160, Math.ceil(diagonal / (spacing * 2)) + 2);
        const lines = [];

        for (let step = -steps; step <= steps; step += 1) {
            const offset = step * spacing;
            const ax = centerX + px * offset;
            const ay = centerY + py * offset;
            lines.push({
                x1: ax - dx * (diagonal * 0.5),
                y1: ay - dy * (diagonal * 0.5),
                x2: ax + dx * (diagonal * 0.5),
                y2: ay + dy * (diagonal * 0.5)
            });
        }
        return lines;
    };

    // 完整的色块分镜库 (涵盖 Duo, Quad, Thirds, Diagonal, Ladder 等)
    const COMPOSITIONS = {
        'duo-split': (ctx) => {
            const { width, height, palette, bleed } = ctx;
            const horizontal = ctx.seedRandom() > 0.5;
            return horizontal
                ? [
                    { polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height * 0.52 + bleed), tone: palette.tone1, enterDX: 0, enterDY: -height * 0.4 },
                    { polygon: rectPolygon(-bleed, height * 0.52, width + bleed * 2, height * 0.48 + bleed), tone: palette.tone3, enterDX: 0, enterDY: height * 0.4 }
                ]
                : [
                    { polygon: rectPolygon(-bleed, -bleed, width * 0.5 + bleed, height + bleed * 2), tone: palette.tone1, enterDX: -width * 0.4, enterDY: 0 },
                    { polygon: rectPolygon(width * 0.5, -bleed, width * 0.5 + bleed, height + bleed * 2), tone: palette.tone3, enterDX: width * 0.4, enterDY: 0 }
                ];
        },
        'quad-split': (ctx) => {
            const { width, height, palette, bleed } = ctx;
            const splitX = width * 0.5;
            const splitY = height * 0.5;
            return [
                { polygon: rectPolygon(-bleed, -bleed, splitX + bleed, splitY + bleed), tone: palette.tone1, enterDX: -width * 0.3, enterDY: -height * 0.3 },
                { polygon: rectPolygon(splitX, -bleed, width - splitX + bleed, splitY + bleed), tone: palette.tone4, enterDX: width * 0.3, enterDY: -height * 0.3 },
                { polygon: rectPolygon(-bleed, splitY, splitX + bleed, height - splitY + bleed), tone: palette.tone3, enterDX: -width * 0.3, enterDY: height * 0.3 },
                { polygon: rectPolygon(splitX, splitY, width - splitX + bleed, height - splitY + bleed), tone: palette.tone2, enterDX: width * 0.3, enterDY: height * 0.3 }
            ];
        },
        'diagonal-halves': (ctx) => {
            const { width, height, palette, bleed } = ctx;
            const lean = height * 0.35;
            return [
                { polygon: [-bleed, -bleed, width + bleed, -bleed, width + bleed, lean, -bleed, height - lean], tone: palette.tone2, enterDX: 0, enterDY: -height * 0.4 },
                { polygon: [-bleed, height - lean, width + bleed, lean, width + bleed, height + bleed, -bleed, height + bleed], tone: palette.tone4, enterDX: 0, enterDY: height * 0.4 }
            ];
        },
        'tri-column': (ctx) => {
            const { width, height, palette, bleed } = ctx;
            const edge = width * 0.3;
            return [
                { polygon: rectPolygon(-bleed, -bleed, edge + bleed, height + bleed * 2), tone: palette.tone1, enterDX: -width * 0.3, enterDY: 0 },
                { polygon: rectPolygon(edge, -bleed, width - edge * 2, height + bleed * 2), tone: palette.tone4, enterDX: 0, enterDY: -height * 0.3 },
                { polygon: rectPolygon(width - edge, -bleed, edge + bleed, height + bleed * 2), tone: palette.tone1, enterDX: width * 0.3, enterDY: 0 }
            ];
        },
        'thirds-stack': (ctx) => {
            const { width, height, palette, bleed } = ctx;
            const band = height / 3;
            return [
                { polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, band + bleed), tone: palette.tone2, enterDX: -width * 0.25, enterDY: 0 },
                { polygon: rectPolygon(-bleed, band, width + bleed * 2, band), tone: palette.tone4, enterDX: width * 0.25, enterDY: 0 },
                { polygon: rectPolygon(-bleed, band * 2, width + bleed * 2, height - band * 2 + bleed), tone: palette.tone1, enterDX: -width * 0.25, enterDY: 0 }
            ];
        },
        'poster-panel': (ctx) => {
            const { width, height, palette, bleed } = ctx;
            return [
                { polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2), tone: palette.tone1, enterDX: 0, enterDY: 0 },
                { polygon: rectPolygon(width * 0.1, height * 0.12, width * 0.8, height * 0.76), tone: palette.tone3, enterDX: width * 0.3, enterDY: 0 }
            ];
        }
    };

    const SHOT_KINDS = Object.keys(COMPOSITIONS);

    // Pixi 渲染器实现
    class TemperaPixiDirector {
        constructor(container) {
            this.container = container;
            this.app = null;
            this.sceneContainer = null;
            this.blocksContainer = null;
            this.hatchContainer = null;
            this.decorContainer = null;
            this.textContainer = null;
            this.trackContainer = null;
            this.editorialTrack = null;
            this.words = [];
            this.width = 1;
            this.height = 1;
            this.initialized = false;
            this.activeKind = 'duo-split';
            this.shotSeed = 0;
            this.palette = null;
            this.destroyed = false;
            this.pendingShot = null;
            this.postProcess = null;
            this.performance = Effects.createPerformance();
            this.phrases = [];
            this.accents = null;
        }

        async init() {
            if (this.initialized || this.destroyed) return;
            const PIXI = global.PIXI;
            if (!PIXI) throw new Error('PIXI is not loaded');

            const application = new PIXI.Application();
            this.app = application;
            await application.init({
                backgroundAlpha: 0,
                preference: 'webgl',
                autoStart: false,
                antialias: true,
                resolution: Math.min(2, global.devicePixelRatio || 1),
                autoDensity: true
            });

            if (this.destroyed || this.app !== application) {
                // destroy() may have already released this application while
                // init was pending. PIXI destruction is not guaranteed to be
                // safely repeatable, so only dispose it here while still owned.
                if (this.app === application) {
                    application.destroy(true, { children: true });
                    this.app = null;
                }
                return;
            }
            this.app.stop();
            this.container.appendChild(this.app.canvas);
            this.app.canvas.className = 'tempera-pixi-canvas';
            this.app.canvas.style.position = 'absolute';
            this.app.canvas.style.inset = '0';
            this.app.canvas.style.pointerEvents = 'none';

            this.sceneContainer = new PIXI.Container();
            this.blocksContainer = new PIXI.Container();
            this.hatchContainer = new PIXI.Container();
            this.decorContainer = new PIXI.Container();
            this.textContainer = new PIXI.Container();
            this.trackContainer = new PIXI.Container();

            this.sceneContainer.addChild(this.blocksContainer);
            this.sceneContainer.addChild(this.hatchContainer);
            this.sceneContainer.addChild(this.decorContainer);
            this.sceneContainer.addChild(this.textContainer);
            this.sceneContainer.addChild(this.trackContainer);
            this.editorialTrack = Effects.createEditorialTrack(PIXI, this.trackContainer, 'tempera');
            this.app.stage.addChild(this.sceneContainer);

            this.postProcess = Effects.createPostProcess(PIXI, this.app.stage);
            this.retirement = Effects.createRetirement(PIXI, this.app.stage);
            this.initialized = true;
            this.resize();
            if (this.pendingShot) this.buildShot(...this.pendingShot);
        }

        resize() {
            if (!this.initialized || !this.app) return;
            const width = Math.max(1, this.container.clientWidth);
            const height = Math.max(1, this.container.clientHeight);
            if (width === this.width && height === this.height) return;
            this.width = width;
            this.height = height;
            this.app.renderer.resize(width, height);
            if (this.pendingShot) this.buildShot(...this.pendingShot);
        }

        resolvePalette(accentColor, colorMode = 'duo', theme = {}) {
            const accent = accentColor || { r: 121, g: 216, b: 255 };
            const hexAccent = `rgb(${accent.r}, ${accent.g}, ${accent.b})`;
            const paper = theme.background || '#171a1d';
            const surface = theme.surface || '#20252a';
            const ink = theme.ink || '#f2f0e9';
            const primary = colorMode === 'mono' ? ink : hexAccent;
            const secondary = colorMode === 'mono' ? ink : theme.secondary || primary;
            // Keep all panels on the background side of the palette so that
            // one foreground remains readable throughout moving split shots.
            return {
                tone1: mixColors(paper, primary, 0.06),
                tone2: mixColors(surface, secondary, 0.12),
                tone3: mixColors(paper, primary, 0.18),
                tone4: surface,
                ink,
                paper,
                accent: primary
            };
        }

        buildShot(line, seed, accentColor, tuning = {}) {
            this.pendingShot = [line, seed, accentColor, tuning];
            if (!this.initialized || this.destroyed) return;
            this.cameraKind = Effects.shotKind(seed, tuning);
            const PIXI = global.PIXI;
            this.shotSeed = seed;
            const rand = global.MusicStageRuntime.seededRandom(`tempera:${seed}`);
            this.palette = this.resolvePalette(accentColor, tuning.colorMode, tuning.palette);
            const kindIndex = Math.floor(rand() * SHOT_KINDS.length);
            this.activeKind = SHOT_KINDS[kindIndex];

            this.retirement.capture([this.blocksContainer, this.hatchContainer, this.decorContainer], this.sceneContainer, line);
            // 1. 重建色块
            Effects.clear(this.blocksContainer);
            Effects.clear(this.hatchContainer);
            Effects.clear(this.decorContainer);

            const ctx = {
                width: this.width,
                height: this.height,
                palette: this.palette,
                bleed: 60,
                seedRandom: rand
            };

            const drawer = COMPOSITIONS[this.activeKind] || COMPOSITIONS['duo-split'];
            const panels = drawer(ctx);

            panels.forEach((panel, i) => {
                const g = new PIXI.Graphics();
                g.poly(panel.polygon).fill({ color: panel.tone, alpha: 0.94 });
                g.pivot.set(0, 0);
                g.position.set(0, 0);
                g.dataset = {
                    targetX: 0,
                    targetY: 0,
                    enterDX: panel.enterDX,
                    enterDY: panel.enterDY,
                    delay: i * 0.08
                };
                this.blocksContainer.addChild(g);

                // 2. 局部网点 Hatch
                if (i === 1 || i === panels.length - 1) {
                    const hg = new PIXI.Graphics();
                    const angle = (rand() - 0.5) * Math.PI * 0.5;
                    const lines = buildHatchLines(panel.polygon, angle, 14);
                    lines.forEach(l => hg.moveTo(l.x1, l.y1).lineTo(l.x2, l.y2));
                    hg.stroke({ color: this.palette.accent, width: 1.2, alpha: 0.45 });
                    const clip = new PIXI.Graphics().poly(panel.polygon).fill(0xffffff);
                    const wrapper = new PIXI.Container();
                    wrapper.addChild(hg, clip);
                    hg.mask = clip;
                    wrapper.dataset = { delay: i * 0.08 + 0.05, enterDX: panel.enterDX, enterDY: panel.enterDY, hatch: hg };
                    this.hatchContainer.addChild(wrapper);
                }
            });

            // 3. 装饰元素 (穿插斜线与标记)
            const dec = new PIXI.Graphics();
            dec.moveTo(-40, this.height * 0.3).lineTo(this.width + 40, this.height * 0.35);
            dec.moveTo(-40, this.height * 0.7).lineTo(this.width + 40, this.height * 0.65);
            dec.stroke({ color: this.palette.accent, width: 1.5, alpha: 0.6 });
            this.decorContainer.addChild(dec);

            // 4. 重建文字层
            Effects.clear(this.textContainer);
            this.words = [];

            this.words = Effects.buildLyrics(PIXI, this.textContainer, line, this.width, this.height, tuning, seed);
            this.numPrimary = PIXI.Color.shared.setValue(this.palette.accent).toNumber();
            this.phrases = Effects.buildPhraseStage(PIXI, this.textContainer, this.words, this.numPrimary);
            this.accents = Effects.createAccentChoreography(PIXI, this.textContainer, this.words,
                this.phrases, this.numPrimary, 'tempera', seed);
            if (tuning.lyricLayout !== 'editorial-track') {
                this.sceneContainer.pivot.set(this.width / 2, this.height / 2);
            }
        }

        update(frame, tuning = {}) {
            if (!this.initialized) return;

            tuning = { ...tuning, performanceMode: 'tempera',
                performance: this.performance.update(frame, tuning, this.words) };
            Effects.applyQuality(this.app, this.width, this.height, tuning.quality);
            const progress = clamp(frame.lineProgress || 0);
            const motion = Effects.motionScale(tuning);
            const elapsed = Math.max(0, frame.playbackTime - (frame.activeLine?.startTime || 0));
            const trackMode = tuning.lyricLayout === 'editorial-track';
            const trackSeed = frame.track?.path || frame.track?.title || 'tempera-track';
            const trackCamera = trackMode
                ? this.editorialTrack.update(frame, tuning, this.numPrimary || 0xffffff, trackSeed, this.width, this.height)
                : null;
            const camera = trackCamera || Effects.camera(frame, tuning, this.cameraKind, this.width, this.height, this.words);
            this.textContainer.visible = !trackMode;
            this.trackContainer.visible = trackMode;
            if (trackMode) {
                this.sceneContainer.pivot.set(camera.x, camera.y);
                this.sceneContainer.position.set(this.width / 2, this.height / 2);
            } else {
                this.sceneContainer.pivot.set(this.width / 2, this.height / 2);
                this.sceneContainer.position.set(camera.x, camera.y);
            }
            this.sceneContainer.scale.set(camera.scale);
            this.sceneContainer.rotation = camera.rotation;
            this.sceneContainer.alpha = trackMode ? 1 : Effects.transition(frame, tuning);
            const fixedOffsetX = trackMode ? camera.x - this.width / 2 : 0;
            const fixedOffsetY = trackMode ? camera.y - this.height / 2 : 0;
            this.blocksContainer.position.set(fixedOffsetX, fixedOffsetY);
            this.hatchContainer.position.set(fixedOffsetX, fixedOffsetY);

            // 2. 色块进场阻尼动画
            this.blocksContainer.children.forEach(b => {
                const d = b.dataset;
                if (!d) return;
                const enterProg = motion > 0 ? clamp((elapsed - d.delay) / 0.45) : 1;
                const ease = 1 - Math.pow(1 - enterProg, 3);
                const intensity = Effects.amount(tuning.performanceIntensity, 1.25) * motion;
                const phase = frame.playbackTime * 0.65 + d.delay * 13;
                const kick = tuning.performance.impact;
                b.position.set(
                    d.enterDX * (1 - ease) * motion + Math.sin(phase) * 14 * intensity + d.enterDX * kick * 0.07,
                    d.enterDY * (1 - ease) * motion + Math.cos(phase * 0.8) * 10 * intensity + d.enterDY * kick * 0.07
                );
                b.alpha = ease;
            });

            // 3. 网点进场
            this.hatchContainer.children.forEach(h => {
                const d = h.dataset;
                if (!d) return;
                const enterProg = motion > 0 ? clamp((elapsed - d.delay) / 0.5) : 1;
                const ease = 1 - Math.pow(1 - enterProg, 3);
                const intensity = Effects.amount(tuning.performanceIntensity, 1.25) * motion;
                h.position.set(d.enterDX * (1 - ease) * motion, d.enterDY * (1 - ease) * motion);
                d.hatch.position.set(
                    Math.sin(frame.playbackTime * 0.5 + d.delay) * 24 * intensity + tuning.performance.impact * 18,
                    Math.cos(frame.playbackTime * 0.35) * 16 * intensity
                );
                h.alpha = ease * (0.45 + tuning.performance.impact * 0.25);
            });

            this.decorContainer.position.set(
                fixedOffsetX + Math.sin(frame.playbackTime * 0.4) * 25 * motion,
                fixedOffsetY + Math.cos(frame.playbackTime * 0.32) * 18 * motion
            );
            if (!trackMode) {
                Effects.animateLyrics(this.words, frame, tuning, this.numPrimary);
                Effects.animatePhraseStage(this.phrases, frame, tuning, this.cameraKind);
                this.accents?.update(frame, tuning);
            }

            // 显隐开关
            this.blocksContainer.visible = tuning.showBlocks !== false;
            this.decorContainer.visible = tuning.showDecor !== false;
            this.hatchContainer.visible = tuning.showDecor !== false;
            this.retirement.update(frame, tuning);
            this.postProcess.update(frame, tuning, this.width, this.height);
            this.app.render();
        }

        getDebugSnapshot() {
            return { initialized: this.initialized, composition: this.activeKind, camera: this.cameraKind,
                glyphs: this.words.length, phrases: this.phrases.length,
                performance: this.performance.snapshot(), accents: this.accents?.snapshot(),
                ...this.editorialTrack?.snapshot(),
                resolution: this.app?.renderer?.resolution, ...this.retirement?.snapshot() };
        }

        destroy() {
            if (this.destroyed && !this.app) return;
            this.destroyed = true;
            this.pendingShot = null;
            this.performance.reset();
            this.words = [];
            this.phrases = [];
            this.accents = null;
            this.editorialTrack?.destroy();
            this.editorialTrack = null;
            this.retirement?.destroy();
            this.retirement = null;
            this.postProcess?.destroy();
            this.postProcess = null;
            // PIXI.Application may already own a renderer/canvas even when init()
            // rejected before `initialized` became true. Always destroy the
            // application object so failed or interrupted stage entries cannot
            // retain a WebGL context.
            if (this.app) {
                try {
                    this.app.destroy(true, { children: true });
                } catch (error) {
                    console.warn('[MusicStage:Tempera] PIXI cleanup failed:', error);
                }
                this.app = null;
            }
            this.sceneContainer = null;
            this.blocksContainer = null;
            this.hatchContainer = null;
            this.decorContainer = null;
            this.textContainer = null;
            this.trackContainer = null;
            this.container = null;
            this.initialized = false;
        }
    }

    global.TemperaPixiDirector = TemperaPixiDirector;
})(window);