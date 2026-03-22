
/**
 * VCPdesktop - 桌面画布渲染器
 * 负责：接收IPC流式token、挂件创建/管理、拖拽交互、样式隔离
 *       右键菜单、收藏系统、侧栏预览
 */

'use strict';

// ============================================================
// 全局状态
// ============================================================
const desktopState = {
    widgets: new Map(),          // id -> widgetData
    dragState: null,
    isConnected: false,
    nextZIndex: 10,              // z-index 递增计数器
    sidebarOpen: false,
    favorites: [],               // [{ id, name, thumbnail }]
};

const TITLE_BAR_HEIGHT = 32;

const canvas = document.getElementById('desktop-canvas');
const statusIndicator = document.getElementById('desktop-status-indicator');
const statusDot = statusIndicator?.querySelector('.desktop-status-dot');
const statusText = statusIndicator?.querySelector('.desktop-status-text');

// ============================================================
// 标题栏控制
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('desktop-btn-minimize')?.addEventListener('click', () => {
        window.electronAPI?.minimizeWindow();
    });
    document.getElementById('desktop-btn-maximize')?.addEventListener('click', () => {
        window.electronAPI?.maximizeWindow();
    });
    document.getElementById('desktop-btn-close')?.addEventListener('click', () => {
        window.electronAPI?.closeWindow();
    });

    // 侧栏开关按钮
    document.getElementById('desktop-btn-sidebar')?.addEventListener('click', () => {
        toggleSidebar();
    });

    initThemeSync();

    updateStatus('waiting', '等待主窗口连接...');
    setTimeout(() => {
        statusIndicator?.classList.add('hidden');
    }, 3000);

    initContextMenu();
    initSidebar();
    initSaveModal();
    loadFavoritesList();

    // 点击空白关闭右键菜单
    document.addEventListener('click', () => {
        hideContextMenu();
    });

    // 阻止画布/挂件区域的默认右键菜单
    document.addEventListener('contextmenu', (e) => {
        if (e.target.closest('#desktop-canvas') || e.target.closest('.desktop-widget')) {
            e.preventDefault();
        }
    });
});

// ============================================================
// 主题同步
// ============================================================
function initThemeSync() {
    const params = new URLSearchParams(window.location.search);
    const initialTheme = params.get('currentThemeMode');
    if (initialTheme === 'light') {
        document.body.classList.add('light-theme');
    }

    if (window.electronAPI?.onThemeUpdated) {
        window.electronAPI.onThemeUpdated((theme) => {
            if (theme === 'light') {
                document.body.classList.add('light-theme');
            } else {
                document.body.classList.remove('light-theme');
            }
        });
    }
}

// ============================================================
// 状态指示器
// ============================================================
function updateStatus(state, message) {
    if (!statusIndicator) return;
    statusIndicator.classList.remove('hidden');

    if (statusDot) {
        statusDot.className = 'desktop-status-dot';
        if (state === 'connected') statusDot.classList.add('connected');
        if (state === 'streaming') statusDot.classList.add('streaming');
    }
    if (statusText) {
        statusText.textContent = message;
    }

    if (state !== 'streaming') {
        setTimeout(() => {
            statusIndicator?.classList.add('hidden');
        }, 3000);
    }
}

// ============================================================
// 挂件管理
// ============================================================

/**
 * 创建挂件容器
 */
function createWidget(widgetId, options = {}) {
    if (desktopState.widgets.has(widgetId)) {
        console.log(`[Desktop] Widget ${widgetId} already exists, reusing.`);
        return desktopState.widgets.get(widgetId);
    }

    const widget = document.createElement('div');
    widget.className = 'desktop-widget constructing entering';
    widget.dataset.widgetId = widgetId;

    const x = options.x || 100;
    const y = Math.max(options.y || 100, TITLE_BAR_HEIGHT + 4); // 限位：不低于标题栏
    const width = options.width || 320;
    const height = options.height || 200;

    widget.style.left = `${x}px`;
    widget.style.top = `${y}px`;
    widget.style.width = `${width}px`;
    widget.style.height = `${height}px`;

    // 分配z-index
    const zIndex = desktopState.nextZIndex++;
    widget.style.zIndex = zIndex;

    // 抓手带
    const grip = document.createElement('div');
    grip.className = 'desktop-widget-grip';
    widget.appendChild(grip);

    // 关闭按钮
    const closeBtn = document.createElement('button');
    closeBtn.className = 'desktop-widget-close-btn';
    closeBtn.innerHTML = '✕';
    closeBtn.title = '关闭挂件';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeWidget(widgetId);
    });
    widget.appendChild(closeBtn);

    // 内容区（Shadow DOM）
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'desktop-widget-content';

    const shadowRoot = contentWrapper.attachShadow({ mode: 'open' });

    const shadowStyle = document.createElement('style');
    shadowStyle.textContent = `
        :host {
            display: block;
            width: 100%;
            height: 100%;
            overflow: auto;
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 2px; }
    `;
    shadowRoot.appendChild(shadowStyle);

    const contentContainer = document.createElement('div');
    contentContainer.className = 'widget-inner-content';
    shadowRoot.appendChild(contentContainer);

    widget.appendChild(contentWrapper);
    canvas.appendChild(widget);

    // 进入动画
    widget.addEventListener('animationend', () => {
        widget.classList.remove('entering');
    }, { once: true });

    // 拖拽
    setupDrag(widget, grip);

    // 右键菜单
    widget.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, widgetId);
    });

    // 点击提升层级
    widget.addEventListener('mousedown', () => {
        bringToFront(widgetId);
    });

    const widgetData = {
        element: widget,
        shadowRoot: shadowRoot,
        contentContainer: contentContainer,
        contentBuffer: '',
        isConstructing: true,
        zIndex: zIndex,
        savedName: null,  // 收藏名
        savedId: null,    // 收藏ID
    };

    desktopState.widgets.set(widgetId, widgetData);
    console.log(`[Desktop] Widget created: ${widgetId}`);
    return widgetData;
}

