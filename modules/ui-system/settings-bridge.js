// settings-bridge — Next UI enhancement bridge for the settings surfaces.
//
// The sidebar settings forms (agent/group) and the global settings modal keep
// their original business DOM, form ids, defaults and IPC; this module only
// layers the VCPUI presentation on top when the mode resolves to next.
//
// Global settings (R5.1): the modal is always rebuilt into a
// SettingsShell-style layout — left rail with a VCPUI-enhanced search field and
// a VCPUI List category navigation, the original form as the content area, and
// the existing footer as the fixed save bar. Its host is independent from the
// home layout, so Classic and Next use the same settings experience.

const controllers = new Set();
const injectedNodes = new Set();
// Per-modal shell state: { layout, nav, listHost, originalNavHtml, meta,
// active, query, list } keyed by the modal root so teardown can restore the
// exact original navigation markup. WeakMap cannot be iterated, so built
// roots are tracked separately.
const shellState = new WeakMap();
const shellRoots = new Set();
// Replaced inline SVGs inside the global form, keyed by container, so teardown
// restores the original Lucide-style paths (classic must not lose them).
const iconReplacements = new Set();
let observer = null;
let refreshQueued = false;

function isNextUi() {
    return document.documentElement.dataset.uiMode === 'next'
        && settingsHost?.dataset.settingsPresentation !== 'classic';
}

function isGlobalSettingsNextUi() {
    // Global settings is the shared settings surface for both home layouts.
    // It must expose the layout selector while Classic is active as well.
    return Boolean(document.getElementById('globalSettingsModal'));
}

function syncGlobalSettingsHost() {
    const modal = document.getElementById('globalSettingsModal');
    const active = Boolean(modal?.classList.contains('active'));
    document.documentElement.classList.toggle('vcp-global-settings-host', active);
    modal?.classList.add('vcp-global-settings-next');
    return modal;
}

function enhance(name, element, options = {}) {
    if (!element || window.VCPUI.getController(element)) return;
    try {
        controllers.add(window.VCPUI.enhance(name, element, options));
    } catch (error) {
        console.warn(`[VCPUI SettingsBridge] Could not enhance ${name}:`, error);
    }
}

function enhanceForm(form) {
    form.querySelectorAll('.agent-settings-section, .group-settings-section').forEach(section => {
        enhance('SettingsSection', section);
    });
    form.querySelectorAll('input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])').forEach(input => {
        enhance('Input', input);
    });
    form.querySelectorAll('textarea').forEach(textarea => enhance('Textarea', textarea));
    form.querySelectorAll('select').forEach(select => enhance('Select', select));
    form.querySelectorAll('input[type="range"]').forEach(range => enhance('Range', range));
    form.querySelectorAll('label.switch').forEach(control => enhance('Switch', control));
    form.querySelectorAll('.agent-name-wrapper, .group-name-wrapper, .group-settings-field-shell, .style-control-item, .params-content > div:not(.form-group-inline)').forEach(field => {
        if (field.querySelector('input:not([type="hidden"]), select, textarea')) enhance('Field', field);
    });
    form.querySelectorAll(':scope > .form-actions').forEach(actionBar => {
        enhance('SettingsActionBar', actionBar, { form });
    });
}

// Lucide icon names for the global settings categories. Icons are always
// rendered through VCPUI (`.vcp-ui-icon` -> lucide-adapter); no inline SVG,
// emoji or text arrows on this surface in next mode.
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

