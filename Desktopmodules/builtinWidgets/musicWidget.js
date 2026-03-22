/**
 * VCPdesktop - 内置迷你音乐播放条模块
 * 负责：音乐播放条 HTML 模板、播放控制 widget
 */

'use strict';

(function () {
    const { state, widget } = window.VCPDesktop;

    // 音乐播放条 HTML 模板
    var MUSIC_HTML = [
        '<style>',
        '.vm-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: linear-gradient(135deg, rgba(20,20,35,0.88), rgba(35,25,50,0.82)); border-radius: 24px; color: #fff; font-family: "Segoe UI", -apple-system, sans-serif; backdrop-filter: blur(12px); min-width: 300px; white-space: nowrap; user-select: none; }',
        '.vm-art { width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #667eea, #764ba2); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; animation: vm-spin 8s linear infinite paused; }',
        '.vm-art.playing { animation-play-state: running; }',
        '@keyframes vm-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
        '.vm-info { flex: 1; min-width: 0; overflow: hidden; }',
        '.vm-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.vm-time { font-size: 10px; opacity: 0.5; }',
        '.vm-controls { display: flex; gap: 4px; flex-shrink: 0; }',
        '.vm-btn { width: 30px; height: 30px; border: none; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.8); border-radius: 50%; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease; }',
        '.vm-btn:hover { background: rgba(255,255,255,0.18); color: #fff; transform: scale(1.08); }',
        '.vm-btn-play { width: 34px; height: 34px; background: rgba(255,255,255,0.12); font-size: 16px; }',
        '.vm-progress { position: absolute; bottom: 0; left: 16px; right: 16px; height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; cursor: pointer; }',
        '.vm-progress-fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); width: 0%; border-radius: 2px; transition: width 0.3s ease; }',
        '.vm-container { position: relative; padding-bottom: 6px; }',
        '.vm-offline { padding: 12px 20px; background: rgba(20,20,35,0.85); border-radius: 24px; color: rgba(255,255,255,0.4); font-size: 12px; text-align: center; backdrop-filter: blur(12px); }',
        '</style>',
        '<div class="vm-container">',
        '    <div class="vm-bar" id="vm-bar">',
        '        <div class="vm-art" id="vm-art">🎵</div>',
        '        <div class="vm-info">',
        '            <div class="vm-title" id="vm-title">未在播放</div>',
        '            <div class="vm-time" id="vm-time">--:-- / --:--</div>',
        '        </div>',
        '        <div class="vm-controls">',
        '            <button class="vm-btn" id="vm-prev" title="上一首">⏮</button>',
        '            <button class="vm-btn vm-btn-play" id="vm-play" title="播放/暂停">▶</button>',
        '            <button class="vm-btn" id="vm-next" title="下一首">⏭</button>',
        '        </div>',
        '    </div>',
        '    <div class="vm-progress" id="vm-progress">',
        '        <div class="vm-progress-fill" id="vm-progress-fill"></div>',
        '    </div>',
        '</div>',
        '<script>',
        '(function() {',
        '    var isPlaying = false;',
        '    var pollTimer = null;',
        '',
        '    var playBtn = document.getElementById("vm-play");',
        '    var prevBtn = document.getElementById("vm-prev");',
        '    var nextBtn = document.getElementById("vm-next");',
        '    var titleEl = document.getElementById("vm-title");',
        '    var timeEl = document.getElementById("vm-time");',
        '    var artEl = document.getElementById("vm-art");',
        '    var progressFill = document.getElementById("vm-progress-fill");',
        '    var progressBar = document.getElementById("vm-progress");',
        '',
        '    function formatTime(secs) {',
        '        if (!secs || isNaN(secs)) return "--:--";',
        '        var m = Math.floor(secs / 60);',
        '        var s = Math.floor(secs % 60);',
        '        return m + ":" + String(s).padStart(2, "0");',
        '    }',
        '',
        '    async function updateState() {',
        '        try {',
        '            var state = await musicAPI.getState();',
        '            if (!state) return;',
        '            ',
        '            isPlaying = state.is_playing || false;',
        '            playBtn.textContent = isPlaying ? "\\u23F8" : "\\u25B6";',
        '            ',
        '            if (isPlaying) {',
        '                artEl.classList.add("playing");',
        '            } else {',
        '                artEl.classList.remove("playing");',
        '            }',
        '            ',
        '            var filePath = state.file_path || state.current_file || "";',
        '            if (filePath) {',
        '                var parts = filePath.split(/[\\\\\\\\/]/);',
        '                var name = parts[parts.length - 1] || "";',
        '                var dotIdx = name.lastIndexOf(".");',
        '                if (dotIdx > 0) name = name.substring(0, dotIdx);',
        '                titleEl.textContent = name || "未知曲目";',
        '            } else {',
        '                titleEl.textContent = "未在播放";',
        '            }',
        '            ',
        '            var pos = state.position_secs || state.position || 0;',
        '            var dur = state.duration_secs || state.duration || 0;',
        '            timeEl.textContent = formatTime(pos) + " / " + formatTime(dur);',
        '            ',
        '            if (dur > 0) {',
        '                progressFill.style.width = (pos / dur * 100) + "%";',
        '            } else {',
        '                progressFill.style.width = "0%";',
        '            }',
        '        } catch(e) {',
        '            console.warn("[MusicWidget] updateState error:", e);',
        '        }',
        '    }',
        '',
        '    playBtn.addEventListener("click", async function() {',
        '        try {',
        '            if (isPlaying) {',
        '                await musicAPI.pause();',
        '            } else {',
        '                await musicAPI.play();',
        '            }',
        '            setTimeout(updateState, 200);',
        '        } catch(e) { console.error("[MusicWidget]", e); }',
        '    });',
        '',
        '    prevBtn.addEventListener("click", function() {',
        '        try { musicAPI.send("music-remote-command", "previous"); } catch(e) {}',
        '        setTimeout(updateState, 500);',
        '    });',
        '',
        '    nextBtn.addEventListener("click", function() {',
        '        try { musicAPI.send("music-remote-command", "next"); } catch(e) {}',
        '        setTimeout(updateState, 500);',
        '    });',
        '',
        '    progressBar.addEventListener("click", async function(e) {',
        '        try {',
        '            var state = await musicAPI.getState();',
        '            if (state && state.duration_secs > 0) {',
        '                var rect = progressBar.getBoundingClientRect();',
        '                var ratio = (e.clientX - rect.left) / rect.width;',
        '                var seekPos = ratio * state.duration_secs;',
        '                await musicAPI.seek(seekPos);',
        '                setTimeout(updateState, 200);',
        '            }',
        '        } catch(e) {}',
        '    });',
        '',
        '    updateState();',
        '    pollTimer = setInterval(updateState, 2000);',
        '})();',
        '<\/script>'
    ].join('\n');

    /**
     * 生成音乐播放条挂件
     */
    async function spawnMusicWidget() {
        var widgetId = 'builtin-music';
        if (state.widgets.has(widgetId)) return;

        var widgetData = widget.create(widgetId, {
            x: 40,
            y: window.innerHeight - 100,
            width: 360,
            height: 60,
        });

        widgetData.contentBuffer = MUSIC_HTML;
        widgetData.contentContainer.innerHTML = MUSIC_HTML;
        widget.processInlineStyles(widgetData);
        widgetData.isConstructing = false;
        widgetData.element.classList.remove('constructing');
        widget.autoResize(widgetData);

        setTimeout(function () {
            widget.processInlineScripts(widgetData);
        }, 100);

        console.log('[VCPdesktop] Music mini-bar widget spawned.');
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.builtinMusic = {
        spawn: spawnMusicWidget,
    };

})();