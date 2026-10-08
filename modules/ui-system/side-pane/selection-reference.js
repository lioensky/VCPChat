/* selection-reference.js
 * Selection snapshot capture, quota validation, and message provenance for Side Chat.
 */
'use strict';

export const MAX_SINGLE_REFERENCE_LENGTH = 8_000;
export const MAX_TOTAL_REFERENCE_LENGTH = 16_000;
export const MAX_REFERENCE_COUNT = 8;

/**
 * Captures current DOM selection within an authorized message bubble.
 * @param {Window} [windowRef=globalThis.window]
 * @returns {{ ok: true, reference: Object } | { ok: false, reason: string, message: string }}
 */
export function captureSelectionReference(windowRef = globalThis.window) {
    if (!windowRef?.getSelection) {
        return {
            ok: false,
            reason: 'SELECTION_API_UNAVAILABLE',
            message: 'Selection API is unavailable'
        };
    }

    const selection = windowRef.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return {
            ok: false,
            reason: 'EMPTY_SELECTION',
            message: '未选择任何文本'
        };
    }

    const text = selection.toString().trim();
    if (!text) {
        return {
            ok: false,
            reason: 'EMPTY_SELECTION',
            message: '所选文本为空'
        };
    }

    if (text.length > MAX_SINGLE_REFERENCE_LENGTH) {
        return {
            ok: false,
            reason: 'EXCEEDS_SINGLE_LIMIT',
            message: `选区长度 (${text.length}) 超过最大限制 (${MAX_SINGLE_REFERENCE_LENGTH})`
        };
    }

    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    const endNode = range.endContainer;

    const startElement = startNode.nodeType === 1 ? startNode : startNode.parentElement;
    const endElement = endNode.nodeType === 1 ? endNode : endNode.parentElement;

    const startMessageItem = startElement?.closest?.('.message-item');
    const endMessageItem = endElement?.closest?.('.message-item');

    if (!startMessageItem || !endMessageItem) {
        return {
            ok: false,
            reason: 'OUTSIDE_MESSAGE',
            message: '选区必须位于聊天消息正文内'
        };
    }

    // Both start and end must reside in the same message item if in message area
    if (startMessageItem !== endMessageItem) {
        return {
            ok: false,
            reason: 'CROSS_MESSAGE_SELECTION',
            message: '不支持跨多条消息的选区引用'
        };
    }

    const sourceMessageItem = startMessageItem;
    const sourceMessageId = sourceMessageItem?.getAttribute?.('data-message-id')
        || sourceMessageItem?.id
        || null;

    const reference = Object.freeze({
        id: `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        text,
        sourceMessageId,
        capturedAt: Date.now()
    });

    return { ok: true, reference };
}

/**
 * Validates adding a new reference into an existing reference array.
 * @param {Array<Object>} existingRefs
 * @param {Object} newRef
 * @returns {{ ok: true } | { ok: false, reason: string, message: string }}
 */
export function validateReferenceList(existingRefs = [], newRef) {
    if (!newRef || !newRef.text) {
        return { ok: false, reason: 'INVALID_REFERENCE', message: '引用内容无效' };
    }

    if (newRef.text.length > MAX_SINGLE_REFERENCE_LENGTH) {
        return {
            ok: false,
            reason: 'EXCEEDS_SINGLE_LIMIT',
            message: `选区长度 (${newRef.text.length}) 超过最大限制 (${MAX_SINGLE_REFERENCE_LENGTH})`
        };
    }

    if (existingRefs.length >= MAX_REFERENCE_COUNT) {
        return {
            ok: false,
            reason: 'EXCEEDS_COUNT_LIMIT',
            message: `引用条数已达上限 (${MAX_REFERENCE_COUNT})`
        };
    }

    const isDuplicate = existingRefs.some(r => {
        if (r.text !== newRef.text) return false;
        if (!r.sourceMessageId && !newRef.sourceMessageId) return true;
        return r.sourceMessageId === newRef.sourceMessageId;
    });
    if (isDuplicate) {
        return {
            ok: false,
            reason: 'DUPLICATE',
            message: '该文本引用已存在'
        };
    }

    const totalLength = existingRefs.reduce((acc, r) => acc + (r.text?.length || 0), 0) + newRef.text.length;
    if (totalLength > MAX_TOTAL_REFERENCE_LENGTH) {
        return {
            ok: false,
            reason: 'EXCEEDS_TOTAL_LIMIT',
            message: `引用总长度 (${totalLength}) 超过上限 (${MAX_TOTAL_REFERENCE_LENGTH})`
        };
    }

    return { ok: true };
}

const api = Object.freeze({
    MAX_SINGLE_REFERENCE_LENGTH,
    MAX_TOTAL_REFERENCE_LENGTH,
    MAX_REFERENCE_COUNT,
    captureSelectionReference,
    validateReferenceList
});

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSelectionReference = api;
}

export default api;
