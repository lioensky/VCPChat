const pty = require('node-pty');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BrowserWindow, ipcMain, clipboard } = require('electron');
const tmp = require('tmp');
const chokidar = require('chokidar');

// --- GUI Window Management ---
let guiWindow = null;

function ensureGuiWindow() {
    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.focus();
        return;
    }

    guiWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: 'VCP PowerShell Executor',
        frame: false, // 禁用窗口边框
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        webPreferences: {
            preload: path.join(__dirname, 'gui', 'preload.js'),
            nodeIntegration: false, // 禁用 Node.js 集成以增强安全性
            contextIsolation: true, // 启用上下文隔离
            spellcheck: false,
            // 将 node_modules 的路径作为参数传递给窗口，以便在 HTML 中使用
            additionalArguments: [`--node-modules-path=${path.join(__dirname, '..', '..', '..', '..', 'node_modules')}`]
        },
        autoHideMenuBar: true,
    });

    guiWindow.loadFile(path.join(__dirname, 'gui', 'PowerShellViewer.html'));

    guiWindow.on('closed', () => {
        guiWindow = null;
        // 当GUI关闭时，也终止关联的 pty 进程
        if (ptyProcess) {
            try {
                ptyProcess.kill();
                console.log('[PowerShellExecutor] GUI closed, associated pty process terminated.');
            } catch (e) {
                console.error('[PowerShellExecutor] Error terminating pty process on GUI close:', e);
            }
            // ptyProcess 的 onExit 事件处理器会自动将其设置为 null 并从 childProcesses 集合中移除
        }
    });
}

// --- 主题管理与文件监视 ---
const settingsPath = path.join(__dirname, '..', '..', '..', 'AppData', 'settings.json');
let settingsWatcher = null;
let lastSentTheme = null; // 用于存储上一次发送的主题名称

/**
 * 读取、比较并发送主题更新。
 * 只有当主题名称实际发生变化时，才会向GUI发送事件。
 * @param {Electron.WebContents} targetWebContents - 目标窗口的 webContents。
 * @param {boolean} [forceSend=false] - 是否强制发送，即使用于初始化。
 */
function sendThemeUpdate(targetWebContents, forceSend = false) {
    if (!targetWebContents || targetWebContents.isDestroyed()) {
        return;
    }
    try {
        let currentTheme = 'dark'; // 默认主题
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            currentTheme = settings.currentThemeMode || 'dark';
        }

        // 只有当主题变化或强制发送时，才进行通信
        if (currentTheme !== lastSentTheme || forceSend) {
            targetWebContents.send('theme-init', { themeName: currentTheme });
            lastSentTheme = currentTheme; // 更新已发送的主题记录
            console.log(`[PowerShellExecutor] Theme updated to: ${currentTheme}`);
        }
    } catch (error) {
        console.error('[PowerShellExecutor] Error reading or sending theme settings:', error);
    }
}

// 初始化文件监视器
function setupThemeWatcher() {
    if (settingsWatcher) {
        settingsWatcher.close();
    }
    settingsWatcher = chokidar.watch(settingsPath, {
        persistent: true,
        ignoreInitial: true
    });

    settingsWatcher.on('change', () => {
        if (guiWindow && !guiWindow.isDestroyed()) {
            sendThemeUpdate(guiWindow.webContents);
        }
    });
}

// 在插件加载时启动监视
setupThemeWatcher();


// 监听来自GUI的“就绪”信号
ipcMain.on('powershell-gui-ready', (event) => {
    // 当GUI准备好时，发送初始主题
    // 强制发送初始主题
    sendThemeUpdate(event.sender, true);
});

// 监听来自GUI的用户命令
ipcMain.on('powershell-command', (event, command) => {
    if (ptyProcess && command) {
        // 将用户输入的命令写入 pty 进程
        ptyProcess.write(`${command}\r`);
    }
});

// 监听来自GUI的复制请求
ipcMain.on('copy-to-clipboard', (event, text) => {
    if (text) {
        clipboard.writeText(text);
    }
});

// 监听来自GUI的粘贴请求
ipcMain.handle('read-from-clipboard', () => {
    return clipboard.readText();
});

// 监听来自GUI的尺寸调整请求
ipcMain.on('powershell-resize', (event, { cols, rows }) => {
    const normalizedCols = Number(cols);
    const normalizedRows = Number(rows);

    if (Number.isInteger(normalizedCols) && Number.isInteger(normalizedRows) && normalizedCols > 0 && normalizedRows > 0) {
        lastKnownSize = { cols: normalizedCols, rows: normalizedRows };
    }

    if (ptyProcess) {
        try {
            ptyProcess.resize(lastKnownSize.cols, lastKnownSize.rows);
        } catch (e) {
            console.error('[PowerShellExecutor] Failed to resize pty:', e);
        }
    }
});

// 监听来自GUI的真实终端输入透传。
// 安全声明：此通道等价于用户直接操作本机终端，不经过 intelligentSecurityCheck；
// forbiddenCommands/authRequiredCommands 仅约束 AI 工具调用路径 processToolCall。
ipcMain.on('powershell-input', (event, data) => {
    if (ptyProcess && typeof data === 'string') {
        ptyProcess.write(data);
    }
});

