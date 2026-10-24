import { createStableSpeechStream } from './streamSpeech.js';

/** One auxiliary window's live speech subscription. History/DOM replay never enters here. */
export function createStreamSpeechOwner({ document, render, speak, stop, resetPlayback, subscribeStop } = {}) {
    let current = null;
    let serial = 0;
    const cancel = messageId => {
        if (!current || (messageId && current.messageId !== messageId)) return;
        current.stream.cancel();
        current = null;
    };
    const unsubscribe = subscribeStop?.(() => cancel());
    function emit(blocks) {
        for (const block of blocks) {
            if (!current || !block.text.trim()) continue;
            speak(block.text, current.messageId, {
                speechStreamId: current.key,
                speechStreamFirst: !current.sent,
            });
            current.sent = true;
        }
    }
    return Object.freeze({
        begin(message) {
            if (current?.messageId === message.id && current.operationId === message.streamOperationId) return;
            cancel();
            resetPlayback?.();
            current = {
                messageId: message.id,
                operationId: message.streamOperationId,
                key: `${message.streamOperationId || message.id}:${++serial}`,
                sent: false,
                stream: createStableSpeechStream({ document, render }),
            };
        },
        append(messageId, delta, operationId) {
            if (!current || current.messageId !== messageId) return;
            if (current.operationId && operationId && current.operationId !== operationId) return;
            emit(current.stream.push(delta));
        },
        finish(messageId, reason, payload) {
            if (!current || current.messageId !== messageId) return;
            if (payload?.streamOperationId && current.operationId && payload.streamOperationId !== current.operationId) return;
            if (reason === 'completed' || reason === 'stop' || reason === 'length' || reason === 'end_turn') {
                emit(current.stream.finish(payload?.fullResponse));
                current = null;
            } else {
                cancel(messageId);
            }
        },
        cancel(messageId) { cancel(messageId); stop?.(); },
        dispose() { cancel(); unsubscribe?.(); },
    });
}