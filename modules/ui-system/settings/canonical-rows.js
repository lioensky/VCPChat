// canonical-rows — one canonical row system for the unified settings surface.
// The upstream form row is retained as the business anchor; geometry, spacing
// and typography belong to the canonical wrapper.
import { sectionKeyForRow, sectionKeyForTitle } from './section-ownership.js';
function removeLegacySubsectionHeadings(form) {
    form.querySelectorAll('.vcp-harness-editor-section-heading').forEach(heading => {
        const section = heading.closest('.settings-section');
        // The section h3 is the single canonical heading.  Subsection cards
        // must not introduce a second title/description stack.
        if (section?.querySelector(':scope > .settings-section-title')) heading.remove();
    });
}

function mountCanonicalSettingsRows(form) {
    if (!form) return;
    // Legacy <hr> separators predate row-owned dividers and each draws its own
    // top+bottom line pair next to the row hairline.  Removing them here (the
    // canonical pass) replaces the retired CSS display:none rule.
    form.querySelectorAll('hr').forEach(separator => separator.remove());
    form.querySelectorAll(':scope > .settings-section').forEach(section => {
        // The stamped attribute is authoritative (main.html); the title map
        // only backfills DOM built without it.
        const key = section.dataset.settingsSectionKey
            || sectionKeyForTitle(section.querySelector(':scope > .settings-section-title')?.textContent);
        if (key) section.dataset.settingsSectionKey = key;
    });
    const candidates = form.querySelectorAll(
        ':scope [data-vcp-settings-row], :scope [data-vcp-settings-control-row], :scope .vcp-settings-row, :scope .vcp-settings-control-row, :scope .settings-form-group, :scope .form-group-inline, :scope > .form-group, :scope .form-group'
    );
    candidates.forEach(row => {
        if (!(row instanceof HTMLElement) || row.closest('.vcp-harness-general-item')) return;
        if (!row.querySelector('input, select, textarea, button, [role="switch"]')) return;
        const keyNode = row.querySelector('[name], [id]');
        const key = keyNode?.getAttribute('name') || keyNode?.id || '';
        const item = document.createElement(row.tagName.toLowerCase());
        const preservedClasses = [...row.classList].filter(className => ![
            'settings-form-group', 'form-group-inline', 'vcp-settings-row', 'vcp-settings-control-row',
            'form-group'
        ].includes(className));
        item.className = ['vcp-harness-general-item', 'vcp-harness-general-row', ...preservedClasses].join(' ');
        for (const attribute of row.attributes) {
            if (attribute.name === 'class' || attribute.name === 'style') continue;
            item.setAttribute(attribute.name, attribute.value);
        }
        item.dataset.settingPrimitive = 'general-item';
        const sectionKey = sectionKeyForRow(row);
        if (sectionKey) item.dataset.settingsSectionKey = sectionKey;
        // 阶段 3 扁平化后 appearance 分区整体是 feature-owned 行区；旧包裹类只
        // 兜底挂载时尚未盖 section key 的 DOM。
        const appearanceOwner = row.closest('.appearance-settings-section, .appearance-sidebar-geometry-section, .appearance-home-tagline-setting, [data-settings-section-key="appearance-settings"]');
        if (appearanceOwner) {
            item.dataset.settingPrimitive = 'appearance-row';
            item.classList.add('vcp-harness-appearance-row');
        }
        if (key) item.dataset.settingKey = key;
        item.dataset.canonicalRow = 'true';
        row.replaceWith(item);
        item.append(...[...row.childNodes]);
        row.remove();
        composeCanonicalRowSlots(item);
    });
    form.dataset.vcpCanonicalRowsMounted = 'true';
}

function composeCanonicalRowSlots(row) {
    if (!row || row.matches('label, fieldset') || row.querySelector(':scope > .vcp-harness-row-copy')) return;
    const children = [...row.children];
    const controls = children.filter(node => node.matches('input, select, textarea, button, .switch, .model-input-container, .vcp-harness-select, .vcp-uiux-input-wrap'));
    // A control that also matches the title selectors (label.switch) must not
    // be copied into the copy slot: append would move it, then the trailing
    // controls pass would move it back out, leaving an empty copy beside the
    // original title wrapper.
    const titles = children.filter(node => node.matches('label, span, strong, h4, h5') && !controls.includes(node));
    const helpers = children.filter(node => node.matches('small, p'));
    if (!controls.length || !titles.length) return;
    const copy = document.createElement('div');
    copy.className = 'vcp-harness-row-copy';
    copy.dataset.settingPrimitive = 'row-copy';
    [...titles, ...helpers].forEach(node => copy.append(node));
    const remaining = children.filter(node => !copy.contains(node) && !controls.includes(node));
    row.replaceChildren(copy, ...remaining, ...controls);
}

export { mountCanonicalSettingsRows, removeLegacySubsectionHeadings };
