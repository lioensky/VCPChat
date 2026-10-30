'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('Git file menu reuses source and native reveal, preserving workspace-relative paths', async () => {
    const dom = new JSDOM('<body><div id="git-groups"></div></body>', {
        runScripts: 'outside-only', url: 'https://projectforge.local/',
    });
    const w = dom.window;
    try {
        // 不触发业务初始化；显式绑定真实的菜单处理函数。
        const add = w.document.addEventListener.bind(w.document);
        w.document.addEventListener = (name, ...args) => {
            if (name !== 'DOMContentLoaded') add(name, ...args);
        };
        const opened = [], revealed = [], errors = [];
        w.api = { gitRevealPath: async (...args) => {
            revealed.push(args); return { success: true, data: {} };
        } };
        w.toast = (...args) => errors.push(args);
        w.$ = id => {
            let el = w.document.getElementById(id);
            if (!el) {
                el = w.document.createElement('div'); el.id = id;
                w.document.body.appendChild(el);
            }
            return el;
        };
        w.window.ProjectForgeSource = { open: async (...args) => opened.push(args) };
        const script = fs.readFileSync(path.join(__dirname, '../ProjectForgemodules/projectforge-git.js'), 'utf8')
            .replace(/\}\)\(\);\s*$/, 'window.__gitTest = { git, bindGitEvents }; })();');
        w.eval(script);
        const { git, bindGitEvents } = w.__gitTest;
        git.workspaceId = 'ws1';
        git.status = { isRepo: true, prefix: 'pkg', changes: [{ path: 'pkg/src/a.js', status: 'M' }] };
        bindGitEvents();
        w.$('git-groups').innerHTML = '<li class="git-row" data-path="pkg/src/a.js" data-group="changes"><button class="git-open">a.js</button></li>';
        const row = w.document.querySelector('.git-row');
        const menu = () => w.document.querySelector('.pf-git-file-menu');
        const show = () => row.dispatchEvent(new w.MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 10, clientY: 10,
        }));
        show();
        assert.equal(menu().querySelectorAll('[role="menuitem"]').length, 2);
        menu().querySelector('[data-action="open"]').click();
        await Promise.resolve();
        assert.deepEqual(opened, [['ws1', 'src/a.js']]);
        assert.equal(menu(), null);
        show();
        git.workspaceId = 'ws2';
        menu().querySelector('[data-action="reveal"]').click();
        await Promise.resolve();
        assert.deepEqual(revealed, [['ws1', 'pkg/src/a.js', 'repo']]);

        show();
        w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(menu(), null);
        assert.equal(w.document.activeElement, row.querySelector('button'));
        git.status.changes[0].status = 'D';
        show();
        assert.equal([...menu().querySelectorAll('button')].every(b => b.disabled), true);
        w.dispatchEvent(new w.Event('blur'));
        assert.equal(menu(), null);
        assert.deepEqual(errors, []);
    } finally { w.close(); }
});