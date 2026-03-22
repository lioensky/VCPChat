/**
 * VCPdesktop - 内置应用托盘挂件
 * 负责：以网格形式展示所有 Dock 中的应用，支持搜索、拖拽到桌面、单击启动
 * 
 * 优势：比 Dock 栏更直观地浏览和管理大量应用，无需通过抽屉逐一操作
 */

'use strict';

(function () {
    const { state, CONSTANTS, widget } = window.VCPDesktop;

    // 应用托盘 HTML 模板
    const APP_TRAY_HTML = `
<style>
:host, .widget-scoped-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
}
.at-container {
    width: 100%;
    height: 100%;
    max-height: 100%;
    background: linear-gradient(145deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%);
    backdrop-filter: blur(20px);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: 'Segoe UI', -apple-system, sans-serif;
    color: rgba(255,255,255,0.85);
    box-sizing: border-box;
}

.at-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px 8px;
    flex-shrink: 0;
}

.at-title {
    font-size: 13px;
    font-weight: 600;
    opacity: 0.7;
    flex-shrink: 0;
}

.at-search {
    flex: 1;
    padding: 5px 10px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 6px;
    color: rgba(255,255,255,0.85);
    font-size: 11px;
    outline: none;
    transition: border-color 0.15s;
}

.at-search:focus {
    border-color: rgba(100,180,255,0.4);
}

.at-search::placeholder {
    color: rgba(255,255,255,0.25);
}

.at-count {
    font-size: 10px;
    opacity: 0.35;
    flex-shrink: 0;
}

.at-grid {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    padding: 6px 10px 10px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
    gap: 4px;
    align-content: start;
}

.at-grid::-webkit-scrollbar { width: 5px; }
.at-grid::-webkit-scrollbar-track { background: rgba(128,128,128,0.05); border-radius: 3px; }
.at-grid::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 3px; }
.at-grid::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.5); }

.at-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 8px 4px 4px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.12s ease;
    user-select: none;
    min-height: 68px;
}

.at-item:hover {
    background: rgba(255,255,255,0.08);
    transform: translateY(-1px);
}

.at-item:active {
    transform: scale(0.95);
    background: rgba(255,255,255,0.12);
}

.at-item.dragging {
    opacity: 0.4;
    transform: scale(0.9);
}

.at-item-icon {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    object-fit: contain;
    pointer-events: none;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.3));
}

.at-item-icon-placeholder {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    background: rgba(255,255,255,0.06);
    border-radius: 6px;
}

.at-item-name {
    font-size: 9px;
    color: rgba(255,255,255,0.7);
    margin-top: 4px;
    max-width: 60px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    line-height: 1.2;
}

.at-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: rgba(255,255,255,0.2);
    font-size: 12px;
    text-align: center;
    line-height: 1.8;
    grid-column: 1 / -1;
    padding: 20px;
}

.at-refresh-btn {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 22px;
    height: 22px;
    background: rgba(255,255,255,0.06);
    border: none;
    border-radius: 5px;
    color: rgba(255,255,255,0.4);
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.12s;
    z-index: 5;
}

.at-refresh-btn:hover {
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.8);
}

/* 浅色主题 */
body.light-theme .at-container {
    color: rgba(0,0,0,0.8);
    background: linear-gradient(145deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.3) 100%);
}
body.light-theme .at-search {
    background: rgba(0,0,0,0.04);
    border-color: rgba(0,0,0,0.08);
    color: rgba(0,0,0,0.8);
}
body.light-theme .at-search::placeholder { color: rgba(0,0,0,0.25); }
body.light-theme .at-item:hover { background: rgba(0,0,0,0.05); }
body.light-theme .at-item:active { background: rgba(0,0,0,0.08); }
body.light-theme .at-item-name { color: rgba(0,0,0,0.65); }
body.light-theme .at-empty { color: rgba(0,0,0,0.2); }
body.light-theme .at-refresh-btn { background: rgba(0,0,0,0.04); color: rgba(0,0,0,0.35); }
body.light-theme .at-refresh-btn:hover { background: rgba(0,0,0,0.08); color: rgba(0,0,0,0.7); }
</style>

<div class="at-container" style="position:relative;">
    <div class="at-header">
        <span class="at-title">📦 应用托盘</span>
        <input class="at-search" id="at-search" type="text" placeholder="搜索应用..." />
        <span class="at-count" id="at-count"></span>
    </div>
    <div class="at-grid" id="at-grid"></div>
    <button class="at-refresh-btn" id="at-refresh" title="刷新列表">🔄</button>
</div>

<script>
(function() {
    var gridEl = document.getElementById('at-grid');
    var searchEl = document.getElementById('at-search');
    var countEl = document.getElementById('at-count');
    var refreshBtn = document.getElementById('at-refresh');

    var defaultIcon = '../assets/setting.png';

    function renderApps(filter) {
        if (!gridEl) return;
        gridEl.innerHTML = '';

        var D = window.VCPDesktop;
        var items = (D && D.state && D.state.dock && D.state.dock.items) ? D.state.dock.items : [];

        // 搜索过滤
        if (filter) {
            var lowerFilter = filter.toLowerCase();
            items = items.filter(function(item) {
                return item.name && item.name.toLowerCase().includes(lowerFilter);
            });
        }

        if (countEl) {
            countEl.textContent = items.length + ' 个';
        }

        if (items.length === 0) {
            var emptyMsg = filter ? '没有匹配的应用' : '暂无应用\\n从 Dock 栏扫描或拖入快捷方式';
            gridEl.innerHTML = '<div class="at-empty">' + emptyMsg + '</div>';
            return;
        }

        items.forEach(function(item) {
            var el = document.createElement('div');
            el.className = 'at-item';
            el.title = item.description || item.name || '';
            el.draggable = true;

            // 图标：优先 icon（PNG），其次 animatedIcon（GIF），最后 emoji 占位
            var trayDisplayIcon = item.icon || item.animatedIcon;
            if (trayDisplayIcon) {
                var img = document.createElement('img');
                img.className = 'at-item-icon';
                img.src = trayDisplayIcon;
                img.draggable = false;
                img.onerror = function() {
                    if (this.src !== defaultIcon) this.src = defaultIcon;
                };
                el.appendChild(img);

                // GIF 动画图标：hover 时播放，移出时恢复静态
                if (item.animatedIcon) {
                    (function(imgEl, staticSrc, animSrc) {
                        // 预加载 GIF
                        var preload = new Image();
                        preload.src = animSrc;
                        el.addEventListener('mouseenter', function() {
                            imgEl.src = animSrc + '?t=' + Date.now();
                        });
                        el.addEventListener('mouseleave', function() {
                            imgEl.src = staticSrc;
                        });
                    })(img, trayDisplayIcon, item.animatedIcon);
                }
            } else if (item.emoji) {
                var placeholder = document.createElement('div');
                placeholder.className = 'at-item-icon-placeholder';
                placeholder.textContent = item.emoji;
                el.appendChild(placeholder);
            } else {
                var placeholder = document.createElement('div');
                placeholder.className = 'at-item-icon-placeholder';
                placeholder.textContent = '📄';
                el.appendChild(placeholder);
            }

            // 名称
            var nameEl = document.createElement('span');
            nameEl.className = 'at-item-name';
            nameEl.textContent = item.name || '未命名';
            el.appendChild(nameEl);

            // 单击启动
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                if (D && D.dock && D.dock.launch) {
                    D.dock.launch(item);
                }
            });

            // 拖拽到桌面（创建桌面快捷方式图标）
            el.addEventListener('dragstart', function(e) {
                e.dataTransfer.setData('application/x-desktop-dock-item', JSON.stringify(item));
                e.dataTransfer.effectAllowed = 'copy';
                el.classList.add('dragging');
            });

            el.addEventListener('dragend', function() {
                el.classList.remove('dragging');
            });

            gridEl.appendChild(el);
        });
    }

    // 搜索过滤
    if (searchEl) {
        searchEl.addEventListener('input', function() {
            renderApps(searchEl.value.trim());
        });
    }

    // 刷新按钮
    if (refreshBtn) {
        refreshBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            renderApps(searchEl ? searchEl.value.trim() : '');
        });
    }

    // 初始渲染
    renderApps('');

    // 定期自动刷新（与 Dock 列表同步，每 5 秒）
    setInterval(function() {
        renderApps(searchEl ? searchEl.value.trim() : '');
    }, 5000);
})();
<\/script>
`;

    /**
     * 生成应用托盘挂件
     */
    function spawnAppTrayWidget() {
        const widgetId = 'builtin-appTray';

        // 如果已存在则聚焦
        if (state.widgets.has(widgetId)) {
            const existing = state.widgets.get(widgetId);
            if (existing && window.VCPDesktop.zIndex) {
                window.VCPDesktop.zIndex.bringToFront(widgetId);
            }
            return;
        }

        const widgetData = widget.create(widgetId, {
            x: 80,
            y: CONSTANTS.TITLE_BAR_HEIGHT + 40,
            width: 340,
            height: 360,
        });

        // 标记为固定尺寸挂件 —— 阻止 MutationObserver 触发的自动尺寸调整
        widgetData.fixedSize = true;

        // 断开内容观察器，防止定期刷新的 DOM 变更触发 autoResize
        if (widgetData._resizeObserver) {
            widgetData._resizeObserver.disconnect();
            widgetData._resizeObserver = null;
        }

        // 强制设置固定尺寸（防止内容撑开）
        widgetData.element.style.width = '340px';
        widgetData.element.style.height = '360px';

        // 确保内容容器也有固定高度约束
        if (widgetData.contentContainer) {
            widgetData.contentContainer.style.width = '100%';
            widgetData.contentContainer.style.height = '100%';
            widgetData.contentContainer.style.overflow = 'hidden';
        }

        widgetData.contentBuffer = APP_TRAY_HTML;
        widgetData.contentContainer.innerHTML = APP_TRAY_HTML;
        widget.processInlineStyles(widgetData);
        widgetData.isConstructing = false;
        widgetData.element.classList.remove('constructing');
        // 不调用 autoResize —— 此挂件使用固定尺寸

        // 延迟执行脚本（确保 DOM 已就绪）
        setTimeout(function () {
            widget.processInlineScripts(widgetData);
        }, 150);

        console.log('[VCPdesktop] App Tray widget spawned.');
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.builtinAppTray = {
        spawn: spawnAppTrayWidget,
    };

})();