/**
 * VoiceComposerView: 主输入框语音交互视图层
 * 实现渐进式展开活动栏（Activity Bar）
 * 包含：32px 紧凑麦克风触发器、展开式取消按钮、零重渲染 SVG 动态波形、停止按钮与草稿冲突插入操作。
 */

function getVoiceWaveformClass() {
    if (typeof window !== 'undefined') {
        if (window.VcpVoice?.VoiceWaveform) return window.VcpVoice.VoiceWaveform;
        if (window.VoiceWaveform) return window.VoiceWaveform;
    }
    if (typeof require === 'function') {
        try {
            return require('./voiceWaveform').VoiceWaveform;
        } catch (_) {}
    }
    return null;
}

// ============================================================================
// 图标生成器（lucide，经 lucide-adapter 产出）
// ============================================================================
function createVoiceIcon(name, size) {
    if (window.VCPIcons?.create) return window.VCPIcons.create(name, { size });
    const span = document.createElement('span');
    span.className = 'vcp-ui-icon';
    span.setAttribute('aria-hidden', 'true');
    span.style.setProperty('--vcp-ui-icon-size', `${size}px`);
    span.textContent = name;
    return span;
}

// 麦克风保留原先的细线手绘图形，Lucide 的 mic 偏粗
function createMicrophoneSvg(size = 18) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '5');
    rect.setAttribute('y', '1.5');
    rect.setAttribute('width', '6');
    rect.setAttribute('height', '9');
    rect.setAttribute('rx', '3');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2.35 8.675C3.075 11.3 5.2 13.125 8 13.125C10.8 13.125 12.925 11.3 13.65 8.675M8 13.125V15');

    svg.append(rect, path);
    return svg;
}

function createCloseSvg(size = 14) {
    return createVoiceIcon('x', size);
}

function createStopSvg(size = 14) {
    const icon = createVoiceIcon('square', size);
    // 停止键保持实心方块
    icon.setAttribute('fill', 'currentColor');
    return icon;
}

class VoiceComposerView {
    constructor() {
        this.button = null;
        this.activityBar = null;
        this.cancelBtn = null;
        this.stopBtn = null;
        this.insertBtn = null;
        this.centerSlot = null;
        this.waveformContainer = null;
        this.activityMessage = null;
        this.waveform = null;
        this.actionsContainer = null;

        this.bubbleDismissTimer = null;
        this.bubbleRemoveTimer = null;
        this.disposers = [];
        this.currentPhase = 'idle';
    }

    ensureStyles() {
        if (typeof document === 'undefined') return;
        const styleId = 'vcp-chat-voice-composer-style';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
#mainVoiceInputBtn {
    /* .trigger { width: 28px; padding: 0 }，18px 线性麦克风，无描边幽灵按钮 */
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-left: auto !important;
    margin-right: 6px !important;
    border-radius: 8px;
    border: 0;
    background: transparent;
    color: var(--vcp-ui-text-2, #a7afb1);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
    box-sizing: border-box;
    padding: 0;
    flex-shrink: 0;
}
html .vcp-ui-scope .chat-input-actions:has(#mainVoiceInputBtn) :is(#sendMessageBtn, .chat-send-button),
html .vcp-ui-scope .chat-input-actions #mainVoiceInputBtn ~ :is(#sendMessageBtn, .chat-send-button),
html .vcp-ui-scope .chat-input-actions #mainVoiceInputBtn + :is(#sendMessageBtn, .chat-send-button),
.chat-input-actions:has(#mainVoiceInputBtn) :is(#sendMessageBtn, .chat-send-button),
.chat-input-actions #mainVoiceInputBtn ~ :is(#sendMessageBtn, .chat-send-button),
.chat-input-actions #mainVoiceInputBtn + :is(#sendMessageBtn, .chat-send-button) {
    margin-left: 0 !important;
}
#mainVoiceInputBtn:hover:not(:disabled) {
    background: var(--vcp-ui-interactive-hover, rgba(127, 127, 127, 0.16));
    color: var(--vcp-ui-text-0, currentColor);
}
#mainVoiceInputBtn svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.2s ease;
}
#mainVoiceInputBtn.stt-mode-active {
    background: #ff4f8b !important;
    color: #ffffff !important;
    animation: vcp-voice-pulse-pink 2.4s ease-in-out infinite;
}
#mainVoiceInputBtn.stt-mode-active svg {
    stroke: #ffffff !important;
    transform: scale(1.08);
}
#mainVoiceInputBtn.audio-record-mode-active {
    background: #f39c12 !important;
    color: #ffffff !important;
    animation: vcp-voice-pulse-orange 2.4s ease-in-out infinite;
}
#mainVoiceInputBtn.audio-record-mode-active svg {
    stroke: #ffffff !important;
    transform: scale(1.08);
}

