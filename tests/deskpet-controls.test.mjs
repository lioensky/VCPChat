import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const prefs = require('../modules/deskpet/petPrefs.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 尺寸和设置（纯函数） ----

test('pet window sizes stay on a 4px grid so fractional display scaling does not round them up', () => {
    assert.deepEqual(prefs.windowSizeForScale(1), { width: 360, height: 464 });
    for (let scale = prefs.SCALE_MIN; scale <= prefs.SCALE_MAX + 1e-9; scale += 0.05) {
        const { width, height } = prefs.windowSizeForScale(scale);
        assert.equal(width % 4, 0, `width at ${scale}`);
        assert.equal(height % 4, 0, `height at ${scale}`);
        // 125%、150%、175% 下换成物理像素都是整数
        for (const factor of [1.25, 1.5, 1.75]) assert.ok(Number.isInteger(width * factor) && Number.isInteger(height * factor));
    }
    assert.ok(prefs.windowSizeForScale(0.5).width >= 360, '缩到最小也要放得下气泡和输入框');
    assert.equal(prefs.clampScale(9), prefs.SCALE_MAX);
    assert.equal(prefs.clampScale('nope'), 1);
});

test('the default size is smaller now; a size someone picked before looks the same as it did', () => {
    // 第一版的 1 倍（360×580 的窗口）太大，现在的 1 倍是它的六成
    assert.ok(prefs.characterBox().height < 300);
    assert.equal(prefs.savedScale(null), 1, '没记过：新的默认');
    assert.equal(prefs.savedScale({ x: 1, y: 2 }), 1);
    assert.equal(prefs.savedScale({ scale: 1 }), 1, '旧版没调过（1 倍）：也用新的默认');
    assert.equal(prefs.savedScale({ scale: 1.5 }), 2.5, '旧版调到 1.5 倍：换算成同样的实际大小');
    assert.equal(prefs.savedScale({ scale: 0.6 }), 1);
    assert.equal(prefs.savedScale({ scale: 2 }), prefs.SCALE_MAX, '换算后超出上限就到上限');
    assert.equal(prefs.savedScale({ scale: 1.5, sizeVersion: prefs.SIZE_VERSION }), 1.5, '新版记的原样用');
    // 旧版记的位置：换算后脚还站在原来的地方（站在任务栏上的不会悬空）
    const feet = (saved, aspect, scale) => {
        const pos = prefs.legacyPosition(saved, aspect, scale);
        return [pos.x + prefs.windowSizeForScale(scale, aspect).width / 2, pos.y + prefs.UI_RESERVE + prefs.characterBox(aspect).height * scale];
    };
    assert.deepEqual(feet({ x: 1000, y: 420, scale: 1 }, null, 1), [1180, 1000], '旧 1 倍：360×580 的窗口，脚在 y=1000');
    const [, tallFeet] = feet({ x: 500, y: 100, scale: 1.5 }, 2.4, prefs.savedScale({ scale: 1.5 }));
    assert.ok(Math.abs(tallFeet - (100 + prefs.UI_RESERVE + (prefs.characterBox(2.4).height / 0.6) * 1.5)) < 1);
    assert.equal(prefs.legacyPosition({ x: 1, y: 2, scale: 1, sizeVersion: prefs.SIZE_VERSION }, null, 1), null, '新版的不动');
});

test('resizing keeps the character standing on the same spot and inside the work area', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const before = { x: 1000, y: 400, width: 360, height: 580 };
    const after = prefs.resizeAnchored(before, prefs.windowSizeForScale(1.5), area);
    assert.equal(after.x + after.width / 2, before.x + before.width / 2, '脚底中点不动');
    assert.equal(after.y + after.height, before.y + before.height, '脚底高度不动');
    const corner = prefs.resizeAnchored({ x: 1700, y: 600, width: 360, height: 580 }, prefs.windowSizeForScale(1.5), area);
    assert.ok(corner.x + corner.width <= area.width && corner.y + corner.height <= area.height, '放大以后挪回屏幕里');
    assert.ok(prefs.maxScaleForWorkArea({ height: 400 }) < 1.2, '矮屏放不下的大小要缩');
});

