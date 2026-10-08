'use strict';

/**
 * 群聊发言请求的地址：和单聊一样跟随「VCP 工具注入」设置。
 * 打开时走 /v1/chatvcp/completions，服务端才把完整的工具调用结果写进流里；
 * 否则只有一行「本轮工具调用摘要」，后面的助手看不到工具返回了什么，文件变更等也无从解析。
 */
function resolveGroupChatUrl(vcpUrl, enableVcpToolInjection) {
    if (!vcpUrl || enableVcpToolInjection !== true) return vcpUrl;
    try {
        const url = new URL(vcpUrl);
        url.pathname = '/v1/chatvcp/completions';
        return url.toString();
    } catch {
        return vcpUrl;
    }
}

module.exports = { resolveGroupChatUrl };
