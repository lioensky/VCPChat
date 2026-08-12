'use strict';

(() => {
    function normalizeAuthor(author) {
        if (typeof author === 'string') {
            const name = author.trim();
            return name ? { id: name, name, type: 'agent' } : null;
        }
        if (!author || typeof author !== 'object') return null;
        const name = String(
            author.name || author.signature || author.id || ''
        ).trim();
        return name
            ? {
                id: String(author.id || name),
                name,
                type: author.type === 'human' ? 'human' : 'agent',
            }
            : null;
    }

    function textFromHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        template.content.querySelectorAll(
            'style,script,noscript'
        ).forEach((node) => node.remove());
        return String(template.content.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function findAll(source, query, options = {}) {
        const text = String(source || '');
        const needle = String(query || '');
        if (!needle) return [];
        let expression;
        try {
            expression = options.regex
                ? new RegExp(needle, options.caseSensitive ? 'g' : 'gi')
                : new RegExp(
                    needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    options.caseSensitive ? 'g' : 'gi'
                );
        } catch (error) {
            throw new Error(`检索表达式无效：${error.message}`);
        }
        const results = [];
        let match;
        while ((match = expression.exec(text)) && results.length < 200) {
            const before = text.slice(0, match.index);
            results.push(Object.freeze({
                startLine: before.split('\n').length,
                endLine: before.split('\n').length
                    + match[0].split('\n').length - 1,
                match: match[0],
            }));
            if (!match[0].length) expression.lastIndex += 1;
        }
        return results;
    }

    function createAgentController(context = {}) {
        const documentPort = context.documentPort;
        const lineagePort = context.lineagePort;
        const core = context.core;
        const diff = context.prDiff;
        if (!documentPort || !lineagePort || !core || !diff) {
            throw new TypeError(
                'Agent controller requires DocumentPort, LineagePort, VDocCore and PR diff.'
            );
        }

        const pending = new Map();
        const handled = new Map();
        let mutationQueue = Promise.resolve();
        let disposed = false;

        function adapter() {
            const current = context.getAdapter?.();
            if (!current) throw new Error('Scriptorium 文档尚未就绪。');
            return current;
        }

        function status() {
            const current = documentPort.status();
            if (!current.ready || !documentPort.document()) {
                throw new Error('Scriptorium 文档尚未就绪。');
            }
            return current;
        }

        function response(data = {}) {
            const current = status();
            return {
                success: true,
                documentId: current.documentId,
                documentKind: adapter().kind === 'deck' ? 'pptx' : 'docx',
                revision: current.revision,
                ...data,
            };
        }

        function sourceFor(sourceKind, slideIndex = null) {
            const current = adapter();
            if (current.kind === 'flow') {
                if (sourceKind && sourceKind !== 'markdown-hybrid') {
                    throw new Error('VDOCX 仅支持 markdown-hybrid。');
                }
                return current.currentSource();
            }
            if (sourceKind === 'deck-css') return current.currentCss();
            const index = slideIndex === null || slideIndex === undefined
                ? current.activeSlideIndex()
                : Number(slideIndex);
            const slide = current.slides()[index];
            if (!slide) throw new Error('指定幻灯片不存在。');
            return String(slide.source || '');
        }

        function documentInfo() {
            const current = status();
            const model = documentPort.document();
            const currentAdapter = adapter();
            return response({
                title: model.manifest.title,
                name: current.currentName,
                dirty: current.dirty,
                scene: core.createSceneConfig(model.manifest.scene),
                activeSlideIndex: currentAdapter.kind === 'deck'
                    ? currentAdapter.activeSlideIndex()
                    : null,
                slideCount: currentAdapter.kind === 'deck'
                    ? currentAdapter.slides().length
                    : null,
            });
        }

        function getSource(options = {}) {
            const kind = options.sourceKind
                || (adapter().kind === 'deck' ? 'html' : 'markdown-hybrid');
            const source = sourceFor(kind, options.slideIndex);
            const lines = source.replace(/\r\n?/g, '\n').split('\n');
            const start = Math.max(
                1,
                Math.min(lines.length, Number(options.startLine) || 1)
            );
            const end = Math.max(
                start,
                Math.min(
                    lines.length,
                    Number(options.endLine) || lines.length,
                    start + 1999
                )
            );
            return response({
                sourceKind: kind,
                slideIndex: adapter().kind === 'deck'
                    ? Number(
                        options.slideIndex ?? adapter().activeSlideIndex()
                    )
                    : null,
                startLine: start,
                endLine: end,
                totalLines: lines.length,
                source: lines.slice(start - 1, end).join('\n'),
            });
        }

        function renderedText(options = {}) {
            const current = adapter();
            if (current.kind === 'flow') {
                const compiled = current.compile();
                return response({
                    semanticFormat: 'compiled-html',
                    text: textFromHtml(compiled.html),
                    blocks: compiled.blocks,
                    diagnostics: compiled.diagnostics,
                });
            }
            const indexes = options.slideIndex === undefined
                ? current.slides().map((slide, index) => index)
                : [Number(options.slideIndex)];
            return response({
                pages: indexes.map((index) => {
                    const slide = current.slides()[index];
                    if (!slide) throw new Error('指定幻灯片不存在。');
                    return {
                        index,
                        id: slide.id,
                        name: slide.name,
                        text: textFromHtml(slide.source),
                        notes: slide.notes || '',
                    };
                }),
            });
        }

        function outline() {
            return response({ items: adapter().outline() });
        }

        function searchSource(options = {}) {
            const current = adapter();
            const kinds = options.sourceKind === 'all'
                ? (
                    current.kind === 'deck'
                        ? ['html', 'deck-css']
                        : ['markdown-hybrid']
                )
                : [
                    options.sourceKind
                    || (current.kind === 'deck' ? 'html' : 'markdown-hybrid'),
                ];
            const indexes = current.kind === 'deck'
                && options.slideIndex === undefined
                ? current.slides().map((slide, index) => index)
                : [options.slideIndex ?? null];
            const results = [];
            kinds.forEach((kind) => {
                const targets = kind === 'deck-css' ? [null] : indexes;
                targets.forEach((index) => {
                    findAll(
                        sourceFor(kind, index),
                        options.query,
                        options
                    ).forEach((item) => results.push({
                        sourceKind: kind,
                        slideIndex: index,
                        ...item,
                    }));
                });
            });
            return response({
                query: options.query,
                results: results.slice(0, 200),
            });
        }

        function publicRecord(record) {
            const { snapshot, ...visible } = record;
            return visible;
        }

        function createReceipt(decision, options = {}) {
            return {
                decision,
                message: String(options.message || options.reason || '').trim(),
                reviewer: normalizeAuthor(options.reviewer) || {
                    id: options.automatic
                        ? 'scriptorium-auto-policy'
                        : 'human',
                    name: options.automatic
                        ? 'Scriptorium 自动允许策略'
                        : '人类审阅者',
                    type: 'human',
                },
                createdAt: Date.now(),
                automatic: options.automatic === true,
                policy: options.policy || null,
            };
        }

        function queueProposal(payload, proposal, operation) {
            status();
            const author = normalizeAuthor(payload.author || payload.maid);
            const summary = String(payload.summary || '').trim();
            if (!author || !summary) {
                return Promise.resolve({
                    success: false,
                    code: !author ? 'AUTHOR_REQUIRED' : 'SUMMARY_REQUIRED',
                    message: !author
                        ? 'Agent PR 必须提供署名。'
                        : 'Agent PR 必须提供 summary。',
                });
            }
            const requestId = String(
                payload.requestId || crypto.randomUUID()
            );
            if (handled.has(requestId)) return handled.get(requestId);
            const current = status();
            const record = lineagePort.add({
                id: payload.prId || `pr-${crypto.randomUUID()}`,
                source: 'agent',
                author,
                name: payload.name || 'Agent 源码变更',
                summary,
                note: payload.note || '',
                baseRevision: Number.isFinite(Number(payload.expectedRevision))
                    ? Number(payload.expectedRevision)
                    : current.revision,
                revision: null,
                proposal,
                status: 'pending',
            }, { snapshot: false });
            let resolvePending;
            const task = new Promise((resolve) => {
                resolvePending = resolve;
            });
            pending.set(record.id, {
                record,
                operation,
                resolve: resolvePending,
                documentId: current.documentId,
            });
            handled.set(requestId, task);
            context.persist?.('AI 待审刻点');
            window.dispatchEvent(new CustomEvent(
                'scriptorium:pr-pending',
                { detail: publicRecord(record) }
            ));
            return task;
        }

        function submitSourcePr(payload = {}) {
            const current = adapter();
            const sourceKind = payload.sourceKind
                || (current.kind === 'deck' ? 'html' : 'markdown-hybrid');
            const slideIndex = current.kind === 'deck'
                ? Number(
                    payload.slideIndex ?? current.activeSlideIndex()
                )
                : null;
            const replacements = Array.isArray(payload.replacements)
                ? payload.replacements
                : [payload];
            const preliminary = diff.applyReplacements(
                sourceFor(sourceKind, slideIndex),
                replacements
            );
            if (!preliminary.success) {
                return Promise.resolve(response(preliminary));
            }
            return queueProposal(payload, {
                type: 'source-replace',
                sourceKind,
                slideIndex,
                replacements,
            }, () => {
                const active = adapter();
                const result = diff.applyReplacements(
                    sourceFor(sourceKind, slideIndex),
                    replacements
                );
                if (!result.success) return result;
                const changed = sourceKind === 'deck-css'
                    ? active.replaceCurrentCss(result.source, {
                        reason: 'agent-source-pr',
                    })
                    : (
                        active.kind === 'deck'
                            ? active.replaceSlideSource(
                                slideIndex,
                                result.source,
                                { reason: 'agent-source-pr' }
                            )
                            : active.replaceCurrentSource(result.source, {
                                reason: 'agent-source-pr',
                            })
                    );
                return {
                    success: changed !== false,
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
            const current = adapter();
            if (current.kind !== 'deck') {
                return Promise.resolve({
                    success: false,
                    code: 'PPTX_REQUIRED',
                    message: '幻灯片操作仅适用于 VPPTX。',
                });
            }
            const proposal = {
                type: `slide-${type}`,
                slideIndex: payload.slideIndex,
                name: payload.name,
                source: payload.source,
                notes: payload.notes,
            };
            return queueProposal(payload, proposal, () => {
                if (type === 'delete') {
                    const removed = current.deleteSlide(
                        payload.slideIndex ?? current.activeSlideIndex(),
                        { reason: 'agent-slide-delete' }
                    );
                    return {
                        success: Boolean(removed),
                        operation: {
                            type: 'slide-delete',
                            slideId: removed?.id,
                        },
                    };
                }
                const created = current.addSlide({
                    name: payload.name,
                    source: payload.source,
                    notes: payload.notes,
                    transition: payload.transition,
                    resources: payload.resources,
                }, {
                    index: type === 'insert'
                        ? payload.slideIndex
                        : undefined,
                    reason: `agent-slide-${type}`,
                });
                return {
                    success: Boolean(created),
                    operation: {
                        type: `slide-${type}`,
                        slideId: created?.id,
                    },
                };
            });
        }

        function approvePr(prId, options = {}) {
            const entry = pending.get(String(prId || ''));
            if (!entry) {
                return Promise.resolve({
                    success: false,
                    code: 'PR_NOT_PENDING',
                    message: '指定 PR 不存在或已完成审阅。',
                });
            }
            const refused = entry.record.proposal
                ?.programmableContent?.status === 'refuse';
            if (refused && options.automatic) {
                return Promise.resolve({
                    success: false,
                    code: 'PR_REQUIRES_HUMAN_REVIEW',
                    message: 'refuse 级提案必须由人类审阅。',
                });
            }
            pending.delete(entry.record.id);
            const receipt = createReceipt('approved', options);
            const task = mutationQueue.then(async () => {
                if (entry.documentId !== status().documentId) {
                    lineagePort.update(entry.record.id, {
                        status: 'conflict',
                        reviewedAt: Date.now(),
                        receipt: {
                            ...receipt,
                            decision: 'conflict',
                        },
                    });
                    const conflict = {
                        success: false,
                        code: 'DOCUMENT_CONTEXT_CHANGED',
                        message: '当前窗口已切换到另一份文档。',
                    };
                    entry.resolve(conflict);
                    return conflict;
                }
                const before = adapter().sourceState();
                const result = await entry.operation();
                const applied = result?.success === true;
                lineagePort.update(entry.record.id, {
                    status: applied ? 'applied' : 'failed',
                    reviewedAt: Date.now(),
                    revision: status().revision,
                    operation: result?.operation || null,
                    changeSet: {
                        type: result?.operation?.type
                            || entry.record.proposal?.type,
                        before,
                        after: applied ? adapter().sourceState() : before,
                    },
                    receipt: applied
                        ? receipt
                        : {
                            ...receipt,
                            decision: 'failed',
                            message: result?.message || '变更应用失败。',
                        },
                    snapshot: applied ? lineagePort.snapshot() : '',
                });
                if (applied) {
                    context.historyPort?.capture?.({
                        reason: 'agent-pr-applied',
                    });
                    context.renderPort?.invalidate?.('agent-pr-applied');
                    context.renderPort?.renderCurrent?.({ force: true });
                }
                await context.persist?.(
                    applied ? 'AI 提案合并刻点' : 'AI 提案失败状态'
                );
                const outcome = {
                    success: applied,
                    code: applied ? undefined : 'MUTATION_FAILED',
                    pr: publicRecord(entry.record),
                    receipt,
                    result,
                };
                entry.resolve(outcome);
                return outcome;
            });
            mutationQueue = task.then(
                () => undefined,
                () => undefined
            );
            return task;
        }

        async function rejectPr(prId, options = {}) {
            const entry = pending.get(String(prId || ''));
            if (!entry) {
                return {
                    success: false,
                    code: 'PR_NOT_PENDING',
                    message: '指定 PR 不存在或已完成审阅。',
                };
            }
            pending.delete(entry.record.id);
            const receipt = createReceipt('rejected', options);
            lineagePort.update(entry.record.id, {
                status: 'rejected',
                reviewedAt: Date.now(),
                receipt,
            });
            await context.persist?.('AI 提案拒绝状态');
            const result = {
                success: false,
                code: 'PR_REJECTED',
                message: receipt.message || '人类拒绝了该提案。',
                receipt,
            };
            entry.resolve(result);
            return result;
        }

        function history(options = {}) {
            return response({
                records: lineagePort.list(options).map(publicRecord),
            });
        }

        const common = Object.freeze({
            getDocumentInfo: documentInfo,
            getRenderedText: renderedText,
            getOutline: outline,
            getSource,
            searchSource,
            getPrHistory: history,
            submitSourcePr,
        });
        const docx = Object.freeze({
            ...common,
            getFullText: renderedText,
        });
        const pptx = Object.freeze({
            ...common,
            getSlideCount: () => response({
                count: adapter().slides().length,
            }),
            getSlide: renderedText,
            getActiveSlide: () => renderedText({
                slideIndex: adapter().activeSlideIndex(),
            }),
            selectSlide: (options = {}) => {
                adapter().selectSlide(Number(options.slideIndex));
                return response({
                    activeSlideIndex: adapter().activeSlideIndex(),
                });
            },
            addSlide: (payload) => mutateSlides(payload, 'add'),
            insertSlide: (payload) => mutateSlides(payload, 'insert'),
            deleteSlide: (payload) => mutateSlides(payload, 'delete'),
        });

        function dispose() {
            if (disposed) return;
            pending.forEach((entry) => entry.resolve({
                success: false,
                code: 'AGENT_DISPOSED',
                message: 'Scriptorium 已关闭。',
            }));
            pending.clear();
            handled.clear();
            disposed = true;
        }

        return Object.freeze({
            version: 3,
            common,
            docx,
            pptx,
            current: () => adapter().kind === 'deck' ? pptx : docx,
            review: Object.freeze({
                approvePr,
                rejectPr,
                listPending: () => [...pending.values()].map(
                    (entry) => publicRecord(entry.record)
                ),
            }),
            dispose,
        });
    }

    window.ScriptoriumAgentPort = Object.freeze({
        normalizeAuthor,
        textFromHtml,
        findAll,
        createAgentController,
    });
})();