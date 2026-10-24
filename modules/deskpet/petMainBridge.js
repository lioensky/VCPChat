// modules/deskpet/petMainBridge.js
// 桌宠和主窗口之间的来回：桌宠上说的话交给主窗口按正常流程发送（附件一起带过去）、
// 问主窗口现在开着哪个话题、点气泡跳到那个话题、把主窗口和桌宠设置页叫到前面。

const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { isAgentId } = require('./petAssets');

// 桌宠带过来的文件：拖进来的（本机路径）或粘贴的图片（字节）。主窗口按拖进输入框的流程存成附件。
const MAX_SEND_FILES = 10;
const MAX_SEND_FILE_BYTES = 20 * 1024 * 1024;
// 拖进来的文件：主窗口发送时整个读进内存再存一份，太大的会卡住整个程序
const MAX_DROP_FILE_BYTES = 200 * 1024 * 1024;
const SEND_TIMEOUT_MS = 10000;
// 主窗口发出后还要等一会儿（最多 1.5 s）确认存进了历史才回结果：截止时间要把这段留出来，
// 不然发出去了、结果却晚于桌宠的超时，用户再点一次就发了两遍
const SEND_ACCEPT_MARGIN_MS = 2000;
const WHERE_TIMEOUT_MS = 1500;

function createPetMainBridge(ctx) {
    const pendingSends = new Map(); // requestId -> resolve
    const pendingWhere = new Map(); // requestId -> resolve：问主窗口现在开着哪个话题

    function cleanSendFiles(files) {
        if (!Array.isArray(files)) return [];
        const out = [];
        for (const file of files.slice(0, MAX_SEND_FILES)) {
            const name = typeof file?.name === 'string' && file.name ? path.basename(file.name).slice(0, 255) : '文件';
            const type = typeof file?.type === 'string' ? file.type.slice(0, 100) : '';
            if (typeof file?.path === 'string' && path.isAbsolute(file.path)) out.push({ path: file.path, name, type });
            else if (file?.data instanceof Uint8Array && file.data.length > 0 && file.data.length <= MAX_SEND_FILE_BYTES) out.push({ data: Buffer.from(file.data), name, type });
        }
        return out;
    }

    // 拖进来的文件：只收普通文件（不收文件夹、设备），也不收大到会卡住主窗口的。返回第一个不行的原因
    async function checkDroppedFiles(files) {
        for (const file of files) {
            if (!file.path) continue;
            const stat = await fs.stat(file.path).catch(() => null);
            if (!stat?.isFile()) return `「${file.name}」不是能发的文件`;
            if (stat.size > MAX_DROP_FILE_BYTES) return `「${file.name}」太大了（超过 200 MB）`;
        }
        return '';
    }

    // 问主窗口一件事：ask(requestId) 发过去，等它在 pending 里按 requestId 回话；等不到算 timedOut
    function askMain(pending, ask, { timeoutMs, timedOut, answer }) {
        const requestId = crypto.randomUUID();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pending.delete(requestId);
                resolve(timedOut);
            }, timeoutMs);
            pending.set(requestId, (value) => {
                clearTimeout(timer);
                pending.delete(requestId);
                resolve(answer(value));
            });
            ask(requestId);
        });
    }

    function sendFromPet(agentId, text, { files = [], newTopic = false } = {}) {
        const { mainWindow } = ctx;
        if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve({ success: false, error: '主窗口不在了' });
        // 过了 deadline 桌宠已经报「没有响应」了：主窗口别再发出去，否则用户重试就会发两遍
        const deadline = Date.now() + SEND_TIMEOUT_MS - SEND_ACCEPT_MARGIN_MS;
        const ask = (requestId) => mainWindow.webContents.send('deskpet:send-request', { requestId, agentId, text, files, newTopic, deadline });
        return askMain(pendingSends, ask, {
            timeoutMs: SEND_TIMEOUT_MS,
            timedOut: { success: false, error: '主窗口没有响应' },
            answer: (result) => result || { success: false },
        });
    }

    // 主窗口现在开着哪个助手的哪个话题：开着「桌宠闲聊」时不往里写（主窗口手里的那份历史会盖掉这一句）
    function mainWhere() {
        const { mainWindow } = ctx;
        if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
        const ask = (requestId) => mainWindow.webContents.send('deskpet:where-request', { requestId });
        return askMain(pendingWhere, ask, {
            timeoutMs: WHERE_TIMEOUT_MS,
            timedOut: null,
            answer: (where) => (where && typeof where === 'object' ? where : null),
        });
    }

    function openMainWindow() {
        const { mainWindow } = ctx;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }

    /** 托盘、右键菜单的「桌宠设置…」：把主窗口叫到前面，打开全局设置的桌宠分区。 */
    function openSettingsPage() {
        openMainWindow();
        ctx.mainContents()?.send('deskpet-settings:open');
    }

    // 点桌宠说的新话题：打开主窗口并切到那个话题（由主窗口按正常流程选中）。
    // 话题可能在气泡还挂着时被删掉了：主窗口选中一个不存在的话题后，接着说的话会存进一份话题列表里看不到的历史，
    // 所以先确认它还在这个助手的配置里。
    async function openTopic(agentId, topicId) {
        openMainWindow();
        const { mainWindow } = ctx;
        if (!mainWindow || mainWindow.isDestroyed() || !isAgentId(agentId) || typeof topicId !== 'string' || !topicId) return false;
        let topics = [];
        try {
            topics = (await fs.readJson(path.join(ctx.paths.agentDir, agentId, 'config.json')))?.topics;
        } catch { /* 读不到配置就当话题不在了 */ }
        if (!Array.isArray(topics) || !topics.some((topic) => String(topic?.id) === topicId)) return false;
        if (mainWindow.isDestroyed()) return false;
        mainWindow.webContents.send('deskpet:open-topic', { agentId, topicId });
        return true;
    }

    return {
        cleanSendFiles,
        checkDroppedFiles,
        sendFromPet,
        mainWhere,
        openMainWindow,
        openSettingsPage,
        openTopic,
        /** 主窗口回话了（deskpet:send-result / deskpet:where-result）。 */
        resolveSend: (payload) => pendingSends.get(payload?.requestId)?.(payload?.result),
        resolveWhere: (payload) => pendingWhere.get(payload?.requestId)?.(payload?.where),
        /** 退出：还在等主窗口回话的都当没答上。 */
        settleAllPending() {
            for (const pending of [pendingSends, pendingWhere]) for (const finish of [...pending.values()]) finish(null);
        },
    };
}

module.exports = { createPetMainBridge };
