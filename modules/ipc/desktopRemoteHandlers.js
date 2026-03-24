/**
 * modules/ipc/desktopRemoteHandlers.js
 * 桌面远程控制处理模块（从 main.js 中独立抽取）
 * 
 * 负责：
 *   - DesktopRemote 插件命令处理（SetWallpaper、QueryDesktop、ViewWidgetSource、CreateWidget）
 *   - Canvas 控制（从分布式服务器触发打开 canvas 窗口）
 *   - Flowlock 控制（从分布式服务器触发心流锁操作）
 * 
 * 这些 handler 主要供 VCPDistributedServer 注入使用，
 * 不直接注册 IPC 监听器，而是作为函数导出给调用方。
 */

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// --- 模块依赖引用 ---
let desktopHandlersRef = null;   // modules/ipc/desktopHandlers
let canvasHandlersRef = null;    // modules/ipc/canvasHandlers
let mainWindowRef = null;        // 主窗口引用

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 初始化模块，注入必要的依赖引用
 * @param {object} params
 * @param {BrowserWindow} params.mainWindow - 主窗口引用
 */
function initialize(params) {
    mainWindowRef = params.mainWindow;
    // 延迟 require 避免循环依赖
    desktopHandlersRef = require('./desktopHandlers');
    canvasHandlersRef = require('./canvasHandlers');
    console.log('[DesktopRemoteHandlers] Initialized.');
}

// ============================================================
// Canvas Control Handler (for Distributed Server)
// ============================================================

/**
 * 处理 canvas 控制指令（分布式服务器调用）
 * @param {string} filePath - 要打开的 canvas 文件路径
 * @returns {Promise<{status: string, message: string}>}
 */
async function handleCanvasControl(filePath) {
    try {
        if (!filePath) {
            throw new Error('No filePath provided for canvas control.');
        }

        if (!canvasHandlersRef) {
            canvasHandlersRef = require('./canvasHandlers');
        }

        // createCanvasWindow 同时处理打开窗口和加载文件
        await canvasHandlersRef.createCanvasWindow(filePath);

        return { status: 'success', message: 'Canvas window command processed.' };
    } catch (error) {
        console.error('[DesktopRemoteHandlers] handleCanvasControl error:', error);
        return { status: 'error', message: error.message };
    }
}

// ============================================================
// Flowlock Control Handler (for Distributed Server)
// ============================================================

/**
 * 处理心流锁控制指令（分布式服务器调用）
 * @param {object} commandPayload - 心流锁命令参数
 * @returns {Promise<{status: string, message: string}>}
 */
