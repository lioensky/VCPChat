// modules/renderer/domBuilder.js

/**
 * @typedef {import('./messageRenderer.js').Message} Message
 * @typedef {import('./messageRenderer.js').CurrentSelectedItem} CurrentSelectedItem
 */

/**
 * Creates the basic HTML structure (skeleton) for a message item.
 * @param {Message} message - The message object.
 * @param {object} globalSettings - The global settings object.
 * @param {CurrentSelectedItem} currentSelectedItem - The currently selected agent or group.
 * @returns {{
 *   messageItem: HTMLElement,
 *   contentDiv: HTMLElement,
 *   avatarImg: HTMLImageElement | null,
 *   senderNameDiv: HTMLElement | null,
 *   nameTimeDiv: HTMLElement | null,
 *   detailsAndBubbleWrapper: HTMLElement | null
 * }} An object containing the created DOM elements.
 */

function fixVoiceChatAssetPath(url, ownerWindow = null) {
    if (!url) return url;
    const pathname = ownerWindow?.location?.pathname || '';
    const isVoiceChatPage = pathname.replace(/\\/g, '/').includes('/Voicechatmodules/');
    if (!isVoiceChatPage) return url;
    if (url.startsWith('assets/')) return `../${url}`;
    return url;
}

function padTimestampPart(value) {
    return String(value).padStart(2, '0');
}

export function formatMessageTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const year = date.getFullYear();
    const month = padTimestampPart(date.getMonth() + 1);
    const day = padTimestampPart(date.getDate());
    const hours = padTimestampPart(date.getHours());
    const minutes = padTimestampPart(date.getMinutes());

    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// lucide circle-alert / info：系统消息是一行提示，错误用前者
const SYSTEM_ICON_ATTRS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const SYSTEM_ERROR_ICON = `<svg ${SYSTEM_ICON_ATTRS}><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;
const SYSTEM_INFO_ICON = `<svg ${SYSTEM_ICON_ATTRS}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;

const USER_MESSAGE_LAYOUT_CLASSES = [
    'user-bubble-ui-enabled',
    'user-bubble-ui-disabled',
    'user-bubble-meta-hidden'
];

export function applyUserMessageLayoutState(messageItem, globalSettings) {
    if (!messageItem?.classList || !messageItem.classList.contains('user')) {
        return;
    }

    messageItem.classList.remove(...USER_MESSAGE_LAYOUT_CLASSES);

    const bubbleUiEnabled = globalSettings?.enableUserChatBubbleUi !== false;
    const showUserMeta = globalSettings?.showUserMetaInChatBubbleUi !== false;

    if (bubbleUiEnabled) {
        messageItem.classList.add('user-bubble-ui-enabled');
        if (!showUserMeta) {
            messageItem.classList.add('user-bubble-meta-hidden');
        }
        return;
    }

    messageItem.classList.add('user-bubble-ui-disabled');
}

export function createMessageSkeleton(message, globalSettings, currentSelectedItem, domRealm = {}) {
    const ownerDocument = domRealm.document || domRealm.root?.ownerDocument;
    if (!ownerDocument?.createElement) throw new TypeError('createMessageSkeleton requires a DOM document');
    const ownerWindow = domRealm.window || ownerDocument.defaultView;
    const messageItem = ownerDocument.createElement('div');
    messageItem.classList.add('message-item', message.role);
    if (message.isGroupMessage) messageItem.classList.add('group-message-item');
    messageItem.dataset.timestamp = String(message.timestamp);
    messageItem.dataset.messageId = message.id;
    if (message.agentId) messageItem.dataset.agentId = message.agentId;
    applyUserMessageLayoutState(messageItem, globalSettings);

    const contentDiv = ownerDocument.createElement('div');
    contentDiv.classList.add('md-content');

    let avatarImg = null,
        nameTimeDiv = null,
        senderNameDiv = null,
        detailsAndBubbleWrapper = null;
    let avatarUrlToUse, senderNameToUse;

    if (message.role === 'user') {
        avatarUrlToUse = globalSettings.userAvatarUrl || 'assets/default_user_avatar.png';
        senderNameToUse = message.name || globalSettings.userName || '你';
    } else if (message.role === 'assistant') {
        if (message.isGroupMessage) {
            avatarUrlToUse = message.avatarUrl || 'assets/default_avatar.png';
            senderNameToUse = message.name || '群成员';
        } else if (message.avatarUrl || currentSelectedItem?.avatarUrl) {
            avatarUrlToUse = message.avatarUrl || currentSelectedItem.avatarUrl;
            senderNameToUse = message.name || currentSelectedItem?.name || 'AI';
        } else {
            avatarUrlToUse = 'assets/default_avatar.png';
            senderNameToUse = message.name || 'AI';
        }
    }

    if (message.role === 'user' || message.role === 'assistant') {
        avatarImg = ownerDocument.createElement('img');
        avatarImg.classList.add('chat-avatar');
        avatarImg.src = fixVoiceChatAssetPath(avatarUrlToUse, ownerWindow);
        avatarImg.alt = `${senderNameToUse} 头像`;
        avatarImg.onerror = () => {
            avatarImg.onerror = null;
            avatarImg.src = fixVoiceChatAssetPath(message.role === 'user' ? 'assets/default_user_avatar.png' : 'assets/default_avatar.png', ownerWindow);
        };

        nameTimeDiv = ownerDocument.createElement('div');
        nameTimeDiv.classList.add('name-time-block');

        senderNameDiv = ownerDocument.createElement('div');
        senderNameDiv.classList.add('sender-name');
        senderNameDiv.textContent = senderNameToUse;

        nameTimeDiv.appendChild(senderNameDiv);

        if (message.timestamp && !message.isThinking) {
            const timestampDiv = ownerDocument.createElement('div');
            timestampDiv.classList.add('message-timestamp');
            timestampDiv.textContent = formatMessageTimestamp(message.timestamp);
            nameTimeDiv.appendChild(timestampDiv);
        }

        detailsAndBubbleWrapper = document.createElement('div');
        detailsAndBubbleWrapper.classList.add('details-and-bubble-wrapper');
        detailsAndBubbleWrapper.appendChild(nameTimeDiv);
        detailsAndBubbleWrapper.appendChild(contentDiv);

        messageItem.appendChild(avatarImg);
        messageItem.appendChild(detailsAndBubbleWrapper);
    } else { // system messages
        messageItem.classList.add('system-message-layout');
        if (message.notice === 'error') messageItem.classList.add('system-notice-error');
        if (!message.isThinking) {
            const icon = ownerDocument.createElement('span');
            icon.className = 'system-message-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = message.notice === 'error' ? SYSTEM_ERROR_ICON : SYSTEM_INFO_ICON;
            messageItem.appendChild(icon);
        }
        messageItem.appendChild(contentDiv);
    }

    return { messageItem, contentDiv, avatarImg, senderNameDiv, nameTimeDiv, detailsAndBubbleWrapper };
}
