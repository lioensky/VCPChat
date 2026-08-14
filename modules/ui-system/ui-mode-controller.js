// UiModeController — the single place that answers "which UI mode is this
// document in?" and runs surface lifecycle (mount/teardown) across:
//
//   - the main renderer (mode is owned by modules/uiModeManager.js),
//   - embedded WebContentsView pages (mode passed by the host as ?uiMode=),
//   - standalone BrowserWindows (mode read from persisted settings),
//   - standalone Electron sub-apps (mode read from their own settings).
//
// It never guesses the mode from the OS theme. Mounting a next-mode surface is
// idempotent: repeated `ui-mode-changed` events must not double-register
// listeners, components or submit handlers.

function normalizeMode(mode) {
    return mode === 'next' ? 'next' : 'classic';
}

function currentMode() {
    return normalizeMode(document.documentElement.dataset.uiMode || 'classic');
}

// Runs `onEnter` the first time the document becomes next mode and `onLeave`
// when it stops being next mode. Safe to call before the mode is known.
function createSurfaceController({ onEnter, onLeave } = {}) {
    let mounted = false;
    const sync = mode => {
        const isNext = normalizeMode(mode) === 'next';
        if (isNext && !mounted) {
            mounted = true;
            onEnter?.();
        } else if (!isNext && mounted) {
            mounted = false;
            onLeave?.();
        }
    };
    const onChange = event => sync(event?.detail?.mode ?? currentMode());
    window.addEventListener('ui-mode-changed', onChange);
    sync(currentMode());
    return Object.freeze({
        isActive: () => mounted,
        sync,
        destroy() {
            window.removeEventListener('ui-mode-changed', onChange);
            if (mounted) {
                mounted = false;
                onLeave?.();
            }
        },
    });
}

function queryModeParam() {
    const param = new URLSearchParams(window.location.search).get('uiMode');
    return param ? normalizeMode(param) : null;
}

async function defaultReadMode() {
    const param = queryModeParam();
    if (param) return param;
    try {
        const api = window.utilityAPI || window.electronAPI;
        const settings = await api?.loadSettings?.();
        return settings?.uiMode == null ? 'classic' : normalizeMode(settings.uiMode);
    } catch {
        return 'classic';
    }
}

// Bootstraps a child document (embedded page, standalone window or sub-app):
// sets html[data-ui-mode] once, dispatches ui-mode-changed, then applies later
// mode changes delivered through the optional subscribeMode callback.
async function bootstrap(options = {}) {
    const {
        readMode = defaultReadMode,
        subscribeMode,
        navigate = url => window.location.replace(url),
    } = options;
    const initial = normalizeMode((await readMode()) || 'classic');
    document.documentElement.dataset.uiMode = initial;
    window.dispatchEvent(new CustomEvent('ui-mode-changed', {
        detail: { mode: initial, previousMode: null },
    }));

    const apply = mode => {
        const next = normalizeMode(mode);
        const previousMode = currentMode();
        if (next === previousMode) return next;
        document.documentElement.dataset.uiMode = next;
        window.dispatchEvent(new CustomEvent('ui-mode-changed', {
            detail: { mode: next, previousMode },
        }));
        return next;
    };

    let unsubscribe;
    const runtimeSubscribe = (window.utilityAPI || window.electronAPI)?.onUiModeUpdated;
    const effectiveSubscribe = subscribeMode || runtimeSubscribe;
    if (typeof effectiveSubscribe === 'function') {
        unsubscribe = effectiveSubscribe(mode => {
            const next = normalizeMode(mode);
            if (next === currentMode()) return;
            // A child presentation that opts into this controller crosses
            // mode boundaries by reloading its original business document.
            // Explicit test/host subscriptions may still use the lightweight
            // apply path.
            if (!subscribeMode && effectiveSubscribe === runtimeSubscribe) {
                const url = new URL(window.location.href);
                url.searchParams.set('uiMode', next);
                navigate(url.toString());
                return;
            }
            apply(next);
        });
    }

    return Object.freeze({
        getMode: () => currentMode(),
        apply,
        destroy() {
            unsubscribe?.();
        },
    });
}

const UiModeController = Object.freeze({
    normalize: normalizeMode,
    getCurrentMode: currentMode,
    createSurfaceController,
    bootstrap,
});

window.VCPUiModeController = UiModeController;
window.dispatchEvent(new CustomEvent('vcp-ui-mode-controller-ready'));

export default UiModeController;
