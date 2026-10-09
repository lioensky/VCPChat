// modules/deskpet/petPrefs.js
// 桌宠的设置和尺寸计算（纯函数，主进程和测试共用）。
//
// 尺寸：窗口坐标和宽高都是 Electron 的 DIP（与显示器缩放无关的逻辑像素），系统再按显示器缩放换成物理像素，
// 所以同一个大小在 100%、150% 的屏上看起来一样大。宽高取 4 的倍数：125%、150%、175% 下换成物理像素都是整数，
// Windows 不会因为取整把窗口一点点撑大（以前 320 宽在 150% 下会变成 322）。

'use strict';

// 1 倍大小时角色占的区域；上方另外留出气泡和输入框的高度（与页面 TOP_RESERVE 一致）。
// 还不知道形象的长宽比（头像、第一次打开）时用这一个。
// 第一版的 1 倍太占地方，第二版（SIZE_VERSION 2）把角色区整体缩到原来的六成。
const SIZE_FACTOR = 0.6;
const SIZE_VERSION = 2;
const BASE_CHARACTER = Object.freeze({ width: 360 * SIZE_FACTOR, height: 430 * SIZE_FACTOR });
// 知道形象的长宽比（高 ÷ 宽，按不透明像素算）以后，角色区跟着比例走：
// 半身立绘、Q 版（高宽比 1.6 以内）和以前一样高，宽度按比例收；竖长的全身像（2.6 以上）高到 324，
// 中间平滑过渡。全身像的人比半身像小一截是自然的，但不至于高出半个屏幕。
const FIGURE = Object.freeze({ tallFrom: 1.6, tallTo: 2.6, tallHeight: 540 * SIZE_FACTOR, maxWidth: 420 * SIZE_FACTOR, sideRoom: 1.15 });
const UI_RESERVE = 150;
// 脚下留给小胶囊的高度（与页面 FOOT_RESERVE 一致）：胶囊在脚底下，不压着脚。
const FOOT_RESERVE = 54;
// 窗口再窄，气泡和输入框也排不下了；输入条要比角色宽出一截（约三个小胶囊宽），按这个定。
// 角色两边多出来的是透明的，鼠标照样穿过去，贴边按角色本身算。
const MIN_WIDTH = 360;
const SCALE_MIN = 0.5;
// 新的 1 倍小了，上限放到 3 倍：以前调到 2 倍的人换算过来还放得下
const SCALE_MAX = 3;
const SCALE_STEP = 0.1;
const SIZE_GRID = 4;

const SHORTCUT_ACTIONS = Object.freeze({
    toggle: { label: '显示/隐藏桌宠', defaultAccelerator: 'CommandOrControl+Alt+Shift+P' },
    talk: { label: '和桌宠说话', defaultAccelerator: 'CommandOrControl+Alt+Shift+M' },
    // 按一下开始录音，再按一下识别完直接发出去（不用碰鼠标）。
    // 这两个默认不占键：全局快捷键对所有程序生效，Cmd+Opt+Shift+V（macOS 的「粘贴并匹配样式」）、
    // Ctrl+Alt+Shift+T（JetBrains 的重构）这类组合一占，别的程序里就按不出来了。要用在设置页里录一个。
    voice: { label: '对桌宠说话（语音，再按一下发送）', defaultAccelerator: '' },
    clickThrough: { label: '只看不点（鼠标穿透）', defaultAccelerator: '' },
});

// VCPChat 自己已经占用的组合键（全局快捷键和菜单），桌宠不能抢。
const RESERVED_ACCELERATORS = Object.freeze([
    'CommandOrControl+Shift+I',
    'CommandOrControl+Shift+N',
    'CommandOrControl+Shift+P',
    'CommandOrControl+Shift+Z',
    'Alt+Super+Z',
    'CommandOrControl+Q',
    'Alt+F4',
]);