// Global settings modal: control enhancement, VCP save bar on the footer and a
// SettingsShell-style layout (search + category List in the left rail).
function enhanceGlobalSettings(root, form) {
    form.querySelectorAll('input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])').forEach(input => {
        enhance('Input', input);
    });
    form.querySelectorAll('textarea').forEach(textarea => enhance('Textarea', textarea));
    form.querySelectorAll('select').forEach(select => enhance('Select', select));
    form.querySelectorAll('input[type="range"]').forEach(range => enhance('Range', range));
    form.querySelectorAll('label.switch').forEach(control => enhance('Switch', control));
    form.querySelectorAll('.agent-name-wrapper').forEach(field => {
        if (field.querySelector('input:not([type="hidden"]), select, textarea')) enhance('Field', field);
    });
    const footer = root.querySelector('.global-settings-footer');
    if (footer) enhance('SettingsActionBar', footer, { form });
    mountSettingsShell(root);
    normalizeFormIcons(root);
}

// Replaces the handful of hand-inlined Lucide paths inside the global form
// with VCPUI icon nodes (rendered by lucide-adapter in next mode). Originals
// are kept so classic mode and teardown can restore them exactly.
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
        replaced.push({ container, original: svg, icon });
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

// SettingsShell build: replaces the legacy <ul> category nav with a VCPUI List
// and pins a VCPUI-enhanced search above it. The original form sections are the
// content area; switching categories only toggles the `active` class so
// unsaved values in hidden sections stay in the DOM.
function mountSettingsShell(root) {
    if (root.querySelector('.vcp-ui-settings-shell')) return;
    const layout = root.querySelector('.global-settings-layout');
    const nav = root.querySelector('.global-settings-nav');
    const listHost = nav?.querySelector('.settings-nav-list');
    if (!layout || !nav || !listHost) {
        mountLegacySearch(root);
        return;
    }

    const meta = [...listHost.querySelectorAll('.settings-nav-item')].map(item => ({
        value: item.dataset.section,
        label: (item.querySelector('span')?.textContent || '').trim() || item.textContent.trim(),
        icon: GLOBAL_CATEGORY_ICONS[item.dataset.section] || 'circle',
        selected: item.classList.contains('active'),
    }));
    const initial = meta.find(item => item.selected)?.value || meta[0]?.value;
    if (!initial || !document.getElementById(`section-${initial}`)) {
        mountLegacySearch(root);
        return;
    }

    const state = {
        layout,
        nav,
        listHost,
        originalNavHtml: listHost.innerHTML,
        meta,
        active: initial,
        query: '',
        list: null,
    };
    shellState.set(root, state);
    shellRoots.add(root);
    layout.classList.add('vcp-ui-settings-shell');

    const sectionText = (value) => document.getElementById(`section-${value}`)?.textContent.toLowerCase() || '';
    const visibleItems = () => {
        const q = state.query.trim().toLowerCase();
        if (!q) return state.meta;
        return state.meta.filter(item =>
            item.label.toLowerCase().includes(q) || sectionText(item.value).includes(q)
        );
    };

    const renderList = () => {
        const items = visibleItems().map(item => ({
            icon: item.icon,
            label: item.label,
            selected: item.value === state.active,
            onClick: () => activateSection(item.value),
        }));
        if (state.list) state.list.update({ items });
        else {
            state.list = window.VCPUI.create('List', { items });
            state.listHost.replaceChildren(state.list.element);
        }
    };

    const activateSection = (value) => {
        if (value === state.active) return;
        root.querySelectorAll('.settings-section').forEach(section => {
            section.classList.remove('active', 'switching-out', 'switching-in');
        });
        const target = document.getElementById(`section-${value}`);
        if (target) target.classList.add('active');
        state.active = value;
        renderList();
    };

    const onQuery = (query) => {
        state.query = query;
        renderList();
        if (query.trim()) {
            const first = visibleItems().find(item => item.value !== state.active) || visibleItems()[0];
            if (first) activateSection(first.value);
        }
    };

    // VCPUI-enhanced search field, pinned to the top of the left rail.
    const search = document.createElement('div');
    search.className = 'vcp-ui-settings-search';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'vcp-ui-icon';
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.textContent = 'search';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = '搜索设置项';
    searchInput.setAttribute('aria-label', '搜索设置项');
    search.append(searchIcon, searchInput);
    enhance('Input', searchInput);
    nav.prepend(search);
    injectedNodes.add(search);
    searchInput.addEventListener('input', () => onQuery(searchInput.value));

    renderList();
}

