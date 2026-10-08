/**
 * modules/ui-system/message-file-changes.js
 * 助手回答里通过 FileOperator 工具改动了文件时，在回答下面补一条可折叠的「本轮改动 N 个文件」，
 * 列出路径和操作（写入 / 修改 / 追加 / 删除 / 移动 / 重命名 / 复制），点路径用侧栏代码查看器打开。
 *
 * 版面对照 ZCode 的 ConversationFileSummaryPanel
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/ConversationFileSummaryPanel.tsx）：
 * 轮次末尾一个折叠的文件摘要，展开后逐个文件，点文件看内容。
 * 原实现的数据来自 agent 自己的文件改动记录（带增删行数、可回退）；VCPChat 的文件改动发生在服务端的 FileOperator 插件里，
 * 前端只能从回答原文中的 TOOL_REQUEST 块和紧随其后的「VCP调用结果」里还原出「改了哪些文件」，
 * 所以回答原文本身没有增删行数，也不提供回退。执行状态不是成功的调用不计入。
 * 增删行数在展开时才去查（getDiffStats，见 git-file-diff.js）：文件在已登记的 Git 工作区里时显示它当前未提交的 +N -N，
 * 点数字在右侧栏 Git 标签里展开这个文件的 diff（openDiff）；查不到就不显示，不影响原有列表。
 * ProjectForge（工程化编辑工具：CreateFile / EditCode / RemoveFile / MoveFile / MoveCode / CopyCode / Rollback）同样识别：
 * 它的路径相对工程根（根目录从建工程的结果里还原），结果里带每次调用的精确 Diff (+N -M)，直接显示，不必再问 Git。
 * 只观察消息 DOM，不改渲染管线；原文从历史记录里按消息 id 取。
 */

'use strict';

import { replaceToolRequestBlocks } from '../renderer/toolRequestScanner.js';
import { collectToolResultRanges } from '../renderer/toolResultRegions.js';

const FIELD_START = /([A-Za-z_][\w]*)[ \t]*[:：][ \t]*(「始(ESCAPE)?」|\{始(ESCAPE)?\})/gi;

/** command → 操作类型；其余 FileOperator 命令（读取、列目录、搜索…）不改文件，忽略。 */
const OPERATIONS = {
    writefile: 'write',
    editfile: 'edit',
    applydiff: 'edit',
    appendfile: 'append',
    deletefile: 'delete',
    movefile: 'move',
    renamefile: 'rename',
    copyfile: 'copy'
};

export const OPERATION_LABELS = {
    create: '新建',
    write: '写入',
    edit: '修改',
    append: '追加',
    delete: '删除',
    move: '移动',
    rename: '重命名',
    copy: '复制'
};

// ------------------------------------------------------------------ pure helpers

/** 解析 `key:「始」value「末」` 字段表；ESCAPE 字段按 `「末ESCAPE」` 收尾，里面的伪标记不会截断。 */
export function parseToolFields(body) {
    const fields = {};
    const text = String(body ?? '');
    const lowered = text.toLowerCase();
    FIELD_START.lastIndex = 0;
    let match;
    while ((match = FIELD_START.exec(text))) {
        const escape = Boolean(match[3] || match[4]);
        const valueStart = match.index + match[0].length;
        const endTokens = escape ? ['「末ESCAPE」', '{末ESCAPE}'] : ['「末」', '{末}'];
        let valueEnd = -1;
        let tokenLength = 0;
        for (const token of endTokens) {
            const at = lowered.indexOf(token.toLowerCase(), valueStart);
            if (at !== -1 && (valueEnd === -1 || at < valueEnd)) { valueEnd = at; tokenLength = token.length; }
        }
        if (valueEnd === -1) { fields[match[1]] = text.slice(valueStart).trim(); break; }
        fields[match[1]] = text.slice(valueStart, valueEnd).trim();
        FIELD_START.lastIndex = valueEnd + tokenLength;
    }
    return fields;
}

