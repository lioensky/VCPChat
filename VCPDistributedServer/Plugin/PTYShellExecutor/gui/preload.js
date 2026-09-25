// gui/preload.js
const { contextBridge, ipcRenderer } = require('electron');

// 在 window 对象上暴露一个名为 'shellAPI' 的安全API
contextBridge.exposeInMainWorld('shellAPI', {
    /**
     * 封装 ipcRenderer.on，安全地将监听器注册到指定通道。
     * @param {string} channel - 要监听的IPC通道。
     * @param {Function} func - 当收到数据时要执行的回调函数。
     */
    on: (channel, func) => {
        // 创建一个安全的包装函数，只传递必要的数据
        const subscription = (event, ...args) => func(...args);
        ipcRenderer.on(channel, subscription);

        // 返回一个取消订阅的函数，以便组件卸载时清理监听器
        return () => {
            ipcRenderer.removeListener(channel, subscription);
        };
    },

    /**
     * 封装 ipcRenderer.send，安全地向主进程发送消息。
     * @param {string} channel - 目标IPC通道。
     * @param  {...any} args - 要发送的数据。
     */
    send: (channel, ...args) => {
        ipcRenderer.send(channel, ...args);
    },

    // --- 终端交互 API ---
    
    /**
     * 发送原始按键输入到 PTY（用于终端直接输入模式）
     * @param {string} data - 原始按键数据
     */
    sendInput: (data) => ipcRenderer.send('shell-input', data),
    
    /**
     * 发送完整命令到 PTY（用于输入框模式，会自动添加换行符）
     * @param {string} command - 完整命令
     */
    sendCommand: (command) => ipcRenderer.send('shell-command', command),
    
    /**
     * 调整终端尺寸
     * @param {number} cols - 列数
     * @param {number} rows - 行数
     */
    resize: (cols, rows) => ipcRenderer.send('shell-resize', { cols, rows }),
    
    /**
     * 复制文本到剪贴板
     * @param {string} text - 要复制的文本
     */
    copyToClipboard: (text) => ipcRenderer.send('copy-to-clipboard', text),
    
    /**
     * 通知主进程 GUI 已就绪
     */
    notifyReady: () => ipcRenderer.send('shell-gui-ready'),

    // --- 窗口控制 API ---
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),

    // --- 事件监听快捷方法 ---
    
    /**
     * 监听来自主进程的终端数据
     * @param {Function} callback - 回调函数
     */
    onData: (callback) => ipcRenderer.on('shell-data', (event, data) => callback(data)),
    
    /**
     * 监听清屏事件
     * @param {Function} callback - 回调函数
     */
    onClear: (callback) => ipcRenderer.on('shell-clear', () => callback()),
    
    /**
     * 监听主进程发布的权威主题状态。
     * @param {Function} callback - 回调函数
     */
    onThemeState: (callback) => ipcRenderer.on('theme-state-updated', (event, data) => callback(data)),
    
    /**
     * 监听 PTY 状态变化
     * @param {Function} callback - 回调函数
     */
    onStatus: (callback) => ipcRenderer.on('pty-status', (event, data) => callback(data))
});

// 获取 node_modules 路径
const args = process.argv;
let nodeModulesPath = '';
for (const arg of args) {
    if (arg.startsWith('--node-modules-path=')) {
        nodeModulesPath = arg.split('=')[1];
        break;
    }
}

contextBridge.exposeInMainWorld('nodeModulesPath', nodeModulesPath);
