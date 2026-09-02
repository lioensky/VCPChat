import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../modules/ui-system/settings-bridge.js', import.meta.url), 'utf8');
const ownership = fs.readFileSync(new URL('../modules/ui-system/settings/section-ownership.js', import.meta.url), 'utf8');
const doc = fs.readFileSync(new URL('../docs/global-settings-section-ownership.md', import.meta.url), 'utf8');
const settingsDir = new URL('../modules/ui-system/settings/', import.meta.url);
const identity = fs.readFileSync(new URL('identity-controls.js', settingsDir), 'utf8');
const typedOwners = fs.readFileSync(new URL('../modules/ui-system/typed-field-owners.js', import.meta.url), 'utf8');
const sections = ['user-identity', 'server-connection', 'appearance-settings', 'render-settings', 'selection-assistant', 'voice-settings', 'advanced-features', 'quick-actions'];
for (const section of sections) assert.ok(doc.includes(`| \`${section}\` |`), `ownership document must list ${section}`);
assert.match(bridge, /function enhanceGlobalSettings\(root, form\)/, 'bridge must retain one global section entry point during migration');
assert.match(`${bridge}\n${identity}`, /(?:function mountTypedAvatarColorPair|export function mountIdentityColorPairs)\(/, 'identity owner must remain explicit');
assert.match(ownership, /section\?\.dataset\?\.settingsSectionKey/, 'section ownership must honor the stamped section key attribute');
for (const section of sections) assert.match(ownership, new RegExp(`'[^']+'\\s*:\\s*'${section}'`), `section key must map ${section}`);
const mainHtml = fs.readFileSync(new URL('../main.html', import.meta.url), 'utf8');
for (const section of sections) {
    assert.ok(mainHtml.includes(`id="section-${section}" data-settings-section-key="${section}"`),
        `main.html must stamp data-settings-section-key on section-${section}`);
}
assert.doesNotMatch(bridge, /createGlobalSettingsStore|new GlobalSettingsStore/, 'section contract must not add a second durable store');

// Every control the settings JS binds must actually exist in main.html.
// A three-way merge can drop markup while keeping the code that drives it;
// those lookups are written defensively (`if (!el) return`), so the loss is
// silent -- no crash, no red assertion, and a screenshot shows nothing wrong
// beyond a feature that simply never appears. This contract turns that whole
// class of regression into a hard failure.
const controlProbeFiles = [
    'modules/renderer/mainChatSettingsPresentationOwner.js',
    'modules/ui-system/settings-bridge.js',
    'modules/ui-system/typed-field-owners.js',
    'modules/global-settings-manager.js',
    'modules/settingsManager.js',
    'modules/ui-system/settings/render-visibility.js',
    'modules/ui-system/settings/dependent-rows.js',
];
// Ids intentionally absent from main.html, each with the reason it is safe:
// containers the flattening removed or renamed (the JS guards them or falls
// back to the new id), plus ids upstream does not ship either.
const controlProbeAllowlist = new Map([
    ['streamAnimationCustomPanel', 'flattened to streamAnimationCustomRow; the lookup falls back to it'],
    ['rustGuardRulesContainer', 'nested container removed by flattening; guarded with if (container)'],
    ['userUseThemeColorsInChat', 'absent upstream as well; pre-existing optional control'],
    ['stripRegexListContainer', 'absent upstream as well; pre-existing optional container'],
    ['streamAnimationDurationValue', 'schema-rendered output label; not a static main.html id'],
]);
// M4 起设置分区没有静态标记：JS 绑定的 id 必须存在于 main.html（模态壳、
// 导航与非设置域）或 schema 编译产物之中。
const { JSDOM } = await import('jsdom');
const schemaDoc = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' }).window.document;
globalThis.document = schemaDoc;
globalThis.window = schemaDoc.defaultView;
const { schemaSurfaceSections } = await import('../modules/settings/schema-surface.js');
const { renderSchemaSection } = await import('../modules/settings/render/field-renderer.js');
const schemaSurfaceHost = schemaDoc.createElement('div');
for (const sectionDescriptor of schemaSurfaceSections()) {
    schemaSurfaceHost.append(...renderSchemaSection(sectionDescriptor, schemaDoc));
}
const htmlIds = new Set([
    ...[...mainHtml.matchAll(/id="([A-Za-z][A-Za-z0-9_-]*)"/g)].map(match => match[1]),
    ...[...schemaSurfaceHost.innerHTML.matchAll(/id="([A-Za-z][A-Za-z0-9_-]*)"/g)].map(match => match[1]),
]);
const missingControls = [];
for (const relativePath of controlProbeFiles) {
    const source = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
    const referenced = new Set([
        ...[...source.matchAll(/getElementById\(\s*['"]([A-Za-z][A-Za-z0-9_-]*)['"]/g)].map(match => match[1]),
        ...[...source.matchAll(/querySelector\(\s*['"]#([A-Za-z][A-Za-z0-9_-]*)['"]/g)].map(match => match[1]),
    ]);
    for (const id of referenced) {
        if (htmlIds.has(id) || controlProbeAllowlist.has(id)) continue;
        missingControls.push(`${id} (referenced by ${relativePath})`);
    }
}
assert.deepEqual(missingControls, [],
    `main.html is missing controls the settings JS binds:\n  ${missingControls.join('\n  ')}`);

console.log(`Global Settings section ownership contract passed (${sections.length} sections; single bridge entry preserved; ${htmlIds.size} markup ids cross-checked against ${controlProbeFiles.length} settings modules).`);