// --- 查询终端可见文本 ---
ipcMain.on('query-visible-text-request', (event) => {
    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.webContents.send('query-visible-text');
    }
});

let visibleTextResolver = null;

ipcMain.on('visible-text-response', (event, text) => {
    if (visibleTextResolver) {
        visibleTextResolver(text);
        visibleTextResolver = null;
    }
});

// --- 新增：窗口控制事件监听 ---
ipcMain.on('minimize-window', () => {
    if (guiWindow) guiWindow.minimize();
});

ipcMain.on('maximize-window', () => {
    if (guiWindow) {
        if (guiWindow.isMaximized()) {
            guiWindow.unmaximize();
        } else {
            guiWindow.maximize();
        }
    }
});

ipcMain.on('close-window', () => {
    if (guiWindow) guiWindow.close();
});

// --- ANSI / terminal control projection for AI text summaries ---
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


// --- 模块级状态 ---
// 用于保存持久化的伪终端（PowerShell）进程
let ptyProcess = null;
// 移除 fullTerminalHistory，后端不再维护终端内容的完整状态
// 新增：用于跟踪所有子进程，确保它们在插件卸载或程序退出时被正确清理
const childProcesses = new Set();
let guiDataListener = null; // 新增：保存GUI监听器的引用
let isExecutingCommand = false; // 仅表示 AI 短命令执行中；不要用于交互式 TUI 会话
let interactiveMode = false; // 表示当前 PTY 被 snow/codex/claude 等交互式程序占用
let lastKnownSize = { cols: 80, rows: 24 }; // GUI 最近一次 fit 出来的尺寸，用作 PTY 初始尺寸

// --- 配置加载 ---
const defaultConfig = {
    returnMode: 'delta', // 默认为增量模式
    forbiddenCommands: [],
    authRequiredCommands: []
};

try {
    const configPath = path.join(__dirname, 'config.env');
    if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');

        const returnModeMatch = configContent.match(/^POWERSHELL_RETURN_MODE\s*=\s*(delta|full)/m);
        if (returnModeMatch) {
            defaultConfig.returnMode = returnModeMatch[1];
        }

        const forbiddenMatch = configContent.match(/^FORBIDDEN_COMMANDS\s*=\s*(.*)/m);
        if (forbiddenMatch && forbiddenMatch[1]) {
            defaultConfig.forbiddenCommands = forbiddenMatch[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c);
        }

        const authRequiredMatch = configContent.match(/^AUTH_REQUIRED_COMMANDS\s*=\s*(.*)/m);
        if (authRequiredMatch && authRequiredMatch[1]) {
            defaultConfig.authRequiredCommands = authRequiredMatch[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c);
        }
    }
} catch (error) {
    console.error('[PowerShellExecutor] Error reading config.env:', error);
}


/**
 * 智能安全检查函数 - 区分命令关键字和路径内容
 * @param {string} command - 要检查的命令字符串
 * @param {string[]} forbiddenKeywords - 禁止的关键字列表
 * @param {string[]} authRequiredKeywords - 需要授权的关键字列表
 * @returns {object} - 检查结果 {isForbidden: boolean, needsAuth: boolean, matchedKeyword: string}
 */