test('shortcuts need real modifiers and never take what VCPChat already uses', () => {
    assert.equal(prefs.normalizeAccelerator('ctrl+alt+shift+p'), 'CommandOrControl+Alt+Shift+P');
    assert.equal(prefs.normalizeAccelerator('Alt+Ctrl+M'), 'CommandOrControl+Alt+M');
    assert.equal(prefs.normalizeAccelerator('Ctrl+F9'), 'CommandOrControl+F9');
    assert.equal(prefs.normalizeAccelerator(''), '');
    assert.equal(prefs.normalizeAccelerator('Ctrl+C'), null, '单个 Ctrl 加字母会抢走复制粘贴这类按键');
    assert.equal(prefs.normalizeAccelerator('Shift+F1+F2'), null);
    assert.equal(prefs.normalizeAccelerator('Shift+Alt'), null);
    assert.equal(prefs.normalizeAccelerator('Shift+F3'), 'Shift+F3');
    assert.equal(prefs.normalizeAccelerator('F3'), null);
    assert.ok(prefs.isReserved(prefs.normalizeAccelerator('Ctrl+Shift+P')));
    for (const accelerator of Object.values(prefs.DEFAULT_SETTINGS.shortcuts)) {
        assert.equal(prefs.normalizeAccelerator(accelerator), accelerator);
        assert.ok(!prefs.isReserved(accelerator));
    }
});

test('a hand-edited or broken settings file falls back to safe defaults', () => {
    assert.deepEqual(prefs.normalizeSettings(null), {
        version: prefs.SETTINGS_VERSION, doNotDisturb: false, restoreOnLaunch: true, yieldToFullscreen: false, clickThrough: false, opacity: 1, wander: false, followCursor: true, hideFromCapture: false, idleChat: false, idleChatMinutes: 30, shortcuts: { ...prefs.DEFAULT_SETTINGS.shortcuts }, openAgents: [], lastAgent: null,
    });
    const odd = prefs.normalizeSettings({
        doNotDisturb: 'yes',
        restoreOnLaunch: false,
        shortcuts: { toggle: 'Ctrl+Shift+I', talk: '' },
        openAgents: ['Nova', '../x', 'Nova', 5, 'Coco'],
        lastAgent: '..',
    });
    assert.equal(odd.doNotDisturb, false);
    assert.equal(odd.restoreOnLaunch, false);
    assert.equal(odd.shortcuts.toggle, prefs.DEFAULT_SETTINGS.shortcuts.toggle, '占用的组合回到默认');
    assert.equal(odd.shortcuts.talk, '', '留空表示不用');
    assert.deepEqual(odd.openAgents, ['Nova', 'Coco']);
    assert.equal(odd.lastAgent, null);
});

test('the voice and click-through keys an older version saved as defaults are dropped once', () => {
    const old = prefs.normalizeSettings({
        shortcuts: { toggle: 'CommandOrControl+Alt+Shift+P', talk: 'CommandOrControl+Alt+Shift+M', voice: 'CommandOrControl+Alt+Shift+V', clickThrough: 'Ctrl+Alt+Shift+T' },
    });
    assert.equal(old.shortcuts.voice, '');
    assert.equal(old.shortcuts.clickThrough, '');
    assert.equal(old.shortcuts.toggle, 'CommandOrControl+Alt+Shift+P');
    // 旧文件里自己录的别的键照留
    assert.equal(prefs.normalizeSettings({ shortcuts: { voice: 'CommandOrControl+Alt+F9' } }).shortcuts.voice, 'CommandOrControl+Alt+F9');
    // 新版本保存过以后，同一个组合是用户自己录的，不再清掉
    const saved = prefs.normalizeSettings({ ...old, shortcuts: { ...old.shortcuts, voice: 'CommandOrControl+Alt+Shift+V' } });
    assert.equal(saved.version, prefs.SETTINGS_VERSION);
    assert.equal(prefs.normalizeSettings(JSON.parse(JSON.stringify(saved))).shortcuts.voice, 'CommandOrControl+Alt+Shift+V');
});

test('pet opacity stays between 30% and fully opaque', () => {
    assert.equal(prefs.normalizeOpacity(undefined), 1);
    assert.equal(prefs.normalizeOpacity('abc'), 1);
    assert.equal(prefs.normalizeOpacity(null), 1);
    assert.equal(prefs.normalizeOpacity(0.6), 0.6);
    assert.equal(prefs.normalizeOpacity(0.62), 0.6);
    assert.equal(prefs.normalizeOpacity(0), 0.3, '不能淡到看不见');
    assert.equal(prefs.normalizeOpacity(5), 1);
    assert.equal(prefs.normalizeSettings({ opacity: 0.4 }).opacity, 0.4);
});

test('cursor following defaults on and capture hiding defaults off', () => {
    assert.equal(prefs.normalizeSettings({ followCursor: false }).followCursor, false);
    assert.equal(prefs.normalizeSettings({ followCursor: 'no' }).followCursor, true);
    assert.equal(prefs.normalizeSettings({ hideFromCapture: true }).hideFromCapture, true);
    assert.equal(prefs.normalizeSettings({ hideFromCapture: 1 }).hideFromCapture, false);
});

// ---- 主进程：大小、免打扰、快捷键、恢复 ----

