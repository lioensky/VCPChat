// typed-field-owners — the typed settings seam for the global settings form:
// the settings/rust/forum/runtime UI services, the snapshot consumers that
// project service state into canonical controls, and the per-field draft/save
// owners that bypass the legacy form-submit chain.  Native controls and
// persisted keys remain canonical; this module owns only the typed command
// path around them.
import { bridgeScope, ensurePresentationScope } from './settings/bridge-shared.js';
import { syncAdvancedSettingsVisibility } from './settings/advanced-visibility.js';
import { syncRustAssistantVisibility } from './settings/rust-visibility.js';
import { syncRenderSettingsVisibility } from './settings/render-visibility.js';
import { syncDependentRows } from './settings/dependent-rows.js';
import { getSaveCoordinator } from './settings/save-coordinator.js';
import { fieldDescriptor, fieldRestore } from './settings/field-registry.js';

const typedFieldStates = new Set();
const typedForumFieldStates = new Set();
let typedSettingsService = null;
let typedSettingsRegistry = null;
let typedRustAssistantService = null;
let typedForumConfigService = null;
let typedAssistantRuntimeService = null;
let typedSettingsState = Object.freeze({});
let typedSettingsExternalRelease = null;
let typedSettingsSaveChain = Promise.resolve();
let typedSettingsSaveGeneration = 0;
let typedSettingsDisposed = false;

