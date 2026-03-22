/**
 * VCPdesktop - vcpAPI 代理层模块
 * 负责：凭据管理、后端 API 代理 fetch、OpenAI 兼容 chat completion post、widget 脚本安全访问后端
 */

'use strict';

(function () {
    let _vcpCredentials = null; // 缓存凭据（admin API: Basic Auth）
    let _vcpApiCredentials = null; // 缓存凭据（VCP Chat API: Bearer Token）

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

                // 加载 VCP Chat API 凭据（Bearer Token 方式，用于 OpenAI 兼容接口）
                if (result.vcpServerUrl && result.vcpApiKey) {
                    _vcpApiCredentials = {
                        vcpServerUrl: result.vcpServerUrl,
                        vcpApiKey: result.vcpApiKey,
                    };
                    console.log('[VCPdesktop] VCP Chat API credentials loaded');
                } else {
                    console.warn('[VCPdesktop] VCP Chat API credentials not available (vcpServerUrl or vcpApiKey missing)');
                }

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
     * vcpAPI 代理 fetch（Admin API，Basic Auth）
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
     * VCP API Post - 标准 OpenAI 兼容 chat completion 请求
     *
     * 这是一个安全的代理方法：widget 脚本无需知道真实的 URL 和 API Key，
     * 只需传入 messages 数组和可选的模型配置即可完成 AI 请求。
     *
     * @param {Array<{role: string, content: string}>} messages - 消息数组（OpenAI 格式）
     * @param {object} [options] - 可选配置
     * @param {string} [options.model] - 模型名称（如 'gemini-2.5-flash-preview'）
     * @param {number} [options.temperature] - 温度参数（0-2）
     * @param {number} [options.max_tokens] - 最大输出 token 数
     * @param {boolean} [options.stream=false] - 是否使用流式输出（当前仅支持非流式）
     * @returns {Promise<{success: boolean, content?: string, usage?: object, raw?: object, error?: string}>}
     *   - success: 请求是否成功
     *   - content: AI 回复的文本内容（成功时）
     *   - usage: token 使用统计（成功时，如果后端返回）
     *   - raw: 原始响应对象（成功时）
     *   - error: 错误信息（失败时）
     */
    async function vcpPost(messages, options = {}) {
        if (!_vcpApiCredentials) {
            throw new Error('VCP Chat API not initialized - vcpServerUrl or vcpApiKey not available');
        }

        const { model, temperature, max_tokens, ...extraOptions } = options;

        const requestBody = {
            messages: messages,
            stream: false, // widget 场景下默认使用非流式
        };

        // 仅在用户指定时添加可选参数
        if (model) requestBody.model = model;
        if (temperature !== undefined) requestBody.temperature = temperature;
        if (max_tokens !== undefined) requestBody.max_tokens = max_tokens;

        // 合并用户自定义的额外参数
        Object.assign(requestBody, extraOptions);

        try {
            const response = await fetch(_vcpApiCredentials.vcpServerUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${_vcpApiCredentials.vcpApiKey}`,
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                let errorMsg = `HTTP ${response.status}`;
                try {
                    const errorData = await response.json();
                    errorMsg = errorData.error?.message || errorData.message || errorData.error || errorMsg;
                } catch (e) {
                    const errorText = await response.text();
                    if (errorText) errorMsg += ': ' + errorText.substring(0, 200);
                }
                return { success: false, error: errorMsg };
            }

            const data = await response.json();

            // 提取标准 OpenAI 格式的回复内容
            const content = data.choices?.[0]?.message?.content || '';
            const usage = data.usage || null;

            return {
                success: true,
                content: content,
                usage: usage,
                raw: data,
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * 检查凭据是否已加载
     * @returns {boolean}
     */
    function hasCredentials() {
        return _vcpCredentials !== null;
    }

    /**
     * 检查 VCP Chat API 凭据是否已加载
     * @returns {boolean}
     */
    function hasChatCredentials() {
        return _vcpApiCredentials !== null;
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
    window.__vcpProxyPost = vcpPost;

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.vcpApi = {
        init: initVcpApi,
        fetch: proxyFetch,
        post: vcpPost,
        hasCredentials,
        hasChatCredentials,
        getBaseUrl,
    };

})();