/**
 * 设置挂件的完整内容
 */
function appendWidgetContent(widgetId, fullContent) {
    let widgetData = desktopState.widgets.get(widgetId);
    if (!widgetData) {
        widgetData = createWidget(widgetId, {
            x: 100 + Math.random() * 200,
            y: 100 + Math.random() * 200,
        });
    }

    widgetData.contentBuffer = fullContent;
    widgetData.contentContainer.innerHTML = fullContent;
    processInlineStyles(widgetData);
    autoResizeWidget(widgetData);
}

/**
 * 自动调整挂件尺寸
 */
function autoResizeWidget(widgetData) {
    requestAnimationFrame(() => {
        const container = widgetData.contentContainer;
        if (!container) return;

        const origDisplay = container.style.display;
        container.style.display = 'inline-block';
        container.style.width = 'auto';

        const contentWidth = container.scrollWidth;
        const contentHeight = container.scrollHeight;

        container.style.display = origDisplay || '';
        container.style.width = '';

        const MIN_WIDTH = 140;
        const MIN_HEIGHT = 60;
        const MAX_WIDTH = window.innerWidth * 0.85;
        const MAX_HEIGHT = window.innerHeight * 0.85;

        const paddingW = 8;
        const paddingH = 14;

        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, contentWidth + paddingW));
        const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, contentHeight + paddingH));

        const widget = widgetData.element;
        widget.style.transition = 'width 0.15s ease-out, height 0.15s ease-out';
        widget.style.width = `${newWidth}px`;
        widget.style.height = `${newHeight}px`;

        setTimeout(() => {
            widget.style.transition = '';
        }, 200);
    });
}

/**
 * 处理内联<style>标签
 */
function processInlineStyles(widgetData) {
    const styleElements = widgetData.contentContainer.querySelectorAll('style');
    styleElements.forEach(styleEl => {
        const newStyle = document.createElement('style');
        newStyle.textContent = styleEl.textContent;
        widgetData.shadowRoot.insertBefore(newStyle, widgetData.contentContainer);
        styleEl.remove();
    });
}

/**
 * 流式替换挂件中指定元素的内容
 */
function replaceInWidgets(targetSelector, newContent) {
    let found = false;
    for (const [widgetId, widgetData] of desktopState.widgets) {
        const targetEl = widgetData.contentContainer.querySelector(targetSelector);
        if (targetEl) {
            targetEl.innerHTML = newContent;
            found = true;
            autoResizeWidget(widgetData);
            console.log(`[Desktop] Replaced content in widget ${widgetId}, selector: ${targetSelector}`);
            break;
        }
    }
    if (!found) {
        console.warn(`[Desktop] Target not found in any widget: ${targetSelector}`);
    }
    return found;
}

/**
 * 完成挂件渲染
 */
function finalizeWidget(widgetId) {
    const widgetData = desktopState.widgets.get(widgetId);
    if (!widgetData) return;

    widgetData.isConstructing = false;
    widgetData.element.classList.remove('constructing');

    processInlineScripts(widgetData);

    console.log(`[Desktop] Widget finalized: ${widgetId}`);
}

/**
 * 处理内联<script>标签
 */
function processInlineScripts(widgetData) {
    const scriptElements = widgetData.contentContainer.querySelectorAll('script');
    scriptElements.forEach(oldScript => {
        const newScript = document.createElement('script');
        if (oldScript.src) {
            newScript.src = oldScript.src;
        } else {
            const widgetId = widgetData.element.dataset.widgetId;
            newScript.textContent = `(function(_realDoc) {
                var _shadowRoot = _realDoc.querySelector('[data-widget-id="${widgetId}"] .desktop-widget-content').shadowRoot;
                var root = _shadowRoot.querySelector('.widget-inner-content');
                var widgetId = '${widgetId}';
                
                var document = {
                    querySelector: function(sel) { return root.querySelector(sel) || _shadowRoot.querySelector(sel); },
                    querySelectorAll: function(sel) { return root.querySelectorAll(sel); },
                    getElementById: function(id) { return root.querySelector('#' + id); },
                    createElement: _realDoc.createElement.bind(_realDoc),
                    createTextNode: _realDoc.createTextNode.bind(_realDoc),
                    createElementNS: _realDoc.createElementNS.bind(_realDoc),
                    body: root,
                    head: _realDoc.head,
                };
                
                // vcpAPI 代理 - 让 widget 脚本可以安全访问后端
                var vcpAPI = {
                    fetch: function(endpoint, opts) { return window.__vcpProxyFetch(endpoint, opts); },
                    weather: function() { return window.__vcpProxyFetch('/admin_api/weather'); },
                };
                
                // musicAPI 代理 - 让 widget 脚本可以控制音乐播放器
                var _electron = window.electron;
                var musicAPI = {
                    play: function() { return _electron ? _electron.invoke('music-play') : Promise.reject('electron not available'); },
                    pause: function() { return _electron ? _electron.invoke('music-pause') : Promise.reject('electron not available'); },
                    getState: function() {
                        if (!_electron) return Promise.reject('electron not available');
                        return _electron.invoke('music-get-state').then(function(r) {
                            return (r && r.state) ? r.state : r;
                        });
                    },
                    setVolume: function(v) { return _electron ? _electron.invoke('music-set-volume', v) : Promise.reject('electron not available'); },
                    seek: function(pos) { return _electron ? _electron.invoke('music-seek', pos) : Promise.reject('electron not available'); },
                    send: function(channel, data) { if (_electron) _electron.send(channel, data); },
                };
                
                ${oldScript.textContent}
            })(window.document);`;
        }
        oldScript.replaceWith(newScript);
    });
}

/**
 * 移除挂件
 */
function removeWidget(widgetId) {
    const widgetData = desktopState.widgets.get(widgetId);
    if (!widgetData) return;

    widgetData.element.classList.add('removing');
    widgetData.element.addEventListener('animationend', () => {
        widgetData.element.remove();
        desktopState.widgets.delete(widgetId);
        console.log(`[Desktop] Widget removed: ${widgetId}`);
    }, { once: true });
}

