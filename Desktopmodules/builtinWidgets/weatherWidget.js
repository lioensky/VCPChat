/**
 * VCPdesktop - 内置天气挂件模块
 * 负责：天气挂件 HTML 模板、自动生成天气 widget
 */

'use strict';

(function () {
    const { state, CONSTANTS, widget } = window.VCPDesktop;

    // 天气挂件 HTML 模板
    var WEATHER_HTML = [
        '<style>',
        '.vw-container { padding: 20px; background: linear-gradient(135deg, rgba(30,60,114,0.85), rgba(42,82,152,0.75)); border-radius: 12px; color: #fff; font-family: "Segoe UI", -apple-system, sans-serif; min-width: 280px; backdrop-filter: blur(10px); }',
        '.vw-loading { text-align: center; padding: 20px; opacity: 0.6; }',
        '.vw-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }',
        '.vw-city { font-size: 13px; opacity: 0.7; }',
        '.vw-update-time { font-size: 11px; opacity: 0.5; }',
        '.vw-main { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }',
        '.vw-emoji { font-size: 48px; line-height: 1; }',
        '.vw-temp-block {}',
        '.vw-temp { font-size: 42px; font-weight: 300; line-height: 1; }',
        '.vw-temp-unit { font-size: 18px; opacity: 0.6; }',
        '.vw-desc { font-size: 14px; opacity: 0.8; margin-top: 2px; }',
        '.vw-details { display: flex; gap: 16px; font-size: 12px; opacity: 0.7; margin-bottom: 14px; flex-wrap: wrap; }',
        '.vw-forecast { display: flex; gap: 8px; overflow-x: auto; }',
        '.vw-forecast::-webkit-scrollbar { height: 0; }',
        '.vw-day { text-align: center; padding: 8px 6px; background: rgba(255,255,255,0.08); border-radius: 8px; min-width: 56px; flex-shrink: 0; }',
        '.vw-day-name { font-size: 11px; opacity: 0.6; }',
        '.vw-day-icon { font-size: 20px; margin: 4px 0; }',
        '.vw-day-temp { font-size: 11px; }',
        '.vw-warning { margin-top: 10px; padding: 6px 10px; background: rgba(255,150,0,0.2); border-left: 3px solid #f97316; border-radius: 4px; font-size: 11px; }',
        '.vw-aqi { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-top: 4px; }',
        '</style>',
        '<div class="vw-container">',
        '    <div class="vw-loading" id="vw-loading">🌤️ 正在获取天气数据...</div>',
        '    <div id="vw-content" style="display:none;"></div>',
        '</div>',
        '<script>',
        '(function() {',
        '    var emojiMap = {',
        '        "100":"☀️","150":"☀️","101":"⛅","151":"⛅","102":"🌤️","152":"🌤️",',
        '        "103":"⛅","153":"⛅","104":"☁️","154":"☁️","300":"🌧️","301":"🌧️",',
        '        "302":"⛈️","303":"⛈️","305":"🌦️","306":"🌧️","307":"🌧️","308":"🌊",',
        '        "309":"🌦️","400":"🌨️","401":"🌨️","402":"❄️","500":"🌫️","501":"🌫️",',
        '        "502":"🌁","900":"🌡️","901":"❄️","999":"🌈"',
        '    };',
        '    function getEmoji(code) { return emojiMap[String(code)] || "🌡️"; }',
        '    function getAqiStyle(cat) {',
        '        var m = {"优":"background:#00e400;color:#fff","良":"background:#ffff00;color:#333",',
        '            "轻度污染":"background:#ff7e00;color:#fff","中度污染":"background:#ff0000;color:#fff"};',
        '        return m[cat] || "background:#999;color:#fff";',
        '    }',
        '    var weekDays = ["周日","周一","周二","周三","周四","周五","周六"];',
        '    ',
        '    async function loadWeather() {',
        '        try {',
        '            var data = await window.__vcpProxyFetch("/admin_api/weather");',
        '            var now = new Date();',
        '            var loadingEl = document.getElementById("vw-loading");',
        '            var contentEl = document.getElementById("vw-content");',
        '            if (loadingEl) loadingEl.style.display = "none";',
        '            if (contentEl) contentEl.style.display = "block";',
        '            ',
        '            var current = null;',
        '            if (data.hourly && data.hourly.length > 0) {',
        '                var minDiff = Infinity;',
        '                for (var h of data.hourly) {',
        '                    var diff = Math.abs(new Date(h.fxTime).getTime() - now.getTime());',
        '                    if (diff < minDiff) { minDiff = diff; current = h; }',
        '                }',
        '            }',
        '            var today = null;',
        '            if (data.daily && data.daily.length > 0) {',
        '                var todayStr = now.toISOString().slice(0,10);',
        '                today = data.daily.find(function(d){return d.fxDate===todayStr}) || data.daily[0];',
        '            }',
        '',
        '            var html = "";',
        '            html += \'<div class="vw-header">\';',
        '            html += \'<span class="vw-city">\' + (data.city || "天气预报") + \'</span>\';',
        '            html += \'<span class="vw-update-time">\' + now.getHours() + \':\' + String(now.getMinutes()).padStart(2,"0") + \'</span>\';',
        '            html += \'</div>\';',
        '            ',
        '            if (current || today) {',
        '                var temp = current ? current.temp : (today ? today.tempMax : "--");',
        '                var text = current ? current.text : (today ? today.textDay : "--");',
        '                var icon = current ? current.icon : (today ? today.iconDay : "999");',
        '                var humidity = current ? current.humidity : (today ? today.humidity : "--");',
        '                var windDir = current ? current.windDir : (today ? today.windDirDay : "--");',
        '                var windScale = current ? current.windScale : (today ? today.windScaleDay : "--");',
        '                var tempRange = today ? (today.tempMin + "°~" + today.tempMax + "°") : "";',
        '                ',
        '                html += \'<div class="vw-main">\';',
        '                html += \'<span class="vw-emoji">\' + getEmoji(icon) + \'</span>\';',
        '                html += \'<div class="vw-temp-block">\';',
        '                html += \'<div><span class="vw-temp">\' + temp + \'</span><span class="vw-temp-unit">°C</span></div>\';',
        '                html += \'<div class="vw-desc">\' + text + \'</div>\';',
        '                html += \'</div>\';',
        '                html += \'</div>\';',
        '                ',
        '                html += \'<div class="vw-details">\';',
        '                html += \'<span>🌡️ \' + tempRange + \'</span>\';',
        '                html += \'<span>💧 \' + humidity + \'%</span>\';',
        '                html += \'<span>🌬️ \' + windDir + " " + windScale + \'级</span>\';',
        '                html += \'</div>\';',
        '            }',
        '            ',
        '            if (data.airQuality) {',
        '                html += \'<div><span class="vw-aqi" style="\' + getAqiStyle(data.airQuality.category) + \'">\';',
        '                html += "AQI " + data.airQuality.aqi + " " + data.airQuality.category;',
        '                html += \'</span></div>\';',
        '            }',
        '            ',
        '            if (data.warning && data.warning.length > 0) {',
        '                for (var w of data.warning) {',
        '                    html += \'<div class="vw-warning">⚠️ \' + w.title + \'</div>\';',
        '                }',
        '            }',
        '            ',
        '            if (data.daily && data.daily.length > 1) {',
        '                html += \'<div class="vw-forecast">\';',
        '                var futureDays = data.daily.slice(1, 5);',
        '                for (var day of futureDays) {',
        '                    var d = new Date(day.fxDate);',
        '                    html += \'<div class="vw-day">\';',
        '                    html += \'<div class="vw-day-name">\' + weekDays[d.getDay()] + \'</div>\';',
        '                    html += \'<div class="vw-day-icon">\' + getEmoji(day.iconDay) + \'</div>\';',
        '                    html += \'<div class="vw-day-temp">\' + day.tempMin + "°~" + day.tempMax + \'°</div>\';',
        '                    html += \'</div>\';',
        '                }',
        '                html += \'</div>\';',
        '            }',
        '            ',
        '            contentEl.innerHTML = html;',
        '        } catch(e) {',
        '            var loadingEl = document.getElementById("vw-loading");',
        '            if (loadingEl) loadingEl.innerHTML = "❌ 天气获取失败: " + e.message;',
        '            console.error("[Weather Widget]", e);',
        '        }',
        '    }',
        '    ',
        '    loadWeather();',
        '    setInterval(loadWeather, 30 * 60 * 1000);',
        '})();',
        '<\/script>'
    ].join('\n');

    /**
     * 生成天气挂件
     */
    async function spawnWeatherWidget() {
        var widgetId = 'builtin-weather';

        // 如果已存在则不重复创建
        if (state.widgets.has(widgetId)) return;

        var widgetData = widget.create(widgetId, {
            x: 40,
            y: CONSTANTS.TITLE_BAR_HEIGHT + 20,
            width: 320,
            height: 280,
        });

        widgetData.contentBuffer = WEATHER_HTML;
        widgetData.contentContainer.innerHTML = WEATHER_HTML;
        widget.processInlineStyles(widgetData);
        widgetData.isConstructing = false;
        widgetData.element.classList.remove('constructing');
        widget.autoResize(widgetData);

        // 延迟执行脚本
        setTimeout(function () {
            widget.processInlineScripts(widgetData);
        }, 100);

        console.log('[VCPdesktop] Weather widget spawned.');
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.builtinWeather = {
        spawn: spawnWeatherWidget,
    };

})();