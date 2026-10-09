// modules/ipc/deskPetHandlers.js
// 桌宠（可选模块，默认关闭）：每个 agent 一个透明、无边框、置顶的小窗，
// 显示该 agent 的 Live2D 模型或差分立绘。可以在桌宠上直接和这个 agent 说话（经主窗口发送，
// 历史照常保存），回复以气泡显示，表情由页面里的情绪导演（modules/emotion）按回复流决定。
//
// Nova 的三套模型来自应用 assets/deskpet/nova/；自定义模型仍来自用户数据目录：
//   AppData/deskpet/live2dcubismcore.min.js     Cubism Core（必须是 5.x；设置页一键下载或用户自行放入）
//   AppData/Agents/<id>/deskpet/<套装>/           一套形象（换装）：Live2D、网格立绘或差分立绘，见 modules/deskpet/outfits.js
//   AppData/Agents/<id>/deskpet/*.model3.json    直接放在 deskpet/ 下的算「默认」那套（以前的单模型布局照旧能用）
//   AppData/Agents/<id>/portrait.<情绪>.<ext>    差分立绘：「立绘」那套，也是 Live2D 用不了时的后备
//   AppData/Agents/<id>/portrait.<ext>           默认立绘；再没有就用头像

const electron = require('electron');
const { BrowserWindow, ipcMain, protocol, net, screen, Menu } = electron;
const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const voice = require('./deskPetVoice');
const petPrefs = require('../deskpet/petPrefs');
const outfitStore = require('../deskpet/outfits');
const { createPetAssets, isAgentId, outfitSummary, SCHEME } = require('../deskpet/petAssets');
const { createPetStateStore, rememberFigure, savedAspect, hasSavedPosition } = require('../deskpet/petState');
const petTray = require('../deskpet/petTray');
const { createIdleRunner } = require('../deskpet/idleRunner');
const { createPetControls } = require('../deskpet/petControls');
const { createPetPreviews } = require('../deskpet/petPreviews');
const { createSettingsPage } = require('../deskpet/settingsPage');
const { createCoreInstaller } = require('../deskpet/cubismCore');
const { createFullscreenWatch } = require('../deskpet/fullscreenWatch');
const edgeSnap = require('../deskpet/edgeSnap');
const throwMotion = require('../deskpet/throwMotion');
const wander = require('../deskpet/wander');
const idleChat = require('../deskpet/idleChat');
const { getAgentMoodStore } = require('../agentMood');

// 窗口大小随每个桌宠自己的缩放和形象的长宽比走（modules/deskpet/petPrefs.js）；不知道比例时 1 倍是 360×580，
// 上方留出气泡和输入框的位置。
// Windows：'pop-up-menu' 压住任务栏，又不像 'screen-saver' 那样和全屏程序抢；
// macOS 需要 'screen-saver' 才能浮在全屏空间之上。
const TOPMOST_LEVEL = process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu';
const HIT_POLL_MS = 50;
const DRAG_TICK_MS = 16;
// X11 上整窗穿透后 Chromium 收不到指针，getCursorScreenPoint() 会停在旧坐标，
// 光标轮询就再也发现不了宠物；Linux 改为把窗口输入区裁到内容包围盒。
const USE_SHAPE = process.platform === 'linux';
const SEND_TIMEOUT_MS = 10000;
// 主窗口发出后还要等一会儿（最多 1.5 s）确认存进了历史才回结果：截止时间要把这段留出来，
// 不然发出去了、结果却晚于桌宠的超时，用户再点一次就发了两遍
const SEND_ACCEPT_MARGIN_MS = 2000;
const DRAG_MAX_MS = 60000;
const DISPLAY_SETTLE_MS = 400;
// 启动时恢复上次的桌宠：等主窗口载完再开，不和首屏抢。
const RESTORE_DELAY_MS = 1500;
// 滚轮调大小：攒够一格再变，触控板的细碎滚动不至于一下变好几档。
const WHEEL_NOTCH = 100;
// 窗口平时是否可聚焦（见 openPet）；输入框关上或页面重载后回到它。
const PET_FOCUSABLE = process.platform !== 'win32';
// Windows 上别的置顶程序（任务管理器、置顶播放器、部分全屏切窗口）弹到前面后，桌宠会被压在下面且不会自己回来；
// 低频补一次置顶层级。只动 z 序，不抢焦点。
const TOPMOST_GUARD_MS = 10000;
const USE_TOPMOST_GUARD = process.platform === 'win32';

let paths = null; // { projectRoot, appDataRoot, agentDir }
let assets = null; // modules/deskpet/petAssets.js：协议背后的文件、助手的形象清单
let stateStore = null; // modules/deskpet/petState.js：AppData/deskpet/state.json
let mainWindow = null;
let initialized = false;
const pets = new Map(); // agentId -> { win, scale, outfit, aspect, ignoringMouse, interactive, hitPoll, drag, lastShape }
const pendingSends = new Map(); // requestId -> resolve
let emotionPrompt = null; // modules/emotion/emotionPrompt.js（ESM，初始化时异步载入）
let controls = null; // modules/deskpet/petControls.js：全局设置、快捷键、设置页的开关和快捷键部分
let previews = null; // modules/deskpet/petPreviews.js：设置页卡片用的形象快照（离屏渲染）
let coreInstaller = null; // modules/deskpet/cubismCore.js：设置页里装 Cubism Core
let shuttingDown = false; // 退出时关窗口不算用户关掉，下次启动还要恢复
let lastTouched = null; // 最近一次被点、被叫出来的桌宠，「和桌宠说话」快捷键找它
let refreshTray = () => {};
let lastTalkedAgentId = null; // 最近一次发出请求的 agent，闹钟认不出是谁设的时交给它的桌宠
const alarms = new Map(); // id -> { timer, dueAt, text, maid }
let idle = null; // 闲时主动搭话（modules/deskpet/idleRunner.js）
const pendingWhere = new Map(); // requestId -> resolve：问主窗口现在开着哪个话题
let services = {}; // { readSettings, historyQueue, agentOps }：main.js 传进来的聊天记录服务（取值函数）
const announcedTopics = new Set(); // 已经在桌宠上说过的话题（同一请求重放时结果会重复回来）

function registerSchemes() {
    protocol.registerSchemesAsPrivileged([
        { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);
}

function registerProtocol() {
    protocol.handle(SCHEME, async (request) => {
        const file = assets.resolveServedFile(request.url);
        if (!file || !(await fs.pathExists(file))) return new Response('not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
    });
}

const listAgentOutfits = (agentId) => assets.listOutfits(agentId);
const resolveAssets = (agentId, wantedOutfit) => assets.resolveAssets(agentId, wantedOutfit);
const listAgents = () => assets.listAgents();

// ---- 窗口 ----------------------------------------------------------------

const readPetState = () => stateStore.read();
const savePetState = (agentId, patch) => stateStore.save(agentId, patch);

function savePetPosition(agentId, position) {
    return savePetState(agentId, { x: position[0], y: position[1] });
}

function sizeOf(pet) {
    return petPrefs.windowSizeForScale(pet.scale, pet.aspect);
}

// 没有记下位置的桌宠从屏幕右下角往左排：已经有桌宠站着的地方让开（窗口两边是透明的，按中间那段人物算），
// 不然几个桌宠叠在同一个角落，后开的把前面的整个挡住。index 是第几个位置（显示器变了、要挪回来时用）。
function defaultPosition(index, size, { avoid = [] } = {}) {
    const area = screen.getPrimaryDisplay().workArea;
    const step = Math.max(40, Math.round(size.width * 0.55));
    const xAt = (slot) => Math.max(area.x, area.x + area.width - size.width - 24 - slot * step);
    const middle = (x, width) => [x + width * 0.25, x + width * 0.75];
    const taken = (x) => avoid.some((b) => {
        const [a1, a2] = middle(x, size.width);
        const [b1, b2] = middle(b.x, b.width);
        return a1 < b2 && b1 < a2;
    });
    let slot = index;
    for (let i = 0; i < 12 && taken(xAt(slot)); i += 1) slot += 1;
    return { x: xAt(slot), y: area.y + area.height - size.height };
}

function isOnScreen(x, y, size) {
    return screen.getAllDisplays().some(({ workArea: a }) =>
        x + size.width > a.x && x < a.x + a.width && y + 40 > a.y && y < a.y + a.height);
}

function workAreaAt(bounds) {
    try {
        return (screen.getDisplayMatching?.(bounds) || screen.getPrimaryDisplay()).workArea;
    } catch {
        return screen.getPrimaryDisplay().workArea;
    }
}

function initialBounds(saved, size) {
    const others = [...pets.values()].filter((p) => !p.win.isDestroyed()).map((p) => p.win.getBounds());
    const fallback = defaultPosition(0, size, { avoid: others });
    if (!hasSavedPosition(saved)) return { ...size, ...fallback };
    // 位置不在任何显示器上（拔了外接屏）就回到默认位置。
    if (!isOnScreen(saved.x, saved.y, size)) return { ...size, ...fallback };
    // 上次藏在屏幕边里：窗口本来就有一大截在屏外，原样放回（openPet 接着按藏边处理）
    const tucked = saved.tuck?.tucked;
    if (tucked && tucked.x === saved.x && tucked.y === saved.y) return { ...size, x: saved.x, y: saved.y };
    // 在那块屏上放不全（换了分辨率、上次在更大的屏上）：整个挪回屏里。
    // 底边留出脚下那截透明的余量：贴着任务栏、甩下去落地的桌宠窗口本来就比工作区低一点，重开不能悬空
    const area = workAreaAt({ x: saved.x, y: saved.y, ...size });
    return {
        ...size,
        x: Math.min(Math.max(saved.x, area.x), area.x + area.width - size.width),
        y: Math.min(Math.max(saved.y, area.y), area.y + area.height - size.height + petPrefs.FOOT_RESERVE),
    };
}

// 窗口位置和大小都从这里设。宽高总用算出来的值，不把 getBounds() 读回来的再写回去：
// Windows 在 125%/150% 缩放下读回来的宽高可能多了一两个像素，写回去就会越变越大。
function applyBounds(pet, bounds, { verify = true } = {}) {
    if (pet.win.isDestroyed()) return;
    pet.win.setBounds(bounds);
    if (!verify) return;
    const got = pet.win.getBounds();
    if (got.width === bounds.width && got.height === bounds.height) return;
    // 不可调整大小的窗口在部分缩放比例下 setBounds 改不动尺寸，临时放开再设一次
    pet.win.setResizable?.(true);
    pet.win.setBounds(bounds);
    pet.win.setResizable?.(false);
}

// 拔掉外接屏、改分辨率或缩放之后：不在任何屏上的桌宠挪回主屏，被系统改掉的窗口尺寸改回来，
// 新屏放不下的大小缩到放得下。
function fitPetsToDisplays() {
    let index = 0;
    for (const pet of pets.values()) {
        if (pet.win.isDestroyed() || pet.drag) continue;
        const b = pet.win.getBounds();
        const area = workAreaAt(b);
        const previous = { ...b, ...sizeOf(pet) };
        const fitted = petPrefs.fitScale(pet.scale, area, pet.aspect);
        const scaleChanged = fitted !== pet.scale;
        pet.scale = fitted;
        const size = sizeOf(pet);
        const onScreen = isOnScreen(b.x, b.y, size);
        // 缩小了：脚底对齐、整个挪回这块屏里；没缩只是不在屏上：回默认位置
        const next = scaleChanged ? petPrefs.resizeAnchored(previous, size, area)
            : onScreen ? { x: b.x, y: b.y } : defaultPosition(index, size);
        if (scaleChanged || !onScreen || b.width !== size.width || b.height !== size.height) {
            if (scaleChanged || !onScreen) untuck(pet);
            applyBounds(pet, { ...next, ...size });
            if (scaleChanged || !onScreen) savePetState(pet.agentId, { x: next.x, y: next.y, tuck: null, ...(scaleChanged ? { scale: fitted } : {}) });
        }
        if (scaleChanged) {
            resetShape(pet);
            sendPrefs(pet);
        }
        index += 1;
    }
}

let displayTimer = null;
function onDisplaysChanged() {
    // 改缩放、远程桌面重连时这些事件会连发，等它们停下来再处理。
    clearTimeout(displayTimer);
    displayTimer = setTimeout(() => {
        displayTimer = null;
        try { fitPetsToDisplays(); for (const pet of pets.values()) reassertTopmost(pet); } catch (error) { console.warn('[DeskPet] display change:', error.message); }
    }, DISPLAY_SETTLE_MS);
}

function visibleAgents() {
    // 全屏时躲起来的也算开着：主窗口头部的开关不跟着跳
    return [...pets.entries()].filter(([, pet]) => !pet.win.isDestroyed() && (pet.win.isVisible() || pet.yielded)).map(([id]) => id);
}

function notifyMain(agentId) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        const openAgents = visibleAgents();
        mainWindow.webContents.send('deskpet:state-changed', { agentId, open: openAgents.includes(agentId), openAgents });
    }
    controls?.refreshSettings();
}

// 设置页（主窗口全局设置 → 桌宠）收到的推送
function mainContents() {
    return mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed?.() ? mainWindow.webContents : null;
}

const settingsPush = {
    changed: (snapshot) => mainContents()?.send('deskpet-settings:changed', snapshot),
    preview: (payload) => mainContents()?.send('deskpet-settings:preview', payload),
    coreProgress: (payload) => mainContents()?.send('deskpet-settings:core-progress', payload),
};

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
        win.loadURL(assets.appUrl(`core-probe.html?n=${Date.now()}`)).catch(() => finish(0));
    });
}

