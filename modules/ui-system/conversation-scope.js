/**
 * modules/ui-system/conversation-scope.js
 * 右上角状态面板里「属于当前会话」的那部分：从这个话题的聊天记录里读出它碰过的 V工程 和它发起的命令。
 *
 * ZCode 的状态面板跟着 session 走：计划、命令都是这个 session 自己的。VCPChat 的 V工程 / 终端是全局的
 * （同一工作区的所有话题共用），所以面板必须拿聊天记录来圈定范围，否则切换助手或话题时看到的还是同一份内容。
 * 只读聊天记录里的工具调用（观察式），不改变工具本身的行为。
 */

'use strict';

import { findProjectRoots, parseToolFields } from './message-file-changes.js';

const TOOL_REQUEST = /<<<\[TOOL_REQUEST\]>>>([\s\S]*?)<<<\[END_TOOL_REQUEST\]>>>/g;

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
 * 聊天记录 → { projectIds, commands }。
 * projectIds：这个会话用过的 V工程 id，最近提到的在前（请求里的 projectId，以及 CreateProject / GetProject 结果里的 id）。
 * commands：这个会话里 PowerShellExecutor 请求过的命令（command、command1、command2…），保留内部空白。
 */
export function collectConversationScope(history) {
    const projects = new Map();
    const commands = new Set();
    const mention = (id) => { projects.delete(id); projects.set(id, true); };

    for (const message of Array.isArray(history) ? history : []) {
        const text = textOf(message);
        if (!text) continue;
        TOOL_REQUEST.lastIndex = 0;
        for (const block of text.matchAll(TOOL_REQUEST)) {
            const fields = parseToolFields(block[1]);
            const tool = fieldOf(fields, 'tool_name').replace(/["'「」]/gu, '').trim().toLowerCase();
            if (tool === 'projectforge') {
                const id = fieldOf(fields, 'projectId', 'project', 'id');
                if (id) mention(id);
            } else if (tool === 'powershellexecutor') {
                for (const [key, value] of Object.entries(fields)) {
                    if (/^command\d*$/i.test(key) && value) commands.add(normalizeCommand(value));
                }
            }
        }
        for (const id of findProjectRoots([text]).keys()) mention(id);
    }
    return { projectIds: [...projects.keys()].reverse(), commands };
}

/** 作用域的指纹：没变化就不用重算面板。 */
export function scopeSignature(scope) {
    return JSON.stringify([scope.projectIds, [...scope.commands].sort()]);
}
