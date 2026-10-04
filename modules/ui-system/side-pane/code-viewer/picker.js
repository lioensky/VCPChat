/**
 * modules/ui-system/side-pane/codeViewerSideProvider.js
 * VCPChat Universal Sub-screen - Code & Diff Viewer Provider
 *
 * Implements the universal sub-screen Code & Diff Viewer supporting:
 * 1. Single file / snippet viewing with line numbers and syntax highlighting
 * 2. Side-by-side or unified line diff comparison (additions, deletions, stats)
 * 3. Deep integration with chat: Copy code, wrap lines, insert into chat composer,
 *    and open in external editor / IDE.
 */

'use strict';

const SOURCE_WORKSPACE_KEY = 'vcp-projectforge-source-workspace';

export function createCodeViewerPicker({
    store,
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
    const cleanups = [];
    function on(node, event, listener) {
        node.addEventListener(event, listener);
        cleanups.push(() => node.removeEventListener(event, listener));
    }

    async function setupPicker() {
        const wsSelect = doc.createElement('select');
        wsSelect.className = 'side-code-picker-select';
        wsSelect.setAttribute('aria-label', '工作区');
        const filterInput = doc.createElement('input');
        filterInput.type = 'search';
        filterInput.className = 'side-code-picker-filter';
        filterInput.placeholder = '搜索文件名...';
        const list = doc.createElement('div');
        list.className = 'side-code-picker-list';
        list.setAttribute('role', 'listbox');
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
                if (rel === activePath) item.classList.add('active');
                const slash = rel.lastIndexOf('/');
                const name = doc.createElement('span');
                name.className = 'side-code-picker-name';
                name.textContent = slash === -1 ? rel : rel.slice(slash + 1);
                const dir = doc.createElement('span');
                dir.className = 'side-code-picker-dir';
                dir.textContent = slash === -1 ? '' : rel.slice(0, slash);
                item.append(name, dir);
                on(item, 'click', () => openFile(rel));
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
                    note.textContent = res?.error || '读取文件列表失败';
                    return;
                }
                files = res.data?.files || [];
                renderList();
                if (res.data?.truncated) {
                    note.textContent += `（文件过多，仅索引前 ${res.data.limit} 个）`;
                }
            } catch (err) {
                if (store.isDisposed || token !== listToken) return;
                note.textContent = `读取文件列表失败: ${err?.message || err}`;
            }
        }

        async function openFile(rel) {
            const workspaceId = activeWorkspaceId;
            activePath = rel;
            list.querySelectorAll('.side-code-picker-item').forEach((el) => {
                el.classList.toggle('active', el.dataset.path === rel);
            });
            setBodyMessage('加载文件中...');
            try {
                const res = await api.sourceReadFile(workspaceId, rel);
                if (store.isDisposed || rel !== activePath || workspaceId !== activeWorkspaceId) return;
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
                    picker.classList.add('is-collapsed');
                }
            } catch (err) {
                if (store.isDisposed) return;
                setBodyMessage(`读取文件失败: ${err?.message || err}`, true);
            }
        }

        on(wsSelect, 'change', () => {
            activeWorkspaceId = wsSelect.value;
            getStorage()?.setItem(SOURCE_WORKSPACE_KEY, activeWorkspaceId);
            activePath = '';
            store.currentCode = '';
            setBodyMessage('请选择要查看的文件');
            loadFiles();
        });
        on(filterInput, 'input', renderList);
        on(pickerToggleBtn, 'click', () => {
            picker.classList.toggle('is-collapsed');
            if (!picker.classList.contains('is-collapsed')) filterInput.focus();
        });

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
                note.textContent = '还没有工作区，请先在 Git 标签页或设置中添加工作区';
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
            const saved = getStorage()?.getItem(SOURCE_WORKSPACE_KEY);
            const preferred = valid(saved) ? saved : res.data.activeWorkspaceId;
            wsSelect.value = valid(preferred) ? preferred : workspaces[0].id;
            activeWorkspaceId = wsSelect.value;
            await loadFiles();
        } catch (err) {
            if (store.isDisposed) return;
            note.textContent = `读取工作区失败: ${err?.message || err}`;
        }
    }

    return Object.freeze({ setupPicker, dispose() { cleanups.splice(0).forEach(cleanup => cleanup()); } });
}
