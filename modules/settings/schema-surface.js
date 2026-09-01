// schema-surface — schema 渲染面的切换与挂载（实验分支 exp/settings-schema）。
// 双轨迁移：默认关闭（沿用 main.html 静态标记）；localStorage 置
// `vcpchat-settings-schema=1` 后，enhanceGlobalSettings 进入管线之前把
// 已迁移分区替换为 schema 编译产物。替换只动分区容器的子节点，分区
// 元素本身保持身份稳定（settings-shell 的分区索引与导航不受影响）。
// 幂等性：分区容器打上 vcpSchemaRendered 持久标记，重复 refresh 不重渲染。
// 现值迁移：替换前采集控件快照、替换后回写；动态节点（populate 出来的
// select 选项、动态追加的路径输入行）按 adoptNodeIds 整体保留原节点。
import { quickActionsSection } from './schema/quick-actions.js';
import { userIdentitySection } from './schema/user-identity.js';
import { serverConnectionSection } from './schema/server-connection.js';
import { renderSettingsSection } from './schema/render-settings.js';
import { selectionAssistantSection } from './schema/selection-assistant.js';
import { voiceSettingsSection } from './schema/voice-settings.js';
import { advancedFeaturesSection } from './schema/advanced-features.js';
import { renderSchemaSection } from './render/field-renderer.js';
import { captureSectionValues, restoreSectionValues } from './store.js';

const SCHEMA_TOGGLE_KEY = 'vcpchat-settings-schema';

// 已迁移到 schema 渲染的分区清单；M3（界面与外观）完成后收齐全部。
const SCHEMA_SECTIONS = Object.freeze([
    userIdentitySection,
    serverConnectionSection,
    renderSettingsSection,
    selectionAssistantSection,
    voiceSettingsSection,
    advancedFeaturesSection,
    quickActionsSection,
]);

export function isSchemaSurfaceEnabled() {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(SCHEMA_TOGGLE_KEY) === '1';
    } catch {
        return false;
    }
}

export function schemaSurfaceSections() {
    return SCHEMA_SECTIONS;
}

// 把已迁移分区替换为 schema 编译产物；返回发生替换的分区 key 列表。
export function applySchemaSurface(form, doc = form?.ownerDocument || undefined) {
    if (!form || !doc || !isSchemaSurfaceEnabled()) return [];
    const replacedKeys = [];
    for (const sectionDescriptor of SCHEMA_SECTIONS) {
        const host = form.querySelector(`#section-${sectionDescriptor.key}`);
        if (!host || host.dataset.vcpSchemaRendered === 'true') continue;
        // 静态标记里可能已被快照/回填路径写过现值（模板默认值之外的
        // 用户配置），替换前采集、替换后回写，避免一次渲染丢一次值。
        const adopted = captureSectionValues(form, sectionDescriptor);
        // 动态节点（populate 出来的 select 选项、动态追加的子行）先摘引
        // 用，替换后原节点搬回渲染产物，保留只有一次填充窗口的状态。
        const liveNodes = new Map();
        for (const id of sectionDescriptor.adoptNodeIds) {
            const node = host.querySelector(`#${id}`);
            if (node) liveNodes.set(id, node);
        }
        const rendered = renderSchemaSection(sectionDescriptor, doc);
        host.replaceChildren(...rendered);
        host.dataset.vcpSchemaRendered = 'true';
        for (const [id, node] of liveNodes) {
            const twin = host.querySelector(`#${id}`);
            if (twin && twin !== node) twin.replaceWith(node);
        }
        restoreSectionValues(host, adopted);
        replacedKeys.push(sectionDescriptor.key);
    }
    return replacedKeys;
}