function lookup(fields, ...names) {
    const wanted = names.map(name => name.toLowerCase());
    for (const [key, value] of Object.entries(fields)) {
        if (wanted.includes(key.toLowerCase()) && typeof value === 'string' && value) return value;
    }
    return '';
}

const toolNameOf = (fields) => lookup(fields, 'tool_name').replace(/["'「」]/gu, '').trim().toLowerCase();

/** FileOperator 请求块 → 它做的文件操作列表（单条命令，或 command1/command2… 的批量写法）。 */
function fileOperatorOperations(fields) {
    const entries = [];
    const single = lookup(fields, 'command');
    if (single) {
        entries.push({ command: single, pick: (...names) => lookup(fields, ...names) });
    } else {
        for (let index = 1; lookup(fields, `command${index}`); index += 1) {
            entries.push({ command: lookup(fields, `command${index}`), pick: (...names) => lookup(fields, ...names.map(name => `${name}${index}`)) });
        }
    }
    const operations = [];
    for (const { command, pick } of entries) {
        const op = OPERATIONS[command.trim().toLowerCase()];
        if (!op) continue;
        if (op === 'move' || op === 'rename' || op === 'copy') {
            const from = pick('source', 'sourcePath');
            const to = pick('destination', 'destinationPath');
            if (from) operations.push({ op, path: from, to });
        } else {
            const path = pick('path', 'filePath');
            if (path) operations.push({ op, path });
        }
    }
    return operations;
}

// ---- ProjectForge：工程化编辑工具，请求带 projectId + 相对工程根的 path；结果里有精确的 Diff (+N -M)

const FORGE_WRITE_HEADER = /^## ✅ (已新建|已覆盖|已写入) · `([^`\n]+)`/u;
const FORGE_MOVE_HEADER = /^## ✅ 已移动 · `([^`\n]+)` → `([^`\n]+)`/u;
const FORGE_CODE_MOVE_HEADER = /^## ✅ 已(?:剪切|复制) · /u;
const FORGE_REMOVE_HEADER = /^## ✅ RemoveFile/u;
const FORGE_ROLLBACK_HEADER = /^## ✅ 已回退/u;
// 回退结果逐个文件列出「- `路径`：动作（节点 `nX`）」；没有 Diff，只知道动作
const FORGE_ROLLBACK_ITEM = /^- `([^`\n]+)`：(恢复内容|重建文件|移到回收站)（节点/gmu;
const FORGE_ROLLBACK_OP = { 恢复内容: 'edit', 重建文件: 'create', 移到回收站: 'delete' };
const FORGE_DIFF_COUNTS = /### Diff \(\+(\d+) -(\d+)\)/u;

const diffCounts = (text) => {
    const match = FORGE_DIFF_COUNTS.exec(text);
    return match ? { added: Number(match[1]), removed: Number(match[2]) } : {};
};

function forgeOperationsOfRequest(fields) {
    const command = lookup(fields, 'command').trim().toLowerCase();
    const projectId = lookup(fields, 'projectId', 'project', 'id');
    const make = (operation) => (projectId ? { ...operation, projectId } : operation);
    const path = lookup(fields, 'path', 'file', 'filePath');
    if (command === 'createfile' && path) return [make({ op: 'write', path })];
    if (command === 'editcode' && path) return [make({ op: 'edit', path })];
    if (command === 'removefile') {
        const paths = [path, ...lookup(fields, 'paths', 'files').split(/[\n,]/u)].map(item => item.trim()).filter(Boolean);
        return paths.map(item => make({ op: 'delete', path: item }));
    }
    if (command === 'movefile') {
        const from = lookup(fields, 'from', 'source', 'path');
        const to = lookup(fields, 'to', 'destination', 'target');
        return from ? [make({ op: 'move', path: from, to })] : [];
    }
    return [];
}

/**
 * ProjectForge 结果 → 这次调用实际改了什么。工具层的「未写入 / 内容无变化 / 有歧义待确认」也会返回
 * 「执行状态: SUCCESS」，真正的成败只看结果正文的标题行（## ✅ …），所以这里不认 ✅ 以外的标题。
 * 路径和增删行数都取自结果：新建的文件没有 Diff，用结果里的「N 行」当 +N。
 */
function forgeOperationsOfResult(body, projectId) {
    const text = String(body ?? '').trim();
    const make = (operation) => (projectId ? { ...operation, projectId } : operation);
    let match = FORGE_WRITE_HEADER.exec(text);
    if (match) {
        const op = match[1] === '已新建' ? 'create' : match[1] === '已覆盖' ? 'write' : 'edit';
        const created = op === 'create' ? /（(\d+) 行/u.exec(text) : null;
        return [make({ op, path: match[2], ...(created ? { added: Number(created[1]), removed: 0 } : diffCounts(text)) })];
    }
    match = FORGE_MOVE_HEADER.exec(text);
    if (match) return [make({ op: 'move', path: match[1], to: match[2] })];
    if (FORGE_REMOVE_HEADER.test(text)) {
        const line = /已移到系统回收站：([^\n]+)/u.exec(text)?.[1] || '';
        return [...line.matchAll(/`([^`\n]+)`（节点/gu)].map(item => make({ op: 'delete', path: item[1] }));
    }
    if (FORGE_ROLLBACK_HEADER.test(text)) {
        return [...text.matchAll(FORGE_ROLLBACK_ITEM)].map(item => make({ op: FORGE_ROLLBACK_OP[item[2]], path: item[1] }));
    }
    if (FORGE_CODE_MOVE_HEADER.test(text)) {
        const parts = text.split(/^### `([^`\n]+)`[ \t]*$/mu);
        const operations = [];
        for (let index = 1; index < parts.length; index += 2) {
            operations.push(make({ op: 'edit', path: parts[index], ...diffCounts(parts[index + 1]) }));
        }
        return operations;
    }
    return [];
}

