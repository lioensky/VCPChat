/**
 * VCPdesktop - 挂件管理核心模块
 * 负责：挂件创建/删除/内容管理、Shadow DOM 隔离、内联脚本/样式处理、自动尺寸调整
 */

'use strict';

(function () {
    const { state, CONSTANTS, domRefs, drag, zIndex } = window.VCPDesktop;

    // ============================================================
    // 挂件创建
    // ============================================================

    /**
     * 创建挂件容器
     * @param {string} widgetId - 挂件唯一标识
     * @param {object} [options] - 位置/尺寸选项
     * @returns {object} widgetData
     */
    function createWidget(widgetId, options = {}) {
        if (state.widgets.has(widgetId)) {
            console.log(`[Desktop] Widget ${widgetId} already exists, reusing.`);
            return state.widgets.get(widgetId);
        }

        const widget = document.createElement('div');
        widget.className = 'desktop-widget constructing entering';
        widget.dataset.widgetId = widgetId;

        const x = options.x || 100;
        const y = Math.max(options.y || 100, CONSTANTS.TITLE_BAR_HEIGHT + 4);
        const width = options.width || 320;
        const height = options.height || 200;

        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;
        widget.style.width = `${width}px`;
        widget.style.height = `${height}px`;

        // 分配z-index
        const z = zIndex.allocate();
        widget.style.zIndex = z;

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
            // 锁定状态下禁止关闭挂件
            if (state.desktopLocked) return;
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
        domRefs.canvas.appendChild(widget);

        // 进入动画
        widget.addEventListener('animationend', () => {
            widget.classList.remove('entering');
        }, { once: true });

        // 拖拽
        drag.setup(widget, grip);

        // 右键菜单
        widget.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.VCPDesktop.contextMenu) {
                window.VCPDesktop.contextMenu.show(e.clientX, e.clientY, widgetId);
            }
        });

        // 点击提升层级
        widget.addEventListener('mousedown', () => {
            zIndex.bringToFront(widgetId);
        });

        const widgetData = {
            element: widget,
            shadowRoot: shadowRoot,
            contentContainer: contentContainer,
            contentBuffer: '',
            isConstructing: true,
            zIndex: z,
            savedName: null,
            savedId: null,
            _resizeObserver: null,
        };

        // 监听 Shadow DOM 内容变化，自动调整尺寸
        // 这确保异步脚本（如天气数据加载）修改内容后挂件能自动适配
        setupContentObserver(widgetData);

        state.widgets.set(widgetId, widgetData);
        console.log(`[Desktop] Widget created: ${widgetId}`);
        return widgetData;
    }

    // ============================================================
    // 挂件内容管理
    // ============================================================

    /**
     * 设置挂件的完整内容
     * @param {string} widgetId
     * @param {string} fullContent - HTML 内容
     */
    function appendWidgetContent(widgetId, fullContent) {
        let widgetData = state.widgets.get(widgetId);
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
     * 流式替换挂件中指定元素的内容
     * @param {string} targetSelector - CSS 选择器
     * @param {string} newContent - 新 HTML 内容
     * @returns {boolean} 是否找到并替换
     */
    function replaceInWidgets(targetSelector, newContent) {
        let found = false;
        for (const [widgetId, widgetData] of state.widgets) {
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

    // ============================================================
    // 挂件渲染完成
    // ============================================================

    /**
     * 完成挂件渲染
     * @param {string} widgetId
     */
    function finalizeWidget(widgetId) {
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) return;

        widgetData.isConstructing = false;
        widgetData.element.classList.remove('constructing');

        processInlineScripts(widgetData);

        console.log(`[Desktop] Widget finalized: ${widgetId}`);
    }

    // ============================================================
    // 挂件删除
    // ============================================================

    /**
     * 移除挂件（带退出动画）
     * @param {string} widgetId
     */
    function removeWidget(widgetId) {
        const widgetData = state.widgets.get(widgetId);
        if (!widgetData) return;

        // 断开内容观察器，防止内存泄漏
        if (widgetData._resizeObserver) {
            widgetData._resizeObserver.disconnect();
            widgetData._resizeObserver = null;
        }

        widgetData.element.classList.add('removing');
        widgetData.element.addEventListener('animationend', () => {
            widgetData.element.remove();
            state.widgets.delete(widgetId);
            console.log(`[Desktop] Widget removed: ${widgetId}`);
        }, { once: true });
    }

    /**
     * 清除所有挂件
     */
    function clearAllWidgets() {
        state.widgets.forEach((_, id) => removeWidget(id));
    }

    // ============================================================
    // 自动尺寸调整
    // ============================================================

    /**
     * 自动调整挂件尺寸以适配内容
     * @param {object} widgetData
     */
    function autoResizeWidget(widgetData) {
        // 如果挂件标记了固定尺寸，跳过自动调整
        if (widgetData.fixedSize) return;

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

            const maxRatio = CONSTANTS.AUTO_RESIZE_MAX_RATIO;
            const newWidth = Math.min(
                window.innerWidth * maxRatio,
                Math.max(CONSTANTS.AUTO_RESIZE_MIN_W, contentWidth + CONSTANTS.AUTO_RESIZE_PAD_W)
            );
            const newHeight = Math.min(
                window.innerHeight * maxRatio,
                Math.max(CONSTANTS.AUTO_RESIZE_MIN_H, contentHeight + CONSTANTS.AUTO_RESIZE_PAD_H)
            );

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
     * 为挂件设置 MutationObserver，监听内容变化自动调整尺寸
     * 解决异步脚本（如天气数据加载、收藏恢复）修改内容后尺寸不更新的问题
     * @param {object} widgetData
     */
    function setupContentObserver(widgetData) {
        let resizeTimer = null;
        const debouncedResize = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                autoResizeWidget(widgetData);
            }, 150);
        };

        const observer = new MutationObserver((mutations) => {
            // 只在有实质性内容变化时触发
            let hasContentChange = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
                    hasContentChange = true;
                    break;
                }
                if (mutation.type === 'characterData') {
                    hasContentChange = true;
                    break;
                }
            }
            if (hasContentChange) {
                debouncedResize();
            }
        });

        observer.observe(widgetData.contentContainer, {
            childList: true,
            subtree: true,
            characterData: true,
        });

        widgetData._resizeObserver = observer;
    }

    // ============================================================
    // 内联样式/脚本处理
    // ============================================================

    /**
     * 处理内联 style 标签，提升到 Shadow DOM 根级
     * @param {object} widgetData
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
     * 生成沙箱包裹代码
     * 将用户脚本包裹在一个 IIFE 中，覆盖 document 对象指向 Shadow DOM，
     * 同时暴露 vcpAPI、musicAPI 等安全接口。
     * @param {string} widgetId - 挂件唯一标识
     * @param {string} userCode - 用户脚本源代码
     * @returns {string} 包裹后的代码
     */
    function buildSandboxCode(widgetId, userCode) {
        return `(function(_realDoc) {
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
                        createRange: _realDoc.createRange.bind(_realDoc),
                        createComment: _realDoc.createComment.bind(_realDoc),
                        createDocumentFragment: _realDoc.createDocumentFragment.bind(_realDoc),
                        addEventListener: function(type, fn, opts) { root.addEventListener(type, fn, opts); },
                        removeEventListener: function(type, fn, opts) { root.removeEventListener(type, fn, opts); },
                        body: root,
                        head: _realDoc.head,
                        documentElement: root,
                    };
                    
                    var vcpAPI = {
                        fetch: function(endpoint, opts) { return window.__vcpProxyFetch(endpoint, opts); },
                        post: function(messages, opts) { return window.__vcpProxyPost(messages, opts); },
                        weather: function() { return window.__vcpProxyFetch('/admin_api/weather'); },
                    };
                    
                    var widgetFS = {
                        saveFile: function(fileName, content, encoding) {
                            var _savedId = null;
                            try {
                                var _wEl = _realDoc.querySelector('[data-widget-id="${widgetId}"]');
                                if (_wEl) {
                                    var _wd = window.VCPDesktop.state.widgets.get('${widgetId}');
                                    if (_wd) _savedId = _wd.savedId;
                                }
                            } catch(e) {}
                            if (!_savedId) return Promise.reject('Widget not saved yet. Save it first via favorites.');
                            return window.electronAPI ? window.electronAPI.desktopSaveWidgetFile({
                                widgetId: _savedId,
                                fileName: fileName,
                                content: content,
                                encoding: encoding || 'utf-8'
                            }) : Promise.reject('electronAPI not available');
                        },
                        loadFile: function(fileName) {
                            var _savedId = null;
                            try {
                                var _wd = window.VCPDesktop.state.widgets.get('${widgetId}');
                                if (_wd) _savedId = _wd.savedId;
                            } catch(e) {}
                            if (!_savedId) return Promise.reject('Widget not saved yet.');
                            return window.electronAPI ? window.electronAPI.desktopLoadWidgetFile({
                                widgetId: _savedId,
                                fileName: fileName
                            }) : Promise.reject('electronAPI not available');
                        },
                        listFiles: function() {
                            var _savedId = null;
                            try {
                                var _wd = window.VCPDesktop.state.widgets.get('${widgetId}');
                                if (_wd) _savedId = _wd.savedId;
                            } catch(e) {}
                            if (!_savedId) return Promise.reject('Widget not saved yet.');
                            return window.electronAPI ? window.electronAPI.desktopListWidgetFiles(_savedId) : Promise.reject('electronAPI not available');
                        },
                    };
                    
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
                    
                    ${userCode}
                })(window.document);`;
    }

    /**
     * 处理内联 & 外部 script 标签，注入 Shadow DOM 安全沙箱
     *
     * 内联脚本：直接包裹在沙箱 IIFE 中执行。
     * 外部脚本（src）：
     *   - 本地/同源 JS：通过 fetch 获取代码内容，然后沙箱包裹执行
     *   - CDN/跨域 JS（如第三方库）：保持原样加载（无法 fetch 跨域代码）
     *
     * 这使得 AI 可以在 widget 文件夹中创建多个 JS 文件，
     * HTML 通过 <script src="app.js"> 引用，所有 JS 都在沙箱内执行。
     *
     * @param {object} widgetData
     */
    function processInlineScripts(widgetData) {
        const scriptElements = widgetData.contentContainer.querySelectorAll('script');
        const widgetId = widgetData.element.dataset.widgetId;

        scriptElements.forEach(oldScript => {
            if (oldScript.src) {
                // 外部脚本：判断是否为本地/同源
                const scriptUrl = oldScript.src;
                const isLocalOrSameOrigin = _isLocalScript(scriptUrl);

                if (isLocalOrSameOrigin) {
                    // 本地/同源脚本：fetch 代码内容，沙箱包裹执行
                    // 先移除原 script 标签（防止浏览器自动执行）
                    const placeholder = document.createComment(`[VCPdesktop] Loading external script: ${scriptUrl}`);
                    oldScript.replaceWith(placeholder);

                    fetch(scriptUrl)
                        .then(response => {
                            if (!response.ok) {
                                throw new Error(`HTTP ${response.status}: ${scriptUrl}`);
                            }
                            return response.text();
                        })
                        .then(code => {
                            const newScript = document.createElement('script');
                            newScript.textContent = buildSandboxCode(widgetId, code);
                            placeholder.parentNode.insertBefore(newScript, placeholder.nextSibling);
                            console.log(`[Desktop] External script loaded & sandboxed: ${scriptUrl}`);
                        })
                        .catch(err => {
                            console.warn(`[Desktop] Failed to fetch external script: ${scriptUrl}`, err.message);
                            // 回退：直接以原始方式加载（不做沙箱包裹）
                            const fallbackScript = document.createElement('script');
                            fallbackScript.src = scriptUrl;
                            placeholder.parentNode.insertBefore(fallbackScript, placeholder.nextSibling);
                        });
                } else {
                    // 跨域/CDN 脚本：直接透传加载（如 Chart.js、Three.js 等第三方库）
                    const newScript = document.createElement('script');
                    newScript.src = oldScript.src;
                    if (oldScript.type) newScript.type = oldScript.type;
                    if (oldScript.crossOrigin) newScript.crossOrigin = oldScript.crossOrigin;
                    oldScript.replaceWith(newScript);
                    console.log(`[Desktop] CDN/external script passthrough: ${scriptUrl}`);
                }
            } else {
                // 内联脚本：沙箱包裹
                const newScript = document.createElement('script');
                newScript.textContent = buildSandboxCode(widgetId, oldScript.textContent);
                oldScript.replaceWith(newScript);
            }
        });
    }

    /**
     * 判断 script src 是否为本地/同源脚本
     * 本地脚本：file:// 协议、相对路径、同源 http(s)
     * CDN/跨域：不同域名的 http(s) URL
     * @param {string} url - script 的 src 属性值
     * @returns {boolean}
     */
    function _isLocalScript(url) {
        try {
            // 相对路径（不以协议开头）总是视为本地
            if (!url.includes('://')) return true;

            const scriptUrl = new URL(url);

            // file:// 协议始终视为本地
            if (scriptUrl.protocol === 'file:') return true;

            // 同源检查
            if (window.location.protocol === 'file:') {
                // desktop.html 自身通过 file:// 加载，所有 http(s) 视为跨域
                return false;
            }

            return scriptUrl.origin === window.location.origin;
        } catch (e) {
            // URL 解析失败，保守地视为本地
            return true;
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.widget = {
        create: createWidget,
        appendContent: appendWidgetContent,
        replaceInWidgets,
        finalize: finalizeWidget,
        remove: removeWidget,
        clearAll: clearAllWidgets,
        autoResize: autoResizeWidget,
        processInlineStyles,
        processInlineScripts,
    };

})();