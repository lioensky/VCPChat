// modules/deskpet/petProactive.js
// 让桌宠自己开口的几件事：AI 主动开的新话题、闹钟到点，以及主窗口转过来的工具审批卡片。
// 这些原本只在主窗口里冒个未读或弹个小窗，桌宠开着时让角色说出来。

const crypto = require('crypto');

const ALARM_MAX_DELAY_MS = 7 * 24 * 3600 * 1000;
const MAX_ALARMS = 50;
// 同一个闹钟的结果回来两次（请求重放）时只记一个：提醒相同、到点时间差不到一分钟
const ALARM_SAME_MS = 60 * 1000;
const MAX_PENDING_APPROVALS = 50;

function createPetProactive(ctx) {
    const { pets } = ctx;
    const alarms = new Map(); // id -> { timer, dueAt, text, maid }
    const announcedTopics = new Set(); // 已经在桌宠上说过的话题（同一请求重放时结果会重复回来）
    const pendingApprovals = new Map(); // requestId → { agentId, payload }

    function proactive(agentId, payload) {
        const pet = pets.get(agentId);
        if (!pet || pet.win.isDestroyed()) return false;
        // 闹钟要叫得醒人：藏起来的桌宠也出来；新话题不打扰藏起来的桌宠，免打扰时也不说。
        if (payload.kind === 'alarm') ctx.windows.showPet(pet);
        else if (!pet.win.isVisible() || ctx.controls?.get().doNotDisturb) return false;
        pet.win.webContents.send('deskpet:proactive', payload);
        return true;
    }

    async function agentIdByName(name) {
        if (!name) return null;
        const wanted = String(name).trim().toLowerCase();
        const agents = await ctx.listAgents().catch(() => []);
        const open = agents.filter((agent) => pets.has(agent.id));
        return open.find((agent) => agent.name.toLowerCase() === wanted || agent.id.toLowerCase() === wanted)?.id || null;
    }

    // 闹钟交给谁：设闹钟时说了是谁（maid）就找那个 agent 的桌宠；否则最近在聊的那个；再不行任意一个开着的。
    async function alarmTarget(maid) {
        const named = await agentIdByName(maid);
        if (named) return named;
        if (ctx.lastTalkedAgentId && pets.has(ctx.lastTalkedAgentId)) return ctx.lastTalkedAgentId;
        return ctx.visibleAgents()[0] || [...pets.keys()][0] || null;
    }

    // ---- 工具审批 ---------------------------------------------------------------------
    // 服务器要人点头的工具调用，主窗口判完自动允许规则后仍待批的，转给发起它的助手的桌宠一份。
    // 应答仍由主窗口发出（它管着去重、过期和理由框），桌宠只是另一个按钮；谁先答都算，答完两边都收起。

    async function offerApproval(raw) {
        if (!raw || typeof raw !== 'object') return false;
        const requestId = typeof raw.requestId === 'string' || typeof raw.requestId === 'number' ? String(raw.requestId) : '';
        if (!requestId || pendingApprovals.has(requestId)) return false;
        const ttl = Number(raw.expiresInMs);
        if (raw.expiresInMs != null && Number.isFinite(ttl) && ttl <= 0) return false;
        const payload = {
            requestId,
            toolName: String(raw.toolName || '').slice(0, 120),
            command: String(raw.command ?? '').slice(0, 2000),
            expiresAt: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl : null,
        };
        // 查助手目录前先占位：查询期间主窗口可能已经应答，也可能重放同一请求。
        // 过期时间从收到请求起算，不能被慢查询延长。
        const entry = { agentId: null, payload };
        pendingApprovals.set(requestId, entry);
        if (pendingApprovals.size > MAX_PENDING_APPROVALS) settleApproval(pendingApprovals.keys().next().value);
        try {
            // 认得出是谁要的就给谁；认不出（没写 maid、名字对不上）就给最近在聊的那个
            const agentId = (await agentIdByName(raw.maid)) || (ctx.lastTalkedAgentId && pets.has(ctx.lastTalkedAgentId) ? ctx.lastTalkedAgentId : null);
            if (pendingApprovals.get(requestId) !== entry) return false;
            if (payload.expiresAt !== null && payload.expiresAt <= Date.now()) return false;
            const pet = agentId && pets.get(agentId);
            if (!pet || pet.win.isDestroyed() || ctx.shuttingDown) return false;
            entry.agentId = agentId;
            if (pet.ready) pet.win.webContents.send('deskpet:approval', payload);
            return true;
        } finally {
            if (!entry.agentId && pendingApprovals.get(requestId) === entry) pendingApprovals.delete(requestId);
        }
    }

    function settleApproval(requestId) {
        const entry = pendingApprovals.get(String(requestId));
        if (!entry) return false;
        pendingApprovals.delete(String(requestId));
        const pet = pets.get(entry.agentId);
        if (pet && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:approval-clear', String(requestId));
        return true;
    }

    // 页面重载（换装、崩溃恢复）后把还在等的审批再给它
    function resendApprovals(pet) {
        const now = Date.now();
        for (const [requestId, entry] of pendingApprovals) {
            if (entry.payload.expiresAt && entry.payload.expiresAt <= now) pendingApprovals.delete(requestId);
            else if (entry.agentId === pet.agentId) pet.win.webContents.send('deskpet:approval', entry.payload);
        }
    }

    // 桌宠关掉了：等着它答的审批不再留着
    function forgetPetApprovals(agentId) {
        for (const [requestId, entry] of pendingApprovals) if (entry.agentId === agentId) pendingApprovals.delete(requestId);
    }

    // 桌宠上点了允许/拒绝：没过期就交回主窗口（它才是真正应答的那边）
    function answerApproval(pet, answer) {
        const requestId = String(answer?.requestId || '');
        const entry = pendingApprovals.get(requestId);
        if (!pet || entry?.agentId !== pet.agentId) return;
        if (entry.payload.expiresAt !== null && entry.payload.expiresAt <= Date.now()) {
            settleApproval(requestId);
            return;
        }
        if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
        ctx.mainWindow.webContents.send('deskpet:approval-answer', { requestId, approved: answer?.approved === true });
    }

    function parsePluginOutput(result) {
        if (result && typeof result === 'object') return result;
        const text = String(result || '');
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end <= start) return null;
        try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    }

    // 角色写在第一句话里的情绪标签（<!--emo:…-->）和心流锁这类 [[…::…]] 控制标记不念出来
    function spokenText(value) {
        return String(value || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\[\[[A-Za-z]+::[^\]\n]*\]\]/g, '').trim();
    }

    function scheduleAlarm({ dueAt, text, maid }) {
        const delay = dueAt - Date.now();
        if (!Number.isFinite(delay) || delay < 0 || delay > ALARM_MAX_DELAY_MS || alarms.size >= MAX_ALARMS) return null;
        for (const alarm of alarms.values()) {
            if (alarm.text === text && alarm.maid === maid && Math.abs(alarm.dueAt - dueAt) < ALARM_SAME_MS) return null;
        }
        const id = crypto.randomUUID();
        const timer = setTimeout(async () => {
            alarms.delete(id);
            const agentId = await alarmTarget(maid);
            if (agentId) proactive(agentId, { kind: 'alarm', text: text || '时间到了！', at: dueAt });
        }, delay);
        timer.unref?.();
        alarms.set(id, { timer, dueAt, text, maid });
        return id;
    }

    /** 分布式服务器每执行完一个工具调用就告诉这里一声（只看结果，不改结果）。 */
    function onDistributedToolResult(toolName, toolArgs = {}, result) {
        if (!ctx.initialized) return;
        if (toolName === 'TopicSponsor' && ['CreateTopic', 'CreateFlowlockTopic'].includes(toolArgs?.command)) {
            const info = parsePluginOutput(result);
            if (!info?.agent_id || !info.topic_id || announcedTopics.has(info.topic_id)) return;
            announcedTopics.add(info.topic_id);
            if (announcedTopics.size > 200) announcedTopics.delete(announcedTopics.values().next().value);
            proactive(info.agent_id, {
                kind: 'topic',
                title: String(info.topic_name || ''),
                text: spokenText(info.initial_message),
                topicId: String(info.topic_id),
            });
        } else if (toolName === 'VCPAlarm') {
            const info = parsePluginOutput(result);
            if (info?.status !== 'success' || !Number.isFinite(info.due_at)) return;
            scheduleAlarm({ dueAt: info.due_at, text: spokenText(info.reminder_text || toolArgs?.reminder_text), maid: toolArgs?.maid });
        }
    }

    return {
        pendingApprovals,
        proactive,
        agentIdByName,
        alarmTarget,
        offerApproval,
        settleApproval,
        resendApprovals,
        forgetPetApprovals,
        answerApproval,
        scheduleAlarm,
        onDistributedToolResult,
        /** 退出：说过的话题、待批的卡片、还没响的闹钟都清掉。 */
        clear() {
            announcedTopics.clear();
            pendingApprovals.clear();
            for (const { timer } of alarms.values()) clearTimeout(timer);
            alarms.clear();
        },
    };
}

module.exports = { createPetProactive };
