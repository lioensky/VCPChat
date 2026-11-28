/**
 * Frontend Pele/Mermaid diagram normalization and opt-in sidecar AI repair.
 * Repair requests explicitly disable VCP and native tool use.
 */

import { decodeHtmlEntities, shouldTreatCodeTagAsMermaid } from '../chat/contentTransforms.js';
import { collectToolDataRanges } from './toolResultRegions.js';
import { TOOL_REQUEST_START_MARKER, scanToolRequestEnd } from './toolRequestScanner.js';
import { collectMarkdownCodeDomains } from './markdownCodeDomainScanner.js';

const CODE_ATTR_PATTERN = '((?:"[^"]*"|\'[^\']*\'|[^\'">])*)';
const MERMAID_CODE_TAG_PREFIX_RE = new RegExp(`<code${CODE_ATTR_PATTERN}>\\s*(flowchart|graph|mermaid)(\\s+)([\\s\\S]*?)<\\/code>`, 'gi');
const MERMAID_CODE_TAG_BARE_RE = new RegExp(`<code${CODE_ATTR_PATTERN}>([\\s\\S]*?)<\\/code>`, 'gi');
const KNOWN_DIAGRAM_START_RE = /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|sankey(?:-beta)?|xychart(?:-beta)?|block-beta)\b/i;

function normalizeLineEndings(value) {
    return String(value ?? '').replace(/\r\n/g, '\n');
}

function normalizeSmartDashes(value) {
    return String(value ?? '').replace(/[—–－]/g, '--');
}

function encodeHtmlEntities(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function findDiagramHeader(normalizedCode) {
    const lines = normalizedCode.split('\n');
    let inFrontmatter = false;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (i === 0 && trimmed === '---') {
            inFrontmatter = true;
            continue;
        }
        if (inFrontmatter) {
            if (trimmed === '---' || trimmed === '...') inFrontmatter = false;
            continue;
        }
        if (trimmed.startsWith('%%')) continue;
        return trimmed;
    }
    return '';
}

function splitSubgraphInlineComment(rawRest) {
    let inDoubleQuote = false;
    for (let i = 0; i < rawRest.length - 1; i++) {
        const ch = rawRest[i];
        if (ch === '"' && rawRest[i - 1] !== '\\') {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }
        if (!inDoubleQuote && ch === '%' && rawRest[i + 1] === '%') {
            const titleRaw = rawRest.slice(0, i);
            const trailing = rawRest.slice(i);
            const wsMatch = titleRaw.match(/(\s*)$/);
            const spacer = wsMatch ? wsMatch[1] : '';
            return {
                title: titleRaw.slice(0, titleRaw.length - spacer.length),
                commentSuffix: spacer + trailing,
            };
        }
    }
    return { title: rawRest, commentSuffix: '' };
}

/**
 * Layer 1 deterministic normalization for Pele/Mermaid source code.
 * Only intended as a fallback after initial rendering throws, or as a final
 * micro-cleanup on LLM output.
 *
 * @param {string} code
 * @returns {string}
 */