// 装好 Core 以后，正在用立绘代替 Live2D 的桌宠重新载入一次，换成真正的 Live2D。
async function reloadLive2DPets() {
    for (const pet of pets.values()) {
        if (pet.win.isDestroyed()) continue;
        const assets = await resolveAssets(pet.agentId, pet.outfit).catch(() => null);
        if (assets?.live2d && !pet.win.isDestroyed()) pet.win.webContents.reload();
    }
}

/** 托盘、右键菜单的「桌宠设置…」：把主窗口叫到前面，打开全局设置的桌宠分区。 */
function openSettingsPage() {
    openMainWindow();
    mainContents()?.send('deskpet-settings:open');
}

function showPet(pet) {
    pet.yielded = false;
    lastTouched = pet.agentId;
    pet.win.showInactive();
    // Windows 上透明窗口隐藏再显示后可能丢掉 WS_EX_TOPMOST，每次显示后重新声明。
    pet.win.setAlwaysOnTop(true, TOPMOST_LEVEL);
    pet.win.moveTop();
}

function reassertTopmost(pet) {
    if (!pet || pet.win.isDestroyed() || !pet.win.isVisible() || pet.drag) return;
    pet.win.setAlwaysOnTop(true, TOPMOST_LEVEL);
    pet.win.moveTop();
}

let topmostGuard = null;
function updateTopmostGuard() {
    const wanted = USE_TOPMOST_GUARD && pets.size > 0;
    if (wanted && !topmostGuard) {
        topmostGuard = setInterval(() => { for (const pet of pets.values()) reassertTopmost(pet); }, TOPMOST_GUARD_MS);
        topmostGuard.unref?.();
    } else if (!wanted && topmostGuard) {
        clearInterval(topmostGuard);
        topmostGuard = null;
    }
}

// ---- 全屏让位（modules/deskpet/fullscreenWatch.js）---------------------------------
// 别的程序在某块屏上全屏时，那块屏上露着的桌宠先藏起来（记作 yielded），退出全屏再放出来。
// 只在进出全屏的那一下动手：全屏期间用户自己把桌宠叫出来就留着，自己藏起来的也不会被放回来。

let fullscreenWatch = null;
function updateFullscreenWatch() {
    if (!fullscreenWatch) return;
    const settings = controls?.get() || petPrefs.DEFAULT_SETTINGS;
    if (settings.yieldToFullscreen && pets.size > 0 && !shuttingDown) fullscreenWatch.start();
    else fullscreenWatch.stop();
}

/** 全屏的那块屏（DIP）上有没有这个桌宠；只有一块屏时都算。 */
function onFullscreenDisplay(pet, area) {
    const displays = screen.getAllDisplays();
    if (displays.length <= 1) return true;
    return screen.getDisplayMatching(area).id === screen.getDisplayMatching(pet.win.getBounds()).id;
}

function applyFullscreen(state) {
    let area = null;
    if (state?.fullscreen && state.rect) {
        // 脚本报的是物理像素；只有 Windows 有 screenToDipRect，也只有 Windows 会报
        area = typeof screen.screenToDipRect === 'function' ? screen.screenToDipRect(null, state.rect) : state.rect;
    }
    for (const pet of pets.values()) {
        if (pet.win.isDestroyed()) continue;
        if (area && onFullscreenDisplay(pet, area)) {
            if (!pet.win.isVisible() || pet.drag || pet.interactive) continue;
            pet.yielded = true;
            pet.win.hide();
        } else if (pet.yielded) {
            showPet(pet);
        }
    }
    refreshTray();
}

function setIgnoreMouse(pet, ignore) {
    if (USE_SHAPE || pet.win.isDestroyed() || ignore === pet.ignoringMouse || pet.ignoringMouse === 'through') return;
    pet.ignoringMouse = ignore;
    // forward:true 让 Windows/macOS 在穿透时仍把 mousemove 送到页面。
    pet.win.setIgnoreMouseEvents(ignore, { forward: true });
}

// 只看不点：整窗穿透且不转发鼠标，页面碰不到悬停、点击和拖动。输入框打开时（快捷键「和桌宠说话」）照常可用，
// 收起后回到穿透。按像素穿透那套（setIgnoreMouse、Linux 的输入区）在这期间不动窗口。
function clickThroughOn() {
    return controls?.get().clickThrough === true;
}

// 截图、录屏、共享屏幕时不出现在画面里（Linux 上 Electron 不支持，调用也无害）
function applyCaptureHiding(win) {
    if (!win || win.isDestroyed()) return;
    try { win.setContentProtection(controls?.get().hideFromCapture === true); } catch { /* 平台不支持 */ }
}

function applyClickThrough(pet) {
    if (!pet || pet.win.isDestroyed()) return;
    const through = clickThroughOn() && !pet.interactive;
    if (through) {
        if (pet.ignoringMouse === 'through') return;
        pet.ignoringMouse = 'through';
        pet.win.setIgnoreMouseEvents(true);
    } else if (pet.ignoringMouse === 'through') {
        pet.ignoringMouse = null;
        if (USE_SHAPE) {
            pet.win.setIgnoreMouseEvents(false);
            resetShape(pet);
        } else {
            setIgnoreMouse(pet, true);
        }
    }
}

function setClickThrough(on) {
    controls?.update({ clickThrough: !!on });
}

// 光标在窗口范围内时把窗口内坐标发给页面，页面按像素 alpha 回答是否命中。
// 不依赖 forward 的鼠标钩子（Windows 上它会悄悄失效）。
function startHitPoll(pet) {
    pet.hitPoll = setInterval(() => {
        if (pet.win.isDestroyed() || pet.drag || pet.interactive || !pet.win.isVisible()) return;
        const p = screen.getCursorScreenPoint();
        const b = pet.win.getBounds();
        const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
        if (!inside) {
            setIgnoreMouse(pet, true);
            // 光标在窗外时只用来让角色看过去；同一位置不重复发。
            if (pet.lastGaze !== `${p.x},${p.y}`) {
                pet.lastGaze = `${p.x},${p.y}`;
                pet.win.webContents.send('deskpet:cursor', { x: p.x - b.x, y: p.y - b.y, outside: true });
            }
            return;
        }
        pet.lastGaze = null;
        pet.win.webContents.send('deskpet:cursor', { x: p.x - b.x, y: p.y - b.y });
    }, HIT_POLL_MS);
}

