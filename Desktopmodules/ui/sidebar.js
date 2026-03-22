/**
 * VCPdesktop - 侧栏系统模块（分页版）
 * 负责：分页标签切换、官方挂件列表、收藏卡片渲染、布局预设管理、拖拽到桌面
 */

'use strict';

(function () {
    const { state, domRefs } = window.VCPDesktop;

    let currentTab = 'widgets';
    let presetContextMenu = null; // 预设右键菜单元素

    // 官方内置挂件注册表
    const BUILTIN_WIDGETS = [
        { id: 'builtinWeather', name: '天气预报', icon: '🌤️', description: '实时天气数据与预报', spawnKey: 'builtinWeather' },
        { id: 'builtinNews', name: '今日热点', icon: '📰', description: '多源新闻热点聚合', spawnKey: 'builtinNews' },
        { id: 'builtinMusic', name: '音乐播放条', icon: '🎵', description: '迷你音乐控制器', spawnKey: 'builtinMusic' },
        { id: 'builtinAppTray', name: '应用托盘', icon: '📦', description: '网格浏览全部应用，拖拽到桌面', spawnKey: 'builtinAppTray' },
    ];

    // ============================================================
    // 初始化
    // ============================================================

    function initSidebar() {
        const sidebar = document.getElementById('desktop-sidebar');
        if (!sidebar) return;

        // 关闭按钮
        sidebar.querySelector('.desktop-sidebar-close')?.addEventListener('click', () => {
            toggleSidebar(false);
        });

        // 分页标签事件
        const tabs = sidebar.querySelectorAll('.desktop-sidebar-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                switchTab(tab.dataset.tab);
            });
        });

        // 保存预设按钮
        const savePresetBtn = document.getElementById('desktop-sidebar-save-preset');
        if (savePresetBtn) {
            savePresetBtn.addEventListener('click', () => {
                saveCurrentLayoutAsPreset();
            });
        }

        // 渲染官方挂件列表
        renderBuiltinWidgets();
    }

    // ============================================================
    // 分页标签切换
    // ============================================================

    function switchTab(tabName) {
        const sidebar = document.getElementById('desktop-sidebar');
        if (!sidebar) return;

        currentTab = tabName;

        // 更新标签样式
        sidebar.querySelectorAll('.desktop-sidebar-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // 切换页面显示
        sidebar.querySelectorAll('.desktop-sidebar-page').forEach(page => {
            page.classList.toggle('active', page.id === `desktop-sidebar-page-${tabName}`);
        });

        // 切换到对应页时刷新数据
        if (tabName === 'favorites' && window.VCPDesktop.favorites) {
            window.VCPDesktop.favorites.loadList();
        } else if (tabName === 'presets') {
            loadPresetList();
        }
    }

    // ============================================================
    // 侧栏开关
    // ============================================================

    function toggleSidebar(forceState) {
        const sidebar = document.getElementById('desktop-sidebar');
        if (!sidebar) return;

        const shouldOpen = forceState !== undefined ? forceState : !state.sidebarOpen;
        state.sidebarOpen = shouldOpen;

        if (shouldOpen) {
            sidebar.classList.add('open');
            // 刷新当前页签内容
            if (currentTab === 'favorites' && window.VCPDesktop.favorites) {
                window.VCPDesktop.favorites.loadList();
            } else if (currentTab === 'presets') {
                loadPresetList();
            }
        } else {
            sidebar.classList.remove('open');
        }
    }

    // ============================================================
    // 官方挂件列表
    // ============================================================

    function renderBuiltinWidgets() {
        const container = document.getElementById('desktop-sidebar-builtin-list');
        if (!container) return;

        container.innerHTML = '';

        BUILTIN_WIDGETS.forEach(widget => {
            const card = document.createElement('div');
            card.className = 'desktop-sidebar-builtin-card';
            card.draggable = true;

            const iconSpan = document.createElement('span');
            iconSpan.className = 'desktop-sidebar-builtin-icon';
            iconSpan.textContent = widget.icon;
            card.appendChild(iconSpan);

            const info = document.createElement('div');
            info.className = 'desktop-sidebar-builtin-info';

            const name = document.createElement('div');
            name.className = 'desktop-sidebar-builtin-name';
            name.textContent = widget.name;
            info.appendChild(name);

            const desc = document.createElement('div');
            desc.className = 'desktop-sidebar-builtin-desc';
            desc.textContent = widget.description;
            info.appendChild(desc);

            card.appendChild(info);

            const addBtn = document.createElement('button');
            addBtn.className = 'desktop-sidebar-card-btn';
            addBtn.textContent = '📤';
            addBtn.title = '放置到桌面';
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                spawnBuiltinWidget(widget.spawnKey);
            });
            card.appendChild(addBtn);

            // 点击也可以生成
            card.addEventListener('click', () => {
                spawnBuiltinWidget(widget.spawnKey);
            });

            // 拖拽支持
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-desktop-builtin-widget', widget.spawnKey);
                e.dataTransfer.effectAllowed = 'copy';
                card.classList.add('dragging');
            });
            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
            });

            container.appendChild(card);
        });
    }

    /**
     * 生成内置挂件
     */
    function spawnBuiltinWidget(spawnKey) {
        const D = window.VCPDesktop;
        if (D[spawnKey] && D[spawnKey].spawn) {
            D[spawnKey].spawn();
        } else {
            console.warn(`[Sidebar] Builtin widget not found: ${spawnKey}`);
        }
    }

    // ============================================================
    // 收藏列表渲染（保持原有逻辑）
    // ============================================================

    function renderSidebarFavorites() {
        const listContainer = document.getElementById('desktop-sidebar-list');
        if (!listContainer) return;

        listContainer.innerHTML = '';

        if (state.favorites.length === 0) {
            listContainer.innerHTML = '<div class="desktop-sidebar-empty">暂无收藏</div>';
            return;
        }

        state.favorites.forEach(fav => {
            const card = document.createElement('div');
            card.className = 'desktop-sidebar-card';
            card.dataset.favId = fav.id;
            card.draggable = true;

            // 缩略图
            const thumb = document.createElement('div');
            thumb.className = 'desktop-sidebar-card-thumb';
            if (fav.thumbnail) {
                thumb.style.backgroundImage = `url(${fav.thumbnail})`;
            } else {
                thumb.textContent = '📦';
                thumb.style.display = 'flex';
                thumb.style.alignItems = 'center';
                thumb.style.justifyContent = 'center';
                thumb.style.fontSize = '24px';
            }
            card.appendChild(thumb);

            // 信息区
            const info = document.createElement('div');
            info.className = 'desktop-sidebar-card-info';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'desktop-sidebar-card-name';
            nameSpan.textContent = fav.name;
            info.appendChild(nameSpan);

            // 操作按钮组
            const actions = document.createElement('div');
            actions.className = 'desktop-sidebar-card-actions';

            const loadBtn = document.createElement('button');
            loadBtn.className = 'desktop-sidebar-card-btn';
            loadBtn.textContent = '📤';
            loadBtn.title = '放置到桌面';
            loadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.VCPDesktop.favorites) {
                    window.VCPDesktop.favorites.spawnFromFavorite(fav.id);
                }
            });
            actions.appendChild(loadBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'desktop-sidebar-card-btn desktop-sidebar-card-btn-del';
            delBtn.textContent = '🗑';
            delBtn.title = '删除收藏';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`确定删除收藏 "${fav.name}" 吗？`)) {
                    if (window.VCPDesktop.favorites) {
                        window.VCPDesktop.favorites.deleteFavorite(fav.id);
                    }
                }
            });
            actions.appendChild(delBtn);

            info.appendChild(actions);
            card.appendChild(info);

            // 拖拽开始
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-desktop-fav-id', fav.id);
                e.dataTransfer.effectAllowed = 'copy';
                card.classList.add('dragging');
            });

            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
            });

            listContainer.appendChild(card);
        });
    }

    // ============================================================
    // 布局预设系统
    // ============================================================

    /**
     * 保存当前桌面布局为预设
     */
    async function saveCurrentLayoutAsPreset() {
        // 使用自定义模态窗代替 prompt()（Electron 中 prompt() 不可用）
        const name = await showInputModal('保存布局预设', '为当前布局取一个名字：', `布局 ${new Date().toLocaleDateString()}`);
        if (!name || !name.trim()) return;

        // 收集当前桌面上所有挂件的状态
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

        // 收集桌面图标
        const iconStates = state.desktopIcons.map(icon => ({...icon}));

        const preset = {
            id: `preset_${Date.now()}`,
            name: name.trim(),
            createdAt: Date.now(),
            widgets: widgetStates,
            desktopIcons: iconStates,
            dock: {
                items: state.dock.items.map(i => ({...i})),
                maxVisible: state.dock.maxVisible,
            },
        };

        // 保存到磁盘
        if (window.electronAPI?.desktopSaveLayout) {
            try {
                // 加载已有预设
                const existing = await loadPresetsFromDisk();
                existing.push(preset);
                await savePresetsAndKeepSettings(existing);

                if (window.VCPDesktop.status) {
                    window.VCPDesktop.status.update('connected', `布局预设已保存: ${name}`);
                    window.VCPDesktop.status.show();
                    setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                }

                // 刷新列表
                loadPresetList();
            } catch (err) {
                console.error('[Sidebar] Save preset error:', err);
            }
        }
    }

    /**
     * 从磁盘加载预设列表
     */
    async function loadPresetsFromDisk() {
        if (!window.electronAPI?.desktopLoadLayout) return [];
        try {
            const result = await window.electronAPI.desktopLoadLayout();
            if (result?.success && result.data && result.data.presets) {
                return result.data.presets;
            }
        } catch (err) {
            console.error('[Sidebar] Load presets error:', err);
        }
        return [];
    }

    /**
     * 保存预设列表，同时保留 layout.json 中的 globalSettings 等其他字段
     */
    async function savePresetsAndKeepSettings(presets) {
        if (!window.electronAPI?.desktopSaveLayout) return;
        try {
            // 读取现有数据以保留 globalSettings 等字段
            let existingData = {};
            if (window.electronAPI?.desktopLoadLayout) {
                const result = await window.electronAPI.desktopLoadLayout();
                if (result?.success && result.data) {
                    existingData = result.data;
                }
            }
            // 更新预设列表，保留其他字段
            existingData.presets = presets;
            await window.electronAPI.desktopSaveLayout(existingData);
        } catch (err) {
            console.error('[Sidebar] Save presets error:', err);
        }
    }

    /**
     * 渲染预设列表
     */
    async function loadPresetList() {
        const container = document.getElementById('desktop-sidebar-preset-list');
        if (!container) return;

        const presets = await loadPresetsFromDisk();
        container.innerHTML = '';

        if (presets.length === 0) {
            container.innerHTML = '<div class="desktop-sidebar-empty">暂无布局预设<br><span style="font-size:11px;opacity:0.5;">点击上方按钮保存当前桌面布局</span></div>';
            return;
        }

        // 获取默认预设ID
        const defaultPresetId = state.globalSettings?.defaultPresetId || null;

        presets.forEach(preset => {
            const card = document.createElement('div');
            card.className = 'desktop-sidebar-preset-card';

            // 标记默认预设
            if (preset.id === defaultPresetId) {
                card.classList.add('default-preset');
            }

            const info = document.createElement('div');
            info.className = 'desktop-sidebar-preset-info';

            const nameRow = document.createElement('div');
            nameRow.className = 'desktop-sidebar-preset-name-row';

            const name = document.createElement('div');
            name.className = 'desktop-sidebar-preset-name';
            name.textContent = preset.name;
            nameRow.appendChild(name);

            // 默认预设标记
            if (preset.id === defaultPresetId) {
                const badge = document.createElement('span');
                badge.className = 'desktop-sidebar-preset-default-badge';
                badge.textContent = '默认';
                badge.title = '启动时自动加载';
                nameRow.appendChild(badge);
            }

            info.appendChild(nameRow);

            const meta = document.createElement('div');
            meta.className = 'desktop-sidebar-preset-meta';
            const widgetCount = preset.widgets?.length || 0;
            const iconCount = preset.desktopIcons?.length || 0;
            const date = new Date(preset.createdAt).toLocaleDateString();
            meta.textContent = `${widgetCount} 挂件 · ${iconCount} 图标 · ${date}`;
            info.appendChild(meta);

            card.appendChild(info);

            // 操作按钮
            const actions = document.createElement('div');
            actions.className = 'desktop-sidebar-card-actions';

            const loadBtn = document.createElement('button');
            loadBtn.className = 'desktop-sidebar-card-btn';
            loadBtn.textContent = '📤';
            loadBtn.title = '应用此布局';
            loadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                applyPreset(preset);
            });
            actions.appendChild(loadBtn);

            card.appendChild(actions);

            // 点击应用
            card.addEventListener('click', () => {
                applyPreset(preset);
            });

            // 右键菜单
            card.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showPresetContextMenu(e.clientX, e.clientY, preset);
            });

            container.appendChild(card);
        });
    }

    /**
     * 应用布局预设
     */
    async function applyPreset(preset) {
        const D = window.VCPDesktop;

        // 清除当前桌面
        D.widget.clearAll();

        // 清除桌面图标
        const canvas = domRefs.canvas;
        if (canvas) {
            canvas.querySelectorAll('.desktop-shortcut-icon').forEach(el => el.remove());
        }
        state.desktopIcons = [];

        // 恢复挂件
        if (preset.widgets && preset.widgets.length > 0) {
            for (const w of preset.widgets) {
                if (w.isBuiltin) {
                    // 内置挂件
                    const builtinKey = w.widgetId.replace('builtin-', 'builtin');
                    const capKey = 'builtin' + builtinKey.charAt(7).toUpperCase() + builtinKey.slice(8);
                    // 尝试匹配: builtin-weather -> builtinWeather
                    const parts = w.widgetId.split('-');
                    if (parts.length >= 2) {
                        const spawnKey = parts[0] + parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
                        if (D[spawnKey] && D[spawnKey].spawn) {
                            D[spawnKey].spawn();
                        }
                    }
                } else if (w.savedId) {
                    // 收藏挂件
                    if (D.favorites) {
                        await D.favorites.spawnFromFavorite(w.savedId, w.x, w.y);
                    }
                }
            }
        }

        // 恢复桌面图标
        if (preset.desktopIcons && preset.desktopIcons.length > 0 && D.dock) {
            for (const icon of preset.desktopIcons) {
                D.dock.createDesktopIcon(icon, icon.x + 32, icon.y + 32);
            }
        }

        if (D.status) {
            D.status.update('connected', `已应用布局: ${preset.name}`);
            D.status.show();
            setTimeout(() => D.status.hide(), 3000);
        }
    }

    /**
     * 删除预设
     */
    async function deletePreset(presetId) {
        if (!window.electronAPI?.desktopSaveLayout) return;

        try {
            const presets = await loadPresetsFromDisk();
            const filtered = presets.filter(p => p.id !== presetId);
            await savePresetsAndKeepSettings(filtered);

            // 如果删除的是默认预设，清除默认设置
            if (state.globalSettings?.defaultPresetId === presetId) {
                state.globalSettings.defaultPresetId = null;
                if (window.VCPDesktop.globalSettings) {
                    window.VCPDesktop.globalSettings.save();
                }
            }

            loadPresetList();
        } catch (err) {
            console.error('[Sidebar] Delete preset error:', err);
        }
    }

    // ============================================================
    // 预设右键菜单
    // ============================================================

    /**
     * 显示预设右键菜单
     */
    function showPresetContextMenu(x, y, preset) {
        // 移除旧菜单
        hidePresetContextMenu();

        const defaultPresetId = state.globalSettings?.defaultPresetId || null;
        const isDefault = preset.id === defaultPresetId;

        presetContextMenu = document.createElement('div');
        presetContextMenu.className = 'desktop-context-menu visible';
        presetContextMenu.style.left = `${x}px`;
        presetContextMenu.style.top = `${y}px`;
        presetContextMenu.style.visibility = 'hidden';

        // 应用布局
        const applyBtn = document.createElement('button');
        applyBtn.className = 'desktop-context-menu-item';
        applyBtn.textContent = '📤 应用布局';
        applyBtn.addEventListener('click', () => {
            hidePresetContextMenu();
            applyPreset(preset);
        });
        presetContextMenu.appendChild(applyBtn);

        // 分隔线
        const divider1 = document.createElement('div');
        divider1.className = 'desktop-context-menu-divider';
        presetContextMenu.appendChild(divider1);

        // 重命名
        const renameBtn = document.createElement('button');
        renameBtn.className = 'desktop-context-menu-item';
        renameBtn.textContent = '✏️ 重命名';
        renameBtn.addEventListener('click', async () => {
            hidePresetContextMenu();
            await renamePreset(preset);
        });
        presetContextMenu.appendChild(renameBtn);

        // 设为默认预设 / 取消默认
        const defaultBtn = document.createElement('button');
        defaultBtn.className = 'desktop-context-menu-item';
        if (isDefault) {
            defaultBtn.textContent = '⭐ 取消默认预设';
        } else {
            defaultBtn.textContent = '⭐ 设为默认预设';
        }
        defaultBtn.addEventListener('click', () => {
            hidePresetContextMenu();
            toggleDefaultPreset(preset.id, isDefault);
        });
        presetContextMenu.appendChild(defaultBtn);

        // 分隔线
        const divider2 = document.createElement('div');
        divider2.className = 'desktop-context-menu-divider';
        presetContextMenu.appendChild(divider2);

        // 删除
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'desktop-context-menu-item desktop-context-menu-item-danger';
        deleteBtn.textContent = '🗑 删除预设';
        deleteBtn.addEventListener('click', async () => {
            hidePresetContextMenu();
            const confirmMsg = `确定删除预设 "${preset.name}" 吗？`;
            const confirmed = await showConfirmModal('删除预设', confirmMsg);
            if (confirmed) {
                await deletePreset(preset.id);
            }
        });
        presetContextMenu.appendChild(deleteBtn);

        document.body.appendChild(presetContextMenu);

        // 边界避让
        requestAnimationFrame(() => {
            if (!presetContextMenu) return;
            const rect = presetContextMenu.getBoundingClientRect();
            let adjustedX = x;
            let adjustedY = y;
            if (rect.bottom > window.innerHeight - 10) adjustedY = y - rect.height;
            if (rect.right > window.innerWidth - 10) adjustedX = x - rect.width;
            if (adjustedY < 10) adjustedY = 10;
            if (adjustedX < 10) adjustedX = 10;
            presetContextMenu.style.left = `${adjustedX}px`;
            presetContextMenu.style.top = `${adjustedY}px`;
            presetContextMenu.style.visibility = '';
        });

        // 点击其他地方关闭
        const closeHandler = (e) => {
            if (presetContextMenu && !presetContextMenu.contains(e.target)) {
                hidePresetContextMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    /**
     * 隐藏预设右键菜单
     */
    function hidePresetContextMenu() {
        if (presetContextMenu) {
            presetContextMenu.remove();
            presetContextMenu = null;
        }
    }

    /**
     * 重命名预设
     */
    async function renamePreset(preset) {
        const newName = await showInputModal('重命名预设', '输入新的预设名称：', preset.name);
        if (!newName || newName === preset.name) return;

        try {
            const presets = await loadPresetsFromDisk();
            const target = presets.find(p => p.id === preset.id);
            if (target) {
                target.name = newName;
                await savePresetsAndKeepSettings(presets);

                if (window.VCPDesktop.status) {
                    window.VCPDesktop.status.update('connected', `预设已重命名: ${newName}`);
                    window.VCPDesktop.status.show();
                    setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                }

                loadPresetList();
            }
        } catch (err) {
            console.error('[Sidebar] Rename preset error:', err);
        }
    }

    /**
     * 设为/取消默认预设
     */
    function toggleDefaultPreset(presetId, isCurrentlyDefault) {
        if (!state.globalSettings) {
            state.globalSettings = {};
        }

        if (isCurrentlyDefault) {
            state.globalSettings.defaultPresetId = null;
            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('connected', '已取消默认预设');
                window.VCPDesktop.status.show();
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        } else {
            state.globalSettings.defaultPresetId = presetId;
            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('connected', '已设为默认预设（下次启动自动加载）');
                window.VCPDesktop.status.show();
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        }

        // 保存全局设置
        if (window.VCPDesktop.globalSettings) {
            window.VCPDesktop.globalSettings.save();
        }

        // 刷新列表显示
        loadPresetList();
    }

    /**
     * 显示确认模态窗
     * @param {string} title - 标题
     * @param {string} message - 描述
     * @returns {Promise<boolean>}
     */
    function showConfirmModal(title, message) {
        return new Promise((resolve) => {
            const modal = document.getElementById('desktop-save-modal');
            if (!modal) {
                resolve(false);
                return;
            }

            const titleEl = modal.querySelector('.desktop-modal-title');
            const descEl = modal.querySelector('.desktop-modal-desc');
            const input = modal.querySelector('.desktop-modal-input');
            const cancelBtn = modal.querySelector('.desktop-modal-cancel');
            const confirmBtn = modal.querySelector('.desktop-modal-confirm');

            const origTitle = titleEl?.textContent;
            const origDesc = descEl?.textContent;
            const origConfirm = confirmBtn?.textContent;

            if (titleEl) titleEl.textContent = title;
            if (descEl) descEl.textContent = message;
            if (confirmBtn) confirmBtn.textContent = '确认删除';
            if (input) input.style.display = 'none';

            delete modal.dataset.targetWidgetId;
            modal.classList.add('visible');

            let resolved = false;

            function cleanup() {
                if (resolved) return;
                resolved = true;
                modal.classList.remove('visible');
                if (titleEl) titleEl.textContent = origTitle;
                if (descEl) descEl.textContent = origDesc;
                if (confirmBtn) confirmBtn.textContent = origConfirm;
                if (input) input.style.display = '';
                cancelBtn?.removeEventListener('click', onCancel);
                confirmBtn?.removeEventListener('click', onConfirm);
                modal.removeEventListener('click', onOverlay);
            }

            function onCancel() {
                cleanup();
                resolve(false);
            }

            function onConfirm() {
                cleanup();
                resolve(true);
            }

            function onOverlay(e) {
                if (e.target === modal) onCancel();
            }

            cancelBtn?.addEventListener('click', onCancel);
            confirmBtn?.addEventListener('click', onConfirm);
            modal.addEventListener('click', onOverlay);
        });
    }

    // ============================================================
    // 通用输入模态窗（替代 prompt()）
    // ============================================================

    /**
     * 显示一个自定义的输入模态窗，返回用户输入的文本
     * @param {string} title - 标题
     * @param {string} description - 描述文案
     * @param {string} defaultValue - 默认值
     * @returns {Promise<string|null>} 用户输入的文本，取消则返回 null
     */
    function showInputModal(title, description, defaultValue = '') {
        return new Promise((resolve) => {
            const modal = document.getElementById('desktop-save-modal');
            if (!modal) {
                resolve(null);
                return;
            }

            const titleEl = modal.querySelector('.desktop-modal-title');
            const descEl = modal.querySelector('.desktop-modal-desc');
            const input = modal.querySelector('.desktop-modal-input');
            const cancelBtn = modal.querySelector('.desktop-modal-cancel');
            const confirmBtn = modal.querySelector('.desktop-modal-confirm');

            // 保存原始内容以便恢复
            const origTitle = titleEl?.textContent;
            const origDesc = descEl?.textContent;
            const origConfirm = confirmBtn?.textContent;

            // 设置新内容
            if (titleEl) titleEl.textContent = title;
            if (descEl) descEl.textContent = description;
            if (confirmBtn) confirmBtn.textContent = '确认';
            if (input) input.value = defaultValue;

            // 清除之前的 widgetId 标记（避免 saveModal 的原始逻辑干扰）
            delete modal.dataset.targetWidgetId;

            modal.classList.add('visible');
            setTimeout(() => input?.focus(), 100);

            let resolved = false;

            function cleanup() {
                if (resolved) return;
                resolved = true;
                modal.classList.remove('visible');
                // 恢复原始内容
                if (titleEl) titleEl.textContent = origTitle;
                if (descEl) descEl.textContent = origDesc;
                if (confirmBtn) confirmBtn.textContent = origConfirm;
                // 移除临时事件
                cancelBtn?.removeEventListener('click', onCancel);
                confirmBtn?.removeEventListener('click', onConfirm);
                input?.removeEventListener('keydown', onKeydown);
                modal.removeEventListener('click', onOverlay);
            }

            function onCancel() {
                cleanup();
                resolve(null);
            }

            function onConfirm() {
                const val = input?.value?.trim();
                if (!val) {
                    input?.classList.add('error');
                    setTimeout(() => input?.classList.remove('error'), 600);
                    return;
                }
                cleanup();
                resolve(val);
            }

            function onKeydown(e) {
                if (e.key === 'Enter') onConfirm();
                if (e.key === 'Escape') onCancel();
            }

            function onOverlay(e) {
                if (e.target === modal) onCancel();
            }

            cancelBtn?.addEventListener('click', onCancel);
            confirmBtn?.addEventListener('click', onConfirm);
            input?.addEventListener('keydown', onKeydown);
            modal.addEventListener('click', onOverlay);
        });
    }

    // ============================================================
    // 画布拖放接收
    // ============================================================

    function initCanvasDrop() {
        const canvas = domRefs.canvas;
        if (!canvas) return;

        canvas.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('application/x-desktop-fav-id') ||
                e.dataTransfer.types.includes('application/x-desktop-builtin-widget')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        canvas.addEventListener('drop', (e) => {
            // 收藏挂件拖入
            const favId = e.dataTransfer.getData('application/x-desktop-fav-id');
            if (favId) {
                e.preventDefault();
                if (window.VCPDesktop.favorites) {
                    window.VCPDesktop.favorites.spawnFromFavorite(favId, e.clientX - 100, e.clientY - 30);
                }
                return;
            }

            // 内置挂件拖入
            const builtinKey = e.dataTransfer.getData('application/x-desktop-builtin-widget');
            if (builtinKey) {
                e.preventDefault();
                spawnBuiltinWidget(builtinKey);
                return;
            }
        });
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.sidebar = {
        init: initSidebar,
        toggle: toggleSidebar,
        render: renderSidebarFavorites,
        initCanvasDrop,
        switchTab,
        applyPreset,
    };

})();