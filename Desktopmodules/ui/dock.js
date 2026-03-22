
/**
 * VCPdesktop - Dock 栏系统模块
 * 负责：底部 Dock 栏渲染、快捷方式管理、拖拽到桌面、应用抽屉
 */

'use strict';

(function () {
    const { state, domRefs, CONSTANTS } = window.VCPDesktop;

    let dockElement = null;
    let dockItemsContainer = null;
    let dockDrawer = null;
    let dockDrawerList = null;
    let isDrawerOpen = false;

    // ============================================================
    // 初始化
    // ============================================================

    /**
     * 初始化 Dock 栏
     */
    function initDock() {
        dockElement = document.getElementById('desktop-dock');
        dockItemsContainer = document.getElementById('desktop-dock-items');
        dockDrawer = document.getElementById('desktop-dock-drawer');
        dockDrawerList = document.getElementById('desktop-dock-drawer-list');

        if (!dockElement) return;

        // 扫描按钮
        const scanBtn = document.getElementById('desktop-dock-scan-btn');
        if (scanBtn) {
            scanBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                scanWindowsShortcuts();
            });
        }

        // 更多按钮（展开抽屉）
        const moreBtn = document.getElementById('desktop-dock-more-btn');
        if (moreBtn) {
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDrawer();
            });
        }

        // 关闭抽屉按钮
        const drawerCloseBtn = document.getElementById('desktop-dock-drawer-close');
        if (drawerCloseBtn) {
            drawerCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDrawer(false);
            });
        }

        // 点击抽屉外部关闭
        if (dockDrawer) {
            dockDrawer.addEventListener('click', (e) => {
                if (e.target === dockDrawer) {
                    toggleDrawer(false);
                }
            });
        }

        // 初始化拖拽接收（从外部拖入 .lnk 文件）
        initFileDrop();

        // 加载已保存的 Dock 配置
        loadDockConfig();
    }

    // ============================================================
    // Dock 渲染
    // ============================================================

    /**
     * 渲染 Dock 中可见的图标
     */
    function renderDock() {
        if (!dockItemsContainer) return;

        dockItemsContainer.innerHTML = '';

        const visibleItems = state.dock.items.slice(0, state.dock.maxVisible);

        visibleItems.forEach((item, index) => {
            const iconEl = createDockIcon(item, index);
            dockItemsContainer.appendChild(iconEl);
        });

        // 更新"更多"按钮的可见性
        const moreBtn = document.getElementById('desktop-dock-more-btn');
        if (moreBtn) {
            moreBtn.style.display = state.dock.items.length > state.dock.maxVisible ? '' : 'none';
            const hiddenCount = state.dock.items.length - state.dock.maxVisible;
            if (hiddenCount > 0) {
                moreBtn.title = `还有 ${hiddenCount} 个应用`;
            }
        }

        // 分隔线：有图标时才显示
        const divider = dockElement?.querySelector('.desktop-dock-divider');
        if (divider) {
            divider.style.display = state.dock.items.length > 0 ? '' : 'none';
        }

        // Dock 始终显示（至少有扫描按钮）
        if (dockElement) {
            dockElement.style.display = 'flex';
        }
    }

    /**
     * 创建单个 Dock 图标元素
     */
    function createDockIcon(item, index) {
        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'desktop-dock-icon';
        iconWrapper.dataset.dockIndex = index;
        iconWrapper.dataset.dockId = item.id;
        iconWrapper.title = item.description || item.name;
        iconWrapper.draggable = true;

        // 图标
        const img = document.createElement('img');
        img.src = item.icon || '../assets/setting.png';
        img.className = 'desktop-dock-icon-img';
        img.draggable = false;
        // 图标加载失败时回退到默认图标
        img.onerror = function () {
            if (this.src !== new URL('../assets/setting.png', location.href).href) {
                this.src = '../assets/setting.png';
            }
        };
        iconWrapper.appendChild(img);

        // 名称标签
        const label = document.createElement('span');
        label.className = 'desktop-dock-icon-label';
        label.textContent = item.name;
        iconWrapper.appendChild(label);

        // 单击启动
        iconWrapper.addEventListener('click', (e) => {
            e.stopPropagation();
            launchDockItem(item);
        });

        // 右键菜单（移除/管理）
        iconWrapper.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showDockContextMenu(e.clientX, e.clientY, item, index);
        });

        // 拖拽到桌面
        iconWrapper.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-desktop-dock-item', JSON.stringify(item));
            e.dataTransfer.effectAllowed = 'copy';
            iconWrapper.classList.add('dragging');
        });

        iconWrapper.addEventListener('dragend', () => {
            iconWrapper.classList.remove('dragging');
        });

        // 鼓泡动画
        iconWrapper.addEventListener('mousedown', () => {
            iconWrapper.classList.add('active');
        });
        iconWrapper.addEventListener('mouseup', () => {
            iconWrapper.classList.remove('active');
        });
        iconWrapper.addEventListener('mouseleave', () => {
            iconWrapper.classList.remove('active');
        });

        return iconWrapper;
    }

    // ============================================================
    // 应用抽屉（App Drawer）
    // ============================================================

    /**
     * 切换抽屉开关
     */
    function toggleDrawer(forceState) {
        if (!dockDrawer) return;

        isDrawerOpen = forceState !== undefined ? forceState : !isDrawerOpen;

        if (isDrawerOpen) {
            renderDrawer();
            dockDrawer.classList.add('open');
        } else {
            dockDrawer.classList.remove('open');
        }
    }

    /**
     * 渲染抽屉中的全部应用
     */
    function renderDrawer() {
        if (!dockDrawerList) return;

        dockDrawerList.innerHTML = '';

        if (state.dock.items.length === 0) {
            dockDrawerList.innerHTML = '<div class="desktop-dock-drawer-empty">暂无应用<br><span style="font-size:11px;opacity:0.5;">点击右下角扫描按钮导入桌面快捷方式</span></div>';
            return;
        }

        state.dock.items.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'desktop-dock-drawer-item';
            card.title = item.description || item.name;

            // 图标
            const img = document.createElement('img');
            img.src = item.icon || '../assets/setting.png';
            img.className = 'desktop-dock-drawer-item-icon';
            img.draggable = false;
            // 图标加载失败时回退到默认图标
            img.onerror = function () {
                if (this.src !== new URL('../assets/setting.png', location.href).href) {
                    this.src = '../assets/setting.png';
                }
            };
            card.appendChild(img);

            // 名称
            const name = document.createElement('span');
            name.className = 'desktop-dock-drawer-item-name';
            name.textContent = item.name;
            card.appendChild(name);

            // 可见性勾选
            const visCheck = document.createElement('input');
            visCheck.type = 'checkbox';
            visCheck.className = 'desktop-dock-drawer-item-check';
            visCheck.checked = index < state.dock.maxVisible;
            visCheck.title = '在 Dock 中显示';
            visCheck.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            visCheck.addEventListener('change', (e) => {
                e.stopPropagation();
                handleVisibilityToggle(item, index, visCheck.checked);
            });
            card.appendChild(visCheck);

            // 删除按钮
            const delBtn = document.createElement('button');
            delBtn.className = 'desktop-dock-drawer-item-del';
            delBtn.textContent = '✕';
            delBtn.title = '从 Dock 移除';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeDockItem(item.id);
                renderDrawer();
            });
            card.appendChild(delBtn);

            // 单击启动
            card.addEventListener('click', () => {
                launchDockItem(item);
            });

            // 拖拽到桌面
            card.draggable = true;
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-desktop-dock-item', JSON.stringify(item));
                e.dataTransfer.effectAllowed = 'copy';
            });

            dockDrawerList.appendChild(card);
        });
    }

    /**
     * 处理抽屉中的可见性切换
     */
    function handleVisibilityToggle(item, currentIndex, shouldBeVisible) {
        if (shouldBeVisible) {
            // 如果当前不在可见范围内，将其移到可见区域末尾
            if (currentIndex >= state.dock.maxVisible) {
                // 把它从当前位置移出
                state.dock.items.splice(currentIndex, 1);
                // 插到 maxVisible - 1 处（可见区域末尾之前）
                const insertAt = Math.min(state.dock.maxVisible - 1, state.dock.items.length);
                state.dock.items.splice(insertAt, 0, item);
            }
        } else {
            // 移到不可见区域
            if (currentIndex < state.dock.maxVisible) {
                state.dock.items.splice(currentIndex, 1);
                state.dock.items.push(item);
            }
        }
        renderDock();
        renderDrawer();
        saveDockConfig();
    }

    // ============================================================
    // 启动应用
    // ============================================================

    // 启动防抖 - 防止用户连续点击启动多个实例
    const _launchCooldowns = new Map(); // targetPath -> timestamp
    const LAUNCH_COOLDOWN_MS = 2000; // 2秒冷却时间

    /**
     * 启动 Dock 中的应用（带防抖）
     */
    async function launchDockItem(item) {
        // 防抖检查
        const key = item.targetPath || item.builtinId || item.id;
        const lastLaunch = _launchCooldowns.get(key);
        const now = Date.now();
        if (lastLaunch && (now - lastLaunch) < LAUNCH_COOLDOWN_MS) {
            console.log(`[Dock] Launch cooldown active for: ${item.name} (${LAUNCH_COOLDOWN_MS - (now - lastLaunch)}ms remaining)`);
            return;
        }
        _launchCooldowns.set(key, now);

        if (item.type === 'builtin') {
            // 内置挂件 - 通过挂件系统生成
            if (item.builtinId && window.VCPDesktop[item.builtinId]) {
                window.VCPDesktop[item.builtinId].spawn();
            }
            return;
        }

        // 快捷方式 - 通过 IPC 启动
        if (window.electronAPI?.desktopShortcutLaunch) {
            try {
                const result = await window.electronAPI.desktopShortcutLaunch(item);
                if (!result.success) {
                    console.error('[Dock] Launch failed:', result.error);
                    if (window.VCPDesktop.status) {
                        window.VCPDesktop.status.update('waiting', `启动失败: ${result.error}`);
                    }
                    // 启动失败时清除冷却，允许重试
                    _launchCooldowns.delete(key);
                } else {
                    console.log(`[Dock] Launched: ${item.name}`);
                }
            } catch (err) {
                console.error('[Dock] Launch error:', err);
                _launchCooldowns.delete(key);
            }
        }
    }

    // ============================================================
    // 快捷方式管理
    // ============================================================

    /**
     * 添加快捷方式到 Dock
     */
    function addDockItem(shortcut) {
        const id = `shortcut_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;

        // 检查是否已存在相同目标的快捷方式
        const existing = state.dock.items.find(
            i => i.targetPath === shortcut.targetPath && i.type === 'shortcut'
        );
        if (existing) {
            console.log(`[Dock] Shortcut already exists: ${shortcut.name}`);
            return existing;
        }

        const item = {
            id,
            name: shortcut.name,
            icon: shortcut.icon || '',
            targetPath: shortcut.targetPath || '',
            args: shortcut.args || '',
            workingDir: shortcut.workingDir || '',
            description: shortcut.description || '',
            originalPath: shortcut.originalPath || '',
            type: 'shortcut',
        };

        state.dock.items.push(item);
        renderDock();
        saveDockConfig();

        return item;
    }

    /**
     * 批量添加快捷方式
     */
    function addDockItems(shortcuts) {
        let addedCount = 0;
        for (const sc of shortcuts) {
            const existing = state.dock.items.find(
                i => i.targetPath === sc.targetPath && i.type === 'shortcut'
            );
            if (!existing) {
                const id = `shortcut_${Date.now()}_${Math.random().toString(36).substr(2, 4)}_${addedCount}`;
                state.dock.items.push({
                    id,
                    name: sc.name,
                    icon: sc.icon || '',
                    targetPath: sc.targetPath || '',
                    args: sc.args || '',
                    workingDir: sc.workingDir || '',
                    description: sc.description || '',
                    originalPath: sc.originalPath || '',
                    type: 'shortcut',
                });
                addedCount++;
            }
        }
        if (addedCount > 0) {
            renderDock();
            saveDockConfig();
        }
        return addedCount;
    }

    /**
     * 移除 Dock 项
     */
    function removeDockItem(itemId) {
        const index = state.dock.items.findIndex(i => i.id === itemId);
        if (index >= 0) {
            state.dock.items.splice(index, 1);
            renderDock();
            saveDockConfig();
        }
    }

    // ============================================================
    // 扫描 Windows 桌面快捷方式
    // ============================================================

    /**
     * 扫描 Windows 桌面上的 .lnk 快捷方式并导入
     */
    async function scanWindowsShortcuts() {
        if (!window.electronAPI?.desktopScanShortcuts) {
            console.warn('[Dock] desktopScanShortcuts API not available');
            return;
        }

        if (window.VCPDesktop.status) {
            window.VCPDesktop.status.update('streaming', '正在扫描桌面快捷方式...');
            window.VCPDesktop.status.show();
        }

        try {
            const result = await window.electronAPI.desktopScanShortcuts();
            if (result?.success && result.shortcuts) {
                const count = addDockItems(result.shortcuts);
                if (window.VCPDesktop.status) {
                    window.VCPDesktop.status.update('connected', `已导入 ${count} 个快捷方式`);
                    setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                }
                console.log(`[Dock] Imported ${count} shortcuts from Windows desktop`);
            } else {
                if (window.VCPDesktop.status) {
                    window.VCPDesktop.status.update('waiting', `扫描失败: ${result?.error || '未知错误'}`);
                    setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                }
            }
        } catch (err) {
            console.error('[Dock] Scan error:', err);
            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('waiting', '扫描失败');
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        }
    }

    // ============================================================
    // 拖拽导入 .lnk 文件
    // ============================================================

    /**
     * 初始化文件拖放接收
     */
    function initFileDrop() {
        // Dock 区域接收文件拖放
        if (dockElement) {
            dockElement.addEventListener('dragover', (e) => {
                if (e.dataTransfer.types.includes('Files')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    dockElement.classList.add('drop-target');
                }
            });

            dockElement.addEventListener('dragleave', () => {
                dockElement.classList.remove('drop-target');
            });

            dockElement.addEventListener('drop', async (e) => {
                dockElement.classList.remove('drop-target');
                const files = e.dataTransfer.files;
                if (!files || files.length === 0) return;

                e.preventDefault();
                const lnkPaths = [];
                for (let i = 0; i < files.length; i++) {
                    if (files[i].name.toLowerCase().endsWith('.lnk')) {
                        lnkPaths.push(files[i].path);
                    }
                }

                if (lnkPaths.length > 0) {
                    await importLnkFiles(lnkPaths);
                }
            });
        }

        // 画布区域也接收 .lnk 文件拖入（创建桌面图标）
        const canvas = domRefs.canvas;
        if (canvas) {
            // 在现有的 dragover 基础上增加对 Files 的支持
            canvas.addEventListener('dragover', (e) => {
                if (e.dataTransfer.types.includes('Files') ||
                    e.dataTransfer.types.includes('application/x-desktop-dock-item')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                }
            });

            canvas.addEventListener('drop', async (e) => {
                // 处理 Dock 图标拖入桌面
                const dockItemData = e.dataTransfer.getData('application/x-desktop-dock-item');
                if (dockItemData) {
                    e.preventDefault();
                    try {
                        const item = JSON.parse(dockItemData);
                        createDesktopIcon(item, e.clientX, e.clientY);
                    } catch (err) {
                        console.error('[Dock] Failed to parse dock item data:', err);
                    }
                    return;
                }

                // 处理外部 .lnk 文件拖入桌面
                const files = e.dataTransfer.files;
                if (files && files.length > 0) {
                    const lnkPaths = [];
                    for (let i = 0; i < files.length; i++) {
                        if (files[i].name.toLowerCase().endsWith('.lnk')) {
                            lnkPaths.push(files[i].path);
                        }
                    }
                    if (lnkPaths.length > 0) {
                        e.preventDefault();
                        // 先导入到 Dock
                        const shortcuts = await importLnkFiles(lnkPaths);
                        // 同时在桌面上创建图标
                        if (shortcuts && shortcuts.length > 0) {
                            let offsetX = 0;
                            for (const sc of shortcuts) {
                                createDesktopIcon(sc, e.clientX + offsetX, e.clientY);
                                offsetX += 90;
                            }
                        }
                    }
                }
            });
        }
    }

    /**
     * 导入 .lnk 文件到 Dock
     */
    async function importLnkFiles(filePaths) {
        if (!window.electronAPI?.desktopShortcutParseBatch) return [];

        try {
            const result = await window.electronAPI.desktopShortcutParseBatch(filePaths);
            if (result?.success && result.shortcuts) {
                const count = addDockItems(result.shortcuts);
                if (window.VCPDesktop.status) {
                    window.VCPDesktop.status.update('connected', `已导入 ${count} 个快捷方式`);
                    window.VCPDesktop.status.show();
                    setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                }
                return result.shortcuts;
            }
        } catch (err) {
            console.error('[Dock] Import error:', err);
        }
        return [];
    }

    // ============================================================
    // 桌面图标
    // ============================================================

    /**
     * 在桌面画布上创建一个快捷方式图标
     */
    function createDesktopIcon(item, x, y) {
        const canvas = domRefs.canvas;
        if (!canvas) return;

        // 检查是否已存在
        const existingIcon = canvas.querySelector(`.desktop-shortcut-icon[data-target-path="${CSS.escape(item.targetPath)}"]`);
        if (existingIcon) {
            console.log(`[Dock] Desktop icon already exists: ${item.name}`);
            return;
        }

        const iconEl = document.createElement('div');
        iconEl.className = 'desktop-shortcut-icon';
        iconEl.dataset.targetPath = item.targetPath || '';
        iconEl.dataset.originalPath = item.originalPath || '';

        // 定位
        const adjustedX = Math.max(10, Math.min(x - 32, window.innerWidth - 80));
        const adjustedY = Math.max(CONSTANTS.TITLE_BAR_HEIGHT + 4, Math.min(y - 32, window.innerHeight - 120));
        iconEl.style.left = `${adjustedX}px`;
        iconEl.style.top = `${adjustedY}px`;

        // 图标图片
        const img = document.createElement('img');
        img.src = item.icon || '../assets/setting.png';
        img.className = 'desktop-shortcut-icon-img';
        img.draggable = false;
        // 图标加载失败时回退到默认图标
        img.onerror = function () {
            if (this.src !== new URL('../assets/setting.png', location.href).href) {
                this.src = '../assets/setting.png';
            }
        };
        iconEl.appendChild(img);

        // 标签
        const label = document.createElement('span');
        label.className = 'desktop-shortcut-icon-label';
        label.textContent = item.name;
        iconEl.appendChild(label);

        // 双击启动
        iconEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            launchDockItem(item);
            // 点击动画
            iconEl.classList.add('launching');
            setTimeout(() => iconEl.classList.remove('launching'), 600);
        });

        // 单击选中
        iconEl.addEventListener('click', (e) => {
            e.stopPropagation();
            // 清除其他选中
            canvas.querySelectorAll('.desktop-shortcut-icon.selected').forEach(el => {
                el.classList.remove('selected');
            });
            iconEl.classList.add('selected');
        });

        // 右键删除
        iconEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showDesktopIconContextMenu(e.clientX, e.clientY, iconEl, item);
        });

        // 拖拽移动
        setupDesktopIconDrag(iconEl);

        canvas.appendChild(iconEl);

        // 保存到状态
        const iconState = {
            id: item.id || `dicon_${Date.now()}`,
            name: item.name,
            icon: item.icon,
            targetPath: item.targetPath,
            args: item.args,
            workingDir: item.workingDir,
            originalPath: item.originalPath,
            x: adjustedX,
            y: adjustedY,
        };
        state.desktopIcons.push(iconState);

        // 进入动画
        iconEl.classList.add('entering');
        iconEl.addEventListener('animationend', () => {
            iconEl.classList.remove('entering');
        }, { once: true });
    }

    /**
     * 桌面图标拖拽移动
     */
    function setupDesktopIconDrag(iconEl) {
        let isDragging = false;
        let startX, startY, origX, origY;

        iconEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isDragging = false;
            startX = e.clientX;
            startY = e.clientY;
            origX = parseInt(iconEl.style.left) || 0;
            origY = parseInt(iconEl.style.top) || 0;

            const onMove = (moveE) => {
                const dx = moveE.clientX - startX;
                const dy = moveE.clientY - startY;
                if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                    isDragging = true;
                    iconEl.classList.add('dragging');
                }
                if (isDragging) {
                    iconEl.style.left = `${origX + dx}px`;
                    iconEl.style.top = `${origY + dy}px`;
                }
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (isDragging) {
                    iconEl.classList.remove('dragging');
                    // 更新状态中的位置
                    const targetPath = iconEl.dataset.targetPath;
                    const iconState = state.desktopIcons.find(i => i.targetPath === targetPath);
                    if (iconState) {
                        iconState.x = parseInt(iconEl.style.left) || 0;
                        iconState.y = parseInt(iconEl.style.top) || 0;
                    }
                }
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // ============================================================
    // Dock 右键菜单
    // ============================================================

    let dockContextMenu = null;

    function showDockContextMenu(x, y, item, index) {
        // 移除旧菜单
        if (dockContextMenu) {
            dockContextMenu.remove();
        }

        dockContextMenu = document.createElement('div');
        dockContextMenu.className = 'desktop-context-menu visible';

        // 先添加到 DOM 以便计算尺寸
        dockContextMenu.style.left = `${x}px`;
        dockContextMenu.style.top = `${y}px`;
        dockContextMenu.style.visibility = 'hidden';

        const launchBtn = document.createElement('button');
        launchBtn.className = 'desktop-context-menu-item';
        launchBtn.textContent = '▶ 启动';
        launchBtn.addEventListener('click', () => {
            dockContextMenu.remove();
            dockContextMenu = null;
            launchDockItem(item);
        });
        dockContextMenu.appendChild(launchBtn);

        const toDesktopBtn = document.createElement('button');
        toDesktopBtn.className = 'desktop-context-menu-item';
        toDesktopBtn.textContent = '📌 放到桌面';
        toDesktopBtn.addEventListener('click', () => {
            dockContextMenu.remove();
            dockContextMenu = null;
            createDesktopIcon(item, window.innerWidth / 2, window.innerHeight / 2);
        });
        dockContextMenu.appendChild(toDesktopBtn);

        // 更换图标
        const changeIconBtn = document.createElement('button');
        changeIconBtn.className = 'desktop-context-menu-item';
        changeIconBtn.textContent = '🎨 更换图标';
        changeIconBtn.addEventListener('click', () => {
            dockContextMenu.remove();
            dockContextMenu = null;
            if (window.VCPDesktop.iconPicker) {
                window.VCPDesktop.iconPicker.open((iconData) => {
                    // 更新 state 中的图标
                    const stateItem = state.dock.items.find(i => i.id === item.id);
                    if (stateItem) {
                        stateItem.icon = iconData.dataUrl;
                    }
                    item.icon = iconData.dataUrl;
                    // 同步更新桌面上已存在的同源图标
                    updateDesktopIconsByTarget(item.targetPath, iconData.dataUrl);
                    // 重新渲染并保存
                    renderDock();
                    saveDockConfig();
                });
            }
        });
        dockContextMenu.appendChild(changeIconBtn);

        const divider = document.createElement('div');
        divider.className = 'desktop-context-menu-divider';
        dockContextMenu.appendChild(divider);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'desktop-context-menu-item desktop-context-menu-item-danger';
        removeBtn.textContent = '✕ 从 Dock 移除';
        removeBtn.addEventListener('click', () => {
            dockContextMenu.remove();
            dockContextMenu = null;
            removeDockItem(item.id);
        });
        dockContextMenu.appendChild(removeBtn);

        document.body.appendChild(dockContextMenu);

        // 边界避让：防止菜单超出窗口
        requestAnimationFrame(() => {
            if (!dockContextMenu) return;
            const rect = dockContextMenu.getBoundingClientRect();
            let adjustedX = x;
            let adjustedY = y;
            // 底部避让
            if (rect.bottom > window.innerHeight - 10) {
                adjustedY = y - rect.height;
            }
            // 右侧避让
            if (rect.right > window.innerWidth - 10) {
                adjustedX = x - rect.width;
            }
            // 顶部避让
            if (adjustedY < 10) {
                adjustedY = 10;
            }
            dockContextMenu.style.left = `${adjustedX}px`;
            dockContextMenu.style.top = `${adjustedY}px`;
            dockContextMenu.style.visibility = '';
        });

        // 点击其他地方关闭
        const closeHandler = (e) => {
            if (dockContextMenu && !dockContextMenu.contains(e.target)) {
                dockContextMenu.remove();
                dockContextMenu = null;
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    /**
     * 桌面图标右键菜单
     */
    function showDesktopIconContextMenu(x, y, iconEl, item) {
        if (dockContextMenu) {
            dockContextMenu.remove();
        }

        dockContextMenu = document.createElement('div');
        dockContextMenu.className = 'desktop-context-menu visible';
        dockContextMenu.style.left = `${x}px`;
        dockContextMenu.style.top = `${y}px`;
        dockContextMenu.style.visibility = 'hidden';

        const launchBtn = document.createElement('button');
        launchBtn.className = 'desktop-context-menu-item';
        launchBtn.textContent = '▶ 启动';
        launchBtn.addEventListener('click', () => {
            dockContextMenu.remove();
            dockContextMenu = null;
            launchDockItem(item);
        });
        dockContextMenu.appendChild(launchBtn);

        // 更换图标
        const changeIconBtn = document.createElement('button');
        changeIconBtn.className = 'desktop-context-menu-item';
        changeIconBtn.textContent = '🎨 更换图标';
        changeIconBtn.addEventListener('click', () => {
            dockContextMenu.remove();
            dockContextMenu = null;
            if (window.VCPDesktop.iconPicker) {
                window.VCPDesktop.iconPicker.open((iconData) => {
                    // 更新桌面图标 DOM
                    const imgEl = iconEl.querySelector('.desktop-shortcut-icon-img');
                    if (imgEl) {
                        imgEl.src = iconData.dataUrl;
                    }
                    // 更新桌面图标状态
                    const targetPath = iconEl.dataset.targetPath;
                    const iconState = state.desktopIcons.find(i => i.targetPath === targetPath);
                    if (iconState) {
                        iconState.icon = iconData.dataUrl;
                    }
                    // 同步更新 Dock 中的同源项
                    const dockItem = state.dock.items.find(i => i.targetPath === targetPath);
                    if (dockItem) {
                        dockItem.icon = iconData.dataUrl;
                        renderDock();
                        saveDockConfig();
                    }
                    item.icon = iconData.dataUrl;
                });
            }
        });
        dockContextMenu.appendChild(changeIconBtn);

        const divider = document.createElement('div');
        divider.className = 'desktop-context-menu-divider';
        dockContextMenu.appendChild(divider);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'desktop-context-menu-item desktop-context-menu-item-danger';
        removeBtn.textContent = '✕ 从桌面移除';
        removeBtn.addEventListener('click', () => {
            dockContextMenu.remove();
            dockContextMenu = null;
            iconEl.classList.add('removing');
            iconEl.addEventListener('animationend', () => {
                iconEl.remove();
                // 从状态中移除
                const targetPath = iconEl.dataset.targetPath;
                const idx = state.desktopIcons.findIndex(i => i.targetPath === targetPath);
                if (idx >= 0) state.desktopIcons.splice(idx, 1);
            }, { once: true });
        });
        dockContextMenu.appendChild(removeBtn);

        document.body.appendChild(dockContextMenu);

        // 边界避让：防止菜单超出窗口
        requestAnimationFrame(() => {
            if (!dockContextMenu) return;
            const rect = dockContextMenu.getBoundingClientRect();
            let adjustedX = x;
            let adjustedY = y;
            if (rect.bottom > window.innerHeight - 10) {
                adjustedY = y - rect.height;
            }
            if (rect.right > window.innerWidth - 10) {
                adjustedX = x - rect.width;
            }
            if (adjustedY < 10) {
                adjustedY = 10;
            }
            dockContextMenu.style.left = `${adjustedX}px`;
            dockContextMenu.style.top = `${adjustedY}px`;
            dockContextMenu.style.visibility = '';
        });

        const closeHandler = (e) => {
            if (dockContextMenu && !dockContextMenu.contains(e.target)) {
                dockContextMenu.remove();
                dockContextMenu = null;
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    // ============================================================
    // 持久化
    // ============================================================

    /**
     * 保存 Dock 配置到磁盘
     */
    async function saveDockConfig() {
        if (!window.electronAPI?.desktopSaveDock) return;

        try {
            await window.electronAPI.desktopSaveDock({
                items: state.dock.items,
                maxVisible: state.dock.maxVisible,
            });
        } catch (err) {
            console.error('[Dock] Save config error:', err);
        }
    }

    /**
     * 从磁盘加载 Dock 配置
     */
    async function loadDockConfig() {
        if (!window.electronAPI?.desktopLoadDock) return;

        try {
            const result = await window.electronAPI.desktopLoadDock();
            if (result?.success && result.data) {
                state.dock.items = result.data.items || [];
                state.dock.maxVisible = result.data.maxVisible || 8;
                renderDock();
                console.log(`[Dock] Config loaded: ${state.dock.items.length} items`);
            }
        } catch (err) {
            console.error('[Dock] Load config error:', err);
        }
    }

    // ============================================================
    // 图标同步更新辅助
    // ============================================================

    /**
     * 更新桌面上所有同源（相同 targetPath）图标的显示
     */
    function updateDesktopIconsByTarget(targetPath, newIconSrc) {
        if (!targetPath) return;
        const canvas = domRefs.canvas;
        if (!canvas) return;

        const icons = canvas.querySelectorAll(`.desktop-shortcut-icon[data-target-path="${CSS.escape(targetPath)}"]`);
        icons.forEach(iconEl => {
            const imgEl = iconEl.querySelector('.desktop-shortcut-icon-img');
            if (imgEl) {
                imgEl.src = newIconSrc;
            }
        });

        // 同步状态
        state.desktopIcons.forEach(iconState => {
            if (iconState.targetPath === targetPath) {
                iconState.icon = newIconSrc;
            }
        });
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.dock = {
        init: initDock,
        render: renderDock,
        addItem: addDockItem,
        addItems: addDockItems,
        removeItem: removeDockItem,
        launch: launchDockItem,
        scan: scanWindowsShortcuts,
        toggleDrawer,
        saveDockConfig,
        loadDockConfig,
        createDesktopIcon,
    };

})();