// anchor：在别的桌宠原来的位置打开（切换助手），按脚底中点对齐。
async function openPet(agentId, { anchor = null } = {}) {
    if (pets.has(agentId)) {
        showPet(pets.get(agentId));
        notifyMain(agentId);
        return { success: true, open: true };
    }
    if (!(await assets.agentExists(agentId))) {
        return { success: false, error: 'agent-not-found' };
    }
    // 读状态期间同一个助手可能已经被另一次调用打开了（快捷键连按、启动恢复和点按钮撞在一起）
    const saved = (await readPetState())[agentId];
    // 上次选的那套形象（没选过或已经删了就用默认那套）；量过它的长宽比就直接按它开窗口
    const outfit = outfitStore.pickOutfit(await listAgentOutfits(agentId).catch(() => []), saved?.outfit);
    if (pets.has(agentId)) return openPet(agentId);
    const outfitId = outfit?.id || null;
    const aspect = outfitId ? savedAspect(saved, outfitId) : null;
    // 按桌宠所在的那块屏限制大小（getDisplayMatching 要完整的矩形，只给 x/y 会退回主屏）
    const savedSize = petPrefs.savedScale(saved);
    const savedRect = hasSavedPosition(saved) ? { x: saved.x, y: saved.y, ...petPrefs.windowSizeForScale(savedSize, aspect) } : null;
    const scale = petPrefs.fitScale(savedSize, workAreaAt(anchor || savedRect || screen.getPrimaryDisplay().workArea), aspect);
    const size = petPrefs.windowSizeForScale(scale, aspect);
    // 旧版记的位置：按脚底对齐换到新尺寸，记下来以后就是新版的了
    const legacy = anchor ? null : petPrefs.legacyPosition(saved, aspect, scale);
    // 旧版记的大小也一起换成新版的记下来：之后记位置会标上新版，旧的大小就不能再留着
    const oldSize = saved?.scale != null && !(Number(saved.sizeVersion) >= petPrefs.SIZE_VERSION);
    if (legacy || oldSize) savePetState(agentId, { ...(legacy || {}), scale }).catch(() => {});
    const win = new BrowserWindow({
        ...(anchor ? petPrefs.resizeAnchored(anchor, size, workAreaAt(anchor)) : initialBounds(legacy ? { ...saved, ...legacy, tuck: null } : saved, size)),
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // Windows：点宠物不抢走正在输入的程序的焦点，只在输入框打开时临时变成可聚焦。
        // macOS 不可聚焦的窗口收不到点击，Linux 窗口管理器对不可聚焦窗口的处理不一
        // （有的直接丢输入），这两处保持可聚焦。
        focusable: PET_FOCUSABLE,
        show: false,
        title: 'VCPChat 桌宠',
        webPreferences: {
            preload: path.join(paths.projectRoot, 'preloads', 'deskpet.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            // 主窗口最小化时桌宠照常动；空闲降帧和隐藏时暂停由页面自己做。
            backgroundThrottling: false,
        },
    });
    applyCaptureHiding(win);
    const pet = { win, contents: win.webContents, agentId, scale, outfit: outfitId, aspect, ignoringMouse: true, interactive: false, hitPoll: null, drag: null, lastShape: '', wheel: 0, ready: false, pendingToggle: null, readyWaiters: [] };
    // 上次藏在屏幕边里、位置没被挪过：接着藏，鼠标过来照样探出来
    const savedTuck = saved?.tuck;
    if (!anchor && savedTuck?.tucked && savedTuck?.outPos) {
        const [atX, atY] = win.getPosition();
        const area = workAreaAt(win.getBounds());
        if (savedTuck.tucked.x === atX && savedTuck.tucked.y === atY) {
            if (isOuterEdge(area, savedTuck.side, atY + win.getBounds().height / 2)) {
                pet.tuck = { side: savedTuck.side, tucked: savedTuck.tucked, outPos: savedTuck.outPos, isOut: false };
            } else {
                // 那条边外面现在接了别的屏：不再藏，整只出来
                win.setPosition(savedTuck.outPos.x, savedTuck.outPos.y);
                savePetState(agentId, { x: savedTuck.outPos.x, y: savedTuck.outPos.y, tuck: null }).catch(() => {});
            }
        }
    }
    pets.set(agentId, pet);
    rememberOpen(agentId, true);

    win.setAlwaysOnTop(true, TOPMOST_LEVEL);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (!USE_SHAPE) win.setIgnoreMouseEvents(true, { forward: true });
    win.once('ready-to-show', () => {
        showPet(pet);
        notifyMain(agentId);
    });
    // 第一次载入时状态本来就是初始值；之后的重载（崩溃恢复、刷新）要把主进程这边也清零。
    win.webContents.on('did-start-loading', () => {
        pet.ready = false;
        resetInputState(pet);
        voice.release(pet);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
        console.warn('[DeskPet] renderer gone:', details.reason);
        if (win.isDestroyed()) return;
        resetInputState(pet);
        if (details.reason === 'clean-exit') return;
        // 一分钟里崩了 3 次以上才放弃（模型本身有问题时别无限崩溃重启）；
        // 偶尔崩一次（显卡驱动重置、睡眠唤醒）不攒着算，挂一整天的桌宠不会因为第四次偶发崩溃就消失
        const now = Date.now();
        pet.crashTimes = [...(pet.crashTimes || []).filter((at) => now - at < CRASH_WINDOW_MS), now];
        if (pet.crashTimes.length <= CRASH_LIMIT) setTimeout(() => !win.isDestroyed() && win.reload(), 250);
        else win.close();
    });
    // 窗口开着时关了后台节流（主窗口最小化时桌宠照常动），隐藏时页面感觉不到，主动告诉它停下。
    const sendVisibility = (visible) => !win.isDestroyed() && win.webContents.send('deskpet:visibility', visible);
    win.on('hide', () => sendVisibility(false));
    win.on('show', () => sendVisibility(true));
    // 置顶被系统或别的程序取消时（例如别的程序调用了 SetWindowPos），马上补回来
    win.on('always-on-top-changed', (_e, onTop) => {
        if (!onTop && !shuttingDown) setImmediate(() => reassertTopmost(pet));
    });
    win.on('closed', () => {
        voice.release(pet);
        clearInterval(pet.hitPoll);
        clearTimeout(pet.tuckTimer);
        clearInterval(pet.walk);
        stopSnap(pet);
        stopDrag(pet);
        settleReady(pet, new Error('桌宠已经关了'));
        for (const [requestId, entry] of pendingApprovals) if (entry.agentId === agentId) pendingApprovals.delete(requestId);
        pets.delete(agentId);
        updateTopmostGuard();
        updateFullscreenWatch();
        if (lastTouched === agentId) lastTouched = null;
        // 用户关掉的下次不再恢复；退出时一起关掉的照旧恢复
        if (!shuttingDown) rememberOpen(agentId, false);
        notifyMain(agentId);
    });
    win.loadURL(assets.pageUrl(agentId));
    if (!USE_SHAPE) startHitPoll(pet);
    applyClickThrough(pet);
    updateTopmostGuard();
    updateFullscreenWatch();
    notifyMain(agentId);
    return { success: true, open: true };
}

// 混合 DPI 多屏之间 setPosition 可能顺带改尺寸，统一用 setBounds 固定宽高。
function moveWithCursor(pet, drag) {
    const c = screen.getCursorScreenPoint();
    // 记最近几个光标位置：松手时按它算甩出去的速度
    // 光标没动就不记：停稳了再松手时最后一个样本是旧的，才认得出「不是甩」
    const samples = drag.samples || (drag.samples = []);
    const last = samples[samples.length - 1];
    if (!last || last.x !== c.x || last.y !== c.y) samples.push({ t: Date.now(), x: c.x, y: c.y });
    if (samples.length > 12) samples.shift();
    applyBounds(pet, { x: c.x - drag.dx, y: c.y - drag.dy, ...sizeOf(pet) }, { verify: false });
}

// 甩出去（modules/deskpet/throwMotion.js）：松手时光标还在快速移动就带着速度滑出去、落到任务栏上，
// 落地时页面演一下「落地」。按着 Alt 松手、慢慢放下的不甩。
function throwPet(pet, figure, samples) {
    const win = pet.win.getBounds();
    const frames = throwMotion.throwPath(win, figure, workAreaAt(win), throwMotion.releaseVelocity(samples, Date.now()), DRAG_TICK_MS);
    if (!frames) return false;
    stopSnap(pet);
    pet.snap = playFrames(pet, frames, {
        stop: () => stopSnap(pet),
        done: (last) => {
            // 甩走了就不再藏在边里（拿起来时 pet.tuck 已清，这里把存下的也清掉）
            savePetState(pet.agentId, { x: last.x, y: last.y, tuck: null }).catch(() => {});
            pet.win.webContents.send('deskpet:landed');
        },
    });
    return true;
}

// 一帧一帧挪窗口（甩出去、滑过去、溜达共用）：窗口没了、被拎起来或 halted() 时 stop()；
// 走完最后一帧先 stop() 再 done(最后一帧)
function playFrames(pet, frames, { stop, halted = () => false, done }) {
    const size = sizeOf(pet);
    return setInterval(() => {
        const next = frames.shift();
        if (!next || pet.win.isDestroyed() || pet.drag || halted()) {
            stop();
            return;
        }
        applyBounds(pet, { ...next, ...size }, { verify: false });
        if (!frames.length) {
            stop();
            done?.(next);
        }
    }, DRAG_TICK_MS);
}

// 贴边（modules/deskpet/edgeSnap.js）：松手时角色离屏幕左右边或任务栏很近，就滑过去贴齐。
// figure 是页面报的角色包围盒（窗口内坐标）；free 是按着 Alt 松手，不吸。
function stopSnap(pet) {
    clearInterval(pet.snap);
    pet.snap = null;
}

// 那条边外面还有没有屏幕（扩展屏中间那条边不能藏：藏进去的半个身子会露在另一块屏上）
function isOuterEdge(area, side, y) {
    const x = side === 'left' ? area.x - 2 : area.x + area.width + 2;
    try {
        return !screen.getAllDisplays().some((d) => {
            const b = d.bounds || d.workArea;
            return b && x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
        });
    } catch {
        return true;
    }
}

// 窗口滑到 to（几帧，先快后慢）；滑完 done
function slideTo(pet, to, done) {
    stopSnap(pet);
    const win = pet.win.getBounds();
    if (to.x === win.x && to.y === win.y) {
        done?.();
        return;
    }
    pet.snap = playFrames(pet, edgeSnap.snapFrames(win, to), { stop: () => stopSnap(pet), done: () => done?.() });
}

function snapToEdge(pet, figure, { free = false } = {}) {
    stopSnap(pet);
    pet.tuck = null;
    if (free || pet.win.isDestroyed()) return false;
    const win = pet.win.getBounds();
    const area = workAreaAt(win);
    // 拖出去一大截：收进边里只露一条，鼠标过来、有话说时探出来（见 setWantOut）
    const tuck = figure && edgeSnap.tuckPosition(win, figure, area, (side, y) => isOuterEdge(area, side, y));
    if (tuck) {
        pet.tuck = { side: tuck.side, tucked: tuck.tucked, outPos: tuck.out, isOut: false };
        slideTo(pet, tuck.tucked, () => savePetState(pet.agentId, {
            x: tuck.tucked.x, y: tuck.tucked.y, tuck: { side: tuck.side, tucked: tuck.tucked, outPos: tuck.out },
        }).catch(() => {}));
        return true;
    }
    savePetState(pet.agentId, { tuck: null }).catch(() => {});
    const inside = figure && figure.x >= -1 && figure.y >= -1
        && figure.x + figure.width <= win.width + 1 && figure.y + figure.height <= win.height + 1;
    if (!inside) return false;
    const target = edgeSnap.snapPosition(win, figure, area);
    if (!target || (target.x === win.x && target.y === win.y)) return false;
    slideTo(pet, target, () => savePetPosition(pet.agentId, [target.x, target.y]).catch(() => {}));
    return true;
}

// 大小变了、换了屏：窗口整个挪回屏里，藏边作废
function untuck(pet) {
    clearTimeout(pet.tuckTimer);
    pet.tuck = null;
    // 正在滑、甩、溜达的也停下：它们的下一帧还按旧位置、旧屏走
    stopSnap(pet);
    stopWalk(pet, { save: false });
}

// 藏在边里的桌宠：鼠标停在露出来的那条上、气泡或输入框开着时整只探出来；都没了等一会儿再缩回去。
const TUCK_BACK_MS = 1200;
function setWantOut(pet, want) {
    const tuck = pet.tuck;
    if (!tuck || pet.drag || pet.win.isDestroyed()) return;
    clearTimeout(pet.tuckTimer);
    if (want) {
        if (!tuck.isOut) {
            tuck.isOut = true;
            slideTo(pet, tuck.outPos);
        }
    } else if (tuck.isOut) {
        pet.tuckTimer = setTimeout(() => {
            if (pet.tuck !== tuck || pet.drag || pet.win.isDestroyed()) return;
            tuck.isOut = false;
            slideTo(pet, tuck.tucked);
        }, TUCK_BACK_MS);
    }
}

// 溜达（modules/deskpet/wander.js）：页面闲了一阵来问，主进程沿任务栏慢慢挪窗口；
// 鼠标碰到角色、拖动、说话、藏起来都会停在原地。
function stopWalk(pet, { save = true } = {}) {
    if (!pet.walk) return;
    clearInterval(pet.walk);
    pet.walk = null;
    if (pet.win.isDestroyed()) return;
    pet.win.webContents.send('deskpet:walk', { dir: null });
    if (save) savePetPosition(pet.agentId, pet.win.getPosition()).catch(() => {});
}

function startWalk(pet, figure) {
    if (controls?.get().wander !== true || pet.walk || pet.drag || pet.snap || pet.tuck || pet.interactive) return false;
    if (pet.win.isDestroyed() || !pet.win.isVisible()) return false;
    const win = pet.win.getBounds();
    const target = wander.wanderTarget(win, figure, workAreaAt(win));
    if (!target) return false;
    pet.win.webContents.send('deskpet:walk', { dir: target.dir });
    pet.walk = playFrames(pet, wander.walkFrames(win, target, DRAG_TICK_MS), { stop: () => stopWalk(pet), halted: () => !pet.win.isVisible() });
    return true;
}

function stopDrag(pet, { save = false } = {}) {
    if (!pet.drag) return;
    clearInterval(pet.drag.timer);
    pet.drag = null;
    if (save && !pet.win.isDestroyed()) savePetPosition(pet.agentId, pet.win.getPosition()).catch(() => {});
}

// 页面重新载入（崩溃自动重载、刷新）时，页面那边的命中、输入框、拖动状态都清零了，
// 主进程这边也要回到初始状态：否则上一次的「可点击」会让一块看不见的窗口挡住桌面。
function resetInputState(pet) {
    stopDrag(pet, { save: true });
    pet.interactive = false;
    pet.lastShape = '';
    if (pet.win.isDestroyed()) return;
    pet.win.setFocusable(PET_FOCUSABLE);
    if (pet.ignoringMouse === 'through') {
        // 页面重载后输入区要重新报；穿透本身保持
        return;
    }
    if (!USE_SHAPE) {
        pet.ignoringMouse = null;
        setIgnoreMouse(pet, true);
    }
    applyClickThrough(pet);
}

const CRASH_WINDOW_MS = 60 * 1000;
const CRASH_LIMIT = 3;

function closePet(agentId) {
    const pet = pets.get(agentId);
    if (pet && !pet.win.isDestroyed()) pet.win.close();
    return { success: true, open: false };
}

/** 助手被删掉：关掉 TA 的桌宠，state.json、开着的列表、最近用过的、卡片快照里都不再留着 TA。
 *  在删目录之前调用（Windows 上桌宠页面还开着时，正在用的模型文件可能删不掉）。 */
async function forgetAgent(agentId) {
    if (!paths || !isAgentId(agentId)) return; // 桌宠模块没启用
    const pet = pets.get(agentId);
    if (pet && !pet.win.isDestroyed()) {
        const closed = new Promise((resolve) => pet.win.once('closed', resolve));
        pet.win.close();
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    if (controls) {
        const settings = controls.get();
        controls.update({
            openAgents: settings.openAgents.filter((id) => id !== agentId),
            ...(settings.lastAgent === agentId ? { lastAgent: null } : {}),
        });
    }
    await stateStore.remove(agentId);
    await previews?.forget(agentId);
    refreshTray();
}

// 页面报上来的角色包围盒（窗口内坐标）；不是四个有限数就当没有
function figureFrom(report) {
    const f = report?.figure;
    return f && [f.x, f.y, f.width, f.height].every(Number.isFinite) ? { x: f.x, y: f.y, width: f.width, height: f.height } : null;
}

function petFromEvent(event) {
    for (const pet of pets.values()) {
        if (!pet.win.isDestroyed() && pet.win.webContents === event.sender) return pet;
    }
    return null;
}

// ---- 回复流接入（chatHandlers 调用） ----------------------------------------

// 桌宠能演的动作写在情绪标记的斜杠后面（DeskPetmodules/gestures.js），标记本身哪里都会去掉。
const GESTURE_PROMPT = [
    '【桌宠动作】桌面上的你还会做动作：想配合动作时，把动作名写在情绪标记的斜杠后面，例如 <!--emo:happy/nod 0.8-->。',
    '动作只能是：nod（点头）shake（摇头）tilt（歪头）cheer（开心地跳一下）bow（鞠躬）。只在真的有这个动作时写，不要每句都写。',
].join('\n');

/** 该 agent 的桌宠打开时，返回要追加到 system prompt 的情绪标记和动作说明（情绪标记与侧栏差分立绘共用一段）。 */
function getSystemPromptAppend(agentId, systemPrompt = '') {
    if (!agentId || !pets.has(agentId) || !emotionPrompt) return '';
    // 侧栏立绘已经加过、或者角色自己的提示词里写了标记说明，就不再重复。
    const parts = [];
    if (emotionPrompt.shouldAddEmotionTagPrompt({ systemPrompt, hasDisplay: true })) parts.push(emotionPrompt.EMOTION_TAG_PROMPT);
    if (!/【桌宠动作】|<!--\s*emo\s*[:：][^>]*\/(?:nod|shake|tilt|cheer|bow)\b/i.test(String(systemPrompt || ''))) parts.push(GESTURE_PROMPT);
    return parts.join('\n');
}

function appendProtocolToMessages(messages, agentId) {
    if (!Array.isArray(messages)) return messages;
    const first = messages[0];
    const hasSystem = first && first.role === 'system' && typeof first.content === 'string';
    const append = getSystemPromptAppend(agentId, hasSystem ? first.content : '');
    if (!append) return messages;
    if (hasSystem) return [{ ...first, content: `${first.content}\n\n${append}` }, ...messages.slice(1)];
    return [{ role: 'system', content: append }, ...messages];
}

function extractDeltaText(chunk) {
    if (typeof chunk === 'string') return chunk;
    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
    const delta = choice?.delta || choice?.message || {};
    return typeof delta.content === 'string' ? delta.content : '';
}

// 回复流原样转给页面，由页面里的情绪导演决定表情和气泡内容。
function forward(agentId, event) {
    const pet = agentId && pets.get(agentId);
    if (pet && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:stream', event);
}

function onRequestStart(messageId, context) {
    if (context?.agentId) {
        lastTalkedAgentId = context.agentId;
        idle?.noteActivity(context.agentId);
    }
    forward(context?.agentId, { type: 'start', messageId: String(messageId) });
}

function onStreamPayload(payload) {
    const agentId = payload?.context?.agentId;
    if (!agentId || !pets.has(agentId)) return;
    const messageId = String(payload.messageId);
    if (payload.type === 'data') {
        const text = extractDeltaText(payload.chunk);
        if (text) forward(agentId, { type: 'data', messageId, text });
    } else if (payload.type === 'end') {
        forward(agentId, { type: 'end', messageId });
    } else if (payload.type === 'error') {
        // 出错的原因也带过去（主窗口里显示的那句）：桌宠上只写「出错了」的话，用户不知道是断网、超时还是服务器报错
        const reason = typeof payload.error === 'string' ? payload.error.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
        forward(agentId, { type: 'error', messageId, ...(reason ? { error: reason } : {}) });
    }
}

/** 非流式回复：整条内容一次性转过去。 */
function onFullResponse(messageId, context, response) {
    const agentId = context?.agentId;
    if (!agentId || !pets.has(agentId)) return;
    const text = response?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text) forward(agentId, { type: 'data', messageId: String(messageId), text });
    forward(agentId, { type: 'end', messageId: String(messageId) });
}

// ---- 从桌宠发消息：交给主窗口按正常流程发送 -----------------------------------

// 桌宠带过来的文件：拖进来的（本机路径）或粘贴的图片（字节）。主窗口按拖进输入框的流程存成附件。
const MAX_SEND_FILES = 10;
const MAX_SEND_FILE_BYTES = 20 * 1024 * 1024;
// 拖进来的文件：主窗口发送时整个读进内存再存一份，太大的会卡住整个程序
const MAX_DROP_FILE_BYTES = 200 * 1024 * 1024;

function cleanSendFiles(files) {
    if (!Array.isArray(files)) return [];
    const out = [];
    for (const file of files.slice(0, MAX_SEND_FILES)) {
        const name = typeof file?.name === 'string' && file.name ? path.basename(file.name).slice(0, 255) : '文件';
        const type = typeof file?.type === 'string' ? file.type.slice(0, 100) : '';
        if (typeof file?.path === 'string' && path.isAbsolute(file.path)) out.push({ path: file.path, name, type });
        else if (file?.data instanceof Uint8Array && file.data.length > 0 && file.data.length <= MAX_SEND_FILE_BYTES) out.push({ data: Buffer.from(file.data), name, type });
    }
    return out;
}

// 拖进来的文件：只收普通文件（不收文件夹、设备），也不收大到会卡住主窗口的。返回第一个不行的原因
async function checkDroppedFiles(files) {
    for (const file of files) {
        if (!file.path) continue;
        const stat = await fs.stat(file.path).catch(() => null);
        if (!stat?.isFile()) return `「${file.name}」不是能发的文件`;
        if (stat.size > MAX_DROP_FILE_BYTES) return `「${file.name}」太大了（超过 200 MB）`;
    }
    return '';
}

// 问主窗口一件事：ask(requestId) 发过去，等它在 pending 里按 requestId 回话；等不到算 timedOut
function askMain(pending, ask, { timeoutMs, timedOut, answer }) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            resolve(timedOut);
        }, timeoutMs);
        pending.set(requestId, (value) => {
            clearTimeout(timer);
            pending.delete(requestId);
            resolve(answer(value));
        });
        ask(requestId);
    });
}

