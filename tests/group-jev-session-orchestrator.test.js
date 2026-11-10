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
test('外部Agent留言只更新历史代际，不冒充人类或重置自治预算', () => {
    const { orchestrator, events } = createFixture();
    orchestrator.notifyHumanMessage('g1', 'external', { id: 'human' });
    const session = orchestrator._getOrCreate('g1', 'external');
    session.autonomousRound = 3;
    session.queue = ['nova', 'alice'];
    session.manualQueue = ['bob'];
    const revision = session.historyRevision;
    const result = orchestrator.notifyExternalMessage('g1', 'external');
    assert.equal(result.historyRevision, revision + 1);
    assert.equal(result.dirty, true);
    assert.equal(session.latestUserMessageId, 'human');
    assert.equal(result.autonomousRound, 3);
    assert.deepEqual(result.queue, ['nova', 'alice']);
    assert.deepEqual(result.manualQueue, ['bob']);
    assert.equal(result.running, false);
    assert.equal(events.at(-1).reason, 'external_message');
});
test('中央批次令牌只交给首位成员，不在编排结束时重复收尾', async () => {
    const tokens = [];
    const finalized = [];
    const fixture = createFixture({
        decisions: [
            routing({ agent_0: 0.6, agent_1: 0.3, agent_2: 0, end_conversation: 0.1 }),
            routing({ agent_0: 0, agent_1: 0, agent_2: 0, end_conversation: 1 }, 0),
        ],
        runAgent: async ({ admissionToken }) => { tokens.push(admissionToken); },
    });
    fixture.orchestrator.finalizeAdmission = async value => finalized.push(value);
    await fixture.orchestrator.start('g1', 'lease-transfer', {
        trigger: 'external_message', admissionToken: 'central-token',
    }).promise;
    assert.deepEqual(tokens, ['central-token', null]);
    assert.deepEqual(finalized, []);
});

test('中央批次未选出发言者时在仲裁结束后收尾', async () => {
    const fixture = createFixture();
    const finalized = [];
    fixture.orchestrator.finalizeAdmission = async value => finalized.push(value);
    await fixture.orchestrator.start('g1', 'lease-empty', {
        trigger: 'external_message', admissionToken: 'central-token',
    }).promise;
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].token, 'central-token');
    assert.equal(finalized[0].error, null);
    assert.equal(fixture.orchestrator.getState('g1', 'lease-empty').running, false);
});

test('中央批次仲裁异常保留原始错误交给收尾回调', async () => {
    const failure = new Error('config unavailable');
    const fixture = createFixture();
    const finalized = [];
    fixture.orchestrator.loadGroupConfig = async () => { throw failure; };
    fixture.orchestrator.finalizeAdmission = async value => finalized.push(value);
    await fixture.orchestrator.start('g1', 'lease-failed', {
        trigger: 'external_message', admissionToken: 'central-token',
    }).promise;
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].error, failure);
    assert.equal(finalized[0].token, 'central-token');
    assert.equal(fixture.orchestrator.getState('g1', 'lease-failed').running, false);
});
test('活跃JEV接收中央批次，由下一位接管且不另开循环', async () => {
    const gate = deferred();
    const firstStarted = deferred();
    const tokens = [];
    const fixture = createFixture({
        decisions: [
            routing({ agent_0: 0.6, agent_1: 0.3, agent_2: 0, end_conversation: 0.1 }),
            routing({ agent_0: 0, agent_1: 0, agent_2: 0, end_conversation: 1 }, 0),
        ],
        runAgent: async ({ admissionToken }) => {
            tokens.push(admissionToken);
            if (tokens.length === 1) {
                firstStarted.resolve();
                await gate.promise;
            }
        },
    });
    const started = fixture.orchestrator.start('g1', 'adopt-active');
    await firstStarted.promise;
    assert.deepEqual(fixture.orchestrator.adoptAdmission('g1', 'adopt-active', 'batch'),
        { accepted: true });
    assert.deepEqual(fixture.orchestrator.adoptAdmission('g1', 'adopt-active', 'other'),
        { accepted: false, reason: 'admission_pending' });
    assert.equal(fixture.orchestrator.start('g1', 'adopt-active').started, false);
    gate.resolve();
    await started.promise;
    assert.deepEqual(tokens, [null, 'batch']);
    assert.equal(fixture.decisionCalls.length, 2);
    assert.equal(fixture.orchestrator.adoptAdmission('g1', 'adopt-active', 'late').accepted, false);
});

