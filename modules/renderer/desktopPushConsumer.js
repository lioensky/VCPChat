const START_TAG = '<<<[DESKTOP_PUSH]>>>';
const END_TAG = '<<<[DESKTOP_PUSH_END]>>>';
const VALID_PREFIXES = ['<!doctype', '<div', '<section', '<article', '<main', '<header', '<nav', '<aside', '<canvas', '<svg', '<style', 'target:', '<!--'];

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

    const send = payload => {
        if (disposed || !connected || typeof electronAPI?.desktopPush !== 'function') return;
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
            };
            states.set(messageId, state);
        }

        let outputText = '';
        for (const char of textToAppend) {
            if (!state.active) {
                state.tagBuffer += char;
                if (START_TAG.startsWith(state.tagBuffer)) {
                    if (state.tagBuffer === START_TAG) {
                        const precedingChar = outputText.length > 0 ? outputText[outputText.length - 1] : '';
                        if (precedingChar === '`') {
                            state.backtickContext = true;
                            outputText += state.tagBuffer;
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
                    outputText += state.tagBuffer;
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
                        send({ action: 'finalize', widgetId: state.widgetId });
                    }
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
                        send({ action: 'create', widgetId: state.widgetId, options: { x: 200, y: 150, width: 400, height: 300 } });
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