function sendFromPet(agentId, text, { files = [], newTopic = false } = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve({ success: false, error: '主窗口不在了' });
    // 过了 deadline 桌宠已经报「没有响应」了：主窗口别再发出去，否则用户重试就会发两遍
    const deadline = Date.now() + SEND_TIMEOUT_MS - SEND_ACCEPT_MARGIN_MS;
    const ask = (requestId) => mainWindow.webContents.send('deskpet:send-request', { requestId, agentId, text, files, newTopic, deadline });
    return askMain(pendingSends, ask, {
        timeoutMs: SEND_TIMEOUT_MS,
        timedOut: { success: false, error: '主窗口没有响应' },
        answer: (result) => result || { success: false },
    });
}

/** 在同一个位置把桌宠换成另一个 agent（各自保留自己的大小，脚底对齐）。 */
async function switchPet(fromId, toId) {
    const pet = pets.get(fromId);
    if (!pet || fromId === toId) return;
    const anchor = pet.win.getBounds();
    if (pets.has(toId)) {
        const target = pets.get(toId);
        applyBounds(target, petPrefs.resizeAnchored(anchor, sizeOf(target), workAreaAt(anchor)));
        showPet(target);
    } else {
        const opened = await openPet(toId, { anchor });
        // 换不过去（助手刚被删掉）就留着原来的桌宠，不要两边都没了。
        if (!opened?.success) return;
    }
    closePet(fromId);
    const moved = pets.get(toId);
    if (moved && !moved.win.isDestroyed()) savePetPosition(toId, moved.win.getPosition());
}

// ---- 大小、免打扰、全部显示隐藏 ------------------------------------------------

// 页面要的设置（prefsFor）和托盘上显示的设置：这些变了才推给页面、才刷新托盘
const PAGE_PREF_KEYS = ['doNotDisturb', 'clickThrough', 'shortcuts', 'opacity', 'wander', 'followCursor'];
const TRAY_KEYS = ['doNotDisturb', 'clickThrough', 'shortcuts', 'openAgents', 'lastAgent'];

function sendPrefs(pet) {
    if (!pet || pet.win.isDestroyed()) return;
    pet.win.webContents.send('deskpet:prefs', prefsFor(pet));
}

function prefsFor(pet) {
    const settings = controls?.get() || petPrefs.DEFAULT_SETTINGS;
    const key = settings.shortcuts?.clickThrough || '';
    return {
        scale: pet.scale,
        doNotDisturb: settings.doNotDisturb,
        clickThrough: settings.clickThrough === true,
        opacity: settings.opacity ?? 1,
        wander: settings.wander === true,
        followCursor: settings.followCursor !== false,
        // 页面提示里写怎么关：按平台写成 Ctrl / Cmd
        clickThroughKey: key.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
    };
}

/**
 * 换了长宽比（换装、页面量出了形象的实际比例）后按新比例改窗口：脚底中点不动，大小档位不变，
 * 新比例在这块屏上放不下时缩到放得下。
 */
function applyAspect(pet, aspect) {
    if (!pet || pet.win.isDestroyed()) return false;
    const previous = { ...pet.win.getBounds(), ...sizeOf(pet) };
    const area = workAreaAt(previous);
    pet.aspect = aspect;
    pet.scale = petPrefs.fitScale(pet.scale, area, aspect);
    const size = sizeOf(pet);
    if (size.width === previous.width && size.height === previous.height) return false;
    const target = petPrefs.resizeAnchored(previous, size, area);
    untuck(pet);
    applyBounds(pet, target);
    resetShape(pet);
    sendPrefs(pet);
    savePetState(pet.agentId, { x: target.x, y: target.y, scale: pet.scale, tuck: null });
    return true;
}