function fakeElectron({ taken = [] } = {}) {
    const handlers = new Map();
    const listeners = new Map();
    const windows = [];
    const shortcuts = new Map();
    const screen = Object.assign(new EventEmitter(), {
        displays: [{ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }],
        cursor: { x: 0, y: 0 },
        getPrimaryDisplay() { return this.displays[0]; },
        getAllDisplays() { return this.displays; },
        getDisplayMatching() { return this.displays[0]; },
        getCursorScreenPoint() { return { ...this.cursor }; },
    });
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
            this.sent = [];
            this.visible = false;
            this.destroyed = false;
            this.webContents = Object.assign(new EventEmitter(), {
                send: (channel, payload) => this.sent.push({ channel, payload }),
                isLoading: () => false,
                getURL: () => 'file://main.html',
                isDestroyed: () => this.destroyed,
                reload: () => { this.reloads = (this.reloads || 0) + 1; },
                setFrameRate() {},
                loadURL: (url) => { this.contentsUrl = url; return Promise.resolve(); },
                // 离屏快照：截到的是一张 40×80 的图；blankFrames 张以内是全透明的（帧还没合成出来）
                capturePage: async (rect) => {
                    this.captured = rect;
                    this.captures = (this.captures || 0) + 1;
                    const blank = this.blankFrames > 0;
                    if (blank) this.blankFrames -= 1;
                    const bitmap = Buffer.alloc(40 * 80 * 4, blank ? 0 : 255);
                    return { isEmpty: () => false, getSize: () => ({ width: 40, height: 80 }), resize: () => this, toPNG: () => Buffer.from('png'), toBitmap: () => bitmap };
                },
            });
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        isMinimized() { return false; }
        show() { this.visible = true; this.emit('show'); }
        showInactive() { this.visible = true; this.emit('show'); }
        hide() { this.visible = false; this.emit('hide'); }
        close() { this.destroyed = true; this.emit('closed'); }
        destroy() { this.close(); }
        setContentSize(width, height) { this.bounds = { ...this.bounds, width, height }; }
        setAlwaysOnTop() {} moveTop() {} setVisibleOnAllWorkspaces() {} focus() {} loadURL(url) { this.url = url; } reload() {}
        restore() {} setMenu() {} setResizable() {}
        setIgnoreMouseEvents() {}
        setFocusable() {}
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
        getBounds() { return { ...this.bounds }; }
        setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
        getContentSize() { return [this.bounds.width, this.bounds.height]; }
    }
    const globalShortcut = {
        register(accelerator, fn) {
            if (taken.includes(accelerator) || shortcuts.has(accelerator)) return false;
            shortcuts.set(accelerator, fn);
            return true;
        },
        unregister(accelerator) { shortcuts.delete(accelerator); },
        isRegistered(accelerator) { return shortcuts.has(accelerator); },
    };
    const electron = {
        BrowserWindow,
        ipcMain: {
            handle: (channel, fn) => handlers.set(channel, fn),
            on: (channel, fn) => listeners.set(channel, fn),
        },
        protocol: { handle() {}, registerSchemesAsPrivileged() {} },
        net: {},
        Menu: {},
        screen,
        globalShortcut,
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        shell: { openPath: async () => '' },
    };
    return { electron, handlers, listeners, windows, screen, shortcuts };
}

