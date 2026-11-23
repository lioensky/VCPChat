'use strict';

const CHAT_BODY_IDLE_MS = 300_000; // Node fetch / Undici default body idle budget.
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

let chatStreamDispatcher;
function getChatStreamDispatcher() {
    if (!chatStreamDispatcher) {
        const { Agent } = require('undici');
        const agent = new Agent();
        // fetch supplies its own bodyTimeout per dispatch, overriding Agent defaults.
        chatStreamDispatcher = {
            dispatch(options, handler) {
                return agent.dispatch({ ...options, bodyTimeout: 0 }, handler);
            },
        };
    }
    return chatStreamDispatcher;
}

module.exports = { createSleepStreamIdle, getChatStreamDispatcher, CHAT_BODY_IDLE_MS, MAX_SLEEP_MS };