/**
 * 回答原文里这些工具的调用结果（按出现顺序）：{ tool, ok, body }。
 * ok 看「执行状态」：带 ❌ 或不是 SUCCESS 的都算失败（真实记录里是「✅ SUCCESS」/「❌ ERROR」）。
 */
function toolResultsOf(text, tools) {
    const results = [];
    for (const range of collectToolResultRanges(text)) {
        const block = text.slice(range.start, range.end);
        const tool = /工具名称:\s*([^\n]+)/u.exec(block)?.[1]?.trim().toLowerCase();
        if (!tools.includes(tool)) continue;
        const status = /执行状态:\s*([^\n]+)/u.exec(block)?.[1]?.trim();
        const ok = typeof status === 'string' && !status.includes('❌') && /^(?:✅\s*)?(?:SUCCESS|SUCCEEDED|OK|成功)\s*$/iu.test(status);
        const body = /返回内容:\s*([\s\S]*)$/u.exec(block)?.[1] ?? '';
        const failed = typeof status === 'string' && /^(?:❌\s*)?(?:ERROR|FAILED|FAILURE|FAIL|失败)(?:\s|:|：|$)/iu.test(status);
        results.push({ start:range.start, end:range.end, tool, ok, state: ok ? 'succeeded' : failed ? 'failed' : 'unknown', body });
    }
    return results;
}

const PROJECT_ROOT_PATTERNS = [
    // CreateProject：「- projectId：`id`…」后面几行内的「- 根目录：…」
    /projectId：`([^`\n]+)`[^\n]*\n(?:- [^\n]*\n)*?- 根目录：([^\n]+)/gu,
    // GetProject：「- 工程：名字（`id`）· 状态 …」下一行「- 根目录：…」
    /- 工程：[^\n]*（`([^`\n]+)`）[^\n]*\n- 根目录：([^\n]+)/gu
];

/** 从 ProjectForge 的结果文本里还原 projectId → 工程根目录；后出现的覆盖先出现的。 */
/** 一段文本里的工程根目录，按出现位置排序：[{ id, root, index }]。 */
export function projectRootMentions(text) {
    if (typeof text !== 'string' || !text.includes('根目录：')) return [];
    const mentions = [];
    for (const pattern of PROJECT_ROOT_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            const root = match[2].replace(/（[^）]*）.*$/u, '').trim();
            if (root) mentions.push({ id: match[1], root, index: match.index });
        }
    }
    return mentions.sort((a, b) => a.index - b.index);
}

