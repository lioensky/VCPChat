/**
 * modules/ipc/desktopHandlers.js
 * VCPdesktop IPC 处理模块
 * 负责：桌面窗口创建管理、流式推送转发、收藏系统持久化、快捷方式解析/启动、Dock持久化、布局持久化、壁纸文件选择、VChat内部应用启动
 */

const { BrowserWindow, ipcMain, app, screen, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// --- 模块状态 ---
let desktopWindow = null;
let mainWindow = null;
let openChildWindows = [];
let appSettingsManager = null;
let alwaysOnBottomEnabled = false;
let alwaysOnBottomInterval = null;

// --- 独立 Electron App 子进程引用（防止重复启动） ---
const standaloneAppProcesses = new Map(); // appDir -> child_process

// --- VChat 内部子窗口单例引用 ---
let vchatForumWindow = null;
let vchatMemoWindow = null;
let vchatTranslatorWindow = null;
let vchatMusicWindow = null;
let vchatThemesWindow = null;

// --- 收藏系统路径 - 使用项目根目录的 AppData ---
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DESKTOP_WIDGETS_DIR = path.join(PROJECT_ROOT, 'AppData', 'DesktopWidgets');
const DESKTOP_DATA_DIR = path.join(PROJECT_ROOT, 'AppData', 'DesktopData');
const DOCK_CONFIG_PATH = path.join(DESKTOP_DATA_DIR, 'dock.json');
const LAYOUT_CONFIG_PATH = path.join(DESKTOP_DATA_DIR, 'layout.json');
const CATALOG_PATH = path.join(DESKTOP_WIDGETS_DIR, 'CATALOG.md');

/**
 * 自动生成 CATALOG.md —— 收藏挂件目录索引
 *
 * 遍历 DesktopWidgets 目录中所有子文件夹，读取 meta.json，
 * 生成一份人类可读的 Markdown 文档，方便 AI 或用户通过 list 指令
 * 快速了解每个文件夹对应的插件名称和内部文件结构。
 *
 * 该函数在以下时机自动调用：
 *   - 保存/更新收藏后 (desktop-save-widget)
 *   - 删除收藏后 (desktop-delete-widget)
 *   - 初始化时 (initialize)
 */
async function generateCatalog() {
    try {
        await fs.ensureDir(DESKTOP_WIDGETS_DIR);
        const entries = await fs.readdir(DESKTOP_WIDGETS_DIR, { withFileTypes: true });

        // 收集所有 widget 信息
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

            // 递归收集文件树
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

        // 按名称排序
        widgets.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));

        // 生成 Markdown 内容
        const lines = [];
        lines.push('# 📦 桌面挂件收藏目录 (CATALOG)');
        lines.push('');
        lines.push('> 此文件由系统自动生成和维护，请勿手动编辑。');
        lines.push(`> 最后更新: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        lines.push('');
        lines.push(`共 **${widgets.length}** 个收藏挂件。`);
        lines.push('');

        if (widgets.length > 0) {
            // 快速索引表
            lines.push('## 📋 快速索引');
            lines.push('');
            lines.push('| # | 收藏名称 | 文件夹 ID | 创建时间 | 更新时间 |');
            lines.push('|---|---------|----------|---------|---------|');
            widgets.forEach((w, i) => {
                const created = w.createdAt ? new Date(w.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知';
                const updated = w.updatedAt ? new Date(w.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知';
                lines.push(`| ${i + 1} | **${w.name}** | \`${w.dirName}\` | ${created} | ${updated} |`);
            });
            lines.push('');

            // 详细文件树
            lines.push('## 📂 详细文件树');
            lines.push('');
            for (const w of widgets) {
                lines.push(`### ${w.name}`);
                lines.push('');
                lines.push(`- **文件夹**: \`${w.dirName}/\``);
                lines.push(`- **收藏 ID**: \`${w.id}\``);
                if (w.createdAt) {
                    lines.push(`- **创建时间**: ${new Date(w.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
                }
                if (w.updatedAt) {
                    lines.push(`- **更新时间**: ${new Date(w.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
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
 * 递归收集目录下的文件列表（相对路径）
 * @param {string} dirPath - 绝对目录路径
 * @param {string} prefix - 当前递归前缀（用于缩进显示）
 * @returns {Promise<string[]>} 文件路径列表
 */
async function collectFileTree(dirPath, prefix) {
    const result = [];
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        // 排序：目录在前，文件在后
        entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            if (entry.name === 'CATALOG.md') continue; // 跳过自身
            if (entry.isDirectory()) {
                result.push(`${prefix}${entry.name}/`);
                const subFiles = await collectFileTree(path.join(dirPath, entry.name), prefix + '  ');
                result.push(...subFiles);
            } else {
                // 附加文件大小信息
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
 * 格式化文件大小
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
 * 在所有已打开的窗口中查找 URL 包含指定关键词的窗口
 * @param {string} urlKeyword - URL 中需要包含的关键词（如 'forum.html'）
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
 * 创建或聚焦一个通用子窗口（用于 VChat 内部应用）
 * @param {BrowserWindow|null} existingWindow - 现有窗口引用
 * @param {object} options - 窗口配置
 * @returns {BrowserWindow} 创建或聚焦后的窗口
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
            preload: path.join(app.getAppPath(), 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true,
        },
        icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
        show: false,
    });

    // 构建 URL
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
        // 清理单例引用
        if (win === vchatForumWindow) vchatForumWindow = null;
        if (win === vchatMemoWindow) vchatMemoWindow = null;
        if (win === vchatTranslatorWindow) vchatTranslatorWindow = null;
        if (win === vchatThemesWindow) vchatThemesWindow = null;
    });

    console.log(`[DesktopHandlers] Created child window: ${options.title}`);
    return win;
}

/**
 * 启动 Windows 系统工具
 * 支持的命令格式：
 *   - ms-settings:display     → 打开 Windows 显示设置
 *   - ms-settings:            → 打开 Windows 设置首页
 *   - control                 → 打开控制面板
 *   - shell:RecycleBinFolder  → 打开回收站
 *   - shell:MyComputerFolder  → 打开此电脑
 * @param {string} cmd - 系统命令
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function launchSystemTool(cmd) {
    try {
        if (!cmd) {
            return { success: false, error: '缺少命令参数' };
        }

        console.log(`[DesktopHandlers] Launching system tool: ${cmd}`);

        if (cmd.startsWith('ms-settings:')) {
            // Windows 设置 URI - 使用 shell.openExternal
            await shell.openExternal(cmd);
            return { success: true };
        }

        if (cmd === 'control') {
            // 控制面板 - 使用 shell.openPath
            const { exec } = require('child_process');
            exec('control.exe', (err) => {
                if (err) console.warn('[DesktopHandlers] control.exe launch warning:', err.message);
            });
            return { success: true };
        }

        if (cmd.startsWith('shell:')) {
            // Windows Shell 文件夹 - 使用 explorer.exe
            const { exec } = require('child_process');
            exec(`explorer.exe ${cmd}`, (err) => {
                if (err) console.warn('[DesktopHandlers] explorer.exe launch warning:', err.message);
            });
            return { success: true };
        }

        // 通用方案：尝试直接打开
        await shell.openPath(cmd);
        return { success: true };
    } catch (err) {
        console.error(`[DesktopHandlers] System tool launch error (${cmd}):`, err);
        return { success: false, error: err.message };
    }
}

/**
 * 启动独立的 Electron App（如人类工具箱、VchatManager）
 * 这些应用是项目内的独立 Electron 入口，拥有各自的 main.js。
 * 通过 child_process.spawn 启动一个新的 electron 实例。
 *
 * @param {string} appDir - 应用目录名（相对于项目根目录，如 'VCPHumanToolBox'）
 * @param {string} displayName - 显示名称（用于日志和状态提示）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function launchStandaloneElectronApp(appDir, displayName) {
    try {
        const appPath = path.join(PROJECT_ROOT, appDir);
        const mainJsPath = path.join(appPath, 'main.js');

        // 检查目录和入口文件是否存在
        if (!await fs.pathExists(mainJsPath)) {
            console.error(`[DesktopHandlers] Standalone app not found: ${mainJsPath}`);
            return { success: false, error: `${displayName} 入口文件不存在: ${appDir}/main.js` };
        }

        // 检查是否已有该应用的进程在运行
        const existingProcess = standaloneAppProcesses.get(appDir);
        if (existingProcess && !existingProcess.killed) {
            // 进程存在，检查是否还活着
            try {
                process.kill(existingProcess.pid, 0); // 发送信号 0 检测进程是否存活
                console.log(`[DesktopHandlers] ${displayName} already running (PID: ${existingProcess.pid})`);
                return { success: true, alreadyRunning: true };
            } catch (e) {
                // 进程已退出，清理引用
                standaloneAppProcesses.delete(appDir);
            }
        }

        // 获取当前 Electron 可执行文件路径
        const electronExe = process.execPath;

        console.log(`[DesktopHandlers] Launching standalone app: ${displayName}`);
        console.log(`[DesktopHandlers]   Electron: ${electronExe}`);
        console.log(`[DesktopHandlers]   App path: ${appPath}`);

        // 使用 spawn 启动独立的 electron 进程
        const { spawn } = require('child_process');
        const child = spawn(electronExe, [mainJsPath], {
            cwd: appPath,
            detached: true,       // 独立进程，不随父进程退出
            stdio: 'ignore',      // 不继承标准IO
            env: {
                ...process.env,
                // 确保子进程知道项目根目录
                VCP_PROJECT_ROOT: PROJECT_ROOT,
            },
        });

        // 解除父进程对子进程的引用，允许子进程独立运行
        child.unref();

        // 记录进程引用（用于防止重复启动）
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
 * 初始化桌面处理模块
 */
function initialize(params) {
    mainWindow = params.mainWindow;
    openChildWindows = params.openChildWindows;
    appSettingsManager = params.settingsManager;


    // 确保目录存在
    fs.ensureDirSync(DESKTOP_WIDGETS_DIR);
    fs.ensureDirSync(DESKTOP_DATA_DIR);

    // 启动时生成/更新 CATALOG.md
    generateCatalog().catch(err => {
        console.warn('[DesktopHandlers] Initial CATALOG.md generation failed:', err.message);
    });

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

            // 保存成功后异步更新 CATALOG.md（不阻塞返回）
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
     * 保存额外文件到收藏目录（用于 AI 生成的多文件 widget）
     * 允许 AI 将外部 JS/CSS/资源文件保存到 widget 收藏目录中。
     * 参数：{ widgetId, fileName, content, encoding }
     * - widgetId: 收藏 ID（目录名）
     * - fileName: 文件名（如 'app.js', 'style.css'，不允许路径穿越）
     * - content: 文件内容（字符串）
     * - encoding: 编码方式，默认 'utf-8'，也支持 'base64'
     */
    ipcMain.handle('desktop-save-widget-file', async (event, data) => {
        try {
            const { widgetId, fileName, content, encoding } = data;
            if (!widgetId || !fileName || content === undefined) {
                return { success: false, error: '缺少必要参数 (widgetId, fileName, content)' };
            }

            // 安全检查：防止路径穿越
            const safeName = path.basename(fileName);
            if (safeName !== fileName || fileName.includes('..')) {
                return { success: false, error: `不安全的文件名: ${fileName}` };
            }

            // 禁止覆盖核心文件
            const protectedFiles = ['meta.json', 'widget.html', 'thumbnail.png'];
            if (protectedFiles.includes(safeName.toLowerCase())) {
                return { success: false, error: `不允许覆盖核心文件: ${safeName}` };
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
     * 读取收藏目录中的额外文件
     * 参数：{ widgetId, fileName }
     * 返回：{ success, content, encoding }
     */
    ipcMain.handle('desktop-load-widget-file', async (event, data) => {
        try {
            const { widgetId, fileName } = data;
            if (!widgetId || !fileName) {
                return { success: false, error: '缺少必要参数' };
            }

            // 安全检查
            const safeName = path.basename(fileName);
            if (safeName !== fileName || fileName.includes('..')) {
                return { success: false, error: `不安全的文件名: ${fileName}` };
            }

            const filePath = path.join(DESKTOP_WIDGETS_DIR, widgetId, safeName);
            if (!await fs.pathExists(filePath)) {
                return { success: false, error: '文件不存在' };
            }

            // 根据扩展名判断是否为文本文件
            const ext = path.extname(safeName).toLowerCase();
            const textExts = ['.js', '.css', '.html', '.htm', '.json', '.txt', '.md', '.svg', '.xml'];
            if (textExts.includes(ext)) {
                const content = await fs.readFile(filePath, 'utf-8');
                return { success: true, content, encoding: 'utf-8' };
            } else {
                // 二进制文件返回 base64
                const buffer = await fs.readFile(filePath);
                return { success: true, content: buffer.toString('base64'), encoding: 'base64' };
            }
        } catch (err) {
            console.error('[DesktopHandlers] Load widget file error:', err);
            return { success: false, error: err.message };
        }
    });

    /**
     * 列出收藏目录中的所有文件
     * 参数：widgetId
     * 返回：{ success, files: [{ name, size, isText }] }
     */
    ipcMain.handle('desktop-list-widget-files', async (event, widgetId) => {
        try {
            if (!widgetId) {
                return { success: false, error: '缺少 widgetId' };
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

            // 删除成功后异步更新 CATALOG.md（不阻塞返回）
            generateCatalog().catch(err => {
                console.warn('[DesktopHandlers] CATALOG.md update after delete failed:', err.message);
            });

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

    // ============================================================
    // --- IPC: 快捷方式解析 & 启动 ---
    // ============================================================

    /**
     * 解析 Windows .url 快捷方式文件（Internet Shortcut）
     * 支持 Steam 等使用自定义协议的应用（如 steam://rungameid/570）
     * @param {string} filePath - .url 文件路径
     * @returns {object|null} 解析后的快捷方式信息
     */
    /**
     * 带超时的 Promise 包装器
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

            // 提取图标（带超时保护，防止 getFileIcon 挂起）
            let iconDataUrl = '';
            try {
                // 优先从 IconFile 指定的文件提取图标
                if (iconFile && await fs.pathExists(iconFile)) {
                    const nativeImage = await withTimeout(
                        app.getFileIcon(iconFile, { size: 'large' }),
                        3000, // 3秒超时
                        null
                    );
                    if (nativeImage && !nativeImage.isEmpty() && isIconValid(nativeImage)) {
                        iconDataUrl = nativeImage.toDataURL();
                    }
                }
                // 如果没有有效图标，尝试从 .url 文件本身提取
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
                targetPath: url,      // 对 .url 文件，targetPath 存储的是 URL（如 steam://rungameid/570）
                args: '',
                workingDir: '',
                description: url,
                icon: iconDataUrl,
                originalPath: filePath,
                isUrlShortcut: true,   // 标记为 URL 快捷方式，启动时使用 shell.openExternal
            };
        } catch (e) {
            console.warn(`[DesktopHandlers] Failed to parse .url file: ${filePath}`, e.message);
            return null;
        }
    }

    /**
     * 解析 Windows 快捷方式 (.lnk) 文件
     * 返回：{ name, targetPath, args, icon (DataURL), workingDir }
     */
    ipcMain.handle('desktop-shortcut-parse', async (event, filePath) => {
        try {
            if (!filePath) {
                return { success: false, error: '不是有效的快捷方式文件' };
            }

            // 支持 .url 文件
            if (filePath.toLowerCase().endsWith('.url')) {
                const result = await parseUrlShortcut(filePath);
                if (result) {
                    return { success: true, shortcut: result };
                }
                return { success: false, error: '无法解析 .url 快捷方式' };
            }

            if (!filePath.toLowerCase().endsWith('.lnk')) {
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
                // 尝试从 .lnk 文件本身提取图标
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
                    const lowerPath = filePath.toLowerCase();

                    // 支持 .url 文件（Steam 等应用的快捷方式）
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
     * 启动快捷方式目标程序
     */
    ipcMain.handle('desktop-shortcut-launch', async (event, shortcutData) => {
        try {
            const { targetPath, args, workingDir, originalPath, isUrlShortcut } = shortcutData;

            if (!targetPath && !originalPath) {
                return { success: false, error: '缺少目标路径' };
            }

            // URL 快捷方式（如 steam://rungameid/570）：使用 shell.openExternal 打开
            if (isUrlShortcut || (targetPath && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(targetPath))) {
                console.log(`[DesktopHandlers] Launching URL shortcut: ${targetPath}`);
                await shell.openExternal(targetPath);
                return { success: true };
            }

            // 优先使用 shell.openPath 打开原始 .lnk/.url 文件（保留完整的快捷方式配置如管理员权限等）
            if (originalPath && await fs.pathExists(originalPath)) {
                console.log(`[DesktopHandlers] Launching shortcut via original file: ${originalPath}`);
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
                        const lowerFile = file.toLowerCase();
                        const filePath = path.join(desktopPath, file);

                        // 处理 .url 文件（Steam 等应用的快捷方式）
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

                        // 处理 .lnk 文件
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

            console.log(`[DesktopHandlers] Scanned ${shortcuts.length} shortcuts from Windows desktop (including .url)`);
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
            let iconFiles = files.filter(f => /\.(png|jpg|jpeg|svg|ico|webp|gif|html|htm)$/i.test(f));

            // 搜索过滤
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
                // 判断图标类型
                let iconType = 'image'; // 默认为图片（png/jpg/svg/ico/webp）
                if (ext === '.gif') iconType = 'gif';
                else if (ext === '.html' || ext === '.htm') iconType = 'html';
                else if (ext === '.svg') iconType = 'svg';

                return {
                    name: path.basename(f, ext),
                    fileName: f,
                    iconType,
                    // 相对于项目根目录的路径，前端使用 ../assets/iconset/... 访问
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

            const ext = path.extname(fullPath).toLowerCase();

            // HTML 图标：返回 HTML 内容字符串（用于 Shadow DOM 渲染）
            if (ext === '.html' || ext === '.htm') {
                const htmlContent = await fs.readFile(fullPath, 'utf-8');
                return { success: true, dataUrl: null, htmlContent, iconType: 'html' };
            }

            // GIF 图标：返回 Data URL
            if (ext === '.gif') {
                const buffer = await fs.readFile(fullPath);
                const dataUrl = `data:image/gif;base64,${buffer.toString('base64')}`;
                return { success: true, dataUrl, iconType: 'gif' };
            }

            // SVG 图标：返回 Data URL + 原始 SVG 文本（供内联使用）
            if (ext === '.svg') {
                const buffer = await fs.readFile(fullPath);
                const svgContent = buffer.toString('utf-8');
                const dataUrl = `data:image/svg+xml;base64,${buffer.toString('base64')}`;
                return { success: true, dataUrl, svgContent, iconType: 'svg' };
            }

            // 其他图片格式：返回 Data URL
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

    // ============================================================
    // --- IPC: VChat 内部应用启动 ---
    // ============================================================

    /**
     * 根据 appAction 启动对应的 VChat 子应用窗口
     * 这是桌面模块调用系统内部各子应用的统一入口
     *
     * 对于有导出函数的模块（notes, rag, canvas），直接 require 并调用。
     * 对于只有 ipcMain.on 注册的模块（forum, memo, music, themes），
     * 在这里直接实现窗口创建逻辑（与 windowHandlers.js 保持一致的单例管理）。
     */
    ipcMain.handle('desktop-launch-vchat-app', async (event, appAction) => {
        try {
            console.log(`[DesktopHandlers] Launching VChat app: ${appAction}`);

            switch (appAction) {
                case 'show-main-window': {
                    // 尝试找到主窗口（可能通过 initialize 传入，也可能需要从所有窗口中查找）
                    let targetMainWindow = mainWindow;
                    if (!targetMainWindow || targetMainWindow.isDestroyed()) {
                        // 在所有窗口中查找加载了 main.html 的窗口
                        const allWindows = BrowserWindow.getAllWindows();
                        targetMainWindow = allWindows.find(win => {
                            if (win.isDestroyed()) return false;
                            const url = win.webContents.getURL();
                            return url.includes('main.html') && !url.includes('desktop.html');
                        });
                    }
                    if (targetMainWindow && !targetMainWindow.isDestroyed()) {
                        if (!targetMainWindow.isVisible()) targetMainWindow.show();
                        if (targetMainWindow.isMinimized()) targetMainWindow.restore();
                        targetMainWindow.focus();
                    } else {
                        return { success: false, error: '主窗口不可用（可能未启动或已关闭）' };
                    }
                    return { success: true };
                }

                case 'open-notes-window': {
                    const notesHandlers = require('./notesHandlers');
                    notesHandlers.createOrFocusNotesWindow();
                    return { success: true };
                }

                case 'open-memo-window': {
                    // 优先检查是否已有 memo 窗口存在（可能由 windowHandlers 创建）
                    const existingMemo = findWindowByUrl('memo.html');
                    if (existingMemo) {
                        if (!existingMemo.isVisible()) existingMemo.show();
                        existingMemo.focus();
                    } else {
                        vchatMemoWindow = createOrFocusChildWindow(vchatMemoWindow, {
                            width: 1200, height: 800, minWidth: 800, minHeight: 600,
                            title: 'VCP Memo 中心',
                            htmlPath: path.join(app.getAppPath(), 'Memomodules', 'memo.html'),
                        });
                    }
                    return { success: true };
                }

                case 'open-forum-window': {
                    // 优先检查是否已有 forum 窗口存在（可能由 windowHandlers 创建）
                    const existingForum = findWindowByUrl('forum.html');
                    if (existingForum) {
                        if (!existingForum.isVisible()) existingForum.show();
                        existingForum.focus();
                    } else {
                        vchatForumWindow = createOrFocusChildWindow(vchatForumWindow, {
                            width: 1200, height: 800, minWidth: 800, minHeight: 600,
                            title: 'VCP 论坛',
                            htmlPath: path.join(app.getAppPath(), 'Forummodules', 'forum.html'),
                        });
                    }
                    return { success: true };
                }

                case 'open-rag-observer-window': {
                    const ragHandlers = require('./ragHandlers');
                    await ragHandlers.openRagObserverWindow();
                    return { success: true };
                }

                case 'open-dice-window': {
                    // 骰子窗口需要先启动本地 express 服务器，
                    // 通过桌面窗口的渲染进程间接调用 electronAPI.openDiceWindow()
                    // 这会触发已注册的 ipcMain.handle('open-dice-window')
                    if (desktopWindow && !desktopWindow.isDestroyed()) {
                        desktopWindow.webContents.executeJavaScript(`window.electronAPI?.openDiceWindow()`).catch(() => {});
                    } else if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.executeJavaScript(`window.electronAPI?.openDiceWindow()`).catch(() => {});
                    }
                    return { success: true };
                }

                case 'open-canvas-window': {
                    const canvasHandlers = require('./canvasHandlers');
                    await canvasHandlers.createCanvasWindow();
                    return { success: true };
                }

                case 'open-translator-window': {
                    // 读取设置获取 API 凭据
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
                        title: '翻译',
                        htmlPath: path.join(app.getAppPath(), 'Translatormodules', 'translator.html'),
                        queryParams: `vcpServerUrl=${encodeURIComponent(vcpServerUrl)}&vcpApiKey=${encodeURIComponent(vcpApiKey)}`,
                    });
                    return { success: true };
                }

                case 'open-music-window': {
                    // 音乐窗口需要通过已注册的 ipcMain.on('open-music-window') 打开
                    // 通过桌面窗口自身的渲染进程触发（桌面窗口加载了相同的 preload.js）
                    if (desktopWindow && !desktopWindow.isDestroyed()) {
                        desktopWindow.webContents.executeJavaScript(`window.electron?.send('open-music-window')`).catch(() => {});
                    } else if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.executeJavaScript(`window.electron?.send('open-music-window')`).catch(() => {});
                    }
                    return { success: true };
                }

                case 'open-themes-window': {
                    vchatThemesWindow = createOrFocusChildWindow(vchatThemesWindow, {
                        width: 850, height: 700,
                        title: '主题选择',
                        htmlPath: path.join(app.getAppPath(), 'Themesmodules', 'themes.html'),
                    });
                    return { success: true };
                }

                case 'launch-human-toolbox': {
                    return await launchStandaloneElectronApp('VCPHumanToolBox', '人类工具箱');
                }

                case 'launch-vchat-manager': {
                    return await launchStandaloneElectronApp('VchatManager', 'VchatManager');
                }

                default: {
                    // 处理系统工具启动：appAction 格式为 'open-system-tool:命令'
                    if (appAction && appAction.startsWith('open-system-tool:')) {
                        const cmd = appAction.substring('open-system-tool:'.length);
                        return await launchSystemTool(cmd);
                    }
                    console.warn(`[DesktopHandlers] Unknown VChat app action: ${appAction}`);
                    return { success: false, error: `未知的应用动作: ${appAction}` };
                }
            }
        } catch (err) {
            console.error(`[DesktopHandlers] VChat app launch error (${appAction}):`, err);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // --- IPC: 打开 Windows 系统工具 ---
    // ============================================================

    ipcMain.handle('desktop-open-system-tool', async (event, cmd) => {
        return await launchSystemTool(cmd);
    });

    console.log('[DesktopHandlers] Initialized (with favorites, vcpAPI, shortcuts, dock, layout, iconset, wallpaper, vchat-apps & system-tools).');
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

        // 使用 showInactive() 避免抢占主窗口焦点
        desktopWindow.showInactive();

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
    generateCatalog,
};