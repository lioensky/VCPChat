'use strict';

const crypto = require('crypto');
const vcpResilienceMask = require('../../modules/shared/vcpResilienceMask');

// Memory-only projection: never write the projected text back to history/CDS.
const REQUEST = '<<<[TOOL_REQUEST]>>>';
const RESULT = '[[VCP调用结果信息汇总:';
const RESULT_END = 'VCP调用结果结束]]';
const SUMMARY = '[本轮工具调用摘要:]';
const SUMMARY_END = '[本轮工具调用摘要结束]';

function sha1Hex8(str) {
    return crypto.createHash('sha1').update(String(str || '').trim()).digest('hex').slice(0, 8);
}

function collectReceiptAnalysis(text) {
    const fingerprints = new Set();
    const codes = new Set();
    let hasReceipt = false;
    if (typeof text !== 'string' || !text.includes('[[VCP协议纠偏指导:')) {
        return { hasReceipt, fingerprints, codes };
    }
    const collectFrom = (chunk) => {
        const fpRe = /\[\[VCP协议纠偏指导:[^\]]*\bblock=([0-9a-f]{8})\b/gi;
        let m;
        while ((m = fpRe.exec(chunk)) !== null) {
            fingerprints.add(m[1].toLowerCase());
        }
        const codeRe = /\[\[VCP协议纠偏指导:[^\]]*\bcode=([A-Z0-9_]+)\b/gi;
        let cm;
        while ((cm = codeRe.exec(chunk)) !== null) {
            codes.add(cm[1].toUpperCase());
        }
    };

    const infoRanges = vcpResilienceMask.findNestedVcpInfoRanges(text);
    for (const r of infoRanges) {
        const block = text.slice(r.start, r.end);
        if (vcpResilienceMask.isGuidanceErrorInfoBlock(block)) {
            hasReceipt = true;
            collectFrom(block);
        }
    }

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

function mergeReceiptAnalysis(base, local) {
    if (!base) return local;
    if (!local || !local.hasReceipt) return base;
    if (!base.hasReceipt) return local;
    return {
        hasReceipt: true,
        fingerprints: new Set([...base.fingerprints, ...local.fingerprints]),
        codes: new Set([...base.codes, ...local.codes]),
    };
}

function resultEnd(text, start) {
    let depth = 1;
    let cursor = start + RESULT.length;
    while (cursor < text.length) {
        const open = text.indexOf(RESULT, cursor);
        const close = text.indexOf(RESULT_END, cursor);
        if (close < 0) return -1;
        if (open >= 0 && open < close) {
            depth++;
            cursor = open + RESULT.length;
        } else {
            cursor = close + RESULT_END.length;
            if (--depth === 0) return cursor;
        }
    }
    return -1;
}

const FIELD_WALL_LINE_RE = /^[ \t]*(<<<\[(?:END_)?ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>|<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:)/gim;
const FIELD_RECEIPT_WALL_RE = /^[ \t]*(?:<<<\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|ASSISTANT|USER)\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:)/im;
const FIELD_DECL_AFTER_TOOL_RE = /^[ \t]*\r?\n?[ \t]*(?:(?:tool_name|maid|maidname|valet|valetname|command|jev|archery)\s*[:：]|[^\s,:：「」{}<>()[\]]+\s*[:：]\s*(?:「始(?:escape)?」|\{始(?:escape)?\})|<tool_name>)/i;

function hasBalancedToolBatchMarkers(slice) {
    const hasStart = slice.includes('<<<[VCP_TOOL_BATCH_START:');
    const hasEnd = slice.includes('<<<[VCP_TOOL_BATCH_END:');
    if (!hasStart && !hasEnd) return true;
    const startRe = /<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/g;
    const endRe = /<<<\[VCP_TOOL_BATCH_END:([^\]\r\n]+)\]>>>/g;
    const events = [];
    let startCount = 0;
    let endCount = 0;
    let m;
    while ((m = startRe.exec(slice)) !== null) {
        startCount += 1;
        events.push({ idx: m.index, type: 'start', id: m[1] });
    }
    while ((m = endRe.exec(slice)) !== null) {
        endCount += 1;
        events.push({ idx: m.index, type: 'end', id: m[1] });
    }
    if (startCount !== (slice.match(/<<<\[VCP_TOOL_BATCH_START:/g) || []).length) return false;
    if (endCount !== (slice.match(/<<<\[VCP_TOOL_BATCH_END:/g) || []).length) return false;
    events.sort((a, b) => a.idx - b.idx);
    const stack = [];
    for (const ev of events) {
        if (ev.type === 'start') {
            stack.push(ev.id);
        } else {
            if (stack.length === 0 || stack[stack.length - 1] !== ev.id) return false;
            stack.pop();
        }
    }
    return stack.length === 0;
}

function hasBalancedDelimiterPair(slice, openRe, closeRe) {
    const events = [];
    let m;
    openRe.lastIndex = 0;
    while ((m = openRe.exec(slice)) !== null) events.push({ idx: m.index, delta: 1 });
    closeRe.lastIndex = 0;
    while ((m = closeRe.exec(slice)) !== null) events.push({ idx: m.index, delta: -1 });
    if (events.length === 0) return true;
    events.sort((a, b) => a.idx - b.idx);
    let depth = 0;
    for (const ev of events) {
        depth += ev.delta;
        if (depth < 0) return false;
    }
    return depth === 0;
}

function isPureRoleExampleInner(inner) {
    if (
        inner.includes('<<<[VCP_TOOL_BATCH_START:')
        || inner.includes('[[VCP调用结果信息汇总:')
        || inner.includes('[[VCP协议纠偏指导:')
        || /[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/i.test(inner)
    ) {
        return false;
    }
    for (const role of ['USER', 'SYSTEM', 'ASSISTANT']) {
        if (!hasBalancedDelimiterPair(
            inner,
            new RegExp(`<<<\\[ROLE_DIVIDE_${role}\\]>>>`, 'g'),
            new RegExp(`<<<\\[END_ROLE_DIVIDE_${role}\\]>>>`, 'g')
        )) {
            return false;
        }
    }
    return hasBalancedDelimiterPair(
        inner,
        /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi,
        /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi
    );
}

function findUnclosedProtocolWall(text, fromIndex) {
    const wallRe = /<<<\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|ASSISTANT|USER)\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>|<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}|\[\[VCP调用结果信息汇总:/gi;
    wallRe.lastIndex = Math.max(0, fromIndex);
    const m = wallRe.exec(text);
    return m ? { index: m.index, marker: m[0] } : null;
}

function findLineLeadingFieldProtocolWall(text, fromIndex, valEndIndex = -1) {
    const limit = valEndIndex !== -1 ? valEndIndex : text.length;
    const closedFenceRanges = valEndIndex !== -1
        ? vcpResilienceMask.findSafeClosedFenceRanges(text, fromIndex, limit)
        : [];
    let cursor = Math.max(0, fromIndex);
    while (cursor < limit) {
        FIELD_WALL_LINE_RE.lastIndex = cursor;
        const m = FIELD_WALL_LINE_RE.exec(text);
        FIELD_WALL_LINE_RE.lastIndex = 0;
        if (!m) return null;

        const marker = m[1];
        const roleName = m[2];
        const markerIndex = m.index + m[0].indexOf(marker);
        if (markerIndex >= limit) return null;

        const containingFence = closedFenceRanges.find(f => markerIndex >= f.start && markerIndex < f.end);
        if (containingFence) {
            cursor = containingFence.nextPos;
            continue;
        }

        if (roleName) {
            const upperRole = roleName.toUpperCase();
            if (!/^<<<\[END_/i.test(marker) && valEndIndex !== -1) {
                const startTag = `<<<[ROLE_DIVIDE_${upperRole}]>>>`;
                const endTag = `<<<[END_ROLE_DIVIDE_${upperRole}]>>>`;
                const afterStart = markerIndex + marker.length;
                const firstEnd = text.indexOf(endTag, afterStart);
                const nextStart = text.indexOf(startTag, afterStart);
                if (
                    firstEnd !== -1
                    && firstEnd + endTag.length <= valEndIndex
                    && (nextStart === -1 || firstEnd < nextStart)
                    && isPureRoleExampleInner(text.slice(afterStart, firstEnd))
                ) {
                    cursor = firstEnd + endTag.length;
                    continue;
                }
            }
            return { index: markerIndex, marker };
        }

        if (/^<{2,4}\[TOOL_REQUEST/i.test(marker) && valEndIndex !== -1) {
            const innerEndRe = /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/ig;
            innerEndRe.lastIndex = markerIndex + marker.length;
            const innerEnd = innerEndRe.exec(text);
            if (
                innerEnd
                && innerEnd.index + innerEnd[0].length <= valEndIndex
                && !FIELD_RECEIPT_WALL_RE.test(text.slice(markerIndex, innerEnd.index))
            ) {
                cursor = innerEnd.index + innerEnd[0].length;
                continue;
            }
            if (!FIELD_DECL_AFTER_TOOL_RE.test(text.slice(markerIndex + marker.length, valEndIndex))) {
                cursor = markerIndex + marker.length;
                continue;
            }
        }
        if (/^<<<\[VCP_TOOL_BATCH_START:/i.test(marker) && valEndIndex !== -1) {
            const headerMatch = /^<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/.exec(text.slice(markerIndex));
            if (headerMatch) {
                const endToken = `<<<[VCP_TOOL_BATCH_END:${headerMatch[1]}]>>>`;
                const batchEndAt = text.indexOf(endToken, markerIndex + headerMatch[0].length);
                const batchCloseEnd = batchEndAt !== -1 ? batchEndAt + endToken.length : -1;
                if (batchCloseEnd !== -1 && batchCloseEnd <= valEndIndex) {
                    const batchSlice = text.slice(markerIndex, batchCloseEnd);
                    if (
                        !batchSlice.includes('[[VCP协议纠偏指导:')
                        && hasBalancedToolBatchMarkers(batchSlice)
                        && isPureRoleExampleInner(
                            batchSlice
                                .replace(/<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>/g, '')
                                .replace(/\[\[VCP调用结果信息汇总:|VCP调用结果结束\]\]/g, '')
                        )
                    ) {
                        cursor = batchCloseEnd;
                        continue;
                    }
                }
            }
        }
        if (marker === RESULT && valEndIndex !== -1) {
            const sliceToFieldEnd = text.slice(markerIndex, valEndIndex);
            const hasReceiptStructure = sliceToFieldEnd.includes(RESULT_END)
                || sliceToFieldEnd.includes('[[VCP协议纠偏指导:')
                || /^[ \t]*-[ \t]*(?:工具名称|执行状态)[:：]/m.test(sliceToFieldEnd);
            if (!hasReceiptStructure) {
                cursor = markerIndex + marker.length;
                continue;
            }
            let sPos = markerIndex + RESULT.length;
            let sDepth = 1;
            let closedEnd = -1;
            while (sPos < valEndIndex && sDepth > 0) {
                const nextOpen = text.indexOf(RESULT, sPos);
                const nextClose = text.indexOf(RESULT_END, sPos);
                if (nextClose === -1 || nextClose + RESULT_END.length > valEndIndex) break;
                if (nextOpen !== -1 && nextOpen < nextClose) {
                    sDepth += 1;
                    sPos = nextOpen + RESULT.length;
                } else {
                    sDepth -= 1;
                    sPos = nextClose + RESULT_END.length;
                    if (sDepth === 0) closedEnd = sPos;
                }
            }
            if (closedEnd !== -1 && isPureRoleExampleInner(text.slice(markerIndex, closedEnd).replaceAll(RESULT, ''))) {
                cursor = closedEnd;
                continue;
            }
        }
        return { index: markerIndex, marker };
    }
    return null;
}

const DUPLICATE_CONTROL_KEYS = new Set(['tool_name', 'jev', 'maid', 'valet']);

function requestInfo(text, start, openLen = REQUEST.length) {
    const fields = new Map();
    let hasDuplicateControlKey = false;
    let cursor = start + openLen;
    const xmlName = text.slice(cursor).match(/^\s*<tool_name>([^<\r\n]+)<\/tool_name>/i);
    if (xmlName) fields.set('tool_name', xmlName[1].trim());
    while (cursor < text.length) {
        const end = /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/ig;
        end.lastIndex = cursor;
        const close = end.exec(text);
        const wall = findUnclosedProtocolWall(text, cursor);
        const field = /(?:^|\n|,)[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/ig;
        field.lastIndex = cursor;
        let next = field.exec(text);
        const immediate = text.slice(cursor).match(/^[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/i);
        if (immediate) next = { ...immediate, index: cursor };

        if (wall && (!close || wall.index < close.index) && (!next || wall.index < next.index)) {
            return { end: wall.index, fields, closed: false, hasUnclosedField: false, hasDuplicateControlKey };
        }
        if (close && (!next || close.index < next.index)) {
            return { end: close.index + close[0].length, fields, closed: true, hasUnclosedField: false, hasDuplicateControlKey };
        }
        if (!next) return { end: wall ? wall.index : text.length, fields, closed: false, hasUnclosedField: false, hasDuplicateControlKey };
        const marker = next[2];
        const valueStart = next.index + next[0].length;
        const usesBrace = marker[0] === '{';
        const isEsc = /escape/i.test(marker);
        const endRe = new RegExp(
            `${usesBrace ? '\\{' : '「'}末${isEsc ? 'ESCAPE' : ''}${usesBrace ? '\\}' : '」'}`,
            'ig'
        );
        endRe.lastIndex = valueStart;
        const valEndMatch = endRe.exec(text);
        const fieldWall = findLineLeadingFieldProtocolWall(text, valueStart, valEndMatch ? valEndMatch.index : -1);
        if (!valEndMatch) {
            if (isEsc) {
                return { end: fieldWall ? fieldWall.index : text.length, fields, closed: false, hasUnclosedField: true, hasDuplicateControlKey };
            }
            if (close && (!fieldWall || close.index < fieldWall.index)) {
                return { end: close.index + close[0].length, fields, closed: true, hasUnclosedField: true, hasDuplicateControlKey };
            }
            return { end: fieldWall ? fieldWall.index : text.length, fields, closed: false, hasUnclosedField: true, hasDuplicateControlKey };
        }
        if (!isEsc && fieldWall && fieldWall.index < valEndMatch.index && (!close || fieldWall.index < close.index)) {
            return { end: fieldWall.index, fields, closed: false, hasUnclosedField: true, hasDuplicateControlKey };
        }
        const key = next[1].toLowerCase();
        const val = text.slice(valueStart, valEndMatch.index).trim();
        if (DUPLICATE_CONTROL_KEYS.has(key) && fields.has(key) && fields.get(key) !== val) {
            hasDuplicateControlKey = true;
        }
        fields.set(key, val);
        cursor = valEndMatch.index + valEndMatch[0].length;
    }
    return { end: text.length, fields, closed: false, hasUnclosedField: false, hasDuplicateControlKey };
}

function projectSummaryBody(rawSummary) {
    if (typeof rawSummary !== 'string' || !rawSummary.trim()) return '';
    const items = rawSummary
        .split(/[；;\r\n]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .filter(item => (
            !/(?:格式错误|执行失败)（未执行）/.test(item)
            && !/^[。.,，\s]+$/.test(item)
        ));
    if (items.length === 0) return '';
    const useNewline = items.every(item => /^-\s/.test(item));
    return items.join(useNewline ? '\n' : '；');
}

function safeName(value) {
    return String(value || '').replace(/[<>\r\n「」{}[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function requestLabel(fields) {
    let name = fields.get('tool_name');
    if (!name && fields.has('jev')) {
        const jev = fields.get('jev');
        name = jev.match(/`([^`]+)`|'([^']+)'/)?.slice(1).find(Boolean);
    }
    return name ? `调用了 ${safeName(name)} 工具。` : '调用了工具（名称未记录）。';
}

function shouldSkipBrokenRequest(rawBlock, request, receipt) {
    if (!receipt || !receipt.hasReceipt) return false;
    if (receipt.fingerprints.has(sha1Hex8(rawBlock))) return true;
    if (!request.closed || request.hasUnclosedField) return true;
    const hasTarget = request.fields.has('tool_name') || request.fields.has('jev');
    if (!hasTarget) return true;
    if (receipt.codes.has('MISSING_MAID')) {
        const hasMaid = request.fields.has('maid')
            || request.fields.has('maidname')
            || request.fields.has('valet')
            || request.fields.has('valetname');
        if (!hasMaid) return true;
    }
    if (receipt.codes.has('DUPLICATE_KEY_CONFLICT') && request.hasDuplicateControlKey) {
        return true;
    }
    return false;
}

function projectMemoryProtocolsInternal(input, inheritedReceipt = null) {
    if (typeof input !== 'string') return '';
    if (!inheritedReceipt) {
        input = input.replace(
            /(?:\x26lt;|\x26#0*60;|\x26#x0*3c;){2,4}\[(?:(?:END_)?TOOL_REQUEST(?:_ESCAPE)?|(?:END_)?ROLE_DIVIDE_(?:SYSTEM|ASSISTANT|USER)|VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+)\](?:\x26gt;|\x26#0*62;|\x26#x0*3e;){2,4}/gi,
            marker => marker.replace(/\x26lt;|\x26#0*60;|\x26#x0*3c;/gi, '<').replace(/\x26gt;|\x26#0*62;|\x26#x0*3e;/gi, '>')
        );
        input = vcpResilienceMask.stripThoughtChains(input);
    }
    const receipt = mergeReceiptAnalysis(inheritedReceipt, collectReceiptAnalysis(input));
    let output = '';
    let cursor = 0;
    // Scan in source order: a result/request owns its entire payload. Protocol
    // tokens inside that payload must never be interpreted as outer summaries.
    const tokens = /<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>|<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}|\[\[VCP调用结果信息汇总:|\[本轮工具调用摘要:\]/gi;
    while (cursor < input.length) {
        tokens.lastIndex = cursor;
        const match = tokens.exec(input);
        if (!match) {
            output += input.slice(cursor);
            break;
        }
        output += input.slice(cursor, match.index);
        if (match[1] !== undefined) {
            const endToken = `<<<[VCP_TOOL_BATCH_END:${match[1]}]>>>`;
            const end = input.indexOf(endToken, tokens.lastIndex);
            // Batch is a hard boundary even when old nested result markers are broken.
            const body = input.slice(tokens.lastIndex, end < 0 ? input.length : end);
            output += '\n' + projectMemoryProtocolsInternal(body, receipt) + '\n';
            cursor = end < 0 ? input.length : end + endToken.length;
        } else if (match[0] === RESULT) {
            cursor = resultEnd(input, match.index);
            if (cursor < 0) cursor = input.length;
            output += '\n';
        } else if (/^<{2,4}\[TOOL_REQUEST/i.test(match[0])) {
            const request = requestInfo(input, match.index, match[0].length);
            const rawBlock = input.slice(match.index, request.end);
            output += shouldSkipBrokenRequest(rawBlock, request, receipt)
                ? '\n'
                : `\n${requestLabel(request.fields)}\n`;
            cursor = request.end;
        } else {
            const end = input.indexOf(SUMMARY_END, tokens.lastIndex);
            const body = input.slice(tokens.lastIndex, end < 0 ? input.length : end);
            const summaryText = projectSummaryBody(projectMemoryProtocolsInternal(body, receipt));
            output += summaryText ? `\n工具调用摘要：${summaryText}\n` : '\n';
            cursor = end < 0 ? input.length : end + SUMMARY_END.length;
        }
    }
    return output
        .replace(/[ \t]*\[\[VCP协议纠偏指导:[\s\S]*?\[\[\/VCP协议纠偏指导\]\][ \t]*(?:\r?\n)?/g, '\n')
        .replace(/[ \t]*\[\[VCP协议纠偏指导:[^\r\n\]]+\]\][ \t]*(?:\r?\n)?/g, '\n')
        .replace(/[ \t]*\[\[VCP协议纠偏指导:[ \t]*(?:code=|[\r\n])[\s\S]*?(?=(?:\[\[VCP协议纠偏指导:)|(?:<<<\[(?:END_)?ROLE_DIVIDE)|(?:<<<\[VCP_TOOL_BATCH_)|(?:VCP调用结果结束\]\])|$)(?:\r?\n)?/g, '\n')
        .replace(/[ \t]*(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][\s\S]*?[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][ \t]*(?:\r?\n)?/gi, '\n')
        .replace(/<<<\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|ASSISTANT|USER)\]>>>/g, '\n')
        .replace(/<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>/g, '\n')
        .replace(/<{2,4}\[(?:END_)?TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi, '')
        .replaceAll(RESULT_END, '')
        .replaceAll(SUMMARY_END, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function projectMemoryProtocols(input) {
    return projectMemoryProtocolsInternal(input, null);
}

module.exports = { projectMemoryProtocols };