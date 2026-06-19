// modules/itemListManager.js

window.itemListManager = (() => {
    // --- Private Variables ---
    let itemListUl;
    let electronAPI;
    let currentSelectedItemRef;
    let mainRendererFunctions; // To call back into renderer.js for actions like selectItem
    let wasSelectionListenerActive = false; // To store the state of the selection listener before dragging
    let uiHelper;
    let activeLoadItemsToken = 0;

    const OPENHER_PERSONA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
    const OPENHER_PERSONA_CACHE_TTL_MS = 11 * 60 * 1000;
    const OPENHER_PERSONA_LABELS = Object.freeze({
        cognitive: {
            seek: '求知',
            discern: '分辨',
            reject: '拒绝',
            observe: '观测',
            infer: '推演',
            remember: '记忆'
        },
        drive: {
            curiosity: '好奇',
            fear: '恐惧',
            libido: '性欲',
            pleasure: '享乐',
            attachment: '依恋',
            control: '控制'
        },
        affective: {
            positive: '正性',
            negative: '负性',
            arousal: '唤醒'
        },
        subAxis: {
            loss_control: '失序',
            exposure: '暴露',
            novelty: '新奇',
            intimacy: '亲近',
            challenge: '挑战',
            comfort: '舒适',
            conflict: '冲突',
            ambiguity: '暧昧',
            safety: '安全',
            dominance: '支配',
            submission: '顺从'
        }
    });

    let personaStatusCache = {
        agents: [],
        fetchedAt: 0,
        pending: null,
        unavailable: false
    };
    let personaAutoRefreshTimer = null;

    /**
     * Initializes the ItemListManager module.
     * @param {object} config - The configuration object.
     * @param {object} config.elements - DOM elements.
     * @param {HTMLElement} config.elements.itemListUl - The <ul> element for the item list.
     * @param {object} config.electronAPI - The preloaded electron API.
     * @param {object} config.refs - References to shared state.
     * @param {object} config.refs.currentSelectedItemRef - A ref to the current selected item object.
     * @param {object} config.mainRendererFunctions - Functions from the main renderer.
     * @param {function} config.mainRendererFunctions.selectItem - Function to select an item.
     * @param {object} config.uiHelper - The UI helper functions object.
     */
    function init(config) {
        // Check for necessary configurations
        if (!config.elements || !config.elements.itemListUl) {
            console.error('[ItemListManager] Missing required DOM element: itemListUl.');
            return;
        }
        if (!config.electronAPI) {
            console.error('[ItemListManager] Missing required configuration: electronAPI.');
            return;
        }
        if (!config.refs || !config.refs.currentSelectedItemRef) {
            console.error('[ItemListManager] Missing required ref: currentSelectedItemRef.');
            return;
        }
        if (!config.mainRendererFunctions || typeof config.mainRendererFunctions.selectItem !== 'function') {
            console.error('[ItemListManager] Missing required main renderer function: selectItem.');
            return;
        }
        if (!config.uiHelper) {
            console.error('[ItemListManager] Missing required configuration: uiHelper.');
            return;
        }

        itemListUl = config.elements.itemListUl;
        electronAPI = config.electronAPI;
        currentSelectedItemRef = config.refs.currentSelectedItemRef;
        mainRendererFunctions = config.mainRendererFunctions;
        uiHelper = config.uiHelper; // Store uiHelper

        ensureOpenHerPersonaAutoRefresh();
        console.log('[ItemListManager] Initialized successfully.');
    }

    /**
     * Highlights the active item in the list.
     * @param {string} itemId - The ID of the item to highlight.
     * @param {string} itemType - The type of the item ('agent' or 'group').
     */
    function highlightActiveItem(itemId, itemType) {
        if (!itemListUl) return;
        document.querySelectorAll('#agentList li').forEach(item => {
            item.classList.toggle('active', item.dataset.itemId === itemId && item.dataset.itemType === itemType);
        });
    }

    /**
     * Initializes the SortableJS functionality for the item list.
     */
    function initializeItemSortable() {
        if (!itemListUl) {
            console.warn("[ItemListManager] itemListUl element not found. Skipping Sortable initialization.");
            return;
        }
        if (itemListUl.sortableInstance) {
            itemListUl.sortableInstance.destroy();
        }
        itemListUl.sortableInstance = new Sortable(itemListUl, {
            animation: 150,
            ghostClass: 'sortable-ghost-main',
            chosenClass: 'sortable-chosen-main',
            dragClass: 'sortable-drag-main',
            onStart: async function(evt) {
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

                const allListItems = Array.from(evt.to.children);
                const orderedItems = allListItems.map(item => ({
                    id: item.dataset.itemId,
                    type: item.dataset.itemType
                }));
                await saveItemOrder(orderedItems);
            }
        });
    }

    /**
     * Saves the new order of items to the settings file.
     * @param {Array<object>} orderedItemsWithTypes - An array of objects with id and type.
     */
    async function saveItemOrder(orderedItemsWithTypes) {
        console.log('[ItemListManager] Saving combined item order:', orderedItemsWithTypes);
        try {
            const result = await electronAPI.saveCombinedItemOrder(orderedItemsWithTypes);
            if (result && result.success) {
                // uiHelper.showToastNotification("项目顺序已保存。"); // Removed successful save notification
            } else {
                uiHelper.showToastNotification(`保存项目顺序失败: ${result?.error || '未知错误'}`, 'error');
                // Consider reloading items to revert to the last saved order if save failed
                // await loadItems();
            }
        } catch (error) {
            console.error('Error saving combined item order:', error);
            uiHelper.showToastNotification(`保存项目顺序出错: ${error.message}`, 'error');
        }
    }

    // To hold the loaded items in memory for quick access
    let loadedItemsCache = [];

    function escapeHtml(str) {
        return (str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function normalizePersonaMatchText(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/[^\p{L}\p{N}_-]/gu, '');
    }

    function stripVcpChatEndpoint(url) {
        const base = String(url || '').trim().replace(/\/v1\/chat\/completions\/?$/, '');
        return base ? `${base.replace(/\/+$/, '')}/` : '';
    }

    function resolveAxisLabel(groupName, key) {
        const group = OPENHER_PERSONA_LABELS[groupName] || {};
        return group[key] || key;
    }

    function toPercent(value) {
        const num = Number(value) || 0;
        return Math.round(Math.max(0, Math.min(1, num)) * 100);
    }

    function getMoodColor(mood = {}) {
        const positive = Number(mood.positive) || 0;
        const negative = Number(mood.negative) || 0;
        const arousal = Number(mood.arousal) || 0;
        const hue = Math.round(210 + (positive - negative) * 95 + arousal * 24);
        const saturation = Math.round(58 + arousal * 28);
        const lightness = Math.round(48 + positive * 12 - negative * 7);
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }

    function axisItems(axisState, groupName) {
        if (!axisState || typeof axisState !== 'object') return [];
        return Object.entries(axisState)
            .map(([key, value]) => ({
                key,
                label: resolveAxisLabel(groupName, key),
                value: Number(value?.value ?? value?.activation ?? 0) || 0,
                subAxes: value?.subAxes || {}
            }))
            .sort((a, b) => b.value - a.value);
    }

    function residualItems(state) {
        const groups = [
            ...axisItems(state?.drive, 'drive'),
            ...axisItems(state?.cognitive, 'cognitive'),
            ...axisItems(state?.affective, 'affective')
        ];

        return groups
            .flatMap(axis => Object.entries(axis.subAxes || {}).map(([subAxis, score]) => ({
                axis: axis.key,
                axisLabel: axis.label,
                subAxis,
                subAxisLabel: OPENHER_PERSONA_LABELS.subAxis[subAxis] || subAxis,
                weight: Number(score?.weight) || 0,
                similarity: Number(score?.similarity) || 0
            })))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, 5);
    }

    function createPersonaViewModel(rawAgent) {
        const summary = rawAgent?.summary || {};
        const state = rawAgent?.status?.state || rawAgent?.state || {};
        const mood = state.mood || {};
        const topCognitive = axisItems(state.cognitive, 'cognitive').slice(0, 2);
        const topDrive = axisItems(state.drive, 'drive').slice(0, 2);
        const residuals = residualItems(state);

        return {
            agentKey: summary.agentKey || state.agentKey || '',
            agentLabel: state.agentLabel || summary.agentLabel || summary.agentKey || 'Agent',
            moodLabel: mood.label || '暂无观测',
            modeLabel: rawAgent?.status?.mode || '纯异步观察',
            positive: Number(mood.positive) || 0,
            negative: Number(mood.negative) || 0,
            arousal: Number(mood.arousal) || 0,
            color: getMoodColor(mood),
            topCognitive,
            topDrive,
            residuals,
            observationCount: Number(summary.observationCount) || 0,
            updatedAt: summary.updatedAt || state.updatedAt || null,
            lastObservedAt: summary.lastObservedAt || state.lastObservedAt || state.lastObservation?.at || null
        };
    }

    function findPersonaForItem(item) {
        if (!item || item.type !== 'agent') {
            return null;
        }

        let matchedAgent = null;

        if (Array.isArray(personaStatusCache.agents) && personaStatusCache.agents.length > 0) {
            const itemKeys = [
                item.id,
                item.name,
                item.config?.name,
                item.config?.agentKey,
                item.config?.agentLabel
            ].map(normalizePersonaMatchText).filter(Boolean);

            if (itemKeys.length > 0) {
                let bestScore = 0;

                personaStatusCache.agents.forEach(rawAgent => {
                    const summary = rawAgent?.summary || {};
                    const state = rawAgent?.status?.state || rawAgent?.state || {};
                    const personaKeys = [
                        summary.agentKey,
                        summary.agentLabel,
                        state.agentKey,
                        state.agentLabel
                    ].map(normalizePersonaMatchText).filter(Boolean);

                    let score = 0;
                    itemKeys.forEach(itemKey => {
                        personaKeys.forEach(personaKey => {
                            if (!itemKey || !personaKey) return;
                            if (itemKey === personaKey) score = Math.max(score, 100);
                            else if (itemKey.includes(personaKey) || personaKey.includes(itemKey)) {
                                score = Math.max(score, Math.min(itemKey.length, personaKey.length));
                            }
                        });
                    });

                    if (score > bestScore) {
                        bestScore = score;
                        matchedAgent = rawAgent;
                    }
                });
            }
        }

        return matchedAgent ? createPersonaViewModel(matchedAgent) : null;
    }

    async function fetchOpenHerPersonaStatus({ force = false } = {}) {
        const now = Date.now();
        if (!force && personaStatusCache.agents.length && now - personaStatusCache.fetchedAt < OPENHER_PERSONA_CACHE_TTL_MS) {
            return personaStatusCache.agents;
        }

        if (personaStatusCache.pending) {
            return personaStatusCache.pending;
        }

        personaStatusCache.pending = (async () => {
            try {
                const settings = await electronAPI.loadSettings();
                const baseUrl = stripVcpChatEndpoint(settings?.vcpServerUrl);
                if (!baseUrl) throw new Error('VCP Server URL not configured');

                let username = settings?.adminUsername || '';
                let password = settings?.adminPassword || '';
                if ((!username || !password) && typeof electronAPI.loadForumConfig === 'function') {
                    const forumConfig = await electronAPI.loadForumConfig();
                    username = username || forumConfig?.username || '';
                    password = password || forumConfig?.password || '';
                }

                if (!username || !password) {
                    throw new Error('Admin credentials not configured');
                }

                const response = await fetch(`${baseUrl}admin_api/openher-persona/status`, {
                    headers: {
                        Authorization: `Basic ${btoa(`${username}:${password}`)}`,
                        Accept: 'application/json'
                    }
                });

                if (!response.ok) {
                    throw new Error(`OpenHerPersona status ${response.status}`);
                }

                const data = await response.json();
                personaStatusCache.agents = Array.isArray(data?.agents) ? data.agents : [];
                personaStatusCache.fetchedAt = Date.now();
                personaStatusCache.unavailable = false;
                updateVisiblePersonaCards();
                return personaStatusCache.agents;
            } catch (error) {
                personaStatusCache.unavailable = true;
                console.debug('[ItemListManager] OpenHerPersona status unavailable:', error?.message || error);
                return personaStatusCache.agents;
            } finally {
                personaStatusCache.pending = null;
            }
        })();

        return personaStatusCache.pending;
    }

    function ensureOpenHerPersonaAutoRefresh() {
        if (personaAutoRefreshTimer) return;
        fetchOpenHerPersonaStatus({ force: false });
        personaAutoRefreshTimer = setInterval(() => {
            fetchOpenHerPersonaStatus({ force: true });
        }, OPENHER_PERSONA_REFRESH_INTERVAL_MS);
    }

    function updateVisiblePersonaCards() {
        if (!itemListUl) return;
        itemListUl.querySelectorAll('li[data-item-type="agent"]').forEach(li => {
            const item = findItemById(li.dataset.itemId, li.dataset.itemType);
            hydratePersonaElement(li, item);
        });
    }

    function buildPersonaCard(persona) {
        const cognitive = persona.topCognitive.map(item => item.label);
        const drive = persona.topDrive.map(item => item.label);
        const headlineWords = [...cognitive, ...drive].slice(0, 4);
        const residuals = persona.residuals.slice(0, 4);

        const card = document.createElement('div');
        card.className = 'agent-emotion-card';
        card.style.setProperty('--agent-emotion-color', persona.color);
        card.setAttribute('aria-hidden', 'true');

        const chips = headlineWords.map((label, index) => (
            `<span class="agent-emotion-barrage agent-emotion-barrage-primary" style="--emotion-index:${index};--emotion-track:${index % 5};">${label}</span>`
        )).join('');

        const residualHtml = residuals.map((item, index) => {
            const absoluteIndex = index + headlineWords.length;
            return `<span class="agent-emotion-barrage agent-emotion-barrage-secondary" style="--emotion-index:${absoluteIndex};--emotion-track:${absoluteIndex % 5};">${item.axisLabel}/${item.subAxisLabel}</span>`;
        }).join('');

        card.innerHTML = `
            <div class="agent-emotion-title">
                <span class="agent-emotion-agent">${escapeHtml(persona.agentLabel)}</span>
                <span class="agent-emotion-mood">「${escapeHtml(persona.moodLabel)}」</span>
            </div>
            <div class="agent-emotion-metrics">
                <span>正性 ${toPercent(persona.positive)}%</span>
                <span>负性 ${toPercent(persona.negative)}%</span>
                <span>唤醒 ${toPercent(persona.arousal)}%</span>
            </div>
            <div class="agent-emotion-barrage-layer">${chips}${residualHtml}</div>
        `;

        return card;
    }

    function hydratePersonaElement(li, item) {
        if (!li || !item || item.type !== 'agent') return;

        const existing = li.querySelector('.agent-emotion-card');
        const persona = findPersonaForItem(item);

        if (!persona) {
            li.classList.toggle('has-agent-emotion', false);
            li.classList.toggle('agent-emotion-unavailable', personaStatusCache.unavailable);
            if (existing) existing.remove();
            return;
        }

        li.classList.add('has-agent-emotion');
        li.classList.remove('agent-emotion-unavailable');
        li.style.setProperty('--agent-emotion-color', persona.color);

        const nameSpan = li.querySelector('.agent-name');
        if (nameSpan) {
            nameSpan.dataset.defaultName = nameSpan.dataset.defaultName || nameSpan.textContent;
            nameSpan.dataset.emotionText = `${persona.agentLabel}正在「${persona.moodLabel}」`;
        }

        if (existing) existing.remove();
        li.appendChild(buildPersonaCard(persona));
    }

    function createItemElement(item) {
        const li = document.createElement('li');
        li.dataset.itemId = item.id;
        li.dataset.itemType = item.type;

        // 创建头像包装器
        const avatarWrapper = document.createElement('div');
        avatarWrapper.classList.add('avatar-wrapper');

        const avatarImg = document.createElement('img');
        avatarImg.classList.add('avatar');
        avatarImg.src = item.avatarUrl ? `${item.avatarUrl}${item.avatarUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : (item.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png');
        avatarImg.alt = `${item.name} 头像`;
        avatarImg.onerror = () => { avatarImg.src = (item.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png'); };

        // 将头像添加到包装器中
        avatarWrapper.appendChild(avatarImg);

        const nameSpan = document.createElement('span');
        nameSpan.classList.add('agent-name');
        nameSpan.textContent = item.name;
        if (item.type === 'group') {
            nameSpan.textContent += " (群)";
        }

        // 应用自定义样式（仅对agent类型）
        if (item.type === 'agent' && item.config) {
            // 只有在未禁用自定义颜色时才应用颜色设置
            if (!item.config.disableCustomColors) {
                // 应用头像边框颜色
                if (item.config.avatarBorderColor) {
                    avatarImg.style.borderColor = item.config.avatarBorderColor;
                }

                // 应用名称文字颜色
                if (item.config.nameTextColor) {
                    nameSpan.style.color = item.config.nameTextColor;
                }
            }
            // 注意：当disableCustomColors为true时，头像边框和名称颜色将使用主题默认值

            // 自定义CSS始终应用（不受disableCustomColors影响）
            if (item.config.customCss) {
                try {
                    // 解析并应用自定义CSS
                    const cssRules = item.config.customCss.split(';').filter(rule => rule.trim());
                    cssRules.forEach(rule => {
                        const [property, value] = rule.split(':').map(s => s.trim());
                        if (property && value) {
                            li.style.setProperty(property, value);
                        }
                    });
                } catch (error) {
                    console.warn(`[ItemListManager] Failed to apply custom CSS for agent ${item.id}:`, error);
                }
            }
        }

        li.appendChild(avatarWrapper);
        li.appendChild(nameSpan);
        hydratePersonaElement(li, item);

        // 为每个项目添加独立的状态管理
        li._lastClickTime = 0;
        li._middleClickHandled = false;

        // 添加鼠标事件监听器
        // 专门处理中键点击的辅助事件
        li.addEventListener('auxclick', (e) => {
            if (e.button === 1) { // 中键
                console.log('[ItemListManager] 检测到中键auxclick事件');
                e.preventDefault();
                e.stopPropagation();
                li._middleClickHandled = true;
                handleMiddleClick(item);
            }
        });

        // 普通点击事件（左键双击检测）
        li.addEventListener('click', (e) => {
            // 如果是中键点击，已经被auxclick处理了，直接返回
            if (li._middleClickHandled) {
                li._middleClickHandled = false;
                return;
            }

            const currentTime = Date.now();
            const timeDiff = currentTime - li._lastClickTime;

            if (e.button === 0 && timeDiff < 300) {
                // 双击 - 打开设置页面
                console.log('[ItemListManager] 检测到双击');
                e.preventDefault();
                e.stopPropagation();
                handleDoubleClick(item);
            } else if (e.button === 0) {
                // 普通左键点击 - 选择项目
                console.log('[ItemListManager] 普通左键点击');
                if (mainRendererFunctions && typeof mainRendererFunctions.selectItem === 'function') {
                    mainRendererFunctions.selectItem(item.id, item.type, item.name, item.avatarUrl, item.config || item);
                }
            }

            li._lastClickTime = currentTime;
        });

        // 防止中键点击的默认行为
        li.addEventListener('contextmenu', (e) => {
            // 不阻止右键菜单，但记录中键状态
            if (e.button === 1) {
                console.log('[ItemListManager] 中键contextmenu事件');
            }
        });

        return li;
    }

    function renderItems(items, fallbackHtml = null) {
        itemListUl.innerHTML = '';

        if (items.length === 0) {
            itemListUl.innerHTML = fallbackHtml || '<li>没有找到Agent或群组。请创建一个。</li>';
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach(item => {
            fragment.appendChild(createItemElement(item));
        });
        itemListUl.appendChild(fragment);

        const currentSelectedItem = currentSelectedItemRef.get();
        if (currentSelectedItem && currentSelectedItem.id) {
            highlightActiveItem(currentSelectedItem.id, currentSelectedItem.type);
        }

        if (typeof Sortable !== 'undefined') {
            initializeItemSortable();
        } else {
            console.warn('[ItemListManager] SortableJS library not found. Item list drag-and-drop ordering will not be available.');
        }
    }

    /**
     * Loads agents and groups, sorts them, and renders them in the list.
     */
    async function loadItems() {
        if (!itemListUl || !electronAPI) {
            console.error('[ItemListManager] Cannot load items. Module not initialized or missing dependencies.');
            return;
        }

        const loadToken = ++activeLoadItemsToken;
        const hadPreviousItems = loadedItemsCache.length > 0;

        if (!hadPreviousItems) {
            itemListUl.innerHTML = '<li><div class="loading-spinner-small"></div>加载列表中...</li>';
        }

        const agentsResult = await electronAPI.getAgents();
        const groupsResult = await electronAPI.getAgentGroups();

        if (loadToken !== activeLoadItemsToken) {
            console.debug('[ItemListManager] Ignoring stale loadItems result.');
            return;
        }

        let items = [];
        const errors = [];

        if (agentsResult && !agentsResult.error) {
            items.push(...agentsResult.map(a => ({ ...a, type: 'agent', id: a.id, avatarUrl: a.avatarUrl || 'assets/default_avatar.png' })));
        } else if (agentsResult && agentsResult.error) {
            errors.push(`加载Agent失败: ${agentsResult.error}`);
        }

        if (groupsResult && !groupsResult.error) {
            items.push(...groupsResult.map(g => ({ ...g, type: 'group', id: g.id, avatarUrl: g.avatarUrl || 'assets/default_group_avatar.png' })));
        } else if (groupsResult && groupsResult.error) {
            errors.push(`加载群组失败: ${groupsResult.error}`);
        }

        let combinedOrderFromSettings = [];
        try {
            const settings = await electronAPI.loadSettings();
            if (settings && settings.combinedItemOrder && Array.isArray(settings.combinedItemOrder)) {
                combinedOrderFromSettings = settings.combinedItemOrder;
            }
        } catch (e) {
            console.warn("[ItemListManager] Could not load combinedItemOrder from settings:", e);
        }

        if (combinedOrderFromSettings.length > 0 && items.length > 0) {
            const itemMap = new Map(items.map(item => [`${item.type}_${item.id}`, item]));
            const orderedItems = [];
            combinedOrderFromSettings.forEach(orderedItemInfo => {
                const key = `${orderedItemInfo.type}_${orderedItemInfo.id}`;
                if (itemMap.has(key)) {
                    orderedItems.push(itemMap.get(key));
                    itemMap.delete(key);
                }
            });
            orderedItems.push(...itemMap.values());
            items = orderedItems;
        } else {
            items.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'group' ? -1 : 1;
                }
                return (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
            });
        }

        if (items.length > 0) {
            loadedItemsCache = [...items]; // Cache the loaded items only when we have valid fresh data
            renderItems(items);
        } else if (errors.length > 0) {
            console.warn('[ItemListManager] Failed to fully reload items, preserving previous list where possible:', errors.join(' | '));
            if (!hadPreviousItems) {
                itemListUl.innerHTML = errors.map(error => `<li>${error}</li>`).join('');
            }
        } else {
            loadedItemsCache = [];
            renderItems([], '<li>没有找到Agent或群组。请创建一个。</li>');
        }

        fetchOpenHerPersonaStatus({ force: false }).then(() => updateVisiblePersonaCards());
        // Asynchronously fetch and update unread counts to avoid blocking initial render
        refreshUnreadCounts();
    }

    /**
     * 仅刷新未读计数，而不重新加载整个列表
     */
    function refreshUnreadCounts() {
        if (!electronAPI) return;
        electronAPI.getUnreadTopicCounts().then(result => {
            if (result && result.success) {
                updateUnreadBadges(result.counts);
            }
        }).catch(err => console.error('[ItemListManager] Failed to fetch unread counts:', err));
    }

    /**
     * 处理双击事件 - 打开设置页面
     * @param {object} item - 项目对象
     */
    function handleDoubleClick(item) {
        console.log('[ItemListManager] 双击项目:', item.name, '类型:', item.type);

        // 选择项目
        if (mainRendererFunctions && typeof mainRendererFunctions.selectItem === 'function') {
            mainRendererFunctions.selectItem(item.id, item.type, item.name, item.avatarUrl, item.config || item);
        }

        // 切换到设置页面 - 使用延时确保项目选择完成
        setTimeout(() => {
            try {
                // 方法1：尝试使用uiManager.switchToTab
                if (window.uiManager && typeof window.uiManager.switchToTab === 'function') {
                    console.log('[ItemListManager] 使用uiManager.switchToTab切换到设置页面');
                    window.uiManager.switchToTab('settings');
                } else {
                    // 方法2：直接操作DOM元素
                    console.log('[ItemListManager] uiManager不可用，直接操作DOM');

                    // 激活设置按钮
                    const settingsTabBtn = document.querySelector('.sidebar-tab-button[data-tab="settings"]');
                    if (settingsTabBtn) {
                        settingsTabBtn.click();
                        console.log('[ItemListManager] 直接点击设置按钮');
                    } else {
                        console.warn('[ItemListManager] 找不到设置按钮');

                        // 方法3：手动切换标签页显示
                        console.log('[ItemListManager] 尝试手动切换到设置标签页');

                        // 隐藏所有标签内容
                        document.querySelectorAll('.sidebar-tab-content').forEach(content => {
                            content.classList.remove('active');
                        });

                        // 显示设置标签内容
                        const settingsContent = document.getElementById('tabContentSettings');
                        if (settingsContent) {
                            settingsContent.classList.add('active');
                            console.log('[ItemListManager] 手动激活设置标签内容');
                        }

                        // 更新按钮状态
                        document.querySelectorAll('.sidebar-tab-button').forEach(btn => {
                            btn.classList.toggle('active', btn.dataset.tab === 'settings');
                        });
                    }
                }
            } catch (error) {
                console.error('[ItemListManager] 切换到设置页面时出错:', error);
            }
        }, 100); // 增加延时到100ms
    }

    /**
     * 处理中键点击事件 - 打开话题页面
     * @param {object} item - 项目对象
     */
    function handleMiddleClick(item) {
        console.log('[ItemListManager] 中键点击项目:', item.name, '类型:', item.type);

        // 选择项目
        if (mainRendererFunctions && typeof mainRendererFunctions.selectItem === 'function') {
            mainRendererFunctions.selectItem(item.id, item.type, item.name, item.avatarUrl, item.config || item);
        }

        // 切换到话题页面 - 使用延时确保项目选择完成
        setTimeout(() => {
            try {
                // 方法1：尝试使用uiManager.switchToTab
                if (window.uiManager && typeof window.uiManager.switchToTab === 'function') {
                    console.log('[ItemListManager] 使用uiManager.switchToTab切换到话题页面');
                    window.uiManager.switchToTab('topics');
                } else {
                    // 方法2：直接操作DOM元素
                    console.log('[ItemListManager] uiManager不可用，直接操作DOM');

                    // 激活话题按钮
                    const topicsTabBtn = document.querySelector('.sidebar-tab-button[data-tab="topics"]');
                    if (topicsTabBtn) {
                        topicsTabBtn.click();
                        console.log('[ItemListManager] 直接点击话题按钮');
                    } else {
                        console.warn('[ItemListManager] 找不到话题按钮');

                        // 方法3：手动切换标签页显示
                        console.log('[ItemListManager] 尝试手动切换标签页');

                        // 隐藏所有标签内容
                        document.querySelectorAll('.sidebar-tab-content').forEach(content => {
                            content.classList.remove('active');
                        });

                        // 显示话题标签内容
                        const topicsContent = document.getElementById('tabContentTopics');
                        if (topicsContent) {
                            topicsContent.classList.add('active');
                            console.log('[ItemListManager] 手动激活话题标签内容');
                        }

                        // 更新按钮状态
                        document.querySelectorAll('.sidebar-tab-button').forEach(btn => {
                            btn.classList.toggle('active', btn.dataset.tab === 'topics');
                        });
                    }
                }
            } catch (error) {
                console.error('[ItemListManager] 切换到话题页面时出错:', error);
            }
        }, 100); // 增加延时到100ms
    }

    /**
     * 重置鼠标事件状态，用于页面切换时清理状态
     */
    function resetMouseEventStates() {
        // 重置所有Agent项目的鼠标事件状态
        const agentItems = document.querySelectorAll('#agentList li');
        agentItems.forEach(item => {
            // 重置每个项目的鼠标事件状态（如果有的话）
            if (item._lastClickTime !== undefined) {
                item._lastClickTime = 0;
            }
            if (item._middleClickHandled !== undefined) {
                item._middleClickHandled = false;
            }
        });
        console.log('[ItemListManager] 鼠标事件状态已重置');
    }

    /**
     * Finds a loaded item by its ID and type from the cache.
     * @param {string} itemId - The ID of the item to find.
     * @param {string} itemType - The type of the item ('agent' or 'group').
     * @returns {object|null} The found item object or null.
     */
    function findItemById(itemId, itemType) {
        if (!loadedItemsCache || loadedItemsCache.length === 0) {
            console.warn('[ItemListManager] findItemById called before items were loaded or cache is empty.');
            return null;
        }
        return loadedItemsCache.find(item => item.id === itemId && item.type === itemType) || null;
    }

    /**
     * Updates the DOM with unread count badges.
     * @param {object} counts - An object mapping agentId to its unread count.
     */
    /**
     * Part C: 更新未读徽章显示
     * @param {object} counts - An object mapping agentId to its unread count.
     */
    function updateUnreadBadges(counts) {
        // 获取当前所有的列表项
        const listItems = itemListUl.querySelectorAll('li[data-item-type="agent"]');

        listItems.forEach(listItem => {
            const agentId = listItem.dataset.itemId;
            const count = counts[agentId];
            const avatarWrapper = listItem.querySelector('.avatar-wrapper');
            const existingBadge = listItem.querySelector('.unread-badge');

            // 检查是否需要显示徽章 (count 为数字且 >= 0)
            if (count !== undefined && (count > 0 || count === 0)) {
                const displayCount = count > 0 ? count.toString() : '';
                const isDotOnly = count === 0;

                if (existingBadge) {
                    // 徽章已存在，检查内容是否变化
                    const currentCount = existingBadge.textContent;
                    const currentIsDot = existingBadge.classList.contains('unread-badge-dot-only');

                    if (currentCount !== displayCount || currentIsDot !== isDotOnly) {
                        // 内容有变化，更新内容并触发动画
                        existingBadge.textContent = displayCount;
                        existingBadge.classList.toggle('unread-badge-dot-only', isDotOnly);

                        // 触发徽章更新动画
                        existingBadge.classList.remove('badge-appear');
                        void existingBadge.offsetWidth; // 强制重绘
                        existingBadge.classList.add('badge-appear');

                        // 触发头像动画
                        const avatarImg = avatarWrapper.querySelector('.avatar');
                        triggerAvatarAnimation(avatarImg);
                    }
                } else {
                    // 徽章不存在，创建新徽章
                    if (!avatarWrapper) return;

                    const unreadBadge = document.createElement('span');
                    unreadBadge.className = 'unread-badge';
                    if (isDotOnly) {
                        unreadBadge.classList.add('unread-badge-dot-only');
                    }
                    unreadBadge.textContent = displayCount;
                    unreadBadge.classList.add('badge-appear');

                    avatarWrapper.appendChild(unreadBadge);

                    // 触发头像动画
                    const avatarImg = avatarWrapper.querySelector('.avatar');
                    triggerAvatarAnimation(avatarImg);
                }
            } else {
                // 不需要显示徽章，如果存在则移除
                if (existingBadge) {
                    existingBadge.remove();
                }
            }
        });
    }

    /**
     * Part C: 触发头像缩放动画
     * @param {HTMLElement} avatarElement - 头像元素
     */
    function triggerAvatarAnimation(avatarElement) {
        if (!avatarElement) return;

        // 移除可能存在的动画类
        avatarElement.classList.remove('avatar-animate');

        // 强制重绘
        void avatarElement.offsetWidth;

        // 添加动画类
        avatarElement.classList.add('avatar-animate');

        // 动画结束后移除类，以便下次可以再次触发
        setTimeout(() => {
            avatarElement.classList.remove('avatar-animate');
        }, 600); // 与动画持续时间一致
    }

    function updateLoadedItemConfig(itemId, itemType, partialConfig) {
        if (!itemId || !itemType || !partialConfig || typeof partialConfig !== 'object') {
            return false;
        }

        const matchedItem = loadedItemsCache.find(item => item.id === itemId && item.type === itemType);
        if (!matchedItem) {
            return false;
        }

        matchedItem.config = {
            ...(matchedItem.config || {}),
            ...partialConfig
        };

        return true;
    }

    // --- Public API ---
    return {
        init,
        loadItems,
        highlightActiveItem,
        resetMouseEventStates,
        findItemById, // Expose the new function
        updateLoadedItemConfig,
        updateUnreadBadges, // Part C: 暴露更新徽章函数供外部调用
        refreshUnreadCounts
    };
})();
