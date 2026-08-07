const apps = new Map();

function validate(definition) {
    if (!definition || typeof definition !== 'object') throw new TypeError('App definition is required.');
    if (!definition.id || !/^[a-z0-9-]+$/.test(definition.id)) throw new TypeError('App id must use lowercase letters, numbers, and hyphens.');
    if (!definition.title) throw new TypeError(`App "${definition.id}" requires a title.`);
    if (definition.kind !== 'internal') throw new TypeError(`App "${definition.id}" must use kind "internal".`);
    if (typeof definition.mount !== 'function') throw new TypeError(`App "${definition.id}" requires mount(container, context).`);
}

function register(definition) {
    validate(definition);
    if (apps.has(definition.id)) throw new Error(`Next UI app id already registered: ${definition.id}`);
    const app = Object.freeze({
        icon: definition.iconSvg ? undefined : 'widgets',
        unmount: () => {},
        ...definition,
    });
    apps.set(app.id, app);
    window.dispatchEvent(new CustomEvent('next-ui-apps-changed', { detail: { id: app.id } }));
    return app;
}

function get(id) {
    return apps.get(id) || null;
}

function list() {
    return [...apps.values()];
}

window.nextUiApps = Object.freeze({ register, get, list });
window.dispatchEvent(new CustomEvent('next-ui-apps-ready'));

export { get, list, register };
