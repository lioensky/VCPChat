/**
 * VCPdesktop - VChat 内部应用注册表 & 启动器
 * 负责：将 VChat 系统内部各子应用（聊天主界面、笔记中心、论坛、翻译、骰子、Canvas、音乐、RAG 监听等）
 *       注册到桌面 Dock 栏中，使用户可以统一从桌面启动这些应用。
 *
 * 图标体系（优先级从高到低）：
 *   1. icon:         静态图标路径（PNG/SVG 文件，默认显示）
 *   2. animatedIcon: 动画图标路径（GIF，hover 时播放）
 *   3. svgIcon:      内联 SVG 字符串（AI 原生生成，支持 currentColor 主题适配）
 *   4. emoji:        备用 emoji（所有图标加载失败时回退）
 *
 * 启动方式通过 IPC 通道 'desktop-launch-vchat-app' 与主进程通信。
 */

'use strict';

(function () {
    const { state } = window.VCPDesktop;

    // ============================================================
    // VChat 内部应用注册表
    // ============================================================

    /**
     * VChat 官方图标路径前缀
     * 图标存放在 assets/iconset/VChatOfficial/ 目录下
     * 从 desktop.html 出发的相对路径为 ../assets/iconset/VChatOfficial/
     */
    const ICON_BASE = '../assets/iconset/VChatOfficial';

    // ============================================================
    // AI 原生 SVG 内联图标
    // 使用 currentColor 实现主题自适应（跟随 CSS --primary-text 等变量）
    // ============================================================
    const SVG_ICONS = {
        chat: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="6" width="40" height="30" rx="6" fill="currentColor" opacity="0.12"/>
            <rect x="4" y="6" width="40" height="30" rx="6" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <path d="M14 40l6-8h-6" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" fill="currentColor" opacity="0.15"/>
            <circle cx="16" cy="21" r="2.5" fill="currentColor"/>
            <circle cx="24" cy="21" r="2.5" fill="currentColor"/>
            <circle cx="32" cy="21" r="2.5" fill="currentColor"/>
        </svg>`,
        notes: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="8" y="4" width="32" height="40" rx="4" fill="currentColor" opacity="0.1"/>
            <rect x="8" y="4" width="32" height="40" rx="4" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <line x1="14" y1="14" x2="34" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="14" y1="21" x2="30" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="14" y1="28" x2="26" y2="28" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M32 30l4-4 4 4-4 4z" fill="currentColor" opacity="0.6"/>
            <line x1="30" y1="36" x2="38" y2="28" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
        memo: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="20" r="14" fill="currentColor" opacity="0.1"/>
            <circle cx="24" cy="20" r="14" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <path d="M16 18c0 0 2-6 8-6s8 6 8 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
            <circle cx="18" cy="22" r="1.5" fill="currentColor"/>
            <circle cx="24" cy="16" r="1.5" fill="currentColor"/>
            <circle cx="30" cy="22" r="1.5" fill="currentColor"/>
            <line x1="18" y1="22" x2="24" y2="16" stroke="currentColor" stroke-width="1.2" opacity="0.4"/>
            <line x1="24" y1="16" x2="30" y2="22" stroke="currentColor" stroke-width="1.2" opacity="0.4"/>
            <line x1="18" y1="22" x2="30" y2="22" stroke="currentColor" stroke-width="1.2" opacity="0.4"/>
            <path d="M18 36v4M24 34v6M30 36v4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>`,
        forum: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="10" width="28" height="20" rx="5" fill="currentColor" opacity="0.1"/>
            <rect x="2" y="10" width="28" height="20" rx="5" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <rect x="18" y="18" width="28" height="20" rx="5" fill="currentColor" opacity="0.08"/>
            <rect x="18" y="18" width="28" height="20" rx="5" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <line x1="8" y1="18" x2="24" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="8" y1="23" x2="20" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="24" y1="26" x2="40" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="24" y1="31" x2="36" y2="31" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
        rag: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="18" fill="currentColor" opacity="0.08"/>
            <circle cx="24" cy="24" r="18" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <circle cx="24" cy="24" r="6" fill="currentColor" opacity="0.2"/>
            <circle cx="24" cy="24" r="6" stroke="currentColor" stroke-width="2" fill="none"/>
            <circle cx="24" cy="24" r="12" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" fill="none" opacity="0.4"/>
            <line x1="24" y1="4" x2="24" y2="10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <line x1="24" y1="38" x2="24" y2="44" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <line x1="4" y1="24" x2="10" y2="24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <line x1="38" y1="24" x2="44" y2="24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>`,
        dice: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="6" width="36" height="36" rx="8" fill="currentColor" opacity="0.1"/>
            <rect x="6" y="6" width="36" height="36" rx="8" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <circle cx="16" cy="16" r="3" fill="currentColor"/>
            <circle cx="32" cy="16" r="3" fill="currentColor"/>
            <circle cx="24" cy="24" r="3" fill="currentColor"/>
            <circle cx="16" cy="32" r="3" fill="currentColor"/>
            <circle cx="32" cy="32" r="3" fill="currentColor"/>
        </svg>`,
        canvas: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="18" fill="currentColor" opacity="0.08"/>
            <circle cx="24" cy="24" r="18" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <circle cx="24" cy="12" r="4" fill="#FF6B6B" opacity="0.8"/>
            <circle cx="14" cy="28" r="4" fill="#4ECDC4" opacity="0.8"/>
            <circle cx="34" cy="28" r="4" fill="#FFE66D" opacity="0.8"/>
            <path d="M8 40l6-14 4 8 6-20 6 16 4-6 6 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.5"/>
        </svg>`,
        translator: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="18" fill="currentColor" opacity="0.08"/>
            <circle cx="24" cy="24" r="18" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <text x="12" y="22" font-size="12" font-weight="bold" fill="currentColor" font-family="sans-serif">A</text>
            <text x="28" y="36" font-size="11" font-weight="bold" fill="currentColor" font-family="sans-serif" opacity="0.7">あ</text>
            <path d="M22 26l6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M26 20l2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
        music: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="36" r="6" fill="currentColor" opacity="0.15"/>
            <circle cx="14" cy="36" r="6" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <circle cx="34" cy="32" r="6" fill="currentColor" opacity="0.15"/>
            <circle cx="34" cy="32" r="6" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <line x1="20" y1="36" x2="20" y2="10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <line x1="40" y1="32" x2="40" y2="6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M20 14l20-6v-2l-20 6z" fill="currentColor" opacity="0.6"/>
            <line x1="20" y1="12" x2="40" y2="6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>`,
        themes: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="18" fill="currentColor" opacity="0.08"/>
            <circle cx="24" cy="24" r="18" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <path d="M24 6c-10 0-18 8-18 18h18V6z" fill="currentColor" opacity="0.2"/>
            <circle cx="18" cy="16" r="3" fill="currentColor" opacity="0.6"/>
            <circle cx="30" cy="16" r="3" fill="currentColor" opacity="0.4"/>
            <circle cx="14" cy="26" r="3" fill="currentColor" opacity="0.5"/>
            <circle cx="34" cy="26" r="3" fill="currentColor" opacity="0.3"/>
            <circle cx="24" cy="34" r="3" fill="currentColor" opacity="0.45"/>
        </svg>`,
        // 独立 Electron App 图标
        toolbox: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="18" width="40" height="26" rx="4" fill="currentColor" opacity="0.1"/>
            <rect x="4" y="18" width="40" height="26" rx="4" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <path d="M16 18V12a4 4 0 014-4h8a4 4 0 014 4v6" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <line x1="4" y1="28" x2="44" y2="28" stroke="currentColor" stroke-width="2" opacity="0.3"/>
            <rect x="20" y="24" width="8" height="8" rx="2" fill="currentColor" opacity="0.3"/>
            <circle cx="24" cy="28" r="2" fill="currentColor"/>
        </svg>`,
        database: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="24" cy="12" rx="16" ry="6" fill="currentColor" opacity="0.12"/>
            <ellipse cx="24" cy="12" rx="16" ry="6" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <path d="M8 12v24c0 3.3 7.2 6 16 6s16-2.7 16-6V12" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <ellipse cx="24" cy="24" rx="16" ry="6" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <ellipse cx="24" cy="36" rx="16" ry="6" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <circle cx="16" cy="24" r="1.5" fill="currentColor" opacity="0.5"/>
            <circle cx="24" cy="24" r="1.5" fill="currentColor" opacity="0.5"/>
            <circle cx="32" cy="24" r="1.5" fill="currentColor" opacity="0.5"/>
        </svg>`,
        // Windows 系统工具图标
        displaySettings: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="4" width="40" height="28" rx="4" fill="currentColor" opacity="0.1"/>
            <rect x="4" y="4" width="40" height="28" rx="4" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <line x1="18" y1="32" x2="18" y2="40" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <line x1="30" y1="32" x2="30" y2="40" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <line x1="12" y1="40" x2="36" y2="40" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="24" cy="18" r="6" stroke="currentColor" stroke-width="2" fill="none" opacity="0.6"/>
            <path d="M24 12v-2M24 26v-2M18 18h-2M32 18h-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>
        </svg>`,
        winSettings: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="18" fill="currentColor" opacity="0.08"/>
            <circle cx="24" cy="24" r="18" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <circle cx="24" cy="24" r="7" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <path d="M24 4v6M24 38v6M4 24h6M38 24h6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M10 10l4.2 4.2M33.8 33.8l4.2 4.2M10 38l4.2-4.2M33.8 14.2L38 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
        </svg>`,
        controlPanel: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="4" width="40" height="40" rx="6" fill="currentColor" opacity="0.08"/>
            <rect x="4" y="4" width="40" height="40" rx="6" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <line x1="12" y1="16" x2="36" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/>
            <line x1="12" y1="24" x2="36" y2="24" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/>
            <line x1="12" y1="32" x2="36" y2="32" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/>
            <circle cx="20" cy="16" r="3" fill="currentColor"/>
            <circle cx="30" cy="24" r="3" fill="currentColor"/>
            <circle cx="16" cy="32" r="3" fill="currentColor"/>
        </svg>`,
        recycleBin: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 16h24l-2 26H14L12 16z" fill="currentColor" opacity="0.1"/>
            <path d="M12 16h24l-2 26H14L12 16z" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <line x1="8" y1="12" x2="40" y2="12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M18 12V8h12v4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            <line x1="20" y1="20" x2="20" y2="36" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
            <line x1="28" y1="20" x2="28" y2="36" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
        </svg>`,
        myComputer: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="6" width="36" height="24" rx="4" fill="currentColor" opacity="0.1"/>
            <rect x="6" y="6" width="36" height="24" rx="4" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <line x1="18" y1="30" x2="18" y2="36" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <line x1="30" y1="30" x2="30" y2="36" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <line x1="14" y1="36" x2="34" y2="36" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <rect x="10" y="10" width="28" height="16" rx="2" fill="currentColor" opacity="0.15"/>
            <path d="M14 40h20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>`,
    };

    /**
     * 所有可用的 VChat 内部子应用定义
     *
     * 每个应用包含：
     *   - id:           唯一标识（用于 Dock 去重）
     *   - name:         显示名称
     *   - icon:         静态图标路径（PNG，默认显示）
     *   - animatedIcon: 动画图标路径（GIF，hover 时播放，可选）
     *   - svgIcon:      内联 SVG 图标字符串（AI 原生生成，支持 CSS 变量主题适配）
     *   - emoji:        备用 emoji 图标（图标加载失败时回退）
     *   - description:  功能描述
     *   - appAction:    主进程执行的动作标识
     */
    const VCHAT_APPS = [
        {
            id: 'vchat-app-main',
            name: 'VChat',
            icon: `${ICON_BASE}/vchat_main.png`,
            animatedIcon: null,
            svgIcon: SVG_ICONS.chat,
            emoji: '💬',
            description: '打开 VChat 聊天主窗口',
            appAction: 'show-main-window',
        },
        {
            id: 'vchat-app-notes',
            name: '用户笔记中心',
            icon: null,
            animatedIcon: `${ICON_BASE}/人类笔记.gif`,
            svgIcon: SVG_ICONS.notes,
            emoji: '📝',
            description: '打开用户笔记管理窗口',
            appAction: 'open-notes-window',
        },
        {
            id: 'vchat-app-memo',
            name: 'AI记忆中心',
            icon: null,
            animatedIcon: `${ICON_BASE}/AI记忆.gif`,
            svgIcon: SVG_ICONS.memo,
            emoji: '🧠',
            description: '打开 AI 记忆图谱 & 备忘录',
            appAction: 'open-memo-window',
        },
        {
            id: 'vchat-app-forum',
            name: '论坛模块',
            icon: null,
            animatedIcon: `${ICON_BASE}/论坛.gif`,
            svgIcon: SVG_ICONS.forum,
            emoji: '🏛️',
            description: '打开 VCP 论坛讨论区',
            appAction: 'open-forum-window',
        },
        {
            id: 'vchat-app-rag-observer',
            name: 'RAG监听',
            icon: null,
            animatedIcon: `${ICON_BASE}/信息流.gif`,
            svgIcon: SVG_ICONS.rag,
            emoji: '📡',
            description: '打开 VCP RAG 信息流监听器',
            appAction: 'open-rag-observer-window',
        },
        {
            id: 'vchat-app-dice',
            name: '丢骰子',
            icon: `${ICON_BASE}/dice.png`,
            animatedIcon: null,
            svgIcon: SVG_ICONS.dice,
            emoji: '🎲',
            description: '打开骰子投掷器模块',
            appAction: 'open-dice-window',
        },
        {
            id: 'vchat-app-canvas',
            name: 'Canvas',
            icon: `${ICON_BASE}/协同.png`,
            animatedIcon: null,
            svgIcon: SVG_ICONS.canvas,
            emoji: '🎨',
            description: '打开 Canvas 协同编辑画布',
            appAction: 'open-canvas-window',
        },
        {
            id: 'vchat-app-translator',
            name: '翻译模块',
            icon: `${ICON_BASE}/翻译.png`,
            animatedIcon: null,
            svgIcon: SVG_ICONS.translator,
            emoji: '🌐',
            description: '打开 AI 翻译工具窗口',
            appAction: 'open-translator-window',
        },
        {
            id: 'vchat-app-music',
            name: '音乐播放器',
            icon: `${ICON_BASE}/音乐.png`,
            animatedIcon: null,
            svgIcon: SVG_ICONS.music,
            emoji: '🎵',
            description: '打开 HIFI 音乐播放器',
            appAction: 'open-music-window',
        },
        {
            id: 'vchat-app-themes',
            name: '主题商店',
            icon: null,
            animatedIcon: `${ICON_BASE}/主题.gif`,
            svgIcon: SVG_ICONS.themes,
            emoji: '🎭',
            description: '打开主题定制与管理',
            appAction: 'open-themes-window',
        },
        {
            id: 'vchat-app-toolbox',
            name: '人类工具箱',
            icon: null,
            animatedIcon: `${ICON_BASE}/工具箱.gif`,
            svgIcon: SVG_ICONS.toolbox,
            emoji: '🧰',
            description: '高级插件管理和调度器（独立应用）',
            appAction: 'launch-human-toolbox',
        },
        {
            id: 'vchat-app-dbmanager',
            name: 'Vchat数据',
            icon: null,
            animatedIcon: `${ICON_BASE}/数据库.gif`,
            svgIcon: SVG_ICONS.database,
            emoji: '🗄️',
            description: '数据库高级管理器（独立应用）',
            appAction: 'launch-vchat-manager',
        },
    ];

    /**
     * Windows 系统工具 — 作为 vchat-app 类型注入 Dock，
     * 使用 appAction: 'open-system-tool:命令' 格式，
     * 由主进程统一处理。
     */
    const SYSTEM_TOOLS = [
        {
            id: 'sys-tool-display-settings',
            name: '显示设置',
            icon: null,
            animatedIcon: null,
            svgIcon: SVG_ICONS.displaySettings,
            emoji: '🖥️',
            description: '打开 Windows 显示设置',
            appAction: 'open-system-tool:ms-settings:display',
        },
        {
            id: 'sys-tool-win-settings',
            name: 'Windows 设置',
            icon: null,
            animatedIcon: null,
            svgIcon: SVG_ICONS.winSettings,
            emoji: '⚙️',
            description: '打开 Windows 系统设置',
            appAction: 'open-system-tool:ms-settings:',
        },
        {
            id: 'sys-tool-control-panel',
            name: '控制面板',
            icon: null,
            animatedIcon: null,
            svgIcon: SVG_ICONS.controlPanel,
            emoji: '🎛️',
            description: '打开 Windows 控制面板',
            appAction: 'open-system-tool:control',
        },
        {
            id: 'sys-tool-recycle-bin',
            name: '回收站',
            icon: null,
            animatedIcon: null,
            svgIcon: SVG_ICONS.recycleBin,
            emoji: '🗑️',
            description: '打开 Windows 回收站',
            appAction: 'open-system-tool:shell:RecycleBinFolder',
        },
        {
            id: 'sys-tool-my-computer',
            name: '我的电脑',
            icon: null,
            animatedIcon: null,
            svgIcon: SVG_ICONS.myComputer,
            emoji: '💻',
            description: '打开此电脑（资源管理器）',
            appAction: 'open-system-tool:shell:MyComputerFolder',
        },
    ];

    // ============================================================
    // 启动 VChat 内部应用
    // ============================================================

    /**
     * 通过 IPC 启动 VChat 内部应用
     * @param {object} appDef - 应用定义对象（来自 VCHAT_APPS）
     */
    async function launchVchatApp(appDef) {
        if (!appDef || !appDef.appAction) {
            console.warn('[VChatApps] Invalid app definition:', appDef);
            return;
        }

        console.log(`[VChatApps] Launching: ${appDef.name} (action: ${appDef.appAction})`);

        if (window.VCPDesktop.status) {
            window.VCPDesktop.status.update('streaming', `正在启动: ${appDef.name}...`);
            window.VCPDesktop.status.show();
        }

        try {
            if (window.electronAPI?.desktopLaunchVchatApp) {
                const result = await window.electronAPI.desktopLaunchVchatApp(appDef.appAction);
                if (result?.success) {
                    console.log(`[VChatApps] Successfully launched: ${appDef.name}`);
                    if (window.VCPDesktop.status) {
                        window.VCPDesktop.status.update('connected', `已启动: ${appDef.name}`);
                        setTimeout(() => window.VCPDesktop.status.hide(), 2000);
                    }
                } else {
                    console.error(`[VChatApps] Launch failed: ${appDef.name}`, result?.error);
                    if (window.VCPDesktop.status) {
                        window.VCPDesktop.status.update('waiting', `启动失败: ${result?.error || '未知错误'}`);
                        setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                    }
                }
            } else {
                console.warn('[VChatApps] desktopLaunchVchatApp API not available');
                if (window.VCPDesktop.status) {
                    window.VCPDesktop.status.update('waiting', '启动接口不可用');
                    setTimeout(() => window.VCPDesktop.status.hide(), 3000);
                }
            }
        } catch (err) {
            console.error(`[VChatApps] Launch error for ${appDef.name}:`, err);
            if (window.VCPDesktop.status) {
                window.VCPDesktop.status.update('waiting', `启动出错: ${err.message}`);
                setTimeout(() => window.VCPDesktop.status.hide(), 3000);
            }
        }
    }

    // ============================================================
    // 将 VChat 内部应用注入到 Dock 系统
    // ============================================================

    /**
     * 将所有 VChat 内部应用注入到 Dock 的 items 列表中。
     * 使用 type: 'vchat-app' 区分于外部快捷方式和内置挂件。
     * 只注入尚未存在的应用（基于 id 去重），保证不会重复。
     */
    function injectVchatAppsToDock() {
        let injectedCount = 0;
        let updatedCount = 0;

        // 合并 VChat 应用和系统工具
        const allApps = [...VCHAT_APPS, ...SYSTEM_TOOLS];

        for (const appDef of allApps) {
            const existing = state.dock.items.find(item => item.id === appDef.id);
            if (existing) {
                // 已存在：同步更新属性（名称/描述/图标等可能在代码中修改过）
                let changed = false;
                if (existing.name !== appDef.name) { existing.name = appDef.name; changed = true; }
                if (existing.emoji !== appDef.emoji) { existing.emoji = appDef.emoji; changed = true; }
                if (existing.description !== appDef.description) { existing.description = appDef.description; changed = true; }
                if (existing.appAction !== appDef.appAction) { existing.appAction = appDef.appAction; changed = true; }
                // 图标仅在用户未自定义时同步（如果是 data: URL 则说明用户自定义了）
                if (existing.icon && !existing.icon.startsWith('data:') && existing.icon !== appDef.icon) {
                    existing.icon = appDef.icon;
                    changed = true;
                }
                // 同步动画图标（animatedIcon 始终从代码定义同步，不受用户自定义影响）
                if (existing.animatedIcon !== appDef.animatedIcon) {
                    existing.animatedIcon = appDef.animatedIcon;
                    changed = true;
                }
                // 同步 SVG 内联图标（始终从代码定义同步）
                if (existing.svgIcon !== appDef.svgIcon) {
                    existing.svgIcon = appDef.svgIcon;
                    changed = true;
                }
                if (changed) updatedCount++;
                continue;
            }

            // 不存在：新增注入
            state.dock.items.push({
                id: appDef.id,
                name: appDef.name,
                icon: appDef.icon,
                animatedIcon: appDef.animatedIcon,
                svgIcon: appDef.svgIcon,
                emoji: appDef.emoji,
                description: appDef.description,
                appAction: appDef.appAction,
                type: 'vchat-app',
            });

            injectedCount++;
        }

        if (injectedCount > 0 || updatedCount > 0) {
            console.log(`[VChatApps] Dock sync: ${injectedCount} new, ${updatedCount} updated`);
            // 触发 Dock 重新渲染
            if (window.VCPDesktop.dock && window.VCPDesktop.dock.render) {
                window.VCPDesktop.dock.render();
            }
            // 保存 Dock 配置以持久化
            if (window.VCPDesktop.dock && window.VCPDesktop.dock.saveDockConfig) {
                window.VCPDesktop.dock.saveDockConfig();
            }
        } else {
            console.log('[VChatApps] All VChat apps in sync, no changes needed');
        }
    }

    /**
     * 获取 VChat 应用定义列表（供外部模块使用）
     */
    function getVchatApps() {
        return VCHAT_APPS;
    }

    /**
     * 根据 appAction 查找应用定义
     */
    function findAppByAction(action) {
        return VCHAT_APPS.find(app => app.appAction === action);
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.vchatApps = {
        list: getVchatApps,
        launch: launchVchatApp,
        inject: injectVchatAppsToDock,
        findByAction: findAppByAction,
        VCHAT_APPS,
        SYSTEM_TOOLS,
    };

})();