/**
 * 清除所有挂件
 */
function clearAllWidgets() {
    desktopState.widgets.forEach((_, id) => removeWidget(id));
}

// ============================================================
// Z-Index 层级管理
// ============================================================

function bringToFront(widgetId) {
    const widgetData = desktopState.widgets.get(widgetId);
    if (!widgetData) return;
    const newZ = desktopState.nextZIndex++;
    widgetData.zIndex = newZ;
    widgetData.element.style.zIndex = newZ;
}

function sendToBack(widgetId) {
    const widgetData = desktopState.widgets.get(widgetId);
    if (!widgetData) return;
    // 找到当前最小z-index，减1
    let minZ = Infinity;
    desktopState.widgets.forEach((wd) => {
        if (wd.zIndex < minZ) minZ = wd.zIndex;
    });
    const newZ = Math.max(1, minZ - 1);
    widgetData.zIndex = newZ;
    widgetData.element.style.zIndex = newZ;
}

// ============================================================
// 拖拽系统（带限位）
// ============================================================
function setupDrag(widgetElement, gripElement) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    gripElement.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        originLeft = parseInt(widgetElement.style.left) || 0;
        originTop = parseInt(widgetElement.style.top) || 0;

        gripElement.style.cursor = 'grabbing';

        // 拖拽期间提升z-index
        const widgetId = widgetElement.dataset.widgetId;
        bringToFront(widgetId);

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = originLeft + dx;
        let newTop = originTop + dy;

        // === 拖拽限位 ===
        const widgetW = widgetElement.offsetWidth;
        const widgetH = widgetElement.offsetHeight;
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;

        // 至少保留40px在可视区域内（防止完全拖出屏幕）
        const minVisible = 40;

        // 上边界：不能拖入标题栏区域
        if (newTop < TITLE_BAR_HEIGHT) {
            newTop = TITLE_BAR_HEIGHT;
        }

        // 下边界：至少保留minVisible在屏幕内
        if (newTop > viewH - minVisible) {
            newTop = viewH - minVisible;
        }

        // 左边界
        if (newLeft < -(widgetW - minVisible)) {
            newLeft = -(widgetW - minVisible);
        }

        // 右边界
        if (newLeft > viewW - minVisible) {
            newLeft = viewW - minVisible;
        }

        widgetElement.style.left = `${newLeft}px`;
        widgetElement.style.top = `${newTop}px`;
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;
        gripElement.style.cursor = '';

        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
}

// ============================================================
// 右键菜单系统
// ============================================================

let contextMenuElement = null;
let contextMenuTargetWidgetId = null;

function initContextMenu() {
    contextMenuElement = document.getElementById('desktop-context-menu');
    if (!contextMenuElement) return;

    // 绑定菜单项事件
    contextMenuElement.querySelector('[data-action="favorite"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = contextMenuTargetWidgetId; // 先保存，因为 hideContextMenu 会清空
        hideContextMenu();
        if (targetId) {
            showSaveModal(targetId);
        }
    });

    contextMenuElement.querySelector('[data-action="refresh"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = contextMenuTargetWidgetId;
        hideContextMenu();
        if (targetId) {
            refreshWidget(targetId);
        }
    });

    contextMenuElement.querySelector('[data-action="close"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = contextMenuTargetWidgetId;
        hideContextMenu();
        if (targetId) {
            removeWidget(targetId);
        }
    });

    contextMenuElement.querySelector('[data-action="bring-front"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = contextMenuTargetWidgetId;
        hideContextMenu();
        if (targetId) {
            bringToFront(targetId);
        }
    });

    contextMenuElement.querySelector('[data-action="send-back"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = contextMenuTargetWidgetId;
        hideContextMenu();
        if (targetId) {
            sendToBack(targetId);
        }
    });
}

function showContextMenu(x, y, widgetId) {
    if (!contextMenuElement) return;
    contextMenuTargetWidgetId = widgetId;

    // 判断是否已收藏，更新收藏按钮文字
    const widgetData = desktopState.widgets.get(widgetId);
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

function hideContextMenu() {
    if (contextMenuElement) {
        contextMenuElement.classList.remove('visible');
    }
    contextMenuTargetWidgetId = null;
}

// ============================================================
// 收藏系统
// ============================================================

/**
 * 收藏模态窗初始化
 */
function initSaveModal() {
    const modal = document.getElementById('desktop-save-modal');
    if (!modal) return;

    const cancelBtn = modal.querySelector('.desktop-modal-cancel');
    const confirmBtn = modal.querySelector('.desktop-modal-confirm');
    const input = modal.querySelector('.desktop-modal-input');

    cancelBtn?.addEventListener('click', () => {
        modal.classList.remove('visible');
    });

    confirmBtn?.addEventListener('click', () => {
        const name = input?.value?.trim();
        if (!name) {
            input?.classList.add('error');
            setTimeout(() => input?.classList.remove('error'), 600);
            return;
        }
        const widgetId = modal.dataset.targetWidgetId;
        // 先关闭模态窗，等动画完成后再截图保存
        modal.classList.remove('visible');
        if (widgetId) {
            // 延迟300ms让模态窗完全消失，避免截图包含模态窗
            setTimeout(() => {
                performSave(widgetId, name);
            }, 350);
        }
    });

    // 回车确认
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            confirmBtn?.click();
        }
        if (e.key === 'Escape') {
            cancelBtn?.click();
        }
    });

    // 点击蒙层关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('visible');
        }
    });
}

function showSaveModal(widgetId) {
    const modal = document.getElementById('desktop-save-modal');
    if (!modal) return;

    const input = modal.querySelector('.desktop-modal-input');
    const widgetData = desktopState.widgets.get(widgetId);

    // 如果已收藏，预填名字
    if (input) {
        input.value = widgetData?.savedName || '';
    }
    modal.dataset.targetWidgetId = widgetId;
    modal.classList.add('visible');

    // 聚焦输入框
    setTimeout(() => input?.focus(), 100);
}

