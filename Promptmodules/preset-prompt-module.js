// Promptmodules/preset-prompt-module.js
// 临时与预制系统提示词模块

class PresetPromptModule {
    constructor(options) {
        this.electronAPI = options.electronAPI;
        this.agentId = null;
        this.config = null;
        this.contextVersion = 0;
        
        this.textarea = null;
        this.presetSelect = null;
        this.presetPath = null;
        this.presets = [];
        
        // 缓存内容数据
        this.cachedContent = '';
        this.cachedSelectedPreset = '';
        
        // 默认预设路径
        this.defaultPresetPath = './AppData/systemPromptPresets';
    }

    /**
     * 更新上下文并加载数据
     * @param {string} agentId 
     * @param {Object} config 
     */
    async updateContext(agentId, config) {
        const contextVersion = ++this.contextVersion;
        this.agentId = agentId;
        this.config = config;
        this.cachedContent = config.presetSystemPrompt || '';
        this.cachedSelectedPreset = config.selectedPreset || '';
        this.presetPath = this.config.presetPromptPath || this.defaultPresetPath;
        await this.loadPresets();
        return contextVersion === this.contextVersion && this.agentId === agentId;
    }

    /**
     * 加载预设路径
     */
    async loadPresetPath() {
        this.presetPath = this.config.presetPromptPath || this.defaultPresetPath;
        await this.loadPresets();
    }

    /**
     * 加载预设列表
     */
    async loadPresets() {
        try {
            const result = await this.electronAPI.loadPresetPrompts(this.presetPath);
            if (result.success) {
                this.presets = result.presets || [];
            } else {
                console.error('Failed to load presets:', result.error);
                this.presets = [];
            }
        } catch (error) {
            console.error('Error loading presets:', error);
            this.presets = [];
        }
    }

    /**
     * 渲染模块UI
     */
    async render(container) {
        container.innerHTML = '';
        container.classList.add('preset-prompt-container');

        // 重新加载预设列表（修复初始化问题）
        await this.loadPresets();

        // 预设路径设置
        const pathSection = this.createPathSection();
        container.appendChild(pathSection);

        // 预设选择器
        const presetSection = this.createPresetSelector();
        container.appendChild(presetSection);

        // 内容编辑区
        const editorSection = this.createEditor();
        container.appendChild(editorSection);
    }

    /**
     * 创建路径设置区域
     */
    createPathSection() {
        const section = document.createElement('div');
        section.className = 'preset-path-section';

        const header = document.createElement('div');
        header.className = 'preset-path-header';

        const label = document.createElement('label');
        label.className = 'preset-section-label';
        label.textContent = '预设文件夹路径:';
        header.appendChild(label);

        const actions = document.createElement('div');
        actions.className = 'preset-path-actions';

        const pathInput = document.createElement('input');
        pathInput.type = 'text';
        pathInput.className = 'preset-path-input';
        pathInput.value = this.presetPath || this.defaultPresetPath;
        pathInput.placeholder = '例如: ./AppData/systemPromptPresets';

        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.className = 'preset-browse-btn';
        browseBtn.title = '浏览文件夹';
        browseBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>浏览</span>';
        browseBtn.onclick = async () => {
            const result = await this.electronAPI.selectDirectory();
            if (result.success && result.path) {
                pathInput.value = result.path;
                this.presetPath = result.path;
                await this.savePresetPath();
                await this.loadPresets();
                this.updatePresetSelector();
            }
        };
        actions.appendChild(browseBtn);

        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'preset-refresh-btn';
        refreshBtn.title = '刷新预设列表';
        refreshBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
        refreshBtn.onclick = async () => {
            this.presetPath = pathInput.value;
            await this.savePresetPath();
            await this.loadPresets();
            this.updatePresetSelector();
        };
        actions.appendChild(refreshBtn);

        header.appendChild(actions);
        section.appendChild(header);

        const pathContainer = document.createElement('div');
        pathContainer.className = 'path-input-container';
        pathContainer.appendChild(pathInput);
        section.appendChild(pathContainer);

        return section;
    }

    /**
     * 创建预设选择器
     */
    createPresetSelector() {
        const section = document.createElement('div');
        section.className = 'preset-selector-section';

        const label = document.createElement('label');
        label.textContent = '选择预设:';
        section.appendChild(label);

        this.presetSelect = document.createElement('select');
        this.presetSelect.className = 'preset-select';
        
        // 添加默认选项
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- 不使用预设 --';
        this.presetSelect.appendChild(defaultOption);

        // 添加预设选项
        this.presets.forEach(preset => {
            const option = document.createElement('option');
            option.value = preset.path;
            option.textContent = preset.name;
            this.presetSelect.appendChild(option);
        });

        // 恢复之前选择的预设（使用缓存）
        if (this.cachedSelectedPreset) {
            this.presetSelect.value = this.cachedSelectedPreset;
        }

        this.presetSelect.onchange = async () => {
            const targetAgentId = this.agentId;
            const loaded = await this.loadSelectedPreset();
            // 只有预设确实加载到原上下文后才触发保存；显式 ID 也会由 SettingsManager
            // 与当前表单上下文复核，旧回调无法把新表单写回旧 Agent。
            if (
                loaded !== false &&
                window.settingsManager &&
                typeof window.settingsManager.triggerAgentSave === 'function'
            ) {
                await window.settingsManager.triggerAgentSave(targetAgentId);
            }
        };

        const selectWrap = document.createElement('div');
        selectWrap.className = 'preset-select-wrapper';
        selectWrap.appendChild(this.presetSelect);
        section.appendChild(selectWrap);
        return section;
    }

