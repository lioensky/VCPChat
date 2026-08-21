'use strict';

(() => {
    function createFlowAdapter(context = {}) {
        const documentPort = context.documentPort;
        const core = context.core;
        const compiler = context.hybridCompiler;
        if (!documentPort || !core || !compiler) {
            throw new TypeError('Flow adapter requires documentPort, core and hybridCompiler.');
        }

        let compiledRevision = -1;
        let compiledDocumentId = null;
        let compiledDocument = null;
        let surface = null;
        let disposed = false;

        function assertActive() {
            if (disposed) throw new Error('Flow adapter has been disposed.');
        }

        function documentModel() {
            assertActive();
            const model = documentPort.document();
            if (!model) throw new Error('No document is open.');
            if (model.manifest?.scene?.kind === core.PROJECT_KINDS.SLIDE_DECK) {
                throw new Error('Flow adapter cannot operate on a slide deck.');
            }
            return model;
        }

        function invalidate() {
            compiledRevision = -1;
            compiledDocumentId = null;
            compiledDocument = null;
            context.onInvalidate?.({ kind: 'flow' });
        }

        function currentSource() {
            return String(documentModel().source?.content || '');
        }

        function replaceCurrentSource(source, options = {}) {
            const nextSource = String(source ?? '');
            const previousSource = currentSource();
            if (nextSource === previousSource) return false;
            const reason = options.reason || 'flow-source-replaced';
            const result = documentPort.mutate((model) => {
                model.source.content = nextSource;
                model.source.format = core.SOURCE_FORMATS.MARKDOWN_HYBRID;
                model.manifest.sourceFormat = core.SOURCE_FORMATS.MARKDOWN_HYBRID;
            }, {
                reason,
                dirty: options.dirty !== false,
            });
            invalidate();
            return result;
        }

        function currentCss() {
            return String(documentModel().source?.documentCss || '');
        }

        function replaceCurrentCss(css, options = {}) {
            const nextCss = core.sanitizeCss(css);
            if (nextCss === currentCss()) return false;
            const result = documentPort.mutate((model) => {
                model.source.documentCss = nextCss;
            }, {
                reason: options.reason || 'flow-css-replaced',
                dirty: options.dirty !== false,
            });
            invalidate();
            return result;
        }

        function compile(options = {}) {
            const model = documentModel();
            const status = documentPort.status();
            if (!options.force
                && compiledDocument
                && compiledRevision === status.revision
                && compiledDocumentId === status.documentId) {
                return compiledDocument;
            }

            const result = compiler.compile(currentSource(), {
                sanitizeHtml: core.sanitizeHtml,
            });
            const previousIslands = new Map(
                (model.islands || []).map((island) => [island.id, island])
            );
            documentPort.updateDerived((nextModel) => {
                nextModel.source.lineEnding = result.lineEnding;
                nextModel.islands = result.islands.map((island) => ({
                    ...previousIslands.get(island.id),
                    ...island,
                    runtimeTextOverrides: Array.isArray(
                        previousIslands.get(island.id)?.runtimeTextOverrides
                    )
                        ? previousIslands.get(island.id).runtimeTextOverrides
                        : [],
                }));
                nextModel.manifest.programmableDependencies = [
                    ...new Set(result.dependencies.filter((item) =>
                        ['anime', 'three'].includes(item)
                    )),
                ];
            }, { reason: 'flow-compiled-metadata' });

            compiledRevision = status.revision;
            compiledDocumentId = status.documentId;
            compiledDocument = Object.freeze({
                ...result,
                css: core.sanitizeCss(model.source?.documentCss || ''),
            });
            return compiledDocument;
        }

        function sourceState(documentOverride = null) {
            const model = documentOverride || documentModel();
            return Object.freeze({
                documentKind: 'docx',
                scene: model.manifest?.scene
                    ? JSON.parse(JSON.stringify(model.manifest.scene))
                    : null,
                source: String(model.source?.content || ''),
                documentCss: String(model.source?.documentCss || ''),
                deckCss: '',
                slides: [],
            });
        }

        function renderEditSurface(target, options = {}) {
            assertActive();
            if (!context.renderer?.renderEdit) {
                throw new Error('Flow edit renderer is unavailable.');
            }
            disposeSurface();
            surface = context.renderer.renderEdit({
                adapter: api,
                target,
                compiled: compile(options),
                ...options,
            });
            return surface;
        }

        function renderReadSurface(target, options = {}) {
            assertActive();
            if (!context.renderer?.renderRead) {
                throw new Error('Flow read renderer is unavailable.');
            }
            return context.renderer.renderRead({
                adapter: api,
                target,
                compiled: compile(options),
                ...options,
            });
        }

        function insertContent(fragment, options = {}) {
            const insertion = String(fragment ?? '').replace(/^\s*\n|\n\s*$/g, '');
            if (!insertion) return false;
            const source = currentSource();
            const requestedOffset = Number(options.offset);
            const offset = Number.isFinite(requestedOffset)
                ? Math.max(0, Math.min(source.length, requestedOffset))
                : source.length;
            const prefix = offset > 0 && !/[\r\n]$/.test(source.slice(0, offset))
                ? '\n\n'
                : '';
            const suffix = offset < source.length && !/^[\r\n]/.test(source.slice(offset))
                ? '\n\n'
                : '';
            return replaceCurrentSource(
                source.slice(0, offset)
                + prefix
                + insertion
                + suffix
                + source.slice(offset),
                { reason: options.reason || 'flow-content-inserted' }
            );
        }

        function executeFormatting(command, value, options = {}) {
            if (!context.editor?.executeFormatting) {
                throw new Error('Flow editor strategy is unavailable.');
            }
            return context.editor.executeFormatting(command, value, {
                adapter: api,
                ...options,
            });
        }

        function outline() {
            const compiled = compile();
            const semanticItems = core.extractOutline(compiled.html);
            const paragraphs = semanticItems.filter((item) =>
                item.kind === 'paragraph'
            );
            return [
                ...compiled.headings.map((heading) => ({
                    ...heading,
                    ordinal: heading.editRegionOrdinal,
                })),
                ...paragraphs,
            ];
        }

        function proposalSource(proposal = {}) {
            return proposal.sourceKind === 'document-css'
                ? currentCss()
                : currentSource();
        }

        function proposalPreview(context = {}) {
            const before = compiler.compile(
                String(context.before || ''),
                { sanitizeHtml: core.sanitizeHtml }
            );
            const after = compiler.compile(
                String(context.after || ''),
                { sanitizeHtml: core.sanitizeHtml }
            );
            return Object.freeze({
                before: before.html,
                after: after.html,
                css: currentCss(),
            });
        }

        function exportHtml(options = {}) {
            if (!context.exporter?.build) {
                throw new Error('Flow exporter is unavailable.');
            }
            return context.exporter.build({
                adapter: api,
                compiled: compile(),
                ...options,
            });
        }

        function attachEditor(editor) {
            context.editor = editor;
            return api;
        }

        function attachRenderer(renderer) {
            context.renderer = renderer;
            return api;
        }

        function attachExporter(exporter) {
            context.exporter = exporter;
            return api;
        }

        function disposeSurface() {
            try {
                surface?.dispose?.();
            } finally {
                surface = null;
                context.editor?.flush?.();
                context.editor?.disposeSurface?.();
            }
        }

        function dispose() {
            if (disposed) return;
            disposeSurface();
            invalidate();
            disposed = true;
        }

        const api = Object.freeze({
            kind: 'flow',
            projectKind: core.PROJECT_KINDS.FLOW_DOCUMENT,
            currentSource,
            replaceCurrentSource,
            currentCss,
            replaceCurrentCss,
            compile,
            sourceState,
            renderEditSurface,
            renderReadSurface,
            insertContent,
            executeFormatting,
            outline,
            proposalSource,
            proposalPreview,
            exportHtml,
            attachEditor,
            attachRenderer,
            attachExporter,
            invalidate,
            disposeSurface,
            dispose,
        });

        return api;
    }

    window.ScriptoriumFlowAdapter = Object.freeze({
        createFlowAdapter,
    });
})();