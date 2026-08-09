(() => {
    const STORAGE_KEY = 'vcpchat.uiMode';
    const CLASSIC_MODE = 'classic';
    const NEXT_MODE = 'next';
    let transitionGeneration = 0;

    function normalize(mode) {
        return mode === NEXT_MODE ? NEXT_MODE : CLASSIC_MODE;
    }

    function apply(mode, options = {}) {
        const normalizedMode = normalize(mode);
        const previousMode = document.documentElement.dataset.uiMode;

        document.documentElement.dataset.uiMode = normalizedMode;

        // `settings.json` is the persistent authority.  localStorage is only
        // a boot-time hint to avoid a blank classic shell before the renderer
        // receives settings through IPC, so callers must opt in after a
        // successful settings read/write.
        if (options.cache === true) {
            localStorage.setItem(STORAGE_KEY, normalizedMode);
        }

        if (previousMode && previousMode !== normalizedMode) {
            window.dispatchEvent(new CustomEvent('ui-mode-changed', {
                detail: { mode: normalizedMode, previousMode }
            }));
        }

        return normalizedMode;
    }

    function getCurrentMode() {
        return normalize(document.documentElement.dataset.uiMode);
    }

    async function applyAsync(mode, options = {}) {
        const normalizedMode = normalize(mode);
        const generation = ++transitionGeneration;
        await window.topTabManager?.prepareForMode?.(normalizedMode);
        if (generation !== transitionGeneration) return getCurrentMode();
        const appliedMode = apply(normalizedMode, options);
        await window.topTabManager?.syncMode?.(appliedMode);
        return appliedMode;
    }

    // The cache never writes back by itself. `loadAndApplyGlobalSettings()`
    // will reconcile it with the authoritative settings file.
    const cachedMode = localStorage.getItem(STORAGE_KEY) ?? NEXT_MODE;
    apply(cachedMode, { cache: false });

    window.uiModeManager = Object.freeze({
        CLASSIC_MODE,
        NEXT_MODE,
        apply,
        applyAsync,
        getCurrentMode,
        normalize
    });
})();
