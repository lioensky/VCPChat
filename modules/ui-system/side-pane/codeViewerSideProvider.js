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
import { toWorkspaceRelative } from '../git-file-diff.js';
import { createSidePaneRootScope } from './side-pane-occurrence.js';
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
         * @param {{ scope?: object }} [context] 控制器给的挂载上下文；scope 是这次挂载的 view scope
         * @returns {Promise<Object>} Tab lifecycle handle
         */
        async mountTab(tab, viewElement, { scope: viewScope = null, restoredState = null } = {}) {
            viewElement.innerHTML = '';
            // 这次挂载的监听和定时器都归 own：控制器释放 view 或调用 dispose 时一起拆掉
            const own = createSidePaneRootScope(viewScope, 'code-viewer');
            const disposed = () => !own.active;
            // 休眠后重新挂载：换行、视图模式、工作区外读取的确认和滚动位置都照原样回来
            let isWrapped = restoredState?.isWrapped === true;

            const payload = tab.payload || {};
            const openedMode = payload.mode === 'diff' ? 'diff' : 'view';
            let currentMode = restoredState?.mode === 'diff' || restoredState?.mode === 'view' ? restoredState.mode : openedMode;
            let currentCode = payload.code || '';
            const filePath = payload.filePath || '';
            const oldCode = payload.oldCode || '';
            const newCode = payload.newCode ?? (openedMode === 'diff' ? currentCode : null);
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
            fileIcon.setAttribute('aria-hidden', 'true');
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
                    ? '<span class="vcp-ui-icon" aria-hidden="true">code</span>'
                    : '<span class="vcp-ui-icon" aria-hidden="true">difference</span>';
                actionsWrapper.appendChild(modeToggleBtn);
            }

            // Wrap Toggle
            const wrapBtn = doc.createElement('button');
            wrapBtn.type = 'button';
            wrapBtn.className = 'side-code-action-btn';
            wrapBtn.setAttribute('data-action', 'toggle-wrap');
            wrapBtn.title = '切换自动换行';
            wrapBtn.setAttribute('aria-label', '自动换行');
            wrapBtn.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">wrap_text</span>';
            wrapBtn.classList.toggle('active', isWrapped);

            // Copy Code Button
            const copyBtn = doc.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'side-code-action-btn';
            copyBtn.setAttribute('data-action', 'copy-code');
            copyBtn.title = '复制代码内容';
            copyBtn.setAttribute('aria-label', '复制代码');
            copyBtn.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">content_copy</span>';

            // Insert to Chat Button
            const insertBtn = doc.createElement('button');
            insertBtn.type = 'button';
            insertBtn.className = 'side-code-action-btn';
            insertBtn.setAttribute('data-action', 'insert-chat');
            insertBtn.title = '插入到主聊天输入框';
            insertBtn.setAttribute('aria-label', '插入聊天');
            insertBtn.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">format_quote</span>';

            // External Open Button
            let externalBtn = null;
            if (filePath) {
                externalBtn = doc.createElement('button');
                externalBtn.type = 'button';
                externalBtn.className = 'side-code-action-btn';
                externalBtn.setAttribute('data-action', 'open-external');
                externalBtn.title = '在文件管理器中显示';
                externalBtn.setAttribute('aria-label', '在文件管理器中显示');
                externalBtn.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">folder_open</span>';
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
                reloadBtn.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">refresh</span>';
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
                pickerToggleBtn.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">folder_open</span>';
                actionsWrapper.prepend(pickerToggleBtn);
                container.append(toolbar, picker, body);
            } else {
                container.append(toolbar, body);
            }
            viewElement.appendChild(container);

            // ---- Workspace file picker ----
            const store = Object.freeze({
                get isDisposed() { return disposed(); },
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
                scope: own,
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
                readFile: isFileBacked ? (options) => readFileForViewer(api, filePath, options) : null,
                renderDiffView: (...args) => renderDiffView(...args)
            });
            const { setBodyMessage, renderCodeView, refreshView, reload } = editorOwner;
            if (restoredState?.outsideWorkspaceAllowed === true) editorOwner.allowOutsideWorkspace();

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
            own.listen(wrapBtn, 'click', () => {
                isWrapped = !isWrapped;
                wrapBtn.classList.toggle('active', isWrapped);
                const shell = body.querySelector('.side-code-editor-shell, .side-diff-shell');
                shell?.classList.toggle('is-wrapped', isWrapped);
            });

            own.listen(copyBtn, 'click', async () => {
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
                    if (disposed()) return;
                    copyBtn.classList.add('copied');
                    uiHelper?.showToastNotification?.('代码已复制到剪贴板', 'success');
                    own.timeout(() => copyBtn.classList.remove('copied'), 1500, 'copied-flash');
                } catch (err) {
                    console.error('[CodeViewerSideProvider] Copy failed:', err);
                    uiHelper?.showToastNotification?.('复制代码失败', 'error');
                }
            });

            own.listen(insertBtn, 'click', () => {
                const commands = (doc.defaultView || globalThis).VCPContributions?.commands;
                if (!commands?.get('composer.insert-text')) return;
                const formatted = `\`\`\`${currentLang}\n${currentCode}\n\`\`\`\n`;
                const result = commands.execute('composer.insert-text', formatted, { gap: 'line' });
                if (result?.inserted) uiHelper?.showToastNotification?.('代码片段已插入主输入框', 'success');
            });

            if (modeToggleBtn) {
                own.listen(modeToggleBtn, 'click', () => {
                    currentMode = currentMode === 'diff' ? 'view' : 'diff';
                    fileIcon.textContent = currentMode === 'diff' ? 'difference' : 'code';
                    langTag.textContent = currentMode === 'diff' ? 'DIFF' : currentTag;
                    modeToggleBtn.title = currentMode === 'diff' ? '切换为纯代码视图' : '切换为差异对比视图';
                    modeToggleBtn.innerHTML = currentMode === 'diff'
                        ? '<span class="vcp-ui-icon" aria-hidden="true">code</span>'
                        : '<span class="vcp-ui-icon" aria-hidden="true">difference</span>';
                    refreshView();
                });
            }

            if (reloadBtn) own.listen(reloadBtn, 'click', () => reload());

            if (externalBtn && filePath) {
                // 只在文件管理器里定位，不按文件关联打开：路径可能来自模型的工具调用，.bat / .lnk 按关联打开就是执行。
                // 已登记工作区里的文件走 gitRevealPath（主进程校验在工作区内）；别处的文件只提示路径。
                own.listen(externalBtn, 'click', async () => {
                    const toast = (message, type) => uiHelper?.showToastNotification?.(message, type);
                    try {
                        const listed = typeof api?.gitRevealPath === 'function' ? await api.gitListWorkspaces?.() : null;
                        const match = listed?.success ? toWorkspaceRelative(filePath, listed.data?.workspaces) : null;
                        if (!match) {
                            toast(`文件路径：${filePath}`, 'info');
                            return;
                        }
                        const res = await api.gitRevealPath(match.workspace.id, match.relPath, 'workspace');
                        if (!res?.success) throw new Error(res?.error || '无法在文件管理器中显示');
                    } catch (error) {
                        toast(error?.message || String(error), 'error');
                    }
                });
            }

            if (isPickerMode) {
                await setupPicker();
            } else {
                await refreshView();
                if (Number.isFinite(restoredState?.scrollTop)) body.scrollTop = restoredState.scrollTop;
                if (Number.isFinite(restoredState?.scrollLeft)) body.scrollLeft = restoredState.scrollLeft;
            }
            // 挂载途中被取消：控制器会丢掉这个视图，这里只清掉自己画的内容
            if (disposed()) {
                viewElement.innerHTML = '';
                return null;
            }
            // 休眠只发生在隐藏时，那时 display:none 的 body 读出来的滚动都是 0：位置在可见时就记下
            let lastScroll = { top: Number(restoredState?.scrollTop) || 0, left: Number(restoredState?.scrollLeft) || 0 };
            own.listen(body, 'scroll', () => {
                if (body.clientHeight > 0) lastScroll = { top: body.scrollTop, left: body.scrollLeft };
            }, { passive: true });

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
                captureState() {
                    return {
                        isWrapped,
                        mode: currentMode,
                        outsideWorkspaceAllowed: editorOwner.outsideWorkspaceAllowed,
                        scrollTop: body.clientHeight > 0 ? body.scrollTop : lastScroll.top,
                        scrollLeft: body.clientHeight > 0 ? body.scrollLeft : lastScroll.left
                    };
                },
                /** 文件标签重新读盘；片段和差异是快照，不受影响 */
                reload() {
                    return isFileBacked && !disposed() ? reload() : Promise.resolve();
                },
                dispose() {
                    editorOwner.dispose();
                    // DOM 同步清掉：scope 的释放是异步的，不能等它，免得把紧接着重新挂载的内容一起清掉
                    viewElement.innerHTML = '';
                    return own.dispose('code-viewer-disposed');
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
