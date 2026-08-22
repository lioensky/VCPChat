/**
 * we-api-shim.js - Wallpaper Engine 私有 JS API 垫片
 *
 * 背景：
 *   web 类型壁纸在 Wallpaper Engine 里运行时，wallpaper32.exe 会向页面注入一组
 *   全局函数供壁纸读取用户配置、音频频谱、正在播放的媒体信息等。浏览器里这些
 *   全部是 undefined，壁纸脚本通常写成：
 *       window.wallpaperPropertyListener = { applyUserProperties(p) {...} }
 *   或
 *       window.wallpaperRegisterAudioListener(cb)
 *   前者不调用只会退化为默认配置，后者直接抛 TypeError 导致整页白屏。
 *
 *   实测本机库存中 1336332719 用了 1 个回调、1509243786 用了 3 个。
 *
 * 策略：
 *   1. 用 Object.defineProperty 的 setter 拦截 wallpaperPropertyListener 的赋值
 *      时机 —— 壁纸脚本刚挂上监听器就立刻回喂一次配置，无需猜时序。
 *   2. project.json 的 general.properties 原样转成 WE 的 { value, type, text } 形状。
 *   3. 音频/媒体类回调给出安全的空实现（静音频谱 + 无播放状态），保证不抛异常。
 *
 * 已知降级（写在 README 已知限制里）：
 *   - 音频律动类壁纸会静止（喂的是全零频谱，真实频谱需接主程序 AnalyserNode）
 *   - 依赖正在播放媒体信息的壁纸显示"无播放"
 */
'use strict';

/** WE 用户属性 → 壁纸脚本期望的形状。 */
function normalizeProperties(properties) {
    const out = {};
    if (!properties || typeof properties !== 'object') return out;
    for (const [key, def] of Object.entries(properties)) {
        if (!def || typeof def !== 'object') continue;
        out[key] = {
            value: def.value,
            type: typeof def.type === 'string' ? def.type : undefined,
            text: typeof def.text === 'string' ? def.text : undefined,
        };
    }
    return out;
}

/**
 * 生成注入用的垫片脚本正文（不含 <script> 标签）。
 * @param {object} properties project.json 的 general.properties
 * @returns {string}
 */
function buildShimSource(properties) {
    // JSON.stringify 后再替换 </ 防止字符串里出现 </script> 提前闭合注入点
    const json = JSON.stringify(normalizeProperties(properties)).replace(/<\//g, '<\\/');

    return `/* VCPWEWallpaper: Wallpaper Engine API shim (injected) */
(function () {
  'use strict';
  var PROPS = ${json};

  function safeCall(fn, arg) {
    try { if (typeof fn === 'function') fn(arg); }
    catch (e) { console.warn('[VCPWEWallpaper shim]', e); }
  }

  // ── 用户属性：拦截赋值时机，挂上监听器的瞬间立刻回喂配置 ──
  var listener = null;
  try {
    Object.defineProperty(window, 'wallpaperPropertyListener', {
      configurable: true,
      get: function () { return listener; },
      set: function (v) {
        listener = v;
        if (!v || typeof v !== 'object') return;
        safeCall(v.applyUserProperties, PROPS);
        safeCall(v.applyGeneralProperties, { fps: 60 });
        safeCall(v.setPaused, false);
      }
    });
  } catch (e) {
    // defineProperty 失败时退化为普通属性，至少不阻塞壁纸加载
    window.wallpaperPropertyListener = null;
  }

  // ── 音频频谱：128 段全零，15Hz 空转（不喂会让部分壁纸卡在等待态）──
  var SILENT = new Array(128).fill(0);
  window.wallpaperRegisterAudioListener = function (cb) {
    if (typeof cb !== 'function') return;
    setInterval(function () { safeCall(cb, SILENT); }, 1000 / 15);
  };

  // ── 媒体信息类：空实现，壁纸走"无播放"分支 ──
  var NOOP = function () {};
  window.wallpaperRegisterMediaPropertiesListener = NOOP;
  window.wallpaperRegisterMediaThumbnailListener = NOOP;
  window.wallpaperRegisterMediaTimelineListener = NOOP;
  window.wallpaperRegisterMediaPlaybackListener = NOOP;
  window.wallpaperRequestRandomFileForProperty = NOOP;
  window.wallpaperPluginListener = window.wallpaperPluginListener || {};

  // 少数壁纸会探测这些能力位来决定走哪条分支
  window.wallpaperRegisterAudioListener.isVCPShim = true;
})();`;
}

/**
 * 把垫片注入 HTML：插在 <head> 之后（或文档最前），保证早于壁纸自身脚本执行。
 * @param {string} html 原始 index.html 文本
 * @param {object} properties project.json 的 general.properties
 * @returns {string}
 */
function injectShim(html, properties) {
    const tag = `<script>${buildShimSource(properties)}</script>`;
    const text = String(html);

    // 优先插到 <head ...> 之后，这样壁纸的 <link>/<script> 都在垫片之后
    const headOpen = /<head[^>]*>/i.exec(text);
    if (headOpen) {
        const at = headOpen.index + headOpen[0].length;
        return text.slice(0, at) + '\n' + tag + text.slice(at);
    }
    // 无 <head> 的裸 HTML：插到 <html> 之后，再退化为文档最前
    const htmlOpen = /<html[^>]*>/i.exec(text);
    if (htmlOpen) {
        const at = htmlOpen.index + htmlOpen[0].length;
        return text.slice(0, at) + '\n' + tag + text.slice(at);
    }
    return tag + '\n' + text;
}

module.exports = { normalizeProperties, buildShimSource, injectShim };
