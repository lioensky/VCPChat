/**
 * VCPdesktop - 右键菜单系统模块
 * 负责：挂件右键菜单、桌面空白区右键菜单（刷新/保存预设/系统工具）
 */

'use strict';

(function () {
    const { state, widget, zIndex } = window.VCPDesktop;

    let contextMenuElement = null;
    let contextMenuTargetWidgetId = null;
    let desktopContextMenuEl = null; // 桌面空白区右键菜单

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

        // 注册桌面空白区右键菜单事件
        initDesktopCanvasContextMenu();
    }

    // ============================================================
    // 桌面空白区右键菜单
    // ============================================================

    /**
     * 注册桌面画布区域的右键菜单
     */
    function initDesktopCanvasContextMenu() {
        const canvas = document.getElementById('desktop-canvas');
        if (!canvas) return;

        canvas.addEventListener('contextmenu', (e) => {
            // 如果右键点击的是挂件或桌面图标，不处理（由各自的 contextmenu 处理）
            if (e.target.closest('.desktop-widget') || e.target.closest('.desktop-shortcut-icon')) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            showDesktopCanvasContextMenu(e.clientX, e.clientY);
        });
    }

    /**
     * 显示桌面空白区右键菜单
     */
    function showDesktopCanvasContextMenu(x, y) {
        // 先移除旧菜单
        hideDesktopCanvasContextMenu();

        desktopContextMenuEl = document.createElement('div');
        desktopContextMenuEl.className = 'desktop-context-menu visible';
        desktopContextMenuEl.style.left = `${x}px`;
        desktopContextMenuEl.style.top = `${y}px`;
        desktopContextMenuEl.style.visibility = 'hidden';

        // --- 锁定/解锁桌面 ---
        const isLocked = state.desktopLocked;
        const lockLabel = isLocked ? '🔓 解锁桌面' : '🔒 锁定桌面';
        const lockBtn = createMenuItem(lockLabel, () => {
            hideDesktopCanvasContextMenu();
            toggleDesktopLock();
        });
        desktopContextMenuEl.appendChild(lockBtn);

        // --- 分隔线 ---
        desktopContextMenuEl.appendChild(createDivider());

        // --- 刷新桌面 ---
        const refreshBtn = createMenuItem('🔄 刷新桌面', () => {
            hideDesktopCanvasContextMenu();
            window.location.reload();
        });
        desktopContextMenuEl.appendChild(refreshBtn);

        // --- 保存当前预设 ---
        const presetLabel = state.lastLoadedPresetId
            ? `💾 保存预设「${state.lastLoadedPresetName || '当前预设'}」`
            : '💾 保存为新预设';
        const savePresetBtn = createMenuItem(presetLabel, async () => {
            hideDesktopCanvasContextMenu();
            if (state.lastLoadedPresetId) {
                // 覆盖保存当前预设
                await overwriteCurrentPreset();
            } else {
                // 新建预设 - 跳转到侧栏预设页
                if (window.VCPDesktop.sidebar) {
                    window.VCPDesktop.sidebar.toggle(true);
                    window.VCPDesktop.sidebar.switchTab('presets');
                }
            }
        });
        desktopContextMenuEl.appendChild(savePresetBtn);

        // --- 分隔线 ---
        desktopContextMenuEl.appendChild(createDivider());

        // --- Windows 系统工具 ---
        const sysLabel = document.createElement('div');
        sysLabel.className = 'desktop-context-menu-label';
        sysLabel.textContent = 'Windows 工具';
        desktopContextMenuEl.appendChild(sysLabel);

        const sysTools = [
            { label: '🖥️ 显示设置',    cmd: 'ms-settings:display' },
            { label: '⚙️ Windows 设置', cmd: 'ms-settings:' },
            { label: '🎛️ 控制面板',     cmd: 'control' },
            { label: '🗑️ 回收站',       cmd: 'shell:RecycleBinFolder' },
            { label: '💻 我的电脑',      cmd: 'shell:MyComputerFolder' },
        ];

        sysTools.forEach(tool => {
            const btn = createMenuItem(tool.label, () => {
                hideDesktopCanvasContextMenu();
                openSystemTool(tool.cmd);
            });
            desktopContextMenuEl.appendChild(btn);
        });

        document.body.appendChild(desktopContextMenuEl);

        // 边界避让
        requestAnimationFrame(() => {
            if (!desktopContextMenuEl) return;
            const rect = desktopContextMenuEl.getBoundingClientRect();
            let ax = x, ay = y;
            if (rect.bottom > window.innerHeight - 10) ay = y - rect.height;
            if (rect.right > window.innerWidth - 10) ax = x - rect.width;
            if (ay < 10) ay = 10;
            if (ax < 10) ax = 10;
            desktopContextMenuEl.style.left = `${ax}px`;
            desktopContextMenuEl.style.top = `${ay}px`;
            desktopContextMenuEl.style.visibility = '';
        });

        // 点击其他区域关闭
        const closeHandler = (e) => {
            if (desktopContextMenuEl && !desktopContextMenuEl.contains(e.target)) {
                hideDesktopCanvasContextMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    /**
     * 隐藏桌面空白区右键菜单
     */
    function hideDesktopCanvasContextMenu() {
        if (desktopContextMenuEl) {
            desktopContextMenuEl.remove();
            desktopContextMenuEl = null;
        }
    }

    /**
     * 创建菜单项
     */
    function createMenuItem(text, onClick) {
        const btn = document.createElement('button');
        btn.className = 'desktop-context-menu-item';
        btn.textContent = text;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    /**
     * 创建分隔线
     */
    function createDivider() {
        const d = document.createElement('div');
        d.className = 'desktop-context-menu-divider';
        return d;
    }

    /**
     * 覆盖保存当前预设（基于 lastLoadedPresetId）
     */
    async function overwriteCurrentPreset() {
        const presetId = state.lastLoadedPresetId;
        if (!presetId) return;

        if (!window.electronAPI?.desktopSaveLayout || !window.electronAPI?.desktopLoadLayout) return;

        try {
            // 加载现有数据
            const result = await window.electronAPI.desktopLoadLayout();
            if (!result?.success || !result.data) return;

            const layoutData = result.data;
            const presets = layoutData.presets || [];
            const target = presets.find(p => p.id === presetId);
            if (!target) {
                if (window.VCPDesktop.status) {
                    window.VCPDesktop.status.update('waiting', '找不到原预设，请手动保存');
                    window.VCPDesktop.status.show();
                    setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                }
                return;
            }

            // 收集当前桌面状态
            const widgetStates = [];
            state.widgets.forEach((widgetData, widgetId) => {
                const el = widgetData.element;
                widgetStates.push({
                    widgetId,
                    x: parseInt(el.style.left) || 0,
                    y: parseInt(el.style.top) || 0,
                    width: parseInt(el.style.width) || 320,
                    height: parseInt(el.style.height) || 200,
                    savedId: widgetData.savedId || null,
                    savedName: widgetData.savedName || null,
                    isBuiltin: widgetId.startsWith('builtin-'),
                });
            });

            const iconStates = state.desktopIcons.map(icon => ({...icon}));

            // 更新预设
            target.widgets = widgetStates;
            target.desktopIcons = iconStates;
            target.dock = {
                items: state.dock.items.map(i => ({...i})),
                maxVisible: state.dock.maxVisible,
            };
            target.updatedAt = Date.now();

            // 保存
            layoutData.presets = presets;
            await window.electronAPI.desktopSaveLayout(layoutData);

            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('connected', `预设已更新: ${target.name}`);
                window.VCPDesktop.status.show();
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        } catch (err) {
            console.error('[ContextMenu] Overwrite preset error:', err);
            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('waiting', '保存预设失败');
                window.VCPDesktop.status.show();
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        }
    }

    /**
     * 打开 Windows 系统工具
     */
    function openSystemTool(cmd) {
        if (window.electronAPI?.desktopOpenSystemTool) {
            window.electronAPI.desktopOpenSystemTool(cmd).catch(err => {
                console.error('[ContextMenu] Open system tool error:', err);
            });
        } else {
            console.warn('[ContextMenu] desktopOpenSystemTool API not available');
        }
    }

    /**
     * 显示右键菜单（挂件专用）
     * @param {number} x - 鼠标 X 坐标
     * @param {number} y - 鼠标 Y 坐标
     * @param {string} widgetId - 目标挂件 ID
     */
    function showContextMenu(x, y, widgetId) {
        if (!contextMenuElement) return;
        contextMenuTargetWidgetId = widgetId;

        // 隐藏桌面右键菜单（如果有）
        hideDesktopCanvasContextMenu();

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
        // 同时隐藏桌面右键菜单
        hideDesktopCanvasContextMenu();
    }

    /**
     * 获取当前菜单目标挂件ID
     * @returns {string|null}
     */
    function getTargetWidgetId() {
        return contextMenuTargetWidgetId;
    }

    // ============================================================
    // 桌面锁定/解锁
    // ============================================================

    /**
     * 切换桌面锁定状态
     */
    function toggleDesktopLock() {
        state.desktopLocked = !state.desktopLocked;
        const canvas = document.getElementById('desktop-canvas');
        if (canvas) {
            if (state.desktopLocked) {
                canvas.classList.add('desktop-locked');
            } else {
                canvas.classList.remove('desktop-locked');
            }
        }

        // 状态提示
        if (window.VCPDesktop.status) {
            const msg = state.desktopLocked ? '桌面已锁定' : '桌面已解锁';
            const icon = state.desktopLocked ? '🔒' : '🔓';
            window.VCPDesktop.status.update('connected', `${icon} ${msg}`);
            window.VCPDesktop.status.show();
            setTimeout(() => window.VCPDesktop.status.hide(), 2000);
        }

        console.log(`[ContextMenu] Desktop lock: ${state.desktopLocked}`);
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
        toggleDesktopLock,
    };

})();