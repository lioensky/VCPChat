// PTYShellExecutor.impl.js - Linux / POSIX 桌面环境下的高性能持久化 Shell 执行器
// 完全对齐 VCPCLI 标准架构：持久化共享会话、commandCapture 日志分流、原子回执、
// commandUnresolved 状态锁、全套交互式 TUI 指令、视图解耦 (terminalTarget) 与侧栏联动。
"use strict";

const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const PluginErrorReporter = require("./PluginErrorReporter");
const reporter = new PluginErrorReporter("PTYShellExecutor");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { BrowserWindow, ipcMain, clipboard, nativeTheme } = require("electron");
const chokidar = require("chokidar");
const { createShellThemeBridge } = require("./ShellThemeBridge");

const {
    buildCaptureWrapper,
    parseCaptureReceipt
} = require("./commandCapture");

const {
    COMMAND_RUN_RAW_LIMIT,
    beginCommandRun,
    appendCommandRunOutput,
    finishCommandRun,
    listCommandRuns,
    getCommandRun,
    subscribeCommandRuns
} = require("./commandRunStore");

const {
    confirmAdminExecution,
    executeAdminCommand
} = require("./AdminConfirm");

const {
    INTERACTIVE_SEQUENCE_LIMITS,
    TERMINAL_KEY_SEQUENCES,
    delay,
    parseWaitDuration,
    parseTerminalKey,
    parseInteractiveSequence
} = require("./terminalKeyParser");

function withPagerDisabledEnv(baseEnv) {
    return {
        ...baseEnv,
        PAGER: "cat",
        LESS: "FRX",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
        SYSTEMD_PAGER: "cat",
        SYSTEMD_LESS: "FRX",
        SYSTEMD_PAGERSECURE: "1",
        MANPAGER: "cat",
        AWS_PAGER: "",
        BAT_PAGER: "cat",
        DELTA_PAGER: "cat"
    };
}

function killProcessGroup(pid, signal = "SIGTERM") {
    if (!pid || typeof pid !== "number") return;
    if (process.platform !== "win32") {
        try {
            process.kill(-pid, signal);
            return;
        } catch (_) {}
    }
    try { process.kill(pid, signal); } catch (_) {}
}

const defaultConfig = {
    shellReturnMode: "delta",
    shellPriority: ["bash", "zsh", "fish"],
    forbiddenCommands: ["rm -rf /", ":(){ :|:& };:"],
    authRequiredCommands: ["sudo", "pkexec", "chmod 777", "mkfs", "dd if="],
    commandTimeout: 60000,
    enableHeadlessMirror: true,
    historyLines: 1000
};

const configPath = path.join(__dirname, "config.env");
if (fs.existsSync(configPath)) {
    try {
        const envContent = fs.readFileSync(configPath, "utf8");
        for (const line of envContent.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const [k, ...vParts] = trimmed.split("=");
            const v = vParts.join("=").trim();
            if (k === "SHELL_RETURN_MODE") defaultConfig.shellReturnMode = v;
            if (k === "SHELL_PRIORITY") defaultConfig.shellPriority = v.split(",").map(s => s.trim());
            if (k === "FORBIDDEN_COMMANDS") defaultConfig.forbiddenCommands = v.split(",").map(s => s.trim()).filter(Boolean);
            if (k === "AUTH_REQUIRED_COMMANDS") defaultConfig.authRequiredCommands = v.split(",").map(s => s.trim()).filter(Boolean);
            if (k === "COMMAND_TIMEOUT") defaultConfig.commandTimeout = parseInt(v, 10) || 60000;
        }
    } catch (_) {}
}

let ptyProcess = null;
let headlessTerminal = null;
let guiWindow = null;
let isExecutingCommand = false;
let commandUnresolved = false;
let interactiveMode = false;
let queueProcessing = false;
const executionQueue = [];
let activeCommandAbort = null;
let pendingCommandCleanup = null;
let lastKnownSize = { cols: 80, rows: 24 };

const REPLAY_LIMIT = 256 * 1024;
let replayBuffer = "";

function appendReplay(data) {
    replayBuffer += data;
    if (replayBuffer.length > REPLAY_LIMIT) {
        replayBuffer = replayBuffer.slice(-REPLAY_LIMIT);
    }
}

function clearReplay() {
    replayBuffer = "";
}

const mirrors = new Set();