function intelligentSecurityCheck(command, forbiddenKeywords, authRequiredKeywords) {
    const result = {
        isForbidden: false,
        needsAuth: false,
        matchedKeyword: null,
        reason: null
    };

    // 预处理命令：移除多余空格，转换为小写
    const normalizedCommand = command.trim().toLowerCase();

    // 如果命令为空，直接返回
    if (!normalizedCommand) {
        return result;
    }

    // 定义路径模式 - 常见的Windows和Unix路径格式
    const pathPatterns = [
        /[a-z]:\\[^\\/:*?"<>|]*(?:\\[^\\/:*?"<>|]*)*\\?/gi,  // Windows路径 C:\path\to\file
        /\/[^\/\s]*(?:\/[^\/\s]*)*\/?/g,                      // Unix路径 /path/to/file
        /\$env:[a-z_]+[^\\/:*?"<>|\s]*/gi,                   // PowerShell环境变量路径
        /\${[^}]+}[^\\/:*?"<>|\s]*/gi,                       // 变量路径 ${VAR}/path
        /~\/[^\/\s]*(?:\/[^\/\s]*)*\/?/g                     // 用户目录路径 ~/path
    ];

    // 提取所有可能的路径
    const detectedPaths = [];
    pathPatterns.forEach(pattern => {
        const matches = normalizedCommand.match(pattern);
        if (matches) {
            detectedPaths.push(...matches);
        }
    });

    // 创建不包含路径的命令版本用于安全检查
    let commandWithoutPaths = normalizedCommand;
    detectedPaths.forEach(path => {
        // 将路径替换为占位符，避免路径中的关键字被误判
        commandWithoutPaths = commandWithoutPaths.replace(path.toLowerCase(), ' __PATH_PLACEHOLDER__ ');
    });

    // 清理命令：移除多余空格
    commandWithoutPaths = commandWithoutPaths.replace(/\s+/g, ' ').trim();

    // 定义PowerShell命令结构模式
    const commandStructurePatterns = [
        // PowerShell cmdlet模式: Verb-Noun
        /\b[a-z]+-[a-z]+\b/g,
        // 常见命令
        /\b(?:get|set|new|remove|copy|move|invoke|start|stop|restart|test|clear|add|export|import|select|where|foreach|sort|group|measure|compare|out|write|read)\b/g,
        // 参数模式
        /\s-[a-z]+\b/g
    ];

    // 检查禁止的关键字
    for (const keyword of forbiddenKeywords) {
        if (!keyword) continue;

        const keywordLower = keyword.toLowerCase();

        // 1. 首先检查是否在路径中
        const isInPath = detectedPaths.some(path =>
            path.toLowerCase().includes(keywordLower)
        );

        if (isInPath) {
            // 如果关键字只在路径中出现，检查是否也在命令部分出现
            if (!commandWithoutPaths.includes(keywordLower)) {
                console.log(`[PowerShellExecutor] 安全检查：关键字 "${keyword}" 仅在路径中发现，允许执行`);
                continue; // 跳过这个关键字，不视为违规
            }
        }

        // 2. 检查命令部分是否包含关键字
        if (commandWithoutPaths.includes(keywordLower)) {
            // 3. 进一步验证：检查关键字是否作为独立的命令或参数出现
            const wordBoundaryPattern = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

            if (wordBoundaryPattern.test(commandWithoutPaths)) {
                result.isForbidden = true;
                result.matchedKeyword = keyword;
                result.reason = `命令包含被禁止的关键字: ${keyword}`;
                console.log(`[PowerShellExecutor] 安全检查：发现禁止的命令关键字 "${keyword}"`);
                return result;
            }
        }
    }

    // 检查需要授权的关键字（使用相同的逻辑）
    for (const keyword of authRequiredKeywords) {
        if (!keyword) continue;

        const keywordLower = keyword.toLowerCase();

        // 1. 首先检查是否在路径中
        const isInPath = detectedPaths.some(path =>
            path.toLowerCase().includes(keywordLower)
        );

        if (isInPath) {
            // 如果关键字只在路径中出现，检查是否也在命令部分出现
            if (!commandWithoutPaths.includes(keywordLower)) {
                console.log(`[PowerShellExecutor] 安全检查：授权关键字 "${keyword}" 仅在路径中发现，不需要授权`);
                continue; // 跳过这个关键字，不需要授权
            }
        }

        // 2. 检查命令部分是否包含关键字
        if (commandWithoutPaths.includes(keywordLower)) {
            // 3. 进一步验证：检查关键字是否作为独立的命令或参数出现
            const wordBoundaryPattern = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

            if (wordBoundaryPattern.test(commandWithoutPaths)) {
                result.needsAuth = true;
                result.matchedKeyword = keyword;
                result.reason = `命令包含需要授权的关键字: ${keyword}`;
                console.log(`[PowerShellExecutor] 安全检查：发现需要授权的命令关键字 "${keyword}"`);
                // 注意：不要return，继续检查其他关键字
            }
        }
    }

    return result;
}

/**
 * 启动一个独立的 Python GUI 脚本来请求管理员权限并执行命令。
 * 这是一个"即发即忘"的操作，它会打开一个全新的、独立的管理员终端窗口。
 * @param {string} command - 需要以管理员权限执行的命令。
 * @returns {Promise<string>} - 一个解析为提示信息的消息。
 */
