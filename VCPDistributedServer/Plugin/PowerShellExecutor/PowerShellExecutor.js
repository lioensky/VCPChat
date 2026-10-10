// node-pty 是原生模块：只读命令记录、不开终端时不加载它，真正创建会话时才 require
let ptyModule = null;
function loadPty() {
    return ptyModule || (ptyModule = require('node-pty'));
}
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BrowserWindow, ipcMain, clipboard } = require('electron');
const tmp = require('tmp');
const chokidar = require('chokidar');
const { CommandOutputParser, CommandTerminalProjection } = require('./command-output-parser');
const { sanitizeTerminalOutput } = require('./terminalOutputSanitizer');
const { buildCaptureWrapper, parseCaptureReceipt } = require('./commandCapture');
let pendingCommandCleanup = null;
let commandUnresolved = false;
// 命令运行记录放在无副作用的独立模块里：主进程只读记录时不必加载整个执行器
const {
    COMMAND_RUN_RAW_LIMIT,
    beginCommandRun,
    appendCommandRunOutput,
    finishCommandRun,
    listCommandRuns,
    getCommandRun,
    subscribeCommandRuns,
} = require('./commandRunStore');
const { resolveConfirmationScript } = require('./nativeHelperPath.js');

// --- GUI Window Management ---
let guiWindow = null;
let guiReady = false;
let guiReadyPromise = Promise.resolve();
let resolveGuiReady = null;

function createGuiReadyBarrier() {
    guiReady = false;
    guiReadyPromise = new Promise((resolve) => {
        resolveGuiReady = resolve;
    });
}

async function waitForGuiReady(timeoutMs = 15000) {
    if (!guiWindow || guiWindow.isDestroyed()) {
        throw new Error('PowerShell GUI window is not available.');
    }

    if (guiReady) {
        return;
    }

    const targetWebContents = guiWindow.webContents;
    let timeoutId = null;

    try {
        await Promise.race([
            guiReadyPromise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`PowerShell GUI initialization timed out after ${timeoutMs}ms.`));
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }

    if (!guiWindow || guiWindow.isDestroyed() || guiWindow.webContents !== targetWebContents || !guiReady) {
        throw new Error('PowerShell GUI window changed or closed during initialization.');
    }
}

function ensureGuiWindow() {
    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.focus();
        return guiWindow;
    }

    createGuiReadyBarrier();
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
        guiReady = false;
        if (resolveGuiReady) {
            resolveGuiReady();
            resolveGuiReady = null;
        }
        guiWindow = null;
        // 窗口只是视图；关闭它不能结束侧栏 / AI 共用的 PTY。
    });

    return guiWindow;
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