function addTypedNetworkPathInput(root, path = '') {
    const container = root?.querySelector?.('#networkNotesPathsContainer');
    if (!container) return false;
    // Resolve the owner before binding any dynamic-row listener.  Rows can be
    // created after the Settings surface mounted; their controls must still
    // retract with the same presentation scope instead of leaving an ambient
    // listener on a detached row during a close/reopen cycle.
    const inputScope = ensurePresentationScope();
    const inputGroup = document.createElement('div');
    inputGroup.className = 'network-path-input-group vcp-settings-row';
    inputGroup.dataset.vcpSettingsRow = 'true';
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'networkNotesPath';
    input.placeholder = '例如 \\NAS\\Shared\\Notes';
    input.value = path;
    // Rows created after the typed field owner mounted belong to it; mark
    // them immediately so an input between the helper call and the next
    // delegation pass can never fall back onto the legacy chain.
    if (document.getElementById('globalSettingsForm')?.dataset.vcpTypedFieldOwnerMounted === 'true') {
        input.dataset.vcpTypedFieldOwner = 'true';
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '删除';
    removeBtn.className = 'sidebar-button small-button danger-button';
    // A silent row removal previously skipped every dirty chain; announce it
    // so the owning owner recomputes the serialized list.
    const removeRow = () => {
        inputGroup.remove();
        container.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (inputScope) inputScope.listen(removeBtn, 'click', removeRow, { once: true });
    else removeBtn.addEventListener('click', removeRow, { once: true });
    inputGroup.append(input, removeBtn);
    container.appendChild(inputGroup);
    // Dynamic rows adopt the same real Input primitive as static fields; a
    // bare input keeps the native control contract when the runtime or the
    // presentation scope is unavailable.
    const inputApi = window.VCPUIUX;
    if (inputApi?.mountInput && inputScope) {
        try {
            inputApi.mountInput(input, {}, inputScope);
            input.closest('.vcp-uiux-input-wrap')?.classList.add('vcp-uiux-input-fill');
        } catch (error) {
            console.warn('[VCPUI SettingsBridge] Could not mount network path Input primitive:', error);
        }
    }
    return true;
}

function ensureTypedSettingsService() {
    if (typedSettingsService || !window.VCPUIUX?.createSettingsUiService) return typedSettingsService;
    const externalListeners = new Set();
    const publishExternal = settings => {
        if (typedSettingsDisposed) return;
        typedSettingsState = Object.freeze({ ...typedSettingsState, ...(settings || {}) });
        externalListeners.forEach(listener => listener(typedSettingsState));
    };
    const onExternalSettings = event => publishExternal(event.detail?.settings);
    if (bridgeScope) bridgeScope.listen(window, 'global-settings-updated', onExternalSettings, undefined, 'typed-settings-external-update');
    else window.addEventListener('global-settings-updated', onExternalSettings);
    typedSettingsExternalRelease = () => {
        if (!bridgeScope) window.removeEventListener('global-settings-updated', onExternalSettings);
        externalListeners.clear();
        typedSettingsExternalRelease = null;
    };
    typedSettingsService = window.VCPUIUX.createSettingsUiService({
        get: () => typedSettingsState,
        save: patch => {
            const generation = ++typedSettingsSaveGeneration;
            const run = async () => {
                const next = Object.freeze({ ...typedSettingsState, ...patch });
                const result = await window.chatAPI?.saveSettings?.(next);
                if (result?.success && generation === typedSettingsSaveGeneration) publishExternal(next);
                return result?.success ? { success: true } : { success: false, error: result?.error || '设置保存失败' };
            };
            const result = typedSettingsSaveChain.then(run, run);
            typedSettingsSaveChain = result.catch(() => {});
            return result;
        },
        cancelPendingSaves: () => {
            typedSettingsSaveGeneration += 1;
            // Do not let a timed-out IPC hold retry behind an unbounded chain.
            // The old request may still settle in the main process, but it has
            // lost publication rights and the next retry starts immediately.
            typedSettingsSaveChain = Promise.resolve();
        },
        subscribe: listener => {
            externalListeners.add(listener);
            return () => externalListeners.delete(listener);
        },
    });
    void window.chatAPI?.loadSettings?.().then(settings => publishExternal(settings)).catch(() => {});
    if (window.VCPUIUX?.createUiServiceRegistryFromScope && bridgeScope && window.VCPUIUX?.settingsUiDefinition) {
        typedSettingsRegistry = window.VCPUIUX.createUiServiceRegistryFromScope(bridgeScope);
        const definition = window.VCPUIUX.settingsUiDefinition;
        typedSettingsRegistry.install(definition, context => definition.provide({
            ...context,
            services: { ...context.services, settings: typedSettingsService },
        }));
    } else {
        // Compatibility fallback while the typed browser entry is unavailable.
        bridgeScope?.own(() => typedSettingsService?.dispose?.(), 'typed-settings-service', 'ui-service');
    }
    bridgeScope?.own(() => {
        typedSettingsDisposed = true;
        typedSettingsExternalRelease?.();
    }, 'typed-settings-events', 'ui-service');
    return typedSettingsService;
}

function mountTypedSettingsConsumer(root) {
    const fallbackService = ensureTypedSettingsService();
    const service = typedSettingsRegistry?.get('settings-ui') || fallbackService;
    if (!service || !root) return;
    const form = root.querySelector('#globalSettingsForm');
    const apply = (_value, snapshot) => {
        if (!form) return;
        root.dataset.vcpSettingsRevision = String(snapshot.revision);
        root.dataset.vcpSettingsSource = snapshot.source;
        // The typed service owns durable projection reads for migrated fields.
        // Never overwrite a user's dirty draft or an in-flight submission.
        if (form.dataset.vcpSettingsDirty === 'true' || form.dataset.globalSettingsSaving === 'true') return;
        const settings = snapshot.value || {};
        const projection = [
            // The retired userUseThemeColorsInChat row never wrote anything:
            // the persisted key has no control inside #globalSettingsForm (its
            // namesake checkbox lives in the per-agent agentSettingsForm), so
            // that lookup resolved to null on every projection pass.
            ['vcpServerUrl', 'vcpServerUrl'],
            ['vcpApiKey', 'vcpApiKey'],
            ['fileKey', 'fileKey'],
            ['vcpLogUrl', 'vcpLogUrl'],
            ['vcpLogKey', 'vcpLogKey'],
            ['topicSummaryModel', 'topicSummaryModel'],
            ['assistantAgent', 'assistantAgent'],
            ['voiceModeLocal', 'voiceMode', 'checked-value', 'local'],
            ['voiceModeNetwork', 'voiceMode', 'checked-value', 'network'],
            ['voiceInputMode', 'voiceInputMode'],
            ['voiceInputShortcut', 'voiceInputShortcut'],
            ['voiceLocalSovitsUrl', 'voiceLocalSettings.sovitsUrl'],
            ['voiceLocalSovitsKey', 'voiceLocalSettings.sovitsKey'],
            ['voiceNetworkProviderUrl', 'voiceNetworkSettings.providerUrl'],
            ['voiceNetworkProviderKey', 'voiceNetworkSettings.providerKey'],
            ['enableDistributedServer', 'enableDistributedServer', 'checked'],
            ['agentMusicControl', 'agentMusicControl', 'checked'],
            ['enableVcpToolInjection', 'enableVcpToolInjection', 'checked'],
            ['enableThoughtChainInjection', 'enableThoughtChainInjection', 'checked'],
            ['enableContextSanitizer', 'enableContextSanitizer', 'checked'],
            ['contextSanitizerDepth', 'contextSanitizerDepth'],
            ['enableAiMessageButtons', 'enableAiMessageButtons', 'checked'],
            ['flowlockContinueDelay', 'flowlockContinueDelay'],
            ['enableMiddleClickQuickAction', 'enableMiddleClickQuickAction', 'checked'],
            ['middleClickQuickAction', 'middleClickQuickAction'],
            ['enableMiddleClickAdvanced', 'enableMiddleClickAdvanced', 'checked'],
            ['middleClickAdvancedDelay', 'middleClickAdvancedDelay'],
            ['enableRegenerateConfirmation', 'enableRegenerateConfirmation', 'checked'],
            ['chatPresentationModeBubble', 'chatPresentationMode', 'checked-value', 'bubble'],
            ['chatPresentationModePanel', 'chatPresentationMode', 'checked-value', 'panel'],
            ['chatPresentationModeImmersive', 'chatPresentationMode', 'checked-value', 'immersive'],
            ['enableUserChatBubbleUi', 'enableUserChatBubbleUi', 'checked'],
            ['showUserMetaInChatBubbleUi', 'showUserMetaInChatBubbleUi', 'checked'],
            ['chatBubbleMaxWidthWideDefault', 'chatBubbleMaxWidthWideDefault'],
            ['chatBubbleMaxWidthWideNotifications', 'chatBubbleMaxWidthWideNotifications'],
            ['chatBubbleMaxWidthWideNarrow', 'chatBubbleMaxWidthWideNarrow'],
            ['minChunkBufferSize', 'minChunkBufferSize'],
            ['smoothStreamIntervalMs', 'smoothStreamIntervalMs'],
            ['enableSmoothStreaming', 'enableSmoothStreaming', 'checked'],
            ['streamAnimationPreset', 'streamAnimationPreset'],
            ['streamAnimationDurationMs', 'streamAnimationDurationMs'],
            ['streamAnimationCustomCss', 'streamAnimationCustomCss'],
        ];
        projection.forEach(([id, path, mode, expected]) => {
            const control = form.querySelector(`#${id}`);
            if (!control) return;
            const value = path.split('.').reduce((current, key) => current?.[key], settings);
            if (value === undefined || value === null) return;
            if (mode === 'checked-value') control.checked = String(value) === expected;
            else if (mode === 'checked-inverse') control.checked = value !== true;
            else if (mode === 'checked' || control.type === 'checkbox') control.checked = Boolean(value);
            else if (mode === 'px-output') {
                control.value = `${value}px`;
                control.textContent = `${value}px`;
            }
            else control.value = String(value);
        });
        // Display defaults ported from the retired startup fallback
        // (handoff retirement batch): the typed state stores raw persisted
        // data, but these two voice controls keep their first-open display
        // defaults exactly as the fallback used to fill them.
        [['voiceInputMode', 'windows_voice_typing'], ['voiceInputShortcut', 'F7'], ['voiceNetworkProviderUrl', 'https://www.dmxapi.cn/v1']]
            .forEach(([id, displayDefault]) => {
                const control = form.querySelector(`#${id}`);
                if (control && !control.value) control.value = displayDefault;
            });
        if (Object.prototype.hasOwnProperty.call(settings, 'userAvatarUrl')) {
            const preview = form.querySelector('#userAvatarPreview');
            const wrapper = preview?.closest('.agent-avatar-wrapper');
            const avatarUrl = String(settings.userAvatarUrl || '');
            if (preview) {
                if (avatarUrl) {
                    preview.src = avatarUrl;
                    preview.style.display = 'block';
                    wrapper?.classList.remove('no-avatar');
                } else {
                    preview.src = '#';
                    preview.style.display = 'none';
                    wrapper?.classList.add('no-avatar');
                }
            }
        }
        const sanitizerContainer = form.querySelector('#contextSanitizerDepthContainer');
        const sanitizerEnabled = settings.enableContextSanitizer === true;
        if (sanitizerContainer) sanitizerContainer.style.display = sanitizerEnabled ? '' : 'none';
        // The flattened quick-actions rows own their visibility; the snapshot
        // path composes the conditions its retired wrapper containers used to
        // provide (the event path is syncAdvancedSettingsVisibility below).
        const middleClickEnabled = settings.enableMiddleClickQuickAction === true;
        const quickActionContainer = form.querySelector('#middleClickQuickActionContainer');
        if (quickActionContainer) quickActionContainer.style.display = middleClickEnabled ? '' : 'none';
        const advancedToggleRow = form.querySelector('#middleClickAdvancedToggleRow');
        if (advancedToggleRow) advancedToggleRow.style.display = middleClickEnabled ? '' : 'none';
        const advancedSettings = form.querySelector('#middleClickAdvancedSettings');
        if (advancedSettings) {
            advancedSettings.style.display = middleClickEnabled && settings.enableMiddleClickAdvanced === true ? '' : 'none';
        }
        const regenerateRow = form.querySelector('#regenerateConfirmationContainer');
        if (regenerateRow) {
            const quickAction = settings.middleClickQuickAction ?? form.querySelector('#middleClickQuickAction')?.value;
            regenerateRow.style.display = middleClickEnabled && quickAction === 'regenerate' ? '' : 'none';
        }
        // 阶段 3 扁平化：appearance 的条件行以 data-visible-when 自持可见性，
        // 快照路径在投影后统一重估一次，而不是直写包裹容器。
        syncDependentRows(form);
    };
    const release = service.state.subscribe(apply);
    const consumerScope = ensurePresentationScope();
    if (consumerScope) {
        consumerScope.own(() => {
            release?.();
            delete root.dataset.vcpSettingsRevision;
            delete root.dataset.vcpSettingsSource;
        }, 'typed-settings-consumer', 'ui-presentation');
    } else {
        // No presentation scope (destroyed bridge): the subscription would
        // fire apply() against a torn-down form forever, so retract it now.
        release?.();
    }
    const assistantSelect = form?.querySelector('#assistantAgent');
    if (assistantSelect && window.MutationObserver) {
        const observer = new MutationObserver(() => {
            const snapshot = service.state.getSnapshot();
            apply(snapshot.value, snapshot);
        });
        observer.observe(assistantSelect, { childList: true });
        ensurePresentationScope()?.own(() => observer.disconnect(), 'typed-assistant-options-consumer', 'ui-presentation');
    }
    const rustService = ensureRustAssistantUiService();
    if (rustService) {
        const applyRust = (_value, snapshot) => {
            if (form.dataset.vcpSettingsDirty === 'true' || form.dataset.globalSettingsSaving === 'true') return;
            const rust = snapshot.value || {};
            // Programmatic checkbox writes signal mounted presentation
            // primitives through vcp-uiux-sync, same contract as set().
            const check = (id, value) => { const control = form.querySelector(`#${id}`); if (!control) return; const next = Boolean(value); if (control.checked === next) return; control.checked = next; control.dispatchEvent(new (control.ownerDocument.defaultView?.CustomEvent ?? CustomEvent)('vcp-uiux-sync', { bubbles: true })); };
            const set = (id, value) => { const control = form.querySelector(`#${id}`); if (control && value !== undefined && value !== null) control.value = String(value); };
            check('rustUseAssistant', rust.useRustAssistant === true);
            check('rustDebugMode', rust.debugMode === true);
            const thresholds = rust.runtimeThresholds || {};
            const custom = Object.entries({ minEventIntervalMs: 80, minDistance: 0, screenshotSuspendMs: 3000, clipboardConflictSuspendMs: 1000, clipboardCheckIntervalMs: 500 })
                .some(([key, fallback]) => Number(thresholds[key] ?? fallback) !== fallback);
            check('rustEnableCustomThresholds', custom);
            set('rustMinEventIntervalMs', thresholds.minEventIntervalMs);
            set('rustMinDistance', thresholds.minDistance);
            set('rustScreenshotSuspendMs', thresholds.screenshotSuspendMs);
            set('rustClipboardConflictSuspendMs', thresholds.clipboardConflictSuspendMs);
            set('rustClipboardCheckIntervalMs', thresholds.clipboardCheckIntervalMs);
            set('rustWhitelistKeywords', Array.isArray(rust.whitelist) ? rust.whitelist.join('\n') : '');
            set('rustBlacklistKeywords', Array.isArray(rust.blacklist) ? rust.blacklist.join('\n') : '');
            set('rustScreenshotApps', Array.isArray(rust.screenshotApps) ? rust.screenshotApps.join('\n') : '');
            const ruleMode = Array.isArray(rust.whitelist) && rust.whitelist.length
                ? 'whitelist'
                : (Array.isArray(rust.blacklist) && rust.blacklist.length ? 'blacklist' : 'none');
            set('rustRuleMode', ruleMode);
            syncRustAssistantVisibility(form);
        };
        const release = rustService.state.subscribe(applyRust);
        const rustScope = ensurePresentationScope();
        if (rustScope) rustScope.own(release, 'typed-rust-assistant-consumer', 'ui-presentation');
        else release?.();
        syncRustAssistantVisibility(form);
        ['change', 'input'].forEach(type => {
            const onChange = () => syncRustAssistantVisibility(form);
            if (rustScope) rustScope.listen(form, type, onChange);
            else form.addEventListener(type, onChange);
        });
        void rustService.refresh.execute();
    }
    const forumService = ensureForumConfigUiService();
    if (forumService) {
        const applyForum = (_value, snapshot) => {
            if (form.dataset.vcpSettingsDirty === 'true' || form.dataset.globalSettingsSaving === 'true') return;
            const forum = snapshot.value || {};
            const username = form.querySelector('#adminUsername');
            const password = form.querySelector('#adminPassword');
            if (username && forum.username !== undefined) username.value = String(forum.username || '');
            if (password && forum.password !== undefined) password.value = String(forum.password || '');
        };
        const release = forumService.state.subscribe(applyForum);
        const forumScope = ensurePresentationScope();
        if (forumScope) forumScope.own(release, 'typed-forum-config-consumer', 'ui-presentation');
        else release?.();
        void forumService.refresh.execute();
    }
    const runtimeService = ensureAssistantRuntimeUiService();
    if (runtimeService) {
        const applyRuntime = (_value, snapshot) => {
            const runtime = snapshot.value || {};
            const modeText = runtime.mode === 'rust' ? 'Rust' : (runtime.mode === 'disabled' ? 'Disabled' : runtime.mode || 'Unknown');
            const desiredText = runtime.desiredMode === 'rust' ? 'Rust' : (runtime.desiredMode === 'disabled' ? 'Disabled' : runtime.desiredMode || 'Unknown');
            const setText = (id, value) => { const node = form.querySelector(`#${id}`); if (node) node.textContent = String(value ?? '无'); };
            setText('assistantRuntimeMode', modeText);
            setText('assistantRuntimeDesiredMode', desiredText);
            setText('assistantRuntimeActive', runtime.active === true ? '运行中' : '未运行');
            setText('assistantRuntimeDebugReason', runtime.debugReason || '无');
            setText('assistantRuntimeForwardedCount', runtime.integrationTrace?.forwardedCount ?? 0);
            setText('assistantRuntimeSidecarActive', runtime.sidecarActive === true ? '运行中' : '未运行');
            setText('assistantRuntimeProcessAlive', runtime.adapterProcessAlive === true ? '运行中' : '未运行');
            setText('assistantRuntimeProcessPid', runtime.adapterProcessPid || '无');
            setText('assistantRuntimeAutoFallbackCount', runtime.runtimeFallbackTrace?.autoFallbackCount ?? 0);
            setText('assistantRuntimeAutoFallbackReason', runtime.runtimeFallbackTrace?.lastAutoFallbackReason || '无');
            setText('assistantRuntimeReceivedCount', runtime.integrationTrace?.receivedSelectionCount ?? 0);
            setText('assistantRuntimeShowAttemptCount', runtime.integrationTrace?.showAttemptCount ?? 0);
            setText('assistantRuntimeShowError', runtime.integrationTrace?.lastShowError || '无');
        };
        const release = runtimeService.state.subscribe(applyRuntime);
        const runtimeScope = ensurePresentationScope();
        if (runtimeScope) runtimeScope.own(release, 'typed-assistant-runtime-consumer', 'ui-presentation');
        else release?.();
        void runtimeService.refresh.execute();
    }
}

function ensureRustAssistantUiService() {
    if (typedRustAssistantService || !typedSettingsRegistry || !window.VCPUIUX?.createRustAssistantUiService) return typedRustAssistantService;
    const chatAPI = window.chatAPI;
    if (!chatAPI?.getRustAssistantConfig || !chatAPI?.saveRustAssistantConfig) return null;
    const adapter = window.VCPUIUX.createRustAssistantUiService({
        get: () => chatAPI.getRustAssistantConfig(),
        save: patch => chatAPI.saveRustAssistantConfig(patch),
    });
    const definition = window.VCPUIUX.rustAssistantUiDefinition;
    typedRustAssistantService = typedSettingsRegistry.install(definition, context => definition.provide({
        ...context,
        services: { ...context.services, rustAssistantAdapter: adapter },
    }));
    return typedRustAssistantService;
}

function ensureForumConfigUiService() {
    if (typedForumConfigService || !typedSettingsRegistry || !window.VCPUIUX?.createForumConfigUiService) return typedForumConfigService;
    const chatAPI = window.chatAPI;
    if (!chatAPI?.loadForumConfig || !chatAPI?.saveForumConfig) return null;
    const adapter = window.VCPUIUX.createForumConfigUiService({
        get: () => chatAPI.loadForumConfig(),
        save: patch => chatAPI.saveForumConfig(patch),
    });
    const definition = window.VCPUIUX.forumConfigUiDefinition;
    typedForumConfigService = typedSettingsRegistry.install(definition, context => definition.provide({
        ...context,
        services: { ...context.services, forumConfigAdapter: adapter },
    }));
    return typedForumConfigService;
}

function ensureAssistantRuntimeUiService() {
    if (typedAssistantRuntimeService || !typedSettingsRegistry || !window.VCPUIUX?.createAssistantRuntimeUiService) return typedAssistantRuntimeService;
    const chatAPI = window.chatAPI;
    if (!chatAPI?.getAssistantRuntimeStatus) return null;
    const adapter = window.VCPUIUX.createAssistantRuntimeUiService({ get: () => chatAPI.getAssistantRuntimeStatus() });
    const definition = window.VCPUIUX.assistantRuntimeUiDefinition;
    typedAssistantRuntimeService = typedSettingsRegistry.install(definition, context => definition.provide({
        ...context,
        services: { ...context.services, assistantRuntimeAdapter: adapter },
    }));
    return typedAssistantRuntimeService;
}

// Forum credentials are presentation-only in this phase.  The existing
// ForumConfigUiService/global submit path remains the command owner until its
// dirty/autosave seam is migrated; this primitive only establishes the
// Uiux Light-DOM geometry and scope-owned teardown contract.

function mountTypedForumFieldOwner(root, form) {
    if (!root || !form || form.dataset.vcpTypedForumFieldOwnerMounted === 'true') return;
    const service = typedSettingsRegistry?.get('forum-config-ui') || ensureForumConfigUiService();
    if (!service?.save?.execute) return;
    const controls = ['adminUsername', 'adminPassword'].map(id => form.querySelector(`#${id}`)).filter(Boolean);
    if (controls.length !== 2) return;
    const ownerScope = ensurePresentationScope();
    if (!ownerScope) return;
    const state = { form, timer: null, pending: false, inFlight: null, disposed: false, failed: false };
    // Status writes go through the save coordinator when one is claimed for
    // the form (the pipeline always claims it); the direct write only serves
    // standalone mounts. The coordinator also receives this owner as a
    // client, so its owner-tagged results are routed here — the legacy
    // machine never filters them by string.
    const coordinator = getSaveCoordinator(form);
    const setStatus = (mode) => {
        if (coordinator) coordinator.reportState(mode);
        else form.dataset.vcpAutosaveState = mode;
    };
    coordinator?.registerClient({ id: 'typed-forum-field-owner', flush: flushTypedForumFields });
    const run = async () => {
        state.timer = null;
        if (state.disposed || !state.pending || state.inFlight) return;
        state.pending = false;
        const username = form.querySelector('#adminUsername')?.value?.trim() || '';
        const password = form.querySelector('#adminPassword')?.value || '';
        state.inFlight = service.save.execute({ username, password, rememberCredentials: true });
        setStatus('saving');
        try {
            const result = await state.inFlight;
            if (state.disposed) return;
            if (!result?.success) {
                state.failed = true;
                form.dataset.vcpSettingsDirty = 'true';
                setStatus('error');
                form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: false, error: result?.error || '论坛配置保存失败', owner: 'typed-forum-field-owner' } }));
            } else {
                state.failed = false;
                if (!state.pending) delete form.dataset.vcpSettingsDirty;
                setStatus('saved');
                form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: true, owner: 'typed-forum-field-owner' } }));
            }
        } catch (error) {
            if (!state.disposed) {
                state.failed = true;
                form.dataset.vcpSettingsDirty = 'true';
                setStatus('error');
                form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: false, error: error?.message || String(error), owner: 'typed-forum-field-owner' } }));
            }
        } finally { state.inFlight = null; if (state.pending) schedule(); }
    };
    const schedule = () => {
        if (state.disposed) return;
        state.pending = true;
        form.dataset.vcpSettingsDirty = 'true';
        setStatus('dirty');
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(run, 400);
    };
    const onInput = event => { if (controls.includes(event.target)) schedule(); };
    // There is no header status surface to click any more: a failed field
    // save retries through the next edit on the same field or the close-time
    // flush, so no cross-owner retry routing is needed.
    state.run = run;
    ownerScope.listen(controls[0], 'input', onInput);
    ownerScope.listen(controls[1], 'input', onInput);
    ownerScope.listen(controls[0], 'change', onInput);
    ownerScope.listen(controls[1], 'change', onInput);
    controls.forEach(control => { control.dataset.vcpTypedForumFieldOwner = 'true'; });
    form.dataset.vcpTypedForumFieldOwnerMounted = 'true';
    typedForumFieldStates.add(state);
    ownerScope.own(() => {
        state.disposed = true;
        if (state.timer) clearTimeout(state.timer);
        controls.forEach(control => { delete control.dataset.vcpTypedForumFieldOwner; });
        typedForumFieldStates.delete(state);
        delete form.dataset.vcpTypedForumFieldOwnerMounted;
    }, 'typed-forum-field-owner', 'ui-presentation');
}