function executeAdminCommand(command) {
    return new Promise((resolve, reject) => {
        // 1. 创建一个临时的输出文件
        tmp.file({ postfix: '.txt' }, (err, tmpFilePath, fd, cleanupCallback) => {
            if (err) {
                return reject(new Error(`无法创建临时文件: ${err.message}`));
            }

            const pythonConfirmScript = path.join(__dirname, 'AdminConfirm.py');
            const commandAsBase64 = Buffer.from(command).toString('base64');

            // 2. 准备传递给Python脚本的参数
            const scriptPathForPS = pythonConfirmScript.replace(/'/g, "''");
            const commandForPS = commandAsBase64.replace(/'/g, "''");
            const tmpPathForPS = tmpFilePath.replace(/'/g, "''");
            const argumentList = `"${scriptPathForPS}", "${commandForPS}", "${tmpPathForPS}"`;

            // 3. 构造PowerShell命令以管理员权限运行Python脚本
            const psCommand = `Start-Process -FilePath "pythonw.exe" -ArgumentList ${argumentList} -Verb RunAs -Wait`;

            const child = spawn('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Command', psCommand
            ], {
                windowsHide: true
            });
            childProcesses.add(child); // 跟踪进程

            let stderrOutput = '';
            child.stderr.on('data', (data) => {
                stderrOutput += data.toString('utf-8');
            });

            child.on('error', (err) => {
                childProcesses.delete(child); // 停止跟踪
                cleanupCallback(); // 清理临时文件
                reject(new Error(`无法启动PowerShell包装脚本: ${err.message}`));
            });

            child.on('close', (code) => {
                childProcesses.delete(child); // 停止跟踪
                // PowerShell脚本执行完毕，现在我们可以安全地读取临时文件的内容了。
                fs.readFile(tmpFilePath, 'utf-8', (readErr, data) => {
                    cleanupCallback(); // 确保无论如何都清理临时文件

                    if (readErr) {
                        // 如果读取文件失败，但我们从stderr得到了信息，就用它。
                        if (stderrOutput.trim()) {
                            return reject(new Error(`管理员脚本执行失败: ${stderrOutput.trim()}`));
                        }
                        return reject(new Error(`无法读取管理员任务的输出文件: ${readErr.message}`));
                    }

                    const result = data.trim();
                    if (result === "USER_CANCELLED") {
                        resolve("用户取消了管理员权限请求。");
                    } else if (result.startsWith("ERROR:")) {
                        reject(new Error(result.substring(6).trim()));
                    } else {
                        resolve(result);
                    }
                });
            });
        });
    });
}

/**
 * 请求用户确认一个敏感命令，但不在确认脚本中执行命令。
 * 确认通过后，命令仍回到主 PTY/xterm 会话执行，以保持 GUI 连续输出。
 * @param {string} command - 需要展示给用户确认的命令。
 * @returns {Promise<boolean>} - 用户是否允许执行。
 */
function requestInteractiveConfirmation(command) {
    return new Promise((resolve, reject) => {
        tmp.file({ postfix: '.txt' }, (err, tmpFilePath, fd, cleanupCallback) => {
            if (err) {
                return reject(new Error(`无法创建临时文件: ${err.message}`));
            }

            const pythonConfirmScript = path.join(__dirname, 'AdminConfirm.py');
            const commandAsBase64 = Buffer.from(command).toString('base64');

            // 普通敏感命令只需要当前权限确认，不应绕过主 PTY/xterm 执行链路。
            const child = spawn('pythonw.exe', [
                pythonConfirmScript,
                commandAsBase64,
                tmpFilePath,
                '--interactive-auth',
                '--confirm-only'
            ], {
                windowsHide: true
            });
            childProcesses.add(child);

            let stderrOutput = '';
            child.stderr.on('data', (data) => {
                stderrOutput += data.toString('utf-8');
            });

            child.on('error', (err) => {
                childProcesses.delete(child);
                cleanupCallback();
                reject(new Error(`无法启动交互式确认脚本: ${err.message}`));
            });

            child.on('close', () => {
                childProcesses.delete(child);
                fs.readFile(tmpFilePath, 'utf-8', (readErr, data) => {
                    cleanupCallback();

                    if (readErr) {
                        if (stderrOutput.trim()) {
                            return reject(new Error(`交互式确认脚本失败: ${stderrOutput.trim()}`));
                        }
                        return reject(new Error(`无法读取交互式确认结果文件: ${readErr.message}`));
                    }

                    const result = data.trim();
                    if (result === 'CONFIRMED') {
                        resolve(true);
                    } else if (result === 'USER_CANCELLED') {
                        resolve(false);
                    } else if (result.startsWith('ERROR:')) {
                        reject(new Error(result.substring(6).trim()));
                    } else {
                        reject(new Error(`未知的交互式确认结果: ${result || '<empty>'}`));
                    }
                });
            });
        });
    });
}

/**
 * 将 PTY 原始输出分发给消费者。
 * 一期只转发给 GUI；二期可在这里接入 @xterm/headless 等后端终端 buffer。
 * @param {string|Buffer} rawData - PTY 原始输出，不能在 GUI 路径前清洗 ANSI。
 */
function dispatchPtyData(rawData) {
    if (!guiWindow || guiWindow.isDestroyed()) {
        return;
    }

    const dataStr = rawData.toString('utf-8');
    if (dataStr) {
        guiWindow.webContents.send('powershell-data', dataStr);
    }
}

/**
 * 创建一个新的伪终端 (pty) 进程。
 */
function createNewPtySession() {
    // newSession 是交互模式的一期低成本复位入口。
    interactiveMode = false;
    isExecutingCommand = false;

    // 如果已存在旧进程，先销毁它
    if (ptyProcess) {
        childProcesses.delete(ptyProcess);
        ptyProcess.kill();
        // 当重置会话时，通知前端清屏
        if (guiWindow && !guiWindow.isDestroyed()) {
            guiWindow.webContents.send('powershell-clear');
        }
    }

    let shell = 'bash';
    let args = [];

    if (os.platform() === 'win32') {
        // 优先使用 PowerShell Core (pwsh.exe)，如果不存在则回退到 Windows PowerShell (powershell.exe)
        const pwshPath = path.join(process.env.PROGRAMFILES, 'PowerShell', '7', 'pwsh.exe');
        if (fs.existsSync(pwshPath)) {
            shell = pwshPath;
        } else {
            shell = 'powershell.exe';
        }
        args = ['-NoLogo'];
    }

    ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-color',
        cols: lastKnownSize.cols,
        rows: lastKnownSize.rows,
        cwd: process.env.USERPROFILE || process.env.HOME,
        env: process.env
    });
    childProcesses.add(ptyProcess);
    const currentPtyProcess = ptyProcess;

    // 设置 PowerShell 输出为 UTF-8 编码
    currentPtyProcess.write('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r');

    // 创建GUI数据监听器（带 AI 短命令执行状态检查）
    guiDataListener = (data) => {
        // AI 短命令期间由 executeSingleCommandInPty 的临时监听器负责 flushToGui，避免重复输出。
        // 交互式 TUI 模式绝不能设置 isExecutingCommand，否则 GUI 会黑屏。
        if (isExecutingCommand) {
            return;
        }

        dispatchPtyData(data);
    };

    // 设置数据监听器，将所有 pty 输出直接代理到 GUI
    currentPtyProcess.onData(guiDataListener);

    // 当 pty 进程意外退出时，清理资源。
    // 注意：newSession 会先 kill 旧 PTY 再创建新 PTY，旧 PTY 的异步 onExit 不能误清理新会话。
    currentPtyProcess.onExit(() => {
        childProcesses.delete(currentPtyProcess);

        if (ptyProcess !== currentPtyProcess) {
            return;
        }

        ptyProcess = null;
        guiDataListener = null;
        isExecutingCommand = false;
        interactiveMode = false;
    });
}

