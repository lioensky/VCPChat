// VCPHumanToolBox/main.js
// 这是一个独立的Electron入口，用于启动人类工具箱。

const { app, BrowserWindow, ipcMain, Menu, dialog, clipboard, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const sharp = require('sharp');

// 导入 ComfyUI IPC 处理器
const { registerComfyUIIpcHandlers } = require('./ComfyUImodules/comfyui-ipc');

let mainWindow = null;

function createWindow() {
    // 创建浏览器窗口。
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        transparent: true,
        frame: false, // 移除原生窗口框架
        hasShadow: false, // 禁用原生窗口阴影，这是实现圆角的关键！
        backgroundColor: '#00000000', // 设置背景色为完全透明，防止伪影
        webPreferences: {
            // 使用 preload 脚本来安全地暴露 API
            preload: path.join(__dirname, 'preload.js'),
            // 保持 nodeIntegration 为 true 以兼容现有代码
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // 加载应用的 index.html
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // 打开开发者工具（可选）
   // mainWindow.webContents.openDevTools();
}

// Electron会在初始化完成并且准备好创建浏览器窗口时调用这个方法
// Electron会在初始化完成并且准备好创建浏览器窗口时调用这个方法
app.whenReady().then(async () => {
    createWindow();
    
    // 注册全局快捷键
    // 注册 F12 快捷键打开开发者工具
    globalShortcut.register('F12', () => {
        if (mainWindow && mainWindow.webContents) {
            if (mainWindow.webContents.isDevToolsOpened()) {
                mainWindow.webContents.closeDevTools();
            } else {
                mainWindow.webContents.openDevTools();
            }
        }
    });

    // 注册 Ctrl+Shift+I 快捷键打开开发者工具
    globalShortcut.register('CommandOrControl+Shift+I', () => {
        if (mainWindow && mainWindow.webContents) {
            if (mainWindow.webContents.isDevToolsOpened()) {
                mainWindow.webContents.closeDevTools();
            } else {
                mainWindow.webContents.openDevTools();
            }
        }
    });
    
    console.log('[Main] Global shortcuts registered: F12, Ctrl+Shift+I');
    
    // 注册 ComfyUI IPC handlers
    try {
        await registerComfyUIIpcHandlers(mainWindow);
        console.log('[Main] ComfyUI IPC handlers registered successfully');
    } catch (error) {
        console.error('[Main] Failed to register ComfyUI IPC handlers:', error);
    }

    // 注册文件系统IPC处理器
    registerFileSystemHandlers();
    console.log('[Main] File system IPC handlers registered successfully');

    app.on('activate', function () {
        // 在macOS上，当单击dock图标并且没有其他窗口打开时，
        // 通常在应用程序中重新创建一个窗口。
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// 当所有窗口都被关闭时退出
// 当所有窗口都被关闭时退出
app.on('window-all-closed', function () {
    // 清理全局快捷键
    globalShortcut.unregisterAll();
    
    // 在macOS上，应用程序及其菜单栏通常会保持活动状态，
    // 直到用户使用 Cmd + Q 显式退出
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers for Context Menu ---

function downloadImage(url, webContents) {
    dialog.showSaveDialog({
        title: 'Save Image As...',
        defaultPath: path.join(app.getPath('downloads'), `image_${Date.now()}.png`),
        filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
        ]
    }).then(result => {
        if (result.canceled || !result.filePath) {
            return;
        }
        const filePath = result.filePath;

        // Handle Data URI
        if (url.startsWith('data:')) {
            const regex = /^data:.+\/(.+);base64,(.*)$/;
            const matches = url.match(regex);
            if (matches) {
                const data = matches[2];
                const buffer = Buffer.from(data, 'base64');
                fs.writeFile(filePath, buffer, (err) => {
                    if (err) console.error('Failed to save data URI image:', err);
                });
            }
        }
        // Handle HTTP/HTTPS URL
        else {
            const protocol = url.startsWith('https') ? https : http;
            const request = protocol.get(url, (response) => {
                if (response.statusCode === 200) {
                    const fileStream = fs.createWriteStream(filePath);
                    response.pipe(fileStream);
                    fileStream.on('finish', () => {
                        fileStream.close();
                    });
                } else {
                     console.error(`Failed to download image. Status code: ${response.statusCode}`);
                }
            });
            request.on('error', (e) => {
                console.error(`Error downloading image: ${e.message}`);
            });
        }
    }).catch(err => {
        console.error(err);
    });
}


function copyImageToClipboard(url) {
    const fetchImage = (imgUrl) => {
        return new Promise((resolve, reject) => {
            const protocol = imgUrl.startsWith('https') ? https : http;
            const request = protocol.get(imgUrl, (response) => {
                if (response.statusCode === 200) {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => resolve(Buffer.concat(chunks)));
                } else {
                    reject(new Error(`Failed to fetch image. Status code: ${response.statusCode}`));
                }
            });
            request.on('error', (e) => reject(e));
        });
    };

    if (url.startsWith('data:')) {
        const image = nativeImage.createFromDataURL(url);
        clipboard.writeImage(image);
    } else {
        fetchImage(url)
            .then(buffer => {
                const image = nativeImage.createFromBuffer(buffer);
                clipboard.writeImage(image);
            })
            .catch(err => console.error('Failed to copy image to clipboard:', err));
    }
}

ipcMain.on('show-image-context-menu', (event, imageUrl) => {
    const template = [
        {
            label: 'Copy Image',
            click: () => copyImageToClipboard(imageUrl)
        },
        {
            label: 'Save Image As...',
            click: () => downloadImage(imageUrl, event.sender)
        }
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

// --- Window Control Handlers ---
ipcMain.on('window-control', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        switch (action) {
            case 'minimize':
                window.minimize();
                break;
            case 'maximize':
                if (window.isMaximized()) {
                    window.unmaximize();
                } else {
                    window.maximize();
                }
                break;
            case 'close':
                window.close();
                break;
        }
    }
});

// --- Wallpaper Processing Handler ---
ipcMain.handle('vcp-ht-process-wallpaper', async (event, imagePath) => {
    try {
        const roundedCorners = Buffer.from(
            '<svg><rect x="0" y="0" width="1200" height="800" rx="12" ry="12"/></svg>'
        );

        const processedImageBuffer = await sharp(imagePath)
            .resize(1200, 800)
            .composite([{
                input: roundedCorners,
                blend: 'dest-in'
            }])
            .png()
            .toBuffer();

        return `data:image/png;base64,${processedImageBuffer.toString('base64')}`;
    } catch (error) {
        console.error('Failed to process wallpaper:', error);
        return null;
    }
});

// --- IPC Handler for proxying tool execution requests ---
ipcMain.handle('vcp-ht-execute-tool-proxy', async (event, { url, apiKey, toolName, userName, args }) => {
    // 动态导入 node-fetch
    const { default: fetch } = await import('node-fetch');

    // 1. 构造请求体
    let requestBody = `<<<[TOOL_REQUEST]>>>\n`;
    requestBody += `maid:「始」${userName}「末」,\n`;
    requestBody += `tool_name:「始」${toolName}「末」,\n`;
    for (const key in args) {
        if (args[key] !== undefined) {
            const value = typeof args[key] === 'boolean' ? String(args[key]) : args[key];
            requestBody += `${key}:「始」${value}「末」,\n`;
        }
    }
    requestBody += `<<<[END_TOOL_REQUEST]>>>`;

    // 2. 发起网络请求
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${apiKey}`
            },
            body: requestBody
        });

        const responseText = await response.text();

        if (!response.ok) {
            try {
                const errorJson = JSON.parse(responseText);
                throw new Error(`HTTP ${response.status}: ${errorJson.error || responseText}`);
            } catch (e) {
                throw new Error(`HTTP ${response.status}: ${responseText}`);
            }
        }
        
        // 3. 返回成功结果
        return {
            success: true,
            data: JSON.parse(responseText)
        };

    } catch (error) {
        console.error(`[Main Process Proxy] Error executing tool '${toolName}':`, error);
        // 4. 返回失败结果
        return {
            success: false,
            error: error.message
        };
    }
});


// --- File System IPC Handlers for Plugin Manager ---
function registerFileSystemHandlers() {
    // 读取目录
    ipcMain.handle('fs-readdir', async (event, dirPath) => {
        try {
            const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
            return items
                .filter(item => item.isDirectory())
                .map(item => item.name);
        } catch (error) {
            console.error('fs-readdir error:', error);
            throw error;
        }
    });

    // 检查文件/目录是否存在
    ipcMain.handle('fs-exists', async (event, filePath) => {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch (error) {
            return false;
        }
    });

    // 读取文件内容
    ipcMain.handle('fs-readfile', async (event, filePath, encoding = 'utf8') => {
        try {
            return await fs.promises.readFile(filePath, encoding);
        } catch (error) {
            console.error('fs-readfile error:', error);
            throw error;
        }
    });

    // 写入文件内容
    ipcMain.handle('fs-writefile', async (event, filePath, data, encoding = 'utf8') => {
        try {
            await fs.promises.writeFile(filePath, data, encoding);
            return true;
        } catch (error) {
            console.error('fs-writefile error:', error);
            throw error;
        }
    });

    // 创建目录
    ipcMain.handle('fs-mkdir', async (event, dirPath, options = { recursive: true }) => {
        try {
            await fs.promises.mkdir(dirPath, options);
            return true;
        } catch (error) {
            console.error('fs-mkdir error:', error);
            throw error;
        }
    });

    // 获取文件/目录状态
    ipcMain.handle('fs-stat', async (event, filePath) => {
        try {
            const stats = await fs.promises.stat(filePath);
            return {
                isFile: stats.isFile(),
                isDirectory: stats.isDirectory(),
                size: stats.size,
                mtime: stats.mtime,
                ctime: stats.ctime
            };
        } catch (error) {
            console.error('fs-stat error:', error);
            throw error;
        }
    });
}
