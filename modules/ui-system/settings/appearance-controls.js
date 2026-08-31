// Appearance section primitive mounting. The native selects remain the
// canonical business controls; this helper owns only generated presentation.
export function mountAppearanceSelects(form, api, scope) {
    if (!form || !scope || !api?.mountSelect) return;
    const fields = [
        ['appearanceDensity', '界面密度'],
        ['appearanceRadius', '圆角风格'],
        ['appearanceTypography', '界面字体'],
        ['appearanceContentWidth', '内容宽度'],
        ['appearanceSurface', '页面材质'],
    ];
    fields.forEach(([id, label]) => {
        const select = form.querySelector(`#${id}`);
        if (!select || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
        if (api.mountField && select.parentElement) api.mountField(select.parentElement, { label, control: select }, scope);
        api.mountSelect(select, { label, portal: true }, scope);
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
    });
}

export function mountAppearanceLanguageRows(form, api, scope) {
    if (!form || !scope || !api?.mountLanguageRow) return;
    const fields = [
        ['appearanceDensity', '界面密度', '调整设置页与工作区控件的疏密程度'],
        ['appearanceRadius', '圆角', '调整页面容器与控件的圆角风格'],
        ['appearanceTypography', '界面字体', '选择界面使用的字体风格'],
        ['appearanceContentWidth', '内容宽度', '调整工作区内容的最大阅读宽度'],
        ['appearanceSurface', '导航材质', '选择侧栏与页面的表面材质'],
    ];
    fields.forEach(([id, title, description]) => {
        const host = form.querySelector(`#${id}Row`);
        const select = form.querySelector(`#${id}`);
        if (!host || !select || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        const options = Array.from(select.options).map(option => ({ id: option.value, label: option.textContent || option.value }));
        const row = api.mountLanguageRow(host, { title, description, options, activeId: select.value, onSelect: value => {
            select.value = value;
            select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
        } }, scope);
        // Snapshot replay writes the canonical select programmatically and
        // signals it with vcp-uiux-sync; without this mirror the pill keeps
        // its mount-time label while the native select moves on.
        scope.listen(select, 'change', () => row.setActive(select.value), undefined, `typed-${id}-language-row-sync`);
        scope.listen(select, 'vcp-uiux-sync', () => row.setActive(select.value), undefined, `typed-${id}-language-row-sync-replay`);
        scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-language-row-marker`, 'ui-primitive');
    });
}

export function mountAppearanceFontSizeRow(form, api, scope) {
    const host = form?.querySelector('#appearanceFontScaleRow');
    const select = form?.querySelector('#appearanceFontScale');
    if (!host || !select || !scope || !api?.mountFontSizeRow || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
    select.dataset.vcpTypedPrimitiveMounted = 'true';
    api.mountFontSizeRow(host, select, scope);
    scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, 'typed-appearance-font-size-marker', 'ui-primitive');
}

export function mountChatFontRows(form, api, scope) {
    if (!form || !scope || !api?.mountLanguageRow) return;
    const fields = [
        ['chatFontPresetRow', 'chatFontPreset', '聊天字体', '选择聊天正文使用的字体'],
        ['chatCodeFontPresetRow', 'chatCodeFontPreset', '代码字体', '选择代码块使用的字体'],
        ['chatDiaryFontPresetRow', 'chatDiaryFontPreset', '场景字体', '选择日记与文学块使用的字体'],
        ['chatToolFontPresetRow', 'chatToolFontPreset', '场景字体', '选择工具结果与系统卡片使用的字体'],
    ];
    fields.forEach(([hostId, id, title, description]) => {
        const host = form.querySelector(`#${hostId}`); const select = form.querySelector(`#${id}`);
        if (!host || !select || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        const options = Array.from(select.options).map(option => ({ id: option.value, label: option.textContent || option.value }));
        const row = api.mountLanguageRow(host, { title, description, options, activeId: select.value, onSelect: value => {
            select.value = value;
            select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
        } }, scope);
        scope.listen(select, 'change', () => row.setActive(select.value), undefined, `typed-${id}-language-row-sync`);
        scope.listen(select, 'vcp-uiux-sync', () => row.setActive(select.value), undefined, `typed-${id}-language-row-sync-replay`);
        scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-language-row-marker`, 'ui-primitive');
    });
}

export function mountAppearanceRadiusLanguageRow(form, api, scope) {
    const host = form?.querySelector('#appearanceSidebarRadiusLanguageRow');
    const select = form?.querySelector('#appearanceSidebarRadius');
    if (!host || !select || !scope || !api?.mountLanguageRow || host.dataset.vcpTypedPrimitiveMounted === 'true') return;
    select.dataset.vcpTypedPrimitiveMounted = 'true';
    const options = Array.from(select.options).map(option => ({ id: option.value, label: option.textContent || option.value }));
    const row = api.mountLanguageRow(host, {
        title: '列表项圆角',
        description: '控制助手、话题和账户列表项的圆角',
        options,
        activeId: select.value,
        onSelect: id => {
            select.value = id;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        },
    }, scope);
    host.dataset.vcpTypedPrimitiveMounted = 'true';
    scope.listen(select, 'change', () => row.setActive(select.value), undefined, 'typed-radius-language-row-sync');
    scope.listen(select, 'vcp-uiux-sync', () => row.setActive(select.value), undefined, 'typed-radius-language-row-sync-replay');
    scope.own(() => { delete host.dataset.vcpTypedPrimitiveMounted; delete select.dataset.vcpTypedPrimitiveMounted; }, 'typed-radius-language-row-marker', 'ui-primitive');
    scope.own(() => row.dispose(), 'typed-radius-language-row', 'ui-primitive');
}
