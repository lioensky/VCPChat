'use strict';

const DEFAULT_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE = 100;
const MIN_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE = 1;
const MAX_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE = 10000;

/**
 * 归一化群聊 Agent 上下文窗口配置。
 * 窗口默认关闭；无效大小回退为 100，并限制在 1–10000。
 */
function normalizeGroupContextWindowSettings(config = {}) {
    const parsedSize = Number.parseInt(config.contextMessageWindowSize, 10);
    const contextMessageWindowSize = Number.isFinite(parsedSize)
        ? Math.min(
            MAX_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE,
            Math.max(MIN_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE, parsedSize)
        )
        : DEFAULT_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE;

    return {
        enableContextMessageWindow: config.enableContextMessageWindow === true,
        contextMessageWindowSize
    };
}

/**
 * 选择发送给群成员模型的历史窗口。
 *
 * 该函数不会修改原数组，也不会影响持久化历史、瀑布流展示或话题总结。
 * “楼层”按历史消息条目计算，窗口始终保留最新的 N 条消息。
 */
function selectGroupContextHistory(groupHistory, groupConfig = {}) {
    const history = Array.isArray(groupHistory) ? groupHistory : [];
    const settings = normalizeGroupContextWindowSettings(groupConfig);
    if (!settings.enableContextMessageWindow || history.length <= settings.contextMessageWindowSize) {
        return history;
    }
    return history.slice(-settings.contextMessageWindowSize);
}

module.exports = {
    DEFAULT_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE,
    MIN_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE,
    MAX_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE,
    normalizeGroupContextWindowSettings,
    selectGroupContextHistory
};