function attachMirror(sink) {
    mirrors.add(sink);
    if (replayBuffer && typeof sink.onData === "function") {
        try { sink.onData(replayBuffer); } catch (_) {}
    }
    return () => {
        mirrors.delete(sink);
    };
}

function notifyMirrors(method, ...args) {
    for (const sink of mirrors) {
        try {
            if (typeof sink[method] === "function") {
                sink[method](...args);
            }
        } catch (e) {
            console.error("[PTYShellExecutor] Mirror dispatch error:", e);
        }
    }
}

function dispatchPtyData(data) {
    appendReplay(data);
    if (headlessTerminal) {
        try { headlessTerminal.write(data); } catch (_) {}
    }
    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.webContents.send("shell-data", data);
    }
    notifyMirrors("onData", data);
}

function ensureHeadlessTerminal() {
    if (!headlessTerminal) {
        headlessTerminal = new Terminal({
            cols: lastKnownSize.cols,
            rows: lastKnownSize.rows,
            allowProposedApi: true
        });
    }
    return headlessTerminal;
}

function detectShell(preferredShell) {
    if (preferredShell) {
        try {
            const { spawnSync } = require("child_process");
            if (spawnSync("which", [preferredShell]).status === 0) return preferredShell;
        } catch (_) {}
    }
    for (const sh of defaultConfig.shellPriority) {
        try {
            const { spawnSync } = require("child_process");
            if (spawnSync("which", [sh]).status === 0) return sh;
        } catch (_) {}
    }
    return process.env.SHELL || "/bin/bash";
}

function createNewPtySession(preferredShell) {
    if (pendingCommandCleanup) pendingCommandCleanup();
    interactiveMode = false;
    isExecutingCommand = false;
    commandUnresolved = false;
    activeCommandAbort = null;

    if (ptyProcess) {
        try { killProcessGroup(ptyProcess.pid); } catch (_) {}
        try { ptyProcess.kill(); } catch (_) {}
        ptyProcess = null;
    }
    clearReplay();
    ensureHeadlessTerminal();
    headlessTerminal.reset();
    notifyMirrors("onClear");

    const shell = detectShell(preferredShell);
    const args = path.basename(shell) === "bash" ? ["--login"] : [];

    ptyProcess = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: lastKnownSize.cols,
        rows: lastKnownSize.rows,
        cwd: process.env.HOME || "/home",
        env: withPagerDisabledEnv({
            ...process.env,
            TERM: "xterm-256color",
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8"
        })
    });

    ptyProcess.onData(data => {
        dispatchPtyData(data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
        notifyMirrors("onExit", exitCode, signal);
        ptyProcess = null;
    });

    return ptyProcess;
}

function ensureMirrorSession(preferredShell) {
    if (!ptyProcess) {
        createNewPtySession(preferredShell);
    }
    return ptyProcess;
}

function restartSession(preferredShell) {
    return createNewPtySession(preferredShell);
}

function getSessionState() {
    return {
        running: Boolean(ptyProcess),
        pid: ptyProcess ? ptyProcess.pid : null,
        busy: Boolean(isExecutingCommand || commandUnresolved || interactiveMode || executionQueue.length > 0),
        unresolved: commandUnresolved,
        queuedTasks: executionQueue.length,
        cols: lastKnownSize.cols,
        rows: lastKnownSize.rows,
        interactiveMode
    };
}

function writeSessionInput(data) {
    if (!ptyProcess) return false;
    ptyProcess.write(data);
    return true;
}

function clearSessionScreen() {
    if (!ptyProcess || isExecutingCommand || commandUnresolved || interactiveMode) return false;
    ptyProcess.write("\x0c");
    return true;
}

function applyPtyResize(cols, rows) {
    const validCols = Math.max(10, Math.min(500, parseInt(cols, 10) || 80));
    const validRows = Math.max(5, Math.min(200, parseInt(rows, 10) || 24));
    lastKnownSize = { cols: validCols, rows: validRows };
    if (ptyProcess) {
        try { ptyProcess.resize(validCols, validRows); } catch (_) {}
    }
    if (headlessTerminal) {
        try { headlessTerminal.resize(validCols, validRows); } catch (_) {}
    }
}

