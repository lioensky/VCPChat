'use strict';

const { ipcMain } = require('electron');
const { createDeepWikiService } = require('../services/deepWikiService');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
let initialized = false;

function initialize({ mainWindow, service = createDeepWikiService() }) {
    if (initialized) return;
    initialized = true;
    const activeRequests = new Map();

    const isMainRenderer = event => Boolean(
        mainWindow
        && !mainWindow.isDestroyed()
        && event?.sender === mainWindow.webContents
    );

    const abortAll = () => {
        activeRequests.forEach(controller => controller.abort());
        activeRequests.clear();
    };

    mainWindow?.webContents?.once?.('destroyed', abortAll);

    ipcMain.handle('ask-nova:query', async (event, payload = {}) => {
        if (!isMainRenderer(event)) return { success: false, error: 'Ask Nova 仅允许主聊天窗口调用。' };
        const requestId = String(payload.requestId || '');
        if (!REQUEST_ID_PATTERN.test(requestId)) return { success: false, error: 'Ask Nova 请求标识无效。' };
        const key = `${event.sender.id}:${requestId}`;
        if (activeRequests.has(key)) return { success: false, error: 'Ask Nova 请求标识重复。' };

        const controller = new AbortController();
        activeRequests.set(key, controller);
        try {
            const result = await service.ask(payload, { signal: controller.signal });
            return { success: true, ...result };
        } catch (error) {
            return {
                success: false,
                cancelled: error?.code === 'ASK_NOVA_CANCELLED',
                error: error?.message || 'DeepWiki MCP 调用失败。'
            };
        } finally {
            activeRequests.delete(key);
        }
    });

    ipcMain.handle('ask-nova:cancel', (event, requestIdValue) => {
        if (!isMainRenderer(event)) return { success: false };
        const requestId = String(requestIdValue || '');
        if (!REQUEST_ID_PATTERN.test(requestId)) return { success: false };
        const key = `${event.sender.id}:${requestId}`;
        const controller = activeRequests.get(key);
        if (!controller) return { success: true, cancelled: false };
        controller.abort();
        return { success: true, cancelled: true };
    });
}

module.exports = { initialize };
