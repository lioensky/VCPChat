// Global settings language/font-size row activation — M5-c pass4 起，语言行与
// 字号行的结构全部由渲染器直出（field-renderer 的 buildLanguageRowStructure /
// buildFontSizeRowStructure 与 widgets 的场景字体行），本模块只激活行为：
// 胶囊菜单挂载、标签镜像（用户驱动的 change 与宿主驱动的 vcp-uiux-sync 快照
// 回放都重新收敛激活标签）以及动态选项重建镜像（划词 Agent 列表运行时填充）。
// 原生 select 仍是唯一业务节点；本模块在激活前统一打 vcpTypedPrimitiveMounted
// 标记（M5-c pass5 起 select-projection 已在 schema 面退役，标记即"已收编"
// 的唯一凭证；agent 设置面仍消费 select-projection，语义不变）。
const collectOptions = select => [...select.options].map(option => ({ id: option.value, label: option.textContent.trim() }));

export function mountGlobalLanguageRows(form, api, scope) {
    if (!form || !scope || !api?.activateLanguageRow || !api?.activateFontSizeRow) return;
    // 字号行：select 在行内，激活只绑 px 读数/归一化/箭头行为。
    form.querySelectorAll('.vcp-uiux-font-size-row').forEach(row => {
        const select = row.querySelector('select');
        if (!select || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        api.activateFontSizeRow(row, select, scope);
        scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, 'typed-font-size-row-marker', 'ui-primitive');
    });
    // 语言行：宿主行是直出结构的父节点，select 是宿主内的业务锚点。
    form.querySelectorAll('.vcp-uiux-language-row').forEach(row => {
        const host = row.parentElement;
        const select = host?.querySelector('select');
        if (!host || !select || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        const controller = api.activateLanguageRow(host, {
            options: collectOptions(select),
            activeId: select.value,
            onSelect: value => {
                if (select.value === value) return;
                select.value = value;
                select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
            },
        }, scope);
        scope.listen(select, 'change', () => controller.setActive(select.value), undefined, `typed-${select.id}-language-row-sync`);
        scope.listen(select, 'vcp-uiux-sync', () => controller.setActive(select.value), undefined, `typed-${select.id}-language-row-sync-replay`);
        scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, `typed-${select.id}-language-row-marker`, 'ui-primitive');
        // 选项列表运行期重建（划词 Agent 列表填充等）时镜像进胶囊，再收敛
        // 激活标签；非动态行的列表从不重建，观察器只是空挂。
        const observer = new MutationObserver(() => {
            void controller.setOptions(collectOptions(select));
            controller.setActive(select.value);
        });
        observer.observe(select, { childList: true });
        scope.own(() => observer.disconnect(), `typed-${select.id}-language-row-options-observer`, 'observer');
    });
}
