/* Read-only diagnostics for Next UI ownership; contains no user content. */
(function installLifecycleInspector(globalObject) {
    'use strict';
    if (!globalObject || globalObject.VCPLifecycleInspector) return;
    const transitionHistory = [];
    let streamDiagnosticsProvider = null;
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
            shell: globalObject.VCPNextShellController?.getDiagnostics?.() || null,
            streams: streamDiagnosticsProvider?.() || null,
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
        });
    }

    function setStreamDiagnosticsProvider(provider) {
        if (typeof provider !== 'function') throw new TypeError('Stream diagnostics provider must be a function.');
        if (streamDiagnosticsProvider && streamDiagnosticsProvider !== provider) {
            throw new Error('Stream diagnostics provider is already registered.');
        }
        streamDiagnosticsProvider = provider;
    }

    globalObject.VCPLifecycleInspector = Object.freeze({ snapshot, snapshotMain, setStreamDiagnosticsProvider });
})(typeof window !== 'undefined' ? window : null);
