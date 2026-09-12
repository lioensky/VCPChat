// Musicmodules/music-ambient-pixi.js
// 基于 Pixi.js v8 的硬件加速背景声纹：旋转扩散涟漪场（Expanding Ripple Waves）+ 响应式气泡系统

(function (global) {
    'use strict';

    const TAU = Math.PI * 2;
    const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));
    const lerp = (a, b, t) => a + (b - a) * t;

    // 极坐标闭合平滑采样 (首尾无缝镜像连续)
    function sampleSpectrumMirror(spectrum, ratio) {
        if (!spectrum || spectrum.length === 0) return 0;
        const folded = ratio <= 0.5 ? ratio * 2 : (1 - ratio) * 2;
        const indexFloat = folded * (spectrum.length - 1);
        const i1 = Math.floor(indexFloat);
        const i2 = Math.min(i1 + 1, spectrum.length - 1);
        const frac = indexFloat - i1;
        const v1 = spectrum[i1] || 0;
        const v2 = spectrum[i2] || 0;
        return v1 + (v2 - v1) * frac;
    }

    // 气泡微粒
    class AmbientBubble {
        constructor(x, y, vx, vy, radius, color, maxLife) {
            this.x = x;
            this.y = y;
            this.vx = vx;
            this.vy = vy;
            this.baseRadius = radius;
            this.radius = radius;
            this.color = color;
            this.alpha = 0;
            this.maxLife = maxLife;
            this.age = 0;
            this.wobblePhase = Math.random() * TAU;
            this.wobbleSpeed = 2 + Math.random() * 3;
            this.dead = false;
        }

        update(dt) {
            this.age += dt;
            if (this.age >= this.maxLife) {
                this.dead = true;
                return;
            }

            const progress = this.age / this.maxLife;
            if (progress < 0.2) {
                this.alpha = (progress / 0.2) * 0.85;
            } else {
                this.alpha = (1 - (progress - 0.2) / 0.8) * 0.85;
            }

            this.vx *= 0.97;
            this.vy *= 0.97;
            this.vy -= 0.18; // 水流浮力

            this.x += this.vx;
            this.y += this.vy;

            this.wobblePhase += this.wobbleSpeed * dt;
            this.x += Math.sin(this.wobblePhase) * 0.4;
        }
    }

    // 扩散涟漪波环定义
    class RippleRing {
        constructor(initialPhase, config) {
            this.phase = initialPhase; // 0.0 ~ 1.0
            this.baseSpeed = config.baseSpeed || 0.11;
            this.baseAngle = config.baseAngle || 0;
            this.spinSpeed = config.spinSpeed || 0.35; // 旋转弧度增量
            this.expandScale = config.expandScale || 2.2;
            this.peakOpacity = config.peakOpacity || 0.45;
            this.segments = config.segments || 64;
            this.bandOffset = config.bandOffset || 0;
            this.baseWidth = config.baseWidth || 1.8;
            this.colorType = config.colorType || 'primary'; // 'primary' | 'soft' | 'highlight'
        }

        advance(dt, energyFactor) {
            // 音频越澎湃，涟漪向外扩散速度略微加快
            const speed = this.baseSpeed * (1 + energyFactor * 0.6);
            this.phase = (this.phase + speed * dt) % 1.0;
        }

        getOpacity() {
            // 钟形包络：前 15% 迅速淡入，后 85% 逐渐扩散淡出
            if (this.phase < 0.15) {
                return (this.phase / 0.15) * this.peakOpacity;
            }
            return (1 - (this.phase - 0.15) / 0.85) * this.peakOpacity;
        }

        getCurrentScale() {
            // 缓动膨胀：起始 0.78，向外逐渐扩散到 expandScale
            const ease = 1 - Math.pow(1 - this.phase, 1.8);
            return lerp(0.78, this.expandScale, ease);
        }

        getCurrentRotation() {
            return this.baseAngle + this.spinSpeed * this.phase;
        }

        getCurrentLineWidth() {
            // 随着向外扩散，线宽由实变细，呈现水波衰减
            return Math.max(0.6, lerp(this.baseWidth, 0.7, this.phase));
        }
    }

    class AmbientPixiController {
        constructor(app, container) {
            this.app = app;
            this.container = container;
            this.pixiApp = null;
            this.stage = null;
            this.glowLayer = null;
            this.waveLayer = null;
            this.bubbleLayer = null;
            this.bubbles = [];
            this.maxBubbles = 75;
            this.lastKickEnergy = 0;
            this.kickCooldown = 0;
            this.width = 1;
            this.height = 1;
            this.initialized = false;
            this.destroyed = false;
            this.initPromise = null;

            // 平滑音频能量
            this.smoothBass = 0;
            this.smoothMid = 0;
            this.smoothHigh = 0;

            // 4 层循环错峰向外扩散的涟漪环
            this.rippleRings = [
                new RippleRing(0.00, {
                    baseSpeed: 0.10,
                    baseAngle: -0.25,
                    spinSpeed: 0.45,
                    expandScale: 1.85,
                    peakOpacity: 0.52,
                    segments: 64,
                    bandOffset: 0.00,
                    baseWidth: 2.2,
                    colorType: 'primary'
                }),
                new RippleRing(0.25, {
                    baseSpeed: 0.085,
                    baseAngle: 0.40,
                    spinSpeed: -0.55,
                    expandScale: 2.10,
                    peakOpacity: 0.42,
                    segments: 72,
                    bandOffset: 0.18,
                    baseWidth: 1.8,
                    colorType: 'soft'
                }),
                new RippleRing(0.50, {
                    baseSpeed: 0.075,
                    baseAngle: -0.60,
                    spinSpeed: 0.38,
                    expandScale: 2.35,
                    peakOpacity: 0.35,
                    segments: 80,
                    bandOffset: 0.36,
                    baseWidth: 1.5,
                    colorType: 'primary'
                }),
                new RippleRing(0.75, {
                    baseSpeed: 0.065,
                    baseAngle: 0.15,
                    spinSpeed: -0.42,
                    expandScale: 2.60,
                    peakOpacity: 0.28,
                    segments: 88,
                    bandOffset: 0.55,
                    baseWidth: 1.2,
                    colorType: 'soft'
                })
            ];
        }

        async init() {
            if (this.initialized || this.destroyed) return;
            if (this.initPromise) return this.initPromise;

            this.initPromise = (async () => {
                const PIXI = global.PIXI;
                if (!PIXI) {
                    console.warn('[AmbientPixi] PIXI.js is not loaded.');
                    return;
                }

                const pixiApp = new PIXI.Application();
                this.pixiApp = pixiApp;

                await pixiApp.init({
                    backgroundAlpha: 0,
                    preference: 'webgl',
                    autoStart: false,
                    antialias: true,
                    resolution: Math.min(1.5, global.devicePixelRatio || 1),
                    autoDensity: true
                });

                if (this.destroyed || this.pixiApp !== pixiApp) {
                    try { pixiApp.destroy(true, { children: true }); } catch (_) {}
                    return;
                }

                pixiApp.stop();
                const canvas = pixiApp.canvas;
                canvas.className = 'ambient-pixi-canvas';
                canvas.style.position = 'absolute';
                canvas.style.inset = '0';
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                canvas.style.pointerEvents = 'none';

                this.container.innerHTML = '';
                this.container.appendChild(canvas);

                this.stage = pixiApp.stage;

                this.glowLayer = new PIXI.Graphics();
                this.waveLayer = new PIXI.Graphics();
                this.bubbleLayer = new PIXI.Graphics();

                this.stage.addChild(this.glowLayer);
                this.stage.addChild(this.waveLayer);
                this.stage.addChild(this.bubbleLayer);

                this.initialized = true;
                this.resize();
            })();

            return this.initPromise;
        }

        resize() {
            if (!this.initialized || !this.pixiApp || this.destroyed) return;
            const w = Math.max(1, this.container.clientWidth);
            const h = Math.max(1, this.container.clientHeight);
            if (w === this.width && h === this.height) return;
            this.width = w;
            this.height = h;
            this.pixiApp.renderer.resize(w, h);
        }

        spawnBubbles(cx, cy, baseRadius, count, color) {
            for (let i = 0; i < count; i++) {
                if (this.bubbles.length >= this.maxBubbles) break;
                const angle = Math.random() * TAU;
                const dist = baseRadius * (0.85 + Math.random() * 0.45);
                const x = cx + Math.cos(angle) * dist;
                const y = cy + Math.sin(angle) * dist;

                // 伴随向外扩散初速度
                const speed = 1.2 + Math.random() * 2.8;
                const vx = Math.cos(angle) * speed + (Math.random() - 0.5) * 0.8;
                const vy = Math.sin(angle) * speed - (0.5 + Math.random() * 1.5);
                const radius = 2.5 + Math.random() * 6.5;
                const life = 1.3 + Math.random() * 1.8;

                this.bubbles.push(new AmbientBubble(x, y, vx, vy, radius, color, life));
            }
        }

        update(dt = 0.016) {
            if (!this.initialized || this.destroyed || !this.pixiApp) return;

            const app = this.app;
            const isPlaying = Boolean(app.isPlaying);
            const spectrum = app.currentVisualizerData || [];
            const hasAudio = spectrum.length > 0;

            // 1. 计算能量分段
            let bassEnergy = 0;
            let midEnergy = 0;
            let highEnergy = 0;

            if (hasAudio && isPlaying) {
                const len = spectrum.length;
                const bassEnd = Math.floor(len * 0.15);
                const midEnd = Math.floor(len * 0.55);

                for (let i = 0; i < bassEnd; i++) bassEnergy += spectrum[i] || 0;
                for (let i = bassEnd; i < midEnd; i++) midEnergy += spectrum[i] || 0;
                for (let i = midEnd; i < len; i++) highEnergy += spectrum[i] || 0;

                bassEnergy = (bassEnergy / Math.max(1, bassEnd)) * 1.4;
                midEnergy = (midEnergy / Math.max(1, midEnd - bassEnd)) * 1.3;
                highEnergy = (highEnergy / Math.max(1, len - midEnd)) * 1.2;
            }

            this.smoothBass = lerp(this.smoothBass, bassEnergy, 0.18);
            this.smoothMid = lerp(this.smoothMid, midEnergy, 0.14);
            this.smoothHigh = lerp(this.smoothHigh, highEnergy, 0.12);

            const idleBreath = Math.sin(Date.now() * 0.0012) * 0.035;
            const currentBass = isPlaying ? this.smoothBass : (0.05 + idleBreath);
            const currentMid = isPlaying ? this.smoothMid : 0.03;

            // 2. 颜色计算
            const { r, g, b } = app.visualizerColor || { r: 0, g: 195, b: 255 };
            const primaryColor = (r << 16) | (g << 8) | b;
            const softColor = (Math.min(255, r + 45) << 16) | (Math.min(255, g + 45) << 8) | Math.min(255, b + 45);

            // 3. 中心位置与基础尺寸
            const cx = this.width * 0.50;
            const cy = this.height * 0.50;
            const minDim = Math.min(this.width, this.height);
            const baseR = minDim * 0.26 * (1 + currentBass * 0.22);

            // 4. 起音爆发生成气泡
            this.kickCooldown -= dt;
            if (isPlaying && currentBass > 0.32 && (currentBass - this.lastKickEnergy > 0.08) && this.kickCooldown <= 0) {
                const bubbleCount = Math.min(10, Math.floor(4 + currentBass * 8));
                this.spawnBubbles(cx, cy, baseR, bubbleCount, softColor);
                this.kickCooldown = 0.18;
            }
            this.lastKickEnergy = currentBass;

            // 5. 绘制中心微光核 (Glow Core)
            this.glowLayer.clear();
            const glowR = baseR * (1.05 + currentBass * 0.35);
            const glowAlpha = clamp(0.06 + currentBass * 0.18, 0.04, 0.28);
            this.glowLayer.circle(cx, cy, glowR).fill({ color: primaryColor, alpha: glowAlpha });

            // 6. 核心：绘制一圈圈一边旋转一边扩散的声纹涟漪波 (Expanding Ripple Rings)
            this.waveLayer.clear();

            this.rippleRings.forEach((ring) => {
                ring.advance(dt, currentBass);

                const ringScale = ring.getCurrentScale();
                const ringAlpha = ring.getOpacity() * (isPlaying ? 1.0 : 0.45);
                const ringRotation = ring.getCurrentRotation();
                const strokeWidth = ring.getCurrentLineWidth();
                const ringRadius = baseR * ringScale;
                const ringColor = ring.colorType === 'soft' ? softColor : primaryColor;

                // 振幅随向外扩散略微舒展
                const waveAmp = minDim * (0.02 + currentBass * 0.09) * Math.sqrt(ringScale);
                const segments = ring.segments;
                const points = [];

                for (let i = 0; i <= segments; i++) {
                    const ratio = i / segments;
                    const theta = ratio * TAU + ringRotation;
                    // 结合频谱与平滑正弦扰动
                    const specVal = sampleSpectrumMirror(spectrum, (ratio + ring.bandOffset) % 1.0);
                    const organicSway = Math.sin(ratio * TAU * 3 + ring.phase * TAU) * 0.12;
                    const r = ringRadius + (specVal * 1.1 + organicSway) * waveAmp;

                    points.push({
                        x: cx + Math.cos(theta) * r,
                        y: cy + Math.sin(theta) * r
                    });
                }

                if (points.length > 2) {
                    this.waveLayer.moveTo(points[0].x, points[0].y);
                    for (let i = 0; i < points.length - 1; i++) {
                        const p0 = points[i];
                        const p1 = points[i + 1];
                        const mx = (p0.x + p1.x) * 0.5;
                        const my = (p0.y + p1.y) * 0.5;
                        this.waveLayer.quadraticCurveTo(p0.x, p0.y, mx, my);
                    }
                    const last = points[points.length - 1];
                    this.waveLayer.lineTo(last.x, last.y);
                    this.waveLayer.stroke({ color: ringColor, alpha: ringAlpha, width: strokeWidth });
                }
            });

            // 7. 更新与绘制气泡粒子
            this.bubbleLayer.clear();
            for (let i = this.bubbles.length - 1; i >= 0; i--) {
                const b = this.bubbles[i];
                b.update(dt);
                if (b.dead) {
                    this.bubbles.splice(i, 1);
                    continue;
                }

                this.bubbleLayer.circle(b.x, b.y, b.radius)
                    .stroke({ color: b.color, alpha: b.alpha * 0.75, width: 1.2 })
                    .fill({ color: b.color, alpha: b.alpha * 0.12 });

                const hlOffset = b.radius * 0.35;
                const hlRadius = Math.max(0.6, b.radius * 0.25);
                this.bubbleLayer.circle(b.x - hlOffset, b.y - hlOffset, hlRadius)
                    .fill({ color: 0xffffff, alpha: b.alpha * 0.85 });
            }

            this.pixiApp.render();
        }

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.initialized = false;
            this.bubbles = [];

            if (this.pixiApp) {
                try {
                    this.pixiApp.stop();
                    this.pixiApp.destroy(true, {
                        children: true,
                        texture: true,
                        context: true
                    });
                } catch (err) {
                    console.warn('[AmbientPixi] Error during PIXI destruction:', err);
                }
                this.pixiApp = null;
            }

            if (this.container) {
                this.container.innerHTML = '';
            }

            this.stage = null;
            this.waveLayer = null;
            this.bubbleLayer = null;
            this.glowLayer = null;
        }
    }

    function setupAmbientPixi(app) {
        const container = document.getElementById('ambient-wave-container');
        if (!container) return;

        app.ambientPixiController = null;

        app.createAmbientPixi = async () => {
            if (app.isStageActive) return;
            if (app.ambientPixiController && !app.ambientPixiController.destroyed) return;

            const controller = new AmbientPixiController(app, container);
            app.ambientPixiController = controller;
            await controller.init();
        };

        app.destroyAmbientPixi = () => {
            if (app.ambientPixiController) {
                app.ambientPixiController.destroy();
                app.ambientPixiController = null;
            }
        };

        app.updateAmbientPixi = (dt) => {
            if (app.isStageActive) return;
            app.ambientPixiController?.update(dt);
        };

        window.addEventListener('resize', () => {
            if (!app.isStageActive) {
                app.ambientPixiController?.resize();
            }
        });

        if (!app.isStageActive) {
            app.createAmbientPixi();
        }
    }

    global.setupAmbientPixi = setupAmbientPixi;
})(window);