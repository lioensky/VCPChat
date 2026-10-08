const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
require('../modules/ui-system/state-channel.js');
const notificationCenter = require('../modules/notificationCenter.js');

const COLLAPSE_KEY = 'vcp-notification-resolved-collapsed';

function fixture() {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="notificationPendingBanner" hidden>
            <button data-action="jump-next"></button>
            <strong data-role="pending-count">0</strong>
            <button data-action="reject-all"><span data-role="label">全部拒绝</span></button>
            <button data-action="approve-all"><span data-role="label">全部允许</span></button>
        </div>
        <div id="notificationToolbar">
            <button data-filter="all" aria-pressed="true">全部<span class="notification-chip-count"></span></button>
            <button data-filter="pending" aria-pressed="false">待审批<span class="notification-chip-count"></span></button>
            <button data-filter="info" aria-pressed="false">通知<span class="notification-chip-count"></span></button>
            <button data-filter="error" aria-pressed="false">错误<span class="notification-chip-count"></span></button>
            <button data-filter="resolved" aria-pressed="false">已处理<span class="notification-chip-count"></span></button>
        </div>
        <ul id="notificationsList"></ul>
    </body>`, { pretendToBeVisual: true, url: 'file:///notification.html' });
    const { document } = dom.window;
    const store = new Map();
    const storage = {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => void store.set(key, String(value)),
    };
    return {
        dom,
        document,
        store,
        storage,
        list: document.getElementById('notificationsList'),
        banner: document.getElementById('notificationPendingBanner'),
        toolbar: document.getElementById('notificationToolbar'),
    };
}

function mountFixture(env = fixture()) {
    const center = notificationCenter.mount({
        document: env.document,
        list: env.list,
        banner: env.banner,
        toolbar: env.toolbar,
        storage: env.storage,
        requestFrame: callback => callback(),
    });
    return { ...env, center };
}

// 与 notificationRenderer 生成的卡片保持同一套数据属性 / 按钮 class。
function addCard(env, { state = 'info', tone = 'neutral', audit = false, approvable = state === 'pending' } = {}) {
    const item = env.document.createElement('li');
    item.className = 'notification-item';
    item.dataset.notificationState = state;
    item.dataset.notificationTone = tone;
    if (approvable) {
        const settle = approved => {
            item.dataset.notificationTone = approved ? 'success' : 'muted';
            item.dataset.notificationState = 'resolved';
            item.dataset.decision = approved ? 'approved' : 'rejected';
        };
        const allow = env.document.createElement('button');
        allow.className = 'vcp-btn vcp-btn-success';
        allow.addEventListener('click', () => settle(true));
        const reject = env.document.createElement('button');
        reject.className = 'vcp-btn vcp-btn-danger';
        reject.addEventListener('click', () => settle(false));
        item.append(allow, reject);
        if (audit) {
            const auditButton = env.document.createElement('button');
            auditButton.className = 'vcp-btn vcp-btn-audit';
            item.appendChild(auditButton);
        }
    }
    env.list.prepend(item);
    return item;
}

const sectionHeader = (env, id) => env.list.querySelector(`.notification-section[data-section="${id}"]`);
const chip = (env, key) => env.toolbar.querySelector(`[data-filter="${key}"]`);

test('mount creates hidden section headers and an empty placeholder', () => {
    const env = mountFixture();
    ['pending', 'info', 'resolved'].forEach(id => assert.equal(sectionHeader(env, id).hidden, true, id));
    const empty = env.list.querySelector('.notification-empty');
    assert.equal(empty.hidden, false);
    assert.equal(empty.querySelector('.notification-empty-text').textContent, '暂无通知');
    assert.equal(env.banner.hidden, true);
    assert.equal(env.list.dataset.filter, 'all');
    env.center.dispose();
});

test('sections show per-state counts and the banner tracks pending approvals', () => {
    const env = mountFixture();
    addCard(env, { state: 'pending', tone: 'warn' });
    addCard(env, { state: 'pending', tone: 'warn' });
    addCard(env, { state: 'info', tone: 'success' });
    addCard(env, { state: 'resolved', tone: 'muted' });
    env.center.update();

    assert.deepEqual(
        { ...env.center.getCounts() },
        { all: 4, pending: 2, info: 1, resolved: 1, error: 0 },
    );
    const count = id => sectionHeader(env, id).querySelector('.notification-section-count').textContent;
    assert.equal(count('pending'), '2');
    assert.equal(count('info'), '1');
    assert.equal(count('resolved'), '1');
    ['pending', 'info', 'resolved'].forEach(id => assert.equal(sectionHeader(env, id).hidden, false, id));
    assert.equal(env.banner.hidden, false);
    assert.equal(env.banner.querySelector('[data-role="pending-count"]').textContent, '2');
    assert.equal(env.list.querySelector('.notification-empty').hidden, true);
    // 计数为 0 的 chip 不显示数字，「全部」永远不显示数字
    assert.equal(chip(env, 'all').querySelector('.notification-chip-count').textContent, '');
    assert.equal(chip(env, 'pending').querySelector('.notification-chip-count').textContent, '2');
    assert.equal(chip(env, 'error').querySelector('.notification-chip-count').textContent, '');
    env.center.dispose();
});

test('the observer regroups automatically when an approval settles', async () => {
    const env = mountFixture();
    const item = addCard(env, { state: 'pending', tone: 'warn' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(env.banner.hidden, false);

    item.dataset.notificationState = 'resolved';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(env.banner.hidden, true);
    assert.equal(env.center.getCounts().resolved, 1);
    env.center.dispose();
});

test('filter chips drive list.dataset.filter and aria-pressed', () => {
    const env = mountFixture();
    addCard(env, { state: 'pending', tone: 'warn' });
    addCard(env, { state: 'info', tone: 'error' });
    addCard(env, { state: 'resolved', tone: 'muted' });
    env.center.update();

    chip(env, 'error').click();
    assert.equal(env.center.getFilter(), 'error');
    assert.equal(env.list.dataset.filter, 'error');
    assert.equal(chip(env, 'error').getAttribute('aria-pressed'), 'true');
    assert.equal(chip(env, 'all').getAttribute('aria-pressed'), 'false');
    // 筛选状态下不显示分组标题
    ['pending', 'info', 'resolved'].forEach(id => assert.equal(sectionHeader(env, id).hidden, true, id));
    assert.equal(env.list.querySelector('.notification-empty').hidden, true);

    // 「通知」只留普通通知，计数不含待审批和已处理
    chip(env, 'info').click();
    assert.equal(env.list.dataset.filter, 'info');
    assert.equal(chip(env, 'info').getAttribute('aria-pressed'), 'true');
    assert.equal(chip(env, 'info').querySelector('.notification-chip-count').textContent, '1');

    env.center.setFilter('bogus');
    assert.equal(env.center.getFilter(), 'all');
    assert.equal(env.list.dataset.filter, 'all');
    env.center.dispose();
});

test('a filter with no matches shows the empty placeholder', () => {
    const env = mountFixture();
    addCard(env, { state: 'info', tone: 'success' });
    env.center.update();

    env.center.setFilter('pending');
    const empty = env.list.querySelector('.notification-empty');
    assert.equal(empty.hidden, false);
    assert.equal(empty.querySelector('.notification-empty-text').textContent, '没有符合条件的通知');
    env.center.dispose();
});

test('resolved section is collapsed by default and the choice is persisted', () => {
    const env = mountFixture();
    addCard(env, { state: 'resolved', tone: 'muted' });
    env.center.update();

    assert.equal(env.list.classList.contains('resolved-collapsed'), true);
    const toggle = sectionHeader(env, 'resolved').querySelector('.notification-section-title');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');

    toggle.click();
    assert.equal(env.list.classList.contains('resolved-collapsed'), false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(env.store.get(COLLAPSE_KEY), 'false');

    // 「已处理」筛选下始终展开，与折叠偏好无关
    toggle.click();
    assert.equal(env.list.classList.contains('resolved-collapsed'), true);
    env.center.setFilter('resolved');
    assert.equal(env.list.classList.contains('resolved-collapsed'), false);
    env.center.dispose();
});

test('a stored expanded preference is honoured on mount', () => {
    const env = fixture();
    env.store.set(COLLAPSE_KEY, 'false');
    const mounted = mountFixture(env);
    assert.equal(mounted.list.classList.contains('resolved-collapsed'), false);
    mounted.center.dispose();
});

test('the resolved clear button removes only resolved cards', () => {
    const env = mountFixture();
    const pending = addCard(env, { state: 'pending', tone: 'warn' });
    const info = addCard(env, { state: 'info' });
    addCard(env, { state: 'resolved', tone: 'muted' });
    addCard(env, { state: 'resolved', tone: 'success' });
    env.center.update();

    sectionHeader(env, 'resolved').querySelector('.notification-section-clear').click();
    assert.equal(env.center.getCounts().resolved, 0);
    assert.equal(env.list.contains(pending), true);
    assert.equal(env.list.contains(info), true);
    assert.equal(sectionHeader(env, 'resolved').hidden, true);
    env.center.dispose();
});

test('jumpToPending cycles through pending cards, skipping busy ones', () => {
    const env = mountFixture();
    const first = addCard(env, { state: 'pending', tone: 'warn' });
    const busy = addCard(env, { state: 'pending', tone: 'warn' });
    busy.classList.add('is-busy');
    const third = addCard(env, { state: 'pending', tone: 'warn' });
    const scrolled = [];
    [first, busy, third].forEach(item => {
        item.scrollIntoView = options => scrolled.push([item, options.block]);
    });
    env.center.update();

    // prepend：列表顺序为 third, busy, first
    assert.equal(env.center.jumpToPending(1), third);
    assert.equal(env.center.jumpToPending(1), first);
    assert.equal(env.center.jumpToPending(1), third);
    assert.equal(env.center.jumpToPending(-1), first);
    assert.equal(third.classList.contains('notification-flash'), true);
    assert.equal(scrolled.length, 4);
    assert.equal(scrolled[0][1], 'center');

    env.banner.querySelector('[data-action="jump-next"]').click();
    assert.equal(scrolled.length, 5);
    env.center.dispose();
});

test('jumpToPending leaves narrowing filters so the target is visible', () => {
    const env = mountFixture();
    addCard(env, { state: 'pending', tone: 'warn' });
    addCard(env, { state: 'info', tone: 'error' });
    env.center.setFilter('error');
    assert.ok(env.center.jumpToPending(1));
    assert.equal(env.center.getFilter(), 'all');
    env.center.dispose();

    const none = mountFixture();
    assert.equal(none.center.jumpToPending(1), null);
    none.center.dispose();
});

test('bulk reject needs a second click to confirm, then settles every pending card', () => {
    const env = mountFixture();
    const a = addCard(env, { state: 'pending', tone: 'warn' });
    const b = addCard(env, { state: 'pending', tone: 'warn' });
    env.center.update();

    const button = env.banner.querySelector('[data-action="reject-all"]');
    const label = button.querySelector('[data-role="label"]');
    button.click();
    assert.equal(label.textContent, '确认拒绝 2 项');
    assert.equal(button.classList.contains('is-confirming'), true);
    assert.equal(a.dataset.notificationState, 'pending');
    assert.equal(b.dataset.notificationState, 'pending');

    button.click();
    assert.equal(a.dataset.decision, 'rejected');
    assert.equal(b.dataset.decision, 'rejected');
    assert.equal(label.textContent, '全部拒绝');
    assert.equal(button.classList.contains('is-confirming'), false);
    assert.equal(env.center.getCounts().pending, 0);
    assert.equal(env.banner.hidden, true);
    env.center.dispose();
});

test('the bulk confirmation lapses after the confirm window', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const env = mountFixture();
    const item = addCard(env, { state: 'pending', tone: 'warn' });
    env.center.update();

    const button = env.banner.querySelector('[data-action="approve-all"]');
    button.click();
    assert.equal(button.classList.contains('is-confirming'), true);
    t.mock.timers.tick(3000);
    assert.equal(button.classList.contains('is-confirming'), false);
    assert.equal(button.querySelector('[data-role="label"]').textContent, '全部允许');
    assert.equal(item.dataset.notificationState, 'pending');
    env.center.dispose();
});

test('bulk approve skips requests that need an audit and reports them', () => {
    const env = mountFixture();
    const plain = addCard(env, { state: 'pending', tone: 'warn' });
    const audited = addCard(env, { state: 'pending', tone: 'warn', audit: true });
    env.center.update();

    const button = env.banner.querySelector('[data-action="approve-all"]');
    button.click();
    assert.equal(button.querySelector('[data-role="label"]').textContent, '确认允许 1 项');
    button.click();

    assert.equal(plain.dataset.decision, 'approved');
    assert.equal(audited.dataset.notificationState, 'pending');
    assert.equal(env.banner.hidden, false);
    assert.equal(env.banner.querySelector('[data-role="pending-count"]').textContent, '1');

    env.center.update();
    assert.equal(button.disabled, true);
    assert.deepEqual({ ...env.center.decideAll('approve') }, { handled: 0, skipped: 1 });
    // 只剩需审计项时，批量允许不进入确认态
    button.click();
    assert.equal(button.classList.contains('is-confirming'), false);
    // 批量拒绝不受审计限制
    assert.deepEqual({ ...env.center.decideAll('reject') }, { handled: 1, skipped: 0 });
    assert.equal(audited.dataset.decision, 'rejected');
    env.center.dispose();
});

test('bulk approve leaves requests that would delete code for one-by-one review', () => {
    const env = mountFixture();
    const plain = addCard(env, { state: 'pending', tone: 'warn' });
    const deletion = addCard(env, { state: 'pending', tone: 'warn' });
    const section = env.document.createElement('div');
    section.className = 'notification-approval-preview-section is-deletion';
    deletion.appendChild(section);
    env.center.update();

    const button = env.banner.querySelector('[data-action="approve-all"]');
    assert.equal(button.getAttribute('title'), '1 项会删除代码或需要审计，请逐条处理');
    assert.deepEqual({ ...env.center.decideAll('approve') }, { handled: 1, skipped: 1 });
    assert.equal(plain.dataset.decision, 'approved');
    assert.equal(deletion.dataset.notificationState, 'pending');
    env.center.update();
    assert.equal(button.disabled, true);
    env.center.dispose();
});

test('settled cards are capped while pending approvals are never trimmed', () => {
    const env = mountFixture();
    const pending = addCard(env, { state: 'pending', tone: 'warn' });
    for (let index = 0; index < notificationCenter.MAX_SETTLED_ITEMS + 25; index += 1) {
        addCard(env, { state: index % 2 ? 'resolved' : 'info', tone: 'neutral' });
    }
    // 最早加入的待审批卡片位于列表最末（最旧），仍需保留
    env.center.update();
    const counts = env.center.getCounts();
    assert.equal(counts.info + counts.resolved, notificationCenter.MAX_SETTLED_ITEMS);
    assert.equal(counts.pending, 1);
    assert.equal(env.list.contains(pending), true);
    env.center.dispose();
});

test('dispose removes injected nodes and stops reacting to changes', async () => {
    const env = mountFixture();
    const button = env.banner.querySelector('[data-action="reject-all"]');
    addCard(env, { state: 'pending', tone: 'warn' });
    env.center.update();
    env.center.dispose();

    assert.equal(env.list.querySelector('.notification-section'), null);
    assert.equal(env.list.querySelector('.notification-empty'), null);

    button.click();
    assert.equal(button.classList.contains('is-confirming'), false);
    chip(env, 'error').click();
    assert.equal(env.list.dataset.filter, 'all');

    addCard(env, { state: 'pending', tone: 'warn' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(env.banner.querySelector('[data-role="pending-count"]').textContent, '1');
});

test('mount without a list is a harmless no-op', () => {
    const { document } = new JSDOM('<!doctype html><body></body>').window;
    const center = notificationCenter.mount({ document });
    assert.doesNotThrow(() => center.update());
    assert.doesNotThrow(() => center.dispose());
    assert.deepEqual({ ...center.getCounts() }, {});
});

test('bell button badge tracks pending approvals from 0 to 2 to 0 and updates aria-label', () => {
    const env = fixture();
    const bellButton = env.document.createElement('button');
    bellButton.id = 'toggleNotificationsBtn';
    bellButton.setAttribute('aria-label', '打开通知面板');
    env.document.body.appendChild(bellButton);
    const mounted = mountFixture(env);

    // 初始 0
    let badge = bellButton.querySelector('.notification-bell-badge');
    assert.ok(!badge || badge.hidden);
    assert.equal(bellButton.hasAttribute('data-pending-count'), false);
    assert.equal(bellButton.getAttribute('aria-label'), '打开通知面板');

    // 0 -> 2
    addCard(mounted, { state: 'pending', tone: 'warn' });
    addCard(mounted, { state: 'pending', tone: 'warn' });
    mounted.center.update();

    badge = bellButton.querySelector('.notification-bell-badge');
    assert.ok(badge);
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, '2');
    assert.equal(bellButton.getAttribute('data-pending-count'), '2');
    assert.equal(bellButton.getAttribute('aria-label'), '打开通知面板（2 项待审批）');

    // 2 -> 0
    mounted.center.decideAll('approve');
    mounted.center.update();

    assert.equal(badge.hidden, true);
    assert.equal(bellButton.hasAttribute('data-pending-count'), false);
    assert.equal(bellButton.getAttribute('aria-label'), '打开通知面板');

    mounted.center.dispose();
});

test('bell button badge displays 99+ when pending approvals exceed 99', () => {
    const env = fixture();
    const bellButton = env.document.createElement('button');
    bellButton.id = 'toggleNotificationsBtn';
    bellButton.setAttribute('aria-label', '打开通知面板');
    env.document.body.appendChild(bellButton);
    const mounted = mountFixture(env);

    for (let index = 0; index < 105; index += 1) {
        addCard(mounted, { state: 'pending', tone: 'warn' });
    }
    mounted.center.update();

    const badge = bellButton.querySelector('.notification-bell-badge');
    assert.ok(badge);
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, '99+');
    assert.equal(bellButton.getAttribute('data-pending-count'), '105');
    assert.equal(bellButton.getAttribute('aria-label'), '打开通知面板（99+ 项待审批）');

    mounted.center.dispose();
});

test('bell button badge and pending attributes are cleaned up on dispose', () => {
    const env = fixture();
    const bellButton = env.document.createElement('button');
    bellButton.id = 'toggleNotificationsBtn';
    bellButton.setAttribute('aria-label', '打开通知面板');
    env.document.body.appendChild(bellButton);
    const mounted = mountFixture(env);

    addCard(mounted, { state: 'pending', tone: 'warn' });
    mounted.center.update();

    assert.ok(bellButton.querySelector('.notification-bell-badge'));
    assert.equal(bellButton.getAttribute('data-pending-count'), '1');
    assert.equal(bellButton.getAttribute('aria-label'), '打开通知面板（1 项待审批）');

    mounted.center.dispose();

    assert.equal(bellButton.querySelector('.notification-bell-badge'), null);
    assert.equal(bellButton.hasAttribute('data-pending-count'), false);
    assert.equal(bellButton.getAttribute('aria-label'), '打开通知面板');
});

test('counts and the VCPLog connection are published on the notification-center channel', () => {
    const channel = notificationCenter.getStateChannel();
    assert.equal(channel, globalThis.VCPStateChannels.get('notification-center'));
    const seen = [];
    const off = channel.subscribe(value => seen.push(value), { immediate: false });

    const env = mountFixture();
    addCard(env, { state: 'pending', tone: 'warn' });
    addCard(env, { state: 'error', tone: 'danger' });
    env.center.update();
    assert.deepEqual({ ...channel.get().counts }, { ...env.center.getCounts() });
    assert.equal(channel.get().counts.pending, 1);

    // 计数没变就不再发
    const published = seen.length;
    env.center.update();
    assert.equal(seen.length, published);

    notificationCenter.setConnection({ status: 'open', text: 'VCPLog: 已连接' });
    assert.deepEqual({ ...channel.get().connection }, { status: 'open', text: 'VCPLog: 已连接' });
    assert.equal(channel.get().counts.pending, 1, '连接状态变化不影响计数');
    notificationCenter.setConnection({ status: 'open', text: 'VCPLog: 已连接' });
    assert.equal(seen.length, published + 1);

    off();
    env.center.dispose();
});
