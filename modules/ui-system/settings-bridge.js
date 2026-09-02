// settings-bridge — unified VCPUI enhancement bridge for settings surfaces.
//
// The entry stays the orchestrator: it owns the global settings modal shell,
// the public window.VCPUISettingsBridge contract and the refresh/teardown
// lifecycle.  The domains live in their own modules —
// settings/bridge-shared.js (presentation scope/controller/Select
// projection/shared passes), agent-settings-bridge.js (Agent/Group sidebar
// forms) and typed-field-owners.js (typed settings seam) — and compose here.
//
// Global settings: the modal is rebuilt into one Uiux SettingsRoot-style
// layout — native nav cells in the left rail, a header/options content column,
// the original form as the business source, and autosave status in the header.

import { ensurePresentationScope, takePresentationScope, isPresentationDestroyed, markPresentationDestroyed, enhance, uniqueSettingsKey, selectProjection, releaseDisconnectedControllers, releaseAllControllers, enhancedControllerCount, bridgeScope } from './settings/bridge-shared.js';
import { mountSettingsAutosave, flushLegacyAutosave, teardownLegacyAutosave } from './settings/autosave.js';
import { claimSaveCoordinator, getSaveCoordinator } from './settings/save-coordinator.js';
import { mountCanonicalSettingsRows } from './settings/canonical-rows.js';
import { runSettingsPipeline } from './settings/pipeline.js';
import { syncRenderSettingsVisibility } from './settings/render-visibility.js';
import { mountAppearanceRanges } from './settings/appearance-ranges.js';
import { mountAppearanceToggles } from './settings/appearance-toggles.js';
import { mountHomeTaglineInput } from './settings/home-controls.js';
import { mountIdentityColorPairs } from './settings/identity-controls.js';
import { mountGlobalLanguageRows } from './settings/global-language-rows.js';
import { mountGlobalChoices, mountGlobalSteppers, mountVoiceShortcutInput } from './settings/global-input-upgrades.js';
import { mountForumCredentialInputs } from './settings/forum-controls.js';
import { applySchemaSurface } from '../settings/schema-surface.js';
import { enhanceForm, mountTypedTopicSummaryModelPicker, cleanupDisconnectedAgentModelPickers, releaseAllAgentModelPickers } from './agent-settings-bridge.js';
import { addTypedNetworkPathInput, ensureTypedSettingsService, ensureRustAssistantUiService, ensureForumConfigUiService, ensureAssistantRuntimeUiService, mountTypedSettingsConsumer, mountTypedForumFieldOwner, mountTypedFieldOwner, flushTypedOwners, flushTypedForumFields, teardownTypedOwners, disposeTypedSettings } from './typed-field-owners.js';

// Per-modal shell state is keyed by modal root so teardown can restore the
// exact original business nodes/classes after the canonical tree is removed.
// WeakMap cannot be iterated, so built roots are tracked separately.
const shellState = new WeakMap();
const shellRoots = new Set();
const disclosureStates = new Set();
// Replaced inline SVGs inside the global form, keyed by container, so teardown
// restores the original upstream paths during teardown.
const iconReplacements = new Set();
let refreshQueued = false;
const settingsHost = document.getElementById('tabContentSettings');
let destroyPromise = null;

function shouldEnhanceSidebarSettings() {
    // Global settings has one presentation contract.  The data attribute is
    // retained only as bootstrap metadata; it never selects a second layout.
    return Boolean(settingsHost);
}

function hasGlobalSettingsSurface() {
    // Global settings has one canonical surface.  Keep this helper as a
    // compatibility seam for callers, but never branch its presentation mode.
    return Boolean(document.getElementById('globalSettingsModal'));
}

function syncGlobalSettingsHost() {
    const modal = document.getElementById('globalSettingsModal');
    const active = Boolean(modal?.classList.contains('active'));
    document.documentElement.classList.toggle('vcp-global-settings-host', active);
    // Keep the historical marker as a non-branching compatibility alias for
    // automation/tests; all styling is owned by the unified surface marker.
    modal?.classList.add('vcp-global-settings-surface');
    if (modal) {
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
    }
    return modal;
}

