/**
 * modules/ipc/desktopHandlers.js
 * VCPdesktop IPC 处理模块
 * 负责：桌面窗口创建管理、流式推送转发、收藏系统持久化、快捷方式解析/启动、Dock持久化、布局持久化
 */

const { BrowserWindow, ipcMain, app, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// --- 模块状态 ---
let desktopWindow = null;
let mainWindow = null;
let openChildWindows = [];
let appSettingsManager = null;

// --- 收藏系统路径 - 使用项目根目录的 AppData ---
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DESKTOP_WIDGETS_DIR = path.join(PROJECT_ROOT, 'AppData', 'DesktopWidgets');
const DESKTOP_DATA_DIR = path.join(PROJECT_ROOT, 'AppData', 'DesktopData');
const DOCK_CONFIG_PATH = path.join(DESKTOP_DATA_DIR, 'dock.json');
const LAYOUT_CONFIG_PATH = path.join(DESKTOP_DATA_DIR, 'layout.json');

/**
 * 初始化桌面处理模块
 */
function initialize(params) {
    mainWindow = params.mainWindow;
    openChildWindows = params.openChildWindows;
    appSettingsManager = params.settingsManager;

    // 确保目录存在
    fs.ensureDirSync(DESKTOP_WIDGETS_DIR);
    fs.ensureDirSync(DESKTOP_DATA_DIR);

    // --- IPC: 打开桌面窗口 ---
    ipcMain.handle('open-desktop-window', async () => {
        await openDesktopWindow();
    });

    // --- IPC: 主窗口 → 桌面画布的流式推送 ---
    ipcMain.on('desktop-push', (event, data) => {
        if (desktopWindow && !desktopWindow.isDestroyed()) {
            desktopWindow.webContents.send('desktop-push-to-canvas', data);
        }
    });

    // --- IPC: 收藏系统 ---

    // 保存/更新收藏
    ipcMain.handle('desktop-save-widget', async (event, data) => {
        try {
            const { id, name, html, thumbnail } = data;
            console.log(`[DesktopHandlers] desktop-save-widget called: id=${id}, name=${name}, html length=${html?.length}, has thumbnail=${!!thumbnail}`);
            if (!id || !name || !html) {
                console.error('[DesktopHandlers] Missing required params:', { id: !!id, name: !!name, html: !!html });
                return { success: false, error: '缺少必要参数' };
            }

            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, id);
            await fs.ensureDir(widgetDir);

            // 保存HTML内容
            await fs.writeFile(path.join(widgetDir, 'widget.html'), html, 'utf-8');

            // 保存元数据
            const meta = {
                id,
                name,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            // 读取已有元数据保留createdAt
            const metaPath = path.join(widgetDir, 'meta.json');
            if (await fs.pathExists(metaPath)) {
                try {
                    const existingMeta = await fs.readJson(metaPath);
                    meta.createdAt = existingMeta.createdAt || meta.createdAt;
                } catch (e) { /* ignore */ }
            }

            await fs.writeJson(metaPath, meta, { spaces: 2 });

            // 保存缩略图（Base64 Data URL → PNG文件）
            if (thumbnail && thumbnail.startsWith('data:image/')) {
                const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
                const thumbBuffer = Buffer.from(base64Data, 'base64');
                await fs.writeFile(path.join(widgetDir, 'thumbnail.png'), thumbBuffer);
            }

            console.log(`[DesktopHandlers] Widget saved: ${name} (${id}) to ${widgetDir}`);
            return { success: true, id };
        } catch (err) {
            console.error('[DesktopHandlers] Save widget error:', err);
            return { success: false, error: err.message };
        }
    });

    // 加载收藏（读取HTML内容）
    ipcMain.handle('desktop-load-widget', async (event, id) => {
        try {
            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, id);
            const htmlPath = path.join(widgetDir, 'widget.html');
            const metaPath = path.join(widgetDir, 'meta.json');

            if (!(await fs.pathExists(htmlPath))) {
                return { success: false, error: '收藏不存在' };
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

    // 删除收藏
    ipcMain.handle('desktop-delete-widget', async (event, id) => {
        try {
            const widgetDir = path.join(DESKTOP_WIDGETS_DIR, id);
            if (await fs.pathExists(widgetDir)) {
                await fs.remove(widgetDir);
                console.log(`[DesktopHandlers] Widget deleted: ${id}`);
            }
            return { success: true };
        } catch (err) {
            console.error('[DesktopHandlers] Delete widget error:', err);
            return { success: false, error: err.message };
        }
    });

    // 列出所有收藏（返回id、name、thumbnail的Data URL）
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

                // 读取缩略图为Data URL
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

            // 按更新时间倒序排列
            widgets.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

            return { success: true, widgets };
        } catch (err) {
            console.error('[DesktopHandlers] List widgets error:', err);
            return { success: false, error: err.message, widgets: [] };
        }
    });

    // 截取桌面窗口指定矩形区域的截图
    ipcMain.handle('desktop-capture-widget', async (event, rect) => {
        try {
            if (!desktopWindow || desktopWindow.isDestroyed()) {
                return { success: false, error: '桌面窗口不存在' };
            }

            const { x, y, width, height } = rect;
            // capturePage 需要整数坐标
            const captureRect = {
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
            };

            console.log(`[DesktopHandlers] Capturing widget area:`, captureRect);
            const image = await desktopWindow.webContents.capturePage(captureRect);
            
            // 缩放到合理的缩略图尺寸
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

    // 获取 VCP 后端凭据（供桌面 widget 的 vcpAPI 使用）
    ipcMain.handle('desktop-get-credentials', async () => {
        try {
            const settingsPath = path.join(PROJECT_ROOT, 'AppData', 'settings.json');
            const forumConfigPath = path.join(PROJECT_ROOT, 'AppData', 'UserData', 'forum.config.json');

            let vcpServerUrl = '';
            let username = '';
            let password = '';

            if (await fs.pathExists(settingsPath)) {
                try {
                    const settings = await fs.readJson(settingsPath);
                    vcpServerUrl = settings.vcpServerUrl || '';
                } catch (e) { /* ignore */ }
            }

            if (await fs.pathExists(forumConfigPath)) {
                try {
                    const config = await fs.readJson(forumConfigPath);
                    username = config.username || '';
                    password = config.password || '';
                } catch (e) { /* ignore */ }
            }

            // 从 vcpServerUrl 推导出 admin API base URL
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
                username,
                password,
            };
        } catch (err) {
            console.error('[DesktopHandlers] Get credentials error:', err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: 快捷方式解析 & 启动 ---
    // ============================================================

    /**
     * 解析 Windows 快捷方式 (.lnk) 文件
     * 返回：{ name, targetPath, args, icon (DataURL), workingDir }
     */
    ipcMain.handle('desktop-shortcut-parse', async (event, filePath) => {
        try {
            if (!filePath || !filePath.toLowerCase().endsWith('.lnk')) {
                return { success: false, error: '不是有效的快捷方式文件' };
            }

            // 使用 Electron 原生 API 解析 .lnk
            let shortcutDetails;
            try {
                shortcutDetails = shell.readShortcutLink(filePath);
            } catch (e) {
                return { success: false, error: `解析快捷方式失败: ${e.message}` };
            }

            const targetPath = shortcutDetails.target || '';
            const args = shortcutDetails.args || '';
            const workingDir = shortcutDetails.cwd || '';
            const description = shortcutDetails.description || '';

            // 从文件名提取显示名称
            const name = path.basename(filePath, '.lnk');

            // 提取图标
            let iconDataUrl = '';
            try {
                // 优先从目标可执行文件提取图标
                const iconTarget = targetPath || filePath;
                const nativeImage = await app.getFileIcon(iconTarget, { size: 'large' });
                if (nativeImage && !nativeImage.isEmpty()) {
                    iconDataUrl = nativeImage.toDataURL();
                }
            } catch (iconErr) {
                console.warn('[DesktopHandlers] Icon extraction failed:', iconErr.message);
                // 尝试从 .lnk 文件本身提取图标
                try {
                    const nativeImage = await app.getFileIcon(filePath, { size: 'large' });
                    if (nativeImage && !nativeImage.isEmpty()) {
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
     * 批量解析多个快捷方式文件
     */
    ipcMain.handle('desktop-shortcut-parse-batch', async (event, filePaths) => {
        try {
            if (!Array.isArray(filePaths)) {
                return { success: false, error: '参数必须是文件路径数组' };
            }

            const results = [];
            for (const filePath of filePaths) {
                try {
                    if (!filePath.toLowerCase().endsWith('.lnk')) continue;

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
                        const nativeImage = await app.getFileIcon(iconTarget, { size: 'large' });
                        if (nativeImage && !nativeImage.isEmpty()) {
                            iconDataUrl = nativeImage.toDataURL();
                        }
                    } catch (e) {
                        try {
                            const nativeImage = await app.getFileIcon(filePath, { size: 'large' });
                            if (nativeImage && !nativeImage.isEmpty()) {
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
     * 启动快捷方式目标程序
     */
    ipcMain.handle('desktop-shortcut-launch', async (event, shortcutData) => {
        try {
            const { targetPath, args, workingDir, originalPath } = shortcutData;

            if (!targetPath && !originalPath) {
                return { success: false, error: '缺少目标路径' };
            }

            // 优先使用 shell.openPath 打开原始 .lnk 文件（保留完整的快捷方式配置如管理员权限等）
            if (originalPath && await fs.pathExists(originalPath)) {
                console.log(`[DesktopHandlers] Launching shortcut via .lnk: ${originalPath}`);
                const errorMsg = await shell.openPath(originalPath);
                if (errorMsg) {
                    return { success: false, error: errorMsg };
                }
                return { success: true };
            }

            // 备选方案：直接打开目标路径
            if (targetPath && await fs.pathExists(targetPath)) {
                console.log(`[DesktopHandlers] Launching target: ${targetPath}`);
                const errorMsg = await shell.openPath(targetPath);
                if (errorMsg) {
                    return { success: false, error: errorMsg };
                }
                return { success: true };
            }

            return { success: false, error: '目标文件不存在' };
        } catch (err) {
            console.error('[DesktopHandlers] Shortcut launch error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 扫描 Windows 桌面上的快捷方式
     * 自动扫描公共桌面和用户桌面
     */
    ipcMain.handle('desktop-scan-shortcuts', async () => {
        try {
            if (process.platform !== 'win32') {
                return { success: false, error: '此功能仅支持 Windows 平台' };
            }

            const shortcuts = [];
            const desktopPaths = [
                app.getPath('desktop'),  // 用户桌面
                path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),  // 公共桌面
            ];

            for (const desktopPath of desktopPaths) {
                try {
                    if (!await fs.pathExists(desktopPath)) continue;
                    const files = await fs.readdir(desktopPath);

                    for (const file of files) {
                        if (!file.toLowerCase().endsWith('.lnk')) continue;

                        const filePath = path.join(desktopPath, file);
                        try {
                            const shortcutDetails = shell.readShortcutLink(filePath);
                            const targetPath = shortcutDetails.target || '';
                            const name = path.basename(file, '.lnk');

                            let iconDataUrl = '';
                            try {
                                const iconTarget = targetPath || filePath;
                                const nativeImage = await app.getFileIcon(iconTarget, { size: 'large' });
                                if (nativeImage && !nativeImage.isEmpty()) {
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
                            // 跳过无法解析的快捷方式
                            console.warn(`[DesktopHandlers] Cannot parse: ${file}`, e.message);
                        }
                    }
                } catch (e) {
                    console.warn(`[DesktopHandlers] Cannot read desktop dir: ${desktopPath}`, e.message);
                }
            }

            // 按名称排序
            shortcuts.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

            console.log(`[DesktopHandlers] Scanned ${shortcuts.length} shortcuts from Windows desktop`);
            return { success: true, shortcuts };
        } catch (err) {
            console.error('[DesktopHandlers] Scan shortcuts error:', err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: Dock 持久化 ---
    // ============================================================

    /**
     * 保存 Dock 配置
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
     * 加载 Dock 配置
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
    // --- IPC: 布局持久化 ---
    // ============================================================

    /**
     * 保存桌面布局
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
     * 加载桌面布局
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

    console.log('[DesktopHandlers] Initialized (with favorites, vcpAPI, shortcuts, dock & layout system).');
}

/**
 * 打开或聚焦桌面画布窗口
 */
async function openDesktopWindow() {
    if (desktopWindow && !desktopWindow.isDestroyed()) {
        if (!desktopWindow.isVisible()) desktopWindow.show();
        desktopWindow.focus();
        return desktopWindow;
    }

    // 读取设置获取主题模式
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
            preload: path.join(app.getAppPath(), 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
        show: false,
    });

    const desktopUrl = `file://${path.join(app.getAppPath(), 'Desktopmodules', 'desktop.html')}?currentThemeMode=${encodeURIComponent(currentThemeMode)}`;
    desktopWindow.loadURL(desktopUrl);
    desktopWindow.setMenu(null);

    desktopWindow.once('ready-to-show', () => {
        desktopWindow.show();
        // 通知桌面窗口自身连接状态
        if (desktopWindow && !desktopWindow.isDestroyed()) {
            desktopWindow.webContents.send('desktop-status', { connected: true, message: '已连接' });
        }
        // 关键：通知主窗口桌面画布已就绪，让主窗口的streamManager知道可以推送了
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop-status', { connected: true, message: '桌面画布已就绪' });
        }
    });

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
        if (openChildWindows) {
            const index = openChildWindows.indexOf(desktopWindow);
            if (index > -1) openChildWindows.splice(index, 1);
        }
        desktopWindow = null;
        console.log('[Desktop] Desktop window closed.');
        // 通知主窗口桌面画布已关闭
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop-status', { connected: false, message: '桌面画布已关闭' });
        }
    });

    return desktopWindow;
}

/**
 * 向桌面画布推送数据
 * 可被其他模块直接调用（不经过IPC）
 */
function pushToDesktop(data) {
    if (desktopWindow && !desktopWindow.isDestroyed()) {
        desktopWindow.webContents.send('desktop-push-to-canvas', data);
        return true;
    }
    return false;
}

/**
 * 获取桌面窗口实例
 */
function getDesktopWindow() {
    return desktopWindow;
}

module.exports = {
    initialize,
    openDesktopWindow,
    pushToDesktop,
    getDesktopWindow,
};