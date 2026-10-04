import test from 'node:test';
import assert from 'node:assert/strict';
import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { sideChatTab } from '../modules/ui-system/side-pane/tab-types/chat.js';

const openChat = (state, descriptor) => SidePaneState.openTab(state, sideChatTab(descriptor, state.tabs));

test('createInitialSidePaneState provides immutable defaults with notifications tab', () => {
    const state = SidePaneState.createInitialSidePaneState();
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.visible, false);
    assert.equal(state.preferredWidth, 360);
    assert.equal(state.activeTabId, 'notifications');
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0].id, 'notifications');
    assert.equal(state.parent, null);
    assert.ok(Object.isFrozen(state));
    assert.ok(Object.isFrozen(state.tabs));
});

test('setVisible returns new frozen snapshot', () => {
    const s0 = SidePaneState.createInitialSidePaneState();
    const s1 = SidePaneState.setVisible(s0, true);
    assert.equal(s1.visible, true);
    assert.notEqual(s0, s1);
    assert.ok(Object.isFrozen(s1));

    // Idempotent when setting same visibility
    const s2 = SidePaneState.setVisible(s1, true);
    assert.equal(s1, s2);
});

test('setPreferredWidth clamps to bounds', () => {
    const s0 = SidePaneState.createInitialSidePaneState();
    const sSmall = SidePaneState.setPreferredWidth(s0, 100);
    assert.equal(sSmall.preferredWidth, 240); // default MIN_WIDTH

    const sLarge = SidePaneState.setPreferredWidth(s0, 1200);
    assert.equal(sLarge.preferredWidth, 800); // default MAX_WIDTH

    const sCustom = SidePaneState.setPreferredWidth(s0, 500, { min: 300, max: 600 });
    assert.equal(sCustom.preferredWidth, 500);
});

test('chat tab type validates the descriptor and reuses the tab of an open child topic', () => {
    const s0 = SidePaneState.createInitialSidePaneState();

    assert.throws(() => {
        openChat(s0, { id: 'invalid' });
    }, /SideChatDescriptor requires a parent conversation reference/);

    assert.throws(() => {
        openChat(s0, {
            id: 'invalid-same',
            parent: { itemType: 'agent', itemId: 'a', topicId: 'same' },
            child: { itemType: 'agent', itemId: 'a', topicId: 'same' },
        });
    }, /Child topicId must differ from parent topicId/);

    const desc1 = {
        id: 'side-1',
        parent: { itemType: 'agent', itemId: 'agent-1', topicId: 'parent-topic' },
        child: { itemType: 'agent', itemId: 'agent-1', topicId: 'child-topic-1' },
        title: '侧聊 1',
    };

    const s1 = openChat(s0, desc1);
    assert.equal(s1.visible, true);
    assert.equal(s1.activeTabId, 'side-1');
    assert.equal(s1.tabs.length, 2);
    assert.equal(s1.tabs[1].id, 'side-1');
    assert.equal(s1.tabs[1].kind, 'chat');

    // Opening with same id or child topicId activates existing tab without adding new one
    const s2 = openChat(s1, { ...desc1, id: 'side-1-duplicate' });
    assert.equal(s2.tabs.length, 2);
    assert.equal(s2.activeTabId, 'side-1');
});