function ensureSettingsAccessibility(modal) {
    if (!modal) return;
    modal.querySelectorAll('button, input:not([type="hidden"]), select, textarea').forEach(control => {
        if (control.getAttribute('aria-hidden') === 'true') return;
        if (control.labels?.length || control.closest('label') || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby') || control.getAttribute('title')) return;
        const text = control.textContent?.replace(/\s+/g, ' ').trim();
        if (text) {
            control.setAttribute('aria-label', text);
            return;
        }
        const previous = control.parentElement?.querySelector('label');
        if (previous?.textContent?.trim()) {
            control.setAttribute('aria-label', previous.textContent.replace(/\s+/g, ' ').trim());
            return;
        }
        const section = control.closest('.settings-section');
        const sectionTitle = section?.querySelector('.settings-section-title')?.textContent?.trim();
        if (sectionTitle) control.setAttribute('aria-label', sectionTitle);
    });
}

function focusSettingsModal(modal) {
    if (!modal?.classList.contains('active')) return;
    const target = modal.querySelector('.vcp-uiux-settings-nav-cell, input:not([type="hidden"]), select, textarea, button') || modal;
    const schedule = globalThis.requestAnimationFrame || (callback => globalThis.setTimeout(callback, 0));
    schedule(() => target.focus({ preventScroll: true }));
}

function trapSettingsFocus(event) {
    const modal = event.currentTarget;
    if (event.key !== 'Tab' || !modal.classList.contains('active')) return;
    const focusables = [...modal.querySelectorAll('button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(node => !node.disabled && node.getAttribute('aria-hidden') !== 'true' && node.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

// Fail-closed fallback for the unified surface: when the projection pipeline
// throws, the new-layer CSS gate must close instead of leaving a
// half-projected modal styled by unified-surface selectors. The gate marker
// and the surface alias come off, and the legacy presentation class hooks the
// shell surgery removed go back on, so the intact classic layer can lay out
// the still-connected business nodes. Moved chrome nodes cannot be restored
// atomically (teardown semantics are final for the renderer lifetime), so
// this fallback guarantees exactly the gate closure plus matchable class
// hooks — the provable minimum for the failure path.
function deactivateGlobalSettingsSurface(modal, error) {
    console.error('[VCPUI SettingsBridge] Unified surface projection failed; the classic presentation takes over:', error);
    document.documentElement.classList.remove('vcp-global-settings-host');
    modal.classList.remove('vcp-global-settings-surface');
    for (const [selector, legacyClass] of [
        ['.vcp-uiux-settings-panel', 'vcp-settings-source-panel'],
        ['.vcp-uiux-settings-nav', 'vcp-settings-source-nav'],
        ['.vcp-uiux-settings-content', 'vcp-settings-source-content'],
        ['.vcp-uiux-settings-nav-title', 'vcp-settings-source-title'],
    ]) {
        modal.querySelector(selector)?.classList.add(legacyClass);
    }
}

// The sidebar entry is a routine text action, so it can use the same generated
// Button contract as the other high-frequency Settings actions.  Its existing
// click handler stays outside this bridge: this owner changes only the visual
// presentation and retracts it with the Settings surface scope.
function mountGlobalSettingsEntryButton() {
    const button = document.getElementById('globalSettingsBtn');
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!button || !api?.mountButton || !scope || button.dataset.vcpTypedGlobalSettingsEntry === 'true') return;
    try {
        api.mountButton(button, { variant: 'outline', size: 'sm' }, scope);
        button.dataset.vcpTypedGlobalSettingsEntry = 'true';
        scope.own(() => {
            delete button.dataset.vcpTypedGlobalSettingsEntry;
        }, 'typed-global-settings-entry-marker', 'ui-presentation');
    } catch (error) {
        // The existing native button and listener remain fully operational if
        // the optional presentation artifact cannot mount.
        console.warn('[VCPUI SettingsBridge] Could not mount global Settings entry Button:', error);
    }
}

// The network-path add action is a routine, non-destructive Settings command.
// Keep its existing event handler and canonical form mutation, while adopting
// the same generated Button owner as the Settings entry itself.
function mountGlobalSettingsPathAction(root) {
    const button = root?.querySelector?.('#addNetworkPathBtn');
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!button || !api?.mountButton || !scope || button.dataset.vcpTypedNetworkPathAction === 'true') return;
    // The add action renders as a full-width dashed affordance inside its
    // card; the generated Button's inline styles (fixed height and radius)
    // would fight that presentation, so this row keeps its own styling.
    if (button.classList.contains('vcp-settings-card-add-row')) return;
    try {
        api.mountButton(button, { variant: 'outline', size: 'sm' }, scope);
        button.dataset.vcpTypedNetworkPathAction = 'true';
        scope.own(() => {
            delete button.dataset.vcpTypedNetworkPathAction;
        }, 'typed-network-path-action-marker', 'ui-presentation');
    } catch (error) {
        console.warn('[VCPUI SettingsBridge] Could not mount network-path action Button:', error);
    }
}

// Lucide icon names for the global settings categories. Icons are always
// rendered through VCPUI (`.vcp-ui-icon` -> lucide-adapter); no inline SVG,
// emoji or text arrows on this surface.
const GLOBAL_CATEGORY_ICONS = Object.freeze({
    'user-identity': 'user',
    'server-connection': 'server',
    'appearance-settings': 'palette',
    'render-settings': 'activity',
    'selection-assistant': 'mouse-pointer-click',
    'voice-settings': 'mic',
    'advanced-features': 'layers',
    'quick-actions': 'zap',
});

// Global settings modal: control enhancement, autosave status, and the
// source-equivalent SettingsRoot shell.
function enhanceGlobalSettings(root, form) {
    // schema 渲染面（exp/settings-schema）：在整条投影管线之前把已迁移分区
    // 替换为 schema 编译产物，管线随后按原样投影；开关关闭时此调用为空操作。
    applySchemaSurface(form);
    // The mount sequence is declared, not positional: every implicit "this
    // pass must own its nodes before X sees them" constraint is an explicit
    // `before` edge, and runSettingsPipeline resolves the same historical
    // order deterministically (declaration order breaks ties).
    const api = () => window.VCPUIUX;
    const scope = ensurePresentationScope;
    const steps = [
        // Claimed before every save client mounts: legacy autosave, the typed
        // settings owner, and the forum owner all register with it as
        // clients. It only needs the form, so it stays step zero — a save
        // client mounting first would silently miss its registration.
        { name: 'save-coordinator', run: () => claimSaveCoordinator(form) },
        {
            name: 'canonical-rows',
            before: ['global-pill-steppers',
                'global-typed-primitives',
                'uiux-disclosures', 'agent-name-fields'],
            run: () => mountCanonicalSettingsRows(form),
        },
        {
            name: 'global-pill-steppers',
            // M5-c pass2 起 stepper 投影退役：结构由 field-renderer 直出，激活
            // 并入 global-typed-primitives；pass4 起语言行/字号行结构亦直出，
            // appearance-rows 步删除；pass5 起 select-projection 随之退役
            //（全部 select 已由直出结构 + 行为激活接管）。本步只剩直出结构的
            // 行为激活——global-language-rows 的通用激活扫描 + 语音快捷键
            // Input 收编。
            run: () => {
                mountGlobalLanguageRows(form, api(), scope());
                mountVoiceShortcutInput(form, api(), scope());
            },
        },
        {
            name: 'global-typed-primitives',
            run: () => {
                mountHomeTaglineInput(form, api(), scope());
                mountGlobalChoices(form, api(), scope());
                mountAppearanceRanges(form, api(), scope());
                mountAppearanceToggles(form, api(), scope());
                mountIdentityColorPairs(form, api(), scope(), (message, kind) => window.uiHelperFunctions?.showToastNotification?.(message, kind));
                mountForumCredentialInputs(form, api(), scope());
                // M5-c pass2：步进器行结构已由渲染器直出，这里只激活行为。
                mountGlobalSteppers(form, api(), scope());
            },
        },
        {
            name: 'topic-summary-picker',
            // Reuse the production AgentModelPicker contract for the
            // topic-summary field.  The native input remains canonical; the
            // legacy modal template stays available until its shared business
            // callers are fully retired.
            run: () => mountTypedTopicSummaryModelPicker(form),
        },
        { name: 'forum-field-owner', run: () => mountTypedForumFieldOwner(root, form) },
        // M5-c pass1：uiux-switches 退役——开关行的 Toggle 原语 holder 由
        // field-renderer 直出（fieldProjection 'toggle' 字段仍走运行时收编）。
        {
            name: 'uiux-disclosures',
            run: () => {
                form.querySelectorAll('.agent-style-collapsible-container').forEach(disclosure => {
                    disclosure.dataset.settingPrimitive = 'disclosure';
                    disclosure.querySelector('.style-collapse-header')?.classList.add('vcp-uiux-disclosure-row');
                });
                mountUiuxDisclosures(form);
            },
        },
        {
            name: 'agent-name-fields',
            // M5-c pass3 起，Field 增强的挂载产物（vcp-ui-settings-field 类 +
            // 初始校验态）由渲染器直出（render/widgets.js 用户名行）；本步
            // 只保留校验态行为绑定（invalid/input/change 重同步）。
            run: () => form.querySelectorAll('.agent-name-wrapper').forEach(field => {
                if (field.querySelector('input:not([type="hidden"]), select, textarea')) enhance('Field', field);
            }),
        },
        { name: 'settings-shell', run: () => mountSettingsShell(root) },
        { name: 'autosave', run: () => mountSettingsAutosave(root, form, scope()) },
        { name: 'typed-field-owner', run: () => mountTypedFieldOwner(root, form) },
        { name: 'form-icons', run: () => normalizeFormIcons(root) },
    ];
    runSettingsPipeline(steps);
    ensureSettingsAccessibility(root);
    if (root.dataset.vcpSettingsFocusBound !== 'true') {
        root.addEventListener('keydown', trapSettingsFocus);
        root.dataset.vcpSettingsFocusBound = 'true';
        ensurePresentationScope()?.own(() => {
            root.removeEventListener('keydown', trapSettingsFocus);
            delete root.dataset.vcpSettingsFocusBound;
        }, 'settings-focus-trap', 'ui-presentation');
    }
    focusSettingsModal(root);
}

// M5-c pass3：uiux-inputs pass 退役——单行输入的 Input 原语包裹
// （span.vcp-uiux-input-wrap + input.input + 内联守卫样式）由渲染器直出
// （render/field-renderer.js buildInputPrimitiveWrap，widgets.js 专属组件
// 同样转录），typed owners 的 raw 投影字段仍由各自挂载方运行时收编。

function mountUiuxDisclosures(form) {
    const ownerScope = ensurePresentationScope();
    if (!ownerScope) return;
    form.querySelectorAll('.agent-style-collapsible-container').forEach(container => {
        // disclosureStates stores state records, not raw containers.  Using
        // Set.has(container) here silently missed the existing record and
        // re-bound click/keydown listeners on every Settings refresh.
        if ([...disclosureStates].some(state => state.container === container)) return;
        const header = container.querySelector('.style-collapse-header');
        const content = container.querySelector('.agent-style-controls');
        if (!header || !content) return;
        const originalHeaderClass = header.className;
        const originalHeaderAttrs = {
            role: header.getAttribute('role'),
            tabindex: header.getAttribute('tabindex'),
            ariaControls: header.getAttribute('aria-controls'),
            ariaExpanded: header.getAttribute('aria-expanded'),
        };
        const originalContentId = content.id;
        if (!content.id) content.id = `${container.id || 'settings-disclosure'}-content`;
        header.classList.add('vcp-uiux-disclosure-row');
        header.setAttribute('role', 'button');
        header.tabIndex = header.tabIndex >= 0 ? header.tabIndex : 0;
        header.setAttribute('aria-controls', content.id);
        const sync = () => header.setAttribute('aria-expanded', String(!container.classList.contains('collapsed')));
        const toggle = event => {
            if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            container.classList.toggle('collapsed');
            sync();
        };
        ownerScope.listen(header, 'click', toggle);
        ownerScope.listen(header, 'keydown', toggle);
        const observer = window.MutationObserver ? new window.MutationObserver(sync) : null;
        observer?.observe(container, { attributes: true, attributeFilter: ['class'] });
        sync();
        const state = { container, header, observer, cleaned: false, cleanup: () => {
            if (state.cleaned) return;
            state.cleaned = true;
            observer?.disconnect();
            header.removeAttribute('aria-controls');
            header.removeAttribute('aria-expanded');
            if (originalHeaderAttrs.role === null) header.removeAttribute('role');
            else header.setAttribute('role', originalHeaderAttrs.role);
            if (originalHeaderAttrs.tabindex === null) header.removeAttribute('tabindex');
            else header.setAttribute('tabindex', originalHeaderAttrs.tabindex);
            if (originalHeaderAttrs.ariaControls === null) header.removeAttribute('aria-controls');
            else header.setAttribute('aria-controls', originalHeaderAttrs.ariaControls);
            if (originalHeaderAttrs.ariaExpanded === null) header.removeAttribute('aria-expanded');
            else header.setAttribute('aria-expanded', originalHeaderAttrs.ariaExpanded);
            header.className = originalHeaderClass;
            if (originalContentId) content.id = originalContentId;
            else content.removeAttribute('id');
            disclosureStates.delete(state);
        }};
        disclosureStates.add(state);
        ownerScope.own(state.cleanup, `uiux-disclosure-${container.id || uniqueSettingsKey()}`, 'ui-presentation');
    });
}

function flushSettingsAutosave() {
    // The coordinator is the single flush entry once the presentation has
    // mounted; the module flushes below only serve the early-bootstrap
    // window where the pipeline has not claimed the form yet.
    const coordinator = getSaveCoordinator(document.getElementById('globalSettingsForm'));
    if (coordinator) {
        coordinator.flush();
        return;
    }
    flushLegacyAutosave();
    flushTypedOwners();
}

function teardownSettingsAutosave() {
    teardownLegacyAutosave();
    teardownTypedOwners();
    getSaveCoordinator(document.getElementById('globalSettingsForm'))?.dispose();
}

function teardownUiuxDisclosures() {
    [...disclosureStates].forEach(state => state.cleanup());
}

// Replaces the handful of hand-inlined Lucide paths inside the global form
// with VCPUI icon nodes (rendered by lucide-adapter). Originals are kept for
// deterministic teardown and business-DOM restoration.
function normalizeFormIcons(root) {
    if (root.dataset.vcpSettingsIconsNormalized) return;
    const replaced = [];
    const replaceIcon = (container, lucideName) => {
        const svg = container?.querySelector('svg');
        if (!svg) return;
        const icon = document.createElement('span');
        icon.className = 'vcp-ui-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = lucideName;
        svg.replaceWith(icon);
        // lucide-adapter replaces this temporary span with an SVG. Retaining
        // the span in the restoration record keeps an already-detached node
        // alive for the whole surface lifetime and, across repeated round-trips,
        // makes Chromium report a linear detached-node chain.
        // Restoration only needs the container and upstream SVG.
        replaced.push({ container, original: svg });
    };
    replaceIcon(root.querySelector('#resetUserAvatarColorsBtn'), 'refresh');
    replaceIcon(root.querySelector('.avatar-upload-overlay'), 'camera');
    replaceIcon(root.querySelector('#openTopicSummaryModelSelectBtn'), 'chevron-down');
    replaced.forEach(record => iconReplacements.add(record));
    if (replaced.length) root.dataset.vcpSettingsIconsNormalized = 'true';
}

function restoreFormIcons(root) {
    iconReplacements.forEach(({ container, original }) => {
        const current = container.querySelector('svg[data-vcp-icon], span.vcp-ui-icon');
        if (current) current.replaceWith(original);
        else if (!original.isConnected) container.prepend(original);
    });
    iconReplacements.clear();
    delete root.dataset.vcpSettingsIconsNormalized;
}

function bindIdentityNameEditor(form) {
    const nameInput = form?.querySelector('#userName');
    const nameDisplay = form?.querySelector('.vcp-uiux-identity-name-value');
    const nameEdit = form?.querySelector('.vcp-uiux-identity-name-edit');
    const nameCancel = form?.querySelector('.vcp-uiux-identity-name-cancel');
    if (!nameInput || !nameDisplay || !nameEdit || nameEdit.dataset.vcpIdentityNameBound === 'true') return;
    const shellScope = ensurePresentationScope();
    const syncName = () => { nameDisplay.textContent = nameInput.value || '用户'; };
    const setButtonIcon = (button, iconName) => {
        const current = button?.querySelector('svg[data-vcp-icon], span.vcp-ui-icon');
        if (!current) return;
        const icon = document.createElement('span');
        icon.className = 'vcp-ui-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = iconName;
        current.replaceWith(icon);
    };
    const setEditing = editing => {
        nameEdit.dataset.vcpIdentityNameBound = 'true';
        nameEdit.dataset.vcpIdentityNameEditing = String(editing);
        if (editing) nameEdit.dataset.vcpIdentityNameOriginal = nameInput.value;
        else delete nameEdit.dataset.vcpIdentityNameOriginal;
        nameEdit.setAttribute('aria-label', editing ? '完成用户名编辑' : '修改用户名');
        nameEdit.setAttribute('data-tooltip', editing ? '完成用户名编辑' : '修改用户名');
        setButtonIcon(nameEdit, editing ? 'check' : 'edit');
        nameInput.hidden = !editing;
        nameDisplay.hidden = editing;
        if (nameCancel) {
            nameCancel.hidden = !editing;
            nameCancel.setAttribute('data-tooltip', '取消修改用户名');
        }
        nameInput.closest('.agent-name-wrapper')?.classList.toggle('is-editing', editing);
        if (editing) { nameInput.focus(); nameInput.select(); }
    };
    nameInput.hidden = true;
    syncName();
    const listenIdentity = (target, type, handler, label) => shellScope ? shellScope.listen(target, type, handler, undefined, label) : target.addEventListener(type, handler);
    listenIdentity(nameEdit, 'click', () => setEditing(nameEdit.dataset.vcpIdentityNameEditing !== 'true'), 'identity-name-edit');
    if (nameCancel) {
        listenIdentity(nameCancel, 'click', () => {
            nameInput.value = nameEdit.dataset.vcpIdentityNameOriginal || nameInput.value;
            syncName();
            setEditing(false);
        }, 'identity-name-cancel');
    }
    listenIdentity(nameInput, 'input', syncName, 'identity-name-input');
    listenIdentity(nameInput, 'keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); setEditing(false); }
        if (event.key === 'Escape') { event.preventDefault(); syncName(); setEditing(false); }
    }, 'identity-name-keys');
    nameEdit.dataset.vcpIdentityNameBound = 'true';
    shellScope?.own(() => {
        delete nameEdit.dataset.vcpIdentityNameBound;
        delete nameEdit.dataset.vcpIdentityNameEditing;
        delete nameEdit.dataset.vcpIdentityNameOriginal;
    }, 'identity-name-editor-markers', 'ui-presentation');
}

// SettingsShell build: assemble a live Uiux SettingsRoot primitive tree.
// The original form sections remain the business source of truth; only the
// shell chrome (nav/header/options) is reconstructed here.
function mountSettingsShell(root) {
    bindIdentityNameEditor(root.querySelector('#globalSettingsForm'));
    if (root.querySelector('.vcp-uiux-settings-panel')) {
        reconcileSettingsShell(root);
        return;
    }
    mountTypedSettingsConsumer(root);
    const shellScope = ensurePresentationScope();
    const panel = root.querySelector('.vcp-settings-source-panel');
    const layout = root.querySelector('.vcp-settings-source-layout');
    const nav = root.querySelector('.vcp-settings-source-nav');
    const listHost = nav?.querySelector('.vcp-settings-source-list');
    const content = root.querySelector('.vcp-settings-source-content');
    const form = root.querySelector('#globalSettingsForm');
    const title = root.querySelector('.vcp-settings-source-title');
    const close = root.querySelector('.close-button');
    if (!panel || !layout || !nav || !content || !form || !title || !close) {
        return;
    }
    let meta = [];
    try {
        const sourceMeta = JSON.parse(nav.dataset.settingsSections || '[]');
        meta = sourceMeta.map(item => ({ ...item, icon: GLOBAL_CATEGORY_ICONS[item.value] || 'circle', selected: item.value === 'user-identity' }));
    } catch (error) {
        console.error('[VCPUI SettingsBridge] Invalid settings section metadata', error);
        return;
    }
    if (!meta.length) return;
    const initial = meta.find(item => item.selected)?.value || meta[0]?.value;
    if (!initial || !document.getElementById(`section-${initial}`)) {
        return;
    }


    const state = {
        panel,
        layout,
        nav,
        content,
        form,
        close,
        listHost: null,
        originalNavHost: listHost || null,
        title,
        header: null,
        options: null,
        sectionHost: null,
        sectionBank: null,
        sections: new Map(),
        navList: null,
        cleanups: [],
        meta,
        active: initial,
        query: '',
    };
    shellState.set(root, state);
    shellRoots.add(root);
    root.classList.add('vcp-uiux-settings-root', 'vcp-global-settings-surface');
    panel.classList.add('vcp-uiux-settings-panel');
    nav.classList.add('vcp-uiux-settings-nav');
    content.classList.add('vcp-uiux-settings-content');
    // The panel is overflow:hidden chrome and must never scroll. If anything
    // gives it a scrollTop anyway — wheel chaining, a stray focus() or
    // scrollIntoView() — the whole surface is displaced out of view, which
    // presents as the settings page white-out. Snap it back; the class check
    // retires the guard once teardown restores the legacy presentation.
    panel.addEventListener('scroll', () => {
        if (!panel.classList.contains('vcp-uiux-settings-panel')) return;
        if (panel.scrollTop !== 0) panel.scrollTop = 0;
        if (panel.scrollLeft !== 0) panel.scrollLeft = 0;
    });
    // Legacy presentation selectors must not participate in the live tree.
    // The classes are restored only when the bridge is torn down.
    nav.classList.remove('vcp-settings-source-nav');
    content.classList.remove('vcp-settings-source-content');
    panel.classList.remove('vcp-settings-source-panel');
    title.classList.remove('vcp-settings-source-title');

    // Uiux owns the settings title in the nav rail, not as a second
    // content heading. Move the canonical node and restore its exact parent
    // and sibling on teardown.
    nav.prepend(title);
    title.classList.add('vcp-uiux-settings-nav-title');
    title.id ||= 'vcpSettingsNavTitle';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', title.id);
    nav.setAttribute('aria-label', '全局设置');
    const search = document.createElement('div');
    search.className = 'vcp-uiux-settings-search';
    const searchButton = document.createElement('button');
    searchButton.type = 'button';
    searchButton.className = 'vcp-uiux-settings-search-button';
    searchButton.setAttribute('aria-label', '搜索设置');
    searchButton.title = '搜索设置';
    const searchIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    searchIcon.dataset.vcpIcon = 'search-outline-16';
    searchIcon.setAttribute('class', 'vcp-icon vcp-uiux-settings-search-icon');
    window.VcpIcons?.render(searchIcon, 'search-outline-16');
    searchButton.append(searchIcon);
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'vcp-uiux-settings-search-input';
    searchInput.placeholder = '搜索设置项';
    searchInput.setAttribute('aria-label', '搜索设置项');
    searchInput.hidden = true;
    search.append(searchButton, searchInput);
    const titleRow = document.createElement('div');
    titleRow.className = 'vcp-uiux-settings-title-row';
    titleRow.append(title, search);
    // Keep the title row attached before the first fallible DOM replacement.
    // If shell surgery fails, the fallback can still find and restore the
    // title's legacy selector hook in the live modal.
    nav.prepend(titleRow);

    // Compose the Uiux header/options primitives around the existing form;
    // the form remains the business owner, while the new nodes own chrome.
    const header = document.createElement('header');
    header.className = 'vcp-uiux-settings-header';
    header.setAttribute('data-setting-primitive', 'header');
    const actions = document.createElement('div');
    actions.className = 'vcp-uiux-settings-actions';
    const options = document.createElement('div');
    options.className = 'vcp-uiux-settings-options';
    options.setAttribute('data-setting-primitive', 'options');
    state.header = header;
    state.options = options;
    options.append(...[...content.childNodes]);
    // Uiux owns an icon-only 28px close primitive with an accessible text
    // seat. Replace the legacy text glyph once, while preserving the same
    // business button and close listener.
    if (!close.dataset.vcpUiuxClose) {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.dataset.vcpIcon = 'close-outline-16';
        icon.setAttribute('class', 'vcp-icon vcp-uiux-settings-close-icon');
        window.VcpIcons?.render(icon, 'close-outline-16');
        const hiddenLabel = document.createElement('span');
        hiddenLabel.className = 'vcp-uiux-settings-close-label';
        hiddenLabel.textContent = close.getAttribute('aria-label') || '关闭';
        close.replaceChildren(icon, hiddenLabel);
        close.classList.add('vcp-uiux-settings-close');
        close.dataset.vcpUiuxClose = 'true';
    }
    actions.append(close);
    header.append(actions);
    content.replaceChildren(header, options);

    // Uiux renders only the selected section into Options. Keep the
    // remaining business fields connected to the same form in a hidden bank
    // so legacy id/name queries, form serialization and IPC handlers remain
    // authoritative without leaving inactive settings in the visible tree.
    const sectionHost = document.createElement('div');
    sectionHost.className = 'vcp-uiux-active-section';
    sectionHost.dataset.settingPrimitive = 'section';
    const sectionBank = document.createElement('div');
    sectionBank.className = 'vcp-uiux-section-bank';
    sectionBank.hidden = true;
    sectionBank.setAttribute('aria-hidden', 'true');
    state.sectionHost = sectionHost;
    state.sectionBank = sectionBank;
    [...form.children].filter(child => child.matches('.settings-section')).forEach(section => {
        const value = section.id.replace(/^section-/, '');
        state.sections.set(value, section);
        section.classList.remove('active');
        sectionBank.append(section);
    });
    form.prepend(sectionHost, sectionBank);
    const initialSection = state.sections.get(initial);
    if (initialSection) {
        sectionHost.append(initialSection);
        initialSection.classList.add('active');
    }
    const canonicalNav = document.createElement('div');
    canonicalNav.className = 'vcp-uiux-settings-nav-list';
    canonicalNav.setAttribute('aria-label', '全局设置分类');
    state.navList = canonicalNav;
    state.listHost = canonicalNav;
    listHost?.replaceWith(canonicalNav);
    nav.replaceChildren(titleRow, canonicalNav);
    // The legacy grid wrapper no longer owns live layout.  Keep it detached so
    // business nodes can be restored atomically by teardown.
    panel.replaceChildren(nav, content);

    const rows = state.meta.map(item => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'vcp-uiux-settings-nav-cell';
        row.dataset.section = item.value;
        row.dataset.vcpCanonicalNav = 'true';
        row.id = `vcpSettingsTab-${item.value}`;
        const icon = document.createElement('span');
        icon.className = 'vcp-uiux-settings-nav-icon vcp-ui-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = item.icon;
        const copy = document.createElement('span');
        copy.className = 'vcp-uiux-settings-nav-copy';
        const label = document.createElement('strong');
        label.textContent = item.label;
        copy.append(label);
        row.append(icon, copy);
        const onClick = () => activateSection(item.value);
        const onKeydown = event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = rows.indexOf(row);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
            rows[next]?.focus();
            if (rows[next]) activateSection(rows[next].dataset.section);
        };
        if (shellScope) {
            shellScope.listen(row, 'click', onClick);
            shellScope.listen(row, 'keydown', onKeydown);
        } else {
            row.addEventListener('click', onClick);
            row.addEventListener('keydown', onKeydown);
        }
        state.listHost.append(row);
        return row;
    });
    const renderList = () => {
        state.listHost.setAttribute('aria-label', '全局设置分类');
        rows.forEach(row => {
            const value = row.dataset.section;
            const item = state.meta.find(candidate => candidate.value === value);
            if (!item) return;
            const section = state.sections.get(value);
            row.hidden = Boolean(state.query && !`${item.label} ${section?.textContent || ''}`.toLocaleLowerCase().includes(state.query));
            const selected = item.value === state.active;
            row.classList.toggle('is-active', selected);
            row.classList.toggle('active', selected);
            row.dataset.state = selected ? 'selected' : 'idle';
            row.tabIndex = selected ? 0 : -1;
        });
        state.meta.forEach(item => {
            const section = state.sections.get(item.value) || root.querySelector(`#section-${item.value}`);
            if (!section) return;
            // The active section is derived from the same state as the nav.
            // Re-assert it on every render so stale classes from a reused
            // modal or a bootstrap refresh cannot leave the two columns out
            // of sync.
            section.classList.toggle('active', item.value === state.active);
            section.removeAttribute('role');
            section.removeAttribute('aria-labelledby');
            section.removeAttribute('aria-hidden');
        });
    };
    const closeSearch = () => { state.query = ''; search.classList.remove('is-open'); title.hidden = false; searchInput.value = ''; searchInput.hidden = true; searchButton.hidden = false; renderList(); };
    const listenSearch = (target, type, handler, label) => {
        if (shellScope) shellScope.listen(target, type, handler, undefined, label);
        else target.addEventListener(type, handler);
    };
    listenSearch(searchButton, 'click', () => { search.classList.add('is-open'); title.hidden = true; searchButton.hidden = true; searchInput.hidden = false; searchInput.focus({ preventScroll: true }); }, 'settings-search-open');
    listenSearch(searchInput, 'input', () => {
        state.query = searchInput.value.trim().toLocaleLowerCase();
        renderList();
        if (state.query) {
            const first = rows.find(row => !row.hidden);
            if (first && first.dataset.section !== state.active) activateSection(first.dataset.section);
        }
    }, 'settings-search-input');
    listenSearch(searchInput, 'keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeSearch(); searchButton.focus(); } }, 'settings-search-escape');
    listenSearch(document, 'pointerdown', event => {
        if (search.classList.contains('is-open') && !search.contains(event.target)) closeSearch();
    }, 'settings-search-outside');

    const activateSection = (value) => {
        if (!state.meta.some(item => item.value === value)) return;
        state.active = value;
        const next = state.sections.get(value);
        if (next && state.sectionHost && next.parentNode !== state.sectionHost) {
            const current = state.sectionHost.querySelector('.settings-section');
            if (current) state.sectionBank.append(current);
            state.sectionHost.append(next);
        }
        renderList();
    };

    renderList();
}

