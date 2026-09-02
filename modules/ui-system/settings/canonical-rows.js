// canonical-rows — one canonical row system for the unified settings surface.
// The upstream form row is retained as the business anchor; geometry, spacing
// and typography belong to the canonical wrapper.
// M5-b 起 canonical 化的单行机械变换与渲染器直出共享（render/canonical-row.js
// 的 canonicalizeRenderedRow）：本 pass 只负责候选扫描与 hr 清理，声明
// canonicalRows 的分区由 field-renderer 直接产出 canonical 行，这里经
// dataset.canonicalRow 已达标记跳过。
import { canonicalizeRenderedRow } from '../../settings/render/canonical-row.js';
import { sectionKeyForRow } from './section-ownership.js';
function mountCanonicalSettingsRows(form) {
    if (!form) return;
    // Legacy <hr> separators predate row-owned dividers and each draws its own
    // top+bottom line pair next to the row hairline.  Removing them here (the
    // canonical pass) replaces the retired CSS display:none rule.
    form.querySelectorAll('hr').forEach(separator => separator.remove());
    // 分区归属只认 main.html 分区壳盖的 data-settings-section-key（M4 起壳
    // 永远带戳）；行级归属由 sectionKeyForRow 统一读取。
    const candidates = form.querySelectorAll(
        ':scope [data-vcp-settings-row], :scope [data-vcp-settings-control-row], :scope .vcp-settings-row, :scope .vcp-settings-control-row, :scope .settings-form-group, :scope .form-group-inline, :scope > .form-group, :scope .form-group'
    );
    candidates.forEach(row => {
        if (!(row instanceof HTMLElement)) return;
        // 渲染器直出的 canonical 行（含其嵌套行）已达标记，二次进入直接跳过。
        if (row.dataset.canonicalRow === 'true' || row.closest('[data-canonical-row="true"]')) return;
        canonicalizeRenderedRow(row, sectionKeyForRow(row));
    });
    form.dataset.vcpCanonicalRowsMounted = 'true';
}

export { mountCanonicalSettingsRows };
