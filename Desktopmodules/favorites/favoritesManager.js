/**
 * VCPdesktop - 收藏系统管理模块
 * 负责：收藏保存/加载/删除/恢复、IPC 持久化调用
 */

'use strict';

(function () {
    const desktopApi = window.desktopAPI || window.electronAPI;
    const { state, status, widget, sidebar, thumbnail } = window.VCPDesktop;

    // ============================================================
    // 执行收藏
    // ============================================================

    /**
     * 执行收藏操作：截图 + 保存HTML + IPC持久化
     * @param {string} widgetId
     * @param {string} name - 收藏名称
     */
    async function performSave(widgetId, name) {
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) {
            console.error('[Desktop] performSave: widgetData not found for', widgetId);
            return;
        }

        // 生成收藏ID
        const saveId = widgetData.savedId || `fav_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        // 获取widget的HTML内容
        const htmlContent = widgetData.contentBuffer || widgetData.contentContainer.innerHTML;
        console.log(`[Desktop] performSave: id=${saveId}, name=${name}, htmlLen=${htmlContent.length}`);

        // 截图
        let thumbnailDataUrl = '';
        try {
            thumbnailDataUrl = await thumbnail.capture(widgetData);
            console.log(`[Desktop] Thumbnail captured: ${thumbnailDataUrl.length} chars`);
        } catch (err) {
            console.warn('[Desktop] Failed to capture thumbnail:', err);
        }

        // 通过IPC发送到主进程持久化
        if (desktopApi?.desktopSaveWidget) {
            try {
                console.log('[Desktop] Calling desktopSaveWidget IPC...');
                const result = await desktopApi.desktopSaveWidget({
                    id: saveId,
                    name: name,
                    html: htmlContent,
                    thumbnail: thumbnailDataUrl,
                });
                console.log('[Desktop] desktopSaveWidget result:', result);
                if (result?.success) {
                    widgetData.savedName = name;
                    widgetData.savedId = saveId;
                    status.update('connected', `已收藏: ${name}`);
                    // 刷新侧栏收藏列表
                    await loadFavoritesList();
                    console.log('[Desktop] Favorites refreshed after save, count:', state.favorites.length);
                } else {
                    status.update('waiting', `收藏失败: ${result?.error || '未知错误'}`);
                }
            } catch (err) {
                console.error('[Desktop] Save widget error:', err);
                status.update('waiting', '收藏失败');
            }
        } else {
            console.warn('[Desktop] desktopSaveWidget API not available');
            status.update('waiting', '收藏API不可用');
        }
    }

    // ============================================================
    // 加载收藏列表
    // ============================================================

    /**
     * 从主进程加载收藏列表
     */
    async function loadFavoritesList() {
        if (!desktopApi?.desktopListWidgets) {
            console.log('[Desktop] desktopListWidgets API not available yet, skipping.');
            return;
        }
        try {
            const result = await desktopApi.desktopListWidgets();
            if (result?.success) {
                state.favorites = result.widgets || [];
                sidebar.render();
            }
        } catch (err) {
            console.warn('[Desktop] Load favorites unavailable (restart main process?):', err.message);
        }
    }

    // ============================================================
    // 从收藏恢复到桌面
    // ============================================================

    /**
     * 从收藏中恢复一个 widget 到桌面
     * @param {string} favoriteId - 收藏 ID
     * @param {number} [x] - 放置 X 坐标
     * @param {number} [y] - 放置 Y 坐标
     */
    async function spawnFromFavorite(favoriteId, x, y) {
        if (desktopApi?.desktopLoadWidget) {
            try {
                const result = await desktopApi.desktopLoadWidget(favoriteId);
                if (result?.success && result.html) {
                    const widgetId = `fav-${favoriteId}-${Date.now()}`;
                    const widgetData = widget.create(widgetId, {
                        x: x || 150 + Math.random() * 200,
                        y: y || 100 + Math.random() * 200,
                    });
                    if (!widgetData) {
                        throw new Error(`Widget "${widgetId}" is being removed. Try again shortly.`);
                    }
                    widgetData.savedId = favoriteId;
                    widgetData.savedName = result.name || favoriteId;
                    widgetData.contentBuffer = result.html;
                    widgetData.contentContainer.innerHTML = result.html;
                    widget.processInlineStyles(widgetData);
                    widgetData.isConstructing = false;
                    widgetData.element.classList.remove('constructing');
                    widget.autoResize(widgetData);
                    // 延迟执行脚本，等DOM渲染完成
                    setTimeout(() => {
                        widget.processInlineScripts(widgetData);
                    }, 100);
                    status.update('connected', `已加载: ${result.name}`);
                }
            } catch (err) {
                console.error('[Desktop] Spawn from favorite error:', err);
            }
        }
    }

    // ============================================================
    // 刷新挂件
    // ============================================================

    /**
     * 刷新挂件（从文件重新加载已收藏的内容）
     * @param {string} widgetId
     */
    async function refreshWidget(widgetId) {
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData || !widgetData.savedId) {
            status.update('waiting', '该挂件未收藏，无法刷新');
            return;
        }

        if (desktopApi?.desktopLoadWidget) {
            try {
                const result = await desktopApi.desktopLoadWidget(widgetData.savedId);
                if (result?.success && result.html) {
                    widgetData.contentBuffer = result.html;
                    widgetData.contentContainer.innerHTML = result.html;
                    widget.processInlineStyles(widgetData);
                    widget.autoResize(widgetData);
                    // 重新执行脚本
                    widget.processInlineScripts(widgetData);
                    status.update('connected', `已刷新: ${widgetData.savedName}`);
                } else {
                    status.update('waiting', `刷新失败: ${result?.error || '未知错误'}`);
                }
            } catch (err) {
                console.error('[Desktop] Refresh widget error:', err);
                status.update('waiting', '刷新失败');
            }
        }
    }

    // ============================================================
    // 删除收藏
    // ============================================================

    /**
     * 删除收藏
     * @param {string} favoriteId
     */
    async function deleteFavorite(favoriteId) {
        if (desktopApi?.desktopDeleteWidget) {
            try {
                const result = await desktopApi.desktopDeleteWidget(favoriteId);
                if (result?.success) {
                    status.update('connected', '已删除收藏');
                    loadFavoritesList();
                }
            } catch (err) {
                console.error('[Desktop] Delete favorite error:', err);
            }
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.favorites = {
        performSave,
        loadList: loadFavoritesList,
        spawnFromFavorite,
        refresh: refreshWidget,
        deleteFavorite,
    };

})();