async function handleFlowlockControl(commandPayload) {
    try {
        const { command, agentId, topicId, prompt, promptSource, target, oldText, newText } = commandPayload;

        console.log(`[DesktopRemoteHandlers] handleFlowlockControl received command: ${command}`, commandPayload);

        if (!mainWindowRef || mainWindowRef.isDestroyed()) {
            throw new Error('Main window is not available.');
        }

        // 对于 'get' 和 'status' 命令，需要等待渲染进程的响应
        if (command === 'get' || command === 'status') {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    ipcMain.removeListener('flowlock-response', responseHandler);
                    reject(new Error(`${command === 'get' ? '获取输入框内容' : '获取心流锁状态'}超时`));
                }, 5000);

                const responseHandler = (event, responseData) => {
                    clearTimeout(timeout);
                    ipcMain.removeListener('flowlock-response', responseHandler);

                    if (responseData.success) {
                        if (command === 'get') {
                            resolve({
                                status: 'success',
                                message: `输入框当前内容为: "${responseData.content}"`,
                                content: responseData.content
                            });
                        } else if (command === 'status') {
                            const statusInfo = responseData.status;
                            const statusText = statusInfo.isActive
                                ? `心流锁已启用 (Agent: ${statusInfo.agentId}, Topic: ${statusInfo.topicId}, 处理中: ${statusInfo.isProcessing ? '是' : '否'})`
                                : '心流锁未启用';
                            resolve({
                                status: 'success',
                                message: statusText,
                                flowlockStatus: statusInfo
                            });
                        }
                    } else {
                        reject(new Error(responseData.error || `${command === 'get' ? '获取输入框内容' : '获取心流锁状态'}失败`));
                    }
                };

                ipcMain.on('flowlock-response', responseHandler);

                mainWindowRef.webContents.send('flowlock-command', {
                    command, agentId, topicId, prompt, promptSource, target, oldText, newText
                });
            });
        }

        // 对于其他命令，发送后立即返回
        mainWindowRef.webContents.send('flowlock-command', {
            command, agentId, topicId, prompt, promptSource, target, oldText, newText
        });

        // 构建自然语言响应
        let naturalResponse = '';
        switch (command) {
            case 'start':
                naturalResponse = `已为 Agent "${agentId}" 的话题 "${topicId}" 启动心流锁。`;
                break;
            case 'stop':
                naturalResponse = `已停止心流锁。`;
                break;
            case 'promptee':
                naturalResponse = `已设置下次续写提示词为: "${prompt}"`;
                break;
            case 'prompter':
                naturalResponse = `已从来源 "${promptSource}" 获取提示词。`;
                break;
            case 'clear':
                naturalResponse = `已清空输入框中的所有提示词。`;
                break;
            case 'remove':
                naturalResponse = `已从输入框中移除: "${target}"`;
                break;
            case 'edit':
                naturalResponse = `已将 "${oldText}" 编辑为 "${newText}"`;
                break;
            default:
                naturalResponse = `心流锁命令 "${command}" 已执行。`;
        }

        return { status: 'success', message: naturalResponse };
    } catch (error) {
        console.error('[DesktopRemoteHandlers] handleFlowlockControl error:', error);
        return { status: 'error', message: error.message };
    }
}

// ============================================================
// Desktop Remote Control Handler (for Distributed Server)
// ============================================================

/**
 * 处理桌面远程控制指令（DesktopRemote 插件命令）
 * @param {object} commandPayload - 命令参数
 * @returns {Promise<{status: string, result?: object, message?: string}>}
 */
async function handleDesktopRemoteControl(commandPayload) {
    try {
        const { command } = commandPayload;
        console.log(`[DesktopRemoteHandlers] handleDesktopRemoteControl received command: ${command}`, commandPayload);

        if (!desktopHandlersRef) {
            desktopHandlersRef = require('./desktopHandlers');
        }

        const desktopWin = desktopHandlersRef.getDesktopWindow();

        if (command === 'SetWallpaper') {
            return await _handleSetWallpaper(commandPayload, desktopWin);
        } else if (command === 'QueryDesktop') {
            return await _handleQueryDesktop(desktopWin);
        } else if (command === 'QueryDock') {
            return await _handleQueryDock(desktopWin);
        } else if (command === 'ViewWidgetSource') {
            return await _handleViewWidgetSource(commandPayload, desktopWin);
        } else if (command === 'CreateWidget') {
            return await _handleCreateWidget(commandPayload, desktopWin);
        } else {
            throw new Error(`未知的桌面控制命令: ${command}`);
        }
    } catch (error) {
        console.error('[DesktopRemoteHandlers] handleDesktopRemoteControl error:', error);
        return { status: 'error', message: error.message };
    }
}

// ============================================================
// 内部实现：SetWallpaper
// ============================================================

