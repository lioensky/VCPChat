/* Read-only diagnostics for Next UI ownership; contains no user content. */
(function installLifecycleInspector(globalObject) {
    'use strict';
    if (!globalObject || globalObject.VCPLifecycleInspector) return;
    const transitionHistory = [];
    let streamDiagnosticsProvider = null;
    let sidePaneDiagnosticsProvider = null;
    const MAX_HISTORY = 30;
    const record = event => {
        const detail = event.detail || {};
        transitionHistory.push(Object.freeze({
            at: Date.now(),
            phase: String(detail.phase || 'changed'),
            mode: detail.mode === 'next' ? 'next' : 'classic',
            generation: Number(detail.generation || detail.transitionGeneration || 0),
            error: detail.error ? String(detail.error).slice(0, 240) : null,
        }));
        if (transitionHistory.length > MAX_HISTORY) transitionHistory.splice(0, transitionHistory.length - MAX_HISTORY);
    };
    globalObject.addEventListener('ui-mode-transition-state', record);
    globalObject.addEventListener('ui-mode-changed', record);

    function snapshot() {
        const scopes = globalObject.VCPLifecycle?.diagnostics?.snapshot?.() || [];
        return Object.freeze({
            at: Date.now(),
            mode: globalObject.document?.documentElement?.dataset?.uiMode === 'next' ? 'next' : 'classic',
            scopes: Object.freeze(scopes),
            stalledScopes: Object.freeze(scopes.filter(scope => scope.state === 'disposing' && scope.disposingMs > 5_000)),
            scopeSummary: globalObject.VCPLifecycle?.diagnostics?.summary?.() || null,
            tasks: Object.freeze(globalObject.VCPTasks?.diagnostics?.snapshot?.() || []),
            contributions: globalObject.VCPContributions?.diagnostics?.snapshot?.() || null,
            states: Object.freeze(globalObject.VCPStateChannels?.diagnostics?.() || []),
            sources: Object.freeze(globalObject.VCPSharedSources?.diagnostics?.() || []),
            shell: globalObject.VCPNextShellController?.getDiagnostics?.() || null,
            streams: streamDiagnosticsProvider?.() || null,
            sidePane: sidePaneDiagnosticsProvider?.() || null,
            performance: Object.freeze(globalObject.VCPPerformance?.snapshot?.() || []),
            transitions: Object.freeze([...transitionHistory]),
        });
    }

    async function snapshotMain() {
        const api = globalObject.chatAPI || globalObject.electronAPI;
        const result = await api?.getMainLifecycleSnapshot?.();
        return Object.freeze({
            embeddedSessions: Object.freeze(result?.embeddedSessions || []),
            activeEmbeddedAction: result?.activeEmbeddedAction || null,
            tasks: Object.freeze(result?.tasks || []),
            chatTasks: Object.freeze(result?.chatTasks || []),
            // 主进程各领域的激活状态：declared / loading / active / failed
            domains: Object.freeze(result?.domains || []),
            // 主进程按窗口的推送订阅：主题、key、订阅窗口数
            subscriptions: Object.freeze(result?.subscriptions || []),
            gitWatchers: Object.freeze(result?.gitWatchers || []),
            // 终端执行器是否已加载（loaded），以及分布式服务器是否在跑（它的插件加载也会拉起执行器）
            terminalExecutor: Object.freeze({ loaded: Boolean(result?.terminalExecutor?.loaded), distributedServer: Boolean(result?.terminalExecutor?.distributedServer) }),
        });
    }

    function setStreamDiagnosticsProvider(provider) {
        if (typeof provider !== 'function') throw new TypeError('Stream diagnostics provider must be a function.');
        if (streamDiagnosticsProvider && streamDiagnosticsProvider !== provider) {
            throw new Error('Stream diagnostics provider is already registered.');
        }
        streamDiagnosticsProvider = provider;
    }

    /** 副屏控制器随界面重建，返回的函数用来在它销毁时注销 */
    function setSidePaneDiagnosticsProvider(provider) {
        if (typeof provider !== 'function') throw new TypeError('Side pane diagnostics provider must be a function.');
        sidePaneDiagnosticsProvider = provider;
        return () => {
            if (sidePaneDiagnosticsProvider === provider) sidePaneDiagnosticsProvider = null;
        };
    }

    globalObject.VCPLifecycleInspector = Object.freeze({ snapshot, snapshotMain, setStreamDiagnosticsProvider, setSidePaneDiagnosticsProvider });
})(typeof window !== 'undefined' ? window : null);