async function loadHandlers({ root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-ctl-')), taken = [] } = {}) {
    const fake = fakeElectron({ taken });
    const originalLoad = Module._load;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Module._load = function load(request, ...rest) {
        if (request === 'electron') return fake.electron;
        return originalLoad.call(this, request, ...rest);
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const name of ['../modules/ipc/deskPetHandlers.js', '../modules/deskpet/petControls.js']) delete require.cache[require.resolve(name)];
    let handlers;
    try {
        handlers = require('../modules/ipc/deskPetHandlers.js');
    } finally {
        Module._load = originalLoad;
        Object.defineProperty(process, 'platform', platform);
    }
    const agentDir = path.join(root, 'Agents');
    for (const id of ['Nova', 'Coco']) {
        fs.mkdirSync(path.join(agentDir, id), { recursive: true });
        fs.writeFileSync(path.join(agentDir, id, 'config.json'), JSON.stringify({ name: id }));
    }
    const mainWindow = new fake.electron.BrowserWindow({});
    handlers.initialize({ mainWindow, projectRoot: path.resolve('.'), appDataRoot: root, agentDir });
    await sleep(20); // 等设置文件读完、快捷键注册好
    const petWindows = () => fake.windows.filter((w) => w.url?.includes('deskpet.html') && !w.destroyed);
    const open = async (agentId = 'Nova') => {
        await fake.handlers.get('deskpet:toggle')({}, agentId);
        const pet = fake.windows.at(-1);
        pet.emit('ready-to-show');
        // 页面载完形象、输入框能用了
        fake.listeners.get('deskpet:page-ready')({ sender: pet.webContents });
        return pet;
    };
    const fromPet = (pet) => ({ sender: pet.webContents });
    const settingsFile = path.join(root, 'deskpet', 'settings.json');
    const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    return { handlers, fake, open, fromPet, root, mainWindow, petWindows, settingsFile, readJson };
}

const bottomCenter = (b) => [b.x + b.width / 2, b.y + b.height];

test('ctrl+wheel resizes a pet around its feet and the size is remembered per agent', async () => {
    const env = await loadHandlers();
    const pet = await env.open('Nova');
    const before = pet.getBounds();
    const wheel = env.fake.listeners.get('deskpet:wheel-resize');
    wheel(env.fromPet(pet), -60); // 半格：不动
    assert.deepEqual(pet.getBounds(), before);
    wheel(env.fromPet(pet), -60);
    const grown = pet.getBounds();
    // 默认大小下窗口已经是最窄（放得下气泡），放大先长高
    assert.ok(grown.width >= before.width && grown.height > before.height, '往上滚放大');
    assert.deepEqual(bottomCenter(grown), bottomCenter(before), '脚底不动');
    assert.equal(pet.sent.filter((m) => m.channel === 'deskpet:prefs').at(-1).payload.scale, 1.1);
    await sleep(30);
    env.handlers.closeAll();

    // 重新载入（相当于重启）：同一个助手按记住的大小和位置回来
    const again = await loadHandlers({ root: env.root });
    const reopened = await again.open('Nova');
    assert.deepEqual(reopened.getBounds(), grown);
    const prefsReply = await again.fake.handlers.get('deskpet:get-prefs')(again.fromPet(reopened));
    assert.equal(prefsReply.scale, 1.1);
    // 另一个助手不受影响
    const coco = await again.open('Coco');
    assert.deepEqual([coco.getBounds().width, coco.getBounds().height], [360, 464]);
    again.handlers.closeAll();
});

test('the first press of the show key brings out Nova, or opens the desk pet settings', async () => {
    const env = await loadHandlers();
    const toggleKey = env.fake.shortcuts.get(prefs.DEFAULT_SETTINGS.shortcuts.toggle);
    // 托盘里「显示桌宠」也能点：从没开过桌宠的人点了才有反应
    const show = env.handlers.trayMenuItems()[0].submenu.find((item) => item.id === 'deskpet-show');
    assert.notEqual(show.enabled, false);
    toggleKey();
    await sleep(50);
    assert.equal(env.petWindows().length, 1);
    assert.match(env.petWindows()[0].url, /agentId=Nova/);
    const assets = await env.fake.handlers.get('deskpet:get-assets')({ sender: env.petWindows()[0].webContents });
    assert.equal(assets.avatar, 'vcp-deskpet://pet/default-avatar.png', '没放头像的助手用默认头像');

    const other = await loadHandlers();
    fs.writeFileSync(path.join(other.root, 'Agents', 'Nova', 'config.json'), JSON.stringify({ name: '小助手' }));
    other.fake.shortcuts.get(prefs.DEFAULT_SETTINGS.shortcuts.toggle)();
    await sleep(50);
    assert.equal(other.petWindows().length, 0, '没有 Nova 就不替用户挑一个');
    assert.ok(other.mainWindow.sent.some((s) => s.channel === 'deskpet-settings:open'), '打开设置页的桌宠分区');
    env.handlers.closeAll();
    other.handlers.closeAll();
});

test('do not disturb reaches every open pet and the tray item reflects it', async () => {
    const env = await loadHandlers();
    const nova = await env.open('Nova');
    const coco = await env.open('Coco');
    let trayRebuilds = 0;
    const structure = [];
    env.handlers.setTrayRefresher((structureChanged) => { trayRebuilds += 1; structure.push(structureChanged); });
    await env.fake.handlers.get('deskpet:toggle')({}, 'Nope');
    await env.fake.handlers.get('deskpet:toggle')({}, 'Nope');
    assert.equal(trayRebuilds, 1, '菜单内容没变就不重建（换下来的旧菜单 Electron 不释放）');
    const toggle = env.handlers.trayMenuItems()[0].submenu.find((item) => item.label === '免打扰');
    assert.equal(toggle.checked, false);
    toggle.click({ checked: true });
    for (const pet of [nova, coco]) assert.equal(pet.sent.filter((m) => m.channel === 'deskpet:prefs').at(-1).payload.doNotDisturb, true);
    assert.equal(trayRebuilds, 2);
    assert.deepEqual(structure, [true, false], '只是勾选变了：改现有菜单，不建新的');
    assert.equal(env.handlers.trayMenuItems()[0].submenu.find((item) => item.label === '免打扰').checked, true);
    await sleep(300);
    assert.equal(env.readJson(env.settingsFile).doNotDisturb, true, '免打扰写进设置，重启后还在');
    env.handlers.closeAll();
});

test('tray state is written into the menu already shown instead of a new one', async () => {
    const env = await loadHandlers();
    await env.open('Nova');
    // 假菜单：按 id 找项，跟 Electron 的 Menu.getMenuItemById 一样
    const fakeMenu = (items) => {
        const byId = new Map();
        const walk = (list) => { for (const item of list) { if (item.id) byId.set(item.id, { ...item }); if (Array.isArray(item.submenu)) walk(item.submenu); } };
        walk(items);
        return { getMenuItemById: (id) => byId.get(id) || null };
    };
    const menu = fakeMenu(env.handlers.trayMenuItems());
    assert.equal(menu.getMenuItemById('deskpet-hide').visible, true);
    assert.equal(menu.getMenuItemById('deskpet-show').visible, false);
    env.handlers.closeAll();
    await env.fake.handlers.get('deskpet:toggle')({}, 'Nope');
    assert.equal(env.handlers.applyTrayState(menu), true);
    assert.equal(menu.getMenuItemById('deskpet-hide').visible, false, '桌宠都关了：显示「显示桌宠」');
    assert.equal(menu.getMenuItemById('deskpet-show').visible, true);
    env.handlers.trayMenuItems()[0].submenu.find((item) => item.id === 'deskpet-click-through').click({ checked: true });
    assert.equal(env.handlers.applyTrayState(menu), true);
    assert.equal(menu.getMenuItemById('deskpet-click-through').checked, true);
    // 菜单里没有这几项（比如还没建过）：要重建
    assert.equal(env.handlers.applyTrayState({ getMenuItemById: () => null }), false);
});

test('opacity from the settings page reaches every pet and is saved', async () => {
    const env = await loadHandlers();
    const nova = await env.open('Nova');
    const update = env.fake.handlers.get('deskpet-settings:update');
    const snap = await update(fromMain(env), { opacity: 0.6 });
    assert.equal(snap.settings?.opacity ?? snap.opacity, 0.6);
    assert.equal(nova.sent.filter((m) => m.channel === 'deskpet:prefs').at(-1).payload.opacity, 0.6);
    await update(fromMain(env), { opacity: 'x' });
    assert.equal(nova.sent.filter((m) => m.channel === 'deskpet:prefs').at(-1).payload.opacity, 0.6, '不是数字的不理');
    await sleep(300);
    assert.equal(env.readJson(env.settingsFile).opacity, 0.6);
    env.handlers.closeAll();
});

test('global shortcuts hide and bring back the pets and open the input box', async () => {
    const env = await loadHandlers();
    const toggleKey = prefs.DEFAULT_SETTINGS.shortcuts.toggle;
    const talkKey = prefs.DEFAULT_SETTINGS.shortcuts.talk;
    assert.ok(env.fake.shortcuts.has(toggleKey) && env.fake.shortcuts.has(talkKey));
    const nova = await env.open('Nova');
    const coco = await env.open('Coco');
    await env.fake.shortcuts.get(toggleKey)();
    await sleep(5);
    assert.ok(!nova.isVisible() && !coco.isVisible(), '有露着的就全部收起');
    await env.fake.shortcuts.get(toggleKey)();
    await sleep(5);
    assert.ok(nova.isVisible() && coco.isVisible(), '再按一次全部回来');
    env.fake.listeners.get('deskpet:touched')(env.fromPet(nova));
    await env.fake.shortcuts.get(talkKey)();
    await sleep(5);
    assert.deepEqual(nova.sent.filter((m) => m.channel === 'deskpet:open-input').at(-1)?.payload, { toggle: true }, '最近碰过的那个弹输入框');
    assert.equal(coco.sent.some((m) => m.channel === 'deskpet:open-input'), false);
    // 语音键：同一个桌宠开始录音（再按一下由页面停下发出去）
    assert.equal(prefs.DEFAULT_SETTINGS.shortcuts.voice, '', '语音键默认不占');
    assert.equal(env.handlers._controls().setShortcut('voice', 'Ctrl+Alt+Shift+V').success, true);
    const voiceKey = 'CommandOrControl+Alt+Shift+V';
    assert.ok(env.fake.shortcuts.has(voiceKey));
    await env.fake.shortcuts.get(voiceKey)();
    await sleep(5);
    assert.deepEqual(nova.sent.filter((m) => m.channel === 'deskpet:open-input').at(-1)?.payload, { voice: true });
    env.handlers.closeAll();
    assert.equal(env.fake.shortcuts.size, 0, '退出时只注销自己的快捷键');
});

test('a shortcut another program holds is reported, and a reserved one is refused', async () => {
    const taken = [prefs.DEFAULT_SETTINGS.shortcuts.talk];
    const env = await loadHandlers({ taken });
    const controls = env.handlers._controls();
    assert.match(controls.failures().talk, /占用/);
    assert.equal(controls.setShortcut('toggle', 'Ctrl+Shift+P').success, false, 'VCPChat 自己的组合不给');
    assert.equal(controls.setShortcut('toggle', prefs.DEFAULT_SETTINGS.shortcuts.talk).success, false, '两个动作不能同一个键');
    const ok = controls.setShortcut('talk', 'Ctrl+Alt+K');
    assert.equal(ok.success, true);
    assert.ok(env.fake.shortcuts.has('CommandOrControl+Alt+K'));
    assert.ok(!env.fake.shortcuts.has(taken[0]));
    env.handlers.closeAll();
});

test('pets open at quit come back on the next launch; ones the user closed do not', async () => {
    const env = await loadHandlers();
    await env.open('Nova');
    const coco = await env.open('Coco');
    await env.fake.handlers.get('deskpet:toggle')({}, 'Coco'); // 用户关掉 Coco
    assert.ok(coco.destroyed);
    env.handlers.closeAll(); // 退出
    await sleep(250);
    assert.deepEqual(env.readJson(env.settingsFile).openAgents, ['Nova']);

    const again = await loadHandlers({ root: env.root });
    // 主窗口载完以后再恢复
    again.mainWindow.webContents.emit('did-finish-load');
    await sleep(1700);
    assert.deepEqual(again.petWindows().map((w) => decodeURIComponent(w.url.split('agentId=')[1])), ['Nova']);
    again.handlers.closeAll();
});

test('a smaller display shrinks a pet that no longer fits', async () => {
    const env = await loadHandlers();
    const pet = await env.open('Nova');
    env.handlers._controls(); // 已初始化
    await env.fake.handlers.get('deskpet-settings:set-scale')?.({ sender: null }, 'Nova', 2); // 不是设置窗口发的：不理
    assert.equal(pet.getBounds().width, 360);
    for (let i = 0; i < 16; i += 1) env.fake.listeners.get('deskpet:wheel-resize')(env.fromPet(pet), -100);
    assert.ok(pet.getBounds().height > 800);
    env.fake.screen.displays = [{ workArea: { x: 0, y: 0, width: 1280, height: 680 } }];
    env.fake.screen.emit('display-metrics-changed');
    await sleep(450);
    const b = pet.getBounds();
    assert.ok(b.height <= 680 && b.y >= 0 && b.y + b.height <= 680, `fits: ${JSON.stringify(b)}`);
    env.handlers.closeAll();
});

// ---- 全局设置 → 桌宠 ----

const fromMain = (env) => ({ sender: env.mainWindow.webContents });

function addOutfit(env, agentId, folder, name) {
    const dir = path.join(env.root, 'Agents', agentId, 'deskpet', folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'portrait.png'), 'x');
    fs.writeFileSync(path.join(dir, 'outfit.json'), JSON.stringify({ name, description: `${name}的介绍` }));
}

