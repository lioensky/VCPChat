// modules/deskpet/petHandlers.js
// 桌宠（可选模块，默认关闭）：每个 agent 一个透明、无边框、置顶的小窗，
// 显示该 agent 的 Live2D 模型或差分立绘。可以在桌宠上直接和这个 agent 说话（经主窗口发送，
// 历史照常保存），回复以气泡显示，表情由页面里的情绪导演（modules/emotion）按回复流决定。
//
// 这里只做装配和主进程的生命周期：建共用上下文（petContext.js）、把各块装上、
// 注册自定义协议和 IPC、启动时恢复上次的桌宠、退出时收摊。具体的活分在：
//   petWindow.js 开关窗口和崩溃恢复　petGeometry.js 位置和大小的算法　petDisplays.js 显示器变化与全屏让位
//   petMotion.js 拖、甩、贴边、溜达　petSizing.js 缩放换装和页面偏好　petMenus.js 右键和托盘菜单
//   petStream.js 回复流接入　petMainBridge.js 和主窗口之间的来回　petProactive.js 主动搭话、闹钟、工具审批
//   petCommands.js 快捷键和设置页触发的动作　petIpc.js 全部 ipcMain 注册
//
// Nova 的三套模型来自应用 assets/deskpet/nova/；自定义模型仍来自用户数据目录：
//   AppData/deskpet/live2dcubismcore.min.js     Cubism Core（必须是 5.x；设置页一键下载或用户自行放入），没有就用随应用附带的 vendor/live2d-cubism-core/
//   AppData/Agents/<id>/deskpet/<套装>/           一套形象（换装）：Live2D、网格立绘或差分立绘，见 modules/deskpet/outfits.js
//   AppData/Agents/<id>/deskpet/*.model3.json    直接放在 deskpet/ 下的算「默认」那套（以前的单模型布局照旧能用）
//   AppData/Agents/<id>/portrait.<情绪>.<ext>    差分立绘：「立绘」那套，也是 Live2D 用不了时的后备
//   AppData/Agents/<id>/portrait.<ext>           默认立绘；再没有就用头像

const electron = require('electron');
const { BrowserWindow, protocol, net, screen } = electron;
const path = require('path');
const { pathToFileURL } = require('url');
const voice = require('./petVoice');
const petPrefs = require('./petPrefs');
const { createPetAssets, isAgentId, SCHEME } = require('./petAssets');
const { createPetStateStore } = require('./petState');
const petTray = require('./petTray');
const { createIdleRunner } = require('./idleRunner');
const { createPetControls } = require('./petControls');
const { createPetPreviews } = require('./petPreviews');
const { createSettingsPage } = require('./settingsPage');
const { createCoreInstaller } = require('./cubismCore');
const idleChat = require('./idleChat');
const { createPetContext } = require('./petContext');
const { createPetGeometry } = require('./petGeometry');
const { createPetWindow } = require('./petWindow');
const { createPetDisplays } = require('./petDisplays');
const { createPetMotion } = require('./petMotion');
const { createPetSizing, PAGE_PREF_KEYS, TRAY_KEYS } = require('./petSizing');
const { createPetStream } = require('./petStream');
const { createPetMainBridge } = require('./petMainBridge');
const { createPetProactive } = require('./petProactive');
const { createPetMenus } = require('./petMenus');
const { createPetCommands } = require('./petCommands');
const { registerIpc } = require('./petIpc');

// 启动时恢复上次的桌宠：等主窗口载完再开，不和首屏抢。
const RESTORE_DELAY_MS = 1500;

// 共用的状态和各块：重新 require 这个文件就是干净的一份（测试每个用例都重来一遍）。
// 各块之间互相调用都经 ctx，装的顺序不用管谁先谁后。
const ctx = createPetContext({ electron, voice });
ctx.geometry = createPetGeometry(ctx);
ctx.windows = createPetWindow(ctx);
ctx.displays = createPetDisplays(ctx);
ctx.motion = createPetMotion(ctx);
ctx.sizing = createPetSizing(ctx);
ctx.stream = createPetStream(ctx);
ctx.bridge = createPetMainBridge(ctx);
ctx.proactive = createPetProactive(ctx);
ctx.menus = createPetMenus(ctx);
ctx.commands = createPetCommands(ctx);

let coreInstaller = null; // modules/deskpet/cubismCore.js：设置页里装 Cubism Core
let restoreTimer = null;
let disposeHostEvents = () => {};