// 监听来自GUI的“就绪”信号。
// 只有当前窗口在 xterm 挂载、IPC 监听注册和首次 fit 完成后发出的信号才能解除屏障；
// 旧窗口的迟到消息不能误解锁新窗口。
ipcMain.on('powershell-gui-ready', (event) => {
    if (!guiWindow || guiWindow.isDestroyed() || event.sender !== guiWindow.webContents) {
        return;
    }

    guiReady = true;
    if (resolveGuiReady) {
        resolveGuiReady();
        resolveGuiReady = null;
    }

    sendThemeUpdate(event.sender, true);
    const replay = readReplay();
    if (replay) event.sender.send('powershell-data', replay);
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
function applyPtyResize(cols, rows) {
    const normalizedCols = Number(cols);
    const normalizedRows = Number(rows);
    const previous = lastKnownSize;

    if (Number.isInteger(normalizedCols) && Number.isInteger(normalizedRows) && normalizedCols > 0 && normalizedRows > 0) {
        lastKnownSize = { cols: normalizedCols, rows: normalizedRows };
    }
    // 镜像视图（侧栏终端）里不持有尺寸的那些要跟着新尺寸画
    if (lastKnownSize.cols !== previous.cols || lastKnownSize.rows !== previous.rows) {
        notifyMirrors('onResize', lastKnownSize.cols, lastKnownSize.rows);
    }

    if (ptyProcess) {
        try {
            ptyProcess.resize(lastKnownSize.cols, lastKnownSize.rows);
        } catch (e) {
            console.error('[PowerShellExecutor] Failed to resize pty:', e);
        }
    }
}

ipcMain.on('powershell-resize', (event, { cols, rows }) => {
    applyPtyResize(cols, rows);
});

// 监听来自GUI的真实终端输入透传。
// 安全声明：此通道等价于用户直接操作本机终端，不经过 intelligentSecurityCheck；
// forbiddenCommands/authRequiredCommands 仅约束 AI 工具调用路径 processToolCall。
ipcMain.on('powershell-input', (event, data) => {
    if (ptyProcess && typeof data === 'string') {
        ptyProcess.write(data);
    }
});

// --- 查询终端可见文本与 xterm 粘贴响应 ---
const visibleTextResolvers = new Map();
const terminalPasteResolvers = new Map();

ipcMain.on('visible-text-response', (event, payload, legacyText) => {
    if (!isPowerShellGuiSender(event)) {
        return;
    }

    // 兼容旧渲染端直接返回字符串的格式。
    if (typeof payload === 'string') {
        const firstEntry = visibleTextResolvers.entries().next().value;
        if (firstEntry) {
            const [requestId, resolve] = firstEntry;
            visibleTextResolvers.delete(requestId);
            resolve(payload);
        }
        return;
    }

    const requestId = payload && payload.requestId;
    const resolver = requestId ? visibleTextResolvers.get(requestId) : null;
    if (resolver) {
        visibleTextResolvers.delete(requestId);
        resolver(typeof payload.text === 'string' ? payload.text : (legacyText || ''));
    }
});

ipcMain.on('terminal-paste-complete', (event, payload) => {
    if (!isPowerShellGuiSender(event)) {
        return;
    }

    const requestId = payload && payload.requestId;
    const resolver = requestId ? terminalPasteResolvers.get(requestId) : null;
    if (resolver) {
        terminalPasteResolvers.delete(requestId);
        resolver();
    }
});

// --- PowerShell GUI 专属窗口控制 ---
// 不复用应用级 minimize-window/maximize-window/close-window：ipcMain 是全局事件总线，
// 使用通用通道会让日志中心等其它窗口的操作也落到此 guiWindow 上；而 PowerShell
// 自身的消息还会与应用级处理器重复执行（最大化切换两次后等同于没有变化）。
function isPowerShellGuiSender(event) {
    return Boolean(
        event
        && guiWindow
        && !guiWindow.isDestroyed()
        && guiWindow.webContents
        && !guiWindow.webContents.isDestroyed()
        && event.sender === guiWindow.webContents
    );
}

ipcMain.on('powershell-window:minimize', (event) => {
    if (isPowerShellGuiSender(event)) {
        guiWindow.minimize();
    }
});

ipcMain.on('powershell-window:toggle-maximize', (event) => {
    if (!isPowerShellGuiSender(event)) {
        return;
    }

    if (guiWindow.isMaximized()) {
        guiWindow.unmaximize();
    } else {
        guiWindow.maximize();
    }
});

ipcMain.on('powershell-window:close', (event) => {
    if (isPowerShellGuiSender(event)) {
        guiWindow.close();
    }
});

// --- ANSI / terminal control projection for AI text summaries ---
// 清洗逻辑在 terminalOutputSanitizer.js（纯函数，命令运行记录也用它）

// --- 模块级状态 ---
// 用于保存持久化的伪终端（PowerShell）进程
let ptyProcess = null;
// 移除 fullTerminalHistory，后端不再维护终端内容的完整状态
// 新增：用于跟踪所有子进程，确保它们在插件卸载或程序退出时被正确清理
const childProcesses = new Set();
let guiDataListener = null; // 新增：保存GUI监听器的引用
let isExecutingCommand = false; // 仅表示 AI 短命令执行中；不要用于交互式 TUI 会话
let interactiveMode = false; // 表示当前 PTY 被 snow/codex/claude 等交互式程序占用
let activeCommandAbort = null; // 当前同步命令的本地等待中止器；供并发 interrupt 工具调用解除阻塞
let lastKnownSize = { cols: 80, rows: 24 }; // GUI 最近一次 fit 出来的尺寸，用作 PTY 初始尺寸
let ptyReadyPromise = Promise.resolve();
let terminalProjection = null;

// --- 并发排队调度状态机 ---
const MAX_EXECUTION_QUEUE_SIZE = 10;
const executionQueue = [];
let queueProcessing = false;

/**
 * 级联清空整个排队队列，对所有等待任务安全 reject，防止前置错误导致错误扩散。
 * @param {string} reasonMessage - 拒绝理由。
 * @returns {Array} 被取消的任务列表。
 */
function purgeExecutionQueue(reasonMessage) {
    if (executionQueue.length === 0) {
        return [];
    }
    const cancelledTasks = executionQueue.splice(0, executionQueue.length);
    for (const task of cancelledTasks) {
        try {
            task.reject(new Error(reasonMessage));
        } catch {
            // 忽略已决议的回调
        }
    }
    return cancelledTasks;
}

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

            let pythonConfirmScript;
            try { pythonConfirmScript = resolveConfirmationScript(__dirname); }
            catch (error) { cleanupCallback(); reject(error); return; }
            const commandAsBase64 = Buffer.from(command).toString('base64');

            // 2. 准备传递给Python脚本的参数
            const scriptPathForPS = pythonConfirmScript.replace(/'/g, "''");
            const commandForPS = commandAsBase64.replace(/'/g, "''");
            const tmpPathForPS = tmpFilePath.replace(/'/g, "''");
            const argumentList = `"${scriptPathForPS}", "${commandForPS}", "${tmpPathForPS}"`;

            // 3. 构造PowerShell命令以管理员权限运行Python脚本（捕获UAC异常并注入纯ASCII标记）
            const psCommand = `$ErrorActionPreference = 'Stop'; try { Start-Process -FilePath "pythonw.exe" -ArgumentList ${argumentList} -Verb RunAs -Wait } catch { [Console]::Error.WriteLine('UAC_CANCELLED_OR_FAILED: ' + $_.Exception.Message) }`;
            const child = spawn('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Command', psCommand
            ], {
                windowsHide: true
            });
            childProcesses.add(child); // 跟踪进程

            let stderrOutput = '';
            let isSettled = false;

            // 310 秒外部安全定时器守护，防止后台卡死挂起 (Todo #3)
            const safetyTimeout = setTimeout(() => {
                if (isSettled) return;
                isSettled = true;
                try {
                    child.kill();
                } catch { }
                childProcesses.delete(child);
                cleanupCallback();
                resolve({
                    isCancelled: true,
                    content: [{
                        type: 'text',
                        text: '⚠️ [操作超时]：等待管理员确认超时（超过无操作安全时限），系统已自动拒绝执行。'
                    }]
                });
            }, 310000);

            child.stderr.on('data', (data) => {
                stderrOutput += data.toString('utf-8');
            });

            child.on('error', (err) => {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(safetyTimeout);
                childProcesses.delete(child); // 停止跟踪
                cleanupCallback(); // 清理临时文件
                reject(new Error(`无法启动PowerShell包装脚本: ${err.message}`));
            });

            child.on('close', (code) => {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(safetyTimeout);
                childProcesses.delete(child); // 停止跟踪
                // PowerShell脚本执行完毕，安全读取临时文件内容
                fs.readFile(tmpFilePath, 'utf-8', (readErr, data) => {
                    cleanupCallback(); // 确保清理临时文件

                    // 检测 UAC 取消或拒绝错误（显式捕获标记、0x800704C7 或中文取消提示）
                    const isUacCancelled = stderrOutput && (
                        stderrOutput.includes('UAC_CANCELLED_OR_FAILED') ||
                        stderrOutput.includes('0x800704C7') ||
                        stderrOutput.includes('74C7') ||
                        stderrOutput.includes('操作已被用户取消') ||
                        stderrOutput.includes('The operation was canceled by the user')
                    );

                    if (isUacCancelled) {
                        return resolve({
                            isCancelled: true,
                            content: [{
                                type: 'text',
                                text: '⚠️ [操作未执行/未授权]：用户在 Windows UAC 提权界面取消了授权，或未获取到管理员权限。敏感命令未执行。'
                            }]
                        });
                    }
                    if (readErr) {
                        if (stderrOutput.trim()) {
                            return reject(new Error(`管理员脚本执行失败: ${stderrOutput.trim()}`));
                        }
                        return reject(new Error(`无法读取管理员任务的输出文件: ${readErr.message}`));
                    }

                    const result = data.trim();
                    if (result === "USER_CANCELLED") {
                        resolve({
                            isCancelled: true,
                            content: [{
                                type: 'text',
                                text: '⚠️ [操作已取消]：用户已主动拒绝或取消了本次管理员权限申请。敏感命令未执行。'
                            }]
                        });
                    } else if (result === "TIMEOUT_REJECTED") {
                        resolve({
                            isCancelled: true,
                            content: [{
                                type: 'text',
                                text: '⚠️ [操作超时]：等待管理员确认超时（超过无操作安全时限），系统已自动拒绝执行。'
                            }]
                        });
                    } else if (result.startsWith("ERROR:")) {
                        reject(new Error(result.substring(6).trim()));
                    } else if (result === "") {
                        // 空输出防穿透：脚本根本未生成内容或提权未通过时，绝不能当作正常执行成功
                        resolve({
                            isCancelled: true,
                            content: [{
                                type: 'text',
                                text: '⚠️ [操作未执行/未授权]：用户在 Windows UAC 提权界面取消了授权，或未获取到管理员权限。敏感命令未执行。'
                            }]
                        });
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

            let pythonConfirmScript;
            try { pythonConfirmScript = resolveConfirmationScript(__dirname); }
            catch (error) { cleanupCallback(); reject(error); return; }
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
                    } else if (result === 'USER_CANCELLED' || result === 'TIMEOUT_REJECTED') {
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
 * GUI 仅接收原始PTY投影；渲染窗口失效不得打断命令完成检测。
 */
function dispatchPtyData(rawData) {
    const dataStr = rawData.toString('utf-8');
    if (!dataStr) {
        return;
    }

    if (mirrorStartupPending) {
        // 启动握手（编码设置与就绪标记）是内部细节，握手完成前不投影到侧栏和独立窗口
        mirrorStartupHeld = (mirrorStartupHeld + dataStr).slice(-MIRROR_REPLAY_LIMIT);
        return;
    }

    emitMirrorData(dataStr);

    try {
        if (!guiWindow || guiWindow.isDestroyed()
            || guiWindow.webContents.isDestroyed()) {
            return;
        }
        guiWindow.webContents.send('powershell-data', dataStr);
    } catch (error) {
        console.warn('[PowerShellExecutor] GUI output delivery failed:', error.message);
    }
}

// --- 侧栏镜像 ---
// 主窗口侧栏的「终端」标签是同一个 PTY 会话的另一个视图：输出同时送往 GUI 窗口和镜像，
// 输入与尺寸调整直接落到同一个 PTY，AI 工具执行的命令因此对两处都可见。
const MIRROR_REPLAY_LIMIT = 256 * 1024;
const mirrorSinks = new Set();
// 回放缓存按块存：满了从头部整块丢掉，每块均摊 O(1)，只在挂载回放时拼一次。
// 原来每块都把 256KB 拼接再切片，刷屏输出时主进程每秒要复制几百 MB（改成有界缓冲预算）
let replayChunks = [];
let replayHead = 0;
let replayLength = 0;
let mirrorStartupPending = false;
let mirrorStartupHeld = '';

function emitMirrorData(dataStr) {
    if (!dataStr) return;
    // 侧栏终端可能在会话进行中才挂载，缓存最近输出用于回放。
    appendReplay(dataStr);
    notifyMirrors('onData', dataStr);
}

function appendReplay(dataStr) {
    replayChunks.push(dataStr);
    replayLength += dataStr.length;
    while (replayLength - replayChunks[replayHead].length >= MIRROR_REPLAY_LIMIT) {
        replayLength -= replayChunks[replayHead].length;
        replayChunks[replayHead++] = undefined;
    }
    if (replayHead > 1024 && replayHead * 2 > replayChunks.length) {
        replayChunks = replayChunks.slice(replayHead);
        replayHead = 0;
    }
}

function readReplay() {
    if (replayLength === 0) return '';
    const text = replayChunks.slice(replayHead).join('');
    if (text.length <= MIRROR_REPLAY_LIMIT) return text;
    // 超出的部分从下一行开头回放，不从控制序列中间切开
    const kept = text.slice(-MIRROR_REPLAY_LIMIT);
    const lineStart = kept.indexOf('\n');
    return lineStart >= 0 && lineStart < 4096 ? kept.slice(lineStart + 1) : kept;
}

function clearReplay() {
    replayChunks = [];
    replayHead = 0;
    replayLength = 0;
}

/** 结束启动握手：成功时只放出就绪标记之后的内容（通常是提示符），失败时原样放出便于排查。 */
function releaseMirrorStartup(afterReady = null) {
    if (!mirrorStartupPending) return;
    mirrorStartupPending = false;
    const held = mirrorStartupHeld;
    mirrorStartupHeld = '';
    const releasedOutput = afterReady === null ? held : afterReady;
    emitMirrorData(releasedOutput);

    try {
        if (!guiWindow || guiWindow.isDestroyed()
            || guiWindow.webContents.isDestroyed()) {
            return;
        }
        guiWindow.webContents.send('powershell-data', releasedOutput);
    } catch (error) {
        console.warn('[PowerShellExecutor] GUI output delivery failed:', error.message);
    }
}

function notifyMirrors(method, ...args) {
    for (const sink of mirrorSinks) {
        try {
            sink[method]?.(...args);
        } catch (e) {
            console.error('[PowerShellExecutor] Mirror sink failed:', e);
        }
    }
}

/**
 * 注册一个镜像视图并回放已有输出。
 * @param {{onData: Function, onClear?: Function, onExit?: Function}} sink
 * @returns {Function} 取消注册
 */
function attachMirror(sink) {
    mirrorSinks.add(sink);
    const replay = readReplay();
    if (replay) {
        try {
            sink.onData(replay);
        } catch (e) {
            console.error('[PowerShellExecutor] Mirror replay failed:', e);
        }
    }
    return () => mirrorSinks.delete(sink);
}

/** 确保有一个 PTY 会话（不打开 GUI 窗口）。 */
function ensureMirrorSession() {
    if (!ptyProcess) {
        createNewPtySession();
    }
    return getSessionState();
}

/** 重置为全新的 PTY 会话（与 GUI 窗口共用）。 */
function restartSession() {
    createNewPtySession();
    return getSessionState();
}

function getSessionState() {
    return {
        running: Boolean(ptyProcess),
        pid: ptyProcess ? ptyProcess.pid : null,
        // AI 短命令、交互式 TUI 或队列排队占用期间，不应向会话里塞入额外命令。
        busy: Boolean(isExecutingCommand || commandUnresolved || interactiveMode || executionQueue.length > 0),
        unresolved: commandUnresolved,
        queuedTasks: executionQueue.length,
        cols: lastKnownSize.cols,
        rows: lastKnownSize.rows,
    };
}

/**
 * 核心异步驱动调度器：按 FIFO 顺序依次分发执行排队任务。
 */
async function processQueueLoop() {
    if (queueProcessing || isExecutingCommand || commandUnresolved) {
        return;
    }
    if (executionQueue.length === 0) {
        return;
    }
    if (interactiveMode) {
        purgeExecutionQueue('终端已转入交互模式 (interactiveMode)，排队中的同步命令已安全取消。');
        return;
    }

    queueProcessing = true;
    const task = executionQueue.shift();

    try {
        isExecutingCommand = true;

        // 1. 协商目标视图
        await prepareTerminalView(task.target, false);

        // 2. 检查或新建会话
        if (task.newSession || !ptyProcess) {
            createNewPtySession();
        }
        isExecutingCommand = true;

        // 3. 等待 PTY 就绪
        await waitForPtyReady();

        // 4. 就绪后再次检查交互模式
        if (interactiveMode) {
            throw new Error('终端在等待就绪期间被交互式程序占用。');
        }

        // 5. 逐条执行命令链（单任务独享 60s 完整生命周期）
        const deltaOutputs = [];
        for (const entry of task.commandEntries) {
            const command = entry.value;
            const currentReturnModeKey = `returnMode${entry.index || ''}`;
            const currentReturnMode = task.args[currentReturnModeKey] || task.finalReturnMode;

            try {
                const output = await executeSingleCommandInPty(ptyProcess, command);
                deltaOutputs.push({ command, output, returnMode: currentReturnMode });
            } catch (error) {
                // 宽进严出因果铁律：前置命令发生任何异常中断，级联取消队列中的所有后序排队任务！
                const cancelled = purgeExecutionQueue(`由于前置命令 [${command}] 执行异常中断，为防止依赖错乱已安全取消后置排队命令。`);
                const cancelledNotice = cancelled.length > 0
                    ? `\n\n🛡️ [排队级联保护] 为杜绝后续命令在未决环境中发生输入踩踏，队列中排队的后续 ${cancelled.length} 个任务已同步安全取消。`
                    : '';
                throw new Error(`${error.message}${cancelledNotice}`);
            }
        }

        // 6. 格式化并交付成功结果
        let finalOutput = '';
        if (task.finalReturnMode === 'full') {
            finalOutput = deltaOutputs.length > 0 ? deltaOutputs[deltaOutputs.length - 1].output : '';
        } else {
            if (deltaOutputs.length === 1) {
                finalOutput = deltaOutputs[0].output;
            } else {
                finalOutput = deltaOutputs.map(res =>
                    `---[Output for: ${res.command}]---\n${res.output}`
                ).join('\n\n');
            }
        }

        const cleanOutput = finalOutput.replace(/\r\n/g, '\n').replace(/\r/g, '');
        task.resolve({ content: [{ type: 'text', text: `\`\`\`powershell\n${cleanOutput}\n\`\`\`` }] });
    } catch (err) {
        task.reject(err);
    } finally {
        isExecutingCommand = false;
        queueProcessing = false;
        // 如果队列还有待办且未被阻塞，异步调度下一轮
        if (executionQueue.length > 0) {
            setImmediate(processQueueLoop);
        }
    }
}

function writeSessionInput(data) {
    if (!ptyProcess || typeof data !== 'string') {
        return false;
    }
    ptyProcess.write(data);
    return true;
}

// 侧栏清屏时让 shell 自己也清一次。Windows 的 ConPTY 记着整屏内容，PTY 一改尺寸就按它整屏重绘，
// 只清前端的话旧内容马上又画回来；node-pty 的 clear() 只对随包的 conpty.dll 生效，系统自带的 ConPTY 上是空操作。
// 所以发 Ctrl+L：PSReadLine / readline 的清屏键，输了一半的命令保留。
// AI 命令或交互程序占着会话时不发，免得混进它们的输入；返回是否发出
function clearSessionScreen() {
    if (!ptyProcess || isExecutingCommand || commandUnresolved || interactiveMode) {
        return false;
    }
    ptyProcess.write('\x0c');
    return true;
}

/**
 * 等待指定 PTY 完成 PowerShell 初始化探针。
 * Promise 与具体 PTY 实例绑定，旧会话的迟到结果不能被新会话复用。
 * @param {object} targetPtyProcess - 要等待的 node-pty 实例。
 * @param {number} timeoutMs - 最大等待时间。
 */
async function waitForPtyReady(targetPtyProcess = ptyProcess, timeoutMs = 15000) {
    if (!targetPtyProcess || targetPtyProcess !== ptyProcess) {
        throw new Error('PowerShell PTY session is not available.');
    }

    let timeoutId = null;
    try {
        await Promise.race([
            ptyReadyPromise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`PowerShell PTY initialization timed out after ${timeoutMs}ms.`));
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }

    if (!ptyProcess || ptyProcess !== targetPtyProcess) {
        throw new Error('PowerShell PTY session changed or exited during initialization.');
    }
}

/**
 * 同时等待渲染端 xterm 和后端 PTY 就绪，确保指令不会在界面初始化前注入。
 */
async function waitForTerminalReady() {
    const targetPtyProcess = ptyProcess;
    await Promise.all([
        waitForGuiReady(),
        waitForPtyReady(targetPtyProcess)
    ]);
}

/**
 * 创建一个新的伪终端 (pty) 进程。
 */
function createNewPtySession() {
    if (pendingCommandCleanup) pendingCommandCleanup();
    // newSession 是交互模式的一期低成本复位入口。
    interactiveMode = false;
    isExecutingCommand = false;
    activeCommandAbort = null;

    // 如果已存在旧进程，先销毁它
    if (ptyProcess) {
        childProcesses.delete(ptyProcess);
        ptyProcess.kill();
        // 当重置会话时，通知前端清屏
        if (guiWindow && !guiWindow.isDestroyed()) {
            guiWindow.webContents.send('powershell-clear');
        }
    }
    clearReplay();
    terminalProjection = null;
    notifyMirrors('onClear');

    let shell = 'bash';
    let args = [];

    if (os.platform() === 'win32') {
        // 优先使用 PowerShell Core (pwsh.exe)，如果不存在则回退到 Windows PowerShell (powershell.exe)
        // 检测顺序：Program Files 标准路径 → where.exe PATH 查找 → 回退 powershell.exe
        const pwshPath = path.join(process.env.PROGRAMFILES, 'PowerShell', '7', 'pwsh.exe');
        if (fs.existsSync(pwshPath)) {
            shell = pwshPath;
        } else {
            // 二级回退：winget/MSIX 安装的 PS7 位于 WindowsApps（AppExecution Alias），
            // fs.existsSync 对此类特殊文件不可靠，直接信任 where.exe 结果。
            try {
                const { execSync } = require('child_process');
                const whereResult = execSync('where.exe pwsh', { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim();
                const firstLine = whereResult.split(/\r?\n/)[0].trim();
                if (firstLine) {
                    shell = firstLine;
                } else {
                    shell = 'powershell.exe';
                }
            } catch (e) {
                shell = 'powershell.exe';
            }
        }
        args = ['-NoLogo'];
    }

    ptyProcess = loadPty().spawn(shell, args, {
        name: 'xterm-color',
        cols: lastKnownSize.cols,
        rows: lastKnownSize.rows,
        cwd: process.env.USERPROFILE || process.env.HOME,
        env: {
            ...process.env,
            PAGER: 'cat',
            GIT_PAGER: 'cat',
            GIT_TERMINAL_PROMPT: '0',
            GH_PAGER: '',
            SYSTEMD_PAGER: 'cat',
            AWS_PAGER: '',
            MANPAGER: 'cat'
        }
    });
    childProcesses.add(ptyProcess);
    const currentPtyProcess = ptyProcess;

    // 创建GUI数据监听器（带 AI 短命令执行状态检查）
    guiDataListener = (data) => {
        // 渲染始终使用完整 PTY 流；命令解析只提取 AI 返回值，不改变屏幕坐标。
        dispatchPtyData(terminalProjection ? terminalProjection.push(data) : data);
    };

    // 设置数据监听器，将所有 pty 输出直接代理到 GUI
    currentPtyProcess.onData(guiDataListener);

    // 不再用固定延时猜测 PowerShell 是否启动完成。随机边界不会以明文出现在
    // PSReadLine 的输入回显中；只有 PowerShell 真正执行 Write-Host 后才会命中。
    const readyBoundary = `__VCP_PTY_READY_${crypto.randomUUID()}__`;
    const encodedReadyBoundary = Buffer.from(readyBoundary, 'utf8').toString('base64');
    mirrorStartupPending = true;
    mirrorStartupHeld = '';

    ptyReadyPromise = new Promise((resolve, reject) => {
        let startupOutput = '';
        let settled = false;
        let timeoutId = null;
        let readyListener = null;
        const cleanupReadyProbe = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (readyListener && typeof readyListener.dispose === 'function') {
                readyListener.dispose();
                readyListener = null;
            }
        };

        readyListener = currentPtyProcess.onData((data) => {
            if (settled) {
                return;
            }

            startupOutput += data.toString('utf8');
            // 防止异常启动输出无限占用内存，同时保留足够长度处理跨 chunk 边界。
            if (startupOutput.length > 65536) {
                startupOutput = startupOutput.slice(-65536);
            }

            const boundaryIndex = startupOutput.indexOf(readyBoundary);
            if (boundaryIndex !== -1) {
                settled = true;
                cleanupReadyProbe();
                if (ptyProcess === currentPtyProcess) {
                    releaseMirrorStartup(startupOutput.slice(boundaryIndex + readyBoundary.length).replace(/^\r?\n/, ''));
                }
                resolve();
            }
        });

        timeoutId = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            cleanupReadyProbe();
            if (ptyProcess === currentPtyProcess) releaseMirrorStartup();
            reject(new Error('PowerShell did not complete its startup readiness probe within 15 seconds.'));
        }, 15000);

        // macOS / Linux 起的是 bash：PowerShell 的初始化写进去只会报语法错误，边界永远等不到，
        // 前 15 秒侧栏一片空白。环境变量 spawn 时已经给了，这里只打印边界：两段引号拼起来，
        // 回显的命令行里是 '…''…'，不会提前命中
        if (os.platform() !== 'win32') {
            const split = Math.floor(readyBoundary.length / 2);
            currentPtyProcess.write(`printf '%s\\n' '${readyBoundary.slice(0, split)}''${readyBoundary.slice(split)}'; clear\r`);
            return;
        }
        const initializationCommand = [
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            '$env:PAGER = "cat"',
            '$env:GIT_PAGER = "cat"',
            '$env:GIT_TERMINAL_PROMPT = "0"',
            '$env:GH_PAGER = ""',
            '$env:SYSTEMD_PAGER = "cat"',
            '$env:AWS_PAGER = ""',
            '$env:MANPAGER = "cat"',
            'function global:more { param([string[]]$paths) if ($paths) { foreach ($file in $paths) { Get-Content $file } } else { $input } }',
            'function global:help { Get-Help @args }',
            // 彻底移除 Clear-Host：ConPTY 二维字符屏幕扫描会在微秒级内将同一行的 Write-Host 输出连同 Clear-Host 擦除，导致丢失就绪标记引发死锁。
            // 启动握手期数据已由 mirrorStartupPending 在内存层完全静音拦截，无需且绝不能在 shell 内清屏。
            `[System.Console]::Out.WriteLine([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedReadyBoundary}')))`
        ].join('; ');
        currentPtyProcess.write(`${initializationCommand}\r`);
    });
    // 只有 AI 命令会等它；没人等的时候超时也不能变成未处理的 rejection
    ptyReadyPromise.catch(() => {});

    // 当 pty 进程意外退出时，清理资源。
    // 注意：newSession 会先 kill 旧 PTY 再创建新 PTY，旧 PTY 的异步 onExit 不能误清理新会话。
    currentPtyProcess.onExit((exitInfo) => {
        childProcesses.delete(currentPtyProcess);
        // 自行结束的 shell 仍占着 ConPTY 的管道句柄，显式 kill 才会释放
        try {
            currentPtyProcess.kill();
        } catch (e) {
            // 进程已经退出
        }

        if (ptyProcess !== currentPtyProcess) {
            return;
        }

        if (pendingCommandCleanup) pendingCommandCleanup();
        ptyProcess = null;
        guiDataListener = null;
        isExecutingCommand = false;
        interactiveMode = false;
        activeCommandAbort = null;
        notifyMirrors('onExit', exitInfo && exitInfo.exitCode);
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
        const targetPtyProcess = ptyProcess;
        waitForTerminalReady()
            .then(() => {
                if (ptyProcess === targetPtyProcess) {
                    targetPtyProcess.write(buildHumanLaunchAnimationCommand());
                }
            })
            .catch((error) => {
                console.error('[PowerShellExecutor] Failed to initialize terminal launch animation:', error);
            });
    }

    return guiWindow;
}

/**
 * Execute in the shared PowerShell session; PTY is display only.
 * Timeout/cancellation ends the caller wait, not the execution lease.
 */
function executeSingleCommandInPty(targetPty, singleCommand) {
    return new Promise((resolve, reject) => {
        if (!targetPty) return reject(new Error('PTY process is not available.'));
        const run = beginCommandRun(singleCommand, { outputSource: 'capture' });
        const runId = crypto.randomUUID();
        const prefix = path.join(os.tmpdir(), `vcp-capture-${runId}`);
        const scriptPath = prefix + '.ps1';
        const wrapperPath = prefix + '-wrapper.ps1';
        const outputPath = prefix + '.log';
        const receiptPath = prefix + '.json';
        let timer = null;
        let timeout = null;
        let closed = false;
        let callerSettled = false;
        let output = '';

        const updateOutput = () => {
            if (!fs.existsSync(outputPath)) return;
            // Writer bounds the file independently of the terminal replay buffer.
            const next = fs.readFileSync(outputPath, 'utf8');
            if (next.length > output.length) {
                appendCommandRunOutput(run, next.slice(output.length));
                output = next;
            }
        };
        const release = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            clearTimeout(timeout);
            if (activeCommandAbort === abort) activeCommandAbort = null;
            if (pendingCommandCleanup === abandon) {
                pendingCommandCleanup = null;
                commandUnresolved = false;
            }
            for (const file of [scriptPath, wrapperPath, outputPath, receiptPath, receiptPath + '.pending']) {
                try { if (fs.existsSync(file)) fs.unlinkSync(file); }
                catch (error) { console.warn('[PowerShellExecutor] Capture cleanup:', error.message); }
            }
        };
        const abandon = () => {
            if (closed) return;
            finishCommandRun(run, 'cancelled');
            release();
            if (!callerSettled) {
                callerSettled = true;
                reject(new Error('PowerShell 会话已退出或被重置，执行回执未完成。'));
            }
        };
        const abort = () => {
            if (closed) return false;
            targetPty.write('\x03');
            commandUnresolved = true;
            finishCommandRun(run, 'cancelling');
            if (!callerSettled) {
                callerSettled = true;
                clearTimeout(timeout);
                reject(new Error('命令已收到 interrupt 请求；已发送 Ctrl+C，等待底层回执确认收尾。'));
            }
            return true;
        };
        pendingCommandCleanup = abandon;
        activeCommandAbort = abort;
        const poll = () => {
            if (closed) return;
            try {
                updateOutput();
                if (!fs.existsSync(receiptPath)) return;
                const receipt = parseCaptureReceipt(fs.readFileSync(receiptPath, 'utf8'), runId);
                updateOutput();
                output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
                run.raw = output;
                const state = run.status === 'cancelling' ? 'cancelled' : 'completed';
                finishCommandRun(run, state, receipt);
                release();
                if (!callerSettled) {
                    callerSettled = true;
                    const integrity = receipt.truncated ? 'truncated' : 'complete';
                    resolve(`[execution=${state}; output=${integrity}; errors=${receipt.errorCount}; terminatingError=${receipt.terminatingError}; nativeExit=${receipt.nativeExitCode ?? 'n/a'}; durationMs=${receipt.durationMs}]\n`
                        + (receipt.truncated ? '[输出超过容量限制，仅保留开头内容]\n' : '')
                        + output);
                }
            } catch (error) {
                // Never release an execution lease based on a broken/missing receipt.
                commandUnresolved = true;
                clearTimeout(timeout);
                if (!callerSettled) {
                    callerSettled = true;
                    reject(new Error(`底层采集失败，会话仍按未决占用处理：${error.message}。请中断或重建会话。`));
                }
            }
        };
        try {
            fs.writeFileSync(scriptPath, '\ufeff' + singleCommand, 'utf8');
            fs.writeFileSync(wrapperPath, '\ufeff' + buildCaptureWrapper({
                scriptPath, outputPath, receiptPath, runId
            }), 'utf8');
            timer = setInterval(poll, 100);
            timeout = setTimeout(() => {
                if (closed || callerSettled) return;
                callerSettled = true;
                commandUnresolved = true;
                finishCommandRun(run, 'running_detached');
                purgeExecutionQueue('前置命令超时但仍占用共享终端，后续排队命令已取消。');
                reject(new Error('命令超过 60 秒同步等待，仍在共享 PTY 执行。底层采集继续，禁止新命令插入；可 QueryVisible 巡视、InterruptPowerShell 请求中断或 newSession:true 重建。'));
            }, 60000);
            targetPty.write(`& '${wrapperPath.replace(/'/g, "''")}'\r`);
        } catch (error) {
            finishCommandRun(run, 'spawn_error');
            release();
            callerSettled = true;
            reject(error);
        }
    });
}


const INTERACTIVE_SEQUENCE_LIMITS = Object.freeze({
    maxSteps: 100,
    maxWaitMs: 60000,
    maxTotalWaitMs: 300000,
    maxTextLength: 100000,
    maxQueryLines: 2000,
    responseTimeoutMs: 5000
});

const TERMINAL_KEY_SEQUENCES = Object.freeze({
    enter: '\r',
    return: '\r',
    up: '\x1b[A',
    arrowup: '\x1b[A',
    down: '\x1b[B',
    arrowdown: '\x1b[B',
    right: '\x1b[C',
    arrowright: '\x1b[C',
    left: '\x1b[D',
    arrowleft: '\x1b[D',
    esc: '\x1b',
    escape: '\x1b',
    tab: '\t',
    backtab: '\x1b[Z',
    'shift+tab': '\x1b[Z',
    backspace: '\x7f',
    delete: '\x1b[3~',
    home: '\x1b[H',
    end: '\x1b[F',
    pageup: '\x1b[5~',
    pagedown: '\x1b[6~',
    space: ' ',
    'ctrl+c': '\x03',
    'ctrl+d': '\x04',
    'ctrl+z': '\x1a',
    'ctrl+l': '\x0c',
    'ctrl+a': '\x01',
    'ctrl+e': '\x05',
    'ctrl+u': '\x15',
    'ctrl+k': '\x0b',
    'ctrl+w': '\x17'
});

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseWaitDuration(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.round(value);
    }

    const match = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/);
    if (!match) {
        throw new Error(`无效 wait 时长 "${value}"；请使用 50ms、1s 或毫秒数字。`);
    }

    const milliseconds = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
    return Math.round(milliseconds);
}

function parseTerminalKey(value) {
    const raw = String(value).trim().toLowerCase();
    const match = raw.match(/^(.+?)(?:\s*\*\s*(\d+))?$/);
    const keyName = match ? match[1].trim() : raw;
    const repeat = match && match[2] ? Number.parseInt(match[2], 10) : 1;
    const sequence = TERMINAL_KEY_SEQUENCES[keyName];

    if (!sequence) {
        throw new Error(`不支持的终端按键 "${value}"。`);
    }
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
        throw new Error(`按键重复次数必须在 1 到 10 之间："${value}"。`);
    }

    return { keyName, repeat, data: sequence.repeat(repeat) };
}

function parseInteractiveSequence(args) {
    const steps = [];

    for (const [key, value] of Object.entries(args)) {
        const match = key.match(/^(command|wait|key|paste|queryVisible)(\d+)$/i);
        if (!match) {
            continue;
        }

        const typeLookup = {
            command: 'command',
            wait: 'wait',
            key: 'key',
            paste: 'paste',
            queryvisible: 'queryVisible'
        };
        steps.push({
            key,
            type: typeLookup[match[1].toLowerCase()],
            index: Number.parseInt(match[2], 10),
            value
        });
    }

    if (steps.length === 0) {
        throw new Error('RunInteractiveSequence 至少需要一个带全局序号的步骤，例如 command1、wait2、key3、paste4、queryVisible5。');
    }
    if (steps.length > INTERACTIVE_SEQUENCE_LIMITS.maxSteps) {
        throw new Error(`交互序列最多允许 ${INTERACTIVE_SEQUENCE_LIMITS.maxSteps} 个步骤。`);
    }

    steps.sort((a, b) => a.index - b.index);
    const usedIndexes = new Set();
    let totalWaitMs = 0;

    for (const step of steps) {
        if (!Number.isInteger(step.index) || step.index < 1) {
            throw new Error(`步骤编号必须是从 1 开始的正整数：${step.key}。`);
        }
        if (usedIndexes.has(step.index)) {
            throw new Error(`步骤编号 ${step.index} 重复；不同类型步骤必须共用唯一的全局序号。`);
        }
        usedIndexes.add(step.index);

        if (step.type === 'wait') {
            step.durationMs = parseWaitDuration(step.value);
            if (step.durationMs < 0 || step.durationMs > INTERACTIVE_SEQUENCE_LIMITS.maxWaitMs) {
                throw new Error(`单个 wait 步骤必须在 0 到 ${INTERACTIVE_SEQUENCE_LIMITS.maxWaitMs}ms 之间。`);
            }
            totalWaitMs += step.durationMs;
        } else if (step.type === 'key') {
            step.keySpec = parseTerminalKey(step.value);
        } else if (step.type === 'queryVisible') {
            const parsedLines = Number.parseInt(step.value, 10);
            step.maxLines = Number.isInteger(parsedLines) && parsedLines > 0
                ? Math.min(parsedLines, INTERACTIVE_SEQUENCE_LIMITS.maxQueryLines)
                : null;
        } else {
            if (typeof step.value !== 'string' || !step.value.length) {
                throw new Error(`${step.key} 必须是非空字符串。`);
            }
            if (step.value.length > INTERACTIVE_SEQUENCE_LIMITS.maxTextLength) {
                throw new Error(`${step.key} 超过 ${INTERACTIVE_SEQUENCE_LIMITS.maxTextLength} 字符限制。`);
            }
        }
    }

    if (totalWaitMs > INTERACTIVE_SEQUENCE_LIMITS.maxTotalWaitMs) {
        throw new Error(`序列累计等待不能超过 ${INTERACTIVE_SEQUENCE_LIMITS.maxTotalWaitMs}ms。`);
    }
    if (steps.every(step => step.type === 'wait')) {
        throw new Error('交互序列不能只包含 wait；请至少加入 command、key、paste 或 queryVisible 步骤。');
    }

    return steps;
}

function requestVisibleText(maxLines = null) {
    return new Promise((resolve, reject) => {
        if (!guiWindow || guiWindow.isDestroyed() || !guiReady) {
            reject(new Error('PowerShell GUI 尚未就绪，无法查询可见文本。'));
            return;
        }

        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
            visibleTextResolvers.delete(requestId);
            reject(new Error('查询终端文本超时'));
        }, INTERACTIVE_SEQUENCE_LIMITS.responseTimeoutMs);

        visibleTextResolvers.set(requestId, (text) => {
            clearTimeout(timeout);
            resolve(text);
        });
        guiWindow.webContents.send('query-visible-text', { requestId, maxLines });
    });
}

function requestTerminalPaste(text) {
    return new Promise((resolve, reject) => {
        if (!guiWindow || guiWindow.isDestroyed() || !guiReady) {
            reject(new Error('PowerShell GUI 尚未就绪，无法执行 xterm 粘贴。'));
            return;
        }

        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
            terminalPasteResolvers.delete(requestId);
            reject(new Error('xterm 粘贴请求超时'));
        }, INTERACTIVE_SEQUENCE_LIMITS.responseTimeoutMs);

        terminalPasteResolvers.set(requestId, () => {
            clearTimeout(timeout);
            resolve();
        });
        guiWindow.webContents.send('terminal-paste-request', { requestId, text });
    });
}

function terminalTarget(args) {
    const target = args.terminalTarget ?? 'sidebar';
    if (!['sidebar', 'window'].includes(target)) throw new Error('terminalTarget 必须为 sidebar 或 window。');
    return target;
}

function requestSidebar(action, params = {}) {
    return require('../../../modules/ipc/terminalHandlers').requestTerminalView(action, params);
}

async function prepareTerminalView(target, required = false) {
    if (target === 'window') {
        ensureGuiWindow();
        await waitForGuiReady();
    } else {
        const opening = requestSidebar('open');
        if (required) await opening;
        else opening.catch(error => console.warn('[PowerShellExecutor] Sidebar unavailable:', error.message));
    }
}

async function queryTarget(target, maxLines) {
    if (target === 'window') return requestVisibleText(maxLines);
    return requestSidebar('query', { maxLines });
}

async function pasteTarget(target, text) {
    if (target === 'window') return requestTerminalPaste(text);
    return requestSidebar('paste', { text });
}

async function ensureInteractiveTerminal(newSession = false, target = 'sidebar') {
    if (isExecutingCommand || queueProcessing || executionQueue.length > 0 || (commandUnresolved && !newSession)) {
        throw new Error('共享终端被同步或未决命令占用，不能投递交互输入。');
    }
    const previousMode = interactiveMode;
    interactiveMode = true;
    try {
        await prepareTerminalView(target, true);
        if (newSession === true || !ptyProcess) createNewPtySession();
        interactiveMode = true;
        await waitForPtyReady();
        return ptyProcess;
    } catch (error) {
        interactiveMode = previousMode;
        throw error;
    }
}

async function sendSingleInteractiveKey(args) {
    if (typeof args.key !== 'string' || !args.key.trim()) {
        throw new Error('SendInteractiveKey 需要 key 参数，例如 enter、up、esc 或 ctrl+c*2。');
    }

    const keySpec = parseTerminalKey(args.key);
    const targetPtyProcess = await ensureInteractiveTerminal(args.newSession === true, terminalTarget(args));
    targetPtyProcess.write(keySpec.data);

    return {
        content: [{
            type: 'text',
            text: `Interactive key sent: ${keySpec.keyName}${keySpec.repeat > 1 ? ` x${keySpec.repeat}` : ''}.`
        }]
    };
}

async function pasteSingleInteractiveText(args) {
    if (typeof args.text !== 'string' || !args.text.length) {
        throw new Error('PasteInteractiveText 需要非空 text 参数。');
    }
    if (args.text.length > INTERACTIVE_SEQUENCE_LIMITS.maxTextLength) {
        throw new Error(`text 超过 ${INTERACTIVE_SEQUENCE_LIMITS.maxTextLength} 字符限制。`);
    }

    const target = terminalTarget(args);
    await ensureInteractiveTerminal(args.newSession === true, target);
    await pasteTarget(target, args.text);

    if (args.submit === true) {
        if (!ptyProcess) {
            throw new Error('粘贴完成后 PTY 会话已退出，无法发送 Enter。');
        }
        ptyProcess.write('\r');
    }

    return {
        content: [{
            type: 'text',
            text: `Interactive text pasted (${args.text.length} characters)${args.submit === true ? ' and Enter was sent' : ''}.`
        }]
    };
}

async function runInteractiveSequence(args) {
    const steps = parseInteractiveSequence(args);

    for (const step of steps.filter(item => item.type === 'command')) {
        const securityResult = intelligentSecurityCheck(
            step.value,
            defaultConfig.forbiddenCommands,
            defaultConfig.authRequiredCommands
        );
        if (securityResult.isForbidden) {
            throw new Error(`步骤 ${step.index} 执行被阻止：${securityResult.reason}`);
        }
        if (securityResult.needsAuth) {
            throw new Error(`步骤 ${step.index} 需要授权，RunInteractiveSequence 不支持在 TUI 序列中弹出授权确认：${securityResult.reason}`);
        }
    }

    const target = terminalTarget(args);
    const targetPtyProcess = await ensureInteractiveTerminal(args.newSession === true, target);
    const queryResults = [];

    for (const step of steps) {
        if (!ptyProcess || ptyProcess !== targetPtyProcess) {
            throw new Error(`执行到步骤 ${step.index} 时 PTY 会话已退出或被替换。`);
        }

        switch (step.type) {
            case 'command':
                targetPtyProcess.write(`${step.value}\r`);
                break;
            case 'wait':
                await delay(step.durationMs);
                break;
            case 'key':
                targetPtyProcess.write(step.keySpec.data);
                break;
            case 'paste':
                await pasteTarget(target, step.value);
                break;
            case 'queryVisible': {
                const text = await queryTarget(target, step.maxLines);
                queryResults.push({ index: step.index, maxLines: step.maxLines, text });
                break;
            }
            default:
                throw new Error(`未知交互步骤类型：${step.type}`);
        }
    }

    if (queryResults.length === 0) {
        return {
            content: [{
                type: 'text',
                text: `Interactive sequence completed (${steps.length} steps). No queryVisible step was requested.`
            }]
        };
    }

    const output = queryResults.map(result => {
        const lineLabel = result.maxLines ? `, max ${result.maxLines} lines` : '';
        return `---[queryVisible step ${result.index}${lineLabel}]---\n${result.text}`;
    }).join('\n\n');

    return { content: [{ type: 'text', text: `\`\`\`\n${output}\n\`\`\`` }] };
}

async function processToolCall(args) {
    const target = terminalTarget(args);
    const declaredCommands = new Set([
        'ExecutePowerShell',
        'StartInteractive',
        'SendInteractiveKey',
        'PasteInteractiveText',
        'RunInteractiveSequence',
        'QueryVisible',
        'InterruptPowerShell',
        'EndInteractive'
    ]);
    const declaredCommand = typeof args.command === 'string' && declaredCommands.has(args.command.trim())
        ? args.command.trim()
        : null;

    // 新清单格式使用 command 选择能力、powershell 传递脚本文本。
    // 同时保留旧 action + command 调用格式，避免已有提示词和调用方立即失效。
    const actionByDeclaredCommand = {
        ExecutePowerShell: 'execute',
        StartInteractive: 'startInteractive',
        SendInteractiveKey: 'interactiveKey',
        PasteInteractiveText: 'interactivePaste',
        RunInteractiveSequence: 'interactiveSequence',
        QueryVisible: 'queryVisible',
        InterruptPowerShell: 'interrupt',
        EndInteractive: 'endInteractive'
    };
    const action = declaredCommand
        ? actionByDeclaredCommand[declaredCommand]
        : (typeof args.action === 'string' ? args.action.trim() : 'execute');

    if (action === 'interactiveKey') {
        return sendSingleInteractiveKey(args);
    }

    if (action === 'interactivePaste') {
        return pasteSingleInteractiveText(args);
    }

    if (action === 'interactiveSequence') {
        return runInteractiveSequence(args);
    }

    if (action.startsWith('queryVisible')) {
        await prepareTerminalView(target, true);

        const legacyMatch = action.match(/^queryVisible(\d+)?$/);
        const requestedMaxLines = declaredCommand === 'QueryVisible' ? args.maxLines : (legacyMatch && legacyMatch[1]);
        const parsedMaxLines = requestedMaxLines === undefined || requestedMaxLines === null || requestedMaxLines === ''
            ? null
            : Number.parseInt(requestedMaxLines, 10);
        const maxLines = Number.isInteger(parsedMaxLines) && parsedMaxLines > 0
            ? Math.min(parsedMaxLines, INTERACTIVE_SEQUENCE_LIMITS.maxQueryLines)
            : null;
        const text = await queryTarget(target, maxLines);
        return { content: [{ type: 'text', text: `\`\`\`\n${text}\n\`\`\`` }] };
    }

    if (action === 'endInteractive') {
        interactiveMode = false;
        return { content: [{ type: 'text', text: 'Interactive mode flag cleared. The existing PTY session was not terminated.' }] };
    }

    if (action === 'interrupt') {
        if (!ptyProcess) {
            return { content: [{ type: 'text', text: 'No active PowerShell session to interrupt.' }] };
        }

        // 宽进严出因果铁律：任何显式中断动作，都必须级联打断清空后序排队队列
        const cancelled = purgeExecutionQueue('当前全局队列已被中断命令停止，后续排队任务已全部安全取消。');

        let interruptedCurrent = false;
        if (activeCommandAbort) {
            interruptedCurrent = activeCommandAbort();
        } else if (interactiveMode) {
            ptyProcess.write('\x03');
            interruptedCurrent = true;
        } else {
            // 向 PTY 发送 Ctrl+C，确保任何后台遗留的长任务或未决前台被清理并恢复提示符
            ptyProcess.write('\x03');
            interruptedCurrent = true;
        }

        const cancelledList = cancelled.length > 0
            ? '\n\n📋 **[级联清理清单]** 已同步安全取消队列中排队的后续 ' + cancelled.length + ' 个任务，杜绝依赖错乱：\n' +
              cancelled.map((t, idx) => `  • [排队任务 ${idx + 1}] ${t.commandEntries.map(e => e.value).join('; ')}`).join('\n')
            : '\n\nℹ️ 队列中无其他待执行任务。';

        const statusMessage = interruptedCurrent
            ? '🛑 **[中断请求已投递]** 已向活动 PTY 会话发送 Ctrl+C；这是中断请求，不代表前台进程已退出。'
            : 'ℹ️ **[中断处理完毕]** 当前无活动的同步执行命令。';

        return { content: [{ type: 'text', text: `${statusMessage}${cancelledList}` }] };
    }

    // --- 1. 解析和排序 PowerShell 脚本 ---
    // 新格式：powershell, powershell1, powershell2...
    // 旧格式：command, command1, command2...
    const scriptParameterPrefix = declaredCommand ? 'powershell' : 'command';
    const commandEntries = Object.entries(args)
        .filter(([key]) => key.startsWith(scriptParameterPrefix))
        .map(([key, value]) => {
            const match = key.match(new RegExp(`^${scriptParameterPrefix}(\\d*)$`));
            const index = match ? (match[1] === '' ? 0 : parseInt(match[1], 10)) : -1;
            return { key, value, index };
        })
        .filter(item => item.index !== -1 && typeof item.value === 'string' && item.value.trim())
        .sort((a, b) => a.index - b.index);

    // 新格式中的 args.command 是能力选择器，绝不能作为待执行脚本。
    if (declaredCommand) {
        commandEntries.forEach(entry => {
            entry.value = entry.value.trim();
        });
    }

    if (commandEntries.length === 0) {
        throw new Error(declaredCommand
            ? '未提供任何有效的 powershell 参数 (例如 powershell, powershell1, powershell2)。'
            : '未提供任何有效的 command 参数 (例如 command, command1, command2)。');
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
        // 提权任务使用独立进程，不终止普通共享会话。
        const command = commandEntries[0].value;
        const fullCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $env:PAGER = 'cat'; $env:GIT_PAGER = 'cat'; $env:GIT_TERMINAL_PROMPT = '0'; function global:more { param([string[]]$paths) if ($paths) { foreach ($file in $paths) { Get-Content $file } } else { $input } }; function global:help { Get-Help @args }; ${command}`;
        const output = await executeAdminCommand(fullCommand);
        if (output && typeof output === 'object' && Array.isArray(output.content)) {
            return output;
        }
        const cleanOutput = (typeof output === 'string' ? output : String(output || '')).replace(/\r\n/g, '\n').replace(/\r/g, '');
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
    // 检查交互模式：TUI 运行中严禁启动任何同步脚本调用
    if (commandUnresolved) {
        if (!newSession) throw new Error('共享终端仍有未决命令；等待底层回执，或使用 newSession:true 重建。');
        createNewPtySession();
    }
    if (interactiveMode && !newSession) {
        throw new Error('当前终端正被交互式程序 (snow/codex/claude) 占用，请先退出并调用 action:"endInteractive"，或使用 newSession:true 重置会话。');
    }

    if (action === 'startInteractive') {
        if (commandEntries.length > 1) {
            throw new Error('startInteractive 只支持单条 command。');
        }

        // 存在排队任务或正在执行同步命令时，禁止抢占开启交互式
        if (isExecutingCommand || executionQueue.length > 0) {
            throw new Error('当前有同步命令正在执行或排队中，无法启动交互式程序。请等待其完成或调用 InterruptPowerShell 中止。');
        }

        await ensureInteractiveTerminal(newSession, target);

        const command = commandEntries[0].value;
        interactiveMode = true;
        // 不设置 isExecutingCommand；交互式 TUI 输出必须走常驻 guiDataListener，否则会黑屏。
        ptyProcess.write(`${command}\r`);
        return { content: [{ type: 'text', text: `Interactive session started: ${command}` }] };
    }

    // 同步执行命令排队入口 (FIFO Queue)
    if (executionQueue.length >= MAX_EXECUTION_QUEUE_SIZE) {
        throw new Error(`[PowerShellExecutor] 命令排队队列已满 (当前排队上限 ${MAX_EXECUTION_QUEUE_SIZE} 个)，请求被拒绝。请等待当前任务完成或调用 InterruptPowerShell 清空队列。`);
    }

    return new Promise((resolve, reject) => {
        executionQueue.push({
            id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            commandEntries,
            target,
            newSession,
            finalReturnMode,
            args,
            resolve,
            reject,
            createdAt: Date.now()
        });
        processQueueLoop();
    });
}

/**
 * 清理插件资源，在主程序退出或插件重载时调用。
 */
function cleanup() {
    if (pendingCommandCleanup) pendingCommandCleanup();
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
    guiReady = false;
    if (resolveGuiReady) {
        resolveGuiReady();
        resolveGuiReady = null;
    }
    guiReadyPromise = Promise.resolve();
    visibleTextResolvers.clear();
    terminalPasteResolvers.clear();

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
    purgeExecutionQueue('PowerShell 插件正在清理重载，排队任务已终止。');
    mirrorSinks.clear();
    terminalProjection = null;
    clearReplay();
    mirrorStartupPending = false;
    mirrorStartupHeld = '';
    ptyProcess = null;
    ptyReadyPromise = Promise.resolve();
    guiDataListener = null;
    isExecutingCommand = false;
    interactiveMode = false;
    activeCommandAbort = null;
}

// 导出主入口、GUI/清理函数，以及无 Electron 副作用的序列解析器供单元测试使用。
module.exports = {
    processToolCall,
    openGuiTerminal,
    attachMirror,
    listCommandRuns,
    getCommandRun,
    subscribeCommandRuns,
    // 仅供测试：跳过 GUI 窗口，直接在共享 PTY 会话里跑一条短命令
    _runCommandForTest: (command) => executeSingleCommandInPty(ptyProcess, command),
    ensureMirrorSession,
    restartSession,
    getSessionState,
    writeSessionInput,
    clearSessionScreen,
    resizeSession: applyPtyResize,
    cleanup,
    parseInteractiveSequence,
    parseWaitDuration,
    parseTerminalKey
};