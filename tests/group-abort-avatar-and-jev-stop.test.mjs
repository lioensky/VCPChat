import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

import { createMessageSkeleton } from '../modules/renderer/domBuilder.js';
import { createVcpStreamBridge } from '../modules/chat/vcpStreamBridge.js';
import { createNonStreamingEventConsumer } from '../modules/renderer/nonStreamingEventConsumer.js';
import { createMainChatSendOwner } from '../modules/renderer/mainChatSendOwner.js';

const require = createRequire(import.meta.url);
const { JevGroupSessionOrchestrator } = require('../Groupmodules/jevGroupSessionOrchestrator.js');

const createDeferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    promise.then(
        value => { clearTimeout(timer); resolve(value); },
        err => { clearTimeout(timer); reject(err); }
    );
});

test('JevGroupSessionOrchestrator hard abortCurrent avoids false completion, speech count inflation and duplicate settlement summary', async () => {
    const events = [];
    const settledCalls = [];
    const turnCompletedCalls = [];
    const agentStarted = createDeferred();
    const releaseAgent = createDeferred();

    const members = [
        { id: 'agent-alpha', name: 'Member Alpha' },
        { id: 'agent-beta', name: 'Member Beta' },
    ];

    const orchestrator = new JevGroupSessionOrchestrator({
        jevService: {
            async decide() {
                return {
                    answers: {
                        speaker_routing: {
                            probabilities: {
                                agent_0: 0.65,
                                agent_1: 0.25,
                                end_conversation: 0.10,
                            },
                        },
                        continue_discussion: { noul: 0.8 },
                    },
                };
            },
        },
        loadGroupConfig: async () => ({
            id: 'group-demo',
            name: 'Demo Group',
            mode: 'jev',
            members: ['agent-alpha', 'agent-beta'],
            modeSettings: {
                jev: {
                    speakerThreshold: 0.1,
                    continueThreshold: 0.4,
                    stopThreshold: 0.6,
                    maxSpeakersPerRound: 2,
                    maxAutonomousRounds: 5,
                    historyWindow: 20,
                    continueDebounceMs: 800,
                    memberStyles: {},
                },
            },
        }),
        loadActiveMembers: async () => members,
        readHistory: async () => [{ id: 'u1', role: 'user', content: 'Start discussion' }],
        runAgent: async () => {
            agentStarted.resolve();
            return await releaseAgent.promise;
        },
        emitEvent: event => events.push(event),
        onAgentTurnCompleted: payload => turnCompletedCalls.push(payload),
        onSessionSettled: payload => settledCalls.push(payload),
        logger: { log() {}, info() {}, warn() {}, error() {} },
        random: () => 0,
    });

    const run = orchestrator.start('group-demo', 'topic-demo', { trigger: 'user_message' });
    await withTimeout(agentStarted.promise, 3000, 'agentStarted');

    const interruptReceipt = await orchestrator.interrupt('group-demo', 'topic-demo', {
        abortCurrent: true,
        abortedMessageId: 'msg-group-demo-1',
    });
    assert.equal(interruptReceipt.success, true);
    assert.equal(interruptReceipt.currentReplyContinues, false);

    releaseAgent.resolve({ interrupted: true });
    await withTimeout(run.promise, 3000, 'orchestrator run completion');

    const finalState = orchestrator.getState('group-demo', 'topic-demo');
    assert.equal(finalState.status, 'idle');
    assert.equal(finalState.speechCounts?.['agent-alpha'] || 0, 0);
    assert.equal(turnCompletedCalls.length, 0);
    assert.equal(settledCalls.length, 0);
    assert.equal(
        events.some(e => e.type === 'group_queue_stopped' && e.reason === 'user_request_stop' && e.currentReplyInterrupted === true),
        true
    );
    assert.equal(
        events.some(e => e.type === 'group_queue_stopped' && e.currentReplyCompleted === true),
        false
    );
});

test('createMessageSkeleton dynamically heals missing group member avatar and name via itemListManager', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    try {
        dom.window.itemListManager = {
            getLoadedItems: () => [
                {
                    id: 'agent-alpha',
                    type: 'agent',
                    name: 'Member Alpha',
                    avatarUrl: 'file:///avatars/member-alpha.png?v=1',
                },
            ],
        };

        const { avatarImg, senderNameDiv } = createMessageSkeleton(
            {
                id: 'msg-history-legacy',
                role: 'assistant',
                agentId: 'agent-alpha',
                isGroupMessage: true,
                content: 'Recovered partial content after topic reload',
                timestamp: 1700000000000,
            },
            {},
            { id: 'group-demo', type: 'group', avatarUrl: 'file:///avatars/group-demo.png' },
            { document: dom.window.document, window: dom.window }
        );

        assert.match(avatarImg.src, /member-alpha\.png/);
        assert.equal(senderNameDiv.textContent, 'Member Alpha');
    } finally {
        dom.window.close();
    }
});