function registerProtocol() {
    protocol.handle(SCHEME, async (request) => {
        const file = await ctx.assets.resolveLocalFile(request.url);
        if (!file) return new Response('not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
    });
}

// 在隐藏的沙箱窗口里加载暂存的 Cubism Core，读出版本号（页面写进标题）；加载不了是 0。
const CORE_PROBE_TIMEOUT_MS = 15000;
function probeCore() {
    return new Promise((resolve) => {
        const win = new BrowserWindow({
            width: 64,
            height: 64,
            show: false,
            skipTaskbar: true,
            focusable: false,
            webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
        });
        let settled = false;
        const finish = (version) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!win.isDestroyed()) win.destroy();
            resolve(version);
        };
        const timer = setTimeout(() => finish(0), CORE_PROBE_TIMEOUT_MS);
        win.webContents.on('page-title-updated', (_event, title) => {
            const match = /^core-version:(\d+)$/.exec(title);
            if (match) finish(Number(match[1]));
        });
        win.webContents.on('render-process-gone', () => finish(0));
        win.on('closed', () => finish(0));
        win.loadURL(ctx.assets.appUrl(`core-probe.html?n=${Date.now()}`)).catch(() => finish(0));
    });
}

// 人在不在：多久没碰键盘鼠标了（秒），以及锁屏了没
function systemAway() {
    try {
        const idleSec = electron.powerMonitor?.getSystemIdleTime?.() ?? 0;
        const lockState = electron.powerMonitor?.getSystemIdleState?.(idleChat.AWAY_AFTER_SEC);
        return { idleSec, locked: lockState === 'locked' };
    } catch {
        return { idleSec: 0, locked: false };
    }
}

