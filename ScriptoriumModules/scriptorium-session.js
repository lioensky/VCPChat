'use strict';

(() => {
    function createSessionController(context) {
        const {
            state,
            elements,
            api,
            core,
            containerModule,
            styleLibrary,
            asyncCoordinator,
            isSlideDeck,
            finalizeEditBurst,
            applySourceChanges,
            renderDocument,
            switchMode,
            captureSnapshot,
            markDirty,
            markSaved,
            updateIdentity,
            renderLineage,
            showToast,
        } = context;

        async function createEditor(documentModel = null, metadata = {}) {
            const generation = state.documentGeneration += 1;
            asyncCoordinator.invalidateLatest('document-open');
            state.saving = false;
            state.loading = true;
            elements['loading-state'].hidden = false;
            updateIdentity();

            try {
                const nextDocument = documentModel
                    ? core.normalizeDocument(documentModel)
                    : core.createDocument();
                if (generation !== state.documentGeneration) return false;

                state.resourceResolver?.revoke();
                state.resourceObjectUrls = new Map();
                state.documentResourceData = metadata.resourceData instanceof Map
                    ? metadata.resourceData
                    : new Map();
                state.document = nextDocument;
                state.resourceResolver = containerModule.createRuntimeResolver(
                    state.document,
                    state.documentResourceData,
                    state.resourceObjectUrls
                );
                state.currentPath = metadata.filePath || null;
                const projectExtension = core.extensionForKind(
                    state.document.manifest.scene.kind
                );
                const fallbackName = state.document.manifest.scene.kind
                    === core.PROJECT_KINDS.SLIDE_DECK
                    ? '未命名演示.vpptx'
                    : '未命名文稿.vdocx';
                state.currentName = metadata.name
                    || state.document.manifest.title
                    || fallbackName;
                if (!state.currentName.toLowerCase().endsWith(projectExtension)) {
                    state.currentName = `${
                        state.currentName.replace(/\.[^.]+$/, '')
                    }${projectExtension}`;
                }

                state.checkpoints = [...state.document.checkpoints];
                state.documentRevision = 0;
                state.previewRevision = -1;
                state.previewResult = null;

                const embeddedStyles = Array.isArray(
                    state.document.manifest.embeddedStyles
                )
                    ? state.document.manifest.embeddedStyles
                    : [];
                embeddedStyles.forEach((style) => {
                    styleLibrary.register(style, {
                        packId: `document.${state.document.manifest.id}`,
                        conflict: 'replace',
                    });
                });
                state.usedAdvancedStyleIds = new Set(
                    Array.isArray(state.document.manifest.styleDependencies)
                        ? state.document.manifest.styleDependencies.filter(
                            (styleId) => styleLibrary.get(styleId)
                        )
                        : []
                );

                state.ready = true;
                state.activeSlideIndex = 0;
                state.selectionRange = null;
                state.selectionText = '';
                state.selectionBlockIds = [];
                state.explicitBlockSelection = false;
                state.blockSelectionAnchorId = null;
                state.history = [];
                state.historyIndex = -1;

                elements['welcome-state'].hidden = true;
                elements['document-workspace'].hidden = false;
                const presentation = isSlideDeck();
                elements['read-mode-btn'].querySelector('span').textContent =
                    presentation ? '放映预览' : '阅读预览';
                elements['export-flow-html-btn'].title = presentation
                    ? '导出单文件演示 HTML'
                    : '导出连续流语义 HTML';
                elements['export-paged-html-btn'].title = presentation
                    ? '导出单文件演示 HTML'
                    : '导出逐页富文档 HTML';
                elements['export-paged-html-btn'].hidden = presentation;

                renderDocument();
                switchMode('render');
                captureSnapshot();
                markSaved();
                renderLineage();
                showToast(
                    documentModel ? 'VDOCX 已展开' : '共笔新稿已建立',
                    'success'
                );
                return true;
            } finally {
                if (generation === state.documentGeneration) {
                    state.loading = false;
                    elements['loading-state'].hidden = true;
                    updateIdentity();
                }
            }
        }

        async function openResult(result, intent = null) {
            if (
                !result?.success
                || (intent && !asyncCoordinator.isLatest(intent))
            ) {
                return false;
            }

            if (result.kind === 'imported') {
                const title = String(result.name || '导入文稿')
                    .replace(/\.[^.]+$/, '');
                const presentation = result.importedKind === 'pptx';
                const model = core.createDocument({
                    title,
                    kind: presentation
                        ? core.PROJECT_KINDS.SLIDE_DECK
                        : undefined,
                    source: presentation ? undefined : String(result.html || ''),
                    slides: presentation ? result.slides : undefined,
                    page: presentation ? result.page : undefined,
                });
                model.manifest.import = result.importMetadata || {
                    sourceFormat: result.importedKind,
                    sourceName: result.name,
                };
                const projectType = presentation ? 'VPPTX' : 'VDOCX';
                if (intent && !asyncCoordinator.isLatest(intent)) return false;

                const created = await createEditor(model, {
                    filePath: null,
                    name: `${title}${presentation ? '.vpptx' : '.vdocx'}`,
                    imported: true,
                });
                if (!created) return false;

                markDirty();
                const warningCount = model.manifest.import?.warnings?.length || 0;
                showToast(
                    warningCount
                        ? `已导入 ${result.importedKind.toUpperCase()} · ${
                            warningCount
                        } 条转换提示`
                        : `已导入 ${result.importedKind.toUpperCase()}，请保存为 ${
                            projectType
                        }`,
                    warningCount ? 'info' : 'success',
                    4200
                );
                return true;
            }

            const bytes = Uint8Array.from(result.bytes || []);
            const unpacked = await containerModule.unpack(bytes, core);
            if (intent && !asyncCoordinator.isLatest(intent)) return false;
            return createEditor(unpacked.document, {
                ...result,
                resourceData: unpacked.resourceData,
            });
        }

        function isCollectableExternalUrl(value) {
            return /^(?:file|https?):/i.test(String(value || '').trim());
        }

        function fontFaceUrls(css) {
            const urls = [];
            String(css || '').replace(/@font-face\s*\{[\s\S]*?\}/gi, (block) => {
                block.replace(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi,
                    (_match, doubleQuoted, singleQuoted, bare) => {
                        const url = doubleQuoted || singleQuoted || bare || '';
                        if (isCollectableExternalUrl(url)) urls.push(url);
                        return _match;
                    });
                return block;
            });
            return [...new Set(urls)];
        }

        function replaceFontFaceUrl(css, sourceUrl, replacement) {
            return String(css || '').replace(/@font-face\s*\{[\s\S]*?\}/gi, (block) =>
                block.replace(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi,
                    (match, doubleQuoted, singleQuoted, bare) => {
                        const url = doubleQuoted || singleQuoted || bare || '';
                        return url === sourceUrl ? `url("${replacement}")` : match;
                    })
            );
        }

        async function collectExternalResources() {
            if (!elements['collect-external-resources']?.checked) {
                return { collected: 0, retained: 0 };
            }
            const cache = new Map();
            const collectUrl = async (url, metadata = {}) => {
                if (!isCollectableExternalUrl(url)) return null;
                if (!cache.has(url)) {
                    cache.set(url, (async () => {
                        try {
                            const result = await api.readExternalResource({ url });
                            if (!result?.success || !result.collectable || !result.bytes) {
                                return { retained: true, reason: result?.reason || '资源不可收纳' };
                            }
                            const resource = await containerModule.registerResource(
                                state.document,
                                state.documentResourceData,
                                {
                                    bytes: Uint8Array.from(result.bytes),
                                    kind: result.category === 'fonts' ? 'font' : 'media',
                                    name: result.name,
                                    mime: result.mime,
                                    description: metadata.description,
                                    nativeWidth: metadata.nativeWidth,
                                    nativeHeight: metadata.nativeHeight,
                                    duration: metadata.duration,
                                    durationText: metadata.durationText,
                                }
                            );
                            return {
                                retained: false,
                                reference: containerModule.resourceReference(resource),
                            };
                        } catch (error) {
                            return { retained: true, reason: error.message };
                        }
                    })());
                }
                return cache.get(url);
            };

            const collectHtml = async (source) => {
                const template = document.createElement('template');
                template.innerHTML = String(source || '');
                let collected = 0;
                let retained = 0;
                const mediaNodes = [...template.content.querySelectorAll(
                    'img[src], video[src], audio[src], source[src]'
                )];
                for (const node of mediaNodes) {
                    const url = node.getAttribute('src') || '';
                    if (!isCollectableExternalUrl(url)) continue;
                    const figure = node.closest('figure');
                    const outcome = await collectUrl(url, {
                        description: node.getAttribute('description')
                            || figure?.getAttribute('description')
                            || node.getAttribute('alt')
                            || node.getAttribute('aria-label')
                            || '',
                        nativeWidth: Number(
                            figure?.dataset.vdocNativeWidth || node.getAttribute('width')
                        ) || null,
                        nativeHeight: Number(
                            figure?.dataset.vdocNativeHeight || node.getAttribute('height')
                        ) || null,
                        duration: Number(
                            figure?.dataset.vdocDuration || node.dataset.vdocDuration
                        ),
                        durationText: figure?.dataset.vdocDurationText || '',
                    });
                    if (outcome?.reference) {
                        node.setAttribute('src', outcome.reference);
                        if (figure) {
                            figure.dataset.vdocSrc = outcome.reference;
                            figure.dataset.vdocSourceKind = 'embedded-resource';
                        }
                        collected += 1;
                    } else {
                        retained += 1;
                    }
                }

                const styleNodes = [...template.content.querySelectorAll('style')];
                for (const style of styleNodes) {
                    for (const url of fontFaceUrls(style.textContent)) {
                        const outcome = await collectUrl(url);
                        if (outcome?.reference) {
                            style.textContent = replaceFontFaceUrl(
                                style.textContent,
                                url,
                                outcome.reference
                            );
                            collected += 1;
                        } else {
                            retained += 1;
                        }
                    }
                }
                return { source: template.innerHTML, collected, retained };
            };

            let collected = 0;
            let retained = 0;
            if (isSlideDeck()) {
                for (const slide of state.document.source.slides || []) {
                    const result = await collectHtml(slide.source);
                    slide.source = core.normalizeCompleteSlideSource(result.source);
                    collected += result.collected;
                    retained += result.retained;
                }
                for (const url of fontFaceUrls(state.document.source.deckCss)) {
                    const outcome = await collectUrl(url);
                    if (outcome?.reference) {
                        state.document.source.deckCss = replaceFontFaceUrl(
                            state.document.source.deckCss,
                            url,
                            outcome.reference
                        );
                        collected += 1;
                    } else {
                        retained += 1;
                    }
                }
            } else {
                const result = await collectHtml(state.document.source.content);
                state.document.source.content = result.source;
                collected = result.collected;
                retained = result.retained;
            }
            if (collected) {
                state.document.manifest.modifiedAt = new Date().toISOString();
                state.previewRevision = -1;
                state.previewResult = null;
                renderDocument();
            }
            return { collected, retained };
        }

        async function saveDocument(saveAs = false) {
            if (!state.ready || state.saving) return false;
            finalizeEditBurst();
            if (state.mode === 'html' || state.mode === 'css') {
                if (applySourceChanges(false) === false) return false;
            }

            const operationContext = asyncCoordinator.captureContext();
            const generation = operationContext.generation;
            const savedRevision = operationContext.revision;
            state.saving = true;
            updateIdentity();

            try {
                const collection = await collectExternalResources();
                state.document.checkpoints = state.checkpoints;
                state.document.manifest.styleDependencies = [
                    ...state.usedAdvancedStyleIds,
                ];
                state.document.manifest.embeddedStyles = [
                    ...state.usedAdvancedStyleIds,
                ].map((styleId) => styleLibrary.get(styleId)).filter(Boolean);

                const bytes = await containerModule.pack(
                    state.document,
                    state.documentResourceData
                );
                const result = await api.save({
                    filePath: state.currentPath,
                    suggestedName: state.currentName,
                    saveAs,
                    bytes,
                });
                if (
                    !result?.success
                    || !asyncCoordinator.isContextCurrent(operationContext)
                ) {
                    return false;
                }

                state.currentPath = result.filePath;
                state.currentName = result.name;
                if (state.documentRevision === savedRevision) markSaved();
                else updateIdentity();

                await renderRecentDocuments();
                if (asyncCoordinator.isContextCurrent(operationContext)) {
                    const collectionSummary = collection.collected
                        ? ` · 已收纳 ${collection.collected} 项资源`
                        : '';
                    const retainedSummary = collection.retained
                        ? ` · ${collection.retained} 项保留原 URL`
                        : '';
                    showToast(
                        `已保存 · ${result.name}${collectionSummary}${retainedSummary}`,
                        'success',
                        collection.retained ? 4200 : 2600
                    );
                }
                return true;
            } catch (error) {
                if (generation === state.documentGeneration) {
                    showToast(`保存失败：${error.message}`, 'error', 5000);
                }
                return false;
            } finally {
                if (generation === state.documentGeneration) {
                    state.saving = false;
                    updateIdentity();
                }
            }
        }

        function persistCheckpoint(reason = '刻点') {
            if (!state.ready || !state.document) return Promise.resolve(false);
            const generation = state.documentGeneration;
            state.document.checkpoints = state.checkpoints;
            state.dirty = true;
            updateIdentity();

            state.checkpointSaveQueue = state.checkpointSaveQueue
                .catch(() => false)
                .then(async () => {
                    while (
                        state.saving
                        && generation === state.documentGeneration
                    ) {
                        await new Promise((resolve) =>
                            window.setTimeout(resolve, 40)
                        );
                    }
                    if (generation !== state.documentGeneration) return false;
                    const saved = await saveDocument(false);
                    if (!saved && generation === state.documentGeneration) {
                        showToast(
                            `${reason}已建立，但自动保存到文件失败`,
                            'error',
                            5000
                        );
                    }
                    return saved;
                });
            return state.checkpointSaveQueue;
        }

        function requestUnsavedDecision(message) {
            if (!state.dirty) return Promise.resolve('discard');
            if (state.unsavedResolver) return Promise.resolve('cancel');

            elements['unsaved-dialog-message'].textContent = message;
            elements['unsaved-document-name'].textContent = state.currentName;
            elements['unsaved-dialog'].hidden = false;
            return new Promise((resolve) => {
                state.unsavedResolver = resolve;
            });
        }

        function resolveUnsavedDecision(decision) {
            const resolve = state.unsavedResolver;
            if (!resolve) return;
            state.unsavedResolver = null;
            elements['unsaved-dialog'].hidden = true;
            resolve(decision);
        }

        async function runAfterUnsavedDecision(message, action) {
            if (!state.dirty) return action();
            const decision = await requestUnsavedDecision(message);
            if (decision === 'cancel') return false;
            if (decision === 'save' && !await saveDocument(false)) return false;
            return action();
        }

        async function withOpenIntent(action, failurePrefix) {
            const intent = asyncCoordinator.beginLatest('document-open');
            try {
                const result = await action();
                return await openResult(result, intent);
            } catch (error) {
                if (asyncCoordinator.isLatest(intent)) {
                    showToast(`${failurePrefix}：${error.message}`, 'error', 5000);
                }
                return false;
            }
        }

        async function chooseOpen() {
            return runAfterUnsavedDecision(
                '打开另一份文档前，可以保存当前修改，或舍弃这些修改。',
                async () => {
                    const opened = await withOpenIntent(
                        () => api.chooseOpen(),
                        '打开失败'
                    );
                    if (opened) await renderRecentDocuments();
                    return opened;
                }
            );
        }

        async function chooseImport() {
            return runAfterUnsavedDecision(
                '导入文档会建立一份新的 VDOCX 文稿。可以先保存当前修改，或舍弃这些修改。',
                async () => {
                    const imported = await withOpenIntent(
                        () => api.chooseImport(),
                        '导入失败'
                    );
                    if (imported) await renderRecentDocuments();
                    return imported;
                }
            );
        }

        async function openPath(filePath) {
            return runAfterUnsavedDecision(
                '载入另一份文档前，可以保存当前修改，或舍弃这些修改。',
                () => withOpenIntent(
                    () => api.readPath(filePath),
                    '载入失败'
                )
            );
        }

        async function renderRecentDocuments() {
            let recent = [];
            try {
                recent = await api.listRecent();
            } catch {}
            elements['recent-documents'].replaceChildren(
                ...recent.slice(0, 6).map((item) => {
                    const button = document.createElement('button');
                    button.className = 'recent-document';
                    button.textContent = item.name;
                    button.title = item.path;
                    button.addEventListener('click', () => openPath(item.path));
                    return button;
                })
            );
        }

        return Object.freeze({
            chooseImport,
            chooseOpen,
            createEditor,
            openPath,
            openResult,
            persistCheckpoint,
            renderRecentDocuments,
            requestUnsavedDecision,
            resolveUnsavedDecision,
            runAfterUnsavedDecision,
            saveDocument,
        });
    }

    window.ScriptoriumSession = Object.freeze({
        createSessionController,
    });
})();