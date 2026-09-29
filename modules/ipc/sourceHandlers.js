// modules/ipc/sourceHandlers.js
// ProjectForge「源码」侧栏的主进程桥。
// - 与 Git 侧栏同样的访问控制：按调用页面 URL 校验，仅施工图页面可用；
//   渲染进程只传 workspaceId 与工作区相对路径，根目录由 workspaceService 解析，且必须是已启用的工作区。
// - 工作区列表复用 git:list-workspaces。
'use strict';

const { ipcMain } = require('electron');
const sourceService = require('../services/sourceService');
const { isAllowedSenderUrl } = require('./gitHandlers');

const CHANNELS = [
    'source:list-files',
    'source:read-file',
    'source:write-file',
    'source:check',
];

let workspaceServiceRef = null;

function isAllowedSender(event) {
    const raw = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    return isAllowedSenderUrl(raw);
}

function resolveWorkspaceRoot(workspaceId) {
    if (!workspaceServiceRef) throw new Error('工作区服务未初始化。');
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('请先选择工作区。');
    const ws = workspaceServiceRef.list().find(item => item.id === workspaceId);
    if (!ws) throw new Error('工作区不存在，可能已被移除。');
    if (!ws.enabled) throw new Error(`工作区 "${ws.alias}" 已停用。`);
    return ws.path;
}

function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
        if (!isAllowedSender(event)) {
            return { success: false, error: '当前窗口无权调用源码接口。' };
        }
        try {
            return { success: true, data: await fn(...args) };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error),
                code: typeof error?.code === 'string' ? error.code : null,
            };
        }
    });
}

function initialize({ workspaceService = null } = {}) {
    workspaceServiceRef = workspaceService;
    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));

    handle('source:list-files', workspaceId => sourceService.listFiles(resolveWorkspaceRoot(workspaceId)));

    handle('source:read-file', (workspaceId, relPath) => sourceService.readFile(
        resolveWorkspaceRoot(workspaceId),
        typeof relPath === 'string' ? relPath : '',
    ));

    handle('source:write-file', (workspaceId, relPath, payload = {}) => {
        const p = payload && typeof payload === 'object' ? payload : {};
        return sourceService.writeFile(resolveWorkspaceRoot(workspaceId), typeof relPath === 'string' ? relPath : '', {
            content: p.content,
            expectedHash: typeof p.expectedHash === 'string' ? p.expectedHash : null,
            eol: p.eol === '\r\n' ? '\r\n' : (p.eol === '\n' ? '\n' : null),
            force: p.force === true,
        });
    });

    // 纯文本检查，不触碰磁盘；路径只用于判断语言
    handle('source:check', (relPath, text) => sourceService.checkSyntax(
        typeof relPath === 'string' ? relPath : '',
        typeof text === 'string' ? text : '',
    ));
}

module.exports = { initialize };