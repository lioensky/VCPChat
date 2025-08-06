// ComfyUI Configuration Module - Coordinator Pattern
(function() {
    'use strict';
    
    class ComfyUIConfigManager {
        constructor() {
            if (ComfyUIConfigManager.instance) {
                return ComfyUIConfigManager.instance;
            }
            
            this.stateManager = window.ComfyUI_StateManager;
            this.uiManager = window.ComfyUI_UIManager;
            this.abortController = null;
            
            ComfyUIConfigManager.instance = this;
            
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.init());
            } else {
                setTimeout(() => this.init(), 100);
            }
        }
        
        static getInstance() {
            if (!ComfyUIConfigManager.instance) {
                ComfyUIConfigManager.instance = new ComfyUIConfigManager();
            }
            return ComfyUIConfigManager.instance;
        }
        
        async init() {
            console.log('[ComfyUI] Initializing ComfyUI Configuration Manager...');
            try {
                await this.loadConfig();
                this.setupFileWatcher();
                this.uiManager.updateConnectionStatus(this.stateManager.isConnectionActive());

                const openBtn = document.getElementById('openComfyUIConfigBtn');
                if (openBtn) {
                    openBtn.addEventListener('click', () => this.openModal());
                } else {
                    console.warn('[ComfyUI] openComfyUIConfigBtn not found during init.');
                }
                
                console.log('[ComfyUI] ComfyUI Configuration Manager initialized successfully');
            } catch (error) {
                console.error('[ComfyUI] Failed to initialize:', error);
            }
        }

        async setupFileWatcher() {
            try {
                if (window.electronAPI && window.electronAPI.watchComfyUIConfig) {
                    const result = await window.electronAPI.watchComfyUIConfig();
                    if (result.success) {
                        console.log('[ComfyUI] File watcher setup successful');
                        window.electronAPI.onComfyUIConfigChanged?.(() => {
                            console.log('[ComfyUI] Config file changed, reloading...');
                            this.handleConfigFileChanged();
                        });
                    } else {
                        console.warn('[ComfyUI] File watcher setup failed:', result.error);
                    }
                }
            } catch (error) {
                console.error('[ComfyUI] Failed to setup file watcher:', error);
            }
        }

        async handleConfigFileChanged() {
            try {
                if (this.stateManager.isHandlingConfigChange) {
                    return;
                }
                this.stateManager.isHandlingConfigChange = true;
                
                const newConfig = await window.electronAPI.getComfyUIConfigRealtime?.();
                if (newConfig) {
                    this.stateManager.updateConfig(newConfig);
                    const modal = this.uiManager.getElement('comfyUIConfigModal');
                    if (modal && modal.style.display !== 'none' && !modal.classList.contains('hidden')) {
                        this.uiManager.populateForm(this.stateManager.getConfig());
                        this.uiManager.showToast('配置已自动更新', 'info');
                    }
                }
                
                setTimeout(() => {
                    this.stateManager.isHandlingConfigChange = false;
                }, 1000);
                
            } catch (error) {
                console.error('[ComfyUI] Failed to handle config file change:', error);
                this.stateManager.isHandlingConfigChange = false;
            }
        }

        async openModal() {
            try {
                // Ensure backend handlers are ready before proceeding
                if (window.electronAPI && window.electronAPI.ensureComfyUIHandlersReady) {
                    const result = await window.electronAPI.ensureComfyUIHandlersReady();
                    if (!result.success) {
                        console.error('[ComfyUI] Backend handlers failed to initialize:', result.error);
                        this.uiManager.showToast('无法初始化ComfyUI模块，请检查主进程日志。', 'error');
                        return; // Stop if backend is not ready
                    }
                }

                this.cancelOngoingOperations();
                this.uiManager.generateModalContent(this);

                const tasks = [
                    this.loadAvailableWorkflows(),
                    this.populateFormFromBackend()
                ];
                if (this.stateManager.isConnectionActive()) {
                    tasks.push(this.loadAvailableModels());
                }
                await Promise.allSettled(tasks);

                this.uiManager.openModal('comfyUIConfigModal');
            } catch (error) {
                console.error('[ComfyUI] Error opening modal:', error);
                this.uiManager.showToast('打开配置时出错，请查看控制台。', 'error');
            }
        }

        closeModal() {
            this.cancelOngoingOperations();
            this.uiManager.closeAllModals();
            this.uiManager.clearDOMCache();
            this.uiManager.closeModal('comfyUIConfigModal');
        }

        cancelOngoingOperations() {
            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
            }
            this.stateManager.isLoading = false;
            const workflowList = this.uiManager.getElement('workflowList');
            if (workflowList && workflowList.innerHTML.includes('workflow-loading')) {
                workflowList.innerHTML = '<div class="workflow-empty">暂无工作流</div>';
            }
        }

        async populateFormFromBackend() {
            try {
                await this.stateManager.loadConfig();
                await this.populateWorkflowSelect();
                this.uiManager.populateForm(this.stateManager.getConfig());
                this.populateLoraList();
            } catch (error) {
                console.error('[ComfyUI] Failed to load config from backend:', error);
                this.uiManager.populateForm(this.stateManager.getConfig());
                this.populateLoraList();
            }
        }

        async populateWorkflowSelect() {
            try {
                if (window.electronAPI && window.electronAPI.loadComfyUIWorkflows) {
                    const workflows = await window.electronAPI.loadComfyUIWorkflows();
                    const workflowSelect = this.uiManager.getElement('workflowSelect');
                    if (workflowSelect && workflows && workflows.length > 0) {
                        workflowSelect.innerHTML = '';
                        workflows.forEach(workflow => {
                            const option = document.createElement('option');
                            option.value = workflow.name;
                            option.textContent = workflow.displayName || workflow.name;
                            workflowSelect.appendChild(option);
                        });
                    }
                }
            } catch (error) {
                console.error('[ComfyUI] Failed to load workflows for select:', error);
            }
        }

        updateConfigFromForm() {
            const pick = (id) => this.uiManager.getElement(id)?.value || '';
            const toInt = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
            const toFloat = (v, def) => { const n = parseFloat(v); return Number.isFinite(n) ? n : def; };
            
            const currentConfig = this.stateManager.getConfig();
            const newConfig = {
                serverUrl: pick('comfyUIServerUrl') || currentConfig.serverUrl,
                apiKey: pick('comfyUIApiKey'),
                workflow: pick('workflowSelect') || currentConfig.workflow,
                defaultModel: pick('defaultModel') || currentConfig.defaultModel,
                defaultWidth: toInt(pick('defaultWidth'), currentConfig.defaultWidth),
                defaultHeight: toInt(pick('defaultHeight'), currentConfig.defaultHeight),
                defaultSteps: toInt(pick('defaultSteps'), currentConfig.defaultSteps),
                defaultCfg: toFloat(pick('defaultCfg'), currentConfig.defaultCfg),
                defaultSampler: pick('defaultSampler') || currentConfig.defaultSampler,
                defaultScheduler: pick('defaultScheduler') || currentConfig.defaultScheduler,
                defaultSeed: toInt(pick('defaultSeed'), currentConfig.defaultSeed),
                defaultBatchSize: toInt(pick('defaultBatchSize'), currentConfig.defaultBatchSize),
                defaultDenoise: toFloat(pick('defaultDenoise'), currentConfig.defaultDenoise),
                qualityTags: pick('qualityTags'),
                negativePrompt: pick('negativePrompt'),
                loras: this.stateManager.get('loras') || [],
                version: '1.0.0',
                lastUpdated: new Date().toISOString()
            };
            this.stateManager.updateConfig(newConfig);
        }

        async testConnection() {
            this.uiManager.setTestConnectionButtonState(false, '测试中...');
            try {
                this.updateConfigFromForm();
                const response = await this.fetchWithTimeout(`${this.stateManager.get('serverUrl')}/system_stats`, {
                    method: 'GET',
                    headers: this.stateManager.get('apiKey') ? { 'Authorization': `Bearer ${this.stateManager.get('apiKey')}` } : {}
                }, 5000);

                if (response.ok) {
                    this.stateManager.setConnectionStatus(true);
                    this.uiManager.updateConnectionStatus(true);
                    await this.loadAvailableModels();
                } else {
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (error) {
                this.stateManager.setConnectionStatus(false);
                this.uiManager.updateConnectionStatus(false);
                this.uiManager.showToast(`连接失败: ${error.message}`, 'error');
            } finally {
                this.uiManager.setTestConnectionButtonState(true);
            }
        }

        async loadAvailableModels() {
            try {
                const response = await this.fetchWithTimeout(`${this.stateManager.get('serverUrl')}/object_info`, {
                    headers: this.stateManager.get('apiKey') ? { 'Authorization': `Bearer ${this.stateManager.get('apiKey')}` } : {}
                }, 5000);

                if (response.ok) {
                    const data = await response.json();
                    this.uiManager.updateModelOptions(data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [], this.stateManager.get('defaultModel'));
                    this.stateManager.setAvailableLoRAs(data.LoraLoader?.input?.required?.lora_name?.[0] || []);
                }
            } catch (error) {
                console.warn('[ComfyUI][Network] Failed to load available models:', error);
            }
        }

        async saveConfig() {
            this.updateConfigFromForm();
            try {
                await this.stateManager.saveConfig();
                this.uiManager.showToast('配置已保存', 'success');
                this.closeModal();
            } catch (error) {
                console.error('Failed to save ComfyUI config:', error);
                this.uiManager.showToast('保存配置失败', 'error');
            }
        }

        async fetchWithTimeout(resource, options = {}, timeoutMs = 8000) {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetch(resource, { ...options, signal: controller.signal });
            } finally {
                clearTimeout(id);
            }
        }

        async loadConfig() {
            await this.stateManager.loadConfig();
        }

        async loadAvailableWorkflows() {
            if (this.stateManager.isLoading) return;
            
            try {
                this.stateManager.isLoading = true;
                this.abortController = new AbortController();
                
                const workflowList = this.uiManager.getElement('workflowList');
                if (workflowList) workflowList.innerHTML = '<div class="workflow-loading">正在加载工作流...</div>';
                
                if (window.electronAPI && window.electronAPI.loadComfyUIWorkflows) {
                    const workflows = await this.callWithTimeout(
                        () => window.electronAPI.loadComfyUIWorkflows(),
                        5000,
                        this.abortController.signal
                    );
                    if (this.abortController.signal.aborted) return;
                    this.uiManager.updateWorkflowList(workflows, this);
                } else {
                    if (workflowList) this.uiManager.updateWorkflowList([], this);
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.warn('Failed to load workflows:', error);
                    this.uiManager.updateWorkflowList(null, this);
                }
            } finally {
                this.stateManager.isLoading = false;
                this.abortController = null;
            }
        }

        async callWithTimeout(fn, timeout, signal) {
            return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => reject(new Error('Operation timed out')), timeout);
                if (signal) {
                    signal.addEventListener('abort', () => {
                        clearTimeout(timeoutId);
                        reject(new DOMException('Operation was aborted', 'AbortError'));
                    });
                }
                fn().then(
                    result => { clearTimeout(timeoutId); resolve(result); },
                    error => { clearTimeout(timeoutId); reject(error); }
                );
            });
        }

        // ... [Workflow and LoRA methods remain, as they are business logic]
    }

    window.comfyUIConfigManager = ComfyUIConfigManager.getInstance();
})();