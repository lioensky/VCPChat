// WebAwesomeAdapter — the only sanctioned gate between VCPChat pages and the
// Web Awesome component runtime.
//
// Business modules must never render `<wa-*>` or consume `--wa-*` directly.
// They call this adapter's VCP-shaped API; the adapter owns component loading,
// token mapping, theme registration, event/prop translation and teardown.
//
// Load order contract:
//   1. `loadComponents(tags)` dynamically imports the vendored self-contained
//      generated dist-cdn closure (vendor/webawesome-runtime) — never at module-eval time.
//   2. `mount(scopeRoot)` applies the VCP token set to the scope and starts a
//      ref-counted theme stylesheet. Classic mode and non-scoped roots no-op.
//   3. `create(tag, attrs, children)` builds an element and awaits `updateComplete`
//      through `awaitUpdate()` where the caller needs post-render layout.
//
// All Web Awesome component registrations happen lazily on first use, gated by
// html[data-ui-mode="next"].

import { WEB_AWESOME_COMPONENTS, WEB_AWESOME_LOCALE } from './webawesome-runtime-manifest.js';

const VENDOR_COMPONENT_BASE = new URL(
    '../../vendor/webawesome-runtime/dist-cdn/components/',
    import.meta.url
).href;

const THEME_URL = new URL(
    '../../vendor/webawesome-runtime/dist-cdn/styles/themes/default.css',
    import.meta.url
).href;

const ZH_CN_TRANSLATION_URL = new URL(
    '../../vendor/webawesome-runtime/dist-cdn/translations/zh-cn.js',
    import.meta.url
).href;

// The kernel is deliberately document-scoped. Custom element registrations
// cannot be rolled back, so a failed component batch must remain a native
// fallback for the rest of this document instead of retrying into a mixed
// WA/native surface.
const CORE_COMPONENTS = WEB_AWESOME_COMPONENTS;
const loaded = new Map();
const ownedThemeNodes = new Set();
let runtimeState = 'idle';
let runtimePromise = null;
let runtimeError = null;

function isNextUi() {
    return document.documentElement.dataset.uiMode === 'next';
}

async function loadComponents(tags) {
    if (!isNextUi()) {
        throw new Error('WebAwesomeAdapter: components require html[data-ui-mode="next"]');
    }
    const requested = [...new Set((tags || CORE_COMPONENTS).map(tag => String(tag).toLowerCase()))];
    const unsupported = requested.filter(tag => !CORE_COMPONENTS.includes(tag));
    if (unsupported.length) {
        throw new Error(`WebAwesomeAdapter: components are not in the runtime manifest: ${unsupported.join(', ')}`);
    }
    if (runtimeState === 'ready') return CORE_COMPONENTS;
    if (runtimeState === 'failed') throw runtimeError;
    if (runtimePromise) return runtimePromise;

    runtimeState = 'loading';
    runtimePromise = Promise.all(
        [import(ZH_CN_TRANSLATION_URL), ...CORE_COMPONENTS.map(tag => import(`${VENDOR_COMPONENT_BASE}${tag}/${tag}.js`))]
    ).then(modules => {
        modules.slice(1).forEach((module, index) => loaded.set(CORE_COMPONENTS[index], module));
        runtimeState = 'ready';
        window.dispatchEvent(new CustomEvent('vcp-webawesome-loaded', {
            detail: { tags: [...CORE_COMPONENTS], state: runtimeState },
        }));
        return CORE_COMPONENTS;
    }).catch(error => {
        loaded.clear();
        runtimeState = 'failed';
        runtimeError = error instanceof Error ? error : new Error(String(error));
        window.dispatchEvent(new CustomEvent('vcp-webawesome-failed', {
            detail: {
                tags: [...CORE_COMPONENTS],
                state: runtimeState,
                error: String(runtimeError.message || runtimeError),
            },
        }));
        throw runtimeError;
    });
    return runtimePromise;
}

function setAttributes(element, attrs = {}) {
    Object.entries(attrs).forEach(([name, value]) => {
        if (name === 'class') {
            element.className = value;
            return;
        }
        if (value === false || value === null || value === undefined) return;
        if (value === true) element.setAttribute(name, '');
        else element.setAttribute(name, String(value));
    });
    return element;
}

function create(tag, attrs = {}, children) {
    const element = document.createElement(`wa-${String(tag).toLowerCase()}`);
    setAttributes(element, attrs);
    if (children) {
        const list = Array.isArray(children) ? children : [children];
        list.forEach(child => element.append(child));
    }
    return element;
}

function on(element, type, handler, options) {
    element.addEventListener(type, handler, options);
    return () => element.removeEventListener(type, handler, options);
}

