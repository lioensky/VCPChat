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



export function createCodeViewerEditor({
    store,
    api,
    body,
    doc,
    escapeHtml,
    filePath,
    renderDiffView
}) {
    function setBodyMessage(text, isError = false) {
        body.innerHTML = '';
        const msg = doc.createElement('div');
        msg.className = isError ? 'side-code-error' : 'side-code-empty';
        msg.textContent = text;
        body.appendChild(msg);
    }

    async function loadFileContent() {
        if (store.currentCode || !filePath) return;
        body.innerHTML = '<div class="side-code-loading"><span class="vcp-ui-icon spin">sync</span> 加载文件中...</div>';
        try {
            let content = null;
            if (api?.getTextContent) {
                const res = await api.getTextContent(filePath);
                content = (typeof res === 'object' && res !== null) ? (res.data || res.text || '') : res;
            }
            if (store.isDisposed) return;
            store.currentCode = content || '';
        } catch (err) {
            if (store.isDisposed) return;
            body.innerHTML = `<div class="side-code-error">读取文件失败: ${escapeHtml(err.message || String(err))}</div>`;
            return false;
        }
        return true;
    }

    function renderCodeView() {
        body.innerHTML = '';
        const editorShell = doc.createElement('div');
        editorShell.className = 'side-code-editor-shell';
        if (store.isWrapped) editorShell.classList.add('is-wrapped');

        // 文件末尾的换行只是行结束符，不算多出来的一行
        const lines = store.currentCode ? store.currentCode.replace(/\r?\n$/, '').split(/\r?\n/) : [''];
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
        code.className = `side-code-highlighted language-${store.currentLang}`;

        const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
        if (win?.hljs?.highlight) {
            try {
                const highlighted = win.hljs.highlight(store.currentCode || '', { language: store.currentLang, ignoreIllegals: true });
                code.innerHTML = highlighted.value;
            } catch {
                code.textContent = store.currentCode;
            }
        } else {
            code.textContent = store.currentCode;
        }

        pre.appendChild(code);
        editorShell.append(gutter, pre);
        body.appendChild(editorShell);
    }

    async function refreshView() {
        const loaded = await loadFileContent();
        if (loaded === false) return;
        if (store.currentMode === 'diff') {
            renderDiffView();
        } else {
            renderCodeView();
        }
    }

    return Object.freeze({ setBodyMessage, loadFileContent, renderCodeView, refreshView, dispose() {  } });
}
