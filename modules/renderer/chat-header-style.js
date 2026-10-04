// 聊天标题栏的两种样式（外观与样式 → 标题栏）：
//   classic  原版：左侧"与 X 聊天中"，右侧整排按钮
//   capsule  胶囊：居中的头像 + 名字，点击打开当前助手 / 群组设置；语音通话和新建话题按钮不显示
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
            pill.title = hasItem ? `${title.dataset.capsuleTitle} - 点击查看详情与设置` : '';
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