async function _handleSetWallpaper(commandPayload, desktopWin) {
    const { wallpaperSource } = commandPayload;
    if (!wallpaperSource) {
        throw new Error('wallpaperSource parameter is required for SetWallpaper.');
    }

    const trimmedSource = wallpaperSource.trim();
    const isHtmlContent = /^<!DOCTYPE|^<html/i.test(trimmedSource);
    const typeLabels = { image: '🖼️ 图片', video: '🎬 视频', html: '🌐 HTML动态' };

    let wallpaperConfig;

    if (isHtmlContent) {
        // 保存 HTML 内容为文件
        const htmlFileName = `ai_wallpaper_${Date.now()}.html`;
        const htmlFilePath = path.join(PROJECT_ROOT, 'AppData', 'DesktopData', htmlFileName);
        await fs.ensureDir(path.join(PROJECT_ROOT, 'AppData', 'DesktopData'));
        await fs.writeFile(htmlFilePath, wallpaperSource, 'utf-8');
        const fileUrl = `file:///${htmlFilePath.replace(/\\/g, '/')}`;
        wallpaperConfig = {
            enabled: true, type: 'html', source: fileUrl,
            filePath: htmlFilePath, opacity: 1, blur: 0, brightness: 1,
        };
        console.log(`[DesktopRemoteHandlers] HTML wallpaper saved to: ${htmlFilePath}`);
    } else if (trimmedSource.startsWith('http://') || trimmedSource.startsWith('https://')) {
        const urlPath = new URL(trimmedSource).pathname;
        const ext = path.extname(urlPath).toLowerCase().replace('.', '');
        const videoExts = ['mp4', 'webm'];
        const htmlExts = ['html', 'htm'];
        let type = 'image';
        if (videoExts.includes(ext)) type = 'video';
        else if (htmlExts.includes(ext)) type = 'html';

        wallpaperConfig = {
            enabled: true, type, source: trimmedSource,
            filePath: trimmedSource, opacity: 1, blur: 0, brightness: 1,
        };
    } else if (trimmedSource.startsWith('file://')) {
        const localPath = trimmedSource.replace(/^file:\/\/\/?/, '');
        const ext = path.extname(localPath).toLowerCase().replace('.', '');
        const videoExts = ['mp4', 'webm'];
        const htmlExts = ['html', 'htm'];
        let type = 'image';
        if (videoExts.includes(ext)) type = 'video';
        else if (htmlExts.includes(ext)) type = 'html';

        wallpaperConfig = {
            enabled: true, type, source: trimmedSource,
            filePath: localPath, opacity: 1, blur: 0, brightness: 1,
        };
    } else {
        throw new Error('wallpaperSource must be an HTTP/HTTPS URL, a file:// URL, or HTML content starting with <!DOCTYPE or <html>.');
    }

    const typeLabel = typeLabels[wallpaperConfig.type] || wallpaperConfig.type;
    let resultMessage;

    if (desktopWin && !desktopWin.isDestroyed()) {
        desktopWin.webContents.send('desktop-remote-set-wallpaper', wallpaperConfig);
        resultMessage = `壁纸已成功推送到桌面。`;
    } else {
        await desktopHandlersRef.openDesktopWindow();
        const newDesktopWin = desktopHandlersRef.getDesktopWindow();
        if (newDesktopWin && !newDesktopWin.isDestroyed()) {
            setTimeout(() => {
                newDesktopWin.webContents.send('desktop-remote-set-wallpaper', wallpaperConfig);
            }, 2000);
            resultMessage = `桌面窗口已自动打开，壁纸已推送。`;
        } else {
            throw new Error('无法打开桌面窗口来设置壁纸。');
        }
    }

    const mdReport = `### 壁纸推送成功\n\n` +
        `- **类型**: ${typeLabel}\n` +
        `- **来源**: \`${wallpaperConfig.filePath || wallpaperConfig.source}\`\n` +
        `- **状态**: ${resultMessage}`;

    return {
        status: 'success',
        result: { content: [{ type: 'text', text: mdReport }] }
    };
}

// ============================================================
// 内部实现：QueryDesktop
// ============================================================

