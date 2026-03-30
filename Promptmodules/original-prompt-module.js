// Promptmodules/original-prompt-module.js
// 原始富文本系统提示词模块

class OriginalPromptModule {
    constructor(options) {
        this.agentId = options.agentId;
        this.config = options.config;
        this.electronAPI = options.electronAPI;
        this.textarea = null;
        
        // 缓存内容数据
        this.cachedContent = this.config.originalSystemPrompt || this.config.systemPrompt || '';
    }

    /**
     * 渲染模块UI
     * @param {HTMLElement} container - 容器元素
     */
    render(container) {
        container.innerHTML = '';

        // 创建文本域
        this.textarea = document.createElement('textarea');
        this.textarea.className = 'prompt-textarea original-prompt-textarea';
        this.textarea.placeholder = '请输入系统提示词...';
        this.textarea.value = this.cachedContent;
        this.textarea.rows = 3;
        
        // 添加自动调整大小
        this.textarea.addEventListener('input', () => {
            this.autoResize();
        });

        container.appendChild(this.textarea);

        // 初始调整大小
        this.autoResize();
    }

    /**
     * 自动调整文本域高度
     */
    autoResize() {
        if (!this.textarea) return;
        this.textarea.style.height = 'auto';
        this.textarea.style.height = this.textarea.scrollHeight + 'px';
    }

    /**
     * 保存数据
     */
    async save() {
        if (!this.textarea) return;

        const content = this.textarea.value.trim();
        
        // 更新缓存
        this.cachedContent = content;
        
        await this.electronAPI.updateAgentConfig(this.agentId, {
            originalSystemPrompt: content
        });
    }

    /**
     * 获取提示词内容
     * @returns {string}
     */
    async getPrompt() {
        if (this.textarea) {
            return this.textarea.value.trim();
        }
        return this.cachedContent;
    }
}

// 导出到全局
window.OriginalPromptModule = OriginalPromptModule;
