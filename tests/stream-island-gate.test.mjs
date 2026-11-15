import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createStreamIslandGate } from '../modules/renderer/streamIslandGate.js';

function gateFixture() {
    const gate = createStreamIslandGate();
    let source = '';
    const epoch = {};
    const owner = {};
    return {
        append(text, now = 0) {
            source += text;
            return gate.update(source, { epoch, owner, now });
        },
        update(now) { return gate.update(source, { epoch, owner, now }); },
    };
}

test('leading commit, 650ms deadline, leaf close and root close bypass cooldown', () => {
    const f = gateFixture();
    assert.equal(f.append('<div class="card">', 0).commit, true);
    assert.equal(f.append('\n<div>long', 20).commit, false);
    assert.equal(f.append(' text', 200).delay, 450);
    assert.equal(f.update(649).commit, false);
    assert.equal(f.update(650).commit, true);
    assert.equal(f.append('</div>', 651).commit, true);
    assert.equal(f.append('\n<div>second', 652).commit, false);
    assert.equal(f.append('</div>', 653).commit, true);
    assert.equal(f.append('\n</div>', 654).commit, true);
    assert.equal(f.append('\nordinary prose', 655).commit, true);
    assert.equal(f.append(' more', 656).active, false);
});

test('parent close is not a leaf close, but root completion always flushes', () => {
    const f = gateFixture();
    f.append('<div>\n<div>\n<div>leaf');
    assert.equal(f.append('</div>', 1).commit, true);
    assert.equal(f.append('</div>', 2).commit, false);
    assert.equal(f.append('\n</div>', 3).commit, true);
});

test('split opening attributes, comments and raw-text closers retain structure', () => {
    const f = gateFixture();
    assert.equal(f.append('<di').active, false);
    assert.equal(f.append('v data-label=">').active, false);
    assert.equal(f.append('">').active, true);
    f.append('<!-- </div>');
    assert.equal(f.append(' -->\n<div>leaf', 10).commit, false);
    assert.equal(f.append('</div>', 11).commit, true);
    const script = f.append('<script>const literal = "</div>";', 700);
    assert.equal(script.length, '<div data-label=">"><!-- </div> -->\n<div>leaf</div>'.length);
    assert.equal(f.append('requestAnimationFrame(frame);', 1500).commit, false);
    assert.equal(f.append('</scr', 1600).commit, false);
    assert.equal(f.append('ipt          ', 1700).commit, false);
    assert.equal(f.append('>', 1701).commit, true);
    assert.equal(f.append('\n</div>', 1702).active, false);
});

test('unclosed style is excluded from committed prefix and closing it forces a commit', () => {
    const f = gateFixture();
    const leading = f.append('<div><style>.card {');
    assert.equal(leading.commit, true);
    assert.equal(leading.length, 5);
    assert.equal(f.append(' color: red;', 700).commit, false);
    assert.equal(f.append(' }</style>', 701).commit, true);
});

test('only zero-indent div candidates in nonopaque source activate throttling', () => {
    const excluded = [
        ' <div>text', '\t<div>text', 'text <div>text', '<division>text',
        '```html\n<div>text', '~~~html\n<div>text',
        '`example\n<div>text',
        '<!-- example\n<div>text',
        '<script>\n<div>text', '<style>\n<div>text',
        '<pre>\n<div>text', '<code>\n<div>text', '<textarea>\n<div>text',
        '<title>\n<div>text', 'text\r<div>text',
        '<<<[TOOL_REQUEST]>>>\n<div>text',
        '[[VCP调用结果信息汇总:\n<div>text',
        '<<<[DESKTOP_PUSH]>>>\n<div>text',
        '<think>\n<div>text',
        '「始ESCAPE」\n<div>text',
        '{始}\n<div>text',
        '<<<[ROLE_DIVIDE_USER]>>>\n<div>text',
    ];
    for (const source of excluded) {
        const f = gateFixture();
        assert.equal(f.append(source).active, false, source);
        assert.equal(f.append(' more', 1).commit, true, source);
    }
    const f = gateFixture();
    assert.equal(f.append('```html\n<div>example</div>\n```\n\n<div>real').active, true);
});

test('multiple cards in one update flush and never reactivate a previously closed root', () => {
    const f = gateFixture();
    assert.equal(f.append('<div>a</div>\n<div>b</div>').commit, true);
    assert.equal(f.append(' suffix', 1).active, false);
    assert.equal(f.append('\n<div>c', 2).active, true);
    assert.equal(f.append(' growing', 3).commit, false);
});

