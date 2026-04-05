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

function fixVoiceChatAssetPath(url) {
    if (!url) return url;
    const isVoiceChatPage = window.location.pathname.replace(/\\/g, '/').includes('/Voicechatmodules/');
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

export function createMessageSkeleton(message, globalSettings, currentSelectedItem) {
    const messageItem = document.createElement('div');
    messageItem.classList.add('message-item', message.role);
    if (message.isGroupMessage) messageItem.classList.add('group-message-item');
    messageItem.dataset.timestamp = String(message.timestamp);
    messageItem.dataset.messageId = message.id;
    if (message.agentId) messageItem.dataset.agentId = message.agentId;
    applyUserMessageLayoutState(messageItem, globalSettings);

    const contentDiv = document.createElement('div');
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
        } else if (currentSelectedItem && currentSelectedItem.avatarUrl) {
            avatarUrlToUse = currentSelectedItem.avatarUrl;
            senderNameToUse = message.name || currentSelectedItem.name || 'AI';
        } else {
            avatarUrlToUse = 'assets/default_avatar.png';
            senderNameToUse = message.name || 'AI';
        }
    }

    if (message.role === 'user' || message.role === 'assistant') {
        avatarImg = document.createElement('img');
        avatarImg.classList.add('chat-avatar');
        avatarImg.src = fixVoiceChatAssetPath(avatarUrlToUse);
        avatarImg.alt = `${senderNameToUse} 头像`;
        avatarImg.onerror = () => {
            avatarImg.onerror = null;
            avatarImg.src = fixVoiceChatAssetPath(message.role === 'user' ? 'assets/default_user_avatar.png' : 'assets/default_avatar.png');
        };

        nameTimeDiv = document.createElement('div');
        nameTimeDiv.classList.add('name-time-block');

        senderNameDiv = document.createElement('div');
        senderNameDiv.classList.add('sender-name');
        senderNameDiv.textContent = senderNameToUse;

        nameTimeDiv.appendChild(senderNameDiv);

        if (message.timestamp && !message.isThinking) {
            const timestampDiv = document.createElement('div');
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
        messageItem.appendChild(contentDiv);
        messageItem.classList.add('system-message-layout');
    }

    return { messageItem, contentDiv, avatarImg, senderNameDiv, nameTimeDiv, detailsAndBubbleWrapper };
}

// Expose to global scope for classic scripts
window.domBuilder = {
    createMessageSkeleton,
    formatMessageTimestamp,
    applyUserMessageLayoutState
};
