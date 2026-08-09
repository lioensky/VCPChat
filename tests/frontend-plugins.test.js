const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');

function readPlugin(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function createRegistry(window) {
    const registry = new Map();
    window.VCPFrontendPlugins = {
        registry,
        get: (id) => registry.get(id),
        register: (id, instance) => {
            registry.set(id, instance);
            return true;
        }
    };
    return registry;
}

function prepareMedia(window) {
    window.HTMLMediaElement.prototype.load = () => {};
    window.HTMLMediaElement.prototype.play = async () => {};
    window.HTMLMediaElement.prototype.pause = () => {};
}

function prepareStatefulMedia(window) {
    const mediaState = new WeakMap();
    const getState = (media) => {
        if (!mediaState.has(media)) mediaState.set(media, { paused: true, playCalls: 0, pauseCalls: 0 });
        return mediaState.get(media);
    };
    Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get() {
            return getState(this).paused;
        }
    });
    window.HTMLMediaElement.prototype.load = () => {};
    window.HTMLMediaElement.prototype.play = async function play() {
        const current = getState(this);
        current.paused = false;
        current.playCalls += 1;
        this.dispatchEvent(new window.Event('play'));
    };
    window.HTMLMediaElement.prototype.pause = function pause() {
        const current = getState(this);
        current.paused = true;
        current.pauseCalls += 1;
        this.dispatchEvent(new window.Event('pause'));
    };
    return { getState };
}

