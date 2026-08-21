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
    let topicListRenderGeneration = 0;
    let topicListScrollCleanup = null;
    let topicCountObserver = null;
    let isManageMode = false;
    let selectedTopicIds = new Set();
    let displayedTopics = [];
    let availableTopics = [];
    let currentItemConfig = null;
    let managedItemKey = '';

    const TOPIC_INITIAL_RENDER_COUNT = 40;
    const TOPIC_PROGRESSIVE_BATCH_SIZE = 30;
    const TOPIC_LOAD_MORE_THRESHOLD_PX = 320;

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
        setupNextUiTopicTools();

        console.log('[TopicListManager] Initialized successfully.');
    }

    function hasUserParticipation(history) {
        return Array.isArray(history) && history.some(message =>
            message &&
            message.role === 'user' &&
            message.isThinking !== true
        );
    }

    function hasValidPersistentUnreadMarker(topic, history) {
        if (topic?.unread !== true) return false;
        if (topic.unreadSource === 'manual') return true;

        // Agent/TopicSponsor 产生的旧未读标记在用户参与后即失效。
        return !hasUserParticipation(history);
    }

    async function clearStalePersistentUnreadMarker(topic, itemId, history) {
        if (
            topic?.unread !== true ||
            topic.unreadSource === 'manual' ||
            !hasUserParticipation(history)
        ) {
            return;
        }

        topic.unread = false;
        delete topic.unreadSource;

        try {
            const result = await electronAPI.setTopicUnread(itemId, topic.id, false);
            if (!result?.success) {
                console.warn(`[TopicListManager] 清理话题 ${topic.id} 的残留未读标记失败:`, result?.error);
            }
        } catch (error) {
            console.warn(`[TopicListManager] 清理话题 ${topic.id} 的残留未读标记失败:`, error);
        }
    }

    /**
     * 统计完全由 Agent 主动发起、尚无用户参与的话题消息数。
     * 系统消息和思考占位不参与判断；历史中只要出现过用户消息就返回 0。
     * @param {Array} history - 消息历史
     * @returns {number}
     */
    function countUnreadMessages(history) {
        if (!Array.isArray(history) || history.length === 0) return 0;

        const effectiveMessages = history.filter(message =>
            message &&
            message.role !== 'system' &&
            message.isThinking !== true
        );

        if (effectiveMessages.some(message => message.role === 'user')) {
            return 0;
        }

        return effectiveMessages.filter(message => message.role === 'assistant').length;
    }

    function normalizeTopicTitle(topicTitle) {
        if (typeof topicTitle !== 'string') return topicTitle;

        const trimmedTitle = topicTitle.trim();
        if (!trimmedTitle) return trimmedTitle;
        if (trimmedTitle.includes('新话题')) return trimmedTitle;

        const timeMatch = trimmedTitle.match(/(\d{1,2}:\d{2}:\d{2})/);
        if (trimmedTitle.includes('新话') && timeMatch) {
            return `新话题 ${timeMatch[1]}`;
        }

        return trimmedTitle;
    }

    /**
     * 解析话题搜索约定词。
     * 仅当完整输入为“未读话题”或“unread topic”时启用未读置顶。
     * @param {string} rawValue - 搜索框原始值
     * @returns {{ rawTerm: string, queryTerm: string, prioritizeUnread: boolean }}
     */
    function parseTopicSearchQuery(rawValue) {
        const rawTerm = String(rawValue || '').trim().toLowerCase();
        const prioritizeUnread = rawTerm === '未读话题' || rawTerm === 'unread topic';

        return {
            rawTerm,
            queryTerm: prioritizeUnread ? '' : rawTerm,
            prioritizeUnread
        };
    }

    /**
     * 读取各话题历史，并将未读话题稳定地移到顶部。
     * 未读组与已读组内部均保留用户自定义顺序。
     */
    async function prioritizeUnreadTopics(topics, currentSelectedItem) {
        const topicsWithUnreadState = await Promise.all(topics.map(async topic => {
            let history = [];
            try {
                history = currentSelectedItem.type === 'group'
                    ? await electronAPI.getGroupChatHistory(currentSelectedItem.id, topic.id)
                    : await electronAPI.getChatHistory(currentSelectedItem.id, topic.id);
            } catch (error) {
                console.warn(`[TopicListManager] 读取话题 ${topic.id} 的未读状态失败:`, error);
            }

            const calculatedUnreadCount = Array.isArray(history)
                ? countUnreadMessages(history)
                : 0;
            const hasPersistentUnread = hasValidPersistentUnreadMarker(topic, history);

            await clearStalePersistentUnreadMarker(topic, currentSelectedItem.id, history);

            return {
                topic,
                isUnread: calculatedUnreadCount > 0 || hasPersistentUnread,
                calculatedUnreadCount
            };
        }));

        const unreadTopics = [];
        const readTopics = [];
        topicsWithUnreadState.forEach(({ topic, isUnread, calculatedUnreadCount }) => {
            topic.__calculatedUnreadCount = calculatedUnreadCount;
            (isUnread ? unreadTopics : readTopics).push(topic);
        });

        return unreadTopics.concat(readTopics);
    }

    function ensureTopicUnreadIndicator(li, unreadCount = -1) {
        if (!li) return;

        let indicator = li.querySelector('.topic-unread-indicator');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'topic-unread-indicator';
            const messageCountSpan = li.querySelector('.message-count');
            li.insertBefore(indicator, messageCountSpan || null);
        }

        indicator.textContent = unreadCount > 0 ? `未读 ${unreadCount}` : '未读';
        indicator.title = unreadCount > 0 ? `${unreadCount} 条未读消息` : '未读话题';
        li.classList.add('has-unread-topic');
    }

    function removeTopicUnreadIndicator(li) {
        if (!li) return;
        li.querySelector('.topic-unread-indicator')?.remove();
        li.classList.remove('has-unread-topic');
    }

    /**
     * Part C: 计算单个话题的未读消息数
     * @param {Object} topic - 话题对象
     * @param {Array} history - 话题历史消息
     * @returns {number} - 未读消息数，-1 表示仅显示小点
     */
    function calculateTopicUnreadCount(topic, history) {
        const count = countUnreadMessages(history);
        if (count > 0) return count;

        // 没有自动计数时，仅保留仍有效的持久化未读标记。
        if (hasValidPersistentUnreadMarker(topic, history)) {
            return -1; // 仅显示小点，不显示数字
        }

        return 0; // 不显示
    }

    function cleanupProgressiveTopicRendering() {
        topicListRenderGeneration++;
        if (typeof topicListScrollCleanup === 'function') {
            topicListScrollCleanup();
            topicListScrollCleanup = null;
        }
        if (topicCountObserver) {
            topicCountObserver.disconnect();
            topicCountObserver = null;
        }
        const topicListUl = document.getElementById('topicList');
        if (topicListUl?.sortableInstance) {
            topicListUl.sortableInstance.destroy();
            topicListUl.sortableInstance = null;
        }
    }

    function getTopicScrollContainer(topicListUl) {
        return topicListUl?.closest('.sidebar-list-scroll') || topicListContainer;
    }

    function ensureTopicCountObserver() {
        if (topicCountObserver) return topicCountObserver;

        topicCountObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;

                const li = entry.target;
                topicCountObserver.unobserve(li);
                loadTopicMessageCount(li);
            });
        }, {
            root: getTopicScrollContainer(document.getElementById('topicList')),
            rootMargin: '240px 0px',
            threshold: 0.01
        });

        return topicCountObserver;
    }

    function loadTopicMessageCount(li) {
        if (!li?.isConnected || li.dataset.countLoaded === 'true' || li.dataset.countLoading === 'true') return;

        const itemId = li.dataset.itemId;
        const itemType = li.dataset.itemType;
        const topicId = li.dataset.topicId;
        const topic = li.__topicData;
        const messageCountSpan = li.querySelector('.message-count');

        if (!itemId || !itemType || !topicId || !topic || !messageCountSpan) return;

        li.dataset.countLoading = 'true';

        let historyPromise;
        if (itemType === 'agent') {
            historyPromise = electronAPI.getChatHistory(itemId, topicId);
        } else if (itemType === 'group') {
            historyPromise = electronAPI.getGroupChatHistory(itemId, topicId);
        }

        if (!historyPromise) {
            messageCountSpan.textContent = 'N/A';
            li.dataset.countLoaded = 'true';
            li.dataset.countLoading = 'false';
            return;
        }

        historyPromise.then(async historyResult => {
            if (!li.isConnected) return;

            messageCountSpan.classList.remove('has-unread', 'unread-marker-only');

            if (historyResult && !historyResult.error && Array.isArray(historyResult)) {
                await clearStalePersistentUnreadMarker(topic, itemId, historyResult);
                const unreadCount = calculateTopicUnreadCount(topic, historyResult);
                if (unreadCount > 0) {
                    messageCountSpan.textContent = `${historyResult.length}`;
                    messageCountSpan.classList.add('has-unread');
                    ensureTopicUnreadIndicator(li, unreadCount);
                } else if (unreadCount === -1) {
                    messageCountSpan.textContent = `${historyResult.length}`;
                    messageCountSpan.classList.add('unread-marker-only');
                    ensureTopicUnreadIndicator(li);
                } else {
                    messageCountSpan.textContent = `${historyResult.length}`;
                    removeTopicUnreadIndicator(li);
                }
            } else {
                messageCountSpan.textContent = 'N/A';
            }
            li.dataset.countLoaded = 'true';
        }).catch(() => {
            if (li.isConnected) {
                messageCountSpan.textContent = 'ERR';
            }
        }).finally(() => {
            if (li.isConnected) {
                li.dataset.countLoading = 'false';
            }
        });
    }

    function createTopicListItem(topic, currentSelectedItem, currentTopicId, itemConfigFull) {
        const li = document.createElement('li');
        li.classList.add('topic-item');
        li.dataset.itemId = currentSelectedItem.id;
        li.dataset.itemType = currentSelectedItem.type;
        li.dataset.topicId = topic.id;
        li.__topicData = topic;

        const isCurrentActiveTopic = topic.id === currentTopicId;
        const isPersistentlyUnread = topic.unread === true || topic.__calculatedUnreadCount > 0;
        li.classList.toggle('active', isCurrentActiveTopic);
        li.classList.toggle('active-topic-glowing', isCurrentActiveTopic);
        li.classList.toggle('has-unread-topic', isPersistentlyUnread);

        const avatarImg = document.createElement('img');
        avatarImg.classList.add('avatar');
        avatarImg.loading = 'lazy';
        avatarImg.decoding = 'async';
        avatarImg.src = currentSelectedItem.avatarUrl ? currentSelectedItem.avatarUrl : (currentSelectedItem.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png');

        const displayTopicTitle = normalizeTopicTitle(topic.name || `话题 ${topic.id}`);
        avatarImg.alt = `${currentSelectedItem.name} - ${displayTopicTitle}`;
        avatarImg.onerror = () => { avatarImg.src = (currentSelectedItem.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png'); };

        const topicTitleDisplay = document.createElement('span');
        topicTitleDisplay.classList.add('topic-title-display');
        topicTitleDisplay.textContent = displayTopicTitle;

        const messageCountSpan = document.createElement('span');
        messageCountSpan.classList.add('message-count');
        messageCountSpan.textContent = '...';

        const selectionIcon = document.createElement('span');
        selectionIcon.classList.add('next-ui-topic-select-icon', 'vcp-ui-icon');
        selectionIcon.setAttribute('aria-hidden', 'true');
        selectionIcon.textContent = selectedTopicIds.has(topic.id) ? 'check_box' : 'check_box_outline_blank';
        li.appendChild(selectionIcon);
        li.appendChild(avatarImg);

        if (topic.locked === false) {
            const unlockedIndicator = document.createElement('span');
            unlockedIndicator.classList.add('unlocked-indicator');
            unlockedIndicator.textContent = 'unlocked';
            unlockedIndicator.title = 'AI可以查看和回复此话题';
            li.appendChild(unlockedIndicator);
        }

        li.appendChild(topicTitleDisplay);
        if (isPersistentlyUnread) {
            ensureTopicUnreadIndicator(li, topic.__calculatedUnreadCount);
        }
        li.appendChild(messageCountSpan);

        const observer = ensureTopicCountObserver();
        observer.observe(li);

        li.addEventListener('click', async () => {
            if (isManageMode) {
                toggleTopicSelection(topic.id);
                return;
            }

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
            if (isManageMode) return;
            showTopicContextMenu(e, li, itemConfigFull, topic, currentSelectedItem.type);
        });

        return li;
    }

    function renderTopicListProgressively(topicListUl, topicsToProcess, currentSelectedItem, currentTopicId, itemConfigFull, searchTerm) {
        const renderGeneration = topicListRenderGeneration;
        const scrollContainer = getTopicScrollContainer(topicListUl);
        const totalCount = topicsToProcess.length;
        const initialCount = searchTerm
            ? Math.min(Math.max(TOPIC_INITIAL_RENDER_COUNT, TOPIC_PROGRESSIVE_BATCH_SIZE), totalCount)
            : Math.min(TOPIC_INITIAL_RENDER_COUNT, totalCount);

        let currentIndex = 0;
        let isRendering = false;
        let allRendered = false;

        const statusLi = document.createElement('li');
        statusLi.className = 'topic-list-progressive-status';
        statusLi.textContent = '';
        statusLi.style.justifyContent = 'center';
        statusLi.style.opacity = '0.75';

        const finalizeIfDone = () => {
            if (!allRendered || renderGeneration !== topicListRenderGeneration) return;

            statusLi.remove();
            if (typeof topicListScrollCleanup === 'function') {
                topicListScrollCleanup();
                topicListScrollCleanup = null;
            }

            if (currentSelectedItem.id && topicsToProcess.length > 0 && typeof Sortable !== 'undefined' && !searchTerm) {
                initializeTopicSortable(currentSelectedItem.id, currentSelectedItem.type);
            }
        };

        const renderNextBatch = (batchSize = TOPIC_PROGRESSIVE_BATCH_SIZE) => {
            if (isRendering || allRendered || renderGeneration !== topicListRenderGeneration) return;
            isRendering = true;

            requestAnimationFrame(() => {
                if (renderGeneration !== topicListRenderGeneration) {
                    isRendering = false;
                    return;
                }

                const fragment = document.createDocumentFragment();
                const end = Math.min(currentIndex + batchSize, totalCount);

                for (; currentIndex < end; currentIndex++) {
                    fragment.appendChild(createTopicListItem(
                        topicsToProcess[currentIndex],
                        currentSelectedItem,
                        currentTopicId,
                        itemConfigFull
                    ));
                }

                if (statusLi.parentNode === topicListUl) {
                    topicListUl.insertBefore(fragment, statusLi);
                } else {
                    topicListUl.appendChild(fragment);
                }

                allRendered = currentIndex >= totalCount;
                isRendering = false;

                if (!allRendered) {
                    statusLi.textContent = `继续向下滚动加载更多话题（${currentIndex}/${totalCount}）`;
                    if (!statusLi.parentNode) topicListUl.appendChild(statusLi);
                    if (scrollContainer.scrollHeight <= scrollContainer.clientHeight + TOPIC_LOAD_MORE_THRESHOLD_PX) {
                        renderNextBatch();
                    }
                } else {
                    finalizeIfDone();
                }
            });
        };

        const onScroll = () => {
            if (allRendered || isRendering || renderGeneration !== topicListRenderGeneration) return;

            const distanceToBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
            if (distanceToBottom <= TOPIC_LOAD_MORE_THRESHOLD_PX) {
                renderNextBatch();
            }
        };

        scrollContainer.addEventListener('scroll', onScroll, { passive: true });
        topicListScrollCleanup = () => scrollContainer.removeEventListener('scroll', onScroll);

        topicListUl.innerHTML = '';
        renderNextBatch(initialCount);
    }

    async function loadTopicList() {
        if (!topicListContainer) {
            console.error("Topic list container (tabContentTopics) not found.");
            return;
        }

        cleanupProgressiveTopicRendering();

        let topicListUl = topicListContainer.querySelector('.topic-list');
        if (topicListUl) {
            topicListUl.innerHTML = '';
        } else {
            const topicsHeader = topicListContainer.querySelector('.topics-header') || document.createElement('div');
            if (!topicsHeader.classList.contains('topics-header')) {
                topicsHeader.className = 'topics-header';
                topicsHeader.innerHTML = `<h2>话题列表</h2><div class="topic-search-container"><input type="text" id="topicSearchInput" placeholder="搜索话题；输入“未读话题”置顶" title="输入“未读话题”或“unread topic”将未读话题置顶" aria-label="搜索话题；输入未读话题将未读话题置顶" class="topic-search-input"></div>`;
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
            availableTopics = [];
            displayedTopics = [];
            currentItemConfig = null;
            managedItemKey = '';
            selectedTopicIds.clear();
            syncManageUi();
            topicListUl.innerHTML = '<li><p>请先在“助手与群组”列表选择一个项目以查看其相关话题。</p></li>';
            return;
        }

        const nextItemKey = `${currentSelectedItem.type}:${currentSelectedItem.id}`;
        if (managedItemKey && managedItemKey !== nextItemKey) {
            selectedTopicIds.clear();
        }
        managedItemKey = nextItemKey;

        const itemNameForLoading = currentSelectedItem.name || '当前项目';
        const searchInput = document.getElementById('topicSearchInput');
        const searchQuery = parseTopicSearchQuery(searchInput ? searchInput.value : '');
        const searchTerm = searchQuery.rawTerm;
        const contentQueryTerm = searchQuery.queryTerm;

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
            availableTopics = [];
            displayedTopics = [];
            currentItemConfig = null;
            selectedTopicIds.clear();
            syncManageUi();
            topicListUl.innerHTML = `<li><p>无法加载 ${itemNameForLoading} 的配置信息: ${itemConfigFull?.error || '未知错误'}</p></li>`;
        } else {
            let topicsToProcess = itemConfigFull.topics || [];
            if (currentSelectedItem.type === 'agent' && topicsToProcess.length === 0) {
                const defaultAgentTopic = { id: "default", name: "主要对话", createdAt: Date.now() };
                topicsToProcess.push(defaultAgentTopic);
            }

            availableTopics = [...topicsToProcess];
            currentItemConfig = itemConfigFull;
            const availableTopicIds = new Set(availableTopics.map(topic => topic.id));
            selectedTopicIds = new Set([...selectedTopicIds].filter(topicId => availableTopicIds.has(topicId)));

            // topicsToProcess.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            if (contentQueryTerm) {
                let frontendFilteredTopics = topicsToProcess.filter(topic => {
                    const normalizedTopicTitle = normalizeTopicTitle(topic.name || '');
                    const nameMatch = normalizedTopicTitle.toLowerCase().includes(contentQueryTerm);
                    let dateMatch = false;
                    if (topic.createdAt) {
                        const date = new Date(topic.createdAt);
                        const fullDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                        const shortDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                        dateMatch = fullDateStr.toLowerCase().includes(contentQueryTerm) || shortDateStr.toLowerCase().includes(contentQueryTerm);
                    }
                    return nameMatch || dateMatch;
                });

                let contentMatchedTopicIds = [];
                try {
                    const contentSearchResult = await electronAPI.searchTopicsByContent(currentSelectedItem.id, currentSelectedItem.type, contentQueryTerm);
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

            if (searchQuery.prioritizeUnread) {
                topicsToProcess = await prioritizeUnreadTopics(topicsToProcess, currentSelectedItem);
            }

            displayedTopics = [...topicsToProcess];
            syncManageUi();

            if (topicsToProcess.length === 0) {
                topicListUl.innerHTML = `<li><p>${itemNameForLoading} 还没有任何话题${searchTerm ? '匹配当前搜索' : ''}。您可以点击上方的“新建${currentSelectedItem.type === 'group' ? '群聊话题' : '聊天话题'}”按钮创建一个。</p></li>`;
            } else {
                const currentTopicId = currentTopicIdRef.get();
                renderTopicListProgressively(topicListUl, topicsToProcess, currentSelectedItem, currentTopicId, itemConfigFull, searchTerm);
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
        if (inputElement.dataset.topicSearchBound === 'true') return;
        inputElement.dataset.topicSearchBound = 'true';

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

    function setupNextUiTopicTools() {
        const topicsHeader = document.querySelector('#tabContentTopics .topics-header-container');
        const createButton = document.getElementById('nextUiCreateTopicBtn');
        const manageButton = document.getElementById('nextUiManageTopicsBtn');
        const searchButton = document.getElementById('nextUiTopicSearchTrigger');
        const searchCloseButton = document.getElementById('nextUiTopicSearchClose');
        const searchInput = document.getElementById('topicSearchInput');
        const selectAllButton = document.getElementById('nextUiSelectAllTopicsBtn');
        const deleteButton = document.getElementById('nextUiDeleteTopicsBtn');
        const exitButton = document.getElementById('nextUiExitTopicManageBtn');

        if (!topicsHeader || !createButton || !manageButton || !searchButton || !searchCloseButton || !searchInput) return;
        if (topicsHeader.dataset.nextUiToolsBound === 'true') return;
        topicsHeader.dataset.nextUiToolsBound = 'true';

        const setSearchMode = (active, clear = !active) => {
            topicsHeader.classList.toggle('is-searching', active);
            searchButton.setAttribute('aria-expanded', String(active));
            if (clear) {
                searchInput.value = '';
                loadTopicList();
            }
            if (active) requestAnimationFrame(() => searchInput.focus());
            else if (document.activeElement === searchInput) searchButton.focus();
        };

        createButton.addEventListener('click', () => {
            document.getElementById('currentAgentSettingsBtn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        createButton.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            document.getElementById('currentAgentSettingsBtn')?.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: event.clientX,
                clientY: event.clientY
            }));
        });
        manageButton.addEventListener('click', () => setManageMode(!isManageMode));
        searchButton.addEventListener('click', () => setSearchMode(true, false));
        searchCloseButton.addEventListener('click', () => setSearchMode(false, true));
        searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setSearchMode(false, true);
            }
        });
        selectAllButton?.addEventListener('click', toggleSelectAllDisplayedTopics);
        deleteButton?.addEventListener('click', deleteSelectedTopics);
        exitButton?.addEventListener('click', () => setManageMode(false));

        syncManageUi();
    }

    function setManageMode(active) {
        isManageMode = active;
        if (!active) selectedTopicIds.clear();

        const topicListUl = document.getElementById('topicList');
        if (active && topicListUl?.sortableInstance) {
            topicListUl.sortableInstance.destroy();
            topicListUl.sortableInstance = null;
        } else if (!active) {
            loadTopicList();
        }

        syncManageUi();
    }

    function toggleTopicSelection(topicId) {
        if (selectedTopicIds.has(topicId)) selectedTopicIds.delete(topicId);
        else selectedTopicIds.add(topicId);
        syncManageUi();
    }

    function toggleSelectAllDisplayedTopics() {
        const displayedIds = displayedTopics.map(topic => topic.id);
        const allDisplayedSelected = displayedIds.length > 0 && displayedIds.every(topicId => selectedTopicIds.has(topicId));

        if (allDisplayedSelected) displayedIds.forEach(topicId => selectedTopicIds.delete(topicId));
        else displayedIds.forEach(topicId => selectedTopicIds.add(topicId));
        syncManageUi();
    }

    function syncManageUi() {
        const container = document.getElementById('tabContentTopics');
        const manageButton = document.getElementById('nextUiManageTopicsBtn');
        const managePanel = container?.querySelector('.next-ui-topic-manage-panel');
        const count = document.getElementById('nextUiTopicSelectionCount');
        const selectAllButton = document.getElementById('nextUiSelectAllTopicsBtn');
        const deleteButton = document.getElementById('nextUiDeleteTopicsBtn');
        const allDisplayedSelected = displayedTopics.length > 0
            && displayedTopics.every(topic => selectedTopicIds.has(topic.id));

        container?.classList.toggle('is-managing', isManageMode);
        manageButton?.classList.toggle('active', isManageMode);
        manageButton?.setAttribute('aria-pressed', String(isManageMode));
        managePanel?.setAttribute('aria-hidden', String(!isManageMode));
        if (count) count.textContent = `已选择 ${selectedTopicIds.size} 项`;
        if (deleteButton) deleteButton.disabled = selectedTopicIds.size === 0;
        const selectAllIcon = selectAllButton?.querySelector('.vcp-ui-icon');
        if (selectAllIcon) selectAllIcon.textContent = allDisplayedSelected ? 'check_box' : 'check_box_outline_blank';
        if (selectAllButton) selectAllButton.title = allDisplayedSelected ? '取消全选' : '全选话题';

        document.querySelectorAll('#topicList .topic-item').forEach(item => {
            const selected = selectedTopicIds.has(item.dataset.topicId);
            item.classList.toggle('selected', selected);
            item.setAttribute('aria-selected', String(selected));
            const icon = item.querySelector('.next-ui-topic-select-icon');
            if (icon) icon.textContent = selected ? 'check_box' : 'check_box_outline_blank';
        });
    }

    async function deleteSelectedTopics() {
        if (!isManageMode || selectedTopicIds.size === 0 || !currentItemConfig) return;

        const currentSelectedItem = currentSelectedItemRef.get();
        const topicsToDelete = availableTopics.filter(topic => selectedTopicIds.has(topic.id));
        if (topicsToDelete.length === 0) return;
        if (topicsToDelete.length >= availableTopics.length) {
            uiHelper.showToastNotification('至少需要保留一个话题。', 'warning');
            return;
        }

        const flowlockedTopic = currentSelectedItem.type === 'agent'
            ? topicsToDelete.find(topic => window.flowlockManager?.isTopicLocked?.(currentSelectedItem.id, topic.id))
            : null;
        if (flowlockedTopic) {
            uiHelper.showToastNotification(`话题“${flowlockedTopic.name}”正在心流锁中运行，请先停止对应心流锁。`, 'warning');
            return;
        }

        const confirmed = await uiHelper.showConfirmDialog(
            `确定要永久删除选中的 ${topicsToDelete.length} 个话题吗？此操作不可撤销。`,
            '批量删除话题',
            '删除',
            '取消',
            true
        );
        if (!confirmed) return;

        let deletedCount = 0;
        let remainingTopics = availableTopics;
        let firstError = '';
        const activeTopicId = currentTopicIdRef.get();
        let activeTopicDeleted = false;

        for (const topic of topicsToDelete) {
            try {
                const result = currentSelectedItem.type === 'agent'
                    ? await electronAPI.deleteTopic(currentSelectedItem.id, topic.id)
                    : await electronAPI.deleteGroupTopic(currentSelectedItem.id, topic.id);
                if (result?.success) {
                    deletedCount++;
                    if (topic.id === activeTopicId) activeTopicDeleted = true;
                    remainingTopics = result.remainingTopics || remainingTopics.filter(item => item.id !== topic.id);
                } else if (!firstError) {
                    firstError = result?.error || '未知错误';
                }
            } catch (error) {
                if (!firstError) firstError = error.message;
            }
        }

        if (activeTopicDeleted) {
            mainRendererFunctions.handleTopicDeletion(remainingTopics, {
                id: currentSelectedItem.id,
                type: currentSelectedItem.type
            });
        }

        setManageMode(false);
        if (deletedCount > 0) uiHelper.showToastNotification(`已删除 ${deletedCount} 个话题。`, 'success');
        if (firstError) uiHelper.showToastNotification(`部分话题删除失败：${firstError}`, 'error');
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
                if (electronAPI?.getSelectionListenerStatus) {
                    wasSelectionListenerActive = await electronAPI.getSelectionListenerStatus();
                    if (wasSelectionListenerActive) {
                        electronAPI.toggleSelectionListener(false);
                    }
                }
            },
            onEnd: async function (evt) {
                // Re-enable selection hook only if it was active before the drag.
                if (electronAPI?.toggleSelectionListener) {
                    if (wasSelectionListenerActive) {
                        electronAPI.toggleSelectionListener(true);
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

        const copyTopicIdOption = document.createElement('div');
        copyTopicIdOption.classList.add('context-menu-item');
        copyTopicIdOption.innerHTML = `<i class="fas fa-copy"></i> 复制话题ID`;
        copyTopicIdOption.onclick = async () => {
            closeTopicContextMenu();
            const topicId = String(topic.id ?? '');
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(topicId);
                } else {
                    const textarea = document.createElement('textarea');
                    textarea.value = topicId;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.focus();
                    textarea.select();
                    document.execCommand('copy');
                    textarea.remove();
                }
                uiHelper.showToastNotification('已复制话题ID', 'success');
            } catch (error) {
                console.error('[TopicListManager] Failed to copy topic ID:', error);
                uiHelper.showToastNotification(`复制话题ID失败: ${error.message}`, 'error');
            }
        };
        menu.appendChild(copyTopicIdOption);

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
                    if (result.unreadSource) {
                        topic.unreadSource = result.unreadSource;
                    } else {
                        delete topic.unreadSource;
                    }
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

            // 活动 Flowlock Session 仍依赖该话题的历史目录，运行期间禁止删除。
            if (itemType === 'agent' && window.flowlockManager?.isTopicLocked?.(itemFullConfig.id, topic.id)) {
                uiHelper.showToastNotification('该话题正在心流锁中运行，请先停止对应 Agent 的心流锁。', 'warning');
                return;
            }

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
                        mainRendererFunctions.handleTopicDeletion(result.remainingTopics, {
                            id: itemFullConfig.id,
                            type: itemType
                        });
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

        const exportFullTopicOption = document.createElement('div');
        exportFullTopicOption.classList.add('context-menu-item');
        exportFullTopicOption.innerHTML = `<i class="fas fa-file-code"></i> 导出此话题(完整)`;
        exportFullTopicOption.onclick = () => {
            closeTopicContextMenu();
            handleExportFullTopic(itemFullConfig, itemType, topic.id, topic.name);
        };
        menu.appendChild(exportFullTopicOption);

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
                    // 兜底：仅清理起止标签分别独占一行的明文思维链。
                    content = content.replace(/^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*\r?\n[\s\S]*?^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm, '');
                    content = content.replace(/^[ \t]*<think(?:ing)?>[ \t]*\r?\n[\s\S]*?^[ \t]*<\/think(?:ing)?>[ \t]*(?:\r?\n|$)/gim, '');
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

    function getRawMessageContent(message) {
        if (typeof message?.content === 'string') return message.content;
        if (typeof message?.content?.text === 'string') return message.content.text;
        if (Array.isArray(message?.content)) {
            return message.content
                .filter(part => part && part.type === 'text' && typeof part.text === 'string')
                .map(part => part.text)
                .join('\n');
        }
        if (message?.content === null || message?.content === undefined) return '';
        try {
            return JSON.stringify(message.content, null, 2);
        } catch {
            return String(message.content);
        }
    }

    function resolveFullExportAgentInfo(message, itemFullConfig, itemType) {
        if (message.role === 'user') {
            return {
                name: message.name || '用户',
                model: 'N/A'
            };
        }

        if (itemType === 'group') {
            const agentId = message.agentId || message.agentID;
            const member = (itemFullConfig.agents || []).find(agent =>
                agent.id === agentId || agent.agentId === agentId
            );
            const usesUnifiedModel = itemFullConfig.useUnifiedModel === true;
            return {
                name: message.name || member?.name || agentId || 'Assistant',
                model: message.model || message.modelName ||
                    (usesUnifiedModel ? itemFullConfig.unifiedModel : member?.model) ||
                    '未知模型'
            };
        }

        return {
            name: message.name || itemFullConfig.name || itemFullConfig.id || 'Assistant',
            model: message.model || message.modelName || itemFullConfig.model || '未知模型'
        };
    }

    async function handleExportFullTopic(itemFullConfig, itemType, topicId, topicName) {
        console.log(`[TopicListManager] Exporting full raw topic: ${topicName} (ID: ${topicId})`);

        try {
            const history = itemType === 'group'
                ? await electronAPI.getGroupChatHistory(itemFullConfig.id, topicId)
                : await electronAPI.getChatHistory(itemFullConfig.id, topicId);

            if (!Array.isArray(history)) {
                throw new Error(history?.error || '无法读取话题历史');
            }

            const messages = history.filter(message =>
                message &&
                message.role !== 'system' &&
                message.isThinking !== true
            );

            if (messages.length === 0) {
                uiHelper.showToastNotification('此话题没有可导出的对话内容。', 'info');
                return;
            }

            let exportContent = `# 话题: ${topicName}\n\n`;
            exportContent += `> 导出模式: 完整（保留原始消息内容）\n\n`;

            messages.forEach((message, index) => {
                const { name, model } = resolveFullExportAgentInfo(message, itemFullConfig, itemType);
                const rawContent = getRawMessageContent(message);

                exportContent += `===== 消息 ${index + 1} =====\n`;
                exportContent += `Role: ${message.role || 'unknown'}\n`;
                exportContent += `Agent: ${name}\n`;
                exportContent += `Model: ${model}\n`;
                if (message.timestamp) {
                    exportContent += `Timestamp: ${new Date(message.timestamp).toISOString()}\n`;
                }
                exportContent += `\n${rawContent}\n\n`;
            });

            const result = await electronAPI.exportTopicAsMarkdown({
                topicName: `${topicName}-完整`,
                markdownContent: exportContent
            });

            if (result.success) {
                uiHelper.showToastNotification(`话题 "${topicName}" 已完整导出到: ${result.path}`);
            } else if (result.error !== '用户取消了导出操作。') {
                uiHelper.showToastNotification(`完整导出话题失败: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('[TopicListManager] 完整导出话题时发生错误:', error);
            uiHelper.showToastNotification(`完整导出话题失败: ${error.message}`, 'error');
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
            if (isManageMode) return;
            if (e.target.closest('button, input, .topics-header-container, .next-ui-topic-manage-panel')) return;
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
