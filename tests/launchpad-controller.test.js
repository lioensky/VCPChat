const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { LaunchpadController } = require('../modules/ui-system/next-shell/launchpad-controller.js');

test('launchpad renders shared catalogs and preserves embedded/window actions', () => {
    const dom = new JSDOM('<!doctype html><body><div id="nextUiAppGrid"></div></body>');
    const opened = [];
    const controller = new LaunchpadController({
        document: dom.window.document,
        getExternalApps: () => [
            { id: 'notes', name: '笔记', icon: 'notes', embed: true },
            { id: 'theme', name: '主题', icon: 'theme', embed: false },
        ],
        getInternalApps: () => [{ id: 'showcase', title: '组件库', icon: 'widgets' }],
        getIcon: icon => `<svg data-icon="${icon}"></svg>`,
        openEmbedded: app => opened.push(`embedded:${app.id}`),
        openExternal: app => opened.push(`window:${app.id}`),
        openInternal: id => opened.push(`internal:${id}`),
    });
    controller.mount();
    const buttons = [...dom.window.document.querySelectorAll('.next-ui-app-item')];
    assert.equal(buttons.length, 3);
    buttons.forEach(button => button.click());
    assert.deepEqual(opened, ['embedded:notes', 'window:theme', 'internal:showcase']);
    controller.render();
    assert.equal(dom.window.document.querySelectorAll('.next-ui-app-item').length, 3);
    controller.dispose();
});
