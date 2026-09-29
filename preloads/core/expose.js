'use strict';

/**
 * 按窗口角色把 preloads/api/*.js 的条目暴露到页面。
 *
 * 每个角色入口（chat.js / utility.js / desktop.js）只调用一次 exposeRole(role)。
 * 页面上会出现三个全局对象：
 *   electronPath           路径辅助（dirname / extname / basename，由主进程计算）
 *   chatAPI / utilityAPI / desktopAPI
 *                          只包含该角色可见的 API
 *   electronAPI            兼容旧代码的全量对象：可见 API 是真实函数，
 *                          其余 API 是隔离桩，调用时打印 "权限已隔离: 名称"，
 *                          query 返回 rejected Promise，subscription 返回空的取消函数
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { ROLE_GLOBALS, loadRegistry } = require('./registry');

function createIsolationStub(name, kind) {
    const message = `权限已隔离: ${name}`;
    if (kind === 'subscription') {
        return () => {
            console.error(message);
            return () => {};
        };
    }
    if (kind === 'query') {
        return () => {
            console.error(message);
            return Promise.reject(new Error(message));
        };
    }
    return () => {
        console.error(message);
    };
}

// 内嵌到主窗口 WebContentsView 中的应用页面，URL 带 ?vcpEmbedded=1
function detectEmbeddedSurface() {
    try {
        return new URLSearchParams(globalThis.location?.search || '').get('vcpEmbedded') === '1';
    } catch {
        return false;
    }
}

function createContext(role) {
    return {
        role,
        ipcRenderer,
        webUtils,
        isEmbeddedSurface: detectEmbeddedSurface(),
    };
}

const pathApi = Object.freeze({
    dirname: (filePath) => ipcRenderer.invoke('path:dirname', filePath),
    extname: (filePath) => ipcRenderer.invoke('path:extname', filePath),
    basename: (filePath) => ipcRenderer.invoke('path:basename', filePath),
});

/**
 * @param {'chat' | 'utility' | 'desktop'} role
 * @returns {{ ctx: object, roleApi: object }} 供角色入口里的 behaviors 复用
 */
function exposeRole(role) {
    const globalName = ROLE_GLOBALS[role];
    if (!globalName) {
        throw new TypeError(`未知 preload 角色: ${role}`);
    }

    const ctx = createContext(role);
    const roleApi = {};
    const compatApi = {};

    for (const [name, { entry, roles }] of loadRegistry()) {
        if (roles.includes(role)) {
            const fn = entry.build(ctx);
            roleApi[name] = fn;
            compatApi[name] = fn;
        } else {
            compatApi[name] = createIsolationStub(name, entry.kind);
        }
    }

    contextBridge.exposeInMainWorld('electronPath', pathApi);
    contextBridge.exposeInMainWorld(globalName, roleApi);
    contextBridge.exposeInMainWorld('electronAPI', compatApi);

    return { ctx, roleApi };
}

module.exports = {
    exposeRole,
};