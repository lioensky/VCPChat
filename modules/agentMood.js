'use strict';

/**
 * 每个助手的长期心情：存在 Agents/<id>/mood.json（不进 config.json），主进程是唯一的写入方。
 * - 聊天请求发出时读最后一条用户消息，回复结束后读整条回复，各算一次情绪事件（modules/emotion/moodState.js）；
 * - 心情变了就通过 broadcast(snapshot) 广播（main.js 发 'agent-mood-changed' 给所有窗口），侧栏立绘和桌宠用同一份；
 * - 心情随时间回落，定时检查一次，显示的情绪变了也广播。
 * 记录不影响聊天：任何异常都吞掉，模块没载入完（ESM 异步载入）时什么也不做。
 */
const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');

const MOOD_FILE = 'mood.json';
const NOOP_CALL = Object.freeze({ chunk() {}, finish() {} });

function textOfContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : '')).join('\n');
    return '';
}

// 最后一条不是 system 的消息是用户的：这是对一句用户话的回复（新发或重新生成），而不是续写
function endsWithUser(messages) {
    if (!Array.isArray(messages)) return false;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role !== 'system') return messages[i]?.role === 'user';
    }
    return false;
}

function lastUserText(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'user') return textOfContent(messages[i].content);
    }
    return '';
}

function deltaText(parsed) {
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta ?? parsed?.delta ?? null;
    return typeof delta?.content === 'string' ? delta.content : '';
}

function responseText(response) {
    const content = response?.choices?.[0]?.message?.content;
    return textOfContent(content);
}

