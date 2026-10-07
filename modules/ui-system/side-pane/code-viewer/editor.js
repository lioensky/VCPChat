/**
 * modules/ui-system/side-pane/code-viewer/editor.js
 * 代码查看器的单文件视图：读取文件、渲染带行号的代码，以及读取失败/过大时的提示。
 */

'use strict';

// 整段高亮和逐行行号的成本随文件大小线性增长；超过这个字符数只预览开头，复制和插入仍用完整内容
export const PREVIEW_CHAR_LIMIT = 256 * 1024;

// 每块的行数：块越小滚动时补排越勤，越大切回标签时要排的越多；200 行约 3600px，比侧栏高出几屏。
// 样式表里块的占位高度按 200 × 18px 写死（side-pane-code-viewer.css 的 .side-code-chunk），改这里要一起改
export const CODE_CHUNK_LINES = 200;

/**
 * 把 highlight.js 的整段输出按行切开：跨行的 <span>（多行注释、模板字符串）在行尾闭合、下一行重新打开，
 * 这样每块都是合法的 HTML，又不必按块各自高亮（那样会丢掉跨块的语法状态）。
 * highlight.js 只输出 <span class="…"> 和转义过的文本，所以按标签切分是安全的。
 */
export function splitHighlightedLines(html) {
    const lines = [];
    const open = [];
    let current = '';
    const token = /(<span[^>]*>)|(<\/span>)|(\r?\n)|([^<\r\n]+)/g;
    let match;
    while ((match = token.exec(html))) {
        if (match[1]) {
            open.push(match[1]);
            current += match[1];
        } else if (match[2]) {
            open.pop();
            current += match[2];
        } else if (match[3]) {
            lines.push(current + '</span>'.repeat(open.length));
            current = open.join('');
        } else {
            current += match[4];
        }
    }
    lines.push(current);
    return lines;
}

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
        const trimmed = shownCode.replace(/\r?\n$/, '');
        const lineCount = shownCode ? trimmed.split(/\r?\n/).length : 1;
        const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
        let lineHtml = null;
        if (win?.hljs?.highlight) {
            try {
                lineHtml = splitHighlightedLines(win.hljs.highlight(trimmed, { language: store.currentLang, ignoreIllegals: true }).value);
            } catch {
                lineHtml = null;
            }
        }
        const lineText = lineHtml ? null : (shownCode ? trimmed.split(/\r?\n/) : ['']);

        // 行号栏和代码各按 CODE_CHUNK_LINES 行分块，块用 content-visibility:auto：滚出视口的块不参与样式和布局。
        // 大文件切回这个标签、聚焦时，浏览器只需要排视口里的那几块，开销不再随文件行数增长。
        // 行高固定，两栏的块高度一致，行号仍然和代码对齐。最后一块不满 200 行，总是正常排版，不用占位高度。
        const gutter = doc.createElement('div');
        gutter.className = 'side-code-gutter';
        gutter.setAttribute('aria-hidden', 'true');
        const pre = doc.createElement('pre');
        pre.className = 'side-code-pre';
        const code = doc.createElement('code');
        code.className = `side-code-highlighted language-${store.currentLang}`;

        for (let start = 0; start < lineCount; start += CODE_CHUNK_LINES) {
            const end = Math.min(lineCount, start + CODE_CHUNK_LINES);

            const numbers = doc.createElement('div');
            numbers.className = 'side-code-chunk';
            for (let idx = start + 1; idx <= end; idx++) {
                const lineNum = doc.createElement('div');
                lineNum.className = 'side-code-line-number';
                lineNum.textContent = String(idx);
                numbers.appendChild(lineNum);
            }
            gutter.appendChild(numbers);

            const text = doc.createElement('div');
            text.className = 'side-code-chunk';
            // 块末尾补一个换行：块尾的换行不会多画一行，但 textContent 和复制出来的文本保持原样
            const tail = end < lineCount ? '\n' : '';
            if (lineHtml) text.innerHTML = lineHtml.slice(start, end).join('\n') + tail;
            else text.textContent = lineText.slice(start, end).join('\n') + tail;
            code.appendChild(text);
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
