// 设置里的字号和三个字体写到 VCP 自己的令牌上。
// 主窗口和子窗口（文坊、笔记、施工台）都加载这一个脚本：
// - 字体：界面字体、正文字体、代码字体分别写 <html> 上的 --uttu-font-body / --uttu-font-reading / --uttu-font-mono，
//   只在和默认不同时写，等于默认就删掉。默认值只在 styles/ui-system/uttu-tokens.css，这里的表里不写 MiSans、Cascadia
//   这些默认字体（默认项的字体栈是 null）。“恢复默认”就是三个覆盖全部删掉。
// - 字号：子窗口没有外观引擎，这里把档位照抄到自己的 <html data-vcp-font-scale>；换算成 --uttu-scale 的规则在
//   uttu-tokens.css。主窗口的档位由外观引擎自己写，这里不碰。
// 主窗口：外观引擎在本脚本之前加载；引擎每次应用外观（含设置页的草稿预览）都发 vcp-appearance-changed，这里跟着改令牌。
// 子窗口：读主窗口存的外观缓存（localStorage 的 vcpchat.appearanceProfile）；几个窗口都从本机文件打开、同一个会话，
// 共用这份存储，主窗口保存时其他窗口马上收到 storage 事件。
// 普通脚本，放在 <head> 里样式表后面，首帧就是对的；不依赖别的模块。
(() => {
    const KEY = 'vcpchat.appearanceProfile';
    const SCALES = new Set(['small', 'large', 'xlarge']);
    const root = document.documentElement;
    // 自定义字体名后面接回的后备字体（不是默认字体本身）。
    const BODY_FALLBACK = '"MiSans", "Noto Sans SC", "Microsoft YaHei", sans-serif';
    const MONO_FALLBACK = 'Consolas, ui-monospace, monospace';
    // 预设名和字体栈照样张 的 FONTS 表；stack 为 null 的是默认项。
    const FONTS = Object.freeze({
        body: Object.freeze({
            token: '--uttu-font-body', key: 'fontBody', customKey: 'fontBodyCustom', fallback: BODY_FALLBACK,
            stacks: Object.freeze({
                misans: null,
                yahei: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
                dengxian: 'DengXian, "Microsoft YaHei", sans-serif',
            }),
        }),
        reading: Object.freeze({
            token: '--uttu-font-reading', key: 'fontReading', customKey: 'fontReadingCustom', fallback: BODY_FALLBACK,
            // 默认是清晰黑体（uttu-tokens.css 里的字体栈），“跟随界面字体”改成写回界面字体令牌。
            stacks: Object.freeze({
                clear: null,
                follow: 'var(--uttu-font-body)',
                misans: BODY_FALLBACK,
                yahei: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
                songti: '"Noto Serif SC", "Source Han Serif SC", SimSun, serif',
                kaiti: 'KaiTi, STKaiti, serif',
            }),
        }),
        mono: Object.freeze({
            token: '--uttu-font-mono', key: 'fontMono', customKey: 'fontMonoCustom', fallback: MONO_FALLBACK,
            stacks: Object.freeze({
                cascadia: null,
                consolas: 'Consolas, "Courier New", monospace',
                jetbrains: '"JetBrains Mono", Consolas, monospace',
            }),
        }),
    });

    // 自定义字体名只留字体名该有的字符（规则同 appearance-engine.js 和 appSettingsManager.js），最长 60 字。
    // 逗号隔开的几个名字各自加引号，后面接回后备字体。
    function customStack(kind, raw) {
        const name = String(raw || '').replace(/[\u0000-\u001f"'`;:(){}[\]<>\\]/g, '').replace(/\s+/g, ' ')
            .trim().slice(0, 60);
        const families = name.split(',').map(part => part.trim()).filter(Boolean);
        return families.length ? `${families.map(part => `"${part}"`).join(', ')}, ${FONTS[kind].fallback}` : null;
    }

    // 外观设置 → 这个字体令牌该写的值；null 表示用默认（删掉覆盖）。
    function fontStack(kind, profile) {
        const font = FONTS[kind];
        const choice = profile && typeof profile[font.key] === 'string' ? profile[font.key] : '';
        if (choice === 'custom') return customStack(kind, profile[font.customKey]);
        return Object.prototype.hasOwnProperty.call(font.stacks, choice) ? font.stacks[choice] : null;
    }

    function setToken(name, value) {
        if (value) {
            if (root.style.getPropertyValue(name).trim() !== value) root.style.setProperty(name, value);
        } else {
            root.style.removeProperty(name);
        }
    }

    function applyFonts(profile) {
        for (const kind of Object.keys(FONTS)) setToken(FONTS[kind].token, fontStack(kind, profile));
    }

    function applyScale(profile) {
        const scale = profile && SCALES.has(profile.fontScale) ? profile.fontScale : '';
        if (scale) root.dataset.vcpFontScale = scale;
        else delete root.dataset.vcpFontScale;
    }

    // 代码配色：写到 <html data-uttu-code-scheme>，颜色在 styles/ui-system/uttu-code-scheme.css；
    // 默认那套（VS Code 深色）不写。
    const CODE_SCHEMES = new Set(['vscode-light', 'one-dark', 'github-dark']);
    function applyCodeScheme(profile) {
        const scheme = profile && CODE_SCHEMES.has(profile.codeScheme) ? profile.codeScheme : '';
        if (scheme) root.dataset.uttuCodeScheme = scheme;
        else delete root.dataset.uttuCodeScheme;
    }

    function readCache() {
        try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
    }

    window.UTTUAppearanceTokens = Object.freeze({ FONTS, fontStack, applyFonts, applyCodeScheme });

    const engine = window.VCPAppearance;
    if (engine) {
        const profile = engine.getCurrent?.() || readCache();
        applyFonts(profile);
        applyCodeScheme(profile);
        window.addEventListener('vcp-appearance-changed', (event) => {
            applyFonts(event.detail?.profile);
            applyCodeScheme(event.detail?.profile);
        });
        return;
    }
    const applyCache = () => {
        const profile = readCache();
        applyScale(profile);
        applyFonts(profile);
        applyCodeScheme(profile);
    };
    applyCache();
    window.addEventListener('storage', (event) => {
        if (event.key === KEY || event.key === null) applyCache();
    });
})();
