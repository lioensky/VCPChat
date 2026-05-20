// Groupmodules/groupSemanticRouter.js
// Production-oriented group message router. It decides who is being asked to
// respond before local agents or bridge runners are invoked.

const http = require('http');
const https = require('https');
const fs = require('fs-extra');
const path = require('path');

const ROUTE_LAYERS = Object.freeze({
    L1_RULE: 'L1_RULE',
    L2_LOCAL_MODEL: 'L2_LOCAL_MODEL',
    L3_CLOUD_ARBITRATION: 'L3_CLOUD_ARBITRATION',
    FAIL_SAFE: 'FAIL_SAFE'
});

const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    failSafeTarget: 'current_main_agent',
    hardwareBaseline: 'rtx3060_6gb_or_12gb',
    modelTiers: {
        default: {
            model: 'Qwen/Qwen3-1.7B',
            deployment: 'local_quantized_q4_or_q5',
            note: 'Default commercial baseline. Intended to run on RTX 3060-class machines, not only high-end 4090 workstations.'
        },
        low_resource: {
            model: 'Qwen/Qwen3-0.6B',
            deployment: 'local_quantized',
            note: 'Emergency low-resource fallback only; not the default commercial experience for Chinese semantic routing.'
        },
        high_quality: {
            model: 'Qwen/Qwen3-4B',
            deployment: 'local_quantized',
            note: 'Optional high-quality tier for stronger machines; not a minimum deployment requirement.'
        }
    },
    l2: {
        enabled: false,
        provider: 'openai-compatible',
        endpoint: process.env.VCP_SEMANTIC_ROUTER_ENDPOINT || 'http://127.0.0.1:1234/v1/chat/completions',
        model: process.env.VCP_SEMANTIC_ROUTER_MODEL || 'Qwen/Qwen3-1.7B',
        timeoutMs: Number(process.env.VCP_SEMANTIC_ROUTER_TIMEOUT_MS || 1200),
        minConfidence: Number(process.env.VCP_SEMANTIC_ROUTER_MIN_CONFIDENCE || 0.75)
    },
    l3: {
        enabled: false
    }
});

