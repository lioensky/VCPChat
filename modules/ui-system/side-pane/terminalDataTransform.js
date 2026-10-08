/**
 * modules/ui-system/side-pane/terminalDataTransform.js
 * PSReadLine 行编辑重绘的背景修正：Windows PowerShell / PSReadLine 重绘当前输入行时，用 ANSI 40m（黑底）
 * 给行尾空白补背景；侧栏终端的背景不是 ANSI black，xterm 会把这些空白画成一条灰块，这里把 40 换回默认背景 49。
 *
 * 移植自 ZCode `packages/ui/src/terminal/terminalDataTransform.ts`（zai-org/ZCode，Apache-2.0），
 * 由 TypeScript 改写为原生 JS；逻辑不变，只是是否为 PowerShell 由调用方告知。
 */

'use strict';

const ESC = String.fromCharCode(0x1b);
const SGR_SEQUENCE_PATTERN = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');
const PSREADLINE_REDRAW_CURSOR_PATTERN = new RegExp(`${ESC}\\[\\d+;\\d+H`);
const PSREADLINE_DEFAULT_ON_BLACK_PATTERN = new RegExp(
    `${ESC}\\[(?:[0-9;]*;)?37(?:;[0-9;]*)?m[\\s\\S]*${ESC}\\[(?:[0-9;]*;)?40(?:;[0-9;]*)?m`
);

function replaceAnsiBlackBackgroundWithDefault(data) {
    return data.replace(SGR_SEQUENCE_PATTERN, (sequence, rawParams) => {
        const params = rawParams.length > 0 ? rawParams.split(';') : ['0'];
        let changed = false;
        const nextParams = params.map(param => {
            if (param !== '40') return param;
            changed = true;
            return '49';
        });
        return changed ? `${ESC}[${nextParams.join(';')}m` : sequence;
    });
}

/**
 * @param {string} data PTY 输出的一块
 * @param {boolean} powershell 会话是不是 PowerShell（共享终端在 Windows 上总是 pwsh / powershell）
 */
export function normalizePowerShellReadlineRedraw(data, powershell) {
    if (!powershell || typeof data !== 'string') return data;
    // 只认带光标定位、不换行、37…40m 的单行重绘，命令自己输出的黑底不动
    if (!data.includes(ESC) || data.includes('\n')) return data;
    if (!PSREADLINE_REDRAW_CURSOR_PATTERN.test(data)) return data;
    if (!PSREADLINE_DEFAULT_ON_BLACK_PATTERN.test(data)) return data;
    return replaceAnsiBlackBackgroundWithDefault(data);
}
