// Promptmodules/prompt-manager.js
// 系统提示词管理器 - 负责三种模式的切换和数据管理

class PromptManager {
  constructor() {
    this.currentMode = "original"; // 'original' | 'modular' | 'preset'
    this.agentId = null;
    this.config = null;
    this.contextVersion = 0;
    this.contextRequestGeneration = 0;
    this.modeSwitchGeneration = 0;
    this.modeSwitchQueue = Promise.resolve();
    this.contextReady = false;

    // 模块实例
    this.originalModule = null;
    this.modularModule = null;
    this.presetModule = null;

    // 默认模式名称
    this.defaultModeNames = {
      original: "文本",
      modular: "模块",
      preset: "预制",
    };

    // 自定义模式名称（从全局设置加载）
    this.customModeNames = {};

    // 右键长按计时器
    this.rightClickTimer = null;
    this.rightClickDelay = 1000; // 1秒
    
    this.isInitialized = false;
    this.containerElement = null;
    this.electronAPI = null;
    this.boundContainerListeners = [];
  }

  /**
   * 初始化提示词管理器（全局单次初始化）
   * @param {Object} options - 初始化选项
   */
  async init(options) {
    if (this.isInitialized) return;
    
    const { containerElement, electronAPI } = options;
    this.containerElement = containerElement;
    this.electronAPI = electronAPI;
    this.bindContainerEvents();

    // 初始化三个模块（仅实例化，不加载数据）
    this.initModules();

    this.isInitialized = true;
    console.log('[PromptManager] Global initialization complete.');
  }

  bindContainerEvents() {
    if (!this.containerElement || this.boundContainerListeners.length) return;
    const listen = (type, handler) => {
      this.containerElement.addEventListener(type, handler);
      this.boundContainerListeners.push([type, handler]);
    };
    const modeButton = (event) => event.target.closest?.('.prompt-mode-button');
    listen('click', (event) => {
      const button = modeButton(event);
      if (button) this.switchMode(button.dataset.mode);
    });
    listen('dblclick', (event) => {
      const button = modeButton(event);
      if (!button) return;
      event.preventDefault();
      this.enterEditMode(button, button.dataset.mode);
    });
    listen('contextmenu', (event) => {
      const button = modeButton(event);
      if (!button) return;
      event.preventDefault();
      this.startRightClickTimer(button.dataset.mode);
    });
    listen('mouseup', (event) => {
      if (event.button === 2 && modeButton(event)) this.cancelRightClickTimer();
    });
    listen('mouseout', (event) => {
      const button = modeButton(event);
      if (button && !button.contains(event.relatedTarget)) this.cancelRightClickTimer();
    });
  }

  /**
   * 更新当前 Agent 上下文并切换显示
   * @param {string} agentId 
   * @param {Object} config 
   */
  async updateAgentContext(agentId, config) {
    const request = ++this.contextRequestGeneration;
    const modular = this.modularModule;
    if (modular) {
      // Validate the old global draft before changing ANY child or parent
      // identity. A rejection must leave the original editor usable.
      await modular.globalSaveQueue.catch(() => {});
      if (request !== this.contextRequestGeneration) return false;
      if (modular.globalSaveConflict
          || (modular.globalWarehouseReady
            && JSON.stringify(modular.hiddenBlocks.global || []) !== modular.persistedGlobalWarehouse)) {
        throw new Error("全局仓库存在冲突或未保存草稿，未切换 Agent 上下文");
      }
    }
    const contextVersion = ++this.contextVersion;
    ++this.modeSwitchGeneration;
    this.contextReady = false;
    if (this.containerElement) this.containerElement.inert = true;
    this.agentId = agentId;
    this.config = config;
    this.currentMode = ["original", "modular", "preset"].includes(config.promptMode)
      ? config.promptMode : "original";

    // 加载自定义模式名称 (这步可以异步)
    await this.loadCustomModeNames();
    if (contextVersion !== this.contextVersion || this.agentId !== agentId) return false;

    // 更新各个子模块的上下文。调用方会串行执行上下文切换；版本检查仍用于
    // 防止模式切换等并发操作在异步边界后继续刷新错误 Agent 的 UI。
    if (this.originalModule) this.originalModule.updateContext(agentId, config);
    if (this.modularModule) await this.modularModule.updateContext(agentId, config);
    if (contextVersion !== this.contextVersion || this.agentId !== agentId) return false;
    if (this.presetModule) await this.presetModule.updateContext(agentId, config);
    if (contextVersion !== this.contextVersion || this.agentId !== agentId) return false;

    // Publish readiness only after every child belongs to this context.
    this.render();
    this.contextReady = true;
    if (this.containerElement) this.containerElement.inert = false;
    return true;
  }

