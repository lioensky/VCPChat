import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { compactionSettings, createCheckpointMessage, DEFAULT_COMPACTION_PROMPT, DEFAULT_COMPACTION_SEND_PROMPT, DEFAULT_COMPACTION_MAIN_PROMPT } from '../modules/chat/contextCompactionPrompts.js';
import { advancedFeaturesSection } from '../modules/settings/schema/advanced-features.js';
import { renderSchemaSection } from '../modules/settings/render/field-renderer.js';
import { syncDependentRows } from '../modules/ui-system/settings/dependent-rows.js';
import { createMessageContextMenu } from '../modules/renderer/messageContextMenu.js';
import { createSingleChatRequestOrchestrator } from '../modules/chat/singleChatRequestOrchestrator.js';

const state = { diaries: [], warnings: [], sourceCount: 1 };
const response = '<context_checkpoint>状态</context_checkpoint>';

test('empty and whitespace prompts use execution defaults without changing custom text', () => {
    const config = compactionSettings({
        contextCompactionPrompt: ' \n', contextCompactionSendPrompt: '', contextCompactionMainPrompt: '\t',
    });
    assert.equal(config.prompt, DEFAULT_COMPACTION_PROMPT);
    assert.equal(config.sendPrompt, DEFAULT_COMPACTION_SEND_PROMPT);
    assert.equal(config.mainPrompt, DEFAULT_COMPACTION_MAIN_PROMPT);
    assert.equal(compactionSettings({ contextCompactionPrompt: '  custom\n' }).prompt, '  custom\n');
});

test('compaction settings declare dependencies and show empty-default guidance on all three prompts', () => {
    const dom = new JSDOM('<form></form>');
    const form = dom.window.document.querySelector('form');
    const previousDocument = globalThis.document;
    globalThis.document = dom.window.document;
    try {
        form.append(...renderSchemaSection(advancedFeaturesSection, dom.window.document));
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
    const ids = ['contextCompactionModel', 'contextCompactionPrompt', 'contextCompactionSendPrompt', 'contextCompactionMainPrompt'];
    for (const enabled of [false, true, false]) {
        form.querySelector('#enableContextCompaction').checked = enabled;
        syncDependentRows(form);
        for (const id of ids) {
            const control = form.querySelector(`#${id}`);
            const row = control.closest('[data-visible-when]');
            assert.equal(row.dataset.visibleWhen, 'enableContextCompaction');
            assert.equal(row.style.display, enabled ? '' : 'none');
            if (control.tagName === 'TEXTAREA') {
                assert.equal(control.value, '');
                assert.match(control.placeholder, /留空使用默认/);
                assert.match(row.textContent, /留空使用默认/);
            }
        }
    }
    dom.window.close();
});

test('latest diaries are Markdown with verbatim bodies while replay metadata remains structured', () => {
    const body = '\r\n# 原始标题\r\n  - "引号" 与 $&\n```text\n原文\n```\n  ';
    const diaries = [
        { fileName: 'a.md', agent: 'Nova', content: body, tag: '工程' },
        { fileName: 'b.md', content: '**第二本**\n正文' },
    ];
    const message = createCheckpointMessage({ ...state, diaries }, response);
    assert.ok(message.content.includes(body));
    assert.match(message.content, /### 日记 1/);
    assert.match(message.content, /### 日记 2/);
    assert.match(message.content, /Tag:工程/);
    assert.ok(!message.content.includes(JSON.stringify(diaries, null, 2)));
    assert.deepEqual(message.contextCompaction.diaries, diaries);
});

test('manual compaction menu includes a matching icon and remains absent from groups', async () => {
    const dom = new JSDOM('<div id="chat"><article class="message-item"></article></div>');
    let type = 'agent';
    let calls = 0;
    const menu = createMessageContextMenu();
    const message = { id: 'm', role: 'user', content: 'hello' };
    menu.initializeContextMenu({
        chatMessagesDiv: dom.window.document.querySelector('#chat'),
        currentChatHistoryRef: { get: () => [message] },
        currentSelectedItemRef: { get: () => ({ id: 'a', type }) },
        currentTopicIdRef: { get: () => 't' },
        uiHelper: { showToastNotification() {} },
    }, { compactContext: async () => { calls++; } });
    const show = () => menu.showContextMenu({ clientX: 10, clientY: 10 },
        dom.window.document.querySelector('article'), message);
    show();
    const option = [...dom.window.document.querySelectorAll('.context-menu-item')]
        .find(node => node.textContent.includes('压缩前文'));
    assert.ok(option.querySelector('i.fas.fa-compress-alt[aria-hidden="true"]'));
    await option.onclick();
    assert.equal(calls, 1);
    type = 'group';
    show();
    assert.ok(!dom.window.document.querySelector('#chatContextMenu').textContent.includes('压缩前文'));
    menu.dispose();
    dom.window.close();
});

test('automatic checkpoint reply bypasses Tavern user suffix and preserves raw diary content', async () => {
    const checkpoint = createCheckpointMessage(state, response, {}, { id: 'checkpoint' });
    let suffixCalls = 0;
    const orchestrator = createSingleChatRequestOrchestrator({
        electronAPI: {},
        tavernEngine: {
            applyUserSuffix() { suffixCalls++; return 'changed'; },
            applySystemSuffix: text => text,
            applyContextInject: messages => messages,
        },
    });
    const request = await orchestrator.buildRequest({
        settings: {}, agentConfig: {}, history: [checkpoint], messageId: 'reply',
        currentUserMessageId: checkpoint.id, context: { agentId: 'a', topicId: 't' },
        tavernRules: [{ enabled: true, type: 'user_suffix' }],
    });
    assert.equal(suffixCalls, 0);
    assert.equal(request.messages[0].content[0].text, checkpoint.content);
});