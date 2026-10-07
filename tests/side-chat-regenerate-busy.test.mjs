import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick } from './helpers/side-chat-surface-fixture.mjs';

// 重新回复先要把截断后的历史落盘；这期间按回车不能另起一轮，否则两轮抢同一个停止按钮，
// 先结束的那轮会把还在生成的那轮的停止按钮藏掉、把内存里的新提问冲掉
test('Enter during regenerate\'s history save does not start a second send', async t => {
    const seed = [{ id: 'u1', role: 'user', content: 'q', timestamp: 1 }, { id: 'a1', role: 'assistant', content: 'a', timestamp: 2 }];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let first = true;
    const f = await fixture(t, { stream: true, seed, onSave: async () => { if (first) { first = false; await gate; } return null; } });
    f.doc.querySelector('[data-message-id="a1"]').dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    f.doc.querySelector('[data-side-chat-action="regenerate"]').click();
    await tick();
    assert.equal(f.form.hasAttribute('aria-busy'), true, 'busy from the start of the regenerate');
    f.submit('new question');
    await tick(); await tick();
    release();
    for (let i = 0; i < 60; i++) await tick();
    assert.equal(f.requests.length, 1, 'only the regenerated question is sent');
    assert.equal(f.form.hasAttribute('aria-busy'), true, 'still generating');
    assert.equal(f.doc.querySelector('.side-chat-stop-btn').hidden, false, 'stop stays available');
    assert.doesNotMatch(f.statusText(), /发送失败/);
});

test('a failed regenerate save releases the composer', async t => {
    const seed = [{ id: 'u1', role: 'user', content: 'q', timestamp: 1 }, { id: 'a1', role: 'assistant', content: 'a', timestamp: 2 }];
    const f = await fixture(t, { stream: true, seed, onSave: async () => ({ success: false, error: 'disk full' }) });
    f.doc.querySelector('[data-message-id="a1"]').dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    f.doc.querySelector('[data-side-chat-action="regenerate"]').click();
    for (let i = 0; i < 10; i++) await tick();
    assert.match(f.statusText(), /重新回复失败/);
    assert.equal(f.form.hasAttribute('aria-busy'), false);
    assert.equal(f.textarea.disabled, false);
});

test('picking a model clears the "pick a model first" error', async t => {
    const f = await fixture(t, { model: '' });
    f.textarea.value = 'hi';
    f.textarea.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    assert.equal(f.statusText(), '请先选择模型');
    f.doc.querySelector('.side-chat-model-picker-btn').click();
    for (let i = 0; i < 5; i++) await tick();
    f.doc.querySelector('.side-chat-model-item[data-model="gpt-x"]').click();
    for (let i = 0; i < 5; i++) await tick();
    assert.notEqual(f.statusText(), '请先选择模型');
    assert.equal(f.doc.querySelector('.side-chat-status-text').classList.contains('error'), false);
});
