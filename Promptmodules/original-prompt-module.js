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
    this.contextVersion = 0;
    this.persistedContent = "";
  }

  /**
   * 更新上下文
   * @param {string} agentId 
   * @param {Object} config 
   */
  updateContext(agentId, config) {
    this.contextVersion += 1;
    this.textarea = null;
    this.agentId = agentId;
    this.config = config;
    // An explicitly empty original prompt is valid. Only legacy configs
    // without a mode-specific field may inherit the compatibility prompt.
    this.cachedContent = typeof config.originalSystemPrompt === "string"
      ? config.originalSystemPrompt
      : (!config.promptMode || config.promptMode === "original")
        ? (config.systemPrompt ?? "")
        : "";
    this.persistedContent = this.cachedContent.trim();
  }

  /**
   * 渲染模块UI
   * @param {HTMLElement} container - 容器元素
   */
  render(container) {
    container.innerHTML = "";
    container.classList.add("original-prompt-container");

    // 创建文本域
    this.textarea = document.createElement("textarea");
    this.textarea.className = "prompt-textarea original-prompt-textarea";
    this.textarea.spellcheck = false;
    this.textarea.autocorrect = "off";
    this.textarea.autocapitalize = "off";
    this.textarea.placeholder = "请输入系统提示词...";
    this.textarea.value = this.cachedContent;
    this.textarea.rows = 3;

    // The editor is a projection of this context's draft, not a durable
    // source that can be reassigned to another Agent.
    const editor = this.textarea;
    const version = this.contextVersion;
    this.textarea.addEventListener("input", () => {
      if (version !== this.contextVersion || this.textarea !== editor) return;
      this.cachedContent = editor.value;
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
    const agentId = this.agentId;
    const version = this.contextVersion;
    const content = this.cachedContent.trim();
    if (!agentId) {
      return { success: false, error: "提示词没有所属 Agent" };
    }

    // An installed coordinator owns the write boundary. A rejected stage is
    // not permission to bypass it with an unversioned IPC write.
    if (typeof window.settingsManager?.stageAgentPatch === "function") {
      const staged = window.settingsManager.stageAgentPatch(
        { originalSystemPrompt: content },
        agentId
      );
      if (staged?.success !== true) {
        throw new Error(staged?.error || "提示词编辑会话拒绝暂存");
      }
      // Keep persistedContent unchanged until a durable acknowledgement.
      return staged;
    }
    if (content === this.persistedContent) {
      return { success: true, skipped: true };
    }
    const result = await this.electronAPI.updateAgentConfig(agentId, {
      originalSystemPrompt: content,
    });
    if (!result || result.success !== true || result.error) {
      throw new Error(result?.error || result?.message || "提示词保存失败");
    }
    if (this.agentId === agentId && this.contextVersion === version) {
      this.persistedContent = content;
    }
    return result;
  }

  /**
   * 获取提示词内容
   * @returns {string}
   */
  async getPrompt() {
    return this.cachedContent.trim();
  }

  /**
   * 销毁模块，释放资源
   */
  destroy() {
    this.contextVersion += 1;
    this.agentId = null;
    this.textarea = null;
    this.container = null;
  }
}

// 导出到全局
window.OriginalPromptModule = OriginalPromptModule;
