import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { tokenizeVcpDocument } from '../modules/renderer/vcpDocumentScanner.js';

// Test-only probes follow the stable-boundary tests; production exposes no
// mutable runtime or frame API. Frames are driven manually, without timing races.
const moduleUrl = new URL('../modules/renderer/streamManager.js', import.meta.url);
let source = fs.readFileSync(moduleUrl, 'utf8');
source = source.replace(/from\s+(['"])(\.[^'"]+)\1/g,
    (_, quote, relative) => `from ${quote}${new URL(relative, moduleUrl).href}${quote}`);
source = source.replace(/    attachStreamProjection,\r?\n/,
    '    probeFrame: renderStreamFrame,\n    probeState: getOrCreateStreamSegmentState,\n    attachStreamProjection,\n');
const { createStreamProjection } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

async function fixture({ smooth = false, seed = '' } = {}) {
    const dom = new JSDOM('<!doctype html><div id="chat"></div>', {
        url: 'https://vcpchat.local/', pretendToBeVisual: true,
    });
    const root = dom.window.document.getElementById('chat');
    let scopeSequence = 0;
    let extractions = 0;
    let cleanups = 0;
    let frameSequence = 0;
    dom.window.requestAnimationFrame = () => ++frameSequence;
    dom.window.cancelAnimationFrame = () => {};
    const publications = [];
    const renderMessage = message => {
        const item = dom.window.document.createElement('article');
        item.className = 'message-item';
        item.dataset.messageId = message.id;
        item.id = `scope-${++scopeSequence}`;
        item.innerHTML = '<div class="md-content"></div>';
        root.append(item);
        return item;
    };
    const projection = createStreamProjection();
    projection.attachStreamProjection({
        window: dom.window, document: dom.window.document, chatMessagesDiv: root,
        currentSelectedItemRef: { get: () => ({ id: 'agent', type: 'agent' }) },
        currentTopicIdRef: { get: () => 'topic' },
        globalSettingsRef: { get: () => ({ enableSmoothStreaming: smooth }) },
        viewAuthority: { isCurrent: () => true },
        transientStreamHistory: {
            async prepare() {},
            async finalize({ messageId, content }) {
                return { message: { id: messageId, role: 'assistant', content }, history: [] };
            },
            discard() {}, dispose() {},
        },
        electronAPI: { onDesktopStatus: () => () => {} },
        uiHelper: { scrollToBottom() {} },
        renderMessage,
        processAssistantScopedHtmlContent(text, scopeId, _item, options) {
            extractions++;
            return tokenizeVcpDocument(text, { mode: options.mode || 'final' }).map(region => {
                const raw = text.slice(region.start, region.end);
                if (region.kind !== 'style' || !region.closed) return raw;
                options.cssChunks.push(`${scopeId}:${raw}`);
                return '<!-- extracted -->';
            }).join('');
        },
        updateStreamScopedCss(chunks, scopeId, item) {
            publications.push({ chunks: [...chunks], scopeId, item });
        },
        cleanupStreamContent() { cleanups++; },
        parseTail: text => text,
        parseFull: text => text,
        async renderPostProcessedHtml(content, html) { content.textContent = html; },
    });
    const message = {
        id: 'stream', role: 'assistant', content: seed,
        agentId: 'agent', topicId: 'topic', streamOperationId: 'operation',
    };
    await projection.startStreamingMessage(message);
    return {
        projection, root, message, publications,
        state: () => projection.probeState(message.id),
        frame: () => projection.probeFrame(message.id),
        append: text => projection.appendStreamChunk(message.id, { content: text }, message, message.streamOperationId),
        extractionCount: () => extractions,
        cleanupCount: () => cleanups,
        async dispose() { await projection.dispose(); dom.window.close(); },
    };
}

test('unchanged stable CSS skips publication on growing prose and duplicate frames', async () => {
    const f = await fixture();
    try {
        f.append('<style>.stable { width: 1px; }</style>');
        f.frame();
        assert.equal(f.publications.length, 1);
        const extractionCount = f.extractionCount();
        for (const text of ['prose', ' more', ' text']) {
            f.append(text);
            f.frame();
        }
        assert.ok(f.extractionCount() > extractionCount, 'extraction still runs on changing source');
        assert.equal(f.publications.length, 1, 'unchanged CSS must not reach the publisher');
        const before = f.state().boundaryScanner.getDiagnostics();
        f.frame();
        f.frame();
        const after = f.state().boundaryScanner.getDiagnostics();
        assert.equal(f.publications.length, 1);
        assert.equal(after.scans, before.scans);
        assert.equal(after.hits, before.hits + 2);
        assert.equal(after.prefixChecks, 0, 'production frame uses owner-issued append identity');
    } finally { await f.dispose(); }
});

test('unchanged CSS inside an unfinished HTML island skips publication, not extraction', async () => {
    const f = await fixture();
    try {
        f.append('<div><style>.tail { width: 2px; }</style>unfinished');
        f.frame();
        assert.equal(f.state().stableCutoff, 0);
        assert.equal(f.publications.length, 1);
        const before = f.extractionCount();
        f.append(' more');
        f.frame();
        assert.equal(f.publications.length, 1);
        assert.equal(f.extractionCount(), before + 1);
        f.append('</div>');
        f.frame();
        assert.ok(f.state().stableCutoff > 0);
        assert.equal(f.publications.length, 2);
        assert.equal(f.publications.at(-1).chunks.length, 1, 'tail-to-stable migration must not duplicate CSS');
    } finally { await f.dispose(); }
});

test('new stable styles publish with an unchanged empty tail and retain source order', async () => {
    const f = await fixture();
    try {
        for (const name of ['first', 'second']) {
            f.append(`<style>.${name} { width: 3px; }</style>`);
            f.frame();
        }
        assert.equal(f.publications.length, 2);
        assert.equal(f.state().lastRenderedTailText, '');
        assert.match(f.publications[1].chunks[0], /\.first/);
        assert.match(f.publications[1].chunks[1], /\.second/);
        f.frame();
        assert.equal(f.publications.length, 2);
    } finally { await f.dispose(); }
});

test('source replacement changes the append epoch and revokes old CSS before new projection', async () => {
    const f = await fixture();
    try {
        f.append('<style>.old { width: 4px; }</style>');
        f.frame();
        const epoch = f.state().sourceEpoch;
        const corrected = 'corrected '.repeat(20) + '\n\nB\n\nC';
        await f.projection.startStreamingMessage({ ...f.message, content: corrected, isThinking: true });
        assert.notEqual(f.state().sourceEpoch, epoch);
        f.frame();
        assert.deepEqual(f.publications.at(-1).chunks, []);
        assert.equal(f.publications.length, 2, 'replacement clears old CSS once, without an extra unchanged publish');
        assert.equal(f.cleanupCount(), 1);
        assert.equal(f.state().boundaryScanner.getDiagnostics().revisions, 1);
        assert.equal(f.state().boundaryScanner.getDiagnostics().prefixChecks, 0);
        assert.match(f.root.textContent, /corrected/);
        f.append(' more');
        f.frame();
        assert.equal(f.publications.length, 2);
    } finally { await f.dispose(); }
});

test('DOM recreation forces CSS publication for the new scope without source prefix validation', async () => {
    const f = await fixture();
    try {
        f.append('<style>.restored { width: 5px; }</style>');
        f.frame();
        const oldPublication = f.publications.at(-1);
        const epoch = f.state().sourceEpoch;
        f.root.replaceChildren();
        await f.projection.reconcileConversation({ itemType: 'agent', itemId: 'agent', topicId: 'topic' });
        const current = f.publications.at(-1);
        assert.equal(f.publications.length, 2);
        assert.notEqual(current.item, oldPublication.item);
        assert.notEqual(current.scopeId, oldPublication.scopeId);
        assert.ok(current.chunks.every(css => css.startsWith(current.scopeId + ':')));
        assert.equal(f.state().sourceEpoch, epoch, 'DOM recovery is not a source replacement');
        assert.equal(f.state().boundaryScanner.getDiagnostics().prefixChecks, 0);
        f.frame();
        assert.equal(f.publications.length, 2);
    } finally { await f.dispose(); }
});

test('smooth visible rollback invalidates the cutoff but later expansion retains append trust', async () => {
    const f = await fixture({ smooth: true, seed: 'A\n\nB\n\nC' });
    try {
        f.frame();
        assert.equal(f.state().stableCutoff, 3);
        const epoch = f.state().sourceEpoch;
        f.state().visibleTextLength = 1;
        f.frame();
        assert.equal(f.state().stableCutoff, 0);
        assert.equal(f.cleanupCount(), 1);
        assert.equal(f.root.textContent, 'A');
        f.state().visibleTextLength = f.message.content.length;
        f.frame();
        assert.equal(f.state().stableCutoff, 3);
        assert.equal(f.state().sourceEpoch, epoch);
        assert.equal(f.state().boundaryScanner.getDiagnostics().prefixChecks, 0);
        assert.equal(f.state().boundaryScanner.getDiagnostics().revisions, 1);
    } finally { await f.dispose(); }
});

test('stable and tail CSS keep source order when the tail becomes stable', async () => {
    const f = await fixture();
    try {
        f.append('<style>.first { width: 1px; }</style>');
        f.frame();
        f.append('\n<div><style>.second { width: 2px; }</style>unfinished');
        f.frame();
        assert.equal(f.publications.at(-1).chunks.length, 2);
        assert.match(f.publications.at(-1).chunks[0], /\.first/);
        assert.match(f.publications.at(-1).chunks[1], /\.second/);
        f.append('</div>');
        f.frame();
        assert.equal(f.publications.at(-1).chunks.length, 2);
        assert.match(f.publications.at(-1).chunks[0], /\.first/);
        assert.match(f.publications.at(-1).chunks[1], /\.second/);
        const count = f.publications.length;
        f.append(' plain continuation');
        f.frame();
        assert.equal(f.publications.length, count);
    } finally { await f.dispose(); }
});

test('a recreated DOM owner forces publication even when it retains the scope id', async () => {
    const f = await fixture();
    try {
        f.append('<style>.same-scope { width: 6px; }</style>');
        f.frame();
        const old = f.publications.at(-1);
        f.root.innerHTML = f.root.innerHTML;
        f.frame();
        const current = f.publications.at(-1);
        assert.equal(f.publications.length, 2);
        assert.equal(current.scopeId, old.scopeId);
        assert.notEqual(current.item, old.item);
        assert.equal(current.item.isConnected, true);
        assert.deepEqual(current.chunks, old.chunks);
        f.frame();
        assert.equal(f.publications.length, 2);
    } finally { await f.dispose(); }
});