// V-Chat Search Manager
// This module handles the global search functionality.

import { scopeCss } from './renderer/contentProcessor.js';

const STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CODE_FENCE_REGEX = /```\w*([\s\S]*?)```/g;

const searchManager = {
    // --- Properties ---
    electronAPI: null,
    uiHelper: null,
    chatManager: null,
    currentSelectedItemRef: null,
    currentTopicIdRef: null,

    elements: {},
    state: {
        allAgents: {},
        allGroups: {},
        searchResults: [],
        currentPage: 1,
        resultsPerPage: 20,
        isFetching: false,
        currentQuery: '',
    },

    // --- Initialization ---
    init(dependencies) {
        console.log('[SearchManager] Initializing...');
        this.electronAPI = dependencies.electronAPI;
        this.uiHelper = dependencies.uiHelper;
        this.chatManager = dependencies.modules.chatManager;
        this.currentSelectedItemRef = dependencies.refs.currentSelectedItemRef;
        this.currentTopicIdRef = dependencies.refs.currentTopicIdRef;

        this.setupGlobalShortcuts();
        
        // 🟢 监听模态框就绪事件
        document.addEventListener('modal-ready', (e) => {
            if (e.detail.modalId === 'globalSearchModal') {
                this.cacheDOMElements();
                this.setupModalEventListeners();
            }
        });
    },

    cacheDOMElements() {
        this.elements.modal = document.getElementById('global-search-modal');
        this.elements.closeButton = document.getElementById('global-search-close-button');
        this.elements.input = document.getElementById('global-search-input');
        this.elements.agentSelect = document.getElementById('global-search-agent-select');
        this.elements.resultsContainer = document.getElementById('global-search-results');
        this.elements.paginationContainer = document.getElementById('global-search-pagination');
    },

    setupGlobalShortcuts() {
        // 仅绑定全局快捷键，不涉及模态框内部元素
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                this.openModal();
            }
            // Esc 键关闭逻辑移至 setupModalEventListeners 或在 openModal 中动态判断
            if (e.key === 'Escape' && this.elements.modal && this.elements.modal.style.display !== 'none') {
                e.preventDefault();
                this.closeModal();
            }
        });
    },

    setupModalEventListeners() {
        if (!this.elements.closeButton) return;

        // Close button
        this.elements.closeButton.addEventListener('click', () => this.closeModal());

        // Perform search on Ctrl+Enter or Enter (if not multiline)
        this.elements.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.ctrlKey || e.shiftKey) {
                    e.preventDefault();
                    const query = this.elements.input.value.trim();
                    if (query && query !== this.state.currentQuery) {
                        this.performSearch(query);
                    }
                }
            }
        });

        this.elements.input.addEventListener('keyup', (e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
                const query = this.elements.input.value.trim();
                if (query && !query.includes('\n') && query !== this.state.currentQuery) {
                    this.performSearch(query);
                }
            }
        });
    },

    async openModal() {
        // 🟢 确保模态框已实例化
        if (!this.elements.modal) {
            this.uiHelper.openModal('globalSearchModal');
            // openModal 会触发 modal-ready，进而调用 cacheDOMElements
        }
        
        if (this.elements.modal) {
            this.elements.modal.style.display = 'flex';
            this.elements.input.focus();
        }
        this.elements.input.select();
        await this.populateAgentSelect();
    },

    async populateAgentSelect() {
        try {
            const [agents, groups] = await Promise.all([
                this.electronAPI.getAgents(),
                this.electronAPI.getAgentGroups()
            ]);

            // 保留当前选中值
            const currentValue = this.elements.agentSelect.value;
            this.elements.agentSelect.innerHTML = '';

            // 置顶"当前会话"选项
            const currentItem = this.currentSelectedItemRef?.get();
            const currentTopicId = this.currentTopicIdRef?.get();
            if (currentItem && currentItem.id && currentTopicId) {
                const currentSessionOption = document.createElement('option');
                currentSessionOption.value = 'current-session';
                currentSessionOption.textContent = `当前会话 (${currentItem.name || currentItem.id})`;
                this.elements.agentSelect.appendChild(currentSessionOption);
            }

            // "所有助手和群组"选项
            const allOption = document.createElement('option');
            allOption.value = 'all';
            allOption.textContent = '所有助手和群组';
            this.elements.agentSelect.appendChild(allOption);

            if (agents && !agents.error) {
                const agentGroup = document.createElement('optgroup');
                agentGroup.label = '助手';
                agents.forEach(agent => {
                    const option = document.createElement('option');
                    option.value = `agent:${agent.id}`;
                    option.textContent = agent.name;
                    agentGroup.appendChild(option);
                });
                this.elements.agentSelect.appendChild(agentGroup);
            }

            if (groups && !groups.error) {
                const groupGroup = document.createElement('optgroup');
                groupGroup.label = '群组';
                groups.forEach(group => {
                    const option = document.createElement('option');
                    option.value = `group:${group.id}`;
                    option.textContent = group.name;
                    groupGroup.appendChild(option);
                });
                this.elements.agentSelect.appendChild(groupGroup);
            }

            // 尝试恢复之前选中的值
            if (currentValue && Array.from(this.elements.agentSelect.options).some(opt => opt.value === currentValue)) {
                this.elements.agentSelect.value = currentValue;
            }
        } catch (error) {
            console.error('[SearchManager] Failed to populate agent select:', error);
        }
    },

    closeModal() {
        this.elements.modal.style.display = 'none';
        this.clearScopedStyles();

        // 清空搜索内容和状态，确保下次打开时是干净的
        if (this.elements.input) this.elements.input.value = '';
        if (this.elements.resultsContainer) this.elements.resultsContainer.innerHTML = '';
        if (this.elements.paginationContainer) this.elements.paginationContainer.innerHTML = '';
        
        this.state.currentQuery = '';
        this.state.searchResults = [];
        this.state.currentPage = 1;
    },

    clearScopedStyles() {
        document.querySelectorAll('style[data-vcp-search-scope-id]').forEach(el => el.remove());
    },

    generateUniqueId() {
        const timestampPart = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substring(2, 9);
        return `vcp-search-bubble-${timestampPart}${randomPart}`;
    },

    processAndInjectScopedCss(content, scopeId) {
        let cssContent = '';
        const processedContent = content.replace(STYLE_REGEX, (match, css) => {
            cssContent += css.trim() + '\n';
            return ''; // 移除 style 标签
        });

        if (cssContent.length > 0) {
            try {
                const scopedCss = scopeCss(cssContent, scopeId);
                const styleElement = document.createElement('style');
                styleElement.setAttribute('data-vcp-search-scope-id', scopeId);
                styleElement.textContent = scopedCss;
                document.head.appendChild(styleElement);
            } catch (error) {
                console.error(`[SearchManager] Failed to scope CSS for ${scopeId}:`, error);
            }
        }
        return processedContent;
    },

    async performSearch(query) {
        if (this.state.isFetching) {
            console.log('[SearchManager] Search already in progress.');
            return;
        }
        if (!query || query.length < 2) {
            this.elements.resultsContainer.innerHTML = '<p style="text-align: center; padding: 20px;">请输入至少2个字符进行搜索。</p>';
            this.state.searchResults = [];
            this.renderSearchResults();
            return;
        }

        this.state.isFetching = true;
        this.state.currentQuery = query;
        this.clearScopedStyles();
        this.elements.resultsContainer.innerHTML = '<p style="text-align: center; padding: 20px;">正在努力搜索中...</p>';
        this.elements.paginationContainer.innerHTML = '';

        try {
            const [agents, groups] = await Promise.all([
                this.electronAPI.getAgents(),
                this.electronAPI.getAgentGroups()
            ]);

            if ((!agents || agents.error) || (!groups || groups.error)) {
                throw new Error(`Failed to fetch data. AgentError: ${agents?.error}, GroupError: ${groups?.error}`);
            }
            
            this.state.allAgents = agents.reduce((acc, agent) => { acc[agent.id] = agent; return acc; }, {});
            this.state.allGroups = groups.reduce((acc, group) => { acc[group.id] = group; return acc; }, {});

            const lowerCaseQuery = query.toLowerCase();
            let allFoundMessages = [];
            const topicsToFetch = [];

            const selectedFilter = this.elements.agentSelect.value; // "all", "current-session", "agent:id", or "group:id"

            // 处理"当前会话"筛选
            if (selectedFilter === 'current-session') {
                const currentItem = this.currentSelectedItemRef?.get();
                const currentTopicId = this.currentTopicIdRef?.get();
                if (currentItem && currentItem.id && currentTopicId) {
                    // 从当前 item 的 config 中找到当前 topic 的名称
                    const itemConfig = currentItem.config || currentItem;
                    const topics = itemConfig.topics || [];
                    const currentTopic = topics.find(t => t.id === currentTopicId);
                    const topicName = currentTopic ? currentTopic.name : '当前话题';

                    topicsToFetch.push({
                        context: {
                            itemId: currentItem.id,
                            itemName: currentItem.name,
                            itemType: currentItem.type,
                            itemAvatar: currentItem.avatarUrl,
                            topicId: currentTopicId,
                            topicName: topicName
                        }
                    });
                }
            } else {
                const [filterType, filterId] = selectedFilter.split(':');

                const processItem = (item, type) => {
                    // 如果指定了过滤，且当前项目不匹配，则跳过
                    if (selectedFilter !== 'all') {
                        if (type !== filterType || item.id !== filterId) {
                            return;
                        }
                    }

                    if (item.topics && item.topics.length > 0) {
                        item.topics.forEach(topic => {
                            topicsToFetch.push({
                                context: {
                                    itemId: item.id,
                                    itemName: item.name,
                                    itemType: type,
                                    itemAvatar: item.avatarUrl,
                                    topicId: topic.id,
                                    topicName: topic.name
                                }
                            });
                        });
                    }
                };

                agents.forEach(agent => processItem(agent, 'agent'));
                groups.forEach(group => processItem(group, 'group'));
            }

            const historyReadPromises = topicsToFetch.map(info => {
                const { itemType, itemId, topicId } = info.context;
                const promise = itemType === 'agent'
                    ? this.electronAPI.getChatHistory(itemId, topicId)
                    : this.electronAPI.getGroupChatHistory(itemId, topicId);

                return promise.then(history => {
                    if (history && !history.error) {
                        return { history, context: info.context };
                    }
                    if (history && history.error) {
                         console.warn(`[SearchManager] Error fetching history for ${itemType} ${itemId}/${topicId}:`, history.error);
                    }
                    return null;
                }).catch(err => {
                    console.error(`[SearchManager] Critical error fetching history for ${itemType} ${itemId}/${topicId}:`, err);
                    return null;
                });
            });

            const results = await Promise.all(historyReadPromises);

            results.filter(r => r !== null).forEach(result => {
                result.history.forEach(message => {
                    const content = (typeof message.content === 'object' && message.content !== null && message.content.text)
                        ? message.content.text
                        : String(message.content || '');

                    // 支持多行搜索：将搜索查询和内容都标准化处理
                    const normalizedContent = content.toLowerCase().replace(/\s+/g, ' ').trim();
                    const normalizedQuery = lowerCaseQuery.replace(/\s+/g, ' ').trim();
                    
                    // 如果查询包含换行符，进行精确的多行匹配
                    let isMatch = false;
                    if (lowerCaseQuery.includes('\n')) {
                        // 多行查询：保持原始格式进行匹配
                        isMatch = content.toLowerCase().includes(lowerCaseQuery);
                    } else {
                        // 单行查询：使用标准化匹配（忽略多余空白）
                        isMatch = normalizedContent.includes(normalizedQuery);
                    }

                    if (isMatch) {
                        allFoundMessages.push({
                            ...message,
                            context: result.context
                        });
                    }
                });
            });

            // 如果在搜索过程中关闭了模态框，则不更新状态和渲染
            if (this.elements.modal.style.display === 'none') {
                return;
            }

            this.state.searchResults = allFoundMessages.sort((a, b) => b.timestamp - a.timestamp);
            this.state.currentPage = 1;
            this.renderSearchResults();

        } catch (error) {
            console.error('[SearchManager] Error during search:', error);
            this.elements.resultsContainer.innerHTML = `<p style="text-align: center; padding: 20px; color: var(--danger-text);">搜索时发生错误: ${error.message}</p>`;
        } finally {
            this.state.isFetching = false;
        }
    },

    renderSearchResults() {
        this.elements.resultsContainer.innerHTML = '';
        this.elements.paginationContainer.innerHTML = '';

        if (this.state.searchResults.length === 0) {
            this.elements.resultsContainer.innerHTML = '<p style="text-align: center; padding: 20px;">未找到匹配的结果。</p>';
            return;
        }

        const startIndex = (this.state.currentPage - 1) * this.state.resultsPerPage;
        const endIndex = startIndex + this.state.resultsPerPage;
        const paginatedResults = this.state.searchResults.slice(startIndex, endIndex);

        paginatedResults.forEach(message => {
            const itemEl = document.createElement('div');
            itemEl.classList.add('search-result-item');
            
            const scopeId = this.generateUniqueId();
            itemEl.id = scopeId;
            
            itemEl.addEventListener('click', () => this.navigateToMessage(message));

            const contentText = (typeof message.content === 'object' && message.content !== null && message.content.text)
                ? message.content.text
                : String(message.content || '');

            // ========== 🔧 修复的核心逻辑 ==========
            let processedContent = contentText;
            const codeBlocks = [];
            
            // 1️⃣ 提取代码块并用占位符替换
            processedContent = processedContent.replace(CODE_FENCE_REGEX, (match, codeContent) => {
                const placeholder = `__VCP_CODE_BLOCK_${codeBlocks.length}__`;
                codeBlocks.push(codeContent); // 只保存代码内容，不保存 ``` 标记
                return placeholder;
            });
            
            // 2️⃣ 提取并注入 Scoped CSS（针对非代码块区域）
            processedContent = this.processAndInjectScopedCss(processedContent, scopeId);
            
            // 3️⃣ 恢复代码块：转义后包装成 <pre><code>
            codeBlocks.forEach((code, i) => {
                const placeholder = `__VCP_CODE_BLOCK_${i}__`;
                const escapedCode = this.escapeHtml(code.trim());
                processedContent = processedContent.replace(
                    placeholder,
                    `<pre class="search-code-block"><code>${escapedCode}</code></pre>`
                );
            });
            // ========== 修复结束 ==========

            const contextEl = document.createElement('div');
            contextEl.classList.add('context');
            contextEl.textContent = `${message.context.itemName} > ${message.context.topicName}`;

            const contentWrapperEl = document.createElement('div');
            contentWrapperEl.classList.add('content');

            // 4️⃣ 直接渲染 HTML（div 气泡会正常显示，代码块已经被安全处理）
            contentWrapperEl.innerHTML = `<span class="name">${this.escapeHtml(message.name || message.role)}: </span><span class="message-body">${processedContent}</span>`;
            
            // 5️⃣ 在 DOM 层面高亮搜索词（避免破坏 HTML 结构）
            const query = this.state.currentQuery;
            if (query) {
                this.highlightTextInElement(contentWrapperEl.querySelector('.message-body'), query);
            }

            itemEl.appendChild(contextEl);
            itemEl.appendChild(contentWrapperEl);
            this.elements.resultsContainer.appendChild(itemEl);
        });

        this.renderPagination();
    },

    /**
     * 在元素的文本节点中高亮搜索词（不破坏 HTML 结构）
     * @param {HTMLElement} element 目标元素
     * @param {string} query 搜索词
     */
    highlightTextInElement(element, query) {
        if (!element || !query) return;
        
        const lowerQuery = query.toLowerCase().replace(/\s+/g, ' ').trim();
        
        // 使用 TreeWalker 遍历所有文本节点
        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );
        
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) {
            textNodes.push(node);
        }
        
        textNodes.forEach(textNode => {
            const text = textNode.textContent;
            const lowerText = text.toLowerCase();
            
            if (!lowerText.includes(lowerQuery)) return;
            
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            let searchIndex = 0;
            
            while ((searchIndex = lowerText.indexOf(lowerQuery, lastIndex)) !== -1) {
                // 添加匹配前的文本
                if (searchIndex > lastIndex) {
                    fragment.appendChild(
                        document.createTextNode(text.slice(lastIndex, searchIndex))
                    );
                }
                // 添加高亮的匹配文本
                const strong = document.createElement('strong');
                strong.className = 'search-highlight';
                strong.textContent = text.slice(searchIndex, searchIndex + lowerQuery.length);
                fragment.appendChild(strong);
                
                lastIndex = searchIndex + lowerQuery.length;
            }
            
            // 添加剩余文本
            if (lastIndex < text.length) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
            }
            
            textNode.parentNode.replaceChild(fragment, textNode);
        });
    },

    renderPagination() {
        const totalPages = Math.ceil(this.state.searchResults.length / this.state.resultsPerPage);
        if (totalPages <= 1) return;

        const prevButton = document.createElement('button');
        prevButton.textContent = '上一页';
        prevButton.classList.add('pagination-button');
        prevButton.disabled = this.state.currentPage === 1;
        prevButton.addEventListener('click', () => {
            if (this.state.currentPage > 1) {
                this.state.currentPage--;
                this.renderSearchResults();
            }
        });

        const nextButton = document.createElement('button');
        nextButton.textContent = '下一页';
        nextButton.classList.add('pagination-button');
        nextButton.disabled = this.state.currentPage === totalPages;
        nextButton.addEventListener('click', () => {
            if (this.state.currentPage < totalPages) {
                this.state.currentPage++;
                this.renderSearchResults();
            }
        });

        const pageInfo = document.createElement('span');
        pageInfo.textContent = `第 ${this.state.currentPage} / ${totalPages} 页 (共 ${this.state.searchResults.length} 条结果)`;
        pageInfo.style.margin = '0 15px';

        this.elements.paginationContainer.appendChild(prevButton);
        this.elements.paginationContainer.appendChild(pageInfo);
        this.elements.paginationContainer.appendChild(nextButton);
    },

    async navigateToMessage(message) {
        this.closeModal();

        const { itemId, itemType, topicId, itemName, itemAvatar } = message.context;
        
        const itemConfig = (itemType === 'agent') 
            ? this.state.allAgents[itemId] 
            : this.state.allGroups[itemId];
            
        if (!itemConfig) {
            console.error(`[SearchManager] Could not find config for ${itemType} with ID ${itemId}`);
            this.uiHelper.showToastNotification('无法导航：找不到对应的项目配置。', 'error');
            return;
        }

        // 核心修复：确保 selectItem 的异步操作完成后再继续
        await this.chatManager.selectItem(itemId, itemType, itemName, itemAvatar, itemConfig);
        // 核心修改：移除了 setTimeout，直接 await selectTopic，确保历史记录加载完毕
        await this.chatManager.selectTopic(topicId);

        // 核心修复：在 requestAnimationFrame 之后给浏览器一个渲染的喘息时间
        await new Promise(resolve => setTimeout(resolve, 100));

        const messageEl = document.querySelector(`.message-item[data-message-id='${message.id}']`);
        if (messageEl) {
            messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            messageEl.classList.add('message-highlight');
            setTimeout(() => {
                messageEl.classList.remove('message-highlight');
            }, 2500); // 保留高亮效果的延时
        } else {
            console.warn(`[SearchManager] Could not find message element with ID: ${message.id} after loading history.`);
            this.uiHelper.showToastNotification('成功定位到话题，但无法高亮显示具体消息。', 'info');
        }
    },

    escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    },

    /**
     * 转义HTML特殊字符，防止HTML注入
     * @param {string} text 要转义的文本
     * @returns {string} 转义后的文本
     */
    escapeHtml(text) {
        if (typeof text !== 'string') return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
};

export default searchManager;