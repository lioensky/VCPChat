
/**
 * VCPdesktop - Dock 栏系统模块
 * 负责：底部 Dock 栏渲染、快捷方式管理、拖拽到桌面、应用抽屉
 *
 * 图标体系（优先级从高到低）：
 *   1. icon (PNG/SVG 文件路径) — 静态图标，默认显示
 *   2. animatedIcon (GIF 文件路径) — 鼠标悬停时播放动画，移出恢复静态
 *   3. svgIcon (内联 SVG 字符串) — AI 原生生成，支持 currentColor 主题适配
 *   4. emoji (文字 emoji) — 最终回退
 *
 * 当只有 animatedIcon 无 icon 时，GIF 自身作为默认显示。
 * svgIcon 仅在无 icon 和 animatedIcon 时使用，作为 AI 原生图标。
 */

'use strict';

(function () {
    const { state, domRefs, CONSTANTS } = window.VCPDesktop;

    let dockElement = null;
    let dockItemsContainer = null;
    let dockDrawer = null;
    let dockDrawerList = null;
    let dockDrawerSearch = null;
    let isDrawerOpen = false;

    // Dock 内部拖拽排序状态
    let dragSortState = {
        isDragging: false,
        draggedIndex: -1,
        draggedItemId: null,
        dropTargetIndex: -1,
    };

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
        dockDrawerSearch = document.getElementById('desktop-dock-drawer-search');

        if (!dockElement) return;

        // 初始应用 Dock 位置
        const pos = state.dock.position || 'bottom';
        const dist = state.dock.edgeDistance ?? 12;
        applyDockPosition(pos, dist);

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

        // 抽屉搜索框
        if (dockDrawerSearch) {
            dockDrawerSearch.addEventListener('input', () => {
                renderDrawer(dockDrawerSearch.value.trim());
            });
            // 阻止搜索框的点击事件冒泡（防止关闭抽屉）
            dockDrawerSearch.addEventListener('click', (e) => {
                e.stopPropagation();
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

        // 初始化 Dock 内部拖拽排序
        initDockSortDrag();

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

        // 只渲染标记为可见（visible !== false）的项目，最多显示 maxVisible 个
        const visibleItems = state.dock.items.filter(item => item.visible !== false);
        const displayItems = visibleItems.slice(0, state.dock.maxVisible);

        displayItems.forEach((item, index) => {
            const iconEl = createDockIcon(item, index);
            dockItemsContainer.appendChild(iconEl);
        });

        // 更新"更多"按钮的可见性：有不可见的项或可见项超过 maxVisible 时显示
        const moreBtn = document.getElementById('desktop-dock-more-btn');
        if (moreBtn) {
            const hasHidden = state.dock.items.some(item => item.visible === false) ||
                              visibleItems.length > state.dock.maxVisible;
            moreBtn.style.display = (state.dock.items.length > 0 && (hasHidden || state.dock.items.length > state.dock.maxVisible)) ? '' : 'none';
            const hiddenCount = state.dock.items.length - displayItems.length;
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

        // 图标渲染：icon(PNG/SVG文件) > animatedIcon(GIF) > svgIcon(内联SVG) > emoji
        const displayIcon = item.icon || item.animatedIcon;
        if (displayIcon) {
            const img = document.createElement('img');
            img.src = displayIcon;
            img.className = 'desktop-dock-icon-img';
            img.draggable = false;
            // 图标加载失败时回退到 svgIcon > emoji > 默认图标
            img.onerror = function () {
                if (item.svgIcon) {
                    const svgEl = document.createElement('span');
                    svgEl.className = 'desktop-dock-icon-svg';
                    svgEl.innerHTML = item.svgIcon;
                    this.replaceWith(svgEl);
                } else if (item.emoji) {
                    const emojiEl = document.createElement('span');
                    emojiEl.className = 'desktop-dock-icon-emoji';
                    emojiEl.textContent = item.emoji;
                    this.replaceWith(emojiEl);
                } else if (this.src !== new URL('../assets/setting.png', location.href).href) {
                    this.src = '../assets/setting.png';
                }
            };
            iconWrapper.appendChild(img);

            // GIF 动画图标：hover 时播放，移出时恢复静态
            if (item.animatedIcon) {
                const preloadGif = new Image();
                preloadGif.src = item.animatedIcon;
                const staticSrc = item.icon || item.animatedIcon;

                iconWrapper.addEventListener('mouseenter', () => {
                    const imgEl = iconWrapper.querySelector('.desktop-dock-icon-img');
                    if (imgEl) {
                        imgEl.src = item.animatedIcon + '?t=' + Date.now();
                    }
                });
                iconWrapper.addEventListener('mouseleave', () => {
                    const imgEl = iconWrapper.querySelector('.desktop-dock-icon-img');
                    if (imgEl) {
                        imgEl.src = staticSrc;
                    }
                });
            }
        } else if (item.htmlIcon) {
            // HTML 富图标（Shadow DOM 隔离渲染）
            const htmlHost = document.createElement('span');
            htmlHost.className = 'desktop-dock-icon-svg'; // 复用 SVG 容器样式
            const shadow = htmlHost.attachShadow({ mode: 'closed' });
            // 注入缩放约束：用包裹容器强制 HTML 图标内容缩放到指定尺寸
            shadow.innerHTML = `<style>:host{display:block;width:100%;height:100%;overflow:hidden;}.vcp-html-icon-wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;transform-origin:center center;}</style><div class="vcp-html-icon-wrap">${item.htmlIcon}</div>`;
            iconWrapper.appendChild(htmlHost);
        } else if (item.svgIcon) {
            // 内联 SVG 图标（AI 原生生成，支持 currentColor 主题适配）
            const svgEl = document.createElement('span');
            svgEl.className = 'desktop-dock-icon-svg';
            svgEl.innerHTML = item.svgIcon;
            iconWrapper.appendChild(svgEl);
        } else if (item.emoji) {
            const emojiEl = document.createElement('span');
            emojiEl.className = 'desktop-dock-icon-emoji';
            emojiEl.textContent = item.emoji;
            iconWrapper.appendChild(emojiEl);
        } else {
            const img = document.createElement('img');
            img.src = '../assets/setting.png';
            img.className = 'desktop-dock-icon-img';
            img.draggable = false;
            iconWrapper.appendChild(img);
        }

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

        // 拖拽：支持 Dock 内排序 + 拖到桌面
        iconWrapper.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-desktop-dock-item', JSON.stringify(item));
            e.dataTransfer.setData('text/x-dock-sort-id', item.id);
            e.dataTransfer.effectAllowed = 'copyMove';
            iconWrapper.classList.add('dragging');

            // 设置拖拽排序状态
            dragSortState.isDragging = true;
            dragSortState.draggedIndex = index;
            dragSortState.draggedItemId = item.id;
            dragSortState.dropTargetIndex = -1;
        });

        iconWrapper.addEventListener('dragend', () => {
            iconWrapper.classList.remove('dragging');
            // 清理排序状态和视觉反馈
            cleanupDragSortIndicators();
            dragSortState.isDragging = false;
            dragSortState.draggedIndex = -1;
            dragSortState.draggedItemId = null;
            dragSortState.dropTargetIndex = -1;
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
    // Dock 内部拖拽排序
    // ============================================================

    /**
     * 初始化 Dock 内部拖拽排序事件
     */
    function initDockSortDrag() {
        if (!dockItemsContainer) return;

        dockItemsContainer.addEventListener('dragover', (e) => {
            // 只处理 Dock 内部排序（检查是否有排序标记）
            if (!dragSortState.isDragging) return;
            if (!e.dataTransfer.types.includes('text/x-dock-sort-id')) return;

            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            // 计算插入位置
            const targetIndex = getDragOverIndex(e.clientX, e.clientY);
            if (targetIndex !== dragSortState.dropTargetIndex) {
                dragSortState.dropTargetIndex = targetIndex;
                updateDragSortIndicators(targetIndex);
            }
        });

        dockItemsContainer.addEventListener('drop', (e) => {
            const sortId = e.dataTransfer.getData('text/x-dock-sort-id');
            if (!sortId || !dragSortState.isDragging) return;

            e.preventDefault();
            e.stopPropagation(); // 防止冒泡到桌面 canvas 的 drop

            const fromDisplayIndex = dragSortState.draggedIndex;
            let toDisplayIndex = dragSortState.dropTargetIndex;

            if (fromDisplayIndex < 0 || toDisplayIndex < 0 || fromDisplayIndex === toDisplayIndex) {
                cleanupDragSortIndicators();
                return;
            }

            // 将显示索引映射回 state.dock.items 中的实际索引
            const visibleItems = state.dock.items.filter(item => item.visible !== false);
            const displayItems = visibleItems.slice(0, state.dock.maxVisible);

            if (fromDisplayIndex >= displayItems.length) {
                cleanupDragSortIndicators();
                return;
            }

            const movedItem = displayItems[fromDisplayIndex];
            const fromActualIndex = state.dock.items.indexOf(movedItem);

            if (fromActualIndex < 0) {
                cleanupDragSortIndicators();
                return;
            }

            // 计算目标位置在全量数组中的实际索引
            let toActualIndex;
            if (toDisplayIndex >= displayItems.length) {
                // 插到显示列表末尾：找到最后一个可见项在全量数组中的位置之后
                const lastVisibleItem = displayItems[displayItems.length - 1];
                toActualIndex = state.dock.items.indexOf(lastVisibleItem) + 1;
            } else {
                // 插到某个可见项前面
                const targetItem = displayItems[toDisplayIndex];
                toActualIndex = state.dock.items.indexOf(targetItem);
            }

            // 执行排序：从数组中移除并插入到新位置
            state.dock.items.splice(fromActualIndex, 1);
            // 移除后索引可能需要调整
            const adjustedTo = toActualIndex > fromActualIndex ? toActualIndex - 1 : toActualIndex;
            state.dock.items.splice(adjustedTo, 0, movedItem);

            renderDock();
            saveDockConfig();

            cleanupDragSortIndicators();
        });

        dockItemsContainer.addEventListener('dragleave', (e) => {
            // 只在离开整个容器时清除指示器
            if (!dockItemsContainer.contains(e.relatedTarget)) {
                cleanupDragSortIndicators();
                dragSortState.dropTargetIndex = -1;
            }
        });
    }

    /**
     * 根据鼠标坐标计算拖拽插入位置索引（支持横向和纵向）
     */
    function getDragOverIndex(clientX, clientY) {
        const icons = dockItemsContainer.querySelectorAll('.desktop-dock-icon');
        if (icons.length === 0) return 0;

        const pos = state.dock.position || 'bottom';
        const isVertical = pos === 'left' || pos === 'right';

        for (let i = 0; i < icons.length; i++) {
            const rect = icons[i].getBoundingClientRect();
            if (isVertical) {
                const midY = rect.top + rect.height / 2;
                if (clientY < midY) return i;
            } else {
                const midX = rect.left + rect.width / 2;
                if (clientX < midX) return i;
            }
        }
        return icons.length;
    }

    /**
     * 更新拖拽排序的视觉指示器（插入线）
     */
    function updateDragSortIndicators(targetIndex) {
        // 清除已有指示器
        cleanupDragSortIndicators();

        const icons = dockItemsContainer.querySelectorAll('.desktop-dock-icon');
        if (icons.length === 0) return;

        // 在目标位置创建插入线指示器
        const indicator = document.createElement('div');
        indicator.className = 'desktop-dock-sort-indicator';

        if (targetIndex < icons.length) {
            // 插到某个图标前面
            icons[targetIndex].insertAdjacentElement('beforebegin', indicator);
        } else {
            // 插到末尾
            dockItemsContainer.appendChild(indicator);
        }
    }

    /**
     * 清除所有拖拽排序指示器
     */
    function cleanupDragSortIndicators() {
        if (!dockItemsContainer) return;
        const indicators = dockItemsContainer.querySelectorAll('.desktop-dock-sort-indicator');
        indicators.forEach(el => el.remove());
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
            // 清空搜索框并渲染全部应用
            if (dockDrawerSearch) {
                dockDrawerSearch.value = '';
            }
            renderDrawer();
            // 根据 Dock 位置调整抽屉对齐
            updateDrawerPosition();
            dockDrawer.classList.add('open');
            // 自动聚焦搜索框
            setTimeout(() => {
                if (dockDrawerSearch) dockDrawerSearch.focus();
            }, 100);
        } else {
            dockDrawer.classList.remove('open');
        }
    }

    /**
     * 渲染抽屉中的全部应用
     */
    function renderDrawer(filter) {
        if (!dockDrawerList) return;

        dockDrawerList.innerHTML = '';

        // 根据搜索关键词过滤
        let items = state.dock.items;
        if (filter) {
            const lowerFilter = filter.toLowerCase();
            items = items.filter(item => {
                const nameMatch = item.name && item.name.toLowerCase().includes(lowerFilter);
                const descMatch = item.description && item.description.toLowerCase().includes(lowerFilter);
                const pathMatch = item.targetPath && item.targetPath.toLowerCase().includes(lowerFilter);
                return nameMatch || descMatch || pathMatch;
            });
        }

        if (items.length === 0) {
            const emptyMsg = filter
                ? `未找到匹配 "${filter}" 的应用`
                : '暂无应用<br><span style="font-size:11px;opacity:0.5;">点击右下角扫描按钮导入桌面快捷方式</span>';
            dockDrawerList.innerHTML = `<div class="desktop-dock-drawer-empty">${emptyMsg}</div>`;
            return;
        }

        items.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'desktop-dock-drawer-item';
            card.title = item.description || item.name;

            // 图标渲染：icon(PNG/SVG文件) > animatedIcon(GIF) > svgIcon(内联SVG) > 默认
            const drawerDisplayIcon = item.icon || item.animatedIcon;
            let img = null;

            if (drawerDisplayIcon) {
                img = document.createElement('img');
                img.src = drawerDisplayIcon;
                img.className = 'desktop-dock-drawer-item-icon';
                img.draggable = false;
                img.onerror = function () {
                    if (item.svgIcon) {
                        const svgEl = document.createElement('span');
                        svgEl.className = 'desktop-dock-drawer-item-svg';
                        svgEl.innerHTML = item.svgIcon;
                        this.replaceWith(svgEl);
                    } else if (this.src !== new URL('../assets/setting.png', location.href).href) {
                        this.src = '../assets/setting.png';
                    }
                };
                card.appendChild(img);
            } else if (item.htmlIcon) {
                const htmlHost = document.createElement('span');
                htmlHost.className = 'desktop-dock-drawer-item-svg';
                const shadow = htmlHost.attachShadow({ mode: 'closed' });
                shadow.innerHTML = `<style>:host{display:block;width:100%;height:100%;overflow:hidden;}.vcp-html-icon-wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;transform-origin:center center;}</style><div class="vcp-html-icon-wrap">${item.htmlIcon}</div>`;
                card.appendChild(htmlHost);
            } else if (item.svgIcon) {
                const svgEl = document.createElement('span');
                svgEl.className = 'desktop-dock-drawer-item-svg';
                svgEl.innerHTML = item.svgIcon;
                card.appendChild(svgEl);
            } else {
                img = document.createElement('img');
                img.src = '../assets/setting.png';
                img.className = 'desktop-dock-drawer-item-icon';
                img.draggable = false;
                card.appendChild(img);
            }

            // GIF 动画图标：hover 时播放，移出时恢复静态
            if (item.animatedIcon && img) {
                const preloadGif = new Image();
                preloadGif.src = item.animatedIcon;
                const staticSrc = item.icon || item.animatedIcon;

                card.addEventListener('mouseenter', () => {
                    img.src = item.animatedIcon + '?t=' + Date.now();
                });
                card.addEventListener('mouseleave', () => {
                    img.src = staticSrc;
                });
            }

            // 名称
            const name = document.createElement('span');
            name.className = 'desktop-dock-drawer-item-name';
            name.textContent = item.name;
            card.appendChild(name);

            // 可见性勾选
            const visCheck = document.createElement('input');
            visCheck.type = 'checkbox';
            visCheck.className = 'desktop-dock-drawer-item-check';
            visCheck.checked = item.visible !== false;
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
                renderDrawer(dockDrawerSearch ? dockDrawerSearch.value.trim() : '');
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
        // 直接设置 item 的 visible 属性，不再通过数组位置判断
        item.visible = shouldBeVisible;
        renderDock();
        renderDrawer(dockDrawerSearch ? dockDrawerSearch.value.trim() : '');
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

        // VChat 内部应用 - 通过 IPC 启动子窗口
        if (item.type === 'vchat-app') {
            if (window.VCPDesktop.vchatApps && window.VCPDesktop.vchatApps.launch) {
                await window.VCPDesktop.vchatApps.launch(item);
            } else {
                console.warn('[Dock] VChat apps module not loaded');
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
            visible: true,
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
                const newItem = {
                    id,
                    name: sc.name,
                    icon: sc.icon || '',
                    targetPath: sc.targetPath || '',
                    args: sc.args || '',
                    workingDir: sc.workingDir || '',
                    description: sc.description || '',
                    originalPath: sc.originalPath || '',
                    type: 'shortcut',
                    visible: true,
                };
                // 保留 URL 快捷方式标记（用于 steam:// 等协议链接的启动）
                if (sc.isUrlShortcut) {
                    newItem.isUrlShortcut = true;
                }
                state.dock.items.push(newItem);
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
                const shortcutPaths = [];
                for (let i = 0; i < files.length; i++) {
                    const name = files[i].name.toLowerCase();
                    if (name.endsWith('.lnk') || name.endsWith('.url')) {
                        shortcutPaths.push(files[i].path);
                    }
                }

                if (shortcutPaths.length > 0) {
                    await importLnkFiles(shortcutPaths);
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
                    const shortcutPaths = [];
                    for (let i = 0; i < files.length; i++) {
                        const name = files[i].name.toLowerCase();
                        if (name.endsWith('.lnk') || name.endsWith('.url')) {
                            shortcutPaths.push(files[i].path);
                        }
                    }
                    if (shortcutPaths.length > 0) {
                        e.preventDefault();
                        // 先导入到 Dock
                        const shortcuts = await importLnkFiles(shortcutPaths);
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

        // 检查是否已存在（对 vchat-app 类型使用 id 去重，对快捷方式使用 targetPath 去重）
        if (item.type === 'vchat-app') {
            const existingIcon = canvas.querySelector(`.desktop-shortcut-icon[data-app-id="${CSS.escape(item.id)}"]`);
            if (existingIcon) {
                console.log(`[Dock] Desktop icon already exists: ${item.name}`);
                return;
            }
        } else {
            const existingIcon = canvas.querySelector(`.desktop-shortcut-icon[data-target-path="${CSS.escape(item.targetPath)}"]`);
            if (existingIcon) {
                console.log(`[Dock] Desktop icon already exists: ${item.name}`);
                return;
            }
        }

        const iconEl = document.createElement('div');
        iconEl.className = 'desktop-shortcut-icon';
        if (item.type === 'vchat-app') {
            iconEl.dataset.appId = item.id || '';
            iconEl.dataset.appType = 'vchat-app';
        } else {
            iconEl.dataset.targetPath = item.targetPath || '';
            iconEl.dataset.originalPath = item.originalPath || '';
        }

        // 定位（如果传入的是精确坐标 _exactPos=true，则跳过偏移调整）
        let adjustedX, adjustedY;
        if (item._exactPos) {
            adjustedX = x;
            adjustedY = y;
        } else {
            adjustedX = Math.max(10, Math.min(x - 32, window.innerWidth - 80));
            adjustedY = Math.max(CONSTANTS.TITLE_BAR_HEIGHT + 4, Math.min(y - 32, window.innerHeight - 120));
        }
        iconEl.style.left = `${adjustedX}px`;
        iconEl.style.top = `${adjustedY}px`;

        // 图标渲染：icon(PNG/SVG文件) > animatedIcon(GIF) > svgIcon(内联SVG) > emoji
        const desktopDisplayIcon = item.icon || item.animatedIcon;
        if (desktopDisplayIcon) {
            const img = document.createElement('img');
            img.src = desktopDisplayIcon;
            img.className = 'desktop-shortcut-icon-img';
            img.draggable = false;
            // 图标加载失败时回退到 svgIcon > emoji > 默认图标
            img.onerror = function () {
                if (item.svgIcon) {
                    const svgEl = document.createElement('span');
                    svgEl.className = 'desktop-shortcut-icon-svg';
                    svgEl.innerHTML = item.svgIcon;
                    this.replaceWith(svgEl);
                } else if (item.emoji) {
                    const emojiEl = document.createElement('span');
                    emojiEl.className = 'desktop-shortcut-icon-emoji';
                    emojiEl.textContent = item.emoji;
                    this.replaceWith(emojiEl);
                } else if (this.src !== new URL('../assets/setting.png', location.href).href) {
                    this.src = '../assets/setting.png';
                }
            };
            iconEl.appendChild(img);

            // GIF 动画图标：hover 时播放，移出时恢复静态
            if (item.animatedIcon) {
                const preloadGif = new Image();
                preloadGif.src = item.animatedIcon;
                const staticSrc = item.icon || item.animatedIcon;

                iconEl.addEventListener('mouseenter', () => {
                    const imgEl = iconEl.querySelector('.desktop-shortcut-icon-img');
                    if (imgEl) {
                        imgEl.src = item.animatedIcon + '?t=' + Date.now();
                    }
                });
                iconEl.addEventListener('mouseleave', () => {
                    const imgEl = iconEl.querySelector('.desktop-shortcut-icon-img');
                    if (imgEl) {
                        imgEl.src = staticSrc;
                    }
                });
            }
        } else if (item.htmlIcon) {
            const htmlHost = document.createElement('span');
            htmlHost.className = 'desktop-shortcut-icon-svg';
            const shadow = htmlHost.attachShadow({ mode: 'closed' });
            shadow.innerHTML = `<style>:host{display:block;width:100%;height:100%;overflow:hidden;}.vcp-html-icon-wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;transform-origin:center center;}</style><div class="vcp-html-icon-wrap">${item.htmlIcon}</div>`;
            iconEl.appendChild(htmlHost);
        } else if (item.svgIcon) {
            const svgEl = document.createElement('span');
            svgEl.className = 'desktop-shortcut-icon-svg';
            svgEl.innerHTML = item.svgIcon;
            iconEl.appendChild(svgEl);
        } else if (item.emoji) {
            const emojiEl = document.createElement('span');
            emojiEl.className = 'desktop-shortcut-icon-emoji';
            emojiEl.textContent = item.emoji;
            iconEl.appendChild(emojiEl);
        } else {
            const img = document.createElement('img');
            img.src = '../assets/setting.png';
            img.className = 'desktop-shortcut-icon-img';
            img.draggable = false;
            iconEl.appendChild(img);
        }

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

        // 保存到状态（保留完整的图标信息，确保预设恢复时图标不丢失）
        const iconState = {
            id: item.id || `dicon_${Date.now()}`,
            name: item.name,
            icon: item.icon,
            animatedIcon: item.animatedIcon || null,
            svgIcon: item.svgIcon || null,
            htmlIcon: item.htmlIcon || null,
            emoji: item.emoji || null,
            targetPath: item.targetPath,
            args: item.args,
            workingDir: item.workingDir,
            originalPath: item.originalPath,
            description: item.description || '',
            type: item.type || 'shortcut',
            appAction: item.appAction || null,
            x: adjustedX,
            y: adjustedY,
        };
        state.desktopIcons.push(iconState);

        // 自动保存桌面图标布局
        saveDesktopIconsDebounced();

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
            // 锁定状态下禁止拖拽桌面图标
            if (state.desktopLocked) return;
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

                    // 网格对齐吸附
                    if (state.globalSettings?.desktopIcon?.gridSnap) {
                        snapToGrid(iconEl);
                    }

                    // 更新状态中的位置
                    const targetPath = iconEl.dataset.targetPath;
                    const appId = iconEl.dataset.appId;
                    const iconState = state.desktopIcons.find(i =>
                        (targetPath && i.targetPath === targetPath) ||
                        (appId && i.id === appId)
                    );
                    if (iconState) {
                        iconState.x = parseInt(iconEl.style.left) || 0;
                        iconState.y = parseInt(iconEl.style.top) || 0;
                    }

                    // 自动保存桌面图标布局
                    saveDesktopIconsDebounced();
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
                    const stateItem = state.dock.items.find(i => i.id === item.id);
                    // 根据图标类型更新不同字段
                    if (iconData.iconType === 'html' && iconData.htmlContent) {
                        // HTML 图标：清除其他图标字段，设置 htmlIcon
                        if (stateItem) {
                            stateItem.icon = null;
                            stateItem.htmlIcon = iconData.htmlContent;
                        }
                        item.icon = null;
                        item.htmlIcon = iconData.htmlContent;
                        // 同步更新桌面上的同源图标 DOM
                        updateDesktopIconsByTargetHtml(item.targetPath, iconData.htmlContent);
                    } else {
                        // 图片/SVG/GIF 图标：使用 dataUrl
                        if (stateItem) {
                            stateItem.icon = iconData.dataUrl;
                            stateItem.htmlIcon = null;
                        }
                        item.icon = iconData.dataUrl;
                        item.htmlIcon = null;
                        updateDesktopIconsByTarget(item.targetPath, iconData.dataUrl);
                    }
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
                    const targetPath = iconEl.dataset.targetPath;
                    const appId = iconEl.dataset.appId;
                    if (iconData.iconType === 'html' && iconData.htmlContent) {
                        // HTML 图标：替换桌面图标 DOM 中的图标元素
                        item.icon = null;
                        item.htmlIcon = iconData.htmlContent;
                        // 更新 state
                        const iconState = state.desktopIcons.find(i =>
                            (targetPath && i.targetPath === targetPath) ||
                            (appId && i.id === appId)
                        );
                        if (iconState) { iconState.icon = null; iconState.htmlIcon = iconData.htmlContent; }
                        // 替换当前桌面图标 DOM 中的图标元素
                        replaceDesktopIconElement(iconEl, 'html', iconData.htmlContent);
                        // 同步 Dock
                        const dockItem = state.dock.items.find(i =>
                            (targetPath && i.targetPath === targetPath) ||
                            (appId && i.id === appId)
                        );
                        if (dockItem) { dockItem.icon = null; dockItem.htmlIcon = iconData.htmlContent; renderDock(); saveDockConfig(); }
                        // 自动保存桌面图标布局
                        saveDesktopIconsDebounced();
                    } else {
                        // 图片/SVG/GIF：替换桌面图标 DOM 中的图标元素
                        item.icon = iconData.dataUrl;
                        item.htmlIcon = null;
                        // 更新 state
                        const iconState = state.desktopIcons.find(i =>
                            (targetPath && i.targetPath === targetPath) ||
                            (appId && i.id === appId)
                        );
                        if (iconState) { iconState.icon = iconData.dataUrl; iconState.htmlIcon = null; }
                        // 替换当前桌面图标 DOM 中的图标元素
                        replaceDesktopIconElement(iconEl, 'image', iconData.dataUrl);
                        // 同步 Dock
                        const dockItem = state.dock.items.find(i =>
                            (targetPath && i.targetPath === targetPath) ||
                            (appId && i.id === appId)
                        );
                        if (dockItem) { dockItem.icon = iconData.dataUrl; dockItem.htmlIcon = null; renderDock(); saveDockConfig(); }
                        // 自动保存桌面图标布局
                        saveDesktopIconsDebounced();
                    }
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
                const rmTargetPath = iconEl.dataset.targetPath;
                const rmAppId = iconEl.dataset.appId;
                const idx = state.desktopIcons.findIndex(i =>
                    (rmTargetPath && i.targetPath === rmTargetPath) ||
                    (rmAppId && i.id === rmAppId)
                );
                if (idx >= 0) state.desktopIcons.splice(idx, 1);
                // 自动保存桌面图标布局
                saveDesktopIconsDebounced();
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
                // 兼容旧数据：没有 visible 字段的 item 根据原来的位置逻辑设置默认值
                state.dock.maxVisible = result.data.maxVisible || 8;
                state.dock.items.forEach((item, index) => {
                    if (item.visible === undefined) {
                        // 旧数据迁移：前 maxVisible 个默认可见，其余不可见
                        item.visible = index < state.dock.maxVisible;
                    }
                });
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
     * 更新桌面上所有同源（相同 targetPath）图标的显示（图片类型）
     */
    function updateDesktopIconsByTarget(targetPath, newIconSrc) {
        if (!targetPath) return;
        const canvas = domRefs.canvas;
        if (!canvas) return;

        const icons = canvas.querySelectorAll(`.desktop-shortcut-icon[data-target-path="${CSS.escape(targetPath)}"]`);
        icons.forEach(iconEl => {
            replaceDesktopIconElement(iconEl, 'image', newIconSrc);
        });

        // 同步状态
        state.desktopIcons.forEach(iconState => {
            if (iconState.targetPath === targetPath) {
                iconState.icon = newIconSrc;
                iconState.htmlIcon = null;
            }
        });

        // 自动保存桌面图标布局
        saveDesktopIconsDebounced();
    }

    /**
     * 更新桌面上所有同源（相同 targetPath）图标的显示（HTML 类型）
     */
    function updateDesktopIconsByTargetHtml(targetPath, htmlContent) {
        if (!targetPath) return;
        const canvas = domRefs.canvas;
        if (!canvas) return;

        const icons = canvas.querySelectorAll(`.desktop-shortcut-icon[data-target-path="${CSS.escape(targetPath)}"]`);
        icons.forEach(iconEl => {
            replaceDesktopIconElement(iconEl, 'html', htmlContent);
        });

        // 同步状态
        state.desktopIcons.forEach(iconState => {
            if (iconState.targetPath === targetPath) {
                iconState.icon = null;
                iconState.htmlIcon = htmlContent;
            }
        });

        // 自动保存桌面图标布局
        saveDesktopIconsDebounced();
    }

    /**
     * 替换桌面图标 DOM 中的图标元素（支持 image/html 类型切换）
     * @param {HTMLElement} iconEl - 桌面图标容器 (.desktop-shortcut-icon)
     * @param {string} type - 'image' | 'html'
     * @param {string} content - dataUrl (image) 或 htmlContent (html)
     */
    function replaceDesktopIconElement(iconEl, type, content) {
        // 移除旧的图标元素（img / span.desktop-shortcut-icon-svg / span.desktop-shortcut-icon-emoji）
        const oldImg = iconEl.querySelector('.desktop-shortcut-icon-img');
        const oldSvg = iconEl.querySelector('.desktop-shortcut-icon-svg');
        const oldEmoji = iconEl.querySelector('.desktop-shortcut-icon-emoji');
        const oldPlaceholder = iconEl.querySelector('.desktop-shortcut-icon-placeholder');
        if (oldImg) oldImg.remove();
        if (oldSvg) oldSvg.remove();
        if (oldEmoji) oldEmoji.remove();
        if (oldPlaceholder) oldPlaceholder.remove();

        // 在 label 之前插入新图标元素
        const label = iconEl.querySelector('.desktop-shortcut-icon-label');

        if (type === 'html') {
            const htmlHost = document.createElement('span');
            htmlHost.className = 'desktop-shortcut-icon-svg';
            const shadow = htmlHost.attachShadow({ mode: 'closed' });
            shadow.innerHTML = `<style>:host{display:block;width:100%;height:100%;overflow:hidden;}.vcp-html-icon-wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;transform-origin:center center;}</style><div class="vcp-html-icon-wrap">${content}</div>`;
            if (label) {
                iconEl.insertBefore(htmlHost, label);
            } else {
                iconEl.appendChild(htmlHost);
            }
        } else {
            // image 类型
            const img = document.createElement('img');
            img.src = content;
            img.className = 'desktop-shortcut-icon-img';
            img.draggable = false;
            img.onerror = function () {
                if (this.src !== new URL('../assets/setting.png', location.href).href) {
                    this.src = '../assets/setting.png';
                }
            };
            if (label) {
                iconEl.insertBefore(img, label);
            } else {
                iconEl.appendChild(img);
            }
        }
    }

    // ============================================================
    // Dock 四向定位
    // ============================================================

    /**
     * 应用 Dock 的位置和边缘距离
     * @param {string} position - 'top' | 'bottom' | 'left' | 'right'
     * @param {number} edgeDistance - 边缘距离 (px)
     */
    function applyDockPosition(position, edgeDistance) {
        if (!dockElement) return;

        const pos = position || 'bottom';
        const dist = edgeDistance ?? 12;

        // 清除所有方向类
        dockElement.classList.remove('dock-top', 'dock-bottom', 'dock-left', 'dock-right');
        dockElement.classList.add(`dock-${pos}`);

        // 重置所有定位属性（使用 'auto' 覆盖 CSS 默认值，避免 top+bottom 同时生效导致铺满）
        dockElement.style.top = 'auto';
        dockElement.style.bottom = 'auto';
        dockElement.style.left = 'auto';
        dockElement.style.right = 'auto';
        dockElement.style.transform = 'none';

        // 根据位置设置定位
        switch (pos) {
            case 'top':
                dockElement.style.top = `${dist}px`;
                dockElement.style.left = '50%';
                dockElement.style.transform = 'translateX(-50%)';
                dockElement.style.flexDirection = 'row';
                if (dockItemsContainer) dockItemsContainer.style.flexDirection = 'row';
                break;
            case 'bottom':
                dockElement.style.bottom = `${dist}px`;
                dockElement.style.left = '50%';
                dockElement.style.transform = 'translateX(-50%)';
                dockElement.style.flexDirection = 'row';
                if (dockItemsContainer) dockItemsContainer.style.flexDirection = 'row';
                break;
            case 'left':
                dockElement.style.left = `${dist}px`;
                dockElement.style.top = '50%';
                dockElement.style.transform = 'translateY(-50%)';
                dockElement.style.flexDirection = 'column';
                if (dockItemsContainer) dockItemsContainer.style.flexDirection = 'column';
                break;
            case 'right':
                dockElement.style.right = `${dist}px`;
                dockElement.style.top = '50%';
                dockElement.style.transform = 'translateY(-50%)';
                dockElement.style.flexDirection = 'column';
                if (dockItemsContainer) dockItemsContainer.style.flexDirection = 'column';
                break;
        }

        // 更新运行时状态
        state.dock.position = pos;
        state.dock.edgeDistance = dist;

        // 更新抽屉位置
        updateDrawerPosition();
    }

    /**
     * 根据 Dock 位置更新抽屉面板的对齐方式
     */
    function updateDrawerPosition() {
        if (!dockDrawer) return;
        const pos = state.dock.position || 'bottom';

        // 清除旧的定位类
        dockDrawer.classList.remove('drawer-from-top', 'drawer-from-bottom', 'drawer-from-left', 'drawer-from-right');
        dockDrawer.classList.add(`drawer-from-${pos}`);
    }

    // ============================================================
    // 桌面图标网格吸附
    // ============================================================

    /**
     * 将桌面图标吸附到最近的网格位置
     * @param {HTMLElement} iconEl - 桌面图标 DOM 元素
     */
    function snapToGrid(iconEl) {
        const iconSize = state.globalSettings?.desktopIcon?.iconSize || 40;
        // 网格单元尺寸 = 图标容器宽度（iconSize + 32px padding）+ 间距
        const cellW = iconSize + 40;  // 水平单元（含间距）
        const cellH = iconSize + 52;  // 垂直单元（含标签 + 间距）
        const padLeft = 16;           // 左侧起始边距
        const padTop = 42;            // 顶部起始边距（标题栏下方）

        let x = parseInt(iconEl.style.left) || 0;
        let y = parseInt(iconEl.style.top) || 0;

        // 计算最近的网格位置
        const col = Math.max(0, Math.round((x - padLeft) / cellW));
        const row = Math.max(0, Math.round((y - padTop) / cellH));

        const snapX = col * cellW + padLeft;
        const snapY = row * cellH + padTop;

        // 平滑吸附动画
        iconEl.style.transition = 'left 0.15s ease, top 0.15s ease';
        iconEl.style.left = `${snapX}px`;
        iconEl.style.top = `${snapY}px`;

        // 动画结束后移除 transition 避免影响后续拖拽
        setTimeout(() => {
            iconEl.style.transition = '';
        }, 160);
    }

    // ============================================================
    // 桌面图标持久化（自动保存/恢复）
    // ============================================================

    let _saveDesktopIconsTimer = null;

    /**
     * 防抖保存桌面图标（避免频繁写入）
     */
    function saveDesktopIconsDebounced() {
        // 恢复期间不自动保存（避免数据翻倍）
        if (_isRestoringIcons) return;
        if (_saveDesktopIconsTimer) clearTimeout(_saveDesktopIconsTimer);
        _saveDesktopIconsTimer = setTimeout(() => {
            saveDesktopIcons();
        }, 800);
    }

    /**
     * 保存桌面图标到 layout.json 的 desktopIcons 字段
     */
    async function saveDesktopIcons() {
        if (!window.electronAPI?.desktopSaveLayout || !window.electronAPI?.desktopLoadLayout) return;

        try {
            const result = await window.electronAPI.desktopLoadLayout();
            const layoutData = (result?.success && result.data) ? result.data : {};
            // 保存到 currentDesktopIcons 字段（清除旧的 desktopIcons 避免混淆）
            layoutData.currentDesktopIcons = state.desktopIcons.map(icon => {
                const copy = {...icon};
                delete copy._exactPos; // 清除临时标记
                return copy;
            });
            delete layoutData.desktopIcons; // 清除旧字段
            await window.electronAPI.desktopSaveLayout(layoutData);
            console.log(`[Dock] Desktop icons saved: ${state.desktopIcons.length} icons`);
        } catch (err) {
            console.error('[Dock] Save desktop icons error:', err);
        }
    }

    /** 是否正在恢复桌面图标（恢复期间不触发自动保存） */
    let _isRestoringIcons = false;

    /**
     * 从 layout.json 恢复桌面图标
     */
    async function restoreDesktopIcons() {
        if (!window.electronAPI?.desktopLoadLayout) return;

        try {
            const result = await window.electronAPI.desktopLoadLayout();
            if (!result?.success || !result.data) return;

            // 支持两个字段名：currentDesktopIcons（新）和 desktopIcons（旧兼容）
            const savedIcons = result.data.currentDesktopIcons || result.data.desktopIcons;
            if (!Array.isArray(savedIcons) || savedIcons.length === 0) return;

            console.log(`[Dock] Restoring ${savedIcons.length} desktop icons...`);

            // 标记恢复中，禁止自动保存
            _isRestoringIcons = true;

            // 清空当前桌面图标状态
            state.desktopIcons = [];

            // 清除画布上现有的桌面图标 DOM
            const canvas = domRefs.canvas;
            if (canvas) {
                canvas.querySelectorAll('.desktop-shortcut-icon').forEach(el => el.remove());
            }

            for (const iconData of savedIcons) {
                // 使用 _exactPos 标记精确坐标（跳过 createDesktopIcon 内部的偏移调整）
                iconData._exactPos = true;
                createDesktopIcon(iconData, iconData.x || 100, iconData.y || 100);
            }

            _isRestoringIcons = false;
            console.log(`[Dock] Desktop icons restored: ${state.desktopIcons.length}`);
        } catch (err) {
            _isRestoringIcons = false;
            console.error('[Dock] Restore desktop icons error:', err);
        }
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
        applyPosition: applyDockPosition,
        restoreDesktopIcons,
        saveDesktopIcons,
    };

})();