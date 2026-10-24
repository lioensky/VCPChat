// 全局快捷键的写法转换：Electron accelerator ↔ 界面上看到的字、按键事件。
// 只做纯计算，给 settings/shortcuts.js 和介绍那行字用。

export const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '');

export function formatAccelerator(accelerator) {
    if (!accelerator) return '';
    return accelerator
        .replace('CommandOrControl', IS_MAC ? 'Cmd' : 'Ctrl')
        .replace('Super', IS_MAC ? 'Cmd' : 'Win')
        .split('+').join(' + ');
}

// KeyboardEvent → Electron accelerator 写法；只按了修饰键时返回 null
export function acceleratorFromEvent(e) {
    const code = e.code || '';
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit\d$/.test(code)) key = code.slice(5);
    else if (/^Numpad\d$/.test(code)) key = code.slice(6);
    else if (/^F\d{1,2}$/.test(code)) key = code;
    else {
        key = {
            Space: 'Space', Tab: 'Tab', Enter: 'Enter', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
            PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
            Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
            Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
        }[code] || null;
    }
    if (!key) return null;
    const parts = [];
    if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push('CommandOrControl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (!IS_MAC && e.metaKey) parts.push('Super');
    parts.push(key);
    return parts.join('+');
}
