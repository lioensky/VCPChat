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
            // 移除未使用的 abortController，保持最小状态面
            
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
            // 延迟到 createUI 调用时再初始化，避免无意义的提前工作
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
                await this.refreshWorkflows(); // 统一刷新工作流列表与下拉

                // Update initial UI states
                this.uiManager.updateConnectionStatus(this.stateManager.isConnectionActive());
                this.uiManager.setTestConnectionButtonState(true); // Ready to test

                // Bind events after UI is fully rendered
                this.uiManager.register('testConnectionBtn', 'click', () => this.testConnection());
                
                // 订阅主进程工作流变更事件，事件驱动刷新
                if (window.electronAPI?.on) {
                    window.electronAPI.on('comfyui:workflows-changed', () => {
                        this.refreshWorkflows();
                    });
                } else if (window.comfyUI?.onConfigChanged) {
                    try { window.comfyUI.watchConfig?.(); } catch(e) {}
                    window.comfyUI.onConfigChanged(() => {
                        this.loadConfig()
                            .then(() => this.uiManager.populateForm(this.stateManager.getConfig()))
                            .then(() => this.refreshWorkflows())
                            .catch(() => {/* ignore */});
                    });
                }

                // If already connected, try to load models
                if (this.stateManager.isConnectionActive()) {
                    this.loadAvailableModels();
                } else {
                    // 没有连接时，使用兜底列表
                    this.populateWithFallbacks();
                }
                // 初始渲染时保证 LoRA 列表与配置同步（去重）
                this.populateLoraList();

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
            // 移除未使用的临时状态与中断控制
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

        // 废弃的独立加载入口，统一使用 refreshWorkflows
        async loadAvailableWorkflows() {
            return this.refreshWorkflows();
        }

        // 统一 toast 封装，优先走 UI 管理器，退化为控制台
        toast(message, type = 'info') {
            try {
                if (this.uiManager && typeof this.uiManager.showToast === 'function') {
                    this.uiManager.showToast(message, type);
                } else if (window.uiHelperFunctions && typeof window.uiHelperFunctions.showToastNotification === 'function') {
                    window.uiHelperFunctions.showToastNotification(message, type);
                } else if (window.uiHelperFunctions && typeof window.uiHelperFunctions.showToast === 'function') {
                    window.uiHelperFunctions.showToast(message, type);
                } else {
                    const level = type === 'error' ? 'error' : (type === 'warning' ? 'warn' : 'log');
                    console[level]('[ComfyUI]', message);
                }
            } catch (e) {
                console.log('[ComfyUI]', message);
            }
        }

        // 集中式刷新：更新工作流列表 + 下拉选择
        async refreshWorkflows() {
            if (!window.electronAPI || typeof window.electronAPI.invoke !== 'function') {
                this.toast('IPC not ready, cannot load workflow list', 'error');
                this.uiManager.updateWorkflowList([], this);
                return;
            }
            try {
                const resp = await window.electronAPI.invoke('comfyui:get-workflows');
                if (!resp?.success) throw new Error(resp?.error || 'Failed to get workflows');
                const workflows = resp.workflows || [];
                this.uiManager.updateWorkflowList(workflows, this);
                await this.populateWorkflowSelect();
            } catch (e) {
                this.toast(`Failed to load workflow list: ${e.message}`, 'error');
                this.uiManager.updateWorkflowList([], this);
            }
        }

        async populateWorkflowSelect() {
            const workflowSelect = this.uiManager.getElement('workflowSelect');
            if (!workflowSelect) return;

            try {
                if (!window.electronAPI?.invoke) {
                    this.toast('IPC not ready, cannot load workflows', 'error');
                    workflowSelect.innerHTML = '<option value="">IPC not ready</option>';
                    return;
                }
                
                const resp = await window.electronAPI.invoke('comfyui:get-workflows');
                if (!resp?.success) {
                    throw new Error(resp?.error || 'Main process failed to get workflow list');
                }

                const workflows = resp.workflows || [];
                workflowSelect.innerHTML = ''; // Clear previous options
                if (workflows.length === 0) {
                    workflowSelect.innerHTML = '<option value="">No workflows available</option>';
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
                this.toast(`Failed to load workflows: ${error.message}`, 'error');
                if (workflowSelect) {
                    workflowSelect.innerHTML = '<option value="">Failed to load</option>';
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
            this.uiManager.setTestConnectionButtonState(false, 'Testing...');
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
                this.toast(`Connection failed: ${error.message}`, 'error');
            } finally {
                this.uiManager.setTestConnectionButtonState(true);
            }
        }

        async loadAvailableModels() {
            try {
                const serverUrl = this.stateManager.get('serverUrl');
                if (!serverUrl) {
                    // 没有服务器地址，使用兜底列表
                    this.populateWithFallbacks();
                    return;
                }

                const response = await this.fetchWithTimeout(`${serverUrl}/object_info`, {
                    headers: this.stateManager.get('apiKey') ? { 'Authorization': `Bearer ${this.stateManager.get('apiKey')}` } : {}
                }, 8000);

                if (response.ok) {
                    const data = await response.json();
                    const currentState = this.stateManager.getConfig();
                    const fallbacks = this.uiManager.fallbackOptions || {};

                    // Models - 使用兜底列表作为备选
                    const models = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
                    this.uiManager.updateModelOptions(
                        models.length > 0 ? models : fallbacks.models || [],
                        currentState.defaultModel
                    );

                    // Samplers and Schedulers from KSampler - 使用兜底列表作为备选
                    const samplers = data.KSampler?.input?.required?.sampler_name?.[0] || [];
                    const schedulers = data.KSampler?.input?.required?.scheduler?.[0] || [];
                    this.uiManager.updateSamplerOptions(
                        samplers.length > 0 ? samplers : fallbacks.samplers || [],
                        currentState.defaultSampler
                    );
                    this.uiManager.updateSchedulerOptions(
                        schedulers.length > 0 ? schedulers : fallbacks.schedulers || [],
                        currentState.defaultScheduler
                    );

                    // Available LoRAs for reference (e.g., autocomplete in future)
                    const loras = data.LoraLoader?.input?.required?.lora_name?.[0] || [];
                    // 将可用 LoRA 列表作为运行时数据存放，不写入 config
                    this.stateManager.setAvailableLoRAs(loras.length > 0 ? loras : fallbacks.loras || []);
                    
                    this.toast('Model/sampler list updated', 'success');
                } else {
                    this.toast('Failed to load model list, using default options', 'warning');
                    this.populateWithFallbacks();
                }
            } catch (error) {
                console.warn('[ComfyUI][Network] Failed to load available models:', error);
                this.toast('Failed to load model list, using default options', 'warning');
                this.populateWithFallbacks();
            }
        }

        populateWithFallbacks() {
            const fallbacks = this.uiManager.fallbackOptions || {};
            const currentState = this.stateManager.getConfig();
            
            this.uiManager.updateModelOptions(
                fallbacks.models || [],
                currentState.defaultModel
            );
            this.uiManager.updateSamplerOptions(
                fallbacks.samplers || [],
                currentState.defaultSampler
            );
            this.uiManager.updateSchedulerOptions(
                fallbacks.schedulers || [],
                currentState.defaultScheduler
            );
            this.stateManager.setAvailableLoRAs(fallbacks.loras || []);
        }

        async saveConfig() {
            this.updateConfigFromForm();
            try {
                if (!window.electronAPI?.invoke) {
                    this.toast('IPC not ready, cannot save config', 'error');
                    await this.stateManager.saveConfig();
                    this.toast('Config saved temporarily to local storage', 'warning');
                    return;
                }
                const data = this.stateManager.getConfig();
                const resp = await window.electronAPI.invoke('comfyui:save-config', data);
                if (resp.success) {
                    this.toast('Config saved', 'success');
                } else {
                    throw new Error(resp.error || 'Main process save failed');
                }
            } catch (error) {
                console.error('Failed to save ComfyUI config:', error);
                this.toast(`Failed to save config: ${error.message}`, 'error');
            }
        }

        async fetchWithTimeout(resource, options = {}, timeoutMs = 8000) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetch(resource, { ...options, signal: controller.signal });
            } finally {
                clearTimeout(timer);
            }
        }

        async loadConfig() {
            try {
                if (!window.electronAPI?.invoke) {
                    this.toast('IPC not ready, falling back to local config', 'warning');
                    await this.stateManager.loadConfig(); // Fallback to localStorage
                    return;
                }

                const resp = await window.electronAPI.invoke('comfyui:get-config');
                if (resp?.success && resp.data) {
                    this.stateManager.updateConfig(resp.data);
                    return;
                } else {
                     throw new Error(resp.error || 'Main process failed to get config');
                }
            } catch (e) {
                console.error('[ComfyUI] IPC get-config failed, falling back to localStorage.', e);
                this.toast(`Cannot load config from file: ${e.message}, falling back to local cache`, 'error');
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
            this.toast('Preset applied', 'info');
        }

        populateLoraList() {
            const loras = this.stateManager.get('loras') || [];
            this.uiManager.updateLoraList(loras, this);
        }

        async viewWorkflow(workflowName) {
            try {
                if (!workflowName) {
                    this.toast('No workflow name specified', 'error');
                    return;
                }
                if (!window.electronAPI?.invoke) {
                    this.toast('IPC not ready, cannot read workflow', 'error');
                    return;
                }
                // 读取工作流 JSON
                const resp = await window.electronAPI.invoke('comfyui:read-workflow', { name: workflowName });
                if (!resp?.success) {
                    throw new Error(resp?.error || 'Failed to read workflow');
                }
                const data = resp.data || {};
                // 切换到“导入工作流”标签并填充编辑器
                this.uiManager.switchTab('import');
                const nameInput = this.uiManager.getElement('workflowName');
                const jsonTextarea = this.uiManager.getElement('workflowJson');
                const importResult = this.uiManager.getElement('importResult');
                if (nameInput) nameInput.value = workflowName;
                if (jsonTextarea) jsonTextarea.value = JSON.stringify(data, null, 2);
                if (importResult) { importResult.style.display = 'none'; importResult.textContent = ''; }
                this.toast('Workflow loaded into editor', 'success');
            } catch (e) {
                console.error('[ComfyUI] viewWorkflow error:', e);
                this.toast(`Cannot view workflow: ${e.message}`, 'error');
            }
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