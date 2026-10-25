// modules/deskpet/petWindow.js
// 桌宠窗口本身：开窗、关窗、显示隐藏、置顶、按像素穿透和整窗穿透、崩溃后重载、
// 页面准备好的等待，以及助手被删掉时的收尾。

const path = require('path');
const petPrefs = require('./petPrefs');
const outfitStore = require('./outfits');
const { isAgentId } = require('./petAssets');
const { savedAspect, hasSavedPosition } = require('./petState');

const HIT_POLL_MS = 50;
const TOPMOST_GUARD_MS = 10000;
const CRASH_WINDOW_MS = 60 * 1000;
const CRASH_LIMIT = 3;
// 等桌宠页面准备好：页面报 ready 就交出去；页面启动失败、窗口关了或等太久都按失败算
const PAGE_READY_TIMEOUT_MS = 20000;

function createPetWindow(ctx) {
    const { pets } = ctx;
    const { BrowserWindow, screen } = ctx.electron;
    const { TOPMOST_LEVEL, USE_SHAPE, USE_TOPMOST_GUARD } = ctx.platform;

    function showPet(pet) {
        pet.yielded = false;
        ctx.lastTouched = pet.agentId;
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

    function setIgnoreMouse(pet, ignore) {
        // 拎起后轮廓和动作会变；迟到的 alpha=false 不能让窗口丢掉这一次按住的指针。
        if (ignore && pet.drag) return;
        if (USE_SHAPE || pet.win.isDestroyed() || ignore === pet.ignoringMouse || pet.ignoringMouse === 'through') return;
        pet.ignoringMouse = ignore;
        // forward:true 让 Windows/macOS 在穿透时仍把 mousemove 送到页面。
        pet.win.setIgnoreMouseEvents(ignore, { forward: true });
    }

    // 只看不点：整窗穿透且不转发鼠标，页面碰不到悬停、点击和拖动。输入框打开时（快捷键「和桌宠说话」）照常可用，
    // 收起后回到穿透。按像素穿透那套（setIgnoreMouse、Linux 的输入区）在这期间不动窗口。
    function clickThroughOn() {
        return ctx.controls?.get().clickThrough === true;
    }

    // 截图、录屏、共享屏幕时不出现在画面里（Linux 上 Electron 不支持，调用也无害）
    function applyCaptureHiding(win) {
        if (!win || win.isDestroyed()) return;
        try { win.setContentProtection(ctx.controls?.get().hideFromCapture === true); } catch { /* 平台不支持 */ }
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
                ctx.sizing.resetShape(pet);
            } else {
                setIgnoreMouse(pet, true);
            }
        }
    }

    function setClickThrough(on) {
        ctx.controls?.update({ clickThrough: !!on });
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

    // 页面重新载入（崩溃自动重载、刷新）时，页面那边的命中、输入框、拖动状态都清零了，
    // 主进程这边也要回到初始状态：否则上一次的「可点击」会让一块看不见的窗口挡住桌面。
    function resetInputState(pet) {
        ctx.motion.stopDrag(pet, { save: true });
        pet.interactive = false;
        pet.lastShape = '';
        if (pet.win.isDestroyed()) return;
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

    function rememberOpen(agentId, open) {
        if (!ctx.controls) return;
        const current = ctx.controls.get().openAgents.filter((id) => id !== agentId);
        ctx.controls.update(open ? { openAgents: [...current, agentId], lastAgent: agentId } : { openAgents: current });
    }

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

    // anchor：在别的桌宠原来的位置打开（切换助手），按脚底中点对齐。
    async function openPet(agentId, { anchor = null } = {}) {
        const { geometry, motion } = ctx;
        if (pets.has(agentId)) {
            showPet(pets.get(agentId));
            ctx.notifyMain(agentId);
            return { success: true, open: true };
        }
        if (!(await ctx.assets.agentExists(agentId))) {
            return { success: false, error: 'agent-not-found' };
        }
        // 读状态期间同一个助手可能已经被另一次调用打开了（快捷键连按、启动恢复和点按钮撞在一起）
        const saved = (await ctx.readPetState())[agentId];
        // 上次选的那套形象（没选过或已经删了就用默认那套）；量过它的长宽比就直接按它开窗口
        const outfit = outfitStore.pickOutfit(await ctx.listAgentOutfits(agentId).catch(() => []), saved?.outfit);
        if (pets.has(agentId)) return openPet(agentId);
        const outfitId = outfit?.id || null;
        const kind = outfit?.kind;
        const aspect = outfitId ? savedAspect(saved, outfitId) : null;
        // 按桌宠所在的那块屏限制大小（getDisplayMatching 要完整的矩形，只给 x/y 会退回主屏）
        const savedSize = petPrefs.savedScale(saved, kind);
        const savedRect = hasSavedPosition(saved) ? { x: saved.x, y: saved.y, ...petPrefs.windowSizeForScale(savedSize, aspect, kind) } : null;
        const scale = petPrefs.fitScale(savedSize, geometry.workAreaAt(anchor || savedRect || screen.getPrimaryDisplay().workArea), aspect, kind);
        const size = petPrefs.windowSizeForScale(scale, aspect, kind);
        // 旧版记的位置：按脚底对齐换到新尺寸，记下来以后就是新版的了
        const legacy = anchor ? null : petPrefs.legacyPosition(saved, aspect, scale, kind);
        // 旧版记的大小也一起换成新版的记下来：之后记位置会标上新版，旧的大小就不能再留着
        const oldSize = saved?.scale != null && !(Number(saved.sizeVersion) >= petPrefs.SIZE_VERSION);
        if (legacy || oldSize) ctx.savePetState(agentId, { ...(legacy || {}), scale }).catch(() => {});
        const win = new BrowserWindow({
            ...(anchor ? petPrefs.resizeAnchored(anchor, size, geometry.workAreaAt(anchor)) : geometry.initialBounds(legacy ? { ...saved, ...legacy, tuck: null } : saved, size)),
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
            // 窗口必须可聚焦：Windows 上不可聚焦的窗口（WS_EX_NOACTIVATE）被点时，Chromium 回
            // MA_NOACTIVATEANDEAT，按下被吞掉、只收到松开，拖动、单击和胶囊按钮全都失灵（窗口碰巧
            // 还是前台时又正常，所以时好时坏）。macOS 不可聚焦的窗口也收不到点击，Linux 有的窗口管理器直接丢输入。
            // Windows 上用工具窗口：不进任务栏和 Alt+Tab。
            ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
            show: false,
            title: 'VCPChat 桌宠',
            webPreferences: {
                preload: path.join(ctx.paths.projectRoot, 'DeskPetmodules', 'preload.js'),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                // 主窗口最小化时桌宠照常动；空闲降帧和隐藏时暂停由页面自己做。
                backgroundThrottling: false,
            },
        });
        applyCaptureHiding(win);
        const pet = { win, contents: win.webContents, agentId, scale, outfit: outfitId, kind, aspect, ignoringMouse: true, interactive: false, hitPoll: null, drag: null, lastShape: '', wheel: 0, ready: false, pendingToggle: null, readyWaiters: [] };
        // 上次藏在屏幕边里、位置没被挪过：接着藏，鼠标过来照样探出来
        const savedTuck = saved?.tuck;
        if (!anchor && savedTuck?.tucked && savedTuck?.outPos) {
            const [atX, atY] = win.getPosition();
            const area = geometry.workAreaAt(win.getBounds());
            if (savedTuck.tucked.x === atX && savedTuck.tucked.y === atY) {
                if (geometry.isOuterEdge(area, savedTuck.side, atY + win.getBounds().height / 2)) {
                    pet.tuck = { side: savedTuck.side, tucked: savedTuck.tucked, outPos: savedTuck.outPos, isOut: false };
                } else {
                    // 那条边外面现在接了别的屏：不再藏，整只出来
                    win.setPosition(savedTuck.outPos.x, savedTuck.outPos.y);
                    ctx.savePetState(agentId, { x: savedTuck.outPos.x, y: savedTuck.outPos.y, tuck: null }).catch(() => {});
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
            ctx.notifyMain(agentId);
        });
        // 第一次载入时状态本来就是初始值；之后的重载（崩溃恢复、刷新）要把主进程这边也清零。
        win.webContents.on('did-start-loading', () => {
            pet.ready = false;
            resetInputState(pet);
            ctx.voice.release(pet);
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
        win.on('hide', () => { sendVisibility(false); ctx.wake?.visibilityChanged(); });
        win.on('show', () => { sendVisibility(true); ctx.wake?.visibilityChanged(); });
        // 置顶被系统或别的程序取消时（例如别的程序调用了 SetWindowPos），马上补回来
        win.on('always-on-top-changed', (_e, onTop) => {
            if (!onTop && !ctx.shuttingDown) setImmediate(() => reassertTopmost(pet));
        });
        win.on('closed', () => {
            ctx.voice.release(pet);
            clearInterval(pet.hitPoll);
            clearTimeout(pet.tuckTimer);
            clearInterval(pet.walk);
            motion.stopSnap(pet);
            motion.stopDrag(pet);
            settleReady(pet, new Error('桌宠已经关了'));
            ctx.proactive.forgetPetApprovals(agentId);
            pets.delete(agentId);
            ctx.wake?.visibilityChanged();
            updateTopmostGuard();
            ctx.displays.updateFullscreenWatch();
            if (ctx.lastTouched === agentId) ctx.lastTouched = null;
            // 用户关掉的下次不再恢复；退出时一起关掉的照旧恢复
            if (!ctx.shuttingDown) rememberOpen(agentId, false);
            ctx.notifyMain(agentId);
        });
        win.loadURL(ctx.assets.pageUrl(agentId));
        if (!USE_SHAPE) startHitPoll(pet);
        applyClickThrough(pet);
        updateTopmostGuard();
        ctx.displays.updateFullscreenWatch();
        ctx.notifyMain(agentId);
        return { success: true, open: true };
    }

    function closePet(agentId) {
        const pet = pets.get(agentId);
        if (pet && !pet.win.isDestroyed()) pet.win.close();
        return { success: true, open: false };
    }

    /** 助手被删掉：关掉 TA 的桌宠，state.json、开着的列表、最近用过的、卡片快照里都不再留着 TA。
     *  在删目录之前调用（Windows 上桌宠页面还开着时，正在用的模型文件可能删不掉）。 */
    async function forgetAgent(agentId) {
        if (!ctx.paths || !isAgentId(agentId)) return; // 桌宠模块没启用
        ctx.sessions.forget(agentId);
        const pet = pets.get(agentId);
        if (pet && !pet.win.isDestroyed()) {
            const closed = new Promise((resolve) => pet.win.once('closed', resolve));
            pet.win.close();
            await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
        }
        if (ctx.controls) {
            const settings = ctx.controls.get();
            ctx.controls.update({
                openAgents: settings.openAgents.filter((id) => id !== agentId),
                ...(settings.lastAgent === agentId ? { lastAgent: null } : {}),
            });
        }
        await ctx.stateStore.remove(agentId);
        await ctx.previews?.forget(agentId);
        ctx.refreshTray();
    }

    // 启动时打开上次开着的桌宠（设置里可以关掉）。
    function restoreOpenPets() {
        const settings = ctx.controls?.get();
        if (!settings?.restoreOnLaunch || !settings.openAgents.length) return;
        (async () => {
            for (const agentId of settings.openAgents) {
                if (ctx.shuttingDown || !ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
                const result = await openPet(agentId).catch(() => null);
                // 助手被删掉了：从恢复列表里拿掉
                if (!result?.success) rememberOpen(agentId, false);
            }
        })();
    }

    // 装好 Core 以后，正在用立绘代替 Live2D 的桌宠重新载入一次，换成真正的 Live2D。
    async function reloadLive2DPets() {
        for (const pet of pets.values()) {
            if (pet.win.isDestroyed()) continue;
            const assets = await ctx.resolveAssets(pet.agentId, pet.outfit).catch(() => null);
            if (assets?.live2d && !pet.win.isDestroyed()) pet.win.webContents.reload();
        }
    }

    return {
        showPet,
        reassertTopmost,
        updateTopmostGuard,
        setIgnoreMouse,
        clickThroughOn,
        setClickThrough,
        applyClickThrough,
        applyCaptureHiding,
        resetInputState,
        rememberOpen,
        whenPageReady,
        settleReady,
        openPet,
        closePet,
        forgetAgent,
        restoreOpenPets,
        reloadLive2DPets,
    };
}

module.exports = { createPetWindow };
