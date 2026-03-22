/**
 * modules/ipc/desktopHandlers.js
 * VCPdesktop IPC 处理模块
 * 负责：桌面窗口创建管理、流式推送转发、收藏系统持久化、快捷方式解析/启动、Dock持久化、布局持久化、壁纸文件选择
 */

const { BrowserWindow, ipcMain, app, screen, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// --- 模块状态 ---
let desktopWindow = null;
let mainWindow = null;
let openChildWindows = [];
let appSettingsManager = null;
let alwaysOnBottomEnabled = false;
let alwaysOnBottomInterval = null;

// --- 收藏系统路径 - 使用项目根目录的 AppData ---
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DESKTOP_WIDGETS_DIR = path.join(PROJECT_ROOT, 'AppData', 'DesktopWidgets');
const DESKTOP_DATA_DIR = path.join(PROJECT_ROOT, 'AppData', 'DesktopData');
const DOCK_CONFIG_PATH = path.join(DESKTOP_DATA_DIR, 'dock.json');
const LAYOUT_CONFIG_PATH = path.join(DESKTOP_DATA_DIR, 'layout.json');

/**
 * 检测图标是否有效（非空白/非全透明）
 * Windows 对某些系统应用（如 UWP/MSIX）可能返回一个非空但几乎全透明或全白的图标，
 * 这类图标虽然 isEmpty() 返回 false，但视觉上是空白的。
 * @param {Electron.NativeImage} nativeImg - Electron NativeImage 对象
 * @returns {boolean} 图标是否有意义（有可见内容）
 */
function isIconValid(nativeImg) {
    try {
        const bitmap = nativeImg.toBitmap();
        const size = nativeImg.getSize();
        if (!bitmap || bitmap.length === 0 || size.width === 0 || size.height === 0) {
            return false;
        }

        const totalPixels = size.width * size.height;
        let opaquePixels = 0;          // 有不透明度的像素
        let colorfulPixels = 0;        // 有实际颜色（非纯白/纯黑）的像素

        // RGBA 格式，每像素 4 字节
        // 采样检测：为了性能，对大图只采样部分像素
        const step = totalPixels > 1024 ? Math.floor(totalPixels / 512) : 1;

        for (let i = 0; i < totalPixels; i += step) {
            const offset = i * 4;
            const r = bitmap[offset];
            const g = bitmap[offset + 1];
            const b = bitmap[offset + 2];
            const a = bitmap[offset + 3];

            if (a > 20) {
                opaquePixels++;
                // 检查是否有实际颜色（非接近纯白或纯黑）
                if (!((r > 240 && g > 240 && b > 240) || (r < 15 && g < 15 && b < 15))) {
                    colorfulPixels++;
                }
            }
        }

        const sampledPixels = Math.ceil(totalPixels / step);
        const opaqueRatio = opaquePixels / sampledPixels;

        // 如果不透明像素少于 5%，判定为空白图标
        if (opaqueRatio < 0.05) {
            return false;
        }

        // 图标有足够的不透明内容，视为有效
        return true;
    } catch (e) {
        // 检测失败时保守地认为图标有效
        console.warn('[DesktopHandlers] isIconValid check failed:', e.message);
        return true;
    }
}

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

    // --- IPC: 窗口始终置底控制 ---
    ipcMain.handle('desktop-set-always-on-bottom', (event, enabled) => {
        setAlwaysOnBottom(enabled);
        return { success: true };
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
                if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                    iconDataUrl = nativeImage.toDataURL();
                }
            } catch (iconErr) {
                console.warn('[DesktopHandlers] Icon extraction failed:', iconErr.message);
                // 尝试从 .lnk 文件本身提取图标
                try {
                    const nativeImage = await app.getFileIcon(filePath, { size: 'large' });
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
                        if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                            iconDataUrl = nativeImage.toDataURL();
                        }
                    } catch (e) {
                        try {
                            const nativeImage = await app.getFileIcon(filePath, { size: 'large' });
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

    // ============================================================
    // --- IPC: 图标集系统（iconset） ---
    // ============================================================

    const ICONSET_DIR = path.join(PROJECT_ROOT, 'assets', 'iconset');

    /**
     * 获取所有图标预设文件夹列表
     * 返回：{ success, presets: [{ name, iconCount }] }
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
                const iconFiles = files.filter(f => /\.(png|jpg|jpeg|svg|ico|webp)$/i.test(f));
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
     * 获取指定预设文件夹中的图标列表
     * 参数：{ presetName, page, pageSize, search }
     * 返回：{ success, icons: [{ name, relativePath }], total, page, pageSize }
     */
    ipcMain.handle('desktop-iconset-list-icons', async (event, params) => {
        try {
            const { presetName, page = 1, pageSize = 50, search = '' } = params;
            const presetDir = path.join(ICONSET_DIR, presetName);

            if (!await fs.pathExists(presetDir)) {
                return { success: false, error: '预设文件夹不存在', icons: [], total: 0 };
            }

            const files = await fs.readdir(presetDir);
            let iconFiles = files.filter(f => /\.(png|jpg|jpeg|svg|ico|webp)$/i.test(f));

            // 搜索过滤
            if (search) {
                const searchLower = search.toLowerCase();
                iconFiles = iconFiles.filter(f => f.toLowerCase().includes(searchLower));
            }

            iconFiles.sort((a, b) => a.localeCompare(b));

            const total = iconFiles.length;
            const startIndex = (page - 1) * pageSize;
            const pagedFiles = iconFiles.slice(startIndex, startIndex + pageSize);

            const icons = pagedFiles.map(f => ({
                name: path.basename(f, path.extname(f)),
                fileName: f,
                // 相对于项目根目录的路径，前端使用 ../assets/iconset/... 访问
                relativePath: `assets/iconset/${presetName}/${f}`,
            }));

            return { success: true, icons, total, page, pageSize };
        } catch (err) {
            console.error('[DesktopHandlers] List iconset icons error:', err);
            return { success: false, error: err.message, icons: [], total: 0 };
        }
    });

    /**
     * 将图标文件读取为 Data URL（用于高质量显示或持久化）
     * 参数：relativePath - 相对于项目根目录的路径
     * 返回：{ success, dataUrl }
     */
    ipcMain.handle('desktop-iconset-get-icon-data', async (event, relativePath) => {
        try {
            const fullPath = path.join(PROJECT_ROOT, relativePath);
            if (!await fs.pathExists(fullPath)) {
                return { success: false, error: '图标文件不存在' };
            }

            const buffer = await fs.readFile(fullPath);
            const ext = path.extname(fullPath).toLowerCase();
            const mimeTypes = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon',
                '.webp': 'image/webp',
            };
            const mime = mimeTypes[ext] || 'image/png';
            const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

            return { success: true, dataUrl };
        } catch (err) {
            console.error('[DesktopHandlers] Get icon data error:', err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: 壁纸文件选择 ---
    // ============================================================

    /**
     * 打开文件选择对话框，选择壁纸文件
     * 支持图片、视频(mp4)、HTML 文件
     * 返回：{ success, filePath, fileUrl, type }
     */
    ipcMain.handle('desktop-select-wallpaper', async () => {
        try {
            const targetWindow = desktopWindow && !desktopWindow.isDestroyed() ? desktopWindow : mainWindow;
            const result = await dialog.showOpenDialog(targetWindow, {
                title: '选择壁纸文件',
                properties: ['openFile'],
                filters: [
                    { name: '所有壁纸类型', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'mp4', 'webm', 'html', 'htm'] },
                    { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'] },
                    { name: '视频', extensions: ['mp4', 'webm'] },
                    { name: 'HTML 动态壁纸', extensions: ['html', 'htm'] },
                ],
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return { success: false, canceled: true };
            }

            const filePath = result.filePaths[0];
            const ext = path.extname(filePath).toLowerCase().replace('.', '');

            // 检测文件类型
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'];
            const videoExts = ['mp4', 'webm'];
            const htmlExts = ['html', 'htm'];

            let type = 'unknown';
            if (imageExts.includes(ext)) type = 'image';
            else if (videoExts.includes(ext)) type = 'video';
            else if (htmlExts.includes(ext)) type = 'html';

            // 将文件路径转为 file:// URL（Electron 渲染进程可以安全加载）
            const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`;

            console.log(`[DesktopHandlers] Wallpaper selected: ${type} - ${filePath}`);
            return { success: true, filePath, fileUrl, type };
        } catch (err) {
            console.error('[DesktopHandlers] Select wallpaper error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 读取壁纸文件并返回 Data URL（用于图片壁纸预览或嵌入）
     * 对于大文件使用 file:// URL 更合适，此 API 主要用于缩略图预览
     */
    ipcMain.handle('desktop-read-wallpaper-thumbnail', async (event, filePath) => {
        try {
            if (!filePath || !await fs.pathExists(filePath)) {
                return { success: false, error: '文件不存在' };
            }

            const ext = path.extname(filePath).toLowerCase();
            const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif'];

            if (!imageExts.includes(ext)) {
                // 非图片类型返回空缩略图
                return { success: true, thumbnail: '', type: ext.replace('.', '') };
            }

            // 读取并缩放为缩略图
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

    console.log('[DesktopHandlers] Initialized (with favorites, vcpAPI, shortcuts, dock, layout, iconset & wallpaper system).');
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

    // 读取全局设置（自动最大化、窗口置底等）
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
        // 启动时自动最大化
        if (desktopGlobalSettings.autoMaximize) {
            desktopWindow.maximize();
            console.log('[Desktop] Auto-maximized on startup');
        }

        desktopWindow.show();

        // 窗口自动置底
        if (desktopGlobalSettings.alwaysOnBottom) {
            // 延迟一小段时间再启用，确保窗口已完全显示
            setTimeout(() => {
                setAlwaysOnBottom(true);
            }, 500);
        }

        // 通知桌面窗口自身连接状态
        if (desktopWindow && !desktopWindow.isDestroyed()) {
            desktopWindow.webContents.send('desktop-status', { connected: true, message: '已连接' });
        }
        // 关键：通知主窗口桌面画布已就绪，让主窗口的streamManager知道可以推送了
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop-status', { connected: true, message: '桌面画布已就绪' });
        }
    });

    // 锁定最大化状态：如果开启了自动最大化，阻止用户手动还原
    if (desktopGlobalSettings.autoMaximize) {
        desktopWindow.on('unmaximize', () => {
            // 在下一个事件循环中重新最大化，实现锁定效果
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
        // 清理置底相关资源
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
        // 通知主窗口桌面画布已关闭
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop-status', { connected: false, message: '桌面画布已关闭' });
        }
    });

    return desktopWindow;
}

// --- 窗口置底 Win32 原生实现 ---
let bottomHelperProcess = null;  // 持久化的 PowerShell 进程
let bottomHwnd = 0;             // 缓存的窗口句柄

/**
 * 启动一个持久化的 PowerShell 进程用于窗口置底操作
 * 避免每次调用都创建新进程
 */
function startBottomHelper(hwnd) {
    if (process.platform !== 'win32') return;
    if (bottomHelperProcess) return; // 已启动

    bottomHwnd = hwnd;

    try {
        // 创建一个持久化的 PowerShell 进程，通过 stdin 接收命令
        const { spawn } = require('child_process');
        bottomHelperProcess = spawn('powershell.exe', [
            '-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'
        ], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // 发送初始化脚本：定义 Win32 API
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
            // 忽略警告，只记录错误
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
 * 停止持久化的 PowerShell 进程
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
 * 使用持久化的 PowerShell 进程调用 Win32 API 将窗口推到底层
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
 * 设置桌面窗口始终置底
 * Windows: 使用原生 SetWindowPos(HWND_BOTTOM) + focus 事件监听
 * 其他平台: 使用 Electron setAlwaysOnTop 近似方案
 * @param {boolean} enabled - 是否启用置底
 */
function setAlwaysOnBottom(enabled) {
    alwaysOnBottomEnabled = enabled;

    if (!desktopWindow || desktopWindow.isDestroyed()) return;

    // 清除之前的定时器
    if (alwaysOnBottomInterval) {
        clearInterval(alwaysOnBottomInterval);
        alwaysOnBottomInterval = null;
    }

    // 移除之前的 focus 事件监听器
    desktopWindow.removeAllListeners('focus');
    // 重新注册必要的 focus 监听（如果有其他模块需要的话可以在这里恢复）

    if (enabled) {
        console.log('[Desktop] Enabling always-on-bottom mode');

        // Windows: 启动持久化的 PowerShell 进程
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
                // Windows: 通过持久化 PowerShell 调用 Win32 SetWindowPos(HWND_BOTTOM)
                nativePushToBottom();
            } else {
                // 其他平台: 使用 Electron API 近似
                try {
                    desktopWindow.setAlwaysOnTop(true, 'screen-saver', -1);
                    desktopWindow.setAlwaysOnTop(false);
                } catch (e) { /* ignore */ }
            }
        };

        // 当窗口获得焦点时，立即将其推到底部
        desktopWindow.on('focus', () => {
            if (!alwaysOnBottomEnabled) return;
            // 短暂延迟后下沉
            setTimeout(() => {
                pushToBottom();
            }, 50);
        });

        // 定时强制置底（每 1.5 秒执行一次，确保持续在底层）
        alwaysOnBottomInterval = setInterval(() => {
            if (!desktopWindow || desktopWindow.isDestroyed() || !alwaysOnBottomEnabled) {
                clearInterval(alwaysOnBottomInterval);
                alwaysOnBottomInterval = null;
                return;
            }
            pushToBottom();
        }, 1500);

        // 初始下沉（延迟 200ms 确保 PowerShell 进程已初始化）
        setTimeout(() => pushToBottom(), 200);

    } else {
        console.log('[Desktop] Disabling always-on-bottom mode');
        // 停止 PowerShell 进程
        stopBottomHelper();
        // 恢复正常窗口行为
        try {
            desktopWindow.setAlwaysOnTop(false);
        } catch (e) { /* ignore */ }
    }
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