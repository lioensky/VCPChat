// WorkflowEditor 动态加载器模块
(function() {
    'use strict';

    class WorkflowEditorLoader {
        constructor() {
            this.loaded = false;
            this.loading = false;
            this.loadPromise = null;
   
            this.requiredScripts = [
                'WorkflowEditormodules/WorkflowEditor_StateManager.js',
                'WorkflowEditormodules/WorkflowEditor_ConnectionManager.js',
                'WorkflowEditormodules/WorkflowEditor_PluginManager.js',
                'WorkflowEditormodules/WorkflowEditor_PluginDialog.js',
                'WorkflowEditormodules/WorkflowEditor_UIManager.js',
                'WorkflowEditormodules/WorkflowEditor_CanvasManager_JSPlumb.js',
                'WorkflowEditormodules/WorkflowEditor_NodeManager.js',
                'WorkflowEditormodules/WorkflowEditor_ExecutionEngine.js',
                'WorkflowEditormodules/WorkflowEditor_Config.js',
                // URL相关功能模块
                'WorkflowEditormodules/WorkflowEditor_NodeManager_URLRenderer_Patch.js',
                'WorkflowEditormodules/WorkflowEditor_NodeManager_URLExtractor.js',
                'WorkflowEditormodules/WorkflowEditor_NodeManager_URLExtractor_Integration.js'
            ];
            this.requiredStyles = [
                'WorkflowEditormodules/workflow-editor.css'
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

        // 初始化方法（兼容性）
        async init() {
            return this.load();
        }

        // 加载所有 WorkflowEditor 模块
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
                console.log('[WorkflowEditorLoader] All modules loaded successfully');
                return true;
            } catch (error) {
                this.loading = false;
                console.error('[WorkflowEditorLoader] Failed to load modules:', error);
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
                throw new Error(`WorkflowEditor module loading failed: ${error.message}`);
            }
        }

        // 等待模块准备就绪
        async _waitForModulesReady() {
            const maxAttempts = 100; // 增加尝试次数从50到100
            const checkInterval = 100;

            for (let i = 0; i < maxAttempts; i++) {
                const iteration = i + 1;
                console.log(`[WorkflowEditorLoader] Waiting for modules (${iteration}/${maxAttempts}): checking dependencies...`);

                const moduleStatus = {
                    stateManager: !!window.WorkflowEditor_StateManager,
                    connectionManager: !!window.WorkflowEditor_ConnectionManager,
                    pluginManager: !!window.WorkflowEditor_PluginManager,
                    pluginDialog: !!window.WorkflowEditor_PluginDialog,
                    uiManager: !!window.WorkflowEditor_UIManager,
                    canvasManager: !!window.WorkflowEditor_CanvasManager,
                    nodeManager: !!window.WorkflowEditor_NodeManager,
                    executionEngine: !!window.WorkflowEditor_ExecutionEngine,
                    workflowEditor: !!window.workflowEditor
                };

                console.log(`[WorkflowEditorLoader] Module status (${iteration}/${maxAttempts}):`, moduleStatus);

                if (window.WorkflowEditor_StateManager &&
                      window.WorkflowEditor_ConnectionManager &&
                      window.WorkflowEditor_PluginManager &&
                      window.WorkflowEditor_PluginDialog &&
                      window.WorkflowEditor_UIManager &&
                      window.WorkflowEditor_CanvasManager &&
                      window.WorkflowEditor_NodeManager &&
                      window.WorkflowEditor_ExecutionEngine &&
                      window.workflowEditor) {

                    console.log('[WorkflowEditorLoader] All modules loaded, initializing workflow editor...');

                    // 初始化workflowEditor - 添加超时控制
                    try {
                        const initPromise = window.workflowEditor.init();
                        const initTimeout = new Promise((_, reject) => {
                            setTimeout(() => reject(new Error('Workflow editor initialization timeout')), 10000); // 10秒超时
                        });

                        const initSuccess = await Promise.race([initPromise, initTimeout]);
                        if (initSuccess) {
                            console.log('[WorkflowEditorLoader] Workflow editor initialization successful');
                            return true;
                        } else {
                            throw new Error('Workflow editor initialization returned false');
                        }
                    } catch (initError) {
                        console.error('[WorkflowEditorLoader] Workflow editor initialization failed:', initError);

                        // 如果是超时错误，提供更友好的消息
                        if (initError.message.includes('timeout')) {
                            console.warn('[WorkflowEditorLoader] Initialization timeout - this may be due to network issues when loading plugins');
                        }

                        throw initError;
                    }
                }

                await new Promise(resolve => setTimeout(resolve, checkInterval));
            }

            // 如果最后一次循环也没有成功，记录失败状态
            console.error('[WorkflowEditorLoader] Final module status:', {
                stateManager: !!window.WorkflowEditor_StateManager,
                connectionManager: !!window.WorkflowEditor_ConnectionManager,
                pluginManager: !!window.WorkflowEditor_PluginManager,
                pluginDialog: !!window.WorkflowEditor_PluginDialog,
                uiManager: !!window.WorkflowEditor_UIManager,
                canvasManager: !!window.WorkflowEditor_CanvasManager,
                nodeManager: !!window.WorkflowEditor_NodeManager,
                executionEngine: !!window.WorkflowEditor_ExecutionEngine,
                workflowEditor: !!window.workflowEditor
            });

            throw new Error('WorkflowEditor modules did not initialize in time (50 attempts failed)');
        }

        // 卸载模块（可选功能）
        unload() {
            if (!this.loaded) {
                return;
            }

            // 清理全局对象
            delete window.WorkflowEditor_StateManager;
            delete window.WorkflowEditor_PluginManager;
            delete window.WorkflowEditor_PluginDialog;
            delete window.WorkflowEditor_UIManager;
            delete window.WorkflowEditor_CanvasManager;
            delete window.WorkflowEditor_NodeManager;
            delete window.workflowEditor;

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
            console.log('[WorkflowEditorLoader] Modules unloaded');
        }
    }

    // 导出为全局单例
    window.WorkflowEditorLoader = new WorkflowEditorLoader();
})();