  /**
   * 初始化三个子模块
   */
  initModules() {
    if (window.OriginalPromptModule) {
      this.originalModule = new window.OriginalPromptModule({
        electronAPI: this.electronAPI,
      });
    }

    if (window.ModularPromptModule) {
      this.modularModule = new window.ModularPromptModule({
        electronAPI: this.electronAPI,
      });
    }

    if (window.PresetPromptModule) {
      this.presetModule = new window.PresetPromptModule({
        electronAPI: this.electronAPI,
      });
    }
  }

  /**
   * 渲染主界面
   */
  render() {
    if (!this.containerElement) return;
    let modeSelector = this.containerElement.querySelector(':scope > .prompt-mode-selector');
    if (!modeSelector) {
      modeSelector = this.createModeSelector();
      this.containerElement.appendChild(modeSelector);
    } else {
      modeSelector.querySelectorAll('.prompt-mode-button').forEach((button) => {
        const modeId = button.dataset.mode;
        button.innerHTML = `
          <span class="prompt-mode-button-icon" aria-hidden="true">${this.getModeIcon(modeId)}</span>
          <span class="prompt-mode-button-label">${this.getModeName(modeId)}</span>
        `;
      });
    }

    let contentContainer = this.containerElement.querySelector(':scope > .prompt-content-container');
    if (!contentContainer) {
      contentContainer = document.createElement("div");
      contentContainer.className = "prompt-content-container";
      contentContainer.id = "promptContentContainer";
      this.containerElement.appendChild(contentContainer);
    }

    // 渲染当前模式的内容
    this.updateModeButtons();
    this.renderCurrentMode();
  }

