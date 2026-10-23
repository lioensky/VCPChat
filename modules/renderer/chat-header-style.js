// 聊天标题栏的两种样式（外观与样式 → 标题栏）：
//   classic  原版：左侧"与 X 聊天中"，右侧整排按钮
//   capsule  胶囊：居中的头像 + 名字，点击展开 / 收起侧栏；语音通话和新建话题按钮不显示
// 样式由 body.chat-header-capsule 切换；标题文字两种写法都存在 h3 的 data 上，切换时直接重写。
(function () {
    'use strict';

    const STYLES = new Set(['classic', 'capsule']);
    const CAPSULE_CLASS = 'chat-header-capsule';
    let current = 'classic';

    const normalize = (style) => (STYLES.has(style) ? style : 'classic');
    const titleEl = () => document.getElementById('currentChatAgentName');

    function render() {
        const isCapsule = current === 'capsule';
        const title = titleEl();
        const hasItem = Boolean(title && title.dataset.classicTitle !== undefined);
        if (hasItem) {
            title.textContent = isCapsule ? title.dataset.capsuleTitle : title.dataset.classicTitle;
        }
        const pill = document.getElementById('chatAgentPill');
        if (!pill) return;
        if (isCapsule) {
            pill.setAttribute('role', 'button');
            pill.tabIndex = 0;
            pill.title = hasItem ? `${title.dataset.capsuleTitle} - 点击展开 / 收起侧栏` : '';
        } else {
            pill.removeAttribute('role');
            pill.removeAttribute('tabindex');
            pill.removeAttribute('title');
        }
    }

    function apply(style) {
        current = normalize(style);
        document.body?.classList.toggle(CAPSULE_CLASS, current === 'capsule');
        render();
        return current;
    }

    // classic / capsule 分别是两种样式下的完整标题；capsule 省略时从 classic 里去掉"与 … 聊天中"
    function setTitle({ classic, capsule } = {}) {
        const title = titleEl();
        if (!title || typeof classic !== 'string') return;
        title.dataset.classicTitle = classic;
        title.dataset.capsuleTitle = typeof capsule === 'string'
            ? capsule
            : classic.replace(/^与\s*/, '').replace(/\s*聊天中$/, '');
        render();
    }

    // 未选中任何助手时的占位文字，两种样式一样
    function clear(text) {
        const title = titleEl();
        if (!title) return;
        delete title.dataset.classicTitle;
        delete title.dataset.capsuleTitle;
        title.textContent = text;
        render();
    }

    // 改名：两种写法里的旧名字都换掉
    function renameItem(oldName, newName) {
        const title = titleEl();
        if (!title || !oldName || title.dataset.classicTitle === undefined) return false;
        if (!title.dataset.classicTitle.includes(oldName)) return false;
        setTitle({
            classic: title.dataset.classicTitle.replace(oldName, newName),
            capsule: title.dataset.capsuleTitle.replace(oldName, newName),
        });
        return true;
    }

    // 侧栏开合时胶囊跟着聊天区居中位置移动：侧栏本身很快滑完，胶囊慢半拍追上去（指数衰减），
    // 靠 translate 补偿布局位移，不改布局本身。只在开合后的一小段时间里跑。
    const GLIDE_TAU_MS = 85;
    const GLIDE_MAX_MS = 900;
    const GLIDE_EPSILON_PX = 0.3;
    let glideRaf = 0;

    function glidePill() {
        const pill = document.getElementById('chatAgentPill');
        if (!pill || current !== 'capsule') return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        cancelAnimationFrame(glideRaf);
        const startedAt = performance.now();
        let last = startedAt;
        let offset = 0;
        let layoutLeft = pill.getBoundingClientRect().left - offset;
        const step = (now) => {
            const dt = Math.min(now - last, 64);
            last = now;
            const left = pill.getBoundingClientRect().left - offset;
            offset -= left - layoutLeft;
            layoutLeft = left;
            offset *= Math.exp(-dt / GLIDE_TAU_MS);
            const settled = Math.abs(offset) < GLIDE_EPSILON_PX;
            pill.style.translate = settled ? '' : `${offset.toFixed(2)}px 0`;
            if (settled) offset = 0;
            if (now - startedAt < GLIDE_MAX_MS && (!settled || now - startedAt < 400)) {
                glideRaf = requestAnimationFrame(step);
            } else {
                pill.style.translate = '';
            }
        };
        glideRaf = requestAnimationFrame(step);
    }

    if (document.body && typeof MutationObserver === 'function') {
        let paneOpen = document.body.classList.contains('vcp-side-pane-open');
        new MutationObserver(() => {
            const open = document.body.classList.contains('vcp-side-pane-open');
            if (open === paneOpen) return;
            paneOpen = open;
            glidePill();
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    window.vcpChatHeader = Object.freeze({
        normalize,
        apply,
        render,
        setTitle,
        clear,
        renameItem,
        isCapsule: () => current === 'capsule',
    });
})();
