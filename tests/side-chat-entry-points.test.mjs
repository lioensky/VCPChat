import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../main.html', import.meta.url), 'utf8');

test('the selection "ask in side pane" button survives message-list re-renders', () => {
    const { document } = new JSDOM(html).window;
    const button = document.getElementById('floatingSelectionSideChatBtn');
    assert.ok(button, 'button exists in main.html');
    // #chatMessages 会被整体清空重绘，按钮放在里面会跟着消失
    assert.equal(button.closest('#chatMessages'), null);
    // lucide 适配器只替换 .vcp-ui-scope 里的图标
    assert.ok(button.classList.contains('vcp-ui-scope') || button.closest('.vcp-ui-scope'));

    // 初始隐藏，选中消息文字后才出现；点它打开侧聊的行为见 side-chat-model-and-context.test.mjs
    assert.equal(button.hidden, true);

    const list = document.getElementById('chatMessages');
    list.innerHTML = '';
    assert.ok(document.getElementById('floatingSelectionSideChatBtn'));
});
