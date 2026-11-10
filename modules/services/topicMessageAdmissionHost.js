'use strict';

const fs = require('fs-extra');
const path = require('path');
const { TopicMessageAdmission } = require('./topicMessageAdmission');
const { createTopicMessageAdmissionStore } = require('./topicMessageAdmissionStore');

async function createTopicMessageAdmissionHost({
    appDataRoot, historyQueue, validate, getMainWindow, ipcMain, logger = console,
    advanceGroup = null,
}) {
    const pending = new Map();
    const channels = [];
    const sender = () => {
        const win = getMainWindow();
        return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null;
    };
    const send = (channel, data) => {
        const target = sender();
        if (!target) throw new Error('主聊天窗口不可用');
        target.send(channel, data);
    };
    const service = new TopicMessageAdmission({
        validate,
        verifyTerminal: (scope, token) => historyQueue.run(scope, async () => {
            await validate(scope);
            const history = await historyQueue.read(scope);
            const matches = history.filter(message => message.role === 'assistant'
                && message.admissionToken === token && message.admissionTerminal === true
                && !message.isThinking && !message.isPendingStream && typeof message.id === 'string' && message.id);
            // Ambiguous evidence is not a safe completion proof.
            return matches.length === 1
                ? { verified: true, messageId: matches[0].id }
                : { verified: false };
        }),
        store: createTopicMessageAdmissionStore(path.join(appDataRoot, 'TopicMessageQueue', 'pending.json')),
        commit: async (scope, message) => {
            // validate must establish topic existence; never resurrect deleted folders.
            const file = historyQueue.getHistoryPath(scope.itemId, scope.topicId);
            if (!await fs.pathExists(file)) throw new Error('目标话题历史已不存在');
            await historyQueue.mutate(scope, history => {
                if (!history.some(item => item.id === message.id)) {
                    const lastTimestamp = history.reduce((latest, item) => {
                        const value = Number(item.timestamp);
                        return Number.isFinite(value) ? Math.max(latest, value) : latest;
                    }, 0);
                    history.push({ ...message, timestamp: Math.max(Date.now(), lastTimestamp + 1) });
                }
                return history;
            }, { requireExisting: true });
            try { send('topic-admission:committed', { scope, messageId: message.id }); }
            catch (error) { logger.warn?.('[Admission] history notification unavailable', error.message); }
        },
        advance: request => {
            if (request.scope.itemType === 'group') {
                if (typeof advanceGroup !== 'function') throw new Error('群聊推进运行时尚未接通，已暂停');
                // The callback accepts/schedules work, never awaits a whole group session.
                return advanceGroup(request, service);
            }
            return new Promise((resolve, reject) => {
            const target = sender();
            if (!target) return reject(new Error('主聊天窗口不可用'));
            const timer = setTimeout(() => {
                pending.delete(request.token);
                reject(new Error('推进请求未获确认，已暂停'));
            }, 15000);
            pending.set(request.token, { resolve, reject, timer, senderId: target.id });
            try { target.send('topic-admission:advance', request); }
            catch (error) {
                clearTimeout(timer);
                pending.delete(request.token);
                reject(error);
            }
            });
        },
        publish: entries => {
            const target = sender();
            if (target) target.send('topic-admission:changed', entries);
        },
        logger,
    });
    await service.initialize();
    const register = (channel, handler) => {
        ipcMain.handle(channel, async (event, ...args) => {
            if (event.sender !== sender()) return { success: false, code: 'FORBIDDEN' };
            try { return await handler(event, ...args); }
            catch (error) { return { success: false, error: error.message || String(error) }; }
        });
        channels.push(channel);
    };
    register('topic-admission:list', (_event, scope) => ({
        success: true, entries: service.snapshot(scope),
    }));
    register('topic-admission:submit', (_event, request) => service.submit(request));
    register('topic-admission:persist-assistant', async (_event, scope, message) => {
        if (scope?.itemType !== 'agent' || typeof message?.id !== 'string' || !message.id
            || message.role !== 'assistant' || message.isThinking || message.isPendingStream) {
            throw new TypeError('终稿提交需要单聊目标与完整 assistant 消息');
        }
        const target = structuredClone(scope);
        const terminal = structuredClone(message);
        // This marker is written only as part of the terminal-history transaction.
        if (typeof terminal.admissionToken === 'string' && terminal.admissionToken) {
            terminal.admissionTerminal = true;
        }
        await validate(target);
        const result = await historyQueue.mutate(target, history => {
            const index = history.findIndex(item => item.id === terminal.id);
            if (index >= 0) {
                if (history[index].role !== 'assistant') throw new Error('终稿 ID 与非 assistant 消息冲突');
                history[index] = { ...history[index], ...terminal };
            } else {
                history.push(terminal);
            }
            return history;
        }, { requireExisting: true });
        return { success: true, messageId: terminal.id, history: result.history };
    });
    register('topic-admission:withdraw', (_event, scope, entryId) => service.withdraw(scope, entryId));
    register('topic-admission:resume', (_event, scope) => service.resume(scope));
    register('topic-admission:reconcile', (_event, scope, entryId) => service.reconcile(scope, entryId));
    register('topic-admission:acquire', (_event, scope, token) => service.acquire(scope, token));
    register('topic-admission:release', (_event, scope, token, outcome) => service.release(scope, token, outcome));
    register('topic-admission:relay', (_event, scope, token, outcome) => service.relay(scope, token, outcome));
    register('topic-admission:cancel-relay', (_event, scope, token) => service.cancelRelay(scope, token));
    register('topic-admission:fail', (_event, scope, token, error) => service.fail(scope, token, error));
    register('topic-admission:uncertain', (_event, scope, token, error) => service.reportUncertain(scope, token, error));
    register('topic-admission:ack', (event, token, error) => {
        const request = pending.get(token);
        if (!request || request.senderId !== event.sender.id) return { success: false, code: 'STALE_REQUEST' };
        clearTimeout(request.timer);
        pending.delete(token);
        if (error) request.reject(new Error(String(error)));
        else request.resolve();
        return { success: true };
    });
    return {
        service,
        async dispose() {
            for (const request of pending.values()) {
                clearTimeout(request.timer);
                request.reject(new Error('Admission host stopped'));
            }
            pending.clear();
            await service.dispose();
            channels.forEach(channel => ipcMain.removeHandler(channel));
        },
    };
}

module.exports = { createTopicMessageAdmissionHost };