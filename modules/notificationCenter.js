// modules/notificationCenter.js
// 通知面板的“信息架构”层：把 #notificationsList 里的卡片按状态分组
// （待审批 / 通知 / 已处理），维护顶部待审批横幅、筛选 chips 与条数上限。
// notificationRenderer 只负责生成卡片并标注 data-notification-state / -tone，
// 分组、计数、跳转和批量处理都在这里，二者通过 DOM 数据属性解耦。
(function installNotificationCenter(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) globalObject.notificationCenter = api;
})(typeof window !== 'undefined' ? window : null, function createNotificationCenterApi() {
    'use strict';

    const MAX_SETTLED_ITEMS = 300;
    const CONFIRM_WINDOW_MS = 3000;
    const COLLAPSE_KEY = 'vcp-notification-resolved-collapsed';
    const SECTIONS = [
        { id: 'pending', title: '待审批' },
        { id: 'info', title: '通知' },
        { id: 'resolved', title: '已处理', collapsible: true, clearable: true },
    ];
    // info 只看普通通知：不含待审批和已处理的审批卡
    const FILTERS = ['all', 'pending', 'info', 'error', 'resolved'];

    // notification-center：计数和 VCPLog 连接状态，给侧栏标签、新标签页的通知卡片读，
    // 它们不再去数筛选条上的数字、盯连接状态那一行的 DOM。
    const STATE_CHANNEL = 'notification-center';
    const COUNT_KEYS = ['all', 'pending', 'info', 'error', 'resolved'];
    const INITIAL_STATE = Object.freeze({
        counts: Object.freeze({ all: 0, pending: 0, info: 0, error: 0, resolved: 0 }),
        connection: Object.freeze({ status: 'unknown', text: 'VCPLog: 未连接' }),
    });

    function getStateChannel() {
        const channels = globalThis.VCPStateChannels;
        if (!channels) return null;
        return channels.get(STATE_CHANNEL) || channels.create(STATE_CHANNEL, INITIAL_STATE);
    }

    function publishCounts(counts) {
        const channel = getStateChannel();
        if (!channel) return;
        const next = Object.freeze(Object.fromEntries(COUNT_KEYS.map(key => [key, Number(counts?.[key]) || 0])));
        const prev = channel.get() || INITIAL_STATE;
        if (COUNT_KEYS.every(key => prev.counts?.[key] === next[key])) return;
        channel.publish(Object.freeze({ ...prev, counts: next }), { source: 'notification-counts' });
    }

    /** VCPLog 连接状态变了（notificationRenderer.updateVCPLogStatus 调） */
    function setConnection({ status = 'unknown', text = '' } = {}) {
        const channel = getStateChannel();
        if (!channel) return;
        const prev = channel.get() || INITIAL_STATE;
        if (prev.connection?.status === status && prev.connection?.text === text) return;
        channel.publish(Object.freeze({ ...prev, connection: Object.freeze({ status, text }) }), { source: 'vcplog-status' });
    }

    function setText(element, value) {
        if (element && element.textContent !== value) element.textContent = value;
    }

    function setHidden(element, hidden) {
        if (element && element.hidden !== hidden) element.hidden = hidden;
    }

    function mount(options = {}) {
        const doc = options.document || globalThis.document;
        const list = options.list || doc?.getElementById('notificationsList');
        if (!doc || !list) return { dispose() {}, update() {}, getCounts: () => ({}) };

        const banner = options.banner || doc.getElementById('notificationPendingBanner');
        const toolbar = options.toolbar || doc.getElementById('notificationToolbar');
        const bellButton = options.bellButton !== undefined ? options.bellButton : doc.getElementById('toggleNotificationsBtn');
        const storage = options.storage || globalThis.localStorage;
        const raf = options.requestFrame || (cb => setTimeout(cb, 16));
        const timers = new Set();
        const cleanups = [];

        let filter = 'all';
        let resolvedCollapsed = true;
        try { resolvedCollapsed = storage?.getItem(COLLAPSE_KEY) !== 'false'; } catch { /* storage may be unavailable */ }
        let cursor = -1;
        let scheduled = false;
        let disposed = false;
        const confirmState = { approve: null, reject: null };

        const sectionHeaders = new Map();
        SECTIONS.forEach(section => {
            const li = doc.createElement('li');
            li.className = 'notification-section';
            li.dataset.section = section.id;
            li.hidden = true;

            const title = doc.createElement(section.collapsible ? 'button' : 'div');
            title.className = 'notification-section-title';
            if (section.collapsible) {
                title.type = 'button';
                title.setAttribute('aria-expanded', String(!resolvedCollapsed));
            }
            const caret = doc.createElement('span');
            caret.className = 'notification-section-caret';
            caret.setAttribute('aria-hidden', 'true');
            const name = doc.createElement('span');
            name.className = 'notification-section-name';
            name.textContent = section.title;
            const count = doc.createElement('span');
            count.className = 'notification-section-count';
            title.append(...(section.collapsible ? [name, count, caret] : [name, count]));
            li.appendChild(title);

            if (section.clearable) {
                const clear = doc.createElement('button');
                clear.type = 'button';
                clear.className = 'notification-section-clear';
                clear.title = '清除已处理的通知';
                clear.setAttribute('aria-label', '清除已处理的通知');
                clear.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">delete</span>';
                clear.addEventListener('click', () => {
                    settledItems('resolved').forEach(item => item.remove());
                    schedule();
                });
                li.appendChild(clear);
            }
            if (section.collapsible) {
                title.addEventListener('click', () => {
                    resolvedCollapsed = !resolvedCollapsed;
                    try { storage?.setItem(COLLAPSE_KEY, String(resolvedCollapsed)); } catch { /* ignore */ }
                    schedule();
                });
            }
            list.appendChild(li);
            sectionHeaders.set(section.id, { li, title, count, section });
        });

        const empty = doc.createElement('li');
        empty.className = 'notification-empty';
        empty.hidden = true;
        empty.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">notifications_off</span><span class="notification-empty-text"></span>';
        list.appendChild(empty);

        const items = () => Array.from(list.children).filter(node => node.classList?.contains('notification-item'));
        const stateOf = item => item.dataset.notificationState || 'info';
        const settledItems = state => items().filter(item => stateOf(item) === state);
        const pendingItems = () => items().filter(item => stateOf(item) === 'pending' && !item.classList.contains('is-busy'));
        // 需要内容审计的、会删除代码的请求都必须逐条看过再允许，批量允许时跳过
        const approvableItems = () => pendingItems().filter(item => !item.querySelector('.vcp-btn-audit, .notification-approval-preview-section.is-deletion'));

        function counts() {
            const all = items();
            return {
                all: all.length,
                pending: all.filter(item => stateOf(item) === 'pending').length,
                info: all.filter(item => stateOf(item) === 'info').length,
                resolved: all.filter(item => stateOf(item) === 'resolved').length,
                error: all.filter(item => item.dataset.notificationTone === 'error').length,
            };
        }

        function trim() {
            // 新卡片 prepend 在最前，越靠后越旧；待审批永不裁剪。
            const settled = items().filter(item => stateOf(item) !== 'pending');
            for (let index = settled.length - 1; index >= MAX_SETTLED_ITEMS; index -= 1) settled[index].remove();
        }

        function update() {
            scheduled = false;
            if (disposed) return;
            trim();
            const c = counts();
            publishCounts(c);

            if (list.dataset.filter !== filter) list.dataset.filter = filter;
            const collapsed = filter === 'all' && resolvedCollapsed;
            list.classList.toggle('resolved-collapsed', collapsed);

            sectionHeaders.forEach(({ li, title, count, section }) => {
                const total = c[section.id];
                setText(count, String(total));
                setHidden(li, filter !== 'all' || total === 0);
                if (section.collapsible) title.setAttribute('aria-expanded', String(!resolvedCollapsed));
            });

            const visible = filter === 'all' ? c.pending + c.info + (collapsed ? 0 : c.resolved)
                : filter === 'error' ? c.error : c[filter];
            const emptyVisible = c.all === 0 || (filter !== 'all' && visible === 0);
            setHidden(empty, !emptyVisible);
            setText(empty.querySelector('.notification-empty-text'),
                c.all === 0 ? '暂无通知' : '没有符合条件的通知');

            if (banner) {
                setHidden(banner, c.pending === 0);
                setText(banner.querySelector('[data-role="pending-count"]'), String(c.pending));
                if (c.pending === 0) resetConfirm();
                // 只剩需逐条审计的请求时，批量允许没有可做的事
                const approve = banner.querySelector('[data-action="approve-all"]');
                if (approve) {
                    const approvable = approvableItems().length;
                    approve.disabled = c.pending > 0 && approvable === 0;
                    // 被跳过的请求要说清楚原因，否则按钮灰掉 / 只处理一部分会让人困惑
                    const skipped = c.pending - approvable;
                    const hint = skipped > 0 ? `${skipped} 项会删除代码或需要审计，请逐条处理` : '';
                    if ((approve.getAttribute('title') || '') !== hint) {
                        if (hint) approve.setAttribute('title', hint);
                        else approve.removeAttribute('title');
                    }
                }
            }
            if (toolbar) {
                toolbar.querySelectorAll('[data-filter]').forEach(chip => {
                    const key = chip.dataset.filter;
                    const pressed = String(key === filter);
                    if (chip.getAttribute('aria-pressed') !== pressed) chip.setAttribute('aria-pressed', pressed);
                    setText(chip.querySelector('.notification-chip-count'), key === 'all' || !c[key] ? '' : String(c[key]));
                });
            }

            if (bellButton) {
                let badge = bellButton.querySelector('.notification-bell-badge');
                if (c.pending > 0) {
                    if (!badge) {
                        badge = doc.createElement('span');
                        badge.className = 'notification-bell-badge';
                        badge.setAttribute('aria-hidden', 'true');
                        bellButton.appendChild(badge);
                    }
                    const text = c.pending > 99 ? '99+' : String(c.pending);
                    setText(badge, text);
                    setHidden(badge, false);
                    bellButton.setAttribute('data-pending-count', String(c.pending));

                    const isPanelActive = bellButton.classList.contains('notification-panel-active') || bellButton.getAttribute('aria-expanded') === 'true';
                    const baseLabel = (bellButton.getAttribute('aria-label') || (isPanelActive ? '关闭通知面板' : '打开通知面板'))
                        .replace(/（[^）]*待审批）/, '').trim();
                    bellButton.setAttribute('aria-label', `${baseLabel}（${text} 项待审批）`);
                } else {
                    if (badge) {
                        setHidden(badge, true);
                    }
                    bellButton.removeAttribute('data-pending-count');
                    const isPanelActive = bellButton.classList.contains('notification-panel-active') || bellButton.getAttribute('aria-expanded') === 'true';
                    const baseLabel = (bellButton.getAttribute('aria-label') || (isPanelActive ? '关闭通知面板' : '打开通知面板'))
                        .replace(/（[^）]*待审批）/, '').trim();
                    bellButton.setAttribute('aria-label', baseLabel);
                }
            }
        }

        function schedule() {
            if (scheduled || disposed) return;
            scheduled = true;
            raf(update);
        }

        function setFilter(next) {
            filter = FILTERS.includes(next) ? next : 'all';
            schedule();
        }

        function flash(item) {
            item.classList.add('notification-flash');
            const timer = setTimeout(() => {
                item.classList.remove('notification-flash');
                timers.delete(timer);
            }, 1400);
            timers.add(timer);
        }

        function jumpToPending(direction = 1) {
            const pending = pendingItems();
            if (!pending.length) return null;
            if (filter !== 'all' && filter !== 'pending') setFilter('all');
            cursor = ((cursor + direction) % pending.length + pending.length) % pending.length;
            const target = pending[cursor];
            target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
            flash(target);
            target.querySelector('textarea, button')?.focus?.({ preventScroll: true });
            return target;
        }

        function resetConfirm() {
            ['approve', 'reject'].forEach(kind => {
                const state = confirmState[kind];
                if (!state) return;
                clearTimeout(state.timer);
                timers.delete(state.timer);
                state.button.classList.remove('is-confirming');
                setText(state.label, state.original);
                confirmState[kind] = null;
            });
        }

        function decideAll(kind) {
            const approved = kind === 'approve';
            // 带内容变更预览的请求必须逐条审计，批量允许时跳过。
            const targets = approved ? approvableItems() : pendingItems();
            const skipped = pendingItems().length - targets.length;
            targets.forEach(item => {
                item.querySelector(approved ? '.vcp-btn-success' : '.vcp-btn-danger')?.click();
            });
            schedule();
            return { handled: targets.length, skipped };
        }

        function onBulkClick(kind, button) {
            const label = button.querySelector('[data-role="label"]') || button;
            const existing = confirmState[kind];
            if (existing) {
                resetConfirm();
                return decideAll(kind);
            }
            resetConfirm();
            const original = label.textContent;
            const n = (kind === 'approve' ? approvableItems() : pendingItems()).length;
            if (n === 0) return { handled: 0, skipped: pendingItems().length };
            label.textContent = `确认${kind === 'approve' ? '允许' : '拒绝'} ${n} 项`;
            button.classList.add('is-confirming');
            const timer = setTimeout(resetConfirm, CONFIRM_WINDOW_MS);
            timers.add(timer);
            confirmState[kind] = { button, label, original, timer };
            return null;
        }

        function bind(target, type, handler) {
            if (!target) return;
            target.addEventListener(type, handler);
            cleanups.push(() => target.removeEventListener(type, handler));
        }

        if (banner) {
            bind(banner.querySelector('[data-action="jump-next"]'), 'click', () => jumpToPending(1));
            bind(banner.querySelector('[data-action="jump-prev"]'), 'click', () => jumpToPending(-1));
            const approve = banner.querySelector('[data-action="approve-all"]');
            const reject = banner.querySelector('[data-action="reject-all"]');
            bind(approve, 'click', () => onBulkClick('approve', approve));
            bind(reject, 'click', () => onBulkClick('reject', reject));
        }
        if (toolbar) {
            toolbar.querySelectorAll('[data-filter]').forEach(chip => {
                bind(chip, 'click', () => setFilter(chip.dataset.filter));
            });
        }

        const Observer = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
        let observer = null;
        if (Observer) {
            observer = new Observer(schedule);
            observer.observe(list, { childList: true });
            // 卡片自身的状态变化（待审批 → 已处理）发生在子节点上
            const itemObserver = new Observer(schedule);
            itemObserver.observe(list, {
                subtree: true,
                attributes: true,
                attributeFilter: ['data-notification-state', 'data-notification-tone'],
            });
            cleanups.push(() => itemObserver.disconnect());
        }
        update();

        return {
            update,
            setFilter,
            jumpToPending,
            decideAll,
            getCounts: counts,
            getFilter: () => filter,
            dispose() {
                disposed = true;
                observer?.disconnect();
                cleanups.forEach(fn => fn());
                timers.forEach(timer => clearTimeout(timer));
                timers.clear();
                sectionHeaders.forEach(({ li }) => li.remove());
                empty.remove();
                if (bellButton) {
                    bellButton.querySelector('.notification-bell-badge')?.remove();
                    bellButton.removeAttribute('data-pending-count');
                    const currentLabel = bellButton.getAttribute('aria-label');
                    if (currentLabel) {
                        const cleaned = currentLabel.replace(/（[^）]*待审批）/, '').trim();
                        bellButton.setAttribute('aria-label', cleaned);
                    }
                }
            },
        };
    }

    return { mount, getStateChannel, setConnection, MAX_SETTLED_ITEMS };
});
