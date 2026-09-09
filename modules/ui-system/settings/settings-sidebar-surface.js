import { renderAgentSettingsSurface } from '../../settings/schema/sidebar-surfaces.js';

const LifecycleScope = globalThis.window?.VCPLifecycle?.LifecycleScope;

function setViewState(node, mounted) {
    if (!node) return;
    node.hidden = !mounted;
    node.setAttribute('aria-hidden', mounted ? 'false' : 'true');
    node.inert = !mounted;
    node.dataset.settingsMounted = mounted ? 'true' : 'false';
}

export function createSettingsSidebarSurface({ document = globalThis.document, root = document?.getElementById('tabContentSettings'), prompt = document?.getElementById('selectAgentPromptForSettings') } = {}) {
    if (!document || !root) throw new TypeError('Settings sidebar surface requires a settings root.');
    const scope = LifecycleScope ? new LifecycleScope('next:settings-sidebar-surface') : null;
    const views = new Map();
    let activeKind = 'agent';
    let activeId = null;
    // Bootstrap renders the canonical Agent form before renderer.js captures
    // its business references. The first uiManager tab sync closes the panel
    // and performs the physical detach for the inactive initial tab.
    let panelActive = true;
    let generation = 0;
    let disposed = false;

    const detach = node => {
        if (!node?.parentNode) return;
        node.parentNode.removeChild(node);
        setViewState(node, false);
    };

    const attach = node => {
        if (!node || disposed || !panelActive) return;
        if (node.parentNode !== root) root.appendChild(node);
        setViewState(node, true);
    };

    const detachAll = () => {
        views.forEach(detach);
        detach(prompt);
        root.dataset.settingsMountedView = 'none';
    };

    const emitChange = () => {
        const EventCtor = document.defaultView?.CustomEvent || globalThis.CustomEvent;
        root.dispatchEvent(new EventCtor('vcp-settings-view-changed', {
            detail: { kind: activeKind, id: activeId, generation, mounted: panelActive },
            bubbles: true,
        }));
    };

    const show = (kind = 'prompt', { id = null, message = null } = {}) => {
        if (disposed) return { generation, kind: activeKind, id: activeId, disposed: true };
        generation += 1;
        activeKind = kind;
        activeId = id;
        detachAll();
        if (kind === 'prompt') {
            if (prompt) {
                if (message !== null) prompt.textContent = message;
                if (panelActive) attach(prompt);
            }
        } else {
            const node = views.get(kind);
            if (panelActive && node) attach(node);
        }
        root.dataset.settingsActiveView = kind;
        root.dataset.settingsActiveId = id || '';
        emitChange();
        return { generation, kind, id };
    };

    const register = (kind, node) => {
        if (!kind || !node) return () => {};
        const previous = views.get(kind);
        if (previous && previous !== node) detach(previous);
        views.set(kind, node);
        node.classList.add('settings-sidebar-surface-view');
        node.dataset.settingsView = kind;
        if (kind === activeKind && panelActive) attach(node);
        else detach(node);
        return () => {
            if (views.get(kind) !== node) return false;
            views.delete(kind);
            detach(node);
            return true;
        };
    };

    const setPanelActive = active => {
        if (disposed) return;
        const nextPanelActive = Boolean(active);
        if (nextPanelActive !== panelActive) generation += 1;
        panelActive = nextPanelActive;
        root.dataset.settingsPanelActive = panelActive ? 'true' : 'false';
        if (!panelActive) {
            detachAll();
            emitChange();
            return;
        }
        if (activeKind === 'prompt') {
            attach(prompt);
        } else {
            attach(views.get(activeKind));
        }
        emitChange();
    };

    const tokenIsCurrent = token => Boolean(token && !disposed && token.generation === generation && token.kind === activeKind && token.id === activeId);

    const dispose = async reason => {
        if (disposed) return;
        disposed = true;
        generation += 1;
        detachAll();
        views.clear();
        await scope?.dispose(reason || 'settings-sidebar-disposed');
    };

    const api = {
        root,
        schema: { renderAgentSettingsSurface },
        register,
        has: kind => views.has(kind),
        getView: kind => views.get(kind) || null,
        show,
        begin: show,
        isCurrent: tokenIsCurrent,
        setPanelActive,
        getSnapshot: () => Object.freeze({ activeKind, activeId, panelActive, generation, disposed }),
        dispose,
    };
    root.dataset.settingsSurface = 'schema';
    root.dataset.settingsPanelActive = panelActive ? 'true' : 'false';
    return Object.freeze(api);
}

export function ensureSettingsSidebarSurface(options = {}) {
    const existing = globalThis.window?.VCPSettingsSidebar;
    if (existing) return existing;
    const surface = createSettingsSidebarSurface(options);
    if (globalThis.window) globalThis.window.VCPSettingsSidebar = surface;
    return surface;
}
