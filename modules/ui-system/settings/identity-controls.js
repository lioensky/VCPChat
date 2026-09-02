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
            const pill = color.closest('.vcp-color-single-pill');
            const isColorLight = (hex) => {
                if (!hex || typeof hex !== 'string') return false;
                let clean = hex.replace('#', '');
                if (clean.length === 3) clean = clean.split('').map(c => c + c).join('');
                if (clean.length !== 6) return false;
                const r = parseInt(clean.substring(0, 2), 16);
                const g = parseInt(clean.substring(2, 4), 16);
                const b = parseInt(clean.substring(4, 6), 16);
                if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
                return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b) > 160;
            };

            const updatePill = (hexVal) => {
                if (!pill) return;
                const hex = (hexVal || '').trim();
                if (!hex || !hex.startsWith('#')) return;
                pill.style.backgroundColor = hex;
                const light = isColorLight(hex);
                pill.style.color = light ? '#111111' : '#ffffff';
                pill.classList.toggle('is-light', light);
                if (text && text.value.toLowerCase() !== hex.toLowerCase()) {
                    text.value = hex.toUpperCase();
                }
            };

            api.mountColorPair(color, text, scope, {
                onValueChange: value => {
                    if (name === 'avatar-border') form.querySelector('#userAvatarPreview')?.style.setProperty('border-color', value);
                    updatePill(value);
                },
                onInvalid: () => showToast('颜色格式无效，请使用 #RRGGBB 格式', 'warning'),
            });
            color.dataset.vcpTypedPrimitiveMounted = 'true';
            scope.own(() => { delete color.dataset.vcpTypedPrimitiveMounted; }, `typed-${name}-color-marker`, 'ui-primitive');

            if (pill) {
                const openPicker = (e) => {
                    if (e.target === text) return;
                    e.preventDefault();
                    try {
                        if (typeof color.showPicker === 'function') {
                            color.showPicker();
                        } else {
                            color.click();
                        }
                    } catch {
                        color.click();
                    }
                };
                pill.addEventListener('click', openPicker);
                scope.own(() => pill.removeEventListener('click', openPicker), `pill-click-${name}`, 'ui-primitive');
            }

            const syncFromInput = () => {
                const val = (text.value || color.value || '').trim();
                updatePill(val);
                if (color && val && val.startsWith('#') && val.length === 7) {
                    color.value = val;
                }
            };

            updatePill(text.value || color.value);
            scope.listen(color, 'vcp-uiux-sync', syncFromInput);
            scope.listen(text, 'vcp-uiux-sync', syncFromInput);
            scope.listen(color, 'input', syncFromInput);
            scope.listen(color, 'change', syncFromInput);
            scope.listen(text, 'input', syncFromInput);
            scope.listen(text, 'change', syncFromInput);
        } catch (error) {
            console.warn('[VCPUI SettingsBridge] Could not mount identity color pair primitive:', error);
        }
    });
}
