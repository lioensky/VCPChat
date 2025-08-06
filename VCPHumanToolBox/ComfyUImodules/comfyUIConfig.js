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
            // Defer initialization until createUI is called
        }

        async createUI(container, options = {}) {
            try {
                this.onCloseCallback = options.onClose; // Store the close callback
                await this.loadConfig(); // Load config first

                // Create the basic UI structure
                const defaultTab = options.defaultTab || 'connection';
                this.uiManager.createPanelContent(container, this, { defaultTab });

                // Populate the form with loaded data
                this.uiManager.populateForm(this.stateManager.getConfig());
                
                // Populate dynamic lists
                this.populateLoraList();
                this.populateWorkflowSelect();
                this.loadAvailableWorkflows(); // This populates the management list

                // Update initial UI states
                this.uiManager.updateConnectionStatus(this.stateManager.isConnectionActive());
                this.uiManager.setTestConnectionButtonState(true); // Ready to test

                // Bind events after UI is fully rendered
                this.uiManager.register('testConnectionBtn', 'click', () => this.testConnection());
                
                // 订阅主进程工作流变更事件，事件驱动刷新
                if (window.electronAPI?.on) {
                    window.electronAPI.on('comfyui:workflows-changed', () => {
                        this.loadAvailableWorkflows();
                        this.populateWorkflowSelect();
                    });
                }

                // If already connected, try to load models
                if (this.stateManager.isConnectionActive()) {
                    this.loadAvailableModels();
                }

            } catch (error) {
                console.error('[ComfyUI] Failed to create UI:', error);
                container.innerHTML = `<div class="error">Failed to load ComfyUI configuration. See console for details.</div>`;
            }
        }

        close() {
            this.cancelOngoingOperations();
            this.uiManager.clearDOMCache();
            // The DrawerController in renderer.js will handle the visual closing
            if (this.onCloseCallback) {
                this.onCloseCallback();
            }
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

        async populateFormFromState() {
            // This function is now effectively replaced by the logic in createUI
            // but we keep it in case it's called from somewhere else.
            this.uiManager.populateForm(this.stateManager.getConfig());
        }

        async loadAvailableWorkflows() {
            if (!window.electronAPI?.invoke) {
                this.uiManager.showToast('IPC未就绪，无法加载工作流列表', 'error');
                return;
            }
            try {
                const resp = await window.electronAPI.invoke('comfyui:get-workflows');
                if (resp.success) {
                    // The response from main.js is already an array of objects
                    this.uiManager.updateWorkflowList(resp.workflows, this);
                } else {
                    throw new Error(resp.error || '获取工作流失败');
                }
            } catch (e) {
                this.uiManager.showToast(`加载工作流列表失败: ${e.message}`, 'error');
                this.uiManager.updateWorkflowList([], this); // Show empty list on error
            }
        }

        async populateWorkflowSelect() {
            const workflowSelect = this.uiManager.getElement('workflowSelect');
            if (!workflowSelect) return;

            try {
                if (!window.electronAPI?.invoke) {
                    this.uiManager.showToast('IPC未就绪,无法加载工作流', 'error');
                    workflowSelect.innerHTML = '<option value="">IPC未就绪</option>';
                    return;
                }
                
                const resp = await window.electronAPI.invoke('comfyui:get-workflows');
                if (!resp.success) {
                    throw new Error(resp.error || '主进程未能获取工作流列表');
                }

                const workflows = resp.workflows || [];
                workflowSelect.innerHTML = ''; // Clear previous options
                if (workflows.length === 0) {
                    workflowSelect.innerHTML = '<option value="">无可用工作流</option>';
                    return;
                }

                workflows.forEach(workflow => {
                    const option = document.createElement('option');
                    option.value = workflow.name;
                    option.textContent = workflow.displayName || workflow.name;
                    workflowSelect.appendChild(option);
                });
                
                // Reselect the stored value
                const storedWorkflow = this.stateManager.get('workflow');
                if (storedWorkflow) {
                    workflowSelect.value = storedWorkflow;
                }

            } catch (error) {
                console.error('[ComfyUI] Failed to load workflows for select:', error);
                this.uiManager.showToast(`加载工作流失败: ${error.message}`, 'error');
                if (workflowSelect) {
                    workflowSelect.innerHTML = '<option value="">加载失败</option>';
                }
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
                }, 8000);

                if (response.ok) {
                    const data = await response.json();
                    const currentState = this.stateManager.getConfig();

                    // Models
                    const models = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
                    this.uiManager.updateModelOptions(models, currentState.defaultModel);

                    // Samplers and Schedulers from KSampler
                    const samplers = data.KSampler?.input?.required?.sampler_name?.[0] || [];
                    const schedulers = data.KSampler?.input?.required?.scheduler?.[0] || [];
                    this.uiManager.updateSamplerOptions(samplers, currentState.defaultSampler);
                    this.uiManager.updateSchedulerOptions(schedulers, currentState.defaultScheduler);

                    // Available LoRAs for reference (e.g., autocomplete in future)
                    const loras = data.LoraLoader?.input?.required?.lora_name?.[0] || [];
                    // 将可用 LoRA 列表作为运行时数据存放，不写入 config
                    this.stateManager.setAvailableLoRAs(loras);
                    
                    this.uiManager.showToast('模型/采样器列表已更新', 'success');
                } else {
                     this.uiManager.showToast(`加载模型列表失败: HTTP ${response.status}`, 'error');
                }
            } catch (error) {
                console.warn('[ComfyUI][Network] Failed to load available models:', error);
                this.uiManager.showToast(`加载模型列表失败: ${error.message}`, 'error');
            }
        }

        async saveConfig() {
            this.updateConfigFromForm();
            try {
                if (!window.electronAPI?.invoke) {
                    this.uiManager.showToast('IPC未就绪,无法保存配置', 'error');
                    // Fallback to local storage if needed, but warn the user
                    await this.stateManager.saveConfig();
                    this.uiManager.showToast('配置已临时保存至本地存储', 'warning');
                    return;
                }
                const data = this.stateManager.getConfig();
                const resp = await window.electronAPI.invoke('comfyui:save-config', data);
                if (resp.success) {
                    this.uiManager.showToast('配置已保存', 'success');
                } else {
                    throw new Error(resp.error || '主进程保存失败');
                }
            } catch (error) {
                console.error('Failed to save ComfyUI config:', error);
                this.uiManager.showToast(`保存配置失败: ${error.message}`, 'error');
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
            try {
                if (!window.electronAPI?.invoke) {
                    this.uiManager.showToast('IPC未就绪,回退至本地配置', 'warning');
                    await this.stateManager.loadConfig(); // Fallback to localStorage
                    return;
                }

                const resp = await window.electronAPI.invoke('comfyui:get-config');
                if (resp?.success && resp.data) {
                    this.stateManager.updateConfig(resp.data);
                    return;
                } else {
                     throw new Error(resp.error || '主进程未能获取配置');
                }
            } catch (e) {
                console.error('[ComfyUI] IPC get-config failed, falling back to localStorage.', e);
                this.uiManager.showToast(`无法从文件加载配置: ${e.message}, 已回退至本地缓存`, 'error');
                await this.stateManager.loadConfig(); // Fallback to localStorage
            }
        }


        applyPreset(dataset) {
            const { width, height, steps, cfg } = dataset;
            const config = {
                defaultWidth: parseInt(width, 10),
                defaultHeight: parseInt(height, 10),
                defaultSteps: parseInt(steps, 10),
                defaultCfg: parseFloat(cfg)
            };
            this.stateManager.updateConfig(config);
            this.uiManager.populateForm(this.stateManager.getConfig());
            this.uiManager.showToast('预设已应用', 'info');
        }

        populateLoraList() {
            const loras = this.stateManager.get('loras') || [];
            this.uiManager.updateLoraList(loras, this);
        }

        // ... [Workflow and LoRA methods remain, as they are business logic]
    }

    // Expose a single, clean interface to the main renderer
    window.comfyUI = {
        createUI: (container, options = {}) => {
            const manager = ComfyUIConfigManager.getInstance();
            manager.createUI(container, options);
        },
        destroyUI: () => {
            const manager = ComfyUIConfigManager.getInstance();
            manager.close();
        },
    };
})();