/**
 * VCPdesktop - 侧栏系统模块
 * 负责：收藏侧栏开关、收藏卡片渲染、拖拽到桌面
 */

'use strict';

(function () {
    const { state, domRefs } = window.VCPDesktop;

    /**
     * 初始化侧栏
     */
    function initSidebar() {
        const sidebar = document.getElementById('desktop-sidebar');
        if (!sidebar) return;

        // 关闭按钮
        sidebar.querySelector('.desktop-sidebar-close')?.addEventListener('click', () => {
            toggleSidebar(false);
        });
    }

    /**
     * 切换侧栏开关
     * @param {boolean} [forceState] - 强制指定开关状态
     */
    function toggleSidebar(forceState) {
        const sidebar = document.getElementById('desktop-sidebar');
        if (!sidebar) return;

        const shouldOpen = forceState !== undefined ? forceState : !state.sidebarOpen;
        state.sidebarOpen = shouldOpen;

        if (shouldOpen) {
            sidebar.classList.add('open');
            // 每次打开刷新收藏列表
            if (window.VCPDesktop.favorites) {
                window.VCPDesktop.favorites.loadList();
            }
        } else {
            sidebar.classList.remove('open');
        }
    }

    /**
     * 渲染侧栏收藏列表
     */
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

    /**
     * 初始化画布区域的拖放接收（从侧栏拖入桌面）
     */
    function initCanvasDrop() {
        const canvas = domRefs.canvas;
        if (!canvas) return;

        canvas.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('application/x-desktop-fav-id')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        canvas.addEventListener('drop', (e) => {
            const favId = e.dataTransfer.getData('application/x-desktop-fav-id');
            if (favId) {
                e.preventDefault();
                if (window.VCPDesktop.favorites) {
                    window.VCPDesktop.favorites.spawnFromFavorite(favId, e.clientX - 100, e.clientY - 30);
                }
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
    };

})();