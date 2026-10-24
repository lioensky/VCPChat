'use strict';

// 语音会话的窗口归属与桌宠文字投递。这里只路由，不持有或复制聊天历史。
const { randomUUID } = require('crypto');

function createVoiceChatSessions({ timeoutMs = 8000 } = {}) {
    const sessions = new Map();
    const pending = new Map();
    const listeners = new Set();
    const alive = row => row && !row.win.isDestroyed() && !row.win.webContents.isDestroyed();
    const notify = agentId => {
        for (const listener of listeners) listener(agentId, status(agentId));
    };
    function status(agentId) {
        const row = sessions.get(agentId);
        return { mode: alive(row) ? 'voice' : 'main', ready: !!(alive(row) && row.ready) };
    }
    function settleFor(row, error) {
        for (const [id, job] of pending) {
            if (job.row === row) finish(id, { success: false, error });
        }
    }
    function finish(id, result) {
        const job = pending.get(id);
        if (!job) return;
        clearTimeout(job.timer);
        pending.delete(id);
        job.resolve(result);
    }
    function register(agentId, win) {
        const old = sessions.get(agentId);
        if (old) settleFor(old, '语音会话已切换，请确认后重新发送');
        const row = { agentId, win, ready: false };
        sessions.set(agentId, row);
        const remove = () => {
            if (sessions.get(agentId) !== row) return;
            sessions.delete(agentId);
            settleFor(row, '语音窗口已关闭，请确认消息是否已发送');
            notify(agentId);
        };
        win.once('closed', remove);
        win.webContents.once('destroyed', remove);
        win.webContents.on('did-start-loading', () => {
            if (sessions.get(agentId) !== row) return;
            row.ready = false;
            settleFor(row, '语音窗口正在重新加载，请确认消息是否已发送');
            notify(agentId);
        });
        notify(agentId);
    }
    function setReady(sender, ready) {
        const row = [...sessions.values()].find(row => alive(row) && row.win.webContents === sender);
        if (!row) return false;
        row.ready = ready === true;
        if (!row.ready) settleFor(row, '语音会话正在关闭，请确认消息是否已发送');
        notify(row.agentId);
        return true;
    }
    function focus(agentId) {
        const row = sessions.get(agentId);
        if (!alive(row)) return false;
        if (row.win.isMinimized()) row.win.restore();
        row.win.show();
        row.win.focus();
        return true;
    }
    function send(agentId, text, { files = [], newTopic = false } = {}) {
        const row = sessions.get(agentId);
        if (!alive(row)) return null; // 只有根本没有语音窗口时才允许普通路由。
        const fail = error => Promise.resolve({ success: false, error });
        if (!row.ready) return fail('语音会话尚未就绪或正在关闭，请稍后再试');
        if (files.length) return fail('语音会话暂不支持附件，请关闭语音窗口后发送');
        if (newTopic) return fail('语音会话中不能新建普通话题，请关闭语音窗口后操作');
        const requestId = randomUUID();
        const deadline = Date.now() + timeoutMs;
        return new Promise(resolve => {
            const timer = setTimeout(() => finish(requestId, {
                success: false, error: '语音窗口未确认接收，请先检查语音记录，避免重复发送',
            }), timeoutMs);
            pending.set(requestId, { row, resolve, timer });
            try {
                row.win.webContents.send('voice-chat:deskpet-send', { requestId, text, deadline });
            } catch {
                finish(requestId, { success: false, error: '无法投递到语音窗口，请确认后重新发送' });
            }
        });
    }
    function acknowledge(sender, payload) {
        const job = pending.get(payload?.requestId);
        if (!job || job.row.win.webContents !== sender) return false;
        finish(payload.requestId, {
            success: payload.success === true,
            ...(payload.success === true ? { route: 'voice' } : { error: String(payload.error || '语音消息发送失败') }),
        });
        return true;
    }
    return {
        register, status, setReady, focus, send, acknowledge,
        interrupt(agentId, messageId) {
            const row = sessions.get(agentId);
            if (!alive(row) || !row.ready) return false;
            row.win.webContents.send('voice-chat:deskpet-interrupt', { messageId });
            return true;
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
}

module.exports = { createVoiceChatSessions, voiceChatSessions: createVoiceChatSessions() };