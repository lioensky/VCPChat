import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildTerminalTheme, DARK_PALETTE, LIGHT_PALETTE, isLightTheme, normalizeCssColor } from '../modules/ui-system/side-pane/terminalTheme.js';

function makeDoc(bodyAttrs = '') {
    const dom = new JSDOM(`<body ${bodyAttrs}><div id="screen"></div></body>`, { pretendToBeVisual: true });
    return dom.window.document;
}

test('dark theme gets the dark ANSI palette and reads the frame computed background / foreground', () => {
    const doc = makeDoc();
    const screen = doc.getElementById('screen');
    const sheet = doc.createElement('style');
    sheet.textContent = '#screen { background-color: rgb(16, 16, 16); color: rgb(238, 238, 238); }';
    doc.head.appendChild(sheet);
    const theme = buildTerminalTheme(doc, screen);
    assert.equal(isLightTheme(doc), false);
    assert.equal(theme.red, DARK_PALETTE.red);
    assert.equal(theme.brightWhite, DARK_PALETTE.brightWhite);
    assert.equal(theme.background, 'rgb(16, 16, 16)');
    assert.equal(theme.foreground, 'rgb(238, 238, 238)');
    assert.equal(theme.cursorAccent, theme.background);
});

test('light theme (data attribute or class) gets the light palette', () => {
    for (const attrs of ['data-vcp-theme="light"', 'class="light-theme"']) {
        const doc = makeDoc(attrs);
        const theme = buildTerminalTheme(doc, doc.getElementById('screen'));
        assert.equal(isLightTheme(doc), true, attrs);
        assert.equal(theme.yellow, LIGHT_PALETTE.yellow);
        assert.equal(theme.background, '#fafafa', 'falls back when the frame has no background');
    }
});

test('normalizeCssColor falls back / passes through without a canvas', () => {
    const doc = makeDoc();
    assert.equal(normalizeCssColor(doc, '', '#123456'), '#123456');
    assert.equal(normalizeCssColor(doc, 'var(--x)', '#123456'), 'var(--x)');
});

test('mounted terminal: xterm theme follows the frame and switches with the light/dark theme', async () => {
    const { createTerminalSideProvider } = await import('../modules/ui-system/side-pane/terminalSideProvider.js');
    const dom = new JSDOM('<body><div id="view"></div></body>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const terminals = [];
    class FakeTerminal {
        constructor(options) { this.options = options; this.cols = 80; this.buffer = { active: {} }; terminals.push(this); }
        loadAddon() {} open() {} onData() { return { dispose() {} }; } onResize() { return { dispose() {} }; }
        focus() {} write() {} dispose() {} reset() {} clear() {} registerLinkProvider() {}
        onTitleChange() { return { dispose() {} }; } onBell() { return { dispose() {} }; }
    }
    const api = { gitListWorkspaces: async () => ({ success: true, data: { workspaces: [] } }), terminalCreate: async () => ({ success: true, data: { id: "s1", replay: "" } }), terminalKill() {} };
    const provider = createTerminalSideProvider({
        document: doc, api, sidePaneController: null,
        xtermLoader: async () => ({ Terminal: FakeTerminal, FitAddon: null })
    });
    const view = doc.getElementById('view');
    let handle;
    try {
        handle = await provider.mountTab({ id: 'terminal:main' }, view);
        const screen = view.querySelector('.side-terminal-screen');
        assert.ok(screen && terminals[0], "terminal mounted");
        assert.equal(screen.getAttribute('style'), null, 'no inline style: the frame color comes from CSS');
        assert.equal(terminals[0].options.theme.background, '#14161a');
        doc.body.setAttribute('data-vcp-theme', 'light');
        await new Promise(resolve => dom.window.queueMicrotask(resolve));
        assert.equal(terminals[0].options.theme.red, LIGHT_PALETTE.red);
        assert.equal(terminals[0].options.theme.background, '#fafafa');
    } finally {
        await handle?.dispose?.();
        dom.window.close();
    }
});

test('the canvas takes the frame colour once the screen is in the pane, and unrelated body changes do not repaint it', async () => {
    const { createTerminalSideProvider } = await import('../modules/ui-system/side-pane/terminalSideProvider.js');
    const dom = new JSDOM('<body><div id="view"></div></body>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const sheet = doc.createElement('style');
    sheet.textContent = '#view .side-terminal-screen { background-color: rgb(30, 40, 50); color: rgb(200, 210, 220); }';
    doc.head.appendChild(sheet);
    const terminals = [];
    class FakeTerminal {
        constructor(options) {
            this.themeWrites = 0;
            let theme = options.theme;
            this.options = { ...options };
            Object.defineProperty(this.options, 'theme', { get: () => theme, set: value => { theme = value; this.themeWrites++; } });
            this.cols = 80; this.buffer = { active: {} }; terminals.push(this);
        }
        loadAddon() {} open() {} onData() { return { dispose() {} }; } onResize() { return { dispose() {} }; }
        focus() {} write() {} dispose() {} reset() {} clear() {} registerLinkProvider() {}
    }
    const api = { terminalCreate: async () => ({ success: true, data: { id: 's1' } }), terminalKill() {} };
    const provider = createTerminalSideProvider({ document: doc, api, sidePaneController: null,
        xtermLoader: async () => ({ Terminal: FakeTerminal, FitAddon: null }) });
    let handle;
    try {
        handle = await provider.mountTab({ id: 'terminal:main' }, doc.getElementById('view'));
        assert.equal(terminals[0].options.theme.background, 'rgb(30, 40, 50)', 'not the hard-coded fallback');
        assert.equal(terminals[0].options.theme.foreground, 'rgb(200, 210, 220)');
        const writes = terminals[0].themeWrites;
        doc.body.classList.add('side-pane-resizing');
        await new Promise(resolve => dom.window.queueMicrotask(resolve));
        assert.equal(terminals[0].themeWrites, writes, 'same colours: no reassignment, no full repaint');
    } finally {
        await handle?.dispose?.();
        dom.window.close();
    }
});

test('PSReadLine line redraws lose their black trailing background; command output keeps its colours', async () => {
    const { normalizePowerShellReadlineRedraw } = await import('../modules/ui-system/side-pane/terminalDataTransform.js');
    const ESC = '\x1b';
    const redraw = `${ESC}[3;1H${ESC}[37mPS C:\\> ${ESC}[93mgit${ESC}[37;40m        ${ESC}[0m`;
    assert.equal(normalizePowerShellReadlineRedraw(redraw, true), `${ESC}[3;1H${ESC}[37mPS C:\\> ${ESC}[93mgit${ESC}[37;49m        ${ESC}[0m`);
    assert.equal(normalizePowerShellReadlineRedraw(redraw, false), redraw, 'bash sessions are left alone');
    const output = `${ESC}[37;40mblack box from a program${ESC}[0m\r\n`;
    assert.equal(normalizePowerShellReadlineRedraw(output, true), output, 'output with a newline is not a line redraw');
});