/**
 * 执行收藏操作：截图 + 保存HTML + IPC持久化
 */
async function performSave(widgetId, name) {
    const widgetData = desktopState.widgets.get(widgetId);
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
        thumbnailDataUrl = await captureWidgetThumbnail(widgetData);
        console.log(`[Desktop] Thumbnail captured: ${thumbnailDataUrl.length} chars`);
    } catch (err) {
        console.warn('[Desktop] Failed to capture thumbnail:', err);
    }

    // 通过IPC发送到主进程持久化
    if (window.electronAPI?.desktopSaveWidget) {
        try {
            console.log('[Desktop] Calling desktopSaveWidget IPC...');
            const result = await window.electronAPI.desktopSaveWidget({
                id: saveId,
                name: name,
                html: htmlContent,
                thumbnail: thumbnailDataUrl,
            });
            console.log('[Desktop] desktopSaveWidget result:', result);
            if (result?.success) {
                widgetData.savedName = name;
                widgetData.savedId = saveId;
                updateStatus('connected', `已收藏: ${name}`);
                // 刷新侧栏收藏列表
                await loadFavoritesList();
                console.log('[Desktop] Favorites refreshed after save, count:', desktopState.favorites.length);
            } else {
                updateStatus('waiting', `收藏失败: ${result?.error || '未知错误'}`);
            }
        } catch (err) {
            console.error('[Desktop] Save widget error:', err);
            updateStatus('waiting', '收藏失败');
        }
    } else {
        console.warn('[Desktop] desktopSaveWidget API not available');
        updateStatus('waiting', '收藏API不可用');
    }
}

/**
 * 捕获widget缩略图
 * 使用离屏Canvas + foreignObject SVG 方式渲染截图
 */
async function captureWidgetThumbnail(widgetData) {
    const widget = widgetData.element;
    if (!widget) throw new Error('No widget element');

    // 使用 Electron 的 webContents.capturePage() 原生截图
    // 需要通过 IPC 发送 widget 的屏幕矩形坐标到主进程
    if (window.electronAPI?.desktopCaptureWidget) {
        const rect = widget.getBoundingClientRect();
        // 考虑设备像素比（高DPI屏幕）
        const dpr = window.devicePixelRatio || 1;
        const captureRect = {
            x: Math.round(rect.x * dpr),
            y: Math.round(rect.y * dpr),
            width: Math.round(rect.width * dpr),
            height: Math.round(rect.height * dpr),
        };

        console.log(`[Desktop] Capturing widget at rect:`, captureRect, `dpr: ${dpr}`);
        const result = await window.electronAPI.desktopCaptureWidget(captureRect);
        if (result?.success && result.thumbnail) {
            return result.thumbnail;
        } else {
            console.warn('[Desktop] capturePage failed:', result?.error);
            // Fallback 到简单文本预览
        }
    }

    // Fallback: 简单的文本预览缩略图
    return generateFallbackThumbnail(widgetData);
}

/**
 * Fallback 缩略图：文本预览
 */
function generateFallbackThumbnail(widgetData) {
    const widget = widgetData.element;
    const widgetRect = widget.getBoundingClientRect();
    const w = Math.round(widgetRect.width);
    const h = Math.round(widgetRect.height);

    const MAX_THUMB = 300;
    const scale = Math.min(MAX_THUMB / w, MAX_THUMB / h, 1);
    const thumbW = Math.round(w * scale);
    const thumbH = Math.round(h * scale);

    const canvasEl = document.createElement('canvas');
    canvasEl.width = thumbW;
    canvasEl.height = thumbH;
    const ctx = canvasEl.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, thumbW, thumbH);
    gradient.addColorStop(0, 'rgba(40, 40, 60, 0.9)');
    gradient.addColorStop(1, 'rgba(20, 20, 40, 0.9)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(0, 0, thumbW, thumbH, 8);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `${Math.max(10, thumbH * 0.08)}px sans-serif`;
    const textContent = (widgetData.contentContainer.textContent || '').trim().substring(0, 100);
    const lines = wrapText(ctx, textContent, thumbW - 16);
    let textY = 16;
    for (let i = 0; i < Math.min(lines.length, 6); i++) {
        ctx.fillText(lines[i], 8, textY);
        textY += Math.max(12, thumbH * 0.12);
    }

    return canvasEl.toDataURL('image/png', 0.8);
}

/**
 * 文本换行辅助函数
 */
