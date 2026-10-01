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
import { computeLineDiff } from '../line-diff.js';

// Same key as the V工程 源码 tab (ProjectForgemodules/projectforge-source.js), so both follow the same workspace choice.
const SOURCE_WORKSPACE_KEY = 'vcp-projectforge-source-workspace';

/**
 * Maps common file extensions to language identifiers for highlight.js and display tags.
 */
const EXTENSION_MAP = Object.freeze({
    js: { lang: 'javascript', tag: 'JS' },
    mjs: { lang: 'javascript', tag: 'JS' },
    cjs: { lang: 'javascript', tag: 'JS' },
    ts: { lang: 'typescript', tag: 'TS' },
    tsx: { lang: 'typescript', tag: 'TSX' },
    jsx: { lang: 'javascript', tag: 'JSX' },
    py: { lang: 'python', tag: 'PY' },
    rs: { lang: 'rust', tag: 'RUST' },
    go: { lang: 'go', tag: 'GO' },
    java: { lang: 'java', tag: 'JAVA' },
    c: { lang: 'c', tag: 'C' },
    cpp: { lang: 'cpp', tag: 'C++' },
    h: { lang: 'c', tag: 'H' },
    hpp: { lang: 'cpp', tag: 'H++' },
    html: { lang: 'html', tag: 'HTML' },
    htm: { lang: 'html', tag: 'HTML' },
    css: { lang: 'css', tag: 'CSS' },
    scss: { lang: 'scss', tag: 'SCSS' },
    json: { lang: 'json', tag: 'JSON' },
    xml: { lang: 'xml', tag: 'XML' },
    md: { lang: 'markdown', tag: 'MD' },
    sh: { lang: 'bash', tag: 'SH' },
    bash: { lang: 'bash', tag: 'BASH' },
    zsh: { lang: 'bash', tag: 'ZSH' },
    ps1: { lang: 'powershell', tag: 'PS1' },
    sql: { lang: 'sql', tag: 'SQL' },
    yaml: { lang: 'yaml', tag: 'YAML' },
    yml: { lang: 'yaml', tag: 'YAML' },
    toml: { lang: 'toml', tag: 'TOML' },
    ini: { lang: 'ini', tag: 'INI' },
    diff: { lang: 'diff', tag: 'DIFF' },
    patch: { lang: 'diff', tag: 'PATCH' }
});

export function detectLanguage(filePathOrName, fallback = 'plaintext') {
    if (!filePathOrName || typeof filePathOrName !== 'string') {
        return { lang: fallback, tag: fallback.toUpperCase() };
    }
    const dotIndex = filePathOrName.lastIndexOf('.');
    if (dotIndex === -1) {
        return { lang: fallback, tag: fallback.toUpperCase() };
    }
    const ext = filePathOrName.slice(dotIndex + 1).toLowerCase();
    return EXTENSION_MAP[ext] || { lang: ext, tag: ext.toUpperCase() };
}

export function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Computes an ordered line-by-line diff between two text strings using Longest Common Subsequence (LCS).
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ rows: Array<{ type: 'same'|'add'|'del', oldLine: number|null, newLine: number|null, text: string }>, addedCount: number, deletedCount: number }}
 */
export { computeLineDiff } from '../line-diff.js';

/**
 * Creates the Code & Diff Viewer provider for the Universal Sub-screen.
 */
