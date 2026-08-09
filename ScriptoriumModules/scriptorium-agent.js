'use strict';

(() => {
    const MAX_QUERY_LINES = 2000;
    const MAX_SEARCH_RESULTS = 200;

    function linesOf(source) {
        return String(source || '').replace(/\r\n?/g, '\n').split('\n');
    }

    function clampLine(value, maximum, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
    }

    function normalizeAuthor(author) {
        if (typeof author === 'string') {
            const name = author.trim();
            return name ? { id: name, name, type: 'agent' } : null;
        }
        if (!author || typeof author !== 'object') return null;
        const name = String(author.name || author.signature || author.id || '').trim();
        if (!name) return null;
        return {
            id: String(author.id || name),
            name,
            type: author.type === 'human' ? 'human' : 'agent',
        };
    }

    function sourceRange(source, startLine = 1, endLine = startLine) {
        const lines = linesOf(source);
        const start = clampLine(startLine, Math.max(1, lines.length), 1);
        const requestedEnd = Math.min(start + MAX_QUERY_LINES - 1, Number(endLine) || start);
        const end = clampLine(requestedEnd, Math.max(1, lines.length), start);
        return {
            startLine: Math.min(start, end),
            endLine: Math.max(start, end),
            totalLines: lines.length,
            source: lines.slice(Math.min(start, end) - 1, Math.max(start, end)).join('\n'),
        };
    }

    function textFromHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        template.content.querySelectorAll('style,script,noscript').forEach((node) => node.remove());
        return (template.content.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function mediaFromHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        return [...template.content.querySelectorAll('img,video,audio,svg,canvas')].map((node) => ({
            kind: node.tagName.toLowerCase(),
            source: node.getAttribute('src') || node.getAttribute('href') || '',
            alt: node.getAttribute('alt') || node.getAttribute('aria-label') || '',
            title: node.getAttribute('title') || '',
        }));
    }

    function findAll(source, query, options = {}) {
        const text = String(source || '');
        const needle = String(query || '');
        if (!needle) return [];
        let pattern;
        try {
            pattern = options.regex
                ? new RegExp(needle, options.caseSensitive ? 'g' : 'gi')
                : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    options.caseSensitive ? 'g' : 'gi');
        } catch (error) {
            throw new Error(`检索表达式无效：${error.message}`);
        }
        const starts = [0];
        for (let index = 0; index < text.length; index += 1) {
            if (text[index] === '\n') starts.push(index + 1);
        }
        const lineAt = (offset) => {
            let low = 0;
            let high = starts.length - 1;
            while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                if (starts[middle] <= offset) low = middle + 1;
                else high = middle - 1;
            }
            return high + 1;
        };
        const results = [];
        let match;
        while ((match = pattern.exec(text)) && results.length < MAX_SEARCH_RESULTS) {
            const value = match[0];
            const startLine = lineAt(match.index);
            const endLine = lineAt(match.index + Math.max(0, value.length - 1));
            results.push({
                startLine,
                endLine,
                match: value,
                context: sourceRange(text, Math.max(1, startLine - 1), endLine + 1).source,
            });
            if (!value.length) pattern.lastIndex += 1;
        }
        return results;
    }

    function offsetsForLines(source, startLine, endLine) {
        const lines = linesOf(source);
        const start = clampLine(startLine, lines.length, 1);
        const end = clampLine(endLine, lines.length, start);
        let startOffset = 0;
        for (let index = 0; index < start - 1; index += 1) {
            startOffset += lines[index].length + 1;
        }
        let endOffset = startOffset;
        for (let index = start - 1; index < end; index += 1) {
            endOffset += lines[index].length;
            if (index < lines.length - 1) endOffset += 1;
        }
        return { startOffset, endOffset };
    }

    function locateTarget(source, target, hintLine) {
        const text = String(source || '');
        const needle = String(target || '');
        if (!needle) throw new Error('PR target 不能为空。');
        const occurrences = [];
        let offset = 0;
        while ((offset = text.indexOf(needle, offset)) >= 0) {
            occurrences.push(offset);
            offset += Math.max(1, needle.length);
        }
        if (!occurrences.length) return null;
        if (occurrences.length === 1 || !Number.isFinite(Number(hintLine))) {
            return { offset: occurrences[0], ambiguous: occurrences.length > 1 };
        }
        const hintedOffset = offsetsForLines(text, Number(hintLine), Number(hintLine)).startOffset;
        occurrences.sort((left, right) =>
            Math.abs(left - hintedOffset) - Math.abs(right - hintedOffset)
        );
        return { offset: occurrences[0], ambiguous: true };
    }

    function applyReplacements(source, replacements) {
        let next = String(source || '');
        const applied = [];
        for (const replacement of replacements) {
            const target = String(replacement?.target || '');
            const located = locateTarget(next, target, replacement?.startLine);
            if (!located) {
                return {
                    success: false,
                    code: 'TARGET_NOT_FOUND',
                    message: '未找到 PR target，未应用任何变更。',
                    target,
                };
            }
            applied.push({
                target,
                replacement: String(replacement?.replace ?? replacement?.replacement ?? ''),
                offset: located.offset,
                ambiguous: located.ambiguous,
                startLine: Number(replacement?.startLine) || null,
            });
            next = `${next.slice(0, located.offset)}${applied.at(-1).replacement}${
                next.slice(located.offset + target.length)
            }`;
        }
        return { success: true, source: next, applied };
    }

    function createAgentApi(context) {
        const {
            state,
            core,
            getRenderRoot,
            getReadRoot,
            getCurrentHtml,
            getCurrentCss,
            setCurrentHtml,
            setCurrentCss,
            renderDocument,
            renderReadingPreview,
            markDirty,
            captureSnapshot,
            renderLineage,
            syncRenderedToSource,
            selectSlide,
        } = context;
        const handledRequests = new Map();
        let mutationQueue = Promise.resolve();

        const revision = () => state.documentRevision;
        const isDeck = () =>
            state.document?.manifest?.scene?.kind === core.PROJECT_KINDS.SLIDE_DECK;
        const slides = () => state.document?.source?.slides || [];
        const sourceFor = (kind = 'html', slideIndex = null) => {
            if (isDeck() && slideIndex !== null) {
                const slide = slides()[Number(slideIndex)];
                if (!slide) throw new Error('指定幻灯片不存在。');
                if (kind === 'css') return slide.css || '';
                if (kind === 'script') return slide.script || '';
                return slide.html || '';
            }
            return kind === 'css' ? getCurrentCss() : getCurrentHtml();
        };

        function assertReady() {
            if (!state.ready || !state.document) throw new Error('Scriptorium 文档尚未就绪。');
        }

        function response(data = {}) {
            return {
                success: true,
                documentId: state.document.manifest.id,
                documentKind: isDeck() ? 'pptx' : 'docx',
                revision: revision(),
                ...data,
            };
        }

        function documentInfo() {
            assertReady();
            return response({
                title: state.document.manifest.title,
                name: state.currentName,
                dirty: state.dirty,
                activeSlideIndex: isDeck() ? state.activeSlideIndex : null,
                slideCount: isDeck() ? slides().length : null,
            });
        }

        function renderedText(options = {}) {
            assertReady();
            if (isDeck()) {
                const indexes = options.slideIndex === undefined
                    ? slides().map((_, index) => index)
                    : [Number(options.slideIndex)];
                return response({
                    pages: indexes.map((index) => {
                        const slide = slides()[index];
                        if (!slide) throw new Error(`第 ${index + 1} 页不存在。`);
                        return {
                            index,
                            id: slide.id,
                            name: slide.name,
                            text: textFromHtml(slide.html),
                            media: mediaFromHtml(slide.html),
                            notes: slide.notes || '',
                        };
                    }),
                });
            }
            return response({ text: textFromHtml(state.document.source.html) });
        }

        function outline() {
            assertReady();
            if (isDeck()) {
                return response({
                    items: slides().map((slide, index) => ({
                        index,
                        id: slide.id,
                        title: slide.name || textFromHtml(slide.html).slice(0, 80),
                    })),
                });
            }
            return response({
                items: core.extractOutline(state.document.source.html)
                    .filter((item) => item.kind === 'heading'),
            });
        }

        function section(options = {}) {
            assertReady();
            if (isDeck()) throw new Error('章节查询仅适用于 DOCX 端。');
            const items = core.extractOutline(state.document.source.html);
            const headings = items.filter((item) => item.kind === 'heading');
            const heading = options.id
                ? headings.find((item) => item.id === options.id)
                : headings[Number(options.index) || 0];
            if (!heading) throw new Error('指定章节不存在。');
            const all = [...items];
            const start = all.findIndex((item) => item.id === heading.id);
            let end = all.length;
            for (let index = start + 1; index < all.length; index += 1) {
                if (all[index].kind === 'heading' && all[index].level <= heading.level) {
                    end = index;
                    break;
                }
            }
            const ids = new Set(all.slice(start, end).map((item) => item.id));
            const template = document.createElement('template');
            template.innerHTML = state.document.source.html;
            const nodes = [...template.content.querySelectorAll('[data-vdoc-text]')]
                .filter((node) => ids.has(node.dataset.vdocText));
            return response({
                heading,
                text: nodes.map((node) => node.textContent || '').join('\n').trim(),
                html: nodes.map((node) => node.outerHTML).join('\n'),
            });
        }

        function viewportSource(options = {}) {
            assertReady();
            syncRenderedToSource?.();
            const root = state.mode === 'read' ? getReadRoot() : getRenderRoot();
            const host = state.mode === 'read'
                ? document.getElementById('read-host')
                : document.getElementById('render-host');
            const hostRect = host?.getBoundingClientRect();
            const visibleIds = root && hostRect
                ? [...root.querySelectorAll('[data-vdoc-text]')].filter((node) => {
                    const rect = node.getBoundingClientRect();
                    return rect.bottom >= hostRect.top && rect.top <= hostRect.bottom;
                }).map((node) => node.dataset.vdocText).filter(Boolean)
                : [];
            const source = sourceFor(options.sourceKind || 'html',
                isDeck() ? state.activeSlideIndex : null);
            const sourceLines = linesOf(source);
            const matchingLines = [];
            sourceLines.forEach((line, index) => {
                if (visibleIds.some((id) => line.includes(`data-vdoc-text="${id}"`))) {
                    matchingLines.push(index + 1);
                }
            });
            const center = matchingLines.length
                ? Math.round((Math.min(...matchingLines) + Math.max(...matchingLines)) / 2)
                : 1;
            const radius = Math.max(1, Math.min(200, Number(options.radius) || 30));
            const range = sourceRange(source, center - radius, center + radius);
            return response({
                ...range,
                visibleBlockIds: visibleIds,
                activeSlideIndex: isDeck() ? state.activeSlideIndex : null,
            });
        }

        function getSource(options = {}) {
            assertReady();
            const source = sourceFor(options.sourceKind || 'html',
                options.slideIndex === undefined ? (isDeck() ? state.activeSlideIndex : null)
                    : options.slideIndex);
            return response({
                sourceKind: options.sourceKind || 'html',
                slideIndex: isDeck()
                    ? Number(options.slideIndex ?? state.activeSlideIndex)
                    : null,
                ...sourceRange(source, options.startLine || 1,
                    options.endLine || linesOf(source).length),
            });
        }

        function searchSource(options = {}) {
            assertReady();
            const kinds = options.sourceKind === 'all'
                ? (isDeck() ? ['html', 'css', 'script'] : ['html', 'css'])
                : [options.sourceKind || 'html'];
            const targets = isDeck()
                ? (options.slideIndex === undefined
                    ? slides().map((_, index) => index)
                    : [Number(options.slideIndex)])
                : [null];
            const results = [];
            targets.forEach((slideIndex) => kinds.forEach((sourceKind) => {
                findAll(sourceFor(sourceKind, slideIndex), options.query, options)
                    .forEach((item) => results.push({ slideIndex, sourceKind, ...item }));
            }));
            return response({ query: options.query, results: results.slice(0, MAX_SEARCH_RESULTS) });
        }

        function history(options = {}) {
            assertReady();
            const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
            return response({
                records: state.checkpoints.slice(0, limit).map((record) => ({
                    id: record.id,
                    source: record.source,
                    author: record.author || null,
                    name: record.name,
                    summary: record.summary || record.note || '',
                    note: record.note || '',
                    createdAt: record.createdAt,
                    baseRevision: record.baseRevision ?? null,
                    revision: record.revision ?? null,
                    operation: record.operation || null,
                    status: record.status || 'applied',
                })),
            });
        }

        function queueMutation(payload, operation) {
            assertReady();
            const author = normalizeAuthor(payload?.author);
            if (!author) {
                return Promise.resolve({
                    success: false,
                    code: 'AUTHOR_REQUIRED',
                    message: 'Agent PR 必须提供署名字段。',
                    revision: revision(),
                });
            }
            const summary = String(payload.summary || '').trim();
            if (!summary) {
                return Promise.resolve({
                    success: false,
                    code: 'SUMMARY_REQUIRED',
                    message: 'Agent PR 必须提供“我做了什么”的摘要字段 summary。',
                    revision: revision(),
                });
            }
            const requestId = String(payload.requestId || crypto.randomUUID());
            if (handledRequests.has(requestId)) return handledRequests.get(requestId);
            const task = mutationQueue.then(async () => {
                if (Number.isFinite(Number(payload.expectedRevision))
                    && Number(payload.expectedRevision) !== revision()) {
                    return {
                        success: false,
                        code: 'REVISION_CONFLICT',
                        message: '文档已被人类或其他 Agent 修改，请基于最新修订重新提交。',
                        expectedRevision: Number(payload.expectedRevision),
                        actualRevision: revision(),
                    };
                }
                const baseRevision = revision();
                const result = await operation();
                if (!result?.success) return result;
                markDirty();
                captureSnapshot();
                const record = {
                    id: payload.prId || `pr-${crypto.randomUUID()}`,
                    source: author.type,
                    author,
                    name: String(payload.name || 'Agent 源码变更'),
                    summary,
                    note: String(payload.note || ''),
                    createdAt: Date.now(),
                    baseRevision,
                    revision: revision(),
                    requestId,
                    operation: result.operation,
                    status: 'applied',
                    snapshot: core.serialize(state.document),
                };
                state.checkpoints.unshift(record);
                renderLineage();
                return response({ pr: record, result });
            }).catch((error) => ({
                success: false,
                code: 'MUTATION_FAILED',
                message: error.message,
                revision: revision(),
            }));
            mutationQueue = task.then(() => undefined, () => undefined);
            handledRequests.set(requestId, task);
            if (handledRequests.size > 500) {
                handledRequests.delete(handledRequests.keys().next().value);
            }
            return task;
        }

        function submitSourcePr(payload = {}) {
            return queueMutation(payload, async () => {
                const sourceKind = payload.sourceKind || 'html';
                const slideIndex = isDeck()
                    ? Number(payload.slideIndex ?? state.activeSlideIndex)
                    : null;
                const original = sourceFor(sourceKind, slideIndex);
                const result = applyReplacements(original,
                    Array.isArray(payload.replacements) ? payload.replacements : [payload]);
                if (!result.success) return result;

                if (isDeck()) {
                    const slide = slides()[slideIndex];
                    if (!slide) throw new Error('指定幻灯片不存在。');
                    if (sourceKind === 'css') slide.css = core.sanitizeCss(result.source);
                    else if (sourceKind === 'script') slide.script = String(result.source);
                    else slide.html = core.formatHtml(core.ensureTextNodeIds(result.source));
                } else if (sourceKind === 'css') {
                    setCurrentCss(result.source);
                } else {
                    setCurrentHtml(result.source);
                }
                renderDocument();
                return {
                    success: true,
                    operation: {
                        type: 'source-replace',
                        sourceKind,
                        slideIndex,
                        replacements: result.applied,
                    },
                };
            });
        }

        function mutateSlides(payload = {}, type) {
            return queueMutation(payload, async () => {
                if (!isDeck()) throw new Error('幻灯片操作仅适用于 PPTX 端。');
                const list = slides();
                if (type === 'delete') {
                    const index = Number(payload.slideIndex ?? state.activeSlideIndex);
                    if (!list[index]) throw new Error('指定幻灯片不存在。');
                    if (list.length <= 1) throw new Error('演示至少需要保留一页。');
                    const [removed] = list.splice(index, 1);
                    state.activeSlideIndex = Math.min(state.activeSlideIndex, list.length - 1);
                    renderDocument();
                    return {
                        success: true,
                        operation: { type: 'slide-delete', index, slideId: removed.id },
                    };
                }
                const insertionIndex = type === 'insert'
                    ? Math.max(0, Math.min(list.length, Number(payload.slideIndex) || 0))
                    : list.length;
                const slide = core.createSlide({
                    name: payload.name,
                    html: payload.html,
                    css: payload.css,
                    script: payload.script,
                    transition: payload.transition,
                    notes: payload.notes,
                    resources: payload.resources,
                }, insertionIndex);
                list.splice(insertionIndex, 0, slide);
                state.activeSlideIndex = insertionIndex;
                renderDocument();
                return {
                    success: true,
                    operation: { type: `slide-${type}`, index: insertionIndex, slideId: slide.id },
                };
            });
        }

        const common = Object.freeze({
            getDocumentInfo: documentInfo,
            getRenderedText: renderedText,
            getOutline: outline,
            getSource,
            searchSource,
            getViewportSource: viewportSource,
            getPrHistory: history,
            submitSourcePr,
        });
        const docx = Object.freeze({
            ...common,
            getFullText: () => renderedText(),
            getSection: section,
        });
        const pptx = Object.freeze({
            ...common,
            getSlideCount: () => response({ count: slides().length }),
            getSlide: (options = {}) => renderedText({ slideIndex: options.slideIndex }),
            getActiveSlide: () => renderedText({ slideIndex: state.activeSlideIndex }),
            selectSlide: (options = {}) => {
                assertReady();
                selectSlide(Number(options.slideIndex));
                return response({ activeSlideIndex: state.activeSlideIndex });
            },
            addSlide: (payload = {}) => mutateSlides(payload, 'add'),
            insertSlide: (payload = {}) => mutateSlides(payload, 'insert'),
            deleteSlide: (payload = {}) => mutateSlides(payload, 'delete'),
        });

        return Object.freeze({
            version: 1,
            common,
            docx,
            pptx,
            current: () => isDeck() ? pptx : docx,
        });
    }

    window.ScriptoriumAgentModule = Object.freeze({
        createAgentApi,
        applyReplacements,
        findAll,
        sourceRange,
        textFromHtml,
    });
})();