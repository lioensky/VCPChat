// groupSettingsMarkup.js - 群组设置页面的 HTML 模板
// 从 grouprenderer.js 中提取，方便后续样式维护

window.GroupSettingsMarkup = (() => {

    /**
     * 生成群组设置表单的完整 HTML 标记
     * @returns {string} 群组设置表单的 HTML 字符串
     */
    function renderGroupSettingsMarkup() {
        return `
            <form id="groupSettingsForm">
                <input type="hidden" id="editingGroupId">

                <div class="group-settings-collapsible-container group-settings-section collapsed" data-section-key="identity">
                    <div class="group-settings-section-header" id="groupIdentityToggleHeader">
                        <span class="group-settings-section-title">基础信息</span>
                        <div class="group-settings-section-summary" id="groupIdentitySummary"></div>
                        <button type="button" class="group-settings-toggle-btn" id="groupIdentityToggleBtn" aria-label="展开或收起基础信息">
                            <svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </button>
                    </div>
                    <div class="group-settings-section-content" id="groupIdentityContent">
                        <div class="group-settings-identity-shell">
                            <div class="agent-identity-main group-identity-main">
                                <div class="agent-avatar-wrapper group-avatar-wrapper">
                                    <img id="groupAvatarPreview" src="assets/default_group_avatar.png" alt="群组头像预览" class="agent-avatar-display group-avatar-display" style="display: block;">
                                    <label for="groupAvatarInput" class="avatar-upload-overlay">
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                                            <circle cx="12" cy="13" r="4"></circle>
                                        </svg>
                                    </label>
                                    <input type="file" id="groupAvatarInput" accept="image/*" style="display: none;">
                                </div>
                                <div class="agent-name-wrapper group-name-wrapper">
                                    <label for="groupNameInput">群组名称</label>
                                    <input type="text" id="groupNameInput" required>
                                </div>
                            </div>

                            <div class="group-settings-field-shell">
                                <label class="group-settings-field-label" for="groupMembersList">群组成员</label>
                                <div id="groupMembersList" class="group-members-list-container"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="group-settings-collapsible-container group-settings-section collapsed" data-section-key="mode">
                    <div class="group-settings-section-header" id="groupModeToggleHeader">
                        <span class="group-settings-section-title">群聊模式</span>
                        <div class="group-settings-section-summary" id="groupModeSummary"></div>
                        <button type="button" class="group-settings-toggle-btn" id="groupModeToggleBtn" aria-label="展开或收起群聊模式">
                            <svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </button>
                    </div>
                    <div class="group-settings-section-content" id="groupModeContent">
                        <div class="group-settings-card-shell">
                            <div class="group-settings-field-shell">
                                <select id="groupChatMode">
                                    <option value="sequential">顺序发言</option>
                                    <option value="naturerandom">自然随机</option>
                                    <option value="invite_only">邀请发言</option>
                                </select>
                            </div>

                            <div id="memberTagsContainer" class="group-settings-field-shell" style="display: none;">
                                <label for="tagMatchMode">Tag 触发模式</label>
                                <select id="tagMatchMode">
                                    <option value="strict">严格模式</option>
                                    <option value="natural">自然模式</option>
                                </select>
                                <div class="group-settings-helper-text">自然模式会区分 Tag 来源，尽量避免 Agent 因引用自身历史发言而重复触发。</div>

                                <div class="group-settings-field-shell group-member-tags-shell">
                                    <label class="group-settings-field-label">成员 Tags</label>
                                    <div id="memberTagsInputs"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="group-settings-collapsible-container group-settings-section collapsed" data-section-key="model">
                    <div class="group-settings-section-header" id="groupModelToggleHeader">
                        <span class="group-settings-section-title">模型设置</span>
                        <div class="group-settings-section-summary" id="groupModelSummary"></div>
                        <button type="button" class="group-settings-toggle-btn" id="groupModelToggleBtn" aria-label="展开或收起模型设置">
                            <svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </button>
                    </div>
                    <div class="group-settings-section-content" id="groupModelContent">
                        <div class="group-settings-card-shell group-settings-model-shell">
                            <div class="group-settings-switch-row">
                                <label for="groupUseUnifiedModel">启用群组统一模型</label>
                                <label class="switch" style="margin-bottom: 0;">
                                    <input type="checkbox" id="groupUseUnifiedModel">
                                    <span class="slider round"></span>
                                </label>
                            </div>

                            <div id="groupUnifiedModelContainer" class="group-settings-field-shell" style="display: none;">
                                <div class="model-input-container">
                                    <input type="text" id="groupUnifiedModelInput" placeholder="选择群组统一模型">
                                    <button type="button" id="openGroupModelSelectBtn" aria-label="打开模型选择器" title="选择模型">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="6 9 12 15 18 9"></polyline>
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="group-settings-collapsible-container group-settings-section collapsed" data-section-key="prompt">
                    <div class="group-settings-section-header" id="groupPromptToggleHeader">
                        <span class="group-settings-section-title">系统提示词</span>
                        <div class="group-settings-section-summary" id="groupPromptSummary"></div>
                        <button type="button" class="group-settings-toggle-btn" id="groupPromptToggleBtn" aria-label="展开或收起系统提示词">
                            <svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </button>
                    </div>
                    <div class="group-settings-section-content" id="groupPromptContent">
                        <div class="group-settings-card-shell group-settings-prompt-shell">
                            <div class="group-settings-field-shell">
                                <label for="groupPrompt">GroupPrompt</label>
                                <textarea id="groupPrompt" rows="4" placeholder="例如：这里是用户家的聊天空间，成员应保持协作与角色分工。"></textarea>
                            </div>
                            <div class="group-settings-field-shell">
                                <label for="invitePrompt">InvitePrompt</label>
                                <textarea id="invitePrompt" rows="4" placeholder="例如：现在轮到 {{VCPChatAgentName}} 发言了。"></textarea>
                                <div class="group-settings-helper-text">可使用 {{VCPChatAgentName}} 作为被邀请发言的 Agent 名称占位符。</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="form-actions">
                    <button type="submit">保存群组设置</button>
                    <div class="delete-button-container">
                        <button type="button" id="deleteGroupBtn" class="danger-button">删除此群组</button>
                    </div>
                </div>
            </form>
        `;
    }

    return {
        renderGroupSettingsMarkup
    };
})();