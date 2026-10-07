/*
 * conversation.current：主聊天当前在看哪个会话，以及它的记录改过几次。
 * 值形如 { itemId, itemType, topicId, historyRevision }：
 *   - itemId / itemType / topicId 只在 chatManager 确认切换完成时更新，切换途中的半截状态不会发出去；
 *   - historyRevision 在每次写入当前记录时加一（发消息、回复写完、编辑、删除……）。
 * 状态面板、侧栏计划页据此重新圈定话题用过的 V工程和命令，不用再盯着聊天区的 DOM。
 */
import '../state-channel.js';

export const CONVERSATION_CURRENT_CHANNEL = 'conversation.current';

const INITIAL = Object.freeze({ itemId: null, itemType: null, topicId: null, historyRevision: 0 });

/** 页面里只有一份；第一次用到时建 */
export function getConversationCurrentChannel() {
    const channels = globalThis.VCPStateChannels;
    if (!channels) return null;
    return channels.get(CONVERSATION_CURRENT_CHANNEL) || channels.create(CONVERSATION_CURRENT_CHANNEL, INITIAL);
}

/** 切换完成：换成新的会话，记录修订号照常往上走 */
export function publishConversationSelection({ itemId = null, itemType = null, topicId = null } = {}) {
    const channel = getConversationCurrentChannel();
    if (!channel) return;
    const prev = channel.get() || INITIAL;
    channel.publish(Object.freeze({
        itemId: itemId ?? null,
        itemType: itemType ?? null,
        topicId: topicId ?? null,
        historyRevision: prev.historyRevision
    }), {
        source: 'selection',
        equals: (left, right) => left?.itemId === right.itemId && left?.itemType === right.itemType && left?.topicId === right.topicId
    });
}

/** 当前记录被写了一次 */
export function bumpConversationHistory() {
    const channel = getConversationCurrentChannel();
    if (!channel) return;
    const prev = channel.get() || INITIAL;
    channel.publish(Object.freeze({ ...prev, historyRevision: prev.historyRevision + 1 }), { source: 'history' });
}

/**
 * 订阅之后的变化，listener(value, prev)。
 * @returns {() => void}
 */
export function watchConversationCurrent(listener) {
    const channel = getConversationCurrentChannel();
    if (!channel || typeof listener !== 'function') return () => {};
    let prev = channel.get();
    const off = channel.subscribe(value => {
        const before = prev;
        prev = value;
        listener(value, before);
    }, { immediate: false });
    return () => { off(); };
}

/** 只关心记录改了（同一个会话里），切会话不算 */
export function watchConversationHistory(listener) {
    return watchConversationCurrent((value, prev) => {
        if (value.historyRevision === prev?.historyRevision) return;
        if (value.itemId !== prev?.itemId || value.topicId !== prev?.topicId) return;
        listener(value);
    });
}

/**
 * 跟随主聊天切换会话：点选的当下通知一次（settled: false，历史还在载入、渲染），载入完成再通知一次（settled: true）。
 * 大话题的历史要渲染好几秒，只等完成事件的话这段时间侧栏一直显示上一个话题。
 * @returns {(() => void) | null} 两个通知都接不上时返回 null
 */
export function followConversationSelection(chatManager, callback) {
    const offIntent = chatManager?.onSelectionIntent?.(event => callback({ ...event, settled: false }));
    const offCommit = chatManager?.onSelectionChange?.(event => callback({ ...event, settled: true }));
    if (typeof offIntent !== 'function' && typeof offCommit !== 'function') return null;
    return () => {
        if (typeof offIntent === 'function') offIntent();
        if (typeof offCommit === 'function') offCommit();
    };
}