test('the settings page only answers the main window and lists the outfits of one agent', async () => {
    const env = await loadHandlers();
    addOutfit(env, 'Nova', 'maid', '女仆');
    addOutfit(env, 'Nova', 'tech', '科技服');
    const catalog = env.fake.handlers.get('deskpet-settings:catalog');
    assert.equal(await catalog({ sender: null }, 'Nova'), null, '不是主窗口发的不理');
    const page = await catalog(fromMain(env), 'Nova');
    assert.equal(page.agentId, 'Nova');
    assert.deepEqual(page.outfits.filter((o) => !o.builtIn).map((o) => o.name), ['科技服', '女仆'].sort((a, b) => a.localeCompare(b, 'zh')));
    assert.ok(page.outfits.filter((o) => o.builtIn).every((o) => o.kindLabel.startsWith('内置')), '自带的 Nova 形象标着内置');
    assert.equal(page.outfits.find((o) => o.id === 'maid').description, '女仆的介绍');
    assert.equal(page.open, false);
    assert.equal(page.outfit, null, '关着的桌宠选中的是「无」');
    assert.deepEqual(page.agents.map((a) => a.id).sort(), ['Coco', 'Nova']);
    env.handlers.closeAll();
});

test('picking a card opens the pet in that outfit, picking none closes it', async () => {
    const env = await loadHandlers();
    addOutfit(env, 'Nova', 'maid', '女仆');
    addOutfit(env, 'Nova', 'tech', '科技服');
    const choose = env.fake.handlers.get('deskpet-settings:choose');
    const result = await choose(fromMain(env), 'Nova', 'tech');
    assert.equal(result.success, true);
    const pet = env.petWindows()[0];
    assert.ok(pet, '没开着的桌宠打开了');
    assert.equal(env.readJson(path.join(env.root, 'deskpet', 'state.json')).Nova.outfit, 'tech', '直接按选的那套开');
    pet.emit('ready-to-show');
    assert.equal(result.catalog.outfit, 'tech');
    const switched = await choose(fromMain(env), 'Nova', 'maid');
    assert.equal(switched.catalog.outfit, 'maid', '开着的桌宠换装');
    const none = await choose(fromMain(env), 'Nova', '');
    assert.equal(none.success, true);
    assert.equal(env.petWindows().length, 0, '「无」收起这个助手的桌宠');
    assert.equal(none.catalog.outfit, null);
    assert.equal((await choose(fromMain(env), '../x', 'maid')).success, false);
    env.handlers.closeAll();
});

