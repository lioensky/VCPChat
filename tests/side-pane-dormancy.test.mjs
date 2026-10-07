// 副屏视图休眠：隐藏太久、离开所属对话、同时挂着的视图太多时只释放视图，标签留着，再显示时重新挂载并拿回之前存下的状态
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { selectDormantViews, DORMANCY_DEFAULTS } from '../modules/ui-system/side-pane/side-pane-dormancy.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = () => new Promise(resolve => setImmediate(resolve));

const candidate = (tabId, fields = {}) => ({
    tabId, shown: false, dormancy: 'none', busy: false, otherTopic: false,
    hiddenSince: 0, lastShownAt: 0, openedAt: 0, ...fields
});

test('policy: a view hidden past the threshold is released, an earlier one schedules the next check', () => {
    const { release, nextCheckAt } = selectDormantViews([
        candidate('old', { hiddenSince: 0 }),
        candidate('recent', { hiddenSince: 4 * 60_000 })
    ], { now: DORMANCY_DEFAULTS.hiddenMs });
    assert.deepEqual(release, [{ tabId: 'old', reason: 'hidden' }]);
    assert.equal(nextCheckAt, 9 * 60_000);
});

test('policy: shown, keep and busy views stay; busy ones are checked again later', () => {
    const now = 10 * 60_000;
    const { release, nextCheckAt } = selectDormantViews([
        candidate('shown', { shown: true, hiddenSince: null }),
        candidate('keep', { dormancy: 'keep' }),
        candidate('busy', { busy: true })
    ], { now });
    assert.deepEqual(release, []);
    assert.equal(nextCheckAt, now + DORMANCY_DEFAULTS.busyRetryMs);
});

test('policy: a view of another conversation sleeps sooner than an ordinary hidden one', () => {
    const { release } = selectDormantViews([
        candidate('elsewhere', { otherTopic: true }),
        candidate('here')
    ], { now: DORMANCY_DEFAULTS.otherTopicMs });
    assert.deepEqual(release, [{ tabId: 'elsewhere', reason: 'other-topic' }]);
});

test('policy: over the live-view limit the least recently shown idle views go first', () => {
    const { release } = selectDormantViews([
        candidate('a', { lastShownAt: 30, hiddenSince: 40 }),
        candidate('b', { lastShownAt: 10, hiddenSince: 40, busy: true }),
        candidate('c', { lastShownAt: 20, hiddenSince: 40 }),
        candidate('d', { shown: true, hiddenSince: null, lastShownAt: 50 }),
        candidate('e', { lastShownAt: 20, hiddenSince: 40, openedAt: 5 })
    ], { now: 50, maxLiveViews: 3 });
    assert.deepEqual(release, [{ tabId: 'c', reason: 'view-limit' }, { tabId: 'e', reason: 'view-limit' }]);
});

test('policy: when only busy views are over the limit it tries again later', () => {
    const { release, nextCheckAt } = selectDormantViews([
        candidate('a', { busy: true, hiddenSince: 0 }),
        candidate('b', { shown: true, hiddenSince: null })
    ], { now: 0, maxLiveViews: 1 });
    assert.deepEqual(release, []);
    assert.equal(nextCheckAt, DORMANCY_DEFAULTS.busyRetryMs);
});

function fixture(dormancy) {
    const dom = new JSDOM(`
        <aside id="vcpSidePane" class="vcp-side-pane">
            <div class="side-pane-tabs"></div>
            <div class="side-pane-content-container"></div>
        </aside>`);
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const mounts = [];
    const busy = new Set();
    const closeAnswers = new Map(); // tabId → 关闭确认的 promise（模拟确认框还开着）
    const provider = {
        mountTab(payload, view, context) {
            const record = { id: payload.id, view, context, restoredState: context.restoredState, disposed: 0, counter: 0 };
            mounts.push(record);
            context.occurrence.signal.addEventListener('abort', () => { record.aborted = true; });
            return {
                isBusy: () => busy.has(payload.id),
                captureState: () => ({ counter: record.counter }),
                requestClose: () => closeAnswers.get(payload.id) || { closed: true },
                dispose() { record.disposed++; }
            };
        }
    };
    const controller = createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        providers: { probe: provider },
        dormancy
    });
    controller.registerTabType({ kind: 'probe', label: 'Probe', provider });
    controller.registerTabType({ kind: 'pinned', label: 'Pinned', provider, dormancy: 'keep' });
    const live = id => mounts.filter(m => m.id === id && !m.disposed);
    return {
        controller, mounts, busy, live, closeAnswers,
        residency: () => controller.getViewResidency(),
        async cleanup() { await controller.dispose(); dom.window.close(); }
    };
}

const tab = (id, fields = {}) => ({ id, kind: 'probe', title: id, closable: true, scopeMode: 'global', ...fields });

