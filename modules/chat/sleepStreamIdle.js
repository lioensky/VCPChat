'use strict';

const CHAT_STREAM_TIMEOUT_MS = 500_000;
const CHAT_BODY_IDLE_MS = CHAT_STREAM_TIMEOUT_MS;
const SLEEP_WAKE_GRACE_MS = 75_000; // Leave room for tool return and the next model dispatch.
const MAX_SLEEP_MS = 12 * 60 * 60 * 1000;

function createSleepStreamIdle({
    idleMs = CHAT_BODY_IDLE_MS,
    wakeGraceMs = SLEEP_WAKE_GRACE_MS,
    now = () => performance.now(),
} = {}) {
    const controller = new AbortController();
    let timer;
    let quietUntil;
    let sleepUntil = 0;
    let closed = false;

    function arm() {
        clearTimeout(timer);
        if (closed || quietUntil === undefined || controller.signal.aborted) return;
        const left = Math.max(quietUntil, sleepUntil) - now();
        if (left <= 0) {
            const error = new Error('VCP 聊天流等待响应数据超时');
            error.name = 'TimeoutError';
            error.code = 'VCP_CHAT_BODY_IDLE_TIMEOUT';
            controller.abort(error);
            return;
        }
        timer = setTimeout(arm, Math.ceil(left));
        timer.unref?.();
    }

    return {
        signal: controller.signal,
        touch() {
            quietUntil = now() + idleMs;
            arm();
        },
        sleep(durationMs) {
            if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_SLEEP_MS) return;
            sleepUntil = Math.max(sleepUntil, now() + durationMs + wakeGraceMs);
            arm();
        },
        resume() {
            if (!sleepUntil) return;
            sleepUntil = 0;
            arm();
        },
        close() {
            closed = true;
            clearTimeout(timer);
        },
    };
}

let chatDispatchers;
function getChatStreamDispatcher({ hasBodyWatchdog = true } = {}) {
    if (!chatDispatchers) {
        const { Agent } = require('undici');
        const agent = new Agent();
        // Fetch supplies its own timeouts per dispatch. Override the header budget
        // and let the application watchdog handle streaming body timeouts and extensions.
        const makeDispatcher = overrides => ({
            dispatch(options, handler) {
                return agent.dispatch({ ...options, headersTimeout: CHAT_STREAM_TIMEOUT_MS, ...overrides }, handler);
            },
        });
        chatDispatchers = {
            stream: makeDispatcher({ bodyTimeout: 0 }),
            nonStream: makeDispatcher({}),
        };
    }
    return hasBodyWatchdog ? chatDispatchers.stream : chatDispatchers.nonStream;
}

module.exports = { createSleepStreamIdle, getChatStreamDispatcher, CHAT_STREAM_TIMEOUT_MS, CHAT_BODY_IDLE_MS, MAX_SLEEP_MS };