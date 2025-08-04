// ComfyUI Configuration Module - Singleton Pattern
(function() {
    'use strict';
    
    class ComfyUIConfigManager {
        constructor() {
            // Prevent multiple instances
            if (ComfyUIConfigManager.instance) {
                return ComfyUIConfigManager.instance;
            }
            
            this.config = {
                serverUrl: 'http://localhost:8188',
                apiKey: '',
                workflow: 'text2img_basic', // 新增：工作流选择
                defaultModel: 'sd_xl_base_1.0.safetensors',
                defaultWidth: 1024,
                defaultHeight: 1024,
                defaultSteps: 30,
                defaultCfg: 7.5,
                defaultSampler: 'dpmpp_2m',
                defaultScheduler: 'normal', // 新增
                defaultSeed: -1, // 新增
                defaultBatchSize: 1, // 新增
                defaultDenoise: 1.0, // 新增
                defaultLoRA: '', // 新增
                defaultLoRAStrength: 1.0, // 新增
                negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry' // 新增
            };
            
            // State management
            this.isConnected = false;
            this.isLoading = false;
            this.isHandlingConfigChange = false; // 新增：防止重复处理配置变化
            this.abortController = null;
            this.modalStack = [];
            this.availableLoRA = []; // 存储可用的LoRA列表
            
            // 移除缓存机制 - 直接从后端读取数据
            
            // Event handlers (bind once)
            this.boundHandlers = {
                escape: this.handleEscapeKey.bind(this),
                formSubmit: this.handleAddWorkflowSubmit.bind(this)
            };
            
            // DOM references cache
            this.domCache = new Map();
            
            ComfyUIConfigManager.instance = this;
            
            // Wait for DOM to be ready
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
                await this.loadConfig(); // 使用异步加载
                this.bindEvents();
                this.setupFileWatcher(); // 设置文件监听
                this.updateConnectionStatus();
                console.log('[ComfyUI] ComfyUI Configuration Manager initialized successfully');
            } catch (error) {
                console.error('[ComfyUI] Failed to initialize:', error);
            }
        }

        // DOM caching utility
        getElement(id, useCache = true) {
            if (useCache && this.domCache.has(id)) {
                const cached = this.domCache.get(id);
                // Verify element is still in DOM
                if (cached && document.contains(cached)) {
                    return cached;
                }
                // Remove stale cache entry
                this.domCache.delete(id);
            }
            
            const element = document.getElementById(id);
            if (element && useCache) {
                this.domCache.set(id, element);
            }
            return element;
        }

        // Clear DOM cache
        clearDOMCache() {
            this.domCache.clear();
        }

    // 设置文件监听
    async setupFileWatcher() {
        try {
            if (window.electronAPI && window.electronAPI.watchComfyUIConfig) {
                const result = await window.electronAPI.watchComfyUIConfig();
                if (result.success) {
                    console.log('[ComfyUI] File watcher setup successful');
                    
                    // 监听后端文件变化通知
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

    // 处理配置文件变化
    async handleConfigFileChanged() {
        try {
            // 防止重复加载
            if (this.isHandlingConfigChange) {
                console.log('[ComfyUI] Config change already being handled, skipping...');
                return;
            }
            
            this.isHandlingConfigChange = true;
            
            // 从后端重新加载配置
            const newConfig = await window.electronAPI.getComfyUIConfigRealtime?.();
            if (newConfig) {
                this.config = { ...this.config, ...newConfig };
                console.log('[ComfyUI] Configuration reloaded from backend after file change');
                
                // 如果配置界面正在显示，更新表单
                const modal = document.getElementById('comfyUIConfigModal');
                if (modal && modal.style.display !== 'none' && !modal.classList.contains('hidden')) {
                    this.populateForm();
                    this.showToast('配置已自动更新', 'info');
                }
            }
            
            // 解除锁定
            setTimeout(() => {
                this.isHandlingConfigChange = false;
            }, 1000); // 1秒后解除锁定
            
        } catch (error) {
            console.error('[ComfyUI] Failed to handle config file change:', error);
            this.isHandlingConfigChange = false;
        }
    }

    // 移除所有缓存相关方法 - 改为直接读取后端数据

    bindEvents() {
        try {
            // Modal open button
            const openBtn = document.getElementById('openComfyUIConfigBtn');
            if (openBtn) {
                openBtn.addEventListener('click', () => this.openModal());
            } else {
                console.warn('[ComfyUI] openComfyUIConfigBtn not found');
            }

            // Tab switching
            document.querySelectorAll('.config-tab-button').forEach(button => {
                button.addEventListener('click', (e) => {
                    this.switchTab(e.target.dataset.tab);
                });
            });

            // Test connection button
            const testBtn = document.getElementById('testConnectionBtn');
            if (testBtn) {
                testBtn.addEventListener('click', () => this.testConnection());
            }

            // Save configuration button
            const saveBtn = document.getElementById('saveComfyUIConfigBtn');
            if (saveBtn) {
                saveBtn.addEventListener('click', () => this.saveConfig());
            }
        } catch (error) {
            console.error('[ComfyUI] Error binding events:', error);
        }

        // Add workflow button
        const addWorkflowBtn = document.getElementById('addWorkflowBtn');
        if (addWorkflowBtn) {
            addWorkflowBtn.addEventListener('click', () => this.showAddWorkflowDialog());
        }

        // Add LoRA button
        const addLoraBtn = document.getElementById('addLoraBtn');
        if (addLoraBtn) {
            addLoraBtn.addEventListener('click', () => this.addLoraItem());
        }

        // Test LoRA button
        const testLoraBtn = document.getElementById('testLoraBtn');
        if (testLoraBtn) {
            testLoraBtn.addEventListener('click', () => this.debugLoRA());
        }

        // Auto-save on input change
        this.bindInputEvents();
    }

    bindInputEvents() {
        const inputs = [
            'comfyUIServerUrl', 'comfyUIApiKey', 'defaultModel',
            'defaultWidth', 'defaultHeight', 'defaultSteps', 
            'defaultCfg', 'defaultSampler', 'defaultScheduler',
            'defaultSeed', 'defaultBatchSize', 'defaultDenoise',
            'qualityTags', 'negativePrompt'
        ];

        inputs.forEach(inputId => {
            const element = document.getElementById(inputId);
            if (element) {
                element.addEventListener('change', () => this.updateConfigFromForm());
            }
        });

        // Bind preset buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const width = e.target.dataset.width;
                const height = e.target.dataset.height;
                
                if (width && height) {
                    document.getElementById('defaultWidth').value = width;
                    document.getElementById('defaultHeight').value = height;
                    this.updateConfigFromForm();
                    
                    // Update active state
                    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                }
            });
        });
    }

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.config-tab-button').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

        // Update tab content
        document.querySelectorAll('.config-tab-content').forEach(content => {
            content.classList.remove('active');
        });
        
        const targetTab = document.getElementById(`${tabName}Tab`);
        if (targetTab) {
            targetTab.classList.add('active');
        }
    }

    async openModal() {
        console.log('[ComfyUI] Opening configuration modal...');
        
        // Cancel any ongoing operations
        this.cancelOngoingOperations();
        
        // First, generate the modal content
        this.generateModalContent();
        
        // 直接从后端加载最新数据 - 不使用缓存
        if (this.isConnected) {
            await this.loadAvailableModels();
        }
        
        // Load available workflows from backend
        await this.loadAvailableWorkflows();
        
        // Populate form with current config from backend
        await this.populateFormFromBackend();
        
        // Open modal using existing UI helper
        if (window.uiHelperFunctions) {
            window.uiHelperFunctions.openModal('comfyUIConfigModal');
        } else {
            console.error('[ComfyUI] uiHelperFunctions not available');
        }
    }

    closeModal() {
        console.log('[ComfyUI] Closing configuration modal...');
        
        // Cancel any ongoing operations
        this.cancelOngoingOperations();
        
        // Close all child modals first
        this.closeAllChildModals();
        
        if (window.uiHelperFunctions) {
            window.uiHelperFunctions.closeModal('comfyUIConfigModal');
        }
        
        // Clear modal stack
        this.modalStack = [];
    }

    closeAllChildModals() {
        // Close all child modals in reverse order (LIFO)
        while (this.modalStack.length > 0) {
            const modalId = this.modalStack.pop();
            console.log(`[ComfyUI] Closing child modal: ${modalId}`);
            
            if (window.uiHelperFunctions) {
                window.uiHelperFunctions.closeModal(modalId);
            } else {
                const modal = document.getElementById(modalId);
                if (modal) {
                    modal.classList.remove('active');
                }
            }
        }
    }

    cancelOngoingOperations() {
        // Cancel any ongoing async operations
        if (this.abortController) {
            console.log('[ComfyUI] Cancelling ongoing operations...');
            this.abortController.abort();
            this.abortController = null;
        }
        
        // Reset loading state
        this.isLoading = false;
        
        // Clear any loading indicators
        const workflowList = document.getElementById('workflowList');
        if (workflowList && workflowList.innerHTML.includes('workflow-loading')) {
            workflowList.innerHTML = '<div class="workflow-empty">暂无工作流</div>';
        }
    }

    generateModalContent() {
        const modal = document.getElementById('comfyUIConfigModal');
        if (!modal) {
            console.error('[ComfyUI] Modal element not found');
            return;
        }

        const modalContent = modal.querySelector('.modal-content');
        if (!modalContent) {
            console.error('[ComfyUI] Modal content element not found');
            return;
        }

        modalContent.innerHTML = `
            <span class="close-button" onclick="window.comfyUIConfigManager.closeModal()">&times;</span>
            <h2>ComfyUI 图像生成配置</h2>
            
            <div class="config-tabs">
                <button class="config-tab-button active" data-tab="connection">连接设置</button>
                <button class="config-tab-button" data-tab="parameters">生成参数</button>
                <button class="config-tab-button" data-tab="prompt">提示词配置</button>
                <button class="config-tab-button" data-tab="workflows">工作流管理</button>
                <button class="config-tab-button" data-tab="import">导入工作流</button>
            </div>

            <div class="config-tab-content active" id="connectionTab">
                <div class="config-section">
                    <h3>ComfyUI 连接配置</h3>
                    <div class="connection-status" id="comfyUIConnectionStatus">
                        <span class="status-indicator offline"></span>
                        <span class="status-text">未连接</span>
                        <button id="testConnectionBtn" class="small-button">测试连接</button>
                    </div>
                    
                    <div class="form-group">
                        <label for="comfyUIServerUrl">ComfyUI 服务器地址:</label>
                        <input type="url" id="comfyUIServerUrl" placeholder="http://localhost:8188" value="http://localhost:8188">
                    </div>
                    
                    <div class="form-group">
                        <label for="comfyUIApiKey">API Key (可选):</label>
                        <input type="password" id="comfyUIApiKey" placeholder="留空则不使用认证">
                    </div>
                </div>
            </div>

            <div class="config-tab-content" id="parametersTab">
                <div class="config-section">
                    <h3>基础生成参数</h3>
                    
                    <div class="form-group">
                        <label for="workflowSelect">工作流模板:</label>
                        <select id="workflowSelect">
                            <option value="text2img_basic">Text2Image 基础</option>
                            <option value="img2img_basic">Image2Image 基础</option>
                        </select>
                        <small>选择Agent调用插件时使用的默认工作流</small>
                    </div>
                    
                    <div class="form-group">
                        <label for="defaultModel">默认模型:</label>
                        <select id="defaultModel">
                            <option value="sd_xl_base_1.0.safetensors">SDXL Base 1.0</option>
                            <option value="sd_xl_refiner_1.0.safetensors">SDXL Refiner 1.0</option>
                        </select>
                    </div>
                    
                    <div class="form-group-inline">
                        <div>
                            <label for="defaultWidth">宽度:</label>
                            <select id="defaultWidth">
                                <option value="512">512px (SD 1.5)</option>
                                <option value="768">768px</option>
                                <option value="832">832px</option>
                                <option value="896">896px</option>
                                <option value="1024" selected>1024px (SDXL)</option>
                                <option value="1152">1152px</option>
                                <option value="1216">1216px</option>
                                <option value="1344">1344px</option>
                                <option value="1536">1536px</option>
                            </select>
                        </div>
                        <div>
                            <label for="defaultHeight">高度:</label>
                            <select id="defaultHeight">
                                <option value="512">512px (SD 1.5)</option>
                                <option value="768">768px</option>
                                <option value="832">832px</option>
                                <option value="896">896px</option>
                                <option value="1024" selected>1024px (SDXL)</option>
                                <option value="1152">1152px</option>
                                <option value="1216">1216px</option>
                                <option value="1344">1344px</option>
                                <option value="1536">1536px</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>快速尺寸预设:</label>
                        <div class="preset-buttons">
                            <button type="button" class="preset-btn" data-width="512" data-height="512">1:1 (512)</button>
                            <button type="button" class="preset-btn" data-width="768" data-height="512">3:2 (768x512)</button>
                            <button type="button" class="preset-btn" data-width="512" data-height="768">2:3 (512x768)</button>
                            <button type="button" class="preset-btn" data-width="1024" data-height="1024">1:1 (1024)</button>
                            <button type="button" class="preset-btn" data-width="1152" data-height="896">9:7 (1152x896)</button>
                            <button type="button" class="preset-btn" data-width="896" data-height="1152">7:9 (896x1152)</button>
                            <button type="button" class="preset-btn" data-width="1344" data-height="768">16:9 (1344x768)</button>
                            <button type="button" class="preset-btn" data-width="768" data-height="1344">9:16 (768x1344)</button>
                        </div>
                    </div>
                    
                    <div class="form-group-inline">
                        <div>
                            <label for="defaultSteps">采样步数:</label>
                            <input type="number" id="defaultSteps" min="1" max="150" value="30">
                        </div>
                        <div>
                            <label for="defaultCfg">CFG Scale:</label>
                            <input type="number" id="defaultCfg" min="1" max="30" step="0.5" value="7.5">
                        </div>
                    </div>
                    
                    <div class="form-group-inline">
                        <div>
                            <label for="defaultSeed">随机种子:</label>
                            <input type="number" id="defaultSeed" value="-1">
                            <small>-1 为随机</small>
                        </div>
                        <div>
                            <label for="defaultBatchSize">生成数量:</label>
                            <input type="number" id="defaultBatchSize" min="1" max="10" value="1">
                        </div>
                    </div>
                    
                    <div class="form-group-inline">
                        <div>
                            <label for="defaultSampler">采样器:</label>
                            <select id="defaultSampler">
                                <option value="euler">Euler</option>
                                <option value="euler_ancestral">Euler Ancestral</option>
                                <option value="dpmpp_2m" selected>DPM++ 2M</option>
                                <option value="dpmpp_sde">DPM++ SDE</option>
                            </select>
                        </div>
                        <div>
                            <label for="defaultScheduler">调度器:</label>
                            <select id="defaultScheduler">
                                <option value="normal" selected>Normal</option>
                                <option value="karras">Karras</option>
                                <option value="exponential">Exponential</option>
                                <option value="simple">Simple</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label for="defaultDenoise">去噪强度:</label>
                        <input type="number" id="defaultDenoise" min="0" max="1" step="0.01" value="1.0">
                    </div>
                </div>
            </div>

            <div class="config-tab-content" id="promptTab">
                <div class="config-section">
                    <h3>LoRA 管理</h3>
                    <p class="section-description">管理LoRA模型，支持多个LoRA同时使用。LoRA将按顺序添加到提示词中。</p>
                    
                    <div id="loraList" class="lora-list">
                        <!-- LoRA列表将动态生成 -->
                    </div>
                    
                    <div class="lora-add-section">
                        <button id="addLoraBtn" class="sidebar-button" style="background-color: var(--user-bubble-bg); color: white;">+ 添加 LoRA</button>
                    </div>
                </div>
                
                <div class="config-section">
                    <h3>质量增强词</h3>
                    <p class="section-description">设置默认的质量增强词，这些词将自动添加到每个生成请求中。</p>
                    
                    <div class="form-group">
                        <label for="qualityTags">质量增强词:</label>
                        <textarea id="qualityTags" rows="3" placeholder="例如: masterpiece, best quality, high resolution, detailed">masterpiece, best quality, high resolution, detailed</textarea>
                        <small>多个标签用逗号分隔，这些词将自动添加到所有生成请求中</small>
                    </div>
                </div>
                
                <div class="config-section">
                    <h3>负面提示词</h3>
                    <p class="section-description">设置默认的负面提示词，用于排除不希望出现的元素。</p>
                    
                    <div class="form-group">
                        <label for="negativePrompt">默认负面提示词:</label>
                        <textarea id="negativePrompt" rows="4" placeholder="输入不希望出现在图像中的元素">lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry</textarea>
                        <small>这些词将告诉AI避免生成相应的内容</small>
                    </div>
                </div>
            </div>

            <div class="config-tab-content" id="workflowsTab">
                <div class="config-section">
                    <h3>工作流模板</h3>
                    <div class="workflow-list" id="workflowList">
                        <div class="workflow-loading">正在加载工作流...</div>
                    </div>
                    <button id="addWorkflowBtn" class="sidebar-button">添加新工作流</button>
                </div>
            </div>

            <div class="config-tab-content" id="importTab">
                <div class="config-section">
                    <h3>导入ComfyUI工作流</h3>
                    <p class="section-description">将ComfyUI导出的API格式工作流JSON粘贴到下方，系统将自动转换为模板格式并保存到工作流文件夹中。</p>
                    
                    <div class="form-group">
                        <label for="workflowName">工作流名称:</label>
                        <input type="text" id="workflowName" placeholder="例如: 人物肖像-高清" maxlength="50">
                        <small>将作为文件名保存，建议使用中文描述</small>
                    </div>
                    
                    <div class="form-group">
                        <label for="workflowJson">工作流JSON:</label>
                        <textarea id="workflowJson" rows="10" placeholder="粘贴ComfyUI导出的API格式JSON工作流..."></textarea>
                        <small>从ComfyUI界面选择 "Save (API Format)" 导出的JSON内容</small>
                    </div>
                    
                    <div class="import-actions">
                        <button id="validateWorkflowBtn" class="sidebar-button" style="background-color: #666;">验证格式</button>
                        <button id="convertWorkflowBtn" class="sidebar-button" style="background-color: var(--user-bubble-bg); color: white;">转换并保存</button>
                    </div>
                    
                    <div id="importResult" class="import-result" style="display: none;">
                        <!-- 验证和转换结果将显示在这里 -->
                    </div>
                </div>
            </div>

            <div class="form-actions" style="margin-top: 20px;">
                <button type="button" id="saveComfyUIConfigBtn" class="sidebar-button" style="background-color: var(--user-bubble-bg); color: white;">保存配置</button>
                <button type="button" class="sidebar-button" onclick="window.comfyUIConfigManager.closeModal()">取消</button>
            </div>
        `;

        // Re-bind events after generating content
        this.bindModalEvents();
    }

    bindModalEvents() {
        // Tab switching
        document.querySelectorAll('.config-tab-button').forEach(button => {
            button.addEventListener('click', (e) => {
                this.switchTab(e.target.dataset.tab);
            });
        });

        // Test connection button
        const testBtn = document.getElementById('testConnectionBtn');
        if (testBtn) {
            testBtn.addEventListener('click', () => this.testConnection());
        }

        // Save configuration button
        const saveBtn = document.getElementById('saveComfyUIConfigBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveConfig());
        }

        // Add workflow button
        const addWorkflowBtn = document.getElementById('addWorkflowBtn');
        if (addWorkflowBtn) {
            addWorkflowBtn.addEventListener('click', () => this.showAddWorkflowDialog());
        }

        // Add LoRA button
        const addLoraBtn = document.getElementById('addLoraBtn');
        if (addLoraBtn) {
            addLoraBtn.addEventListener('click', () => this.addLoraItem());
        }

        // Import workflow buttons
        const validateWorkflowBtn = document.getElementById('validateWorkflowBtn');
        if (validateWorkflowBtn) {
            validateWorkflowBtn.addEventListener('click', () => this.validateWorkflowJson());
        }

        const convertWorkflowBtn = document.getElementById('convertWorkflowBtn');
        if (convertWorkflowBtn) {
            convertWorkflowBtn.addEventListener('click', () => this.convertAndSaveWorkflow());
        }

        // Refresh workflows button
        const refreshBtn = document.getElementById('refreshWorkflowsBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.loadAvailableWorkflows());
        }

        // Preset buttons for quick size setting
        document.querySelectorAll('.preset-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const width = e.target.dataset.width;
                const height = e.target.dataset.height;
                
                const widthSelect = document.getElementById('defaultWidth');
                const heightSelect = document.getElementById('defaultHeight');
                
                if (widthSelect && heightSelect) {
                    widthSelect.value = width;
                    heightSelect.value = height;
                    
                    // Highlight the selected preset button
                    document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
                    e.target.classList.add('active');
                }
            });
        });
    }

    closeModal() {
        if (window.uiHelperFunctions) {
            window.uiHelperFunctions.closeModal('comfyUIConfigModal');
        }
    }

    // 新方法：从后端加载配置并填充表单
    async populateFormFromBackend() {
        try {
            // 直接从后端读取最新配置
            if (window.electronAPI && window.electronAPI.loadComfyUIConfig) {
                const backendConfig = await window.electronAPI.loadComfyUIConfig();
                if (backendConfig) {
                    // 更新本地配置对象
                    this.config = { ...this.config, ...backendConfig };
                    
                    // 加载工作流列表并填充选择框
                    await this.populateWorkflowSelect();
                    
                    // 填充表单（包括LoRA列表和质量词）
                    this.populateForm();
                    
                    // 生成LoRA列表
                    this.populateLoraList();
                }
            }
        } catch (error) {
            console.error('[ComfyUI] Failed to load config from backend:', error);
            // 使用默认配置填充表单
            this.populateForm();
            this.populateLoraList();
        }
    }

    // 新方法：填充工作流选择框
    async populateWorkflowSelect() {
        try {
            if (window.electronAPI && window.electronAPI.loadComfyUIWorkflows) {
                const workflows = await window.electronAPI.loadComfyUIWorkflows();
                const workflowSelect = document.getElementById('workflowSelect');
                
                if (workflowSelect && workflows && workflows.length > 0) {
                    // 清空现有选项
                    workflowSelect.innerHTML = '';
                    
                    // 添加工作流选项
                    workflows.forEach(workflow => {
                        const option = document.createElement('option');
                        option.value = workflow.name;
                        option.textContent = workflow.displayName || workflow.name;
                        workflowSelect.appendChild(option);
                    });
                    
                    console.log('[ComfyUI] Populated workflow select with', workflows.length, 'workflows');
                } else {
                    console.warn('[ComfyUI] No workflows available or element not found');
                }
            }
        } catch (error) {
            console.error('[ComfyUI] Failed to load workflows for select:', error);
        }
    }

    populateForm() {
        const elements = {
            'comfyUIServerUrl': this.config.serverUrl,
            'comfyUIApiKey': this.config.apiKey,
            'workflowSelect': this.config.workflow, // 新增工作流选择
            'defaultModel': this.config.defaultModel,
            'defaultWidth': this.config.defaultWidth,
            'defaultHeight': this.config.defaultHeight,
            'defaultSteps': this.config.defaultSteps,
            'defaultCfg': this.config.defaultCfg,
            'defaultSampler': this.config.defaultSampler,
            'defaultScheduler': this.config.defaultScheduler, // 新增
            'defaultSeed': this.config.defaultSeed, // 新增
            'defaultBatchSize': this.config.defaultBatchSize, // 新增
            'defaultDenoise': this.config.defaultDenoise, // 新增
            'qualityTags': this.config.qualityTags || '', // 质量词
            'negativePrompt': this.config.negativePrompt // 新增
        };

        Object.entries(elements).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) {
                element.value = value;
            }
        });
    }

    updateConfigFromForm() {
        const serverUrl = document.getElementById('comfyUIServerUrl')?.value || this.config.serverUrl;
        const apiKey = document.getElementById('comfyUIApiKey')?.value || '';
        
        this.config = {
            serverUrl,
            apiKey,
            workflow: document.getElementById('workflowSelect')?.value || this.config.workflow, // 新增
            defaultModel: document.getElementById('defaultModel')?.value || this.config.defaultModel,
            defaultWidth: parseInt(document.getElementById('defaultWidth')?.value) || this.config.defaultWidth,
            defaultHeight: parseInt(document.getElementById('defaultHeight')?.value) || this.config.defaultHeight,
            defaultSteps: parseInt(document.getElementById('defaultSteps')?.value) || this.config.defaultSteps,
            defaultCfg: parseFloat(document.getElementById('defaultCfg')?.value) || this.config.defaultCfg,
            defaultSampler: document.getElementById('defaultSampler')?.value || this.config.defaultSampler,
            defaultScheduler: document.getElementById('defaultScheduler')?.value || this.config.defaultScheduler, // 新增
            defaultSeed: parseInt(document.getElementById('defaultSeed')?.value) || this.config.defaultSeed, // 新增
            defaultBatchSize: parseInt(document.getElementById('defaultBatchSize')?.value) || this.config.defaultBatchSize, // 新增
            defaultDenoise: parseFloat(document.getElementById('defaultDenoise')?.value) || this.config.defaultDenoise, // 新增
            qualityTags: document.getElementById('qualityTags')?.value || this.config.qualityTags || '', // 质量词
            negativePrompt: document.getElementById('negativePrompt')?.value || this.config.negativePrompt, // 新增
            loras: this.config.loras || [], // 保持当前的LoRA配置
            version: '1.0.0',
            lastUpdated: new Date().toISOString()
        };
    }

    async testConnection() {
        const testBtn = document.getElementById('testConnectionBtn');
        const statusText = document.querySelector('#comfyUIConnectionStatus .status-text');
        const statusIndicator = document.querySelector('#comfyUIConnectionStatus .status-indicator');
        
        if (testBtn) testBtn.disabled = true;
        if (statusText) statusText.textContent = '测试中...';
        
        try {
            this.updateConfigFromForm();
            const response = await fetch(`${this.config.serverUrl}/system_stats`, {
                method: 'GET',
                headers: this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {},
                timeout: 5000
            });
            
            if (response.ok) {
                this.isConnected = true;
                if (statusText) statusText.textContent = '已连接';
                if (statusIndicator) {
                    statusIndicator.classList.remove('offline');
                    statusIndicator.classList.add('online');
                }
                await this.loadAvailableModels();
            } else {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (error) {
            this.isConnected = false;
            if (statusText) statusText.textContent = `连接失败: ${error.message}`;
            if (statusIndicator) {
                statusIndicator.classList.remove('online');
                statusIndicator.classList.add('offline');
            }
        } finally {
            if (testBtn) testBtn.disabled = false;
        }
    }

    async loadAvailableModels() {
        try {
            const response = await fetch(`${this.config.serverUrl}/object_info`, {
                headers: this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {}
            });
            
            if (response.ok) {
                const data = await response.json();
                this.updateModelOptions(data);
                this.updateLoraOptions(data); // 同时加载LoRA选项
            }
        } catch (error) {
            console.warn('Failed to load available models:', error);
        }
    }

    updateModelOptions(objectInfo) {
        const modelSelect = document.getElementById('defaultModel');
        if (!modelSelect || !objectInfo) return;

        // Extract checkpoint models
        const checkpoints = objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
        
        if (checkpoints.length > 0) {
            // Clear existing options except first few defaults
            const currentValue = modelSelect.value;
            modelSelect.innerHTML = '';
            
            checkpoints.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                if (model === currentValue) {
                    option.selected = true;
                }
                modelSelect.appendChild(option);
            });
        }
    }

    updateLoraOptions(objectInfo) {
        // 提取可用的LoRA模型
        const loras = objectInfo?.LoraLoader?.input?.required?.lora_name?.[0] || [];
        
        // 存储可用的LoRA列表供后续使用
        this.availableLoRA = loras;
    }

    updateConnectionStatus() {
        const statusText = document.querySelector('#comfyUIConnectionStatus .status-text');
        const statusIndicator = document.querySelector('#comfyUIConnectionStatus .status-indicator');
        
        if (statusText && statusIndicator) {
            if (this.isConnected) {
                statusText.textContent = '已连接';
                statusIndicator.classList.remove('offline');
                statusIndicator.classList.add('online');
            } else {
                statusText.textContent = '未连接';
                statusIndicator.classList.remove('online');
                statusIndicator.classList.add('offline');
            }
        }
    }

    async saveConfig() {
        this.updateConfigFromForm();
        
        try {
            // 标记正在保存，防止文件监听器重复触发
            this.isHandlingConfigChange = true;
            
            // Save to plugin settings file
            if (window.electronAPI && window.electronAPI.saveComfyUIConfig) {
                await window.electronAPI.saveComfyUIConfig(this.config);
                
                // 保存后等待一下再重新加载，避免与文件监听器冲突
                setTimeout(async () => {
                    try {
                        const savedConfig = await window.electronAPI.loadComfyUIConfig();
                        if (savedConfig) {
                            this.config = { ...this.config, ...savedConfig };
                            console.log('[ComfyUI] Config reloaded from backend after save');
                        }
                    } catch (error) {
                        console.error('[ComfyUI] Failed to reload config after save:', error);
                    } finally {
                        // 解除锁定
                        this.isHandlingConfigChange = false;
                    }
                }, 500); // 500ms 延迟
                
            } else {
                // Fallback to localStorage
                localStorage.setItem('comfyui-config', JSON.stringify(this.config));
                this.isHandlingConfigChange = false;
            }
            
            // Show success message
            this.showToast('配置已保存', 'success');
            
            // Close modal
            if (window.uiHelperFunctions) {
                window.uiHelperFunctions.closeModal('comfyUIConfigModal');
            }
        } catch (error) {
            console.error('Failed to save ComfyUI config:', error);
            this.showToast('保存配置失败', 'error');
            this.isHandlingConfigChange = false;
        }
    }

    // 更新为异步方法，直接从后端加载
    async loadConfig() {
        try {
            // 直接从后端读取配置
            if (window.electronAPI && window.electronAPI.loadComfyUIConfig) {
                const config = await window.electronAPI.loadComfyUIConfig();
                if (config) {
                    this.config = { ...this.config, ...config };
                    console.log('[ComfyUI] Config loaded from backend');
                }
            } else {
                // Fallback to localStorage
                const saved = localStorage.getItem('comfyui-config');
                if (saved) {
                    this.config = { ...this.config, ...JSON.parse(saved) };
                }
            }
        } catch (error) {
            console.warn('Failed to load ComfyUI config:', error);
        }
    }

    showToast(message, type = 'info') {
        try {
            // Use existing toast notification system if available
            if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                window.uiHelperFunctions.showToastNotification(message, type);
            } else if (window.uiHelperFunctions && window.uiHelperFunctions.showToast) {
                window.uiHelperFunctions.showToast(message, type);
            } else {
                // Simple fallback - create a temporary toast
                this.showFallbackToast(message, type);
            }
        } catch (error) {
            console.error('[ComfyUI] Error showing toast:', error);
            // Ultra-safe fallback
            this.showFallbackToast(message, type);
        }
    }

    showFallbackToast(message, type = 'info') {
        // Create a simple toast element
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background-color: ${type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#007bff'};
            color: white;
            padding: 12px 20px;
            border-radius: 4px;
            z-index: 10000;
            font-size: 14px;
            max-width: 300px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        `;
        toast.textContent = message;
        
        document.body.appendChild(toast);
        
        // Auto remove after 3 seconds
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 3000);
    }

    async loadAvailableWorkflows() {
        console.log('[ComfyUI] Loading workflows from backend (no cache)');
        
        // Prevent concurrent loading
        if (this.isLoading) {
            console.log('[ComfyUI] Already loading workflows, skipping...');
            return;
        }
        
        try {
            this.isLoading = true;
            
            // Create a new abort controller for this operation
            this.abortController = new AbortController();
            
            // Show loading state
            const workflowList = this.getElement('workflowList');
            if (workflowList) {
                workflowList.innerHTML = '<div class="workflow-loading">正在加载工作流...</div>';
            }
            
            if (window.electronAPI && window.electronAPI.loadComfyUIWorkflows) {
                const workflows = await this.callWithTimeout(
                    () => window.electronAPI.loadComfyUIWorkflows(),
                    5000, // 5 second timeout
                    this.abortController.signal
                );
                
                // Check if operation was cancelled
                if (this.abortController.signal.aborted) {
                    console.log('[ComfyUI] Workflow loading was cancelled');
                    return;
                }
                
                // 直接更新界面，不缓存结果
                this.updateWorkflowList(workflows);
            } else {
                // If no API available, show empty state
                if (workflowList) {
                    workflowList.innerHTML = '<div class="workflow-empty">暂无工作流</div>';
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('[ComfyUI] Workflow loading was cancelled');
                return;
            }
            
            console.warn('Failed to load workflows:', error);
            const workflowList = this.getElement('workflowList');
            if (workflowList) {
                workflowList.innerHTML = '<div class="workflow-error">加载工作流失败</div>';
            }
        } finally {
            this.isLoading = false;
            this.abortController = null;
        }
    }

    async callWithTimeout(fn, timeout, signal) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Operation timed out'));
            }, timeout);
            
            // Handle abort signal
            if (signal) {
                signal.addEventListener('abort', () => {
                    clearTimeout(timeoutId);
                    reject(new DOMException('Operation was aborted', 'AbortError'));
                });
            }
            
            fn().then(
                result => {
                    clearTimeout(timeoutId);
                    resolve(result);
                },
                error => {
                    clearTimeout(timeoutId);
                    reject(error);
                }
            );
        });
    }

    updateWorkflowList(workflows) {
        const workflowList = document.getElementById('workflowList');
        if (!workflowList) return;
        
        // Check if we were cancelled
        if (this.abortController && this.abortController.signal.aborted) {
            console.log('[ComfyUI] Workflow list update cancelled');
            return;
        }
        
        if (!workflows || workflows.length === 0) {
            workflowList.innerHTML = '<div class="workflow-empty">暂无工作流</div>';
            return;
        }
        
        workflowList.innerHTML = '';
        
        workflows.forEach(workflow => {
            // Double-check if we were cancelled during iteration
            if (this.abortController && this.abortController.signal.aborted) {
                return;
            }
            
            const workflowItem = document.createElement('div');
            workflowItem.className = 'workflow-item';
            workflowItem.innerHTML = `
                <span class="workflow-name">${workflow.displayName || workflow.name}</span>
                <div class="workflow-actions">
                    <button class="small-button" onclick="window.comfyUIConfigManager.viewWorkflow('${workflow.name}')">查看</button>
                    <button class="small-button" onclick="window.comfyUIConfigManager.editWorkflow('${workflow.name}')">编辑</button>
                    ${workflow.isCustom ? `<button class="small-button danger" onclick="window.comfyUIConfigManager.deleteWorkflow('${workflow.name}')">删除</button>` : ''}
                </div>
            `;
            workflowList.appendChild(workflowItem);
        });
    }

    async viewWorkflow(workflowName) {
        try {
            if (window.electronAPI && window.electronAPI.loadWorkflowContent) {
                const content = await window.electronAPI.loadWorkflowContent(workflowName);
                this.showWorkflowEditor(workflowName, content, true); // readonly
            }
        } catch (error) {
            this.showToast('加载工作流失败', 'error');
            console.error('Failed to view workflow:', error);
        }
    }

    async editWorkflow(workflowName) {
        try {
            if (window.electronAPI && window.electronAPI.loadWorkflowContent) {
                const content = await window.electronAPI.loadWorkflowContent(workflowName);
                this.showWorkflowEditor(workflowName, content, false); // editable
            }
        } catch (error) {
            this.showToast('加载工作流失败', 'error');
            console.error('Failed to edit workflow:', error);
        }
    }

    showWorkflowEditor(workflowName, content, readonly = false) {
        // Remove existing editor if any
        const existingEditor = document.getElementById('workflowEditorModal');
        if (existingEditor) {
            existingEditor.remove();
        }

        // Create a simple workflow editor modal
        const editorModal = document.createElement('div');
        editorModal.className = 'modal';
        editorModal.id = 'workflowEditorModal';
        editorModal.innerHTML = `
            <div class="modal-content" style="max-width: 800px; max-height: 600px;">
                <span class="close-button" onclick="this.parentElement.parentElement.remove()">&times;</span>
                <h2>${readonly ? '查看' : '编辑'}工作流: ${workflowName}</h2>
                <textarea id="workflowContent" style="width: 100%; height: 400px; font-family: monospace; font-size: 0.9em;" ${readonly ? 'readonly' : ''}>${JSON.stringify(content, null, 2)}</textarea>
                ${!readonly ? `
                <div class="form-actions" style="margin-top: 15px;">
                    <button type="button" id="saveWorkflowBtn" class="sidebar-button" style="background-color: var(--user-bubble-bg); color: white;">保存</button>
                    <button type="button" onclick="this.parentElement.parentElement.parentElement.remove()" class="sidebar-button">取消</button>
                </div>
                ` : `
                <div class="form-actions" style="margin-top: 15px;">
                    <button type="button" onclick="this.parentElement.parentElement.parentElement.remove()" class="sidebar-button">关闭</button>
                </div>
                `}
            </div>
        `;
        
        document.body.appendChild(editorModal);
        editorModal.style.display = 'flex';
        
        // Handle ESC key to close
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                editorModal.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
        
        // Add save functionality if not readonly
        if (!readonly) {
            const saveBtn = document.getElementById('saveWorkflowBtn');
            if (saveBtn) {
                saveBtn.addEventListener('click', async () => {
                    await this.saveWorkflowFromEditor(workflowName, editorModal, handleEscape);
                });
            }
        }
    }

    async saveWorkflowFromEditor(workflowName, editorModal, handleEscape) {
        const content = document.getElementById('workflowContent').value;
        const saveBtn = document.getElementById('saveWorkflowBtn');
        const originalText = saveBtn.textContent;
        
        try {
            // Disable save button
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中...';
            
            const workflowData = JSON.parse(content);
            if (window.electronAPI && window.electronAPI.saveWorkflowContent) {
                const result = await window.electronAPI.saveWorkflowContent(workflowName, workflowData);
                if (result.success) {
                    this.showToast('工作流保存成功', 'success');
                    document.removeEventListener('keydown', handleEscape);
                    editorModal.remove();
                    await this.loadAvailableWorkflows(); // Refresh list
                } else {
                    this.showToast(`保存失败: ${result.error}`, 'error');
                    saveBtn.disabled = false;
                    saveBtn.textContent = originalText;
                }
            }
        } catch (error) {
            if (error instanceof SyntaxError) {
                this.showToast('保存失败: JSON格式错误', 'error');
            } else {
                this.showToast('保存失败: 系统错误', 'error');
            }
            console.error('Failed to save workflow:', error);
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
        }
    }

    async deleteWorkflow(workflowName) {
        if (confirm(`确定要删除工作流 "${workflowName}" 吗？此操作不可恢复。`)) {
            try {
                if (window.electronAPI && window.electronAPI.deleteWorkflow) {
                    await window.electronAPI.deleteWorkflow(workflowName);
                    this.showToast('工作流已删除', 'success');
                    await this.loadAvailableWorkflows(); // Refresh list
                }
            } catch (error) {
                this.showToast('删除失败', 'error');
                console.error('Failed to delete workflow:', error);
            }
        }
    }

    showAddWorkflowDialog() {
        // Use the same modal pattern as the main interface
        let dialog = this.getElement('addWorkflowModal', false); // Don't cache modal elements
        if (!dialog) {
            // Create the modal once and reuse it
            dialog = this.createAddWorkflowModal();
        }
        
        // Reset form state
        this.resetAddWorkflowForm();
        
        // Add to modal stack for proper cleanup
        if (!this.modalStack.includes('addWorkflowModal')) {
            this.modalStack.push('addWorkflowModal');
        }
        
        // Use the same modal opening method as the main interface
        if (window.uiHelperFunctions) {
            window.uiHelperFunctions.openModal('addWorkflowModal');
        } else {
            dialog.classList.add('active');
        }
        
        // Focus on input field
        setTimeout(() => {
            const nameInput = this.getElement('newWorkflowName');
            if (nameInput) {
                nameInput.focus();
            }
        }, 100);
    }

    createAddWorkflowModal() {
        const dialog = document.createElement('div');
        dialog.className = 'modal';
        dialog.id = 'addWorkflowModal';
        dialog.innerHTML = `
            <div class="modal-content" style="max-width: 500px;">
                <span class="close-button" onclick="window.comfyUIConfigManager.closeAddWorkflowDialog()">&times;</span>
                <h2>添加新工作流</h2>
                <form id="addWorkflowForm">
                    <div class="form-group">
                        <label for="newWorkflowName">工作流名称:</label>
                        <input type="text" id="newWorkflowName" placeholder="输入工作流名称" required maxlength="50">
                        <small style="color: var(--secondary-text); font-size: 0.8em;">只能包含字母、数字、下划线、中横线和中文</small>
                    </div>
                    <div class="form-group">
                        <label for="workflowTemplate">基于模板:</label>
                        <select id="workflowTemplate">
                            <option value="text2img_basic">文本到图像 (基础)</option>
                            <option value="img2img_basic">图像到图像 (基础)</option>
                            <option value="empty">空白工作流</option>
                        </select>
                    </div>
                    <div class="form-actions" style="margin-top: 20px;">
                        <button type="submit" class="sidebar-button" style="background-color: var(--user-bubble-bg); color: white;">创建</button>
                        <button type="button" onclick="window.comfyUIConfigManager.closeAddWorkflowDialog()" class="sidebar-button">取消</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(dialog);
        
        // Bind form events only once
        this.bindAddWorkflowFormEvents();
        
        return dialog;
    }

    resetAddWorkflowForm() {
        const form = this.getElement('addWorkflowForm');
        if (form) {
            form.reset();
            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '创建';
            }
        }
    }

    closeAddWorkflowDialog() {
        console.log('[ComfyUI] Closing add workflow dialog...');
        
        // Remove from modal stack
        const index = this.modalStack.indexOf('addWorkflowModal');
        if (index > -1) {
            this.modalStack.splice(index, 1);
        }
        
        // Use the same modal closing method as the main interface
        if (window.uiHelperFunctions) {
            window.uiHelperFunctions.closeModal('addWorkflowModal');
        } else {
            const dialog = document.getElementById('addWorkflowModal');
            if (dialog) {
                dialog.classList.remove('active');
            }
        }
        
        // Clean up any potential loading states or pending operations
        const form = document.getElementById('addWorkflowForm');
        if (form) {
            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '创建';
            }
        }
    }

    bindAddWorkflowFormEvents() {
        const form = this.getElement('addWorkflowForm');
        if (!form) return;
        
        // Remove existing listeners to prevent duplicates
        form.removeEventListener('submit', this.boundHandlers.formSubmit);
        form.addEventListener('submit', this.boundHandlers.formSubmit);
        
        // Remove existing ESC listener
        document.removeEventListener('keydown', this.boundHandlers.escape);
        document.addEventListener('keydown', this.boundHandlers.escape);
    }

    handleEscapeKey(e) {
        if (e.key === 'Escape') {
            const modal = this.getElement('addWorkflowModal');
            if (modal && modal.classList.contains('active')) {
                this.closeAddWorkflowDialog();
            }
        }
    }

    async handleAddWorkflowSubmit(e) {
        e.preventDefault();
        
        try {
            const workflowName = document.getElementById('newWorkflowName').value.trim();
            const template = document.getElementById('workflowTemplate').value;
            
            // Validate workflow name
            if (!workflowName) {
                this.showToast('请输入工作流名称', 'error');
                const nameInput = document.getElementById('newWorkflowName');
                if (nameInput) {
                    nameInput.focus();
                }
                return;
            }
            
            // Validate workflow name format
            if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$/.test(workflowName)) {
                this.showToast('工作流名称只能包含字母、数字、下划线、中横线和中文', 'error');
                const nameInput = document.getElementById('newWorkflowName');
                if (nameInput) {
                    nameInput.focus();
                    nameInput.select();
                }
                return;
            }
            
            const submitBtn = e.target.querySelector('button[type="submit"]');
            const originalText = submitBtn.textContent;
            
            // Disable submit button to prevent double submission
            submitBtn.disabled = true;
            submitBtn.textContent = '创建中...';
            
            try {
                const success = await this.createNewWorkflow(workflowName, template);
                
                if (success) {
                    this.closeAddWorkflowDialog();
                } else {
                    // Re-enable button if creation failed
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;
                }
            } catch (workflowError) {
                console.error('Error creating workflow:', workflowError);
                this.showToast('创建工作流时发生错误', 'error');
                
                // Re-enable button
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        } catch (formError) {
            console.error('Error in form submission handler:', formError);
            this.showToast('表单处理时发生错误', 'error');
        }
    }

    async createNewWorkflow(workflowName, templateType) {
        try {
            console.log(`[ComfyUI] Creating new workflow: ${workflowName} with template: ${templateType}`);
            
            if (!window.electronAPI) {
                throw new Error('electronAPI 不可用');
            }
            
            if (!window.electronAPI.createNewWorkflow) {
                throw new Error('createNewWorkflow API 不可用');
            }
            
            const result = await window.electronAPI.createNewWorkflow(workflowName, templateType);
            console.log('[ComfyUI] Create workflow result:', result);
            
            if (result && result.success) {
                this.showToast('工作流创建成功', 'success');
                
                // 直接重新加载工作流列表，不缓存
                const modal = this.getElement('comfyUIConfigModal');
                if (modal && modal.style.display !== 'none' && !this.abortController?.signal.aborted) {
                    await this.loadAvailableWorkflows(); // 直接从后端加载
                }
                return true;
            } else {
                const errorMsg = (result && result.error) ? result.error : '未知错误';
                this.showToast(`创建失败: ${errorMsg}`, 'error');
                return false;
            }
        } catch (error) {
            console.error('Failed to create workflow:', error);
            
            // Provide more specific error messages
            if (error.message.includes('electronAPI')) {
                this.showToast('系统错误：无法访问后端API', 'error');
            } else if (error.message.includes('网络')) {
                this.showToast('网络错误：请检查VCPToolBox服务器连接', 'error');
            } else {
                this.showToast(`创建工作流失败: ${error.message || '未知错误'}`, 'error');
            }
            return false;
        }
    }

    // Public API for other modules
    getConfig() {
        return { ...this.config };
    }

    isConnectionActive() {
        return this.isConnected;
    }

    // Resource cleanup method
    destroy() {
        
        // Cancel any ongoing operations
        this.cancelOngoingOperations();
        
        // Close all modals
        this.closeAllChildModals();
        
        // Remove event listeners
        document.removeEventListener('keydown', this.boundHandlers.escape);
        
        // Clear DOM cache only
        this.clearDOMCache();
        
        // Remove from DOM if exists
        const addWorkflowModal = document.getElementById('addWorkflowModal');
        if (addWorkflowModal) {
            addWorkflowModal.remove();
        }
        
        // Clear instance
        ComfyUIConfigManager.instance = null;
    }

    // 工作流验证方法
    async validateWorkflowJson() {
        const workflowJsonTextarea = document.getElementById('workflowJson');
        const resultDiv = document.getElementById('importResult');
        
        if (!workflowJsonTextarea || !resultDiv) return;
        
        const jsonContent = workflowJsonTextarea.value.trim();
        if (!jsonContent) {
            this.showImportResult('error', '请先粘贴工作流JSON内容');
            return;
        }
        
        try {
            // 解析JSON
            const workflowData = JSON.parse(jsonContent);
            
            // 验证是否为有效的ComfyUI工作流
            if (!workflowData || typeof workflowData !== 'object') {
                throw new Error('无效的JSON格式');
            }
            
            // 检查是否包含ComfyUI节点结构
            const nodeCount = Object.keys(workflowData).length;
            let hasComfyUINodes = false;
            
            for (const [key, node] of Object.entries(workflowData)) {
                if (node && node.class_type && node.inputs) {
                    hasComfyUINodes = true;
                    break;
                }
            }
            
            if (!hasComfyUINodes) {
                throw new Error('不是有效的ComfyUI工作流格式');
            }
            
            // 使用electron API验证模板
            const validation = await window.electronAPI.validateWorkflowTemplate(workflowData);
            
            if (validation.success) {
                const message = `✅ 工作流验证通过！\n` +
                               `- 节点数量: ${nodeCount}\n` +
                               `- 已包含占位符: ${validation.placeholders.length}\n` +
                               `- 是否为模板: ${validation.isTemplate ? '是' : '否'}`;
                
                this.showImportResult('success', message);
            } else {
                throw new Error(validation.error || '验证失败');
            }
            
        } catch (error) {
            console.error('[ComfyUI] Workflow validation failed:', error);
            this.showImportResult('error', `验证失败: ${error.message}`);
        }
    }

    // 转换并保存工作流
    async convertAndSaveWorkflow() {
        const workflowNameInput = document.getElementById('workflowName');
        const workflowJsonTextarea = document.getElementById('workflowJson');
        
        if (!workflowNameInput || !workflowJsonTextarea) return;
        
        const workflowName = workflowNameInput.value.trim();
        const jsonContent = workflowJsonTextarea.value.trim();
        
        if (!workflowName) {
            this.showImportResult('error', '请输入工作流名称');
            return;
        }
        
        if (!jsonContent) {
            this.showImportResult('error', '请先粘贴工作流JSON内容');
            return;
        }
        
        try {
            // 解析JSON
            const workflowData = JSON.parse(jsonContent);
            
            // 调用electron API转换并保存
            const result = await window.electronAPI.importAndConvertWorkflow(workflowData, workflowName);
            
            if (result.success) {
                this.showImportResult('success', `✅ ${result.message}`);
                
                // 清空输入框
                workflowNameInput.value = '';
                workflowJsonTextarea.value = '';
                
                // 刷新工作流列表（如果在工作流管理标签页）
                this.loadAvailableWorkflows();
                
            } else {
                throw new Error(result.error || '转换失败');
            }
            
        } catch (error) {
            console.error('[ComfyUI] Workflow conversion failed:', error);
            this.showImportResult('error', `转换失败: ${error.message}`);
        }
    }

    // 显示导入结果
    showImportResult(type, message) {
        const resultDiv = document.getElementById('importResult');
        if (!resultDiv) return;
        
        resultDiv.style.display = 'block';
        resultDiv.className = `import-result ${type}`;
        resultDiv.innerHTML = `
            <div class="result-content">
                ${message.replace(/\n/g, '<br>')}
            </div>
        `;
        
        // 3秒后自动隐藏成功消息
        if (type === 'success') {
            setTimeout(() => {
                resultDiv.style.display = 'none';
            }, 3000);
        }
    }

    // LoRA管理功能
    populateLoraList() {
        const loraList = document.getElementById('loraList');
        if (!loraList) return;
        
        const loras = this.config.loras || [];
        loraList.innerHTML = '';
        
        if (loras.length === 0) {
            loraList.innerHTML = '<div class="lora-empty">暂无LoRA配置</div>';
            return;
        }
        
        loras.forEach((lora, index) => {
            const loraItem = this.createLoraItem(lora, index);
            loraList.appendChild(loraItem);
        });
    }
    
    createLoraItem(lora, index) {
        const loraItem = document.createElement('div');
        loraItem.className = 'lora-item';
        loraItem.dataset.index = index;
        
        loraItem.innerHTML = `
            <div class="lora-header">
                <div class="lora-name-display">${lora.name || '未命名LoRA'}</div>
                <div class="lora-actions">
                    <label class="lora-enabled">
                        <input type="checkbox" ${lora.enabled ? 'checked' : ''} 
                               onchange="window.comfyUIConfigManager.updateLoraProperty(${index}, 'enabled', this.checked)">
                        启用
                    </label>
                    <button class="small-button danger" onclick="window.comfyUIConfigManager.removeLoraItem(${index})">删除</button>
                </div>
            </div>
            <div class="lora-controls">
                <div class="lora-control">
                    <label>模型强度:</label>
                    <input type="number" class="lora-strength" min="0" max="2" step="0.1" value="${lora.strength || 1.0}"
                           onchange="window.comfyUIConfigManager.updateLoraProperty(${index}, 'strength', parseFloat(this.value))">
                </div>
                <div class="lora-control">
                    <label>CLIP强度:</label>
                    <input type="number" class="lora-clip-strength" min="0" max="2" step="0.1" value="${lora.clipStrength || 1.0}"
                           onchange="window.comfyUIConfigManager.updateLoraProperty(${index}, 'clipStrength', parseFloat(this.value))">
                </div>
            </div>
        `;
        
        return loraItem;
    }
    
    addLoraItem() {
        // 检查是否有可用的LoRA模型
        if (!this.availableLoRA || this.availableLoRA.length === 0) {
            // 检查连接状态
            if (!this.isConnected) {
                this.showToast('请先测试连接以加载可用的LoRA模型', 'warning');
            } else {
                this.showToast('未找到可用的LoRA模型，请确认ComfyUI中已安装LoRA', 'warning');
            }
            return;
        }

        // 显示LoRA选择对话框
        this.showLoraSelectionDialog();
    }

    showLoraSelectionDialog() {
        // 移除现有的对话框
        const existingDialog = document.getElementById('loraSelectionModal');
        if (existingDialog) {
            existingDialog.remove();
        }

        // 创建LoRA选择对话框
        const dialog = document.createElement('div');
        dialog.className = 'modal';
        dialog.id = 'loraSelectionModal';
        
        const loraOptions = this.availableLoRA.map(lora => 
            `<option value="${lora}">${lora}</option>`
        ).join('');

        dialog.innerHTML = `
            <div class="modal-content" style="max-width: 500px;">
                <span class="close-button" onclick="this.parentElement.parentElement.remove()">&times;</span>
                <h2>选择LoRA模型</h2>
                <div class="form-group">
                    <label for="loraModelSelect">可用的LoRA模型:</label>
                    <select id="loraModelSelect" size="8" style="height: 200px;">
                        ${loraOptions}
                    </select>
                    <small>从ComfyUI服务器加载的可用LoRA模型列表</small>
                </div>
                <div class="form-group">
                    <label for="loraStrengthInput">模型强度:</label>
                    <input type="number" id="loraStrengthInput" min="0" max="2" step="0.1" value="1.0">
                </div>
                <div class="form-group">
                    <label for="loraClipStrengthInput">CLIP强度:</label>
                    <input type="number" id="loraClipStrengthInput" min="0" max="2" step="0.1" value="1.0">
                </div>
                <div class="form-actions" style="margin-top: 20px;">
                    <button type="button" id="addSelectedLoraBtn" class="sidebar-button" style="background-color: var(--user-bubble-bg); color: white;">添加LoRA</button>
                    <button type="button" onclick="this.parentElement.parentElement.parentElement.remove()" class="sidebar-button">取消</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        dialog.style.display = 'flex';
        
        // 绑定添加按钮事件
        const addBtn = document.getElementById('addSelectedLoraBtn');
        if (addBtn) {
            addBtn.addEventListener('click', () => this.addSelectedLora(dialog));
        }

        // ESC键关闭
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                dialog.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
    }

    addSelectedLora(dialog) {
        const selectElement = document.getElementById('loraModelSelect');
        const strengthInput = document.getElementById('loraStrengthInput');
        const clipStrengthInput = document.getElementById('loraClipStrengthInput');
        
        if (!selectElement.value) {
            this.showToast('请选择一个LoRA模型', 'warning');
            return;
        }

        if (!this.config.loras) {
            this.config.loras = [];
        }
        
        // 检查是否已经存在相同的LoRA
        const existingLora = this.config.loras.find(lora => lora.name === selectElement.value);
        if (existingLora) {
            this.showToast('该LoRA已存在于列表中', 'warning');
            return;
        }

        const newLora = {
            name: selectElement.value,
            strength: parseFloat(strengthInput.value) || 1.0,
            clipStrength: parseFloat(clipStrengthInput.value) || 1.0,
            enabled: true
        };
        
        this.config.loras.push(newLora);
        this.populateLoraList();
        
        // 关闭对话框
        dialog.remove();
        
        this.showToast('LoRA已添加', 'success');
    }
    
    removeLoraItem(index) {
        if (!this.config.loras || index < 0 || index >= this.config.loras.length) {
            return;
        }
        
        if (confirm('确定要删除这个LoRA配置吗？')) {
            this.config.loras.splice(index, 1);
            this.populateLoraList();
        }
    }
    
    updateLoraProperty(index, property, value) {
        if (!this.config.loras || index < 0 || index >= this.config.loras.length) {
            return;
        }
        
        this.config.loras[index][property] = value;
    }
}

    // Initialize the ComfyUI Configuration Manager (Singleton)
    window.comfyUIConfigManager = ComfyUIConfigManager.getInstance();
    
})(); // End of IIFE (Immediately Invoked Function Expression)