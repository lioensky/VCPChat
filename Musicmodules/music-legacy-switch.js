// Musicmodules/music-legacy-switch.js
// 「旧版界面（原版）」：打开就把音乐窗口换成上游原版界面（Musicmodules-legacy/，原样保留）。
// 原版里同一个开关关掉就回到这里。选择存在设置的 musicLegacyUI 里，下次开窗口照这个来。
// 入口有两个：设置里的开关，和首页视图菜单（标题栏右边）最后一项「旧版界面」——后者调 MusicLegacySwitch.switchToLegacy()。

(function () {
    'use strict';
    const api = () => window.utilityAPI || window.electronAPI;
    let busy = false;

    const switchToLegacy = async () => {
        const input = document.getElementById('legacy-ui-switch');
        if (busy || !api()?.setMusicLegacyUI) return;
        busy = true;
        if (input) {
            input.checked = true;
            input.disabled = true;
        }
        try {
            await api().setMusicLegacyUI(true);
        } catch (error) {
            if (input) input.checked = false;
            window.MusicToast?.show({ kind: 'error', message: '切换旧版界面失败' });
            console.warn('[Music] 切换界面失败：', error);
        } finally {
            busy = false;
            if (input) input.disabled = false;
        }
    };

    const mount = () => {
        const input = document.getElementById('legacy-ui-switch');
        if (!api()?.setMusicLegacyUI) {
            input?.closest('.setting-item')?.setAttribute('hidden', '');
            return;
        }
        if (input) input.checked = false;
        input?.addEventListener('change', switchToLegacy);
    };

    window.MusicLegacySwitch = Object.freeze({ switchToLegacy });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
