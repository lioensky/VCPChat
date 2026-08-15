const apps = new Map();

function validate(definition) {
    if (!definition || typeof definition !== 'object') throw new TypeError('App definition is required.');
    if (!definition.id || !/^[a-z0-9-]+$/.test(definition.id)) throw new TypeError('App id must use lowercase letters, numbers, and hyphens.');
    if (!definition.title) throw new TypeError(`App "${definition.id}" requires a title.`);
    if (definition.kind !== 'internal') throw new TypeError(`App "${definition.id}" must use kind "internal".`);
    if (typeof definition.mount !== 'function') throw new TypeError(`App "${definition.id}" requires mount(container, context).`);
}

function unregister(id, expectedApp = null) {
    const app = apps.get(id);
    if (!app || (expectedApp && app !== expectedApp)) return false;
    apps.delete(id);
    window.dispatchEvent(new CustomEvent('next-ui-apps-changed', {
        detail: { id, action: 'unregistered', app }
    }));
    return true;
}

function register(definition, options = {}) {
    validate(definition);
    if (apps.has(definition.id)) throw new Error(`Next UI app id already registered: ${definition.id}`);
    const app = Object.freeze({
        icon: definition.iconSvg ? undefined : 'widgets',
        unmount: () => {},
        ...definition,
    });
    const owner = options.owner;
    if (owner?.active === false) throw new Error(`Cannot register Next UI app "${app.id}" on an inactive owner.`);
    apps.set(app.id, app);
    try {
        if (owner && typeof owner.own === 'function') {
            owner.own(() => unregister(app.id, app), `next-app:${app.id}`, 'ui-registration');
        }
    } catch (error) {
        apps.delete(app.id);
        throw error;
    }
    window.dispatchEvent(new CustomEvent('next-ui-apps-changed', {
        detail: { id: app.id, action: 'registered', app }
    }));
    return app;
}

function get(id) {
    return apps.get(id) || null;
}

function list() {
    return [...apps.values()];
}

window.nextUiApps = Object.freeze({ register, unregister, get, list });
window.dispatchEvent(new CustomEvent('next-ui-apps-ready'));

export { get, list, register, unregister };
