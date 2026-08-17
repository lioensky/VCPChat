const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

test('lifecycle inspector reports ownership metadata without payload content', async () => {
    const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>', { runScripts: 'outside-only' });
    const { window } = dom;
    window.VCPLifecycle = { diagnostics: { snapshot: () => [{ id: 1, label: 'next:test' }], summary: () => ({ activeScopes: 1 }) } };
    window.VCPTasks = { diagnostics: { snapshot: () => [{ id: 'safe-id', owner: 'next:test' }] } };
    window.VCPContributions = { diagnostics: { snapshot: () => ({ apps: [{ id: 'safe-app', ownerId: 'test' }] }) } };
    window.VCPStateChannels = { diagnostics: () => [{ name: 'theme', revision: 1, subscribers: 1 }] };
    window.VCPNextShellController = { getDiagnostics: () => ({ mounted: true, openViews: ['app:safe'] }) };
    window.VCPPerformance = { snapshot: () => [{ name: 'next.mount', durationMs: 12, metadata: { mode: 'next' } }] };
    window.chatAPI = { getMainLifecycleSnapshot: async () => ({
        embeddedSessions: [{ action: 'open-notes-window' }], activeEmbeddedAction: null,
        tasks: [{ requestId: 'request-1', operation: 'embedded:create', state: 'running', ageMs: 2 }],
        chatTasks: [{ requestId: 'message-1', operation: 'chat:stream', state: 'running', ageMs: 1 }],
    }) };
    window.eval(fs.readFileSync('modules/ui-system/lifecycle-inspector.js', 'utf8'));
    window.dispatchEvent(new window.CustomEvent('ui-mode-transition-state', { detail: { phase: 'settled', mode: 'next', generation: 3 } }));
    const renderer = window.VCPLifecycleInspector.snapshot();
    const main = await window.VCPLifecycleInspector.snapshotMain();
    assert.equal(renderer.mode, 'next');
    assert.equal(renderer.transitions[0].generation, 3);
    assert.equal(renderer.performance[0].name, 'next.mount');
    assert.equal(main.tasks[0].operation, 'embedded:create');
    assert.equal(main.chatTasks[0].operation, 'chat:stream');
    const serialized = JSON.stringify({ renderer, main });
    assert.doesNotMatch(serialized, /apiKey|chatHistory|fileContent|secret/i);
    const originalSnapshot = window.VCPLifecycleInspector.snapshot;
    window.VCPLifecycleInspector.snapshot = () => null;
    assert.equal(window.VCPLifecycleInspector.snapshot, originalSnapshot);
    dom.window.close();
});
