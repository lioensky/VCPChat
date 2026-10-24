// modules/deskpet/petContext.js
// 桌宠各模块共用的上下文：开着的桌宠、路径、主窗口、平台差异，以及推给主窗口和设置页的几句话。
// 各模块装好以后也挂在这里（见 petHandlers.js 的组装），互相调用都走 ctx，不留模块级全局。

const path = require('path');
const fs = require('fs-extra');
const { isAgentId } = require('./petAssets');
const { createSessionActivity } = require('./sessionActivity');

/**
 * 每次载入 petHandlers.js 建一份：所有可变状态都在这里，重新 require 就是干净的一份。
 *
 * @param {object} options
 * @param {typeof import('electron')} options.electron 测试里换成假的，所以只从这里取，不在各模块里 require
 * @param {object} options.voice petVoice：测试里会重新 require，所以也从这里取，各模块不在模块级抓一份
 */
function createPetContext({ electron, voice }) {
    const ctx = {
        electron,
        voice,
        // Windows：'pop-up-menu' 压住任务栏，又不像 'screen-saver' 那样和全屏程序抢；
        // macOS 需要 'screen-saver' 才能浮在全屏空间之上。
        platform: {
            TOPMOST_LEVEL: process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu',
            // X11 上整窗穿透后 Chromium 收不到指针，getCursorScreenPoint() 会停在旧坐标，
            // 光标轮询就再也发现不了宠物；Linux 改为把窗口输入区裁到内容包围盒。
            USE_SHAPE: process.platform === 'linux',
            // Windows 上别的置顶程序（任务管理器、置顶播放器、部分全屏切窗口）弹到前面后，
            // 桌宠会被压在下面且不会自己回来；低频补一次置顶层级（见 petWindow.js）。
            USE_TOPMOST_GUARD: process.platform === 'win32',
        },
        paths: null, // { projectRoot, appDataRoot, agentDir }
        assets: null, // modules/deskpet/petAssets.js：协议背后的文件、助手的形象清单
        stateStore: null, // modules/deskpet/petState.js：AppData/deskpet/state.json
        mainWindow: null,
        initialized: false,
        shuttingDown: false, // 退出时关窗口不算用户关掉，下次启动还要恢复
        lastTouched: null, // 最近一次被点、被叫出来的桌宠，「和桌宠说话」快捷键找它
        lastTalkedAgentId: null, // 最近一次发出请求的 agent，闹钟认不出是谁设的时交给它的桌宠
        controls: null, // modules/deskpet/petControls.js：全局设置、快捷键、设置页的开关和快捷键部分
        previews: null, // modules/deskpet/petPreviews.js：设置页卡片用的形象快照（离屏渲染）
        idle: null, // 闲时主动搭话（modules/deskpet/idleRunner.js）
        emotionPrompt: null, // modules/emotion/emotionPrompt.js（ESM，初始化时异步载入）
        services: {}, // { readSettings, historyQueue, agentOps }：main.js 传进来的聊天记录服务（取值函数）
        refreshTray: () => {},
        // agentId -> { win, scale, outfit, aspect, ignoringMouse, interactive, hitPoll, drag, lastShape }
        pets: new Map(),
        sessions: null, // 下面建；桌宠上那张会话卡片
        // 以下由 petHandlers.js 组装时填上，各模块之间只经这里互相调用
        geometry: null,
        windows: null,
        displays: null,
        motion: null,
        sizing: null,
        stream: null,
        bridge: null,
        proactive: null,
        menus: null,
        commands: null,

        readPetState: () => ctx.stateStore.read(),
        savePetState: (agentId, patch) => ctx.stateStore.save(agentId, patch),
        savePetPosition: (agentId, position) => ctx.savePetState(agentId, { x: position[0], y: position[1] }),
        listAgents: () => ctx.assets.listAgents(),
        listAgentOutfits: (agentId) => ctx.assets.listOutfits(agentId),
        resolveAssets: (agentId, wantedOutfit) => ctx.assets.resolveAssets(agentId, wantedOutfit),

        visibleAgents() {
            // 全屏时躲起来的也算开着：主窗口头部的开关不跟着跳
            return [...ctx.pets.entries()].filter(([, pet]) => !pet.win.isDestroyed() && (pet.win.isVisible() || pet.yielded)).map(([id]) => id);
        },

        notifyMain(agentId) {
            const { mainWindow } = ctx;
            if (mainWindow && !mainWindow.isDestroyed()) {
                const openAgents = ctx.visibleAgents();
                mainWindow.webContents.send('deskpet:state-changed', { agentId, open: openAgents.includes(agentId), openAgents });
            }
            ctx.controls?.refreshSettings();
        },

        // 设置页（主窗口全局设置 → 桌宠）收到的推送
        mainContents() {
            const { mainWindow } = ctx;
            return mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed?.() ? mainWindow.webContents : null;
        },

        // 只有主窗口能开关桌宠、回传发送结果和定位结果；别的渲染进程发来的一律忽略。
        fromMain(event) {
            return Boolean(ctx.mainWindow && !ctx.mainWindow.isDestroyed() && event.sender === ctx.mainWindow.webContents);
        },

        petFromEvent(event) {
            for (const pet of ctx.pets.values()) {
                if (!pet.win.isDestroyed() && pet.win.webContents === event.sender) return pet;
            }
            return null;
        },

        // 页面报上来的角色包围盒（窗口内坐标）；不是四个有限数就当没有
        figureFrom(report) {
            const f = report?.figure;
            return f && [f.x, f.y, f.width, f.height].every(Number.isFinite) ? { x: f.x, y: f.y, width: f.width, height: f.height } : null;
        },
    };

    ctx.settingsPush = {
        changed: (snapshot) => ctx.mainContents()?.send('deskpet-settings:changed', snapshot),
        preview: (payload) => ctx.mainContents()?.send('deskpet-settings:preview', payload),
        coreProgress: (payload) => ctx.mainContents()?.send('deskpet-settings:core-progress', payload),
    };

    ctx.sessions = createSessionActivity({
        async titleOf(agentId, topicId) {
            if (topicId === `voicechat_${agentId}`) return '语音聊天';
            if (!ctx.paths || !isAgentId(agentId)) return '';
            const config = await fs.readJson(path.join(ctx.paths.agentDir, agentId, 'config.json'));
            return config.topics?.find(topic => String(topic.id) === topicId)?.name || '';
        },
        publish(agentId, session) { ctx.stream?.forward(agentId, { type: 'session', session }); },
    });

    return ctx;
}

module.exports = { createPetContext };