function buildHumanLaunchAnimationCommand() {
    const script = [
        '$esc = [char]27',
        '# 尝试擦掉用于触发动画的短命令输入行，避免启动动画前出现杂乱命令文本。',
        'Write-Host -NoNewline "$esc[1A$esc[2K`r"',
        '',
        '# 霓虹渐变色定义',
        '$c1 = "$esc[38;2;245;194;231m" # Pink',
        '$c2 = "$esc[38;2;203;166;247m" # Mauve',
        '$c3 = "$esc[38;2;137;180;250m" # Blue',
        '$c4 = "$esc[38;2;116;199;236m" # Sapphire',
        '$c5 = "$esc[38;2;137;220;235m" # Sky',
        '$c6 = "$esc[38;2;148;226;213m" # Teal',
        '$reset = "$esc[0m"',
        '$gray = "$esc[38;2;147;153;178m"',
        '$darkGray = "$esc[38;2;88;91;112m"',
        '$green = "$esc[38;2;166;227;161m"',
        '$yellow = "$esc[38;2;249;226;175m"',
        '',
        '# 逐行打印华丽的 VCP CLI ASCII Art',
        'Write-Host ""',
        'Write-Host "  ${c1}██╗   ██╗  ██████╗  ██████╗      ██████╗  ██╗      ██╗${reset}"',
        'Start-Sleep -Milliseconds 40',
        'Write-Host "  ${c2}██║   ██║ ██╔════╝  ██╔══██╗    ██╔════╝  ██║      ██║${reset}"',
        'Start-Sleep -Milliseconds 40',
        'Write-Host "  ${c3}██║   ██║ ██║       ██████╔╝    ██║       ██║      ██║${reset}"',
        'Start-Sleep -Milliseconds 40',
        'Write-Host "  ${c4}╚██╗ ██╔╝ ██║       ██╔═══╝     ██║       ██║      ██║${reset}"',
        'Start-Sleep -Milliseconds 40',
        'Write-Host "  ${c5} ╚████╔╝  ╚██████╗  ██║         ╚██████╗  ███████╗ ██║${reset}"',
        'Start-Sleep -Milliseconds 40',
        'Write-Host "  ${c6}  ╚═══╝    ╚═════╝  ╚═╝          ╚═════╝  ╚══════╝ ╚═╝${reset}"',
        'Start-Sleep -Milliseconds 50',
        '',
        '# 打印副标题和分割线',
        'Write-Host "  ${darkGray}──────────────────────────────────────────────────────────${reset}"',
        'Write-Host "  ${gray}Distributed PowerShell Bridge & Interactive Terminal GUI${reset}"',
        'Write-Host "  ${darkGray}──────────────────────────────────────────────────────────${reset}"',
        'Write-Host ""',
        '',
        '# 华丽的渐变色进度条加载动画',
        '$barWidth = 30',
        'for ($i = 0; $i -le $barWidth; $i++) {',
        '    $percent = [math]::Round(($i / $barWidth) * 100)',
        '    $filledCount = $i',
        '    $emptyCount = $barWidth - $i',
        '    ',
        '    # 动态计算渐变色 (从 Mauve 203,166,247 渐变到 Teal 148,226,213)',
        '    $r = [int](203 - (203 - 148) * ($i / $barWidth))',
        '    $g = [int](166 + (226 - 166) * ($i / $barWidth))',
        '    $b = [int](247 - (247 - 213) * ($i / $barWidth))',
        '    $color = "$esc[38;2;${r};${g};${b}m"',
        '    ',
        '    $filled = "▰" * $filledCount',
        '    $empty = "▱" * $emptyCount',
        '    ',
        '    Write-Host -NoNewline "$esc[2K`r  ${gray}Loading Bridge:${reset} [${color}${filled}${darkGray}${empty}${reset}] ${color}${percent}%${reset}"',
        '    Start-Sleep -Milliseconds 35',
        '}',
        'Write-Host ""',
        'Write-Host ""',
        '',
        '# 打印系统就绪状态和极客风系统信息',
        'Write-Host "  ${gray}Status:${reset}    ${green}ONLINE${reset}"',
        'Write-Host "  ${gray}Session:${reset}   ${c3}Active PowerShell Bridge${reset}"',
        'Write-Host "  ${gray}Terminal:${reset}  ${yellow}Interactive Console Ready${reset}"',
        'Write-Host ""',
        'Write-Host "  ${gray}Type commands below. Press ${c3}Ctrl+C${gray} to interrupt.${reset}"',
        'Write-Host ""',
        'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    ].join('\n');

    const tempScriptName = `vcp-cli-launch-${crypto.randomUUID()}.ps1`;
    const tempScriptPath = path.join(os.tmpdir(), tempScriptName);
    fs.writeFileSync(tempScriptPath, `\ufeff${script}`, 'utf8');

    const escapedTempScriptPath = tempScriptPath.replace(/'/g, "''");
    return `& '${escapedTempScriptPath}'\r`;
}

/**
 * 打开或聚焦 PowerShellExecutor 的交互式终端 GUI。
 * 该入口供主程序托盘 / 桌面应用启动器直接调用，不需要先通过 AI 工具执行命令。
 * @returns {BrowserWindow} PowerShell 终端窗口实例。
 */
function openGuiTerminal() {
    ensureGuiWindow();

    const shouldPlayHumanLaunchAnimation = !ptyProcess;
    if (!ptyProcess) {
        createNewPtySession();
    }

    if (shouldPlayHumanLaunchAnimation && ptyProcess) {
        setTimeout(() => {
            if (ptyProcess) {
                ptyProcess.write(buildHumanLaunchAnimationCommand());
            }
        }, 650);
    }

    return guiWindow;
}

/**
 * 插件的主入口点，由 PluginManager 直接调用。
 * @param {object} args - 从 AI 工具调用中解析出的参数。
 * @returns {Promise<string>} - 命令执行的结果。
 */
/**
 * 在给定的 pty 会话中执行单条命令并返回其增量输出。
 * @param {object} ptyProcess - node-pty 实例。
 * @param {string} singleCommand - 要执行的单条命令。
 * @returns {Promise<string>} - 该命令的增量输出。
 */
function executeSingleCommandInPty(ptyProcess, singleCommand) {
    return new Promise((resolve, reject) => {
        if (!ptyProcess) {
            return reject(new Error("PTY process is not available."));
        }

        let rawOutput = '';
        let hasSeenStartBoundary = false;
        let settled = false;
        let tempScriptPath = null;

        const startBoundary = `__VCP_COMMAND_START_${crypto.randomUUID()}__`;
        const endBoundary = `__VCP_COMMAND_END_${crypto.randomUUID()}__`;

        const cleanupListener = (listenerDisposable, timeoutId) => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            if (listenerDisposable && typeof listenerDisposable.dispose === 'function') {
                listenerDisposable.dispose();
            }
            if (tempScriptPath) {
                try {
                    fs.unlinkSync(tempScriptPath);
                } catch (e) {
                    console.warn('[PowerShellExecutor] Failed to remove temporary script:', e.message);
                }
                tempScriptPath = null;
            }
        };

        const flushToGui = (text) => {
            if (text) {
                dispatchPtyData(text);
            }
        };

        const listenerDisposable = ptyProcess.onData((data) => {
            if (settled) {
                return;
            }

            let chunk = data.toString('utf-8');

            // 丢弃开始边界之前的所有迟到输出，避免上一条命令残留串入本次结果
            if (!hasSeenStartBoundary) {
                const startIndex = chunk.indexOf(startBoundary);
                if (startIndex === -1) {
                    return;
                }

                hasSeenStartBoundary = true;
                chunk = chunk.substring(startIndex + startBoundary.length);
            }

            const endIndex = chunk.indexOf(endBoundary);
            if (endIndex !== -1) {
                const finalChunk = chunk.substring(0, endIndex);
                rawOutput += finalChunk;
                flushToGui(finalChunk);

                settled = true;
                cleanupListener(listenerDisposable, timeoutId);
                resolve(sanitizeTerminalOutput(rawOutput).trim());
                return;
            }

            rawOutput += chunk;
            flushToGui(chunk);
        });

        const timeoutId = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            cleanupListener(listenerDisposable, timeoutId);
            reject(new Error(`Command "${singleCommand}" timed out after 60 seconds.`));
        }, 60000);

        try {
            const tempScriptName = `vcp-powershell-${crypto.randomUUID()}.ps1`;
            tempScriptPath = path.join(os.tmpdir(), tempScriptName);
            // Windows PowerShell 5.1 对无 BOM UTF-8 的中文兼容性较差，写入 BOM 保证脚本内容稳定解析。
            fs.writeFileSync(tempScriptPath, `\ufeff${singleCommand}`, 'utf8');

            const escapedTempScriptPath = tempScriptPath.replace(/'/g, "''");
            const encodedStartBoundary = Buffer.from(startBoundary, 'utf8').toString('base64');
            const encodedEndBoundary = Buffer.from(endBoundary, 'utf8').toString('base64');

            // 不能把 boundary 明文写进交互式命令行：
            // PowerShell/PSReadLine 会先回显整行输入，若监听器在“输入回显”里提前匹配到 boundary，
            // 就会把命令尚未执行的回显误判为真实输出，造成提前结束或卡死。
            // 因此这里用 Base64 在 PowerShell 内部还原 boundary，让 GUI/AI 只匹配真实 Write-Host 输出。
            const wrappedCommand = [
                `$__vcpStart = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedStartBoundary}'))`,
                `$__vcpEnd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedEndBoundary}'))`,
                `Write-Host $__vcpStart`,
                // 即使临时脚本发生 ParserError / RuntimeException，也必须输出 end boundary，
                // 否则 AI 调用会一直等待直到超时。错误文本仍由 PTY 原样进入 rawOutput。
                `try { & '${escapedTempScriptPath}' } finally { Write-Host $__vcpEnd }`
            ].join('; ');

            ptyProcess.write(`${wrappedCommand}\r`);
        } catch (error) {
            settled = true;
            cleanupListener(listenerDisposable, timeoutId);
            reject(new Error(`无法创建或执行临时 PowerShell 脚本: ${error.message}`));
        }
    });
}


