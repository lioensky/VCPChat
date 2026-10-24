'use strict';

// 主进程扩展点。可选功能（modules/*/feature.json）在这里挂钩，核心代码只按钩子名调用，不 require 具体功能；
// 没有人挂钩时每个调用都是空操作。所有钩子都列在 HOOKS 里，名字或调用方式写错直接抛错。
//
// 调用方式：
//   emit       通知；返回值忽略
//   emitAsync  依次等待每个处理函数
//   pipe       依次改写第一个参数，返回最后的结果
//   every      所有处理函数都没返回 false 时为 true（没人挂钩也是 true）
//   collect    把每个处理函数返回的数组拼起来
// 处理函数出错只记日志、跳过它，不会打断调用方。

const HOOKS = Object.freeze({
    // 单聊请求（不含群聊）
    'chat:request-messages': 'pipe', // (messages, context) → messages，发出前追加系统提示等
    'chat:request-start': 'emit', // (messageId, context)
    'chat:stream-payload': 'emit', // (payload) 流式事件；用户中止时收尾为 { type: 'end', aborted: true }
    'chat:full-response': 'emit', // (messageId, context, response) 非流式回复
    // 分布式服务器上的工具调用成功了
    'tools:result': 'emit', // (toolName, toolArgs, result)
    // 删除助手目录之前
    'agent:removed': 'emitAsync', // (agentId)
    // 朗读请求；返回 false 就不念（例如这条已经有别的窗口在念）
    'tts:speak': 'every', // (sender, options)
    // 托盘菜单
    'tray:menu-items': 'collect', // () → MenuItemConstructorOptions[]，插在「退出」上面
    'tray:update-menu': 'every', // (menu) 就地改勾选/可用状态；返回 false 表示要重建菜单
    'tray:refresh': 'emit', // (structureChanged) 功能状态变了，请托盘刷新
});

function createHostHooks({ logger = console } = {}) {
    const handlers = new Map(Object.keys(HOOKS).map((name) => [name, []]));

    function listFor(name, kind) {
        const list = handlers.get(name);
        if (!list) throw new Error(`Unknown host hook: ${name}`);
        if (kind && HOOKS[name] !== kind) throw new Error(`Host hook ${name} is called with ${HOOKS[name]}, not ${kind}`);
        return list;
    }

    function safely(name, fn, args, fallback) {
        try {
            return fn(...args);
        } catch (error) {
            logger.warn(`[hostHooks] ${name} handler failed:`, error?.message || error);
            return fallback;
        }
    }

    function on(name, fn) {
        if (typeof fn !== 'function') throw new TypeError(`Host hook ${name} needs a function`);
        const list = listFor(name);
        list.push(fn);
        return () => {
            const index = list.indexOf(fn);
            if (index !== -1) list.splice(index, 1);
        };
    }

    return {
        on,
        emit(name, ...args) {
            for (const fn of [...listFor(name, 'emit')]) safely(name, fn, args);
        },
        async emitAsync(name, ...args) {
            for (const fn of [...listFor(name, 'emitAsync')]) {
                try {
                    await fn(...args);
                } catch (error) {
                    logger.warn(`[hostHooks] ${name} handler failed:`, error?.message || error);
                }
            }
        },
        pipe(name, value, ...args) {
            let current = value;
            for (const fn of [...listFor(name, 'pipe')]) {
                const next = safely(name, fn, [current, ...args], current);
                if (next !== undefined) current = next;
            }
            return current;
        },
        every(name, ...args) {
            let allowed = true;
            for (const fn of [...listFor(name, 'every')]) {
                if (safely(name, fn, args, true) === false) allowed = false;
            }
            return allowed;
        },
        collect(name, ...args) {
            const items = [];
            for (const fn of [...listFor(name, 'collect')]) {
                const result = safely(name, fn, args, []);
                if (Array.isArray(result)) items.push(...result);
            }
            return items;
        },
    };
}

module.exports = {
    HOOKS,
    createHostHooks,
    hostHooks: createHostHooks(),
};
