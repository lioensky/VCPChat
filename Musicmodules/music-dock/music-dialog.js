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
    const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
    const activeStack = [];
    const closingTimers = new Map();
    global.addEventListener?.('beforeunload', () => {
        for (const [el, timer] of closingTimers) {
            clearTimeout(timer);
            el.remove();
        }
        closingTimers.clear();
    }, { once: true });

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
        const dialog = document.createElement('div');
        dialog.className = 'dialog glass-panel';
        dialog.setAttribute('role', 'alertdialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', `${id}-t`);
        const heading = document.createElement('h3');
        heading.id = `${id}-t`;
        heading.textContent = title;
        dialog.appendChild(heading);
        if (message) {
            dialog.setAttribute('aria-describedby', `${id}-m`);
            const msg = document.createElement('p');
            msg.className = 'music-dialog-msg';
            msg.id = `${id}-m`;
            msg.textContent = message;
            dialog.appendChild(msg);
        }
        const actions = document.createElement('div');
        actions.className = 'dialog-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'dialog-btn cancel';
        cancelBtn.textContent = cancelText;
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = danger ? 'dialog-btn confirm danger' : 'dialog-btn confirm';
        confirmBtn.textContent = confirmText;
        actions.append(cancelBtn, confirmBtn);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        activeStack.push(overlay);

        let done = false;
        let openRaf = 0;
        const onUnload = () => finish(false, true);
        const finish = (value, immediate = false) => {
            if (done) return;
            done = true;
            const isImmediate = immediate === true;
            const idx = activeStack.indexOf(overlay);
            if (idx !== -1) activeStack.splice(idx, 1);
            if (openRaf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(openRaf); openRaf = 0; }
            const pending = closingTimers.get(overlay);
            if (pending) { clearTimeout(pending); closingTimers.delete(overlay); }
            global.removeEventListener('keydown', onKey, true);
            global.removeEventListener?.('beforeunload', onUnload);
            // 先归还焦点（排除 body 与对话框自身）再撤掉 visible 类，避免改类后立刻 focus() 触发强制重排
            if (!isImmediate) {
                if (previousFocus instanceof HTMLElement && previousFocus !== document.body && previousFocus.isConnected && !overlay.contains(previousFocus)) {
                    try { previousFocus.focus({ preventScroll: true }); } catch (e) { /* 焦点还不回去就算了 */ }
                } else if (overlay.contains(document.activeElement)) {
                    try { document.activeElement.blur(); } catch (e) { /* noop */ }
                }
            }
            overlay.dataset.closing = '1';
            overlay.classList.remove('visible');
            // 留给合上的动画（流体套件或 .2s 淡出）；窗口卸载时直接移除，避免悬挂定时器。
            if (isImmediate) overlay.remove();
            else {
                const timer = setTimeout(() => { closingTimers.delete(overlay); overlay.remove(); }, 320);
                closingTimers.set(overlay, timer);
            }
            resolve(value);
        };
        // 捕获阶段拦住：仅最顶层确认框接管 Esc / Enter / Tab 与导航快捷键，避免叠开时同时关闭。
        const onKey = (e) => {
            if (activeStack[activeStack.length - 1] !== overlay) return;
            if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(false); }
            else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(document.activeElement !== cancelBtn); }
            else if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                (document.activeElement === confirmBtn ? cancelBtn : confirmBtn).focus({ preventScroll: true });
            } else if (NAV_KEYS.has(e.key) || (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1)) {
                // 单字母与导航快捷键（空格播放、/ 搜索、方向键翻阵列…）在框开着时不该生效
                e.stopPropagation();
            }
        };
        global.addEventListener('keydown', onKey, true);
        global.addEventListener?.('beforeunload', onUnload, { once: true });
        cancelBtn.addEventListener('click', () => finish(false));
        confirmBtn.addEventListener('click', () => finish(true));
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });

        // 先落到页面里再加 visible，过渡和流体动作才会播。
        const reveal = () => {
            openRaf = 0;
            if (done) return;
            overlay.classList.add('visible');
            confirmBtn.focus({ preventScroll: true });
        };
        if (typeof requestAnimationFrame === 'function') openRaf = requestAnimationFrame(reveal);
        else reveal();
    });

    global.MusicDialog = { confirm };
})(window);