// Reconcile a previously mounted shell after modal reopen or section-bank
// churn.  The form remains canonical; this only restores the active section's
// physical host and presentation markers when an earlier close/reopen turn
// left a stale active class behind.
function reconcileSettingsShell(root) {
    const state = shellState.get(root);
    if (!state?.sectionHost || !state.sectionBank || !state.form) return;
    const activeSection = state.sections.get(state.active);
    if (!activeSection) return;
    if (activeSection.parentNode !== state.sectionHost) {
        const current = state.sectionHost.querySelector('.settings-section');
        if (current && current !== activeSection) state.sectionBank.append(current);
        state.sectionHost.append(activeSection);
    }
    state.sections.forEach((section, value) => {
        section.classList.toggle('active', value === state.active);
    });
    state.listHost?.querySelectorAll?.('[data-section]')?.forEach(row => {
        const selected = row.dataset.section === state.active;
        row.classList.toggle('is-active', selected);
        row.classList.toggle('active', selected);
        row.dataset.state = selected ? 'selected' : 'idle';
        row.tabIndex = selected ? 0 : -1;
    });
}

function cleanupDisconnectedControllers() {
    releaseDisconnectedControllers();
    cleanupDisconnectedAgentModelPickers();
}

function refresh() {
    refreshQueued = false;
    if (isPresentationDestroyed()) return;
    ensurePresentationScope();
    cleanupDisconnectedControllers();
    mountGlobalSettingsEntryButton();
    const globalSettingsModal = syncGlobalSettingsHost();
    mountGlobalSettingsPathAction(globalSettingsModal);
    if (shouldEnhanceSidebarSettings()) {
        document.querySelectorAll('#agentSettingsForm, #groupSettingsForm').forEach(enhanceForm);
    }
    if (hasGlobalSettingsSurface()) {
        const form = globalSettingsModal?.querySelector('#globalSettingsForm');
        if (globalSettingsModal && form) {
            try {
                enhanceGlobalSettings(globalSettingsModal, form);
            } catch (error) {
                deactivateGlobalSettingsSurface(globalSettingsModal, error);
            }
        }
    }
}