// R2-02C: these controls have a single draft/save owner. They continue to
// use the canonical business nodes and persisted keys, but no longer enter
// the legacy form-submit/autosave chain.
const TYPED_FIELD_DEFINITIONS = Object.freeze({
    userAvatarBorderColor: { path: 'userAvatarBorderColor', kind: 'string' },
    userAvatarBorderColorText: { path: 'userAvatarBorderColor', kind: 'string' },
    // Name color mirrors the avatar pair: two controls, one persisted key.
    userNameTextColor: { path: 'userNameTextColor', kind: 'string', fallback: '#ffffff' },
    userNameTextColorText: { path: 'userNameTextColor', kind: 'string', fallback: '#ffffff' },
    userName: { path: 'userName', kind: 'string', trimValue: true, fallback: '用户' },
    continueWritingPrompt: { path: 'continueWritingPrompt', kind: 'string', trimValue: true, fallback: '请继续' },
    showHomeVisualBrand: { path: 'showHomeVisualBrand', kind: 'boolean' },
    showHomeVisualTagline: { path: 'showHomeVisualTagline', kind: 'boolean' },
    homeVisualTagline: { path: 'homeVisualTagline', kind: 'string' },
    // Wide layout is one boolean behind a radio pair; the Normal radio owns
    // the inverted value so both half-states flow through the same draft.
    chatLayoutModeWide: { path: 'enableWideChatLayout', kind: 'boolean' },
    chatLayoutModeNormal: { path: 'enableWideChatLayout', kind: 'inverse-boolean' },
    // Chat typography presets/customs: selects and text inputs keep their
    // canonical nodes; visual application stays with the settings snapshot
    // consumers (chat renderer semantics untouched).
    chatFontPreset: { path: 'chatFontPreset', kind: 'string' },
    chatFontCustom: { path: 'chatFontCustom', kind: 'string' },
    chatCodeFontPreset: { path: 'chatCodeFontPreset', kind: 'string' },
    chatCodeFontCustom: { path: 'chatCodeFontCustom', kind: 'string' },
    chatDiaryFontPreset: { path: 'chatDiaryFontPreset', kind: 'string' },
    chatDiaryFontCustom: { path: 'chatDiaryFontCustom', kind: 'string' },
    chatToolFontPreset: { path: 'chatToolFontPreset', kind: 'string' },
    chatToolFontCustom: { path: 'chatToolFontCustom', kind: 'string' },
    appearanceDensity: { path: 'appearanceProfile.density', kind: 'string' },
    appearanceRadius: { path: 'appearanceProfile.radius', kind: 'string' },
    appearanceTypography: { path: 'appearanceProfile.typography', kind: 'string' },
    appearanceFontScale: { path: 'appearanceProfile.fontScale', kind: 'string' },
    appearanceContentWidth: { path: 'appearanceProfile.contentWidth', kind: 'string' },
    appearanceSurface: { path: 'appearanceProfile.surface', kind: 'string' },
    appearanceSidebarRadius: { path: 'appearanceProfile.sidebarRadius', kind: 'string' },
    appearanceSidebarRowHeight: { path: 'appearanceProfile.sidebarRowHeight', kind: 'number' },
    appearanceSidebarAvatarSize: { path: 'appearanceProfile.sidebarAvatarSize', kind: 'number' },
    appearanceCustomRadius: { path: 'appearanceProfile.customRadius', kind: 'number' },
    // The model-selection button still uses the shared legacy modal, but the
    // canonical text value can already use the single typed save owner.
    topicSummaryModel: { path: 'topicSummaryModel', kind: 'string' },
    voiceInputMode: { path: 'voiceInputMode', kind: 'string', fallback: 'windows_voice_typing' },
    voiceInputShortcut: { path: 'voiceInputShortcut', kind: 'string', fallback: 'F7', trimValue: true },
    streamAnimationPreset: { path: 'streamAnimationPreset', kind: 'string', fallback: 'slide-left' },
    streamAnimationDurationMs: { path: 'streamAnimationDurationMs', kind: 'number', fallback: 500 },
    streamAnimationCustomCss: { path: 'streamAnimationCustomCss', kind: 'string' },
});

