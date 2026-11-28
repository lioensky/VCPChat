/*
 * 墨痕的渲染器（PixiJS）：三遍画面都交给 Pixi 的渲染器画，着色器还是墨痕自己的。
 *
 *   逐字层   每个字一个实例化的四边形，加法混合画进墨场（半浮点离屏图，和画布一样大）
 *   平滑场   低分辨率、一次写两张图（墨团/冲击环/云，和流场的位移）
 *   主遍     按画布原生像素：阈值、网点、颗粒、纸纹、墨漫、扫笔、压印
 *
 * 渲染器从 MusicStagePixiEffects.createApplication 拿，舞台关掉后会停放一会儿：
 * 短时间内切回墨痕时，上下文和编译好的着色器都还在。
 *
 * 这里只管显卡资源和三遍的顺序；每帧的参数由 inkdraft-manager.js 写进 uniforms / glyphUniforms。
 */
(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    if (!Utils) throw new Error('MusicStageModeUtils must load before inkdraft-pixi.js');

    // 浮点转半浮点（就近舍入、遇半取偶，和显卡驱动上传 R16F 时做的一样）
    const toHalf = (() => {
        const f32 = new Float32Array(1);
        const u32 = new Uint32Array(f32.buffer);
        const roundEven = (v) => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 ? r - 1 : r; };
        return (value) => {
            if (!(value > 0)) return 0;
            if (value < 6.103515625e-5) return roundEven(value * 16777216);   // 比 2^-14 小：非规格数
            f32[0] = value;
            const bits = u32[0];
            const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
            if (exponent >= 31) return 0x7c00;
            const mantissa = bits & 0x7fffff;
            let half = (exponent << 10) | (mantissa >>> 13);
            const rest = mantissa & 0x1fff;
            if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half += 1;
            return half;
        };
    })();

    // 每个渲染器一张噪声图、一张纸纹；渲染器停放后再被拿去用时不用重传
    const sharedTextures = new WeakMap();
    const warmedRenderers = new WeakSet();
    const programs = new WeakMap();

    const create = (PIXI, app, spec) => {
        const renderer = app.renderer;
        const gl = renderer.gl;
        if (!gl || renderer.context?.webGLVersion !== 2) return null;
        const { limits, glyphFloats, buffers } = spec;
        // 字图集是两通道、宽度不一定是 4 的倍数
        const alignRows = () => gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        alignRows();

        const style = (filter, { mip = false, repeat = false } = {}) => ({
            resolution: 1,
            alphaMode: 'no-premultiply-alpha',
            scaleMode: filter,
            mipmapFilter: mip ? 'linear' : 'nearest',
            autoGenerateMipmaps: mip,
            addressMode: repeat ? 'repeat' : 'clamp-to-edge',
            autoGarbageCollect: false
        });
        // 传上显卡；这些图的来源（两张共用的画布、用完就丢的数组）之后会变，不能让 Pixi 自己回收再重传
        const upload = (source) => {
            source.autoGarbageCollect = false;
            alignRows();
            renderer.texture.initSource(source);
            return source;
        };

        let cache = programs.get(PIXI);
        if (!cache) {
            cache = {
                main: PIXI.GlProgram.from({ vertex: spec.vertex, fragment: spec.fragment, name: 'inkdraft-main' }),
                smooth: PIXI.GlProgram.from({ vertex: spec.vertex, fragment: spec.smoothFragment, name: 'inkdraft-smooth' }),
                glyph: PIXI.GlProgram.from({ vertex: spec.glyphVertex, fragment: spec.glyphFragment, name: 'inkdraft-glyph' })
            };
            programs.set(PIXI, cache);
        }

        let textures = sharedTextures.get(renderer);
        if (!textures) {
            const pixels = Utils.noisePixels();
            const half = new Uint16Array(pixels.data.length);
            for (let i = 0; i < half.length; i += 1) half[i] = toHalf(pixels.data[i]);
            textures = {
                noise: upload(new PIXI.BufferImageSource({
                    resource: half, width: pixels.size, height: pixels.size, format: 'r16float', ...style('linear', { repeat: true })
                })),
                paper: upload(new PIXI.BufferImageSource({
                    resource: spec.paperTile.data, width: spec.paperTile.size, height: spec.paperTile.size, format: 'r8unorm', ...style('linear', { repeat: true })
                }))
            };
            sharedTextures.set(renderer, textures);
        }

        // 墨场：能渲染半浮点就用半浮点（几个字的墨叠起来能超过 1）
        const halfFloat = Boolean(renderer.context.extensions?.colorBufferFloat || gl.getExtension('EXT_color_buffer_half_float'));
        const target = (format) => new PIXI.TextureSource({ width: 1, height: 1, format, antialias: false, ...style('linear') });
        const field = new PIXI.Texture({ source: target(halfFloat ? 'rgba16float' : 'rgba8unorm') });
        const smoothField = target(halfFloat ? 'rgba16float' : 'rgba8unorm');
        const smoothWarp = target('rgba8unorm');
        const smoothTarget = new PIXI.RenderTarget({ colorTextures: [smoothField, smoothWarp] });

        const f32 = (value = 0) => ({ value, type: 'f32' });
        const vec = (n, value) => ({ value: value || new Float32Array(n), type: `vec${n}<f32>` });
        const list = (value, size) => ({ value, type: 'vec4<f32>', size });
        const shared = new PIXI.UniformGroup({
            uRes: vec(2), uWorld: vec(2), uIdSize: vec(2), uView: vec(4), uPrevView: vec(4), uPrevFade: f32(), uAspect: f32(1), uTime: f32(),
            uStroke: vec(2), uTone: f32(),
            uBlobs: list(buffers.blobs, limits.blobs), uBlobCount: { value: 0, type: 'i32' },
            uAccent: list(buffers.accents, limits.accents), uAccentCount: { value: 0, type: 'i32' },
            uRings: list(buffers.rings, limits.rings), uClouds: list(buffers.clouds, limits.clouds),
            uBlobCol: vec(3), uDotPx: f32(1), uDotAngle: f32(), uFlood: vec(4), uSmash: f32(), uSweep: vec(4), uCloud: f32(), uExit: f32(),
            uFlow: f32(), uFlowT: f32(), uGrainStep: f32(), uPaper: vec(3), uInk: vec(3), uAccentCol: vec(3), uKeywords: f32(), uDot: vec(3),
            uNeg: f32(), uHalftone: f32(), uGrain: f32(), uPaperGrain: f32(), uPress: f32(), uBeat: f32()
        });
        const glyphGroup = new PIXI.UniformGroup({
            uView: vec(4), uAspect: f32(1), uTime: f32(), uPop: f32(), uReveal: f32(), uCss: f32(1), uBleed: f32(), uWobble: f32()
        });
        const blank = PIXI.Texture.WHITE.source;
        // 取样器的先后别动：Pixi 按第一次见到的顺序给它们排纹理单元
        const mainShader = new PIXI.Shader({
            glProgram: cache.main,
            resources: {
                ink: shared, uMain: blank, uIds: blank, uGlyphF: field.source, uPrev: blank, uNoise: textures.noise,
                uSmooth: smoothField, uWarp: smoothWarp, uPaperTex: textures.paper
            }
        });
        const smoothShader = new PIXI.Shader({ glProgram: cache.smooth, resources: { ink: shared, uNoise: textures.noise } });
        const glyphShader = new PIXI.Shader({ glProgram: cache.glyph, resources: { glyph: glyphGroup, uAtlas: blank } });

        // 一个盖住全屏的三角形
        const triangle = new PIXI.Geometry({
            attributes: { aPosition: { buffer: new Float32Array([-1, -1, 3, -1, -1, 3]), format: 'float32x2' } }
        });
        const scene = (geometry, shader, blendMode) => {
            const mesh = new PIXI.Mesh({ geometry, shader });
            mesh.blendMode = blendMode;
            const root = new PIXI.Container();
            root.addChild(mesh);
            return root;
        };
        const mainScene = scene(triangle, mainShader, 'none');
        const smoothScene = scene(triangle, smoothShader, 'none');
        const emptyScene = new PIXI.Container();

        const stride = glyphFloats * 4;
        const slots = Array.from({ length: 3 }, () => {
            const buffer = new PIXI.Buffer({ data: new Float32Array(glyphFloats), usage: PIXI.BufferUsage.VERTEX | PIXI.BufferUsage.COPY_DST });
            const instanced = offset => ({ buffer, format: 'float32x4', stride, offset, instance: true });
            const geometry = new PIXI.Geometry({
                topology: 'triangle-strip',
                instanceCount: 1,
                attributes: {
                    aPosition: { buffer: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), format: 'float32x2' },
                    iA: instanced(0), iB: instanced(16), iR: instanced(32)
                }
            });
            return { key: null, data: null, used: 0, main: null, ids: null, atlas: null, buffer, geometry, scene: scene(geometry, glyphShader, 'add') };
        });

        const dropCanvases = (slot) => {
            slot.main?.destroy();
            slot.ids?.destroy();
            slot.main = slot.ids = null;
        };
        const canvasSource = (canvas, options) => new PIXI.CanvasSource({
            resource: canvas, width: canvas.width, height: canvas.height, autoDensity: false, ...options
        });

        const baseResolution = renderer.resolution;
        const CLEAR_ZERO = [0, 0, 0, 0];
        let destroyed = false;

        return {
            canvas: app.canvas,
            slots,
            uniforms: shared.uniforms,
            glyphUniforms: glyphGroup.uniforms,
            get width() { return app.canvas.width; },
            get height() { return app.canvas.height; },
            // 后台并行预热三套着色器，让首次 Pixi 渲染命中驱动缓存而不阻塞主线程
            async warm(isAlive = () => true) {
                if (destroyed || warmedRenderers.has(renderer)) return false;
                const ok = await global.MusicStageRuntime?.warmPrograms?.(
                    gl, [cache.glyph, cache.smooth, cache.main], () => !destroyed && isAlive()
                );
                if (ok) warmedRenderers.add(renderer);
                return Boolean(ok);
            },
            // 画布的 CSS 大小 w×h、每个 CSS 像素 scale 个缓冲像素
            resize(w, h, scale) {
                if (renderer.resolution === scale && renderer.screen.width === w && renderer.screen.height === h) return false;
                renderer.resize(w, h, scale);
                // Pixi 按「缓冲像素 ÷ 分辨率」写的行内宽高会差出零点几个像素，画面被拉伸重采样；交回给样式表铺满
                app.canvas.style.width = '';
                app.canvas.style.height = '';
                return true;
            },
            // 两张画布换了大小：旧的画布纹理都作废
            resetCanvases() {
                slots.forEach((slot) => { dropCanvases(slot); slot.key = null; slot.data = null; });
            },
            // 一段准备好了：主图、编号图、字图集、逐字实例传上显卡
            fill(slot, mainCanvas, idsCanvas, data) {
                alignRows();
                if (slot.main && (slot.main.pixelWidth !== mainCanvas.width || slot.main.pixelHeight !== mainCanvas.height)) dropCanvases(slot);
                if (!slot.main) {
                    slot.main = upload(canvasSource(mainCanvas, style('linear', { mip: true })));
                    slot.ids = upload(canvasSource(idsCanvas, style('nearest')));
                } else {
                    slot.main.update();
                    slot.ids.update();
                }
                slot.atlas?.destroy();
                // 注记和远景里的小字会缩得比图集小很多：要 mip，不然闪烁、断笔
                slot.atlas = upload(new PIXI.BufferImageSource({
                    resource: data.atlas.data, width: data.atlas.width, height: data.atlas.height, format: 'rg8unorm', ...style('linear', { mip: true })
                }));
                slot.atlas.resource = null;   // 已经在显卡上了，这份数组不留
                if (data.glyphCount) {
                    slot.buffer.data = data.glyphInst;
                    slot.geometry.instanceCount = data.glyphCount;
                }
            },
            // 画一帧。smoothSize：平滑场的像素大小
            render(slot, prevSlot, smoothSize) {
                const width = app.canvas.width;
                const height = app.canvas.height;
                const u = shared.uniforms;
                if (field.source.pixelWidth !== width || field.source.pixelHeight !== height) field.source.resize(width, height, 1);
                if (slot.data.glyphCount) {
                    glyphShader.resources.uAtlas = slot.atlas;
                    renderer.render({ container: slot.scene, target: field, clear: true, clearColor: CLEAR_ZERO });
                } else {
                    renderer.render({ container: emptyScene, target: field, clear: true, clearColor: CLEAR_ZERO });
                }
                const [sw, sh] = smoothSize;
                if (smoothField.pixelWidth !== sw || smoothField.pixelHeight !== sh) smoothTarget.resize(sw, sh, 1);
                u.uRes[0] = sw; u.uRes[1] = sh; u.uAspect = sw / sh;
                renderer.render({ container: smoothScene, target: smoothTarget, clear: false });
                u.uRes[0] = width; u.uRes[1] = height; u.uAspect = width / height;
                mainShader.resources.uMain = slot.main;
                mainShader.resources.uIds = slot.ids;
                mainShader.resources.uPrev = (prevSlot || slot).main;
                renderer.render({ container: mainScene, clear: false });
            },
            destroy() {
                if (destroyed) return;
                destroyed = true;
                slots.forEach((slot) => {
                    dropCanvases(slot);
                    slot.atlas?.destroy();
                    slot.scene.destroy({ children: true });
                    slot.geometry.destroy(true);
                    slot.key = slot.data = slot.atlas = null;
                });
                mainScene.destroy({ children: true });
                smoothScene.destroy({ children: true });
                emptyScene.destroy();
                triangle.destroy(true);
                mainShader.destroy();
                smoothShader.destroy();
                glyphShader.destroy();
                field.destroy(true);
                smoothTarget.destroy();
                smoothField.destroy();
                smoothWarp.destroy();
                // 交还之前把分辨率改回去，下一个用这只渲染器的舞台按它自己的算
                try { renderer.resize(renderer.screen.width, renderer.screen.height, baseResolution); } catch (error) { /* 渲染器已经没了 */ }
            }
        };
    };

    global.MusicStageInkPixi = Object.freeze({ create, _test: Object.freeze({ toHalf }) });
})(window);
