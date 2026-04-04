/**
 * modules/ipc/desktopHandlers.js
 * VCPdesktop IPC 澶勭悊妯″潡
 * 璐熻矗锛氭闈㈢獥鍙ｅ垱寤虹鐞嗐€佹祦寮忔帹閫佽浆鍙戙€佹敹钘忕郴缁熸寔涔呭寲銆佸揩鎹锋柟寮忚В鏋?鍚姩銆丏ock鎸佷箙鍖栥€佸竷灞€鎸佷箙鍖栥€佸绾告枃浠堕€夋嫨銆乂Chat鍐呴儴搴旂敤鍚姩
 */

const { BrowserWindow, ipcMain, app, screen, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const desktopMetrics = require('./desktopMetrics');
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveAppPreload } = require('../services/preloadPaths');

// --- 妯″潡鐘舵€?---
let desktopWindow = null;
let mainWindow = null;
let openChildWindows = [];
let appSettingsManager = null;
let alwaysOnBottomEnabled = false;
let alwaysOnBottomInterval = null;

// --- 鐙珛 Electron App 瀛愯繘绋嬪紩鐢紙闃叉閲嶅鍚姩锛?---
const standaloneAppProcesses = new Map(); // appDir -> child_process

// --- VChat 鍐呴儴瀛愮獥鍙ｅ崟渚嬪紩鐢?---
let vchatForumWindow = null;
let vchatMemoWindow = null;
let vchatTranslatorWindow = null;
let vchatMusicWindow = null;
let vchatThemesWindow = null;

// --- 鏀惰棌绯荤粺璺緞 - 浣跨敤椤圭洰鏍圭洰褰曠殑 AppData ---
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DESKTOP_WIDGETS_DIR = path.join(PROJECT_ROOT, 'AppData', 'DesktopWidgets');
const DESKTOP_DATA_DIR = path.join(PROJECT_ROOT, 'AppData', 'DesktopData');
const DOCK_CONFIG_PATH = path.join(DESKTOP_DATA_DIR, 'dock.json');
const LAYOUT_CONFIG_PATH = path.join(DESKTOP_DATA_DIR, 'layout.json');
const CATALOG_PATH = path.join(DESKTOP_WIDGETS_DIR, 'CATALOG.md');

/**
 * 鑷姩鐢熸垚 CATALOG.md 鈥斺€?鏀惰棌鎸備欢鐩綍绱㈠紩
 *
 * 閬嶅巻 DesktopWidgets 鐩綍涓墍鏈夊瓙鏂囦欢澶癸紝璇诲彇 meta.json锛?
 * 鐢熸垚涓€浠戒汉绫诲彲璇荤殑 Markdown 鏂囨。锛屾柟渚?AI 鎴栫敤鎴烽€氳繃 list 鎸囦护
 * 蹇€熶簡瑙ｆ瘡涓枃浠跺す瀵瑰簲鐨勬彃浠跺悕绉板拰鍐呴儴鏂囦欢缁撴瀯銆?
 *
 * 璇ュ嚱鏁板湪浠ヤ笅鏃舵満鑷姩璋冪敤锛?
 *   - 淇濆瓨/鏇存柊鏀惰棌鍚?(desktop-save-widget)
 *   - 鍒犻櫎鏀惰棌鍚?(desktop-delete-widget)
 *   - 鍒濆鍖栨椂 (initialize)
 */
async function generateCatalog() {
    try {
        await fs.ensureDir(DESKTOP_WIDGETS_DIR);
        const entries = await fs.readdir(DESKTOP_WIDGETS_DIR, { withFileTypes: true });

        // 鏀堕泦鎵€鏈?widget 淇℃伅
        const widgets = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, entry.name);
            const metaPath = path.join(widgetDir, 'meta.json');

            let meta = { id: entry.name, name: entry.name };
            if (await fs.pathExists(metaPath)) {
                try {
                    meta = await fs.readJson(metaPath);
                } catch (e) { /* ignore */ }
            }

            // 閫掑綊鏀堕泦鏂囦欢鏍?
            const fileTree = await collectFileTree(widgetDir, '');

            widgets.push({
                dirName: entry.name,
                name: meta.name || entry.name,
                id: meta.id || entry.name,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                fileTree,
            });
        }

        // 鎸夊悕绉版帓搴?
        widgets.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));

        // 鐢熸垚 Markdown 鍐呭
        const lines = [];
        lines.push('# 馃摝 妗岄潰鎸備欢鏀惰棌鐩綍 (CATALOG)');
        lines.push('');
        lines.push('> Auto-generated catalog. Do not edit manually.');
        lines.push(`> Last updated: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        lines.push('');
        lines.push(`Total **${widgets.length}** widgets.`);
        lines.push('');

        if (widgets.length > 0) {
            // 蹇€熺储寮曡〃
            lines.push('## Quick Index');
            lines.push('');
            lines.push('| # | 鏀惰棌鍚嶇О | 鏂囦欢澶?ID | 鍒涘缓鏃堕棿 | 鏇存柊鏃堕棿 |');
            lines.push('|---|---------|----------|---------|---------|');
            widgets.forEach((w, i) => {
                const created = w.createdAt ? new Date(w.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '鏈煡';
                const updated = w.updatedAt ? new Date(w.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '鏈煡';
                lines.push(`| ${i + 1} | **${w.name}** | \`${w.dirName}\` | ${created} | ${updated} |`);
            });
            lines.push('');

            // 璇︾粏鏂囦欢鏍?
            lines.push('## File Tree');
            lines.push('');
            for (const w of widgets) {
                lines.push(`### ${w.name}`);
                lines.push('');
                lines.push(`- **鏂囦欢澶?*: \`${w.dirName}/\``);
                lines.push(`- **鏀惰棌 ID**: \`${w.id}\``);
                if (w.createdAt) {
                    lines.push(`- **鍒涘缓鏃堕棿**: ${new Date(w.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
                }
                if (w.updatedAt) {
                    lines.push(`- **鏇存柊鏃堕棿**: ${new Date(w.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
                }
                lines.push('');
                lines.push('```');
                lines.push(`${w.dirName}/`);
                for (const file of w.fileTree) {
                    lines.push(`  ${file}`);
                }
                lines.push('```');
                lines.push('');
            }
        }

        await fs.writeFile(CATALOG_PATH, lines.join('\n'), 'utf-8');
        console.log(`[DesktopHandlers] CATALOG.md updated (${widgets.length} widgets)`);
    } catch (err) {
        console.error('[DesktopHandlers] Failed to generate CATALOG.md:', err);
    }
}

/**
 * 閫掑綊鏀堕泦鐩綍涓嬬殑鏂囦欢鍒楄〃锛堢浉瀵硅矾寰勶級
 * @param {string} dirPath - 缁濆鐩綍璺緞
 * @param {string} prefix - 褰撳墠閫掑綊鍓嶇紑锛堢敤浜庣缉杩涙樉绀猴級
 * @returns {Promise<string[]>} 鏂囦欢璺緞鍒楄〃
 */
async function collectFileTree(dirPath, prefix) {
    const result = [];
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        // 鎺掑簭锛氱洰褰曞湪鍓嶏紝鏂囦欢鍦ㄥ悗
        entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            if (entry.name === 'CATALOG.md') continue; // 璺宠繃鑷韩
            if (entry.isDirectory()) {
                result.push(`${prefix}${entry.name}/`);
                const subFiles = await collectFileTree(path.join(dirPath, entry.name), prefix + '  ');
                result.push(...subFiles);
            } else {
                // 闄勫姞鏂囦欢澶у皬淇℃伅
                try {
                    const stat = await fs.stat(path.join(dirPath, entry.name));
                    const sizeStr = formatFileSize(stat.size);
                    result.push(`${prefix}${entry.name}  (${sizeStr})`);
                } catch (e) {
                    result.push(`${prefix}${entry.name}`);
                }
            }
        }
    } catch (e) { /* ignore */ }
    return result;
}

/**
 * 鏍煎紡鍖栨枃浠跺ぇ灏?
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 妫€娴嬪浘鏍囨槸鍚︽湁鏁堬紙闈炵┖鐧?闈炲叏閫忔槑锛?
 * Windows 瀵规煇浜涚郴缁熷簲鐢紙濡?UWP/MSIX锛夊彲鑳借繑鍥炰竴涓潪绌轰絾鍑犱箮鍏ㄩ€忔槑鎴栧叏鐧界殑鍥炬爣锛?
 * 杩欑被鍥炬爣铏界劧 isEmpty() 杩斿洖 false锛屼絾瑙嗚涓婃槸绌虹櫧鐨勩€?
 * @param {Electron.NativeImage} nativeImg - Electron NativeImage 瀵硅薄
 * @returns {boolean} 鍥炬爣鏄惁鏈夋剰涔夛紙鏈夊彲瑙佸唴瀹癸級
 */
function isIconValid(nativeImg) {
    try {
        const bitmap = nativeImg.toBitmap();
        const size = nativeImg.getSize();
        if (!bitmap || bitmap.length === 0 || size.width === 0 || size.height === 0) {
            return false;
        }

        const totalPixels = size.width * size.height;
        let opaquePixels = 0;          // 鏈変笉閫忔槑搴︾殑鍍忕礌
        let colorfulPixels = 0;        // 鏈夊疄闄呴鑹诧紙闈炵函鐧?绾粦锛夌殑鍍忕礌

        // RGBA 鏍煎紡锛屾瘡鍍忕礌 4 瀛楄妭
        // 閲囨牱妫€娴嬶細涓轰簡鎬ц兘锛屽澶у浘鍙噰鏍烽儴鍒嗗儚绱?
        const step = totalPixels > 1024 ? Math.floor(totalPixels / 512) : 1;

        for (let i = 0; i < totalPixels; i += step) {
            const offset = i * 4;
            const r = bitmap[offset];
            const g = bitmap[offset + 1];
            const b = bitmap[offset + 2];
            const a = bitmap[offset + 3];

            if (a > 20) {
                opaquePixels++;
                // 妫€鏌ユ槸鍚︽湁瀹為檯棰滆壊锛堥潪鎺ヨ繎绾櫧鎴栫函榛戯級
                if (!((r > 240 && g > 240 && b > 240) || (r < 15 && g < 15 && b < 15))) {
                    colorfulPixels++;
                }
            }
        }

        const sampledPixels = Math.ceil(totalPixels / step);
        const opaqueRatio = opaquePixels / sampledPixels;

        // 濡傛灉涓嶉€忔槑鍍忕礌灏戜簬 5%锛屽垽瀹氫负绌虹櫧鍥炬爣
        if (opaqueRatio < 0.05) {
            return false;
        }

        // 鍥炬爣鏈夎冻澶熺殑涓嶉€忔槑鍐呭锛岃涓烘湁鏁?
        return true;
    } catch (e) {
        // 妫€娴嬪け璐ユ椂淇濆畧鍦拌涓哄浘鏍囨湁鏁?
        console.warn('[DesktopHandlers] isIconValid check failed:', e.message);
        return true;
    }
}

