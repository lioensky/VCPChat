(function (global) {
    'use strict';

    const Runtime = global.MusicStageRuntime;
    const Modes = global.MusicStageModes;
    if (!Runtime || !Modes) throw new Error('Music stage runtime and modes must load before music-stage-host.js');

    const { clamp, DisposableScope } = Runtime;

    const fileUrl = (path) => path ? `file://${String(path).replace(/\\/g, '/')}` : '';

    const createElement = (tag, className, attributes = {}) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        Object.entries(attributes).forEach(([name, value]) => {
            if (name === 'text') element.textContent = value;
            else if (name === 'html') element.innerHTML = value;
            else if (value !== undefined && value !== null) element.setAttribute(name, String(value));
        });
        return element;
    };

    const icons = Object.freeze({
        previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.5 5.5v13L9 12l9.5-6.5ZM5 5h2v14H5z" fill="currentColor"/></svg>',
        next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5v13L15 12 5.5 5.5ZM17 5h2v14h-2z" fill="currentColor"/></svg>',
        play: '<svg class="stage-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5v14L19 12 7.5 5Z" fill="currentColor"/></svg>',
        pause: '<svg class="stage-pause-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6V5Zm8 0h4v14h-4V5Z" fill="currentColor"/></svg>',
        volume: '<svg class="stage-volume-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.2-.8a5.4 5.4 0 0 1 0 7.6M18.8 5.6a9 9 0 0 1 0 12.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        muted: '<svg class="stage-muted-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4m4.5-1.5 11 11m0-11-11 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 3 4 4-4 4M3 10V8a3 3 0 0 1 3-3h15M7 21l-4-4 4-4m14 1v2a3 3 0 0 1-3 3H3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        repeatOne: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 3 4 4-4 4M3 10V8a3 3 0 0 1 3-3h15M7 21l-4-4 4-4m14 1v2a3 3 0 0 1-3 3H3M11 10h2v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    });

    function setupMusicStage(app) {
        const root = document.getElementById('music-stage');
        const toggleButton = document.getElementById('stage-toggle-btn');
        if (!root || !toggleButton) {
            console.warn('[MusicStage] Required DOM was not found.');
            return;
        }

        const elements = {
            backdropCurrent: root.querySelector('.music-stage-backdrop-current'),
            backdropNext: root.querySelector('.music-stage-backdrop-next'),
            shade: root.querySelector('.music-stage-shade'),
            edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'),
            edgeCanvas: root.querySelector('.music-stage-edge-spectrum-canvas'),
            modeRoot: root.querySelector('.music-stage-mode-root'),
            modeSwitcher: root.querySelector('.music-stage-mode-switcher'),
            cover: root.querySelector('.music-stage-cover'),
            title: root.querySelector('.music-stage-track-title'),
            artist: root.querySelector('.music-stage-track-artist'),
            album: root.querySelector('.music-stage-track-album'),
            currentTime: root.querySelector('.music-stage-current-time'),
            duration: root.querySelector('.music-stage-duration'),
            progressTrack: root.querySelector('.music-stage-progress-track'),
            progressFill: root.querySelector('.music-stage-progress-fill'),
            playMode: root.querySelector('[data-stage-action="play-mode"]'),
            prev: root.querySelector('[data-stage-action="previous"]'),
            play: root.querySelector('[data-stage-action="toggle-play"]'),
            next: root.querySelector('[data-stage-action="next"]'),
            volumeButton: root.querySelector('[data-stage-action="toggle-mute"]'),
            volumeSlider: root.querySelector('.music-stage-volume-slider'),
            chrome: root.querySelector('.music-stage-chrome'),
            emptyNotice: root.querySelector('.music-stage-empty-notice')
        };

        const edgeContext = elements.edgeCanvas?.getContext('2d', { alpha: true });
        const prefersReducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const edgeCanvasState = {
            width: 0,
            height: 0,
            dpr: 1,
            top: new Float32Array(0),
            right: new Float32Array(0),
            bottom: new Float32Array(0),
            left: new Float32Array(0)
        };

        const scope = new DisposableScope();
        const state = {
            active: false,
            modeId: localStorage.getItem('musicStageMode') || 'luminous',
            modeInstance: null,
            generation: 0,
            trackPath: null,
            trackSignature: '',
            coverUrl: '',
            backgroundTimer: null,
            lastFrame: null,
            draggingProgress: false,
            lastTransportSignature: '',
            lastNonZeroVolume: Math.max(0.35, Number(app.volumeSlider?.value) || 1),
            destroyed: false,
            stats: {
                modeCreates: 0,
                modeDestroys: 0,
                frameUpdates: 0,
                modeSwitches: 0
            }
        };

        const setButtonState = () => {
            toggleButton.classList.toggle('is-active', state.active);
            toggleButton.setAttribute('aria-pressed', String(state.active));
            toggleButton.setAttribute('aria-label', state.active ? '退出歌词舞台' : '进入歌词舞台');
            toggleButton.title = state.active ? '退出歌词舞台 (Esc)' : '进入歌词舞台';
        };

        const destroyMode = () => {
            if (!state.modeInstance) return;
            state.modeInstance.destroy();
            state.modeInstance = null;
            state.stats.modeDestroys += 1;
        };

        const createMode = (modeId) => {
            destroyMode();
            state.generation += 1;
            state.modeId = Modes.get(modeId).id;
            state.modeInstance = Modes.create(state.modeId, elements.modeRoot, {
                app,
                generation: state.generation,
                isCurrentGeneration: (generation) => generation === state.generation && !state.destroyed
            });
            state.stats.modeCreates += 1;
            localStorage.setItem('musicStageMode', state.modeId);

            elements.modeSwitcher.querySelectorAll('[data-stage-mode]').forEach((button) => {
                const selected = button.dataset.stageMode === state.modeId;
                button.classList.toggle('is-active', selected);
                button.setAttribute('aria-pressed', String(selected));
            });

            if (state.lastFrame) state.modeInstance.updateFrame(state.lastFrame);
        };

        const renderModeButtons = () => {
            const fragment = document.createDocumentFragment();
            Modes.entries.forEach((entry) => {
                const button = createElement('button', 'music-stage-mode-button', {
                    type: 'button',
                    text: entry.label,
                    title: `切换至${entry.label}`,
                    'data-stage-mode': entry.id,
                    'aria-pressed': 'false'
                });
                fragment.appendChild(button);
            });
            elements.modeSwitcher.replaceChildren(fragment);
        };

        const updateBackdrop = (coverUrl) => {
            const nextUrl = coverUrl || '';
            if (nextUrl === state.coverUrl) return;
            state.coverUrl = nextUrl;
            const cssImage = nextUrl ? `url("${nextUrl.replace(/"/g, '\\"')}")` : 'none';

            if (state.backgroundTimer) {
                clearTimeout(state.backgroundTimer);
                state.backgroundTimer = null;
            }

            elements.backdropNext.style.backgroundImage = cssImage;
            root.classList.add('is-changing-cover');
            state.backgroundTimer = setTimeout(() => {
                elements.backdropCurrent.style.backgroundImage = cssImage;
                root.classList.remove('is-changing-cover');
                state.backgroundTimer = null;
            }, 850);
        };

        const updateTrack = (track) => {
            const title = app.stripAudioExtension?.(track?.title) || track?.title || '未选择歌曲';
            const artist = track?.artist || '未知艺术家';
            const album = track?.album || '';
            const coverUrl = fileUrl(track?.albumArt);
            const identity = track?.path || `${title}\u0001${artist}`;
            const signature = `${identity}\u0001${title}\u0001${artist}\u0001${album}\u0001${coverUrl}\u0001${app.currentTheme}`;
            if (signature === state.trackSignature) return;
            state.trackSignature = signature;

            if (identity !== state.trackPath) {
                state.trackPath = identity;
                elements.title.classList.remove('is-changing');
                void elements.title.offsetWidth;
                elements.title.classList.add('is-changing');
            }

            elements.title.textContent = title;
            elements.artist.textContent = artist;
            elements.album.textContent = album;
            elements.album.hidden = !album;
            elements.cover.setAttribute('aria-label', `${title} 的封面`);
            elements.cover.style.backgroundImage = coverUrl
                ? `url("${coverUrl.replace(/"/g, '\\"')}")`
                : `url("../assets/${app.currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}")`;
            updateBackdrop(coverUrl);
            elements.emptyNotice.hidden = Boolean(track);
        };

        const updateProgress = (frame) => {
            const percent = frame.duration > 0 ? clamp(frame.playbackTime / frame.duration) * 100 : 0;
            elements.progressFill.style.width = `${percent.toFixed(3)}%`;
            elements.progressTrack.querySelector('.music-stage-progress-glow').style.width = `${percent.toFixed(3)}%`;
            elements.currentTime.textContent = app.formatTime?.(frame.playbackTime) || '0:00';
            elements.duration.textContent = app.formatTime?.(frame.duration) || '0:00';
            elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
            elements.progressTrack.setAttribute('aria-valuetext', `${elements.currentTime.textContent} / ${elements.duration.textContent}`);
        };

        const updatePlaybackState = (isPlaying) => {
            root.classList.toggle('is-playing', isPlaying);
            elements.play.classList.toggle('is-playing', isPlaying);
            elements.play.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
            elements.play.title = isPlaying ? '暂停' : '播放';
        };

        const resizeEdgeCanvas = (frame) => {
            if (!edgeContext || !elements.edgeCanvas) return false;
            const width = Math.max(1, root.clientWidth);
            const height = Math.max(1, root.clientHeight);
            const dpr = Math.min(1.75, frame.viewport?.dpr || global.devicePixelRatio || 1);
            const pixelWidth = Math.round(width * dpr);
            const pixelHeight = Math.round(height * dpr);
            if (
                edgeCanvasState.width !== width
                || edgeCanvasState.height !== height
                || edgeCanvasState.dpr !== dpr
            ) {
                elements.edgeCanvas.width = pixelWidth;
                elements.edgeCanvas.height = pixelHeight;
                elements.edgeCanvas.style.width = `${width}px`;
                elements.edgeCanvas.style.height = `${height}px`;
                edgeCanvasState.width = width;
                edgeCanvasState.height = height;
                edgeCanvasState.dpr = dpr;
            }
            edgeContext.setTransform(dpr, 0, 0, dpr, 0, 0);
            return true;
        };

        const getSpectrumSample = (spectrum, ratio, offset = 0) => {
            if (!spectrum?.length) return 0;
            const wrappedRatio = (clamp(ratio) * 0.86 + offset) % 1;
            const center = Math.floor(Math.pow(wrappedRatio, 1.55) * (spectrum.length - 1));
            const radius = Math.max(1, Math.floor(spectrum.length / 180));
            let total = 0;
            let count = 0;
            for (let index = Math.max(0, center - radius); index <= Math.min(spectrum.length - 1, center + radius); index += 1) {
                total += Number(spectrum[index]) || 0;
                count += 1;
            }
            const value = total / Math.max(1, count);
            return clamp(Math.pow(Math.max(0, value - 0.025), 0.78));
        };

        const ensureEdgeBuffer = (side, pointCount) => {
            const coordinateCount = pointCount * 2;
            if (edgeCanvasState[side].length !== coordinateCount) {
                edgeCanvasState[side] = new Float32Array(coordinateCount);
            }
            return edgeCanvasState[side];
        };

        const fillEdgePoints = (
            points,
            side,
            spectrum,
            offset,
            inset,
            width,
            height,
            amplitude,
            idleScale
        ) => {
            const count = points.length / 2;
            const span = side === 'top' || side === 'bottom'
                ? width - inset * 2
                : height - inset * 2;
            for (let index = 0; index < count; index += 1) {
                const ratio = index / Math.max(1, count - 1);
                const edgeFade = Math.pow(Math.sin(ratio * Math.PI), 0.42);
                const energy = getSpectrumSample(spectrum, ratio, offset) * edgeFade * idleScale;
                const coordinateIndex = index * 2;
                if (side === 'top') {
                    points[coordinateIndex] = inset + ratio * span;
                    points[coordinateIndex + 1] = inset + energy * amplitude;
                } else if (side === 'bottom') {
                    points[coordinateIndex] = width - inset - ratio * span;
                    points[coordinateIndex + 1] = height - inset - energy * amplitude;
                } else if (side === 'left') {
                    points[coordinateIndex] = inset + energy * amplitude;
                    points[coordinateIndex + 1] = height - inset - ratio * span;
                } else {
                    points[coordinateIndex] = width - inset - energy * amplitude;
                    points[coordinateIndex + 1] = inset + ratio * span;
                }
            }
        };

        const strokeEdgePath = (points, color, alpha, blur) => {
            if (!edgeContext || points.length < 4) return;
            edgeContext.save();
            edgeContext.beginPath();
            edgeContext.moveTo(points[0], points[1]);
            for (let index = 2; index < points.length - 2; index += 2) {
                edgeContext.quadraticCurveTo(
                    points[index],
                    points[index + 1],
                    (points[index] + points[index + 2]) / 2,
                    (points[index + 1] + points[index + 3]) / 2
                );
            }
            edgeContext.lineTo(points[points.length - 2], points[points.length - 1]);
            edgeContext.lineCap = 'round';
            edgeContext.lineJoin = 'round';
            edgeContext.lineWidth = blur > 0 ? 2.8 : 1.05;
            edgeContext.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
            edgeContext.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.min(0.9, alpha * 1.45)})`;
            edgeContext.shadowBlur = blur;
            edgeContext.stroke();
            edgeContext.restore();
        };

        const drawEdgeSpectrum = (frame) => {
            if (!resizeEdgeCanvas(frame) || !edgeContext) return;
            const { width, height } = edgeCanvasState;
            edgeContext.clearRect(0, 0, width, height);
            if (prefersReducedMotion?.matches || !frame.audio.spectrum?.length) return;

            const spectrum = frame.audio.spectrum;
            const accent = app.visualizerColor || { r: 121, g: 216, b: 255 };
            const color = {
                r: clamp(Number(accent.r) || 121, 0, 255),
                g: clamp(Number(accent.g) || 216, 0, 255),
                b: clamp(Number(accent.b) || 255, 0, 255)
            };
            const inset = clamp(Math.min(width, height) * 0.012, 7, 14);
            const horizontalAmplitude = clamp(height * 0.052, 18, 48);
            const verticalAmplitude = clamp(width * 0.038, 15, 42);
            const horizontalCount = clamp(Math.round(width / 15), 44, 104);
            const verticalCount = clamp(Math.round(height / 15), 28, 72);
            const idleScale = frame.isPlaying ? 1 : 0.12;

            const top = ensureEdgeBuffer('top', horizontalCount);
            const right = ensureEdgeBuffer('right', verticalCount);
            const bottom = ensureEdgeBuffer('bottom', horizontalCount);
            const left = ensureEdgeBuffer('left', verticalCount);
            fillEdgePoints(top, 'top', spectrum, 0, inset, width, height, horizontalAmplitude, idleScale);
            fillEdgePoints(right, 'right', spectrum, 0.11, inset, width, height, verticalAmplitude, idleScale);
            fillEdgePoints(bottom, 'bottom', spectrum, 0.21, inset, width, height, horizontalAmplitude, idleScale);
            fillEdgePoints(left, 'left', spectrum, 0.34, inset, width, height, verticalAmplitude, idleScale);

            const alpha = 0.28 + frame.audio.power * 0.62;
            strokeEdgePath(top, color, alpha * 0.38, 13);
            strokeEdgePath(right, color, alpha * 0.38, 13);
            strokeEdgePath(bottom, color, alpha * 0.38, 13);
            strokeEdgePath(left, color, alpha * 0.38, 13);
            strokeEdgePath(top, color, alpha, 2.5);
            strokeEdgePath(right, color, alpha, 2.5);
            strokeEdgePath(bottom, color, alpha, 2.5);
            strokeEdgePath(left, color, alpha, 2.5);
        };

        const getPlayModePresentation = () => {
            const mode = app.playModes[app.currentPlayMode] || 'repeat';
            if (mode === 'repeat-one') return { mode, label: '单曲循环', icon: icons.repeatOne };
            if (mode === 'shuffle') return { mode, label: '随机播放', icon: icons.shuffle };
            return { mode, label: '列表循环', icon: icons.repeat };
        };

        const updateTransportControls = () => {
            const volume = clamp(Number(app.volumeSlider?.value) || 0);
            const presentation = getPlayModePresentation();
            const signature = `${presentation.mode}:${volume.toFixed(3)}`;
            if (signature === state.lastTransportSignature) return;
            state.lastTransportSignature = signature;

            elements.playMode.innerHTML = presentation.icon;
            elements.playMode.title = presentation.label;
            elements.playMode.setAttribute('aria-label', presentation.label);
            elements.playMode.dataset.playMode = presentation.mode;
            elements.playMode.classList.toggle('is-active', presentation.mode !== 'repeat');

            elements.volumeSlider.value = String(volume);
            elements.volumeSlider.style.setProperty('--stage-volume', `${(volume * 100).toFixed(1)}%`);
            elements.volumeButton.classList.toggle('is-muted', volume <= 0.001);
            elements.volumeButton.title = volume <= 0.001 ? '恢复音量' : '静音';
            elements.volumeButton.setAttribute('aria-label', volume <= 0.001 ? '恢复音量' : '静音');
            if (volume > 0.001) state.lastNonZeroVolume = volume;
        };

        const setVolume = (value) => {
            const volume = clamp(Number(value) || 0);
            if (app.volumeSlider) {
                app.volumeSlider.value = String(volume);
                app.updateVolumeSliderBackground?.(volume);
            }
            app.api?.setMusicVolume?.(volume);
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
            app.saveSettings?.();
            state.lastTransportSignature = '';
            updateTransportControls();
        };

        const updateFrame = (timestamp) => {
            if (!state.active || state.destroyed) return;
            const frame = Runtime.createFrame(app, timestamp);
            state.lastFrame = frame;
            state.stats.frameUpdates += 1;
            app.currentLyricIndex = frame.currentLineIndex;
            updateTrack(frame.track);
            updateProgress(frame);
            updatePlaybackState(frame.isPlaying);
            updateTransportControls();
            root.style.setProperty('--stage-audio-power', frame.audio.power.toFixed(4));
            root.style.setProperty('--stage-audio-bass', frame.audio.bass.toFixed(4));
            root.style.setProperty('--stage-audio-vocal', frame.audio.vocal.toFixed(4));
            drawEdgeSpectrum(frame);
            state.modeInstance?.updateFrame?.(frame);
        };

        const seekFromPointer = async (event, commit) => {
            const rect = elements.progressTrack.getBoundingClientRect();
            const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1));
            const duration = state.lastFrame?.duration || app.lastKnownDuration || 0;
            const target = duration * ratio;
            elements.progressFill.style.width = `${(ratio * 100).toFixed(3)}%`;
            elements.progressTrack.querySelector('.music-stage-progress-glow').style.width = `${(ratio * 100).toFixed(3)}%`;
            elements.currentTime.textContent = app.formatTime?.(target) || '0:00';
            app.lastKnownCurrentTime = target;
            app.lastStateUpdateTime = Date.now();
            if (commit && duration > 0) await app.api?.seekMusic?.(target);
        };

        const enter = () => {
            if (state.active || state.destroyed) return;
            state.active = true;
            app.isStageActive = true;
            document.body.classList.add('music-stage-active');
            root.hidden = false;
            root.setAttribute('aria-hidden', 'false');
            createMode(state.modeId);
            setButtonState();
            requestAnimationFrame(() => {
                root.classList.add('is-visible');
                root.focus({ preventScroll: true });
                updateFrame(performance.now());
            });
        };

        const exit = () => {
            if (!state.active || state.destroyed) return;
            state.active = false;
            app.isStageActive = false;
            root.classList.remove('is-visible');
            document.body.classList.remove('music-stage-active');
            setButtonState();
            const generation = ++state.generation;
            setTimeout(() => {
                if (state.active || state.destroyed || generation !== state.generation) return;
                destroyMode();
                root.hidden = true;
                root.setAttribute('aria-hidden', 'true');
                toggleButton.focus({ preventScroll: true });
            }, 380);
        };

        const toggle = () => state.active ? exit() : enter();

        const setMode = (modeId) => {
            const resolved = Modes.get(modeId).id;
            if (resolved === state.modeId && state.modeInstance) return;
            state.stats.modeSwitches += 1;
            state.modeId = resolved;
            if (!state.active) {
                localStorage.setItem('musicStageMode', resolved);
                return;
            }
            elements.modeRoot.classList.add('is-switching');
            const generation = ++state.generation;
            setTimeout(() => {
                if (!state.active || state.destroyed || generation !== state.generation) return;
                createMode(resolved);
                requestAnimationFrame(() => elements.modeRoot.classList.remove('is-switching'));
            }, 170);
        };

        const onKeyDown = (event) => {
            if (!state.active) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                exit();
            } else if (event.code === 'Space' && !event.target.closest('button, input, select')) {
                event.preventDefault();
                app.isPlaying ? app.pauseTrack() : app.playTrack();
            } else if (event.key === 'ArrowLeft' && event.altKey) {
                event.preventDefault();
                app.prevTrack();
            } else if (event.key === 'ArrowRight' && event.altKey) {
                event.preventDefault();
                app.nextTrack();
            }
        };

        renderModeButtons();
        elements.play.innerHTML = `${icons.play}${icons.pause}`;
        elements.prev.innerHTML = icons.previous;
        elements.next.innerHTML = icons.next;
        elements.volumeButton.innerHTML = `${icons.volume}${icons.muted}`;
        updateTransportControls();

        scope.listen(toggleButton, 'click', toggle);
        scope.listen(elements.play, 'click', () => app.isPlaying ? app.pauseTrack() : app.playTrack());
        scope.listen(elements.prev, 'click', () => app.prevTrack());
        scope.listen(elements.next, 'click', () => app.nextTrack());
        scope.listen(elements.playMode, 'click', () => {
            app.currentPlayMode = (app.currentPlayMode + 1) % app.playModes.length;
            app.updateModeButton?.();
            if (app.wnpAdapter) app.wnpAdapter.sendUpdate();
            state.lastTransportSignature = '';
            updateTransportControls();
        });
        scope.listen(elements.volumeButton, 'click', () => {
            const current = Number(app.volumeSlider?.value) || 0;
            setVolume(current > 0.001 ? 0 : state.lastNonZeroVolume);
        });
        scope.listen(elements.volumeSlider, 'input', (event) => setVolume(event.target.value));
        scope.listen(elements.modeSwitcher, 'click', (event) => {
            const button = event.target.closest('[data-stage-mode]');
            if (button) setMode(button.dataset.stageMode);
        });
        scope.listen(elements.progressTrack, 'pointerdown', (event) => {
            state.draggingProgress = true;
            elements.progressTrack.setPointerCapture?.(event.pointerId);
            seekFromPointer(event, false);
        });
        scope.listen(elements.progressTrack, 'pointermove', (event) => {
            if (state.draggingProgress) seekFromPointer(event, false);
        });
        scope.listen(elements.progressTrack, 'pointerup', (event) => {
            if (!state.draggingProgress) return;
            state.draggingProgress = false;
            elements.progressTrack.releasePointerCapture?.(event.pointerId);
            seekFromPointer(event, true);
        });
        scope.listen(elements.progressTrack, 'pointercancel', () => {
            state.draggingProgress = false;
        });
        scope.listen(elements.progressTrack, 'keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const duration = state.lastFrame?.duration || app.lastKnownDuration || 0;
            let target = app.lastKnownCurrentTime || 0;
            if (event.key === 'ArrowLeft') target -= 5;
            if (event.key === 'ArrowRight') target += 5;
            if (event.key === 'Home') target = 0;
            if (event.key === 'End') target = duration;
            target = clamp(target, 0, duration);
            app.lastKnownCurrentTime = target;
            app.lastStateUpdateTime = Date.now();
            app.api?.seekMusic?.(target);
        });
        scope.listen(global, 'keydown', onKeyDown);
        scope.listen(global, 'resize', () => {
            edgeCanvasState.width = 0;
            edgeCanvasState.height = 0;
            state.modeInstance?.resize?.({
                width: global.innerWidth,
                height: global.innerHeight,
                dpr: Math.min(2, global.devicePixelRatio || 1)
            });
        });
        scope.listen(document, 'visibilitychange', () => {
            if (!state.modeInstance) return;
            if (document.hidden) state.modeInstance.suspend?.();
            else state.modeInstance.resume?.();
        });
        scope.listen(global, 'beforeunload', () => app.stageHost?.destroy?.(), { once: true });

        setButtonState();
        root.hidden = true;
        root.setAttribute('aria-hidden', 'true');

        app.stageHost = {
            enter,
            exit,
            toggle,
            setMode,
            updateFrame,
            updateTrack,
            get active() { return state.active; },
            get modeId() { return state.modeId; },
            getDebugSnapshot() {
                return {
                    active: state.active,
                    modeId: state.modeId,
                    generation: state.generation,
                    hasModeInstance: Boolean(state.modeInstance),
                    modeRootChildren: elements.modeRoot.childElementCount,
                    canvasCount: elements.modeRoot.querySelectorAll('canvas').length,
                    ...state.stats
                };
            },
            destroy() {
                if (state.destroyed) return;
                state.destroyed = true;
                state.active = false;
                app.isStageActive = false;
                state.generation += 1;
                if (state.backgroundTimer) clearTimeout(state.backgroundTimer);
                destroyMode();
                if (edgeContext && elements.edgeCanvas) {
                    edgeContext.clearRect(0, 0, elements.edgeCanvas.width, elements.edgeCanvas.height);
                    elements.edgeCanvas.width = 1;
                    elements.edgeCanvas.height = 1;
                }
                scope.destroy();
                document.body.classList.remove('music-stage-active');
                root.remove();
            }
        };
    }

    global.setupMusicStage = setupMusicStage;
})(window);