/** 页面量出了当前这套形象的长宽比（不透明像素的包围盒，高 ÷ 宽）。 */
async function onFigureMeasured(pet, report) {
    const measured = petPrefs.normalizeAspect(report?.aspect);
    if (!measured || !pet.outfit || report?.outfit !== pet.outfit || pet.win.isDestroyed()) return;
    const saved = (await readPetState())[pet.agentId];
    const known = savedAspect(saved, pet.outfit);
    // 和记着的差不多就沿用记着的：量的时候正呼吸、做动作，每次差一点，窗口不该跟着变
    const aspect = known && petPrefs.sameAspect(measured, known) ? known : measured;
    if (known !== aspect) savePetState(pet.agentId, { figures: rememberFigure(saved, pet.outfit, aspect) });
    // 拖着的时候不改窗口，放下以后下次量到再改
    if (pet.drag || pet.win.isDestroyed() || report.outfit !== pet.outfit) return;
    if (pet.aspect !== null && petPrefs.sameAspect(aspect, pet.aspect)) return;
    applyAspect(pet, aspect);
    controls?.refreshSettings();
}

/** 换装：记住这次的选择，按这套的比例改窗口（脚底不动），再重新载入页面换上新形象。 */
async function setPetOutfit(agentId, outfitId) {
    const pet = pets.get(agentId);
    if (!pet || pet.win.isDestroyed() || !outfitStore.isOutfitId(outfitId)) return false;
    const outfit = (await listAgentOutfits(agentId).catch(() => [])).find((o) => o.id === outfitId);
    if (!outfit || pet.win.isDestroyed()) return false;
    if (pet.outfit === outfitId) return true;
    stopDrag(pet, { save: true });
    pet.outfit = outfitId;
    const saved = (await readPetState())[agentId];
    await savePetState(agentId, { outfit: outfitId });
    if (pet.win.isDestroyed() || pet.outfit !== outfitId) return false;
    // 没量过的形象先按默认比例开，页面量完会再报上来
    applyAspect(pet, savedAspect(saved, outfitId));
    pet.win.webContents.reload();
    controls?.refreshSettings();
    return true;
}

/** 改一个桌宠的大小：脚底不动，放不下就缩到当前屏放得下。 */
function setPetScale(agentId, scale) {
    const pet = pets.get(agentId);
    if (!pet && isAgentId(agentId)) {
        // 没开着的桌宠（设置页里调的）：记下来，下次按它开
        const next = petPrefs.clampScale(scale);
        savePetState(agentId, { scale: next }).then(() => controls?.refreshSettings());
        return next;
    }
    if (!pet || pet.win.isDestroyed() || pet.drag) return null;
    const bounds = pet.win.getBounds();
    const area = workAreaAt(bounds);
    const next = petPrefs.fitScale(scale, area, pet.aspect);
    if (next === pet.scale) return pet.scale;
    // 脚底位置按算出来的旧宽高定，不用读回来的（系统可能多算了一两个像素）
    const previous = { ...bounds, ...sizeOf(pet) };
    pet.scale = next;
    const target = petPrefs.resizeAnchored(previous, sizeOf(pet), area);
    untuck(pet);
    applyBounds(pet, target);
    resetShape(pet);
    sendPrefs(pet);
    savePetState(agentId, { x: target.x, y: target.y, scale: next, tuck: null });
    controls?.refreshSettings();
    return next;
}

function stepPetScale(agentId, direction) {
    const pet = pets.get(agentId);
    if (!pet) return null;
    return setPetScale(agentId, pet.scale + Math.sign(direction) * petPrefs.SCALE_STEP);
}

// Linux 的输入区按旧窗口算的，换大小后让页面重新报一次
function resetShape(pet) {
    pet.lastShape = '';
}

function setDoNotDisturb(on) {
    controls?.update({ doNotDisturb: !!on });
}

function broadcastPrefs() {
    for (const pet of pets.values()) sendPrefs(pet);
}

function rememberOpen(agentId, open) {
    if (!controls) return;
    const current = controls.get().openAgents.filter((id) => id !== agentId);
    controls.update(open ? { openAgents: [...current, agentId], lastAgent: agentId } : { openAgents: current });
}

/** 快捷键「显示/隐藏桌宠」：有露着的就全部收起；都收着就全部叫回来；一个都没开就打开上次那个。 */
async function toggleAllPets() {
    const live = [...pets.values()].filter((pet) => !pet.win.isDestroyed());
    const visible = live.filter((pet) => pet.win.isVisible());
    if (visible.length) {
        for (const pet of visible) pet.win.hide();
        for (const pet of live) pet.yielded = false;
    } else if (live.length) {
        for (const pet of live) showPet(pet);
    } else {
        const settings = controls?.get();
        let candidates = [...new Set([...(settings?.openAgents || []), settings?.lastAgent].filter(Boolean))];
        // 第一次按：还没开过桌宠。有叫 Nova 的助手就请出内置 Nova；没有就打开设置页的桌宠分区，告诉 TA 从哪开始
        if (!candidates.length) {
            const nova = (await listAgents()).find((agent) => agent.name.trim().toLowerCase() === 'nova');
            if (nova) candidates = [nova.id];
        }
        for (const agentId of candidates.slice(0, 1)) await openPet(agentId);
        if (!pets.size) openSettingsPage();
    }
    for (const pet of live) notifyMain(pet.agentId);
    refreshTray();
}

/** 快捷键「和桌宠说话」：叫出最近用过的那个桌宠并打开输入框；输入框已经开着就收起。
 *  语音那个键（voice）：开始录音；正在录就停下、识别完直接发。 */
async function talkToPet({ voice = false } = {}) {
    let pet = (lastTouched && pets.get(lastTouched)) || [...pets.values()].find((p) => !p.win.isDestroyed() && p.win.isVisible())
        || [...pets.values()].find((p) => !p.win.isDestroyed());
    if (!pet) {
        await toggleAllPets();
        pet = [...pets.values()][0];
        if (!pet) return;
    }
    if (!pet.win.isVisible()) {
        showPet(pet);
        notifyMain(pet.agentId);
    }
    lastTouched = pet.agentId;
    openInput(pet, voice ? { voice: true } : { toggle: true });
}

// 刚打开的桌宠页面还没准备好（形象还在载入）时先记着，页面报 ready 以后再弹输入框
function openInput(pet, options) {
    if (pet.win.isDestroyed()) return;
    stopWalk(pet);
    if (pet.ready) pet.win.webContents.send('deskpet:open-input', options);
    else pet.pendingToggle = options;
}

// 等桌宠页面准备好：页面报 ready 就交出去；页面启动失败、窗口关了或等太久都按失败算
const PAGE_READY_TIMEOUT_MS = 20000;
function whenPageReady(pet) {
    if (pet.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: setTimeout(() => settleReady(pet, new Error('桌宠还没准备好')), PAGE_READY_TIMEOUT_MS) };
        pet.readyWaiters.push(waiter);
    });
}

function settleReady(pet, error = null) {
    const waiters = pet.readyWaiters.splice(0);
    for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        if (error) waiter.reject(error);
        else waiter.resolve();
    }
}

/** 设置页预览里输入的话：叫出这个助手的桌宠（没开就打开），由桌宠发出去，回复显示在桌宠头上。 */
async function talkFromSettings(agentId, text, { newTopic = false } = {}) {
    if (!pets.has(agentId)) {
        const opened = await openPet(agentId);
        if (!opened?.success) return { success: false, error: '桌宠打不开' };
    }
    const pet = pets.get(agentId);
    if (!pet || pet.win.isDestroyed()) return { success: false, error: '桌宠打不开' };
    if (!pet.win.isVisible()) showPet(pet);
    lastTouched = agentId;
    notifyMain(agentId);
    // 交到桌宠页面手里才算发出：页面没起来（启动失败、被关）就照实告诉设置页
    try {
        await whenPageReady(pet);
    } catch (error) {
        return { success: false, error: error.message };
    }
    if (pet.win.isDestroyed()) return { success: false, error: '桌宠已经关了' };
    pet.win.webContents.send('deskpet:open-input', { submit: text, newTopic });
    return { success: true };
}

/** 设置页的「显示 / 隐藏桌宠」。显示时一个都没开就打开设置页里正在看的那个助手。 */
async function setPetsVisible(visible, agentId) {
    const live = [...pets.values()].filter((pet) => !pet.win.isDestroyed());
    if (!visible) {
        for (const pet of live) {
            pet.yielded = false;
            if (pet.win.isVisible()) pet.win.hide();
        }
    } else if (live.length) {
        for (const pet of live) showPet(pet);
    } else if (agentId && isAgentId(agentId)) {
        await openPet(agentId);
    } else {
        await toggleAllPets();
    }
    for (const pet of live) notifyMain(pet.agentId);
    refreshTray();
}

function listPetsForSettings() {
    return [...pets.values()].filter((pet) => !pet.win.isDestroyed()).map((pet) => ({
        agentId: pet.agentId,
        name: pet.name || pet.agentId,
        scale: pet.scale,
        maxScale: petPrefs.maxScaleForWorkArea(workAreaAt(pet.win.getBounds()), pet.aspect),
        visible: pet.win.isVisible(),
        outfit: pet.outfit,
        outfits: pet.outfits || [],
    }));
}

function outfitMenu(pet, outfits) {
    return outfits.map((outfit) => ({
        label: outfitStore.outfitLabel(outfit),
        type: 'radio',
        checked: outfit.id === pet.outfit,
        click: () => setPetOutfit(pet.agentId, outfit.id).catch((error) => console.warn('[DeskPet] outfit switch failed:', error.message)),
    }));
}

// 角色淡一点，后面的字能透出来；气泡和输入框不变
function opacityMenu() {
    const current = controls?.get().opacity ?? 1;
    return [1, 0.8, 0.6, 0.4].map((value) => ({
        label: value === 1 ? '不透明' : `${Math.round(value * 100)}%`,
        type: 'radio',
        checked: Math.abs(current - value) < 0.001,
        click: () => controls?.update({ opacity: value }),
    }));
}

function scaleMenu(pet) {
    const presets = [0.8, 1, 1.25, 1.5, 2, 2.5];
    const max = petPrefs.maxScaleForWorkArea(workAreaAt(pet.win.getBounds()), pet.aspect);
    const shortcut = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
    return [
        { label: `放大（${shortcut}+滚轮）`, enabled: pet.scale < max, click: () => stepPetScale(pet.agentId, 1) },
        { label: '缩小', enabled: pet.scale > petPrefs.SCALE_MIN, click: () => stepPetScale(pet.agentId, -1) },
        { type: 'separator' },
        ...presets.map((value) => ({
            label: `${Math.round(value * 100)}%`,
            type: 'radio',
            checked: Math.abs(pet.scale - value) < 0.001,
            enabled: value <= max,
            click: () => setPetScale(pet.agentId, value),
        })),
    ];
}

