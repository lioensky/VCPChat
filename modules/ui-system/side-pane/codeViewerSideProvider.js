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
import { createCodeViewerPicker } from './code-viewer/picker.js';
import { createCodeViewerEditor } from './code-viewer/editor.js';
import { readFileForViewer } from './code-viewer/file-read.js';
import { createCodeViewerDiffView } from './code-viewer/diff-view.js';
import { computeLineDiff } from '../line-diff.js';
import { detectLanguage } from './code-viewer/helpers.js';
export { detectLanguage } from './code-viewer/helpers.js';
export { escapeHtml } from '../text-escape.js';

// Same key as the V工程 源码 tab (ProjectForgemodules/projectforge-source.js), so both follow the same workspace choice.

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
            // 只带路径打开的是文件标签：内容从磁盘读，重新打开或刷新时重读；带了代码的是快照，不读盘
            const isFileBacked = Boolean(filePath) && !currentCode;

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

            // Reload Button（文件可能已在外部被修改或删除）
            let reloadBtn = null;
            if (isFileBacked) {
                reloadBtn = doc.createElement('button');
                reloadBtn.type = 'button';
                reloadBtn.className = 'side-code-action-btn';
                reloadBtn.setAttribute('data-action', 'reload-file');
                reloadBtn.title = '重新读取文件';
                reloadBtn.setAttribute('aria-label', '重新读取');
                reloadBtn.innerHTML = '<span class="vcp-ui-icon">refresh</span>';
                actionsWrapper.appendChild(reloadBtn);
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
            const store = Object.freeze({
                get isDisposed() { return isDisposed; },
                get isWrapped() { return isWrapped; },
                set isWrapped(value) { isWrapped = value; },
                get currentCode() { return currentCode; },
                set currentCode(value) { currentCode = value; },
                get currentMode() { return currentMode; },
                set currentMode(value) { currentMode = value; },
                get currentLang() { return currentLang; },
                set currentLang(value) { currentLang = value; },
                get currentTag() { return currentTag; },
                set currentTag(value) { currentTag = value; }
            });

            const pickerOwner = createCodeViewerPicker({
                store,
                api,
                detectLanguage,
                doc,
                getStorage,
                langTag,
                picker,
                pickerToggleBtn,
                renderCodeView: (...args) => renderCodeView(...args),
                setBodyMessage: (...args) => setBodyMessage(...args),
                titleLabel
            });
            const { setupPicker } = pickerOwner;

            const editorOwner = createCodeViewerEditor({
                store,
                body,
                doc,
                readFile: isFileBacked ? () => readFileForViewer(api, filePath) : null,
                renderDiffView: (...args) => renderDiffView(...args)
            });
            const { setBodyMessage, renderCodeView, refreshView, reload } = editorOwner;

            const diffViewOwner = createCodeViewerDiffView({
                store,
                body,
                computeLineDiff,
                doc,
                newCode,
                oldCode
            });
            const { renderDiffView } = diffViewOwner;

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
                const commands = (doc.defaultView || globalThis).VCPContributions?.commands;
                if (!commands?.get('composer.insert-text')) return;
                const formatted = `\`\`\`${currentLang}\n${currentCode}\n\`\`\`\n`;
                const result = commands.execute('composer.insert-text', formatted, { gap: 'line' });
                if (result?.inserted) uiHelper?.showToastNotification?.('代码片段已插入主输入框', 'success');
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

            reloadBtn?.addEventListener('click', () => reload());

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
                /** 文件标签重新读盘；片段和差异是快照，不受影响 */
                reload() {
                    return isFileBacked && !isDisposed ? reload() : Promise.resolve();
                },
                dispose() {
                    isDisposed = true;
                    pickerOwner.dispose();
                    editorOwner.dispose();
                    diffViewOwner.dispose();
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
            // 同一个文件已经有视图时，openTab 只会切过去；这里补一次重读，免得显示外部修改前的旧内容
            const existing = filePath && !code ? sidePaneController.getTabHandle?.(tabId) : null;

            const handle = await sidePaneController.openTab({
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
            if (existing && handle === existing) await handle.reload?.();
            return handle;
        }
    };
}