function initialize(options) {
    if (ctx.initialized) return;
    ctx.initialized = true;
    ctx.mainWindow = options.mainWindow || null;
    ctx.paths = {
        projectRoot: options.projectRoot,
        appDataRoot: options.appDataRoot,
        agentDir: options.agentDir,
    };
    const { paths } = ctx;
    ctx.assets = createPetAssets({ paths, stagedCorePath: () => coreInstaller?.stagedPath });
    ctx.stateStore = createPetStateStore({ file: path.join(paths.appDataRoot, 'deskpet', 'state.json') });
    ctx.services = {
        readSettings: typeof options.readSettings === 'function' ? options.readSettings : null,
        historyQueue: typeof options.historyQueue === 'function' ? options.historyQueue : null,
        agentOps: typeof options.agentOps === 'function' ? options.agentOps : null,
    };
    ctx.idle = createIdleRunner({
        settings: () => ctx.controls?.get() || petPrefs.DEFAULT_SETTINGS,
        services: ctx.services,
        candidates: ctx.commands.idleCandidates,
        isShowing: (agentId) => {
            const pet = ctx.pets.get(agentId);
            return Boolean(pet && !pet.win.isDestroyed() && pet.win.isVisible());
        },
        systemAway,
        mainWhere: ctx.bridge.mainWhere,
        promptAppend: ctx.stream.getSystemPromptAppend,
        speak: ctx.proactive.proactive,
        isShuttingDown: () => ctx.shuttingDown,
    });
    registerProtocol();
    registerIpc(ctx);
    voice.initialize({ paths, findPet: (event) => ctx.petFromEvent(event), tts: options.tts });
    ctx.controls = createPetControls({
        electron,
        appDataRoot: paths.appDataRoot,
        actions: {
            toggleAll: () => ctx.commands.toggleAllPets().catch((error) => console.warn('[DeskPet] toggle failed:', error.message)),
            talk: () => ctx.commands.talkToPet().catch((error) => console.warn('[DeskPet] talk failed:', error.message)),
            voice: () => ctx.commands.talkToPet({ voice: true }).catch((error) => console.warn('[DeskPet] voice failed:', error.message)),
            listPets: ctx.commands.listPetsForSettings,
            setScale: (agentId, scale) => ctx.sizing.setPetScale(agentId, scale),
            sendToSettings: ctx.settingsPush.changed,
            openSettingsPage: ctx.bridge.openSettingsPage,
            isSettingsSender: (sender) => Boolean(sender && ctx.mainWindow && !ctx.mainWindow.isDestroyed() && sender === ctx.mainWindow.webContents),
        },
    });
    const controls = ctx.controls;
    controls.registerIpc();
    ctx.previews = createPetPreviews({
        BrowserWindow,
        cacheRoot: path.join(paths.appDataRoot, 'deskpet', 'previews'),
        preload: path.join(paths.projectRoot, 'DeskPetmodules', 'preload.js'),
        pageUrl: (agentId) => ctx.assets.pageUrl(agentId, '&preview=1'),
        // 卡片快照按 2 倍画：比桌面上默认的大，缩进卡片里也清楚
        windowSize: (aspect, kind) => petPrefs.windowSizeForScale(2, aspect, kind),
    });
    coreInstaller = createCoreInstaller({ appDataRoot: paths.appDataRoot, projectRoot: paths.projectRoot, fetch: (url, init) => net.fetch(url, init), probe: probeCore });
    createSettingsPage({
        electron,
        paths,
        controls,
        previews: ctx.previews,
        core: {
            status: () => coreInstaller.status(),
            installOfficial: () => coreInstaller.installOfficial(ctx.settingsPush.coreProgress),
            installFromFile: (file) => coreInstaller.installFromFile(file),
            afterInstall: ctx.windows.reloadLive2DPets,
        },
        pets: {
            listAgents: ctx.listAgents,
            listOutfits: ctx.listAgentOutfits,
            readState: async (agentId) => (await ctx.readPetState())[agentId] || null,
            saveState: ctx.savePetState,
            isAgentId,
            info: (agentId) => ctx.commands.listPetsForSettings().find((p) => p.agentId === agentId) || null,
            openAgents: () => ctx.visibleAgents(),
            lastTouched: () => ctx.lastTouched,
            openPet: ctx.windows.openPet,
            closePet: (agentId) => { ctx.windows.closePet(agentId); ctx.refreshTray(); },
            showPet: (agentId) => { const pet = ctx.pets.get(agentId); if (pet && !pet.win.isDestroyed()) { ctx.windows.showPet(pet); ctx.notifyMain(agentId); } },
            setOutfit: ctx.sizing.setPetOutfit,
            pushProfile: (agentId, payload) => {
                const pet = ctx.pets.get(agentId);
                if (!pet || pet.win.isDestroyed() || !pet.ready) return false;
                pet.win.webContents.send('deskpet:profile', payload);
                if (payload?.emotion || payload?.tap) ctx.windows.showPet(pet);
                return true;
            },
            setVisible: ctx.commands.setPetsVisible,
            talk: ctx.commands.talkFromSettings,
            mainWindow: () => (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null),
            sendPreview: ctx.settingsPush.preview,
        },
    }).registerIpc();
    ctx.displays.initFullscreenWatch();
    controls.onChange((_settings, changed) => {
        if (changed.some((key) => PAGE_PREF_KEYS.includes(key))) ctx.sizing.broadcastPrefs();
        if (changed.includes('hideFromCapture')) for (const pet of ctx.pets.values()) ctx.windows.applyCaptureHiding(pet.win);
        if (changed.includes('wander') && controls.get().wander !== true) for (const pet of ctx.pets.values()) ctx.motion.stopWalk(pet);
        if (changed.includes('clickThrough')) for (const pet of ctx.pets.values()) ctx.windows.applyClickThrough(pet);
        if (changed.includes('yieldToFullscreen')) ctx.displays.updateFullscreenWatch();
        if (changed.includes('idleChat')) ctx.idle.update();
        if (changed.some((key) => TRAY_KEYS.includes(key))) ctx.refreshTray();
    });
    const settingsReady = controls.load().then(() => {
        if (ctx.shuttingDown) return;
        controls.applyShortcuts();
        ctx.refreshTray();
        ctx.idle.update();
    });
    // 主窗口载完以后再恢复上次的桌宠
    const scheduleRestore = () => settingsReady.then(() => {
        if (!ctx.shuttingDown) restoreTimer = setTimeout(ctx.windows.restoreOpenPets, RESTORE_DELAY_MS);
    });
    const mainContents = ctx.mainWindow?.webContents;
    if (mainContents?.isLoading?.() === false && mainContents.getURL?.()) scheduleRestore();
    else mainContents?.once?.('did-finish-load', scheduleRestore);
    const hostEvents = [];
    const listenHost = (target, event, fn) => {
        target?.on?.(event, fn);
        hostEvents.push(() => target?.removeListener?.(event, fn));
    };
    disposeHostEvents = () => { for (const dispose of hostEvents.splice(0)) dispose(); };
    hostEvents.push(() => mainContents?.removeListener?.('did-finish-load', scheduleRestore));
    // 主窗口刷新时设置页没了：录快捷键录到一半暂停的全局快捷键要恢复
    listenHost(mainContents, 'did-start-loading', () => ctx.controls?.pauseShortcuts(false));
    listenHost(screen, 'display-removed', ctx.displays.onDisplaysChanged);
    listenHost(screen, 'display-added', ctx.displays.onDisplaysChanged);
    listenHost(screen, 'display-metrics-changed', ctx.displays.onDisplaysChanged);
    // 睡眠唤醒、解锁以后：笔记本可能拔了扩展坞、换了分辨率，置顶也可能被系统取消。和显示器变了一样重新摆一遍
    listenHost(electron.powerMonitor, 'resume', ctx.displays.onDisplaysChanged);
    listenHost(electron.powerMonitor, 'unlock-screen', ctx.displays.onDisplaysChanged);
    import(pathToFileURL(path.join(paths.projectRoot, 'modules', 'emotion', 'emotionPrompt.js')).href)
        .then((mod) => { ctx.emotionPrompt = mod; })
        .catch((error) => console.warn('[DeskPet] emotion prompt unavailable:', error.message));
    // 主窗口关掉时桌宠跟着关，否则剩下的透明窗口会让应用无法退出。
    listenHost(ctx.mainWindow, 'closed', closeAll);
    // 退出时（macOS 上 Cmd+Q 会先关桌宠窗口、后关主窗口）桌宠被一起关掉不算用户关的，恢复列表照旧
    listenHost(electron.app, 'before-quit', () => { ctx.shuttingDown = true; });
}