function wrapText(ctx, text, maxWidth) {
    const words = text.split('');
    const lines = [];
    let line = '';

    for (const char of words) {
        const testLine = line + char;
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && line) {
            lines.push(line);
            line = char;
        } else {
            line = testLine;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/**
 * 刷新挂件（从文件重新加载）
 */
async function refreshWidget(widgetId) {
    const widgetData = desktopState.widgets.get(widgetId);
    if (!widgetData || !widgetData.savedId) {
        updateStatus('waiting', '该挂件未收藏，无法刷新');
        return;
    }

    if (window.electronAPI?.desktopLoadWidget) {
        try {
            const result = await window.electronAPI.desktopLoadWidget(widgetData.savedId);
            if (result?.success && result.html) {
                widgetData.contentBuffer = result.html;
                widgetData.contentContainer.innerHTML = result.html;
                processInlineStyles(widgetData);
                autoResizeWidget(widgetData);
                // 重新执行脚本
                processInlineScripts(widgetData);
                updateStatus('connected', `已刷新: ${widgetData.savedName}`);
            } else {
                updateStatus('waiting', `刷新失败: ${result?.error || '未知错误'}`);
            }
        } catch (err) {
            console.error('[Desktop] Refresh widget error:', err);
            updateStatus('waiting', '刷新失败');
        }
    }
}

/**
 * 加载收藏列表
 */
async function loadFavoritesList() {
    if (!window.electronAPI?.desktopListWidgets) {
        console.log('[Desktop] desktopListWidgets API not available yet, skipping.');
        return;
    }
    try {
        const result = await window.electronAPI.desktopListWidgets();
        if (result?.success) {
            desktopState.favorites = result.widgets || [];
            renderSidebarFavorites();
        }
    } catch (err) {
        // 静默处理 - 可能是主进程版本不匹配
        console.warn('[Desktop] Load favorites unavailable (restart main process?):', err.message);
    }
}

/**
 * 从收藏中恢复一个widget到桌面
 */
async function spawnFromFavorite(favoriteId, x, y) {
    if (window.electronAPI?.desktopLoadWidget) {
        try {
            const result = await window.electronAPI.desktopLoadWidget(favoriteId);
            if (result?.success && result.html) {
                const widgetId = `fav-${favoriteId}-${Date.now()}`;
                const widgetData = createWidget(widgetId, {
                    x: x || 150 + Math.random() * 200,
                    y: y || 100 + Math.random() * 200,
                });
                widgetData.savedId = favoriteId;
                widgetData.savedName = result.name || favoriteId;
                widgetData.contentBuffer = result.html;
                widgetData.contentContainer.innerHTML = result.html;
                processInlineStyles(widgetData);
                widgetData.isConstructing = false;
                widgetData.element.classList.remove('constructing');
                autoResizeWidget(widgetData);
                // 延迟执行脚本，等DOM渲染完成
                setTimeout(() => {
                    processInlineScripts(widgetData);
                }, 100);
                updateStatus('connected', `已加载: ${result.name}`);
            }
        } catch (err) {
            console.error('[Desktop] Spawn from favorite error:', err);
        }
    }
}

/**
 * 删除收藏
 */
async function deleteFavorite(favoriteId) {
    if (window.electronAPI?.desktopDeleteWidget) {
        try {
            const result = await window.electronAPI.desktopDeleteWidget(favoriteId);
            if (result?.success) {
                updateStatus('connected', '已删除收藏');
                loadFavoritesList();
            }
        } catch (err) {
            console.error('[Desktop] Delete favorite error:', err);
        }
    }
}

// ============================================================
// 侧栏系统
// ============================================================

function initSidebar() {
    const sidebar = document.getElementById('desktop-sidebar');
    if (!sidebar) return;

    // 关闭按钮
    sidebar.querySelector('.desktop-sidebar-close')?.addEventListener('click', () => {
        toggleSidebar(false);
    });

    // 侧栏收藏列表区域设置drop事件（用于从桌面拖回收藏夹 - 暂不实现）
}

function toggleSidebar(forceState) {
    const sidebar = document.getElementById('desktop-sidebar');
    if (!sidebar) return;

    const shouldOpen = forceState !== undefined ? forceState : !desktopState.sidebarOpen;
    desktopState.sidebarOpen = shouldOpen;

    if (shouldOpen) {
        sidebar.classList.add('open');
        loadFavoritesList(); // 每次打开刷新
    } else {
        sidebar.classList.remove('open');
    }
}

function renderSidebarFavorites() {
    const listContainer = document.getElementById('desktop-sidebar-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';

    if (desktopState.favorites.length === 0) {
        listContainer.innerHTML = '<div class="desktop-sidebar-empty">暂无收藏</div>';
        return;
    }

    desktopState.favorites.forEach(fav => {
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
            spawnFromFavorite(fav.id);
        });
        actions.appendChild(loadBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'desktop-sidebar-card-btn desktop-sidebar-card-btn-del';
        delBtn.textContent = '🗑';
        delBtn.title = '删除收藏';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`确定删除收藏 "${fav.name}" 吗？`)) {
                deleteFavorite(fav.id);
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

// 画布区域接收侧栏拖拽
canvas?.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-desktop-fav-id')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }
});

canvas?.addEventListener('drop', (e) => {
    const favId = e.dataTransfer.getData('application/x-desktop-fav-id');
    if (favId) {
        e.preventDefault();
        spawnFromFavorite(favId, e.clientX - 100, e.clientY - 30);
    }
});

// ============================================================
// IPC 监听 - 接收来自主窗口的流式推送
// ============================================================

if (window.electronAPI?.onDesktopPush) {
    window.electronAPI.onDesktopPush((data) => {
        const { action, widgetId, content, options } = data;

        switch (action) {
            case 'create':
                createWidget(widgetId, options);
                updateStatus('streaming', `正在渲染挂件: ${widgetId}`);
                break;

            case 'append':
                appendWidgetContent(widgetId, content);
                break;

            case 'finalize':
                finalizeWidget(widgetId);
                updateStatus('connected', `挂件渲染完成: ${widgetId}`);
                break;

            case 'replace':
                replaceInWidgets(data.targetSelector, content);
                updateStatus('streaming', `替换内容: ${data.targetSelector}`);
                break;

            case 'remove':
                removeWidget(widgetId);
                break;

            case 'clear':
                clearAllWidgets();
                break;

            default:
                console.warn(`[Desktop] Unknown action: ${action}`);
        }
    });
}

if (window.electronAPI?.onDesktopStatus) {
    window.electronAPI.onDesktopStatus((data) => {
        desktopState.isConnected = data.connected;
        updateStatus(
            data.connected ? 'connected' : 'waiting',
            data.message || (data.connected ? '已连接' : '等待连接...')
        );
    });
}

// ============================================================
// 调试工具
// ============================================================
window.__desktopDebug = {
    createWidget,
    appendWidgetContent,
    finalizeWidget,
    removeWidget,
    clearAllWidgets,
    getState: () => desktopState,

    test: () => {
        const id = 'test-' + Date.now();
        createWidget(id, { x: 200, y: 150, width: 300, height: 180 });

        let html = '';
        const chunks = [
            '<div style="padding:16px; background:rgba(0,0,0,0.3); border-radius:12px; color:#fff; font-family:sans-serif;">',
            '<h2 style="margin:0 0 8px 0; font-size:18px;">🌤 武汉 · 多云</h2>',
            '<p style="margin:0; font-size:32px; font-weight:bold;">18°C</p>',
            '<p style="margin:4px 0 0 0; font-size:12px; opacity:0.6;">湿度 65% · 东风 3级</p>',
            '</div>'
        ];

        let i = 0;
        const interval = setInterval(() => {
            if (i >= chunks.length) {
                clearInterval(interval);
                finalizeWidget(id);
                return;
            }
            html += chunks[i];
            appendWidgetContent(id, html.slice(0));
            const wd = desktopState.widgets.get(id);
            if (wd) {
                wd.contentBuffer = html;
                wd.contentContainer.innerHTML = html;
            }
            i++;
        }, 300);

        return id;
    }
};

// ============================================================
// vcpAPI 代理层 - 让 widget 脚本可以安全访问后端 API
// ============================================================

let _vcpCredentials = null; // 缓存凭据

/**
 * 初始化 vcpAPI 凭据
 */
async function initVcpApi() {
    if (!window.electronAPI?.desktopGetCredentials) {
        console.warn('[VCPdesktop] desktopGetCredentials not available');
        return;
    }
    try {
        const result = await window.electronAPI.desktopGetCredentials();
        if (result?.success && result.apiBaseUrl) {
            _vcpCredentials = {
                apiBaseUrl: result.apiBaseUrl,
                auth: btoa(result.username + ':' + result.password),
            };
            console.log('[VCPdesktop] vcpAPI credentials loaded, base:', _vcpCredentials.apiBaseUrl);
        } else {
            console.warn('[VCPdesktop] vcpAPI credentials not available');
        }
    } catch (err) {
        console.error('[VCPdesktop] Failed to load vcpAPI credentials:', err);
    }
}

/**
 * vcpAPI 代理 fetch - 全局可用
 * widget 脚本中通过 vcpAPI.fetch('/admin_api/weather') 调用
 */
window.__vcpProxyFetch = async function(endpoint, options = {}) {
    if (!_vcpCredentials) {
        throw new Error('vcpAPI not initialized - credentials not available');
    }
    const url = _vcpCredentials.apiBaseUrl + endpoint;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Basic ${_vcpCredentials.auth}`,
            ...(options.headers || {}),
        },
    });
    return response.json();
};

// DOMContentLoaded 中加载凭据并启动天气挂件
document.addEventListener('DOMContentLoaded', async () => {
    await initVcpApi();
    // 凭据加载完成后，自动加载天气挂件
    if (_vcpCredentials) {
        setTimeout(() => spawnWeatherWidget(), 500);
    }
});

// ============================================================
// 内置天气挂件
// ============================================================

async function spawnWeatherWidget() {
    const widgetId = 'builtin-weather';
    
    // 如果已存在则不重复创建
    if (desktopState.widgets.has(widgetId)) return;

    const weatherHtml = `
<style>
    .vw-container {
        padding: 20px;
        background: linear-gradient(135deg, rgba(30,60,114,0.85), rgba(42,82,152,0.75));
        border-radius: 12px;
        color: #fff;
        font-family: 'Segoe UI', -apple-system, sans-serif;
        min-width: 280px;
        backdrop-filter: blur(10px);
    }
    .vw-loading {
        text-align: center;
        padding: 20px;
        opacity: 0.6;
    }
    .vw-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
    }
    .vw-city {
        font-size: 13px;
        opacity: 0.7;
    }
    .vw-update-time {
        font-size: 11px;
        opacity: 0.5;
    }
    .vw-main {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 16px;
    }
    .vw-emoji {
        font-size: 48px;
        line-height: 1;
    }
    .vw-temp-block {}
    .vw-temp {
        font-size: 42px;
        font-weight: 300;
        line-height: 1;
    }
    .vw-temp-unit {
        font-size: 18px;
        opacity: 0.6;
    }
    .vw-desc {
        font-size: 14px;
        opacity: 0.8;
        margin-top: 2px;
    }
    .vw-details {
        display: flex;
        gap: 16px;
        font-size: 12px;
        opacity: 0.7;
        margin-bottom: 14px;
        flex-wrap: wrap;
    }
    .vw-forecast {
        display: flex;
        gap: 8px;
        overflow-x: auto;
    }
    .vw-forecast::-webkit-scrollbar { height: 0; }
    .vw-day {
        text-align: center;
        padding: 8px 6px;
        background: rgba(255,255,255,0.08);
        border-radius: 8px;
        min-width: 56px;
        flex-shrink: 0;
    }
    .vw-day-name { font-size: 11px; opacity: 0.6; }
    .vw-day-icon { font-size: 20px; margin: 4px 0; }
    .vw-day-temp { font-size: 11px; }
    .vw-warning {
        margin-top: 10px;
        padding: 6px 10px;
        background: rgba(255,150,0,0.2);
        border-left: 3px solid #f97316;
        border-radius: 4px;
        font-size: 11px;
    }
    .vw-aqi {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        margin-top: 4px;
    }
</style>
<div class="vw-container">
    <div class="vw-loading" id="vw-loading">🌤️ 正在获取天气数据...</div>
    <div id="vw-content" style="display:none;"></div>
</div>
<script>
(function() {
    var emojiMap = {
        '100':'☀️','150':'☀️','101':'⛅','151':'⛅','102':'🌤️','152':'🌤️',
        '103':'⛅','153':'⛅','104':'☁️','154':'☁️','300':'🌧️','301':'🌧️',
        '302':'⛈️','303':'⛈️','305':'🌦️','306':'🌧️','307':'🌧️','308':'🌊',
        '309':'🌦️','400':'🌨️','401':'🌨️','402':'❄️','500':'🌫️','501':'🌫️',
        '502':'🌁','900':'🌡️','901':'❄️','999':'🌈'
    };
    function getEmoji(code) { return emojiMap[String(code)] || '🌡️'; }
    function getAqiStyle(cat) {
        var m = {'优':'background:#00e400;color:#fff','良':'background:#ffff00;color:#333',
            '轻度污染':'background:#ff7e00;color:#fff','中度污染':'background:#ff0000;color:#fff'};
        return m[cat] || 'background:#999;color:#fff';
    }
    var weekDays = ['周日','周一','周二','周三','周四','周五','周六'];
    
    async function loadWeather() {
        try {
            var data = await window.__vcpProxyFetch('/admin_api/weather');
            var now = new Date();
            var loadingEl = document.getElementById('vw-loading');
            var contentEl = document.getElementById('vw-content');
            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl) contentEl.style.display = 'block';
            
            // 找当前小时的天气
            var current = null;
            if (data.hourly && data.hourly.length > 0) {
                var minDiff = Infinity;
                for (var h of data.hourly) {
                    var diff = Math.abs(new Date(h.fxTime).getTime() - now.getTime());
                    if (diff < minDiff) { minDiff = diff; current = h; }
                }
            }
            var today = null;
            if (data.daily && data.daily.length > 0) {
                var todayStr = now.toISOString().slice(0,10);
                today = data.daily.find(function(d){return d.fxDate===todayStr}) || data.daily[0];
            }

            var html = '';
            
            // 头部
            html += '<div class="vw-header">';
            html += '<span class="vw-city">' + (data.city || '天气预报') + '</span>';
            html += '<span class="vw-update-time">' + now.getHours() + ':' + String(now.getMinutes()).padStart(2,'0') + '</span>';
            html += '</div>';
            
            // 主温度区
            if (current || today) {
                var temp = current ? current.temp : (today ? today.tempMax : '--');
                var text = current ? current.text : (today ? today.textDay : '--');
                var icon = current ? current.icon : (today ? today.iconDay : '999');
                var humidity = current ? current.humidity : (today ? today.humidity : '--');
                var windDir = current ? current.windDir : (today ? today.windDirDay : '--');
                var windScale = current ? current.windScale : (today ? today.windScaleDay : '--');
                var tempRange = today ? (today.tempMin + '°~' + today.tempMax + '°') : '';
                
                html += '<div class="vw-main">';
                html += '<span class="vw-emoji">' + getEmoji(icon) + '</span>';
                html += '<div class="vw-temp-block">';
                html += '<div><span class="vw-temp">' + temp + '</span><span class="vw-temp-unit">°C</span></div>';
                html += '<div class="vw-desc">' + text + '</div>';
                html += '</div>';
                html += '</div>';
                
                html += '<div class="vw-details">';
                html += '<span>🌡️ ' + tempRange + '</span>';
                html += '<span>💧 ' + humidity + '%</span>';
                html += '<span>🌬️ ' + windDir + ' ' + windScale + '级</span>';
                html += '</div>';
            }
            
            // 空气质量
            if (data.airQuality) {
                html += '<div><span class="vw-aqi" style="' + getAqiStyle(data.airQuality.category) + '">';
                html += 'AQI ' + data.airQuality.aqi + ' ' + data.airQuality.category;
                html += '</span></div>';
            }
            
            // 预警
            if (data.warning && data.warning.length > 0) {
                for (var w of data.warning) {
                    html += '<div class="vw-warning">⚠️ ' + w.title + '</div>';
                }
            }
            
            // 未来天气
            if (data.daily && data.daily.length > 1) {
                html += '<div class="vw-forecast">';
                var futureDays = data.daily.slice(1, 5);
                for (var day of futureDays) {
                    var d = new Date(day.fxDate);
                    html += '<div class="vw-day">';
                    html += '<div class="vw-day-name">' + weekDays[d.getDay()] + '</div>';
                    html += '<div class="vw-day-icon">' + getEmoji(day.iconDay) + '</div>';
                    html += '<div class="vw-day-temp">' + day.tempMin + '°~' + day.tempMax + '°</div>';
                    html += '</div>';
                }
                html += '</div>';
            }
            
            contentEl.innerHTML = html;
        } catch(e) {
            var loadingEl = document.getElementById('vw-loading');
            if (loadingEl) loadingEl.innerHTML = '❌ 天气获取失败: ' + e.message;
            console.error('[Weather Widget]', e);
        }
    }
    
    loadWeather();
    // 每30分钟自动刷新
    setInterval(loadWeather, 30 * 60 * 1000);
})();
</script>
`;

    const widgetData = createWidget(widgetId, {
        x: 40,
        y: TITLE_BAR_HEIGHT + 20,
        width: 320,
        height: 280,
    });

    widgetData.contentBuffer = weatherHtml;
    widgetData.contentContainer.innerHTML = weatherHtml;
    processInlineStyles(widgetData);
    widgetData.isConstructing = false;
    widgetData.element.classList.remove('constructing');
    autoResizeWidget(widgetData);

    // 延迟执行脚本
    setTimeout(() => {
        processInlineScripts(widgetData);
    }, 100);

    console.log('[VCPdesktop] Weather widget spawned.');
}

// ============================================================
// 内置迷你音乐播放条
// ============================================================

async function spawnMusicWidget() {
    const widgetId = 'builtin-music';
    if (desktopState.widgets.has(widgetId)) return;

    const musicHtml = `
<style>
    .vm-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        background: linear-gradient(135deg, rgba(20,20,35,0.88), rgba(35,25,50,0.82));
        border-radius: 24px;
        color: #fff;
        font-family: 'Segoe UI', -apple-system, sans-serif;
        backdrop-filter: blur(12px);
        min-width: 300px;
        white-space: nowrap;
        user-select: none;
    }
    .vm-art {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: linear-gradient(135deg, #667eea, #764ba2);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        flex-shrink: 0;
        animation: vm-spin 8s linear infinite paused;
    }
    .vm-art.playing { animation-play-state: running; }
    @keyframes vm-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
    .vm-info {
        flex: 1;
        min-width: 0;
        overflow: hidden;
    }
    .vm-title {
        font-size: 13px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .vm-time {
        font-size: 10px;
        opacity: 0.5;
    }
    .vm-controls {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
    }
    .vm-btn {
        width: 30px;
        height: 30px;
        border: none;
        background: rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.8);
        border-radius: 50%;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
    }
    .vm-btn:hover {
        background: rgba(255,255,255,0.18);
        color: #fff;
        transform: scale(1.08);
    }
    .vm-btn-play {
        width: 34px;
        height: 34px;
        background: rgba(255,255,255,0.12);
        font-size: 16px;
    }
    .vm-progress {
        position: absolute;
        bottom: 0;
        left: 16px;
        right: 16px;
        height: 3px;
        background: rgba(255,255,255,0.1);
        border-radius: 2px;
        overflow: hidden;
        cursor: pointer;
    }
    .vm-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #667eea, #764ba2);
        width: 0%;
        border-radius: 2px;
        transition: width 0.3s ease;
    }
    .vm-container {
        position: relative;
        padding-bottom: 6px;
    }
    .vm-offline {
        padding: 12px 20px;
        background: rgba(20,20,35,0.85);
        border-radius: 24px;
        color: rgba(255,255,255,0.4);
        font-size: 12px;
        text-align: center;
        backdrop-filter: blur(12px);
    }
