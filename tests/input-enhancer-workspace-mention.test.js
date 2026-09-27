'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'modules', 'inputEnhancer.js'), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function createFixture({ activeWorkspaceId = null } = {}) {
    const dom = new JSDOM(
        '<!doctype html><body><div id="composer"><textarea id="message"></textarea></div></body>',
        { runScripts: 'dangerously', url: 'http://localhost/' },
    );
    const { window } = dom;
    window.console = { ...console, log() {} };
    window.alert = message => { throw new Error(`Unexpected alert: ${message}`); };
    window.electronPath = { basename: async p => path.basename(p) };
    window.eval(source);

    const searchCalls = [];
    const handled = [];
    const workspaces = [
        { id: 'ws_a', alias: 'vcpchat', path: 'H:\\VCPChat', enabled: true },
        { id: 'ws_b', alias: 'vcptoolbox', path: 'H:\\VCPToolBox', enabled: true },
    ];
    const electronAPI = {
        searchNotes: async () => [],
        listWorkspaces: async () => ({ success: true, workspaces, activeWorkspaceId }),
        searchWorkspaceFiles: async (query, options) => {
            searchCalls.push({ query, alias: options?.alias ?? null });
            return {
                success: true,
                results: [{
                    source: 'workspace', workspaceId: 'ws_a', alias: options?.alias || 'vcpchat',
                    name: 'inputEnhancer.js', relPath: 'modules/inputEnhancer.js',
                    path: 'H:\\VCPChat\\modules\\inputEnhancer.js',
                }],
            };
        },
        handleFileDrop: async (_a, _t, files) => {
            handled.push(...files);
            return files.map(file => ({
                success: true,
                attachment: { name: file.name, type: 'text/plain', size: 1, internalPath: `file://${file.path}`, isLiveReference: true },
            }));
        },
        onAddFileToInput: () => () => {},
    };

    const attachments = [];
    const messageInput = window.document.getElementById('message');
    window.inputEnhancer.initializeInputEnhancer({
        messageInput,
        dropTargetElement: window.document.getElementById('composer'),
        electronAPI,
        attachedFiles: { append: value => attachments.push(value) },
        updateAttachmentPreview() {},
        getCurrentAgentId: () => 'agent-1',
        getCurrentTopicId: () => 'topic-1',
    });

    async function type(value) {
        messageInput.value = value;
        messageInput.selectionStart = messageInput.selectionEnd = value.length;
        messageInput.dispatchEvent(new window.Event('input', { bubbles: true }));
        await flush();
        await flush();
        return window.document.getElementById('note-suggestion-popup');
    }

    return { dom, window, messageInput, attachments, handled, searchCalls, type };
}

async function cleanup(fixture) {
    await fixture.window.inputEnhancer.dispose();
    fixture.dom.window.close();
}

test('multiple workspaces: @prefix offers alias completion that scopes the next search', async t => {
    const fixture = createFixture();
    t.after(() => cleanup(fixture));

    const popup = await fixture.type('@vcp');
    const aliasItems = [...popup.querySelectorAll('.suggestion-kind-alias')];
    assert.deepEqual(aliasItems.map(item => item.querySelector('.suggestion-name').textContent), ['vcpchat/', 'vcptoolbox/']);

    aliasItems[0].click();
    await flush();
    await flush();
    assert.equal(fixture.messageInput.value, '@vcpchat/');
    const scoped = fixture.searchCalls.at(-1);
    assert.deepEqual(scoped, { query: '', alias: 'vcpchat' });
});

test('selecting a workspace file attaches it by real path and clears the mention', async t => {
    const fixture = createFixture();
    t.after(() => cleanup(fixture));

    const popup = await fixture.type('请看 @vcpchat/input');
    assert.deepEqual(fixture.searchCalls.at(-1), { query: 'input', alias: 'vcpchat' });
    popup.querySelector('.suggestion-kind-workspace').click();
    await flush();

    assert.equal(fixture.handled[0].path, 'H:\\VCPChat\\modules\\inputEnhancer.js');
    assert.equal(fixture.handled[0].liveReference, false, 'workspace ownership is decided by the main process');
    assert.equal(fixture.attachments[0].isLiveReference, true);
    assert.equal(fixture.messageInput.value, '请看 ');
});

test('an active workspace scopes plain @keyword searches and hides alias items', async t => {
    const fixture = createFixture({ activeWorkspaceId: 'ws_b' });
    t.after(() => cleanup(fixture));

    const popup = await fixture.type('@input');
    assert.deepEqual(fixture.searchCalls.at(-1), { query: 'input', alias: 'vcptoolbox' });
    assert.equal(popup.querySelectorAll('.suggestion-kind-alias').length, 0);
});

test('email-like text does not trigger the mention popup', async t => {
    const fixture = createFixture();
    t.after(() => cleanup(fixture));

    await fixture.type('联系 user@example.com');
    const popup = fixture.window.document.getElementById('note-suggestion-popup');
    assert.ok(!popup || popup.style.display !== 'block');
    assert.equal(fixture.searchCalls.length, 0);
});

test('suggestion names are rendered as text, not HTML', async t => {
    const fixture = createFixture();
    t.after(() => cleanup(fixture));
    const popup = await fixture.type('@vcpchat/x');
    assert.equal(popup.querySelector('img, script'), null);
    assert.equal(popup.querySelector('.suggestion-kind-workspace .suggestion-name').textContent, 'inputEnhancer.js');
});