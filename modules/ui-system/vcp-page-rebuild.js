// vcp-page-rebuild — shared next-mode page reconstruction helper.
//
// Business pages adopt the next-UI presentation by moving their existing
// business nodes into a VCPUI AppPageShell, enhancing the controls, and
// attaching Web Awesome tooltips. Classic mode keeps the original DOM/CSS.
// The helper is inert unless the page is in next mode with VCPUI available.

function isNextUi() {
    return document.documentElement.dataset.uiMode === 'next'
        && Boolean(window.VCPUI)
        && window.VCPUiModeController?.getCurrentMode() === 'next';
}

function enhanceControl(V, kind, selector) {
    document.querySelectorAll(selector).forEach(element => {
        try {
            V.enhance(kind, element);
        } catch (error) {
            console.warn(`[VCPPageRebuild] enhance ${kind} on ${selector}:`, error);
        }
    });
}

export function rebuild(options) {
    if (!isNextUi()) return null;
    if (document.body.classList.contains('vcp-ui-scope')) return null;

    const V = window.VCPUI;
    const container = document.querySelector(options.containerSelector);
    if (!container) return null;
    document.body.classList.add('vcp-ui-scope');

    const shell = V.create('AppPageShell', {
        title: options.title || '应用',
        windowControls: options.windowControls !== false,
        onMinimize: options.onMinimize,
        onMaximize: options.onMaximize,
        onClose: options.onClose,
    });

    const actions = (options.actionSelectors || []).map(selector => document.querySelector(selector)).filter(Boolean);
    if (actions.length) shell.update({ actions });

    const body = document.createElement('div');
    body.className = options.bodyClass || 'vcp-ui-page-body';
    while (container.firstChild) body.append(container.firstChild);
    shell.update({ content: body });

    if (options.navSelector) document.querySelector(options.navSelector)?.remove();
    container.remove();
    document.body.append(shell.element);

    const enhance = options.enhanceSelectors || {};
    (enhance.select || []).forEach(selector => enhanceControl(V, 'Select', selector));
    (enhance.input || []).forEach(selector => enhanceControl(V, 'Input', selector));
    (enhance.textarea || []).forEach(selector => enhanceControl(V, 'Textarea', selector));
    (enhance.range || []).forEach(selector => enhanceControl(V, 'Range', selector));
    (enhance.switch || []).forEach(selector => enhanceControl(V, 'Switch', selector));

    if (options.tooltipSelectors?.length) {
        options.tooltipSelectors.forEach(selector => {
            const el = document.querySelector(selector);
            if (!el) return;
            try {
                const tip = V.create('Tooltip', { trigger: el, content: el.title || el.getAttribute('aria-label') || '操作', placement: 'top' });
                document.body.append(tip.element);
            } catch (error) {
                console.warn(`[VCPPageRebuild] tooltip on ${selector}:`, error);
            }
        });
    }

    return shell;
}

window.VCPPageRebuild = Object.freeze({ rebuild });
