// 编辑区的按键。文本视图、Markdown 源码、网页源码的每个 CodeMirror 都有。
// 键位照 VS Code。命令来自 CodeMirror 的 sublime 键表和 comment、continuelist 两个插件；不直接用 sublime 键表：它的 Ctrl K 连按和文坊的链接键冲突。
(() => {
    'use strict';
    const CM = window.CodeMirror;
    if (!CM?.defineInitHook) return;
    const inMarkdown = (cm) => /markdown|gfm/.test(cm.getModeAt(cm.getCursor())?.name || '');
    // 代码字号：Ctrl 加减、Ctrl 滚轮，Ctrl 0 回到默认；所有编辑区一起变，记在本机。
    const SIZE_KEY = 'uttu.scriptorium.code.size';
    const editors = new Set();
    const savedSize = () => { try { return Number(localStorage.getItem(SIZE_KEY)) || 0; } catch (_) { return 0; } };
    function applySize(size) {
        try { localStorage.setItem(SIZE_KEY, String(size)); } catch (_) { /* 只在这次用 */ }
        for (const cm of editors) {
            if (!cm.getWrapperElement().isConnected) { editors.delete(cm); continue; }
            cm.getWrapperElement().style.fontSize = size ? `${size}px` : '';
            cm.refresh();
        }
    }
    function stepSize(cm, step) {
        const current = savedSize() || parseFloat(getComputedStyle(cm.getWrapperElement()).fontSize) || 13;
        applySize(Math.min(32, Math.max(9, current + step)));
    }
    const KEYS = {
        'Ctrl-/': 'toggleCommentIndented',
        'Ctrl-D': 'selectNextOccurrence',
        'Ctrl-L': 'selectLine',
        'Shift-Ctrl-K': 'deleteLine',
        'Shift-Alt-Down': 'duplicateLine',
        'Shift-Alt-Up': 'duplicateLine',
        'Alt-Up': 'swapLineUp',
        'Alt-Down': 'swapLineDown',
        'Ctrl-Enter': 'insertLineAfter',
        'Shift-Ctrl-Enter': 'insertLineBefore',
        'Ctrl-G': () => window.UTTUScriptoriumUI?.openCommands?.(':'),
        'Ctrl-=': (cm) => stepSize(cm, 1),
        'Ctrl--': (cm) => stepSize(cm, -1),
        'Ctrl-0': () => applySize(0),
        Enter: (cm) => (inMarkdown(cm) ? cm.execCommand('newlineAndIndentContinueMarkdownList') : CM.Pass),
    };
    CM.defineInitHook((cm) => {
        cm.addKeyMap(KEYS);
        cm.setOption('matchBrackets', true);
        editors.add(cm);
        const wrapper = cm.getWrapperElement();
        if (savedSize()) wrapper.style.fontSize = `${savedSize()}px`;
        wrapper.addEventListener('wheel', (event) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            stepSize(cm, event.deltaY < 0 ? 1 : -1);
        }, { passive: false });
    });
})();
