'use strict';

const DEFAULT_NAVIGATOR_PROMPT = [
    '你是智能群聊的发言导航员。请根据当前群聊的最新内容、成员身份与成员各自的发言触发风格，判断谁最有必要继续发言。',
    '优先考虑：被直接询问或点名、具备相关知识、能够补充新信息、需要回应误解或冲突、能够自然承接当前话题的成员。',
    '降低以下成员的优先级：刚刚已经充分表达、只会重复已有内容、与当前话题无关、没有实质推进价值的成员。',
    '如果问题已经解决、话题自然结束、继续回复只会重复或尴尬延长对话，请优先选择结束群聊。',
    '不要为了维持活跃而强行安排发言。'
].join('');

const DEFAULT_JEV_MODE_SETTINGS = Object.freeze({
    navigatorPrompt: DEFAULT_NAVIGATOR_PROMPT,
    speakerThreshold: 0.16,
    continueThreshold: 0.45,
    stopThreshold: 0.55,
    maxSpeakersPerRound: 3,
    maxAutonomousRounds: 12,
    historyWindow: 12,
    continueDebounceMs: 800,
    fallbackPolicy: 'stop',
    memberStyles: Object.freeze({})
});

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function clampInteger(value, fallback, min, max) {
    return Math.round(clampNumber(value, fallback, min, max));
}

