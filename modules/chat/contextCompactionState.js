import { readToolRequestField, replaceToolRequestBlocks, findUnclosedToolRequest } from '../renderer/toolRequestScanner.js';
import { collectToolResultRanges, collectCodeDomainsOutsideToolResults, isToolResultHidden } from '../renderer/toolResultRegions.js';
import { extractAnchors, flattenContent } from './contextCompactionFidelity.js';
import { extractOpenIssueWindows } from './contextCompactionContinuity.js';

export const COMPACTION_KIND = 'vchat-context-checkpoint';

export function isContextCheckpoint(message) {
    return message?.role === 'user'
        && message.contextCompaction?.kind === COMPACTION_KIND
        && message.contextCompaction?.version === 1
        && typeof message.contextCompaction.checkpoint === 'string';
}

/** UI history remains complete; only outbound history starts at the newest checkpoint. */
export function effectiveContextHistory(history = []) {
    let start = 0;
    for (let index = history.length - 1; index >= 0; index--) {
        if (isContextCheckpoint(history[index])) {
            start = index;
            break;
        }
    }
    return history.slice(start).filter(message => message && !message.isThinking);
}

function removeRanges(text, ranges) {
    let output = '';
    let cursor = 0;
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
        if (range.start >= cursor) output += text.slice(cursor, range.start);
        cursor = Math.max(cursor, range.end);
    }
    return output + text.slice(cursor);
}

function countOccurrences(text, target) {
    if (!target) return 0;
    let count = 0;
    let cursor = 0;
    while ((cursor = text.indexOf(target, cursor)) !== -1) {
        count++;
        cursor += target.length;
    }
    return count;
}

function applyDiaryEvent(event, diaries, warnings) {
    const fields = event.fields;
    if (event.command === 'update') {
        const target = fields.target;
        const replacement = fields.replace;
        const candidates = diaries.filter(diary =>
            !diary.unparsed
            && ['fileName', 'folder', 'agent', 'date'].every(key => !fields[key] || diary[key] === fields[key])
            && typeof target === 'string' && target.length > 0
            && countOccurrences(diary.content, target) === 1);
        if (replacement !== null && candidates.length === 1) {
            const diary = candidates[0];
            // Function replacement is essential: $&, $' and $$ are literal diary characters.
            diary.content = diary.content.replace(target, () => replacement);
        } else {
            warnings.push('日记更新未能唯一匹配，已跳过并保留原文');
        }
        return;
    }
    diaries.push({
        fileName: fields.fileName || '',
        folder: fields.folder || '',
        agent: fields.agent || '',
        date: fields.date || '',
        tag: fields.tag || '',
        content: fields.content ?? event.raw,
        unparsed: fields.content === null,
    });
    if (fields.content === null) warnings.push('日记内容无法解析，已原样保留整个日记块');
}

function readDiaryFields(body) {
    const raw = name => readToolRequestField(body, name, { trim: false });
    const meta = name => readToolRequestField(body, name) || '';
    return {
        content: raw('Content'),
        target: raw('target'),
        replace: raw('replace'),
        fileName: meta('fileName'),
        folder: meta('folder'),
        agent: meta('maid') || meta('maidName') || meta('valet') || meta('valetName'),
        date: meta('Date'),
        tag: raw('Tag'),
    };
}

