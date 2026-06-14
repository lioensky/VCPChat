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
            if (settings.vcpServerUrl && settings.vcpApiKey) {
                vcpServerUrl = settings.vcpServerUrl;
                vcpApiKey = settings.vcpApiKey;
                console.log('Translator config loaded successfully:', { vcpServerUrl, vcpApiKey });
            } else {
                console.error('Failed to load VCP config from settings.');
                alert('无法从主程序加载翻译配置。');
            }
        } catch (error) {
            console.error('Error loading settings via IPC:', error);
            alert('加载配置时出错。');
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
    translateBtn.addEventListener('click', () => {
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
    });

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
    copyBtn.addEventListener('click', () => {
        const textToCopy = translatedTextarea.value;
        if (textToCopy && !translatedTextarea.classList.contains('streaming')) {
            navigator.clipboard.writeText(textToCopy).then(() => {
                copyBtn.innerHTML = '<span class="copy-feedback">已复制!</span>';
                setTimeout(() => {
                    copyBtn.innerHTML = originalCopyBtnIcon;
                }, 2000);
            }).catch(err => {
                console.error('Could not copy text: ', err);
                copyBtn.innerHTML = '<span class="copy-feedback">失败</span>';
                 setTimeout(() => {
                    copyBtn.innerHTML = originalCopyBtnIcon;
                }, 2000);
            });
        }
    });

    initialize();
});
