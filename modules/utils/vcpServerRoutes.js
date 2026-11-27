'use strict';

(function (factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else globalThis.vcpServerRoutes = factory();
})(function () {
    const paths = Object.freeze({
        chat: '/v1/chat/completions',
        chatWithTools: '/v1/chatvcp/completions',
        models: '/v1/models',
        interrupt: '/v1/interrupt',
        humanTool: '/v1/human/tool',
        weather: '/admin_api/weather',
    });

    // The global VCP setting denotes an HTTP origin, never an API endpoint.
    // Accept past path-bearing values and bare host[:port] during migration.
    function normalizeVcpServerUrl(value) {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw || /^[/?#]/.test(raw) || /[\s\\]/.test(raw)) return '';
        const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
        if (!absolute && /^[a-z][a-z\d+.-]*:(?!\d+(?:[/?#]|$))/i.test(raw)) return '';
        const candidate = absolute ? raw : `http://${raw}`;
        try {
            const url = new URL(candidate);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
            return url.origin;
        } catch {
            return '';
        }
    }

    function vcpServerEndpoint(value, route) {
        const origin = normalizeVcpServerUrl(value);
        if (!origin) throw new TypeError('VCP 服务器地址必须是有效的 HTTP(S) URL');
        if (!Object.hasOwn(paths, route)) throw new TypeError(`Unknown VCP route: ${route}`);
        return origin + paths[route];
    }

    function vcpChatUrl(value, enableVcpToolInjection) {
        return vcpServerEndpoint(value, enableVcpToolInjection === true ? 'chatWithTools' : 'chat');
    }

    // Keep response handling with the caller: search parses results, writers only need status.
    function postHumanTool(settings, name, args, { signal } = {}) {
        const { vcpServerUrl, vcpApiKey } = settings ?? {};
        if (!vcpApiKey) throw new Error('API Key 未配置');
        return fetch(vcpServerEndpoint(vcpServerUrl, 'humanTool'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${vcpApiKey}`
            },
            body: JSON.stringify({ name, arguments: args }),
            signal
        });
    }

    return Object.freeze({ normalizeVcpServerUrl, vcpServerEndpoint, vcpChatUrl, postHumanTool });
});