// Promptmodules/prompt-manager.js
// 系统提示词管理器 - 负责三种模式的切换和数据管理

class PromptManager {
    constructor() {
        this.currentMode = 'original'; // 'original' | 'modular' | 'preset'
        this.agentId = null;
        this.config = null;

        // 模块实例
        this.originalModule = null;
        this.modularModule = null;
        this.presetModule = null;

        // 默认模式名称
        this.defaultModeNames = {
            original: '原始富文本',
            modular: '模块化',
            preset: '临时与预制'
        };

        // 自定义模式名称（从全局设置加载）
        this.customModeNames = {};

        // 右键长按计时器
        this.rightClickTimer = null;
        this.rightClickDelay = 1000; // 1秒
    }

    /**
     * 初始化提示词管理器
     * @param {Object} options - 初始化选项
     */
    async init(options) {
        const {
            agentId,
            config,
            containerElement,
            electronAPI
        } = options;

        this.agentId = agentId;
        this.config = config;
        this.containerElement = containerElement;
        this.electronAPI = electronAPI;

        // 从配置中读取当前模式
        this.currentMode = config.promptMode || 'original';

        // 加载自定义模式名称
        await this.loadCustomModeNames();

        // 初始化三个模块
        this.initModules();

        // 渲染UI
        this.render();
    }

    /**
     * 初始化三个子模块
     */
    initModules() {
        if (window.OriginalPromptModule) {
            this.originalModule = new window.OriginalPromptModule({
                agentId: this.agentId,
                config: this.config,
                electronAPI: this.electronAPI
            });
        }

        if (window.ModularPromptModule) {
            this.modularModule = new window.ModularPromptModule({
                agentId: this.agentId,
                config: this.config,
                electronAPI: this.electronAPI
            });
        }

        if (window.PresetPromptModule) {
            this.presetModule = new window.PresetPromptModule({
                agentId: this.agentId,
                config: this.config,
                electronAPI: this.electronAPI
            });
        }
    }

    /**
     * 渲染主界面
     */
    render() {
        if (!this.containerElement) return;

        // 清空容器
        this.containerElement.innerHTML = '';

        // 创建模式切换按钮区域
        const modeSelector = this.createModeSelector();
        this.containerElement.appendChild(modeSelector);

        // 创建内容容器
        const contentContainer = document.createElement('div');
        contentContainer.className = 'prompt-content-container';
        contentContainer.id = 'promptContentContainer';
        this.containerElement.appendChild(contentContainer);

        // 渲染当前模式的内容
        this.renderCurrentMode();
    }

