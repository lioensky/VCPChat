import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTerminalSideProvider } from '../modules/ui-system/side-pane/terminalSideProvider.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

function setupEnvironment() {
    const dom = new JSDOM(
        '<aside><div class="side-pane-tabs"></div><div class="side-pane-content-container"></div></aside>',
        { pretendToBeVisual: true }
    );
    const doc = dom.window.document;
    const root = doc.querySelector('aside');
    const controller = createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container')
    });

    class FakeTerminal {
        constructor(options) {
            this.options = options;
            this.cols = 80;
            this.rows = 24;
        }
        open(screen) {
            // 模拟 xterm.open 生成的结构
            const xtermRoot = doc.createElement('div');
            xtermRoot.className = 'xterm';

            const viewport = doc.createElement('div');
            viewport.className = 'xterm-viewport';
            // 模拟视口几何尺寸：clientWidth 280, offsetWidth 300（右侧 20px 为滚动条槽）
            Object.defineProperty(viewport, 'clientWidth', { value: 280, configurable: true });
            Object.defineProperty(viewport, 'offsetWidth', { value: 300, configurable: true });
            viewport.getBoundingClientRect = () => ({
                left: 0,
                right: 300,
                top: 0,
                bottom: 500,
                width: 300,
                height: 500
            });

            const scrollArea = doc.createElement('div');
            scrollArea.className = 'xterm-scroll-area';
            viewport.appendChild(scrollArea);

            const screenEl = doc.createElement('div');
            screenEl.className = 'xterm-screen';

            xtermRoot.appendChild(viewport);
            xtermRoot.appendChild(screenEl);
            screen.appendChild(xtermRoot);
        }
        onData() {}
        onResize() {}
        loadAddon() {}
        attachCustomKeyEventHandler() {}
        hasSelection() { return false; }
        getSelection() { return ''; }
        focus() {}
        write() {}
        clear() {}
        reset() {}
        dispose() {}
    }

    const api = {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [] } }),
        terminalCreate: async () => ({ success: true, data: { id: 'view:1', pid: 123 } }),
        terminalKill: async () => ({ success: true }),
        onTerminalData: () => () => {},
        onTerminalClear: () => () => {},
        onTerminalExit: () => () => {}
    };

    const provider = createTerminalSideProvider({
        document: doc,
        api,
        sidePaneController: controller,
        xtermLoader: async () => ({ Terminal: FakeTerminal, FitAddon: null })
    });

    controller.registerProvider('terminal', provider);

    return { dom, doc, controller, provider };
}

test('clicking inside the scrollbar gutter stops propagation so xterm selection does not preventDefault', async () => {
    const { doc, provider } = setupEnvironment();
    const tab = { id: 'test-terminal', type: 'terminal' };
    const container = doc.createElement('div');
    doc.body.appendChild(container);

    const view = await provider.mountTab(tab, container);

    const screen = container.querySelector('.side-terminal-screen');
    assert.ok(screen, 'screen element should be mounted');

    const xtermRoot = screen.querySelector('.xterm');
    assert.ok(xtermRoot, 'xterm root should exist inside screen');

    let xtermMousedownReceived = false;
    xtermRoot.addEventListener('mousedown', () => {
        xtermMousedownReceived = true;
    });

    // 1. 点击滚动条槽内 (clientX = 290，落在 280-300 之间)
    const scrollbarClickEvent = new doc.defaultView.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 290,
        clientY: 100,
        button: 0
    });

    const viewport = screen.querySelector('.xterm-viewport');
    viewport.dispatchEvent(scrollbarClickEvent);

    assert.equal(
        xtermMousedownReceived,
        false,
        'mousedown in the scrollbar gutter must be stopped at the capture phase and not reach .xterm'
    );

    // 2. 点击文本区域 (clientX = 100，落在 0-280 之间)
    const textClickEvent = new doc.defaultView.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
        button: 0
    });

    viewport.dispatchEvent(textClickEvent);

    assert.equal(
        xtermMousedownReceived,
        true,
        'mousedown in the text area must pass through to .xterm for normal selection'
    );

    view?.dispose?.();
});