'use strict';

// RAG 观察器与悬浮窗：浪潮语义寻址可视化窗口，以及悬浮提示层的显示、透明度、穿透和审批操作。
// 主进程：modules/ipc/ragHandlers.js
// 渲染端：RAGmodules/
const { invoke, send, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/ragHandlers.js'],
    roles: ['utility'],
    api: {
        openRAGObserverWindow: invoke('open-rag-observer-window').roles('chat', 'utility'),

        ragOverlayShow: send('rag-overlay-show', 'payload'),
        ragOverlayHide: send('rag-overlay-hide'),
        ragOverlaySetEnabled: send('rag-overlay-set-enabled', 'enabled'),
        ragOverlaySetNotificationCategoryEnabled: send('rag-overlay-set-notification-category-enabled', 'enabled'),
        ragOverlaySetOpacity: send('rag-overlay-set-opacity', 'opacity'),
        ragOverlaySetPassThrough: send('rag-overlay-set-pass-through', 'passThrough'),
        ragOverlayResize: send('rag-overlay-resize', 'payload'),
        ragOverlayGetBounds: invoke('rag-overlay-get-bounds'),
        ragOverlayGetState: invoke('rag-overlay-get-state'),
        onRagOverlayPayload: on('rag-overlay-payload'),
        onRagOverlayPassThroughChanged: on('rag-overlay-pass-through-changed'),

        // 悬浮窗里的审批按钮：悬浮窗发出，观察器窗口接收
        sendRagOverlayApprovalAction: send('rag-overlay-approval-action', 'payload'),
        onRagOverlayApprovalAction: on('rag-overlay-approval-action'),
    },
};