</style>
<div class="vm-container">
    <div class="vm-bar" id="vm-bar">
        <div class="vm-art" id="vm-art">🎵</div>
        <div class="vm-info">
            <div class="vm-title" id="vm-title">未在播放</div>
            <div class="vm-time" id="vm-time">--:-- / --:--</div>
        </div>
        <div class="vm-controls">
            <button class="vm-btn" id="vm-prev" title="上一首">⏮</button>
            <button class="vm-btn vm-btn-play" id="vm-play" title="播放/暂停">▶</button>
            <button class="vm-btn" id="vm-next" title="下一首">⏭</button>
        </div>
    </div>
    <div class="vm-progress" id="vm-progress">
        <div class="vm-progress-fill" id="vm-progress-fill"></div>
    </div>
</div>
<script>
(function() {
    var isPlaying = false;
    var pollTimer = null;

    var playBtn = document.getElementById('vm-play');
    var prevBtn = document.getElementById('vm-prev');
    var nextBtn = document.getElementById('vm-next');
    var titleEl = document.getElementById('vm-title');
    var timeEl = document.getElementById('vm-time');
    var artEl = document.getElementById('vm-art');
    var progressFill = document.getElementById('vm-progress-fill');
    var progressBar = document.getElementById('vm-progress');

    function formatTime(secs) {
        if (!secs || isNaN(secs)) return '--:--';
        var m = Math.floor(secs / 60);
        var s = Math.floor(secs % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    async function updateState() {
        try {
            var state = await musicAPI.getState();
            if (!state) return;
            
            isPlaying = state.is_playing || false;
            playBtn.textContent = isPlaying ? '\\u23F8' : '\\u25B6';
            
            if (isPlaying) {
                artEl.classList.add('playing');
            } else {
                artEl.classList.remove('playing');
            }
            
            // 曲名 - Rust引擎返回 file_path
            var filePath = state.file_path || state.current_file || '';
            if (filePath) {
                var parts = filePath.split(/[\\\\\\/]/);
                var name = parts[parts.length - 1] || '';
                var dotIdx = name.lastIndexOf('.');
                if (dotIdx > 0) name = name.substring(0, dotIdx);
                titleEl.textContent = name || '未知曲目';
            } else {
                titleEl.textContent = '未在播放';
            }
            
            // 时间和进度
            var pos = state.position_secs || state.position || 0;
            var dur = state.duration_secs || state.duration || 0;
            timeEl.textContent = formatTime(pos) + ' / ' + formatTime(dur);
            
            if (dur > 0) {
                progressFill.style.width = (pos / dur * 100) + '%';
            } else {
                progressFill.style.width = '0%';
            }
        } catch(e) {
            console.warn('[MusicWidget] updateState error:', e);
        }
    }

    // 播放/暂停
    playBtn.addEventListener('click', async function() {
        try {
            if (isPlaying) {
                await musicAPI.pause();
            } else {
                await musicAPI.play();
            }
            setTimeout(updateState, 200);
        } catch(e) { console.error('[MusicWidget]', e); }
    });

    // 上一首/下一首 - 通过主窗口的 music-command 通道
    // 桌面窗口没有直接的 prev/next IPC，需要通过 electron.send
    prevBtn.addEventListener('click', function() {
        // 通过主进程转发给音乐窗口
        try { musicAPI.send('music-remote-command', 'previous'); } catch(e) {}
        setTimeout(updateState, 500);
    });

    nextBtn.addEventListener('click', function() {
        try { musicAPI.send('music-remote-command', 'next'); } catch(e) {}
        setTimeout(updateState, 500);
    });

    // 进度条点击 seek
    progressBar.addEventListener('click', async function(e) {
        try {
            var state = await musicAPI.getState();
            if (state && state.duration_secs > 0) {
                var rect = progressBar.getBoundingClientRect();
                var ratio = (e.clientX - rect.left) / rect.width;
                var seekPos = ratio * state.duration_secs;
                await musicAPI.seek(seekPos);
                setTimeout(updateState, 200);
            }
        } catch(e) {}
    });

    // 初始状态 + 定时轮询
    updateState();
    pollTimer = setInterval(updateState, 2000);
})();
</script>
`;

    const widgetData = createWidget(widgetId, {
        x: 40,
        y: window.innerHeight - 100,
        width: 360,
        height: 60,
    });

    widgetData.contentBuffer = musicHtml;
    widgetData.contentContainer.innerHTML = musicHtml;
    processInlineStyles(widgetData);
    widgetData.isConstructing = false;
    widgetData.element.classList.remove('constructing');
    autoResizeWidget(widgetData);

    setTimeout(() => {
        processInlineScripts(widgetData);
    }, 100);

    console.log('[VCPdesktop] Music mini-bar widget spawned.');
}

// 也在启动时加载音乐条
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => spawnMusicWidget(), 800);
});

// 暴露到调试接口
window.__desktopDebug.spawnWeatherWidget = spawnWeatherWidget;
window.__desktopDebug.spawnMusicWidget = spawnMusicWidget;

console.log('[VCPdesktop] Desktop canvas renderer initialized.');
console.log('[VCPdesktop] Debug: window.__desktopDebug.test() to create a test widget.');