test('words typed in the settings preview wait until the pet page is ready, then the pet sends them', async () => {
    const env = await loadHandlers();
    const talk = env.fake.handlers.get('deskpet-settings:talk');
    assert.equal((await talk(fromMain(env), 'Nova', '   ')).success, false);
    const pending = talk(fromMain(env), 'Nova', '你好');
    await sleep(30);
    const pet = env.petWindows()[0];
    pet.emit('ready-to-show');
    assert.equal(pet.sent.some((m) => m.channel === 'deskpet:open-input'), false, '页面还没好，先不发');
    env.fake.listeners.get('deskpet:page-ready')({ sender: pet.webContents });
    assert.equal((await pending).success, true, '交到页面手里才算发出');
    assert.deepEqual(pet.sent.filter((m) => m.channel === 'deskpet:open-input').at(-1)?.payload, { submit: '你好', newTopic: false });
    // 第二句直接交给已经准备好的页面，不会顶掉第一句
    assert.equal((await talk(fromMain(env), 'Nova', '还在吗')).success, true);
    assert.deepEqual(pet.sent.filter((m) => m.channel === 'deskpet:open-input').map((m) => m.payload.submit), ['你好', '还在吗']);
    // 预览输入条上按了「+」：交给桌宠时带上开新话题
    assert.equal((await talk(fromMain(env), 'Nova', '换个话题', { newTopic: true })).success, true);
    assert.deepEqual(pet.sent.filter((m) => m.channel === 'deskpet:open-input').at(-1)?.payload, { submit: '换个话题', newTopic: true });
    env.handlers.closeAll();
});

