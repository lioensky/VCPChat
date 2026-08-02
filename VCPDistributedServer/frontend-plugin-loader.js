(() => {
    'use strict';

    if (window.VCPFrontendPlugins?.loaderStarted) return;

    const registry = new Map();
    const api = {
        loaderStarted: true,
        registry,
        register(id, instance) {
            if (!id || registry.has(id)) return false;
            registry.set(id, instance || {});
            document.dispatchEvent(new CustomEvent('vcp-frontend-plugin-ready', {
                detail: { id, instance: instance || {} }
            }));
            return true;
        },
        get(id) {
            return registry.get(id);
        }
    };

    window.VCPFrontendPlugins = api;

    function loadStyle(plugin) {
        if (!plugin.style || document.querySelector(`link[data-vcp-plugin="${plugin.id}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = plugin.style;
        link.dataset.vcpPlugin = plugin.id;
        document.head.appendChild(link);
    }

    function loadScript(plugin) {
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = plugin.script;
            script.defer = true;
            script.dataset.vcpPlugin = plugin.id;
            script.onload = () => resolve({ id: plugin.id, loaded: true });
            script.onerror = () => {
                console.error(`[FrontendPlugins] 加载失败: ${plugin.id}`);
                resolve({ id: plugin.id, loaded: false });
            };
            document.body.appendChild(script);
        });
    }

    async function start() {
        const results = [];
        try {
            const response = await window.chatAPI?.listEnabledFrontendPlugins?.();
            const plugins = response?.success && Array.isArray(response.plugins) ? response.plugins : [];
            for (const plugin of plugins) {
                loadStyle(plugin);
                results.push(await loadScript(plugin));
            }
        } catch (error) {
            console.error('[FrontendPlugins] 无法读取已启用插件清单。', error);
        }
        document.dispatchEvent(new CustomEvent('vcp-frontend-plugins-loaded', {
            detail: { results }
        }));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
