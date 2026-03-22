/**
 * VCPdesktop - 右键菜单系统模块
 * 负责：右键菜单显示/隐藏、菜单项事件分发
 */

'use strict';

(function () {
    const { state, widget, zIndex } = window.VCPDesktop;

    let contextMenuElement = null;
    let contextMenuTargetWidgetId = null;

    /**
     * 初始化右键菜单
     */
    function initContextMenu() {
        contextMenuElement = document.getElementById('desktop-context-menu');
        if (!contextMenuElement) return;

        // 绑定菜单项事件
        contextMenuElement.querySelector('[data-action="favorite"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = contextMenuTargetWidgetId;
            hideContextMenu();
            if (targetId && window.VCPDesktop.saveModal) {
                window.VCPDesktop.saveModal.show(targetId);
            }
        });

        contextMenuElement.querySelector('[data-action="refresh"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = contextMenuTargetWidgetId;
            hideContextMenu();
            if (targetId && window.VCPDesktop.favorites) {
                window.VCPDesktop.favorites.refresh(targetId);
            }
        });

        contextMenuElement.querySelector('[data-action="close"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = contextMenuTargetWidgetId;
            hideContextMenu();
            if (targetId) {
                widget.remove(targetId);
            }
        });

        contextMenuElement.querySelector('[data-action="bring-front"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = contextMenuTargetWidgetId;
            hideContextMenu();
            if (targetId) {
                zIndex.bringToFront(targetId);
            }
        });

        contextMenuElement.querySelector('[data-action="move-up"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = contextMenuTargetWidgetId;
            hideContextMenu();
            if (targetId) {
                zIndex.moveUp(targetId);
            }
        });

        contextMenuElement.querySelector('[data-action="move-down"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = contextMenuTargetWidgetId;
            hideContextMenu();
            if (targetId) {
                zIndex.moveDown(targetId);
            }
        });

        contextMenuElement.querySelector('[data-action="send-back"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = contextMenuTargetWidgetId;
            hideContextMenu();
            if (targetId) {
                zIndex.sendToBack(targetId);
            }
        });
    }

    /**
     * 显示右键菜单
     * @param {number} x - 鼠标 X 坐标
     * @param {number} y - 鼠标 Y 坐标
     * @param {string} widgetId - 目标挂件 ID
     */
    function showContextMenu(x, y, widgetId) {
        if (!contextMenuElement) return;
        contextMenuTargetWidgetId = widgetId;

        // 判断是否已收藏，更新收藏按钮文字
        const widgetData = state.widgets.get(widgetId);
        const favBtn = contextMenuElement.querySelector('[data-action="favorite"]');
        if (favBtn) {
            if (widgetData?.savedId) {
                favBtn.textContent = '⭐ 更新收藏';
            } else {
                favBtn.textContent = '⭐ 收藏';
            }
        }

        // 判断是否已收藏，更新刷新按钮可见性
        const refreshBtn = contextMenuElement.querySelector('[data-action="refresh"]');
        if (refreshBtn) {
            refreshBtn.style.display = widgetData?.savedId ? '' : 'none';
        }

        // 定位，确保不超出视口
        const menuW = 160;
        const menuH = contextMenuElement.offsetHeight || 200;
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;

        if (x + menuW > viewW) x = viewW - menuW - 8;
        if (y + menuH > viewH) y = viewH - menuH - 8;
        if (x < 0) x = 8;
        if (y < 0) y = 8;

        contextMenuElement.style.left = `${x}px`;
        contextMenuElement.style.top = `${y}px`;
        contextMenuElement.classList.add('visible');
    }

    /**
     * 隐藏右键菜单
     */
    function hideContextMenu() {
        if (contextMenuElement) {
            contextMenuElement.classList.remove('visible');
        }
        contextMenuTargetWidgetId = null;
    }

    /**
     * 获取当前菜单目标挂件ID
     * @returns {string|null}
     */
    function getTargetWidgetId() {
        return contextMenuTargetWidgetId;
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.contextMenu = {
        init: initContextMenu,
        show: showContextMenu,
        hide: hideContextMenu,
        getTargetWidgetId,
    };

})();