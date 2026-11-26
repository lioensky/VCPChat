const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
window.matchMedia = () => ({ matches: false });
const stage = path.resolve(__dirname, '..', 'Musicmodules', 'music-stage');
require(path.join(stage, 'music-stage-runtime.js'));
require(path.join(stage, 'modes', 'stage-mode-utils.js'));
require(path.join(stage, 'modes', 'inkdraft-pixi.js'));
const { create, _test: { toHalf } } = window.MusicStageInkPixi;

test('half floats round to nearest, ties to even', () => {
    assert.equal(toHalf(0), 0);
    assert.equal(toHalf(1), 0x3c00);
    assert.equal(toHalf(0.5), 0x3800);
    assert.equal(toHalf(1 / 3), 0x3555);
    assert.equal(toHalf(0.999999), 0x3c00, 'rounds up into the next exponent');
    assert.equal(toHalf(2 ** -24), 1, 'smallest subnormal');
    assert.equal(toHalf(2 ** -25), 0, 'a tie below the smallest subnormal goes to even');
    assert.equal(toHalf(1 + 2 ** -11), 0x3c00, 'tie, even mantissa stays');
    assert.equal(toHalf(1 + 3 * 2 ** -11), 0x3c02, 'tie, odd mantissa goes up');
});

// A stand-in renderer that records what the stage asks of it.
const fakePixi = () => {
    const log = { renders: [], destroyed: 0, live: 0, uploads: 0 };
    class Thing {
        constructor(options = {}) { Object.assign(this, options); log.live += 1; }
        destroy() { log.destroyed += 1; }
    }
    class Source extends Thing {
        constructor(options) { super(options); this.pixelWidth = options.width; this.pixelHeight = options.height; }
        resize(w, h) { this.pixelWidth = w; this.pixelHeight = h; }
        update() { log.uploads += 1; }
    }
    class UniformGroup { constructor(spec) { this.uniforms = Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v.value])); } }
    class Container extends Thing { addChild(child) { this.child = child; } }
    class RenderTarget extends Thing { resize(w, h) { this.colorTextures.forEach(t => t.resize(w, h)); } }
    const PIXI = {
        GlProgram: { from: options => ({ ...options }) },
        UniformGroup, Container, RenderTarget,
        Shader: class extends Thing { constructor(options) { super(options); this.resources = { ...options.resources }; } },
        Geometry: Thing, Mesh: Thing, Buffer: Thing,
        BufferUsage: { VERTEX: 32, COPY_DST: 8 },
        TextureSource: Source, CanvasSource: Source, BufferImageSource: Source,
        Texture: class extends Thing { static WHITE = { source: { white: true } }; }
    };
    const canvas = { width: 640, height: 360, style: {} };
    const renderer = {
        gl: { pixelStorei() {}, getExtension: () => null, UNPACK_ALIGNMENT: 1 },
        context: { webGLVersion: 2, extensions: { colorBufferFloat: {} } },
        texture: { initSource() { log.uploads += 1; } },
        resolution: 2,
        screen: { width: 320, height: 180 },
        resize(w, h, resolution) { this.screen = { width: w, height: h }; this.resolution = resolution; canvas.width = Math.round(w * resolution); canvas.height = Math.round(h * resolution); },
        render(options) { log.renders.push(options); }
    };
    return { PIXI, app: { renderer, canvas }, log };
};
const spec = () => ({
    vertex: 'v', fragment: 'f', smoothFragment: 's', glyphVertex: 'gv', glyphFragment: 'gf', glyphFloats: 12,
    limits: { blobs: 48, rings: 4, accents: 5, clouds: 6 },
    buffers: { blobs: new Float32Array(192), rings: new Float32Array(16), accents: new Float32Array(20), clouds: new Float32Array(24) },
    paperTile: { size: 4, data: new Uint8Array(16) }
});

test('no WebGL2 renderer: nothing is created', () => {
    const { PIXI, app } = fakePixi();
    app.renderer.context.webGLVersion = 1;
    assert.equal(create(PIXI, app, spec()), null);
});

test('a frame is three passes: glyphs into the field, the smooth field, then the screen', () => {
    const { PIXI, app, log } = fakePixi();
    const ink = create(PIXI, app, spec());
    assert.equal(ink.resize(640, 360, 1), true);
    assert.equal(ink.resize(640, 360, 1), false, 'same size again is not a resize');
    const slot = ink.slots[0];
    const main = { width: 2048, height: 1152 }, ids = { width: 1024, height: 576 };
    const data = { atlas: { data: new Uint8Array(8), width: 2, height: 2 }, glyphInst: new Float32Array(24), glyphCount: 2 };
    ink.fill(slot, main, ids, data);
    slot.data = data;
    assert.equal(slot.geometry.instanceCount, 2);
    assert.equal(slot.atlas.resource, null, 'the atlas pixels are not kept after upload');
    const firstMain = slot.main;
    ink.fill(slot, main, ids, data);
    assert.equal(slot.main, firstMain, 'the canvas textures are reused for the next line');

    ink.render(slot, null, [320, 180]);
    assert.equal(log.renders.length, 3);
    const [glyphs, smooth, screen] = log.renders;
    assert.equal(glyphs.container, slot.scene);
    assert.equal(glyphs.clear, true);
    assert.deepEqual([glyphs.target.source.pixelWidth, glyphs.target.source.pixelHeight], [640, 360]);
    assert.equal(smooth.target.colorTextures.length, 2, 'the smooth pass writes two images at once');
    assert.equal(smooth.target.colorTextures[0].pixelWidth, 320);
    assert.equal(screen.target, undefined, 'the last pass goes to the canvas');
    assert.deepEqual([...ink.uniforms.uRes], [640, 360], 'the screen pass sees the canvas size');

    // a line with no glyphs still clears the field
    log.renders.length = 0;
    slot.data = { glyphCount: 0 };
    ink.render(slot, null, [320, 180]);
    assert.notEqual(log.renders[0].container, slot.scene);
    assert.equal(log.renders[0].clear, true);

    ink.resetCanvases();
    assert.equal(slot.main, null);
    assert.equal(slot.key, null);
});

test('destroy hands the renderer back at the resolution it came with', () => {
    const { PIXI, app, log } = fakePixi();
    const ink = create(PIXI, app, spec());
    ink.resize(640, 360, 1);
    const before = log.destroyed;
    ink.destroy();
    ink.destroy();
    assert.equal(app.renderer.resolution, 2);
    assert.ok(log.destroyed - before >= 12, 'scenes, geometry, shaders and targets are released');
});
