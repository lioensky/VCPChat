import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../modules/ui-system/settings-bridge.js', import.meta.url), 'utf8');
const rows = fs.readFileSync(new URL('../modules/ui-system/settings/canonical-rows.js', import.meta.url), 'utf8');
const ownership = fs.readFileSync(new URL('../modules/ui-system/settings/section-ownership.js', import.meta.url), 'utf8');
const doc = fs.readFileSync(new URL('../docs/global-settings-section-ownership.md', import.meta.url), 'utf8');
const settingsDir = new URL('../modules/ui-system/settings/', import.meta.url);
const identity = fs.readFileSync(new URL('identity-controls.js', settingsDir), 'utf8');
const choices = fs.readFileSync(new URL('choice-controls.js', settingsDir), 'utf8');
const advancedVisibility = fs.readFileSync(new URL('../modules/ui-system/settings/advanced-visibility.js', import.meta.url), 'utf8');
const typedOwners = fs.readFileSync(new URL('../modules/ui-system/typed-field-owners.js', import.meta.url), 'utf8');
const rustVisibility = fs.readFileSync(new URL('../modules/ui-system/settings/rust-visibility.js', import.meta.url), 'utf8');
const sections = ['user-identity', 'server-connection', 'appearance-settings', 'render-settings', 'selection-assistant', 'voice-settings', 'advanced-features', 'quick-actions'];
for (const section of sections) assert.ok(doc.includes(`| \`${section}\` |`), `ownership document must list ${section}`);
assert.match(bridge, /function enhanceGlobalSettings\(root, form\)/, 'bridge must retain one global section entry point during migration');
assert.match(`${bridge}\n${identity}`, /(?:function mountTypedAvatarColorPair|export function mountIdentityColorPairs)\(/, 'identity owner must remain explicit');
assert.match(`${bridge}\n${choices}`, /(?:function mountTypedGlobalChoiceGroups|export function mountChoiceControls)\(/, 'choice owner must remain explicit');
assert.match(bridge, /function mountUiuxInputs\(/, 'input owner must remain explicit');
assert.match(rows, /sectionKeyForRow\(row\)/, 'canonical rows must publish section ownership metadata');
assert.match(rows, /section\.dataset\.settingsSectionKey/, 'canonical section roots must honor the stamped section key attribute');
assert.match(rows, /sectionKeyForTitle\(/, 'canonical section roots must keep the title map as fallback');
assert.match(advancedVisibility, /export function syncAdvancedSettingsVisibility\(form\)/, 'advanced helper must expose one section projection contract');
assert.match(rustVisibility, /export function syncRustAssistantVisibility\(form\)/, 'Rust helper must expose one section projection contract');
assert.match(`${bridge}\n${typedOwners}`, /syncAdvancedSettingsVisibility\(form\)/, 'the bridge composition must invoke the advanced section helper');
assert.match(`${bridge}\n${typedOwners}`, /syncRustAssistantVisibility\(form\)/, 'the bridge composition must invoke the Rust section helper');
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
    'modules/ui-system/settings/canonical-rows.js',
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
]);
const htmlIds = new Set([...mainHtml.matchAll(/id="([A-Za-z][A-Za-z0-9_-]*)"/g)].map(match => match[1]));
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
