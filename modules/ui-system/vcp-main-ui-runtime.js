import './webawesome-adapter.js';

let generation = 0;
let releaseScope = null;
let activating = false;
const LifecycleScope = window.VCPLifecycle?.LifecycleScope;
const moduleScope = LifecycleScope ? new LifecycleScope('next:main-ui-runtime-controller') : null;
let nextScope = null;

function hasActiveTarget() {
    const sidebarSettings = document.querySelector('#tabContentSettings[aria-hidden="false"]');
    const globalSettings = document.querySelector('#globalSettingsModal:not([hidden])');
    return Boolean(sidebarSettings?.isConnected || globalSettings?.isConnected);
}

async function activateKernel() {
    if (activating || releaseScope || !hasActiveTarget()) return;
    activating = true;
    const currentGeneration = ++generation;
    const activationScope = nextScope;
    try {
        await window.VCPWebAwesome?.loadComponents?.();
        if (currentGeneration !== generation
            || (activationScope && !activationScope.active)) return;
        const mountedRelease = window.VCPWebAwesome?.mountScope?.(document.body) || null;
        if (currentGeneration !== generation
            || (activationScope && !activationScope.active)) {
            mountedRelease?.();
            return;
        }
        releaseScope = mountedRelease;
        if (mountedRelease && activationScope) {
            activationScope.own(() => mountedRelease(), 'webawesome-main-scope', 'ui-registration');
        }
        // The settings bridge owns legacy form controls. In particular it
        // keeps upstream Select elements native so Classic/Next round-trips
        // do not repeatedly construct and detach large WA shadow trees.
        window.VCPUISettingsBridge?.refresh?.();
    } catch (error) {
        console.warn('[VCPUI Main Runtime] Web Awesome preload failed; native controls remain active:', error);
    } finally {
        // A newer activation may already be in flight after a mode round-trip.
        // Only the generation that acquired the lock may release it.
        if (currentGeneration === generation) activating = false;
    }
}

function mountCanonicalRuntime() {
    if (!nextScope && moduleScope) nextScope = moduleScope.child('next:main-ui-runtime');
    if (nextScope) {
        nextScope.listen(document, 'click', handleSettingsTabClick, undefined, 'settings-tab-click');
        nextScope.listen(document, 'modal-visibility-changed', handleSurfaceVisibility, undefined, 'settings-modal-visibility');
    } else {
        document.addEventListener('click', handleSettingsTabClick);
        document.addEventListener('modal-visibility-changed', handleSurfaceVisibility);
    }
    activateKernel();
}

function handleSettingsTabClick(event) {
    if (!event.target?.closest?.('.sidebar-tab-button[data-tab="settings"]')) return;
    handleSurfaceVisibility();
}

function handleSurfaceVisibility() {
    queueMicrotask(activateKernel);
}

function destroyCanonicalRuntime() {
    generation += 1;
    activating = false;
    if (nextScope) {
        const scope = nextScope;
        nextScope = null;
        void scope.dispose('canonical-runtime-destroy').catch(error => {
            console.error('[VCPUI Main Runtime] Failed to dispose canonical runtime:', error);
        });
    } else {
        document.removeEventListener('click', handleSettingsTabClick);
        document.removeEventListener('modal-visibility-changed', handleSurfaceVisibility);
        releaseScope?.();
    }
    releaseScope = null;
}

mountCanonicalRuntime();
moduleScope?.own(destroyCanonicalRuntime, 'canonical-main-ui-runtime', 'ui-registration');
