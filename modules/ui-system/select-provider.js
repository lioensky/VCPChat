// Select provider policy for VCPUI.
//
// This module deliberately contains no DOM mounting code. It is the stable
// decision boundary between product surfaces and whichever implementation is
// used to present a Select. A provider is selected exactly once for a mounted
// controller; a later Web Awesome registration never mutates that controller
// into a different implementation.

export const SELECT_PROVIDER = Object.freeze({
    NATIVE: 'native',
    CUSTOMIZABLE_NATIVE: 'customizable-native',
    WEB_AWESOME_OWNED: 'webawesome-owned',
    WEB_AWESOME_PROXY: 'webawesome-proxy',
});

const REQUESTS = new Set(['auto', 'native', 'customizable-native', 'webawesome']);

export function detectCustomizableNativeSelect(css = globalThis.CSS) {
    const supports = typeof css?.supports === 'function'
        ? (property, value) => {
            try { return Boolean(css.supports(property, value)); } catch { return false; }
        }
        : () => false;
    const supportsSelector = typeof css?.supports === 'function'
        ? selector => {
            try { return Boolean(css.supports(`selector(${selector})`)); } catch { return false; }
        }
        : () => false;

    const baseSelect = supports('appearance', 'base-select');
    const picker = supportsSelector('::picker(select)');
    return Object.freeze({
        supported: baseSelect && picker,
        baseSelect,
        picker,
    });
}

export function createSelectProviderDecision({
    ownership = 'existing',
    requested = 'auto',
    webAwesomeReady = false,
    customizableNative = detectCustomizableNativeSelect(),
} = {}) {
    if (!['existing', 'owned'].includes(ownership)) {
        throw new TypeError(`Unknown Select ownership: ${ownership}`);
    }
    const normalizedRequest = REQUESTS.has(requested) ? requested : 'auto';
    const capability = typeof customizableNative === 'boolean'
        ? Object.freeze({ supported: customizableNative, baseSelect: customizableNative, picker: customizableNative })
        : Object.freeze({
            supported: Boolean(customizableNative?.supported),
            baseSelect: Boolean(customizableNative?.baseSelect),
            picker: Boolean(customizableNative?.picker),
        });

    let provider;
    let reason;
    if (normalizedRequest === 'native') {
        provider = SELECT_PROVIDER.NATIVE;
        reason = 'explicit-native';
    } else if (normalizedRequest === 'customizable-native') {
        provider = capability.supported ? SELECT_PROVIDER.CUSTOMIZABLE_NATIVE : SELECT_PROVIDER.NATIVE;
        reason = capability.supported ? 'explicit-customizable-native' : 'customizable-native-unsupported';
    } else if (normalizedRequest === 'webawesome' || normalizedRequest === 'auto') {
        if (webAwesomeReady) {
            provider = ownership === 'owned'
                ? SELECT_PROVIDER.WEB_AWESOME_OWNED
                : SELECT_PROVIDER.WEB_AWESOME_PROXY;
            reason = normalizedRequest === 'webawesome' ? 'explicit-webawesome' : 'webawesome-ready';
        } else {
            provider = SELECT_PROVIDER.NATIVE;
            reason = normalizedRequest === 'webawesome' ? 'webawesome-unavailable' : 'stable-native-fallback';
        }
    }

    return Object.freeze({
        provider,
        ownership,
        requested: normalizedRequest,
        webAwesomeReady: Boolean(webAwesomeReady),
        customizableNative: capability,
        reason,
    });
}

export function selectProviderRequest(options = {}) {
    if (options.provider) return options.provider;
    if (options.kernel === 'native') return 'native';
    if (options.kernel === 'webawesome') return 'webawesome';
    return 'auto';
}
