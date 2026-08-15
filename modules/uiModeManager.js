(() => {
    const STORAGE_KEY = 'vcpchat.uiMode';
    const CLASSIC_MODE = 'classic';
    const NEXT_MODE = 'next';
    let transitionGeneration = 0;
    let transitionQueue = Promise.resolve();
    let transitionState = Object.freeze({ phase: 'settled', mode: null, generation: 0 });

    function publishTransition(phase, mode, generation, error = null) {
        transitionState = Object.freeze({ phase, mode, generation, error });
        window.dispatchEvent(new CustomEvent('ui-mode-transition-state', {
            detail: transitionState
        }));
    }

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
                detail: {
                    mode: normalizedMode,
                    previousMode,
                    preview: options.preview === true,
                    coordinated: options.coordinated === true,
                    transitionGeneration: options.transitionGeneration || null
                }
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
        const run = async () => {
            if (generation !== transitionGeneration) return getCurrentMode();
            publishTransition('preparing', normalizedMode, generation);
            const transitionOptions = {
                ...options,
                coordinated: true,
                transitionGeneration: generation
            };
            try {
                await window.topTabManager?.prepareForMode?.(normalizedMode, transitionOptions);
                if (generation !== transitionGeneration) return getCurrentMode();
                publishTransition('committing', normalizedMode, generation);
                const appliedMode = apply(normalizedMode, transitionOptions);
                await window.topTabManager?.syncMode?.(appliedMode, transitionOptions);
                if (generation === transitionGeneration) publishTransition('settled', appliedMode, generation);
                return appliedMode;
            } catch (error) {
                if (generation === transitionGeneration) publishTransition('failed', getCurrentMode(), generation, error?.message || String(error));
                throw error;
            }
        };
        const result = transitionQueue.then(run, run);
        transitionQueue = result.catch(() => {});
        return result;
    }

    // The cache never writes back by itself. `loadAndApplyGlobalSettings()`
    // will reconcile it with the authoritative settings file.
    const cachedMode = localStorage.getItem(STORAGE_KEY) ?? CLASSIC_MODE;
    apply(cachedMode, { cache: false });

    window.uiModeManager = Object.freeze({
        CLASSIC_MODE,
        NEXT_MODE,
        apply,
        applyAsync,
        whenSettled: () => transitionQueue,
        getTransitionState: () => transitionState,
        getCurrentMode,
        normalize
    });
})();
