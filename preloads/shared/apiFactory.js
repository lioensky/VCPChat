const { contextBridge, ipcRenderer } = require('electron');

function command(value) {
    return { kind: 'command', value };
}

function query(value) {
    return { kind: 'query', value };
}

function subscription(value) {
    return { kind: 'subscription', value };
}

function createOps() {
    const subscribeIpc = (channel, callback, mapper = (_event, ...args) => args) => {
        const listener = (event, ...args) => {
            const mapped = mapper(event, ...args);
            if (Array.isArray(mapped)) {
                callback(...mapped);
                return;
            }
            callback(mapped);
        };

        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    };

    return {
        invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
        send: (channel, ...args) => ipcRenderer.send(channel, ...args),
        subscribe: (channel, mapper) => (callback) => subscribeIpc(channel, callback, mapper),
        pathApi: {
            dirname: (filePath) => ipcRenderer.invoke('path:dirname', filePath),
            extname: (filePath) => ipcRenderer.invoke('path:extname', filePath),
            basename: (filePath) => ipcRenderer.invoke('path:basename', filePath),
        },
    };
}

function materializeApi(definitions, keys) {
    return keys.reduce((api, key) => {
        if (definitions[key]) {
            api[key] = definitions[key].value;
        }
        return api;
    }, {});
}

function createIsolationMessage(name) {
    return `权限已隔离: ${name}`;
}

function createIsolationStub(name, kind) {
    const message = createIsolationMessage(name);

    if (kind === 'subscription') {
        return () => {
            console.error(message);
            return () => {};
        };
    }

    if (kind === 'query') {
        return () => {
            console.error(message);
            return Promise.reject(new Error(message));
        };
    }

    return () => {
        console.error(message);
    };
}

function createCompatApi(definitions, allowedKeys) {
    const compatApi = {};
    const allowedKeySet = new Set(allowedKeys);

    for (const [key, definition] of Object.entries(definitions)) {
        compatApi[key] = allowedKeySet.has(key)
            ? definition.value
            : createIsolationStub(key, definition.kind);
    }

    return compatApi;
}

function exposeRoleApis(roleApiName, roleApi, compatApi, ops) {
    contextBridge.exposeInMainWorld('electronPath', ops.pathApi);
    contextBridge.exposeInMainWorld(roleApiName, roleApi);
    contextBridge.exposeInMainWorld('electronAPI', compatApi);
}

module.exports = {
    command,
    query,
    subscription,
    createOps,
    materializeApi,
    createCompatApi,
    exposeRoleApis,
};
