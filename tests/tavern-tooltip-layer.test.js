'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

test('Tavern tooltip portal rises above its owner and resets for ordinary anchors', async () => {
    const source = fs.readFileSync('modules/ui-system/next-shell/next-shell-controller.js', 'utf8');
    const start = source.indexOf('    function mountNativeTooltipBridge(scope) {');
    const end = source.indexOf('\n    function mount() {', start);
    assert.ok(start >= 0 && end > start);
    const dom = new JSDOM(
        '<div class="tavern-popover" style="position:fixed;z-index:5000"><button title="全局开关">全局</button></div>' +
        '<button class="ordinary" title="普通提示">普通</button>',
        { runScripts: 'outside-only', pretendToBeVisual: true }
    );
    const cleanups = [];
    const scope = {
        listen(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            cleanups.push(() => target.removeEventListener(type, handler, options));
        },
        own(dispose) { cleanups.push(dispose); },
    };
    try {
        dom.window.eval(source.slice(start, end) + '\nwindow.testMount = mountNativeTooltipBridge;');
        dom.window.testMount(scope);
        const host = dom.window.document.querySelector('.next-ui-tooltip-layer');
        const anchor = dom.window.document.querySelector('.tavern-popover button');
        anchor.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(host.hidden, false);
        assert.equal(host.style.zIndex, '5001');
        assert.equal(host.textContent, '全局开关');
        anchor.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
        assert.equal(host.hidden, true);
        assert.equal(host.style.zIndex, '');
        dom.window.document.querySelector('.ordinary').dispatchEvent(
            new dom.window.FocusEvent('focusin', { bubbles: true })
        );
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(host.hidden, false);
        assert.equal(host.style.zIndex, '');
        assert.equal(host.textContent, '普通提示');
    } finally {
        cleanups.reverse().forEach(dispose => dispose());
        dom.window.close();
    }
});