/** Extract actual protocol blocks without interpreting marker-looking code or result payloads. */
export function extractDiaryText(text, diaries, warnings) {
    const events = [];
    const requests = [];
    replaceToolRequestBlocks(text, (raw, body, start, end) => {
        requests.push({ start, end });
        const name = readToolRequestField(body, 'tool_name')
            || body.match(/<tool_name>([\s\S]*?)<\/tool_name>/i)?.[1];
        if (name?.trim().toLowerCase() === 'dailynote') {
            const fields = readDiaryFields(body);
            const command = (readToolRequestField(body, 'command') || '').toLowerCase();
            events.push({
                start, end, raw, fields,
                command: command === 'update' || (!command && fields.target !== null && fields.replace !== null) ? 'update' : 'create',
            });
        }
        return raw;
    });

    const results = collectToolResultRanges(text);
    const codes = collectCodeDomainsOutsideToolResults(text, results)
        .filter(range => range.kind === 'fence' || !text.slice(range.start, range.end).includes('\n'));
    const blocked = [...results, ...codes, ...requests];
    const legacyStart = '<<<DailyNoteStart>>>';
    const legacyEnd = '<<<DailyNoteEnd>>>';
    let cursor = 0;
    while ((cursor = text.indexOf(legacyStart, cursor)) !== -1) {
        const start = cursor;
        cursor += legacyStart.length;
        if (blocked.some(range => start >= range.start && start < range.end)) continue;
        const close = text.indexOf(legacyEnd, cursor);
        const end = close === -1 ? text.length : close + legacyEnd.length;
        const body = text.slice(cursor, close === -1 ? text.length : close);
        const contentMarker = /(?:^|\n)Content:[ \t]*/i.exec(body);
        const metadata = key => body.match(new RegExp(`(?:^|\\n)${key}:[ \\t]*([^\\r\\n]*)`, 'i'))?.[1]?.trim() || '';
        events.push({
            start, end, raw: text.slice(start, end), command: 'create',
            fields: {
                content: contentMarker && close !== -1 ? body.slice(contentMarker.index + contentMarker[0].length) : null,
                agent: metadata('Maid') || metadata('Valet'), date: metadata('Date'),
                fileName: metadata('fileName'), folder: metadata('folder'), tag: '',
            },
        });
        cursor = end;
    }
    const unclosed = findUnclosedToolRequest(text);
    if (unclosed && readToolRequestField(unclosed.content.slice('<<<[TOOL_REQUEST]>>>'.length), 'tool_name')?.toLowerCase() === 'dailynote') {
        events.push({
            start: unclosed.startIndex, end: text.length, raw: unclosed.content,
            command: 'create', fields: { content: null },
        });
    }
    events.sort((a, b) => a.start - b.start);
    for (const event of events) applyDiaryEvent(event, diaries, warnings);

    // DailyNote receipts are excluded too; never treat nested marker text as a new invocation.
    const receipts = results.filter(range => {
        const raw = text.slice(range.start, range.end);
        return isToolResultHidden(raw)
            || /^[ \t]*-[ \t]*(?:工具名称|tool_name):[ \t]*DailyNote[ \t]*\r?$/im.test(raw);
    });
    return removeRanges(text, [...events, ...receipts]);
}

function transformContent(content, transform) {
    if (typeof content === 'string') return transform(content);
    if (Array.isArray(content)) return content.map(part =>
        part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: transform(part.text) } : part);
    if (content && typeof content.text === 'string') return { ...content, text: transform(content.text) };
    return content;
}

// 压缩请求里附件和超长工具返回只带有上限的摘录。附件记录会作为“历史附件元数据”整份
// 序列化（contextCompactionPrompts.js），其中 _fileManagerData.extractedText 是附件抽出的
// 全文；工具返回也原样整段发出。一份几 MB 的网页附件就能让压缩请求本身超过压缩模型的
// 上限，压缩永远做不成。保真审计和冲突比较都读这份 state，所以截短放在这里，三者看到的
// 是同一份内容。数值是经验值：附件开头 4000 字足够认出是什么文件；工具返回超过 6000 字时
// 留开头 4000、结尾 1000。
const ATTACHMENT_EXCERPT_CHARS = 4000;
const TOOL_RESULT_LIMIT_CHARS = 6000;
const TOOL_RESULT_HEAD_CHARS = 4000;
const TOOL_RESULT_TAIL_CHARS = 1000;

const BULKY_ATTACHMENT_FIELDS = new Set(['_fileManagerData', 'extractedText', 'imageFrames', 'inlineFrames']);
const FILE_MANAGER_METADATA = ['name', 'type', 'size', 'hash', 'internalPath', 'sourcePath', 'isLiveReference', 'pdfMeta'];