  /**
   * 创建模式切换按钮
   */
  createModeSelector() {
    const container = document.createElement("div");
    container.className = "prompt-mode-selector";

    const modes = [{ id: "original" }, { id: "modular" }, { id: "preset" }];

    modes.forEach((mode) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "prompt-mode-button";
      button.dataset.mode = mode.id;
      button.innerHTML = `
                <span class="prompt-mode-button-icon" aria-hidden="true">${this.getModeIcon(
                  mode.id
                )}</span>
                <span class="prompt-mode-button-label">${this.getModeName(
                  mode.id
                )}</span>
            `;

      if (this.currentMode === mode.id) {
        button.classList.add("active");
      }

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
      preset: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17h1.5"/><path d="M12 22h1.5"/><path d="M12 2h1.5"/><path d="M17.5 22H19a1 1 0 0 0 1-1"/><path d="M17.5 2H19a1 1 0 0 1 1 1v1.5"/><path d="M20 14v3h-2.5"/><path d="M20 8.5V10"/><path d="M4 10V8.5"/><path d="M4 19.5V14"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H8"/><path d="M8 22H6.5a1 1 0 0 1 0-5H8"/></svg>`,
    };

    return icons[modeId] || "";
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
      console.error("[PromptManager] 加载自定义模式名称失败:", error);
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
        promptModeCustomNames: this.customModeNames,
      };
      await this.electronAPI.saveSettings(newSettings);
    } catch (error) {
      console.error("[PromptManager] 保存自定义模式名称失败:", error);
    }
  }

  /**
   * 进入编辑模式
   */
  enterEditMode(button, modeId) {
    const currentName = button.textContent.trim();

    // 创建输入框
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentName;
    input.className = "prompt-mode-name-input";
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
    button.textContent = "";
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
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveName();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });

    // 失去焦点保存
    input.addEventListener("blur", saveName);
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
      const button = this.containerElement.querySelector(
        `.prompt-mode-button[data-mode="${modeId}"]`
      );
      if (button) {
        button.textContent = this.defaultModeNames[modeId];
      }

      // 显示提示
      if (
        window.uiHelperFunctions &&
        window.uiHelperFunctions.showToastNotification
      ) {
        window.uiHelperFunctions.showToastNotification(
          `已恢复模式名称为"${this.defaultModeNames[modeId]}"`,
          "success"
        );
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
   * 解绑容器事件监听（仅销毁时调用；正常运行期间解绑会导致模式按钮失效）
   */
  unbindContainerEvents() {
    this.boundContainerListeners.forEach(([type, handler]) => {
      this.containerElement?.removeEventListener(type, handler);
    });
    this.boundContainerListeners = [];
  }

  /**
   * 切换模式
   * @param {string} mode - 目标模式
   */
  switchMode(mode) {
     if (!this.contextReady || !["original", "modular", "preset"].includes(mode) || !this.agentId) {
       return Promise.resolve({ success: false, stale: true });
     }
     // Even a click on the currently displayed mode cancels earlier intent.
     const generation = ++this.modeSwitchGeneration;
     const agentId = this.agentId;
     const version = this.contextVersion;
     const ownsContext = () => this.agentId === agentId && this.contextVersion === version;
     const isCurrent = () => ownsContext() && generation === this.modeSwitchGeneration;
     const task = async () => {
       if (!isCurrent()) return { success: false, stale: true };
       await this.saveCurrentModeData();
       if (!isCurrent()) return { success: false, stale: true };

       const targetModule = mode === "original" ? this.originalModule
         : mode === "modular" ? this.modularModule : this.presetModule;
       if (!targetModule) throw new Error("目标提示词模块尚未就绪");
       const systemPrompt = await targetModule.getPrompt();
       if (!isCurrent()) return { success: false, stale: true };

       // Commit mode and its effective prompt through the Agent edit session
       // whenever the settings surface owns this context.
       const patch = { promptMode: mode, systemPrompt };
       let result;
       if (typeof window.settingsManager?.stageAgentPatch === "function") {
         result = window.settingsManager.stageAgentPatch(patch, agentId);
         // A rejected session stage must never authorize an unversioned write.
       } else {
         result = await this.electronAPI.updateAgentConfig(agentId, patch);
       }
       if (!result || result.success !== true || result.error) {
         throw new Error(result?.error || result?.message || "提示词模式保存失败");
       }
       // With a coordinator this projects the accepted draft, not a durable
       // acknowledgement. The settings save indicator owns persistence status.
       // Standalone callers reach here only after their IPC acknowledges.
       if (ownsContext()) {
         this.currentMode = mode;
         this.config = { ...this.config, promptMode: mode, systemPrompt };
         this.updateModeButtons();
         this.renderCurrentMode();
       }
       return result;
     };
     const operation = this.modeSwitchQueue.catch(() => {}).then(task);
     this.modeSwitchQueue = operation;
     // Event-driven callers do not await switchMode; still report failures.
     operation.catch(error => {
       console.error("[PromptManager] Mode switch failed:", error);
       if (ownsContext()) {
         window.uiHelperFunctions?.showToastNotification?.(
           `提示词模式切换失败，草稿已保留：${error.message}`, "error"
         );
       }
     });
     return operation;
 }

 /**
  * 更新模式按钮的激活状态
   */
  updateModeButtons() {
    const buttons = this.containerElement.querySelectorAll(
      ".prompt-mode-button"
    );
    buttons.forEach((button) => {
      if (button.dataset.mode === this.currentMode) {
        button.classList.add("active");
      } else {
        button.classList.remove("active");
      }
    });
  }

  /**
   * 渲染当前模式的内容
   */
  renderCurrentMode() {
    // The owning settings surface may be detached from document.
    // Resolve only inside our container, never another surface's editor.
    const contentContainer = this.containerElement?.querySelector(":scope > .prompt-content-container");
    if (!contentContainer) return;

    contentContainer.innerHTML = "";
    contentContainer.className = `prompt-content-container ${this.currentMode}-mode`;

    switch (this.currentMode) {
      case "original":
        if (this.originalModule) {
          this.originalModule.render(contentContainer);
        }
        break;
      case "modular":
        if (this.modularModule) {
          this.modularModule.render(contentContainer);
        }
        break;
      case "preset":
        if (this.presetModule) {
          this.presetModule.render(contentContainer);
        }
        break;
    }
  }

  /**
   * Drain editor work before an external save or handoff.
   * Mode-switch tasks must not call this method: it waits for their queue.
   */
  async flushEditorWork() {
    const version = this.contextVersion;
    const agentId = this.agentId;
    const assertOwner = () => {
      if (!this.contextReady || version !== this.contextVersion || agentId !== this.agentId) {
        throw new Error("等待保存期间提示词上下文已切换");
      }
    };
    assertOwner();
    while (true) {
      const modeQueue = this.modeSwitchQueue;
      // A failed intent leaves the displayed draft intact. Retrying that
      // draft below must remain possible; persistent conflicts still reject.
      await modeQueue.catch(() => {});
      assertOwner();
      await this.presetModule?.waitForPendingLoads?.();
      assertOwner();
      if (modeQueue !== this.modeSwitchQueue) continue;
      await this.saveCurrentModeData();
      assertOwner();
      if (modeQueue === this.modeSwitchQueue
          && !this.presetModule?.pendingPresetLoads?.size) {
        return { success: true, agentId, contextVersion: version };
      }
    }
  }

  /**
   * 保存当前模式的数据
   */
  async saveCurrentModeData() {
    if (!this.contextReady) throw new Error("提示词上下文尚未就绪，已阻止保存");
    const version = this.contextVersion;
    const agentId = this.agentId;
    const modular = this.modularModule;
    // Global drafts outlive the displayed mode. Drain them before allowing
    // a handoff even when the user is currently editing original/preset text.
    if (this.currentMode !== "modular" && modular?.globalWarehouseReady) {
      await modular.saveGlobalSnapshot(
        structuredClone(modular.hiddenBlocks.global || []), modular.contextVersion
      );
      if (version !== this.contextVersion || agentId !== this.agentId) {
        throw new Error("保存期间提示词上下文已切换");
      }
    }
    switch (this.currentMode) {
      case "original":
        if (this.originalModule) {
          await this.originalModule.save();
        }
        break;
      case "modular":
        if (this.modularModule) {
          await this.modularModule.save();
        }
        break;
      case "preset":
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
    if (!this.contextReady) throw new Error("提示词上下文尚未就绪，不能作为空提示词读取");
    switch (this.currentMode) {
      case "original":
        return this.originalModule ? await this.originalModule.getPrompt() : "";
      case "modular":
        return this.modularModule
          ? await this.modularModule.getFormattedPrompt()
          : "";
      case "preset":
        return this.presetModule ? await this.presetModule.getPrompt() : "";
      default:
        return "";
    }
  }

  /**
   * 外部接口：切换到指定模式（用于插件调用）
   * @param {string} mode - 目标模式
   */
  async setMode(mode) {
    if (["original", "modular", "preset"].includes(mode)) {
      await this.switchMode(mode);
    }
  }

  /**
   * 外部接口：获取当前绑定的 Agent。
   * @returns {string|null}
   */
  getAgentId() {
    return this.agentId;
  }

  /**
   * 外部接口：获取当前模式
   * @returns {string} 当前模式
   */
  getMode() {
    return this.currentMode;
  }

  /**
   * 销毁管理器，清理子模块和定时器
   */
  destroy() {
    ++this.contextRequestGeneration;
    this.contextReady = false;
    ++this.contextVersion;
    ++this.modeSwitchGeneration;
    this.agentId = null;
    // 1. 清理子模块
    if (this.originalModule && typeof this.originalModule.destroy === "function") {
      this.originalModule.destroy();
    }
    if (this.modularModule && typeof this.modularModule.destroy === "function") {
      this.modularModule.destroy();
    }
    if (this.presetModule && typeof this.presetModule.destroy === "function") {
      this.presetModule.destroy();
    }

    // 2. 清理计时器
    this.cancelRightClickTimer();

    // 3. 解绑容器事件监听
    this.unbindContainerEvents();

    // 4. 清理 DOM 引用
    this.containerElement = null;

    // 5. 重置模块引用
    this.originalModule = null;
    this.modularModule = null;
    this.presetModule = null;

    console.debug(`[PromptManager] Destroyed for agent: ${this.agentId}`);
  }
}

// 导出到全局
window.PromptManager = PromptManager;


// Synchronous capture boundary for the Agent edit-session coordinator.
// No IPC or DOM reads may occur while constructing a persistence snapshot.
PromptManager.prototype.captureSnapshot = function captureSnapshot() {
    if (!this.contextReady || !this.agentId) {
        throw new Error("提示词上下文尚未就绪，无法生成保存快照");
    }
    const mode = this.currentMode;
    const child = mode === "original" ? this.originalModule
        : mode === "modular" ? this.modularModule
        : mode === "preset" ? this.presetModule : null;
    if (!child || child.agentId !== this.agentId) {
        throw new Error("提示词子模块归属不一致，已阻止保存");
    }
    let patch;
    if (mode === "original") {
        const content = child.cachedContent.trim();
        patch = { originalSystemPrompt: content, systemPrompt: content };
    } else if (mode === "preset") {
        const content = child.cachedContent.trim();
        patch = {
            presetSystemPrompt: content,
            selectedPreset: child.cachedSelectedPreset,
            presetPromptPath: child.presetPath,
            systemPrompt: content,
        };
    } else {
        const hiddenBlocks = structuredClone(child.hiddenBlocks);
        delete hiddenBlocks.global;
        patch = {
            advancedSystemPrompt: {
                blocks: structuredClone(child.blocks),
                hiddenBlocks,
                warehouseOrder: [...child.warehouseOrder],
                viewMode: child.viewMode,
            },
            systemPrompt: child.getFormattedPrompt(),
        };
    }
    return Object.freeze({
        agentId: this.agentId,
        contextVersion: this.contextVersion,
        mode,
        patch: Object.freeze({ ...patch, promptMode: mode }),
    });
};
