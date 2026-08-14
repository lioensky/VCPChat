'use strict';

(() => {
    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
    }

    function safeFileStem(name) {
        return String(name || 'svg-asset')
            .replace(/\.svg$/i, '')
            .replace(/[^a-z0-9\u3400-\u9fff_-]+/gi, '-')
            .replace(/^-+|-+$/g, '')
            || 'svg-asset';
    }

    function idSegment(value) {
        const normalized = String(value || '')
            .normalize('NFKD')
            .replace(/[^\x00-\x7F]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return normalized || `asset-${Date.now().toString(36)}`;
    }

    function createSvgAssetController(context = {}) {
        const elements = context.elements || {};
        const library = context.library;
        const objects = context.objects;
        const persistencePort = context.persistencePort || {};
        const notificationPort = context.notificationPort || {};
        if (!library || !objects) {
            throw new TypeError(
                'SVG asset controller requires asset library and object module.'
            );
        }

        const state = {
            abortController: null,
            libraryDisposer: null,
            selectedAssetId: null,
            opened: false,
            initialized: false,
            disposed: false,
        };
        let initializationPromise = null;

        function picker() {
            return elements['svg-asset-picker'];
        }

        function manager() {
            return elements['svg-asset-manager-dialog'];
        }

        function currentAsset() {
            return state.selectedAssetId
                ? library.get(state.selectedAssetId)
                : null;
        }

        function currentPack() {
            const asset = currentAsset();
            return asset ? library.getPack(asset.packId) : null;
        }

        async function persist() {
            return persistencePort.saveSvgAssetPacks?.(
                library.exportUserPacks()
            );
        }

        function initialize() {
            if (state.initialized) return Promise.resolve(true);
            if (initializationPromise) return initializationPromise;
            initializationPromise = (async () => {
                try {
                    const packs =
                        await persistencePort.loadSvgAssetPacks?.() || [];
                    library.replaceUserPacks(packs);
                } catch (error) {
                    notificationPort.show?.(
                        `SVG 资产库载入失败：${error.message}`,
                        'error',
                        5000
                    );
                }
                state.initialized = true;
                renderAll();
                return true;
            })();
            return initializationPromise;
        }

        function previewMarkup(asset, options = {}) {
            const source = String(asset?.source || '')
                .replace(/<\/style/gi, '<\\/style');
            const pause = options.pause !== false;
            return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}
body{display:grid;place-items:center;padding:8px;box-sizing:border-box}
svg{display:block;width:100%;height:100%;max-width:100%;max-height:100%;overflow:visible}
${
    pause
        ? `*,*::before,*::after{animation-play-state:paused!important}
svg{pointer-events:none}`
        : ''
}
</style>
</head>
<body>${source}</body>
</html>`;
        }

        function assetCard(asset, options = {}) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = options.manager
                ? 'svg-asset-manager-card'
                : 'svg-asset-card';
            button.dataset.svgAssetId = asset.id;
            button.setAttribute('role', 'option');
            button.setAttribute(
                'aria-selected',
                String(asset.id === state.selectedAssetId)
            );
            button.classList.toggle(
                'active',
                asset.id === state.selectedAssetId
            );

            const preview = document.createElement('iframe');
            preview.className = 'svg-asset-card-preview';
            preview.sandbox = '';
            preview.tabIndex = -1;
            preview.setAttribute('aria-hidden', 'true');
            preview.srcdoc = previewMarkup(asset);

            const copy = document.createElement('span');
            copy.className = 'svg-asset-card-copy';
            const name = document.createElement('strong');
            name.textContent = asset.name;
            const meta = document.createElement('small');
            meta.textContent = `${asset.category} · ${
                asset.kind === 'animated' ? '动画' : '静态'
            }`;
            copy.append(name, meta);
            button.append(preview, copy);

            if (asset.kind === 'animated') {
                const badge = document.createElement('i');
                badge.className = 'svg-asset-motion-badge';
                badge.textContent = '动';
                button.appendChild(badge);
                button.addEventListener('mouseenter', () => {
                    preview.srcdoc = previewMarkup(asset, { pause: false });
                });
                button.addEventListener('mouseleave', () => {
                    preview.srcdoc = previewMarkup(asset);
                });
            }

            button.addEventListener('click', () => {
                if (options.manager) selectForEditing(asset.id);
                else insert(asset.id);
            });
            return button;
        }

        function filteredAssets(scope = 'picker') {
            const query = String(
                elements[
                    scope === 'picker'
                        ? 'svg-asset-picker-search'
                        : 'svg-asset-manager-search'
                ]?.value || ''
            );
            return library.list({
                query,
                category: scope === 'picker'
                    ? elements['svg-asset-picker-category']?.value || ''
                    : '',
                kind: scope === 'manager'
                    ? elements['svg-asset-manager-kind']?.value || ''
                    : '',
            });
        }

        function renderCategories() {
            const select = elements['svg-asset-picker-category'];
            if (!select) return;
            const previous = select.value;
            const all = document.createElement('option');
            all.value = '';
            all.textContent = '全部分类';
            const options = library.categories().map((category) => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                return option;
            });
            select.replaceChildren(all, ...options);
            if ([...select.options].some((option) =>
                option.value === previous
            )) {
                select.value = previous;
            }
        }

        function renderPicker() {
            renderCategories();
            const assets = filteredAssets('picker');
            elements['svg-asset-picker-grid']?.replaceChildren(
                ...assets.map((asset) => assetCard(asset))
            );
            if (elements['svg-asset-picker-count']) {
                elements['svg-asset-picker-count'].textContent =
                    `${assets.length} 个资产`;
            }
        }

        function renderManagerList() {
            const assets = filteredAssets('manager');
            elements['svg-asset-manager-list']?.replaceChildren(
                ...assets.map((asset) =>
                    assetCard(asset, { manager: true })
                )
            );
        }

        function renderAll() {
            renderPicker();
            renderManagerList();
            if (state.selectedAssetId && !currentAsset()) {
                state.selectedAssetId = null;
                clearEditor();
            }
        }

        function positionPicker() {
            const trigger = elements['svg-asset-picker-btn'];
            const panel = picker();
            if (!trigger || !panel) return;
            const rect = trigger.getBoundingClientRect();
            const width = Math.min(520, window.innerWidth - 16);
            panel.style.width = `${width}px`;
            panel.style.left = `${
                Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))
            }px`;
            panel.style.top = `${Math.min(
                window.innerHeight - 24,
                rect.bottom + 8
            )}px`;
        }

        function openPicker() {
            if (!picker()) return false;
            state.opened = true;
            picker().hidden = false;
            elements['svg-asset-picker-btn']?.setAttribute(
                'aria-expanded',
                'true'
            );
            positionPicker();
            renderPicker();
            return true;
        }

        function closePicker() {
            state.opened = false;
            if (picker()) picker().hidden = true;
            elements['svg-asset-picker-btn']?.setAttribute(
                'aria-expanded',
                'false'
            );
        }

        function togglePicker() {
            return state.opened ? closePicker() : openPicker();
        }

        function insert(assetId, options = {}) {
            if (!context.canInsert?.()) {
                notificationPort.show?.(
                    '请先打开文档并切换到连续编辑模式。',
                    'info'
                );
                return false;
            }
            try {
                const instance = library.instantiate(assetId, options);
                const node = objects.createShapeFromSvg(
                    instance.asset,
                    instance.source,
                    {
                        width: instance.width,
                        height: instance.height,
                        deck: context.freeCanvas?.() === true,
                        layout: options.layout,
                        left: options.left,
                        top: options.top,
                        rotation: options.rotation,
                        opacity: options.opacity,
                        description: options.description,
                    }
                );
                const inserted = context.insertObject?.(node) === true;
                if (inserted) {
                    closePicker();
                    notificationPort.show?.(
                        `已插入图形 · ${instance.asset.name}`,
                        'success'
                    );
                }
                return inserted;
            } catch (error) {
                notificationPort.show?.(
                    `图形插入失败：${error.message}`,
                    'error'
                );
                return false;
            }
        }

        function uniqueAssetId(packId, stem, used = new Set()) {
            const base = `${packId}.${idSegment(stem)}`;
            let candidate = base;
            let suffix = 2;
            while (library.get(candidate) || used.has(candidate)) {
                candidate = `${base}-${suffix}`;
                suffix += 1;
            }
            used.add(candidate);
            return candidate;
        }

        async function importFiles(files) {
            const selected = [...(files || [])];
            if (!selected.length) return false;
            const timestamp = Date.now().toString(36);
            const packId = `vcp.user.svg-import.${timestamp}`;
            const used = new Set();
            const assets = [];
            const errors = [];
            for (const file of selected) {
                try {
                    const source = await file.text();
                    const name = safeFileStem(file.name);
                    assets.push({
                        id: uniqueAssetId(packId, name, used),
                        version: 1,
                        name,
                        description: `从 ${file.name} 导入的 SVG 图形`,
                        category: '用户导入',
                        tags: ['导入', name],
                        source,
                        defaultSize: { width: 260, height: 180 },
                        createdBy: 'human',
                    });
                } catch (error) {
                    errors.push(`${file.name}：${error.message}`);
                }
            }
            try {
                if (!assets.length) {
                    throw new Error(errors[0] || '没有可导入的 SVG。');
                }
                const result = library.registerPack({
                    format: library.PACK_FORMAT,
                    version: library.PACK_VERSION,
                    manifest: {
                        id: packId,
                        name: `本地 SVG 导入 ${new Date().toLocaleString()}`,
                        description: `一次导入 ${assets.length} 个本地 SVG 文件。`,
                        author: 'Human',
                    },
                    assets,
                }, { conflict: 'replace' });
                await persist();
                renderAll();
                notificationPort.show?.(
                    `已导入 ${result.assets.length} 个 SVG${
                        errors.length ? `，${errors.length} 个失败` : ''
                    }`,
                    errors.length ? 'info' : 'success',
                    5000
                );
                return true;
            } catch (error) {
                notificationPort.show?.(
                    `SVG 批量导入失败：${error.message}`,
                    'error',
                    6000
                );
                return false;
            } finally {
                if (elements['svg-asset-import-input']) {
                    elements['svg-asset-import-input'].value = '';
                }
            }
        }

        function openManager() {
            closePicker();
            if (!manager()) return false;
            manager().hidden = false;
            renderManagerList();
            const first = currentAsset() || filteredAssets('manager')[0];
            if (first) selectForEditing(first.id);
            else clearEditor();
            return true;
        }

        function closeManager() {
            if (manager()) manager().hidden = true;
        }

        function clearEditor() {
            state.selectedAssetId = null;
            if (elements['svg-asset-editor-heading']) {
                elements['svg-asset-editor-heading'].textContent =
                    '资产预览';
            }
            if (elements['svg-asset-editor-origin']) {
                elements['svg-asset-editor-origin'].textContent =
                    '选择一个资产';
            }
            [
                'svg-asset-name-input',
                'svg-asset-category-input',
                'svg-asset-description-input',
                'svg-asset-tags-input',
                'svg-asset-width-input',
                'svg-asset-height-input',
                'svg-asset-source-input',
            ].forEach((id) => {
                if (elements[id]) elements[id].value = '';
            });
            if (elements['svg-asset-save-btn']) {
                elements['svg-asset-save-btn'].disabled = true;
            }
            if (elements['svg-asset-delete-btn']) {
                elements['svg-asset-delete-btn'].disabled = true;
            }
        }

        function selectForEditing(assetId) {
            const asset = library.get(assetId);
            if (!asset) return false;
            state.selectedAssetId = asset.id;
            const pack = library.getPack(asset.packId);
            elements['svg-asset-editor-heading'].textContent = asset.name;
            elements['svg-asset-editor-origin'].textContent = pack?.builtin
                ? `内置只读 · ${pack.manifest.name}`
                : `可编辑 · ${pack?.manifest?.name || asset.packId}`;
            elements['svg-asset-name-input'].value = asset.name;
            elements['svg-asset-category-input'].value = asset.category;
            elements['svg-asset-description-input'].value =
                asset.description;
            elements['svg-asset-tags-input'].value =
                asset.tags.join(', ');
            elements['svg-asset-width-input'].value =
                String(asset.defaultSize.width);
            elements['svg-asset-height-input'].value =
                String(asset.defaultSize.height);
            elements['svg-asset-source-input'].value = asset.source;
            elements['svg-asset-preview-frame'].srcdoc = previewMarkup(
                asset,
                { pause: false }
            );
            const editable = pack?.editable === true;
            [
                'svg-asset-name-input',
                'svg-asset-category-input',
                'svg-asset-description-input',
                'svg-asset-tags-input',
                'svg-asset-width-input',
                'svg-asset-height-input',
                'svg-asset-source-input',
            ].forEach((id) => {
                if (elements[id]) elements[id].disabled = !editable;
            });
            elements['svg-asset-save-btn'].disabled = !editable;
            elements['svg-asset-delete-btn'].disabled = !editable;
            validateEditor();
            renderManagerList();
            return true;
        }

        function editorAsset() {
            const asset = currentAsset();
            if (!asset) return null;
            return {
                ...asset,
                name: elements['svg-asset-name-input'].value,
                category: elements['svg-asset-category-input'].value,
                description:
                    elements['svg-asset-description-input'].value,
                tags: elements['svg-asset-tags-input'].value
                    .split(/[,，]/)
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                defaultSize: {
                    width: Number(
                        elements['svg-asset-width-input'].value
                    ),
                    height: Number(
                        elements['svg-asset-height-input'].value
                    ),
                },
                source: elements['svg-asset-source-input'].value,
            };
        }

        function validateEditor() {
            const asset = editorAsset();
            if (!asset) return false;
            try {
                const normalized = library.normalizeAsset(
                    asset,
                    asset.packId
                );
                const diagnostics = normalized.diagnostics;
                elements['svg-asset-editor-diagnostics'].textContent =
                    `${normalized.kind === 'animated' ? '动画' : '静态'} SVG`
                    + ` · ${diagnostics.nodes} 节点`
                    + ` · ${diagnostics.sourceBytes} 字节`
                    + (
                        diagnostics.scriptsRemoved
                            ? ' · 已移除脚本'
                            : ''
                    );
                elements['svg-asset-editor-diagnostics'].className =
                    'object-source-diagnostics valid';
                elements['svg-asset-preview-frame'].srcdoc =
                    previewMarkup(normalized, { pause: false });
                if (currentPack()?.editable) {
                    elements['svg-asset-save-btn'].disabled = false;
                }
                return true;
            } catch (error) {
                elements['svg-asset-editor-diagnostics'].textContent =
                    error.message;
                elements['svg-asset-editor-diagnostics'].className =
                    'object-source-diagnostics invalid';
                elements['svg-asset-save-btn'].disabled = true;
                return false;
            }
        }

        async function saveEditor() {
            const asset = editorAsset();
            const pack = currentPack();
            if (!asset || !pack?.editable || !validateEditor()) return false;
            const assets = pack.assets.map((candidate) =>
                candidate.id === asset.id ? asset : candidate
            );
            try {
                const result = library.registerPack({
                    format: pack.format,
                    version: pack.version,
                    manifest: pack.manifest,
                    assets,
                }, { conflict: 'replace' });
                await persist();
                renderAll();
                selectForEditing(asset.id);
                notificationPort.show?.(
                    `已保存 SVG 资产 · ${asset.name}`,
                    'success'
                );
                context.onChange?.({
                    operation: 'replace',
                    pack: result,
                });
                return true;
            } catch (error) {
                notificationPort.show?.(
                    `SVG 资产保存失败：${error.message}`,
                    'error'
                );
                return false;
            }
        }

        async function deleteSelectedPack() {
            const pack = currentPack();
            if (!pack?.editable) return false;
            if (!window.confirm(
                `删除资产包“${pack.manifest.name}”及其中 ${
                    pack.assets.length
                } 个资产？`
            )) {
                return false;
            }
            library.unregisterPack(pack.manifest.id);
            await persist();
            state.selectedAssetId = null;
            clearEditor();
            renderAll();
            notificationPort.show?.(
                `已删除 SVG 资产包 · ${pack.manifest.name}`,
                'success'
            );
            context.onChange?.({
                operation: 'delete',
                pack,
            });
            return true;
        }

        function exportSelectedPack() {
            const pack = currentPack()
                || library.listPacks().find((item) => item.editable);
            if (!pack) {
                notificationPort.show?.('没有可导出的 SVG 资产包。', 'info');
                return false;
            }
            const source = library.serializePack(pack.manifest.id);
            const url = URL.createObjectURL(new Blob(
                [source],
                { type: 'application/json' }
            ));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${
                idSegment(pack.manifest.id)
            }.vsvg.json`;
            anchor.click();
            URL.revokeObjectURL(url);
            return true;
        }

        function bind() {
            state.abortController?.abort();
            state.abortController = new AbortController();
            const options = { signal: state.abortController.signal };
            elements['svg-asset-picker-btn']?.addEventListener(
                'click',
                (event) => {
                    event.stopPropagation();
                    togglePicker();
                },
                options
            );
            elements['svg-asset-picker-search']?.addEventListener(
                'input',
                renderPicker,
                options
            );
            elements['svg-asset-picker-category']?.addEventListener(
                'change',
                renderPicker,
                options
            );
            elements['svg-asset-manage-btn']?.addEventListener(
                'click',
                openManager,
                options
            );
            elements['svg-asset-import-card']?.addEventListener(
                'click',
                () => elements['svg-asset-import-input']?.click(),
                options
            );
            elements['svg-asset-manager-import-btn']?.addEventListener(
                'click',
                () => elements['svg-asset-import-input']?.click(),
                options
            );
            elements['svg-asset-import-input']?.addEventListener(
                'change',
                (event) => importFiles(event.target.files),
                options
            );
            elements['svg-asset-manager-close-btn']?.addEventListener(
                'click',
                closeManager,
                options
            );
            elements['svg-asset-manager-dialog']?.addEventListener(
                'click',
                (event) => {
                    if (event.target === manager()) closeManager();
                },
                options
            );
            elements['svg-asset-manager-search']?.addEventListener(
                'input',
                renderManagerList,
                options
            );
            elements['svg-asset-manager-kind']?.addEventListener(
                'change',
                renderManagerList,
                options
            );
            elements['svg-asset-editor-form']?.addEventListener(
                'input',
                validateEditor,
                options
            );
            elements['svg-asset-editor-form']?.addEventListener(
                'submit',
                (event) => {
                    event.preventDefault();
                    saveEditor();
                },
                options
            );
            elements['svg-asset-delete-btn']?.addEventListener(
                'click',
                deleteSelectedPack,
                options
            );
            elements['svg-asset-manager-export-btn']?.addEventListener(
                'click',
                exportSelectedPack,
                options
            );
            document.addEventListener('click', (event) => {
                if (state.opened
                    && !picker()?.contains(event.target)
                    && !elements['svg-asset-picker-btn']?.contains(
                        event.target
                    )) {
                    closePicker();
                }
            }, options);
            window.addEventListener('resize', () => {
                if (state.opened) positionPicker();
            }, options);
            state.libraryDisposer?.();
            state.libraryDisposer = library.subscribe(renderAll);
            initialize();
            return api;
        }

        function dispose() {
            if (state.disposed) return;
            state.abortController?.abort();
            state.libraryDisposer?.();
            closePicker();
            closeManager();
            state.disposed = true;
        }

        const api = Object.freeze({
            initialize,
            openPicker,
            closePicker,
            openManager,
            closeManager,
            insert,
            importFiles,
            renderAll,
            persist,
            bind,
            dispose,
        });
        return api;
    }

    window.ScriptoriumSvgAssets = Object.freeze({
        createSvgAssetController,
    });
})();