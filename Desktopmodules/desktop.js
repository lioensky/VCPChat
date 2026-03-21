/**
 * VCPdesktop - 桌面画布渲染器
 * 负责：接收IPC流式token、挂件创建/管理、拖拽交互、样式隔离
 */

'use strict';

// ============================================================
// 全局状态
// ============================================================
const desktopState = {
    widgets: new Map(),          // id -> { element, shadowRoot, contentBuffer, isConstructing }
    dragState: null,             // 当前拖拽状态
    isConnected: false,
};

const canvas = document.getElementById('desktop-canvas');
const statusIndicator = document.getElementById('desktop-status-indicator');
const statusDot = statusIndicator?.querySelector('.desktop-status-dot');
const statusText = statusIndicator?.querySelector('.desktop-status-text');

// ============================================================
// 标题栏控制
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // 窗口控制按钮
    document.getElementById('desktop-btn-minimize')?.addEventListener('click', () => {
        window.electronAPI?.minimizeWindow();
    });
    document.getElementById('desktop-btn-maximize')?.addEventListener('click', () => {
        window.electronAPI?.maximizeWindow();
    });
    document.getElementById('desktop-btn-close')?.addEventListener('click', () => {
        window.electronAPI?.closeWindow();
    });

    // 主题同步
    initThemeSync();

    // 状态指示
    updateStatus('waiting', '等待主窗口连接...');
    setTimeout(() => {
        statusIndicator?.classList.add('hidden');
    }, 3000);
});

// ============================================================
// 主题同步
// ============================================================
function initThemeSync() {
    // 从URL参数读取初始主题
    const params = new URLSearchParams(window.location.search);
    const initialTheme = params.get('currentThemeMode');
    if (initialTheme === 'light') {
        document.body.classList.add('light-theme');
    }

    // 监听主题变更
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

    // 非streaming状态3秒后自动隐藏
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
 * @param {string} widgetId - 挂件唯一标识
 * @param {object} options - { x, y, width, height }
 */
function createWidget(widgetId, options = {}) {
    if (desktopState.widgets.has(widgetId)) {
        console.log(`[Desktop] Widget ${widgetId} already exists, reusing.`);
        return desktopState.widgets.get(widgetId);
    }

    const widget = document.createElement('div');
    widget.className = 'desktop-widget constructing entering';
    widget.dataset.widgetId = widgetId;

    // 定位
    const x = options.x || 100;
    const y = options.y || 100;
    const width = options.width || 320;
    const height = options.height || 200;

    widget.style.left = `${x}px`;
    widget.style.top = `${y}px`;
    widget.style.width = `${width}px`;
    widget.style.height = `${height}px`;

    // 抓手带
    const grip = document.createElement('div');
    grip.className = 'desktop-widget-grip';
    widget.appendChild(grip);

    // 关闭按钮（hover时出现在右上角）
    const closeBtn = document.createElement('button');
    closeBtn.className = 'desktop-widget-close-btn';
    closeBtn.innerHTML = '✕';
    closeBtn.title = '关闭挂件';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeWidget(widgetId);
    });
    widget.appendChild(closeBtn);

    // 内容区（使用Shadow DOM实现样式隔离）
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'desktop-widget-content';
    
    const shadowRoot = contentWrapper.attachShadow({ mode: 'open' });
    
    // 在Shadow DOM中注入基础样式
    const shadowStyle = document.createElement('style');
    shadowStyle.textContent = `
        :host {
            display: block;
            width: 100%;
            height: 100%;
            overflow: auto;
        }
        * {
            box-sizing: border-box;
        }
        /* 滚动条美化 */
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 2px; }
    `;
    shadowRoot.appendChild(shadowStyle);

    // 内容容器
    const contentContainer = document.createElement('div');
    contentContainer.className = 'widget-inner-content';
    shadowRoot.appendChild(contentContainer);

    widget.appendChild(contentWrapper);
    canvas.appendChild(widget);

    // 进入动画结束后移除entering类
    widget.addEventListener('animationend', () => {
        widget.classList.remove('entering');
    }, { once: true });

    // 设置拖拽
    setupDrag(widget, grip);

    const widgetData = {
        element: widget,
        shadowRoot: shadowRoot,
        contentContainer: contentContainer,
        contentBuffer: '',
        isConstructing: true,
    };

    desktopState.widgets.set(widgetId, widgetData);
    console.log(`[Desktop] Widget created: ${widgetId}`);
    return widgetData;
}

/**
 * 设置挂件的完整内容（全量覆盖方式，用于流式渲染）
 * 每次调用都用完整的累积buffer替换，实现"生长"效果
 * 同时自动调整挂件尺寸以适应内容
 * @param {string} widgetId
 * @param {string} fullContent - 当前累积的完整HTML内容
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

    // 自适应尺寸：根据内容的实际尺寸调整挂件大小
    autoResizeWidget(widgetData);
}

/**
 * 根据Shadow DOM内容的实际尺寸自动调整挂件大小
 * 使用 requestAnimationFrame 确保在渲染后测量
 */
