// Appearance Range primitive mounting. Native range inputs remain canonical.
export function mountAppearanceRanges(form, api, scope) {
    if (!form || !scope || (!api?.mountNumericStepperRow && !api?.mountRange)) return;
    [['appearanceSidebarAvatarSize', '头像大小', '调整侧栏头像的显示尺寸'],
        ['appearanceSidebarRowHeight', '列表项高度', '调整侧栏列表项的高度'],
        ['appearanceCustomRadius', '自定义圆角值', '调整列表项的自定义圆角']].forEach(([id, title, description]) => {
        const input = form.querySelector(`#${id}`);
        const host = input?.parentElement;
        if (!input || !host || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
        if (api.mountNumericStepperRow) api.mountNumericStepperRow(host, input, { title, description }, scope);
        else api.mountRange(input, { output: form.querySelector(`#${id}Value`), format: value => `${value}px` }, scope);
        input.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
    });
}
