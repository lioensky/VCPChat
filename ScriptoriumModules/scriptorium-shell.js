'use strict';

(() => {
    function createShell(context = {}) {
        const elements = {};
        const controllers = new Set();
        let abortController = null;
        let documentDisposer = null;
        let themeDisposer = null;
        let mode = 'edit';
        let rightSourceMode = null;
        let rightSourceOpenedMode = null;
        let zoom = 100;
        let focusMode = false;
        let scrollDocumentId = null;
        let scrollRestoreToken = 0;
        const scrollPositions = new Map();
        let islandContext = null;
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

        function updateMetrics() {
            const text = String(context.metricsPort?.text?.() || '');
            const compact = text.replace(/\s/gu, '');
            const cjkCharacters = (
                text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []
            ).length;
            const nonCjkWords = (
                text
                    .replace(/[\u3400-\u9fff\uf900-\ufaff]/gu, ' ')
                    .match(/[\p{L}\p{N}]+/gu) || []
            ).length;
            if (elements['word-count']) {
                elements['word-count'].textContent =
                    `${cjkCharacters + nonCjkWords} 字`;
            }
            if (elements['character-count']) {
                elements['character-count'].textContent =
                    `${Array.from(compact).length} 字符`;
            }
        }

        function updateDocumentStatus() {
            updateIdentity();
            updateMetrics();
            updateSourceMirror();
        }

        function updateIdentity() {
            const status = context.documentPort.status();
            const homeVisible = elements['welcome-state']?.hidden === false;
            const name = homeVisible
                ? ''
                : status.currentName || '未命名文稿.vdocx';
            const location = homeVisible
                ? ''
                : status.currentPath || '尚未保存到磁盘';
            if (elements['document-title']) {
                elements['document-title'].textContent = name;
                elements['document-title'].title = location;
            }
            if (elements['focus-document-title']) {
                elements['focus-document-title'].textContent = name;
                elements['focus-document-title'].title = location;
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
            syncFocusModeControls();
        }

        function canUseFocusMode() {
            const status = context.documentPort.status();
            const documentModel = context.documentPort.document?.();
            const isDeck = documentModel?.manifest?.scene?.kind
                === context.core.PROJECT_KINDS.SLIDE_DECK;
            const workspaceVisible =
                elements['document-workspace']?.hidden === false;
            return status.ready
                && workspaceVisible
                && !isDeck
                && (mode === 'edit' || mode === 'read');
        }

        function setFocusMode(active, options = {}) {
            const next = active === true && canUseFocusMode();
            focusMode = next;
            document.body.classList.toggle('focus-mode', next);
            elements['focus-mode-btn']?.setAttribute(
                'aria-pressed',
                String(next)
            );
            if (elements['focus-mode-dock']) {
                elements['focus-mode-dock'].hidden = !next;
            }
            if (next && options.focusDock !== false) {
                elements['focus-exit-btn']?.focus({ preventScroll: true });
            }
            return next;
        }

        function syncFocusModeControls() {
            const available = canUseFocusMode();
            if (!available && focusMode) {
                setFocusMode(false, { focusDock: false });
            }
            if (elements['focus-mode-btn']) {
                elements['focus-mode-btn'].hidden = !available;
                elements['focus-mode-btn'].setAttribute(
                    'aria-pressed',
                    String(focusMode)
                );
            }
            if (elements['focus-mode-dock']) {
                elements['focus-mode-dock'].hidden = !focusMode;
            }
            return available;
        }

        function surfaceMode() {
            return mode;
        }

        function updateSourceMirror(options = {}) {
            const host = elements['source-right-host'];
            if (!host) return false;
            const active = mode === 'edit' && rightSourceMode;
            host.hidden = !active;
            if (!active) return false;
            const isCss = rightSourceMode === 'source-css';
            const sourceMode = isCss ? 'css' : 'html';
            const shouldOpen = options.open === true
                || rightSourceOpenedMode !== rightSourceMode;
            if (shouldOpen) {
                context.sourceRightPort?.open?.(
                    sourceMode,
                    { focus: false }
                );
                rightSourceOpenedMode = rightSourceMode;
            } else {
                context.sourceRightPort?.syncFromModel?.({
                    preserveCursor: true,
                });
            }
            return true;
        }

        function closeRightSurface() {
            if (!rightSourceMode) return false;
            rightSourceMode = null;
            rightSourceOpenedMode = null;
            const host = elements['source-right-host'];
            if (host) host.hidden = true;
            syncSurfaceButtons();
            return true;
        }

        function setRightSourceMode(nextMode) {
            if (mode !== 'edit') {
                showToast('只有左侧为连续编辑时才能开启右侧源码', 'info');
                return false;
            }
            const normalized = nextMode === 'source-css'
                ? 'source-css'
                : nextMode === 'source-html'
                    ? 'source-html'
                    : null;
            if (!normalized) return false;
            if (rightSourceMode === normalized) {
                return closeRightSurface();
            }
            rightSourceMode = normalized;
            updateSourceMirror({ open: true });
            syncSurfaceButtons();
            return true;
        }

        function syncSurfaceButtons() {
            [
                ['render', mode === 'edit'],
                ['read', mode === 'read'],
                ['html', mode === 'source-html'],
                ['css', mode === 'source-css'],
            ].forEach(([name, active]) => {
                const button = elements[`${name}-mode-btn`];
                button?.classList.toggle('active', active);
                button?.classList.toggle(
                    'right-surface',
                    rightSourceMode === `source-${name}`
                );
                button?.setAttribute('aria-pressed', String(active));
            });
            elements['html-mode-btn']?.classList.toggle(
                'right-surface',
                rightSourceMode === 'source-html'
            );
            elements['css-mode-btn']?.classList.toggle(
                'right-surface',
                rightSourceMode === 'source-css'
            );
        }

        function resetScrollPositionsIfDocumentChanged() {
            const documentId = context.documentPort.status().documentId || null;
            if (documentId === scrollDocumentId) return;
            scrollDocumentId = documentId;
            scrollPositions.clear();
            scrollRestoreToken += 1;
        }

        function captureScrollPosition(surfaceMode = mode) {
            resetScrollPositionsIfDocumentChanged();
            if (surfaceMode === 'edit' || surfaceMode === 'read') {
                const host = elements[
                    surfaceMode === 'read' ? 'read-host' : 'render-host'
                ];
                if (!host) return false;
                scrollPositions.set(surfaceMode, {
                    left: host.scrollLeft,
                    top: host.scrollTop,
                });
                return true;
            }
            if (!surfaceMode.startsWith('source-')) return false;
            const editor = context.sourcePort?.editor?.();
            const info = editor?.getScrollInfo?.();
            if (!info) return false;
            scrollPositions.set(surfaceMode, {
                left: info.left,
                top: info.top,
            });
            return true;
        }

        function restoreScrollPosition(surfaceMode = mode) {
            resetScrollPositionsIfDocumentChanged();
            const position = scrollPositions.get(surfaceMode);
            if (!position) return false;
            const token = ++scrollRestoreToken;
            window.setTimeout(() => {
                if (disposed || mode !== surfaceMode
                    || token !== scrollRestoreToken) {
                    return;
                }
                if (surfaceMode === 'edit' || surfaceMode === 'read') {
                    const host = elements[
                        surfaceMode === 'read' ? 'read-host' : 'render-host'
                    ];
                    host?.scrollTo?.({
                        left: position.left,
                        top: position.top,
                        behavior: 'auto',
                    });
                    return;
                }
                context.sourcePort?.editor?.()?.scrollTo?.(
                    position.left,
                    position.top
                );
            }, 0);
            return true;
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
            setFocusMode,
            refreshControls: syncFocusModeControls,
            renderRead: (options) =>
                context.renderPort.renderRead(options),
            disposeRead: () =>
                context.renderPort.disposeSurface('read'),
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
            resetScrollPositionsIfDocumentChanged();
            context.editorResolver?.()?.flush?.();
            if (normalized !== mode) {
                context.historyPort?.finalize?.({
                    reason: 'surface-history-finalized',
                });
                captureScrollPosition(mode);
                scrollRestoreToken += 1;
            }
            mode = normalized;
            if (mode !== 'edit' && rightSourceMode) {
                rightSourceMode = null;
                rightSourceOpenedMode = null;
                elements['source-right-host'].hidden = true;
            }
            context.historyPort?.activate?.(undefined, {
                reason: 'surface-history-activated',
            });
            context.renderPort.setMode(normalized);
            const edit = normalized === 'edit';
            const read = normalized === 'read';
            const source = normalized.startsWith('source-');
            elements['render-host'].hidden = !edit;
            elements['read-host'].hidden = !read;
            elements['source-host'].hidden = !source;
            syncSurfaceButtons();
            if (edit) context.renderPort.renderEdit({
                force: options.force === true,
            });
            else if (read) context.renderPort.renderRead({
                force: options.force === true,
            });
            else context.sourcePort?.open?.(
                normalized === 'source-html' ? 'html' : 'css',
                { focus: true }
            );
            restoreScrollPosition(normalized);
            updateSourceMirror();
            syncFocusModeControls();
            context.findPort?.refresh?.();
            return true;
        }

        function syncSettingsControls() {
            const trusted =
                context.settingsPort?.get?.('trustNetworkFonts') === true;
            if (elements['trust-network-fonts-toggle']) {
                elements['trust-network-fonts-toggle'].checked = trusted;
            }
            if (elements['network-font-trust-status']) {
                elements['network-font-trust-status'].textContent = trusted
                    ? '已信任：直接使用并导出 HTTPS 字体 URL'
                    : '受控模式：下载字体并收纳到本地工程';
                elements['network-font-trust-status'].classList.toggle(
                    'trusted',
                    trusted
                );
            }
            return trusted;
        }

        function setSettingsOpen(open) {
            if (!elements['settings-dialog']) return false;
            elements['settings-dialog'].hidden = !open;
            elements['settings-btn']?.setAttribute(
                'aria-expanded',
                String(open)
            );
            if (open) {
                syncSettingsControls();
                elements['settings-close-btn']?.focus({
                    preventScroll: true,
                });
            }
            return open;
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

        function hideIslandContextMenu() {
            const menu = elements['island-context-menu'];
            if (menu) menu.hidden = true;
            islandContext = null;
        }

        function showIslandContextMenu(x, y, payload = {}) {
            const menu = elements['island-context-menu'];
            if (!menu || !Number.isFinite(Number(payload.sourceOffset))) {
                return false;
            }
            islandContext = {
                islandId: String(payload.islandId || ''),
                sourceOffset: Number(payload.sourceOffset),
            };
            menu.hidden = false;
            const width = 202;
            const height = 58;
            menu.style.left = `${Math.max(
                8,
                Math.min(innerWidth - width - 8, Number(x) || 8)
            )}px`;
            menu.style.top = `${Math.max(
                8,
                Math.min(innerHeight - height - 8, Number(y) || 8)
            )}px`;
            return true;
        }

        function locateIslandSource() {
            const target = islandContext;
            hideIslandContextMenu();
            if (!target) return false;
            if (!switchMode('source-html')) return false;
            window.setTimeout(() => {
                if (disposed) return;
                context.sourcePort?.revealOffset?.(target.sourceOffset);
            }, 30);
            return true;
        }

        function bindControls() {
            abortController = new AbortController();
            const options = { signal: abortController.signal };
            const click = (id, handler) =>
                elements[id]?.addEventListener('click', handler, options);
            const startMenu = elements['start-menu'];
            const startMenuButton = elements['start-menu-btn'];
            const startMenuDropdown = elements['start-menu-dropdown'];
            let startMenuCloseTimer = null;

            const setStartMenuOpen = (open) => {
                window.clearTimeout(startMenuCloseTimer);
                startMenu?.classList.toggle('open', open);
                if (startMenuDropdown) startMenuDropdown.hidden = !open;
                startMenuButton?.setAttribute('aria-expanded', String(open));
            };
            const scheduleStartMenuClose = () => {
                window.clearTimeout(startMenuCloseTimer);
                startMenuCloseTimer = window.setTimeout(
                    () => setStartMenuOpen(false),
                    180
                );
            };
            const runStartMenuAction = (action) => {
                setStartMenuOpen(false);
                return action();
            };

            startMenu?.addEventListener(
                'mouseenter',
                () => setStartMenuOpen(true),
                options
            );
            startMenu?.addEventListener(
                'mouseleave',
                scheduleStartMenuClose,
                options
            );
            startMenuDropdown?.addEventListener(
                'mouseenter',
                () => setStartMenuOpen(true),
                options
            );
            startMenuDropdown?.addEventListener(
                'mouseleave',
                scheduleStartMenuClose,
                options
            );
            startMenuButton?.addEventListener('click', (event) => {
                event.stopPropagation();
                setStartMenuOpen(!startMenu?.classList.contains('open'));
            }, options);
            document.addEventListener('click', (event) => {
                const target = event.target;
                if (!startMenu?.contains(target)
                    && !startMenuDropdown?.contains(target)) {
                    setStartMenuOpen(false);
                }
                if (!elements['island-context-menu']?.contains(target)) {
                    hideIslandContextMenu();
                }
            }, options);
            elements['island-context-menu']?.addEventListener(
                'click',
                (event) => {
                    if (event.target.closest('[data-island-action="source"]')) {
                        locateIslandSource();
                    }
                },
                options
            );

            click('minimize-btn', context.persistencePort.minimizeWindow);
            click('maximize-btn', context.persistencePort.maximizeWindow);
            click('close-btn', () => context.sessionPort.close());
            click('settings-btn', () => setSettingsOpen(true));
            click('settings-close-btn', () => setSettingsOpen(false));
            elements['settings-dialog']?.addEventListener('click', (event) => {
                if (event.target === elements['settings-dialog']) {
                    setSettingsOpen(false);
                }
            }, options);
            elements['trust-network-fonts-toggle']?.addEventListener(
                'change',
                (event) => {
                    const trusted = context.settingsPort?.set?.(
                        'trustNetworkFonts',
                        event.target.checked
                    ) === true;
                    syncSettingsControls();
                    context.renderPort.invalidate('network-font-trust-changed');
                    context.renderPort.renderCurrent?.({ force: true });
                    showToast(
                        trusted
                            ? '已信任网络字体；渲染和导出将直接使用 HTTPS URL'
                            : '已恢复网络字体本地化与便携导出',
                        trusted ? 'info' : 'success',
                        4200
                    );
                },
                options
            );
            click('new-btn', () =>
                runStartMenuAction(() => context.sessionPort.create())
            );
            click('new-deck-btn', () =>
                runStartMenuAction(() => context.sessionPort.createDeck())
            );
            click('home-btn', () =>
                runStartMenuAction(() => context.sessionPort.showHome())
            );
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

            ['html-mode-btn', 'css-mode-btn'].forEach((id) => {
                elements[id]?.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    setRightSourceMode(
                        id === 'css-mode-btn'
                            ? 'source-css'
                            : 'source-html'
                    );
                }, options);
            });
            click('format-source-btn', () => context.sourcePort?.format?.());
            click('insert-media-btn', () => context.mediaPort?.open?.());
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
            click('focus-mode-btn', () => setFocusMode(true));
            click('focus-exit-btn', () => setFocusMode(false));

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
                    if (elements['settings-dialog']?.hidden === false) {
                        event.preventDefault();
                        setSettingsOpen(false);
                    }
                    if (focusMode) {
                        event.preventDefault();
                        setFocusMode(false);
                    }
                    setStartMenuOpen(false);
                    hideIslandContextMenu();
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
                updateDocumentStatus
            ) || null;
            updateDocumentStatus();
            syncFocusModeControls();
            syncSettingsControls();
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
            captureScrollPosition(mode);
            scrollRestoreToken += 1;
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
            updateMetrics,
            switchMode,
            setRightSourceMode,
            closeRightSurface,
            showIslandContextMenu,
            hideIslandContextMenu,
            setFocusMode,
            syncFocusModeControls,
            updateZoom,
            initialize,
            dispose,
        });
    }

    window.ScriptoriumShell = Object.freeze({
        createShell,
    });
})();