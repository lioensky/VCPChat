// vcp-ui-runtime-bootstrap — shared entry for standalone/embedded application
// pages that have adopted the next-UI presentation.
//
// A migrated page includes this module (plus styles/ui-system/runtime.css) and
// then uses window.VCPUI. The bootstrap:
//   - reads the UI mode from the ?uiMode= query param (embedded views are given
//     it by the host; standalone windows fall back to persisted settings),
//   - sets html[data-ui-mode] and dispatches ui-mode-changed,
//   - exposes VCPUI and the UiModeController for the page's own controllers.
//
// The module is inert in classic mode: it only sets the mode attribute and
// never mounts a component tree, so a classic page keeps its current DOM/CSS.

import VCPUI from './vcp-ui.js';
import UiModeController from './ui-mode-controller.js';
import { resolveSurfaceUiMode } from './ui-surface-policy.js';
import './webawesome-adapter.js';
import './vcp-page-rebuild.js';

window.VCPUI = VCPUI;

let bootstrapController = null;
if (document.documentElement.dataset.uiMode) {
    // A previous bootstrap (or the host) already resolved the mode.
    window.VCPUiModeController = UiModeController;
} else {
    const controller = await UiModeController.bootstrap();
    bootstrapController = controller;
    window.VCPUiModeController = Object.freeze({
        ...UiModeController,
        bootstrapController: controller,
    });
}

// A child application's next presentation is a product capability, not an
// automatic consequence of the main window using next UI. Pages that are not
// on the active allowlist remain on their classic DOM while their experimental
// AppPageShell implementations stay archived in source control.
const requestedMode = document.documentElement.dataset.uiMode || 'classic';
const effectiveMode = resolveSurfaceUiMode(requestedMode, window.location);
if (effectiveMode !== requestedMode) {
    if (bootstrapController?.apply) {
        bootstrapController.apply(effectiveMode);
    } else {
        document.documentElement.dataset.uiMode = effectiveMode;
        window.dispatchEvent(new CustomEvent('ui-mode-changed', {
            detail: { mode: effectiveMode, previousMode: requestedMode },
        }));
    }
}

// Standalone next-mode pages do not inherit the main renderer's icon runtime.
// Keep that dependency at this shared design-system entry so business pages
// still request semantic icons only through VCPUI.
if (document.documentElement.dataset.uiMode === 'next' && !window.lucide) {
    try {
        window.lucide = await import('../../node_modules/lucide/dist/esm/lucide.mjs');
        await import('./lucide-adapter.js');
    } catch (error) {
        console.warn('[VCPUI Runtime] Lucide unavailable, using the bundled symbol font:', error);
    }
}

// In next mode the page opts into Web Awesome as the behavior/a11y kernel for
// the core controls it builds through VCPUI.create (Button, IconButton, Input,
// Textarea, Select, Checkbox, Switch, Card, Tabs, Dialog, Tooltip). The bundles
// load lazily here, so classic pages never fetch them and the main renderer
// keeps Web Awesome out of its boot path.
//
// Timing contract: `vcp-ui-runtime-ready` is dispatched from a DOMContentLoaded
// listener AFTER the Web Awesome bundles have resolved (or failed). DOMContentLoaded
// fires after every page script (classic + module) has run, and page ready
// listeners are attached before this dispatch, so a page that builds its
// next-UI tree in the `vcp-ui-runtime-ready` listener always sees the same
// kernel: Web Awesome-backed elements when the preload succeeded, native DOM
// otherwise.
//
// Deterministic fallback (no random state): custom element registration cannot
// be rolled back, so the adapter's terminal runtime state is authoritative. A
// failed batch keeps every VCPUI factory on the native path for this document,
// even if the browser registry contains definitions from completed imports.
let waPreloaded = false;
let runtimeGeneration = 0;
let releaseScope = null;

// Dispatch after DOMContentLoaded (module eval happens in the interactive
// phase, before page DOMContentLoaded handlers attach their ready listeners).
function dispatchRuntimeReady() {
    window.dispatchEvent(new CustomEvent('vcp-ui-runtime-ready', {
        detail: {
            mode: document.documentElement.dataset.uiMode || 'classic',
            waKernel: waPreloaded && document.documentElement.dataset.uiMode === 'next'
                ? 'web-awesome'
                : 'native',
        },
    }));
}

function waitForDocumentReady() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise(resolve => window.addEventListener('DOMContentLoaded', resolve, { once: true }));
}

async function mountRuntime() {
    const generation = ++runtimeGeneration;
    waPreloaded = false;
    try {
        const tags = await window.VCPWebAwesome?.loadComponents?.();
        if (generation !== runtimeGeneration || document.documentElement.dataset.uiMode !== 'next') return;
        waPreloaded = Boolean(tags?.length);
        await waitForDocumentReady();
        if (generation !== runtimeGeneration || document.documentElement.dataset.uiMode !== 'next') return;
        releaseScope = window.VCPWebAwesome?.mountScope?.(document.body) || null;
    } catch (error) {
        if (generation !== runtimeGeneration) return;
        console.warn('[VCPUI Runtime] Web Awesome preload failed, using native controls:', error);
    }
    if (generation === runtimeGeneration && document.documentElement.dataset.uiMode === 'next') {
        dispatchRuntimeReady();
    }
}

function unmountRuntime() {
    runtimeGeneration += 1;
    waPreloaded = false;
    releaseScope?.();
    releaseScope = null;
}

const runtimeSurface = UiModeController.createSurfaceController({
    onEnter: mountRuntime,
    onLeave: unmountRuntime,
});
window.addEventListener('pagehide', () => runtimeSurface.destroy(), { once: true });

export default VCPUI;