@keyframes vcp-voice-pulse-pink {
    0% { box-shadow: 0 0 0 0 rgba(255, 79, 139, 0.65); transform: scale(0.96); }
    30% { box-shadow: 0 0 0 10px rgba(255, 79, 139, 0); transform: scale(1.04); }
    60% { box-shadow: 0 0 0 5px rgba(255, 79, 139, 0.2); transform: scale(1); }
    100% { box-shadow: 0 0 0 0 rgba(255, 79, 139, 0); transform: scale(0.96); }
}
@keyframes vcp-voice-pulse-orange {
    0% { box-shadow: 0 0 0 0 rgba(243, 156, 18, 0.65); transform: scale(0.96); }
    30% { box-shadow: 0 0 0 10px rgba(243, 156, 18, 0); transform: scale(1.04); }
    60% { box-shadow: 0 0 0 5px rgba(243, 156, 18, 0.2); transform: scale(1); }
    100% { box-shadow: 0 0 0 0 rgba(243, 156, 18, 0); transform: scale(0.96); }
}

#mainVoiceInputBtn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    pointer-events: none;
}

.vcp-mic-menu {
    position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 1000; width: 300px; padding: 6px;
    border-radius: 12px; background: var(--vcp-ui-surface-raised, var(--secondary-bg, #2b2f31));
    color: var(--vcp-ui-text-0, var(--primary-text, #e6e9ea));
    border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.25)); box-shadow: 0 8px 24px rgba(0,0,0,.28);
}
.vcp-mic-menu-title { padding: 4px 8px 6px; font-size: 13px; opacity: .55; }
.vcp-mic-menu-item {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 8px;
    background: transparent; color: inherit; font: inherit; font-size: 14px; line-height: 20px; text-align: left; cursor: pointer;
}
.vcp-mic-menu-item:hover, .vcp-mic-menu-item:focus-visible, .vcp-mic-menu-item[aria-checked="true"] { background: var(--vcp-ui-interactive-hover, rgba(127,127,127,.16)); outline: none; }
.vcp-mic-menu-item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vcp-mic-menu-item .check { flex: none; width: 16px; color: var(--vcp-ui-accent, #4c8dff); }
.vcp-mic-menu-note { padding: 6px 8px 2px; font-size: 12px; opacity: .55; border-top: 1px solid var(--vcp-ui-border, rgba(127,127,127,.2)); margin-top: 4px; }

/* 展开活动栏（Activity Bar / captureRow） */
html .vcp-ui-scope .chat-input-actions.vcp-voice-expanded > :not(#vcpVoiceActivityBar):not(#sendMessageBtn):not(.chat-send-button),
.chat-input-actions.vcp-voice-expanded > :not(#vcpVoiceActivityBar):not(#sendMessageBtn):not(.chat-send-button) {
    display: none !important;
}

.vcp-voice-activity-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1 1 0;
    width: 0;
    min-width: 0;
    min-height: 34px;
    box-sizing: border-box;
    padding: 0 4px;
    margin-right: 6px;
    animation: vcp-voice-slide-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes vcp-voice-slide-in {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
}

/* 圆形按钮样式 */
.vcp-voice-round-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--vcp-ui-border, rgba(255, 255, 255, 0.10));
    background: var(--vcp-ui-surface-2, rgba(255, 255, 255, 0.06));
    color: var(--vcp-ui-text-2, #a7afb1);
    cursor: pointer;
    flex: none;
    box-sizing: border-box;
    transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

.vcp-voice-round-btn:hover:not(:disabled) {
    background: var(--vcp-ui-interactive-hover, rgba(255, 255, 255, 0.14));
    color: var(--vcp-ui-text-0, #f2f0e9);
    border-color: var(--vcp-ui-border-strong, rgba(255, 255, 255, 0.20));
}

.vcp-voice-cancel-btn:hover:not(:disabled) {
    border-color: rgba(235, 87, 87, 0.40);
    background: rgba(235, 87, 87, 0.12);
    color: #ff5c5c;
}

.vcp-voice-stop-btn {
    border-color: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 45%, transparent);
    background: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 12%, transparent);
    color: var(--vcp-ui-accent, #ff4f8b);
}

.vcp-voice-stop-btn:hover:not(:disabled) {
    background: var(--vcp-ui-accent, #ff4f8b);
    border-color: var(--vcp-ui-accent, #ff4f8b);
    color: #ffffff;
    box-shadow: 0 0 10px color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 35%, transparent);
}

.vcp-voice-center-slot {
    flex: 1 1 0;
    width: 0;
    min-width: 0;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

.vcp-voice-waveform-container {
    display: flex;
    align-items: center;
    flex: 1 1 0;
    width: 0;
    min-width: 24px;
    height: 24px;
    color: var(--vcp-ui-accent, #ff4f8b);
}

.vcp-voice-waveform-container.mode-audio-record {
    color: #f39c12;
}

.vcp-voice-waveform-svg {
    display: block;
    width: 100%;
    height: 24px;
    min-width: 24px;
    color: inherit;
}

.vcp-voice-activity-message {
    font-size: 12px;
    color: var(--vcp-ui-text-2, #a7afb1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 0;
    min-width: 0;
}

.vcp-voice-action-slot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    height: 32px;
    gap: 8px;
}

.vcp-voice-retry-btn {
    border-color: var(--vcp-ui-border, rgba(255, 255, 255, 0.12));
    background: var(--vcp-ui-surface-2, rgba(255, 255, 255, 0.06));
    color: var(--vcp-ui-text-1, #f2f0e9);
}

.vcp-voice-retry-btn:hover:not(:disabled) {
    border-color: var(--vcp-ui-accent, #ff4f8b);
    background: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 16%, transparent);
    color: var(--vcp-ui-accent, #ff4f8b);
}

/* 动态加载弧 */
.vcp-voice-spinner {
    flex: none;
    color: var(--vcp-ui-accent, #ff4f8b);
}

.vcp-voice-spinner-motion {
    transform-origin: center;
    animation: voice-state-dot-spin 1.5s linear infinite;
}

.vcp-voice-spinner-track,
.vcp-voice-spinner-arc {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
}

.vcp-voice-spinner-track {
    opacity: 0.25;
}

.vcp-voice-spinner-arc {
    stroke-dasharray: 12 150;
    animation: voice-state-dot-dash 1.5s ease-in-out infinite;
}

@keyframes voice-state-dot-spin {
    to { transform: rotate(360deg); }
}

@keyframes voice-state-dot-dash {
    0% {
        stroke-dasharray: 12 150;
        stroke-dashoffset: 0;
    }
    50% {
        stroke-dasharray: 24 150;
        stroke-dashoffset: -6;
    }
    100% {
        stroke-dasharray: 12 150;
        stroke-dashoffset: 0;
    }
}

/* 行内操作按钮（小号主按钮） */
.vcp-voice-insert-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    font-size: 12px;
    line-height: 18px;
    padding: 0 10px;
    border-radius: var(--vcp-ui-radius-sm, 6px);
    border: none;
    background: var(--vcp-ui-accent, #ff4f8b);
    color: #ffffff;
    font-weight: 500;
    cursor: pointer;
    flex: none;
    box-sizing: border-box;
    transition: background 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}

.vcp-voice-insert-action-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 86%, #ffffff 14%);
    transform: translateY(-0.5px);
}

.vcp-voice-popover-bubble {
    position: absolute;
    bottom: calc(100% + 10px);
    right: 0;
    min-width: 220px;
    max-width: 320px;
    background: rgba(23, 26, 29, 0.96);
    color: #f2f0e9;
    border: 1px solid rgba(255, 79, 139, 0.65);
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 12px;
    line-height: 1.45;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    pointer-events: none;
    z-index: 1000;
    backdrop-filter: blur(10px);
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.25s ease, transform 0.25s ease;
}
.vcp-voice-popover-bubble.active { opacity: 1; transform: translateY(0); }
.vcp-voice-popover-bubble::after {
    content: '';
    position: absolute;
    top: 100%;
    right: 14px;
    border: 5px solid transparent;
    border-top-color: rgba(255, 79, 139, 0.65);
}
.vcp-voice-popover-title { font-weight: 600; color: #ff4f8b; margin-bottom: 3px; }
.vcp-voice-popover-sub { color: #a7afb1; font-size: 11px; }
`;
        document.head.appendChild(style);
    }

    mount(options = {}) {
        if (typeof document === 'undefined') return null;
        this.ensureStyles();

        const actionsContainer = document.querySelector('.chat-input-actions');
        if (!actionsContainer) return null;
        this.actionsContainer = actionsContainer;

        const sendBtn = options.sendMessageBtn || document.getElementById('sendMessageBtn');

        // 1. 常态触发麦克风按钮
        let btn = document.getElementById('mainVoiceInputBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'mainVoiceInputBtn';
            btn.type = 'button';
            btn.setAttribute('aria-label', '语音输入与录音');

            btn.replaceChildren(createMicrophoneSvg(18));

            if (sendBtn && sendBtn.parentNode === actionsContainer) {
                actionsContainer.insertBefore(btn, sendBtn);
            } else {
                actionsContainer.appendChild(btn);
            }
        }
        this.button = btn;

        // 2. 展开式活动栏（Activity Bar）
        let activityBar = document.getElementById('vcpVoiceActivityBar');
        if (!activityBar) {
            activityBar = document.createElement('div');
            activityBar.id = 'vcpVoiceActivityBar';
            activityBar.className = 'vcp-voice-activity-bar';
            activityBar.style.display = 'none';
            activityBar.setAttribute('data-voice-activity', 'idle');

            // [✕ 取消/放弃 按钮]
            const cancelBtn = document.createElement('button');
            cancelBtn.id = 'vcpVoiceCancelBtn';
            cancelBtn.type = 'button';
            cancelBtn.className = 'vcp-voice-round-btn vcp-voice-cancel-btn';
            cancelBtn.title = '取消并放弃本次录音 (ESC)';
            cancelBtn.setAttribute('aria-label', '取消并放弃');
            cancelBtn.appendChild(createCloseSvg(14));

            // [中间槽位：SVG 波形或状态提示]
            const centerSlot = document.createElement('div');
            centerSlot.id = 'vcpVoiceCenterSlot';
            centerSlot.className = 'vcp-voice-center-slot';

            const waveformContainer = document.createElement('div');
            waveformContainer.id = 'vcpVoiceWaveformContainer';
            waveformContainer.className = 'vcp-voice-waveform-container';

            const activityMessage = document.createElement('span');
            activityMessage.id = 'vcpVoiceActivityMessage';
            activityMessage.className = 'vcp-voice-activity-message';
            activityMessage.setAttribute('role', 'status');
            activityMessage.setAttribute('aria-live', 'polite');
            activityMessage.style.display = 'none';

            centerSlot.append(waveformContainer, activityMessage);

            // [右侧操作槽位：停止按钮 / 冲突插入按钮]
            const actionSlot = document.createElement('div');
            actionSlot.className = 'vcp-voice-action-slot';

            const stopBtn = document.createElement('button');
            stopBtn.id = 'vcpVoiceStopBtn';
            stopBtn.type = 'button';
            stopBtn.className = 'vcp-voice-round-btn vcp-voice-stop-btn';
            stopBtn.title = '停止并完成录音';
            stopBtn.setAttribute('aria-label', '停止并完成');
            stopBtn.appendChild(createStopSvg(14));

            const insertBtn = document.createElement('button');
            insertBtn.id = 'vcpVoiceInsertBtn';
            insertBtn.type = 'button';
            insertBtn.className = 'vcp-voice-insert-action-btn';
            insertBtn.style.display = 'none';
            insertBtn.textContent = '插入文字';
            insertBtn.title = '在当前输入框光标处插入识别内容';
            insertBtn.setAttribute('aria-label', '在当前输入框光标处插入识别内容');

            const retryBtn = document.createElement('button');
            retryBtn.id = 'vcpVoiceRetryBtn';
            retryBtn.type = 'button';
            retryBtn.className = 'vcp-voice-round-btn vcp-voice-retry-btn';
            retryBtn.style.display = 'none';
            retryBtn.title = '重新录音';
            retryBtn.setAttribute('aria-label', '重新录音');
            retryBtn.appendChild(createMicrophoneSvg(18));

            actionSlot.append(stopBtn, insertBtn, retryBtn);

            activityBar.append(cancelBtn, centerSlot, actionSlot);

            // 挂载到主触发按钮左侧（活动栏在左，麦克风按钮在右紧邻发送按钮）
            if (btn && btn.parentNode === actionsContainer) {
                actionsContainer.insertBefore(activityBar, btn);
            } else if (sendBtn && sendBtn.parentNode === actionsContainer) {
                actionsContainer.insertBefore(activityBar, sendBtn);
            } else {
                actionsContainer.appendChild(activityBar);
            }
        }

        this.activityBar = activityBar;
        this.cancelBtn = activityBar.querySelector('#vcpVoiceCancelBtn');
        this.stopBtn = activityBar.querySelector('#vcpVoiceStopBtn');
        this.insertBtn = activityBar.querySelector('#vcpVoiceInsertBtn');
        this.retryBtn = activityBar.querySelector('#vcpVoiceRetryBtn');
        this.centerSlot = activityBar.querySelector('#vcpVoiceCenterSlot');
        this.waveformContainer = activityBar.querySelector('#vcpVoiceWaveformContainer');
        this.activityMessage = activityBar.querySelector('#vcpVoiceActivityMessage');

        // 初始化 SVG 动态波形
        const WaveformClass = getVoiceWaveformClass();
        if (WaveformClass && this.waveformContainer) {
            this.waveform = new WaveformClass();
            this.waveform.mount(this.waveformContainer);
        }

        // 按键操作不窃取 Composer 输入框的光标与选区（keepDraftFocus）
        const keepDraftFocus = event => {
            event.preventDefault();
            if (options.messageInput && !options.messageInput.disabled) {
                try {
                    options.messageInput.focus({ preventScroll: true });
                } catch (_) {}
            }
        };

        // 事件监听绑定
        // 长按麦克风按钮：弹出麦克风选择面板
        const LONG_PRESS_MS = 500;
        let pressTimer = null;
        let longPressed = false;
        const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
        const onPressStart = event => {
            if (event.button !== 0 || !options.onLongPress) return;
            longPressed = false;
            cancelPress();
            pressTimer = setTimeout(() => {
                pressTimer = null;
                longPressed = true;
                options.onLongPress();
            }, LONG_PRESS_MS);
        };

        const onLeftClick = event => {
            event.preventDefault();
            event.stopPropagation();
            if (longPressed) { longPressed = false; return; }
            options.onLeftClick?.();
        };

        const onContextMenu = event => {
            event.preventDefault();
            event.stopPropagation();
            options.onContextMenu?.();
        };

        const onCancelClick = event => {
            event.preventDefault();
            event.stopPropagation();
            options.onCancel?.();
        };

        const onStopClick = event => {
            event.preventDefault();
            event.stopPropagation();
            options.onStop?.();
        };

        const onInsertClick = event => {
            event.preventDefault();
            event.stopPropagation();
            options.onInsertPending?.();
        };

        const onRetryClick = event => {
            event.preventDefault();
            event.stopPropagation();
            options.onRetry?.();
        };

        const onPress = () => options.onPress?.();
        btn.addEventListener('mousedown', onPress);
        btn.addEventListener('mousedown', keepDraftFocus);
        this.cancelBtn?.addEventListener('mousedown', keepDraftFocus);
        this.stopBtn?.addEventListener('mousedown', keepDraftFocus);
        this.insertBtn?.addEventListener('mousedown', keepDraftFocus);
        this.retryBtn?.addEventListener('mousedown', keepDraftFocus);

        btn.addEventListener('mousedown', onPressStart);
        btn.addEventListener('mouseup', cancelPress);
        btn.addEventListener('mouseleave', cancelPress);
        btn.addEventListener('click', onLeftClick);
        btn.addEventListener('contextmenu', onContextMenu);
        this.cancelBtn?.addEventListener('click', onCancelClick);
        this.stopBtn?.addEventListener('click', onStopClick);
        this.insertBtn?.addEventListener('click', onInsertClick);
        this.retryBtn?.addEventListener('click', onRetryClick);

        this.disposers.push(() => {
            btn.removeEventListener('mousedown', onPress);
            btn.removeEventListener('mousedown', keepDraftFocus);
            this.cancelBtn?.removeEventListener('mousedown', keepDraftFocus);
            this.stopBtn?.removeEventListener('mousedown', keepDraftFocus);
            this.insertBtn?.removeEventListener('mousedown', keepDraftFocus);
            this.retryBtn?.removeEventListener('mousedown', keepDraftFocus);

            cancelPress();
            btn.removeEventListener('mousedown', onPressStart);
            btn.removeEventListener('mouseup', cancelPress);
            btn.removeEventListener('mouseleave', cancelPress);
            this.closeMicMenu();
            btn.removeEventListener('click', onLeftClick);
            btn.removeEventListener('contextmenu', onContextMenu);
            this.cancelBtn?.removeEventListener('click', onCancelClick);
            this.stopBtn?.removeEventListener('click', onStopClick);
            this.insertBtn?.removeEventListener('click', onInsertClick);
            this.retryBtn?.removeEventListener('click', onRetryClick);
            btn.remove();
            activityBar.remove();
        });

        return btn;
    }

    setSttActive(active) {
        if (!this.button) return;
        this.button.classList.toggle('stt-mode-active', Boolean(active));
    }

    setRecordingAudio(active) {
        if (!this.button) return;
        this.button.classList.toggle('audio-record-mode-active', Boolean(active));
    }

    // 渐进式状态流转呈现
    setPhase(phase, payload = {}) {
        this.currentPhase = phase;
        if (!this.activityBar) return;

        this.activityBar.setAttribute('data-voice-activity', phase);

        if (phase === 'idle') {
            this.waveform?.stop();
            this.actionsContainer?.classList.remove('vcp-voice-expanded');
            if (this.button) this.button.style.display = '';
            this.activityBar.style.display = 'none';
            if (this.activityMessage) this.activityMessage.textContent = '';
            if (this.insertBtn) this.insertBtn.style.display = 'none';
            if (this.stopBtn) this.stopBtn.style.display = 'inline-flex';
            return;
        }

        // 展开活动栏
        this.actionsContainer?.classList.add('vcp-voice-expanded');
        if (this.button) this.button.style.display = 'none';
        this.activityBar.style.display = 'flex';

        // 区分模式着色
        if (payload.mode === 'audio-record') {
            this.waveformContainer?.classList.add('mode-audio-record');
        } else {
            this.waveformContainer?.classList.remove('mode-audio-record');
        }

        const renderSpinner = (text) => {
            if (!this.activityMessage) return;
            this.activityMessage.style.display = 'inline-flex';
            this.activityMessage.replaceChildren();

            const spinner = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            spinner.setAttribute('class', 'vcp-voice-spinner');
            spinner.setAttribute('width', '14');
            spinner.setAttribute('height', '14');
            spinner.setAttribute('viewBox', '0 0 24 24');
            spinner.setAttribute('aria-hidden', 'true');

            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', 'vcp-voice-spinner-motion');

            const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            track.setAttribute('class', 'vcp-voice-spinner-track');
            track.setAttribute('cx', '12'); track.setAttribute('cy', '12'); track.setAttribute('r', '9.5');

            const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            arc.setAttribute('class', 'vcp-voice-spinner-arc');
            arc.setAttribute('cx', '12'); arc.setAttribute('cy', '12'); arc.setAttribute('r', '9.5');

            g.append(track, arc);
            spinner.appendChild(g);

            const span = document.createElement('span');
            span.textContent = text;

            this.activityMessage.append(spinner, span);
        };

        if (phase === 'recording') {
            if (this.waveformContainer) this.waveformContainer.style.display = 'flex';
            if (this.activityMessage) this.activityMessage.style.display = 'none';
            if (this.stopBtn) this.stopBtn.style.display = 'inline-flex';
            if (this.insertBtn) this.insertBtn.style.display = 'none';
            if (this.retryBtn) this.retryBtn.style.display = 'none';
            if (this.cancelBtn) {
                this.cancelBtn.title = '取消并放弃录音 (ESC)';
                this.cancelBtn.setAttribute('aria-label', '取消并放弃录音');
            }

            if (payload.source) {
                this.waveform?.start(payload.source);
            }
        } else if (phase === 'requesting') {
            this.waveform?.stop();
            if (this.waveformContainer) this.waveformContainer.style.display = 'none';
            renderSpinner(payload.message || '请允许使用麦克风…');
            if (this.stopBtn) this.stopBtn.style.display = 'none';
            if (this.insertBtn) this.insertBtn.style.display = 'none';
            if (this.retryBtn) this.retryBtn.style.display = 'none';
            if (this.cancelBtn) {
                this.cancelBtn.title = '取消 (ESC)';
                this.cancelBtn.setAttribute('aria-label', '取消');
            }
        } else if (phase === 'transcribing') {
            this.waveform?.stop();
            if (this.waveformContainer) this.waveformContainer.style.display = 'none';
            renderSpinner(payload.message || '识别中…');
            if (this.stopBtn) this.stopBtn.style.display = 'none';
            if (this.insertBtn) this.insertBtn.style.display = 'none';
            if (this.retryBtn) this.retryBtn.style.display = 'none';
            if (this.cancelBtn) {
                this.cancelBtn.title = '取消 (ESC)';
                this.cancelBtn.setAttribute('aria-label', '取消');
            }
        } else if (phase === 'feedback') {
            this.waveform?.stop();
            if (this.waveformContainer) this.waveformContainer.style.display = 'none';
            const feedbackText = payload.message || (payload.hasPending ? '草稿已被修改。可在当前光标处插入。' : '未识别到语音');
            if (this.activityMessage) {
                this.activityMessage.style.display = 'inline-flex';
                this.activityMessage.textContent = feedbackText;
                this.activityMessage.title = feedbackText;
            }
            if (this.stopBtn) this.stopBtn.style.display = 'none';
            if (payload.hasPending) {
                if (this.insertBtn) this.insertBtn.style.display = 'inline-flex';
                if (this.retryBtn) this.retryBtn.style.display = 'none';
                if (this.cancelBtn) {
                    this.cancelBtn.title = '丢弃识别文字 (ESC)';
                    this.cancelBtn.setAttribute('aria-label', '丢弃识别文字');
                }
            } else {
                if (this.insertBtn) this.insertBtn.style.display = 'none';
                if (this.retryBtn) this.retryBtn.style.display = 'inline-flex';
                if (this.cancelBtn) {
                    this.cancelBtn.title = '取消 (ESC)';
                    this.cancelBtn.setAttribute('aria-label', '取消');
                }
            }
        }
    }

    closeMicMenu() {
        this.micMenu?.remove();
        this.micMenu = null;
        if (this.micMenuCleanup) { this.micMenuCleanup(); this.micMenuCleanup = null; }
    }

    // devices: [{ deviceId, label }]，selectedId 为空表示系统默认
    showMicMenu({ devices = [], selectedId = '', note = '', onSelect } = {}) {
        if (!this.button || !this.actionsContainer) return;
        this.closeMicMenu();
        const menu = document.createElement('div');
        menu.className = 'vcp-mic-menu';
        menu.setAttribute('role', 'menu');
        const title = document.createElement('div');
        title.className = 'vcp-mic-menu-title';
        title.textContent = '麦克风';
        menu.appendChild(title);
        const entries = devices.length ? devices : [{ deviceId: '', label: '系统默认麦克风' }];
        const hasSelected = entries.some(d => d.deviceId === selectedId);
        entries.forEach(d => {
            const checked = hasSelected ? d.deviceId === selectedId : (d.deviceId === 'default' || d === entries[0]);
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'vcp-mic-menu-item';
            item.setAttribute('role', 'menuitemradio');
            item.setAttribute('aria-checked', String(checked));
            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = d.label || '麦克风';
            name.title = d.label || '';
            const check = document.createElement('span');
            check.className = 'check';
            check.textContent = checked ? '\u2713' : '';
            item.append(name, check);
            item.addEventListener('click', event => {
                event.stopPropagation();
                this.closeMicMenu();
                onSelect?.(d.deviceId);
            });
            menu.appendChild(item);
        });
        if (note) {
            const n = document.createElement('div');
            n.className = 'vcp-mic-menu-note';
            n.textContent = note;
            menu.appendChild(n);
        }
        const host = this.actionsContainer;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(menu);
        this.micMenu = menu;
        const onDown = event => { if (!menu.contains(event.target)) this.closeMicMenu(); };
        const onKey = event => { if (event.key === 'Escape') { this.closeMicMenu(); event.stopPropagation(); } };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        this.micMenuCleanup = () => {
            document.removeEventListener('mousedown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }

    updateTooltip(state = {}) {
        if (!this.button) return;
        const { isRecordingAudio, isSttActive, voiceInputMode } = state;
        const isWindows = typeof state.isWindows === 'boolean'
            ? state.isWindows
            : typeof process !== 'undefined' && process.platform === 'win32';
        const isAltMode = voiceInputMode === 'right_alt_hold';

        if (isRecordingAudio && voiceInputMode === 'local_sensevoice') {
            this.button.title = '正在录音... 点击停止并在本地转写为文字 (ESC 取消)';
            return;
        }

        if (isRecordingAudio) {
            this.button.title = '正在录制原声音频... 点击停止并生成 WAV 附件 (ESC 取消)';
            return;
        }

        if (isSttActive) {
            this.button.title = isAltMode
                ? '语音听写运行中【右 Alt 模拟长按模式，期间请勿按压其他键；点击停止关闭】'
                : '语音听写运行中 (停顿自动完成，点击立即关闭退出)';
            return;
        }

        if (voiceInputMode === 'local_sensevoice') {
            this.button.title = '左键录音并本地转写为文字 (SenseVoice 离线)；右键录制原声 WAV 附件';
            return;
        }

        if (!isWindows) {
            this.button.title = '点击开始语音录音 (生成高保真 WAV 附件)；右键亦可录制';
            return;
        }

        this.button.title = isAltMode
            ? '左键开启输入法语音听写 (右 Alt 模拟模式)；右键录制原声 WAV 附件'
            : '左键开启语音听写；右键录制原声 WAV 附件';
    }

    showBubble(title, subtitle) {
        if (!this.button || typeof document === 'undefined') return;

        let bubble = document.getElementById('vcp-voice-popover-bubble');
        if (!bubble) {
            bubble = document.createElement('div');
            bubble.id = 'vcp-voice-popover-bubble';
            bubble.className = 'vcp-voice-popover-bubble';
            this.button.appendChild(bubble);
        }

        bubble.replaceChildren();

        const titleEl = document.createElement('div');
        titleEl.className = 'vcp-voice-popover-title';
        titleEl.textContent = title;

        const subEl = document.createElement('div');
        subEl.className = 'vcp-voice-popover-sub';
        subEl.textContent = subtitle;

        bubble.append(titleEl, subEl);

        void bubble.offsetWidth;
        bubble.classList.add('active');

        clearTimeout(this.bubbleDismissTimer);
        clearTimeout(this.bubbleRemoveTimer);
        this.bubbleDismissTimer = setTimeout(() => {
            bubble?.classList.remove('active');
            this.bubbleRemoveTimer = setTimeout(() => {
                bubble?.remove();
                this.bubbleRemoveTimer = null;
            }, 300);
        }, 3800);
    }

    dispose() {
        clearTimeout(this.bubbleDismissTimer);
        clearTimeout(this.bubbleRemoveTimer);
        this.bubbleDismissTimer = null;
        this.bubbleRemoveTimer = null;
        try {
            this.waveform?.destroy();
        } catch (_) {}
        this.waveform = null;

        this.disposers.splice(0).reverse().forEach(fn => {
            try { fn(); } catch (_) {}
        });
        if (typeof document !== 'undefined') {
            const style = document.getElementById('vcp-chat-voice-composer-style');
            if (style) style.remove();
        }
        this.button = null;
        this.activityBar = null;
        this.cancelBtn = null;
        this.stopBtn = null;
        this.insertBtn = null;
        this.retryBtn = null;
        this.centerSlot = null;
        this.waveformContainer = null;
        this.activityMessage = null;
        this.actionsContainer = null;
    }
}

if (typeof window !== 'undefined') {
    window.VcpVoice = Object.assign(window.VcpVoice || {}, {
        VoiceComposerView,
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VoiceComposerView,
    };
}
