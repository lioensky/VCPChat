const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const PluginErrorReporter = require('./PluginErrorReporter');
const reporter = new PluginErrorReporter('PTYShellExecutor');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { BrowserWindow, ipcMain, clipboard } = require('electron');
const chokidar = require('chokidar');

// ============================================================================
// 异步任务管理器 (AsyncTaskManager)
// ============================================================================

/**
 * 异步任务管理器
 * 用于管理长时间运行的后台任务（如 codex、长时间编译等）
 */
class AsyncTaskManager {
    constructor() {
        // 任务存储: Map<taskId, TaskInfo>
        this.tasks = new Map();
        
        // 任务状态目录（持久化）
        this.stateDir = path.join(__dirname, 'state');
        this.ensureStateDir();
        
        // 最大保留任务数（防止内存泄漏）
        this.maxTasks = 100;
        
        // 任务输出最大长度（5MB）
        this.maxOutputLength = 5 * 1024 * 1024;

        // 并发控制
        this.maxConcurrent = 5;
        this.runningCount = 0;
        this.queue = [];

        // 默认任务超时 (30分钟)
        this.defaultTaskTimeout = 30 * 60 * 1000;
    }
    
    ensureStateDir() {
        if (!fs.existsSync(this.stateDir)) {
            fs.mkdirSync(this.stateDir, { recursive: true });
        }
    }
    
    /**
     * 生成唯一任务ID
     */
    generateTaskId() {
        const timestamp = Date.now().toString(36);
        const random = crypto.randomBytes(4).toString('hex');
        return `task_${timestamp}_${random}`;
    }
    
    /**
     * 启动异步任务
     * @param {string} command - 要执行的命令
     * @param {object} options - 选项
     * @returns {object} - { taskId, status }
     */
    startTask(command, options = {}) {
        const taskId = this.generateTaskId();
        const shell = options.shell || process.env.SHELL || '/bin/bash';
        
        // 异步清理旧任务，不阻塞主线程
        setImmediate(() => this.cleanupOldTasks());
        
        const taskInfo = {
            taskId,
            command,
            shell,
            options,
            status: 'queued',
            output: '',
            exitCode: null,
            startTime: new Date().toISOString(),
            endTime: null,
            pid: null,
            _term: null,
            _process: null,
            _timeoutTimer: null,
            // P0: 用于修复 cancel 导致的死锁
            _finalized: false,
            _cancelRequested: false
        };

        this.tasks.set(taskId, taskInfo);

        // 进入队列
        this.queue.push(taskId);
        this.processQueue();

        return {
            taskId,
            status: 'queued',
            message: '任务已加入队列，使用 action: "query" 查询状态'
        };
    }

    /**
     * 处理任务队列 - P1: 填满并发
     */
    processQueue() {
        // 使用 while 循环填满并发槽位
        while (this.runningCount < this.maxConcurrent && this.queue.length > 0) {
            const taskId = this.queue.shift();
            const taskInfo = this.tasks.get(taskId);

            if (!taskInfo || taskInfo.status !== 'queued') {
                continue; // 跳过无效任务，继续处理下一个
            }

            this.executeTask(taskInfo);
        }
    }