const applicationRoot = path.join(__dirname, "..", "..", "..");
const shellThemeBridge = createShellThemeBridge({
    chokidar,
    nativeTheme,
    settingsPaths: [
        path.join(applicationRoot, "AppData", "settings.json"),
        path.join(applicationRoot, "settings.json")
    ],
    themeStylesheetPath: path.join(applicationRoot, "styles", "themes.css"),
    getTarget: () => (guiWindow && !guiWindow.isDestroyed() ? guiWindow.webContents : null)
}).start();

if (ipcMain) {
    ipcMain.on("shell-gui-ready", (event) => {
        if (!guiWindow || guiWindow.isDestroyed() || guiWindow.webContents !== event.sender) return;
        shellThemeBridge.sendSnapshot(event.sender);
        if (ptyProcess) {
            event.sender.send("pty-status", { connected: true });
        }
    });

    ipcMain.on("shell-input", (event, data) => {
        if (!guiWindow || guiWindow.isDestroyed() || guiWindow.webContents !== event.sender) return;
        if (ptyProcess && typeof data === "string" && data) {
            ptyProcess.write(data);
        }
    });

    ipcMain.on("shell-command", (event, command) => {
        if (!guiWindow || guiWindow.isDestroyed() || guiWindow.webContents !== event.sender) return;
        if (ptyProcess && typeof command === "string" && command) {
            ptyProcess.write(command + "\n");
        }
    });

    ipcMain.on("shell-resize", (event, payload = {}) => {
        if (!guiWindow || guiWindow.isDestroyed() || guiWindow.webContents !== event.sender) return;
        const { cols, rows } = payload || {};
        applyPtyResize(cols, rows);
    });

    ipcMain.on("copy-to-clipboard", (event, text) => {
        if (!guiWindow || guiWindow.isDestroyed() || guiWindow.webContents !== event.sender) return;
        if (text && clipboard) clipboard.writeText(text);
    });

    ipcMain.on("minimize-window", (event) => {
        if (guiWindow && !guiWindow.isDestroyed() && guiWindow.webContents === event.sender) {
            guiWindow.minimize();
        }
    });

    ipcMain.on("maximize-window", (event) => {
        if (guiWindow && !guiWindow.isDestroyed() && guiWindow.webContents === event.sender) {
            guiWindow.isMaximized() ? guiWindow.unmaximize() : guiWindow.maximize();
        }
    });

    ipcMain.on("close-window", (event) => {
        if (guiWindow && !guiWindow.isDestroyed() && guiWindow.webContents === event.sender) {
            guiWindow.close();
        }
    });
}

function ensureGuiWindow() {
    if (!BrowserWindow) return null;
    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.focus();
        return guiWindow;
    }
    guiWindow = new BrowserWindow({
        width: 900,
        height: 600,
        title: "VCP PTY Shell Executor",
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, "gui", "preload.js"),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: true
    });

    guiWindow.loadFile(path.join(__dirname, "gui", "ShellViewer.html"));
    guiWindow.webContents.on("did-finish-load", () => {
        if (replayBuffer) {
            guiWindow.webContents.send("shell-data", replayBuffer);
        }
        shellThemeBridge.sendSnapshot(guiWindow.webContents);
    });

    guiWindow.on("closed", () => {
        guiWindow = null;
    });

    return guiWindow;
}

function openGuiTerminal() {
    return ensureGuiWindow();
}

function requestSidebar(action, params = {}) {
    try {
        return require('../../../modules/ipc/terminalHandlers').requestTerminalView(action, params);
    } catch (e) {
        return Promise.reject(e);
    }
}

function terminalTarget(args = {}) {
    const target = String(args.terminalTarget || "sidebar").trim().toLowerCase();
    return target === "window" ? "window" : "sidebar";
}

async function prepareTerminalView(target, required = false) {
    if (target === "window") {
        ensureGuiWindow();
    } else {
        const opening = requestSidebar("open");
        if (required) await opening;
        else opening.catch(error => console.warn("[PTYShellExecutor] Sidebar unavailable:", error.message));
    }
}

