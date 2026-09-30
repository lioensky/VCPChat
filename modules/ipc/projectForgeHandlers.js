// modules/ipc/projectForgeHandlers.js
// ProjectForge 施工图 GUI 的主进程桥：直接复用插件模块（与分布式服务器同进程、同一模块实例），
// 因此写锁、工作区白名单、快照库都与 CLI 端完全一致。
// GUI 只读；唯一的写操作是带署名的单文件回退。
'use strict';

const { ipcMain, webContents } = require('electron');
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

let workspaceServiceRef = null;
let forgeModule = null;
let listeningEvents = false;

function broadcastToProjectForge(channel, payload) {
    if (!webContents || typeof webContents.getAllWebContents !== 'function') return;
    for (const wc of webContents.getAllWebContents()) {
        try {
            if (wc.isDestroyed()) continue;
            const url = (wc.getURL() || '').toLowerCase();
            if (url.includes('projectforge.html')) {
                wc.send(channel, payload);
            }
        } catch (_e) { /* ignore */ }
    }
}

function setupEventListener() {
    if (listeningEvents) return;
    if (!forgeModule) forgeModule = require(path.join(PLUGIN_DIR, 'ProjectForgeService.js'));
    if (forgeModule?.events) {
        forgeModule.events.on('changed', payload => {
            broadcastToProjectForge('project-forge:changed', payload);
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

function initialize({ workspaceService = null } = {}) {
    workspaceServiceRef = workspaceService;
    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));
    setupEventListener();

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
        });
    }));
    ipcMain.handle('project-forge:delete-project', wrap((projectId, signature) => forge().deleteProject(projectId, signature)));
}

module.exports = { initialize };