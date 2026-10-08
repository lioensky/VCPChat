/**
 * modules/ui-system/chat-back-to-bottom.js
 * 主聊天的「回到底部」圆钮：离开底部（粘底跟随关闭）时浮在输入区上沿正中，点一下回到最新消息并重新跟随。
 *
 * 显隐规则和位置照 ZCode 的 ConversationBackToBottomButton
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/ConversationTimeline.tsx）：
 * 不在跟随、且有消息时显示；挂在输入区上方 8px、水平居中。
 * 跟随状态只由 ui-helpers.js 持有：这里订阅它在滚动容器上派发的 vcp-chat-follow-change，
 * 点击时走 resetChatScrollFollow + scrollToBottom，不自己判断几何位置。
 */

'use strict';

import { bindChatNavigationIdle } from './chat-navigation-idle.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_FOLLOW_CHANGE_EVENT = 'vcp-chat-follow-change';

function createArrowDownIcon(doc) {
    // lucide arrow-down
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M12 5v14', 'm19 12-7 7-7-7']) {
        const path = doc.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }
    return svg;
}

export function createChatBackToBottom({
    document: doc = document,
    uiHelper = null,
    scroller = null,
    messagesRoot = null,
    dock = null,
    label = '回到底部'
} = {}) {
    const cleanups = [];
    let button = null;
    let messages = messagesRoot;
    let following = true;
    let idleControl = null;

    function sync() {
        if (!button) return;
        button.hidden = following || !messages.querySelector(':scope > .message-item');
        idleControl?.refresh();
    }

    function mount() {
        if (button) return button;
        scroller = scroller || doc.querySelector('.chat-messages-container');
        messages = messages || doc.getElementById('chatMessages');
        dock = dock || doc.querySelector('.chat-input-area');
        if (!uiHelper || !scroller || !messages || !dock) return null;

        button = doc.createElement('button');
        button.type = 'button';
        button.className = 'vcp-back-to-bottom';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.hidden = true;
        button.appendChild(createArrowDownIcon(doc));
        const onClick = () => {
            uiHelper.resetChatScrollFollow?.();
            uiHelper.scrollToBottom?.({ force: true });
        };
        button.addEventListener('click', onClick);
        cleanups.push(() => button.removeEventListener('click', onClick));
        dock.prepend(button);
        idleControl = bindChatNavigationIdle({ element: button, scroller });
        cleanups.push(() => { idleControl.dispose(); idleControl = null; });

        const eventName = uiHelper.CHAT_FOLLOW_CHANGE_EVENT || DEFAULT_FOLLOW_CHANGE_EVENT;
        const onFollowChange = (event) => {
            following = event.detail?.followBottom !== false;
            sync();
        };
        scroller.addEventListener(eventName, onFollowChange);
        cleanups.push(() => scroller.removeEventListener(eventName, onFollowChange));

        // 换话题 / 清空时消息被整体替换，只看直接子节点增删即可
        const MutationObserverCtor = doc.defaultView?.MutationObserver;
        if (typeof MutationObserverCtor === 'function') {
            const observer = new MutationObserverCtor(sync);
            observer.observe(messages, { childList: true });
            cleanups.push(() => observer.disconnect());
        }

        following = uiHelper.captureChatScrollFollow?.().followBottom !== false;
        sync();
        return button;
    }

    function dispose() {
        while (cleanups.length) cleanups.pop()();
        button?.remove();
        button = null;
    }

    return {
        mount,
        dispose,
        get element() { return button; }
    };
}
