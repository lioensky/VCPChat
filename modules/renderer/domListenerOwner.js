/** Owns DOM event registrations for one renderer lifecycle and removes them on dispose. */
export function createDomListenerOwner({ reportError = console.error } = {}) {
    const registrations = [];
    let disposed = false;
    let capturingOwned = false;
    const add = (target, type, handler, options) => {
        if (disposed || !target?.addEventListener || typeof handler !== 'function') return false;
        capturingOwned = true;
        try { target.addEventListener(type, handler, options); } finally { capturingOwned = false; }
        registrations.push(() => target.removeEventListener?.(type, handler, options));
        return true;
    };
    const own = resource => {
        if (disposed || !resource) return resource;
        const dispose = typeof resource === 'function' ? resource : (resource.disconnect || resource.dispose || resource.abort);
        if (typeof dispose === 'function') registrations.push(() => dispose.call(resource));
        return resource;
    };
    const timeout = (callback, delay) => {
        if (disposed || typeof callback !== 'function') return null;
        const handle = setTimeout(() => { if (!disposed) callback(); }, delay);
        registrations.push(() => clearTimeout(handle));
        return handle;
    };
    const capture = () => {
        if (disposed || typeof EventTarget === 'undefined') return () => {};
        const originalAdd = EventTarget.prototype.addEventListener;
        const originalRemove = EventTarget.prototype.removeEventListener;
        const owner = EventTarget.prototype;
        owner.addEventListener = function(type, handler, options) {
            if (!capturingOwned && typeof handler === 'function') {
                registrations.push(() => originalRemove.call(this, type, handler, options));
            }
            return originalAdd.call(this, type, handler, options);
        };
        return () => { owner.addEventListener = originalAdd; };
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const remove of registrations.splice(0).reverse()) {
            try { remove(); } catch (error) { reportError('[DomListenerOwner] remove failed', error); }
        }
    };
    return Object.freeze({ add, own, timeout, capture, dispose });
}