    /**
     * 真正执行任务
     */
    executeTask(taskInfo) {
        const { taskId, command, shell, options } = taskInfo;
        this.runningCount++;
        taskInfo.status = 'running';

        // 初始化 headless 终端
        const term = new Terminal({
            cols: 120, rows: 100, allowProposedApi: true
        });
        taskInfo._term = term;

        let currentOutputSize = 0;

        try {
            const proc = spawn(shell, ['-c', command], {
                cwd: options.cwd || process.env.HOME || '/home',
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    LANG: 'en_US.UTF-8',
                    LC_ALL: 'en_US.UTF-8',
                    DEBIAN_FRONTEND: 'noninteractive',
                    CI: 'true'
                },
                detached: false,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            taskInfo.pid = proc.pid;
            taskInfo._process = proc;

            const onData = (data) => {
                if (currentOutputSize < this.maxOutputLength) {
                    const remaining = this.maxOutputLength - currentOutputSize;
                    const toWrite = data.length > remaining ? data.slice(0, remaining) : data;
                    term.write(toWrite);
                    currentOutputSize += toWrite.length;
                    
                    if (currentOutputSize >= this.maxOutputLength) {
                        term.write('\r\n\x1b[31m[Error] Output limit exceeded, truncating...\x1b[0m\r\n');
                    }
                }
            };

            proc.stdout.on('data', onData);
            proc.stderr.on('data', onData);

            // P0: 修复 cancel 导致队列死锁 - 使用 _finalized 标志确保只执行一次
            const finalize = (status, code, errorMsg = null) => {
                // 确保只 finalize 一次
                if (taskInfo._finalized) return;
                taskInfo._finalized = true;
                
                // 清除超时定时器
                if (taskInfo._timeoutTimer) {
                    clearTimeout(taskInfo._timeoutTimer);
                    taskInfo._timeoutTimer = null;
                }

                // 根据 _cancelRequested 决定最终状态
                if (taskInfo._cancelRequested) {
                    taskInfo.status = 'cancelled';
                } else {
                    taskInfo.status = status;
                }
                
                taskInfo.exitCode = code;
                taskInfo.endTime = new Date().toISOString();
                taskInfo.output = getCleanTextFromBuffer(term);
                if (errorMsg) taskInfo.output += `\n[Error] ${errorMsg}`;
                if (taskInfo._cancelRequested) taskInfo.output += '\n\n[任务已被用户取消]';

                // 彻底释放资源
                if (taskInfo._term) {
                    taskInfo._term.dispose();
                    taskInfo._term = null;
                }
                taskInfo._process = null;

                this.saveTaskState(taskId, taskInfo);
                
                // 关键：无论什么路径，都必须减少 runningCount
                this.runningCount--;
                console.log(`[PTYShellExecutor] Task ${taskId} ${taskInfo.status} with code ${code}`);
                
                // 继续处理队列
                this.processQueue();
            };

            proc.on('close', (code) => finalize(code === 0 ? 'completed' : 'failed', code));
            proc.on('error', (err) => finalize('failed', -1, err.message));

            // 设置超时
            const timeout = options.timeout || this.defaultTaskTimeout;
            taskInfo._timeoutTimer = setTimeout(() => {
                if (taskInfo.status === 'running') {
                    console.warn(`[PTYShellExecutor] Task ${taskId} timed out after ${timeout}ms`);
                    if (taskInfo._process) {
                        try { taskInfo._process.kill('SIGKILL'); } catch(e) {}
                    }
                    finalize('failed', -2, `Task timed out after ${timeout}ms`);
                }
            }, timeout);

        } catch (err) {
            this.runningCount--;
            taskInfo.status = 'failed';
            taskInfo.output = `[Launch Error] ${err.message}`;
            reporter.capture('asyncTaskLaunch', err, { taskId, command, shell });
            this.saveTaskState(taskId, taskInfo);
            this.processQueue();
        }
    }
    
    /**
     * 查询任务状态
     * @param {string} taskId - 任务ID
     * @returns {object} - 任务信息
     */
    queryTask(taskId) {
        // 先从内存中查找
        let taskInfo = this.tasks.get(taskId);
        
        // 如果内存中没有，尝试从文件加载
        if (!taskInfo) {
            taskInfo = this.loadTaskState(taskId);
        }
        
        if (!taskInfo) {
            return {
                taskId,
                status: 'not_found',
                message: `任务 ${taskId} 不存在`
            };
        }
        
        // 返回任务信息（不包含进程引用）
        return {
            taskId: taskInfo.taskId,
            command: taskInfo.command,
            status: taskInfo.status,
            output: taskInfo.status === 'running' ? getCleanTextFromBuffer(taskInfo._term) : taskInfo.output,
            exitCode: taskInfo.exitCode,
            startTime: taskInfo.startTime,
            endTime: taskInfo.endTime,
            pid: taskInfo.pid
        };
    }
    
    /**
     * 取消任务 - P0: 修复死锁问题
     * @param {string} taskId - 任务ID
     * @returns {object} - 操作结果
     */
    cancelTask(taskId) {
        const taskInfo = this.tasks.get(taskId);
        
        if (!taskInfo) {
            return {
                taskId,
                status: 'not_found',
                message: `任务 ${taskId} 不存在或已完成`
            };
        }
        
        // 如果已经完成或已取消，返回当前状态
        if (taskInfo._finalized || taskInfo.status === 'cancelled' || taskInfo.status === 'completed' || taskInfo.status === 'failed') {
            return {
                taskId,
                status: taskInfo.status,
                message: `任务已经是 ${taskInfo.status} 状态，无法取消`
            };
        }
        
        // 如果还在队列中（未开始执行）
        if (taskInfo.status === 'queued') {
            // 从队列中移除
            const queueIndex = this.queue.indexOf(taskId);
            if (queueIndex !== -1) {
                this.queue.splice(queueIndex, 1);
            }
            taskInfo.status = 'cancelled';
            taskInfo._finalized = true;
            taskInfo.endTime = new Date().toISOString();
            taskInfo.output = '[任务在启动前被取消]';
            this.saveTaskState(taskId, taskInfo);
            return {
                taskId,
                status: 'cancelled',
                message: '任务已取消（未启动）'
            };
        }
        
        // 如果正在运行，设置取消标记并终止进程
        // 关键：不直接修改 status 为 cancelled，让 finalize 来处理
        taskInfo._cancelRequested = true;
        taskInfo.status = 'cancelling'; // 中间状态，表示正在取消
        
        // 终止进程
        if (taskInfo._process) {
            try {
                taskInfo._process.kill('SIGTERM');
                // 给进程一些时间优雅退出
                setTimeout(() => {
                    if (taskInfo._process && !taskInfo._process.killed) {
                        try {
                            taskInfo._process.kill('SIGKILL');
                        } catch (e) { /* ignore */ }
                    }
                }, 3000);
            } catch (e) {
                console.error(`[PTYShellExecutor] Error killing task ${taskId}:`, e);
            }
        }
        
        // 注意：不在这里 runningCount--，由 finalize 处理
        // 不在这里 saveTaskState，由 finalize 处理
        
        return {
            taskId,
            status: 'cancelling',
            message: '任务取消请求已发送，等待进程退出'
        };
    }
    
    /**
     * 列出所有任务
     * @returns {array} - 任务列表
     */
    listTasks() {
        const taskList = [];
        
        // 从内存中获取
        for (const [taskId, taskInfo] of this.tasks) {
            taskList.push({
                taskId: taskInfo.taskId,
                command: taskInfo.command.substring(0, 100) + (taskInfo.command.length > 100 ? '...' : ''),
                status: taskInfo.status,
                startTime: taskInfo.startTime,
                endTime: taskInfo.endTime,
                pid: taskInfo.pid
            });
        }
        
        // 从文件中加载已完成的任务
        try {
            const files = fs.readdirSync(this.stateDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const taskId = file.replace('.json', '');
                    if (!this.tasks.has(taskId)) {
                        const taskInfo = this.loadTaskState(taskId);
                        if (taskInfo) {
                            taskList.push({
                                taskId: taskInfo.taskId,
                                command: taskInfo.command.substring(0, 100) + (taskInfo.command.length > 100 ? '...' : ''),
                                status: taskInfo.status,
                                startTime: taskInfo.startTime,
                                endTime: taskInfo.endTime,
                                pid: taskInfo.pid
                            });
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[PTYShellExecutor] Error listing tasks from files:', e);
        }
        
        // 按开始时间倒序排列
        taskList.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
        
        return taskList;
    }
    
    /**
     * 保存任务状态到文件
     */
    saveTaskState(taskId, taskInfo) {
        try {
            const filePath = path.join(this.stateDir, `${taskId}.json`);
            const saveData = {
                taskId: taskInfo.taskId,
                command: taskInfo.command,
                shell: taskInfo.shell,
                status: taskInfo.status,
                output: taskInfo.output,
                exitCode: taskInfo.exitCode,
                startTime: taskInfo.startTime,
                endTime: taskInfo.endTime,
                pid: taskInfo.pid
            };
            fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2));
        } catch (e) {
            console.error(`[PTYShellExecutor] Error saving task state ${taskId}:`, e);
        }
    }
    
    /**
     * 从文件加载任务状态
     */
    loadTaskState(taskId) {
        try {
            const filePath = path.join(this.stateDir, `${taskId}.json`);
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(data);
            }
        } catch (e) {
            console.error(`[PTYShellExecutor] Error loading task state ${taskId}:`, e);
        }
        return null;
    }
    
    /**
     * 清理旧任务
     */
    cleanupOldTasks() {
        // 清理内存中已完成的旧任务
        if (this.tasks.size > this.maxTasks) {
            const sortedTasks = [...this.tasks.entries()]
                .filter(([_, info]) => info.status !== 'running')
                .sort((a, b) => new Date(a[1].startTime) - new Date(b[1].startTime));
            
            const toRemove = sortedTasks.slice(0, this.tasks.size - this.maxTasks);
            for (const [taskId] of toRemove) {
                this.tasks.delete(taskId);
            }
        }
        // 清理超过7天的文件
        try {
            const files = fs.readdirSync(this.stateDir);
            const now = Date.now();
            const maxAge = 7 * 24 * 60 * 60 * 1000; // 7天
            
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(this.stateDir, file);
                    const stat = fs.statSync(filePath);
                    if (now - stat.mtimeMs > maxAge) {
                        fs.unlinkSync(filePath);
                    }
                }
            }
        } catch (e) {
            console.error('[PTYShellExecutor] Error cleaning up old tasks:', e);
        }
    }
    
    /**
     * 清理所有资源
     */
    cleanup() {
        // 终止所有运行中的任务
        for (const [taskId, taskInfo] of this.tasks) {
            if (taskInfo.status === 'running' && taskInfo._process) {
                try {
                    taskInfo._process.kill('SIGTERM');
                } catch (e) {
                    // ignore
                }
            }
        }
        this.tasks.clear();
    }
}