async function processToolCall(args) {
    const action = typeof args.action === 'string' ? args.action.trim() : 'execute';

    if (action.startsWith('queryVisible')) {
        ensureGuiWindow();
        
        const match = action.match(/^queryVisible(\d+)?$/);
        const maxLines = match && match[1] ? parseInt(match[1], 10) : null;
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                visibleTextResolver = null;
                reject(new Error('查询终端文本超时'));
            }, 5000);

            visibleTextResolver = (text) => {
                clearTimeout(timeout);
                resolve({ content: [{ type: 'text', text: `\`\`\`\n${text}\n\`\`\`` }] });
            };

            guiWindow.webContents.send('query-visible-text', { maxLines });
        });
    }

    if (action === 'endInteractive') {
        interactiveMode = false;
        return { content: [{ type: 'text', text: 'Interactive mode flag cleared. The existing PTY session was not terminated.' }] };
    }

    // --- 1. 解析和排序命令 ---
    const commandEntries = Object.entries(args)
        .filter(([key]) => key.startsWith('command'))
        .map(([key, value]) => {
            const match = key.match(/^command(\d*)$/);
            const index = match ? (match[1] === '' ? 0 : parseInt(match[1], 10)) : -1;
            return { key, value, index };
        })
        .filter(item => item.index !== -1)
        .sort((a, b) => a.index - b.index);

    if (commandEntries.length === 0) {
        throw new Error('未提供任何有效的 command 参数 (例如 command, command1, command2)。');
    }

    if (action !== 'execute' && action !== 'startInteractive') {
        throw new Error(`不支持的 action: ${action}`);
    }

    // --- 2. 智能安全预检查 ---
    let needsInteractiveAuth = false;
    for (const entry of commandEntries) {
        const securityResult = intelligentSecurityCheck(
            entry.value,
            defaultConfig.forbiddenCommands,
            defaultConfig.authRequiredCommands
        );

        if (securityResult.isForbidden) {
            throw new Error(`执行被阻止：${securityResult.reason}`);
        }

        if (securityResult.needsAuth) {
            needsInteractiveAuth = true;
            console.log(`[PowerShellExecutor] 命令 "${entry.value}" 需要交互式授权：${securityResult.reason}`);
        }
    }

    // --- 3. 初始化会话和参数 ---
    const lastCommandIndex = commandEntries[commandEntries.length - 1].index;
    const getArg = (key, defaultVal) => {
        const indexedKey = `${key}${lastCommandIndex || ''}`;
        return args[indexedKey] !== undefined ? args[indexedKey] : (args[key] !== undefined ? args[key] : defaultVal);
    };

    const requireAdmin = getArg('requireAdmin', false);
    const newSession = getArg('newSession', false);
    const finalReturnMode = getArg('returnMode', defaultConfig.returnMode);

    // --- 4. 根据模式选择执行路径 ---

    // 路径 A: 管理员模式 (最高优先级)
    if (requireAdmin) {
        if (commandEntries.length > 1) {
            throw new Error("管理员模式 (requireAdmin: true) 不支持执行多个命令链。");
        }
        if (ptyProcess) {
            ptyProcess.kill();
            ptyProcess = null;
        }
        const command = commandEntries[0].value;
        const fullCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
        const output = await executeAdminCommand(fullCommand);
        const cleanOutput = output.replace(/\r\n/g, '\n').replace(/\r/g, '');
        return { content: [{ type: 'text', text: `\`\`\`powershell\n${cleanOutput}\n\`\`\`` }] };
    }

    // 路径 B: 普通敏感命令确认模式
    // 这里只做确认；确认通过后继续走路径 C，在主 PTY/xterm 会话中执行并连续显示输出。
    if (needsInteractiveAuth) {
        const combinedCommand = commandEntries.map(e => e.value).join('; ');
        const confirmed = await requestInteractiveConfirmation(combinedCommand);
        if (!confirmed) {
            return { content: [{ type: 'text', text: '用户取消了操作。' }] };
        }
    }

    // 路径 C: 标准非管理员会话执行
    ensureGuiWindow();

    if (newSession || !ptyProcess) {
        createNewPtySession();
        await new Promise(resolve => setTimeout(resolve, 500)); // 等待PTY初始化
    }

    if (action === 'startInteractive') {
        if (commandEntries.length > 1) {
            throw new Error('startInteractive 只支持单条 command。');
        }

        const command = commandEntries[0].value;
        interactiveMode = true;
        // 不设置 isExecutingCommand；交互式 TUI 输出必须走常驻 guiDataListener，否则会黑屏。
        ptyProcess.write(`${command}\r`);
        return { content: [{ type: 'text', text: `Interactive session started: ${command}` }] };
    }

    if (interactiveMode) {
        throw new Error('当前终端正被交互式程序 (snow/codex/claude) 占用，请先退出并调用 action:"endInteractive"，或使用 newSession:true 重置会话。');
    }

    const deltaOutputs = [];
    isExecutingCommand = true;
    try {
        for (const entry of commandEntries) {
            const command = entry.value;
            const currentReturnModeKey = `returnMode${entry.index || ''}`;
            const currentReturnMode = args[currentReturnModeKey] || finalReturnMode;

            try {
                const output = await executeSingleCommandInPty(ptyProcess, command);
                deltaOutputs.push({ command, output, returnMode: currentReturnMode });
            } catch (error) {
                throw new Error(`在执行命令 "${command}" 时出错: ${error.message}`);
            }
        }
    } finally {
        isExecutingCommand = false;
    }

    // --- 5. 格式化并返回结果 ---
    let finalOutput = '';
    if (finalReturnMode === 'full') {
        finalOutput = deltaOutputs.length > 0 ? deltaOutputs[deltaOutputs.length - 1].output : '';
    } else { // delta 模式
        if (deltaOutputs.length === 1) {
            finalOutput = deltaOutputs[0].output;
        } else {
            finalOutput = deltaOutputs.map(res =>
                `---[Output for: ${res.command}]---\n${res.output}`
            ).join('\n\n');
        }
    }

    const cleanOutput = finalOutput.replace(/\r\n/g, '\n').replace(/\r/g, '');
    return { content: [{ type: 'text', text: `\`\`\`powershell\n${cleanOutput}\n\`\`\`` }] };
}

