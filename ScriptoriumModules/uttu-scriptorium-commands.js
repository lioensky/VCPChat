// 文坊的命令面板和快捷键表。
// 框是 Ctrl P 那个（uttu-scriptorium-quickopen.js）：开头打 > 列命令（Ctrl Shift P 直接带上 >），打 ? 列全部快捷键。
// 命令每次打开时现算：文件菜单里能点的（UI.fileItems）、当前文件的右键菜单（uttu-scriptorium-filemenu.js）、视图、左栏、工作区、标签。
// 菜单里灰掉的不列；开关类写成“自动保存：关掉”这样，一看就知道点了会怎样。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;

    function list() {
        const items = [];
        const seen = new Set();
        const add = (group, label, run, k = '') => {
            const key = `${group}\n${label}`;
            if (!label || seen.has(key)) return;
            seen.add(key);
            items.push({ name: label, rel: group, tag: k, run });
        };
        // 文件菜单（网页开着时是网页自己那一份）。
        for (const item of UI.fileItems?.() || []) {
            if (!item || item.sep || item.grp || item.disabled || !item.act) continue;
            const label = item.check === undefined ? item.label : `${item.label}：${item.check ? '关掉' : '打开'}`;
            add('文件', label, item.act, item.k || '');
        }
        // 当前文件：右键菜单那一份（打开、新建这些对当前文件没意义的不列）。
        const doc = UI.doc();
        const menu = window.UTTUScriptoriumFileMenu;
        const title = document.getElementById('uttu-title');
        if (doc?.filePath && menu?.itemsFor && title) {
            for (const item of menu.itemsFor({ path: doc.filePath, kind: 'title', el: title }, title)) {
                if (!item || item.sep || item.disabled || !item.act || item.label === '打开') continue;
                add('当前文件', item.label, item.act, item.k || '');
            }
        }
        // 视图。
        add('视图', '阅读', () => UI.setMode('read'), 'Ctrl E');
        add('视图', '编辑（所见即所得）', () => UI.setMode('edit'), 'Ctrl E');
        add('视图', '源码（左源码右预览）', () => UI.setMode('source'));
        if (doc && !UI.overlay?.()) add('视图', '编辑这份文档的 CSS', () => { UI.setMode('source'); UI.setEditor('css'); });
        add('视图', '专注模式', () => UI.forward('focus-mode-btn'));
        add('视图', document.body.classList.contains('uttu-right-open') ? '收起检查器' : '打开检查器', () => UI.setRight(!document.body.classList.contains('uttu-right-open')));
        // 左栏。
        for (const [key, label] of [['lib', '文库'], ['outline', '目录'], ['notes', '笔记']]) {
            add('左栏', label, () => UI.setLeft(true, key));
        }
        if (doc) add('左栏', '在这份文件里找', () => UI.openFind?.(''), 'Ctrl F');
        add('左栏', '在所有文件里找', () => UI.openFind?.('', false, 'files'), 'Ctrl Shift F');
        add('左栏', '收起左栏', () => UI.setLeft(false));
        // 工作区。
        const folder = window.UTTUScriptoriumFolder;
        if (folder) {
            add('工作区', '打开文件夹', () => folder.choose());
            add('工作区', '全部折叠', () => folder.collapseAll());
            add('工作区', folder.showAll?.() ? '只显示文档和图片' : '显示所有文件', () => folder.setShowAll?.(!folder.showAll?.()));
            add('工作区', '快速打开文件', () => UI.openQuickOpen?.(), 'Ctrl P');
        }
        // 标签。
        const tabs = window.UTTUScriptoriumTabs;
        if (tabs && doc?.filePath && tabs.list().length) {
            add('标签', '关闭这个标签', () => void tabs.close(doc.filePath), 'Ctrl W');
            if (tabs.list().length > 1) {
                add('标签', '关闭其他标签', () => void tabs.closeOthers(doc.filePath));
                add('标签', '下一个标签', () => {
                    const all = tabs.list();
                    const at = all.findIndex((item) => item.replace(/\\/g, '/').toLowerCase() === doc.filePath.replace(/\\/g, '/').toLowerCase());
                    void tabs.switchTo(all[(at + 1) % all.length]);
                }, 'Ctrl Tab');
            }
        }
        add('帮助', '看全部快捷键', () => setTimeout(() => UI.openCommands?.('?'), 0));
        return items;
    }

    // 快捷键表：哪里能用写在后面。改了快捷键记得改这里（冒烟查了这张表里的几项真的能用）。
    const SHORTCUTS = [
        ['Ctrl N', '新建', '任何时候'],
        ['Ctrl O', '打开文件', '任何时候'],
        ['Ctrl S', '保存', '开着自动保存时不用按'],
        ['Ctrl Shift S', '另存为', '任何时候'],
        ['F5', '从磁盘重新载入', '有没存的改动时先问'],
        ['Ctrl P', '快速打开文件', '工作区和最近打开'],
        ['Ctrl Shift P', '命令面板', '框里打 > 找命令'],
        ['Ctrl F', '在文档里查找', '带上选中的字'],
        ['Ctrl E', '阅读 / 编辑 切换', '开着文稿、.md 时'],
        ['Ctrl Z / Ctrl Y', '撤销 / 重做', '编辑时'],
        ['Ctrl K', '把选中的字做成链接', '所见编辑'],
        ['/', '插入菜单', '所见编辑的空行'],
        ['Ctrl + 点链接', '跟着链接走', '编辑面（阅读面直接点）'],
        ['Ctrl H', '替换', '文稿、Markdown、文本和代码'],
        ['Ctrl Shift F', '在工作区的文件里找', '任何时候'],
        ['Ctrl Shift T', '重开刚关掉的标签', '任何时候'],
        ['Ctrl 加 / 减、Ctrl 滚轮', '放大、缩小代码字号（Ctrl 0 还原）', '文本和代码、源码视图'],
        ['Ctrl G', '跳到第几行', '文本和代码、源码视图'],
        ['Ctrl /', '注释这几行', '文本和代码、源码视图'],
        ['Ctrl D', '选中下一个相同的词', '文本和代码、源码视图'],
        ['Alt ↑ / ↓', '上下移动这一行', '文本和代码、源码视图'],
        ['Shift Alt ↓', '复制这一行', '文本和代码、源码视图'],
        ['Ctrl Shift K', '删掉这一行', '文本和代码、源码视图'],
        ['Ctrl Enter', '在下面新起一行', '文本和代码、源码视图'],
        ['Ctrl Tab / Ctrl Shift Tab', '下一个 / 上一个标签', '两个标签以上'],
        ['Ctrl W', '关掉当前标签', '任何时候'],
        ['中键', '关掉标签', '标签上'],
        ['F2', '重命名', '资源管理器的行'],
        ['Delete', '移到回收站（再问一次）', '资源管理器的行'],
        ['菜单键 / Shift F10', '右键菜单', '资源管理器的行、标签'],
        ['← → 空格', '翻页', '放映时'],
        ['Esc', '关掉菜单、小框；退出放映、专注', '任何时候'],
    ];
    const shortcuts = () => SHORTCUTS.map(([k, label, where]) => ({ name: label, rel: where, tag: k }));

    window.UTTUScriptoriumCommands = Object.freeze({ list, shortcuts });
})();