// 创建全局异步任务管理器实例
const asyncTaskManager = new AsyncTaskManager();

// ============================================================================
// GUI Window Management
// ============================================================================

// --- GUI Window Management ---
let guiWindow = null;

function ensureGuiWindow() {
    if (!BrowserWindow) return; // 非 Electron 环境下跳过 GUI
    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.focus();
        return;
    }

    guiWindow = new BrowserWindow({
        width: 900,
        height: 600,
        title: 'VCP Local Shell Executor',
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'gui', 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            spellcheck: false,
            additionalArguments: [`--node-modules-path=${path.join(__dirname, '..', '..', '..', 'node_modules')}`]
        },
        autoHideMenuBar: true,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: true
    });

    guiWindow.loadFile(path.join(__dirname, 'gui', 'ShellViewer.html'));

    guiWindow.on('closed', () => {
        guiWindow = null;
        if (ptyProcess) {
            try {
                ptyProcess.kill();
                console.log('[PTYShellExecutor] GUI closed, pty process terminated.');
            } catch (e) {
                console.error('[PTYShellExecutor] Error terminating pty on GUI close:', e);
            }
        }
    });
}

// --- 主题管理 ---
const settingsPath = path.join(__dirname, '..', '..', '..', 'AppData', 'settings.json');
const rootSettingsPath = path.join(__dirname, '..', '..', '..', 'settings.json');
let settingsWatcher = null;
let lastSentTheme = null;

