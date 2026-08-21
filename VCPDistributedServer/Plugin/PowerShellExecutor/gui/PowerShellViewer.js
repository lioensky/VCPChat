// PowerShellViewer.js

// --- 终端初始化 ---
const terminalContainer = document.getElementById('terminal-container');
const commandInput = document.getElementById('command-input');
const sendButton = document.getElementById('send-button');
const contextMenu = document.getElementById('terminal-context-menu');

// 创建 FitAddon 实例
const fitAddon = new FitAddon.FitAddon();

// 创建一个函数来获取CSS变量值
function getCssVariable(variable) {
    return getComputedStyle(document.body).getPropertyValue(variable).trim();
}

const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: {},
    allowTransparency: true,
    windowsMode: true,
    // 禁用内置的复制行为，我们将通过Electron API手动处理
    copyOnSelect: false 
});

// 将 FitAddon 加载到终端实例中
term.loadAddon(fitAddon);

// 将终端挂载到 HTML 容器中
term.open(terminalContainer);

// --- 功能函数 ---

let fitTimer = null;

function fitTerminal() {
    try {
        fitAddon.fit();
        // 在调整前端后，立即将新的尺寸发送到后端
        if (window.electronAPI) {
            window.electronAPI.send('powershell-resize', { cols: term.cols, rows: term.rows });
        }
    } catch (e) {
        console.error("Failed to fit terminal:", e);
    }
}

function scheduleFitTerminal(delay = 100) {
    if (fitTimer) {
        clearTimeout(fitTimer);
    }

    fitTimer = setTimeout(() => {
        fitTimer = null;
        fitTerminal();
    }, delay);
}

function sendCommand() {
    const command = commandInput.value;
    if (command.trim() && window.electronAPI) {
        // 真实 PTY 会自行回显输入；前端本地 echo 会导致重复字符和 TUI 状态错位。
        window.electronAPI.send('powershell-command', command);
        commandInput.value = '';
        term.focus();
    }
}

function copySelection() {
    const selection = term.getSelection();
    if (selection && window.electronAPI) {
        window.electronAPI.send('copy-to-clipboard', selection);
        return true;
    }
    return false;
}

async function pasteFromClipboard() {
    if (!window.electronAPI || typeof window.electronAPI.invoke !== 'function') {
        return;
    }

    try {
        const text = await window.electronAPI.invoke('read-from-clipboard');
        if (text) {
            window.electronAPI.send('powershell-input', text);
            term.focus();
        }
    } catch (error) {
        console.error('Failed to paste from clipboard:', error);
    }
}

function clearTerminal() {
    term.clear();
    term.focus();
}

function selectAllTerminal() {
    term.selectAll();
    term.focus();
}

function interruptCommand() {
    if (window.electronAPI) {
        window.electronAPI.send('powershell-input', '\x03');
        term.focus();
    }
}

function extractVisibleText(maxLines) {
    const buffer = term.buffer.active;
    const lines = [];
    const totalLines = buffer.length;
    const startLine = maxLines ? Math.max(0, totalLines - maxLines) : 0;
    
    for (let i = startLine; i < totalLines; i++) {
        const line = buffer.getLine(i);
        if (line) {
            lines.push(line.translateToString(true));
        }
    }
    return lines.join('\n').trim();
}

function hideContextMenu() {
    if (contextMenu) {
        contextMenu.hidden = true;
    }
}

function updateContextMenuState() {
    if (!contextMenu) {
        return;
    }

    const copyButton = contextMenu.querySelector('[data-action="copy"]');
    if (copyButton) {
        copyButton.disabled = !term.hasSelection();
    }
}

function showContextMenu(event) {
    if (!contextMenu) {
        return;
    }

    event.preventDefault();
    updateContextMenuState();

    contextMenu.hidden = false;
    const menuRect = contextMenu.getBoundingClientRect();
    const left = Math.min(event.clientX, window.innerWidth - menuRect.width - 8);
    const top = Math.min(event.clientY, window.innerHeight - menuRect.height - 8);

    contextMenu.style.left = `${Math.max(8, left)}px`;
    contextMenu.style.top = `${Math.max(8, top)}px`;
}

function handleContextMenuAction(action) {
    switch (action) {
        case 'copy':
            copySelection();
            break;
        case 'paste':
            pasteFromClipboard();
            break;
        case 'selectAll':
            selectAllTerminal();
            break;
        case 'clear':
            clearTerminal();
            break;
        case 'interrupt':
            interruptCommand();
            break;
        case 'refit':
            fitTerminal();
            term.focus();
            break;
        default:
            break;
    }

    hideContextMenu();
}

// --- IPC 与事件监听 ---

