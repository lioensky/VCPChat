import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildChatEventGraph } from '../scripts/build-chat-event-graph.mjs';

test('reviewed dynamic calls require the same operation and source expression, with stable Windows line endings', () => {
    const file = 'modules/reviewed.js';
    const source = 'function bind(name) {\nwindow.addEventListener(name, handler);\n}';
    const f = fixture({ [file]: source }, [{ id: 'fixture.reviewed', dynamicSites: [
        { file, line: 2, kind: 'custom-event-listener', match: 'window.addEventListener(name' }
    ] }]);
    try {
        const original = f.graph();
        assert.equal(original.registeredDynamic.length, 1);
        assert.deepEqual(original.undiscovered, []);
        f.write(file, source.replace(/\n/g, '\r\n'));
        assert.deepEqual(f.graph(), original, 'Git checkout line endings must not stale the graph');
        f.write(file, source.replace('addEventListener(name', 'addEventListener(otherName'));
        assert.equal(f.graph().registeredDynamic.length, 0);
        assert.equal(f.graph().undiscovered.length, 1, 'a changed call needs a new source review');
        f.write(file, source.replace('addEventListener', 'removeEventListener'));
        assert.equal(f.graph().registeredDynamic.length, 0, 'a different operation cannot borrow registration');
    } finally { f.close(); }
});

test('source reviews cannot silently retire calls no longer observed in the graph', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const contract = JSON.parse(fs.readFileSync(path.join(repo, 'docs/contracts/chat-contracts.json')))
        .find(item => item.kind === 'source-review');
    const f = fixture({}, [contract]);
    try {
        f.write('graph.json', JSON.stringify({ schemaVersion: 1, events: [], registeredDynamic: [], undiscovered: [] }));
        const result = spawnSync(process.execPath, ['scripts/check-chat-contracts.mjs'], {
            cwd: repo, encoding: 'utf8', windowsHide: true,
            env: { ...process.env, VCPCHAT_CONTRACTS_INPUT: path.join(f.root, 'docs/contracts/chat-contracts.json'),
                VCPCHAT_GRAPH_INPUT: path.join(f.root, 'graph.json'), VCPCHAT_CONSUMER_REPORT_INPUT: path.join(f.root, 'absent.json') }
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /not observed by the generated graph/);
    } finally { f.close(); }
});

function fixture(files, contracts = []) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-event-inventory-'));
    const write = (file, content) => {
        const target = path.resolve(root, file);
        assert.ok(target.startsWith(root + path.sep));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    write('docs/contracts/chat-contracts.json', JSON.stringify(contracts));
    for (const [file, content] of Object.entries(files)) write(file, content);
    return { root, write, graph: () => buildChatEventGraph({ root, subscriptionNames: new Set(['onThemeUpdated']) }),
        close() {
            assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
            assert.ok(path.basename(root).startsWith('vcp-event-inventory-'));
            fs.rmSync(root, { recursive: true, force: true });
        } };
}

test('qualified CustomEvent and a lexical constant connect the actual source endpoints', () => {
    const f = fixture({ 'modules/follow.js': `const EVENT = 'vcp:git-follow-workspace';
win.dispatchEvent(new win.CustomEvent(EVENT, { detail: { workspaceId: 'a' } }));
win.addEventListener(EVENT, listener);` });
    try {
        const g = f.graph(), event = g.events.find(item => item.name === 'vcp:git-follow-workspace');
        assert.deepEqual(event.producers, [{ file: 'modules/follow.js', line: 2, kind: 'custom-event-create' }]);
        assert.deepEqual(event.consumers, [{ file: 'modules/follow.js', line: 3, kind: 'custom-event-listener' }]);
        assert.deepEqual(g.undiscovered, []);
    } finally { f.close(); }
});

test('comments, regexes and embedded code strings are not executable event endpoints', () => {
    const f = fixture({ 'modules/noise.js': `// ipcRenderer.send('vcp:comment', 1)
const text = "window.addEventListener('vcp:string', handler)";
const regex = /onThemeUpdated\(/;
function onThemeUpdated() {}
const html = \`<script>dispatchEvent(new CustomEvent('vcp:embedded'))</script>\`;
window.addEventListener('vcp:real', handler);` });
    try {
        const g = f.graph();
        assert.deepEqual(g.events.map(item => item.name), ['vcp:real']);
        assert.deepEqual(g.events[0].producers, []);
        assert.equal(g.events[0].consumers[0].line, 6);
    } finally { f.close(); }
});

