// gui/preload.js
const { contextBridge, ipcRenderer } = require('electron');

const allowedInvokeChannels = new Set([
  'read-from-clipboard'
]);

// 在 window 对象上暴露一个名为 'electronAPI' 的安全API
contextBridge.exposeInMainWorld('electronAPI', {
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

  /**
   * 封装 ipcRenderer.invoke，用于需要返回值的安全请求。
   * @param {string} channel - 目标IPC通道。
   * @param  {...any} args - 要发送的数据。
   */
  invoke: (channel, ...args) => {
    if (!allowedInvokeChannels.has(channel)) {
      throw new Error(`Unsupported invoke channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  // --- 新增窗口控制API ---
 minimizeWindow: () => ipcRenderer.send('minimize-window'),
 maximizeWindow: () => ipcRenderer.send('maximize-window'),
 closeWindow: () => ipcRenderer.send('close-window')
});