test('words for a pet whose page fails to start come back as not sent', async () => {
    const env = await loadHandlers();
    const talk = env.fake.handlers.get('deskpet-settings:talk');
    const pending = talk(fromMain(env), 'Coco', '你好');
    await sleep(30);
    const pet = env.petWindows()[0];
    env.fake.listeners.get('deskpet:page-failed')({ sender: pet.webContents }, '模型载不进来');
    const result = await pending;
    assert.equal(result.success, false);
    assert.match(result.error, /模型载不进来/);
    assert.equal(pet.sent.some((m) => m.channel === 'deskpet:open-input'), false);
    env.handlers.closeAll();
});

test('show and hide from the settings page, and a closed pet remembers the size set there', async () => {
    const env = await loadHandlers();
    const visible = env.fake.handlers.get('deskpet-settings:set-visible');
    let page = await visible(fromMain(env), true, 'Coco');
    const coco = env.petWindows()[0];
    coco.emit('ready-to-show');
    assert.ok(coco.url.includes('agentId=Coco'), '一个都没开时打开正在看的那个助手');
    page = await visible(fromMain(env), false, 'Coco');
    assert.equal(coco.isVisible(), false);
    assert.equal(page.anyVisible, false);
    await env.fake.handlers.get('deskpet-settings:set-scale')(fromMain(env), 'Nova', 1.5);
    await sleep(30);
    assert.equal(env.readJson(path.join(env.root, 'deskpet', 'state.json')).Nova.scale, 1.5);
    env.handlers.closeAll();
});