const DEFAULT_SETTINGS = Object.freeze({
    doNotDisturb: false,
    restoreOnLaunch: true,
    // 别的程序全屏时先躲开（只在 Windows 上做，见 modules/deskpet/fullscreenWatch.js）。
    // 先默认关着，等 Windows 上的 CI 验证过检测脚本再打开
    yieldToFullscreen: false,
    // 只看不点：鼠标整个穿过桌宠，点不到也拖不动；托盘、快捷键关掉
    clickThrough: false,
    // 角色的不透明度（气泡、输入框不跟着变淡）
    opacity: 1,
    // 溜达：站在任务栏上闲了一阵会沿着任务栏走一小段（Live2D 模型没有走路动作，默认关）
    wander: false,
    // 视线跟着光标走；关掉后只自己四处看（光标在屏幕上来回动时不会一直盯着）
    followCursor: true,
    // 截图、录屏、共享屏幕时桌宠不出现在画面里（Windows、macOS 有效）
    hideFromCapture: false,
    // 闲时主动搭话：人在电脑前、这么久（分钟）没和助手说话时让 TA 说一句（会调用模型，默认关）
    idleChat: false,
    idleChatMinutes: 30,
    shortcuts: Object.freeze(Object.fromEntries(
        Object.entries(SHORTCUT_ACTIONS).map(([id, action]) => [id, action.defaultAccelerator]),
    )),
    // 上次退出时开着的桌宠（按打开顺序），启动时据此恢复。
    openAgents: Object.freeze([]),
    // 最近一次用过的桌宠，快捷键在一个桌宠都没开时打开它。
    lastAgent: null,
});

function roundToGrid(value) {
    return Math.round(value / SIZE_GRID) * SIZE_GRID;
}

function clampScale(scale) {
    const value = Number(scale);
    if (!Number.isFinite(value)) return 1;
    // 只保留到 0.05，避免浮点累加出 1.0000000002 这种值写进设置。
    return Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, value)) * 20) / 20;
}

function isAspect(aspect) {
    const a = Number(aspect);
    return Number.isFinite(a) && a >= 0.25 && a <= 8;
}

/** 1 倍大小时角色区的宽高。aspect 是形象的高 ÷ 宽（页面量出来报给主进程），不知道时用默认的。 */
function characterBox(aspect) {
    if (!isAspect(aspect)) return BASE_CHARACTER;
    const a = Number(aspect);
    const tall = Math.min(1, Math.max(0, (a - FIGURE.tallFrom) / (FIGURE.tallTo - FIGURE.tallFrom)));
    const height = BASE_CHARACTER.height + (FIGURE.tallHeight - BASE_CHARACTER.height) * tall;
    // 两边留一点：Live2D 抬手、拖动时身子甩起来不碰窗口边
    const width = Math.min(FIGURE.maxWidth, (height / a) * FIGURE.sideRoom);
    return { width, height };
}

/**
 * 旧版（sizeVersion < 2）记下的窗口位置换到新尺寸下：旧窗口没有脚下的余量、1 倍也更大，
 * 原样用左上角的话脚会离开原来站的地方（站在任务栏上的会悬空）。按角色脚底中点对齐算新的左上角。
 * scale 是换算后的新倍数；不是旧版记录、没有位置时返回 null。
 */
function legacyPosition(saved, aspect, scale) {
    if (!saved || Number(saved.sizeVersion) >= SIZE_VERSION) return null;
    // 旧版量完形象就会记一次大小；没记过大小的是新版里还没改过大小的，不动
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y) || saved.scale == null || !Number.isFinite(Number(saved.scale))) return null;
    const raw = Number(saved.scale);
    const box = characterBox(aspect);
    const oldWidth = Math.max(280, roundToGrid((box.width / SIZE_FACTOR) * raw));
    const oldFeet = saved.y + UI_RESERVE + (box.height / SIZE_FACTOR) * raw;
    const size = windowSizeForScale(scale, aspect);
    return {
        x: Math.round(saved.x + (oldWidth - size.width) / 2),
        y: Math.round(oldFeet - UI_RESERVE - box.height * clampScale(scale)),
    };
}

/** 某个大小对应的窗口宽高（DIP，4 的倍数）。 */
function windowSizeForScale(scale, aspect) {
    const s = clampScale(scale);
    const box = characterBox(aspect);
    return {
        width: Math.max(MIN_WIDTH, roundToGrid(box.width * s)),
        height: roundToGrid(UI_RESERVE + box.height * s + FOOT_RESERVE),
    };
}

/** 这块工作区（显示器去掉任务栏）最多能放多大。 */
function maxScaleForWorkArea(workArea, aspect) {
    if (!workArea || !(workArea.height > 0)) return SCALE_MAX;
    const fit = (workArea.height - UI_RESERVE - FOOT_RESERVE) / characterBox(aspect).height;
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.floor(fit * 20) / 20));
}

