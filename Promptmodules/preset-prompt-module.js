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
        this.presetLoadGeneration = 0;
        this.catalogGeneration = 0;
        this.pendingPresetLoads = new Set();
        
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
        ++this.presetLoadGeneration;
        this.textarea = null;
        this.presetSelect = null;
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
        const version = this.contextVersion;
        const generation = ++this.catalogGeneration;
        const presetPath = this.presetPath;
        try {
            const result = await this.electronAPI.loadPresetPrompts(presetPath);
            if (version !== this.contextVersion || generation !== this.catalogGeneration || presetPath !== this.presetPath) return;
            if (result.success) {
                this.presets = result.presets || [];
            } else {
                console.error('Failed to load presets:', result.error);
                this.presets = [];
            }
        } catch (error) {
            if (version !== this.contextVersion || generation !== this.catalogGeneration) return;
            console.error('Error loading presets:', error);
            this.presets = [];
        }
    }

    /**
     * 渲染模块UI
     */
    render(container) {
        container.innerHTML = '';
        container.classList.add('preset-prompt-container');

        // Context initialization loads the catalog. Rendering must be synchronous:
        // a delayed render must never append this mode into another mode's view.

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
        const contextVersion = this.contextVersion;
        browseBtn.onclick = async () => {
            const result = await this.electronAPI.selectDirectory();
            if (contextVersion !== this.contextVersion) return;
            if (result.success && result.path) {
                pathInput.value = result.path;
                this.presetPath = result.path;
                await this.savePresetPath();
                if (contextVersion !== this.contextVersion) return;
                await this.loadPresets();
                if (contextVersion === this.contextVersion) this.updatePresetSelector();
            }
        };
        actions.appendChild(browseBtn);

        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'preset-refresh-btn';
        refreshBtn.title = '刷新预设列表';
        refreshBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
        refreshBtn.onclick = async () => {
            if (contextVersion !== this.contextVersion) return;
            this.presetPath = pathInput.value;
            await this.savePresetPath();
            if (contextVersion !== this.contextVersion) return;
            await this.loadPresets();
            if (contextVersion === this.contextVersion) this.updatePresetSelector();
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

        const select = this.presetSelect;
        const contextVersion = this.contextVersion;
        this.presetSelect.onchange = async () => {
            if (contextVersion !== this.contextVersion || select !== this.presetSelect) return;
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
        label.className = 'preset-section-label';
        label.textContent = '系统提示词:';
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'vcp-settings-info-badge';
        badge.title = '可使用 {{AgentName}} 占位符，将在对话中自动替换为当前助手名称';
        badge.setAttribute('data-tooltip', '可使用 {{AgentName}} 占位符，将在对话中自动替换为当前助手名称');
        badge.setAttribute('aria-label', '占位符说明');
        badge.textContent = '?';
        badge.onclick = (e) => { e.preventDefault(); e.stopPropagation(); };
        label.appendChild(badge);
        section.appendChild(label);

        this.textarea = document.createElement('textarea');
        this.textarea.className = 'prompt-textarea preset-prompt-textarea';
        this.textarea.spellcheck = false;
        this.textarea.autocorrect = 'off';
        this.textarea.autocapitalize = 'off';
        this.textarea.placeholder = '请输入系统提示词或选择预设...';
        this.textarea.value = this.cachedContent;
        this.textarea.rows = 3;

        const editor = this.textarea;
        const contextVersion = this.contextVersion;
        this.textarea.addEventListener('input', () => {
            if (contextVersion !== this.contextVersion || editor !== this.textarea) return;
            ++this.presetLoadGeneration;
            this.cachedContent = editor.value;
            this.autoResize();
        });

        section.appendChild(this.textarea);

        // 使用setTimeout确保DOM渲染完成后再调整大小
        setTimeout(() => {
            if (contextVersion === this.contextVersion && editor === this.textarea) {
                this.autoResize();
            }
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
    loadSelectedPreset() {
        const operation = this.performPresetLoad();
        this.pendingPresetLoads.add(operation);
        const cleanup = () => this.pendingPresetLoads.delete(operation);
        operation.then(cleanup, cleanup);
        return operation;
    }

    async waitForPendingLoads() {
        while (this.pendingPresetLoads.size) {
            await Promise.all([...this.pendingPresetLoads]);
        }
    }

    async performPresetLoad() {
        const targetAgentId = this.agentId;
        const contextVersion = this.contextVersion;
        const generation = ++this.presetLoadGeneration;
        const select = this.presetSelect;
        const presetPath = select.value;
        const ownsRequest = () => this.agentId === targetAgentId
            && this.contextVersion === contextVersion
            && generation === this.presetLoadGeneration
            && select === this.presetSelect;
        
        if (!presetPath) {
            // Explicit user selection, not a loading failure.
            this.cachedSelectedPreset = '';
            this.cachedContent = '';
            if (this.textarea) {
                this.textarea.value = '';
                this.autoResize();
            }
            await this.save();
            return ownsRequest();
        }

        try {
            const result = await this.electronAPI.loadPresetContent(presetPath);
            if (!ownsRequest()) {
                console.debug(`[PresetPromptModule] Ignoring stale preset load for agent ${targetAgentId}.`);
                return false;
            }
            if (result.success && typeof result.content === 'string') {
                // Publish the selection and its content together only after a
                // successful load. Empty file contents are a legitimate value.
                this.cachedSelectedPreset = presetPath;
                this.cachedContent = result.content;
                if (this.textarea) this.textarea.value = this.cachedContent;
                // 使用setTimeout确保内容已渲染
                setTimeout(() => {
                    if (this.agentId === targetAgentId && this.contextVersion === contextVersion) {
                        this.autoResize();
                    }
                }, 0);
                await this.save();
                return ownsRequest();
            } else {
                select.value = this.cachedSelectedPreset;
                console.error('Failed to load preset content:', result.error);
                return false;
            }
        } catch (error) {
            if (ownsRequest()) select.value = this.cachedSelectedPreset;
            console.error('Error loading preset content:', error);
            return false;
        }
    }

    /**
     * 保存预设路径
     */
    async savePresetPath() {
        const agentId = this.agentId;
        const presetPromptPath = this.presetPath;
        if (!agentId) throw new Error('预设路径没有所属 Agent');

        if (typeof window.settingsManager?.stageAgentPatch === 'function') {
            const staged = window.settingsManager.stageAgentPatch({ presetPromptPath }, agentId);
            if (staged?.success !== true) {
                throw new Error(staged?.error || '预设路径编辑会话拒绝暂存');
            }
            return staged;
        }

        const result = await this.electronAPI.updateAgentConfig(agentId, {
            presetPromptPath
        });
        if (!result || result.success !== true || result.error) {
            throw new Error(result?.error || '预设路径保存失败');
        }
        return result;
    }

    /**
     * 保存数据
     */
    async save() {
        // Save the context-owned draft, never a retained editor from another mode.

        // 在调用 IPC 前冻结目标和数据。设置页存在编辑会话时，提示词
        // 只进入该会话，由统一保存入口提交。
        const targetAgentId = this.agentId;
        if (!targetAgentId) return;
        const content = this.cachedContent.trim();
        const selectedPreset = this.cachedSelectedPreset;

        this.cachedContent = content;
        this.cachedSelectedPreset = selectedPreset;

        const patch = {
            presetSystemPrompt: content,
            selectedPreset,
            presetPromptPath: this.presetPath,
        };
        // The coordinator derives the effective prompt from the active mode.
        // A late preset load must not replace another mode's systemPrompt.
        if (typeof window.settingsManager?.stageAgentPatch === 'function') {
            const staged = window.settingsManager.stageAgentPatch(patch, targetAgentId);
            if (staged?.success !== true) {
                throw new Error(staged?.error || '预置提示词编辑会话拒绝暂存');
            }
            return staged;
        }
        const result = await this.electronAPI.updateAgentConfig(targetAgentId, patch);
        if (!result || result.success !== true || result.error) {
            throw new Error(result?.error || result?.message || '预置提示词保存失败');
        }
        return result;
    }

    /**
     * 获取提示词内容
     */
  async getPrompt() {
    return this.cachedContent.trim();
  }

  /**
   * 销毁模块，释放资源
   */
  destroy() {
    ++this.contextVersion;
    ++this.presetLoadGeneration;
    this.agentId = null;
    this.textarea = null;
    this.presetSelect = null;
    this.container = null;
  }
}

// 导出到全局
window.PresetPromptModule = PresetPromptModule;
