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

    // M5-c pass6：canonical-rows 投影 pass 退役（全分区直出后空转），
    // 模块文件删除；保留删除守卫防止回潮。
    assert.equal(fs.existsSync(path.join(settingsDir, 'canonical-rows.js')), false,
        'canonical-rows pass module must stay retired');

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

    // M5-d：advanced/rust 两个可见性薄包装退役（渲染器已声明 data-visible-when，
    // 事件路径直调 dependent-rows 的统一求值器），保留删除守卫防止回潮。
    assert.equal(fs.existsSync(path.join(settingsDir, 'advanced-visibility.js')), false,
        'the retired advanced-visibility wrapper must stay deleted');
    assert.equal(fs.existsSync(path.join(settingsDir, 'rust-visibility.js')), false,
        'the retired rust-visibility wrapper must stay deleted');
    const render = await import(pathToFileURL(path.join(settingsDir, 'render-visibility.js')).href);
    assert.equal(typeof render.syncRenderSettingsVisibility, 'function');
    const languageRows = await import(pathToFileURL(path.join(settingsDir, 'global-language-rows.js')).href);
    assert.equal(typeof languageRows.mountGlobalLanguageRows, 'function');
    const ranges = await import(pathToFileURL(path.join(settingsDir, 'appearance-ranges.js')).href);
    assert.equal(typeof ranges.mountAppearanceRanges, 'function');
    const toggles = await import(pathToFileURL(path.join(settingsDir, 'appearance-toggles.js')).href);
    assert.equal(typeof toggles.mountAppearanceToggles, 'function');
    const home = await import(pathToFileURL(path.join(settingsDir, 'home-controls.js')).href);
    assert.equal(typeof home.mountHomeTaglineInput, 'function');
    const identity = await import(pathToFileURL(path.join(settingsDir, 'identity-controls.js')).href);
    assert.equal(typeof identity.mountIdentityColorPairs, 'function');
    const choicePrimitive = await import(pathToFileURL(path.join(root, 'modules', 'uiux', 'generated', 'primitives', 'choice.js')).href);
    assert.equal(typeof choicePrimitive.mountChoice, 'function');
    assert.equal(typeof choicePrimitive.activateChoice, 'function');
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
        'enhance', 'uniqueSettingsKey', 'selectProjection', 'mountUiuxSwitches',
        'releaseDisconnectedControllers', 'releaseAllControllers',
    ]) {
        assert.ok(name in shared, `bridge-shared must export ${name}`);
    }
    assert.equal(typeof shared.ensurePresentationScope, 'function');
    assert.equal(typeof shared.mountUiuxSwitches, 'function', 'agent 设置面仍经共享挂载方收编开关');
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
        'mountSelectKeyboardGlue', 'mountUiuxSelects', 'teardownUiuxSelects',
        // M5-c pass6：mountCanonicalSettingsRows 随 canonical-rows 步退役；
        // composeCanonicalRowSlots 唯一载体是渲染侧机械层。
        'composeCanonicalRowSlots',
        'mountSettingsAutosave', 'flushLegacyAutosave', 'teardownLegacyAutosave',
        // 2026-08-31 domain split homes.
        'enhanceForm', 'mountTypedModelPicker', 'mountTypedSettingsConsumer', 'mountTypedFieldOwner',
        'mountTypedForumFieldOwner', 'addTypedNetworkPathInput', 'ensureTypedSettingsService',
        'mountUiuxSwitches', 'mountUiuxDisclosures',
        'enhance', 'uniqueSettingsKey', 'mountSettingsShell', 'flushTypedOwners',
    ];
    const moduleSource = [
        ...fs.readdirSync(settingsDir).filter(name => name.endsWith('.js')).map(name => read(path.join(settingsDir, name))),
        // M5-b：canonical 行机械层移居渲染侧，composeCanonicalRowSlots 的唯一
        // 载体随清单一并扫描。
        read(path.join(root, 'modules', 'settings', 'render', 'canonical-row.js')),
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
    assert.ok(!entry.includes("from './settings/canonical-rows.js'"), 'the retired canonical-rows module must not be imported');
    assert.match(shared, /createSelectProjection\(\{ ensurePresentationScope \}\)/, 'shared module must inject the presentation scope');
    // The presentation scope is module-private in bridge-shared; the entry may
    // only reach it via accessors. (A direct reference survived the domain
    // split once and only blew up in the WA journey's destroy() call.)
    assert.ok(!/\bpresentationScope\b/.test(entry), 'entry must use the shared scope accessors, never the module-private variable');
    assert.match(entry, /from '\.\/settings\/global-language-rows\.js'/, 'entry must import the language-row activation module');
    assert.match(entry, /from '\.\/agent-settings-bridge\.js'/, 'entry must compose the Agent domain module');
    assert.match(entry, /from '\.\/typed-field-owners\.js'/, 'entry must compose the typed field owner module');
    const typed = read(typedOwners);
    // M5-d：薄包装退役后，typed owners 只 import render-visibility（旧式 id 表）
    // 与 dependent-rows（统一可见性求值器），不再有 advanced/rust 包装导入。
    for (const visibility of ['render-visibility.js', 'dependent-rows.js']) {
        assert.match(typed, new RegExp(`from '\\./settings/${visibility}'`), `typed owners must import the ${visibility} helper`);
    }
    assert.ok(!typed.includes('advanced-visibility'), 'typed owners must call the unified evaluator directly');
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
    assert.match(shellCss, /#openTopicSummaryModelSelectBtn\)\:not\(\.vcp-uiux-button\)/,
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
    assert.match(enhanceForm, /if \(!select\.closest\('\.vcp-uiux-select'\)\) enhance\('Select'/,
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
    assert.ok(agentCss.includes('[id="agentSettingsContainer"] select:not(.vcp-uiux-select-native)'), 'legacy Select CSS must exclude the typed native node');
    assert.ok(/body(?:\.light-theme|\[data-vcp-theme="light"\]) \[id="agentSettingsContainer"\] select:not\(\.vcp-uiux-select-native\)/.test(agentCss), 'light Select CSS must exclude the typed native node');
    assert.ok(/body(?::not\(\.light-theme\)|\[data-vcp-theme="dark"\]) \[id="agentSettingsContainer"\] select:not\(\.vcp-uiux-select-native\)/.test(agentCss), 'dark Select CSS must exclude the typed native node');
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
        '.vcp-uiux-select-native',
    ]) {
        assert.ok(shellCss.includes(selector), `legacy Agent shell selectors must exclude typed primitive internals: ${selector}`);
    }
    assert.match(shellCss, /Generated primitives own the inner native control's geometry and focus/,
        'the ownership boundary must remain explicit rather than relying on cascade order');
    assert.match(legacyControlsCss, /input\[type="text"\][\s\S]*?:not\(\.input\):not\(:is\(\.vcp-uiux-color-pair > input\)\)/,
        'the still-loaded Agent control fallback must exclude generated Input and ColorPair inner nodes');
    assert.match(legacyControlsCss, /select:not\(\.vcp-uiux-select-native\)/,
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
    const css = read(path.join(root, 'styles', 'ui-system', 'settings-template.css'));
    const renderer = read(path.join(root, 'modules', 'settings', 'render', 'field-renderer.js'));
    const upgrades = read(path.join(settingsDir, 'global-input-upgrades.js'));
    // M5-c pass5：分段结构由渲染器直出，运行期只剩 activateChoice 行为绑定。
    assert.match(renderer, /innerRow\.classList\.add\('vcp-uiux-choice'\)/,
        'the renderer emits the Choice row class statically');
    assert.match(renderer, /'vcp-uiux-choice-option'/,
        'the renderer emits the Choice option classes statically');
    assert.match(renderer, /dataset\.value = checkedRadio\.value/,
        'the renderer seeds dataset.value from the compiled checked radio');
    assert.match(entry, /mountGlobalChoices\(form, api\(\), scope\(\)\)/,
        'global settings enhancement wires the Choice activation scan');
    assert.match(upgrades, /api\.activateChoice\(row, scope\)/,
        'the scan activates behavior on renderer-emitted choice rows');
    assert.doesNotMatch(entry, /mountChoiceControls/,
        'the retired id-table choice mount must stay retired');
    assert.ok(!fs.existsSync(path.join(settingsDir, 'choice-controls.js')),
        'choice-controls.js stays deleted');
    assert.doesNotMatch(css, /#voiceModeLocal/, 'the retired page-local voice radio CSS no longer competes with Choice');
});

test('global typed primitive mounts keep one lifecycle registration per primitive', () => {
    const entry = read(bridgeEntry);
    const languageRowsModule = read(path.join(settingsDir, 'global-language-rows.js'));
    const ranges = read(path.join(settingsDir, 'appearance-ranges.js'));
    const toggles = read(path.join(settingsDir, 'appearance-toggles.js'));
    const home = read(path.join(settingsDir, 'home-controls.js'));
    const identity = read(path.join(settingsDir, 'identity-controls.js'));
    const forum = read(path.join(settingsDir, 'forum-controls.js'));
    const globalTypedOwners = languageRowsModule + '\n' + ranges + '\n' + toggles + '\n' + home + '\n' + identity + '\n' + forum + '\n' + read(path.join(settingsDir, 'global-input-upgrades.js'));
    // Each generated primitive calls scope.own() internally.  The bridge can
    // own its DOM marker, but must not register the returned release again:
    // that adds a second resource to every Settings-open cycle and asks the
    // same idempotent disposer to run twice during teardown.
    assert.doesNotMatch(globalTypedOwners, /scope\.own\(\w*release[,) ]/i,
        'bridge must not duplicate generated primitive disposers in the presentation scope');
    // M5-c pass5：schema 面的分段行结构由渲染器直出，运行期只剩行为激活
    // （mountChoice 语义保留给 agent 设置面，不在本扫描清单内）。
    for (const primitive of ['activateChoice', 'mountRange', 'mountToggle', 'mountColorPair', 'mountInput', 'activateLanguageRow', 'activateFontSizeRow']) {
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
    const helper = entry.slice(entry.indexOf('function mountUiuxDisclosures'), entry.indexOf('function flushSettingsAutosave'));
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
                wrap.className = 'vcp-uiux-select';
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
        assert.equal(form.querySelectorAll('.vcp-uiux-select').length, 0, 'scope disposal restores the canonical select DOM');
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
    for (const name of [
        'global-pill-steppers', 'global-typed-primitives', 'topic-summary-picker',
        'forum-field-owner', 'uiux-disclosures',
        'agent-name-fields', 'settings-shell', 'save-coordinator', 'autosave', 'typed-field-owner']) {
        assert.match(fn, new RegExp(`name: '${name}'`), `mount step ${name} must stay declared`);
    }
    // M5-c pass2：legacy-range-pass 退役——全局设置面仅有的四条 range 全部
    // 被步进器/外观原语收编，Range enhance 扫描无可增强对象，pass 随 pass2 删除。
    assert.doesNotMatch(fn, /name: 'legacy-range-pass'/,
        'the vacuous legacy Range pass must stay retired');
    // M5-c pass3：uiux-inputs 退役——单行输入的 Input 原语包裹由渲染器直出
    // （render/field-renderer.js buildInputPrimitiveWrap），包裹扫描无可包裹
    // 对象，pass 随 pass3 删除；raw 投影字段仍由 typed owners 运行时收编。
    assert.doesNotMatch(fn, /name: 'uiux-inputs'/,
        'the retired generic Input pass must stay retired');
    // M5-c pass4：appearance-rows 退役——语言行/字号行结构由渲染器直出
    // （field-renderer buildLanguageRowStructure / buildFontSizeRowStructure），
    // 运行期只剩 global-language-rows 的通用行为激活（并入 global-pill-steppers
    // 步；pass5 起 select-projection 管线步退役，before 边随之收缩）。
    assert.doesNotMatch(fn, /name: 'appearance-rows'/,
        'the retired appearance-rows pass must stay retired');
    // M5-c pass5：select-projection 退役——pass4 的通用激活扫描已把全部
    // schema select 打标收编，弹层投影在 schema 面无可投影对象；模块保留
    // （agent 设置面仍是真实消费方），管线步与 before 边随之删除。
    assert.doesNotMatch(fn, /name: 'select-projection'/,
        'the vacuous schema-surface select projection pass must stay retired');
    // M5-c pass6：canonical-rows 步退役——全部分区由渲染器直出 canonical 行，
    // 投影 pass 在 schema 面无候选行；模块与管线步、before 边随之删除。
    // form-icons 步同批退役：三个内联 Lucide SVG 由渲染器直出 vcp-ui-icon 节点。
    assert.doesNotMatch(fn, /name: 'canonical-rows'/,
        'the vacuous schema-surface canonical-rows pass must stay retired');
    assert.doesNotMatch(fn, /name: 'form-icons'/,
        'the vacuous form-icons pass must stay retired');
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
    // （vcpCanonicalRowsMounted 随 M5-c pass6 canonical-rows pass 退役注销。）
    for (const name of ['vcpTypedPrimitiveMounted', 'vcpTypedGlobalSettingsEntry', 'vcpTypedNetworkPathAction',
        'vcpSettingsRow', 'vcpSelectRebuilding',
        'vcpUiuxToggleMounted', 'vcpAutosaveState', 'vcpSettingsDirty', 'vcpTypedAgentModel']) {
        assert.ok(registry.isRegisteredSettingsMarker(name), `known marker ${name} must be registered`);
    }
    assert.equal(registry.isRegisteredSettingsMarker('vcpCanonicalRowsMounted'), false,
        'the retired canonical-rows pass marker must stay deregistered');
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

test('设置分区静态标记退役（M4）：分区契约由 schema 渲染承接', () => {
    // main.html 的八个分区壳只剩 id + data-settings-section-key；行结构、
    // 业务锚点与 data-visible-when 组合的全部契约移到
    // tests/settings-schema-render.test.mjs（schema 编译产物逐字对齐原静态标记）。
    const html = read(path.join(root, 'main.html'));
    for (const key of ['user-identity', 'server-connection', 'appearance-settings', 'render-settings',
        'selection-assistant', 'voice-settings', 'advanced-features', 'quick-actions']) {
        assert.match(html, new RegExp(`id="section-${key}" data-settings-section-key="${key}"></div>`),
            `section ${key} shell must remain for nav/ownership`);
    }
    const templateMatch = html.match(/<template id="globalSettingsModalTemplate">([\s\S]*?)<\/template>/);
    assert.ok(templateMatch, 'the global settings modal template must remain');
    assert.ok(!templateMatch[1].includes('data-vcp-style='),
        'the static settings rows retire with the schema surface');
    assert.ok(!html.includes('id="middleClickQuickActionContainer"'), 'quick-actions rows moved to schema');
    assert.ok(!html.includes('id="contextSanitizerDepthContainer"'), 'advanced-features rows moved to schema');
    // The flattened sections own the top-border divider model in CSS.
    const overrides = read(path.join(root, 'styles', 'ui-system', 'settings-template.css'));
    assert.match(overrides, /\.vcp-ui-scope#globalSettingsModal \.vcp-uiux-general-row \+ \.vcp-uiux-general-row \{\s*\n\s*border-top: 1px solid/,
        'the unified settings surface draws its hairlines from the adjacent-sibling top border');
    assert.ok(!overrides.includes('vcp-uiux-row-tail'),
        'the JS tail marker CSS is retired with the globalized top-border model');
    // Nested row primitives self-inject a bottom hairline; inside a canonical
    // row it must yield to the row boundary (two-column stepper rows leak
    // partial double hairlines otherwise).
    assert.match(overrides, /\.vcp-uiux-general-row :is\(\.vcp-uiux-language-row, \.vcp-uiux-numeric-stepper-row, \.vcp-uiux-font-size-row\) \{\s*\n\s*border-bottom: 0;/,
        'nested row primitives opt out of their self-drawn hairline inside canonical rows');
    // The section projection keeps the export but delegates to the shared
    // evaluator; no hardcoded per-row display writes survive the flatten.
    // M5-d：advanced/rust 薄包装文件删除（事件路径经 typed-field-owners 直调
    // syncDependentRows），保留删除守卫；render-visibility 保留（旧式 id 表 +
    // 时长输出镜像，非 data-visible-when 语义）。
    assert.equal(fs.existsSync(path.join(root, 'modules', 'ui-system', 'settings', 'advanced-visibility.js')), false,
        'the retired advanced-visibility wrapper must stay deleted');
    assert.equal(fs.existsSync(path.join(root, 'modules', 'ui-system', 'settings', 'rust-visibility.js')), false,
        'the retired rust-visibility wrapper must stay deleted');
    const typedOwnersSource = read(path.join(root, 'modules', 'ui-system', 'typed-field-owners.js'));
    for (const retiredCall of ['syncAdvancedSettingsVisibility', 'syncRustAssistantVisibility']) {
        assert.ok(!typedOwnersSource.includes(retiredCall), `typed owners must not call ${retiredCall}`);
    }
    assert.match(typedOwnersSource, /import \{ syncDependentRows \} from '\.\/settings\/dependent-rows\.js';/,
        'typed owners must import the unified visibility evaluator directly');
    // The fallback binder re-evaluates the same clauses for degraded mode.
    const legacy = read(eventListeners);
    assert.match(legacy, /syncDependentRows/);
    const audit = read(path.join(root, 'scripts', 'audit-settings-layout.mjs'));
    assert.match(audit, /FLAT_SECTIONS = new Set\(\['quick-actions', 'advanced-features', 'render-settings', 'server-connection', 'voice-settings', 'selection-assistant', 'user-identity', 'appearance-settings'\]\)/,
        'the layout probe must enforce the flattened sections');
    // 事件路径与快照路径都改走共享行评估器，不允许残留直写。
    const presentation = read(path.join(root, 'modules', 'renderer', 'mainChatSettingsPresentationOwner.js'));
    for (const retired of ['userChatBubbleSettings', 'chatBubbleWidthSettings']) {
        assert.ok(!presentation.includes(retired), `presentation owner must not reference ${retired}`);
    }
    assert.match(presentation, /import \{ syncDependentRows \} from '\.\.\/ui-system\/settings\/dependent-rows\.js';/);
    const typed = read(path.join(root, 'modules', 'ui-system', 'typed-field-owners.js'));
    assert.ok(!typed.includes('chatBubbleWidthSettings'), 'typed snapshot path must not write the retired panel');
    // canonical 行投影：appearance 分区整体是 feature-owned 行区（M5-b 起机械
    // 层与渲染器直出共享，断言跟着搬到 render/canonical-row.js）。
    const canonical = read(path.join(root, 'modules', 'settings', 'render', 'canonical-row.js'));
    assert.match(canonical, /appearance-home-tagline-setting, \[data-settings-section-key="appearance-settings"\]'/,
        'appearanceOwner covers the stamped appearance section');
    // M5-c pass6：canonical-rows 投影 pass 退役（渲染器全分区直出，pass 在
    // schema 面无候选行），模块文件删除；保留删除守卫防止回潮。
    assert.equal(fs.existsSync(path.join(root, 'modules', 'ui-system', 'settings', 'canonical-rows.js')), false,
        'the retired canonical-rows pass module must stay deleted');
});

test('settings 挂载管线：步骤失败必须带步名记录并向调用方抛出', async () => {
    const pipeline = await import(pathToFileURL(path.join(settingsDir, 'pipeline.js')).href);
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
        assert.throws(
            () => pipeline.runSettingsPipeline([
                { name: 'first', run: () => {} },
                { name: 'boom', run: () => { throw new Error('simulated step failure'); } },
                { name: 'never', run: () => assert.fail('later steps must not run') },
            ]),
            /simulated step failure/,
            'the step failure must propagate to the caller boundary',
        );
    } finally {
        console.error = originalError;
    }
    assert.ok(
        errors.some(args => typeof args[0] === 'string' && args[0].includes('"boom"')),
        'the log must attribute the failure to the exact step name',
    );
    assert.doesNotThrow(() => pipeline.resolvePipelineOrder([{ name: 'solo', run: () => {} }]));
});

test('统一 surface 投影失败必须关闭 CSS 门并恢复 legacy 类钩子', async () => {
    const mainHtml = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
    const source = new JSDOM(mainHtml, { url: 'https://vcpchat.local/' });
    const dom = new JSDOM('<!doctype html><html><body><div id="modal-container"></div></body></html>', {
        url: 'https://vcpchat.local/',
    });
    const template = source.window.document.getElementById('globalSettingsModalTemplate');
    dom.window.document.getElementById('modal-container')
        .appendChild(dom.window.document.importNode(template.content, true));

    const previousGlobals = {};
    for (const name of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Element', 'Node']) {
        previousGlobals[name] = globalThis[name];
    }
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        CustomEvent: dom.window.CustomEvent,
        Event: dom.window.Event,
        HTMLElement: dom.window.HTMLElement,
        Element: dom.window.Element,
        Node: dom.window.Node,
    });
    dom.window.chatAPI = {
        async saveSettings() { return { success: true }; },
        async saveRustAssistantConfig() { return { success: true }; },
        connectVCPLog() {},
        disconnectVCPLog() {},
    };

    const bridgeErrors = [];
    const originalError = console.error;
    console.error = (...args) => bridgeErrors.push(args);
    try {
        // Force a mid-shell-surgery failure: the canonical nav replaceWith is
        // the first destructive move of the shell step.
        const listHost = dom.window.document.querySelector('.vcp-settings-source-list');
        assert.ok(listHost, 'the legacy nav list host must exist before the shell mounts');
        listHost.replaceWith = () => { throw new Error('simulated shell surgery failure'); };

        await import(`${pathToFileURL(bridgeEntry).href}?settings-fallback-test=1`);
        const modal = dom.window.document.getElementById('globalSettingsModal');
        modal.classList.add('active');
        dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
            detail: { modalId: 'globalSettingsModal', active: true },
        }));
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.equal(
            dom.window.document.documentElement.classList.contains('vcp-global-settings-host'),
            false,
            'the new-layer CSS gate must close when the projection fails',
        );
        assert.equal(modal.classList.contains('vcp-global-settings-surface'), false,
            'the surface alias must come off with the gate');
        for (const [selector, legacyClass] of [
            ['.vcp-uiux-settings-panel', 'vcp-settings-source-panel'],
            ['.vcp-uiux-settings-nav', 'vcp-settings-source-nav'],
            ['.vcp-uiux-settings-content', 'vcp-settings-source-content'],
            ['.vcp-uiux-settings-nav-title', 'vcp-settings-source-title'],
        ]) {
            const node = modal.querySelector(selector);
            assert.ok(node && node.classList.contains(legacyClass),
                `${legacyClass} must be restored so the classic layer can match the node`);
        }
        assert.ok(
            bridgeErrors.some(args => typeof args[0] === 'string' && args[0].includes('projection failed')),
            'the fallback must log the projection failure',
        );
    } finally {
        console.error = originalError;
        for (const name of Object.keys(previousGlobals)) {
            if (previousGlobals[name] === undefined) delete globalThis[name];
            else globalThis[name] = previousGlobals[name];
        }
    }
});
