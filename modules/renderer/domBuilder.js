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

function addLocalAvatarCacheBuster(url) {
    if (typeof url !== 'string') return url;
    if (!url.startsWith('file://') || url.includes('?')) return url;
    if (
        !/[\\/](avatar|user_avatar)\.(png|jpe?g|gif|webp)$/i.test(url)
        && !/[\\/]AppData[\\/]avatarimage[\\/][^\\/]+\.(png|jpe?g|gif|webp)$/i.test(url)
    ) {
        return url;
    }
    return `${url}?t=${Date.now()}`;
}

function currentAppRootPath() {
    if (typeof window === 'undefined' || window.location?.protocol !== 'file:') {
        return '';
    }
    const pathname = decodeURIComponent(window.location.pathname || '');
    const normalized = pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\\/g, '/');
    return normalized.includes('/')
        ? normalized.slice(0, normalized.lastIndexOf('/'))
        : normalized;
}

function localAvatarImageUrl(fileName) {
    const appRoot = currentAppRootPath();
    if (!appRoot || !fileName) return null;
    return encodeURI(`file:///${appRoot.replace(/^\/+/, '')}/AppData/avatarimage/${fileName}`);
}

export function localAgentAvatarUrl(agentId) {
    if (!agentId) return null;
    const appRoot = currentAppRootPath();
    if (!appRoot) return null;
    return encodeURI(`file:///${appRoot.replace(/^\/+/, '')}/AppData/Agents/${agentId}/avatar.png`);
}

export function canonicalAgentAvatarUrl(agentId) {
    if (agentId === 'Codex_Projection') return localAvatarImageUrl('Codex_Projection.png');
    if (agentId === 'VCP_Assistant') return localAvatarImageUrl('VCP_Assistant.png');
    return null;
}

export function resolveKnownAgentId(message) {
    const agentId = message?.agentId || '';
    const actorId = message?.metadata?.actor_id || message?.actor_id || '';
    const speakerRoleHint = message?.metadata?.speaker_role_hint || message?.speaker_role_hint || '';
    const name = message?.name || message?.metadata?.actor_name_cn || '';
    const identity = `${agentId} ${actorId} ${speakerRoleHint} ${name}`.toLowerCase();

    if (identity.includes('codex') || identity.includes('ai设计师')) {
        return 'Codex_Projection';
    }
    if (identity.includes('xiaoan') || identity.includes('小安') || identity.includes('vcp_assistant')) {
        return 'VCP_Assistant';
    }
    return agentId || null;
}

export function resolveMessageAvatarUrl(message, fallback = 'assets/default_avatar.png') {
    const knownAgentId = resolveKnownAgentId(message);
    if (isHumanSideMessage(message)) {
        return localAvatarImageUrl('user_default.png') || fallback;
    }
    return canonicalAgentAvatarUrl(knownAgentId)
        || (knownAgentId ? localAgentAvatarUrl(knownAgentId) : null)
        || (!knownAgentId ? message?.avatarUrl : null)
        || fallback;
}

function resolveAvatarErrorFallback(message, isExternalAgent, knownAgentId) {
    if (isHumanSideMessage(message)) {
        return localAvatarImageUrl('user_default.png') || 'assets/default_user_avatar.png';
    }
    if (isExternalAgent || message?.isGroupMessage) {
        return (knownAgentId ? localAgentAvatarUrl(knownAgentId) : null) || 'assets/default_avatar.png';
    }
    return message?.role === 'user' ? 'assets/default_user_avatar.png' : 'assets/default_avatar.png';
}

export function isHumanSideMessage(message) {
    const actorType = message?.metadata?.actor_type || message?.actor_type || '';
    const actorId = message?.metadata?.actor_id || message?.actor_id || '';
    const speakerRoleHint = message?.metadata?.speaker_role_hint || message?.speaker_role_hint || '';
    const name = message?.name || message?.metadata?.actor_name_cn || '';
    return actorType === 'human'
        || actorId === 'yangchen'
        || actorId === 'owner'
        || actorId === 'user'
        || actorId === '用户'
        || actorId === '主人'
        || actorId === '杨晨'
        || speakerRoleHint === 'yangchen'
        || speakerRoleHint === 'owner'
        || speakerRoleHint === 'user'
        || name === '杨晨'
        || name === '主人'
        || name === '用户';
}

