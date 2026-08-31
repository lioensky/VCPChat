// Stable presentation keys for the canonical Global Settings rows. This is
// metadata only: settingsManager and the native controls remain authoritative.
const SECTION_KEYS = Object.freeze({
    '用户身份': 'user-identity',
    '服务器连接': 'server-connection',
    '界面与外观': 'appearance-settings',
    '消息渲染': 'render-settings',
    '划词助手': 'selection-assistant',
    '语音设置': 'voice-settings',
    '高级功能': 'advanced-features',
    '快捷操作': 'quick-actions',
});

function sectionKeyForSection(section) {
    // main.html stamps data-settings-section-key on every section root; that
    // attribute is authoritative so renaming the visible title cannot silently
    // re-key the section.  The Chinese-title map stays as a fallback for DOM
    // built without the attribute (test fixtures, partial templates).
    const key = section?.dataset?.settingsSectionKey;
    if (key) return key;
    const title = section?.querySelector?.(':scope > .settings-section-title')?.textContent?.trim();
    return title ? SECTION_KEYS[title] || '' : '';
}

function sectionKeyForRow(row) {
    return sectionKeyForSection(row?.closest?.('.settings-section'));
}

function sectionKeyForTitle(title) {
    return SECTION_KEYS[String(title || '').trim()] || '';
}

export { SECTION_KEYS, sectionKeyForSection, sectionKeyForRow, sectionKeyForTitle };
