import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    trimTerminalUrlCandidate,
    findHttpLinksInTerminalText,
    isHttpTerminalUrl,
    getHttpLinksForTerminalBufferLine
} from '../modules/ui-system/side-pane/terminalLinks.js';
import { createTerminalSideProvider } from '../modules/ui-system/side-pane/terminalSideProvider.js';

function fakeBuffer(rows, cols) {
    const lines = rows.map((text, index) => ({
        isWrapped: index > 0 && rows[index].wrapped === true,
        getCell: (x) => (x < text.length ? { getWidth: () => 1, getChars: () => text[x] } : { getWidth: () => 1, getChars: () => '' })
    }));
    return { length: lines.length, getLine: (i) => lines[i], cols };
}

test('url candidates lose trailing punctuation and unbalanced closing brackets', () => {
    assert.equal(trimTerminalUrlCandidate('https://a.dev/x.'), 'https://a.dev/x');
    assert.equal(trimTerminalUrlCandidate('https://a.dev/x)'), 'https://a.dev/x');
    assert.equal(trimTerminalUrlCandidate('https://a.dev/(x)'), 'https://a.dev/(x)');
    assert.deepEqual(findHttpLinksInTerminalText('see http://localhost:5173/, then https://b.io').map(l => l.text),
        ['http://localhost:5173/', 'https://b.io']);
    assert.equal(isHttpTerminalUrl('https://b.io'), true);
    assert.equal(isHttpTerminalUrl('file:///etc/passwd'), false);
    assert.equal(isHttpTerminalUrl('javascript:alert(1)'), false);
});

test('a buffer line yields 1-based link ranges', () => {
    const text = 'open http://localhost:3000 now';
    const links = getHttpLinksForTerminalBufferLine(fakeBuffer([text], text.length), 1, text.length);
    assert.equal(links.length, 1);
    assert.equal(links[0].text, 'http://localhost:3000');
    assert.deepEqual(links[0].range, { start: { x: 6, y: 1 }, end: { x: 26, y: 1 } });
    assert.deepEqual(links[0].decorations, { underline: true, pointerCursor: true });
    assert.equal(getHttpLinksForTerminalBufferLine(fakeBuffer(['no links here'], 13), 1, 13), undefined);
});

test('the terminal tab opens clicked links through onOpenUrl', async () => {
    const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
    const doc = dom.window.document;
    const opened = [];
    let linkProvider = null;
    const text = 'ready at https://example.com/app';
    const buffer = fakeBuffer([text], 80);
    class FakeTerminal {
        constructor() { this.cols = 80; this.buffer = { active: buffer }; }
        loadAddon() {}
        open() {}
        onData() {}
        onResize() {}
        write() {}
        reset() {}
        focus() {}
        dispose() {}
        registerLinkProvider(provider) { linkProvider = provider; }
    }
    const api = {
        terminalCreate: async () => ({ success: true, data: { id: 't1' } }),
        terminalResize() {}, terminalWrite() {}, terminalKill() {},
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [] } })
    };
    const provider = createTerminalSideProvider({
        document: doc,
        api,
        sidePaneController: {},
        xtermLoader: async () => ({ Terminal: FakeTerminal, FitAddon: null }),
        onOpenUrl: (url) => opened.push(url)
    });
    const handle = await provider.mountTab({ id: 'terminal:main', kind: 'terminal' }, doc.getElementById('host'));
    assert.ok(linkProvider, 'a link provider is registered');
    let links;
    linkProvider.provideLinks(1, (result) => { links = result; });
    assert.equal(links.length, 1);
    let prevented = false;
    links[0].activate({ preventDefault: () => { prevented = true; } }, links[0].text);
    assert.deepEqual(opened, ['https://example.com/app']);
    assert.equal(prevented, true);
    await handle?.dispose?.();
});
