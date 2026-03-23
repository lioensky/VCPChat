/**
 * VCPdesktop - 拖拽系统模块
 * 负责：挂件拖拽交互、边界限位、光标状态管理
 */

'use strict';

(function () {
    const { CONSTANTS, zIndex } = window.VCPDesktop;

    /**
     * 为挂件设置拖拽行为
     * @param {HTMLElement} widgetElement - 挂件容器元素
     * @param {HTMLElement} gripElement - 拖拽手柄元素
     */
    function setupDrag(widgetElement, gripElement) {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;

        gripElement.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // 锁定状态下禁止拖拽
            if (window.VCPDesktop.state && window.VCPDesktop.state.desktopLocked) return;
            e.preventDefault();
            e.stopPropagation();

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            originLeft = parseInt(widgetElement.style.left) || 0;
            originTop = parseInt(widgetElement.style.top) || 0;

            gripElement.style.cursor = 'grabbing';

            // 拖拽期间提升z-index
            const widgetId = widgetElement.dataset.widgetId;
            zIndex.bringToFront(widgetId);

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            let newLeft = originLeft + dx;
            let newTop = originTop + dy;

            // === 拖拽限位 ===
            const widgetW = widgetElement.offsetWidth;
            const viewW = window.innerWidth;
            const viewH = window.innerHeight;
            const minVisible = CONSTANTS.DRAG_MIN_VISIBLE;

            // 上边界：不能拖入标题栏区域
            if (newTop < CONSTANTS.TITLE_BAR_HEIGHT) {
                newTop = CONSTANTS.TITLE_BAR_HEIGHT;
            }

            // 下边界：至少保留minVisible在屏幕内
            if (newTop > viewH - minVisible) {
                newTop = viewH - minVisible;
            }

            // 左边界
            if (newLeft < -(widgetW - minVisible)) {
                newLeft = -(widgetW - minVisible);
            }

            // 右边界
            if (newLeft > viewW - minVisible) {
                newLeft = viewW - minVisible;
            }

            widgetElement.style.left = `${newLeft}px`;
            widgetElement.style.top = `${newTop}px`;
        }

        function onMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            gripElement.style.cursor = '';

            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.drag = {
        setup: setupDrag,
    };

})();