// True once the lazy component bundle for `tag` has been registered. VCPUI
// factories use this to decide whether to build a Web Awesome-backed control
// (behavior/a11y kernel) or fall back to the native DOM control.
function isDefined(tag) {
    const normalized = String(tag).toLowerCase();
    return runtimeState === 'ready'
        && typeof customElements !== 'undefined'
        && Boolean(customElements.get(`wa-${normalized}`));
}

// True once the bundle for `tag` has been fetched in this session, whether or
// not the custom element is defined yet (bundle import registers it). This is
// the deterministic preload state the runtime bootstrap reports on.
function isLoaded(tag) {
    return runtimeState === 'ready' && loaded.has(String(tag).toLowerCase());
}

function getRuntimeState() {
    return Object.freeze({
        state: runtimeState,
        components: [...CORE_COMPONENTS],
        locale: WEB_AWESOME_LOCALE,
        error: runtimeError ? String(runtimeError.message || runtimeError) : null,
    });
}

// Re-dispatches a Web Awesome event as a VCP event on the same element, so
// business code keeps listening for the VCP event name (e.g. `change`) while
// the behavior is owned by Web Awesome. Returns an unsubscribe function.
function translateEvent(element, waEventName, vcpEventName, mapper = () => undefined) {
    const handler = event => {
        const detail = mapper(event);
        element.dispatchEvent(new CustomEvent(vcpEventName, {
            bubbles: true,
            detail,
        }));
    };
    element.addEventListener(waEventName, handler);
    return () => element.removeEventListener(waEventName, handler);
}

// Mounts a Web Awesome scope: applies the VCP token mapping and starts the
// ref-counted theme stylesheet. Returns a release function for teardown.
function mountScope(scopeRoot) {
    const releaseTokens = applyTokens(scopeRoot);
    const releaseTheme = registerTheme();
    return () => {
        releaseTokens();
        releaseTheme();
    };
}

async function awaitUpdate(element) {
    if (element?.updateComplete instanceof Promise) await element.updateComplete;
    return element;
}

// Maps the current VCP design tokens onto Web Awesome's --wa-* contract for a
// specific scope root. Only runs in next UI mode; the actual mapping lives in
// styles/ui-system/webawesome-adapter.css (kept as the single visual authority).
function applyTokens(scopeRoot) {
    if (!isNextUi() || !scopeRoot) return () => {};
    const hadLightClass = scopeRoot.classList.contains('wa-light');
    const hadDarkClass = scopeRoot.classList.contains('wa-dark');
    const syncTheme = () => {
        const isLight = document.body.classList.contains('light-theme');
        scopeRoot.classList.toggle('wa-light', isLight);
        scopeRoot.classList.toggle('wa-dark', !isLight);
    };
    scopeRoot.dataset.waScope = 'true';
    syncTheme();
    const observer = typeof MutationObserver === 'function'
        ? new MutationObserver(syncTheme)
        : null;
    observer?.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
        observer?.disconnect();
        scopeRoot.removeAttribute('data-wa-scope');
        scopeRoot.classList.toggle('wa-light', hadLightClass);
        scopeRoot.classList.toggle('wa-dark', hadDarkClass);
    };
}

function registerTheme() {
    let link = document.querySelector('link[data-webawesome-runtime-theme]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = THEME_URL;
        link.dataset.webawesomeRuntimeTheme = 'true';
        document.head.append(link);
    }
    const owners = Number(link.dataset.ownerCount || 0) + 1;
    link.dataset.ownerCount = String(owners);
    ownedThemeNodes.add(link);
    return () => {
        const remaining = Number(link.dataset.ownerCount || 1) - 1;
        if (remaining <= 0) {
            link.remove();
            ownedThemeNodes.delete(link);
        } else {
            link.dataset.ownerCount = String(remaining);
        }
    };
}

function destroy() {
    // Component definitions and successfully imported modules are permanent
    // for this document. Only scope ownership is disposable.
    ownedThemeNodes.forEach(node => node.remove());
    ownedThemeNodes.clear();
}

window.VCPWebAwesome = Object.freeze({
    loadComponents,
    create,
    on,
    isDefined,
    isLoaded,
    getRuntimeState,
    translateEvent,
    mountScope,
    awaitUpdate,
    applyTokens,
    registerTheme,
    destroy,
    isNextUi
});

window.dispatchEvent(new CustomEvent('vcp-webawesome-adapter-ready'));

export default {
    loadComponents,
    create,
    on,
    isDefined,
    isLoaded,
    getRuntimeState,
    translateEvent,
    mountScope,
    awaitUpdate,
    applyTokens,
    registerTheme,
    destroy,
    isNextUi
};
