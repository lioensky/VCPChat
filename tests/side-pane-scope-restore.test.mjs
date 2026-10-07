import test from 'node:test';
import assert from 'node:assert/strict';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { sideChatTab } from '../modules/ui-system/side-pane/tab-types/chat.js';

const topicA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
const topicB = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-b' };
const browser = { id: 'browser:1', kind: 'browser', title: '浏览器', closable: true, scopeMode: 'global' };
const chatOf = (parent) => ({
    id: `chat-${parent.topicId}`,
    title: '辅助对话',
    parent: { ...parent, name: 'Agent' },
    child: { itemType: 'agent', itemId: 'agent-1', topicId: `child-${parent.topicId}` },
    contextMode: 'references-only'
});

function setup() {
    let s = SidePaneState.setParent(SidePaneState.createInitialSidePaneState({ visible: true }), topicA);
    s = SidePaneState.openTab(s, browser);
    const chat = sideChatTab(chatOf(topicA), s.tabs);
    s = SidePaneState.openTab(s, chat);
    return { state: SidePaneState.activateTab(s, chat.id), chatId: chat.id };
}

test('returning to a topic restores its side chat even while a global tool filled in elsewhere', () => {
    const { state, chatId } = setup();
    // B 没有自己的标签，落到浏览器
    const onB = SidePaneState.setParent(state, topicB);
    assert.equal(onB.activeTabId, browser.id);
    assert.equal(onB.visible, true);
    // 回到 A：还原 A 上次停留的辅助对话，而不是继续停在浏览器
    const backOnA = SidePaneState.setParent(onB, topicA, { preferredTabId: chatId, collapsedPreference: false });
    assert.equal(backOnA.activeTabId, chatId);
    assert.equal(backOnA.visible, true);
});

test('a topic remembered as collapsed stays collapsed when its side chat is restored', () => {
    const { state, chatId } = setup();
    const onB = SidePaneState.setParent(state, topicB);
    const backOnA = SidePaneState.setParent(onB, topicA, { preferredTabId: chatId, collapsedPreference: true });
    assert.equal(backOnA.activeTabId, chatId);
    assert.equal(backOnA.visible, false);
});

test('a global tool keeps the pane state when no topic tab is remembered', () => {
    const { state } = setup();
    const onBrowser = SidePaneState.activateTab(state, browser.id);
    const onB = SidePaneState.setParent(onBrowser, topicB);
    assert.equal(onB.activeTabId, browser.id);
    const backOnA = SidePaneState.setParent(onB, topicA, { preferredTabId: browser.id, collapsedPreference: true });
    assert.equal(backOnA.activeTabId, browser.id);
    // 全局工具不跟着话题的收起偏好走
    assert.equal(backOnA.visible, true);
});

test('another topic\'s side chat is never restored as the preferred tab', () => {
    const { state, chatId } = setup();
    const onB = SidePaneState.setParent(state, topicB, { preferredTabId: chatId });
    assert.equal(onB.activeTabId, browser.id);
});
