import test from 'node:test';
import assert from 'node:assert/strict';
import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';

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

test('openChatTab validates descriptor and avoids duplicate child topics', () => {
    const s0 = SidePaneState.createInitialSidePaneState();

    assert.throws(() => {
        SidePaneState.openChatTab(s0, { id: 'invalid' });
    }, /SideChatDescriptor requires a parent conversation reference/);

    assert.throws(() => {
        SidePaneState.openChatTab(s0, {
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

    const s1 = SidePaneState.openChatTab(s0, desc1);
    assert.equal(s1.visible, true);
    assert.equal(s1.activeTabId, 'side-1');
    assert.equal(s1.tabs.length, 2);
    assert.equal(s1.tabs[1].id, 'side-1');
    assert.equal(s1.tabs[1].kind, 'chat');

    // Opening with same id or child topicId activates existing tab without adding new one
    const s2 = SidePaneState.openChatTab(s1, { ...desc1, id: 'side-1-duplicate' });
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

    let state = SidePaneState.openChatTab(s0, desc1);
    state = SidePaneState.openChatTab(state, desc2);
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
    state = SidePaneState.openChatTab(state, {
        id: 'side-a1',
        parent: parentA,
        child: { itemType: 'agent', itemId: 'agent-a', topicId: 'child-a1' },
        title: 'A1',
    });
    state = SidePaneState.openChatTab(state, {
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
