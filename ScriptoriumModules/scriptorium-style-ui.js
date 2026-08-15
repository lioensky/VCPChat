'use strict';

(() => {
    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
    }

    function createStyleUiController(context = {}) {
        const elements = context.elements || {};
        const styleLibrary = context.styleLibrary;
        const persistencePort = context.persistencePort || {};
        const notificationPort = context.notificationPort || {};
        if (!styleLibrary) {
            throw new TypeError('Style UI requires VDocStyleLibrary.');
        }

        let editorPort = null;
        let selectedStyleId = null;
        let abortController = null;
        let libraryDisposer = null;
        let disposed = false;
        let initialized = false;
        let initializationPromise = null;

        function persist() {
            return persistencePort.saveStylePacks?.(
                styleLibrary.exportUserPacks()
            );
        }

        function initialize() {
            if (initialized) return Promise.resolve(true);
            if (initializationPromise) return initializationPromise;
            initializationPromise = (async () => {
                try {
                    const packs =
                        await persistencePort.loadStylePacks?.() || [];
                    styleLibrary.replaceUserPacks(packs);
                } catch (error) {
                    notificationPort.show?.(
                        `高级样式库载入失败：${error.message}`,
                        'error',
                        5000
                    );
                }
                initialized = true;
                populateCategories();
                renderList();
                return true;
            })();
            return initializationPromise;
        }

        function currentEditor() {
            return editorPort || context.getEditorPort?.() || null;
        }

        function setEditorPort(nextEditor) {
            if (!nextEditor
                || typeof nextEditor.executeFormatting !== 'function') {
                throw new TypeError('Style UI requires an EditorPort.');
            }
            editorPort = nextEditor;
            return editorPort;
        }

        function selectionTarget() {
            return currentEditor()?.formattingState?.()?.selectionTarget
                || 'inline';
        }

        function populateCategories() {
            const select = elements['style-category-select'];
            if (!select) return;
            const previous = select.value;
            const all = document.createElement('option');
            all.value = '';
            all.textContent = '全部分类';
            const options = styleLibrary.categories().map((category) => {
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

        function stylesForCurrentSelection() {
            const target = selectionTarget();
            return styleLibrary.list({
                query: elements['style-search-input']?.value || '',
                category: elements['style-category-select']?.value || '',
            }).filter((style) =>
                style.targets.includes(target)
                || style.targets.includes('inline')
                || (
                    target === 'heading'
                    && style.targets.includes('block')
                )
            );
        }

        function renderList() {
            const styles = stylesForCurrentSelection();
            if (!styles.some((style) => style.id === selectedStyleId)) {
                selectedStyleId = null;
                if (elements['style-apply-btn']) {
                    elements['style-apply-btn'].disabled = true;
                }
            }
            elements['style-library-list']?.replaceChildren(
                ...styles.map((style) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'style-card';
                    button.classList.toggle(
                        'active',
                        style.id === selectedStyleId
                    );
                    button.setAttribute('role', 'option');
                    button.setAttribute(
                        'aria-selected',
                        String(style.id === selectedStyleId)
                    );
                    const name = document.createElement('strong');
                    name.textContent = style.name;
                    const category = document.createElement('span');
                    category.className = 'style-card-category';
                    category.textContent = style.category;
                    const description = document.createElement('p');
                    description.textContent = style.description;
                    button.append(name, category, description);
                    button.addEventListener(
                        'click',
                        () => select(style.id)
                    );
                    return button;
                })
            );
        }

        function preview(style) {
            const previous = elements['style-preview-frame'];
            if (!previous) return;
            const frame = previous.cloneNode(false);
            frame.removeAttribute('srcdoc');
            previous.replaceWith(frame);
            elements['style-preview-frame'] = frame;
            try {
                const product = styleLibrary.createPreviewDocument(style.id, {
                    text: currentEditor()?.selectionState?.()?.text
                        || style.previewText,
                });
                const tag = style.targets.includes('heading')
                    ? 'h2'
                    : style.targets.includes('paragraph')
                        ? 'p'
                        : style.targets.includes('block')
                            ? 'div'
                            : 'span';
                frame.srcdoc = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
html,body{
    margin:0;
    min-height:100%;
    background:#fffdf8;
    color:#202723
}
body{
    display:grid;
    place-items:center;
    padding:34px;
    box-sizing:border-box;
    font-family:"Noto Serif CJK SC","Microsoft YaHei",serif;
    line-height:1.75
}
${product.css}
</style>
</head>
<body>
<${tag} class="${escapeHtml(product.className)}">${
    escapeHtml(
        String(product.text || style.previewText || '高级样式预览')
            .slice(0, 1200)
    )
}</${tag}>
</body>
</html>`;
            } catch (error) {
                frame.srcdoc = `<!doctype html><body>${
                    escapeHtml(`预览生成失败：${error.message}`)
                }</body>`;
                elements['style-apply-btn'].disabled = true;
            }
        }

        function select(styleId) {
            const style = styleLibrary.get(styleId);
            if (!style) return false;
            selectedStyleId = style.id;
            renderList();
            elements['style-preview-category'].textContent = style.category;
            elements['style-preview-name'].textContent = style.name;
            elements['style-preview-description'].textContent =
                style.description;
            elements['style-preview-targets'].textContent =
                `适用：${style.targets.join(' / ')}`;
            elements['style-apply-btn'].disabled = false;
            preview(style);
            return true;
        }

        function open() {
            const editor = currentEditor();
            if (!editor?.selectionState?.()?.range) {
                notificationPort.show?.('请先选择一段文字。', 'info');
                return false;
            }

            // “高级样式”按钮位于文字右键菜单内部，点击它不会触发菜单的
            // 外部 pointerdown 自动关闭逻辑。模态窗口打开前显式收起菜单，
            // 避免浮层继续拦截交互或遮挡样式库。
            if (elements['text-context-menu']) {
                elements['text-context-menu'].hidden = true;
            }
            elements['style-library-dialog'].hidden = false;
            populateCategories();
            renderList();
            const first = stylesForCurrentSelection()[0];
            if (first) select(first.id);
            return true;
        }

        function close() {
            if (elements['style-library-dialog']) {
                elements['style-library-dialog'].hidden = true;
            }
        }

        function apply() {
            const style = styleLibrary.get(selectedStyleId);
            if (!style) return false;
            const applied = currentEditor()?.executeFormatting?.(
                'advanced-style',
                {
                    id: style.id,
                    className: style.className,
                    targets: style.targets,
                },
                { preferSaved: true }
            );
            if (!applied) {
                notificationPort.show?.(
                    '当前选区无法应用高级样式。',
                    'error'
                );
                return false;
            }
            context.onStyleUsed?.(style);
            close();
            notificationPort.show?.(
                `已应用高级样式 · ${style.name}`,
                'success'
            );
            return true;
        }

        async function importPack(file) {
            if (!file) return false;
            try {
                const pack = styleLibrary.parsePack(await file.text());
                const result = styleLibrary.registerPack(pack, {
                    conflict: 'replace',
                });
                await persist();
                populateCategories();
                renderList();
                notificationPort.show?.(
                    `已导入 ${result.styles.length} 个高级样式`,
                    'success'
                );
                return true;
            } catch (error) {
                notificationPort.show?.(
                    `样式包导入失败：${error.message}`,
                    'error',
                    5000
                );
                return false;
            } finally {
                if (elements['style-import-input']) {
                    elements['style-import-input'].value = '';
                }
            }
        }

        function exportPack() {
            try {
                const content = styleLibrary.serializePack(null, {
                    id: `vcp.user.${Date.now().toString(36)}`,
                    name: 'Scriptorium 高级样式集',
                    author: 'Human + AI',
                });
                const url = URL.createObjectURL(new Blob(
                    [content],
                    { type: 'application/json' }
                ));
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `scriptorium-styles-${
                    new Date().toISOString().slice(0, 10)
                }.vstyle.json`;
                anchor.click();
                URL.revokeObjectURL(url);
                return true;
            } catch (error) {
                notificationPort.show?.(
                    `样式包导出失败：${error.message}`,
                    'error'
                );
                return false;
            }
        }

        function bind() {
            abortController?.abort();
            abortController = new AbortController();
            const options = { signal: abortController.signal };
            elements['advanced-style-btn']?.addEventListener(
                'mousedown',
                (event) => event.preventDefault(),
                options
            );
            elements['advanced-style-btn']?.addEventListener(
                'click',
                open,
                options
            );
            elements['style-library-close-btn']?.addEventListener(
                'click',
                close,
                options
            );
            elements['style-search-input']?.addEventListener(
                'input',
                renderList,
                options
            );
            elements['style-category-select']?.addEventListener(
                'change',
                renderList,
                options
            );
            elements['style-apply-btn']?.addEventListener(
                'click',
                apply,
                options
            );
            elements['style-import-btn']?.addEventListener(
                'click',
                () => elements['style-import-input']?.click(),
                options
            );
            elements['style-import-input']?.addEventListener(
                'change',
                (event) => importPack(event.target.files?.[0]),
                options
            );
            elements['style-export-btn']?.addEventListener(
                'click',
                exportPack,
                options
            );
            libraryDisposer?.();
            libraryDisposer = styleLibrary.subscribe?.(() => {
                if (!elements['style-library-dialog']?.hidden) {
                    populateCategories();
                    renderList();
                }
            });
            initialize();
            return api;
        }

        function dispose() {
            if (disposed) return;
            abortController?.abort();
            libraryDisposer?.();
            close();
            editorPort = null;
            disposed = true;
        }

        const api = Object.freeze({
            initialize,
            persist,
            setEditorPort,
            open,
            close,
            select,
            apply,
            renderList,
            importPack,
            exportPack,
            bind,
            dispose,
        });
        return api;
    }

    window.ScriptoriumStyleUi = Object.freeze({
        createStyleUiController,
    });
})();