/**
 * state.json 里记的大小换成现在的倍数。第一版记的倍数是按大的那套 1 倍算的：
 * 没调过（1 倍）的直接用新的默认；调过的换算成同样的实际大小，看起来不变。
 */
function savedScale(saved) {
    const raw = Number(saved?.scale);
    if (!Number.isFinite(raw)) return 1;
    if (Number(saved.sizeVersion) >= SIZE_VERSION) return clampScale(raw);
    if (Math.abs(raw - 1) < 0.001) return 1;
    return clampScale(raw / SIZE_FACTOR);
}

function fitScale(scale, workArea, aspect) {
    return Math.min(clampScale(scale), maxScaleForWorkArea(workArea, aspect));
}

/** 页面报上来的长宽比：不合理的值丢掉，其余保留两位小数（同一个形象每次量出来差一点点不算变了）。 */
// 同一套形象每次量出来会差一点（Live2D 量的时候正呼吸、做待机动作）：相差 5% 以内算同一个比例，不改窗口、不重记
const ASPECT_TOLERANCE = 0.05;
function sameAspect(a, b) {
    return isAspect(a) && isAspect(b) && Math.abs(Number(a) - Number(b)) / Number(b) < ASPECT_TOLERANCE;
}

function normalizeAspect(aspect) {
    return isAspect(aspect) ? Math.round(Number(aspect) * 100) / 100 : null;
}

/**
 * 换大小时窗口的新位置：脚底中点不动（角色站在原地变大变小），再挪回工作区里。
 * bounds 是当前窗口，size 是新宽高。
 */
function resizeAnchored(bounds, size, workArea) {
    let x = Math.round(bounds.x + (bounds.width - size.width) / 2);
    let y = Math.round(bounds.y + bounds.height - size.height);
    if (workArea) {
        x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - size.width);
        y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - size.height);
    }
    return { x, y, ...size };
}

// ---- 快捷键 -------------------------------------------------------------------

