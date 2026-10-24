// modules/deskpet/petIpc.js
// 桌宠这边所有 ipcMain 的注册都在这里：主窗口发来的开关和回传、桌宠页面报上来的
// 页面就绪、形象尺寸、命中、拖动、溜达、右键菜单等。具体做什么都交给各模块。

// 滚一格算多少（deltaY 按像素给，攒够一格再变）
const WHEEL_NOTCH = 100;
const { voiceChatSessions } = require('../voice/voiceChatSessions');

function registerIpc(ctx) {
    const { ipcMain } = ctx.electron;
    const { pets } = ctx;
    const { USE_SHAPE } = ctx.platform;

    ipcMain.handle('deskpet:toggle', async (event, agentId) => {
        if (!ctx.fromMain(event)) return { success: false, error: 'forbidden' };
        if (typeof agentId !== 'string' || !agentId) return { success: false, error: 'invalid-agent' };
        const pet = pets.get(agentId);
        // 隐藏着的桌宠：再点一次是叫回来，不是关掉。
        const result = await (pet && pet.win.isVisible() ? ctx.windows.closePet(agentId) : ctx.windows.openPet(agentId));
        ctx.refreshTray();
        return { ...result, openAgents: ctx.visibleAgents() };
    });
    ipcMain.handle('deskpet:get-open-agents', () => ctx.visibleAgents());
    ipcMain.on('deskpet:send-result', (event, payload) => {
        if (!ctx.fromMain(event)) return;
        ctx.bridge.resolveSend(payload);
    });
    ipcMain.on('deskpet:where-result', (event, payload) => {
        if (!ctx.fromMain(event)) return;
        ctx.bridge.resolveWhere(payload);
    });

    ipcMain.handle('deskpet:get-assets', async (event) => {
        const pet = ctx.petFromEvent(event);
        if (!pet) {
            // 设置页卡片的快照：离屏窗口按指定的那套形象画一次
            const job = ctx.previews?.jobFor(event.sender);
            return job ? { ...(await ctx.resolveAssets(job.agentId, job.outfitId)), preview: true } : null;
        }
        const wanted = pet.outfit;
        const assets = await ctx.resolveAssets(pet.agentId, wanted);
        pet.name = assets.name;
        pet.outfits = assets.outfits;
        // 记着的那套已经删了：换成实际显示的这套。等待期间又换了装（连点卡片）就别把新选的盖回去
        if (pet.outfit === wanted) {
            pet.outfit = assets.outfit?.id || null;
            pet.capabilities = assets.live2d?.capabilities || null;
            pet.capabilitiesOutfit = pet.outfit;
            if (pet.kind !== assets.outfit?.kind) ctx.sizing.applyAspect(pet, null, assets.outfit?.kind);
        }
        const saved = (await ctx.readPetState())[pet.agentId];
        return { ...assets, wardrobeSelection: saved?.wardrobes?.[assets.outfit?.id] || {}, session: ctx.sessions.get(pet.agentId), chatRoute: voiceChatSessions.status(pet.agentId) };
    });
    ipcMain.on('deskpet:preview-ready', (event, report) => {
        ctx.previews?.ready(event.sender, report && typeof report === 'object' ? report : null);
    });
    // 页面准备好了（形象载完、输入框能用了）：补上等着的输入框
    ipcMain.on('deskpet:page-ready', (event, backendKind) => {
        const pet = ctx.petFromEvent(event);
        if (!pet) return;
        pet.ready = true;
        pet.backendKind = backendKind === 'live2d' ? 'live2d' : null;
        ctx.menus.pushWardrobe(pet).catch((error) => console.warn('[DeskPet] wardrobe restore failed:', error.message));
        // 藏着的时候重载（换装、崩溃恢复）：新页面默认在跑，告诉它停下
        if (!pet.win.isDestroyed() && !pet.win.isVisible()) pet.win.webContents.send('deskpet:visibility', false);
        const pending = pet.pendingToggle;
        pet.pendingToggle = null;
        if (pending) ctx.commands.openInput(pet, pending);
        ctx.proactive.resendApprovals(pet);
        ctx.windows.settleReady(pet);
    });
    // 页面启动失败：等着交给它的话不再等
    ipcMain.on('deskpet:page-failed', (event, message) => {
        const pet = ctx.petFromEvent(event);
        if (!pet) return;
        ctx.windows.settleReady(pet, new Error(`桌宠启动失败：${typeof message === 'string' && message ? message : '未知原因'}`));
    });
    // 页面量出了形象的长宽比：按它改窗口（全身像高、Q 版矮），记下来下次直接用
    ipcMain.on('deskpet:figure', (event, report) => {
        const pet = ctx.petFromEvent(event);
        if (pet && report && typeof report === 'object') {
            ctx.sizing.onFigureMeasured(pet, report).catch((error) => console.warn('[DeskPet] figure:', error.message));
        }
    });
    ipcMain.handle('deskpet:get-prefs', (event) => {
        const pet = ctx.petFromEvent(event);
        return pet ? ctx.sizing.prefsFor(pet) : null;
    });
    // 在角色上按住 Ctrl 滚滚轮调大小；deltaY 按像素给，攒够一格再变
    ipcMain.on('deskpet:wheel-resize', (event, deltaY) => {
        const pet = ctx.petFromEvent(event);
        const delta = Number(deltaY);
        if (!pet || !Number.isFinite(delta) || pet.drag) return;
        pet.wheel = (Math.sign(pet.wheel) === Math.sign(delta) ? pet.wheel : 0) + delta;
        if (Math.abs(pet.wheel) < WHEEL_NOTCH) return;
        // 往上滚（deltaY < 0）是放大
        ctx.sizing.stepPetScale(pet.agentId, -Math.sign(pet.wheel));
        pet.wheel = 0;
    });
    ipcMain.on('deskpet:touched', (event) => {
        const pet = ctx.petFromEvent(event);
        if (pet) ctx.lastTouched = pet.agentId;
    });
    // 这个助手的持续心情（modules/agentMood.js，和侧栏立绘同一份）：待机时显示它，之后跟着 agent-mood-changed 更新
    ipcMain.handle('deskpet:get-mood', async (event) => {
        const pet = ctx.petFromEvent(event);
        return pet ? ctx.menus.readMood(pet.agentId) : null;
    });
    ipcMain.handle('deskpet:send', async (event, text, options) => {
        const pet = ctx.petFromEvent(event);
        const message = typeof text === 'string' ? text.trim() : '';
        const attached = ctx.bridge.cleanSendFiles(options?.files);
        if (!pet || (!message && !attached.length)) return { success: false, error: '没有内容' };
        if (attached.some((f) => f.path)) {
            const problem = await ctx.bridge.checkDroppedFiles(attached);
            if (problem) return { success: false, error: problem };
        }
        ctx.motion.stopWalk(pet);
        return ctx.bridge.sendFromPet(pet.agentId, message.slice(0, 8000), { files: attached, newTopic: options?.newTopic === true });
    });
    // 输入框打开时整窗可点并拿到键盘焦点；关上后回到按像素穿透。
    ipcMain.on('deskpet:set-interactive', (event, on) => {
        const pet = ctx.petFromEvent(event);
        if (!pet || pet.win.isDestroyed()) return;
        pet.interactive = !!on;
        ctx.windows.applyClickThrough(pet);
        if (on) {
            if (!USE_SHAPE) ctx.windows.setIgnoreMouse(pet, false);
            pet.win.focus();
        } else {
            // 输入框收起：先回到整窗穿透，页面下一次命中会重新报上来（光标不在角色上时不会再报，
            // 不回到穿透的话整块透明窗口会一直挡着下面的点击）
            if (!USE_SHAPE) {
                pet.ignoringMouse = null;
                ctx.windows.setIgnoreMouse(pet, true);
            }
            ctx.windows.applyClickThrough(pet);
        }
    });
    ipcMain.on('deskpet:open-main', () => ctx.bridge.openMainWindow());
    // 工具审批：主窗口转来、主窗口说答完了；桌宠上点了允许/拒绝交回主窗口
    ipcMain.on('deskpet:approval-offer', (event, payload) => {
        if (!ctx.fromMain(event)) return;
        ctx.proactive.offerApproval(payload).catch((error) => console.warn('[DeskPet] approval offer failed:', error?.message || error));
    });
    ipcMain.on('deskpet:approval-settled', (event, requestId) => {
        if (!ctx.fromMain(event)) return;
        ctx.proactive.settleApproval(requestId);
    });
    ipcMain.on('deskpet:approval-answer', (event, answer) => {
        ctx.proactive.answerApproval(ctx.petFromEvent(event), answer);
    });
    // 桌宠上点了停止：交给主窗口按它的中止流程停掉那条回复
    ipcMain.on('deskpet:interrupt', (event, messageId) => {
        const pet = ctx.petFromEvent(event);
        if (!pet || typeof messageId !== 'string' || !messageId || messageId.length > 200) return;
        if (ctx.sessions.get(pet.agentId)?.sessions?.some(row => row.messageId === messageId && row.topicId === `voicechat_${pet.agentId}`)) {
            voiceChatSessions.interrupt?.(pet.agentId, messageId);
            return;
        }
        const { mainWindow } = ctx;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('deskpet:interrupt-request', { agentId: pet.agentId, messageId });
    });
    // 多久没碰键盘鼠标了（秒）：回复说完时人在不在
    ipcMain.handle('deskpet:idle-seconds', () => {
        try { return ctx.electron.powerMonitor?.getSystemIdleTime?.() ?? 0; } catch { return 0; }
    });
    ipcMain.on('deskpet:open-topic', (event, topicId) => {
        const pet = ctx.petFromEvent(event);
        if (!pet) return;
        ctx.bridge.openTopic(pet.agentId, topicId).then((opened) => {
            if (!opened && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:topic-missing');
        }).catch((error) => console.warn('[DeskPet] open topic failed:', error.message));
    });
    ipcMain.on('deskpet:hit', (event, hit) => {
        const pet = ctx.petFromEvent(event);
        if (!pet) return;
        if (hit) ctx.motion.stopWalk(pet);
        ctx.windows.setIgnoreMouse(pet, !hit);
    });
    // 藏在边里时：页面说现在要不要探出来（鼠标在角色上、气泡或输入框开着）
    ipcMain.on('deskpet:want-out', (event, want) => {
        const pet = ctx.petFromEvent(event);
        if (pet) ctx.motion.setWantOut(pet, want === true);
    });
    ipcMain.on('deskpet:content-bounds', (event, rect) => {
        const pet = ctx.petFromEvent(event);
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
        const pet = ctx.petFromEvent(event);
        if (!pet) return;
        ctx.motion.startDrag(pet, origin);
    });
    ipcMain.on('deskpet:drag-end', (event, report) => {
        const pet = ctx.petFromEvent(event);
        if (pet) ctx.motion.endDrag(pet, report);
    });

    // 页面闲了一阵：figure 是角色在窗口里的包围盒；stop 是页面那边有了动静
    ipcMain.on('deskpet:wander', (event, report) => {
        const pet = ctx.petFromEvent(event);
        if (!pet || pet.win.isDestroyed()) return;
        if (report?.stop === true) {
            ctx.motion.stopWalk(pet);
            return;
        }
        const figure = ctx.figureFrom(report);
        if (figure) ctx.motion.startWalk(pet, figure);
    });

    ipcMain.on('deskpet:context-menu', async (event) => {
        const pet = ctx.petFromEvent(event);
        if (pet) await ctx.menus.showContextMenu(pet);
    });
}

module.exports = { registerIpc, WHEEL_NOTCH };