function sendThemeUpdate(targetWebContents, forceSend = false) {
    if (!targetWebContents || targetWebContents.isDestroyed()) return;
    try {
        let currentTheme = 'dark';
        // 优先检查 AppData/settings.json，回退到根目录 settings.json
        const targetPath = fs.existsSync(settingsPath) ? settingsPath : (fs.existsSync(rootSettingsPath) ? rootSettingsPath : null);
        
        if (targetPath) {
            // 使用同步读取并强制不使用缓存
            const content = fs.readFileSync(targetPath, 'utf-8');
            const settings = JSON.parse(content);
            currentTheme = settings.currentThemeMode || 'dark';
            console.log(`[PTYShellExecutor] Detected theme from ${targetPath}: ${currentTheme}`);
        }
        
        if (currentTheme !== lastSentTheme || forceSend) {
            targetWebContents.send('theme-init', { themeName: currentTheme });
            lastSentTheme = currentTheme;
        }
    } catch (error) {
        console.error('[PTYShellExecutor] Error sending theme:', error);
    }
}

function setupThemeWatcher() {
    if (settingsWatcher) settingsWatcher.close();
    // 同时监听两个可能的配置文件路径
    // 使用更激进的轮询模式以确保在某些文件系统上能检测到变化
    settingsWatcher = chokidar.watch([settingsPath, rootSettingsPath], {
        persistent: true,
        ignoreInitial: true,
        usePolling: true,
        interval: 500,
        binaryInterval: 1000
    });
    
    settingsWatcher.on('all', (event, path) => {
        if (guiWindow && !guiWindow.isDestroyed()) {
            // 稍微延迟读取，确保文件写入已完成
            setTimeout(() => {
                // 竞态保护：延迟期间窗口可能已关闭并将 guiWindow 置空
                if (guiWindow && !guiWindow.isDestroyed()) {
                    sendThemeUpdate(guiWindow.webContents);
                }
            }, 100);
        }
    });
}

setupThemeWatcher();

// --- IPC 事件监听 ---
if (ipcMain) {
    ipcMain.on('shell-gui-ready', (event) => {
        sendThemeUpdate(event.sender, true);
        
        // 如果 PTY 尚未启动，则主动启动一个默认会话
        if (!ptyProcess) {
            console.log('[PTYShellExecutor] GUI ready but no PTY session. Starting default session...');
            createNewPtySession();
        }
        
        // 通知 GUI PTY 连接状态
        if (ptyProcess) {
            event.sender.send('pty-status', { connected: true });
        }
    });

    // 原始按键输入 - 直接写入 PTY（用于终端直接输入模式）
    ipcMain.on('shell-input', (event, data) => {
        if (ptyProcess && data) {
            ptyProcess.write(data);
        }
    });

    // 完整命令执行 - 添加换行符（用于输入框模式）
    ipcMain.on('shell-command', (event, command) => {
        if (ptyProcess && command) {
            ptyProcess.write(`${command}\n`);
        }
    });

    ipcMain.on('copy-to-clipboard', (event, text) => {
        if (text && clipboard) clipboard.writeText(text);
    });

    ipcMain.on('shell-resize', (event, { cols, rows }) => {
        if (ptyProcess) {
            try { ptyProcess.resize(cols, rows); } catch (e) { /* ignore */ }
        }
    });

    ipcMain.on('minimize-window', () => { if (guiWindow) guiWindow.minimize(); });
    ipcMain.on('maximize-window', () => {
        if (guiWindow) {
            guiWindow.isMaximized() ? guiWindow.unmaximize() : guiWindow.maximize();
        }
    });
    ipcMain.on('close-window', () => { if (guiWindow) guiWindow.close(); });
}

// --- ANSI 清理 ---
/**
 * 清理终端输出中的 ANSI 转义序列和控制字符
 *
 * 处理的序列类型：
 * 1. CSI (Control Sequence Introducer) - \x1b[ 开头的序列
 * 2. OSC (Operating System Command) - \x1b] 开头的序列，包括：
 *    - OSC 0/1/2: 窗口标题
 *    - OSC 7: 当前工作目录
 *    - OSC 133: Shell integration (fish/zsh/bash 的命令标记)
 *    - OSC 1337: iTerm2 专有序列
 * 3. 其他转义序列 (DCS, PM, APC 等)
 * 4. 单字符控制序列
 * 5. 数据分片导致的残留片段（如 [4;1m, [0m 等）
 *
 * @param {string} str - 包含 ANSI 序列的原始字符串
 * @returns {string} - 清理后的纯文本字符串
 */