async function _handleQueryDesktop(desktopWin) {
    if (!desktopWin || desktopWin.isDestroyed()) {
        const mdReport = `### 桌面状态报告\n\n` +
            `**桌面窗口状态**: ❌ 未打开\n\n` +
            `桌面画布窗口当前未启动，无法查询挂件和图标信息。`;
        return {
            status: 'success',
            result: { content: [{ type: 'text', text: mdReport }] }
        };
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ipcMain.removeListener('desktop-remote-query-response', responseHandler);
            reject(new Error('查询桌面状态超时。'));
        }, 5000);

        const responseHandler = (event, responseData) => {
            clearTimeout(timeout);
            ipcMain.removeListener('desktop-remote-query-response', responseHandler);

            if (responseData.success) {
                const widgets = responseData.widgets || [];
                const icons = responseData.icons || [];

                let mdReport = `### 桌面状态报告\n\n**桌面窗口状态**: ✅ 已打开\n\n`;

                mdReport += `#### 活跃挂件 (${widgets.length}个)\n\n`;
                if (widgets.length === 0) {
                    mdReport += `*桌面上没有活跃的挂件。*\n\n`;
                } else {
                    mdReport += `| 挂件ID | 收藏状态 | 收藏名 | 持久化目录 |\n|---|---|---|---|\n`;
                    for (const w of widgets) {
                        if (w.savedName) {
                            mdReport += `| \`${w.id}\` | ⭐ 已收藏 | ${w.savedName} | \`${w.savedDir}\` |\n`;
                        } else {
                            mdReport += `| \`${w.id}\` | 未收藏 | - | - |\n`;
                        }
                    }
                    mdReport += `\n`;
                }

                mdReport += `#### 桌面图标 (${icons.length}个)\n\n`;
                if (icons.length === 0) {
                    mdReport += `*桌面上没有快捷方式图标。*\n`;
                } else {
                    for (const iconName of icons) {
                        mdReport += `- ${iconName}\n`;
                    }
                }

                resolve({
                    status: 'success',
                    result: { content: [{ type: 'text', text: mdReport }] }
                });
            } else {
                reject(new Error(responseData.error || '查询桌面状态失败。'));
            }
        };

        ipcMain.on('desktop-remote-query-response', responseHandler);
        desktopWin.webContents.send('desktop-remote-query');
    });
}

// ============================================================
// 内部实现：QueryDock
// ============================================================

