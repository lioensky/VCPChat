/** Workspace file selection. The latest read owns both content and failure messages. */

'use strict';

const SOURCE_WORKSPACE_KEY = 'vcp-projectforge-source-workspace';

export function createCodeViewerPicker({
    store,
    scope,
    api,
    detectLanguage,
    doc,
    getStorage,
    langTag,
    picker,
    pickerToggleBtn,
    renderCodeView,
    setBodyMessage,
    titleLabel
}) {
    let readToken = 0;
    // 监听挂在查看器这次挂载的 scope 上，标签释放时一起拆
    const on = (node, event, listener) => scope.listen(node, event, listener, undefined, `picker:${event}`);

    function setCollapsed(collapsed) {
        picker.classList.toggle('is-collapsed', collapsed);
        pickerToggleBtn?.setAttribute('aria-expanded', String(!collapsed));
    }

    async function setupPicker() {
        const wsSelect = doc.createElement('select');
        wsSelect.className = 'side-code-picker-select';
        wsSelect.setAttribute('aria-label', '工作区');
        const filterInput = doc.createElement('input');
        filterInput.type = 'search';
        filterInput.className = 'side-code-picker-filter';
        filterInput.placeholder = '搜索文件名...';
        filterInput.setAttribute('aria-label', '搜索文件名');
        // 行是普通按钮，不是 option，所以不标 listbox；方向键导航见下面的 onListKeydown
        const list = doc.createElement('div');
        list.className = 'side-code-picker-list';
        list.setAttribute('aria-label', '文件');
        const note = doc.createElement('div');
        note.className = 'side-code-picker-note';
        picker.append(wsSelect, filterInput, list, note);

        let files = [];
        let activeWorkspaceId = '';
        let activePath = '';
        let listToken = 0;

        function renderList() {
            list.innerHTML = '';
            const keyword = filterInput.value.trim().toLowerCase();
            const matched = keyword ? files.filter((f) => f.toLowerCase().includes(keyword)) : files;
            const shown = matched.slice(0, 300);
            for (const rel of shown) {
                const item = doc.createElement('button');
                item.type = 'button';
                item.className = 'side-code-picker-item';
                item.dataset.path = rel;
                if (rel === activePath) {
                    item.classList.add('active');
                    item.setAttribute('aria-current', 'true');
                }
                const slash = rel.lastIndexOf('/');
                const name = doc.createElement('span');
                name.className = 'side-code-picker-name';
                name.textContent = slash === -1 ? rel : rel.slice(slash + 1);
                const dir = doc.createElement('span');
                dir.className = 'side-code-picker-dir';
                dir.textContent = slash === -1 ? '' : rel.slice(0, slash);
                item.append(name, dir);
                list.appendChild(item);
            }
            note.textContent = matched.length > shown.length
                ? `仅显示前 ${shown.length} 项，共 ${matched.length} 项匹配，请输入关键字缩小范围`
                : `${matched.length} 个文件`;
        }

        async function loadFiles() {
            const token = ++listToken;
            files = [];
            list.innerHTML = '';
            if (!activeWorkspaceId) {
                note.textContent = '';
                return;
            }
            note.textContent = '正在读取文件列表...';
            try {
                const res = await api.sourceListFiles(activeWorkspaceId);
                if (store.isDisposed || token !== listToken) return;
                if (!res?.success) {
                    showListError(res?.error || '读取文件列表失败');
                    return;
                }
                files = res.data?.files || [];
                renderList();
                if (res.data?.truncated) {
                    note.textContent += `（文件过多，仅索引前 ${res.data.limit} 个）`;
                }
            } catch (err) {
                if (store.isDisposed || token !== listToken) return;
                showListError(`读取文件列表失败：${err?.message || err}`);
            }
        }

        // 换个工作区再换回来才会重读，太绕：出错时就地给一个重试
        function showListError(message) {
            note.textContent = message;
            const retry = doc.createElement('button');
            retry.type = 'button';
            retry.className = 'side-code-picker-retry';
            retry.textContent = '重试';
            retry.addEventListener('click', () => { void loadFiles(); });
            note.append(' ', retry);
        }

        async function openFile(rel) {
            const token = ++readToken;
            const workspaceId = activeWorkspaceId;
            const isCurrent = () => !store.isDisposed && token === readToken;
            activePath = rel;
            store.currentCode = '';
            list.querySelectorAll('.side-code-picker-item').forEach((el) => {
                el.classList.toggle('active', el.dataset.path === rel);
                if (el.dataset.path === rel) el.setAttribute('aria-current', 'true');
                else el.removeAttribute('aria-current');
            });
            setBodyMessage('加载文件中…');
            try {
                const res = await api.sourceReadFile(workspaceId, rel);
                if (!isCurrent()) return;
                if (!res?.success) {
                    setBodyMessage(res?.error || '读取文件失败', true);
                    return;
                }
                const file = res.data || {};
                const name = rel.slice(rel.lastIndexOf('/') + 1);
                const meta = detectLanguage(name, 'plaintext');
                store.currentLang = meta.lang;
                store.currentTag = meta.tag;
                titleLabel.textContent = name;
                titleLabel.title = rel;
                langTag.textContent = store.currentTag;
                langTag.dataset.lang = store.currentLang;
                store.currentCode = '';
                if (file.binary) {
                    setBodyMessage('二进制文件，无法预览');
                } else if (file.tooLarge) {
                    setBodyMessage(`文件过大（${Math.round((file.size || 0) / 1024)} KB），无法预览`);
                } else if (file.encodingError) {
                    setBodyMessage('文件编码无法识别为 UTF-8，无法预览', true);
                } else {
                    store.currentCode = file.text || '';
                    renderCodeView();
                    // 收起会把焦点所在的行藏掉，焦点交给能再打开选择器的按钮（Radix Popover 关闭时也回到触发器）
                    const hadFocus = picker.contains(doc.activeElement);
                    setCollapsed(true);
                    if (hadFocus) pickerToggleBtn?.focus?.();
                }
            } catch (err) {
                if (!isCurrent()) return;
                setBodyMessage(`读取文件失败：${err?.message || err}`, true);
            }
        }

        // One owner for resident rows; replacing the list releases every retired row.
        on(list, 'click', event => {
            const item = event.target?.closest?.('.side-code-picker-item');
            if (item && list.contains(item)) openFile(item.dataset.path);
        });
        on(wsSelect, 'change', () => {
            ++readToken;
            activeWorkspaceId = wsSelect.value;
            try { getStorage()?.setItem(SOURCE_WORKSPACE_KEY, activeWorkspaceId); } catch (_error) { /* Storage is optional. */ }
            activePath = '';
            store.currentCode = '';
            setBodyMessage('请选择要查看的文件');
            loadFiles();
        });
        on(filterInput, 'input', renderList);
        // 搜索框 ↓ 进列表，列表里 ↑↓/Home/End 移动，第一行再按 ↑ 回搜索框（同 cmdk 的文件选择）
        const rows = () => Array.from(list.querySelectorAll('.side-code-picker-item'));
        on(filterInput, 'keydown', (event) => {
            if (event.key !== 'ArrowDown') return;
            const first = rows()[0];
            if (!first) return;
            event.preventDefault();
            first.focus();
        });
        on(list, 'keydown', (event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = rows();
            const index = items.indexOf(event.target);
            if (index < 0) return;
            event.preventDefault();
            if (event.key === 'ArrowUp' && index === 0) { filterInput.focus(); return; }
            const next = event.key === 'Home' ? 0
                : event.key === 'End' ? items.length - 1
                    : Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
            items[next].focus();
        });
        on(pickerToggleBtn, 'click', () => {
            setCollapsed(!picker.classList.contains('is-collapsed'));
            if (!picker.classList.contains('is-collapsed')) filterInput.focus();
        });
        setCollapsed(picker.classList.contains('is-collapsed'));

        setBodyMessage('请选择要查看的文件');
        if (typeof api?.gitListWorkspaces !== 'function' || typeof api?.sourceListFiles !== 'function') {
            note.textContent = '当前窗口不支持浏览工作区文件';
            return;
        }
        try {
            const res = await api.gitListWorkspaces();
            if (store.isDisposed) return;
            const workspaces = res?.data?.workspaces || [];
            if (!res?.success || workspaces.length === 0) {
                wsSelect.disabled = true;
                filterInput.disabled = true;
                // 读失败不能说成「还没有工作区」，那会让用户去添加一个已经有的工作区
                note.textContent = res?.success ? '还没有工作区，请先在 Git 标签页或设置中添加工作区' : `读取工作区失败：${res?.error || '未知错误'}`;
                return;
            }
            for (const ws of workspaces) {
                const opt = doc.createElement('option');
                opt.value = ws.id;
                opt.textContent = ws.alias || ws.path;
                opt.title = ws.path;
                wsSelect.appendChild(opt);
            }
            const valid = (id) => workspaces.some((w) => w.id === id);
            let saved = null;
            try { saved = getStorage()?.getItem(SOURCE_WORKSPACE_KEY); } catch (_error) { /* Storage is optional. */ }
            const preferred = valid(saved) ? saved : res.data.activeWorkspaceId;
            wsSelect.value = valid(preferred) ? preferred : workspaces[0].id;
            activeWorkspaceId = wsSelect.value;
            await loadFiles();
        } catch (err) {
            if (store.isDisposed) return;
            note.textContent = `读取工作区失败: ${err?.message || err}`;
        }
    }

    return Object.freeze({ setupPicker });
}
