/**
 * VCPdesktop - 窗口可见性冻结模块
 * 负责：当桌面窗口最小化或被系统级遮挡时，自动冻结所有动画以节省资源
 *
 * 检测机制：
 *   1. document.visibilitychange — 最小化/切换标签页
 *   2. Electron IPC 'window-occluded' — 系统级遮挡检测（如果可用）
 *
 * 注意：不再监听 blur/focus 事件，因为普通窗口覆盖（非全屏/非最大化遮挡）
 *       也会触发 blur，导致冻结机制过于灵敏。
 *
 * 冻结范围：
 *   - 壁纸层（视频暂停、HTML iframe 通信）
 *   - 所有挂件内的动画（CSS 动画、Web Animations API、canvas/rAF、Three.js）
 *   - 挂件内的定时器（setInterval/setTimeout 由浏览器自动节流，此处辅助冻结 rAF）
 *   - Dock GIF 动画图标
 *
 * 借鉴 visibilityOptimizer.js 的暂停/恢复策略，但作用于整个桌面窗口级别。
 *
 * 功能开关：可通过全局设置中的 visibilityFreezerEnabled 控制是否启用此功能。
 */

'use strict';

(function () {
    const { state, domRefs } = window.VCPDesktop;

    let isFrozen = false;

    // 被冻结前壁纸视频是否正在播放
    let wallpaperVideoWasPlaying = false;

    // 配置
    const CONFIG = {
        // 调试日志
        debug: false,
    };

    // ============================================================
    // 初始化
    // ============================================================

    /**
     * 检查功能是否启用（读取全局设置）
     */
    function isEnabled() {
        // 默认启用；如果全局设置中明确关闭则禁用
        const setting = state.globalSettings?.visibilityFreezerEnabled;
        return setting !== false;
    }

    /**
     * 初始化可见性冻结系统
     */
    function init() {
        // 1. Page Visibility API — 最可靠，最小化/标签切换必触发
        document.addEventListener('visibilitychange', onVisibilityChange);

        // 2. Electron IPC — 系统级遮挡检测（若 preload 暴露了此接口）
        if (window.electronAPI?.onWindowOccluded) {
            window.electronAPI.onWindowOccluded((occluded) => {
                if (!isEnabled()) return;
                if (occluded) {
                    freeze('electron-occluded');
                } else {
                    unfreeze('electron-occluded');
                }
            });
        }

        log('Initialized (enabled: ' + isEnabled() + ')');
    }

    // ============================================================
    // 事件处理
    // ============================================================

    function onVisibilityChange() {
        if (!isEnabled()) return;
        if (document.hidden) {
            freeze('visibilitychange');
        } else {
            unfreeze('visibilitychange');
        }
    }

    // ============================================================
    // 冻结 / 解冻
    // ============================================================

    /**
     * 冻结所有桌面动画
     */
    function freeze(reason) {
        if (isFrozen) return;
        isFrozen = true;

        log(`Freezing (reason: ${reason})`);

        // 添加全局冻结 CSS class（暂停所有 CSS 动画/过渡）
        document.body.classList.add('desktop-frozen');

        // 1. 冻结壁纸
        freezeWallpaper();

        // 2. 冻结所有挂件
        freezeWidgets();

        // 3. 冻结 Dock GIF 动画
        freezeDockAnimations();
    }

    /**
     * 解冻所有桌面动画
     */
    function unfreeze(reason) {
        if (!isFrozen) return;
        isFrozen = false;

        log(`Unfreezing (reason: ${reason})`);

        // 移除全局冻结 CSS class
        document.body.classList.remove('desktop-frozen');

        // 1. 恢复壁纸
        unfreezeWallpaper();

        // 2. 恢复所有挂件
        unfreezeWidgets();

        // 3. 恢复 Dock GIF 动画
        unfreezeDockAnimations();
    }

    // ============================================================
    // 壁纸冻结
    // ============================================================

    function freezeWallpaper() {
        const wallpaperLayer = document.getElementById('desktop-wallpaper-layer');
        if (!wallpaperLayer) return;

        // 视频壁纸：暂停
        const video = wallpaperLayer.querySelector('video');
        if (video && !video.paused) {
            wallpaperVideoWasPlaying = true;
            video.pause();
            log('Wallpaper video paused');
        } else {
            wallpaperVideoWasPlaying = false;
        }

        // HTML 壁纸（iframe）：发送冻结消息 + 设置 display:none 让浏览器自动节流
        const iframe = wallpaperLayer.querySelector('iframe');
        if (iframe) {
            try {
                iframe.contentWindow?.postMessage({ type: 'vcp-freeze' }, '*');
            } catch (e) { /* 跨域忽略 */ }
            iframe.dataset.vcpFrozen = 'true';
            iframe.style.visibility = 'hidden';
        }
    }

    function unfreezeWallpaper() {
        const wallpaperLayer = document.getElementById('desktop-wallpaper-layer');
        if (!wallpaperLayer) return;

        // 恢复视频播放
        const video = wallpaperLayer.querySelector('video');
        if (video && wallpaperVideoWasPlaying) {
            video.play().catch(() => { });
            wallpaperVideoWasPlaying = false;
            log('Wallpaper video resumed');
        }

        // 恢复 HTML 壁纸 iframe
        const iframe = wallpaperLayer.querySelector('iframe');
        if (iframe && iframe.dataset.vcpFrozen === 'true') {
            iframe.style.visibility = 'visible';
            delete iframe.dataset.vcpFrozen;
            try {
                iframe.contentWindow?.postMessage({ type: 'vcp-unfreeze' }, '*');
            } catch (e) { /* 跨域忽略 */ }
        }
    }

    // ============================================================
    // 挂件冻结
    // ============================================================

    function freezeWidgets() {
        if (!state.widgets || state.widgets.size === 0) return;

        state.widgets.forEach((widgetData, widgetId) => {
            try {
                freezeSingleWidget(widgetData);
            } catch (e) {
                console.warn(`[VisibilityFreezer] Error freezing widget ${widgetId}:`, e);
            }
        });

        log(`Froze ${state.widgets.size} widgets`);
    }

    function unfreezeWidgets() {
        if (!state.widgets || state.widgets.size === 0) return;

        state.widgets.forEach((widgetData, widgetId) => {
            try {
                unfreezeSingleWidget(widgetData);
            } catch (e) {
                console.warn(`[VisibilityFreezer] Error unfreezing widget ${widgetId}:`, e);
            }
        });

        log(`Unfroze ${state.widgets.size} widgets`);
    }

    /**
     * 冻结单个挂件内的所有动画
     */
    function freezeSingleWidget(widgetData) {
        const el = widgetData.element;
        if (!el) return;

        // CSS 动画：添加暂停类
        el.classList.add('vcp-widget-frozen');

        // Web Animations API：暂停所有运行中的动画
        try {
            const anims = el.getAnimations({ subtree: true });
            const pausedAnims = [];
            anims.forEach(anim => {
                if (anim.playState === 'running') {
                    anim.pause();
                    pausedAnims.push(anim);
                }
            });
            // 记录被暂停的动画，以便精确恢复
            widgetData._frozenAnimations = pausedAnims;
        } catch (e) {
            widgetData._frozenAnimations = [];
        }

        // Shadow DOM 内的 canvas：隐藏以节省 GPU
        if (widgetData.shadowRoot) {
            const canvases = widgetData.shadowRoot.querySelectorAll('canvas');
            canvases.forEach(canvas => {
                canvas.dataset.vcpFrozen = 'true';
                canvas.style.visibility = 'hidden';
            });

            // Shadow DOM 内的 video/audio：暂停
            const mediaElements = widgetData.shadowRoot.querySelectorAll('video, audio');
            mediaElements.forEach(media => {
                if (!media.paused) {
                    media.dataset.vcpWasPlaying = 'true';
                    media.pause();
                }
            });

            // Shadow DOM 内的 SVG SMIL 动画
            const svgs = widgetData.shadowRoot.querySelectorAll('svg');
            svgs.forEach(svg => {
                try { if (svg.pauseAnimations) svg.pauseAnimations(); } catch (e) { }
            });
        }
    }

    /**
     * 解冻单个挂件
     */
    function unfreezeSingleWidget(widgetData) {
        const el = widgetData.element;
        if (!el) return;

        // 恢复 CSS 动画
        el.classList.remove('vcp-widget-frozen');

        // 恢复 Web Animations API
        if (widgetData._frozenAnimations) {
            widgetData._frozenAnimations.forEach(anim => {
                try {
                    if (anim.playState === 'paused') {
                        anim.play();
                    }
                } catch (e) { }
            });
            widgetData._frozenAnimations = null;
        }

        // 恢复 canvas
        if (widgetData.shadowRoot) {
            const canvases = widgetData.shadowRoot.querySelectorAll('canvas');
            canvases.forEach(canvas => {
                if (canvas.dataset.vcpFrozen === 'true') {
                    canvas.style.visibility = 'visible';
                    delete canvas.dataset.vcpFrozen;
                }
            });

            // 恢复 video/audio
            const mediaElements = widgetData.shadowRoot.querySelectorAll('video, audio');
            mediaElements.forEach(media => {
                if (media.dataset.vcpWasPlaying === 'true') {
                    media.play().catch(() => { });
                    delete media.dataset.vcpWasPlaying;
                }
            });

            // 恢复 SVG SMIL 动画
            const svgs = widgetData.shadowRoot.querySelectorAll('svg');
            svgs.forEach(svg => {
                try { if (svg.unpauseAnimations) svg.unpauseAnimations(); } catch (e) { }
            });
        }
    }

    // ============================================================
    // Dock 动画冻结
    // ============================================================

    function freezeDockAnimations() {
        const dockItems = document.getElementById('desktop-dock-items');
        if (!dockItems) return;

        // 冻结 Dock 中的 GIF 动画图标：将 src 替换为静态快照
        // 通过 CSS class 控制动画暂停
        dockItems.classList.add('vcp-dock-frozen');

        // GIF 图标：将 img src 缓存并设为空，阻止 GIF 动画帧解码
        const gifImages = dockItems.querySelectorAll('img.desktop-dock-icon-img');
        gifImages.forEach(img => {
            if (img.src && (img.src.includes('.gif') || img.src.includes('?t='))) {
                img.dataset.vcpFrozenSrc = img.src;
                // 不直接清空 src（会导致闪烁），而是靠 CSS 暂停
            }
        });
    }

    function unfreezeDockAnimations() {
        const dockItems = document.getElementById('desktop-dock-items');
        if (!dockItems) return;

        dockItems.classList.remove('vcp-dock-frozen');

        // 恢复 GIF 图标
        const gifImages = dockItems.querySelectorAll('img.desktop-dock-icon-img');
        gifImages.forEach(img => {
            if (img.dataset.vcpFrozenSrc) {
                delete img.dataset.vcpFrozenSrc;
            }
        });
    }

    // ============================================================
    // 工具
    // ============================================================

    function log(msg) {
        if (CONFIG.debug) {
            console.debug(`[VisibilityFreezer] ${msg}`);
        }
    }

    /**
     * 查询当前冻结状态
     */
    function isFrozenState() {
        return isFrozen;
    }

    /**
     * 动态设置启用/禁用状态
     * @param {boolean} enabled - true 启用冻结功能，false 禁用
     */
    function setEnabled(enabled) {
        if (state.globalSettings) {
            state.globalSettings.visibilityFreezerEnabled = !!enabled;
        }
        // 如果禁用且当前处于冻结状态，立即解冻
        if (!enabled && isFrozen) {
            unfreeze('disabled-by-user');
        }
        log('Enabled set to: ' + enabled);
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.visibilityFreezer = {
        init,
        freeze,
        unfreeze,
        isFrozen: isFrozenState,
        isEnabled,
        setEnabled,
    };

})();