function stripAnsi(str) {
    if (!str || typeof str !== 'string') return str || '';
    
    return str
        // OSC 序列: \x1b] ... (\x07 | \x1b\\)
        // 匹配 OSC 133 (shell integration), OSC 0/1/2 (标题), OSC 7 (cwd) 等
        .replace(/\x1b\][\d;]*(?:[^\x07\x1b]*)?(?:\x07|\x1b\\)/g, '')
        
        // CSI 序列: \x1b[ ... (字母结尾)
        // 包括颜色、光标移动、清屏等
        .replace(/\x1b\[[\d;]*[A-Za-z]/g, '')
        
        // CSI 序列 (扩展): 处理更复杂的 CSI 序列
        .replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, '')
        
        // DCS (Device Control String): \x1bP ... \x1b\\
        .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
        
        // PM (Privacy Message): \x1b^ ... \x1b\\
        .replace(/\x1b\^[^\x1b]*\x1b\\/g, '')
        
        // APC (Application Program Command): \x1b_ ... \x1b\\
        .replace(/\x1b_[^\x1b]*\x1b\\/g, '')
        
        // 单字符转义序列: \x1b 后跟单个字符
        .replace(/\x1b[DMEHcn78>=]/g, '')
        
        // 清理残留的 BEL 字符
        .replace(/\x07/g, '')
        
        // 清理其他 C0 控制字符 (保留换行符 \n, 回车符 \r, 制表符 \t)
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        
        // 清理 C1 控制字符
        .replace(/[\x80-\x9f]/g, '');
}

/**
 * 清理数据分片导致的 ANSI 序列残留片段
 *
 * 当 PTY 数据被分片时，\x1b 可能在一个数据块的末尾，
 * 而 [4;1m 在下一个数据块的开头，导致正则无法匹配完整序列。
 * 拼接后会出现类似 "[4;1m", "[0m", "[1;32m" 这样的残留片段。
 *
 * @param {string} str - 原始字符串
 * @returns {string} - 清理后的字符串
 */
function stripOrphanedAnsiFragments(str) {
    if (!str || typeof str !== 'string') return str || '';
    
    return str
        // 清理孤立的 CSI 参数片段: [数字;数字m 或 [数字m 等
        // 这些是 \x1b 被分片后残留的部分
        .replace(/\[[\d;]*[A-Za-z]/g, (match, offset, string) => {
            // 检查前一个字符是否是 \x1b，如果是则保留（让其他正则处理）
            // 如果不是，说明是孤立片段，需要删除
            if (offset > 0 && string[offset - 1] === '\x1b') {
                return match; // 保留，让其他正则处理
            }
            // 检查是否是行首或前面是空白/换行，这种情况下可能是孤立片段
            if (offset === 0 || /[\s\n\r]/.test(string[offset - 1])) {
                return ''; // 删除孤立片段
            }
            return match; // 其他情况保留（可能是正常文本如 "[test]"）
        })
        
        // 清理孤立的 OSC 片段: ]数字; 开头的
        .replace(/\][\d;]+[^\x07\x1b]*(?:\x07|\x1b\\)?/g, (match, offset, string) => {
            if (offset > 0 && string[offset - 1] === '\x1b') {
                return match;
            }
            if (offset === 0 || /[\s\n\r]/.test(string[offset - 1])) {
                return '';
            }
            return match;
        })
        
        // 清理末尾可能残留的不完整 ESC 序列
        .replace(/\x1b$/g, '')
        
        // 清理开头可能残留的 CSI 参数（没有 ESC 前缀）
        .replace(/^[\d;]*[mKJHABCDEFGsu]/g, '');
}

/**
 * 清理 fish shell 特有的 shell integration 标记
 * 这些标记用于终端的命令追踪功能，但在文本输出中应该被移除
 *
 * @param {string} str - 原始字符串
 * @returns {string} - 清理后的字符串
 */
function stripFishIntegration(str) {
    if (!str || typeof str !== 'string') return str || '';
    
    // Fish shell integration 使用 OSC 133 序列
    // 格式: \x1b]133;X\x07 或 \x1b]133;X;...\x07
    // X 可以是: A (提示符开始), B (命令开始), C (命令结束), D (命令完成)
    return str
        .replace(/\x1b\]133;[ABCD][^\x07]*\x07/g, '')
        // 也处理使用 ST (\x1b\\) 作为终止符的情况
        .replace(/\x1b\]133;[ABCD][^\x1b]*\x1b\\/g, '')
        // 清理分片后的残留: ]133;A 等
        .replace(/\]133;[ABCD][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
}

/**
 * 清理 fish shell 的警告信息
 * fish 在某些终端环境下会输出关于 shell integration 功能不可用的警告
 *
 * @param {string} str - 原始字符串
 * @returns {string} - 清理后的字符串
 */
function stripFishWarnings(str) {
    if (!str || typeof str !== 'string') return str || '';
    
    return str
        // 清理 fish 的 shell integration 警告
        // 例如: "warning: fish could not read response to shell integration query. Some optional features may not work."
        .replace(/warning:\s*fish could not read response.*?optional features[^\n]*\.?/gis, '')
        // 清理其他常见的 fish 警告信息
        .replace(/warning:\s*Unable to read the terminal.*?\n/gi, '')
        // 清理 fish 的 "Welcome to fish" 消息（如果不需要）
        // .replace(/Welcome to fish,.*?\n/gi, '')
        // 清理警告后可能残留的空行
        .replace(/^\s*\n/gm, '');
}

/**
 * 清理逐字符回显模式
 * fish shell 在某些情况下会逐字符回显输入，导致每个字符单独一行
 * 这种模式表现为连续的单字符行
 *
 * @param {string} str - 原始字符串
 * @returns {string} - 清理后的字符串
 */
