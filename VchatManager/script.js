document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const agentsListEl = document.getElementById('agents-list');
    const groupsListEl = document.getElementById('groups-list');
    const chatHistoryEl = document.getElementById('chat-history');
    const jsonEditorEl = document.getElementById('json-editor');
    const attachmentViewerEl = document.getElementById('attachment-viewer');
    const tabsEl = document.getElementById('tabs');
    const tabPanels = document.querySelectorAll('.tab-panel');
    const mainContentEl = document.getElementById('main-content');
    const searchModalEl = document.getElementById('search-modal');
    const closeSearchModalBtn = document.getElementById('close-search-modal');
    const searchInputEl = document.getElementById('search-input');
    const searchResultsEl = document.getElementById('search-results');
    const searchPaginationEl = document.getElementById('search-pagination');

    // --- State Variables ---
    const AppDataPath = 'AppData/';
    let currentHistory = [];
    let currentHistoryPath = '';
    let allAgents = {};
    let allGroups = {};
    let allSettings = {};
    let searchResults = [];
    let currentPage = 1;
    const resultsPerPage = 15;
    let consistencyChecker = null;
    let lastCheckResults = null;

    // --- Data Fetching and Initial Rendering ---
    async function fetchData() {
        try {
            const settingsStr = await window.api.readFile(`${AppDataPath}settings.json`);
            if (!settingsStr) throw new Error('Failed to read settings.json');
            const settings = JSON.parse(settingsStr);

            const agents = {};
            const groups = {};

            // If combinedItemOrder doesn't exist, build it from existing directories
            let combinedItemOrder = settings.combinedItemOrder;
            if (!combinedItemOrder || !Array.isArray(combinedItemOrder)) {
                combinedItemOrder = [];

                // Scan Agents directory
                const agentDirs = await window.api.listDir(`${AppDataPath}Agents`);
                if (agentDirs && Array.isArray(agentDirs)) {
                    for (const agentId of agentDirs) {
                        combinedItemOrder.push({ type: 'agent', id: agentId });
                    }
                }

                // Scan AgentGroups directory
                const groupDirs = await window.api.listDir(`${AppDataPath}AgentGroups`);
                if (groupDirs && Array.isArray(groupDirs)) {
                    for (const groupId of groupDirs) {
                        combinedItemOrder.push({ type: 'group', id: groupId });
                    }
                }
            }

            for (const item of combinedItemOrder) {
                const configPath = item.type === 'agent'
                    ? `${AppDataPath}Agents/${item.id}/config.json`
                    : `${AppDataPath}AgentGroups/${item.id}/config.json`;

                const configStr = await window.api.readFile(configPath);
                if (configStr) {
                    const config = JSON.parse(configStr);
                    const avatarPath = configPath.replace('config.json', 'avatar.png');

                    // Check if avatar file exists, otherwise use default
                    const avatarExists = await window.api.readFile(avatarPath);
                    const finalAvatarPath = avatarExists ? avatarPath :
                        (item.type === 'agent' ? 'assets/default_avatar.png' : 'assets/default_group_avatar.png');

                    if (item.type === 'agent') {
                        agents[item.id] = { ...config, id: item.id, avatar: finalAvatarPath };
                    } else {
                        groups[item.id] = { ...config, id: item.id, avatar: finalAvatarPath };
                    }
                } else {
                    console.warn(`Could not load config for ${item.type}: ${item.id}`);
                }
            }

            // Update settings with the combinedItemOrder if it was constructed
            settings.combinedItemOrder = combinedItemOrder;

            allSettings = settings;
            allAgents = agents;
            allGroups = groups;
            return { settings, agents, groups };
        } catch (error) {
            console.error("Error loading VChat data:", error);
            mainContentEl.innerHTML = `<p style="color: red;">Error loading data: ${error.message}.</p>`;
            return null;
        }
    }

    function renderSidebar(data) {
        if (!data) return;
        const { settings, agents, groups } = data;

        agentsListEl.innerHTML = '<h3>Agents</h3>';
        groupsListEl.innerHTML = '<h3>Groups</h3>';

        // Check if combinedItemOrder exists and is an array
        if (!settings.combinedItemOrder || !Array.isArray(settings.combinedItemOrder)) {
            console.warn('No combinedItemOrder found in settings');
            return;
        }

        settings.combinedItemOrder.forEach(item => {
            const itemData = item.type === 'agent' ? agents[item.id] : groups[item.id];
            if (!itemData) return;

            const listItem = document.createElement('div');
            listItem.classList.add('sidebar-item');
            listItem.dataset.id = item.id;
            listItem.dataset.type = item.type;
            
            // Handle avatar path for Electron
            let avatarSrc;
            if (itemData.avatar.startsWith('assets/')) {
                // Default avatar from assets folder
                avatarSrc = `../${itemData.avatar}`;
            } else {
                // Custom avatar from AppData
                avatarSrc = `../${itemData.avatar}`;
            }

            listItem.innerHTML = `<img src="${avatarSrc}" class="avatar" alt="${itemData.name || 'Unknown'} avatar" onerror="this.src='../assets/default_avatar.png'"><span>${itemData.name || 'Unknown Agent'}</span>`;
            
            if (item.type === 'agent') {
                agentsListEl.appendChild(listItem);
            } else {
                groupsListEl.appendChild(listItem);
            }
            
            listItem.addEventListener('click', () => handleSidebarClick(itemData));
        });
    }

    function handleSidebarClick(itemData) {
        switchTab('chat-history');
        chatHistoryEl.innerHTML = '';
        jsonEditorEl.innerHTML = '';
        currentHistory = [];
        currentHistoryPath = '';

        if (!itemData || !itemData.topics) {
            chatHistoryEl.innerHTML = '<p>No topics found for this item.</p>';
            return;
        }

        const topicsList = document.createElement('ul');
        topicsList.classList.add('topics-list');
        
        // Sort topics by createdAt timestamp, newest first
        const sortedTopics = [...itemData.topics].sort((a, b) => b.createdAt - a.createdAt);

        sortedTopics.forEach(topic => {
            const topicItem = document.createElement('li');
            topicItem.textContent = `${topic.name} (${topic.id})`;
            topicItem.addEventListener('click', (e) => {
                e.stopPropagation();
                loadChatHistory(itemData.id, topic.id);
            });
            topicsList.appendChild(topicItem);
        });

        chatHistoryEl.appendChild(topicsList);
    }

    async function loadChatHistory(itemId, topicId) {
        chatHistoryEl.innerHTML = `<p>Loading history for ${topicId}...</p>`;
        currentHistoryPath = `${AppDataPath}UserData/${itemId}/topics/${topicId}/history.json`;
        
        try {
            const historyStr = await window.api.readFile(currentHistoryPath);
            if (!historyStr) throw new Error('History file is empty or could not be read.');
            
            currentHistory = JSON.parse(historyStr);
            renderChatHistory(currentHistory);
            renderJsonEditor(currentHistory);
        } catch (error) {
            console.error(`Error loading history for ${itemId}/${topicId}:`, error);
            chatHistoryEl.innerHTML = `<p style="color: red;">Could not load chat history: ${error.message}</p>`;
            jsonEditorEl.innerHTML = '';
        }
    }

    function renderChatHistory(history) {
        switchTab('chat-history');
        chatHistoryEl.innerHTML = '<h3>Chat History</h3>';
        history.forEach(message => {
            const messageEl = createMessageElement(message);
            chatHistoryEl.appendChild(messageEl);
        });
    }

    function createMessageElement(message) {
        const messageEl = document.createElement('div');
        messageEl.classList.add('message', `role-${message.role}`);
        messageEl.dataset.messageId = message.id;

        const headerDiv = document.createElement('div');
        headerDiv.classList.add('message-header');
        headerDiv.innerHTML = `
            <span class="name">${message.name || message.role}</span>
            <span class="timestamp">${new Date(message.timestamp).toLocaleString()}</span>
        `;

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('content');
        
        // Store reference to the original message object for editing
        contentDiv.messageData = message; 
        
        // Set initial text content
        updateMessageContent(contentDiv, message.content);

        contentDiv.addEventListener('click', () => enterEditMode(contentDiv));

        messageEl.appendChild(headerDiv);
        messageEl.appendChild(contentDiv);
        return messageEl;
    }

    function updateMessageContent(contentDiv, contentData) {
        if (typeof contentData === 'string') {
            contentDiv.textContent = contentData;
        } else if (typeof contentData === 'object' && contentData !== null) {
            if (contentData.hasOwnProperty('text')) {
                contentDiv.textContent = contentData.text;
            } else {
                contentDiv.textContent = JSON.stringify(contentData, null, 2);
            }
        } else {
            contentDiv.textContent = String(contentData);
        }
    }

    function enterEditMode(contentDiv) {
        if (contentDiv.querySelector('textarea')) return; // Already in edit mode

        const message = contentDiv.messageData;
        const originalContent = (typeof message.content === 'object' && message.content.hasOwnProperty('text'))
            ? message.content.text
            : message.content;

        const textarea = document.createElement('textarea');
        textarea.classList.add('edit-textarea');
        textarea.value = originalContent;
        
        contentDiv.innerHTML = '';
        contentDiv.appendChild(textarea);
        textarea.focus();
        textarea.style.height = `${textarea.scrollHeight}px`; // Auto-adjust height

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                saveEdit(contentDiv, textarea.value);
            }
            if (e.key === 'Escape') {
                cancelEdit(contentDiv, originalContent);
            }
        });

        textarea.addEventListener('blur', () => {
             // Revert if user clicks away without saving
            cancelEdit(contentDiv, originalContent);
        });
    }

    async function saveEdit(contentDiv, newText) {
        const message = contentDiv.messageData;

        // Update the in-memory history object carefully
        if (typeof message.content === 'object' && message.content.hasOwnProperty('text')) {
            message.content.text = newText;
        } else {
            message.content = newText;
        }

        // Persist changes to the file
        const result = await window.api.writeFile(currentHistoryPath, JSON.stringify(currentHistory, null, 2));
        if (result.success) {
            console.log('History saved successfully.');
            // Update the UI
            updateMessageContent(contentDiv, message.content);
            // Also update the JSON editor view
            renderJsonEditor(currentHistory);
        } else {
            console.error('Failed to save history:', result.error);
            // Revert UI on failure
            cancelEdit(contentDiv, message.content); 
            alert(`Error saving file: ${result.error}`);
        }
    }

    function cancelEdit(contentDiv, originalContent) {
         updateMessageContent(contentDiv, originalContent);
    }

   function renderJsonEditor(history) {
       jsonEditorEl.innerHTML = '<h3>JSON Editor</h3>';
       const pre = document.createElement('pre');
       const code = document.createElement('code');
       code.textContent = JSON.stringify(history, null, 2);
       pre.appendChild(code);
       jsonEditorEl.appendChild(pre);
   }

    // --- Other UI Functions (Tabs, Attachments, etc.) ---
    // ... (previous functions for tabs, attachments, theme, resizer remain here) ...
    function setupResizer() {
        const resizer = document.getElementById('resizer');
        const sidebar = document.getElementById('sidebar');
        
        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            document.body.style.userSelect = 'none';
            document.body.style.pointerEvents = 'none';

            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        });

        function handleMouseMove(e) {
            if (!isResizing) return;
            let newWidth = e.clientX;
            if (newWidth < 200) newWidth = 200;
            if (newWidth > 600) newWidth = 600;
            sidebar.style.width = `${newWidth}px`;
        }

        function handleMouseUp() {
            isResizing = false;
            document.body.style.userSelect = '';
            document.body.style.pointerEvents = '';
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        }
    }

    function setupThemeToggle() {
        const themeToggleButton = document.getElementById('theme-toggle');
        themeToggleButton.addEventListener('click', () => {
            document.body.classList.toggle('light-theme');
            const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
            localStorage.setItem('vchat-manager-theme', currentTheme);
        });

        const savedTheme = localStorage.getItem('vchat-manager-theme');
        if (savedTheme === 'light') {
            document.body.classList.add('light-theme');
        }
    }
    
    function switchTab(tabId) {
        tabsEl.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });
        tabPanels.forEach(panel => {
            panel.classList.toggle('active', panel.id === tabId);
        });
    }

    tabsEl.addEventListener('click', (e) => {
        if (e.target.matches('.tab-button')) {
            const tabId = e.target.dataset.tab;
            switchTab(tabId);
            if (tabId === 'attachment-viewer' && attachmentViewerEl.childElementCount === 0) {
                loadAndRenderAttachments();
            }
        }
    });
    
    async function loadAndRenderAttachments() {
        attachmentViewerEl.innerHTML = '<p>Loading attachments...</p>';
        try {
            const files = await window.api.listDir(`${AppDataPath}UserData/attachments`);
            attachmentViewerEl.innerHTML = '';

            const categories = { Images: [], Audios: [], Videos: [], Documents: [], Scripts: [], Others: [] };
            const fileTypes = {
                Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
                Audios: ['mp3', 'wav', 'ogg', 'flac', 'm4a'],
                Videos: ['mp4', 'webm', 'mov'],
                Documents: ['pdf', 'md', 'txt', 'html', 'docx'],
                Scripts: ['js']
            };

            files.forEach(file => {
                const ext = file.split('.').pop().toLowerCase();
                let category = 'Others';
                for (const cat in fileTypes) {
                    if (fileTypes[cat].includes(ext)) {
                        category = cat;
                        break;
                    }
                }
                categories[category].push(file);
            });

            for (const category in categories) {
                if (categories[category].length > 0) {
                    const categoryTitle = document.createElement('h4');
                    categoryTitle.textContent = category;
                    categoryTitle.classList.add('attachment-category-title', 'collapsible');
                    
                    const gridContainer = document.createElement('div');
                    gridContainer.classList.add('attachment-grid');
                    
                    categoryTitle.addEventListener('click', () => {
                        gridContainer.classList.toggle('collapsed');
                        categoryTitle.classList.toggle('collapsed');
                    });

                    attachmentViewerEl.appendChild(categoryTitle);
                    
                    categories[category].forEach(file => {
                        const itemEl = document.createElement('div');
                        itemEl.classList.add('attachment-item');
                        const filePath = `${AppDataPath}UserData/attachments/${file}`;
                        const fileSrcPath = `../${filePath}`;

                        if (fileTypes.Images.includes(file.split('.').pop().toLowerCase())) {
                            itemEl.innerHTML = `<img src="${fileSrcPath}" alt="${file}"><div class="filename">${file}</div>`;
                        } else {
                            itemEl.innerHTML = `<span>${file}</span>`;
                        }
                        gridContainer.appendChild(itemEl);
                    });
                    attachmentViewerEl.appendChild(gridContainer);
                }
            }

        } catch (error) {
            attachmentViewerEl.innerHTML = `<p style="color: red;">Could not load attachments: ${error.message}</p>`;
        }
    }

    // --- Search Functionality ---
    function setupSearch() {
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                searchModalEl.style.display = 'flex';
                searchInputEl.focus();
            }
        });

        closeSearchModalBtn.addEventListener('click', () => {
            searchModalEl.style.display = 'none';
        });

        searchModalEl.addEventListener('click', (e) => {
            if (e.target === searchModalEl) {
                searchModalEl.style.display = 'none';
            }
        });

        searchInputEl.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                performSearch(searchInputEl.value);
            }
        });
    }

    async function performSearch(query) {
        if (!query || query.trim().length < 2) {
            searchResultsEl.innerHTML = '<p>Please enter at least 2 characters to search.</p>';
            searchResults = [];
            renderSearchResults();
            return;
        }

        searchResultsEl.innerHTML = '<p>Searching...</p>';
        const lowerCaseQuery = query.toLowerCase();
        let allFoundMessages = [];

        const historyPathsToFetch = [];

        // 1. Collect all history file paths
        const processItem = (item, type) => {
            if (item.topics && item.topics.length > 0) {
                item.topics.forEach(topic => {
                    historyPathsToFetch.push({
                        path: `${AppDataPath}UserData/${item.id}/topics/${topic.id}/history.json`,
                        context: {
                            itemId: item.id,
                            itemName: item.name,
                            itemType: type,
                            topicId: topic.id,
                            topicName: topic.name
                        }
                    });
                });
            }
        };

        Object.values(allAgents).forEach(agent => processItem(agent, 'agent'));
        Object.values(allGroups).forEach(group => processItem(group, 'group'));

        // 2. Fetch all histories concurrently
        const results = await Promise.all(
            historyPathsToFetch.map(async (file) => {
                try {
                    const historyStr = await window.api.readFile(file.path);
                    if (historyStr) {
                        return { history: JSON.parse(historyStr), context: file.context };
                    }
                } catch (e) {
                    // Ignore errors for non-existent history files
                }
                return null;
            })
        );

        // 3. Search within fetched histories
        results.filter(r => r !== null).forEach(result => {
            result.history.forEach(message => {
                const content = (typeof message.content === 'object' && message.content !== null && message.content.text)
                    ? message.content.text
                    : String(message.content);

                if (content.toLowerCase().includes(lowerCaseQuery)) {
                    allFoundMessages.push({
                        ...message,
                        context: result.context
                    });
                }
            });
        });
        
        searchResults = allFoundMessages.sort((a, b) => b.timestamp - a.timestamp); // Show newest first
        currentPage = 1;
        renderSearchResults();
    }

    function renderSearchResults() {
        searchResultsEl.innerHTML = '';
        searchPaginationEl.innerHTML = '';

        if (searchResults.length === 0) {
            searchResultsEl.innerHTML = '<p>No results found.</p>';
            return;
        }

        const startIndex = (currentPage - 1) * resultsPerPage;
        const endIndex = startIndex + resultsPerPage;
        const paginatedResults = searchResults.slice(startIndex, endIndex);

        paginatedResults.forEach(message => {
            const itemEl = document.createElement('div');
            itemEl.classList.add('search-result-item');
            itemEl.addEventListener('click', () => navigateToMessage(message));

            const contentText = (typeof message.content === 'object' && message.content !== null && message.content.text)
                ? message.content.text
                : String(message.content);
            
            const contextEl = document.createElement('div');
            contextEl.classList.add('context');
            contextEl.textContent = `${message.context.itemName} > ${message.context.topicName}`;

            const contentWrapperEl = document.createElement('div');
            contentWrapperEl.classList.add('content');

            const nameSpan = document.createElement('span');
            nameSpan.classList.add('name');
            nameSpan.textContent = `${message.name || message.role}: `;
            contentWrapperEl.appendChild(nameSpan);

            // To prevent rendering HTML, we create text nodes and strong elements separately
            const query = searchInputEl.value;
            if (query) {
                const parts = contentText.split(new RegExp(`(${query})`, 'gi'));
                parts.forEach(part => {
                    if (part && part.toLowerCase() === query.toLowerCase()) {
                        const strong = document.createElement('strong');
                        strong.textContent = part;
                        contentWrapperEl.appendChild(strong);
                    } else if (part) {
                        contentWrapperEl.appendChild(document.createTextNode(part));
                    }
                });
            } else {
                contentWrapperEl.appendChild(document.createTextNode(contentText));
            }

            itemEl.appendChild(contextEl);
            itemEl.appendChild(contentWrapperEl);
            searchResultsEl.appendChild(itemEl);
        });

        // Render pagination
        const totalPages = Math.ceil(searchResults.length / resultsPerPage);
        if (totalPages > 1) {
            const prevButton = document.createElement('button');
            prevButton.textContent = 'Previous';
            prevButton.classList.add('pagination-button');
            prevButton.disabled = currentPage === 1;
            prevButton.addEventListener('click', () => {
                if (currentPage > 1) {
                    currentPage--;
                    renderSearchResults();
                }
            });

            const nextButton = document.createElement('button');
            nextButton.textContent = 'Next';
            nextButton.classList.add('pagination-button');
            nextButton.disabled = currentPage === totalPages;
            nextButton.addEventListener('click', () => {
                if (currentPage < totalPages) {
                    currentPage++;
                    renderSearchResults();
                }
            });
            
            const pageInfo = document.createElement('span');
            pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
            pageInfo.style.margin = '0 10px';

            searchPaginationEl.appendChild(prevButton);
            searchPaginationEl.appendChild(pageInfo);
            searchPaginationEl.appendChild(nextButton);
        }
    }

    async function navigateToMessage(message) {
        // 1. Close search modal
        searchModalEl.style.display = 'none';

        // 2. Find and click the sidebar item
        const { itemId, itemType, topicId } = message.context;
        const sidebarItem = document.querySelector(`.sidebar-item[data-id='${itemId}'][data-type='${itemType}']`);
        
        if (!sidebarItem) {
            console.error('Could not find the sidebar item to navigate to.');
            alert('Error: Could not find the corresponding Agent/Group in the sidebar.');
            return;
        }
        
        // This will show the topics list
        sidebarItem.click();

        // 3. Load the specific chat history
        await loadChatHistory(itemId, topicId);

        // 4. Find the message element and highlight it
        const messageEl = chatHistoryEl.querySelector(`.message[data-message-id='${message.id}']`);

        if (messageEl) {
            // 5. Scroll to the message
            messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // 6. Add highlight class and remove it after a delay
            messageEl.classList.add('message-highlight');
            setTimeout(() => {
                messageEl.classList.remove('message-highlight');
            }, 2500); // Highlight for 2.5 seconds
        } else {
            console.warn(`Could not find message element with ID: ${message.id} after loading history.`);
        }
    }

    // --- Consistency Check Functions ---
    function setupConsistencyCheck() {
        const consistencyBtn = document.getElementById('consistency-check-btn');
        const consistencyModal = document.getElementById('consistency-modal');
        const closeConsistencyModal = document.getElementById('close-consistency-modal');
        const runCheckBtn = document.getElementById('run-check-btn');
        const applyFixesBtn = document.getElementById('apply-fixes-btn');

        consistencyBtn.addEventListener('click', () => {
            consistencyModal.style.display = 'flex';
        });

        closeConsistencyModal.addEventListener('click', () => {
            consistencyModal.style.display = 'none';
        });

        consistencyModal.addEventListener('click', (e) => {
            if (e.target === consistencyModal) {
                consistencyModal.style.display = 'none';
            }
        });

        runCheckBtn.addEventListener('click', async () => {
            await performConsistencyCheck();
        });

        applyFixesBtn.addEventListener('click', async () => {
            await applyConsistencyFixes();
        });
    }

    async function performConsistencyCheck() {
        const statusEl = document.getElementById('consistency-status');
        const resultsEl = document.getElementById('consistency-results');
        const summaryEl = document.getElementById('consistency-summary');
        const issuesListEl = document.getElementById('consistency-issues-list');
        const actionsEl = document.getElementById('consistency-actions');

        statusEl.innerHTML = '<p>🔍 Checking consistency... Please wait.</p>';
        resultsEl.style.display = 'none';

        try {
            // Initialize consistency checker
            consistencyChecker = new ConsistencyChecker(AppDataPath, window.api);
            
            // Perform check
            lastCheckResults = await consistencyChecker.performCheck(allAgents, allGroups);
            
            // Generate report
            const report = consistencyChecker.generateReport(lastCheckResults);
            
            // Display results
            statusEl.innerHTML = '';
            resultsEl.style.display = 'block';
            
            summaryEl.innerHTML = `<h4>${report.summary}</h4>`;
            
            if (lastCheckResults.totalIssues === 0) {
                issuesListEl.innerHTML = '<p style="color: green;">✓ All topic lists are consistent with chat history files.</p>';
                actionsEl.style.display = 'none';
            } else {
                // Display issues
                issuesListEl.innerHTML = '<h4>Issues Found:</h4>';
                const issuesList = document.createElement('div');
                issuesList.classList.add('issues-list');
                
                lastCheckResults.issues.forEach((issue, index) => {
                    const issueEl = document.createElement('div');
                    issueEl.classList.add('issue-item');
                    issueEl.dataset.issueIndex = index;
                    
                    const typeLabel = issue.itemType === 'orphaned_agent'
                        ? '🔧 ORPHANED AGENT'
                        : issue.itemType.toUpperCase();
                    let issueHtml = `
                        <div class="issue-header">
                            <input type="checkbox" class="issue-checkbox" data-index="${index}" checked>
                            <strong>[${typeLabel}] ${issue.itemName}</strong>
                        </div>
                        <div class="issue-details">
                            <p>${issue.message}</p>
                    `;
                    
                    if (issue.type === 'orphaned_files') {
                        issueHtml += '<ul class="topic-list">';
                        issue.orphanedTopics.forEach(topic => {
                            issueHtml += `<li>📁 ${topic.id} - ${topic.name} (${topic.messageCount} messages)</li>`;
                        });
                        issueHtml += '</ul>';
                    } else if (issue.type === 'missing_files') {
                        issueHtml += '<ul class="topic-list">';
                        issue.missingTopics.forEach(topic => {
                            issueHtml += `<li>❌ ${topic.id} - ${topic.name}</li>`;
                        });
                        issueHtml += '</ul>';
                    } else if (issue.type === 'missing_agent_config') {
                        const info = issue.recoveryInfo;
                        issueHtml += '<div class="recovery-details">';
                        issueHtml += `<p>🔍 <strong>Recovered agent name:</strong> ${info.agentName || 'Unknown'}</p>`;
                        issueHtml += `<p>📊 <strong>Total messages:</strong> ${info.totalMessages}</p>`;
                        if (info.oldestTimestamp) {
                            issueHtml += `<p>📅 <strong>Date range:</strong> ${new Date(info.oldestTimestamp).toLocaleDateString()} ~ ${info.newestTimestamp ? new Date(info.newestTimestamp).toLocaleDateString() : 'N/A'}</p>`;
                        }
                        if (info.model) {
                            issueHtml += `<p>🤖 <strong>Model used:</strong> ${info.model}</p>`;
                        }
                        issueHtml += '<ul class="topic-list">';
                        info.topics.forEach(topic => {
                            issueHtml += `<li>💬 ${topic.id} - ${topic.name} (${topic.messageCount} messages)</li>`;
                        });
                        issueHtml += '</ul>';
                        issueHtml += '</div>';
                    }
                    
                    issueHtml += '</div>';
                    issueEl.innerHTML = issueHtml;
                    issuesList.appendChild(issueEl);
                });
                
                issuesListEl.appendChild(issuesList);
                actionsEl.style.display = 'block';
            }
            
        } catch (error) {
            console.error('Error during consistency check:', error);
            statusEl.innerHTML = `<p style="color: red;">❌ Error during check: ${error.message}</p>`;
            resultsEl.style.display = 'none';
        }
    }

    async function applyConsistencyFixes() {
        const applyFixesBtn = document.getElementById('apply-fixes-btn');
        const addOrphaned = document.getElementById('fix-add-orphaned').checked;
        const removeMissing = document.getElementById('fix-remove-missing').checked;
        const recoverOrphanedAgents = document.getElementById('fix-recover-agents').checked;
        
        if (!lastCheckResults || lastCheckResults.totalIssues === 0) {
            alert('No issues to fix.');
            return;
        }
        
        // Get selected issues
        const checkboxes = document.querySelectorAll('.issue-checkbox:checked');
        const selectedIssues = Array.from(checkboxes).map(cb => {
            const index = parseInt(cb.dataset.index);
            return lastCheckResults.issues[index];
        });
        
        if (selectedIssues.length === 0) {
            alert('Please select at least one issue to fix.');
            return;
        }
        
        const hasOrphanedAgents = selectedIssues.some(i => i.type === 'missing_agent_config');
        const confirmMsg = `Apply fixes to ${selectedIssues.length} issue(s)?\n\n` +
            `Options:\n` +
            `- Add orphaned topics: ${addOrphaned ? 'YES' : 'NO'}\n` +
            `- Remove missing topics: ${removeMissing ? 'YES' : 'NO'}\n` +
            `- Recover orphaned agents: ${recoverOrphanedAgents ? 'YES' : 'NO'}\n` +
            (hasOrphanedAgents ? `\n⚠ This will CREATE new agent config files for recovered agents.\n` : '') +
            `\nThis will modify agent/group config files.`;
        
        if (!confirm(confirmMsg)) {
            return;
        }
        
        applyFixesBtn.disabled = true;
        applyFixesBtn.textContent = 'Applying fixes...';
        
        try {
            const results = await consistencyChecker.fixIssues(selectedIssues, {
                addOrphaned,
                removeMissing,
                recoverOrphanedAgents
            });
            
            // Show results
            let successCount = 0;
            let failCount = 0;
            let messages = [];
            
            results.forEach(result => {
                if (result.success) {
                    successCount++;
                    if (result.itemType === 'orphaned_agent' && result.modified) {
                        messages.push(`✓ Recovered agent "${result.recoveredName}" (${result.topicsCount} topics, ${result.totalMessages} messages)`);
                    } else if (result.modified) {
                        messages.push(`✓ ${result.itemType} ${result.itemId}: Updated (${result.topicsCount} topics)`);
                    } else {
                        messages.push(`○ ${result.itemType} ${result.itemId}: No changes needed`);
                    }
                } else {
                    failCount++;
                    messages.push(`✗ ${result.itemType} ${result.itemId}: ${result.error}`);
                }
            });
            
            alert(`Fixes applied!\n\nSuccess: ${successCount}\nFailed: ${failCount}\n\n${messages.join('\n')}`);
            
            // Reload data to reflect changes
            const data = await fetchData();
            if (data) {
                allAgents = data.agents;
                allGroups = data.groups;
                allSettings = data.settings;
                renderSidebar(data);
            }
            
            // Re-run check to show updated status
            await performConsistencyCheck();
            
        } catch (error) {
            console.error('Error applying fixes:', error);
            alert(`Error applying fixes: ${error.message}`);
        } finally {
            applyFixesBtn.disabled = false;
            applyFixesBtn.textContent = 'Apply Fixes';
        }
    }

    // --- Initialization ---
    async function initialize() {
        setupThemeToggle();
        setupResizer();
        setupSearch();
        setupConsistencyCheck();
        const data = await fetchData();
        if (data) {
            renderSidebar(data);
        }
    }

    initialize();
});