function createAgentMoodStore({
    agentDir,
    mood,
    broadcast = () => {},
    now = () => Date.now(),
    writeDelayMs = 1000,
    recheckMs = 10 * 60 * 1000,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = handle => clearTimeout(handle),
}) {
    const states = new Map(); // agentId -> { mood, loading, shown, writeTimer, writing, events, lastReply, seenReplies, lastUserText }
    let recheckTimer = null;
    let disposed = false;
    // 每次广播递增：渲染端用它判断先后（系统时间可能被往回调，updatedAt 不可靠）
    let seq = 0;

    const resolveDir = (agentId) => {
        const id = typeof agentId === 'string' ? agentId : '';
        if (!agentDir || !id || id !== path.basename(id) || id === '.' || id === '..') return null;
        return path.join(agentDir, id);
    };

    function entryOf(agentId) {
        let entry = states.get(agentId);
        if (!entry) {
            entry = {
                mood: null,
                loading: null,
                shown: null,
                writeTimer: null,
                writing: Promise.resolve(),
                events: 0,
                lastReply: null,
                seenReplies: new Set(),
                lastUserText: '',
            };
            states.set(agentId, entry);
        }
        return entry;
    }

    async function load(agentId) {
        const entry = entryOf(agentId);
        if (entry.mood) return entry;
        if (!entry.loading) {
            entry.loading = (async () => {
                let stored = null;
                try {
                    stored = await fs.readJson(path.join(resolveDir(agentId), MOOD_FILE));
                } catch (_error) { /* 没有文件或读不懂：从平静开始 */ }
                if (!entry.mood) entry.mood = mood.normalizeMood(stored, now());
                entry.shown = mood.moodSnapshot(entry.mood, now()).emotion;
                return entry;
            })().finally(() => { entry.loading = null; });
        }
        return entry.loading;
    }

    function scheduleWrite(agentId, entry) {
        if (entry.writeTimer) return;
        entry.writeTimer = setTimer(() => {
            entry.writeTimer = null;
            write(agentId, entry);
        }, writeDelayMs);
    }

    // 同一个助手的写入排队进行：上一次还没换上去时下一次不会去动同一个临时文件
    function write(agentId, entry) {
        entry.writing = entry.writing.then(() => writeNow(agentId, entry)).catch(() => {});
        return entry.writing;
    }

    async function writeNow(agentId, entry) {
        const dir = resolveDir(agentId);
        // 助手删掉了就不再写，免得把目录又建出来
        if (!dir || !entry.mood || entry.forgotten || !(await fs.pathExists(dir))) return;
        const file = path.join(dir, MOOD_FILE);
        // 临时文件名固定：中途崩溃留下的那一个下次会被覆盖，不会越积越多
        const temp = `${file}.tmp`;
        await fs.writeFile(temp, JSON.stringify(entry.mood, null, 2));
        // 直接改名覆盖：中途不会出现 mood.json 不存在的时刻（Windows 上被占用时 graceful-fs 会重试）
        await fs.rename(temp, file);
    }

    function publish(agentId, entry) {
        seq += 1;
        const snapshot = { agentId, seq, ...mood.moodSnapshot(entry.mood, now()) };
        entry.shown = snapshot.emotion;
        try {
            broadcast(snapshot);
        } catch (_error) { /* 窗口关了之类，不影响 */ }
        ensureRecheck();
        return snapshot;
    }

    async function record(agentId, event) {
        if (disposed || !event || !resolveDir(agentId)) return null;
        const entry = await load(agentId);
        if (entry.forgotten) return null;
        entry.mood = mood.applyMoodEvent(entry.mood, { at: now(), ...event });
        entry.events += 1;
        scheduleWrite(agentId, entry);
        return publish(agentId, entry);
    }

    /**
     * 一条回复结束。重新生成时，被换掉的那条回复留下的影响先撤回（中间没有别的事件时），
     * 否则同一句话重新生成几次，心情就被同一个方向推几次
     */
    async function recordReply(agentId, event, { userText, regenerate }) {
        if (disposed || !resolveDir(agentId)) return null;
        const entry = await load(agentId);
        if (entry.forgotten) return null;
        const previous = entry.lastReply;
        let changed = false;
        if (regenerate && previous && previous.userText === userText && previous.events === entry.events && previous.before !== entry.mood) {
            entry.mood = previous.before;
            changed = true;
        }
        const before = entry.mood;
        if (event) {
            entry.mood = mood.applyMoodEvent(entry.mood, { at: now(), ...event });
            entry.events += 1;
            changed = true;
        }
        entry.lastReply = userText ? { userText, before, events: entry.events } : null;
        if (!changed) return null;
        scheduleWrite(agentId, entry);
        return publish(agentId, entry);
    }

    // 心情会随时间回落：隔一阵看一眼，显示的情绪变了就再广播一次；全都回到平静后就停
    function ensureRecheck() {
        if (recheckTimer || disposed || !(recheckMs > 0)) return;
        recheckTimer = setTimer(() => {
            recheckTimer = null;
            let active = false;
            for (const [agentId, entry] of states) {
                if (!entry.mood) continue;
                const snapshot = mood.moodSnapshot(entry.mood, now());
                if (snapshot.emotion !== entry.shown) publish(agentId, entry);
                if (snapshot.emotion !== 'neutral') active = true;
            }
            if (active) ensureRecheck();
        }, recheckMs);
        recheckTimer?.unref?.();
    }

    return Object.freeze({
        async get(agentId) {
            if (!resolveDir(agentId)) return null;
            const entry = await load(agentId);
            return { agentId, seq, ...mood.moodSnapshot(entry.mood, now()) };
        },
        /** 一次聊天请求：begin 时看用户这句话，chunk 攒回复正文，finish 时看整条回复 */
        observe({ context, messages, messageId } = {}) {
            const agentId = context?.agentId ? String(context.agentId) : '';
            if (disposed || !agentId || context?.isGroupMessage || !resolveDir(agentId)) return NOOP_CALL;
            const entry = entryOf(agentId);
            const userText = lastUserText(messages).trim();
            // 重新生成会把同一句话再发一次，不重复算；续写（最后一条是助手的）也会带上同一句话
            const regenerate = Boolean(userText) && userText === entry.lastUserText && endsWithUser(messages);
            if (userText && userText !== entry.lastUserText) {
                entry.lastUserText = userText;
                const event = mood.userMessageMoodEvent(userText, now());
                if (event) record(agentId, event).catch(() => {});
            }
            let text = '';
            let done = false;
            return {
                chunk(parsed) {
                    if (done) return;
                    try {
                        text = (text + deltaText(parsed)).slice(-8000);
                    } catch (_error) { /* 记录失败不影响聊天 */ }
                },
                finish({ response = null, error = null, aborted = false } = {}) {
                    if (done) return;
                    done = true;
                    try {
                        // 回复期间助手被删了：不再记
                        if (error || aborted || entry.forgotten) return;
                        const id = messageId ? String(messageId) : '';
                        if (id) {
                            if (entry.seenReplies.has(id)) return;
                            entry.seenReplies.add(id);
                            if (entry.seenReplies.size > 32) entry.seenReplies.delete(entry.seenReplies.values().next().value);
                        }
                        const full = response ? responseText(response) : text;
                        const event = mood.replyMoodEvent(full, now());
                        recordReply(agentId, event, { userText: endsWithUser(messages) ? userText : '', regenerate }).catch(() => {});
                    } catch (_error) { /* 记录失败不影响聊天 */ }
                },
            };
        },
        record,
        /** 退出前把还没写的心情写掉，正在写的也等它写完 */
        async flush() {
            const pending = [];
            for (const [agentId, entry] of states) {
                if (entry.writeTimer) {
                    clearTimer(entry.writeTimer);
                    entry.writeTimer = null;
                    write(agentId, entry);
                }
                pending.push(entry.writing);
            }
            await Promise.all(pending);
        },
        /** 助手要删了：不再写它的心情，等正在写的写完，再从内存里丢掉（删除目录之前调用） */
        async forget(agentId) {
            const entry = states.get(agentId);
            if (!entry) return;
            entry.forgotten = true;
            if (entry.writeTimer) clearTimer(entry.writeTimer);
            entry.writeTimer = null;
            states.delete(agentId);
            await entry.writing;
        },
        dispose() {
            disposed = true;
            if (recheckTimer) clearTimer(recheckTimer);
            recheckTimer = null;
            for (const entry of states.values()) {
                if (entry.writeTimer) clearTimer(entry.writeTimer);
                entry.writeTimer = null;
            }
        },
    });
}

