// modules/ipc/projectForgeHandlers.js
// ProjectForge 施工图 GUI 的主进程桥：直接复用插件模块（与分布式服务器同进程、同一模块实例），
// 因此写锁、工作区白名单、快照库都与 CLI 端完全一致。
// GUI 只读；唯一的写操作是带署名的单文件回退。
'use strict';

const { ipcMain: defaultIpcMain } = require('electron');
// main.js 传入经 sidePaneIpcPolicy 包装过的 ipcMain（先查调用方窗口）；不传就用 Electron 的
let ipcMain = defaultIpcMain;
const path = require('path');
const fs = require('fs');

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'VCPDistributedServer', 'Plugin', 'ProjectForge');
const CHANNELS = [
    'project-forge:list-projects',
    'project-forge:get-project',
    'project-forge:search-history',
    'project-forge:get-batch',
    'project-forge:get-node',
    'project-forge:revert-file',
    'project-forge:delete-project',
];

// 工程变更推送的订阅主题：V工程窗口、主窗口的状态面板和侧栏有人在看时才订阅，推送只发给订阅了的窗口
const CHANGED_TOPIC = 'project-forge';

let workspaceServiceRef = null;
let subscriptionsRef = null;
let forgeModule = null;
let listeningEvents = false;

function setupEventListener() {
    if (listeningEvents) return;
    if (!forgeModule) forgeModule = require(path.join(PLUGIN_DIR, 'ProjectForgeService.js'));
    if (forgeModule?.events) {
        forgeModule.events.on('changed', payload => {
            subscriptionsRef?.publish(CHANGED_TOPIC, '', 'project-forge:changed', payload);
        });
        listeningEvents = true;
    }
}

function readPluginConfig() {
    try {
        const envPath = path.join(PLUGIN_DIR, 'config.env');
        if (!fs.existsSync(envPath)) return {};
        return require('dotenv').parse(fs.readFileSync(envPath));
    } catch (error) {
        console.warn('[ProjectForgeGUI] Failed to read plugin config.env:', error.message);
        return {};
    }
}

function forge() {
    if (!forgeModule) forgeModule = require(path.join(PLUGIN_DIR, 'ProjectForgeService.js'));
    // 分布式服务器未启用时插件不会被初始化；此处按插件配置懒初始化。
    forgeModule.ensureRuntime({
        config: readPluginConfig(),
        services: { workspaceService: workspaceServiceRef },
        logger: console,
    });
    return forgeModule.gui;
}

function wrap(fn) {
    return async (_event, ...args) => {
        try {
            return { success: true, data: await fn(...args) };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    };
}

/**
 * @param {object} [options]
 * @param {object} [options.workspaceService]
 * @param {object} [options.subscriptions] stateSubscriptions.js 的订阅表；第一个窗口订阅时才加载插件、挂上变更监听
 */
function initialize({ workspaceService = null, subscriptions = null, ipcMain: injectedIpcMain = null } = {}) {
    ipcMain = injectedIpcMain || defaultIpcMain;
    workspaceServiceRef = workspaceService;
    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));
    if (subscriptions && subscriptions !== subscriptionsRef) {
        subscriptionsRef = subscriptions;
        subscriptions.declare(CHANGED_TOPIC, { onFirst: () => setupEventListener() });
    }

    ipcMain.handle('project-forge:list-projects', wrap((options = {}) => forge().listProjects(options)));
    ipcMain.handle('project-forge:get-project', wrap(projectId => forge().getProject(String(projectId || ''))));
    ipcMain.handle('project-forge:search-history', wrap((filters = {}) => forge().searchHistory(filters || {})));
    ipcMain.handle('project-forge:get-batch', wrap((projectId, batchId) => forge().getBatchNodes(String(projectId || ''), batchId)));
    ipcMain.handle('project-forge:get-node', wrap((projectId, nodeId) => forge().getNodeDetail(String(projectId || ''), nodeId)));
    ipcMain.handle('project-forge:revert-file', wrap((payload = {}) => {
        const p = payload && typeof payload === 'object' ? payload : {};
        return forge().revertFileChange({
            projectId: String(p.projectId || ''),
            nodeId: Number(p.nodeId),
            mode: p.mode === 'after' ? 'after' : 'before',
            signature: typeof p.signature === 'string' ? p.signature : '',
            reason: typeof p.reason === 'string' ? p.reason : '',
            dryRun: p.dryRun === true,
            force: p.force === true,
            ...(Object.prototype.hasOwnProperty.call(p, 'expectedHash') ? { expectedHash: p.expectedHash } : {}),
        });
    }));
    ipcMain.handle('project-forge:delete-project', wrap((projectId, signature) => forge().deleteProject(projectId, signature)));
}

module.exports = { CHANGED_TOPIC, initialize };
