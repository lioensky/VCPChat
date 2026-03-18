// Musicmodules/music-visualizer.js
// 频谱可视化器 + WebSocket 连接

function setupVisualizer(app) {
    // --- Particle Class ---
    class Particle {
        constructor(x, y) {
            this.x = x;
            this.y = y;
            this.targetY = y;
            this.vy = 0;
            this.size = 1.1;
            this.spring = 0.08;
            this.friction = 0.85;
        }

        update() {
            const dy = this.targetY - this.y;
            const ay = dy * this.spring;
            this.vy += ay;
            this.vy *= this.friction;
            this.y += this.vy;
        }
    }

    app.recreateParticles = () => {
        app.particles.length = 0;
        if (app.visualizerCanvas.width > 0) {
            for (let i = 0; i < app.PARTICLE_COUNT; i++) {
                const x = app.visualizerCanvas.width * (i / (app.PARTICLE_COUNT - 1));
                app.particles.push(new Particle(x, app.visualizerCanvas.height - 10));
            }
        }
    };

    // --- Vocal Visualizer ---
    app.vocalCanvas = document.getElementById('vocal-visualizer');
    if (app.vocalCanvas) {
        app.vocalCtx = app.vocalCanvas.getContext('2d');
        app.vocalWaves = [
            { alpha: 0.1, speed: 0.05, frequency: 0.015, amplitude: 5, phase: 0 },
            { alpha: 0.2, speed: 0.08, frequency: 0.02, amplitude: 8, phase: 2 },
            { alpha: 0.4, speed: 0.12, frequency: 0.025, amplitude: 12, phase: 4 },
            { alpha: 0.6, speed: 0.15, frequency: 0.03, amplitude: 15, phase: 6 }
        ];
    }

    app.drawVocalVisualizer = () => {
        if (!app.vocalCanvas || !app.vocalCtx || app.currentVisualizerData.length === 0) return;

        const ctx = app.vocalCtx;
        const canvas = app.vocalCanvas;
        const data = app.currentVisualizerData;

        // Resize canvas if needed
        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 提取人声范围能量 (约 300Hz - 3400Hz)
        const startBin = Math.floor(300 / 21.5);
        const endBin = Math.floor(3400 / 21.5);
        let vocalEnergy = 0;
        const actualEnd = Math.min(endBin, data.length);
        for (let i = startBin; i < actualEnd; i++) {
            vocalEnergy += data[i];
        }
        vocalEnergy = (vocalEnergy / (actualEnd - startBin)) || 0;

        // 缓动处理人声能量
        if (app.smoothedVocalEnergy === undefined) app.smoothedVocalEnergy = 0;
        app.smoothedVocalEnergy += (vocalEnergy - app.smoothedVocalEnergy) * 0.15;

        const centerY = canvas.height / 2;
        const time = Date.now();
        const { r, g, b } = app.visualizerColor;

        app.vocalWaves.forEach((wave, i) => {
            ctx.beginPath();
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${wave.alpha})`;
            ctx.lineWidth = 1.5;

            for (let x = 0; x <= canvas.width; x += 2) {
                const edgeFade = Math.pow(Math.sin((x / canvas.width) * Math.PI), 2);
                const y = centerY + Math.sin(x * wave.frequency + time * wave.speed * 0.01 + wave.phase) 
                          * (wave.amplitude + app.smoothedVocalEnergy * 35) 
                          * edgeFade;


                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        });
    };

    // --- WebSocket for Visualization ---
    app.connectWebSocket = () => {
        app.ws = new WebSocket("ws://127.0.0.1:63789/ws");

        app.ws.onopen = () => {
            console.log('[Music.js] Connected to Rust Audio Engine via WebSocket.');
            if (!app.animationFrameId) {
                app.startVisualizerAnimation();
            }
        };

        app.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'spectrum_data') {
                    if (app.isPlaying) {
                        app.targetVisualizerData = message.data;
                        if (app.currentVisualizerData.length === 0) {
                            app.currentVisualizerData = Array(app.targetVisualizerData.length).fill(0);
                        }
                    }
                } else if (message.type === 'needs_preload') {
                    console.log('[Music.js] Received needs_preload event, remaining:', message.remaining_secs?.toFixed(1), 's');
                    app.handleNeedsPreload();
                }
            } catch (e) {
                console.error('[Music.js] Failed to parse WebSocket message:', e);
            }
        };

        app.ws.onclose = () => {
            setTimeout(app.connectWebSocket, 5000);
        };

        app.ws.onerror = (err) => {
            console.error('[Music.js] WebSocket error:', err);
            app.ws.close();
        };
    };

    app.drawVisualizer = (data) => {
        app.visualizerCtx.clearRect(0, 0, app.visualizerCanvas.width, app.visualizerCanvas.height);

        const bufferLength = data.length;
        if (bufferLength === 0) return;

        const gradient = app.visualizerCtx.createLinearGradient(0, 0, 0, app.visualizerCanvas.height);
        const { r, g, b } = app.visualizerColor;
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.85)`);
        gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.4)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.05)`);

        app.visualizerCtx.fillStyle = gradient;
        app.visualizerCtx.strokeStyle = gradient;
        app.visualizerCtx.lineWidth = 2;

        app.visualizerCtx.beginPath();
        app.visualizerCtx.moveTo(0, app.visualizerCanvas.height);

        const sliceWidth = app.visualizerCanvas.width / (bufferLength - 1);

        const getPoint = (index) => {
            const value = data[index] || 0;
            const x = index * sliceWidth;
            const y = app.visualizerCanvas.height - (value * app.visualizerCanvas.height * 1.2);
            return [x, y];
        };

        for (let i = 0; i < bufferLength - 1; i++) {
            const [x1, y1] = getPoint(i);
            const [x2, y2] = getPoint(i + 1);
            const [prev_x, prev_y] = i > 0 ? getPoint(i - 1) : [x1, y1];
            const [next_x, next_y] = i < bufferLength - 2 ? getPoint(i + 2) : [x2, y2];

            const tension = 0.5;
            const cp1_x = x1 + (x2 - prev_x) / 6 * tension;
            const cp1_y = y1 + (y2 - prev_y) / 6 * tension;
            const cp2_x = x2 - (next_x - x1) / 6 * tension;
            const cp2_y = y2 - (next_y - y1) / 6 * tension;

            if (i === 0) {
                app.visualizerCtx.lineTo(x1, y1);
            }
            app.visualizerCtx.bezierCurveTo(cp1_x, cp1_y, cp2_x, cp2_y, x2, y2);
        }

        app.visualizerCtx.lineTo(app.visualizerCanvas.width, app.visualizerCanvas.height);
        app.visualizerCtx.closePath();
        app.visualizerCtx.fill();
    };

    app.startVisualizerAnimation = () => {
        const draw = () => {
            if (app.isPlaying) {
                app.animateLyrics();
            }

            // --- Bass Animation Logic ---
            if (app.isPlaying && app.currentVisualizerData.length > 0 && app.albumArtWrapper) {
                const bassBinCount = Math.floor(app.currentVisualizerData.length * 0.05);
                let bassEnergy = 0;
                for (let i = 0; i < bassBinCount; i++) {
                    bassEnergy += app.currentVisualizerData[i];
                }
                bassEnergy /= bassBinCount;

                if (bassEnergy > app.BASS_THRESHOLD && app.bassScale < app.BASS_BOOST) {
                    app.bassScale = app.BASS_BOOST;
                } else {
                    app.bassScale = Math.max(1.0, app.bassScale * app.BASS_DECAY);
                }
                app.albumArtWrapper.style.transform = `scale(${app.bassScale})`;
            }

            if (app.targetVisualizerData.length === 0) {
                app.visualizerCtx.clearRect(0, 0, app.visualizerCanvas.width, app.visualizerCanvas.height);
                app.animationFrameId = requestAnimationFrame(draw);
                return;
            }

            // 缓动更新
            for (let i = 0; i < app.targetVisualizerData.length; i++) {
                if (app.currentVisualizerData[i] === undefined) {
                    app.currentVisualizerData[i] = 0;
                }
                app.currentVisualizerData[i] += (app.targetVisualizerData[i] - app.currentVisualizerData[i]) * app.easingFactor;
            }

            app.drawVisualizer(app.currentVisualizerData);
            app.drawVocalVisualizer();

            // 更新粒子
            app.particles.forEach(p => {
                const positionRatio = p.x / app.visualizerCanvas.width;
                const dataIndexFloat = positionRatio * (app.currentVisualizerData.length - 1);
                const index1 = Math.floor(dataIndexFloat);
                const index2 = Math.min(index1 + 1, app.currentVisualizerData.length - 1);

                const value1 = app.currentVisualizerData[index1] || 0;
                const value2 = app.currentVisualizerData[index2] || 0;
                const fraction = dataIndexFloat - index1;
                const interpolatedValue = value1 + (value2 - value1) * fraction;

                const spectrumY = app.visualizerCanvas.height - (interpolatedValue * app.visualizerCanvas.height * 1.2);
                p.targetY = spectrumY - 6;
                p.update();
            });

            // 绘制粒子曲线
            if (app.particles.length > 1) {
                app.visualizerCtx.beginPath();
                app.visualizerCtx.moveTo(app.particles[0].x, app.particles[0].y);

                for (let i = 0; i < app.particles.length - 2; i++) {
                    const p1 = app.particles[i];
                    const p2 = app.particles[i + 1];
                    const xc = (p1.x + p2.x) / 2;
                    const yc = (p1.y + p2.y) / 2;
                    app.visualizerCtx.quadraticCurveTo(p1.x, p1.y, xc, yc);
                }

                const secondLast = app.particles[app.particles.length - 2];
                const last = app.particles[app.particles.length - 1];
                app.visualizerCtx.quadraticCurveTo(secondLast.x, secondLast.y, last.x, last.y);

                const { r, g, b } = app.visualizerColor;
                app.visualizerCtx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
                app.visualizerCtx.lineWidth = 1.5;
                app.visualizerCtx.lineJoin = 'round';
                app.visualizerCtx.lineCap = 'round';
                app.visualizerCtx.stroke();
            }

            app.animationFrameId = requestAnimationFrame(draw);
        };
        draw();
    };
}
