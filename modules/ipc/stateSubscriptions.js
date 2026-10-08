// modules/ipc/stateSubscriptions.js
// 主进程按窗口的订阅表：渲染端的共享数据源有了第一个持有者时发 state:subscribe(topic, key)，
// 最后一个离开时发 state:unsubscribe；主进程推送只发给订阅了的窗口，不再按页面 URL 猜谁需要。
//   - 同一个窗口里多次订阅按次数计，归零才算离开；窗口关闭或主框架导航时它的订阅全部清掉；
//   - 某个 topic+key 第一个窗口订阅时调用 onFirst(key)，最后一个窗口离开时调用 onLast(key)，
//     主进程侧的文件监听之类的资源跟着它启停；
//   - describe(key) 可选：订阅成功时把它的返回值作为 state 一起回给这个窗口，
//     后来的窗口也能知道已经发生过的状态（比如这个仓库的监听已经降级）；
//   - snapshot() 给 lifecycle:get-main-snapshot 用，只有 topic、key 和窗口数，没有数据内容。
'use strict';

const { onSenderGone } = require('./senderLifetime');

const CHANNELS = ['state:subscribe', 'state:unsubscribe'];
const TOPIC_PATTERN = /^[a-z][a-z0-9.-]{1,63}$/;
const MAX_KEY_LENGTH = 300;

function createStateSubscriptions({ logger = console } = {}) {
    const topics = new Map(); // name → { keyed, onFirst, onLast, describe, windows: Map<key, number> }
    const bySender = new Map(); // sender → { entries: Map<id, { name, key, refs }>, forget }
    let ipcRef = null;

    const entryId = (name, key) => `${name}\u0000${key}`;

    function declare(name, { keyed = false, onFirst = null, onLast = null, describe = null } = {}) {
        if (!TOPIC_PATTERN.test(String(name))) throw new TypeError(`[StateSubscriptions] invalid topic name: ${name}`);
        if (topics.has(name)) throw new Error(`[StateSubscriptions] topic declared twice: ${name}`);
        topics.set(name, { keyed: Boolean(keyed), onFirst, onLast, describe, windows: new Map() });
    }

    function normalize(name, key) {
        const topic = topics.get(name);
        if (!topic) return { error: `未知的订阅主题：${name}` };
        const value = key == null ? '' : String(key);
        if (topic.keyed && !value) return { error: `${name} 需要 key` };
        if (!topic.keyed && value) return { error: `${name} 不接受 key` };
        if (value.length > MAX_KEY_LENGTH) return { error: 'key 过长' };
        return { topic, key: value };
    }

    function call(hook, key, name) {
        if (typeof hook !== 'function') return;
        try {
            hook(key);
        } catch (error) {
            logger?.error?.(`[StateSubscriptions] ${name} hook failed:`, error);
        }
    }

    function windowJoined(name, topic, key) {
        const count = (topic.windows.get(key) || 0) + 1;
        topic.windows.set(key, count);
        if (count === 1) call(topic.onFirst, key, name);
    }

    function windowLeft(name, topic, key) {
        const count = (topic.windows.get(key) || 0) - 1;
        if (count > 0) {
            topic.windows.set(key, count);
            return;
        }
        topic.windows.delete(key);
        call(topic.onLast, key, name);
    }

    function dropSender(sender) {
        const record = bySender.get(sender);
        if (!record) return;
        bySender.delete(sender);
        record.forget();
        for (const { name, key } of record.entries.values()) {
            const topic = topics.get(name);
            if (topic) windowLeft(name, topic, key);
        }
    }

    function subscribe(sender, name, key) {
        const target = normalize(name, key);
        if (target.error) return { success: false, error: target.error };
        let record = bySender.get(sender);
        if (!record) {
            record = { entries: new Map(), forget: () => {} };
            bySender.set(sender, record);
            record.forget = onSenderGone(sender, () => dropSender(sender));
        }
        const id = entryId(name, target.key);
        const entry = record.entries.get(id);
        if (entry) {
            entry.refs += 1;
        } else {
            record.entries.set(id, { name, key: target.key, refs: 1 });
            windowJoined(name, target.topic, target.key);
        }
        if (typeof target.topic.describe !== 'function') return { success: true };
        try {
            return { success: true, state: target.topic.describe(target.key) ?? null };
        } catch (error) {
            logger?.error?.(`[StateSubscriptions] ${name} describe failed:`, error);
            return { success: true, state: null };
        }
    }

    function unsubscribe(sender, name, key) {
        const target = normalize(name, key);
        if (target.error) return { success: false, error: target.error };
        const record = bySender.get(sender);
        const id = entryId(name, target.key);
        const entry = record?.entries.get(id);
        if (!entry) return { success: true }; // 多余的取消直接忽略
        entry.refs -= 1;
        if (entry.refs > 0) return { success: true };
        record.entries.delete(id);
        if (!record.entries.size) {
            bySender.delete(sender);
            record.forget();
        }
        windowLeft(name, target.topic, target.key);
        return { success: true };
    }

    /** 只发给订阅了 name/key 的窗口；返回实际发送的窗口数 */
    function publish(name, key, channel, payload) {
        const id = entryId(name, key == null ? '' : String(key));
        let sent = 0;
        for (const [sender, record] of [...bySender]) {
            if (!record.entries.has(id)) continue;
            try {
                if (sender.isDestroyed?.()) {
                    dropSender(sender);
                    continue;
                }
                sender.send(channel, payload);
                sent += 1;
            } catch (_error) { /* 页面正在关闭 */ }
        }
        return sent;
    }

    function windowsFor(name, key = '') {
        return topics.get(name)?.windows.get(key == null ? '' : String(key)) || 0;
    }

    function snapshot() {
        const rows = [];
        for (const [name, topic] of topics) {
            for (const [key, windows] of topic.windows) rows.push(Object.freeze({ topic: name, key, windows }));
        }
        return rows;
    }

    /**
     * @param {{ handle: Function, removeHandler: Function }} ipcMain
     * @param {(event) => boolean} isAllowedSender
     */
    function registerIpc(ipcMain, isAllowedSender) {
        ipcRef = ipcMain;
        const guard = typeof isAllowedSender === 'function' ? isAllowedSender : () => false;
        for (const channel of CHANNELS) ipcMain.removeHandler(channel);
        ipcMain.handle('state:subscribe', (event, name, key) => {
            if (!guard(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
            return subscribe(event.sender, String(name || ''), key);
        });
        ipcMain.handle('state:unsubscribe', (event, name, key) => {
            if (!guard(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
            return unsubscribe(event.sender, String(name || ''), key);
        });
    }

    function dispose() {
        if (ipcRef) for (const channel of CHANNELS) ipcRef.removeHandler(channel);
        ipcRef = null;
        for (const sender of [...bySender.keys()]) dropSender(sender);
    }

    return Object.freeze({ declare, subscribe, unsubscribe, publish, windowsFor, snapshot, registerIpc, dispose });
}

module.exports = { CHANNELS, createStateSubscriptions };
