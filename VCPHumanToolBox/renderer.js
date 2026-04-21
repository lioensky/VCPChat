// VCPHumanToolBox/renderer.js
// Enhanced by CodeCC &赵枫 - 2026-04-21
// 8features: search+filter, hide maid, param folding, timer, retry, copy, form cache, history
import { tools } from './renderer_modules/config.js';
import * as canvasHandler from './renderer_modules/ui/canvas-handler.js';
import * as dynamicImageHandler from './renderer_modules/ui/dynamic-image-handler.js';

document.addEventListener('DOMContentLoaded', async () => {
    // --- 元素获取 ---
    const toolGrid = document.getElementById('tool-grid');
    const toolDetailView = document.getElementById('tool-detail-view');
    const backToGridBtn = document.getElementById('back-to-grid-btn');
    const toolTitle = document.getElementById('tool-title');
    const toolDescription = document.getElementById('tool-description');
    const toolForm = document.getElementById('tool-form');
    const resultContainer = document.getElementById('result-container');

    // --- 全局变量 ---
    let VCP_SERVER_URL = '';
    let VCP_API_KEY = '';
    let USER_NAME = 'Human';
    let settings = {};
    let MAX_FILENAME_LENGTH = 400;
    let currentToolName = '';
    const formStateCache = new Map();
    const executionHistory = [];

    // --- 工具分类映射 ---
    const TOOL_CATEGORIES = {
        '多媒体生成': ['ZImageGen','FluxGen','DoubaoGen','QwenImageGen',
            'GeminiImageGen','NovelAIGen','ComfyCloudGen','SunoGen',
            'WanVideoGen','GrokVideoGen','WebUIGen','ComfyUIGen','NanoBananaGen2'],
        '联网搜索': ['VSearch','TavilySearch','GoogleSearch','SerpSearch',
            'UrlFetch','BilibiliFetch','FlashDeepSearch','AnimeFinder'],
        '代码与仓库': ['GitSearch','DeepWikiVCP'],
        '学术研究': ['PubMedSearch','PaperReader'],
        '记忆与思考': ['DeepMemo','LightMemo','ThoughtClusterManager',
            'TopicMemo','AgentTopicCreator'],
        '通讯与社区': ['AgentAssistant','AgentDream','AgentMessage','VCPForum'],
        '占卜与趣味': ['TarotDivination'],
        '工具与计算': ['SciCalculator','MusicController','VCPAlarm','TableLampRemote'],
        '文件管理': ['LocalSearchController','ServerSearchController',
            'PowerShellExecutor','ServerPowerShellExecutor',
            'CodeSearcher','ServerCodeSearcher'],
        '日程管理': ['ScheduleManager']
    };

    function getCategoryForTool(toolName) {
        for (const [cat, list] of Object.entries(TOOL_CATEGORIES)) {
            if (list.includes(toolName)) return cat;
        }
        return '其他';
    }

    // --- 设置加载与保存 ---
    async function loadSettings() {
        try {
            settings = await window.electronAPI.invoke('vcp-ht-get-settings');
        } catch (error) {
            console.error('Failed to load settings:', error);
            settings = {};
        }
    }

    async function saveSettings() {
        try {
            const result = await window.electronAPI.invoke('vcp-ht-save-settings', settings);
            if (!result.success) {
                throw new Error(result.error);
            }
            console.log('[VCPHumanToolBox] Settings saved successfully');
        } catch (error) {
            console.error('[VCPHumanToolBox] Failed to save settings:', error);throw error;
        }
    }

    // --- 初始化应用程序 ---
    async function initializeApp() {
        await loadSettings();

        if (settings.vcpServerUrl) {
            try {
                const url = new URL(settings.vcpServerUrl);
                url.pathname = '/v1/human/tool';
                VCP_SERVER_URL = url.toString();
            } catch (e) {
                console.error("Invalid vcpServerUrl in settings:", settings.vcpServerUrl);
            }
        }VCP_API_KEY = settings.vcpApiKey || '';
        USER_NAME = settings.userName || 'Human';
        MAX_FILENAME_LENGTH = settings.maxFilenameLength || 400;
    // 恢复执行历史
        if (Array.isArray(settings.vcpht_executionHistory)) {
            executionHistory.push(...settings.vcpht_executionHistory.slice(0, 15));
        }
        
        canvasHandler.setMaxFilenameLength(MAX_FILENAME_LENGTH);

        if (!VCP_SERVER_URL || !VCP_API_KEY) {
            toolGrid.innerHTML = `<div class="info-box"><p><strong>错误：无法加载配置文件 (settings.json)。请确保文件存在且格式正确。</strong></p><p>未能从settings.json 中找到 vcpServerUrl 或 vcpApiKey</p></div>`;
            return;
        }

        initializeUI();
    }

    // --- 函数定义 ---

    function renderToolGrid() {
        toolGrid.innerHTML = '';

        // 读取收藏列表
        let favorites = [];
        try {
            favorites = JSON.parse(localStorage.getItem('vcpht_favorites') || '[]');
        } catch (e) { favorites = []; }

        //搜索栏容器
        const searchBar = document.createElement('div');
        searchBar.className = 'tool-search-bar';
        searchBar.style.cssText = `
            display: flex; gap: 10px; margin-bottom: 20px; align-items: center;
            grid-column: 1 / -1;
        `;

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = '🔍 搜索工具...';
        searchInput.className = 'tool-search-input';
        searchInput.style.cssText = `
            flex: 1; padding: 10px 14px; border-radius: 8px;
            border: 1px solid var(--border-color);
            background: var(--input-bg); color: var(--primary-text);
            font-size: 14px; outline: none; transition: border-color 0.2s;
        `;

        const categorySelect = document.createElement('select');
        categorySelect.className = 'tool-category-select';
        categorySelect.style.cssText = `
            padding: 10px 14px; border-radius: 8px;
            border: 1px solid var(--border-color);
            background: var(--input-bg); color: var(--primary-text);
            font-size: 14px; cursor: pointer; min-width: 140px;
        `;
        const allOption = document.createElement('option');
        allOption.value = '';
        allOption.textContent = '全部分类';
        categorySelect.appendChild(allOption);

        // 收藏选项
        const favOption = document.createElement('option');
        favOption.value = '__favorites__';
        favOption.textContent = '⭐ 收藏';
        categorySelect.appendChild(favOption);

        for (const cat of Object.keys(TOOL_CATEGORIES)) {
            const opt = document.createElement('option');
            opt.value = cat;
            opt.textContent = cat;
            categorySelect.appendChild(opt);
        }

        const countBadge = document.createElement('span');
        countBadge.className = 'tool-count-badge';
        countBadge.style.cssText = `
            padding: 6px 12px; border-radius: 20px; font-size: 12px;
            background: rgba(255,152,0,0.15); color: var(--highlight-text);
            white-space: nowrap; font-weight: 600;
        `;
        const totalTools = Object.keys(tools).length;
        countBadge.textContent = `共${totalTools} 个`;

        searchBar.appendChild(searchInput);
        searchBar.appendChild(categorySelect);
        searchBar.appendChild(countBadge);
        toolGrid.appendChild(searchBar);

        // 生成工具卡片
        for (const toolName in tools) {
            const tool = tools[toolName];
            const category = getCategoryForTool(toolName);
            const isFav = favorites.includes(toolName);

            const card = document.createElement('div');
            card.className = 'tool-card';
            card.dataset.toolName = toolName;
            card.dataset.category = category;
            card.dataset.search = `${toolName} ${tool.displayName} ${tool.description} ${category}`.toLowerCase();

            card.innerHTML = `
                <div style="position: relative;">
                    <span class="fav-star" data-tool="${toolName}" style="
                        position: absolute; top: -8px; right: -8px;
                        font-size: 18px; cursor: pointer; z-index: 2;
                        filter: ${isFav ? 'none' : 'grayscale(1) opacity(0.3)'};
                        transition: all 0.2s;
                    ">${isFav ? '★' : '☆'}</span>
                    <h3>${tool.displayName}</h3>
                    <p>${tool.description}</p>
                    <span style="display:inline-block; margin-top:8px; padding:2px 8px; border-radius:10px; font-size:11px; background:rgba(255,152,0,0.1); color:var(--highlight-text);">${category}</span>
                </div>
            `;

            //卡片点击 → 进入工具
            card.addEventListener('click', (e) => {
                if (e.target.classList.contains('fav-star')) return;
                showToolDetail(toolName);
            });

            // 星星点击 → 切换收藏
            const star = card.querySelector('.fav-star');
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                let favs = [];
                try { favs = JSON.parse(localStorage.getItem('vcpht_favorites') || '[]'); } catch(err) { favs = []; }

                const idx = favs.indexOf(toolName);
                if (idx >= 0) {
                    favs.splice(idx, 1);
                    star.textContent = '☆';
                    star.style.filter = 'grayscale(1) opacity(0.3)';
                } else {
                    favs.push(toolName);
                    star.textContent = '★';
                    star.style.filter = 'none';
                }
                localStorage.setItem('vcpht_favorites', JSON.stringify(favs));// 如果当前在收藏筛选模式，重新过滤
                if (categorySelect.value === '__favorites__') {
                    filterCards();
                }
            });

            // 星星hover效果
            star.addEventListener('mouseenter', () => {
                if (star.style.filter.includes('grayscale')) {
                    star.style.filter = 'grayscale(0) opacity(0.7)';
                }
            });
            star.addEventListener('mouseleave', () => {
                const currentFavs = JSON.parse(localStorage.getItem('vcpht_favorites') || '[]');
                if (!currentFavs.includes(toolName)) {
                    star.style.filter = 'grayscale(1) opacity(0.3)';
                }
            });

            toolGrid.appendChild(card);
        }

        // 搜索与筛选逻辑
        function filterCards() {
            const query = searchInput.value.toLowerCase().trim();
            const selectedCat = categorySelect.value;
            const cards = toolGrid.querySelectorAll('.tool-card');
            let visibleCount = 0;

            // 收藏模式需要实时读取
            let currentFavs = [];
            if (selectedCat === '__favorites__') {
                try { currentFavs = JSON.parse(localStorage.getItem('vcpht_favorites') || '[]'); } catch(e) { currentFavs = []; }
            }

            cards.forEach(card => {
                const matchSearch = !query || card.dataset.search.includes(query);
                let matchCat;
                if (selectedCat === '__favorites__') {
                    matchCat = currentFavs.includes(card.dataset.toolName);
                } else {
                    matchCat = !selectedCat || card.dataset.category === selectedCat;
                }

                if (matchSearch && matchCat) {
                    card.style.display = '';visibleCount++;
                } else {
                    card.style.display = 'none';
                }
            });

            countBadge.textContent = query || selectedCat
                ? `匹配 ${visibleCount} / ${totalTools}`
                : `共 ${totalTools} 个`;
        }

        searchInput.addEventListener('input', filterCards);
        categorySelect.addEventListener('change', filterCards);
    }

    function showToolDetail(toolName) {
        // 保存当前表单状态
        if (currentToolName) {
            saveFormState(currentToolName);
        }
        currentToolName = toolName;

        const tool = tools[toolName];
        toolTitle.textContent = tool.displayName;
        toolDescription.textContent = tool.description;
        
        buildToolForm(toolName);

        toolGrid.style.display = 'none';
        toolDetailView.style.display = 'block';
        resultContainer.innerHTML = '';
        renderHistory();
    }

    // --- 表单状态缓存 ---
    function saveFormState(toolName) {
        if (!toolForm) return;
        const state = {};
        const inputs = toolForm.querySelectorAll('input, textarea, select');
        inputs.forEach(el => {
            if (!el.name) return;
            //跳过dragdrop类型和文件输入
            if (el.closest('.dragdrop-image-container')) return;
            if (el.type === 'file') return;
            if (el.type === 'checkbox' || el.type === 'radio') {
                state[el.name + (el.type === 'radio' ? '_' + el.value : '')] = el.checked;
            } else {
                state[el.name] = el.value;
            }
        });
        formStateCache.set(toolName, state);
    }

    function restoreFormState(toolName) {
        const state = formStateCache.get(toolName);
        if (!state) return;
        const inputs = toolForm.querySelectorAll('input, textarea, select');
        inputs.forEach(el => {
            if (!el.name) return;
            if (el.closest('.dragdrop-image-container')) return;
            if (el.type === 'checkbox') {
                if (state[el.name] !== undefined) el.checked = state[el.name];
            } else if (el.type === 'radio') {
                const key = el.name + '_' + el.value;
                if (state[key] !== undefined) el.checked = state[key];
            } else {
                if (state[el.name] !== undefined) el.value = state[el.name];
            }
        });
    }

    function buildToolForm(toolName) {
        const tool = tools[toolName];
        toolForm.innerHTML = '';
        const paramsContainer = document.createElement('div');
        paramsContainer.id = 'params-container';

        if (tool.commands) {
            const commandSelectGroup = document.createElement('div');
            commandSelectGroup.className = 'form-group';
            commandSelectGroup.innerHTML = `<label>选择操作 (Command):</label>`;
            const commandSelect = document.createElement('select');
            commandSelect.id = 'command-select';
            commandSelect.name = 'command';
            
            for (const commandName in tool.commands) {
                const option = document.createElement('option');
                option.value = commandName;
                option.textContent = `${commandName} - ${tool.commands[commandName].description}`;
                commandSelect.appendChild(option);
            }
            commandSelectGroup.appendChild(commandSelect);
            toolForm.appendChild(commandSelectGroup);
            toolForm.appendChild(paramsContainer);

            commandSelect.addEventListener('change', (e) => {
                renderFormParams(tool.commands[e.target.value].params, paramsContainer, toolName, e.target.value);
            });renderFormParams(tool.commands[commandSelect.value].params, paramsContainer, toolName, commandSelect.value);} else {
            toolForm.appendChild(paramsContainer);renderFormParams(tool.params, paramsContainer, toolName);
        }

        // 添加按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 10px; margin-top: 15px; flex-wrap: wrap;';
        
        const submitButton = document.createElement('button');
        submitButton.type = 'submit';
        submitButton.textContent = '执行';
        submitButton.style.cssText = `
            background-color: var(--success-color);
            color: var(--text-on-accent);
            border: none;
            padding: 12px 25px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            transition: background-color 0.2s;`;
        buttonContainer.appendChild(submitButton);
        
        // 添加全部清空按钮
        const clearAllButton = document.createElement('button');
        clearAllButton.type = 'button';
        clearAllButton.innerHTML = '🗑️ 全部清空';
        clearAllButton.style.cssText = `
            background-color: var(--warning-color, #f59e0b);
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
        `;
        
        clearAllButton.addEventListener('click', () => {
            clearAllFormData(toolName);
        });
        
        buttonContainer.appendChild(clearAllButton);

        // 为ComfyUI 工具添加设置按钮
        if (toolName === 'ComfyUIGen') {
            const settingsButton = document.createElement('button');
            settingsButton.type = 'button';
            settingsButton.textContent = '⚙️ 设置';
            settingsButton.className = 'back-btn';
            settingsButton.style.cssText = 'margin-left: auto;';
            settingsButton.addEventListener('click', () => openComfyUISettings());
            buttonContainer.appendChild(settingsButton);
        }
        
        // 为 NanoBananaGen 工具添加文件名设置按钮
        if (toolName === 'NanoBananaGen') {
            const filenameSettingsButton = document.createElement('button');
            filenameSettingsButton.type = 'button';
            filenameSettingsButton.innerHTML = '⚙️ 设置';
            filenameSettingsButton.style.cssText = `
                background-color: var(--secondary-color, #6b7280);
                color: white;
                border: none;
                padding: 12px 20px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s;
            `;
            
            filenameSettingsButton.addEventListener('click', () => {
                showFilenameSettings();
            });
            
            buttonContainer.appendChild(filenameSettingsButton);
        }

        toolForm.appendChild(buttonContainer);

        toolForm.onsubmit = (e) => {
            e.preventDefault();
            executeTool(toolName);
        };

        // 恢复缓存的表单状态
        setTimeout(() => restoreFormState(toolName), 0);
    }

    function renderFormParams(params, container, toolName = '', commandName = '') {
        container.innerHTML = '';
        const dependencyListeners = [];

        const isNanoBananaCompose = toolName === 'NanoBananaGen' && commandName === 'compose';

        // 分离必填和可选参数
        const requiredParams = [];
        const optionalParams = [];
        params.forEach(param => {
            if (param.name === 'maid') return; // 隐藏maid字段
            if (param.required) {
                requiredParams.push(param);
            } else {
                optionalParams.push(param);
            }
        });

        //渲染必填参数
        requiredParams.forEach(param => {
            const el = createParamElement(param, dependencyListeners, toolName);
            container.appendChild(el);
        });

        // 渲染可选参数（折叠）
        if (optionalParams.length > 0) {
            const details = document.createElement('details');
            details.className = 'optional-params-group';
            details.style.cssText = `
                margin-top: 10px; border: 1px solid var(--border-color);
                border-radius: 8px; overflow: hidden;
            `;
            const summary = document.createElement('summary');
            summary.style.cssText = `
                padding: 10px 14px; cursor: pointer;
                background: rgba(255,255,255,0.03);
                color: var(--secondary-text); font-size: 14px;
                user-select: none;
            `;
            summary.textContent = `高级选项 (${optionalParams.length} 项)`;
            details.appendChild(summary);

            const optContainer = document.createElement('div');
            optContainer.style.cssText = 'padding: 10px 14px;';
            optionalParams.forEach(param => {
                const el = createParamElement(param, dependencyListeners, toolName);
                optContainer.appendChild(el);
            });
            details.appendChild(optContainer);
            container.appendChild(details);
        }

        if (isNanoBananaCompose) {
            dynamicImageHandler.createDynamicImageContainer(container);
        }

        dependencyListeners.forEach(listener => listener());
    }

    //提取的单参数渲染函数
    function createParamElement(param, dependencyListeners, toolName) {
        const paramGroup = document.createElement('div');
        paramGroup.className = 'form-group';
        
        let labelText = param.description || param.name;
        const label = document.createElement('label');
        label.textContent = `${labelText}${param.required ? ' *' : ''}`;
        
        let input;
        if (param.type === 'textarea') {
            input = document.createElement('textarea');
        } else if (param.type === 'select') {
            input = document.createElement('select');param.options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.textContent = opt || `(${param.name})`;
                input.appendChild(option);
            });
        } else if (param.type === 'radio') {
            input = document.createElement('div');
            input.className = 'radio-group';
            param.options.forEach(opt => {
                const radioLabel = document.createElement('label');
                const radioInput = document.createElement('input');
                radioInput.type = 'radio';
                radioInput.name = param.name;
                radioInput.value = opt;
                if (opt === param.default) radioInput.checked = true;
                radioLabel.appendChild(radioInput);
                radioLabel.append(` ${opt}`);
                input.appendChild(radioLabel);

                radioInput.addEventListener('change', () => {
                    dependencyListeners.forEach(listener => listener());
                });
            });
        } else if (param.type === 'dragdrop_image') {
            input = canvasHandler.createDragDropImageInput(param);
        } else if (param.type === 'checkbox') {
            input = document.createElement('div');
            input.className = 'checkbox-group';
            
            const checkboxLabel = document.createElement('label');
            checkboxLabel.className = 'checkbox-label';
            checkboxLabel.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;margin-top: 5px;
            `;
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = param.name;
            checkbox.checked = param.default || false;
            
            const checkboxText = document.createElement('span');
            checkboxText.textContent = param.description || param.name;
            
            checkboxLabel.appendChild(checkbox);
            checkboxLabel.appendChild(checkboxText);
            input.appendChild(checkboxLabel);
            
            if (param.name === 'enable_translation') {
                const translationContainer = createTranslationContainer(param.name);
                input.appendChild(translationContainer);
                
                checkbox.addEventListener('change', (e) => {
                    const container = input.querySelector('.translation-container');
                    if (container) {
                        container.style.display = e.target.checked ? 'block' : 'none';
                    }
                });
            }
        } else {
            input = document.createElement('input');
            input.type = param.type || 'text';
            if (input.type === 'number') {
                if (param.min !== undefined) input.min = param.min;
                if (param.max !== undefined) input.max = param.max;
                input.step = param.step || 'any';
            }}
        
        if (input.tagName !== 'DIV' || param.type === 'dragdrop_image') {
            input.name = param.name;
            if (param.type !== 'dragdrop_image') {
                input.placeholder = param.placeholder || '';
                if (param.default) input.value = param.default;
            }
            if (param.required) input.required = true;
        } else {
            const hiddenInput = document.createElement('input');
            hiddenInput.type = 'hidden';
            hiddenInput.name = param.name;
            paramGroup.appendChild(hiddenInput);}

        paramGroup.appendChild(label);
        paramGroup.appendChild(input);

        if (param.dependsOn) {
            const dependencyCheck = () => {
                const dependencyField = toolForm.querySelector(`[name="${param.dependsOn.field}"]:checked`) || toolForm.querySelector(`[name="${param.dependsOn.field}"]`);
                if (dependencyField && dependencyField.value === param.dependsOn.value) {
                    paramGroup.style.display = '';
                } else {
                    paramGroup.style.display = 'none';
                }
            };
            dependencyListeners.push(dependencyCheck);}

        return paramGroup;
    }
    function createTranslationContainer(paramName) {
        const container = document.createElement('div');
        container.className = 'translation-container';
        container.style.cssText = `
            display: none;
            margin-top: 10px;
            padding: 15px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background: rgba(59, 130, 246, 0.05);
        `;
        
        const settingsArea = document.createElement('div');
        settingsArea.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
            align-items: center;
            flex-wrap: wrap;
        `;
        
        const qualityLabel = document.createElement('label');
        qualityLabel.textContent = '质量：';
        qualityLabel.style.cssText = `
            font-weight: bold;
            color: var(--secondary-text);
            font-size: 14px;
        `;
        
        const qualitySelect = document.createElement('select');
        qualitySelect.className = 'translation-quality-select';
        qualitySelect.innerHTML = `
            <option value="gemini-2.5-flash">快速</option>
            <option value="gemini-2.0-flash" selected>均衡</option>
            <option value="gpt-4o">质量</option>
        `;
        qualitySelect.style.cssText = `
            padding: 6px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--primary-text);
        `;
        
        const languageLabel = document.createElement('label');
        languageLabel.textContent = '目标语言：';
        languageLabel.style.cssText = `
            font-weight: bold;
            color: var(--secondary-text);
            font-size: 14px;
        `;
        
        const languageSelect = document.createElement('select');
        languageSelect.className = 'translation-language-select';
        languageSelect.innerHTML = `
            <option value="en" selected>英语</option>
            <option value="zh">中文</option>
            <option value="ja">日语</option>
            <option value="ko">韩语</option>
            <option value="fr">法语</option>
            <option value="de">德语</option>
            <option value="es">西班牙语</option>
        `;
        languageSelect.style.cssText = `
            padding: 6px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--primary-text);
        `;
        
        settingsArea.appendChild(qualityLabel);
        settingsArea.appendChild(qualitySelect);
        settingsArea.appendChild(languageLabel);
        settingsArea.appendChild(languageSelect);
        
        const translatedPromptLabel = document.createElement('label');
        translatedPromptLabel.textContent = '翻译后的提示词：';
        translatedPromptLabel.style.cssText = `
            display: block;
            margin-bottom: 8px;
            font-weight: bold;
            color: var(--secondary-text);
        `;
        
        const translatedPromptArea = document.createElement('textarea');
        translatedPromptArea.className = 'translated-prompt';
        translatedPromptArea.placeholder = '翻译结果将显示在这里…';
        translatedPromptArea.readOnly = false;
        translatedPromptArea.style.cssText = `
            width: 100%;
            min-height: 80px;
            padding: 10px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--primary-text);
            font-family: inherit;
            resize: vertical;
            box-sizing: border-box;
        `;
        
        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = `
            display: flex;
            gap: 10px;
            margin-top: 10px;
        `;
        
        const translateButton = document.createElement('button');
        translateButton.type = 'button';
        translateButton.innerHTML = '🌍 翻译';
        translateButton.style.cssText = `
            background: var(--primary-color);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;`;
        
        const useOriginalButton = document.createElement('button');
        useOriginalButton.type = 'button';
        useOriginalButton.innerHTML = '⬅️ 使用原文';
        useOriginalButton.style.cssText = `
            background: var(--warning-color, #f59e0b);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;
        
        translateButton.addEventListener('click', async () => {
            const promptTextarea = toolForm.querySelector('textarea[name="prompt"]');
            if (promptTextarea && promptTextarea.value.trim()) {
                const quality = qualitySelect.value;
                const targetLang = languageSelect.value;
                await translatePrompt(promptTextarea.value, translatedPromptArea, translateButton, quality, targetLang);
            } else {
                alert('请先输入提示词');
            }
        });
        
        useOriginalButton.addEventListener('click', () => {
            const promptTextarea = toolForm.querySelector('textarea[name="prompt"]');
            if (promptTextarea) {
                translatedPromptArea.value = promptTextarea.value;
            }
        });
        
        buttonGroup.appendChild(translateButton);
        buttonGroup.appendChild(useOriginalButton);
        
        container.appendChild(settingsArea);
        container.appendChild(translatedPromptLabel);
        container.appendChild(translatedPromptArea);
        container.appendChild(buttonGroup);
        
        return container;
    }

    // 翻译提示词
    async function translatePrompt(text, outputTextarea, button, quality = 'gemini-2.5-flash', targetLang = 'en') {
        const originalText = button.innerHTML;
        button.innerHTML = '🔄 翻译中...';
        button.disabled = true;
        
        try {
            const languageMap = {
                'en': '英语',
                'zh': '中文', 
                'ja': '日语',
                'ko': '韩语',
                'fr': '法语',
                'de': '德语',
                'es': '西班牙语'
            };
            
            const targetLanguageText = languageMap[targetLang] || '英语';
            const systemPrompt = `你是一个专业的翻译助手。请将用户提供的文本翻译成${targetLanguageText}。 仅返回翻译结果，不要包含任何解释或额外信息。`;
            
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ];
            
            const chatUrl = VCP_SERVER_URL.replace('/v1/human/tool', '/v1/chat/completions');
            const response = await fetch(chatUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VCP_API_KEY}`
                },
                body: JSON.stringify({
                    messages: messages,
                    model: quality,
                    temperature: 0.7,
                    max_tokens: 50000,
                    stream: false
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`服务器错误: ${response.status} ${response.statusText} - ${errorText}`);
            }
            
            const result = await response.json();
            const translation = result.choices?.[0]?.message?.content;
            
            if (translation) {
                outputTextarea.value = translation.trim();
            } else {
                throw new Error('API 返回的响应中没有有效的翻译内容。');
            }
        } catch (error) {
            console.error('翻译失败:', error);
            outputTextarea.value = `翻译失败: ${error.message}\n\n原文: ${text}`;
        } finally {
            button.innerHTML = originalText;
            button.disabled = false;
        }
    }

    // 全部清空功能
    function clearAllFormData(toolName) {
        const confirmed = confirm('确定要清空所有内容吗？包括提示词、翻译内容、图片和额外图片。');
        if (!confirmed) return;
        
        const inputs = toolForm.querySelectorAll('input, textarea, select');
        inputs.forEach(input => {
            if (input.type === 'checkbox' || input.type === 'radio') {
                input.checked = input.defaultChecked || false;
            } else if (input.tagName === 'SELECT') {
                input.selectedIndex = 0;
            } else {
                input.value = '';
            }
        });
        
        const translationContainers = toolForm.querySelectorAll('.translation-container');
        translationContainers.forEach(container => {
            const translatedPrompt = container.querySelector('.translated-prompt');
            if (translatedPrompt) translatedPrompt.value = '';
            container.style.display = 'none';
        });
        
        const previewAreas = toolForm.querySelectorAll('.image-preview-area');
        previewAreas.forEach(preview => {
            preview.style.display = 'none';preview.innerHTML = '';
        });
        
        const dropZones = toolForm.querySelectorAll('.drop-zone');
        const clearButtons = toolForm.querySelectorAll('.clear-image-btn');
        
        dropZones.forEach(dropZone => {
            dropZone.style.display = 'block';
            dropZone.innerHTML = `
                <div class="drop-icon">📁</div>
                <p>拖拽图片文件到此处或点击选择</p>
            `;dropZone.style.color = 'var(--secondary-text)';
        });
        
        clearButtons.forEach(btn => { btn.style.display = 'none'; });
        
        if (toolName === 'NanoBananaGen') {
            const dynamicContainer = toolForm.querySelector('.dynamic-images-container');
            if (dynamicContainer) {
                const imagesList = dynamicContainer.querySelector('.sortable-images-list');
                if (imagesList) {
                    const dynamicItems = imagesList.querySelectorAll('.dynamic-image-item');
                    dynamicItems.forEach(item => { item.remove(); });
                }}
        }
        
        if (resultContainer) resultContainer.innerHTML = '';
        
        // 清除该工具的缓存
        formStateCache.delete(toolName);
        const successMessage = document.createElement('div');
        successMessage.className = 'success-notification';
        successMessage.style.cssText = `
            position: fixed; top: 20px; right: 20px;
            background: var(--success-color); color: white;
            padding: 12px 20px; border-radius: 6px;
            z-index: 1000; font-size: 14px; font-weight: 500;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        `;
        successMessage.textContent = '✓ 已清空所有内容';
        document.body.appendChild(successMessage);
        
        setTimeout(() => {
            if (successMessage.parentNode) {
                successMessage.classList.add('removing');
                setTimeout(() => {
                    if (successMessage.parentNode) successMessage.parentNode.removeChild(successMessage);
                }, 300);
            }
        }, 2700);
    }

    // 显示文件名设置对话框
    function showFilenameSettings() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.5); z-index: 10000;
            display: flex; justify-content: center; align-items: center;
        `;
        
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: var(--card-bg); border-radius: 8px; padding: 30px;
            width: 90%; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
        `;
        
        dialog.innerHTML = `
            <h3>文件名显示设置</h3>
            <div style="margin: 15px 0;">
                <label>文件名最大长度（超过则省略）：</label>
                <input type="number" id="filename-length-input" value="${MAX_FILENAME_LENGTH}" min="50" max="1000" style="width: 100%; padding: 8px; margin-top: 5px; background: var(--input-bg); color: var(--primary-text); border: 1px solid var(--border-color); border-radius: 4px;">
            </div>
            <p style="font-size: 12px; color: var(--secondary-text);">建议范围：50-1000 字符，默认为 400</p>
            <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                <button id="cancel-btn" style="padding: 8px 16px; background: var(--secondary-color, #6b7280); color: white; border: none; border-radius: 4px; cursor: pointer;">取消</button>
                <button id="save-btn" style="padding: 8px 16px; background: var(--success-color); color: white; border: none; border-radius: 4px; cursor: pointer;">保存</button>
            </div>
        `;
        
        const input = dialog.querySelector('#filename-length-input');
        const cancelBtn = dialog.querySelector('#cancel-btn');
        const saveBtn = dialog.querySelector('#save-btn');
        
        cancelBtn.addEventListener('click', () => { document.body.removeChild(overlay); });
        
        saveBtn.addEventListener('click', async () => {
            const newLength = parseInt(input.value, 10);
            if (newLength >= 50 && newLength <= 1000) {
                MAX_FILENAME_LENGTH = newLength;
                settings.maxFilenameLength = newLength;
                try {
                    await saveSettings();
                    const successMsg = document.createElement('div');
                    successMsg.className = 'success-notification';
                    successMsg.style.cssText = `
                        position: fixed; top: 20px; right: 20px;
                        background: var(--success-color); color: white;
                        padding: 12px 20px; border-radius: 6px;
                        z-index: 10001; font-size: 14px; font-weight: 500;`;
                    successMsg.textContent = '✓ 设置已保存';
                    document.body.appendChild(successMsg);
                    setTimeout(() => { if (successMsg.parentNode) successMsg.parentNode.removeChild(successMsg); }, 2000);
                    document.body.removeChild(overlay);
                } catch (saveError) {
                    console.error('[VCPHumanToolBox] Failed to save settings:', saveError);
                    alert('保存设置失败：' + saveError.message);
                }
            } else {
                alert('请输入 50-1000 之间的数值');
            }
        });
        
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);overlay.addEventListener('click', (e) => {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    async function executeTool(toolName) {
        const formData = new FormData(toolForm);
        const args = {};
        let finalToolName = toolName;

        for (let [key, value] of formData.entries()) {
            const inputElement = toolForm.querySelector(`[name="${key}"]`);
            if (inputElement && inputElement.type === 'checkbox') {
                args[key] = inputElement.checked;
            } else if (value) {
                args[key] = value;
            }
        }

        // 防御性注入 maid
        args.maid = USER_NAME;
        // 计时器
        const startTime = Date.now();
        let timerInterval;
        resultContainer.innerHTML = '<div class="loader"></div><p class="loading" id="loading-timer">⏱ 执行中...</p>';
        const timerEl = document.getElementById('loading-timer');
        timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            if (timerEl) timerEl.textContent = `⏱ 已等待 ${elapsed}s...`;
        }, 1000);

        try {
            const result = await window.electronAPI.invoke('vcp-ht-execute-tool-proxy', {
                url: VCP_SERVER_URL,
                apiKey: VCP_API_KEY,
                toolName: finalToolName,
                userName: USER_NAME,
                args: args
            });

            clearInterval(timerInterval);
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            // 记录执行历史
            executionHistory.unshift({
                toolName: finalToolName,
                displayName: tools[finalToolName]?.displayName || finalToolName,
                command: args.command || '',
                time: new Date().toLocaleTimeString(),
                success: result.success,
                duration: duration
            });
            if (executionHistory.length > 15) executionHistory.pop();

            if (result.success) {
                renderResult(result.data, toolName, duration);
            } else {
                renderResult({ status: 'error', error: result.error }, toolName, duration);
            }
        } catch (error) {
            clearInterval(timerInterval);
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            executionHistory.unshift({
                toolName: finalToolName,
                displayName: tools[finalToolName]?.displayName || finalToolName,
                command: args.command || '',
                time: new Date().toLocaleTimeString(),
                success: false,
                duration: duration
            });
            if (executionHistory.length > 15) executionHistory.pop();
            renderResult({ status: 'error', error: error.message }, toolName, duration);
        }

        renderHistory();
        // 持久化执行历史到settings
        settings.vcpht_executionHistory = executionHistory.slice(0, 15);
        saveSettings().catch(e => console.warn('History save failed:', e));
    }

    function renderResult(data, toolName, duration = '') {
        resultContainer.innerHTML = '';

        //耗时标签
        if (duration) {
            const durationTag = document.createElement('div');
            durationTag.style.cssText = `
                display: inline-block; padding: 4px 10px; border-radius: 12px;
                font-size: 11px; margin-bottom: 10px;
                background: ${data.status === 'error' || data.error ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)'};
                color: ${data.status === 'error' || data.error ? 'var(--danger-color)' : 'var(--success-color)'};`;
            durationTag.textContent = `${data.status === 'error' || data.error ? '❌' : '✅'} 耗时 ${duration}s`;
            resultContainer.appendChild(durationTag);
        }
        
        // 错误处理
        if (data.status === 'error' || data.error) {
            const errorMessage = data.error || data.message || '未知错误';
            const pre = document.createElement('pre');
            pre.className = 'error';
            pre.textContent = typeof errorMessage === 'object' ? JSON.stringify(errorMessage, null, 2) : errorMessage;
            resultContainer.appendChild(pre);

            // 重试按钮
            const retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.innerHTML = '🔄 重试';
            retryBtn.style.cssText = `
                margin-top: 10px; padding: 8px 16px; border-radius: 5px;
                border: 1px solid var(--danger-color); background: transparent;
                color: var(--danger-color); cursor: pointer; font-size: 14px;
                transition: all 0.2s;
            `;
            retryBtn.addEventListener('click', () => executeTool(toolName));
            retryBtn.addEventListener('mouseenter', () => {
                retryBtn.style.background = 'var(--danger-color)';
                retryBtn.style.color = 'white';
            });
            retryBtn.addEventListener('mouseleave', () => {
                retryBtn.style.background = 'transparent';
                retryBtn.style.color = 'var(--danger-color)';
            });
            resultContainer.appendChild(retryBtn);
            return;
        }
        
        // 提取核心内容
        let content = data.result || data.message || data;
        if (content && typeof content.content === 'string') {
            try {
                const parsedContent = JSON.parse(content.content);
                content = parsedContent.original_plugin_output || parsedContent;
            } catch (e) {
                content = content.content;
            }
        }
        
        // 渲染内容
        if (content == null) {
            const p = document.createElement('p');
            p.textContent = '插件执行完毕，但没有返回明确内容。';
            resultContainer.appendChild(p);
        } else if (content && Array.isArray(content.content)) {
            content.content.forEach(item => {
                if (item.type === 'text') {
                    const pre = document.createElement('pre');
                    pre.textContent = item.text;
                    resultContainer.appendChild(pre);
                } else if (item.type === 'image_url' && item.image_url && item.image_url.url) {
                    const imgElement = document.createElement('img');
                    imgElement.src = item.image_url.url;
                    resultContainer.appendChild(imgElement);
                }
            });
        } else if (typeof content === 'string' && (content.startsWith('data:image') || /\.(jpg|jpeg|png|gif|webp)$/i.test(content))) {
            const imgElement = document.createElement('img');
            imgElement.src = content;
            resultContainer.appendChild(imgElement);
        } else if (typeof content === 'string') {
            const div = document.createElement('div');
            if (window.marked && typeof window.marked.parse === 'function') {
                div.innerHTML = window.marked.parse(content);
            } else {
                div.textContent = content;
            }
            resultContainer.appendChild(div);
        } else if (toolName === 'TavilySearch' && content && (content.results || content.images)) {
            const searchResultsWrapper = document.createElement('div');
            searchResultsWrapper.className = 'tavily-search-results';

            if (content.images && content.images.length > 0) {
                const imagesContainer = document.createElement('div');
                imagesContainer.className = 'tavily-images-container';
                content.images.forEach(image => {
                    const imageWrapper = document.createElement('figure');
                    imageWrapper.className = 'tavily-image-wrapper';
                    const img = document.createElement('img');
                    img.src = image.url;
                    const figcaption = document.createElement('figcaption');
                    figcaption.textContent = image.description;
                    imageWrapper.appendChild(img);
                    imageWrapper.appendChild(figcaption);
                    imagesContainer.appendChild(imageWrapper);
                });
                searchResultsWrapper.appendChild(imagesContainer);
            }

            if (content.results && content.results.length > 0) {
                const resultsContainer = document.createElement('div');
                resultsContainer.className = 'tavily-results-container';
                content.results.forEach(result => {
                    const resultItem = document.createElement('div');
                    resultItem.className = 'tavily-result-item';
                    const title = document.createElement('h4');
                    const link = document.createElement('a');
                    link.href = result.url;
                    link.textContent = result.title;
                    link.target = '_blank';
                    title.appendChild(link);
                    const url = document.createElement('p');
                    url.className = 'tavily-result-url';
                    url.textContent = result.url;
                    const snippet = document.createElement('div');
                    snippet.className = 'tavily-result-snippet';
                    if (window.marked && typeof window.marked.parse === 'function') {
                        snippet.innerHTML = window.marked.parse(result.content);
                    } else {
                        snippet.textContent = result.content;
                    }
                    resultItem.appendChild(title);
                    resultItem.appendChild(url);
                    resultItem.appendChild(snippet);
                    resultsContainer.appendChild(resultItem);
                });
                searchResultsWrapper.appendChild(resultsContainer);
            }

            resultContainer.appendChild(searchResultsWrapper);
        } else if (typeof content === 'object') {
            const imageUrl = content.image_url || content.url || content.image;
            const textResult = content.result || content.message || content.original_plugin_output || content.content;
            
            if (typeof imageUrl === 'string') {
                const imgElement = document.createElement('img');
                imgElement.src = imageUrl;
                resultContainer.appendChild(imgElement);
            } else if (typeof textResult === 'string') {
                if (window.marked && typeof window.marked.parse === 'function') {
                    resultContainer.innerHTML += window.marked.parse(textResult);
                } else {
                    resultContainer.textContent = textResult;
                }
            } else {
                const pre = document.createElement('pre');
                pre.textContent = JSON.stringify(content, null, 2);
                resultContainer.appendChild(pre);
            }
        } else {
            const pre = document.createElement('pre');
            pre.textContent = `插件返回了未知类型的数据: ${String(content)}`;
            resultContainer.appendChild(pre);
        }

        // 复制按钮（仅文本结果）
        const textContent = resultContainer.innerText.trim();
        if (textContent && textContent.length > 10) {
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.innerHTML = '📋 复制结果';
            copyBtn.style.cssText = `
                margin-top: 12px; padding: 6px 14px; border-radius: 5px;
                border: 1px solid var(--border-color); background: transparent;
                color: var(--secondary-text); cursor: pointer; font-size: 12px;
                transition: all 0.2s;
            `;
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(textContent);
                    copyBtn.innerHTML = '✅ 已复制';
                    setTimeout(() => { copyBtn.innerHTML = '📋 复制结果'; }, 2000);
                } catch (e) {
                    copyBtn.innerHTML = '❌ 复制失败';
                    setTimeout(() => { copyBtn.innerHTML = '📋 复制结果'; }, 2000);
                }
            });
            resultContainer.appendChild(copyBtn);
        }
    }

    // --- 执行历史 ---
    function renderHistory() {
        const historyContainer = document.getElementById('execution-history');
        if (!historyContainer) return;
        if (executionHistory.length === 0) {
            historyContainer.innerHTML = '';
            return;
        }

        historyContainer.innerHTML = `
            <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--border-color);">
                <h4 style="margin: 0 0 10px; color: var(--secondary-text); font-size: 13px;">📜 执行历史 (最近${executionHistory.length}条)</h4>
                ${executionHistory.map(h => `
                    <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 12px; color: var(--placeholder-text); border-bottom: 1px solid rgba(255,255,255,0.03);">
                        <span>${h.success ? '✅' : '❌'}</span>
                        <span style="color: var(--secondary-text); font-weight: 500;">${h.displayName}</span>
                        ${h.command ? `<span style="color: var(--placeholder-text);">→ ${h.command}</span>` : ''}
                        <span style="margin-left: auto; color: var(--placeholder-text);">${h.duration}s</span>
                        <span style="color: var(--placeholder-text);">${h.time}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // --- Image Viewer Modal ---
    function setupImageViewer() {
        if (document.getElementById('image-viewer-modal')) return;

        const viewer = document.createElement('div');
        viewer.id = 'image-viewer-modal';
        viewer.style.cssText = `
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            overflow: auto;
            background-color: rgba(0,0,0,0.85);
            justify-content: center;
            align-items: center;
        `;
        viewer.innerHTML = `
            <span style="position:absolute;top:15px;right:35px;color:#f1f1f1;font-size:40px;font-weight:bold;cursor:pointer;">&times;</span>
            <img style="margin:auto;display:block;max-width:90%;max-height:90%;">
        `;
        document.body.appendChild(viewer);

        const modalImg = viewer.querySelector('img');
        const closeBtn = viewer.querySelector('span');

        function openModal(src) {
            viewer.style.display = 'flex';
            modalImg.src = src;
            document.addEventListener('keydown', handleEscKeyModal);
        }

        function closeModal() {
            viewer.style.display = 'none';
            modalImg.src = '';
            document.removeEventListener('keydown', handleEscKeyModal);
        }

        function handleEscKeyModal(e) {
            if (e.key === 'Escape') closeModal();
        }

        closeBtn.onclick = closeModal;
        viewer.onclick = function(e) {
            if (e.target === viewer) closeModal();
        };

        resultContainer.addEventListener('click', (e) => {
            let target = e.target;
            if (target.tagName === 'IMG' && target.parentElement.tagName === 'A') {
                target = target.parentElement;
            }
            if (target.tagName === 'A' && target.href && (target.href.match(/\.(jpeg|jpg|gif|png|webp)$/i) || target.href.startsWith('data:image'))) {
                e.preventDefault();
                openModal(target.href);
            }
        });
    }

    // --- 初始化 ---
    async function loadAndProcessWallpaper() {
        const bodyStyles = getComputedStyle(document.body);
        let wallpaperUrl = bodyStyles.backgroundImage;

        if (wallpaperUrl && wallpaperUrl !== 'none') {
            const match = wallpaperUrl.match(/url\("(.+)"\)/);
            if (match && match[1]) {
                let imagePath = match[1];
                if (imagePath.startsWith('file:///')) {
                    imagePath = decodeURI(imagePath.substring(8));
                }

                try {
                    const processedImageBase64 = await window.electronAPI.invoke('vcp-ht-process-wallpaper', imagePath);
                    if (processedImageBase64) {
                        document.body.style.backgroundImage = `url('${processedImageBase64}')`;}
                } catch (error) {
                    console.error('Wallpaper processing failed:', error);
                }
            }
        }
    }

    function initializeUI() {
        document.getElementById('minimize-btn').addEventListener('click', () => {
            window.electronAPI.send('window-control','minimize');
        });
        document.getElementById('maximize-btn').addEventListener('click', () => {
            window.electronAPI.send('window-control', 'maximize');
        });
        document.getElementById('close-btn').addEventListener('click', () => {
            window.electronAPI.send('window-control', 'close');
        });

        const themeToggleBtn = document.getElementById('theme-toggle-btn');
        
        function applyTheme(theme) {
            if (theme === 'light') {
                document.body.classList.add('light-theme');
                themeToggleBtn.textContent = '☀️';} else {
                document.body.classList.remove('light-theme');
                themeToggleBtn.textContent = '🌙';
            }
        }

        applyTheme(settings.vcpht_theme);

        themeToggleBtn.addEventListener('click', async () => {
            const isLight = document.body.classList.toggle('light-theme');
            const newTheme = isLight ? 'light' : 'dark';
            applyTheme(newTheme);
            settings.vcpht_theme = newTheme;
            
            try {
                await saveSettings();
            } catch (saveError) {
                console.error('[VCPHumanToolBox] Failed to save theme setting:', saveError);
            }
        });

        backToGridBtn.addEventListener('click', () => {
            if (currentToolName) {
                saveFormState(currentToolName);
            }
            toolDetailView.style.display = 'none';
            toolGrid.style.display = 'grid';
        });

        const workflowBtn = document.getElementById('workflow-btn');
        if (workflowBtn) {
            workflowBtn.addEventListener('click', openWorkflowEditor);
        }
        renderToolGrid();
        loadAndProcessWallpaper();
        setupImageViewer();
    }

    initializeApp();

    // --- ComfyUI 集成功能 ---
    let comfyUIDrawer = null;
    let comfyUILoaded = false;

    function createComfyUIDrawer() {
        const overlay = document.createElement('div');
        overlay.className = 'drawer-overlay hidden';
        overlay.addEventListener('click', closeComfyUISettings);

        const drawer = document.createElement('div');
        drawer.className = 'drawer-panel';
        drawer.innerHTML = `
            <div id="comfyui-drawer-content">
                <p style="text-align: center; color: var(--secondary-text);">
                    正在加载 ComfyUI 配置...
                </p>
            </div>
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(drawer);

        return { overlay, drawer };
    }

    async function openComfyUISettings() {
        if (!comfyUIDrawer) {
            comfyUIDrawer = createComfyUIDrawer();
        }

        comfyUIDrawer.overlay.classList.remove('hidden');
        comfyUIDrawer.drawer.classList.add('open');
        document.body.classList.add('drawer-open');

        if (!comfyUILoaded) {
            try {
                await loadComfyUIModules();
                
                if (window.ComfyUILoader) {
                    await window.ComfyUILoader.load();
                    
                    const drawerContent = document.getElementById('comfyui-drawer-content');
                    if (window.comfyUI && drawerContent) {
                        window.comfyUI.createUI(drawerContent, {
                            defaultTab: 'connection',
                            onClose: closeComfyUISettings
                        });
                    }
                    
                    comfyUILoaded = true;
                } else {
                    throw new Error('ComfyUILoader 未能正确加载');
                }
            } catch (error) {
                console.error('加载 ComfyUI 模块失败:', error);
                const drawerContent = document.getElementById('comfyui-drawer-content');
                if (drawerContent) {
                    drawerContent.innerHTML = `
                        <p style="color: var(--danger-color); text-align: center;">
                            加载 ComfyUI 配置失败: ${error.message}
                        </p>
                    `;
                }
            }
        }

        document.addEventListener('keydown', handleEscKey);
    }

    function closeComfyUISettings() {
        if (comfyUIDrawer) {
            comfyUIDrawer.overlay.classList.add('hidden');
            comfyUIDrawer.drawer.classList.remove('open');
            document.body.classList.remove('drawer-open');
        }
        document.removeEventListener('keydown', handleEscKey);
    }

    function handleEscKey(e) {
        if (e.key === 'Escape') closeComfyUISettings();
    }

    async function loadComfyUIModules() {
        const loaderScript = document.createElement('script');
        loaderScript.src = 'ComfyUImodules/ComfyUILoader.js';
        return new Promise((resolve, reject) => {
            loaderScript.onload = resolve;
            loaderScript.onerror = () => reject(new Error('无法加载 ComfyUILoader.js'));
            document.head.appendChild(loaderScript);
        });
    }

    // --- 工作流编排集成功能 ---
    let workflowEditorLoaded = false;

    async function openWorkflowEditor() {
        try {
            if (!workflowEditorLoaded) {
                await loadWorkflowEditorModules();
                workflowEditorLoaded = true;
            }

            if (window.workflowEditor) {
                window.workflowEditor.show();
            } else {
                throw new Error('工作流编排器未能正确初始化');
            }
        } catch (error) {
            console.error('打开工作流编排器失败:', error);
            alert(`打开工作流编排器失败: ${error.message}`);
        }
    }

    async function loadWorkflowEditorModules() {
        const loaderScript = document.createElement('script');
        loaderScript.src = 'WorkflowEditormodules/WorkflowEditorLoader_Simplified.js';
        
        await new Promise((resolve, reject) => {
            loaderScript.onload = resolve;
            loaderScript.onerror = () => reject(new Error('无法加载 WorkflowEditorLoader_Simplified.js'));
            document.head.appendChild(loaderScript);
        });

        if (window.WorkflowEditorLoader) {
            await window.WorkflowEditorLoader.load();
            
            if (window.workflowEditor) {
                await window.workflowEditor.init();
                console.log('工作流编排器初始化成功');
            } else {
                throw new Error('WorkflowEditor 配置模块未能正确加载');
            }
        } else {
            throw new Error('WorkflowEditorLoader 未能正确加载');
        }
    }

    window.openComfyUISettings = openComfyUISettings;
    window.closeComfyUISettings = closeComfyUISettings;
    window.openWorkflowEditor = openWorkflowEditor;
});