function scheduleRefresh() {
    if (isPresentationDestroyed() || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(refresh);
}

function teardown() {
    const scope = takePresentationScope();
    // Retract enhanced controller identity synchronously before a rapid
    // A rapid surface round-trip can schedule another refresh.  The Scope
    // disposal below still owns error isolation and all non-controller
    // resources, but must not leave stale VCPUI proxies visible to the next
    // presentation generation.
    releaseAllControllers();
    if (scope) {
        void scope.dispose('settings-presentation-teardown').catch(error => {
            console.error('[VCPUI SettingsBridge] Failed to dispose presentation:', error);
        });
    }
    releaseAllAgentModelPickers();
    teardownSettingsAutosave();
    teardownUiuxDisclosures();
    selectProjection.teardown();
    [...shellRoots].forEach(root => {
        const state = shellState.get(root);
        if (!state) return;
        state.cleanups?.forEach(cleanup => cleanup());
        state.cleanups = [];
        // The unified Surface is canonical for the renderer lifetime. Teardown
        // releases listeners/controllers but does not resurrect retired DOM.
        shellState.delete(root);
    });
    shellRoots.clear();
    document.querySelectorAll('#globalSettingsModal[data-vcp-settings-icons-normalized]').forEach(restoreFormIcons);
    document.getElementById('globalSettingsModal')?.classList.remove('vcp-global-settings-surface');
    document.documentElement.classList.remove('vcp-global-settings-host');
}

const handleModalVisibility = event => {
    if (event.detail?.modalId === 'globalSettingsModal') {
        if (event.detail?.active !== false) {
            const root = event.detail?.root || document.getElementById('globalSettingsModal');
            bindIdentityNameEditor(root?.querySelector('#globalSettingsForm'));
        }
        if (event.detail?.active === false) flushSettingsAutosave();
        scheduleRefresh();
    }
};
const handleSurfaceUpdated = () => scheduleRefresh();
if (bridgeScope) bridgeScope.listen(document, 'modal-visibility-changed', handleModalVisibility, undefined, 'settings-modal-visibility');
else document.addEventListener('modal-visibility-changed', handleModalVisibility);

// Collapse toggles for settings cards (vcp-settings-card). The card markup
// is static business markup in main.html and outlives individual surface
// mounts, so the toggle is a delegated listener rather than a per-mount
// binding. Collapsed state is visual only — form serialization keeps
// reading every field regardless of visibility.
if (!globalThis.vcpSettingsCardToggleBound) {
    globalThis.vcpSettingsCardToggleBound = true;
    document.addEventListener('click', event => {
        const toggle = event.target instanceof Element
            ? event.target.closest('.vcp-settings-card-toggle') : null;
        if (!toggle) return;
        const card = toggle.closest('.vcp-settings-card');
        if (!card) return;
        const collapsed = card.classList.toggle('vcp-settings-card-collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
    });
}
if (bridgeScope) {
    bridgeScope.listen(document, 'modal-ready', handleModalVisibility, undefined, 'settings-modal-ready');
    bridgeScope.listen(document, 'vcp-settings-surface-updated', handleSurfaceUpdated, undefined, 'settings-surface-updated');
} else {
    document.addEventListener('modal-ready', handleModalVisibility);
    document.addEventListener('vcp-settings-surface-updated', handleSurfaceUpdated);
}
scheduleRefresh();

window.VCPUISettingsBridge = Object.freeze({
    refresh: scheduleRefresh,
    flush: flushSettingsAutosave,
    flushForum: flushTypedForumFields,
    addNetworkPathInput(path = '') {
        if (isPresentationDestroyed()) return false;
        const root = document.getElementById('globalSettingsModal');
        return addTypedNetworkPathInput(root, path)
            || window.uiHelperFunctions?.addNetworkPathInput?.(path)
            || false;
    },
    getTypedService() {
        return ensureTypedSettingsService();
    },
    getRustAssistantService() {
        ensureTypedSettingsService();
        return ensureRustAssistantUiService();
    },
    getForumConfigService() {
        ensureTypedSettingsService();
        return ensureForumConfigUiService();
    },
    getAssistantRuntimeService() {
        ensureTypedSettingsService();
        return ensureAssistantRuntimeUiService();
    },
    destroy() {
        if (destroyPromise) return destroyPromise;
        markPresentationDestroyed();
        disposeTypedSettings();
        if (!bridgeScope) {
            document.removeEventListener('modal-visibility-changed', handleModalVisibility);
            document.removeEventListener('modal-ready', handleModalVisibility);
            document.removeEventListener('vcp-settings-surface-updated', handleSurfaceUpdated);
        }
        teardown();
        destroyPromise = bridgeScope?.dispose('settings-bridge-destroyed') || Promise.resolve();
        return destroyPromise;
    },
    get enhancedCount() {
        return enhancedControllerCount();
    }
});
