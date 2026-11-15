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

test('linear trimming preserves legacy mixed bracket and punctuation semantics', () => {
    const legacy = value => {
        let s = String(value).replace(/[.,;:!?]+$/, '');
        const pairs = { ')': '(', ']': '[', '}': '{' };
        for (;;) {
            const last = s.slice(-1), opening = pairs[last];
            if (!opening) return s;
            const count = ch => [...s].filter(c => c === ch).length;
            if (count(last) <= count(opening)) return s;
            s = s.slice(0, -1).replace(/[.,;:!?]+$/, '');
        }
    };
    const alphabet = ['(', ')', '[', ']', '{', '}', '.', 'x'];
    const visit = (suffix, depth) => {
        const input = 'https://a.dev/' + suffix;
        assert.equal(trimTerminalUrlCandidate(input), legacy(input), suffix);
        if (depth) for (const char of alphabet) visit(suffix + char, depth - 1);
    };
    visit('', 4);
    assert.equal(trimTerminalUrlCandidate('https://a.dev/' + ')'.repeat(12000)), 'https://a.dev/');
});

test('wrapped links retain cell coordinates including wide and combining cells', () => {
    const cells = [
        ['界', 2], ['', 0], ['e\u0301', 1], [' ', 1],
        ...[...'https://a.dev/x'].map(char => [char, 1])
    ];
    const cols = 10;
    const rows = [];
    for (let i = 0; i < cells.length; i += cols) rows.push(cells.slice(i, i + cols));
    const buffer = { length: rows.length, getLine: i => rows[i] && ({
        isWrapped: i > 0,
        getCell: x => rows[i][x] && ({
            getWidth: () => rows[i][x][1], getChars: () => rows[i][x][0]
        })
    }) };
    const links = getHttpLinksForTerminalBufferLine(buffer, 1, cols);
    assert.equal(links[0].text, 'https://a.dev/x');
    assert.deepEqual(links[0].range, { start: { x: 5, y: 1 }, end: { x: 9, y: 2 } });
    const atZero = getHttpLinksForTerminalBufferLine(fakeBuffer(['https://a.dev'], 13), 1, 13);
    assert.deepEqual(atZero[0].range.start, { x: 1, y: 1 });
});

test('oversized wrapped lines stop before cell scanning and do not expose partial links', () => {
    let reads = 0, cells = 0;
    const buffer = { length: 5000, getLine: i => {
        reads++;
        return i >= 0 && i < 5000 ? { isWrapped: i > 0,
            getCell: () => { cells++; throw new Error('must not scan over-budget cells'); }
        } : undefined;
    } };
    assert.equal(getHttpLinksForTerminalBufferLine(buffer, 2500, 80), undefined);
    assert.ok(reads < 210, `bounded row traversal: ${reads}`);
    assert.equal(cells, 0);
    assert.equal(getHttpLinksForTerminalBufferLine(buffer, 0, 80), undefined);
    assert.equal(getHttpLinksForTerminalBufferLine(buffer, 1, 0), undefined);
});

test('scan budget admits complete lines at the limit and rejects the next row', () => {
    let scans = 0;
    const cell = { getWidth: () => 1, getChars: () => 'a' };
    const buffer = rows => ({ length: rows, getLine: i => i >= 0 && i < rows ? {
        isWrapped: i > 0, getCell: () => { scans++; return cell; }
    } : undefined });
    assert.equal(getHttpLinksForTerminalBufferLine(buffer(204), 100, 80), undefined);
    assert.equal(scans, 204 * 81);
    scans = 0;
    assert.equal(getHttpLinksForTerminalBufferLine(buffer(205), 100, 80), undefined);
    assert.equal(scans, 0);
});
