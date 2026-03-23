// modules/topicListManager.js

window.topicListManager = (() => {
    // --- Private Variables ---
    let topicListContainer;
    let electronAPI;
    let currentSelectedItemRef;
    let currentTopicIdRef;
    let uiHelper;
    let mainRendererFunctions;
    let wasSelectionListenerActive = false; // To store the state of the selection listener before dragging

    /**
     * Initializes the TopicListManager module.
     * @param {object} config - The configuration object.
     */
    function init(config) {
        if (!config.elements || !config.elements.topicListContainer) {
            console.error('[TopicListManager] Missing required DOM element: topicListContainer.');
            return;
        }
        if (!config.electronAPI || !config.refs || !config.uiHelper || !config.mainRendererFunctions) {
            console.error('[TopicListManager] Missing required configuration parameters.');
            return;
        }

        topicListContainer = config.elements.topicListContainer;
        electronAPI = config.electronAPI;
        currentSelectedItemRef = config.refs.currentSelectedItemRef;
        currentTopicIdRef = config.refs.currentTopicIdRef;
        uiHelper = config.uiHelper;
        mainRendererFunctions = config.mainRendererFunctions;

        // 设置鼠标快捷键
        setupMouseShortcuts();

        console.log('[TopicListManager] Initialized successfully.');
    }

    /**
     * Part C: 智能计数逻辑辅助函数（前端复制）
     * 判断是否应该激活计数
     * @param {Array} history - 消息历史
     * @returns {boolean}
     */
    function shouldActivateCount(history) {
        if (!history || history.length === 0) return false;

        // 过滤掉系统消息
        const nonSystemMessages = history.filter(msg => msg.role !== 'system');

        // 必须有且只有一条消息，且该消息是 AI 回复
        return nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'assistant';
    }

    /**
     * Part C: 计算未读消息数量
     * @param {Array} history - 消息历史
     * @returns {number}
     */
    function countUnreadMessages(history) {
        return shouldActivateCount(history) ? 1 : 0;
    }

    /**
     * Part C: 计算单个话题的未读消息数
     * @param {Object} topic - 话题对象
     * @param {Array} history - 话题历史消息
     * @returns {number} - 未读消息数，-1 表示仅显示小点
     */
    function calculateTopicUnreadCount(topic, history) {
        // 优先检查自动计数条件（AI回复了但用户没回）
        if (shouldActivateCount(history)) {
            const count = countUnreadMessages(history);
            if (count > 0) return count;
        }

        // 如果不满足自动计数条件，但被手动标记为未读，则显示小点
        if (topic.unread === true) {
            return -1; // 仅显示小点，不显示数字
        }

        return 0; // 不显示
    }

    async function loadTopicList() {
        if (!topicListContainer) {
            console.error("Topic list container (tabContentTopics) not found.");
            return;
        }

        let topicListUl = topicListContainer.querySelector('.topic-list');
        if (topicListUl) {
            topicListUl.innerHTML = '';
        } else {
            const topicsHeader = topicListContainer.querySelector('.topics-header') || document.createElement('div');
            if (!topicsHeader.classList.contains('topics-header')) {
                topicsHeader.className = 'topics-header';
                topicsHeader.innerHTML = `<h2>话题列表</h2><div class="topic-search-container"><input type="text" id="topicSearchInput" placeholder="搜索话题..." class="topic-search-input"></div>`;
                topicListContainer.prepend(topicsHeader);
                const newTopicSearchInput = topicsHeader.querySelector('#topicSearchInput');
                if (newTopicSearchInput) setupTopicSearchListener(newTopicSearchInput);
            }

            topicListUl = document.createElement('ul');
            topicListUl.className = 'topic-list';
            topicListUl.id = 'topicList';
            topicListContainer.appendChild(topicListUl);
        }

        const currentSelectedItem = currentSelectedItemRef.get();
        if (!currentSelectedItem.id) {
            topicListUl.innerHTML = '<li><p>请先在“助手与群组”列表选择一个项目以查看其相关话题。</p></li>';
            return;
        }

        const itemNameForLoading = currentSelectedItem.name || '当前项目';
        const searchInput = document.getElementById('topicSearchInput');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        let itemConfigFull;

        if (!searchTerm) {
            topicListUl.innerHTML = `<li><div class="loading-spinner-small"></div>正在加载 ${itemNameForLoading} 的话题...</li>`;
        } else {
            topicListUl.innerHTML = '';
        }

        if (currentSelectedItem.type === 'agent') {
            itemConfigFull = await electronAPI.getAgentConfig(currentSelectedItem.id);
        } else if (currentSelectedItem.type === 'group') {
            itemConfigFull = await electronAPI.getAgentGroupConfig(currentSelectedItem.id);
        }

        if (itemConfigFull && !itemConfigFull.error) {
            mainRendererFunctions.updateCurrentItemConfig(itemConfigFull);
        }

        if (!itemConfigFull || itemConfigFull.error) {
            topicListUl.innerHTML = `<li><p>无法加载 ${itemNameForLoading} 的配置信息: ${itemConfigFull?.error || '未知错误'}</p></li>`;
        } else {
            let topicsToProcess = itemConfigFull.topics || [];
            if (currentSelectedItem.type === 'agent' && topicsToProcess.length === 0) {
                const defaultAgentTopic = { id: "default", name: "主要对话", createdAt: Date.now() };
                topicsToProcess.push(defaultAgentTopic);
            }

            // topicsToProcess.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            if (searchTerm) {
                let frontendFilteredTopics = topicsToProcess.filter(topic => {
                    const nameMatch = topic.name.toLowerCase().includes(searchTerm);
                    let dateMatch = false;
                    if (topic.createdAt) {
                        const date = new Date(topic.createdAt);
                        const fullDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                        const shortDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                        dateMatch = fullDateStr.toLowerCase().includes(searchTerm) || shortDateStr.toLowerCase().includes(searchTerm);
                    }
                    return nameMatch || dateMatch;
                });

                let contentMatchedTopicIds = [];
                try {
                    const contentSearchResult = await electronAPI.searchTopicsByContent(currentSelectedItem.id, currentSelectedItem.type, searchTerm);
                    if (contentSearchResult && contentSearchResult.success && Array.isArray(contentSearchResult.matchedTopicIds)) {
                        contentMatchedTopicIds = contentSearchResult.matchedTopicIds;
                    } else if (contentSearchResult && !contentSearchResult.success) {
                        console.warn("Topic content search failed:", contentSearchResult.error);
                    }
                } catch (e) {
                    console.error("Error calling searchTopicsByContent:", e);
                }

                const finalFilteredTopicIds = new Set(frontendFilteredTopics.map(t => t.id));
                contentMatchedTopicIds.forEach(id => finalFilteredTopicIds.add(id));

                topicsToProcess = topicsToProcess.filter(topic => finalFilteredTopicIds.has(topic.id));
            }

            if (topicsToProcess.length === 0) {
                topicListUl.innerHTML = `<li><p>${itemNameForLoading} 还没有任何话题${searchTerm ? '匹配当前搜索' : ''}。您可以点击上方的“新建${currentSelectedItem.type === 'group' ? '群聊话题' : '聊天话题'}”按钮创建一个。</p></li>`;
            } else {
                topicListUl.innerHTML = '';
                const currentTopicId = currentTopicIdRef.get();

                // --- 优化：分批渲染话题列表 ---
                const BATCH_SIZE = 20;
                let currentIndex = 0;

                const renderBatch = () => {
                    const fragment = document.createDocumentFragment();
                    const end = Math.min(currentIndex + BATCH_SIZE, topicsToProcess.length);

                    for (; currentIndex < end; currentIndex++) {
                        const topic = topicsToProcess[currentIndex];
                        const li = document.createElement('li');
                        li.classList.add('topic-item');
                        li.dataset.itemId = currentSelectedItem.id;
                        li.dataset.itemType = currentSelectedItem.type;
                        li.dataset.topicId = topic.id;
                        const isCurrentActiveTopic = topic.id === currentTopicId;
                        li.classList.toggle('active', isCurrentActiveTopic);
                        li.classList.toggle('active-topic-glowing', isCurrentActiveTopic);

                        const avatarImg = document.createElement('img');
                        avatarImg.classList.add('avatar');
                        // 优化：延迟加载头像，仅在需要时添加时间戳
                        avatarImg.src = currentSelectedItem.avatarUrl ? currentSelectedItem.avatarUrl : (currentSelectedItem.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png');
                        avatarImg.alt = `${currentSelectedItem.name} - ${topic.name}`;
                        avatarImg.onerror = () => { avatarImg.src = (currentSelectedItem.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png'); };

                        const topicTitleDisplay = document.createElement('span');
                        topicTitleDisplay.classList.add('topic-title-display');
                        topicTitleDisplay.textContent = topic.name || `话题 ${topic.id}`;

                        const messageCountSpan = document.createElement('span');
                        messageCountSpan.classList.add('message-count');
                        messageCountSpan.textContent = '...';

                        li.appendChild(avatarImg);

                        if (topic.locked === false) {
                            const unlockedIndicator = document.createElement('span');
                            unlockedIndicator.classList.add('unlocked-indicator');
                            unlockedIndicator.textContent = 'unlocked';
                            unlockedIndicator.title = 'AI可以查看和回复此话题';
                            li.appendChild(unlockedIndicator);
                        }

                        li.appendChild(topicTitleDisplay);
                        li.appendChild(messageCountSpan);

                        // 优化：延迟加载计数逻辑，避免瞬间爆发大量 IPC 请求
                        setTimeout(() => {
                            if (!li.isConnected) return; // 如果节点已从 DOM 移除，则跳过

                            let historyPromise;
                            if (currentSelectedItem.type === 'agent') {
                                historyPromise = electronAPI.getChatHistory(currentSelectedItem.id, topic.id);
                            } else if (currentSelectedItem.type === 'group') {
                                historyPromise = electronAPI.getGroupChatHistory(currentSelectedItem.id, topic.id);
                            }

                            if (historyPromise) {
                                historyPromise.then(historyResult => {
                                    if (historyResult && !historyResult.error && Array.isArray(historyResult)) {
                                        const unreadCount = calculateTopicUnreadCount(topic, historyResult);
                                        if (unreadCount > 0) {
                                            messageCountSpan.textContent = `${unreadCount}`;
                                            messageCountSpan.classList.add('has-unread');
                                        } else if (unreadCount === -1) {
                                            messageCountSpan.textContent = `${historyResult.length}`;
                                            messageCountSpan.classList.add('unread-marker-only');
                                        } else {
                                            messageCountSpan.textContent = `${historyResult.length}`;
                                        }
                                    } else {
                                        messageCountSpan.textContent = 'N/A';
                                    }
                                }).catch(() => messageCountSpan.textContent = 'ERR');
                            }
                        }, 100 + (currentIndex * 10)); // 阶梯式延迟请求

                        li.addEventListener('click', async () => {
                            if (currentTopicIdRef.get() === topic.id) {
                                return;
                            }

                            if (window.__vcpRendererReady === false) {
                                window.__vcpPendingTopicSelection = {
                                    itemId: currentSelectedItem.id,
                                    itemType: currentSelectedItem.type,
                                    topicId: topic.id,
                                };
                                if (uiHelper && uiHelper.showToastNotification) {
                                    uiHelper.showToastNotification('正在初始化界面，稍后自动打开该话题', 'info');
                                }
                                return;
                            }

                            try {
                                await Promise.resolve(mainRendererFunctions.selectTopic(topic.id));
                            } catch (error) {
                                console.error('[TopicListManager] Failed to select topic:', error);
                                if (uiHelper && uiHelper.showToastNotification) {
                                    uiHelper.showToastNotification(`打开话题失败: ${error.message}`, 'error');
                                }
                            }
                        });

                        li.addEventListener('contextmenu', (e) => {
                            e.preventDefault();
                            showTopicContextMenu(e, li, itemConfigFull, topic, currentSelectedItem.type);
                        });
                        fragment.appendChild(li);
                    }

                    topicListUl.appendChild(fragment);

                    if (currentIndex < topicsToProcess.length) {
                        // 使用 requestAnimationFrame 确保在下一帧继续渲染，保持 UI 响应
                        requestAnimationFrame(renderBatch);
                    } else {
                        // 渲染完成后初始化排序
                        if (currentSelectedItem.id && topicsToProcess.length > 0 && typeof Sortable !== 'undefined') {
                            initializeTopicSortable(currentSelectedItem.id, currentSelectedItem.type);
                        }
                    }
                };

                // 开始第一批渲染
                renderBatch();
            }
            if (currentSelectedItem.id && topicsToProcess && topicsToProcess.length > 0 && typeof Sortable !== 'undefined') {
                initializeTopicSortable(currentSelectedItem.id, currentSelectedItem.type);
            }
        }
    }

    function setupTopicSearch() {
        let searchInput = document.getElementById('topicSearchInput');
        if (searchInput) {
            setupTopicSearchListener(searchInput);
        }
    }

    function setupTopicSearchListener(inputElement) {
        inputElement.addEventListener('input', filterTopicList);
        inputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                filterTopicList();
            }
        });
    }

    function filterTopicList() {
        loadTopicList();
    }

    function initializeTopicSortable(itemId, itemType) {
        const topicListUl = document.getElementById('topicList');
        if (!topicListUl) {
            console.warn("[TopicListManager] topicListUl element not found. Skipping Sortable initialization.");
            return;
        }

        if (topicListUl.sortableInstance) {
            topicListUl.sortableInstance.destroy();
        }

        topicListUl.sortableInstance = new Sortable(topicListUl, {
            animation: 150,
            ghostClass: 'sortable-ghost-topic',
            chosenClass: 'sortable-chosen-topic',
            dragClass: 'sortable-drag-topic',
            onStart: async function (evt) {
                // Check original state, store it, and then disable if it was active.
                if (window.electronAPI && window.electronAPI.getSelectionListenerStatus) {
                    wasSelectionListenerActive = await window.electronAPI.getSelectionListenerStatus();
                    if (wasSelectionListenerActive) {
                        window.electronAPI.toggleSelectionListener(false);
                    }
                }
            },
            onEnd: async function (evt) {
                // Re-enable selection hook only if it was active before the drag.
                if (window.electronAPI && window.electronAPI.toggleSelectionListener) {
                    if (wasSelectionListenerActive) {
                        window.electronAPI.toggleSelectionListener(true);
                    }
                    wasSelectionListenerActive = false; // Reset state
                }

                const topicItems = Array.from(evt.to.children);
                const orderedTopicIds = topicItems.map(item => item.dataset.topicId);
                try {
                    let result;
                    if (itemType === 'agent') {
                        result = await electronAPI.saveTopicOrder(itemId, orderedTopicIds);
                    } else if (itemType === 'group') {
                        result = await electronAPI.saveGroupTopicOrder(itemId, orderedTopicIds);
                    }

                    if (result && result.success) {
                        // UI reflects sort.
                    } else {
                        console.error(`Failed to save topic order for ${itemType} ${itemId}:`, result?.error);
                        uiHelper.showToastNotification(`保存话题顺序失败: ${result?.error || '未知错误'}`, 'error');
                        loadTopicList();
                    }
                } catch (error) {
                    console.error(`Error calling saveTopicOrder for ${itemType} ${itemId}:`, error);
                    uiHelper.showToastNotification(`调用保存话题顺序API时出错: ${error.message}`, 'error');
                    loadTopicList();
                }
            }
        });
    }

    function showTopicContextMenu(event, topicItemElement, itemFullConfig, topic, itemType) {
        // closeContextMenu(); // This function is not available in this module
        closeTopicContextMenu();

        const menu = document.createElement('div');
        menu.id = 'topicContextMenu';
        menu.classList.add('context-menu');

        const editTitleOption = document.createElement('div');
        editTitleOption.classList.add('context-menu-item');
        editTitleOption.innerHTML = `<i class="fas fa-edit"></i> 编辑话题标题`;
        editTitleOption.onclick = () => {
            closeTopicContextMenu();
            const titleDisplayElement = topicItemElement.querySelector('.topic-title-display');
            if (!titleDisplayElement) return;

            const originalTitle = topic.name;
            titleDisplayElement.style.display = 'none';

            const inputWrapper = document.createElement('div');
            inputWrapper.style.display = 'flex';
            inputWrapper.style.alignItems = 'center';

            const inputField = document.createElement('input');
            inputField.type = 'text';
            inputField.value = originalTitle;
            inputField.classList.add('topic-title-edit-input');
            inputField.style.flexGrow = '1';
            inputField.onclick = (e) => e.stopPropagation();

            const confirmButton = document.createElement('button');
            confirmButton.innerHTML = '✓';
            confirmButton.classList.add('topic-title-edit-confirm');
            confirmButton.onclick = async (e) => {
                e.stopPropagation();
                const newTitle = inputField.value.trim();
                if (newTitle && newTitle !== originalTitle) {
                    let saveResult;
                    if (itemType === 'agent') {
                        saveResult = await electronAPI.saveAgentTopicTitle(itemFullConfig.id, topic.id, newTitle);
                    } else if (itemType === 'group') {
                        saveResult = await electronAPI.saveGroupTopicTitle(itemFullConfig.id, topic.id, newTitle);
                    }
                    if (saveResult && saveResult.success) {
                        topic.name = newTitle;
                        titleDisplayElement.textContent = newTitle;
                        if (itemFullConfig.topics) {
                            const topicInFullConfig = itemFullConfig.topics.find(t => t.id === topic.id);
                            if (topicInFullConfig) topicInFullConfig.name = newTitle;
                        }
                    } else {
                        uiHelper.showToastNotification(`更新话题标题失败: ${saveResult?.error || '未知错误'}`, 'error');
                    }
                }
                titleDisplayElement.style.display = '';
                inputWrapper.replaceWith(titleDisplayElement);
            };

            const cancelButton = document.createElement('button');
            cancelButton.innerHTML = '✗';
            cancelButton.classList.add('topic-title-edit-cancel');
            cancelButton.onclick = (e) => {
                e.stopPropagation();
                titleDisplayElement.style.display = '';
                inputWrapper.replaceWith(titleDisplayElement);
            };

            inputWrapper.appendChild(inputField);
            inputWrapper.appendChild(confirmButton);
            inputWrapper.appendChild(cancelButton);
            topicItemElement.insertBefore(inputWrapper, titleDisplayElement.nextSibling);
            inputField.focus();
            inputField.select();

            inputField.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    confirmButton.click();
                } else if (e.key === 'Escape') {
                    cancelButton.click();
                }
            });
        };
        menu.appendChild(editTitleOption);

        // Part C: 锁定/解锁话题选项
        const toggleLockOption = document.createElement('div');
        toggleLockOption.classList.add('context-menu-item');
        const isLocked = topic.locked !== false; // 默认为锁定
        toggleLockOption.innerHTML = isLocked
            ? `<i class="fas fa-unlock"></i> 解锁话题`
            : `<i class="fas fa-lock"></i> 锁定话题`;
        toggleLockOption.onclick = async () => {
            closeTopicContextMenu();
            try {
                const result = await electronAPI.toggleTopicLock(itemFullConfig.id, topic.id);
                if (result.success) {
                    topic.locked = result.locked;
                    uiHelper.showToastNotification(result.message, 'success');
                    loadTopicList(); // 刷新列表以显示新状态
                } else {
                    uiHelper.showToastNotification(`切换锁定状态失败: ${result.error}`, 'error');
                }
            } catch (error) {
                uiHelper.showToastNotification(`操作失败: ${error.message}`, 'error');
            }
        };
        menu.appendChild(toggleLockOption);

        // Part C: 标记为未读/已读选项
        const toggleUnreadOption = document.createElement('div');
        toggleUnreadOption.classList.add('context-menu-item');
        const isUnread = topic.unread === true;
        toggleUnreadOption.innerHTML = isUnread
            ? `<i class="fas fa-check"></i> 标记为已读`
            : `<i class="fas fa-envelope"></i> 标记为未读`;
        toggleUnreadOption.onclick = async () => {
            closeTopicContextMenu();
            try {
                const result = await electronAPI.setTopicUnread(itemFullConfig.id, topic.id, !isUnread);
                if (result.success) {
                    topic.unread = result.unread;
                    uiHelper.showToastNotification(
                        topic.unread ? '已标记为未读' : '已标记为已读',
                        'success'
                    );
                    loadTopicList(); // 刷新列表
                    // 同时刷新助手列表以更新计数
                    if (window.itemListManager) {
                        window.itemListManager.loadItems();
                    }
                } else {
                    uiHelper.showToastNotification(`操作失败: ${result.error}`, 'error');
                }
            } catch (error) {
                uiHelper.showToastNotification(`操作失败: ${error.message}`, 'error');
            }
        };
        menu.appendChild(toggleUnreadOption);

        const deleteTopicPermanentlyOption = document.createElement('div');
        deleteTopicPermanentlyOption.classList.add('context-menu-item', 'danger-item');
        deleteTopicPermanentlyOption.innerHTML = `<i class="fas fa-trash-alt"></i> 删除此话题`;
        deleteTopicPermanentlyOption.onclick = async () => {
            closeTopicContextMenu();
            // 使用自定义确认对话框替代原生 confirm()，避免 Electron 焦点问题
            const confirmed = await uiHelper.showConfirmDialog(
                `确定要永久删除话题 "${topic.name}" 吗？此操作不可撤销。`,
                '删除话题',
                '删除',
                '取消',
                true // isDanger
            );
            if (confirmed) {
                let result;
                if (itemType === 'agent') {
                    result = await electronAPI.deleteTopic(itemFullConfig.id, topic.id);
                } else if (itemType === 'group') {
                    result = await electronAPI.deleteGroupTopic(itemFullConfig.id, topic.id);
                }

                if (result && result.success) {
                    if (currentTopicIdRef.get() === topic.id) {
                        mainRendererFunctions.handleTopicDeletion(result.remainingTopics);
                    }
                    loadTopicList();
                } else {
                    uiHelper.showToastNotification(`删除话题 "${topic.name}" 失败: ${result ? result.error : '未知错误'}`, 'error');
                }
            }
        };
        menu.appendChild(deleteTopicPermanentlyOption);

        const exportTopicOption = document.createElement('div');
        exportTopicOption.classList.add('context-menu-item');
        exportTopicOption.innerHTML = `<i class="fas fa-file-export"></i> 导出此话题`;
        exportTopicOption.onclick = () => {
            closeTopicContextMenu();
            handleExportTopic(itemFullConfig.id, itemType, topic.id, topic.name);
        };
        menu.appendChild(exportTopicOption);

        // 智能定位逻辑：先隐藏菜单以测量尺寸
        menu.style.visibility = 'hidden';
        menu.style.position = 'absolute';
        document.body.appendChild(menu);

        // 获取菜单和窗口尺寸
        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        let top = event.clientY;
        let left = event.clientX;

        // 检查菜单是否会超出窗口底部
        if (top + menuHeight > windowHeight) {
            // 将菜单显示在鼠标上方
            top = event.clientY - menuHeight;
            // 如果上方空间也不够，则贴近顶部
            if (top < 0) top = 5;
        }

        // 检查菜单是否会超出窗口右侧
        if (left + menuWidth > windowWidth) {
            // 将菜单显示在鼠标左侧
            left = event.clientX - menuWidth;
            // 如果左侧空间也不够，则贴近左边
            if (left < 0) left = 5;
        }

        // 应用最终位置并显示菜单
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        menu.style.visibility = 'visible';

        document.addEventListener('click', closeTopicContextMenuOnClickOutside, true);
    }

    function closeTopicContextMenu() {
        const existingMenu = document.getElementById('topicContextMenu');
        if (existingMenu) {
            existingMenu.remove();
            document.removeEventListener('click', closeTopicContextMenuOnClickOutside, true);
        }
    }

    function closeTopicContextMenuOnClickOutside(event) {
        const menu = document.getElementById('topicContextMenu');
        if (menu && !menu.contains(event.target)) {
            closeTopicContextMenu();
        }
    }

    async function handleExportTopic(itemId, itemType, topicId, topicName) {
        const currentTopicId = currentTopicIdRef.get();
        if (topicId !== currentTopicId) {
            uiHelper.showToastNotification('请先点击并加载此话题，然后再导出。', 'info');
            return;
        }

        console.log(`[TopicListManager] Exporting currently visible topic: ${topicName} (ID: ${topicId})`);

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
                    // 克隆节点，移除思维链气泡（<think> 已被渲染为 DOM 节点，innerText 会包含其文本）
                    const contentClone = contentElement.cloneNode(true);
                    contentClone.querySelectorAll('.vcp-thought-chain-bubble').forEach(el => el.remove());
                    let content = contentClone.innerText || contentClone.textContent || "";
                    // 兜底：清理可能残留的明文形式思维链
                    content = content.replace(/\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][\s\S]*?\[--- 元思考链结束 ---\]/gs, '');
                    content = content.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
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
            console.error(`[TopicListManager] 导出话题时发生错误:`, error);
            uiHelper.showToastNotification(`导出话题时发生前端错误: ${error.message}`, 'error');
        }
    }

    /**
     * 设置鼠标快捷键事件监听器
     */
    function setupMouseShortcuts() {
        const topicsContainer = document.getElementById('tabContentTopics');
        if (!topicsContainer) {
            console.warn('[TopicListManager] 话题容器未找到，跳过鼠标快捷键设置');
            return;
        }

        let lastLeftClickTime = 0;

        // 双击左键：进入设置页面
        topicsContainer.addEventListener('click', (e) => {
            if (e.button === 0) { // 左键
                const currentTime = Date.now();
                const timeDiff = currentTime - lastLeftClickTime;

                if (timeDiff < 300) { // 双击检测（300ms内）
                    console.log('[TopicListManager] 检测到双击左键，进入设置页面');
                    e.preventDefault();
                    e.stopPropagation();

                    // 切换到设置页面
                    if (window.uiManager && typeof window.uiManager.switchToTab === 'function') {
                        window.uiManager.switchToTab('settings');
                    } else {
                        console.warn('[TopicListManager] uiManager不可用，无法切换到设置页面');
                    }
                }

                lastLeftClickTime = currentTime;
            }
        });

        // 中键点击：返回助手页面
        topicsContainer.addEventListener('auxclick', (e) => {
            if (e.button === 1) { // 中键
                console.log('[TopicListManager] 检测到中键点击，返回助手页面');
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
                    console.warn('[TopicListManager] uiManager不可用，无法切换到助手页面');
                }
            }
        });

        // 防止中键点击的默认行为
        topicsContainer.addEventListener('mousedown', (e) => {
            if (e.button === 1) { // 中键
                e.preventDefault();
            }
        });

        console.log('[TopicListManager] 鼠标快捷键设置完成');
    }

    // --- Public API ---
    return {
        init,
        loadTopicList,
        setupTopicSearch,
        showTopicContextMenu,
        setupMouseShortcuts
    };
})();
