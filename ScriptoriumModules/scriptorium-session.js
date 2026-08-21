'use strict';

(() => {
    function createSessionController(context = {}) {
        const documentPort = context.documentPort;
        const persistencePort = context.persistencePort;
        const containerModule = context.containerModule;
        const core = context.core;
        const notificationPort = context.notificationPort || {};
        if (!documentPort || !persistencePort || !containerModule || !core) {
            throw new TypeError(
                'Session controller requires DocumentPort, PersistencePort, VDocContainer and VDocCore.'
            );
        }

        let elements = context.elements || {};
        let unsavedResolver = null;
        let checkpointQueue = Promise.resolve();
        let disposed = false;

        function setElements(nextElements) {
            elements = nextElements || {};
        }

        function adapter() {
            const resolved = context.getAdapter?.();
            if (!resolved) throw new Error('No document adapter is active.');
            return resolved;
        }

        async function activateDocument(documentModel, metadata = {}) {
            const previousDocumentId = documentPort.status().documentId;
            documentPort.setActivity({
                loading: true,
                reason: 'document-loading',
            });
            if (elements['loading-state']) {
                elements['loading-state'].hidden = false;
            }
            try {
                const normalized = core.normalizeDocument(documentModel);
                documentPort.replaceDocument(normalized, {
                    ...metadata,
                    previousDocumentId,
                    reason: metadata.reason || 'session-open',
                });
                const activeAdapter = context.resolveAdapter(normalized);
                context.activateAdapter(activeAdapter);

                // 导入的 Markdown/HTML 可能把网络字体声明放在混合源码的
                // <style> 中。必须在首次 Surface 渲染前完成受控下载、工程
                // 资源注册和 URL 改写，否则首屏只能使用回退字体。
                if (metadata.imported && context.networkFontPort) {
                    try {
                        await context.networkFontPort.processDocument(
                            activeAdapter,
                            {
                                dirty: false,
                                notify: true,
                            }
                        );
                    } catch (error) {
                        console.warn(
                            '[ScriptoriumSession] Imported network fonts could not be localized:',
                            error
                        );
                        notificationPort.show?.(
                            `网络字体本地化失败，将使用回退字体：${error.message}`,
                            'info',
                            5000
                        );
                    }
                }

                context.historyPort.reset({ capture: false });
                context.renderPort.invalidate('document-opened');

                // 工作区必须先进入可布局状态，再建立依赖宿主尺寸、ShadowRoot
                // 和可见区域的编辑 Surface。禁止在 hidden 祖先中预渲染后仅凭
                // 模式切换返回值推断画布已经可用。
                document.body.classList.remove('home-state');
                if (elements['welcome-state']) {
                    elements['welcome-state'].hidden = true;
                }
                if (elements['document-workspace']) {
                    elements['document-workspace'].hidden = false;
                }
                if (elements['render-host']) {
                    elements['render-host'].hidden = false;
                }
                if (elements['read-host']) {
                    elements['read-host'].hidden = true;
                }
                if (elements['source-host']) {
                    elements['source-host'].hidden = true;
                }

                const editActivated = context.surfacePort?.switchMode?.(
                    'edit',
                    { force: true }
                );
                if (!editActivated) {
                    context.renderPort.renderEdit({ force: true });
                }
                context.historyPort.capture({ reason: 'document-opened' });
                context.lineagePort?.load?.(normalized);
                notificationPort.show?.(
                    metadata.imported
                        ? '导入工程已建立'
                        : '文档已展开',
                    'success'
                );
                return true;
            } finally {
                documentPort.setActivity({
                    loading: false,
                    reason: 'document-loaded',
                });
                if (elements['loading-state']) {
                    elements['loading-state'].hidden = true;
                }
            }
        }

        function create(documentModel = null, metadata = {}) {
            return activateDocument(
                documentModel || core.createDocument(),
                metadata
            );
        }

        function createDeck() {
            return create(core.createDocument({
                kind: core.PROJECT_KINDS.SLIDE_DECK,
                title: '未命名演示',
            }));
        }

        async function openResult(result) {
            if (!result?.success) return false;
            if (result.kind === 'imported') {
                const title = String(result.name || '导入文稿')
                    .replace(/\.[^.]+$/, '');
                const deck = result.importedKind === 'pptx';
                const model = core.createDocument({
                    title,
                    kind: deck
                        ? core.PROJECT_KINDS.SLIDE_DECK
                        : core.PROJECT_KINDS.FLOW_DOCUMENT,
                    source: deck ? undefined : String(result.source ?? ''),
                    lineEnding: deck ? 'lf' : result.lineEnding,
                    slides: deck ? result.slides : undefined,
                    page: deck ? result.page : undefined,
                });
                model.manifest.import = result.importMetadata || {
                    sourceFormat: result.importedKind,
                    sourceName: result.name,
                };
                const opened = await activateDocument(model, {
                    filePath: null,
                    name: `${title}${deck ? '.vpptx' : '.vdocx'}`,
                    imported: true,
                });
                if (opened) {
                    documentPort.markDirty({
                        reason: 'imported-document',
                    });
                }
                return opened;
            }
            const bytes = Uint8Array.from(result.bytes || []);
            const unpacked = await containerModule.unpack(bytes, core);
            return activateDocument(unpacked.document, {
                ...result,
                resourceData: unpacked.resourceData,
            });
        }

        async function runAfterUnsavedDecision(message, action) {
            if (!documentPort.status().dirty) return action();
            const decision = await requestUnsavedDecision(message);
            if (decision === 'cancel') return false;
            if (decision === 'save' && !await save(false)) return false;
            return action();
        }

        async function open() {
            return runAfterUnsavedDecision(
                '打开另一份文档前，可以保存当前修改，或舍弃这些修改。',
                async () => {
                    try {
                        return openResult(await persistencePort.chooseOpen());
                    } catch (error) {
                        notificationPort.show?.(
                            `打开失败：${error.message}`,
                            'error',
                            5000
                        );
                        return false;
                    }
                }
            );
        }

        async function importDocument() {
            return runAfterUnsavedDecision(
                '导入文档会建立一份新工程。可以先保存当前修改。',
                async () => {
                    try {
                        return openResult(await persistencePort.chooseImport());
                    } catch (error) {
                        notificationPort.show?.(
                            `导入失败：${error.message}`,
                            'error',
                            5000
                        );
                        return false;
                    }
                }
            );
        }

        async function openPath(filePath) {
            return runAfterUnsavedDecision(
                '载入另一份文档前，可以保存当前修改。',
                async () => {
                    try {
                        return openResult(
                            await persistencePort.readPath(filePath)
                        );
                    } catch (error) {
                        notificationPort.show?.(
                            `载入失败：${error.message}`,
                            'error',
                            5000
                        );
                        return false;
                    }
                }
            );
        }

        async function save(saveAs = false) {
            const status = documentPort.status();
            if (!status.ready || status.saving) return false;
            context.editorResolver?.()?.flush?.();
            // 渲染编辑器与源码编辑器均实时写入同一个文档模型。保存只需
            // 结束当前历史输入脉冲，不再从源码面板提交第二份草稿。
            context.historyPort.finalize();

            const operationContext = documentPort.captureContext();
            documentPort.setActivity({
                saving: true,
                reason: 'document-saving',
            });
            try {
                context.lineagePort?.sync?.();
                context.onBeforeSave?.(documentPort.document(), adapter());
                const bytes = await containerModule.pack(
                    documentPort.document(),
                    documentPort.resourceData()
                );
                const result = await persistencePort.save({
                    filePath: status.currentPath,
                    suggestedName: status.currentName,
                    saveAs,
                    bytes,
                });
                if (!result?.success
                    || !documentPort.isContextCurrent(operationContext)) {
                    return false;
                }
                documentPort.markSaved({
                    filePath: result.filePath,
                    name: result.name,
                    revision: operationContext.revision,
                });
                notificationPort.show?.(
                    `已保存 · ${result.name}`,
                    'success'
                );
                renderRecent();
                return true;
            } catch (error) {
                notificationPort.show?.(
                    `保存失败：${error.message}`,
                    'error',
                    5000
                );
                return false;
            } finally {
                if (documentPort.isContextCurrent(
                    operationContext,
                    { document: false }
                )) {
                    documentPort.setActivity({
                        saving: false,
                        reason: 'document-save-finished',
                    });
                }
            }
        }

        function persistCheckpoint(reason = '刻点') {
            checkpointQueue = checkpointQueue
                .catch(() => false)
                .then(async () => {
                    while (documentPort.status().saving) {
                        await new Promise((resolve) =>
                            window.setTimeout(resolve, 40)
                        );
                    }
                    const saved = await save(false);
                    if (!saved) {
                        notificationPort.show?.(
                            `${reason}已建立，但保存到文件失败`,
                            'error',
                            5000
                        );
                    }
                    return saved;
                });
            return checkpointQueue;
        }

        function requestUnsavedDecision(message) {
            if (!documentPort.status().dirty) {
                return Promise.resolve('discard');
            }
            if (unsavedResolver) return Promise.resolve('cancel');
            if (elements['unsaved-dialog-message']) {
                elements['unsaved-dialog-message'].textContent = message;
            }
            if (elements['unsaved-document-name']) {
                elements['unsaved-document-name'].textContent =
                    documentPort.status().currentName;
            }
            elements['unsaved-dialog'].hidden = false;
            return new Promise((resolve) => {
                unsavedResolver = resolve;
            });
        }

        function resolveUnsavedDecision(decision) {
            if (!unsavedResolver) return;
            const resolve = unsavedResolver;
            unsavedResolver = null;
            elements['unsaved-dialog'].hidden = true;
            resolve(decision);
        }

        async function showHome() {
            return runAfterUnsavedDecision(
                '回到首页前，可以保存当前修改，或舍弃这些修改。',
                async () => {
                    context.surfacePort?.setFocusMode?.(false, {
                        focusDock: false,
                    });
                    context.editorResolver?.()?.flush?.();
                    context.historyPort.finalize();
                    context.navigationPort?.clear?.();
                    context.lineageUiPort?.clear?.();
                    if (elements['document-title']) {
                        elements['document-title'].textContent = '';
                        elements['document-title'].title = '';
                    }
                    if (elements['focus-document-title']) {
                        elements['focus-document-title'].textContent = '';
                        elements['focus-document-title'].title = '';
                    }
                    if (elements['document-workspace']) {
                        elements['document-workspace'].hidden = true;
                    }
                    if (elements['loading-state']) {
                        elements['loading-state'].hidden = true;
                    }
                    if (elements['welcome-state']) {
                        elements['welcome-state'].hidden = false;
                    }
                    document.body.classList.add('home-state');
                    context.surfacePort?.refreshControls?.();
                    await Promise.all([
                        renderRecent(),
                        context.libraryPort?.refresh?.(),
                    ]);
                    return true;
                }
            );
        }

        async function close() {
            return runAfterUnsavedDecision(
                '关闭 Scriptorium 前，可以保存当前修改。',
                () => persistencePort.closeWindow()
            );
        }

        async function renderRecent() {
            const host = elements['recent-documents'];
            if (!host) return;
            let recent = [];
            try {
                recent = await persistencePort.listRecent();
            } catch {}
            host.replaceChildren(...recent.slice(0, 6).map((item) => {
                const button = document.createElement('button');
                button.className = 'recent-document';
                button.textContent = item.name;
                button.title = item.path;
                button.addEventListener(
                    'click',
                    () => openPath(item.path)
                );
                return button;
            }));
        }

        function bind() {
            elements['unsaved-cancel-btn']?.addEventListener(
                'click',
                () => resolveUnsavedDecision('cancel')
            );
            elements['unsaved-discard-btn']?.addEventListener(
                'click',
                () => resolveUnsavedDecision('discard')
            );
            elements['unsaved-save-btn']?.addEventListener(
                'click',
                () => resolveUnsavedDecision('save')
            );
        }

        function dispose() {
            if (disposed) return;
            if (unsavedResolver) resolveUnsavedDecision('cancel');
            disposed = true;
        }

        return Object.freeze({
            setElements,
            activateDocument,
            create,
            createDeck,
            showHome,
            open,
            import: importDocument,
            openPath,
            openResult,
            save,
            close,
            persistCheckpoint,
            requestUnsavedDecision,
            resolveUnsavedDecision,
            runAfterUnsavedDecision,
            renderRecent,
            bind,
            dispose,
        });
    }

    window.ScriptoriumSession = Object.freeze({
        createSessionController,
    });
})();