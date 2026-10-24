// extensions — 可选功能（modules/*/feature.json）往全局设置里加分区。
// 功能模块在渲染进程里调用 registerSettingsSection，早于或晚于设置壳挂载都行：
// schema-surface 渲染分区内容，settings-bridge 补上导航行。核心不认识具体功能，
// 功能目录删掉，分区就不出现。
// requestSettingsSection(key) 让设置壳切到某个分区：壳已挂载就立刻切，没挂载就等它挂载时切。

const sections = new Map();
const listeners = new Set();
let requestedKey = null;

function notify(change) {
    for (const listener of [...listeners]) {
        try {
            listener(change);
        } catch (error) {
            console.error('[SettingsExtensions] listener failed:', error);
        }
    }
}

/**
 * @param {{ section: { key: string }, label: string, icon?: string }} extension
 *   section 是 schema kernel 的 section(...) 产物；label 是导航上的名字，icon 是 vcp-ui-icon 名
 */
export function registerSettingsSection({ section, label, icon = 'circle' }) {
    const key = section?.key;
    if (!key || !label) throw new TypeError('registerSettingsSection 需要 section.key 和 label');
    if (sections.has(key)) throw new Error(`设置分区重名: ${key}`);
    const extension = Object.freeze({ key, section, label, icon });
    sections.set(key, extension);
    notify({ type: 'section', extension });
}

export function settingsSectionExtensions() {
    return [...sections.values()];
}

export function requestSettingsSection(key) {
    requestedKey = String(key || '') || null;
    if (requestedKey) notify({ type: 'request', key: requestedKey });
}

// 设置壳挂载或切换时取走请求，只用一次
export function takeRequestedSettingsSection() {
    const key = requestedKey;
    requestedKey = null;
    return key;
}

export function onSettingsExtensionChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
