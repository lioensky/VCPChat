import VCPUI from './vcp-ui.js';
import UiModeController from './ui-mode-controller.js';
import './webawesome-adapter.js';

let generation = 0;
let releaseScope = null;
let selectObserver = null;
let activating = false;

function hasActiveTarget() {
    const sidebarSettings = document.querySelector('#tabContentSettings[aria-hidden="false"]');
    const globalSettings = document.querySelector('#globalSettingsModal:not([hidden])');
    return Boolean(sidebarSettings?.isConnected || globalSettings?.isConnected);
}

async function activateKernel() {
    if (activating || selectObserver || !hasActiveTarget()) return;
    activating = true;
    const currentGeneration = ++generation;
    try {
        await window.VCPWebAwesome?.loadComponents?.();
        if (currentGeneration !== generation || document.documentElement.dataset.uiMode !== 'next') return;
        releaseScope = window.VCPWebAwesome?.mountScope?.(document.body) || null;
        selectObserver = VCPUI.observeControls(document, {
            kinds: ['Select'],
            filter: select => Boolean(select.closest('#tabContentSettings, #globalSettingsModal')),
        });
        window.VCPUISettingsBridge?.refresh?.();
    } catch (error) {
        console.warn('[VCPUI Main Runtime] Web Awesome preload failed; native controls remain active:', error);
    } finally {
        activating = false;
    }
}

function enterNextMode() {
    document.addEventListener('click', handleSettingsTabClick);
    document.addEventListener('modal-visibility-changed', handleSurfaceVisibility);
    activateKernel();
}

function handleSettingsTabClick(event) {
    if (!event.target?.closest?.('.sidebar-tab-button[data-tab="settings"]')) return;
    handleSurfaceVisibility();
}

function handleSurfaceVisibility() {
    queueMicrotask(activateKernel);
}

function leaveNextMode() {
    generation += 1;
    activating = false;
    document.removeEventListener('click', handleSettingsTabClick);
    document.removeEventListener('modal-visibility-changed', handleSurfaceVisibility);
    selectObserver?.destroy();
    selectObserver = null;
    releaseScope?.();
    releaseScope = null;
}

UiModeController.createSurfaceController({
    onEnter: enterNextMode,
    onLeave: leaveNextMode,
});