export function createCodeViewerSideProvider({
    document: doc = document,
    api = (typeof window !== 'undefined' ? (window.utilityAPI || window.electronAPI) : null),
    uiHelper = (typeof window !== 'undefined' ? window.uiHelperFunctions : null),
    sidePaneController = null
} = {}) {
    const kind = 'code-viewer';
    const getStorage = () => {
        try {
            return doc?.defaultView?.localStorage || null;
        } catch (_error) {
            return null;
        }
    };

    return {
        kind,

        /**
         * Mounts the Code & Diff Viewer into the tab's container.
         * @param {Object} tab - SidePaneTab descriptor
         * @param {HTMLElement} viewElement - DOM element container for this tab
         * @returns {Promise<Object>} Tab lifecycle handle
         */
        async mountTab(tab, viewElement) {
            viewElement.innerHTML = '';
            let isDisposed = false;
            let isWrapped = false;

            const payload = tab.payload || {};
            let currentMode = payload.mode === 'diff' ? 'diff' : 'view';
            let currentCode = payload.code || '';
            const filePath = payload.filePath || '';
            const oldCode = payload.oldCode || '';
            const newCode = payload.newCode ?? (currentMode === 'diff' ? currentCode : null);
            const langMeta = detectLanguage(filePath || tab.title || payload.language, payload.language || 'plaintext');
            let currentLang = langMeta.lang;
            let currentTag = langMeta.tag;
            // Opened from the "+" menu / launcher without any content: let the user browse a workspace instead of showing nothing.
            const isPickerMode = !filePath && !currentCode && !oldCode && !payload.mode;

            // 1. Root Container
            const container = doc.createElement('div');
            container.className = 'side-code-container';

            // 2. Toolbar
            const toolbar = doc.createElement('div');
            toolbar.className = 'side-code-toolbar';

            const infoWrapper = doc.createElement('div');
            infoWrapper.className = 'side-code-info';

            const fileIcon = doc.createElement('span');
            fileIcon.className = 'vcp-ui-icon side-code-file-icon';
            fileIcon.textContent = currentMode === 'diff' ? 'difference' : 'code';

            const titleLabel = doc.createElement('span');
            titleLabel.className = 'side-code-title';
            titleLabel.textContent = tab.title || (filePath ? filePath.split(/[/\\]/).pop() : '代码片段');
            titleLabel.title = filePath || tab.title || '代码查看器';

            const langTag = doc.createElement('span');
            langTag.className = 'side-code-lang-tag';
            langTag.textContent = currentMode === 'diff' ? 'DIFF' : currentTag;

            infoWrapper.append(fileIcon, titleLabel, langTag);

            const actionsWrapper = doc.createElement('div');
            actionsWrapper.className = 'side-code-actions';

            // Diff Mode Switcher (if both old and new or patch available)
            let modeToggleBtn = null;
            if (oldCode || currentMode === 'diff') {
                modeToggleBtn = doc.createElement('button');
                modeToggleBtn.type = 'button';
                modeToggleBtn.className = 'side-code-action-btn side-code-mode-toggle';
                modeToggleBtn.title = currentMode === 'diff' ? '切换为纯代码视图' : '切换为差异对比视图';
                modeToggleBtn.setAttribute('aria-label', '切换视图');
                modeToggleBtn.innerHTML = currentMode === 'diff'
                    ? '<span class="vcp-ui-icon">code</span>'
                    : '<span class="vcp-ui-icon">difference</span>';
                actionsWrapper.appendChild(modeToggleBtn);
            }

            // Wrap Toggle
            const wrapBtn = doc.createElement('button');
            wrapBtn.type = 'button';
            wrapBtn.className = 'side-code-action-btn';
            wrapBtn.setAttribute('data-action', 'toggle-wrap');
            wrapBtn.title = '切换自动换行';
            wrapBtn.setAttribute('aria-label', '自动换行');
            wrapBtn.innerHTML = '<span class="vcp-ui-icon">wrap_text</span>';

            // Copy Code Button
            const copyBtn = doc.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'side-code-action-btn';
            copyBtn.setAttribute('data-action', 'copy-code');
            copyBtn.title = '复制代码内容';
            copyBtn.setAttribute('aria-label', '复制代码');
            copyBtn.innerHTML = '<span class="vcp-ui-icon">content_copy</span>';

            // Insert to Chat Button
            const insertBtn = doc.createElement('button');
            insertBtn.type = 'button';
            insertBtn.className = 'side-code-action-btn';
            insertBtn.setAttribute('data-action', 'insert-chat');
            insertBtn.title = '插入到主聊天输入框';
            insertBtn.setAttribute('aria-label', '插入聊天');
            insertBtn.innerHTML = '<span class="vcp-ui-icon">format_quote</span>';

            // External Open Button
            let externalBtn = null;
            if (filePath) {
                externalBtn = doc.createElement('button');
                externalBtn.type = 'button';
                externalBtn.className = 'side-code-action-btn';
                externalBtn.setAttribute('data-action', 'open-external');
                externalBtn.title = '在外部编辑器中打开';
                externalBtn.setAttribute('aria-label', '外部打开');
                externalBtn.innerHTML = '<span class="vcp-ui-icon">open_in_new</span>';
            }

            actionsWrapper.append(wrapBtn, copyBtn, insertBtn);
            if (externalBtn) actionsWrapper.appendChild(externalBtn);
            toolbar.append(infoWrapper, actionsWrapper);

            // 3. Body
            const body = doc.createElement('div');
            body.className = 'side-code-body';

            let picker = null;
            let pickerToggleBtn = null;
            if (isPickerMode) {
                picker = doc.createElement('div');
                picker.className = 'side-code-picker';
                pickerToggleBtn = doc.createElement('button');
                pickerToggleBtn.type = 'button';
                pickerToggleBtn.className = 'side-code-action-btn';
                pickerToggleBtn.title = '选择文件';
                pickerToggleBtn.setAttribute('aria-label', '选择文件');
                pickerToggleBtn.innerHTML = '<span class="vcp-ui-icon">folder_open</span>';
                actionsWrapper.prepend(pickerToggleBtn);
                container.append(toolbar, picker, body);
            } else {
                container.append(toolbar, body);
            }
            viewElement.appendChild(container);

            // ---- Workspace file picker ----
            function setBodyMessage(text, isError = false) {
                body.innerHTML = '';
                const msg = doc.createElement('div');
                msg.className = isError ? 'side-code-error' : 'side-code-empty';
                msg.textContent = text;
                body.appendChild(msg);
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
                        item.addEventListener('click', () => openFile(rel));
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
                        if (isDisposed || token !== listToken) return;
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
                        if (isDisposed || token !== listToken) return;
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
                        if (isDisposed || rel !== activePath || workspaceId !== activeWorkspaceId) return;
                        if (!res?.success) {
                            setBodyMessage(res?.error || '读取文件失败', true);
                            return;
                        }
                        const file = res.data || {};
                        const name = rel.slice(rel.lastIndexOf('/') + 1);
                        const meta = detectLanguage(name, 'plaintext');
                        currentLang = meta.lang;
                        currentTag = meta.tag;
                        titleLabel.textContent = name;
                        titleLabel.title = rel;
                        langTag.textContent = currentTag;
                        currentCode = '';
                        if (file.binary) {
                            setBodyMessage('二进制文件，无法预览');
                        } else if (file.tooLarge) {
                            setBodyMessage(`文件过大（${Math.round((file.size || 0) / 1024)} KB），无法预览`);
                        } else if (file.encodingError) {
                            setBodyMessage('文件编码无法识别为 UTF-8，无法预览', true);
                        } else {
                            currentCode = file.text || '';
                            renderCodeView();
                            picker.classList.add('is-collapsed');
                        }
                    } catch (err) {
                        if (isDisposed) return;
                        setBodyMessage(`读取文件失败: ${err?.message || err}`, true);
                    }
                }

                wsSelect.addEventListener('change', () => {
                    activeWorkspaceId = wsSelect.value;
                    getStorage()?.setItem(SOURCE_WORKSPACE_KEY, activeWorkspaceId);
                    activePath = '';
                    currentCode = '';
                    setBodyMessage('请选择要查看的文件');
                    loadFiles();
                });
                filterInput.addEventListener('input', renderList);
                pickerToggleBtn.addEventListener('click', () => {
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
                    if (isDisposed) return;
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
                    if (isDisposed) return;
                    note.textContent = `读取工作区失败: ${err?.message || err}`;
                }
            }

            // Fetch File Content if needed
            async function loadFileContent() {
                if (currentCode || !filePath) return;
                body.innerHTML = '<div class="side-code-loading"><span class="vcp-ui-icon spin">sync</span> 加载文件中...</div>';
                try {
                    let content = null;
                    if (api?.getTextContent) {
                        const res = await api.getTextContent(filePath);
                        content = (typeof res === 'object' && res !== null) ? (res.data || res.text || '') : res;
                    }
                    if (isDisposed) return;
                    currentCode = content || '';
                } catch (err) {
                    if (isDisposed) return;
                    body.innerHTML = `<div class="side-code-error">读取文件失败: ${escapeHtml(err.message || String(err))}</div>`;
                    return false;
                }
                return true;
            }

            // Render Functions
            function renderCodeView() {
                body.innerHTML = '';
                const editorShell = doc.createElement('div');
                editorShell.className = 'side-code-editor-shell';
                if (isWrapped) editorShell.classList.add('is-wrapped');

                // 文件末尾的换行只是行结束符，不算多出来的一行
                const lines = currentCode ? currentCode.replace(/\r?\n$/, '').split(/\r?\n/) : [''];
                const gutter = doc.createElement('div');
                gutter.className = 'side-code-gutter';
                gutter.setAttribute('aria-hidden', 'true');

                for (let idx = 1; idx <= lines.length; idx++) {
                    const lineNum = doc.createElement('div');
                    lineNum.className = 'side-code-line-number';
                    lineNum.textContent = String(idx);
                    gutter.appendChild(lineNum);
                }

                const pre = doc.createElement('pre');
                pre.className = 'side-code-pre';
                const code = doc.createElement('code');
                code.className = `side-code-highlighted language-${currentLang}`;

                const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
                if (win?.hljs?.highlight) {
                    try {
                        const highlighted = win.hljs.highlight(currentCode || '', { language: currentLang, ignoreIllegals: true });
                        code.innerHTML = highlighted.value;
                    } catch {
                        code.textContent = currentCode;
                    }
                } else {
                    code.textContent = currentCode;
                }

                pre.appendChild(code);
                editorShell.append(gutter, pre);
                body.appendChild(editorShell);
            }

            function renderDiffView() {
                body.innerHTML = '';
                const diffShell = doc.createElement('div');
                diffShell.className = 'side-diff-shell';
                if (isWrapped) diffShell.classList.add('is-wrapped');

                let diffResult;
                try { diffResult = computeLineDiff(oldCode, newCode ?? currentCode); }
                catch (error) { body.textContent = error.message; return; }
                const statsBar = doc.createElement('div');
                statsBar.className = 'side-diff-stats-bar';
                statsBar.innerHTML = `
                    <span class="side-diff-badge add">+${diffResult.addedCount}</span>
                    <span class="side-diff-badge del">-${diffResult.deletedCount}</span>
                    <span class="side-diff-meta">总计 ${diffResult.rows.length} 行对比${diffResult.approximate ? '（大段内容按区块比较，增删数为估算）' : ''}</span>
                `;
                diffShell.appendChild(statsBar);

                const table = doc.createElement('div');
                table.className = 'side-diff-table';

                const appendRow = row => {
                    const rowDiv = doc.createElement('div');
                    rowDiv.className = `side-diff-row is-${row.type}`;

                    const oldNum = doc.createElement('span');
                    oldNum.className = 'side-diff-cell side-diff-num old';
                    oldNum.textContent = row.oldLine !== null ? String(row.oldLine) : '';

                    const newNum = doc.createElement('span');
                    newNum.className = 'side-diff-cell side-diff-num new';
                    newNum.textContent = row.newLine !== null ? String(row.newLine) : '';

                    const sign = doc.createElement('span');
                    sign.className = 'side-diff-cell side-diff-sign';
                    sign.textContent = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';

                    const text = doc.createElement('span');
                    text.className = 'side-diff-cell side-diff-text';
                    text.textContent = row.text;

                    rowDiv.append(oldNum, newNum, sign, text);
                    table.appendChild(rowDiv);
                };
                let displayed = 0;
                const more = doc.createElement('button');
                more.type = 'button';
                more.className = 'side-code-action-btn';
                function appendPage() {
                    const end = Math.min(displayed + 500, diffResult.rows.length);
                    while (displayed < end) appendRow(diffResult.rows[displayed++]);
                    more.textContent = '显示更多行（剩余 ' + (diffResult.rows.length - displayed) + ' 行）';
                    more.hidden = displayed >= diffResult.rows.length;
                }
                more.addEventListener('click', appendPage);
                appendPage();
                diffShell.append(table, more);
                body.appendChild(diffShell);
            }

            async function refreshView() {
                const loaded = await loadFileContent();
                if (loaded === false) return;
                if (currentMode === 'diff') {
                    renderDiffView();
                } else {
                    renderCodeView();
                }
            }

            // Event Listeners
            wrapBtn.addEventListener('click', () => {
                isWrapped = !isWrapped;
                wrapBtn.classList.toggle('active', isWrapped);
                const shell = body.querySelector('.side-code-editor-shell, .side-diff-shell');
                shell?.classList.toggle('is-wrapped', isWrapped);
            });

            copyBtn.addEventListener('click', async () => {
                const textToCopy = currentMode === 'diff'
                    ? (newCode || currentCode)
                    : currentCode;
                try {
                    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
                    if (win?.navigator?.clipboard?.writeText) {
                        await win.navigator.clipboard.writeText(textToCopy);
                    } else if (api?.writeTextToClipboard) {
                        await api.writeTextToClipboard(textToCopy);
                    }
                    copyBtn.classList.add('copied');
                    uiHelper?.showToastNotification?.('代码已复制到剪贴板', 'success');
                    setTimeout(() => copyBtn.classList.remove('copied'), 1500);
                } catch (err) {
                    console.error('[CodeViewerSideProvider] Copy failed:', err);
                    uiHelper?.showToastNotification?.('复制代码失败', 'error');
                }
            });

            insertBtn.addEventListener('click', () => {
                const messageInput = doc.getElementById('messageInput');
                if (!messageInput) return;
                const formatted = `\`\`\`${currentLang}\n${currentCode}\n\`\`\`\n`;
                const currentValue = messageInput.value || '';
                const separator = (currentValue.length > 0 && !currentValue.endsWith('\n')) ? '\n' : '';
                messageInput.value = currentValue + separator + formatted;
                const EventCtor = doc.defaultView?.Event || (typeof Event !== 'undefined' ? Event : null);
                if (EventCtor) {
                    messageInput.dispatchEvent(new EventCtor('input', { bubbles: true }));
                }
                messageInput.focus();
                uiHelper?.showToastNotification?.('代码片段已插入主输入框', 'success');
            });

            if (modeToggleBtn) {
                modeToggleBtn.addEventListener('click', () => {
                    currentMode = currentMode === 'diff' ? 'view' : 'diff';
                    fileIcon.textContent = currentMode === 'diff' ? 'difference' : 'code';
                    langTag.textContent = currentMode === 'diff' ? 'DIFF' : currentTag;
                    modeToggleBtn.title = currentMode === 'diff' ? '切换为纯代码视图' : '切换为差异对比视图';
                    modeToggleBtn.innerHTML = currentMode === 'diff'
                        ? '<span class="vcp-ui-icon">code</span>'
                        : '<span class="vcp-ui-icon">difference</span>';
                    refreshView();
                });
            }

            if (externalBtn && filePath) {
                externalBtn.addEventListener('click', () => {
                    if (api?.openPythonAttachmentInTextEditor) {
                        api.openPythonAttachmentInTextEditor(filePath);
                    } else if (api?.sendOpenExternalLink) {
                        api.sendOpenExternalLink(filePath);
                    } else {
                        uiHelper?.showToastNotification?.(`文件路径: ${filePath}`, 'info');
                    }
                });
            }

            if (isPickerMode) {
                await setupPicker();
            } else {
                await refreshView();
            }

            return {
                focus() {
                    body.focus?.();
                },
                getCode() {
                    return currentCode;
                },
                getMode() {
                    return currentMode;
                },
                dispose() {
                    isDisposed = true;
                    viewElement.innerHTML = '';
                }
            };
        },

        /**
         * Helper to open code viewer tab via sidePaneController.
         */
        async openViewer(options = {}) {
            if (!sidePaneController) return null;
            const {
                filePath = '',
                code = '',
                language = 'plaintext',
                title = '',
                mode = 'view',
                oldCode = '',
                newCode = '',
                closable = true,
                scopeMode = 'global'
            } = options;

            const langMeta = detectLanguage(filePath || title || language, language);
            const resolvedTitle = title || (filePath ? filePath.split(/[/\\]/).pop() : '代码查看器');
            const tabId = filePath ? `code-viewer:${filePath}` : `code-viewer:${Date.now()}`;

            return await sidePaneController.openTab({
                id: tabId,
                kind,
                title: resolvedTitle,
                icon: mode === 'diff' ? 'difference' : 'code',
                closable,
                scopeMode,
                payload: {
                    filePath,
                    code,
                    language: langMeta.lang,
                    mode,
                    oldCode,
                    newCode
                }
            });
        }
    };
}