async function queryVisibleLines(maxLines = 200) {
    ensureHeadlessTerminal();
    const buffer = headlessTerminal.buffer.active;
    const lines = [];
    const limit = Math.min(maxLines, buffer.length);
    for (let i = buffer.length - limit; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n").trim();
}

function executeSingleCommandInPty(targetPty, singleCommand) {
    return new Promise((resolve, reject) => {
        if (!targetPty) return reject(new Error("PTY 会话进程不可用。"));

        const run = beginCommandRun(singleCommand, { outputSource: "capture" });
        const runId = crypto.randomUUID();
        const prefix = path.join(os.tmpdir(), "vcp-pty-" + runId);
        const scriptPath = prefix + ".sh";
        const wrapperPath = prefix + "-wrapper.sh";
        const outputPath = prefix + ".log";
        const receiptPath = prefix + ".json";

        let timer = null;
        let timeout = null;
        let closed = false;
        let callerSettled = false;
        let output = "";

        const updateOutput = () => {
            if (!fs.existsSync(outputPath)) return;
            try {
                const next = fs.readFileSync(outputPath, "utf8");
                if (next.length > output.length) {
                    appendCommandRunOutput(run, next.slice(output.length));
                    output = next;
                }
            } catch (_) {}
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
            for (const file of [scriptPath, wrapperPath, outputPath, receiptPath, receiptPath + ".pending"]) {
                try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
            }
        };

        const abandon = () => {
            if (closed) return;
            finishCommandRun(run, "cancelled");
            release();
            if (!callerSettled) {
                callerSettled = true;
                reject(new Error("Shell 会话已退出或重置，执行未收到完成回执。"));
            }
        };

        const abort = () => {
            if (closed) return false;
            targetPty.write("\x03");
            commandUnresolved = true;
            finishCommandRun(run, "cancelling");
            if (!callerSettled) {
                callerSettled = true;
                clearTimeout(timeout);
                reject(new Error("已向 Shell 会话投递 Ctrl+C 中断请求；会话保持未决状态直至收尾回执。"));
            }
            return true;
        };

        pendingCommandCleanup = abandon;
        activeCommandAbort = abort;
let captureParser = parseCaptureReceipt;

        const poll = () => {
            if (closed) return;
            try {
                updateOutput();
                if (!fs.existsSync(receiptPath)) return;
                const receipt = captureParser(fs.readFileSync(receiptPath, "utf8"), runId);
                updateOutput();
                output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
                run.raw = output;
                const state = run.status === "cancelling" ? "cancelled" : "completed";
                finishCommandRun(run, state, receipt);
                release();
                if (!callerSettled) {
                    callerSettled = true;
                    const isCleanSuccess = state === "completed"
                        && (receipt.nativeExitCode === 0 || receipt.nativeExitCode === null || receipt.nativeExitCode === undefined)
                        && !receipt.terminatingError
                        && !receipt.truncated
                        && (!receipt.errorCount || receipt.errorCount === 0);

                    if (isCleanSuccess) {
                        resolve(output);
                    } else {
                        const integrity = receipt.truncated ? "truncated" : "complete";
                        resolve("[execution=" + state + "; output=" + integrity + "; errors=" + receipt.errorCount + "; terminatingError=" + receipt.terminatingError + "; nativeExit=" + (receipt.nativeExitCode ?? "n/a") + "; durationMs=" + receipt.durationMs + "]\\n"
                            + (receipt.truncated ? "[输出超过容量限制，仅保留开头内容]\\n" : "")
                            + output);
                    }
                }
            } catch (error) {
                commandUnresolved = true;
                clearTimeout(timeout);
                if (!callerSettled) {
                    callerSettled = true;
                    reject(new Error("底层回执解析异常，会话按未决锁定处理: " + error.message));
                }
            }
};

        try {
            try {
                delete require.cache[require.resolve('./commandCapture')];
            } catch (_) {}
            const captureModule = require('./commandCapture');
            const captureBuilder = captureModule.buildCaptureWrapper || buildCaptureWrapper;
captureParser = captureModule.parseCaptureReceipt || parseCaptureReceipt;
            fs.writeFileSync(scriptPath, singleCommand, "utf8");
            fs.writeFileSync(wrapperPath, captureBuilder({
                scriptPath,
                outputPath,
                receiptPath,
                runId,
                execPath: process.execPath
            }), "utf8");
            fs.chmodSync(wrapperPath, 0o755);
            timer = setInterval(poll, 100);
            timeout = setTimeout(() => {
                if (closed || callerSettled) return;
                callerSettled = true;
                commandUnresolved = true;
                finishCommandRun(run, "running_detached");
                purgeExecutionQueue("前置命令超时仍占用终端，后续排队任务已安全取消。");
                reject(new Error("命令超过 60 秒同步等待，仍在前台 Shell 持续执行中。执行锁保留以防踩踏；可使用 QueryVisible 巡视、InterruptPowerShell 发送中断或 newSession:true 重建会话。"));
            }, defaultConfig.commandTimeout);

            targetPty.write("source '" + wrapperPath.replace(/'/g, "'\\''") + "'\r");
        } catch (error) {
            finishCommandRun(run, "spawn_error");
            release();
            callerSettled = true;
            reject(error);
        }
    });
}

function purgeExecutionQueue(reason) {
    const cancelled = executionQueue.splice(0, executionQueue.length);
    for (const item of cancelled) {
        if (typeof item.reject === "function") {
            item.reject(new Error(reason));
        }
    }
    return cancelled;
}

async function processQueueLoop() {
    if (queueProcessing || isExecutingCommand || commandUnresolved) return;
    if (executionQueue.length === 0) return;

    queueProcessing = true;
    while (executionQueue.length > 0) {
        if (commandUnresolved) break;
        const task = executionQueue.shift();
        try {
            if (task.newSession || !ptyProcess) {
                createNewPtySession();
            }
            isExecutingCommand = true;
            const res = await executeSingleCommandInPty(ptyProcess, task.command);
            task.resolve(res);
        } catch (e) {
            task.reject(e);
        } finally {
            isExecutingCommand = false;
        }
    }
    queueProcessing = false;
}

async function ensureInteractiveTerminal(newSession = false, target = "sidebar") {
    if (isExecutingCommand || queueProcessing || executionQueue.length > 0 || (commandUnresolved && !newSession)) {
        throw new Error("共享终端正被未决或同步任务占用，无法进入交互模式。");
    }
    await prepareTerminalView(target, true);
    if (newSession || !ptyProcess) {
        createNewPtySession();
    }
    interactiveMode = true;
    return ptyProcess;
}

async function processToolCall(rawArgs = {}) {
    const args = rawArgs || {};
    const commandName = (args.command || args.action || "").trim().toLowerCase();

    if (commandName === "interruptpowershell" || commandName === "interruptcommand" || commandName === "interruptshell" ||
        (args.action === "cancel" && !args.taskId)) {
        const interruptedCurrent = Boolean(activeCommandAbort && activeCommandAbort());
        const cancelledQueue = purgeExecutionQueue("命令队列被全局中断取消。");
        const cancelledText = cancelledQueue.length > 0
            ? "\n\n🛡️ 已同步取消排队的 " + cancelledQueue.length + " 个任务。"
            : "";
        const msg = interruptedCurrent
            ? "🛑 [中断请求已投递] 已向活动 Shell 会话发送 Ctrl+C；等待底层回执确认收尾。"
            : "ℹ️ 当前无正在等待的同步命令。";
        return { content: [{ type: "text", text: msg + cancelledText }] };
    }

    if (commandName === "endinteractive" || args.action === "endinteractive") {
        interactiveMode = false;
        return { content: [{ type: "text", text: "✅ 交互模式已解除，Shell 提示符已复位。" }] };
    }

    if (commandName === "queryvisible" || args.action === "queryvisible") {
        const maxLines = Math.max(10, Math.min(2000, parseInt(args.maxLines, 10) || 200));
        const text = await queryVisibleLines(maxLines);
        return { content: [{ type: "text", text: text || "(终端屏幕当前无可见文本)" }] };
    }

    if (commandName === "sendinteractivekey" || args.action === "sendinteractivekey") {
        if (!args.key) throw new Error("SendInteractiveKey 缺少 key 参数。");
        const keySpec = parseTerminalKey(args.key);
        const ptyProc = await ensureInteractiveTerminal(args.newSession === true, terminalTarget(args));
        ptyProc.write(keySpec.data);
        return { content: [{ type: "text", text: "已发送按键 " + keySpec.keyName + " (" + keySpec.repeat + " 次)" }] };
    }

    if (commandName === "pasteinteractivetext" || args.action === "pasteinteractivetext") {
        if (typeof args.text !== "string") throw new Error("PasteInteractiveText 缺少 text 参数。");
        const ptyProc = await ensureInteractiveTerminal(args.newSession === true, terminalTarget(args));
        ptyProc.write("\x1b[200~" + args.text + "\x1b[201~");
        if (args.submit === true) {
            ptyProc.write("\r");
        }
        return { content: [{ type: "text", text: "已粘贴 " + args.text.length + " 个字符" + (args.submit ? " 并发送回车" : "") + "。" }] };
    }

    if (commandName === "runinteractivesequence" || args.action === "runinteractivesequence") {
        const steps = parseInteractiveSequence(args);
        const ptyProc = await ensureInteractiveTerminal(args.newSession === true, terminalTarget(args));
        const receipts = [];

        for (const step of steps) {
            if (step.type === "command") {
                ptyProc.write(step.value + "\r");
                receipts.push("[Step " + step.index + "] 执行命令: " + step.value);
            } else if (step.type === "wait") {
                const ms = parseWaitDuration(step.value);
                await delay(ms);
                receipts.push("[Step " + step.index + "] 等待 " + ms + "ms");
            } else if (step.type === "key") {
                const keySpec = parseTerminalKey(step.value);
                ptyProc.write(keySpec.data);
                receipts.push("[Step " + step.index + "] 按键: " + keySpec.keyName);
            } else if (step.type === "paste") {
                ptyProc.write("\x1b[200~" + step.value + "\x1b[201~");
                receipts.push("[Step " + step.index + "] 粘贴 " + String(step.value).length + " 字符");
            } else if (step.type === "queryVisible") {
                const visible = await queryVisibleLines(parseInt(step.value, 10) || 200);
                receipts.push("[Step " + step.index + "] 可见屏幕:\n" + visible);
            }
        }
        return { content: [{ type: "text", text: receipts.join("\n") }] };
    }

    if (commandName === "startinteractive" || args.action === "startinteractive") {
        const cmd = args.powershell || args.command;
        if (!cmd) throw new Error("StartInteractive 缺少 command 参数。");
        const ptyProc = await ensureInteractiveTerminal(args.newSession === true, terminalTarget(args));
        ptyProc.write(cmd + "\r");
        return { content: [{ type: "text", text: "交互程序已启动：" + cmd + "，已在终端中接管。" }] };
    }

    if (args.action === "async") {
        return {
            content: [{
                type: "text",
                text: "提示：异步任务推荐直接使用常规命令执行。若为长时间运行任务，建议在命令末尾添加 & 后台运行或使用 nohup。"
            }]
        };
    }

    let singleCommand = args.powershell || args.script || "";
    if (!singleCommand) {
        if (commandName !== "executecommand" && commandName !== "executepowershell") {
            singleCommand = args.command || "";
        }
    }
    if (!singleCommand) {
        throw new Error("缺少要执行的命令参数 (command、powershell 或 script)。");
    }

    if (args.requireAdmin === true) {
        const out = await executeAdminCommand(singleCommand);
        return { content: [{ type: "text", text: out }] };
    }

    for (const forbidden of defaultConfig.forbiddenCommands) {
        if (singleCommand.includes(forbidden)) {
            throw new Error("命令被安全策略拒绝：包含禁止的高危模式 \"" + forbidden + "\"。");
        }
    }

    if (commandUnresolved) {
        if (!args.newSession) {
            throw new Error("共享 Shell 终端仍有未决任务在运行；请等待其回执，或传入 newSession:true 强制重建会话。");
        }
        createNewPtySession();
    }

    if (interactiveMode && !args.newSession) {
        throw new Error("当前终端正处于交互式 TUI 占用模式；请先调用 EndInteractive 或使用 newSession:true 重置。");
    }

    await prepareTerminalView(terminalTarget(args), false);

    return new Promise((resolve, reject) => {
        executionQueue.push({
            command: singleCommand,
            newSession: args.newSession === true,
            resolve: output => resolve({ content: [{ type: "text", text: output }] }),
            reject
        });
        processQueueLoop();
    });
}

function cleanup() {
    if (pendingCommandCleanup) pendingCommandCleanup();
    if (ptyProcess) {
        try { killProcessGroup(ptyProcess.pid); } catch (_) {}
        try { ptyProcess.kill(); } catch (_) {}
        ptyProcess = null;
    }
    if (guiWindow && !guiWindow.isDestroyed()) {
        guiWindow.destroy();
        guiWindow = null;
    }
    try {
        shellThemeBridge.dispose();
    } catch (_) {}
}

module.exports = {
    processToolCall,
    openGuiTerminal,
    attachMirror,
    listCommandRuns,
    getCommandRun,
    subscribeCommandRuns,
    _runCommandForTest: command => executeSingleCommandInPty(ptyProcess || createNewPtySession(), command),
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