function autoResizeWidget(widgetData) {
    requestAnimationFrame(() => {
        const container = widgetData.contentContainer;
        if (!container) return;

        // 获取内容的实际尺寸
        const contentWidth = container.scrollWidth;
        const contentHeight = container.scrollHeight;

        // 限制最小/最大尺寸
        const MIN_WIDTH = 120;
        const MIN_HEIGHT = 60;
        const MAX_WIDTH = window.innerWidth * 0.8;
        const MAX_HEIGHT = window.innerHeight * 0.8;

        // 添加padding余量（抓手带 + 内边距）
        const paddingW = 16;
        const paddingH = 24; // 包含抓手带高度

        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, contentWidth + paddingW));
        const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, contentHeight + paddingH));

        const widget = widgetData.element;
        // 使用平滑过渡
        widget.style.transition = 'width 0.15s ease-out, height 0.15s ease-out';
        widget.style.width = `${newWidth}px`;
        widget.style.height = `${newHeight}px`;

        // 过渡结束后清除transition，避免影响拖拽
        setTimeout(() => {
            widget.style.transition = '';
        }, 200);
    });
}

/**
 * 处理内联<style>标签，将其提取到Shadow DOM中
 */
function processInlineStyles(widgetData) {
    const styleElements = widgetData.contentContainer.querySelectorAll('style');
    styleElements.forEach(styleEl => {
        // 移到shadowRoot顶层
        const newStyle = document.createElement('style');
        newStyle.textContent = styleEl.textContent;
        widgetData.shadowRoot.insertBefore(newStyle, widgetData.contentContainer);
        styleEl.remove();
    });
}

/**
 * 完成挂件渲染（施工态结束）
 * @param {string} widgetId
 */
function finalizeWidget(widgetId) {
    const widgetData = desktopState.widgets.get(widgetId);
    if (!widgetData) return;

    widgetData.isConstructing = false;
    widgetData.element.classList.remove('constructing');

    // 处理内联脚本
    processInlineScripts(widgetData);

    console.log(`[Desktop] Widget finalized: ${widgetId}`);
}

/**
 * 处理内联<script>标签
 * 关键：将脚本包装在闭包中，注入 shadowRoot 引用
 * 这样挂件脚本中可以用 `root.querySelector()` 操作自身DOM
 * 而不是用 `document.querySelector()` 操作宿主文档
 */
function processInlineScripts(widgetData) {
    const scriptElements = widgetData.contentContainer.querySelectorAll('script');
    scriptElements.forEach(oldScript => {
        const newScript = document.createElement('script');
        if (oldScript.src) {
            newScript.src = oldScript.src;
        } else {
            // 包装脚本在沙箱闭包中，注入 root 变量 + 覆盖 document 查询方法
            // 这样AI编写的脚本中 document.querySelector('#xxx') 和 document.getElementById('xxx')
            // 都会自动在 Shadow DOM 内查找，而不是在宿主文档中查找
            const widgetId = widgetData.element.dataset.widgetId;
            // 使用 window.document 获取原始document引用，避免变量提升导致的引用问题
            newScript.textContent = `(function(_realDoc) {
                var _shadowRoot = _realDoc.querySelector('[data-widget-id="${widgetId}"] .desktop-widget-content').shadowRoot;
                var root = _shadowRoot.querySelector('.widget-inner-content');
                var widgetId = '${widgetId}';
                
                // 覆盖 document 查询方法，让AI脚本中的 document.querySelector 自动在 Shadow DOM 内查找
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
                
                ${oldScript.textContent}
            })(window.document);`;
        }
        oldScript.replaceWith(newScript);
    });
}

/**
 * 移除挂件
 * @param {string} widgetId
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
// 拖拽系统（抓手带拖拽，解决拖拽/点击竞态）
// ============================================================
function setupDrag(widgetElement, gripElement) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    gripElement.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // 只响应左键
        e.preventDefault();
        e.stopPropagation();

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        originLeft = parseInt(widgetElement.style.left) || 0;
        originTop = parseInt(widgetElement.style.top) || 0;

        gripElement.style.cursor = 'grabbing';

        // 拖拽期间提升z-index
        widgetElement.style.zIndex = '1000';

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        widgetElement.style.left = `${originLeft + dx}px`;
        widgetElement.style.top = `${originTop + dy}px`;
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;
        gripElement.style.cursor = '';
        widgetElement.style.zIndex = '';

        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
}

// ============================================================
// IPC 监听 - 接收来自主窗口的流式推送
// ============================================================

// 监听桌面推送数据
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

// 监听连接状态
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
// 调试用：直接在画布上测试挂件
// ============================================================
window.__desktopDebug = {
    createWidget,
    appendWidgetContent,
    finalizeWidget,
    removeWidget,
    clearAllWidgets,
    getState: () => desktopState,
    
    // 快速测试
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
            appendWidgetContent(id, html.slice(0)); // 全量更新
            // 实际上appendWidgetContent是累加buffer的，这里直接重置
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

console.log('[VCPdesktop] Desktop canvas renderer initialized.');
console.log('[VCPdesktop] Debug: window.__desktopDebug.test() to create a test widget.');