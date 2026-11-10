import { replaceToolRequestBlocks, readToolRequestField, findEarliestUnclosedToolBlock } from '../renderer/toolRequestScanner.js';
import { collectToolResultRanges, collectCodeDomainsOutsideToolResults, findToolResultEnd, isToolResultHidden } from '../renderer/toolResultRegions.js';
import { collectToolBatchRanges } from '../renderer/toolBatchRegions.js';

const RESULT_START = '[[VCP调用结果信息汇总:';
const RESULT_END = 'VCP调用结果结束]]';
const FOLD_MARKER = '【Forge T1 · 历史结果预览】';
const SHRINKABLE = new Set(['ReadCode', 'Outline', 'FindSymbol', 'References', 'Trace', 'GetNodeDiff', 'EditCode', 'CreateFile', 'MoveCode', 'CopyCode']);
const KNOWN = new Set([...SHRINKABLE, 'RemoveFile', 'MoveFile', 'Rollback', 'UpdateTodos', 'GetProject', 'SearchHistory', 'EvalSymbol', 'SubmitReport']);
const PROTECTED = /审批|审核留言|approval|异步任务|asynchronous|timely_contact|DESKTOP_PUSH|data:(?:image|audio|video)|image_url/i;
const inRange = (index, range) => index >= range.start && index < range.end;
const unique = values => [...new Set(values)];

