/**
 * settingsManager.js
 * 
 * Manages the settings panel for both Agents and Groups.
 * Handles displaying, populating, saving, and deleting items.
 */
const settingsManager = (() => {
    /**
     * Completes a VCP Server URL to the full completions endpoint.
     * @param {string} url - The URL to complete.
     * @returns {string} The completed URL.
     */
    function completeVcpUrl(url) {
        if (!url) return '';
        let trimmedUrl = url.trim();
        if (trimmedUrl === '') return '';

        // If it doesn't have a protocol, add http://
        if (!/^https?:\/\//i.test(trimmedUrl)) {
            trimmedUrl = 'http://' + trimmedUrl;
        }

        try {
            const urlObject = new URL(trimmedUrl);
            const requiredPath = '/v1/chat/completions';

            // For any other case (e.g., root path '/', or some other path),
            // we set the path to the required one.
            urlObject.pathname = requiredPath;
            return urlObject.toString();

        } catch (e) {
            // If URL parsing fails, it's likely an invalid URL.
            // We return the original input for the user to see and correct.
            console.warn(`Could not parse and complete URL: ${url}`, e);
            return url;
        }
    }

    // --- Private Variables ---
    let electronAPI = null;
    let uiHelper = null;
    let refs = {}; // To hold references to currentSelectedItem, etc.
    let mainRendererFunctions = {}; // To call back to renderer.js functions if needed

    // DOM Elements
    let agentSettingsContainer, groupSettingsContainer, selectItemPromptForSettings;
    let itemSettingsContainerTitle, selectedItemNameForSettingsSpan, deleteItemBtn;
    let agentSettingsForm, editingAgentIdInput, agentNameInput, agentAvatarInput, agentAvatarPreview;
    let agentModelInput, agentTemperatureInput;
    let agentContextTokenLimitInput, agentMaxOutputTokensInput, agentTopPInput, agentTopKInput;
    let agentAvatarBorderColorInput, agentAvatarBorderColorTextInput;
    let agentNameTextColorInput, agentNameTextColorTextInput;
    let agentCustomCssInput;
    let promptManager = null; // PromptManager instance
    let openModelSelectBtn, modelSelectModal, modelList, modelSearchInput, refreshModelsBtn;
    let topicSummaryModelInput, openTopicSummaryModelSelectBtn; // New elements for topic summary model
    let agentTtsVoicePrimarySelect, agentTtsRegexPrimaryInput, agentTtsVoiceSecondarySelect, agentTtsRegexSecondaryInput, refreshTtsModelsBtn, agentTtsSpeedSlider, ttsSpeedValueSpan;
    let stripRegexListContainer;

    // --- New Regex Modal Elements ---
    let regexRuleModal, regexRuleForm, editingRegexRuleId, regexRuleTitle, regexRuleFind, regexRuleReplace;
    let regexRuleMinDepth, regexRuleMaxDepth, cancelRegexRuleBtn, closeRegexRuleModalBtn;

    // A private variable to hold the regex rules for the currently edited agent
    let currentAgentRegexes = [];
    let currentModelSelectCallback = null;
    const sectionControllers = new Map();
    let lastPersistedCollapseStateSignature = '';
    let scheduleStickyButtonsRefresh = () => { };
    const initializedCollapseStateAgents = new Set();
    const promptModeFallbackLabels = {
        original: '文本',
        modular: '模块',
        preset: '预置'
    };

    /**
     * Displays the appropriate settings view (agent, group, or default prompt)
     * based on the currently selected item.
     */
    async function displaySettingsForItem() {
        const currentSelectedItem = refs.currentSelectedItemRef.get();

        const agentSettingsExists = agentSettingsContainer && typeof agentSettingsContainer.style !== 'undefined';
        const groupSettingsExists = groupSettingsContainer && typeof groupSettingsContainer.style !== 'undefined';

        if (currentSelectedItem.id) {
            selectItemPromptForSettings.style.display = 'none';
            selectedItemNameForSettingsSpan.textContent = currentSelectedItem.name || currentSelectedItem.id;

            if (currentSelectedItem.type === 'agent') {
                if (agentSettingsExists) agentSettingsContainer.style.display = '';
                if (groupSettingsExists) groupSettingsContainer.style.display = 'none';
                itemSettingsContainerTitle.textContent = 'Agent 设置: ';
                deleteItemBtn.textContent = '删除此 Agent';
                await populateAgentSettingsForm(currentSelectedItem.id, (currentSelectedItem.config || currentSelectedItem));
            } else if (currentSelectedItem.type === 'group') {
                if (agentSettingsExists) agentSettingsContainer.style.display = 'none';
                if (groupSettingsExists) groupSettingsContainer.style.display = 'block';
                itemSettingsContainerTitle.textContent = '群组设置: ';
                deleteItemBtn.textContent = '删除此群组';
                if (window.GroupRenderer && typeof window.GroupRenderer.displayGroupSettingsPage === 'function') {
                    window.GroupRenderer.displayGroupSettingsPage(currentSelectedItem.id);
                } else {
                    console.error("GroupRenderer or displayGroupSettingsPage not available.");
                    if (groupSettingsExists) groupSettingsContainer.innerHTML = "<p>无法加载群组设置界面。</p>";
                }
            }
        } else {
            if (agentSettingsExists) agentSettingsContainer.style.display = 'none';
            if (groupSettingsExists) groupSettingsContainer.style.display = 'none';
            selectItemPromptForSettings.textContent = '请先在左侧选择一个 Agent 或群组以查看或修改其设置。';
            selectItemPromptForSettings.style.display = 'block';
            itemSettingsContainerTitle.textContent = '设置';
            selectedItemNameForSettingsSpan.textContent = '';
        }
    }

    /**
     * Populates the agent settings form with the config of the selected agent.
     * @param {string} agentId - The ID of the agent.
     * @param {object} agentConfig - The configuration object for the agent.
     */
    async function populateAgentSettingsForm(agentId, agentConfig) {
        if (groupSettingsContainer) groupSettingsContainer.style.display = 'none';
        if (agentSettingsContainer) agentSettingsContainer.style.display = '';

        if (!agentConfig || agentConfig.error) {
            uiHelper.showToastNotification(`加载Agent配置失败: ${agentConfig?.error || '未知错误'}`, 'error');
            if (agentSettingsContainer) agentSettingsContainer.style.display = 'none';
            selectItemPromptForSettings.textContent = `加载 ${agentId} 配置失败。`;
            selectItemPromptForSettings.style.display = 'block';
            return;
        }

        editingAgentIdInput.value = agentId;
        agentNameInput.value = agentConfig.name || agentId;

        // Initialize PromptManager (Singleton Pattern)
        const systemPromptContainer = document.getElementById('systemPromptContainer');
        if (systemPromptContainer && window.PromptManager) {
            if (!promptManager) {
                promptManager = new window.PromptManager();
                await promptManager.init({
                    containerElement: systemPromptContainer,
                    electronAPI: electronAPI
                });
            } else {
                // Save current state before switching context
                await promptManager.saveCurrentModeData();
            }

            await promptManager.updateAgentContext(agentId, agentConfig);
        }

        agentModelInput.value = agentConfig.model || '';
        agentTemperatureInput.value = agentConfig.temperature !== undefined ? agentConfig.temperature : 0.7;
        agentContextTokenLimitInput.value = agentConfig.contextTokenLimit !== undefined ? agentConfig.contextTokenLimit : 4000;
        agentMaxOutputTokensInput.value = agentConfig.maxOutputTokens !== undefined ? agentConfig.maxOutputTokens : 1000;
        agentTopPInput.value = agentConfig.top_p !== undefined ? agentConfig.top_p : '';
        agentTopKInput.value = agentConfig.top_k !== undefined ? agentConfig.top_k : '';

        const streamOutput = agentConfig.streamOutput !== undefined ? agentConfig.streamOutput : true;
        document.getElementById('agentStreamOutputTrue').checked = streamOutput === true || String(streamOutput) === 'true';
        document.getElementById('agentStreamOutputFalse').checked = streamOutput === false || String(streamOutput) === 'false';

        // 获取头像包装器元素
        const avatarWrapper = agentAvatarPreview?.closest('.agent-avatar-wrapper');

        if (agentConfig.avatarUrl) {
            agentAvatarPreview.src = `${agentConfig.avatarUrl}${agentConfig.avatarUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
            agentAvatarPreview.style.display = 'block';
            // 有头像时移除 no-avatar 类
            if (avatarWrapper) {
                avatarWrapper.classList.remove('no-avatar');
            }
        } else {
            // 头像为空时显示默认头像，不进行颜色提取
            agentAvatarPreview.src = 'assets/default_avatar.png';
            agentAvatarPreview.style.display = 'block';
            // 无头像时添加 no-avatar 类，确保相机图标始终显示
            if (avatarWrapper) {
                avatarWrapper.classList.add('no-avatar');
            }
        }
        agentAvatarInput.value = '';
        mainRendererFunctions.setCroppedFile('agent', null);

        // Populate custom style settings
        agentAvatarBorderColorInput.value = agentConfig.avatarBorderColor || '#3d5a80';
        agentAvatarBorderColorTextInput.value = agentConfig.avatarBorderColor || '#3d5a80';
        agentNameTextColorInput.value = agentConfig.nameTextColor || '#ffffff';
        agentNameTextColorTextInput.value = agentConfig.nameTextColor || '#ffffff';
        agentCustomCssInput.value = agentConfig.customCss || '';

        // Load card CSS
        const agentCardCssInput = document.getElementById('agentCardCss');
        if (agentCardCssInput) {
            agentCardCssInput.value = agentConfig.cardCss || '';
        }

        // Load chat CSS
        const agentChatCssInput = document.getElementById('agentChatCss');
        if (agentChatCssInput) {
            agentChatCssInput.value = agentConfig.chatCss || '';
        }

        // Apply card CSS to the identity container in settings page
        applyCardCssToIdentityContainer(agentConfig.cardCss || '');

        // Load disableCustomColors setting
        const disableCustomColorsCheckbox = document.getElementById('disableCustomColors');
        if (disableCustomColorsCheckbox) {
            disableCustomColorsCheckbox.checked = agentConfig.disableCustomColors || false;
        }

        // Load useThemeColorsInChat setting
        const useThemeColorsInChatCheckbox = document.getElementById('useThemeColorsInChat');
        if (useThemeColorsInChatCheckbox) {
            useThemeColorsInChatCheckbox.checked = agentConfig.useThemeColorsInChat || false;
        }

        // Populate bilingual TTS settings
        await populateTtsModels(agentConfig.ttsVoicePrimary, agentConfig.ttsVoiceSecondary);

        agentTtsRegexPrimaryInput.value = agentConfig.ttsRegexPrimary || '';
        agentTtsRegexSecondaryInput.value = agentConfig.ttsRegexSecondary || '';

        agentTtsSpeedSlider.value = agentConfig.ttsSpeed !== undefined ? agentConfig.ttsSpeed : 1.0;
        ttsSpeedValueSpan.textContent = parseFloat(agentTtsSpeedSlider.value).toFixed(1);

        // Load and render regex rules
        currentAgentRegexes = JSON.parse(JSON.stringify(agentConfig.stripRegexes || [])); // Deep copy
        renderRegexList();

        // Restore collapse states after dynamic content is ready
        restoreCollapseStates(agentConfig);
        updateAllSectionSummaries();
        scheduleStickyButtonsRefresh();
    }

    /**
     * Handles the submission of the agent settings form, saving the changes.
     * @param {Event} event - The form submission event.
     */
    async function saveCurrentAgentSettings(event) {
        event.preventDefault();
        const agentId = editingAgentIdInput.value;
        if (!agentId) {
            console.error("[SettingsManager] Cannot save agent settings: agentId is missing.");
            uiHelper.showToastNotification("保存失败：未指定 Agent ID", 'error');
            return;
        }

        // Get system prompt from PromptManager
        let systemPromptData = {};
        if (promptManager) {
            await promptManager.saveCurrentModeData();
            const currentPrompt = await promptManager.getCurrentSystemPrompt();
            systemPromptData.systemPrompt = currentPrompt; // Keep for compatibility
        }

        const newConfig = {
            name: agentNameInput.value.trim(),
            ...systemPromptData,
            model: agentModelInput.value.trim() || 'gemini-pro',
            temperature: parseFloat(agentTemperatureInput.value),
            contextTokenLimit: parseInt(agentContextTokenLimitInput.value),
            maxOutputTokens: parseInt(agentMaxOutputTokensInput.value),
            top_p: parseFloat(agentTopPInput.value) || undefined,
            top_k: parseInt(agentTopKInput.value) || undefined,
            streamOutput: document.getElementById('agentStreamOutputTrue').checked,
            ttsVoicePrimary: agentTtsVoicePrimarySelect.value,
            ttsRegexPrimary: agentTtsRegexPrimaryInput.value.trim(),
            ttsVoiceSecondary: agentTtsVoiceSecondarySelect.value,
            ttsRegexSecondary: agentTtsRegexSecondaryInput.value.trim(),
            ttsSpeed: parseFloat(agentTtsSpeedSlider.value),
            stripRegexes: currentAgentRegexes,
            avatarBorderColor: agentAvatarBorderColorInput.value,
            nameTextColor: agentNameTextColorInput.value,
            customCss: agentCustomCssInput.value.trim(),
            cardCss: document.getElementById('agentCardCss')?.value.trim() || '',
            chatCss: document.getElementById('agentChatCss')?.value.trim() || '',
            disableCustomColors: document.getElementById('disableCustomColors')?.checked || false,
            useThemeColorsInChat: document.getElementById('useThemeColorsInChat')?.checked || false,
            uiCollapseStates: getCurrentCollapseStates()
        };

        if (!newConfig.name) {
            uiHelper.showToastNotification("Agent名称不能为空！", 'error');
            return;
        }

        const croppedFile = mainRendererFunctions.getCroppedFile('agent');
        if (croppedFile) {
            try {
                const arrayBuffer = await croppedFile.arrayBuffer();
                const avatarResult = await electronAPI.saveAvatar(agentId, {
                    name: croppedFile.name,
                    type: croppedFile.type,
                    buffer: arrayBuffer
                });

                if (avatarResult.error) {
                    uiHelper.showToastNotification(`保存Agent头像失败: ${avatarResult.error}`, 'error');
                    // 如果头像保存失败，视情况决定是否继续保存其他配置。这里选择报错并中断。
                    return;
                } else {
                    // 只在成功保存真实头像文件后才提取颜色
                    if (avatarResult.needsColorExtraction && avatarResult.avatarUrl && electronAPI.saveAvatarColor) {
                        // 这里不阻塞主流程，但也进行错误处理
                        uiHelper.getAverageColorFromAvatar(avatarResult.avatarUrl, (avgColor) => {
                            if (avgColor) {
                                electronAPI.saveAvatarColor({ type: 'agent', id: agentId, color: avgColor })
                                    .then((saveColorResult) => {
                                        if (saveColorResult && saveColorResult.success) {
                                            if (refs.currentSelectedItemRef.get().id === agentId && refs.currentSelectedItemRef.get().type === 'agent' && window.messageRenderer) {
                                                window.messageRenderer.setCurrentItemAvatarColor(avgColor);
                                            }
                                        } else {
                                            console.warn(`Failed to save agent ${agentId} avatar color:`, saveColorResult?.error);
                                        }
                                    }).catch(err => console.error(`Error saving agent ${agentId} avatar color:`, err));
                            }
                        });
                    }
                    agentAvatarPreview.src = avatarResult.avatarUrl;
                    mainRendererFunctions.setCroppedFile('agent', null);
                    agentAvatarInput.value = '';
                }
            } catch (readError) {
                console.error("读取Agent头像文件失败:", readError);
                uiHelper.showToastNotification(`读取Agent头像文件失败: ${readError.message}`, 'error');
                return; // 中断保存
            }
        }

        const result = await electronAPI.saveAgentConfig(agentId, newConfig);
        const saveButton = agentSettingsForm.querySelector('button[type="submit"]');

        if (result.success) {
            if (saveButton) uiHelper.showSaveFeedback(saveButton, true, '已保存!', '保存 Agent 设置');
            await window.itemListManager.loadItems();

            const currentSelectedItem = refs.currentSelectedItemRef.get();
            if (currentSelectedItem.id === agentId && currentSelectedItem.type === 'agent') {
                const updatedAgentConfig = await electronAPI.getAgentConfig(agentId);
                
                // ⚠️ 检查是否返回错误对象
                if (updatedAgentConfig && updatedAgentConfig.error) {
                    console.error(`[SettingsManager] Failed to get updated agent config:`, updatedAgentConfig.error);
                    uiHelper.showToastNotification(`无法刷新Agent配置: ${updatedAgentConfig.error}`, 'warning');
                    // 仍然更新名称，但不更新其他可能缺失的属性
                    currentSelectedItem.name = newConfig.name;
                    selectedItemNameForSettingsSpan.textContent = newConfig.name;
                    if (mainRendererFunctions.updateChatHeader) {
                        mainRendererFunctions.updateChatHeader(`与 ${newConfig.name} 聊天中`);
                    }
                } else if (updatedAgentConfig) {
                    currentSelectedItem.name = newConfig.name;
                    if (currentSelectedItem.config) {
                        currentSelectedItem.config = updatedAgentConfig;
                    } else {
                        Object.assign(currentSelectedItem, updatedAgentConfig);
                    }

                    // Update other UI parts via callbacks or direct calls if modules are passed in
                    if (mainRendererFunctions.updateChatHeader) {
                        mainRendererFunctions.updateChatHeader(`与 ${newConfig.name} 聊天中`);
                    }
                    if (window.messageRenderer) {
                        window.messageRenderer.setCurrentItemAvatar(updatedAgentConfig.avatarUrl);
                        window.messageRenderer.setCurrentItemAvatarColor(updatedAgentConfig.avatarCalculatedColor || null);
                    }
                    selectedItemNameForSettingsSpan.textContent = newConfig.name;
                }
            }
        } else {
            if (saveButton) uiHelper.showSaveFeedback(saveButton, false, '保存失败', '保存 Agent 设置');
            uiHelper.showToastNotification(`保存Agent设置失败: ${result.error}`, 'error');
        }
    }

    /**
     * Handles the deletion of the currently selected item (agent or group).
     */
    async function handleDeleteCurrentItem() {
        const currentSelectedItem = refs.currentSelectedItemRef.get();
        if (!currentSelectedItem.id) {
            uiHelper.showToastNotification("没有选中的项目可删除。", 'info');
            return;
        }

        const itemTypeDisplay = currentSelectedItem.type === 'group' ? '群组' : 'Agent';
        const itemName = currentSelectedItem.name || '当前选中的项目';

        if (await uiHelper.showConfirmDialog(`您确定要删除 ${itemTypeDisplay} "${itemName}" 吗？其所有聊天记录和设置都将被删除，此操作不可撤销！`, '删除确认', '删除', '取消', true)) {
            let result;
            if (currentSelectedItem.type === 'agent') {
                result = await electronAPI.deleteAgent(currentSelectedItem.id);
            } else if (currentSelectedItem.type === 'group') {
                result = await electronAPI.deleteAgentGroup(currentSelectedItem.id);
            }

            if (result && result.success) {
                // Reset state in renderer via refs
                refs.currentSelectedItemRef.set({ id: null, type: null, name: null, avatarUrl: null, config: null });
                refs.currentTopicIdRef.set(null);
                refs.currentChatHistoryRef.set([]);

                // Call back to renderer to update UI
                if (mainRendererFunctions.onItemDeleted) {
                    mainRendererFunctions.onItemDeleted();
                }
            } else {
                uiHelper.showToastNotification(`删除${itemTypeDisplay}失败: ${result?.error || '未知错误'}`, 'error');
            }
        }
    }

    /**
     * Populates the assistant agent select dropdown with available agents.
     */
    async function populateAssistantAgentSelect() {
        const assistantAgentSelect = document.getElementById('assistantAgent');
        if (!assistantAgentSelect) {
            console.warn('[SettingsManager] populateAssistantAgentSelect: assistantAgentSelect element not found');
            return;
        }

        const agents = await electronAPI.getAgents();
        if (agents && !agents.error) {
            assistantAgentSelect.innerHTML = '<option value="">请选择一个Agent</option>'; // Clear and add placeholder
            agents.forEach(agent => {
                const option = document.createElement('option');
                option.value = agent.id;
                option.textContent = agent.name || agent.id;
                assistantAgentSelect.appendChild(option);
            });
        } else {
            console.error('[SettingsManager] Failed to load agents for assistant select:', agents?.error);
            assistantAgentSelect.innerHTML = '<option value="">加载Agent失败</option>';
        }
    }

    /**
     * Populates the primary and secondary TTS voice model select dropdowns.
     * @param {string} currentPrimaryVoice - The currently selected primary voice.
     * @param {string} currentSecondaryVoice - The currently selected secondary voice.
     */
    async function populateTtsModels(currentPrimaryVoice, currentSecondaryVoice) {
        if (!agentTtsVoicePrimarySelect || !agentTtsVoiceSecondarySelect) return;

        const globalSettings = window.globalSettings || {};
        const isNetworkMode = globalSettings.voiceMode === 'network';

        try {
            // Clear existing options
            agentTtsVoicePrimarySelect.innerHTML = '<option value="">不使用语音</option>';
            agentTtsVoiceSecondarySelect.innerHTML = '<option value="">不使用</option>';

            let optionList = [];

            if (isNetworkMode && electronAPI.loadWebindexModels) {
                const webindexPayload = await electronAPI.loadWebindexModels();
                const models = Array.isArray(webindexPayload?.models) ? webindexPayload.models : [];
                optionList = models.flatMap(model => Array.isArray(model.mergedVoiceOptions) ? model.mergedVoiceOptions : []);
            } else {
                const localModels = await electronAPI.sovitsGetModels();
                optionList = localModels && typeof localModels === 'object'
                    ? Object.keys(localModels).map(modelName => ({
                        id: modelName,
                        voice: modelName,
                        displayName: modelName,
                        type: 'local'
                    }))
                    : [];
            }

            if (optionList.length > 0) {
                optionList.forEach(item => {
                    const optionValue = item.voice || item.id;
                    const optionLabel = item.displayName || item.voice || item.id;

                    const primaryOption = document.createElement('option');
                    primaryOption.value = optionValue;
                    primaryOption.textContent = optionLabel;
                    if (optionValue === currentPrimaryVoice) {
                        primaryOption.selected = true;
                    }
                    agentTtsVoicePrimarySelect.appendChild(primaryOption);

                    const secondaryOption = document.createElement('option');
                    secondaryOption.value = optionValue;
                    secondaryOption.textContent = optionLabel;
                    if (optionValue === currentSecondaryVoice) {
                        secondaryOption.selected = true;
                    }
                    agentTtsVoiceSecondarySelect.appendChild(secondaryOption);
                });
            } else {
                const disabledOption = isNetworkMode
                    ? '<option value="" disabled>未找到网络音色，请先生成 webindexmodel.json</option>'
                    : '<option value="" disabled>未找到模型,请启动Sovits</option>';
                agentTtsVoicePrimarySelect.innerHTML += disabledOption;
                agentTtsVoiceSecondarySelect.innerHTML += disabledOption;
            }
        } catch (error) {
            console.error('Failed to get TTS models:', error);
            const errorOption = isNetworkMode
                ? '<option value="" disabled>获取网络音色失败</option>'
                : '<option value="" disabled>获取模型失败</option>';
            agentTtsVoicePrimarySelect.innerHTML = errorOption;
            agentTtsVoiceSecondarySelect.innerHTML = errorOption;
            uiHelper.showToastNotification(isNetworkMode ? '获取网络音色失败' : '获取Sovits语音模型失败', 'error');
        }
    }

    /**
     * 设置鼠标快捷键事件监听器
     */
    function setupMouseShortcuts() {
        const settingsContainer = document.getElementById('tabContentSettings');
        if (!settingsContainer) {
            console.warn('[SettingsManager] 设置容器未找到，跳过鼠标快捷键设置');
            return;
        }

        let lastRightClickTime = 0;

        // 双击右键：返回助手页面
        settingsContainer.addEventListener('contextmenu', (e) => {
            const currentTime = Date.now();
            const timeDiff = currentTime - lastRightClickTime;

            if (timeDiff < 300) { // 双击检测（300ms内）
                console.log('[SettingsManager] 检测到双击右键，返回助手页面');
                e.preventDefault();
                e.stopPropagation();

                // 切换到助手页面
                if (window.uiManager && typeof window.uiManager.switchToTab === 'function') {
                    window.uiManager.switchToTab('agents');
                    // 重置助手页面的鼠标事件状态，确保双击功能正常工作
                    if (window.itemListManager && typeof window.itemListManager.resetMouseEventStates === 'function') {
                        window.itemListManager.resetMouseEventStates();
                    }
                } else {
                    console.warn('[SettingsManager] uiManager不可用，无法切换到助手页面');
                }
            }

            lastRightClickTime = currentTime;
        });

        // 中键点击：进入话题页面
        settingsContainer.addEventListener('auxclick', (e) => {
            if (e.button === 1) { // 中键
                console.log('[SettingsManager] 检测到中键点击，进入话题页面');
                e.preventDefault();
                e.stopPropagation();

                // 切换到话题页面
                if (window.uiManager && typeof window.uiManager.switchToTab === 'function') {
                    window.uiManager.switchToTab('topics');
                } else {
                    console.warn('[SettingsManager] uiManager不可用，无法切换到话题页面');
                }
            }
        });

        // 防止中键点击的默认行为
        settingsContainer.addEventListener('mousedown', (e) => {
            if (e.button === 1) { // 中键
                e.preventDefault();
            }
        });

        console.log('[SettingsManager] 鼠标快捷键设置完成');
    }

    // --- Public API ---
    return {
        init: (options) => {
            electronAPI = options.electronAPI;
            uiHelper = options.uiHelper;
            refs = options.refs;
            mainRendererFunctions = options.mainRendererFunctions;

            // DOM Elements (Always present)
            agentSettingsContainer = options.elements.agentSettingsContainer;
            groupSettingsContainer = options.elements.groupSettingsContainer;
            selectItemPromptForSettings = options.elements.selectItemPromptForSettings;
            itemSettingsContainerTitle = options.elements.itemSettingsContainerTitle;
            selectedItemNameForSettingsSpan = options.elements.selectedItemNameForSettingsSpan;
            deleteItemBtn = options.elements.deleteItemBtn;
            agentSettingsForm = options.elements.agentSettingsForm;
            editingAgentIdInput = options.elements.editingAgentIdInput;
            agentNameInput = options.elements.agentNameInput;
            agentAvatarInput = options.elements.agentAvatarInput;
            agentAvatarPreview = options.elements.agentAvatarPreview;
            agentModelInput = options.elements.agentModelInput;
            agentTemperatureInput = options.elements.agentTemperatureInput;
            agentContextTokenLimitInput = options.elements.agentContextTokenLimitInput;
            agentMaxOutputTokensInput = options.elements.agentMaxOutputTokensInput;
            agentTopPInput = document.getElementById('agentTopP');
            agentTopKInput = document.getElementById('agentTopK');

            agentAvatarBorderColorInput = document.getElementById('agentAvatarBorderColor');
            agentAvatarBorderColorTextInput = document.getElementById('agentAvatarBorderColorText');
            agentNameTextColorInput = document.getElementById('agentNameTextColor');
            agentNameTextColorTextInput = document.getElementById('agentNameTextColorText');
            agentCustomCssInput = document.getElementById('agentCustomCss');
            openModelSelectBtn = options.elements.openModelSelectBtn;
            topicSummaryModelInput = options.elements.topicSummaryModelInput;
            openTopicSummaryModelSelectBtn = options.elements.openTopicSummaryModelSelectBtn;

            agentTtsVoicePrimarySelect = document.getElementById('agentTtsVoicePrimary');
            agentTtsRegexPrimaryInput = document.getElementById('agentTtsRegexPrimary');
            agentTtsVoiceSecondarySelect = document.getElementById('agentTtsVoiceSecondary');
            agentTtsRegexSecondaryInput = document.getElementById('agentTtsRegexSecondary');
            refreshTtsModelsBtn = document.getElementById('refreshTtsModelsBtn');
            agentTtsSpeedSlider = options.elements.agentTtsSpeedSlider;
            ttsSpeedValueSpan = options.elements.ttsSpeedValueSpan;

            // 🟢 监听模态框就绪事件，动态绑定延迟加载的元素
            document.addEventListener('modal-ready', (e) => {
                const { modalId } = e.detail;
                if (modalId === 'modelSelectModal') {
                    modelSelectModal = document.getElementById('modelSelectModal');
                    modelList = document.getElementById('modelList');
                    modelSearchInput = document.getElementById('modelSearchInput');
                    refreshModelsBtn = document.getElementById('refreshModelsBtn');

                    if (modelSearchInput) modelSearchInput.addEventListener('input', filterModels);
                    if (refreshModelsBtn) refreshModelsBtn.addEventListener('click', handleRefreshModels);
                }
                if (modalId === 'regexRuleModal') {
                    regexRuleModal = document.getElementById('regexRuleModal');
                    regexRuleForm = document.getElementById('regexRuleForm');
                    editingRegexRuleId = document.getElementById('editingRegexRuleId');
                    regexRuleTitle = document.getElementById('regexRuleTitle');
                    regexRuleFind = document.getElementById('regexRuleFind');
                    regexRuleReplace = document.getElementById('regexRuleReplace');
                    regexRuleMinDepth = document.getElementById('regexRuleMinDepth');
                    regexRuleMaxDepth = document.getElementById('regexRuleMaxDepth');
                    cancelRegexRuleBtn = document.getElementById('cancelRegexRule');
                    closeRegexRuleModalBtn = document.getElementById('closeRegexRuleModal');

                    if (regexRuleForm) regexRuleForm.addEventListener('submit', handleRegexFormSubmit);
                    if (cancelRegexRuleBtn) cancelRegexRuleBtn.addEventListener('click', closeRegexModal);
                    if (closeRegexRuleModalBtn) closeRegexRuleModalBtn.addEventListener('click', closeRegexModal);
                    if (regexRuleModal) {
                        regexRuleModal.addEventListener('click', (ev) => {
                            if (ev.target === regexRuleModal) closeRegexModal();
                        });
                    }
                }
                if (modalId === 'globalSettingsModal') {
                    topicSummaryModelInput = document.getElementById('topicSummaryModel');
                    openTopicSummaryModelSelectBtn = document.getElementById('openTopicSummaryModelSelectBtn');

                    if (openTopicSummaryModelSelectBtn) {
                        openTopicSummaryModelSelectBtn.addEventListener('click', () => handleOpenModelSelect(topicSummaryModelInput));
                    }
                }
            });

            // Event Listeners for always-present elements
            if (agentSettingsForm) {
                agentSettingsForm.addEventListener('submit', saveCurrentAgentSettings);
            }
            if (deleteItemBtn) {
                deleteItemBtn.addEventListener('click', handleDeleteCurrentItem);
            }
            if (agentAvatarInput) {
                agentAvatarInput.addEventListener('change', (event) => {
                    const file = event.target.files[0];
                    if (file) {
                        uiHelper.openAvatarCropper(file, (croppedFileResult) => {
                            mainRendererFunctions.setCroppedFile('agent', croppedFileResult);
                            if (agentAvatarPreview) {
                                const previewUrl = URL.createObjectURL(croppedFileResult);
                                agentAvatarPreview.src = previewUrl;
                                agentAvatarPreview.style.display = 'block';

                                // 上传新头像后移除 no-avatar 类
                                const avatarWrapper = agentAvatarPreview.closest('.agent-avatar-wrapper');
                                if (avatarWrapper) {
                                    avatarWrapper.classList.remove('no-avatar');
                                }

                                // 只对用户上传的真实头像进行颜色提取，不对默认头像提取
                                // 裁切完成后立即计算颜色并填充到输入框
                                // 使用与全局设置相同的getDominantAvatarColor函数以保持一致性
                                if (window.getDominantAvatarColor) {
                                    window.getDominantAvatarColor(previewUrl).then((avgColor) => {
                                        if (avgColor && agentAvatarBorderColorInput && agentNameTextColorInput) {
                                            // 将rgb格式转换为hex格式
                                            const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                                            if (rgbMatch) {
                                                const r = parseInt(rgbMatch[1]);
                                                const g = parseInt(rgbMatch[2]);
                                                const b = parseInt(rgbMatch[3]);
                                                const hexColor = '#' + [r, g, b].map(x => {
                                                    const hex = x.toString(16);
                                                    return hex.length === 1 ? '0' + hex : hex;
                                                }).join('');

                                                // 填充到两个颜色输入框
                                                agentAvatarBorderColorInput.value = hexColor;
                                                agentAvatarBorderColorTextInput.value = hexColor;
                                                agentNameTextColorInput.value = hexColor;
                                                agentNameTextColorTextInput.value = hexColor;

                                                // 更新头像预览的边框颜色
                                                agentAvatarPreview.style.borderColor = hexColor;

                                                console.log('[SettingsManager] Auto-filled colors from avatar:', hexColor);
                                            }
                                        }
                                    }).catch(err => {
                                        console.error('[SettingsManager] Error extracting color:', err);
                                    });
                                } else {
                                    console.warn('[SettingsManager] getDominantAvatarColor not available, using fallback');
                                    // 降级使用原来的方法
                                    uiHelper.getAverageColorFromAvatar(previewUrl, (avgColor) => {
                                        if (avgColor && agentAvatarBorderColorInput && agentNameTextColorInput) {
                                            const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                                            if (rgbMatch) {
                                                const r = parseInt(rgbMatch[1]);
                                                const g = parseInt(rgbMatch[2]);
                                                const b = parseInt(rgbMatch[3]);
                                                const hexColor = '#' + [r, g, b].map(x => {
                                                    const hex = x.toString(16);
                                                    return hex.length === 1 ? '0' + hex : hex;
                                                }).join('');

                                                agentAvatarBorderColorInput.value = hexColor;
                                                agentAvatarBorderColorTextInput.value = hexColor;
                                                agentNameTextColorInput.value = hexColor;
                                                agentNameTextColorTextInput.value = hexColor;
                                                agentAvatarPreview.style.borderColor = hexColor;

                                                console.log('[SettingsManager] Auto-filled colors from avatar (fallback):', hexColor);
                                            }
                                        }
                                    });
                                }
                            }
                        }, 'agent');
                    } else {
                        if (agentAvatarPreview) agentAvatarPreview.style.display = 'none';
                        mainRendererFunctions.setCroppedFile('agent', null);
                    }
                });
            }

            if (openModelSelectBtn) {
                openModelSelectBtn.addEventListener('click', () => handleOpenModelSelect(agentModelInput));
            }
            if (modelSearchInput) {
                modelSearchInput.addEventListener('input', filterModels);
            }
            if (refreshModelsBtn) {
                refreshModelsBtn.addEventListener('click', handleRefreshModels);
            }
            if (electronAPI.onModelsUpdated) {
                electronAPI.onModelsUpdated(async (models) => {
                    console.log('[SettingsManager] Received models-updated event. Repopulating list.');
                    let hotModelIds = [];
                    let favoriteModelIds = [];
                    try {
                        if (electronAPI.getHotModels) {
                            hotModelIds = await electronAPI.getHotModels();
                        }
                        if (electronAPI.getFavoriteModels) {
                            favoriteModelIds = await electronAPI.getFavoriteModels();
                        }
                    } catch (e) { /* ignore */ }
                    populateModelList(models, currentModelSelectCallback, hotModelIds, favoriteModelIds);
                    uiHelper.showToastNotification('模型列表已刷新', 'success');
                });
            }

            if (agentTtsSpeedSlider && ttsSpeedValueSpan) {
                agentTtsSpeedSlider.addEventListener('input', () => {
                    ttsSpeedValueSpan.textContent = parseFloat(agentTtsSpeedSlider.value).toFixed(1);
                });
            }

            if (refreshTtsModelsBtn) {
                refreshTtsModelsBtn.addEventListener('click', async () => {
                    const isNetworkMode = (window.globalSettings || {}).voiceMode === 'network';
                    uiHelper.showToastNotification(isNetworkMode ? '正在刷新网络音色列表...' : '正在刷新语音模型...', 'info');
                    try {
                        if (!isNetworkMode) {
                            await electronAPI.sovitsGetModels(true); // force refresh
                        }
                        await populateTtsModels(agentTtsVoicePrimarySelect.value, agentTtsVoiceSecondarySelect.value); // repopulate
                        uiHelper.showToastNotification(isNetworkMode ? '网络音色列表已刷新' : '语音模型列表已刷新', 'success');
                    } catch (e) {
                        uiHelper.showToastNotification(isNetworkMode ? '刷新网络音色失败' : '刷新语音模型失败', 'error');
                    }
                });
            }

            // 创建正则设置UI
            createStripRegexUI();

            // 添加Agent设置滚动条粘性按钮逻辑
            setupAgentSettingsStickyButtons();

            // 设置鼠标快捷键
            setupMouseShortcuts();

            // Setup color picker synchronization
            setupColorPickerSync();

            // Setup unified collapsible sections
            setupAgentSettingsSections();

            // Setup style collapsible
            setupStyleCollapsible();

            // Setup reset colors button
            if (resetAvatarColorsBtn) {
                resetAvatarColorsBtn.addEventListener('click', handleResetAvatarColors);
            }

            // Setup card CSS input real-time preview
            const agentCardCssInput = document.getElementById('agentCardCss');
            if (agentCardCssInput) {
                agentCardCssInput.addEventListener('input', (e) => {
                    applyCardCssToIdentityContainer(e.target.value);
                });
            }

            console.log('settingsManager initialized.');

            // --- Global Settings Enhancements ---
            const vcpServerUrlInput = document.getElementById('vcpServerUrl');
            if (vcpServerUrlInput) {
                vcpServerUrlInput.addEventListener('blur', () => {
                    const completedUrl = completeVcpUrl(vcpServerUrlInput.value);
                    vcpServerUrlInput.value = completedUrl;
                });
            }
        },
        prewarmPromptManager: async () => {
            const systemPromptContainer = document.getElementById('systemPromptContainer');
            if (systemPromptContainer && window.PromptManager && !promptManager) {
                console.log('[SettingsManager] Pre-warming PromptManager...');
                promptManager = new window.PromptManager();
                await promptManager.init({
                    containerElement: systemPromptContainer,
                    electronAPI: electronAPI
                });
            }
        },
        displaySettingsForItem: displaySettingsForItem,
        populateAssistantAgentSelect: populateAssistantAgentSelect,
        // Expose for external use if needed, e.g., in the save function
        completeVcpUrl: completeVcpUrl,
        openModelSelectForInput: async (targetInputElement) => {
            await handleOpenModelSelect(targetInputElement);
        },
        triggerAgentSave: async (overrideAgentId) => {
            // 触发Agent设置保存（不含头像）
            // 支持传入锁定的agentId，防止异步操作期间DOM状态变化导致写入错误Agent
            const agentId = overrideAgentId || editingAgentIdInput.value;
            if (!agentId) return;

            let systemPromptData = {};
            if (promptManager) {
                await promptManager.saveCurrentModeData();
                const currentPrompt = await promptManager.getCurrentSystemPrompt();
                systemPromptData.systemPrompt = currentPrompt;
            }

            const newConfig = {
                name: agentNameInput.value.trim(),
                ...systemPromptData,
                model: agentModelInput.value.trim() || 'gemini-pro',
                temperature: parseFloat(agentTemperatureInput.value),
                contextTokenLimit: parseInt(agentContextTokenLimitInput.value),
                maxOutputTokens: parseInt(agentMaxOutputTokensInput.value),
                top_p: parseFloat(agentTopPInput.value) || undefined,
                top_k: parseInt(agentTopKInput.value) || undefined,
                streamOutput: document.getElementById('agentStreamOutputTrue').checked,
                ttsVoicePrimary: agentTtsVoicePrimarySelect.value,
                ttsRegexPrimary: agentTtsRegexPrimaryInput.value.trim(),
                ttsVoiceSecondary: agentTtsVoiceSecondarySelect.value,
                ttsRegexSecondary: agentTtsRegexSecondaryInput.value.trim(),
                ttsSpeed: parseFloat(agentTtsSpeedSlider.value),
                stripRegexes: currentAgentRegexes
            };

            await electronAPI.saveAgentConfig(agentId, newConfig);
        },

        /**
         * 重新加载当前 Agent 的设置（用于外部触发刷新）
         * @param {string} agentId - Agent ID
         */
        reloadAgentSettings: async (agentId) => {
            // 检查是否正在编辑该 Agent
            if (editingAgentIdInput && editingAgentIdInput.value === agentId) {
                console.log('[SettingsManager] Reloading settings for agent:', agentId);

                // 确保设置页面是激活状态
                const settingsTab = document.getElementById('tabContentSettings');
                const isSettingsVisible = settingsTab && settingsTab.classList.contains('active');

                if (!isSettingsVisible) {
                    console.log('[SettingsManager] Settings tab not visible, performing silent config reload');

                    try {
                        // 方案1：直接重新加载配置并填充表单，不切换标签
                        const config = await electronAPI.getAgentConfig(agentId);
                        if (config && !config.error) {
                            // 临时激活设置标签内容（不改变按钮状态）
                            const originalDisplay = settingsTab.style.display;
                            settingsTab.style.display = 'block';
                            settingsTab.classList.add('active');

                            // 等待 DOM 准备好
                            await new Promise(resolve => setTimeout(resolve, 50));

                            // 重新填充表单
                            await populateAgentSettingsForm(agentId, config);
                            console.log('[SettingsManager] Agent settings reloaded silently');

                            // 恢复原始显示状态
                            await new Promise(resolve => setTimeout(resolve, 50));
                            settingsTab.classList.remove('active');
                            if (originalDisplay !== 'block') {
                                settingsTab.style.display = originalDisplay;
                            }

                            return { success: true, silent: true };
                        } else {
                            console.error('[SettingsManager] Failed to load config for silent reload:', config?.error);
                            return await performFullTabSwitch(agentId);
                        }
                    } catch (error) {
                        console.error('[SettingsManager] Error during silent reload:', error);
                        return await performFullTabSwitch(agentId);
                    }
                }

                // 重新加载配置（设置页面可见的情况）
                const config = await electronAPI.getAgentConfig(agentId);
                if (config && !config.error) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    await populateAgentSettingsForm(agentId, config);
                    console.log('[SettingsManager] Agent settings reloaded successfully');
                    sessionStorage.removeItem('pendingAgentReload');
                    return { success: true };
                } else {
                    console.error('[SettingsManager] Failed to reload agent config:', config?.error);
                    return { success: false, error: config?.error || 'Failed to load config' };
                }
            } else {
                console.log('[SettingsManager] Agent not currently being edited, skipping reload');
                return { success: true, skipped: true };
            }
        }
    };

    /**
     * 执行完整的标签切换刷新（降级方案 - 内部辅助函数）
     * @param {string} agentId - Agent ID
     */
    async function performFullTabSwitch(agentId) {
        console.log('[SettingsManager] Falling back to full tab switch method');

        const currentActiveTab = document.querySelector('.sidebar-tab-button.active');
        const currentTabName = currentActiveTab ? currentActiveTab.dataset.tab : 'agents';

        if (window.uiManager && typeof window.uiManager.switchToTab === 'function') {
            window.uiManager.switchToTab('settings');
            await new Promise(resolve => setTimeout(resolve, 100));

            try {
                const config = await electronAPI.getAgentConfig(agentId);
                if (config && !config.error) {
                    await populateAgentSettingsForm(agentId, config);
                    console.log('[SettingsManager] Agent settings reloaded (full tab switch)');
                }
            } catch (error) {
                console.error('[SettingsManager] Error during full tab switch:', error);
            }

            await new Promise(resolve => setTimeout(resolve, 50));
            window.uiManager.switchToTab(currentTabName);
            console.log('[SettingsManager] Switched back to:', currentTabName);

            return { success: true, fullSwitch: true };
        } else {
            console.warn('[SettingsManager] uiManager.switchToTab not available');
            sessionStorage.setItem('pendingAgentReload', agentId);
            return { success: true, deferred: true };
        }
    }

    /**
 * Opens the model selection modal and populates it with cached models.
 */
    async function handleOpenModelSelect(targetInputElement) {
        try {
            // 并行获取模型列表、热门模型和收藏模型
            let [models, hotModelIds, favoriteModelIds] = await Promise.all([
                electronAPI.getCachedModels(),
                electronAPI.getHotModels ? electronAPI.getHotModels() : Promise.resolve([]),
                electronAPI.getFavoriteModels ? electronAPI.getFavoriteModels() : Promise.resolve([])
            ]);

            // 如果缓存为空，尝试触发一次刷新并等待
            if (!models || models.length === 0) {
                console.log('[SettingsManager] Cached models empty, requesting refresh...');
                if (electronAPI.refreshModels) {
                    electronAPI.refreshModels();
                    // 等待一小会儿让主进程获取模型
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    models = await electronAPI.getCachedModels();
                }
            }

            currentModelSelectCallback = (modelId) => {
                if (targetInputElement) {
                    targetInputElement.value = modelId;
                    targetInputElement.dispatchEvent(new Event('input', { bubbles: true }));
                    targetInputElement.dispatchEvent(new Event('change', { bubbles: true }));
                }
                uiHelper.closeModal('modelSelectModal');
                updateSectionSummary('model');
            };
            uiHelper.openModal('modelSelectModal');
            // 确保在模态框打开后（DOM 元素已从模板实例化）再填充列表
            setTimeout(() => {
                populateModelList(models, currentModelSelectCallback, hotModelIds || [], favoriteModelIds || []);
            }, 0);
        } catch (error) {
            console.error('Failed to get cached models:', error);
            uiHelper.showToastNotification('获取模型列表失败', 'error');
        }
    }
    /**
 * Populates the model list in the modal.
 * @param {Array} models - An array of model objects.
 * @param {Function} onModelSelect - Callback when a model is selected.
 * @param {Array<string>} hotModelIds - Array of hot model IDs (top N most used).
 * @param {Array<string>} favoriteModelIds - Array of favorited model IDs.
 */
    function populateModelList(models, onModelSelect, hotModelIds = [], favoriteModelIds = []) {
        // 重新获取元素引用，因为它们可能是动态从模板生成的
        modelList = document.getElementById('modelList');
        if (!modelList) {
            console.warn('[SettingsManager] modelList element not found during populateModelList');
            return;
        }
        modelList.innerHTML = ''; // Clear existing list

        const isSingleModelObject = models
            && typeof models === 'object'
            && !Array.isArray(models)
            && typeof models.id === 'string';

        const normalizedModels = Array.isArray(models)
            ? models
            : Array.isArray(models?.data)
                ? models.data
                : Array.isArray(models?.models)
                    ? models.models
                    : isSingleModelObject
                        ? [models]
                        : [];
        const normalizedHotModelIds = Array.isArray(hotModelIds) ? hotModelIds : [];
        const normalizedFavoriteModelIds = Array.isArray(favoriteModelIds) ? favoriteModelIds : [];

        if (!Array.isArray(models) && !isSingleModelObject && !Array.isArray(models?.data) && !Array.isArray(models?.models)) {
            console.warn('[SettingsManager] populateModelList received unsupported models payload:', models);
        }

        if (normalizedModels.length === 0) {
            modelList.innerHTML = '<li>没有可用的模型。请检查您的 VCP 服务器 URL 或刷新列表。</li>';
            return;
        }

        const favSet = new Set(normalizedFavoriteModelIds);

        // 创建模型列表项的辅助函数
        function createModelLi(model, isHot, isFavoriteSection) {
            const li = document.createElement('li');
            li.dataset.modelId = model.id;

            // 热门标记
            if (isHot) {
                li.classList.add('hot-model');
                const badge = document.createElement('span');
                badge.className = 'hot-model-badge';
                badge.textContent = '🔥';
                li.appendChild(badge);
            }

            const nameSpan = document.createElement('span');
            nameSpan.className = 'model-name-text';
            nameSpan.textContent = model.id;
            li.appendChild(nameSpan);

            // 收藏星星
            const starSpan = document.createElement('span');
            starSpan.className = 'model-favorite-star';
            const isFavorited = favSet.has(model.id);
            if (isFavorited) {
                starSpan.classList.add('favorited');
                starSpan.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
            } else {
                starSpan.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
            }
            starSpan.title = isFavorited ? "取消收藏" : "收藏模型";

            // 星星点击事件：切换收藏状态
            starSpan.addEventListener('click', async (e) => {
                e.stopPropagation(); // 阻止触发模型选择
                if (electronAPI.toggleFavoriteModel) {
                    const result = await electronAPI.toggleFavoriteModel(model.id);
                    if (result && result.favorited !== undefined) {
                        // 重新拉取一次整个列表的逻辑，保持UI一致性
                        handleOpenModelSelect(document.getElementById('agentModel') || null); // Note: targetInputElement context is somewhat lost here, ideally we should just refresh the view
                    }
                }
            });
            li.appendChild(starSpan);

            li.addEventListener('click', () => {
                if (typeof onModelSelect === 'function') {
                    onModelSelect(model.id);
                }
            });
            return li;
        }

        // 🔥 热门模型分区
        if (normalizedHotModelIds.length > 0) {
            // 按热门列表顺序筛选出存在于当前模型列表中的热门模型
            const hotModels = normalizedHotModelIds
                .map(id => normalizedModels.find(m => m.id === id))
                .filter(Boolean);

            if (hotModels.length > 0) {
                const hotTitle = document.createElement('li');
                hotTitle.className = 'model-section-title';
                hotTitle.textContent = '🔥 热门模型';
                modelList.appendChild(hotTitle);

                hotModels.forEach(model => {
                    modelList.appendChild(createModelLi(model, true, false));
                });
            }
        }

        // ⭐ 收藏模型分区
        if (normalizedFavoriteModelIds.length > 0) {
            const favoriteModels = normalizedFavoriteModelIds
                .map(id => normalizedModels.find(m => m.id === id))
                .filter(Boolean);

            if (favoriteModels.length > 0) {
                const favTitle = document.createElement('li');
                favTitle.className = 'model-section-title';
                favTitle.textContent = '⭐ 收藏模型';
                modelList.appendChild(favTitle);

                favoriteModels.forEach(model => {
                    modelList.appendChild(createModelLi(model, false, true));
                });
            }
        }

        // 📋 全部模型分区
        if (normalizedModels.length > 0) {
            const allTitle = document.createElement('li');
            allTitle.className = 'model-section-title';
            allTitle.textContent = '📋 全部模型';
            modelList.appendChild(allTitle);

            normalizedModels.forEach(model => {
                modelList.appendChild(createModelLi(model, false, false));
            });
        }
    }

    /**
     * Filters the model list based on the search input.
     */
    function filterModels() {
        const filter = modelSearchInput.value.toLowerCase();
        const items = modelList.getElementsByTagName('li');
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            // 分区标题跟随其子项的可见性
            if (item.classList.contains('model-section-title')) {
                // 先隐藏标题，后面根据子项可见性再决定
                item.style.display = filter ? 'none' : '';
                continue;
            }
            const txtValue = item.textContent || item.innerText;
            if (txtValue.toLowerCase().indexOf(filter) > -1) {
                item.style.display = '';
            } else {
                item.style.display = 'none';
            }
        }
        // 搜索时隐藏所有分区标题以得到扁平化结果
        // 无搜索时恢复分区标题
        if (!filter) {
            for (let i = 0; i < items.length; i++) {
                items[i].style.display = '';
            }
        }
    }

    /**
     * Handles the refresh models button click.
     */
    async function handleRefreshModels() {
        if (!electronAPI.refreshModels) {
            uiHelper.showToastNotification('当前环境不支持刷新模型列表', 'error');
            return;
        }

        uiHelper.showToastNotification('正在刷新模型列表...', 'info');

        try {
            const result = await electronAPI.refreshModels();
            const models = Array.isArray(result?.models) ? result.models : await electronAPI.getCachedModels();

            let hotModelIds = [];
            let favoriteModelIds = [];
            try {
                if (electronAPI.getHotModels) {
                    hotModelIds = await electronAPI.getHotModels();
                }
                if (electronAPI.getFavoriteModels) {
                    favoriteModelIds = await electronAPI.getFavoriteModels();
                }
            } catch (e) {
                console.warn('[SettingsManager] Failed to refresh model metadata:', e);
            }

            populateModelList(models, currentModelSelectCallback, hotModelIds, favoriteModelIds);

            if (Array.isArray(models) && models.length > 0) {
                uiHelper.showToastNotification(`模型列表已刷新，共 ${models.length} 个模型`, 'success');
            } else {
                uiHelper.showToastNotification('模型列表刷新完成，但服务器未返回可用模型', 'warning');
            }
        } catch (error) {
            console.error('[SettingsManager] Failed to refresh models:', error);
            uiHelper.showToastNotification(`刷新模型列表失败: ${error.message || error}`, 'error');
        }
    }

    /**
     * Creates the strip regex UI section
     */
    // --- Regex Settings V2 ---

function createStripRegexUI() {
        const ttsCollapsibleContainer = getSectionContainer('tts');
        if (!ttsCollapsibleContainer || !ttsCollapsibleContainer.parentNode) {
            console.warn('[SettingsManager] TTS collapsible container not found for regex UI insertion');
            return;
        }

        const existingContainer = getSectionContainer('regex');
        if (existingContainer) {
            stripRegexListContainer = existingContainer.querySelector('#stripRegexListContainer');
            return;
        }

        const section = document.createElement('div');
        section.className = 'agent-settings-collapsible-container agent-settings-section strip-regex-container collapsed';
        section.dataset.sectionKey = 'regex';

        const header = document.createElement('div');
        header.className = 'agent-settings-section-header';
        header.id = 'regexToggleHeader';

        const title = document.createElement('span');
        title.className = 'agent-settings-section-title';
        title.textContent = '正则设置';
        header.appendChild(title);

        const summary = document.createElement('div');
        summary.className = 'agent-settings-section-summary';
        summary.id = 'regexSummary';
        header.appendChild(summary);

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'agent-settings-toggle-btn';
        toggleBtn.id = 'regexToggleBtn';
        toggleBtn.setAttribute('aria-label', '展开或收起正则设置');
        toggleBtn.innerHTML = `
            <svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
        `;
        header.appendChild(toggleBtn);

        const content = document.createElement('div');
        content.className = 'agent-settings-section-content';
        content.id = 'regexContent';

        const shell = document.createElement('div');
        shell.className = 'agent-settings-card-shell';

        stripRegexListContainer = document.createElement('div');
        stripRegexListContainer.id = 'stripRegexListContainer';
        stripRegexListContainer.className = 'strip-regex-list-container';
        shell.appendChild(stripRegexListContainer);

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '添加正则';
        addBtn.className = 'btn-add-regex';
        addBtn.addEventListener('click', () => openRegexModal());
        shell.appendChild(addBtn);

        const importBtn = document.createElement('button');
        importBtn.type = 'button';
        importBtn.textContent = '导入正则';
        importBtn.className = 'btn-add-regex btn-add-regex-secondary';
        importBtn.addEventListener('click', () => handleImportRegex());
        shell.appendChild(importBtn);

        content.appendChild(shell);
        section.appendChild(header);
        section.appendChild(content);

        ttsCollapsibleContainer.parentNode.insertBefore(section, ttsCollapsibleContainer.nextSibling);

        console.log('[SettingsManager] Regex UI created after TTS collapsible container');
    }

    function renderRegexList() {
        if (!stripRegexListContainer) return;
        stripRegexListContainer.innerHTML = '';
        currentAgentRegexes.forEach(rule => {
            const row = createRegexRow(rule);
            stripRegexListContainer.appendChild(row);
        });
        updateSectionSummary('regex');
        scheduleStickyButtonsRefresh();
    }

    function createRegexRow(rule) {
        const row = document.createElement('div');
        row.className = 'strip-regex-row';
        row.dataset.ruleId = rule.id;

        const title = document.createElement('span');
        title.className = 'strip-regex-title';
        title.textContent = rule.title || '(无标题)';
        title.title = rule.findPattern || '无查找内容';

        const buttonsContainer = document.createElement('div');
        buttonsContainer.style.display = 'flex';
        buttonsContainer.style.gap = '8px';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn-edit-regex';  // 保持原始样式类，保持主题适应性
        editBtn.title = '编辑规则';
        // 调整为与删除按钮完全相同的大小（38x38px）
        editBtn.style.height = '38px';    // 与删除按钮相同高度
        editBtn.style.width = '38px';     // 与删除按钮相同宽度
        editBtn.style.minHeight = '38px';
        editBtn.style.minWidth = '38px';
        editBtn.style.padding = '0';      // 与删除按钮相同的内边距
        editBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
        editBtn.addEventListener('click', () => openRegexModal(rule));

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-delete-regex';
        deleteBtn.title = '删除规则';
        deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
        deleteBtn.addEventListener('click', async () => {
            if (await uiHelper.showConfirmDialog(`确定要删除规则 "${rule.title}" 吗？`, '删除确认', '删除', '取消', true)) {
                currentAgentRegexes = currentAgentRegexes.filter(r => r.id !== rule.id);
                renderRegexList();
            }
        });

        buttonsContainer.appendChild(editBtn);
        buttonsContainer.appendChild(deleteBtn);
        row.appendChild(title);
        row.appendChild(buttonsContainer);
        return row;
    }

    function openRegexModal(ruleData = null) {
        uiHelper.openModal('regexRuleModal');

        // Ensure elements are captured if they weren't already
        if (!regexRuleForm) {
            regexRuleModal = document.getElementById('regexRuleModal');
            regexRuleForm = document.getElementById('regexRuleForm');
            editingRegexRuleId = document.getElementById('editingRegexRuleId');
            regexRuleTitle = document.getElementById('regexRuleTitle');
            regexRuleFind = document.getElementById('regexRuleFind');
            regexRuleReplace = document.getElementById('regexRuleReplace');
            regexRuleMinDepth = document.getElementById('regexRuleMinDepth');
            regexRuleMaxDepth = document.getElementById('regexRuleMaxDepth');
            cancelRegexRuleBtn = document.getElementById('cancelRegexRule');
            closeRegexRuleModalBtn = document.getElementById('closeRegexRuleModal');
        }

        if (!regexRuleForm) return;

        regexRuleForm.reset();
        if (ruleData) {
            // Edit mode
            editingRegexRuleId.value = ruleData.id;
            regexRuleTitle.value = ruleData.title || '';
            regexRuleFind.value = ruleData.findPattern || '';
            regexRuleReplace.value = ruleData.replaceWith || '';

            (ruleData.applyToRoles || []).forEach(role => {
                const checkbox = regexRuleForm.querySelector(`input[name="applyToRoles"][value="${role}"]`);
                if (checkbox) checkbox.checked = true;
            });

            // 设置应用范围
            if (ruleData.applyToFrontend !== undefined) {
                document.getElementById('applyToFrontend').checked = ruleData.applyToFrontend;
            } else if (ruleData.applyToScopes) {
                // 兼容旧数据结构
                document.getElementById('applyToFrontend').checked = ruleData.applyToScopes.includes('frontend');
            } else {
                document.getElementById('applyToFrontend').checked = true;
            }

            if (ruleData.applyToContext !== undefined) {
                document.getElementById('applyToContext').checked = ruleData.applyToContext;
            } else if (ruleData.applyToScopes) {
                // 兼容旧数据结构
                document.getElementById('applyToContext').checked = ruleData.applyToScopes.includes('context');
            } else {
                document.getElementById('applyToContext').checked = true;
            }

            regexRuleMinDepth.value = ruleData.minDepth !== undefined ? ruleData.minDepth : 0;
            regexRuleMaxDepth.value = ruleData.maxDepth !== undefined ? ruleData.maxDepth : -1;
        } else {
            // New rule mode
            editingRegexRuleId.value = '';
            regexRuleMinDepth.value = 0;
            regexRuleMaxDepth.value = -1;
        }
    }

    function closeRegexModal() {
        uiHelper.closeModal('regexRuleModal');
    }

    function handleRegexFormSubmit(event) {
        event.preventDefault();

        const id = editingRegexRuleId.value || `rule_${Date.now()}`;
        const title = regexRuleTitle.value.trim();
        const findPattern = regexRuleFind.value.trim();

        if (!title || !findPattern) {
            uiHelper.showToastNotification('规则标题和查找内容不能为空！', 'error');
            return;
        }

        const newRule = {
            id,
            title,
            findPattern,
            replaceWith: regexRuleReplace.value,
            applyToRoles: Array.from(regexRuleForm.querySelectorAll('input[name="applyToRoles"]:checked')).map(cb => cb.value),
            applyToFrontend: document.getElementById('applyToFrontend').checked,
            applyToContext: document.getElementById('applyToContext').checked,
            minDepth: parseInt(regexRuleMinDepth.value, 10),
            maxDepth: parseInt(regexRuleMaxDepth.value, 10)
        };

        const existingIndex = currentAgentRegexes.findIndex(r => r.id === id);
        if (existingIndex > -1) {
            currentAgentRegexes[existingIndex] = newRule;
        } else {
            currentAgentRegexes.push(newRule);
        }

        renderRegexList();
        closeRegexModal();
    }

    /**
     * 处理导入正则规则（暂时未实现）
     */
    async function handleImportRegex() {
        const agentId = editingAgentIdInput.value;
        if (!agentId) {
            uiHelper.showToastNotification('请先选择一个Agent。', 'warning');
            return;
        }

        try {
            const result = await electronAPI.importRegexRules(agentId);

            if (result.success) {
                currentAgentRegexes = result.rules;
                renderRegexList();
                uiHelper.showToastNotification('正则规则导入成功！', 'success');
            } else if (!result.canceled) {
                // Don't show an error if the user just canceled the dialog
                uiHelper.showToastNotification(`导入失败: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('导入正则规则时发生意外错误:', error);
            uiHelper.showToastNotification(`导入失败: ${error.message}`, 'error');
        }
    }

    /**
     * 设置Agent设置的粘性按钮效果
     */
    /**
     * 设置设置页面的粘性按钮效果（通用逻辑，支持 Agent 和群组）
     */
    function setupAgentSettingsStickyButtons() {
        const settingsTab = document.getElementById('tabContentSettings');
        if (!settingsTab) return;

        let isCurrentlyAtBottom = false;

        const updateButtonsState = () => {
            const allFormActions = settingsTab.querySelectorAll('.form-actions');
            if (allFormActions.length === 0) return;

            // 检测是否到达底部（引入滞后性/Hysteresis逻辑以消除抖动）
            const distanceToBottom = settingsTab.scrollHeight - settingsTab.scrollTop - settingsTab.clientHeight;
            
            // 判定逻辑：
            // 1. 如果当前未显示（isCurrentlyAtBottom = false），则在距离底部 < 10px 时触发显示
            // 2. 如果当前已显示（isCurrentlyAtBottom = true），则只有在向上滚动超过 60px 时才隐藏
            //    (60px 略大于增加的按钮区域高度，防止高度变化导致的判定循环)
            const threshold = isCurrentlyAtBottom ? 60 : 10;
            const isAtBottom = distanceToBottom <= threshold;

            if (isAtBottom !== isCurrentlyAtBottom) {
                isCurrentlyAtBottom = isAtBottom;
                allFormActions.forEach(formActions => {
                    if (isAtBottom) {
                        formActions.classList.add('scrolled-to-bottom');
                    } else {
                        formActions.classList.remove('scrolled-to-bottom');
                    }
                });
            }
        };



        // 监听滚动事件
        settingsTab.addEventListener('scroll', updateButtonsState);

        // 暴露刷新方法给外部调用
        scheduleStickyButtonsRefresh = () => {
            window.requestAnimationFrame(updateButtonsState);
        };

        // 初始检查
        setTimeout(updateButtonsState, 100);

        // 定期检查（处理动态内容加载导致的滚动条变化）
        setInterval(updateButtonsState, 1000);

        console.log('[SettingsManager] Settings sticky buttons initialized with generic scroll detection.');
    }



    /**
     * 设置颜色选择器与文本输入框的同步
     */
    function setupColorPickerSync() {
        // 头像边框颜色同步
        if (agentAvatarBorderColorInput && agentAvatarBorderColorTextInput) {
            agentAvatarBorderColorInput.addEventListener('input', (e) => {
                agentAvatarBorderColorTextInput.value = e.target.value;
                updateAvatarPreviewStyle();
            });

            agentAvatarBorderColorTextInput.addEventListener('input', (e) => {
                const color = e.target.value.trim();
                if (/^#[0-9A-F]{6}$/i.test(color)) {
                    agentAvatarBorderColorInput.value = color;
                    updateAvatarPreviewStyle();
                }
            });

            agentAvatarBorderColorTextInput.addEventListener('blur', (e) => {
                const color = e.target.value.trim();
                if (!/^#[0-9A-F]{6}$/i.test(color)) {
                    e.target.value = agentAvatarBorderColorInput.value;
                    uiHelper.showToastNotification('颜色格式无效，请使用 #RRGGBB 格式', 'warning');
                }
            });
        }

        // 名称文字颜色同步
        if (agentNameTextColorInput && agentNameTextColorTextInput) {
            agentNameTextColorInput.addEventListener('input', (e) => {
                agentNameTextColorTextInput.value = e.target.value;
            });

            agentNameTextColorTextInput.addEventListener('input', (e) => {
                const color = e.target.value.trim();
                if (/^#[0-9A-F]{6}$/i.test(color)) {
                    agentNameTextColorInput.value = color;
                }
            });

            agentNameTextColorTextInput.addEventListener('blur', (e) => {
                const color = e.target.value.trim();
                if (!/^#[0-9A-F]{6}$/i.test(color)) {
                    e.target.value = agentNameTextColorInput.value;
                    uiHelper.showToastNotification('颜色格式无效，请使用 #RRGGBB 格式', 'warning');
                }
            });
        }

        console.log('[SettingsManager] Color picker synchronization setup complete.');
    }

    /**
     * 更新头像预览的样式
     */
    function updateAvatarPreviewStyle() {
        if (agentAvatarPreview && agentAvatarBorderColorInput) {
            agentAvatarPreview.style.borderColor = agentAvatarBorderColorInput.value;
        }
    }

    /**
     * 设置参数容器的折叠功能
     */
function setupParamsCollapsible() {
        setupAgentSettingsSections();
    }

    /**
     * 设置语音设置容器的折叠功能
     */
    function setupTtsCollapsible() {
        setupAgentSettingsSections();
    }

    /**
     * 获取当前所有折叠区域的状态
     */
    function getCurrentCollapseStates() {
        return {
            identityCollapsed: getSectionContainer('identity')?.classList.contains('collapsed') ?? true,
            promptCollapsed: getSectionContainer('prompt')?.classList.contains('collapsed') ?? true,
            modelCollapsed: getSectionContainer('model')?.classList.contains('collapsed') ?? true,
            paramsCollapsed: getSectionContainer('params')?.classList.contains('collapsed') ?? true,
            ttsCollapsed: getSectionContainer('tts')?.classList.contains('collapsed') ?? true,
            regexCollapsed: getSectionContainer('regex')?.classList.contains('collapsed') ?? true,
            styleCollapsed: document.querySelector('.agent-style-collapsible-container')?.classList.contains('collapsed') ?? true
        };
    }

    function getSectionContainer(key) {
        return agentSettingsForm?.querySelector(`.agent-settings-section[data-section-key="${key}"]`) || null;
    }

    function createSectionController(key, buildSummary) {
        const container = getSectionContainer(key);
        if (!container) {
            return null;
        }

        const header = container.querySelector('.agent-settings-section-header');
        const summary = container.querySelector('.agent-settings-section-summary');
        const toggleBtn = container.querySelector('.agent-settings-toggle-btn');
        if (!header || !summary || !toggleBtn) {
            console.warn(`[SettingsManager] Missing collapsible controls for section "${key}"`);
            return null;
        }

        const controller = {
            key,
            container,
            header,
            summary,
            toggleBtn,
            buildSummary,
            setCollapsed(collapsed) {
                this.container.classList.toggle('collapsed', !!collapsed);
            }
        };

        if (!header.dataset.collapsibleBound) {
            header.addEventListener('click', (event) => {
                event.preventDefault();
                controller.setCollapsed(!controller.container.classList.contains('collapsed'));
                updateSectionSummary(key);
                persistCollapseStatesForCurrentSelection();
                scheduleStickyButtonsRefresh();
            });
            header.dataset.collapsibleBound = 'true';
        }

        sectionControllers.set(key, controller);
        return controller;
    }

    function buildIdentitySummary() {
        const name = agentNameInput?.value?.trim() || '未命名 Agent';
        const avatarSrc = agentAvatarPreview?.getAttribute('src') || 'assets/default_avatar.png';
        return {
            kind: 'identity',
            text: name,
            avatarSrc: avatarSrc || 'assets/default_avatar.png'
        };
    }

    async function buildPromptSummary() {
        const mode = promptManager?.getMode?.() || 'original';
        const modeLabel = promptManager?.getModeName?.(mode) || promptModeFallbackLabels[mode] || mode;
        let promptContent = '';

        try {
            promptContent = promptManager?.getCurrentSystemPrompt
                ? await promptManager.getCurrentSystemPrompt()
                : '';
        } catch (error) {
            console.warn('[SettingsManager] Failed to build prompt summary from PromptManager:', error);
        }

        if (!promptContent) {
            const promptTextarea = document.querySelector('#systemPromptContainer textarea');
            promptContent = promptTextarea?.value?.trim() || '';
        }

        return buildPromptSummaryText(`模式: ${modeLabel}`, promptContent);
    }

    function buildPromptSummaryText(modeLine, promptContent) {
        const normalizedPrompt = (promptContent || '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!normalizedPrompt) {
            return `${modeLine}\n暂无提示词内容`;
        }

        const preview = normalizedPrompt.length > 96
            ? `${normalizedPrompt.slice(0, 96)}...`
            : normalizedPrompt;

        return `${modeLine}\n${preview}`;
    }

    function buildModelSummary() {
        return agentModelInput?.value?.trim() || '未选择模型';
    }

    function buildParamsSummary() {
        const temperature = agentTemperatureInput?.value || '0.7';
        const contextLimit = agentContextTokenLimitInput?.value || '4000';
        const maxOutput = agentMaxOutputTokensInput?.value || '1000';
        const topP = agentTopPInput?.value || '未设置';
        const topK = agentTopKInput?.value || '未设置';
        const streamOutput = document.getElementById('agentStreamOutputTrue')?.checked ? '流式' : '非流式';

        return [
            `Temperature: ${temperature}`,
            `上下文: ${contextLimit}`,
            `最大输出: ${maxOutput}`,
            `Top P: ${topP}`,
            `Top K: ${topK}`,
            `输出: ${streamOutput}`
        ].join('\n');
    }

    function buildTtsSummary() {
        const primaryVoice = agentTtsVoicePrimarySelect?.selectedOptions?.[0]?.textContent?.trim()
            || agentTtsVoicePrimarySelect?.value
            || '不使用语音';
        const primaryRegex = agentTtsRegexPrimaryInput?.value?.trim() || '全部';
        const secondaryVoice = agentTtsVoiceSecondarySelect?.selectedOptions?.[0]?.textContent?.trim()
            || agentTtsVoiceSecondarySelect?.value
            || '不使用';
        const secondaryRegex = agentTtsRegexSecondaryInput?.value?.trim() || '无';
        const speed = agentTtsSpeedSlider?.value || '1.0';

        return [
            `主语言: ${primaryVoice}`,
            `主语言正则: ${primaryRegex}`,
            `副语言: ${secondaryVoice}`,
            `副语言正则: ${secondaryRegex}`,
            `语速: ${speed}`
        ].join('\n');
    }

    function buildRegexSummary() {
        const count = Array.isArray(currentAgentRegexes) ? currentAgentRegexes.length : 0;
        return count > 0 ? `${count} 条规则` : '暂无规则';
    }

    function setupAgentSettingsSections() {
        sectionControllers.clear();

        createSectionController('identity', buildIdentitySummary);
        createSectionController('prompt', buildPromptSummary);
        createSectionController('model', buildModelSummary);
        createSectionController('params', buildParamsSummary);
        createSectionController('tts', buildTtsSummary);
        createSectionController('regex', buildRegexSummary);

        if (!agentSettingsForm?.dataset.sectionSummaryBindings) {
            const bindSummaryRefresh = (element, events = ['input']) => {
                if (!element || element.dataset.summaryRefreshBound) return;
                events.forEach(eventName => {
                    element.addEventListener(eventName, () => updateAllSectionSummaries());
                });
                element.dataset.summaryRefreshBound = 'true';
            };

            [
                agentNameInput,
                agentTemperatureInput,
                agentContextTokenLimitInput,
                agentMaxOutputTokensInput,
                agentTopPInput,
                agentTopKInput,
                agentTtsRegexPrimaryInput,
                agentTtsRegexSecondaryInput,
                agentTtsSpeedSlider,
                agentModelInput,
                document.getElementById('agentStreamOutputTrue'),
                document.getElementById('agentStreamOutputFalse'),
                agentTtsVoicePrimarySelect,
                agentTtsVoiceSecondarySelect
            ].forEach(element => bindSummaryRefresh(element, ['input', 'change']));

            const systemPromptContainer = document.getElementById('systemPromptContainer');
            if (systemPromptContainer && !systemPromptContainer.dataset.summaryRefreshBound) {
                const schedulePromptRefresh = () => {
                    window.setTimeout(() => updateSectionSummary('prompt'), 0);
                    scheduleStickyButtonsRefresh();
                };
                ['input', 'change', 'click'].forEach(eventName => {
                    systemPromptContainer.addEventListener(eventName, schedulePromptRefresh);
                });
                const promptObserver = new MutationObserver(() => schedulePromptRefresh());
                promptObserver.observe(systemPromptContainer, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });
                systemPromptContainer.dataset.summaryRefreshBound = 'true';
            }

            if (agentAvatarPreview && !agentAvatarPreview.dataset.summaryObserverBound) {
                const avatarObserver = new MutationObserver(() => updateSectionSummary('identity'));
                avatarObserver.observe(agentAvatarPreview, { attributes: true, attributeFilter: ['src'] });
                agentAvatarPreview.dataset.summaryObserverBound = 'true';
            }

            agentSettingsForm.dataset.sectionSummaryBindings = 'true';
        }

        updateAllSectionSummaries();
    }

    async function updateSectionSummary(key) {
        const controller = sectionControllers.get(key);
        if (!controller) return;

        const summaryValue = await Promise.resolve(controller.buildSummary());

        if (summaryValue && typeof summaryValue === 'object' && summaryValue.kind === 'identity') {
            controller.summary.classList.add('summary-with-avatar');
            controller.summary.innerHTML = '';

            const avatar = document.createElement('img');
            avatar.className = 'agent-settings-summary-avatar';
            avatar.src = summaryValue.avatarSrc || 'assets/default_avatar.png';
            avatar.alt = '';

            const label = document.createElement('span');
            label.className = 'agent-settings-summary-label';
            label.textContent = summaryValue.text || '未命名 Agent';

            controller.summary.appendChild(avatar);
            controller.summary.appendChild(label);
            return;
        }

        controller.summary.classList.remove('summary-with-avatar');
        controller.summary.textContent = typeof summaryValue === 'string' ? summaryValue : '';
    }

    function updateAllSectionSummaries() {
        sectionControllers.forEach((_, key) => {
            updateSectionSummary(key);
        });
    }

    function getCollapseStatesFromConfig(agentConfig) {
        return agentConfig?.uiCollapseStates || {};
    }

    function syncCollapseStatesToCurrentSelection(collapseStates = getCurrentCollapseStates()) {
        const currentSelectedItem = refs.currentSelectedItemRef?.get?.();
        if (!currentSelectedItem || currentSelectedItem.type !== 'agent') {
            return;
        }

        if (currentSelectedItem.config) {
            currentSelectedItem.config.uiCollapseStates = { ...collapseStates };
        } else {
            currentSelectedItem.uiCollapseStates = { ...collapseStates };
        }
    }

    async function persistCollapseStatesForCurrentSelection() {
        const currentSelectedItem = refs.currentSelectedItemRef?.get?.();
        const agentId = editingAgentIdInput?.value || currentSelectedItem?.id;
        if (!agentId || !electronAPI?.updateAgentConfig) {
            return;
        }

        const collapseStates = getCurrentCollapseStates();
        const signature = `${agentId}:${JSON.stringify(collapseStates)}`;
        if (signature === lastPersistedCollapseStateSignature) {
            return;
        }

        syncCollapseStatesToCurrentSelection(collapseStates);
        lastPersistedCollapseStateSignature = signature;

        try {
            await electronAPI.updateAgentConfig(agentId, { uiCollapseStates: collapseStates });
        } catch (error) {
            console.error('[SettingsManager] Failed to persist collapse states:', error);
            lastPersistedCollapseStateSignature = '';
        }
    }

    /**
     * 恢复折叠区域的状态
     */
    function restoreCollapseStates(agentConfig) {
        const agentId = editingAgentIdInput?.value || agentConfig?.id || '';
        const isFirstSettingsLoadThisSession = agentId && !initializedCollapseStateAgents.has(agentId);
        const states = {
            identityCollapsed: true,
            promptCollapsed: true,
            modelCollapsed: true,
            paramsCollapsed: true,
            ttsCollapsed: true,
            regexCollapsed: true,
            styleCollapsed: true,
            ...(isFirstSettingsLoadThisSession ? {} : getCollapseStatesFromConfig(agentConfig))
        };

        if (agentId) {
            initializedCollapseStateAgents.add(agentId);
        }

        [
            ['identity', states.identityCollapsed],
            ['prompt', states.promptCollapsed],
            ['model', states.modelCollapsed],
            ['params', states.paramsCollapsed],
            ['tts', states.ttsCollapsed],
            ['regex', states.regexCollapsed]
        ].forEach(([key, collapsed]) => {
            const controller = sectionControllers.get(key);
            if (controller) {
                controller.setCollapsed(collapsed);
            }
        });

        const styleContainer = document.querySelector('.agent-style-collapsible-container');
        if (styleContainer) {
            styleContainer.classList.toggle('collapsed', !!states.styleCollapsed);
        }

        syncCollapseStatesToCurrentSelection(states);
        lastPersistedCollapseStateSignature = `${editingAgentIdInput?.value || agentConfig?.id || ''}:${JSON.stringify(states)}`;
        updateAllSectionSummaries();

        console.log('[SettingsManager] Collapse states restored:', states);
    }

    /**
     * 设置自定义样式容器的折叠功能
     */
    function setupStyleCollapsible() {
        const styleContainer = document.querySelector('.agent-style-collapsible-container');
        const styleHeader = document.getElementById('styleCollapseHeader');

        if (!styleContainer || !styleHeader) {
            console.warn('[SettingsManager] Style collapsible elements not found');
            return;
        }

        if (!styleHeader.dataset.collapsibleBound) {
            styleHeader.addEventListener('click', () => {
                styleContainer.classList.toggle('collapsed');
                persistCollapseStatesForCurrentSelection();
                scheduleStickyButtonsRefresh();
            });
            styleHeader.dataset.collapsibleBound = 'true';
        }

        console.log('[SettingsManager] Style collapsible setup complete.');
    }

    /**
     * 处理重置头像颜色按钮点击
     */
    function handleResetAvatarColors() {
        const agentAvatarPreview = document.getElementById('agentAvatarPreview');

        if (!agentAvatarPreview || !agentAvatarPreview.src || agentAvatarPreview.src === '#' || agentAvatarPreview.src.includes('default_avatar.png')) {
            uiHelper.showToastNotification('请先上传头像后再重置颜色', 'warning');
            return;
        }

        // 从当前头像中提取颜色，使用与全局设置相同的方法
        if (window.getDominantAvatarColor) {
            window.getDominantAvatarColor(agentAvatarPreview.src).then((avgColor) => {
                if (avgColor && agentAvatarBorderColorInput && agentNameTextColorInput) {
                    // 将rgb格式转换为hex格式
                    const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                    if (rgbMatch) {
                        const r = parseInt(rgbMatch[1]);
                        const g = parseInt(rgbMatch[2]);
                        const b = parseInt(rgbMatch[3]);
                        const hexColor = '#' + [r, g, b].map(x => {
                            const hex = x.toString(16);
                            return hex.length === 1 ? '0' + hex : hex;
                        }).join('');

                        // 填充到两个颜色输入框
                        agentAvatarBorderColorInput.value = hexColor;
                        agentAvatarBorderColorTextInput.value = hexColor;
                        agentNameTextColorInput.value = hexColor;
                        agentNameTextColorTextInput.value = hexColor;

                        // 更新头像预览的边框颜色
                        agentAvatarPreview.style.borderColor = hexColor;

                        uiHelper.showToastNotification('已重置为头像默认颜色', 'success');
                        console.log('[SettingsManager] Colors reset to avatar default:', hexColor);
                    }
                } else {
                    uiHelper.showToastNotification('无法从头像提取颜色', 'error');
                }
            }).catch(err => {
                console.error('[SettingsManager] Error extracting color:', err);
                uiHelper.showToastNotification('提取颜色时出错', 'error');
            });
        } else {
            console.warn('[SettingsManager] getDominantAvatarColor not available, using fallback');
            // 降级使用原来的方法
            uiHelper.getAverageColorFromAvatar(agentAvatarPreview.src, (avgColor) => {
                if (avgColor && agentAvatarBorderColorInput && agentNameTextColorInput) {
                    const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                    if (rgbMatch) {
                        const r = parseInt(rgbMatch[1]);
                        const g = parseInt(rgbMatch[2]);
                        const b = parseInt(rgbMatch[3]);
                        const hexColor = '#' + [r, g, b].map(x => {
                            const hex = x.toString(16);
                            return hex.length === 1 ? '0' + hex : hex;
                        }).join('');

                        agentAvatarBorderColorInput.value = hexColor;
                        agentAvatarBorderColorTextInput.value = hexColor;
                        agentNameTextColorInput.value = hexColor;
                        agentNameTextColorTextInput.value = hexColor;
                        agentAvatarPreview.style.borderColor = hexColor;

                        uiHelper.showToastNotification('已重置为头像默认颜色', 'success');
                        console.log('[SettingsManager] Colors reset to avatar default (fallback):', hexColor);
                    }
                } else {
                    uiHelper.showToastNotification('无法从头像提取颜色', 'error');
                }
            });
        }
    }
    /**
     * 应用名片CSS到设置页面的Agent身份容器
     */
    function applyCardCssToIdentityContainer(cardCss) {
        const identityContainer = document.querySelector('#agentSettingsContainer .agent-identity-container');
        if (!identityContainer) return;

        if (cardCss && cardCss.trim()) {
            console.log('[SettingsManager] Applying card CSS to identity container:', cardCss);
            // 解析并应用CSS
            const styleDeclarations = cardCss.split(';').filter(s => s.trim());
            styleDeclarations.forEach(declaration => {
                const [property, value] = declaration.split(':').map(s => s.trim());
                if (property && value) {
                    identityContainer.style.setProperty(property, value);
                }
            });
        } else {
            // 清除之前的自定义样式
            identityContainer.removeAttribute('style');
        }
    }

})();

window.settingsManager = settingsManager;
