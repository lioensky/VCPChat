// modules/ipc/workspaceHandlers.js
// 工作区管理：settings.workspaces 是唯一持久化来源，WorkspaceIndex 是内存投影。
// 所有增删改都走 settingsManager.updateSettings（带锁、原子写），
// 写入后通过 settings-updated 事件重新 configure 索引。
'use strict';

const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const fileManager = require('../fileManager');
const { WorkspaceIndex, normalizeWorkspaceList, sanitizeAlias } = require('../services/workspaceIndex');
const {
    normalizePromptSettings,
    expandWorkspacePlaceholders,
} = require('../services/workspacePromptPlaceholders');

const CHANNELS = [
    'workspaces:list',
    'workspaces:set-active',
    'workspaces:search',
    'workspaces:rebuild',
    'workspaces:add',
    'workspaces:remove',
    'workspaces:update',
    'workspaces:select-directory',
    'workspaces:expand-placeholders',
    'workspaces:get-prompt-settings',
    'workspaces:set-prompt-settings',
];

let workspaceIndex = null;
let settingsManagerRef = null;
// 全局"当前工作区"：只影响 @ 提及的默认搜索范围，不与 Agent / 话题绑定。
let activeWorkspaceId = null;
// {{VCPChatWorkSpace}} 系统提示占位符的行为设置（settings.workspacePromptSettings）。
let promptSettings = normalizePromptSettings(null);
let settingsListener = null;
let externalSettingsListener = null;

function getWorkspaceIndex() {
    return workspaceIndex;
}

/** 绝对路径 → 工作区归属；不在任何启用工作区内返回 null。 */
function resolveWorkspaceFile(absolutePath) {
    return workspaceIndex ? workspaceIndex.resolveFile(absolutePath) : null;
}

function applySettings(settings) {
    if (!workspaceIndex) return;
    workspaceIndex.configure(Array.isArray(settings?.workspaces) ? settings.workspaces : []);
    activeWorkspaceId = typeof settings?.activeWorkspaceId === 'string' ? settings.activeWorkspaceId : null;
    promptSettings = normalizePromptSettings(settings?.workspacePromptSettings);
}

function getPromptSettings() {
    return { ...promptSettings };
}

/** 展开文本中的 {{VCPChatWorkSpace}} / {{VCPChatWorkSpace:文件夹名}}；无占位符时原样返回。 */
function expandPlaceholders(text) {
    return expandWorkspacePlaceholders(text, {
        index: workspaceIndex,
        activeWorkspaceId: getActiveWorkspaceId(),
        settings: promptSettings,
    });
}

/** 当前工作区 id；已被移除或停用时视为未选择（全部工作区）。 */
function getActiveWorkspaceId() {
    if (!activeWorkspaceId || !workspaceIndex) return null;
    return workspaceIndex.list().some(ws => ws.id === activeWorkspaceId && ws.enabled) ? activeWorkspaceId : null;
}

function snapshot() {
    return { workspaces: workspaceIndex.list(), activeWorkspaceId: getActiveWorkspaceId() };
}

async function mutateWorkspaces(mutator) {
    if (!settingsManagerRef) throw new Error('SettingsManager 未初始化。');
    const result = await settingsManagerRef.updateSettings(current => {
        const list = normalizeWorkspaceList(current.workspaces);
        const next = normalizeWorkspaceList(mutator(list));
        // 当前工作区被移除时一并清空，避免悬空 id。
        const active = next.some(item => item.id === current.activeWorkspaceId) ? current.activeWorkspaceId : null;
        return { ...current, workspaces: next, activeWorkspaceId: active };
    });
    // writeSettings 会 emit settings-updated；这里再同步一次，保证返回值即最新状态。
    applySettings(result?.settings);
    return workspaceIndex.list();
}

