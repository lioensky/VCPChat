// ComfyUI UI Manager Module
(function() {
    'use strict';

    class ComfyUI_UIManager {
        constructor() {
            if (ComfyUI_UIManager.instance) {
                return ComfyUI_UIManager.instance;
            }
            this.domCache = new Map();
            this.modalStack = [];
            ComfyUI_UIManager.instance = this;
        }

        static getInstance() {
            if (!ComfyUI_UIManager.instance) {
                ComfyUI_UIManager.instance = new ComfyUI_UIManager();
            }
            return ComfyUI_UIManager.instance;
        }

        // --- DOM Utilities ---
        getElement(id, useCache = true) {
            if (useCache && this.domCache.has(id)) {
                const cached = this.domCache.get(id);
                if (cached && document.contains(cached)) {
                    return cached;
                }
                this.domCache.delete(id);
            }
            const element = document.getElementById(id);
            if (element && useCache) {
                this.domCache.set(id, element);
            }
            return element;
        }

        clearDOMCache() {
            this.domCache.clear();
        }

        // --- Event Registration ---
        register(idOrSelector, event, handler, opts = {}) {
            const node = typeof idOrSelector === 'string' ? this.getElement(idOrSelector) : idOrSelector;
            if (!node) return null;
            const clone = node.cloneNode(true);
            node.parentNode.replaceChild(clone, node);
            clone.addEventListener(event, handler, opts);
            return clone;
        }

        registerAll(selector, event, handler, opts = {}) {
            const nodes = Array.from(document.querySelectorAll(selector));
            return nodes.map(n => this.register(n, event, handler, opts));
        }

        // --- Toast Notifications ---
        showToast(message, type = 'info') {
            try {
                if (window.uiHelperFunctions?.showToastNotification) {
                    window.uiHelperFunctions.showToastNotification(message, type);
                } else if (window.uiHelperFunctions?.showToast) {
                    window.uiHelperFunctions.showToast(message, type);
                } else {
                    this.showFallbackToast(message, type);
                }
            } catch (error) {
                console.error('[ComfyUI UI] Error showing toast:', error);
                this.showFallbackToast(message, type);
            }
        }

        showFallbackToast(message, type = 'info') {
            const toast = document.createElement('div');
            toast.style.cssText = `
                position: fixed; top: 20px; right: 20px;
                background-color: ${type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#007bff'};
                color: white; padding: 12px 20px; border-radius: 4px; z-index: 10000;
                font-size: 14px; max-width: 300px; box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            `;
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 3000);
        }

        // --- Modal Management ---
        openModal(modalId) {
            if (window.uiHelperFunctions) {
                window.uiHelperFunctions.openModal(modalId);
            } else {
                const modal = this.getElement(modalId);
                if (modal) modal.classList.add('active');
            }
            if (!this.modalStack.includes(modalId)) {
                this.modalStack.push(modalId);
            }
        }

        closeModal(modalId) {
            if (window.uiHelperFunctions) {
                window.uiHelperFunctions.closeModal(modalId);
            } else {
                const modal = this.getElement(modalId);
                if (modal) modal.classList.remove('active');
            }
            const index = this.modalStack.indexOf(modalId);
            if (index > -1) {
                this.modalStack.splice(index, 1);
            }
        }

        closeAllModals() {
            while (this.modalStack.length > 0) {
                const modalId = this.modalStack.pop();
                this.closeModal(modalId);
            }
        }
        
        // --- UI Updates ---
        updateConnectionStatus(isConnected) {
            const statusText = this.getElement('comfyUIConnectionStatus')?.querySelector('.status-text');
            const statusIndicator = this.getElement('comfyUIConnectionStatus')?.querySelector('.status-indicator');
            if (statusText && statusIndicator) {
                statusText.textContent = isConnected ? '已连接' : '未连接';
                statusIndicator.classList.toggle('online', isConnected);
                statusIndicator.classList.toggle('offline', !isConnected);
            }
        }
        
        setTestConnectionButtonState(enabled, text = '测试连接') {
            const testBtn = this.getElement('testConnectionBtn');
            if (testBtn) {
                testBtn.disabled = !enabled;
                testBtn.textContent = text;
            }
        }

        // --- UI Generation and Population ---
        generateModalContent(coordinator) {
            const modal = this.getElement('comfyUIConfigModal');
            if (!modal) {
                console.error('[ComfyUI UI] Modal element not found');
                return;
            }

            const modalContent = modal.querySelector('.modal-content');
            if (!modalContent) {
                console.error('[ComfyUI UI] Modal content element not found');
                return;
            }

            modalContent.innerHTML = `
                <span class="close-button">&times;</span>
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
                            <input type="url" id="comfyUIServerUrl" placeholder="http://localhost:8188">
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
                            <select id="workflowSelect"></select>
                            <small>选择Agent调用插件时使用的默认工作流</small>
                        </div>
                        <div class="form-group">
                            <label for="defaultModel">默认模型:</label>
                            <select id="defaultModel"></select>
                        </div>
                        <div class="form-group-inline">
                            <div>
                                <label for="defaultWidth">宽度:</label>
                                <select id="defaultWidth">
                                    <option value="1024">1024px</option>
                                </select>
                            </div>
                            <div>
                                <label for="defaultHeight">高度:</label>
                                <select id="defaultHeight">
                                    <option value="1024">1024px</option>
                                </select>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>快速尺寸预设:</label>
                            <div class="preset-buttons">
                                 <button type="button" class="preset-btn" data-width="1024" data-height="1024">1:1 (1024)</button>
                            </div>
                        </div>
                        <div class="form-group-inline">
                            <div>
                                <label for="defaultSteps">采样步数:</label>
                                <input type="number" id="defaultSteps" min="1" max="150">
                            </div>
                            <div>
                                <label for="defaultCfg">CFG Scale:</label>
                                <input type="number" id="defaultCfg" min="1" max="30" step="0.5">
                            </div>
                        </div>
                         <div class="form-group-inline">
                            <div>
                                <label for="defaultSeed">随机种子:</label>
                                <input type="number" id="defaultSeed">
                                <small>-1 为随机</small>
                            </div>
                            <div>
                                <label for="defaultBatchSize">生成数量:</label>
                                <input type="number" id="defaultBatchSize" min="1" max="10">
                            </div>
                        </div>
                        <div class="form-group-inline">
                            <div>
                                <label for="defaultSampler">采样器:</label>
                                <select id="defaultSampler"></select>
                            </div>
                            <div>
                                <label for="defaultScheduler">调度器:</label>
                                <select id="defaultScheduler"></select>
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="defaultDenoise">去噪强度:</label>
                            <input type="number" id="defaultDenoise" min="0" max="1" step="0.01">
                        </div>
                    </div>
                </div>
                <div class="config-tab-content" id="promptTab">
                    <div class="config-section">
                        <h3>LoRA 管理</h3>
                        <p class="section-description">管理LoRA模型...</p>
                        <div id="loraList" class="lora-list"></div>
                        <div class="lora-add-section">
                            <button id="addLoraBtn" class="sidebar-button">+ 添加 LoRA</button>
                        </div>
                    </div>
                    <div class="config-section">
                        <h3>质量增强词</h3>
                        <div class="form-group">
                            <label for="qualityTags">质量增强词:</label>
                            <textarea id="qualityTags" rows="3"></textarea>
                        </div>
                    </div>
                    <div class="config-section">
                        <h3>负面提示词</h3>
                        <div class="form-group">
                            <label for="negativePrompt">默认负面提示词:</label>
                            <textarea id="negativePrompt" rows="4"></textarea>
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
                        <div class="form-group">
                            <label for="workflowName">工作流名称:</label>
                            <input type="text" id="workflowName" placeholder="例如: 人物肖像-高清">
                        </div>
                        <div class="form-group">
                            <label for="workflowJson">工作流JSON:</label>
                            <textarea id="workflowJson" rows="10"></textarea>
                        </div>
                        <div class="import-actions">
                            <button id="validateWorkflowBtn" class="sidebar-button">验证格式</button>
                            <button id="convertWorkflowBtn" class="sidebar-button">转换并保存</button>
                        </div>
                        <div id="importResult" class="import-result" style="display: none;"></div>
                    </div>
                </div>

                <div class="form-actions" style="margin-top: 20px;">
                    <button type="button" id="saveComfyUIConfigBtn" class="sidebar-button">保存配置</button>
                    <button type="button" id="cancelComfyUIConfigBtn" class="sidebar-button">取消</button>
                </div>
            `;

            // Bind general events
            this.register(modal.querySelector('.close-button'), 'click', () => coordinator.closeModal());
            this.registerAll('.config-tab-button', 'click', (e) => this.switchTab(e.target.dataset.tab));
            this.register('saveComfyUIConfigBtn', 'click', () => coordinator.saveConfig());
            this.register('cancelComfyUIConfigBtn', 'click', () => coordinator.closeModal());
        }

        switchTab(tabName) {
            document.querySelectorAll('.config-tab-button').forEach(btn => btn.classList.remove('active'));
            document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
            document.querySelectorAll('.config-tab-content').forEach(content => content.classList.remove('active'));
            this.getElement(`${tabName}Tab`).classList.add('active');
        }

        populateForm(config) {
            const elements = {
                'comfyUIServerUrl': config.serverUrl,
                'comfyUIApiKey': config.apiKey,
                'workflowSelect': config.workflow,
                'defaultModel': config.defaultModel,
                'defaultWidth': config.defaultWidth,
                'defaultHeight': config.defaultHeight,
                'defaultSteps': config.defaultSteps,
                'defaultCfg': config.defaultCfg,
                'defaultSampler': config.defaultSampler,
                'defaultScheduler': config.defaultScheduler,
                'defaultSeed': config.defaultSeed,
                'defaultBatchSize': config.defaultBatchSize,
                'defaultDenoise': config.defaultDenoise,
                'qualityTags': config.qualityTags || '',
                'negativePrompt': config.negativePrompt
            };

            for (const [id, value] of Object.entries(elements)) {
                const el = this.getElement(id);
                if (el && String(el.value) !== String(value)) {
                    el.value = value;
                }
            }
        }
        
        updateWorkflowList(workflows, coordinator) {
            const workflowList = this.getElement('workflowList');
            if (!workflowList) return;

            if (!workflows || workflows.length === 0) {
                workflowList.innerHTML = '<div class="workflow-empty">暂无工作流</div>';
                return;
            }

            workflowList.innerHTML = '';
            workflows.forEach(workflow => {
                const item = document.createElement('div');
                item.className = 'workflow-item';
                item.innerHTML = `
                    <span class="workflow-name">${workflow.displayName || workflow.name}</span>
                    <div class="workflow-actions">
                        <button class="small-button view-workflow">查看</button>
                        <button class="small-button edit-workflow">编辑</button>
                        ${workflow.isCustom ? `<button class="small-button danger delete-workflow">删除</button>` : ''}
                    </div>
                `;
                this.register(item.querySelector('.view-workflow'), 'click', () => coordinator.viewWorkflow(workflow.name));
                this.register(item.querySelector('.edit-workflow'), 'click', () => coordinator.editWorkflow(workflow.name));
                if (workflow.isCustom) {
                    this.register(item.querySelector('.delete-workflow'), 'click', () => coordinator.deleteWorkflow(workflow.name));
                }
                workflowList.appendChild(item);
            });
        }
        
        updateModelOptions(models, currentModel) {
            const modelSelect = this.getElement('defaultModel');
            if (!modelSelect) return;

            modelSelect.innerHTML = '';
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                if (model === currentModel) {
                    option.selected = true;
                }
                modelSelect.appendChild(option);
            });
        }
    }

    window.ComfyUI_UIManager = ComfyUI_UIManager.getInstance();
})();