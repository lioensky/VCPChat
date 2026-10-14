marked.setOptions({ gfm: true, breaks: true });

// --- Performance Constants ---
      const MAX_CARDS = 150; // DOM中最多保留的卡片数量
      const CARD_CLEANUP_BATCH = 30; // 每次清理的卡片数量
      const MESSAGE_THROTTLE_MS = 80; // 消息处理节流间隔(ms)
      const SETTLE_DELAY_MS = 500; // 卡片动画完成后释放will-change的延迟

      // --- Visuals & Utils ---
      const infoContainer = document.getElementById("infoContainer");
      const scrollToTopBtn = document.getElementById("scrollToTopBtn");
      let currentFilter = "all";
      let _cardCount = 0; // 跟踪当前卡片数量，避免频繁querySelectorAll

      // --- Raw Data Store for Copy Button ---
      const _rawDataStore = new Map();
      let _rawDataIdCounter = 0;

      // --- RAG Compare State ---
      let isCompareMode = false;
      let selectedCardA = null;
      let selectedCardB = null;
      let _compareCardIdCounter = 0;
      const _compareCardStore = new Map();

      function copyRawData(dataId, btn) {
        const rawJson = _rawDataStore.get(dataId);
        if (rawJson) {
          copyToClipboard(rawJson, btn);
        }
      }

      // --- HTML Sanitization Utility ---
      // 性能优化：使用字符替换代替DOM操作
      const _escapeMap = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      const _escapeRe = /[&<>"']/g;
      function escapeHTML(str) {
        if (typeof str !== "string") return "";
        return str.replace(_escapeRe, (ch) => _escapeMap[ch]);
      }

      function encodeURIComponentForInlineAttribute(str) {
        return encodeURIComponent(String(str || "")).replace(
          /[!'()*]/g,
          (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
        );
      }

      // 性能优化：预编译所有正则表达式（避免每次调用都重新创建）
      const _sanitizeRegexes = [
        new RegExp("<style\\b[^>]*>[\\s\\S]*?<\\/style\\s*>", "gi"),
        new RegExp("<scr" + "ipt\\b[^>]*>[\\s\\S]*?<\\/scr" + "ipt\\s*>", "gi"),
        new RegExp("<link\\b[^>]*\\/?>", "gi"),
        new RegExp("<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe\\s*>", "gi"),
        new RegExp("<object\\b[^>]*>[\\s\\S]*?<\\/object\\s*>", "gi"),
        new RegExp("<embed\\b[^>]*\\/?>", "gi"),
        new RegExp("<form\\b[^>]*>[\\s\\S]*?<\\/form\\s*>", "gi"),
      ];
      const _styleAttrRe = /(<[^>]+\sstyle\s*=\s*")((?:[^"])*)(">)/gi;
      const _dangerousCssPatterns = [
        /position\s*:\s*(fixed|absolute)\s*;?/gi,
        /z-index\s*:\s*[^;]*;?/gi,
        /background(-image|-color)?\s*:\s*[^;]*;?/gi,
      ];

      function sanitizeRenderedHTML(html) {
        if (typeof html !== "string") return "";
        for (let i = 0; i < _sanitizeRegexes.length; i++) {
          _sanitizeRegexes[i].lastIndex = 0; // 重置全局正则状态
          html = html.replace(_sanitizeRegexes[i], "");
        }
        _styleAttrRe.lastIndex = 0;
        html = html.replace(
          _styleAttrRe,
          function (match, prefix, styleVal, suffix) {
            var cleaned = styleVal;
            for (let i = 0; i < _dangerousCssPatterns.length; i++) {
              _dangerousCssPatterns[i].lastIndex = 0;
              cleaned = cleaned.replace(_dangerousCssPatterns[i], "");
            }
            return cleaned.trim()
              ? prefix + cleaned + suffix
              : prefix.replace(/\sstyle\s*=\s*"$/, "") + '">';
          }
        );
        return html;
      }

      // Safe wrapper around marked.parse — always sanitizes output
      // 性能优化：添加简单LRU缓存，避免重复解析相同文本
      const _markedCache = new Map();
      const _markedCacheMaxSize = 64;
      function safeMarkedParse(text) {
        if (typeof text !== "string") return "";
        // 短文本直接缓存
        if (text.length < 2000) {
          const cached = _markedCache.get(text);
          if (cached !== undefined) return cached;
        }
        const result = sanitizeRenderedHTML(marked.parse(text));
        if (text.length < 2000) {
          if (_markedCache.size >= _markedCacheMaxSize) {
            // 删除最早的条目
            const firstKey = _markedCache.keys().next().value;
            _markedCache.delete(firstKey);
          }
          _markedCache.set(text, result);
        }
        return result;
      }

      function stripTrailingCompareTags(text) {
        const lines = String(text ?? "")
          .replace(/\r\n?/g, "\n")
          .split("\n");
        let endIndex = lines.length;

        while (endIndex > 0 && !lines[endIndex - 1].trim()) {
          endIndex -= 1;
        }

        if (
          endIndex > 0 &&
          /^Tag\s*:/i.test(lines[endIndex - 1].trim())
        ) {
          endIndex -= 1;
          while (endIndex > 0 && !lines[endIndex - 1].trim()) {
            endIndex -= 1;
          }
        }

        return lines.slice(0, endIndex).join("\n");
      }

      function normalizeCompareContent(result) {
        return stripTrailingCompareTags(result?.text)
          .toLocaleLowerCase()
          .replace(/\s+/g, " ")
          .trim();
      }

      function updateCompareBar() {
        const floatingBar = document.getElementById("compareFloatingBar");
        const entryButton = document.getElementById("compareEntryBtn");
        const openButton = document.getElementById("openCompareModalButton");
        const status = document.getElementById("compareToolbarStatus");
        const hasBothSelections = !!selectedCardA && !!selectedCardB;

        document.body.classList.toggle("compare-mode-active", isCompareMode);
        floatingBar?.classList.toggle("active", isCompareMode);
        entryButton?.classList.toggle("is-active", isCompareMode);
        if (openButton) {
          openButton.disabled = !hasBothSelections;
        }
        if (status) {
          status.textContent = `A 轮：${
            selectedCardA ? "已选择" : "未选择"
          } · B 轮：${selectedCardB ? "已选择" : "未选择"}`;
        }

        document.querySelectorAll(".card-base.type-rag").forEach((card) => {
          const cardId = card.getAttribute("data-compare-card-id");
          card.classList.toggle(
            "card-selected-a",
            !!selectedCardA && selectedCardA.cardId === cardId
          );
          card.classList.toggle(
            "card-selected-b",
            !!selectedCardB && selectedCardB.cardId === cardId
          );
        });

        document.querySelectorAll(".compare-card-actions").forEach((actions) => {
          const cardId = actions.getAttribute("data-card-id");
          const card = cardId ? _compareCardStore.get(cardId) : null;
          if (!card) return;
          ["A", "B"].forEach((slot) => {
            const button = actions.querySelector(
              `.compare-card-slot-btn[data-slot="${slot}"]`
            );
            if (!button) return;
            const selected =
              (slot === "A" ? selectedCardA : selectedCardB)?.cardId ===
              card.cardId;
            button.classList.toggle("is-selected", selected);
            button.textContent = selected ? `已选 ${slot}` : `设为 ${slot}`;
            button.setAttribute("aria-pressed", String(selected));
          });
        });
      }

      function toggleCompareMode(enable) {
        isCompareMode =
          typeof enable === "boolean" ? enable : !isCompareMode;
        if (!isCompareMode) closeCompareModal();
        updateCompareBar();
      }

      function setCardAsSlot(slot, cardId) {
        if (slot !== "A" && slot !== "B") return;
        const card = _compareCardStore.get(cardId);
        if (!card) return;

        if (slot === "A") {
          if (selectedCardA?.cardId === cardId) {
            selectedCardA = null;
          } else {
            selectedCardA = card;
            if (selectedCardB?.cardId === cardId) selectedCardB = null;
          }
        } else {
          if (selectedCardB?.cardId === cardId) {
            selectedCardB = null;
          } else {
            selectedCardB = card;
            if (selectedCardA?.cardId === cardId) selectedCardA = null;
          }
        }

        if (!isCompareMode) isCompareMode = true;
        updateCompareBar();
      }

      function clearCompareSelection() {
        selectedCardA = null;
        selectedCardB = null;
        closeCompareModal();
        updateCompareBar();
      }

      function renderCompareModal() {
        if (!selectedCardA || !selectedCardB) return;
        const summary = document.getElementById("compareModalSummary");
        const setA = new Set(
          (selectedCardA.data.results || []).map((result) =>
            normalizeCompareContent(result)
          )
        );
        const setB = new Set(
          (selectedCardB.data.results || []).map((result) =>
            normalizeCompareContent(result)
          )
        );
        const columns = [
          {
            slot: "A",
            card: selectedCardA,
            otherItemsTextSet: setB,
            header: document.getElementById("compareColumnAHeader"),
            list: document.getElementById("compareColumnAList"),
          },
          {
            slot: "B",
            card: selectedCardB,
            otherItemsTextSet: setA,
            header: document.getElementById("compareColumnBHeader"),
            list: document.getElementById("compareColumnBList"),
          },
        ];

        if (summary) {
          summary.textContent = `${selectedCardA.data.dbName || "Unknown"} vs ${
            selectedCardB.data.dbName || "Unknown"
          }`;
        }

        columns.forEach(({ slot, card, otherItemsTextSet, header, list }) => {
          if (!header || !list) return;
          const resultCount = Array.isArray(card.data.results)
            ? card.data.results.length
            : 0;
          header.innerHTML = `
            <h3>${slot} 轮检索 <span class="meta-pill">${resultCount} 条召回</span></h3>
          `;
          list.innerHTML = `
            <div class="card-base type-rag compare-rendered-card settled">
              ${buildRagCardHTML(card.data, {
                mode: "compare",
                slot,
                otherItemsTextSet,
              })}
            </div>
          `;
        });
      }

      function openCompareModal() {
        if (!selectedCardA || !selectedCardB) return;
        const modal = document.getElementById("compareModal");
        if (!modal) return;
        renderCompareModal();
        modal.classList.add("active");
      }

      function closeCompareModal() {
        document.getElementById("compareModal")?.classList.remove("active");
      }

      function removeCompareCard(cardId) {
        const card = _compareCardStore.get(cardId);
        if (!card) return;
        if (selectedCardA?.cardId === cardId) selectedCardA = null;
        if (selectedCardB?.cardId === cardId) selectedCardB = null;
        _compareCardStore.delete(cardId);
        updateCompareBar();
      }

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeCompareModal();
      });

      // --- 消息节流队列 ---
      let _messageQueue = [];
      let _messageThrottleTimer = null;
      function enqueueMessage(handler, data) {
        _messageQueue.push({ handler, data });
        if (!_messageThrottleTimer) {
          _messageThrottleTimer = setTimeout(
            _flushMessageQueue,
            MESSAGE_THROTTLE_MS
          );
        }
      }
      function _flushMessageQueue() {
        _messageThrottleTimer = null;
        const batch = _messageQueue;
        _messageQueue = [];
        // 使用requestAnimationFrame确保在下一帧渲染
        requestAnimationFrame(() => {
          for (let i = 0; i < batch.length; i++) {
            batch[i].handler(batch[i].data);
          }
        });
      }

      const overlayState = {
        passThrough: true,
        opacity: 0.9,
        hideTimer: null,
        pendingApprovalIds: new Set(),
        pendingApprovals: [], // [{requestId, toolName, maid, command, timestamp}, ...]
        lastPayload: null,
      };

      const PARTITION_DEFINITIONS = [
        { key: "rag", name: "RAG知识库", color: "var(--accent-rag, #3498db)" },
        { key: "chain", name: "元思考链", color: "var(--accent-chain, #9b59b6)" },
        { key: "chat", name: "Agent会话", color: "var(--accent-agent, #f1c40f)" },
        { key: "memo", name: "记忆检索", color: "var(--accent-memo, #1abc9c)" },
        { key: "dream", name: "Agent梦境", color: "var(--accent-dream, #e84393)" },
        { key: "notification", name: "通知消息", color: "var(--accent-notification, #ff9f43)" },
      ];

      const PARTITIONS_STORAGE_KEY = "vcp_observer_enabled_partitions_v1";

      const observerRuntimeState = {
        partitions: {
          rag: true,
          chain: true,
          chat: true,
          memo: true,
          dream: true,
          notification: true,
        },
        notificationsEnabled: true,
        overlayEnabled: true,
        mounted: true,
      };

      function isPartitionEnabled(partitionKey) {
        if (!partitionKey) return true;
        return observerRuntimeState.partitions[partitionKey] !== false;
      }

      function getPartitionKeyForData(data) {
        if (!data || typeof data !== "object") return null;
        if (data.type === "AGENT_PRIVATE_CHAT_PREVIEW" || data.source === "AgentAssistant") {
          return "chat";
        }
        if (data.type === "META_THINKING_CHAIN") {
          return "chain";
        }
        if (data.type === "AI_MEMO_RETRIEVAL" || data.type === "DailyNote") {
          return "memo";
        }
        if (data.type && data.type.startsWith("AGENT_DREAM_")) {
          return "dream";
        }
        if (data.type === "tool_approval_request" || isNotificationData(data)) {
          return "notification";
        }
        return "rag";
      }

      function toggleSettingsModal() {
        const modal = document.getElementById("settingsModal");
        if (!modal) return;
        if (!modal.classList.contains("active")) {
          renderSettingsPartitions();
        }
        modal.classList.toggle("active");
      }

      function updateToolbarSwitch(buttonId, enabled, label) {
        const button = document.getElementById(buttonId);
        if (!button) return;
        const isOn = !!enabled;
        button.classList.toggle("is-off", !isOn);

        const statusText = button.querySelector(".status-text");
        if (statusText) {
          statusText.textContent = isOn ? "已开启" : "已关闭";
        }

        // 同步 aria-pressed 状态
        button.setAttribute("aria-pressed", String(isOn));
      }

      function removeCardsByType(typeClass) {
        if (!typeClass) return;
        const cards = infoContainer.querySelectorAll(`.card-base.${typeClass}`);
        cards.forEach((card) => {
          const cardId = card.getAttribute("data-compare-card-id");
          if (cardId) removeCompareCard(cardId);
          card.remove();
        });

        _cardCount = infoContainer.querySelectorAll(".card-base").length;
        updateCompareBar();

        if (_cardCount === 0) {
          infoContainer.innerHTML = `
                          <div style="text-align:center; color:rgba(255,255,255,0.3); margin-top: 50px; font-size: 0.9rem;">
                              <p>等待数据接入...</p>
                              <p style="font-size: 0.8em;">System Ready</p>
                          </div>`;
        }
      }

      function syncFilterBarVisibility() {
        PARTITION_DEFINITIONS.forEach(({ key }) => {
          const filterBtn = document.querySelector(`.filter-btn[data-type="${key}"]`);
          if (!filterBtn) return;
          const enabled = isPartitionEnabled(key);
          filterBtn.style.display = enabled ? "" : "none";
        });

        // 如果当前选中的分类按钮被隐藏了，退回显示“全部”
        if (currentFilter !== "all" && !isPartitionEnabled(currentFilter)) {
          const allBtn = document.querySelector('.filter-btn[data-type="all"]');
          if (allBtn) {
            filterLogs("all", allBtn);
          }
        } else {
          // 重新定位滑块
          const activeBtn = document.querySelector(".filter-btn.active");
          const highlight = document.querySelector(".filter-highlight");
          if (activeBtn && highlight) {
            highlight.style.width = `${activeBtn.offsetWidth}px`;
            highlight.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
          }
        }
      }

      function renderSettingsPartitions() {
        const container = document.getElementById("settingsPartitionsContainer");
        if (!container) return;

        container.innerHTML = PARTITION_DEFINITIONS.map((partition) => {
          const enabled = isPartitionEnabled(partition.key);
          const isOffClass = enabled ? "is-active" : "is-off";
          return `
            <label class="partition-chip ${isOffClass}" data-key="${partition.key}">
              <input type="checkbox" ${enabled ? "checked" : ""} onchange="handlePartitionToggle('${partition.key}', this.checked)">
              <span class="partition-chip-dot" style="background-color: ${partition.color}; color: ${partition.color};"></span>
              <span class="partition-chip-title">${escapeHTML(partition.name)}</span>
            </label>
          `;
        }).join("");
      }

      function savePartitionsToStorage() {
        try {
          localStorage.setItem(PARTITIONS_STORAGE_KEY, JSON.stringify(observerRuntimeState.partitions));
        } catch (e) {
          console.warn("[RAG Observer] 保存监控分区设置失败:", e);
        }
      }

      function loadPartitionsFromStorage() {
        try {
          const raw = localStorage.getItem(PARTITIONS_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
              PARTITION_DEFINITIONS.forEach(({ key }) => {
                if (typeof parsed[key] === "boolean") {
                  observerRuntimeState.partitions[key] = parsed[key];
                }
              });
            }
          }
        } catch (e) {
          console.warn("[RAG Observer] 读取监控分区设置失败:", e);
        }
      }

      function handlePartitionToggle(partitionKey, enabled, shouldSyncToConfig = true) {
        observerRuntimeState.partitions[partitionKey] = !!enabled;
        savePartitionsToStorage();
        renderSettingsPartitions();
        syncFilterBarVisibility();

        if (!enabled) {
          removeCardsByType(`type-${partitionKey}`);
        }

        // 如果调整的是通知消息分区，同时联动通知通道
        if (partitionKey === "notification") {
          setNotificationCategoryEnabled(enabled, shouldSyncToConfig);
        }
      }

      function setNotificationCategoryEnabled(
        enabled,
        shouldSyncToConfig = true
      ) {
        const nextEnabled = !!enabled;
        observerRuntimeState.notificationsEnabled = nextEnabled;
        observerRuntimeState.partitions.notification = nextEnabled;
        savePartitionsToStorage();

        updateToolbarSwitch(
          "oldNotificationCategoryToggle",
          observerRuntimeState.notificationsEnabled,
          "通知分类"
        );
        syncFilterBarVisibility();
        renderSettingsPartitions();

        if (!observerRuntimeState.notificationsEnabled) {
          removeCardsByType("type-notification");
          overlayState.pendingApprovalIds.clear();
          hideOverlayNotification();
        }

        if (
          shouldSyncToConfig &&
          typeof window.setNotificationChannelEnabledFromObserver === "function"
        ) {
          window.setNotificationChannelEnabledFromObserver(
            observerRuntimeState.notificationsEnabled
          );
        }

        if (
          shouldSyncToConfig &&
          window.electronAPI?.ragOverlaySetNotificationCategoryEnabled
        ) {
          window.electronAPI.ragOverlaySetNotificationCategoryEnabled(
            observerRuntimeState.notificationsEnabled
          );
        }
      }

      function setOverlayEnabled(enabled, shouldSyncToMain = true) {
        observerRuntimeState.overlayEnabled = !!enabled;
        updateToolbarSwitch(
          "overlayFeatureToggle",
          observerRuntimeState.overlayEnabled,
          "悬浮窗"
        );
        updateToolbarSwitch(
          "oldOverlayFeatureToggle",
          observerRuntimeState.overlayEnabled,
          "悬浮窗"
        );

        if (!observerRuntimeState.overlayEnabled) {
          clearOverlayHideTimer();
          overlayState.pendingApprovalIds.clear();
          overlayState.lastPayload = null;
          if (window.electronAPI?.ragOverlayHide) {
            window.electronAPI.ragOverlayHide();
          }
        }

        if (shouldSyncToMain && window.electronAPI?.ragOverlaySetEnabled) {
          window.electronAPI.ragOverlaySetEnabled(
            observerRuntimeState.overlayEnabled
          );
        }

        if (observerRuntimeState.overlayEnabled) {
          if (window.electronAPI?.ragOverlaySetPassThrough) {
            window.electronAPI.ragOverlaySetPassThrough(
              overlayState.passThrough
            );
          }
          if (window.electronAPI?.ragOverlaySetOpacity) {
            window.electronAPI.ragOverlaySetOpacity(overlayState.opacity);
          }
        }
      }

      function toggleNotificationCategory() {
        setNotificationCategoryEnabled(
          !observerRuntimeState.notificationsEnabled,
          true
        );
      }

      function toggleOverlayFeature() {
        setOverlayEnabled(!observerRuntimeState.overlayEnabled, true);
      }

      function updateOverlayControlButtons() {
        const passBtn = document.getElementById("overlayPassThroughBtn");
        const interactiveBtn = document.getElementById("overlayInteractiveBtn");
        if (!passBtn || !interactiveBtn) return;
        passBtn.classList.toggle("active", overlayState.passThrough);
        interactiveBtn.classList.toggle("active", !overlayState.passThrough);
      }

      function setOverlayPassThrough(passThrough, shouldSyncToMain = true) {
        const previousPassThrough = overlayState.passThrough;
        overlayState.passThrough = !!passThrough;
        updateOverlayControlButtons();

        if (!overlayState.passThrough) {
          clearOverlayHideTimer();
          if (
            observerRuntimeState.overlayEnabled &&
            window.electronAPI?.ragOverlayShow
          ) {
            const payloadToShow = overlayState.lastPayload
              ? {
                  ...overlayState.lastPayload,
                  passThrough: false,
                  opacity: overlayState.opacity,
                  timestamp: new Date().toLocaleTimeString(),
                }
              : {
                  title: "悬浮窗已切换为可交互",
                  content: "当前为可交互模式，将保持显示。",
                  type: "overlay_mode_change",
                  level: "info",
                  timestamp: new Date().toLocaleTimeString(),
                  passThrough: false,
                  opacity: overlayState.opacity,
                };
            overlayState.lastPayload = payloadToShow;
            window.electronAPI.ragOverlayShow(payloadToShow);
          }
        } else if (
          previousPassThrough !== overlayState.passThrough &&
          overlayState.pendingApprovalIds.size === 0
        ) {
          hideOverlayNotification();
        }

        if (
          shouldSyncToMain &&
          observerRuntimeState.overlayEnabled &&
          window.electronAPI?.ragOverlaySetPassThrough
        ) {
          window.electronAPI.ragOverlaySetPassThrough(overlayState.passThrough);
        }
      }

      function setOverlayOpacity(opacityPercent, shouldSyncToMain = true) {
        const numeric = Math.max(
          20,
          Math.min(100, Number(opacityPercent) || 90)
        );
        overlayState.opacity = numeric / 100;

        const opacityRange = document.getElementById("overlayOpacityRange");
        if (opacityRange && String(opacityRange.value) !== String(numeric)) {
          opacityRange.value = String(numeric);
        }

        const opacityValue = document.getElementById("overlayOpacityValue");
        if (opacityValue) {
          opacityValue.textContent = `${numeric}%`;
        }

        if (
          shouldSyncToMain &&
          observerRuntimeState.overlayEnabled &&
          window.electronAPI?.ragOverlaySetOpacity
        ) {
          window.electronAPI.ragOverlaySetOpacity(overlayState.opacity);
        }
      }

      function clearOverlayHideTimer() {
        if (overlayState.hideTimer) {
          clearTimeout(overlayState.hideTimer);
          overlayState.hideTimer = null;
        }
      }

      function hideOverlayNotification() {
        clearOverlayHideTimer();
        if (overlayState.pendingApprovalIds.size > 0) return;
        if (overlayState.pendingApprovals.length > 0) return;
        if (!overlayState.passThrough) return; // 可交互模式下保持显示
        if (
          observerRuntimeState.overlayEnabled &&
          window.electronAPI?.ragOverlayHide
        ) {
          window.electronAPI.ragOverlayHide();
        }
      }

      function scheduleOverlayHide(delay = 2000) {
        clearOverlayHideTimer();
        if (overlayState.pendingApprovalIds.size > 0) return;
        if (overlayState.pendingApprovals.length > 0) return;
        if (!overlayState.passThrough) return; // 可交互模式下不自动隐藏
        overlayState.hideTimer = setTimeout(() => {
          overlayState.hideTimer = null;
          if (
            overlayState.pendingApprovalIds.size === 0 &&
            overlayState.pendingApprovals.length === 0 &&
            overlayState.passThrough
          ) {
            hideOverlayNotification();
          }
        }, delay);
      }

      // 从 vcp_log 的 content 中尽量提取友好可读消息（参考主程序 notificationRenderer.js 的逻辑）
      function extractFriendlyVcpLogContent(vcpData) {
        if (!vcpData || typeof vcpData !== "object") {
          return { title: "", content: "", level: "info" };
        }

        const toolName = vcpData.tool_name || "";
        const statusRaw = String(vcpData.status || "").toLowerCase();
        const level =
          statusRaw === "error" || statusRaw === "failed"
            ? "error"
            : statusRaw === "success" || statusRaw === "ok"
            ? "success"
            : "info";

        let title = toolName
          ? `${toolName} ${vcpData.status || ""}`.trim()
          : "VCP 日志";
        let content = "";

        if (typeof vcpData.content === "undefined") {
          return { title, content: "(无内容)", level };
        }

        const rawContentString = String(vcpData.content);
        content = rawContentString;

        // 错误情况下尝试提取 plugin_error / error / message
        if (statusRaw === "error" && rawContentString.includes("{")) {
          const jsonStart = rawContentString.indexOf("{");
          const prefix = rawContentString.substring(0, jsonStart);
          const jsonPart = rawContentString.substring(jsonStart);
          try {
            const parsed = JSON.parse(jsonPart);
            const displayError =
              parsed.plugin_error || parsed.error || parsed.message;
            if (displayError) {
              content =
                prefix.trim() +
                (prefix.trim().endsWith(":") ? " " : ": ") +
                displayError;
              return { title, content, level };
            }
          } catch (e) {
            // ignore
          }
        }

        // 尝试解析为 JSON，提取友好字段
        try {
          const parsedInner = JSON.parse(rawContentString);
          let titleSuffix = "";
          if (parsedInner.MaidName) titleSuffix += ` by ${parsedInner.MaidName}`;
          if (
            parsedInner.timestamp &&
            typeof parsedInner.timestamp === "string" &&
            parsedInner.timestamp.length >= 16
          ) {
            titleSuffix += `${parsedInner.MaidName ? " " : ""}@ ${parsedInner.timestamp.substring(11, 16)}`;
          }
          if (titleSuffix) title += ` (${titleSuffix.trim()})`;

          if (typeof parsedInner.original_plugin_output !== "undefined") {
            const pluginOutput = parsedInner.original_plugin_output;
            if (typeof pluginOutput === "object" && pluginOutput !== null) {
              if (toolName === "DailyNote" && pluginOutput.message) {
                const statusIcon =
                  pluginOutput.status === "success" ? "✅" : "❌";
                content = `${statusIcon} ${pluginOutput.message}`;
              } else if (
                pluginOutput.message &&
                typeof pluginOutput.message === "string"
              ) {
                content = pluginOutput.message;
              } else {
                content = JSON.stringify(pluginOutput, null, 2);
              }
            } else {
              content = String(pluginOutput);
            }
          } else if (toolName === "DailyNote") {
            const statusIcon = vcpData.status === "success" ? "✅" : "❌";
            content = parsedInner.message
              ? `${statusIcon} ${parsedInner.message}`
              : `${statusIcon} 日记内容已成功记录到本地知识库。`;
          }
        } catch (e) {
          // 非 JSON 内容，保持原样
        }

        return { title, content, level };
      }

      function buildOverlayPayload(data) {
        const now = new Date().toLocaleTimeString();
        const type = data?.type || "unknown";
        let title = `信息流通知: ${type}`;
        let content = "";
        let level = "info";
        let approval = null;

        if (type === "tool_approval_request") {
          const req = data?.data || {};
          title = "工具调用审核请求";
          content = `${req.maid || "未知助手"} 请求调用 ${
            req.toolName || "未知工具"
          }`;
          approval = {
            requestId: String(req.requestId || ""),
            toolName: req.toolName || "未知工具",
            maid: req.maid || "未知助手",
            command: String(
              req.args?.command || JSON.stringify(req.args || {}, null, 2) || ""
            ),
            timestamp: req.timestamp || now,
          };
          level = "warning";
        } else if (type === "tool_approval_response") {
          const resp = data?.data || {};
          title = "工具审核结果";
          const reasonHint = typeof resp.reason === "string" && resp.reason.trim()
            ? `\n理由: ${resp.reason.trim()}`
            : "";
          content = `${resp.approved ? "已允许" : "已拒绝"} ${
            resp.requestId ? `(ID: ${resp.requestId})` : ""
          }`.trim() + reasonHint;
          level = resp.approved ? "success" : "error";
        } else if (type === "tool_auto_approval" && data?.data) {
          const auto = data.data || {};
          title = `✅ 已自动允许: ${auto.toolName || "未知工具"}`;
          content = `助手: ${auto.maid || "未知"}\n规则: ${
            auto.ruleName || "未命名规则"
          }\n请求ID: ${auto.requestId || "N/A"}\n状态: ${
            auto.sent ? "已发送允许响应" : "发送失败"
          }`;
          level = auto.sent ? "success" : "warning";
        } else if (type === "vcp_log" && data?.data) {
          const friendly = extractFriendlyVcpLogContent(data.data);
          title = friendly.title || "VCP 日志";
          content = friendly.content;
          level = friendly.level || "info";
        } else if (
          type === "notification" ||
          type === "error" ||
          type === "connection_ack"
        ) {
          title = `系统通知: ${type}`;
          content = data.message || JSON.stringify(data.data || data, null, 2);
          if (type === "error") level = "error";
        } else if (type === "RAG_RETRIEVAL_DETAILS") {
          title = `RAG 检索: ${data.dbName || "Unknown"}`;
          content = data.query || "收到一条 RAG 检索信息";
        } else if (type === "META_THINKING_CHAIN") {
          title = `元思考链: ${data.chainName || "Unknown"}`;
          content = data.query || "收到一条元思考链信息";
        } else if (type === "AGENT_PRIVATE_CHAT_PREVIEW") {
          title = `Agent 私聊: ${data.agentName || "Unknown"}`;
          content = data.response || data.query || "收到一条 Agent 私聊预览";
        } else if (type === "AI_MEMO_RETRIEVAL") {
          title = "记忆检索";
          content = data.extractedMemories || "收到一条记忆检索信息";
        } else if (type === "DailyNote") {
          title = `日记召回: ${data.dbName || "Unknown"}`;
          content = data.message || "收到一条日记召回信息";
        } else if (type.startsWith("AGENT_DREAM_")) {
          title = `Agent 梦境: ${data.agentName || "Unknown"}`;
          content =
            data.message ||
            data.error ||
            data.narrative ||
            "收到一条 Agent 梦境信息";
        } else {
          content = data.message || JSON.stringify(data?.data || data, null, 2);
        }

        content = String(content || "").trim();
        if (content.length > 280) {
          content = `${content.slice(0, 280)}...`;
        }

        return {
          title,
          content,
          type,
          level,
          timestamp: now,
          opacity: overlayState.opacity,
          passThrough: overlayState.passThrough,
          approval,
        };
      }

      function notifyOverlayFromData(data) {
        if (
          !observerRuntimeState.overlayEnabled ||
          !window.electronAPI?.ragOverlayShow ||
          !data
        )
          return;

        // 审批类消息（请求/响应）不受分区开关影响，
        // 因为即使通知分类关闭，也需要清理 pendingApprovals 状态
        const isApprovalRequest = data.type === "tool_approval_request";
        const isApprovalResponse = data.type === "tool_approval_response";
        const partitionKey = getPartitionKeyForData(data);

        if (
          !isPartitionEnabled(partitionKey) &&
          !isApprovalRequest &&
          !isApprovalResponse
        ) {
          return;
        }

        // ── 管理 pendingApprovals 数组 ──
        if (isApprovalRequest) {
          const req = data?.data || {};
          const requestId = String(req.requestId || "");
          if (requestId) {
            overlayState.pendingApprovalIds.add(requestId);
            // 避免重复添加同一个 requestId
            if (
              !overlayState.pendingApprovals.some(
                (p) => p.requestId === requestId
              )
            ) {
              overlayState.pendingApprovals.push({
                requestId,
                toolName: req.toolName || "未知工具",
                maid: req.maid || "未知助手",
                command: String(
                  req.args?.command ||
                    JSON.stringify(req.args || {}, null, 2) ||
                    ""
                ),
                timestamp: req.timestamp || new Date().toLocaleTimeString(),
              });
            }
          }
        }

        if (isApprovalResponse) {
          const requestId = String(data?.data?.requestId || "");
          if (requestId) {
            overlayState.pendingApprovalIds.delete(requestId);
            overlayState.pendingApprovals =
              overlayState.pendingApprovals.filter(
                (p) => p.requestId !== requestId
              );
          } else {
            overlayState.pendingApprovalIds.clear();
            overlayState.pendingApprovals = [];
          }
          // 待审批全部清空时恢复穿透模式（审批期间被强制设为 false）
          if (
            overlayState.pendingApprovals.length === 0 &&
            overlayState.pendingApprovalIds.size === 0
          ) {
            overlayState.passThrough = true;
          }
        }

        // ── 构建包含完整待审批列表的 payload ──
        const payload = buildOverlayPayload(data);
        payload.pendingApprovals = overlayState.pendingApprovals;
        payload.approvalCount = overlayState.pendingApprovals.length;

        // 有待审批时强制可交互模式，否则使用用户保存的模式
        const hasPending = overlayState.pendingApprovals.length > 0;
        payload.passThrough = hasPending ? false : overlayState.passThrough;

        payload.opacity = overlayState.opacity;
        overlayState.lastPayload = { ...payload };

        // 审批响应消息不展示内容（只是确认状态变更），直接隐藏即可
        if (isApprovalResponse && !hasPending) {
          if (window.electronAPI?.ragOverlayHide) {
            window.electronAPI.ragOverlayHide();
          }
        } else {
          window.electronAPI.ragOverlayShow(payload);

          // ── 隐藏逻辑 ──
          if (
            overlayState.pendingApprovals.length === 0 &&
            overlayState.pendingApprovalIds.size === 0
          ) {
            scheduleOverlayHide(2000);
          } else {
            clearOverlayHideTimer();
          }
        }
      }

      function updateStatus(status, message) {
        const dot = document.getElementById("statusDot");
        const text = document.getElementById("statusText");

        dot.className = "status-dot";
        if (status === "open") dot.classList.add("dot-green");
        else if (status === "connecting") dot.classList.add("dot-orange");
        else dot.classList.add("dot-red");

        text.textContent = message;
      }

      function updateScrollTopButtonVisibility() {
        if (!scrollToTopBtn || !infoContainer) return;
        const shouldShow = infoContainer.scrollTop > 240;
        scrollToTopBtn.classList.toggle("visible", shouldShow);
      }

      function scrollInfoToTop() {
        if (!infoContainer) return;
        infoContainer.scrollTo({
          top: 0,
          behavior: "smooth",
        });
      }

      function filterLogs(type, btnElement) {
        if (!btnElement) return;
        currentFilter = type;

        // Update buttons
        document
          .querySelectorAll(".filter-btn")
          .forEach((btn) => btn.classList.remove("active"));
        btnElement.classList.add("active");

        // Move the highlight
        const highlight = document.querySelector(".filter-highlight");
        highlight.style.width = `${btnElement.offsetWidth}px`;
        highlight.style.transform = `translateX(${btnElement.offsetLeft}px)`;

        // Change highlight color based on type
        const typeColors = {
          all: "rgba(255, 255, 255, 0.15)",
          rag: "rgba(52, 152, 219, 0.4)", // --accent-rag
          chain: "rgba(52, 152, 219, 0.4)", // --accent-chain
          chat: "rgba(52, 152, 219, 0.4)", // --accent-chat
          memo: "rgba(52, 152, 219, 0.4)", // --accent-memo
          dream: "rgba(52, 152, 219, 0.4)", // --accent-dream
          notification: "rgba(52, 152, 219, 0.4)", // --notification
        };
        highlight.style.backgroundColor = typeColors[type] || typeColors["all"];

        // Filter DOM
        const cards = document.querySelectorAll(".card-base");
        cards.forEach((card) => {
          if (type === "all") {
            card.style.display = "block";
          } else {
            if (card.classList.contains(`type-${type}`)) {
              card.style.display = "block";
            } else {
              card.style.display = "none";
            }
          }
        });
      }

      function clearLogs() {
        selectedCardA = null;
        selectedCardB = null;
        isCompareMode = false;
        closeCompareModal();
        _compareCardStore.clear();
        updateCompareBar();

        const cards = infoContainer.querySelectorAll(".card-base");
        if (cards.length === 0) return;

        // 性能优化：卡片数量多时跳过逐个动画，直接清空
        if (cards.length > 30) {
          infoContainer.innerHTML = `
                          <div style="text-align:center; color:rgba(255,255,255,0.3); margin-top: 50px; font-size: 0.9rem;">
                              <p>等待数据接入...</p>
                              <p style="font-size: 0.8em;">System Ready</p>
                          </div>`;
          _cardCount = 0;
          // 清空markdown缓存释放内存
          _markedCache.clear();
          return;
        }

        cards.forEach((card, index) => {
          card.classList.remove("card-enter");
          card.style.animation = "none";
          void card.offsetHeight;

          setTimeout(() => {
            card.classList.add("is-clearing");
          }, index * 50);
        });

        const animationDuration = 400;
        const lastCardDelay = (cards.length - 1) * 50;

        setTimeout(() => {
          infoContainer.innerHTML = `
                          <div style="text-align:center; color:rgba(255,255,255,0.3); margin-top: 50px; font-size: 0.9rem;">
                              <p>等待数据接入...</p>
                              <p style="font-size: 0.8em;">System Ready</p>
                          </div>`;
          _cardCount = 0;
          _markedCache.clear();
        }, lastCardDelay + animationDuration);
      }

      function copyToClipboard(text, btn) {
        navigator.clipboard.writeText(text).then(() => {
          const originalHTML = btn.innerHTML;
          btn.innerHTML = `<svg class="icon-btn-svg"><use href="#icon-check"></use></svg>`;
          btn.style.color = "#4caf50";
          setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.style.color = "";
          }, 1500);
        });
      }

      function toggleExpand(btn) {
        const wrapper = btn.closest(".content-wrapper");
        if (!wrapper) return;

        const snippet = wrapper.querySelector(".snippet");
        const full = wrapper.querySelector(".full-text");

        // Toggle logic
        if (full.style.display === "block") {
          full.style.display = "none";
          snippet.style.display = "-webkit-box"; // Restore line clamp
          btn.classList.remove("expanded");
        } else {
          // 性能优化：延迟渲染markdown，首次展开时才解析
          const lazyMd = full.getAttribute("data-lazy-md");
          if (lazyMd) {
            full.innerHTML = safeMarkedParse(decodeURIComponent(lazyMd));
            full.removeAttribute("data-lazy-md"); // 只渲染一次
          }
          full.style.display = "block";
          snippet.style.display = "none";
          btn.classList.add("expanded");
        }
      }

      function toggleBM25Tokens(button) {
        const container = button
          ?.closest(".bm25-details-container")
          ?.querySelector(".bm25-token-list");
        if (!container) return;

        const isCollapsed = container.classList.toggle("is-collapsed");
        const extraCount = Number(button.getAttribute("data-extra-count") || 0);
        button.textContent = isCollapsed
          ? `展开 ${extraCount} 个`
          : "收起 BM25 词";
        button.setAttribute("aria-expanded", String(!isCollapsed));
      }

      // --- Block Generators ---

      // Helper to create generic toggle-able text
      // 性能优化：长文本延迟渲染markdown，只在展开时才解析
      function createContentHTML(text) {
        if (text === undefined || text === null) return "";
        text = String(text);
        const isLong = text.length > 150;

        if (!isLong) {
          const rendered = safeMarkedParse(text);
          return `<div class="text-content">${rendered}</div>`;
        }

        // 长文本：snippet用纯文本，full-text标记为lazy，展开时才渲染markdown
        const encodedText = encodeURIComponentForInlineAttribute(text);

        return `
                      <div class="content-wrapper">
                          <div class="text-content">
                              <div class="snippet">${escapeHTML(text)}</div>
                              <div class="full-text" data-lazy-md="${encodedText}"></div>
                          </div>
                          <div class="action-row">
                              <button class="icon-btn" title="复制" onclick="copyToClipboard(decodeURIComponent('${encodedText}'), this)">
                                  <svg><use href="#icon-copy"></use></svg>
                              </button>
                              <button class="icon-btn" title="展开/收起" onclick="toggleExpand(this)">
                                  <svg class="toggle-arrow"><use href="#icon-chevron"></use></svg>
                              </button>
                          </div>
                      </div>
                  `;
      }

      function formatRiverMemoNumber(value, digits = 0) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return "N/A";
        return digits > 0 ? numeric.toFixed(digits) : numeric.toLocaleString();
      }

      function createRiverMemoHTML(data) {
        if (!data?.useRiverMemo || !data.riverMemo || typeof data.riverMemo !== "object") {
          return "";
        }

        const memo = data.riverMemo;
        const omega = Number(memo.omega);
        const omegaDisplay = Number.isFinite(omega) ? omega.toFixed(4) : "N/A";
        const omegaPercent = Number.isFinite(omega)
          ? `${Math.max(0, Math.min(100, omega * 100)).toFixed(1)}%`
          : "N/A";
        const offered = Number(memo.offeredCandidates);
        const ranked = Number(memo.rankedCandidates);
        const returned = Number(memo.returnedCandidates);
        const rankRate =
          Number.isFinite(offered) && offered > 0 && Number.isFinite(ranked)
            ? `${((ranked / offered) * 100).toFixed(1)}%`
            : "N/A";
        const returnRate =
          Number.isFinite(ranked) && ranked > 0 && Number.isFinite(returned)
            ? `${((returned / ranked) * 100).toFixed(1)}%`
            : "N/A";
        const rawRegime = String(memo.regime || "unknown").toLowerCase();
        const regimeClass = ["sparse", "dense", "balanced"].includes(rawRegime)
          ? rawRegime
          : "unknown";
        const regimeLabels = {
          sparse: "稀疏地形",
          dense: "致密地形",
          balanced: "均衡地形",
          unknown: "未知地形",
        };
        const artifactSig = String(memo.artifactSig || "");
        const queryId = String(memo.queryId || "");

        return `
          <div class="rivermemo-panel" title="RiverMemo 动态置信度与候选河网统计">
            <div class="rivermemo-header">
              <div class="rivermemo-title">
                <span>≋</span>
                <span>RiverMemo · Ω 动态置信度场</span>
              </div>
              <span class="rivermemo-regime regime-${regimeClass}">${regimeLabels[regimeClass]}</span>
            </div>
            <div class="rivermemo-metrics">
              <div class="rivermemo-metric">
                <div class="rivermemo-metric-label">Ω 可观测性</div>
                <div class="rivermemo-metric-value">${escapeHTML(omegaDisplay)}</div>
              </div>
              <div class="rivermemo-metric">
                <div class="rivermemo-metric-label">三维置信度</div>
                <div class="rivermemo-metric-value">${escapeHTML(omegaPercent)}</div>
              </div>
              <div class="rivermemo-metric">
                <div class="rivermemo-metric-label">排序保留率</div>
                <div class="rivermemo-metric-value">${escapeHTML(rankRate)}</div>
              </div>
              <div class="rivermemo-metric">
                <div class="rivermemo-metric-label">最终收束率</div>
                <div class="rivermemo-metric-value">${escapeHTML(returnRate)}</div>
              </div>
            </div>
            <div class="rivermemo-funnel" title="候选供给 → 拓扑排序 → 最终返回">
              <span class="rivermemo-funnel-node">供给 ${escapeHTML(formatRiverMemoNumber(offered))}</span>
              <span class="rivermemo-funnel-arrow">→</span>
              <span class="rivermemo-funnel-node">排序 ${escapeHTML(formatRiverMemoNumber(ranked))}</span>
              <span class="rivermemo-funnel-arrow">→</span>
              <span class="rivermemo-funnel-node">返回 ${escapeHTML(formatRiverMemoNumber(returned))}</span>
            </div>
            ${
              artifactSig || queryId
                ? `<div class="rivermemo-identifiers">
                    ${artifactSig ? `<span title="${escapeHTML(artifactSig)}">SIG ${escapeHTML(artifactSig.slice(0, 12))}…</span>` : ""}
                    ${queryId ? `<span title="${escapeHTML(queryId)}">QID ${escapeHTML(queryId)}</span>` : ""}
                  </div>`
                : ""
            }
          </div>
        `;
      }

      function buildRagCardHTML(data, options = {}) {
        const mode = options.mode === "compare" ? "compare" : "normal";
        const cardId = String(options.cardId || "");
        const slot = options.slot === "B" ? "B" : "A";
        const otherItemsTextSet =
          options.otherItemsTextSet instanceof Set
            ? options.otherItemsTextSet
            : new Set();
        const results = Array.isArray(data.results) ? data.results : [];

        let coreTagsHTML = "";
        if (Array.isArray(data.coreTags) && data.coreTags.length > 0) {
          coreTagsHTML = `
                          <div class="core-tags-container" title="显性意图核心标签">
                              ${data.coreTags
                                .map(
                                  (tag) =>
                                    `<span class="core-tag-pill">${escapeHTML(
                                      String(tag)
                                    )}</span>`
                                )
                                .join("")}
                          </div>
                      `;
        }

        let bm25DetailsHTML = "";
        if (data.useBM25) {
          const bm25ModeLabel =
            data.bm25Mode === "tag"
              ? "标签模式"
              : data.bm25Mode === "text"
              ? "全文模式"
              : data.bm25Mode
              ? String(data.bm25Mode)
              : "未知模式";
          const rawBM25Tokens = Array.isArray(data.bm25QueryTokens)
            ? data.bm25QueryTokens
                .map((token) => String(token).trim())
                .filter(Boolean)
            : [];
          const seenBM25TokenKeys = new Set();
          const bm25Tokens = [];
          rawBM25Tokens.forEach((token) => {
            const normalizedKey = token.toLowerCase();
            if (!normalizedKey || seenBM25TokenKeys.has(normalizedKey)) return;
            seenBM25TokenKeys.add(normalizedKey);
            bm25Tokens.push(token);
          });

          const resultTextForBM25 = results
            .map((result) => `${result?.text || ""} ${result?.source || ""}`)
            .join("\n")
            .toLowerCase();
          const matchedBM25Tokens = [];
          const matchedBM25TokenKeys = new Set();
          const otherBM25Tokens = [];
          bm25Tokens.forEach((token) => {
            const normalizedToken = token.toLowerCase();
            if (normalizedToken && resultTextForBM25.includes(normalizedToken)) {
              matchedBM25Tokens.push(token);
              matchedBM25TokenKeys.add(normalizedToken);
            } else {
              otherBM25Tokens.push(token);
            }
          });

          const orderedBM25Tokens = [...matchedBM25Tokens, ...otherBM25Tokens];
          const bm25PreviewLimit = Math.max(
            8,
            Math.min(16, matchedBM25Tokens.length || 8)
          );
          const shouldCollapseBM25Tokens =
            orderedBM25Tokens.length > bm25PreviewLimit;
          const bm25TokenHTML = orderedBM25Tokens
            .map((token, index) => {
              const isMatched = matchedBM25TokenKeys.has(token.toLowerCase());
              const extraClass =
                shouldCollapseBM25Tokens && index >= bm25PreviewLimit
                  ? " bm25-token-extra"
                  : "";
              return `<span class="bm25-token-pill${
                isMatched ? " is-matched" : ""
              }${extraClass}">${escapeHTML(String(token))}</span>`;
            })
            .join("");
          const bm25ExtraCount = Math.max(
            0,
            orderedBM25Tokens.length - bm25PreviewLimit
          );
          const bm25TokenToggleHTML = shouldCollapseBM25Tokens
            ? `<button class="bm25-token-toggle" type="button" aria-expanded="false" data-extra-count="${bm25ExtraCount}" onclick="toggleBM25Tokens(this)">展开 ${bm25ExtraCount} 个</button>`
            : "";
          bm25DetailsHTML = `
                          <div class="bm25-details-container" title="BM25 查询词与命中统计">
                              <span class="bm25-token-pill" style="color:#fff; background:rgba(52,152,219,0.28); border-color:rgba(52,152,219,0.65);">BM25: ${escapeHTML(
                                bm25ModeLabel
                              )}</span>
                              <span class="bm25-token-pill">Matched: ${escapeHTML(
                                String(data.bm25MatchedCount ?? 0)
                              )}</span>
                              <span class="bm25-token-pill">Tokens: ${escapeHTML(
                                rawBM25Tokens.length === orderedBM25Tokens.length
                                  ? String(orderedBM25Tokens.length)
                                  : `${orderedBM25Tokens.length}/${rawBM25Tokens.length}`
                              )}</span>
                              <span class="bm25-token-list${
                                shouldCollapseBM25Tokens ? " is-collapsed" : ""
                              }">${bm25TokenHTML}</span>
                              ${bm25TokenToggleHTML}
                          </div>
                      `;
        }

        const riverMemoHTML = createRiverMemoHTML(data);
        const rawDataId = "raw_" + ++_rawDataIdCounter;
        _rawDataStore.set(rawDataId, JSON.stringify(data, null, 2));
        const compareActionsHTML =
          mode === "normal" && cardId
            ? `
                      <div class="compare-card-actions" data-card-id="${cardId}">
                          <button class="compare-card-slot-btn" type="button" data-slot="A" aria-label="设为 A 轮" onclick="event.stopPropagation(); setCardAsSlot('A', '${cardId}')">设为 A</button>
                          <button class="compare-card-slot-btn" type="button" data-slot="B" aria-label="设为 B 轮" onclick="event.stopPropagation(); setCardAsSlot('B', '${cardId}')">设为 B</button>
                      </div>
                  `
            : "";

        let headerHTML = `
                      <button class="card-raw-copy-btn" title="复制原始JSON数据" onclick="copyRawData('${rawDataId}', this)">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
                      </button>
                      ${compareActionsHTML}
                      <h3>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
                          ${escapeHTML(String(data.dbName || "Unknown"))}
                      </h3>
                      <div class="meta-info">
                          <span class="meta-pill">K: ${escapeHTML(
                            String(data.k ?? "N/A")
                          )}</span>
                          <span class="meta-pill">Time: ${escapeHTML(
                            String(!!data.useTime)
                          )}</span>
                          <span class="meta-pill">Group: ${escapeHTML(
                            String(!!data.useGroup)
                          )}</span>
                          <span class="meta-pill">VirtualIndex: ${escapeHTML(
                            String(!!data.virtualIndex)
                          )}</span>
                          <span class="meta-pill">ReRank: ${escapeHTML(
                            String(!!data.useRerank)
                          )}</span>
                          ${
                            data.useRiverMemo
                              ? `<span class="meta-pill" style="color:#8ff5dc; border-color:rgba(26,188,156,0.65);">RiverMemo: ON</span>`
                              : ""
                          }
                          ${
                            data.fromCache
                              ? `<span class="meta-pill" style="color:#b8c7ff; border-color:rgba(155,89,182,0.6);">Cache Hit</span>`
                              : ""
                          }
                          ${
                            data.useBM25
                              ? `<span class="meta-pill" style="color:#8fd3ff; border-color:#3498db;">BM25: ${escapeHTML(
                                  String(data.bm25Mode || "on")
                                )}</span>`
                              : ""
                          }
                          ${
                            data.useTagMemo
                              ? `<span class="meta-pill" style="color:#ffc107; border-color:#ffc107;">TagBoost: ${escapeHTML(
                                  String(data.tagWeight)
                                )}</span>`
                              : ""
                          }
                          ${
                            data.useGeodesicRerank
                              ? `<span class="meta-pill" style="color:#1abc9c; border-color:#1abc9c;">GeoReRank: true</span>`
                              : ""
                          }
                          ${
                            data.geoAlpha !== undefined &&
                            data.geoAlpha !== null
                              ? `<span class="meta-pill" style="color:#1abc9c; border-color:#1abc9c;">geoAlpha: ${escapeHTML(
                                  String(data.geoAlpha)
                                )}</span>`
                              : ""
                          }
                      </div>
                      ${riverMemoHTML}
                      ${bm25DetailsHTML}
                      ${coreTagsHTML}
                      ${createContentHTML(data.query)}
                  `;

        let resultsHTML = "";
        results.forEach((r) => {
          const hasScore = typeof r.score === "number";
          const scoreDisplay = hasScore ? r.score.toFixed(3) : "Time";
          const scoreClass = hasScore
            ? r.score >= 0.8
              ? "score-high"
              : r.score >= 0.5
              ? "score-med"
              : "score-low"
            : "score-med";
          const isBoosted =
            data.useTagMemo &&
            typeof r.originalScore === "number" &&
            r.originalScore !== r.score;

          let bm25ScoresHTML = "";
          if (data.useBM25 || r.source === "bm25" || r.source === "bm25_tag") {
            const bm25ScoreParts = [];
            if (typeof r.bm25Score === "number") {
              bm25ScoreParts.push(
                `<span class="meta-pill">BM25: ${r.bm25Score.toFixed(4)}</span>`
              );
            }
            if (typeof r.normalizedBM25Score === "number") {
              bm25ScoreParts.push(
                `<span class="meta-pill">Norm: ${r.normalizedBM25Score.toFixed(
                  4
                )}</span>`
              );
            }
            if (bm25ScoreParts.length > 0) {
              bm25ScoresHTML = `<div class="bm25-score-row" style="margin-bottom:6px;">${bm25ScoreParts.join(
                ""
              )}</div>`;
            }
          }

          let tagsHTML = "";
          const isTimeRecall =
            r.source === "time" || !r.matchedTags || r.matchedTags.length === 0;
          const globalUniqueTags = (
            (data.tagStats && data.tagStats.uniqueMatchedTags) ||
            []
          ).filter((tag) => tag !== "time" && tag !== "Time");
          const resultMatchedTags = new Set(
            (r.matchedTags || []).filter(
              (tag) => tag !== "time" && tag !== "Time"
            )
          );
          const allTagsSet = new Set([
            ...globalUniqueTags,
            ...resultMatchedTags,
          ]);

          if (allTagsSet.size > 0 && !isTimeRecall) {
            const sortedTags = [...allTagsSet].sort((a, b) => {
              const aIsMatched = resultMatchedTags.has(a);
              const bIsMatched = resultMatchedTags.has(b);
              if (aIsMatched && !bIsMatched) return -1;
              if (!aIsMatched && bIsMatched) return 1;
              return 0;
            });
            const renderedTags = sortedTags
              .map((tag) =>
                resultMatchedTags.has(tag)
                  ? `<span class="tag-match-highlight">${escapeHTML(
                      String(tag)
                    )}</span>`
                  : escapeHTML(String(tag))
              )
              .join(", ");
            const hasMatched = resultMatchedTags.size > 0;
            const tagIcon = hasMatched
              ? `<span style="filter: drop-shadow(0 0 5px #ffc107); color: #ffc107; font-weight: bold;">🏷️</span>`
              : `🏷️`;
            tagsHTML = `<div style="margin-top:4px; font-size:0.75em; color:rgba(255,193,7,0.6);">${tagIcon} ${renderedTags}</div>`;
          }

          let diffBadgeHTML = "";
          if (mode === "compare") {
            const isCommon = otherItemsTextSet.has(normalizeCompareContent(r));
            const diffClass = isCommon ? "diff-common" : `diff-unique-${slot.toLowerCase()}`;
            const diffLabel = isCommon ? "共同召回" : `仅 ${slot} 召回`;
            diffBadgeHTML = `<span class="diff-badge ${diffClass}">${diffLabel}</span>`;
          }

          resultsHTML += `
                          <div class="rag-sub-item">
                              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:6px;">
                                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                                      <span class="score-badge ${
                                        isBoosted ? "score-boosted" : scoreClass
                                      }">
                                          ${scoreDisplay} ${
                                            isBoosted ? "⚡" : ""
                                          }
                                      </span>
                                      ${diffBadgeHTML}
                                  </div>
                                  <span style="font-size:0.75em; opacity:0.6; flex:0 0 auto;">${escapeHTML(
                                    String(r.source || "Unknown")
                                  )}</span>
                              </div>
                              ${bm25ScoresHTML}
                              ${createContentHTML(r.text)}
                              ${tagsHTML}
                          </div>
                      `;
        });

        return headerHTML + `<div style="margin-top:15px;">${resultsHTML}</div>`;
      }

      // 1. RAG BLOCK
      function displayRagInfo(data) {
        // 审批类消息（请求/响应）不受分区开关影响，
        // 需要先驱动悬浮窗以清理 pendingApprovals 状态
        const isApprovalMsg =
          data?.type === "tool_approval_request" ||
          data?.type === "tool_approval_response";
        const partitionKey = getPartitionKeyForData(data);

        if (!isPartitionEnabled(partitionKey) && !isApprovalMsg) {
          return;
        }

        // 所有消息统一驱动外部悬浮通知窗（仅消息到达时显现）
        notifyOverlayFromData(data);

        if (!isPartitionEnabled(partitionKey)) {
          return;
        }

        // Handle specialized types first — 使用消息节流队列
        if (data.type === "AGENT_PRIVATE_CHAT_PREVIEW")
          return enqueueMessage(displayAgentChat, data);
        if (data.type === "META_THINKING_CHAIN")
          return enqueueMessage(displayChain, data);
        if (data.type === "AI_MEMO_RETRIEVAL")
          return enqueueMessage(displayMemo, data);
        if (data.type.startsWith("AGENT_DREAM_"))
          return enqueueMessage(displayDreamInfo, data);
        if (data.type === "DailyNote")
          return enqueueMessage(displayDailyNote, data);
        if (data.source === "AgentAssistant")
          return enqueueMessage(displayAgentAssistantNotification, data);
        if (data.type === "tool_approval_request")
          return enqueueMessage(displayToolApprovalRequest, data);
        if (isNotificationData(data))
          return enqueueMessage(displaySystemNotification, data);

        {
          const cardId = `rag_${++_compareCardIdCounter}`;
          const block = document.createElement("div");
          block.className = "card-base type-rag card-enter";
          block.dataset.compareCardId = cardId;
          const card = {
            cardId,
            data,
            el: block,
          };
          _compareCardStore.set(cardId, card);
          block.innerHTML = buildRagCardHTML(data, {
            mode: "normal",
            cardId,
          });
          prependCard(block);
          updateCompareBar();
          return;
        }

        if (false) {
        const block = document.createElement("div");
        block.className = "card-base type-rag card-enter";
        const compareCardId = `rag_${++_compareCardIdCounter}`;
        const compareCard = {
          cardId: compareCardId,
          query: String(data.query || ""),
          coreTags: Array.isArray(data.coreTags)
            ? data.coreTags.map((tag) => String(tag))
            : [],
          dbName: String(data.dbName || "Unknown"),
          itemIds: [],
        };
        (data.results || []).forEach((result, index) => {
          const snapshot = createCompareSnapshot(
            compareCardId,
            data,
            result,
            index
          );
          compareCard.itemIds.push(snapshot.id);
        });
        _compareCardStore.set(compareCardId, compareCard);
        block.dataset.compareCardId = compareCardId;

        // Core Tags (Spotlight)
        let coreTagsHTML = "";
        if (data.coreTags && data.coreTags.length > 0) {
          coreTagsHTML = `
                          <div class="core-tags-container" title="显性意图核心标签">
                              ${data.coreTags
                                .map(
                                  (tag) =>
                                    `<span class="core-tag-pill">${escapeHTML(
                                      String(tag)
                                    )}</span>`
                                )
                                .join("")}
                          </div>
                      `;
        }

        // BM25 Details
        let bm25DetailsHTML = "";
        if (data.useBM25) {
          const bm25ModeLabel =
            data.bm25Mode === "tag"
              ? "标签模式"
              : data.bm25Mode === "text"
              ? "全文模式"
              : data.bm25Mode
              ? String(data.bm25Mode)
              : "未知模式";
          const rawBM25Tokens = Array.isArray(data.bm25QueryTokens)
            ? data.bm25QueryTokens.map((token) => String(token).trim()).filter(Boolean)
            : [];
          const seenBM25TokenKeys = new Set();
          const bm25Tokens = [];
          rawBM25Tokens.forEach((token) => {
            const normalizedKey = token.toLowerCase();
            if (!normalizedKey || seenBM25TokenKeys.has(normalizedKey)) return;
            seenBM25TokenKeys.add(normalizedKey);
            bm25Tokens.push(token);
          });

          const resultTextForBM25 = (data.results || [])
            .map((result) => `${result?.text || ""} ${result?.source || ""}`)
            .join("\n")
            .toLowerCase();
          const matchedBM25Tokens = [];
          const matchedBM25TokenKeys = new Set();
          const otherBM25Tokens = [];
          bm25Tokens.forEach((token) => {
            const normalizedToken = token.toLowerCase();
            if (normalizedToken && resultTextForBM25.includes(normalizedToken)) {
              matchedBM25Tokens.push(token);
              matchedBM25TokenKeys.add(normalizedToken);
            } else {
              otherBM25Tokens.push(token);
            }
          });

          const orderedBM25Tokens = [...matchedBM25Tokens, ...otherBM25Tokens];
          const bm25PreviewLimit = Math.max(
            8,
            Math.min(16, matchedBM25Tokens.length || 8)
          );
          const shouldCollapseBM25Tokens =
            orderedBM25Tokens.length > bm25PreviewLimit;
          const bm25TokenHTML = orderedBM25Tokens
            .map((token, index) => {
              const isMatched = matchedBM25TokenKeys.has(token.toLowerCase());
              const extraClass =
                shouldCollapseBM25Tokens && index >= bm25PreviewLimit
                  ? " bm25-token-extra"
                  : "";
              return `<span class="bm25-token-pill${
                isMatched ? " is-matched" : ""
              }${extraClass}">${escapeHTML(String(token))}</span>`;
            })
            .join("");
          const bm25ExtraCount = Math.max(
            0,
            orderedBM25Tokens.length - bm25PreviewLimit
          );
          const bm25TokenToggleHTML = shouldCollapseBM25Tokens
            ? `<button class="bm25-token-toggle" type="button" aria-expanded="false" data-extra-count="${bm25ExtraCount}" onclick="toggleBM25Tokens(this)">展开 ${bm25ExtraCount} 个</button>`
            : "";
          bm25DetailsHTML = `
                          <div class="bm25-details-container" title="BM25 查询词与命中统计">
                              <span class="bm25-token-pill" style="color:#fff; background:rgba(52,152,219,0.28); border-color:rgba(52,152,219,0.65);">BM25: ${escapeHTML(
                                bm25ModeLabel
                              )}</span>
                              <span class="bm25-token-pill">Matched: ${escapeHTML(
                                String(data.bm25MatchedCount ?? 0)
                              )}</span>
                              <span class="bm25-token-pill">Tokens: ${escapeHTML(
                                rawBM25Tokens.length === orderedBM25Tokens.length
                                  ? String(orderedBM25Tokens.length)
                                  : `${orderedBM25Tokens.length}/${rawBM25Tokens.length}`
                              )}</span>
                              <span class="bm25-token-list${
                                shouldCollapseBM25Tokens ? " is-collapsed" : ""
                              }">${bm25TokenHTML}</span>
                              ${bm25TokenToggleHTML}
                          </div>
                      `;
        }

        const riverMemoHTML = createRiverMemoHTML(data);

        // Header
        // 用于复制原始数据：存入 Map，按 ID 索引，避免内联字符串转义问题
        const rawDataId = "raw_" + ++_rawDataIdCounter;
        _rawDataStore.set(rawDataId, JSON.stringify(data, null, 2));

        let headerHTML = `
                      <button class="card-raw-copy-btn" title="复制原始JSON数据" onclick="copyRawData('${rawDataId}', this)">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
                      </button>
                      <div class="compare-card-actions" data-card-id="${compareCardId}">
                          <button class="compare-select-action compare-card-action" type="button" data-slot="A" onclick="event.stopPropagation(); addEntireCardToSlot('A', '${compareCardId}')">+A 全部</button>
                          <button class="compare-select-action compare-card-action" type="button" data-slot="B" onclick="event.stopPropagation(); addEntireCardToSlot('B', '${compareCardId}')">+B 全部</button>
                      </div>
                      <h3>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
                          ${escapeHTML(String(data.dbName || "Unknown"))}
                      </h3>
                      <div class="meta-info">
                          <span class="meta-pill">K: ${escapeHTML(
                            String(data.k ?? "N/A")
                          )}</span>
                          <span class="meta-pill">Time: ${escapeHTML(
                            String(!!data.useTime)
                          )}</span>
                          <span class="meta-pill">Group: ${escapeHTML(
                            String(!!data.useGroup)
                          )}</span>
                          <span class="meta-pill">VirtualIndex: ${escapeHTML(
                            String(!!data.virtualIndex)
                          )}</span>
                          <span class="meta-pill">ReRank: ${escapeHTML(
                            String(!!data.useRerank)
                          )}</span>
                          ${
                            data.useRiverMemo
                              ? `<span class="meta-pill" style="color:#8ff5dc; border-color:rgba(26,188,156,0.65);">RiverMemo: ON</span>`
                              : ""
                          }
                          ${
                            data.fromCache
                              ? `<span class="meta-pill" style="color:#b8c7ff; border-color:rgba(155,89,182,0.6);">Cache Hit</span>`
                              : ""
                          }
                          ${
                            data.useBM25
                              ? `<span class="meta-pill" style="color:#8fd3ff; border-color:#3498db;">BM25: ${escapeHTML(
                                  String(data.bm25Mode || "on")
                                )}</span>`
                              : ""
                          }
                          ${
                            data.useTagMemo
                              ? `<span class="meta-pill" style="color:#ffc107; border-color:#ffc107;">TagBoost: ${escapeHTML(
                                  String(data.tagWeight)
                                )}</span>`
                              : ""
                          }
                          ${
                            data.useGeodesicRerank
                              ? `<span class="meta-pill" style="color:#1abc9c; border-color:#1abc9c;">GeoReRank: true</span>`
                              : ""
                          }
                          ${
                            data.geoAlpha !== undefined &&
                            data.geoAlpha !== null
                              ? `<span class="meta-pill" style="color:#1abc9c; border-color:#1abc9c;">geoAlpha: ${escapeHTML(
                                  String(data.geoAlpha)
                                )}</span>`
                              : ""
                          }
                      </div>
                      ${riverMemoHTML}
                      ${bm25DetailsHTML}
                      ${coreTagsHTML}
                      ${createContentHTML(data.query)}
                  `;

        // Results
        let resultsHTML = "";
        (data.results || []).forEach((r, resultIndex) => {
          // BUG FIX: Check if r.score is a valid number before calling toFixed().
          // Time-based results from the backend don't have a score, which was causing a rendering crash.
          const hasScore = typeof r.score === "number";
          const scoreDisplay = hasScore ? r.score.toFixed(3) : "Time"; // Display 'Time' for time-based results
          const scoreClass = hasScore
            ? r.score >= 0.8
              ? "score-high"
              : r.score >= 0.5
              ? "score-med"
              : "score-low"
            : "score-med";
          const isBoosted =
            data.useTagMemo && r.originalScore && r.originalScore !== r.score;

          let bm25ScoresHTML = "";
          if (data.useBM25 || r.source === "bm25" || r.source === "bm25_tag") {
            const bm25ScoreParts = [];
            if (typeof r.bm25Score === "number") {
              bm25ScoreParts.push(
                `<span class="meta-pill">BM25: ${r.bm25Score.toFixed(
                  4
                )}</span>`
              );
            }
            if (typeof r.normalizedBM25Score === "number") {
              bm25ScoreParts.push(
                `<span class="meta-pill">Norm: ${r.normalizedBM25Score.toFixed(
                  4
                )}</span>`
              );
            }
            if (bm25ScoreParts.length > 0) {
              bm25ScoresHTML = `<div class="bm25-score-row" style="margin-bottom:6px;">${bm25ScoreParts.join(
                ""
              )}</div>`;
            }
          }

          let tagsHTML = "";
          // 时间召回的结果（source === 'time'）不显示标签区域
          const isTimeRecall =
            r.source === "time" || !r.matchedTags || r.matchedTags.length === 0;
          // 收集全局唯一标签池 (uniqueMatchedTags) 和当前 result 的 matchedTags
          const globalUniqueTags = (
            (data.tagStats && data.tagStats.uniqueMatchedTags) ||
            []
          ).filter((t) => t !== "time" && t !== "Time");
          const resultMatchedTags = new Set(
            (r.matchedTags || []).filter((t) => t !== "time" && t !== "Time")
          );
          // 合并去重：全局 uniqueMatchedTags + 当前 matchedTags
          const allTagsSet = new Set([
            ...globalUniqueTags,
            ...resultMatchedTags,
          ]);

          if (allTagsSet.size > 0 && !isTimeRecall) {
            // 排序：当前 result 匹配命中的标签排在前面
            const sortedTags = [...allTagsSet].sort((a, b) => {
              const aIsMatched = resultMatchedTags.has(a);
              const bIsMatched = resultMatchedTags.has(b);
              if (aIsMatched && !bIsMatched) return -1;
              if (!aIsMatched && bIsMatched) return 1;
              return 0;
            });

            const renderedTags = sortedTags
              .map((tag) => {
                if (resultMatchedTags.has(tag)) {
                  return `<span class="tag-match-highlight">${escapeHTML(
                    String(tag)
                  )}</span>`;
                }
                return escapeHTML(String(tag));
              })
              .join(", ");

            const hasMatched = resultMatchedTags.size > 0;
            const tagIcon = hasMatched
              ? `<span style="filter: drop-shadow(0 0 5px #ffc107); color: #ffc107; font-weight: bold;">🏷️</span>`
              : `🏷️`;

            tagsHTML = `<div style="margin-top:4px; font-size:0.75em; color:rgba(255,193,7,0.6);">${tagIcon} ${renderedTags}</div>`;
          }

          resultsHTML += `
                          <div class="rag-sub-item" data-compare-id="${compareCardId}_${resultIndex}">
                              <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                                  <span class="score-badge ${
                                    isBoosted ? "score-boosted" : scoreClass
                                  }">
                                      ${scoreDisplay} ${isBoosted ? "⚡" : ""}
                                  </span>
                                  <div style="display:flex; align-items:center; gap:6px;">
                                      <span style="font-size:0.75em; opacity:0.6;">${escapeHTML(
                                        String(r.source || "Unknown")
                                      )}</span>
                                      <button class="compare-select-action" type="button" data-compare-id="${compareCardId}_${resultIndex}" data-slot="A" aria-label="加入 A 槽" onclick="event.stopPropagation(); toggleItemInSlot('A', '${compareCardId}_${resultIndex}')">A</button>
                                      <button class="compare-select-action" type="button" data-compare-id="${compareCardId}_${resultIndex}" data-slot="B" aria-label="加入 B 槽" onclick="event.stopPropagation(); toggleItemInSlot('B', '${compareCardId}_${resultIndex}')">B</button>
                                  </div>
                              </div>
                              ${bm25ScoresHTML}
                              ${createContentHTML(r.text)}
                              ${tagsHTML}
                          </div>
                      `;
        });

        block.innerHTML =
          headerHTML + `<div style="margin-top:15px;">${resultsHTML}</div>`;
        prependCard(block);
        updateCompareUI();
      }
        }

      // 2. CHAIN BLOCK
      function displayChain(data) {
        const block = document.createElement("div");
        block.className = "card-base type-chain card-enter";

        // Chain Path Visualization
        const stagesPath = data.stages
          .map((s) => s.clusterName)
          .join(' <span style="opacity:0.4;">→</span> ');

        let headerHTML = `
                      <h3 style="color: var(--accent-chain);">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
                          元思考链: ${data.chainName}
                      </h3>
                      <div class="meta-info" style="color:var(--accent-chain); font-weight:600;">
                          ${stagesPath}
                      </div>
                      ${createContentHTML(data.query)}
                  `;

        let stagesHTML = "";
        if (data.stages && data.stages.length > 0) {
          data.stages.forEach((stage) => {
            let resultsHTML = "";
            if (stage.results && stage.results.length > 0) {
              stage.results.forEach((r) => {
                resultsHTML += `
                                      <div class="rag-sub-item" style="background:rgba(0,0,0,0.1); margin-top:8px;">
                                           <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                                              <span class="score-badge score-med">
                                                  Score: ${
                                                    r.score
                                                      ? r.score.toFixed(3)
                                                      : "N/A"
                                                  }
                                              </span>
                                              <span style="font-size:0.75em; opacity:0.6;">${
                                                r.source || "Unknown"
                                              }</span>
                                          </div>
                                          ${createContentHTML(r.text)}
                                      </div>
                                  `;
              });
            } else {
              resultsHTML = `<div class="rag-sub-item" style="background:rgba(0,0,0,0.1); margin-top:8px; font-style:italic; color:rgba(255,255,255,0.5);">本阶段无结果</div>`;
            }

            stagesHTML += `
                              <div class="rag-sub-item" style="margin-top:15px; border-left: 2px solid var(--accent-chain);">
                                  <div style="font-weight:bold; color: #fff; margin-bottom: 8px;">
                                      阶段 ${stage.stage}: ${stage.clusterName} (${stage.resultCount}个结果)
                                  </div>
                                  ${resultsHTML}
                              </div>
                          `;
          });
        }

        block.innerHTML =
          headerHTML + `<div style="margin-top:15px;">${stagesHTML}</div>`;
        prependCard(block);
      }

      // 3. AGENT CHAT BLOCK
      function displayAgentChat(data) {
        const block = document.createElement("div");
        block.className = "card-base type-chat card-enter";
        block.innerHTML = `
                      <h3 style="color: var(--accent-agent);">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                          Agent 私聊: ${data.agentName}
                      </h3>
                      <div style="margin-top:10px; padding-left:10px; border-left:2px solid rgba(255,255,255,0.1);">
                          <div style="font-size:0.8em; opacity:0.5; margin-bottom:4px;">USER</div>
                          ${createContentHTML(data.query)}
                      </div>
                      <div style="margin-top:15px; padding-left:10px; border-left:2px solid var(--accent-agent);">
                          <div style="font-size:0.8em; color:var(--accent-agent); margin-bottom:4px;">AI RESPONSE</div>
                          ${createContentHTML(data.response)}
                      </div>
                  `;
        prependCard(block);
      }

      // 4. MEMO BLOCK
      function displayMemo(data) {
        const block = document.createElement("div");
        block.className = "card-base type-memo card-enter";
        block.innerHTML = `
                      <h3 style="color: var(--accent-memo);">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                          记忆回溯 (${data.diaryCount || 0})
                      </h3>
                      <div class="meta-info">模式: ${data.mode}</div>
                      ${createContentHTML(data.extractedMemories)}
                  `;
        prependCard(block);
      }

      // 5. DAILY NOTE BLOCK
      function displayDailyNote(data) {
        const block = document.createElement("div");
        block.className = "card-base type-memo card-enter"; // Reuse memo style

        const isFullText = data.action === "FullTextRecall";
        const icon = isFullText
          ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>'
          : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>';

        block.innerHTML = `
                      <h3 style="color: var(--accent-memo);">
                          ${icon}
                          日记召回: ${data.dbName}
                      </h3>
                      <div class="meta-info">
                          <span class="meta-pill">模式: ${
                            isFullText ? "全量召回 <<>>" : "直接引入 {{}}"
                          }</span>
                      </div>
                      <div style="color: var(--accent-memo); font-weight: bold; padding: 10px; background: rgba(26, 188, 156, 0.1); border-radius: 8px; border-left: 3px solid var(--accent-memo);">
                          ${escapeHTML(data.message)}
                      </div>
                  `;
        prependCard(block);
      }

      // 6. DREAM BLOCK
      function displayDreamInfo(data) {
        const block = document.createElement("div");
        block.className = "card-base type-dream card-enter";

        let icon =
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>'; // Moon icon
        let title = `Agent 梦境: ${data.agentName}`;
        let contentHTML = "";

        switch (data.type) {
          case "AGENT_DREAM_START":
            contentHTML = `<div style="color: var(--accent-dream); font-weight: bold; padding: 10px; background: rgba(232, 67, 147, 0.1); border-radius: 8px;">${escapeHTML(
              data.message
            )}</div>`;
            break;
          case "AGENT_DREAM_ASSOCIATIONS":
            title += " - 联想召回";
            icon =
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg>'; // Layers icon
            contentHTML = `
                              <div class="meta-info">
                                  <span class="meta-pill">种子数: ${
                                    data.seedCount
                                  }</span>
                                  <span class="meta-pill">联想数: ${
                                    data.associationCount
                                  }</span>
                              </div>
                              <div style="margin-top:10px;">
                                  <div style="font-size:0.8em; opacity:0.6; margin-bottom:5px;">梦境种子:</div>
                                  ${data.seeds
                                    .map(
                                      (s) =>
                                        `<div class="rag-sub-item" style="font-size:0.9em;"><strong>${escapeHTML(
                                          s.file
                                        )}</strong>: ${escapeHTML(
                                          s.snippet
                                        )}</div>`
                                    )
                                    .join("")}
                              </div>
                              <div style="margin-top:10px;">
                                  <div style="font-size:0.8em; opacity:0.6; margin-bottom:5px;">联想内容:</div>
                                  ${data.associations
                                    .map(
                                      (a) =>
                                        `<div class="rag-sub-item" style="font-size:0.9em; display:flex; justify-content:space-between;"><span>${escapeHTML(
                                          a.file
                                        )}</span><span class="score-badge score-med">${escapeHTML(
                                          String(a.score)
                                        )}</span></div>`
                                    )
                                    .join("")}
                              </div>
                          `;
            break;
          case "AGENT_DREAM_NARRATIVE":
            title += " - 梦叙事";
            icon =
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>'; // Book icon
            contentHTML = `
                              <div class="meta-info"><span class="meta-pill">全长: ${
                                data.fullLength
                              } 字</span></div>
                              ${createContentHTML(data.narrative)}
                          `;
            break;
          case "AGENT_DREAM_OPERATIONS":
            title += " - 梦操作";
            icon =
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>'; // Activity icon
            contentHTML = `
                              <div class="meta-info">
                                  <span class="meta-pill">操作数: ${
                                    data.operationCount
                                  }</span>
                                  <span class="meta-pill">日志: ${
                                    data.logFile
                                  }</span>
                              </div>
                              <div style="margin-top:10px;">
                                  ${data.operations
                                    .map(
                                      (op) => `
                                      <div class="rag-sub-item" style="display:flex; justify-content:space-between; align-items:center;">
                                          <span><code style="color:var(--accent-dream)">${
                                            op.type
                                          }</code> <small style="opacity:0.5;">${
                                        op.operationId
                                      }</small></span>
                                          <span class="score-badge ${
                                            op.status === "pending_review"
                                              ? "score-med"
                                              : "score-high"
                                          }">${op.status}</span>
                                      </div>
                                  `
                                    )
                                    .join("")}
                              </div>
                          `;
            break;
          case "AGENT_DREAM_END":
            title += " - 梦境状态";
            icon =
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'; // X circle icon
            contentHTML = `<div style="color: #ff5f56; font-weight: bold; padding: 10px; background: rgba(255, 95, 86, 0.1); border-radius: 8px;">${escapeHTML(
              data.error || "梦境结束"
            )}</div>`;
            break;
        }

        block.innerHTML = `
                      <h3 style="color: var(--accent-dream);">
                          ${icon}
                          ${title}
                      </h3>
                      <div class="meta-info">
                          <span class="meta-pill">DreamID: ${
                            data.dreamId
                          }</span>
                          <span class="meta-pill">Time: ${new Date(
                            data.timestamp
                          ).toLocaleTimeString()}</span>
                      </div>
                      ${contentHTML}
                  `;
        prependCard(block);
      }

      // 7. NOTIFICATION HELPERS
      function isNotificationData(data) {
        if (!data || typeof data !== "object") return false;
        const notificationTypes = new Set([
          "vcp_log",
          "daily_note_created",
          "video_generation_status",
          "tool_approval_request",
          "tool_approval_response",
          "tool_auto_approval",
          "connection_ack",
          "notification",
        ]);
        return notificationTypes.has(data.type);
      }

      function normalizeNotificationContent(data) {
        if (!data || typeof data !== "object") {
          return {
            title: "通知消息",
            source: "System",
            status: "info",
            content: String(data || "收到一条空通知"),
          };
        }

        if (
          data.type === "vcp_log" &&
          data.data &&
          typeof data.data === "object"
        ) {
          const payload = data.data;
          const friendly = extractFriendlyVcpLogContent(payload);
          return {
            title: friendly.title || "VCP 日志通知",
            source: payload.source || "VCPLog",
            status: payload.status || "info",
            content: friendly.content || "",
          };
        }

        if (
          data.type === "tool_auto_approval" &&
          data.data &&
          typeof data.data === "object"
        ) {
          const auto = data.data;
          return {
            title: `✅ 已自动允许: ${auto.toolName || "未知工具"}`,
            source: "FilterManager",
            status: auto.sent ? "success" : "warning",
            content:
              `助手: ${auto.maid || "未知"}\n` +
              `规则: ${auto.ruleName || "未命名规则"}\n` +
              `请求ID: ${auto.requestId || "N/A"}\n` +
              `状态: ${auto.sent ? "已发送允许响应" : "发送失败"}`,
          };
        }

        if (
          data.type === "daily_note_created" &&
          data.data &&
          typeof data.data === "object"
        ) {
          const note = data.data;
          return {
            title: `日记通知: ${note.maidName || "N/A"}`,
            source: "DailyNote",
            status: note.status || "info",
            content: note.message || JSON.stringify(note, null, 2),
          };
        }

        if (
          data.type === "video_generation_status" &&
          data.data &&
          typeof data.data === "object"
        ) {
          const video = data.data;
          const message =
            video?.original_plugin_output?.message ||
            JSON.stringify(video, null, 2);
          return {
            title: "视频生成状态",
            source: "VideoGenerator",
            status: video.status || "info",
            content:
              typeof message === "string"
                ? message
                : JSON.stringify(message, null, 2),
          };
        }

        const fallbackContent =
          data.message ||
          (data.data
            ? JSON.stringify(data.data, null, 2)
            : JSON.stringify(data, null, 2));
        return {
          title: `通知: ${data.type || "unknown"}`,
          source: data.source || "System",
          status: data.status || "info",
          content: fallbackContent,
        };
      }

      // 8. AGENT ASSISTANT NOTIFICATION BLOCK
      function displayAgentAssistantNotification(data) {
        const block = document.createElement("div");
        block.className = "card-base type-chat card-enter";

        const messageText = String(data.message || "收到一条 Agent 助手通知");
        const isSucceed =
          messageText.includes("Succeed") || messageText.includes("success");
        const isFailed =
          messageText.includes("Failed") || messageText.includes("error");
        const dotClass = isSucceed
          ? "dot-green"
          : isFailed
          ? "dot-red"
          : "dot-orange";

        if (window.pretextBridge && window.pretextBridge.isReady()) {
          const containerWidth = infoContainer.offsetWidth || 500;
          window.pretextBridge.estimateHeight(
            "rag-chat-" + Date.now(),
            messageText,
            "rag",
            containerWidth
          );
        }

        block.innerHTML = `
                      <h3 style="color: var(--accent-agent);">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><polyline points="17 11 19 13 23 9"></polyline></svg>
                          Agent 助手通知
                      </h3>
                      <div class="meta-info">
                          <span class="status-pill" style="margin-bottom:0; background:transparent; border:none; padding:0;">
                              <div class="status-dot ${dotClass}"></div>
                              <span style="color:var(--accent-agent);">${
                                data.source || "AgentAssistant"
                              }</span>
                          </span>
                          <span class="meta-pill">Time: ${new Date().toLocaleTimeString()}</span>
                      </div>
                      <div style="margin-top:10px; padding:12px; background:rgba(241, 196, 15, 0.1); border-radius:8px; border-left:3px solid var(--accent-agent); color:rgba(255,255,255,0.9); font-size:0.95rem;">
                          ${safeMarkedParse(messageText)}
                      </div>
                  `;
        prependCard(block);
      }

      function submitToolApproval(requestId, approved, btnElement = null, reason = "") {
        if (!requestId) {
          console.error("[RAG Observer] 工具审核缺少 requestId，无法提交。");
          return false;
        }

        const trimmedReason =
          typeof reason === "string" ? reason.trim().slice(0, 1000) : "";

        const responseData = {
          requestId,
          approved: !!approved,
        };
        if (trimmedReason) {
          responseData.reason = trimmedReason;
        }

        const payload = {
          type: "tool_approval_response",
          data: responseData,
        };

        let sendOk = false;
        if (typeof window.sendVcpLogMessageFromObserver === "function") {
          sendOk = window.sendVcpLogMessageFromObserver(payload) === true;
        }

        if (
          !sendOk &&
          window.electronAPI &&
          typeof window.electronAPI.sendVCPLogMessage === "function"
        ) {
          // 兜底：如果直连通道未就绪，尝试主进程中转通道
          window.electronAPI.sendVCPLogMessage(payload);
          sendOk = true;
        }

        if (!sendOk) {
          console.error("[RAG Observer] 无可用发送通道，工具审核响应未发出。");
          return false;
        }
        overlayState.pendingApprovalIds.delete(requestId);
        overlayState.pendingApprovals = overlayState.pendingApprovals.filter(
          (p) => p.requestId !== requestId
        );
        if (
          overlayState.pendingApprovals.length === 0 &&
          overlayState.pendingApprovalIds.size === 0
        ) {
          overlayState.passThrough = true;
          scheduleOverlayHide(2000);
        }

        const actions = btnElement?.closest(".approval-actions");
        if (actions) {
          actions.querySelectorAll("button").forEach((btn) => {
            btn.disabled = true;
            if (btn !== btnElement) {
              btn.style.opacity = "0.45";
            }
          });
        }

        if (btnElement) {
          btnElement.textContent = approved ? "已允许" : "已拒绝";
        }

        return true;
      }

      function handleToolApprovalAction(
        encodedRequestId,
        approved,
        btnElement
      ) {
        const requestId = decodeURIComponent(encodedRequestId || "");
        const card = btnElement?.closest(".card-base");
        const reasonInput = card?.querySelector(".tool-approval-reason-input");
        const reason = reasonInput?.value || "";
        submitToolApproval(requestId, approved, btnElement, reason);
      }

      // 9. TOOL APPROVAL REQUEST BLOCK
      function displayToolApprovalRequest(data) {
        const block = document.createElement("div");
        block.className = "card-base type-notification card-enter";

        const approvalData =
          data && typeof data.data === "object" && data.data ? data.data : {};
        const requestId = String(approvalData.requestId || "");
        const toolName = approvalData.toolName || "未知工具";
        const maidName = approvalData.maid || "未知助手";
        const command =
          approvalData.args?.command ||
          JSON.stringify(approvalData.args || {}, null, 2);
        const requestTime =
          approvalData.timestamp || new Date().toLocaleString();
        const encodedRequestId = encodeURIComponent(requestId);

        block.innerHTML = `
                      <h3 style="color: var(--accent-notification);">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z"></path><path d="M9 12l2 2 4-4"></path></svg>
                          工具调用审核请求
                      </h3>
                      <div class="meta-info">
                          <span class="meta-pill">工具: ${toolName}</span>
                          <span class="meta-pill">助手: ${maidName}</span>
                          <span class="meta-pill">Time: ${requestTime}</span>
                      </div>
                      <div class="rag-sub-item" style="margin-top:8px; border-left: 2px solid var(--accent-notification);">
                          <div style="font-size:0.8em; opacity:0.7; margin-bottom:6px;">命令预览</div>
                          ${createContentHTML(
                            String(command || "(empty command)")
                          )}
                      </div>
                      <div class="approval-actions">
                          <button class="approval-btn approve" onclick="handleToolApprovalAction('${encodedRequestId}', true, this)" ${
          requestId ? "" : "disabled"
        }>允许</button>
                          <button class="approval-btn reject" onclick="handleToolApprovalAction('${encodedRequestId}', false, this)" ${
          requestId ? "" : "disabled"
        }>拒绝</button>
                      </div>
                  `;

        if (window.pretextBridge && window.pretextBridge.isReady()) {
          const containerWidth = infoContainer.offsetWidth || 500;
          window.pretextBridge.estimateHeight(
            "rag-tool-" + requestId,
            String(command),
            "rag",
            containerWidth
          );
        }

        prependCard(block);
      }

      // 10. GENERIC NOTIFICATION BLOCK
      function displaySystemNotification(data) {
        const block = document.createElement("div");
        block.className = "card-base type-notification card-enter";

        const normalized = normalizeNotificationContent(data);
        const contentString = String(normalized.content || "");
        const isSucceed =
          /success|succeed|ok/i.test(normalized.status) ||
          /success|succeed/i.test(contentString);
        const isFailed =
          /error|failed|fail/i.test(normalized.status) ||
          /error|failed|fail/i.test(contentString);
        const dotClass = isSucceed
          ? "dot-green"
          : isFailed
          ? "dot-red"
          : "dot-orange";

        block.innerHTML = `
                      <h3 style="color: var(--accent-notification);">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
                          ${normalized.title}
                      </h3>
                      <div class="meta-info">
                          <span class="status-pill" style="margin-bottom:0; background:transparent; border:none; padding:0;">
                              <div class="status-dot ${dotClass}"></div>
                              <span style="color:var(--accent-notification);">${
                                normalized.source
                              }</span>
                          </span>
                          <span class="meta-pill">Status: ${
                            normalized.status
                          }</span>
                          <span class="meta-pill">Time: ${new Date().toLocaleTimeString()}</span>
                      </div>
                      ${createContentHTML(contentString)}
                  `;

        if (window.pretextBridge && window.pretextBridge.isReady()) {
          const containerWidth = infoContainer.offsetWidth || 500;
          window.pretextBridge.estimateHeight(
            "rag-sys-" + Date.now(),
            contentString,
            "rag",
            containerWidth
          );
        }

        prependCard(block);
      }

      function prependCard(element) {
        // Check filter before adding
        const type = element.classList.contains("type-rag")
          ? "rag"
          : element.classList.contains("type-chain")
          ? "chain"
          : element.classList.contains("type-chat")
          ? "chat"
          : element.classList.contains("type-memo")
          ? "memo"
          : element.classList.contains("type-dream")
          ? "dream"
          : element.classList.contains("type-notification")
          ? "notification"
          : "all";

        if (currentFilter !== "all" && currentFilter !== type) {
          element.style.display = "none";
        }

        // Remove "Waiting..." text if present
        if (
          infoContainer.children.length > 0 &&
          infoContainer.children[0].tagName === "DIV" &&
          infoContainer.children[0].innerText.includes("等待数据")
        ) {
          infoContainer.innerHTML = "";
          _cardCount = 0;
        }

        infoContainer.prepend(element);
        _cardCount++;

        // 性能优化：动画完成后释放will-change，减少GPU内存占用
        setTimeout(() => {
          element.classList.add("settled");
        }, SETTLE_DELAY_MS);

        // 性能核心：DOM卡片数量上限，自动清理最旧的卡片
        if (_cardCount > MAX_CARDS) {
          _trimOldCards();
        }
      }

      // 批量移除超出上限的旧卡片
      function _trimOldCards() {
        const cards = infoContainer.querySelectorAll(".card-base");
        const excess = cards.length - (MAX_CARDS - CARD_CLEANUP_BATCH);
        if (excess <= 0) return;

        // 从末尾开始移除（最旧的卡片在底部）
        for (
          let i = cards.length - 1;
          i >= 0 && i >= cards.length - excess;
          i--
        ) {
          const cardId = cards[i].getAttribute("data-compare-card-id");
          if (cardId) removeCompareCard(cardId);
          cards[i].remove();
        }
        _cardCount = infoContainer.querySelectorAll(".card-base").length;
        updateCompareBar();
      }

      // --- Spectrum Animation ---
      // 性能优化：使用OffscreenCanvas（如果支持），减少主线程开销
      const canvas = document.getElementById("spectrum-canvas");
      const ctx = canvas.getContext("2d", { alpha: true });
      let animationId = null;
      let _spectrumEndTime = 0;
      // 预创建渐变（在resize时更新）
      let _spectrumGradient = null;

      function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = 4;
        // 重建渐变
        _spectrumGradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
        _spectrumGradient.addColorStop(0, "#3498db");
        _spectrumGradient.addColorStop(0.5, "#9b59b6");
        _spectrumGradient.addColorStop(1, "#f1c40f");
      }
      // 性能优化：resize事件防抖
      let _resizeTimer = null;
      window.addEventListener("resize", () => {
        if (_resizeTimer) clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
          resizeCanvas();
          if (window.pretextBridge && window.pretextBridge.isReady()) {
            window.pretextBridge.recalculateAll(window.innerWidth);
          }
        }, 150);
      });
      resizeCanvas();

      window.startSpectrumAnimation = function (duration = 3000) {
        _spectrumEndTime = Date.now() + duration;
        // 如果动画已在运行，只延长时间，不重启
        if (animationId) return;

        function draw() {
          const now = Date.now();
          if (now > _spectrumEndTime) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            animationId = null;
            return;
          }

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = _spectrumGradient;

          // 性能优化：减少bar数量，使用位运算
          const width = canvas.width;
          const bars = 30; // 从50减少到30
          const step = width / bars;
          const t = now * 0.005;

          for (let i = 0; i < bars; i++) {
            const h = (Math.sin(i * 0.2 + t) + 1) * 2;
            ctx.fillRect(i * step, 2 - h / 2, step - 2, h);
          }

          animationId = requestAnimationFrame(draw);
        }
        draw();
      };

      // --- UI Initialization ---
      async function initializeObserverUI() {
        const activeButton = document.querySelector(".filter-btn.active");
        if (activeButton) {
          setTimeout(() => {
            const highlight = document.querySelector(".filter-highlight");
            if (!highlight) return;

            highlight.style.transition = "none"; // No animation on load
            highlight.style.width = `${activeButton.offsetWidth}px`;
            highlight.style.transform = `translateX(${activeButton.offsetLeft}px)`;

            // Force reflow to apply styles immediately
            void highlight.offsetWidth;

            // Re-enable transitions
            highlight.style.transition = "all 0.4s var(--ease-elastic)";
          }, 100); // A small delay to ensure layout is calculated
        }

        // 1. 从本地存储加载监控分区偏好
        loadPartitionsFromStorage();

        // 2. 初始化开关状态（从主进程恢复持久化状态）
        try {
          if (window.electronAPI?.ragOverlayGetState) {
            const restoredState = await window.electronAPI.ragOverlayGetState();
            if (restoredState && typeof restoredState === "object") {
              const hasStoredNotification =
                localStorage.getItem(PARTITIONS_STORAGE_KEY) !== null;
              if (
                !hasStoredNotification &&
                typeof restoredState.notificationCategoryEnabled === "boolean"
              ) {
                setNotificationCategoryEnabled(
                  restoredState.notificationCategoryEnabled,
                  false
                );
              } else {
                setNotificationCategoryEnabled(
                  observerRuntimeState.partitions.notification,
                  false
                );
              }

              if (typeof restoredState.enabled === "boolean") {
                setOverlayEnabled(restoredState.enabled, false);
              } else {
                setOverlayEnabled(true, false);
              }

              if (typeof restoredState.passThrough === "boolean") {
                setOverlayPassThrough(restoredState.passThrough, false);
              } else {
                updateOverlayControlButtons();
              }

              const opacityPercent = Number(restoredState.opacity) * 100;
              if (Number.isFinite(opacityPercent)) {
                setOverlayOpacity(opacityPercent, false);
              } else {
                setOverlayOpacity(90, false);
              }
            } else {
              setNotificationCategoryEnabled(
                observerRuntimeState.partitions.notification,
                false
              );
              setOverlayEnabled(true, false);
              updateOverlayControlButtons();
              setOverlayOpacity(90, false);
            }
          } else {
            setNotificationCategoryEnabled(
              observerRuntimeState.partitions.notification,
              false
            );
            setOverlayEnabled(true, false);
            updateOverlayControlButtons();
            setOverlayOpacity(90, false);
          }
        } catch (overlayStateError) {
          console.warn(
            "[RAG Observer] 读取悬浮窗持久化状态失败，回退默认值:",
            overlayStateError
          );
          setNotificationCategoryEnabled(
            observerRuntimeState.partitions.notification,
            false
          );
          setOverlayEnabled(true, false);
          updateOverlayControlButtons();
          setOverlayOpacity(90, false);
        }

        // 3. 渲染偏好设置中的分区选项并同步过滤器可见性
        renderSettingsPartitions();
        syncFilterBarVisibility();

        if (
          typeof window.setNotificationChannelEnabledFromObserver === "function"
        ) {
          window.setNotificationChannelEnabledFromObserver(
            observerRuntimeState.notificationsEnabled
          );
        }

        if (
          observerRuntimeState.overlayEnabled &&
          window.electronAPI?.ragOverlayHide
        ) {
          window.electronAPI.ragOverlayHide();
        }

        // 当从悬浮窗点击审核按钮时，复用监听器内审核逻辑
        if (window.electronAPI?.onRagOverlayApprovalAction) {
          window.electronAPI.onRagOverlayApprovalAction((payload) => {
            if (!observerRuntimeState.overlayEnabled) return;
            if (!payload || !payload.requestId) return;
            submitToolApproval(
              String(payload.requestId),
              !!payload.approved,
              null,
              typeof payload.reason === "string" ? payload.reason : ""
            );
          });
        }

        window.addEventListener("beforeunload", () => {
          observerRuntimeState.mounted = false;
          clearOverlayHideTimer();
          if (window.electronAPI?.ragOverlayHide) {
            window.electronAPI.ragOverlayHide();
          }
          if (
            typeof window.setNotificationChannelEnabledFromObserver ===
            "function"
          ) {
            window.setNotificationChannelEnabledFromObserver(false);
          }
        });

        if (infoContainer) {
          infoContainer.addEventListener("scroll", updateScrollTopButtonVisibility);
          updateScrollTopButtonVisibility();
        }
      }

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeObserverUI);
      } else {
        initializeObserverUI();
      }
