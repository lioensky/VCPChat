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

function chatResponseError(payload) {
    if (!payload?.error) return null;
    const failure = describeChatRequestError(payload);
    return Object.assign(new Error(failure.error), { status: failure.status, isChatResponseError: true });
}

module.exports = { describeChatRequestError, readChatHttpError, chatResponseError };