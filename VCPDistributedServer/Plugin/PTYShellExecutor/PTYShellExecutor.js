/**
 * PTYShellExecutor.entry.js (引导层)
 * 负责极简加载、错误捕获与完整接口转发透传
 */
"use strict";

const PluginErrorReporter = require("./PluginErrorReporter");
const reporter = new PluginErrorReporter("PTYShellExecutor");
reporter.installProcessHooks();

let impl = null;
try {
    impl = require("./PTYShellExecutor.impl");
} catch (err) {
    reporter.capture("load", err, {
        hint: "主体逻辑加载失败，可能是原生依赖(node-pty)缺失或版本不匹配",
        requirePath: "./PTYShellExecutor.impl"
    });
}

async function processToolCall(args) {
    const isNewSession = args && (args.newSession === true || args.newSession === "true" || args.reload === true || args.reload === "true");
    if (isNewSession) {
        try {
            if (impl && typeof impl.cleanup === "function") {
                impl.cleanup();
            }
            delete require.cache[require.resolve("./commandCapture")];
            delete require.cache[require.resolve("./commandRunStore")];
            delete require.cache[require.resolve("./terminalKeyParser")];
            delete require.cache[require.resolve("./AdminConfirm")];
            delete require.cache[require.resolve("./PTYShellExecutor.impl")];
            impl = require("./PTYShellExecutor.impl");
} catch (reloadErr) {
            console.warn("[PTYShellExecutor] Hot reload on newSession failed:", reloadErr.message);
        }
    }
    if (!impl) {
        return {
            status: "error",
            message: "插件加载失败，请检查本地诊断报告。",
        };
    }
    if (typeof impl.processToolCall !== "function") {
        reporter.capture("exportCheck", new Error("Missing processToolCall function"), {
            exports: Object.keys(impl)
        });
        return {
            status: "error",
            message: "插件接口异常：缺失 processToolCall"
        };
    }
    try {
        return await impl.processToolCall(args);
    } catch (err) {
        reporter.capture("processToolCall", err, { args });
        throw err;
    }
}

function cleanup() {
    if (impl && typeof impl.cleanup === "function") {
        try {
            impl.cleanup();
        } catch (err) {
            reporter.capture("cleanup", err);
        }
    }
}

module.exports = {
    processToolCall,
    cleanup,
    // 代理透传所有 impl 的底层控制和侧栏镜像方法
    openGuiTerminal: (...args) => impl?.openGuiTerminal(...args),
    attachMirror: (...args) => impl?.attachMirror(...args),
    listCommandRuns: (...args) => impl?.listCommandRuns(...args),
    getCommandRun: (...args) => impl?.getCommandRun(...args),
    subscribeCommandRuns: (...args) => impl?.subscribeCommandRuns(...args),
    _runCommandForTest: (...args) => impl?._runCommandForTest(...args),
    ensureMirrorSession: (...args) => impl?.ensureMirrorSession(...args),
    restartSession: (...args) => impl?.restartSession(...args),
    getSessionState: (...args) => impl?.getSessionState(...args),
    writeSessionInput: (...args) => impl?.writeSessionInput(...args),
    clearSessionScreen: (...args) => impl?.clearSessionScreen(...args),
    resizeSession: (...args) => impl?.resizeSession(...args),
    parseInteractiveSequence: (...args) => impl?.parseInteractiveSequence(...args),
    parseWaitDuration: (...args) => impl?.parseWaitDuration(...args),
    parseTerminalKey: (...args) => impl?.parseTerminalKey(...args)
};
