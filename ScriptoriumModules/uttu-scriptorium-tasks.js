// .md 里的勾选框。待办就是 `- [ ]`，不另存一份。这里只管点勾选框。
// 阅读视图里的勾选框能点：上游排出来的是 disabled 的 <input type=checkbox>，没有对应的源码位置，所以按“第几个任务”对上源码里那一行
//    （代码块、属性段里的不算；数目对不上时按那一条的文字找），只改 [ ] 里那一个字符，走 replaceSource（能撤销，照常存回原文件）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { session } = UI;

    // 认法：行首可以有引用和缩进，后面是列表记号和 [ ]。
    const TASK = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](?:\s+|$)(.*)$/;
    function tasksIn(text) {
        const lines = String(text).split('\n');
        const found = [];
        let fence = false;
        let front = lines[0]?.replace(/^﻿/, '').trim() === '---';
        lines.forEach((raw, index) => {
            const line = raw.replace(/\r$/, '');
            if (front) { if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) front = false; return; }
            if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
            if (fence) return;
            const match = TASK.exec(line);
            if (match) found.push({ index, prefix: match[1].length, done: match[2] !== ' ', text: match[3].trim() });
        });
        return found;
    }
    // 在源码里把第 index 行那个任务改成 done；返回新源码，对不上返回 null。
    function flip(source, task, done) {
        const lines = source.split('\n');
        const line = lines[task.index];
        if (line === undefined) return null;
        const at = task.prefix + 1;
        lines[task.index] = `${line.slice(0, at)}${done ? 'x' : ' '}${line.slice(at + 1)}`;
        return lines.join('\n');
    }
    const plainOf = (text) => String(text).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();

    // ---------- 1. 阅读视图里的勾选框 ----------
    let sheet = null;
    function prepare(root) {
        if (!root) return;
        for (const box of root.querySelectorAll('input[type="checkbox"]')) {
            if (box.disabled) box.disabled = false;
            box.dataset.uttuTask = '1';
        }
        if (!sheet && typeof CSSStyleSheet === 'function') {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(`input[data-uttu-task] { cursor: pointer; }
li:has(> input[data-uttu-task]:checked), li:has(> p > input[data-uttu-task]:checked) { opacity: .62; }`);
        }
        if (sheet && !root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
    let observed = null;
    const observer = new MutationObserver(() => { clearTimeout(prepareTimer); prepareTimer = setTimeout(() => prepare(observed), 120); });
    let prepareTimer = 0;
    function watch() {
        const root = session()?.readRoot?.();
        if (root && root !== observed) {
            observer.disconnect();
            observer.observe(root, { childList: true, subtree: true });
            observed = root;
        }
        prepare(root);
    }
    UI.on('document', watch);
    UI.on('view', watch);

    document.addEventListener('click', (event) => {
        const root = session()?.readRoot?.();
        const box = event.composedPath().find((node) => node?.tagName === 'INPUT' && node.type === 'checkbox');
        if (!box || !root || box.getRootNode() !== root || UI.doc()?.kind === 'web-page') return;
        event.preventDefault(); // 状态以源码为准：改了源码、阅读面重画
        const boxes = [...root.querySelectorAll('input[type="checkbox"]')];
        const source = session()?.source?.() || '';
        const tasks = tasksIn(source);
        let task = boxes.length === tasks.length ? tasks[boxes.indexOf(box)] : null;
        if (!task) {
            const wanted = plainOf(box.closest('li')?.textContent || '');
            task = tasks.find((item) => plainOf(item.text) === wanted) || null;
        }
        if (!task) { UI.toast('这一条在源码里对不上，切到编辑视图改。', 'error', 4000); return; }
        const next = flip(source, task, !task.done);
        if (next !== null) session()?.replaceSource?.(next, 'uttu-task-toggle');
    }, true);

    window.UTTUScriptoriumTasks = Object.freeze({ tasksIn, flip });
})();
