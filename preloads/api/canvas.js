'use strict';

// 画布（Canvas）：画布窗口、画布文件的增删改、AI 编辑提案审批、内容同步给聊天窗口。
// 主进程：modules/ipc/canvasHandlers.js
// 渲染端：Canvasmodules/
const { invoke, send, on, onSignal } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/canvasHandlers.js'],
    roles: ['utility'],
    api: {
        // request 可为空，也可为 { filePath, ... }；主进程 normalizeCanvasOpenRequest 统一解析
        openCanvasWindow: invoke('open-canvas-window', (request = null) => [request]).roles('chat', 'utility'),
        canvasReady: send('canvas-ready'),
        onCanvasLoadData: on('canvas-load-data'),
        onLoadCanvasFileByPath: on('load-canvas-file-by-path'),

        createNewCanvas: send('create-new-canvas'),
        loadCanvasFile: send('load-canvas-file', 'filePath'),
        saveCanvasFile: send('save-canvas-file', 'file'),
        renameCanvasFile: invoke('rename-canvas-file', 'data'),
        copyCanvasFile: send('copy-canvas-file', 'filePath'),
        deleteCanvasFile: send('delete-canvas-file', 'filePath'),
        onCanvasFileChanged: on('canvas-file-changed'),

        // AI 对画布内容的修改提案，由用户在画布窗口里批准或拒绝
        onCanvasEditProposal: on('canvas-edit-proposal'),
        sendCanvasEditDecision: send('canvas-edit-decision', 'decision'),

        // 聊天窗口读取画布当前内容，作为上下文发送给 AI
        getLatestCanvasContent: invoke('get-latest-canvas-content').roles('chat', 'utility'),
        onCanvasContentUpdate: on('canvas-content-update').roles('chat', 'utility'),
        onCanvasWindowClosed: onSignal('canvas-window-closed').roles('chat', 'utility'),
    },
};