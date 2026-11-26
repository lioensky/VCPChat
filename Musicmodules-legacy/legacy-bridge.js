// Musicmodules-legacy/legacy-bridge.js
// 旧版音乐界面（上游原版）的接线：这个文件夹里其余文件都和上游 main 一字不差，只有 music.html 多引了这一个脚本。
// 只做两件事：
//   1. 在标题栏加返回新版的按钮，设置面板也保留「旧版界面（原版）」开关。
//   2. 音频引擎的端口现在由主进程启动时探测（默认 63789 被系统占用时会换），
//      原版频谱直接连 ws://127.0.0.1:63789/ws，这里把这个地址换成引擎实际的地址。

(function () {
    'use strict';

    const api = window.utilityAPI || window.electronAPI;
    const DEFAULT_WS = 'ws://127.0.0.1:63789/ws';

    // ---- 1. 引擎地址 ----
    let engineWs = null;
    let endpointReady = null;
    try {
        const asked = api?.getAudioEngineEndpoint?.();
        if (asked && typeof asked.then === 'function') {
            endpointReady = asked.then((ep) => { if (ep && ep.wsUrl) engineWs = ep.wsUrl; }).catch(() => {});
        }
        api?.onAudioEngineStatus?.((ep) => { if (ep && ep.wsUrl) engineWs = ep.wsUrl; });
    } catch (e) { /* 旧主进程没有这个接口，就用默认端口 */ }

    // 原版在 DOMContentLoaded 里同步连频谱，那时地址还没从主进程回来，只能连 63789；
    // 引擎换了端口（63789 被系统预留时）就先失败一次，要等 5 秒重连，开头的频谱和播完事件都丢了。
    // 所以让原版的 DOMContentLoaded 处理等地址回来再跑（最多等 1.5 秒）。
    if (endpointReady && document.readyState === 'loading') {
        const nativeAdd = document.addEventListener;
        const waitForEndpoint = Promise.race([endpointReady, new Promise((r) => setTimeout(r, 1500))]);
        document.addEventListener = function (type, listener, options) {
            if (type === 'DOMContentLoaded' && typeof listener === 'function') {
                const original = listener;
                listener = function (event) { waitForEndpoint.then(() => original.call(this, event)); };
            }
            return nativeAdd.call(this, type, listener, options);
        };
        nativeAdd.call(document, 'DOMContentLoaded', () => { delete document.addEventListener; });
    }
    const NativeWebSocket = window.WebSocket;
    if (NativeWebSocket) {
        const Bridged = function (url, protocols) {
            const target = (String(url) === DEFAULT_WS && engineWs) ? engineWs : url;
            return protocols === undefined ? new NativeWebSocket(target) : new NativeWebSocket(target, protocols);
        };
        Bridged.prototype = NativeWebSocket.prototype;
        ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { Bridged[k] = NativeWebSocket[k]; });
        window.WebSocket = Bridged;
    }

    // ---- 2. 返回新版界面 ----
    const mount = () => {
        if (!api?.setMusicLegacyUI) return;
        const windowControls = document.querySelector('#custom-title-bar .window-controls');
        const button = document.createElement('button');
        button.id = 'music-current-ui-btn';
        button.className = 'window-control-btn';
        button.type = 'button';
        button.title = '切换到新版界面';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 8h18M9 8v12"></path></svg>';
        windowControls?.before(button);

        const grid = document.querySelector('.settings-container .settings-grid');
        const item = document.createElement('div');
        item.className = 'setting-item toggle-item';
        item.innerHTML = '<label for="legacy-ui-switch" title="关掉回到新版音乐界面">旧版界面（原版）</label>'
            + '<label class="switch compact"><input type="checkbox" id="legacy-ui-switch" checked><span class="slider round"></span></label>';
        grid?.appendChild(item);

        const input = item.querySelector('input');
        const switchToCurrent = async () => {
            if (button.disabled) return;
            button.disabled = input.disabled = true;
            input.checked = false;
            try {
                await api.setMusicLegacyUI(false);
            } catch (error) {
                input.checked = true;
                console.warn('[Music legacy] 切换界面失败：', error);
            } finally {
                button.disabled = input.disabled = false;
            }
        };
        button.addEventListener('click', switchToCurrent);
        input.addEventListener('change', switchToCurrent);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