function closeAll() {
    // 退出（或主窗口关掉）时一起关：恢复列表保持原样，下次启动照旧打开
    ctx.shuttingDown = true;
    disposeHostEvents();
    clearTimeout(restoreTimer);
    ctx.sessions.clear();
    ctx.bridge.settleAllPending();
    ctx.proactive.clear();
    for (const agentId of [...ctx.pets.keys()]) ctx.windows.closePet(agentId);
    ctx.displays.stop();
    const settingsSaved = ctx.controls?.dispose();
    ctx.previews?.dispose();
    ctx.idle?.stop();
    // 退出流程要等这次写盘：去抖窗口里改的设置不能丢
    return Promise.resolve(settingsSaved);
}

// chatHandlers 在主聊天的发送和流式路径上调用这些钩子；桌宠出任何错都不能打断主聊天。
function isolated(name, fn, fallback) {
    return (...args) => {
        try {
            return fn(...args);
        } catch (error) {
            console.warn(`[DeskPet] ${name} failed:`, error?.message || error);
            return typeof fallback === 'function' ? fallback(...args) : fallback;
        }
    };
}

module.exports = {
    initialize,
    closeAll,
    // 托盘：建菜单时取「桌宠」这一项，并在桌宠状态变了时请托盘刷新（经 index.js 挂到 hostHooks）
    trayMenuItems: isolated('trayMenuItems', ctx.menus.trayMenuItems, []),
    // 只是勾选、可用、显示变了：改现有菜单（见 modules/deskpet/petTray.js）
    applyTrayState: isolated('applyTrayState', (menu) => petTray.applyTrayState(menu, ctx.menus.trayMenuItems()), false),
    setTrayRefresher: (fn) => { ctx.refreshTray = typeof fn === 'function' ? isolated('refreshTray', petTray.refreshWhenChanged(ctx.menus.trayMenuItems, fn)) : () => {}; },
    getSystemPromptAppend: isolated('getSystemPromptAppend', ctx.stream.getSystemPromptAppend, ''),
    appendProtocolToMessages: isolated('appendProtocolToMessages', ctx.stream.appendProtocolToMessages, (messages) => messages),
    onRequestStart: isolated('onRequestStart', ctx.stream.onRequestStart),
    onStreamPayload: isolated('onStreamPayload', ctx.stream.onStreamPayload),
    onFullResponse: isolated('onFullResponse', ctx.stream.onFullResponse),
    onDistributedToolResult: isolated('onDistributedToolResult', ctx.proactive.onDistributedToolResult),
    forgetAgent: (agentId) => Promise.resolve(ctx.windows.forgetAgent(agentId)).catch((error) => console.warn('[DeskPet] forget agent failed:', error.message)),
    // 测试用
    _promptReady: () => Boolean(ctx.emotionPrompt),
    _applyFullscreen: ctx.displays.applyFullscreen,
    _idleTick: (options) => ctx.idle.tick(options),
    _idleState: () => ctx.idle.states,
    _controls: () => ctx.controls,
    _pets: () => ctx.pets,
    _pendingApprovals: () => ctx.proactive.pendingApprovals,
    _resolveServedFile: (url, testPaths) => createPetAssets({ paths: testPaths, stagedCorePath: () => coreInstaller?.stagedPath }).resolveServedFile(url),
};
