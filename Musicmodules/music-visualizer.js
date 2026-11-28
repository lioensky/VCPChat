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

    const VOCAL_START_BIN = Math.floor(300 / 21.5);
    const VOCAL_END_BIN = Math.floor(3400 / 21.5);
    let vocalFadeWidth = 0;
    let vocalFade = null;
    let vocalSizeDirty = true;
    let vocalObsWidth = -1;
    let vocalObsHeight = -1;
    let vocalResizeObserver = null;
    let vocalR = -1, vocalG = -1, vocalB = -1;
    let vocalStrokeStyles = null;
    let gradH = -1, gradR = -1, gradG = -1, gradB = -1;
    let particleR = -1, particleG = -1, particleB = -1;
    let particleStrokeStyle = '';
    let lastCoverScaleQ = -1;

    const markVocalSizeDirty = () => {
        vocalSizeDirty = true;
        vocalObsWidth = -1;
        vocalObsHeight = -1;
    };
    if (app.vocalCanvas && typeof ResizeObserver === 'function') {
        try {
            vocalResizeObserver = new ResizeObserver((entries) => {
                const rect = entries?.[entries.length - 1]?.contentRect;
                if (rect && rect.width >= 0 && rect.height >= 0) {
                    vocalObsWidth = Math.round(rect.width);
                    vocalObsHeight = Math.round(rect.height);
                } else {
                    vocalObsWidth = -1;
                    vocalObsHeight = -1;
                }
                vocalSizeDirty = true;
            });
            vocalResizeObserver.observe(app.vocalCanvas);
        } catch (e) {
            vocalResizeObserver = null;
        }
    }

    app.drawVocalVisualizer = () => {
        if (!app.vocalCanvas || !app.vocalCtx || app.currentVisualizerData.length === 0) return;

        const ctx = app.vocalCtx;
        const canvas = app.vocalCanvas;
        const data = app.currentVisualizerData;

        // 仅在尺寸标记脏时同步画布像素：优先使用 ResizeObserver 提供的 contentRect，避免帧循环触发同步布局读取
        if (vocalSizeDirty) {
            const cw = vocalObsWidth >= 0 ? vocalObsWidth : canvas.clientWidth;
            const ch = vocalObsHeight >= 0 ? vocalObsHeight : canvas.clientHeight;
            if (cw > 0 && ch > 0) {
                if (canvas.width !== cw || canvas.height !== ch) {
                    canvas.width = cw;
                    canvas.height = ch;
                }
                vocalSizeDirty = false;
            } else if (canvas.width !== cw || canvas.height !== ch) {
                canvas.width = cw;
                canvas.height = ch;
            }
        }

        const w = canvas.width;
        const h = canvas.height;
        if (!w || !h) return;

        ctx.clearRect(0, 0, w, h);

        // 提取人声范围能量 (约 300Hz - 3400Hz)
        let vocalEnergy = 0;
        const actualEnd = Math.min(VOCAL_END_BIN, data.length);
        for (let i = VOCAL_START_BIN; i < actualEnd; i++) {
            vocalEnergy += data[i];
        }
        vocalEnergy = (vocalEnergy / (actualEnd - VOCAL_START_BIN)) || 0;

        // 缓动处理人声能量
        if (app.smoothedVocalEnergy === undefined) app.smoothedVocalEnergy = 0;
        app.smoothedVocalEnergy += (vocalEnergy - app.smoothedVocalEnergy) * 0.15;

        if (vocalFadeWidth !== w) {
            vocalFadeWidth = w;
            const steps = (w >> 1) + 1;
            vocalFade = new Float32Array(steps);
            const invW = Math.PI / w;
            for (let idx = 0; idx < steps; idx++) {
                const s = Math.sin(idx * 2 * invW);
                vocalFade[idx] = s * s;
            }
        }

        const centerY = h * 0.5;
        const time = Date.now();
        const { r, g, b } = app.visualizerColor;
        if (vocalR !== r || vocalG !== g || vocalB !== b || !vocalStrokeStyles) {
            vocalR = r; vocalG = g; vocalB = b;
            const wLen = app.vocalWaves.length;
            vocalStrokeStyles = new Array(wLen);
            for (let i = 0; i < wLen; i += 1) {
                vocalStrokeStyles[i] = `rgba(${r}, ${g}, ${b}, ${app.vocalWaves[i].alpha})`;
            }
        }
        const energyBoost = app.smoothedVocalEnergy * 35;
        ctx.lineWidth = 1.5;

        for (let wIdx = 0; wIdx < app.vocalWaves.length; wIdx++) {
            const wave = app.vocalWaves[wIdx];
            const amp = wave.amplitude + energyBoost;
            const step = wave.frequency * 2;
            const phaseOffset = time * wave.speed * 0.01 + wave.phase;
            // 和角递推替代每帧 ~2000 次 Math.sin 调用，波形精度一致
            let s = Math.sin(phaseOffset);
            let c = Math.cos(phaseOffset);
            const sd = Math.sin(step);
            const cd = Math.cos(step);
            ctx.beginPath();
            ctx.strokeStyle = vocalStrokeStyles[wIdx];

            for (let x = 0, idx = 0; x <= w; x += 2, idx++) {
                const y = centerY + s * amp * vocalFade[idx];
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                const ns = s * cd + c * sd;
                c = c * cd - s * sd;
                s = ns;
            }
            ctx.stroke();
        }
    };

    // --- WebSocket for Visualization ---
    app.visualizerDestroyed = false;
    app.visualizerReconnectTimer = null;

    app.connectWebSocket = () => {
        if (app.visualizerDestroyed) return;
        if (app.visualizerReconnectTimer) {
            clearTimeout(app.visualizerReconnectTimer);
            app.visualizerReconnectTimer = null;
        }
        if (app.ws && (
            app.ws.readyState === WebSocket.OPEN
            || app.ws.readyState === WebSocket.CONNECTING
        )) return;

        // 端口由主进程启动引擎时探测决定，地址经 getAudioEngineEndpoint 下发；拿不到时退回默认端口。
        const socket = new WebSocket(app.audioEngineWsUrl || "ws://127.0.0.1:63789/ws");
        app.ws = socket;
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
            if (app.visualizerDestroyed || app.ws !== socket) {
                socket.close();
                return;
            }
            console.log('[Music.js] Connected to Rust Audio Engine via WebSocket.');
            app.visualizerReconnectAttempts = 0;
            if (!app.animationFrameId) {
                app.startVisualizerAnimation();
            }
        };

        socket.onmessage = (event) => {
            if (app.visualizerDestroyed || app.ws !== socket) return;
            try {
                const message = typeof event.data === 'string'
                    ? JSON.parse(event.data)
                    : app.decodeEngineBinaryFrame(event.data);
                if (!message) return;
                if (message.type === 'hello') {
                    // 新引擎：频谱改收二进制帧，播放状态改收推送。
                    if (Array.isArray(message.features) && message.features.includes('spectrum_binary')) {
                        socket.send(JSON.stringify({ type: 'subscribe', spectrum: 'binary' }));
                    }
                    app.handleEngineHello?.(message);
                } else if (message.type === 'playback_state') {
                    app.handleEnginePlaybackState?.(message);
                } else if (message.type === 'spectrum_data') {
                    // 停着的时候只通知一次“没在播”，播放时按 40ms 节流（与主进程 musicGrooveBus 节流窗口对齐），避免 60Hz 冗余 IPC 序列化。
                    const grooving = app.isPlaying === true && !app.isTrackLoading;
                    const nowMs = performance.now();
                    if ((grooving && nowMs - (app._lastGrooveSentAt || 0) >= 40) || (!grooving && app._lastGroovePlaying !== false)) {
                        app._lastGroovePlaying = grooving;
                        app._lastGrooveSentAt = nowMs;
                        app.api?.publishMusicGroove?.(grooving ? {
                            playing: true,
                            trackKey: app.playlist?.[app.currentTrackIndex]?.path || '',
                            data: message.data
                        } : { playing: false });
                    }
                    if (app.isPlaying) {
                        if (!app.animationFrameId) app.wakeVisualizer();
                        app._visualizerIdle = false;
                        app.targetVisualizerData = message.data;
                        if (app.currentVisualizerData.length === 0) {
                            app.currentVisualizerData = Array(app.targetVisualizerData.length).fill(0);
                        }
                    }
                } else if (message.type === 'load_error' || message.type === 'load_complete' || message.type === 'loading_progress') {
                    app.handleEngineLoadEvent?.(message);
                } else if (message.type === 'needs_preload') {
                    console.log('[Music.js] Received needs_preload event, remaining:', message.remaining_secs?.toFixed(1), 's');
                    app.handleNeedsPreload();
                } else if (message.type === 'playback_ended') {
                    // 防护1：如果正在加载新曲目（手动切歌），则忽略此事件。
                    if (app.isTrackLoading) {
                        console.log('[Music.js] playback_ended ignored: track is currently loading');
                        return;
                    }
                    // 防护2：如果刚刚发生了 gapless 切歌（track_changed），则忽略此事件。
                    // 后端在 gapless 切歌时会同时设置 EVENT_TRACK_CHANGED 和 EVENT_PLAYBACK_ENDED
                    // 两个事件在同一 tick 中被发送，导致 track_changed 更新了 index 后，
                    // playback_ended 又错误地触发 nextTrack()。
                    if (app._gaplessJustSwitched) {
                        console.log('[Music.js] playback_ended ignored: gapless switch just occurred');
                        app._gaplessJustSwitched = false;
                        return;
                    }
                    // 停止轮询，防止 pollState 中的状态更新与 nextTrack 冲突（在 handlePlaybackEnded 里）
                    if (app.handlePlaybackEnded) app.handlePlaybackEnded('push');
                    else {
                        app.stopStatePolling();
                        app.isPlaying = false;
                        app.playPauseBtn.classList.remove('is-playing');
                        app.nextTrack();
                    }
                } else if (message.type === 'track_changed') {
                    console.log('[Music.js] Gapless track changed:', message.file_path);
                    // 设置 gapless 切歌标志，抑制紧随其后的 playback_ended 事件
                    app._gaplessJustSwitched = true;
                    app.endedHandledForLoad = null; // 无缝切过去的这首放完时也要能往下切
                    // 安全兜底：如果 playback_ended 没有紧跟着来，在一定时间后清除标志
                    clearTimeout(app._gaplessSwitchTimer);
                    app._gaplessSwitchTimer = setTimeout(() => {
                        app._gaplessJustSwitched = false;
                    }, 2000);
                    // 重置 preload 标志，允许新一轮预加载
                    app.isPreloadingNext = false;
                    app.syncTrackIndexByPath(message.file_path);
                }
            } catch (e) {
                console.error('[Music.js] Failed to parse WebSocket message:', e);
            }
        };

        socket.onclose = () => {
            if (app.ws === socket) {
                app.ws = null;
                if (app._lastGroovePlaying) {
                    app._lastGroovePlaying = false;
                    app.api?.publishMusicGroove?.({ playing: false });
                }
                app.handleEngineDisconnected?.();
            }
            if (app.visualizerDestroyed || app.visualizerReconnectTimer) return;
            // 切歌、播完这些事件都走这条连接（引擎会攒着，连上再发），断开期间一首歌放完就会静音到重连为止。
            // 所以先快后慢：0.5、1、2、4 秒，之后每 5 秒一次；连上就归零。
            const attempt = app.visualizerReconnectAttempts || 0;
            app.visualizerReconnectAttempts = attempt + 1;
            app.visualizerReconnectTimer = setTimeout(() => {
                app.visualizerReconnectTimer = null;
                app.connectWebSocket();
            }, Math.min(5000, 500 * 2 ** attempt));
        };

        socket.onerror = (err) => {
            if (!app.visualizerDestroyed) console.error('[Music.js] WebSocket error:', err);
            socket.close();
        };
    };

    // 引擎的二进制帧：[类型 u8][版本 u8][段数 u16 小端][段数 × f32 小端]，类型 1 是频谱。
    // 复用解码数组，避免 60Hz 频谱帧每秒新建 60 个数组（闭包自包含，兼容单测片段执行）。
    app.decodeEngineBinaryFrame = (() => {
        let buf = [];
        return (buffer) => {
            if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return null;
            const view = new DataView(buffer);
            const kind = view.getUint8(0);
            const version = view.getUint8(1);
            const count = view.getUint16(2, true);
            if (kind !== 1 || version !== 1 || buffer.byteLength < 4 + count * 4) return null;
            if (buf.length !== count) buf = new Array(count);
            for (let i = 0; i < count; i++) buf[i] = view.getFloat32(4 + i * 4, true);
            return { type: 'spectrum_data', data: buf };
        };
    })();

    app.destroyVisualizer = () => {
        if (app.visualizerDestroyed) return;
        app.visualizerDestroyed = true;
        if (app._lastGroovePlaying) {
            app._lastGroovePlaying = false;
            app.api?.publishMusicGroove?.({ playing: false });
        }
        if (app.visualizerReconnectTimer) {
            clearTimeout(app.visualizerReconnectTimer);
            app.visualizerReconnectTimer = null;
        }
        if (app._gaplessSwitchTimer) {
            clearTimeout(app._gaplessSwitchTimer);
            app._gaplessSwitchTimer = null;
        }
        if (app.animationFrameId) {
            cancelAnimationFrame(app.animationFrameId);
            app.animationFrameId = null;
        }
        app._visualizerWakeObserver?.disconnect();
        app._visualizerWakeObserver = null;
        vocalResizeObserver?.disconnect();
        vocalResizeObserver = null;
        if (app._visualizerWakeOnVisible) {
            document.removeEventListener('visibilitychange', app._visualizerWakeOnVisible);
            window.removeEventListener('resize', app._visualizerWakeOnVisible);
            app._visualizerWakeOnVisible = null;
        }
        const socket = app.ws;
        app.ws = null;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            try { socket.close(); } catch (error) {}
        }
        app.targetVisualizerData.length = 0;
        app.currentVisualizerData.length = 0;
        app.particles.length = 0;
        vocalFadeWidth = 0;
        vocalFade = null;
        gradH = -1;
        app._visualizerGradient = null;
        if (app.visualizerCanvas) app.visualizerCanvas.width = app.visualizerCanvas.height = 1;
        if (app.vocalCanvas) app.vocalCanvas.width = app.vocalCanvas.height = 1;
    };

    app.drawVisualizer = (data) => {
        const canvas = app.visualizerCanvas;
        const ctx = app.visualizerCtx;
        if (!canvas || !ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const bufferLength = data.length;
        if (bufferLength < 2 || !w || !h) return;

        // 渐变只和画布高度、主题色有关，不必每帧新建（整数比较避免 60fps 模板串分配）。
        const { r, g, b } = app.visualizerColor;
        if (gradH !== h || gradR !== r || gradG !== g || gradB !== b || !app._visualizerGradient) {
            const created = ctx.createLinearGradient(0, 0, 0, h);
            created.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.85)`);
            created.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.4)`);
            created.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.05)`);
            app._visualizerGradient = created;
            gradH = h; gradR = r; gradG = g; gradB = b;
        }
        const gradient = app._visualizerGradient;

        ctx.fillStyle = gradient;

        ctx.beginPath();
        ctx.moveTo(0, h);

        const sliceWidth = w / (bufferLength - 1);
        const scaleY = h * 1.2;
        const t6 = 0.5 / 6;
        const dxStep = sliceWidth * t6;
        const dxSpan = dxStep * 2;
        const lastIdx = bufferLength - 1;

        let y0 = h - (data[0] || 0) * scaleY;
        let y1 = y0;
        let y2 = h - (data[1] || 0) * scaleY;
        ctx.lineTo(0, y1);

        for (let i = 0; i < lastIdx; i++) {
            const x1 = i * sliceWidth;
            const x2 = (i + 1) * sliceWidth;
            const y3 = i < lastIdx - 1 ? h - (data[i + 2] || 0) * scaleY : y2;
            const cp1x = x1 + (i > 0 ? dxSpan : dxStep);
            const cp1y = y1 + (y2 - y0) * t6;
            const cp2x = x2 - (i < lastIdx - 1 ? dxSpan : dxStep);
            const cp2y = y2 - (y3 - y1) * t6;

            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
            y0 = y1;
            y1 = y2;
            y2 = y3;
        }

        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
    };

    // 这条循环该不该跑：
    // - 窗口不可见：不跑。
    // - 歌词舞台开着：舞台每一帧都是从这里驱动的（stageHost.updateFrame），要跑。
    // - 经典视图被档案页盖住：不跑。
    // - 正在播放：跑。暂停后只跑到频谱和封面落回静止为止。
    app.visualizerShouldRun = () => {
        if (app.visualizerDestroyed || document.hidden) return false;
        if (app.isStageActive && app.stageHost?.active) return true;
        if (document.body.classList.contains('music-archive-on')) return false;
        if (app.isPlaying) return true;
        if (performance.now() < (app._visualizerKeepUntil || 0)) return true; // 刚被叫醒：让背景把新状态画出来
        const settling = app.targetVisualizerData.length > 0 && !app._visualizerIdle;
        return settling || (Number.isFinite(app.bassScale) && app.bassScale !== 1.0);
    };
    // keepMs：暂停着也先画这么久（刚打开、换主题、改窗口大小后，背景要重画几帧才对）。
    app.wakeVisualizer = (keepMs = 0) => {
        if (keepMs > 0) app._visualizerKeepUntil = Math.max(app._visualizerKeepUntil || 0, performance.now() + keepMs);
        if (!app.animationFrameId && app.visualizerShouldRun()) app.startVisualizerAnimation();
    };
    app._visualizerKeepUntil = performance.now() + 2500;
    // 播放/暂停、进出舞台、档案页和经典视图互换以及主题/画质切换会改 body 的 class；忽略无关类名，避免暂停时空转 1.2 秒。
    if (!app._visualizerWakeObserver && typeof MutationObserver === 'function') {
        const wakeClassSig = () => {
            const cl = document.body.classList;
            return (cl.contains('music-archive-on') ? 1 : 0)
                | (cl.contains('music-stage-active') ? 2 : 0)
                | (cl.contains('music-playing') ? 4 : 0)
                | (cl.contains('light-theme') ? 8 : 0)
                | (cl.contains('music-reduce-motion') ? 16 : 0)
                | (cl.contains('music-fl-low') ? 32 : 0);
        };
        let lastWakeSig = wakeClassSig();
        app._visualizerWakeObserver = new MutationObserver(() => {
            const sig = wakeClassSig();
            if (sig === lastWakeSig) return;
            lastWakeSig = sig;
            markVocalSizeDirty();
            app.wakeVisualizer(1200);
        });
        app._visualizerWakeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        app._visualizerWakeOnVisible = () => { markVocalSizeDirty(); app.wakeVisualizer(400); };
        document.addEventListener('visibilitychange', app._visualizerWakeOnVisible);
        window.addEventListener('resize', app._visualizerWakeOnVisible);
    }

    app.startVisualizerAnimation = () => {
        if (app.visualizerDestroyed || app.animationFrameId) return;
        const draw = (timestamp) => {
            if (app.visualizerDestroyed) {
                app.animationFrameId = null;
                return;
            }
            // Pixi 的全局 system ticker（纹理回收、指针事件）自己会一直按满帧空转：
            // 停掉它的自驱动，改成跟着这里的真实帧走，页面静止时它也静止。
            const pixiTicker = window.PIXI?.Ticker?.system;
            if (pixiTicker?.started) { pixiTicker.autoStart = false; pixiTicker.stop(); }
            // 没有东西要画就整个停下，不再空排帧；wakeVisualizer 在状态变化时再把循环叫起来。
            if (!app.visualizerShouldRun()) {
                app.animationFrameId = null;
                return;
            }
            pixiTicker?.update(timestamp);
            const isStageActive = Boolean(app.isStageActive && app.stageHost?.active);

            if (app.isPlaying && !isStageActive) {
                app.animateLyrics();
            }

            // --- Cover Pulse Animation Logic ---
            // 沉浸舞台拥有自己的封面与音频响应，普通封面在舞台期间或降低动态时停止写入跳动缩放。
            const reduceMotion = Boolean(window.MusicMotion?.reduced?.() || document.body?.classList?.contains('music-reduce-motion'));
            if (!isStageActive && !reduceMotion && app.isPlaying && app.currentVisualizerData.length > 0 && app.albumArtWrapper) {
                const startBin = Math.max(0, Math.floor(app.currentVisualizerData.length * app.COVER_MID_START_RATIO));
                const endBin = Math.min(
                    app.currentVisualizerData.length,
                    Math.max(startBin + 1, Math.floor(app.currentVisualizerData.length * app.COVER_MID_END_RATIO))
                );
                let midEnergy = 0;

                for (let i = startBin; i < endBin; i++) {
                    midEnergy += app.currentVisualizerData[i] || 0;
                }

                midEnergy /= (endBin - startBin);

                const floor = app.COVER_PULSE_FLOOR ?? 0.22;
                const compressedEnergy = Math.max(0, midEnergy - floor) / Math.max(0.001, 1 - floor);
                const shapedEnergy = Math.min(1, Math.pow(compressedEnergy, 0.65));

                if (app.coverPulseEnergy === undefined) app.coverPulseEnergy = 0;
                app.coverPulseEnergy += (shapedEnergy - app.coverPulseEnergy) * app.COVER_PULSE_SMOOTHING;

                app.bassScale = 1 + Math.min(app.coverPulseEnergy, 1) * app.COVER_PULSE_INTENSITY;
                const scaleQ = Math.round(app.bassScale * 10000);
                if (scaleQ !== lastCoverScaleQ) {
                    lastCoverScaleQ = scaleQ;
                    app.albumArtWrapper.style.transform = `scale(${(scaleQ / 10000).toFixed(4)})`;
                }
            } else if (app.albumArtWrapper && app.bassScale !== 1.0) {
                app.coverPulseEnergy = 0;
                app.bassScale += (1.0 - app.bassScale) * 0.18;
                if (Math.abs(app.bassScale - 1.0) < 0.001) app.bassScale = 1.0;
                const scaleQ = app.bassScale === 1.0 ? 10000 : Math.round(app.bassScale * 10000);
                if (scaleQ !== lastCoverScaleQ) {
                    lastCoverScaleQ = scaleQ;
                    app.albumArtWrapper.style.transform = scaleQ === 10000 ? 'scale(1)' : `scale(${(scaleQ / 10000).toFixed(4)})`;
                }
            }

            if (app.targetVisualizerData.length === 0) {
                if (isStageActive) {
                    app.stageHost.updateFrame(timestamp);
                } else if (app.isPlaying) {
                    app.updateAmbientPixi?.(0.016);
                    app.visualizerCtx.clearRect(0, 0, app.visualizerCanvas.width, app.visualizerCanvas.height);
                } else {
                    // 还没收到过频谱（刚打开、没播过）：同样只按低帧率画背景，画布本来就是空的不用清。
                    app._ambientIdleFrame = ((app._ambientIdleFrame || 0) + 1) % 5;
                    if (app._ambientIdleFrame === 0) app.updateAmbientPixi?.(0.08);
                }
                app.animationFrameId = requestAnimationFrame(draw);
                return;
            }

            // 暂停后让频谱自然落回零，落稳之后不再每帧重画同一幅画面。
            const paused = !app.isPlaying;
            if (paused && app._visualizerIdle && !isStageActive) {
                // 暂停后背景只剩很慢的“呼吸”，每秒画十来次就够，不必让显卡按满帧重画整窗。
                app._ambientIdleFrame = ((app._ambientIdleFrame || 0) + 1) % 5;
                if (app._ambientIdleFrame === 0) app.updateAmbientPixi?.(0.08);
                app.animationFrameId = requestAnimationFrame(draw);
                return;
            }

            // 缓动更新
            let peak = 0;
            for (let i = 0; i < app.targetVisualizerData.length; i++) {
                if (app.currentVisualizerData[i] === undefined) {
                    app.currentVisualizerData[i] = 0;
                }
                if (paused) app.targetVisualizerData[i] *= 0.86;
                app.currentVisualizerData[i] += (app.targetVisualizerData[i] - app.currentVisualizerData[i]) * app.easingFactor;
                if (app.currentVisualizerData[i] > peak) peak = app.currentVisualizerData[i];
            }
            app._visualizerQuietFrames = paused && peak < 0.003 ? (app._visualizerQuietFrames || 0) + 1 : 0;
            // 多等半秒左右，让顶部的粒子曲线也回到基线。
            app._visualizerIdle = app._visualizerQuietFrames > 40;

            if (isStageActive) {
                app.stageHost.updateFrame(timestamp);
                if (!app._visualizerClearedForStage) {
                    app._visualizerClearedForStage = true;
                    app.visualizerCtx.clearRect(0, 0, app.visualizerCanvas.width, app.visualizerCanvas.height);
                }
                app.animationFrameId = requestAnimationFrame(draw);
                return;
            }
            app._visualizerClearedForStage = false;

            app.updateAmbientPixi?.(0.016);
            app.drawVisualizer(app.currentVisualizerData);
            app.drawVocalVisualizer();

            // 更新粒子
            const particles = app.particles;
            const pCount = particles.length;
            const visW = app.visualizerCanvas.width;
            const visH = app.visualizerCanvas.height;
            const curData = app.currentVisualizerData;
            const dataLast = curData.length - 1;
            if (pCount > 0 && visW > 0 && dataLast >= 0) {
                const invVisW = dataLast / visW;
                const scaleVisH = visH * 1.2;
                for (let i = 0; i < pCount; i++) {
                    const p = particles[i];
                    const dataIndexFloat = p.x * invVisW;
                    const index1 = Math.floor(dataIndexFloat);
                    const index2 = index1 < dataLast ? index1 + 1 : dataLast;

                    const value1 = curData[index1] || 0;
                    const value2 = curData[index2] || 0;
                    const interpolatedValue = value1 + (value2 - value1) * (dataIndexFloat - index1);

                    p.targetY = visH - (interpolatedValue * scaleVisH) - 6;
                    p.update();
                }
            }

            // 绘制粒子曲线
            if (pCount > 1) {
                const vctx = app.visualizerCtx;
                vctx.beginPath();
                vctx.moveTo(particles[0].x, particles[0].y);

                for (let i = 0; i < pCount - 2; i++) {
                    const p1 = particles[i];
                    const p2 = particles[i + 1];
                    vctx.quadraticCurveTo(p1.x, p1.y, (p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5);
                }

                const secondLast = particles[pCount - 2];
                const last = particles[pCount - 1];
                vctx.quadraticCurveTo(secondLast.x, secondLast.y, last.x, last.y);

                const { r, g, b } = app.visualizerColor;
                if (particleR !== r || particleG !== g || particleB !== b) {
                    particleR = r; particleG = g; particleB = b;
                    particleStrokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
                }
                vctx.strokeStyle = particleStrokeStyle;
                vctx.lineWidth = 1.5;
                vctx.lineJoin = 'round';
                vctx.lineCap = 'round';
                vctx.stroke();
            }

            app.animationFrameId = requestAnimationFrame(draw);
        };
        draw(performance.now());
    };
}