function initialize({ settingsManager, logger = console } = {}) {
    settingsManagerRef = settingsManager;
    workspaceIndex?.dispose();
    workspaceIndex = new WorkspaceIndex({ logger });
    fileManager.setWorkspaceReferenceResolver(ref => workspaceIndex?.resolveReference(ref) || null);

    if (settingsManager) {
        if (settingsListener) settingsManager.off?.('settings-updated', settingsListener);
        if (externalSettingsListener) settingsManager.off?.('settings-external-updated', externalSettingsListener);
        settingsListener = settings => applySettings(settings);
        externalSettingsListener = payload => applySettings(payload?.settings);
        settingsManager.on?.('settings-updated', settingsListener);
        settingsManager.on?.('settings-external-updated', externalSettingsListener);
        settingsManager.readSettings()
            .then(applySettings)
            .catch(error => logger.warn?.('[Workspaces] Failed to read settings:', error.message));
    }

    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));

    ipcMain.handle('workspaces:list', () => ({ success: true, ...snapshot() }));

    ipcMain.handle('workspaces:set-active', async (_event, workspaceId = null) => {
        try {
            const target = typeof workspaceId === 'string' && workspaceId ? workspaceId : null;
            if (target && !workspaceIndex.list().some(ws => ws.id === target && ws.enabled)) {
                return { success: false, error: '该工作区不存在或已停用。', ...snapshot() };
            }
            const result = await settingsManagerRef.updateSettings(current => ({ ...current, activeWorkspaceId: target }));
            applySettings(result?.settings);
            return { success: true, ...snapshot() };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspaces:search', async (_event, query, options = {}) => {
        try {
            const results = await workspaceIndex.search(typeof query === 'string' ? query : '', {
                alias: typeof options?.alias === 'string' ? options.alias : null,
                limit: Math.min(200, Math.max(1, Number(options?.limit) || 50)),
            });
            return { success: true, results };
        } catch (error) {
            return { success: false, error: error.message, results: [] };
        }
    });

    ipcMain.handle('workspaces:rebuild', async (_event, workspaceId = null) => {
        try {
            return { success: true, workspaces: await workspaceIndex.rebuild(workspaceId || null) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspaces:add', async (_event, rawPath, alias = '') => {
        try {
            if (typeof rawPath !== 'string' || !rawPath.trim()) {
                return { success: false, error: '请提供工作区目录路径。' };
            }
            const resolved = path.resolve(rawPath.trim());
            const stat = await fs.stat(resolved).catch(() => null);
            if (!stat?.isDirectory()) return { success: false, error: `目录不存在: ${resolved}` };
            if (path.parse(resolved).root === resolved) {
                return { success: false, error: '不能把整个磁盘根目录登记为工作区。' };
            }
            const workspaces = await mutateWorkspaces(list => [
                ...list,
                { path: resolved, alias: sanitizeAlias(alias) || undefined },
            ]);
            return { success: true, workspaces };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspaces:remove', async (_event, workspaceId) => {
        try {
            const workspaces = await mutateWorkspaces(list => list.filter(item => item.id !== workspaceId));
            return { success: true, workspaces };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspaces:update', async (_event, workspaceId, patch = {}) => {
        try {
            let conflict = null;
            const workspaces = await mutateWorkspaces(list => list.map(item => {
                if (item.id !== workspaceId) return item;
                const next = { ...item };
                if (typeof patch.alias === 'string') {
                    const alias = sanitizeAlias(patch.alias);
                    if (!alias) {
                        conflict = '别名不能为空。';
                    } else if (list.some(other => other.id !== workspaceId && other.alias === alias)) {
                        conflict = `别名 "${alias}" 已被其他工作区使用。`;
                    } else {
                        next.alias = alias;
                    }
                }
                if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
                return next;
            }));
            return conflict ? { success: false, error: conflict, workspaces } : { success: true, workspaces };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspaces:expand-placeholders', async (_event, text) => {
        try {
            if (typeof text !== 'string') return { success: false, error: '文本必须是字符串。' };
            return { success: true, text: await expandPlaceholders(text) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspaces:get-prompt-settings', () => ({ success: true, settings: getPromptSettings() }));

    ipcMain.handle('workspaces:set-prompt-settings', async (_event, patch = {}) => {
        try {
            if (!settingsManagerRef) throw new Error('SettingsManager 未初始化。');
            const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
            const result = await settingsManagerRef.updateSettings(current => ({
                ...current,
                workspacePromptSettings: normalizePromptSettings({
                    ...normalizePromptSettings(current.workspacePromptSettings),
                    ...source,
                }),
            }));
            applySettings(result?.settings);
            return { success: true, settings: getPromptSettings() };
        } catch (error) {
            return { success: false, error: error.message, settings: getPromptSettings() };
        }
    });

    ipcMain.handle('workspaces:select-directory', async event => {
        const owner = BrowserWindow.fromWebContents(event.sender) || undefined;
        const result = await dialog.showOpenDialog(owner, {
            title: '选择工作区目录',
            properties: ['openDirectory'],
        });
        if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
        return { success: true, path: result.filePaths[0] };
    });
}

function dispose() {
    if (settingsManagerRef) {
        if (settingsListener) settingsManagerRef.off?.('settings-updated', settingsListener);
        if (externalSettingsListener) settingsManagerRef.off?.('settings-external-updated', externalSettingsListener);
    }
    settingsListener = null;
    externalSettingsListener = null;
    fileManager.setWorkspaceReferenceResolver(null);
    workspaceIndex?.dispose();
    workspaceIndex = null;
}

/**
 * 供主进程内其他服务（如 VCPDistributedServer 的 direct 插件）使用的稳定只读门面。
 * 每次调用都读取当前 workspaceIndex，索引被重建/替换后无需重新注入。
 * 只暴露已启用工作区的路径信息，不提供任何写入 settings 的能力。
 */
const workspaceService = Object.freeze({
    /** 所有已登记工作区（含停用），字段：id, alias, path, enabled, status */
    list() {
        return workspaceIndex ? workspaceIndex.list().map(ws => ({
            id: ws.id,
            alias: ws.alias,
            path: ws.path,
            enabled: ws.enabled,
            status: ws.status,
        })) : [];
    },
    /** 已启用工作区的根目录列表，用作写入白名单 */
    getEnabledRoots() {
        return this.list().filter(ws => ws.enabled).map(ws => ws.path);
    },
    getActiveWorkspaceId,
    resolveFile: resolveWorkspaceFile,
    getPromptSettings,
    expandPlaceholders,
});

module.exports = {
    initialize,
    dispose,
    getWorkspaceIndex,
    getActiveWorkspaceId,
    resolveWorkspaceFile,
    expandPlaceholders,
    getPromptSettings,
    workspaceService,
};