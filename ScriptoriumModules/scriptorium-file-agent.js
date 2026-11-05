// Agent 请求跟随当前显示的文件。网页、PDF、表格、文本、图片、白板显示在文稿之上时（ScriptoriumFileViews.registerOverlay），
// 原有的 Agent 接口仍会作用于后面的文稿：后面没有文稿时返回“文档尚未就绪”；后面有文稿时读到的是那份文稿，
// 截图的画面是上面的文件、附带的文字说明却属于后面的文稿；SubmitSourcePr 也会提交到后面的文稿。
// scriptorium.js 收到请求时先询问这里：有文件视图显示时由这里应答；文稿在最上面时返回 null，按原有流程处理。
// 样式包、SVG 资产等与当前文件无关的命令也返回 null。
// 各视图提供 agent：text()（显示的文字）、surface()（截图范围）；有源码的另提供 source()，白板另提供 picture() 与 board。
(() => {
    'use strict';
    const UI = window.ScriptoriumFileViews;
    if (!UI?.on) return;

    const WRITES = new Set(['submitSourcePr', 'addSlide', 'insertSlide', 'deleteSlide', 'updatePresentationConfig', 'updateSceneConfig']);
    const DOCUMENT_ONLY = new Set(['getOutline', 'getSection', 'getFullText', 'getViewportSource', 'getPrHistory',
        'getSlideCount', 'getSlide', 'getActiveSlide', 'selectSlide']);
    const BOARD_ONLY = new Set(['getBoard', 'updateBoard', 'saveBoard', 'getBoardNodeSource', 'getBoardHistory']);
    const MAX_LINES = 2000; // 与 GetSource 单次上限一致
    const MAX_VISUAL_TEXT = 4000;

    const nextFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const namedKind = (doc) => `${window.ScriptoriumFileTypes?.nameOfKind(doc.kind) || '文件'}《${doc.name}》`;

    function refuseWrite(doc) {
        const how = doc.kind === 'board' ? '白板请使用 UpdateBoard 修改。'
            : ['web-page', 'table', 'text'].includes(doc.kind) ? '这类文件可直接修改，文坊会自动刷新。'
                : '这类文件目前没有修改命令。';
        return new Error(`当前打开的是${namedKind(doc)}，这条修改文稿的命令未执行。${how}`);
    }

    function source(view, doc, payload) {
        const text = view.agent.source?.();
        if (text === undefined) throw new Error(`${namedKind(doc)}没有源码，请使用 ${doc.kind === 'board' ? 'GetBoard 读取元素' : 'GetRenderedText 读取文字'}。`);
        const lines = text.split('\n');
        const startLine = Math.max(1, Number(payload.startLine) || 1);
        const endLine = Math.min(lines.length, Number(payload.endLine) || lines.length, startLine + MAX_LINES - 1);
        return { sourceKind: doc.kind === 'web-page' ? 'html' : 'text', startLine, endLine, totalLines: lines.length, source: lines.slice(startLine - 1, endLine).join('\n') };
    }

    async function search(view, payload) {
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

    async function visual(view, payload) {
        const stabilizationMs = Math.max(0, Math.min(30000, Number(payload.stabilizationMs) || 0));
        if (stabilizationMs) await new Promise((resolve) => setTimeout(resolve, stabilizationMs));
        await nextFrames();
        // 白板直接导出一张图：看的是文件内容，不改变用户眼前的画面。
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
        if (method === 'createBoard') return { success: true, ...await window.ScriptoriumBoardView.createArtifact(payload) };
        if (BOARD_ONLY.has(method) && doc?.kind !== 'board') {
            throw new Error(`当前打开的${doc ? `是${namedKind(doc)}` : '不是白板'}。请先在文坊中打开 .excalidraw 文件。`);
        }
        if (!doc || !view.agent) return null;
        if (WRITES.has(method)) throw refuseWrite(doc);
        if (DOCUMENT_ONLY.has(method)) {
            throw new Error(`当前打开的是${namedKind(doc)}，这条命令只适用于文稿和演示。读取文字请使用 GetRenderedText，查看画面请使用 GetVisualContext。`);
        }
        const base = { success: true, documentKind: doc.kind, revision: doc.revision || 0, title: doc.name, name: doc.name,
            filePath: doc.filePath, dirty: Boolean(doc.dirty) };
        switch (method) {
            case 'getDocumentInfo': return base;
            case 'getRenderedText': return { ...base, text: await view.agent.text() };
            case 'getSource': return { ...base, ...source(view, doc, payload) };
            case 'searchSource': return { ...base, ...await search(view, payload) };
            case 'getVisualContext': return { ...base, ...await visual(view, payload) };
            case 'getBoard': return { ...base, ...view.agent.board.read(payload) };
            case 'updateBoard': return { ...base, ...await view.agent.board.update(payload) };
            case 'saveBoard': return { ...base, ...await view.agent.board.save(payload) };
            case 'getBoardNodeSource': return { ...base, ...view.agent.board.getNodeSource(payload) };
            case 'getBoardHistory': return { ...base, ...view.agent.board.history() };
            default: return null;
        }
    }

    window.ScriptoriumFileAgent = Object.freeze({ answer });
})();
