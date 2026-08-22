// Web Awesome sibling proxy for an existing business-owned <select>.
//
// The original Select remains the form/value/options authority. This provider
// owns only the visible WA node, synchronization, temporary compatibility
// descriptors and teardown. Provider selection happens outside this module.

export function mountWebAwesomeSelectProxy({
    element,
    wa,
    options = {},
    providerDecision,
    makeController,
    attachControlApi,
    waSize,
    waFocus,
    rememberController,
    forgetController,
}) {
    if (!element?.matches?.('select') || !wa) {
        throw new TypeError('Web Awesome Select proxy requires a source Select and a WA element.');
    }

    const document = element.ownerDocument;
    const EventCtor = document.defaultView?.Event || Event;
    const Observer = document.defaultView?.MutationObserver || globalThis.MutationObserver;
    const originallyNativeSelect = element.classList.contains('vcp-ui-native-select');
    const originallySelectSource = element.classList.contains('vcp-ui-select-source');
    const originalSize = element.getAttribute('data-size');
    const originalAriaHidden = element.getAttribute('aria-hidden');
    const originalTabIndex = element.getAttribute('tabindex');
    const originallyHidden = element.hidden;
    const state = { size: element.dataset.size || 'md', ...options };
    let syncing = false;
    let observer;
    let renderedOptionsSignature = null;
    let controller;
    let active = true;

    const restoreSource = () => {
        active = false;
        observer?.disconnect();
        observer = null;
        forgetController(element);
        if (!originallyNativeSelect) element.classList.remove('vcp-ui-native-select');
        if (!originallySelectSource) element.classList.remove('vcp-ui-select-source');
        if (originalSize === null) element.removeAttribute('data-size');
        else element.setAttribute('data-size', originalSize);
        if (originalAriaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', originalAriaHidden);
        if (originalTabIndex === null) element.removeAttribute('tabindex');
        else element.setAttribute('tabindex', originalTabIndex);
        element.hidden = originallyHidden;
    };

    try {

    wa.className = 'vcp-ui-select vcp-ui-wa-select vcp-ui-select-proxy';
    wa.dataset.vcpSelectProxyFor = element.id || '';
    wa.setAttribute('data-vcp-select-proxy', 'true');
    element.classList.add('vcp-ui-native-select', 'vcp-ui-select-source');
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
    element.setAttribute('tabindex', '-1');

    const insertProxy = () => {
        if (active && !wa.isConnected && element.parentNode) element.after(wa);
    };

    const nativeOptionRecords = () => [...element.options].map(option => ({
        value: option.value,
        label: option.label || option.textContent || option.value,
        disabled: option.disabled || Boolean(option.closest('optgroup')?.disabled),
        group: option.closest('optgroup')?.label || '',
    }));

    const syncNativeToProxy = () => {
        if (!active || syncing) return;
        syncing = true;
        try {
            insertProxy();
            const businessClasses = [...element.classList]
                .filter(name => !['vcp-ui-native-select', 'vcp-ui-select-source'].includes(name));
            wa.className = ['vcp-ui-select', 'vcp-ui-wa-select', 'vcp-ui-select-proxy', ...businessClasses].join(' ');
            wa.removeAttribute('style');
            [
                'display', 'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight',
                'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
                'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf',
                'gridArea', 'gridColumn', 'gridRow', 'order', 'boxSizing', 'fontSize',
            ].forEach(property => {
                const value = element.style[property];
                if (value) wa.style[property] = value;
            });
            waSize(wa, element.dataset.size || state.size);
            wa.disabled = Boolean(element.disabled);
            wa.required = Boolean(element.required);
            wa.name = '';
            const label = state.label || element.getAttribute('aria-label') || element.labels?.[0]?.textContent?.trim() || '';
            if (label) wa.setAttribute('aria-label', label);
            else wa.removeAttribute('aria-label');
            ['aria-describedby', 'aria-labelledby', 'title'].forEach(attribute => {
                const value = element.getAttribute(attribute);
                if (value) wa.setAttribute(attribute, value);
                else wa.removeAttribute(attribute);
            });
            const invalid = state.invalid ?? element.getAttribute('aria-invalid') === 'true';
            if (invalid) wa.setAttribute('aria-invalid', 'true');
            else wa.removeAttribute('aria-invalid');
            if (typeof wa.setCustomValidity === 'function') {
                wa.setCustomValidity(invalid ? (state.invalidMessage || element.validationMessage || ' ') : '');
            }
            const optionRecords = nativeOptionRecords();
            const optionsSignature = JSON.stringify(optionRecords);
            if (optionsSignature !== renderedOptionsSignature) {
                wa.replaceChildren();
                let previousGroup = null;
                optionRecords.forEach(record => {
                    const option = document.createElement('wa-option');
                    option.value = record.value;
                    option.disabled = record.disabled;
                    option.textContent = record.label;
                    if (record.group) {
                        option.dataset.group = record.group;
                        option.setAttribute('aria-label', `${record.group}: ${record.label}`);
                        if (record.group !== previousGroup) option.dataset.groupStart = 'true';
                    }
                    previousGroup = record.group;
                    wa.append(option);
                });
                renderedOptionsSignature = optionsSignature;
            }
            const proxyValue = wa.value == null ? '' : String(wa.value);
            if (proxyValue !== element.value) wa.value = element.value;
        } finally {
            syncing = false;
        }
    };

    const syncProxyToNative = event => {
        if (!active || syncing) return;
        event?.stopPropagation?.();
        syncing = true;
        let changed = false;
        try {
            const nextValue = wa.value == null ? '' : String(wa.value);
            changed = element.value !== nextValue;
            element.value = nextValue;
        } finally {
            syncing = false;
        }
        if (event?.type === 'input' && changed) {
            element.dispatchEvent(new EventCtor('input', { bubbles: true }));
        } else if (event?.type === 'change') {
            if (changed) element.dispatchEvent(new EventCtor('input', { bubbles: true }));
            element.dispatchEvent(new EventCtor('change', { bubbles: true }));
        }
    };

    controller = makeController(wa, state, current => {
        if (current.value !== undefined && element.value !== String(current.value)) element.value = String(current.value);
        if (current.disabled !== undefined) element.disabled = Boolean(current.disabled);
        if (current.required !== undefined) element.required = Boolean(current.required);
        syncNativeToProxy();
    }, () => {
        restoreSource();
    });
    controller.nativeElement = element;
    attachControlApi(controller, element);
    controller.kernel = 'webawesome-proxy';
    controller.provider = providerDecision.provider;
    controller.providerDecision = providerDecision;
    controller.kind = 'select';
    controller.refresh = () => {
        syncNativeToProxy();
        return controller;
    };
    rememberController(element, controller);
    controller._listen(wa, 'input', syncProxyToNative);
    controller._listen(wa, 'change', syncProxyToNative);
    controller._listen(wa, 'wa-show', syncNativeToProxy);
    controller._listen(element, 'input', syncNativeToProxy);
    controller._listen(element, 'change', syncNativeToProxy);
    [...(element.labels || [])].forEach(label => controller._listen(label, 'click', event => {
        event.preventDefault();
        wa.focus?.();
    }));
    if (typeof Observer !== 'undefined') {
        observer = new Observer(() => queueMicrotask(syncNativeToProxy));
        observer.observe(element, { attributes: true, childList: true, subtree: true, characterData: true });
    }
    queueMicrotask(syncNativeToProxy);
    return waFocus(controller, wa);
    } catch (error) {
        try { controller?.destroy?.(); } catch {}
        restoreSource();
        wa.remove();
        throw error;
    }
}
