/**
 * modules/ui-system/side-pane/terminalLinks.js
 * 终端里的 http(s) 链接识别：把 xterm 缓冲区里（含自动换行的多行）的 URL 找出来，交给 link provider。
 *
 * 移植自 ZCode `packages/ui/src/terminal/terminalLinks.ts`（zai-org/ZCode，Apache-2.0），
 * 由 TypeScript 改写为原生 JS；逻辑不变。
 */

'use strict';

const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]+$/;
const CLOSING_BRACKET_PAIRS = { ')': '(', ']': '[', '}': '{' };

function countChar(value, char) {
    let count = 0;
    for (const current of value) {
        if (current === char) count += 1;
    }
    return count;
}

/** 去掉 URL 末尾的标点；括号只在闭合多于开启时才剥掉。 */
export function trimTerminalUrlCandidate(value) {
    let trimmed = String(value).replace(TRAILING_PUNCTUATION_PATTERN, '');
    for (;;) {
        const last = trimmed.slice(-1);
        const opening = last ? CLOSING_BRACKET_PAIRS[last] : undefined;
        if (!last || !opening) return trimmed;
        if (countChar(trimmed, last) <= countChar(trimmed, opening)) return trimmed;
        trimmed = trimmed.slice(0, -1).replace(TRAILING_PUNCTUATION_PATTERN, '');
    }
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
        for (let index = 0; index < text.length; index += 1) snapshot.positions.push({ bufferLine, cellX });
    }
}

function getWrappedLineRange(buffer, bufferLineNumber) {
    let start = bufferLineNumber - 1;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
    let end = bufferLineNumber - 1;
    while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end += 1;
    return { start, end };
}

function readWrappedLineSnapshot(buffer, bufferLineNumber, cols) {
    const { start, end } = getWrappedLineRange(buffer, bufferLineNumber);
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
        if (!start || !end) continue;
        const link = {
            text: match.text,
            range: {
                start: { x: start.cellX + 1, y: start.bufferLine },
                end: { x: end.cellX + 1, y: end.bufferLine }
            },
            // xterm 只在 hover 时绘制装饰：显式打开下划线和手型，链接才不会看起来像普通文本
            decorations: { underline: true, pointerCursor: true }
        };
        if (link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber) links.push(link);
    }
    return links.length > 0 ? links : undefined;
}