test('source replacement, visible rollback and DOM recreation force a fresh projection', () => {
    const gate = createStreamIslandGate();
    const epoch = {};
    const owner = {};
    gate.update('<div>old text', { epoch, owner, now: 0 });
    assert.equal(gate.update('<div>old text more', { epoch, owner, now: 1 }).commit, false);
    assert.equal(gate.update('<div>old text more', { epoch, owner: {}, now: 2 }).commit, true);
    assert.equal(gate.update('<div>', { epoch, owner, now: 3 }).commit, true);
    assert.equal(gate.update('replacement', { epoch: {}, owner, now: 4 }).active, false);
});

test('tag literals in island code domains neither close divs nor freeze commits', () => {
    for (const [opening, closing] of [
        ['```html\n', '\n```\n'],
        ['~~~html\n', '\n~~~\n'],
        ['`', '`'],
        ['<pre>', '</pre>'],
        ['<code>', '</code>'],
        ['<textarea>', '</textarea>'],
    ]) {
        const f = gateFixture();
        f.append('<div>\n');
        f.append(opening + '<script><style></div>', 1);
        const tick = f.update(650);
        assert.equal(tick.commit, true, opening);
        assert.equal(tick.length, ('<div>\n' + opening + '<script><style></div>').length, opening);
        const end = f.append(closing + '\n<div>leaf</div>', 651);
        assert.equal(end.active, true, opening);
        assert.equal(end.commit, true, opening);
        assert.equal(f.append('\n</div>', 652).active, false, opening);
    }
});

test('style and script outside cards remain ordinary unthrottled source', () => {
    for (const tag of ['style', 'script']) {
        const f = gateFixture();
        const source = `<${tag}>unfinished`;
        assert.equal(f.append(source).length, source.length);
        const next = f.append(' more', 1);
        assert.equal(next.commit, true);
        assert.equal(next.length, source.length + 5);
    }
});

test('every character split retains raw-text isolation and releases the root', () => {
    const f = gateFixture();
    const source = '<div class="card">\n<div>leaf</div>\n<script>const x = "</div>";</script>\n</div>\ntext';
    let visible = '';
    for (let index = 0; index < source.length; index++) {
        visible += source[index];
        const result = f.append(source[index], index * 10);
        const scriptStart = visible.indexOf('<script>');
        if (scriptStart >= 0 && !visible.includes('</script>')) {
            assert.ok(result.length <= scriptStart, 'partial script must not enter the committed prefix');
        }
    }
    assert.equal(f.append(' ordinary', 1000).active, false);
});

test('oversized or excessively nested islands fail open instead of locking prose', () => {
    const oversized = gateFixture();
    oversized.append('<div>');
    assert.equal(oversized.append('x'.repeat(256 * 1024), 1).active, false);
    const deep = gateFixture();
    assert.equal(deep.append('<div>'.repeat(130), 1).active, false);
});

