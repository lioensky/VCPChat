// Musicmodules/music-dock/music-dialog.js
// 音乐窗口自己的确认框，替代系统原生 confirm()。
// 长相和「新建歌单」一样（.dialog-overlay > .dialog），打开、合上的液体动作由流体套件按 visible 类自动处理。
//
//   const ok = await MusicDialog.confirm({
//       title: '移除这首歌？', message: '磁盘上的文件不会删除。',
//       confirmText: '移除', danger: true
//   });
//
// 键盘：Enter 确认，Esc 取消，Tab 只在两个按钮间轮转；合上后焦点回到打开前的位置。
(function (global) {
    'use strict';

    let seq = 0;

    const confirm = (options = {}) => new Promise((resolve) => {
        const {
            title = '确认',
            message = '',
            confirmText = '确定',
            cancelText = '取消',
            danger = false
        } = typeof options === 'string' ? { message: options } : options;
        const id = `music-dialog-${++seq}`;
        const previousFocus = document.activeElement;

        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay music-dialog';
        overlay.innerHTML = `
            <div class="dialog glass-panel" role="alertdialog" aria-modal="true" aria-labelledby="${id}-t"${message ? ` aria-describedby="${id}-m"` : ''}>
                <h3 id="${id}-t"></h3>
                ${message ? `<p class="music-dialog-msg" id="${id}-m"></p>` : ''}
                <div class="dialog-actions">
                    <button type="button" class="dialog-btn cancel"></button>
                    <button type="button" class="dialog-btn confirm${danger ? ' danger' : ''}"></button>
                </div>
            </div>`;
        overlay.querySelector('h3').textContent = title;
        if (message) overlay.querySelector('.music-dialog-msg').textContent = message;
        const cancelBtn = overlay.querySelector('.dialog-btn.cancel');
        const confirmBtn = overlay.querySelector('.dialog-btn.confirm');
        cancelBtn.textContent = cancelText;
        confirmBtn.textContent = confirmText;
        document.body.appendChild(overlay);

        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            global.removeEventListener('keydown', onKey, true);
            overlay.classList.remove('visible');
            // 留给合上的动画（流体套件或 .2s 淡出）
            setTimeout(() => overlay.remove(), 320);
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
                try { previousFocus.focus({ preventScroll: true }); } catch (e) { /* 焦点还不回去就算了 */ }
            }
            resolve(value);
        };
        // 捕获阶段拦住：Esc 只关这个框，不会顺带关掉抽屉、退出舞台。
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
            else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(document.activeElement !== cancelBtn); }
            else if (e.key === 'Tab') {
                e.preventDefault();
                (document.activeElement === confirmBtn ? cancelBtn : confirmBtn).focus();
            } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
                // 单字母快捷键（空格播放、/ 搜索…）在框开着时不该生效
                e.stopPropagation();
            }
        };
        global.addEventListener('keydown', onKey, true);
        cancelBtn.addEventListener('click', () => finish(false));
        confirmBtn.addEventListener('click', () => finish(true));
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });

        // 先落到页面里再加 visible，过渡和流体动作才会播。
        requestAnimationFrame(() => {
            overlay.classList.add('visible');
            confirmBtn.focus({ preventScroll: true });
        });
    });

    global.MusicDialog = { confirm };
})(window);
