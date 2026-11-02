// Agent 命令跟着最上面的视图走。
// 网页、PDF、表格盖在文稿上面时（UI.registerOverlay），上游的 Agent 接口答的还是藏在后面的文稿：读到别的文件，截图只有 1×1，
// SubmitSourcePr 合进后面的文稿还回成功。scriptorium.js 收到请求时先问这里：开着盖在上面的视图就由这里答；
// 文稿在最上面时回 null，照走上游。样式包、SVG 资产这些和当前文件无关的命令也回 null。
// 每个视图给 agent：text()（看得到的文字）、surface()（截图的范围）；有源码的另给 source()。
(() => {
    'use strict';
    document.body.classList.add('uttu-built'); // 这是页面最后一个脚本，现在才开始排版（uttu-scriptorium.css）
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;

    const WRITES = new Set(['submitSourcePr', 'addSlide', 'insertSlide', 'deleteSlide', 'updatePresentationConfig', 'updateSceneConfig']);
    const DOCUMENT_ONLY = new Set(['getOutline', 'getSection', 'getFullText', 'getViewportSource', 'getPrHistory',
        'getSlideCount', 'getSlide', 'getActiveSlide', 'selectSlide']);
    const BOARD_ONLY = new Set(['getBoard', 'updateBoard']); // uttu-scriptorium-board.js
    const MAX_LINES = 2000; // 和 GetSource 单次上限一致
    const MAX_VISUAL_TEXT = 4000;

    const nextFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const namedKind = (doc) => `${window.UTTUScriptoriumTypes?.nameOfKind(doc.kind) || '文件'}《${doc.name}》`;

    function refuseWrite(doc) {
        const how = doc.kind === 'board' ? '白板用 UpdateBoard 改。'
            : ['web-page', 'table', 'text'].includes(doc.kind) ? '这类文件直接改，文坊会自己刷新。'
                : '这类文件现在没有修改命令。';
        return new Error(`现在开着的是${namedKind(doc)}，这条改文稿的命令没有执行。${how}要改文稿，先用 OpenDocument 打开它。`);
    }

    function source(view, doc, payload) {
        const text = view.agent.source?.();
        if (text === undefined) throw new Error(`${namedKind(doc)}没有源码，用 ${doc.kind === 'board' ? 'GetBoard 读元素' : 'GetRenderedText 读文字'}。`);
        const lines = text.split('\n');
        const startLine = Math.max(1, Number(payload.startLine) || 1);
        const endLine = Math.min(lines.length, Number(payload.endLine) || lines.length, startLine + MAX_LINES - 1);
        return { sourceKind: 'html', startLine, endLine, totalLines: lines.length, source: lines.slice(startLine - 1, endLine).join('\n') };
    }

    async function search(view, doc, payload) {
        const text = view.agent.source?.() ?? await view.agent.text();
        const query = String(payload.query || '');
        const flags = payload.caseSensitive ? 'g' : 'gi';
        const pattern = new RegExp(payload.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        const results = text.split('\n').flatMap((line, index) => {
            pattern.lastIndex = 0;
            return pattern.test(line) ? [{ line: index + 1, text: line }] : [];
        });
        return { query, count: results.length, results: results.slice(0, 200) };
    }

    async function visual(view, doc, payload) {
        const stabilizationMs = Math.max(0, Math.min(30000, Number(payload.stabilizationMs) || 0));
        if (stabilizationMs) await new Promise((resolve) => setTimeout(resolve, stabilizationMs));
        await nextFrames();
        // 白板直接导出一张图：看的是文件内容，不用动用户眼前的画面。
        const picture = await view.agent.picture?.(payload);
        if (picture) return { scope: 'board', renderedText: String(await view.agent.text()).slice(0, MAX_VISUAL_TEXT), imageDataUrl: picture, visualStability: { stabilizationMs, slideChanged: false } };
        const box = view.agent.surface().getBoundingClientRect();
        return {
            scope: 'viewport',
            renderedText: String(await view.agent.text()).slice(0, MAX_VISUAL_TEXT),
            captureRect: { x: box.x, y: box.y, width: box.width, height: box.height },
            visualStability: { stabilizationMs, slideChanged: false },
        };
    }

    async function answer(request) {
        const view = UI.overlay?.();
        const doc = view?.doc?.();
        const method = request?.method;
        const payload = request?.payload || {};
        if (BOARD_ONLY.has(method) && doc?.kind !== 'board') throw new Error(`现在开着的${doc ? `是${namedKind(doc)}` : '不是白板'}，先用 OpenDocument 打开 .excalidraw 文件。`);
        if (!doc) return null;
        if (WRITES.has(method)) throw refuseWrite(doc);
        if (DOCUMENT_ONLY.has(method)) {
            throw new Error(`现在开着的是${namedKind(doc)}，这条命令只对文稿和演示有用。读文字用 GetRenderedText，看样子用 GetVisualContext。`);
        }
        const base = { success: true, documentKind: doc.kind, revision: doc.revision || 0, title: doc.name, name: doc.name,
            filePath: doc.filePath, dirty: Boolean(doc.dirty) };
        switch (method) {
            case 'getDocumentInfo': return base;
            case 'getRenderedText': return { ...base, text: await view.agent.text() };
            case 'getSource': return { ...base, ...source(view, doc, payload) };
            case 'searchSource': return { ...base, ...await search(view, doc, payload) };
            case 'getVisualContext': return { ...base, ...await visual(view, doc, payload) };
            case 'getBoard': return { ...base, ...view.agent.board.read(payload) };
            case 'updateBoard': return { ...base, ...await view.agent.board.update(payload) };
            default: return null;
        }
    }

    window.UTTUScriptoriumAgent = Object.freeze({ answer });
})();
