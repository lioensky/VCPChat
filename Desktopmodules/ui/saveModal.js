/**
 * VCPdesktop - 收藏模态窗模块
 * 负责：收藏命名弹窗的显示/隐藏、输入验证、确认回调
 */

'use strict';

(function () {

    /**
     * 初始化收藏模态窗
     */
    function initSaveModal() {
        const modal = document.getElementById('desktop-save-modal');
        if (!modal) return;

        const cancelBtn = modal.querySelector('.desktop-modal-cancel');
        const confirmBtn = modal.querySelector('.desktop-modal-confirm');
        const input = modal.querySelector('.desktop-modal-input');

        cancelBtn?.addEventListener('click', () => {
            modal.classList.remove('visible');
        });

        confirmBtn?.addEventListener('click', () => {
            const name = input?.value?.trim();
            if (!name) {
                input?.classList.add('error');
                setTimeout(() => input?.classList.remove('error'), 600);
                return;
            }
            const widgetId = modal.dataset.targetWidgetId;
            // 先关闭模态窗，等动画完成后再截图保存
            modal.classList.remove('visible');
            if (widgetId && window.VCPDesktop.favorites) {
                // 延迟300ms让模态窗完全消失，避免截图包含模态窗
                setTimeout(() => {
                    window.VCPDesktop.favorites.performSave(widgetId, name);
                }, 350);
            }
        });

        // 回车确认
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmBtn?.click();
            }
            if (e.key === 'Escape') {
                cancelBtn?.click();
            }
        });

        // 点击蒙层关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('visible');
            }
        });
    }

    /**
     * 显示收藏模态窗
     * @param {string} widgetId - 要收藏的挂件 ID
     */
    function showSaveModal(widgetId) {
        const modal = document.getElementById('desktop-save-modal');
        if (!modal) return;

        const input = modal.querySelector('.desktop-modal-input');
        const { state } = window.VCPDesktop;
        const widgetData = state.widgets.get(widgetId);

        // 如果已收藏，预填名字
        if (input) {
            input.value = widgetData?.savedName || '';
        }
        modal.dataset.targetWidgetId = widgetId;
        modal.classList.add('visible');

        // 聚焦输入框
        setTimeout(() => input?.focus(), 100);
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.saveModal = {
        init: initSaveModal,
        show: showSaveModal,
    };

})();