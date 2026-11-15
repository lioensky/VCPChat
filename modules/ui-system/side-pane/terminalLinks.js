/**
 * modules/ui-system/side-pane/terminalLinks.js
 * 终端里的 http(s) 链接识别：把 xterm 缓冲区里（含自动换行的多行）的 URL 找出来，交给 link provider。
 *
 * 移植自 ZCode `packages/ui/src/terminal/terminalLinks.ts`（zai-org/ZCode，Apache-2.0），
 * 由 TypeScript 改写为原生 JS；逻辑不变。
 */

'use strict';

const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]/;
const CLOSING_BRACKET_PAIRS = { ')': '(', ']': '[', '}': '{' };
// 超预算只取消自动链接，不截断文本/URL；最多扫描这数量的终端单元格。
const MAX_LINK_SCAN_CELLS = 16 * 1024;

/** 去掉 URL 末尾的标点；括号只在闭合多于开启时才剥掉。 */
export function trimTerminalUrlCandidate(value) {
    const text = String(value);
    const counts = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
    for (const char of text) {
        if (Object.hasOwn(counts, char)) counts[char]++;
    }
    let end = text.length;
    while (end > 0) {
        const last = text[end - 1];
        if (TRAILING_PUNCTUATION_PATTERN.test(last)) { end--; continue; }
        const opening = CLOSING_BRACKET_PAIRS[last];
        if (!opening || counts[last] <= counts[opening]) break;
        counts[last]--;
        end--;
    }
    return text.slice(0, end);
}

export function findHttpLinksInTerminalText(text) {
    const links = [];
    for (const match of String(text).matchAll(HTTP_URL_PATTERN)) {
        const startIndex = match.index ?? 0;
        const trimmed = trimTerminalUrlCandidate(match[0]);
        if (!trimmed) continue;
        links.push({ text: trimmed, startIndex, endIndex: startIndex + trimmed.length - 1 });
    }
    return links;
}

export function isHttpTerminalUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_error) {
        return false;
    }
}

function appendBufferLine(snapshot, line, bufferLine, cols) {
    const reusableCell = line.getCell(0);
    for (let cellX = 0; cellX < cols; cellX += 1) {
        const current = line.getCell(cellX, reusableCell);
        if (!current || current.getWidth() === 0) continue;
        const text = current.getChars() || ' ';
        snapshot.text += text;
        for (let index = 0; index < text.length; index += 1) snapshot.positions.push((bufferLine - 1) * cols + cellX);
    }
}

function getWrappedLineRange(buffer, bufferLineNumber, cols) {
    if (!Number.isInteger(cols) || cols <= 0 || cols > MAX_LINK_SCAN_CELLS
        || !Number.isInteger(bufferLineNumber) || bufferLineNumber < 1 || bufferLineNumber > buffer.length) return null;
    const maxRows = Math.floor(MAX_LINK_SCAN_CELLS / cols);
    let start = bufferLineNumber - 1;
    let end = start;
    while (start > 0 && buffer.getLine(start)?.isWrapped) {
        if (end - start + 1 >= maxRows) return null;
        start--;
    }
    while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) {
        if (end - start + 1 >= maxRows) return null;
        end++;
    }
    return { start, end };
}

function readWrappedLineSnapshot(buffer, bufferLineNumber, cols) {
    const range = getWrappedLineRange(buffer, bufferLineNumber, cols);
    if (!range) return null;
    const { start, end } = range;
    const snapshot = { text: '', positions: [] };
    for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
        const line = buffer.getLine(lineIndex);
        if (!line) return null;
        appendBufferLine(snapshot, line, lineIndex + 1, cols);
    }
    return snapshot;
}

/** xterm `registerLinkProvider` 的数据部分：返回 bufferLineNumber 这一行上的链接（没有则 undefined）。 */
export function getHttpLinksForTerminalBufferLine(buffer, bufferLineNumber, cols) {
    const snapshot = readWrappedLineSnapshot(buffer, bufferLineNumber, cols);
    if (!snapshot || !snapshot.text) return undefined;
    const links = [];
    for (const match of findHttpLinksInTerminalText(snapshot.text)) {
        const start = snapshot.positions[match.startIndex];
        const end = snapshot.positions[match.endIndex];
        if (start === undefined || end === undefined) continue;
        const link = {
            text: match.text,
            range: {
                start: { x: start % cols + 1, y: Math.floor(start / cols) + 1 },
                end: { x: end % cols + 1, y: Math.floor(end / cols) + 1 }
            },
            // xterm 只在 hover 时绘制装饰：显式打开下划线和手型，链接才不会看起来像普通文本
            decorations: { underline: true, pointerCursor: true }
        };
        if (link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber) links.push(link);
    }
    return links.length > 0 ? links : undefined;
}