function readTypedFieldPatch(control, service, pendingPatch) {
    const definition = TYPED_FIELD_DEFINITIONS[control?.id];
    if (!definition) return null;
    const raw = control.type === 'checkbox' || control.type === 'radio' ? control.checked : control.value;
    let value = definition.kind === 'choice' ? definition.value : definition.kind === 'number' ? Number(raw) : definition.kind === 'inverse-boolean' ? Boolean(raw) !== true : definition.kind === 'boolean' ? Boolean(raw) : String(raw);
    // Keep the legacy whole-form collect contract for fields whose persisted
    // semantics depend on it (trim + default fill), so the save command line
    // cannot diverge from what the legacy chain used to persist.
    if (definition.trimValue && typeof value === 'string') value = value.trim();
    if (definition.fallback !== undefined && typeof value === 'string' && !value) value = definition.fallback;
    if (definition.path.startsWith('appearanceProfile.')) {
        // Build the full-profile snapshot on top of the accumulated draft, not
        // bare service state: every later event in one debounce window would
        // otherwise revert earlier drafts of sibling appearance fields.
        const current = {
            ...(service.state.get()?.appearanceProfile || {}),
            ...(pendingPatch?.appearanceProfile || {}),
        };
        const key = definition.path.slice('appearanceProfile.'.length);
        return { appearanceProfile: { ...current, [key]: value } };
    }
    return { [definition.path]: value };
}

