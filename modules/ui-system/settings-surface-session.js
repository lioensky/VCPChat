// Ownership for asynchronous writes into the reusable global-settings modal.
// The modal keeps its DOM between opens, so a request started by one open must
// lose the right to commit as soon as that open closes or a new one begins.

let generation = 0;
let active = false;
let root = null;

function isGlobalSettingsEvent(event) {
    return event?.detail?.modalId === 'globalSettingsModal';
}

function handleVisibility(event) {
    if (!isGlobalSettingsEvent(event)) return;
    generation += 1;
    active = event.detail.active === true;
    root = active ? document.getElementById('globalSettingsModal') : null;
}

document.addEventListener('modal-visibility-changed', handleVisibility);

export function captureSettingsSurfaceSession() {
    const modal = document.getElementById('globalSettingsModal');
    if (modal && modal.classList.contains('active') && !active) {
        // Covers callers that run after the modal was opened before this module
        // observed the event (for example in a test harness).
        active = true;
        root = modal;
        generation += 1;
    }
    return Object.freeze({ generation, root });
}

export function isCurrentSettingsSurfaceSession(session) {
    if (!session || !active || session.generation !== generation) return false;
    const modal = root || document.getElementById('globalSettingsModal');
    return Boolean(modal && modal === session.root && modal.isConnected && modal.classList.contains('active'));
}

export function currentSettingsSurfaceGeneration() {
    return active ? generation : 0;
}

