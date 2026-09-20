'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JevGroupSessionOrchestrator } = require('../Groupmodules/jevGroupSessionOrchestrator');

const members = [
    { id: 'nova', name: 'Nova' },
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' }
];

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function tick() {
    return new Promise(resolve => setImmediate(resolve));
}

function createFixture({
    decisions = [],
    runAgent,
    initialHistory = [{ id: 'u1', role: 'user', content: '开始讨论' }]
} = {}) {
    const history = [...initialHistory];
    const events = [];
    const decisionCalls = [];
    const groupConfig = {
        id: 'g1',
        name: '测试群',
        members: members.map(member => member.id),
        mode: 'jev',
        modeSettings: {
            jev: {
                speakerThreshold: 0.1,
                continueThreshold: 0.4,
                stopThreshold: 0.6,
                maxSpeakersPerRound: 3,
                maxAutonomousRounds: 5,
                historyWindow: 20,
                continueDebounceMs: 800,
                memberStyles: {}
            }
        }
    };
    let decisionIndex = 0;
    const orchestrator = new JevGroupSessionOrchestrator({
        jevService: {
            async decide(state, questions, options) {
                decisionCalls.push({ state, questions, options });
                const value = decisions[decisionIndex++];
                return typeof value === 'function'
                    ? value({ state, questions, options, history })
                    : value || {
                        answers: {
                            speaker_routing: {
                                probabilities: {
                                    agent_0: 0,
                                    agent_1: 0,
                                    agent_2: 0,
                                    end_conversation: 1
                                }
                            },
                            continue_discussion: { noul: 0 }
                        }
                    };
            }
        },
        loadGroupConfig: async () => groupConfig,
        loadActiveMembers: async () => members,
        readHistory: async () => [...history],
        runAgent: runAgent || (async ({ agent }) => {
            history.push({
                id: `a-${agent.id}-${history.length}`,
                role: 'assistant',
                agentId: agent.id,
                name: agent.name,
                content: `${agent.name} 回复`
            });
        }),
        emitEvent: event => events.push(event),
        logger: { log() {}, warn() {}, error() {} },
        random: () => 0
    });
    return { orchestrator, history, events, decisionCalls, groupConfig };
}

function routing(probabilities, continuation = 0.9) {
    return {
        answers: {
            speaker_routing: { probabilities },
            continue_discussion: { noul: continuation }
        }
    };
}

test('Top-K 批次按裁决顺序执行，完成后再重新裁决', async () => {
    const order = [];
    const fixture = createFixture({
        decisions: [
            routing({
                agent_0: 0.5,
                agent_1: 0.3,
                agent_2: 0.1,
                end_conversation: 0.1
            }),
            routing({
                agent_0: 0.05,
                agent_1: 0.05,
                agent_2: 0.05,
                end_conversation: 0.85
            })
        ],
        runAgent: async ({ agent }) => {
            order.push(agent.id);
            fixture.history.push({
                role: 'assistant',
                agentId: agent.id,
                name: agent.name,
                content: '回复'
            });
        }
    });

    const started = fixture.orchestrator.start('g1', 't1', { trigger: 'user_message' });
    await started.promise;

    assert.deepEqual(order, ['nova', 'alice', 'bob']);
    assert.equal(fixture.decisionCalls.length, 2);
    assert.equal(fixture.orchestrator.getState('g1', 't1').status, 'idle');
});

test('普通人类插话保留剩余 K 队列且后续 Agent 从最新历史读取', async () => {
    const firstAgentGate = deferred();
    const observedHistory = [];
    const order = [];
    const fixture = createFixture({
        decisions: [
            routing({
                agent_0: 0.55,
                agent_1: 0.3,
                agent_2: 0.05,
                end_conversation: 0.1
            }),
            routing({
                agent_0: 0.05,
                agent_1: 0.05,
                agent_2: 0.05,
                end_conversation: 0.85
            })
        ],
        runAgent: async ({ agent }) => {
            order.push(agent.id);
            observedHistory.push(fixture.history.map(message => message.id));
            if (agent.id === 'nova') await firstAgentGate.promise;
            fixture.history.push({
                id: `reply-${agent.id}`,
                role: 'assistant',
                agentId: agent.id,
                name: agent.name,
                content: '回复'
            });
        }
    });

    const started = fixture.orchestrator.start('g1', 't2', { trigger: 'user_message' });
    while (fixture.orchestrator.getState('g1', 't2').currentAgentId !== 'nova') await tick();

    fixture.history.push({ id: 'human-insert', role: 'user', content: '补充条件' });
    fixture.orchestrator.notifyHumanMessage(
        'g1',
        't2',
        { id: 'human-insert' },
        []
    );
    firstAgentGate.resolve();
    await started.promise;

    assert.deepEqual(order, ['nova', 'alice']);
    assert.equal(observedHistory[1].includes('human-insert'), true);
    assert.equal(fixture.decisionCalls.length, 2);
});

