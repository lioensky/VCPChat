// 对话模式（chat-presentation-messenger）的运行时标记。
// 样式全部在 styles/chat-messenger.css；这里只给消息打上 CSS 选不出来的状态：
//   messenger-tail       最后一条助手消息；它工作中时，底部显示头像和"正在工作"
//   mg-cont / mg-more    与上一条 / 下一条属于同一发送者，用来收紧间距
//   messenger-enter      新到达的消息播放一次入场动画（加载历史时不播）
//   messenger-group-head 群聊里每组第一条，显示发送者名字
// 另外维护一个跟随悬停气泡的浮动操作条（复制 / 更多），并让消息列与输入框左右对齐。
(function () {
    'use strict';

    const MODE_CLASS = 'chat-presentation-messenger';
    const QUIET_AFTER_BULK_MS = 450;

    let list = null;
    let observer = null;
    let frame = 0;
    let quietUntil = 0;
    let toolbar = null;
    let hoverItem = null;
    let hideTimer = 0;

    const isActive = () => document.body.classList.contains(MODE_CLASS);

    const keyOf = (item) => {
        if (item.classList.contains('user')) return 'user';
        if (item.classList.contains('assistant')) return `assistant:${item.dataset.agentId || item.querySelector('.sender-name')?.textContent || ''}`;
        return null;
    };

    const toggle = (el, cls, on) => {
        if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
    };

    function mark() {
        frame = 0;
        if (!list || !isActive()) return;
        const items = Array.from(list.children).filter(el => el.classList.contains('message-item'));
        const keys = items.map(keyOf);
        const agents = new Set(keys.filter(k => k && k.startsWith('assistant:')));
        toggle(list, 'messenger-multi-agent', agents.size > 1);

        let tail = null;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].classList.contains('assistant')) { tail = items[i]; break; }
        }
        items.forEach((item, i) => {
            const key = keys[i];
            const cont = key !== null && keys[i - 1] === key;
            const more = key !== null && keys[i + 1] === key;
            toggle(item, 'mg-cont', cont);
            toggle(item, 'mg-more', more);
            toggle(item, 'messenger-group-head', key !== null && !cont);
            toggle(item, 'messenger-tail', item === tail);
        });
        if (tail) {
            const name = tail.querySelector('.sender-name')?.textContent?.trim() || '助手';
            if (tail.dataset.messengerName !== name) tail.dataset.messengerName = name;
        }
    }

    // 消息列两侧留白 = 输入框外沿到消息列边缘的距离，这样气泡和输入框左右齐平。
    let insetFrame = 0;
    function syncInset() {
        insetFrame = 0;
        if (!list) return;
        if (!isActive()) {
            list.style.removeProperty('--messenger-inset-left');
            list.style.removeProperty('--messenger-inset-right');
            return;
        }
        const card = document.querySelector('.chat-input-card');
        const cardRect = card?.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        if (!cardRect?.width || !listRect.width) return;
        const left = Math.max(10, Math.round(cardRect.left - listRect.left));
        const right = Math.max(10, Math.round(listRect.right - cardRect.right));
        list.style.setProperty('--messenger-inset-left', `${left}px`);
        list.style.setProperty('--messenger-inset-right', `${right}px`);
    }
    const scheduleInset = () => {
        if (!insetFrame) insetFrame = requestAnimationFrame(syncInset);
    };
    const insetObserver = new ResizeObserver(scheduleInset);

    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(mark);
    };

    function onMutations(records) {
        if (hoverItem && !list.contains(hoverItem)) hideToolbar();
        const now = performance.now();
        let added = [];
        let removed = 0;
        for (const record of records) {
            removed += record.removedNodes.length;
            for (const node of record.addedNodes) {
                if (node.nodeType === 1 && node.classList.contains('message-item')) added.push(node);
            }
        }
        // 切换话题会先清空再成批插入；这段时间里的消息都是历史，不播入场动画。
        if (removed > 2 || added.length > 2) quietUntil = now + QUIET_AFTER_BULK_MS;
        else if (now < quietUntil) quietUntil = now + QUIET_AFTER_BULK_MS;
        else if (isActive() && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
            for (const item of added) {
                item.classList.add('messenger-enter');
                item.addEventListener('animationend', function clear(e) {
                    if (e.target !== item && !e.target.matches?.('.md-content')) return;
                    item.classList.remove('messenger-enter');
                    item.removeEventListener('animationend', clear);
                });
                setTimeout(() => item.classList.remove('messenger-enter'), 900);
            }
        }
        if (added.length || removed) schedule();
    }

    // ─── 悬停操作条 ───

    function buildToolbar() {
        const bar = document.createElement('div');
        bar.className = 'messenger-hover-actions';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', '消息操作');
        bar.setAttribute('aria-hidden', 'true');
        bar.inert = true;
        bar.innerHTML = `
            <button type="button" data-messenger-action="copy" title="复制" aria-label="复制">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"></rect><path d="M5 15V6a2 2 0 0 1 2-2h9"></path></svg>
            </button>
            <button type="button" data-messenger-action="more" title="更多" aria-label="更多">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>
            </button>`;
        bar.addEventListener('mouseenter', () => clearTimeout(hideTimer));
        bar.addEventListener('mouseleave', () => scheduleHide());
        bar.addEventListener('click', onToolbarClick);
        document.body.appendChild(bar);
        return bar;
    }

    function placeToolbar(item) {
        const bubble = item.querySelector('.md-content');
        if (!bubble) return;
        toolbar ||= buildToolbar();
        const rect = bubble.getBoundingClientRect();
        const user = item.classList.contains('user');
        const width = toolbar.offsetWidth || 46;
        const height = toolbar.offsetHeight || 22;
        // 在气泡外侧 13px、与气泡垂直居中；长消息只取可见部分的中线。
        const viewport = list.closest('.chat-messages-container')?.getBoundingClientRect();
        const visibleTop = Math.max(rect.top, viewport?.top ?? 0);
        const visibleBottom = Math.min(rect.bottom, viewport?.bottom ?? window.innerHeight);
        const top = (visibleTop + visibleBottom) / 2 - height / 2;
        const gap = 13 - 4; // 按钮 22px、图标 15px，图标离气泡 13px
        const left = user ? rect.left - width - gap : rect.right + gap;
        toolbar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
        toolbar.classList.toggle('is-user', user);
        toolbar.classList.add('is-visible');
        toolbar.inert = false;
        toolbar.setAttribute('aria-hidden', 'false');
        clearTimeout(hideTimer);
    }

    function hideToolbar() {
        clearTimeout(hideTimer);
        if (toolbar) {
            toolbar.classList.remove('is-visible');
            toolbar.inert = true;
            toolbar.setAttribute('aria-hidden', 'true');
        }
        hoverItem = null;
    }

    function scheduleHide() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideToolbar, 160);
    }

    function onPointerOver(e) {
        if (!isActive()) return;
        const item = e.target.closest?.('.message-item.user, .message-item.assistant');
        if (!item || item.classList.contains('streaming')) return;
        if (item === hoverItem && toolbar?.classList.contains('is-visible')) { clearTimeout(hideTimer); return; }
        hoverItem = item;
        placeToolbar(item);
    }

    function onPointerOut(e) {
        if (!hoverItem) return;
        const to = e.relatedTarget;
        if (to && (hoverItem.contains(to) || toolbar?.contains(to))) return;
        scheduleHide();
    }

    async function onToolbarClick(e) {
        const button = e.target.closest('button[data-messenger-action]');
        if (!button || !hoverItem) return;
        // A topic or presentation switch can precede its MutationObserver callback.
        if (!isActive() || !list?.contains(hoverItem) || hoverItem.classList.contains('streaming')) {
            hideToolbar();
            return;
        }
        const bubble = hoverItem.querySelector('.md-content');
        if (button.dataset.messengerAction === 'copy') {
            try {
                await navigator.clipboard.writeText(bubble?.innerText?.trim() || '');
                button.classList.add('is-done');
                setTimeout(() => button.classList.remove('is-done'), 1100);
            } catch (error) {
                console.warn('[messenger] copy failed', error);
            }
            return;
        }
        // "更多"复用现有右键菜单：在按钮位置向消息派发 contextmenu。
        const r = button.getBoundingClientRect();
        (bubble || hoverItem).dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, view: window, button: 2,
            clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.bottom + 4)
        }));
        hideToolbar();
    }

    function attach() {
        const next = document.getElementById('chatMessages');
        if (!next || next === list) return;
        observer?.disconnect();
        list = next;
        observer = new MutationObserver(onMutations);
        observer.observe(list, { childList: true });
        list.addEventListener('mouseover', onPointerOver);
        list.addEventListener('mouseout', onPointerOut);
        insetObserver.disconnect();
        insetObserver.observe(list);
        const card = document.querySelector('.chat-input-card');
        if (card) insetObserver.observe(card);
        scheduleInset();
        list.closest('.chat-messages-container')?.addEventListener('scroll', () => {
            hideToolbar();
        }, { passive: true });
        schedule();
    }

    function start() {
        attach();
        // 切换到对话模式时补一次标记。
        new MutationObserver(() => {
            scheduleInset();
            if (isActive()) schedule(); else hideToolbar();
        })
            .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
