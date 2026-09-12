(function (global) {
    'use strict';

    const clamp = (val, min = 0, max = 1) => Math.min(max, Math.max(min, val));
    const Effects = global.MusicStagePixiEffects;

    // 商籁 Pixi 动态图形与排版导演类
    class SonnetPixiDirector {
        constructor(container) {
            this.container = container;
            this.app = null;
            this.sceneContainer = null;
            this.frameDecorContainer = null;
            this.hudContainer = null;
            this.geoContainer = null;
            this.textContainer = null;
            this.trackContainer = null;
            this.editorialTrack = null;
            this.giantText = null;
            this.words = [];
            this.width = 1;
            this.height = 1;
            this.initialized = false;
            this.accent = { r: 121, g: 216, b: 255 };
            this.destroyed = false;
            this.pendingShot = null;
            this.postProcess = null;
            this.performance = Effects.createPerformance();
            this.phrases = [];
            this.accents = null;
            this.orbits = [];
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
                // The mode may be destroyed while initialization is awaiting
                // GPU setup. Avoid dereferencing or destroying an application
                // which the synchronous teardown path has already released.
                if (this.app === application) {
                    application.destroy(true, { children: true });
                    this.app = null;
                }
                return;
            }
            this.app.stop();
            this.container.appendChild(this.app.canvas);
            this.app.canvas.className = 'sonnet-pixi-canvas';
            this.app.canvas.style.position = 'absolute';
            this.app.canvas.style.inset = '0';
            this.app.canvas.style.pointerEvents = 'none';

            this.sceneContainer = new PIXI.Container();
            this.geoContainer = new PIXI.Container();
            this.hudContainer = new PIXI.Container();
            this.frameDecorContainer = new PIXI.Container();
            this.textContainer = new PIXI.Container();
            this.trackContainer = new PIXI.Container();

            this.sceneContainer.addChild(this.geoContainer);
            this.sceneContainer.addChild(this.hudContainer);
            this.sceneContainer.addChild(this.frameDecorContainer);
            this.sceneContainer.addChild(this.textContainer);
            this.sceneContainer.addChild(this.trackContainer);
            this.editorialTrack = Effects.createEditorialTrack(PIXI, this.trackContainer, 'sonnet');
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

        buildShot(line, seed, accentColor, tuning = {}) {
            this.pendingShot = [line, seed, accentColor, tuning];
            if (!this.initialized || this.destroyed) return;
            this.activeKind = Effects.shotKind(seed, tuning);
            const PIXI = global.PIXI;
            this.accent = accentColor || { r: 121, g: 216, b: 255 };
            const hexPrimary = `rgb(${this.accent.r}, ${this.accent.g}, ${this.accent.b})`;
            const numPrimary = PIXI.Color.shared.setValue(hexPrimary).toNumber();
            const rand = global.MusicStageRuntime.seededRandom(`sonnet:${seed}`);

            this.retirement.capture([this.hudContainer, this.frameDecorContainer], this.sceneContainer, line);
            // 1. 重建外层线框系统 (Frame Decor & Corner Brackets)
            Effects.clear(this.frameDecorContainer);
            const frame = new PIXI.Graphics();
            const padX = this.width * 0.08;
            const padY = this.height * 0.12;
            const fw = this.width - padX * 2;
            const fh = this.height - padY * 2;

            // 绘制精细虚线与角标
            const cornerSize = 24;
            // 4个角标
            frame.moveTo(padX, padY + cornerSize).lineTo(padX, padY).lineTo(padX + cornerSize, padY);
            frame.moveTo(padX + fw - cornerSize, padY).lineTo(padX + fw, padY).lineTo(padX + fw, padY + cornerSize);
            frame.moveTo(padX, padY + fh - cornerSize).lineTo(padX, padY + fh).lineTo(padX + cornerSize, padY + fh);
            frame.moveTo(padX + fw - cornerSize, padY + fh).lineTo(padX + fw, padY + fh).lineTo(padX + fw, padY + fh - cornerSize);
            frame.stroke({ color: numPrimary, width: 2, alpha: 0.65 });

            // 边框标尺刻度
            for (let x = padX + 40; x < padX + fw - 40; x += 30) {
                frame.moveTo(x, padY).lineTo(x, padY + (x % 90 === 0 ? 10 : 5));
                frame.moveTo(x, padY + fh).lineTo(x, padY + fh - (x % 90 === 0 ? 10 : 5));
            }
            frame.stroke({ color: numPrimary, width: 1, alpha: 0.35 });
            this.frameDecorContainer.addChild(frame);

            // 2. HUD 动态图形与雷达/几何中心
            Effects.clear(this.hudContainer);
            Effects.clear(this.geoContainer);
            this.giantText = null;

            this.orbits = [];
            const hud = new PIXI.Graphics();
            const cx = this.width * 0.5;
            const cy = this.height * 0.5;
            const radius = Math.min(this.width, this.height) * 0.38;

            // Independent local-space orbits, counter-rotating broken arcs and ticks.
            for (let i = 0; i < 5; i++) {
                const orbit = new PIXI.Graphics();
                const r = radius * (0.4 + i * 0.17);
                for (let segment = 0; segment < 6; segment++) {
                    const start = segment * Math.PI / 3 + i * 0.24;
                    orbit.arc(0, 0, r, start, start + Math.PI * (0.16 + i * 0.008));
                    orbit.stroke({ color: numPrimary, width: i % 2 ? 1 : 2, alpha: 0.22 });
                }
                for (let tick = 0; tick < 36; tick++) {
                    const a = tick * Math.PI / 18;
                    const outer = r + (tick % 3 ? 4 : 11);
                    orbit.moveTo(Math.cos(a) * r, Math.sin(a) * r)
                        .lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
                }
                orbit.stroke({ color: numPrimary, width: 1, alpha: 0.35 });
                orbit.circle(r, 0, 3).fill({ color: numPrimary, alpha: 0.8 });
                orbit.position.set(cx, cy);
                this.hudContainer.addChild(orbit);
                this.orbits.push(orbit);
            }

            // 十字交叉瞄准线
            hud.moveTo(cx - radius, cy).lineTo(cx + radius, cy);
            hud.moveTo(cx, cy - radius).lineTo(cx, cy + radius);
            hud.stroke({ color: numPrimary, width: 1, alpha: 0.25 });

            // 扇形扫描区
            hud.moveTo(cx, cy);
            hud.arc(cx, cy, radius * 0.8, 0, Math.PI / 3);
            hud.lineTo(cx, cy);
            hud.fill({ color: numPrimary, alpha: 0.08 });

            this.hudContainer.addChild(hud);

            // 3. 巨型装饰文字 (Giant Outline Text)
            if (this.giantText) {
                this.giantText.destroy();
                this.giantText = null;
            }
            const giantStr = line?.fullText ? global.MusicStageRuntime.splitGraphemes(line.fullText).slice(0, 8).join('') : 'SONNET';
            this.giantText = new PIXI.Text({
                text: giantStr,
                style: {
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                    fontSize: Math.min(180, this.width * 0.22),
                    fontWeight: '900',
                    fill: 'transparent',
                    stroke: { color: numPrimary, width: 2 },
                    alpha: 0.12
                }
            });
            this.giantText.alpha = 0.12;
            this.giantText.anchor.set(0.5);
            this.giantText.position.set(cx, cy - 20);
            this.geoContainer.addChild(this.giantText);

            // 4. 正文歌词文字排版与词组容器
            Effects.clear(this.textContainer);
            this.words = [];

            this.motif = Effects.buildMotif(PIXI, this.geoContainer, this.width, this.height, numPrimary, seed);
            this.motif.pivot.set(cx, cy);
            this.motif.position.set(cx, cy);
            this.words = Effects.buildLyrics(PIXI, this.textContainer, line, this.width, this.height, tuning, seed);
            this.numPrimary = numPrimary;
            this.phrases = Effects.buildPhraseStage(PIXI, this.textContainer, this.words, numPrimary);
            this.accents = Effects.createAccentChoreography(PIXI, this.textContainer, this.words,
                this.phrases, numPrimary, 'sonnet', seed);
            this.scan = hud;
            this.scan.pivot.set(cx, cy);
            this.scan.position.set(cx, cy);
            if (tuning.lyricLayout !== 'editorial-track') {
                this.sceneContainer.pivot.set(cx, cy);
            }
            this.hudContainer.pivot.set(cx, cy);
            this.hudContainer.position.set(cx, cy);
        }

        update(frame, tuning = {}) {
            if (!this.initialized) return;

            tuning = { ...tuning, performanceMode: 'sonnet',
                performance: this.performance.update(frame, tuning, this.words) };
            Effects.applyQuality(this.app, this.width, this.height, tuning.quality);
            const progress = clamp(frame.lineProgress || 0);
            const motion = Effects.motionScale(tuning);
            const bass = Number(frame.audio?.bass) || 0;
            const trackMode = tuning.lyricLayout === 'editorial-track';
            const trackSeed = frame.track?.path || frame.track?.title || 'sonnet-track';
            const trackCamera = trackMode
                ? this.editorialTrack.update(frame, tuning, this.numPrimary || 0xffffff, trackSeed, this.width, this.height)
                : null;
            const camera = trackCamera || Effects.camera(frame, tuning, this.activeKind, this.width, this.height, this.words);
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
            this.geoContainer.position.set(fixedOffsetX, fixedOffsetY);
            this.frameDecorContainer.position.set(fixedOffsetX, fixedOffsetY);
            this.hudContainer.position.set(this.width / 2 + fixedOffsetX, this.height / 2 + fixedOffsetY);

            const time = frame.playbackTime;
            const intensity = motion * Effects.amount(tuning.performanceIntensity, 1.25);
            const kick = tuning.performance.impact;
            this.orbits.forEach((orbit, index) => {
                orbit.visible = tuning.quality !== 'energy-saving' || index < 2;
                const direction = index % 2 ? -1 : 1;
                orbit.rotation = (time * (0.07 + index * 0.025) + kick * 0.15) * direction * intensity;
                orbit.scale.set(1 + kick * (0.025 + index * 0.015) * intensity);
                orbit.alpha = 0.55 + tuning.performance.energy * 0.35;
            });
            this.scan.rotation = time * 0.32 * intensity;
            this.motif.rotation = -time * 0.035 * intensity;
            this.motif.scale.set(1 + Math.sin(time * 0.6) * 0.025 * intensity);
            this.frameDecorContainer.scale.set(1 + kick * 0.008 * intensity);
            if (this.giantText) {
                this.giantText.scale.set(1 + tuning.performance.energy * 0.06 * intensity);
                this.giantText.position.set(this.width * 0.5 + Math.sin(time * 0.14) * this.width * 0.12 * intensity,
                    this.height * 0.5 - 20 + Math.cos(time * 0.19) * 18 * intensity);
                this.giantText.rotation = Math.sin(time * 0.12) * 0.035 * intensity;
            }

            if (!trackMode) {
                Effects.animateLyrics(this.words, frame, tuning, this.numPrimary);
                Effects.animatePhraseStage(this.phrases, frame, tuning, this.activeKind);
                this.accents?.update(frame, tuning);
            }

            // 4. 图层开关
            this.hudContainer.visible = tuning.showBackground !== false && tuning.guideLines !== false;
            this.frameDecorContainer.visible = tuning.showDecor !== false;
            this.geoContainer.visible = tuning.showBackground !== false;
            this.retirement.update(frame, tuning);
            this.postProcess.update(frame, tuning, this.width, this.height);
            this.app.render();
        }

        getDebugSnapshot() {
            return { initialized: this.initialized, camera: this.activeKind,
                glyphs: this.words.length, phrases: this.phrases.length, orbits: this.orbits.length,
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
            this.orbits = [];
            this.accents = null;
            this.editorialTrack?.destroy();
            this.editorialTrack = null;
            this.motif = this.scan = this.giantText = null;
            this.retirement?.destroy();
            this.retirement = null;
            this.postProcess?.destroy();
            this.postProcess = null;
            // A rejected or interrupted init can allocate the renderer before
            // `initialized` is set. Destroy any existing application regardless
            // of that flag to release its WebGL context and canvas references.
            if (this.app) {
                try {
                    this.app.destroy(true, { children: true });
                } catch (error) {
                    console.warn('[MusicStage:Sonnet] PIXI cleanup failed:', error);
                }
                this.app = null;
            }
            this.sceneContainer = null;
            this.frameDecorContainer = null;
            this.hudContainer = null;
            this.geoContainer = null;
            this.textContainer = null;
            this.trackContainer = null;
            this.container = null;
            this.initialized = false;
        }
    }

    global.SonnetPixiDirector = SonnetPixiDirector;
})(window);