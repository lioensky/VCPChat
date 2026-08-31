/**
 * A deliberately local service assembly. The registry owns one child scope;
 * it is not a global plugin container and cannot outlive its surface owner.
 */
export function createUiServiceRegistry(parentScope) {
    if (!parentScope?.active)
        throw new Error('UiServiceRegistry requires an active UiScope.');
    const scope = parentScope.child('ui-services');
    const services = new Map();
    const releases = new Map();
    let disposed = false;
    let disposePromise = null;
    // Registered before services so child teardown releases services first,
    // then invalidates the registry view exposed to late consumers.
    scope.own(() => {
        disposed = true;
        services.clear();
        releases.clear();
    }, 'service-registry-state', 'ui-registry');
    const context = () => Object.freeze({
        scope,
        services: Object.freeze(Object.fromEntries(services)),
    });
    const install = (definition, provider) => {
        if (disposed || !scope.active)
            throw new Error('UiServiceRegistry is disposed.');
        if (!definition?.id || typeof definition.provide !== 'function')
            throw new TypeError('Invalid UI service definition.');
        if (services.has(definition.id))
            throw new Error(`UI service already installed: ${definition.id}`);
        const service = (provider || definition.provide)(context());
        if (service == null)
            throw new Error(`UI service provider returned no service: ${definition.id}`);
        services.set(definition.id, service);
        try {
            const release = scope.own(() => service.dispose?.(), `service:${definition.id}`, 'ui-service');
            releases.set(definition.id, release);
            return service;
        }
        catch (error) {
            services.delete(definition.id);
            Promise.resolve(service.dispose?.()).catch(() => { });
            throw error;
        }
    };
    const uninstall = async (id) => {
        const release = releases.get(id);
        if (!release)
            return;
        services.delete(id);
        releases.delete(id);
        await release();
    };
    return Object.freeze({
        install,
        get: (id) => services.get(id),
        uninstall,
        release: uninstall,
        async dispose(reason = 'ui-service-registry-disposed') {
            if (disposePromise)
                return disposePromise;
            disposed = true;
            services.clear();
            releases.clear();
            disposePromise = scope.dispose(reason);
            await disposePromise;
        },
    });
}
