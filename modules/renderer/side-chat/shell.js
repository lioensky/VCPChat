/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

export function createSideChatShell({
    currentModel,
    container,
    descriptor,
    escapeHtml
}) {
    const modelName = currentModel || '选择模型';

    const isSnapshot = descriptor.contextMode === 'parent-snapshot';

    container.innerHTML = `
      <div class="side-chat-surface" aria-label="辅助对话">
        <span class="side-chat-topic-title sr-only" title="${escapeHtml(descriptor.title)}">${escapeHtml(descriptor.title)}</span>
        <div class="side-chat-messages-container" tabindex="-1" aria-label="辅助对话消息">
          <div class="side-chat-empty-state" aria-hidden="true">
            <div class="side-chat-empty-title">辅助对话</div>
            <div class="side-chat-empty-desc">
              ${isSnapshot
                ? '发送第一条消息时会带上来源话题的历史快照。在下方输入提问，或在主聊中划选文字追问。'
                : '当前为仅引用模式。选区引用会作为上下文随问题一同发送。'}
            </div>
          </div>
        </div>
        <form class="side-chat-composer">
          <div class="chat-input-card side-chat-input-card">
            <div class="side-chat-reference-list" hidden aria-label="选区引用"></div>
            <textarea class="chat-message-input side-chat-textarea" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1" aria-label="辅助对话输入框" disabled></textarea>
            <div class="chat-input-actions side-chat-input-actions">
              <div class="side-chat-status-bar" role="status" aria-live="polite">
                <span class="side-chat-status-text"></span>
                <button type="button" class="side-chat-persistence-badge side-chat-status-unsaved" hidden title="历史保存失败。左键重试保存，右键放弃未保存状态">未保存 ↻</button>
              </div>
              <div class="side-chat-model-picker-wrapper">
                <button type="button" class="side-chat-model-picker-btn" title="切换模型 (当前: ${escapeHtml(modelName)})" aria-haspopup="listbox" aria-expanded="false">
                  <span class="side-chat-model-name">${escapeHtml(modelName)}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                </button>
                <div class="side-chat-model-popover" hidden aria-label="选择模型">
                  <input type="text" class="side-chat-model-search" placeholder="搜索模型..." aria-label="搜索模型" />
                  <div class="side-chat-model-list" role="listbox"></div>
                </div>
              </div>
              <button type="submit" class="chat-send-button side-chat-send-btn" title="发送 (Enter)" aria-label="发送" disabled>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m5 12 7-7 7 7"></path>
                  <path d="M12 19V5"></path>
                </svg>
              </button>
              <button type="button" class="chat-send-button side-chat-stop-btn interrupt-mode" hidden title="停止生成" aria-label="停止生成">
                <span class="vcp-ui-icon">stop</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    `;

    const root = container.querySelector('.side-chat-messages-container');

    const form = container.querySelector('.side-chat-composer');

    const textarea = form.querySelector('.side-chat-textarea');

    const sendBtn = form.querySelector('.side-chat-send-btn');

    const stopBtn = form.querySelector('.side-chat-stop-btn');

    const statusText = container.querySelector('.side-chat-status-text');

    const persistenceBadge = container.querySelector('.side-chat-persistence-badge');

    const referenceList = container.querySelector('.side-chat-reference-list');

    const modelPickerBtn = container.querySelector('.side-chat-model-picker-btn');

    const modelPopover = container.querySelector('.side-chat-model-popover');

    const modelNameSpan = container.querySelector('.side-chat-model-name');

    return Object.freeze({ root, form, textarea, sendBtn, stopBtn, statusText, persistenceBadge, referenceList, modelPickerBtn, modelPopover, modelNameSpan, dispose() {  } });
}
