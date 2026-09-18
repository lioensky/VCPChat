'use strict';

(() => {
    const api = window.chartAPI;
    const mode = new URLSearchParams(window.location.search).get('mode') || 'workbench';
    const isFloating = mode === 'floating';
    const elements = {
        detached: document.getElementById('detachedState'),
        detach: document.getElementById('detachChartButton'),
        globalStatus: document.getElementById('globalStatus'),
        chartCount: document.getElementById('chartCount'),
        chartList: document.getElementById('chartList'),
        search: document.getElementById('chartSearchInput'),
        host: document.getElementById('chartFrame'),
        empty: document.getElementById('emptyState'),
        overlay: document.getElementById('runtimeOverlay'),
        overlayTitle: document.getElementById('overlayTitle'),
        overlayDescription: document.getElementById('overlayDescription'),
        errorPanel: document.getElementById('errorPanel'),
        errorMessage: document.getElementById('errorMessage'),
        title: document.getElementById('chartTitle'),
        meta: document.getElementById('chartMeta'),
        badge: document.getElementById('runtimeBadge'),
        reload: document.getElementById('reloadChartButton'),
        contextMenu: document.getElementById('chartContextMenu'),
        toastRegion: document.getElementById('toastRegion'),
    };

    const state = {
        charts: [],
        selectedId: null,
        snapshot: null,
        generation: 0,
        runtimeStatus: 'idle',
        diagnostics: null,
        runtime: null,
        loadTimer: null,
        unsubscribers: [],
        resizeObserver: null,
        contextChartId: null,
        floatingIds: new Set(),
        transferring: new Set(),
        mountPromise: null,
        releasePromise: Promise.resolve(),
    };

    const ICON = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 3v18h18"></path>
            <path d="m7 16 4-5 4 3 5-7"></path>
        </svg>
    `;

    function escapeHtml(value) {
        const node = document.createElement('span');
        node.textContent = String(value ?? '');
        return node.innerHTML;
    }

    function showToast(message, type = '') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`.trim();
        toast.textContent = message;
        elements.toastRegion.appendChild(toast);
        setTimeout(() => toast.remove(), 3200);
    }

    function setGlobalStatus(text) {
        elements.globalStatus.textContent = text;
    }

    function reportStatus(status, description = '') {
        state.runtimeStatus = status;
        const labels = {
            idle: '未加载',
            loading: '加载中',
            mounting: '挂载中',
            ready: '已就绪',
            busy: '更新中',
            stable: '稳定',
            error: '错误',
            destroyed: '已销毁',
        };
        elements.badge.className = `runtime-badge ${status}`;
        elements.badge.textContent = labels[status] || status;
        if (description) setGlobalStatus(description);
        api?.reportRuntimeStatus?.({
            chartId: state.selectedId,
            status,
            description,
            stable: status === 'stable',
            diagnostics: state.diagnostics,
            generation: state.generation,
            codeRevision: state.snapshot?.manifest?.codeRevision,
            dataRevision: state.snapshot?.manifest?.dataRevision,
        });
    }

    function setLoading(loading, description = '准备本地渲染依赖…') {
        elements.overlay.hidden = !loading;
        elements.overlayTitle.textContent = '正在加载图表';
        elements.overlayDescription.textContent = description;
    }

    function clearError() {
        elements.errorPanel.hidden = true;
        elements.errorMessage.textContent = '';
    }

    function showError(error) {
        const message = error?.stack || error?.message || String(error);
        elements.errorMessage.textContent = message;
        elements.errorPanel.hidden = false;
        setLoading(false);
        reportStatus('error', '图表运行时错误');
        api?.reportRuntimeError?.({
            chartId: state.selectedId,
            generation: state.generation,
            message,
            diagnostics: state.diagnostics,
        });
    }

    function hideContextMenu() {
        elements.contextMenu.hidden = true;
        state.contextChartId = null;
    }

    function showContextMenu(chartId, clientX, clientY) {
        state.contextChartId = chartId;
        elements.contextMenu.hidden = false;
        const rect = elements.contextMenu.getBoundingClientRect();
        const margin = 8;
        elements.contextMenu.style.left = `${Math.max(
            margin,
            Math.min(clientX, window.innerWidth - rect.width - margin)
        )}px`;
        elements.contextMenu.style.top = `${Math.max(
            margin,
            Math.min(clientY, window.innerHeight - rect.height - margin)
        )}px`;
        elements.contextMenu.querySelector('button:not([disabled])')?.focus();
    }

    function chartById(chartId) {
        return state.charts.find(chart => chart.id === chartId) || null;
    }

    async function editChart(chartId) {
        const chart = chartById(chartId);
        if (!chart) {
            showToast('图表已不存在，请刷新列表。', 'error');
            return;
        }
        try {
            await api.openChartInCanvas({ chartId: chart.id });
            showToast(`已在 Canvas 中打开“${chart.name || chart.id}”`, 'success');
        } catch (error) {
            showToast(`无法打开 Canvas：${error.message || String(error)}`, 'error');
        }
    }

    async function deleteChart(chartId) {
        const chart = chartById(chartId);
        if (!chart) {
            showToast('图表已不存在，请刷新列表。', 'error');
            return;
        }
        const displayName = chart.name || chart.id;
        if (!window.confirm(`确定删除图表“${displayName}”吗？\n\n图表将移入回收区，可由图表服务恢复。`)) {
            return;
        }
        try {
            await api.deleteChart({
                chartId: chart.id,
                expectedRevision: chart.revision,
            });
            if (state.selectedId === chart.id) await resetStage();
            await refreshCharts();
            showToast(`已删除图表“${displayName}”`, 'success');
        } catch (error) {
            showToast(`删除失败：${error.message || String(error)}`, 'error');
            await refreshCharts();
        }
    }

    function filteredCharts() {
        const query = elements.search.value.trim().toLowerCase();
        if (!query) return state.charts;
        return state.charts.filter(chart =>
            `${chart.id} ${chart.name} ${chart.description || ''}`.toLowerCase().includes(query)
        );
    }

    function renderList() {
        const charts = filteredCharts();
        elements.chartCount.textContent = String(state.charts.length);
        elements.chartList.replaceChildren();
        if (!charts.length) {
            const placeholder = document.createElement('div');
            placeholder.className = 'list-placeholder';
            placeholder.textContent = state.charts.length
                ? '没有匹配的图表'
                : '暂无图表。Agent 创建图表后会自动显示在这里。';
            elements.chartList.appendChild(placeholder);
            return;
        }

        charts.forEach(chart => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `chart-list-item${chart.id === state.selectedId ? ' active' : ''}`;
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', chart.id === state.selectedId ? 'true' : 'false');
            button.innerHTML = `
                <span class="chart-item-icon">${ICON}</span>
                <span class="chart-item-copy">
                    <strong>${escapeHtml(chart.name || chart.id)}</strong>
                    <small>${escapeHtml(chart.id)}${state.floatingIds.has(chart.id) ? ' · 独立展示中' : ''}</small>
                </span>
            `;
            button.addEventListener('click', () => {
                hideContextMenu();
                selectChart(chart.id);
            });
            button.addEventListener('contextmenu', event => {
                event.preventDefault();
                event.stopPropagation();
                if (state.selectedId !== chart.id) selectChart(chart.id);
                showContextMenu(chart.id, event.clientX, event.clientY);
            });
            elements.chartList.appendChild(button);
        });
    }

    async function refreshCharts() {
        try {
            const result = await api.listCharts();
            state.charts = Array.isArray(result) ? result : result?.charts || [];
            renderList();
            setGlobalStatus(`${state.charts.length} 个图表`);
            if (state.selectedId && !state.charts.some(chart => chart.id === state.selectedId)) {
                await resetStage();
            }
        } catch (error) {
            setGlobalStatus('读取图表列表失败');
            showToast(error.message || String(error), 'error');
        }
    }

    function isDetached(chartId = state.selectedId) {
        return mode === 'workbench'
            && (state.floatingIds.has(chartId) || state.transferring.has(chartId));
    }

    async function releaseRuntime() {
        clearTimeout(state.loadTimer);
        state.loadTimer = null;
        const runtime = state.runtime;
        const mounting = state.mountPromise;
        state.runtime = null;
        state.mountPromise = null;
        const previous = state.releasePromise;
        state.releasePromise = (async () => {
            await previous;
            try { await mounting; } catch (_error) {}
            await runtime?.destroy?.(false);
        })();
        await state.releasePromise;
    }

    async function showDetached(chartId) {
        const generation = ++state.generation;
        state.selectedId = chartId;
        state.snapshot = null;
        await releaseRuntime();
        if (generation !== state.generation) return;
        elements.host.hidden = true;
        elements.empty.hidden = true;
        elements.detached.hidden = false;
        elements.reload.disabled = true;
        elements.detach.disabled = true;
        elements.title.textContent = chartById(chartId)?.name || chartId;
        elements.meta.textContent = chartId;
        clearError();
        setLoading(false);
        elements.badge.className = 'runtime-badge stable';
        elements.badge.textContent = '独立展示中';
        setGlobalStatus('图表正在悬浮窗中独立运行');
        renderList();
    }

    async function detachChart(chartId) {
        if (!chartId || state.transferring.has(chartId)) return;
        if (state.floatingIds.has(chartId)) {
            await api.focusFloatingChart(chartId);
            return;
        }
        state.transferring.add(chartId);
        try {
            // Release the workbench renderer before creating the floating window.
            await showDetached(chartId);
            await api.detachChart(chartId);
        } catch (error) {
            showToast(`无法打开悬浮窗：${error.message || error}`, 'error');
        } finally {
            state.transferring.delete(chartId);
            await syncFloatingCharts(await api.getFloatingCharts());
        }
    }

    async function syncFloatingCharts(ids) {
        const wasDetached = isDetached();
        state.floatingIds = new Set(ids || []);
        renderList();
        if (mode !== 'workbench' || !state.selectedId) return;
        if (isDetached()) await showDetached(state.selectedId);
        else if (wasDetached || !elements.detached.hidden) {
            await selectChart(state.selectedId, { force: true });
        }
    }

    function createRuntime() {
        const generation = state.generation;
        return new window.VCPChartRuntime.ChartRuntime({
            host: elements.host,
            api,
            onStatus: ({ status, description, diagnostics }) => {
                if (generation !== state.generation) return;
                if (diagnostics) state.diagnostics = diagnostics;
                reportStatus(status, description);
                if (status === 'ready') setLoading(false);
            },
            onError: ({ message, diagnostics }) => {
                if (generation !== state.generation) return;
                state.diagnostics = diagnostics || null;
                showError(new Error(message));
            },
            onStable: ({ diagnostics }) => {
                if (generation !== state.generation) return;
                clearTimeout(state.loadTimer);
                state.loadTimer = null;
                state.diagnostics = diagnostics;
                setLoading(false);
                clearError();
                reportStatus('stable', '图表渲染稳定');
            },
            onEvent: ({ name, payload }) => {
                if (generation !== state.generation) return;
                api?.reportRuntimeEvent?.({ chartId: state.selectedId, name, payload });
            },
        });
    }

    async function resetStage() {
        const generation = ++state.generation;
        clearTimeout(state.loadTimer);
        state.loadTimer = null;
        await releaseRuntime();
        if (generation !== state.generation) return;
        elements.detached.hidden = true;
        elements.detach.disabled = true;
        state.selectedId = null;
        state.snapshot = null;
        state.diagnostics = null;
        elements.host.hidden = true;
        elements.empty.hidden = false;
        elements.title.textContent = '选择一个图表';
        elements.meta.textContent = '从左侧列表选择要展示的图表';
        elements.reload.disabled = true;
        clearError();
        setLoading(false);
        reportStatus('idle');
        renderList();
    }

    function updateMeta() {
        const manifest = state.snapshot?.manifest;
        if (!manifest) return;
        elements.title.textContent = manifest.name || manifest.id;
        elements.meta.textContent = [
            manifest.id,
            `代码 v${manifest.codeRevision}`,
            `数据 v${manifest.dataRevision}`,
            (manifest.libraries || []).join(' · '),
        ].filter(Boolean).join('  /  ');
    }

    async function selectChart(chartId, options = {}) {
        if (!chartId) return;
        if (isDetached(chartId)) return showDetached(chartId);
        if (!options.force && chartId === state.selectedId && state.snapshot) return;
        state.generation += 1;
        const generation = state.generation;
        state.selectedId = chartId;
        state.snapshot = null;
        elements.detached.hidden = true;
        elements.detach.disabled = false;
        renderList();
        clearError();
        setLoading(true);
        reportStatus('loading', `正在读取 ${chartId}`);
        elements.empty.hidden = true;
        elements.host.hidden = false;
        elements.reload.disabled = false;

        try {
            await releaseRuntime();
            if (generation !== state.generation) return;
            const snapshot = await api.getChartSnapshot(chartId);
            if (generation !== state.generation) return;
            state.snapshot = snapshot;
            updateMeta();
            state.runtime = createRuntime();
            state.loadTimer = setTimeout(() => {
                if (generation !== state.generation || state.runtimeStatus === 'stable') return;
                setLoading(false);
                showToast('图表尚未报告稳定，已保留当前渲染结果。', 'error');
                api.reportRuntimeStatus({
                    chartId,
                    status: state.runtimeStatus,
                    stable: false,
                    warning: 'stable-timeout',
                    generation,
                });
            }, 5000);
            state.mountPromise = state.runtime.mount(snapshot);
            await state.mountPromise;
        } catch (error) {
            if (generation === state.generation) showError(error);
        }
    }

    async function handleChartEvent(change) {
        await refreshCharts();
        if (!change || change.chartId !== state.selectedId) return;
        if (isDetached()) {
            await showDetached(state.selectedId);
            return;
        }
        if (change.type === 'deleted') {
            await resetStage();
            return;
        }
        if (['source-changed', 'manifest-changed', 'restored'].includes(change.type)) {
            await selectChart(change.chartId, { force: true });
            return;
        }
        if (change.type === 'data-replaced') {
            const generation = state.generation;
            const snapshot = await api.getChartSnapshot(change.chartId);
            if (generation !== state.generation || change.chartId !== state.selectedId || isDetached()) return;
            state.snapshot = snapshot;
            updateMeta();
            await state.runtime?.update?.({ ...change, data: snapshot.data });
            return;
        }
        if (change.type === 'data-patched') {
            if (!state.snapshot || !state.runtime) return;
            if (
                state.snapshot
                && Number(change.dataRevision) !== Number(state.snapshot.manifest.dataRevision) + 1
            ) {
                await selectChart(change.chartId, { force: true });
                return;
            }
            state.snapshot.manifest.dataRevision = change.dataRevision;
            state.snapshot.manifest.revision = change.revision;
            updateMeta();
            await state.runtime?.update?.(change);
        }
    }

    function currentSize() {
        const rect = elements.host.getBoundingClientRect();
        return {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            devicePixelRatio: window.devicePixelRatio,
        };
    }

    async function applyTheme(theme) {
        const normalized = String(theme?.mode || theme?.themeMode || theme || '').toLowerCase();
        const value = normalized === 'light' ? 'light' : 'dark';
        const isLight = value === 'light';
        document.body.classList.toggle('light-theme', isLight);
        document.body.classList.toggle('dark-theme', !isLight);
        document.documentElement.classList.toggle('light-theme', isLight);
        document.documentElement.classList.toggle('dark-theme', !isLight);
        document.documentElement.dataset.theme = value;
        await state.runtime?.setTheme?.(value);
    }

    function bindEvents() {
        const run = operation => Promise.resolve().then(operation).catch(error =>
            showToast(error.message || String(error), 'error'));
        elements.detach.addEventListener('click', () => run(() => detachChart(state.selectedId)));
        document.getElementById('focusFloatingButton').addEventListener('click', () =>
            run(() => api.focusFloatingChart(state.selectedId)));
        for (const id of ['dockChartButton', 'restoreChartButton']) {
            document.getElementById(id).addEventListener('click', () =>
                run(() => api.dockChart(state.selectedId)));
        }
        document.getElementById('pinChartButton').addEventListener('click', () => run(async () => {
            const pinned = await api.togglePin();
            const button = document.getElementById('pinChartButton');
            button.textContent = pinned ? '已置顶' : '置顶';
            button.setAttribute('aria-pressed', String(pinned));
        }));
        elements.search.addEventListener('input', renderList);
        document.getElementById('refreshButton').addEventListener('click', refreshCharts);
        elements.contextMenu.addEventListener('click', event => {
            const action = event.target.closest('button[data-action]')?.dataset.action;
            const chartId = state.contextChartId;
            if (!action || !chartId) return;
            hideContextMenu();
            if (action === 'detach') run(() => detachChart(chartId));
            if (action === 'edit') editChart(chartId);
            if (action === 'delete') deleteChart(chartId);
        });
        document.addEventListener('pointerdown', event => {
            if (!elements.contextMenu.hidden && !elements.contextMenu.contains(event.target)) {
                hideContextMenu();
            }
        }, true);
        document.addEventListener('contextmenu', event => {
            if (!event.target.closest?.('.chart-list-item') && !elements.contextMenu.contains(event.target)) {
                hideContextMenu();
            }
        }, true);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !elements.contextMenu.hidden) {
                hideContextMenu();
            }
        });
        window.addEventListener('blur', hideContextMenu);
        window.addEventListener('resize', hideContextMenu);
        document.getElementById('collapseSidebarButton').addEventListener('click', () => {
            document.body.classList.add('sidebar-collapsed');
            setTimeout(() => state.runtime?.resize?.(currentSize()), 200);
        });
        document.getElementById('expandSidebarButton').addEventListener('click', () => {
            document.body.classList.remove('sidebar-collapsed');
            setTimeout(() => state.runtime?.resize?.(currentSize()), 200);
        });
        document.getElementById('minimizeButton').addEventListener('click', api.minimizeWindow);
        document.getElementById('maximizeButton').addEventListener('click', api.toggleMaximizeWindow);
        document.getElementById('closeButton').addEventListener('click', api.closeWindow);
        document.getElementById('devtoolsButton').addEventListener('click', api.openDevTools);
        elements.reload.addEventListener('click', () => {
            if (state.selectedId) selectChart(state.selectedId, { force: true });
        });
        document.getElementById('retryButton').addEventListener('click', () => {
            if (state.selectedId) selectChart(state.selectedId, { force: true });
        });

        state.resizeObserver = new ResizeObserver(() => {
            const generation = state.generation;
            state.runtime?.resize?.(currentSize()).catch(error => {
                if (generation === state.generation) showError(error);
            });
        });
        state.resizeObserver.observe(document.getElementById('stageBody'));

        state.unsubscribers.push(
            api.onFloatingChanged(ids => run(() => syncFloatingCharts(ids))),
            api.onChartChanged(change => run(() => handleChartEvent(change))),
            api.onSelectChart(chartId => {
                if (chartId) selectChart(chartId, { force: true });
                else resetStage();
            }),
            api.onThemeUpdated(applyTheme),
            api.onRequestDiagnostics(request => {
                if (!request || request.chartId !== state.selectedId) return;
                state.diagnostics = state.runtime?.collectDiagnostics?.() || null;
                api.reportDiagnostics({
                    chartId: state.selectedId,
                    requestId: request.requestId,
                    generation: state.generation,
                    diagnostics: state.diagnostics,
                });
            })
        );

        window.addEventListener('beforeunload', () => {
            hideContextMenu();
            clearTimeout(state.loadTimer);
            state.runtime?.destroy?.(false);
            state.resizeObserver?.disconnect();
            state.unsubscribers.forEach(unsubscribe => unsubscribe?.());
        });
    }

    async function initialize() {
        if (!api || !window.VCPChartRuntime) {
            throw new Error('图表运行时或预加载 API 未就绪。');
        }
        document.body.classList.toggle('floating-mode', isFloating);
        elements.detach.hidden = mode !== 'workbench';
        document.getElementById('dockChartButton').hidden = !isFloating;
        document.getElementById('pinChartButton').hidden = !isFloating;
        if (isFloating) {
            document.querySelector('.titlebar-brand span').textContent = '悬浮图表';
            document.title = 'VCP 悬浮图表';
        }
        bindEvents();
        state.floatingIds = new Set(await api.getFloatingCharts());
        try {
            await applyTheme(await api.getCurrentTheme());
        } catch (_error) {
            // Dark is the default.
        }
        await refreshCharts();
        const initialChartId = await api.getInitialChartId();
        if (initialChartId) await selectChart(initialChartId, { force: true });
        api.windowReady({ selectedChartId: state.selectedId });
    }

    initialize().catch(showError);
})();