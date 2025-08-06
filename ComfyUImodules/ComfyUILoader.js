/**
 * ComfyUILoader.js - ComfyUI module loader for preload context
 * 保持单一职责：统一封装 ComfyUI 相关 IPC 调用与事件订阅。
 */
const { ipcRenderer } = require('electron');

// 优先通过 window.electronAPI 调用以遵循白名单
const invoke = (ch, data) => {
    try {
        if (window.electronAPI && typeof window.electronAPI.invoke === 'function') {
            return window.electronAPI.invoke(ch, data);
        }
        // Fallback direct invoke (for legacy environments)
        return ipcRenderer.invoke(ch, data);
    } catch (e) {
        return Promise.reject(e);
    }
};
const onEvent = (ch, cb) => {
    if (window.electronAPI && typeof window.electronAPI.on === 'function') {
        return window.electronAPI.on(ch, cb);
    }
    const listener = (_event, ...args) => cb(...args);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
};

// ComfyUI API wrapper
const comfyUIAPI = {
    // 初始化 ComfyUI 主进程处理器
    ensureHandlersReady: () => invoke('ensure-comfyui-handlers-ready'),

    // 配置管理
    getConfig: () => invoke('comfyui:get-config'),
    saveConfig: (config) => invoke('comfyui:save-config', config),

    // 工作流管理
    getWorkflows: () => invoke('comfyui:get-workflows'),
    readWorkflow: (name) => invoke('comfyui:read-workflow', { name }),
    saveWorkflow: (name, data) => invoke('comfyui:save-workflow', { name, data }),
    deleteWorkflow: (name) => invoke('comfyui:delete-workflow', { name }),

    // 文件监听
    watchConfig: () => invoke('watch-comfyui-config'),
    getConfigRealtime: () => invoke('get-comfyui-config-realtime'),
    onConfigChanged: (callback) => onEvent('comfyui-config-changed', callback),

    // 工作流模板转换
    convertWorkflowToTemplate: (workflowData, templateName) =>
        invoke('convert-workflow-to-template', workflowData, templateName),
    importAndConvertWorkflow: (workflowData, workflowName) =>
        invoke('import-and-convert-workflow', workflowData, workflowName),
    validateWorkflowTemplate: (workflowData) =>
        invoke('validate-workflow-template', workflowData)
};

// Export for use in preload
module.exports = comfyUIAPI;