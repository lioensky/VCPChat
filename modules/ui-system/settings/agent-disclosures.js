// Agent section DisclosureRow presentation owner. Manager remains the sole
// owner of collapse state and commands; this module only binds the generated
// controller and mirrors canonical DOM state into it.
export function mountAgentSectionDisclosures(form, api, scope, manager, states) {
    const mounted = new Set();
    if (!form || !api?.mountDisclosureRowController || !scope || typeof manager?.toggleAgentSettingsSection !== 'function') return mounted;
    const expectedKeys = new Set(['identity', 'prompt', 'model', 'params', 'tts', 'regex']);
    form.querySelectorAll('.agent-settings-section[data-section-key]').forEach(container => {
        const key = container.dataset.sectionKey;
        if (!expectedKeys.has(key)) return;
        if ([...states].some(state => state.container === container)) { mounted.add(container); return; }
        const header = container.querySelector('.agent-settings-section-header');
        const content = container.querySelector('.agent-settings-section-content');
        const title = header?.querySelector('.agent-settings-section-title');
        const summary = header?.querySelector('.agent-settings-section-summary');
        const toggle = header?.querySelector('.agent-settings-toggle-btn');
        if (!header || !content || !title || !summary || !toggle) return;
        if (!content.id) content.id = `agent-settings-section-${key}-content`;
        let disclosure;
        try {
            disclosure = api.mountDisclosureRowController(header, {
                content,
                open: !container.classList.contains('collapsed'),
                expandable: true,
                className: 'vcp-agent-settings-disclosure-row',
                toggle,
                onToggle: () => manager.toggleAgentSettingsSection(key),
            }, scope);
        } catch (error) {
            console.warn(`[VCPUI SettingsBridge] Could not adopt Agent disclosure "${key}":`, error);
            return;
        }
        const sync = () => disclosure.setOpen(!container.classList.contains('collapsed'));
        const observer = window.MutationObserver ? new window.MutationObserver(sync) : null;
        observer?.observe(container, { attributes: true, attributeFilter: ['class'] });
        header.dataset.vcpTypedAgentDisclosure = 'true';
        sync();
        const state = { container, observer, cleanup: () => {
            observer?.disconnect();
            delete header.dataset.vcpTypedAgentDisclosure;
            states.delete(state);
        }};
        states.add(state);
        scope.own(state.cleanup, `typed-agent-section-disclosure-${key}`, 'ui-presentation');
        mounted.add(container);
    });
    return mounted;
}