function stripCharacterEcho(str) {
    if (!str || typeof str !== 'string') return str || '';
    
    // 检测并移除逐字符回显模式
    // 模式特征：连续5个或更多的单字符行
    // 改进正则：匹配行首可选空白 + 单个非空白字符 + 行尾可选空白 + 换行
    // 且支持跨行匹配
    const charEchoRegex = /(?:^[ \t]*\S[ \t]*\r?\n){5,}/gm;
    
    let cleaned = str.replace(charEchoRegex, '');
    
    // 处理另一种常见情况：字符之间夹杂着 ANSI 残留片段（如 4;1m）
    // 如果一行只包含残留的 ANSI 字符或单个字符，也应视为回显
    const complexEchoRegex = /(?:^[ \t]*(?:\d+;\d+m|\S)[ \t]*\r?\n){5,}/gm;
    
    return cleaned.replace(complexEchoRegex, '');
}

/**
 * 完整的输出清理函数
 * 组合所有清理步骤，返回干净的文本输出
 *
 * @param {string} str - 原始终端输出
 * @returns {string} - 清理后的纯文本
 */
/**
 * 从 xterm-headless Buffer 中提取纯文本
 * @param {Terminal} term - xterm-headless 实例
 * @returns {string} - 清理后的纯文本
 */
function getCleanTextFromBuffer(term) {
    if (!term) return '';
    const buffer = term.buffer.active;
    const lines = [];
    
    // 遍历 buffer 提取文本
    for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) {
            lines.push(line.translateToString(true).trimEnd());
        }
    }
    
    // 过滤掉末尾的空行，但保留中间的空行
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].length > 0) {
            lastNonEmpty = i;
            break;
        }
    }
    
    const result = lastNonEmpty === -1 ? '' : lines.slice(0, lastNonEmpty + 1).join('\n');
    
    // 进一步清理提示符、警告和边界标记
    return stripFishWarnings(result)
        .replace(/__VCP_BOUNDARY_[a-f0-9]+__/g, '')
        // 过滤常见的提示符模式 (针对 Fish/Zsh/Bash)
        .replace(/^.*?[➜❯❯❯❯].*?\n/gm, '')
        .trim();
}

function cleanOutput(str) {
    if (!str || typeof str !== 'string') return str || '';
    
    // 降级方案：如果无法使用 xterm-headless，则使用正则
    // 但在新的架构中，我们应该尽量通过 Terminal 实例来处理
    const tempTerm = new Terminal({ cols: 120, rows: 100 });
    tempTerm.write(str);
    return getCleanTextFromBuffer(tempTerm);
}

// --- 模块级状态 ---
let ptyProcess = null;
const childProcesses = new Set();
let isExecutingCommand = false;
let executionQueue = Promise.resolve();
let executionQueueLength = 0;
const MAX_EXECUTION_QUEUE_LENGTH = 50;

// --- 配置加载 ---
const defaultConfig = {
    returnMode: 'delta',
    shellPriority: ['fish', 'zsh', 'bash'],
    forbiddenCommands: [],
    authRequiredCommands: [],
    commandTimeout: 60000
};

try {
    const configPath = path.join(__dirname, 'config.env');
    if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const returnModeMatch = configContent.match(/^SHELL_RETURN_MODE\s*=\s*(delta|full)/m);
        if (returnModeMatch) defaultConfig.returnMode = returnModeMatch[1];

        const priorityMatch = configContent.match(/^SHELL_PRIORITY\s*=\s*(.*)/m);
        if (priorityMatch && priorityMatch[1]) {
            defaultConfig.shellPriority = priorityMatch[1].split(',').map(s => s.trim()).filter(s => s);
        }

        const forbiddenMatch = configContent.match(/^FORBIDDEN_COMMANDS\s*=\s*(.*)/m);
        if (forbiddenMatch && forbiddenMatch[1]) {
            defaultConfig.forbiddenCommands = forbiddenMatch[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c);
        }

        const authMatch = configContent.match(/^AUTH_REQUIRED_COMMANDS\s*=\s*(.*)/m);
        if (authMatch && authMatch[1]) {
            defaultConfig.authRequiredCommands = authMatch[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c);
        }

        const timeoutMatch = configContent.match(/^COMMAND_TIMEOUT\s*=\s*(\d+)/m);
        if (timeoutMatch) defaultConfig.commandTimeout = parseInt(timeoutMatch[1], 10);
    }
} catch (error) {
    console.error('[PTYShellExecutor] Error reading config.env:', error);
}

// --- Shell 检测 ---
function detectShell(preferredShell) {
    const shellPaths = {
        fish: ['/usr/bin/fish', '/bin/fish', '/usr/local/bin/fish'],
        zsh: ['/usr/bin/zsh', '/bin/zsh', '/usr/local/bin/zsh'],
        bash: ['/usr/bin/bash', '/bin/bash', '/usr/local/bin/bash']
    };

    // 如果指定了 shell，优先使用
    if (preferredShell && shellPaths[preferredShell]) {
        for (const p of shellPaths[preferredShell]) {
            if (fs.existsSync(p)) return p;
        }
    }

    // 按优先级检测
    for (const shellName of defaultConfig.shellPriority) {
        if (shellPaths[shellName]) {
            for (const p of shellPaths[shellName]) {
                if (fs.existsSync(p)) return p;
            }
        }
    }

    // 回退到环境变量或默认 bash
    return process.env.SHELL || '/bin/bash';
}

