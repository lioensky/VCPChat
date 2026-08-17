(() => {
    const STORAGE_KEY = 'vcpchat.uiMode';
    const CLASSIC_MODE = 'classic';
    const NEXT_MODE = 'next';
    const settled = Object.freeze({ phase: 'settled', mode: NEXT_MODE, generation: 0 });

    // Read-only compatibility facade for integrations that still query the
    // historical API. Persisted uiMode belongs to the settings schema only;
    // it is not a live main-window state source.
    function normalize() { return NEXT_MODE; }
    function apply(_requestedMode, options = {}) {
        document.documentElement.dataset.uiMode = NEXT_MODE;
        if (options.cache === true) localStorage.setItem(STORAGE_KEY, NEXT_MODE);
        return NEXT_MODE;
    }
    async function applyAsync(requestedMode, options = {}) { return apply(requestedMode, options); }

    apply(localStorage.getItem(STORAGE_KEY), { cache: false });
    const stateChannel = window.VCPStateChannels?.create('ui-mode', Object.freeze({ mode: NEXT_MODE, transition: settled })) || null;
    window.uiModeManager = Object.freeze({
        CLASSIC_MODE, NEXT_MODE, apply, applyAsync,
        whenSettled: () => Promise.resolve(NEXT_MODE),
        getTransitionState: () => settled,
        getCurrentMode: () => NEXT_MODE,
        normalize,
        getState: () => stateChannel?.get() || Object.freeze({ mode: NEXT_MODE, transition: settled }),
        subscribe: (listener, options) => stateChannel?.subscribe(listener, options) || (() => false),
    });
})();