const moduleUrl = new URL('../modules/renderer/streamManager.js', import.meta.url);
let source = fs.readFileSync(moduleUrl, 'utf8');
source = source.replace(/from\s+(['"])(\.[^'"]+)\1/g,
    (_, quote, relative) => `from ${quote}${new URL(relative, moduleUrl).href}${quote}`);
source = source.replace(/    attachStreamProjection,\r?\n/,
    '    probeFrame: renderStreamFrame,\n    probeState: getOrCreateStreamSegmentState,\n    attachStreamProjection,\n');
const { createStreamProjection } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

async function projectionFixture(t, { smooth = false } = {}) {
    const dom = new JSDOM('<!doctype html><div id="chat"></div>', {
        url: 'https://vcpchat.local/', pretendToBeVisual: true,
    });
    const root = dom.window.document.getElementById('chat');
    let now = 0;
    let timerId = 0;
    let parses = 0;
    const timers = new Map();
    t.mock.method(Date, 'now', () => now);
    dom.window.requestAnimationFrame = () => 1;
    dom.window.cancelAnimationFrame = () => {};
    dom.window.setTimeout = (callback, delay) => {
        timers.set(++timerId, { callback, due: now + delay });
        return timerId;
    };
    dom.window.clearTimeout = id => timers.delete(id);
    const projection = createStreamProjection();
    projection.attachStreamProjection({
        window: dom.window, document: dom.window.document, chatMessagesDiv: root,
        currentSelectedItemRef: { get: () => ({ id: 'agent' }) },
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
        renderMessage(message) {
            const item = dom.window.document.createElement('article');
            item.className = 'message-item';
            item.dataset.messageId = message.id;
            item.innerHTML = '<div class="md-content"></div>';
            root.append(item);
            return item;
        },
        parseTail(text) { parses++; return text; },
        parseFull(text) { parses++; return text; },
        async renderPostProcessedHtml(content, html) { content.innerHTML = html; },
    });
    const message = { id: 'stream', role: 'assistant', content: '',
        agentId: 'agent', topicId: 'topic', streamOperationId: 'operation' };
    await projection.startStreamingMessage(message);
    return {
        projection, root, message, timers,
        get parses() { return parses; },
        append(text) {
            projection.appendStreamChunk(message.id, { content: text }, message, 'operation');
        },
        frame() { return projection.probeFrame(message.id); },
        state() { return projection.probeState(message.id); },
        advance(time) {
            now = time;
            for (const [id, timer] of [...timers]) {
                if (timer.due <= now) { timers.delete(id); timer.callback(); }
            }
        },
        async dispose() { await projection.dispose(); dom.window.close(); },
    };
}

test('projection skips parsing during cooldown and flushes at deadline without another chunk', async t => {
    const f = await projectionFixture(t);
    try {
        f.append('<div>');
        f.frame();
        const first = f.parses;
        f.append('pending text');
        assert.equal(f.frame(), false);
        assert.equal(f.parses, first);
        assert.equal(f.root.textContent, '');
        assert.ok(f.state().islandGateTimer);
        f.advance(649);
        assert.equal(f.root.textContent, '');
        f.advance(650);
        assert.equal(f.root.textContent, 'pending text');
        assert.equal(f.parses, first + 1);
        f.append('\n<div>leaf</div>');
        f.frame();
        assert.match(f.root.textContent, /leaf/);
        assert.equal(f.state().islandGateTimer, null);
    } finally { await f.dispose(); }
});

test('projection never mounts partial island styles or scripts, then flushes each closed block', async t => {
    const f = await projectionFixture(t);
    try {
        f.append('<div>base');
        f.frame();
        for (const tag of ['style', 'script']) {
            f.append(`<${tag}>unfinished`);
            f.frame();
            const parses = f.parses;
            f.append(' more');
            f.frame();
            f.advance(tag === 'style' ? 1000 : 2000);
            assert.equal(f.parses, parses);
            assert.equal(f.root.querySelector(tag), null, `partial ${tag} must stay off DOM`);
            assert.equal(f.state().islandGateTimer, null);
            f.append(`</${tag}>`);
            f.frame();
            assert.ok(f.root.querySelector(tag), `closed ${tag} flushes without cooldown`);
        }
    } finally { await f.dispose(); }
});

test('smooth consumption stays authoritative; closing visible root bypasses the cooldown', async t => {
    const f = await projectionFixture(t, { smooth: true });
    try {
        f.append('<div>body\n</div>');
        f.state().visibleTextLength = 5;
        f.frame();
        f.state().visibleTextLength = 9;
        assert.equal(f.frame(), false);
        f.state().visibleTextLength = '<div>body\n</div>'.length;
        f.frame();
        assert.equal(f.root.textContent, 'body\n');
        assert.equal(f.state().islandGateTimer, null);
    } finally { await f.dispose(); }
});

test('terminal projects full text immediately and cancels a pending gate deadline', async t => {
    const f = await projectionFixture(t);
    try {
        f.append('<div>');
        f.frame();
        f.append('tail');
        f.frame();
        assert.ok(f.state().islandGateTimer);
        await f.projection.projectStreamTerminal('stream', 'stop', f.message,
            { fullResponse: '<div>final</div>', streamOperationId: 'operation' });
        assert.equal(f.root.textContent, 'final');
        f.advance(1000);
        assert.equal(f.root.textContent, 'final');
        assert.equal(f.projection.getDiagnostics().delayedCleanupTimers, 0);
    } finally { await f.dispose(); }
});

test('discard cancels pending gate deadlines', async t => {
    const f = await projectionFixture(t);
    try {
        f.append('<div>');
        f.frame();
        f.append('pending');
        f.frame();
        f.projection.discardStreamingMessage('stream');
        const parses = f.parses;
        f.advance(1000);
        assert.equal(f.parses, parses);
        assert.equal(f.projection.getDiagnostics().delayedCleanupTimers, 0);
    } finally { await f.dispose(); }
});