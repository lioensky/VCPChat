// Global identity ColorPair primitive mounting. Native color/text inputs stay
// canonical; callbacks only update presentation preview and validation UI.
export function mountIdentityColorPairs(form, api, scope, showToast = () => {}) {
    if (!form || !scope || !api?.mountColorPair) return;
    [['#userAvatarBorderColor', '#userAvatarBorderColorText', 'avatar-border'],
        ['#userNameTextColor', '#userNameTextColorText', 'user-name-text']].forEach(([colorId, textId, name]) => {
        const color = form.querySelector(colorId);
        const text = form.querySelector(textId);
        if (!color || !text || color.dataset.vcpTypedPrimitiveMounted === 'true') return;
        try {
            api.mountColorPair(color, text, scope, {
                onValueChange: value => {
                    if (name === 'avatar-border') form.querySelector('#userAvatarPreview')?.style.setProperty('border-color', value);
                },
                onInvalid: () => showToast('颜色格式无效，请使用 #RRGGBB 格式', 'warning'),
            });
            color.dataset.vcpTypedPrimitiveMounted = 'true';
            scope.own(() => { delete color.dataset.vcpTypedPrimitiveMounted; }, `typed-${name}-color-marker`, 'ui-primitive');
        } catch (error) {
            console.warn('[VCPUI SettingsBridge] Could not mount identity color pair primitive:', error);
        }
    });
}
