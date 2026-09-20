'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    JevDecisionMode,
    DEFAULT_NAVIGATOR_PROMPT,
    DEFAULT_JEV_MODE_SETTINGS,
    normalizeJevModeSettings,
    buildDecisionRequest,
    parseDecisionResponse
} = require('../Groupmodules/modes/jevDecisionMode');

const members = [
    { id: 'nova', name: 'Nova' },
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' }
];

function createGroupConfig(overrides = {}) {
    return {
        id: 'group-1',
        name: '测试群',
        groupPrompt: '讨论工程设计',
        modeSettings: {
            jev: {
                speakerThreshold: 0.2,
                continueThreshold: 0.45,
                stopThreshold: 0.55,
                maxSpeakersPerRound: 2,
                maxAutonomousRounds: 8,
                historyWindow: 10,
                memberStyles: {
                    nova: '熟悉 VCP 与新技术，适合回答架构问题。',
                    alice: '擅长测试与可靠性。',
                    bob: '擅长前端交互。'
                },
                ...overrides
            }
        }
    };
}

test('JEV 历史窗口默认使用最近 12 楼', () => {
    const normalized = normalizeJevModeSettings({}, members.map(member => member.id));

    assert.equal(DEFAULT_JEV_MODE_SETTINGS.historyWindow, 12);
    assert.equal(normalized.historyWindow, 12);
});

test('JEV 配置归一化会裁剪范围并只保留当前成员风格', () => {
    const normalized = normalizeJevModeSettings({
        navigatorPrompt: ' ',
        speakerThreshold: 9,
        continueThreshold: -1,
        stopThreshold: '0.7',
        maxSpeakersPerRound: 0,
        maxAutonomousRounds: 999,
        historyWindow: 2.6,
        continueDebounceMs: -5,
        fallbackPolicy: 'unknown',
        memberStyles: {
            nova: '  技术话题  ',
            removed: '不应保留'
        }
    }, ['nova', 'alice']);

    assert.equal(normalized.navigatorPrompt, DEFAULT_NAVIGATOR_PROMPT);
    assert.equal(normalized.speakerThreshold, 1);
    assert.equal(normalized.continueThreshold, 0);
    assert.equal(normalized.stopThreshold, 0.7);
    assert.equal(normalized.maxSpeakersPerRound, 1);
    assert.equal(normalized.maxAutonomousRounds, 100);
    assert.equal(normalized.historyWindow, 3);
    assert.equal(normalized.continueDebounceMs, 0);
    assert.equal(normalized.fallbackPolicy, 'stop');
    assert.deepEqual(normalized.memberStyles, {
        nova: '技术话题',
        alice: ''
    });
});

test('请求使用不透明选项键并携带成员触发风格和最近历史', () => {
    const history = [
        { id: 'old', role: 'user', name: '用户', content: '旧消息' },
        { id: 'a1', role: 'assistant', name: 'Nova', agentId: 'nova', content: '架构建议' },
        { id: 'u2', role: 'user', name: '用户', content: { text: '@Alice 请检查测试' } }
    ];
    const request = buildDecisionRequest(members, history, createGroupConfig({ historyWindow: 2 }), {
        trigger: 'user_message',
        autonomousRound: 1,
        latestUserMessageId: 'u2',
        speechCounts: { nova: 1 }
    });

    assert.deepEqual(request.optionToAgentId, {
        agent_0: 'nova',
        agent_1: 'alice',
        agent_2: 'bob'
    });
    assert.equal(request.questions.speaker_routing.criteria.end_conversation.length > 0, true);
    assert.match(request.questions.speaker_routing.criteria.agent_1, /测试与可靠性/);
    assert.equal(request.state.recentMessages.length, 2);
    assert.equal(request.state.recentMessages[1].text, '@Alice 请检查测试');
    assert.equal(request.state.members[0].autonomousRunSpeechCount, 1);
});

test('概率截断按权重排序并最多选择 K 名成员', () => {
    const request = buildDecisionRequest(members, [], createGroupConfig(), {});
    const decision = parseDecisionResponse({
        answers: {
            speaker_routing: {
                type: 'choice',
                choice: 'agent_1',
                probabilities: {
                    agent_0: 0.31,
                    agent_1: 0.42,
                    agent_2: 0.19,
                    end_conversation: 0.08
                },
                confidence: 0.91
            },
            continue_discussion: { type: 'noul', noul: 0.82 }
        }
    }, request, members);

    assert.equal(decision.shouldStop, false);
    assert.deepEqual(decision.selectedAgentIds, ['alice', 'nova']);
    assert.deepEqual(
        decision.rankedSpeakers.map(item => item.agentId),
        ['alice', 'nova', 'bob']
    );
});

test('继续概率不足时优先智能结束', () => {
    const request = buildDecisionRequest(members, [], createGroupConfig(), {});
    const decision = parseDecisionResponse({
        answers: {
            speaker_routing: {
                probabilities: {
                    agent_0: 0.7,
                    agent_1: 0.1,
                    agent_2: 0.05,
                    end_conversation: 0.15
                }
            },
            continue_discussion: { noul: 0.2 }
        }
    }, request, members);

    assert.equal(decision.shouldStop, true);
    assert.equal(decision.stopReason, 'continue_probability_below_threshold');
    assert.deepEqual(decision.selectedAgentIds, []);
});

test('结束选项达到阈值且权重最高时智能结束', () => {
    const request = buildDecisionRequest(members, [], createGroupConfig(), {});
    const decision = parseDecisionResponse({
        answers: {
            speaker_routing: {
                choice: 'end_conversation',
                probabilities: {
                    agent_0: 0.15,
                    agent_1: 0.12,
                    agent_2: 0.08,
                    end_conversation: 0.65
                }
            },
            continue_discussion: { noul: 0.6 }
        }
    }, request, members);

    assert.equal(decision.shouldStop, true);
    assert.equal(decision.stopReason, 'end_option_selected');
});

test('强制继续会忽略结束判定并以最高概率成员保底', () => {
    const request = buildDecisionRequest(
        members,
        [],
        createGroupConfig({ speakerThreshold: 0.8 }),
        { forceContinue: true }
    );
    const decision = parseDecisionResponse({
        answers: {
            speaker_routing: {
                probabilities: {
                    agent_0: 0.2,
                    agent_1: 0.3,
                    agent_2: 0.1,
                    end_conversation: 0.4
                }
            },
            continue_discussion: { noul: 0.1 }
        }
    }, request, members, { forceContinue: true });

    assert.equal(decision.shouldStop, false);
    assert.deepEqual(decision.selectedAgentIds, ['alice']);
});

test('JevDecisionMode 调用服务并透传中止信号', async () => {
    const calls = [];
    const controller = new AbortController();
    const mode = new JevDecisionMode({
        jevService: {
            async decide(state, questions, options) {
                calls.push({ state, questions, options });
                return {
                    answers: {
                        speaker_routing: {
                            probabilities: {
                                agent_0: 0.6,
                                agent_1: 0.15,
                                agent_2: 0.1,
                                end_conversation: 0.15
                            }
                        },
                        continue_discussion: { noul: 0.9 }
                    }
                };
            }
        },
        logger: { log() {} }
    });

    const result = await mode.decide(
        members,
        [{ role: 'user', content: '谁来聊聊架构？' }],
        createGroupConfig(),
        { autonomousRound: 1 },
        { signal: controller.signal }
    );

    assert.deepEqual(result.selectedAgentIds, ['nova']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.signal, controller.signal);
});