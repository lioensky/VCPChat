import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings bridge split invariants (refactor 2026-08-27, R2-02E item 4b).
// settings-bridge.js was a 2200-line module mixing a dozen concerns. This
// wave extracts the single-concern modules under modules/ui-system/settings/;
// these tests keep the extraction honest: one home per function, no cycles,
// and the entry stays the only writer of the public bridge global.

const root = process.cwd();
const bridgeEntry = path.join(root, 'modules', 'ui-system', 'settings-bridge.js');
const agentBridge = path.join(root, 'modules', 'ui-system', 'agent-settings-bridge.js');
const typedOwners = path.join(root, 'modules', 'ui-system', 'typed-field-owners.js');
const bridgeShared = path.join(root, 'modules', 'ui-system', 'settings', 'bridge-shared.js');
const eventListeners = path.join(root, 'modules', 'event-listeners.js');
const settingsDir = path.join(root, 'modules', 'ui-system', 'settings');
const read = file => fs.readFileSync(file, 'utf8');

test('single-concern modules import cleanly and expose their contract', async () => {
    const projection = await import(pathToFileURL(path.join(settingsDir, 'select-projection.js')).href);
    assert.equal(typeof projection.createSelectProjection, 'function');
    const api = projection.createSelectProjection({ ensurePresentationScope: () => null });
    assert.equal(typeof api.mount, 'function');
    assert.equal(typeof api.teardown, 'function');

    const autosave = await import(pathToFileURL(path.join(settingsDir, 'autosave.js')).href);
    assert.deepEqual(
        Object.keys(autosave).sort(),
        ['flushLegacyAutosave', 'mountSettingsAutosave', 'teardownLegacyAutosave'],
    );
    // Bridge-free operation: flush/teardown on an empty registry must no-op.
    autosave.flushLegacyAutosave();
    autosave.teardownLegacyAutosave();

    const rows = await import(pathToFileURL(path.join(settingsDir, 'canonical-rows.js')).href);
    assert.deepEqual(Object.keys(rows).sort(), ['mountCanonicalSettingsRows', 'removeLegacySubsectionHeadings']);

    const fields = await import(pathToFileURL(path.join(settingsDir, 'field-registry.js')).href);
    assert.deepEqual(
        Object.keys(fields).sort(),
        ['FIELDS', 'STEPPER_FIELDS', 'fieldDescriptor', 'fieldProjection', 'fieldRestore'],
    );
    assert.deepEqual(fields.STEPPER_FIELDS.map(field => field.id), [
        'minChunkBufferSize', 'smoothStreamIntervalMs', 'streamAnimationDurationMs', 'middleClickAdvancedDelay',
    ]);
    // Non-input projections must be queryable without re-hardcoding ids.
    assert.equal(fields.fieldProjection('homeVisualTagline'), 'raw');
    assert.equal(fields.fieldProjection('showHomeVisualTagline'), 'toggle');
    assert.equal(fields.fieldProjection('unknownField'), '');
    // 阶段 4 字段描述符（裁剪版 schema）：类型 / 恢复 / 校验 / redaction 槽位。
    assert.equal(fields.fieldDescriptor('adminPassword')?.type, 'secret');
    assert.equal(fields.fieldDescriptor('adminPassword')?.redaction, 'omit-log', 'secret-class fields register the redaction interface');
    assert.equal(fields.fieldDescriptor('middleClickAdvancedDelay')?.validation?.min, 1000);
    assert.equal(fields.fieldRestore('homeVisualTagline', {}),
        '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
    assert.equal(fields.fieldRestore('userNameTextColorText', { userNameTextColor: '#123456' }), '#123456');
    assert.equal(fields.fieldRestore('voiceInputShortcut', {}), 'F7');
    assert.equal(fields.fieldRestore('unknownField', {}), undefined);
    const registrySource = read(path.join(settingsDir, 'field-registry.js'));
    assert.ok(!/from\s+['"](?:schemastery|cordis)/i.test(registrySource), 'the trimmed descriptor schema must not grow schema-framework deps');

    const advanced = await import(pathToFileURL(path.join(settingsDir, 'advanced-visibility.js')).href);
    assert.equal(typeof advanced.syncAdvancedSettingsVisibility, 'function');
    const rust = await import(pathToFileURL(path.join(settingsDir, 'rust-visibility.js')).href);
    assert.equal(typeof rust.syncRustAssistantVisibility, 'function');
    const render = await import(pathToFileURL(path.join(settingsDir, 'render-visibility.js')).href);
    assert.equal(typeof render.syncRenderSettingsVisibility, 'function');
    const appearance = await import(pathToFileURL(path.join(settingsDir, 'appearance-controls.js')).href);
    assert.equal(typeof appearance.mountAppearanceSelects, 'function');
    const ranges = await import(pathToFileURL(path.join(settingsDir, 'appearance-ranges.js')).href);
    assert.equal(typeof ranges.mountAppearanceRanges, 'function');
    const toggles = await import(pathToFileURL(path.join(settingsDir, 'appearance-toggles.js')).href);
    assert.equal(typeof toggles.mountAppearanceToggles, 'function');
    const home = await import(pathToFileURL(path.join(settingsDir, 'home-controls.js')).href);
    assert.equal(typeof home.mountHomeTaglineInput, 'function');
    const identity = await import(pathToFileURL(path.join(settingsDir, 'identity-controls.js')).href);
    assert.equal(typeof identity.mountIdentityColorPairs, 'function');
    const choices = await import(pathToFileURL(path.join(settingsDir, 'choice-controls.js')).href);
    assert.equal(typeof choices.mountChoiceControls, 'function');
    const forum = await import(pathToFileURL(path.join(settingsDir, 'forum-controls.js')).href);
    assert.equal(typeof forum.mountForumCredentialInputs, 'function');
    const modelDirectory = await import(pathToFileURL(path.join(settingsDir, 'agent-model-picker-directory.js')).href);
    assert.equal(typeof modelDirectory.normalizeAgentModels, 'function');
    assert.equal(typeof modelDirectory.createAgentModelPickerDirectory, 'function');

    // 2026-08-31 domain split: shared presentation state, Agent sidebar and
    // typed settings seam each expose one narrow contract.
    const shared = await import(pathToFileURL(bridgeShared).href);
    for (const name of [
        'bridgeScope', 'ensurePresentationScope', 'isPresentationDestroyed', 'markPresentationDestroyed',
        'enhance', 'uniqueSettingsKey', 'selectProjection', 'mountHarnessSwitches',
        'releaseDisconnectedControllers', 'releaseAllControllers',
    ]) {
        assert.ok(name in shared, `bridge-shared must export ${name}`);
    }
    assert.equal(typeof shared.ensurePresentationScope, 'function');
    assert.equal(typeof shared.mountHarnessSwitches, 'function');
    const agent = await import(pathToFileURL(agentBridge).href);
    assert.deepEqual(Object.keys(agent).sort(), [
        'cleanupDisconnectedAgentModelPickers', 'enhanceForm',
        'mountTypedTopicSummaryModelPicker', 'releaseAllAgentModelPickers',
    ]);
    const owners = await import(pathToFileURL(typedOwners).href);
    assert.deepEqual(Object.keys(owners).sort(), [
        'addTypedNetworkPathInput', 'disposeTypedSettings', 'ensureAssistantRuntimeUiService',
        'ensureForumConfigUiService', 'ensureRustAssistantUiService', 'ensureTypedSettingsService',
        'flushTypedForumFields', 'flushTypedOwners', 'mountTypedFieldOwner',
        'mountTypedForumFieldOwner', 'mountTypedSettingsConsumer', 'teardownTypedOwners',
    ]);
    // Bridge-free operation: flush/teardown/dispose on an empty registry no-op.
    owners.flushTypedOwners();
    owners.teardownTypedOwners();
    owners.disposeTypedSettings();
});

test('Agent ModelPicker directory stays an injected short-lived capability', async () => {
    const { normalizeAgentModels, createAgentModelPickerDirectory } = await import(
        pathToFileURL(path.join(settingsDir, 'agent-model-picker-directory.js')).href,
    );
    assert.deepEqual(normalizeAgentModels({ models: [{ id: 'a' }] }), [{ id: 'a' }]);
    const calls = [];
    let updated;
    const input = { value: 'fav' };
    const api = {
        async getCachedModels() { calls.push('cache'); return [{ id: 'hot', name: 'Hot', provider: 'p' }, 'fav']; },
        async getHotModels() { calls.push('hot'); return ['hot']; },
        async getFavoriteModels() { calls.push('favorite'); return ['fav']; },
        async refreshModels() { calls.push('refresh'); },
        async toggleFavoriteModel(id) { calls.push(`toggle:${id}`); },
        onModelsUpdated(listener) { updated = listener; return () => { updated = undefined; }; },
    };
    const directory = createAgentModelPickerDirectory({ electronAPI: api, input });
    const options = await directory.options(new AbortController().signal);
    assert.deepEqual(options.map(option => [option.group, option.id]), [
        ['热门模型', 'hot'], ['收藏模型', 'fav'], ['全部模型', 'hot'], ['全部模型', 'fav'],
    ]);
    assert.equal(options.find(option => option.id === 'fav').active, true);
    await directory.toggleFavorite('hot', new AbortController().signal);
    assert.ok(calls.includes('toggle:hot'));
    const release = directory.subscribeUpdated(() => {});
    assert.equal(typeof release, 'function');
    release();
    assert.equal(updated, undefined);
});

test('each extracted function has exactly one home (entry or module, never both)', () => {
    const entry = read(bridgeEntry);
    const functions = [
        'mountSelectKeyboardGlue', 'mountHarnessSelects', 'teardownHarnessSelects',
        'removeLegacySubsectionHeadings', 'mountCanonicalSettingsRows', 'composeCanonicalRowSlots',
        'mountSettingsAutosave', 'flushLegacyAutosave', 'teardownLegacyAutosave',
        // 2026-08-31 domain split homes.
        'enhanceForm', 'mountTypedModelPicker', 'mountTypedSettingsConsumer', 'mountTypedFieldOwner',
        'mountTypedForumFieldOwner', 'addTypedNetworkPathInput', 'ensureTypedSettingsService',
        'mountHarnessSwitches', 'mountHarnessInputs', 'mountHarnessDisclosures',
        'enhance', 'uniqueSettingsKey', 'mountSettingsShell', 'flushTypedOwners',
    ];
    const moduleSource = [
        ...fs.readdirSync(settingsDir).filter(name => name.endsWith('.js')).map(name => read(path.join(settingsDir, name))),
        read(agentBridge), read(typedOwners),
    ].join('\n');
    for (const name of functions) {
        const inModule = moduleSource.includes(`function ${name}(`);
        const inEntry = entry.includes(`function ${name}(`);
        assert.notEqual(inModule, inEntry, `function ${name} must live in exactly one place`);
    }
    // The entry must not keep the extracted legacy registries as dead state.
    for (const state of ['primitiveSelectStates', 'selectObserverStates', 'autosaveStates']) {
        assert.ok(!new RegExp(`(?:^|\n)const ${state} =`).test(entry), `entry must not re-declare module-owned state ${state}`);
    }
    // The domain registries must move with their functions, not stay behind.
    for (const state of ['agentModelPickerReleases', 'agentSectionDisclosureStates', 'typedFieldStates', 'typedForumFieldStates']) {
        assert.ok(!entry.includes(`const ${state}`) && !entry.includes(`let ${state}`), `entry must not re-declare domain state ${state}`);
    }
});

test('no import cycles: settings/* modules never import the bridge entry', () => {
    const names = fs.readdirSync(settingsDir).filter(name => name.endsWith('.js'));
    const sources = [
        ...names.map(name => [name, read(path.join(settingsDir, name))]),
        ['agent-settings-bridge.js', read(agentBridge)],
        ['typed-field-owners.js', read(typedOwners)],
    ];
    for (const [name, source] of sources) {
        const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
        for (const target of imports) {
            assert.ok(!target.includes('settings-bridge'), `${name} must not import the bridge entry (cycle risk)`);
        }
    }
    // The domains must not reach into each other either: both depend on the
    // shared module only; the entry composes them.
    const agentImports = [...read(agentBridge).matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
    assert.ok(!agentImports.some(target => target.includes('typed-field-owners')), 'agent domain must not import the typed owners');
    const typedImports = [...read(typedOwners).matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
    assert.ok(!typedImports.some(target => target.includes('agent-settings-bridge')), 'typed owners must not import the agent domain');
});

test('the bridge entry wires the modules and stays the sole bridge-global owner', () => {
    const entry = read(bridgeEntry);
    const shared = read(bridgeShared);
    assert.ok(shared.includes("from './select-projection.js'"), 'shared module must own the select projection');
    assert.ok(entry.includes("from './settings/autosave.js'"), 'entry must import the autosave module');
    assert.ok(entry.includes("from './settings/canonical-rows.js'"), 'entry must import the canonical rows module');
    assert.match(shared, /createSelectProjection\(\{ ensurePresentationScope \}\)/, 'shared module must inject the presentation scope');
    // The presentation scope is module-private in bridge-shared; the entry may
    // only reach it via accessors. (A direct reference survived the domain
    // split once and only blew up in the WA journey's destroy() call.)
    assert.ok(!/\bpresentationScope\b/.test(entry), 'entry must use the shared scope accessors, never the module-private variable');
    assert.match(entry, /from '\.\/settings\/appearance-controls\.js'/, 'entry must import the appearance helper');
    assert.match(entry, /from '\.\/agent-settings-bridge\.js'/, 'entry must compose the Agent domain module');
    assert.match(entry, /from '\.\/typed-field-owners\.js'/, 'entry must compose the typed field owner module');
    const typed = read(typedOwners);
    for (const visibility of ['advanced-visibility.js', 'rust-visibility.js', 'render-visibility.js']) {
        assert.match(typed, new RegExp(`from '\\./settings/${visibility}'`), `typed owners must import the ${visibility} helper`);
    }
    const globalOwners = [...entry.matchAll(/window\.VCPUISettingsBridge\s*=/g)].length;
    assert.equal(globalOwners, 1, 'exactly one window.VCPUISettingsBridge assignment');
});

test('legacy Rust visibility listeners are fallback-only when typed consumer is active', () => {
    const source = read(eventListeners);
    const binder = source.slice(source.indexOf('async function setupRustAssistantConfigListeners'), source.indexOf('async function loadAndPopulateRustConfig'));
    assert.match(binder, /await loadAndPopulateRustConfig\(\);/);
    assert.match(binder, /if \(window\.VCPUISettingsBridge\?\.getRustAssistantService\?\.\(\)\) return;/,
        'legacy Rust binder must exit when the typed section owner is available');
});

test('typed Rust visibility listeners use the presentation scope', () => {
    const typed = read(typedOwners);
    const owner = typed.slice(typed.indexOf('const rustService = ensureRustAssistantUiService'), typed.indexOf('const forumService = ensureForumConfigUiService'));
    assert.match(owner, /rustScope\.listen\(form, type, onChange\)/);
    assert.doesNotMatch(owner, /rustScope\?\.own\(\(\) => form\.removeEventListener/);
});

test('legacy ColorPair binder is artifact-fallback-only', () => {
    const source = read(eventListeners);
    const bind = source.slice(source.indexOf('if (!modal.dataset.globalSettingsControlsBound)'), source.indexOf('const openGlobalSettings'));
    assert.match(bind, /if \(!window\.VCPUIUX\?\.mountColorPair\) setupColorSyncListeners\(\);/,
        'legacy color mirror listeners must not run beside generated ColorPair');
});

test('render visibility helper projects all custom typography rows', async () => {
    const { syncRenderSettingsVisibility } = await import(pathToFileURL(path.join(settingsDir, 'render-visibility.js')).href);
    const dom = new JSDOM(`<!doctype html><form>
        <select id="chatFontPreset"><option value="system">system</option><option value="custom">custom</option></select><div id="chatFontCustomRow"></div>
        <select id="chatCodeFontPreset"><option value="system">system</option><option value="custom">custom</option></select><div id="chatCodeFontCustomRow"></div>
        <select id="chatDiaryFontPreset"><option value="system">system</option><option value="custom">custom</option></select><div id="chatDiaryFontCustomRow"></div>
        <select id="chatToolFontPreset"><option value="system">system</option><option value="custom">custom</option></select><div id="chatToolFontCustomRow"></div>
    </form>`);
    const form = dom.window.document.querySelector('form');
    syncRenderSettingsVisibility(form);
    for (const id of ['chatFontCustomRow', 'chatCodeFontCustomRow', 'chatDiaryFontCustomRow', 'chatToolFontCustomRow']) {
        assert.equal(form.querySelector(`#${id}`).style.display, 'none');
    }
    form.querySelector('#chatCodeFontPreset').value = 'custom';
    form.querySelector('#chatToolFontPreset').value = 'custom';
    syncRenderSettingsVisibility(form);
    assert.equal(form.querySelector('#chatCodeFontCustomRow').style.display, 'block');
    assert.equal(form.querySelector('#chatToolFontCustomRow').style.display, 'block');
    assert.equal(form.querySelector('#chatFontCustomRow').style.display, 'none');
});

test('render preset listeners retract with the typed field owner', () => {
    const typed = read(typedOwners);
    const owner = typed.slice(typed.indexOf('function mountTypedFieldOwner'), typed.indexOf('function flushTypedForumFields'));
    assert.match(owner, /renderPresetIds = \['chatFontPreset', 'chatCodeFontPreset', 'chatDiaryFontPreset', 'chatToolFontPreset'\]/);
    assert.match(owner, /ownerScope\.listen\(select, 'change', onRenderPresetChange\)/);
    assert.doesNotMatch(owner, /select\.addEventListener\('change', onRenderPresetChange\)/);
});

test('typed Agent Inputs share one private owner while preserving canonical native controls', () => {
    const agent = read(agentBridge);
    const helper = agent.match(/function mountTypedAgentInput\(form, \{ id, marker, ownerKey, placeholder = false, restoreClass = false \}\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(helper, /api\.mountInput\(input, props, scope\)/, 'the helper must mount on the injected presentation owner');
    assert.match(helper, /delete input\.dataset\[marker\]/, 'scope teardown must remove each input marker');
    assert.match(helper, /restoreClass && input\.isConnected/, 'only configured fields restore their native class');

    const callers = agent.slice(
        agent.indexOf('function mountTypedAgentRegexInputs'),
        agent.indexOf('function mountTypedAgentStreamChoice'),
    );
    assert.doesNotMatch(callers, /api\.mountInput\(/, 'callers must not grow a second primitive owner');
    for (const marker of [
        'vcpTypedAgentIdentity', 'vcpTypedAgentModel', 'vcpTypedAgentTemperature',
        'vcpTypedAgentContextLimit', 'vcpTypedAgentMaxOutput', 'vcpTypedAgentTopP',
        'vcpTypedAgentTopK', 'vcpTypedPrimitiveMounted',
    ]) {
        assert.match(callers, new RegExp(marker), `typed Agent Input marker must remain configured: ${marker}`);
    }
});

test('global network-path add action uses the generated Button owner', () => {
    const entry = read(bridgeEntry);
    const shellCss = read(path.join(root, 'styles', 'ui-system', 'settings-shell.css'));
    const owner = entry.match(/function mountGlobalSettingsPathAction\(root\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(entry, /mountGlobalSettingsPathAction\(globalSettingsModal\);/,
        'global Settings refresh must adopt the network-path action');
    assert.match(owner, /#addNetworkPathBtn/);
    assert.match(owner, /api\.mountButton\(button, \{ variant: 'outline', size: 'sm' \}, scope\)/);
    assert.match(owner, /delete button\.dataset\.vcpTypedNetworkPathAction/);
    assert.match(shellCss, /#openTopicSummaryModelSelectBtn\)\:not\(\.vcp-harness-button\)/,
        'legacy Settings action CSS must exclude generated Buttons');
});

test('Agent section disclosures use one generated presentation owner and preserve manager-owned collapse state', () => {
    const agent = read(agentBridge);
    const disclosureModule = read(path.join(settingsDir, 'agent-disclosures.js'));
    assert.doesNotMatch(disclosureModule, /chatAPI|saveSettings|loadSettings/, 'Agent disclosure helper must not cross the business boundary');
    assert.match(disclosureModule, /manager\.toggleAgentSettingsSection\(key\)/, 'Agent disclosure helper must call the injected manager command');
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const owner = disclosureModule;
    assert.match(owner, /api\?\.mountDisclosureRowController/, 'Agent headers must use the generated Light-DOM DisclosureRow controller');
    assert.match(owner, /manager\.toggleAgentSettingsSection\(key\)/, 'presentation must call the manager command, not mutate DOM/config itself');
    assert.match(owner, /new window\.MutationObserver\(sync\)/, 'selection restore must project canonical collapsed DOM state into ARIA');
    assert.match(owner, /scope\.own\(state\.cleanup/, 'the observer and marker must retract with the presentation owner');
    for (const key of ['identity', 'prompt', 'model', 'params', 'tts', 'regex']) {
        assert.match(owner, new RegExp(`['\"]${key}['\"]`), `section ${key} must be owned by the migration slice`);
    }
    assert.match(manager, /toggleAgentSettingsSection:\s*\(key\)\s*=>\s*toggleAgentSettingsSection\(key\)/,
        'SettingsManager must expose one narrow canonical toggle command');
    const controller = manager.slice(
        manager.indexOf('function createSectionController(key, buildSummary)'),
        manager.indexOf('function buildIdentitySummary()', manager.indexOf('function createSectionController(key, buildSummary)')),
    );
    assert.doesNotMatch(controller, /header\.addEventListener\('click'/,
        'legacy manager header listeners must be retired once the typed owner owns activation');
    assert.match(owner, /const mounted = new Set\(\)/,
        'the typed owner must report exactly which canonical sections it adopted');
    assert.match(owner, /try \{[\s\S]*?api\.mountDisclosureRowController[\s\S]*?\} catch \(error\) \{/,
        'one failed generated adoption must leave the remaining form eligible for legacy fallback');
    assert.match(agent, /if \(!typedAgentSectionOwners\.has\(section\)\) enhance\('SettingsSection', section\)/,
        'a section without the generated artifact must retain the legacy fallback owner');
    assert.doesNotMatch(agent, /form\.querySelectorAll\('\.agent-settings-section, \.group-settings-section'\)/,
        'Agent sections must not be bulk-enhanced alongside a typed owner');
});

test('Agent TTS Range has one presentation output owner and no manager-side listener', () => {
    const agent = read(agentBridge);
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const rangeOwner = agent.match(/function mountTypedAgentTtsSpeedRange\(form\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const controlsCss = read(path.join(root, 'styles', 'setting', 'settings-form-controls.css'));
    assert.match(rangeOwner, /api\.mountRange\(input, \{ output, format: value => Number\.parseFloat\(value\)\.toFixed\(1\) \}, scope\)/,
        'generated Range must preserve the existing one-decimal TTS speed presentation');
    assert.doesNotMatch(manager, /function syncRangeProgress\(/,
        'the retired manager-only range progress projection must not remain after the typed Range owns presentation');
    assert.doesNotMatch(manager, /agentTtsSpeedSlider\.addEventListener\('input'/,
        'SettingsManager must not retain a second TTS output listener beside the generated Range');
    assert.doesNotMatch(manager, /ttsSpeedValueSpan/,
        'SettingsManager must not retain a display-node reference after the generated Range owns output projection');
    assert.doesNotMatch(controlsCss, /#agentTtsSpeed\s*\{/,
        'the typed Range wrapper, not an Agent-id selector, must own flexible row geometry');
});

test('Agent TTS Voice Select keeps business option loading while one typed projection owns presentation', () => {
    const agent = read(agentBridge);
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const selectProjection = read(path.join(settingsDir, 'select-projection.js'));
    const agentCss = read(path.join(root, 'styles', 'setting', 'agent', 'agent-card-controls.css'));
    const enhanceForm = agent.slice(agent.indexOf('function enhanceForm(form)'), agent.indexOf('function mountTypedAgentInput(form, {'));

    assert.match(enhanceForm, /selectProjection\.mount\(form\)/,
        'Agent TTS Voice Select must mount through the shared generated Select projection');
    assert.match(enhanceForm, /if \(!select\.closest\('\.vcp-harness-select'\)\) enhance\('Select'/,
        'legacy VCPUI Select enhancement must not mount inside a typed Select wrapper');
    assert.match(selectProjection, /select\.dataset\.vcpTypedPrimitiveMounted === 'true'/,
        'a native node already owned by the generated primitive must not receive a second projection');
    assert.match(selectProjection, /selectScope = scope\.child\(`select-projection:/,
        'each Select presentation owner must retract with its own child scope');
    assert.match(selectProjection, /new window\.MutationObserver\(/,
        'dynamic model option replacement must be observed by the one Select projection owner');
    assert.match(manager, /async function populateTtsModels\(currentPrimaryVoice, currentSecondaryVoice\)/,
        'TTS voice model discovery remains the canonical business loader');
    assert.match(manager, /commitOptions\(agentTtsVoicePrimarySelect, primaryOptions, currentPrimaryVoice\)/,
        'the primary native select remains the canonical option/value node');
    assert.match(manager, /commitOptions\(agentTtsVoiceSecondarySelect, secondaryOptions, currentSecondaryVoice\)/,
        'the secondary native select remains the canonical option/value node');
    assert.match(manager, /await electronAPI\.sovitsGetModels\(true\)/,
        'the refresh command remains on the native TTS model path');
    assert.doesNotMatch(manager, /agentTtsVoice(?:Primary|Secondary)Select\.addEventListener\(/,
        'SettingsManager must not register a competing TTS Select presentation listener');
    assert.ok(agentCss.includes('[id="agentSettingsContainer"] select:not(.vcp-harness-select-native)'), 'legacy Select CSS must exclude the typed native node');
    assert.ok(/body(?:\.light-theme|\[data-vcp-theme="light"\]) \[id="agentSettingsContainer"\] select:not\(\.vcp-harness-select-native\)/.test(agentCss), 'light Select CSS must exclude the typed native node');
    assert.ok(/body(?::not\(\.light-theme\)|\[data-vcp-theme="dark"\]) \[id="agentSettingsContainer"\] select:not\(\.vcp-harness-select-native\)/.test(agentCss), 'dark Select CSS must exclude the typed native node');
});

test('上游 MiMo 导演提示词保留 canonical 数组并由 SettingsManager 管理生命周期', () => {
    const html = read(path.join(root, 'main.html'));
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const tts = read(path.join(root, 'modules', 'SovitsTTS.js'));
    for (const id of [
        'agentTtsDirectorPromptInput',
        'addAgentTtsDirectorPromptBtn',
        'fillAgentTtsDirectorTemplateBtn',
        'agentTtsDirectorPromptsContainer',
    ]) {
        assert.match(html, new RegExp(`id="${id}"`), `MiMo director control ${id} must remain in the Agent form`);
    }
    assert.match(manager, /agentConfig\.ttsDirectorPrompts/, 'population must read the upstream persisted prompt array');
    assert.match(manager, /ttsDirectorPrompts: \[\.\.\.currentAgentTtsDirectorPrompts\]/, 'save paths must write the canonical prompt array');
    assert.match(manager, /TTS_DIRECTOR_TEMPLATE/, 'the upstream director template action must remain available');
    assert.match(manager, /clearTtsDirectorListeners\(\)/, 'static director listeners must retract on pagehide');
    assert.match(tts, /options\.directorPrompts/, 'the runtime consumer must continue receiving the saved prompt array');
});

test('Agent shell CSS leaves typed primitive inner controls to their own presentation owner', () => {
    const shellCss = read(path.join(root, 'styles', 'ui-system', 'settings-shell.css'));
    const legacyControlsCss = read(path.join(root, 'styles', 'setting', 'agent', 'agent-card-controls.css'));
    const paramsCss = read(path.join(root, 'styles', 'setting', 'settings-agent-params.css'));
    for (const selector of [
        '.vcp-uiux-input-wrap > input',
        '.vcp-uiux-color-pair > input',
        '.vcp-uiux-range > input',
        '.vcp-harness-select-native',
    ]) {
        assert.ok(shellCss.includes(selector), `legacy Agent shell selectors must exclude typed primitive internals: ${selector}`);
    }
    assert.match(shellCss, /Generated primitives own the inner native control's geometry and focus/,
        'the ownership boundary must remain explicit rather than relying on cascade order');
    assert.match(legacyControlsCss, /input\[type="text"\][\s\S]*?:not\(\.input\):not\(:is\(\.vcp-uiux-color-pair > input\)\)/,
        'the still-loaded Agent control fallback must exclude generated Input and ColorPair inner nodes');
    assert.match(legacyControlsCss, /select:not\(\.vcp-harness-select-native\)/,
        'the still-loaded Agent control fallback must not style a typed Select native node');
    assert.match(paramsCss, /\.params-content input\[type="number"\]:not\(\.input\)/,
        'the parameter-sheet numeric fallback must exclude generated Input nodes');
    assert.doesNotMatch(paramsCss, /\.params-content input\[type="number"\](?!:not\(\.input\))/,
        'the parameter sheet must not retain a competing numeric Input presentation owner');
});

test('Agent ColorPairs have one generated synchronization owner and preserve canonical color controls', () => {
    const agent = read(agentBridge);
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const owner = agent.match(/function mountTypedAgentColorPairs\(form\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(owner, /api\.mountColorPair\(color, text, scope, \{/, 'Agent ColorPairs must inject the generated presentation contract');
    assert.match(owner, /onValueChange: value =>/, 'avatar border preview must be an injected presentation reaction');
    assert.match(owner, /onInvalid: \(\) => window\.uiHelperFunctions\?\.showToastNotification/, 'invalid hex feedback must remain on the owned presentation path');
    assert.doesNotMatch(manager, /function setupColorPickerSync\(/,
        'SettingsManager must not retain duplicate color/text synchronization listeners');
    assert.doesNotMatch(manager, /function updateAvatarPreviewStyle\(/,
        'avatar border preview updates must not retain a manager-side presentation helper');
    assert.doesNotMatch(manager, /setupColorPickerSync\(\)/,
        'SettingsManager init must not remount the retired ColorPair listener bundle');
    for (const id of ['agentAvatarBorderColor', 'agentAvatarBorderColorText', 'agentNameTextColor', 'agentNameTextColorText']) {
        assert.match(manager, new RegExp(id), `canonical Agent color control ${id} must remain available to persistence/reset commands`);
    }
});

test('global voice and chat-layout radios adopt the generated Choice pill batch', () => {
    const entry = read(bridgeEntry);
    const css = read(path.join(root, 'styles', 'ui-system', 'settings-overrides.css'));
    assert.match(entry, /mountChoiceControls\(form, api\(\), scope\(\)\)/, 'global settings enhancement wires the Choice batch');
    const choiceOwner = read(path.join(settingsDir, 'choice-controls.js'));
    assert.match(choiceOwner, /#voiceModeLocal/, 'voice mode is the active high-frequency native radio consumer');
    assert.match(choiceOwner, /api\.mountChoice\(voice, scope\)/, 'the generated Choice mounts under the presentation owner');
    assert.match(choiceOwner, /#chatLayoutModeNormal/, 'the chat-layout radio group joins the Choice pill batch');
    assert.match(choiceOwner, /api\.mountChoice\(chatLayout, scope\)/, 'chat-layout mounts under the same presentation owner');
    assert.doesNotMatch(css, /#voiceModeLocal/, 'the retired page-local voice radio CSS no longer competes with Choice');
});

test('global typed primitive mounts keep one lifecycle registration per primitive', () => {
    const entry = read(bridgeEntry);
    const appearance = read(path.join(settingsDir, 'appearance-controls.js'));
    const ranges = read(path.join(settingsDir, 'appearance-ranges.js'));
    const toggles = read(path.join(settingsDir, 'appearance-toggles.js'));
    const home = read(path.join(settingsDir, 'home-controls.js'));
    const identity = read(path.join(settingsDir, 'identity-controls.js'));
    const choices = read(path.join(settingsDir, 'choice-controls.js'));
    const forum = read(path.join(settingsDir, 'forum-controls.js'));
    const globalTypedOwners = entry.slice(
        entry.indexOf('function mountHarnessInputs'),
        entry.indexOf('// R2-02C:'),
    ) + '\n' + appearance + '\n' + ranges + '\n' + toggles + '\n' + home + '\n' + identity + '\n' + choices + '\n' + forum;
    // Each generated primitive calls scope.own() internally.  The bridge can
    // own its DOM marker, but must not register the returned release again:
    // that adds a second resource to every Settings-open cycle and asks the
    // same idempotent disposer to run twice during teardown.
    assert.doesNotMatch(globalTypedOwners, /scope\.own\(\w*release[,) ]/i,
        'bridge must not duplicate generated primitive disposers in the presentation scope');
    for (const primitive of ['mountChoice', 'mountRange', 'mountToggle', 'mountColorPair', 'mountInput', 'mountSelect']) {
        assert.match(globalTypedOwners, new RegExp(`api\\.${primitive}\\(`),
            `${primitive} must remain mounted by the generated primitive`);
    }
});

test('settings shell navigation binds through the presentation scope', () => {
    const entry = read(bridgeEntry);
    const shell = entry.slice(entry.indexOf('function mountSettingsShell'), entry.indexOf('function cleanupDisconnectedControllers'));
    assert.match(shell, /shellScope\.listen\(row, 'click', onClick\)/);
    assert.match(shell, /shellScope\.listen\(row, 'keydown', onKeydown\)/);
});

test('typed settings external updates use the bridge scope', () => {
    const typed = read(typedOwners);
    const owner = typed.slice(typed.indexOf('function ensureTypedSettingsService'), typed.indexOf('function mountTypedSettingsConsumer'));
    assert.match(owner, /bridgeScope\.listen\(window, 'global-settings-updated'/);
    assert.match(owner, /else window\.addEventListener\('global-settings-updated'/);
});

test('legacy disclosure fast teardown is explicitly idempotent', () => {
    const entry = read(bridgeEntry);
    const helper = entry.slice(entry.indexOf('function mountHarnessDisclosures'), entry.indexOf('function flushSettingsAutosave'));
    assert.match(helper, /cleaned:\s*false/);
    assert.match(helper, /if \(state\.cleaned\) return;/);
    assert.match(helper, /state\.cleaned = true;/);
    assert.match(helper, /originalHeaderClass/);
    assert.match(helper, /header\.className = originalHeaderClass/);
    assert.match(helper, /originalContentId/);
});

test('Select option rebuild turns are owned and retract cleanly with the presentation scope', async () => {
    const dom = new JSDOM('<!doctype html><form><select id="voice"><option value="one">One</option><option value="two">Two</option></select></form>');
    const previous = Object.fromEntries([
        'window', 'document', 'Element', 'Node', 'Event', 'MutationObserver', 'Option', 'HTMLElement',
    ].map(key => [key, globalThis[key]]));
    const records = new Set();
    const createScope = () => {
        let active = true;
        const scope = {
            get active() { return active; },
            own(disposer) {
                let released = false;
                const release = () => {
                    if (released) return Promise.resolve();
                    released = true;
                    records.delete(release);
                    return Promise.resolve(disposer());
                };
                records.add(release);
                return release;
            },
            child() {
                const child = createScope();
                scope.own(() => child.dispose());
                return child;
            },
            async dispose() {
                if (!active) return;
                active = false;
                await Promise.all([...records].reverse().map(release => release()));
            },
        };
        return scope;
    };
    const scope = createScope();
    try {
        Object.assign(globalThis, {
            window: dom.window,
            document: dom.window.document,
            Element: dom.window.Element,
            Node: dom.window.Node,
            Event: dom.window.Event,
            MutationObserver: dom.window.MutationObserver,
            Option: dom.window.Option,
            HTMLElement: dom.window.HTMLElement,
        });
        let mounts = 0;
        dom.window.VCPUIUX = {
            mountSelect(select, _props, selectScope) {
                mounts += 1;
                const parent = select.parentNode;
                const wrap = dom.window.document.createElement('span');
                wrap.className = 'vcp-harness-select';
                parent.insertBefore(wrap, select);
                wrap.append(select);
                return selectScope.own(() => {
                    if (select.parentNode === wrap) parent.insertBefore(select, wrap);
                    wrap.remove();
                });
            },
        };
        const projectionModule = await import(`${pathToFileURL(path.join(settingsDir, 'select-projection.js')).href}?scope-owner=${Date.now()}`);
        const projection = projectionModule.createSelectProjection({ ensurePresentationScope: () => scope });
        const form = dom.window.document.querySelector('form');
        const select = dom.window.document.querySelector('select');
        projection.mount(form);
        assert.equal(mounts, 1, 'initial native select receives one projection');

        select.append(new dom.window.Option('Three', 'three'));
        // The observer -> owned timer -> child-scope dispose -> remount path
        // crosses several task turns.  Poll to a bounded deadline instead of
        // assuming a fixed delay, so a busy CI worker cannot report a false
        // negative while still preserving a real timeout failure.
        for (let attempt = 0; attempt < 50 && mounts < 2; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(mounts, 2, 'option-list change remounts exactly one projection');
        assert.equal(form.dataset.vcpSelectRebuilding, undefined, 'rebuild guard releases after the owned continuation');

        await scope.dispose();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(form.querySelectorAll('.vcp-harness-select').length, 0, 'scope disposal restores the canonical select DOM');
        assert.equal(records.size, 0, 'observer and deferred turns are retracted from the owner');
    } finally {
        Object.entries(previous).forEach(([key, value]) => {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        });
        dom.window.close();
    }
});

test('设置桥挂载流水线：拓扑解析确定性、未知依赖与环都显式失败', async () => {
    const pipeline = await import(pathToFileURL(path.join(settingsDir, 'pipeline.js')).href);
    assert.deepEqual(Object.keys(pipeline).sort(), ['resolvePipelineOrder', 'runSettingsPipeline']);

    const steps = [
        { name: 'a', before: ['c'], run: () => {} },
        { name: 'b', run: () => {} },
        { name: 'c', before: ['d'], run: () => {} },
        { name: 'd', run: () => {} },
    ];
    assert.deepEqual(pipeline.resolvePipelineOrder(steps), ['a', 'b', 'c', 'd'],
        'a graph without cross edges reproduces the declaration order');

    // Repeated resolution is deterministic, and reordering independent steps
    // is the only way to change the outcome.
    assert.deepEqual(pipeline.resolvePipelineOrder([...steps].reverse()), ['b', 'a', 'c', 'd']);

    assert.throws(() => pipeline.resolvePipelineOrder([{ name: 'x', before: ['ghost'], run: () => {} }]),
        /unknown follower "ghost"/, 'an edge to a nonexistent step must fail loudly');
    assert.throws(() => pipeline.resolvePipelineOrder([
        { name: 'x', before: ['y'], run: () => {} },
        { name: 'y', before: ['x'], run: () => {} },
    ]), /dependency cycle among: x, y/, 'a dependency cycle must fail loudly');

    const executed = [];
    pipeline.runSettingsPipeline([
        { name: 'first', before: ['second'], run: () => executed.push('first') },
        { name: 'second', run: () => executed.push('second') },
    ], { onStep: name => executed.push(`step:${name}`) });
    assert.deepEqual(executed, ['first', 'step:first', 'second', 'step:second'],
        'steps run in dependency order with an onStep observation hook');
});

test('enhanceGlobalSettings 声明挂载步骤并保留关键顺序约束', () => {
    const entry = read(bridgeEntry);
    const fn = entry.slice(entry.indexOf('function enhanceGlobalSettings(root, form)'), entry.indexOf('runSettingsPipeline(steps);'));
    assert.match(entry, /import \{ runSettingsPipeline \} from '\.\/settings\/pipeline\.js';/,
        'the entry executes the shared declarative pipeline runner');
    for (const name of ['canonical-rows', 'harness-inputs', 'appearance-rows',
        'global-pill-steppers', 'select-projection', 'global-typed-primitives', 'topic-summary-picker',
        'forum-field-owner', 'legacy-range-pass', 'harness-switches', 'harness-disclosures',
        'agent-name-fields', 'settings-shell', 'save-coordinator', 'autosave', 'typed-field-owner', 'form-icons']) {
        assert.match(fn, new RegExp(`name: '${name}'`), `mount step ${name} must stay declared`);
    }
    // The two documented ordering hazards stay explicit edges, not comments.
    assert.match(fn, /name: 'global-pill-steppers',\s*\n(?:.*\n)*?\s*before: \['select-projection', 'legacy-range-pass'\]/,
        'pill/stepper projections must declare precedence over the select projection and the legacy Range pass');
    assert.match(fn, /name: 'appearance-rows',\s*\n(?:.*\n)*?\s*before: \['select-projection'\]/,
        'appearance projections must declare precedence over the catch-all select projection');
    assert.match(fn, /name: 'canonical-rows',\s*\n(?:.*\n)*?\s*before: \['harness-inputs'/,
        'row-consuming passes must declare their dependence on canonical rows');
});

test('保存协调器：唯一提交入口与显式订阅替代 owner 字符串过滤（阶段 4）', async () => {
    const coordinatorSource = read(path.join(settingsDir, 'save-coordinator.js'));
    assert.ok(!/from\s+['"](?:schemastery|cordis)/i.test(coordinatorSource), 'the coordinator stays dependency-free');
    // owner 字符串过滤退场：legacy 客户端不再硬编码 typed owner 的 id。
    const autosaveSource = read(path.join(settingsDir, 'autosave.js'));
    for (const owner of ["'typed-settings-field-owner'", "'typed-forum-field-owner'"]) {
        assert.ok(!autosaveSource.includes(owner), `autosave must not filter by owner string ${owner}`);
    }
    assert.match(autosaveSource, /from '\.\/save-coordinator\.js'/, 'autosave registers with the coordinator');
    // typed owners 注册为协调器客户端，各自 flush 自己的注册表。
    const typed = read(typedOwners);
    assert.match(typed, /registerClient\(\{ id: 'typed-settings-field-owner', flush: flushTypedSettingsFields \}\)/);
    assert.match(typed, /registerClient\(\{ id: 'typed-forum-field-owner', flush: flushTypedForumFields \}\)/);
    // 桥入口：协调器先于 autosave 步挂载；flush/teardown 走协调器。
    const entry = read(bridgeEntry);
    assert.match(entry, /import \{ claimSaveCoordinator, getSaveCoordinator \} from '\.\/settings\/save-coordinator\.js';/);
    const coordinatorIdx = entry.indexOf("name: 'save-coordinator'");
    const autosaveIdx = entry.indexOf("name: 'autosave'");
    assert.ok(coordinatorIdx > -1 && coordinatorIdx < autosaveIdx, 'the coordinator step must mount before the autosave step');
    // Every save client mounts after the coordinator — the forum owner runs
    // earlier in the list than autosave, so pin it against the first of them.
    for (const client of ['forum-field-owner', 'autosave', 'typed-field-owner']) {
        const clientIdx = entry.indexOf(`name: '${client}'`);
        assert.ok(coordinatorIdx < clientIdx, `the coordinator step must mount before the ${client} step`);
    }
    assert.match(entry, /getSaveCoordinator\(document\.getElementById\('globalSettingsForm'\)\);\s*\n\s*if \(coordinator\) \{\s*\n\s*coordinator\.flush\(\);/,
        'the close-time flush prefers the coordinator entry');
    assert.match(entry, /teardownLegacyAutosave\(\);\s*\n\s*teardownTypedOwners\(\);\s*\n\s*getSaveCoordinator\(document\.getElementById\('globalSettingsForm'\)\)\?\.dispose\(\);/,
        'teardown disposes the coordinator');

    // 行为面：按 owner 路由结果，默认客户端收未标注结果；vcpAutosaveState
    // 契约经由协调器单点写入，值不变。
    const { claimSaveCoordinator } = await import(pathToFileURL(path.join(settingsDir, 'save-coordinator.js')).href);
    const dom = new JSDOM('<form id="f"></form>');
    const form = dom.window.document.getElementById('f');
    const received = { legacy: [], typed: [] };
    const coordinator = claimSaveCoordinator(form);
    coordinator.registerClient({ id: 'legacy-autosave', isDefault: true, onResult: detail => received.legacy.push(detail) });
    coordinator.registerClient({ id: 'typed-settings-field-owner', onResult: detail => received.typed.push(detail) });
    const dispatch = detail => form.dispatchEvent(new dom.window.CustomEvent('vcp-settings-save-result', { detail }));
    dispatch({ success: true });
    dispatch({ success: false, owner: 'typed-settings-field-owner' });
    dispatch({ success: true, owner: 'typed-forum-field-owner' });
    assert.deepEqual(received.legacy.map(detail => detail.owner || 'unowned'), ['unowned'],
        'only untagged results reach the default client');
    assert.deepEqual(received.typed, [{ success: false, owner: 'typed-settings-field-owner' }],
        'a registered owner receives its own results only');
    coordinator.reportState('saving');
    assert.equal(form.dataset.vcpAutosaveState, 'saving');
    coordinator.reportState('');
    assert.equal(form.dataset.vcpAutosaveState, undefined);
    coordinator.dispose();
    dispatch({ success: true });
    assert.equal(received.legacy.length, 1, 'dispose removes the coordinator listener');
});

test('settings 域的 dataset marker 全部登记在统一注册表中', async () => {
    const registry = await import(pathToFileURL(path.join(settingsDir, 'marker-registry.js')).href);
    assert.equal(typeof registry.isRegisteredSettingsMarker, 'function');
    assert.equal(typeof registry.settingsMarkerCleanup, 'function');
    for (const [name, meta] of Object.entries(registry.SETTINGS_MARKERS)) {
        assert.ok(meta.owner && meta.cleanup, `marker ${name} must declare owner and cleanup`);
        assert.ok(['scope-owned', 'manual-retract', 'persistent', 'business-contract'].includes(meta.cleanup),
            `marker ${name} cleanup must use a documented value, got: ${meta.cleanup}`);
    }
    // Business/control attributes are not idempotency markers and stay out.
    for (const name of ['vcpTypedPrimitiveMounted', 'vcpTypedGlobalSettingsEntry', 'vcpTypedNetworkPathAction',
        'vcpSettingsRow', 'vcpCanonicalRowsMounted', 'vcpSelectRebuilding',
        'vcpHarnessToggleMounted', 'vcpAutosaveState', 'vcpSettingsDirty', 'vcpTypedAgentModel']) {
        assert.ok(registry.isRegisteredSettingsMarker(name), `known marker ${name} must be registered`);
    }
    assert.equal(registry.isRegisteredSettingsMarker('vcpTotallyUnknownMarker'), false);

    // Audit: every dataset marker literal used by the bridge domain must be
    // registered, so new markers cannot accumulate as untracked conventions.
    const domainFiles = [bridgeEntry, agentBridge, typedOwners,
        ...fs.readdirSync(settingsDir).filter(name => name.endsWith('.js'))
            .map(name => path.join(settingsDir, name))];
    const exempt = new Set(['style', 'state', 'selected', 'section', 'settingKey', 'sectionKey']);
    const unregistered = new Set();
    for (const file of domainFiles) {
        const source = read(file);
        for (const match of source.matchAll(/dataset\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
            const name = match[1];
            if (!exempt.has(name) && !registry.isRegisteredSettingsMarker(name)) unregistered.add(name);
        }
    }
    assert.deepEqual([...unregistered], [],
        'every dataset marker in the settings domain must declare owner + cleanup in marker-registry.js');
});

test('data-visible-when 投影：复选/取值/未知来源放行/隐藏还原', async () => {
    const module = await import(pathToFileURL(path.join(settingsDir, 'dependent-rows.js')).href);
    assert.deepEqual(Object.keys(module).sort(), ['evaluateVisibleWhen', 'syncDependentRows']);
    const dom = new JSDOM(`<!doctype html><form>
        <input type="checkbox" id="enableMiddleClickQuickAction" checked>
        <select id="middleClickQuickAction"><option value="edit">edit</option><option value="regenerate">regenerate</option></select>
        <input type="checkbox" id="enableMiddleClickAdvanced">
        <div class="row" id="rowA" data-visible-when="enableMiddleClickQuickAction"></div>
        <div class="row" id="rowB" data-visible-when="enableMiddleClickQuickAction && middleClickQuickAction=regenerate"></div>
        <div class="row" id="rowC" data-visible-when="renamedControl"></div>
        <div class="row" id="rowD"></div>
    </form>`);
    const form = dom.window.document.querySelector('form');
    module.syncDependentRows(form);
    const display = id => form.querySelector(`#${id}`).style.display;
    assert.equal(display('rowA'), '', 'checked source keeps the row CSS-driven');
    assert.equal(display('rowB'), 'none', 'value clause gates the row');
    assert.equal(display('rowC'), '', 'unknown sources fail open');
    assert.equal(display('rowD'), '', 'rows without the attribute are untouched');
    form.querySelector('#middleClickQuickAction').value = 'regenerate';
    form.querySelector('#enableMiddleClickQuickAction').checked = false;
    module.syncDependentRows(form);
    assert.equal(display('rowA'), 'none');
    assert.equal(display('rowB'), 'none', 'an && chain needs every clause');
    assert.equal(module.evaluateVisibleWhen(form, ''), true, 'empty expression is always visible');
});

test('quick-actions 扁平化：依赖容器退场，条件行直接挂在分区下', () => {
    const html = read(path.join(root, 'main.html'));
    assert.doesNotMatch(html, /id="middleClickAdvancedContainer"/,
        'the advanced guard container must retire with the flattened rows');
    for (const id of ['middleClickQuickActionContainer', 'regenerateConfirmationContainer', 'middleClickAdvancedToggleRow', 'middleClickAdvancedSettings']) {
        assert.match(html, new RegExp(`id="${id}"`), `flattened row ${id} must remain in the section`);
    }
    // Conditional rows declare their composition instead of nesting wrappers.
    assert.match(html, /id="regenerateConfirmationContainer"[^>]*data-visible-when="enableMiddleClickQuickAction && middleClickQuickAction=regenerate"/s);
    assert.match(html, /id="middleClickAdvancedSettings"[^>]*data-visible-when="enableMiddleClickQuickAction && enableMiddleClickAdvanced"/s);
    // The flattened sections own the top-border divider model in CSS.
    const overrides = read(path.join(root, 'styles', 'ui-system', 'settings-overrides.css'));
    assert.match(overrides, /\.vcp-ui-scope#globalSettingsModal \.vcp-harness-general-row \+ \.vcp-harness-general-row \{\s*\n\s*border-top: 1px solid/,
        'the unified settings surface draws its hairlines from the adjacent-sibling top border');
    assert.ok(!overrides.includes('vcp-harness-row-tail'),
        'the JS tail marker CSS is retired with the globalized top-border model');
    // Nested row primitives self-inject a bottom hairline; inside a canonical
    // row it must yield to the row boundary (two-column stepper rows leak
    // partial double hairlines otherwise).
    assert.match(overrides, /\.vcp-harness-general-row :is\(\.vcp-harness-language-row, \.vcp-harness-numeric-stepper-row, \.vcp-harness-font-size-row\) \{\s*\n\s*border-bottom: 0;/,
        'nested row primitives opt out of their self-drawn hairline inside canonical rows');
});

test('advanced-features 扁平化：净化深度行改为条件行属性', () => {
    const html = read(path.join(root, 'main.html'));
    assert.match(html, /id="contextSanitizerDepthContainer"[^>]*data-visible-when="enableContextSanitizer"/s,
        'the sanitizer depth row must own its visibility via data-visible-when');
    // The section projection keeps the export but delegates to the shared
    // evaluator; no hardcoded per-row display writes survive the flatten.
    const helper = read(path.join(root, 'modules', 'ui-system', 'settings', 'advanced-visibility.js'));
    assert.ok(!helper.includes('contextSanitizerDepthContainer'),
        'the advanced projection must not hand-write retired conditional rows');
    assert.match(helper, /syncDependentRows\(form\)/);
    const audit = read(path.join(root, 'scripts', 'audit-settings-layout.mjs'));
    assert.match(audit, /FLAT_SECTIONS = new Set\(\['quick-actions', 'advanced-features', 'render-settings', 'server-connection', 'voice-settings', 'selection-assistant', 'user-identity', 'appearance-settings'\]\)/,
        'the layout probe must enforce the flattened sections');
});

test('user-identity 扁平化：identity 容器退场，头像合成与折叠样式区成为 canonical 行', () => {
    const html = read(path.join(root, 'main.html'));
    const sectionStart = html.indexOf('id="section-user-identity"');
    const sectionEnd = html.indexOf('id="section-server-connection"');
    assert.ok(sectionStart > 0 && sectionEnd > sectionStart, 'user-identity section bounds');
    const section = html.slice(sectionStart, sectionEnd);
    assert.ok(!section.includes('agent-identity-container'),
        'the identity wrapper must retire; avatar+name composition joins the row system');
    assert.match(section, /class="agent-identity-main" data-vcp-settings-row>/,
        'the avatar+name composite becomes one canonical row');
    assert.match(section, /class="agent-style-collapsible-container collapsed" data-vcp-settings-row>/,
        'the style disclosure keeps its collapse semantics as a canonical row');
    for (const kept of ['userAvatarPreview', 'userName', 'userStyleCollapseHeader', 'userAvatarBorderColor', 'adminUsername']) {
        assert.ok(section.includes(`id="${kept}"`), `identity control ${kept} must remain`);
    }
});

test('appearance-settings 扁平化：四个 editor-section 与依赖面板退场，呈现模式成为行属性', () => {
    const html = read(path.join(root, 'main.html'));
    const sectionStart = html.indexOf('id="section-appearance-settings"');
    const sectionEnd = html.indexOf('<!-- 消息渲染 -->');
    assert.ok(sectionStart > 0 && sectionEnd > sectionStart, 'appearance section bounds');
    const section = html.slice(sectionStart, sectionEnd);
    // 包裹结构整体退场：editor-section、依赖面板、网格与几何容器不再承载行。
    for (const retired of ['vcp-harness-editor-section', 'userChatBubbleSettings', 'chatBubbleWidthSettings',
        'wideChatLayoutSettings', 'appearance-settings-grid', 'appearance-sidebar-geometry-controls',
        'appearance-home-tagline-setting', 'settings-dependent-panel', 'settings-nested-panel']) {
        assert.ok(!section.includes(retired), `${retired} must retire with the flattened appearance section`);
    }
    // 视觉行与条件行：workbench 卡片之后到分区结束全部是 canonical 行。
    for (const promoted of ['appearanceDensityRow', 'appearanceRadiusRow', 'appearanceTypographyRow',
        'appearanceFontScaleRow', 'appearanceContentWidthRow', 'appearanceSurfaceRow',
        'appearanceSidebarRadiusLanguageRow']) {
        assert.match(section, new RegExp(`id="${promoted}" data-vcp-settings-row>`),
            `${promoted} joins the canonical row system`);
    }
    assert.ok((section.match(/data-vcp-settings-row/g) || []).length >= 9,
        'home visual rows, language hosts and geometry rows all become canonical rows');
    // 呈现模式的守卫面板变成行属性；radio 源用裸 id（checked 语义）组合。
    assert.match(section, /data-visible-when="chatPresentationModeBubble"/);
    assert.match(section, /data-visible-when="chatPresentationModeBubble && enableUserChatBubbleUi"/);
    assert.match(section, /data-visible-when="chatPresentationModeBubble && chatLayoutModeWide"/);
    // 事件路径与快照路径都改走共享行评估器，不允许残留直写。
    const presentation = read(path.join(root, 'modules', 'renderer', 'mainChatSettingsPresentationOwner.js'));
    for (const retired of ['userChatBubbleSettings', 'chatBubbleWidthSettings']) {
        assert.ok(!presentation.includes(retired), `presentation owner must not reference ${retired}`);
    }
    assert.match(presentation, /import \{ syncDependentRows \} from '\.\.\/ui-system\/settings\/dependent-rows\.js';/);
    const typed = read(path.join(root, 'modules', 'ui-system', 'typed-field-owners.js'));
    assert.ok(!typed.includes('chatBubbleWidthSettings'), 'typed snapshot path must not write the retired panel');
    // canonical 行投影：appearance 分区整体是 feature-owned 行区。
    const canonical = read(path.join(root, 'modules', 'ui-system', 'settings', 'canonical-rows.js'));
    assert.match(canonical, /appearance-home-tagline-setting, \[data-settings-section-key="appearance-settings"\]'/,
        'appearanceOwner covers the stamped appearance section');
});

test('selection-assistant 扁平化：rust guard 容器退场，条件行组合声明', () => {
    const html = read(path.join(root, 'main.html'));
    const sectionStart = html.indexOf('id="section-selection-assistant"');
    const sectionEnd = html.indexOf('id="section-voice-settings"');
    assert.ok(sectionStart > 0 && sectionEnd > sectionStart, 'selection-assistant section bounds');
    const section = html.slice(sectionStart, sectionEnd);
    // Guard/panel wrappers retire; the diagnostics panel becomes an inline
    // expansion of the debug toggle row.
    for (const retired of ['rustAssistantConfigContainer', 'rustGuardRulesContainer', 'rustCustomThresholdsPanel', 'rustWhitelistPanel', 'rustBlacklistPanel', 'rustScreenshotAppsPanel']) {
        assert.ok(!section.includes(`id="${retired}"`), `guard container ${retired} must retire`);
    }
    for (const kept of ['rustDebugPanel', 'rustRuleModeRow', 'rustEnableCustomThresholds']) {
        assert.ok(section.includes(`id="${kept}"`), `flattened row ${kept} must remain`);
    }
    // Composed conditions replace the nested wrappers.
    assert.match(section, /id="rustDebugPanel"[^>]*data-visible-when="rustDebugMode"/s);
    assert.match(section, /data-vcp-style="23" data-visible-when="rustUseAssistant"/);
    assert.match(section, /data-visible-when="rustUseAssistant && rustEnableCustomThresholds"/);
    assert.match(section, /data-visible-when="rustUseAssistant && rustRuleMode=whitelist"/);
    assert.match(section, /data-visible-when="rustUseAssistant && rustRuleMode=blacklist"/);
    // The section projection delegates to the shared evaluator.
    const helper = read(path.join(root, 'modules', 'ui-system', 'settings', 'rust-visibility.js'));
    assert.ok(!helper.includes('rustGuardRulesContainer'),
        'the rust projection must not hand-write retired guard containers');
    assert.match(helper, /syncDependentRows\(form\)/);
    // The fallback binder re-evaluates the same clauses for degraded mode.
    const legacy = read(eventListeners);
    assert.match(legacy, /syncDependentRows/);
});

test('render-settings 扁平化：editor-section 包裹退场，行直接挂在分区下', () => {
    const html = read(path.join(root, 'main.html'));
    // The render section no longer ships the wrapper markup (its heading was
    // already runtime-removed as a duplicate of the section title).
    const sectionStart = html.indexOf('id="section-render-settings"');
    const sectionEnd = html.indexOf('id="section-selection-assistant"');
    assert.ok(sectionStart > 0 && sectionEnd > sectionStart, 'render-settings section bounds');
    const section = html.slice(sectionStart, sectionEnd);
    assert.ok(!section.includes('vcp-harness-editor-section'), 'the editor-section wrapper must retire');
    for (const id of ['minChunkBufferSize', 'streamAnimationSettingsRow', 'streamAnimationDurationRow', 'streamAnimationCustomRow']) {
        assert.ok(section.includes(`id="${id}"`), `flattened render row ${id} must remain`);
    }
    // The inline number row joins the canonical row system so the section is
    // one contiguous canonical row run (adjacency + divider probes).
    assert.match(section, /class="form-group settings-inline-number-row"/);
});