const MODIFIER_ALIASES = {
    commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl', control: 'CommandOrControl', ctrl: 'CommandOrControl',
    command: 'CommandOrControl', cmd: 'CommandOrControl',
    alt: 'Alt', option: 'Alt', altgr: 'Alt',
    shift: 'Shift',
    super: 'Super', meta: 'Super', win: 'Super',
};
const MODIFIER_ORDER = ['CommandOrControl', 'Alt', 'Shift', 'Super'];
const NAMED_KEYS = new Map([
    ...['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Enter', 'Home', 'End', 'PageUp', 'PageDown',
        'Up', 'Down', 'Left', 'Right', 'Plus', 'Escape'].map((k) => [k.toLowerCase(), k]),
    ['return', 'Enter'], ['esc', 'Escape'], ['arrowup', 'Up'], ['arrowdown', 'Down'], ['arrowleft', 'Left'],
    ['arrowright', 'Right'], ['del', 'Delete'],
]);
const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`']);

function normalizeKey(raw) {
    const key = String(raw || '').trim();
    if (!key) return null;
    if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
    if (PUNCTUATION.has(key)) return key;
    return NAMED_KEYS.get(key.toLowerCase()) || null;
}

/**
 * 规范化一个组合键（Electron accelerator 写法）。不合法时返回 null，空字符串表示「不用快捷键」。
 * 要求：一个主键，加上至少两个修饰键（F1–F24 至少一个），且不能只有 Shift。
 * 这样不会抢走打字和各程序常用的 Ctrl+字母。
 */
function normalizeAccelerator(value) {
    if (value === '' || value === null) return '';
    if (typeof value !== 'string') return null;
    const parts = value.split('+').map((p) => p.trim());
    // "Ctrl+Plus" 写成 "Ctrl++" 时 split 会出空串，统一按 Plus 处理
    if (value.endsWith('++')) parts.splice(parts.length - 2, 2, 'Plus');
    const modifiers = new Set();
    let key = null;
    for (const part of parts) {
        const modifier = MODIFIER_ALIASES[part.toLowerCase()];
        if (modifier) { modifiers.add(modifier); continue; }
        if (key) return null;
        key = normalizeKey(part);
        if (!key) return null;
    }
    if (!key) return null;
    const isFunctionKey = /^F\d+$/.test(key);
    const strong = [...modifiers].filter((m) => m !== 'Shift').length;
    if (!isFunctionKey && (modifiers.size < 2 || strong < 1)) return null;
    if (isFunctionKey && modifiers.size < 1) return null;
    return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join('+');
}

function isReserved(accelerator) {
    return RESERVED_ACCELERATORS.includes(accelerator);
}

// ---- 设置文件 -------------------------------------------------------------------

function isAgentIdLike(value) {
    return typeof value === 'string' && value.length > 0 && value.length < 200 && !/[\\/]/.test(value) && value !== '.' && value !== '..';
}

const OPACITY_MIN = 0.3;
// 闲时主动搭话的间隔可选项（分钟），与 modules/deskpet/idleChat.js 一致
const IDLE_CHAT_MINUTES = Object.freeze([10, 30, 60]);

/** 不透明度：0.3–1，按 0.05 取整；不是数就当 1 */
function normalizeOpacity(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || value === null || value === '') return 1;
    return Math.round(Math.min(1, Math.max(OPACITY_MIN, n)) * 20) / 20;
}

/** 把磁盘上读到的设置（可能缺字段、被手改坏）整理成完整、合法的设置。 */
// 设置文件的格式版本。2：语音、只看不点两个快捷键默认不再占键；之前的文件里存着的旧默认键当作没设
const SETTINGS_VERSION = 2;
const RETIRED_DEFAULTS = Object.freeze({
    voice: 'CommandOrControl+Alt+Shift+V',
    clickThrough: 'CommandOrControl+Alt+Shift+T',
});

function normalizeSettings(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const legacy = !(Number(input.version) >= SETTINGS_VERSION);
    const shortcuts = {};
    for (const id of Object.keys(SHORTCUT_ACTIONS)) {
        let given = input.shortcuts && Object.prototype.hasOwnProperty.call(input.shortcuts, id) ? input.shortcuts[id] : undefined;
        if (legacy && given !== undefined && RETIRED_DEFAULTS[id] && normalizeAccelerator(given) === RETIRED_DEFAULTS[id]) given = undefined;
        const normalized = given === undefined ? DEFAULT_SETTINGS.shortcuts[id] : normalizeAccelerator(given);
        shortcuts[id] = normalized === null || isReserved(normalized) ? DEFAULT_SETTINGS.shortcuts[id] : normalized;
    }
    // 几个动作撞了同一个键：排在后面的作废
    const used = new Set();
    for (const id of Object.keys(shortcuts)) {
        if (!shortcuts[id]) continue;
        if (used.has(shortcuts[id])) shortcuts[id] = '';
        else used.add(shortcuts[id]);
    }
    const openAgents = Array.isArray(input.openAgents) ? [...new Set(input.openAgents.filter(isAgentIdLike))].slice(0, 16) : [];
    return {
        version: SETTINGS_VERSION,
        doNotDisturb: input.doNotDisturb === true,
        restoreOnLaunch: input.restoreOnLaunch !== false,
        yieldToFullscreen: input.yieldToFullscreen === true,
        clickThrough: input.clickThrough === true,
        opacity: normalizeOpacity(input.opacity),
        wander: input.wander === true,
        followCursor: input.followCursor !== false,
        hideFromCapture: input.hideFromCapture === true,
        idleChat: input.idleChat === true,
        idleChatMinutes: IDLE_CHAT_MINUTES.includes(Number(input.idleChatMinutes)) ? Number(input.idleChatMinutes) : 30,
        shortcuts,
        openAgents,
        lastAgent: isAgentIdLike(input.lastAgent) ? input.lastAgent : null,
    };
}

module.exports = {
    normalizeOpacity,
    OPACITY_MIN,
    IDLE_CHAT_MINUTES,
    BASE_CHARACTER,
    SIZE_VERSION,
    UI_RESERVE,
    FOOT_RESERVE,
    SCALE_MIN,
    SCALE_MAX,
    SCALE_STEP,
    SHORTCUT_ACTIONS,
    RESERVED_ACCELERATORS,
    DEFAULT_SETTINGS,
    clampScale,
    savedScale,
    characterBox,
    normalizeAspect,
    sameAspect,
    windowSizeForScale,
    maxScaleForWorkArea,
    fitScale,
    resizeAnchored,
    legacyPosition,
    normalizeAccelerator,
    isReserved,
    normalizeSettings,
    SETTINGS_VERSION,
};