function mountTypedFieldOwner(root, form) {
    if (!root || !form || form.dataset.vcpTypedFieldOwnerMounted === 'true') return;
    const service = typedSettingsRegistry?.get('settings-ui') || ensureTypedSettingsService();
    if (!service?.save?.execute) return;
    const ownerScope = ensurePresentationScope();
    if (!ownerScope) return;
    const controls = Object.keys(TYPED_FIELD_DEFINITIONS)
        .map(id => form.querySelector(`#${id}`))
        .filter(Boolean);
    if (!controls.length) return;
    const state = { root, form, timer: null, pendingPatch: null, inFlight: null, disposed: false, cleanups: [], run: null };
    // Dynamic path rows cannot be expressed as one control per definition id:
    // every row shares the networkNotesPaths key.  The container becomes the
    // owned unit and delegation covers rows added after mount.
    const pathsContainer = form.querySelector('#networkNotesPathsContainer');
    const collectNetworkNotesPaths = () => [...pathsContainer.querySelectorAll('input[name="networkNotesPath"]')]
        .map(input => input.value.trim())
        .filter(Boolean);
    const project = snapshot => {
        if (state.disposed || form.dataset.vcpSettingsDirty === 'true' || form.dataset.globalSettingsSaving === 'true') return;
        const settings = snapshot?.value || {};
        const appearance = settings.appearanceProfile || {};
        const set = (id, value) => { const node = form.querySelector(`#${id}`); if (node && value !== undefined && value !== null) { const next = String(value); if (node.value !== next) { node.value = next; const EventCtor = node.ownerDocument.defaultView?.CustomEvent ?? CustomEvent; node.dispatchEvent(new EventCtor('vcp-uiux-sync')); } } };
        // Programmatic checkbox writes signal mounted presentation primitives
        // through vcp-uiux-sync, same contract as set() above.
        const check = (id, value) => { const node = form.querySelector(`#${id}`); if (!node) return; const next = Boolean(value); if (node.checked === next) return; node.checked = next; node.dispatchEvent(new (node.ownerDocument.defaultView?.CustomEvent ?? CustomEvent)('vcp-uiux-sync')); };
        set('userAvatarBorderColor', settings.userAvatarBorderColor || '#3d5a80');
        set('userAvatarBorderColorText', fieldRestore('userAvatarBorderColorText', settings) ?? '');
        set('appearanceDensity', appearance.density || 'comfortable');
        set('appearanceRadius', appearance.radius || 'small');
        set('appearanceTypography', appearance.typography || 'system');
        set('appearanceFontScale', appearance.fontScale || 'normal');
        set('appearanceContentWidth', appearance.contentWidth || 'full');
        set('appearanceSurface', appearance.surface || 'translucent');
        set('appearanceSidebarRowHeight', appearance.sidebarRowHeight ?? 46);
        set('appearanceSidebarRowHeightValue', `${appearance.sidebarRowHeight ?? 46}px`);
        set('appearanceSidebarAvatarSize', appearance.sidebarAvatarSize ?? 32);
        set('appearanceSidebarAvatarSizeValue', `${appearance.sidebarAvatarSize ?? 32}px`);
        set('appearanceCustomRadius', appearance.customRadius ?? 10);
        set('appearanceCustomRadiusValue', `${appearance.customRadius ?? 10}px`);
        set('appearanceSidebarRadius', appearance.sidebarRadius || 'tuned');
        check('chatLayoutModeWide', settings.enableWideChatLayout === true);
        check('chatLayoutModeNormal', settings.enableWideChatLayout !== true);
        check('showHomeVisualBrand', settings.showHomeVisualBrand !== false);
        check('showHomeVisualTagline', settings.showHomeVisualTagline !== false);
        set('homeVisualTagline', fieldRestore('homeVisualTagline', settings) ?? '');
        // Name cluster owns its snapshot reads now; the color mirror keeps
        // both controls on one persisted key like the avatar pair.  The
        // legacy userUseThemeColorsInChat key has no control inside the
        // Settings form (the visible useThemeColorsInChat checkbox belongs
        // to the per-agent form), so there is nothing to project for it.
        set('userName', settings.userName);
        set('userNameTextColor', settings.userNameTextColor || '#ffffff');
        set('userNameTextColorText', fieldRestore('userNameTextColorText', settings) ?? '');
        set('continueWritingPrompt', settings.continueWritingPrompt);
        // Chat typography owns its fallbacks here now that the generic
        // snapshot projection no longer writes these nodes.
        set('chatFontPreset', settings.chatFontPreset || 'system');
        set('chatFontCustom', settings.chatFontCustom || '');
        set('chatCodeFontPreset', settings.chatCodeFontPreset || 'consolas');
        set('chatCodeFontCustom', settings.chatCodeFontCustom || '');
        set('chatDiaryFontPreset', settings.chatDiaryFontPreset || 'serif');
        set('chatDiaryFontCustom', settings.chatDiaryFontCustom || '');
        set('chatToolFontPreset', settings.chatToolFontPreset || 'system');
        set('chatToolFontCustom', settings.chatToolFontCustom || '');
        set('voiceInputMode', settings.voiceInputMode || 'windows_voice_typing');
        set('voiceInputShortcut', fieldRestore('voiceInputShortcut', settings) ?? '');
        set('streamAnimationPreset', settings.streamAnimationPreset || 'slide-left');
        set('streamAnimationDurationMs', settings.streamAnimationDurationMs ?? 500);
        set('streamAnimationDurationValue', `${settings.streamAnimationDurationMs ?? 500}ms`);
        set('streamAnimationCustomCss', settings.streamAnimationCustomCss || '');
        syncRenderSettingsVisibility(form);
        // Network notes rows: the typed field owner is their single writer;
        // the generic consumer projection no longer rebuilds them.
        if (pathsContainer) {
            const paths = Array.isArray(settings.networkNotesPaths)
                ? settings.networkNotesPaths.map(path => String(path || '')).filter(Boolean)
                : [];
            const current = collectNetworkNotesPaths();
            if (current.join('\u0000') !== paths.join('\u0000')) {
                pathsContainer.replaceChildren();
                const addPath = path => addTypedNetworkPathInput(root, path)
                    || window.uiHelperFunctions?.addNetworkPathInput?.(path);
                if (typeof addPath === 'function') {
                    (paths.length ? paths : ['']).forEach(path => addPath(path));
                    pathsContainer.querySelectorAll('input[name="networkNotesPath"]').forEach(input => { input.dataset.vcpTypedFieldOwner = 'true'; });
                }
            }
        }
    };
    // Conditional rows are presentation-owned. Keep their immediate response
    // local to this Settings owner so the ambient event-listeners module does
    // not compete with snapshot projection or survive modal teardown.
    const syncConditionalRows = () => syncAdvancedSettingsVisibility(form);
    syncConditionalRows();
    ['change', 'input'].forEach(type => {
        const onChange = () => syncConditionalRows();
        ownerScope.listen(form, type, onChange);
    });
    // Status writes go through the save coordinator when one is claimed for
    // the form (the pipeline always claims it); the direct write only serves
    // standalone mounts. The coordinator also receives this owner as a
    // client, so its owner-tagged results are routed here — the legacy
    // machine never filters them by string.
    const coordinator = getSaveCoordinator(form);
    const setStatus = (mode) => {
        if (coordinator) coordinator.reportState(mode);
        else form.dataset.vcpAutosaveState = mode;
    };
    coordinator?.registerClient({ id: 'typed-settings-field-owner', flush: flushTypedSettingsFields });
    const publish = (success, error = '') => {
        form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success, error: error || undefined, owner: 'typed-settings-field-owner' } }));
    };
    const run = async () => {
        state.timer = null;
        if (state.disposed || !state.pendingPatch || state.inFlight) return;
        const patch = state.pendingPatch;
        state.pendingPatch = null;
        state.inFlight = service.save.execute(patch);
        setStatus('saving');
        try {
            const result = await state.inFlight;
            if (state.disposed) return;
            if (!result?.success) {
                form.dataset.vcpSettingsDirty = 'true';
                setStatus('error');
                publish(false, result?.error || '设置保存失败');
                return;
            }
            if (!state.pendingPatch) delete form.dataset.vcpSettingsDirty;
            setStatus('saved');
            publish(true);
            if (state.pendingPatch) schedule();
        } catch (error) {
            if (!state.disposed) {
                form.dataset.vcpSettingsDirty = 'true';
                setStatus('error');
                publish(false, error?.message || String(error));
            }
        } finally {
            state.inFlight = null;
        }
    };
    const schedule = () => {
        if (state.disposed) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(run, 400);
    };
    state.run = run;
    const markDirty = () => {
        form.dataset.vcpSettingsDirty = 'true';
        setStatus('dirty');
    };
    // Bounds live in the field descriptor (阶段 4); the clamp pass consults
    // the registry instead of hardcoding the numbers.
    const middleClickDelayValidation = fieldDescriptor('middleClickAdvancedDelay')?.validation || {};
    const normalizeMiddleClickDelay = control => {
        if (!control) return false;
        const value = Number.parseInt(control.value, 10);
        const min = middleClickDelayValidation.min ?? 1000;
        if (Number.isFinite(value) && value >= min) return false;
        control.value = String(middleClickDelayValidation.clampTo ?? min);
        window.uiHelperFunctions?.showToastNotification?.(
            middleClickDelayValidation.message || `快捷环出现延迟不能小于${min}ms，已自动调整`, 'info');
        return true;
    };
    const onInput = event => {
        const control = event.target;
        if (!TYPED_FIELD_DEFINITIONS[control?.id]) return;
        if (control.id === 'middleClickAdvancedDelay') normalizeMiddleClickDelay(control);
        const patch = readTypedFieldPatch(control, service, state.pendingPatch) || {};
        if (patch.appearanceProfile) {
            state.pendingPatch = {
                ...(state.pendingPatch || {}),
                appearanceProfile: {
                    ...(state.pendingPatch?.appearanceProfile || service.state.get()?.appearanceProfile || {}),
                    ...patch.appearanceProfile,
                },
            };
        } else {
            state.pendingPatch = { ...(state.pendingPatch || {}), ...patch };
        }
        markDirty();
        schedule();
    };
    controls.forEach(control => {
        control.dataset.vcpTypedFieldOwner = 'true';
        ownerScope.listen(control, 'input', onInput);
        ownerScope.listen(control, 'change', onInput);
        state.cleanups.push(() => {
            delete control.dataset.vcpTypedFieldOwner;
        });
    });
    const renderPresetIds = ['chatFontPreset', 'chatCodeFontPreset', 'chatDiaryFontPreset', 'chatToolFontPreset'];
    renderPresetIds.forEach(id => {
        const select = form.querySelector(`#${id}`);
        if (!select) return;
        const onRenderPresetChange = () => syncRenderSettingsVisibility(form);
        ownerScope.listen(select, 'change', onRenderPresetChange);
    });
    ['streamAnimationPreset', 'streamAnimationDurationMs'].forEach(id => {
        const control = form.querySelector(`#${id}`);
        if (!control) return;
        ownerScope.listen(control, 'input', () => syncRenderSettingsVisibility(form));
        ownerScope.listen(control, 'change', () => syncRenderSettingsVisibility(form));
    });
    const middleClickAdvancedDelay = form.querySelector('#middleClickAdvancedDelay');
    if (middleClickAdvancedDelay) {
        const onBlur = () => {
            if (normalizeMiddleClickDelay(middleClickAdvancedDelay)) {
                middleClickAdvancedDelay.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        ownerScope.listen(middleClickAdvancedDelay, 'blur', onBlur);
    }
    if (pathsContainer) {
        const onRowsDirty = () => {
            // Row removal, row addition and typing all reduce to "recollect
            // the current list"; empty rows drop out like the legacy save.
            state.pendingPatch = { ...(state.pendingPatch || {}), networkNotesPaths: collectNetworkNotesPaths() };
            markDirty();
            schedule();
        };
        ownerScope.listen(pathsContainer, 'input', onRowsDirty);
        ownerScope.listen(pathsContainer, 'change', onRowsDirty);
        pathsContainer.querySelectorAll('input[name="networkNotesPath"]').forEach(input => { input.dataset.vcpTypedFieldOwner = 'true'; });
        state.cleanups.push(() => {
            pathsContainer.querySelectorAll('input[name="networkNotesPath"]').forEach(input => { delete input.dataset.vcpTypedFieldOwner; });
        });
    }
    const release = service.state.subscribe((_value, snapshot) => project(snapshot));
    state.cleanups.push(() => release?.());
    state.cleanups.push(() => {
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.pendingPatch = null;
        state.disposed = true;
        service.cancelPendingSaves?.();
        delete form.dataset.vcpTypedFieldOwnerMounted;
    });
    form.dataset.vcpTypedFieldOwnerMounted = 'true';
    typedFieldStates.add(state);
    ensurePresentationScope()?.own(() => {
        state.cleanups.forEach(cleanup => cleanup());
        typedFieldStates.delete(state);
    }, 'typed-settings-field-owner', 'ui-presentation');
}

function flushTypedForumFields() {
    typedForumFieldStates.forEach(state => {
        if (state.disposed || !state.pending || state.inFlight) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        void state.run?.();
    });
}

// Settings-field half of the flush, kept separate so the save coordinator can
// register each client with exactly its own registry.
function flushTypedSettingsFields() {
    typedFieldStates.forEach(state => {
        if (state.disposed || !state.pendingPatch || state.inFlight) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        // The field owner intentionally starts its own command and does not
        // route through form.requestSubmit(), which would re-enter legacy
        // presentation and close the modal.
        void state.run?.();
    });
}

// Typed halves of the entry's flush/teardown autosave composition: the draft
// owners flush through their own commands (never form.requestSubmit()) and
// retract their cleanups with the surface.
function flushTypedOwners() {
    flushTypedSettingsFields();
    typedForumFieldStates.forEach(state => {
        if (state.disposed || !state.pending || state.inFlight) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        void state.run?.();
    });
}

function teardownTypedOwners() {
    [...typedFieldStates].forEach(state => {
        state.cleanups.forEach(cleanup => cleanup());
        typedFieldStates.delete(state);
    });
    [...typedForumFieldStates].forEach(state => {
        state.disposed = true;
        if (state.timer) clearTimeout(state.timer);
        typedForumFieldStates.delete(state);
    });
}

function disposeTypedSettings() {
    typedSettingsDisposed = true;
    if (!bridgeScope) {
        typedSettingsService?.dispose?.();
        typedSettingsExternalRelease?.();
    }
}

export {
    addTypedNetworkPathInput,
    ensureTypedSettingsService,
    ensureRustAssistantUiService,
    ensureForumConfigUiService,
    ensureAssistantRuntimeUiService,
    mountTypedSettingsConsumer,
    mountTypedForumFieldOwner,
    mountTypedFieldOwner,
    flushTypedOwners,
    flushTypedForumFields,
    teardownTypedOwners,
    disposeTypedSettings,
};
