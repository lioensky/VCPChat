'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
    const source = fs.readFileSync(path.join(__dirname, '../ProjectForgemodules/projectforge.js'), 'utf8');
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '莱恩', addEventListener(type, fn) { this[type] = fn; } });
        return elements.get(id);
    };
    const timers = new Map();
    let nextTimer = 0;
    const calls = [];
    let resolve;
    const context = {
        $: element,
        document: { addEventListener(type, fn) {
            const el = element('document:' + type);
            const previous = el.fn;
            el.fn = event => { previous?.(event); fn(event); };
        } },
        api: { projectForgeAcceptProject: (...args) => {
            calls.push(args);
            return new Promise(r => { resolve = r; });
        } },
        call: async p => { const result = await p; if (!result.success) throw new Error(result.error); },
        getSignature: () => '莱恩', debounce: fn => fn,
        loadProjects: async () => {}, selectProject: async () => {}, renderProjectList() {},
        state: { currentId: null }, toast() {},
        setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
        clearTimeout: id => timers.delete(id),
    };
    // 执行实际事件绑定函数的列表交互部分，避免启动整个 Electron 页面。
    const start = source.indexOf('function bindEvents() {');
    const end = source.indexOf("    document.querySelector('.tabs')", start);
    vm.runInNewContext(source.slice(start, end) + '\n}\nbindEvents();', context);
    const button = () => {
        const classes = new Set();
        return {
            dataset: { id: 'p-test' }, textContent: '待验收', disabled: false,
            classList: { add: s => classes.add(s), remove: s => classes.delete(s) },
            contains(target) { return target === this; },
            closest(selector) { return selector === '.project-accept' ? this : null; },
        };
    };
    const click = target => element('project-list').click({ target, stopPropagation() {} });
    return { element, timers, calls, button, click, finish: () => resolve({ success: true }) };
}

test('待验收徽标：第一次只确认，第二次提交，提交中不重复调用', async () => {
    const f = fixture(), btn = f.button();
    await f.click(btn);
    assert.equal(btn.textContent, '确认验收？');
    assert.equal(f.calls.length, 0);
    const pending = f.click(btn);
    assert.equal(btn.disabled, true);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], ['p-test', '莱恩']);
    await f.click(btn);
    assert.equal(f.calls.length, 1);
    f.finish();
    await pending;
});

test('超时、Escape及点击外部都撤销确认，不落库', async () => {
    for (const mode of ['timeout', 'escape', 'outside']) {
        const f = fixture(), btn = f.button();
        await f.click(btn);
        if (mode === 'timeout') [...f.timers.values()].at(-1)();
        if (mode === 'escape') f.element('document:keydown').fn({ key: 'Escape' });
        if (mode === 'outside') f.element('document:click').fn({ target: {} });
        assert.equal(btn.textContent, '待验收');
        assert.equal(f.calls.length, 0);
        await f.click(btn);
        assert.equal(f.calls.length, 0);
    }
});