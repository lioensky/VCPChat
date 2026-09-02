const test = require('node:test');
const assert = require('node:assert/strict');

const sequentialMode = require('../Groupmodules/modes/sequentialMode');

const agents = [
    { id: 'agent-a', name: 'Agent A' },
    { id: 'agent-b', name: 'Agent B' },
    { id: 'agent-c', name: 'Agent C' }
];

test('顺序模式采用 modeSettings 中保存的自定义发言顺序', () => {
    const speakers = sequentialMode.determineSpeakers(
        agents,
        [],
        {
            modeSettings: {
                sequential: {
                    speakerOrder: ['agent-c', 'agent-a', 'agent-b']
                }
            }
        },
        {}
    );

    assert.deepEqual(speakers.map(agent => agent.id), [
        'agent-c',
        'agent-a',
        'agent-b'
    ]);
});

test('顺序模式把尚未配置次序的新成员稳定追加到末尾', () => {
    const speakers = sequentialMode.determineSpeakers(
        agents,
        [],
        {
            modeSettings: {
                sequential: {
                    speakerOrder: ['agent-b']
                }
            }
        },
        {}
    );

    assert.deepEqual(speakers.map(agent => agent.id), [
        'agent-b',
        'agent-a',
        'agent-c'
    ]);
});

test('顺序模式兼容旧 sequentialSpeakerOrder 字段', () => {
    const speakers = sequentialMode.determineSpeakers(
        agents,
        [],
        {
            sequentialSpeakerOrder: ['agent-c', 'agent-b', 'agent-a']
        },
        {}
    );

    assert.deepEqual(speakers.map(agent => agent.id), [
        'agent-c',
        'agent-b',
        'agent-a'
    ]);
});

test('顺序模式未配置顺序时保持成员原始顺序且不修改输入数组', () => {
    const originalIds = agents.map(agent => agent.id);
    const speakers = sequentialMode.determineSpeakers(agents, [], {}, {});

    assert.deepEqual(speakers.map(agent => agent.id), originalIds);
    assert.deepEqual(agents.map(agent => agent.id), originalIds);
    assert.notStrictEqual(speakers, agents);
});