test('@Agent 会把成员提升为当前发言者后的下一位并去重', async () => {
    const gate = deferred();
    const order = [];
    const fixture = createFixture({
        decisions: [
            routing({
                agent_0: 0.5,
                agent_1: 0.3,
                agent_2: 0.15,
                end_conversation: 0.05
            }),
            routing({
                agent_0: 0,
                agent_1: 0,
                agent_2: 0,
                end_conversation: 1
            }, 0)
        ],
        runAgent: async ({ agent }) => {
            order.push(agent.id);
            if (agent.id === 'nova') await gate.promise;
            fixture.history.push({
                id: `reply-${agent.id}`,
                role: 'assistant',
                agentId: agent.id,
                name: agent.name,
                content: '回复'
            });
        }
    });

    const started = fixture.orchestrator.start('g1', 't3', { trigger: 'user_message' });
    while (fixture.orchestrator.getState('g1', 't3').currentAgentId !== 'nova') await tick();

    fixture.history.push({ id: 'mention-bob', role: 'user', content: '@Bob 先说' });
    fixture.orchestrator.notifyHumanMessage(
        'g1',
        't3',
        { id: 'mention-bob' },
        ['bob']
    );
    gate.resolve();
    await started.promise;

    assert.deepEqual(order, ['nova', 'bob', 'alice']);
    assert.equal(order.filter(id => id === 'bob').length, 1);
});

test('裁决期间插话使旧裁决失效并触发一次最新裁决', async () => {
    const arbitrationGate = deferred();
    const fixture = createFixture({
        decisions: [
            async () => {
                await arbitrationGate.promise;
                return routing({
                    agent_0: 0.8,
                    agent_1: 0.1,
                    agent_2: 0.05,
                    end_conversation: 0.05
                });
            },
            routing({
                agent_0: 0,
                agent_1: 0,
                agent_2: 0,
                end_conversation: 1
            }, 0)
        ]
    });

    const started = fixture.orchestrator.start('g1', 't4', { trigger: 'user_message' });
    while (fixture.orchestrator.getState('g1', 't4').status !== 'arbitrating') await tick();

    fixture.history.push({ id: 'during-arbitration', role: 'user', content: '新条件' });
    fixture.orchestrator.notifyHumanMessage(
        'g1',
        't4',
        { id: 'during-arbitration' },
        []
    );
    arbitrationGate.resolve();
    await started.promise;

    assert.equal(fixture.decisionCalls.length, 2);
    assert.equal(
        fixture.events.some(event => event.reason === 'stale_arbitration_discarded'),
        true
    );
    assert.equal(
        fixture.history.some(message => message.role === 'assistant'),
        false
    );
});

test('停止队列不打断当前 Agent，但阻止剩余成员和后续裁决', async () => {
    const agentStarted = deferred();
    const finishCurrentAgent = deferred();
    const order = [];
    let currentSignal = null;
    const fixture = createFixture({
        decisions: [
            routing({
                agent_0: 0.55,
                agent_1: 0.3,
                agent_2: 0.05,
                end_conversation: 0.1
            })
        ],
        runAgent: async ({ agent, signal }) => {
            order.push(agent.id);
            currentSignal = signal;
            agentStarted.resolve();
            await finishCurrentAgent.promise;
            fixture.history.push({
                id: `reply-${agent.id}`,
                role: 'assistant',
                agentId: agent.id,
                name: agent.name,
                content: '完整回复'
            });
        }
    });

    const started = fixture.orchestrator.start('g1', 't5', { trigger: 'user_message' });
    await agentStarted.promise;
    const result = await fixture.orchestrator.interrupt('g1', 't5');

    assert.equal(result.success, true);
    assert.equal(result.wasRunning, true);
    assert.equal(result.currentReplyContinues, true);
    assert.equal(currentSignal.aborted, false);
    assert.equal(fixture.orchestrator.getState('g1', 't5').stopRequested, true);

    finishCurrentAgent.resolve();
    await started.promise;

    assert.deepEqual(order, ['nova']);
    assert.equal(fixture.history.some(message => message.id === 'reply-nova'), true);
    assert.equal(fixture.decisionCalls.length, 1);
    assert.equal(fixture.orchestrator.getState('g1', 't5').status, 'idle');
    assert.equal(
        fixture.events.some(event => (
            event.type === 'group_queue_stopped'
            && event.reason === 'user_queue_stop_pending_current'
            && event.currentReplyContinues === true
        )),
        true
    );
    assert.equal(
        fixture.events.some(event => (
            event.type === 'group_queue_stopped'
            && event.reason === 'user_queue_stop'
            && event.currentReplyCompleted === true
        )),
        true
    );
});