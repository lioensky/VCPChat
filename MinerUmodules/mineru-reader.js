// MinerUmodules/mineru-reader.js
// Markdown + PDF 双栏阅读器：Markdown 图片走 vcp-mineru 协议，PDF 由内置 pdf.js 渲染。
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const MAX_FIND_HITS = 400;
const MAX_OUTLINE_NODES = 2000;
const MAX_QUALITY_ROWS = 100;
const MAX_CANVAS_PIXELS = 32_000_000;
const MAX_CANVAS_SIDE = 16384;
const POSITION_PREFIX = 'vcp-mineru-reader:';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

function normalizeMatchText(value) {
    return String(value || '')
        .toLocaleLowerCase()
        .replace(/[\s\u00a0]+/g, '')
        .replace(/[\p{P}\p{S}]/gu, '');
}

function normalizeRelativePath(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    try {
        value = decodeURIComponent(value);
    } catch {
        // 保留原始值
    }
    value = value.replace(/\\/g, '/');
    const segments = [];
    for (const part of value.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            segments.pop();
        } else {
            segments.push(part);
        }
    }
    return segments.join('/');
}

function basenameOf(value) {
    return String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return new Uint8Array(data);
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) return new Uint8Array(data.data);
    if (data && Array.isArray(data.buffer)) return new Uint8Array(data.buffer);
    return null;
}

function isRenderCancelled(error) {
    return error?.name === 'RenderingCancelledException'
        || /cancelled/i.test(String(error?.message || ''));
}