/**
 * 鍦ㄦ墍鏈夊凡鎵撳紑鐨勭獥鍙ｄ腑鏌ユ壘 URL 鍖呭惈鎸囧畾鍏抽敭璇嶇殑绐楀彛
 * @param {string} urlKeyword - URL 涓渶瑕佸寘鍚殑鍏抽敭璇嶏紙濡?'forum.html'锛?
 * @returns {BrowserWindow|null}
 */
function findWindowByUrl(urlKeyword) {
    const allWindows = BrowserWindow.getAllWindows();
    return allWindows.find(win => {
        if (win.isDestroyed()) return false;
        try {
            const url = win.webContents.getURL();
            return url.includes(urlKeyword);
        } catch (e) {
            return false;
        }
    }) || null;
}

/**
 * 鍒涘缓鎴栬仛鐒︿竴涓€氱敤瀛愮獥鍙ｏ紙鐢ㄤ簬 VChat 鍐呴儴搴旂敤锛?
 * @param {BrowserWindow|null} existingWindow - 鐜版湁绐楀彛寮曠敤
 * @param {object} options - 绐楀彛閰嶇疆
 * @returns {BrowserWindow} 鍒涘缓鎴栬仛鐒﹀悗鐨勭獥鍙?
 */
function createOrFocusChildWindow(existingWindow, options) {
    if (existingWindow && !existingWindow.isDestroyed()) {
        if (!existingWindow.isVisible()) existingWindow.show();
        existingWindow.focus();
        return existingWindow;
    }

    const win = new BrowserWindow({
        width: options.width || 1000,
        height: options.height || 700,
        minWidth: options.minWidth || 600,
        minHeight: options.minHeight || 400,
        title: options.title || 'VChat',
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        modal: false,
        webPreferences: {
            preload: options.preloadPath || resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.UTILITY),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true,
        },
        icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
        show: false,
    });

    // 鏋勫缓 URL
    let url = `file://${options.htmlPath}`;
    if (options.queryParams) {
        url += `?${options.queryParams}`;
    }

    win.loadURL(url);
    win.setMenu(null);

    if (openChildWindows) {
        openChildWindows.push(win);
    }

    win.once('ready-to-show', () => {
        win.show();
    });

    win.on('close', (evt) => {
        if (process.platform === 'darwin' && !app.isQuitting) {
            evt.preventDefault();
            win.hide();
        }
    });

    win.on('closed', () => {
        if (openChildWindows) {
            const idx = openChildWindows.indexOf(win);
            if (idx > -1) openChildWindows.splice(idx, 1);
        }
        // 娓呯悊鍗曚緥寮曠敤
        if (win === vchatForumWindow) vchatForumWindow = null;
        if (win === vchatMemoWindow) vchatMemoWindow = null;
        if (win === vchatTranslatorWindow) vchatTranslatorWindow = null;
        if (win === vchatThemesWindow) vchatThemesWindow = null;
    });

    console.log(`[DesktopHandlers] Created child window: ${options.title}`);
    return win;
}

function ensureMainWindowVisible() {
    let targetMainWindow = mainWindow;
    if (!targetMainWindow || targetMainWindow.isDestroyed()) {
        const allWindows = BrowserWindow.getAllWindows();
        targetMainWindow = allWindows.find(win => {
            if (win.isDestroyed()) return false;
            const url = win.webContents.getURL();
            return url.includes('main.html') && !url.includes('desktop.html');
        });
    }

    if (!targetMainWindow || targetMainWindow.isDestroyed()) {
        throw new Error('Main window is not available.');
    }

    if (!targetMainWindow.isVisible()) targetMainWindow.show();
    if (targetMainWindow.isMinimized()) targetMainWindow.restore();
    targetMainWindow.focus();
    return targetMainWindow;
}

function registerManagedWindows() {
    windowService.register(WINDOW_APP_IDS.MAIN, {
        owner: 'desktopHandlers',
        getWindow: () => mainWindow,
        open: async () => ensureMainWindowVisible(),
    });

    windowService.register(WINDOW_APP_IDS.DESKTOP, {
        owner: 'desktopHandlers',
        getWindow: () => desktopWindow,
        open: async () => openDesktopWindow(),
    });

    windowService.register(WINDOW_APP_IDS.NOTES, {
        owner: 'notesHandlers',
        getWindow: () => {
            const notesHandlers = require('./notesHandlers');
            return notesHandlers.getNotesWindow();
        },
        open: async () => {
            const notesHandlers = require('./notesHandlers');
            return notesHandlers.createOrFocusNotesWindow();
        },
        payloadChannel: 'shared-note-data',
        readyTimeoutMs: 10000,
    });

    windowService.register(WINDOW_APP_IDS.MEMO, {
        owner: 'desktopHandlers',
        getWindow: () => vchatMemoWindow || findWindowByUrl('memo.html'),
        open: async () => {
            const existingMemo = findWindowByUrl('memo.html');
            if (existingMemo) {
                if (!existingMemo.isVisible()) existingMemo.show();
                existingMemo.focus();
                vchatMemoWindow = existingMemo;
                return existingMemo;
            }
            vchatMemoWindow = createOrFocusChildWindow(vchatMemoWindow, {
                width: 1200, height: 800, minWidth: 800, minHeight: 600,
                title: 'VCP Memo Center',
                htmlPath: path.join(app.getAppPath(), 'Memomodules', 'memo.html'),
            });
            return vchatMemoWindow;
        },
    });

    windowService.register(WINDOW_APP_IDS.FORUM, {
        owner: 'desktopHandlers',
        getWindow: () => vchatForumWindow || findWindowByUrl('forum.html'),
        open: async () => {
            const existingForum = findWindowByUrl('forum.html');
            if (existingForum) {
                if (!existingForum.isVisible()) existingForum.show();
                existingForum.focus();
                vchatForumWindow = existingForum;
                return existingForum;
            }
            vchatForumWindow = createOrFocusChildWindow(vchatForumWindow, {
                width: 1200, height: 800, minWidth: 800, minHeight: 600,
                title: 'VCP Forum',
                htmlPath: path.join(app.getAppPath(), 'Forummodules', 'forum.html'),
            });
            return vchatForumWindow;
        },
    });

    windowService.register(WINDOW_APP_IDS.RAG_OBSERVER, {
        owner: 'ragHandlers',
        getWindow: () => {
            const ragHandlers = require('./ragHandlers');
            return ragHandlers.getRagObserverWindow();
        },
        open: async () => {
            const ragHandlers = require('./ragHandlers');
            await ragHandlers.openRagObserverWindow();
            return ragHandlers.getRagObserverWindow();
        },
    });

    windowService.register(WINDOW_APP_IDS.DICE, {
        owner: 'diceHandlers',
        getWindow: () => {
            const diceHandlers = require('./diceHandlers');
            return diceHandlers.getDiceWindow();
        },
        open: async () => {
            const diceHandlers = require('./diceHandlers');
            await diceHandlers.createOrFocusDiceWindow(PROJECT_ROOT);
            return diceHandlers.getDiceWindow();
        },
        readyTimeoutMs: 10000,
    });

    windowService.register(WINDOW_APP_IDS.CANVAS, {
        owner: 'canvasHandlers',
        getWindow: () => {
            const canvasHandlers = require('./canvasHandlers');
            return canvasHandlers.getCanvasWindow();
        },
        open: async (options = {}) => {
            const canvasHandlers = require('./canvasHandlers');
            await canvasHandlers.createCanvasWindow(options.filePath || null);
            return canvasHandlers.getCanvasWindow();
        },
        readyTimeoutMs: 10000,
    });

    windowService.register(WINDOW_APP_IDS.TRANSLATOR, {
        owner: 'desktopHandlers',
        getWindow: () => vchatTranslatorWindow,
        open: async () => {
            let settings = {};
            try {
                const settingsPath = path.join(PROJECT_ROOT, 'AppData', 'settings.json');
                if (await fs.pathExists(settingsPath)) {
                    settings = await fs.readJson(settingsPath);
                }
            } catch (e) { /* ignore */ }

            const vcpServerUrl = settings.vcpServerUrl || '';
            const vcpApiKey = settings.vcpApiKey || '';

            vchatTranslatorWindow = createOrFocusChildWindow(vchatTranslatorWindow, {
                width: 1000, height: 700, minWidth: 800, minHeight: 600,
                title: 'Translator',
                htmlPath: path.join(app.getAppPath(), 'Translatormodules', 'translator.html'),
                queryParams: `vcpServerUrl=${encodeURIComponent(vcpServerUrl)}&vcpApiKey=${encodeURIComponent(vcpApiKey)}`,
            });
            return vchatTranslatorWindow;
        },
    });

    windowService.register(WINDOW_APP_IDS.MUSIC, {
        owner: 'musicHandlers',
        getWindow: () => {
            const musicHandlers = require('./musicHandlers');
            return musicHandlers.getMusicWindow();
        },
        open: async () => {
            const musicHandlers = require('./musicHandlers');
            return musicHandlers.createOrFocusMusicWindow();
        },
        readyTimeoutMs: 10000,
    });

    windowService.register(WINDOW_APP_IDS.THEMES, {
        owner: 'desktopHandlers',
        getWindow: () => vchatThemesWindow,
        open: async () => {
            vchatThemesWindow = createOrFocusChildWindow(vchatThemesWindow, {
                width: 850, height: 700,
                title: 'Theme Picker',
                htmlPath: path.join(app.getAppPath(), 'Themesmodules', 'themes.html'),
            });
            return vchatThemesWindow;
        },
    });
}