function attachmentForCompaction(attachment) {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const data = attachment._fileManagerData || {};
    const text = [data.extractedText, attachment.extractedText].find(value => typeof value === 'string') || '';
    // 顶层字段照留（冲突比较也靠它们），只去掉全文和图片帧，再从 _fileManagerData 补上元数据。
    const summary = Object.fromEntries(Object.entries(attachment).filter(([key]) => !BULKY_ATTACHMENT_FIELDS.has(key)));
    for (const key of FILE_MANAGER_METADATA) {
        if (summary[key] === undefined && data[key] !== undefined) summary[key] = data[key];
    }
    if (text) {
        summary.textLength = text.length;
        summary.excerpt = text.slice(0, ATTACHMENT_EXCERPT_CHARS);
        if (text.length > ATTACHMENT_EXCERPT_CHARS) {
            summary.excerptNote = `压缩时只带开头 ${ATTACHMENT_EXCERPT_CHARS} 字，全文 ${text.length} 字，需要时按路径重读`;
        }
    }
    return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function capToolResults(text) {
    const ranges = collectToolResultRanges(text)
        .filter(range => range.end - range.start > TOOL_RESULT_LIMIT_CHARS)
        .sort((a, b) => a.start - b.start);
    if (!ranges.length) return text;
    let output = '';
    let cursor = 0;
    for (const range of ranges) {
        if (range.start < cursor) continue;
        const block = text.slice(range.start, range.end);
        const omitted = block.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
        output += text.slice(cursor, range.start)
            + block.slice(0, TOOL_RESULT_HEAD_CHARS)
            + `\n【压缩时略去中间 ${omitted} 字】\n`
            + block.slice(block.length - TOOL_RESULT_TAIL_CHARS);
        cursor = range.end;
    }
    return output + text.slice(cursor);
}

/** No mutation of the source history or the previous checkpoint's diary state. */
export function prepareCompactionState(history = []) {
    const effective = effectiveContextHistory(history);
    const previous = isContextCheckpoint(effective[0]) ? effective[0] : null;
    const diaries = (previous?.contextCompaction.diaries || []).map(diary => ({ ...diary }));
    const warnings = [...(previous?.contextCompaction.warnings || [])];
    const messages = effective.map(message => {
        if (isContextCheckpoint(message)) {
            return { role: 'user', content: message.contextCompaction.checkpoint };
        }
        const copy = { role: message.role, content: transformContent(message.content, text => capToolResults(extractDiaryText(text, diaries, warnings))) };
        for (const key of ['name', 'tool_calls', 'tool_call_id', 'attachments']) {
            if (message[key] !== undefined) copy[key] = message[key];
        }
        if (Array.isArray(copy.attachments)) copy.attachments = copy.attachments.map(attachmentForCompaction);
        return copy;
    });
    // Closed loop: the previous checkpoint's audit misses are surfaced to the
    // next compression request, so the model is told exactly what it dropped.
    const previousAuditMissing = previous ? [...new Set([
        ...((previous.contextCompaction.fidelity?.missing?.path) || []),
        ...((previous.contextCompaction.fidelity?.missing?.hash) || []),
        ...((previous.contextCompaction.fidelity?.missing?.url) || []),
        ...((previous.contextCompaction.continuity?.anchors?.missing) || []),
    ].filter(Boolean))].slice(0, 16) : [];
    return {
        messages, diaries, warnings: [...new Set(warnings)], sourceCount: effective.length,
        previousCheckpoint: previous ? previous.contextCompaction.checkpoint : null,
        previousAuditMissing,
    };
}

export function validateCheckpoint(value) {
    if (Array.isArray(value)) {
        if (value.some(part => !['text', 'output_text'].includes(part?.type) || typeof part.text !== 'string')) {
            throw new Error('压缩模型返回了非文本内容，未保存快照');
        }
        value = value.map(part => part.text).join('');
    }
    if (typeof value !== 'string' || !value.trim()) throw new Error('压缩模型未返回有效文本，原历史未修改');
    // Report quality belongs to the prompt. Metadata, not model-authored tags,
    // owns the context boundary. Preserve every character of the returned report.
    return value;
}


/**
 * Cheap pre-flight digest of what a compaction is about to consume: message
 * count, distinct identifier anchors, and open-issue windows carried over
 * from the previous checkpoint. Pure local statistics surfaced to the user
 * while a compaction is running; not a gate, not an estimate of quality.
 * @param {Array} history raw chat history
 * @returns {{sourceCount: number, anchors: number, openWindows: number}}
 */
export function summarizeCompactionInput(history = []) {
    const effective = effectiveContextHistory(history);
    const previousCheckpoint = (isContextCheckpoint(effective[0]) ? effective[0] : null)
        ?.contextCompaction?.checkpoint || null;
    let anchors = 0;
    for (const message of effective) {
        for (const anchorsOfKind of extractAnchors(flattenContent(message?.content)).values()) {
            anchors += anchorsOfKind.size;
        }
    }
    return {
        sourceCount: effective.length,
        anchors,
        openWindows: extractOpenIssueWindows(previousCheckpoint).length,
    };
}