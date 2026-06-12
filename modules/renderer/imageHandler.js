// modules/renderer/imageHandler.js
import { fixEmoticonUrl } from './emoticonUrlFixer.js';
 

let imageHandlerRefs = {
    electronAPI: null,
    uiHelper: null,
    chatMessagesDiv: null,
};

// --- OpenHerPersona 聊天分条（burst bubbles） ---
// 模型在一次生成里用 <!--brk--> 注释自我分条（由 OpenHerPersona 的 hint 引导，
// 零额外模型调用）。注释经 marked 渲染后成为 DOM 注释节点，这里把顶层内容按
// 标记分桶成多个气泡，并对最新消息做 QQ 式逐条浮现动画。
const BURST_MARKER_VALUE = 'brk';

function isBurstMarkerNode(node) {
    return Boolean(node) && node.nodeType === Node.COMMENT_NODE && String(node.nodeValue || '').trim() === BURST_MARKER_VALUE;
}

function nodesHaveContent(nodes) {
    return nodes.some((node) => {
        if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent.trim());
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        return Boolean(node.textContent.trim())
            || Boolean(node.matches?.('img,video,audio,canvas,iframe,svg'))
            || Boolean(node.querySelector('img,video,audio,canvas,iframe,svg'));
    });
}

function applyBurstBubbles(contentDiv) {
    if (!contentDiv) return;
    const messageItem = contentDiv.closest ? contentDiv.closest('.message-item') : null;
    if (messageItem && (messageItem.classList.contains('streaming') || messageItem.classList.contains('thinking'))) {
        return;
    }

    // 流式期间已实时分条（burst-streaming），或本消息此前已播放过浮现动画
    // （收尾阶段可能发生第二次整段重渲染），都不再重放，避免"重新弹出"。
    const wasStreaming = contentDiv.classList.contains('burst-streaming');
    contentDiv.classList.remove('burst-streaming');
    const alreadyRevealed = Boolean(messageItem && messageItem.dataset.burstRevealed === 'true');

    const wrappers = splitIntoBurstBubbles(contentDiv);
    if (wrappers.length === 0) return;
    contentDiv.classList.add('burst-mode');
    if (messageItem) messageItem.dataset.burstRevealed = 'true';

    const isInitialLoad = messageItem?.dataset?.vcpInitialLoad === 'true';
    const animate =
        !isInitialLoad &&
        !wasStreaming &&
        !alreadyRevealed &&
        Boolean(messageItem && messageItem.parentElement && messageItem.parentElement.lastElementChild === messageItem);
    if (!animate) return;

    let revealDelay = 0;
    wrappers.forEach((wrapper, index) => {
        if (index === 0) return;
        // 延迟按上一条的长度估算"打字时间"，模拟下一条分条到达的节奏
        const previousLength = (wrappers[index - 1].textContent || '').length;
        revealDelay += Math.min(1500, 360 + previousLength * 22);
        wrapper.classList.add('burst-pending');
        wrapper.style.animationDelay = `${revealDelay}ms`;
    });
}

function findBurstAvatarSrc(container) {
    const messageItem = container.closest ? container.closest('.message-item') : null;
    // 头像行的负边距对齐只按 assistant 左侧布局设计；用户消息不套头像行
    if (!messageItem || messageItem.classList.contains('user')) return null;
    const avatar = messageItem.querySelector('img.chat-avatar');
    return avatar && avatar.src ? avatar.src : null;
}

