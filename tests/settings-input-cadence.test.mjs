import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { classifyInput, isTextControl, TEXT_IDLE_DELAY_MS, DISCRETE_DELAY_MS } from '../modules/ui-system/settings/input-cadence.js';
import { mountSettingsAutosave, teardownLegacyAutosave } from '../modules/ui-system/settings/autosave.js';

const html = `<form id="f">
  <input id="name" type="text"><input id="key" type="password"><textarea id="prompt"></textarea>
  <input id="flag" type="checkbox"><select id="mode"><option>a</option><option>b</option></select>
  <button type="submit">save</button></form>`;

test('控件分类：文本类走空闲/提交，离散控件走400ms，组合输入跳过', () => {
    const { window: w } = new JSDOM(html);
    const $ = id => w.document.getElementById(id);
    assert.equal(isTextControl($('name')), true);
    assert.equal(isTextControl($('key')), true);
    assert.equal(isTextControl($('prompt')), true);
    assert.equal(isTextControl($('flag')), false);
    assert.equal(isTextControl($('mode')), false);
    assert.equal(classifyInput({ type: 'input', target: $('name') }), 'text-idle');
    assert.equal(classifyInput({ type: 'change', target: $('name') }), 'text-commit');
    assert.equal(classifyInput({ type: 'change', target: $('flag') }), 'discrete');
    assert.equal(classifyInput({ type: 'input', target: $('name'), isComposing: true }), 'skip');
    assert.equal(TEXT_IDLE_DELAY_MS, 1500);
    assert.equal(DISCRETE_DELAY_MS, 400);
    w.close();
});

test('整表单自动保存：打字只在空闲或失焦时写一次，输入法组合期间零写入', t => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { window: w } = new JSDOM(html);
    t.after(() => { teardownLegacyAutosave(); mock.timers.reset(); w.close(); });
    const form = w.document.getElementById('f');
    const $ = id => w.document.getElementById(id);
    let submits = 0;
    form.requestSubmit = () => { submits++; };
    const fire = (el, type, init = {}) => el.dispatchEvent(new w.Event(type, { bubbles: true, ...init }));
    const settle = () => form.dispatchEvent(new w.CustomEvent('vcp-settings-save-result', { detail: { success: true } }));
    mountSettingsAutosave(null, form, null, { fallbackMs: 60000 });

    // 连续打字：每次输入都重置空闲计时，停顿不足1500ms不写
    for (const value of ['s', 'sk', 'sk-1']) { $('key').value = value; fire($('key'), 'input'); mock.timers.tick(1000); }
    assert.equal(submits, 0);
    mock.timers.tick(500);
    assert.equal(submits, 1, '空闲1500ms兜底保存一次');
    settle();

    // 空闲保存后失焦，值没变：不重复写
    fire($('key'), 'change');
    mock.timers.tick(TEXT_IDLE_DELAY_MS);
    assert.equal(submits, 1);

    // 输入法组合：拼音中间态不保存，组合结束后按文本规则调度
    $('name').dispatchEvent(new w.CompositionEvent('compositionstart', { bubbles: true }));
    $('name').value = 'ni hao';
    $('name').dispatchEvent(new w.InputEvent('input', { bubbles: true, isComposing: true }));
    mock.timers.tick(5000);
    assert.equal(submits, 1, '组合输入期间零保存');
    $('name').value = '你好';
    $('name').dispatchEvent(new w.CompositionEvent('compositionend', { bubbles: true }));
    mock.timers.tick(TEXT_IDLE_DELAY_MS);
    assert.equal(submits, 2);
    settle();

    // 打字后立刻失焦：立即提交一次，空闲计时不再追加写入
    $('prompt').value = 'hello'; fire($('prompt'), 'input');
    fire($('prompt'), 'change');
    mock.timers.tick(0);
    assert.equal(submits, 3);
    settle();
    mock.timers.tick(TEXT_IDLE_DELAY_MS * 2);
    assert.equal(submits, 3);

    // 离散控件维持400ms
    $('flag').checked = true; fire($('flag'), 'change');
    mock.timers.tick(399);
    assert.equal(submits, 3);
    mock.timers.tick(1);
    assert.equal(submits, 4);
});