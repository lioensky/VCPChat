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

    // .html opens as a web page (uttu-scriptorium-page.js), not imported. The main process answers
    // kind 'web-page' for it; openPath routes it before the unsaved-changes question (the document behind stays as is).
    // PDF and tables open the same way (kind 'overlay'); every such view is registered on UTTUScriptoriumUI.
    const uttuPageTook = async (result) => {
        if (result?.kind !== 'web-page' && result?.kind !== 'overlay') return false;
        if (result.asText) window.UTTUScriptoriumTypes?.markText(result.filePath);
        await window.UTTUScriptoriumUI?.routeOverlay?.(result.filePath);
        return true;
    };
    const uttuRoute = (path) => window.UTTUScriptoriumUI?.routeOverlay?.(path) ?? null;
    const persistencePort = Object.freeze({
        chooseOpen: async () => { // same first paint as readPath below
            const result = await nativeApi.chooseOpen();
            if (await uttuPageTook(result)) return { success: false };
            await window.UTTUScriptoriumMarkdown?.firstPaint?.(result);
            return result;
        },
        chooseImport: () => nativeApi.chooseImport(),
        // a large .md shows its opening first (uttu-scriptorium-markdown.js firstPaint)
        readPath: async (path) => {
            const result = await nativeApi.readPath(path);
            if (await uttuPageTook(result)) return { success: false };
            await window.UTTUScriptoriumMarkdown?.firstPaint?.(result);
            return result;
        },
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
    let sourceRightPort = null;
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
            // .md 里的相对图片按文件所在文件夹换成本机地址（uttu-scriptorium-markdown.js）。
            resourceResolver: () => window.UTTUScriptoriumMarkdown?.resolver?.(documentPort.resourceResolver())
                ?? documentPort.resourceResolver(),
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
            onTransaction: () =>
                navigationPort?.render?.(),
            onSelectionChange: () =>
                formattingPort?.scheduleSync?.(),
            onContextMenu: (input) =>
                formattingPort?.openContextMenu?.(input),
            onIslandContextMenu: (input) => {
                const islandId = String(
                    input?.island?.dataset?.vdocIsland || ''
                );
                if (!islandId || activeAdapter?.kind !== 'flow') return false;
                const compiled = activeAdapter.compile();
                const island = compiled.islands?.find(
                    (candidate) => candidate.id === islandId
                );
                if (!island?.sourceRange) return false;
                return shell?.showIslandContextMenu?.(
                    input.event.clientX,
                    input.event.clientY,
                    {
                        islandId,
                        sourceOffset: island.sourceRange.start,
                    }
                ) || false;
            },
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

    function activateAdapter(adapter, options = {}) {
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
        sourceRightPort?.setAdapter(adapter);
        exportPort?.setAdapter(adapter);
        mediaPort?.setAdapter(adapter);
        navigationPort?.setAdapter(adapter, null, options); // renderFollows
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
        openPath: (...args) => window.UTTUScriptoriumUI.noteOpen(args[0], uttuRoute(args[0]) ?? sessionPort?.openPath(...args)), // web pages
        import: (...args) => sessionPort?.import(...args),
        save: (...args) => sessionPort?.save(...args),
        close: (...args) => sessionPort?.close(...args),
    });
    // 扩展层延后读工作面时页面可能已释放（渲染协调器会抛错），读不到就当没有。
    function quiet(read) {
        try {
            return read() || null;
        } catch (_) {
            return null;
        }
    }
    // 文坊的 扩展层（uttu-scriptorium.js）用选好的版式、样式和起步模板新建文档，或给当前文稿换样式和版式。
    // 名字不能用 ScriptoriumSession：上游的会话模块占着这个全局，覆盖了文坊初始化会中断。
    window.UTTUScriptoriumSession = Object.freeze({
        create: sessionFacade.create,
        syncFocus: () => shell?.syncFocusModeControls(), // 视图开关时重新判断能不能专注
        // 文库（左侧面板）：读目录、打开一份。
        openPath: sessionFacade.openPath,
        listLibrary: () => persistencePort.listDocumentLibrary(),
        // 文库管理（改名、复制一份、移到回收站、在文件夹里显示、临时转正式），主进程只认文库目录里的文档。
        libraryAction: (payload) => nativeApi?.libraryAction?.(payload),
        current() {
            const status = documentPort.status();
            const model = status.ready ? documentPort.document() : null;
            if (!model) return null;
            return Object.freeze({
                kind: model.manifest.scene.kind,
                filePath: status.currentPath || null,
                dirty: status.dirty,
                saving: status.saving,
                revision: status.revision,
                // +1 each time a document is opened, the same file reopened included (not on edits or saves)
                generation: status.generation,
                documentCss: String(model.source?.documentCss || ''),
                paginationMode: model.manifest.scene.pagination?.mode || 'flow',
                defaultCss: core.createDocument().source.documentCss,
                // 从 .md 打开的文档：所在文件夹、相对图片能读到的范围（modules/uttu/markdownFiles）。
                markdownFile: model.manifest.uttu?.markdownFile || null,
            });
        },
        restyle({ documentCss, paginationMode } = {}) {
            if (!documentPort.status().ready) return false;
            const result = documentPort.mutate((model) => {
                if (model.manifest.scene.kind === core.PROJECT_KINDS.SLIDE_DECK) return false;
                if (typeof documentCss === 'string') model.source.documentCss = core.sanitizeCss(documentCss);
                if (paginationMode) {
                    model.manifest.scene = core.createSceneConfig({
                        ...model.manifest.scene,
                        pagination: { mode: paginationMode },
                    });
                }
                return true;
            }, { reason: 'uttu-restyle' });
            if (result) historyPort.capture?.({ reason: 'uttu-restyle' });
            renderFacade.invalidate('uttu-restyle');
            renderFacade.renderCurrent({ force: true });
            return result;
        },
        // 第二版布局要的几个口子。
        // 工作面：edit / read / source-html / source-css；双栏时编辑面和阅读面同时显示。
        // 读的几个口子在页面关掉、渲染协调器释放以后返回 null，不抛错（扩展层有延后执行的量尺寸）。
        surface: () => quiet(() => shell?.surfacePort?.mode?.()),
        switchSurface: (mode, options) => shell?.surfacePort?.switchMode?.(mode, options) ?? false,
        editRoot: () => quiet(() => shell?.surfacePort?.editRoot?.()),
        readRoot: () => quiet(() => shell?.surfacePort?.readRoot?.()),
        // 源码面的 CodeMirror：挪了位置、改了大小以后要 refresh，不然行号栏宽度算错、盖住正文。
        sourceEditor: () => quiet(() => shell?.surfacePort?.sourceEditor?.()),
        // 画阅读面当预览，但不改当前工作面：渲染协调器画完阅读面会把自己的模式记成 read，这里改回去。
        renderPreview(options = {}) {
            if (!documentPort.status().ready) return false;
            const mode = renderFacade.status()?.mode || 'edit';
            try {
                renderFacade.renderRead({ force: options.force === true });
            } finally {
                if (mode !== 'read') renderFacade.setMode(mode);
            }
            return true;
        },
        zoom: () => renderFacade.status()?.zoom || 100,
        setZoom: (value) => renderFacade.setZoom(value),
        subscribe: (listener) => documentPort.subscribe('*', listener),
        // 文稿源码（Markdown 混合源码）。改完重画当前工作面，源码编辑器也从模型重新载入。
        source() {
            const model = documentPort.status().ready ? documentPort.document() : null;
            return model && model.manifest.scene.kind !== core.PROJECT_KINDS.SLIDE_DECK ? String(model.source.content || '') : null;
        },
        replaceSource(next, reason = 'uttu-source') {
            if (typeof next !== 'string' || !documentPort.status().ready) return false;
            editorFacade.flush();
            const changed = documentPort.mutate((model) => {
                if (model.manifest.scene.kind === core.PROJECT_KINDS.SLIDE_DECK) return false;
                if (model.source.content === next) return false;
                model.source.content = next;
                return true;
            }, { reason });
            if (!changed) return false;
            historyPort.capture?.({ reason });
            renderFacade.invalidate(reason);
            const mode = shell?.surfacePort?.mode?.() || 'edit';
            shell?.surfacePort?.switchMode?.(mode, { force: true });
            return true;
        },
        // 格式命令（粗体、列表、对齐……）走上游格式控制器，和功能区按钮同一条路。
        format: (command, value, options = {}) =>
            formattingPort?.execute?.(command, value, { preferSaved: true, ...options }) ?? false,
        // 在光标处插入一段 Markdown（插入菜单、空行打 /）。replaceBefore：光标前面刚打的“/查询词”一起去掉。
        insertMarkdown(markdown, options = {}) {
            const text = String(markdown || '').trim();
            if (!text || !documentPort.status().ready || activeAdapter?.kind !== 'flow') return false;
            editorFacade.flush();
            let offset = Number(activeEditor?.insertionOffset?.());
            const before = String(options.replaceBefore || '');
            const changed = documentPort.mutate((model) => {
                const source = String(model.source.content || '');
                if (!Number.isFinite(offset)) offset = source.length;
                offset = Math.max(0, Math.min(source.length, offset));
                let start = offset;
                if (before && source.slice(offset - before.length, offset) === before) start = offset - before.length;
                const head = source.slice(0, start).replace(/[ \t]+$/, '');
                const tail = source.slice(offset);
                const lead = !head || /\n\s*\n$/.test(head) ? '' : (/\n$/.test(head) ? '\n' : '\n\n');
                const trail = !tail || /^\s*\n\s*\n/.test(tail) ? '' : (/^\n/.test(tail) ? '\n' : '\n\n');
                model.source.content = `${head}${lead}${text}${trail}${tail}`;
                return true;
            }, { reason: 'uttu-insert' });
            if (!changed) return false;
            historyPort.capture?.({ reason: 'uttu-insert' });
            renderFacade.invalidate('uttu-insert');
            renderFacade.renderEdit({ force: true });
            return true;
        },
        insertionOffset: () => activeEditor?.insertionOffset?.() ?? null,
        // 把光标放回源码里这个位置。弹窗抢走焦点后，编辑中的那一段已经收起。
        focusOffset(offset) {
            const view = activeEditor?.captureViewState?.();
            return view ? activeEditor.restoreViewState({ ...view, sourceOffset: offset, focused: true }) : false;
        },
        // 编辑面里选中的文字在源码里的位置（加链接用）；没选中、跨块时为 null。
        sourceSelection() {
            const selection = activeEditor?.sourceSelection?.();
            return selection ? { start: selection.sourceStart, end: selection.sourceEnd, text: selection.selected } : null;
        },
        // 批注存在 manifest.uttu.comments（vdoc-core 的 normalizeDocument 保留 manifest.uttu）。
        comments() {
            const model = documentPort.status().ready ? documentPort.document() : null;
            const list = model?.manifest?.uttu?.comments;
            return Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : [];
        },
        setComments(list) {
            if (!documentPort.status().ready || !Array.isArray(list)) return false;
            const changed = documentPort.mutate((model) => {
                model.manifest.uttu = { ...(model.manifest.uttu || {}), comments: JSON.parse(JSON.stringify(list)) };
                return true;
            }, { reason: 'uttu-comments' });
            // 撤销、重做按整份快照来回：批注不进快照的话，撤一步文字会把刚写的批注一起丢掉。
            if (changed) historyPort.capture?.({ reason: 'uttu-comments' });
            return changed;
        },
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
    // the word count compiled the whole document again on every status change (saving, activity,
    // each keystroke): over two seconds each time for a 1 MB Markdown file. A flow document now counts the compile its
    // surface already made for this revision (flow adapter compiled()); until there is one, text() answers null and the
    // shell asks again shortly (scriptorium-shell.js updateMetrics), and only text(true) still compiles by itself.
    // The text of one compile is kept, so status changes without an edit cost nothing.
    let metricsCompiled = null;
    let metricsText = '';
    const metricsPort = Object.freeze({
        text(compileIfNeeded = false) {
            const documentModel = documentPort.document();
            if (!documentModel) return '';
            const deck = documentModel.manifest?.scene?.kind === core.PROJECT_KINDS.SLIDE_DECK;
            if (!deck) {
                const compiled = activeAdapter?.kind === 'flow' ? activeAdapter.compiled?.() : null;
                if (!compiled && !compileIfNeeded) return null;
                if (compiled && compiled === metricsCompiled) return metricsText;
                const template = document.createElement('template');
                template.innerHTML = compiled ? compiled.html : hybridCompiler.compile(
                    String(documentModel.source?.content || ''),
                    { sanitizeHtml: core.sanitizeHtml }
                ).html;
                metricsCompiled = compiled;
                metricsText = template.content.textContent || '';
                return metricsText;
            }
            const html = (documentModel.source?.slides || [])
                .map((slide) => core.splitSlideSource(slide.source).html)
                .join('\n');
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
            valueForMode: (...args) => sourcePort?.valueForMode?.(...args) || '',
            revealOffset: (...args) => sourcePort?.revealOffset(...args),
        },
        sourceRightPort: {
            editor: () => sourceRightPort?.editor?.() || null,
            open: (...args) => sourceRightPort?.open(...args),
            syncFromModel: (...args) =>
                sourceRightPort?.syncFromModel?.(...args),
            valueForMode: (...args) =>
                sourceRightPort?.valueForMode?.(...args) || '',
            revealOffset: (...args) =>
                sourceRightPort?.revealOffset?.(...args),
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

        const rightElementMap = Object.freeze({
            'source-host': 'source-right-host',
            'source-editor': 'source-editor-right',
            'source-title': 'source-right-title',
            'source-description': 'source-right-description',
            'source-diagnostics': 'source-right-diagnostics',
        });
        const rightElements = new Proxy(elements, {
            get(target, property, receiver) {
                const mapped = rightElementMap[property] || property;
                return Reflect.get(target, mapped, receiver);
            },
        });
        sourceRightPort =
            window.ScriptoriumSourceEditor.createSourceEditorController({
                core,
                hybridCompiler,
                documentPort,
                elements: rightElements,
                notificationPort,
                historyPort,
                renderPort: renderFacade,
                networkFontPort,
                getAdapter: adapterResolver,
            });
        sourceRightPort.initialize();

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
                const current = select.value; // 列表可能在文档开好之后才到
                select.replaceChildren(...fonts.map((font) => {
                    const option = document.createElement('option');
                    option.value = font;
                    option.textContent = font;
                    option.style.fontFamily = `"${font}"`;
                    return option;
                }));
                if (current) select.value = current;
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

    // Agent 改一份 .md 之前，文脉里要有“改之前”那一版可以回溯。合入时记下的快照是
    // 改完的样子；第一次被改之前、或者用户自己改过还没记，最新一版快照和现在的正文对不上，就先记一版（快照是现在的样子）。
    // .md 的文脉存在 AppData（modules/uttu/markdownFiles uttu-md-lineage），关了重开还在。
    function keepBeforeAgentChange() {
        const model = documentPort.document();
        if (!model?.manifest?.uttu?.markdownFile) return;
        const latest = lineagePort.list().find((record) => record.snapshot);
        let latestSource = null;
        try { latestSource = latest ? JSON.parse(latest.snapshot)?.source?.content ?? null : null; } catch (_) { latestSource = null; }
        if (latestSource === String(model.source?.content ?? '')) return;
        lineagePort.add({ name: '改之前', summary: 'Agent 改之前的样子', source: 'human', status: 'applied' });
    }

    async function onInitialize() {
        pathRequestDisposer = persistencePort.onOpenPathRequest(
            (path) => sessionFacade.openPath(path) // through the facade, so a web page opens as one
        );
        agentRequestDisposer = persistencePort.onAgentRequest(
            async (request) => {
                const requestId = request?.requestId;
                try {
                    // 网页、PDF、表格开着时 Agent 命令答它们，不答藏在后面的文稿（uttu-scriptorium-agent.js）。
                    const uttuAnswer = await window.UTTUScriptoriumAgent?.answer(request);
                    if (uttuAnswer) {
                        persistencePort.respondAgentRequest({ requestId, result: uttuAnswer });
                        return;
                    }
                    const endpoint = request?.endpoint === 'current'
                        || !request?.endpoint
                        ? agentPort.current()
                        : agentPort[request.endpoint];
                    const method = endpoint?.[request?.method];
                    if (request?.method === 'submitSourcePr') keepBeforeAgentChange();
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
        void loadFonts(); // 字体列表只有字体菜单用，页面就绪不等它
        await Promise.all([
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
        sourceRightPort?.dispose?.();
        sourcePort?.dispose?.();
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