// --- 安全检查 ---
function securityCheck(command) {
    const normalizedCommand = command.trim().toLowerCase();
    
    for (const forbidden of defaultConfig.forbiddenCommands) {
        if (normalizedCommand.includes(forbidden)) {
            return { blocked: true, reason: `命令包含被禁止的关键字: ${forbidden}` };
        }
    }

    for (const authRequired of defaultConfig.authRequiredCommands) {
        if (normalizedCommand.includes(authRequired)) {
            return { blocked: false, needsConfirm: true, keyword: authRequired };
        }
    }

    return { blocked: false, needsConfirm: false };
}

// --- 创建 PTY 会话 ---
function createNewPtySession(preferredShell) {
    if (ptyProcess) {
        childProcesses.delete(ptyProcess);
        ptyProcess.kill();
        if (guiWindow && !guiWindow.isDestroyed()) {
            guiWindow.webContents.send('shell-clear');
        }
    }

    const shell = detectShell(preferredShell);
    const shellName = path.basename(shell);
    
    // 使用登录 shell 模式以加载配置文件
    const args = shellName === 'bash' ? ['--login'] : (shellName === 'zsh' ? ['--login'] : []);

    console.log(`[PTYShellExecutor] Starting shell: ${shell} with args: ${args.join(' ')}`);

    ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cwd: process.env.HOME || '/home',
        env: {
            ...process.env,
            TERM: 'xterm-256color',
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8'
        }
    });
    childProcesses.add(ptyProcess);

    // 数据监听 - 转发到 GUI
    ptyProcess.onData((data) => {
        if (isExecutingCommand) return;
        if (guiWindow && !guiWindow.isDestroyed()) {
            guiWindow.webContents.send('shell-data', data);
        }
    });

    ptyProcess.onExit(() => {
        childProcesses.delete(ptyProcess);
        ptyProcess = null;
        isExecutingCommand = false;
        if (guiWindow && !guiWindow.isDestroyed()) {
            guiWindow.webContents.send('pty-status', { connected: false });
        }
    });

    return shellName;
}

// --- 执行单条命令 ---
function executeSingleCommand(ptyProcess, singleCommand) {
    return new Promise((resolve, reject) => {
        if (!ptyProcess) {
            return reject(new Error("PTY process is not available."));
        }

        const term = new Terminal({
            cols: 120,
            rows: 100,
            allowProposedApi: true
        });
        const boundary = `__VCP_BOUNDARY_${crypto.randomUUID().replace(/-/g, '')}__`;
        
        let currentOutputSize = 0;
        const maxOutput = 1024 * 1024; // 同步执行限制 1MB

        const dataListener = (data) => {
            const dataStr = data.toString('utf-8');
            
            // 限制同步输出大小，防止 OOM
            if (currentOutputSize < maxOutput) {
                const remaining = maxOutput - currentOutputSize;
                const toWrite = data.length > remaining ? data.slice(0, remaining) : data;
                term.write(toWrite);
                currentOutputSize += toWrite.length;
            }
                
            // [Piko Fix 2026-02-08] 边界检测修复
            // 根因：@xterm/headless 6.0.0 中 term.write('', callback) 写入空字符串时
            // 回调可能永远不触发，导致 resolve() 永远不被调用 → 60s 超时
            if (dataStr.includes(boundary)) {
                // 快速路径：当前数据包直接包含完整边界标记
                setTimeout(() => {
                    cleanup();
                    resolve(getCleanTextFromBuffer(term));
                }, 50);
            } else if (dataStr.includes('__VCP_BOUNDARY_') || dataStr.includes('__VCP_')) {
                // 慢速路径：检测到部分边界（数据分片），延迟扫描 buffer
                setTimeout(() => {
                    const buffer = term.buffer.active;
                    for (let i = buffer.length - 1; i >= Math.max(0, buffer.length - 30); i--) {
                        const line = buffer.getLine(i);
                        if (line && line.translateToString(true).includes(boundary)) {
                            cleanup();
                            resolve(getCleanTextFromBuffer(term));
                            return;
                        }
                    }
                }, 50);
            }

            // 转发原始数据到 GUI
            if (guiWindow && !guiWindow.isDestroyed()) {
                guiWindow.webContents.send('shell-data', dataStr);
            }
        };

        const cleanup = () => {
            clearTimeout(timeoutId);
            ptyProcess.removeListener('data', dataListener);
            if (term) term.dispose();
        };

        const timeoutId = setTimeout(() => {
            cleanup();
            const err = new Error(`Command timed out after ${defaultConfig.commandTimeout / 1000} seconds.`);
            reporter.capture('syncCommandTimeout', err, { singleCommand });
            reject(err);
        }, defaultConfig.commandTimeout);

        ptyProcess.on('data', dataListener);
        
        // 发送指令
        ptyProcess.write('\x03');
        setTimeout(() => {
            ptyProcess.write(`${singleCommand}\necho "${boundary}"\n`);
        }, 100);
    });
}