/** 托盘菜单里的「桌宠」一项（main.js 建托盘菜单时调用）。 */
function trayMenuItems() {
    if (!controls) return [];
    const settings = controls.get();
    const live = [...pets.values()].filter((pet) => !pet.win.isDestroyed());
    const anyVisible = live.some((pet) => pet.win.isVisible());
    // 只显示快捷键，不在菜单里再注册一次（全局快捷键已经注册过了）
    const shortcut = (id) => (settings.shortcuts[id] ? { accelerator: settings.shortcuts[id], registerAccelerator: false } : {});
    const toggle = () => toggleAllPets().catch(() => {});
    // 显示 / 隐藏是两项轮流露出来，开关桌宠时只改 visible，不用换文字重建菜单
    return [{
        label: '桌宠',
        submenu: [
            { id: 'deskpet-hide', label: '隐藏桌宠', ...shortcut('toggle'), visible: anyVisible, click: toggle },
            { id: 'deskpet-show', label: '显示桌宠', ...shortcut('toggle'), visible: !anyVisible, click: toggle },
            { id: 'deskpet-talk', label: '和桌宠说话', ...shortcut('talk'), click: () => talkToPet().catch(() => {}) },
            { type: 'separator' },
            { id: 'deskpet-dnd', label: '免打扰', type: 'checkbox', checked: settings.doNotDisturb, click: (item) => setDoNotDisturb(item.checked) },
            { id: 'deskpet-click-through', label: '只看不点（鼠标穿透）', type: 'checkbox', checked: settings.clickThrough, ...shortcut('clickThrough'), click: (item) => setClickThrough(item.checked) },
            { label: '桌宠设置…', click: () => controls.openSettings() },
        ],
    }];
}

// 启动时打开上次开着的桌宠（设置里可以关掉）。
function restoreOpenPets() {
    const settings = controls?.get();
    if (!settings?.restoreOnLaunch || !settings.openAgents.length) return;
    (async () => {
        for (const agentId of settings.openAgents) {
            if (shuttingDown || !mainWindow || mainWindow.isDestroyed()) return;
            const result = await openPet(agentId).catch(() => null);
            // 助手被删掉了：从恢复列表里拿掉
            if (!result?.success) rememberOpen(agentId, false);
        }
    })();
}

function openMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

// ---- 主动搭话：AI 主动开的新话题、闹钟到点 ---------------------------------------
// 这两样原本只在主窗口话题列表里冒个未读、或者弹一个独立的闹钟小窗；桌宠开着时让角色自己说出来。

const ALARM_MAX_DELAY_MS = 7 * 24 * 3600 * 1000;
const MAX_ALARMS = 50;

function proactive(agentId, payload) {
    const pet = pets.get(agentId);
    if (!pet || pet.win.isDestroyed()) return false;
    // 闹钟要叫得醒人：藏起来的桌宠也出来；新话题不打扰藏起来的桌宠，免打扰时也不说。
    if (payload.kind === 'alarm') showPet(pet);
    else if (!pet.win.isVisible() || controls?.get().doNotDisturb) return false;
    pet.win.webContents.send('deskpet:proactive', payload);
    return true;
}

async function agentIdByName(name) {
    if (!name) return null;
    const wanted = String(name).trim().toLowerCase();
    const agents = await listAgents().catch(() => []);
    const open = agents.filter((agent) => pets.has(agent.id));
    return open.find((agent) => agent.name.toLowerCase() === wanted || agent.id.toLowerCase() === wanted)?.id || null;
}

// 闹钟交给谁：设闹钟时说了是谁（maid）就找那个 agent 的桌宠；否则最近在聊的那个；再不行任意一个开着的。
async function alarmTarget(maid) {
    const named = await agentIdByName(maid);
    if (named) return named;
    if (lastTalkedAgentId && pets.has(lastTalkedAgentId)) return lastTalkedAgentId;
    return visibleAgents()[0] || [...pets.keys()][0] || null;
}

// ---- 工具审批 ---------------------------------------------------------------------
// 服务器要人点头的工具调用，主窗口判完自动允许规则后仍待批的，转给发起它的助手的桌宠一份。
// 应答仍由主窗口发出（它管着去重、过期和理由框），桌宠只是另一个按钮；谁先答都算，答完两边都收起。

const MAX_PENDING_APPROVALS = 50;
const pendingApprovals = new Map(); // requestId → { agentId, payload }

async function offerApproval(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const requestId = typeof raw.requestId === 'string' || typeof raw.requestId === 'number' ? String(raw.requestId) : '';
    if (!requestId || pendingApprovals.has(requestId)) return false;
    const ttl = Number(raw.expiresInMs);
    if (raw.expiresInMs != null && Number.isFinite(ttl) && ttl <= 0) return false;
    const payload = {
        requestId,
        toolName: String(raw.toolName || '').slice(0, 120),
        command: String(raw.command ?? '').slice(0, 2000),
        expiresAt: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl : null,
    };
    // 查助手目录前先占位：查询期间主窗口可能已经应答，也可能重放同一请求。
    // 过期时间从收到请求起算，不能被慢查询延长。
    const entry = { agentId: null, payload };
    pendingApprovals.set(requestId, entry);
    if (pendingApprovals.size > MAX_PENDING_APPROVALS) settleApproval(pendingApprovals.keys().next().value);
    try {
        // 认得出是谁要的就给谁；认不出（没写 maid、名字对不上）就给最近在聊的那个
        const agentId = (await agentIdByName(raw.maid)) || (lastTalkedAgentId && pets.has(lastTalkedAgentId) ? lastTalkedAgentId : null);
        if (pendingApprovals.get(requestId) !== entry) return false;
        if (payload.expiresAt !== null && payload.expiresAt <= Date.now()) return false;
        const pet = agentId && pets.get(agentId);
        if (!pet || pet.win.isDestroyed() || shuttingDown) return false;
        entry.agentId = agentId;
        if (pet.ready) pet.win.webContents.send('deskpet:approval', payload);
        return true;
    } finally {
        if (!entry.agentId && pendingApprovals.get(requestId) === entry) pendingApprovals.delete(requestId);
    }
}