export function findProjectRoots(texts) {
    const roots = new Map();
    for (const text of texts) {
        for (const { id, root } of projectRootMentions(text)) roots.set(id, root);
    }
    return roots;
}

/**
 * 回答原文 → 改动文件列表 [{path, op, to?, projectId?, added?, removed?}]。
 * 请求与结果仅在一问一答的区间内配对；并行调用无关联 ID 时归属不明，不把未知写成改动。
 * FileOperator 的路径取自请求；ProjectForge 的路径和增删行数取自结果（路径相对工程根，带 projectId）。
 * 同一个路径只出现一次，操作取最终效果：删除 / 移动 / 重命名 / 复制 以最后一次为准，否则 新建 > 写入 > 修改 > 追加。
 * ProjectForge 每次调用的增删行数累加；这个文件是本轮新建的，就按新建后的行数算（+净增，不含 -）。
 */
/** Call outcomes keep attempted paths separate from confirmed filesystem changes. */
export function classifyToolFileOperations(text) {
    const source = typeof text === 'string' ? text : '';
    const requests = { fileoperator: [], projectforge: [] };
    replaceToolRequestBlocks(source, (match, content, start, end) => {
        const fields = parseToolFields(content), tool = toolNameOf(fields);
        if (tool === 'fileoperator') requests.fileoperator.push({start,end,fields, candidates:fileOperatorOperations(fields)});
        else if (tool === 'projectforge') requests.projectforge.push({start,end,fields, candidates:forgeOperationsOfRequest(fields)});
        return match;
    });
    const results = toolResultsOf(source,['fileoperator','projectforge']);
    return Object.entries(requests).flatMap(([tool,calls]) => {
        const outcomes = results.filter(result => result.tool === tool);
        const paired = outcomes.length === calls.length;
        return calls.map((call,index) => {
            // Equal counts cannot prove attribution for interleaved/concurrent same-tool calls.
            const candidate = paired ? outcomes[index] : null;
            const bounded = candidate && call.end <= candidate.start
                && (!calls[index+1] || candidate.end <= calls[index+1].start)
                && (!outcomes[index-1] || outcomes[index-1].end <= call.start);
            const result = bounded ? candidate : null;
            const state = result?.state || (outcomes.length === 0 ? 'pending' : 'unknown');
            const operations = state !== 'succeeded' ? [] : tool === 'fileoperator' ? call.candidates : forgeOperationsOfResult(result.body,lookup(call.fields,'projectId','project','id'));
            return {tool,state,operations,candidates:call.candidates};
        });
    });
}

export function extractFileChanges(text) {
    const calls = classifyToolFileOperations(text).filter(call => call.state === 'succeeded').map(call => call.operations);
    const perPath = new Map();
    for (const operations of calls) {
        for (const operation of operations) {
            const key = `${operation.projectId || ''}|${operation.path}`;
            if (!perPath.has(key)) perPath.set(key, []);
            perPath.get(key).push(operation);
        }
    }

    const rank = { create: 4, write: 3, edit: 2, append: 1 };
    const changes = [];
    for (const operations of perPath.values()) {
        const { path, projectId } = operations[0];
        const identity = { path, ...(projectId ? { projectId } : {}) };
        const last = operations[operations.length - 1];
        if (!rank[last.op]) {
            changes.push({ ...identity, op: last.op, ...(last.to ? { to: last.to } : {}) });
            continue;
        }
        const writes = operations.filter(entry => rank[entry.op]);
        const strongest = [...writes].sort((a, b) => rank[b.op] - rank[a.op])[0];
        const change = { ...identity, op: strongest.op };
        if (writes.every(entry => entry.added !== undefined)) {
            const added = writes.reduce((sum, entry) => sum + entry.added, 0);
            const removed = writes.reduce((sum, entry) => sum + entry.removed, 0);
            Object.assign(change, strongest.op === 'create' ? { added: Math.max(0, added - removed), removed: 0 } : { added, removed });
        }
        changes.push(change);
    }
    return changes;
}