/** Non-cryptographic change detector, NOT authentication, permission or proof of testing. */
export function forgeSourceFingerprint(text) {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
    return `fnv1a32-utf16:${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function textPart(message) {
    if (typeof message.content === 'string') return { text: message.content, partIndex: -1 };
    if (Array.isArray(message.content) && message.content.length === 1 && message.content[0]?.type === 'text'
        && typeof message.content[0].text === 'string') return { text: message.content[0].text, partIndex: 0 };
    return null; // Media and cross-part protocol ownership are deliberately not inferred.
}
function seqs(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const parts = value.replace(/^\s*\[|\]\s*$/g, '').split(/[\s,，、]+/).filter(Boolean);
    return parts.every(part => /^#?[1-9]\d*$/.test(part)) ? unique(parts.map(part => part.replace(/^#/, ''))) : [];
}
function safeGap(text) {
    return text.replace(/<<<\[(?:END_)?ROLE_DIVIDE_(?:USER|ASSISTANT)\]>>>/g, '').trim() === '';
}

/** Structural recognition of historical text, not authentication of tool execution. */
function scanMessage(text) {
    if (text.includes(FOLD_MARKER) || PROTECTED.test(text) || findEarliestUnclosedToolBlock(text)) return null;
    const requests = [];
    let recovered = false;
    replaceToolRequestBlocks(text, (raw, body, start, end, scan) => {
        recovered ||= scan.field?.recoveredFromUnclosedField === true;
        const field = name => readToolRequestField(body, name);
        requests.push({ start, end, raw, field, name: field('tool_name'), command: field('command'), projectId: field('projectId') });
        return raw;
    });
    if (recovered) return null;
    const batches = collectToolBatchRanges(text);
    const results = collectToolResultRanges(text);
    const code = collectCodeDomainsOutsideToolResults(text, results);
    const opaque = [...requests, ...code];
    const envelopes = [];
    for (const batch of batches) {
        if (opaque.some(domain => inRange(batch.start, domain))) continue;
        if (!batch.closed) return null;
        const inner = results.filter(range => range.start >= batch.contentStart && range.end <= batch.contentEnd);
        // No call_id in this protocol: a concurrent batch cannot be zipped to requests by name.
        if (inner.length !== 1 || !inner[0].closed
            || text.slice(batch.contentStart, inner[0].start).trim()
            || !/^(?:\s*|\s*\[本轮工具调用摘要:\]\r?\n[^\r\n]*\r?\n\[本轮工具调用摘要结束\]\s*)$/.test(text.slice(inner[0].end, batch.contentEnd))) return null;
        envelopes.push({ ...batch, result: inner[0] });
    }
    for (const result of results) {
        if (batches.some(batch => inRange(result.start, batch)) || opaque.some(domain => inRange(result.start, domain))) continue;
        if (!result.closed) return null;
        envelopes.push({ ...result, result, batchId: null });
    }
    const events = [...requests.map(request => ({ ...request, kind: 'call' })), ...envelopes.map(envelope => ({ ...envelope, kind: 'result' }))]
        .sort((left, right) => left.start - right.start);
    const rows = [];
    let call = null;
    for (const event of events) {
        if (event.kind === 'call') {
            if (call) return null;
            call = event;
            continue;
        }
        if (!call || !safeGap(text.slice(call.end, event.start))) return null;
        const range = event.result;
        const raw = text.slice(range.start, range.end);
        // Reject renderer recovery and nested protocol data rather than shortening an ambiguous result.
        if (findToolResultEnd(text, range.start) !== range.end || isToolResultHidden(raw)
            || raw.indexOf(RESULT_START, RESULT_START.length) !== -1
            || raw.indexOf(RESULT_END) !== raw.length - RESULT_END.length) return null;
        const parsed = /^\[\[VCP调用结果信息汇总:\r?\n- 工具名称: ([^\r\n]+)\r?\n- 执行状态: ([^\r\n]+)\r?\n- 返回内容: ([\s\S]*)\r?\nVCP调用结果结束\]\]$/.exec(raw);
        if (!parsed || call.name !== parsed[1].trim()) return null;
        if (['archery', 'timely_contact', 'river', 'vref'].some(key => call.field(key) !== null)) return null;
        // A structurally paired but unowned call (e.g. CreateProject) is a barrier,
        // not permission to invent a project and not a veto on later serial stages.
        if (call.name !== 'ProjectForge' || !KNOWN.has(call.command) || !/^[A-Za-z0-9_-]+$/.test(call.projectId || '')) {
            rows.push({ barrier: true }); call = null; continue;
        }
        const status = parsed[2].trim();
        const body = parsed[3];
        let done = [];
        if (call.command === 'UpdateTodos' && status === '✅ SUCCESS') {
            const header = /^## Todo 已更新 · [^\r\n]*（`([A-Za-z0-9_-]+)`）\r?$/m.exec(body);
            const changes = /^- 变更：([^\r\n]*)\r?$/m.exec(body)?.[1] || '';
            const requested = seqs(call.field('done'));
            const overwritten = ['doing', 'pending', 'blocked', 'remove'].flatMap(key => seqs(call.field(key)));
            const changed = [...changes.matchAll(/(?:^|，)#([1-9]\d*)→done(?=，|$)/g)].map(match => match[1]);
            if (header?.[1] === call.projectId && !/未找到的序号/.test(body)
                && !overwritten.length && requested.length && requested.every(id => changed.includes(id))) done = requested;
        }
        rows.push({ call, result: range, envelope: event, raw, body, status, done, batchId: event.batchId });
        call = null;
    }
    return call ? null : rows;
}

function sourceOf(item) {
    return { messageId: item.message.id, partIndex: item.partIndex, start: item.row.result.start, end: item.row.result.end,
        messageChars: item.text.length, fingerprint: forgeSourceFingerprint(item.text),
        resultFingerprint: forgeSourceFingerprint(item.row.raw), batchId: item.row.batchId };
}
function observationOf(item) {
    const { call, status, body } = item.row;
    const nodeLines = body.split(/\r?\n/).filter(line => /^- /.test(line) && /`[nb]\d+`/.test(line));
    return { source: sourceOf(item), projectId: call.projectId, command: call.command, status,
        path: call.field('path') || '', from: call.field('from') || '', to: call.field('to') || '',
        reason: call.field('reason') || '', symbol: call.field('symbol') || '', todo: call.field('todo') || '',
        anchors: unique(nodeLines.flatMap(line => line.match(/\b[nb]\d+\b/g) || [])),
        receipt: nodeLines.join('\n'), done: item.row.done };
}

/** A historical observation ledger, not a current project/Todo database mirror. */
export function renderForgeStages(stages = []) {
    if (!stages.length) return '';
    const lines = ['## 宿主保留：Forge 阶段观察账本', '以下仅为历史协议观测；Todo done是状态切点，不证明测试通过或当前磁盘状态。原文仍在话题历史，来源偏移按UTF-16计算。'];
    for (const stage of stages) {
        lines.push(`projectId: ${stage.projectId} · 阶段关闭Todo #${stage.done.join(',#')}`);
        for (const entry of stage.entries) {
            lines.push(`- ${entry.command} ${entry.path || entry.from || entry.to || ''} · ${entry.status}${entry.anchors.length ? ' · '+entry.anchors.join(' ') : ''}`);
            if (entry.reason) lines.push(`  原因声明：${entry.reason}`);
            if (entry.symbol) lines.push(`  符号：${entry.symbol}`);
            if (entry.receipt) lines.push(entry.receipt);
            lines.push(`  原文 messageId=${JSON.stringify(entry.source.messageId)} part=${entry.source.partIndex} [${entry.source.start},${entry.source.end}) ${entry.source.resultFingerprint}`);
        }
    }
    return lines.join('\n');
}

