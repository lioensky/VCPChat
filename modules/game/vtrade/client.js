'use strict';

// VTrade 对决 lives in the VTrade plugin on VCPToolBox. VChat reaches its authenticated page interface
// (/admin_api/vtrade/api/duel) with the administrator account VChat already keeps for admin pages: the server
// address from AppData/settings.json and the account from AppData/UserData/forum.config.json, the same source as
// the desktop widgets. Agent tool calls cannot reach this interface, so decision tickets only come through here.
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const PAGE = '/admin_api/vtrade/duel/';
const API = '/admin_api/vtrade/api/duel';

async function readCredentials(root = ROOT) {
    const read = async file => {
        try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; }
    };
    const settings = await read(path.join(root, 'AppData', 'settings.json'));
    const account = await read(path.join(root, 'AppData', 'UserData', 'forum.config.json'));
    let origin = '';
    try { origin = new URL(settings.vcpServerUrl).origin; } catch { /* not configured */ }
    return { origin, username: account.username || '', password: account.password || '' };
}

class VTradeError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

class VTradeClient {
    constructor({ credentials = readCredentials, fetchImpl = (...args) => fetch(...args), timeoutMs = 30000 } = {}) {
        Object.assign(this, { credentials, fetchImpl, timeoutMs });
    }
    async account() {
        const { origin, username, password } = await this.credentials();
        if (!origin) throw new VTradeError('NOT_CONFIGURED', '尚未设置 VCP 服务器地址。');
        if (!username || !password) {
            throw new VTradeError('NO_ADMIN_ACCOUNT', 'VTrade 对决需要 VCP 管理员账号：请先在论坛模块登录一次（与桌面挂件使用同一账号）。');
        }
        return { origin, authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
    }
    // The page address. The Agents the page offers come from syncRoster on the orchestrator, not from the address.
    async pageUrl() {
        const { origin, authorization } = await this.account();
        return { url: new URL(PAGE, origin).toString(), origin, authorization };
    }
    async duel(action, input = {}) {
        const { origin, authorization } = await this.account();
        let response;
        try {
            response = await this.fetchImpl(new URL(API, origin), { method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', Authorization: authorization },
                body: JSON.stringify({ action, ...input }), signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (error) {
            throw new VTradeError('NETWORK', `无法连接 VCP 服务器：${error.message}`);
        }
        if (response.status === 401) throw new VTradeError('UNAUTHORIZED', 'VCP 管理员账号无效，请在论坛模块重新登录。');
        if (response.status === 404) throw new VTradeError('PLUGIN_MISSING', 'VCP 服务器上没有启用 VTrade 插件。');
        let body;
        try { body = await response.json(); } catch { throw new VTradeError('BAD_RESPONSE', 'VTrade 没有返回可识别的结果。'); }
        if (!body.ok) throw new VTradeError(body.code || 'FAILED', body.error || 'VTrade 操作失败。');
        return body;
    }
}

module.exports = { VTradeClient, VTradeError, readCredentials };