test('a view hidden too long sleeps; the tab stays and remounts with what it saved', async () => {
    const h = fixture({ hiddenMs: 30 });
    try {
        await h.controller.openTab(tab('probe:a'));
        await h.controller.openTab(tab('probe:b'));
        const [first] = h.mounts;
        first.counter = 7;
        await sleep(80);
        await settle();

        assert.equal(first.disposed, 1, 'the hidden view was released');
        assert.equal(first.context.scope.disposed, true, 'its view scope went with it');
        assert.notEqual(first.aborted, true, 'the tab itself is still open');
        assert.equal(first.view.isConnected, false);
        assert.deepEqual(h.residency().live, ['probe:b']);
        assert.deepEqual(h.residency().dormant.map(({ tabId, reason }) => [tabId, reason]), [['probe:a', 'hidden']]);
        assert.ok(h.controller.getSnapshot().tabs.some(t => t.id === 'probe:a'));
        const diagnostics = h.controller.getDiagnostics().tabs.filter(t => t.kind === 'probe');
        assert.deepEqual(diagnostics.map(({ id, view, visible, dormantReason }) => ({ id, view, visible, dormantReason })), [
            { id: 'probe:a', view: 'dormant', visible: false, dormantReason: 'hidden' },
            { id: 'probe:b', view: 'live', visible: true, dormantReason: null }
        ]);
        assert.equal(diagnostics[1].hiddenMs, null);

        h.controller.activateTab('probe:a');
        await settle();
        const again = h.live('probe:a');
        assert.equal(again.length, 1, 'shown again, it mounts a fresh view');
        assert.notEqual(again[0], first);
        assert.deepEqual(again[0].restoredState, { counter: 7 });
        assert.equal(again[0].context.occurrence, first.context.occurrence, 'same tab occurrence across the sleep');
        assert.deepEqual(h.residency().dormant, []);
    } finally { await h.cleanup(); }
});

test('busy views and keep-type views do not sleep', async () => {
    const h = fixture({ hiddenMs: 20, busyRetryMs: 20 });
    try {
        await h.controller.openTab(tab('probe:busy'));
        await h.controller.openTab(tab('probe:keep', { kind: 'pinned' }));
        await h.controller.openTab(tab('probe:front'));
        h.busy.add('probe:busy');
        await sleep(60);
        await settle();
        assert.equal(h.live('probe:busy').length, 1);
        assert.equal(h.live('probe:keep').length, 1);

        h.busy.delete('probe:busy');
        await sleep(60);
        await settle();
        assert.equal(h.live('probe:busy').length, 0, 'once idle it sleeps at the next check');
        assert.equal(h.live('probe:keep').length, 1);
    } finally { await h.cleanup(); }
});

test('views beyond the live-view limit sleep least recently shown first', async () => {
    const h = fixture({ maxLiveViews: 2 });
    try {
        await h.controller.openTab(tab('probe:1'));
        await h.controller.openTab(tab('probe:2'));
        h.controller.activateTab('probe:1');
        await h.controller.openTab(tab('probe:3'));
        await settle();
        assert.deepEqual(h.residency().live.sort(), ['probe:1', 'probe:3']);
        assert.deepEqual(h.residency().dormant.map(d => [d.tabId, d.reason]), [['probe:2', 'view-limit']]);
    } finally { await h.cleanup(); }
});

test('a topic tab sleeps soon after its conversation is left', async () => {
    const h = fixture({ otherTopicMs: 0 });
    const topicA = { itemType: 'agent', itemId: 'a', topicId: 't1' };
    const topicB = { itemType: 'agent', itemId: 'a', topicId: 't2' };
    try {
        h.controller.setParent(topicA);
        await h.controller.openTab(tab('probe:topic', { scopeMode: 'topic', parent: topicA }));
        await h.controller.openTab(tab('probe:global'));
        h.controller.activateTab('probe:topic');
        h.controller.setParent(topicB);
        await settle();
        assert.deepEqual(h.residency().dormant.map(d => [d.tabId, d.reason]), [['probe:topic', 'other-topic']]);
        assert.equal(h.live('probe:global').length, 1, 'an ordinary hidden view keeps the long threshold');

        h.controller.setParent(topicA);
        h.controller.activateTab('probe:topic');
        await settle();
        assert.equal(h.live('probe:topic').length, 1, 'coming back and showing it remounts it');
    } finally { await h.cleanup(); }
});

test('closing a sleeping tab releases its occurrence without mounting it again', async () => {
    const h = fixture({ maxLiveViews: 1 });
    try {
        await h.controller.openTab(tab('probe:x'));
        await h.controller.openTab(tab('probe:y'));
        await settle();
        assert.deepEqual(h.residency().dormant.map(d => d.tabId), ['probe:x']);
        const [sleeping] = h.mounts;
        await h.controller.closeTab('probe:x');
        assert.equal(sleeping.aborted, true);
        assert.deepEqual(h.residency().dormant, []);
        assert.equal(h.mounts.filter(m => m.id === 'probe:x').length, 1);
    } finally { await h.cleanup(); }
});

