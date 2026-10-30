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
test('local capsule writes target override, supports keyboard and rolls back failure', async () => {
    const dom = new JSDOM('<div class="tavern-popover"><div class="tavern-popover-body"></div></div>', {
        runScripts: 'outside-only',
    });
    try {
        const calls = [];
        let fail = false;
        let globalEnabled = false;
        const globalCalls = [];
        dom.window.electronAPI = {
            updateConversationOverride: async (owner, patch) => {
                calls.push(JSON.parse(JSON.stringify({ owner, patch })));
                return fail ? { success: false, error: 'disk full' } : { success: true };
            },
            tavernToggleRuleEnabled: async key => {
                globalCalls.push(key);
                if (fail) return { success: false, error: 'disk full' };
                globalEnabled = !globalEnabled;
                return { success: true, store: { rules: [
                    { id: 'r', source: 'official', enabled: globalEnabled },
                ] } };
            },
            tavernSaveRules: () => { throw new Error('local UI must not write global store'); },
        };
        dom.window.eval(fs.readFileSync(path.join(__dirname, '../Tavernmodules/tavern-manager.js'), 'utf8'));
        await new Promise(resolve => setImmediate(resolve));
        const manager = dom.window.TavernManager;
        manager.popoverEl = dom.window.document.querySelector('.tavern-popover');
        manager.overrideOwner = { type: 'group', id: 'g' };
        manager.store = { rules: [{
            id: 'r', name: 'rule', enabled: false, globalEnabled: false,
            overrideEnabled: null, overrideKey: 'official:r',
        }] };
        manager._renderPopoverList();
        const capsule = manager.popoverEl.querySelector('[role="radiogroup"]');
        const buttons = [...capsule.querySelectorAll('[role="radio"]')];
        assert.deepEqual(buttons.map(button => button.textContent), ['全局', '开启', '关闭']);
        assert.equal(capsule.dataset.value, 'inherit');
        buttons[1].click();
        assert.equal(capsule.getAttribute('aria-busy'), 'true');
        buttons[2].click(); // 保存期间不重复发请求
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls[0], {
            owner: { type: 'group', id: 'g' },
            patch: { kind: 'rule', key: 'official:r', value: true },
        });
        assert.equal(manager.store.rules[0].enabled, true);
        assert.equal(calls.length, 1);
        fail = true;
        buttons[2].click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(capsule.dataset.value, 'true');
        assert.equal(buttons[1].getAttribute('aria-checked'), 'true');
        assert.equal(capsule.hasAttribute('aria-busy'), false);
        fail = false;
        buttons[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(capsule.dataset.value, 'inherit');
        assert.equal(calls.at(-1).patch.value, null);
        buttons[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(capsule.dataset.value, 'false');
        assert.equal(calls.at(-1).patch.value, false);
        assert.equal(buttons.filter(button => button.tabIndex === 0).length, 1);
        buttons[0].click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(capsule.dataset.value, 'inherit');
        assert.equal(globalCalls.length, 0, 'first click only restores inheritance');
        assert.equal(capsule.dataset.globalEnabled, 'false');
        buttons[0].click();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(globalCalls, ['official:r']);
        assert.equal(capsule.dataset.globalEnabled, 'true');
        assert.equal(manager.store.rules[0].enabled, true);
        fail = true;
        buttons[0].click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(capsule.dataset.globalEnabled, 'true', 'failed global write retains confirmed state');
        assert.equal(manager.store.rules[0].enabled, true);
        fail = false;
        buttons[0].click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(capsule.dataset.globalEnabled, 'false');
        assert.equal(manager.store.rules[0].enabled, false);
    } finally { dom.window.close(); }
});