// Promptmodules/original-prompt-module.js
// 原始富文本系统提示词模块

class OriginalPromptModule {
  constructor(options) {
    this.electronAPI = options.electronAPI;
    this.agentId = null;
    this.config = null;
    this.textarea = null;
    this.maxAutoHeight = 320;
    this.cachedContent = "";
  }

  /**
   * 更新上下文
   * @param {string} agentId 
   * @param {Object} config 
   */
  updateContext(agentId, config) {
    this.agentId = agentId;
    this.config = config;
    this.cachedContent = config.originalSystemPrompt || config.systemPrompt || "";
  }

  /**
   * 渲染模块UI
   * @param {HTMLElement} container - 容器元素
   */
  render(container) {
    container.innerHTML = "";

    // 创建文本域
    this.textarea = document.createElement("textarea");
    this.textarea.className = "prompt-textarea original-prompt-textarea";
    this.textarea.placeholder = "请输入系统提示词...";
    this.textarea.value = this.cachedContent;
    this.textarea.rows = 3;

    // 添加自动调整大小
    this.textarea.addEventListener("input", () => {
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

    this.textarea.style.height = "auto";

    const nextHeight = Math.min(this.textarea.scrollHeight, this.maxAutoHeight);
    this.textarea.style.height = `${nextHeight}px`;
    this.textarea.style.overflowY =
      this.textarea.scrollHeight > this.maxAutoHeight ? "auto" : "hidden";
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
      originalSystemPrompt: content,
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

  /**
   * 销毁模块，释放资源
   */
  destroy() {
    this.textarea = null;
    this.container = null;
  }
}

// 导出到全局
window.OriginalPromptModule = OriginalPromptModule;
