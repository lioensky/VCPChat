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

    function programmablePolicy() {
        return window.ScriptoriumProgrammableContent || null;
    }

    function reviewProgrammableHtml(html, context = {}) {
        const policy = programmablePolicy();
        if (!policy) {
            return {
                html: String(html || ''),
                dependencies: [],
                diagnostics: [{
                    level: 'refuse',
                    ruleId: 'review-engine-unavailable',
                    message: '可编程内容审查器未加载。',
                    context,
                }],
                refused: true,
            };
        }

        const normalized = policy.normalizeHtmlDependencies(html, context);
        const diagnostics = [...normalized.diagnostics];
        policy.reviewScriptsInHtml(normalized.html, context).forEach((entry) => {
            if (entry.kind !== 'inline' || !entry.review) return;
            entry.review.findings.forEach((finding) => diagnostics.push({
                ...finding,
                scriptId: entry.scriptId,
                context: entry.review.context,
            }));
        });

        return {
            ...normalized,
            diagnostics,
            refused: diagnostics.some((item) => item.level === 'refuse'),
        };
    }

    function reviewStandaloneScript(source, context = {}) {
        const policy = programmablePolicy();
        if (policy) return policy.reviewJavaScript(source, context);
        return {
            allowed: false,
            level: 'refuse',
            findings: [{
                level: 'refuse',
                ruleId: 'review-engine-unavailable',
                message: '可编程内容审查器未加载。',
            }],
            context,
        };
    }

    function normalizeProjectProgrammableContent(payload, deck) {
        const diagnostics = [];
        const dependencies = new Set();

        if (!deck) {
            const result = reviewProgrammableHtml(payload.html, {
                phase: 'create',
                documentKind: 'docx',
            });
            result.dependencies.forEach((item) => dependencies.add(item));
            diagnostics.push(...result.diagnostics);
            return {
                html: result.html,
                slides: undefined,
                dependencies: [...dependencies],
                diagnostics,
                refused: result.refused,
            };
        }

        const slides = (Array.isArray(payload.slides) ? payload.slides : [])
            .map((slide, index) => {
                const htmlResult = reviewProgrammableHtml(slide?.html, {
                    phase: 'create',
                    documentKind: 'pptx',
                    slideIndex: index,
                });
                htmlResult.dependencies.forEach((item) => dependencies.add(item));
                diagnostics.push(...htmlResult.diagnostics);

                const scriptReview = reviewStandaloneScript(slide?.script, {
                    phase: 'create',
                    documentKind: 'pptx',
                    slideIndex: index,
                    scriptId: slide?.id || `slide-${index + 1}`,
                });
                (scriptReview.dependencies || [])
                    .forEach((item) => dependencies.add(item));
                scriptReview.findings.forEach((finding) => diagnostics.push({
                    ...finding,
                    scriptId: scriptReview.context?.scriptId,
                    context: scriptReview.context,
                }));

                return {
                    ...(slide && typeof slide === 'object' ? slide : {}),
                    html: htmlResult.html,
                };
            });

        return {
            html: undefined,
            slides,
            dependencies: [...dependencies],
            diagnostics,
            refused: diagnostics.some((item) => item.level === 'refuse'),
        };
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
            persistCheckpoint,
            syncRenderedToSource,
            selectSlide,
        } = context;
        const handledRequests = new Map();
        const pendingPrs = new Map();
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

        function currentProgrammableContentStatus() {
            const diagnostics = Array.isArray(state.programmableContentDiagnostics)
                ? state.programmableContentDiagnostics
                : [];
            const status = diagnostics.some((item) => item.level === 'refuse')
                ? 'refuse'
                : diagnostics.some((item) => item.level === 'warn')
                    ? 'warn'
                    : 'allow';
            return {
                status,
                dependencies: Array.isArray(
                    state.document?.manifest?.programmableDependencies
                )
                    ? state.document.manifest.programmableDependencies
                    : [],
                diagnostics,
            };
        }

        function response(data = {}) {
            return {
                success: true,
                documentId: state.document.manifest.id,
                documentKind: isDeck() ? 'pptx' : 'docx',
                revision: revision(),
                programmableContent: currentProgrammableContentStatus(),
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

        function nextAnimationFrame() {
            return new Promise((resolve) => window.requestAnimationFrame(resolve));
        }

        function boundedDelay(waitMs) {
            return new Promise((resolve) => window.setTimeout(resolve, waitMs));
        }

        function visualStabilizationMs(options = {}, slideChanged = false) {
            const supplied = options.stabilizationMs
                ?? options.renderStabilizationMs
                ?? options.visualDelayMs;
            const fallback = slideChanged ? 750 : 0;
            const parsed = supplied === undefined || supplied === ''
                ? fallback
                : Number(supplied);
            if (!Number.isFinite(parsed) || parsed < 0) {
                throw new Error('视觉渲染稳定等待必须是非负数。');
            }
            return Math.min(Math.round(parsed), 5000);
        }

        function waitForTransition(root, timeoutMs) {
            if (!root || timeoutMs <= 0) return Promise.resolve('disabled');
            return new Promise((resolve) => {
                let settled = false;
                const finish = (reason) => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timer);
                    root.removeEventListener('transitionend', onTransitionEnd, true);
                    root.removeEventListener('transitioncancel', onTransitionCancel, true);
                    resolve(reason);
                };
                const onTransitionEnd = () => finish('transitionend');
                const onTransitionCancel = () => finish('transitioncancel');
                const timer = window.setTimeout(() => finish('timeout'), timeoutMs);
                root.addEventListener('transitionend', onTransitionEnd, true);
                root.addEventListener('transitioncancel', onTransitionCancel, true);
            });
        }

        async function waitForVisualStability(root, options, slideChanged) {
            const stabilizationMs = visualStabilizationMs(options, slideChanged);

            // renderDocument() 同步替换 Shadow DOM；先跨两帧让样式计算、布局和
            // 合成器接收到新页面，再开始观察新页面自己的过渡事件。
            await nextAnimationFrame();
            await nextAnimationFrame();

            const transitionResult = slideChanged
                ? await waitForTransition(root, stabilizationMs)
                : 'not-switched';

            // 字体和图片会在 DOM 已建立后继续改变排版。等待这些资源，但使用同一
            // 安全上限，避免网络资源或损坏字体永久阻塞 Agent 调用。
            const resourceTimeoutMs = Math.max(250, stabilizationMs || 750);
            const resourceTasks = [];
            if (document.fonts?.ready) resourceTasks.push(document.fonts.ready.catch(() => undefined));
            root?.querySelectorAll?.('img').forEach((image) => {
                if (image.complete) {
                    if (typeof image.decode === 'function') {
                        resourceTasks.push(image.decode().catch(() => undefined));
                    }
                    return;
                }
                resourceTasks.push(new Promise((resolve) => {
                    image.addEventListener('load', resolve, { once: true });
                    image.addEventListener('error', resolve, { once: true });
                }));
            });
            if (resourceTasks.length) {
                await Promise.race([
                    Promise.allSettled(resourceTasks),
                    boundedDelay(resourceTimeoutMs),
                ]);
            }

            // Canvas 绘制、ResizeObserver 与字体替换可能在资源完成后再提交更新；
            // 最后两帧是 capturePage() 前的合成提交屏障。
            await nextAnimationFrame();
            await nextAnimationFrame();

            return {
                slideChanged,
                stabilizationMs,
                transitionResult,
                framesAfterRender: 4,
            };
        }

        async function visualContext(options = {}) {
            assertReady();
            const requestedSlideIndex = options.slideIndex === undefined
                ? state.activeSlideIndex
                : Number(options.slideIndex);
            let slideChanged = false;
            if (isDeck() && requestedSlideIndex !== state.activeSlideIndex) {
                if (!slides()[requestedSlideIndex]) throw new Error('指定幻灯片不存在。');
                slideChanged = selectSlide(requestedSlideIndex) === true;
            }
            if (state.mode === 'read') renderReadingPreview();

            const root = state.mode === 'read' ? getReadRoot() : getRenderRoot();
            const stability = await waitForVisualStability(root, options, slideChanged);
            const host = state.mode === 'read'
                ? document.getElementById('read-host')
                : document.getElementById('render-host');
            const rect = host?.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                throw new Error('当前文档阅读窗口不可见，无法获取视觉上下文。');
            }
            const sourceHtml = isDeck()
                ? slides()[state.activeSlideIndex]?.html || ''
                : state.document.source.html;
            return response({
                scope: String(options.scope || 'viewport'),
                title: state.document.manifest.title,
                name: state.currentName,
                mode: state.mode,
                activeSlideIndex: isDeck() ? state.activeSlideIndex : null,
                renderedText: textFromHtml(sourceHtml),
                media: mediaFromHtml(sourceHtml),
                visualStability: stability,
                captureRect: {
                    x: rect.left,
                    y: rect.top,
                    width: rect.width,
                    height: rect.height,
                },
            });
        }

        function buildProjectArtifact(payload = {}) {
            const projectType = String(payload.projectType || '').toLowerCase();
            const deck = projectType === 'pptx' || projectType === 'vpptx';
            const author = normalizeAuthor(payload.maid);
            if (!author) {
                return {
                    success: false,
                    code: 'MAID_REQUIRED',
                    message: '创建完整工程必须提供 maid 署名字段。',
                };
            }
            const summary = String(payload.summary || '').trim()
                || '创建完整 Scriptorium 工程';
            const title = String(payload.title || (deck ? '未命名演示' : '未命名文稿'));
            const programmable = normalizeProjectProgrammableContent(payload, deck);
            if (programmable.refused) {
                return {
                    success: false,
                    code: 'PROGRAMMABLE_CONTENT_REFUSED',
                    message: [
                        '工程包含被 Scriptorium 安全策略拒绝的 JavaScript，未创建文件。',
                        ...programmable.diagnostics
                            .filter((item) => item.level === 'refuse')
                            .map((item) => `[${item.ruleId}] ${item.message}`),
                    ].join(' '),
                    documentKind: deck ? 'pptx' : 'docx',
                    programmableContent: {
                        status: 'refuse',
                        dependencies: programmable.dependencies,
                        diagnostics: programmable.diagnostics,
                    },
                };
            }

            const model = core.createDocument({
                title,
                kind: deck ? core.PROJECT_KINDS.SLIDE_DECK : core.PROJECT_KINDS.FLOW_DOCUMENT,
                html: deck ? undefined : programmable.html,
                css: payload.css,
                slides: deck ? programmable.slides : undefined,
                page: payload.page,
                presentation: payload.presentation,
            });
            model.manifest.programmableDependencies = programmable.dependencies;
            const createdAt = Date.now();
            model.checkpoints.unshift({
                id: `agent-create-${crypto.randomUUID()}`,
                source: author.type,
                maid: author,
                author,
                name: deck ? 'Agent 创建演示工程' : 'Agent 创建文稿工程',
                summary,
                note: '',
                createdAt,
                baseRevision: null,
                revision: 0,
                operation: {
                    type: 'project-create',
                    projectType: deck ? 'pptx' : 'docx',
                },
                status: 'applied',
            });
            return {
                success: true,
                documentId: model.manifest.id,
                documentKind: deck ? 'pptx' : 'docx',
                title: model.manifest.title,
                suggestedName: `${model.manifest.title}${deck ? '.vpptx' : '.vdocx'}`,
                programmableContent: {
                    status: programmable.diagnostics.some((item) => item.level === 'warn')
                        ? 'warn'
                        : 'allow',
                    dependencies: programmable.dependencies,
                    diagnostics: programmable.diagnostics,
                },
                serialized: core.serialize(model),
            };
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

        function publicRecord(record) {
            return {
                id: record.id,
                source: record.source,
                maid: record.maid || record.author || null,
                author: record.author || record.maid || null,
                name: record.name,
                summary: record.summary || record.note || '',
                note: record.note || '',
                createdAt: record.createdAt,
                reviewedAt: record.reviewedAt || null,
                baseRevision: record.baseRevision ?? null,
                revision: record.revision ?? null,
                operation: record.operation || null,
                proposal: record.proposal || null,
                status: record.status || 'applied',
                receipt: record.receipt || null,
            };
        }

        function history(options = {}) {
            assertReady();
            const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
            const requestedStatus = String(options.status || '').trim().toLowerCase();
            const records = state.checkpoints
                .filter((record) => !requestedStatus
                    || String(record.status || 'applied').toLowerCase() === requestedStatus)
                .slice(0, limit)
                .map(publicRecord);
            return response({ records });
        }

        function createReceipt(decision, options = {}) {
            const reviewer = normalizeAuthor(options.reviewer)
                || {
                    id: decision === 'auto-approved' ? 'scriptorium-auto-policy' : 'human',
                    name: decision === 'auto-approved' ? 'Scriptorium 自动允许策略' : '人类审阅者',
                    type: 'human',
                };
            return {
                decision,
                message: String(options.message || options.reason || '').trim(),
                reviewer,
                createdAt: Date.now(),
                automatic: decision === 'auto-approved',
                policy: options.policy && typeof options.policy === 'object'
                    ? options.policy
                    : null,
            };
        }

        async function approvePr(prId, options = {}) {
            const pending = pendingPrs.get(String(prId || ''));
            if (!pending) {
                return {
                    success: false,
                    code: 'PR_NOT_PENDING',
                    message: '指定 PR 不存在或已完成审阅。',
                    revision: revision(),
                };
            }
            const { record, operation, resolve } = pending;
            pendingPrs.delete(record.id);
            const receipt = createReceipt(
                options.automatic === true ? 'auto-approved' : 'approved',
                options
            );
            const task = mutationQueue.then(async () => {
                const activeDocumentId = state.document?.manifest?.id || null;
                if (record.documentId !== activeDocumentId
                    || record.baseRevision !== revision()) {
                    record.status = 'conflict';
                    record.reviewedAt = Date.now();
                    record.receipt = {
                        ...receipt,
                        decision: 'conflict',
                        message: receipt.message || (
                            record.documentId !== activeDocumentId
                                ? '审批时当前窗口已切换到另一份文档，未应用该提案。'
                                : '审批时文档修订已变化，未应用该提案。'
                        ),
                    };
                    renderLineage();
                    await persistCheckpoint?.('AI 提案冲突状态');
                    const conflict = response({
                        success: false,
                        code: 'REVISION_CONFLICT',
                        message: record.receipt.message,
                        pr: publicRecord(record),
                        receipt: record.receipt,
                        expectedRevision: record.baseRevision,
                        actualRevision: revision(),
                    });
                    resolve(conflict);
                    return conflict;
                }
                const result = await operation();
                if (!result?.success) {
                    record.status = 'failed';
                    record.reviewedAt = Date.now();
                    record.receipt = {
                        ...receipt,
                        decision: 'failed',
                        message: result.message || receipt.message || '变更应用失败。',
                    };
                    renderLineage();
                    await persistCheckpoint?.('AI 提案失败状态');
                    const failure = response({
                        success: false,
                        code: result.code || 'MUTATION_FAILED',
                        message: record.receipt.message,
                        pr: publicRecord(record),
                        receipt: record.receipt,
                        result,
                    });
                    resolve(failure);
                    return failure;
                }
                markDirty();
                captureSnapshot();
                record.status = 'applied';
                record.reviewedAt = Date.now();
                record.revision = revision();
                record.operation = result.operation;
                record.receipt = receipt;
                record.snapshot = core.serialize(state.document);
                renderLineage();
                await persistCheckpoint?.('AI 提案合并刻点');
                const accepted = response({
                    pr: publicRecord(record),
                    receipt,
                    result,
                });
                resolve(accepted);
                return accepted;
            }).catch(async (error) => {
                record.status = 'failed';
                record.reviewedAt = Date.now();
                record.receipt = {
                    ...receipt,
                    decision: 'failed',
                    message: error.message,
                };
                renderLineage();
                await persistCheckpoint?.('AI 提案异常状态');
                const failure = {
                    success: false,
                    code: 'MUTATION_FAILED',
                    message: error.message,
                    revision: revision(),
                    pr: publicRecord(record),
                    receipt: record.receipt,
                };
                resolve(failure);
                return failure;
            });
            mutationQueue = task.then(() => undefined, () => undefined);
            return task;
        }

        async function rejectPr(prId, options = {}) {
            const pending = pendingPrs.get(String(prId || ''));
            if (!pending) {
                return {
                    success: false,
                    code: 'PR_NOT_PENDING',
                    message: '指定 PR 不存在或已完成审阅。',
                    revision: revision(),
                };
            }
            pendingPrs.delete(pending.record.id);
            const receipt = createReceipt('rejected', options);
            pending.record.status = 'rejected';
            pending.record.reviewedAt = Date.now();
            pending.record.receipt = receipt;
            renderLineage();
            await persistCheckpoint?.('AI 提案拒绝状态');
            const rejected = response({
                success: false,
                code: 'PR_REJECTED',
                message: receipt.message || '人类拒绝了该变更提案。',
                pr: publicRecord(pending.record),
                receipt,
            });
            pending.resolve(rejected);
            return rejected;
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
            if (Number.isFinite(Number(payload.expectedRevision))
                && Number(payload.expectedRevision) !== revision()) {
                return Promise.resolve({
                    success: false,
                    code: 'REVISION_CONFLICT',
                    message: '文档已被人类或其他 Agent 修改，请基于最新修订重新提交。',
                    expectedRevision: Number(payload.expectedRevision),
                    actualRevision: revision(),
                });
            }

            const record = {
                id: payload.prId || `pr-${crypto.randomUUID()}`,
                documentId: state.document.manifest.id,
                source: author.type,
                maid: author,
                author,
                name: String(payload.name || 'Agent 源码变更'),
                summary,
                note: String(payload.note || ''),
                createdAt: Date.now(),
                baseRevision: revision(),
                revision: null,
                requestId,
                operation: null,
                proposal: payload.proposal || null,
                status: 'pending',
                receipt: null,
            };
            state.checkpoints.unshift(record);
            let resolvePending;
            const task = new Promise((resolve) => {
                resolvePending = resolve;
            });
            pendingPrs.set(record.id, {
                record,
                operation,
                resolve: resolvePending,
            });
            handledRequests.set(requestId, task);
            renderLineage();
            persistCheckpoint?.('AI 待审刻点');
            window.dispatchEvent(new CustomEvent('scriptorium:pr-pending', {
                detail: publicRecord(record),
            }));
            if (handledRequests.size > 500) {
                const oldest = handledRequests.keys().next().value;
                if (oldest !== requestId) handledRequests.delete(oldest);
            }
            return task;
        }

        function submitSourcePr(payload = {}) {
            const sourceKind = payload.sourceKind || 'html';
            const slideIndex = isDeck()
                ? Number(payload.slideIndex ?? state.activeSlideIndex)
                : null;
            const suppliedReplacements = Array.isArray(payload.replacements)
                ? payload.replacements
                : [payload];
            const original = sourceFor(sourceKind, slideIndex);
            const preliminary = applyReplacements(original, suppliedReplacements);
            if (!preliminary.success) return Promise.resolve(response(preliminary));

            let replacements = suppliedReplacements;
            let programmableContent = {
                status: 'allow',
                dependencies: [],
                diagnostics: [],
            };

            if (sourceKind === 'html') {
                // 在 PR 建立前规范化 replacement 片段，使人类审阅的是最终源码：
                // Anime/Three CDN 会变成 VDOC 内置依赖标记，其他外链变成忽略标记。
                replacements = suppliedReplacements.map((replacement, index) => {
                    const normalized = reviewProgrammableHtml(
                        replacement?.replace ?? replacement?.replacement ?? '',
                        {
                            phase: 'pr',
                            documentKind: isDeck() ? 'pptx' : 'docx',
                            slideIndex,
                            replacementIndex: index,
                        }
                    );
                    programmableContent.dependencies.push(...normalized.dependencies);
                    programmableContent.diagnostics.push(...normalized.diagnostics);
                    return {
                        ...replacement,
                        replace: normalized.html,
                    };
                });
                programmableContent.dependencies = [
                    ...new Set(programmableContent.dependencies),
                ];

                // 再审查应用转换后 replacement 得到的完整候选源码。
                const candidate = applyReplacements(original, replacements);
                if (!candidate.success) return Promise.resolve(response(candidate));
                const candidateReview = reviewProgrammableHtml(candidate.source, {
                    phase: 'pr-candidate',
                    documentKind: isDeck() ? 'pptx' : 'docx',
                    slideIndex,
                });
                programmableContent.dependencies = [
                    ...new Set([
                        ...programmableContent.dependencies,
                        ...candidateReview.dependencies,
                    ]),
                ];
                programmableContent.diagnostics.push(...candidateReview.diagnostics);
            } else if (sourceKind === 'script') {
                const scriptReview = reviewStandaloneScript(preliminary.source, {
                    phase: 'pr',
                    documentKind: isDeck() ? 'pptx' : 'docx',
                    slideIndex,
                    scriptId: isDeck() ? `slide-${slideIndex + 1}` : 'document',
                });
                programmableContent.dependencies.push(
                    ...(scriptReview.dependencies || [])
                );
                scriptReview.findings.forEach((finding) =>
                    programmableContent.diagnostics.push({
                        ...finding,
                        context: scriptReview.context,
                    })
                );
            }

            programmableContent.status = programmableContent.diagnostics.some(
                (item) => item.level === 'refuse'
            )
                ? 'refuse'
                : programmableContent.diagnostics.some((item) => item.level === 'warn')
                    ? 'warn'
                    : 'allow';

            if (programmableContent.status === 'refuse') {
                return Promise.resolve(response({
                    success: false,
                    code: 'PROGRAMMABLE_CONTENT_REFUSED',
                    message: '源码变更包含被安全策略拒绝的 JavaScript，未建立待审 PR。',
                    programmableContent,
                }));
            }

            return queueMutation({
                ...payload,
                replacements,
                proposal: {
                    type: 'source-replace',
                    sourceKind,
                    slideIndex,
                    replacements,
                    programmableContent,
                },
            }, async () => {
                const current = sourceFor(sourceKind, slideIndex);
                const result = applyReplacements(current, replacements);
                if (!result.success) return result;

                let nextSource = result.source;
                if (sourceKind === 'html') {
                    const normalized = reviewProgrammableHtml(nextSource, {
                        phase: 'pr-apply',
                        documentKind: isDeck() ? 'pptx' : 'docx',
                        slideIndex,
                    });
                    if (normalized.refused) {
                        return {
                            success: false,
                            code: 'PROGRAMMABLE_CONTENT_REFUSED',
                            message: '审批后复核发现被拒绝的 JavaScript，未应用变更。',
                            programmableContent: {
                                status: 'refuse',
                                dependencies: normalized.dependencies,
                                diagnostics: normalized.diagnostics,
                            },
                        };
                    }
                    nextSource = normalized.html;
                    state.document.manifest.programmableDependencies = [
                        ...new Set([
                            ...(state.document.manifest.programmableDependencies || []),
                            ...normalized.dependencies,
                        ]),
                    ];
                } else if (sourceKind === 'script') {
                    state.document.manifest.programmableDependencies = [
                        ...new Set([
                            ...(state.document.manifest.programmableDependencies || []),
                            ...programmableContent.dependencies,
                        ]),
                    ];
                }

                if (isDeck()) {
                    const slide = slides()[slideIndex];
                    if (!slide) throw new Error('指定幻灯片不存在。');
                    if (sourceKind === 'css') slide.css = core.sanitizeCss(nextSource);
                    else if (sourceKind === 'script') slide.script = String(nextSource);
                    else slide.html = core.formatHtml(core.ensureTextNodeIds(nextSource));
                } else if (sourceKind === 'css') {
                    setCurrentCss(nextSource);
                } else {
                    setCurrentHtml(nextSource);
                }
                renderDocument();
                return {
                    success: true,
                    operation: {
                        type: 'source-replace',
                        sourceKind,
                        slideIndex,
                        replacements: result.applied,
                        programmableContent,
                    },
                    programmableContent,
                };
            });
        }

        function mutateSlides(payload = {}, type) {
            if (!isDeck()) {
                return Promise.resolve(response({
                    success: false,
                    code: 'PPTX_REQUIRED',
                    message: '幻灯片操作仅适用于 PPTX 端。',
                }));
            }

            let normalizedPayload = payload;
            let programmableContent = {
                status: 'allow',
                dependencies: [],
                diagnostics: [],
            };

            if (type !== 'delete') {
                const insertionIndex = type === 'insert'
                    ? Math.max(0, Math.min(slides().length, Number(payload.slideIndex) || 0))
                    : slides().length;
                const htmlReview = reviewProgrammableHtml(payload.html, {
                    phase: 'pr',
                    documentKind: 'pptx',
                    slideIndex: insertionIndex,
                });
                const scriptReview = reviewStandaloneScript(payload.script, {
                    phase: 'pr',
                    documentKind: 'pptx',
                    slideIndex: insertionIndex,
                    scriptId: payload.id || `slide-${insertionIndex + 1}`,
                });
                programmableContent.dependencies = [
                    ...new Set([
                        ...htmlReview.dependencies,
                        ...(scriptReview.dependencies || []),
                    ]),
                ];
                programmableContent.diagnostics = [
                    ...htmlReview.diagnostics,
                    ...scriptReview.findings.map((finding) => ({
                        ...finding,
                        context: scriptReview.context,
                    })),
                ];
                programmableContent.status = programmableContent.diagnostics.some(
                    (item) => item.level === 'refuse'
                )
                    ? 'refuse'
                    : programmableContent.diagnostics.some((item) => item.level === 'warn')
                        ? 'warn'
                        : 'allow';
                normalizedPayload = {
                    ...payload,
                    html: htmlReview.html,
                };

                if (programmableContent.status === 'refuse') {
                    return Promise.resolve(response({
                        success: false,
                        code: 'PROGRAMMABLE_CONTENT_REFUSED',
                        message: '新增页面包含被安全策略拒绝的 JavaScript，未建立待审 PR。',
                        programmableContent,
                    }));
                }
            }

            return queueMutation({
                ...normalizedPayload,
                proposal: {
                    type: `slide-${type}`,
                    slideIndex: normalizedPayload.slideIndex,
                    name: normalizedPayload.name,
                    html: normalizedPayload.html,
                    css: normalizedPayload.css,
                    script: normalizedPayload.script,
                    notes: normalizedPayload.notes,
                    programmableContent,
                },
            }, async () => {
                const list = slides();
                if (type === 'delete') {
                    const index = Number(normalizedPayload.slideIndex ?? state.activeSlideIndex);
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
                    ? Math.max(0, Math.min(list.length, Number(normalizedPayload.slideIndex) || 0))
                    : list.length;
                const slide = core.createSlide({
                    name: normalizedPayload.name,
                    html: normalizedPayload.html,
                    css: normalizedPayload.css,
                    script: normalizedPayload.script,
                    transition: normalizedPayload.transition,
                    notes: normalizedPayload.notes,
                    resources: normalizedPayload.resources,
                }, insertionIndex);
                list.splice(insertionIndex, 0, slide);
                state.document.manifest.programmableDependencies = [
                    ...new Set([
                        ...(state.document.manifest.programmableDependencies || []),
                        ...programmableContent.dependencies,
                    ]),
                ];
                state.activeSlideIndex = insertionIndex;
                renderDocument();
                return {
                    success: true,
                    operation: {
                        type: `slide-${type}`,
                        index: insertionIndex,
                        slideId: slide.id,
                        programmableContent,
                    },
                    programmableContent,
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
            getVisualContext: visualContext,
            getPrHistory: history,
            submitSourcePr,
            buildProjectArtifact,
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
            version: 2,
            common,
            docx,
            pptx,
            current: () => isDeck() ? pptx : docx,
            review: Object.freeze({
                approvePr,
                rejectPr,
                listPending: () => [...pendingPrs.values()]
                    .map((item) => publicRecord(item.record)),
            }),
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