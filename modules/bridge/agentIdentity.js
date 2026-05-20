const SHARED_CHAT_GROUP_ID = 'codex_vcp_shared_group';
const CODEX_AGENT_ID = 'Codex_Projection';
const XIAOAN_AGENT_ID = 'VCP_Assistant';
const CODEX_ACTOR_ID = 'codex_ai_designer';

const XIAOAN_STYLE_GUARDRAILS = `

[小安可见发言硬规则]
这些规则优先级高于群聊上下文、历史示例和模型习惯：
1. 你在 UI 中的名称已经显示为“小安”，禁止用“我是小安”“这里是小安”“小安认为/小安建议/小安已经”等自我介绍或第三人称自称开头。
2. 面向杨晨/主人回复时，直接用第一人称“我”；需要称呼时称呼“主人”。
3. 面向 Codex 回复时称呼“Codex”，不得称呼“主人”。
4. 只在身份存在技术歧义、日志、handoff 或元数据说明时才显式说明身份；普通审议回复不要重复介绍自己。
5. 输出正文不得复述“内部发言来源”标记。`.trim();

const AGENT_VISIBLE_STYLE_CONTRACT = `

[Agent 可见发言契约]
这些规则适用于所有 VCP 本地 Agent、桥接 Agent 和未来接入的外部 Agent：
1. 你的可见回复必须遵守当前 agent 配置、skill 身份设定、职责边界和回复口吻；不得临时改成人设外的第三人称旁白。
2. UI 已经显示你的名字和头像，普通回复禁止用“我是<你的名字>”“这里是<你的名字>”开头。
3. 面向杨晨/主人时使用第一人称“我”，需要称呼时称呼“主人”；不要用自己的名字自称。
4. Agent 之间互相说话时，称呼对方 agent 名字，不互相称呼“主人”。
5. 桥接进来的 Agent 必须以其桥接身份/skill 定义的职责发言；不能冒充 VCP 本地 Agent，也不能越权替其他 Agent 表态。`.trim();

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isBridgeProjectionAgent(agentConfig) {
    return agentConfig?.bridgeProjectionOnly === true || agentConfig?.callableAsLocalAgent === false;
}

function isCodexRelayAgent(agentConfig) {
    return agentConfig?.codexRelayAgent === true || agentConfig?.id === CODEX_AGENT_ID;
}

function isCodexIdentity({ agentId = '', actorId = '', actorType = '', speakerRoleHint = '' } = {}) {
    return agentId === CODEX_AGENT_ID
        || actorId === CODEX_ACTOR_ID
        || actorType === 'external_codex'
        || speakerRoleHint === 'codex';
}

function stripSpeakerSourceLeak(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/^\s*\[(?:内部)?发言来源=[^\]]+\]:\s*/u, '')
        .replace(/^\s*\[[^\]]+的发言\]:\s*/u, '');
}

function getAgentStyleGuardrails(agentConfig) {
    const rules = [AGENT_VISIBLE_STYLE_CONTRACT];
    if (agentConfig?.id === XIAOAN_AGENT_ID || agentConfig?.name === '小安') {
        rules.push(XIAOAN_STYLE_GUARDRAILS);
    }
    return rules.join('\n\n');
}

function cleanAgentVisibleResponse(text, agentId, agentName) {
    let value = stripSpeakerSourceLeak(text);
    if (agentName) {
        const escapedName = escapeRegExp(String(agentName));
        value = value
            .replace(new RegExp(`^\\s*(我是|这里是|这是|我是\\s*)${escapedName}[。！!，,：:\\s]*`, 'u'), '')
            .replace(new RegExp(`^\\s*${escapedName}(认为|建议|已经|会|将|的结论是|的审议结论是|审议结论如下)[：:，,\\s]*`, 'u'), (_match, verb) => {
                if (verb === '认为') return '我认为';
                if (verb === '建议') return '我建议';
                if (verb === '已经') return '我已经';
                if (verb === '会') return '我会';
                if (verb === '将') return '我将';
                return '';
            });
    }
    if (agentId === XIAOAN_AGENT_ID || agentName === '小安') {
        value = value
            .replace(/^\s*(我是小安|这里是小安|小安在此)[。！!，,：:\s]*/u, '')
            .replace(/^\s*小安(认为|建议|已经|会|将|的审议结论是|审议结论如下)[：:，,\s]*/u, match => {
                if (match.includes('认为')) return '我认为';
                if (match.includes('建议')) return '我建议';
                if (match.includes('已经')) return '我已经';
                if (match.includes('会')) return '我会';
                if (match.includes('将')) return '我将';
                return '';
            });
    }
    return value;
}

