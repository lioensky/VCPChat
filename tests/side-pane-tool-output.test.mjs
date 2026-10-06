import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { commandRunStatusLabel, createToolOutputSideProvider, formatRunDuration } from '../modules/ui-system/side-pane/toolOutputSideProvider.js';
import { getCommandRunsSource } from '../modules/ui-system/sources/terminal-command-runs.js';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test('formatRunDuration and status labels', () => {
    assert.equal(formatRunDuration({ startedAt: 1000, endedAt: 1400 }), '400 毫秒');
    assert.equal(formatRunDuration({ startedAt: 0, endedAt: 1500 }), '1.5 秒');
    assert.equal(formatRunDuration({ startedAt: 0, endedAt: 125000 }), '2 分 05 秒');
    assert.equal(formatRunDuration({ startedAt: 1000 }, 3000), '2.0 秒');
    assert.equal(commandRunStatusLabel('timed_out'), '已超时');
});

function makeEnv({ runs, details }) {
    const dom = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const state = { runs, details, gets: [], opened: [], toasts: [], watch: 0, copied: [] };
    let changed = null;
    let unsubscribed = false;
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text) => { state.copied.push(text); } } });
    const api = {
        terminalListCommandRuns: async () => ({ success: true, data: state.runs }),
        terminalGetCommandRun: async (id) => {
            state.gets.push(id);
            return state.details[id] ? { success: true, data: state.details[id] } : { success: false, error: '这条命令记录已被清理。' };
        },
        terminalWatchCommandRuns: async () => { state.watch += 1; return { success: true }; },
        onTerminalCommandRunChanged: (cb) => { changed = cb; return () => { unsubscribed = true; }; }
    };
    // 没有宽限期：最后一个持有者离开就立即取消订阅，方便断言
    getCommandRunsSource(api, { graceMs: 0 });
    const sidePaneController = {
        openTab: async (tab) => { state.opened.push(tab); return { focus() {} }; },
        setVisible() {}
    };
    const provider = createToolOutputSideProvider({ document: doc, api, sidePaneController, uiHelper: { showToastNotification: (m) => state.toasts.push(m) } });
    return { dom, doc, provider, state, view: doc.getElementById('view'), fire: (s) => changed?.(s), wasUnsubscribed: () => unsubscribed };
}

const RUNS = [
    { id: 'r2', command: 'npm test', status: 'running', startedAt: Date.now() - 2000, endedAt: null },
    { id: 'r1', command: 'git status', status: 'completed', startedAt: Date.now() - 9000, endedAt: Date.now() - 8000 }
];
const DETAILS = {
    r2: { ...RUNS[0], output: 'running tests…\n', truncated: false },
    r1: { ...RUNS[1], output: 'On branch main\n', truncated: true }
};

test('openToolOutputTab opens the singleton tab', async () => {
    const { provider, state } = makeEnv({ runs: RUNS, details: DETAILS });
    await provider.openToolOutputTab();
    assert.equal(state.opened[0].id, 'tool-output:main');
    assert.equal(state.opened[0].kind, 'tool-output');
});

test('mountTab follows the latest run, streams updates, and lets the user pick another', async () => {
    const { provider, state, view, fire, wasUnsubscribed } = makeEnv({ runs: RUNS, details: DETAILS });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    assert.equal(state.watch, 1);
    assert.deepEqual(state.gets, ['r2']);
    assert.equal(view.querySelector('.side-tool-output-text').textContent, 'running tests…\n');
    assert.match(view.querySelector('.side-tool-output-chip').textContent, /运行中/);
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'npm test');
    assert.equal(view.querySelectorAll('.side-tool-output-picker option').length, 2);

    // 输出增长与完成
    state.details.r2 = { ...RUNS[0], status: 'completed', endedAt: Date.now(), output: 'running tests…\nok\n', truncated: false };
    fire({ id: 'r2', command: 'npm test', status: 'completed', startedAt: RUNS[0].startedAt, endedAt: Date.now() });
    await wait(150);
    assert.match(view.querySelector('.side-tool-output-text').textContent, /ok/);
    assert.match(view.querySelector('.side-tool-output-chip').textContent, /已完成/);

    // 没手动选过：新命令自动跟过去
    state.details.r3 = { id: 'r3', command: 'echo hi', status: 'running', startedAt: Date.now(), endedAt: null, output: 'hi\n', truncated: false };
    fire({ id: 'r3', command: 'echo hi', status: 'running', startedAt: Date.now(), endedAt: null });
    await wait(150);
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'echo hi');

    // 手动选旧命令后，新命令不再抢焦点，并显示截断提示
    const picker = view.querySelector('.side-tool-output-picker');
    picker.value = 'r1';
    picker.dispatchEvent(new view.ownerDocument.defaultView.Event('change'));
    await wait();
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'git status');
    assert.equal(view.querySelector('.side-tool-output-notice').hidden, false);
    fire({ id: 'r4', command: 'later', status: 'running', startedAt: Date.now(), endedAt: null });
    await wait(150);
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'git status');

    // 复制
    view.querySelector('.side-tool-output-actions button').click();
    await wait();
    assert.deepEqual(state.copied, ['On branch main\n']);

    handle.dispose();
    assert.equal(wasUnsubscribed(), true);
    assert.equal(view.innerHTML, '');
});