function resolveAppActionToAppId(appAction) {
    switch (appAction) {
        case 'show-main-window':
            return WINDOW_APP_IDS.MAIN;
        case 'open-notes-window':
            return WINDOW_APP_IDS.NOTES;
        case 'open-memo-window':
            return WINDOW_APP_IDS.MEMO;
        case 'open-forum-window':
            return WINDOW_APP_IDS.FORUM;
        case 'open-rag-observer-window':
            return WINDOW_APP_IDS.RAG_OBSERVER;
        case 'open-dice-window':
            return WINDOW_APP_IDS.DICE;
        case 'open-canvas-window':
            return WINDOW_APP_IDS.CANVAS;
        case 'open-translator-window':
            return WINDOW_APP_IDS.TRANSLATOR;
        case 'open-music-window':
            return WINDOW_APP_IDS.MUSIC;
        case 'open-themes-window':
            return WINDOW_APP_IDS.THEMES;
        default:
            return null;
    }
}

/**
 * 鍚姩 Windows 绯荤粺宸ュ叿
 * 鏀寔鐨勫懡浠ゆ牸寮忥細
 *   - ms-settings:display     鈫?鎵撳紑 Windows 鏄剧ず璁剧疆
 *   - ms-settings:            鈫?鎵撳紑 Windows 璁剧疆棣栭〉
 *   - control                 鈫?鎵撳紑鎺у埗闈㈡澘
 *   - shell:RecycleBinFolder  鈫?鎵撳紑鍥炴敹绔?
 *   - shell:MyComputerFolder  鈫?鎵撳紑姝ょ數鑴?
 * @param {string} cmd - 绯荤粺鍛戒护
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function launchSystemTool(cmd) {
    try {
        if (!cmd) {
            return { success: false, error: '缂哄皯鍛戒护鍙傛暟' };
        }

        console.log(`[DesktopHandlers] Launching system tool: ${cmd}`);

        if (cmd.startsWith('ms-settings:')) {
            // Windows 璁剧疆 URI - 浣跨敤 shell.openExternal
            await shell.openExternal(cmd);
            return { success: true };
        }

        if (cmd === 'control') {
            // 鎺у埗闈㈡澘 - 浣跨敤 shell.openPath
            const { exec } = require('child_process');
            exec('control.exe', (err) => {
                if (err) console.warn('[DesktopHandlers] control.exe launch warning:', err.message);
            });
            return { success: true };
        }

        if (cmd.startsWith('shell:')) {
            // Windows Shell 鏂囦欢澶?- 浣跨敤 explorer.exe
            const { exec } = require('child_process');
            exec(`explorer.exe ${cmd}`, (err) => {
                if (err) console.warn('[DesktopHandlers] explorer.exe launch warning:', err.message);
            });
            return { success: true };
        }

        // 閫氱敤鏂规锛氬皾璇曠洿鎺ユ墦寮€
        await shell.openPath(cmd);
        return { success: true };
    } catch (err) {
        console.error(`[DesktopHandlers] System tool launch error (${cmd}):`, err);
        return { success: false, error: err.message };
    }
}

/**
 * 鍚姩鐙珛鐨?Electron App锛堝浜虹被宸ュ叿绠便€乂chatManager锛?
 * 杩欎簺搴旂敤鏄」鐩唴鐨勭嫭绔?Electron 鍏ュ彛锛屾嫢鏈夊悇鑷殑 main.js銆?
 * 閫氳繃 child_process.spawn 鍚姩涓€涓柊鐨?electron 瀹炰緥銆?
 *
 * @param {string} appDir - 搴旂敤鐩綍鍚嶏紙鐩稿浜庨」鐩牴鐩綍锛屽 'VCPHumanToolBox'锛?
 * @param {string} displayName - 鏄剧ず鍚嶇О锛堢敤浜庢棩蹇楀拰鐘舵€佹彁绀猴級
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function launchStandaloneElectronApp(appDir, displayName) {
    try {
        const appPath = path.join(PROJECT_ROOT, appDir);
        const mainJsPath = path.join(appPath, 'main.js');

        // 妫€鏌ョ洰褰曞拰鍏ュ彛鏂囦欢鏄惁瀛樺湪
        if (!await fs.pathExists(mainJsPath)) {
            console.error(`[DesktopHandlers] Standalone app not found: ${mainJsPath}`);
            return { success: false, error: `${displayName} 鍏ュ彛鏂囦欢涓嶅瓨鍦? ${appDir}/main.js` };
        }

        // 妫€鏌ユ槸鍚﹀凡鏈夎搴旂敤鐨勮繘绋嬪湪杩愯
        const existingProcess = standaloneAppProcesses.get(appDir);
        if (existingProcess && !existingProcess.killed) {
            // 杩涚▼瀛樺湪锛屾鏌ユ槸鍚﹁繕娲荤潃
            try {
                process.kill(existingProcess.pid, 0); // 鍙戦€佷俊鍙?0 妫€娴嬭繘绋嬫槸鍚﹀瓨娲?
                console.log(`[DesktopHandlers] ${displayName} already running (PID: ${existingProcess.pid})`);
                return { success: true, alreadyRunning: true };
            } catch (e) {
                // 杩涚▼宸查€€鍑猴紝娓呯悊寮曠敤
                standaloneAppProcesses.delete(appDir);
            }
        }

        // 鑾峰彇褰撳墠 Electron 鍙墽琛屾枃浠惰矾寰?
        const electronExe = process.execPath;

        console.log(`[DesktopHandlers] Launching standalone app: ${displayName}`);
        console.log(`[DesktopHandlers]   Electron: ${electronExe}`);
        console.log(`[DesktopHandlers]   App path: ${appPath}`);

        // 浣跨敤 spawn 鍚姩鐙珛鐨?electron 杩涚▼
        const { spawn } = require('child_process');
        const child = spawn(electronExe, [mainJsPath], {
            cwd: appPath,
            detached: true,       // 鐙珛杩涚▼锛屼笉闅忕埗杩涚▼閫€鍑?
            stdio: 'ignore',      // 涓嶇户鎵挎爣鍑咺O
            env: {
                ...process.env,
                // 纭繚瀛愯繘绋嬬煡閬撻」鐩牴鐩綍
                VCP_PROJECT_ROOT: PROJECT_ROOT,
            },
        });

        // 瑙ｉ櫎鐖惰繘绋嬪瀛愯繘绋嬬殑寮曠敤锛屽厑璁稿瓙杩涚▼鐙珛杩愯
        child.unref();

        // 璁板綍杩涚▼寮曠敤锛堢敤浜庨槻姝㈤噸澶嶅惎鍔級
        standaloneAppProcesses.set(appDir, child);

        child.on('exit', (code) => {
            console.log(`[DesktopHandlers] ${displayName} exited with code ${code}`);
            standaloneAppProcesses.delete(appDir);
        });

        child.on('error', (err) => {
            console.error(`[DesktopHandlers] ${displayName} process error:`, err.message);
            standaloneAppProcesses.delete(appDir);
        });

        console.log(`[DesktopHandlers] ${displayName} launched successfully (PID: ${child.pid})`);
        return { success: true };
    } catch (err) {
        console.error(`[DesktopHandlers] Failed to launch ${displayName}:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * 鍒濆鍖栨闈㈠鐞嗘ā鍧?
 */
