/**
 * modules/ui-system/conversation-scope.js
 * 右上角状态面板里「属于当前会话」的那部分：从这个话题的聊天记录里读出它碰过的 V工程 和它发起的命令。
 *
 * 状态面板应该跟着会话走：计划、命令都是这个 session 自己的。VCPChat 的 V工程 / 终端是全局的
 * （同一工作区的所有话题共用），所以面板必须拿聊天记录来圈定范围，否则切换助手或话题时看到的还是同一份内容。
 * 只读聊天记录里的工具调用（观察式），不改变工具本身的行为。
 */

'use strict';

import { projectRootMentions, parseToolFields } from './message-file-changes.js';

const TOOL_REQUEST = /<<<\[TOOL_REQUEST\]>>>([\s\S]*?)<<<\[END_TOOL_REQUEST\]>>>/g;
// ProjectForge 每次施工（含 Rollback）在结果里写「批次 `bN`」；时间线 / 历史列表只写 `bN`，不算这个话题的施工
const BATCH_MENTION = /批次 `b(\d+)`/g;
const REVERT_BATCHES_KEY = 'vcp-projectforge-topic-batches';
const REVERT_TOPICS_MAX = 100;
const REVERT_BATCHES_MAX = 200;

const textOf = (message) => {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n');
    return '';
};

const fieldOf = (fields, ...names) => {
    const wanted = names.map(name => name.toLowerCase());
    for (const [key, value] of Object.entries(fields)) {
        if (wanted.includes(key.toLowerCase()) && typeof value === 'string' && value) return value;
    }
    return '';
};

/** 终端运行记录里的命令和请求里的命令仅去除首尾空白；引号、换行及内部空白都参与匹配。 */
export const normalizeCommand = (command) => String(command ?? '').trim();

/**
 * 聊天记录 → { projectIds, commands, batchIds }。
 * projectIds：这个会话用过的 V工程 id，最近提到的在前（请求里的 projectId，以及 CreateProject / GetProject 结果里的 id）。
 * commands：这个会话里 PowerShellExecutor 请求过的命令（command、command1、command2…），保留内部空白。
 * batchIds：这个会话里 ProjectForge 施工产生的批次号（批次号全局唯一，不分工程）。
 */
export function collectConversationScope(history) {
    const projects = new Map();
    const commands = new Set();
    const batchIds = new Set();
    const mention = (id) => { projects.delete(id); projects.set(id, true); };

    for (const message of Array.isArray(history) ? history : []) {
        const text = textOf(message);
        if (!text) continue;
        // 同一条消息里请求和结果交错出现，按文本位置依次记，最后出现的才算最近
        const seen = projectRootMentions(text).map(({ id, index }) => ({ id, index }));
        TOOL_REQUEST.lastIndex = 0;
        for (const block of text.matchAll(TOOL_REQUEST)) {
            const fields = parseToolFields(block[1]);
            const tool = fieldOf(fields, 'tool_name').replace(/["'「」]/gu, '').trim().toLowerCase();
            if (tool === 'projectforge') {
                const id = fieldOf(fields, 'projectId', 'project', 'id');
                if (id) seen.push({ id, index: block.index });
            } else if (tool === 'powershellexecutor') {
                for (const [key, value] of Object.entries(fields)) {
                    if (/^command\d*$/i.test(key) && value) commands.add(normalizeCommand(value));
                }
            }
        }
        for (const { id } of seen.sort((a, b) => a.index - b.index)) mention(id);
        for (const match of text.matchAll(BATCH_MENTION)) batchIds.add(Number(match[1]));
    }
    return { projectIds: [...projects.keys()].reverse(), commands, batchIds };
}

/**
 * 侧栏里人工回退产生的批次不在聊天记录里，按话题记在本地（话题键同侧栏的 getParentKey）。
 */
export function readRevertBatches(storage, topicKey) {
    if (!topicKey) return [];
    try {
        const all = JSON.parse(storage?.getItem?.(REVERT_BATCHES_KEY) || '{}');
        const ids = Array.isArray(all?.[topicKey]) ? all[topicKey] : [];
        return ids.map(Number).filter(Number.isInteger);
    } catch (_e) { return []; }
}

export function recordRevertBatch(storage, topicKey, batchId) {
    const id = Number(batchId);
    if (!topicKey || !Number.isInteger(id) || !storage?.setItem) return;
    let all = {};
    try { all = JSON.parse(storage.getItem(REVERT_BATCHES_KEY) || '{}') || {}; } catch (_e) { all = {}; }
    const ids = (Array.isArray(all[topicKey]) ? all[topicKey] : []).filter(x => x !== id);
    ids.push(id);
    delete all[topicKey];
    all[topicKey] = ids.slice(-REVERT_BATCHES_MAX);
    // 最近用过的话题排在最后，超出上限时丢最早的
    const keys = Object.keys(all);
    for (const key of keys.slice(0, Math.max(0, keys.length - REVERT_TOPICS_MAX))) delete all[key];
    try { storage.setItem(REVERT_BATCHES_KEY, JSON.stringify(all)); } catch (_e) { /* 存不下就只是少了这次的范围 */ }
}

/** 作用域的指纹：没变化就不用重算面板。 */
export function scopeSignature(scope) {
    return JSON.stringify([scope.projectIds, [...scope.commands].sort(), [...(scope.batchIds || [])].sort((a, b) => a - b)]);
}
