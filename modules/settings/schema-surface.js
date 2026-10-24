// schema-surface — schema 渲染面的挂载（实验分支 exp/settings-schema，M4 起转正）。
// M0-M3 双轨期用 localStorage 开关切换新旧 surface 做像素/行为对照；M4 删除
// main.html 静态设置标记后 schema 面成为唯一呈现，enhanceGlobalSettings 进入
// 管线之前把全部分区原地替换为 schema 编译产物。替换只动分区容器的子节点，
// 分区元素本身保持身份稳定（settings-shell 的分区索引与导航不受影响）。
// 幂等性：分区容器打上 vcpSchemaRendered 持久标记，重复 refresh 不重渲染。
// 现值迁移：M4 静态标记退役后首渲染没有可采集的现值，持久值由
// typed-field-owners 的快照投影按 id 回填；populate 出来的 select 选项、
// 动态追加的子行都在渲染之后由各自服务填充（M4-c 起 adopt/快照迁移路径
// 随静态面一并退役）。
import { quickActionsSection } from './schema/quick-actions.js';
import { userIdentitySection } from './schema/user-identity.js';
import { serverConnectionSection } from './schema/server-connection.js';
import { jevServiceSection } from './schema/jev-service.js';
import { renderSettingsSection } from './schema/render-settings.js';
import { selectionAssistantSection } from './schema/selection-assistant.js';
import { voiceSettingsSection } from './schema/voice-settings.js';
import { advancedFeaturesSection } from './schema/advanced-features.js';
import { workspaceManagementSection } from './schema/workspace-management.js';
import { appearanceSettingsSection } from './schema/appearance-settings.js';
import { renderSchemaSection } from './render/field-renderer.js';
import { settingsSectionExtensions } from './extensions.js';

// 已迁移到 schema 渲染的分区清单；M3（界面与外观）已收齐全部分区。
const SCHEMA_SECTIONS = Object.freeze([
    userIdentitySection,
    serverConnectionSection,
    jevServiceSection,
    appearanceSettingsSection,
    renderSettingsSection,
    selectionAssistantSection,
    voiceSettingsSection,
    advancedFeaturesSection,
    workspaceManagementSection,
    quickActionsSection,
]);

// 核心分区加上可选功能注册进来的分区（modules/settings/extensions.js）
export function schemaSurfaceSections() {
    const extensions = settingsSectionExtensions();
    return extensions.length ? [...SCHEMA_SECTIONS, ...extensions.map(extension => extension.section)] : SCHEMA_SECTIONS;
}

// 把全部分区替换为 schema 编译产物；返回发生替换的分区 key 列表。
export function applySchemaSurface(form, doc = form?.ownerDocument || undefined) {
    if (!form || !doc) return [];
    const replacedKeys = [];
    for (const sectionDescriptor of schemaSurfaceSections()) {
        // 核心分区的壳在 main.html 里，缺了就不渲染；只有可选功能注册的分区由这里补壳
        const host = form.querySelector(`#section-${sectionDescriptor.key}`)
            || (SCHEMA_SECTIONS.includes(sectionDescriptor) ? null : appendSectionHost(form, doc, sectionDescriptor.key));
        if (!host || host.dataset.vcpSchemaRendered === 'true') continue;
        host.replaceChildren(...renderSchemaSection(sectionDescriptor, doc));
        host.dataset.vcpSchemaRendered = 'true';
        replacedKeys.push(sectionDescriptor.key);
    }
    return replacedKeys;
}

// main.html 只写了核心分区的壳；功能注册进来的分区在这里补一个同样的壳
function appendSectionHost(form, doc, key) {
    const host = doc.createElement('div');
    host.className = 'settings-section';
    host.id = `section-${key}`;
    host.dataset.settingsSectionKey = key;
    form.append(host);
    return host;
}
