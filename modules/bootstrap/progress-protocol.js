'use strict';

const PROGRESS_PROTOCOL_VERSION = 1;
const EVENT_TYPES = Object.freeze([
    'operation-started',
    'stage-started',
    'stage-output',
    'stage-completed',
    'operation-completed',
    'operation-failed',
    'operation-cancelled',
]);

function createProgressEvent({ type, operationId, stage = null, detail = null, now = new Date() } = {}) {
    if (!EVENT_TYPES.includes(type)) throw new TypeError(`Unsupported progress event type: ${type}`);
    if (!operationId) throw new TypeError('operationId is required');
    return {
        protocolVersion: PROGRESS_PROTOCOL_VERSION,
        type,
        operationId,
        stage,
        at: new Date(now).toISOString(),
        detail,
    };
}

function encodeProgressEvent(event) {
    return `${JSON.stringify(event)}\n`;
}

function parseProgressLine(line) {
    const event = JSON.parse(String(line));
    if (event.protocolVersion !== PROGRESS_PROTOCOL_VERSION || !EVENT_TYPES.includes(event.type)) {
        throw new Error('Unsupported Bootstrap progress frame.');
    }
    return event;
}

module.exports = {
    PROGRESS_PROTOCOL_VERSION,
    EVENT_TYPES,
    createProgressEvent,
    encodeProgressEvent,
    parseProgressLine,
};
