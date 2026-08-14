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
        const containerModule = context.containerModule;
        const programmableContent = context.programmableContent;
        const styleLibrary = context.styleLibrary;
        const svgAssetLibrary = context.svgAssetLibrary;
        if (!documentPort || !lineagePort || !core || !diff
            || !styleLibrary || !svgAssetLibrary) {
            throw new TypeError(
                'Agent controller requires DocumentPort, LineagePort, VDocCore, PR diff, VDocStyleLibrary and VDocSvgAssetLibrary.'
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
                if (!sourceKind || sourceKind === 'markdown-hybrid') {
                    return current.currentSource();
                }
                if (sourceKind === 'document-css') return current.currentCss();
                throw new Error('VDOCX 仅支持 markdown-hybrid 或 document-css。');
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

        function reviewProgrammableHtml(html, reviewContext = {}) {
            if (!programmableContent?.normalizeHtmlDependencies
                || !programmableContent?.reviewScriptsInHtml) {
                return {
                    html: String(html || ''),
                    dependencies: [],
                    diagnostics: [{
                        level: 'refuse',
                        ruleId: 'review-engine-unavailable',
                        message: '可编程内容审查器未加载。',
                        context: reviewContext,
                    }],
                    refused: true,
                };
            }

            const normalized = programmableContent.normalizeHtmlDependencies(
                html,
                reviewContext
            );
            const diagnostics = [...(normalized.diagnostics || [])];
            programmableContent.reviewScriptsInHtml(
                normalized.html,
                reviewContext
            ).forEach((entry) => {
                if (entry.kind !== 'inline' || !entry.review) return;
                (entry.review.findings || []).forEach((finding) =>
                    diagnostics.push({
                        ...finding,
                        scriptId: entry.scriptId,
                        context: entry.review.context,
                    })
                );
            });
            return {
                ...normalized,
                diagnostics,
                refused: diagnostics.some((item) => item.level === 'refuse'),
            };
        }

        function programmableStatus(dependencies = [], diagnostics = []) {
            return {
                status: diagnostics.some((item) => item.level === 'refuse')
                    ? 'refuse'
                    : diagnostics.some((item) => item.level === 'warn')
                        ? 'warn'
                        : 'allow',
                dependencies: [...new Set(dependencies)],
                diagnostics,
            };
        }

        function registerProgrammableDependencies(dependencies = []) {
            const additions = [...new Set(dependencies)]
                .filter((dependency) =>
                    ['anime', 'three'].includes(dependency)
                );
            if (!additions.length) return false;
            const model = documentPort.document();
            const current = model?.manifest?.programmableDependencies || [];
            const next = [...new Set([...current, ...additions])];
            if (next.length === current.length) return false;
            return documentPort.mutate((documentModel) => {
                documentModel.manifest.programmableDependencies = next;
            }, {
                reason: 'programmable-dependencies-registered',
                dirty: false,
                derived: true,
            });
        }

        function outline() {
            const current = adapter();
            if (current.kind === 'flow') {
                const headings = current.compile().headings || [];
                return response({
                    sourceKind: 'markdown-hybrid',
                    count: headings.length,
                    totalCharacters: current.currentSource().length,
                    items: headings,
                });
            }
            return response({ items: current.outline() });
        }

        function section(options = {}) {
            const current = adapter();
            if (current.kind !== 'flow') {
                throw new Error('GetSection 仅适用于 VDOCX。');
            }
            const source = current.currentSource();
            const headings = current.compile().headings || [];
            const requestedId = String(options.id || '');
            const requestedIndex = Number(options.index);
            const heading = requestedId
                ? headings.find((item) => item.id === requestedId)
                : headings[Number.isInteger(requestedIndex) ? requestedIndex : -1];
            if (!heading) throw new Error('指定章节不存在。请先调用 GetOutline 获取章节 ID 或索引。');
            const sectionSource = source.slice(
                heading.sourceRange.start,
                heading.sourceRange.end
            ).replace(/\s+$/, '');
            const compiled = context.hybridCompiler?.compile?.(sectionSource, {
                sanitizeHtml: core.sanitizeHtml,
            });
            return response({
                sourceKind: 'markdown-hybrid',
                heading: {
                    id: heading.id,
                    index: heading.index,
                    text: heading.text,
                    level: heading.level,
                    characterCount: heading.characterCount,
                    contentCharacterCount: heading.contentCharacterCount,
                },
                startLine: heading.startLine,
                endLine: heading.endLine,
                sourceRange: heading.sourceRange,
                source: sectionSource,
                renderedText: compiled
                    ? textFromHtml(compiled.html)
                    : sectionSource,
                diagnostics: compiled?.diagnostics || [],
            });
        }

        function searchSource(options = {}) {
            const current = adapter();
            const kinds = options.sourceKind === 'all'
                ? (
                    current.kind === 'deck'
                        ? ['html', 'deck-css']
                        : ['markdown-hybrid', 'document-css']
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

        function viewportSource(options = {}) {
            const current = adapter();
            const kind = options.sourceKind
                || (current.kind === 'deck' ? 'html' : 'markdown-hybrid');
            const source = sourceFor(kind);
            if (kind === 'deck-css' || kind === 'document-css') {
                return getSource({
                    sourceKind: kind,
                    startLine: options.startLine,
                    endLine: options.endLine,
                });
            }

            const root = context.surfacePort?.activeRoot?.()
                || context.surfacePort?.editRoot?.()
                || null;
            const shells = root
                ? [...root.querySelectorAll('[data-vdoc-edit-key]')]
                : [];
            const visible = shells.filter((node) => {
                const rect = node.getBoundingClientRect();
                return rect.bottom >= 0
                    && rect.top <= window.innerHeight
                    && rect.right >= 0
                    && rect.left <= window.innerWidth;
            });
            const compiled = current.kind === 'flow' ? current.compile() : null;
            const visibleKeys = visible.map((node) =>
                String(node.dataset.vdocEditKey || '')
            ).filter(Boolean);
            const visibleRegions = compiled
                ? compiled.editRegions.filter((region) =>
                    visibleKeys.includes(region.key)
                )
                : [];
            const sourceStart = visibleRegions.length
                ? Math.min(...visibleRegions.map((region) => region.sourceRange.start))
                : 0;
            const sourceEnd = visibleRegions.length
                ? Math.max(...visibleRegions.map((region) => region.sourceRange.end))
                : source.length;
            const lines = source.replace(/\r\n?/g, '\n').split('\n');
            const firstLine = source.slice(0, sourceStart).replace(/\r\n?/g, '\n')
                .split('\n').length;
            const lastLine = source.slice(0, sourceEnd).replace(/\r\n?/g, '\n')
                .split('\n').length;
            const radius = Math.max(1, Math.min(200, Number(options.radius) || 40));
            const startLine = Math.max(1, firstLine - radius);
            const endLine = Math.min(lines.length, lastLine + radius);
            return response({
                sourceKind: kind,
                slideIndex: current.kind === 'deck'
                    ? current.activeSlideIndex()
                    : null,
                startLine,
                endLine,
                totalLines: lines.length,
                visibleBlockIds: visibleKeys,
                source: lines.slice(startLine - 1, endLine).join('\n'),
            });
        }

        async function visualContext(options = {}) {
            const current = adapter();
            if (current.kind === 'deck' && options.slideIndex !== undefined) {
                current.selectSlide(Number(options.slideIndex));
            }
            const stabilizationMs = Math.max(
                0,
                Math.min(30000, Number(options.stabilizationMs) || 0)
            );
            if (stabilizationMs) {
                await new Promise((resolve) =>
                    window.setTimeout(resolve, stabilizationMs)
                );
            }
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
            const root = context.surfacePort?.activeRoot?.()
                || context.surfacePort?.editRoot?.();
            const host = root?.host;
            const rect = host?.getBoundingClientRect?.();
            const semantic = renderedText({
                slideIndex: current.kind === 'deck'
                    ? current.activeSlideIndex()
                    : undefined,
            });
            return response({
                title: documentPort.document()?.manifest?.title || '',
                scope: options.scope || (
                    current.kind === 'deck' ? 'slide' : 'viewport'
                ),
                activeSlideIndex: current.kind === 'deck'
                    ? current.activeSlideIndex()
                    : null,
                renderedText: current.kind === 'deck'
                    ? semantic.pages?.[0]?.text || ''
                    : semantic.text || '',
                captureRect: rect ? {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                } : null,
                visualStability: {
                    stabilizationMs,
                    slideChanged: current.kind === 'deck'
                        && options.slideIndex !== undefined,
                },
            });
        }

        function listStylePacks(options = {}) {
            const query = String(options.query || '').trim().toLowerCase();
            const editableOnly = options.editableOnly === true;
            const packs = styleLibrary.listPacks()
                .filter((pack) => !editableOnly || pack.editable)
                .filter((pack) => !query || [
                    pack.manifest.id,
                    pack.manifest.name,
                    pack.manifest.description,
                    pack.manifest.author,
                    ...pack.styles.flatMap((style) => [
                        style.id,
                        style.name,
                        style.description,
                        style.category,
                        ...(style.tags || []),
                    ]),
                ].some((value) =>
                    String(value || '').toLowerCase().includes(query)
                ));
            return {
                success: true,
                format: styleLibrary.PACK_FORMAT,
                version: styleLibrary.PACK_VERSION,
                builtinPackId: styleLibrary.BUILTIN_PACK_ID,
                count: packs.length,
                packs,
            };
        }

        function getStylePack(options = {}) {
            const packId = String(
                options.packId || options.id || ''
            ).trim();
            if (!packId) throw new Error('GetStylePack 缺少 packId。');
            const pack = styleLibrary.getPack(packId);
            if (!pack) throw new Error(`未找到高级样式包：${packId}`);
            return {
                success: true,
                pack,
                source: JSON.stringify({
                    format: pack.format,
                    version: pack.version,
                    manifest: pack.manifest,
                    styles: pack.styles,
                }, null, 2),
            };
        }

        async function upsertStylePack(options = {}) {
            const author = normalizeAuthor(options.maid || options.author);
            if (!author) {
                throw new Error('Agent 管理样式包必须提供 maid 署名。');
            }
            const supplied = options.pack ?? options.source;
            let pack = supplied;
            if (typeof supplied === 'string') {
                pack = styleLibrary.parsePack(supplied);
            }
            if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
                throw new Error('UpsertStylePack 缺少 pack JSON 对象或源码。');
            }
            const packId = String(pack.manifest?.id || '').trim();
            const existed = Boolean(styleLibrary.getPack(packId));
            const result = styleLibrary.registerPack(pack, {
                conflict: 'replace',
            });
            await context.onStyleLibraryChange?.({
                operation: existed ? 'replace' : 'create',
                pack: result,
            });
            return {
                success: true,
                operation: existed ? 'replace' : 'create',
                maid: author,
                pack: result,
            };
        }

        async function deleteStylePack(options = {}) {
            const author = normalizeAuthor(options.maid || options.author);
            if (!author) {
                throw new Error('Agent 管理样式包必须提供 maid 署名。');
            }
            const packId = String(
                options.packId || options.id || ''
            ).trim();
            if (!packId) throw new Error('DeleteStylePack 缺少 packId。');
            const existing = styleLibrary.getPack(packId);
            if (!existing) throw new Error(`未找到高级样式包：${packId}`);
            styleLibrary.unregisterPack(packId);
            await context.onStyleLibraryChange?.({
                operation: 'delete',
                pack: existing,
            });
            return {
                success: true,
                operation: 'delete',
                packId,
                deletedStyleCount: existing.styles.length,
                maid: author,
            };
        }

        function listSvgAssetPacks(options = {}) {
            const query = String(options.query || '').trim().toLowerCase();
            const editableOnly = options.editableOnly === true;
            const packs = svgAssetLibrary.listPacks()
                .filter((pack) => !editableOnly || pack.editable)
                .filter((pack) => !query || [
                    pack.manifest.id,
                    pack.manifest.name,
                    pack.manifest.description,
                    pack.manifest.author,
                    ...pack.assets.flatMap((asset) => [
                        asset.id,
                        asset.name,
                        asset.description,
                        asset.category,
                        ...(asset.tags || []),
                    ]),
                ].some((value) =>
                    String(value || '').toLowerCase().includes(query)
                ));
            return {
                success: true,
                format: svgAssetLibrary.PACK_FORMAT,
                version: svgAssetLibrary.PACK_VERSION,
                builtinPackId: svgAssetLibrary.BUILTIN_PACK_ID,
                count: packs.length,
                packs,
            };
        }

        function listSvgAssets(options = {}) {
            const assets = svgAssetLibrary.list({
                query: options.query,
                packId: options.packId,
                category: options.category,
                kind: options.kind,
            }).map((asset) => {
                const { source, ...metadata } = asset;
                return metadata;
            });
            return {
                success: true,
                count: assets.length,
                assets,
            };
        }

        function getSvgAsset(options = {}) {
            const assetId = String(
                options.assetId || options.id || ''
            ).trim();
            if (!assetId) throw new Error('GetSvgAsset 缺少 assetId。');
            const asset = svgAssetLibrary.get(assetId);
            if (!asset) throw new Error(`未找到 SVG 资产：${assetId}`);
            const pack = svgAssetLibrary.getPack(asset.packId);
            return {
                success: true,
                builtin: pack?.builtin === true,
                editable: pack?.editable === true,
                asset,
                source: asset.source,
            };
        }

        function getSvgAssetPack(options = {}) {
            const packId = String(
                options.packId || options.id || ''
            ).trim();
            if (!packId) {
                throw new Error('GetSvgAssetPack 缺少 packId。');
            }
            const pack = svgAssetLibrary.getPack(packId);
            if (!pack) throw new Error(`未找到 SVG 资产包：${packId}`);
            return {
                success: true,
                pack,
                source: svgAssetLibrary.serializePack(packId),
            };
        }

        async function upsertSvgAssetPack(options = {}) {
            const author = normalizeAuthor(options.maid || options.author);
            if (!author) {
                throw new Error('Agent 管理 SVG 资产包必须提供 maid 署名。');
            }
            const supplied = options.pack ?? options.source;
            let pack = supplied;
            if (typeof supplied === 'string') {
                pack = svgAssetLibrary.parsePack(supplied);
            }
            if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
                throw new Error(
                    'UpsertSvgAssetPack 缺少 pack JSON 对象或源码。'
                );
            }
            const packId = String(pack.manifest?.id || '').trim();
            const existed = Boolean(svgAssetLibrary.getPack(packId));
            const result = svgAssetLibrary.registerPack(pack, {
                conflict: 'replace',
            });
            await context.persistSvgAssets?.();
            return {
                success: true,
                operation: existed ? 'replace' : 'create',
                maid: author,
                pack: result,
            };
        }

        async function deleteSvgAssetPack(options = {}) {
            const author = normalizeAuthor(options.maid || options.author);
            if (!author) {
                throw new Error('Agent 管理 SVG 资产包必须提供 maid 署名。');
            }
            const packId = String(
                options.packId || options.id || ''
            ).trim();
            if (!packId) {
                throw new Error('DeleteSvgAssetPack 缺少 packId。');
            }
            const existing = svgAssetLibrary.getPack(packId);
            if (!existing) throw new Error(`未找到 SVG 资产包：${packId}`);
            svgAssetLibrary.unregisterPack(packId);
            await context.persistSvgAssets?.();
            return {
                success: true,
                operation: 'delete',
                packId,
                deletedAssetCount: existing.assets.length,
                maid: author,
            };
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
            const expectedRevision = Number(payload.expectedRevision);
            if (Number.isFinite(expectedRevision)
                && expectedRevision !== current.revision) {
                const message =
                    `提案基于 revision ${expectedRevision}，当前文档为 revision ${
                        current.revision
                    }；提案未应用，文档未发生变化。`;
                const receipt = {
                    decision: 'conflict',
                    message,
                    reviewer: {
                        id: 'scriptorium-revision-guard',
                        name: 'Scriptorium 修订保护',
                        type: 'human',
                    },
                    createdAt: Date.now(),
                    automatic: true,
                    policy: {
                        source: 'revision-preflight',
                        expectedRevision,
                        actualRevision: current.revision,
                    },
                };
                const record = lineagePort.add({
                    id: payload.prId || `pr-${crypto.randomUUID()}`,
                    source: 'agent',
                    author,
                    name: payload.name || 'Agent 源码变更',
                    summary,
                    note: payload.note || '',
                    baseRevision: expectedRevision,
                    revision: current.revision,
                    proposal,
                    operation: null,
                    changeSet: null,
                    status: 'conflict',
                    reviewedAt: Date.now(),
                    receipt,
                }, { snapshot: false });
                const conflict = {
                    success: false,
                    code: 'DOCUMENT_REVISION_CONFLICT',
                    message:
                        '提案基础修订与当前文档修订不一致，请重新读取源码后提交。',
                    expectedRevision,
                    actualRevision: current.revision,
                    requestId,
                    pending: false,
                    terminal: true,
                    pr: publicRecord(record),
                    receipt,
                };
                const task = Promise.resolve(
                    context.persist?.('AI 提案预检冲突') || true
                ).then(() => conflict);
                handled.set(requestId, task);
                window.dispatchEvent(new CustomEvent(
                    'scriptorium:pr-completed',
                    { detail: conflict }
                ));
                return task;
            }
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
            const suppliedReplacements = Array.isArray(payload.replacements)
                ? payload.replacements
                : [payload];
            let replacements = suppliedReplacements;
            let programmable = programmableStatus();

            if (current.kind === 'deck' && sourceKind === 'html') {
                const dependencies = [];
                const diagnostics = [];
                replacements = suppliedReplacements.map((replacement, index) => {
                    const normalized = reviewProgrammableHtml(
                        replacement?.replace ?? replacement?.replacement ?? '',
                        {
                            phase: 'agent-pr-replacement',
                            documentKind: 'pptx',
                            slideIndex,
                            replacementIndex: index,
                        }
                    );
                    dependencies.push(...(normalized.dependencies || []));
                    diagnostics.push(...(normalized.diagnostics || []));
                    return {
                        ...replacement,
                        replace: normalized.html,
                    };
                });
                const candidate = diff.applyReplacements(
                    sourceFor(sourceKind, slideIndex),
                    replacements
                );
                if (!candidate.success) {
                    return Promise.resolve(response(candidate));
                }
                const candidateReview = reviewProgrammableHtml(
                    candidate.source,
                    {
                        phase: 'agent-pr-candidate',
                        documentKind: 'pptx',
                        slideIndex,
                    }
                );
                dependencies.push(...(candidateReview.dependencies || []));
                diagnostics.push(...(candidateReview.diagnostics || []));
                programmable = programmableStatus(dependencies, diagnostics);
            }

            const proposal = {
                type: 'source-replace',
                sourceKind,
                slideIndex,
                replacements,
                programmableContent: programmable,
            };
            const expectedRevision = Number(payload.expectedRevision);
            if (Number.isFinite(expectedRevision)
                && expectedRevision !== status().revision) {
                // Revision 是乐观并发的首要裁决条件。旧修订请求不得继续
                // 定位 target，否则会以 TARGET_NOT_FOUND 掩盖真实冲突。
                return queueProposal(payload, proposal, () => ({
                    success: false,
                    code: 'DOCUMENT_REVISION_CONFLICT',
                }));
            }
            const preliminary = diff.applyReplacements(
                sourceFor(sourceKind, slideIndex),
                replacements
            );
            if (!preliminary.success) {
                return Promise.resolve(response(preliminary));
            }
            if (current.kind === 'flow' && sourceKind === 'markdown-hybrid') {
                const validation = context.hybridCompiler?.validate?.(
                    preliminary.source
                );
                if (validation && !validation.valid) {
                    return Promise.resolve(response({
                        success: false,
                        code: 'HYBRID_SOURCE_INVALID',
                        message: '提案会产生无效的 Markdown-first 混合源码，已拒绝进入审批。',
                        diagnostics: validation.diagnostics,
                        islands: validation.islands,
                    }));
                }
            }
            return queueProposal(payload, proposal, () => {
                const active = adapter();
                const result = diff.applyReplacements(
                    sourceFor(sourceKind, slideIndex),
                    replacements
                );
                if (!result.success) return result;
                let nextSource = result.source;
                if (active.kind === 'deck' && sourceKind === 'html') {
                    const normalized = reviewProgrammableHtml(nextSource, {
                        phase: 'agent-pr-apply',
                        documentKind: 'pptx',
                        slideIndex,
                    });
                    nextSource = normalized.html;
                    programmable = programmableStatus(
                        normalized.dependencies,
                        normalized.diagnostics
                    );
                    registerProgrammableDependencies(
                        normalized.dependencies
                    );
                }
                const changed = sourceKind === 'deck-css'
                    || sourceKind === 'document-css'
                    ? active.replaceCurrentCss(nextSource, {
                        reason: 'agent-source-pr',
                    })
                    : (
                        active.kind === 'deck'
                            ? active.replaceSlideSource(
                                slideIndex,
                                nextSource,
                                { reason: 'agent-source-pr' }
                            )
                            : active.replaceCurrentSource(nextSource, {
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
                        programmableContent: programmable,
                    },
                    programmableContent: programmable,
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
            let normalizedPayload = payload;
            let programmable = programmableStatus();
            if (type !== 'delete') {
                if (!String(payload.source || '').trim()) {
                    return Promise.resolve(response({
                        success: false,
                        code: 'SLIDE_SOURCE_REQUIRED',
                        message: '新增或插入页面必须提供完整 source。',
                    }));
                }
                const insertionIndex = type === 'insert'
                    ? Math.max(
                        0,
                        Math.min(
                            current.slides().length,
                            Number(payload.slideIndex) || 0
                        )
                    )
                    : current.slides().length;
                const normalized = reviewProgrammableHtml(payload.source, {
                    phase: 'agent-slide',
                    documentKind: 'pptx',
                    slideIndex: insertionIndex,
                });
                normalizedPayload = {
                    ...payload,
                    source: normalized.html,
                };
                programmable = programmableStatus(
                    normalized.dependencies,
                    normalized.diagnostics
                );
            }
            const proposal = {
                type: `slide-${type}`,
                slideIndex: normalizedPayload.slideIndex,
                name: normalizedPayload.name,
                source: normalizedPayload.source,
                notes: normalizedPayload.notes,
                programmableContent: programmable,
            };
            return queueProposal(normalizedPayload, proposal, () => {
                if (type === 'delete') {
                    const removed = current.deleteSlide(
                        normalizedPayload.slideIndex
                            ?? current.activeSlideIndex(),
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
                    name: normalizedPayload.name,
                    source: normalizedPayload.source,
                    notes: normalizedPayload.notes,
                    transition: normalizedPayload.transition,
                    resources: normalizedPayload.resources,
                }, {
                    index: type === 'insert'
                        ? normalizedPayload.slideIndex
                        : undefined,
                    reason: `agent-slide-${type}`,
                });
                if (created) {
                    registerProgrammableDependencies(
                        programmable.dependencies
                    );
                }
                return {
                    success: Boolean(created),
                    operation: {
                        type: `slide-${type}`,
                        slideId: created?.id,
                        programmableContent: programmable,
                    },
                    programmableContent: programmable,
                };
            });
        }

        function updatePresentationConfig(payload = {}) {
            const current = adapter();
            if (current.kind !== 'deck') {
                return Promise.resolve({
                    success: false,
                    code: 'PPTX_REQUIRED',
                    message: '演示配置仅适用于 VPPTX。',
                });
            }
            const currentScene = core.createSceneConfig(
                documentPort.document().manifest.scene
            );
            const proposalScene = core.createSceneConfig({
                ...currentScene,
                kind: core.PROJECT_KINDS.SLIDE_DECK,
                page: {
                    ...currentScene.page,
                    ...(payload.page || {}),
                },
                presentation: {
                    ...currentScene.presentation,
                    ...(payload.presentation || {}),
                },
            });
            return queueProposal(payload, {
                type: 'presentation-config',
                scene: proposalScene,
            }, () => ({
                success: current.updateScene(proposalScene, {
                    reason: 'agent-presentation-config',
                }) !== false,
                operation: {
                    type: 'presentation-config',
                    scene: proposalScene,
                },
            }));
        }

        function programmableReview(sources, documentKind) {
            const diagnostics = [];
            const dependencies = new Set();
            (sources || []).forEach((source, sourceIndex) => {
                programmableContent?.reviewScriptsInHtml?.(source, {
                    documentKind,
                    surface: 'project-artifact',
                    sourceIndex,
                }).forEach((entry) => {
                    if (entry.dependency?.library) {
                        dependencies.add(entry.dependency.library);
                    }
                    if (entry.review) {
                        entry.review.dependencies?.forEach((dependency) =>
                            dependencies.add(dependency)
                        );
                        entry.review.findings?.forEach((finding) =>
                            diagnostics.push({
                                ...finding,
                                sourceIndex,
                                scriptId: entry.scriptId,
                            })
                        );
                    }
                    if (entry.dependency?.level) {
                        diagnostics.push({
                            level: entry.dependency.level,
                            ruleId: entry.dependency.code || 'script-dependency',
                            message: entry.dependency.message,
                            sourceIndex,
                            scriptId: entry.scriptId,
                        });
                    }
                });
            });
            const refused = diagnostics.some((item) => item.level === 'refuse');
            return {
                status: refused
                    ? 'refuse'
                    : diagnostics.some((item) => item.level === 'warn')
                        ? 'warn'
                        : 'allow',
                dependencies: [...dependencies],
                diagnostics,
            };
        }

        async function buildProjectArtifact(payload = {}) {
            if (!containerModule?.pack) {
                throw new Error('Scriptorium 工程容器模块不可用。');
            }
            const projectType = String(payload.projectType || '').toLowerCase();
            const deck = ['pptx', 'vpptx'].includes(projectType);
            if (!deck && !['docx', 'vdocx'].includes(projectType)) {
                throw new Error('projectType 必须为 docx 或 pptx。');
            }
            const source = String(payload.source || '');
            const slides = Array.isArray(payload.slides) ? payload.slides : [];
            if (!deck && !source.trim()) throw new Error('VDOCX source 不能为空。');
            if (deck && (!slides.length || slides.some((slide) =>
                !String(slide?.source || '').trim()
            ))) {
                throw new Error('VPPTX slides 必须包含至少一页完整 source。');
            }

            const normalizedSlides = deck
                ? slides.map((slide, index) => {
                    const normalized = reviewProgrammableHtml(
                        slide?.source,
                        {
                            phase: 'agent-project-create',
                            documentKind: 'pptx',
                            slideIndex: index,
                        }
                    );
                    return {
                        ...(slide && typeof slide === 'object' ? slide : {}),
                        source: normalized.html,
                        programmableContent: normalized,
                    };
                })
                : [];
            const review = deck
                ? programmableStatus(
                    normalizedSlides.flatMap((slide) =>
                        slide.programmableContent.dependencies || []
                    ),
                    normalizedSlides.flatMap((slide) =>
                        slide.programmableContent.diagnostics || []
                    )
                )
                : programmableReview([source], 'docx');
            if (review.status === 'refuse') {
                return {
                    success: false,
                    code: 'PROGRAMMABLE_CONTENT_REFUSED',
                    message: '可编程内容未通过安全审查。',
                    programmableContent: review,
                };
            }
            if (!deck) {
                const validation = context.hybridCompiler?.validate?.(source);
                if (validation && !validation.valid) {
                    return {
                        success: false,
                        code: 'HYBRID_SOURCE_INVALID',
                        message: 'Markdown-first 混合源码未通过校验。',
                        programmableContent: {
                            ...review,
                            status: 'refuse',
                            diagnostics: [
                                ...review.diagnostics,
                                ...validation.diagnostics,
                            ],
                        },
                    };
                }
            }

            const model = core.createDocument({
                title: payload.title || (deck ? '未命名演示' : '未命名文稿'),
                kind: deck
                    ? core.PROJECT_KINDS.SLIDE_DECK
                    : core.PROJECT_KINDS.FLOW_DOCUMENT,
                source: deck ? undefined : source,
                documentCss: deck ? undefined : payload.documentCss,
                deckCss: deck ? payload.deckCss : undefined,
                slides: deck
                    ? normalizedSlides.map(
                        ({ programmableContent: _review, ...slide }) => slide
                    )
                    : undefined,
                page: payload.page,
                presentation: payload.presentation,
            });
            const creator = normalizeAuthor(payload.maid || payload.author);
            if (!creator) {
                return {
                    success: false,
                    code: 'AUTHOR_REQUIRED',
                    message: 'Agent 创建工程必须提供有效 maid 署名。',
                };
            }
            const createdAt = Date.parse(model.manifest.createdAt) || Date.now();
            model.checkpoints = [{
                id: `lineage-create-${model.manifest.id}`,
                source: 'agent',
                author: creator,
                name: 'Agent 创建文档',
                summary: String(
                    payload.summary || `由 ${creator.name} 创建完整文档工程。`
                ).trim(),
                note: '',
                createdAt,
                baseRevision: null,
                revision: 0,
                operation: {
                    type: 'project-create',
                    documentKind: deck ? 'pptx' : 'docx',
                },
                proposal: null,
                changeSet: null,
                status: 'applied',
                receipt: {
                    decision: 'created',
                    message: `文档由 ${creator.name} 创建。`,
                    reviewer: creator,
                    createdAt,
                    automatic: true,
                    policy: { source: 'agent-project-creation' },
                },
                snapshot: '',
            }];
            model.manifest.programmableDependencies = review.dependencies
                .filter((dependency) => ['anime', 'three'].includes(dependency));
            const bytes = await containerModule.pack(model, new Map());
            return {
                success: true,
                documentId: model.manifest.id,
                title: model.manifest.title,
                suggestedName: `${
                    model.manifest.title || (deck ? '未命名演示' : '未命名文稿')
                }${deck ? '.vpptx' : '.vdocx'}`,
                bytes,
                programmableContent: review,
            };
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
                const activeStatus = status();
                if (entry.documentId !== activeStatus.documentId) {
                    const conflictReceipt = {
                        ...receipt,
                        decision: 'conflict',
                        message: '当前窗口已切换到另一份文档，提案未应用。',
                    };
                    lineagePort.update(entry.record.id, {
                        status: 'conflict',
                        reviewedAt: Date.now(),
                        operation: null,
                        changeSet: null,
                        receipt: conflictReceipt,
                    });
                    await context.persist?.('AI 提案文档上下文冲突');
                    const conflict = {
                        success: false,
                        code: 'DOCUMENT_CONTEXT_CHANGED',
                        message: conflictReceipt.message,
                        pending: false,
                        terminal: true,
                        pr: publicRecord(entry.record),
                        receipt: conflictReceipt,
                    };
                    entry.resolve(conflict);
                    window.dispatchEvent(new CustomEvent(
                        'scriptorium:pr-completed',
                        { detail: conflict }
                    ));
                    return conflict;
                }
                if (Number(entry.record.baseRevision) !== activeStatus.revision) {
                    const conflictReceipt = {
                        ...receipt,
                        decision: 'conflict',
                        message: `文档修订已从 ${
                            entry.record.baseRevision
                        } 变为 ${activeStatus.revision}，提案未应用。`,
                    };
                    lineagePort.update(entry.record.id, {
                        status: 'conflict',
                        reviewedAt: Date.now(),
                        revision: activeStatus.revision,
                        operation: null,
                        changeSet: null,
                        receipt: conflictReceipt,
                    });
                    await context.persist?.('AI 提案应用冲突');
                    const conflict = {
                        success: false,
                        code: 'DOCUMENT_REVISION_CONFLICT',
                        message:
                            '提案基础修订与当前文档修订不一致，请重新读取源码后提交。',
                        expectedRevision: entry.record.baseRevision,
                        actualRevision: activeStatus.revision,
                        pending: false,
                        terminal: true,
                        pr: publicRecord(entry.record),
                        receipt: conflictReceipt,
                    };
                    entry.resolve(conflict);
                    window.dispatchEvent(new CustomEvent(
                        'scriptorium:pr-completed',
                        { detail: conflict }
                    ));
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
            getViewportSource: viewportSource,
            getVisualContext: visualContext,
            getPrHistory: history,
            listStylePacks,
            getStylePack,
            upsertStylePack,
            deleteStylePack,
            listSvgAssetPacks,
            listSvgAssets,
            getSvgAsset,
            getSvgAssetPack,
            upsertSvgAssetPack,
            deleteSvgAssetPack,
            submitSourcePr,
            buildProjectArtifact,
        });
        const docx = Object.freeze({
            ...common,
            getFullText: renderedText,
            getSection: section,
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
            updatePresentationConfig,
            updateSceneConfig: updatePresentationConfig,
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
            version: 5,
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