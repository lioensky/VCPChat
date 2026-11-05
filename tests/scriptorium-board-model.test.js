'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../ScriptoriumModules/scriptorium-board-model');
test('HTML node dimensions and source quota', () => {
    assert.equal(model.htmlNode({ source: '<b>动画</b>' }).width, 480);
    assert.throws(() => model.htmlNode({ width: NaN }), /宽高/);
    assert.throws(() => model.htmlNode({ height: 20 }), /宽高/);
    assert.throws(() => model.source('中'.repeat(model.MAX_SOURCE)), /512 KB/);
});
test('source replacements are exact, unique and atomic', () => {
    const original = '<h1>甲</h1><p>乙</p>';
    assert.equal(model.patchSource(original, [
        { target: '甲', replace: '丙' }, { target: '乙', replace: '丁' },
    ]), '<h1>丙</h1><p>丁</p>');
    assert.throws(() => model.patchSource('aaa', [{ target: 'aa', replace: 'x' }]), /不唯一/);
    assert.throws(() => model.patchSource(original, [
        { target: '<h1>甲', replace: '' }, { target: '甲</h1>', replace: '' },
    ]), /重叠/);
    assert.throws(() => model.patchSource(original, [{ target: '不存在', replace: '' }]), /找不到/);
});
test('sandbox is offline and snapshots exclude recursive lineage', () => {
    const html = model.sandboxDocument('<script>console.log(1)</script>');
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /frame-src 'none'/);
    assert.doesNotMatch(html, /unsafe-eval|allow-same-origin/);
    const scene = { elements: [{ id: 'a' }], vcpBoard: { history: ['large'] } };
    const snap = model.sceneSnapshot(scene);
    assert.equal(snap.vcpBoard, undefined);
    snap.elements[0].id = 'b';
    assert.equal(scene.elements[0].id, 'a');
});