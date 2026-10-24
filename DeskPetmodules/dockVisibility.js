// One place owns hover delays. Input/recording and explicitly opened sessions stay available.
export function createDockVisibility({ getMode, setMode, suppress = () => {}, showMs = 120, hideMs = 800,
    schedule = setTimeout, cancel = clearTimeout }) {
    let state = { hover: false, dragging: false, visible: true, through: false, pinned: false };
    let showTimer = null, hideTimer = null, suppressed = false, disposed = false;
    const focused = () => ['bar', 'rec'].includes(getMode());
    const clearShow = () => { if (showTimer !== null) cancel(showTimer); showTimer = null; };
    const clearHide = () => { if (hideTimer !== null) cancel(hideTimer); hideTimer = null; };
    const unavailable = () => !state.visible || state.dragging || (state.through && !focused());
    const wanted = () => state.hover || state.pinned;
    function reconcile() {
        if (disposed) return;
        const nextSuppressed = unavailable();
        if (suppressed !== nextSuppressed) { suppressed = nextSuppressed; suppress(suppressed); }
        if (suppressed) {
            clearShow(); clearHide();
            if (!focused() && getMode() !== 'hidden') setMode('hidden');
            return;
        }
        if (focused()) { clearShow(); clearHide(); return; }
        if (wanted()) {
            clearHide();
            if (getMode() === 'hidden' && showTimer === null) showTimer = schedule(() => {
                showTimer = null;
                if (!disposed && !unavailable() && wanted()) setMode('pill');
            }, showMs);
        } else {
            clearShow();
            if (getMode() === 'pill' && hideTimer === null) hideTimer = schedule(() => {
                hideTimer = null;
                if (!disposed && !unavailable() && !wanted() && !focused()) setMode('hidden');
            }, hideMs);
        }
    }
    return {
        update(patch) {
            if (!Object.keys(patch).some(key => state[key] !== patch[key])) return;
            state = { ...state, ...patch };
            reconcile();
        },
        modeChanged: reconcile,
        restingMode: () => !state.through && !unavailable() && wanted() ? 'pill' : 'hidden',
        dispose() { disposed = true; clearShow(); clearHide(); },
    };
}

// An alpha probe may finish after the pointer has left, or after it reached a UI button.
export function createCursorHitGate() {
    let inside = false, ui = false;
    return {
        cursor(next) { inside = !next.outside; ui = inside && next.ui === true; },
        resolve(hit) { return inside && (ui || Boolean(hit)); },
    };
}
