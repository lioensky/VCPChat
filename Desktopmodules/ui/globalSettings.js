/**
 * VCPdesktop - 全局设置模块
 * 负责：桌面全局设置的UI渲染、保存/加载、应用设置逻辑
 * 
 * 设置项：
 *   - autoMaximize: 打开桌面时自动最大化
 *   - alwaysOnBottom: 桌面窗口自动置于所有窗口最底层
 *   - defaultPresetId: 启动时自动加载的默认预设ID
 *   - dock.maxVisible: Dock栏默认显示图标数目
 *   - dock.iconSize: Dock栏图标大小
 */

'use strict';

(function () {
    const { state } = window.VCPDesktop;

    // 默认设置
    const DEFAULT_SETTINGS = {
        autoMaximize: false,
        alwaysOnBottom: false,
        defaultPresetId: null,
        dock: {
            maxVisible: 8,
            iconSize: 32,       // px
        },
    };

    let overlayEl = null;

    // ============================================================
    // 初始化
    // ============================================================

    async function init() {
        // 确保 state.globalSettings 存在
        if (!state.globalSettings) {
            state.globalSettings = { ...DEFAULT_SETTINGS, dock: { ...DEFAULT_SETTINGS.dock } };
        }

        // 从磁盘加载设置（等待完成，确保后续 applyOnStartup 能读取到）
        await loadSettings();

        // 绑定侧栏设置按钮
        const settingsBtn = document.getElementById('desktop-sidebar-settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                openSettingsModal();
            });
        }

        // 绑定设置模态窗事件
        overlayEl = document.getElementById('desktop-settings-overlay');
        if (overlayEl) {
            // 关闭按钮
            overlayEl.querySelector('.desktop-settings-close')?.addEventListener('click', () => {
                closeSettingsModal();
            });

            // 点击蒙层关闭
            overlayEl.addEventListener('click', (e) => {
                if (e.target === overlayEl) {
                    closeSettingsModal();
                }
            });

            // 重置按钮
            overlayEl.querySelector('.desktop-settings-footer-btn.reset')?.addEventListener('click', () => {
                resetSettings();
            });

            // 保存按钮
            overlayEl.querySelector('.desktop-settings-footer-btn.save')?.addEventListener('click', () => {
                applyAndSaveFromUI();
                closeSettingsModal();
            });
        }
    }

    // ============================================================
    // 设置模态窗
    // ============================================================

    /**
     * 打开全局设置模态窗
     */
    function openSettingsModal() {
        if (!overlayEl) return;

        // 填充当前设置到UI
        populateUI();
        overlayEl.classList.add('visible');
    }

    /**
     * 关闭全局设置模态窗
     */
    function closeSettingsModal() {
        if (!overlayEl) return;
        overlayEl.classList.remove('visible');
    }

    /**
     * 将当前设置值填充到 UI 控件
     */
    function populateUI() {
        const s = state.globalSettings;

        // 自动最大化
        const autoMaxEl = document.getElementById('desktop-setting-auto-maximize');
        if (autoMaxEl) autoMaxEl.checked = !!s.autoMaximize;

        // 窗口置底
        const bottomEl = document.getElementById('desktop-setting-always-bottom');
        if (bottomEl) bottomEl.checked = !!s.alwaysOnBottom;

        // Dock 可见图标数
        const dockCountEl = document.getElementById('desktop-setting-dock-count-value');
        if (dockCountEl) dockCountEl.textContent = s.dock?.maxVisible || DEFAULT_SETTINGS.dock.maxVisible;

        // Dock 图标大小
        const dockSizeEl = document.getElementById('desktop-setting-dock-size');
        const dockSizeLabelEl = document.getElementById('desktop-setting-dock-size-label');
        if (dockSizeEl) dockSizeEl.value = s.dock?.iconSize || DEFAULT_SETTINGS.dock.iconSize;
        if (dockSizeLabelEl) dockSizeLabelEl.textContent = `${s.dock?.iconSize || DEFAULT_SETTINGS.dock.iconSize}px`;
    }

    /**
     * 从 UI 控件读取设置并应用+保存
     */
    function applyAndSaveFromUI() {
        const s = state.globalSettings;

        // 读取 UI 值
        const autoMaxEl = document.getElementById('desktop-setting-auto-maximize');
        if (autoMaxEl) s.autoMaximize = autoMaxEl.checked;

        const bottomEl = document.getElementById('desktop-setting-always-bottom');
        if (bottomEl) s.alwaysOnBottom = bottomEl.checked;

        const dockCountEl = document.getElementById('desktop-setting-dock-count-value');
        if (dockCountEl) {
            const val = parseInt(dockCountEl.textContent);
            if (!isNaN(val) && val > 0) {
                s.dock.maxVisible = val;
            }
        }

        const dockSizeEl = document.getElementById('desktop-setting-dock-size');
        if (dockSizeEl) {
            const val = parseInt(dockSizeEl.value);
            if (!isNaN(val) && val >= 16 && val <= 64) {
                s.dock.iconSize = val;
            }
        }

        // 应用设置
        applySettings();

        // 保存到磁盘
        saveSettings();

        // 状态反馈
        if (window.VCPDesktop.status) {
            window.VCPDesktop.status.update('connected', '设置已保存');
            window.VCPDesktop.status.show();
            setTimeout(() => window.VCPDesktop.status.hide(), 2500);
        }
    }

    /**
     * 重置为默认设置
     */
    function resetSettings() {
        state.globalSettings = { ...DEFAULT_SETTINGS, dock: { ...DEFAULT_SETTINGS.dock } };
        populateUI();

        if (window.VCPDesktop.status) {
            window.VCPDesktop.status.update('connected', '已恢复默认设置');
            window.VCPDesktop.status.show();
            setTimeout(() => window.VCPDesktop.status.hide(), 2500);
        }
    }

    // ============================================================
    // 应用设置到运行时
    // ============================================================

    /**
     * 将当前 globalSettings 应用到运行时
     */
    function applySettings() {
        const s = state.globalSettings;

        // 1. 自动最大化（锁定最大化状态）
        const titleBar = document.getElementById('desktop-title-bar');
        const dragRegion = titleBar?.querySelector('.desktop-title-bar-drag-region');

        if (s.autoMaximize) {
            if (window.electronAPI?.maximizeWindow) {
                window.electronAPI.maximizeWindow();
            }
            // 禁用标题栏最大化按钮，锁死最大化状态
            const maxBtn = document.getElementById('desktop-btn-maximize');
            if (maxBtn) {
                maxBtn.disabled = true;
                maxBtn.style.opacity = '0.3';
                maxBtn.style.cursor = 'not-allowed';
                maxBtn.title = '已锁定最大化（可在全局设置中关闭）';
            }
            // 禁用标题栏拖拽区域，防止通过拖拽标题栏取消最大化
            if (titleBar) {
                titleBar.style.webkitAppRegion = 'no-drag';
            }
            if (dragRegion) {
                dragRegion.style.webkitAppRegion = 'no-drag';
            }
        } else {
            // 恢复最大化按钮
            const maxBtn = document.getElementById('desktop-btn-maximize');
            if (maxBtn) {
                maxBtn.disabled = false;
                maxBtn.style.opacity = '';
                maxBtn.style.cursor = '';
                maxBtn.title = '最大化';
            }
            // 恢复标题栏拖拽区域
            if (titleBar) {
                titleBar.style.webkitAppRegion = 'drag';
            }
            if (dragRegion) {
                dragRegion.style.webkitAppRegion = '';
            }
        }

        // 2. 窗口置底
        if (window.electronAPI?.setAlwaysOnBottom) {
            window.electronAPI.setAlwaysOnBottom(!!s.alwaysOnBottom);
        }

        // 3. Dock 可见图标数
        if (s.dock?.maxVisible && state.dock) {
            state.dock.maxVisible = s.dock.maxVisible;
            if (window.VCPDesktop.dock) {
                window.VCPDesktop.dock.render();
            }
        }

        // 4. Dock 图标大小 - 通过 CSS 变量应用
        if (s.dock?.iconSize) {
            document.documentElement.style.setProperty('--desktop-dock-icon-size', `${s.dock.iconSize}px`);
        }
    }

    /**
     * 启动时应用设置（包括加载默认预设）
     */
    async function applyOnStartup() {
        const s = state.globalSettings;

        // 应用基础设置
        applySettings();

        // 加载默认预设
        if (s.defaultPresetId) {
            try {
                const presets = await loadPresetsFromDisk();
                const defaultPreset = presets.find(p => p.id === s.defaultPresetId);
                if (defaultPreset && window.VCPDesktop.sidebar) {
                    // 延迟一些时间让其他系统初始化完成
                    setTimeout(() => {
                        console.log(`[GlobalSettings] Auto-loading default preset: ${defaultPreset.name}`);
                        // 调用 sidebar 中暴露的 applyPreset（需要在 sidebar 中导出）
                        if (window.VCPDesktop.sidebar.applyPreset) {
                            window.VCPDesktop.sidebar.applyPreset(defaultPreset);
                        }
                    }, 1500);
                }
            } catch (err) {
                console.error('[GlobalSettings] Failed to load default preset:', err);
            }
        }
    }

    /**
     * 辅助：从磁盘加载预设列表（与 sidebar 共用 API）
     */
    async function loadPresetsFromDisk() {
        if (!window.electronAPI?.desktopLoadLayout) return [];
        try {
            const result = await window.electronAPI.desktopLoadLayout();
            if (result?.success && result.data && result.data.presets) {
                return result.data.presets;
            }
        } catch (err) {
            console.error('[GlobalSettings] Load presets error:', err);
        }
        return [];
    }

    // ============================================================
    // 持久化（复用 layout.json，全局设置存储在其 globalSettings 字段中）
    // ============================================================

    /**
     * 保存设置到磁盘（合并写入 layout.json）
     */
    async function saveSettings() {
        if (!window.electronAPI?.desktopSaveLayout || !window.electronAPI?.desktopLoadLayout) {
            console.warn('[GlobalSettings] Layout API not available, cannot save settings');
            return;
        }

        try {
            // 先读取现有的 layout.json 数据（包含预设等）
            const existing = await loadLayoutData();
            // 合并 globalSettings 字段
            existing.globalSettings = { ...state.globalSettings };
            // 写回
            await window.electronAPI.desktopSaveLayout(existing);
            console.log('[GlobalSettings] Settings saved to layout.json');
        } catch (err) {
            console.error('[GlobalSettings] Save error:', err);
        }
    }

    /**
     * 从磁盘加载设置（从 layout.json 的 globalSettings 字段读取）
     */
    async function loadSettings() {
        if (!window.electronAPI?.desktopLoadLayout) {
            console.log('[GlobalSettings] Layout API not available, skipping settings load');
            return;
        }

        try {
            const layoutData = await loadLayoutData();
            if (layoutData.globalSettings) {
                // 合并设置（保留默认值作为fallback）
                state.globalSettings = {
                    ...DEFAULT_SETTINGS,
                    ...layoutData.globalSettings,
                    dock: {
                        ...DEFAULT_SETTINGS.dock,
                        ...(layoutData.globalSettings.dock || {}),
                    },
                };
                console.log('[GlobalSettings] Settings loaded from layout.json:', state.globalSettings);
            }
        } catch (err) {
            console.warn('[GlobalSettings] Load settings unavailable:', err.message);
        }
    }

    /**
     * 辅助：加载 layout.json 完整数据
     */
    async function loadLayoutData() {
        try {
            const result = await window.electronAPI.desktopLoadLayout();
            if (result?.success && result.data) {
                return result.data;
            }
        } catch (err) {
            console.error('[GlobalSettings] Load layout data error:', err);
        }
        return {};
    }

    // ============================================================
    // Dock 计数器 UI 交互
    // ============================================================

    /**
     * 初始化数值选择器的加减按钮（在 DOM 准备好后调用）
     */
    function initNumberControls() {
        // Dock 可见数量 - / +
        const minusBtn = document.getElementById('desktop-setting-dock-count-minus');
        const plusBtn = document.getElementById('desktop-setting-dock-count-plus');
        const valueEl = document.getElementById('desktop-setting-dock-count-value');

        if (minusBtn && plusBtn && valueEl) {
            minusBtn.addEventListener('click', () => {
                let val = parseInt(valueEl.textContent) || DEFAULT_SETTINGS.dock.maxVisible;
                if (val > 2) {
                    val--;
                    valueEl.textContent = val;
                }
            });
            plusBtn.addEventListener('click', () => {
                let val = parseInt(valueEl.textContent) || DEFAULT_SETTINGS.dock.maxVisible;
                if (val < 20) {
                    val++;
                    valueEl.textContent = val;
                }
            });
        }

        // Dock 图标大小滑块
        const sizeRange = document.getElementById('desktop-setting-dock-size');
        const sizeLabel = document.getElementById('desktop-setting-dock-size-label');
        if (sizeRange && sizeLabel) {
            sizeRange.addEventListener('input', () => {
                sizeLabel.textContent = `${sizeRange.value}px`;
            });
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.globalSettings = {
        init,
        open: openSettingsModal,
        close: closeSettingsModal,
        save: saveSettings,
        load: loadSettings,
        apply: applySettings,
        applyOnStartup,
        initNumberControls,
    };

})();