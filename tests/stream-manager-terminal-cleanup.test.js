'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('modules/renderer/streamManager.js', 'utf8');

function functionBody(name, nextExport) {
    const start = source.indexOf(`export async function ${name}`);
    const end = source.indexOf(nextExport, start);
    assert.notEqual(start, -1, `${name} export is missing`);
    assert.notEqual(end, -1, `${name} boundary is missing`);
    return source.slice(start, end);
}

test('stream initialization discards owned state on background history and render failures', () => {
    const body = functionBody('startStreamingMessage', 'export function appendStreamChunk');
    assert.match(
        body,
        /Could not load history for background message[\s\S]*?discardStreamingMessage\(messageId\);[\s\S]*?return null;/,
    );
    assert.match(
        body,
        /Failed to render message item[\s\S]*?discardStreamingMessage\(messageId\);[\s\S]*?return null;/,
    );
});

test('stream finalization discards owned state on every unrecoverable lookup failure', () => {
    const body = functionBody('finalizeStreamedMessage', 'export function discardStreamingMessage');
    for (const marker of [
        'No context available for message',
        'Could not load history for finalization',
        'not found in assistant history',
        'not found in history',
    ]) {
        const markerIndex = body.indexOf(marker);
        assert.notEqual(markerIndex, -1, `missing terminal branch: ${marker}`);
        const terminalWindow = body.slice(markerIndex, markerIndex + 420);
        assert.match(terminalWindow, /discardStreamingMessage\(messageId\);[\s\S]*?return;/, `${marker} does not release stream state`);
    }
});

test('discardStreamingMessage releases every strong stream owner', () => {
    const start = source.indexOf('export function discardStreamingMessage');
    const end = source.indexOf('export function cleanupTransientState', start);
    const body = source.slice(start, end);
    for (const owner of [
        'streamingChunkQueues',
        'streamingTimers',
        'pendingDirectRenderMessages',
        'accumulatedStreamText',
        'streamSegmentStates',
        'messageDomCache',
        'preBufferedChunks',
        'messageInitializationStatus',
        'pendingFinalizationEvents',
        'pendingHistoryEntries',
        'messageContextMap',
        'viewContextCache',
    ]) {
        assert.match(body, new RegExp(`${owner}\\.delete\\(messageId\\)`), `${owner} is not released`);
    }
    assert.match(body, /cleanupDesktopPushState\(messageId\)/);
    assert.match(body, /updateSendButtonState/);
});

test('a runtime background-history failure releases every stream owner', async () => {
    const dom = new JSDOM('<!doctype html><div id="chat"></div>', {
        runScripts: 'outside-only',
        url: 'https://vcpchat.local/',
    });
    const executableSource = source
        .replace(/^import .*;$/gm, '')
        .replace(/\bexport\s+(?=(?:async\s+)?function\b)/g, '');
    dom.window.formatMessageTimestamp = () => 'now';
    dom.window.PIPELINE_MODES = { STREAM_FAST: 'stream-fast' };
    dom.window.createContentPipeline = () => ({ process: text => ({ text }) });
    dom.window.updateSendButtonState = () => {};
    dom.window.eval(`
        const formatMessageTimestamp = window.formatMessageTimestamp;
        const PIPELINE_MODES = window.PIPELINE_MODES;
        const createContentPipeline = window.createContentPipeline;
        ${executableSource}
    `);

    const history = [];
    const selected = { id: 'visible-agent', type: 'agent' };
    const api = dom.window.streamManager;
    api.initStreamManager({
        electronAPI: {
            getChatHistory: async () => { throw new Error('controlled history failure'); },
        },
        currentSelectedItemRef: { get: () => selected },
        currentTopicIdRef: { get: () => 'visible-topic' },
        currentChatHistoryRef: { get: () => history, set() {} },
        globalSettingsRef: { get: () => ({ enableSmoothStreaming: false }) },
        chatMessagesDiv: dom.window.document.getElementById('chat'),
        renderMessage: () => null,
        uiHelper: {},
    });

    api.appendStreamChunk('background-message', { content: 'buffered-before-init' }, {
        agentId: 'background-agent',
        topicId: 'background-topic',
    });
    await api.startStreamingMessage({
        id: 'background-message',
        agentId: 'background-agent',
        topicId: 'background-topic',
        content: '',
    });

    assert.deepEqual({ ...api.getDiagnostics() }, {
        activeMessageId: null,
        initialization: 0,
        activeInitializations: 0,
        contexts: 0,
        pendingHistory: 0,
        prebuffered: 0,
        pendingFinalizations: 0,
        chunkQueues: 0,
        renderTimers: 0,
        delayedCleanupTimers: 0,
        historySaveQueue: 0,
        desktopPushStates: 0,
    });
    dom.window.close();
});
