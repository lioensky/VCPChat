// modules/deskpet/idleChat.js
// 闲时主动搭话：用户在电脑前、但有一阵子没和助手说话时，让桌宠用助手自己的人设和最近的聊天说一句。
// 这一句记进这个助手固定的「桌宠闲聊」话题（不动用户正在聊的话题），点气泡就切过去接着聊。
// 这里只放判断、拼请求、清理回复和写话题这些不碰窗口的部分；什么时候问、交给哪个桌宠由 deskPetHandlers 决定。

const crypto = require('crypto');

const IDLE_CHAT_MINUTES = Object.freeze([10, 30, 60]);
const DEFAULT_IDLE_CHAT_MINUTES = 30;
// 键盘鼠标停了这么久就当人不在电脑前：对着空屋子说话白花钱
const AWAY_AFTER_SEC = 5 * 60;
// 深夜不说（本地时间 23:00–08:00）
const NIGHT_START_HOUR = 23;
const NIGHT_END_HOUR = 8;
// 生成失败后至少隔这么久再试，免得服务器不通时每分钟打一次
const RETRY_AFTER_MS = 10 * 60 * 1000;
const IDLE_TOPIC_NAME = '桌宠闲聊';
const IDLE_TOPIC_SOURCE = 'deskpet:idle-chat';
const HISTORY_TAKE = 8;
const HISTORY_CHARS = 600;
const LINE_MAX_CHARS = 160;

function normalizeMinutes(value) {
    const n = Number(value);
    return IDLE_CHAT_MINUTES.includes(n) ? n : DEFAULT_IDLE_CHAT_MINUTES;
}

function isNight(date) {
    const h = date.getHours();
    return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

/**
 * 现在该不该说。返回 { ok: true } 或 { ok: false, reason }，reason 只用来调试和测试。
 * lastActivityAt：最近一次和这个助手有来往（发消息、在桌宠上说话、桌宠主动说过）的时间。
 */
function shouldSpeak({ enabled, minutes, now, lastActivityAt = 0, lastAttemptAt = 0, lastFailedAt = 0, systemIdleSec = 0, locked = false, doNotDisturb = false, visible = true, busy = false }) {
    if (!enabled) return { ok: false, reason: 'off' };
    if (doNotDisturb) return { ok: false, reason: 'dnd' };
    if (!visible) return { ok: false, reason: 'hidden' };
    if (busy) return { ok: false, reason: 'busy' };
    if (locked || systemIdleSec >= AWAY_AFTER_SEC) return { ok: false, reason: 'away' };
    if (isNight(new Date(now))) return { ok: false, reason: 'night' };
    const gap = normalizeMinutes(minutes) * 60 * 1000;
    if (now - Math.max(lastActivityAt, lastAttemptAt) < gap) return { ok: false, reason: 'recent' };
    if (now - lastFailedAt < RETRY_AFTER_MS) return { ok: false, reason: 'retry-later' };
    return { ok: true };
}

function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    if (typeof content?.text === 'string') return content.text;
    return '';
}

function trimForContext(text) {
    const plain = String(text || '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    return plain.length > HISTORY_CHARS ? `${plain.slice(0, HISTORY_CHARS)}…` : plain;
}

function promptOf(config) {
    const mode = config?.promptMode || 'original';
    if (mode === 'preset' && typeof config?.presetSystemPrompt === 'string') return config.presetSystemPrompt;
    if (mode === 'modular' && typeof config?.advancedSystemPrompt === 'string') return config.advancedSystemPrompt;
    return String(config?.originalSystemPrompt ?? config?.systemPrompt ?? '');
}

/** 拼请求：助手自己的系统提示词 + 最近几句 + 一条说明。 */
function buildMessages({ config, agentName, history = [], promptAppend = '', userName = '用户', now = Date.now() }) {
    const system = [promptOf(config).replace(/\{\{AgentName\}\}/g, agentName || ''), promptAppend].filter((s) => s && s.trim()).join('\n\n');
    const recent = history
        .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && !m.isThinking)
        .slice(-HISTORY_TAKE)
        .map((m) => ({ role: m.role, content: trimForContext(messageText(m)) }))
        .filter((m) => m.content);
    const time = new Date(now);
    const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    const instruction = [
        `（现在是 ${clock}。${userName}在电脑前，但有一阵子没和你说话了。你在TA的桌面上，想主动搭一句话。`,
        '用你自己的口吻说一到两句，口语、简短，像随口一提：可以接着之前聊的，可以关心一下TA，也可以说点你自己想到的。',
        '不要提到这段说明，不要用工具，不要问「有什么可以帮你」。句首写一个情绪标记。）',
    ].join('');
    return [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...recent,
        { role: 'user', content: instruction },
    ];
}