    /**
     * 更新预设选择器
     */
    updatePresetSelector() {
        if (!this.presetSelect) return;

        // 保存当前选择
        const currentValue = this.presetSelect.value;

        // 清空并重建选项
        this.presetSelect.innerHTML = '';

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- 不使用预设 --';
        this.presetSelect.appendChild(defaultOption);

        this.presets.forEach(preset => {
            const option = document.createElement('option');
            option.value = preset.path;
            option.textContent = preset.name;
            this.presetSelect.appendChild(option);
        });

        // 恢复选择
        this.presetSelect.value = currentValue;
    }

    /**
     * 创建编辑器
     */
    createEditor() {
        const section = document.createElement('div');
        section.className = 'preset-editor-section';

        const label = document.createElement('label');
        label.textContent = '系统提示词 (可使用 {{AgentName}} 占位符):';
        section.appendChild(label);

        this.textarea = document.createElement('textarea');
        this.textarea.className = 'prompt-textarea preset-prompt-textarea';
        this.textarea.placeholder = '请输入系统提示词或选择预设...';
        this.textarea.value = this.cachedContent;
        this.textarea.rows = 3;

        // 添加输入事件监听器
        this.textarea.addEventListener('input', () => {
            this.autoResize();
        });

        section.appendChild(this.textarea);

        // 使用setTimeout确保DOM渲染完成后再调整大小
        setTimeout(() => {
            this.autoResize();
        }, 0);

        return section;
    }

    /**
     * 自动调整文本域高度
     */
    autoResize() {
        if (!this.textarea) return;
        // 重置高度以获取正确的scrollHeight
        this.textarea.style.height = 'auto';
        // 设置最小高度
        const minHeight = 60;
        // 根据内容设置高度，但不小于最小高度
        const newHeight = Math.max(minHeight, this.textarea.scrollHeight);
        this.textarea.style.height = newHeight + 'px';
    }

    /**
     * 加载选中的预设
     */
    async loadSelectedPreset() {
        const targetAgentId = this.agentId;
        const contextVersion = this.contextVersion;
        const presetPath = this.presetSelect.value;
        
        if (!presetPath) {
            // 不使用预设，清空内容
            if (this.textarea) {
                this.textarea.value = '';
                this.autoResize();
            }
            await this.save();
            return this.agentId === targetAgentId && this.contextVersion === contextVersion;
        }

        try {
            const result = await this.electronAPI.loadPresetContent(presetPath);
            if (this.agentId !== targetAgentId || this.contextVersion !== contextVersion) {
                console.debug(`[PresetPromptModule] Ignoring stale preset load for agent ${targetAgentId}.`);
                return false;
            }
            if (result.success && this.textarea) {
                this.textarea.value = result.content || '';
                // 使用setTimeout确保内容已渲染
                setTimeout(() => {
                    if (this.agentId === targetAgentId && this.contextVersion === contextVersion) {
                        this.autoResize();
                    }
                }, 0);
                await this.save();
                return true;
            } else {
                console.error('Failed to load preset content:', result.error);
                return false;
            }
        } catch (error) {
            console.error('Error loading preset content:', error);
            return false;
        }
    }

    /**
     * 保存预设路径
     */
    async savePresetPath() {
        await this.electronAPI.updateAgentConfig(this.agentId, {
            presetPromptPath: this.presetPath
        });
    }

    /**
     * 保存数据
     */
    async save() {
        if (!this.textarea) return;

        // 在调用 IPC 前冻结目标与数据，后续上下文切换不会改变本次写入归属。
        const targetAgentId = this.agentId;
        if (!targetAgentId) return;
        const content = this.textarea.value.trim();
        const selectedPreset = this.presetSelect ? this.presetSelect.value : '';

        // 更新缓存
        this.cachedContent = content;
        this.cachedSelectedPreset = selectedPreset;

        await this.electronAPI.updateAgentConfig(targetAgentId, {
            presetSystemPrompt: content,
            selectedPreset: selectedPreset
        });
    }

    /**
     * 获取提示词内容
     */
  async getPrompt() {
    if (this.textarea) {
      return this.textarea.value.trim();
    }
    return this.cachedContent;
  }

  /**
   * 销毁模块，释放资源
   */
  destroy() {
    this.textarea = null;
    this.presetSelect = null;
    this.container = null;
  }
}

// 导出到全局
window.PresetPromptModule = PresetPromptModule;
