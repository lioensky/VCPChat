'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../Gamemodules/forge-tax/engine');
const { formatResult } = require('../Gamemodules/forge-tax/tool-result.cjs');
test('文本块Markdown仅列一次最终状态，包含操作所需ID概率与商店', () => {
    const state = new Engine({ seed: 1 }).getState();
    const output = formatResult({
        ok: true, state,
        results: [1, 2].map(step => ({ step, command: 'GetState', ok: true, state, events: [] }))
    });
    assert.equal(output.content.length, 1);
    assert.equal(output.content[0].type, 'text');
    const text = output.content[0].text;
    assert.equal(text.split('### 背包').length - 1, 1);
    assert.ok(text.includes('s1') && text.includes('revision: 0'));
    assert.ok(text.includes('下一锤概率') && text.includes('### 遗物机'));
    assert.ok(!text.includes('"results":'));
});
test('部分失败保留回执及未执行列表，无局和开窗可格式化', () => {
    const text = formatResult({
        ok: false, partial: true, failedStep: 2, error: '剑不存在',
        results: [{ step: 1, command: 'BuyItem', ok: true },
            { step: 2, command: 'UseItem', ok: false, error: '剑不存在' }],
        skipped: [{ step: 3, command: 'Hammer' }], state: null
    }).content[0].text;
    assert.ok(text.includes('部分成功') && text.includes('3.Hammer'));
    assert.ok(text.includes('请勿整串重放'));
    assert.ok(formatResult({ ok: true, message: '观看窗口已打开' }).content[0].text.includes('观看窗口已打开'));
});