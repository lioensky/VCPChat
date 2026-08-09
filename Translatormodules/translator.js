const api = window.utilityAPI || window.electronAPI;

document.addEventListener('DOMContentLoaded', async () => {
    // 获取所有需要的 DOM 元素
    const sourceTextarea = document.getElementById('sourceText');
    const translatedTextarea = document.getElementById('translatedText');
    const targetLanguageSelect = document.getElementById('targetLanguageSelect');
    const modelSelect = document.getElementById('modelSelect');
    const customPromptVarInput = document.getElementById('customPromptVar');
    const translateBtn = document.getElementById('translateBtn');
    const copyBtn = document.getElementById('copyBtn');

    // --- Custom Title Bar Elements ---
    const settingsTranslatorBtn = document.getElementById('translator-settings-btn');
    const minimizeTranslatorBtn = document.getElementById('minimize-translator-btn');
    const maximizeTranslatorBtn = document.getElementById('maximize-translator-btn');
    const closeTranslatorBtn = document.getElementById('close-translator-btn');

    // --- Settings Modal Elements ---
    const settingsModal = document.getElementById('settingsModal');
    const settingsModalBackdrop = document.getElementById('settingsModalBackdrop');
    const closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
    const fastModelInput = document.getElementById('fastModelInput');
    const balancedModelInput = document.getElementById('balancedModelInput');
    const qualityModelInput = document.getElementById('qualityModelInput');
    const streamModeToggle = document.getElementById('streamModeToggle');
    const resetSettingsBtn = document.getElementById('resetSettingsBtn');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const settingsSaveStatus = document.getElementById('settingsSaveStatus');

    const DEFAULT_TRANSLATOR_SETTINGS = {
        models: {
            fast: 'gemini-3.1-flash-lite-preview',
            balanced: 'gemini-3-flash-preview',
            quality: 'gemini-3.1-pro'
        },
        stream: false
    };

    // 配置和状态变量
    let vcpServerUrl = '';
    let vcpApiKey = '';
    let currentTheme = 'dark'; // 默认是暗色主题
    let abortController = null; // 用于中止 fetch 请求
    let translatorSettings = structuredClone(DEFAULT_TRANSLATOR_SETTINGS);

    // 保存复制按钮原始的 SVG 图标
    const originalCopyBtnIcon = copyBtn.innerHTML;

    const cloneDefaultSettings = () => structuredClone(DEFAULT_TRANSLATOR_SETTINGS);

    const normalizeTranslatorSettings = (settings = {}) => ({
        models: {
            ...DEFAULT_TRANSLATOR_SETTINGS.models,
            ...(settings.models || {})
        },
        stream: Boolean(settings.stream)
    });

    const getSelectedModelConfig = () => {
        const selectedMode = modelSelect.value;
        const model = translatorSettings.models[selectedMode] || DEFAULT_TRANSLATOR_SETTINGS.models[selectedMode] || DEFAULT_TRANSLATOR_SETTINGS.models.balanced;
        return { model, temperature: 0.7, stream: translatorSettings.stream };
    };

    const refreshModelSelectLabels = () => {
        const labels = {
            fast: '快速',
            balanced: '均衡',
            quality: '质量'
        };

        Array.from(modelSelect.options).forEach((option) => {
            const modelName = translatorSettings.models[option.value] || DEFAULT_TRANSLATOR_SETTINGS.models[option.value] || '';
            option.textContent = `${labels[option.value] || option.value} · ${modelName}`;
            option.title = modelName;
        });
    };

    const fillSettingsForm = () => {
        fastModelInput.value = translatorSettings.models.fast;
        balancedModelInput.value = translatorSettings.models.balanced;
        qualityModelInput.value = translatorSettings.models.quality;
        streamModeToggle.checked = translatorSettings.stream;
        settingsSaveStatus.textContent = '';
    };

    const readSettingsForm = () => ({
        models: {
            fast: fastModelInput.value.trim() || DEFAULT_TRANSLATOR_SETTINGS.models.fast,
            balanced: balancedModelInput.value.trim() || DEFAULT_TRANSLATOR_SETTINGS.models.balanced,
            quality: qualityModelInput.value.trim() || DEFAULT_TRANSLATOR_SETTINGS.models.quality
        },
        stream: streamModeToggle.checked
    });

    const openSettingsModal = () => {
        fillSettingsForm();
        settingsModal.classList.remove('hidden');
        setTimeout(() => fastModelInput.focus(), 0);
    };

    const closeSettingsModal = () => {
        settingsModal.classList.add('hidden');
    };

    const setSettingsStatus = (message, type = '') => {
        settingsSaveStatus.textContent = message;
        settingsSaveStatus.dataset.type = type;
    };

    // 应用主题的函数 (与主程序同步)
    const applyTheme = (theme) => {
        document.body.classList.toggle('light-theme', theme === 'light');
        currentTheme = theme;
    };

    // 从主进程加载 VCP 配置
    async function loadConfig() {
        try {
            const settings = await api.loadSettings();
            vcpServerUrl = settings?.vcpServerUrl || '';
            vcpApiKey = settings?.vcpApiKey || '';
            if (vcpServerUrl && vcpApiKey) {
                console.log('Translator config loaded successfully:', { vcpServerUrl });
            } else {
                console.warn('Translator VCP config is not available yet; translation remains disabled until configured.');
            }
        } catch (error) {
            console.error('Error loading settings via IPC:', error);
            vcpServerUrl = '';
            vcpApiKey = '';
        }
    }

    async function loadTranslatorSettings() {
        try {
            if (typeof api?.loadTranslatorSettings !== 'function') {
                console.warn('loadTranslatorSettings API not found, using defaults.');
                translatorSettings = cloneDefaultSettings();
                return;
            }

            const result = await api.loadTranslatorSettings();
            if (result?.success) {
                translatorSettings = normalizeTranslatorSettings(result.settings);
            } else {
                console.warn('Failed to load translator settings, using defaults:', result?.error);
                translatorSettings = cloneDefaultSettings();
            }
        } catch (error) {
            console.error('Error loading translator settings:', error);
            translatorSettings = cloneDefaultSettings();
        } finally {
            refreshModelSelectLabels();
        }
    }

    async function saveTranslatorSettingsFromForm() {
        const nextSettings = normalizeTranslatorSettings(readSettingsForm());
        setSettingsStatus('保存中...', 'pending');
        saveSettingsBtn.disabled = true;

        try {
            if (typeof api?.saveTranslatorSettings !== 'function') {
                throw new Error('当前预加载 API 未暴露保存翻译设置接口。');
            }

            const result = await api.saveTranslatorSettings(nextSettings);
            if (!result?.success) {
                throw new Error(result?.error || '保存失败。');
            }

            translatorSettings = normalizeTranslatorSettings(result.settings || nextSettings);
            refreshModelSelectLabels();
            fillSettingsForm();
            setSettingsStatus('已保存到 AppData/translatorsetting.json', 'success');
            setTimeout(closeSettingsModal, 500);
        } catch (error) {
            console.error('Error saving translator settings:', error);
            setSettingsStatus(`保存失败: ${error.message}`, 'error');
        } finally {
            saveSettingsBtn.disabled = false;
        }
    }

    function extractStreamDelta(payload) {
        return payload?.choices?.[0]?.delta?.content
            ?? payload?.choices?.[0]?.message?.content
            ?? payload?.choices?.[0]?.text
            ?? '';
    }

    async function readStreamingResponse(response, signal) {
        if (!response.body) {
            throw new Error('当前环境不支持读取流式响应。');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullTranslation = '';

        translatedTextarea.value = '';

        while (true) {
            if (signal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                const dataText = trimmed.startsWith('data:')
                    ? trimmed.slice(5).trim()
                    : trimmed;

                if (!dataText || dataText === '[DONE]') continue;

                try {
                    const payload = JSON.parse(dataText);
                    const delta = extractStreamDelta(payload);
                    if (delta) {
                        fullTranslation += delta;
                        translatedTextarea.value = fullTranslation;
                    }
                } catch (parseError) {
                    console.warn('Unable to parse streaming chunk:', dataText, parseError);
                }
            }
        }

        if (buffer.trim()) {
            const dataText = buffer.trim().startsWith('data:')
                ? buffer.trim().slice(5).trim()
                : buffer.trim();

            if (dataText && dataText !== '[DONE]') {
                try {
                    const payload = JSON.parse(dataText);
                    const delta = extractStreamDelta(payload);
                    if (delta) {
                        fullTranslation += delta;
                        translatedTextarea.value = fullTranslation;
                    }
                } catch (parseError) {
                    console.warn('Unable to parse final streaming chunk:', dataText, parseError);
                }
            }
        }

        if (!fullTranslation) {
            throw new Error('API 流式响应中没有有效的翻译内容。');
        }
    }

    // --- 直接调用 VCP API 进行翻译 ---
    async function performDirectTranslation(messages, modelConfig) {
        if (abortController) {
            abortController.abort(); // Abort previous request if any
        }
        abortController = new AbortController();
        const signal = abortController.signal;

        translatedTextarea.value = modelConfig.stream ? '正在连接流式翻译...' : '翻译中...';
        translatedTextarea.classList.add('streaming');

        try {
            const response = await fetch(vcpServerUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${vcpApiKey}`
                },
                body: JSON.stringify({
                    messages: messages,
                    model: modelConfig.model,
                    temperature: modelConfig.temperature,
                    max_tokens: 60000,
                    stream: modelConfig.stream
                }),
                signal: signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`服务器错误: ${response.status} ${response.statusText} - ${errorText}`);
            }

            if (modelConfig.stream) {
                await readStreamingResponse(response, signal);
                return;
            }

            const result = await response.json();
            const translation = result.choices?.[0]?.message?.content;

            if (translation) {
                translatedTextarea.value = translation;
            } else {
                throw new Error('API 返回的响应中没有有效的翻译内容。');
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('Translation request was aborted.');
                translatedTextarea.value = '翻译已取消。';
            } else {
                console.error('Error during direct translation fetch:', error);
                translatedTextarea.value = `翻译请求失败: ${error.message}`;
            }
        } finally {
            translatedTextarea.classList.remove('streaming');
            abortController = null;
        }
    }

    // --- 为翻译按钮添加点击事件 ---
    const runTranslation = () => {
        const sourceText = sourceTextarea.value.trim();
        if (!sourceText) {
            alert('请输入要翻译的文本。');
            return;
        }
        if (!vcpServerUrl || !vcpApiKey) {
            alert('VCP 服务器 URL 或 API Key 未配置，请检查主程序设置。');
            return;
        }

        const targetLanguageValue = targetLanguageSelect.value;
        const customPromptVar = customPromptVarInput.value.trim();
        let targetLanguageText = '';

        if (targetLanguageValue === 'custom') {
            targetLanguageText = customPromptVar;
            if (!targetLanguageText) {
                alert('请在“自定义提示词”框中输入您想翻译的目标语言。');
                return;
            }
            // 当使用自定义语言时，我们将自定义提示词框的内容作为目标语言。
        } else {
            targetLanguageText = targetLanguageSelect.options[targetLanguageSelect.selectedIndex].text;
        }

        let systemPrompt = `你是一个专业的翻译助手。请将用户提供的文本翻译成${targetLanguageText}。`;
        // 如果不是自定义模式，并且自定义提示词有内容，则添加为额外要求
        if (targetLanguageValue !== 'custom' && customPromptVar) {
            systemPrompt += ` 额外要求: ${customPromptVar}。`;
        }
        systemPrompt += ` 仅返回翻译结果，不要包含任何解释或额外信息。`;

        const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: sourceText }];
        const modelConfig = getSelectedModelConfig();

        performDirectTranslation(messages, modelConfig);
    };
    translateBtn.addEventListener('click', runTranslation);

    // --- Settings Modal Listeners ---
    settingsTranslatorBtn.addEventListener('click', openSettingsModal);
    closeSettingsModalBtn.addEventListener('click', closeSettingsModal);
    settingsModalBackdrop.addEventListener('click', closeSettingsModal);
    saveSettingsBtn.addEventListener('click', saveTranslatorSettingsFromForm);
    resetSettingsBtn.addEventListener('click', () => {
        translatorSettings = cloneDefaultSettings();
        fillSettingsForm();
        setSettingsStatus('已恢复默认，点击保存后生效。', 'pending');
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !settingsModal.classList.contains('hidden')) {
            closeSettingsModal();
        }
    });

    // --- Initialization and Theme Handling ---
    async function initialize() {
        await loadConfig(); // Load VCP settings first
        await loadTranslatorSettings();

        // Then initialize theme
        try {
            const theme = await api.getCurrentTheme();
            applyTheme(theme || 'dark');
        } catch (error) {
            console.error('Failed to get initial theme:', error);
            applyTheme('dark'); // Fallback
        }

        if (api) {
            api.onThemeUpdated(applyTheme);
        } else {
            console.warn('utilityAPI not found. Theme updates will not work.');
        }

        // --- Custom Title Bar Listeners ---
        minimizeTranslatorBtn.addEventListener('click', () => {
            if (api) api.minimizeWindow();
        });

        maximizeTranslatorBtn.addEventListener('click', () => {
            if (api) api.maximizeWindow();
        });

        closeTranslatorBtn.addEventListener('click', () => {
            if (api?.closeWindow) {
                api.closeWindow();
            } else {
                window.close();
            }
        });
    }

    // --- 为复制按钮添加点击事件 ---
    // next 模式：复制按钮由 VCPUI IconButton 接管，反馈改用 VCPUI.feedback（Toast）。
    let nextCopyButton = null;
    const showCopyFeedback = (message, isSuccess) => {
        if (nextCopyButton && window.VCPUI?.feedback) {
            window.VCPUI.feedback.toast(message, { variant: isSuccess ? 'success' : 'error' });
            return;
        }
        copyBtn.innerHTML = `<span class="copy-feedback">${message}</span>`;
        setTimeout(() => {
            copyBtn.innerHTML = originalCopyBtnIcon;
        }, 2000);
    };
    const copyTranslation = () => {
        const textToCopy = translatedTextarea.value;
        if (textToCopy && !translatedTextarea.classList.contains('streaming')) {
            navigator.clipboard.writeText(textToCopy).then(() => {
                showCopyFeedback('已复制!', true);
            }).catch(err => {
                console.error('Could not copy text: ', err);
                showCopyFeedback('失败', false);
            });
        }
    };
    copyBtn.addEventListener('click', copyTranslation);

    // --- 新版 UI：真实重建页面结构（AppPageShell + VCPUI 控件 + Web Awesome） ---
    // 经典模式保持原 DOM/CSS；next 模式将既有业务节点移入 VCPUI 外壳并增强，
    // 业务逻辑（流式翻译/复制/设置保存）继续操作同一批元素，无需重写。
    let nextSettingsModal = null;
    function buildNextTranslator() {
        if (!window.VCPUI) return;
        if (window.VCPUiModeController?.getCurrentMode() !== 'next') return;
        if (document.body.classList.contains('vcp-ui-scope')) return;

        const V = window.VCPUI;
        const container = document.querySelector('.translator-container');
        if (!container) return;
        document.body.classList.add('vcp-ui-scope');

        const shell = V.create('AppPageShell', {
            title: '翻译助手',
            windowControls: true,
            onMinimize: () => api?.minimizeWindow?.(),
            onClose: () => api?.closeWindow?.(),
        });
        shell.element.classList.add('vcp-ui-translator-shell', 'vcp-ui-integrated-shell');

        // 设置入口：换为 VCPUI IconButton（保留原点击逻辑：打开设置弹窗）。
        const legacySettingsBtn = document.getElementById('translator-settings-btn');
        let settingsAction = null;
        let openNextSettings = null;
        if (legacySettingsBtn) {
            settingsAction = V.create('IconButton', { icon: 'settings', label: '翻译设置', variant: 'ghost' });
            settingsAction.element.title = '翻译设置';
            settingsAction.element.addEventListener('click', () => {
                openSettingsModal();
                openNextSettings?.();
            });
        }
        const shellTitle = document.createElement('span');
        shellTitle.className = 'vcp-ui-translator-shell-title';
        shellTitle.append(Object.assign(document.createElement('strong'), { textContent: '翻译助手' }));
        if (settingsAction?.element) shellTitle.append(settingsAction.element);
        const shellWorkspaceTitle = document.createElement('strong');
        shellWorkspaceTitle.className = 'vcp-ui-translator-shell-workspace-title';
        shellWorkspaceTitle.textContent = '翻译工作台';
        shell.update({ title: shellTitle, actions: [shellWorkspaceTitle] });

        // 原容器内容移入 shell 内容区，避免双标题。
        const header = container.querySelector('.translator-header');
        header?.querySelector('h2')?.remove();
        const body = document.createElement('div');
        body.className = 'vcp-ui-translator-body';
        while (container.firstChild) body.append(container.firstChild);
        shell.update({ content: body });

        // 移除旧标题栏（AppPageShell 提供窗口控制）；清空已搬空的容器。
        document.getElementById('custom-title-bar')?.remove();
        container.remove();
        document.body.append(shell.element);

        const sourceTextarea = document.getElementById('sourceText');
        const outputArea = body.querySelector('.output-area');
        const translatorHeader = body.querySelector('.translator-header');
        const translatorMain = body.querySelector('.translator-main');
        const translatorControls = body.querySelector('.translator-controls');
        if (translatorHeader && translatorMain && translatorControls) {
            const layout = document.createElement('div');
            layout.className = 'vcp-ui-translator-layout vcp-ui-integrated-layout';
            layout.dataset.layout = 'rail';

            translatorHeader.classList.add('vcp-ui-translator-sidebar', 'vcp-ui-integrated-rail');
            if (settingsAction?.element) {
                const sidebarTools = document.createElement('div');
                sidebarTools.className = 'vcp-ui-translator-sidebar-tools';
                sidebarTools.append(settingsAction.element);
                translatorHeader.prepend(sidebarTools);
            }

            const controlLabels = new Map([
                [modelSelect, '模型'],
                [targetLanguageSelect, '目标语言'],
                [customPromptVarInput, '自定义指令'],
            ]);
            for (const [control, labelText] of controlLabels) {
                if (!control?.isConnected) continue;
                const field = document.createElement('label');
                field.className = 'vcp-ui-translator-field';
                const label = document.createElement('span');
                label.className = 'vcp-ui-translator-field-label';
                label.textContent = labelText;
                control.before(field);
                field.append(label, control);
            }

            const workspace = document.createElement('section');
            workspace.className = 'vcp-ui-translator-workspace vcp-ui-integrated-main';
            translatorHeader.before(layout);
            layout.append(translatorHeader, workspace);
            workspace.append(translatorMain);
        }
        if (sourceTextarea && outputArea) {
            const sourcePane = document.createElement('section');
            sourcePane.className = 'vcp-ui-translation-pane vcp-ui-translation-source';
            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'vcp-ui-translation-pane-header';
            sourceHeader.textContent = '原文';
            sourceTextarea.before(sourcePane);
            sourcePane.append(sourceHeader, sourceTextarea);

            outputArea.classList.add('vcp-ui-translation-pane', 'vcp-ui-translation-output');
            const outputHeader = document.createElement('div');
            outputHeader.className = 'vcp-ui-translation-pane-header';
            outputHeader.textContent = '译文';
            outputArea.prepend(outputHeader);
        }

        // 控件增强（VCPUI.enhance 保留原生 .value/.options 供业务逻辑使用）。
        document.querySelectorAll('.translator-controls select').forEach(select => {
            try { V.enhance('Select', select); } catch (error) { console.warn('[Translator] enhance select:', error); }
        });
        document.querySelectorAll('.translator-controls input[type="text"]').forEach(input => {
            try { V.enhance('Input', input); } catch (error) { console.warn('[Translator] enhance input:', error); }
        });
        document.querySelectorAll('.translator-main textarea').forEach(textarea => {
            try { V.enhance('Textarea', textarea); } catch (error) { console.warn('[Translator] enhance textarea:', error); }
        });

        // 翻译按钮 → VCPUI Button（保留原点击逻辑）。
        let nextTranslate = null;
        if (translateBtn && translateBtn.isConnected) {
            nextTranslate = V.create('Button', { label: '翻译', icon: 'translate', variant: 'primary' });
            nextTranslate.element.classList.add('vcp-ui-translator-translate');
            nextTranslate.element.addEventListener('click', runTranslation);
            translateBtn.replaceWith(nextTranslate.element);
            translateBtn.dataset.nextUiReplaced = 'true';
        }

        // 复制按钮 → VCPUI IconButton（保留原点击逻辑；反馈走 VCPUI.feedback）。
        if (copyBtn && copyBtn.isConnected) {
            nextCopyButton = V.create('IconButton', { icon: 'copy', label: '复制译文', variant: 'secondary' });
            nextCopyButton.element.classList.add('vcp-ui-translator-copy');
            nextCopyButton.element.addEventListener('click', copyTranslation);
            copyBtn.replaceWith(nextCopyButton.element);
            copyBtn.dataset.nextUiReplaced = 'true';
        }

        // 设置弹窗 → VCPUI Modal（内容沿用同一批表单元素，业务读写不变）。
        const settingsFormBody = document.querySelector('.settings-modal-body');
        if (settingsFormBody) {
            document.getElementById('closeSettingsModalBtn')?.remove();
            const footerButtons = [document.getElementById('resetSettingsBtn'), document.getElementById('saveSettingsBtn')].filter(Boolean);
            openNextSettings = () => {
                nextSettingsModal?.close?.();
                settingsFormBody.querySelectorAll('input[type="text"]').forEach(input => {
                    try { V.enhance('Input', input); } catch (error) { console.warn('[Translator] enhance settings input:', error); }
                });
                nextSettingsModal = V.create('Modal', {
                    title: '翻译设置',
                    content: settingsFormBody,
                    actions: footerButtons,
                    closeOnBackdrop: true,
                    onClose: () => settingsModal.classList.add('hidden'),
                });
                document.body.append(nextSettingsModal.element);
            };
            // 保存成功后的 setTimeout(closeSettingsModal, 500) 只是切回 hidden 类，
            // 这里观察旧弹窗类名并同步关闭 VCPUI Modal。
            const settingsObserver = new MutationObserver(() => {
                if (settingsModal.classList.contains('hidden') && nextSettingsModal) nextSettingsModal.close?.();
            });
            settingsObserver.observe(settingsModal, { attributes: true, attributeFilter: ['class'] });
        }

        // Tooltip 通过 VCPUI.create('Tooltip') 创建（由 VCPUI 委托 Web Awesome）。
        [settingsAction?.element, nextTranslate?.element, nextCopyButton?.element].filter(Boolean).forEach(el => {
            const tip = V.create('Tooltip', { trigger: el, content: el.getAttribute('aria-label') || el.title || '操作', placement: 'top' });
            document.body.append(tip.element);
        });
    }
    window.addEventListener('vcp-ui-runtime-ready', buildNextTranslator);

    initialize();
});