test('动态壁纸插件创建紧凑面板、互斥图标、两级显隐开关并通过原生 IPC 选目录', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <header class="chat-header">
            <h3 id="currentChatAgentName">Agent A</h3>
            <div class="chat-actions"><button id="original-action">原按钮</button></div>
        </header>
        <section id="section-quick-actions"><h3>快捷操作</h3></section>
    </body>`, {
        url: 'https://vcpchat.local/main.html',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    createRegistry(window);
    prepareMedia(window);
    const directoryCalls = [];
    window.chatAPI = {
        selectVchatWallpaperDirectory: async (directoryPath) => {
            directoryCalls.push(directoryPath);
            return {
                success: true,
                directoryPath: 'C:\\Wallpapers',
                files: [{ name: 'wallpaper.webm', url: 'file:///C:/Wallpapers/wallpaper.webm' }]
            };
        }
    };
    window.eval(readPlugin('VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin.js'));

    const header = window.document.querySelector('.chat-header');
    const titleGroup = window.document.getElementById('vchat-wallpaper-title-group');
    const panel = window.document.getElementById('vchat-dynamic-wallpaper-panel');
    const actions = window.document.querySelector('.chat-actions');
    const video = window.document.getElementById('vchat-dynamic-wallpaper-video');
    const globalEnabled = window.document.getElementById('vchatDynamicWallpaperEnabled');
    const wallpaperVisible = panel.querySelector('.vchat-wallpaper-visible input');

    assert.deepEqual(Array.from(header.children), [titleGroup, actions]);
    assert.equal(titleGroup.firstElementChild.id, 'currentChatAgentName');
    assert.equal(titleGroup.lastElementChild, panel);
    assert.equal(actions.lastElementChild.id, 'original-action');
    assert.equal(panel.style.display, 'flex');
    assert.ok(panel.classList.contains('collapsed'));
    assert.equal(window.document.querySelector('input[type="file"]'), null);
    panel.querySelector('[data-action="collapse"]').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(directoryCalls, ['']);
    assert.equal(video.getAttribute('src'), 'file:///C:/Wallpapers/wallpaper.webm');
    assert.equal(window.VCPFrontendPlugins.get('vchat-dynamic-wallpaper').state.directoryPath, 'C:\\Wallpapers');
    assert.equal(panel.querySelector('.vchat-wallpaper-name'), null);
    assert.equal(panel.querySelector('.vchat-wallpaper-count'), null);
    panel.querySelectorAll('button').forEach((button) => {
        assert.ok(button.children.length > 0);
        assert.ok(Array.from(button.children).every((child) => child.tagName === 'svg'));
    });
    assert.equal(Array.from(panel.querySelectorAll('[data-action="play"] svg')).filter((icon) => icon.style.display !== 'none').length, 1);
    assert.equal(Array.from(panel.querySelectorAll('[data-action="mode"] svg')).filter((icon) => icon.style.display !== 'none').length, 1);
    assert.equal(Array.from(panel.querySelectorAll('[data-action="mute"] svg')).filter((icon) => icon.style.display !== 'none').length, 1);
    assert.equal(globalEnabled.checked, true);
    assert.equal(wallpaperVisible.checked, true);

    wallpaperVisible.checked = false;
    wallpaperVisible.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(video.style.display, 'none');
    assert.equal(window.document.body.classList.contains('vchat-dynamic-wallpaper-visible'), false);
    assert.equal(panel.style.display, 'flex');

    globalEnabled.checked = false;
    globalEnabled.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(video.style.display, 'none');
    assert.equal(panel.style.display, 'none');

    globalEnabled.checked = true;
    globalEnabled.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(panel.style.display, 'flex');
    assert.ok(window.VCPFrontendPlugins.registry.has('vchat-dynamic-wallpaper'));

    window.VCPFrontendPlugins.get('vchat-dynamic-wallpaper').destroy();
    assert.deepEqual(Array.from(header.children), [window.document.getElementById('currentChatAgentName'), actions]);
    dom.window.close();
});

test('动态壁纸区分主动暂停与隐藏挂起并持久化真实播放意图', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <header class="chat-header">
            <h3 id="currentChatAgentName">Agent A</h3>
            <div class="chat-actions"></div>
        </header>
    </body>`, {
        url: 'https://vcpchat.local/main.html',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    createRegistry(window);
    const media = prepareStatefulMedia(window);
    window.localStorage.setItem('vchatDynamicWallpaper.settings.v1', JSON.stringify({
        index: 1,
        currentTime: 12.5,
        playing: false,
        enabled: true,
        wallpaperVisible: true,
        directoryPath: 'C:\\Wallpapers'
    }));
    window.chatAPI = {
        selectVchatWallpaperDirectory: async () => ({
            success: true,
            directoryPath: 'C:\\Wallpapers',
            files: [
                { name: 'first.webm', url: 'file:///C:/Wallpapers/first.webm' },
                { name: 'second.webm', url: 'file:///C:/Wallpapers/second.webm' }
            ]
        })
    };
    window.eval(readPlugin('VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin.js'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const plugin = window.VCPFrontendPlugins.get('vchat-dynamic-wallpaper');
    const video = window.document.getElementById('vchat-dynamic-wallpaper-video');
    const visible = window.document.querySelector('.vchat-wallpaper-visible input');
    assert.equal(plugin.state.index, 1);
    assert.equal(video.getAttribute('src'), 'file:///C:/Wallpapers/second.webm');
    assert.equal(video.currentTime, 12.5);
    assert.equal(media.getState(video).playCalls, 0);
    assert.equal(plugin.state.playing, false);

    await video.play();
    video.currentTime = 18.25;
    visible.checked = false;
    visible.dispatchEvent(new window.Event('change', { bubbles: true }));
    let saved = JSON.parse(window.localStorage.getItem('vchatDynamicWallpaper.settings.v1'));
    assert.equal(media.getState(video).pauseCalls, 1);
    assert.equal(video.paused, true);
    assert.equal(plugin.state.playing, true);
    assert.equal(saved.playing, true);
    assert.equal(saved.index, 1);
    assert.equal(saved.currentTime, 18.25);

    visible.checked = true;
    visible.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(media.getState(video).playCalls, 2);
    assert.equal(video.paused, false);

    window.document.querySelector('[data-action="play"]').click();
    assert.equal(video.paused, true);
    assert.equal(plugin.state.playing, false);
    const playCallsAfterManualPause = media.getState(video).playCalls;
    visible.checked = false;
    visible.dispatchEvent(new window.Event('change', { bubbles: true }));
    visible.checked = true;
    visible.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(media.getState(video).playCalls, playCallsAfterManualPause);
    assert.equal(video.paused, true);

    window.dispatchEvent(new window.Event('beforeunload'));
    saved = JSON.parse(window.localStorage.getItem('vchatDynamicWallpaper.settings.v1'));
    assert.equal(saved.playing, false);
    assert.equal(saved.index, 1);
    assert.equal(saved.currentTime, 18.25);

    plugin.destroy();
    dom.window.close();
});

test('动态壁纸播放列表全部失败后只尝试一轮并停止切换', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <header class="chat-header">
            <h3 id="currentChatAgentName">Agent A</h3>
            <div class="chat-actions"></div>
        </header>
    </body>`, {
        url: 'https://vcpchat.local/main.html',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    createRegistry(window);
    prepareMedia(window);
    let objectUrlCount = 0;
    window.URL.createObjectURL = () => `blob:test-${++objectUrlCount}`;
    window.URL.revokeObjectURL = () => {};
    window.eval(readPlugin('VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin.js'));

    const plugin = window.VCPFrontendPlugins.get('vchat-dynamic-wallpaper');
    const video = window.document.getElementById('vchat-dynamic-wallpaper-video');
    plugin.setPlaylist([
        new window.File(['a'], 'a.mp4', { type: 'video/mp4' }),
        new window.File(['b'], 'b.webm', { type: 'video/webm' }),
        new window.File(['c'], 'c.mov', { type: 'video/quicktime' })
    ]);

    assert.equal(objectUrlCount, 1);
    video.dispatchEvent(new window.Event('error'));
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(objectUrlCount, 2);
    video.dispatchEvent(new window.Event('error'));
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(objectUrlCount, 3);
    video.dispatchEvent(new window.Event('error'));
    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.equal(objectUrlCount, 3);
    assert.equal(plugin.state.failedIndexes.size, 3);
    plugin.destroy();
    dom.window.close();
});

test('自动 TTS 开关注入 Sovits 设置区且只朗读启动后完成的新助手消息', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <header class="chat-header"><h3 id="currentChatAgentName">Agent A</h3></header>
        <section id="agentSettingsContainer">
            <div id="ttsContent"><div class="speed-group"><label>语速</label><div class="slider-container"><input id="agentTtsSpeed"></div></div></div>
        </section>
        <main id="chatMessages">
            <div class="message-item assistant" data-message-id="history-1" data-agent-id="agent-a">
                <div class="md-content">历史消息</div>
            </div>
        </main>
    </body>`, {
        url: 'https://vcpchat.local/main.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    createRegistry(window);
    window.currentSelectedItem = { id: 'agent-a', type: 'agent', name: 'Agent A' };
    const calls = [];
    window.chatAPI = {
        getAgentConfig: async () => ({
            ttsVoicePrimary: 'voice-a',
            ttsSpeed: 1.2,
            ttsRegexPrimary: '',
            ttsVoiceSecondary: '',
            ttsRegexSecondary: ''
        }),
        sovitsSpeak: (payload) => calls.push(payload)
    };
    window.eval(readPlugin('VCPDistributedServer/Plugin/VChatAutoTTS/plugin.js'));

    const controls = window.document.getElementById('vchat-auto-tts-controls');
    const speedGroup = window.document.querySelector('.speed-group');
    assert.equal(speedGroup.nextElementSibling, controls);
    assert.ok(window.document.getElementById('ttsContent').contains(controls));
    assert.equal(window.document.getElementById('vchat-auto-tts-button'), null);
    assert.equal(window.document.getElementById('vchat-auto-tts-panel'), null);

    const enabled = controls.querySelector('[data-field="enabled"]');
    enabled.checked = true;
    enabled.dispatchEvent(new window.Event('change', { bubbles: true }));

    const lateHistory = window.document.createElement('div');
    lateHistory.className = 'message-item assistant';
    lateHistory.dataset.messageId = 'late-history';
    lateHistory.dataset.agentId = 'agent-a';
    lateHistory.innerHTML = '<div class="md-content">切换话题后载入的历史消息</div>';
    window.document.getElementById('chatMessages').appendChild(lateHistory);

    const message = window.document.createElement('div');
    message.className = 'message-item assistant streaming';
    message.dataset.messageId = 'new-1';
    message.dataset.agentId = 'agent-a';
    message.innerHTML = '<div class="md-content">新回复<pre><code>const hidden = true;</code></pre></div>';
    window.document.getElementById('chatMessages').appendChild(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
    message.classList.remove('streaming');
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].msgId, 'new-1');
    assert.equal(calls[0].voice, 'voice-a');
    assert.match(calls[0].text, /新回复/);
    assert.doesNotMatch(calls[0].text, /hidden/);
    assert.ok(!calls.some((call) => call.msgId === 'history-1'));
    assert.ok(!calls.some((call) => call.msgId === 'late-history'));

    window.VCPFrontendPlugins.get('vchat-auto-tts').destroy();
    dom.window.close();
});

test('统一加载桥只加载现有插件管理器返回的已启用前端插件', async () => {
    const dom = new JSDOM('<!doctype html><head></head><body></body>', {
        url: 'https://vcpchat.local/main.html',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.chatAPI = {
        listEnabledFrontendPlugins: async () => ({
            success: true,
            plugins: [{
                id: 'VChatDynamicWallpaper',
                style: 'VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin.css',
                script: 'VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin.js'
            }]
        })
    };
    const appendedScripts = [];
    const originalAppendChild = window.document.body.appendChild.bind(window.document.body);
    window.document.body.appendChild = (node) => {
        const result = originalAppendChild(node);
        if (node.tagName === 'SCRIPT') {
            appendedScripts.push(node.getAttribute('src'));
            queueMicrotask(() => node.onload?.());
        }
        return result;
    };

    window.eval(readPlugin('VCPDistributedServer/frontend-plugin-loader.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(appendedScripts, ['VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin.js']);
    assert.equal(window.document.querySelectorAll('script[data-vcp-plugin]').length, 1);
    assert.equal(window.document.querySelectorAll('link[data-vcp-plugin]').length, 1);
    assert.equal(window.document.querySelector('[data-vcp-plugin="VChatAutoTTS"]'), null);
    dom.window.close();
});