/**
 * 清理插件资源，在主程序退出或插件重载时调用。
 */
function cleanup() {
    console.log('[PowerShellExecutor] 正在清理资源...');

    // 1. 关闭并销毁 GUI 窗口
    if (guiWindow && !guiWindow.isDestroyed()) {
        try {
            // 移除 'closed' 监听器，以避免在程序化关闭时触发额外的 ptyProcess.kill()
            guiWindow.removeAllListeners('closed');
            guiWindow.close();
            console.log('[PowerShellExecutor] GUI 窗口已关闭。');
        } catch (e) {
            console.error('[PowerShellExecutor] 关闭 GUI 窗口时出错:', e);
        }
        guiWindow = null;
    }

    // 2. 终止所有跟踪的子进程
    if (childProcesses.size > 0) {
        console.log(`[PowerShellExecutor] 正在终止 ${childProcesses.size} 个子进程...`);
        for (const processToKill of childProcesses) {
            try {
                // ptyProcess 和 child_process 对象都有一个 .kill() 方法
                processToKill.kill();
                console.log(`[PowerShellExecutor] 进程 (PID: ${processToKill.pid}) 已终止。`);
            } catch (e) {
                console.error(`[PowerShellExecutor] 终止进程 (PID: ${processToKill.pid}) 时出错:`, e);
            }
        }
        childProcesses.clear();
    }

    // 3. 停止文件监视器
    if (settingsWatcher) {
        try {
            settingsWatcher.close();
            settingsWatcher = null;
            console.log('[PowerShellExecutor] Settings file watcher stopped.');
        } catch (e) {
            console.error('[PowerShellExecutor] Error stopping settings watcher:', e);
        }
    }

    // 4. 确保 ptyProcess 状态被重置
    ptyProcess = null;
    guiDataListener = null;
    isExecutingCommand = false;
    interactiveMode = false;
}

// 导出 processToolCall 函数、GUI 打开函数和 cleanup 函数
module.exports = {
    processToolCall,
    openGuiTerminal,
    cleanup
};