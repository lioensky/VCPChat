import { TOOL_RESULT_START_MARKER, TOOL_RESULT_END_MARKER } from './toolResultRegions.js';

const START_TAG = '<<<[DESKTOP_PUSH]>>>';
const END_TAG = '<<<[DESKTOP_PUSH_END]>>>';
const VALID_PREFIXES = ['<!doctype', '<div', '<section', '<article', '<main', '<header', '<nav', '<aside', '<canvas', '<svg', '<style', 'target:', '<!--'];
const TOOL_RESULT_WINDOW_LENGTH = Math.max(TOOL_RESULT_START_MARKER.length, TOOL_RESULT_END_MARKER.length);

/**
 * 工具结果是后端注入的数据域，优先级高于 DESKTOP_PUSH。
 * 其内部出现的推送标记（例如工具读取的文件、网页里恰好含有该语法）只是数据，
 * 绝不能真的推送到桌面画布。逐字符维护一个标记长度的滑动窗口，
 * 可识别被网络分片切开的起止标记。两种标记不共享首字符（`[` vs `<`），
 * 因此不会与推送标签的前缀缓冲产生竞争。
 *
 * 嵌套感知（与 toolResultRegions.findToolResultEnd 同一规则）：起始标记深度 +1，
 * 结束标记深度 -1，深度回到 0 才离开区间；深度为 0 时的孤立结束标记忽略。
 */
function trackToolResultChar(state, char) {
    state.toolResultWindow = (state.toolResultWindow + char).slice(-TOOL_RESULT_WINDOW_LENGTH);
    if (state.toolResultWindow.endsWith(TOOL_RESULT_START_MARKER)) {
        state.toolResultDepth += 1;
        // 清空窗口：同一段字符不会被重复计数。
        state.toolResultWindow = '';
    } else if (state.toolResultDepth > 0 && state.toolResultWindow.endsWith(TOOL_RESULT_END_MARKER)) {
        state.toolResultDepth -= 1;
        state.toolResultWindow = '';
    }
}

/**
 * Owns the Desktop canvas subscription and every timer created while consuming
 * stream tokens. The stream projection only supplies tokens and releases a
 * message lease; it never owns Desktop IPC lifecycle state.
 */
