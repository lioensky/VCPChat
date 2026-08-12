'use strict';

(() => {
    function createShell(context = {}) {
        const elements = {};
        const controllers = new Set();
        let abortController = null;
        let documentDisposer = null;
        let themeDisposer = null;
        let mode = 'edit';
        let zoom = 100;
        let disposed = false;

        function cacheElements() {
            document.querySelectorAll('[id]').forEach((element) => {
                elements[element.id] = element;
            });
            return elements;
        }

        function showToast(message, type = 'info', duration = 2600) {
            const region = elements['toast-region'];
            if (!region) return;
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.textContent = message;
            region.appendChild(toast);
            window.setTimeout(() => {
                toast.style.opacity = '0';
                window.setTimeout(() => toast.remove(), 180);
            }, duration);
        }

        const notificationPort = Object.freeze({
            show: showToast,
        });

        function register(controller) {
            if (controller) controllers.add(controller);
            return controller;
        }

        function updateIdentity() {
            const status = context.documentPort.status();
            const name = status.currentName || '未命名文稿.vdocx';
            if (elements['document-title']) {
                elements['document-title'].textContent = name;
                elements['document-title'].title =
                    status.currentPath || '尚未保存到磁盘';
            }
            if (elements['focus-document-title']) {
                elements['focus-document-title'].textContent = name;
            }
            if (elements['save-state']) {
                elements['save-state'].textContent = status.loading
                    ? '正在展开'
                    : status.saving
                        ? '正在保存'
                        : status.dirty
                            ? '有未保存修改'
                            : status.ready
                                ? '已保存'
                                : '等待落笔';
            }
            elements['document-state-dot']?.classList.toggle(
                'dirty',
                status.dirty && !status.saving
            );
            elements['document-state-dot']?.classList.toggle(
                'saved',
                status.ready && !status.dirty
            );
            [
                'save-btn',
                'save-as-btn',
                'export-flow-html-btn',
                'export-paged-html-btn',
                'export-pdf-btn',
                'create-checkpoint-btn',
            ].forEach((id) => {
                if (elements[id]) {
                    elements[id].disabled = !status.ready || status.saving;
                }
            });
        }

        function surfaceMode() {
            return mode;
        }

        function activeRoot() {
            return mode === 'read'
                ? elements['read-page-stream']?.shadowRoot
                : elements['page-stream']?.shadowRoot;
        }

        const surfacePort = Object.freeze({
            mode: surfaceMode,
            activeRoot,
            editRoot: () => elements['page-stream']?.shadowRoot,
            readRoot: () => elements['read-page-stream']?.shadowRoot,
            sourceEditor: () => context.sourcePort?.editor?.() || null,
            switchMode: (nextMode, options) => switchMode(nextMode, options),
            renderRead: (options) =>
                context.renderPort.renderRead(options),
        });

        function switchMode(nextMode, options = {}) {
            if (!context.documentPort.status().ready) return false;
            const normalized = {
                render: 'edit',
                html: 'source-html',
                css: 'source-css',
            }[nextMode] || nextMode;
            if (!['edit', 'read', 'source-html', 'source-css'].includes(normalized)) {
                return false;
            }
            context.editorResolver?.()?.flush?.();
            mode = normalized;
            context.renderPort.setMode(normalized);
            const edit = normalized === 'edit';
            const read = normalized === 'read';
            const source = normalized.startsWith('source-');
            elements['render-host'].hidden = !edit;
            elements['read-host'].hidden = !read;
            elements['source-host'].hidden = !source;
            [
                ['render', edit],
                ['read', read],
                ['html', normalized === 'source-html'],
                ['css', normalized === 'source-css'],
            ].forEach(([name, active]) => {
                const button = elements[`${name}-mode-btn`];
                button?.classList.toggle('active', active);
                button?.setAttribute('aria-pressed', String(active));
            });
            if (edit) context.renderPort.renderEdit({
                force: options.force === true,
            });
            else if (read) context.renderPort.renderRead({
                force: options.force === true,
            });
            else context.sourcePort?.open?.(
                normalized === 'source-html' ? 'html' : 'css'
            );
            context.findPort?.refresh?.();
            return true;
        }

        function updateZoom(value) {
            zoom = context.renderPort.setZoom(value);
            if (elements['zoom-range']) {
                elements['zoom-range'].value = String(zoom);
            }
            if (elements['zoom-value']) {
                elements['zoom-value'].textContent = `${zoom}%`;
            }
            return zoom;
        }

        function bindControls() {
            abortController = new AbortController();
            const options = { signal: abortController.signal };
            const click = (id, handler) =>
                elements[id]?.addEventListener('click', handler, options);

            click('minimize-btn', context.persistencePort.minimizeWindow);
            click('maximize-btn', context.persistencePort.maximizeWindow);
            click('close-btn', () => context.sessionPort.close());
            click('new-btn', () => context.sessionPort.create());
            click('new-deck-btn', () => context.sessionPort.createDeck());
            click('welcome-new-btn', () => context.sessionPort.create());
            click('open-btn', () => context.sessionPort.open());
            click('welcome-open-btn', () => context.sessionPort.open());
            click('import-btn', () => context.sessionPort.import());
            click('save-btn', () => context.sessionPort.save(false));
            click('save-as-btn', () => context.sessionPort.save(true));
            click('export-flow-html-btn', () =>
                context.exportPort.execute('html-flow')
            );
            click('export-paged-html-btn', () =>
                context.exportPort.execute('html-paged')
            );
            click('export-pdf-btn', () =>
                context.exportPort.execute('pdf')
            );
            click('render-mode-btn', () => switchMode('edit'));
            click('read-mode-btn', () => switchMode('read'));
            click('html-mode-btn', () => switchMode('source-html'));
            click('css-mode-btn', () => switchMode('source-css'));
            click('format-source-btn', () => context.sourcePort?.format?.());
            click('insert-block-btn', () =>
                context.editorResolver?.()?.insertStructure?.(
                    elements['block-type-select']?.value || 'paragraph'
                )
            );
            click('insert-table-btn', () =>
                context.editorResolver?.()?.insertStructure?.('table')
            );
            click('zoom-out-btn', () => updateZoom(zoom - 10));
            click('zoom-in-btn', () => updateZoom(zoom + 10));
            elements['zoom-range']?.addEventListener(
                'input',
                (event) => updateZoom(event.target.value),
                options
            );
            click('outline-toggle-btn', () =>
                document.body.classList.toggle('outline-collapsed')
            );
            click('lineage-toggle-btn', () =>
                document.body.classList.toggle('lineage-collapsed')
            );

            window.addEventListener('keydown', (event) => {
                const modifier = event.ctrlKey || event.metaKey;
                const key = event.key.toLowerCase();
                if (modifier && key === 's') {
                    event.preventDefault();
                    context.sessionPort.save(event.shiftKey);
                } else if (modifier && key === 'o') {
                    event.preventDefault();
                    context.sessionPort.open();
                } else if (modifier && key === 'n') {
                    event.preventDefault();
                    context.sessionPort.create();
                } else if (modifier && key === 'z') {
                    event.preventDefault();
                    context.historyPort.execute(event.shiftKey ? 'redo' : 'undo');
                } else if (modifier && key === 'y') {
                    event.preventDefault();
                    context.historyPort.execute('redo');
                } else if (modifier && key === 'f') {
                    event.preventDefault();
                    context.findPort?.open?.();
                } else if (event.key === 'Escape') {
                    context.findPort?.close?.();
                    context.mediaPort?.close?.();
                    context.stylePort?.close?.();
                }
            }, options);
        }

        async function initialize() {
            cacheElements();
            context.bindElements?.(elements, notificationPort, surfacePort);
            bindControls();
            controllers.forEach((controller) => controller.bind?.());
            documentDisposer?.();
            documentDisposer = context.documentPort.subscribe(
                '*',
                updateIdentity
            ) || null;
            updateIdentity();
            try {
                document.body.classList.toggle(
                    'light-theme',
                    await context.persistencePort.getCurrentTheme() === 'light'
                );
            } catch {}
            themeDisposer?.();
            themeDisposer = context.persistencePort.onThemeUpdated?.((theme) =>
                document.body.classList.toggle('light-theme', theme === 'light')
            ) || null;
            await context.onInitialize?.();
            context.persistencePort.windowReady?.({
                surface: 'scriptorium',
                version: 3,
                format: context.core.FORMAT,
            });
        }

        function dispose() {
            if (disposed) return;
            abortController?.abort();
            documentDisposer?.();
            themeDisposer?.();
            abortController = null;
            documentDisposer = null;
            themeDisposer = null;
            [...controllers].reverse().forEach((controller) => {
                try {
                    controller.dispose?.();
                } catch (error) {
                    console.error('[ScriptoriumShell] dispose failed:', error);
                }
            });
            controllers.clear();
            disposed = true;
        }

        return Object.freeze({
            elements,
            notificationPort,
            surfacePort,
            register,
            cacheElements,
            updateIdentity,
            switchMode,
            updateZoom,
            initialize,
            dispose,
        });
    }

    window.ScriptoriumShell = Object.freeze({
        createShell,
    });
})();