    /**
     * 创建模式切换按钮
     */
    createModeSelector() {
        const container = document.createElement('div');
        container.className = 'prompt-mode-selector';

        const modes = [
            { id: 'original' },
            { id: 'modular' },
            { id: 'preset' }
        ];

        modes.forEach(mode => {
            const button = document.createElement('button');
            button.className = 'prompt-mode-button';
            button.dataset.mode = mode.id;
            button.innerHTML = `
                <span class="prompt-mode-button-icon" aria-hidden="true">${this.getModeIcon(mode.id)}</span>
                <span class="prompt-mode-button-label">${this.getModeName(mode.id)}</span>
            `;

            if (this.currentMode === mode.id) {
                button.classList.add('active');
            }

            // 左键单击：切换模式
            button.addEventListener('click', () => this.switchMode(mode.id));

            // 双击：进入编辑模式
            button.addEventListener('dblclick', (e) => {
                e.preventDefault();
                this.enterEditMode(button, mode.id);
            });

            // 右键长按：恢复默认名称
            button.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.startRightClickTimer(mode.id);
            });

            button.addEventListener('mouseup', (e) => {
                if (e.button === 2) { // 右键
                    this.cancelRightClickTimer();
                }
            });

            button.addEventListener('mouseleave', () => {
                this.cancelRightClickTimer();
            });

            container.appendChild(button);
        });

        return container;
    }

    /**
     * 获取模式名称（优先使用自定义名称）
     */
    getModeName(modeId) {
        return this.customModeNames[modeId] || this.defaultModeNames[modeId];
    }

    getModeIcon(modeId) {
        const icons = {
            original: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="m8 13 4-7 4 7"/><path d="M9.1 11h5.7"/></svg>`,
            modular: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"/><rect x="14" y="2" width="8" height="8" rx="1"/></svg>`,
            preset: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17h1.5"/><path d="M12 22h1.5"/><path d="M12 2h1.5"/><path d="M17.5 22H19a1 1 0 0 0 1-1"/><path d="M17.5 2H19a1 1 0 0 1 1 1v1.5"/><path d="M20 14v3h-2.5"/><path d="M20 8.5V10"/><path d="M4 10V8.5"/><path d="M4 19.5V14"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H8"/><path d="M8 22H6.5a1 1 0 0 1 0-5H8"/></svg>`
        };

        return icons[modeId] || '';
    }

    /**
     * 加载自定义模式名称
     */
    async loadCustomModeNames() {
        try {
            const settings = await this.electronAPI.loadSettings();
            if (settings && settings.promptModeCustomNames) {
                this.customModeNames = settings.promptModeCustomNames;
            }
        } catch (error) {
            console.error('[PromptManager] 加载自定义模式名称失败:', error);
        }
    }

    /**
     * 保存自定义模式名称到全局设置
     */
    async saveCustomModeNames() {
        try {
            const settings = await this.electronAPI.loadSettings();
            const newSettings = {
                ...settings,
                promptModeCustomNames: this.customModeNames
            };
            await this.electronAPI.saveSettings(newSettings);
        } catch (error) {
            console.error('[PromptManager] 保存自定义模式名称失败:', error);
        }
    }

    /**
     * 进入编辑模式
     */
    enterEditMode(button, modeId) {
        const currentName = button.textContent.trim();

        // 创建输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.className = 'prompt-mode-name-input';
        input.style.cssText = `
            width: 100%;
            height: 100%;
            border: 2px solid var(--accent-bg);
            background: var(--button-bg);
            color: var(--primary-text);
            font-size: inherit;
            font-family: inherit;
            text-align: center;
            padding: 0;
            margin: 0;
            box-sizing: border-box;
        `;

        // 替换按钮文本
        button.textContent = '';
        button.appendChild(input);
        input.focus();
        input.select();

        // 保存函数
        const saveName = async () => {
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
                // 保存新名称
                this.customModeNames[modeId] = newName;
                await this.saveCustomModeNames();
                button.textContent = newName;
            } else {
                button.textContent = currentName;
            }
            input.remove();
        };

        // 取消函数
        const cancel = () => {
            button.textContent = currentName;
            input.remove();
        };

        // 回车保存
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveName();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });

        // 失去焦点保存
        input.addEventListener('blur', saveName);
    }

    /**
     * 开始右键长按计时器
     */
    startRightClickTimer(modeId) {
        this.cancelRightClickTimer(); // 先取消之前的计时器

        this.rightClickTimer = setTimeout(async () => {
            // 恢复默认名称
            delete this.customModeNames[modeId];
            await this.saveCustomModeNames();

            // 更新UI
            const button = this.containerElement.querySelector(`.prompt-mode-button[data-mode="${modeId}"]`);
            if (button) {
                button.textContent = this.defaultModeNames[modeId];
            }

            // 显示提示
            if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                window.uiHelperFunctions.showToastNotification(`已恢复模式名称为"${this.defaultModeNames[modeId]}"`, 'success');
            }
        }, this.rightClickDelay);
    }

    /**
     * 取消右键长按计时器
     */
    cancelRightClickTimer() {
        if (this.rightClickTimer) {
            clearTimeout(this.rightClickTimer);
            this.rightClickTimer = null;
        }
    }

    /**
     * 切换模式
     * @param {string} mode - 目标模式
     */
    async switchMode(mode) {
        if (this.currentMode === mode) return;

        // 【防竞态】在切换开始时锁定agentId，防止异步操作期间用户切换Agent导致写入错误目标
        const lockedAgentId = this.agentId;

        // 1. 获取最新提示词内容
        const systemPrompt = await this.getCurrentSystemPrompt();

        // 2. 更新模式
        this.currentMode = mode;

        // 3. 执行合并保存：一次性更新模式和系统提示词，避免多次磁盘操作
        // 注意：这里我们主动更新 agentConfig 里的 promptMode 和 systemPrompt 两个关键字段
        await this.electronAPI.updateAgentConfig(lockedAgentId, {
            promptMode: mode,
            systemPrompt: systemPrompt
        });

        // 4. 更新UI
        this.updateModeButtons();
        this.renderCurrentMode();

        // 5. 偶尔可能需要触发全面保存（例如子模块有自己的特殊配置项需要同步）
        // 但我们在上面已经更新了最关键的 mode+prompt，这里可以异步进行或由子模块自行负责
        if (window.settingsManager && typeof window.settingsManager.triggerAgentSave === 'function') {
            // 注意：这里不再 await，减少阻塞感，因为关键数据已经通过 updateAgentConfig 落地了
            window.settingsManager.triggerAgentSave(lockedAgentId).catch(err => {
                console.error('[PromptManager] Trigger full save failed:', err);
            });
        }
    }

    /**
     * 更新模式按钮的激活状态
     */
    updateModeButtons() {
        const buttons = this.containerElement.querySelectorAll('.prompt-mode-button');
        buttons.forEach(button => {
            if (button.dataset.mode === this.currentMode) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });
    }

    /**
     * 渲染当前模式的内容
     */
    renderCurrentMode() {
        const contentContainer = document.getElementById('promptContentContainer');
        if (!contentContainer) return;

        contentContainer.innerHTML = '';

        switch (this.currentMode) {
            case 'original':
                if (this.originalModule) {
                    this.originalModule.render(contentContainer);
                }
                break;
            case 'modular':
                if (this.modularModule) {
                    this.modularModule.render(contentContainer);
                }
                break;
            case 'preset':
                if (this.presetModule) {
                    this.presetModule.render(contentContainer);
                }
                break;
        }
    }

    /**
     * 保存当前模式的数据
     */
    async saveCurrentModeData() {
        switch (this.currentMode) {
            case 'original':
                if (this.originalModule) {
                    await this.originalModule.save();
                }
                break;
            case 'modular':
                if (this.modularModule) {
                    await this.modularModule.save();
                }
                break;
            case 'preset':
                if (this.presetModule) {
                    await this.presetModule.save();
                }
                break;
        }
    }

    /**
     * 获取当前激活的系统提示词
     * @returns {string} 格式化后的系统提示词
     */
    async getCurrentSystemPrompt() {
        switch (this.currentMode) {
            case 'original':
                return this.originalModule ? await this.originalModule.getPrompt() : '';
            case 'modular':
                return this.modularModule ? await this.modularModule.getFormattedPrompt() : '';
            case 'preset':
                return this.presetModule ? await this.presetModule.getPrompt() : '';
            default:
                return '';
        }
    }

    /**
     * 外部接口：切换到指定模式（用于插件调用）
     * @param {string} mode - 目标模式
     */
    async setMode(mode) {
        if (['original', 'modular', 'preset'].includes(mode)) {
            await this.switchMode(mode);
        }
    }

    /**
     * 外部接口：获取当前模式
     * @returns {string} 当前模式
     */
    getMode() {
        return this.currentMode;
    }
}

// 导出到全局
window.PromptManager = PromptManager;