function mergeConfig(base, override) {
    const result = { ...(base || {}) };
    for (const [key, value] of Object.entries(override || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = mergeConfig(result[key] || {}, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

function loadLocalOverride() {
    const localPath = path.join(__dirname, 'groupSemanticRouter.local.json');
    try {
        if (!fs.existsSync(localPath)) return {};
        const override = fs.readJsonSync(localPath);
        return override && typeof override === 'object' ? override : {};
    } catch (error) {
        console.warn(`[GroupSemanticRouter] Failed to load local override: ${error.message}`);
        return {};
    }
}

const ACTION_PATTERNS = [
    ['discuss', /(讨论|商量|一起聊|达成一致|互相反审|协作完成|你俩|你们两个|两位)/i],
    ['review', /(反审|审议|看一下|看看|有没有问题|评估|确认|把关)/i],
    ['explain', /(为什么|解释|怎么来的|怎么判断|判断成|说明一下|说一下)/i],
    ['recall', /(记得|记不记得|回忆|召回|之前|刚才|当时|群聊里)/i],
    ['execute', /(改|实现|落代码|处理|修|做|生成|同步|写入)/i],
    ['answer', /(回答|回复|怎么看|意见|建议|在不在)/i]
];

const DIRECT_VERBS = [
    '你', '请', '帮', '帮我', '看', '看下', '看一下', '看看', '确认', '回答',
    '解释', '处理', '说', '说一下', '补充', '评估', '反审', '审议', '检查',
    '改', '修', '实现', '落代码', '同步', '召回', '记得'
];

function normalizeText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeCompact(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[，,。.!！?？:：;；、"'“”‘’`]/g, '');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(items) {
    return [...new Set(items.filter(Boolean))];
}

function normalizeAgentId(id) {
    const value = String(id || '').trim();
    if (!value) return '';
    if (/^(codex|code|codex_projection|ai设计师codex|设计师codex)$/i.test(value)) return 'Codex_Projection';
    if (/^(xiaoan|小安|vcp|vcp_assistant)$/i.test(value)) return 'VCP_Assistant';
    return value;
}

function buildAgentCatalog(activeMembers = [], groupConfig = {}) {
    const catalog = new Map();

    function ensureAgent(id, name, aliases = [], source = 'member') {
        const agentId = normalizeAgentId(id);
        if (!agentId) return;
        const current = catalog.get(agentId) || { id: agentId, name: name || agentId, aliases: [], source };
        current.name = current.name || name || agentId;
        current.aliases.push(agentId, name || '', ...aliases);
        catalog.set(agentId, current);
    }

    for (const member of activeMembers || []) {
        ensureAgent(member.id, member.name, [
            ...(Array.isArray(member.aliases) ? member.aliases : []),
            ...(member.id === 'Codex_Projection' ? ['codex', 'code', 'AI设计师 Codex', '设计师Codex'] : []),
            ...(member.id === 'VCP_Assistant' ? ['小安', 'xiaoan', 'VCP Assistant'] : [])
        ], 'member');
    }

    for (const participant of groupConfig.externalParticipants || []) {
        const actorId = participant.actor_id || '';
        if (participant.actor_type === 'external_codex' || actorId === 'codex_ai_designer') {
            ensureAgent('Codex_Projection', participant.actor_name_cn || 'AI设计师 Codex', ['codex', 'code', 'AI设计师 Codex', '设计师Codex'], 'external');
        }
    }

    ensureAgent('Codex_Projection', 'AI设计师 Codex', ['codex', 'code', 'AI设计师 Codex', '设计师Codex'], 'builtin');
    ensureAgent('VCP_Assistant', '小安', ['小安', 'xiaoan'], 'builtin');

    return [...catalog.values()].map(agent => ({
        ...agent,
        aliases: unique(agent.aliases)
            .map(alias => String(alias || '').trim())
            .filter(alias => alias.length > 0)
            .sort((a, b) => b.length - a.length)
    }));
}

function findAliasMentions(compactText, agent, options = {}) {
    const hits = [];
    for (const alias of agent.aliases) {
        const compactAlias = normalizeCompact(alias);
        if (!compactAlias) continue;
        let index = compactText.indexOf(compactAlias);
        while (index >= 0) {
            const isAtPrefixed = index > 0 && compactText[index - 1] === '@';
            if (!(options.ignoreAtPrefixed && isAtPrefixed)) {
                hits.push({ alias, compactAlias, index, end: index + compactAlias.length });
            }
            index = compactText.indexOf(compactAlias, index + compactAlias.length);
        }
    }
    return hits.sort((a, b) => a.index - b.index || b.compactAlias.length - a.compactAlias.length);
}

function detectActionType(text) {
    for (const [type, pattern] of ACTION_PATTERNS) {
        if (pattern.test(text)) return type;
    }
    return 'message';
}

function hasDirectAddressAfter(compactText, mention) {
    const tail = compactText.slice(mention.end, mention.end + 10);
    return DIRECT_VERBS.some(verb => tail.startsWith(normalizeCompact(verb)));
}

function isLeadingAddress(compactText, mention) {
    if (mention.index > 2) return false;
    const after = compactText.slice(mention.end, mention.end + 12);
    if (!after) return false;
    return !/^(刚才|之前|当时|的|说|观点|方案|讨论|回复|判断|和|跟|与|以及)/.test(after);
}

function hasAtMention(rawText, agent) {
    return agent.aliases.some(alias => {
        const compactAlias = normalizeCompact(alias);
        if (!compactAlias) return false;
        const pattern = new RegExp(`@\\s*${escapeRegExp(alias).replace(/\\ /g, '\\s*')}`, 'i');
        return pattern.test(rawText) || normalizeCompact(rawText).includes(`@${compactAlias}`);
    });
}

function isContextOnly(compactText, mention) {
    const before = compactText.slice(Math.max(0, mention.index - 4), mention.index);
    const after = compactText.slice(mention.end, mention.end + 8);
    return /(和|跟|与|同|以及)$/.test(before)
        || /^(刚才|之前|当时|的|说|观点|方案|讨论|回复|判断)/.test(after);
}

function hasPluralDiscussion(compactText) {
    return /(你俩|你们俩|你们两个|两位|一起讨论|讨论一下|商量一下|达成一致|协作完成|互相反审)/.test(compactText);
}

function routeByRules({ text, activeMembers, groupConfig, userMessage = {} }) {
    const rawText = normalizeText(text);
    const compactText = normalizeCompact(rawText);
    const catalog = buildAgentCatalog(activeMembers, groupConfig);
    const actionType = detectActionType(rawText);
    const targetAgents = [];
    const contextAgents = [];
    const reasons = [];
    const structuredMentions = Array.isArray(userMessage.mentions)
        ? userMessage.mentions
        : (Array.isArray(userMessage.content?.mentions) ? userMessage.content.mentions : null);
    const hasStructuredMentionField = Array.isArray(structuredMentions);

    const mentionMap = new Map();
    for (const agent of catalog) {
        const hits = findAliasMentions(compactText, agent, { ignoreAtPrefixed: hasStructuredMentionField });
        if (hits.length > 0) mentionMap.set(agent.id, { agent, hits });
    }

    if (hasStructuredMentionField && structuredMentions.length > 0) {
        for (const mention of structuredMentions) {
            const mentionId = normalizeText(mention.id);
            const mentionIdentityKey = normalizeText(mention.identityKey);
            const mentionName = normalizeCompact(mention.name || mention.text);
            const matchedAgent = catalog.find(agent =>
                agent.id === mentionId
                || agent.id === mentionIdentityKey
                || agent.aliases.some(alias => normalizeCompact(alias) === mentionName || normalizeCompact(`@${alias}`) === mentionName)
            );
            if (matchedAgent) {
                targetAgents.push(matchedAgent.id);
                reasons.push(`structured mention targets ${matchedAgent.name}`);
            }
        }
    }

    if (!hasStructuredMentionField) {
        for (const { agent } of mentionMap.values()) {
            if (hasAtMention(rawText, agent)) {
                targetAgents.push(agent.id);
                reasons.push(`@ mention targets ${agent.name}`);
            }
        }
    }

    if (targetAgents.length === 0 && hasPluralDiscussion(compactText)) {
        for (const { agent } of mentionMap.values()) {
            targetAgents.push(agent.id);
        }
        if (targetAgents.length >= 2) {
            reasons.push('plural discussion wording targets multiple mentioned agents');
        }
    }

    if (targetAgents.length === 0) {
        for (const { agent, hits } of mentionMap.values()) {
            const primary = hits[0];
            if (hasDirectAddressAfter(compactText, primary) || isLeadingAddress(compactText, primary)) {
                targetAgents.push(agent.id);
                reasons.push(`direct address near ${agent.name}`);
                continue;
            }
            if (isContextOnly(compactText, primary)) {
                contextAgents.push(agent.id);
                reasons.push(`${agent.name} appears as context only`);
            }
        }
    }

    if (targetAgents.length > 0) {
        for (const { agent, hits } of mentionMap.values()) {
            if (targetAgents.includes(agent.id)) continue;
            if (hits.some(hit => isContextOnly(compactText, hit))) contextAgents.push(agent.id);
        }
    }

    const uniqueTargets = unique(targetAgents);
    const uniqueContexts = unique(contextAgents).filter(id => !uniqueTargets.includes(id));
    const discussionMode = uniqueTargets.length >= 2 && (actionType === 'discuss' || hasPluralDiscussion(compactText));

    if (uniqueTargets.length > 0) {
        return {
            enabled: true,
            target_agents: uniqueTargets,
            context_agents: uniqueContexts,
            action_type: discussionMode ? 'discuss' : actionType,
            discussion_mode: discussionMode,
            confidence: hasPluralDiscussion(compactText) || rawText.includes('@') ? 0.98 : 0.9,
            route_layer: ROUTE_LAYERS.L1_RULE,
            reason: reasons.join('; ') || 'rule-based direct target detected',
            fallback_reason: ''
        };
    }

    if (mentionMap.size > 0 && uniqueContexts.length > 0) {
        return {
            enabled: true,
            target_agents: [],
            context_agents: uniqueContexts,
            action_type: actionType,
            discussion_mode: false,
            confidence: 0.72,
            route_layer: ROUTE_LAYERS.FAIL_SAFE,
            reason: reasons.join('; ') || 'agent names appear only as context',
            fallback_reason: 'context_only_mentions_without_clear_target'
        };
    }

    return {
        enabled: true,
        target_agents: [],
        context_agents: [],
        action_type: actionType,
        discussion_mode: false,
        confidence: 0.55,
        route_layer: ROUTE_LAYERS.FAIL_SAFE,
        reason: 'no explicit agent target detected',
        fallback_reason: 'no_target'
    };
}

function postJson(urlString, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request({
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
            },
            timeout: timeoutMs
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`semantic router model returned ${res.statusCode}: ${text.slice(0, 300)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                } catch (error) {
                    reject(new Error(`semantic router model returned invalid JSON: ${error.message}`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error(`semantic router model timeout after ${timeoutMs}ms`));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

async function routeByLocalModel({ text, activeMembers, groupConfig, baseDecision, config }) {
    const l2 = config.l2 || {};
    if (l2.enabled !== true) return baseDecision;
    const catalog = buildAgentCatalog(activeMembers, groupConfig);
    const agentBrief = catalog.map(agent => ({
        id: agent.id,
        name: agent.name,
        aliases: agent.aliases
    }));
    const prompt = [
        '你是 VCPChat 的群聊语义路由器，只输出 JSON。',
        '判断用户消息应该由哪个 agent 回复，谁只是上下文对象。',
        '字段: target_agents, context_agents, action_type, discussion_mode, confidence, reason。',
        '如果不确定，不要猜；target_agents 为空，confidence 低于 0.75。',
        `可用 agent: ${JSON.stringify(agentBrief, null, 2)}`,
        `用户消息: ${text}`
    ].join('\n');
    try {
        const response = await postJson(l2.endpoint, {
            model: l2.model || DEFAULT_CONFIG.l2.model,
            messages: [
                { role: 'system', content: 'Return strict JSON only.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0,
            max_tokens: 260
        }, l2.timeoutMs || DEFAULT_CONFIG.l2.timeoutMs);
        const content = response?.choices?.[0]?.message?.content || response?.choices?.[0]?.text || '';
        const parsed = extractJsonObject(content);
        if (!parsed || !Array.isArray(parsed.target_agents) || typeof parsed.confidence !== 'number') {
            return {
                ...baseDecision,
                route_layer: ROUTE_LAYERS.FAIL_SAFE,
                fallback_reason: 'l2_invalid_output',
                reason: `${baseDecision.reason}; L2 invalid output`
            };
        }
        const allowedIds = new Set(catalog.map(agent => agent.id));
        const targetAgents = unique(parsed.target_agents.map(normalizeAgentId)).filter(id => allowedIds.has(id));
        const contextAgents = unique((parsed.context_agents || []).map(normalizeAgentId)).filter(id => allowedIds.has(id) && !targetAgents.includes(id));
        const confidence = Math.max(0, Math.min(1, Number(parsed.confidence)));
        if (confidence < (l2.minConfidence || DEFAULT_CONFIG.l2.minConfidence)) {
            return {
                ...baseDecision,
                target_agents: [],
                context_agents: contextAgents,
                action_type: parsed.action_type || baseDecision.action_type,
                discussion_mode: false,
                confidence,
                route_layer: ROUTE_LAYERS.FAIL_SAFE,
                reason: parsed.reason || baseDecision.reason,
                fallback_reason: 'l2_low_confidence'
            };
        }
        return {
            enabled: true,
            target_agents: targetAgents,
            context_agents: contextAgents,
            action_type: parsed.action_type || baseDecision.action_type,
            discussion_mode: Boolean(parsed.discussion_mode),
            confidence,
            route_layer: ROUTE_LAYERS.L2_LOCAL_MODEL,
            reason: parsed.reason || 'local semantic model route',
            fallback_reason: ''
        };
    } catch (error) {
        return {
            ...baseDecision,
            route_layer: baseDecision.target_agents.length > 0 ? baseDecision.route_layer : ROUTE_LAYERS.FAIL_SAFE,
            fallback_reason: baseDecision.target_agents.length > 0 ? '' : `l2_unavailable:${error.message}`,
            reason: `${baseDecision.reason}; L2 unavailable`
        };
    }
}

async function routeGroupMessage({ text, activeMembers = [], groupConfig = {}, userMessage = {}, history = [] }) {
    const config = mergeConfig(
        mergeConfig(DEFAULT_CONFIG, groupConfig.semanticRouter || {}),
        loadLocalOverride()
    );
    if (config.enabled === false || userMessage?.metadata?.suppress_agents === true || userMessage?.suppressAgents === true) {
        return {
            enabled: false,
            target_agents: [],
            context_agents: [],
            action_type: 'message',
            discussion_mode: false,
            confidence: 1,
            route_layer: 'DISABLED',
            reason: 'semantic router disabled or agents suppressed',
            fallback_reason: ''
        };
    }
    const l1Decision = routeByRules({ text, activeMembers, groupConfig, userMessage, history });
    if (l1Decision.route_layer === ROUTE_LAYERS.L1_RULE && l1Decision.confidence >= 0.9) {
        return l1Decision;
    }
    return routeByLocalModel({ text, activeMembers, groupConfig, baseDecision: l1Decision, config });
}

module.exports = {
    ROUTE_LAYERS,
    DEFAULT_CONFIG,
    buildAgentCatalog,
    routeByRules,
    routeGroupMessage
};
