import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { commandRunStatusLabel, createToolOutputSideProvider, formatRunDuration } from '../modules/ui-system/side-pane/toolOutputSideProvider.js';
import { getCommandRunsSource } from '../modules/ui-system/sources/terminal-command-runs.js';
import { waitFor } from './helpers/wait-for.mjs';

// 只冲掉 IPC stub 的 promise；setImmediate 不被 mock.timers 接管
// 断言失败时也拆掉挂着的标签，否则运行中命令的走秒定时器会让进程挂住
const live = new Set();
afterEach(async () => {
    mock.timers.reset();
    for (const handle of [...live]) await handle.dispose();
});

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test('formatRunDuration switches units by magnitude; every status has its own label', () => {
    const unit = (text) => text.replace(/[\d.\s]/g, '');
    const ms = formatRunDuration({ startedAt: 1000, endedAt: 1400 });
    const sec = formatRunDuration({ startedAt: 0, endedAt: 1500 });
    const min = formatRunDuration({ startedAt: 0, endedAt: 125000 });
    assert.match(ms, /^400\D/);
    assert.match(sec, /^1\.5\D/);
    assert.match(min, /^2\D+05\D/);
    assert.notEqual(unit(ms), unit(sec), 'below 1s uses a different unit than seconds');
    assert.notEqual(unit(min), unit(sec), 'a minute or more adds a minutes unit');
    // 没结束的命令按传入的 now 计时
    assert.match(formatRunDuration({ startedAt: 1000 }, 3000), /^2\.0\D/);
    assert.equal(formatRunDuration({}), '');

    const statuses = ['running', 'completed', 'cancelled', 'timed_out', 'spawn_error'];
    const labels = statuses.map(commandRunStatusLabel);
    assert.ok(labels.every(Boolean));
    assert.equal(new Set(labels).size, statuses.length);
    assert.equal(commandRunStatusLabel('mystery'), 'mystery', 'unknown statuses fall back to the raw value');
});

function makeEnv({ runs, details, runningReloadMs = 60 }) {
    const dom = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const state = { runs, details, gets: [], opened: [], toasts: [], watch: 0, copied: [] };
    let changed = null;
    let unsubscribed = false;
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text) => { state.copied.push(text); } } });
    const api = {
        terminalListCommandRuns: async () => (state.listError ? { success: false, error: state.listError } : { success: true, data: state.runs }),
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
    const provider = createToolOutputSideProvider({ document: doc, api, sidePaneController, runningReloadMs, uiHelper: { showToastNotification: (m) => state.toasts.push(m) } });
    const mountTab = provider.mountTab.bind(provider);
    provider.mountTab = async (...args) => {
        const handle = await mountTab(...args);
        const dispose = handle.dispose.bind(handle);
        handle.dispose = () => { live.delete(handle); return dispose(); };
        live.add(handle);
        return handle;
    };
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
    assert.equal(view.querySelector('.side-tool-output-chip').dataset.status, 'running');
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'npm test');
    assert.equal(view.querySelectorAll('.side-tool-output-picker option').length, 2);

    // 输出增长与完成
    state.details.r2 = { ...RUNS[0], status: 'completed', endedAt: Date.now(), output: 'running tests…\nok\n', truncated: false };
    fire({ id: 'r2', command: 'npm test', status: 'completed', startedAt: RUNS[0].startedAt, endedAt: Date.now() });
    await waitFor(() => /ok/.test(view.querySelector('.side-tool-output-text').textContent), { message: 'output did not grow' });
    assert.equal(view.querySelector('.side-tool-output-chip').dataset.status, 'completed');

    // 没手动选过：新命令自动跟过去
    state.details.r3 = { id: 'r3', command: 'echo hi', status: 'running', startedAt: Date.now(), endedAt: null, output: 'hi\n', truncated: false };
    fire({ id: 'r3', command: 'echo hi', status: 'running', startedAt: Date.now(), endedAt: null });
    await waitFor(() => view.querySelector('.side-tool-output-command').textContent === 'echo hi', { message: 'did not follow the new run' });
    await waitFor(() => state.gets.includes('r3'));

    // 手动选旧命令后，新命令不再抢焦点，并显示截断提示
    const picker = view.querySelector('.side-tool-output-picker');
    picker.value = 'r1';
    picker.dispatchEvent(new view.ownerDocument.defaultView.Event('change'));
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'git status');
    await waitFor(() => view.querySelector('.side-tool-output-notice').hidden === false, { message: 'truncation notice not shown' });
    const picks = state.gets.length;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        fire({ id: 'r4', command: 'later', status: 'running', startedAt: Date.now(), endedAt: null });
        mock.timers.tick(1000);
        await settle();
        assert.equal(view.querySelector('.side-tool-output-command').textContent, 'git status');
        assert.equal(view.querySelector('.side-tool-output-picker').value, 'r1');
        assert.equal(state.gets.length, picks, 'a new run does not steal a manual pick');
    } finally {
        mock.timers.reset();
    }

    // 复制
    view.querySelector('[data-action="copy"]').click();
    await waitFor(() => state.copied.length === 1, { message: 'nothing copied' });
    assert.deepEqual(state.copied, ['On branch main\n']);

    await handle.dispose();
    assert.equal(wasUnsubscribed(), true);
    assert.equal(view.innerHTML, '');
});

