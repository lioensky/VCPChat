document.addEventListener('DOMContentLoaded', async () => {
    // 获取所有需要的 DOM 元素
    const sourceTextarea = document.getElementById('sourceText');
    const translatedTextarea = document.getElementById('translatedText');
    const targetLanguageSelect = document.getElementById('targetLanguageSelect');
    const customPromptVarInput = document.getElementById('customPromptVar');
    const translateBtn = document.getElementById('translateBtn');
    const copyBtn = document.getElementById('copyBtn');

    // --- Custom Title Bar Elements ---
    const minimizeTranslatorBtn = document.getElementById('minimize-translator-btn');
    const maximizeTranslatorBtn = document.getElementById('maximize-translator-btn');
    const closeTranslatorBtn = document.getElementById('close-translator-btn');

    // 配置和状态变量
    let vcpServerUrl = '';
    let vcpApiKey = '';
    let currentTheme = 'dark'; // 默认是暗色主题
    let abortController = null; // 用于中止 fetch 请求

    // 保存复制按钮原始的 SVG 图标
    const originalCopyBtnIcon = copyBtn.innerHTML;

    // 应用主题的函数 (与主程序同步)
    const applyTheme = (theme) => {
        document.body.classList.toggle('light-theme', theme === 'light');
        currentTheme = theme;
    };

    // 从主进程加载配置
    async function loadConfig() {
        try {
            const settings = await window.electronAPI.loadSettings();
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

    // --- 直接调用 VCP API 进行翻译 ---
    async function performDirectTranslation(messages, modelConfig) {
        if (abortController) {
            abortController.abort(); // Abort previous request if any
        }
        abortController = new AbortController();
        const signal = abortController.signal;

        let fullTranslation = '';
        translatedTextarea.value = '翻译中...';
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
                    max_tokens: 50000,
                    stream: false // Use non-streaming request
                }),
                signal: signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`服务器错误: ${response.status} ${response.statusText} - ${errorText}`);
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

        const targetLanguage = targetLanguageSelect.value;
        const customPromptVar = customPromptVarInput.value.trim();

        let systemPrompt = `你是一个专业的翻译助手。请将用户提供的文本翻译成${targetLanguageSelect.options[targetLanguageSelect.selectedIndex].text}。`;
        if (customPromptVar) {
            systemPrompt += ` 额外要求: ${customPromptVar}。`;
        }
        systemPrompt += ` 仅返回翻译结果，不要包含任何解释或额外信息。`;

        const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: sourceText }];
        const modelConfig = { model: 'gemini-2.5-flash-lite-preview-06-17', temperature: 0.7 };

        performDirectTranslation(messages, modelConfig);
    });

    // --- Initialization and Theme Handling ---
    async function initialize() {
        await loadConfig(); // Load VCP settings first

        // Then initialize theme
        try {
            const theme = await window.electronAPI.getCurrentTheme();
            applyTheme(theme || 'dark');
        } catch (error) {
            console.error('Failed to get initial theme:', error);
            applyTheme('dark'); // Fallback
        }

        if (window.electronAPI) {
            window.electronAPI.onThemeUpdated(applyTheme);
        } else {
            console.warn('electronAPI not found. Theme updates will not work.');
        }

        // --- Custom Title Bar Listeners ---
        minimizeTranslatorBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.minimizeWindow();
        });

        maximizeTranslatorBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.maximizeWindow();
        });

        closeTranslatorBtn.addEventListener('click', () => {
            window.close();
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
