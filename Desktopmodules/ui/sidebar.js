/**
 * VCPdesktop - 侧栏系统模块（分页版）
 * 负责：分页标签切换、官方挂件列表、收藏卡片渲染、布局预设管理、拖拽到桌面
 */

'use strict';

(function () {
    const { state, domRefs } = window.VCPDesktop;

    let currentTab = 'widgets';

    // 官方内置挂件注册表
    const BUILTIN_WIDGETS = [
        { id: 'builtinWeather', name: '天气预报', icon: '🌤️', description: '实时天气数据与预报', spawnKey: 'builtinWeather' },
        { id: 'builtinNews', name: '今日热点', icon: '📰', description: '多源新闻热点聚合', spawnKey: 'builtinNews' },
        { id: 'builtinMusic', name: '音乐播放条', icon: '🎵', description: '迷你音乐控制器', spawnKey: 'builtinMusic' },
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
                await window.electronAPI.desktopSaveLayout({ presets: existing });

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

        presets.forEach(preset => {
            const card = document.createElement('div');
            card.className = 'desktop-sidebar-preset-card';

            const info = document.createElement('div');
            info.className = 'desktop-sidebar-preset-info';

            const name = document.createElement('div');
            name.className = 'desktop-sidebar-preset-name';
            name.textContent = preset.name;
            info.appendChild(name);

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

            const delBtn = document.createElement('button');
            delBtn.className = 'desktop-sidebar-card-btn desktop-sidebar-card-btn-del';
            delBtn.textContent = '🗑';
            delBtn.title = '删除预设';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`确定删除预设 "${preset.name}" 吗？`)) {
                    await deletePreset(preset.id);
                }
            });
            actions.appendChild(delBtn);

            card.appendChild(actions);

            // 点击应用
            card.addEventListener('click', () => {
                applyPreset(preset);
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
            await window.electronAPI.desktopSaveLayout({ presets: filtered });
            loadPresetList();
        } catch (err) {
            console.error('[Sidebar] Delete preset error:', err);
        }
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
    };

})();