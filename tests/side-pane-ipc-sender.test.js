'use strict';

// 侧栏相关 IPC 的调用方窗口策略（modules/ipc/sidePaneIpcPolicy.js）：chat / utility preload 会装进很多窗口，
// 表里每个通道都要在注册层拦住其它窗口和 webview，main.js 的每个侧栏领域都要走这张表。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describeApis } = require('../preloads/core/registry.js');
const { SIDE_PANE_IPC_POLICY, createSidePaneSenderGuard, guardIpcMain } = require('../modules/ipc/sidePaneIpcPolicy');
const { createDomainActivator } = require('../modules/ipc/domainActivator');
const { createTrustedMainSender } = require('./helpers/trusted-main-sender.cjs');

const main = createTrustedMainSender();
const forge = createTrustedMainSender('ProjectForgemodules/projectforge.html');
// 带 utility / chat preload 的其它应用窗口
const otherWindow = createTrustedMainSender('Forummodules/forum.html');
const guestPage = createTrustedMainSender();
guestPage.sender.getType = () => 'webview';
const subframe = createTrustedMainSender();
subframe.event = { sender: subframe.sender, senderFrame: { url: subframe.sender.mainFrame.url, detached: false } };

const apis = describeApis().filter(api => api.kind !== 'subscription');
const channelsOf = domain => [...new Set(apis.filter(api => api.domain === domain).map(api => api.channel))];

function fakeIpcMain() {
    const handlers = new Map();
    return { handlers, handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) };
}

for (const [domain, policy] of Object.entries(SIDE_PANE_IPC_POLICY)) {
    test(`${domain}: every channel rejects other windows, webviews and subframes before reaching its handler`, async () => {
        const channels = channelsOf(domain);
        assert.ok(channels.length, `preload domain ${domain} has channels`);
        const open = new Set(policy.open || []);
        const allow = createSidePaneSenderGuard(domain, () => main.mainWindow);
        const ipc = fakeIpcMain();
        const reached = [];
        const guarded = guardIpcMain(ipc, allow);
        // 领域激活器这条路径也查一遍：拒绝时连领域都不加载
        const activatorIpc = fakeIpcMain();
        let loaded = false;
        createDomainActivator({ ipcMain: activatorIpc, logger: { error() {} } }).register(domain, {
            channels, allowSender: allow,
            load: () => { loaded = true; return {}; },
            init: (_mod, { ipcMain: domainIpc }) => channels.forEach(channel => domainIpc.handle(channel, () => ({ success: true }))),
        });
        for (const channel of channels) guarded.handle(channel, () => { reached.push(channel); return { success: true }; });
        for (const channel of channels) {
            for (const caller of [otherWindow, guestPage, subframe]) {
                const direct = await ipc.handlers.get(channel)(caller.event);
                const viaActivator = await activatorIpc.handlers.get(channel)(caller.event);
                if (open.has(channel)) {
                    assert.equal(direct.success, true, `${channel} is read-only and open`);
                } else {
                    assert.equal(direct.success, false, `${channel} must reject ${caller.sender.getURL()}`);
                    assert.equal(viaActivator.success, false, `${channel} via activator`);
                }
            }
        }
        assert.deepEqual(reached.filter(channel => !open.has(channel)), []);
        if (!open.size) assert.equal(loaded, false, 'a rejected call must not load the domain');
        for (const channel of channels) {
            assert.equal((await ipc.handlers.get(channel)(main.event)).success, true, `${channel} from the main window`);
        }
        if (policy.pages.includes('ProjectForgemodules/projectforge.html')) {
            assert.equal((await ipc.handlers.get(channels[0])(forge.event)).success, true, 'the ProjectForge window');
        }
    });
}

test('main.js puts every side pane domain behind the policy', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    for (const domain of Object.keys(SIDE_PANE_IPC_POLICY)) {
        assert.match(source, new RegExp(`sidePaneGuard\\('${domain}'\\)`), domain);
    }
    // 领域激活器登记的每个领域都必须带 allowSender
    const registrations = source.split('domainActivator.register(').slice(1);
    assert.ok(registrations.length >= 5);
    for (const block of registrations) {
        const name = /^'([^']+)'/.exec(block)[1];
        const body = block.slice(0, block.indexOf('});'));
        assert.match(body, /allowSender: sidePaneGuard\(/, `domain ${name} registered without allowSender`);
    }
    for (const init of ['workspaceHandlers.initialize(', 'projectForgeHandlers.initialize(', 'sourceHandlers.initialize(']) {
        const line = source.slice(source.indexOf(init)).split('\n')[0];
        assert.match(line, /ipcMain: guardIpcMain\(ipcMain, sidePaneGuard\(/, init);
    }
});
