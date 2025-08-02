// VCPHumanToolBox/renderer.js
const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    // --- 元素获取 ---
    const toolGrid = document.getElementById('tool-grid');
    const toolDetailView = document.getElementById('tool-detail-view');
    const backToGridBtn = document.getElementById('back-to-grid-btn');
    const toolTitle = document.getElementById('tool-title');
    const toolDescription = document.getElementById('tool-description');
    const toolForm = document.getElementById('tool-form');
    const resultContainer = document.getElementById('result-container');

    // --- 从主程序 settings.json 读取配置 ---
    const fs = require('fs');
    const path = require('path');

    let VCP_SERVER_URL = '';
    let VCP_API_KEY = '';
    let USER_NAME = 'Human'; // Default value in case it's not found

    try {
        const settingsPath = path.join(__dirname, '..', 'AppData', 'settings.json');
        const settingsData = fs.readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(settingsData);
        
        if (settings.vcpServerUrl) {
            const url = new URL(settings.vcpServerUrl);
            url.pathname = '/v1/human/tool';
            VCP_SERVER_URL = url.toString();
        }
        VCP_API_KEY = settings.vcpApiKey || '';
        USER_NAME = settings.userName || 'Human';

        if (!VCP_SERVER_URL || !VCP_API_KEY) {
            throw new Error('未能从 settings.json 中找到 vcpServerUrl 或 vcpApiKey');
        }

    } catch (error) {
        console.error('加载配置文件失败:', error);
        // 在界面上显示错误，阻止后续操作
        toolGrid.innerHTML = `<div class="error">错误：无法加载配置文件 (settings.json)。请确保文件存在且格式正确。<br>${error.message}</div>`;
        return; // 停止执行
    }


    // --- 工具定义 (基于 supertool.txt) ---
    const tools = {
        // 多媒体生成类
        'FluxGen': {
            displayName: 'Flux 图片生成',
            description: '艺术风格多变，仅支持英文提示词。',
            params: [
                { name: 'prompt', type: 'textarea', required: true, placeholder: '详细的英文提示词' },
                { name: 'resolution', type: 'select', required: true, options: ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280'] }
            ]
        },
        'DoubaoGen': {
            displayName: '豆包图片生成',
            description: '国产文生图，支持中文和任意分辨率，适合平面设计。',
            params: [
                { name: 'prompt', type: 'textarea', required: true, placeholder: '详细的提示词，可包含中文' },
                { name: 'resolution', type: 'text', required: true, placeholder: '例如: 800x600' }
            ]
        },
        'SunoGen': {
            displayName: 'Suno 音乐生成',
            description: '强大的Suno音乐生成器。',
            commands: {
                'generate_song': {
                    description: '生成歌曲或纯音乐',
                    params: [
                        { name: 'mode', type: 'radio', options: ['lyrics', 'instrumental'], default: 'lyrics', description: '生成模式' },
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '[Verse 1]\nSunlight on my face...', dependsOn: { field: 'mode', value: 'lyrics' } },
                        { name: 'tags', type: 'text', required: false, placeholder: 'acoustic, pop, happy', dependsOn: { field: 'mode', value: 'lyrics' } },
                        { name: 'title', type: 'text', required: false, placeholder: 'Sunny Days', dependsOn: { field: 'mode', value: 'lyrics' } },
                        { name: 'gpt_description_prompt', type: 'textarea', required: true, placeholder: '一首关于星空和梦想的安静钢琴曲', dependsOn: { field: 'mode', value: 'instrumental' } }
                    ]
                }
            }
        },
        'Wan2.1VideoGen': {
            displayName: 'Wan2.1 视频生成',
            description: '基于强大的Wan2.1模型生成视频。',
            commands: {
                'submit': {
                    description: '提交新视频任务',
                    params: [
                        { name: 'mode', type: 'radio', options: ['i2v', 't2v'], default: 't2v', description: '生成模式' },
                        { name: 'image_url', type: 'text', required: true, placeholder: 'http://example.com/cat.jpg', dependsOn: { field: 'mode', value: 'i2v' } },
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '一只猫在太空漫步', dependsOn: { field: 'mode', value: 't2v' } },
                        { name: 'resolution', type: 'select', required: true, options: ['1280x720', '720x1280', '960x960'], dependsOn: { field: 'mode', value: 't2v' } }
                    ]
                },
                'query': {
                    description: '查询任务状态',
                    params: [{ name: 'request_id', type: 'text', required: true, placeholder: '任务提交后返回的ID' }]
                }
            }
        },
        // 工具类
        'SciCalculator': {
            displayName: '科学计算器',
            description: '支持基础运算、函数、统计和微积分。',
            params: [{ name: 'expression', type: 'textarea', required: true, placeholder: "例如: integral('x**2', 0, 1)" }]
        },
        'TavilySearch': {
            displayName: 'Tavily 联网搜索',
            description: '专业的联网搜索API。',
            params: [
                { name: 'query', type: 'text', required: true, placeholder: '搜索的关键词或问题' },
                { name: 'topic', type: 'text', required: false, placeholder: "general, news, finance..." },
                { name: 'search_depth', type: 'select', required: false, options: ['basic', 'advanced'] },
                { name: 'max_results', type: 'number', required: false, placeholder: '10' }
            ]
        },
        'GoogleSearch': {
            displayName: 'Google 搜索',
            description: '进行一次标准的谷歌网页搜索。',
            params: [{ name: 'query', type: 'text', required: true, placeholder: '如何学习编程？' }]
        },
        'UrlFetch': {
            displayName: '网页超级爬虫',
            description: '获取网页的文本内容或快照。',
            params: [
                { name: 'url', type: 'text', required: true, placeholder: 'https://example.com' },
                { name: 'mode', type: 'select', required: false, options: ['text', 'snapshot'] }
            ]
        },
        'BilibiliFetch': {
            displayName: 'B站内容获取',
            description: '获取B站视频的TTS转化文本内容。',
            params: [{ name: 'url', type: 'text', required: true, placeholder: 'Bilibili 视频的 URL' }]
        },
        'FlashDeepSearch': {
            displayName: '深度信息研究',
            description: '进行深度主题搜索，返回研究论文。',
            params: [
                { name: 'SearchContent', type: 'textarea', required: true, placeholder: '希望研究的主题内容' },
                { name: 'SearchBroadness', type: 'number', required: false, placeholder: '7 (范围 5-20)' }
            ]
        },
        // VCP通讯插件
        'AgentAssistant': {
            displayName: '女仆通讯器',
            description: '用于联络别的女仆Agent。',
            params: [
                { name: 'agent_name', type: 'text', required: true, placeholder: '例如: 小娜, 小克...' },
                { name: 'prompt', type: 'textarea', required: true, placeholder: '我是[您的名字]，我想请你...' }
            ]
        },
        'AgentMessage': {
            displayName: '主人通讯器',
            description: '向莱恩主人的设备发送通知消息。',
            params: [{ name: 'message', type: 'textarea', required: true, placeholder: '要发送的消息内容' }]
        },
        'DeepMemo': {
            displayName: '深度回忆',
            description: '回忆过去的聊天历史。',
            params: [
                { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                { name: 'keyword', type: 'text', required: true, placeholder: '多个关键词用空格或逗号分隔' },
                { name: 'window_size', type: 'number', required: false, placeholder: '10 (范围 1-20)' }
            ]
        },
        // 物联网插件
        'TableLampRemote': {
            displayName: '桌面台灯控制器',
            description: '控制智能台灯的状态。',
            commands: {
                'GetLampStatus': {
                    description: '获取台灯当前信息',
                    params: []
                },
                'LampControl': {
                    description: '控制台灯',
                    params: [
                        { name: 'power', type: 'select', options: ['', 'True', 'False'], description: '电源' },
                        { name: 'brightness', type: 'number', min: 1, max: 100, placeholder: '1-100', description: '亮度' },
                        { name: 'color_temperature', type: 'number', min: 2500, max: 4800, placeholder: '2500-4800', description: '色温' }
                    ]
                }
            }
        }
    };

    // --- 函数定义 ---

    function renderToolGrid() {
        toolGrid.innerHTML = '';
        for (const toolName in tools) {
            const tool = tools[toolName];
            const card = document.createElement('div');
            card.className = 'tool-card';
            card.dataset.toolName = toolName;
            card.innerHTML = `
                <h3>${tool.displayName}</h3>
                <p>${tool.description}</p>
            `;
            card.addEventListener('click', () => showToolDetail(toolName));
            toolGrid.appendChild(card);
        }
    }

    function showToolDetail(toolName) {
        const tool = tools[toolName];
        toolTitle.textContent = tool.displayName;
        toolDescription.textContent = tool.description;
        
        buildToolForm(toolName);

        toolGrid.style.display = 'none';
        toolDetailView.style.display = 'block';
        resultContainer.innerHTML = '';
    }

    function buildToolForm(toolName) {
        const tool = tools[toolName];
        toolForm.innerHTML = '';
        const paramsContainer = document.createElement('div');
        paramsContainer.id = 'params-container';

        if (tool.commands) {
            const commandSelectGroup = document.createElement('div');
            commandSelectGroup.className = 'form-group';
            commandSelectGroup.innerHTML = `<label for="command-select">选择操作 (Command):</label>`;
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
                renderFormParams(tool.commands[e.target.value].params, paramsContainer);
            });
            renderFormParams(tool.commands[commandSelect.value].params, paramsContainer);

        } else {
            toolForm.appendChild(paramsContainer);
            renderFormParams(tool.params, paramsContainer);
        }

        const submitButton = document.createElement('button');
        submitButton.type = 'submit';
        submitButton.textContent = '执行';
        toolForm.appendChild(submitButton);

        toolForm.onsubmit = (e) => {
            e.preventDefault();
            executeTool(toolName);
        };
    }

    function renderFormParams(params, container) {
        container.innerHTML = '';
        const dependencyListeners = [];

        params.forEach(param => {
            const paramGroup = document.createElement('div');
            paramGroup.className = 'form-group';
            
            let labelText = param.description || param.name;
            const label = document.createElement('label');
            label.textContent = `${labelText}${param.required ? ' *' : ''}`;
            
            let input;
            if (param.type === 'textarea') {
                input = document.createElement('textarea');
            } else if (param.type === 'select') {
                input = document.createElement('select');
                param.options.forEach(opt => {
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

                    // Add listener for dependency changes
                    radioInput.addEventListener('change', () => {
                        dependencyListeners.forEach(listener => listener());
                    });
                });
            } else {
                input = document.createElement('input');
                input.type = param.type || 'text';
            }
            
            if (input.tagName !== 'DIV') {
                input.name = param.name;
                input.placeholder = param.placeholder || '';
                if (param.required) input.required = true;
            } else {
                // For radio group, we need a hidden input to carry the name for FormData
                const hiddenInput = document.createElement('input');
                hiddenInput.type = 'hidden';
                hiddenInput.name = param.name;
                paramGroup.appendChild(hiddenInput);
            }

            paramGroup.appendChild(label);
            paramGroup.appendChild(input);
            container.appendChild(paramGroup);

            // Handle conditional visibility
            if (param.dependsOn) {
                const dependencyCheck = () => {
                    const dependencyField = toolForm.querySelector(`[name="${param.dependsOn.field}"]:checked`) || toolForm.querySelector(`[name="${param.dependsOn.field}"]`);
                    if (dependencyField && dependencyField.value === param.dependsOn.value) {
                        paramGroup.style.display = '';
                    } else {
                        paramGroup.style.display = 'none';
                    }
                };
                dependencyListeners.push(dependencyCheck);
            }
        });

        dependencyListeners.forEach(listener => listener());
    }

    async function executeTool(toolName) {
        const formData = new FormData(toolForm);
        const args = {};

        // Collect all form data
        for (let [key, value] of formData.entries()) {
            const inputElement = toolForm.querySelector(`[name="${key}"]`);
            if (inputElement && inputElement.type === 'checkbox') {
                args[key] = inputElement.checked;
            } else if (value) { // Don't include empty optional fields
                args[key] = value;
            }
        }
        // Handle radio groups correctly
        const radioGroups = toolForm.querySelectorAll('.radio-group');
        radioGroups.forEach(group => {
            const selected = group.querySelector('input:checked');
            if (selected) {
                args[selected.name] = selected.value;
            }
        });

        // Build the plain text request body
        let requestBody = `<<<[TOOL_REQUEST]>>>\n`;
        requestBody += `maid:「始」${USER_NAME}「末」,\n`;
        requestBody += `tool_name:「始」${toolName}「末」,\n`;
        for (const key in args) {
            if (args[key] !== undefined) {
                const value = typeof args[key] === 'boolean' ? String(args[key]) : args[key];
                requestBody += `${key}:「始」${value}「末」,\n`;
            }
        }
        requestBody += `<<<[END_TOOL_REQUEST]>>>`;

        resultContainer.innerHTML = '<div class="loading">正在执行...</div>';

        try {
            const response = await fetch(VCP_SERVER_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Authorization': `Bearer ${VCP_API_KEY}`
                },
                body: requestBody // Send the plain text body
            });

            const responseText = await response.text();
            if (!response.ok) {
                // Try to parse error JSON if possible, otherwise use the raw text
                try {
                    const errorJson = JSON.parse(responseText);
                    throw new Error(`HTTP ${response.status}: ${errorJson.error || responseText}`);
                } catch (e) {
                    throw new Error(`HTTP ${response.status}: ${responseText}`);
                }
            }

            const data = JSON.parse(responseText); // The response is JSON
            renderResult(data, toolName);

        } catch (error) {
            console.error('Error executing tool:', error);
            resultContainer.innerHTML = `<div class="error">执行出错: ${error.message}</div>`;
        }
    }

    function renderResult(data, toolName) {
        resultContainer.innerHTML = '';

        // Check for error status from the plugin
        if (data.status === 'error' || data.error) {
            const errorMessage = data.error || data.message || '未知错误';
            const pre = document.createElement('pre');
            pre.className = 'error';
            pre.textContent = typeof errorMessage === 'object' ? JSON.stringify(errorMessage, null, 2) : errorMessage;
            resultContainer.appendChild(pre);
            return;
        }

        // The actual content is in data.result or data.message
        const content = data.result || data.message || data;

        // Special parsing for SciCalculator
        if (toolName === 'SciCalculator' && content && typeof content.original_plugin_output === 'string') {
            const output = content.original_plugin_output;
            const match = output.match(/###(.*?)###/);
            if (match && match[1]) {
                const pre = document.createElement('pre');
                pre.textContent = match[1];
                resultContainer.appendChild(pre);
                return; // Parsing is done for this tool
            }
        }

        try {
            // Check for multi-modal structure
            if (content && Array.isArray(content.content)) {
                content.content.forEach(item => {
                    if (item.type === 'text') {
                        const textElement = document.createElement('p');
                        textElement.textContent = item.text;
                        resultContainer.appendChild(textElement);
                    } else if (item.type === 'image_url' && item.image_url && item.image_url.url) {
                        const imgElement = document.createElement('img');
                        imgElement.src = item.image_url.url;
                        
                        // Add context menu for saving the image
                        imgElement.addEventListener('contextmenu', (e) => {
                            e.preventDefault();
                            ipcRenderer.send('show-image-context-menu', imgElement.src);
                        });

                        resultContainer.appendChild(imgElement);
                    }
                    // Future handlers for audio/video can be added here
                });
            } else { // Simple text or JSON object
                const pre = document.createElement('pre');
                pre.textContent = typeof content === 'object' ? JSON.stringify(content, null, 2) : content;
                resultContainer.appendChild(pre);
            }
        } catch (e) {
            // Fallback for unexpected format
            const pre = document.createElement('pre');
            pre.textContent = `无法解析返回结果: ${JSON.stringify(data, null, 2)}`;
            resultContainer.appendChild(pre);
        }
    }

    // --- 初始化 ---
    function initialize() {
        // Window controls
        document.getElementById('minimize-btn').addEventListener('click', () => {
            ipcRenderer.send('window-control', 'minimize');
        });
        document.getElementById('maximize-btn').addEventListener('click', () => {
            ipcRenderer.send('window-control', 'maximize');
        });
        document.getElementById('close-btn').addEventListener('click', () => {
            ipcRenderer.send('window-control', 'close');
        });

        // App controls
        backToGridBtn.addEventListener('click', () => {
            toolDetailView.style.display = 'none';
            toolGrid.style.display = 'grid';
        });

        renderToolGrid();
    }

    initialize();
});