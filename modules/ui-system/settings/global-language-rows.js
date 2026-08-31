// Global settings LanguageRow projection — the DeepSeek-style pill selector
// rows for the remaining global selects.  The native select stays the sole
// business node (hidden inside its row); the pill mirrors it like the
// appearance-area adapters: user-driven `change` and host-driven snapshot
// replay (`vcp-uiux-sync`) both re-converge the active label.
const LANGUAGE_ROW_FIELDS = [
    {
        id: 'assistantAgent', hostId: 'assistantAgentContainer', title: '划词助手 Agent', description: '划词内容交给所选 Agent 处理',
        // The agent list is populated (and repopulated) at runtime via
        // option-list rebuilds, so the pill must mirror those rebuilds.
        dynamic: true,
    },
    { id: 'middleClickQuickAction', hostId: 'middleClickQuickActionContainer', title: '中键快速执行功能', description: '按住中键从快捷环直接执行所选功能' },
    { id: 'voiceInputMode', hostId: 'voiceInputModeRow', title: '语音输入模式', description: '选择系统听写适配方式' },
    { id: 'streamAnimationPreset', hostId: 'streamAnimationSettingsRow', title: '流式内容动效', description: '消息内容进场动画样式' },
    { id: 'rustRuleMode', hostId: 'rustRuleModeRow', title: '规则模式', description: 'Rust 划词助手的文本处理规则' },
];

const collectOptions = select => [...select.options].map(option => ({ id: option.value, label: option.textContent.trim() }));

export function mountGlobalLanguageRows(form, api, scope) {
    if (!form || !scope || !api?.mountLanguageRow) return;
    LANGUAGE_ROW_FIELDS.forEach(({ id, hostId, title, description, dynamic }) => {
        const select = form.querySelector(`#${id}`);
        // Resolve the host by its stable row id: the canonical-row pass has
        // already replaced the legacy .vcp-settings-row/.form-group classes by
        // the time this adapter runs, but it preserves element ids.
        const host = (hostId && form.querySelector(`#${hostId}`)) || select?.closest('.vcp-harness-general-item, .vcp-settings-row, .form-group');
        if (!select || !host || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
        // Mark both the business node (the select projection skips marked
        // selects) and the host row (re-entrancy guard for this adapter).
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        host.dataset.vcpTypedPrimitiveMounted = 'true';
        const row = api.mountLanguageRow(host, {
            title, description,
            options: collectOptions(select),
            activeId: select.value,
            onSelect: value => {
                if (select.value === value) return;
                select.value = value;
                select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
            },
        }, scope);
        scope.listen(select, 'change', () => row.setActive(select.value), undefined, `typed-${id}-language-row-sync`);
        scope.listen(select, 'vcp-uiux-sync', () => row.setActive(select.value), undefined, `typed-${id}-language-row-sync-replay`);
        scope.own(() => { delete host.dataset.vcpTypedPrimitiveMounted; delete select.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-language-row-marker`, 'ui-primitive');
        scope.own(() => row.dispose(), `typed-${id}-language-row`, 'ui-primitive');
        if (dynamic) {
            // Population replaces the option list in place; mirror every
            // rebuild into the pill, then re-converge the active label.
            const observer = new MutationObserver(() => {
                void row.setOptions(collectOptions(select));
                row.setActive(select.value);
            });
            observer.observe(select, { childList: true });
            scope.own(() => observer.disconnect(), `typed-${id}-language-row-options-observer`, 'observer');
        }
    });
}
