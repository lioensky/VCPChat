/*
 * AI 命令运行记录。
 * 侧栏「命令输出」标签读取这里：每条 AI 短命令一条记录（命令、状态、输出），只保留最近若干条与有限输出。
 * 这个模块没有任何加载副作用（不碰 Electron、不注册 IPC、不读配置、不起监视器），
 * 主进程只想列出或读取记录时直接 require 它，不必为此加载整个 PowerShellExecutor。
 * 执行器和读取方拿到的是同一份模块实例（Node 的 require 缓存），记录天然共享。
 */
'use strict';

const { sanitizeTerminalOutput } = require('./terminalOutputSanitizer');

const COMMAND_RUN_LIMIT = 30;
const COMMAND_RUN_RAW_LIMIT = 512 * 1024;
const COMMAND_RUN_READ_LIMIT = 64 * 1024;
const commandRuns = [];
const commandRunListeners = new Set();
let commandRunSequence = 0;

function summarizeCommandRun(run) {
    return {
        id: run.id,
        command: run.command,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
    };
}

function emitCommandRunChanged(run) {
    const summary = summarizeCommandRun(run);
    for (const listener of commandRunListeners) {
        try {
            listener(summary);
        } catch (e) {
            console.error('[PowerShellExecutor] Command run listener failed:', e);
        }
    }
}

function beginCommandRun(command) {
    commandRunSequence += 1;
    const run = {
        id: `run-${Date.now().toString(36)}-${commandRunSequence}`,
        command: String(command),
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        raw: '',
        rawTruncated: false,
    };
    commandRuns.push(run);
    if (commandRuns.length > COMMAND_RUN_LIMIT) {
        commandRuns.splice(0, commandRuns.length - COMMAND_RUN_LIMIT);
    }
    emitCommandRunChanged(run);
    return run;
}

function appendCommandRunOutput(run, chunk) {
    if (!chunk) return;
    run.raw += chunk;
    if (run.raw.length > COMMAND_RUN_RAW_LIMIT) {
        run.raw = run.raw.slice(-COMMAND_RUN_RAW_LIMIT);
        run.rawTruncated = true;
    }
    emitCommandRunChanged(run);
}

function finishCommandRun(run, status) {
    if (run.status !== 'running') return;
    run.status = status;
    run.endedAt = Date.now();
    emitCommandRunChanged(run);
}

/** 最近的命令运行记录（新的在前），不含输出正文。 */
function listCommandRuns() {
    return commandRuns.map(summarizeCommandRun).reverse();
}

/** 读取一条记录，输出为清洗后的纯文本，只保留末尾 maxChars 个字符。 */
function getCommandRun(id, { maxChars = COMMAND_RUN_READ_LIMIT } = {}) {
    const run = commandRuns.find(item => item.id === id);
    if (!run) return null;
    const limit = Math.max(1, Math.min(COMMAND_RUN_READ_LIMIT, Math.floor(Number(maxChars)) || COMMAND_RUN_READ_LIMIT));
    // 起始标记那一行留下的换行不算输出
    const clean = sanitizeTerminalOutput(run.raw).replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/^\n/, '');
    const truncated = run.rawTruncated || clean.length > limit;
    return {
        ...summarizeCommandRun(run),
        output: truncated ? clean.slice(-limit) : clean,
        truncated,
    };
}

function subscribeCommandRuns(listener) {
    commandRunListeners.add(listener);
    return () => commandRunListeners.delete(listener);
}

module.exports = {
    // 执行器累计原始输出时沿用同一上限
    COMMAND_RUN_RAW_LIMIT,
    beginCommandRun,
    appendCommandRunOutput,
    finishCommandRun,
    listCommandRuns,
    getCommandRun,
    subscribeCommandRuns,
};
