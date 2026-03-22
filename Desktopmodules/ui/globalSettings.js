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
 *   - wallpaper: 自定义壁纸配置
 */

'use strict';

(function () {
    const { state } = window.VCPDesktop;

    // 默认壁纸设置
    const DEFAULT_WALLPAPER = {
        enabled: false,
        type: 'none',
        source: '',
        filePath: '',
        opacity: 1,
        blur: 0,
        brightness: 1,
        videoMuted: true,
        videoPlaybackRate: 1,
    };

    // 默认设置
    const DEFAULT_SETTINGS = {
        autoMaximize: false,
        alwaysOnBottom: false,
        visibilityFreezerEnabled: true,
        defaultPresetId: null,
        dock: {
            maxVisible: 8,
            iconSize: 32,       // px
            position: 'bottom', // 'top' | 'bottom' | 'left' | 'right'
            edgeDistance: 12,    // px
        },
        desktopIcon: {
            gridSnap: false,    // 桌面应用图标网格对齐
            iconSize: 40,       // 桌面应用图标大小 (px)
        },
        wallpaper: { ...DEFAULT_WALLPAPER },
    };

    let overlayEl = null;

    // ============================================================
    // 初始化
    // ============================================================

    async function init() {
        // 确保 state.globalSettings 存在
        if (!state.globalSettings) {
            state.globalSettings = {
                ...DEFAULT_SETTINGS,
                dock: { ...DEFAULT_SETTINGS.dock },
                wallpaper: { ...DEFAULT_WALLPAPER },
            };
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

        // 初始化壁纸 UI 控件事件绑定
        initWallpaperControls();
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

        // 可见性冻结开关
        const freezerEl = document.getElementById('desktop-setting-visibility-freezer');
        if (freezerEl) freezerEl.checked = s.visibilityFreezerEnabled !== false;

        // Dock 位置
        const dockPosition = s.dock?.position || DEFAULT_SETTINGS.dock.position;
        const posBtns = document.querySelectorAll('.desktop-settings-dock-pos-btn');
        posBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.pos === dockPosition);
        });

        // Dock 边缘距离
        const edgeDistEl = document.getElementById('desktop-setting-dock-edge-distance');
        const edgeDistLabel = document.getElementById('desktop-setting-dock-edge-distance-label');
        const edgeDist = s.dock?.edgeDistance ?? DEFAULT_SETTINGS.dock.edgeDistance;
        if (edgeDistEl) edgeDistEl.value = edgeDist;
        if (edgeDistLabel) edgeDistLabel.textContent = `${edgeDist}px`;

        // Dock 可见图标数
        const dockCountEl = document.getElementById('desktop-setting-dock-count-value');
        if (dockCountEl) dockCountEl.textContent = s.dock?.maxVisible || DEFAULT_SETTINGS.dock.maxVisible;

        // Dock 图标大小
        const dockSizeEl = document.getElementById('desktop-setting-dock-size');
        const dockSizeLabelEl = document.getElementById('desktop-setting-dock-size-label');
        if (dockSizeEl) dockSizeEl.value = s.dock?.iconSize || DEFAULT_SETTINGS.dock.iconSize;
        if (dockSizeLabelEl) dockSizeLabelEl.textContent = `${s.dock?.iconSize || DEFAULT_SETTINGS.dock.iconSize}px`;

        // 桌面图标 - 网格对齐
        const gridSnapEl = document.getElementById('desktop-setting-icon-grid-snap');
        if (gridSnapEl) gridSnapEl.checked = !!(s.desktopIcon?.gridSnap);

        // 桌面图标 - 图标大小
        const iconSizeEl = document.getElementById('desktop-setting-icon-size');
        const iconSizeLabel = document.getElementById('desktop-setting-icon-size-label');
        const size = s.desktopIcon?.iconSize || DEFAULT_SETTINGS.desktopIcon.iconSize;
        if (iconSizeEl) iconSizeEl.value = size;
        if (iconSizeLabel) iconSizeLabel.textContent = `${size}px`;

        // 壁纸设置
        populateWallpaperUI();
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

        const freezerEl = document.getElementById('desktop-setting-visibility-freezer');
        if (freezerEl) s.visibilityFreezerEnabled = freezerEl.checked;

        // Dock 位置
        const activePos = document.querySelector('.desktop-settings-dock-pos-btn.active');
        if (activePos) {
            s.dock.position = activePos.dataset.pos || 'bottom';
        }

        // Dock 边缘距离
        const edgeDistEl = document.getElementById('desktop-setting-dock-edge-distance');
        if (edgeDistEl) {
            const val = parseInt(edgeDistEl.value);
            if (!isNaN(val) && val >= 0 && val <= 60) {
                s.dock.edgeDistance = val;
            }
        }

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

        // 桌面图标 - 网格对齐
        const gridSnapEl = document.getElementById('desktop-setting-icon-grid-snap');
        if (gridSnapEl) {
            if (!s.desktopIcon) s.desktopIcon = { ...DEFAULT_SETTINGS.desktopIcon };
            s.desktopIcon.gridSnap = gridSnapEl.checked;
        }

        // 桌面图标 - 图标大小
        const iconSizeEl = document.getElementById('desktop-setting-icon-size');
        if (iconSizeEl) {
            if (!s.desktopIcon) s.desktopIcon = { ...DEFAULT_SETTINGS.desktopIcon };
            const val = parseInt(iconSizeEl.value);
            if (!isNaN(val) && val >= 24 && val <= 72) {
                s.desktopIcon.iconSize = val;
            }
        }

        // 读取壁纸 UI 值
        readWallpaperFromUI();

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
        state.globalSettings = {
            ...DEFAULT_SETTINGS,
            dock: { ...DEFAULT_SETTINGS.dock },
            desktopIcon: { ...DEFAULT_SETTINGS.desktopIcon },
            wallpaper: { ...DEFAULT_WALLPAPER },
        };
        populateUI();

        // 立即应用壁纸重置
        if (window.VCPDesktop.wallpaper) {
            window.VCPDesktop.wallpaper.apply(state.globalSettings.wallpaper);
        }

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

        // 2.5. 可见性冻结开关
        if (window.VCPDesktop.visibilityFreezer) {
            window.VCPDesktop.visibilityFreezer.setEnabled(s.visibilityFreezerEnabled !== false);
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

        // 4.5. Dock 位置和边缘距离
        if (window.VCPDesktop.dock && window.VCPDesktop.dock.applyPosition) {
            const pos = s.dock?.position || 'bottom';
            const dist = s.dock?.edgeDistance ?? 12;
            // 同步到 dock 运行时状态
            if (state.dock) {
                state.dock.position = pos;
                state.dock.edgeDistance = dist;
            }
            window.VCPDesktop.dock.applyPosition(pos, dist);
        }

        // 4.6. 桌面应用图标大小 - 通过 CSS 变量应用
        if (s.desktopIcon?.iconSize) {
            document.documentElement.style.setProperty('--desktop-shortcut-icon-size', `${s.desktopIcon.iconSize}px`);
        }

        // 5. 壁纸
        if (window.VCPDesktop.wallpaper) {
            window.VCPDesktop.wallpaper.apply(s.wallpaper);
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
                    desktopIcon: {
                        ...DEFAULT_SETTINGS.desktopIcon,
                        ...(layoutData.globalSettings.desktopIcon || {}),
                    },
                    wallpaper: {
                        ...DEFAULT_WALLPAPER,
                        ...(layoutData.globalSettings.wallpaper || {}),
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
        // Dock 位置选择器
        const posBtns = document.querySelectorAll('.desktop-settings-dock-pos-btn');
        posBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                posBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Dock 边缘距离滑块
        const edgeDistRange = document.getElementById('desktop-setting-dock-edge-distance');
        const edgeDistLabel = document.getElementById('desktop-setting-dock-edge-distance-label');
        if (edgeDistRange && edgeDistLabel) {
            edgeDistRange.addEventListener('input', () => {
                edgeDistLabel.textContent = `${edgeDistRange.value}px`;
            });
        }

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

        // 桌面图标大小滑块
        const iconSizeRange = document.getElementById('desktop-setting-icon-size');
        const iconSizeLabel = document.getElementById('desktop-setting-icon-size-label');
        if (iconSizeRange && iconSizeLabel) {
            iconSizeRange.addEventListener('input', () => {
                iconSizeLabel.textContent = `${iconSizeRange.value}px`;
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
    // 壁纸 UI 交互
    // ============================================================

    /**
     * 填充壁纸 UI 控件
     */
    function populateWallpaperUI() {
        const wp = state.globalSettings.wallpaper || DEFAULT_WALLPAPER;

        // 启用开关
        const enabledEl = document.getElementById('desktop-setting-wallpaper-enabled');
        if (enabledEl) enabledEl.checked = !!wp.enabled;

        // 显示/隐藏配置区域
        const configEl = document.getElementById('desktop-settings-wallpaper-config');
        if (configEl) configEl.style.display = wp.enabled ? '' : 'none';

        // 透明度
        const opacityEl = document.getElementById('desktop-setting-wallpaper-opacity');
        const opacityLabel = document.getElementById('desktop-setting-wallpaper-opacity-label');
        if (opacityEl) opacityEl.value = Math.round((wp.opacity || 1) * 100);
        if (opacityLabel) opacityLabel.textContent = `${Math.round((wp.opacity || 1) * 100)}%`;

        // 模糊度
        const blurEl = document.getElementById('desktop-setting-wallpaper-blur');
        const blurLabel = document.getElementById('desktop-setting-wallpaper-blur-label');
        if (blurEl) blurEl.value = wp.blur || 0;
        if (blurLabel) blurLabel.textContent = `${wp.blur || 0}px`;

        // 亮度
        const brightnessEl = document.getElementById('desktop-setting-wallpaper-brightness');
        const brightnessLabel = document.getElementById('desktop-setting-wallpaper-brightness-label');
        if (brightnessEl) brightnessEl.value = Math.round((wp.brightness || 1) * 100);
        if (brightnessLabel) brightnessLabel.textContent = `${Math.round((wp.brightness || 1) * 100)}%`;

        // 视频静音
        const videoMutedEl = document.getElementById('desktop-setting-wallpaper-video-muted');
        if (videoMutedEl) videoMutedEl.checked = wp.videoMuted !== false;

        // 视频播放速度
        const videoSpeedEl = document.getElementById('desktop-setting-wallpaper-video-speed');
        const videoSpeedLabel = document.getElementById('desktop-setting-wallpaper-video-speed-label');
        if (videoSpeedEl) videoSpeedEl.value = Math.round((wp.videoPlaybackRate || 1) * 100);
        if (videoSpeedLabel) videoSpeedLabel.textContent = `${(wp.videoPlaybackRate || 1).toFixed(1)}x`;

        // 显示/隐藏视频选项
        const videoOptionsEl = document.getElementById('desktop-settings-wallpaper-video-options');
        if (videoOptionsEl) videoOptionsEl.style.display = wp.type === 'video' ? '' : 'none';

        // 更新预览
        updateWallpaperPreview(wp);

        // 更新文件信息
        const infoEl = document.getElementById('desktop-settings-wallpaper-info');
        if (infoEl) {
            if (wp.filePath) {
                const typeLabels = { image: '🖼️ 图片', video: '🎬 视频', html: '🌐 HTML' };
                infoEl.textContent = `${typeLabels[wp.type] || wp.type} · ${wp.filePath}`;
            } else {
                infoEl.textContent = '';
            }
        }
    }

    /**
     * 更新壁纸预览区域
     */
    function updateWallpaperPreview(wp) {
        const previewEl = document.getElementById('desktop-settings-wallpaper-preview');
        if (!previewEl) return;

        previewEl.innerHTML = '';

        if (!wp.source || wp.type === 'none') {
            previewEl.innerHTML = '<div class="desktop-settings-wallpaper-preview-empty">未选择壁纸<br>支持图片、视频(mp4)、HTML动态壁纸</div>';
            return;
        }

        // 类型标记
        const badge = document.createElement('div');
        badge.className = 'desktop-settings-wallpaper-type-badge';
        const typeLabels = { image: '图片', video: '视频', html: 'HTML' };
        badge.textContent = typeLabels[wp.type] || wp.type;

        if (wp.type === 'image') {
            const img = document.createElement('img');
            img.src = wp.source;
            img.alt = '壁纸预览';
            img.onerror = () => {
                previewEl.innerHTML = '<div class="desktop-settings-wallpaper-preview-empty">图片加载失败</div>';
            };
            previewEl.appendChild(img);
        } else if (wp.type === 'video') {
            const video = document.createElement('video');
            video.src = wp.source;
            video.muted = true;
            video.autoplay = true;
            video.loop = true;
            video.playsInline = true;
            video.style.pointerEvents = 'none';
            previewEl.appendChild(video);
        } else if (wp.type === 'html') {
            // HTML 壁纸在预览中显示占位提示
            const placeholder = document.createElement('div');
            placeholder.className = 'desktop-settings-wallpaper-preview-empty';
            placeholder.innerHTML = '🌐 HTML 动态壁纸<br><span style="font-size:10px;opacity:0.5">保存后可在桌面预览效果</span>';
            previewEl.appendChild(placeholder);
        }

        previewEl.appendChild(badge);
    }

    /**
     * 从 UI 读取壁纸设置
     */
    function readWallpaperFromUI() {
        const s = state.globalSettings;
        if (!s.wallpaper) s.wallpaper = { ...DEFAULT_WALLPAPER };

        const enabledEl = document.getElementById('desktop-setting-wallpaper-enabled');
        if (enabledEl) s.wallpaper.enabled = enabledEl.checked;

        const opacityEl = document.getElementById('desktop-setting-wallpaper-opacity');
        if (opacityEl) s.wallpaper.opacity = parseInt(opacityEl.value) / 100;

        const blurEl = document.getElementById('desktop-setting-wallpaper-blur');
        if (blurEl) s.wallpaper.blur = parseInt(blurEl.value);

        const brightnessEl = document.getElementById('desktop-setting-wallpaper-brightness');
        if (brightnessEl) s.wallpaper.brightness = parseInt(brightnessEl.value) / 100;

        const videoMutedEl = document.getElementById('desktop-setting-wallpaper-video-muted');
        if (videoMutedEl) s.wallpaper.videoMuted = videoMutedEl.checked;

        const videoSpeedEl = document.getElementById('desktop-setting-wallpaper-video-speed');
        if (videoSpeedEl) s.wallpaper.videoPlaybackRate = parseInt(videoSpeedEl.value) / 100;
    }

    /**
     * 初始化壁纸相关的 UI 事件绑定
     */
    function initWallpaperControls() {
        // 壁纸启用开关
        const enabledEl = document.getElementById('desktop-setting-wallpaper-enabled');
        const configEl = document.getElementById('desktop-settings-wallpaper-config');
        if (enabledEl && configEl) {
            enabledEl.addEventListener('change', () => {
                configEl.style.display = enabledEl.checked ? '' : 'none';
            });
        }

        // 选择壁纸文件按钮
        const selectBtn = document.getElementById('desktop-setting-wallpaper-select');
        if (selectBtn) {
            selectBtn.addEventListener('click', async () => {
                if (!window.electronAPI?.desktopSelectWallpaper) {
                    console.warn('[GlobalSettings] desktopSelectWallpaper API not available');
                    return;
                }

                const result = await window.electronAPI.desktopSelectWallpaper();
                if (!result.success || result.canceled) return;

                const wp = state.globalSettings.wallpaper || (state.globalSettings.wallpaper = { ...DEFAULT_WALLPAPER });
                wp.type = result.type;
                wp.source = result.fileUrl;
                wp.filePath = result.filePath;
                wp.enabled = true;

                // 更新启用开关
                if (enabledEl) enabledEl.checked = true;
                if (configEl) configEl.style.display = '';

                // 显示/隐藏视频选项
                const videoOptionsEl = document.getElementById('desktop-settings-wallpaper-video-options');
                if (videoOptionsEl) videoOptionsEl.style.display = result.type === 'video' ? '' : 'none';

                // 更新预览
                updateWallpaperPreview(wp);

                // 更新文件信息
                const infoEl = document.getElementById('desktop-settings-wallpaper-info');
                if (infoEl) {
                    const typeLabels = { image: '🖼️ 图片', video: '🎬 视频', html: '🌐 HTML' };
                    infoEl.textContent = `${typeLabels[result.type] || result.type} · ${result.filePath}`;
                }

                console.log(`[GlobalSettings] Wallpaper selected: ${result.type} - ${result.filePath}`);
            });
        }

        // 移除壁纸按钮
        const clearBtn = document.getElementById('desktop-setting-wallpaper-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                const wp = state.globalSettings.wallpaper || (state.globalSettings.wallpaper = { ...DEFAULT_WALLPAPER });
                wp.type = 'none';
                wp.source = '';
                wp.filePath = '';

                // 更新预览
                updateWallpaperPreview(wp);

                // 清除文件信息
                const infoEl = document.getElementById('desktop-settings-wallpaper-info');
                if (infoEl) infoEl.textContent = '';

                // 隐藏视频选项
                const videoOptionsEl = document.getElementById('desktop-settings-wallpaper-video-options');
                if (videoOptionsEl) videoOptionsEl.style.display = 'none';
            });
        }

        // 透明度滑块
        const opacityEl = document.getElementById('desktop-setting-wallpaper-opacity');
        const opacityLabel = document.getElementById('desktop-setting-wallpaper-opacity-label');
        if (opacityEl && opacityLabel) {
            opacityEl.addEventListener('input', () => {
                opacityLabel.textContent = `${opacityEl.value}%`;
            });
        }

        // 模糊度滑块
        const blurEl = document.getElementById('desktop-setting-wallpaper-blur');
        const blurLabel = document.getElementById('desktop-setting-wallpaper-blur-label');
        if (blurEl && blurLabel) {
            blurEl.addEventListener('input', () => {
                blurLabel.textContent = `${blurEl.value}px`;
            });
        }

        // 亮度滑块
        const brightnessEl = document.getElementById('desktop-setting-wallpaper-brightness');
        const brightnessLabel = document.getElementById('desktop-setting-wallpaper-brightness-label');
        if (brightnessEl && brightnessLabel) {
            brightnessEl.addEventListener('input', () => {
                brightnessLabel.textContent = `${brightnessEl.value}%`;
            });
        }

        // 视频播放速度滑块
        const videoSpeedEl = document.getElementById('desktop-setting-wallpaper-video-speed');
        const videoSpeedLabel = document.getElementById('desktop-setting-wallpaper-video-speed-label');
        if (videoSpeedEl && videoSpeedLabel) {
            videoSpeedEl.addEventListener('input', () => {
                videoSpeedLabel.textContent = `${(parseInt(videoSpeedEl.value) / 100).toFixed(1)}x`;
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