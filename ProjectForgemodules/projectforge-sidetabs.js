// ProjectForgemodules/projectforge-sidetabs.js
// 侧栏滑动分页控制器（工程 / Git / 源码）。
// - 负责分页按钮状态、滑动轨道位置、主面板模式（#main-panel[data-mode]）与上次分页的记忆。
// - 各分页模块在自己的 DOMContentLoaded 中 register(name, { onEnter, onLeave })；
//   模块不可用时应隐藏自己的分页按钮（hidden），控制器会自动跳过。
// 与 projectforge.js 同为经典脚本，复用其顶层 $。
'use strict';

(() => {
    const SIDE_TAB_KEY = 'vcp-projectforge-side-tab';
    const DEFAULT_TAB = 'projects';
    const savedTab = localStorage.getItem(SIDE_TAB_KEY) || DEFAULT_TAB;
    const hooks = new Map();
    let current = DEFAULT_TAB;

    const allTabs = () => [...document.querySelectorAll('.side-tab')];
    const visibleTabs = () => allTabs().filter(tab => !tab.hidden);
    const pageNames = () => [...document.querySelectorAll('.side-page')].map(page => page.dataset.sidePage);

    function switchTo(name, { focus = false, persist = true } = {}) {
        const available = visibleTabs().map(tab => tab.dataset.sideTab);
        const target = available.includes(name) ? name : DEFAULT_TAB;
        const previous = current;
        current = target;

        const sidebar = $('project-sidebar');
        sidebar.dataset.sideActive = target;
        sidebar.style.setProperty('--side-index', String(Math.max(0, pageNames().indexOf(target))));
        $('main-panel').dataset.mode = target;

        allTabs().forEach(tab => {
            const active = tab.dataset.sideTab === target;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            if (active && focus) tab.focus();
        });
        document.querySelectorAll('.side-page').forEach(page => {
            const active = page.dataset.sidePage === target;
            page.inert = !active;
            page.setAttribute('aria-hidden', String(!active));
        });
        if (persist) localStorage.setItem(SIDE_TAB_KEY, target);

        if (previous !== target) hooks.get(previous)?.onLeave?.();
        hooks.get(target)?.onEnter?.({ previous });
    }

    function register(name, handlers = {}) {
        hooks.set(name, handlers);
    }

    function bind() {
        const bar = $('side-tabs');
        bar.addEventListener('click', e => {
            const tab = e.target.closest('.side-tab');
            if (tab && !tab.hidden) switchTo(tab.dataset.sideTab);
        });
        bar.addEventListener('keydown', e => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            const tabs = visibleTabs();
            if (!tabs.length) return;
            const index = Math.max(0, tabs.indexOf(document.activeElement));
            let next = index;
            if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') next = 0;
            else next = tabs.length - 1;
            switchTo(tabs[next].dataset.sideTab, { focus: true });
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        bind();
        // 各分页模块在各自的 DOMContentLoaded 中注册；全部执行完后再恢复上次的分页
        setTimeout(() => {
            if (savedTab !== DEFAULT_TAB) switchTo(savedTab, { persist: false });
        }, 0);
    });

    window.ProjectForgeSideTabs = Object.freeze({
        register,
        switchTo,
        current: () => current,
        savedTab,
    });
})();