test('binding resolution respects parameter, block, catch and hoisted var shadowing', () => {
    const f = fixture({ 'modules/scopes.js': `const EVENT = 'vcp:outer';
function dynamic(EVENT) { window.addEventListener(EVENT, handler); }
{ const EVENT = 'vcp:inner'; window.addEventListener(EVENT, handler); }
try {} catch (EVENT) { window.addEventListener(EVENT, handler); }
function hoisted() { window.addEventListener(EVENT, handler); { var EVENT; } }
window.addEventListener(EVENT, handler);` });
    try {
        const g = f.graph();
        assert.deepEqual(g.events.map(item => item.name), ['vcp:inner', 'vcp:outer']);
        assert.equal(g.events.find(item => item.name === 'vcp:outer').consumers.length, 1);
        assert.deepEqual(g.undiscovered.map(item => item.line), [2, 4, 5]);
    } finally { f.close(); }
});

test('immutable aliases resolve but mutable bindings, cycles and imported names stay uncertain', () => {
    const f = fixture({ 'modules/aliases.js': `import { EVENT as IMPORTED } from './external.js';
const PREFIX = 'vcp:'; const BASE = PREFIX + 'alias'; const EVENT = BASE;
window.addEventListener(EVENT, handler);
let mutable = 'vcp:before'; mutable = 'vcp:after'; window.addEventListener(mutable, handler);
const a = b; const b = a; window.addEventListener(a, handler);
window.addEventListener(IMPORTED, handler);` });
    try {
        const g = f.graph();
        assert.deepEqual(g.events.map(item => item.name), ['vcp:alias']);
        assert.equal(g.undiscovered.length, 3);
    } finally { f.close(); }
});

test('event listeners are consumers, IPC sends are producers, payload helpers are neither', () => {
    const f = fixture({ 'modules/roles.js': `ipcMain.on('vcp:request', handler);
ipcMain.handle('vcp:invoke', handler);
ipcRenderer.send('vcp:request', payload);
event.sender.send('vcp:reply', payload);
socket.send(JSON.stringify(payload));
on(element, 'vcp:helper', handler);
dispatch(element, 'vcp:helper');
onThemeUpdated(payload);
electronAPI.onThemeUpdated(handler);` });
    try {
        const g = f.graph();
        assert.deepEqual(g.events.map(item => item.name), ['onThemeUpdated(', 'vcp:invoke', 'vcp:reply', 'vcp:request']);
        const request = g.events.find(item => item.name === 'vcp:request');
        assert.equal(request.producers.length, 1); assert.equal(request.consumers.length, 1);
        assert.equal(g.events.find(item => item.name === 'vcp:invoke').producers.length, 0);
        assert.equal(g.events.find(item => item.name === 'onThemeUpdated(').consumers.length, 1);
        assert.equal(g.undiscovered.length, 0);
    } finally { f.close(); }
});

test('preload channel declarations retain their channel without inventing callback events', () => {
    const f = fixture({ 'preloads/api/chat.js': `const CHANNEL = 'vcp:history';
const api = { onHistory: on(CHANNEL), query: invoke('vcp:query'), post: send('vcp:post') };` });
    try {
        const g = f.graph();
        assert.deepEqual(g.events.map(item => item.name), ['vcp:history', 'vcp:post', 'vcp:query']);
        assert.equal(g.events.find(item => item.name === 'vcp:history').consumers.length, 1);
        assert.equal(g.events.find(item => item.name === 'vcp:query').producers.length, 1);
    } finally { f.close(); }
});

test('the real preload registry recognizes theme subscriptions without a fixture name override', () => {
    const f = fixture({ 'modules/theme.js': 'electronAPI.onThemeUpdated(handler);' });
    try {
        const g = buildChatEventGraph({ root: f.root });
        assert.equal(g.events.find(item => item.name === 'onThemeUpdated(')?.consumers.length, 1);
    } finally { f.close(); }
});

test('only the registered dynamic site is observed; another listener remains unregistered', () => {
    const file = 'modules/dynamic.js';
    const f = fixture({ [file]: `function relay(name) {
window.dispatchEvent(new window.CustomEvent(name));
window.addEventListener(name, handler);
}` }, [{ id: 'fixture.relay', dynamicSites: [{ file, line: 2 }] }]);
    try {
        const g = f.graph();
        assert.deepEqual(g.events, []);
        assert.equal(g.registeredDynamic.length, 1);
        assert.equal(g.registeredDynamic[0].contractId, 'fixture.relay');
        assert.deepEqual(g.undiscovered.map(item => item.line), [3]);
    } finally { f.close(); }
});

