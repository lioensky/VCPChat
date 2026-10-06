/* 终端输出清洗：纯函数，无 Electron、无文件系统副作用，执行器和命令运行记录共用。 */
'use strict';

/**
 * 按“安全的一维日志投影语义”清理输出，用于 AI 工具返回的 Markdown 摘要。
 *
 * 注意：GUI 路径必须继续接收原始 PTY 数据，由 xterm.js 处理完整 ANSI/VT 状态机。
 * 摘要层刻意不做跨行光标寻址模拟：PowerShell/PSReadLine 在长行、自动换行、
 * CJK 宽字符场景下会发出光标定位序列，半模拟很容易把正常 JSON/路径投影成
 * 大片空行或错位文本。这里仅处理最常见且低风险的日志语义：
 * - CR 原地刷新当前逻辑行
 * - LF/CRLF 稳定换行
 * - BS 退格
 * - CSI K 行内擦除
 * - SGR 颜色与其它 CSI/OSC 控制序列忽略
 *
 * @param {string} str - 原始终端输出。
 * @returns {string} - 适合放入 Markdown codeblock 的纯文本快照。
 */
function sanitizeTerminalOutput(str) {
    if (!str) {
        return '';
    }

    const normalized = String(str)
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '') // OSC 序列
        .replace(/\x00/g, '')                                  // null
        .replace(/\x07/g, '');                                 // bell

    const lines = [[]];
    let row = 0;
    let col = 0;

    const ensureRow = (targetRow) => {
        while (lines.length <= targetRow) {
            lines.push([]);
        }
    };

    const putChar = (char) => {
        ensureRow(row);
        lines[row][col] = char;
        col += 1;
    };

    const eraseInLine = (mode) => {
        ensureRow(row);
        if (mode === 1) {
            for (let i = 0; i <= col; i += 1) {
                lines[row][i] = undefined;
            }
            return;
        }

        if (mode === 2) {
            lines[row] = [];
            col = 0;
            return;
        }

        lines[row].length = col;
    };

    const parseFirstParam = (rawParams) => {
        const cleanedParams = (rawParams || '').replace(/[?>=]/g, '');
        const firstValue = cleanedParams.split(';')[0];
        const parsed = Number.parseInt(firstValue, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    };

    for (let i = 0; i < normalized.length; i += 1) {
        const char = normalized[i];

        if (char === '\u001b' || char === '\u009b') {
            const isC1Csi = char === '\u009b';
            const nextChar = normalized[i + 1];

            if (isC1Csi || nextChar === '[') {
                let cursor = i + (isC1Csi ? 1 : 2);
                let params = '';

                while (cursor < normalized.length && !/[\x40-\x7e]/.test(normalized[cursor])) {
                    params += normalized[cursor];
                    cursor += 1;
                }

                if (cursor >= normalized.length) {
                    break;
                }

                const finalByte = normalized[cursor];

                if (finalByte === 'K') {
                    eraseInLine(parseFirstParam(params));
                } else if (finalByte === 'G') {
                    const column = parseFirstParam(params) || 1;
                    col = Math.max(0, column - 1);
                }
                // 其它 CSI（含 SGR m、跨行 A/B/H/J、私有模式 h/l）在摘要层只剥离不应用，
                // 避免半终端状态机破坏普通长输出。真实 GUI 仍由 xterm.js 完整处理。

                i = cursor;
                continue;
            }

            // 非 CSI ESC 序列：跳过 ESC 和紧随的最终字节，避免污染摘要。
            if (nextChar) {
                i += 1;
            }
            continue;
        }

        if (char === '\r') {
            col = 0;
            if (normalized[i + 1] === '\n') {
                row += 1;
                ensureRow(row);
                i += 1;
            }
            continue;
        }

        if (char === '\n') {
            row += 1;
            ensureRow(row);
            continue;
        }

        if (char === '\b') {
            col = Math.max(0, col - 1);
            ensureRow(row);
            lines[row][col] = undefined;
            continue;
        }

        if (char === '\t') {
            const nextTabStop = col + (8 - (col % 8));
            while (col < nextTabStop) {
                putChar(' ');
            }
            continue;
        }

        if (char >= ' ' || char === '\u3000') {
            putChar(char);
        }
    }

    return lines
        .map((line) => line.map((cell) => cell || ' ').join('').replace(/[ \t]+$/g, ''))
        .join('\n');
}

module.exports = { sanitizeTerminalOutput };