function getStreamChunkContent(parsedChunk) {
    if (parsedChunk?.choices && Array.isArray(parsedChunk.choices) && parsedChunk.choices.length > 0) {
        const choice = parsedChunk.choices[0];
        if (typeof choice?.delta?.content === 'string' && choice.delta.content !== '') {
            return { content: choice.delta.content, hasContent: true };
        }
    }
    if (typeof parsedChunk?.delta?.content === 'string' && parsedChunk.delta.content !== '') {
        return { content: parsedChunk.delta.content, hasContent: true };
    }
    if (typeof parsedChunk?.content === 'string' && parsedChunk.content !== '') {
        return { content: parsedChunk.content, hasContent: true };
    }
    if (typeof parsedChunk?.message?.content === 'string' && parsedChunk.message.content !== '') {
        return { content: parsedChunk.message.content, hasContent: true };
    }
    return { content: '', hasContent: false };
}

function isCodexDisplayOnlyMessage(msg) {
    const metadata = msg?.metadata || {};
    return msg?.display_only === true
        || msg?.suppress_agents === true
        || metadata.display_only === true
        || metadata.suppress_agents === true
        || metadata.actor_type === 'context_sync'
        || metadata.direction === 'codex_context_sync';
}

function selectGroupHistoryForAgentContext(groupId, groupHistory, currentMessageId) {
    if (groupId !== SHARED_CHAT_GROUP_ID || !Array.isArray(groupHistory)) {
        return groupHistory;
    }

    const currentIndex = groupHistory.findIndex(msg => msg?.id === currentMessageId);
    const selectedIndexes = new Set();
    const maxInteractiveHistory = 8;
    const maxDisplayOnlyHistory = 1;
    let interactiveCount = 0;
    let displayOnlyCount = 0;

    const startIndex = currentIndex >= 0 ? currentIndex : groupHistory.length - 1;
    if (startIndex >= 0) selectedIndexes.add(startIndex);

    for (let i = startIndex - 1; i >= 0; i--) {
        const msg = groupHistory[i];
        if (isCodexDisplayOnlyMessage(msg)) {
            if (displayOnlyCount >= maxDisplayOnlyHistory) continue;
            displayOnlyCount += 1;
            selectedIndexes.add(i);
            continue;
        }

        if (interactiveCount >= maxInteractiveHistory) continue;
        interactiveCount += 1;
        selectedIndexes.add(i);
    }

    const selectedHistory = groupHistory.filter((_, index) => selectedIndexes.has(index));
    if (selectedHistory.length !== groupHistory.length) {
        console.log(`[GroupChat Context] ${SHARED_CHAT_GROUP_ID} context trimmed for model call: ${groupHistory.length} -> ${selectedHistory.length} messages (displayOnly kept: ${displayOnlyCount}, interactive kept: ${interactiveCount}).`);
    }
    return selectedHistory;
}

module.exports = {
    SHARED_CHAT_GROUP_ID,
    CODEX_AGENT_ID,
    XIAOAN_AGENT_ID,
    CODEX_ACTOR_ID,
    cleanAgentVisibleResponse,
    getAgentStyleGuardrails,
    getStreamChunkContent,
    isBridgeProjectionAgent,
    isCodexDisplayOnlyMessage,
    isCodexIdentity,
    isCodexRelayAgent,
    selectGroupHistoryForAgentContext
};