// --- 主入口 ---
async function processToolCall(args) {
    // 获取 action 参数，默认为 'execute'（同步执行）
    const action = (args.action || 'execute').toLowerCase();
    
    console.log(`[PTYShellExecutor] Action: ${action}`);
    
    // 根据 action 分发处理
    switch (action) {
        case 'async':
        case 'async_execute':
            return handleAsyncExecute(args);
            
        case 'query':
        case 'eventlog':
            return handleQuery(args);
            
        case 'cancel':
            return handleCancel(args);
            
        case 'list':
            return handleList(args);
            
        case 'execute':
        default:
            return handleSyncExecute(args);
    }
}

/**
 * 处理异步执行请求
 * @param {object} args - 参数
 * @returns {object} - { taskId, status, message }
 */
function handleAsyncExecute(args) {
    const command = args.command;
    if (!command) {
        throw new Error('异步执行需要提供 command 参数');
    }
    
    // 安全检查
    const check = securityCheck(command);
    if (check.blocked) {
        throw new Error(`执行被阻止：${check.reason}`);
    }
    
    // 启动异步任务
    const result = asyncTaskManager.startTask(command, {
        shell: args.shell,
        cwd: args.cwd
    });
    
    return result;
}

/**
 * 处理任务查询请求
 * @param {object} args - 参数
 * @returns {object} - 任务信息
 */
function handleQuery(args) {
    const taskId = args.taskId;
    if (!taskId) {
        throw new Error('查询任务需要提供 taskId 参数');
    }
    
    return asyncTaskManager.queryTask(taskId);
}

/**
 * 处理任务取消请求
 * @param {object} args - 参数
 * @returns {object} - 操作结果
 */
function handleCancel(args) {
    const taskId = args.taskId;
    
    if (!taskId) {
        throw new Error('取消任务需要提供 taskId 参数');
    }
    
    return asyncTaskManager.cancelTask(taskId);
}

/**
 * 处理任务列表请求
 * @param {object} args - 参数
 * @returns {object} - 任务列表
 */
function handleList(args) {
    const tasks = asyncTaskManager.listTasks();
    return {
        count: tasks.length,
        tasks: tasks
    };
}

/**
 * 处理同步执行请求（原有逻辑）
 * @param {object} args - 参数
 * @returns {string} - 命令输出
 */
async function handleSyncExecute(args) {
    // 将执行逻辑封装，以便放入队列
    const task = async () => {
        // 解析命令参数
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
            throw new Error('未提供任何有效的 command 参数。');
        }

        // 安全检查
        for (const entry of commandEntries) {
            const check = securityCheck(entry.value);
            if (check.blocked) {
                throw new Error(`执行被阻止：${check.reason}`);
            }
            if (check.needsConfirm) {
                console.log(`[PTYShellExecutor] 命令包含敏感关键字 "${check.keyword}"，但继续执行。`);
            }
        }

        // 获取参数
        const preferredShell = args.shell || null;
        const newSession = args.newSession === true || args.newSession === 'true';
        const returnMode = args.returnMode || defaultConfig.returnMode;

        // 确保 GUI 窗口存在
        ensureGuiWindow();

        // 创建或复用会话
        if (newSession || !ptyProcess) {
            const shellName = createNewPtySession(preferredShell);
            await new Promise(resolve => setTimeout(resolve, 800)); // 等待 shell 初始化
            console.log(`[PTYShellExecutor] Session started with ${shellName}`);
        }

        // 执行命令
        const outputs = [];
        isExecutingCommand = true;
        
        try {
            for (const entry of commandEntries) {
                const output = await executeSingleCommand(ptyProcess, entry.value);
                outputs.push({ command: entry.value, output });
            }
        } finally {
            isExecutingCommand = false;
        }

        // 格式化返回
        if (outputs.length === 1) {
            return outputs[0].output;
        }
        return outputs.map(res => `---[${res.command}]---\n${res.output}`).join('\n\n');
    };

    // 队列长度限制与拒绝策略
    if (executionQueueLength >= MAX_EXECUTION_QUEUE_LENGTH) {
        throw new Error(`同步执行队列已满 (${MAX_EXECUTION_QUEUE_LENGTH})，请稍后再试或使用 action: "async" 模式。`);
    }

    executionQueueLength++;

    // 将任务加入全局执行队列，确保指令按顺序发送，避免粘连
    const resultPromise = executionQueue.then(async () => {
        try {
            return await task();
        } finally {
            executionQueueLength--;
        }
    }, async (err) => {
        try {
            console.error('[PTYShellExecutor] Previous queue task failed, continuing...', err);
            return await task();
        } finally {
            executionQueueLength--;
        }
    });

    // 更新全局队列引用
    executionQueue = resultPromise.then(
        () => {},
        () => {}
    );

    return await resultPromise;
}

// --- 清理 ---
function cleanup() {
    console.log('[PTYShellExecutor] Cleaning up...');

    // 清理异步任务管理器
    asyncTaskManager.cleanup();

    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.removeAllListeners('closed');
        guiWindow.close();
        guiWindow = null;
    }

    for (const proc of childProcesses) {
        try { proc.kill(); } catch (e) { /* ignore */ }
    }
    childProcesses.clear();

    if (settingsWatcher) {
        settingsWatcher.close();
        settingsWatcher = null;
    }

    ptyProcess = null;
}

module.exports = { processToolCall, cleanup };