test('openToolOutputTab with a runId selects that run in an already-mounted tab', async () => {
    const { provider, view } = makeEnv({ runs: RUNS, details: DETAILS });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    await provider.openToolOutputTab({ runId: 'r1' });
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'git status');
    await handle.dispose();
});

test('a run picked in a mounted tab does not stick to the tab after it sleeps and remounts', async () => {
    const { provider, state, view } = makeEnv({ runs: RUNS, details: DETAILS });
    const first = await provider.mountTab({ id: 'tool-output:main' }, view);
    await provider.openToolOutputTab({ runId: 'r1' });
    await waitFor(() => state.gets.includes('r1'));
    await first.dispose(); // 休眠
    const again = await provider.mountTab({ id: 'tool-output:main' }, view);
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'npm test', 'follows the latest run again');
    await again.dispose();
});

test('a run requested before the tab mounts is honoured', async () => {
    const { provider, view } = makeEnv({ runs: RUNS, details: DETAILS });
    await provider.openToolOutputTab({ runId: 'r1' });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    assert.equal(view.querySelector('.side-tool-output-command').textContent, 'git status');
    await handle.dispose();
});

test('shows a helpful empty state when no command has run', async () => {
    const { provider, view } = makeEnv({ runs: [], details: {} });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    assert.equal(view.querySelector('.side-tool-output-empty').hidden, false);
    assert.equal(view.querySelector('.side-tool-output-picker').disabled, true);
    await handle.dispose();
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
        const reads = state.gets.length;
        state.details.r2 = { ...RUNS[0], output, truncated: false };
        fire({ id: 'r2', command: 'npm test', status: 'running', startedAt: RUNS[0].startedAt, endedAt: null });
        // 读到了新输出（读取完成后才会渲染）
        await waitFor(() => state.gets.length > reads);
        await settle();
    };

    scroll(800); // 跟随中滚到底
    assert.equal(follow.hidden, true);
    scroll(300); // 向上滚：暂停
    assert.equal(follow.hidden, false);
    assert.ok(follow.getAttribute('aria-label'));

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
    await handle.dispose();
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
    await waitFor(() => bar.hidden === true, { message: 'retry did not clear the error' });
    assert.equal(view.querySelector('.side-tool-output-text').textContent, 'back\n');
    await handle.dispose();
});

