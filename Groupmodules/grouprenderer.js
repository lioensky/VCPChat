// Grouprenderer.js - Handles UI and logic for Agent Groups

window.GroupRenderer = (() => {
    let electronAPI;
    let globalSettings;
    let currentSelectedItemRef; // Reference to renderer's currentSelectedItem { get, set }
    let currentTopicIdRef;      // Reference to renderer's currentTopicId { get, set }
    let messageRenderer;        // Reference to messageRenderer module
    let uiHelper;               // Reference to UI helper functions from renderer.js (openModal, closeModal, etc.)
    let mainRendererElements;   // Restore module-level mainRendererElements
    let selectAgentPromptForSettingsElementFromRenderer; // Specific variable for this element
    let agentSettingsContainerFromRenderer; // Specific variable for this element
    let selectedItemNameForSettingsElementFromRenderer; // 新增：用于存储 selectedItemNameForSettingsSpan 的引用
    let mainRendererFunctions;  // Reference to shared functions from renderer.js (loadItems, highlightActiveItem, etc.)
    let inviteAgentButtonsContainerRef; // 新增：用于存储邀请发言按钮容器的引用

    // DOM Elements specific to Group functionality (some might be created dynamically)
    let groupSettingsContainer;
    let groupSettingsForm;
    let groupNameInput, groupAvatarInput, groupAvatarPreview;
    let groupMembersListDiv, addRemoveMembersBtn;
    let groupChatModeSelect;
    let memberTagsContainer, memberTagsInputsDiv;
    let groupPromptTextarea, invitePromptTextarea;
    let deleteGroupBtn;
    let createNewGroupBtn; // This button is in main.html, renderer.js might attach its listener

    // State for group settings
    let availableAgentsForGroup = []; // To populate member selection

    function init(dependencies) {
        console.log('[GroupRenderer] init function CALLED. Dependencies received:', Object.keys(dependencies));
        electronAPI = dependencies.electronAPI;
        globalSettings = dependencies.globalSettingsRef;
        currentSelectedItemRef = dependencies.currentSelectedItemRef;
        currentTopicIdRef = dependencies.currentTopicIdRef;
        messageRenderer = dependencies.messageRenderer;
        uiHelper = dependencies.uiHelper;
        mainRendererElements = dependencies.mainRendererElements; // Restore assignment
        console.log('[GroupRenderer INIT] mainRendererElements assigned in init. Value:', mainRendererElements);
        if (mainRendererElements) {
            console.log('[GroupRenderer INIT] mainRendererElements.currentChatAgentNameH3 is:', mainRendererElements.currentChatAgentNameH3);
            console.log('[GroupRenderer INIT] mainRendererElements.currentAgentSettingsBtn is:', mainRendererElements.currentItemActionBtn); // Note: renderer.js uses currentItemActionBtn for this
        }
        mainRendererFunctions = dependencies.mainRendererFunctions;
        inviteAgentButtonsContainerRef = dependencies.inviteAgentButtonsContainerRef; // 新增

        if (mainRendererElements) {
            // console.log('[GroupRenderer INIT] Received mainRendererElements (already logged above):', mainRendererElements);
            // Still assign to specific vars for clarity in displayGroupSettingsPage and logging
            selectAgentPromptForSettingsElementFromRenderer = mainRendererElements.selectItemPromptForSettings;
            agentSettingsContainerFromRenderer = mainRendererElements.agentSettingsContainer;
            selectedItemNameForSettingsElementFromRenderer = mainRendererElements.selectedItemNameForSettingsSpan;
            
            console.log('[GroupRenderer INIT] mainRendererElements.selectItemPromptForSettings IS:', selectAgentPromptForSettingsElementFromRenderer);
            console.log('[GroupRenderer INIT] mainRendererElements.agentSettingsContainer IS:', agentSettingsContainerFromRenderer);
            console.log('[GroupRenderer INIT] mainRendererElements.selectedItemNameForSettingsSpan IS:', selectedItemNameForSettingsElementFromRenderer);

            if (selectAgentPromptForSettingsElementFromRenderer) {
                console.log('[GroupRenderer INIT] Attempting to access style of selectAgentPromptForSettingsElementFromRenderer:', selectAgentPromptForSettingsElementFromRenderer.style.display);
            } else {
                console.error('[GroupRenderer INIT] selectAgentPromptForSettingsElementFromRenderer is FALSY after assignment!');
            }
        } else {
            console.error('[GroupRenderer INIT] dependencies.mainRendererElements (and thus mainRendererElements) is undefined or null!');
        }
        
        // Get references to group settings form elements (assuming they are added to DOM by renderer.js or main.html)
        // These elements are defined in the innerHTML for groupSettingsContainer in renderer.js
        // We need to ensure they are accessible after renderer.js appends groupSettingsContainer
        // This might be better done after the DOM is fully ready and elements are appended.
        // For now, we'll assume renderer.js makes them available or we query them here.
        ensureGroupSettingsDOM(); // Ensure DOM for group settings is ready
        console.log('[GroupRenderer] Initialized with dependencies.');
        console.log('[GroupRenderer INIT] inviteAgentButtonsContainerRef received:', inviteAgentButtonsContainerRef ? 'Exists' : 'MISSING');
        setupGroupSpecificEventListeners();
    }
    
    function ensureGroupSettingsDOM() {
        let settingsTab = document.getElementById('tabContentSettings');
        if (!settingsTab) {
            console.error("[GroupRenderer] Could not find tabContentSettings to append group settings DOM.");
            return false;
        }

        groupSettingsContainer = document.getElementById('groupSettingsContainer');
        if (!groupSettingsContainer) {
            groupSettingsContainer = document.createElement('div');
            groupSettingsContainer.id = 'groupSettingsContainer';
            groupSettingsContainer.style.display = 'none'; // Initially hidden
            settingsTab.appendChild(groupSettingsContainer);
            console.log("[GroupRenderer] groupSettingsContainer created.");
        }

        // Always set the innerHTML to ensure all form elements are present
        groupSettingsContainer.innerHTML = `
            <form id="groupSettingsForm">
                <input type="hidden" id="editingGroupId">
                <div class="form-group">
                    <label for="groupNameInput">群组名称:</label>
                    <input type="text" id="groupNameInput" required>
                </div>
                <div class="form-group">
                    <label for="groupAvatarInput">群组头像:</label>
                    <input type="file" id="groupAvatarInput" accept="image/*">
                    <img id="groupAvatarPreview" src="#" alt="群组头像预览" style="display: none; max-width: 100px; max-height: 100px; border-radius: 50%;">
                </div>
                <div class="form-group">
                    <label>群组成员:</label>
                    <div id="groupMembersList" class="group-members-list-container"></div>
                </div>
                <div class="form-group">
                    <label for="groupChatMode">群聊模式:</label>
                    <select id="groupChatMode">
                        <option value="sequential">顺序发言</option>
                        <option value="naturerandom">自然随机</option>
                        <option value="invite_only">邀请发言</option>
                    </select>
                </div>
                <div id="memberTagsContainer" class="form-group" style="display: none;">
                    <label>成员 Tags (用于自然随机模式):</label>
                    <div id="memberTagsInputs"></div>
                </div>
                <div class="form-group">
                    <label for="groupPrompt">群设定 (GroupPrompt):</label>
                    <textarea id="groupPrompt" rows="3" placeholder="例如：现在这里是用户家的聊天室..."></textarea>
                </div>
                <div class="form-group">
                    <label for="invitePrompt">发言设定 (InvitePrompt):</label>
                    <textarea id="invitePrompt" rows="3" placeholder="例如：现在轮到你 {{VCPChatAgentName}} 发言了。"></textarea>
                    <small>使用 {{VCPChatAgentName}} 作为被邀请发言的Agent名称占位符。</small>
                </div>
                <div class="form-actions">
                    <button type="submit">保存群组设置</button>
                    <button type="button" id="deleteGroupBtn">删除此群组</button>
                </div>
            </form>
        `;
        console.log("[GroupRenderer] groupSettingsContainer innerHTML set.");
        // Now that DOM is ensured and populated, get element references
        return getGroupSettingsElements(); // Return true if elements are successfully retrieved
    }


    function getGroupSettingsElements() {
        groupSettingsContainer = document.getElementById('groupSettingsContainer');
        if (!groupSettingsContainer) {
            console.error('[GroupRenderer] groupSettingsContainer not found in DOM!');
            return false;
        }
        groupSettingsForm = document.getElementById('groupSettingsForm');
        groupNameInput = document.getElementById('groupNameInput');
        groupAvatarInput = document.getElementById('groupAvatarInput');
        groupAvatarPreview = document.getElementById('groupAvatarPreview');
        groupMembersListDiv = document.getElementById('groupMembersList');
        groupChatModeSelect = document.getElementById('groupChatMode');
        memberTagsContainer = document.getElementById('memberTagsContainer');
        memberTagsInputsDiv = document.getElementById('memberTagsInputs');
        groupPromptTextarea = document.getElementById('groupPrompt');
        invitePromptTextarea = document.getElementById('invitePrompt');
        deleteGroupBtn = document.getElementById('deleteGroupBtn'); // This is the button inside the group settings form
        return true;
    }


    function setupGroupSpecificEventListeners() {
        // Event listener for "Create New Group" button (assuming it's in main.html)
        createNewGroupBtn = document.getElementById('createNewGroupBtn');
        if (createNewGroupBtn) {
            createNewGroupBtn.addEventListener('click', handleCreateNewGroup);
        } else {
            console.warn('[GroupRenderer] createNewGroupBtn not found.');
        }

        // Listeners for group settings form (will be attached when form is displayed)
        // This is handled in displayGroupSettingsPage
    }

    async function handleCreateNewGroup() {
        uiHelper.openModal('createGroupModal');
        const form = document.getElementById('createGroupForm');
        const nameInput = document.getElementById('newGroupNameInput');
        nameInput.value = `新群组_${Date.now()}`; // Pre-fill with a default name

        // Remove previous event listener to avoid multiple submissions
        const newForm = form.cloneNode(true);
        form.parentNode.replaceChild(newForm, form);
        
        newForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const groupName = document.getElementById('newGroupNameInput').value.trim(); // Get value from the new form's input
            if (groupName) {
                uiHelper.closeModal('createGroupModal');
                try {
                    const result = await electronAPI.createAgentGroup(groupName);
                    if (result.success && result.agentGroup) {
                        // uiHelper.showToastNotification(`群组 "${result.agentGroup.name}" 已创建!`); // Removed toast notification
                        await mainRendererFunctions.loadItems(); // Reload combined list
                        mainRendererFunctions.selectItem(result.agentGroup.id, 'group', result.agentGroup.name, result.agentGroup.avatarUrl, result.agentGroup);
                        mainRendererFunctions.switchToTab('settings');
                        // displayGroupSettingsPage is called by selectItem or switchToTab indirectly
                    } else {
                        uiHelper.showToastNotification(`创建群组失败: ${result.error}`, 'error');
                    }
                } catch (error) {
                    console.error('创建群组时出错:', error);
                    uiHelper.showToastNotification(`创建群组时发生错误: ${error.message}`, 'error');
                }
            }
        });
    }

    // Called by renderer.js when a group item is selected
    async function handleSelectGroup(groupId, groupName, groupAvatarUrl, groupConfig) {
        const currentSelectedItem = currentSelectedItemRef.get();
        if (currentSelectedItem.id === groupId && currentSelectedItem.type === 'group' && currentTopicIdRef.get()) {
            return; // Already selected this group and a topic is loaded
        }

        currentSelectedItemRef.set({ id: groupId, type: 'group', name: groupName, avatarUrl: groupAvatarUrl, config: groupConfig });
        currentTopicIdRef.set(null); // Reset topic
        messageRenderer.setCurrentSelectedItem(currentSelectedItemRef.get());
        messageRenderer.setCurrentTopicId(null);
        messageRenderer.setCurrentItemAvatar(groupAvatarUrl); // Use group avatar - CORRECTED FUNCTION NAME
        messageRenderer.setCurrentItemAvatarColor(groupConfig?.avatarCalculatedColor || null); // CORRECTED FUNCTION NAME


        if (mainRendererElements.currentChatNameH3) {
            mainRendererElements.currentChatNameH3.textContent = `与群组 ${groupName} 聊天中`;
        }
        if (mainRendererElements.currentItemActionBtn) {
            mainRendererElements.currentItemActionBtn.textContent = '新建群聊话题';
            mainRendererElements.currentItemActionBtn.title = `为群组 ${groupName} 新建群聊话题`;
            mainRendererElements.currentItemActionBtn.style.display = 'inline-block';
        }
        // mainRendererElements.clearCurrentChatBtn.style.display = 'inline-block'; // This button is removed

        mainRendererFunctions.highlightActiveItem(groupId, 'group');

        try {
            const topics = await electronAPI.getGroupTopics(groupId);
            if (topics && !topics.error && topics.length > 0) {
                let topicToLoadId = topics[0].id;
                const rememberedTopicId = localStorage.getItem(`lastActiveTopic_${groupId}_group`);
                if (rememberedTopicId && topics.some(t => t.id === rememberedTopicId)) {
                    topicToLoadId = rememberedTopicId;
                }
                currentTopicIdRef.set(topicToLoadId);
                messageRenderer.setCurrentTopicId(topicToLoadId);
                await loadGroupChatHistory(groupId, topicToLoadId);
            } else if (topics.error) {
                console.error(`加载群组 ${groupId} 的话题列表失败:`, topics.error);
                messageRenderer.renderMessage({ role: 'system', content: `加载话题列表失败: ${topics.error}`, timestamp: Date.now() });
            } else {
                // No topics, create a default one or prompt
                const defaultTopicResult = await electronAPI.createNewTopicForGroup(groupId, "主要群聊");
                if (defaultTopicResult.success) {
                    currentTopicIdRef.set(defaultTopicResult.topicId);
                    messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                    await loadGroupChatHistory(groupId, defaultTopicResult.topicId);
                } else {
                    messageRenderer.renderMessage({ role: 'system', content: `创建默认话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                    await loadGroupChatHistory(groupId, null); // Show "no topic"
                }
            }
        } catch (e) {
            console.error(`选择群组 ${groupId} 时发生错误: `, e);
            messageRenderer.renderMessage({ role: 'system', content: `选择群组时出错: ${e.message}`, timestamp: Date.now() });
        }

        mainRendererElements.messageInput.disabled = false;
        mainRendererElements.sendMessageBtn.disabled = false;
        mainRendererElements.attachFileBtn.disabled = false;
        // mainRendererElements.messageInput.focus();

        // After selecting group and loading history, update invite buttons
        console.log(`[GroupRenderer handleSelectGroup] Checking mode for group ${groupId}. Mode: ${groupConfig?.mode}`);
        if (groupConfig && groupConfig.mode === 'invite_only') {
            console.log(`[GroupRenderer handleSelectGroup] Group ${groupId} is in invite_only mode. Members:`, groupConfig.members);
            const membersDetails = await Promise.all(
                (groupConfig.members || []).map(async (id) => {
                    const config = await electronAPI.getAgentConfig(id);
                    console.log(`[GroupRenderer handleSelectGroup] Fetched config for member ${id}:`, config ? 'Exists' : 'Error/Null', config?.error);
                    return config;
                })
            );
            const validMembers = membersDetails.filter(m => m && !m.error);
            console.log(`[GroupRenderer handleSelectGroup] membersDetails count: ${membersDetails.length}, validMembers count: ${validMembers.length}`);
            displayInviteAgentButtons(groupId, currentTopicIdRef.get(), validMembers, groupConfig);
        } else {
            console.log(`[GroupRenderer handleSelectGroup] Group ${groupId} is NOT in invite_only mode or groupConfig is missing. Clearing buttons.`);
            clearInviteAgentButtons();
        }
    }


    async function displayGroupSettingsPage(groupId) {
        console.log('[GroupRenderer] displayGroupSettingsPage called for groupId:', groupId);
        
        // Use the module-level specific references that were set during init
        // const localSelectPrompt = selectAgentPromptForSettingsElementFromRenderer; // No longer needed if mainRendererElements is used directly
        // const localAgentSettingsContainer = agentSettingsContainerFromRenderer; // No longer needed

        console.log('[GroupRenderer] selectAgentPromptForSettingsElementFromRenderer at start of displayGroupSettingsPage:', selectAgentPromptForSettingsElementFromRenderer);
        console.log('[GroupRenderer] agentSettingsContainerFromRenderer at start of displayGroupSettingsPage:', agentSettingsContainerFromRenderer);


        if (!getGroupSettingsElements()) { // This function primarily gets elements specific to group settings form
            console.error('[GroupRenderer] getGroupSettingsElements() failed in displayGroupSettingsPage.');
            return;
        }

        const groupConfig = await electronAPI.getAgentGroupConfig(groupId);
        if (!groupConfig || groupConfig.error) {
            alert(`加载群组配置失败: ${groupConfig?.error || '未知错误'}`);
            if (groupSettingsContainer) groupSettingsContainer.style.display = 'none'; // Hide group settings form
            if (selectAgentPromptForSettingsElementFromRenderer) { // Use direct module-level ref
                selectAgentPromptForSettingsElementFromRenderer.textContent = `加载群组 ${groupId} 配置失败。`;
                selectAgentPromptForSettingsElementFromRenderer.style.display = 'block';
            } else {
                console.error('[GroupRenderer] selectAgentPromptForSettingsElementFromRenderer is undefined when trying to show error for groupConfig load failure.');
            }
            return;
        }

        // Hide agent-specific settings container (using the specific ref from renderer)
        if (agentSettingsContainerFromRenderer && typeof agentSettingsContainerFromRenderer.style !== 'undefined') {
            agentSettingsContainerFromRenderer.style.display = 'none';
        } else {
            // Fallback if the reference from renderer.js wasn't correctly passed or is not a DOM element
            const fallbackAgentSettings = document.getElementById('agentSettingsContainer');
            if (fallbackAgentSettings) fallbackAgentSettings.style.display = 'none';
            else console.warn('[GroupRenderer] agentSettingsContainerFromRenderer (and fallback) is undefined, cannot hide agent settings.');
        }
        
        // Show group-specific settings container (this is managed within GroupRenderer)
        if (groupSettingsContainer && typeof groupSettingsContainer.style !== 'undefined') {
            groupSettingsContainer.style.display = 'block';
        }
        
        // Hide the "select item" prompt (using the specific ref from renderer)
        if (selectAgentPromptForSettingsElementFromRenderer) { // Use direct module-level ref
            selectAgentPromptForSettingsElementFromRenderer.style.display = 'none';
        } else {
            console.error('[GroupRenderer] selectAgentPromptForSettingsElementFromRenderer is undefined when trying to hide it.');
            const fallbackPrompt = document.getElementById('selectAgentPromptForSettings'); // Fallback
            if (fallbackPrompt) {
                console.warn('[GroupRenderer] Fallback: Hiding selectAgentPromptForSettings using direct getElementById.');
                fallbackPrompt.style.display = 'none';
            } else {
                console.error('[GroupRenderer] CRITICAL: selectAgentPromptForSettings element not found even with direct getElementById.');
            }
        }

        // Use the specific module-level reference for selectedItemNameForSettingsElementFromRenderer
        if (selectedItemNameForSettingsElementFromRenderer) {
            selectedItemNameForSettingsElementFromRenderer.textContent = groupConfig.name || groupId;
        } else {
            console.error('[GroupRenderer] selectedItemNameForSettingsElementFromRenderer is undefined, cannot set textContent.');
            const fallbackElement = document.getElementById('selectedAgentNameForSettings'); // Fallback
            if (fallbackElement) {
                console.warn('[GroupRenderer] Fallback: Setting selectedAgentNameForSettings using direct getElementById.');
                fallbackElement.textContent = groupConfig.name || groupId;
            } else {
                console.error('[GroupRenderer] CRITICAL: selectedAgentNameForSettings element not found even with direct getElementById.');
            }
        }
        document.getElementById('editingGroupId').value = groupId;

        groupNameInput.value = groupConfig.name || '';
        groupAvatarPreview.style.display = groupConfig.avatarUrl ? 'block' : 'none';
        groupAvatarPreview.src = groupConfig.avatarUrl ? `${groupConfig.avatarUrl}?t=${Date.now()}` : '#';
        groupAvatarInput.value = ''; // Clear file input

        groupChatModeSelect.value = groupConfig.mode || 'sequential';
        groupPromptTextarea.value = groupConfig.groupPrompt || '';
        invitePromptTextarea.value = groupConfig.invitePrompt || '现在轮到你{{VCPChatAgentName}}发言了。';

        await populateGroupMembersSettings(groupConfig);
        toggleMemberTagsVisibility(groupConfig.mode);

        groupChatModeSelect.onchange = () => {
            toggleMemberTagsVisibility(groupChatModeSelect.value);
        };

        if (groupSettingsForm._eventListenerAttached) {
            groupSettingsForm.removeEventListener('submit', handleSaveGroupSettings);
        }
        groupSettingsForm.addEventListener('submit', handleSaveGroupSettings);
        groupSettingsForm._eventListenerAttached = true;


        if (deleteGroupBtn._eventListenerAttached) {
            deleteGroupBtn.removeEventListener('click', handleDeleteCurrentGroup);
        }
        deleteGroupBtn.addEventListener('click', handleDeleteCurrentGroup);
        deleteGroupBtn._eventListenerAttached = true;

        if (groupAvatarInput._eventListenerAttached) {
            groupAvatarInput.removeEventListener('change', handleGroupAvatarChange);
        }
        groupAvatarInput.addEventListener('change', handleGroupAvatarChange);
        groupAvatarInput._eventListenerAttached = true;
    }

    function handleGroupAvatarChange(event) {
        const file = event.target.files[0];
        if (file) {
            uiHelper.openAvatarCropper(file, (croppedFile) => {
                mainRendererFunctions.setCroppedFile('group', croppedFile); // Use renderer's central cropped file store
                if (groupAvatarPreview) {
                    groupAvatarPreview.src = URL.createObjectURL(croppedFile);
                    groupAvatarPreview.style.display = 'block';
                }
            });
        }
    }


    async function populateGroupMembersSettings(groupConfig) {
        if (!groupMembersListDiv) {
            console.error("groupMembersListDiv not found for populating members.");
            return;
        }
        groupMembersListDiv.innerHTML = '加载Agent列表中...';
        memberTagsInputsDiv.innerHTML = ''; // Clear old tag inputs

        try {
            const agents = await electronAPI.getAgents();
            if (agents.error) {
                groupMembersListDiv.innerHTML = `加载Agent列表失败: ${agents.error}`;
                return;
            }
            availableAgentsForGroup = agents; // Store for later use
            groupMembersListDiv.innerHTML = ''; // Clear loading

            agents.forEach(agent => {
                const memberDiv = document.createElement('div');
                memberDiv.className = 'group-member-item';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `member_agent_${agent.id}`;
                checkbox.value = agent.id;
                checkbox.checked = groupConfig.members && groupConfig.members.includes(agent.id);
                checkbox.onchange = () => updateMemberTagsInputs(groupConfig);


                const label = document.createElement('label');
                label.htmlFor = `member_agent_${agent.id}`;
                label.textContent = agent.name;

                const avatar = document.createElement('img');
                avatar.src = agent.avatarUrl || 'assets/default_avatar.png';
                avatar.alt = agent.name;
                avatar.className = 'avatar-small';

                label.prepend(avatar);
                memberDiv.appendChild(checkbox);
                memberDiv.appendChild(label);
                groupMembersListDiv.appendChild(memberDiv);
            });
            updateMemberTagsInputs(groupConfig); // Initial population of tag inputs
        } catch (error) {
            groupMembersListDiv.innerHTML = `加载Agent列表时出错: ${error.message}`;
            console.error("Error populating group members settings:", error);
        }
    }

    function updateMemberTagsInputs(groupConfig) {
        if (!memberTagsInputsDiv || !groupMembersListDiv) return;
        memberTagsInputsDiv.innerHTML = ''; // Clear existing
        const selectedMemberIds = Array.from(groupMembersListDiv.querySelectorAll('input[type="checkbox"]:checked'))
            .map(cb => cb.value);

        selectedMemberIds.forEach(agentId => {
            const agent = availableAgentsForGroup.find(a => a.id === agentId);
            if (agent) {
                const tagInputDiv = document.createElement('div');
                tagInputDiv.className = 'member-tag-input-item';
                const label = document.createElement('label');
                label.htmlFor = `tags_for_${agentId}`;
                label.textContent = `${agent.name} Tags:`;
                const input = document.createElement('input');
                input.type = 'text';
                input.id = `tags_for_${agentId}`;
                input.dataset.agentId = agentId;
                input.placeholder = "例如: 猫娘,小克,科学";
                input.value = (groupConfig.memberTags && groupConfig.memberTags[agentId]) ? groupConfig.memberTags[agentId] : '';
                tagInputDiv.appendChild(label);
                tagInputDiv.appendChild(input);
                memberTagsInputsDiv.appendChild(tagInputDiv);
            }
        });
    }


    function toggleMemberTagsVisibility(mode) {
        if (memberTagsContainer) {
            memberTagsContainer.style.display = mode === 'naturerandom' ? 'block' : 'none';
        }
    }

    async function handleSaveGroupSettings(event) {
        event.preventDefault();
        if (!getGroupSettingsElements()) {
            alert("无法保存群组设置，表单元素未找到。");
            return;
        }

        const groupId = document.getElementById('editingGroupId').value;
        const selectedMemberIds = Array.from(groupMembersListDiv.querySelectorAll('input[type="checkbox"]:checked'))
            .map(cb => cb.value);

        const memberTags = {};
        if (memberTagsInputsDiv) {
            memberTagsInputsDiv.querySelectorAll('input[type="text"]').forEach(input => {
                memberTags[input.dataset.agentId] = input.value.trim();
            });
        }

        const newConfig = {
            name: groupNameInput.value.trim(),
            members: selectedMemberIds,
            mode: groupChatModeSelect.value,
            memberTags: memberTags,
            groupPrompt: groupPromptTextarea.value.trim(),
            invitePrompt: invitePromptTextarea.value.trim()
        };

        if (!newConfig.name) {
            alert("群组名称不能为空！");
            return;
        }

        const croppedGroupAvatar = mainRendererFunctions.getCroppedFile('group');
        if (croppedGroupAvatar) {
            try {
                const arrayBuffer = await croppedGroupAvatar.arrayBuffer();
                const avatarResult = await electronAPI.saveAgentGroupAvatar(groupId, {
                    name: croppedGroupAvatar.name,
                    type: croppedGroupAvatar.type,
                    buffer: arrayBuffer
                });
                if (avatarResult.success) {
                    newConfig.avatar = avatarResult.avatarFileName; // Save filename to config
                    groupAvatarPreview.src = avatarResult.avatarUrl; // Update preview
                    mainRendererFunctions.setCroppedFile('group', null); // Clear after save
                    groupAvatarInput.value = '';
                    // Potentially update avatar color if groups also have calculated colors
                } else {
                    alert(`保存群组头像失败: ${avatarResult.error}`);
                }
            } catch (readError) {
                alert(`读取群组头像文件失败: ${readError.message}`);
            }
        }

        try {
            const result = await electronAPI.saveAgentGroupConfig(groupId, newConfig);
            const saveButton = groupSettingsForm.querySelector('button[type="submit"]');

            if (result.success && result.agentGroup) {
                if (saveButton) uiHelper.showSaveFeedback(saveButton, true, "已保存!", "保存群组设置");
                await mainRendererFunctions.loadItems(); // Reload list to reflect name/avatar changes
                // If current selected group is this one, update its details
                const currentSelected = currentSelectedItemRef.get();
                if (currentSelected.id === groupId && currentSelected.type === 'group') {
                    currentSelectedItemRef.set({ ...currentSelected, ...result.agentGroup });
                    if (mainRendererElements && mainRendererElements.currentChatAgentNameH3) {
                        mainRendererElements.currentChatAgentNameH3.textContent = `与群组 ${result.agentGroup.name} 聊天中`;
                    } else {
                        console.warn('[GroupRenderer] mainRendererElements or mainRendererElements.currentChatAgentNameH3 is not available in handleSaveGroupSettings when trying to update chat name.');
                    }
                    messageRenderer.setCurrentItemAvatar(result.agentGroup.avatarUrl);
                    messageRenderer.setCurrentItemAvatarColor(result.agentGroup.avatarCalculatedColor); // Update avatar color
                }
                // Use the specific module-level reference for selectedItemNameForSettingsElementFromRenderer
                if (selectedItemNameForSettingsElementFromRenderer) {
                    selectedItemNameForSettingsElementFromRenderer.textContent = result.agentGroup.name;
                } else {
                     console.error('[GroupRenderer] selectedItemNameForSettingsElementFromRenderer is undefined in handleSaveGroupSettings, cannot set textContent.');
                     const fallbackElement = document.getElementById('selectedAgentNameForSettings'); // Fallback
                     if (fallbackElement) {
                        console.warn('[GroupRenderer] Fallback: Setting selectedAgentNameForSettings using direct getElementById in handleSaveGroupSettings.');
                        fallbackElement.textContent = result.agentGroup.name;
                     } else {
                        console.error('[GroupRenderer] CRITICAL: selectedAgentNameForSettings element not found even with direct getElementById in handleSaveGroupSettings.');
                     }
                }
                // uiHelper.showToastNotification(`群组 "${result.agentGroup.name}" 设置已保存。`); // Removed successful save notification
           } else {
               if (saveButton) uiHelper.showSaveFeedback(saveButton, false, "保存失败", "保存群组设置");
               alert(`保存群组设置失败: ${result.error}`);
            }

            // Update invite buttons based on new mode after saving
            const updatedGroupConfig = result.agentGroup || newConfig; // Use result if available, else optimistic newConfig
            if (updatedGroupConfig.mode === 'invite_only') {
                const membersDetails = await Promise.all(
                    (updatedGroupConfig.members || []).map(id => electronAPI.getAgentConfig(id))
                );
                const validMembers = membersDetails.filter(m => m && !m.error);
                displayInviteAgentButtons(groupId, currentTopicIdRef.get(), validMembers, updatedGroupConfig);
            } else {
                clearInviteAgentButtons();
            }

        } catch (error) {
            console.error("Error saving group settings:", error);
            // 使用 uiHelper.showToastNotification 替换 alert
            if (uiHelper && typeof uiHelper.showToastNotification === 'function') {
                uiHelper.showToastNotification(`保存群组设置时出错: ${error.message}`, 'error');
            } else {
                // Fallback if uiHelper is not available for some reason
                console.error(`保存群组设置时出错 (uiHelper not available): ${error.message}`);
            }
        }
    }

    async function handleDeleteCurrentGroup() {
        if (!getGroupSettingsElements()) return;
        const groupId = document.getElementById('editingGroupId').value;
        const groupName = groupNameInput.value || '当前选中的群组';

        if (confirm(`您确定要删除群组 "${groupName}" 吗？其所有聊天记录和设置都将被删除，此操作不可撤销！`)) {
            try {
                const result = await electronAPI.deleteAgentGroup(groupId);
                if (result.success) {
                    // alert(`群组 ${groupName} 已删除。`); // 移除成功提示
                    const currentSelected = currentSelectedItemRef.get();
                    if (currentSelected.id === groupId && currentSelected.type === 'group') {
                        currentSelectedItemRef.set({ id: null, type: null, name: null, avatarUrl: null, config: null });
                        currentTopicIdRef.set(null);
                        if (mainRendererElements && mainRendererElements.currentChatAgentNameH3) {
                            mainRendererElements.currentChatAgentNameH3.textContent = '选择一个Agent或群组开始聊天';
                        } else {
                            console.warn('[GroupRenderer handleDeleteCurrentGroup] mainRendererElements.currentChatAgentNameH3 is not available.');
                        }
                        if (messageRenderer) messageRenderer.clearChat();
                        if (mainRendererElements && mainRendererElements.currentAgentSettingsBtn) mainRendererElements.currentAgentSettingsBtn.style.display = 'none';
                        if (mainRendererElements && mainRendererElements.clearCurrentChatBtn) mainRendererElements.clearCurrentChatBtn.style.display = 'none';
                        if (mainRendererElements && mainRendererElements.messageInput) mainRendererElements.messageInput.disabled = true;
                        if (mainRendererElements && mainRendererElements.sendMessageBtn) mainRendererElements.sendMessageBtn.disabled = true;
                        if (mainRendererElements && mainRendererElements.attachFileBtn) mainRendererElements.attachFileBtn.disabled = true;
                        if (messageRenderer) {
                            messageRenderer.setCurrentItemAvatar(null);
                            messageRenderer.setCurrentItemAvatarColor(null);
                        }
                        clearInviteAgentButtons(); // Clear invite buttons on delete

                        // 显式重置设置区域的UI状态
                        if (groupSettingsContainer) { // 这是本模块管理的群组设置容器
                            groupSettingsContainer.style.display = 'none';
                        }
                        // 确保Agent设置容器也隐藏 (如果之前是显示的)
                        // agentSettingsContainerFromRenderer 是从 renderer.js 传入的 Agent 设置容器
                        if (agentSettingsContainerFromRenderer && agentSettingsContainerFromRenderer.style) {
                             agentSettingsContainerFromRenderer.style.display = 'none';
                        }
                        // selectAgentPromptForSettingsElementFromRenderer 是从 renderer.js 传入的提示元素
                        if (selectAgentPromptForSettingsElementFromRenderer && selectAgentPromptForSettingsElementFromRenderer.style) {
                            selectAgentPromptForSettingsElementFromRenderer.textContent = '请选择一个Agent或群组进行设置。';
                            selectAgentPromptForSettingsElementFromRenderer.style.display = 'block';
                        }
                        // selectedItemNameForSettingsElementFromRenderer 是从 renderer.js 传入的显示名称的元素
                        if (selectedItemNameForSettingsElementFromRenderer) {
                            selectedItemNameForSettingsElementFromRenderer.textContent = ''; // 清空顶部显示的名称
                        }
                    }
                    if (mainRendererFunctions && mainRendererFunctions.loadItems) await mainRendererFunctions.loadItems();
                    
                    // 调用 displaySettingsForItem。
                    // 如果 currentSelectedItemRef.get().id 仍然为 null (例如，列表为空或没有自动选择),
                    // 它应该基于我们上面设置的UI状态正确显示“请选择”提示。
                    // 如果 loadItems 导致了新的选择, 它将显示新选定项的设置。
                    if (mainRendererFunctions && mainRendererFunctions.displaySettingsForItem) {
                        mainRendererFunctions.displaySettingsForItem();
                    }
                } else {
                    alert(`删除群组失败: ${result.error}`);
                }
            } catch (error) {
                console.error("Error deleting group:", error);
                alert(`删除群组时出错: ${error.message}`);
            }
        }
    }

    // --- Group Topic Management ---
    async function loadTopicsForGroup(groupId, searchTerm = '') {
        const topicListUl = mainRendererElements.topicListUl;
        if (!topicListUl) {
            console.error("Topic list UL not found for group topics.");
            return;
        }
        topicListUl.innerHTML = `<li><p>正在加载群组 ${groupId} 的话题...</p></li>`;
        try {
            let topics = await electronAPI.getGroupTopics(groupId);
            if (topics && !topics.error && searchTerm) {
                topics = topics.filter(topic =>
                    topic.name.toLowerCase().includes(searchTerm.toLowerCase())
                );
            }
            renderGroupTopicList(topics, topicListUl, groupId);
        } catch (error) {
            console.error(`加载群组 ${groupId} 话题失败:`, error);
            topicListUl.innerHTML = `<li><p>加载话题失败: ${error.message}</p></li>`;
        }
    }

    function renderGroupTopicList(topics, container, groupId) {
        container.innerHTML = '';
        if (topics.error) {
            container.innerHTML = `<li>加载话题失败: ${topics.error}</li>`;
            return;
        }
        if (!topics || topics.length === 0) {
            container.innerHTML = '<li>此群组还没有话题。</li>';
            return;
        }

        topics.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        topics.forEach(topic => {
            const li = document.createElement('li');
            li.className = 'topic-item';
            li.dataset.itemId = groupId; // Store group ID
            li.dataset.itemType = 'group';
            li.dataset.topicId = topic.id;
            if (topic.id === currentTopicIdRef.get()) {
                li.classList.add('active', 'active-topic-glowing');
            }

            const avatarImg = document.createElement('img');
            avatarImg.className = 'avatar';
            const groupConfig = currentSelectedItemRef.get().config;
            avatarImg.src = groupConfig?.avatarUrl || 'assets/default_avatar.png'; // Use group avatar
            avatarImg.alt = '群组头像';

            const topicNameSpan = document.createElement('span');
            topicNameSpan.className = 'topic-name';
            topicNameSpan.textContent = topic.name;

            li.appendChild(avatarImg);
            li.appendChild(topicNameSpan);
            li.addEventListener('click', () => handleGroupTopicSelection(groupId, topic.id));
            // Add context menu for rename/delete group topic
            li.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                uiHelper.showTopicContextMenu(e, groupId, 'group', topic.id, topic.name, handleRenameGroupTopic, handleDeleteGroupTopic, handleExportGroupTopic);
            });
            container.appendChild(li);
        });
        mainRendererFunctions.initializeTopicSortable(groupId, 'group');
    }

    async function handleGroupTopicSelection(groupId, topicId) {
        currentTopicIdRef.set(topicId);
        messageRenderer.setCurrentTopicId(topicId);
        await loadGroupChatHistory(groupId, topicId);
        localStorage.setItem(`lastActiveTopic_${groupId}_group`, topicId);

        // Bug 1 Fix: Refresh invite buttons if in invite_only mode
        const currentSelected = currentSelectedItemRef.get();
        if (currentSelected && currentSelected.type === 'group' && currentSelected.config) {
            const groupConfig = currentSelected.config;
            if (groupConfig.mode === 'invite_only') {
                console.log(`[GroupRenderer handleGroupTopicSelection] InviteOnly mode detected for group ${groupId}, topic ${topicId}. Refreshing invite buttons.`);
                const membersDetails = await Promise.all(
                    (groupConfig.members || []).map(async (id) => {
                        const config = await electronAPI.getAgentConfig(id);
                        if (!config || config.error) {
                            console.warn(`[GroupRenderer handleGroupTopicSelection] Failed to fetch config for member ${id}: ${config?.error}`);
                            return null;
                        }
                        return config;
                    })
                );
                const validMembers = membersDetails.filter(m => m);
                displayInviteAgentButtons(groupId, topicId, validMembers, groupConfig);
            }
        }
    }

    async function handleRenameGroupTopic(groupId, topicId, oldName) {
        const newName = prompt(`重命名群组话题 "${oldName}":`, oldName);
        if (newName && newName.trim() !== oldName) {
            const result = await electronAPI.saveGroupTopicTitle(groupId, topicId, newName.trim());
            if (result.success) {
                await mainRendererFunctions.loadTopicList(); // Reload topics for current item
            } else {
                alert(`重命名群组话题失败: ${result.error}`);
            }
        }
    }

    async function handleDeleteGroupTopic(groupId, topicId, topicName) {
        if (confirm(`确定要删除群组话题 "${topicName}" 吗？此操作不可撤销。`)) {
            const result = await electronAPI.deleteGroupTopic(groupId, topicId);
            if (result.success) {
                // uiHelper.showToastNotification(`群组话题 "${topicName}" 已删除。`); // 移除成功提示
                if (currentTopicIdRef.get() === topicId) {
                    currentTopicIdRef.set(null);
                    messageRenderer.setCurrentTopicId(null);
                    messageRenderer.clearChat();
                    // Load first available topic or show "no topic"
                    const topics = await electronAPI.getGroupTopics(groupId);
                    if (topics && topics.length > 0) {
                        handleGroupTopicSelection(groupId, topics[0].id);
                    }
                }
                await mainRendererFunctions.loadTopicList();
            } else {
                alert(`删除群组话题失败: ${result.error}`);
            }
        }
    }

    async function handleExportGroupTopic(groupId, topicId, topicName) {
        const currentTopicId = currentTopicIdRef.get();
        if (topicId !== currentTopicId) {
            uiHelper.showToastNotification('请先点击并加载此话题，然后再导出。', 'info');
            return;
        }

        console.log(`[GroupRenderer] Exporting currently visible topic: ${topicName} (ID: ${topicId})`);

        try {
            const chatMessagesDiv = document.getElementById('chatMessages');
            if (!chatMessagesDiv) {
                console.error('[Export Debug] chatMessagesDiv not found!');
                uiHelper.showToastNotification('错误：找不到聊天内容容器。', 'error');
                return;
            }

            const messageItems = chatMessagesDiv.querySelectorAll('.message-item');
            console.log(`[Export Debug] Found ${messageItems.length} message items.`);
            if (messageItems.length === 0) {
                uiHelper.showToastNotification('此话题没有可见的聊天内容可导出。', 'info');
                return;
            }

            let markdownContent = `# 话题: ${topicName}\n\n`;
            let extractedCount = 0;

            messageItems.forEach((item, index) => {
                if (item.classList.contains('system') || item.classList.contains('thinking')) {
                    console.log(`[Export Debug] Skipping system/thinking message at index ${index}.`);
                    return;
                }

                const senderElement = item.querySelector('.sender-name');
                const contentElement = item.querySelector('.md-content');

                if (senderElement && contentElement) {
                    const sender = senderElement.textContent.trim().replace(':', '');
                    let content = contentElement.innerText || contentElement.textContent || "";
                    content = content.trim();

                    if (sender && content) {
                        markdownContent += `**${sender}**: ${content}\n\n---\n\n`;
                        extractedCount++;
                    } else {
                        console.log(`[Export Debug] Skipping message at index ${index} due to empty sender or content. Sender: "${sender}", Content: "${content}"`);
                    }
                } else {
                    console.log(`[Export Debug] Skipping message at index ${index} because sender or content element was not found.`);
                }
            });

            console.log(`[Export Debug] Extracted ${extractedCount} messages. Final markdown length: ${markdownContent.length}`);

            if (extractedCount === 0) {
                uiHelper.showToastNotification('未能从当前话题中提取任何有效对话内容。', 'warning');
                return;
            }

            const result = await electronAPI.exportTopicAsMarkdown({
                topicName: topicName,
                markdownContent: markdownContent
            });

            if (result.success) {
                uiHelper.showToastNotification(`话题 "${topicName}" 已成功导出到: ${result.path}`);
            } else {
                uiHelper.showToastNotification(`导出话题失败: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error(`[GroupRenderer] 导出话题时发生错误:`, error);
            uiHelper.showToastNotification(`导出话题时发生前端错误: ${error.message}`, 'error');
        }
    }

    // --- Group Chat Message Handling ---
    async function handleSendGroupMessage() {
        const content = mainRendererElements.messageInput.value.trim();
        const attachedFiles = mainRendererFunctions.getAttachedFiles(); // Get from renderer.js

        if (!content && attachedFiles.length === 0) return;

        const currentSelected = currentSelectedItemRef.get();
        const currentTopic = currentTopicIdRef.get();

        if (!currentSelected.id || currentSelected.type !== 'group' || !currentTopic) {
            // alert('请先选择一个群组和话题！'); // 使用 uiHelper
            if (uiHelper && uiHelper.showToastNotification) uiHelper.showToastNotification('请先选择一个群组和话题！', 'error'); else alert('请先选择一个群组和话题！');
            return;
        }
        
        const currentGlobalSettings = globalSettings.get(); // 获取实际的设置对象
        if (!currentGlobalSettings.vcpServerUrl) {
            // alert('请先在全局设置中配置VCP服务器URL！'); // 使用 uiHelper
            if (uiHelper && uiHelper.showToastNotification) uiHelper.showToastNotification('请先在全局设置中配置VCP服务器URL！', 'error'); else alert('请先在全局设置中配置VCP服务器URL！');
            if (uiHelper && uiHelper.openModal) uiHelper.openModal('globalSettingsModal');
            return;
        }

        let combinedTextContent = content;
        const uiAttachments = []; // For UI rendering and passing full metadata

        if (attachedFiles.length > 0) {
            for (const af of attachedFiles) {
                // af should contain _fileManagerData which has originalName, internalPath, type, size, extractedText
                const attachmentInfoForUI = {
                    type: af.file.type, // From the original File object
                    src: af.localPath,   // Internal file:// path
                    name: af.originalName,
                    size: af.file.size,
                    // Crucially, pass _fileManagerData so groupchat.js can access extractedText and internalPath
                    _fileManagerData: af._fileManagerData
                };
                uiAttachments.push(attachmentInfoForUI);

                if (af._fileManagerData && af._fileManagerData.extractedText) {
                    combinedTextContent += `\n\n[附加文件: ${af.originalName}]\n${af._fileManagerData.extractedText}\n[/附加文件结束: ${af.originalName}]`;
                } else if (af._fileManagerData && af.file.type && !af.file.type.startsWith('image/')) {
                    combinedTextContent += `\n\n[附加文件: ${af.originalName} (无法预览文本内容)]`;
                }
            }
        }

        // Message object for UI rendering (uses original user input text 'content')
        // 'content' variable is from: const content = mainRendererElements.messageInput.value.trim();
        const userMessageForUI = {
            role: 'user',
            name: currentGlobalSettings.userName || '用户',
            content: {
                text: content
            },
            timestamp: Date.now(),
            id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
            attachments: uiAttachments
        };

        messageRenderer.renderMessage(userMessageForUI); // Render user's own message in UI

        mainRendererElements.messageInput.value = '';
        mainRendererFunctions.clearAttachedFiles();
        mainRendererFunctions.updateAttachmentPreview();
        uiHelper.autoResizeTextarea(mainRendererElements.messageInput);
        // mainRendererElements.messageInput.focus();

        // Message object for IPC to backend (uses combined text content)
        const userMessageForIPC = {
            role: 'user',
            name: userMessageForUI.name,
            content: { // This 'content' object is what groupchat.js's handleGroupChatMessage expects for the current turn
                text: combinedTextContent // Combined text for AI for this turn
            },
            originalUserText: content, // Pass the original user input separately for history saving
            timestamp: userMessageForUI.timestamp,
            id: userMessageForUI.id,
            attachments: uiAttachments // Pass full attachment info for backend processing (includes _fileManagerData)
        };

        try {
            // `sendGroupChatMessage` in main.js will call `groupchat.js` which handles streaming via `vcp-group-stream-chunk`
            const result = await electronAPI.sendGroupChatMessage(
                currentSelected.id,
                currentTopic,
                userMessageForIPC // Pass the message object with combined text to IPC
            );

            if (result.error) {
                // console.error("Sending group chat message failed (main process response):", result.error); // 根据用户要求移除此报错
                // messageRenderer.renderMessage({ // 根据用户要求移除此报错
                //     role: 'system',
                //     content: `群聊消息发送失败: ${result.error}`,
                //     timestamp: Date.now()
                // });
            } else {
                // Success means the message was handed off to groupchat.js for processing.
                // Responses will come via 'vcp-group-stream-chunk'.
                console.log("Group message sent to main process for handling.");
            }
        } catch (error) {
            // console.error('发送群聊消息时出错:', error); // 根据用户要求移除此报错
            // messageRenderer.renderMessage({ // 根据用户要求移除此报错
            //     role: 'system',
            //     content: `发送群聊消息时出错: ${error.message}`,
            //     timestamp: Date.now()
            // });
        }
    }


    async function loadGroupChatHistory(groupId, topicId) {
        messageRenderer.clearChat();
        const currentSelected = currentSelectedItemRef.get();

        if (!groupId || !topicId) {
            const errorMsg = `错误：无法加载群聊记录，群组ID (${groupId}) 或话题ID (${topicId}) 缺失。`;
            console.error(errorMsg);
            messageRenderer.renderMessage({ role: 'system', content: errorMsg, timestamp: Date.now() });
            return;
        }

        messageRenderer.renderMessage({ role: 'system', name: '系统', content: '加载聊天记录中...', timestamp: Date.now(), isThinking: true, id: 'loading_history' });

        try {
            const history = await electronAPI.getGroupChatHistory(groupId, topicId);
            messageRenderer.removeMessageById('loading_history');

            await mainRendererFunctions.displayTopicTimestampBubble(groupId, 'group', topicId);

            if (history.error) {
                messageRenderer.renderMessage({ role: 'system', content: `加载群聊记录失败: ${history.error}`, timestamp: Date.now() });
            } else {
                mainRendererFunctions.setCurrentChatHistory(history); // Update history in renderer.js
                history.forEach(msg => messageRenderer.renderMessage(msg, true)); // Render silently
            }
        } catch (error) {
            messageRenderer.removeMessageById('loading_history');
            messageRenderer.renderMessage({ role: 'system', content: `加载群聊记录时出错: ${error.message}`, timestamp: Date.now() });
        }
        uiHelper.scrollToBottom();
        if (groupId && topicId) {
            localStorage.setItem(`lastActiveTopic_${groupId}_group`, topicId);
        }
}

    function clearInviteAgentButtons() {
        const container = inviteAgentButtonsContainerRef ? inviteAgentButtonsContainerRef.get() : null;
        if (container) {
            container.innerHTML = '';
            container.style.display = 'none';
        }
    }

    async function displayInviteAgentButtons(groupId, topicId, membersConfigs, groupConfig) {
        const container = inviteAgentButtonsContainerRef ? inviteAgentButtonsContainerRef.get() : null;
        if (!container) {
            console.error("[GroupRenderer] Invite agent buttons container not found.");
            return;
        }
        container.innerHTML = ''; // Clear previous buttons

        if (!membersConfigs || membersConfigs.length === 0 || !groupConfig || groupConfig.mode !== 'invite_only') {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'grid'; // Using grid for layout as suggested
        // Example: container.style.gridTemplateColumns = 'repeat(3, 1fr)'; // Set by CSS later

        for (const memberConfig of membersConfigs) {
            if (!memberConfig || memberConfig.error) continue; // Skip invalid members

            const button = document.createElement('button');
            button.className = 'invite-agent-button';
            button.title = `邀请 ${memberConfig.name} 发言`;

            const avatarImg = document.createElement('img');
            avatarImg.src = memberConfig.avatarUrl || 'assets/default_avatar.png';
            avatarImg.alt = memberConfig.name;
            // Styles for avatar in button (can be moved to CSS)
            avatarImg.style.width = '24px';
            avatarImg.style.height = '24px';
            avatarImg.style.borderRadius = '50%';
            avatarImg.style.marginRight = '8px';
            avatarImg.style.objectFit = 'cover';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = memberConfig.name;

            button.appendChild(avatarImg);
            button.appendChild(nameSpan);

            button.addEventListener('click', () => {
                handleInviteAgentButtonClick(groupId, topicId, memberConfig.id, memberConfig.name);
            });
            container.appendChild(button);
        }
    }

    async function handleInviteAgentButtonClick(groupId, _topicId, agentId, agentName) { // _topicId is ignored
        const topicId = currentTopicIdRef.get(); // Always use the current topic ID
        console.log(`[GroupRenderer] Invite button clicked for agent: ${agentName} (ID: ${agentId}) in group ${groupId}, topic ${topicId}`);
        if (!topicId) {
            uiHelper.showToastNotification('错误：无法邀请发言，当前话题ID未知。', 'error');
            return;
        }
        try {
            const currentGlobalSettings = globalSettings.get();
            if (!currentGlobalSettings.vcpServerUrl) {
                if (uiHelper && uiHelper.showToastNotification) uiHelper.showToastNotification('请先在全局设置中配置VCP服务器URL！', 'error'); else alert('请先在全局设置中配置VCP服务器URL！');
                if (uiHelper && uiHelper.openModal) uiHelper.openModal('globalSettingsModal');
                return;
            }
            // Renderer informs main process to trigger the invitation.
            // Main process will then call groupchat.js's handleInviteAgentToSpeak.
            // Responses (thinking, data, end, error) will come via 'vcp-group-stream-chunk'.
            await electronAPI.inviteAgentToSpeak(groupId, topicId, agentId); // Use the fresh topicId
            // Optionally, provide some immediate UI feedback, e.g., a small spinner on the button,
            // or a toast "正在邀请 AgentName 发言..."
            // The actual message rendering will be handled by the vcp-group-stream-chunk listener.
        } catch (error) {
            console.error(`[GroupRenderer] Error inviting agent ${agentName}:`, error);
            if (uiHelper && uiHelper.showToastNotification) {
                uiHelper.showToastNotification(`邀请 ${agentName} 发言失败: ${error.message}`, 'error');
            } else {
                alert(`邀请 ${agentName} 发言失败: ${error.message}`);
            }
        }
    }

    // Public API for GroupRenderer
    console.log('[GroupRenderer] Preparing to return public API.');
    return {
        init,
        handleSelectGroup,
        displayGroupSettingsPage,
        loadTopicsForGroup, // Called when topics tab is selected for a group
        handleSendGroupMessage, // Called by renderer's send button if current chat is group
        loadGroupChatHistory,
        handleCreateNewGroup, // If button is managed here
        handleGroupTopicSelection,
        handleRenameGroupTopic,
        handleDeleteGroupTopic,
        handleExportGroupTopic,
        displayInviteAgentButtons, // Export for potential external calls if needed
        clearInviteAgentButtons,   // Export for potential external calls
        // Potentially other methods if renderer.js needs to interact more
    };
})();

// Note: This file will be included in main.html AFTER renderer.js,
// or renderer.js will need to dynamically load it.
// For simplicity, assume it's loaded via script tag, and renderer.js calls GroupRenderer.init().