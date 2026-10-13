/*
 * AI 命令运行记录 (PTYShellExecutor).
 * 侧栏「命令输出」标签读取这里：每条 AI 命令一条记录（命令、状态、输出、原子回执），
 * 该模块无加载副作用，执行器和读取方共享同一缓存实例。
 */
"use strict";

const COMMAND_RUN_LIMIT = 50;
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
        outputSource: run.outputSource,
        receipt: run.receipt,
    };
}

function emitCommandRunChanged(run) {
    const summary = summarizeCommandRun(run);
    for (const listener of commandRunListeners) {
        try {
            listener(summary);
        } catch (e) {
            console.error("[PTYShellExecutor] Command run listener failed:", e);
        }
    }
}

function beginCommandRun(command, { outputSource = "capture" } = {}) {
    commandRunSequence += 1;
    const run = {
        id: `run-${Date.now().toString(36)}-${commandRunSequence}`,
        command: String(command),
        status: "running",
        startedAt: Date.now(),
        endedAt: null,
        raw: "",
        rawTruncated: false,
        outputSource,
        receipt: null,
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

function finishCommandRun(run, status, receipt = null) {
    if (!["running", "running_detached", "cancelling"].includes(run.status)) return;
    run.status = status;
    run.receipt = receipt;
    run.rawTruncated = Boolean(run.rawTruncated || receipt?.truncated);
    run.endedAt = ["running_detached", "cancelling"].includes(status) ? null : Date.now();
    emitCommandRunChanged(run);
}

function listCommandRuns() {
    return commandRuns.map(summarizeCommandRun).reverse();
}

const cleanedOutput = new WeakMap();

function cleanRunOutput(run) {
    const cached = cleanedOutput.get(run);
    if (cached && cached.raw === run.raw) return cached.clean;
    // capture 日志本身就是纯净文本，标准化换行即可
    let clean = run.raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    cleanedOutput.set(run, { raw: run.raw, clean });
    return clean;
}

function getCommandRun(id, { maxChars = COMMAND_RUN_READ_LIMIT } = {}) {
    const run = commandRuns.find(item => item.id === id);
    if (!run) return null;
    const limit = Math.max(1, Math.min(COMMAND_RUN_READ_LIMIT, Math.floor(Number(maxChars)) || COMMAND_RUN_READ_LIMIT));
    const clean = cleanRunOutput(run);
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
    COMMAND_RUN_RAW_LIMIT,
    beginCommandRun,
    appendCommandRunOutput,
    finishCommandRun,
    listCommandRuns,
    getCommandRun,
    subscribeCommandRuns,
};
