'use strict';

// preloads/api/*.js 的契约测试：注册表可加载、角色可见性、以及使用这些 preload 的窗口都关闭了沙箱。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { describeApis, ROLE_GLOBALS } = require('../preloads/core/registry');

const root = path.resolve(__dirname, '..');
const apis = describeApis();
const byName = new Map(apis.map((api) => [api.name, api]));

function visibleTo(role) {
    return new Set(apis.filter((api) => api.roles.includes(role)).map((api) => api.name));
}

test('注册表加载成功，每个角色都有可见 API', () => {
    assert.ok(apis.length > 0);
    for (const role of Object.keys(ROLE_GLOBALS)) {
        assert.ok(visibleTo(role).size > 0, `角色 ${role} 没有任何可见 API`);
    }
});

test('除本地 API 外，每个条目都声明了 IPC 通道', () => {
    const localOnly = new Set(['getPathForFile']);
    for (const api of apis) {
        if (localOnly.has(api.name)) continue;
        assert.equal(typeof api.channel, 'string', `${api.name} 缺少 channel`);
        assert.ok(api.channel.length > 0, `${api.name} 的 channel 为空`);
    }
});

test('群聊队列中断与 JEV 群聊 API 对 chat 角色可见，且主进程已注册', () => {
    const handlers = fs.readFileSync(path.join(root, 'modules/ipc/groupChatHandlers.js'), 'utf8');
    const chat = visibleTo('chat');
    const contracts = [
        ['interrupt-group-chat-queue', 'interruptGroupChatQueue'],
        ['start-jev-group-chat', 'startJevGroupChat'],
        ['continue-jev-group-chat', 'continueJevGroupChat'],
        ['enqueue-jev-group-agent', 'enqueueJevGroupAgent'],
        ['get-jev-group-chat-state', 'getJevGroupChatState'],
    ];
    for (const [channel, name] of contracts) {
        assert.ok(chat.has(name), `chat 角色缺少 ${name}`);
        assert.equal(byName.get(name).channel, channel);
        assert.equal(byName.get(name).domain, 'groupChat');
        assert.ok(handlers.includes(`ipcMain.handle('${channel}'`), `主进程缺少 ${channel}`);
    }
});

test('主聊天语音 API 对 chat 可见，且不存在私自存盘的录音通道', () => {
    const chat = visibleTo('chat');
    assert.ok(chat.has('startMainChatVoiceInput'));
    assert.ok(chat.has('onMainChatVoiceSessionEnded'));
    assert.ok(!byName.has('saveRecordedAudioFile'));
    assert.ok(!apis.some((api) => api.channel === 'save-recorded-audio-file'));
});

test('置顶 API 只对 utility 可见', () => {
    for (const name of ['togglePinWindow', 'isWindowPinned', 'onWindowPinnedChanged']) {
        assert.deepEqual(byName.get(name).roles, ['utility']);
    }
});

// 使用 chat/utility/desktop preload 的窗口必须 sandbox: false，否则 preload 里的相对 require 会失败，
// 页面上 chatAPI/utilityAPI/desktopAPI 全部缺失。
test('使用角色 preload 的窗口都显式设置了 sandbox: false', () => {
    const files = [
        'main.js',
        'modules/ipc/assistantHandlers.js',
        'modules/ipc/canvasHandlers.js',
        'modules/ipc/desktopHandlers.js',
        'modules/ipc/diceHandlers.js',
        'modules/ipc/fileDialogHandlers.js',
        'modules/ipc/musicHandlers.js',
        'modules/ipc/notesHandlers.js',
        'modules/ipc/ragHandlers.js',
        'modules/ipc/themeHandlers.js',
        'modules/ipc/translatorHandlers.js',
        'modules/ipc/voiceHandlers.js',
        'modules/ipc/windowHandlers.js',
        'modules/services/embeddedAppSessionManager.js',
    ];
    let checked = 0;
    for (const file of files) {
        const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            if (!/preload:.*PRELOAD_ROLES\.(CHAT|UTILITY|DESKTOP)/.test(line)) return;
            checked += 1;
            const block = lines.slice(Math.max(0, index - 6), index + 8).join('\n');
            assert.match(block, /sandbox:\s*false/, `${file}:${index + 1} 使用角色 preload 但没有 sandbox: false`);
        });
    }
    assert.equal(checked, 22, '角色 preload 窗口数量变化，请同步更新本测试的文件清单');
});