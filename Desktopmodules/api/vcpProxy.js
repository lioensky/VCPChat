/**
 * VCPdesktop - vcpAPI 代理层模块
 * 负责：凭据管理、后端 API 代理 fetch、widget 脚本安全访问后端
 */

'use strict';

(function () {
    let _vcpCredentials = null; // 缓存凭据

    /**
     * 初始化 vcpAPI 凭据
     * @returns {Promise<boolean>} 是否初始化成功
     */
    async function initVcpApi() {
        if (!window.electronAPI?.desktopGetCredentials) {
            console.warn('[VCPdesktop] desktopGetCredentials not available');
            return false;
        }
        try {
            const result = await window.electronAPI.desktopGetCredentials();
            if (result?.success && result.apiBaseUrl) {
                _vcpCredentials = {
                    apiBaseUrl: result.apiBaseUrl,
                    auth: btoa(result.username + ':' + result.password),
                };
                console.log('[VCPdesktop] vcpAPI credentials loaded, base:', _vcpCredentials.apiBaseUrl);
                return true;
            } else {
                console.warn('[VCPdesktop] vcpAPI credentials not available');
                return false;
            }
        } catch (err) {
            console.error('[VCPdesktop] Failed to load vcpAPI credentials:', err);
            return false;
        }
    }

    /**
     * vcpAPI 代理 fetch
     * widget 脚本中通过 vcpAPI.fetch('/admin_api/weather') 调用
     * @param {string} endpoint - API 端点路径
     * @param {object} [options] - fetch 选项
     * @returns {Promise<any>} JSON 响应
     */
    async function proxyFetch(endpoint, options = {}) {
        if (!_vcpCredentials) {
            throw new Error('vcpAPI not initialized - credentials not available');
        }
        const url = _vcpCredentials.apiBaseUrl + endpoint;
        const response = await fetch(url, {
            ...options,
            headers: {
                'Authorization': `Basic ${_vcpCredentials.auth}`,
                ...(options.headers || {}),
            },
        });
        return response.json();
    }

    /**
     * 检查凭据是否已加载
     * @returns {boolean}
     */
    function hasCredentials() {
        return _vcpCredentials !== null;
    }

    /**
     * 获取 API 基础 URL
     * @returns {string|null}
     */
    function getBaseUrl() {
        return _vcpCredentials?.apiBaseUrl || null;
    }

    // 挂载全局代理函数供 widget 脚本沙箱内调用
    window.__vcpProxyFetch = proxyFetch;

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.vcpApi = {
        init: initVcpApi,
        fetch: proxyFetch,
        hasCredentials,
        getBaseUrl,
    };

})();