async function _handleQueryDock(desktopWin) {
    if (!desktopWin || desktopWin.isDestroyed()) {
        const mdReport = `### Dock 应用列表报告\n\n` +
            `**桌面窗口状态**: ❌ 未打开\n\n` +
            `桌面画布窗口当前未启动，无法查询 Dock 应用列表。`;
        return {
            status: 'success',
            result: { content: [{ type: 'text', text: mdReport }] }
        };
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ipcMain.removeListener('desktop-remote-query-dock-response', responseHandler);
            reject(new Error('查询 Dock 应用列表超时。'));
        }, 5000);

        const responseHandler = (event, responseData) => {
            clearTimeout(timeout);
            ipcMain.removeListener('desktop-remote-query-dock-response', responseHandler);

            if (responseData.success) {
                const dockItems = responseData.dockItems || [];
                const vchatApps = responseData.vchatApps || [];
                const systemTools = responseData.systemTools || [];
                const builtinWidgets = responseData.builtinWidgets || [];

                let mdReport = `### Dock 应用列表报告\n\n**桌面窗口状态**: ✅ 已打开\n\n`;

                // Dock 中的用户快捷方式
                mdReport += `#### Dock 快捷方式 (${dockItems.length}个)\n\n`;
                if (dockItems.length === 0) {
                    mdReport += `*Dock 中没有用户添加的快捷方式。*\n\n`;
                } else {
                    mdReport += `| 名称 | 类型 | 可见 | 启动方式 |\n|---|---|---|---|\n`;
                    for (const item of dockItems) {
                        const visible = item.visible !== false ? '✅' : '❌';
                        let launchMethod = '';
                        if (item.type === 'vchat-app') {
                            launchMethod = `\`dock.launch({type:'vchat-app', appAction:'${item.appAction}'})\``;
                        } else if (item.type === 'builtin') {
                            launchMethod = `\`dock.launch({type:'builtin', builtinId:'${item.builtinId}'})\``;
                        } else {
                            launchMethod = `\`dock.launch({type:'shortcut', targetPath:'${item.targetPath}'})\``;
                        }
                        mdReport += `| ${item.name} | ${item.type || 'shortcut'} | ${visible} | ${launchMethod} |\n`;
                    }
                    mdReport += `\n`;
                }

                // VChat 内部应用（硬编码，始终可用）
                mdReport += `#### VChat 内部应用 (${vchatApps.length}个，始终可用)\n\n`;
                mdReport += `| 名称 | emoji | appAction | 启动代码 |\n|---|---|---|---|\n`;
                for (const app of vchatApps) {
                    mdReport += `| ${app.name} | ${app.emoji || '-'} | \`${app.appAction}\` | \`dock.launch({type:'vchat-app', appAction:'${app.appAction}'})\` |\n`;
                }
                mdReport += `\n`;

                // 系统工具
                mdReport += `#### Windows 系统工具 (${systemTools.length}个，始终可用)\n\n`;
                mdReport += `| 名称 | emoji | appAction | 启动代码 |\n|---|---|---|---|\n`;
                for (const tool of systemTools) {
                    mdReport += `| ${tool.name} | ${tool.emoji || '-'} | \`${tool.appAction}\` | \`dock.launch({type:'vchat-app', appAction:'${tool.appAction}'})\` |\n`;
                }
                mdReport += `\n`;

                // 内置挂件
                mdReport += `#### 内置桌面挂件 (${builtinWidgets.length}个)\n\n`;
                mdReport += `| 名称 | builtinId | 启动代码 |\n|---|---|---|\n`;
                for (const w of builtinWidgets) {
                    mdReport += `| ${w.name} | \`${w.builtinId}\` | \`dock.launch({type:'builtin', builtinId:'${w.builtinId}'})\` |\n`;
                }
                mdReport += `\n`;

                mdReport += `---\n**提示**: 在 Widget 脚本中，所有启动操作都通过 \`window.VCPDesktop.dock.launch(item)\` 调用。`;

                resolve({
                    status: 'success',
                    result: { content: [{ type: 'text', text: mdReport }] }
                });
            } else {
                reject(new Error(responseData.error || '查询 Dock 应用列表失败。'));
            }
        };

        ipcMain.on('desktop-remote-query-dock-response', responseHandler);
        desktopWin.webContents.send('desktop-remote-query-dock');
    });
}

// ============================================================
// 内部实现：ViewWidgetSource
// ============================================================

async function _handleViewWidgetSource(commandPayload, desktopWin) {
    const { widgetId } = commandPayload;
    if (!widgetId) {
        throw new Error('widgetId parameter is required for ViewWidgetSource.');
    }

    if (!desktopWin || desktopWin.isDestroyed()) {
        throw new Error('桌面窗口未打开，无法查看挂件源码。');
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ipcMain.removeListener('desktop-remote-view-source-response', responseHandler);
            reject(new Error('查看挂件源码超时。'));
        }, 5000);

        const responseHandler = (event, responseData) => {
            if (responseData.widgetId !== widgetId) return;

            clearTimeout(timeout);
            ipcMain.removeListener('desktop-remote-view-source-response', responseHandler);

            if (responseData.success) {
                const htmlSource = responseData.html || '';
                const savedName = responseData.savedName || null;
                const savedId = responseData.savedId || null;

                let mdReport = `### 挂件源码: \`${widgetId}\`\n\n`;
                if (savedName) {
                    mdReport += `- **收藏名**: ${savedName}\n`;
                    mdReport += `- **收藏ID**: \`${savedId}\`\n\n`;
                }
                mdReport += `**HTML内容** (${htmlSource.length} 字符):\n\n\`\`\`html\n${htmlSource}\n\`\`\``;

                resolve({
                    status: 'success',
                    result: {
                        content: [{ type: 'text', text: mdReport }]
                    }
                });
            } else {
                reject(new Error(responseData.error || '查看挂件源码失败。'));
            }
        };

        ipcMain.on('desktop-remote-view-source-response', responseHandler);
        desktopWin.webContents.send('desktop-remote-view-source', { widgetId });
    });
}

