/** Owns DOM event registrations for one renderer lifecycle and removes them on dispose. */
export function createDomListenerOwner({ reportError = console.error } = {}) {
    // 已经结束的登记（触发过的定时器、触发过的 once 监听）要及时删掉：
    // 主窗口的 owner 活一整个会话，只增不减会把每条通知的浮卡和回调都留在内存里
    const registrations = new Set();
    let disposed = false;
    let capturingOwned = false;
    const add = (target, type, handler, options) => {
        if (disposed || !target?.addEventListener || typeof handler !== 'function') return false;
        let remove = null;
        const listener = options?.once === true
            ? function onceListener(...args) { registrations.delete(remove); return handler.apply(this, args); }
            : handler;
        capturingOwned = true;
        try { target.addEventListener(type, listener, options); } finally { capturingOwned = false; }
        remove = () => target.removeEventListener?.(type, listener, options);
        registrations.add(remove);
        return true;
    };
    const own = resource => {
        if (disposed || !resource) return resource;
        const dispose = typeof resource === 'function' ? resource : (resource.disconnect || resource.dispose || resource.abort);
        if (typeof dispose === 'function') registrations.add(() => dispose.call(resource));
        return resource;
    };
    const timeout = (callback, delay) => {
        if (disposed || typeof callback !== 'function') return null;
        let remove = null;
        const handle = setTimeout(() => {
            registrations.delete(remove);
            if (!disposed) callback();
        }, delay);
        remove = timerCanceller(handle);
        registrations.add(remove);
        return handle;
    };
    const capture = () => {
        if (disposed || typeof EventTarget === 'undefined') return () => {};
        const originalAdd = EventTarget.prototype.addEventListener;
        const originalRemove = EventTarget.prototype.removeEventListener;
        const owner = EventTarget.prototype;
        owner.addEventListener = function(type, handler, options) {
            if (!capturingOwned && typeof handler === 'function') {
                registrations.add(() => originalRemove.call(this, type, handler, options));
            }
            return originalAdd.call(this, type, handler, options);
        };
        return () => { owner.addEventListener = originalAdd; };
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        const pending = [...registrations].reverse();
        registrations.clear();
        for (const remove of pending) {
            try { remove(); } catch (error) { reportError('[DomListenerOwner] remove failed', error); }
        }
    };
    const size = () => registrations.size;
    return Object.freeze({ add, own, timeout, capture, dispose, size });
}

// 在独立作用域里建取消函数：和回调同一个闭包的话，外部直接 clearTimeout 掉的定时器
// 会让这条登记连同回调（和回调引用的 DOM）一起留到 owner 销毁
function timerCanceller(handle) {
    return () => clearTimeout(handle);
}
