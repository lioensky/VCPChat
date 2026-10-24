// modules/deskpet/idleRunner.js
// 闲时主动搭话的那一套时机和流程（说什么、能不能说的规则在 idleChat.js）：
// 设置里打开后，每分钟看一眼：人在电脑前、这么久没和助手说话、没开免打扰、桌宠露着，就让助手说一句。
// 一次只让一个桌宠说（最近聊过的那个优先）。说的话记进这个助手的「桌宠闲聊」话题，点气泡切过去接着聊。

'use strict';

const fs = require('fs-extra');
const idleChat = require('./idleChat');

const IDLE_TICK_MS = 60 * 1000;

function promptText(config) {
    return String(config?.systemPrompt ?? config?.originalSystemPrompt ?? '');
}

/**
 * deps：
 *   settings()               桌宠设置（idleChat、idleChatMinutes、doNotDisturb）
 *   services                 { readSettings, historyQueue, agentOps }，都是取值函数
 *   candidates()             露着的桌宠，先说的排前面
 *   isShowing(agentId)       这个桌宠现在还露着
 *   systemAway()             { idleSec, locked }
 *   mainWhere()              主窗口现在开着哪个话题（问不到是 null）
 *   promptAppend(id, text)   桌宠要追加到 system prompt 的那段
 *   speak(id, payload)       让桌宠把这句说出来，说了返回 true
 *   isShuttingDown()
 */
function createIdleRunner(deps) {
    const states = new Map(); // agentId -> { lastActivityAt, lastAttemptAt, lastFailedAt, activity }
    let timer = null;
    let running = false;

    function noteActivity(agentId) {
        if (!agentId) return;
        const state = states.get(agentId) || { lastActivityAt: 0, lastAttemptAt: 0, lastFailedAt: 0 };
        state.lastActivityAt = Date.now();
        state.activity = (state.activity || 0) + 1;
        states.set(agentId, state);
    }

    function stateFor(agentId) {
        let state = states.get(agentId);
        if (!state) {
            // 刚打开的桌宠从现在开始算，不会一开就说
            state = { lastActivityAt: Date.now(), lastAttemptAt: 0, lastFailedAt: 0 };
            states.set(agentId, state);
        }
        return state;
    }

    function update() {
        const on = deps.settings().idleChat === true;
        if (on && !timer) {
            timer = setInterval(() => { tick().catch((error) => console.warn('[DeskPet] idle chat failed:', error?.message || error)); }, IDLE_TICK_MS);
            timer.unref?.();
        } else if (!on && timer) {
            stop();
        }
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    // 最近在聊的话题（历史文件最新改过的那个）里的最后几句，给助手接话用
    async function recentHistory(agentId, config) {
        const queue = deps.services.historyQueue?.();
        const topics = Array.isArray(config?.topics) ? config.topics.slice(0, 30) : [];
        if (!queue || !topics.length) return [];
        let best = null;
        for (const topic of topics) {
            if (!topic?.id) continue;
            let file;
            try { file = queue.getHistoryPath(agentId, topic.id); } catch { continue; }
            const stat = await fs.stat(file).catch(() => null);
            if (stat && (!best || stat.mtimeMs > best.mtimeMs)) best = { id: topic.id, mtimeMs: stat.mtimeMs };
        }
        if (!best) return [];
        return queue.read({ itemId: agentId, itemType: 'agent', topicId: best.id }).catch(() => []);
    }

    async function tick({ now = Date.now(), force = false } = {}) {
        if (running || deps.isShuttingDown()) return { spoke: false, reason: 'running' };
        const settings = deps.settings();
        const away = deps.systemAway();
        const agentId = deps.candidates()[0];
        if (!agentId) return { spoke: false, reason: 'no-pet' };
        const state = stateFor(agentId);
        const verdict = force ? { ok: true } : idleChat.shouldSpeak({
            enabled: settings.idleChat === true,
            minutes: settings.idleChatMinutes,
            now,
            ...state,
            systemIdleSec: away.idleSec,
            locked: away.locked,
            doNotDisturb: settings.doNotDisturb === true,
            visible: true,
        });
        if (!verdict.ok) return { spoke: false, reason: verdict.reason };
        running = true;
        state.lastAttemptAt = now;
        try {
            return await speak(agentId, state);
        } finally {
            running = false;
        }
    }

    async function speak(agentId, state) {
        // 生成这段时间里有了来往（用户开始说话了）就不说：按次数比，不按毫秒比
        const activityBefore = state.activity || 0;
        const agentOps = deps.services.agentOps?.();
        const queue = deps.services.historyQueue?.();
        const appSettings = await deps.services.readSettings?.().catch(() => null);
        if (!agentOps || !queue || !appSettings?.vcpServerUrl) return { spoke: false, reason: 'no-service' };
        const fail = (reason) => {
            state.lastFailedAt = Date.now();
            return { spoke: false, reason };
        };
        let config;
        try { config = await agentOps.readAgent(agentId); } catch { return fail('no-agent'); }
        const agentName = config?.name || agentId;
        const history = await recentHistory(agentId, config);
        const messages = idleChat.buildMessages({
            config,
            agentName,
            history,
            promptAppend: deps.promptAppend(agentId, promptText(config)),
            userName: appSettings.userName || '用户',
        });
        let line;
        try {
            line = idleChat.cleanLine(await idleChat.generate({ url: appSettings.vcpServerUrl, key: appSettings.vcpApiKey, model: config?.model, messages }));
        } catch (error) {
            console.warn('[DeskPet] idle chat generate failed:', error?.message || error);
            return fail('generate');
        }
        if (!line) return fail('empty');
        // 等回复这段时间里用户可能开始说话了、开了免打扰、把桌宠藏了：这句就不说了
        if (!deps.isShowing(agentId) || deps.settings().doNotDisturb) return { spoke: false, reason: 'changed' };
        if ((state.activity || 0) !== activityBefore) return { spoke: false, reason: 'changed' };
        const where = await deps.mainWhere();
        const topics = Array.isArray(config?.topics) ? config.topics : [];
        const idleTopic = topics.find((t) => t?.creatorSource === idleChat.IDLE_TOPIC_SOURCE);
        if (!where || (idleTopic && where.itemId === agentId && where.topicId === idleTopic.id)) return { spoke: false, reason: 'topic-open' };
        const tag = line.emotion ? `<!--emo:${line.emotion} ${line.intensity}-->` : '';
        let topicId;
        try {
            topicId = await idleChat.recordLine({
                agent: { id: agentId, name: agentName, avatarColor: config?.avatarCalculatedColor || config?.avatarColor },
                text: `${tag}${line.text}`,
                updateConfig: (id, updater) => agentOps.updateAgent(id, updater),
                historyQueue: queue,
            });
        } catch (error) {
            console.warn('[DeskPet] idle chat record failed:', error?.message || error);
            return fail('record');
        }
        const spoke = deps.speak(agentId, { kind: 'topic', title: idleChat.IDLE_TOPIC_NAME, text: line.text, topicId, emotion: line.emotion, intensity: line.intensity });
        if (spoke) state.lastActivityAt = Date.now();
        return { spoke, topicId, text: line.text };
    }

    return { noteActivity, update, stop, tick, states };
}

module.exports = { createIdleRunner, IDLE_TICK_MS };
