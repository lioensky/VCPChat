/**
 * VCPdesktop - 壁纸管理模块
 * 负责：自定义壁纸的创建/切换/移除，支持图片、视频(mp4)、HTML动态壁纸
 * 
 * 壁纸层结构：
 *   #desktop-wallpaper-layer （z-index: 0，位于 body 和 canvas 之间）
 *     ├── <div>  图片壁纸（通过 background-image）
 *     ├── <video> 视频壁纸（自动循环播放）
 *     └── <iframe> HTML壁纸（沙盒化加载）
 * 
 * 壁纸设置存储在 state.globalSettings.wallpaper 中：
 *   {
 *     enabled: boolean,       // 是否启用自定义壁纸
 *     type: 'image'|'video'|'html'|'none',
 *     source: string,         // 文件路径或 Data URL
 *     opacity: number,        // 壁纸透明度 0~1
 *     blur: number,           // 模糊度 px
 *     brightness: number,     // 亮度 0~2
 *     videoMuted: boolean,    // 视频壁纸是否静音
 *     videoPlaybackRate: number, // 视频播放速率
 *   }
 */

'use strict';

(function () {
    const { state } = window.VCPDesktop;

    // 默认壁纸设置
    const DEFAULT_WALLPAPER = {
        enabled: false,
        type: 'none',       // 'image' | 'video' | 'html' | 'none'
        source: '',         // 文件路径（file:///...）或空
        opacity: 1,
        blur: 0,
        brightness: 1,
        videoMuted: true,
        videoPlaybackRate: 1,
    };

    let wallpaperLayer = null;
    let currentElement = null; // 当前壁纸元素（img div / video / iframe）

    // ============================================================
    // 初始化
    // ============================================================

    /**
     * 初始化壁纸管理器
     * 获取壁纸层 DOM 引用，应用已保存的壁纸设置
     */
    function init() {
        wallpaperLayer = document.getElementById('desktop-wallpaper-layer');
        if (!wallpaperLayer) {
            console.warn('[WallpaperManager] Wallpaper layer element not found');
            return;
        }

        // 确保 state 中有壁纸设置
        if (!state.globalSettings.wallpaper) {
            state.globalSettings.wallpaper = { ...DEFAULT_WALLPAPER };
        }

        console.log('[WallpaperManager] Initialized');
    }

    // ============================================================
    // 壁纸应用
    // ============================================================

    /**
     * 应用壁纸设置
     * @param {object} [wallpaperConfig] - 可选，若不传则使用 state 中的配置
     */
    function apply(wallpaperConfig) {
        const config = wallpaperConfig || state.globalSettings.wallpaper || DEFAULT_WALLPAPER;

        if (!wallpaperLayer) {
            wallpaperLayer = document.getElementById('desktop-wallpaper-layer');
            if (!wallpaperLayer) return;
        }

        // 清除当前壁纸（带渐出效果）
        clearWithTransition(() => {
            if (!config.enabled || config.type === 'none' || !config.source) {
                // 无自定义壁纸：恢复 body 原有的 themes.css 壁纸显示
                document.body.classList.remove('desktop-custom-wallpaper-active');
                wallpaperLayer.style.display = 'none';
                return;
            }

            // 有自定义壁纸：隐藏 body 的 themes.css 壁纸
            document.body.classList.add('desktop-custom-wallpaper-active');
            wallpaperLayer.style.display = 'block';

            // 应用滤镜效果
            applyFilters(config);

            // 根据类型创建壁纸元素
            switch (config.type) {
                case 'image':
                    applyImageWallpaper(config.source);
                    break;
                case 'video':
                    applyVideoWallpaper(config.source, config);
                    break;
                case 'html':
                    applyHtmlWallpaper(config.source);
                    break;
                default:
                    console.warn('[WallpaperManager] Unknown wallpaper type:', config.type);
            }
        });
    }

    /**
     * 应用滤镜效果到壁纸层
     */
    function applyFilters(config) {
        if (!wallpaperLayer) return;

        const filters = [];
        if (config.blur > 0) {
            filters.push(`blur(${config.blur}px)`);
        }
        if (config.brightness !== undefined && config.brightness !== 1) {
            filters.push(`brightness(${config.brightness})`);
        }

        wallpaperLayer.style.filter = filters.length > 0 ? filters.join(' ') : '';
        wallpaperLayer.style.opacity = config.opacity !== undefined ? config.opacity : 1;
    }

    /**
     * 应用图片壁纸
     */
    function applyImageWallpaper(source) {
        const div = document.createElement('div');
        div.className = 'desktop-wallpaper-image';
        div.style.backgroundImage = `url("${escapeUrl(source)}")`;
        wallpaperLayer.appendChild(div);
        currentElement = div;
        console.log('[WallpaperManager] Image wallpaper applied:', source.substring(0, 80));
    }

    /**
     * 应用视频壁纸
     */
    function applyVideoWallpaper(source, config) {
        const video = document.createElement('video');
        video.className = 'desktop-wallpaper-video';
        video.src = source;
        video.autoplay = true;
        video.loop = true;
        video.muted = config.videoMuted !== false; // 默认静音
        video.playsInline = true;
        video.playbackRate = config.videoPlaybackRate || 1;

        // 防止视频右键菜单
        video.addEventListener('contextmenu', (e) => e.preventDefault());

        // 视频加载错误处理
        video.addEventListener('error', (e) => {
            console.error('[WallpaperManager] Video wallpaper load error:', e);
            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('waiting', '视频壁纸加载失败');
                window.VCPDesktop.status.show();
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        });

        // 确保视频播放
        video.addEventListener('canplay', () => {
            video.play().catch(err => {
                console.warn('[WallpaperManager] Video autoplay blocked:', err.message);
            });
        });

        wallpaperLayer.appendChild(video);
        currentElement = video;
        console.log('[WallpaperManager] Video wallpaper applied:', source.substring(0, 80));
    }

    /**
     * 应用 HTML 壁纸
     * HTML 壁纸通过 iframe 沙盒化加载，支持动态效果（粒子、shader 等）
     * 使用 CSS transition 实现加载完成后的渐入效果
     */
    function applyHtmlWallpaper(source) {
        const iframe = document.createElement('iframe');
        iframe.className = 'desktop-wallpaper-html';
        iframe.frameBorder = '0';
        iframe.scrolling = 'no';
        // 沙盒：允许脚本执行，但限制其他能力
        iframe.sandbox = 'allow-scripts allow-same-origin';
        iframe.allowTransparency = true;

        // 防止 iframe 捕获事件（让事件穿透到桌面画布）
        iframe.style.pointerEvents = 'none';

        // iframe 加载完成后触发渐入
        iframe.addEventListener('load', () => {
            // 短暂延迟确保 iframe 内容已渲染
            setTimeout(() => {
                iframe.classList.add('wallpaper-loaded');
                console.log('[WallpaperManager] HTML wallpaper loaded and fading in');
            }, 100);
        });

        // 加载错误处理
        iframe.addEventListener('error', (e) => {
            console.error('[WallpaperManager] HTML wallpaper load error:', e);
            // 即使出错也显示（可能是部分加载）
            iframe.classList.add('wallpaper-loaded');
            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('waiting', 'HTML壁纸加载失败');
                window.VCPDesktop.status.show();
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        });

        wallpaperLayer.appendChild(iframe);
        // 设置 src 在 appendChild 之后，确保 load 事件不会被遗漏
        iframe.src = source;
        currentElement = iframe;
        console.log('[WallpaperManager] HTML wallpaper applied:', source.substring(0, 80));
    }

    // ============================================================
    // 壁纸操作
    // ============================================================

    /**
     * 清除当前壁纸（无动画，直接清除）
     */
    function clear() {
        if (!wallpaperLayer) return;

        // 如果有视频，先暂停释放资源
        if (currentElement && currentElement.tagName === 'VIDEO') {
            currentElement.pause();
            currentElement.src = '';
            currentElement.load(); // 释放内存
        }

        // 如果有 iframe，清除 src
        if (currentElement && currentElement.tagName === 'IFRAME') {
            currentElement.src = 'about:blank';
        }

        wallpaperLayer.innerHTML = '';
        currentElement = null;
    }

    /**
     * 带渐出过渡的壁纸切换
     * 如果当前有壁纸，先渐出再执行回调；如果没有则直接执行
     * @param {Function} callback - 渐出完成后执行的回调
     */
    function clearWithTransition(callback) {
        if (!wallpaperLayer || !currentElement) {
            // 没有当前壁纸，直接清除并执行回调
            clear();
            if (callback) callback();
            return;
        }

        // 为壁纸层添加渐出效果
        wallpaperLayer.style.transition = 'opacity 0.4s ease-out';
        wallpaperLayer.style.opacity = '0';

        // 渐出完成后清除旧壁纸并执行回调
        setTimeout(() => {
            clear();
            // 重置透明度（新壁纸会通过 CSS animation/transition 自行渐入）
            wallpaperLayer.style.transition = '';
            wallpaperLayer.style.opacity = '';
            if (callback) callback();
        }, 420); // 略长于 transition 时间
    }

    /**
     * 更新壁纸滤镜（不重新加载壁纸）
     */
    function updateFilters(config) {
        const wallpaperConfig = config || state.globalSettings.wallpaper;
        if (wallpaperConfig) {
            applyFilters(wallpaperConfig);
        }
    }

    /**
     * 更新视频壁纸特定属性
     */
    function updateVideoSettings(config) {
        if (!currentElement || currentElement.tagName !== 'VIDEO') return;

        if (config.videoMuted !== undefined) {
            currentElement.muted = config.videoMuted;
        }
        if (config.videoPlaybackRate !== undefined) {
            currentElement.playbackRate = config.videoPlaybackRate;
        }
    }

    /**
     * 获取当前壁纸配置
     */
    function getConfig() {
        return state.globalSettings.wallpaper || { ...DEFAULT_WALLPAPER };
    }

    /**
     * 检测文件类型
     * @param {string} filePath - 文件路径
     * @returns {'image'|'video'|'html'|'unknown'}
     */
    function detectType(filePath) {
        if (!filePath) return 'unknown';
        const ext = filePath.split('.').pop().toLowerCase();

        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'];
        const videoExts = ['mp4', 'webm', 'ogg', 'mov'];
        const htmlExts = ['html', 'htm'];

        if (imageExts.includes(ext)) return 'image';
        if (videoExts.includes(ext)) return 'video';
        if (htmlExts.includes(ext)) return 'html';
        return 'unknown';
    }

    // ============================================================
    // 工具函数
    // ============================================================

    /**
     * 转义 URL 中的特殊字符
     */
    function escapeUrl(url) {
        return url.replace(/\\/g, '/').replace(/"/g, '%22');
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.wallpaper = {
        DEFAULT: DEFAULT_WALLPAPER,
        init,
        apply,
        clear,
        updateFilters,
        updateVideoSettings,
        getConfig,
        detectType,
    };

})();