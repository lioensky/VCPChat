((root, factory) => {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.VCPProtocolResilienceMask = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
    const INFO_START = '[[VCP调用结果信息汇总:';
    const INFO_END = 'VCP调用结果结束]]';

    const LINE_MARKER_BLANK_RE = /^(?:[ \t\r]|<!--VCP_THOUGHT_CHAIN_\d+-->|<<<\[(?:END_)?ROLE_DIVIDE_[A-Z]+\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>)*$/;

    const TOOL_OPEN_SOURCE = '<{2,4}\\[TOOL_REQUEST(?:_ESCAPE)?\\]>{2,4}';
    const TOOL_END_SOURCE = '<{2,4}\\[END_TOOL_REQUEST(?:_ESCAPE)?\\]>{2,4}';
    const ROLE_WALL_SOURCE = '<<<\\[(?:END_)?ROLE_DIVIDE_[A-Z]+\\]>>>';

    function isBacktickWrapped(text, index, length) {
        return (index > 0 && text[index - 1] === '`')
            || (index + length < text.length && text[index + length] === '`');
    }

    function isLineLeadingBlank(text, index) {
        if (typeof text !== 'string' || index < 0 || index > text.length) return false;
        const lineStart = text.lastIndexOf('\n', index - 1) + 1;
        const prefix = text.slice(lineStart, index);
        return LINE_MARKER_BLANK_RE.test(prefix);
    }

    function isLineTrailingBlank(text, afterIndex) {
        if (typeof text !== 'string' || afterIndex < 0 || afterIndex > text.length) return false;
        const nl = text.indexOf('\n', afterIndex);
        const suffix = text.slice(afterIndex, nl === -1 ? text.length : nl);
        return LINE_MARKER_BLANK_RE.test(suffix);
    }

    function findNextLineLeadingInfoStart(text, from) {
        let idx = from;
        while (idx < text.length) {
            const pos = text.indexOf(INFO_START, idx);
            if (pos === -1) return -1;
            if (isLineLeadingBlank(text, pos)) return pos;
            idx = pos + INFO_START.length;
        }
        return -1;
    }

    function scanVcpInfoBlockEnd(text, start) {
        const findNextInnerStart = (from, constrainLineLeading) => (
            constrainLineLeading ? findNextLineLeadingInfoStart(text, from) : text.indexOf(INFO_START, from)
        );

        const findNextValidEnd = (from) => {
            let idx = from;
            while (idx <= text.length) {
                const pos = text.indexOf(INFO_END, idx);
                if (pos === -1) return -1;
                if (isLineTrailingBlank(text, pos + INFO_END.length)) {
                    return pos;
                }
                idx = pos + INFO_END.length;
            }
            return -1;
        };

        const scanWithConstraint = (constrainLineLeading) => {
            let depth = 1;
            let scan = start + INFO_START.length;
            while (scan <= text.length) {
                const nextEnd = findNextValidEnd(scan);
                if (nextEnd === -1) return -1;
                const nextStart = findNextInnerStart(scan, constrainLineLeading);
                if (nextStart !== -1 && nextStart < nextEnd) {
                    depth += 1;
                    scan = nextStart + INFO_START.length;
                    continue;
                }
                depth -= 1;
                scan = nextEnd + INFO_END.length;
                if (depth === 0) return scan;
            }
            return -1;
        };

        const looseEnd = scanWithConstraint(false);
        return looseEnd !== -1 ? looseEnd : scanWithConstraint(true);
    }

    function findNestedVcpInfoRanges(text) {
        const ranges = [];
        if (typeof text !== 'string' || !text.includes(INFO_START)) return ranges;

        let cursor = 0;
        while (cursor < text.length) {
            const start = findNextLineLeadingInfoStart(text, cursor);
            if (start === -1) break;
            const blockEnd = scanVcpInfoBlockEnd(text, start);
            if (blockEnd === -1) {
                cursor = start + INFO_START.length;
                continue;
            }
            ranges.push({ start, end: blockEnd });
            cursor = blockEnd;
        }
        return ranges;
    }

    function findNextExplicitFieldStart(text, fromIndex) {
        const atCursor = text.slice(fromIndex).match(
            /^[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/i
        );
        if (atCursor) {
            const marker = atCursor[2];
            const markerStart = fromIndex + atCursor[0].lastIndexOf(marker);
            return {
                declarationStart: fromIndex,
                markerStart,
                markerEnd: markerStart + marker.length,
                marker,
                usesBrace: marker[0] === '{',
                isEscape: /escape/i.test(marker),
            };
        }
        const fieldRe = /(^|\n|,)[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/gi;
        fieldRe.lastIndex = fromIndex;
        const m = fieldRe.exec(text);
        if (!m) return null;
        const marker = m[3];
        const markerStart = m.index + m[0].lastIndexOf(marker);
        return {
            declarationStart: m.index + m[1].length,
            markerStart,
            markerEnd: markerStart + marker.length,
            marker,
            usesBrace: marker[0] === '{',
            isEscape: /escape/i.test(marker),
        };
    }

    function execUnwrappedRegex(regex, text, fromIndex) {
        let pos = fromIndex;
        while (pos < text.length) {
            regex.lastIndex = pos;
            const m = regex.exec(text);
            if (!m) return null;
            if (!isBacktickWrapped(text, m.index, m[0].length)) {
                return m;
            }
            pos = m.index + m[0].length;
        }
        return null;
    }

    function hasGuidanceInMaskedText(chunk, masks) {
        if (typeof chunk !== 'string') return false;
        if (chunk.includes('[[VCP协议纠偏指导:')) return true;
        const maskTokenRe = /__VCP_MASK_[a-z0-9]{10,}_(\d+)__/g;
        let mm;
        while ((mm = maskTokenRe.exec(chunk)) !== null) {
            const idx = Number(mm[1]);
            const original = Array.isArray(masks) ? masks[idx]?.content : null;
            if (!original || original.includes('[[VCP协议纠偏指导:')) {
                return true;
            }
        }
        return false;
    }

    function hasCrossJumpEscapeReceipt(slice, usesBrace, masks = null) {
        if (typeof slice !== 'string') return false;
        const secondEscapeRe = usesBrace
            ? /(?:<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}|^|\n|,)[ \t]*[^\s,:：「」{}]+[ \t]*[:：][ \t]*\{始ESCAPE\}/i
            : /(?:<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}|^|\n|,)[ \t]*[^\s,:：「」{}]+[ \t]*[:：][ \t]*「始ESCAPE」/i;

        // 1. ROLE_DIVIDE_USER 包裹回执（支持完整结果块、单行极简指导回执或步骤1掩码占位符）
        if (slice.includes('<<<[ROLE_DIVIDE_USER]>>>') && slice.includes('<<<[END_ROLE_DIVIDE_USER]>>>')) {
            const envelopeRe = /<<<\[ROLE_DIVIDE_USER\]>>>([\s\S]*?)<<<\[END_ROLE_DIVIDE_USER\]>>>/g;
            let m;
            while ((m = envelopeRe.exec(slice)) !== null) {
                const body = m[1];
                if (
                    (body.includes(INFO_START) && body.includes(INFO_END))
                    || /__VCP_MASK_[a-z0-9]{10,}_\d+__/.test(body)
                    || /\[\[VCP协议纠偏指导:\s*code=[A-Z0-9_]+/i.test(body)
                ) {
                    if (secondEscapeRe.test(slice.slice(m.index + m[0].length))) {
                        return true;
                    }
                }
            }
        }

        // 2. 无 ROLE_DIVIDE_USER 外壳的闭合批次或裸纠偏汇总块（含掩码占位符）
        if (slice.includes('<<<[VCP_TOOL_BATCH_START:')) {
            const batchRe = /<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>([\s\S]*?)<<<\[VCP_TOOL_BATCH_END:[^\]\r\n]+\]>>>/g;
            let bm;
            while ((bm = batchRe.exec(slice)) !== null) {
                if (hasGuidanceInMaskedText(bm[1], masks) && secondEscapeRe.test(slice.slice(bm.index + bm[0].length))) {
                    return true;
                }
            }
        }

        if (slice.includes(INFO_START)) {
            const infoRe = /\[\[VCP调用结果信息汇总:([\s\S]*?)VCP调用结果结束\]\]/g;
            let im;
            while ((im = infoRe.exec(slice)) !== null) {
                if (im[1].includes('[[VCP协议纠偏指导:') && secondEscapeRe.test(slice.slice(im.index + im[0].length))) {
                    return true;
                }
            }
        }

        const maskTokenRe = /__VCP_MASK_[a-z0-9]{10,}_(\d+)__/g;
        let mm;
        while ((mm = maskTokenRe.exec(slice)) !== null) {
            const idx = Number(mm[1]);
            const original = Array.isArray(masks) ? masks[idx]?.content : null;
            if ((!original || original.includes('[[VCP协议纠偏指导:')) && secondEscapeRe.test(slice.slice(mm.index + mm[0].length))) {
                return true;
            }
        }

        return false;
    }

    function findNextLineLeadingToolStart(text, fromIndex, toolOpenRe) {
        let pos = fromIndex;
        while (pos < text.length) {
            const m = execUnwrappedRegex(toolOpenRe, text, pos);
            if (!m) return null;
            if (isLineLeadingBlank(text, m.index)) {
                return m;
            }
            pos = m.index + m[0].length;
        }
        return null;
    }

    function findNextClosedMarkdownFence(text, from) {
        if (typeof text !== 'string' || (!text.includes('```') && !text.includes('~~~'))) return null;
        const len = text.length;
        const fenceOpenRe = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/gm;
        let searchPos = from;
        while (searchPos < len) {
            fenceOpenRe.lastIndex = searchPos;
            const m = fenceOpenRe.exec(text);
            if (!m) return null;
            const fenceChar = m[1][0];
            const fenceLen = m[1].length;
            const info = m[2] || '';
            const openNl = text.indexOf('\n', m.index);
            if (fenceChar === '`' && info.includes('`')) {
                searchPos = openNl === -1 ? len : openNl + 1;
                continue;
            }
            let scanPos = openNl === -1 ? len : openNl + 1;
            let closeEnd = -1;
            while (scanPos < len) {
                const cNl = text.indexOf('\n', scanPos);
                const cLineEnd = cNl === -1 ? len : cNl;
                const cRaw = text.slice(scanPos, cLineEnd);
                const cLine = cRaw.endsWith('\r') ? cRaw.slice(0, -1) : cRaw;
                const closeMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(cLine);
                if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
                    closeEnd = cLineEnd;
                    break;
                }
                if (cNl === -1) break;
                scanPos = cNl + 1;
            }
            if (closeEnd !== -1) {
                const afterCloseNl = text.indexOf('\n', closeEnd);
                const closeLineStart = text.lastIndexOf('\n', closeEnd - 1) + 1;
                return {
                    start: m.index,
                    end: closeEnd,
                    nextPos: afterCloseNl === -1 ? len : afterCloseNl + 1,
                    closeLineStart,
                    ch: fenceChar,
                    len: fenceLen,
                };
            }
            searchPos = openNl === -1 ? len : openNl + 1;
        }
        return null;
    }

    const ROLE_WALL_LINE_RE = /^[ \t]*(<<<\[(?:END_)?ROLE_DIVIDE_([A-Z]+)\]>>>)/gm;
    const FIELD_DECL_AFTER_TOOL_RE = /^[ \t]*\r?\n?[ \t]*(?:(?:tool_name|maid|maidname|valet|valetname|command|jev|archery)\s*[:：]|[^\s,:：「」{}<>()[\]]+\s*[:：]\s*(?:「始(?:escape)?」|\{始(?:escape)?\})|<tool_name>)/i;
    const RECEIPT_OR_ROLE_WALL_LINE_RE = /^[ \t]*(?:<<<\[(?:END_)?ROLE_DIVIDE_[A-Z]+\]>>>|<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:)/gm;
    const MASK_TOKEN_RE = /__VCP_MASK_[a-z0-9]{10,}_(\d+)__/g;

    function hasBalancedSummaryBlocks(text) {
        let pos = 0;
        let depth = 0;
        while (pos < text.length) {
            const nextOpen = text.indexOf(INFO_START, pos);
            const nextClose = text.indexOf(INFO_END, pos);
            if (nextOpen === -1 && nextClose === -1) break;
            if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
                depth += 1;
                pos = nextOpen + INFO_START.length;
            } else {
                if (depth <= 0) return false;
                depth -= 1;
                pos = nextClose + INFO_END.length;
            }
        }
        return depth === 0;
    }

    function hasBalancedRoleAndToolMarkers(slice) {
        for (const role of ['USER', 'SYSTEM', 'ASSISTANT']) {
            if (!hasBalancedMarkers(
                slice,
                new RegExp(`<<<\\[ROLE_DIVIDE_${role}\\]>>>`, 'g'),
                new RegExp(`<<<\\[END_ROLE_DIVIDE_${role}\\]>>>`, 'g')
            )) {
                return false;
            }
        }
        return hasBalancedMarkers(
            slice,
            new RegExp(TOOL_OPEN_SOURCE, 'gi'),
            new RegExp(TOOL_END_SOURCE, 'gi')
        );
    }

    function hasUnbalancedInnerFence(inner, outerChar = '`') {
        const fenceCh = outerChar === '~' ? '~' : '`';
        let openLen = 0;
        let lineStart = 0;
        while (lineStart < inner.length) {
            const nl = inner.indexOf('\n', lineStart);
            const lineEnd = nl === -1 ? inner.length : nl;
            const rawLine = inner.slice(lineStart, lineEnd);
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (openLen > 0) {
                const closeMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
                if (closeMatch && closeMatch[1][0] === fenceCh && closeMatch[1].length >= openLen) {
                    openLen = 0;
                }
            } else {
                const openMatch = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
                if (openMatch && openMatch[1][0] === fenceCh && (fenceCh !== '`' || !openMatch[2].includes('`'))) {
                    openLen = openMatch[1].length;
                }
            }
            if (nl === -1) break;
            lineStart = nl + 1;
        }
        return openLen > 0;
    }

    function hasBalancedToolBatchMarkers(text) {
        const hasStart = text.includes('<<<[VCP_TOOL_BATCH_START:');
        const hasEnd = text.includes('<<<[VCP_TOOL_BATCH_END:');
        if (!hasStart && !hasEnd) return true;
        const startRe = /<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/g;
        const endRe = /<<<\[VCP_TOOL_BATCH_END:([^\]\r\n]+)\]>>>/g;
        const events = [];
        let startCount = 0;
        let endCount = 0;
        let m;
        while ((m = startRe.exec(text)) !== null) {
            startCount += 1;
            events.push({ idx: m.index, type: 'start', id: m[1] });
        }
        while ((m = endRe.exec(text)) !== null) {
            endCount += 1;
            events.push({ idx: m.index, type: 'end', id: m[1] });
        }
        if (startCount !== (text.match(/<<<\[VCP_TOOL_BATCH_START:/g) || []).length) return false;
        if (endCount !== (text.match(/<<<\[VCP_TOOL_BATCH_END:/g) || []).length) return false;
        events.sort((a, b) => a.idx - b.idx);
        const stack = [];
        for (const ev of events) {
            if (ev.type === 'start') {
                stack.push(ev.id);
            } else {
                if (stack.length === 0 || stack[stack.length - 1] !== ev.id) {
                    return false;
                }
                stack.pop();
            }
        }
        return stack.length === 0;
    }

    function isSafeClosedFenceText(fenceText, masks = null) {
        let expanded = fenceText;
        if (/__VCP_MASK_[a-z0-9]{10,}_\d+__/.test(fenceText)) {
            if (!Array.isArray(masks)) return false;
            let missing = false;
            expanded = fenceText.replace(MASK_TOKEN_RE, (_m, idxText) => {
                const original = masks[Number(idxText)]?.content;
                if (typeof original !== 'string') {
                    missing = true;
                    return '';
                }
                return original;
            });
            if (missing) return false;
        }
        if (expanded.includes('[[VCP协议纠偏指导:')) {
            return false;
        }
        if (!hasBalancedToolBatchMarkers(expanded)) {
            return false;
        }
        if (!expanded.includes(INFO_START) && !expanded.includes('<<<[VCP_TOOL_BATCH_START:')) {
            return true;
        }
        return hasBalancedSummaryBlocks(expanded) && hasBalancedRoleAndToolMarkers(expanded);
    }

    function findNextLineLeadingRoleWall(text, fromIndex, limit = text.length) {
        let pos = fromIndex;
        while (pos < limit) {
            ROLE_WALL_LINE_RE.lastIndex = pos;
            const m = ROLE_WALL_LINE_RE.exec(text);
            ROLE_WALL_LINE_RE.lastIndex = 0;
            if (!m) return null;
            const markerAt = m.index + m[0].indexOf(m[1]);
            if (markerAt >= limit) return null;
            if (!isBacktickWrapped(text, markerAt, m[1].length)) {
                return { index: markerAt, marker: m[1], roleName: m[2] };
            }
            pos = markerAt + m[1].length;
        }
        return null;
    }

    function hasBalancedMarkers(slice, openRe, closeRe) {
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

    function isPureRoleExampleInField(inner, activeRole) {
        if (
            inner.includes('<<<[VCP_TOOL_BATCH_START:')
            || inner.includes(INFO_START)
            || inner.includes('[[VCP协议纠偏指导:')
            || /__VCP_MASK_[a-z0-9]{10,}_\d+__/.test(inner)
            || /[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/i.test(inner)
        ) {
            return false;
        }
        const roles = new Set(['USER', 'SYSTEM', 'ASSISTANT']);
        if (activeRole) roles.add(activeRole);
        for (const role of roles) {
            if (!hasBalancedMarkers(
                inner,
                new RegExp(`<<<\\[ROLE_DIVIDE_${role}\\]>>>`, 'g'),
                new RegExp(`<<<\\[END_ROLE_DIVIDE_${role}\\]>>>`, 'g')
            )) {
                return false;
            }
        }
        return hasBalancedMarkers(
            inner,
            new RegExp(TOOL_OPEN_SOURCE, 'gi'),
            new RegExp(TOOL_END_SOURCE, 'gi')
        );
    }

    function isRealSummaryReceiptInField(slice) {
        return slice.includes(INFO_END)
            || slice.includes('[[VCP协议纠偏指导:')
            || /^[ \t]*-[ \t]*(?:工具名称|执行状态)[:：]/m.test(slice);
    }

    function findNextLineLeadingSummaryWall(text, fromIndex, limit = text.length) {
        const re = /^[ \t]*(<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:)/gm;
        re.lastIndex = fromIndex;
        const m = re.exec(text);
        if (!m) return null;
        const markerAt = m.index + m[0].indexOf(m[1]);
        if (markerAt >= limit) return null;
        return { index: markerAt, marker: m[1] };
    }

    function isPureSelfContainedToolExample(text, toolStart, innerEndIndex, innerEndLen, closedFences) {
        const fullSlice = text.slice(toolStart, innerEndIndex + innerEndLen);
        if (!hasBalancedMarkers(
            fullSlice,
            new RegExp(TOOL_OPEN_SOURCE, 'gi'),
            new RegExp(TOOL_END_SOURCE, 'gi')
        )) {
            return false;
        }
        if (/__VCP_MASK_[a-z0-9]{10,}_\d+__/.test(text.slice(toolStart, innerEndIndex))) {
            return false;
        }
        let pos = toolStart;
        while (pos < innerEndIndex) {
            RECEIPT_OR_ROLE_WALL_LINE_RE.lastIndex = pos;
            const m = RECEIPT_OR_ROLE_WALL_LINE_RE.exec(text);
            RECEIPT_OR_ROLE_WALL_LINE_RE.lastIndex = 0;
            if (!m || m.index >= innerEndIndex) break;
            const fence = closedFences.find(f => m.index >= f.start && m.index < f.end);
            if (fence) {
                pos = fence.nextPos;
                continue;
            }
            if (m[0].trimStart().startsWith(INFO_START) && !isRealSummaryReceiptInField(text.slice(m.index, innerEndIndex))) {
                pos = m.index + m[0].length;
                continue;
            }
            return false;
        }
        return true;
    }

    function blankInlineBackticksOutsideFences(text, safeFences = []) {
        if (typeof text !== 'string' || !text.includes('`')) return text;
        const chars = text.split('');
        let i = 0;
        let fIdx = 0;
        while (i < text.length) {
            while (fIdx < safeFences.length && safeFences[fIdx].end <= i) {
                fIdx += 1;
            }
            if (fIdx < safeFences.length && i >= safeFences[fIdx].start && i < safeFences[fIdx].end) {
                i = safeFences[fIdx].end;
                continue;
            }
            if (text[i] === '`') {
                let bs = 0;
                for (let b = i - 1; b >= 0 && text[b] === '\\'; b -= 1) bs += 1;
                let j = i;
                while (j < text.length && text[j] === '`') j += 1;
                const openLen = j - i;
                if (bs % 2 === 1) {
                    i = j;
                    continue;
                }
                let k = j;
                let matchedEnd = -1;
                while (k < text.length) {
                    if (text[k] === '\r' || text[k] === '\n') break;
                    if (text[k] === '`') {
                        let closeEnd = k;
                        while (closeEnd < text.length && text[closeEnd] === '`') closeEnd += 1;
                        if (closeEnd - k === openLen) {
                            matchedEnd = closeEnd;
                            break;
                        }
                        k = closeEnd;
                        continue;
                    }
                    k += 1;
                }
                if (matchedEnd !== -1) {
                    for (let p = i; p < matchedEnd; p += 1) {
                        chars[p] = ' ';
                    }
                    i = matchedEnd;
                    continue;
                }
                i = j;
                continue;
            }
            i += 1;
        }
        return chars.join('');
    }

    function findClosedFenceAndToolRanges(text, masks = null, options = {}) {
        const ranges = [];
        if (typeof text !== 'string') return ranges;
        const hasFence = text.includes('```') || text.includes('~~~');
        const hasTool = /\[TOOL_REQUEST/i.test(text);
        if (!hasFence && !hasTool) return ranges;

        const len = text.length;
        const toolOpenRe = new RegExp(TOOL_OPEN_SOURCE, 'gi');
        const toolEndRe = new RegExp(TOOL_END_SOURCE, 'gi');
        const nextOpenRe = new RegExp(TOOL_OPEN_SOURCE, 'gi');
        const roleWallRe = new RegExp(ROLE_WALL_SOURCE, 'g');
        const escPairOpenRe = /(?:「始ESCAPE」|\{始ESCAPE\})/gi;
        const safeFences = Array.isArray(options.safeFences)
            ? options.safeFences
            : (hasFence
                ? findFenceRangesOutsideProtocolWalls(text, {
                    masks,
                    splitAtThoughtClose: Boolean(options.splitAtThoughtClose),
                })
                : []);
        const toolScanText = hasTool ? blankInlineBackticksOutsideFences(text, safeFences) : text;
        let safeFenceIdx = 0;

        const findNextTool = (from) => {
            if (!hasTool) return null;
            return execUnwrappedRegex(toolOpenRe, toolScanText, from);
        };

        let pos = 0;
        while (pos < len) {
            while (safeFenceIdx < safeFences.length && safeFences[safeFenceIdx].start < pos) {
                safeFenceIdx += 1;
            }
            const fenceM = safeFenceIdx < safeFences.length ? safeFences[safeFenceIdx] : null;
            const toolM = findNextTool(pos);
            if (!fenceM && !toolM) break;

            if (fenceM && (!toolM || fenceM.start <= toolM.index)) {
                ranges.push({ kind: 'fence', start: fenceM.start, end: fenceM.end });
                pos = fenceM.nextPos;
                safeFenceIdx += 1;
            } else {
                let scan = toolM.index + toolM[0].length;
                let closedEnd = -1;
                while (scan < len) {
                    const nextField = findNextExplicitFieldStart(text, scan);
                    const endM = execUnwrappedRegex(toolEndRe, toolScanText, scan);
                    const nextM = execUnwrappedRegex(nextOpenRe, toolScanText, scan);
                    roleWallRe.lastIndex = scan;
                    const wallM = roleWallRe.exec(toolScanText);

                    const candidates = [];
                    if (nextField) candidates.push({ kind: 'field', index: nextField.declarationStart, field: nextField });
                    if (endM) candidates.push({ kind: 'end', index: endM.index, match: endM });
                    if (nextM) candidates.push({ kind: 'next', index: nextM.index });
                    if (wallM) candidates.push({ kind: 'wall', index: wallM.index });
                    if (candidates.length === 0) break;

                    candidates.sort((a, b) => a.index - b.index);
                    const earliest = candidates[0];

                    if (earliest.kind === 'next' || earliest.kind === 'wall') {
                        break;
                    }
                    if (earliest.kind === 'end') {
                        closedEnd = earliest.match.index + earliest.match[0].length;
                        break;
                    }

                    const field = earliest.field;
                    if (field.isEscape) {
                        const closeRe = field.usesBrace ? /\{末ESCAPE\}/gi : /「末ESCAPE」/gi;
                        closeRe.lastIndex = field.markerEnd;
                        const escCloseM = closeRe.exec(text);
                        if (!escCloseM) {
                            break;
                        }
                        if (hasCrossJumpEscapeReceipt(text.slice(field.markerEnd, escCloseM.index), field.usesBrace, masks)) {
                            break;
                        }
                        scan = escCloseM.index + escCloseM[0].length;
                        continue;
                    }

                    // Normal (non-ESCAPE) field:
                    // 1) Skip paired single-layer 「始ESCAPE」...「末ESCAPE」 / {始ESCAPE}...{末ESCAPE} if encountered before normal closer
                    // 2) Skip markers inside safe closed Markdown fences and pure self-contained ROLE_DIVIDE_* / TOOL_REQUEST examples
                    // 3) Break if an unescaped line-leading ROLE_DIVIDE_* or TOOL_REQUEST hard wall is hit before normal closer
                    const normalCloseRe = field.usesBrace ? /\{末\}/g : /「末」/g;
                    let fieldCursor = field.markerEnd;
                    let fieldClosed = false;
                    let hitWall = false;
                    let cachedFenceFrom = -1;
                    let cachedFenceLimit = -1;
                    let cachedClosedFences = [];
                    const getClosedFences = (from, limit) => {
                        if (limit <= from) return [];
                        if (cachedFenceFrom !== from || cachedFenceLimit !== limit) {
                            cachedFenceFrom = from;
                            cachedFenceLimit = limit;
                            cachedClosedFences = findSafeClosedFenceRanges(text, from, limit, masks);
                        }
                        return cachedClosedFences;
                    };
                    const findOutsideFences = (fences, findFn, startPos) => {
                        let search = startPos;
                        while (search < len) {
                            const m = findFn(search);
                            if (!m) return null;
                            const fence = fences.find(f => m.index >= f.start && m.index < f.end);
                            if (fence) {
                                search = fence.nextPos;
                                continue;
                            }
                            return m;
                        }
                        return null;
                    };

                    while (fieldCursor < len) {
                        normalCloseRe.lastIndex = fieldCursor;
                        const normalCloseM = normalCloseRe.exec(text);
                        const fenceLimit = normalCloseM ? normalCloseM.index : fieldCursor;
                        const closedFences = normalCloseM ? getClosedFences(fieldCursor, fenceLimit) : [];
                        const escOpenM = findOutsideFences(closedFences, (s) => {
                            escPairOpenRe.lastIndex = s;
                            return escPairOpenRe.exec(text);
                        }, fieldCursor);
                        const fWallM = findOutsideFences(
                            closedFences,
                            (s) => findNextLineLeadingRoleWall(toolScanText, s, normalCloseM ? normalCloseM.index : len),
                            fieldCursor
                        );
                        const fSummaryWallM = findOutsideFences(
                            closedFences,
                            (s) => findNextLineLeadingSummaryWall(toolScanText, s, normalCloseM ? normalCloseM.index : len),
                            fieldCursor
                        );
                        const fLineToolM = findOutsideFences(
                            closedFences,
                            (s) => findNextLineLeadingToolStart(toolScanText, s, nextOpenRe),
                            fieldCursor
                        );

                        let earliestWallIndex = -1;
                        if (fWallM) earliestWallIndex = fWallM.index;
                        if (fSummaryWallM && (earliestWallIndex === -1 || fSummaryWallM.index < earliestWallIndex)) {
                            earliestWallIndex = fSummaryWallM.index;
                        }
                        if (fLineToolM && (earliestWallIndex === -1 || fLineToolM.index < earliestWallIndex)) {
                            earliestWallIndex = fLineToolM.index;
                        }

                        if (
                            escOpenM
                            && (!normalCloseM || escOpenM.index < normalCloseM.index)
                            && (earliestWallIndex === -1 || escOpenM.index < earliestWallIndex)
                        ) {
                            const usesEscBrace = escOpenM[0][0] === '{';
                            const escCloseRe = usesEscBrace ? /\{末ESCAPE\}/gi : /「末ESCAPE」/gi;
                            escCloseRe.lastIndex = escOpenM.index + escOpenM[0].length;
                            const escCloseM = escCloseRe.exec(text);
                            if (
                                escCloseM
                                && !hasCrossJumpEscapeReceipt(text.slice(escOpenM.index + escOpenM[0].length, escCloseM.index), usesEscBrace, masks)
                            ) {
                                fieldCursor = escCloseM.index + escCloseM[0].length;
                            } else {
                                fieldCursor = escOpenM.index + escOpenM[0].length;
                            }
                            continue;
                        }

                        if (earliestWallIndex !== -1 && (!normalCloseM || earliestWallIndex < normalCloseM.index)) {
                            if (normalCloseM) {
                                if (fSummaryWallM && fSummaryWallM.index === earliestWallIndex) {
                                    if (fSummaryWallM.marker === INFO_START) {
                                        if (!isRealSummaryReceiptInField(text.slice(fSummaryWallM.index, normalCloseM.index))) {
                                            fieldCursor = fSummaryWallM.index + fSummaryWallM.marker.length;
                                            continue;
                                        }
                                        let sPos = fSummaryWallM.index + INFO_START.length;
                                        let sDepth = 1;
                                        let closedEnd = -1;
                                        while (sPos < normalCloseM.index && sDepth > 0) {
                                            const nextOpen = text.indexOf(INFO_START, sPos);
                                            const nextClose = text.indexOf(INFO_END, sPos);
                                            if (nextClose === -1 || nextClose + INFO_END.length > normalCloseM.index) break;
                                            if (nextOpen !== -1 && nextOpen < nextClose) {
                                                sDepth += 1;
                                                sPos = nextOpen + INFO_START.length;
                                            } else {
                                                sDepth -= 1;
                                                sPos = nextClose + INFO_END.length;
                                                if (sDepth === 0) closedEnd = sPos;
                                            }
                                        }
                                        if (closedEnd !== -1) {
                                            const docInner = text.slice(fSummaryWallM.index, closedEnd);
                                            if (
                                                !docInner.includes('[[VCP协议纠偏指导:')
                                                && !docInner.includes('<<<[VCP_TOOL_BATCH_START:')
                                                && !docInner.includes('<<<[ROLE_DIVIDE_USER]>>>')
                                                && hasBalancedRoleAndToolMarkers(docInner)
                                            ) {
                                                fieldCursor = closedEnd;
                                                continue;
                                            }
                                        }
                                    } else if (fSummaryWallM.marker.startsWith('<<<[VCP_TOOL_BATCH_START:')) {
                                        const headerMatch = /^<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/.exec(text.slice(fSummaryWallM.index));
                                        if (headerMatch) {
                                            const endToken = `<<<[VCP_TOOL_BATCH_END:${headerMatch[1]}]>>>`;
                                            const batchEndAt = text.indexOf(endToken, fSummaryWallM.index + headerMatch[0].length);
                                            const batchCloseEnd = batchEndAt !== -1 ? batchEndAt + endToken.length : -1;
                                            if (batchCloseEnd !== -1 && batchCloseEnd <= normalCloseM.index) {
                                                const batchSlice = text.slice(fSummaryWallM.index, batchCloseEnd);
                                                if (
                                                    !batchSlice.includes('[[VCP协议纠偏指导:')
                                                    && hasBalancedToolBatchMarkers(batchSlice)
                                                    && hasBalancedSummaryBlocks(batchSlice)
                                                    && hasBalancedRoleAndToolMarkers(batchSlice)
                                                ) {
                                                    fieldCursor = batchCloseEnd;
                                                    continue;
                                                }
                                            }
                                        }
                                    }
                                } else if (fWallM && fWallM.index === earliestWallIndex && !fWallM.marker.startsWith('<<<[END_')) {
                                    const startTag = `<<<[ROLE_DIVIDE_${fWallM.roleName}]>>>`;
                                    const endTag = `<<<[END_ROLE_DIVIDE_${fWallM.roleName}]>>>`;
                                    const afterStart = fWallM.index + fWallM.marker.length;
                                    const firstEnd = text.indexOf(endTag, afterStart);
                                    const nextStart = text.indexOf(startTag, afterStart);
                                    if (
                                        firstEnd !== -1
                                        && firstEnd + endTag.length <= normalCloseM.index
                                        && (nextStart === -1 || firstEnd < nextStart)
                                        && isPureRoleExampleInField(text.slice(afterStart, firstEnd), fWallM.roleName)
                                    ) {
                                        fieldCursor = firstEnd + endTag.length;
                                        continue;
                                    }
                                } else if (fLineToolM && fLineToolM.index === earliestWallIndex) {
                                    const innerEnd = execUnwrappedRegex(toolEndRe, toolScanText, fLineToolM.index + fLineToolM[0].length);
                                    if (
                                        innerEnd
                                        && innerEnd.index + innerEnd[0].length <= normalCloseM.index
                                        && isPureSelfContainedToolExample(
                                            toolScanText,
                                            fLineToolM.index,
                                            innerEnd.index,
                                            innerEnd[0].length,
                                            closedFences
                                        )
                                    ) {
                                        fieldCursor = innerEnd.index + innerEnd[0].length;
                                        continue;
                                    }
                                    if (!FIELD_DECL_AFTER_TOOL_RE.test(text.slice(fLineToolM.index + fLineToolM[0].length, normalCloseM.index))) {
                                        fieldCursor = fLineToolM.index + fLineToolM[0].length;
                                        continue;
                                    }
                                }
                            }
                            hitWall = true;
                            break;
                        }

                        if (normalCloseM) {
                            scan = normalCloseM.index + normalCloseM[0].length;
                            fieldClosed = true;
                            break;
                        }

                        break;
                    }

                    if (fieldClosed) {
                        continue;
                    }
                    if (hitWall) {
                        break;
                    }

                    // Field is genuinely unclosed (no normal closer exists): fallback to END_TOOL_REQUEST only if earlier than next TOOL_REQUEST & ROLE_DIVIDE_*
                    const fEndM = execUnwrappedRegex(toolEndRe, toolScanText, field.markerEnd);
                    const fNextM = execUnwrappedRegex(nextOpenRe, toolScanText, field.markerEnd);
                    const fWallM = findNextLineLeadingRoleWall(toolScanText, field.markerEnd, len);
                    if (fEndM && (!fNextM || fEndM.index < fNextM.index) && (!fWallM || fEndM.index < fWallM.index)) {
                        closedEnd = fEndM.index + fEndM[0].length;
                    }
                    break;
                }

                if (closedEnd > 0) {
                    ranges.push({ kind: 'tool', start: toolM.index, end: closedEnd });
                    pos = closedEnd;
                } else {
                    // Never teleport to nextM across intervening fenced code blocks
                    pos = toolM.index + toolM[0].length;
                }
            }
        }
        return ranges;
    }

    function applyMaskRanges(text, ranges, pushMask) {
        if (!ranges || ranges.length === 0) return text;
        let out = '';
        let cursor = 0;
        for (const r of ranges) {
            if (r.start < cursor) continue;
            out += text.slice(cursor, r.start) + pushMask(text.slice(r.start, r.end), r);
            cursor = r.end;
        }
        out += text.slice(cursor);
        return out;
    }

    function maskProtectedRegions(content, options = {}) {
        const masks = [];
        const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const pushTaggedMask = (kind) => (chunk) => {
            const token = `__VCP_MASK_${nonce}_${masks.length}__`;
            masks.push({ token, content: chunk, kind });
            return token;
        };
        const pushMask = pushTaggedMask('protocol');

        let masked = content;
        const infoRanges = findNestedVcpInfoRanges(masked);
        const filteredInfoRanges = typeof options.shouldMaskInfoBlock === 'function'
            ? infoRanges.filter(r => options.shouldMaskInfoBlock(masked.slice(r.start, r.end)))
            : infoRanges;
        masked = applyMaskRanges(masked, filteredInfoRanges, pushMask);

        const fenceAndToolRanges = findClosedFenceAndToolRanges(masked, masks, {
            splitAtThoughtClose: Boolean(options.splitAtThoughtClose),
        });
        const filteredRanges = typeof options.shouldMaskToolBlock === 'function'
            ? fenceAndToolRanges.filter(r => r.kind !== 'tool' || options.shouldMaskToolBlock(masked.slice(r.start, r.end), r))
            : fenceAndToolRanges;
        masked = applyMaskRanges(masked, filteredRanges, (chunk, r) => pushTaggedMask(r?.kind || 'protocol')(chunk));

        const beforeInlineRegionMasks = masks.length;
        const { text: inlineProtected, masks: inlineTempMasks } = maskInlineBackticks(masked, 'VCP_REGION_INLINE');
        let regionWork = inlineProtected.replace(/<<<DailyNoteStart>>>(?:(?!<<<DailyNoteStart>>>)[\s\S])*?<<<DailyNoteEnd>>>/g, pushMask);

        if (!options.skipTopLevelEscape) {
            regionWork = regionWork
                .replace(/「始ESCAPE」[\s\S]*?「末ESCAPE」/gi, pushMask)
                .replace(/\{始ESCAPE\}[\s\S]*?\{末ESCAPE\}/gi, pushMask);
        }
        if (inlineTempMasks.length > 0) {
            for (let idx = beforeInlineRegionMasks; idx < masks.length; idx += 1) {
                masks[idx].content = unmaskInlineBackticks(masks[idx].content, inlineTempMasks);
            }
        }
        masked = unmaskInlineBackticks(regionWork, inlineTempMasks);

        return { text: masked, masks };
    }

    function unmaskProtectedRegions(text, masks) {
        if (!masks || !masks.length || typeof text !== 'string') return text;
        let result = text;
        for (let i = masks.length - 1; i >= 0; i--) {
            const { token, content: original } = masks[i];
            if (result.includes(token)) {
                result = result.split(token).join(original);
            }
        }
        return result;
    }

    function isGuidanceErrorInfoBlock(block) {
        if (typeof block !== 'string' || !block) return false;
        const head = block.slice(0, 600);
        const toolMatch = head.match(/^[ \t]*-[ \t]*工具名称[:：][ \t]*(.+)$/m);
        const statusMatch = head.match(/^[ \t]*-[ \t]*执行状态[:：][ \t]*(.+)$/m);
        const isVcpTool = Boolean(toolMatch && toolMatch[1].trim() === 'VCP工具调用');
        const isErrorStatus = Boolean(statusMatch && /❌\s*ERROR/i.test(statusMatch[1]));
        const hasGuidanceReturn = /^[ \t]*-[ \t]*返回内容[:：]\s*\[\[VCP协议纠偏指导:/m.test(head);
        const hasReceiptPattern = /\[\[VCP协议纠偏指导:\s*code=[A-Z0-9_]+(?:\s+block=[a-zA-Z0-9_-]+)?/i.test(block)
            && (block.includes('[[/VCP协议纠偏指导]]') || /\[\[VCP协议纠偏指导:\s*code=[A-Z0-9_]+\s+block=[a-zA-Z0-9_-]+\]\]/i.test(head));
        return (hasGuidanceReturn || hasReceiptPattern) && (isVcpTool || isErrorStatus);
    }

    function findThoughtBoundary(tail, masks, includeToolMasks) {
        const lineWallRe = includeToolMasks
            ? /(?:^|\r?\n)[ \t]*(?:<<<\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|USER|ASSISTANT)\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4})/im
            : /(?:^|\r?\n)[ \t]*(?:<<<\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|USER|ASSISTANT)\]>>>|<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:)/im;
        const lineWallMatch = lineWallRe.exec(tail);
        let earliest = lineWallMatch ? lineWallMatch.index : -1;

        const maskRe = /__VCP_MASK_[a-z0-9]{10,}_(\d+)__/g;
        let mm;
        while ((mm = maskRe.exec(tail)) !== null) {
            if (earliest !== -1 && mm.index >= earliest) break;
            const idx = Number(mm[1]);
            const entry = Array.isArray(masks) ? masks[idx] : null;
            if (entry?.kind === 'fence') continue;
            if (!includeToolMasks && entry && !entry.content?.startsWith(INFO_START)) {
                continue;
            }
            const nlBefore = mm.index === 0 ? -1 : tail.lastIndexOf('\n', mm.index - 1);
            const prefixOnLine = tail.slice(nlBefore + 1, mm.index);
            if (/^[ \t]*$/.test(prefixOnLine) && nlBefore !== -1) {
                const lineBreakStart = nlBefore > 0 && tail[nlBefore - 1] === '\r' ? nlBefore - 1 : nlBefore;
                earliest = lineBreakStart;
            } else {
                earliest = mm.index;
            }
            break;
        }
        return earliest;
    }

    function stripThoughtBlocks(text, masks) {
        if (typeof text !== 'string' || !text) return text;
        const openerRe = /^[ \t]*(?:<(think(?:ing)?|thought(?:s)?|antthinking)(?:[ \t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*[ \t]*>([^\r\n]*)(?:\r?\n|$)|\[--- VCP元思考链(?:(?!---\]).)*?---\][ \t]*(?:\r?\n|$)|\[--- VCP元思考链(?![^\r\n]*---\])[^\r\n]*(?:\r?\n|$))/gim;

        let work = text;
        let searchFrom = 0;
        while (searchFrom < work.length) {
            openerRe.lastIndex = searchFrom;
            const m = openerRe.exec(work);
            if (!m) break;
            const tagName = m[1];
            const inlineTailAfterOpen = m[2] || '';
            const isStandaloneOpener = !tagName || /^[ \t]*$/.test(inlineTailAfterOpen);
            const afterOpener = m.index + m[0].length;
            const closeRe = tagName
                ? new RegExp(`</${tagName}[ \\t]*>`, 'i')
                : /\[--- 元思考链结束 ---\]/;
            if (tagName && !isStandaloneOpener && closeRe.test(inlineTailAfterOpen)) {
                searchFrom = afterOpener;
                continue;
            }
            const tail = work.slice(afterOpener);
            const hardBoundaryIdx = findThoughtBoundary(tail, masks, false);
            const searchSlice = hardBoundaryIdx !== -1 ? tail.slice(0, hardBoundaryIdx) : tail;
            const closeMatch = closeRe.exec(searchSlice);

            if (closeMatch) {
                const closeAbsStart = afterOpener + closeMatch.index;
                let closeAbsEnd = closeAbsStart + closeMatch[0].length;
                const afterClose = work.slice(closeAbsEnd);
                if (/^[ \t]*\r?\n/.test(afterClose)) {
                    const nlMatch = /^[ \t]*\r?\n/.exec(afterClose);
                    closeAbsEnd += nlMatch[0].length;
                } else {
                    const spaceMatch = /^[ \t]+/.exec(afterClose);
                    if (spaceMatch) {
                        closeAbsEnd += spaceMatch[0].length;
                    }
                }
                work = work.slice(0, m.index) + work.slice(closeAbsEnd);
                searchFrom = m.index;
                continue;
            }

            if (!isStandaloneOpener) {
                searchFrom = afterOpener;
                continue;
            }

            const danglingBoundaryIdx = findThoughtBoundary(tail, masks, true);
            let lineBreak = '';
            let removeFrom = m.index;
            if (removeFrom >= 2 && work[removeFrom - 2] === '\r' && work[removeFrom - 1] === '\n') {
                removeFrom -= 2;
                lineBreak = '\r\n';
            } else if (removeFrom >= 1 && work[removeFrom - 1] === '\n') {
                removeFrom -= 1;
                lineBreak = '\n';
            }

            if (danglingBoundaryIdx === -1) {
                work = work.slice(0, removeFrom);
                break;
            }

            const boundaryStart = afterOpener + danglingBoundaryIdx;
            const afterBoundary = work.slice(boundaryStart);
            if (removeFrom === 0) {
                work = afterBoundary.replace(/^\r?\n/, '');
                searchFrom = 0;
            } else {
                const needsSep = !afterBoundary.startsWith('\n') && !afterBoundary.startsWith('\r\n');
                work = work.slice(0, removeFrom) + (needsSep ? (lineBreak || '\n') : '') + afterBoundary;
                searchFrom = removeFrom;
            }
        }
        return work;
    }

    function stripThoughtChains(content) {
        if (typeof content !== 'string') return content;

        const { text: masked, masks } = maskProtectedRegions(content, { splitAtThoughtClose: true });
        const { text: inlineMasked, masks: inlineMasks } = maskInlineBackticks(masked, 'VCP_THOUGHT_INLINE');

        const THOUGHT_CHAIN_REGEX = /^[ \t]*\[--- VCP元思考链(?:(?!---\]).)*?---\](?:[ \t]*\r?\n[\s\S]*?^[ \t]*|[^\r\n]*?)\[--- 元思考链结束 ---\](?:[ \t]*\r?\n|[ \t]*)/gm;
        const CONVENTIONAL_INLINE_THOUGHT_REGEX = /^[ \t]*<(think(?:ing)?|thought(?:s)?|antthinking)(?:[ \t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*[ \t]*>[^\r\n]*?<\/\1[ \t]*>[ \t]*(?:\r?\n|$)/gim;

        let cleaned = inlineMasked
            .replace(THOUGHT_CHAIN_REGEX, '')
            .replace(CONVENTIONAL_INLINE_THOUGHT_REGEX, '');
        cleaned = stripThoughtBlocks(cleaned, masks);

        return unmaskProtectedRegions(unmaskInlineBackticks(cleaned, inlineMasks), masks);
    }

    function isToolResultHidden(rawBlock) {
        if (typeof rawBlock !== 'string') return false;
        if (/^\[\[VCP调用结果信息汇总:\s*(?:\[HIDDEN\]|<!--HIDDEN-->|\(HIDDEN\))/i.test(rawBlock)) {
            return true;
        }
        const head = rawBlock.slice(0, 300);
        return /^[ \t]*-[ \t]*(?:注入上下文|上下文注入|上下文状态|Context):\s*(?:隐藏|hidden|false|否)/im.test(head);
    }

    function stripHiddenToolResults(content) {
        if (typeof content !== 'string' || !content.includes(INFO_START)) return content;

        const hasFence = content.includes('```') || content.includes('~~~');
        const safeFences = hasFence ? findFenceRangesOutsideProtocolWalls(content) : [];
        let safeFenceIdx = 0;
        const hiddenRanges = [];
        let pos = 0;

        while (pos < content.length) {
            while (safeFenceIdx < safeFences.length && safeFences[safeFenceIdx].start < pos) {
                safeFenceIdx += 1;
            }
            const fenceM = safeFenceIdx < safeFences.length ? safeFences[safeFenceIdx] : null;
            const infoStart = findNextLineLeadingInfoStart(content, pos);
            if (!fenceM && infoStart === -1) break;

            if (fenceM && (infoStart === -1 || fenceM.start <= infoStart)) {
                pos = fenceM.nextPos;
                safeFenceIdx += 1;
                continue;
            }

            const blockEnd = scanVcpInfoBlockEnd(content, infoStart);
            if (blockEnd === -1) {
                pos = infoStart + INFO_START.length;
                continue;
            }

            if (isToolResultHidden(content.slice(infoStart, blockEnd))) {
                hiddenRanges.push({ start: infoStart, end: blockEnd });
            }
            pos = blockEnd;
        }

        if (hiddenRanges.length === 0) {
            return content;
        }

        let result = '';
        let cursor = 0;
        for (const r of hiddenRanges) {
            if (r.start < cursor) continue;
            result += content.slice(cursor, r.start);
            cursor = r.end;
        }
        result += content.slice(cursor);

        return result.replace(/\n{3,}/g, '\n\n');
    }

    function stripErrorSummaryItemsInSummaryBlocks(text) {
        if (typeof text !== 'string' || !text) return text;
        const summaryBlockRe = /([ \t]*)(\[本轮工具调用摘要:\]|[【\[]\s*本轮工具调用摘要\s*[:：]\s*[】\]]|<<<\[VCP_TOOL_BATCH_SUMMARY\]>>>)([\s\S]*?)(\[本轮工具调用摘要结束\]|[【\[]\s*本轮工具调用摘要结束\s*[】\]]|<<<\[END_VCP_TOOL_BATCH_SUMMARY\]>>>)([ \t]*(?:\r?\n)?)/g;
        return text.replace(summaryBlockRe, (fullMatch, indent, openTag, body, closeTag, trailing) => {
            const items = body
                .split(/[；;\r\n]+/)
                .map(s => s.trim())
                .filter(Boolean);
            const kept = items.filter(item => (
                !/(?:格式错误|执行失败)（未执行）/.test(item)
                && !/^[。.,，\s]+$/.test(item)
            ));
            if (kept.length === 0) {
                return '';
            }
            const hasLeadingNl = /^\s*\n/.test(body);
            const hasTrailingNl = /\n\s*$/.test(body);
            const useNewline = kept.every(item => /^-\s/.test(item));
            const inner = kept.join(useNewline ? '\n' : '；');
            return `${indent}${openTag}${hasLeadingNl ? '\n' : ''}${inner}${hasTrailingNl ? '\n' : ''}${closeTag}${trailing}`;
        });
    }

    function stripResilienceNoiseFromMasked(maskedText) {
        let result = maskedText;
        // 1a. 闭合纠偏指导全文块
        result = result.replace(/[ \t]*\[\[VCP协议纠偏指导:[\s\S]*?\[\[\/VCP协议纠偏指导\]\][ \t]*(?:\r?\n)?/g, '');
        // 1b. 单行极简纠偏指导回执
        result = result.replace(/[ \t]*\[\[VCP协议纠偏指导:[^\r\n\]]+\]\][ \t]*(?:\r?\n)?/g, '');
        // 1c. 截断未闭合纠偏指导
        result = result.replace(/[ \t]*\[\[VCP协议纠偏指导:[ \t]*(?:code=|[\r\n])[\s\S]*?(?=(?:\[\[VCP协议纠偏指导:)|(?:<<<\[\/?(?:END_)?ROLE_DIVIDE)|(?:VCP调用结果结束\]\])|$)(?:\r?\n)?/g, '');
        // 2. 常驻药丸
        result = result.replace(/[ \t]*(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][\s\S]*?[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][ \t]*(?:\r?\n)?/gi, '');
        // 3. 摘要报错项（仅在摘要块内部拆条过滤后用 `；` 重拼，外加严格行首 `- [x]` 清单条目）
        result = stripErrorSummaryItemsInSummaryBlocks(result);
        result = result.replace(/^[ \t]*-\s*\[[xX]\][ \t]+[^\r\n]*(?:格式错误|执行失败)（未执行）[^\r\n]*[ \t]*(?:\r?\n)?/gm, '');
        // 4a. 掏空后的错误结果汇总块与空批次摘要壳
        result = result.replace(/[ \t]*\[\[VCP调用结果信息汇总:\s*(?:\r?\n)?(?:[ \t]*-(?![ \t]*返回内容)[^\r\n:：]+[:：][^\r\n]*(?:\r?\n))*?[ \t]*-[ \t]*执行状态[:：][ \t]*❌[ \t]*ERROR[ \t]*(?:\r?\n)?(?:[ \t]*-(?![ \t]*返回内容)[^\r\n:：]+[:：][^\r\n]*(?:\r?\n))*?(?:[ \t]*-[ \t]*返回内容[:：]?[ \t]*)?\s*VCP调用结果结束\]\][ \t]*(?:\r?\n)?/gi, '');
        result = result.replace(/[ \t]*(?:<<<\[VCP_TOOL_BATCH_SUMMARY\]>>>\s*<<<\[END_VCP_TOOL_BATCH_SUMMARY\]>>>|\[本轮工具调用摘要:\]\s*(?:\r?\n)?\s*\[本轮工具调用摘要结束\]|[【\[]\s*本轮工具调用摘要\s*[:：]\s*[】\]]\s*(?:\r?\n)?\s*[【\[]\s*本轮工具调用摘要结束\s*[】\]])[ \t]*(?:\r?\n)?/g, '');
        // 4b. 置空占位符
        result = result.replace(/[ \t]*(?:\(上轮未执行的异常工具调用已略去\)|\[工具调用纠偏已归档\])[ \t]*(?:\r?\n)?/g, '');
        // 5. 空批次外壳与空 ROLE_DIVIDE_USER 外壳
        result = result.replace(/[ \t]*<<<\[ROLE_DIVIDE_USER\]>>>\s*<<<\[VCP_TOOL_BATCH_START:[^\]]+\]>>>\s*<<<\[VCP_TOOL_BATCH_END:[^\]]+\]>>>\s*<<<\[END_ROLE_DIVIDE_USER\]>>>[ \t]*(?:\r?\n)?/g, '');
        result = result.replace(/[ \t]*<<<\[ROLE_DIVIDE_USER\]>>>\s*<<<\[END_ROLE_DIVIDE_USER\]>>>[ \t]*(?:\r?\n)?/g, '');
        return result;
    }

    function stripProtocolResilienceNoise(content) {
        if (typeof content !== 'string' || !content) return content;

        const { text: masked, masks } = maskProtectedRegions(content, {
            skipTopLevelEscape: true,
            shouldMaskInfoBlock: (block) => !isGuidanceErrorInfoBlock(block)
        });

        const cleaned = stripResilienceNoiseFromMasked(masked);
        const result = unmaskProtectedRegions(cleaned, masks);
        return result.replace(/\n{3,}/g, '\n\n');
    }

    function createUniqueMaskPrefix(text, label = 'VCP_MASK') {
        const source = typeof text === 'string' ? text : '';
        let prefix;
        do {
            const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
            prefix = `__${label}_${nonce}_`;
        } while (source.includes(prefix));
        return prefix;
    }

    function maskInlineBackticks(text, label = 'VCP_INLINE') {
        if (typeof text !== 'string' || !text.includes('`')) {
            return { text: typeof text === 'string' ? text : '', masks: [] };
        }
        const prefix = createUniqueMaskPrefix(text, label);
        const masks = [];
        let out = '';
        let i = 0;
        while (i < text.length) {
            if (text[i] === '`') {
                let bs = 0;
                for (let b = i - 1; b >= 0 && text[b] === '\\'; b -= 1) bs += 1;
                let j = i;
                while (j < text.length && text[j] === '`') j += 1;
                const openLen = j - i;
                if (bs % 2 === 1) {
                    out += text.slice(i, j);
                    i = j;
                    continue;
                }
                let k = j;
                let matchedEnd = -1;
                while (k < text.length) {
                    if (text[k] === '\r' || text[k] === '\n') break;
                    if (text[k] === '`') {
                        let closeEnd = k;
                        while (closeEnd < text.length && text[closeEnd] === '`') closeEnd += 1;
                        if (closeEnd - k === openLen) {
                            matchedEnd = closeEnd;
                            break;
                        }
                        k = closeEnd;
                        continue;
                    }
                    k += 1;
                }
                if (matchedEnd !== -1) {
                    const token = `${prefix}${masks.length}__`;
                    masks.push({ token, content: text.slice(i, matchedEnd) });
                    out += token;
                    i = matchedEnd;
                    continue;
                }
                out += text.slice(i, j);
                i = j;
                continue;
            }
            out += text[i];
            i += 1;
        }
        return { text: out, masks };
    }

    function unmaskInlineBackticks(text, inlineMasks) {
        if (!inlineMasks || !inlineMasks.length || typeof text !== 'string') return text;
        let result = text;
        for (let i = inlineMasks.length - 1; i >= 0; i -= 1) {
            const { token, content } = inlineMasks[i];
            if (result.includes(token)) result = result.split(token).join(content);
        }
        return result;
    }

    function shouldStripUnclosedToolRequest(text, startIndex, openMarkerLength = 20) {
        if (typeof text !== 'string' || startIndex < 0) return false;
        if (isLineLeadingBlank(text, startIndex)) return true;
        const afterOpen = text.slice(startIndex + openMarkerLength, startIndex + openMarkerLength + 160);
        return /^[ \t]*\r?\n?[ \t]*(?:(?:tool_name|maid|maidname|valet|valetname|command|jev|archery)\s*[:：]|[^\s,:：「」{}<>()[\]]+\s*[:：]\s*(?:「始(?:escape)?」|\{始(?:escape)?\})|<tool_name>)/i.test(afterOpen);
    }

    function findSafeClosedFenceRanges(text, fromIndex = 0, endIndex = -1, masks = null) {
        const ranges = [];
        if (typeof text !== 'string') return ranges;
        const limit = endIndex !== -1 ? Math.min(endIndex, text.length) : text.length;
        const startOffset = Math.max(0, fromIndex);
        if (startOffset >= limit) return ranges;
        const slice = text.slice(startOffset, limit);
        if (!slice.includes('```') && !slice.includes('~~~')) return ranges;

        let pos = 0;
        while (pos < slice.length) {
            const fenceM = findNextClosedMarkdownFence(slice, pos);
            if (!fenceM) break;
            if (fenceM.start === 0 && startOffset > 0 && text[startOffset - 1] !== '\n') {
                const nl = slice.indexOf('\n', 0);
                if (nl === -1) break;
                pos = nl + 1;
                continue;
            }
            const fenceText = slice.slice(fenceM.start, fenceM.end);
            if (isSafeClosedFenceText(fenceText, masks)) {
                ranges.push({
                    start: startOffset + fenceM.start,
                    end: startOffset + fenceM.end,
                    nextPos: startOffset + fenceM.nextPos,
                });
            }
            pos = fenceM.nextPos;
        }
        return ranges;
    }

    function findFenceRangesOutsideProtocolWalls(text, options = {}) {
        if (typeof text !== 'string' || (!text.includes('```') && !text.includes('~~~'))) return [];
        const wallParts = [
            '^[ \\t]*<<<\\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|USER|ASSISTANT)\\]>>>',
            '^[ \\t]*<<<\\[VCP_TOOL_BATCH_START:[^\\]\\r\\n]+\\]>>>',
            '^[ \\t]*\\[\\[VCP调用结果信息汇总:',
            '^[ \\t]*\\[\\[VCP协议纠偏指导:',
        ];
        if (options.extraWallPattern) {
            wallParts.push(options.extraWallPattern);
        }
        const wallRe = new RegExp(wallParts.join('|'), 'im');
        const extraWallRe = options.extraWallPattern ? new RegExp(options.extraWallPattern, 'i') : null;

        const blankRangesPreservingNewlines = (src, targetRanges) => {
            if (!targetRanges || targetRanges.length === 0) return src;
            const chars = src.split('');
            for (const r of targetRanges) {
                const s = Math.max(0, r.start);
                const e = Math.min(src.length, r.end);
                for (let i = s; i < e; i += 1) {
                    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
                }
            }
            return chars.join('');
        };

        const hasStripableUnclosedToolBefore = (limit, collectedRanges = []) => {
            const rawPrefix = text.slice(0, limit);
            if (!/\[TOOL_REQUEST/i.test(rawPrefix)) return false;
            const prefixFences = collectedRanges.filter(r => r.end <= limit);
            const prefixInfos = findNestedVcpInfoRanges(rawPrefix);
            const combined = [...prefixFences, ...prefixInfos].sort((a, b) => a.start - b.start || b.end - a.end);
            const maskedPrefix = blankRangesPreservingNewlines(rawPrefix, combined);
            let prefix = blankInlineBackticksOutsideFences(maskedPrefix, prefixFences);
            prefix = prefix
                .replace(/「始ESCAPE」[\s\S]*?「末ESCAPE」/gi, m => m.replace(/[^\r\n]/g, ' '))
                .replace(/\{始ESCAPE\}[\s\S]*?\{末ESCAPE\}/gi, m => m.replace(/[^\r\n]/g, ' '));
            const openRe = new RegExp(TOOL_OPEN_SOURCE, 'gi');
            const endRe = new RegExp(TOOL_END_SOURCE, 'gi');
            const events = [];
            let m;
            while ((m = openRe.exec(prefix)) !== null) {
                if (!isBacktickWrapped(prefix, m.index, m[0].length) && shouldStripUnclosedToolRequest(prefix, m.index, m[0].length)) {
                    events.push({ idx: m.index, delta: 1 });
                }
            }
            while ((m = endRe.exec(prefix)) !== null) {
                if (!isBacktickWrapped(prefix, m.index, m[0].length)) {
                    events.push({ idx: m.index, delta: -1 });
                }
            }
            events.sort((a, b) => a.idx - b.idx);
            let depth = 0;
            for (const ev of events) {
                depth += ev.delta;
                if (depth < 0) depth = 0;
            }
            return depth > 0;
        };

        const hasBalancedRoleDividersInMask = (slice) => {
            for (const role of ['USER', 'SYSTEM', 'ASSISTANT']) {
                if (!hasBalancedMarkers(
                    slice,
                    new RegExp(`<<<\\[ROLE_DIVIDE_${role}\\]>>>`, 'g'),
                    new RegExp(`<<<\\[END_ROLE_DIVIDE_${role}\\]>>>`, 'g')
                )) {
                    return false;
                }
            }
            return true;
        };

        const findActiveThoughtAt = (limit, collectedRanges) => {
            if (!options.splitAtThoughtClose || limit <= 0) return null;
            const prefixRaw = text.slice(0, limit);
            if (!/(?:<(?:think|thought|antthinking)|\[--- VCP元思考链)/i.test(prefixRaw)) return null;

            const prefixFences = collectedRanges.filter(r => r.end <= limit);
            const prefixTools = /\[TOOL_REQUEST/i.test(prefixRaw)
                ? findClosedFenceAndToolRanges(prefixRaw, options.masks, { safeFences: prefixFences }).filter(r => r.kind === 'tool')
                : [];
            const combinedMasks = [...prefixFences, ...prefixTools].sort((a, b) => a.start - b.start || b.end - a.end);
            const maskedPrefix = combinedMasks.length
                ? applyMaskRanges(prefixRaw, combinedMasks, chunk => ' '.repeat(chunk.length))
                : prefixRaw;
            const { text: inlineMaskedPrefix } = maskInlineBackticks(maskedPrefix, 'VCP_THOUGHT_PREFIX');
            const prefix = inlineMaskedPrefix
                .replace(/<<<DailyNoteStart>>>(?:(?!<<<DailyNoteStart>>>)[\s\S])*?<<<DailyNoteEnd>>>/g, m => ' '.repeat(m.length))
                .replace(/「始ESCAPE」[\s\S]*?「末ESCAPE」/gi, m => ' '.repeat(m.length))
                .replace(/\{始ESCAPE\}[\s\S]*?\{末ESCAPE\}/gi, m => ' '.repeat(m.length));
            const openerRe = /^[ \t]*(?:<(think(?:ing)?|thought(?:s)?|antthinking)(?:[ \t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*[ \t]*>[ \t]*(?=\r?\n|$)|\[--- VCP元思考链(?:(?!---\]).)*?---\][ \t]*(?=\r?\n|$)|\[--- VCP元思考链(?![^\r\n]*---\])[^\r\n]*(?=\r?\n|$))/gim;
            let cursor = 0;
            while (cursor < prefix.length) {
                openerRe.lastIndex = cursor;
                const m = openerRe.exec(prefix);
                if (!m) break;
                const tagName = m[1];
                const closeRe = tagName ? new RegExp(`</${tagName}[ \\t]*>`, 'ig') : /\[--- 元思考链结束 ---\]/g;
                closeRe.lastIndex = m.index + m[0].length;
                const closeM = closeRe.exec(prefix);
                if (!closeM) {
                    return {
                        lineCloseRe: tagName
                            ? new RegExp(`^[ \\t]*</${tagName}[ \\t]*>`, 'im')
                            : /^[ \t]*\[--- 元思考链结束 ---\]/m,
                    };
                }
                cursor = closeM.index + closeM[0].length;
            }
            return null;
        };

        const findCrossWallMatch = (fenceM, collectedRanges) => {
            const openNl = text.indexOf('\n', fenceM.start);
            if (openNl === -1) return null;
            const closeLineStart = fenceM.closeLineStart;
            if (closeLineStart <= openNl + 1) return null;
            const rawInner = text.slice(openNl + 1, closeLineStart);
            let inner = rawInner;
            if (Array.isArray(options.masks) && /__VCP_MASK_[a-z0-9]{10,}_\d+__/.test(rawInner)) {
                inner = rawInner.replace(MASK_TOKEN_RE, (m, idxText) => options.masks[Number(idxText)]?.content ?? m);
            }

            const activeThought = findActiveThoughtAt(fenceM.start, collectedRanges);
            const thoughtCloseMatch = activeThought ? activeThought.lineCloseRe.exec(rawInner) : null;

            const firstWall = wallRe.exec(rawInner);
            const firstExpandedWall = inner === rawInner ? firstWall : wallRe.exec(inner);
            if (!firstWall && !firstExpandedWall && !thoughtCloseMatch) return null;

            const hasUnbalancedFence = hasUnbalancedInnerFence(inner, fenceM.ch);
            const hasOpenToolBefore = hasStripableUnclosedToolBefore(fenceM.start, collectedRanges);
            let isCrossWall = false;
            if (firstWall || firstExpandedWall) {
                if (extraWallRe && extraWallRe.test(rawInner)) {
                    isCrossWall = true;
                } else if (/^[ \t]*<<<\[VCP_TOOL_BATCH_START:/m.test(inner)) {
                    isCrossWall = true;
                } else if (/^[ \t]*\[\[VCP协议纠偏指导:/m.test(inner)) {
                    isCrossWall = hasOpenToolBefore
                        || hasUnbalancedFence
                        || inner.includes('<<<[ROLE_DIVIDE_USER]>>>')
                        || !inner.includes('[[/VCP协议纠偏指导]]');
                } else if (/^[ \t]*\[\[VCP调用结果信息汇总:/m.test(inner)) {
                    const hasUnbalancedRole = (hasOpenToolBefore || inner.includes('<<<[ROLE_DIVIDE_USER]>>>'))
                        && inner.includes('<<<[ROLE_DIVIDE_')
                        && !hasBalancedRoleDividersInMask(inner);
                    const hasUnbalancedSum = !hasBalancedSummaryBlocks(inner);
                    const sumAt = inner.search(/^[ \t]*\[\[VCP调用结果信息汇总:/m);
                    const isTruncatedSummary = hasUnbalancedSum
                        && (
                            text.indexOf(INFO_END, fenceM.end) !== -1
                            || isToolResultHidden(sumAt >= 0 ? inner.slice(sumAt).trimStart() : inner)
                        );
                    isCrossWall = hasUnbalancedFence
                        || hasOpenToolBefore
                        || hasUnbalancedRole
                        || isTruncatedSummary
                        || (inner.includes('<<<[ROLE_DIVIDE_USER]>>>') && hasUnbalancedSum);
                } else {
                    const hasRoleEnvelope = /<<<\[ROLE_DIVIDE_(USER|SYSTEM|ASSISTANT)\]>>>[\s\S]*?<<<\[END_ROLE_DIVIDE_\1\]>>>/.test(inner);
                    const hasUnbalancedRole = hasOpenToolBefore
                        && inner.includes('<<<[END_ROLE_DIVIDE_')
                        && !hasBalancedRoleDividersInMask(inner);
                    isCrossWall = hasUnbalancedFence
                        || hasUnbalancedRole
                        || (hasRoleEnvelope && hasOpenToolBefore);
                }
            }

            if (thoughtCloseMatch) {
                const wallIdx = isCrossWall
                    ? (firstWall || /^[ \t]*__VCP_MASK_[a-z0-9]{10,}_\d+__/m.exec(rawInner))?.index ?? Infinity
                    : Infinity;
                if (!isCrossWall || thoughtCloseMatch.index <= wallIdx) {
                    const afterThoughtClose = openNl + 1 + thoughtCloseMatch.index + thoughtCloseMatch[0].length;
                    return {
                        thoughtSplit: true,
                        wallAbs: openNl + 1 + thoughtCloseMatch.index,
                        afterWall: Math.min(closeLineStart, afterThoughtClose),
                        innerStart: openNl + 1,
                        closeLineStart,
                        hasOpenToolBefore: true,
                    };
                }
            }

            if (!isCrossWall) return null;
            const wallTokenMatch = firstWall || /^[ \t]*__VCP_MASK_[a-z0-9]{10,}_\d+__/m.exec(rawInner);
            if (!wallTokenMatch) return null;
            const wallAbs = openNl + 1 + wallTokenMatch.index;
            return {
                thoughtSplit: false,
                wallAbs,
                afterWall: Math.min(closeLineStart, wallAbs + wallTokenMatch[0].length),
                innerStart: openNl + 1,
                closeLineStart,
                hasOpenToolBefore,
            };
        };

        const ranges = [];
        let pos = 0;
        if (options.startsMidLine) {
            const firstNl = text.indexOf('\n', 0);
            if (firstNl === -1) return ranges;
            pos = firstNl + 1;
        }
        while (pos < text.length) {
            const fenceM = findNextClosedMarkdownFence(text, pos);
            if (!fenceM) break;
            const cross = findCrossWallMatch(fenceM, ranges);
            if (!cross) {
                ranges.push({ kind: 'fence', start: fenceM.start, end: fenceM.end, nextPos: fenceM.nextPos });
                pos = fenceM.nextPos;
                continue;
            }
            if (!cross.thoughtSplit && cross.wallAbs > fenceM.start) {
                if (!cross.hasOpenToolBefore) {
                    let preEnd = cross.wallAbs;
                    const beforeWall = text.slice(fenceM.start, preEnd);
                    const trailingBlank = /\r?\n[ \t]*$/.exec(beforeWall);
                    if (trailingBlank && fenceM.start + trailingBlank.index > fenceM.start) {
                        preEnd = fenceM.start + trailingBlank.index;
                    }
                    ranges.push({ kind: 'fence', start: fenceM.start, end: preEnd, nextPos: preEnd });
                } else {
                    const preSlice = text.slice(cross.innerStart, cross.wallAbs);
                    if (preSlice.includes('```') || preSlice.includes('~~~')) {
                        const subRanges = findFenceRangesOutsideProtocolWalls(preSlice, { ...options, startsMidLine: false });
                        for (const sr of subRanges) {
                            ranges.push({
                                kind: 'fence',
                                start: cross.innerStart + sr.start,
                                end: cross.innerStart + sr.end,
                                nextPos: cross.innerStart + sr.nextPos,
                            });
                        }
                    }
                }
            }
            const hasRightOpen = hasUnbalancedInnerFence(text.slice(cross.afterWall, cross.closeLineStart), fenceM.ch);
            const rightEnd = hasRightOpen ? fenceM.end : cross.closeLineStart;
            const rightSlice = text.slice(cross.afterWall, rightEnd);
            if (rightSlice.includes('```') || rightSlice.includes('~~~')) {
                const rightMidLine = cross.afterWall > 0 && text[cross.afterWall - 1] !== '\n';
                const rightRanges = findFenceRangesOutsideProtocolWalls(rightSlice, { ...options, startsMidLine: rightMidLine });
                for (const rr of rightRanges) {
                    ranges.push({
                        kind: 'fence',
                        start: cross.afterWall + rr.start,
                        end: cross.afterWall + rr.end,
                        nextPos: cross.afterWall + rr.nextPos,
                    });
                }
            }
            pos = fenceM.nextPos;
        }
        return ranges;
    }

    function stripUnclosedToolRequestsSafe(text, findUnclosedFn, options = {}) {
        if (typeof text !== 'string' || !text || typeof findUnclosedFn !== 'function') return text;

        const fencePrefix = createUniqueMaskPrefix(text, 'VCP_UNCLOSED_FENCE');
        const fenceMasks = [];
        const fenceRanges = findFenceRangesOutsideProtocolWalls(text, {
            extraWallPattern: options.extraWallPattern,
        });
        const maskedFence = applyMaskRanges(text, fenceRanges, (chunk) => {
            const token = `${fencePrefix}${fenceMasks.length}__`;
            fenceMasks.push({ token, content: chunk });
            return token;
        });
        const { text: maskedWork, masks: inlineMasks } = maskInlineBackticks(maskedFence, 'VCP_UNCLOSED_INLINE');

        let work = maskedWork;
        let unclosedCursor = 0;
        const wallParts = [
            '^[ \\t]*<<<\\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|USER|ASSISTANT)\\]>>>',
            '^[ \\t]*<{2,4}\\[TOOL_REQUEST(?:_ESCAPE)?\\]>{2,4}',
        ];
        if (options.extraWallPattern) {
            wallParts.push(options.extraWallPattern);
        }
        const wallRe = new RegExp(wallParts.join('|'), 'im');
        const allowFuzzyStart = Boolean(options.allowFuzzyStart);

        while (unclosedCursor < work.length) {
            const unclosed = findUnclosedFn(work.slice(unclosedCursor), {
                allowFuzzyStart,
                stopAtProtocolWalls: true,
            });
            if (unclosed == null) break;
            const relStart = typeof unclosed === 'number' ? unclosed : (unclosed.startIndex ?? unclosed.start);
            if (!Number.isInteger(relStart)) break;
            const start = unclosedCursor + relStart;
            const openMatch = /^<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/i.exec(work.slice(start));
            const markerLen = openMatch ? openMatch[0].length : '<<<[TOOL_REQUEST]>>>'.length;
            if (!shouldStripUnclosedToolRequest(work, start, markerLen)) {
                unclosedCursor = start + markerLen;
                continue;
            }
            const rest = work.slice(start);
            const wallMatch = wallRe.exec(rest.slice(markerLen));
            if (wallMatch) {
                work = work.slice(0, start) + '\n' + rest.slice(markerLen + wallMatch.index);
                unclosedCursor = start + 1;
            } else {
                work = work.slice(0, start);
                break;
            }
        }

        return unmaskProtectedRegions(
            unmaskInlineBackticks(work, inlineMasks),
            fenceMasks
        );
    }

    function extractTextFromMultimodalContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter(part => part && (part.type === 'text' || part.type === 'output_text' || part.type === undefined) && typeof part.text === 'string')
                .map(part => part.text)
                .join('\n');
        }
        if (content && typeof content.text === 'string') return content.text;
        return '';
    }

    return Object.freeze({
        INFO_START,
        INFO_END,
        isLineLeadingBlank,
        isLineTrailingBlank,
        findNestedVcpInfoRanges,
        findClosedFenceAndToolRanges,
        applyMaskRanges,
        maskProtectedRegions,
        unmaskProtectedRegions,
        isGuidanceErrorInfoBlock,
        isToolResultHidden,
        stripThoughtChains,
        stripHiddenToolResults,
        stripErrorSummaryItemsInSummaryBlocks,
        stripResilienceNoiseFromMasked,
        stripProtocolResilienceNoise,
        extractTextFromMultimodalContent,
        createUniqueMaskPrefix,
        maskInlineBackticks,
        unmaskInlineBackticks,
        blankInlineBackticksOutsideFences,
        shouldStripUnclosedToolRequest,
        findSafeClosedFenceRanges,
        findFenceRangesOutsideProtocolWalls,
        stripUnclosedToolRequestsSafe,
    });
});
