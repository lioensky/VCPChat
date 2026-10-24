import test from 'node:test';
import assert from 'node:assert/strict';
import { live2DFailureText, vowelParamsOf } from '../DeskPetmodules/live2dBackend.js';
import { paramTargets, EMOTION_PARAMS, EMOTION_LABEL, EMOTION_EMOJI, EMOTION_RING } from '../DeskPetmodules/emotionLook.js';
import { fpsTier, FPS, FPS_SOFTWARE, createPixiStage, createFigureFit } from '../DeskPetmodules/petStage.js';
import { EMOTION_KEYS } from '../DeskPetmodules/expressionMap.js';

test('a broken Live2D model is explained in words, not loader URLs', () => {
    const missing = live2DFailureText(new Error('Failed to load texture vcp-deskpet://pet/agent/Nova/deskpet/tech/textures/texture_00.png: 404 Not Found'));
    assert.match(missing, /缺贴图（texture_00\.png）/);
    assert.match(live2DFailureText(new Error('Unexpected token < in JSON at position 0')), /\.model3\.json 读不了/);
    assert.match(live2DFailureText(new Error('createModel failed: Invalid moc3')), /\.moc3 文件读不了/);
    const other = live2DFailureText(new Error('boom at vcp-deskpet://pet/agent/Nova/deskpet/x.model3'));
    assert.doesNotMatch(other, /vcp-deskpet:/);
    assert.equal(live2DFailureText(null), 'Live2D 模型载入失败，先用立绘代替');
});

test('vowel mouth shapes are used only when a, i and u are all there', () => {
    assert.deepEqual(vowelParamsOf(new Set(['ParamA', 'ParamI', 'ParamU', 'ParamE', 'ParamO'])).map((p) => p.vowel), ['a', 'i', 'u', 'e', 'o']);
    assert.deepEqual(vowelParamsOf(new Set(['ParamMouthA', 'ParamMouthI', 'ParamMouthU'])).map((p) => p.id), ['ParamMouthA', 'ParamMouthI', 'ParamMouthU']);
    // 只有一两个对得上多半是巧合
    assert.deepEqual(vowelParamsOf(new Set(['ParamA', 'ParamO', 'ParamAngleX'])), []);
});

test('parameter targets scale the emotion by intensity and add the state on top', () => {
    const happy = paramTargets({ emotion: 'happy', intensity: 0.5, state: null });
    assert.equal(happy.ParamMouthForm, 0.5);
    // 强度太低也至少看得出来（0.3），太高不超过 1
    assert.equal(paramTargets({ emotion: 'happy', intensity: 0.05 }).ParamMouthForm, 0.3);
    assert.equal(paramTargets({ emotion: 'happy', intensity: 4 }).ParamMouthForm, 1);
    const thinking = paramTargets({ emotion: 'curious', intensity: 1, state: 'thinking' });
    assert.equal(thinking.ParamAngleZ, EMOTION_PARAMS.curious.ParamAngleZ + -6);
    assert.deepEqual(paramTargets({ emotion: 'unknown', intensity: 1 }), {});
});

test('every emotion has a label, an emoji, a ring colour and a parameter set', () => {
    for (const key of EMOTION_KEYS) {
        assert.ok(EMOTION_LABEL[key], `${key} label`);
        assert.ok(EMOTION_EMOJI[key], `${key} emoji`);
        assert.ok(EMOTION_RING[key], `${key} ring`);
        assert.ok(EMOTION_PARAMS[key], `${key} params`);
    }
});

test('frame-rate tiers: old true/false still work and software rendering is always slower', () => {
    assert.equal(fpsTier(true), 'active');
    assert.equal(fpsTier(false), 'idle');
    assert.equal(fpsTier('sleep'), 'sleep');
    assert.equal(fpsTier('anything'), 'active');
    for (const tier of ['active', 'idle', 'sleep']) assert.ok(FPS_SOFTWARE[tier] < FPS[tier]);
});

test('Pixi resources dispose once on success, initialization failure and mount failure', async (t) => {
    const old = { PIXI: globalThis.PIXI, document: globalThis.document, window: globalThis.window };
    t.after(() => Object.assign(globalThis, old));
    globalThis.window = { devicePixelRatio: 1 };
    globalThis.document = { createElement: () => ({ getContext: () => ({ getExtension: () => null, getParameter: () => 'GPU' }) }) };
    let initialized, destroyed, failInit = false, released;
    globalThis.PIXI = { Application: class {
        constructor() { this.ticker = {}; }
        async init() { initialized++; if (failInit) throw Error('init failed'); }
        destroy() { destroyed++; }
    } };
    const listeners = new Map();
    const canvas = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
    initialized = destroyed = released = 0;
    const backend = await createPixiStage(canvas, { mount: async () => ({ kind: 'test', destroy: () => { released++; } }) });
    backend.destroy(); backend.destroy();
    assert.equal(released, 1); assert.equal(destroyed, 1); assert.equal(listeners.size, 0);
    failInit = true;
    await assert.rejects(createPixiStage(canvas, { mount: async () => ({}) }), /init failed/);
    assert.equal(destroyed, 2); assert.equal(listeners.size, 0);
    failInit = false;
    await assert.rejects(createPixiStage(canvas, { mount: async () => { throw Error('mount failed'); } }), /mount failed/);
    assert.equal(destroyed, 3); assert.equal(listeners.size, 0);
});

test('disposing figure measurement removes resize hooks and settles pending work', async (t) => {
    const old = globalThis.window;
    t.after(() => { globalThis.window = old; });
    const listeners = new Set();
    globalThis.window = { innerWidth: 360, innerHeight: 480, addEventListener: (_event, fn) => listeners.add(fn), removeEventListener: (_event, fn) => listeners.delete(fn) };
    const figure = createFigureFit({}, { style: {} }, { width: 200, height: 300, apply() {} });
    assert.equal(listeners.size, 1);
    figure.dispose(); figure.dispose();
    assert.equal(listeners.size, 0); assert.equal(await figure.ready, null);
});
