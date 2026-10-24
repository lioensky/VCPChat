'use strict';

// 桌宠的唯一入口（主进程）。由 modules/appFeatures.js 按 feature.json 加载，调用这里的 register(host)；
// 自定义协议 vcp-deskpet:// 也在 feature.json 里声明，由加载器在 app ready 之前登记。
// 桌宠需要核心配合的地方全部经 host.hooks（modules/hostHooks.js）挂上去，不反向 require 核心模块。
// 删掉整个 modules/deskpet 目录，核心照常运行。

const handlers = require('./petHandlers');
const voice = require('./petVoice');

/**
 * app ready、主窗口建好以后调用一次。
 *
 * @param {object} host
 * @param {ReturnType<import('../hostHooks').createHostHooks>} host.hooks 核心的挂钩点
 * @param {{ startSpeech: Function, appendSpeech: Function, stopSpeechFrom: Function }} host.tts 共用的朗读（modules/ipc/sovitsHandlers.js）
 * @param {Electron.BrowserWindow} host.mainWindow
 * @param {string} host.projectRoot
 * @param {string} host.appDataRoot
 * @param {string} host.agentDir
 * @param {() => Promise<object>} [host.readSettings] 闲时搭话读服务器设置
 * @param {() => object} [host.historyQueue] 写「桌宠闲聊」话题时与其他写入串行
 * @param {() => object} [host.agentOps] 建话题用的助手操作服务
 * @returns {{ dispose(): Promise<void> }} 退出时 await dispose()：摘掉挂钩、关掉桌宠、写完设置
 */
function register(host) {
    const { hooks, ...options } = host;
    handlers.initialize(options);

    const offs = [
        hooks.on('chat:request-messages', (messages, context) => handlers.appendProtocolToMessages(messages, context?.agentId)),
        hooks.on('chat:request-start', handlers.onRequestStart),
        hooks.on('chat:stream-payload', handlers.onStreamPayload),
        hooks.on('chat:full-response', handlers.onFullResponse),
        hooks.on('tools:result', handlers.onDistributedToolResult),
        hooks.on('agent:removed', handlers.forgetAgent),
        hooks.on('tts:speak', voice.allowSpeech),
        hooks.on('tray:menu-items', handlers.trayMenuItems),
        hooks.on('tray:update-menu', handlers.applyTrayState),
    ];
    handlers.setTrayRefresher((structureChanged) => hooks.emit('tray:refresh', structureChanged));

    let disposed = null;
    return {
        dispose() {
            disposed ??= (async () => {
                for (const off of offs) off();
                handlers.setTrayRefresher(null);
                await handlers.closeAll();
            })();
            return disposed;
        },
    };
}

module.exports = { register };
