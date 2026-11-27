import { readToolRequestField, replaceToolRequestBlocks } from '../renderer/toolRequestScanner.js';
import { collectToolResultRanges, collectCodeDomainsOutsideToolResults, isToolResultHidden } from '../renderer/toolResultRegions.js';
import { extractAnchors, flattenContent } from './contextCompactionFidelity.js';
import { extractOpenIssueWindows } from './contextCompactionContinuity.js';
import {
    isLineLeadingBlank,
    findNestedVcpInfoRanges,
    findClosedFenceAndToolRanges,
    maskProtectedRegions,
    unmaskProtectedRegions,
    isGuidanceErrorInfoBlock,
    stripThoughtChains,
    stripResilienceNoiseFromMasked,
} from '../shared/vcpResilienceMaskEsm.js';

export const COMPACTION_KIND = 'vchat-context-checkpoint';

export function isContextCheckpoint(message) {
    return message?.role === 'user'
        && message.contextCompaction?.kind === COMPACTION_KIND
        && message.contextCompaction?.version === 1
        && typeof message.contextCompaction.checkpoint === 'string';
}

function checkpointFailure(value) {
    if (typeof value !== 'string' || !value.trim()) return '压缩模型未返回有效文本，原历史未修改';
    const text = value.trimStart();
    if (/^(?:\[UPSTREAM_ERROR\]|upstream_stalled(?=$|[\s:：]))/i.test(text)
        || /^\{\s*"error"\s*:/.test(text)) {
        return '压缩模型返回上游错误信封，未保存快照';
    }
    return null;
}

function isBrokenCheckpoint(message) {
    return isContextCheckpoint(message) && checkpointFailure(message.contextCompaction.checkpoint) !== null;
}

/** UI history remains complete; outbound history starts at the newest usable checkpoint. */
export function effectiveContextHistory(history = []) {
    let start = 0;
    for (let index = history.length - 1; index >= 0; index--) {
        if (isContextCheckpoint(history[index]) && !isBrokenCheckpoint(history[index])) {
            start = index;
            break;
        }
    }
    return history.slice(start).filter(message => message && !message.isThinking && !isBrokenCheckpoint(message));
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

function sha1Hex8(str) {
    let bytes;
    if (typeof TextEncoder !== 'undefined') {
        bytes = new TextEncoder().encode(str);
    } else {
        const utf8 = unescape(encodeURIComponent(str));
        bytes = new Uint8Array(utf8.length);
        for (let i = 0; i < utf8.length; i++) bytes[i] = utf8.charCodeAt(i);
    }
    const len = bytes.length;
    const totalLen = (((len + 8) >> 6) + 1) * 64;
    const buf = new Uint8Array(totalLen);
    buf.set(bytes);
    buf[len] = 0x80;
    const bitLen = len * 8;
    const dv = new DataView(buf.buffer);
    dv.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(totalLen - 4, bitLen >>> 0, false);

    let h0 = 0x67452301;
    let h1 = 0xEFCDAB89;
    let h2 = 0x98BADCFE;
    let h3 = 0x10325476;
    let h4 = 0xC3D2E1F0;
    const w = new Int32Array(80);
    const rol = (n, s) => (n << s) | (n >>> (32 - s));

    for (let offset = 0; offset < totalLen; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getInt32(offset + i * 4, false);
        for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let i = 0; i < 80; i++) {
            const f = i < 20 ? ((b & c) | (~b & d))
                : i < 40 ? (b ^ c ^ d)
                : i < 60 ? ((b & c) | (b & d) | (c & d))
                : (b ^ c ^ d);
            const k = i < 20 ? 0x5A827999 : i < 40 ? 0x6ED9EBA1 : i < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
            const temp = (rol(a, 5) + f + e + k + w[i]) | 0;
            e = d; d = c; c = rol(b, 30); b = a; a = temp;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return ((h0 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 8);
}

function collectReceiptAnalysis(text) {
    const fingerprints = new Set();
    const codes = new Set();
    let hasReceipt = false;
    if (typeof text !== 'string' || !text.includes('[[VCP协议纠偏指导:')) {
        return { hasReceipt, fingerprints, codes };
    }
    const collectFrom = (chunk) => {
        const re = /\[\[VCP协议纠偏指导:[^\]]*\bblock=([0-9a-f]{8})\b/gi;
        let m;
        while ((m = re.exec(chunk)) !== null) {
            fingerprints.add(m[1].toLowerCase());
        }
        const codeRe = /\[\[VCP协议纠偏指导:[^\]]*\bcode=([A-Z0-9_]+)\b/gi;
        let cm;
        while ((cm = codeRe.exec(chunk)) !== null) {
            codes.add(cm[1].toUpperCase());
        }
    };

    // 1. 仅从真正的纠偏错误汇总块提取凭条，并记录全部 infoRanges 用于遮罩正常工具输出（如 FileOperator 源码）
    const infoRanges = findNestedVcpInfoRanges(text);
    for (const r of infoRanges) {
        const block = text.slice(r.start, r.end);
        if (isGuidanceErrorInfoBlock(block)) {
            hasReceipt = true;
            collectFrom(block);
        }
    }

    // 2. 在剔除全部 infoRanges 后的临时扫描视图中匹配 ROLE_DIVIDE_USER，防止正常工具输出内的字面量或 <<<[END_ROLE_DIVIDE_USER]>>> 伪造/截断回执
    let outsideInfo = text;
    if (infoRanges.length > 0) {
        let out = '';
        let cur = 0;
        for (const r of infoRanges) {
            if (r.start < cur) continue;
            out += text.slice(cur, r.start) + ' ';
            cur = r.end;
        }
        out += text.slice(cur);
        outsideInfo = out;
    }

    const roleRe = /<<<\[ROLE_DIVIDE_USER\]>>>([\s\S]*?)<<<\[END_ROLE_DIVIDE_USER\]>>>/g;
    let rm;
    while ((rm = roleRe.exec(outsideInfo)) !== null) {
        if (/\[\[VCP协议纠偏指导:\s*code=[A-Z0-9_]+/i.test(rm[1])) {
            hasReceipt = true;
            collectFrom(rm[1]);
        }
    }
    return { hasReceipt, fingerprints, codes };
}

function extractReceiptFingerprints(text) {
    return collectReceiptAnalysis(text).fingerprints;
}

function hasRealGuidanceReceiptEsm(text) {
    return collectReceiptAnalysis(text).hasReceipt;
}

function isInsideInlineBacktick(text, index, length) {
    if ((index > 0 && text[index - 1] === '`') || (index + length < text.length && text[index + length] === '`')) {
        return true;
    }
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const nl = text.indexOf('\n', index);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    const rel = index - lineStart;
    let i = 0;
    while (i < line.length) {
        if (line[i] !== '`') {
            i += 1;
            continue;
        }
        let tickLen = 0;
        while (i + tickLen < line.length && line[i + tickLen] === '`') tickLen += 1;
        const spanStart = i;
        const closeRe = new RegExp(`(?<!\`)\`{${tickLen}}(?!\`)`);
        const m = closeRe.exec(line.slice(i + tickLen));
        if (m) {
            const spanEnd = i + tickLen + m.index + tickLen;
            if (rel >= spanStart && rel < spanEnd) return true;
            i = spanEnd;
        } else {
            i += tickLen;
        }
    }
    return false;
}

function stripFieldPayloadsForValidation(body) {
    let out = '';
    let cursor = 0;
    while (cursor < body.length) {
        const atCursor = body.slice(cursor).match(
            /^[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/i
        );
        let field = null;
        if (atCursor) {
            const marker = atCursor[2];
            const markerStart = cursor + atCursor[0].lastIndexOf(marker);
            field = { markerStart, markerEnd: markerStart + marker.length, marker };
        } else {
            const re = /(^|\n|,)[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/gi;
            re.lastIndex = cursor;
            const m = re.exec(body);
            if (m) {
                const marker = m[3];
                const markerStart = m.index + m[0].lastIndexOf(marker);
                field = { markerStart, markerEnd: markerStart + marker.length, marker };
            }
        }
        if (!field) {
            out += body.slice(cursor);
            break;
        }
        const usesBrace = field.marker[0] === '{';
        const isEsc = /escape/i.test(field.marker);
        const closeRe = new RegExp(
            `${usesBrace ? '\\{' : '「'}末${isEsc ? 'ESCAPE' : ''}${usesBrace ? '\\}' : '」'}`,
            'ig'
        );
        closeRe.lastIndex = field.markerEnd;
        const closeM = closeRe.exec(body);
        if (!closeM) {
            out += body.slice(cursor);
            break;
        }
        if (!isEsc) {
            const innerSlice = body.slice(field.markerEnd, closeM.index)
                .replace(/「始ESCAPE」[\s\S]*?「末ESCAPE」/gi, '')
                .replace(/\{始ESCAPE\}[\s\S]*?\{末ESCAPE\}/gi, '');
            if (/(?:^|\n|,)[ \t]*[^\s,:：「」{}]+[ \t]*[:：][ \t]*(?:「始|\{始)/.test(innerSlice)) {
                out += body.slice(cursor, field.markerEnd);
                cursor = field.markerEnd;
                continue;
            }
        }
        out += body.slice(cursor, field.markerEnd) + closeM[0];
        cursor = closeM.index + closeM[0].length;
    }
    return out;
}

function hasDuplicateControlKeyConflict(body) {
    const controlKeys = new Set(['tool_name', 'jev', 'maid', 'valet']);
    const seen = new Map();
    const xmlToolM = body.match(/^\s*<tool_name>([^<\r\n]+)<\/tool_name>/i);
    if (xmlToolM) seen.set('tool_name', xmlToolM[1].trim());
    let cursor = 0;
    while (cursor < body.length) {
        const atCursor = body.slice(cursor).match(
            /^[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/i
        );
        let key = null;
        let marker = null;
        let markerEnd = -1;
        if (atCursor) {
            key = atCursor[1].toLowerCase();
            marker = atCursor[2];
            markerEnd = cursor + atCursor[0].length;
        } else {
            const re = /(^|\n|,)[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/gi;
            re.lastIndex = cursor;
            const m = re.exec(body);
            if (!m) break;
            key = m[2].toLowerCase();
            marker = m[3];
            markerEnd = m.index + m[0].length;
        }
        const usesBrace = marker[0] === '{';
        const isEsc = /escape/i.test(marker);
        const closeRe = new RegExp(
            `${usesBrace ? '\\{' : '「'}末${isEsc ? 'ESCAPE' : ''}${usesBrace ? '\\}' : '」'}`,
            'ig'
        );
        closeRe.lastIndex = markerEnd;
        const closeM = closeRe.exec(body);
        if (!closeM) break;
        if (!isEsc) {
            const innerSlice = body.slice(markerEnd, closeM.index)
                .replace(/「始ESCAPE」[\s\S]*?「末ESCAPE」/gi, '')
                .replace(/\{始ESCAPE\}[\s\S]*?\{末ESCAPE\}/gi, '');
            if (/(?:^|\n|,)[ \t]*[^\s,:：「」{}]+[ \t]*[:：][ \t]*(?:「始|\{始)/.test(innerSlice)) {
                cursor = markerEnd;
                continue;
            }
        }
        const val = body.slice(markerEnd, closeM.index).trim();
        if (controlKeys.has(key)) {
            if (seen.has(key) && seen.get(key) !== val) return true;
            seen.set(key, val);
        }
        cursor = closeM.index + closeM[0].length;
    }
    return false;
}

function isBrokenToolRequestBody(rawBlock, receiptCodes = null) {
    const body = rawBlock
        .replace(/^<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/i, '')
        .replace(/<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}$/i, '');
    const skeleton = stripFieldPayloadsForValidation(body);
    const hasToolName = /(?:^|\n|,)\s*tool_name\s*[:：]\s*(?:[「{]始(?:ESCAPE)?[」}]|<\/tool_name>)/i.test(skeleton)
        || /<tool_name>[^<\r\n]+<\/tool_name>/i.test(skeleton)
        || /(?:^|\n|,)\s*tool_name\s*[:：]\s*[「{]始/i.test(skeleton);
    const hasJev = /(?:^|\n|,)\s*jev\s*[:：]\s*[「{]始/i.test(skeleton);
    if (!hasToolName && !hasJev) return true;
    if (/(?:^|\n|,)\s*(?:tool_name|maid|valet|jev)\s*=\s*["']?/i.test(skeleton)) return true;
    const opens = (skeleton.match(/[「{]始(?:ESCAPE|escape)?[」}]/gi) || []).length;
    const closes = (skeleton.match(/[「{]末(?:ESCAPE|escape)?[」}]/gi) || []).length;
    if (opens > closes) return true;
    if (receiptCodes?.has('MISSING_MAID')
        && !/(?:^|\n|,)\s*(?:maid|maidname|valet|valetname)\s*[:：]\s*[「{]始/i.test(skeleton)) {
        return true;
    }
    if (receiptCodes?.has('DUPLICATE_KEY_CONFLICT') && hasDuplicateControlKeyConflict(body)) {
        return true;
    }
    return false;
}

function computeAnyClosedMatchedFp(text, receiptFingerprints) {
    if (!receiptFingerprints || receiptFingerprints.size === 0) return false;
    const nonGuidanceInfoRanges = findNestedVcpInfoRanges(text)
        .filter(r => !isGuidanceErrorInfoBlock(text.slice(r.start, r.end)));
    let maskedForFp = text;
    if (nonGuidanceInfoRanges.length > 0) {
        let buf = '';
        let cur = 0;
        for (const r of nonGuidanceInfoRanges) {
            if (r.start < cur) continue;
            buf += text.slice(cur, r.start) + text.slice(r.start, r.end).replace(/[^\n]/g, ' ');
            cur = r.end;
        }
        buf += text.slice(cur);
        maskedForFp = buf;
    }
    const closedToolBlocks = findClosedFenceAndToolRanges(maskedForFp)
        .filter(r => r.kind === 'tool');
    return closedToolBlocks.some(r => receiptFingerprints.has(sha1Hex8(text.slice(r.start, r.end).trim())));
}

function findUnclosedToolBoundary(text, fromIndex, blockedRanges) {
    const candidates = [text.length];
    const pushBoundary = (idx) => {
        if (idx >= fromIndex && idx < candidates[0]) candidates[0] = idx;
    };

    const blankLineRe = /\r?\n[ \t]*\r?\n/g;
    blankLineRe.lastIndex = fromIndex;
    const blankM = blankLineRe.exec(text);
    if (blankM) pushBoundary(blankM.index);

    const wallRe = /<<<\[(?:END_)?ROLE_DIVIDE_[A-Z]+\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:|__VCP_MASK_/g;
    wallRe.lastIndex = fromIndex;
    const wallM = wallRe.exec(text);
    if (wallM) pushBoundary(wallM.index);

    const nextToolRe = /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
    nextToolRe.lastIndex = fromIndex;
    let nextM;
    while ((nextM = nextToolRe.exec(text)) !== null) {
        if (!blockedRanges || !blockedRanges.some(r => nextM.index >= r.start && nextM.index < r.end)) {
            pushBoundary(nextM.index);
            break;
        }
    }

    return candidates[0];
}

function stripBoundedMarkerBlocks(text, startRe, options = {}) {
    const requireLineLeading = Boolean(options?.requireLineLeading);
    const allowInlineIfFollowedByField = Boolean(options?.allowInlineIfFollowedByField);
    const extraBoundariesRe = options?.extraBoundariesRe || null;
    let out = '';
    let cursor = 0;
    while (cursor < text.length) {
        startRe.lastIndex = cursor;
        const m = startRe.exec(text);
        if (!m) {
            out += text.slice(cursor);
            break;
        }
        const markerEnd = m.index + m[0].length;
        const followedByField = allowInlineIfFollowedByField
            && /^[ \t]*\r?\n?[ \t]*(?:[^\s,:：「」{}]+[ \t]*[:：][ \t]*(?:「始|\{始)|<tool_name>)/i.test(
                text.slice(markerEnd, markerEnd + 160)
            );
        if (
            isInsideInlineBacktick(text, m.index, m[0].length)
            || (requireLineLeading && !isLineLeadingBlank(text, m.index) && !followedByField)
        ) {
            out += text.slice(cursor, markerEnd);
            cursor = markerEnd;
            continue;
        }

        let delStart = m.index;
        while (delStart > cursor && (text[delStart - 1] === ' ' || text[delStart - 1] === '\t')) {
            delStart -= 1;
        }
        out += text.slice(cursor, delStart);

        const scanFrom = markerEnd;
        let delEnd = text.length;
        const updateEnd = (idx) => {
            if (idx >= scanFrom && idx < delEnd) delEnd = idx;
        };

        const blankLineRe = /\r?\n[ \t]*\r?\n/g;
        blankLineRe.lastIndex = scanFrom;
        const blankM = blankLineRe.exec(text);
        if (blankM) updateEnd(blankM.index);

        const boundaryRe = /__VCP_MASK_|<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}|<<<\[(?:END_)?ROLE_DIVIDE_[A-Z]+\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:/gi;
        boundaryRe.lastIndex = scanFrom;
        const wallM = boundaryRe.exec(text);
        if (wallM) updateEnd(wallM.index);

        if (extraBoundariesRe) {
            extraBoundariesRe.lastIndex = scanFrom;
            const extraM = extraBoundariesRe.exec(text);
            if (extraM) updateEnd(extraM.index);
        }

        cursor = delEnd;
    }
    return out;
}

function findBareFieldCloseMatch(text, valStart, usesBrace, isEscape) {
    const hardWallRe = /__VCP_MASK_|<<<\[(?:END_)?ROLE_DIVIDE_[A-Z]+\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:/i;
    const lineToolRe = /^[ \t]*<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/im;
    const findEarliestWall = (from) => {
        const slice = text.slice(from);
        const hw = hardWallRe.exec(slice);
        const lt = lineToolRe.exec(slice);
        let earliest = -1;
        if (hw) earliest = from + hw.index;
        if (lt && (earliest === -1 || from + lt.index < earliest)) earliest = from + lt.index;
        return earliest;
    };

    if (isEscape) {
        const closeRe = usesBrace ? /\{末ESCAPE\}/gi : /「末ESCAPE」/gi;
        closeRe.lastIndex = valStart;
        const closeM = closeRe.exec(text);
        if (!closeM) return null;
        const wallIdx = findEarliestWall(valStart);
        if (wallIdx !== -1 && wallIdx < closeM.index) return null;
        return closeM;
    }

    const normalCloseRe = usesBrace ? /\{末\}/g : /「末」/g;
    const escOpenRe = /(?:「始ESCAPE」|\{始ESCAPE\})/gi;
    let cursor = valStart;
    while (cursor < text.length) {
        normalCloseRe.lastIndex = cursor;
        const normalCloseM = normalCloseRe.exec(text);
        escOpenRe.lastIndex = cursor;
        const escOpenM = escOpenRe.exec(text);
        const wallIdx = findEarliestWall(cursor);

        if (
            escOpenM
            && (!normalCloseM || escOpenM.index < normalCloseM.index)
            && (wallIdx === -1 || escOpenM.index < wallIdx)
        ) {
            const escCloseRe = escOpenM[0][0] === '{' ? /\{末ESCAPE\}/gi : /「末ESCAPE」/gi;
            escCloseRe.lastIndex = escOpenM.index + escOpenM[0].length;
            const escCloseM = escCloseRe.exec(text);
            if (!escCloseM || (wallIdx !== -1 && escCloseM.index > wallIdx)) return null;
            cursor = escCloseM.index + escCloseM[0].length;
            continue;
        }

        if (wallIdx !== -1 && (!normalCloseM || wallIdx < normalCloseM.index)) {
            return null;
        }
        return normalCloseM || null;
    }
    return null;
}

function stripCategoryVBareFieldClusters(text, { receiptFingerprints, hasExternalReceiptCode, hasUnreconciledReceipt }) {
    if (typeof text !== 'string' || !text) return text;
    if (!hasExternalReceiptCode && (!receiptFingerprints || receiptFingerprints.size === 0)) return text;

    const anchorRe = /^[ \t]*(?:maid|valet|tool_name|jev)[ \t]*[:：][ \t]*(?:「始(?:escape)?」|\{始(?:escape)?\})/gim;
    const fieldHeadRe = /^[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/i;
    const ranges = [];
    let searchCursor = 0;

    while (searchCursor < text.length) {
        anchorRe.lastIndex = searchCursor;
        const m = anchorRe.exec(text);
        if (!m) break;

        if (isInsideInlineBacktick(text, m.index, m[0].length)) {
            searchCursor = m.index + m[0].length;
            continue;
        }

        let scan = m.index;
        let fieldCount = 0;
        let lastEndWithoutNl = m.index;
        let lastEndWithNl = m.index;

        while (scan < text.length) {
            const fm = fieldHeadRe.exec(text.slice(scan));
            if (!fm) break;

            const marker = fm[2];
            const usesBrace = marker[0] === '{';
            const isEscape = /escape/i.test(marker);
            const valStart = scan + fm[0].length;
            const closeM = findBareFieldCloseMatch(text, valStart, usesBrace, isEscape);
            if (!closeM) break;

            let afterClose = closeM.index + closeM[0].length;
            const punctMatch = /^[ \t]*[,，]?[ \t]*/.exec(text.slice(afterClose));
            if (punctMatch) afterClose += punctMatch[0].length;

            lastEndWithoutNl = afterClose;
            const nlMatch = /^\r?\n/.exec(text.slice(afterClose));
            const afterLine = nlMatch ? afterClose + nlMatch[0].length : afterClose;
            lastEndWithNl = afterLine;

            fieldCount += 1;
            scan = afterLine;
        }

        if (fieldCount === 0) {
            searchCursor = m.index + m[0].length;
            continue;
        }

        const rawCluster = text.slice(m.index, lastEndWithoutNl);
        const fpWithPunct = sha1Hex8(rawCluster.trim());
        const fpNoPunct = sha1Hex8(rawCluster.replace(/[,， \t]+$/, '').trim());
        const matchedFp = Boolean(
            receiptFingerprints
            && (receiptFingerprints.has(fpWithPunct) || receiptFingerprints.has(fpNoPunct))
        );

        if (matchedFp || (hasExternalReceiptCode && hasUnreconciledReceipt)) {
            ranges.push({ start: m.index, end: lastEndWithNl });
        }
        searchCursor = Math.max(m.index + m[0].length, lastEndWithNl);
    }

    return ranges.length > 0 ? removeRanges(text, ranges) : text;
}

/** Extract actual protocol blocks without interpreting marker-looking code or result payloads. */
export function extractDiaryText(text, diaries, warnings) {
    const source = stripThoughtChains(text);
    const { hasReceipt, fingerprints, codes: receiptCodes } = collectReceiptAnalysis(source);
    const anyClosedMatchedFp = computeAnyClosedMatchedFp(source, fingerprints);
    const events = [];
    const rejectedEvents = [];
    const requests = [];
    replaceToolRequestBlocks(source, (raw, body, start, end) => {
        requests.push({ start, end });
        const name = readToolRequestField(body, 'tool_name')
            || body.match(/<tool_name>([\s\S]*?)<\/tool_name>/i)?.[1];
        if (name?.trim().toLowerCase() === 'dailynote') {
            const rejectedByReceipt = fingerprints.has(sha1Hex8(raw.trim()))
                || (hasReceipt && !(fingerprints.size > 0 && anyClosedMatchedFp) && isBrokenToolRequestBody(raw, receiptCodes));
            if (rejectedByReceipt) {
                rejectedEvents.push({ start, end, raw });
            } else {
                const fields = readDiaryFields(body);
                const command = (readToolRequestField(body, 'command') || '').toLowerCase();
                events.push({
                    start, end, raw, fields,
                    command: command === 'update' || (!command && fields.target !== null && fields.replace !== null) ? 'update' : 'create',
                });
            }
        }
        return raw;
    }, { allowFuzzyStart: true, stopAtProtocolWalls: true });

    const results = collectToolResultRanges(source);
    const codes = collectCodeDomainsOutsideToolResults(source, results)
        .filter(range => range.kind === 'fence' || !source.slice(range.start, range.end).includes('\n'));
    const blocked = [...results, ...codes, ...requests];
    const legacyStart = '<<<DailyNoteStart>>>';
    const legacyEnd = '<<<DailyNoteEnd>>>';
    let cursor = 0;
    while ((cursor = source.indexOf(legacyStart, cursor)) !== -1) {
        const start = cursor;
        cursor += legacyStart.length;
        if (blocked.some(range => start >= range.start && start < range.end)) continue;
        const close = source.indexOf(legacyEnd, cursor);
        const end = close === -1 ? source.length : close + legacyEnd.length;
        const body = source.slice(cursor, close === -1 ? source.length : close);
        const contentMarker = /(?:^|\n)Content:[ \t]*/i.exec(body);
        const metadata = key => body.match(new RegExp(`(?:^|\\n)${key}:[ \\t]*([^\\r\\n]*)`, 'i'))?.[1]?.trim() || '';
        events.push({
            start, end, raw: source.slice(start, end), command: 'create',
            fields: {
                content: contentMarker && close !== -1 ? body.slice(contentMarker.index + contentMarker[0].length) : null,
                agent: metadata('Maid') || metadata('Valet'), date: metadata('Date'),
                fileName: metadata('fileName'), folder: metadata('folder'), tag: '',
            },
        });
        cursor = end;
    }

    const unclosedRe = /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
    let unclosedScanCursor = 0;
    let um;
    while (unclosedScanCursor < source.length) {
        unclosedRe.lastIndex = unclosedScanCursor;
        um = unclosedRe.exec(source);
        if (!um) break;
        const start = um.index;
        const markerEnd = start + um[0].length;
        if (blocked.some(range => start >= range.start && start < range.end)) {
            const containing = blocked.find(range => start >= range.start && start < range.end);
            unclosedScanCursor = Math.max(markerEnd, containing.end);
            continue;
        }
        const boundaryEnd = findUnclosedToolBoundary(source, markerEnd, [...results, ...codes]);
        const rawUnclosed = source.slice(start, boundaryEnd);
        const unclosedBody = rawUnclosed.slice(um[0].length);
        const unclosedName = readToolRequestField(unclosedBody, 'tool_name')
            || unclosedBody.match(/<tool_name>([\s\S]*?)<\/tool_name>/i)?.[1];
        if (unclosedName?.trim().toLowerCase() === 'dailynote') {
            const rejectedByReceipt = fingerprints.has(sha1Hex8(rawUnclosed.trim()))
                || (hasReceipt && !(fingerprints.size > 0 && anyClosedMatchedFp));
            if (rejectedByReceipt) {
                rejectedEvents.push({ start, end: boundaryEnd, raw: rawUnclosed });
            } else {
                events.push({
                    start, end: boundaryEnd, raw: rawUnclosed,
                    command: 'create', fields: { content: null },
                });
            }
            unclosedScanCursor = boundaryEnd;
        } else {
            unclosedScanCursor = markerEnd;
        }
    }

    events.sort((a, b) => a.start - b.start);
    for (const event of events) applyDiaryEvent(event, diaries, warnings);

    // DailyNote receipts are excluded too; never treat nested marker text as a new invocation.
    const receipts = results.filter(range => {
        const raw = source.slice(range.start, range.end);
        return isToolResultHidden(raw)
            || /^[ \t]*-[ \t]*(?:工具名称|tool_name):[ \t]*DailyNote[ \t]*\r?$/im.test(raw);
    });
    return stripCompactionResilienceMarkers(removeRanges(source, [...events, ...rejectedEvents, ...receipts]));
}

/**
 * 剥除上下文压缩待处理文本中的协议自愈纠偏回执、关联坏块、空错误信封、摘要报错项、置空占位符与常驻药丸
 * 防止智能压缩模型把协议纠偏说明与药丸写进上下文 Checkpoint 摘要，并保护正常工具结果与代码围栏
 */
export function stripCompactionResilienceMarkers(text) {
    if (typeof text !== 'string' || !text) return text;
    const { hasReceipt, fingerprints: receiptFingerprints, codes: receiptCodes } = collectReceiptAnalysis(text);
    const anyClosedMatchedFp = computeAnyClosedMatchedFp(text, receiptFingerprints);
    const isBrokenClosedBlock = (block) => {
        if (!hasReceipt) return false;
        if (receiptFingerprints.size > 0) {
            if (receiptFingerprints.has(sha1Hex8(block.trim()))) return true;
            if (anyClosedMatchedFp) return false;
        }
        return isBrokenToolRequestBody(block, receiptCodes);
    };

    const { text: masked, masks } = maskProtectedRegions(text, {
        skipTopLevelEscape: true,
        shouldMaskInfoBlock: (block) => !isGuidanceErrorInfoBlock(block),
        shouldMaskToolBlock: (block) => !isBrokenClosedBlock(block)
    });

    let result = masked;
    if (hasReceipt) {
        const matchedFps = new Set();
        const brokenClosedRanges = findClosedFenceAndToolRanges(result)
            .filter(r => r.kind === 'tool' && isBrokenClosedBlock(result.slice(r.start, r.end)));
        if (brokenClosedRanges.length > 0) {
            let out = '';
            let cur = 0;
            for (const r of brokenClosedRanges) {
                matchedFps.add(sha1Hex8(result.slice(r.start, r.end).trim()));
                out += result.slice(cur, r.start);
                cur = r.end;
            }
            out += result.slice(cur);
            result = out;
        }

        // 同步清除外部协议坏块（Category V）：仅在指纹命中或回执包含外部协议/类别V错误码且无已对账VCP闭块时清除
        const hasExternalReceiptCode = [...receiptCodes].some(c =>
            /^(?:EXTERNAL_.*|CATEGORY_V.*|MALFORMED_BLOCK_SYNTAX)$/i.test(c)
        );
        const extClosedRe = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>|<function_call\b[^>]*>[\s\S]*?<\/function_call>|\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]|\[FUNCTION_CALL\][\s\S]*?\[\/FUNCTION_CALL\]/gi;
        const extMatches = [];
        let em;
        while ((em = extClosedRe.exec(result)) !== null) {
            if (isInsideInlineBacktick(result, em.index, em[0].length)) continue;
            const fp = sha1Hex8(em[0].trim());
            const matchedFp = receiptFingerprints.has(fp);
            if (matchedFp) matchedFps.add(fp);
            extMatches.push({
                start: em.index,
                end: em.index + em[0].length,
                matchedFp,
            });
        }
        const anyExtMatchedFp = extMatches.some(item => item.matchedFp);
        if (extMatches.length > 0) {
            const toRemove = extMatches.filter(item =>
                item.matchedFp || (hasExternalReceiptCode && !anyClosedMatchedFp)
            );
            if (toRemove.length > 0) {
                result = removeRanges(result, toRemove);
            }
        }
        if ((hasExternalReceiptCode || anyExtMatchedFp) && !anyClosedMatchedFp) {
            result = stripBoundedMarkerBlocks(
                result,
                /<tool_call\b[^>]*>|<function_call\b[^>]*>|\[TOOL_CALL\]|\[FUNCTION_CALL\]/gi,
                { requireLineLeading: true }
            );
        }

        const hasUnreconciledReceipt = receiptFingerprints.size === 0
            || [...receiptFingerprints].some(fp => !matchedFps.has(fp));
        result = stripCategoryVBareFieldClusters(result, {
            receiptFingerprints,
            hasExternalReceiptCode,
            hasUnreconciledReceipt,
        });

        // 线性界定清除未闭合 VCP TOOL_REQUEST 坏块（仅当存在未对账回执或明确未闭合错误码，且仅清除行首非反引号起始块）
        const hasUnclosedReceiptCode = [...receiptCodes].some(c =>
            /^(?:UNCLOSED_.*|MISSING_END_MARKER)$/i.test(c)
        );
        if ((!anyClosedMatchedFp && !anyExtMatchedFp) || hasUnclosedReceiptCode) {
            result = stripBoundedMarkerBlocks(result, /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi, {
                requireLineLeading: true,
                allowInlineIfFollowedByField: true,
            });
        }
    }

    result = stripResilienceNoiseFromMasked(result);
    result = unmaskProtectedRegions(result, masks);
    return result.replace(/\n{3,}/g, '\n\n');
}

function transformContent(content, transform) {
    if (typeof content === 'string') return transform(content);
    if (Array.isArray(content)) return content.map(part =>
        part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: transform(part.text) } : part);
    if (content && typeof content.text === 'string') return { ...content, text: transform(content.text) };
    return content;
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
        const copy = { role: message.role, content: transformContent(message.content, text => extractDiaryText(text, diaries, warnings)) };
        for (const key of ['name', 'tool_calls', 'tool_call_id', 'attachments']) {
            if (message[key] !== undefined) copy[key] = message[key];
        }
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
    const failure = checkpointFailure(value);
    if (failure) throw new Error(failure);
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