export function createMinerUReader(options) {
    const {
        api,
        elements,
        toast,
        imageUrlOf,
        onOpenLink,
        onPdfUnavailable,
        onImageOpen,
    } = options;

    const state = {
        paperId: '',
        detail: null,
        headings: [],
        outlineNodes: [],
        findHits: [],
        findIndex: -1,
        findQuery: '',
        pdfDoc: null,
        pdfBytes: null,
        pdfPage: 1,
        pdfTotal: 0,
        fitMode: true,
        zoomScale: 1,
        renderSeq: 0,
        loadSeq: 0,
        resizeTimer: null,
        saveTimer: null,
        destroyed: false,
    };

    let resizeObserver = null;
    if (elements.pdfScroll && typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
            if (!state.fitMode || !state.pdfDoc) return;
            clearTimeout(state.resizeTimer);
            state.resizeTimer = setTimeout(() => {
                void renderCurrentPage();
            }, 160);
        });
        resizeObserver.observe(elements.pdfScroll);
    }

    function positionKey() {
        return state.paperId ? `${POSITION_PREFIX}${state.paperId}` : '';
    }

    function readPosition() {
        const key = positionKey();
        if (!key) return null;
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    function savePosition() {
        const key = positionKey();
        if (!key) return;
        try {
            localStorage.setItem(key, JSON.stringify({
                page: state.pdfPage,
                mdTop: elements.mdScroll?.scrollTop || 0,
                at: Date.now(),
            }));
        } catch {
            // 忽略存储失败
        }
    }

    function scheduleSavePosition() {
        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(savePosition, 320);
    }

    elements.mdScroll?.addEventListener('scroll', scheduleSavePosition, { passive: true });

    function setPlaceholder(text, { action = false } = {}) {
        if (!elements.pdfPlaceholder) return;
        elements.pdfPlaceholder.hidden = false;
        elements.pdfPlaceholder.innerHTML = '';
        const p = document.createElement('div');
        p.textContent = text;
        elements.pdfPlaceholder.appendChild(p);
        if (action) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn small';
            button.textContent = '关联本地 PDF';
            button.addEventListener('click', () => onPdfUnavailable?.());
            elements.pdfPlaceholder.appendChild(button);
        }
        if (elements.pdfCanvas) elements.pdfCanvas.hidden = true;
    }

    function clearPlaceholder() {
        if (elements.pdfPlaceholder) {
            elements.pdfPlaceholder.hidden = true;
            elements.pdfPlaceholder.textContent = '';
        }
        if (elements.pdfCanvas) elements.pdfCanvas.hidden = false;
    }

    function updatePdfControls() {
        if (elements.pdfPageInput) {
            elements.pdfPageInput.value = String(state.pdfPage || 1);
            elements.pdfPageInput.max = String(state.pdfTotal || 1);
        }
        if (elements.pdfPageTotal) elements.pdfPageTotal.textContent = `/ ${state.pdfTotal || 0}`;
    }

    function updateZoomLabel(scale) {
        if (elements.pdfZoomLabel) elements.pdfZoomLabel.textContent = `${Math.round((scale || 1) * 100)}%`;
    }

    async function renderCurrentPage() {
        if (!state.pdfDoc || state.destroyed) return;
        const pageNumber = Math.min(Math.max(1, state.pdfPage), state.pdfTotal || 1);
        const seq = ++state.renderSeq;
        try {
            const page = await state.pdfDoc.getPage(pageNumber);
            if (seq !== state.renderSeq || state.destroyed) return;
            const base = page.getViewport({ scale: 1 });
            const available = Math.max(240, (elements.pdfScroll?.clientWidth || 640) - 40);
            const scale = state.fitMode
                ? Math.min(4, Math.max(0.25, available / base.width))
                : Math.min(4, Math.max(0.25, state.zoomScale));
            const dpr = Math.min(2.5, window.devicePixelRatio || 1);
            // 超大页面 / 高 DPR / 高倍缩放时限制画布像素与单边尺寸，避免分配失败
            const maxScale = Math.min(
                Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, base.width * base.height)) / dpr,
                MAX_CANVAS_SIDE / Math.max(base.width, base.height) / dpr,
            );
            const effectiveScale = Math.max(0.02, Math.min(scale, maxScale));
            const viewport = page.getViewport({ scale: effectiveScale });
            const canvas = elements.pdfCanvas;
            if (!canvas) return;
            canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
            canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) return;
            context.save();
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.restore();
            const task = page.render({
                canvasContext: context,
                viewport,
                transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
            });
            await task.promise;
            if (seq !== state.renderSeq || state.destroyed) return;
            clearPlaceholder();
            state.zoomScale = effectiveScale;
            updateZoomLabel(effectiveScale);
            updatePdfControls();
        } catch (error) {
            if (!isRenderCancelled(error) && !state.destroyed) {
                setPlaceholder(`PDF 页面渲染失败：${error?.message || error}`);
            }
        }
    }

    async function loadPdf(detail) {
        const paperId = detail.paper?.paperId || '';
        disposePdf();
        const seq = ++state.loadSeq;
        state.paperId = paperId;
        state.detail = detail;
        if (!paperId) return;
        if (!detail.pdfAvailable) {
            setPlaceholder('这篇论文还没有可用的本地 PDF。解析时记录了源文件路径，或可手动关联一个 PDF。', { action: true });
            return;
        }
        setPlaceholder('正在加载 PDF...');
        try {
            const result = await api.mineruReadPdf(paperId);
            if (seq !== state.loadSeq || state.destroyed) return;
            if (!result?.success) throw new Error(result?.error || '读取 PDF 失败');
            if (!result.data?.available) {
                setPlaceholder(result.data?.reason || '没有可用的本地 PDF。', { action: true });
                return;
            }
            const bytes = toBytes(result.data.data);
            if (!bytes?.byteLength) throw new Error('PDF 数据为空。');
            state.pdfBytes = bytes;
            const task = pdfjsLib.getDocument({ data: bytes });
            const doc = await task.promise;
            if (seq !== state.loadSeq || state.destroyed) {
                doc.destroy();
                return;
            }
            state.pdfDoc = doc;
            state.pdfTotal = doc.numPages;
            const saved = readPosition();
            state.pdfPage = Math.min(Math.max(1, Number(saved?.page) || 1), state.pdfTotal);
            updatePdfControls();
            await renderCurrentPage();
            if (saved?.mdTop && elements.mdScroll) {
                elements.mdScroll.scrollTop = Number(saved.mdTop) || 0;
            }
        } catch (error) {
            if (seq !== state.loadSeq || state.destroyed) return;
            setPlaceholder(`PDF 加载失败：${error?.message || error}`, { action: true });
        }
    }

    function disposePdf() {
        state.loadSeq += 1;
        state.renderSeq += 1;
        if (state.pdfDoc) {
            try { state.pdfDoc.destroy(); } catch { /* ignore */ }
        }
        state.pdfDoc = null;
        state.pdfBytes = null;
        state.pdfPage = 1;
        state.pdfTotal = 0;
        updatePdfControls();
    }

    function renderOutline(detail) {
        const outline = Array.isArray(detail.index?.outline) ? detail.index.outline : [];
        state.outlineNodes = outline;
        if (!elements.outlineList) return;
        elements.outlineList.innerHTML = '';
        if (!outline.length) {
            elements.outlineList.innerHTML = '<div class="empty-list">没有识别到标题层级</div>';
            return;
        }
        const visible = outline.length > MAX_OUTLINE_NODES
            ? outline.slice(0, MAX_OUTLINE_NODES)
            : outline;
        const counters = [];
        for (let index = 0; index < visible.length; index += 1) {
            const node = visible[index];
            const level = Math.min(6, Math.max(1, Number(node.level) || 1));
            while (counters.length < level) counters.push(0);
            counters[level - 1] += 1;
            counters.length = level;
            const number = counters.map(count => count || 1).join('.');
            const text = node.text || '(无标题)';
            const hasOwnNumber = /^\s*(?:\d+(?:\.\d+)*|[IVXLC]+\.?)\s+/i.test(text);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `outline-item level-${level}`;
            button.dataset.index = String(index);
            button.title = `${text} · p${(Number(node.page_idx) || 0) + 1}`;
            const numberSpan = document.createElement('span');
            numberSpan.className = 'page';
            numberSpan.textContent = hasOwnNumber ? '' : number;
            const textSpan = document.createElement('span');
            textSpan.className = 'text';
            textSpan.textContent = text;
            const pageSpan = document.createElement('span');
            pageSpan.className = 'page';
            pageSpan.textContent = `p${(Number(node.page_idx) || 0) + 1}`;
            button.append(numberSpan, textSpan, pageSpan);
            button.addEventListener('click', () => goToOutline(index));
            elements.outlineList.appendChild(button);
        }
        if (visible.length < outline.length) {
            const note = document.createElement('div');
            note.className = 'empty-list';
            note.textContent = `仅显示前 ${MAX_OUTLINE_NODES} 条，共 ${outline.length} 条`;
            elements.outlineList.appendChild(note);
        }
    }

    function goToOutline(index) {
        const node = state.outlineNodes[index];
        if (!node) return;
        const target = findHeadingElement(node.text);
        if (target) {
            target.scrollIntoView({ block: 'start', behavior: 'smooth' });
            target.classList.add('outline-target');
            setTimeout(() => target.classList.remove('outline-target'), 1200);
        }
        if (Number.isInteger(node.page_idx) && state.pdfDoc) {
            void goToPage(Number(node.page_idx) + 1);
        }
    }

    function findHeadingElement(text) {
        const needle = normalizeMatchText(text);
        if (!needle) return null;
        const exact = state.headings.find(entry => entry.normalized === needle);
        if (exact) return exact.element;
        const starts = state.headings.find(entry => entry.normalized.startsWith(needle) || needle.startsWith(entry.normalized));
        if (starts) return starts.element;
        const contains = state.headings.find(entry => entry.normalized.includes(needle) || needle.includes(entry.normalized));
        return contains?.element || null;
    }

    function renderQuality(detail) {
        const box = elements.qualityBox;
        if (!box) return;
        const errors = Array.isArray(detail.index?.errors) ? detail.index.errors : [];
        const warnings = Array.isArray(detail.index?.warnings) ? detail.index.warnings : [];
        if (!errors.length && !warnings.length) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        box.hidden = false;
        box.innerHTML = '';
        const title = document.createElement('div');
        title.textContent = '质检';
        title.style.fontWeight = '650';
        title.style.marginBottom = '5px';
        box.appendChild(title);
        for (const error of errors.slice(0, MAX_QUALITY_ROWS)) {
            const row = document.createElement('div');
            row.className = 'err';
            row.textContent = `错误：${error}`;
            box.appendChild(row);
        }
        for (const warning of warnings.slice(0, MAX_QUALITY_ROWS)) {
            const row = document.createElement('div');
            row.className = 'warn';
            row.textContent = `复核：${warning}`;
            box.appendChild(row);
        }
        if (errors.length > MAX_QUALITY_ROWS || warnings.length > MAX_QUALITY_ROWS) {
            const row = document.createElement('div');
            row.className = 'warn';
            row.textContent = `仅显示前 ${MAX_QUALITY_ROWS} 条，共 ${errors.length} 错误 / ${warnings.length} 复核`;
            box.appendChild(row);
        }
    }

    function clearFindMarks() {
        if (!elements.mdContent) return;
        const marks = [...elements.mdContent.querySelectorAll('mark.md-hit')];
        for (const mark of marks) {
            mark.replaceWith(document.createTextNode(mark.textContent || ''));
        }
        if (marks.length) elements.mdContent.normalize();
        state.findHits = [];
        state.findIndex = -1;
        if (elements.mdFindCount) {
            elements.mdFindCount.hidden = true;
            elements.mdFindCount.textContent = '';
        }
    }

    function highlightTextNode(node, query) {
        const text = node.nodeValue || '';
        const lower = text.toLocaleLowerCase();
        const needle = query.toLocaleLowerCase();
        if (!needle || !lower.includes(needle)) return;
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let index = lower.indexOf(needle);
        while (index !== -1 && state.findHits.length < MAX_FIND_HITS) {
            if (index > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
            const mark = document.createElement('mark');
            mark.className = 'md-hit';
            mark.dataset.hit = String(state.findHits.length);
            mark.textContent = text.slice(index, index + needle.length);
            fragment.appendChild(mark);
            state.findHits.push(mark);
            cursor = index + needle.length;
            index = lower.indexOf(needle, cursor);
        }
        if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
        node.parentNode?.replaceChild(fragment, node);
    }

    function applyFind(query) {
        clearFindMarks();
        state.findQuery = query;
        if (!query || query.length < 2 || !elements.mdContent) return;
        const walker = document.createTreeWalker(elements.mdContent, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (['SCRIPT', 'STYLE', 'MARK'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const nodes = [];
        while (walker.nextNode() && state.findHits.length < MAX_FIND_HITS) nodes.push(walker.currentNode);
        for (const node of nodes) {
            if (state.findHits.length >= MAX_FIND_HITS) break;
            highlightTextNode(node, query);
        }
        if (elements.mdFindCount) {
            elements.mdFindCount.hidden = false;
            elements.mdFindCount.textContent = state.findHits.length
                ? `0/${state.findHits.length}`
                : '0/0';
        }
        if (state.findHits.length) showFindHit(0);
    }

    function showFindHit(index) {
        if (!state.findHits.length) return;
        const count = state.findHits.length;
        const next = ((index % count) + count) % count;
        state.findHits.forEach((mark, i) => mark.classList.toggle('current', i === next));
        state.findIndex = next;
        state.findHits[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (elements.mdFindCount) elements.mdFindCount.textContent = `${next + 1}/${count}`;
    }

    function processImages(detail) {
        if (!elements.mdContent) return;
        const images = Array.isArray(detail.index?.images) ? detail.index.images : [];
        const byRel = new Map();
        const byBase = new Map();
        for (const image of images) {
            const rel = normalizeRelativePath(image.rel);
            byRel.set(rel, image);
            byBase.set(basenameOf(rel), image);
        }
        for (const img of [...elements.mdContent.querySelectorAll('img')]) {
            const raw = img.getAttribute('src') || '';
            if (!raw) {
                img.remove();
                continue;
            }
            if (/^(?:data:|https?:|file:|vcp-mineru:)/i.test(raw)) {
                if (/^https?:/i.test(raw)) {
                    img.addEventListener('error', () => img.classList.add('img-failed'), { once: true });
                }
            } else {
                const rel = normalizeRelativePath(raw);
                const matched = byRel.get(rel) || byBase.get(basenameOf(rel));
                const finalRel = matched?.rel || rel;
                if (!finalRel) {
                    img.remove();
                    continue;
                }
                img.dataset.mineruRel = finalRel;
                img.src = imageUrlOf(state.paperId, finalRel);
            }
            img.loading = 'lazy';
            img.decoding = 'async';
            const matched = byRel.get(normalizeRelativePath(img.dataset.mineruRel || raw))
                || byBase.get(basenameOf(img.dataset.mineruRel || raw));
            const caption = (matched?.caption || img.getAttribute('alt') || '').trim();
            img.addEventListener('error', () => {
                if (matched?.url && img.src !== matched.url) {
                    img.src = matched.url;
                    return;
                }
                img.classList.add('img-failed');
            });
            img.addEventListener('click', () => onImageOpen?.(img.currentSrc || img.src, caption));
        }
        for (const table of [...elements.mdContent.querySelectorAll('table')]) {
            if (table.parentElement?.classList.contains('table-scroll')) continue;
            const wrapper = document.createElement('div');
            wrapper.className = 'table-scroll';
            table.parentNode?.insertBefore(wrapper, table);
            wrapper.appendChild(table);
        }
        for (const link of [...elements.mdContent.querySelectorAll('a[href]')]) {
            link.addEventListener('click', event => {
                const href = link.getAttribute('href') || '';
                if (href.startsWith('#')) {
                    event.preventDefault();
                    const id = decodeURIComponent(href.slice(1));
                    elements.mdContent.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
                    return;
                }
                if (/^https?:/i.test(href)) {
                    event.preventDefault();
                    onOpenLink?.(href);
                }
            });
        }
        for (const pre of [...elements.mdContent.querySelectorAll('pre')]) {
            pre.setAttribute('tabindex', '0');
        }
    }

    function indexHeadings() {
        if (!elements.mdContent) return;
        const nodes = [...elements.mdContent.querySelectorAll('h1, h2, h3, h4, h5, h6')];
        state.headings = nodes.map((element, index) => {
            const id = `md-heading-${index}`;
            element.id = id;
            return { element, id, normalized: normalizeMatchText(element.textContent) };
        });
    }

    function renderMarkdown(detail) {
        const content = elements.mdContent;
        if (!content) return;
        clearFindMarks();
        const text = detail.markdown || '';
        if (elements.mdSourceLabel) {
            elements.mdSourceLabel.textContent = detail.markdownSource ? `来自 ${detail.markdownSource}` : '';
        }
        if (elements.mdPlaceholder) elements.mdPlaceholder.hidden = Boolean(text);
        if (!text) {
            content.innerHTML = '';
            return;
        }
        let html = '';
        if (window.marked?.parse) {
            try {
                html = window.marked.parse(text, { gfm: true, breaks: false });
            } catch {
                html = `<pre>${escapeHtml(text)}</pre>`;
            }
        } else {
            html = `<pre>${escapeHtml(text)}</pre>`;
        }
        if (window.DOMPurify?.sanitize) {
            try {
                html = window.DOMPurify.sanitize(html, {
                    ADD_ATTR: ['target'],
                    ADD_DATA_URI_TAGS: ['img'],
                    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|data|vcp-mineru):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
                });
            } catch {
                // 病态嵌套可能让净化器爆栈：退回纯文本，绝不注入未净化 HTML
                html = `<pre>${escapeHtml(text)}</pre>`;
            }
        } else {
            // 净化器不可用时退回纯文本，绝不把 Markdown 生成的 HTML 直接注入页面
            html = `<pre>${escapeHtml(text)}</pre>`;
        }
        content.innerHTML = html;
        indexHeadings();
        processImages(detail);
        if (window.renderMathInElement) {
            try {
                window.renderMathInElement(content, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '\\[', right: '\\]', display: true },
                        { left: '$', right: '$', display: false },
                        { left: '\\(', right: '\\)', display: false },
                    ],
                    throwOnError: false,
                    strict: false,
                });
            } catch {
                // 公式渲染失败不影响正文
            }
        }
    }

    async function open(detail) {
        state.destroyed = false;
        state.paperId = detail.paper?.paperId || '';
        state.detail = detail;
        state.pdfPage = 1;
        state.pdfTotal = 0;
        state.fitMode = true;
        renderOutline(detail);
        renderQuality(detail);
        renderMarkdown(detail);
        await loadPdf(detail);
    }

    function close() {
        disposePdf();
        state.detail = null;
        state.paperId = '';
        state.headings = [];
        state.outlineNodes = [];
        clearFindMarks();
        if (elements.mdContent) elements.mdContent.innerHTML = '';
        if (elements.outlineList) elements.outlineList.innerHTML = '';
        if (elements.qualityBox) {
            elements.qualityBox.hidden = true;
            elements.qualityBox.innerHTML = '';
        }
    }

    async function goToPage(page) {
        if (!state.pdfDoc) return;
        const next = Math.min(Math.max(1, Math.trunc(Number(page) || 1)), state.pdfTotal || 1);
        if (next === state.pdfPage && elements.pdfCanvas?.hidden === false) return;
        state.pdfPage = next;
        updatePdfControls();
        elements.pdfScroll?.scrollTo({ top: 0 });
        await renderCurrentPage();
        savePosition();
    }

    function nextPage() {
        void goToPage(state.pdfPage + 1);
    }

    function prevPage() {
        void goToPage(state.pdfPage - 1);
    }

    function zoomBy(factor) {
        if (!state.pdfDoc) return;
        state.fitMode = false;
        if (elements.pdfFit) elements.pdfFit.setAttribute('aria-pressed', 'false');
        state.zoomScale = Math.min(4, Math.max(0.25, (state.zoomScale || 1) * factor));
        void renderCurrentPage();
    }

    function fitWidth() {
        if (!state.pdfDoc) return;
        state.fitMode = true;
        if (elements.pdfFit) elements.pdfFit.setAttribute('aria-pressed', 'true');
        void renderCurrentPage();
    }

    function setWrap(enabled) {
        elements.mdContent?.classList.toggle('wrap-code', Boolean(enabled));
    }

    function destroy() {
        state.destroyed = true;
        close();
        clearTimeout(state.resizeTimer);
        clearTimeout(state.saveTimer);
        resizeObserver?.disconnect();
        resizeObserver = null;
    }

    return {
        open,
        close,
        destroy,
        goToPage,
        nextPage,
        prevPage,
        zoomIn: () => zoomBy(1.15),
        zoomOut: () => zoomBy(1 / 1.15),
        fitWidth,
        setWrap,
        setFind(query) { applyFind(String(query || '').trim()); },
        findNext() { showFindHit(state.findIndex + 1); },
        findPrev() { showFindHit(state.findIndex - 1); },
        get pdfPage() { return state.pdfPage; },
        get pdfTotal() { return state.pdfTotal; },
    };
}
