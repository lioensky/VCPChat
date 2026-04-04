/**
 * VCPdesktop - 内置新闻热点挂件模块
 * 负责：调用 /admin_api/dailyhot 获取今日热点，分来源标签页 + 虚拟滚动
 */

'use strict';

(function () {
    const { state, CONSTANTS, widget } = window.VCPDesktop;

    // 新闻挂件 HTML 模板（使用数组拼接避免模板字符串截断）
    var NEWS_HTML = [
        '<style>',
        '.vn-container { padding: 0; background: linear-gradient(135deg, rgba(18,18,32,0.92), rgba(28,22,42,0.88)); border-radius: 12px; color: #fff; font-family: "Segoe UI", -apple-system, sans-serif; min-width: 260px; max-width: 320px; max-height: 480px; display: flex; flex-direction: column; backdrop-filter: blur(12px); overflow: hidden; }',
        '.vn-header { padding: 14px 16px 0; flex-shrink: 0; }',
        '.vn-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }',
        '.vn-title { font-size: 15px; font-weight: 600; }',
        '.vn-title-icon { font-size: 18px; }',
        '.vn-count { font-size: 11px; opacity: 0.4; }',
        '.vn-search { width: 100%; padding: 7px 10px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; color: #fff; font-size: 12px; outline: none; margin-bottom: 8px; transition: border-color 0.2s; }',
        '.vn-search:focus { border-color: rgba(100,180,255,0.4); }',
        '.vn-search::placeholder { color: rgba(255,255,255,0.3); }',
        '.vn-tabs { display: flex; gap: 3px; padding: 0 12px 4px; flex-shrink: 0; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 10px; }',
        '.vn-tabs::-webkit-scrollbar { height: 14px; }',
        '.vn-tabs::-webkit-scrollbar-track { background: transparent; border-top: 5px solid transparent; border-bottom: 5px solid transparent; background-clip: padding-box; }',
        '.vn-tabs::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.25); border-radius: 10px; border-top: 5px solid transparent; border-bottom: 5px solid transparent; background-clip: padding-box; }',
        '.vn-tabs::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.45); border-top: 4px solid transparent; border-bottom: 4px solid transparent; background-clip: padding-box; }',
        '.vn-tab { padding: 3px 8px; font-size: 10px; border-radius: 10px; border: none; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.6); cursor: pointer; white-space: nowrap; transition: all 0.15s; flex-shrink: 0; }',
        '.vn-tab:hover { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.9); }',
        '.vn-tab.active { background: rgba(100,180,255,0.2); color: rgba(100,180,255,0.95); }',
        '.vn-list { flex: 1; overflow-y: auto; padding: 0 12px 12px; }',
        '.vn-list::-webkit-scrollbar { width: 3px; }',
        '.vn-list::-webkit-scrollbar-track { background: transparent; }',
        '.vn-list::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.25); border-radius: 2px; }',
        '.vn-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 6px; border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer; border-radius: 6px; transition: background 0.12s; }',
        '.vn-item:hover { background: rgba(255,255,255,0.06); }',
        '.vn-item:last-child { border-bottom: none; }',
        '.vn-rank { min-width: 20px; height: 20px; border-radius: 4px; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.4); font-size: 10px; font-weight: 600; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }',
        '.vn-rank.top1 { background: rgba(255,80,80,0.25); color: #ff6b6b; }',
        '.vn-rank.top2 { background: rgba(255,160,60,0.2); color: #ffa03c; }',
        '.vn-rank.top3 { background: rgba(255,200,60,0.18); color: #ffc83c; }',
        '.vn-item-body { flex: 1; min-width: 0; }',
        '.vn-item-title { font-size: 12px; line-height: 1.5; color: rgba(255,255,255,0.85); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
        '.vn-item-source { font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 2px; }',
        '.vn-loading { display: flex; align-items: center; justify-content: center; padding: 40px; opacity: 0.5; font-size: 13px; }',
        '.vn-empty { text-align: center; padding: 30px; opacity: 0.4; font-size: 12px; }',
        '.vn-more { text-align: center; padding: 8px; }',
        '.vn-more-btn { padding: 5px 16px; font-size: 11px; border: none; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.5); border-radius: 12px; cursor: pointer; transition: all 0.15s; }',
        '.vn-more-btn:hover { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.8); }',
        '</style>',
        '<div class="vn-container">',
        '    <div class="vn-header">',
        '        <div class="vn-title-row">',
        '            <span><span class="vn-title-icon">📰</span> <span class="vn-title">今日热点</span></span>',
        '            <span class="vn-count" id="vn-count"></span>',
        '        </div>',
        '        <input class="vn-search" id="vn-search" type="text" placeholder="搜索新闻..." />',
        '    </div>',
        '    <div class="vn-tabs" id="vn-tabs"></div>',
        '    <div class="vn-list" id="vn-list">',
        '        <div class="vn-loading" id="vn-loading">📡 正在获取热点新闻...</div>',
        '    </div>',
        '</div>',
        '<script>',
        '(function() {',
        '    var allNews = [];',
        '    var filteredNews = [];',
        '    var sources = [];',
        '    var currentSource = "全部";',
        '    var searchQuery = "";',
        '    var displayCount = 30;',
        '    var PAGE_SIZE = 30;',
        '',
        '    var tabsEl = document.getElementById("vn-tabs");',
        '    var listEl = document.getElementById("vn-list");',
        '    var loadingEl = document.getElementById("vn-loading");',
        '    var countEl = document.getElementById("vn-count");',
        '    var searchEl = document.getElementById("vn-search");',
        '',
        '    async function loadNews() {',
        '        try {',
        '            var data = await window.__vcpProxyFetch("/admin_api/dailyhot");',
        '            if (data && data.success && data.data) {',
        '                allNews = data.data;',
        '                var srcSet = {};',
        '                for (var i = 0; i < allNews.length; i++) {',
        '                    var s = allNews[i].source || "未知";',
        '                    srcSet[s] = (srcSet[s] || 0) + 1;',
        '                }',
        '                sources = Object.keys(srcSet).sort(function(a, b) { return srcSet[b] - srcSet[a]; });',
        '                renderTabs();',
        '                applyFilter();',
        '            } else {',
        '                loadingEl.innerHTML = "❌ 数据格式异常";',
        '            }',
        '        } catch(e) {',
        '            loadingEl.innerHTML = "❌ 获取失败: " + e.message;',
        '            console.error("[NewsWidget]", e);',
        '        }',
        '    }',
        '',
        '    function renderTabs() {',
        '        var html = \'<button class="vn-tab active" data-src="全部">全部</button>\';',
        '        for (var i = 0; i < sources.length; i++) {',
        '            html += \'<button class="vn-tab" data-src="\' + sources[i] + \'">\' + sources[i] + \'</button>\';',
        '        }',
        '        tabsEl.innerHTML = html;',
        '        var btns = tabsEl.querySelectorAll(".vn-tab");',
        '        for (var j = 0; j < btns.length; j++) {',
        '            btns[j].addEventListener("click", function() {',
        '                currentSource = this.getAttribute("data-src");',
        '                var all = tabsEl.querySelectorAll(".vn-tab");',
        '                for (var k = 0; k < all.length; k++) all[k].classList.remove("active");',
        '                this.classList.add("active");',
        '                displayCount = PAGE_SIZE;',
        '                applyFilter();',
        '            });',
        '        }',
        '    }',
        '',
        '    function applyFilter() {',
        '        filteredNews = allNews;',
        '        if (currentSource !== "全部") {',
        '            filteredNews = filteredNews.filter(function(n) { return n.source === currentSource; });',
        '        }',
        '        if (searchQuery) {',
        '            var q = searchQuery.toLowerCase();',
        '            filteredNews = filteredNews.filter(function(n) {',
        '                return (n.title && n.title.toLowerCase().indexOf(q) >= 0) || (n.source && n.source.toLowerCase().indexOf(q) >= 0);',
        '            });',
        '        }',
        '        countEl.textContent = filteredNews.length + " 条";',
        '        renderList();',
        '    }',
        '',
        '    function renderList() {',
        '        if (filteredNews.length === 0) {',
        '            listEl.innerHTML = \'<div class="vn-empty">没有找到相关新闻</div>\';',
        '            return;',
        '        }',
        '        var showing = filteredNews.slice(0, displayCount);',
        '        var html = "";',
        '        for (var i = 0; i < showing.length; i++) {',
        '            var item = showing[i];',
        '            var rankClass = "vn-rank";',
        '            if (i === 0) rankClass += " top1";',
        '            else if (i === 1) rankClass += " top2";',
        '            else if (i === 2) rankClass += " top3";',
        '            html += \'<div class="vn-item" data-url="\' + (item.url || "") + \'">\';',
        '            html += \'<span class="\' + rankClass + \'">\' + (i + 1) + \'</span>\';',
        '            html += \'<div class="vn-item-body">\';',
        '            html += \'<div class="vn-item-title">\' + escapeHtml(item.title || "无标题") + \'</div>\';',
        '            if (currentSource === "全部") {',
        '                html += \'<div class="vn-item-source">\' + escapeHtml(item.source || "") + \'</div>\';',
        '            }',
        '            html += \'</div></div>\';',
        '        }',
        '        if (displayCount < filteredNews.length) {',
        '            html += \'<div class="vn-more"><button class="vn-more-btn" id="vn-load-more">加载更多 (\' + (filteredNews.length - displayCount) + \' 条)</button></div>\';',
        '        }',
        '        listEl.innerHTML = html;',
        '',
        '        // 点击新闻条目打开链接',
        '        var items = listEl.querySelectorAll(".vn-item");',
        '        for (var j = 0; j < items.length; j++) {',
        '            items[j].addEventListener("click", function() {',
        '                var url = this.getAttribute("data-url");',
        '                if (url) {',
        '                    try {',
        '                        var _desktopBridge = window.desktopAPI || window.electronAPI;',
        '                        if (_desktopBridge && _desktopBridge.sendOpenExternalLink) {',
        '                            _desktopBridge.sendOpenExternalLink(url);',
        '                        } else {',
        '                            window.open(url, "_blank");',
        '                        }',
        '                    } catch(e) {',
        '                        window.open(url, "_blank");',
        '                    }',
        '                }',
        '            });',
        '        }',
        '',
        '        // 加载更多按钮',
        '        var moreBtn = listEl.querySelector("#vn-load-more");',
        '        if (moreBtn) {',
        '            moreBtn.addEventListener("click", function() {',
        '                displayCount += PAGE_SIZE;',
        '                renderList();',
        '            });',
        '        }',
        '    }',
        '',
        '    function escapeHtml(str) {',
        '        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");',
        '    }',
        '',
        '    // 搜索输入防抖',
        '    var searchTimer = null;',
        '    searchEl.addEventListener("input", function() {',
        '        if (searchTimer) clearTimeout(searchTimer);',
        '        searchTimer = setTimeout(function() {',
        '            searchQuery = searchEl.value.trim();',
        '            displayCount = PAGE_SIZE;',
        '            applyFilter();',
        '        }, 250);',
        '    });',
        '',
        '    loadNews();',
        '    // 每 30 分钟自动刷新',
        '    setInterval(loadNews, 30 * 60 * 1000);',
        '})();',
        '<\/script>'
    ].join('\n');

    /**
     * 生成新闻热点挂件
     */
    async function spawnNewsWidget() {
        var widgetId = 'builtin-news';

        // 如果已存在则不重复创建
        if (state.widgets.has(widgetId)) return;

        var widgetData = widget.create(widgetId, {
            x: 380,
            y: CONSTANTS.TITLE_BAR_HEIGHT + 20,
            width: 300,
            height: 440,
        });

        widgetData.contentBuffer = NEWS_HTML;
        widgetData.contentContainer.innerHTML = NEWS_HTML;
        widget.processInlineStyles(widgetData);
        widgetData.isConstructing = false;
        widgetData.element.classList.remove('constructing');
        widget.autoResize(widgetData);

        // 延迟执行脚本
        setTimeout(function () {
            widget.processInlineScripts(widgetData);
        }, 100);

        console.log('[VCPdesktop] News widget spawned.');
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.builtinNews = {
        spawn: spawnNewsWidget,
    };

})();
