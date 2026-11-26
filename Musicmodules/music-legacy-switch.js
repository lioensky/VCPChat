// Musicmodules/music-legacy-switch.js
// 设置里的「旧版界面（原版）」：打开就把音乐窗口换成上游原版界面（Musicmodules-legacy/，原样保留）。
// 原版里同一个开关关掉就回到这里。选择存在设置的 musicLegacyUI 里，下次开窗口照这个来。

(function () {
    'use strict';
    const mount = () => {
        const api = window.utilityAPI || window.electronAPI;
        const input = document.getElementById('legacy-ui-switch');
        const button = document.getElementById('music-legacy-btn');
        if (!api?.setMusicLegacyUI) {
            input?.closest('.setting-item')?.setAttribute('hidden', '');
            return;
        }

        if (input) input.checked = false;
        if (button) button.hidden = false;

        const switchToLegacy = async () => {
            if (input?.disabled || button?.disabled) return;
            if (input) {
                input.checked = true;
                input.disabled = true;
            }
            if (button) button.disabled = true;
            try {
                await api.setMusicLegacyUI(true);
            } catch (error) {
                if (input) input.checked = false;
                window.MusicToast?.show({ kind: 'error', message: '切换旧版界面失败' });
                console.warn('[Music] 切换界面失败：', error);
            } finally {
                if (input) input.disabled = false;
                if (button) button.disabled = false;
            }
        };

        button?.addEventListener('click', switchToLegacy);
        input?.addEventListener('change', switchToLegacy);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