export function normalizePeleSource(code) {
    let normalized = normalizeSmartDashes(normalizeLineEndings(code));
    const header = findDiagramHeader(normalized);
    if (!/^(?:flowchart|graph)\b/i.test(header)) {
        return normalized;
    }

    let inMultilineQuote = false;
    normalized = normalized
        .split('\n')
        .map((line) => {
            const wasInMultilineQuote = inMultilineQuote;
            for (let i = 0; i < line.length; i++) {
                if (line[i] === '"' && line[i - 1] !== '\\') {
                    inMultilineQuote = !inMultilineQuote;
                }
            }
            if (wasInMultilineQuote) return line;

            const match = line.match(/^(\s*subgraph\s+)(.+?)(\s*)$/i);
            if (!match) return line;
            const [, prefix, rest, suffix] = match;
            const { title, commentSuffix } = splitSubgraphInlineComment(rest);
            const trimmedTitle = title.trim();
            if (!trimmedTitle) return line;

            // Already a single quoted title (`subgraph "Title"`).
            if (/^"[^"]+"$/.test(trimmedTitle)) return line;

            // `subgraph id [Title]` or `subgraph "id" [Title]`: preserve IDs and quote bracket label when needed.
            const idBracketMatch = trimmedTitle.match(/^("[^"]+"|[^\s\[\]"]+)\s*\[([\s\S]*)\]$/);
            if (idBracketMatch) {
                const [, idPart, rawLabel] = idBracketMatch;
                const inner = rawLabel.trim();
                if (/^"[^"]*"$/.test(inner)) return line;
                if (!/[()（）"]/.test(inner)) return line;
                return `${prefix}${idPart} ["${inner.replace(/"/g, "'")}"]${commentSuffix}${suffix}`;
            }

            // Single plain identifier (`subgraph sg1`).
            if (/^[A-Za-z0-9_.\-]+$/.test(trimmedTitle)) return line;

            const safeTitle = trimmedTitle.replace(/"/g, "'");
            return `${prefix}"${safeTitle}"${commentSuffix}${suffix}`;
        })
        .join('\n');
    return normalized;
}

/**
 * Build minimal, tool-free messages for the opt-in small chart-repair model.
 *
 * @param {string} code
 * @param {string} errorMessage
 * @returns {Array<{role: 'system'|'user', content: string}>}
 */
export function buildMermaidRepairMessages(code, errorMessage) {
    const cleanCode = normalizeLineEndings(code).trim();
    const cleanError = String(errorMessage || 'Unknown syntax error').trim();
    return [
        {
            role: 'system',
            content: [
                '[[VCPToolUse=Forbidden]]',
                '你是前端图表语法修复助手。前端使用 **Pele** 渲染器（兼容 Mermaid 核心语法，词法解析对引号、关键字和块闭合较严格）。',
                '请根据给定的渲染报错和 `^` 指针位置，理解出错原因并做最小必要的完整修正，保留原有结构、节点含义与文案。',
                '',
                '通用准则（请结合具体报错自主判断修复，不限于固定套路）：',
                '1. 观察 `^` 所指位置与期望 token（Expecting ...），定位真正导致解析卡住的字符或结构；允许对冲突的节点 ID（如 `end` 改名）、多余字符、非法格式或缺失的 `end` 闭合做必要调整。',
                '2. `subgraph` 标题或节点 `[]`/`()`/`{}` 内若包含空格、括号 `()（）`、冒号、斜杠或特殊符号，使用双引号 `""` 包裹（内部若原有双引号可改用单引号）。',
                '3. 流程图使用标准箭头（`-->`、`-.->`、`==>`），避免单横线 `->` 或中文破折号 `—>`。',
                '4. 简短思考定位后，只输出修复后的完整源码（放在单个 ```mermaid 代码块内），不要附带解释说明。',
            ].join('\n'),
        },
        {
            role: 'user',
            content: `Pele 渲染报错：\n${cleanError}\n\n请修复以下图表源码：\n\`\`\`mermaid\n${cleanCode}\n\`\`\``,
        },
    ];
}

function stripReasoningBlocks(text) {
    let cleaned = String(text ?? '')
        .replace(/<(think(?:ing)?|thought(?:s)?)>[\s\S]*?<\/\1>/gi, '\n')
        .replace(/\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][\s\S]*?\[--- 元思考链结束 ---\]/g, '\n');
    // Only strip a dangling leading `...</think>` closing tag before the first code fence
    // (never strip literal `</think>` appearing inside diagram node labels or fenced blocks).
    const fenceIdx = cleaned.search(/(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/);
    const head = fenceIdx === -1 ? cleaned : cleaned.slice(0, fenceIdx);
    const tail = fenceIdx === -1 ? '' : cleaned.slice(fenceIdx);
    const strippedHead = fenceIdx === -1 && KNOWN_DIAGRAM_START_RE.test(head.trim())
        ? head
        : head.replace(/^[\s\S]*?<\/(?:think(?:ing)?|thought(?:s)?)>/i, '');
    return (strippedHead + tail).trim();
}

function splitFenceDomainParts(slice) {
    const firstNewline = slice.indexOf('\n');
    if (firstNewline === -1) return null;
    const openingLine = slice.slice(0, firstNewline).replace(/\r$/, '');
    const openMatch = openingLine.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (!openMatch) return null;
    const infoString = openMatch[2].trim();
    const rest = slice.slice(firstNewline + 1);
    const closingMatch = rest.match(/\r?\n[ \t]*(?:`{3,}|~{3,})[ \t]*\r?\n?$/);
    if (!closingMatch) return null;
    const body = rest.slice(0, rest.length - closingMatch[0].length);
    return { infoString, body };
}

/**
 * Extract pure Mermaid/Pele diagram source from a model reply.
 * Strips `<think>` reasoning blocks, handles variable-length fences & `~~~`,
 * prefers the last matching diagram fence when explanations precede the fix,
 * and handles unclosed fences cleanly.
 *
 * @param {string} replyText
 * @returns {string}
 */
export function extractMermaidCodeFromReply(replyText) {
    const raw = normalizeLineEndings(replyText).trim();
    if (!raw) return '';

    const stripped = stripReasoningBlocks(raw) || raw;
    const domains = collectMarkdownCodeDomains(stripped).filter((d) => d.kind === 'fence' && d.closed);
    if (domains.length > 0) {
        const candidates = [];
        for (const domain of domains) {
            const parts = splitFenceDomainParts(stripped.slice(domain.start, domain.end));
            if (!parts) continue;
            const body = parts.body.trim();
            if (!body) continue;
            const lang = parts.infoString.split(/\s+/)[0].toLowerCase();
            const isMermaidLang = lang === 'mermaid' || lang === 'flowchart' || lang === 'graph';
            const looksLikeDiagram = KNOWN_DIAGRAM_START_RE.test(body);
            candidates.push({ body, score: (isMermaidLang ? 2 : 0) + (looksLikeDiagram ? 1 : 0) });
        }

        const strong = candidates.filter((c) => c.score >= 2);
        if (strong.length > 0) return strong[strong.length - 1].body;

        const fallbackDiagram = candidates.filter((c) => c.score >= 1);
        if (fallbackDiagram.length > 0) return fallbackDiagram[fallbackDiagram.length - 1].body;

        if (candidates.length > 0) return candidates[candidates.length - 1].body;
    }

    const unclosedFenceMatch = stripped.match(/(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*)$/);
    if (unclosedFenceMatch) {
        return unclosedFenceMatch[2]
            .replace(/\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/, '')
            .trim();
    }

    return stripped
        .replace(/^(?:`{3,}|~{3,})[^\n]*\n?/i, '')
        .replace(/\n?(?:`{3,}|~{3,})[ \t]*$/g, '')
        .trim();
}

function maskRangePreservingNewlines(text, start, end) {
    return text.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ') + text.slice(end);
}

function collectThoughtRangesOutsideFences(scanText) {
    const lineRegex = /.*(?:\r\n|\n|\r|$)/g;
    const ranges = [];
    let activeFence = null;
    let activeThought = null;
    let lineMatch;

    while ((lineMatch = lineRegex.exec(scanText)) !== null) {
        const line = lineMatch[0];
        if (line === '' && lineMatch.index === scanText.length) break;

        const lineWithoutEnding = line.replace(/\r\n|\n|\r$/, '');
        const fenceMatch = lineWithoutEnding.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            const trailingText = fenceMatch[2] || '';
            if (!activeFence) {
                activeFence = { char: marker[0], length: marker.length };
            } else if (marker[0] === activeFence.char && marker.length >= activeFence.length && trailingText.trim() === '') {
                activeFence = null;
            }
            continue;
        }
        if (activeFence) continue;

        if (!activeThought) {
            if (/^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*$/.test(lineWithoutEnding)) {
                activeThought = { start: lineMatch.index, type: 'custom' };
            } else if (/^[ \t]*<(think(?:ing)?|thought(?:s)?)>[ \t]*$/i.test(lineWithoutEnding)) {
                activeThought = { start: lineMatch.index, type: 'conventional' };
            }
            continue;
        }

        const isEnd = activeThought.type === 'custom'
            ? /^[ \t]*\[--- 元思考链结束 ---\][ \t]*$/.test(lineWithoutEnding)
            : /^[ \t]*<\/(?:think(?:ing)?|thought(?:s)?)>[ \t]*$/i.test(lineWithoutEnding);
        if (isEnd) {
            ranges.push({ start: activeThought.start, end: lineMatch.index + line.length });
            activeThought = null;
        }
    }

    return ranges;
}

function collectToolRequestRangesOutsideFences(text) {
    if (!text.includes(TOOL_REQUEST_START_MARKER)) return [];
    const fenceDomains = collectMarkdownCodeDomains(text).filter((d) => d.kind === 'fence');
    const ranges = [];
    let cursor = 0;

    while (cursor < text.length) {
        const startIndex = text.indexOf(TOOL_REQUEST_START_MARKER, cursor);
        if (startIndex === -1) break;
        const enclosingFence = fenceDomains.find((d) => startIndex >= d.start && startIndex < d.end);
        if (enclosingFence) {
            cursor = enclosingFence.end;
            continue;
        }
        const contentStart = startIndex + TOOL_REQUEST_START_MARKER.length;
        const scan = scanToolRequestEnd(text, contentStart);
        if (scan.status !== 'complete') {
            cursor = contentStart;
            continue;
        }
        ranges.push({ start: startIndex, end: scan.endIndex });
        cursor = scan.endIndex;
    }

    return ranges;
}

/**
 * Mask tool results, thought chains, and tool requests strictly preserving string length
 * and 1-to-1 character offsets with `rawText`.
 *
 * @param {string} rawText
 * @returns {string}
 */
function maskProtectedRegions(rawText) {
    let masked = rawText;

    const toolRanges = collectToolDataRanges(rawText);
    for (let i = toolRanges.length - 1; i >= 0; i--) {
        masked = maskRangePreservingNewlines(masked, toolRanges[i].start, toolRanges[i].end);
    }

    const thoughtRanges = collectThoughtRangesOutsideFences(masked);
    for (let i = thoughtRanges.length - 1; i >= 0; i--) {
        masked = maskRangePreservingNewlines(masked, thoughtRanges[i].start, thoughtRanges[i].end);
    }

    const requestRanges = collectToolRequestRangesOutsideFences(masked);
    for (let i = requestRanges.length - 1; i >= 0; i--) {
        masked = maskRangePreservingNewlines(masked, requestRanges[i].start, requestRanges[i].end);
    }

    return masked;
}

function blockMatchesOriginal(candidateBody, normalizedOriginal) {
    const normalizedBody = normalizeLineEndings(candidateBody).trim();
    if (!normalizedBody) return false;
    if (normalizedBody === normalizedOriginal) return true;
    return normalizeSmartDashes(normalizedBody) === normalizedOriginal;
}

function matchMermaidFenceDomain(rawSlice, normOriginal, cleanFixed) {
    const firstNewline = rawSlice.indexOf('\n');
    if (firstNewline === -1) return null;

    const openingWithNl = rawSlice.slice(0, firstNewline + 1);
    const openMatch = openingWithNl.match(/^([ \t]{0,3}(?:`{3,}|~{3,})[^\S\n]*(mermaid|flowchart|graph)[^\S\n]*\r?\n)$/i);
    if (!openMatch) return null;

    const rest = rawSlice.slice(firstNewline + 1);
    const closingMatch = rest.match(/(\r?\n[ \t]*(?:`{3,}|~{3,})[ \t]*\r?\n?)$/);
    if (!closingMatch) return null;

    const body = rest.slice(0, rest.length - closingMatch[0].length);
    if (!blockMatchesOriginal(body, normOriginal)) return null;

    const lineBreak = openingWithNl.includes('\r\n') ? '\r\n' : '\n';
    const formattedFixed = cleanFixed.replace(/\r?\n/g, lineBreak);
    return `${openingWithNl}${formattedFixed}${closingMatch[0]}`;
}

function findFirstMatchReplacement(maskedText, rawText, originalCode, fixedCode) {
    const normOriginal = normalizeLineEndings(originalCode).trim();
    const cleanFixed = normalizeLineEndings(fixedCode).trim();
    if (!normOriginal || !cleanFixed) return null;

    // 1. Scan top-level Markdown code domains outside protected regions.
    // Nested fences inside ````markdown blocks stay safely ignored.
    const codeDomains = collectMarkdownCodeDomains(maskedText);
    for (const domain of codeDomains) {
        if (domain.kind !== 'fence' || !domain.closed) continue;
        const slice = rawText.slice(domain.start, domain.end);
        const replacement = matchMermaidFenceDomain(slice, normOriginal, cleanFixed);
        if (replacement !== null) {
            return { start: domain.start, end: domain.end, replacement };
        }
    }

    // 2. Mask all Markdown fences/inline spans before checking HTML <code> tags.
    let codeTagScanText = maskedText;
    for (let i = codeDomains.length - 1; i >= 0; i--) {
        codeTagScanText = maskRangePreservingNewlines(codeTagScanText, codeDomains[i].start, codeDomains[i].end);
    }

    let m;
    MERMAID_CODE_TAG_PREFIX_RE.lastIndex = 0;
    while ((m = MERMAID_CODE_TAG_PREFIX_RE.exec(codeTagScanText)) !== null) {
        const [fullMatch, attrs, keyword, ws, innerBody] = m;
        if (!shouldTreatCodeTagAsMermaid(attrs, keyword, innerBody)) continue;
        const candidate = keyword.toLowerCase() === 'mermaid' ? innerBody : `${keyword}${ws}${innerBody}`;
        if (!blockMatchesOriginal(decodeHtmlEntities(candidate), normOriginal)
            && !blockMatchesOriginal(decodeHtmlEntities(innerBody), normOriginal)) {
            continue;
        }
        const lineBreak = fullMatch.includes('\r\n') ? '\r\n' : '\n';
        const formattedFixed = encodeHtmlEntities(cleanFixed.replace(/\r?\n/g, lineBreak));
        return {
            start: m.index,
            end: m.index + fullMatch.length,
            replacement: `<code${attrs}>mermaid${lineBreak}${formattedFixed}${lineBreak}</code>`,
        };
    }

    MERMAID_CODE_TAG_BARE_RE.lastIndex = 0;
    while ((m = MERMAID_CODE_TAG_BARE_RE.exec(codeTagScanText)) !== null) {
        const [fullMatch, attrs, body] = m;
        const decoded = decodeHtmlEntities(body);
        const hasMermaidClass = /\bclass\s*=\s*(?:"[^"]*\b(?:language-)?mermaid\b[^"]*"|'[^']*\b(?:language-)?mermaid\b[^']*')/i.test(attrs || '');
        const isMultilineDiagram = KNOWN_DIAGRAM_START_RE.test(decoded.trim()) && /\r?\n/.test(decoded);
        if (!hasMermaidClass && !isMultilineDiagram) continue;
        if (!blockMatchesOriginal(decoded, normOriginal)) continue;
        const lineBreak = fullMatch.includes('\r\n') ? '\r\n' : '\n';
        const formattedFixed = encodeHtmlEntities(cleanFixed.replace(/\r?\n/g, lineBreak));
        return {
            start: m.index,
            end: m.index + fullMatch.length,
            replacement: `<code${attrs}>mermaid${lineBreak}${formattedFixed}${lineBreak}</code>`,
        };
    }

    return null;
}

function replaceFirstMatchingMermaidBlockInText(rawText, originalCode, fixedCode) {
    if (typeof rawText !== 'string' || !rawText) {
        return { updated: false, text: rawText };
    }

    const masked = maskProtectedRegions(rawText);
    const hit = findFirstMatchReplacement(masked, rawText, originalCode, fixedCode);
    if (!hit) {
        return { updated: false, text: rawText };
    }

    return {
        updated: true,
        text: rawText.slice(0, hit.start) + hit.replacement + rawText.slice(hit.end),
    };
}

/**
 * Replace the matching broken Mermaid block inside string or structured `{ text }` content,
 * skipping protected thought chains, tool results, tool requests, and non-mermaid code fences.
 *
 * @param {string|{text?: string}} rawContent
 * @param {string} originalCode
 * @param {string} fixedCode
 * @returns {{ updated: boolean, content: string|object }}
 */
export function replaceMermaidBlockInMessageContent(rawContent, originalCode, fixedCode) {
    if (typeof rawContent === 'string') {
        const result = replaceFirstMatchingMermaidBlockInText(rawContent, originalCode, fixedCode);
        return { updated: result.updated, content: result.text };
    }

    if (rawContent && typeof rawContent === 'object' && typeof rawContent.text === 'string') {
        const result = replaceFirstMatchingMermaidBlockInText(rawContent.text, originalCode, fixedCode);
        if (!result.updated) {
            return { updated: false, content: rawContent };
        }
        return {
            updated: true,
            content: {
                ...rawContent,
                text: result.text,
            },
        };
    }

    return { updated: false, content: rawContent };
}

/**
 * Patch a persisted/in-memory chat message in-place, synchronizing `assistantSegments`
 * (when present) and `content` so hosted tool replay stays consistent.
 *
 * @param {object} message
 * @param {string} originalCode
 * @param {string} fixedCode
 * @returns {{ updated: boolean, message: object }}
 */
export function patchMessageMermaidContent(message, originalCode, fixedCode) {
    if (!message || typeof message !== 'object') {
        return { updated: false, message };
    }

    if (Array.isArray(message.assistantSegments) && message.assistantSegments.length > 0) {
        let segmentUpdated = false;
        const originalFlat = message.assistantSegments.map((seg) => seg?.content ?? '').join('');
        const nextSegments = message.assistantSegments.map((seg) => {
            if (segmentUpdated || !seg || seg.receipt || typeof seg.content !== 'string') {
                return seg;
            }
            const segResult = replaceFirstMatchingMermaidBlockInText(seg.content, originalCode, fixedCode);
            if (!segResult.updated) return seg;
            segmentUpdated = true;
            return { ...seg, content: segResult.text };
        });

        if (segmentUpdated) {
            const nextFlat = nextSegments.map((seg) => seg?.content ?? '').join('');
            let nextContent = message.content;
            if (typeof message.content === 'string') {
                if (message.content === originalFlat) {
                    nextContent = nextFlat;
                } else {
                    const contentResult = replaceMermaidBlockInMessageContent(message.content, originalCode, fixedCode);
                    nextContent = contentResult.updated ? contentResult.content : nextFlat;
                }
            } else if (message.content && typeof message.content === 'object') {
                const contentResult = replaceMermaidBlockInMessageContent(message.content, originalCode, fixedCode);
                if (contentResult.updated) nextContent = contentResult.content;
            }

            return {
                updated: true,
                message: {
                    ...message,
                    content: nextContent,
                    assistantSegments: nextSegments,
                },
            };
        }
    }

    const contentPatch = replaceMermaidBlockInMessageContent(message.content, originalCode, fixedCode);
    if (!contentPatch.updated) {
        return { updated: false, message };
    }

    return {
        updated: true,
        message: {
            ...message,
            content: contentPatch.content,
        },
    };
}

function tryRenderWithPele(peleApi, candidateCode) {
    if (!peleApi || typeof peleApi.render !== 'function') {
        return { ok: false, error: new Error('本地 Pele 渲染依赖未加载。') };
    }
    try {
        const rendered = peleApi.render(candidateCode);
        if (rendered && typeof rendered.svg === 'string' && rendered.svg.trim()) {
            return { ok: true, code: candidateCode, svg: rendered.svg };
        }
        return { ok: false, error: new Error('Pele 返回空 SVG。') };
    } catch (primaryError) {
        const normalized = normalizePeleSource(candidateCode);
        if (normalized !== candidateCode) {
            try {
                const rendered = peleApi.render(normalized);
                if (rendered && typeof rendered.svg === 'string' && rendered.svg.trim()) {
                    return { ok: true, code: normalized, svg: rendered.svg };
                }
            } catch {
                // Keep primary syntax error so caller sees exact parse failure.
            }
        }
        return { ok: false, error: primaryError };
    }
}

/**
 * Call the configured opt-in repair model and verify the result via local `pele.render`.
 *
 * @param {object} params
 * @returns {Promise<{ok: boolean, code?: string, svg?: string, model?: string, reason?: string, error?: string, candidateCode?: string}>}
 */
async function requestRepairCompletion({ chatUrl, headers, model, messages, signal, timeoutMs, fetchImpl }) {
    const requestController = new AbortController();
    let timedOut = false;
    let timeoutHandle = null;
    const onExternalAbort = () => {
        requestController.abort();
    };
    if (signal) {
        signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            requestController.abort();
        }, timeoutMs);
    }

    let response;
    try {
        response = await fetchImpl(chatUrl, {
            method: 'POST',
            headers,
            signal: requestController.signal,
            body: JSON.stringify({
                model,
                messages,
                tool_choice: 'none',
                function_call: null,
                temperature: 0.1,
                max_tokens: 4096,
                stream: false,
            }),
        });
    } catch (error) {
        if (timedOut) {
            return {
                ok: false,
                reason: 'timeout',
                error: '图表修复请求超时，请点击重试。',
            };
        }
        if (error?.name === 'AbortError' || signal?.aborted) {
            return { ok: false, reason: 'aborted', error: '图表修复请求已取消。' };
        }
        return { ok: false, reason: 'network-error', error: error?.message || '图表修复请求失败。' };
    } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', onExternalAbort);
    }

    if (!response.ok) {
        return { ok: false, reason: 'http-error', error: `图表修复请求失败 (${response.status})` };
    }

    try {
        const data = await response.json();
        return { ok: true, data };
    } catch (error) {
        return { ok: false, reason: 'invalid-json', error: error?.message || '无法解析修复模型响应。' };
    }
}

/**
 * Call the configured opt-in repair model and verify the result via local `pele.render`.
 * Uses local Pele compiler error feedback for up to `maxAttempts` (default 2) when
 * a small model leaves a secondary syntax error on its first draft.
 *
 * @param {object} params
 * @returns {Promise<{ok: boolean, code?: string, svg?: string, model?: string, reason?: string, error?: string, candidateCode?: string}>}
 */
export async function repairMermaidDiagram({
    code,
    errorMessage,
    settings,
    signal,
    timeoutMs = 30000,
    maxAttempts = 2,
    fetchImpl = globalThis.fetch,
    pele = globalThis.pele,
    vcpChatUrlFn = globalThis.vcpServerRoutes?.vcpChatUrl,
} = {}) {
    const model = typeof settings?.mermaidRepairModel === 'string' ? settings.mermaidRepairModel.trim() : '';
    if (!model) {
        return { ok: false, reason: 'disabled', error: '未选择图表修复模型。' };
    }

    const vcpServerUrl = typeof settings?.vcpServerUrl === 'string' ? settings.vcpServerUrl.trim() : '';
    if (!vcpServerUrl) {
        return { ok: false, reason: 'missing-endpoint', error: 'VCP 服务器地址未配置。' };
    }

    let chatUrl = '';
    try {
        chatUrl = typeof vcpChatUrlFn === 'function' ? vcpChatUrlFn(vcpServerUrl) : '';
    } catch (urlError) {
        return { ok: false, reason: 'missing-endpoint', error: urlError?.message || 'VCP 服务器地址无效。' };
    }
    if (!chatUrl) {
        return { ok: false, reason: 'missing-endpoint', error: 'VCP 服务器地址未配置或无效。' };
    }

    if (typeof fetchImpl !== 'function') {
        return { ok: false, reason: 'missing-fetch', error: '当前环境不支持网络请求。' };
    }

    if (!pele || typeof pele.render !== 'function') {
        return { ok: false, reason: 'missing-renderer', error: '本地 Pele 渲染依赖未加载。' };
    }

    if (signal?.aborted) {
        return { ok: false, reason: 'aborted', error: '图表修复请求已取消。' };
    }

    const headers = { 'Content-Type': 'application/json' };
    const apiKey = typeof settings?.vcpApiKey === 'string' ? settings.vcpApiKey.trim() : '';
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const totalAttempts = Math.max(1, Number(maxAttempts) || 1);
    const messages = buildMermaidRepairMessages(code, errorMessage);
    const startedAt = Date.now();
    let lastInvalid = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        const elapsed = Date.now() - startedAt;
        const remainingMs = Number.isFinite(timeoutMs) && timeoutMs > 0
            ? Math.max(1, timeoutMs - elapsed)
            : timeoutMs;
        if (Number.isFinite(timeoutMs) && timeoutMs > 0 && elapsed >= timeoutMs) {
            return {
                ok: false,
                reason: 'timeout',
                error: `图表修复请求超时（${Math.max(1, Math.round(timeoutMs / 1000))}s），请点击重试。`,
            };
        }

        const completion = await requestRepairCompletion({
            chatUrl,
            headers,
            model,
            messages,
            signal,
            timeoutMs: remainingMs,
            fetchImpl,
        });
        if (!completion.ok) {
            if (completion.reason === 'timeout') {
                return {
                    ...completion,
                    error: `图表修复请求超时（${Math.max(1, Math.round(timeoutMs / 1000))}s），请点击重试。`,
                };
            }
            return completion;
        }

        const rawReply = completion.data?.choices?.[0]?.message?.content;
        const candidateCode = extractMermaidCodeFromReply(rawReply);
        if (!candidateCode) {
            return { ok: false, reason: 'empty-response', error: '修复模型未返回有效图表源码。' };
        }
        if (candidateCode.length > 100000) {
            return { ok: false, reason: 'too-large', error: '修复后的图表源码超过 100,000 字符限制。' };
        }

        const verification = tryRenderWithPele(pele, candidateCode);
        if (verification.ok) {
            return {
                ok: true,
                code: verification.code,
                svg: verification.svg,
                model,
            };
        }

        lastInvalid = {
            ok: false,
            reason: 'invalid-syntax',
            error: verification.error?.message || '修复后的图表仍无法通过 Pele 渲染。',
            candidateCode,
        };

        if (attempt < totalAttempts) {
            messages.push(
                { role: 'assistant', content: `\`\`\`mermaid\n${candidateCode}\n\`\`\`` },
                {
                    role: 'user',
                    content: [
                        `上面修复后的图表仍无法通过 Pele 渲染，最新报错如下：`,
                        lastInvalid.error,
                        '',
                        '请根据 `^` 指针所指位置重新定位剩余语法问题并修正（保留原图语义），只输出完整的 ```mermaid 代码块。',
                    ].join('\n'),
                }
            );
        }
    }

    return lastInvalid;
}