function normalizeJevModeSettings(value = {}, memberIds = []) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const sourceStyles = source.memberStyles && typeof source.memberStyles === 'object' && !Array.isArray(source.memberStyles)
        ? source.memberStyles
        : {};
    const memberStyles = {};
    for (const memberId of memberIds) {
        if (typeof memberId !== 'string' || !memberId) continue;
        memberStyles[memberId] = typeof sourceStyles[memberId] === 'string'
            ? sourceStyles[memberId].trim()
            : '';
    }

    return {
        ...source,
        navigatorPrompt: typeof source.navigatorPrompt === 'string' && source.navigatorPrompt.trim()
            ? source.navigatorPrompt.trim()
            : DEFAULT_NAVIGATOR_PROMPT,
        speakerThreshold: clampNumber(source.speakerThreshold, DEFAULT_JEV_MODE_SETTINGS.speakerThreshold, 0, 1),
        continueThreshold: clampNumber(source.continueThreshold, DEFAULT_JEV_MODE_SETTINGS.continueThreshold, 0, 1),
        stopThreshold: clampNumber(source.stopThreshold, DEFAULT_JEV_MODE_SETTINGS.stopThreshold, 0, 1),
        maxSpeakersPerRound: clampInteger(source.maxSpeakersPerRound, DEFAULT_JEV_MODE_SETTINGS.maxSpeakersPerRound, 1, 32),
        maxAutonomousRounds: clampInteger(source.maxAutonomousRounds, DEFAULT_JEV_MODE_SETTINGS.maxAutonomousRounds, 1, 100),
        historyWindow: clampInteger(source.historyWindow, DEFAULT_JEV_MODE_SETTINGS.historyWindow, 1, 200),
        continueDebounceMs: clampInteger(source.continueDebounceMs, DEFAULT_JEV_MODE_SETTINGS.continueDebounceMs, 0, 10000),
        fallbackPolicy: source.fallbackPolicy === 'top_speaker' ? 'top_speaker' : 'stop',
        memberStyles
    };
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (content && typeof content.text === 'string') return content.text;
    if (Array.isArray(content)) {
        return content
            .filter(part => part && part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

function buildMemberRuntime(activeMembers, history, settings, runtime = {}) {
    return activeMembers.map(member => {
        let messagesSinceLastSpeech = null;
        let speechCount = 0;
        for (let index = history.length - 1; index >= 0; index--) {
            if (history[index]?.agentId !== member.id) continue;
            speechCount += 1;
            if (messagesSinceLastSpeech === null) {
                messagesSinceLastSpeech = history.length - index - 1;
            }
        }
        return {
            agentId: member.id,
            name: member.name || member.id,
            triggerStyle: settings.memberStyles[member.id] || '',
            messagesSinceLastSpeech,
            totalSpeechCount: speechCount,
            autonomousRunSpeechCount: Number(runtime.speechCounts?.[member.id]) || 0,
            manuallyQueued: Array.isArray(runtime.manuallyQueuedAgentIds)
                && runtime.manuallyQueuedAgentIds.includes(member.id)
        };
    });
}

function buildDecisionRequest(activeMembers, history, groupConfig, runtime = {}) {
    const memberIds = activeMembers.map(member => member.id);
    const settings = normalizeJevModeSettings(groupConfig?.modeSettings?.jev, memberIds);
    const optionToAgentId = {};
    const criteria = {};

    activeMembers.forEach((member, index) => {
        const optionKey = `agent_${index}`;
        optionToAgentId[optionKey] = member.id;
        const style = settings.memberStyles[member.id] || '未配置特殊触发风格；根据上下文相关性判断。';
        criteria[optionKey] = `${member.name || member.id}：${style}`;
    });
    criteria.end_conversation = '当前话题已经自然结束、问题已解决，或继续发言只会重复已有内容。';

    const recentHistory = history.slice(-settings.historyWindow).map(message => ({
        id: message.id || null,
        role: message.role || 'unknown',
        speakerName: message.name || (message.role === 'user' ? '用户' : 'AI'),
        agentId: message.agentId || null,
        text: contentToText(message.content),
        timestamp: typeof message.timestamp === 'number' ? message.timestamp : null
    }));

    return {
        settings,
        optionToAgentId,
        state: {
            group: {
                id: groupConfig?.id || null,
                name: groupConfig?.name || '',
                prompt: groupConfig?.groupPrompt || ''
            },
            recentMessages: recentHistory,
            members: buildMemberRuntime(activeMembers, history, settings, runtime),
            runtime: {
                trigger: runtime.trigger || 'automatic',
                autonomousRound: Number(runtime.autonomousRound) || 0,
                forceContinue: runtime.forceContinue === true,
                latestUserMessageId: runtime.latestUserMessageId || null
            }
        },
        questions: {
            speaker_routing: {
                type: 'choice',
                instructions: settings.navigatorPrompt,
                criteria
            },
            continue_discussion: {
                type: 'noul',
                instructions: '基于当前对话，继续由群聊成员自主推进是否仍然自然、有价值且不会只是重复？'
            }
        }
    };
}

function normalizeProbability(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
}

function parseDecisionResponse(response, request, activeMembers, runtime = {}) {
    const { settings, optionToAgentId } = request;
    const routingAnswer = response?.answers?.speaker_routing || {};
    const continueAnswer = response?.answers?.continue_discussion || {};
    const probabilities = routingAnswer.probabilities && typeof routingAnswer.probabilities === 'object'
        ? routingAnswer.probabilities
        : {};
    const continueProbability = normalizeProbability(continueAnswer.noul);
    const endProbability = normalizeProbability(probabilities.end_conversation);
    const forceContinue = runtime.forceContinue === true;

    const ranked = Object.entries(optionToAgentId)
        .map(([optionKey, agentId]) => ({
            optionKey,
            agentId,
            probability: normalizeProbability(probabilities[optionKey]),
            agent: activeMembers.find(member => member.id === agentId) || null
        }))
        .filter(candidate => candidate.agent)
        .sort((left, right) => right.probability - left.probability);

    const highestSpeakerProbability = ranked[0]?.probability || 0;
    let stopReason = null;
    if (!forceContinue && continueProbability < settings.continueThreshold) {
        stopReason = 'continue_probability_below_threshold';
    } else if (
        !forceContinue
        && endProbability >= settings.stopThreshold
        && endProbability >= highestSpeakerProbability
    ) {
        stopReason = 'end_option_selected';
    }

    let selected = stopReason
        ? []
        : ranked
            .filter(candidate => candidate.probability >= settings.speakerThreshold)
            .slice(0, settings.maxSpeakersPerRound);

    if (
        selected.length === 0
        && forceContinue
        && ranked.length > 0
    ) {
        selected = [ranked[0]];
    } else if (
        selected.length === 0
        && !stopReason
        && settings.fallbackPolicy === 'top_speaker'
        && ranked.length > 0
    ) {
        selected = [ranked[0]];
    }

    if (selected.length === 0 && !stopReason) {
        stopReason = 'no_speaker_above_threshold';
    }

    return {
        shouldStop: Boolean(stopReason),
        stopReason,
        selectedAgentIds: selected.map(candidate => candidate.agentId),
        selectedAgents: selected.map(candidate => candidate.agent),
        rankedSpeakers: ranked.map(({ agent, ...candidate }) => ({
            ...candidate,
            name: agent.name || agent.id
        })),
        continueProbability,
        endProbability,
        rawChoice: routingAnswer.choice || null,
        confidence: normalizeProbability(routingAnswer.confidence),
        usage: response?.usage || null
    };
}

class JevDecisionMode {
    constructor({ jevService, logger = console } = {}) {
        if (!jevService || typeof jevService.decide !== 'function') {
            throw new TypeError('JevDecisionMode requires a jevService.');
        }
        this.jevService = jevService;
        this.logger = logger;
    }

    async decide(activeMembers, history, groupConfig, runtime = {}, options = {}) {
        if (!Array.isArray(activeMembers) || activeMembers.length === 0) {
            return {
                shouldStop: true,
                stopReason: 'no_active_members',
                selectedAgentIds: [],
                selectedAgents: [],
                rankedSpeakers: [],
                continueProbability: 0,
                endProbability: 1,
                rawChoice: null,
                confidence: 1,
                usage: null
            };
        }

        const request = buildDecisionRequest(activeMembers, history, groupConfig, runtime);
        const response = await this.jevService.decide(
            request.state,
            request.questions,
            { signal: options.signal }
        );
        const decision = parseDecisionResponse(response, request, activeMembers, runtime);
        this.logger.log(
            `[JevDecisionMode] round=${runtime.autonomousRound || 0}, ` +
            `selected=${decision.selectedAgentIds.join(',') || 'none'}, ` +
            `continue=${decision.continueProbability.toFixed(3)}, ` +
            `end=${decision.endProbability.toFixed(3)}, ` +
            `stop=${decision.stopReason || 'no'}`
        );
        return decision;
    }
}

module.exports = {
    JevDecisionMode,
    DEFAULT_NAVIGATOR_PROMPT,
    DEFAULT_JEV_MODE_SETTINGS,
    normalizeJevModeSettings,
    buildDecisionRequest,
    parseDecisionResponse
};