function preview(item, maxPreviewChars) {
    const { row } = item;
    if (!SHRINKABLE.has(row.call.command) || row.status !== '✅ SUCCESS' || row.body.length <= maxPreviewChars) return null;
    // Never shorten a failed/partial/unknown result, warning or explicit test summary.
    if (/失败|错误|Error|Exception|警告|⚠|truncat|cancel|timeout|未完成|未写入|跳过|未找到|\b(?:tests?|pass(?:ed)?|fail(?:ed)?|skip(?:ped)?)\b/i.test(row.body)) return null;
    const half = Math.floor(maxPreviewChars / 2);
    const headers = row.body.split(/\r?\n/).filter(line => /^#{1,4} |^- /.test(line) && /`[nb]\d+`|reason|工程|已写入|已新建|已覆盖/.test(line));
    const kept = unique([row.body.slice(0, half), ...headers, row.body.slice(-half)]).join('\n');
    return `${FOLD_MARKER}\nProjectForge ${row.call.command} · ${row.status}（历史回执，不代表全局验收）\n${kept}\n[中段省略；不是完整发现；原文messageId=${JSON.stringify(item.message.id)} part=${item.partIndex} [${row.result.start},${row.result.end}) ${forgeSourceFingerprint(row.raw)}]\n`;
}

/**
 * Call with T2-effective history. Rebuilt from source on every boundary; no mutable cache.
 * Only complete ProjectForge stages close on a successful, uniquely paired UpdateTodos(done).
 * Latest keepRecentBatches results stay raw. Rejected stages leave input references untouched.
 */
export function projectForgeHistory(history = [], options = {}) {
    const keepRecentBatches = options.keepRecentBatches ?? 2;
    const maxPreviewChars = options.maxPreviewChars ?? 1200;
    const maxLedgerChars = options.maxLedgerChars ?? 24000;
    if (![keepRecentBatches, maxPreviewChars, maxLedgerChars].every(Number.isSafeInteger)
        || keepRecentBatches < 0 || maxPreviewChars < 128 || maxLedgerChars < 0) throw new TypeError('Invalid Forge projection budget');
    const ids = history.map(message => message?.id).filter(id => typeof id === 'string');
    const duplicateIds = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
    const candidates = [];
    const allRows = [];
    let pending = [];
    let projectId = null;
    for (const message of history) {
        if (!message || message.role !== 'assistant' || message.isThinking || message.contextCompaction
            || message.attachments?.length || message.tool_calls?.length || typeof message.id !== 'string' || !message.id || duplicateIds.has(message.id)) {
            pending = []; projectId = null; continue;
        }
        const part = textPart(message);
        const rows = part && scanMessage(part.text);
        if (!rows) { pending = []; projectId = null; continue; }
        for (const row of rows) {
            if (row.barrier) { pending = []; projectId = null; continue; }
            const item = { message, text: part.text, partIndex: part.partIndex, row };
            allRows.push(item);
            if (projectId !== row.call.projectId) pending = [];
            projectId = row.call.projectId;
            pending.push(item);
            if (row.done.length) {
                candidates.push({ projectId, done: row.done, items: pending });
                pending = [];
            }
        }
    }
    const protectedRows = new Set(allRows.slice(Math.max(0, allRows.length - keepRecentBatches)));
    const edits = new Map();
    const stages = [];
    for (const candidate of candidates) {
        const selected = candidate.items.filter(item => !protectedRows.has(item));
        const replacements = selected.map(item => ({ item, text: preview(item, maxPreviewChars) })).filter(edit => edit.text !== null);
        if (!replacements.length) continue;
        const stage = { version: 1, projectId: candidate.projectId, done: candidate.done,
            closure: sourceOf(candidate.items.at(-1)), entries: candidate.items.map(observationOf) };
        if (JSON.stringify([...stages, stage]).length > maxLedgerChars) continue;
        let saving = 0;
        for (const edit of replacements) saving += JSON.stringify(edit.item.row.raw).length - JSON.stringify(edit.text).length;
        // Include the entire recoverable stage metadata AND its rendered form in the benefit price.
        if (saving <= JSON.stringify(stage).length + JSON.stringify(renderForgeStages([stage])).length + 256) continue;
        stages.push(stage);
        for (const edit of replacements) {
            const list = edits.get(edit.item.message) || [];
            list.push({ start: edit.item.row.result.start, end: edit.item.row.result.end, text: edit.text });
            edits.set(edit.item.message, list);
        }
    }
    if (!stages.length) return { history, stages: [], stats: { foldedResults: 0, savedChars: 0 } };
    const projected = history.map(message => {
        const list = edits.get(message);
        if (!list) return message;
        const part = textPart(message);
        let text = part.text;
        for (const edit of list.sort((left, right) => right.start - left.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
        return { ...message, content: part.partIndex === -1 ? text : [{ ...message.content[0], text }] };
    });
    return { history: projected, stages, stats: { foldedResults: [...edits.values()].reduce((count, list) => count + list.length, 0),
        savedChars: JSON.stringify(history).length - JSON.stringify(projected).length } };
}

/** Locate original payload without executing it. Fingerprints detect ordinary edits, not malicious collisions. */
export function recoverForgeSource(history, source) {
    const matches = history.filter(message => message?.id === source.messageId);
    if (matches.length !== 1) return null;
    const part = textPart(matches[0]);
    if (!part || part.partIndex !== source.partIndex || part.text.length !== source.messageChars
        || forgeSourceFingerprint(part.text) !== source.fingerprint) return null;
    const raw = part.text.slice(source.start, source.end);
    return forgeSourceFingerprint(raw) === source.resultFingerprint ? raw : null;
}

/** Revalidate historical observations against original messages, not rendered summaries.
 * Fingerprints detect ordinary edits; they are not authentication or proof of testing. */
export function inheritForgeStages(history, state) {
    const warnings = [];
    if (state === undefined) return { stages: [], warnings };
    if (state?.version !== 1 || !Array.isArray(state.stages) || JSON.stringify(state).length > 24000) {
        return { stages: [], warnings: ['Forge历史账本版本或大小无效；未继承机器观察，原始历史仍保留'] };
    }
    const positions = new Map();
    history.forEach((message, index) => {
        const list = positions.get(message?.id) || [];
        list.push(index); positions.set(message?.id, list);
    });
    const seen = new Set();
    const stages = [];
    for (const stage of state.stages) {
        let valid = stage?.version === 1 && Array.isArray(stage.entries) && stage.entries.length > 0
            && Array.isArray(stage.done) && stage.done.length > 0;
        let lastPosition = -1;
        let lastEnd = -1;
        const sources = new Set();
        if (valid) for (const entry of stage.entries) {
            const source = entry?.source;
            if (!source || !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end)
                || source.start < 0 || source.end <= source.start || recoverForgeSource(history, source) === null) { valid = false; break; }
            const indexes = positions.get(source.messageId);
            const index = indexes?.length === 1 ? indexes[0] : -1;
            if (index < lastPosition || (index === lastPosition && source.start < lastEnd)) { valid = false; break; }
            const message = history[index];
            const part = textPart(message);
            const rows = message.role === 'assistant' && !message.contextCompaction && !message.attachments?.length
                ? scanMessage(part.text) : null;
            const row = rows?.find(item => !item.barrier && item.result.start === source.start && item.result.end === source.end);
            const key = JSON.stringify([source.messageId, source.partIndex, source.start, source.end]);
            if (!row || sources.has(key) || row.call.projectId !== stage.projectId
                || JSON.stringify(observationOf({ message, text: part.text, partIndex: part.partIndex, row })) !== JSON.stringify(entry)) { valid = false; break; }
            sources.add(key); lastPosition = index; lastEnd = source.end;
        }
        if (valid) {
            const last = stage.entries.at(-1);
            valid = JSON.stringify(last.source) === JSON.stringify(stage.closure)
                && last.command === 'UpdateTodos' && last.status === '✅ SUCCESS'
                && JSON.stringify(last.done) === JSON.stringify(stage.done);
        }
        if (!valid) {
            warnings.push('Forge阶段来源已变化、缺失或不匹配；未继承该机器观察，按原始话题历史回读');
            continue;
        }
        const key = JSON.stringify(stage.closure);
        if (!seen.has(key)) { seen.add(key); stages.push(structuredClone(stage)); }
    }
    return { stages, warnings: unique(warnings) };
}
