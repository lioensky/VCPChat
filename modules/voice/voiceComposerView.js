class VoiceComposerView {
    constructor() {
        this.button = null;
        this.bubbleDismissTimer = null;
        this.bubbleRemoveTimer = null;
        this.disposers = [];
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
html .vcp-ui-scope .chat-input-actions #mainVoiceInputBtn + :is(#sendMessageBtn, .chat-send-button),
.chat-input-actions #mainVoiceInputBtn + :is(#sendMessageBtn, .chat-send-button) {
    margin-left: 0 !important;
}
#mainVoiceInputBtn:hover {
    background: color-mix(in srgb, var(--vcp-ui-accent, #ff4f8b) 10%, transparent);
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

            const sendBtn = options.sendMessageBtn;
            if (sendBtn && sendBtn.parentNode === actionsContainer) {
                actionsContainer.insertBefore(btn, sendBtn);
            } else {
                actionsContainer.appendChild(btn);
            }
        }
        this.button = btn;

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

        btn.addEventListener('click', onLeftClick);
        btn.addEventListener('contextmenu', onContextMenu);

        this.disposers.push(() => {
            btn.removeEventListener('click', onLeftClick);
            btn.removeEventListener('contextmenu', onContextMenu);
            btn.remove();
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

    updateTooltip(state = {}) {
        if (!this.button) return;
        const { isRecordingAudio, isSttActive, voiceInputMode } = state;
        const isAltMode = voiceInputMode === 'right_alt_hold';

        if (isRecordingAudio) {
            this.button.title = '正在录制原声音频... 点击停止并生成 WAV 附件';
            return;
        }

        if (isSttActive) {
            this.button.title = isAltMode
                ? '语音听写运行中【右 Alt 模拟长按模式，期间请勿按压其他键；点击停止关闭】'
                : '语音听写运行中 (停顿自动完成，点击立即关闭退出)';
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
        this.disposers.splice(0).reverse().forEach(fn => {
            try { fn(); } catch (_) {}
        });
        if (typeof document !== 'undefined') {
            const style = document.getElementById('vcp-chat-voice-composer-style');
            if (style) style.remove();
        }
        this.button = null;
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
