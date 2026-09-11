(function (global) {
    'use strict';

    // 核心几何与网点算法 (纯算法，无 DOM)
    const TAU = Math.PI * 2;
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
            this.words = [];
            this.width = 1;
            this.height = 1;
            this.initialized = false;
            this.activeKind = 'duo-split';
            this.shotSeed = 0;
            this.palette = null;
        }

        async init() {
            if (this.initialized) return;
            const PIXI = global.PIXI;
            if (!PIXI) throw new Error('PIXI is not loaded');

            this.app = new PIXI.Application();
            await this.app.init({
                backgroundAlpha: 0,
                resizeTo: this.container,
                antialias: true,
                resolution: Math.min(2, global.devicePixelRatio || 1),
                autoDensity: true
            });

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

            this.sceneContainer.addChild(this.blocksContainer);
            this.sceneContainer.addChild(this.hatchContainer);
            this.sceneContainer.addChild(this.decorContainer);
            this.sceneContainer.addChild(this.textContainer);
            this.app.stage.addChild(this.sceneContainer);

            this.initialized = true;
            this.resize();
        }

        resize() {
            if (!this.initialized || !this.app) return;
            this.width = Math.max(1, this.container.clientWidth);
            this.height = Math.max(1, this.container.clientHeight);
            this.app.renderer.resize(this.width, this.height);
        }

        resolvePalette(accentColor, colorMode = 'duo') {
            const PIXI = global.PIXI;
            const accent = accentColor || { r: 121, g: 216, b: 255 };
            const hexAccent = `rgb(${accent.r}, ${accent.g}, ${accent.b})`;
            
            if (colorMode === 'mono') {
                return {
                    tone1: '#111111',
                    tone2: '#333333',
                    tone3: '#666666',
                    tone4: '#f2f2f2',
                    ink: '#ffffff',
                    paper: '#000000',
                    accent: '#ffffff'
                };
            }

            return {
                tone1: mixColors('#10141a', hexAccent, 0.16),
                tone2: mixColors('#141d28', hexAccent, 0.38),
                tone3: mixColors('#1a2a3c', hexAccent, 0.68),
                tone4: '#ffffff',
                ink: '#ffffff',
                paper: '#080b10',
                accent: hexAccent
            };
        }

        buildShot(line, seed, accentColor, tuning = {}) {
            if (!this.initialized) return;
            const PIXI = global.PIXI;
            this.shotSeed = seed;
            const rand = global.MusicStageRuntime.seededRandom(`tempera:${seed}`);
            this.palette = this.resolvePalette(accentColor, tuning.colorMode);
            const kindIndex = Math.floor(rand() * SHOT_KINDS.length);
            this.activeKind = SHOT_KINDS[kindIndex];

            // 1. 重建色块
            this.blocksContainer.removeChildren();
            this.hatchContainer.removeChildren();
            this.decorContainer.removeChildren();

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
                    hg.dataset = { delay: i * 0.08 + 0.05, enterDX: panel.enterDX * 0.8, enterDY: panel.enterDY * 0.8 };
                    this.hatchContainer.addChild(hg);
                }
            });

            // 3. 装饰元素 (穿插斜线与标记)
            const dec = new PIXI.Graphics();
            dec.moveTo(-40, this.height * 0.3).lineTo(this.width + 40, this.height * 0.35);
            dec.moveTo(-40, this.height * 0.7).lineTo(this.width + 40, this.height * 0.65);
            dec.stroke({ color: this.palette.accent, width: 1.5, alpha: 0.6 });
            this.decorContainer.addChild(dec);

            // 4. 重建文字层
            this.textContainer.removeChildren();
            this.words = [];

            if (line && line.resolvedWords && line.resolvedWords.length) {
                const words = line.resolvedWords;
                const fontSize = Math.max(38, Math.min(76, Math.floor(this.width / Math.max(8, words.length * 1.5))));
                let cursorX = this.width * 0.1;
                const baselineY = this.height * 0.5;

                words.forEach((w, index) => {
                    const textNode = new PIXI.Text({
                        text: w.text,
                        style: {
                            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                            fontSize: fontSize,
                            fontWeight: '900',
                            fill: this.palette.ink,
                            letterSpacing: 2
                        }
                    });

                    textNode.anchor.set(0, 0.5);
                    textNode.position.set(cursorX, baselineY);
                    
                    // 单词初始偏移参数
                    const enterAngle = (rand() - 0.5) * 0.2;
                    textNode.dataset = {
                        baseX: cursorX,
                        baseY: baselineY,
                        startTime: w.startTime,
                        endTime: w.endTime,
                        angle: enterAngle
                    };

                    cursorX += textNode.width + fontSize * 0.12;
                    this.words.push(textNode);
                    this.textContainer.addChild(textNode);
                });

                // 整体文字容器居中微调
                const totalW = cursorX - this.width * 0.1;
                this.textContainer.position.set((this.width - totalW) / 2 - this.width * 0.1, 0);
            }
        }

        update(frame, tuning = {}) {
            if (!this.initialized) return;

            const progress = clamp(frame.lineProgress || 0);
            const cameraIntensity = Number(tuning.cameraIntensity) || 1;
            const vocal = Number(frame.audio?.vocal) || 0;
            const bass = Number(frame.audio?.bass) || 0;

            // 1. 镜头推进与微摆动
            const travel = (progress - 0.5) * -40 * cameraIntensity;
            const sway = Math.sin(progress * Math.PI) * -16 * cameraIntensity;
            const zoom = 1 + bass * 0.03 * cameraIntensity;
            this.sceneContainer.position.set(travel, sway);
            this.sceneContainer.scale.set(zoom);

            // 2. 色块进场阻尼动画
            this.blocksContainer.children.forEach(b => {
                const d = b.dataset;
                if (!d) return;
                const enterProg = clamp((progress - d.delay) / 0.35);
                const ease = 1 - Math.pow(1 - enterProg, 3);
                b.position.set(d.enterDX * (1 - ease), d.enterDY * (1 - ease));
                b.alpha = ease;
            });

            // 3. 网点进场
            this.hatchContainer.children.forEach(h => {
                const d = h.dataset;
                if (!d) return;
                const enterProg = clamp((progress - d.delay) / 0.4);
                const ease = 1 - Math.pow(1 - enterProg, 3);
                h.position.set(d.enterDX * (1 - ease), d.enterDY * (1 - ease));
                h.alpha = ease * 0.6;
            });

            // 4. 逐字动势与反色高亮
            const playback = frame.playbackTime || 0;
            this.words.forEach(wordNode => {
                const d = wordNode.dataset;
                if (!d) return;
                const wordProg = clamp((playback - d.startTime) / Math.max(0.001, d.endTime - d.startTime));
                
                if (playback < d.startTime) {
                    wordNode.alpha = 0.35;
                    wordNode.tint = 0x888888;
                    wordNode.scale.set(0.92);
                } else if (playback >= d.endTime) {
                    wordNode.alpha = 0.95;
                    wordNode.tint = 0xffffff;
                    wordNode.scale.set(1.0);
                } else {
                    // 活跃字跳动
                    wordNode.alpha = 1.0;
                    wordNode.tint = Number(global.PIXI.Color.shared.setValue(this.palette.accent).toNumber());
                    const bounce = Math.sin(wordProg * Math.PI) * 0.18;
                    wordNode.scale.set(1.0 + bounce);
                    wordNode.rotation = (wordProg - 0.5) * d.angle;
                }
            });

            // 显隐开关
            this.blocksContainer.visible = tuning.showBlocks !== false;
            this.decorContainer.visible = tuning.showDecor !== false;
            this.hatchContainer.visible = tuning.showDecor !== false;
        }

        destroy() {
            if (this.app) {
                this.app.destroy(true, { children: true });
                this.app = null;
            }
            this.initialized = false;
        }
    }

    global.TemperaPixiDirector = TemperaPixiDirector;
})(window);