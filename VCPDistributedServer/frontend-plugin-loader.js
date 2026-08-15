(() => {
    'use strict';

    if (window.VCPFrontendPlugins?.loaderStarted) return;

    const registry = new Map();
    const pluginScopes = new Map();
    const contributionFacades = new Map();
    const LifecycleScope = window.VCPLifecycle?.LifecycleScope;
    const loaderScope = LifecycleScope ? new LifecycleScope('frontend-plugin-loader') : null;
    let destroyed = false;

    function ensurePluginScope(id) {
        if (!loaderScope || destroyed || !loaderScope.active) return null;
        let scope = pluginScopes.get(id);
        if (!scope || scope.disposed) {
            scope = loaderScope.child(`frontend-plugin:${id}`);
            pluginScopes.set(id, scope);
        }
        return scope;
    }

    function emitChange(id, action, instance) {
        document.dispatchEvent(new CustomEvent(
            action === 'registered' ? 'vcp-frontend-plugin-ready' : 'vcp-frontend-plugin-removed',
            { detail: { id, action, instance } }
        ));
    }

    async function unregister(id, expectedInstance = null, reason = 'unregistered') {
        const instance = registry.get(id);
        const scope = pluginScopes.get(id);
        if (expectedInstance && instance !== expectedInstance) return false;
        if (!instance && !scope) return false;
        if (scope) {
            pluginScopes.delete(id);
            await scope.dispose(reason);
        } else {
            registry.delete(id);
            await instance?.destroy?.();
            emitChange(id, 'unregistered', instance);
        }
        return true;
    }

    const api = {
        loaderStarted: true,
        registry,
        register(id, instance) {
            if (destroyed || !id || registry.has(id)) return false;
            const value = instance || {};
            registry.set(id, value);
            const scope = ensurePluginScope(id);
            if (scope) {
                if (typeof value.destroy === 'function') {
                    scope.own(() => value.destroy(), `plugin-destroy:${id}`, 'plugin-instance');
                }
                scope.own(() => {
                    if (registry.get(id) !== value) return;
                    registry.delete(id);
                    emitChange(id, 'unregistered', value);
                }, `plugin-registration:${id}`, 'ui-registration');
            }
            emitChange(id, 'registered', value);
            return true;
        },
        unregister,
        get(id) {
            return registry.get(id);
        },
        getScope(id) {
            return ensurePluginScope(id);
        },
        getContributions(id) {
            if (destroyed || !id || !window.VCPContributions) return null;
            if (contributionFacades.has(id)) return contributionFacades.get(id);
            const owner = ensurePluginScope(id);
            if (!owner) return null;
            const options = { owner, ownerId: `plugin:${id}` };
            const facade = Object.freeze({
                registerApp: definition => window.VCPContributions.apps.register(definition, options),
                registerCommand: definition => window.VCPContributions.commands.register(definition, options),
                registerMenuItem: definition => window.VCPContributions.menus.register(definition, options),
                registerSettingsEntry: definition => window.VCPContributions.settings.register(definition, options),
            });
            contributionFacades.set(id, facade);
            owner.own(() => contributionFacades.delete(id), `plugin-contributions:${id}`, 'contribution');
            return facade;
        },
        async destroy() {
            if (destroyed) return;
            destroyed = true;
            try {
                if (loaderScope) await loaderScope.dispose('loader-destroyed');
                else {
                    for (const id of [...registry.keys()]) {
                        await unregister(id, null, 'loader-destroyed');
                    }
                }
            } finally {
                registry.clear();
                pluginScopes.clear();
                contributionFacades.clear();
            }
        }
    };

    window.VCPFrontendPlugins = api;

    function loadStyle(plugin) {
        if (destroyed || !plugin.style || document.querySelector(`link[data-vcp-plugin="${plugin.id}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = plugin.style;
        link.dataset.vcpPlugin = plugin.id;
        document.head.appendChild(link);
        ensurePluginScope(plugin.id)?.own(() => link.remove(), `plugin-style:${plugin.id}`, 'style');
    }

    function loadScript(plugin) {
        return new Promise((resolve) => {
            if (destroyed) {
                resolve({ id: plugin.id, loaded: false, cancelled: true });
                return;
            }
            const script = document.createElement('script');
            const pluginScope = ensurePluginScope(plugin.id);
            let settled = false;
            let releaseCancellation = null;
            const finish = result => {
                if (settled) return false;
                settled = true;
                script.onload = null;
                script.onerror = null;
                resolve(result);
                void releaseCancellation?.();
                return true;
            };
            script.src = plugin.script;
            script.defer = true;
            script.dataset.vcpPlugin = plugin.id;
            script.onload = () => finish({ id: plugin.id, loaded: true });
            script.onerror = () => {
                console.error(`[FrontendPlugins] 加载失败: ${plugin.id}`);
                finish({ id: plugin.id, loaded: false });
                void unregister(plugin.id, null, 'script-load-failed')
                    .catch(error => {
                        console.error(`[FrontendPlugins] 清理失败资源: ${plugin.id}`, error);
                    });
            };
            releaseCancellation = pluginScope?.own(() => {
                finish({ id: plugin.id, loaded: false, cancelled: true });
            }, `plugin-script-load:${plugin.id}`, 'task-cancel');
            document.body.appendChild(script);
            pluginScope?.own(() => script.remove(), `plugin-script:${plugin.id}`, 'script');
        });
    }

    async function start() {
        const results = [];
        try {
            const tasks = window.VCPTasks;
            const discoveryTask = window.chatAPI?.listEnabledFrontendPlugins && tasks?.createTask?.({
                id: tasks.createTaskId?.('frontend-plugin-discovery') || `frontend-plugin-discovery:${Date.now()}`,
                start: () => window.chatAPI.listEnabledFrontendPlugins(),
            });
            const response = discoveryTask && loaderScope
                ? await discoveryTask.own(loaderScope, 'frontend-plugin-discovery')
                : await window.chatAPI?.listEnabledFrontendPlugins?.();
            if (destroyed) return;
            const plugins = response?.success && Array.isArray(response.plugins) ? response.plugins : [];
            for (const plugin of plugins) {
                if (destroyed) break;
                loadStyle(plugin);
                results.push(await loadScript(plugin));
            }
        } catch (error) {
            console.error('[FrontendPlugins] 无法读取已启用插件清单。', error);
        }
        if (destroyed) return;
        document.dispatchEvent(new CustomEvent('vcp-frontend-plugins-loaded', {
            detail: { results }
        }));
    }

    if (document.readyState === 'loading') {
        if (loaderScope) loaderScope.listen(document, 'DOMContentLoaded', start, { once: true }, 'plugin-loader-start');
        else document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
    loaderScope?.listen(window, 'pagehide', () => {
        void api.destroy().catch(error => console.error('[FrontendPlugins] 清理失败:', error));
    }, { once: true }, 'plugin-loader-pagehide');
})();
