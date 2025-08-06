// VCPHumanToolBox/main.js
// 这是一个独立的Electron入口，用于启动人类工具箱。

const { app, BrowserWindow, ipcMain, Menu, dialog, clipboard, nativeImage } = require('electron');
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
app.whenReady().then(async () => {
    createWindow();
    
    // 注册 ComfyUI IPC handlers
    try {
        await registerComfyUIIpcHandlers(mainWindow);
        console.log('[Main] ComfyUI IPC handlers registered successfully');
    } catch (error) {
        console.error('[Main] Failed to register ComfyUI IPC handlers:', error);
    }

    app.on('activate', function () {
        // 在macOS上，当单击dock图标并且没有其他窗口打开时，
        // 通常在应用程序中重新创建一个窗口。
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// 当所有窗口都被关闭时退出
app.on('window-all-closed', function () {
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
