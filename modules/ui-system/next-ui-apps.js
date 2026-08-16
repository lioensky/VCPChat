const apps = window.VCPContributions?.apps;
if (!apps) throw new Error('VCP contribution registry must load before Next UI applications.');

function validate(definition) {
    if (!definition || typeof definition !== 'object') throw new TypeError('App definition is required.');
    if (!definition.id || !/^[a-z0-9-]+$/.test(definition.id)) throw new TypeError('App id must use lowercase letters, numbers, and hyphens.');
    if (!definition.title) throw new TypeError(`App "${definition.id}" requires a title.`);
    if (definition.kind !== 'internal') throw new TypeError(`App "${definition.id}" must use kind "internal".`);
    if (typeof definition.mount !== 'function') throw new TypeError(`App "${definition.id}" requires mount(container, context).`);
}

function unregister(id, expectedApp = null) {
    return apps.unregister(id, expectedApp);
}

function register(definition, options = {}) {
    validate(definition);
    const app = Object.freeze({
        icon: definition.iconSvg ? undefined : 'widgets',
        unmount: () => {},
        ...definition,
    });
    return apps.register(app, options).contribution;
}

function get(id) {
    return apps.get(id);
}

function list() {
    return apps.list();
}

apps.subscribe(change => {
    window.dispatchEvent(new CustomEvent('next-ui-apps-changed', {
        detail: { id: change.id, action: change.action, app: change.contribution }
    }));
});

window.nextUiApps = Object.freeze({ register, unregister, get, list });
window.dispatchEvent(new CustomEvent('next-ui-apps-ready'));

export { get, list, register, unregister };