let sharedStore = null;
let pendingConfig = null;

/** 主进程启动时配置一次；情绪模块是 ESM，异步载入完成前 observeAgentMood() 是空操作 */
function configureAgentMood({ agentDir, broadcast, projectRoot = path.join(__dirname, '..') } = {}) {
    pendingConfig = { agentDir, broadcast };
    const url = pathToFileURL(path.join(projectRoot, 'modules', 'emotion', 'moodState.js')).href;
    return import(url).then((mood) => {
        if (pendingConfig?.agentDir !== agentDir) return sharedStore;
        sharedStore?.dispose();
        sharedStore = createAgentMoodStore({ agentDir, mood, broadcast });
        return sharedStore;
    }).catch((error) => {
        console.warn('[AgentMood] mood module unavailable:', error.message);
        return null;
    });
}

function getAgentMoodStore() {
    return sharedStore;
}

function observeAgentMood(args) {
    try {
        return sharedStore ? sharedStore.observe(args) : NOOP_CALL;
    } catch (_error) {
        return NOOP_CALL;
    }
}

/** 把轨迹记录和心情观察合成一个调用句柄：chatHandlers 里原来调用 trajectoryCall 的地方都不用改 */
function teeCall(...calls) {
    return {
        id: calls[0]?.id ?? null,
        chunk(parsed) { calls.forEach(call => call?.chunk(parsed)); },
        finish(result) { calls.forEach(call => call?.finish(result)); },
    };
}

module.exports = {
    MOOD_FILE,
    createAgentMoodStore,
    configureAgentMood,
    getAgentMoodStore,
    observeAgentMood,
    teeCall,
};