const EMO_RE = /<!--\s*emo\s*[:：]\s*([a-z]+)(?:\/[a-z]+)?(?:\s+([0-9.]+))?\s*-->/i;

/** 回复整理成能说出口的一句；空的、太像在报错的返回 null。 */
function cleanLine(raw) {
    let text = String(raw || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const emo = EMO_RE.exec(text);
    // 工具调用块、控制标记、其余注释都不要
    text = text
        .replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\[\[[A-Za-z]+::[^\]\n]*\]\]/g, '')
        .replace(/^\s*["“「]|["”」]\s*$/g, '')
        .replace(/\n{2,}/g, '\n')
        .trim();
    if (!text) return null;
    if (text.length > LINE_MAX_CHARS) {
        const cut = text.slice(0, LINE_MAX_CHARS);
        const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('~'));
        text = end > 20 ? cut.slice(0, end + 1) : `${cut}…`;
    }
    const intensity = emo && emo[2] ? Math.max(0, Math.min(1, Number(emo[2]) || 0.6)) : 0.6;
    return { text, emotion: emo ? emo[1].toLowerCase() : null, intensity, raw: String(raw).trim() };
}

/** 调 VCP 服务器（OpenAI 兼容接口，不流式）。失败抛错。 */
async function generate({ fetchImpl = fetch, url, key, model, messages, timeoutMs = 45000 }) {
    if (!url || !model) throw new Error('没有配置服务器或模型');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({ model, messages, stream: false, temperature: 0.9, max_tokens: 2000 }),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
        const data = await response.json();
        return messageText(data?.choices?.[0]?.message);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 记进「桌宠闲聊」话题：没有就新建（不改主窗口当前话题），有就接在后面。返回话题 id。
 * updateConfig(agentId, updater) 与 historyQueue 是主进程里聊天记录用的那一套（串行写、原子替换）。
 */
async function recordLine({ agent, text, updateConfig, historyQueue, now = Date.now() }) {
    let topicId = null;
    await updateConfig(agent.id, (config) => {
        const topics = Array.isArray(config.topics) ? config.topics : [];
        const existing = topics.find((t) => t?.creatorSource === IDLE_TOPIC_SOURCE);
        if (existing) {
            topicId = existing.id;
            return { config: { ...config, topics: topics.map((t) => (t.id === existing.id ? { ...t, unread: true } : t)) }, result: null };
        }
        topicId = `topic_${now}_${crypto.randomUUID()}`;
        const topic = { id: topicId, name: IDLE_TOPIC_NAME, createdAt: now, locked: false, unread: true, creatorSource: IDLE_TOPIC_SOURCE };
        return { config: { ...config, topics: [topic, ...topics] }, result: null };
    });
    const message = {
        role: 'assistant',
        name: agent.name,
        content: text,
        timestamp: now,
        id: `msg_${now}_assistant_${crypto.randomUUID()}`,
        isThinking: false,
        avatarUrl: agent.avatarUrl || null,
        avatarColor: agent.avatarColor || 'rgb(96,106,116)',
        isGroupMessage: false,
        agentId: agent.id,
        finishReason: 'completed',
        _metadata: { createdBy: IDLE_TOPIC_SOURCE, createdAt: now, speaker_agent_id: agent.id, speaker_name: agent.name },
    };
    await historyQueue.mutate({ itemId: agent.id, itemType: 'agent', topicId }, (history) => [...history, message]);
    return topicId;
}

module.exports = {
    IDLE_CHAT_MINUTES,
    DEFAULT_IDLE_CHAT_MINUTES,
    AWAY_AFTER_SEC,
    RETRY_AFTER_MS,
    IDLE_TOPIC_NAME,
    IDLE_TOPIC_SOURCE,
    normalizeMinutes,
    isNight,
    shouldSpeak,
    buildMessages,
    cleanLine,
    generate,
    recordLine,
};