test('a hidden tab keeps only the latest update and catches up when shown again', async () => {
    const { provider, state, view, fire } = makeEnv({ runs: RUNS, details: DETAILS });
    let visible = true;
    // 挂载前就接管定时器：走秒的 interval 要由同一套（假）计时器创建和清除
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view, { occurrence: { isVisible: () => visible } });
    assert.deepEqual(state.gets, ['r2']);
    try {
        visible = false;
        handle.suspend();
        const startedAt = Date.now();
        state.details.r3 = { id: 'r3', command: 'echo hi', status: 'running', startedAt, endedAt: null, output: 'hi\n', truncated: false };
        fire({ id: 'r3', command: 'echo hi', status: 'running', startedAt, endedAt: null });
        mock.timers.tick(1000);
        await settle();
        state.details.r3 = { ...state.details.r3, status: 'completed', endedAt: Date.now(), output: 'hi\nbye\n' };
        fire({ id: 'r3', command: 'echo hi', status: 'completed', startedAt, endedAt: Date.now() });
        mock.timers.tick(1000);
        await settle();
        // 藏着的时候不读输出、不重画
        assert.deepEqual(state.gets, ['r2']);
        assert.equal(view.querySelector('.side-tool-output-command').textContent, 'npm test');

        visible = true;
        handle.resume();
        mock.timers.tick(60);
        await settle();
        // 重新显示时按最新一份列表跟到新命令，只读一次输出
        assert.equal(view.querySelector('.side-tool-output-command').textContent, 'echo hi');
        assert.equal(view.querySelector('.side-tool-output-chip').dataset.status, 'completed');
        assert.equal(view.querySelector('.side-tool-output-text').textContent, 'hi\nbye\n');
        mock.timers.tick(1000);
        await settle();
        assert.deepEqual(state.gets, ['r2', 'r3']);
    } finally {
        await handle.dispose();
        mock.timers.reset();
    }
});

test('a command that keeps printing is re-read at most once per interval, with one read in flight', async (t) => {
    const { provider, state, view, fire } = makeEnv({ runs: RUNS, details: { r2: { ...RUNS[0], output: 'a\n', truncated: false } }, runningReloadMs: 800 });
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    t.after(() => mock.timers.reset());
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    await settle();
    const before = state.gets.length;
    for (let i = 0; i < 6; i += 1) {
        state.details.r2 = { ...RUNS[0], output: `line ${i}\n`, truncated: false };
        fire({ id: 'r2', command: 'npm test', status: 'running', startedAt: RUNS[0].startedAt, endedAt: null });
        mock.timers.tick(100);
        await settle();
    }
    assert.equal(state.gets.length, before, 'no re-read inside the interval');
    mock.timers.tick(199);
    await settle();
    assert.equal(state.gets.length, before, 'still none just before the interval ends');
    mock.timers.tick(1);
    await settle();
    assert.equal(state.gets.length, before + 1, 'one re-read after the interval');
    assert.equal(view.querySelector('.side-tool-output-text').textContent, 'line 5\n', 'and it shows the latest output');
    mock.timers.tick(800);
    await settle();
    assert.equal(state.gets.length, before + 1, 'no further reads without new output');
    await handle.dispose();
});

test('a failed command list shows an error with a retry, not "no commands yet"', async () => {
    const { provider, state, view } = makeEnv({ runs: RUNS, details: DETAILS });
    state.listError = '终端服务未启动';
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    assert.equal(view.querySelector('.side-tool-output-empty').hidden, true);
    const bar = view.querySelector('.side-tool-output-error');
    assert.equal(bar.hidden, false);
    assert.match(bar.textContent, /终端服务未启动/);

    state.listError = '';
    view.querySelector('.side-tool-output-error-retry').click();
    await waitFor(() => bar.hidden && /^running tests…/.test(view.querySelector('.side-tool-output-text').textContent), { message: 'retry never loaded the command list' });
    assert.match(view.querySelector('.side-tool-output-text').textContent, /^running tests…/);
    await handle.dispose();
});

test('a failed reload while a command runs keeps the output on screen', async () => {
    const { provider, state, view, fire } = makeEnv({ runs: RUNS, details: { ...DETAILS } });
    const handle = await provider.mountTab({ id: 'tool-output:main' }, view);
    const shown = view.querySelector('.side-tool-output-text').textContent;
    assert.match(shown, /^running tests…/);
    delete state.details.r2;
    fire({ ...RUNS[0], updatedAt: Date.now() });
    await waitFor(() => !view.querySelector('.side-tool-output-error').hidden, { message: 'the failed reload never surfaced' });
    assert.equal(view.querySelector('.side-tool-output-text').textContent, shown, 'the last output stays');
    await handle.dispose();
});