test('JEV异步收尾期间关闭批次接收，即使running仍为true', async () => {
    const fixture = createFixture();
    const entered = deferred();
    const finish = deferred();
    fixture.orchestrator.finalizeAdmission = async () => {
        entered.resolve();
        await finish.promise;
    };
    const started = fixture.orchestrator.start('g1', 'adopt-closing', {
        trigger: 'external_message', admissionToken: 'original',
    });
    await entered.promise;
    assert.equal(fixture.orchestrator.getState('g1', 'adopt-closing').running, true);
    assert.deepEqual(fixture.orchestrator.adoptAdmission('g1', 'adopt-closing', 'late'),
        { accepted: false, reason: 'not_accepting' });
    finish.resolve();
    await started.promise;
});
test('等待接管归属在同次编排稳定，在下一次编排重新生成', async () => {
    const owners = [];
    const fixture = createFixture({
        decisions: [
            routing({ agent_0: 0.6, agent_1: 0.3, agent_2: 0, end_conversation: 0.1 }),
            routing({ agent_0: 0, agent_1: 0, agent_2: 0, end_conversation: 1 }, 0),
        ],
        runAgent: async ({ handoffOwner }) => { owners.push(handoffOwner); },
    });
    await fixture.orchestrator.start('g1', 'owner-isolation').promise;
    assert.equal(owners.length, 2);
    assert.equal(typeof owners[0], 'string');
    assert.ok(owners[0].length > 0);
    assert.equal(owners[0], owners[1]);
    await fixture.orchestrator.start('g1', 'owner-isolation', {
        initialAgentId: 'nova',
    }).promise;
    assert.equal(owners.length, 3);
    assert.notEqual(owners[0], owners[2]);
});
test('活跃JEV优先交接已等待成员，不重复挂接批次', async () => {
    const entered = deferred();
    const finish = deferred();
    const fixture = createFixture({
        runAgent: async () => { entered.resolve(); await finish.promise; },
    });
    const transfers = [];
    fixture.orchestrator.transferWaitingAdmission = async value => {
        transfers.push(value);
        return { success: true, token: 'waiting-member' };
    };
    const started = fixture.orchestrator.start('g1', 'handoff-waiting', {
        initialAgentId: 'nova',
    });
    await entered.promise;
    const result = await fixture.orchestrator.handoffAdmission('g1', 'handoff-waiting', 'batch');
    assert.deepEqual(result, { accepted: true, transferred: true, token: 'waiting-member' });
    assert.equal(transfers[0].token, 'batch');
    assert.ok(transfers[0].handoffOwner);
    assert.equal(fixture.orchestrator._getOrCreate('g1', 'handoff-waiting')
        .admissionRunOptions.admissionToken, null);
    finish.resolve();
    await started.promise;
});

test('中央交接返回前旧编排退出，不向结束会话挂令牌', async () => {
    const entered = deferred();
    const finishAgent = deferred();
    const transferStarted = deferred();
    const finishTransfer = deferred();
    const fixture = createFixture({
        runAgent: async () => { entered.resolve(); await finishAgent.promise; },
    });
    fixture.orchestrator.transferWaitingAdmission = async () => {
        transferStarted.resolve();
        await finishTransfer.promise;
        return { success: false, code: 'NO_WAITING_SPEAKER' };
    };
    const started = fixture.orchestrator.start('g1', 'handoff-exited', {
        initialAgentId: 'nova',
    });
    await entered.promise;
    const handoff = fixture.orchestrator.handoffAdmission('g1', 'handoff-exited', 'batch');
    await transferStarted.promise;
    finishAgent.resolve();
    while (fixture.orchestrator._getOrCreate('g1', 'handoff-exited').admissionRunOptions) await tick();
    finishTransfer.resolve();
    assert.deepEqual(await handoff, { accepted: false, reason: 'not_accepting' });
    await started.promise;
    assert.equal(fixture.orchestrator.getState('g1', 'handoff-exited').running, false);
});
test('无等待者查询期间下一成员必须等待交接裁决', { timeout: 3000 }, async () => {
    const firstStarted = deferred();
    const finishFirst = deferred();
    const transferStarted = deferred();
    const finishTransfer = deferred();
    const tokens = [];
    const fixture = createFixture({
        decisions: [
            routing({ agent_0: 0.6, agent_1: 0.3, agent_2: 0, end_conversation: 0.1 }),
            routing({ agent_0: 0, agent_1: 0, agent_2: 0, end_conversation: 1 }, 0),
        ],
        runAgent: async ({ admissionToken }) => {
            tokens.push(admissionToken);
            if (tokens.length === 1) {
                firstStarted.resolve();
                await finishFirst.promise;
            }
        },
    });
    fixture.orchestrator.transferWaitingAdmission = async () => {
        transferStarted.resolve();
        await finishTransfer.promise;
        return { success: false, code: 'NO_WAITING_SPEAKER' };
    };
    const started = fixture.orchestrator.start('g1', 'handoff-barrier');
    await firstStarted.promise;
    const handoff = fixture.orchestrator.handoffAdmission('g1', 'handoff-barrier', 'batch');
    await transferStarted.promise;
    finishFirst.resolve();
    await tick();
    assert.deepEqual(tokens, [null]);
    finishTransfer.resolve();
    assert.deepEqual(await handoff, { accepted: true });
    await started.promise;
    assert.deepEqual(tokens, [null, 'batch']);
});