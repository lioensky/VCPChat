// Home tagline primitive mounting. The input remains the canonical form node.
export function mountHomeTaglineInput(form, api, scope) {
    if (!form || !scope || !api?.mountInput) return;
    const input = form.querySelector('#homeVisualTagline');
    if (!input || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
    api.mountInput(input, {}, scope);
    input.dataset.vcpTypedPrimitiveMounted = 'true';
    scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, 'typed-home-tagline-marker', 'ui-primitive');
}