export function createDesktopPushConsumer({
    electronAPI,
    scheduler = globalThis,
    now = () => Date.now(),
    createWidgetId = () => `dw-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`,
    logger = console,
    throttleMs = 100,
    timeoutMs = 150_000,
} = {}) {
    const states = new Map();
    let connected = false;
    let disposed = false;
    let unsubscribe = null;

    const resetState = state => {
        state.active = false;
        state.tagBuffer = '';
        state.buffer = '';
        state.widgetId = null;
        state.created = false;
        state.validated = false;
        state.isReplaceMode = false;
        state.lastPushedLength = 0;
        state.lastTokenTime = null;
    };

    const stopTimer = state => {
        if (!state) return;
        state.timerGeneration += 1;
        if (!state.pushTimer) return;
        scheduler.clearInterval(state.pushTimer);
        state.pushTimer = null;
    };

    const send = (payload, force = false) => {
        if (disposed || (!connected && !force) || typeof electronAPI?.desktopPush !== 'function') return;
        electronAPI.desktopPush(payload);
    };

    const start = () => {
        if (disposed || unsubscribe || typeof electronAPI?.onDesktopStatus !== 'function') return;
        const release = electronAPI.onDesktopStatus(data => {
            if (disposed) return;
            connected = !!data?.connected;
            logger.log?.(`[DesktopPush] Desktop window availability changed: ${connected}`);
        });
        unsubscribe = typeof release === 'function' ? release : () => {};
    };

    const processToken = (messageId, textToAppend) => {
        if (disposed || !messageId || typeof textToAppend !== 'string') return textToAppend || '';

        let state = states.get(messageId);
        if (!state) {
            state = {
                active: false,
                widgetId: null,
                buffer: '',
                tagBuffer: '',
                created: false,
                validated: false,
                pushTimer: null,
                lastPushedLength: 0,
                lastTokenTime: null,
                backtickContext: false,
                isReplaceMode: false,
                revoked: false,
                timerGeneration: 0,
                toolResultDepth: 0,
                toolResultWindow: '',
            };
            states.set(messageId, state);
        }

        let outputText = '';
        // 所有流向聊天气泡的正文字符都经过这里，以便追踪工具结果区间。
        const emit = (text) => {
            outputText += text;
            for (const emittedChar of text) trackToolResultChar(state, emittedChar);
        };

        for (const char of textToAppend) {
            if (!state.active && state.toolResultDepth > 0) {
                // 工具结果数据域内不识别任何推送标签。
                emit(char);
                continue;
            }

            if (!state.active) {
                state.tagBuffer += char;
                if (START_TAG.startsWith(state.tagBuffer)) {
                    if (state.tagBuffer === START_TAG) {
                        const precedingChar = outputText.length > 0 ? outputText[outputText.length - 1] : '';
                        if (precedingChar === '`') {
                            state.backtickContext = true;
                            emit(state.tagBuffer);
                            state.tagBuffer = '';
                            continue;
                        }
                        state.active = true;
                        state.backtickContext = false;
                        state.widgetId = createWidgetId();
                        state.buffer = '';
                        state.created = false;
                        state.validated = false;
                        state.tagBuffer = '';
                        state.lastPushedLength = 0;
                    }
                } else {
                    emit(state.tagBuffer);
                    state.tagBuffer = '';
                }
                continue;
            }

            state.tagBuffer += char;
            if (END_TAG.startsWith(state.tagBuffer)) {
                if (state.tagBuffer !== END_TAG) continue;

                stopTimer(state);
                if (state.created) {
                    if (state.isReplaceMode) {
                        const targetMatch = state.buffer.match(/target:(?:「始ESCAPE」([\s\S]*?)「末ESCAPE」|「始」([\s\S]*?)「末」)/);
                        const replaceMatch = state.buffer.match(/replace:(?:「始ESCAPE」([\s\S]*?)「末ESCAPE」|「始」([\s\S]*?)「末」)/);
                        if (targetMatch && replaceMatch) {
                            const targetSelector = (targetMatch[1] || targetMatch[2] || '').trim();
                            const replaceContent = (replaceMatch[1] || replaceMatch[2] || '').trim();
                            send({ action: 'replace', targetSelector, content: replaceContent });
                        } else {
                            logger.warn?.('[DesktopPush] Replace block was missing target/replace fields.');
                        }
                    } else {
                        send({ action: 'append', widgetId: state.widgetId, content: state.buffer });
                        send({ action: 'finalize', widgetId: state.widgetId, content: state.buffer });
                    }
                } else if (!state.isReplaceMode && state.validated && state.buffer.trim().length > 0) {
                    send({ action: 'finalize', widgetId: state.widgetId, content: state.buffer, offline: true }, true);
                }
                resetState(state);
                continue;
            }

            state.buffer += state.tagBuffer;
            state.tagBuffer = '';
            state.lastTokenTime = now();

            if (!state.validated && state.buffer.trim().length >= 5) {
                const trimmedBuffer = state.buffer.trim().toLowerCase();
                const isValid = VALID_PREFIXES.some(prefix => trimmedBuffer.startsWith(prefix));
                if (isValid) {
                    state.validated = true;
                    state.isReplaceMode = trimmedBuffer.startsWith('target:');
                    state.created = state.isReplaceMode
                        || (connected && typeof electronAPI?.desktopPush === 'function');

                    if (!state.isReplaceMode && state.created) {
                        // 关键重构：在线创建挂件时不传硬编码固定坐标 x/y，让画布端 widgetManager 的响应式多列网格算法自动计算错落排布！
                        send({ action: 'create', widgetId: state.widgetId, options: { width: 340, height: 220 } });
                    }

                    if (connected && typeof electronAPI?.desktopPush === 'function') {
                        const interval = state.isReplaceMode ? 5000 : throttleMs;
                        const timerGeneration = ++state.timerGeneration;
                        state.pushTimer = scheduler.setInterval(() => {
                            if (disposed || state.revoked || state.timerGeneration !== timerGeneration) return;
                            if (!state.isReplaceMode && state.buffer.length > state.lastPushedLength) {
                                send({ action: 'append', widgetId: state.widgetId, content: state.buffer });
                                state.lastPushedLength = state.buffer.length;
                            }
                            if (!state.lastTokenTime || now() - state.lastTokenTime <= timeoutMs) return;

                            stopTimer(state);
                            if (!state.isReplaceMode && state.created) {
                                send({ action: 'append', widgetId: state.widgetId, content: state.buffer });
                                send({ action: 'finalize', widgetId: state.widgetId });
                            }
                            resetState(state);
                        }, interval);
                    }
                } else if (state.buffer.trim().length >= 30) {
                    logger.warn?.(`[DesktopPush] Invalid content prefix, discarding push block: "${trimmedBuffer.substring(0, 30)}..."`);
                    stopTimer(state);
                    resetState(state);
                }
            }
        }
        return outputText;
    };

    const cleanupMessage = messageId => {
        const state = states.get(messageId);
        if (state) state.revoked = true;
        stopTimer(state);
        states.delete(messageId);
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        try {
            unsubscribe?.();
        } catch (error) {
            logger.warn?.('[DesktopPush] Status unsubscribe failed during dispose.', error);
        }
        unsubscribe = null;
        connected = false;
        for (const state of states.values()) {
            state.revoked = true;
            stopTimer(state);
        }
        states.clear();
    };

    return Object.freeze({
        start,
        processToken,
        cleanupMessage,
        dispose,
        getStateCount: () => states.size,
    });
}
