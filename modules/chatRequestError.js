'use strict';

function readStatus(value) {
    return Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function describeChatRequestError(payload, httpStatus, fallback = '服务端未提供错误说明') {
    const nested = payload?.error;
    const status = readStatus(httpStatus) ?? readStatus(nested?.status) ?? readStatus(payload?.status);
    const detail = [nested?.message, payload?.message, nested, payload]
        .find(value => typeof value === 'string' && value.trim() && value.trim() !== '[object Object]');
    const message = (detail || fallback).replace(/\s+/g, ' ').trim().slice(0, 240);
    return status ? { error: `HTTP ${status}：${message}`, status } : { error: message };
}

async function readChatHttpError(response) {
    let payload;
    try {
        payload = JSON.parse(await response.text());
    } catch {
        // An HTML error page or unreadable body should not replace the HTTP status.
    }
    return describeChatRequestError(payload, response.status);
}

/**
 * The server refused the request before sending it upstream because it exceeds the context
 * limit. On a stream this arrives as a normal-looking chunk; it is an error, not a reply.
 * (A tool loop stopped half-way carries stage 'tool_loop' and stays part of the reply.)
 */
function contextBudgetRefusal(payload) {
    if (payload?.vcp_context_budget?.stage !== 'outbound') return null;
    const text = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content;
    const message = typeof text === 'string' && text.trim()
        ? text.replace(/^\s*\[ERROR\]\s*/, '').trim()
        : '请求超过上下文上限，未发送给模型。';
    return Object.assign(new Error(message), { isChatResponseError: true, isContextBudgetRefusal: true });
}

function chatResponseError(payload) {
    const refusal = contextBudgetRefusal(payload);
    if (refusal) return refusal;
    if (!payload?.error) return null;
    const failure = describeChatRequestError(payload);
    return Object.assign(new Error(failure.error), { status: failure.status, isChatResponseError: true });
}

module.exports = { describeChatRequestError, readChatHttpError, chatResponseError };