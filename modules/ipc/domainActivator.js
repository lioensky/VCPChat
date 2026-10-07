// modules/ipc/domainActivator.js
// 主进程领域按需激活：启动时只为每个通道登记一个转发 handler，
// 某个领域的通道第一次被调用时才 require 它的 handler 模块并 initialize，然后把这次调用转过去。
//   - 领域状态：declared（只登记了通道）→ loading → active | failed；failed 的下一次调用会重试；
//   - 模块的 initialize 拿到的是本领域专用的 ipcMain（只认本领域的通道），注册的 handler 存在这里，
//     对外的 ipcMain.handle 始终是同一个转发函数，不需要来回替换；
//   - eager 的领域登记时就激活（例如浏览器的安全围栏必须在任何 <webview> 出现之前就位），
//     这样诊断里所有领域的样子是一致的；
//   - 退出时只释放已经激活过的领域，不会为了 dispose 把没用过的模块加载进来。
'use strict';

const STATES = Object.freeze(['declared', 'loading', 'active', 'failed']);

/**
 * 从 preload 清单里取某个领域的 invoke 通道。
 * 订阅类（main → 渲染端推送）不需要 handler；send 类目前这几个领域都没有，出现了就直接报错，免得漏注册。
 * @param {Array<{ domain: string, kind: string, channel: string }>} apis describeApis() 的结果
 * @param {string} domain
 */
function channelsForDomain(apis, domain) {
    const own = apis.filter((api) => api.domain === domain && api.kind !== 'subscription');
    const unsupported = own.filter((api) => api.kind !== 'query');
    if (unsupported.length) {
        throw new Error(`[DomainActivator] ${domain}: 只支持 invoke 通道，${unsupported.map((api) => api.channel).join(', ')} 需要单独处理`);
    }
    return [...new Set(own.map((api) => api.channel))];
}

/**
 * @param {{ ipcMain: { handle: Function, removeHandler: Function }, logger?: Console }} options
 */
function createDomainActivator({ ipcMain, logger = console } = {}) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('[DomainActivator] ipcMain is required.');
    const domains = new Map();
    const owners = new Map(); // channel → domain
    // 退出时 disposeAll({ final: true }) 之后置位：will-quit 时窗口只是隐藏，渲染端的轮询和订阅还会调进来，
    // 不拦住的话会把刚释放的领域重新 initialize（起 watcher、子进程），而之后再也没人 dispose
    let shutDown = false;

    function unavailable(domain, error) {
        return { success: false, error: `${domain.name} 功能加载失败：${error?.message || String(error)}` };
    }

    function activate(name) {
        const domain = domains.get(name);
        if (!domain) throw new Error(`[DomainActivator] 未登记的领域：${name}`);
        if (shutDown) throw new Error(`${name} 正在退出，不再激活`);
        if (domain.state === 'active') return domain.module;
        if (domain.state === 'loading') throw new Error(`${name} 正在初始化，不能在初始化过程中调用自己的通道`);
        domain.state = 'loading';
        domain.error = null;
        domain.attempts += 1;
        const startedAt = Date.now();
        try {
            const mod = domain.load();
            domain.handlers.clear();
            domain.init(mod, { ipcMain: domain.registrar });
            domain.module = mod;
            domain.state = 'active';
            domain.activatedAt = Date.now();
            domain.activationMs = domain.activatedAt - startedAt;
            return mod;
        } catch (error) {
            domain.state = 'failed';
            domain.error = error?.message || String(error);
            domain.handlers.clear();
            logger?.error?.(`[DomainActivator] ${name} 激活失败:`, error);
            throw error;
        }
    }

    function dispatch(domain, channel, event, args) {
        if (shutDown) return { success: false, error: 'shutting-down' };
        if (domain.state !== 'active') {
            try {
                activate(domain.name);
            } catch (error) {
                return unavailable(domain, error);
            }
        }
        domain.calls += 1;
        const handler = domain.handlers.get(channel);
        if (!handler) return { success: false, error: `${domain.name} 没有实现 ${channel}` };
        return handler(event, ...args);
    }

    /**
     * @param {string} name
     * @param {object} spec
     * @param {string[]} spec.channels 本领域的 invoke 通道
     * @param {() => any} spec.load 返回 handler 模块（通常就是 require）
     * @param {(mod: any, ctx: { ipcMain: object }) => void} spec.init 用 ctx.ipcMain 注册 handler
     * @param {(mod: any) => void} [spec.dispose]
     * @param {boolean} [spec.eager=false]
     */
    function register(name, { channels, load, init, dispose = null, eager = false } = {}) {
        if (domains.has(name)) throw new Error(`[DomainActivator] 领域重复登记：${name}`);
        if (!Array.isArray(channels) || !channels.length) throw new TypeError(`[DomainActivator] ${name}: channels 不能为空`);
        if (typeof load !== 'function' || typeof init !== 'function') throw new TypeError(`[DomainActivator] ${name}: 需要 load 和 init`);
        for (const channel of channels) {
            if (owners.has(channel)) throw new Error(`[DomainActivator] 通道 ${channel} 已属于 ${owners.get(channel).name}`);
        }

        const domain = {
            name,
            channels: Object.freeze([...new Set(channels)]),
            load,
            init,
            dispose,
            state: 'declared',
            error: null,
            module: null,
            handlers: new Map(),
            calls: 0,
            attempts: 0,
            activatedAt: null,
            activationMs: null,
            registrar: null,
        };
        const owned = new Set(domain.channels);
        domain.registrar = Object.freeze({
            handle(channel, handler) {
                if (!owned.has(channel)) throw new Error(`[DomainActivator] ${name} 不能注册不属于自己的通道 ${channel}`);
                if (typeof handler !== 'function') throw new TypeError(`[DomainActivator] ${channel}: handler 必须是函数`);
                domain.handlers.set(channel, handler);
            },
            removeHandler(channel) {
                domain.handlers.delete(channel);
            },
        });
        domains.set(name, domain);

        for (const channel of domain.channels) {
            owners.set(channel, domain);
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, (event, ...args) => dispatch(domain, channel, event, args));
        }
        if (eager) activate(name);
        return domain.registrar;
    }

    function stateOf(name) {
        return domains.get(name)?.state || null;
    }

    function snapshot() {
        return [...domains.values()].map((domain) => Object.freeze({
            name: domain.name,
            state: domain.state,
            channels: domain.channels.length,
            calls: domain.calls,
            attempts: domain.attempts,
            activatedAt: domain.activatedAt,
            activationMs: domain.activationMs,
            error: domain.error,
        }));
    }

    /**
     * 释放已激活领域的资源，退回 declared；通道仍然登记着，之后再被调用会重新初始化。
     * final：应用退出，之后的调用一律返回 shutting-down，不再激活任何领域
     */
    function disposeAll({ final = false } = {}) {
        if (final) shutDown = true;
        for (const domain of domains.values()) {
            if (domain.state !== 'active') continue;
            try {
                domain.dispose?.(domain.module);
            } catch (error) {
                logger?.error?.(`[DomainActivator] ${domain.name} 释放失败:`, error);
            }
            domain.state = 'declared';
            domain.module = null;
            domain.handlers.clear();
        }
    }

    /** 连同通道一起撤掉（测试或整体重建时用） */
    function unregisterAll() {
        disposeAll();
        for (const channel of owners.keys()) ipcMain.removeHandler(channel);
        owners.clear();
        domains.clear();
    }

    return Object.freeze({ register, activate, stateOf, snapshot, disposeAll, unregisterAll });
}

module.exports = { createDomainActivator, channelsForDomain, STATES };
