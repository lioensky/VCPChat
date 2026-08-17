'use strict';

(() => {
    const nativeApi = window.scriptoriumAPI;
    const core = window.VDocCore;
    const containerModule = window.VDocContainer;
    const hybridCompiler = window.VDocHybridCompiler;
    const styleLibrary = window.VDocStyleLibrary;
    const pagination = window.VDocPagination;

    const requiredModules = {
        nativeApi,
        core,
        containerModule,
        hybridCompiler,
        styleLibrary,
        pagination,
        settings: window.ScriptoriumSettings,
        documentStore: window.ScriptoriumDocumentStore,
        flowAdapter: window.ScriptoriumFlowAdapter,
        deckAdapter: window.ScriptoriumDeckAdapter,
        selection: window.ScriptoriumDomSelection,
        flowEditor: window.ScriptoriumFlowEditor,
        deckEditor: window.ScriptoriumDeckEditor,
        formatting: window.ScriptoriumFormatting,
        primitives: window.ScriptoriumRenderPrimitives,
        svgAssetLibrary: window.VDocSvgAssetLibrary,
        svgAssets: window.ScriptoriumSvgAssets,
        renderedText: window.ScriptoriumRenderedText,
        flowRenderer: window.ScriptoriumFlowRenderer,
        deckRenderer: window.ScriptoriumDeckRenderer,
        renderCoordinator: window.ScriptoriumRenderCoordinator,
        history: window.ScriptoriumEditHistory,
        flowExport: window.ScriptoriumFlowExport,
        deckExport: window.ScriptoriumDeckExport,
        exportController: window.ScriptoriumExport,
        media: window.ScriptoriumMedia,
        find: window.ScriptoriumFind,
        navigation: window.ScriptoriumNavigation,
        styleUi: window.ScriptoriumStyleUi,
        lineageStore: window.ScriptoriumLineageStore,
        lineageUi: window.ScriptoriumLineageUi,
        prDiff: window.ScriptoriumPrDiff,
        agentPort: window.ScriptoriumAgentPort,
        runtime: window.ScriptoriumRuntime,
        networkFonts: window.ScriptoriumNetworkFonts,
        sourceEditor: window.ScriptoriumSourceEditor,
        library: window.ScriptoriumLibrary,
        session: window.ScriptoriumSession,
        shell: window.ScriptoriumShell,
    };

    const missing = Object.entries(requiredModules)
        .filter(([, value]) => !value)
        .map(([name]) => name);
    if (missing.length) {
        throw new Error(
            `Scriptorium modules are unavailable: ${missing.join(', ')}`
        );
    }

    const persistencePort = Object.freeze({
        chooseOpen: () => nativeApi.chooseOpen(),
        chooseImport: () => nativeApi.chooseImport(),
        readPath: (path) => nativeApi.readPath(path),
        readExternalResource: (payload) =>
            nativeApi.readExternalResource(payload),
        resolveFontStylesheet: (payload) =>
            nativeApi.resolveFontStylesheet(payload),
        resolveFontUrl: (payload) =>
            nativeApi.resolveFontUrl(payload),
        save: (payload) => nativeApi.save(payload),
        exportRichDocument: (payload) =>
            nativeApi.exportRichDocument(payload),
        listDocumentLibrary: () =>
            nativeApi.listDocumentLibrary(),
        listRecent: () => nativeApi.listRecent(),
        loadStylePacks: () =>
            nativeApi.loadStylePacks?.() || [],
        saveStylePacks: (packs) =>
            nativeApi.saveStylePacks?.(packs),
        loadSvgAssetPacks: () =>
            nativeApi.loadSvgAssetPacks?.() || [],
        saveSvgAssetPacks: (packs) =>
            nativeApi.saveSvgAssetPacks?.(packs),
        listSystemFonts: (force) => nativeApi.listSystemFonts(force),
        loadAgentsList: () => nativeApi.loadAgentsList?.() || [],
        loadUserAvatar: () => nativeApi.loadUserAvatar?.() || null,
        loadAgentAvatar: (folderName) =>
            nativeApi.loadAgentAvatar?.(folderName) || null,
        getCurrentTheme: () => nativeApi.getCurrentTheme(),
        onThemeUpdated: (listener) =>
            nativeApi.onThemeUpdated(listener),
        onOpenPathRequest: (listener) =>
            nativeApi.onOpenPathRequest(listener),
        minimizeWindow: () => nativeApi.minimizeWindow(),
        maximizeWindow: () => nativeApi.maximizeWindow(),
        closeWindow: () => nativeApi.closeWindow(),
        windowReady: (payload) => nativeApi.windowReady(payload),
        onAgentCheckpointProposed: (listener) =>
            nativeApi.onAgentCheckpointProposed?.(listener),
        onAgentRequest: (listener) =>
            nativeApi.onAgentRequest?.(listener),
        respondAgentRequest: (payload) =>
            nativeApi.respondAgentRequest?.(payload),
    });

    const settingsPort =
        window.ScriptoriumSettings.createSettingsStore();

    const documentPort =
        window.ScriptoriumDocumentStore.createDocumentStore({
            core,
            containerModule,
            settingsPort,
        });

    let activeAdapter = null;
    let activeEditor = null;
    let renderPort = null;
    let sourcePort = null;
    let exportPort = null;
    let sessionPort = null;
    let libraryPort = null;
    let mediaPort = null;
    let findPort = null;
    let navigationPort = null;
    let formattingPort = null;
    let stylePort = null;
    let lineageUiPort = null;
    let prDiffPort = null;
    let agentPort = null;
    let objectPort = null;
    let svgAssetPort = null;
    let networkFontPort = null;
    let shell = null;
    let pathRequestDisposer = null;
    let agentRequestDisposer = null;
    let agentCheckpointDisposer = null;
    let initialized = false;
    let disposed = false;

    const editorResolver = () => activeEditor;
    const adapterResolver = () => activeAdapter;
    const notificationFacade = Object.freeze({
        show: (...args) =>
            shell?.notificationPort?.show?.(...args),
    });

    const renderFacade = Object.freeze({
        setAdapter: (...args) => renderPort?.setAdapter(...args),
        setMode: (...args) => renderPort?.setMode(...args),
        setZoom: (...args) => renderPort?.setZoom(...args) ?? 100,
        renderEdit: (...args) => renderPort?.renderEdit(...args),
        renderRead: (...args) => renderPort?.renderRead(...args),
        renderCurrent: (...args) => renderPort?.renderCurrent(...args),
        disposeSurface: (...args) => renderPort?.disposeSurface(...args),
        patchRegion: (...args) =>
            activeAdapter?.kind === 'flow'
                ? flowRenderer?.patchRegion?.(...args)
                : false,
        invalidate: (...args) => renderPort?.invalidate(...args),
        status: () => renderPort?.status?.() || null,
    });

    const editorFacade = Object.freeze({
        flush: (...args) => activeEditor?.flush?.(...args) ?? true,
        captureViewState: (...args) =>
            activeEditor?.captureViewState?.(...args) || null,
        restoreViewState: (...args) =>
            activeEditor?.restoreViewState?.(...args) ?? false,
        disposeSurface: (...args) =>
            activeEditor?.disposeSurface?.(...args),
    });

    function historyBranchKey() {
        const mode = shell?.surfacePort?.mode?.() || 'edit';
        if (activeAdapter?.kind !== 'deck') {
            return `${mode}|flow|document`;
        }
        if (mode === 'source-css') return `${mode}|deck|global-css`;
        const slideId = activeAdapter.activeSlide?.()?.id
            || `index-${activeAdapter.activeSlideIndex?.() ?? 0}`;
        return `${mode}|deck|slide:${encodeURIComponent(slideId)}`;
    }

    function restoreHistorySnapshot(serialized, branchKey) {
        const captured = core.parse(serialized);
        if (activeAdapter?.kind !== 'deck') return captured;

        const current = documentPort.document();
        if (!current) return captured;
        const merged = core.parse(core.serialize(current));
        if (branchKey === 'source-css|deck|global-css') {
            merged.source.deckCss = String(captured.source?.deckCss || '');
            return merged;
        }

        const encodedSlideId = String(branchKey || '')
            .match(/\|deck\|slide:(.*)$/)?.[1];
        const slideId = encodedSlideId
            ? decodeURIComponent(encodedSlideId)
            : '';
        const capturedSlide = (captured.source?.slides || []).find(
            (slide) => slide.id === slideId
        );
        const currentIndex = (merged.source?.slides || []).findIndex(
            (slide) => slide.id === slideId
        );
        if (capturedSlide && currentIndex >= 0) {
            merged.source.slides[currentIndex] =
                JSON.parse(JSON.stringify(capturedSlide));
        }
        return merged;
    }

    const historyPort = window.ScriptoriumEditHistory.createEditHistory({
        documentPort,
        core,
        editorPort: editorFacade,
        adapterResolver,
        renderPort: renderFacade,
        branchKeyResolver: historyBranchKey,
        restoreSnapshot: restoreHistorySnapshot,
        onChange: () => formattingPort?.syncHistoryControls?.(),
    });

    const lineagePort =
        window.ScriptoriumLineageStore.createLineageStore({
            documentPort,
            core,
        });

    const renderedTextPort =
        window.ScriptoriumRenderedText.createRenderedTextController({
            historyPort,
            notificationPort: notificationFacade,
            // 延迟读取，避免在 visibilityPort 声明前触发词法作用域暂存死区；
            // 编辑事件发生时该端口已经完成初始化。
            getVisibilityPort: () => visibilityPort,
        });

    const runtimePort =
        window.ScriptoriumRuntime.createRuntimeController({
            documentPort,
        });

    const visibilityObservers = new Map();
    const visibilityPort = Object.freeze({
        pause(surface) {
            if (!surface) return false;
            window.ScriptoriumVisibility.pause(surface);
            return true;
        },
        resume(surface) {
            if (!surface) return false;
            window.ScriptoriumVisibility.resume(surface);
            return true;
        },
        isPaused(surface) {
            return Boolean(
                surface
                && window.ScriptoriumVisibility.isPaused(surface)
            );
        },
        observe(root, host, options = {}) {
            const previous = visibilityObservers.get(root);
            previous?.disconnect?.();
            const observer = window.ScriptoriumVisibility.observePages(
                root,
                host,
                options
            );
            visibilityObservers.set(root, observer);
            return observer;
        },
        disconnect(root) {
            visibilityObservers.get(root)?.disconnect?.();
            visibilityObservers.delete(root);
        },
        dispose() {
            visibilityObservers.forEach((observer) =>
                observer.disconnect?.()
            );
            visibilityObservers.clear();
        },
    });

    const primitives =
        window.ScriptoriumRenderPrimitives.createRenderPrimitives({
            core,
            styleLibrary,
            hybridCompiler,
            settingsPort,
            resourceResolver: () => documentPort.resourceResolver(),
        });

    const flowAdapter =
        window.ScriptoriumFlowAdapter.createFlowAdapter({
            documentPort,
            core,
            hybridCompiler,
            onInvalidate: () =>
                renderFacade.invalidate('flow-adapter-invalidated'),
        });

    const deckAdapter =
        window.ScriptoriumDeckAdapter.createDeckAdapter({
            documentPort,
            core,
            onActiveSlideChange: () => {
                renderFacade.invalidate('active-slide-changed');
                historyPort.activate(undefined, {
                    reason: 'active-slide-changed',
                });
                if (initialized) {
                    renderFacade.renderEdit({ force: true });
                    navigationPort?.render?.();
                    sourcePort?.refresh?.();
                }
            },
        });

    let flowRenderer = null;
    let deckRenderer = null;

    const flowEditor =
        window.ScriptoriumFlowEditor.createFlowEditor({
            adapter: flowAdapter,
            documentPort,
            selectionPrimitives: window.ScriptoriumDomSelection,
            hybridCompiler,
            historyPort,
            renderPort: renderFacade,
            mediaPort: {
                open: () => mediaPort?.open?.(),
            },
            notificationPort: notificationFacade,
            onSelectionChange: () =>
                formattingPort?.scheduleSync?.(),
            onContextMenu: (input) =>
                formattingPort?.openContextMenu?.(input),
            isContextMenuOpen: () =>
                formattingPort?.contextMenuOpen?.() === true,
        });

    const deckEditor =
        window.ScriptoriumDeckEditor.createDeckEditor({
            adapter: deckAdapter,
            documentPort,
            selectionPrimitives: window.ScriptoriumDomSelection,
            core,
            historyPort,
            notificationPort: notificationFacade,
            restoreSemantics: primitives.restoreMathSemantics,
            mediaPort: {
                open: () => mediaPort?.open?.(),
            },
            onSelectionChange: () =>
                formattingPort?.scheduleSync?.(),
            onFormattingTarget: (target) =>
                formattingPort?.scheduleSync?.(target),
        });

    const objectFacade = Object.freeze({
        bindRoot: (...args) => objectPort?.bindRoot?.(...args),
        clearSelection: (...args) =>
            objectPort?.clearSelection?.(...args),
    });

    flowRenderer =
        window.ScriptoriumFlowRenderer.createFlowRenderer({
            primitives,
            pagination,
            documentPort,
            editorPort: flowEditor,
            objectPort: objectFacade,
            renderedTextPort,
            runtimePort,
            visibilityPort,
            adapter: flowAdapter,
        });

    deckRenderer =
        window.ScriptoriumDeckRenderer.createDeckRenderer({
            primitives,
            pagination,
            documentPort,
            core,
            editorPort: deckEditor,
            objectPort: objectFacade,
            renderedTextPort,
            runtimePort,
            visibilityPort,
            escapeHtml(value) {
                return String(value || '').replace(
                    /[&<>"']/g,
                    (character) =>
                        `&#${character.charCodeAt(0)};`
                );
            },
        });

    const flowExporter =
        window.ScriptoriumFlowExport.createFlowExporter({
            documentPort,
            primitives,
            pagination,
        });

    const deckExporter =
        window.ScriptoriumDeckExport.createDeckExporter({
            documentPort,
            core,
            primitives,
            pagination,
        });

    flowAdapter
        .attachEditor(flowEditor)
        .attachRenderer(flowRenderer)
        .attachExporter(flowExporter);
    deckAdapter
        .attachEditor(deckEditor)
        .attachRenderer(deckRenderer)
        .attachExporter(deckExporter);

    function resolveAdapter(documentModel = documentPort.document()) {
        return documentModel?.manifest?.scene?.kind
            === core.PROJECT_KINDS.SLIDE_DECK
            ? deckAdapter
            : flowAdapter;
    }

    function activateAdapter(adapter) {
        if (!adapter) return null;
        activeEditor?.flush?.();
        activeAdapter?.disposeSurface?.();
        activeAdapter = adapter;
        activeEditor = adapter.kind === 'deck'
            ? deckEditor
            : flowEditor;
        if (adapter.kind === 'deck') {
            deckAdapter.resetActiveSlide();
        }
        renderPort?.setAdapter(adapter);
        sourcePort?.setAdapter(adapter);
        exportPort?.setAdapter(adapter);
        mediaPort?.setAdapter(adapter);
        navigationPort?.setAdapter(adapter);
        formattingPort?.setEditorPort(activeEditor);
        stylePort?.setEditorPort(activeEditor);
        lineageUiPort?.setAdapter(adapter);
        return adapter;
    }

    function mutateObject(mutation) {
        if (!activeAdapter || !mutation?.objectId) return false;
        const result = window.ScriptoriumObjects.applyMutationToSource(
            activeAdapter.currentSource(),
            mutation,
            activeAdapter.kind === 'deck'
        );
        if (!result.changed) return false;
        activeAdapter.replaceCurrentSource(result.source, {
            reason: `object-${mutation.type}`,
        });
        historyPort.capture({ reason: `object-${mutation.type}` });
        renderFacade.invalidate('object-mutated');
        renderFacade.renderEdit({ force: true });
        return true;
    }

    function insertObject(node) {
        if (!node || !activeAdapter) return false;
        window.ScriptoriumObjects.normalizeObjectNode(
            node,
            activeAdapter.kind === 'deck'
        );
        const offset = activeAdapter.kind === 'flow'
            ? activeEditor?.insertionOffset?.()
            : undefined;
        const inserted = activeAdapter.insertContent(node.outerHTML, {
            reason: 'object-inserted',
            ...(Number.isFinite(offset) ? { offset } : {}),
        });
        if (!inserted) return false;
        historyPort.capture({ reason: 'object-inserted' });
        renderFacade.invalidate('object-inserted');
        renderFacade.renderEdit({ force: true });
        return true;
    }

    const sessionFacade = Object.freeze({
        create: (...args) => sessionPort?.create(...args),
        createDeck: (...args) => sessionPort?.createDeck(...args),
        showHome: (...args) => sessionPort?.showHome(...args),
        open: (...args) => sessionPort?.open(...args),
        openPath: (...args) => sessionPort?.openPath(...args),
        import: (...args) => sessionPort?.import(...args),
        save: (...args) => sessionPort?.save(...args),
        close: (...args) => sessionPort?.close(...args),
    });
    const exportFacade = Object.freeze({
        execute: (...args) => exportPort?.execute(...args),
    });
    const findFacade = Object.freeze({
        open: (...args) => findPort?.open(...args),
        close: (...args) => findPort?.close(...args),
        refresh: (...args) => findPort?.refresh(...args),
    });
    const mediaFacade = Object.freeze({
        open: (...args) => mediaPort?.open(...args),
        close: (...args) => mediaPort?.close(...args),
    });
    const styleFacade = Object.freeze({
        close: (...args) => stylePort?.close(...args),
    });
    const metricsPort = Object.freeze({
        text() {
            const documentModel = documentPort.document();
            if (!documentModel) return '';
            const html = documentModel.manifest?.scene?.kind
                === core.PROJECT_KINDS.SLIDE_DECK
                ? (documentModel.source?.slides || [])
                    .map((slide) => core.splitSlideSource(slide.source).html)
                    .join('\n')
                : hybridCompiler.compile(
                    String(documentModel.source?.content || ''),
                    { sanitizeHtml: core.sanitizeHtml }
                ).html;
            const template = document.createElement('template');
            template.innerHTML = html;
            return template.content.textContent || '';
        },
    });

    shell = window.ScriptoriumShell.createShell({
        core,
        documentPort,
        persistencePort,
        renderPort: renderFacade,
        sourcePort: {
            editor: () => sourcePort?.editor?.() || null,
            open: (...args) => sourcePort?.open(...args),
            apply: (...args) => sourcePort?.apply(...args),
            format: (...args) => sourcePort?.format(...args),
        },
        sessionPort: sessionFacade,
        exportPort: exportFacade,
        historyPort,
        findPort: findFacade,
        mediaPort: mediaFacade,
        stylePort: styleFacade,
        metricsPort,
        settingsPort,
        editorResolver,
        bindElements,
        onInitialize,
    });

    function bindElements(elements, notificationPort, surfacePort) {
        renderPort =
            window.ScriptoriumRenderCoordinator.createRenderCoordinator({
            documentPort,
            primitives,
            runtimePort,
            editorPort: flowEditor,
            editHost: elements['page-stream'],
                readHost: elements['read-page-stream'],
                editScrollHost: elements['render-host'],
                readScrollHost: elements['read-host'],
                onRendered: () => navigationPort?.render?.(),
            });

        networkFontPort =
            window.ScriptoriumNetworkFonts.createNetworkFontController({
                documentPort,
                containerModule,
                persistencePort,
                notificationPort,
                settingsPort,
            });

        sourcePort =
            window.ScriptoriumSourceEditor.createSourceEditorController({
                core,
                hybridCompiler,
                documentPort,
                elements,
                notificationPort,
                historyPort,
                renderPort: renderFacade,
                networkFontPort,
                getAdapter: adapterResolver,
            });
        sourcePort.initialize();

        exportPort =
            window.ScriptoriumExport.createExportController({
                documentPort,
                persistencePort,
                exportResourcesModule:
                    window.ScriptoriumExportResources,
                containerModule,
                notificationPort,
                editorPort: editorFacade,
                historyPort,
                surfacePort,
                getAdapter: adapterResolver,
            });

        mediaPort =
            window.ScriptoriumMedia.createMediaController({
                elements,
                documentPort,
                containerModule,
                notificationPort,
                getAdapter: adapterResolver,
                hash: hybridCompiler.simpleHash,
            });

        findPort =
            window.ScriptoriumFind.createFindController({
                elements,
                surfacePort,
                getAdapter: adapterResolver,
            });

        const flowNavigation =
            window.ScriptoriumNavigation
                .createFlowNavigationStrategy({ surfacePort });
        const deckNavigation =
            window.ScriptoriumNavigation
                .createDeckNavigationStrategy({
                    renderer: deckRenderer,
                    renderPort: renderFacade,
                    sourcePort,
                });
        navigationPort =
            window.ScriptoriumNavigation.createNavigationController({
                elements,
                strategies: {
                    flow: flowNavigation,
                    deck: deckNavigation,
                },
                renderPort: renderFacade,
                getAdapter: adapterResolver,
            });

        formattingPort =
            window.ScriptoriumFormatting.createFormattingController({
                elements,
                notificationPort,
                historyPort,
                getEditorPort: editorResolver,
            });

        stylePort =
            window.ScriptoriumStyleUi.createStyleUiController({
                elements,
                styleLibrary,
                persistencePort,
                notificationPort,
                getEditorPort: editorResolver,
                onStyleUsed(style) {
                    documentPort.mutate((model) => {
                        const ids = new Set(
                            model.manifest.styleDependencies || []
                        );
                        ids.add(style.id);
                        model.manifest.styleDependencies = [...ids];
                        model.manifest.embeddedStyles = [...ids]
                            .map((id) => styleLibrary.get(id))
                            .filter(Boolean);
                    }, { reason: 'advanced-style-used' });

                    // 局部文字补丁只会更新内容节点，不会重建 Shadow DOM
                    // 中的样式表。样式依赖写入后强制刷新编辑面，确保首次
                    // 使用的高级样式无需手动刷新即可立即获得对应 CSS。
                    renderFacade.invalidate('advanced-style-used');
                    renderFacade.renderEdit({ force: true });
                },
            });

        libraryPort =
            window.ScriptoriumLibrary.createLibraryController({
                elements,
                persistencePort,
                openPath: (filePath) =>
                    sessionFacade.openPath(filePath),
            });

        sessionPort =
            window.ScriptoriumSession.createSessionController({
                documentPort,
                persistencePort,
                containerModule,
                core,
                elements,
                notificationPort,
                renderPort: renderFacade,
                surfacePort,
                sourcePort,
                networkFontPort,
                historyPort,
                lineagePort,
                navigationPort,
                lineageUiPort,
                libraryPort,
                editorResolver,
                getAdapter: adapterResolver,
                resolveAdapter,
                activateAdapter,
            });

        prDiffPort =
            window.ScriptoriumPrDiff.createPrDiffController({
                elements,
                getAdapter: adapterResolver,
            });

        const reviewFacade = Object.freeze({
            open: (record) => lineageUiPort?.openReview?.(record),
        });
        lineageUiPort =
            window.ScriptoriumLineageUi.createLineageUiController({
                elements,
                lineagePort,
                documentPort,
                notificationPort,
                identityPort: {
                    loadAgentsList: () =>
                        persistencePort.loadAgentsList(),
                    loadUserAvatar: () =>
                        persistencePort.loadUserAvatar(),
                    loadAgentAvatar: (folderName) =>
                        persistencePort.loadAgentAvatar(folderName),
                },
                historyPort,
                renderPort: renderFacade,
                editorResolver,
                getAdapter: adapterResolver,
                resolveAdapter,
                activateAdapter,
                prDiffPort,
                reviewPort: reviewFacade,
                getAgentPort: () => agentPort,
                persist: (reason) =>
                    sessionPort.persistCheckpoint(reason),
            });

        agentPort =
            window.ScriptoriumAgentPort.createAgentController({
                documentPort,
                lineagePort,
                core,
                containerModule,
                hybridCompiler,
                styleLibrary,
                svgAssetLibrary: window.VDocSvgAssetLibrary,
                programmableContent: window.ScriptoriumProgrammableContent,
                prDiff: window.ScriptoriumPrDiff,
                historyPort,
                renderPort: renderFacade,
                surfacePort: shell.surfacePort,
                getAdapter: adapterResolver,
                persist: (reason) =>
                    sessionPort.persistCheckpoint(reason),
                onStyleLibraryChange: async () => {
                    await stylePort.persist();
                    renderFacade.invalidate('style-library-changed');
                    renderFacade.renderCurrent({ force: true });
                },
                persistSvgAssets: () =>
                    persistencePort.saveSvgAssetPacks(
                        window.VDocSvgAssetLibrary.exportUserPacks()
                    ),
            });
        window.ScriptoriumAgent = agentPort;

        objectPort =
            window.ScriptoriumObjects.createObjectController({
                elements,
                getRoot: () => shell.surfacePort.editRoot(),
                getZoom: () => renderPort.status().zoom,
                layoutPort: Object.freeze({
                    mode: () => activeAdapter?.kind === 'deck'
                        ? 'free-canvas'
                        : 'flow',
                }),
                canInsert: () =>
                    documentPort.status().ready
                    && shell.surfacePort.mode() === 'edit',
                insertObject,
                commitMutation: mutateObject,
            });

        svgAssetPort =
            window.ScriptoriumSvgAssets.createSvgAssetController({
                elements,
                library: window.VDocSvgAssetLibrary,
                objects: window.ScriptoriumObjects,
                persistencePort,
                notificationPort,
                canInsert: () =>
                    documentPort.status().ready
                    && shell.surfacePort.mode() === 'edit',
                freeCanvas: () => activeAdapter?.kind === 'deck',
                insertObject,
            });

        [
            sessionPort,
            libraryPort,
            mediaPort,
            findPort,
            navigationPort,
            formattingPort,
            stylePort,
            lineageUiPort,
            svgAssetPort,
        ].forEach(shell.register);
    }

    async function loadFonts() {
        const elements = shell.elements;
        try {
            const fonts = await persistencePort.listSystemFonts();
            [
                elements['font-family-select'],
                elements['selection-font-family'],
            ].forEach((select) => {
                if (!select) return;
                select.replaceChildren(...fonts.map((font) => {
                    const option = document.createElement('option');
                    option.value = font;
                    option.textContent = font;
                    option.style.fontFamily = `"${font}"`;
                    return option;
                }));
            });
            elements['font-status'].textContent =
                `${fonts.length} 种系统字体可用`;
        } catch {
            if (elements['font-status']) {
                elements['font-status'].textContent =
                    '系统字体读取失败';
            }
        }
    }

    async function onInitialize() {
        pathRequestDisposer = persistencePort.onOpenPathRequest(
            (path) => sessionPort.openPath(path)
        );
        agentRequestDisposer = persistencePort.onAgentRequest(
            async (request) => {
                const requestId = request?.requestId;
                try {
                    const endpoint = request?.endpoint === 'current'
                        || !request?.endpoint
                        ? agentPort.current()
                        : agentPort[request.endpoint];
                    const method = endpoint?.[request?.method];
                    if (typeof method !== 'function') {
                        throw new Error(
                            `未知 Agent 方法：${request?.method || '—'}`
                        );
                    }
                    const result = await method(request.payload || {});
                    persistencePort.respondAgentRequest({
                        requestId,
                        result,
                    });
                } catch (error) {
                    persistencePort.respondAgentRequest({
                        requestId,
                        error: {
                            code: 'AGENT_REQUEST_FAILED',
                            message: error.message,
                        },
                    });
                }
            }
        );
        agentCheckpointDisposer =
            persistencePort.onAgentCheckpointProposed((payload) => {
                if (!payload) return;
                lineagePort.add({
                    ...payload,
                    source: 'agent',
                    status: payload.status || 'applied',
                });
                sessionPort.persistCheckpoint('AI 刻点');
            });
        await Promise.all([
            loadFonts(),
            sessionPort.renderRecent(),
            libraryPort.refresh(),
            stylePort.initialize(),
            svgAssetPort.initialize(),
        ]);
        initialized = true;
    }

    function dispose() {
        if (disposed) return;
        activeEditor?.flush?.();
        historyPort.finalize({ force: true });
        pathRequestDisposer?.();
        agentRequestDisposer?.();
        agentCheckpointDisposer?.();
        visibilityPort.dispose();
        objectPort?.dispose?.();
        networkFontPort?.dispose?.();
        renderedTextPort.dispose();
        shell.dispose();
        runtimePort.dispose();
        agentPort?.dispose?.();
        renderPort?.dispose?.();
        flowEditor.dispose();
        deckEditor.dispose();
        flowAdapter.dispose();
        deckAdapter.dispose();
        historyPort.dispose();
        lineagePort.dispose();
        documentPort.dispose();
        settingsPort.dispose();
        disposed = true;
    }

    window.addEventListener('beforeunload', dispose, { once: true });
    document.addEventListener('DOMContentLoaded', () => {
        shell.initialize().catch((error) => {
            console.error('[Scriptorium] Initialization failed:', error);
            shell.notificationPort.show(
                `Scriptorium 初始化失败：${error.message}`,
                'error',
                8000
            );
        });
    }, { once: true });
})();