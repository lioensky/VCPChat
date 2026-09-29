'use strict';

/**
 * preload API 条目的声明工具。
 *
 * preloads/api/*.js 只用这里导出的函数来描述 IPC，不直接接触 ipcRenderer。
 * core/expose.js 会按窗口角色把条目实例化成页面可调用的函数。
 *
 *   invoke(channel, ...argNames)   请求-响应，调用 ipcRenderer.invoke，返回 Promise
 *   send(channel, ...argNames)     单向命令，调用 ipcRenderer.send，没有返回值
 *   on(channel)                    订阅事件，回调形式为 callback(payload)，返回取消订阅函数
 *   onArgs(channel, ...argNames)   订阅事件，事件带多个参数，回调形式为 callback(a, b, ...)
 *   onSignal(channel)              订阅事件，事件不带数据，回调形式为 callback()
 *   custom(kind, channel, build)   以上都表达不了时使用，build(ctx) 返回最终函数
 *
 * argNames 只写参数名，它既是文档，也决定按位置转发多少个参数。
 * 需要默认值或要重组参数时，改传一个映射函数，返回值是发给主进程的参数数组：
 *   invoke('workspaces:add', (dirPath, alias = '') => [dirPath, alias])
 *
 * 链式修饰：
 *   .roles('chat', 'desktop')   本条目的可见角色与领域文件默认值不同时使用
 *   .mapResult(result => ...)    需要在返回给页面前加工主进程结果时使用
 */

const KINDS = Object.freeze(['query', 'command', 'subscription']);

class ApiEntry {
    constructor(kind, channel, build) {
        if (!KINDS.includes(kind)) {
            throw new TypeError(`未知的 preload 条目类型: ${kind}`);
        }
        this.kind = kind; // 'query' | 'command' | 'subscription'，决定隔离桩的形态
        this.channel = channel; // 主要 IPC 通道，仅作索引与文档
        this.build = build; // (ctx) => 暴露给页面的函数
        this.allowedRoles = null; // null 表示沿用领域文件的 roles
    }

    roles(...roleNames) {
        this.allowedRoles = roleNames;
        return this;
    }

    mapResult(transform) {
        const build = this.build;
        this.build = (ctx) => {
            const call = build(ctx);
            return async (...args) => transform(await call(...args));
        };
        return this;
    }
}

// 按位置转发固定数量的参数；缺失的位置补 undefined，与手写的 (a, b) => invoke(ch, a, b) 等价。
function toArgsMapper(argSpec) {
    if (argSpec.length === 1 && typeof argSpec[0] === 'function') {
        return argSpec[0];
    }
    const count = argSpec.length;
    return (...args) => Array.from({ length: count }, (_, index) => args[index]);
}

function invoke(channel, ...argSpec) {
    const toArgs = toArgsMapper(argSpec);
    return new ApiEntry('query', channel, ({ ipcRenderer }) =>
        (...args) => ipcRenderer.invoke(channel, ...toArgs(...args)));
}

function send(channel, ...argSpec) {
    const toArgs = toArgsMapper(argSpec);
    return new ApiEntry('command', channel, ({ ipcRenderer }) =>
        (...args) => {
            ipcRenderer.send(channel, ...toArgs(...args));
        });
}

function subscription(channel, pickArgs) {
    return new ApiEntry('subscription', channel, ({ ipcRenderer }) =>
        (callback) => {
            const listener = (_event, ...payload) => callback(...pickArgs(payload));
            ipcRenderer.on(channel, listener);
            return () => ipcRenderer.removeListener(channel, listener);
        });
}

function on(channel) {
    return subscription(channel, (payload) => [payload[0]]);
}

function onArgs(channel, ...argNames) {
    return subscription(channel, (payload) => argNames.map((_, index) => payload[index]));
}

// 与旧实现保持一致：回调收到一个 undefined 参数
function onSignal(channel) {
    return subscription(channel, () => [undefined]);
}

function custom(kind, channel, build) {
    return new ApiEntry(kind, channel, build);
}

module.exports = {
    ApiEntry,
    KINDS,
    invoke,
    send,
    on,
    onArgs,
    onSignal,
    custom,
};