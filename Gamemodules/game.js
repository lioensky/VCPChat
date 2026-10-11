(() => {
    'use strict';
    const api = window.utilityAPI || window.electronAPI;
    const scope = new AbortController();
    const status = document.getElementById('game-status');
    const listen = (node, callback) => node?.addEventListener('click', callback, { signal: scope.signal });
    let maximized = false;
    listen(document.getElementById('minimize-btn'), () => api?.minimizeWindow?.());
    listen(document.getElementById('maximize-btn'), () => {
        if (maximized) api?.unmaximizeWindow?.();
        else api?.maximizeWindow?.();
    });
    listen(document.getElementById('close-btn'), () => api?.closeWindow?.());
    const cleanups = [
        api?.onWindowMaximized?.(() => { maximized = true; }),
        api?.onWindowUnmaximized?.(() => { maximized = false; }),
    ];
    document.querySelectorAll('[data-game]').forEach(button => {
        listen(button, async () => {
            if (button.disabled) return;
            button.disabled = true;
            status.textContent = '正在打开游戏…';
            try {
                if (!api?.launchGame) throw new Error('游戏启动接口未连接，请重启 VChat 后重试。');
                const result = await api.launchGame(button.dataset.game);
                if (!result?.success) throw new Error(result?.error || '游戏启动失败。');
                status.textContent = '游戏窗口已打开。再次点击会聚焦现有窗口。';
            } catch (error) {
                status.textContent = error.message;
            } finally {
                button.disabled = false;
            }
        });
    });
    api?.windowReady?.('game-hall');
    window.addEventListener('pagehide', () => {
        scope.abort();
        cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
    }, { once: true });
})();