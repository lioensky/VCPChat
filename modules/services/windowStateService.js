(function installWindowStateService(globalObject, factory) {
    const exported = factory;
    if (typeof module === 'object' && module.exports) module.exports = exported;
    if (!globalObject?.document) return;
    const api = globalObject.chatAPI || globalObject.electronAPI;
    const channels = globalObject.VCPStateChannels;
    if (!api || !channels || globalObject.VCPWindowState) return;
    globalObject.VCPWindowState = factory({ api, channels });
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWindowStateService({ api, channels }) {
    if (!api) throw new TypeError('Window API is required.');
    if (!channels?.create) throw new TypeError('State channel API is required.');

    const freezeState = state => Object.freeze({
        ready: state.ready === true,
        maximized: state.maximized === true,
    });
    const channel = channels.create('main-window', freezeState({ ready: false, maximized: false }));
    let disposed = false;
    const publish = maximized => {
        if (disposed) return channel.getSnapshot();
        const previous = channel.get();
        if (previous.ready && previous.maximized === maximized) return channel.getSnapshot();
        return channel.publish(freezeState({ ready: true, maximized }), {
            source: 'window-api',
            equals: (left, right) => left.ready === right.ready && left.maximized === right.maximized,
        });
    };

    const disposers = [];
    const register = (method, maximized) => {
        const unsubscribe = api[method]?.(() => publish(maximized));
        if (typeof unsubscribe === 'function') disposers.push(unsubscribe);
    };
    register('onWindowMaximized', true);
    register('onWindowUnmaximized', false);

    const service = {
        minimize: () => api.minimizeWindow?.(),
        minimizeToTray: () => api.minimizeToTray?.(),
        maximize: () => api.maximizeWindow?.(),
        unmaximize: () => api.unmaximizeWindow?.(),
        toggleMaximize() {
            return channel.get().maximized ? service.unmaximize() : service.maximize();
        },
        close: () => api.closeWindow?.(),
        getState: () => channel.get(),
        getSnapshot: () => channel.getSnapshot(),
        subscribe: (listener, options) => channel.subscribe(listener, options),
        dispose() {
            if (disposed) return false;
            disposed = true;
            disposers.splice(0).forEach(unsubscribe => unsubscribe());
            channel.dispose();
            return true;
        },
    };
    return Object.freeze(service);
});
