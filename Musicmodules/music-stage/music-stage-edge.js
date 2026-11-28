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
        let hasAllEdgeContexts = true;
        for (let index = 0; index < EDGE_SIDES.length; index += 1) {
            const side = EDGE_SIDES[index];
            const canvas = index === 0 ? elements.edgeCanvas : elements.edgeCanvas?.cloneNode(false);
            if (index > 0 && canvas?.hasAttribute?.('id')) canvas.removeAttribute('id');
            const context = canvas?.getContext?.('2d', { alpha: true });
            if (!canvas || !context) { hasAllEdgeContexts = false; continue; }
            if (index > 0) {
                elements.edgeCanvas.after(canvas);
                scope?.add?.(() => canvas.remove());
            }
            edgeStrips[side] = { canvas, context, x: 0, y: 0, width: 0, height: 0, lookup: null, flatLayoutRev: 0, flatColorRev: 0, flatStyle: -1 };
        }
        const edgeContext = hasAllEdgeContexts && edgeStrips.top ? edgeStrips.top.context : null;
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
            lastVisRef: null,
            lastRgb: '',
            lastQuality: '',
            lastTrack: null,
            layoutRev: 1,
            colorRev: 1,
            lastFlatLayoutRev: 0,
            lastFlatColorRev: 0,
            lastFlatStyle: -1,
            lastColorRgb: '',
            lastAlphaByte: -1,
            mono: false,
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
            scope?.add?.(() => observer.disconnect());
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
                // Read --stage-edge-mono before mutating strip canvases/styles to avoid write-then-read reflow.
                const nextMono = typeof global.getComputedStyle === 'function'
                    ? global.getComputedStyle(edgeStrips.top.canvas).getPropertyValue('--stage-edge-mono').trim() === '1'
                    : false;
                const metrics = edgeMetrics(width, height);
                const { horizontalBand, verticalBand } = metrics;
                const boxes = {
                    top: [0, 0, width, horizontalBand],
                    bottom: [0, height - horizontalBand, width, horizontalBand],
                    left: [0, 0, verticalBand, height],
                    right: [width - verticalBand, 0, verticalBand, height]
                };
                for (let i = 0; i < EDGE_SIDES.length; i += 1) {
                    const side = EDGE_SIDES[i];
                    const strip = edgeStrips[side];
                    const box = boxes[side];
                    strip.x = box[0];
                    strip.y = box[1];
                    strip.width = box[2];
                    strip.height = box[3];
                    strip.canvas.width = Math.round(strip.width * dpr);
                    strip.canvas.height = Math.round(strip.height * dpr);
                    const st = strip.canvas.style;
                    st.left = `${strip.x}px`;
                    st.top = `${strip.y}px`;
                    st.width = `${strip.width}px`;
                    st.height = `${strip.height}px`;
                    // Draw in window coordinates, whichever strip it is.
                    strip.context.setTransform(dpr, 0, 0, dpr, -strip.x * dpr, -strip.y * dpr);
                    strip.context.lineCap = 'round';
                    strip.context.lineJoin = 'round';
                    strip.lookup = null;
                    strip.flatStyle = -1;
                }
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
                edgeCanvasState.layoutRev += 1;
                edgeCanvasState.lastFlatStyle = -1;
                edgeCanvasState.blank = false;
                if (edgeCanvasState.mono !== nextMono) {
                    edgeCanvasState.mono = nextMono;
                    edgeCanvasState.colorRev += 1;
                    edgeCanvasState.lastColorRgb = '';
                }
            }
            return true;
        };

        const clearEdgeStrips = () => {
            edgeCanvasState.lastFlatStyle = -1;
            for (let i = 0; i < EDGE_SIDES.length; i += 1) {
                const strip = edgeStrips[EDGE_SIDES[i]];
                strip.flatStyle = -1;
                strip.context.clearRect(strip.x, strip.y, strip.width, strip.height);
            }
        };

        let specPrefix = new Float64Array(0);
        const buildSpectrumPrefix = (spectrum) => {
            const len = spectrum?.length || 0;
            if (len === 0) return 0;
            if (specPrefix.length < len + 1) specPrefix = new Float64Array(len + 1);
            let sum = 0;
            let maxVal = 0;
            specPrefix[0] = 0;
            for (let i = 0; i < len; i += 1) {
                const v = +spectrum[i];
                if (v > 0) {
                    sum += v;
                    if (v > maxVal) maxVal = v;
                }
                specPrefix[i + 1] = sum;
            }
            return maxVal;
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
                scaledFades[index] = (index === 0 || index === denom) ? 0 : Math.pow(Math.sin(ratio * Math.PI), 0.42) * amplitude;
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
            const layoutRev = edgeCanvasState.layoutRev;
            if (points._fixedRev !== layoutRev) {
                if (horizontal) {
                    for (let index = 0; index < count; index += 1) points[index << 1] = fixed[index];
                } else {
                    for (let index = 0; index < count; index += 1) points[(index << 1) + 1] = fixed[index];
                }
                points._fixedRev = layoutRev;
            }
            const dynOffset = horizontal ? 1 : 0;
            if (specLen <= 0) {
                for (let index = 0, ptr = dynOffset; index < count; index += 1, ptr += 2) points[ptr] = baseAxis;
                return false;
            }
            const signedScale = sign * idleScale;
            const motionMin = 0.05 / idleScale;
            let hasMotion = false;
            for (let index = 0, ptr = dynOffset; index < count; index += 1, ptr += 2) {
                const value = (specPrefix[hiArr[index] + 1] - specPrefix[loArr[index]]) * invSpan[index];
                if (value > 0.025) {
                    const lutIdx = value >= 1 ? POW_LUT_SIZE : (value * POW_LUT_SIZE) | 0;
                    const sample = POW_LUT[lutIdx];
                    if (sample > 0) {
                        const rawDisp = sample * scaledFades[index];
                        if (rawDisp > motionMin) hasMotion = true;
                        points[ptr] = baseAxis + rawDisp * signedScale;
                        continue;
                    }
                }
                points[ptr] = baseAxis;
            }
            return hasMotion;
        };

        const strokeEdgePair = (ctx2d, points, hasMotion, glowStroke, glowShadow, mainStroke, mainShadow, lightGlow) => {
            const len = points.length;
            if (!ctx2d || len < 4) return;
            const last = len - 2;
            ctx2d.beginPath();
            ctx2d.moveTo(points[0], points[1]);
            if (hasMotion && last > 2) {
                let px = points[2];
                let py = points[3];
                for (let index = 2; index < last; index += 2) {
                    const nx = points[index + 2];
                    const ny = points[index + 3];
                    ctx2d.quadraticCurveTo(px, py, (px + nx) * 0.5, (py + ny) * 0.5);
                    px = nx;
                    py = ny;
                }
            }
            ctx2d.lineTo(points[last], points[last + 1]);
            // The wide soft pass stands in for the glow filters the canvas used to have.
            ctx2d.lineWidth = 2.8;
            ctx2d.strokeStyle = glowStroke;
            ctx2d.shadowColor = glowShadow;
            ctx2d.shadowBlur = lightGlow ? 8 : 18;
            ctx2d.stroke();
            ctx2d.lineWidth = 1.05;
            ctx2d.strokeStyle = mainStroke;
            if (lightGlow) {
                ctx2d.shadowBlur = 0;
                ctx2d.shadowColor = 'transparent';
                ctx2d.stroke();
            } else {
                ctx2d.shadowColor = mainShadow;
                ctx2d.shadowBlur = 3.5;
                ctx2d.stroke();
                ctx2d.shadowBlur = 0;
                ctx2d.shadowColor = 'transparent';
            }
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
            edgeCanvasState.lastVisRef = null;
            edgeCanvasState.lastRgb = '';
            edgeCanvasState.lastQuality = '';
            edgeCanvasState.lastTrack = null;
            edgeCanvasState.layoutRev += 1;
            edgeCanvasState.lastFlatStyle = -1;
            edgeCanvasState.lastColorRgb = '';
            edgeCanvasState.lastAlphaByte = -1;
            edgeCanvasState.mono = false;
            edgeCanvasState.blank = true;
            specPrefix = new Float64Array(0);
            edgeCanvasState.top = new Float32Array(0);
            edgeCanvasState.right = new Float32Array(0);
            edgeCanvasState.bottom = new Float32Array(0);
            edgeCanvasState.left = new Float32Array(0);
            for (let i = 0; i < EDGE_SIDES.length; i += 1) {
                const strip = edgeStrips[EDGE_SIDES[i]];
                if (!strip) continue;
                strip.lookup = null;
                strip.flatStyle = -1;
                if (strip.canvas.width !== 1) strip.canvas.width = 1;
                if (strip.canvas.height !== 1) strip.canvas.height = 1;
            }
        };

        const drawSide = (strip, pts, moving, wasBlank, flatStyle, layoutRev, colorRev, lightGlow) => {
            if (!moving && !wasBlank
                && strip.flatStyle === flatStyle
                && strip.flatLayoutRev === layoutRev
                && strip.flatColorRev === colorRev) return;
            if (moving) {
                strip.flatStyle = -1;
            } else {
                strip.flatStyle = flatStyle;
                strip.flatLayoutRev = layoutRev;
                strip.flatColorRev = colorRev;
            }
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
                if (edgeContext && (!edgeCanvasState.blank || edgeCanvasState.width > 0)) {
                    if (!edgeCanvasState.blank) clearEdgeStrips();
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
            const targetDpr = Math.min(quality === 'energy-saving' ? 1 : 1.5, frame.viewport?.dpr || global.devicePixelRatio || 1);
            const needsResize = edgeCanvasState.width === 0
                || !rootSize
                || Math.max(1, rootSize.width) !== edgeCanvasState.width
                || Math.max(1, rootSize.height) !== edgeCanvasState.height
                || targetDpr !== edgeCanvasState.dpr
                || qualityChanged;
            // Gate throttled playing frames before touching canvas sizing or accent resolution.
            if (frame.isPlaying) {
                edgeCanvasState.pausedAt = 0;
                const aim = 1000 / (EDGE_FPS[quality] || 30);
                if (now < edgeCanvasState.drawnAt) edgeCanvasState.drawnAt = 0;
                if (!needsResize && !trackChanged && !edgeCanvasState.blank && edgeCanvasState.drawnAt && now - edgeCanvasState.drawnAt < aim - 3) return;
            }
            const palRef = app?.stagePalette?.accentRgb || null;
            const visRef = palRef ? null : (app?.visualizerColor || null);
            const accentUnchanged = edgeCanvasState.lastR >= 0 && (
                (palRef && palRef === edgeCanvasState.lastAccentRef
                    && palRef.r === edgeCanvasState.lastR && palRef.g === edgeCanvasState.lastG && palRef.b === edgeCanvasState.lastB)
                || (!palRef && visRef && visRef === edgeCanvasState.lastVisRef
                    && visRef.r === edgeCanvasState.lastR && visRef.g === edgeCanvasState.lastG && visRef.b === edgeCanvasState.lastB)
                || (!palRef && !visRef && edgeCanvasState.lastAccentRef === null && edgeCanvasState.lastVisRef === null)
            );
            if (!frame.isPlaying) {
                if (now < edgeCanvasState.pausedAt) edgeCanvasState.pausedAt = now;
                if (!needsResize && !trackChanged && !edgeCanvasState.blank && accentUnchanged) {
                    edgeCanvasState.pausedAt ||= now;
                    if (now - edgeCanvasState.pausedAt > 1500) return;
                    if (edgeCanvasState.drawnAt && now - edgeCanvasState.drawnAt < 250) return;
                }
            }
            let colorChanged = false;
            let colorR = edgeCanvasState.lastR;
            let colorG = edgeCanvasState.lastG;
            let colorB = edgeCanvasState.lastB;
            if (!accentUnchanged) {
                const color = global.MusicStageModeUtils.resolveAccent(app);
                colorR = color.r;
                colorG = color.g;
                colorB = color.b;
                colorChanged = colorR !== edgeCanvasState.lastR
                    || colorG !== edgeCanvasState.lastG
                    || colorB !== edgeCanvasState.lastB;
            }
            if (!frame.isPlaying && !needsResize && !trackChanged && !colorChanged && !edgeCanvasState.blank) {
                edgeCanvasState.lastAccentRef = palRef;
                edgeCanvasState.lastVisRef = visRef;
                edgeCanvasState.pausedAt ||= now;
                if (now - edgeCanvasState.pausedAt > 1500) return;
                if (edgeCanvasState.drawnAt && now - edgeCanvasState.drawnAt < 250) return;
            }
            const prevMono = edgeCanvasState.mono;
            if ((needsResize || !global.ResizeObserver) && !resizeEdgeCanvas(frame)) return;
            const monoChanged = edgeCanvasState.mono !== prevMono;
            const { width, height, inset, horizontalAmplitude, verticalAmplitude, horizontalCount, verticalCount } = edgeCanvasState;
            edgeCanvasState.lastTrack = track;
            edgeCanvasState.lastAccentRef = palRef;
            edgeCanvasState.lastVisRef = visRef;
            // If track/theme accent or quality tier changed while paused, wake the settled paused border once to match.
            if (colorChanged || qualityChanged || monoChanged) {
                edgeCanvasState.lastR = colorR;
                edgeCanvasState.lastG = colorG;
                edgeCanvasState.lastB = colorB;
                if (edgeCanvasState.mono) {
                    const luma = Math.round(0.2126 * colorR + 0.7152 * colorG + 0.0722 * colorB);
                    edgeCanvasState.lastRgb = `${luma}, ${luma}, ${luma}`;
                } else {
                    edgeCanvasState.lastRgb = `${colorR}, ${colorG}, ${colorB}`;
                }
                edgeCanvasState.lastQuality = quality;
                edgeCanvasState.colorRev += 1;
                edgeCanvasState.pausedAt = 0;
                edgeCanvasState.drawnAt = 0;
            } else if (trackChanged) {
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
            // 8-bit alpha quantization matches 8bpc canvas raster precision and avoids per-frame rgba string churn
            const alphaByte = Math.max(0, Math.min(255, Math.round(alpha * 255)));
            const lightGlow = quality === 'energy-saving';
            const flatStyle = alphaByte | (lightGlow ? 256 : 0);
            const layoutRev = edgeCanvasState.layoutRev;
            const colorRev = edgeCanvasState.colorRev;
            // If peak bin <= 0.025, every windowed average is <= 0.025 and maps to zero displacement in POW_LUT.
            const specMax = buildSpectrumPrefix(spectrum);
            const activeSpectrum = specMax > 0.025;

            if (!activeSpectrum && !edgeCanvasState.blank
                && edgeCanvasState.lastFlatStyle === flatStyle
                && edgeCanvasState.lastFlatLayoutRev === layoutRev
                && edgeCanvasState.lastFlatColorRev === colorRev) {
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
            if (activeSpectrum) {
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
            edgeCanvasState.drawnAt = now;
            if (!hasMotion && !edgeCanvasState.blank
                && edgeCanvasState.lastFlatStyle === flatStyle
                && edgeCanvasState.lastFlatLayoutRev === layoutRev
                && edgeCanvasState.lastFlatColorRev === colorRev) {
                return;
            }
            const wasBlank = edgeCanvasState.blank;
            edgeCanvasState.blank = false;
            if (hasMotion) {
                edgeCanvasState.lastFlatStyle = -1;
            } else {
                edgeCanvasState.lastFlatStyle = flatStyle;
                edgeCanvasState.lastFlatLayoutRev = layoutRev;
                edgeCanvasState.lastFlatColorRev = colorRev;
            }

            if (rgb !== edgeCanvasState.lastColorRgb || alphaByte !== edgeCanvasState.lastAlphaByte) {
                edgeCanvasState.lastColorRgb = rgb;
                edgeCanvasState.lastAlphaByte = alphaByte;
                const qAlpha = alphaByte / 255;
                const glowAlpha = qAlpha * 0.5;
                edgeCanvasState.glowStroke = `rgba(${rgb}, ${glowAlpha.toFixed(3)})`;
                edgeCanvasState.glowShadow = `rgba(${rgb}, ${Math.min(0.9, glowAlpha * 1.45).toFixed(3)})`;
                edgeCanvasState.mainStroke = `rgba(${rgb}, ${qAlpha.toFixed(3)})`;
                edgeCanvasState.mainShadow = `rgba(${rgb}, ${Math.min(0.9, qAlpha * 1.45).toFixed(3)})`;
            }
            drawSide(edgeStrips.top, top, mTop, wasBlank, flatStyle, layoutRev, colorRev, lightGlow);
            drawSide(edgeStrips.right, right, mRight, wasBlank, flatStyle, layoutRev, colorRev, lightGlow);
            drawSide(edgeStrips.bottom, bottom, mBottom, wasBlank, flatStyle, layoutRev, colorRev, lightGlow);
            drawSide(edgeStrips.left, left, mLeft, wasBlank, flatStyle, layoutRev, colorRev, lightGlow);
        };

        return {
            draw: drawEdgeSpectrum,
            invalidate: () => {
                rootSize = null;
                edgeCanvasState.width = 0;
                edgeCanvasState.height = 0;
                edgeCanvasState.layoutRev += 1;
                edgeCanvasState.lastFlatStyle = -1;
                for (let i = 0; i < EDGE_SIDES.length; i += 1) {
                    const strip = edgeStrips[EDGE_SIDES[i]];
                    if (strip) strip.flatStyle = -1;
                }
            },
            release
        };
    }

    global.MusicStageEdge = { create };
})(window);