function settleApproval(requestId) {
    const entry = pendingApprovals.get(String(requestId));
    if (!entry) return false;
    pendingApprovals.delete(String(requestId));
    const pet = pets.get(entry.agentId);
    if (pet && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:approval-clear', String(requestId));
    return true;
}

// 页面重载（换装、崩溃恢复）后把还在等的审批再给它
function resendApprovals(pet) {
    const now = Date.now();
    for (const [requestId, entry] of pendingApprovals) {
        if (entry.payload.expiresAt && entry.payload.expiresAt <= now) pendingApprovals.delete(requestId);
        else if (entry.agentId === pet.agentId) pet.win.webContents.send('deskpet:approval', entry.payload);
    }
}

function parsePluginOutput(result) {
    if (result && typeof result === 'object') return result;
    const text = String(result || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// 角色写在第一句话里的情绪标签（<!--emo:…-->）和心流锁这类 [[…::…]] 控制标记不念出来
function spokenText(value) {
    return String(value || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\[\[[A-Za-z]+::[^\]\n]*\]\]/g, '').trim();
}

// 同一个闹钟的结果回来两次（请求重放）时只记一个：提醒相同、到点时间差不到一分钟
const ALARM_SAME_MS = 60 * 1000;

function scheduleAlarm({ dueAt, text, maid }) {
    const delay = dueAt - Date.now();
    if (!Number.isFinite(delay) || delay < 0 || delay > ALARM_MAX_DELAY_MS || alarms.size >= MAX_ALARMS) return null;
    for (const alarm of alarms.values()) {
        if (alarm.text === text && alarm.maid === maid && Math.abs(alarm.dueAt - dueAt) < ALARM_SAME_MS) return null;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(async () => {
        alarms.delete(id);
        const agentId = await alarmTarget(maid);
        if (agentId) proactive(agentId, { kind: 'alarm', text: text || '时间到了！', at: dueAt });
    }, delay);
    timer.unref?.();
    alarms.set(id, { timer, dueAt, text, maid });
    return id;
}

/** 分布式服务器每执行完一个工具调用就告诉这里一声（只看结果，不改结果）。 */
function onDistributedToolResult(toolName, toolArgs = {}, result) {
    if (!initialized) return;
    if (toolName === 'TopicSponsor' && ['CreateTopic', 'CreateFlowlockTopic'].includes(toolArgs?.command)) {
        const info = parsePluginOutput(result);
        if (!info?.agent_id || !info.topic_id || announcedTopics.has(info.topic_id)) return;
        announcedTopics.add(info.topic_id);
        if (announcedTopics.size > 200) announcedTopics.delete(announcedTopics.values().next().value);
        proactive(info.agent_id, {
            kind: 'topic',
            title: String(info.topic_name || ''),
            text: spokenText(info.initial_message),
            topicId: String(info.topic_id),
        });
    } else if (toolName === 'VCPAlarm') {
        const info = parsePluginOutput(result);
        if (info?.status !== 'success' || !Number.isFinite(info.due_at)) return;
        scheduleAlarm({ dueAt: info.due_at, text: spokenText(info.reminder_text || toolArgs?.reminder_text), maid: toolArgs?.maid });
    }
}

// 点桌宠说的新话题：打开主窗口并切到那个话题（由主窗口按正常流程选中）。
// 话题可能在气泡还挂着时被删掉了：主窗口选中一个不存在的话题后，接着说的话会存进一份话题列表里看不到的历史，
// 所以先确认它还在这个助手的配置里。
async function openTopic(agentId, topicId) {
    openMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || !isAgentId(agentId) || typeof topicId !== 'string' || !topicId) return false;
    let topics = [];
    try {
        topics = (await fs.readJson(path.join(paths.agentDir, agentId, 'config.json')))?.topics;
    } catch { /* 读不到配置就当话题不在了 */ }
    if (!Array.isArray(topics) || !topics.some((topic) => String(topic?.id) === topicId)) return false;
    if (mainWindow.isDestroyed()) return false;
    mainWindow.webContents.send('deskpet:open-topic', { agentId, topicId });
    return true;
}

// ---- 闲时主动搭话（时机和流程在 modules/deskpet/idleRunner.js）-----------------------

const WHERE_TIMEOUT_MS = 1500;

function systemAway() {
    try {
        const idleSec = electron.powerMonitor?.getSystemIdleTime?.() ?? 0;
        const lockState = electron.powerMonitor?.getSystemIdleState?.(idleChat.AWAY_AFTER_SEC);
        return { idleSec, locked: lockState === 'locked' };
    } catch {
        return { idleSec: 0, locked: false };
    }
}

// 主窗口现在开着哪个助手的哪个话题：开着「桌宠闲聊」时不往里写（主窗口手里的那份历史会盖掉这一句）
function mainWhere() {
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
    const ask = (requestId) => mainWindow.webContents.send('deskpet:where-request', { requestId });
    return askMain(pendingWhere, ask, {
        timeoutMs: WHERE_TIMEOUT_MS,
        timedOut: null,
        answer: (where) => (where && typeof where === 'object' ? where : null),
    });
}

function idleCandidates() {
    const visible = visibleAgents().filter((id) => {
        const pet = pets.get(id);
        return pet && !pet.win.isDestroyed() && pet.win.isVisible();
    });
    if (lastTalkedAgentId && visible.includes(lastTalkedAgentId)) return [lastTalkedAgentId, ...visible.filter((id) => id !== lastTalkedAgentId)];
    return visible;
}

// ---- 持续心情 ----------------------------------------------------------------

const MOOD_LABEL = {
    neutral: '🙂 平静', calm: '😌 放松', happy: '😊 开心', excited: '🤩 兴奋', shy: '😳 害羞', affectionate: '🥰 温柔',
    curious: '🤔 好奇', surprised: '😮 惊讶', concerned: '😟 担心', sad: '😢 难过', tired: '😪 疲惫', angry: '😠 生气',
};

async function readMood(agentId) {
    try {
        return (await getAgentMoodStore()?.get(agentId)) ?? null;
    } catch (_error) {
        return null;
    }
}

function moodMenuLabel(mood) {
    const label = MOOD_LABEL[mood?.emotion] || MOOD_LABEL.neutral;
    if (!mood || mood.emotion === 'neutral') return `现在的心情：${label}`;
    const degree = mood.intensity >= 0.6 ? '很' : mood.intensity >= 0.35 ? '' : '有点';
    return `现在的心情：${label.replace(' ', ` ${degree}`)}`;
}

// ---- IPC ----------------------------------------------------------------

function registerIpc() {
    ipcMain.handle('deskpet:toggle', async (_e, agentId) => {
        if (typeof agentId !== 'string' || !agentId) return { success: false, error: 'invalid-agent' };
        const pet = pets.get(agentId);
        // 隐藏着的桌宠：再点一次是叫回来，不是关掉。
        const result = await (pet && pet.win.isVisible() ? closePet(agentId) : openPet(agentId));
        refreshTray();
        return { ...result, openAgents: visibleAgents() };
    });
    ipcMain.handle('deskpet:get-open-agents', () => visibleAgents());
    ipcMain.on('deskpet:send-result', (_e, payload) => {
        pendingSends.get(payload?.requestId)?.(payload?.result);
    });
    ipcMain.on('deskpet:where-result', (event, payload) => {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
        pendingWhere.get(payload?.requestId)?.(payload?.where);
    });

    ipcMain.handle('deskpet:get-assets', async (event) => {
        const pet = petFromEvent(event);
        if (!pet) {
            // 设置页卡片的快照：离屏窗口按指定的那套形象画一次
            const job = previews?.jobFor(event.sender);
            return job ? { ...(await resolveAssets(job.agentId, job.outfitId)), preview: true } : null;
        }
        const wanted = pet.outfit;
        const assets = await resolveAssets(pet.agentId, wanted);
        pet.name = assets.name;
        pet.outfits = assets.outfits;
        // 记着的那套已经删了：换成实际显示的这套。等待期间又换了装（连点卡片）就别把新选的盖回去
        if (pet.outfit === wanted) pet.outfit = assets.outfit?.id || null;
        return assets;
    });
    ipcMain.on('deskpet:preview-ready', (event, report) => {
        previews?.ready(event.sender, report && typeof report === 'object' ? report : null);
    });
    // 页面准备好了（形象载完、输入框能用了）：补上等着的输入框
    ipcMain.on('deskpet:page-ready', (event) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        pet.ready = true;
        // 藏着的时候重载（换装、崩溃恢复）：新页面默认在跑，告诉它停下
        if (!pet.win.isDestroyed() && !pet.win.isVisible()) pet.win.webContents.send('deskpet:visibility', false);
        const pending = pet.pendingToggle;
        pet.pendingToggle = null;
        if (pending) openInput(pet, pending);
        resendApprovals(pet);
        settleReady(pet);
    });
    // 页面启动失败：等着交给它的话不再等
    ipcMain.on('deskpet:page-failed', (event, message) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        settleReady(pet, new Error(`桌宠启动失败：${typeof message === 'string' && message ? message : '未知原因'}`));
    });
    // 页面量出了形象的长宽比：按它改窗口（全身像高、Q 版矮），记下来下次直接用
    ipcMain.on('deskpet:figure', (event, report) => {
        const pet = petFromEvent(event);
        if (pet && report && typeof report === 'object') {
            onFigureMeasured(pet, report).catch((error) => console.warn('[DeskPet] figure:', error.message));
        }
    });
    ipcMain.handle('deskpet:get-prefs', (event) => {
        const pet = petFromEvent(event);
        return pet ? prefsFor(pet) : null;
    });
    // 在角色上按住 Ctrl 滚滚轮调大小；deltaY 按像素给，攒够一格再变
    ipcMain.on('deskpet:wheel-resize', (event, deltaY) => {
        const pet = petFromEvent(event);
        const delta = Number(deltaY);
        if (!pet || !Number.isFinite(delta) || pet.drag) return;
        pet.wheel = (Math.sign(pet.wheel) === Math.sign(delta) ? pet.wheel : 0) + delta;
        if (Math.abs(pet.wheel) < WHEEL_NOTCH) return;
        // 往上滚（deltaY < 0）是放大
        stepPetScale(pet.agentId, -Math.sign(pet.wheel));
        pet.wheel = 0;
    });
    ipcMain.on('deskpet:touched', (event) => {
        const pet = petFromEvent(event);
        if (pet) lastTouched = pet.agentId;
    });
    // 这个助手的持续心情（modules/agentMood.js，和侧栏立绘同一份）：待机时显示它，之后跟着 agent-mood-changed 更新
    ipcMain.handle('deskpet:get-mood', async (event) => {
        const pet = petFromEvent(event);
        return pet ? readMood(pet.agentId) : null;
    });
    ipcMain.handle('deskpet:send', async (event, text, options) => {
        const pet = petFromEvent(event);
        const message = typeof text === 'string' ? text.trim() : '';
        const attached = cleanSendFiles(options?.files);
        if (!pet || (!message && !attached.length)) return { success: false, error: '没有内容' };
        if (attached.some((f) => f.path)) {
            const problem = await checkDroppedFiles(attached);
            if (problem) return { success: false, error: problem };
        }
        stopWalk(pet);
        return sendFromPet(pet.agentId, message.slice(0, 8000), { files: attached, newTopic: options?.newTopic === true });
    });
    // 输入框打开时整窗可点、可聚焦；关上后回到按像素穿透。
    ipcMain.on('deskpet:set-interactive', (event, on) => {
        const pet = petFromEvent(event);
        if (!pet || pet.win.isDestroyed()) return;
        pet.interactive = !!on;
        applyClickThrough(pet);
        if (on) {
            if (!USE_SHAPE) setIgnoreMouse(pet, false);
            pet.win.setFocusable(true);
            pet.win.focus();
        } else {
            // 输入框收起：先回到整窗穿透，页面下一次命中会重新报上来（光标不在角色上时不会再报，
            // 不回到穿透的话整块透明窗口会一直挡着下面的点击）
            if (!USE_SHAPE) {
                pet.ignoringMouse = null;
                setIgnoreMouse(pet, true);
            }
            applyClickThrough(pet);
            // 回到不抢焦点的状态，之后点宠物也不会把正在打字的程序挤到后面
            if (!PET_FOCUSABLE) pet.win.setFocusable(false);
        }
    });
    ipcMain.on('deskpet:open-main', () => openMainWindow());
    // 工具审批：主窗口转来、主窗口说答完了；桌宠上点了允许/拒绝交回主窗口
    ipcMain.on('deskpet:approval-offer', (event, payload) => {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
        offerApproval(payload).catch((error) => console.warn('[DeskPet] approval offer failed:', error?.message || error));
    });
    ipcMain.on('deskpet:approval-settled', (event, requestId) => {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
        settleApproval(requestId);
    });
    ipcMain.on('deskpet:approval-answer', (event, answer) => {
        const pet = petFromEvent(event);
        const requestId = String(answer?.requestId || '');
        const entry = pendingApprovals.get(requestId);
        if (!pet || entry?.agentId !== pet.agentId) return;
        if (entry.payload.expiresAt !== null && entry.payload.expiresAt <= Date.now()) {
            settleApproval(requestId);
            return;
        }
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('deskpet:approval-answer', { requestId, approved: answer?.approved === true });
    });
    // 桌宠上点了停止：交给主窗口按它的中止流程停掉那条回复
    ipcMain.on('deskpet:interrupt', (event, messageId) => {
        const pet = petFromEvent(event);
        if (!pet || typeof messageId !== 'string' || !messageId || messageId.length > 200) return;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('deskpet:interrupt-request', { agentId: pet.agentId, messageId });
    });
    // 多久没碰键盘鼠标了（秒）：回复说完时人在不在
    ipcMain.handle('deskpet:idle-seconds', () => {
        try { return electron.powerMonitor?.getSystemIdleTime?.() ?? 0; } catch { return 0; }
    });
    ipcMain.on('deskpet:open-topic', (event, topicId) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        openTopic(pet.agentId, topicId).then((opened) => {
            if (!opened && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:topic-missing');
        }).catch((error) => console.warn('[DeskPet] open topic failed:', error.message));
    });
    ipcMain.on('deskpet:hit', (event, hit) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        if (hit) stopWalk(pet);
        setIgnoreMouse(pet, !hit);
    });
    // 藏在边里时：页面说现在要不要探出来（鼠标在角色上、气泡或输入框开着）
    ipcMain.on('deskpet:want-out', (event, want) => {
        const pet = petFromEvent(event);
        if (pet) setWantOut(pet, want === true);
    });
    ipcMain.on('deskpet:content-bounds', (event, rect) => {
        const pet = petFromEvent(event);
        if (!USE_SHAPE || !pet || pet.win.isDestroyed() || !rect || pet.ignoringMouse === 'through') return;
        const [w, h] = pet.win.getContentSize();
        const x = Math.max(0, Math.floor(rect.x));
        const y = Math.max(0, Math.floor(rect.y));
        const shape = { x, y, width: Math.min(w - x, Math.ceil(rect.width)), height: Math.min(h - y, Math.ceil(rect.height)) };
        const key = JSON.stringify(shape);
        if (key === pet.lastShape || shape.width <= 0 || shape.height <= 0) return;
        pet.lastShape = key;
        pet.win.setShape([shape]);
    });

    // 拖动在主进程里跟随光标，不用 -webkit-app-region：它在 Windows 上会吞点击，
    // 也没法和按像素穿透同时用。origin 是按下那一刻的屏幕坐标。
    ipcMain.on('deskpet:drag-start', (event, origin) => {
        const pet = petFromEvent(event);
        if (!pet || pet.win.isDestroyed()) return;
        // 上一次拖动的 pointerup 丢了（触屏 pointercancel、拖动中弹出菜单）时还会再来一次 drag-start；
        // 先收掉旧的定时器，否则它会一直跟着光标，drag-end 之后还会每帧抛异常。
        stopDrag(pet);
        stopSnap(pet);
        // 拿起来了：藏边的状态作废，松手时重新算
        clearTimeout(pet.tuckTimer);
        pet.tuck = null;
        stopWalk(pet, { save: false });
        const p = origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) ? origin : screen.getCursorScreenPoint();
        const [wx, wy] = pet.win.getPosition();
        const drag = { dx: p.x - wx, dy: p.y - wy, timer: null, startedAt: Date.now() };
        drag.timer = setInterval(() => {
            if (pet.win.isDestroyed() || pet.drag !== drag) {
                clearInterval(drag.timer);
                return;
            }
            // 兜底：页面再也没发 drag-end（渲染进程卡死），不让窗口永远粘在光标上。
            if (Date.now() - drag.startedAt > DRAG_MAX_MS) {
                stopDrag(pet, { save: true });
                return;
            }
            moveWithCursor(pet, drag);
        }, DRAG_TICK_MS);
        pet.drag = drag;
    });
    ipcMain.on('deskpet:drag-end', (event, report) => {
        const pet = petFromEvent(event);
        if (!pet?.drag || pet.win.isDestroyed()) return;
        moveWithCursor(pet, pet.drag);
        const samples = pet.drag.samples;
        stopDrag(pet, { save: true });
        const figure = figureFrom(report);
        const free = report?.free === true;
        // 拖出屏幕边一大截松手是想藏起来，不当成甩
        const win = pet.win.getBounds();
        const tucking = figure && edgeSnap.tuckPosition(win, figure, workAreaAt(win), (side, y) => isOuterEdge(workAreaAt(win), side, y));
        if (!free && figure && !tucking && throwPet(pet, figure, samples)) return;
        snapToEdge(pet, figure, { free });
    });

    // 页面闲了一阵：figure 是角色在窗口里的包围盒；stop 是页面那边有了动静
    ipcMain.on('deskpet:wander', (event, report) => {
        const pet = petFromEvent(event);
        if (!pet || pet.win.isDestroyed()) return;
        if (report?.stop === true) {
            stopWalk(pet);
            return;
        }
        const figure = figureFrom(report);
        if (figure) startWalk(pet, figure);
    });

    ipcMain.on('deskpet:context-menu', async (event) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        stopWalk(pet);
        const [agents, mood, voiceItem, outfits] = await Promise.all([
            listAgents().catch(() => []), readMood(pet.agentId), voice.menuItem(pet), listAgentOutfits(pet.agentId).catch(() => []),
        ]);
        // 读助手列表期间桌宠可能已经被关掉了。
        if (pet.win.isDestroyed()) return;
        pet.outfits = outfits.map(outfitSummary);
        Menu.buildFromTemplate([
            { label: moodMenuLabel(mood), enabled: false },
            { type: 'separator' },
            { label: '和 TA 说话', click: () => openInput(pet, {}) },
            {
                label: '切换助手',
                enabled: agents.length > 1,
                submenu: agents.map((agent) => ({
                    label: agent.label,
                    type: 'radio',
                    checked: agent.id === pet.agentId,
                    click: () => switchPet(pet.agentId, agent.id).catch((error) => console.warn('[DeskPet] switch failed:', error.message)),
                })),
            },
            { label: '换装', enabled: outfits.length > 1, submenu: outfitMenu(pet, outfits) },
            voiceItem,
            { label: '打开主窗口', click: openMainWindow },
            { type: 'separator' },
            { label: '大小', submenu: scaleMenu(pet) },
            { label: '透明度', submenu: opacityMenu() },
            {
                label: '免打扰',
                type: 'checkbox',
                checked: controls?.get().doNotDisturb === true,
                click: (item) => setDoNotDisturb(item.checked),
            },
            {
                label: '在桌面上溜达',
                type: 'checkbox',
                checked: controls?.get().wander === true,
                click: (item) => controls?.update({ wander: item.checked }),
            },
            // 打开后点不到桌宠了：从托盘或快捷键关
            { label: '只看不点（鼠标穿透）', click: () => setClickThrough(true) },
            { label: '桌宠设置…', click: () => controls?.openSettings() },
            { type: 'separator' },
            {
                label: '隐藏桌宠',
                click: () => {
                    if (pet.win.isDestroyed()) return;
                    pet.yielded = false;
                    pet.win.hide();
                    notifyMain(pet.agentId);
                    refreshTray();
                },
            },
            { label: '关闭桌宠', click: () => closePet(pet.agentId) },
        ]).popup({ window: pet.win });
    });
}

