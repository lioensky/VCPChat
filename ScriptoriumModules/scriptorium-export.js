'use strict';

(() => {
    function createExportController(context = {}) {
        const documentPort = context.documentPort;
        const persistencePort = context.persistencePort;
        const resourceModule = context.exportResourcesModule;
        const containerModule = context.containerModule;
        const notificationPort = context.notificationPort || {};
        if (!documentPort || !persistencePort) {
            throw new TypeError(
                'Export controller requires DocumentPort and PersistencePort.'
            );
        }

        let adapter = null;
        let disposed = false;

        function assertActive() {
            if (disposed) throw new Error('Export controller has been disposed.');
        }

        function setAdapter(nextAdapter) {
            assertActive();
            if (!nextAdapter || typeof nextAdapter.exportHtml !== 'function') {
                throw new TypeError('Export controller requires a document adapter.');
            }
            adapter = nextAdapter;
            return adapter;
        }

        function currentAdapter() {
            assertActive();
            const resolved = adapter || context.getAdapter?.();
            if (!resolved) throw new Error('No document adapter is active.');
            return resolved;
        }

        function suggestedName(format) {
            const name = documentPort.status().currentName || '未命名文稿.vdocx';
            const base = name.replace(/\.(?:vdocx|vpptx)$/i, '');
            return `${base}${format === 'pdf' ? '.pdf' : '.html'}`;
        }

        async function localizeHtml(html, operationContext) {
            if (!resourceModule?.localizeHtmlMedia) {
                return {
                    html,
                    localized: 0,
                    retained: 0,
                    failures: [],
                };
            }
            const result = await resourceModule.localizeHtmlMedia(html, {
                readExternalResource: (payload) =>
                    persistencePort.readExternalResource(payload),
                bytesToBase64: containerModule?.bytesToBase64,
            });
            if (!documentPort.isContextCurrent(
                operationContext,
                { revision: true }
            )) {
                return null;
            }
            return result;
        }

        async function execute(format, options = {}) {
            assertActive();
            const status = documentPort.status();
            if (!status.ready || status.saving) return false;
            context.editorPort?.flush?.();
            context.historyPort?.finalize?.();

            const operationContext = documentPort.captureContext({
                command: 'export',
                format,
            });
            try {
                const product = await currentAdapter().exportHtml({
                    format,
                    zoom: options.zoom,
                    surfacePort: context.surfacePort,
                });
                if (!product || typeof product.html !== 'string') {
                    throw new Error('文档适配器没有返回有效 HTML 导出产物。');
                }
                if (!documentPort.isContextCurrent(
                    operationContext,
                    { revision: true }
                )) {
                    return false;
                }

                let html = documentPort.resourceResolver()
                    ?.resolveExportHtml?.(product.html)
                    || product.html;
                let localization = null;
                if (format !== 'pdf') {
                    localization = await localizeHtml(html, operationContext);
                    if (!localization) return false;
                    html = localization.html;
                }

                const model = documentPort.document();
                const result = await persistencePort.exportRichDocument({
                    format,
                    html,
                    paged: product.paged === true,
                    suggestedName: suggestedName(format),
                    page: product.page || model.manifest?.scene?.page,
                    programmableDependencies:
                        model.manifest?.programmableDependencies || [],
                });
                if (!result?.success
                    || !documentPort.isContextCurrent(operationContext)) {
                    return false;
                }

                const localizedSummary = localization?.localized
                    ? ` · 已内联 ${localization.localized} 项媒体`
                    : '';
                const retainedSummary = localization?.retained
                    ? ` · ${localization.retained} 项保留原 URL`
                    : '';
                notificationPort.show?.(
                    `已导出 · ${result.name}${localizedSummary}${retainedSummary}`,
                    localization?.retained ? 'info' : 'success',
                    localization?.retained ? 5000 : 2600
                );
                if (localization?.failures?.length) {
                    console.warn(
                        '[ScriptoriumExport] External resources retained:',
                        localization.failures
                    );
                }
                return true;
            } catch (error) {
                notificationPort.show?.(
                    `导出失败：${error.message}`,
                    'error',
                    5000
                );
                return false;
            }
        }

        function dispose() {
            adapter = null;
            disposed = true;
        }

        return Object.freeze({
            setAdapter,
            execute,
            dispose,
        });
    }

    window.ScriptoriumExport = Object.freeze({
        createExportController,
    });
})();