test('parse errors identify the file instead of emitting a partial reassuring graph', () => {
    const f = fixture({ 'modules/broken.js': 'const incomplete = ;' });
    try { assert.throws(f.graph, /Cannot inventory event source modules\/broken.js/); }
    finally { f.close(); }
});

test('a constructor registration cannot hide a different protocol operation on the same line', () => {
    const file = 'modules/collision.js';
    const f = fixture({ [file]: 'function relay(name) { new CustomEvent(name); window.addEventListener(name, handler); }' },
        [{ id: 'fixture.constructor', dynamicSites: [{ file, line: 1 }] }]);
    try {
        const g = f.graph();
        assert.equal(g.registeredDynamic.length, 1);
        assert.equal(g.registeredDynamic[0].kind, 'custom-event-create');
        assert.equal(g.undiscovered.length, 1);
        assert.match(g.undiscovered[0].reason, /dynamic listener name/);
    } finally { f.close(); }
});

test('an isolated graph ignores test/vendor code and generation does not mutate its sources', () => {
    const files = { 'modules/real.js': "window.addEventListener('vcp:real', handler);",
        'modules/tests/fake.js': "window.addEventListener('vcp:fake', handler);",
        'modules/vendor/fake.js': "window.addEventListener('vcp:vendor', handler);" };
    const f = fixture(files);
    try {
        const first = f.graph(), second = f.graph();
        assert.deepEqual(first, second);
        assert.deepEqual(first.filesScanned, ['modules/real.js']);
        assert.deepEqual(first.events.map(item => item.name), ['vcp:real']);
        for (const [file, source] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(f.root, file), 'utf8'), source);
    } finally { f.close(); }
});