test('openToolOutputTab with a runId selects that run in an already-mounted tab', async () => {
    const { provider, view } = makeEnv({ runs: RUNS, details: DETAILS });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    await provider.openToolOutputTab({ runId: 'r1' });
    await wait();
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'git status');
    handle.dispose();
});

test('a run requested before the tab mounts is honoured', async () => {
    const { provider, view } = makeEnv({ runs: RUNS, details: DETAILS });
    await provider.openToolOutputTab({ runId: 'r1' });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'git status');
    handle.dispose();
});

test('shows a helpful empty state when no command has run', async () => {
    const { provider, view } = makeEnv({ runs: [], details: {} });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    assert.equal(view.querySelector('.side-tool-output-empty').hidden, false);
    assert.match(view.querySelector('.side-tool-output-empty').textContent, /PowerShellExecutor/);
    assert.equal(view.querySelector('.side-tool-output-picker').disabled, true);
    handle.dispose();
});

test('scrolling up pauses following and freezes the output; returning to the bottom resumes with the latest', async () => {
    const initial = 'running tests…\n';
    const { provider, state, view, fire, dom } = makeEnv({ runs: RUNS, details: { r2: { ...RUNS[0], output: initial, truncated: false } } });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    const wrap = view.querySelector('.side-tool-output-scroll');
    const text = view.querySelector('.side-tool-output-text');
    const follow = view.querySelector('.side-tool-output-follow');
    let top = 0;
    Object.defineProperty(wrap, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(wrap, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(wrap, 'scrollTop', { get: () => top, set: (v) => { top = v; }, configurable: true });
    const scroll = (to) => { top = to; wrap.dispatchEvent(new dom.window.Event('scroll')); };
    const update = async (output) => {
        state.details.r2 = { ...RUNS[0], output, truncated: false };
        fire({ id: 'r2', command: 'npm test', status: 'running', startedAt: RUNS[0].startedAt, endedAt: null });
        await wait(150);
    };

    scroll(800); // 跟随中滚到底
    assert.equal(follow.hidden, true);
    scroll(300); // 向上滚：暂停
    assert.equal(follow.hidden, false);
    assert.equal(follow.getAttribute('aria-label'), '回到底部');

    await update('first\nsecond\n');
    assert.equal(text.textContent, 'running tests…\n', 'output stays frozen while paused');

    scroll(800); // 手动滚回底部：恢复并补上最新
    assert.equal(follow.hidden, true);
    assert.equal(text.textContent, 'first\nsecond\n');

    scroll(300);
    await update('third\n');
    follow.click(); // 点箭头恢复
    assert.equal(text.textContent, 'third\n');
    assert.equal(top, 1000);
    assert.equal(follow.hidden, true);
    handle.dispose();
});

test('a failed output query shows an inline error with a retry instead of a toast', async () => {
    const { provider, state, view } = makeEnv({ runs: RUNS, details: {} });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    const bar = view.querySelector('.side-tool-output-error');
    assert.equal(bar.hidden, false);
    assert.match(bar.textContent, /已被清理/);
    assert.deepEqual(state.toasts, []);

    state.details.r2 = { ...RUNS[0], output: 'back\n', truncated: false };
    view.querySelector('.side-tool-output-error-retry').click();
    await wait();
    assert.equal(bar.hidden, true);
    assert.equal(view.querySelector('.side-tool-output-text').textContent, 'back\n');
    handle.dispose();
});
