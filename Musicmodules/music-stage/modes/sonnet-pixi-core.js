(function (global) {
    'use strict';

    const clamp = (val, min = 0, max = 1) => Math.min(max, Math.max(min, val));

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
            this.giantText = null;
            this.words = [];
            this.width = 1;
            this.height = 1;
            this.initialized = false;
            this.accent = { r: 121, g: 216, b: 255 };
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
            this.app.canvas.className = 'sonnet-pixi-canvas';
            this.app.canvas.style.position = 'absolute';
            this.app.canvas.style.inset = '0';
            this.app.canvas.style.pointerEvents = 'none';

            this.sceneContainer = new PIXI.Container();
            this.geoContainer = new PIXI.Container();
            this.hudContainer = new PIXI.Container();
            this.frameDecorContainer = new PIXI.Container();
            this.textContainer = new PIXI.Container();

            this.sceneContainer.addChild(this.geoContainer);
            this.sceneContainer.addChild(this.hudContainer);
            this.sceneContainer.addChild(this.frameDecorContainer);
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

        buildShot(line, seed, accentColor) {
            if (!this.initialized) return;
            const PIXI = global.PIXI;
            this.accent = accentColor || { r: 121, g: 216, b: 255 };
            const hexPrimary = `rgb(${this.accent.r}, ${this.accent.g}, ${this.accent.b})`;
            const numPrimary = PIXI.Color.shared.setValue(hexPrimary).toNumber();
            const rand = global.MusicStageRuntime.seededRandom(`sonnet:${seed}`);

            // 1. 重建外层线框系统 (Frame Decor & Corner Brackets)
            this.frameDecorContainer.removeChildren();
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
            this.hudContainer.removeChildren();
            this.geoContainer.removeChildren();

            const hud = new PIXI.Graphics();
            const cx = this.width * 0.5;
            const cy = this.height * 0.5;
            const radius = Math.min(this.width, this.height) * 0.38;

            // 几何光环与同心圆
            hud.circle(cx, cy, radius * 0.9).stroke({ color: numPrimary, width: 1.5, alpha: 0.25 });
            hud.circle(cx, cy, radius * 0.6).stroke({ color: numPrimary, width: 1, alpha: 0.2 });
            hud.circle(cx, cy, radius * 0.3).stroke({ color: numPrimary, width: 2, alpha: 0.3 });

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
            const giantStr = line?.fullText ? line.fullText.slice(0, 8) : 'SONNET';
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
            this.giantText.anchor.set(0.5);
            this.giantText.position.set(cx, cy - 20);
            this.geoContainer.addChild(this.giantText);

            // 4. 正文歌词文字排版与词组容器
            this.textContainer.removeChildren();
            this.words = [];

            if (line && line.resolvedWords && line.resolvedWords.length) {
                const words = line.resolvedWords;
                const fontSize = Math.max(34, Math.min(68, Math.floor(this.width / Math.max(8, words.length * 1.4))));
                let cursorX = 0;
                const textGroup = new PIXI.Container();

                words.forEach((w, index) => {
                    const textNode = new PIXI.Text({
                        text: w.text,
                        style: {
                            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                            fontSize: fontSize,
                            fontWeight: '800',
                            fill: '#ffffff',
                            letterSpacing: 1.5
                        }
                    });

                    textNode.anchor.set(0, 0.5);
                    textNode.position.set(cursorX, 0);
                    textNode.dataset = {
                        startTime: w.startTime,
                        endTime: w.endTime
                    };

                    cursorX += textNode.width + fontSize * 0.1;
                    this.words.push(textNode);
                    textGroup.addChild(textNode);
                });

                textGroup.position.set(cx - cursorX / 2, cy);
                this.textContainer.addChild(textGroup);
            }
        }

        update(frame, tuning = {}) {
            if (!this.initialized) return;

            const progress = clamp(frame.lineProgress || 0);
            const cameraIntensity = Number(tuning.cameraIntensity) || 1;
            const power = Number(frame.audio?.power) || 0;
            const bass = Number(frame.audio?.bass) || 0;

            // 1. 镜头推拉与 HUD 动态追踪 (Camera Tracking)
            const driftX = (progress - 0.5) * -35 * cameraIntensity;
            const driftY = Math.sin(progress * Math.PI) * -12 * cameraIntensity;
            const scale = 1.0 + power * 0.03 * cameraIntensity;

            this.sceneContainer.position.set(driftX, driftY);
            this.sceneContainer.scale.set(scale);

            // 2. HUD 旋转与脉冲
            if (this.hudContainer) {
                this.hudContainer.rotation = progress * 0.15;
            }
            if (this.giantText) {
                this.giantText.scale.set(1 + bass * 0.05);
            }

            // 3. 逐字高亮
            const playback = frame.playbackTime || 0;
            this.words.forEach(wordNode => {
                const d = wordNode.dataset;
                if (!d) return;

                if (playback < d.startTime) {
                    wordNode.alpha = 0.35;
                    wordNode.tint = 0x777777;
                } else if (playback >= d.endTime) {
                    wordNode.alpha = 0.9;
                    wordNode.tint = 0xdddddd;
                } else {
                    wordNode.alpha = 1.0;
                    wordNode.tint = Number(global.PIXI.Color.shared.setValue(this.accent).toNumber());
                    wordNode.scale.set(1.08);
                }
            });

            // 4. 图层开关
            this.hudContainer.visible = tuning.showBackground !== false;
            this.frameDecorContainer.visible = tuning.showDecor !== false;
            this.geoContainer.visible = tuning.showBackground !== false;
        }

        destroy() {
            if (this.app) {
                this.app.destroy(true, { children: true });
                this.app = null;
            }
            this.initialized = false;
        }
    }

    global.SonnetPixiDirector = SonnetPixiDirector;
})(window);