// Home visual Toggle primitive mounting. Native checkboxes remain canonical.
export function mountAppearanceToggles(form, api, scope) {
    if (!form || !scope || !api?.mountToggle) return;
    ['showHomeVisualBrand', 'showHomeVisualTagline'].forEach(id => {
        const input = form.querySelector(`#${id}`);
        if (!input || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
        api.mountToggle(input, scope);
        input.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
    });
}