export function isAgentSideMessage(message) {
    if (!message?.isGroupMessage) return false;
    const actorType = message.metadata?.actor_type || message.actor_type || '';
    if (isHumanSideMessage(message)) return false;
    return actorType === 'external_codex'
        || actorType === 'external_participant'
        || actorType === 'vcp_agent'
        || message.agentId === 'Codex_Projection'
        || message.agentId === 'VCP_Assistant'
        || resolveKnownAgentId(message) === 'Codex_Projection'
        || resolveKnownAgentId(message) === 'VCP_Assistant';
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
    const inferredGroupMessage = message?.isGroupMessage === true
        || Boolean(message?.groupId)
        || currentSelectedItem?.type === 'group'
        || message?.metadata?.bridge_room === true;
    const renderMessage = inferredGroupMessage && message?.isGroupMessage !== true
        ? {
            ...message,
            isGroupMessage: true,
            groupId: message?.groupId || currentSelectedItem?.id || null
        }
        : message;
    const messageItem = document.createElement('div');
    const isExternalAgent = isAgentSideMessage(renderMessage);
    const knownAgentId = resolveKnownAgentId(renderMessage);
    const visualRole = isExternalAgent ? 'assistant' : renderMessage.role;
    messageItem.classList.add('message-item', visualRole);
    if (isExternalAgent) messageItem.classList.add('external-agent-message');
    if (knownAgentId === 'Codex_Projection') messageItem.classList.add('codex-projection-message');
    if (renderMessage.isGroupMessage) messageItem.classList.add('group-message-item');
    messageItem.dataset.timestamp = String(renderMessage.timestamp);
    messageItem.dataset.messageId = renderMessage.id;
    if (renderMessage.agentId) messageItem.dataset.agentId = renderMessage.agentId;
    applyUserMessageLayoutState(messageItem, globalSettings);

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('md-content');

    let avatarImg = null,
        nameTimeDiv = null,
        senderNameDiv = null,
        detailsAndBubbleWrapper = null;
    let avatarUrlToUse, senderNameToUse;

    if (renderMessage.role === 'user') {
        if (isExternalAgent) {
            avatarUrlToUse = resolveMessageAvatarUrl(renderMessage);
        } else {
            avatarUrlToUse = globalSettings.userAvatarUrl || 'assets/default_user_avatar.png';
        }
        senderNameToUse = renderMessage.name || globalSettings.userName || '你';
    } else if (renderMessage.role === 'assistant') {
        if (renderMessage.isGroupMessage) {
            avatarUrlToUse = resolveMessageAvatarUrl(renderMessage);
            senderNameToUse = renderMessage.name || '群成员';
        } else if (renderMessage.avatarUrl || (currentSelectedItem && currentSelectedItem.avatarUrl)) {
            avatarUrlToUse = renderMessage.avatarUrl || currentSelectedItem.avatarUrl;
            senderNameToUse = renderMessage.name || currentSelectedItem.name || 'AI';
        } else {
            avatarUrlToUse = 'assets/default_avatar.png';
            senderNameToUse = renderMessage.name || 'AI';
        }
    }

    if (renderMessage.role === 'user' || renderMessage.role === 'assistant') {
        avatarImg = document.createElement('img');
        avatarImg.classList.add('chat-avatar');
        avatarImg.src = fixVoiceChatAssetPath(addLocalAvatarCacheBuster(avatarUrlToUse));
        avatarImg.alt = `${senderNameToUse} 头像`;
        avatarImg.onerror = () => {
            avatarImg.onerror = null;
            avatarImg.src = fixVoiceChatAssetPath(addLocalAvatarCacheBuster(
                resolveAvatarErrorFallback(renderMessage, isExternalAgent, knownAgentId)
            ));
        };

        nameTimeDiv = document.createElement('div');
        nameTimeDiv.classList.add('name-time-block');

        senderNameDiv = document.createElement('div');
        senderNameDiv.classList.add('sender-name');
        senderNameDiv.textContent = senderNameToUse;

        nameTimeDiv.appendChild(senderNameDiv);

        if (renderMessage.timestamp && !renderMessage.isThinking) {
            const timestampDiv = document.createElement('div');
            timestampDiv.classList.add('message-timestamp');
            timestampDiv.textContent = formatMessageTimestamp(renderMessage.timestamp);
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
    applyUserMessageLayoutState,
    resolveMessageAvatarUrl,
    resolveKnownAgentId,
    isHumanSideMessage,
    isAgentSideMessage
};
