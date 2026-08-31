// Forum credential primitive mounting. Save/dirty semantics remain in the
// ForumConfigUiService field owner.
export function mountForumCredentialInputs(form, api, scope) {
    if (!form || !scope || !api?.mountInput) return;
    ['adminUsername', 'adminPassword'].forEach(id => {
        const input = form.querySelector(`#${id}`);
        if (!input || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
        api.mountInput(input, {}, scope);
        input.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
    });
}
