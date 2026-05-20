const assert = require('assert');
const router = require('../groupSemanticRouter');

const activeMembers = [
    { id: 'VCP_Assistant', name: '小安' },
    { id: 'Codex_Projection', name: 'AI设计师 Codex', codexRelayAgent: true }
];

const groupConfig = {
    externalParticipants: [
        { actor_id: 'codex_ai_designer', actor_type: 'external_codex', actor_name_cn: 'AI设计师 Codex' }
    ],
    semanticRouter: { l2: { enabled: false } }
};

function route(text, userMessage = {}) {
    return router.routeByRules({ text, activeMembers, groupConfig, userMessage });
}

const cases = [
    {
        name: 'codex natural address without punctuation',
        text: 'codex你帮我解释刚才那个判断',
        target: ['Codex_Projection'],
        context: [],
        discussion: false
    },
    {
        name: 'codex leading address with freeform content',
        text: 'codex 端到端测试一下现在应该进入队列',
        target: ['Codex_Projection'],
        context: [],
        discussion: false
    },
    {
        name: 'xiaoan natural address without punctuation',
        text: '小安你看一下codex刚才这个方案有没有问题',
        target: ['VCP_Assistant'],
        context: ['Codex_Projection'],
        discussion: false
    },
    {
        name: 'codex addressed and xiaoan context only',
        text: 'codex你和小安刚才讨论那个机制时为什么这么判断',
        target: ['Codex_Projection'],
        context: ['VCP_Assistant'],
        discussion: false
    },
    {
        name: 'multiple agents discussion',
        text: '小安和codex你俩讨论一下这个规则',
        target: ['VCP_Assistant', 'Codex_Projection'],
        context: [],
        discussion: true
    },
    {
        name: '@codex direct mention',
        text: '@Codex 测试一下你能不能收到',
        target: ['Codex_Projection'],
        context: [],
        discussion: false
    },
    {
        name: 'agent mentioned only as context',
        text: '我刚才看了小安的观点觉得还行',
        target: [],
        context: ['VCP_Assistant'],
        discussion: false
    },
    {
        name: 'plain typed at text is not a structured mention',
        text: '@小安 测试一下',
        userMessage: { mentions: [] },
        target: [],
        context: [],
        discussion: false
    },
    {
        name: 'selected mention token targets xiaoan',
        text: '@小安 测试一下',
        userMessage: { mentions: [{ id: 'VCP_Assistant', name: '小安', identityKey: 'VCP_Assistant' }] },
        target: ['VCP_Assistant'],
        context: [],
        discussion: false
    }
];

for (const item of cases) {
    const result = route(item.text, item.userMessage || {});
    assert.deepStrictEqual(result.target_agents.sort(), item.target.sort(), `${item.name}: target_agents`);
    assert.deepStrictEqual(result.context_agents.sort(), item.context.sort(), `${item.name}: context_agents`);
    assert.strictEqual(result.discussion_mode, item.discussion, `${item.name}: discussion_mode`);
    assert.ok(result.reason, `${item.name}: reason`);
}

console.log(`groupSemanticRouter golden cases passed: ${cases.length}`);