test('diagnostics count what each live view still holds, including what its provider hung below it', async () => {
    const h = fixture({ hiddenMs: 30 });
    try {
        await h.controller.openTab(tab('probe:a'));
        await h.controller.openTab(tab('probe:b'));
        const [first, second] = h.mounts;
        const { scope } = second.context;
        scope.listen(second.view, 'click', () => {}, undefined, 'probe-click');
        scope.interval(() => {}, 60_000, 'probe-poll');
        // provider 自己的子 scope 里挂的也算到这个视图头上
        scope.child('probe-provider').listen(second.view, 'keydown', () => {}, undefined, 'probe-key');
        first.context.scope.listen(first.view, 'click', () => {}, undefined, 'probe-click');

        const live = h.controller.getDiagnostics().tabs.find(t => t.id === 'probe:b');
        assert.deepEqual(live.resources, { scopes: 2, resources: 3, byType: { listener: 2, interval: 1 } });

        await sleep(80);
        await settle();
        const dormant = h.controller.getDiagnostics().tabs.find(t => t.id === 'probe:a');
        assert.equal(dormant.view, 'dormant');
        assert.equal(dormant.resources, null, 'a sleeping view holds nothing');
        assert.doesNotMatch(JSON.stringify(h.controller.getDiagnostics()), /probe-click|probe-key/, 'only counts, no labels or content');
    } finally {
        await h.cleanup();
    }
});

test('policy: keep views do not take places under the live-view limit', () => {
    const { release } = selectDormantViews([
        candidate('chat-1', { dormancy: 'keep' }),
        candidate('chat-2', { dormancy: 'keep' }),
        candidate('chat-3', { dormancy: 'keep' }),
        candidate('browser', { dormancy: 'limit-only', hiddenSince: 0, lastShownAt: 10 }),
        candidate('plan', { shown: true, hiddenSince: null, lastShownAt: 20 })
    ], { now: 0, maxLiveViews: 2 });
    assert.deepEqual(release, []);
});

test('policy: limit-only views never sleep for being hidden, only for their own page limit', () => {
    const now = 60 * 60_000;
    const hiddenLong = selectDormantViews([
        candidate('browser', { dormancy: 'limit-only', hiddenSince: 0 })
    ], { now });
    assert.deepEqual(hiddenLong.release, []);

    const overLimit = selectDormantViews([
        candidate('browser-old', { dormancy: 'limit-only', lastShownAt: 1 }),
        candidate('browser-new', { dormancy: 'limit-only', lastShownAt: 2 }),
        candidate('shown', { shown: true, hiddenSince: null, lastShownAt: 3 })
    ], { now, maxLivePages: 1 });
    assert.deepEqual(overLimit.release, [{ tabId: 'browser-old', reason: 'view-limit' }]);
});

test('policy: opening many code and terminal tabs never pushes a live web page out', () => {
    const now = 60_000;
    const views = Array.from({ length: 10 }, (_, i) => candidate(`code-${i}`, { lastShownAt: 10 + i, hiddenSince: now }));
    const result = selectDormantViews([
        candidate('browser', { dormancy: 'limit-only', lastShownAt: 1 }),
        ...views
    ], { now, maxLiveViews: 8 });
    assert.equal(result.release.some(entry => entry.tabId === 'browser'), false, 'the oldest view is a page, but it is not evicted');
    assert.deepEqual(result.release.map(entry => entry.tabId), ['code-0', 'code-1']);
});

test('collapsing the pane does not put the current tab to sleep', async () => {
    const h = fixture({ hiddenMs: 30 });
    try {
        await h.controller.openTab(tab('probe:a'));
        h.controller.setVisible(false);
        await sleep(80);
        await settle();

        assert.deepEqual(h.residency().live, ['probe:a']);
        assert.deepEqual(h.residency().dormant, []);
        h.controller.setVisible(true);
        await settle();
        assert.equal(h.mounts.length, 1, 'expanding again shows the same view');
    } finally { await h.cleanup(); }
});

test('a tab whose close is waiting on the confirm dialog does not sleep, and closes once confirmed', async () => {
    const h = fixture({ hiddenMs: 30 });
    try {
        await h.controller.openTab(tab('probe:a'));
        await h.controller.openTab(tab('probe:b'));
        const answer = Promise.withResolvers();
        h.closeAnswers.set('probe:a', answer.promise);
        const closing = h.controller.closeTab('probe:a');
        await sleep(80); // 隐藏到期的检查在确认框开着时到了
        assert.deepEqual(h.residency().dormant, [], 'the tab being closed is not put to sleep');
        answer.resolve({ closed: true });
        await closing;
        assert.equal(h.controller.getSnapshot().tabs.some(t => t.id === 'probe:a'), false);
        assert.equal(h.mounts[0].disposed, 1);
    } finally {
        await h.cleanup();
    }
});
