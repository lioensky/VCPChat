'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('popover displays enabled rules first without changing store or execution order', () => {
    const dom = new JSDOM('<div class="tavern-popover"><div class="tavern-popover-body"></div></div>', {
        runScripts: 'outside-only'
    });
    try {
        dom.window.eval(fs.readFileSync(path.join(__dirname, '../Tavernmodules/tavern-manager.js'), 'utf8'));
        const manager = dom.window.TavernManager;
        manager.popoverEl = dom.window.document.querySelector('.tavern-popover');
        const rules = [
            { id: 'off1', name: 'match off1', enabled: false },
            { id: 'on1', name: 'match on1', enabled: true },
            { id: 'off2', name: 'other off2', enabled: false },
            { id: 'default', name: 'match default' },
            { id: 'on2', name: 'other on2', enabled: true }
        ];
        manager.store = { version: 1, rules };
        const original = JSON.stringify(manager.store);
        const ids = () => Array.from(manager.popoverEl.querySelectorAll('.tavern-rule-row'), row => row.dataset.ruleId);
        manager._renderPopoverList();
        assert.deepEqual(ids(), ['on1', 'default', 'on2', 'off1', 'off2']);
        assert.deepEqual(Array.from(manager.popoverEl.querySelectorAll('input'), input => input.checked),
            [true, true, true, false, false]);
        assert.equal(JSON.stringify(manager.store), original);
        assert.equal(manager.store.rules, rules);
        assert.deepEqual(Array.from(manager.getActiveRulesForScope('agent'), rule => rule.id), ['on1', 'default', 'on2']);

        manager._renderPopoverList('match');
        assert.deepEqual(ids(), ['on1', 'default', 'off1']);
        assert.equal(JSON.stringify(manager.store), original);

        manager._renderPopoverList('missing');
        assert.deepEqual(ids(), []);
        assert.match(manager.popoverEl.textContent, /未找到匹配的规则/);

        rules.forEach(rule => { rule.enabled = false; });
        manager._renderPopoverList();
        assert.deepEqual(ids(), rules.map(rule => rule.id));
        rules.forEach(rule => { rule.enabled = true; });
        manager._renderPopoverList();
        assert.deepEqual(ids(), rules.map(rule => rule.id));

        manager.store.rules = [];
        manager._renderPopoverList();
        assert.match(manager.popoverEl.textContent, /还没有任何规则/);
    } finally {
        dom.window.close();
    }
});