test('closeTab handles fallback and protects notifications tab', () => {
    const s0 = SidePaneState.createInitialSidePaneState();

    // Cannot close notifications
    const sCannotClose = SidePaneState.closeTab(s0, 'notifications');
    assert.equal(sCannotClose, s0);

    const desc1 = {
        id: 'side-1',
        parent: { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-p' },
        child: { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-c1' },
        title: '侧聊 1',
    };
    const desc2 = {
        id: 'side-2',
        parent: { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-p' },
        child: { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-c2' },
        title: '侧聊 2',
    };

    let state = openChat(s0, desc1);
    state = openChat(state, desc2);
    assert.equal(state.tabs.length, 3);
    assert.equal(state.activeTabId, 'side-2');

    // Closing active side-2 should fallback to previous tab (side-1)
    state = SidePaneState.closeTab(state, 'side-2');
    assert.equal(state.tabs.length, 2);
    assert.equal(state.activeTabId, 'side-1');

    // Closing active side-1 should fallback to notifications
    state = SidePaneState.closeTab(state, 'side-1');
    assert.equal(state.tabs.length, 1);
    assert.equal(state.activeTabId, 'notifications');
});

test('getVisibleTabs filters chat tabs by parent conversation reference', () => {
    const parentA = { itemType: 'agent', itemId: 'agent-a', topicId: 'topic-a' };
    const parentB = { itemType: 'agent', itemId: 'agent-b', topicId: 'topic-b' };

    let state = SidePaneState.createInitialSidePaneState();
    state = openChat(state, {
        id: 'side-a1',
        parent: parentA,
        child: { itemType: 'agent', itemId: 'agent-a', topicId: 'child-a1' },
        title: 'A1',
    });
    state = openChat(state, {
        id: 'side-b1',
        parent: parentB,
        child: { itemType: 'agent', itemId: 'agent-b', topicId: 'child-b1' },
        title: 'B1',
    });

    assert.equal(state.tabs.length, 3); // notifications, side-a1, side-b1

    const visibleA = SidePaneState.getVisibleTabs(state, parentA);
    assert.deepEqual(visibleA.map(t => t.id), ['notifications', 'side-a1']);

    const visibleB = SidePaneState.getVisibleTabs(state, parentB);
    assert.deepEqual(visibleB.map(t => t.id), ['notifications', 'side-b1']);

    const all = SidePaneState.getVisibleTabs(state, null);
    assert.equal(all.length, 3);
});

test('global tools retain selection and visibility across topic changes', () => {
 let state=SidePaneState.createInitialSidePaneState();
 state=SidePaneState.openTab(state,{id:'git-global',kind:'git',scopeMode:'global'});
 state=SidePaneState.setParent(state,{itemId:'a',topicId:'new',itemType:'agent'});
 assert.equal(state.activeTabId,'git-global');assert.equal(state.visible,true);
 state=SidePaneState.setVisible(state,false);
 state=SidePaneState.setParent(state,{itemId:'b',topicId:'other',itemType:'agent'});
 assert.equal(state.activeTabId,'git-global');assert.equal(state.visible,false);
});

test('updateTab changes title and payload without activating the tab', () => {
    let s = SidePaneState.openTab(SidePaneState.createInitialSidePaneState(), { id: 'b1', kind: 'browser', title: '浏览器', payload: {} });
    s = SidePaneState.openTab(s, { id: 'n1', kind: 'notes', title: '笔记' });
    const next = SidePaneState.updateTab(s, 'b1', { title: '  Example Domain ', payload: { url: 'https://example.com/' } });
    assert.equal(next.activeTabId, 'n1');
    const tab = next.tabs.find(t => t.id === 'b1');
    assert.equal(tab.title, 'Example Domain');
    assert.deepEqual(tab.payload, { url: 'https://example.com/' });
    assert.ok(Object.isFrozen(tab));
    assert.equal(SidePaneState.updateTab(next, 'b1', { title: '' }), next, 'empty title is ignored');
    assert.equal(SidePaneState.updateTab(next, 'missing', { title: 'x' }), next);
});

test('a topic-scoped tab with a parent only shows under that conversation', () => {
    const a = { itemType: 'agent', itemId: 'nova', topicId: 'a' };
    const b = { itemType: 'agent', itemId: 'nova', topicId: 'b' };
    let state = SidePaneState.createInitialSidePaneState();
    state = SidePaneState.setParent(state, a);
    state = SidePaneState.openTab(state, { id: 'plan-detail:p1@a', kind: 'plan-detail', title: '计划', scopeMode: 'topic', parent: a });
    assert.equal(state.activeTabId, 'plan-detail:p1@a');

    state = SidePaneState.setParent(state, b);
    assert.deepEqual(SidePaneState.getVisibleTabs(state, b).map(t => t.id), ['notifications']);
    assert.notEqual(state.activeTabId, 'plan-detail:p1@a');
    assert.equal(SidePaneState.activateTab(state, 'plan-detail:p1@a'), state, 'activation cannot select another conversation');

    state = SidePaneState.setParent(state, a);
    assert.ok(SidePaneState.getVisibleTabs(state, a).some(t => t.id === 'plan-detail:p1@a'));
    assert.equal(state.activeTabId, 'plan-detail:p1@a');
});

test('restoreTabs appends missing tabs without changing the active tab or visibility', () => {
    let state = SidePaneState.createInitialSidePaneState();
    state = SidePaneState.openTab(state, { id: 'notes', kind: 'notes', title: '笔记' });
    state = SidePaneState.setVisible(state, false);

    const restored = SidePaneState.restoreTabs(state, [
        { id: 'notes', kind: 'notes', title: '旧标题' },
        { id: 'git', kind: 'git', title: 'Git', closable: true },
        { id: 'notifications', kind: 'notifications' },
        null
    ]);
    assert.deepEqual(restored.tabs.map(t => t.id), ['notifications', 'notes', 'git']);
    assert.equal(restored.tabs[1].title, '笔记');
    assert.equal(restored.activeTabId, 'notes');
    assert.equal(restored.visible, false);
    assert.ok(Object.isFrozen(restored.tabs[2]));
    assert.equal(restored.tabs[2].scopeMode, 'global');

    assert.equal(SidePaneState.restoreTabs(restored, []), restored);
});
