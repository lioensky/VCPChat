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
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--vcp-ui-send-button-size, 36px);
    height: var(--vcp-ui-send-button-size, 36px);
    margin-left: auto !important;
    margin-right: 6px !important;
    border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, var(--vcp-ui-accent, var(--button-bg, #ff4f8b)) 82%, #fbf9f5 18%);
    background: transparent;
    color: color-mix(in srgb, var(--vcp-ui-accent, var(--button-bg, #ff4f8b)) 82%, #fbf9f5 18%);
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
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
#mainVoiceInputBtn:hover {
    background: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 12%, transparent);
    transform: translateY(-1px);
}
#mainVoiceInputBtn svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: color-mix(in srgb, var(--vcp-ui-accent, var(--button-bg, #ff4f8b)) 82%, #fbf9f5 18%) !important;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.2s ease;
}
#mainVoiceInputBtn.stt-mode-active {
    background: #ff4f8b !important;
    border-color: #ff3377 !important;
    color: #ffffff !important;
    animation: vcp-voice-pulse-pink 2.4s ease-in-out infinite;
}
#mainVoiceInputBtn.stt-mode-active svg {
    stroke: #ffffff !important;
    transform: scale(1.08);
}
#mainVoiceInputBtn.audio-record-mode-active {
    background: #f39c12 !important;
    border-color: #e67e22 !important;
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

/* 展开活动栏（Activity Bar） */
html .vcp-ui-scope .chat-input-actions.vcp-voice-expanded > :not(#vcpVoiceActivityBar):not(#sendMessageBtn):not(.chat-send-button),
.chat-input-actions.vcp-voice-expanded > :not(#vcpVoiceActivityBar):not(#sendMessageBtn):not(.chat-send-button) {
    display: none !important;
}

.vcp-voice-activity-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1 1 0;
    width: 0;
    min-width: 0;
    min-height: 36px;
    box-sizing: border-box;
    padding: 0 4px;
    margin-right: 6px;
    animation: vcp-voice-slide-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes vcp-voice-slide-in {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
}

.vcp-voice-round-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--vcp-ui-border, rgba(255, 255, 255, 0.12));
    background: var(--vcp-ui-surface-2, rgba(255, 255, 255, 0.06));
    color: var(--vcp-ui-text-2, #a7afb1);
    cursor: pointer;
    flex: 0 0 auto;
    padding: 0;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.vcp-voice-round-btn:hover {
    background: var(--vcp-ui-interactive-hover, rgba(255, 255, 255, 0.12));
    color: var(--vcp-ui-text-1, #f2f0e9);
}

.vcp-voice-cancel-btn:hover {
    border-color: rgba(235, 87, 87, 0.45);
    background: rgba(235, 87, 87, 0.15);
    color: #ff5c5c;
}

.vcp-voice-stop-btn {
    border-color: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 60%, transparent);
    background: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 16%, transparent);
    color: var(--vcp-ui-accent, #ff4f8b);
}

.vcp-voice-stop-btn:hover {
    background: var(--vcp-ui-accent, #ff4f8b);
    border-color: var(--vcp-ui-accent, #ff4f8b);
    color: #ffffff;
    box-shadow: 0 0 12px color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 45%, transparent);
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
    flex: 1 1 0;
    width: 0;
    min-width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
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
}

.vcp-voice-state-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vcp-ui-accent, #ff4f8b);
    animation: vcp-voice-dot-blink 1.2s ease-in-out infinite;
    flex-shrink: 0;
}

@keyframes vcp-voice-dot-blink {
    0%, 100% { opacity: 0.3; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.15); }
}

.vcp-voice-action-slot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    height: 32px;
    gap: 8px;
}

