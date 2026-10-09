/**
 * 桌宠上输入的话由主窗口按正常流程发送：切到那个 Agent，再用请求对象调用
 * handleSendMessage。不经过主输入框，用户还没发的草稿和已选附件都不会被带走或覆盖。
 */
export const DESK_PET_SEND_ACCEPT_MS = 1500;

export function createDeskPetSendBridge({
    getSelectedItem,
    getTopicId,
    findAgent,
    selectItem,
    sendMessage,
    startTopic,
    isBusy,
    storeFiles = async () => [],
    acceptMs = DESK_PET_SEND_ACCEPT_MS,
    wait = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
}) {
    // 桌宠的发送一条一条来：两次快速发送不能同时等切换、同时通过「上一条还在回复中」的检查。
    let queue = Promise.resolve();
    return function sendFromPet(request) {
        const run = queue.then(() => sendOne(request));
        queue = run.catch(() => {});
        return run;
    };

    async function sendOne({ agentId, text, files, newTopic = false, deadline } = {}) {
        // 桌宠那边已经按超时报失败了（前面排着的一条切换太慢）：不再发，免得用户重试后发两遍
        const expired = () => Number.isFinite(deadline) && now() > deadline;
        const dropped = Array.isArray(files) ? files : [];
        if (typeof text !== 'string') text = '';
        if (typeof agentId !== 'string' || !agentId || (!text.trim() && !dropped.length)) {
            return { success: false, error: '没有内容' };
        }
        if (getSelectedItem()?.id !== agentId || !getTopicId()) {
            const item = findAgent(agentId);
            if (!item) return { success: false, error: '助手列表里找不到这个 Agent' };
            // 等整个选中事务完成（话题定下来）再发；选中刚开始时话题还是空的，那时发出去的话会被丢掉。
            await selectItem(item);
        }
        const selected = getSelectedItem();
        if (selected?.id !== agentId || selected?.type !== 'agent' || !getTopicId()) {
            return { success: false, error: '没能切换到这个助手' };
        }
        if (isBusy()) return { success: false, error: '上一条还在回复中' };
        if (expired()) return { success: false, error: '主窗口没有响应' };
        // 桌宠输入条上按了「+」：先像主窗口的「新话题」那样开一个，开成了再发
        if (newTopic) {
            const before = getTopicId();
            await startTopic?.(selected);
            if (!getTopicId() || getTopicId() === before || getSelectedItem()?.id !== agentId) {
                return { success: false, error: '没能开新话题' };
            }
            if (expired()) return { success: false, error: '主窗口没有响应' };
        }
        // 桌宠带来的文件按拖进输入框的流程存进这个话题（按了「+」就是刚开的那个），存好的才带上；一个都没存好就不发
        let attachments = [];
        if (dropped.length) {
            const results = await storeFiles(agentId, getTopicId(), dropped).catch(error => [{ error: error?.message || String(error) }]);
            attachments = (Array.isArray(results) ? results : []).filter(r => r?.success && r.attachment).map(({ attachment: att }) => ({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.internalPath,
                originalName: att.name,
                isLiveReference: att.isLiveReference === true,
                _fileManagerData: att,
            }));
            if (!attachments.length) {
                const failed = (Array.isArray(results) ? results : []).find(r => r?.error);
                return { success: false, error: `文件没存上：${failed?.error || '未知原因'}` };
            }
            if (expired()) return { success: false, error: '主窗口没有响应' };
        }
        const sending = Promise.resolve().then(() => sendMessage({ content: text, attachments, propagateError: true }));
        // 发送要等回复开始流才返回；这里只等校验和落盘这一小段，之后的错误会显示在聊天里，桌宠也会收到出错事件。
        const early = await Promise.race([
            sending.then(() => null, error => error || new Error('发送失败')),
            wait(acceptMs).then(() => null),
        ]);
        // shownInChat：话已经存进历史，只是回复失败（聊天里有报错）；不能让桌宠当成没发出去再发一遍。
        if (early && !early.shownInChat) return { success: false, error: early.message || String(early) };
        return { success: true };
    }
}