test('the contract gate rejects an unregistered dynamic listener from generated evidence', () => {
    const f = fixture({ 'modules/unknown.js': 'function bind(name) { window.addEventListener(name, handler); }' });
    try {
        f.write('graph.json', JSON.stringify(f.graph()));
        const result = spawnSync(process.execPath, ['scripts/check-chat-contracts.mjs'], {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            encoding: 'utf8', windowsHide: true,
            env: { ...process.env, VCPCHAT_CONTRACTS_INPUT: path.join(f.root, 'docs/contracts/chat-contracts.json'), VCPCHAT_GRAPH_INPUT: path.join(f.root, 'graph.json'), VCPCHAT_CONSUMER_REPORT_INPUT: path.join(f.root, 'absent.json') }
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /graph contains 1 unregistered dynamic event site/);
    } finally { f.close(); }
});

test('the contract gate cannot accept a different operation at a registered file and line', () => {
    const file = 'modules/ui-system/webawesome-adapter.js';
    const contract = { id: 'fixture.kind', kind: 'event', owner: file, status: 'manual_required', dynamic: true,
        producer: [file], consumers: [file], terminal: { single: false },
        dynamicSites: [{ file, line: 1, kind: 'custom-event-listener' }] };
    const f = fixture({}, [contract]);
    try {
        f.write('graph.json', JSON.stringify({ schemaVersion: 1, events: [], undiscovered: [],
            registeredDynamic: [{ file, line: 1, kind: 'custom-event-create', contractId: 'fixture.kind' }] }));
        const result = spawnSync(process.execPath, ['scripts/check-chat-contracts.mjs'], {
            cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true,
            env: { ...process.env, VCPCHAT_CONTRACTS_INPUT: path.join(f.root, 'docs/contracts/chat-contracts.json'),
                VCPCHAT_GRAPH_INPUT: path.join(f.root, 'graph.json'), VCPCHAT_CONSUMER_REPORT_INPUT: path.join(f.root, 'absent.json') }
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /fixture.kind dynamicSites entry is not observed/);
    } finally { f.close(); }
});


test('explicit protocol operations retain names outside the old domain keyword list', () => {
    const f = fixture({ 'preloads/api/other.js': "const api = { get: invoke('get-agents'), dice: onArgs('roll-dice', 'notation'), notes: onSignal('local-notes-changed'), close: custom('command', 'close-window', builder), path: custom('query', null, builder) };",
        'modules/other.js': "ipcMain.handle('get-agents', handler); ipcRenderer.invoke('git:status'); window.addEventListener('blur', handler); new CustomEvent('ready'); emit('plain payload'); socket.send('plain payload');" });
    try {
        const g = f.graph();
        assert.deepEqual(g.events.map(item => item.name), ['blur', 'close-window', 'get-agents', 'git:status', 'local-notes-changed', 'ready', 'roll-dice']);
        assert.equal(g.events.find(item => item.name === 'get-agents').producers.length, 1);
        assert.equal(g.events.find(item => item.name === 'get-agents').consumers.length, 1);
        assert.equal(g.events.find(item => item.name === 'roll-dice').consumers.length, 1);
        assert.equal(g.undiscovered.length, 0);
    } finally { f.close(); }
});

test('every real preload channel has a source declaration in its own API domain', async () => {
    const { createRequire } = await import('node:module');
    const apis = createRequire(import.meta.url)('../preloads/core/registry.js').describeApis();
    const g = buildChatEventGraph();
    const missing = apis.filter(api => typeof api.channel === 'string' && !g.events.some(event => event.name === api.channel
        && event.evidence.some(site => site.file === 'preloads/api/' + api.domain + '.js' && site.kind === 'preload-channel-definition')));
    assert.deepEqual(missing.map(api => ({ name: api.name, channel: api.channel, domain: api.domain })), []);
});


test('conditional channel aliases and concatenation inventory every finite source branch', () => {
    const f = fixture({ 'modules/finite.js': "function route(embedded) { const choice = embedded ? 'child' : 'host'; const channel = 'vcp:' + choice; ipcRenderer.send(channel); window.addEventListener(channel, listener); }" });
    try {
        const g = f.graph();
        assert.deepEqual(g.events.map(event => event.name), ['vcp:child', 'vcp:host']);
        assert.ok(g.events.every(event => event.producers.length === 1 && event.consumers.length === 1));
        assert.deepEqual(g.undiscovered, []);
    } finally { f.close(); }
});

test('a known conditional branch cannot conceal its unresolved sibling', () => {
    const f = fixture({ 'modules/partial.js': "function route(channel) { ipcRenderer.send(flag ? 'known-close' : channel); }" });
    try {
        const g = f.graph();
        assert.deepEqual(g.events.map(event => event.name), ['known-close']);
        assert.equal(g.undiscovered.length, 1);
        assert.match(g.undiscovered[0].reason, /channel/);
    } finally { f.close(); }
});

test('large finite branch products retain evidence while remaining explicitly incomplete', () => {
    const expression = Array.from({ length: 7 }, (_, i) => "(flag" + i + " ? 'a' : 'b')").join(' + ');
    const f = fixture({ 'modules/product.js': 'ipcRenderer.invoke(' + expression + ');' });
    try {
        const g = f.graph();
        assert.ok(g.events.length > 0 && g.events.length < 128);
        assert.ok(g.events.every(event => /^[ab]{7}$/.test(event.name)));
        assert.equal(g.undiscovered.length, 1, 'bounded analysis must not certify exhaustive coverage');
    } finally { f.close(); }
});

test('both actual closeWindow runtime channels have a source producer without changing the window', async () => {
    const { createRequire } = await import('node:module');
    const entry = createRequire(import.meta.url)('../preloads/core/registry.js').loadRegistry().get('closeWindow').entry;
    const sent = [];
    for (const isEmbeddedSurface of [false, true]) entry.build({ isEmbeddedSurface, ipcRenderer: { send: channel => sent.push(channel) } })();
    assert.deepEqual(sent, ['close-window', 'embedded-vchat-app:request-close']);
    const g = buildChatEventGraph();
    for (const name of sent) assert.ok(g.events.find(event => event.name === name)?.producers.some(site => site.file === 'preloads/api/window.js' && site.kind === 'event-send'));
    assert.ok(!g.undiscovered.some(site => site.file === 'preloads/api/window.js'));
});

test('local IPC wrappers connect the caller channel through its parameter position and alias', () => {
    const f = fixture({ 'preloads/local.js': `const { ipcRenderer: ipc } = require('electron');
function listen(callback, channel) { ipc.on(channel, callback); }
const query = (payload, channel) => ipc.invoke(channel, payload);
const alias = listen;
alias(handler, 'chart:changed'); query(payload, 'loom:get-app');` });
    try {
        const g = f.graph();
        assert.ok(g.events.find(event => event.name === 'chart:changed')?.consumers.some(site => site.line === 5));
        assert.ok(g.events.find(event => event.name === 'loom:get-app')?.producers.some(site => site.line === 5));
    } finally { f.close(); }
});

test('wrapper discovery rejects unrelated, shadowed, rebound and deferred protocol helpers', () => {
    const f = fixture({ 'preloads/shadowed.js': `const { ipcRenderer } = require('electron');
function subscribe(channel, callback) { ipcRenderer.on(channel, callback); }
function unrelated() { return 'value'; } unrelated('chart:unrelated');
function scoped(subscribe) { subscribe('chart:shadowed', handler); }
let changed = subscribe; changed = unrelated; changed('chart:rebound');
function deferred(channel) { return () => ipcRenderer.on(channel, handler); } deferred('chart:deferred');
function rewritten(channel) { channel = 'chart:replacement'; ipcRenderer.on(channel, handler); } rewritten('chart:rewritten');
function fakeReceiver(ipcRenderer, channel) { ipcRenderer.on(channel, handler); } fakeReceiver({}, 'chart:fake');
function nested(channel) { function dead() { ipcRenderer.on(channel, handler); } } nested('chart:dead');
subscribe(dynamicChannel, handler);` });
    try {
        const g = f.graph();
        for (const name of ['unrelated', 'shadowed', 'rebound', 'deferred', 'rewritten', 'fake', 'dead']) {
            assert.ok(!g.events.some(event => event.name === 'chart:' + name), name);
        }
        assert.ok(g.undiscovered.some(site => site.line === 10 && /dynamicChannel/.test(site.reason)));
    } finally { f.close(); }
});

test('actual dedicated preload wrappers retain their own source endpoints', () => {
    const g = buildChatEventGraph();
    for (const [file, name, role] of [
        ['preloads/chart.js', 'chart:changed', 'consumers'],
        ['preloads/chart.js', 'chart:select', 'consumers'],
        ['preloads/docx.js', 'docx:open-path-request', 'consumers'],
        ['preloads/loom.js', 'loom:registry-changed', 'consumers'],
        ['preloads/loom.js', 'loom:get-app', 'producers'],
    ]) assert.ok(g.events.find(event => event.name === name)?.[role].some(site => site.file === file), file + ': ' + name);
});

test('wrapper protocol origin must be Electron and survive lexical shadowing and mutation', () => {
    const f = fixture({ 'modules/origins.js': `import { ipcRenderer as wire } from 'electron';
function valid(channel) { wire.send(channel); } valid('chart:valid');
{ const { ipcRenderer } = require('other'); function unrelated(channel) { ipcRenderer.send(channel); } unrelated('chart:other-module'); }
function factory(require) { const { ipcRenderer } = require('electron'); function fake(channel) { ipcRenderer.send(channel); } fake('chart:fake-require'); }
{ const { ipcRenderer } = require('electron'); ipcRenderer = replacement; function changed(channel) { ipcRenderer.send(channel); } changed('chart:changed-receiver'); }
function shadowed(channel) { { const channel = 'chart:local'; wire.send(channel); } } shadowed('chart:outer');
const cycleA = cycleB; const cycleB = cycleA; cycleA('chart:cycle');` });
    try {
        const g = f.graph();
        assert.ok(g.events.find(event => event.name === 'chart:valid')?.producers.some(site => site.line === 2));
        for (const name of ['other-module', 'fake-require', 'changed-receiver', 'outer', 'cycle']) {
            assert.ok(!g.events.some(event => event.name === 'chart:' + name), name);
        }
    } finally { f.close(); }
});

test('wrapper finite and missing call arguments preserve partial evidence without retiring its implementation site', () => {
    const file = 'preloads/partial-wrapper.js';
    const f = fixture({ [file]: `const { ipcRenderer } = require('electron');
function query(channel) { return ipcRenderer.invoke(channel); }
query(flag ? 'loom:known' : runtimeValue);
query();` });
    try {
        const g = f.graph();
        assert.ok(g.events.find(event => event.name === 'loom:known')?.producers.some(site => site.line === 3));
        assert.deepEqual(g.undiscovered.map(site => site.line), [2, 3, 4]);
        assert.match(g.undiscovered[2].reason, /<missing>/);
    } finally { f.close(); }
});
