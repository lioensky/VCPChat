// Musicmodules/music-stage/music-stage-edge.js
// 舞台的边框频谱：窗口外圈四条细画布（每边一条，不铺满整窗），按频段画线、光晕，和绕边转的光。
// 宿主每帧调 draw(frame)；窗口尺寸变了调 invalidate()（舞台尺寸缓存和画布尺寸一起作废）；关掉舞台时 release() 把画布缩到 1×1 交还显存。
//
// 从 music-stage-host.js 拆出来，代码原样搬过来；宿主的 root、elements、state、scope 通过 create(ctx) 传进来。
(function (global) {
    'use strict';

    function create(ctx) {
        const { app, root, elements, state, scope, clamp } = ctx;

        // The spectrum lives in the outer band of the window, so each side has a
        // strip canvas of its own instead of one canvas the size of the window.
        const EDGE_SIDES = ['top', 'right', 'bottom', 'left'];
        const edgeStrips = {};
        EDGE_SIDES.forEach((side, index) => {
            const canvas = index === 0 ? elements.edgeCanvas : elements.edgeCanvas?.cloneNode(false);
            const context = canvas?.getContext?.('2d', { alpha: true });
            if (!canvas || !context) return;
            if (index > 0) elements.edgeCanvas.after(canvas);
            edgeStrips[side] = { canvas, context, x: 0, y: 0, width: 0, height: 0 };
        });
        const edgeContext = edgeStrips.left ? edgeStrips.top.context : null;
        // The orbiting light of the edge ring: its gradient is drawn once and
        // turned by the compositor, instead of the ring being restyled and its
        // masked gradient painted again at every step of the orbit.
        const edgeFlow = elements.edgeSpectrum?.querySelector('.music-stage-edge-flow');
        if (edgeFlow && !edgeFlow.querySelector('.music-stage-edge-flow-light')) {
            const light = document.createElement('div');
            light.className = 'music-stage-edge-flow-light';
            edgeFlow.prepend(light);
        }
        const prefersReducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const edgeCanvasState = {
            width: 0,
            height: 0,
            dpr: 1,
            drawnAt: 0,
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
                horizontalBand: Math.ceil(inset + horizontalAmplitude + 24),
                verticalBand: Math.ceil(inset + verticalAmplitude + 24) };
        };

        // Reading the stage's size every frame forces a layout every frame;
        // keep it from the resize observer and read it only when unknown.
        let rootSize = null;
        if (global.ResizeObserver) {
            const observer = new global.ResizeObserver(() => { rootSize = null; });
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
            // A glowing line gains nothing from more than this.
            const dpr = Math.min(1.5, frame.viewport?.dpr || global.devicePixelRatio || 1);
            if (
                edgeCanvasState.width !== width
                || edgeCanvasState.height !== height
                || edgeCanvasState.dpr !== dpr
            ) {
                const { horizontalBand, verticalBand } = edgeMetrics(width, height);
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
                });
                edgeCanvasState.width = width;
                edgeCanvasState.height = height;
                edgeCanvasState.dpr = dpr;
                edgeCanvasState.drawnAt = 0;
                edgeCanvasState.pausedAt = 0;
                edgeCanvasState.blank = false;
            }
            return true;
        };

        const clearEdgeStrips = () => EDGE_SIDES.forEach((side) => {
            const strip = edgeStrips[side];
            strip.context.clearRect(strip.x, strip.y, strip.width, strip.height);
        });

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

        const strokeEdgePath = (edgeContext, points, color, alpha, blur) => {
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
            if (state.config.edgeSpectrum === false) return;
            if (!resizeEdgeCanvas(frame) || !edgeContext) return;
            const { width, height } = edgeCanvasState;
            if (prefersReducedMotion?.matches || !frame.audio.spectrum?.length) {
                if (!edgeCanvasState.blank) clearEdgeStrips();
                edgeCanvasState.blank = true;
                return;
            }
            // A paused stage holds a faint, still line: let it settle for a
            // moment after the pause, then leave the canvases alone.
            const now = performance.now();
            if (frame.isPlaying) edgeCanvasState.pausedAt = 0;
            else {
                edgeCanvasState.pausedAt ||= now;
                if (now - edgeCanvasState.pausedAt > 1500 && !edgeCanvasState.blank) return;
                if (now - edgeCanvasState.drawnAt < 250) return;
            }
            edgeCanvasState.drawnAt = now;
            edgeCanvasState.blank = false;
            clearEdgeStrips();

            const spectrum = frame.audio.spectrum;
            const color = global.MusicStageModeUtils.resolveAccent(app);
            const { inset, horizontalAmplitude, verticalAmplitude } = edgeMetrics(width, height);
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
            // The wide soft pass stands in for the glow filters the canvas used to have.
            [['top', top], ['right', right], ['bottom', bottom], ['left', left]].forEach(([side, points]) => {
                const context = edgeStrips[side].context;
                strokeEdgePath(context, points, color, alpha * 0.5, 18);
                strokeEdgePath(context, points, color, alpha, 3.5);
            });
        };

        return {
            draw: drawEdgeSpectrum,
            invalidate: () => { rootSize = null; edgeCanvasState.width = 0; edgeCanvasState.height = 0; },
            release: () => {
                EDGE_SIDES.forEach((side) => {
                    const strip = edgeStrips[side];
                    if (!strip) return;
                    strip.canvas.width = 1;
                    strip.canvas.height = 1;
                });
            }
        };
    }

    global.MusicStageEdge = { create };
})(window);