function initialize(options) {
    if (initialized) return;
    initialized = true;
    mainWindow = options.mainWindow || null;
    paths = {
        projectRoot: options.projectRoot,
        appDataRoot: options.appDataRoot,
        agentDir: options.agentDir,
    };
    assets = createPetAssets({ paths, stagedCorePath: () => coreInstaller?.stagedPath });
    stateStore = createPetStateStore({ file: path.join(paths.appDataRoot, 'deskpet', 'state.json') });
    services = {
        readSettings: typeof options.readSettings === 'function' ? options.readSettings : null,
        historyQueue: typeof options.historyQueue === 'function' ? options.historyQueue : null,
        agentOps: typeof options.agentOps === 'function' ? options.agentOps : null,
    };
    idle = createIdleRunner({
        settings: () => controls?.get() || petPrefs.DEFAULT_SETTINGS,
        services,
        candidates: idleCandidates,
        isShowing: (agentId) => {
            const pet = pets.get(agentId);
            return Boolean(pet && !pet.win.isDestroyed() && pet.win.isVisible());
        },
        systemAway,
        mainWhere,
        promptAppend: getSystemPromptAppend,
        speak: proactive,
        isShuttingDown: () => shuttingDown,
    });
    registerProtocol();
    registerIpc();
    voice.initialize({ paths, findPet: petFromEvent });
    controls = createPetControls({
        electron,
        appDataRoot: paths.appDataRoot,
        actions: {
            toggleAll: () => toggleAllPets().catch((error) => console.warn('[DeskPet] toggle failed:', error.message)),
            talk: () => talkToPet().catch((error) => console.warn('[DeskPet] talk failed:', error.message)),
            voice: () => talkToPet({ voice: true }).catch((error) => console.warn('[DeskPet] voice failed:', error.message)),
            listPets: listPetsForSettings,
            setScale: (agentId, scale) => setPetScale(agentId, scale),
            sendToSettings: settingsPush.changed,
            openSettingsPage,
            isSettingsSender: (sender) => Boolean(sender && mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents),
        },
    });
    controls.registerIpc();
    previews = createPetPreviews({
        BrowserWindow,
        cacheRoot: path.join(paths.appDataRoot, 'deskpet', 'previews'),
        preload: path.join(paths.projectRoot, 'preloads', 'deskpet.js'),
        pageUrl: (agentId) => assets.pageUrl(agentId, '&preview=1'),
        // 卡片快照按 2 倍画：比桌面上默认的大，缩进卡片里也清楚
        windowSize: (aspect) => petPrefs.windowSizeForScale(2, aspect),
    });
    coreInstaller = createCoreInstaller({ appDataRoot: paths.appDataRoot, fetch: (url, init) => net.fetch(url, init), probe: probeCore });
    createSettingsPage({
        electron,
        paths,
        controls,
        previews,
        core: {
            status: () => coreInstaller.status(),
            installOfficial: () => coreInstaller.installOfficial(settingsPush.coreProgress),
            installFromFile: (file) => coreInstaller.installFromFile(file),
            afterInstall: reloadLive2DPets,
        },
        pets: {
            listAgents,
            listOutfits: listAgentOutfits,
            readState: async (agentId) => (await readPetState())[agentId] || null,
            saveState: savePetState,
            isAgentId,
            info: (agentId) => listPetsForSettings().find((p) => p.agentId === agentId) || null,
            openAgents: visibleAgents,
            lastTouched: () => lastTouched,
            openPet,
            closePet: (agentId) => { closePet(agentId); refreshTray(); },
            showPet: (agentId) => { const pet = pets.get(agentId); if (pet && !pet.win.isDestroyed()) { showPet(pet); notifyMain(agentId); } },
            setOutfit: setPetOutfit,
            pushProfile: (agentId, payload) => {
                const pet = pets.get(agentId);
                if (!pet || pet.win.isDestroyed() || !pet.ready) return false;
                pet.win.webContents.send('deskpet:profile', payload);
                if (payload?.emotion || payload?.tap) showPet(pet);
                return true;
            },
            setVisible: setPetsVisible,
            talk: talkFromSettings,
            mainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
            sendPreview: settingsPush.preview,
        },
    }).registerIpc();
    // 主窗口刷新时设置页没了：录快捷键录到一半暂停的全局快捷键要恢复
    mainWindow?.webContents?.on?.('did-start-loading', () => controls?.pauseShortcuts(false));
    fullscreenWatch = createFullscreenWatch({ onChange: applyFullscreen });
    controls.onChange((_settings, changed) => {
        if (changed.some((key) => PAGE_PREF_KEYS.includes(key))) broadcastPrefs();
        if (changed.includes('hideFromCapture')) for (const pet of pets.values()) applyCaptureHiding(pet.win);
        if (changed.includes('wander') && controls.get().wander !== true) for (const pet of pets.values()) stopWalk(pet);
        if (changed.includes('clickThrough')) for (const pet of pets.values()) applyClickThrough(pet);
        if (changed.includes('yieldToFullscreen')) updateFullscreenWatch();
        if (changed.includes('idleChat')) idle.update();
        if (changed.some((key) => TRAY_KEYS.includes(key))) refreshTray();
    });
    const settingsReady = controls.load().then(() => {
        controls.applyShortcuts();
        refreshTray();
        idle.update();
    });
    // 主窗口载完以后再恢复上次的桌宠
    const scheduleRestore = () => settingsReady.then(() => setTimeout(restoreOpenPets, RESTORE_DELAY_MS));
    if (mainWindow?.webContents?.isLoading?.() === false && mainWindow.webContents.getURL?.()) scheduleRestore();
    else mainWindow?.webContents?.once?.('did-finish-load', scheduleRestore);
    screen.on('display-removed', onDisplaysChanged);
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-metrics-changed', onDisplaysChanged);
    // 睡眠唤醒、解锁以后：笔记本可能拔了扩展坞、换了分辨率，置顶也可能被系统取消。和显示器变了一样重新摆一遍
    electron.powerMonitor?.on?.('resume', onDisplaysChanged);
    electron.powerMonitor?.on?.('unlock-screen', onDisplaysChanged);
    import(pathToFileURL(path.join(paths.projectRoot, 'modules', 'emotion', 'emotionPrompt.js')).href)
        .then((mod) => { emotionPrompt = mod; })
        .catch((error) => console.warn('[DeskPet] emotion prompt unavailable:', error.message));
    // 主窗口关掉时桌宠跟着关，否则剩下的透明窗口会让应用无法退出。
    mainWindow?.on?.('closed', closeAll);
    // 退出时（macOS 上 Cmd+Q 会先关桌宠窗口、后关主窗口）桌宠被一起关掉不算用户关的，恢复列表照旧
    electron.app?.on?.('before-quit', () => { shuttingDown = true; });
}

function closeAll() {
    // 退出（或主窗口关掉）时一起关：恢复列表保持原样，下次启动照旧打开
    shuttingDown = true;
    pendingApprovals.clear();
    for (const agentId of [...pets.keys()]) closePet(agentId);
    fullscreenWatch?.stop();
    controls?.dispose();
    previews?.dispose();
    for (const { timer } of alarms.values()) clearTimeout(timer);
    alarms.clear();
    idle?.stop();
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
    registerSchemes,
    initialize,
    closeAll,
    // 托盘：main.js 建菜单时取「桌宠」这一项，并在桌宠状态变了时重建菜单
    trayMenuItems: isolated('trayMenuItems', trayMenuItems, []),
    // 只是勾选、可用、显示变了：改现有菜单（见 modules/deskpet/petTray.js）
    applyTrayState: isolated('applyTrayState', (menu) => petTray.applyTrayState(menu, trayMenuItems()), false),
    setTrayRefresher: (fn) => { refreshTray = typeof fn === 'function' ? isolated('refreshTray', petTray.refreshWhenChanged(trayMenuItems, fn)) : () => {}; },
    getSystemPromptAppend: isolated('getSystemPromptAppend', getSystemPromptAppend, ''),
    appendProtocolToMessages: isolated('appendProtocolToMessages', appendProtocolToMessages, (messages) => messages),
    onRequestStart: isolated('onRequestStart', onRequestStart),
    onStreamPayload: isolated('onStreamPayload', onStreamPayload),
    onFullResponse: isolated('onFullResponse', onFullResponse),
    onDistributedToolResult: isolated('onDistributedToolResult', onDistributedToolResult),
    forgetAgent: (agentId) => Promise.resolve(forgetAgent(agentId)).catch((error) => console.warn('[DeskPet] forget agent failed:', error.message)),
    // 测试用
    _promptReady: () => Boolean(emotionPrompt),
    _applyFullscreen: applyFullscreen,
    _idleTick: (options) => idle.tick(options),
    _idleState: () => idle.states,
    _controls: () => controls,
    _pets: () => pets,
    _pendingApprovals: () => pendingApprovals,
    _resolveServedFile: (url, testPaths) => createPetAssets({ paths: testPaths, stagedCorePath: () => coreInstaller?.stagedPath }).resolveServedFile(url),
};