// 核心分桶：把 container 顶层内容按 brk 注释标记包装成气泡序列。
// 第 2 条起套上"假头像行"（克隆本消息头像），冒充独立的新消息。
// 返回包出来的外层元素数组（首条为 .burst-bubble，其余为 .burst-row）；
// 有效段落数少于 minBubbles 时不动结构，返回空数组。
// （最终渲染要求 ≥2 段才值得分条；流式稳定区则 1 段就包，尾部根充当下一条气泡。）
export function splitIntoBurstBubbles(container, minBubbles = 2) {
    if (!container) return [];

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT);
    const markers = [];
    let current;
    while ((current = walker.nextNode())) {
        if (String(current.nodeValue || '').trim() === BURST_MARKER_VALUE) markers.push(current);
    }
    if (markers.length === 0) return [];

    // 只接受由 Markdown 独立行 `<!--brk-->` 渲染出来的顶层注释节点作为分条触发器。
    // 行内标记通常会留在 <p> / <li> 等内容容器内，一律移除，不拆父节点，避免行间误触发。
    for (const marker of markers) {
        const parent = marker.parentNode;
        if (!parent || parent === container) continue;
        marker.remove();
    }

    const topLevelNodes = Array.from(container.childNodes);
    const existingWrappers = topLevelNodes.filter((node) => (
        node.nodeType === Node.ELEMENT_NODE
        && (node.classList.contains('burst-bubble') || node.classList.contains('burst-row'))
    ));
    const lastExistingWrapperIndex = topLevelNodes.reduce((lastIndex, node, index) => (
        node.nodeType === Node.ELEMENT_NODE
        && (node.classList.contains('burst-bubble') || node.classList.contains('burst-row'))
            ? index
            : lastIndex
    ), -1);
    const sourceNodes = lastExistingWrapperIndex === -1
        ? topLevelNodes
        : topLevelNodes.slice(lastExistingWrapperIndex + 1);
    const hasMarkerInSourceNodes = sourceNodes.some(isBurstMarkerNode);
    if (lastExistingWrapperIndex !== -1 && !hasMarkerInSourceNodes) {
        return existingWrappers;
    }

    const groups = [[]];
    for (const child of sourceNodes) {
        if (isBurstMarkerNode(child)) {
            child.remove();
            if (groups[groups.length - 1].length > 0) groups.push([]);
            continue;
        }
        groups[groups.length - 1].push(child);
    }

    const bubbleGroups = groups.filter(nodesHaveContent);
    const allWrappers = [...existingWrappers];
    if (bubbleGroups.length + existingWrappers.length < minBubbles) return allWrappers.length > 0 ? allWrappers : [];
    groups
        .filter((group) => !nodesHaveContent(group))
        .forEach((group) => group.forEach((node) => node.remove()));

    const avatarSrc = findBurstAvatarSrc(container);

    const newWrappers = bubbleGroups.map((nodes, index) => {
        const bubble = document.createElement('div');
        bubble.className = 'burst-bubble';
        nodes.forEach((node) => bubble.appendChild(node));

        if ((existingWrappers.length === 0 && index === 0) || !avatarSrc) {
            container.appendChild(bubble);
            return bubble;
        }

        const row = document.createElement('div');
        row.className = 'burst-row';
        const avatar = document.createElement('img');
        avatar.className = 'burst-avatar';
        avatar.src = avatarSrc;
        avatar.alt = '';
        row.appendChild(avatar);
        row.appendChild(bubble);
        container.appendChild(row);
        return row;
    });

    return [...allWrappers, ...newWrappers];
}

export function initializeImageHandler(refs) {
    imageHandlerRefs.electronAPI = refs.electronAPI;
    imageHandlerRefs.uiHelper = refs.uiHelper;
    imageHandlerRefs.chatMessagesDiv = refs.chatMessagesDiv;
    console.log("[ImageHandler] Initialized.");
}

/**
 * 将内容设置到DOM元素，并处理其中的图片。
 * 此函数现在管理一个持久化的图片加载状态，以防止在流式渲染中重复加载和闪烁。
 * @param {HTMLElement} contentDiv - 要设置内容的DOM元素。
 * @param {string} rawHtml - 经过marked.parse()处理的原始HTML。
 * @param {string} messageId - 消息ID。
 */
export function setContentAndProcessImages(contentDiv, rawHtml, messageId) {
    // 🟢 直接设置 HTML，不做替换
    contentDiv.innerHTML = rawHtml;

    // OpenHerPersona 聊天分条：按 brk 注释标记把内容拆成连发气泡
    try {
        applyBurstBubbles(contentDiv);
    } catch (error) {
        console.warn('[ImageHandler] burst bubble split failed:', error);
    }

    // 🟢 然后对所有 <img> 添加事件监听
    const images = contentDiv.querySelectorAll('img');
    images.forEach((img, index) => {
        // 分条假头像不参与图片预览/右键复制
        if (img.classList.contains('burst-avatar')) return;
        let src = img.src;
        
        // 修复表情包 URL
        if (fixEmoticonUrl && src.includes('表情包')) {
            const fixedSrc = fixEmoticonUrl(src);
            if (fixedSrc !== src) {
                img.src = fixedSrc;
                src = fixedSrc;
            }
        }
        
        // 添加交互事件
        img.style.cursor = 'pointer';
        img.title = `点击在新窗口预览\n右键可复制图片`;
        
        img.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
            imageHandlerRefs.electronAPI.openImageViewer({
                src: src,
                title: img.alt || src.split('/').pop() || 'AI 图片',
                theme: currentTheme
            });
        });

        img.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            imageHandlerRefs.electronAPI.showImageContextMenu(src);
        });
    });
}