.vcp-voice-retry-btn {
    border-color: var(--vcp-ui-border, rgba(255, 255, 255, 0.15));
    background: var(--vcp-ui-surface-2, rgba(255, 255, 255, 0.08));
    color: var(--vcp-ui-text-1, #f2f0e9);
}

.vcp-voice-retry-btn:hover {
    border-color: var(--vcp-ui-accent, #ff4f8b);
    background: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 16%, transparent);
    color: var(--vcp-ui-accent, #ff4f8b);
}

.vcp-voice-spinner {
    flex: none;
    color: var(--vcp-ui-accent, #ff4f8b);
}

.vcp-voice-spinner-motion {
    transform-origin: center;
    animation: vcp-voice-spin 1.5s linear infinite;
}

.vcp-voice-spinner-track,
.vcp-voice-spinner-arc {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-linecap: round;
}

.vcp-voice-spinner-track {
    opacity: 0.25;
}

.vcp-voice-spinner-arc {
    stroke-dasharray: 20 150;
    animation: vcp-voice-arc-breathe 1.5s ease-in-out infinite;
}

@keyframes vcp-voice-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

@keyframes vcp-voice-arc-breathe {
    0%, 100% { stroke-dashoffset: 0; }
    50% { stroke-dashoffset: -35; }
}

.vcp-voice-insert-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 12px;
    height: 28px;
    border-radius: 14px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--vcp-ui-accent, #ff4f8b);
    background: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 16%, transparent);
    color: var(--vcp-ui-accent, #ff4f8b);
    cursor: pointer;
    flex: 0 0 auto;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.vcp-voice-insert-action-btn:hover {
    background: var(--vcp-ui-accent, #ff4f8b);
    color: #ffffff;
    transform: translateY(-1px);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 35%, transparent);
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

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('aria-hidden', 'true');

            const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path1.setAttribute('d', 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z');

            const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path2.setAttribute('d', 'M19 10v2a7 7 0 0 1-14 0v-2');

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', '12');
            line.setAttribute('y1', '19');
            line.setAttribute('x2', '12');
            line.setAttribute('y2', '22');

            svg.append(path1, path2, line);
            btn.replaceChildren(svg);

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
            const cancelSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            cancelSvg.setAttribute('viewBox', '0 0 24 24');
            cancelSvg.setAttribute('width', '14');
            cancelSvg.setAttribute('height', '14');
            cancelSvg.setAttribute('fill', 'none');
            cancelSvg.setAttribute('stroke', 'currentColor');
            cancelSvg.setAttribute('stroke-width', '2');
            cancelSvg.setAttribute('stroke-linecap', 'round');
            cancelSvg.setAttribute('stroke-linejoin', 'round');
            const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l1.setAttribute('x1', '18'); l1.setAttribute('y1', '6'); l1.setAttribute('x2', '6'); l1.setAttribute('y2', '18');
            const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l2.setAttribute('x1', '6'); l2.setAttribute('y1', '6'); l2.setAttribute('x2', '18'); l2.setAttribute('y2', '18');
            cancelSvg.append(l1, l2);
            cancelBtn.appendChild(cancelSvg);

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
            const stopSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            stopSvg.setAttribute('viewBox', '0 0 24 24');
            stopSvg.setAttribute('width', '12');
            stopSvg.setAttribute('height', '12');
            stopSvg.setAttribute('fill', 'currentColor');
            const stopRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            stopRect.setAttribute('x', '5'); stopRect.setAttribute('y', '5');
            stopRect.setAttribute('width', '14'); stopRect.setAttribute('height', '14');
            stopRect.setAttribute('rx', '2');
            stopSvg.appendChild(stopRect);
            stopBtn.appendChild(stopSvg);

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
            const retrySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            retrySvg.setAttribute('viewBox', '0 0 24 24');
            retrySvg.setAttribute('width', '16');
            retrySvg.setAttribute('height', '16');
            retrySvg.setAttribute('fill', 'none');
            retrySvg.setAttribute('stroke', 'currentColor');
            retrySvg.setAttribute('stroke-width', '2');
            retrySvg.setAttribute('stroke-linecap', 'round');
            retrySvg.setAttribute('stroke-linejoin', 'round');
            const retryPath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            retryPath1.setAttribute('d', 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z');
            const retryPath2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            retryPath2.setAttribute('d', 'M19 10v2a7 7 0 0 1-14 0v-2');
            const retryLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            retryLine.setAttribute('x1', '12'); retryLine.setAttribute('x2', '12');
            retryLine.setAttribute('y1', '19'); retryLine.setAttribute('y2', '22');
            retrySvg.append(retryPath1, retryPath2, retryLine);
            retryBtn.appendChild(retrySvg);

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
        const onLeftClick = event => {
            event.preventDefault();
            event.stopPropagation();
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

        btn.addEventListener('mousedown', keepDraftFocus);
        this.cancelBtn?.addEventListener('mousedown', keepDraftFocus);
        this.stopBtn?.addEventListener('mousedown', keepDraftFocus);
        this.insertBtn?.addEventListener('mousedown', keepDraftFocus);
        this.retryBtn?.addEventListener('mousedown', keepDraftFocus);

        btn.addEventListener('click', onLeftClick);
        btn.addEventListener('contextmenu', onContextMenu);
        this.cancelBtn?.addEventListener('click', onCancelClick);
        this.stopBtn?.addEventListener('click', onStopClick);
        this.insertBtn?.addEventListener('click', onInsertClick);
        this.retryBtn?.addEventListener('click', onRetryClick);

        this.disposers.push(() => {
            btn.removeEventListener('mousedown', keepDraftFocus);
            this.cancelBtn?.removeEventListener('mousedown', keepDraftFocus);
            this.stopBtn?.removeEventListener('mousedown', keepDraftFocus);
            this.insertBtn?.removeEventListener('mousedown', keepDraftFocus);
            this.retryBtn?.removeEventListener('mousedown', keepDraftFocus);

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

    updateTooltip(state = {}) {
        if (!this.button) return;
        const { isRecordingAudio, isSttActive, voiceInputMode } = state;
        const isWindows = typeof process !== 'undefined' && process.platform === 'win32';
        const isAltMode = voiceInputMode === 'right_alt_hold';

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
