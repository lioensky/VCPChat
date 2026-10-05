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
            <span class="vcp-ui-icon side-chat-empty-icon">chat_bubble</span>
            <div class="side-chat-empty-title">辅助对话</div>
            <div class="side-chat-empty-desc">
              ${isSnapshot
                ? '带着来源话题的快照提问，也可划选主聊文字追问。'
                : '仅引用模式：选区引用会随问题一同发送。'}
            </div>
          </div>
        </div>
        <form class="side-chat-composer">
          <div class="chat-input-card side-chat-input-card">
            <div class="side-chat-reference-list" hidden aria-label="选区引用"></div>
            <div class="attachment-preview-area side-chat-attachment-preview" hidden aria-label="附件"></div>
            <textarea class="chat-message-input side-chat-textarea" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1" aria-label="辅助对话输入框" disabled></textarea>
            <div class="chat-input-actions side-chat-input-actions">
              <button type="button" class="chat-quick-new-button side-chat-attach-btn" title="添加附件" aria-label="添加附件" disabled>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>
              </button>
              <button type="button" class="chat-emoticon-button side-chat-emoticon-btn" title="打开表情包" aria-label="打开表情包" disabled>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"></path>
                  <path d="M15 3v5a1 1 0 0 0 1 1h5"></path>
                  <path d="M8 13h.01"></path>
                  <path d="M16 13h.01"></path>
                  <path d="M10 16s.8 1 2 1c1.3 0 2-1 2-1"></path>
                </svg>
              </button>
              <div class="side-chat-status-bar" role="status" aria-live="polite">
                <span class="side-chat-status-text"></span>
                <button type="button" class="side-chat-persistence-badge side-chat-status-unsaved" hidden title="历史保存失败。左键重试保存，右键放弃未保存状态">未保存 ↻</button>
              </div>
              <div class="side-chat-model-picker-wrapper">
                <button type="button" class="side-chat-model-picker-btn" title="切换模型 (当前: ${escapeHtml(modelName)})" aria-haspopup="listbox" aria-expanded="false">
                  <span class="side-chat-model-name">${escapeHtml(modelName)}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"></path>
                    <path d="M12 22V12"></path>
                    <path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"></path>
                    <path d="m7.5 4.27 9 5.15"></path>
                  </svg>
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
                <svg class="chat-stop-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor"></rect></svg>
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

    const attachBtn = form.querySelector('.side-chat-attach-btn');

    const emoticonBtn = form.querySelector('.side-chat-emoticon-btn');

    const attachmentPreview = form.querySelector('.side-chat-attachment-preview');

    return Object.freeze({ root, form, textarea, sendBtn, stopBtn, statusText, persistenceBadge, referenceList, modelPickerBtn, modelPopover, modelNameSpan, attachBtn, emoticonBtn, attachmentPreview, dispose() {  } });
}
