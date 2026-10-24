// modules/deskpet/petStream.js
// 主聊天那边的回复流原样转给桌宠页面（表情和气泡由页面里的情绪导演决定），
// 外加桌宠开着时要追加到 system prompt 的情绪标记和动作说明。

// 桌宠能演的动作写在情绪标记的斜杠后面（DeskPetmodules/gestures.js），标记本身哪里都会去掉。
const GESTURE_PROMPT = [
    '【桌宠动作】桌面上的你还会做动作：想配合动作时，把动作名写在情绪标记的斜杠后面，例如 <!--emo:happy/nod 0.8-->。',
    '动作只能是：nod（点头）shake（摇头）tilt（歪头）cheer（开心地跳一下）bow（鞠躬）。只在真的有这个动作时写，不要每句都写。',
].join('\n');

function createPetStream(ctx) {
    const { pets } = ctx;

    /** 该 agent 的桌宠打开时，返回要追加到 system prompt 的情绪标记和动作说明（情绪标记与侧栏差分立绘共用一段）。 */
    function getSystemPromptAppend(agentId, systemPrompt = '') {
        if (!agentId || !pets.has(agentId) || !ctx.emotionPrompt) return '';
        // 侧栏立绘已经加过、或者角色自己的提示词里写了标记说明，就不再重复。
        const parts = [];
        if (ctx.emotionPrompt.shouldAddEmotionTagPrompt({ systemPrompt, hasDisplay: true })) parts.push(ctx.emotionPrompt.EMOTION_TAG_PROMPT);
        if (!/【桌宠动作】|<!--\s*emo\s*[:：][^>]*\/(?:nod|shake|tilt|cheer|bow)\b/i.test(String(systemPrompt || ''))) parts.push(GESTURE_PROMPT);
        return parts.join('\n');
    }

    function appendProtocolToMessages(messages, agentId) {
        if (!Array.isArray(messages)) return messages;
        const first = messages[0];
        const hasSystem = first && first.role === 'system' && typeof first.content === 'string';
        const append = getSystemPromptAppend(agentId, hasSystem ? first.content : '');
        if (!append) return messages;
        if (hasSystem) return [{ ...first, content: `${first.content}\n\n${append}` }, ...messages.slice(1)];
        return [{ role: 'system', content: append }, ...messages];
    }

    function extractDeltaText(chunk) {
        if (typeof chunk === 'string') return chunk;
        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
        const delta = choice?.delta || choice?.message || {};
        return typeof delta.content === 'string' ? delta.content : '';
    }

    // 回复流原样转给页面，由页面里的情绪导演决定表情和气泡内容。
    function forward(agentId, event) {
        const changed = ctx.sessions.update(agentId, event);
        const pet = agentId && pets.get(agentId);
        // token 继续到来时不重复序列化整份会话列表；开始回复、结束、标题变动时再发快照。
        if (pet && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:stream', {
            ...event, ...(event.type !== 'data' || changed ? { session: ctx.sessions.get(agentId) } : {}),
        });
    }

    function onRequestStart(messageId, context) {
        ctx.sessions.start(messageId, context);
        if (context?.agentId) {
            ctx.lastTalkedAgentId = context.agentId;
            ctx.idle?.noteActivity(context.agentId);
        }
        forward(context?.agentId, { type: 'start', messageId: String(messageId) });
    }

    function onStreamPayload(payload) {
        const agentId = payload?.context?.agentId;
        if (!agentId) return;
        const messageId = String(payload.messageId);
        if (payload.type === 'data') {
            const text = extractDeltaText(payload.chunk);
            if (text) forward(agentId, { type: 'data', messageId, text });
        } else if (payload.type === 'end') {
            forward(agentId, { type: 'end', messageId, ...(payload.aborted ? { aborted: true } : {}) });
        } else if (payload.type === 'error') {
            // 出错的原因也带过去（主窗口里显示的那句）：桌宠上只写「出错了」的话，用户不知道是断网、超时还是服务器报错
            const reason = typeof payload.error === 'string' ? payload.error.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
            forward(agentId, { type: 'error', messageId, ...(reason ? { error: reason } : {}) });
        }
    }

    /** 非流式回复：整条内容一次性转过去。 */
    function onFullResponse(messageId, context, response) {
        const agentId = context?.agentId;
        if (!agentId) return;
        const text = response?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text) forward(agentId, { type: 'data', messageId: String(messageId), text });
        forward(agentId, { type: 'end', messageId: String(messageId) });
    }

    return {
        getSystemPromptAppend,
        appendProtocolToMessages,
        extractDeltaText,
        forward,
        onRequestStart,
        onStreamPayload,
        onFullResponse,
    };
}

module.exports = { createPetStream, GESTURE_PROMPT };
