const api = window.utilityAPI || window.electronAPI;

document.addEventListener('DOMContentLoaded', async () => {
    // 获取所有需要的 DOM 元素
    const sourceTextarea = document.getElementById('sourceText');
    const translatedTextarea = document.getElementById('translatedText');
    const targetLanguageList = document.getElementById('targetLanguageList');
    const modelModeList = document.getElementById('modelModeList');
    const customPromptVarInput = document.getElementById('customPromptVar');
    const customLanguageInput = document.getElementById('customLanguageInput');
    const extraPromptBtn = document.getElementById('extraPromptBtn');
    const extraPromptRow = document.getElementById('extraPromptRow');
    const clearSourceBtn = document.getElementById('clearSourceBtn');
    const translateBtn = document.getElementById('translateBtn');
    const copyBtn = document.getElementById('copyBtn');
    const pageTitle = document.getElementById('pageTitle');
    const translatorSummary = document.getElementById('translatorSummary');
    const translatorNotice = document.getElementById('translatorNotice');
    const sourceCount = document.getElementById('sourceCount');
    const openSettingsBtn = document.getElementById('openSettingsBtn');

    // --- Window Control Elements ---
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

    const MODE_LABELS = {
        fast: '快速',
        balanced: '均衡',
        quality: '质量'
    };

    const COPIED_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

    // 配置和状态变量
    let vcpServerUrl = '';
    let vcpApiKey = '';
    let currentTheme = 'dark'; // 默认是暗色主题
    let abortController = null; // 用于中止 fetch 请求
    let translatorSettings = structuredClone(DEFAULT_TRANSLATOR_SETTINGS);
    let activeLanguage = 'en';
    let activeMode = 'fast';
    let settingsLoaded = false; // 读取成功前不写回，避免用默认值覆盖用户的设置文件
    let settingsSaveQueue = Promise.resolve();
    let targetLanguageSaveTimer = null;

    // 保存复制按钮原始的 SVG 图标
    const originalCopyBtnIcon = copyBtn.innerHTML;

    const cloneDefaultSettings = () => structuredClone(DEFAULT_TRANSLATOR_SETTINGS);

    const normalizeTargetLanguage = (value) => (typeof value?.id === 'string'
        ? { id: value.id, custom: typeof value.custom === 'string' ? value.custom : '' }
        : null);

    const normalizeTranslatorSettings = (settings = {}) => ({
        models: {
            ...DEFAULT_TRANSLATOR_SETTINGS.models,
            ...(settings.models || {})
        },
        stream: Boolean(settings.stream),
        targetLanguage: normalizeTargetLanguage(settings.targetLanguage)
    });

    const getModelName = (mode) => translatorSettings.models[mode] || DEFAULT_TRANSLATOR_SETTINGS.models[mode] || DEFAULT_TRANSLATOR_SETTINGS.models.balanced;

    const getSelectedModelConfig = () => ({ model: getModelName(activeMode), temperature: 0.7, stream: translatorSettings.stream });

    const getLanguageLabel = (language) => {
        const item = targetLanguageList.querySelector(`[data-language="${language}"] .nav-label`);
        return item ? item.textContent.trim() : language;
    };

    const showNotice = (message, type = 'error') => {
        translatorNotice.textContent = message;
        translatorNotice.dataset.type = type;
        translatorNotice.hidden = !message;
    };

    const clearNotice = () => showNotice('');

    const setResultState = (state) => {
        if (state) {
            translatedTextarea.dataset.state = state;
        } else {
            delete translatedTextarea.dataset.state;
        }
    };

    // 自定义语言时，标题后面直接接一个输入框，读起来就是“翻译为 ____”
    const renderHeader = () => {
        const isCustom = activeLanguage === 'custom';
        pageTitle.textContent = isCustom ? '翻译为' : `翻译为${getLanguageLabel(activeLanguage)}`;
        customLanguageInput.hidden = !isCustom;

        translatorSummary.replaceChildren(...[
            MODE_LABELS[activeMode],
            getModelName(activeMode),
            translatorSettings.stream ? '流式输出' : '完整返回'
        ].map((text) => {
            const item = document.createElement('span');
            item.className = 'intro-item';
            item.textContent = text;
            return item;
        }));
    };

    const updateSourceCount = () => {
        const length = sourceTextarea.value.length;
        sourceCount.textContent = String(length);
        sourceCount.hidden = length === 0;
        clearSourceBtn.hidden = length === 0;
    };

    // 只有真正的译文才能复制：空白、进行中和失败提示都不算
    const updateCopyState = () => {
        copyBtn.disabled = !translatedTextarea.value
            || translatedTextarea.classList.contains('streaming')
            || translatedTextarea.dataset.state === 'error';
    };

    const setExtraPromptOpen = (open) => {
        extraPromptRow.hidden = !open;
        extraPromptBtn.setAttribute('aria-expanded', String(open));
    };

    const updateExtraPromptIndicator = () => {
        extraPromptBtn.classList.toggle('has-value', Boolean(customPromptVarInput.value.trim()));
    };

    const syncRadioGroup = (group, attribute, value) => {
        group.querySelectorAll('.nav-item').forEach((item) => {
            const checked = item.dataset[attribute] === value;
            item.setAttribute('aria-checked', String(checked));
            item.tabIndex = checked ? 0 : -1;
        });
    };

    const selectLanguage = (language) => {
        activeLanguage = language;
        syncRadioGroup(targetLanguageList, 'language', language);
        renderHeader();
    };

    const modeItems = () => Array.from(modelModeList.querySelectorAll('.menu-item'));

    const selectMode = (mode) => {
        activeMode = mode;
        modelModeList.querySelectorAll('[data-mode]').forEach((item) => {
            item.setAttribute('aria-checked', String(item.dataset.mode === mode));
        });
        const label = `模型：${MODE_LABELS[mode] || mode}`;
        settingsTranslatorBtn.title = label;
        settingsTranslatorBtn.setAttribute('aria-label', label);
        renderHeader();
    };

    const refreshModelModeLabels = () => {
        modelModeList.querySelectorAll('[data-mode]').forEach((item) => {
            item.querySelector('[data-model-name]').textContent = getModelName(item.dataset.mode);
        });
        renderHeader();
    };

    const isModeMenuOpen = () => !modelModeList.hidden;

    const openModeMenu = () => {
        modelModeList.hidden = false;
        settingsTranslatorBtn.setAttribute('aria-expanded', 'true');
        const checked = modelModeList.querySelector('[aria-checked="true"]') || modeItems()[0];
        checked.focus();
    };

    const closeModeMenu = ({ restoreFocus = false } = {}) => {
        if (!isModeMenuOpen()) return;
        modelModeList.hidden = true;
        settingsTranslatorBtn.setAttribute('aria-expanded', 'false');
        if (restoreFocus) settingsTranslatorBtn.focus();
    };

    // 方向键在单选组内移动并选中
    const handleRadioKeydown = (group, onSelect) => (event) => {
        const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        const items = Array.from(group.querySelectorAll('.nav-item'));
        const index = items.indexOf(document.activeElement);
        if (index < 0) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = items.length - 1;
        else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % items.length;
        else nextIndex = (index - 1 + items.length) % items.length;
        items[nextIndex].focus();
        onSelect(items[nextIndex]);
    };

    const fillSettingsForm = (settings = translatorSettings) => {
        fastModelInput.value = settings.models.fast;
        balancedModelInput.value = settings.models.balanced;
        qualityModelInput.value = settings.models.quality;
        streamModeToggle.checked = settings.stream;
        settingsSaveStatus.textContent = '';
    };

    const currentTargetLanguage = () => ({ id: activeLanguage, custom: customLanguageInput.value.trim() });

    // 所有写入排队进行，语言切换和设置对话框不会同时写同一个文件
    const queueSettingsSave = (settings) => {
        const run = settingsSaveQueue.then(() => api.saveTranslatorSettings(settings));
        settingsSaveQueue = run.catch(() => {});
        return run;
    };

    // 目标语言（含自定义文字）随翻译设置一起保存，下次打开时恢复
    const saveTargetLanguage = () => {
        clearTimeout(targetLanguageSaveTimer);
        targetLanguageSaveTimer = null;
        if (!settingsLoaded || typeof api?.saveTranslatorSettings !== 'function') return;
        translatorSettings.targetLanguage = currentTargetLanguage();
        queueSettingsSave({ ...translatorSettings }).then((result) => {
            if (!result?.success) console.warn('Failed to save target language:', result?.error);
        }).catch((error) => console.error('Error saving target language:', error));
    };

    const scheduleTargetLanguageSave = () => {
        clearTimeout(targetLanguageSaveTimer);
        targetLanguageSaveTimer = setTimeout(saveTargetLanguage, 400);
    };

    const restoreTargetLanguage = () => {
        const saved = translatorSettings.targetLanguage;
        if (!saved) return;
        customLanguageInput.value = saved.custom;
        if (targetLanguageList.querySelector(`[data-language="${CSS.escape(saved.id)}"]`)) {
            selectLanguage(saved.id);
        }
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
                showNotice('无法从主程序加载翻译配置。');
            }
        } catch (error) {
            console.error('Error loading settings via IPC:', error);
            showNotice('加载配置时出错。');
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
                restoreTargetLanguage();
                settingsLoaded = true;
            } else {
                console.warn('Failed to load translator settings, using defaults:', result?.error);
                translatorSettings = cloneDefaultSettings();
            }
        } catch (error) {
            console.error('Error loading translator settings:', error);
            translatorSettings = cloneDefaultSettings();
        } finally {
            refreshModelModeLabels();
        }
    }

    async function saveTranslatorSettingsFromForm() {
        clearTimeout(targetLanguageSaveTimer);
        targetLanguageSaveTimer = null;
        const nextSettings = normalizeTranslatorSettings({ ...readSettingsForm(), targetLanguage: currentTargetLanguage() });
        setSettingsStatus('保存中...', 'pending');
        saveSettingsBtn.disabled = true;

        try {
            if (typeof api?.saveTranslatorSettings !== 'function') {
                throw new Error('当前预加载 API 未暴露保存翻译设置接口。');
            }

            const result = await queueSettingsSave(nextSettings);
            if (!result?.success) {
                throw new Error(result?.error || '保存失败。');
            }

            translatorSettings = normalizeTranslatorSettings(result.settings || nextSettings);
            settingsLoaded = true;
            refreshModelModeLabels();
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
        // 被新请求取代或被清空的旧请求不再改动界面
        const isCurrent = () => abortController?.signal === signal;

        translatedTextarea.value = modelConfig.stream ? '正在连接流式翻译...' : '翻译中...';
        translatedTextarea.classList.add('streaming');
        setResultState('');
        updateCopyState();

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
            if (signal.aborted) {
                console.log('Translation request was aborted.');
                if (isCurrent()) translatedTextarea.value = '翻译已取消。';
            } else if (isCurrent()) {
                console.error('Error during direct translation fetch:', error);
                translatedTextarea.value = `翻译请求失败: ${error.message}`;
                setResultState('error');
            }
        } finally {
            if (isCurrent()) {
                translatedTextarea.classList.remove('streaming');
                abortController = null;
                updateCopyState();
            }
        }
    }

    // --- 为翻译按钮添加点击事件 ---
    translateBtn.addEventListener('click', () => {
        const sourceText = sourceTextarea.value.trim();
        if (!sourceText) {
            showNotice('请输入要翻译的文本。', 'warning');
            sourceTextarea.focus();
            return;
        }
        if (!vcpServerUrl || !vcpApiKey) {
            showNotice('VCP 服务器 URL 或 API Key 未配置，请检查主程序设置。');
            return;
        }

        const targetLanguageValue = activeLanguage;
        const customPromptVar = customPromptVarInput.value.trim();
        let targetLanguageText = '';

        if (targetLanguageValue === 'custom') {
            targetLanguageText = customLanguageInput.value.trim();
            if (!targetLanguageText) {
                showNotice('请先填写目标语言。', 'warning');
                customLanguageInput.focus();
                return;
            }
        } else {
            targetLanguageText = getLanguageLabel(targetLanguageValue);
        }

        clearNotice();

        let systemPrompt = `你是一个专业的翻译助手。请将用户提供的文本翻译成${targetLanguageText}。`;
        // 附加要求有内容时，作为额外要求加入提示词
        if (customPromptVar) {
            systemPrompt += ` 额外要求: ${customPromptVar}。`;
        }
        systemPrompt += ` 仅返回翻译结果，不要包含任何解释或额外信息。`;

        const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: sourceText }];
        const modelConfig = getSelectedModelConfig();

        performDirectTranslation(messages, modelConfig);
    });

    // --- Sidebar Listeners ---
    targetLanguageList.addEventListener('click', (event) => {
        const item = event.target.closest('.nav-item');
        if (!item) return;
        selectLanguage(item.dataset.language);
        scheduleTargetLanguageSave();
        if (item.dataset.language === 'custom' && !customLanguageInput.value.trim()) customLanguageInput.focus();
    });
    targetLanguageList.addEventListener('keydown', handleRadioKeydown(targetLanguageList, (item) => {
        selectLanguage(item.dataset.language);
        scheduleTargetLanguageSave();
    }));

    // --- Model Menu ---
    settingsTranslatorBtn.addEventListener('click', () => {
        if (isModeMenuOpen()) closeModeMenu();
        else openModeMenu();
    });

    settingsTranslatorBtn.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' && !isModeMenuOpen()) {
            event.preventDefault();
            openModeMenu();
        }
    });

    modelModeList.addEventListener('click', (event) => {
        const item = event.target.closest('[data-mode]');
        if (!item) return;
        selectMode(item.dataset.mode);
        closeModeMenu({ restoreFocus: true });
    });

    modelModeList.addEventListener('keydown', (event) => {
        const items = modeItems();
        const index = items.indexOf(document.activeElement);
        let nextIndex = null;
        if (event.key === 'ArrowDown') nextIndex = (index + 1) % items.length;
        else if (event.key === 'ArrowUp') nextIndex = (index - 1 + items.length) % items.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = items.length - 1;
        else if (event.key === 'Tab') closeModeMenu();
        if (nextIndex === null) return;
        event.preventDefault();
        items[nextIndex].focus();
    });

    document.addEventListener('pointerdown', (event) => {
        if (isModeMenuOpen() && !event.target.closest('.menu-anchor')) closeModeMenu();
    });

    openSettingsBtn.addEventListener('click', () => {
        closeModeMenu();
        openSettingsModal();
    });

    // --- Input Listeners ---
    sourceTextarea.addEventListener('input', updateSourceCount);
    customLanguageInput.addEventListener('input', () => {
        clearNotice();
        scheduleTargetLanguageSave();
    });
    customLanguageInput.addEventListener('change', saveTargetLanguage);
    window.addEventListener('pagehide', () => {
        if (targetLanguageSaveTimer) saveTargetLanguage();
    });
    customPromptVarInput.addEventListener('input', updateExtraPromptIndicator);

    extraPromptBtn.addEventListener('click', () => {
        const open = extraPromptRow.hidden;
        setExtraPromptOpen(open);
        if (open) customPromptVarInput.focus();
    });

    clearSourceBtn.addEventListener('click', () => {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
        sourceTextarea.value = '';
        translatedTextarea.value = '';
        translatedTextarea.classList.remove('streaming');
        setResultState('');
        clearNotice();
        updateSourceCount();
        updateCopyState();
        sourceTextarea.focus();
    });

    [sourceTextarea, customPromptVarInput, customLanguageInput].forEach((field) => {
        field.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                translateBtn.click();
            }
        });
    });

    // --- Settings Modal Listeners ---
    closeSettingsModalBtn.addEventListener('click', closeSettingsModal);
    settingsModalBackdrop.addEventListener('click', closeSettingsModal);
    saveSettingsBtn.addEventListener('click', saveTranslatorSettingsFromForm);
    resetSettingsBtn.addEventListener('click', () => {
        fillSettingsForm(cloneDefaultSettings());
        setSettingsStatus('已恢复默认，点击保存后生效。', 'pending');
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (isModeMenuOpen()) {
            closeModeMenu({ restoreFocus: true });
        } else if (!settingsModal.classList.contains('hidden')) {
            closeSettingsModal();
        }
    });

    // --- Initialization and Theme Handling ---
    async function initialize() {
        selectLanguage(activeLanguage);
        selectMode(activeMode);
        updateSourceCount();
        updateCopyState();

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

        // --- Window Control Listeners ---
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
    const restoreCopyBtn = () => {
        copyBtn.innerHTML = originalCopyBtnIcon;
        copyBtn.classList.remove('is-copied');
        copyBtn.title = '复制译文';
    };

    copyBtn.addEventListener('click', () => {
        const textToCopy = translatedTextarea.value;
        if (textToCopy && !copyBtn.disabled) {
            navigator.clipboard.writeText(textToCopy).then(() => {
                copyBtn.innerHTML = COPIED_ICON;
                copyBtn.classList.add('is-copied');
                copyBtn.title = '已复制';
                setTimeout(restoreCopyBtn, 2000);
            }).catch(err => {
                console.error('Could not copy text: ', err);
                showNotice('复制失败，请手动选择译文复制。');
            });
        }
    });

    initialize();
});