test('card snapshots are rendered offscreen once and reused while the files stay the same', async () => {
    const env = await loadHandlers();
    addOutfit(env, 'Nova', 'maid', '女仆');
    const catalog = env.fake.handlers.get('deskpet-settings:catalog');
    const first = await catalog(fromMain(env), 'Nova');
    assert.equal(first.outfits[0].preview, null, '第一次没有现成的快照');
    const offscreen = env.fake.windows.find((w) => w.options.webPreferences?.offscreen);
    assert.ok(offscreen, '在离屏窗口里画');
    assert.match(offscreen.contentsUrl, /preview=1/);
    // 离屏页面问自己该画谁
    const assets = await env.fake.handlers.get('deskpet:get-assets')({ sender: offscreen.webContents });
    assert.equal(assets.preview, true);
    assert.equal(assets.outfit.id, 'maid');
    const job = new URL(offscreen.contentsUrl).searchParams.get('job');
    // 上一次渲染（超时了）迟到的报告：不能截成这一套
    env.fake.listeners.get('deskpet:preview-ready')({ sender: offscreen.webContents }, { bounds: { x: 0, y: 0, width: 50, height: 50 }, job: `${job}0` });
    await sleep(20);
    assert.equal(offscreen.captured, undefined);
    env.fake.listeners.get('deskpet:preview-ready')({ sender: offscreen.webContents }, { bounds: { x: 100, y: 200, width: 120, height: 300 }, aspect: 2.5, job });
    await sleep(50);
    assert.deepEqual(offscreen.captured, { x: 94, y: 194, width: 132, height: 312 }, '只截角色那一块，四周留一点边');
    const pushed = env.mainWindow.sent.find((m) => m.channel === 'deskpet-settings:preview');
    assert.equal(pushed.payload.outfitId, 'maid');
    assert.match(pushed.payload.url, /^file:.*\.png\?v=/);
    const second = await catalog(fromMain(env), 'Nova');
    assert.equal(second.outfits[0].preview, pushed.payload.url, '文件没变就直接用');
    env.handlers.closeAll();
});

test('a snapshot taken before the offscreen frame is drawn is retried, and a blank one is never cached', async () => {
    const env = await loadHandlers();
    addOutfit(env, 'Nova', 'maid', '女仆');
    const catalog = env.fake.handlers.get('deskpet-settings:catalog');
    await catalog(fromMain(env), 'Nova');
    const offscreen = env.fake.windows.find((w) => w.options.webPreferences?.offscreen);
    const ready = (win) => env.fake.listeners.get('deskpet:preview-ready')({ sender: win.webContents }, {
        bounds: { x: 10, y: 10, width: 40, height: 80 }, job: new URL(win.contentsUrl).searchParams.get('job'),
    });
    offscreen.blankFrames = 2;
    ready(offscreen);
    await sleep(900);
    assert.equal(offscreen.captures, 3, '前两张是空的，再截一次');
    const pushed = env.mainWindow.sent.filter((m) => m.channel === 'deskpet-settings:preview');
    assert.match(pushed.at(-1).payload.url, /^file:.*\.png\?v=/);

    env.handlers.closeAll();

    // 一直截不到东西：这一套不存快照，下次打开设置页还会重画
    const env2 = await loadHandlers();
    addOutfit(env2, 'Nova', 'maid', '女仆');
    await env2.fake.handlers.get('deskpet-settings:catalog')(fromMain(env2), 'Nova');
    const blankWin = env2.fake.windows.find((w) => w.options.webPreferences?.offscreen);
    blankWin.blankFrames = 99;
    env2.fake.listeners.get('deskpet:preview-ready')({ sender: blankWin.webContents }, {
        bounds: { x: 10, y: 10, width: 40, height: 80 }, job: new URL(blankWin.contentsUrl).searchParams.get('job'),
    });
    await sleep(2200);
    const last = env2.mainWindow.sent.filter((m) => m.channel === 'deskpet-settings:preview').at(-1);
    assert.equal(last.payload.url, null);
    const third = await env2.fake.handlers.get('deskpet-settings:catalog')(fromMain(env2), 'Nova');
    assert.equal(third.outfits[0].preview, null, '空白的没缓存下来');
    env2.handlers.closeAll();
});

test('the settings file and the settings page never claim the same channel', () => {
    const { createPetControls } = require('../modules/deskpet/petControls.js');
    const { createSettingsPage } = require('../modules/deskpet/settingsPage.js');
    const channels = new Set();
    // 和 Electron 一样，同一个频道注册两次直接报错
    const ipcMain = {
        handle(channel) {
            if (channels.has(channel)) throw new Error(`second handler for ${channel}`);
            channels.add(channel);
        },
        on() {},
    };
    const electron = { ipcMain, globalShortcut: { register() { return true; }, unregister() {}, isRegistered() { return false; } }, dialog: {}, shell: {} };
    const controls = createPetControls({ electron, appDataRoot: os.tmpdir(), actions: {} });
    controls.registerIpc();
    createSettingsPage({ electron, paths: { agentDir: os.tmpdir() }, controls, previews: {}, pets: {} }).registerIpc();
    assert.ok(channels.has('deskpet-settings:get'));
    controls.dispose?.();
});
