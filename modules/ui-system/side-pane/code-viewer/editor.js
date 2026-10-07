/**
 * modules/ui-system/side-pane/code-viewer/editor.js
 * 代码查看器的单文件视图：读取文件、渲染带行号的代码，以及读取失败/过大时的提示。
 */

'use strict';

// 整段高亮和逐行行号的成本随文件大小线性增长；超过这个字符数只预览开头，复制和插入仍用完整内容
export const PREVIEW_CHAR_LIMIT = 256 * 1024;

// 文件末尾的换行只是行结束符，不算多出来的一行
function countLines(text) {
    let count = 1;
    for (let at = text.indexOf('\n'); at !== -1 && at < text.length - 1; at = text.indexOf('\n', at + 1)) count++;
    return count;
}

export function createCodeViewerEditor({
    store,
    body,
    doc,
    readFile = null,
    renderDiffView
}) {
    // 只有按路径打开的文件标签才有 readFile；代码片段和差异是打开时的快照，不重新读取
    let fileLoaded = false;
    let readToken = 0;
    // 用户点过「读取」后，工作区外的这个文件就不再问
    let outsideWorkspaceAllowed = false;

    function setBodyMessage(text, isError = false) {
        body.innerHTML = '';
        const msg = doc.createElement('div');
        msg.className = isError ? 'side-code-error' : 'side-code-empty';
        msg.textContent = text;
        body.appendChild(msg);
    }

    function showConsent(notice) {
        body.innerHTML = '';
        const box = doc.createElement('div');
        box.className = 'side-pane-mount-error side-code-consent';
        const [title, ...rest] = String(notice || '').split('\n');
        const titleEl = doc.createElement('div');
        titleEl.className = 'side-pane-mount-error-title';
        titleEl.textContent = title;
        const detail = doc.createElement('div');
        detail.className = 'side-pane-mount-error-detail';
        detail.textContent = rest.join('\n');
        const read = doc.createElement('button');
        read.type = 'button';
        read.className = 'side-pane-mount-error-retry';
        read.textContent = '读取这个文件';
        read.addEventListener('click', () => {
            outsideWorkspaceAllowed = true;
            void refreshView({ force: true });
        });
        box.append(titleEl, detail, read);
        body.appendChild(box);
    }

    /**
     * 读取文件内容到 store。返回 true 表示可以渲染；false 表示已显示错误/提示，或者被更新的读取取代。
     * force 用于重新打开或手动刷新：文件可能已在外部被修改或删除。
     */
    async function loadFileContent({ force = false } = {}) {
        if (!readFile || (fileLoaded && !force)) return true;
        const token = ++readToken;
        body.innerHTML = '<div class="side-code-loading"><span class="vcp-ui-icon spin">sync</span> 加载文件中...</div>';
        let result;
        try {
            result = await readFile({ allowOutsideWorkspace: outsideWorkspaceAllowed });
        } catch (err) {
            result = { ok: false, error: `读取文件失败: ${err?.message || err}` };
        }
        if (store.isDisposed || token !== readToken) return false;
        if (!result?.ok) {
            // 失败时不保留旧内容，免得复制/插入拿到已经不存在的文件内容
            store.currentCode = '';
            fileLoaded = false;
            if (result?.needsConsent) showConsent(result.notice);
            else if (result?.notice) setBodyMessage(result.notice);
            else setBodyMessage(result?.error || '读取文件失败', true);
            return false;
        }
        store.currentCode = result.text;
        fileLoaded = true;
        return true;
    }

    function renderCodeView() {
        body.innerHTML = '';
        const fullCode = store.currentCode || '';
        let shownCode = fullCode;
        if (fullCode.length > PREVIEW_CHAR_LIMIT) {
            // 在行尾截断，最后一行不显示半截
            const cut = fullCode.lastIndexOf('\n', PREVIEW_CHAR_LIMIT);
            shownCode = fullCode.slice(0, cut > 0 ? cut : PREVIEW_CHAR_LIMIT);
            const note = doc.createElement('div');
            note.className = 'side-code-truncated-note';
            // 按行数说明：字符数换算不成字节（中文一个字三字节），行数才是准的
            note.textContent = `文件较大（共 ${countLines(fullCode)} 行），只预览前 ${countLines(shownCode)} 行；完整内容请在外部编辑器中查看。`;
            body.appendChild(note);
        }

        const editorShell = doc.createElement('div');
        editorShell.className = 'side-code-editor-shell';
        if (store.isWrapped) editorShell.classList.add('is-wrapped');

        // 文件末尾的换行只是行结束符，不算多出来的一行
        const lines = shownCode ? shownCode.replace(/\r?\n$/, '').split(/\r?\n/) : [''];
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
                const highlighted = win.hljs.highlight(shownCode, { language: store.currentLang, ignoreIllegals: true });
                code.innerHTML = highlighted.value;
            } catch {
                code.textContent = shownCode;
            }
        } else {
            code.textContent = shownCode;
        }

        pre.appendChild(code);
        editorShell.append(gutter, pre);
        body.appendChild(editorShell);
    }

    async function refreshView({ force = false } = {}) {
        const loaded = await loadFileContent({ force });
        if (loaded === false) return;
        if (store.currentMode === 'diff') {
            renderDiffView();
        } else {
            renderCodeView();
        }
    }

    return Object.freeze({
        setBodyMessage,
        loadFileContent,
        renderCodeView,
        refreshView,
        // 文件标签被重新打开或点了刷新：重新读盘
        reload: () => refreshView({ force: true }),
        dispose() { readToken++; }
    });
}
