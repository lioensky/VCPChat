/**
 * VCPdesktop - 状态指示器模块
 * 负责：底部状态栏显示连接状态、流式状态、消息提示
 */

'use strict';

(function () {
    const { domRefs } = window.VCPDesktop;

    /**
     * 更新状态指示器
     * @param {'waiting' | 'connected' | 'streaming'} state - 状态类型
     * @param {string} message - 显示消息
     */
    function updateStatus(state, message) {
        const { statusIndicator, statusDot, statusText } = domRefs;
        if (!statusIndicator) return;

        statusIndicator.classList.remove('hidden');

        if (statusDot) {
            statusDot.className = 'desktop-status-dot';
            if (state === 'connected') statusDot.classList.add('connected');
            if (state === 'streaming') statusDot.classList.add('streaming');
        }
        if (statusText) {
            statusText.textContent = message;
        }

        if (state !== 'streaming') {
            setTimeout(() => {
                statusIndicator?.classList.add('hidden');
            }, 3000);
        }
    }

    /**
     * 隐藏状态指示器
     */
    function hideStatus() {
        domRefs.statusIndicator?.classList.add('hidden');
    }

    /**
     * 显示状态指示器
     */
    function showStatus() {
        domRefs.statusIndicator?.classList.remove('hidden');
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.status = {
        update: updateStatus,
        hide: hideStatus,
        show: showStatus,
    };

})();