test('nonStreamingEventConsumer retires agent_thinking stream operation on full_response and remove_message', async () => {
    const events = [];
    const bridge = createVcpStreamBridge({
        createConsumer: initialEvent => ({
            prepare: async () => events.push(['prepare', initialEvent.messageId]),
            consume: streamEvent => events.push(['consume', streamEvent.type, initialEvent.messageId]),
            persist: async () => events.push(['persist', initialEvent.messageId]),
            dispose: () => events.push(['dispose', initialEvent.messageId]),
        }),
    });

    const consumer = createNonStreamingEventConsumer({
        renderTarget: {
            root: {},
            removeMessage: async (id, save) => events.push(['remove-dom', id, save]),
        },
        messageRenderer: {
            renderFullMessageProjection: async id => events.push(['project-full', id]),
        },
        viewAuthority: { isCurrent: () => true },
        disposeStream: (id, reason) => bridge.disposeOperation(id, reason),
        streamProjection: {
            discardStreamingMessage: id => events.push(['discard-projection', id]),
        },
        notifySendStateChanged: () => events.push(['sync-send-btn']),
    });

    assert.equal(
        bridge.accept({
            type: 'agent_thinking',
            messageId: 'msg-nonstream-1',
            context: { groupId: 'group-demo', topicId: 'topic-demo', agentId: 'agent-alpha', isGroupMessage: true },
        }),
        true
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(
        await consumer.consume({
            type: 'full_response',
            messageId: 'msg-nonstream-1',
            fullResponse: 'Complete non-stream reply',
            context: { groupId: 'group-demo', topicId: 'topic-demo', agentId: 'agent-alpha', isGroupMessage: true },
        }),
        true
    );

    assert.equal(
        bridge.accept({
            type: 'data',
            messageId: 'msg-nonstream-1',
            chunk: 'stale chunk',
            context: { groupId: 'group-demo', topicId: 'topic-demo', agentId: 'agent-alpha', isGroupMessage: true },
        }),
        false
    );
    assert.equal(events.some(item => item[0] === 'dispose' && item[1] === 'msg-nonstream-1'), true);
    assert.equal(events.some(item => item[0] === 'discard-projection' && item[1] === 'msg-nonstream-1'), true);
    assert.equal(events.some(item => item[0] === 'project-full' && item[1] === 'msg-nonstream-1'), true);
    assert.equal(events.some(item => item[0] === 'persist'), false);

    await bridge.dispose();
    consumer.dispose();
});

test('mainChatSendOwner projects stop button during JEV arbitration window while respecting draft priority', async () => {
    const activeQueues = new Set();
    const calls = [];
    let draftPresent = false;
    const classes = new Set();
    const button = {
        innerHTML: '<span>send</span>',
        dataset: {},
        title: '',
        attributes: {},
        classList: {
            toggle(name, active) { active ? classes.add(name) : classes.delete(name); },
            contains: name => classes.has(name),
        },
        setAttribute(name, value) { this.attributes[name] = value; },
    };

    const owner = createMainChatSendOwner({
        button,
        messagesRoot: { querySelector: () => null },
        historyRef: { get: () => [], set: () => {} },
        selectedItemRef: { get: () => ({ id: 'group-demo', type: 'group', name: 'Demo Group' }) },
        topicIdRef: { get: () => 'topic-demo' },
        streamProjection: {
            getActiveStreamingMessageId: () => null,
            getActiveStreamingContext: () => null,
        },
        chatAPI: {
            interruptGroupChatQueue: async (groupId, topicId) => {
                calls.push(['interrupt-queue', groupId, topicId]);
                return { success: true, message: '已停止后续群聊队列。' };
            },
        },
        interruptHandler: {},
        getAdapter: () => null,
        getChatManager: () => ({ handleSendMessage: async () => calls.push(['send']) }),
        messageRenderer: {},
        notify: (msg, type) => calls.push(['notify', msg, type]),
        hasDraft: () => draftPresent,
        isGroupQueueActive: (groupId, topicId) => activeQueues.has(`${groupId}::${topicId}`),
        clearGroupQueueActive: (groupId, topicId) => activeQueues.delete(`${groupId}::${topicId}`),
    });

    const consumer = createNonStreamingEventConsumer({
        renderTarget: { root: {}, removeMessage: async () => {} },
        messageRenderer: { renderFullMessageProjection: async () => {} },
        viewAuthority: { isCurrent: () => true },
        onGroupQueueStateChange: ({ groupId, topicId, active }) => {
            const key = `${groupId}::${topicId}`;
            if (active) activeQueues.add(key);
            else activeQueues.delete(key);
        },
        notifySendStateChanged: owner.update,
    });

    await consumer.consume({
        type: 'jev_arbitration_started',
        messageId: 'jev_session_demo_1',
        context: { groupId: 'group-demo', topicId: 'topic-demo', isGroupMessage: true },
    });
    assert.equal(button.dataset.mode, 'interrupt');
    assert.equal(button.classList.contains('interrupt-mode'), true);

    draftPresent = true;
    owner.update();
    assert.equal(button.dataset.mode, 'send');

    draftPresent = false;
    owner.update();
    assert.equal(button.dataset.mode, 'interrupt');

    await owner.handleAction();
    assert.equal(button.dataset.mode, 'send');
    assert.deepEqual(calls[0], ['interrupt-queue', 'group-demo', 'topic-demo']);
});