function initialize(params) {
    mainWindow = params.mainWindow;
    openChildWindows = params.openChildWindows;
    appSettingsManager = params.settingsManager;
    registerManagedWindows();


    // 纭繚鐩綍瀛樺湪
    fs.ensureDirSync(DESKTOP_WIDGETS_DIR);
    fs.ensureDirSync(DESKTOP_DATA_DIR);

    // 鍚姩鏃剁敓鎴?鏇存柊 CATALOG.md
    generateCatalog().catch(err => {
        console.warn('[DesktopHandlers] Initial CATALOG.md generation failed:', err.message);
    });

    // --- IPC: 鎵撳紑妗岄潰绐楀彛 ---
    ipcMain.handle('open-desktop-window', async () => {
        await openDesktopWindow();
    });

    // --- IPC: 绐楀彛濮嬬粓缃簳鎺у埗 ---
    ipcMain.handle('desktop-set-always-on-bottom', (event, enabled) => {
        setAlwaysOnBottom(enabled);
        return { success: true };
    });

    // --- IPC: 涓荤獥鍙?鈫?妗岄潰鐢诲竷鐨勬祦寮忔帹閫?---
    ipcMain.on('desktop-push', (event, data) => {
        if (desktopWindow && !desktopWindow.isDestroyed()) {
            desktopWindow.webContents.send('desktop-push-to-canvas', data);
        }
    });

    // --- IPC: 鏀惰棌绯荤粺 ---

    // 淇濆瓨/鏇存柊鏀惰棌
    ipcMain.handle('desktop-save-widget', async (event, data) => {
        try {
            const { id, name, html, thumbnail } = data;
            console.log(`[DesktopHandlers] desktop-save-widget called: id=${id}, name=${name}, html length=${html?.length}, has thumbnail=${!!thumbnail}`);
            if (!id || !name || !html) {
                console.error('[DesktopHandlers] Missing required params:', { id: !!id, name: !!name, html: !!html });
                return { success: false, error: '缂哄皯蹇呰鍙傛暟' };
            }

            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, id);
            await fs.ensureDir(widgetDir);

            // 淇濆瓨HTML鍐呭
            await fs.writeFile(path.join(widgetDir, 'widget.html'), html, 'utf-8');

            // 淇濆瓨鍏冩暟鎹?
            const meta = {
                id,
                name,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            // 璇诲彇宸叉湁鍏冩暟鎹繚鐣檆reatedAt
            const metaPath = path.join(widgetDir, 'meta.json');
            if (await fs.pathExists(metaPath)) {
                try {
                    const existingMeta = await fs.readJson(metaPath);
                    meta.createdAt = existingMeta.createdAt || meta.createdAt;
                } catch (e) { /* ignore */ }
            }

            await fs.writeJson(metaPath, meta, { spaces: 2 });

            // 淇濆瓨缂╃暐鍥撅紙Base64 Data URL 鈫?PNG鏂囦欢锛?
            if (thumbnail && thumbnail.startsWith('data:image/')) {
                const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
                const thumbBuffer = Buffer.from(base64Data, 'base64');
                await fs.writeFile(path.join(widgetDir, 'thumbnail.png'), thumbBuffer);
            }

            console.log(`[DesktopHandlers] Widget saved: ${name} (${id}) to ${widgetDir}`);

            // 淇濆瓨鎴愬姛鍚庡紓姝ユ洿鏂?CATALOG.md锛堜笉闃诲杩斿洖锛?
            generateCatalog().catch(err => {
                console.warn('[DesktopHandlers] CATALOG.md update after save failed:', err.message);
            });

            return { success: true, id };
        } catch (err) {
            console.error('[DesktopHandlers] Save widget error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 淇濆瓨棰濆鏂囦欢鍒版敹钘忕洰褰曪紙鐢ㄤ簬 AI 鐢熸垚鐨勫鏂囦欢 widget锛?
     * 鍏佽 AI 灏嗗閮?JS/CSS/璧勬簮鏂囦欢淇濆瓨鍒?widget 鏀惰棌鐩綍涓€?
     * 鍙傛暟锛歿 widgetId, fileName, content, encoding }
     * - widgetId: 鏀惰棌 ID锛堢洰褰曞悕锛?
     * - fileName: 鏂囦欢鍚嶏紙濡?'app.js', 'style.css'锛屼笉鍏佽璺緞绌胯秺锛?
     * - content: 鏂囦欢鍐呭锛堝瓧绗︿覆锛?
     * - encoding: 缂栫爜鏂瑰紡锛岄粯璁?'utf-8'锛屼篃鏀寔 'base64'
     */
    ipcMain.handle('desktop-save-widget-file', async (event, data) => {
        try {
            const { widgetId, fileName, content, encoding } = data;
            if (!widgetId || !fileName || content === undefined) {
                return { success: false, error: '缂哄皯蹇呰鍙傛暟 (widgetId, fileName, content)' };
            }

            // 瀹夊叏妫€鏌ワ細闃叉璺緞绌胯秺
            const safeName = path.basename(fileName);
            if (safeName !== fileName || fileName.includes('..')) {
                return { success: false, error: `涓嶅畨鍏ㄧ殑鏂囦欢鍚? ${fileName}` };
            }

            // 绂佹瑕嗙洊鏍稿績鏂囦欢
            const protectedFiles = ['meta.json', 'widget.html', 'thumbnail.png'];
            if (protectedFiles.includes(safeName.toLowerCase())) {
                return { success: false, error: `涓嶅厑璁歌鐩栨牳蹇冩枃浠? ${safeName}` };
            }

            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, widgetId);
            await fs.ensureDir(widgetDir);

            const filePath = path.join(widgetDir, safeName);
            const enc = encoding === 'base64' ? 'base64' : 'utf-8';
            await fs.writeFile(filePath, content, enc);

            console.log(`[DesktopHandlers] Widget file saved: ${widgetId}/${safeName} (${enc})`);
            return { success: true, filePath: `${widgetId}/${safeName}` };
        } catch (err) {
            console.error('[DesktopHandlers] Save widget file error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 璇诲彇鏀惰棌鐩綍涓殑棰濆鏂囦欢
     * 鍙傛暟锛歿 widgetId, fileName }
     * 杩斿洖锛歿 success, content, encoding }
     */
    ipcMain.handle('desktop-load-widget-file', async (event, data) => {
        try {
            const { widgetId, fileName } = data;
            if (!widgetId || !fileName) {
                return { success: false, error: '缂哄皯蹇呰鍙傛暟' };
            }

            // 瀹夊叏妫€鏌?
            const safeName = path.basename(fileName);
            if (safeName !== fileName || fileName.includes('..')) {
                return { success: false, error: `涓嶅畨鍏ㄧ殑鏂囦欢鍚? ${fileName}` };
            }

            const filePath = path.join(DESKTOP_WIDGETS_DIR, widgetId, safeName);
            if (!await fs.pathExists(filePath)) {
                return { success: false, error: 'File not found.' };
            }

            // 鏍规嵁鎵╁睍鍚嶅垽鏂槸鍚︿负鏂囨湰鏂囦欢
            const ext = path.extname(safeName).toLowerCase();
            const textExts = ['.js', '.css', '.html', '.htm', '.json', '.txt', '.md', '.svg', '.xml'];
            if (textExts.includes(ext)) {
                const content = await fs.readFile(filePath, 'utf-8');
                return { success: true, content, encoding: 'utf-8' };
            } else {
                // 浜岃繘鍒舵枃浠惰繑鍥?base64
                const buffer = await fs.readFile(filePath);
                return { success: true, content: buffer.toString('base64'), encoding: 'base64' };
            }
        } catch (err) {
            console.error('[DesktopHandlers] Load widget file error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 鍒楀嚭鏀惰棌鐩綍涓殑鎵€鏈夋枃浠?
     * 鍙傛暟锛歸idgetId
     * 杩斿洖锛歿 success, files: [{ name, size, isText }] }
     */
    ipcMain.handle('desktop-list-widget-files', async (event, widgetId) => {
        try {
            if (!widgetId) {
                return { success: false, error: '缂哄皯 widgetId' };
            }

            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, widgetId);
            if (!await fs.pathExists(widgetDir)) {
                return { success: true, files: [] };
            }

            const entries = await fs.readdir(widgetDir, { withFileTypes: true });
            const files = [];
            const textExts = ['.js', '.css', '.html', '.htm', '.json', '.txt', '.md', '.svg', '.xml'];

            for (const entry of entries) {
                if (!entry.isFile()) continue;
                const ext = path.extname(entry.name).toLowerCase();
                try {
                    const stat = await fs.stat(path.join(widgetDir, entry.name));
                    files.push({
                        name: entry.name,
                        size: stat.size,
                        isText: textExts.includes(ext),
                    });
                } catch (e) {
                    files.push({ name: entry.name, size: 0, isText: textExts.includes(ext) });
                }
            }

            return { success: true, files };
        } catch (err) {
            console.error('[DesktopHandlers] List widget files error:', err);
            return { success: false, error: err.message };
        }
    });

    // 鍔犺浇鏀惰棌锛堣鍙朒TML鍐呭锛?
    ipcMain.handle('desktop-load-widget', async (event, id) => {
        try {
            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, id);
            const htmlPath = path.join(widgetDir, 'widget.html');
            const metaPath = path.join(widgetDir, 'meta.json');

            if (!(await fs.pathExists(htmlPath))) {
                return { success: false, error: 'Widget not found.' };
            }

            const html = await fs.readFile(htmlPath, 'utf-8');
            let name = id;
            if (await fs.pathExists(metaPath)) {
                try {
                    const meta = await fs.readJson(metaPath);
                    name = meta.name || id;
                } catch (e) { /* ignore */ }
            }

            return { success: true, html, name, id };
        } catch (err) {
            console.error('[DesktopHandlers] Load widget error:', err);
            return { success: false, error: err.message };
        }
    });

    // 鍒犻櫎鏀惰棌
    ipcMain.handle('desktop-delete-widget', async (event, id) => {
        try {
            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, id);
            if (await fs.pathExists(widgetDir)) {
                await fs.remove(widgetDir);
                console.log(`[DesktopHandlers] Widget deleted: ${id}`);
            }

            // 鍒犻櫎鎴愬姛鍚庡紓姝ユ洿鏂?CATALOG.md锛堜笉闃诲杩斿洖锛?
            generateCatalog().catch(err => {
                console.warn('[DesktopHandlers] CATALOG.md update after delete failed:', err.message);
            });

            return { success: true };
        } catch (err) {
            console.error('[DesktopHandlers] Delete widget error:', err);
            return { success: false, error: err.message };
        }
    });

    // 鍒楀嚭鎵€鏈夋敹钘忥紙杩斿洖id銆乶ame銆乼humbnail鐨凞ata URL锛?
    ipcMain.handle('desktop-list-widgets', async () => {
        try {
            console.log(`[DesktopHandlers] desktop-list-widgets called, dir: ${DESKTOP_WIDGETS_DIR}`);
            await fs.ensureDir(DESKTOP_WIDGETS_DIR);
            const entries = await fs.readdir(DESKTOP_WIDGETS_DIR, { withFileTypes: true });
            console.log(`[DesktopHandlers] Found ${entries.length} entries in DesktopWidgets dir`);
            const widgets = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const widgetDir = path.join(DESKTOP_WIDGETS_DIR, entry.name);
                const metaPath = path.join(widgetDir, 'meta.json');
                const thumbPath = path.join(widgetDir, 'thumbnail.png');

                let meta = { id: entry.name, name: entry.name };
                if (await fs.pathExists(metaPath)) {
                    try {
                        meta = await fs.readJson(metaPath);
                    } catch (e) { /* ignore */ }
                }

                // 璇诲彇缂╃暐鍥句负Data URL
                let thumbnail = '';
                if (await fs.pathExists(thumbPath)) {
                    try {
                        const thumbBuffer = await fs.readFile(thumbPath);
                        thumbnail = `data:image/png;base64,${thumbBuffer.toString('base64')}`;
                    } catch (e) { /* ignore */ }
                }

                widgets.push({
                    id: meta.id || entry.name,
                    name: meta.name || entry.name,
                    thumbnail,
                    createdAt: meta.createdAt,
                    updatedAt: meta.updatedAt,
                });
            }

            // 鎸夋洿鏂版椂闂村€掑簭鎺掑垪
            widgets.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

            return { success: true, widgets };
        } catch (err) {
            console.error('[DesktopHandlers] List widgets error:', err);
            return { success: false, error: err.message, widgets: [] };
        }
    });

    // 鎴彇妗岄潰绐楀彛鎸囧畾鐭╁舰鍖哄煙鐨勬埅鍥?
    ipcMain.handle('desktop-capture-widget', async (event, rect) => {
        try {
            if (!desktopWindow || desktopWindow.isDestroyed()) {
                return { success: false, error: 'Desktop window not found.' };
            }

            const { x, y, width, height } = rect;
            // capturePage 闇€瑕佹暣鏁板潗鏍?
            const captureRect = {
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
            };

            console.log(`[DesktopHandlers] Capturing widget area:`, captureRect);
            const image = await desktopWindow.webContents.capturePage(captureRect);
            
            // 缂╂斁鍒板悎鐞嗙殑缂╃暐鍥惧昂瀵?
            const MAX_THUMB = 300;
            const scale = Math.min(MAX_THUMB / captureRect.width, MAX_THUMB / captureRect.height, 1);
            const thumbWidth = Math.round(captureRect.width * scale);
            const thumbHeight = Math.round(captureRect.height * scale);
            
            const resized = image.resize({ width: thumbWidth, height: thumbHeight, quality: 'good' });
            const dataUrl = `data:image/png;base64,${resized.toPNG().toString('base64')}`;
            
            console.log(`[DesktopHandlers] Widget captured: ${thumbWidth}x${thumbHeight}, data length: ${dataUrl.length}`);
            return { success: true, thumbnail: dataUrl };
        } catch (err) {
            console.error('[DesktopHandlers] Capture widget error:', err);
            return { success: false, error: err.message };
        }
    });

    // 鑾峰彇 VCP 鍚庣鍑嵁锛堜緵妗岄潰 widget 鐨?vcpAPI 浣跨敤锛?
    ipcMain.handle('desktop-get-credentials', async () => {
        try {
            const settingsPath = path.join(PROJECT_ROOT, 'AppData', 'settings.json');
            const forumConfigPath = path.join(PROJECT_ROOT, 'AppData', 'UserData', 'forum.config.json');

            let vcpServerUrl = '';
            let vcpApiKey = '';
            let username = '';
            let password = '';

            if (await fs.pathExists(settingsPath)) {
                try {
                    const settings = await fs.readJson(settingsPath);
                    vcpServerUrl = settings.vcpServerUrl || '';
                    vcpApiKey = settings.vcpApiKey || '';
                } catch (e) { /* ignore */ }
            }

            if (await fs.pathExists(forumConfigPath)) {
                try {
                    const config = await fs.readJson(forumConfigPath);
                    username = config.username || '';
                    password = config.password || '';
                } catch (e) { /* ignore */ }
            }

            // 浠?vcpServerUrl 鎺ㄥ鍑?admin API base URL
            let apiBaseUrl = '';
            if (vcpServerUrl) {
                try {
                    const urlObj = new URL(vcpServerUrl);
                    apiBaseUrl = `${urlObj.protocol}//${urlObj.host}`;
                } catch (e) { /* ignore */ }
            }

            return {
                success: true,
                apiBaseUrl,
                vcpServerUrl,
                vcpApiKey,
                username,
                password,
            };
        } catch (err) {
            console.error('[DesktopHandlers] Get credentials error:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.removeHandler('desktop-launch-vchat-app');
    ipcMain.handle('desktop-launch-vchat-app', async (event, appAction) => {
        try {
            console.log(`[DesktopHandlers] Launching VChat app via WindowService: ${appAction}`);

            const appId = resolveAppActionToAppId(appAction);
            if (appId) {
                await windowService.open(appId);
                return { success: true, appId };
            }

            if (appAction === 'launch-human-toolbox') {
                return await launchStandaloneElectronApp('VCPHumanToolBox', 'Human Toolbox');
            }

            if (appAction === 'launch-vchat-manager') {
                return await launchStandaloneElectronApp('VchatManager', 'VchatManager');
            }

            if (appAction && appAction.startsWith('open-system-tool:')) {
                const cmd = appAction.substring('open-system-tool:'.length);
                return await launchSystemTool(cmd);
            }

            console.warn(`[DesktopHandlers] Unknown VChat app action: ${appAction}`);
            return { success: false, error: `Unknown app action: ${appAction}` };
        } catch (err) {
            console.error(`[DesktopHandlers] VChat app launch error (${appAction}):`, err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: 蹇嵎鏂瑰紡瑙ｆ瀽 & 鍚姩 ---
    // ============================================================

    /**
     * 瑙ｆ瀽 Windows .url 蹇嵎鏂瑰紡鏂囦欢锛圛nternet Shortcut锛?
     * 鏀寔 Steam 绛変娇鐢ㄨ嚜瀹氫箟鍗忚鐨勫簲鐢紙濡?steam://rungameid/570锛?
     * @param {string} filePath - .url 鏂囦欢璺緞
     * @returns {object|null} 瑙ｆ瀽鍚庣殑蹇嵎鏂瑰紡淇℃伅
     */
    /**
     * 甯﹁秴鏃剁殑 Promise 鍖呰鍣?
     */
    function withTimeout(promise, ms, fallback) {
        return Promise.race([
            promise,
            new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
        ]);
    }

    async function parseUrlShortcut(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split(/\r?\n/);

            let url = '';
            let iconFile = '';
            let iconIndex = 0;

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.toLowerCase().startsWith('url=')) {
                    url = trimmed.substring(4);
                } else if (trimmed.toLowerCase().startsWith('iconfile=')) {
                    iconFile = trimmed.substring(9);
                } else if (trimmed.toLowerCase().startsWith('iconindex=')) {
                    iconIndex = parseInt(trimmed.substring(10), 10) || 0;
                }
            }

            if (!url) return null;

            const name = path.basename(filePath, '.url');

            // 鎻愬彇鍥炬爣锛堝甫瓒呮椂淇濇姢锛岄槻姝?getFileIcon 鎸傝捣锛?
            let iconDataUrl = '';
            try {
                // 浼樺厛浠?IconFile 鎸囧畾鐨勬枃浠舵彁鍙栧浘鏍?
                if (iconFile && await fs.pathExists(iconFile)) {
                    const nativeImage = await withTimeout(
                        app.getFileIcon(iconFile, { size: 'large' }),
                        3000, // 3绉掕秴鏃?
                        null
                    );
                    if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                        iconDataUrl = nativeImage.toDataURL();
                    }
                }
                // 濡傛灉娌℃湁鏈夋晥鍥炬爣锛屽皾璇曚粠 .url 鏂囦欢鏈韩鎻愬彇
                if (!iconDataUrl) {
                    const nativeImage = await withTimeout(
                        app.getFileIcon(filePath, { size: 'large' }),
                        3000,
                        null
                    );
                    if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                        iconDataUrl = nativeImage.toDataURL();
                    }
                }
            } catch (e) {
                console.warn('[DesktopHandlers] URL shortcut icon extraction failed:', e.message);
            }

            return {
                name,
                targetPath: url,      // 瀵?.url 鏂囦欢锛宼argetPath 瀛樺偍鐨勬槸 URL锛堝 steam://rungameid/570锛?
                args: '',
                workingDir: '',
                description: url,
                icon: iconDataUrl,
                originalPath: filePath,
                isUrlShortcut: true,   // 鏍囪涓?URL 蹇嵎鏂瑰紡锛屽惎鍔ㄦ椂浣跨敤 shell.openExternal
            };
        } catch (e) {
            console.warn(`[DesktopHandlers] Failed to parse .url file: ${filePath}`, e.message);
            return null;
        }
    }

    /**
     * 瑙ｆ瀽 Windows 蹇嵎鏂瑰紡 (.lnk) 鏂囦欢
     * 杩斿洖锛歿 name, targetPath, args, icon (DataURL), workingDir }
     */
    ipcMain.handle('desktop-shortcut-parse', async (event, filePath) => {
        try {
            if (!filePath) {
                return { success: false, error: 'Invalid shortcut file.' };
            }

            // 鏀寔 .url 鏂囦欢
            if (filePath.toLowerCase().endsWith('.url')) {
                const result = await parseUrlShortcut(filePath);
                if (result) {
                    return { success: true, shortcut: result };
                }
                return { success: false, error: '鏃犳硶瑙ｆ瀽 .url 蹇嵎鏂瑰紡' };
            }

            if (!filePath.toLowerCase().endsWith('.lnk')) {
                return { success: false, error: 'Invalid shortcut file.' };
            }

            // 浣跨敤 Electron 鍘熺敓 API 瑙ｆ瀽 .lnk
            let shortcutDetails;
            try {
                shortcutDetails = shell.readShortcutLink(filePath);
            } catch (e) {
                return { success: false, error: `瑙ｆ瀽蹇嵎鏂瑰紡澶辫触: ${e.message}` };
            }

            const targetPath = shortcutDetails.target || '';
            const args = shortcutDetails.args || '';
            const workingDir = shortcutDetails.cwd || '';
            const description = shortcutDetails.description || '';

            // 浠庢枃浠跺悕鎻愬彇鏄剧ず鍚嶇О
            const name = path.basename(filePath, '.lnk');

            // 鎻愬彇鍥炬爣
            let iconDataUrl = '';
            try {
                // 浼樺厛浠庣洰鏍囧彲鎵ц鏂囦欢鎻愬彇鍥炬爣
                const iconTarget = targetPath || filePath;
                const nativeImage = await withTimeout(
                    app.getFileIcon(iconTarget, { size: 'large' }),
                    3000,
                    null
                );
                if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                    iconDataUrl = nativeImage.toDataURL();
                }
            } catch (iconErr) {
                console.warn('[DesktopHandlers] Icon extraction failed:', iconErr.message);
                // 灏濊瘯浠?.lnk 鏂囦欢鏈韩鎻愬彇鍥炬爣
                try {
                    const nativeImage = await withTimeout(
                        app.getFileIcon(filePath, { size: 'large' }),
                        3000,
                        null
                    );
                    if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                        iconDataUrl = nativeImage.toDataURL();
                    }
                } catch (e) { /* ignore */ }
            }

            console.log(`[DesktopHandlers] Shortcut parsed: ${name} -> ${targetPath}`);
            return {
                success: true,
                shortcut: {
                    name,
                    targetPath,
                    args,
                    workingDir,
                    description,
                    icon: iconDataUrl,
                    originalPath: filePath,
                },
            };
        } catch (err) {
            console.error('[DesktopHandlers] Shortcut parse error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 鎵归噺瑙ｆ瀽澶氫釜蹇嵎鏂瑰紡鏂囦欢
     */
    ipcMain.handle('desktop-shortcut-parse-batch', async (event, filePaths) => {
        try {
            if (!Array.isArray(filePaths)) {
                return { success: false, error: 'Expected an array of file paths.' };
            }

            const results = [];
            for (const filePath of filePaths) {
                try {
                    const lowerPath = filePath.toLowerCase();

                    // 鏀寔 .url 鏂囦欢锛圫team 绛夊簲鐢ㄧ殑蹇嵎鏂瑰紡锛?
                    if (lowerPath.endsWith('.url')) {
                        const urlResult = await parseUrlShortcut(filePath);
                        if (urlResult) {
                            results.push(urlResult);
                        }
                        continue;
                    }

                    if (!lowerPath.endsWith('.lnk')) continue;

                    let shortcutDetails;
                    try {
                        shortcutDetails = shell.readShortcutLink(filePath);
                    } catch (e) {
                        continue;
                    }

                    const targetPath = shortcutDetails.target || '';
                    const name = path.basename(filePath, '.lnk');

                    let iconDataUrl = '';
                    try {
                        const iconTarget = targetPath || filePath;
                        const nativeImage = await withTimeout(
                            app.getFileIcon(iconTarget, { size: 'large' }),
                            3000,
                            null
                        );
                        if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                            iconDataUrl = nativeImage.toDataURL();
                        }
                    } catch (e) {
                        try {
                            const nativeImage = await withTimeout(
                                app.getFileIcon(filePath, { size: 'large' }),
                                3000,
                                null
                            );
                            if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                                iconDataUrl = nativeImage.toDataURL();
                            }
                        } catch (e2) { /* ignore */ }
                    }

                    results.push({
                        name,
                        targetPath,
                        args: shortcutDetails.args || '',
                        workingDir: shortcutDetails.cwd || '',
                        description: shortcutDetails.description || '',
                        icon: iconDataUrl,
                        originalPath: filePath,
                    });
                } catch (e) {
                    console.warn(`[DesktopHandlers] Failed to parse shortcut: ${filePath}`, e.message);
                }
            }

            console.log(`[DesktopHandlers] Batch parsed ${results.length} shortcuts from ${filePaths.length} files`);
            return { success: true, shortcuts: results };
        } catch (err) {
            console.error('[DesktopHandlers] Batch parse error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 鍚姩蹇嵎鏂瑰紡鐩爣绋嬪簭
     */
    ipcMain.handle('desktop-shortcut-launch', async (event, shortcutData) => {
        try {
            const { targetPath, args, workingDir, originalPath, isUrlShortcut } = shortcutData;

            if (!targetPath && !originalPath) {
                return { success: false, error: '缂哄皯鐩爣璺緞' };
            }

            // URL 蹇嵎鏂瑰紡锛堝 steam://rungameid/570锛夛細浣跨敤 shell.openExternal 鎵撳紑
            if (isUrlShortcut || (targetPath && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(targetPath))) {
                console.log(`[DesktopHandlers] Launching URL shortcut: ${targetPath}`);
                await shell.openExternal(targetPath);
                return { success: true };
            }

            // 浼樺厛浣跨敤 shell.openPath 鎵撳紑鍘熷 .lnk/.url 鏂囦欢锛堜繚鐣欏畬鏁寸殑蹇嵎鏂瑰紡閰嶇疆濡傜鐞嗗憳鏉冮檺绛夛級
            if (originalPath && await fs.pathExists(originalPath)) {
                console.log(`[DesktopHandlers] Launching shortcut via original file: ${originalPath}`);
                const errorMsg = await shell.openPath(originalPath);
                if (errorMsg) {
                    return { success: false, error: errorMsg };
                }
                return { success: true };
            }

            // 澶囬€夋柟妗堬細鐩存帴鎵撳紑鐩爣璺緞
            if (targetPath && await fs.pathExists(targetPath)) {
                console.log(`[DesktopHandlers] Launching target: ${targetPath}`);
                const errorMsg = await shell.openPath(targetPath);
                if (errorMsg) {
                    return { success: false, error: errorMsg };
                }
                return { success: true };
            }

            return { success: false, error: 'Target file not found.' };
        } catch (err) {
            console.error('[DesktopHandlers] Shortcut launch error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 鎵弿 Windows 妗岄潰涓婄殑蹇嵎鏂瑰紡
     * 鑷姩鎵弿鍏叡妗岄潰鍜岀敤鎴锋闈?
     */
    ipcMain.handle('desktop-scan-shortcuts', async () => {
        try {
            if (process.platform !== 'win32') {
                return { success: false, error: '姝ゅ姛鑳戒粎鏀寔 Windows 骞冲彴' };
            }

            const shortcuts = [];
            const desktopPaths = [
                app.getPath('desktop'),  // 鐢ㄦ埛妗岄潰
                path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),  // 鍏叡妗岄潰
            ];

            for (const desktopPath of desktopPaths) {
                try {
                    if (!await fs.pathExists(desktopPath)) continue;
                    const files = await fs.readdir(desktopPath);

                    for (const file of files) {
                        const lowerFile = file.toLowerCase();
                        const filePath = path.join(desktopPath, file);

                        // 澶勭悊 .url 鏂囦欢锛圫team 绛夊簲鐢ㄧ殑蹇嵎鏂瑰紡锛?
                        if (lowerFile.endsWith('.url')) {
                            try {
                                const urlResult = await parseUrlShortcut(filePath);
                                if (urlResult) {
                                    shortcuts.push(urlResult);
                                }
                            } catch (e) {
                                console.warn(`[DesktopHandlers] Cannot parse .url: ${file}`, e.message);
                            }
                            continue;
                        }

                        // 澶勭悊 .lnk 鏂囦欢
                        if (!lowerFile.endsWith('.lnk')) continue;

                        try {
                            const shortcutDetails = shell.readShortcutLink(filePath);
                            const targetPath = shortcutDetails.target || '';
                            const name = path.basename(file, '.lnk');

                            let iconDataUrl = '';
                            try {
                                const iconTarget = targetPath || filePath;
                                const nativeImage = await withTimeout(
                                    app.getFileIcon(iconTarget, { size: 'large' }),
                                    3000,
                                    null
                                );
                                if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                                    iconDataUrl = nativeImage.toDataURL();
                                }
                            } catch (e) { /* ignore */ }

                            shortcuts.push({
                                name,
                                targetPath,
                                args: shortcutDetails.args || '',
                                workingDir: shortcutDetails.cwd || '',
                                description: shortcutDetails.description || '',
                                icon: iconDataUrl,
                                originalPath: filePath,
                            });
                        } catch (e) {
                            // 璺宠繃鏃犳硶瑙ｆ瀽鐨勫揩鎹锋柟寮?
                            console.warn(`[DesktopHandlers] Cannot parse: ${file}`, e.message);
                        }
                    }
                } catch (e) {
                    console.warn(`[DesktopHandlers] Cannot read desktop dir: ${desktopPath}`, e.message);
                }
            }

            // 鎸夊悕绉版帓搴?
            shortcuts.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

            console.log(`[DesktopHandlers] Scanned ${shortcuts.length} shortcuts from Windows desktop (including .url)`);
            return { success: true, shortcuts };
        } catch (err) {
            console.error('[DesktopHandlers] Scan shortcuts error:', err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: Dock 鎸佷箙鍖?---
    // ============================================================

    /**
     * 淇濆瓨 Dock 閰嶇疆
     */
    ipcMain.handle('desktop-save-dock', async (event, dockData) => {
        try {
            await fs.writeJson(DOCK_CONFIG_PATH, dockData, { spaces: 2 });
            console.log(`[DesktopHandlers] Dock config saved (${dockData.items?.length || 0} items)`);
            return { success: true };
        } catch (err) {
            console.error('[DesktopHandlers] Save dock error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 鍔犺浇 Dock 閰嶇疆
     */
    ipcMain.handle('desktop-load-dock', async () => {
        try {
            if (await fs.pathExists(DOCK_CONFIG_PATH)) {
                const data = await fs.readJson(DOCK_CONFIG_PATH);
                return { success: true, data };
            }
            return { success: true, data: { items: [], maxVisible: 8 } };
        } catch (err) {
            console.error('[DesktopHandlers] Load dock error:', err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: 甯冨眬鎸佷箙鍖?---
    // ============================================================

    /**
     * 淇濆瓨妗岄潰甯冨眬
     */
    ipcMain.handle('desktop-save-layout', async (event, layoutData) => {
        try {
            await fs.writeJson(LAYOUT_CONFIG_PATH, layoutData, { spaces: 2 });
            console.log(`[DesktopHandlers] Layout saved`);
            return { success: true };
        } catch (err) {
            console.error('[DesktopHandlers] Save layout error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 鍔犺浇妗岄潰甯冨眬
     */
    ipcMain.handle('desktop-load-layout', async () => {
        try {
            if (await fs.pathExists(LAYOUT_CONFIG_PATH)) {
                const data = await fs.readJson(LAYOUT_CONFIG_PATH);
                return { success: true, data };
            }
            return { success: true, data: null };
        } catch (err) {
            console.error('[DesktopHandlers] Load layout error:', err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: 鍥炬爣闆嗙郴缁燂紙iconset锛?---
    // ============================================================

    const ICONSET_DIR = path.join(PROJECT_ROOT, 'assets', 'iconset');

    /**
     * 鑾峰彇鎵€鏈夊浘鏍囬璁炬枃浠跺す鍒楄〃
     * 杩斿洖锛歿 success, presets: [{ name, iconCount }] }
     */
    ipcMain.handle('desktop-iconset-list-presets', async () => {
        try {
            if (!await fs.pathExists(ICONSET_DIR)) {
                return { success: true, presets: [] };
            }
            const entries = await fs.readdir(ICONSET_DIR, { withFileTypes: true });
            const presets = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const presetDir = path.join(ICONSET_DIR, entry.name);
                const files = await fs.readdir(presetDir);
                const iconFiles = files.filter(f => /\.(png|jpg|jpeg|svg|ico|webp|gif|html|htm)$/i.test(f));
                presets.push({
                    name: entry.name,
                    iconCount: iconFiles.length,
                });
            }
            presets.sort((a, b) => a.name.localeCompare(b.name));
            return { success: true, presets };
        } catch (err) {
            console.error('[DesktopHandlers] List iconset presets error:', err);
            return { success: false, error: err.message, presets: [] };
        }
    });

    /**
     * 鑾峰彇鎸囧畾棰勮鏂囦欢澶逛腑鐨勫浘鏍囧垪琛?
     * 鍙傛暟锛歿 presetName, page, pageSize, search }
     * 杩斿洖锛歿 success, icons: [{ name, relativePath }], total, page, pageSize }
     */
    ipcMain.handle('desktop-iconset-list-icons', async (event, params) => {
        try {
            const { presetName, page = 1, pageSize = 50, search = '' } = params;
            const presetDir = path.join(ICONSET_DIR, presetName);

            if (!await fs.pathExists(presetDir)) {
                return { success: false, error: '棰勮鏂囦欢澶逛笉瀛樺湪', icons: [], total: 0 };
            }

            const files = await fs.readdir(presetDir);
            let iconFiles = files.filter(f => /\.(png|jpg|jpeg|svg|ico|webp|gif|html|htm)$/i.test(f));

            // 鎼滅储杩囨护
            if (search) {
                const searchLower = search.toLowerCase();
                iconFiles = iconFiles.filter(f => f.toLowerCase().includes(searchLower));
            }

            iconFiles.sort((a, b) => a.localeCompare(b));

            const total = iconFiles.length;
            const startIndex = (page - 1) * pageSize;
            const pagedFiles = iconFiles.slice(startIndex, startIndex + pageSize);

            const icons = pagedFiles.map(f => {
                const ext = path.extname(f).toLowerCase();
                // 鍒ゆ柇鍥炬爣绫诲瀷
                let iconType = 'image'; // 榛樿涓哄浘鐗囷紙png/jpg/svg/ico/webp锛?
                if (ext === '.gif') iconType = 'gif';
                else if (ext === '.html' || ext === '.htm') iconType = 'html';
                else if (ext === '.svg') iconType = 'svg';

                return {
                    name: path.basename(f, ext),
                    fileName: f,
                    iconType,
                    // 鐩稿浜庨」鐩牴鐩綍鐨勮矾寰勶紝鍓嶇浣跨敤 ../assets/iconset/... 璁块棶
                    relativePath: `assets/iconset/${presetName}/${f}`,
                };
            });

            return { success: true, icons, total, page, pageSize };
        } catch (err) {
            console.error('[DesktopHandlers] List iconset icons error:', err);
            return { success: false, error: err.message, icons: [], total: 0 };
        }
    });

    /**
     * 灏嗗浘鏍囨枃浠惰鍙栦负 Data URL锛堢敤浜庨珮璐ㄩ噺鏄剧ず鎴栨寔涔呭寲锛?
     * 鍙傛暟锛歳elativePath - 鐩稿浜庨」鐩牴鐩綍鐨勮矾寰?
     * 杩斿洖锛歿 success, dataUrl }
     */
    ipcMain.handle('desktop-iconset-get-icon-data', async (event, relativePath) => {
        try {
            const fullPath = path.join(PROJECT_ROOT, relativePath);
            if (!await fs.pathExists(fullPath)) {
                return { success: false, error: 'Icon file not found.' };
            }

            const ext = path.extname(fullPath).toLowerCase();

            // HTML 鍥炬爣锛氳繑鍥?HTML 鍐呭瀛楃涓诧紙鐢ㄤ簬 Shadow DOM 娓叉煋锛?
            if (ext === '.html' || ext === '.htm') {
                const htmlContent = await fs.readFile(fullPath, 'utf-8');
                return { success: true, dataUrl: null, htmlContent, iconType: 'html' };
            }

            // GIF 鍥炬爣锛氳繑鍥?Data URL
            if (ext === '.gif') {
                const buffer = await fs.readFile(fullPath);
                const dataUrl = `data:image/gif;base64,${buffer.toString('base64')}`;
                return { success: true, dataUrl, iconType: 'gif' };
            }

            // SVG 鍥炬爣锛氳繑鍥?Data URL + 鍘熷 SVG 鏂囨湰锛堜緵鍐呰仈浣跨敤锛?
            if (ext === '.svg') {
                const buffer = await fs.readFile(fullPath);
                const svgContent = buffer.toString('utf-8');
                const dataUrl = `data:image/svg+xml;base64,${buffer.toString('base64')}`;
                return { success: true, dataUrl, svgContent, iconType: 'svg' };
            }

            // 鍏朵粬鍥剧墖鏍煎紡锛氳繑鍥?Data URL
            const buffer = await fs.readFile(fullPath);
            const mimeTypes = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.ico': 'image/x-icon',
                '.webp': 'image/webp',
            };
            const mime = mimeTypes[ext] || 'image/png';
            const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

            return { success: true, dataUrl, iconType: 'image' };
        } catch (err) {
            console.error('[DesktopHandlers] Get icon data error:', err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: 澹佺焊鏂囦欢閫夋嫨 ---
    // ============================================================

    /**
     * 鎵撳紑鏂囦欢閫夋嫨瀵硅瘽妗嗭紝閫夋嫨澹佺焊鏂囦欢
     * 鏀寔鍥剧墖銆佽棰?mp4)銆丠TML 鏂囦欢
     * 杩斿洖锛歿 success, filePath, fileUrl, type }
     */
    ipcMain.handle('desktop-select-wallpaper', async () => {
        try {
            const targetWindow = desktopWindow && !desktopWindow.isDestroyed() ? desktopWindow : mainWindow;
            const result = await dialog.showOpenDialog(targetWindow, {
                title: '閫夋嫨澹佺焊鏂囦欢',
                properties: ['openFile'],
                filters: [
                    { name: 'All supported wallpapers', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'mp4', 'webm', 'html', 'htm'] },
                    { name: '鍥剧墖', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'] },
                    { name: '瑙嗛', extensions: ['mp4', 'webm'] },
                    { name: 'HTML wallpapers', extensions: ['html', 'htm'] },
                ],
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return { success: false, canceled: true };
            }

            const filePath = result.filePaths[0];
            const ext = path.extname(filePath).toLowerCase().replace('.', '');

            // 妫€娴嬫枃浠剁被鍨?
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'];
            const videoExts = ['mp4', 'webm'];
            const htmlExts = ['html', 'htm'];

            let type = 'unknown';
            if (imageExts.includes(ext)) type = 'image';
            else if (videoExts.includes(ext)) type = 'video';
            else if (htmlExts.includes(ext)) type = 'html';

            // 灏嗘枃浠惰矾寰勮浆涓?file:// URL锛圗lectron 娓叉煋杩涚▼鍙互瀹夊叏鍔犺浇锛?
            const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`;

            console.log(`[DesktopHandlers] Wallpaper selected: ${type} - ${filePath}`);
            return { success: true, filePath, fileUrl, type };
        } catch (err) {
            console.error('[DesktopHandlers] Select wallpaper error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 璇诲彇澹佺焊鏂囦欢骞惰繑鍥?Data URL锛堢敤浜庡浘鐗囧绾搁瑙堟垨宓屽叆锛?
     * 瀵逛簬澶ф枃浠朵娇鐢?file:// URL 鏇村悎閫傦紝姝?API 涓昏鐢ㄤ簬缂╃暐鍥鹃瑙?
     */
    ipcMain.handle('desktop-read-wallpaper-thumbnail', async (event, filePath) => {
        try {
            if (!filePath || !await fs.pathExists(filePath)) {
                return { success: false, error: 'File not found.' };
            }

            const ext = path.extname(filePath).toLowerCase();
            const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif'];

            if (!imageExts.includes(ext)) {
                // 闈炲浘鐗囩被鍨嬭繑鍥炵┖缂╃暐鍥?
                return { success: true, thumbnail: '', type: ext.replace('.', '') };
            }

            // 璇诲彇骞剁缉鏀句负缂╃暐鍥?
            const buffer = await fs.readFile(filePath);
            const mimeTypes = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.png': 'image/png', '.gif': 'image/gif',
                '.webp': 'image/webp', '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml', '.avif': 'image/avif',
            };
            const mime = mimeTypes[ext] || 'image/png';
            const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

            return { success: true, thumbnail: dataUrl };
        } catch (err) {
            console.error('[DesktopHandlers] Read wallpaper thumbnail error:', err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: 鎵撳紑 Windows 绯荤粺宸ュ叿 ---
    // ============================================================

    ipcMain.handle('desktop-open-system-tool', async (event, cmd) => {
        return await launchSystemTool(cmd);
    });

    desktopMetrics.initialize({ ipcMain });

    console.log('[DesktopHandlers] Initialized (with favorites, vcpAPI, shortcuts, dock, layout, iconset, wallpaper, vchat-apps, system-tools & desktop-metrics).');
}

/**
 * 鎵撳紑鎴栬仛鐒︽闈㈢敾甯冪獥鍙?
 */
async function openDesktopWindow() {
    if (desktopWindow && !desktopWindow.isDestroyed()) {
        if (!desktopWindow.isVisible()) desktopWindow.show();
        desktopWindow.focus();
        return desktopWindow;
    }

    // 璇诲彇璁剧疆鑾峰彇涓婚妯″紡
    let currentThemeMode = 'dark';
    try {
        if (appSettingsManager) {
            const settings = await appSettingsManager.readSettings();
            currentThemeMode = settings.currentThemeMode || 'dark';
        }
    } catch (e) {
        console.error('[Desktop] Failed to read theme settings:', e);
    }

    desktopWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 600,
        minHeight: 400,
        title: 'VCPdesktop',
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        webPreferences: {
            preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.DESKTOP),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
        show: false,
    });

    const desktopUrl = `file://${path.join(app.getAppPath(), 'Desktopmodules', 'desktop.html')}?currentThemeMode=${encodeURIComponent(currentThemeMode)}`;
    desktopWindow.loadURL(desktopUrl);
    windowService.attachWindow(WINDOW_APP_IDS.DESKTOP, desktopWindow);
    desktopWindow.setMenu(null);

    // 璇诲彇鍏ㄥ眬璁剧疆锛堣嚜鍔ㄦ渶澶у寲銆佺獥鍙ｇ疆搴曠瓑锛?
    let desktopGlobalSettings = {};
    try {
        if (fs.pathExistsSync(LAYOUT_CONFIG_PATH)) {
            const layoutData = fs.readJsonSync(LAYOUT_CONFIG_PATH);
            desktopGlobalSettings = layoutData.globalSettings || {};
        }
    } catch (e) {
        console.warn('[Desktop] Failed to read global settings:', e.message);
    }

    desktopWindow.once('ready-to-show', () => {
        // 鍚姩鏃惰嚜鍔ㄦ渶澶у寲
        if (desktopGlobalSettings.autoMaximize) {
            desktopWindow.maximize();
            console.log('[Desktop] Auto-maximized on startup');
        }

        // 浣跨敤 showInactive() 閬垮厤鎶㈠崰涓荤獥鍙ｇ劍鐐?
        desktopWindow.showInactive();

        // 绐楀彛鑷姩缃簳
        if (desktopGlobalSettings.alwaysOnBottom) {
            // 寤惰繜涓€灏忔鏃堕棿鍐嶅惎鐢紝纭繚绐楀彛宸插畬鍏ㄦ樉绀?
            setTimeout(() => {
                setAlwaysOnBottom(true);
            }, 500);
        }

        // 閫氱煡妗岄潰绐楀彛鑷韩杩炴帴鐘舵€?
        if (desktopWindow && !desktopWindow.isDestroyed()) {
            desktopWindow.webContents.send('desktop-status', { connected: true, message: 'Connected.' });
        }
        // 鍏抽敭锛氶€氱煡涓荤獥鍙ｆ闈㈢敾甯冨凡灏辩华锛岃涓荤獥鍙ｇ殑streamManager鐭ラ亾鍙互鎺ㄩ€佷簡
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop-status', { connected: true, message: 'Desktop window is ready.' });
        }
    });

    // 閿佸畾鏈€澶у寲鐘舵€侊細濡傛灉寮€鍚簡鑷姩鏈€澶у寲锛岄樆姝㈢敤鎴锋墜鍔ㄨ繕鍘?
    if (desktopGlobalSettings.autoMaximize) {
        desktopWindow.on('unmaximize', () => {
            // 鍦ㄤ笅涓€涓簨浠跺惊鐜腑閲嶆柊鏈€澶у寲锛屽疄鐜伴攣瀹氭晥鏋?
            setImmediate(() => {
                if (desktopWindow && !desktopWindow.isDestroyed()) {
                    desktopWindow.maximize();
                }
            });
        });
    }

    if (openChildWindows) {
        openChildWindows.push(desktopWindow);
    }

    desktopWindow.on('close', (event) => {
        if (process.platform === 'darwin' && !app.isQuitting) {
            event.preventDefault();
            desktopWindow.hide();
        }
    });

    desktopWindow.on('closed', () => {
        // 娓呯悊缃簳鐩稿叧璧勬簮
        alwaysOnBottomEnabled = false;
        if (alwaysOnBottomInterval) {
            clearInterval(alwaysOnBottomInterval);
            alwaysOnBottomInterval = null;
        }
        stopBottomHelper();

        if (openChildWindows) {
            const index = openChildWindows.indexOf(desktopWindow);
            if (index > -1) openChildWindows.splice(index, 1);
        }
        desktopWindow = null;
        console.log('[Desktop] Desktop window closed.');
        // 閫氱煡涓荤獥鍙ｆ闈㈢敾甯冨凡鍏抽棴
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop-status', { connected: false, message: 'Desktop window closed.' });
        }
    });

    return desktopWindow;
}

// --- 绐楀彛缃簳 Win32 鍘熺敓瀹炵幇 ---
let bottomHelperProcess = null;  // 鎸佷箙鍖栫殑 PowerShell 杩涚▼
let bottomHwnd = 0;             // 缂撳瓨鐨勭獥鍙ｅ彞鏌?

/**
 * 鍚姩涓€涓寔涔呭寲鐨?PowerShell 杩涚▼鐢ㄤ簬绐楀彛缃簳鎿嶄綔
 * 閬垮厤姣忔璋冪敤閮藉垱寤烘柊杩涚▼
 */
function startBottomHelper(hwnd) {
    if (process.platform !== 'win32') return;
    if (bottomHelperProcess) return; // 宸插惎鍔?

    bottomHwnd = hwnd;

    try {
        // 鍒涘缓涓€涓寔涔呭寲鐨?PowerShell 杩涚▼锛岄€氳繃 stdin 鎺ユ敹鍛戒护
        const { spawn } = require('child_process');
        bottomHelperProcess = spawn('powershell.exe', [
            '-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'
        ], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // 鍙戦€佸垵濮嬪寲鑴氭湰锛氬畾涔?Win32 API
        const initScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VCPWinAPI {
    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    public static void PushToBottom(IntPtr hwnd) {
        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }
}
"@
Write-Host "VCPREADY"
`;
        bottomHelperProcess.stdin.write(initScript + '\n');

        bottomHelperProcess.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg.includes('VCPREADY')) {
                console.log('[Desktop] Bottom helper PowerShell process ready');
            }
        });

        bottomHelperProcess.stderr.on('data', (data) => {
            // 蹇界暐璀﹀憡锛屽彧璁板綍閿欒
            const msg = data.toString().trim();
            if (msg && !msg.includes('WARNING')) {
                console.warn('[Desktop] Bottom helper stderr:', msg);
            }
        });

        bottomHelperProcess.on('exit', (code) => {
            console.log(`[Desktop] Bottom helper process exited with code ${code}`);
            bottomHelperProcess = null;
        });

        bottomHelperProcess.on('error', (err) => {
            console.error('[Desktop] Bottom helper process error:', err.message);
            bottomHelperProcess = null;
        });

    } catch (e) {
        console.error('[Desktop] Failed to start bottom helper:', e.message);
        bottomHelperProcess = null;
    }
}

/**
 * 鍋滄鎸佷箙鍖栫殑 PowerShell 杩涚▼
 */
function stopBottomHelper() {
    if (bottomHelperProcess) {
        try {
            bottomHelperProcess.stdin.write('exit\n');
            bottomHelperProcess.stdin.end();
        } catch (e) { /* ignore */ }
        bottomHelperProcess = null;
    }
    bottomHwnd = 0;
}

/**
 * 浣跨敤鎸佷箙鍖栫殑 PowerShell 杩涚▼璋冪敤 Win32 API 灏嗙獥鍙ｆ帹鍒板簳灞?
 */
function nativePushToBottom() {
    if (!bottomHelperProcess || !bottomHwnd) return;
    try {
        bottomHelperProcess.stdin.write(`[VCPWinAPI]::PushToBottom([IntPtr]${bottomHwnd})\n`);
    } catch (e) {
        console.warn('[Desktop] nativePushToBottom write error:', e.message);
    }
}

/**
 * 璁剧疆妗岄潰绐楀彛濮嬬粓缃簳
 * Windows: 浣跨敤鍘熺敓 SetWindowPos(HWND_BOTTOM) + focus 浜嬩欢鐩戝惉
 * 鍏朵粬骞冲彴: 浣跨敤 Electron setAlwaysOnTop 杩戜技鏂规
 * @param {boolean} enabled - 鏄惁鍚敤缃簳
 */
function setAlwaysOnBottom(enabled) {
    alwaysOnBottomEnabled = enabled;

    if (!desktopWindow || desktopWindow.isDestroyed()) return;

    // 娓呴櫎涔嬪墠鐨勫畾鏃跺櫒
    if (alwaysOnBottomInterval) {
        clearInterval(alwaysOnBottomInterval);
        alwaysOnBottomInterval = null;
    }

    // 绉婚櫎涔嬪墠鐨?focus 浜嬩欢鐩戝惉鍣?
    desktopWindow.removeAllListeners('focus');
    // 閲嶆柊娉ㄥ唽蹇呰鐨?focus 鐩戝惉锛堝鏋滄湁鍏朵粬妯″潡闇€瑕佺殑璇濆彲浠ュ湪杩欓噷鎭㈠锛?

    if (enabled) {
        console.log('[Desktop] Enabling always-on-bottom mode');

        // Windows: 鍚姩鎸佷箙鍖栫殑 PowerShell 杩涚▼
        if (process.platform === 'win32') {
            try {
                const handle = desktopWindow.getNativeWindowHandle();
                const hwnd = handle.readInt32LE(0);
                startBottomHelper(hwnd);
            } catch (e) {
                console.warn('[Desktop] Failed to get native handle:', e.message);
            }
        }

        const pushToBottom = () => {
            if (!desktopWindow || desktopWindow.isDestroyed() || !alwaysOnBottomEnabled) return;

            if (process.platform === 'win32') {
                // Windows: 閫氳繃鎸佷箙鍖?PowerShell 璋冪敤 Win32 SetWindowPos(HWND_BOTTOM)
                nativePushToBottom();
            } else {
                // 鍏朵粬骞冲彴: 浣跨敤 Electron API 杩戜技
                try {
                    desktopWindow.setAlwaysOnTop(true, 'screen-saver', -1);
                    desktopWindow.setAlwaysOnTop(false);
                } catch (e) { /* ignore */ }
            }
        };

        // 褰撶獥鍙ｈ幏寰楃劍鐐规椂锛岀珛鍗冲皢鍏舵帹鍒板簳閮?
        desktopWindow.on('focus', () => {
            if (!alwaysOnBottomEnabled) return;
            // 鐭殏寤惰繜鍚庝笅娌?
            setTimeout(() => {
                pushToBottom();
            }, 50);
        });

        // 瀹氭椂寮哄埗缃簳锛堟瘡 1.5 绉掓墽琛屼竴娆★紝纭繚鎸佺画鍦ㄥ簳灞傦級
        alwaysOnBottomInterval = setInterval(() => {
            if (!desktopWindow || desktopWindow.isDestroyed() || !alwaysOnBottomEnabled) {
                clearInterval(alwaysOnBottomInterval);
                alwaysOnBottomInterval = null;
                return;
            }
            pushToBottom();
        }, 1500);

        // 鍒濆涓嬫矇锛堝欢杩?200ms 纭繚 PowerShell 杩涚▼宸插垵濮嬪寲锛?
        setTimeout(() => pushToBottom(), 200);

    } else {
        console.log('[Desktop] Disabling always-on-bottom mode');
        // 鍋滄 PowerShell 杩涚▼
        stopBottomHelper();
        // 鎭㈠姝ｅ父绐楀彛琛屼负
        try {
            desktopWindow.setAlwaysOnTop(false);
        } catch (e) { /* ignore */ }
    }
}

/**
 * 鍚戞闈㈢敾甯冩帹閫佹暟鎹?
 * 鍙鍏朵粬妯″潡鐩存帴璋冪敤锛堜笉缁忚繃IPC锛?
 */
function pushToDesktop(data) {
    if (desktopWindow && !desktopWindow.isDestroyed()) {
        desktopWindow.webContents.send('desktop-push-to-canvas', data);
        return true;
    }
    return false;
}

/**
 * 鑾峰彇妗岄潰绐楀彛瀹炰緥
 */
function getDesktopWindow() {
    return desktopWindow;
}

module.exports = {
    initialize,
    openDesktopWindow,
    pushToDesktop,
    getDesktopWindow,
    generateCatalog,
};
