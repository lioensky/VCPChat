import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSideChatDescriptor,
    createChildTopicForAgent,
    deleteSideChatChild,
    dedupeSideChatCreation,
    freezeParentHistory
} from '../modules/chat/sideChatSessionService.js';

test('createSideChatDescriptor validates parent and childTopicId and enforces distinct topics', () => {
    assert.throws(() => createSideChatDescriptor({ parent: null, childTopicId: 't2' }), /valid parent/);
    assert.throws(() => createSideChatDescriptor({ parent: { itemId: 'a1' }, childTopicId: 't2' }), /valid parent/);
    assert.throws(() => createSideChatDescriptor({ parent: { itemId: 'a1', topicId: 't1' }, childTopicId: null }), /childTopicId/);
    assert.throws(() => createSideChatDescriptor({ parent: { itemId: 'a1', topicId: 't1' }, childTopicId: 't1' }), /must be different/);

    const desc = createSideChatDescriptor({
        parent: { itemId: 'agent-1', topicId: 'topic-main', name: 'Agent 1' },
        childTopicId: 'topic-side-1',
        title: '测试侧聊'
    });

    assert.equal(desc.parent.itemId, 'agent-1');
    assert.equal(desc.parent.topicId, 'topic-main');
    assert.equal(desc.child.itemId, 'agent-1');
    assert.equal(desc.child.topicId, 'topic-side-1');
    assert.equal(desc.title, '测试侧聊');
    assert.equal(desc.contextMode, 'references-only');
    assert.equal(desc.type, 'selection-side-chat');
    assert.equal(desc.ephemeral, true);
    assert.ok(desc.id.startsWith('sidechat-'));
    assert.equal(Object.isFrozen(desc), true);
});

test('createChildTopicForAgent delegates to electronAPI and returns normalized outcome', async () => {
    // Missing API
    const resNoApi = await createChildTopicForAgent({ electronAPI: null, agentId: 'a1' });
    assert.equal(resNoApi.ok, false);
    assert.equal(resNoApi.code, 'IPC_UNAVAILABLE');

    // Missing agent
    const resNoAgent = await createChildTopicForAgent({ electronAPI: { createSideChatChild: async () => {} }, agentId: '' });
    assert.equal(resNoAgent.ok, false);
    assert.equal(resNoAgent.code, 'INVALID_AGENT');

    // Successful creation
    const mockSuccessApi = {
        async createSideChatChild(agentId) {
            assert.equal(agentId, 'agent-xyz');
            return { success: true, topicId: 'topic-12345' };
        }
    };
    const resSuccess = await createChildTopicForAgent({ electronAPI: mockSuccessApi, agentId: 'agent-xyz', topicTitle: '专属侧聊' });
    assert.equal(resSuccess.ok, true);
    assert.equal(resSuccess.topicId, 'topic-12345');
    assert.equal(resSuccess.topicName, '专属侧聊');

    // Failed creation
    const mockFailApi = {
        async createSideChatChild() {
            return { success: false, error: 'Agent disk is full' };
        }
    };
    const resFail = await createChildTopicForAgent({ electronAPI: mockFailApi, agentId: 'agent-xyz' });
    assert.equal(resFail.ok, false);
    assert.equal(resFail.code, 'CREATE_FAILED');
    assert.equal(resFail.message, 'Agent disk is full');
});