export function summarizeFileChanges(changes) {
    return changes.length === 0 ? '' : `本轮改动 ${changes.length} 个文件`;
}

// ------------------------------------------------------------------ controller

/** 工程根 + 相对路径；分隔符跟着根目录的写法走（Windows 根目录用反斜杠）。 */
function joinPath(root, relative) {
    const separator = root.includes('\\') ? '\\' : '/';
    return `${root.replace(/[\\/]+$/u, '')}${separator}${String(relative).replace(/^[\\/]+/u, '').replace(/[\\/]/gu, separator)}`;
}

function baseName(path) {
    return String(path).replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() || String(path);
}

export function createMessageFileChanges({
    document: doc = document,
    messagesRoot = null,
    getHistory = () => [],
    openFile = null,
    getDiffStats = null,
    openDiff = null,
    relativePath = null
} = {}) {
    const win = doc.defaultView;
    let observer = null;
    let disposed = false;
    // 没有文件改动的消息记下 id 和当时的内容（引用历史里同一个字符串）：class 再变（hover、展开等）不用重新提取；
    // 只记长度的话，编辑后长度没变、却多了文件改动的消息会被跳过
    const noChanges = new Map();

    // 一批 mutation 共用一份历史索引和工程根：长历史加载时不再每条消息线性 find、再扫一遍全历史
    function createBatch() {
        let history = null;
        let byId = null;
        let roots = null;
        const getAll = () => (history ??= getHistory() || []);
        return {
            find: id => (byId ??= new Map(getAll().map(message => [message?.id, message]))).get(id),
            roots: () => (roots ??= findProjectRoots(getAll().map(message => message?.content)))
        };
    }

    function render(item, batch = createBatch()) {
        if (!item.classList?.contains('message-item') || !item.classList.contains('assistant') || item.classList.contains('streaming')) return;
        const wrapper = item.querySelector(':scope > .details-and-bubble-wrapper');
        if (!wrapper || wrapper.querySelector(':scope > .vcp-file-changes')) return;
        const id = item.dataset.messageId;
        if (!id) return;
        const record = batch.find(id);
        const raw = typeof record?.content === 'string' ? record.content : '';
        if (noChanges.get(id) === raw) return;
        const changes = extractFileChanges(raw);
        if (changes.length === 0) { noChanges.set(id, raw); return; }
        noChanges.delete(id);
        // ProjectForge 的路径相对工程根；根目录写在建工程（CreateProject / GetProject）的结果里，可能在更早的消息中
        const roots = changes.some(change => change.projectId) ? batch.roots() : new Map();

        const details = doc.createElement('details');
        details.className = 'vcp-file-changes';
        const summary = doc.createElement('summary');
        summary.textContent = summarizeFileChanges(changes);
        details.appendChild(summary);
        const list = doc.createElement('ul');
        const statSlots = [];
        for (const change of changes) {
            const row = doc.createElement('li');
            const badge = doc.createElement('span');
            badge.className = `vcp-file-changes-op op-${change.op}`;
            badge.textContent = OPERATION_LABELS[change.op];
            const root = change.projectId ? roots.get(change.projectId) : null;
            const absolute = change.projectId ? (root ? joinPath(root, change.path) : null) : change.path;
            const target = change.to ? `${change.path} → ${change.to}` : (absolute || change.path);
            const canOpen = openFile && change.op !== 'delete' && !change.to && absolute;
            const label = doc.createElement(canOpen ? 'button' : 'span');
            label.className = 'vcp-file-changes-path';
            label.textContent = change.to ? `${baseName(change.path)} → ${baseName(change.to)}` : baseName(change.path);
            label.title = target;
            if (canOpen) {
                label.type = 'button';
                label.addEventListener('click', () => openFile(absolute));
            }
            const dir = doc.createElement('span');
            dir.className = 'vcp-file-changes-dir';
            // 目录按工作区相对路径显示；在工作区根下的文件不显示目录
            const shown = (!change.projectId && !change.to && relativePath?.(change.path)) || change.path;
            dir.textContent = shown.slice(0, Math.max(0, shown.length - baseName(shown).length)).replace(/[\\/]+$/u, '');
            dir.title = target;
            const stats = doc.createElement('span');
            stats.className = 'vcp-file-changes-stats';
            row.append(badge, label, dir, stats);
            list.appendChild(row);
            const statsPath = absolute || change.path;
            if (change.added !== undefined && !change.to) {
                // 工具结果里带着这一轮的精确增删行数，不用等 Git
                paintCounts(stats, { added: change.added, removed: change.removed }, statsPath, '这个文件本轮的增删行数（来自 ProjectForge 的执行结果）');
            } else if (getDiffStats && !change.to) {
                statSlots.push({ statsPath, stats });
            }
        }
        details.appendChild(list);
        // 展开才查：历史消息很多，加载时不去逐个问 Git
        let statsRequested = false;
        details.addEventListener('toggle', () => {
            if (!details.open || statsRequested || disposed) return;
            statsRequested = true;
            statSlots.forEach(slot => paintStats(slot.statsPath, slot.stats));
        });
        wrapper.appendChild(details);
    }

    function paintCounts(slot, counts, statsPath, hint) {
        const button = doc.createElement(openDiff ? 'button' : 'span');
        button.className = 'vcp-file-changes-counts';
        if (openDiff) {
            button.type = 'button';
            button.title = `${hint}；点击在右侧栏 Git 标签里查看这个文件的 diff`;
            button.addEventListener('click', () => openDiff(statsPath));
        } else {
            button.title = hint;
        }
        const added = doc.createElement('span');
        added.className = 'text-diff-added';
        added.textContent = `+${counts.added}`;
        const removed = doc.createElement('span');
        removed.className = 'text-diff-removed';
        removed.textContent = `-${counts.removed}`;
        button.append(added, removed);
        slot.textContent = '';
        slot.appendChild(button);
    }

    async function paintStats(statsPath, slot) {
        let result = null;
        try { result = await getDiffStats(statsPath); } catch (_error) { result = null; }
        if (disposed || !slot.isConnected || !result) return;
        if (result.state === 'clean') {
            slot.textContent = '无未提交改动';
            slot.classList.add('is-muted');
            slot.title = '这个文件在 Git 里已经没有未提交的改动（可能已提交）';
            return;
        }
        if (result.state !== 'ready') return;
        paintCounts(slot, result, statsPath, '数字是这个文件当前未提交的全部改动，不只这一轮');
    }

    function onMutations(records) {
        const batch = createBatch();
        for (const record of records) {
            if (record.type === 'attributes') {
                render(record.target, batch);
                continue;
            }
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.classList.contains('message-item')) render(node, batch);
                else node.querySelectorAll?.('.message-item').forEach(item => render(item, batch));
            }
        }
    }

    function mount() {
        messagesRoot = messagesRoot || doc.getElementById('chatMessages');
        if (!messagesRoot || observer || disposed || typeof win?.MutationObserver !== 'function') return null;
        observer = new win.MutationObserver(onMutations);
        observer.observe(messagesRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        const batch = createBatch();
        messagesRoot.querySelectorAll('.message-item').forEach(item => render(item, batch));
        return observer;
    }

    function dispose() {
        disposed = true;
        observer?.disconnect();
        observer = null;
    }

    return { mount, dispose };
}
