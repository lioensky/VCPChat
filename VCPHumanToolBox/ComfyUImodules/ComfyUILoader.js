// ComfyUI 动态加载器模块
(function() {
    'use strict';

    class ComfyUILoader {
        constructor() {
            this.loaded = false;
            this.loading = false;
            this.loadPromise = null;
            this.requiredScripts = [
                'ComfyUImodules/ComfyUI_StateManager.js',
                'ComfyUImodules/ComfyUI_UIManager.js',
                'ComfyUImodules/comfyUIConfig.js'
            ];
            this.requiredStyles = [
                'ComfyUImodules/comfyui.css'
            ];
        }

        // 检查模块是否已加载
        isLoaded() {
            return this.loaded;
        }

        // 动态加载脚本
        loadScript(src) {
            return new Promise((resolve, reject) => {
                // 检查脚本是否已经存在
                const existingScript = document.querySelector(`script[src="${src}"]`);
                if (existingScript) {
                    resolve();
                    return;
                }

                const script = document.createElement('script');
                script.src = src;
                script.onload = () => resolve();
                script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
                document.head.appendChild(script);
            });
        }

        // 动态加载样式
        loadStyle(href) {
            return new Promise((resolve, reject) => {
                // 检查样式是否已经存在
                const existingLink = document.querySelector(`link[href="${href}"]`);
                if (existingLink) {
                    resolve();
                    return;
                }

                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = href;
                link.onload = () => resolve();
                link.onerror = () => reject(new Error(`Failed to load style: ${href}`));
                document.head.appendChild(link);
            });
        }

        // 加载所有 ComfyUI 模块
        async load() {
            if (this.loaded) {
                return true;
            }

            if (this.loading) {
                return this.loadPromise;
            }

            this.loading = true;
            this.loadPromise = this._performLoad();
            
            try {
                await this.loadPromise;
                this.loaded = true;
                this.loading = false;
                console.log('[ComfyUILoader] All modules loaded successfully');
                return true;
            } catch (error) {
                this.loading = false;
                console.error('[ComfyUILoader] Failed to load modules:', error);
                throw error;
            }
        }

        async _performLoad() {
            try {
                // 先加载样式
                for (const style of this.requiredStyles) {
                    await this.loadStyle(style);
                }

                // 按顺序加载脚本（确保依赖关系）
                for (const script of this.requiredScripts) {
                    await this.loadScript(script);
                }

                // 等待模块初始化
                await this._waitForModulesReady();

                return true;
            } catch (error) {
                throw new Error(`ComfyUI module loading failed: ${error.message}`);
            }
        }

        // 等待模块准备就绪
        async _waitForModulesReady() {
            const maxAttempts = 50;
            const checkInterval = 100;

            for (let i = 0; i < maxAttempts; i++) {
                if (window.ComfyUI_StateManager && 
                    window.ComfyUI_UIManager && 
                    window.comfyUI) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, checkInterval));
            }

            throw new Error('ComfyUI modules did not initialize in time');
        }

        // 卸载模块（可选功能）
        unload() {
            if (!this.loaded) {
                return;
            }

            // 清理全局对象
            delete window.ComfyUI_StateManager;
            delete window.ComfyUI_UIManager;
            delete window.comfyUI;

            // 移除脚本标签
            this.requiredScripts.forEach(src => {
                const script = document.querySelector(`script[src="${src}"]`);
                if (script) {
                    script.remove();
                }
            });

            // 移除样式标签
            this.requiredStyles.forEach(href => {
                const link = document.querySelector(`link[href="${href}"]`);
                if (link) {
                    link.remove();
                }
            });

            this.loaded = false;
            console.log('[ComfyUILoader] Modules unloaded');
        }
    }

    // 导出为全局单例
    window.ComfyUILoader = new ComfyUILoader();
})();