// ============================================================
// 内部实现：CreateWidget（新增指令）
// ============================================================

/**
 * 远程创建桌面 Widget
 *
 * 支持参数：
 *   - htmlContent (必需): Widget 的 HTML 内容
 *   - x (可选): 初始 X 坐标，默认 100
 *   - y (可选): 初始 Y 坐标，默认 100
 *   - width (可选): 初始宽度，默认 320
 *   - height (可选): 初始高度，默认 200
 *   - widgetId (可选): 自定义 widget ID，默认自动生成
 *   - autoSave (可选): 是否自动收藏，默认 false
 *   - saveName (可选): 收藏名称（当 autoSave 为 true 时使用）
 *   - scriptCode (可选): 外部 JS 源码字符串，自动保存为 app.js
 */
async function _handleCreateWidget(commandPayload, desktopWin) {
    const { htmlContent, x, y, width, height, widgetId, autoSave, saveName, scriptCode } = commandPayload;

    if (!htmlContent) {
        throw new Error('htmlContent parameter is required for CreateWidget.');
    }

    // 确保桌面窗口已打开
    let targetWin = desktopWin;
    if (!targetWin || targetWin.isDestroyed()) {
        await desktopHandlersRef.openDesktopWindow();
        targetWin = desktopHandlersRef.getDesktopWindow();
        if (!targetWin || targetWin.isDestroyed()) {
            throw new Error('无法打开桌面窗口来创建挂件。');
        }
        // 等待窗口就绪
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 生成 widget ID
    const finalWidgetId = widgetId || `remote-widget-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // 构建选项
    const options = {};
    if (typeof x === 'number') options.x = x;
    if (typeof y === 'number') options.y = y;
    if (typeof width === 'number') options.width = width;
    if (typeof height === 'number') options.height = height;

    // 如果有 scriptCode，需要先保存为 app.js，再将文件路径信息传递给渲染进程
    let savedId = null;
    let finalHtmlContent = htmlContent;
    const hasScriptCode = typeof scriptCode === 'string' && scriptCode.trim().length > 0;

    if (hasScriptCode) {
        // 强制 autoSave，生成 savedId
        savedId = `saved-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const widgetDir = path.join(PROJECT_ROOT, 'AppData', 'DesktopWidgets', savedId);
        await fs.ensureDir(widgetDir);

        // 保存 JS 代码为 app.js
        const appJsPath = path.join(widgetDir, 'app.js');
        await fs.writeFile(appJsPath, scriptCode, 'utf-8');
        console.log(`[DesktopRemoteHandlers] Script file saved: ${savedId}/app.js`);

        // 保存 widget.html
        await fs.writeFile(path.join(widgetDir, 'widget.html'), htmlContent, 'utf-8');

        // 保存 meta.json
        const meta = {
            id: savedId,
            name: saveName || 'AI Widget',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await fs.writeJson(path.join(widgetDir, 'meta.json'), meta, { spaces: 2 });

        console.log(`[DesktopRemoteHandlers] Widget pre-saved with app.js: ${savedId}`);

        // 构建 file:// URL，将 HTML 中 <script src="app.js"> 替换为绝对路径
        const widgetDirUrl = `file:///${widgetDir.replace(/\\/g, '/')}`;
        const appJsUrl = `${widgetDirUrl}/app.js`;

        // 替换 <script src="app.js"> 为绝对路径
        finalHtmlContent = finalHtmlContent.replace(
            /(<script[^>]*\ssrc\s*=\s*)(["'])app\.js\2/gi,
            `$1$2${appJsUrl}$2`
        );
        // 也处理无引号的情况
        finalHtmlContent = finalHtmlContent.replace(
            /(<script[^>]*\ssrc\s*=\s*)app\.js(\s|>)/gi,
            `$1"${appJsUrl}"$2`
        );

        // 如果 HTML 中没有 <script src="app.js">，自动追加一个
        if (!htmlContent.match(/<script[^>]*\ssrc\s*=\s*["']?app\.js/i)) {
            // 在 </body> 或末尾追加
            if (finalHtmlContent.includes('</body>')) {
                finalHtmlContent = finalHtmlContent.replace('</body>', `<script src="${appJsUrl}"></script>\n</body>`);
            } else {
                finalHtmlContent += `\n<script src="${appJsUrl}"></script>`;
            }
            console.log(`[DesktopRemoteHandlers] Auto-appended <script src="app.js"> to HTML`);
        }
    }

    // 通过 IPC 向桌面窗口发送创建指令
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ipcMain.removeListener('desktop-remote-create-widget-response', responseHandler);
            let timeoutReport = `### 挂件创建完成\n\n` +
                `- **挂件ID**: \`${finalWidgetId}\`\n` +
                `- **位置**: (${options.x || 100}, ${options.y || 100})\n` +
                `- **尺寸**: ${options.width || 320} × ${options.height || 200}\n` +
                `- **状态**: 已推送到桌面（响应超时，可能已创建成功）`;
            if (hasScriptCode) {
                timeoutReport += `\n- **外部脚本**: \`app.js\` 已保存`;
            }
            resolve({
                status: 'success',
                result: {
                    content: [{
                        type: 'text',
                        text: timeoutReport
                    }]
                }
            });
        }, 8000);

        const responseHandler = (event, responseData) => {
            // 增加 ID 匹配检查，确保并发请求时响应正确对应
            if (responseData.widgetId !== finalWidgetId) return;

            clearTimeout(timeout);
            ipcMain.removeListener('desktop-remote-create-widget-response', responseHandler);

            if (responseData.success) {
                let mdReport = `### 挂件创建成功 ✅\n\n` +
                    `- **挂件ID**: \`${finalWidgetId}\`\n` +
                    `- **位置**: (${options.x || 100}, ${options.y || 100})\n` +
                    `- **尺寸**: ${options.width || 320} × ${options.height || 200}\n`;

                const finalSavedId = savedId || responseData.savedId;
                const finalSavedName = saveName || responseData.savedName;

                if (finalSavedId) {
                    mdReport += `- **收藏状态**: ⭐ 已自动收藏为 "${finalSavedName}"\n`;
                    mdReport += `- **持久化目录**: \`AppData/DesktopWidgets/${finalSavedId}\`\n`;
                }

                if (hasScriptCode) {
                    mdReport += `- **外部脚本**: \`app.js\`\n`;
                }

                mdReport += `\n*挂件已成功创建并渲染在桌面画布上。*`;

                resolve({
                    status: 'success',
                    result: {
                        content: [{ type: 'text', text: mdReport }]
                    }
                });
            } else {
                reject(new Error(responseData.error || '创建挂件失败。'));
            }
        };

        ipcMain.on('desktop-remote-create-widget-response', responseHandler);

        // 发送创建指令到桌面渲染进程
        targetWin.webContents.send('desktop-remote-create-widget', {
            widgetId: finalWidgetId,
            htmlContent: finalHtmlContent,
            options,
            autoSave: hasScriptCode ? true : !!autoSave,
            saveName: saveName || (hasScriptCode ? 'AI Widget' : null),
            preSavedId: savedId || null,
        });
    });
}

// ============================================================
// 导出
// ============================================================

module.exports = {
    initialize,
    handleDesktopRemoteControl,
    handleCanvasControl,
    handleFlowlockControl,
};