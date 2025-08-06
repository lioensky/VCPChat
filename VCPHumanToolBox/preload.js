// ComfyUI Preload Script
const { contextBridge, ipcRenderer } = require('electron');

// 暴露 ComfyUI API 到渲染进程
contextBridge.exposeInMainWorld('comfyuiAPI', {
    // 配置管理
    getConfig: () => ipcRenderer.invoke('comfyui:get-config'),
    saveConfig: (config) => ipcRenderer.invoke('comfyui:save-config', config),
    
    // 工作流管理
    getWorkflows: () => ipcRenderer.invoke('comfyui:get-workflows'),
    readWorkflow: (name) => ipcRenderer.invoke('comfyui:read-workflow', { name }),
    saveWorkflow: (name, data) => ipcRenderer.invoke('comfyui:save-workflow', { name, data }),
    deleteWorkflow: (name) => ipcRenderer.invoke('comfyui:delete-workflow', { name }),
    
    // 路径查询
    getPluginPath: () => ipcRenderer.invoke('comfyui:get-plugin-path'),
    
    // 事件监听（如果后续需要添加文件监听功能）
    on: (channel, callback) => {
        const validChannels = ['comfyui:config-changed', 'comfyui:workflows-changed'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => callback(...args));
        }
    },
    
    // 移除事件监听
    removeAllListeners: (channel) => {
        const validChannels = ['comfyui:config-changed', 'comfyui:workflows-changed'];
        if (validChannels.includes(channel)) {
            ipcRenderer.removeAllListeners(channel);
        }
    }
});

// 暴露通用的 electronAPI（保持与现有代码兼容）
contextBridge.exposeInMainWorld('electronAPI', {
    invoke: (channel, ...args) => {
        // 允许的通道列表
        const allowedChannels = [
            'comfyui:get-config',
            'comfyui:save-config',
            'comfyui:get-workflows',
            'comfyui:read-workflow',
            'comfyui:save-workflow',
            'comfyui:delete-workflow',
            'comfyui:get-plugin-path'
        ];
        
        if (allowedChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, ...args);
        }
        
        console.warn(`[Preload] Blocked invoke on unauthorized channel: ${channel}`);
        return Promise.reject(new Error('Unauthorized channel'));
    },
    
    on: (channel, callback) => {
        const allowedChannels = ['comfyui:config-changed', 'comfyui:workflows-changed'];
        if (allowedChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => callback(...args));
        } else {
            console.warn(`[Preload] Blocked listener on unauthorized channel: ${channel}`);
        }
    },
    
    removeAllListeners: (channel) => {
        const allowedChannels = ['comfyui:config-changed', 'comfyui:workflows-changed'];
        if (allowedChannels.includes(channel)) {
            ipcRenderer.removeAllListeners(channel);
        }
    }
});

console.log('[Preload] ComfyUI preload script loaded');