// Legacy fallback used only when the modal has no category nav (kept for the
// contract fixture and defensive coverage): injects the search into the content
// column and filters `.settings-nav-item` nodes by hiding them.
function mountLegacySearch(root) {
    const content = root.querySelector('.global-settings-content');
    const navItems = [...root.querySelectorAll('.settings-nav-item')];
    if (!content || content.querySelector('.vcp-ui-settings-search')) return;

    const search = document.createElement('div');
    search.className = 'vcp-ui-settings-search';
    const icon = document.createElement('span');
    icon.className = 'vcp-ui-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'search';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = '搜索设置项';
    input.setAttribute('aria-label', '搜索设置项');
    search.append(icon, input);
    content.prepend(search);
    injectedNodes.add(search);

    input.addEventListener('input', () => {
        const query = input.value.trim().toLowerCase();
        navItems.forEach(item => {
            const section = root.querySelector(`#section-${item.dataset.section}`);
            const hit = !query
                || (section && section.textContent.toLowerCase().includes(query))
                || item.textContent.toLowerCase().includes(query);
            item.hidden = !hit;
        });
        if (query) {
            const firstVisible = navItems.find(item => !item.hidden);
            if (firstVisible) firstVisible.click();
        }
    });
}

function cleanupDisconnectedControllers() {
    [...controllers].forEach(controller => {
        if (controller.element.isConnected) return;
        controller.destroy();
        controllers.delete(controller);
    });
}

function refresh() {
    refreshQueued = false;
    cleanupDisconnectedControllers();
    const globalSettingsModal = syncGlobalSettingsHost();
    if (isNextUi()) {
        document.querySelectorAll('#agentSettingsForm, #groupSettingsForm').forEach(enhanceForm);
    }
    if (isGlobalSettingsNextUi()) {
        const form = globalSettingsModal?.querySelector('#globalSettingsForm');
        if (globalSettingsModal && form) enhanceGlobalSettings(globalSettingsModal, form);
    }
}

function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(refresh);
}

function teardown() {
    [...controllers].reverse().forEach(controller => controller.destroy());
    controllers.clear();
    injectedNodes.forEach(node => node.remove());
    injectedNodes.clear();
    [...shellRoots].forEach(root => {
        const state = shellState.get(root);
        if (!state) return;
        state.layout.classList.remove('vcp-ui-settings-shell');
        state.list?.destroy();
        state.listHost.innerHTML = state.originalNavHtml;
        shellState.delete(root);
    });
    shellRoots.clear();
    document.querySelectorAll('#globalSettingsModal[data-vcp-settings-icons-normalized]').forEach(restoreFormIcons);
    document.documentElement.classList.remove('vcp-global-settings-host');
}

function syncMode() {
    teardown();
    scheduleRefresh();
}

observer = new window.MutationObserver(scheduleRefresh);
const settingsHost = document.getElementById('tabContentSettings');
if (settingsHost) observer.observe(settingsHost, { childList: true, subtree: true });
const modalContainer = document.getElementById('modal-container');
if (modalContainer) observer.observe(modalContainer, { childList: true, subtree: true });
window.addEventListener('ui-mode-changed', syncMode);
const handleModalVisibility = event => {
    if (event.detail?.modalId === 'globalSettingsModal') scheduleRefresh();
};
document.addEventListener('modal-visibility-changed', handleModalVisibility);
syncMode();

window.VCPUISettingsBridge = Object.freeze({
    refresh: scheduleRefresh,
    destroy() {
        observer?.disconnect();
        observer = null;
        window.removeEventListener('ui-mode-changed', syncMode);
        document.removeEventListener('modal-visibility-changed', handleModalVisibility);
        teardown();
    },
    get enhancedCount() {
        return controllers.size;
    }
});