if (window.electronAPI) {
    // --- 查询可见文本 ---
    window.electronAPI.on('query-visible-text', ({ maxLines }) => {
        const text = extractVisibleText(maxLines);
        window.electronAPI.send('visible-text-response', text);
    });

    // --- 数据、清屏与主题 ---
    // 前端现在是一个纯粹的渲染器,所有状态和内容都由后端主导。
    window.electronAPI.on('powershell-data', (data) => {
        // 后端现在负责所有数据清理，前端只需直接写入即可。
        if (data) {
            term.write(data);
        }
    });

    window.electronAPI.on('powershell-clear', () => {
        term.clear();
    });
    window.electronAPI.on('theme-init', ({ themeName }) => {
        // 恢复主程序使用的标准主题切换逻辑：
        // 当 themeName 为 'light' 时，添加 'light-theme' 类；否则，移除该类以应用默认的深色主题。
        document.body.classList.toggle('light-theme', themeName === 'light');

        // 延迟执行以确保CSS变量已应用
        setTimeout(() => {
            term.options.theme = {
                background: 'transparent',
                foreground: getCssVariable('--primary-text'),
                cursor: getCssVariable('--highlight-text'),
                selectionBackground: getCssVariable('--accent-bg'),
                black: getCssVariable('--tertiary-bg'),
                red: getCssVariable('--danger-color'),
                green: getCssVariable('--success-color'),
                yellow: getCssVariable('--quoted-text'),
                blue: getCssVariable('--button-bg'),
                magenta: getCssVariable('--highlight-text'),
                cyan: getCssVariable('--secondary-text'),
                white: getCssVariable('--primary-text'),
                brightBlack: getCssVariable('--secondary-text'),
                brightRed: getCssVariable('--danger-hover-bg'),
                brightGreen: getCssVariable('--success-color'),
                brightYellow: getCssVariable('--quoted-text'),
                brightBlue: getCssVariable('--button-hover-bg'),
                brightMagenta: getCssVariable('--highlight-text'),
                brightCyan: getCssVariable('--secondary-text'),
                brightWhite: getCssVariable('--primary-text')
            };
            term.refresh(0, term.rows - 1);
        }, 100);
    });

    // --- 真实终端输入透传 ---
    term.onData((data) => {
        window.electronAPI.send('powershell-input', data);
    });

    terminalContainer.addEventListener('mousedown', () => {
        term.focus();
    });

    // --- 右键菜单与快捷键 ---
    terminalContainer.addEventListener('contextmenu', showContextMenu);

    document.addEventListener('click', (event) => {
        if (contextMenu && !contextMenu.hidden && !contextMenu.contains(event.target)) {
            hideContextMenu();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            hideContextMenu();
        }
    });

    if (contextMenu) {
        contextMenu.addEventListener('click', (event) => {
            const menuItem = event.target.closest('.context-menu-item');
            if (!menuItem || menuItem.disabled) {
                return;
            }

            handleContextMenuAction(menuItem.dataset.action);
        });
    }

    term.attachCustomKeyEventHandler((arg) => {
        if (arg.type !== 'keydown') {
            return true;
        }

        if (arg.ctrlKey && arg.shiftKey && arg.code === 'KeyC') {
            copySelection();
            return false;
        }

        if (arg.ctrlKey && arg.shiftKey && arg.code === 'KeyV') {
            pasteFromClipboard();
            return false;
        }

        if (arg.ctrlKey && arg.code === 'KeyC') {
            if (term.hasSelection()) {
                copySelection();
                return false;
            }

            return true; // 无选区时保留终端原生 Ctrl+C 中断行为
        }

        if (arg.ctrlKey && arg.code === 'KeyV') {
            pasteFromClipboard();
            return false;
        }

        if (arg.ctrlKey && arg.code === 'KeyL') {
            clearTerminal();
            return false;
        }

        return true;
    });

} else {
    console.error('Fatal Error: electronAPI not found.');
    term.writeln('Error: Could not connect to the backend.');
}

// --- 窗口与输入监听 ---
window.addEventListener('DOMContentLoaded', () => {
    fitTerminal();
    term.focus();
    if (window.electronAPI) {
        window.electronAPI.send('powershell-gui-ready');
    }

    // --- 自定义标题栏事件监听 ---
    const minimizeBtn = document.getElementById('minimize-btn');
    const maximizeBtn = document.getElementById('maximize-btn');
    const closeBtn = document.getElementById('close-btn');

    minimizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.minimizeWindow();
    });

    maximizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.maximizeWindow();
    });

    closeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.closeWindow();
    });
});
window.addEventListener('resize', () => scheduleFitTerminal(100));
if (sendButton && commandInput) {
    sendButton.addEventListener('click', sendCommand);
    commandInput.addEventListener('keydown', (event) => {
        // 当用户按下 Enter 键但没有同时按下 Shift 键时，发送命令
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // 阻止默认的 Enter 行为（例如，在 textarea 中换行）
            sendCommand();
        }
        // Shift+Enter 的默认行为就是在 textarea 中换行，所以我们不需要为它编写特殊逻辑
    });
}