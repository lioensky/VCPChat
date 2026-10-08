/**
 * modules/ui-system/conversation-status-panel/dom.js
 * 会话右上角浮动的「状态」面板：Git 变更（更改 / 分支 / 提交或推送）与 V工程 计划（todo），
 * 也可以收起成一颗迷你胶囊。
 *
 * 结构、交互和样式对照 ZCode 的 ConversationStatusPanel / GitBranchSwitcher / GitActionMenu
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4 与 packages/ui/src），
 * 由 React + Tailwind 改写为原生 DOM + styles/ui-system/status-panel.css。
 * 数据来自现有后端：Git 走 git:* IPC，V工程走 project-forge:* IPC，
 * 工作区选择与侧栏 Git 标签、V工程 Git 页共用同一个 localStorage 键。
 */

'use strict';



export function createStatusPanelDom({
    doc
}) {
    const cleanups = [];
    function h(tag, className, ...children) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        for (const child of children) {
            if (child === null || child === undefined || child === false) continue;
            node.appendChild(typeof child === 'string' || typeof child === 'number' ? doc.createTextNode(String(child)) : child);
        }
        return node;
    }

    function icon(name, className = '') {
        const span = doc.createElement('span');
        span.className = `vcp-ui-icon zc-i ${className}`.trim();
        span.textContent = name;
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    function button(className, { label = '', type = 'button', disabled = false, onClick = null } = {}, ...children) {
        const btn = h('button', className, ...children);
        btn.type = type;
        btn.disabled = disabled;
        if (label) btn.setAttribute('aria-label', label);
        if (onClick) btn.addEventListener('click', onClick);
        return btn;
    }

    function diffCounts(added, removed, className = '') {
        return h('span', `zc-diff ${className}`.trim(),
            h('span', 'zc-added', `+${added}`), ' ', h('span', 'zc-removed', `-${removed}`));
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    return Object.freeze({ h, icon, button, diffCounts, on, cleanups, dispose() { cleanups.splice(0).forEach(fn => { try { fn(); } catch (_e) { /* ignore */ } }); } });
}