test('createChildTopicForAgent never falls back to creating a real agent topic', async () => {
    let realTopicCreated = false;
    const res = await createChildTopicForAgent({
        electronAPI: { createNewTopicForAgent: async () => { realTopicCreated = true; return { success: true, topicId: 't' }; } },
        agentId: 'agent-xyz'
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'IPC_UNAVAILABLE');
    assert.equal(realTopicCreated, false);
});

test('dedupeSideChatCreation coalesces concurrent creations for the same key', async () => {
    let calls = 0;
    const factory = async () => { calls += 1; await new Promise(r => setTimeout(r, 10)); return { id: calls }; };
    const [a, b] = await Promise.all([
        dedupeSideChatCreation('agent:topic', factory),
        dedupeSideChatCreation('agent:topic', factory)
    ]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    const c = await dedupeSideChatCreation('agent:topic', factory);
    assert.equal(calls, 2);
    assert.notEqual(c, a);
});

test('deleteSideChatChild delegates to electronAPI and normalizes outcome', async () => {
    assert.equal((await deleteSideChatChild({ electronAPI: {}, agentId: 'a', childTopicId: 't' })).code, 'IPC_UNAVAILABLE');
    assert.equal((await deleteSideChatChild({ electronAPI: {}, agentId: '', childTopicId: 't' })).code, 'INVALID_PARAMS');
    const ok = await deleteSideChatChild({ electronAPI: { deleteSideChatChild: async () => ({ success: true }) }, agentId: 'a', childTopicId: 't' });
    assert.equal(ok.ok, true);
    const bad = await deleteSideChatChild({ electronAPI: { deleteSideChatChild: async () => ({ success: false, error: 'NOT_A_SIDE_CHAT_CHILD' }) }, agentId: 'a', childTopicId: 't' });
    assert.equal(bad.ok, false);
    assert.equal(bad.message, 'NOT_A_SIDE_CHAT_CHILD');
});

test('freezeParentHistory filters out transient or streaming messages and clones stable ones', () => {
    const raw = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello', timestamp: 100 },
        { role: 'assistant', content: 'Hi there!', timestamp: 200 },
        { role: 'assistant', content: 'Thinking...', isStreaming: true, transient: true },
        { role: 'assistant', content: '', pending: true },
        { role: 'invalid_role', content: 'skip me' }
    ];

    const frozen = freezeParentHistory(raw);
    assert.equal(frozen.length, 3);
    assert.equal(frozen[0].role, 'system');
    assert.equal(frozen[1].role, 'user');
    assert.equal(frozen[1].content, 'Hello');
    assert.equal(frozen[2].role, 'assistant');
    assert.equal(frozen[2].content, 'Hi there!');
    assert.equal(frozen[2].isInherited, true);

    // Verify deep copy
    raw[1].content = 'Mutated';
    assert.equal(frozen[1].content, 'Hello');
});

test('saveSideChatMetadata, listSideChatsForParent and createParentSnapshot handle contracts', async () => {
    const {
        saveSideChatMetadata,
        listSideChatsForParent,
        createParentSnapshot
    } = await import('../modules/chat/sideChatSessionService.js');

    // Invalid metadata structure
    const resInvalid = await saveSideChatMetadata({ electronAPI: null, metadata: null });
    assert.equal(resInvalid.ok, false);
    assert.equal(resInvalid.code, 'INVALID_METADATA');

    // Mock API
    let stored = null;
    const mockElectron = {
        async saveSideChatMetadata(meta) {
            stored = meta;
            return { success: true, metadata: meta };
        },
        async listSideChatMetadata(agentId, parentTopicId) {
            if (stored && (!parentTopicId || stored.parent?.topicId === parentTopicId)) {
                return { success: true, items: [stored] };
            }
            return { success: true, items: [] };
        },
        async createSideChatSnapshot(agentId, parentTopicId, childTopicId) {
            return {
                success: true,
                snapshotId: 'snap-123',
                snapshotBoundary: { lastMessageId: 'm1', capturedAt: 500, messageCount: 1 },
                messages: [{ id: 'm1', role: 'user', content: 'hello' }]
            };
        }
    };

    const meta = {
        schemaVersion: 1,
        id: 'sc-1',
        parent: { itemType: 'agent', itemId: 'a1', topicId: 'top-parent' },
        child: { itemType: 'agent', itemId: 'a1', topicId: 'top-child' },
        title: '测试侧聊'
    };

    // Save
    const saveRes = await saveSideChatMetadata({ electronAPI: mockElectron, metadata: meta });
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.metadata.id, 'sc-1');

    // List
    const listRes = await listSideChatsForParent({ electronAPI: mockElectron, agentId: 'a1', parentTopicId: 'top-parent' });
    assert.equal(listRes.ok, true);
    assert.equal(listRes.items.length, 1);

    // Create snapshot
    const snapRes = await createParentSnapshot({ electronAPI: mockElectron, agentId: 'a1', parentTopicId: 'top-parent' });
    assert.equal(snapRes.ok, true);
    assert.equal(snapRes.snapshotId, 'snap-123');
    assert.equal(snapRes.messages.length, 1);

    const snapFail = await createParentSnapshot({
        electronAPI: { createSideChatSnapshot: async () => ({ success: false, error: 'disk failure' }) },
        agentId: 'a', parentTopicId: 'p', fallbackHistory: []
    });
    assert.equal(snapFail.ok, false);
    assert.equal(snapFail.code, 'SNAPSHOT_FAILED');
    assert.equal(snapFail.error, 'disk failure');

    const missingIpc = await saveSideChatMetadata({ electronAPI: {}, metadata: meta });
    assert.equal(missingIpc.ok, false);
    assert.equal(missingIpc.code, 'UNSUPPORTED');
});
