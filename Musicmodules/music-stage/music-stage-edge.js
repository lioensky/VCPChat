// Musicmodules/music-stage/music-stage-edge.js
// 舞台的边框频谱：窗口外圈四条细画布（每边一条，不铺满整窗），按频段画线、光晕，和绕边转的光。
// 宿主每帧调 draw(frame)；窗口尺寸变了调 invalidate()（舞台尺寸缓存和画布尺寸一起作废）；关掉舞台时 release() 把画布缩到 1×1 交还显存。
//
// 从 music-stage-host.js 拆出来，代码原样搬过来；宿主的 root、elements、state、scope 通过 create(ctx) 传进来。
(function (global) {
    'use strict';

    const EDGE_SIDES = ['top', 'right', 'bottom', 'left'];
    const POW_LUT_SIZE = 1024;
    const POW_LUT = new Float32Array(POW_LUT_SIZE + 1);
    for (let i = 0; i <= POW_LUT_SIZE; i += 1) {
        const v = i / POW_LUT_SIZE;
        POW_LUT[i] = v > 0.025 ? Math.min(1, Math.pow(v - 0.025, 0.78)) : 0;
    }

    function create(ctx) {
        const { app, root, elements, state, scope, clamp } = ctx;

        // The spectrum lives in the outer band of the window, so each side has a
        // strip canvas of its own instead of one canvas the size of the window.
        const edgeStrips = {};
        EDGE_SIDES.forEach((side, index) => {
            const canvas = index === 0 ? elements.edgeCanvas : elements.edgeCanvas?.cloneNode(false);
            const context = canvas?.getContext?.('2d', { alpha: true });
            if (!canvas || !context) return;
            if (index > 0) {
                elements.edgeCanvas.after(canvas);
                scope?.add?.(() => canvas.remove());
            }
            edgeStrips[side] = { canvas, context, x: 0, y: 0, width: 0, height: 0, lookup: null, flatKey: '' };
        });
        const edgeContext = EDGE_SIDES.every((side) => edgeStrips[side]?.context) ? edgeStrips.top.context : null;
        // The orbiting light of the edge ring: its gradient is drawn once and
        // turned by the compositor, instead of the ring being restyled and its
        // masked gradient painted again at every step of the orbit.
        const edgeFlow = elements.edgeSpectrum?.querySelector('.music-stage-edge-flow');
        if (edgeFlow && !edgeFlow.querySelector('.music-stage-edge-flow-light')) {
            const light = document.createElement('div');
            light.className = 'music-stage-edge-flow-light';
            light.setAttribute('aria-hidden', 'true');
            edgeFlow.prepend(light);
        }
        const prefersReducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const EDGE_FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
        const edgeCanvasState = {
            width: 0,
            height: 0,
            dpr: 1,
            inset: 10,
            horizontalAmplitude: 24,
            verticalAmplitude: 20,
            horizontalCount: 64,
            verticalCount: 40,
            drawnAt: 0,
            pausedAt: 0,
            lastR: -1,
            lastG: -1,
            lastB: -1,
            lastAccentRef: null,
            lastRgb: '',
            lastQuality: '',
            lastTrack: null,
            lastFlatKey: '',
            lastColorKey: '',
            glowStroke: '',
            glowShadow: '',
            mainStroke: '',
            mainShadow: '',
            blank: false,
            top: new Float32Array(0),
            right: new Float32Array(0),
            bottom: new Float32Array(0),
            left: new Float32Array(0)
        };

        // Thickness of the band a side can draw into: the line, its swing and its glow.
        const edgeMetrics = (width, height) => {
            const inset = clamp(Math.min(width, height) * 0.012, 7, 14);
            const horizontalAmplitude = clamp(height * 0.052, 18, 48);
            const verticalAmplitude = clamp(width * 0.038, 15, 42);
            return { inset, horizontalAmplitude, verticalAmplitude,
                horizontalBand: Math.max(1, Math.min(height, Math.ceil(inset + horizontalAmplitude + 24))),
                verticalBand: Math.max(1, Math.min(width, Math.ceil(inset + verticalAmplitude + 24))) };
        };

        // Reading the stage's size every frame forces a layout every frame;
        // capture dimensions straight from ResizeObserver so resizes avoid clientWidth/Height reflows.
        let rootSize = null;
        if (global.ResizeObserver) {
            const observer = new global.ResizeObserver((entries) => {
                const rect = entries?.[entries.length - 1]?.contentRect;
                if (rect && rect.width > 0 && rect.height > 0) {
                    rootSize = { width: Math.round(rect.width), height: Math.round(rect.height) };
                } else {
                    rootSize = null;
                }
            });
            observer.observe(root);
            scope.add(() => observer.disconnect());
        }
        const stageSize = () => {
            if (!rootSize || !global.ResizeObserver) rootSize = { width: root.clientWidth, height: root.clientHeight };
            return rootSize;
        };
        const resizeEdgeCanvas = (frame) => {
            if (!edgeContext) return false;
            const size = stageSize();
            const width = Math.max(1, size.width);
            const height = Math.max(1, size.height);
            // A glowing line gains nothing from more than this; energy-saving caps at 1x to trim shadowBlur fill cost.
            const dprCap = state.config.quality === 'energy-saving' ? 1 : 1.5;
            const dpr = Math.min(dprCap, frame.viewport?.dpr || global.devicePixelRatio || 1);
            if (
                edgeCanvasState.width !== width
                || edgeCanvasState.height !== height
                || edgeCanvasState.dpr !== dpr
            ) {
                const metrics = edgeMetrics(width, height);
                const { horizontalBand, verticalBand } = metrics;
                const boxes = {
                    top: [0, 0, width, horizontalBand],
                    bottom: [0, height - horizontalBand, width, horizontalBand],
                    left: [0, 0, verticalBand, height],
                    right: [width - verticalBand, 0, verticalBand, height]
                };
                EDGE_SIDES.forEach((side) => {
                    const strip = edgeStrips[side];
                    [strip.x, strip.y, strip.width, strip.height] = boxes[side];
                    strip.canvas.width = Math.round(strip.width * dpr);
                    strip.canvas.height = Math.round(strip.height * dpr);
                    Object.assign(strip.canvas.style, {
                        left: `${strip.x}px`, top: `${strip.y}px`,
                        width: `${strip.width}px`, height: `${strip.height}px`
                    });
                    // Draw in window coordinates, whichever strip it is.
                    strip.context.setTransform(dpr, 0, 0, dpr, -strip.x * dpr, -strip.y * dpr);
                    strip.context.lineCap = 'round';
                    strip.context.lineJoin = 'round';
                    strip.lookup = null;
                    strip.flatKey = '';
                });
                edgeCanvasState.width = width;
                edgeCanvasState.height = height;
                edgeCanvasState.dpr = dpr;
                edgeCanvasState.inset = metrics.inset;
                edgeCanvasState.horizontalAmplitude = metrics.horizontalAmplitude;
                edgeCanvasState.verticalAmplitude = metrics.verticalAmplitude;
                edgeCanvasState.horizontalCount = clamp(Math.round(width / 15), 44, 104);
                edgeCanvasState.verticalCount = clamp(Math.round(height / 15), 28, 72);
                edgeCanvasState.drawnAt = 0;
                edgeCanvasState.pausedAt = 0;
                edgeCanvasState.lastFlatKey = '';
                edgeCanvasState.blank = false;
            }
            return true;
        };

        const clearEdgeStrips = () => {
            edgeCanvasState.lastFlatKey = '';
            for (let i = 0; i < EDGE_SIDES.length; i += 1) {
                const strip = edgeStrips[EDGE_SIDES[i]];
                strip.flatKey = '';
                strip.context.clearRect(strip.x, strip.y, strip.width, strip.height);
            }
        };

        let specPrefix = new Float64Array(0);
        const buildSpectrumPrefix = (spectrum) => {
            const len = spectrum?.length || 0;
            if (len === 0) return 0;
            if (specPrefix.length < len + 1) specPrefix = new Float64Array(len + 1);
            let sum = 0;
            specPrefix[0] = 0;
            for (let i = 0; i < len; i += 1) {
                const v = +spectrum[i];
                if (v > 0) sum += v;
                specPrefix[i + 1] = sum;
            }
            return sum;
        };

        const getEdgeLookup = (side, count, offset, specLen, inset, width, height, amplitude) => {
            const strip = edgeStrips[side];
            let entry = strip?.lookup;
            if (entry && entry.count === count && entry.offset === offset && entry.specLen === specLen
                && entry.width === width && entry.height === height
                && entry.inset === inset && entry.amplitude === amplitude) {
                return entry;
            }
            const fixed = new Float32Array(count);
            const scaledFades = new Float32Array(count);
            const loArr = new Int32Array(count);
            const hiArr = new Int32Array(count);
            const invSpan = new Float32Array(count);
            const denom = Math.max(1, count - 1);
            const maxIdx = Math.max(0, specLen - 1);
            const radius = Math.max(1, Math.floor(specLen / 180));
            const span = (side === 'top' || side === 'bottom' ? width : height) - inset * 2;
            const reverse = side === 'bottom' || side === 'left';
            const edgeLen = side === 'bottom' ? width : height;
            for (let index = 0; index < count; index += 1) {
                const ratio = index / denom;
                fixed[index] = reverse ? edgeLen - inset - ratio * span : inset + ratio * span;
                scaledFades[index] = Math.pow(Math.sin(ratio * Math.PI), 0.42) * amplitude;
                const wrappedRatio = (clamp(ratio) * 0.86 + offset) % 1;
                const center = Math.floor(Math.pow(wrappedRatio, 1.55) * maxIdx);
                const lo = center > radius ? center - radius : 0;
                const hi = center + radius < maxIdx ? center + radius : maxIdx;
                loArr[index] = lo;
                hiArr[index] = hi;
                invSpan[index] = 1 / Math.max(1, hi - lo + 1);
            }
            entry = {
                count, offset, specLen, width, height, inset, amplitude,
                fixed, scaledFades, loArr, hiArr, invSpan
            };
            if (strip) strip.lookup = entry;
            return entry;
        };

        const ensureEdgeBuffer = (side, pointCount) => {
            const coordinateCount = pointCount * 2;
            if (edgeCanvasState[side].length !== coordinateCount) {
                edgeCanvasState[side] = new Float32Array(coordinateCount);
            }
            return edgeCanvasState[side];
        };

        const fillFlatEndpoints = (points, side, inset, width, height) => {
            const last = points.length - 2;
            const isTop = side === 'top';
            const isBottom = side === 'bottom';
            const isLeft = side === 'left';
            const baseAxis = isTop || isLeft ? inset : (isBottom ? height - inset : width - inset);
            if (isTop || isBottom) {
                points[0] = isBottom ? width - inset : inset;
                points[1] = baseAxis;
                points[last] = isBottom ? inset : width - inset;
                points[last + 1] = baseAxis;
            } else {
                points[0] = baseAxis;
                points[1] = isLeft ? height - inset : inset;
                points[last] = baseAxis;
                points[last + 1] = isLeft ? inset : height - inset;
            }
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
            const count = points.length >> 1;
            const specLen = spectrum?.length || 0;
            const lookup = getEdgeLookup(side, count, offset, specLen, inset, width, height, amplitude);
            const { fixed, scaledFades, loArr, hiArr, invSpan } = lookup;
            const isTop = side === 'top';
            const isBottom = side === 'bottom';
            const isLeft = side === 'left';
            const baseAxis = isTop || isLeft ? inset : (isBottom ? height - inset : width - inset);
            const sign = isTop || isLeft ? 1 : -1;
            const horizontal = isTop || isBottom;
            let hasMotion = false;
            for (let index = 0; index < count; index += 1) {
                let disp = 0;
                if (specLen > 0) {
                    const value = (specPrefix[hiArr[index] + 1] - specPrefix[loArr[index]]) * invSpan[index];
                    if (value > 0.025) {
                        const lutIdx = value >= 1 ? POW_LUT_SIZE : (value * POW_LUT_SIZE) | 0;
                        const sample = POW_LUT[lutIdx];
                        if (sample > 0) {
                            disp = sample * scaledFades[index] * idleScale;
                            if (disp > 0.05) hasMotion = true;
                        }
                    }
                }
                const coordinateIndex = index << 1;
                if (horizontal) {
                    points[coordinateIndex] = fixed[index];
                    points[coordinateIndex + 1] = baseAxis + sign * disp;
                } else {
                    points[coordinateIndex] = baseAxis + sign * disp;
                    points[coordinateIndex + 1] = fixed[index];
                }
            }
            return hasMotion;
        };

        const strokeEdgePair = (ctx2d, points, hasMotion, glowStroke, glowShadow, mainStroke, mainShadow, lightGlow) => {
            if (!ctx2d || points.length < 4) return;
            ctx2d.beginPath();
            ctx2d.moveTo(points[0], points[1]);
            if (hasMotion) {
                for (let index = 2; index < points.length - 2; index += 2) {
                    ctx2d.quadraticCurveTo(
                        points[index],
                        points[index + 1],
                        (points[index] + points[index + 2]) * 0.5,
                        (points[index + 1] + points[index + 3]) * 0.5
                    );
                }
            }
            ctx2d.lineTo(points[points.length - 2], points[points.length - 1]);
            // The wide soft pass stands in for the glow filters the canvas used to have.
            ctx2d.lineWidth = 2.8;
            ctx2d.strokeStyle = glowStroke;
            ctx2d.shadowColor = glowShadow;
            ctx2d.shadowBlur = lightGlow ? 8 : 18;
            ctx2d.stroke();
            ctx2d.lineWidth = 1.05;
            ctx2d.strokeStyle = mainStroke;
            ctx2d.shadowColor = lightGlow ? 'transparent' : mainShadow;
            ctx2d.shadowBlur = lightGlow ? 0 : 3.5;
            ctx2d.stroke();
            ctx2d.shadowBlur = 0;
            ctx2d.shadowColor = 'transparent';
        };

        const release = () => {
            edgeCanvasState.width = 0;
            edgeCanvasState.height = 0;
            edgeCanvasState.drawnAt = 0;
            edgeCanvasState.pausedAt = 0;
            edgeCanvasState.lastR = -1;
            edgeCanvasState.lastG = -1;
            edgeCanvasState.lastB = -1;
            edgeCanvasState.lastAccentRef = null;
            edgeCanvasState.lastRgb = '';
            edgeCanvasState.lastQuality = '';
            edgeCanvasState.lastTrack = null;
            edgeCanvasState.lastFlatKey = '';
            edgeCanvasState.lastColorKey = '';
            edgeCanvasState.blank = true;
            specPrefix = new Float64Array(0);
            for (let i = 0; i < EDGE_SIDES.length; i += 1) {
                const strip = edgeStrips[EDGE_SIDES[i]];
                if (!strip) continue;
                strip.lookup = null;
                strip.flatKey = '';
                if (strip.canvas.width !== 1) strip.canvas.width = 1;
                if (strip.canvas.height !== 1) strip.canvas.height = 1;
            }
        };

        const drawSide = (strip, pts, moving, wasBlank, flatBase, lightGlow) => {
            if (!moving && !wasBlank && strip.flatKey === flatBase) return;
            strip.flatKey = moving ? '' : flatBase;
            strip.context.clearRect(strip.x, strip.y, strip.width, strip.height);
            strokeEdgePair(
                strip.context, pts, moving,
                edgeCanvasState.glowStroke, edgeCanvasState.glowShadow,
                edgeCanvasState.mainStroke, edgeCanvasState.mainShadow,
                lightGlow
            );
        };

        const drawEdgeSpectrum = (frame) => {
            if (state.config.edgeSpectrum === false) {
                if (edgeContext && !edgeCanvasState.blank) {
                    clearEdgeStrips();
                    if (edgeCanvasState.width > 0) release();
                    else edgeCanvasState.blank = true;
                }
                return;
            }
            if (!edgeContext) return;
            const reducedMotion = global.MusicStageRuntime.isReducedMotion(prefersReducedMotion);
            if (reducedMotion || !frame.audio.spectrum?.length) {
                if (!edgeCanvasState.blank && edgeCanvasState.width > 0) {
                    clearEdgeStrips();
                    if (reducedMotion) release();
                } else if (reducedMotion && edgeCanvasState.width > 0) {
                    release();
                }
                edgeCanvasState.blank = true;
                return;
            }
            const now = Number.isFinite(frame.now) ? frame.now : performance.now();
            const quality = state.config.quality || 'standard';
            const qualityChanged = quality !== edgeCanvasState.lastQuality;
            const track = frame.track || null;
            const trackChanged = track !== edgeCanvasState.lastTrack;
            const needsResize = edgeCanvasState.width === 0
                || !rootSize
                || Math.max(1, rootSize.width) !== edgeCanvasState.width
                || Math.max(1, rootSize.height) !== edgeCanvasState.height
                || qualityChanged;
            // Gate throttled playing frames before touching canvas sizing or accent resolution.
            if (frame.isPlaying) {
                edgeCanvasState.pausedAt = 0;
                const aim = 1000 / (EDGE_FPS[quality] || 30);
                if (now < edgeCanvasState.drawnAt) edgeCanvasState.drawnAt = 0;
                if (!needsResize && !trackChanged && !edgeCanvasState.blank && edgeCanvasState.drawnAt && now - edgeCanvasState.drawnAt < aim - 3) return;
            } else {
                if (now < edgeCanvasState.pausedAt) edgeCanvasState.pausedAt = now;
                const palRef = app?.stagePalette?.accentRgb || null;
                if (!needsResize && !trackChanged && !edgeCanvasState.blank
                    && palRef && palRef === edgeCanvasState.lastAccentRef) {
                    edgeCanvasState.pausedAt ||= now;
                    if (now - edgeCanvasState.pausedAt > 1500) return;
                    if (edgeCanvasState.drawnAt && now - edgeCanvasState.drawnAt < 250) return;
                }
            }
            const color = global.MusicStageModeUtils.resolveAccent(app);
            const colorChanged = color.r !== edgeCanvasState.lastR
                || color.g !== edgeCanvasState.lastG
                || color.b !== edgeCanvasState.lastB;
            if (!frame.isPlaying && !needsResize && !trackChanged && !colorChanged && !edgeCanvasState.blank) {
                edgeCanvasState.lastAccentRef = app?.stagePalette?.accentRgb || null;
                edgeCanvasState.pausedAt ||= now;
                if (now - edgeCanvasState.pausedAt > 1500) return;
                if (edgeCanvasState.drawnAt && now - edgeCanvasState.drawnAt < 250) return;
            }
            if (!resizeEdgeCanvas(frame)) return;
            const { width, height, inset, horizontalAmplitude, verticalAmplitude, horizontalCount, verticalCount } = edgeCanvasState;
            edgeCanvasState.lastTrack = track;
            edgeCanvasState.lastAccentRef = app?.stagePalette?.accentRgb || null;
            // If track/theme accent or quality tier changed while paused, wake the settled paused border once to match.
            if (colorChanged || qualityChanged) {
                edgeCanvasState.lastR = color.r;
                edgeCanvasState.lastG = color.g;
                edgeCanvasState.lastB = color.b;
                edgeCanvasState.lastRgb = `${color.r}, ${color.g}, ${color.b}`;
                edgeCanvasState.lastQuality = quality;
                edgeCanvasState.pausedAt = 0;
                edgeCanvasState.drawnAt = 0;
            }
            const rgb = edgeCanvasState.lastRgb;
            // A paused stage holds a faint, still line: let it settle for a
            // moment after the pause, then leave the canvases alone.
            // While playing, pace 4-canvas glow rasterization to match the quality tier.
            if (!frame.isPlaying) {
                edgeCanvasState.pausedAt ||= now;
                if (now - edgeCanvasState.pausedAt > 1500 && !edgeCanvasState.blank) return;
                if (edgeCanvasState.drawnAt && now - edgeCanvasState.drawnAt < 250) return;
            }
            const spectrum = frame.audio.spectrum;
            const idleScale = frame.isPlaying ? 1 : 0.12;
            const alpha = 0.28 + (Number(frame.audio.power) || 0) * 0.62;
            const alphaKey = alpha.toFixed(3);
            const lightGlow = quality === 'energy-saving';
            const flatBase = `${rgb}|${alphaKey}|${lightGlow ? 1 : 0}|${width}x${height}x${edgeCanvasState.dpr}`;
            const spectrumSum = buildSpectrumPrefix(spectrum);

            if (spectrumSum <= 0 && !edgeCanvasState.blank && flatBase === edgeCanvasState.lastFlatKey) {
                edgeCanvasState.drawnAt = now;
                return;
            }

            const top = ensureEdgeBuffer('top', horizontalCount);
            const right = ensureEdgeBuffer('right', verticalCount);
            const bottom = ensureEdgeBuffer('bottom', horizontalCount);
            const left = ensureEdgeBuffer('left', verticalCount);
            let mTop = false;
            let mRight = false;
            let mBottom = false;
            let mLeft = false;
            if (spectrumSum > 0) {
                mTop = fillEdgePoints(top, 'top', spectrum, 0, inset, width, height, horizontalAmplitude, idleScale);
                mRight = fillEdgePoints(right, 'right', spectrum, 0.11, inset, width, height, verticalAmplitude, idleScale);
                mBottom = fillEdgePoints(bottom, 'bottom', spectrum, 0.21, inset, width, height, horizontalAmplitude, idleScale);
                mLeft = fillEdgePoints(left, 'left', spectrum, 0.34, inset, width, height, verticalAmplitude, idleScale);
            } else {
                fillFlatEndpoints(top, 'top', inset, width, height);
                fillFlatEndpoints(right, 'right', inset, width, height);
                fillFlatEndpoints(bottom, 'bottom', inset, width, height);
                fillFlatEndpoints(left, 'left', inset, width, height);
            }

            const hasMotion = mTop || mRight || mBottom || mLeft;
            const flatKey = hasMotion ? '' : flatBase;
            edgeCanvasState.drawnAt = now;
            if (!hasMotion && !edgeCanvasState.blank && flatKey === edgeCanvasState.lastFlatKey) {
                return;
            }
            const wasBlank = edgeCanvasState.blank;
            edgeCanvasState.blank = false;
            edgeCanvasState.lastFlatKey = flatKey;

            const colorKey = `${rgb}|${alphaKey}`;
            if (colorKey !== edgeCanvasState.lastColorKey) {
                edgeCanvasState.lastColorKey = colorKey;
                const glowAlpha = alpha * 0.5;
                edgeCanvasState.glowStroke = `rgba(${rgb}, ${glowAlpha.toFixed(3)})`;
                edgeCanvasState.glowShadow = `rgba(${rgb}, ${Math.min(0.9, glowAlpha * 1.45).toFixed(3)})`;
                edgeCanvasState.mainStroke = `rgba(${rgb}, ${alphaKey})`;
                edgeCanvasState.mainShadow = `rgba(${rgb}, ${Math.min(0.9, alpha * 1.45).toFixed(3)})`;
            }
            drawSide(edgeStrips.top, top, mTop, wasBlank, flatBase, lightGlow);
            drawSide(edgeStrips.right, right, mRight, wasBlank, flatBase, lightGlow);
            drawSide(edgeStrips.bottom, bottom, mBottom, wasBlank, flatBase, lightGlow);
            drawSide(edgeStrips.left, left, mLeft, wasBlank, flatBase, lightGlow);
        };

        return {
            draw: drawEdgeSpectrum,
            invalidate: () => {
                rootSize = null;
                edgeCanvasState.width = 0;
                edgeCanvasState.height = 0;
                edgeCanvasState.lastFlatKey = '';
                for (let i = 0; i < EDGE_SIDES.length; i += 1) {
                    const strip = edgeStrips[EDGE_SIDES[i]];
                    if (strip) strip.flatKey = '';
                }
            },
            release
        };
    }

    global.MusicStageEdge = { create };
})(window);
