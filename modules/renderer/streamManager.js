// modules/renderer/streamManager.js
import { formatMessageTimestamp } from './domBuilder.js';
import { createContentPipeline, PIPELINE_MODES } from './contentPipeline.js';

// --- Stream State ---
const streamingChunkQueues = new Map(); // messageId -> array of original chunk strings
const streamingTimers = new Map();      // messageId -> intervalId
const accumulatedStreamText = new Map(); // messageId -> string
const streamSegmentStates = new Map(); // messageId -> { stableCutoff, stableHtml, stableRenderedCutoff, stableBlocks, stableBlockSeq, lastTailText, lastParagraphBoundary }
let activeStreamingMessageId = null; // Track the currently active streaming message
const elementContentLengthCache = new WeakMap(); // 跟踪每个元素的内容长度；WeakMap 避免 morphdom 替换节点后的强引用泄漏

// --- VCPdesktop 流式推送状态 ---
const desktopPushStates = new Map(); // messageId -> { active, widgetId, buffer, tagBuffer, created, pushTimer, lastPushedLength, lastTokenTime, validated }
const DESKTOP_PUSH_START_TAG = '<<<[DESKTOP_PUSH]>>>';
const DESKTOP_PUSH_END_TAG = '<<<[DESKTOP_PUSH_END]>>>';
const DESKTOP_PUSH_THROTTLE_MS = 100; // 每100ms推送一次累积内容到桌面画布
const DESKTOP_PUSH_TIMEOUT_MS = 150000; // 150秒超时：未闭合的推送块自动finalize
const DESKTOP_PUSH_VALID_PREFIXES = ['<!doctype', '<div', '<section', '<article', '<main', '<header', '<nav', '<aside', '<canvas', '<svg', '<style', 'target:','<!--'];
let desktopWindowAvailable = false; // 缓存桌面窗口是否可用，避免每个token都发IPC

const TOOL_REQUEST_START = '<<<[TOOL_REQUEST]>>>';
const TOOL_REQUEST_END = '<<<[END_TOOL_REQUEST]>>>';
const TOOL_RESULT_START = '[[VCP调用结果信息汇总:';
const TOOL_RESULT_END = 'VCP调用结果结束]]';
const TOOL_CALL_SUMMARY_START = '[本轮工具调用摘要:]';
const TOOL_CALL_SUMMARY_END = '[本轮工具调用摘要结束]';
const ROLE_DIVIDER_REGEX = /<<<\[(END_)?ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;
const DESKTOP_PUSH_START = '<<<[DESKTOP_PUSH]>>>';
const DESKTOP_PUSH_END = '<<<[DESKTOP_PUSH_END]>>>';
const CODE_FENCE = '```';
const THOUGHT_CHAIN_START = '[--- VCP元思考链';
const THOUGHT_CHAIN_END = '[--- 元思考链结束 ---]';
const THINK_START_REGEX = /<think(?:ing)?>/ig;
const THINK_END_REGEX = /<\/think(?:ing)?>/ig;
const DAILY_NOTE_START = '<<<DailyNoteStart>>>';
const DAILY_NOTE_END = '<<<DailyNoteEnd>>>';
// OpenHerPersona 聊天分条标记：完整出现即成为稳定切点，流式过程中实时分出气泡
const BURST_MARKER_TOKEN = '<!--brk-->';
const MARKDOWN_SECTION_BREAK_TOKEN = '---';
const STREAM_PARAGRAPH_SAFETY_BLOCKS = 1;
const HTML_ISLAND_MAX_STACK_DEPTH = 128;
const HTML_ISLAND_MAX_CHARS = 256 * 1024;
const HTML_RAWTEXT_TAGS = new Set(['script', 'style']);
const HTML_VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);
const HTML_ISLAND_STACK_TAGS = new Set([
    'a', 'article', 'aside', 'b', 'blockquote', 'button', 'canvas', 'code',
    'defs', 'div', 'em', 'figcaption', 'figure', 'filter', 'footer', 'form',
    'g', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'i', 'label', 'li',
    'lineargradient', 'main', 'nav', 'ol', 'p', 'path', 'pre', 'radialgradient',
    'section', 'select', 'span', 'strong', 'svg', 'table', 'tbody', 'td',
    'textarea', 'th', 'thead', 'tr', 'ul', ...HTML_RAWTEXT_TAGS
]);

const STREAM_BLOCK_TAG_REGEX = /^(P|DIV|UL|OL|LI|PRE|BLOCKQUOTE|H[1-6]|TABLE|TR|FIGURE)$/;
const STREAM_PRESERVED_BLOCK_CLASSES = [
    'vcp-tool-use-bubble',
    'vcp-tool-result-bubble',
    'maid-diary-bubble',
    'vcp-thought-chain-bubble',
    'vcp-role-divider',
    'mermaid',
    'katex',
    'vcp-html-preview-container'
];
const STREAM_PRESERVED_CHILD_ATTRS = [
    'data-vcp-preserve-children',
    'data-vcp-rendered',
    'data-vcp-html-preview'
];

function hasAnyClass(el, classNames) {
    return !!el?.classList && classNames.some(className => el.classList.contains(className));
}

function hasAnyAttribute(el, attrNames) {
    return !!el?.hasAttribute && attrNames.some(attrName => el.hasAttribute(attrName));
}

function shouldPreserveStreamElement(fromEl, toEl) {
    if (!fromEl || fromEl.nodeType !== 1) return false;

    if (hasAnyClass(fromEl, STREAM_PRESERVED_BLOCK_CLASSES)) {
        return true;
    }

    if (hasAnyAttribute(fromEl, STREAM_PRESERVED_CHILD_ATTRS)) {
        return true;
    }

    // 后处理后的代码高亮节点会带 hljs 类，流式下一帧不应反复重写其内部结构。
    if (fromEl.tagName === 'CODE' && fromEl.classList.contains('hljs')) {
        return true;
    }

    // KaTeX 通常会生成复杂嵌套 DOM，保留已处理结果，等待最终完整渲染统一刷新。
    if (fromEl.closest?.('.katex')) {
        return true;
    }

    return false;
}

function shouldSkipStreamChildren(fromEl, toEl) {
    if (!fromEl || fromEl.nodeType !== 1) return false;

    if (hasAnyClass(fromEl, STREAM_PRESERVED_BLOCK_CLASSES)) {
        return true;
    }

    if (hasAnyAttribute(fromEl, STREAM_PRESERVED_CHILD_ATTRS)) {
        return true;
    }

    if (fromEl.tagName === 'PRE' && fromEl.dataset.rawContent) {
        return true;
    }

    return false;
}

function preserveDynamicStreamState(fromEl, toEl) {
    if (!fromEl || !toEl || fromEl.nodeType !== 1 || toEl.nodeType !== 1) return;

    if (fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
    }

    if (fromEl.classList.contains('preview-mode')) {
        toEl.classList.add('preview-mode');
    }

    if (fromEl.dataset.vcpInteractive === 'true') {
        toEl.dataset.vcpInteractive = 'true';
    }

    if (fromEl.dataset.vcpBlockType) {
        toEl.dataset.vcpBlockType = fromEl.dataset.vcpBlockType;
    }

    if (fromEl.dataset.vcpKey) {
        toEl.dataset.vcpKey = fromEl.dataset.vcpKey;
    }
}

// --- DOM Cache ---
const messageDomCache = new Map(); // messageId -> { messageItem, contentDiv }

const scrollThrottleTimers = new Map(); // messageId -> timerId
const SCROLL_THROTTLE_MS = 100; // 100ms 节流
const viewContextCache = new Map(); // messageId -> boolean (是否为当前视图)
let currentViewSignature = null; // 当前视图的签名
let globalRenderLoopRunning = false;
const pendingDirectRenderMessages = new Set(); // 非平滑流式：chunk 到达只置脏，由全局 rAF 合帧渲染

// 记录延迟清理定时器，方便切换话题时统一清除
const delayedCleanupTimers = new Map(); // messageId -> timerId

// --- 新增：预缓冲系统 ---
const preBufferedChunks = new Map(); // messageId -> array of chunks waiting for initialization
const messageInitializationStatus = new Map(); // messageId -> 'pending' | 'ready' | 'finalized'
const pendingFinalizationEvents = new Map(); // messageId -> { finishReason, context, finalPayload }

// --- 新增：消息上下文映射 ---
const messageContextMap = new Map(); // messageId -> {agentId, groupId, topicId, isGroupMessage}

// --- Local Reference Store ---
let refs = {};
let contentPipeline = null;
let transientCleanupRegistered = false;

// --- Pre-compiled Regular Expressions for Performance ---

/**
 * Initializes the Stream Manager with necessary dependencies from the main renderer.
 * @param {object} dependencies - An object containing all required functions and references.
 */
export function initStreamManager(dependencies) {
    refs = dependencies;

    // App 级兜底扫帚：页面卸载时释放孤儿流的预缓冲、上下文映射、桌面推送 interval 等 transient 状态。
    // 不挂到 clearChat，避免切换话题时误伤同窗口内其他 agent 的后台流式聊天。
    if (!transientCleanupRegistered) {
        window.addEventListener('beforeunload', cleanupTransientState);
        transientCleanupRegistered = true;
    }

    contentPipeline = createContentPipeline({
        fixEmoticonUrlsInMarkdown: (text) => {
            if (!text || typeof text !== 'string' || !refs.emoticonUrlFixer) return text;

            let processedText = text;

            processedText = processedText.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
                const fixedUrl = refs.emoticonUrlFixer.fixEmoticonUrl(url);
                return `![${alt}](${fixedUrl})`;
            });

            processedText = processedText.replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, before, url, after) => {
                const fixedUrl = refs.emoticonUrlFixer.fixEmoticonUrl(url);
                return `<img${before}src="${fixedUrl}"${after}>`;
            });

            return processedText;
        },
        processStartEndMarkers: (text) => refs.processStartEndMarkers ? refs.processStartEndMarkers(text) : text,
        deIndentMisinterpretedCodeBlocks: (text) => refs.deIndentMisinterpretedCodeBlocks ? refs.deIndentMisinterpretedCodeBlocks(text) : text,
        applyContentProcessors: (text) => {
            let processedText = text;
            if (refs.removeSpeakerTags) {
                processedText = refs.removeSpeakerTags(processedText);
            }
            if (refs.ensureNewlineAfterCodeBlock) {
                processedText = refs.ensureNewlineAfterCodeBlock(processedText);
            }
            if (refs.ensureSpaceAfterTilde) {
                processedText = refs.ensureSpaceAfterTilde(processedText);
            }
            if (refs.ensureSeparatorBetweenImgAndCode) {
                processedText = refs.ensureSeparatorBetweenImgAndCode(processedText);
            }
            return processedText;
        }
    });

    // Assume morphdom is passed in dependencies, warn if not present.
    if (!refs.morphdom) {
        console.warn('[StreamManager] `morphdom` not provided. Streaming rendering will fall back to inefficient innerHTML updates.');
    }

    // 监听桌面窗口状态，缓存到本地标志位
    // 这样在流式推送时就不需要每个token都做IPC查询
    if (refs.electronAPI?.onDesktopStatus) {
        refs.electronAPI.onDesktopStatus((data) => {
            desktopWindowAvailable = !!data.connected;
            console.log(`[StreamManager] Desktop window availability changed: ${desktopWindowAvailable}`);
        });
    }
}

function shouldEnableSmoothStreaming() {
    const globalSettings = refs.globalSettingsRef.get();
    return globalSettings.enableSmoothStreaming === true;
}

function messageIsFinalized(messageId) {
    // Don't rely on current history, check accumulated state
    const initStatus = messageInitializationStatus.get(messageId);
    return initStatus === 'finalized';
}

function isThinkingPlaceholderText(text) {
    if (typeof text !== 'string') return false;
    const normalized = text.trim();
    return normalized === '思考中...' || normalized === '思考中' || normalized === 'Thinking...' || normalized === 'thinking...';
}

/**
 * 🟢 生成当前视图的唯一签名
 */
function getCurrentViewSignature() {
    const currentSelectedItem = refs.currentSelectedItemRef.get();
    const currentTopicId = refs.currentTopicIdRef.get();
    return `${currentSelectedItem?.id || 'none'}-${currentTopicId || 'none'}`;
}

/**
 * 🟢 带缓存的视图检查
 */
function isMessageForCurrentView(context) {
    if (!context) return false;
    
    const newSignature = getCurrentViewSignature();
    
    // 如果视图切换了，清空缓存
    if (currentViewSignature !== newSignature) {
        currentViewSignature = newSignature;
        viewContextCache.clear();
    }
    
    const currentSelectedItem = refs.currentSelectedItemRef.get();
    const currentTopicId = refs.currentTopicIdRef.get();
    
    if (!currentSelectedItem || !currentTopicId) return false;
    
    const itemId = context.groupId || context.agentId;
    return itemId === currentSelectedItem.id && context.topicId === currentTopicId;
}

async function getHistoryForContext(context) {
    const { electronAPI } = refs;
    if (!context) return null;
    
    const { agentId, groupId, topicId, isGroupMessage } = context;
    const itemId = groupId || agentId;
    
    if (!itemId || !topicId) return null;
    
    try {
        const historyResult = isGroupMessage
            ? await electronAPI.getGroupChatHistory(itemId, topicId)
            : await electronAPI.getChatHistory(itemId, topicId);
        
        if (historyResult && !historyResult.error) {
            return historyResult;
        }
    } catch (e) {
        console.error(`[StreamManager] Failed to get history for context`, context, e);
    }
    
    return null;
}

// 🟢 历史保存防抖
const historySaveQueue = new Map(); // context signature -> {context, history, timerId}
const HISTORY_SAVE_DEBOUNCE = 1000; // 1秒防抖

async function debouncedSaveHistory(context, history) {
    if (!context || context.topicId === 'assistant_chat' || context.topicId?.startsWith('voicechat_')) {
        return; // 跳过临时聊天
    }
    
    const signature = `${context.groupId || context.agentId}-${context.topicId}`;
    
    // 清除之前的定时器
    const existing = historySaveQueue.get(signature);
    if (existing?.timerId) {
        clearTimeout(existing.timerId);
    }
    
    // 设置新的防抖定时器
    const timerId = setTimeout(async () => {
        const queuedData = historySaveQueue.get(signature);
        if (queuedData) {
            await saveHistoryForContext(queuedData.context, queuedData.history);
            historySaveQueue.delete(signature);
        }
    }, HISTORY_SAVE_DEBOUNCE);
    
    // 使用最新的 history 克隆以避免引用问题
    historySaveQueue.set(signature, { context, history: [...history], timerId });
}

async function saveHistoryForContext(context, history) {
    const { electronAPI } = refs;
    if (!context || context.isGroupMessage) {
        // For group messages, the main process (groupchat.js) is the single source of truth for history.
        // The renderer avoids saving to prevent race conditions and overwriting the correct history.
        return;
    }
    
    const { agentId, topicId } = context;
    
    if (!agentId || !topicId) return;
    
    const historyToSave = history.filter(msg => !msg.isThinking);
    
    try {
        await electronAPI.saveChatHistory(agentId, topicId, historyToSave);
    } catch (e) {
        console.error(`[StreamManager] Failed to save history for context`, context, e);
    }
}

/**
 * 批量应用流式渲染所需的轻量级预处理。
 * P0-1 后仅作为 parseTail 缺失时的兜底；正常路径由 messageRenderer 注入的 parseTail 统一处理。
 */
function applyStreamingPreprocessors(text) {
    if (!text) return '';
    if (!contentPipeline) return text;

    return contentPipeline.process(text, {
        mode: PIPELINE_MODES.STREAM_FAST
    }).text;
}

function parseStreamTail(text) {
    if (typeof refs.parseTail === 'function') {
        return refs.parseTail(text);
    }

    const processedText = applyStreamingPreprocessors(text);
    return refs.markedInstance?.parse ? refs.markedInstance.parse(processedText) : processedText;
}

function parseFullStreamContent(text, options = {}) {
    if (typeof refs.parseFull === 'function') {
        return refs.parseFull(text, options);
    }

    return refs.markedInstance?.parse ? refs.markedInstance.parse(text) : text;
}

function ensureStreamingRoots(contentDiv) {
    let stableRoot = contentDiv.querySelector('.vcp-stream-stable-root');
    let stableBlocksRoot = contentDiv.querySelector('.vcp-stream-stable-blocks-root');
    let tailRoot = contentDiv.querySelector('.vcp-stream-tail-root');

    if (!stableRoot || !tailRoot) {
        contentDiv.innerHTML = '';
        stableRoot = document.createElement('div');
        stableRoot.className = 'vcp-stream-stable-root';
        stableBlocksRoot = document.createElement('div');
        stableBlocksRoot.className = 'vcp-stream-stable-blocks-root';
        stableRoot.appendChild(stableBlocksRoot);
        tailRoot = document.createElement('div');
        tailRoot.className = 'vcp-stream-tail-root';
        contentDiv.appendChild(stableRoot);
        contentDiv.appendChild(tailRoot);
    } else if (!stableBlocksRoot) {
        // 兼容旧的 stableRoot 结构：后续追加式固化只写入 stableBlocksRoot。
        // 如果 stableRoot 已有旧内容，先原样搬入 blocksRoot，避免切换实现时丢失已渲染 DOM。
        stableBlocksRoot = document.createElement('div');
        stableBlocksRoot.className = 'vcp-stream-stable-blocks-root';
        while (stableRoot.firstChild) {
            stableBlocksRoot.appendChild(stableRoot.firstChild);
        }
        stableRoot.appendChild(stableBlocksRoot);
    }

    return { stableRoot, stableBlocksRoot, tailRoot };
}

function getOrCreateStreamSegmentState(messageId) {
    let state = streamSegmentStates.get(messageId);
    if (!state) {
        state = {
            // 已判定为稳定的源码前缀终点；tail 从这里开始渲染。
            stableCutoff: 0,
            // 兼容旧路径/调试用：记录最近一次稳定 HTML 片段或前缀。
            stableHtml: '',
            // 已实际追加固化到 stableBlocksRoot 的源码终点。
            // 下一步切换为追加式固化时，只渲染 [stableRenderedCutoff, stableCutoff)。
            stableRenderedCutoff: 0,
            // 追加式 stable block 元数据：{ id, start, end, source, html, element }。
            stableBlocks: [],
            stableBlockSeq: 0,
            lastTailText: '',
            lastParagraphBoundary: 0,
            burstBubbleCount: 0
        };
        streamSegmentStates.set(messageId, state);
    }
    return state;
}

function createStableBlockRecord(segmentState, start, end, source, html, element = null) {
    const id = `stream-stable-block-${segmentState.stableBlockSeq++}`;
    return {
        id,
        start,
        end,
        source,
        html,
        element
    };
}

function resetStableBlockState(segmentState) {
    segmentState.stableRenderedCutoff = 0;
    segmentState.stableBlocks = [];
    segmentState.stableBlockSeq = 0;
    segmentState.stableHtml = '';
}

function appendStableBlockFragment(stableBlocksRoot, segmentState, sourceText, html, options = {}) {
    if (!stableBlocksRoot || !sourceText) return null;

    const {
        messageId = null,
        settings = null
    } = options;

    const blockEl = document.createElement('div');
    const blockRecord = createStableBlockRecord(
        segmentState,
        segmentState.stableRenderedCutoff,
        segmentState.stableRenderedCutoff + sourceText.length,
        sourceText,
        html,
        blockEl
    );

    blockEl.className = 'vcp-stream-stable-block';
    blockEl.dataset.vcpStreamStableBlock = 'true';
    blockEl.dataset.vcpBlockKey = blockRecord.id;
    blockEl.dataset.vcpStableStart = String(blockRecord.start);
    blockEl.dataset.vcpStableEnd = String(blockRecord.end);

    stableBlocksRoot.appendChild(blockEl);
    segmentState.stableBlocks.push(blockRecord);
    segmentState.stableRenderedCutoff = blockRecord.end;
    segmentState.stableHtml += html || '';

    if (typeof refs.renderPostProcessedHtml === 'function') {
        const enrichResult = refs.renderPostProcessedHtml(blockEl, html, {
            messageId,
            settings,
            renderSessionId: null,
            runHeavy: true,
            includeAttachments: false
        });
        if (enrichResult && typeof enrichResult.catch === 'function') {
            enrichResult.catch(error => console.error('[StreamManager] Stable block enrichment failed:', error));
        }
    } else {
        blockEl.innerHTML = html;
    }

    return blockRecord;
}

function appendNewStableRange(stableBlocksRoot, segmentState, textForRendering, nextStableCutoff, options = {}) {
    if (nextStableCutoff <= segmentState.stableRenderedCutoff) return [];

    // 如果外部状态异常回退，宁可重置追加缓存，也不要产生重叠 block。
    if (segmentState.stableRenderedCutoff > nextStableCutoff) {
        stableBlocksRoot.textContent = '';
        resetStableBlockState(segmentState);
    }

    const appendedBlocks = [];

    while (segmentState.stableRenderedCutoff < nextStableCutoff) {
        const currentOffset = segmentState.stableRenderedCutoff;
        const markerIndex = findNextLineOnlyToken(textForRendering, BURST_MARKER_TOKEN, currentOffset);
        const effectiveMarkerIndex = markerIndex !== -1 && markerIndex < nextStableCutoff ? markerIndex : -1;
        const sliceEnd = effectiveMarkerIndex === -1 ? nextStableCutoff : effectiveMarkerIndex;
        const sourceText = textForRendering.slice(currentOffset, sliceEnd);

        if (sourceText) {
            const html = parseFullStreamContent(sourceText);
            const blockRecord = appendStableBlockFragment(stableBlocksRoot, segmentState, sourceText, html, options);
            if (blockRecord) appendedBlocks.push(blockRecord);
        }

        if (effectiveMarkerIndex === -1) {
            break;
        }

        // 独立行 <!--brk--> 作为稳定切点和气泡边界参与源码进度，
        // 但不渲染进 stable block，避免后续为了分条再解包/搬运已稳定 DOM。
        segmentState.stableRenderedCutoff = effectiveMarkerIndex + BURST_MARKER_TOKEN.length;
    }

    return appendedBlocks;
}

function unwrapStableBlockContainersForBurst(stableBlocksRoot, segmentState) {
    if (!stableBlocksRoot) return;

    const blockEls = Array.from(stableBlocksRoot.querySelectorAll(':scope > .vcp-stream-stable-block'));
    if (blockEls.length === 0) return;

    for (const blockEl of blockEls) {
        const parent = blockEl.parentNode;
        if (!parent) continue;

        while (blockEl.firstChild) {
            parent.insertBefore(blockEl.firstChild, blockEl);
        }
        blockEl.remove();
    }

    // burst 分条会重排 stable DOM；后续 stable block 继续追加即可，旧 block 元数据不再依赖 element 引用。
    for (const block of segmentState.stableBlocks) {
        block.element = null;
    }
}

// 分条流式时给尾部根（"正在打字"的下一条）套上头像行，看起来像新消息正在到来。
// 收尾阶段会整体重渲染 contentDiv，包装行随之消失。
function ensureBurstTailRow(contentDiv, tailRoot, messageItem) {
    if (contentDiv.querySelector('.burst-tail-row')) return;
    const avatar = messageItem ? messageItem.querySelector('img.chat-avatar') : null;
    const tailRow = document.createElement('div');
    tailRow.className = 'burst-row burst-tail-row';
    if (avatar && avatar.src) {
        const tailAvatar = document.createElement('img');
        tailAvatar.className = 'burst-avatar';
        tailAvatar.src = avatar.src;
        tailAvatar.alt = '';
        tailRow.appendChild(tailAvatar);
    }
    contentDiv.appendChild(tailRow);
    tailRow.appendChild(tailRoot);
}

function createBurstAvatarForMessage(messageItem) {
    const avatar = messageItem ? messageItem.querySelector('img.chat-avatar') : null;
    if (!avatar || !avatar.src) return null;

    const burstAvatar = document.createElement('img');
    burstAvatar.className = 'burst-avatar';
    burstAvatar.src = avatar.src;
    burstAvatar.alt = '';
    return burstAvatar;
}

function promoteStableBlocksToBurstBubbles(stableBlocksRoot, messageItem) {
    if (!stableBlocksRoot) return [];

    const wrappers = [];
    const children = Array.from(stableBlocksRoot.children);
    let existingBubbleCount = 0;

    for (const child of children) {
        if (child.classList.contains('burst-row') || child.classList.contains('burst-bubble')) {
            existingBubbleCount += 1;
            wrappers.push(child);
        }
    }

    const blockEls = children.filter((child) => (
        child.classList.contains('vcp-stream-stable-block')
        && child.dataset.vcpBurstWrapped !== 'true'
    ));

    for (const blockEl of blockEls) {
        blockEl.dataset.vcpBurstWrapped = 'true';
        blockEl.classList.add('burst-bubble');

        if (existingBubbleCount === 0) {
            wrappers.push(blockEl);
            existingBubbleCount += 1;
            continue;
        }

        const row = document.createElement('div');
        row.className = 'burst-row';
        const burstAvatar = createBurstAvatarForMessage(messageItem);
        if (burstAvatar) row.appendChild(burstAvatar);
        stableBlocksRoot.insertBefore(row, blockEl);
        row.appendChild(blockEl);
        wrappers.push(row);
        existingBubbleCount += 1;
    }

    return wrappers;
}

function startsWithAt(text, index, token) {
    return text.startsWith(token, index);
}

function findMatchingFenceEnd(text, startIndex) {
    const openEnd = text.indexOf('\n', startIndex);
    if (openEnd === -1) return -1;

    let searchIndex = openEnd + 1;
    while (searchIndex < text.length) {
        const closeIndex = text.indexOf(CODE_FENCE, searchIndex);
        if (closeIndex === -1) return -1;

        const lineStart = closeIndex === 0 ? 0 : text.lastIndexOf('\n', closeIndex - 1) + 1;
        const prefix = text.slice(lineStart, closeIndex);
        if (prefix.trim() === '') {
            const lineEnd = text.indexOf('\n', closeIndex);
            return lineEnd === -1 ? text.length : lineEnd + 1;
        }

        searchIndex = closeIndex + CODE_FENCE.length;
    }

    return -1;
}

function isLineOnlyToken(text, tokenStart, tokenLength) {
    const lineStart = tokenStart === 0 ? 0 : text.lastIndexOf('\n', tokenStart - 1) + 1;
    const lineEndIndex = text.indexOf('\n', tokenStart + tokenLength);
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
    const before = text.slice(lineStart, tokenStart);
    const after = text.slice(tokenStart + tokenLength, lineEnd);

    return before.trim() === '' && after.trim() === '';
}

function findNextLineOnlyToken(text, token, startOffset = 0) {
    let index = Math.max(0, startOffset);
    while (index < text.length) {
        const tokenIndex = text.indexOf(token, index);
        if (tokenIndex === -1) return -1;
        if (isLineOnlyToken(text, tokenIndex, token.length)) return tokenIndex;
        index = tokenIndex + token.length;
    }
    return -1;
}

function hasLineOnlyToken(text, token) {
    return findNextLineOnlyToken(text, token, 0) !== -1;
}

function findDisplayMathBlockEnd(text, startIndex, delimiter) {
    if (!isLineOnlyToken(text, startIndex, delimiter.length)) {
        return -1;
    }

    let searchIndex = startIndex + delimiter.length;
    while (searchIndex < text.length) {
        const closeIndex = text.indexOf(delimiter, searchIndex);
        if (closeIndex === -1) return -1;

        if (isLineOnlyToken(text, closeIndex, delimiter.length)) {
            const lineEnd = text.indexOf('\n', closeIndex + delimiter.length);
            return lineEnd === -1 ? text.length : lineEnd + 1;
        }

        searchIndex = closeIndex + delimiter.length;
    }

    return -1;
}

function findConventionalThinkEnd(text, startIndex) {
    THINK_END_REGEX.lastIndex = startIndex;
    const match = THINK_END_REGEX.exec(text);
    THINK_END_REGEX.lastIndex = 0;
    return match ? match.index + match[0].length : -1;
}

function findConventionalThinkStart(text, startIndex) {
    THINK_START_REGEX.lastIndex = startIndex;
    const match = THINK_START_REGEX.exec(text);
    THINK_START_REGEX.lastIndex = 0;
    return match ? match.index : -1;
}

function findParagraphStableCutoff(text, floorOffset) {
    const boundaries = [];
    let searchIndex = Math.max(0, floorOffset);

    while (searchIndex < text.length) {
        const boundaryIndex = text.indexOf('\n\n', searchIndex);
        if (boundaryIndex === -1) break;

        const cutoff = boundaryIndex + 2;
        if (cutoff > floorOffset) {
            boundaries.push(cutoff);
        }

        searchIndex = cutoff;
    }

    if (boundaries.length <= STREAM_PARAGRAPH_SAFETY_BLOCKS) {
        return floorOffset;
    }

    return boundaries[boundaries.length - 1 - STREAM_PARAGRAPH_SAFETY_BLOCKS];
}

function findHtmlTagEnd(text, tagStart) {
    let quote = null;

    for (let i = tagStart + 1; i < text.length; i++) {
        const char = text[i];

        if (quote) {
            if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (char === '>') {
            return i;
        }
    }

    return -1;
}

function parseHtmlTagToken(text, tagStart) {
    if (startsWithAt(text, tagStart, '<!--')) {
        return { type: 'comment' };
    }

    const tagEnd = findHtmlTagEnd(text, tagStart);
    if (tagEnd === -1) {
        return { type: 'incomplete' };
    }

    const raw = text.slice(tagStart + 1, tagEnd);
    const trimmed = raw.trim();

    if (!trimmed) {
        return { type: 'unknown', tagEnd };
    }

    if (trimmed[0] === '!' || trimmed[0] === '?') {
        return { type: 'declaration', tagEnd };
    }

    const isClosing = trimmed[0] === '/';
    const nameSource = isClosing ? trimmed.slice(1).trimStart() : trimmed;
    const nameMatch = nameSource.match(/^([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!nameMatch) {
        return { type: 'unknown', tagEnd };
    }

    const name = nameMatch[1].toLowerCase();
    return {
        type: 'tag',
        tagEnd,
        name,
        isClosing,
        isSelfClosing: /\/\s*$/.test(trimmed)
    };
}

function popHtmlIslandStack(stack, tagName) {
    const topIndex = stack.lastIndexOf(tagName);
    if (topIndex === -1) {
        return false;
    }

    stack.splice(topIndex);
    return true;
}

function isBareDivIslandLineStart(text, tagStart) {
    const lineStart = tagStart === 0 ? 0 : text.lastIndexOf('\n', tagStart - 1) + 1;
    const prefix = text.slice(lineStart, tagStart);

    // 只把“新行上暴露的裸 <div>”视为动画岛入口。
    // 行内代码 `... <div> ...`、普通 Markdown 文本中的 <div> 提及、反引号包裹的 `<div>` 都不会触发。
    return prefix.trim() === '';
}

function scanBareDivIslandEnd(text, startIndex) {
    const stack = [];
    let index = startIndex;
    const lowerText = text.toLowerCase();

    while (index < text.length) {
        if (index - startIndex > HTML_ISLAND_MAX_CHARS) {
            return { end: -1, blocked: true, abandoned: true };
        }

        const tagStart = text.indexOf('<', index);
        if (tagStart === -1) {
            return { end: -1, blocked: true };
        }

        if (tagStart - startIndex > HTML_ISLAND_MAX_CHARS) {
            return { end: -1, blocked: true, abandoned: true };
        }

        if (startsWithAt(text, tagStart, '<!--')) {
            const commentEnd = text.indexOf('-->', tagStart + 4);
            if (commentEnd === -1) {
                return { end: -1, blocked: true };
            }
            index = commentEnd + 3;
            continue;
        }

        const token = parseHtmlTagToken(text, tagStart);
        if (token.type === 'incomplete') {
            return { end: -1, blocked: true };
        }

        if (token.type !== 'tag') {
            index = (token.tagEnd ?? tagStart) + 1;
            continue;
        }

        const { name, tagEnd, isClosing, isSelfClosing } = token;

        if (isClosing) {
            popHtmlIslandStack(stack, name);
            index = tagEnd + 1;

            if (stack.length === 0) {
                return { end: index, blocked: false };
            }

            continue;
        }

        const shouldPush = !isSelfClosing && !HTML_VOID_TAGS.has(name) && HTML_ISLAND_STACK_TAGS.has(name);
        if (!shouldPush) {
            index = tagEnd + 1;
            continue;
        }

        stack.push(name);
        if (stack.length > HTML_ISLAND_MAX_STACK_DEPTH) {
            return { end: -1, blocked: true, abandoned: true };
        }

        index = tagEnd + 1;

        if (HTML_RAWTEXT_TAGS.has(name)) {
            const rawTextCloseStart = lowerText.indexOf(`</${name}`, index);
            if (rawTextCloseStart === -1) {
                return { end: -1, blocked: true };
            }

            const rawTextCloseToken = parseHtmlTagToken(text, rawTextCloseStart);
            if (rawTextCloseToken.type === 'incomplete') {
                return { end: -1, blocked: true };
            }

            if (rawTextCloseToken.type === 'tag' && rawTextCloseToken.isClosing && rawTextCloseToken.name === name) {
                popHtmlIslandStack(stack, name);
                index = rawTextCloseToken.tagEnd + 1;

                if (stack.length === 0) {
                    return { end: index, blocked: false };
                }
            } else {
                index = rawTextCloseStart + 2;
            }
        }
    }

    return { end: -1, blocked: true };
}

function findBareDivIslandStableCutoff(text, startOffset = 0) {
    if (typeof text !== 'string') {
        return { cutoff: startOffset, blocked: false };
    }

    let index = Math.max(0, startOffset);
    let cutoff = startOffset;

    while (index < text.length) {
        const tagStart = text.indexOf('<', index);
        if (tagStart === -1) {
            break;
        }

        if (startsWithAt(text, tagStart, '<!--')) {
            const commentEnd = text.indexOf('-->', tagStart + 4);
            if (commentEnd === -1) {
                return { cutoff, blocked: true };
            }
            index = commentEnd + 3;
            continue;
        }

        const token = parseHtmlTagToken(text, tagStart);
        if (token.type === 'incomplete') {
            return { cutoff, blocked: true };
        }

        if (token.type !== 'tag') {
            index = (token.tagEnd ?? tagStart) + 1;
            continue;
        }

        if (!token.isClosing && token.name === 'div' && !token.isSelfClosing && isBareDivIslandLineStart(text, tagStart)) {
            const island = scanBareDivIslandEnd(text, tagStart);
            if (island.end > tagStart) {
                cutoff = island.end;
                index = island.end;
                continue;
            }

            return {
                cutoff,
                blocked: true,
                abandoned: island.abandoned === true
            };
        }

        index = token.tagEnd + 1;
    }

    return { cutoff, blocked: false };
}

function hasLikelyUnclosedHtmlIsland(text, startOffset = 0) {
    return findBareDivIslandStableCutoff(text, startOffset).blocked;
}

function findRoleDividerSectionEnd(text, startIndex) {
    ROLE_DIVIDER_REGEX.lastIndex = startIndex;
    const startMatch = ROLE_DIVIDER_REGEX.exec(text);
    ROLE_DIVIDER_REGEX.lastIndex = 0;

    if (!startMatch || startMatch.index !== startIndex || startMatch[1]) {
        return -1;
    }

    const role = startMatch[2];
    const endToken = `<<<[END_ROLE_DIVIDE_${role}]>>>`;
    const endIndex = text.indexOf(endToken, startIndex + startMatch[0].length);
    return endIndex === -1 ? -1 : endIndex + endToken.length;
}

function findExplicitStablePrefix(text, startOffset = 0) {
    let index = Math.max(0, startOffset);
    let stableCutoff = startOffset;
    let paragraphFloor = startOffset;
    let blockedByUnclosedExplicitBlock = false;

    while (index < text.length) {
        if (startsWithAt(text, index, CODE_FENCE)) {
            const fenceEnd = findMatchingFenceEnd(text, index);
            if (fenceEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = fenceEnd;
            paragraphFloor = fenceEnd;
            index = fenceEnd;
            continue;
        }

        if (startsWithAt(text, index, '$$') && isLineOnlyToken(text, index, 2)) {
            const mathEnd = findDisplayMathBlockEnd(text, index, '$$');
            if (mathEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = mathEnd;
            paragraphFloor = mathEnd;
            index = mathEnd;
            continue;
        }

        if (startsWithAt(text, index, '\\[') && isLineOnlyToken(text, index, 2)) {
            const mathEnd = findDisplayMathBlockEnd(text, index, '\\]');
            if (mathEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = mathEnd;
            paragraphFloor = mathEnd;
            index = mathEnd;
            continue;
        }

        if (startsWithAt(text, index, TOOL_REQUEST_START)) {
            const endIndex = text.indexOf(TOOL_REQUEST_END, index + TOOL_REQUEST_START.length);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + TOOL_REQUEST_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, TOOL_RESULT_START)) {
            const endIndex = text.indexOf(TOOL_RESULT_END, index + TOOL_RESULT_START.length);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + TOOL_RESULT_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, TOOL_CALL_SUMMARY_START)) {
            const endIndex = text.indexOf(TOOL_CALL_SUMMARY_END, index + TOOL_CALL_SUMMARY_START.length);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + TOOL_CALL_SUMMARY_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, '<<<[ROLE_DIVIDE_')) {
            const sectionEnd = findRoleDividerSectionEnd(text, index);
            if (sectionEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = sectionEnd;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, DESKTOP_PUSH_START)) {
            const endIndex = text.indexOf(DESKTOP_PUSH_END, index + DESKTOP_PUSH_START.length);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + DESKTOP_PUSH_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, THOUGHT_CHAIN_START)) {
            const endIndex = text.indexOf(THOUGHT_CHAIN_END, index + THOUGHT_CHAIN_START.length);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + THOUGHT_CHAIN_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, DAILY_NOTE_START)) {
            const endIndex = text.indexOf(DAILY_NOTE_END, index + DAILY_NOTE_START.length);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + DAILY_NOTE_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, BURST_MARKER_TOKEN)) {
            if (isLineOnlyToken(text, index, BURST_MARKER_TOKEN.length)) {
                // 只有独立行的 <!--brk--> 才是 OpenHerPersona 分条触发器；
                // 行内出现的注释只按普通 Markdown/HTML 内容处理，避免误切分。
                stableCutoff = index + BURST_MARKER_TOKEN.length;
                paragraphFloor = stableCutoff;
            }
            index += BURST_MARKER_TOKEN.length;
            continue;
        }

        if (startsWithAt(text, index, MARKDOWN_SECTION_BREAK_TOKEN)) {
            if (isLineOnlyToken(text, index, MARKDOWN_SECTION_BREAK_TOKEN.length)) {
                // 独立行 Markdown 文档分段符 --- 可作为稳定切点；
                // 目前只处理严格的 ---，暂不扩展到 ***/___ 或带空格变体。
                stableCutoff = index + MARKDOWN_SECTION_BREAK_TOKEN.length;
                paragraphFloor = stableCutoff;
            }
            index += MARKDOWN_SECTION_BREAK_TOKEN.length;
            continue;
        }

        const thinkStart = findConventionalThinkStart(text, index);
        if (thinkStart === index) {
            const thinkEnd = findConventionalThinkEnd(text, index);
            if (thinkEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = thinkEnd;
            paragraphFloor = thinkEnd;
            index = thinkEnd;
            continue;
        }

        index += 1;
    }

    if (blockedByUnclosedExplicitBlock) {
        return stableCutoff;
    }

    const divIslandResult = findBareDivIslandStableCutoff(text, paragraphFloor);
    if (divIslandResult.cutoff > stableCutoff) {
        stableCutoff = divIslandResult.cutoff;
        paragraphFloor = divIslandResult.cutoff;
    }

    if (divIslandResult.blocked) {
        return stableCutoff;
    }

    const paragraphCutoff = findParagraphStableCutoff(text, paragraphFloor);
    return Math.max(stableCutoff, paragraphCutoff);
}

/**
 * 获取或缓存消息的 DOM 引用
 */
function getCachedMessageDom(messageId) {
    let cached = messageDomCache.get(messageId);
    
    if (cached) {
        // 验证缓存是否仍然有效（元素还在 DOM 中）
        if (cached.messageItem.isConnected) {
            return cached;
        }
        // 缓存失效，删除
        messageDomCache.delete(messageId);
    }
    
    // 重新查询并缓存
    const { chatMessagesDiv } = refs;
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    
    if (!messageItem) return null;
    
    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return null;
    
    cached = { messageItem, contentDiv };
    messageDomCache.set(messageId, cached);
    
    return cached;
}

/**
 * Sets up onload and onerror handlers for an emoticon image to fix its URL on error
 * and prevent flickering by controlling its visibility.
 * @param {HTMLImageElement} img The image element.
 */
function setupEmoticonHandlers(img) {
    img.onload = function() {
        this.style.visibility = 'visible';
        this.onload = null;
        this.onerror = null;
    };
    
    img.onerror = function() {
        // If a fix was already attempted, make it visible (as a broken image) and stop.
        if (this.dataset.emoticonFixAttempted === 'true') {
            this.style.visibility = 'visible';
            this.onload = null;
            this.onerror = null;
            return;
        }
        this.dataset.emoticonFixAttempted = 'true';
        
        const fixedSrc = refs.emoticonUrlFixer.fixEmoticonUrl(this.src);
        if (fixedSrc !== this.src) {
            this.src = fixedSrc; // This will re-trigger either onload or onerror
        } else {
            // If the URL can't be fixed, show the broken image and clean up handlers.
            this.style.visibility = 'visible';
            this.onload = null;
            this.onerror = null;
        }
    };
}

function processStreamTailImages(container) {
    if (!refs.emoticonUrlFixer || !container) return;

    const newImages = container.querySelectorAll('img[src*="表情包"]:not([data-emoticon-handler-attached])');

    newImages.forEach(img => {
        img.dataset.emoticonHandlerAttached = 'true';
        img.style.visibility = 'hidden';

        if (img.complete && img.naturalWidth > 0) {
            img.style.visibility = 'visible';
        } else {
            setupEmoticonHandlers(img);
        }
    });
}

/**
 * Renders a single frame of the streaming message using morphdom for efficient DOM updates.
 * This version performs minimal processing to keep it fast and avoid destroying JS state.
 * @param {string} messageId The ID of the message.
 */
function renderStreamFrame(messageId) {
    // 🟢 优先使用缓存
    let isForCurrentView = viewContextCache.get(messageId);
    
    // 如果没有缓存（可能是旧消息），回退到实时检查
    if (isForCurrentView === undefined) {
        const context = messageContextMap.get(messageId);
        isForCurrentView = isMessageForCurrentView(context);
        viewContextCache.set(messageId, isForCurrentView);
    }
    
    if (!isForCurrentView) return;

    // 🟢 使用缓存的 DOM 引用
    const cachedDom = getCachedMessageDom(messageId);
    if (!cachedDom) return;

    const { contentDiv, messageItem } = cachedDom;
    const { stableRoot, stableBlocksRoot, tailRoot } = ensureStreamingRoots(contentDiv);
    const segmentState = getOrCreateStreamSegmentState(messageId);

    const textForRendering = accumulatedStreamText.get(messageId) || "";
    let nextStableCutoff = findExplicitStablePrefix(textForRendering, segmentState.stableCutoff);

    // burst 流式开始后，stable 区只在下一个独立行 brk 到达时继续推进。
    // 否则普通段落 stable 会把“正在打字的当前气泡”提前固化成新的 stable block，
    // 再被原子提升为独立气泡，表现为“所有 stable 都自动分成气泡”。
    if ((segmentState.burstBubbleCount > 0 || contentDiv.classList.contains('burst-streaming'))
        && nextStableCutoff > segmentState.stableCutoff
        && !hasLineOnlyToken(textForRendering.slice(segmentState.stableCutoff, nextStableCutoff), BURST_MARKER_TOKEN)) {
        nextStableCutoff = segmentState.stableCutoff;
    }

    // 移除思考指示器
    const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
    if (streamingIndicator) streamingIndicator.remove();

    if (nextStableCutoff > segmentState.stableCutoff) {
        const stableText = textForRendering.slice(0, nextStableCutoff);
        const newStableText = textForRendering.slice(segmentState.stableRenderedCutoff, nextStableCutoff);
        const hasBurstMarkerInStable = hasLineOnlyToken(stableText, BURST_MARKER_TOKEN);
        const hasBurstMarkerInNewStable = hasLineOnlyToken(newStableText, BURST_MARKER_TOKEN);
        segmentState.stableCutoff = nextStableCutoff;

        appendNewStableRange(stableBlocksRoot, segmentState, textForRendering, nextStableCutoff, {
            messageId,
            settings: refs.globalSettingsRef?.get?.()
        });

        // OpenHerPersona 聊天分条：一旦稳定区出现 brk，立即进入 burst-streaming。
        // 流式路径不再解包已稳定 DOM，也不再对 stableBlocksRoot 做全量 split；
        // 而是按独立行 brk 在源码层切分 stable block，并把每个 stable block 原子提升为气泡。
        // 这样避免 stable -> burst 之间的 live DOM 拆包/重包中间态，降低透明闪烁和复杂后处理节点抖动。
        try {
            let bubbles = [];
            if (hasBurstMarkerInStable || hasBurstMarkerInNewStable) {
                contentDiv.classList.add('burst-streaming');
                if (messageItem) messageItem.dataset.burstRevealed = 'true';
                bubbles = promoteStableBlocksToBurstBubbles(stableBlocksRoot, messageItem);
                ensureBurstTailRow(contentDiv, tailRoot, messageItem);
            }
            if (bubbles.length > 0) {
                bubbles.forEach((bubble, index) => {
                    if (index >= segmentState.burstBubbleCount) {
                        bubble.classList.add('burst-pending');
                        bubble.style.animationDelay = '0ms';
                    }
                });
                segmentState.burstBubbleCount = bubbles.length;
            }
        } catch (error) {
            console.warn('[StreamManager] burst bubble split failed:', error);
        }
    }

    const tailText = textForRendering.slice(segmentState.stableCutoff);
    const rawHtml = parseStreamTail(tailText);

    if (refs.morphdom) {
        try {
            refs.morphdom(tailRoot, `<div>${rawHtml}</div>`, {
                childrenOnly: true,

                getNodeKey: function(node) {
                    if (!node || node.nodeType !== 1) return undefined;
                    return node.id || node.dataset?.vcpKey || node.dataset?.vcpBlockKey || undefined;
                },

                skipFromChildren: function(fromEl, toEl) {
                    return shouldSkipStreamChildren(fromEl, toEl);
                },
                
                onBeforeElUpdated: function(fromEl, toEl) {
                // 跳过相同节点
                if (fromEl.isEqualNode(toEl)) {
                    return false;
                }

                preserveDynamicStreamState(fromEl, toEl);

                // 跳过已完成后处理或需要保留内部状态的复杂块，避免流式尾部 diff 反复重写子树。
                if (shouldPreserveStreamElement(fromEl, toEl)) {
                    return false;
                }
                
                // 🟢 关键修复：保留正在进行的动画类，防止 morphdom 在下一帧将其移除
                // 因为 toEl 是从 marked 重新生成的，不包含这些动态添加的动画类
                if (fromEl.classList.contains('vcp-stream-element-fade-in')) {
                    toEl.classList.add('vcp-stream-element-fade-in');
                }
                if (fromEl.classList.contains('vcp-stream-content-pulse')) {
                    toEl.classList.add('vcp-stream-content-pulse');
                }

                // 🟢 检测块级元素的显著内容增长
                if (STREAM_BLOCK_TAG_REGEX.test(fromEl.tagName)) {
                    const oldLength = elementContentLengthCache.get(fromEl) || fromEl.textContent.length;
                    const newLength = toEl.textContent.length;
                    const lengthDiff = newLength - oldLength;
                    
                    // 如果内容增长超过阈值（比如20个字符），触发微动画
                    if (lengthDiff > 20) {
                        // 使用脉冲动画而不是滑入动画
                        fromEl.classList.add('vcp-stream-content-pulse');
                        setTimeout(() => {
                            fromEl.classList.remove('vcp-stream-content-pulse');
                        }, 300);
                    }
                    
                    // 更新缓存
                    elementContentLengthCache.set(fromEl, newLength);
                }
                
                // 🟢 保留按钮状态
                if (fromEl.tagName === 'BUTTON' && fromEl.dataset.vcpInteractive === 'true') {
                    if (fromEl.disabled) {
                        toEl.disabled = true;
                        toEl.style.opacity = fromEl.style.opacity;
                        toEl.textContent = fromEl.textContent; // 保留"✓"标记
                    }
                }
                
                // 🟢 保留媒体播放状态
                if ((fromEl.tagName === 'VIDEO' || fromEl.tagName === 'AUDIO') && !fromEl.paused) {
                    return false; // 不更新正在播放的媒体
                }
                
                // 🟢 保留输入焦点
                if (fromEl === document.activeElement) {
                    requestAnimationFrame(() => toEl.focus());
                }
                
                // 🟢 简化图片逻辑：只保留状态，不再做 URL 对比
                if (fromEl.tagName === 'IMG') {
                    // 保留加载状态标记
                    if (fromEl.dataset.emoticonHandlerAttached) {
                        toEl.dataset.emoticonHandlerAttached = 'true';
                    }
                    if (fromEl.dataset.emoticonFixAttempted) {
                        toEl.dataset.emoticonFixAttempted = 'true';
                    }
                    
                    // 保留事件处理器
                    if (fromEl.onerror && !toEl.onerror) {
                        toEl.onerror = fromEl.onerror;
                    }
                    if (fromEl.onload && !toEl.onload) {
                        toEl.onload = fromEl.onload;
                    }
                    
                    // 保留可见性状态
                    if (fromEl.style.visibility) {
                        toEl.style.visibility = fromEl.style.visibility;
                    }
                    
                    // 🟢 如果图片已成功加载，不要更新它
                    if (fromEl.complete && fromEl.naturalWidth > 0) {
                        return false;
                    }
                }
                
                return true;
            },
            
            onBeforeNodeDiscarded: function(node) {
                // 防止删除标记为永久保留的元素
                if (node.classList?.contains('keep-alive')) {
                    return false;
                }
                return true;
            },
            
            onNodeAdded: function(node) {
                // 增强：包含更多常见的块级元素，确保列表、表格等都能触发横向渐入
                if (node.nodeType === 1 && STREAM_BLOCK_TAG_REGEX.test(node.tagName)) {
                    // 确保新节点应用横向渐入类
                    node.classList.add('vcp-stream-element-fade-in');
                    
                    // 初始化长度缓存用于后续的脉冲检测
                    elementContentLengthCache.set(node, node.textContent.length);
                    
                    // 动画结束后清理类名，但保留一小段时间确保渲染稳定
                    setTimeout(() => {
                        if (node && node.classList) {
                            node.classList.remove('vcp-stream-element-fade-in');
                        }
                    }, 1000);
                }
                return node;
            }
        });
        } catch (error) {
            // 🟢 捕获不完整 HTML 导致的 morphdom 异常
            // 在流式输出过程中，这是预期内的行为，静默忽略即可
            // 等待下一个 chunk 到达后，内容变得完整，渲染会自动恢复正常
            console.debug('[StreamManager] morphdom skipped frame due to incomplete HTML, waiting for more chunks...');
        }
    } else {
        tailRoot.innerHTML = rawHtml;
    }

    processStreamTailImages(stableRoot);
    processStreamTailImages(tailRoot);
    segmentState.lastTailText = tailText;
}

/**
 * 🟢 节流版本的滚动函数
 */
function throttledScrollToBottom(messageId) {
    if (scrollThrottleTimers.has(messageId)) {
        return; // 节流期间，跳过
    }
    
    refs.uiHelper.scrollToBottom();
    
    const timerId = setTimeout(() => {
        scrollThrottleTimers.delete(messageId);
    }, SCROLL_THROTTLE_MS);
    
    scrollThrottleTimers.set(messageId, timerId);
}

function processAndRenderSmoothChunk(messageId) {
    const queue = streamingChunkQueues.get(messageId);
    let shouldRender = false;

    if (queue && queue.length > 0) {
        const globalSettings = refs.globalSettingsRef.get();
        const minChunkSize = globalSettings.minChunkBufferSize !== undefined && globalSettings.minChunkBufferSize >= 1 ? globalSettings.minChunkBufferSize : 1;
        const queuedChars = queue.reduce((total, chunk) => total + chunk.length, 0);
        const isFinalized = messageIsFinalized(messageId);
        const adaptiveTarget = Math.ceil(queuedChars / (isFinalized ? 8 : 15));
        const drainTarget = Math.max(minChunkSize, adaptiveTarget, isFinalized ? 80 : 0);

        // 自适应排空：队列越深，每帧消费越多；finalize 后加速追平，避免剩余文本瞬移。
        let processedChars = 0;
        while (queue.length > 0 && processedChars < drainTarget) {
            processedChars += queue.shift().length;
        }

        shouldRender = true;
    }

    if (pendingDirectRenderMessages.has(messageId)) {
        pendingDirectRenderMessages.delete(messageId);
        shouldRender = true;
    }

    if (!shouldRender) return;

    // Render the current state of the accumulated text using our lightweight method.
    renderStreamFrame(messageId);
    
    // Scroll if the message is in the current view.
    const context = messageContextMap.get(messageId);
    if (isMessageForCurrentView(context)) {
        throttledScrollToBottom(messageId);
    }
}

function renderChunkDirectlyToDOM(messageId, textToAppend) {
    // 非平滑流式不再每个网络 chunk 立即渲染；只标记为 dirty，由全局 rAF 循环按 TARGET_FPS 合帧。
    pendingDirectRenderMessages.add(messageId);
    if (!streamingTimers.has(messageId)) {
        streamingTimers.set(messageId, true);
        startGlobalRenderLoop();
    }
}

export async function startStreamingMessage(message, passedMessageItem = null) {
    const messageId = message.id;
    
    // 🟢 修复：如果消息已在处理中，且 isThinking 状态没变，直接返回现有状态
    const currentStatus = messageInitializationStatus.get(messageId);
    const cached = getCachedMessageDom(messageId);
    const isCurrentlyThinking = cached?.messageItem?.classList.contains('thinking');

    if ((currentStatus === 'pending' || currentStatus === 'ready') && (isCurrentlyThinking === !!message.isThinking)) {
        console.debug(`[StreamManager] Message ${messageId} already initialized (${currentStatus}) with same thinking state, skipping re-init`);
        return cached?.messageItem || null;
    }

    // Store the context for this message - ensure proper context structure
    const context = {
        agentId: message.agentId || message.context?.agentId || (message.isGroupMessage ? undefined : refs.currentSelectedItemRef.get()?.id),
        groupId: message.groupId || message.context?.groupId || (message.isGroupMessage ? refs.currentSelectedItemRef.get()?.id : undefined),
        topicId: message.topicId || message.context?.topicId || refs.currentTopicIdRef.get(),
        isGroupMessage: message.isGroupMessage || message.context?.isGroupMessage || false,
        agentName: message.name || message.context?.agentName,
        avatarUrl: message.avatarUrl || message.context?.avatarUrl,
        avatarColor: message.avatarColor || message.context?.avatarColor,
    };
    
    // Validate context
    if (!context.topicId || (!context.agentId && !context.groupId)) {
        console.error(`[StreamManager] Invalid context for message ${messageId}`, context);
        return null;
    }
    
    messageContextMap.set(messageId, context);
    
    // 🟢 关键修复：如果消息已经初始化过，不要重新设为 pending，避免阻塞后续 chunk
    if (!currentStatus || currentStatus === 'finalized') {
        messageInitializationStatus.set(messageId, 'pending');
    }
    
    activeStreamingMessageId = messageId;
    
    const { chatMessagesDiv, electronAPI, currentChatHistoryRef, uiHelper } = refs;
    const isForCurrentView = isMessageForCurrentView(context);
    // 🟢 缓存视图检查结果
    viewContextCache.set(messageId, isForCurrentView);
    
    // Get the correct history for this message's context
    let historyForThisMessage;
    // For assistant chat, always use a temporary in-memory history
    if (context.topicId === 'assistant_chat' || context.topicId?.startsWith('voicechat_')) {
        historyForThisMessage = currentChatHistoryRef.get();
    } else if (isForCurrentView) {
        // For current view, use in-memory history
        historyForThisMessage = currentChatHistoryRef.get();
    } else {
        // For background chats, load from disk
        historyForThisMessage = await getHistoryForContext(context);
        if (!historyForThisMessage) {
            console.error(`[StreamManager] Could not load history for background message ${messageId}`, context);
            messageInitializationStatus.set(messageId, 'finalized');
            return null;
        }
    }
    
    // Only manipulate DOM for current view
    let messageItem = null;
    if (isForCurrentView) {
        messageItem = passedMessageItem || chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
        if (!messageItem) {
            const placeholderMessage = { 
                ...message, 
                content: message.content || '思考中...', // Show thinking text initially
                isThinking: true, // Mark as thinking
                timestamp: message.timestamp || Date.now(), 
                isGroupMessage: message.isGroupMessage || false 
            };
            messageItem = refs.renderMessage(placeholderMessage, false);
            if (!messageItem) {
                console.error(`[StreamManager] Failed to render message item for ${message.id}`);
                messageInitializationStatus.set(messageId, 'finalized');
                return null;
            }
        }
        // Add streaming class and remove thinking class when we have a valid messageItem
        if (messageItem && messageItem.classList) {
            messageItem.classList.add('streaming');
            messageItem.classList.remove('thinking');
        }
    }
    
    // Initialize streaming state
    if (shouldEnableSmoothStreaming()) {
        if (!streamingChunkQueues.has(messageId)) {
            streamingChunkQueues.set(messageId, []);
        }
    }
    
    // 🟢 使用更明确的覆盖逻辑
    const existingText = accumulatedStreamText.get(messageId);
    const shouldSkipGroupThinkingSeed = context.isGroupMessage === true && message.isThinking === true;
    const newText = shouldSkipGroupThinkingSeed ? '' : (message.content || '');
    const shouldOverwrite = !existingText
        || existingText === '思考中...'
        || newText.length > existingText.length;
    
    if (shouldOverwrite) {
        accumulatedStreamText.set(messageId, newText);
    }
    
    // Prepare placeholder for history
    const placeholderForHistory = {
        ...message,
        content: shouldSkipGroupThinkingSeed ? '' : (message.content || ''),
        isThinking: false,
        timestamp: message.timestamp || Date.now(),
        isGroupMessage: context.isGroupMessage,
        name: context.agentName,
        agentId: context.agentId
    };
    
    // Update the appropriate history
    const historyIndex = historyForThisMessage.findIndex(m => m.id === message.id);
    if (historyIndex === -1) {
        historyForThisMessage.push(placeholderForHistory);
    } else {
        historyForThisMessage[historyIndex] = { ...historyForThisMessage[historyIndex], ...placeholderForHistory };
    }
    
    // Save the history
    if (isForCurrentView) {
        // Update in-memory reference for current view
        currentChatHistoryRef.set([...historyForThisMessage]);
        window.updateSendButtonState?.();
    }
    
    // 🟢 使用防抖保存
    if (context.topicId !== 'assistant_chat' && !context.topicId.startsWith('voicechat_')) {
        debouncedSaveHistory(context, historyForThisMessage);
    }
    
    // Initialization is complete, message is ready to process chunks.
    // 如果 end/error 事件在异步初始化期间已经到达，不能把状态从 finalized 回退到 ready。
    if (messageInitializationStatus.get(messageId) !== 'finalized') {
        messageInitializationStatus.set(messageId, 'ready');
    }
    
    // Process any chunks that were pre-buffered during initialization.
    const bufferedChunks = preBufferedChunks.get(messageId);
    if (bufferedChunks && bufferedChunks.length > 0 && messageInitializationStatus.get(messageId) === 'ready') {
        console.debug(`[StreamManager] Processing ${bufferedChunks.length} pre-buffered chunks for message ${messageId}`);
        for (const chunkData of bufferedChunks) {
            appendStreamChunk(messageId, chunkData.chunk, chunkData.context);
        }
        preBufferedChunks.delete(messageId);
    }
    
    const deferredFinalization = pendingFinalizationEvents.get(messageId);
    if (deferredFinalization) {
        pendingFinalizationEvents.delete(messageId);
        console.warn(`[StreamManager] Replaying deferred finalization for message ${messageId}.`);
        setTimeout(() => {
            finalizeStreamedMessage(
                messageId,
                deferredFinalization.finishReason,
                deferredFinalization.context,
                deferredFinalization.finalPayload
            );
        }, 0);
    }
    
    if (isForCurrentView) {
        // 如果从思考转为非思考，立即触发一次渲染以清理占位符
        if (!message.isThinking && isCurrentlyThinking) {
            renderStreamFrame(messageId);
        }
        uiHelper.scrollToBottom();
    }
    
    return messageItem;
}

// 🟢 全局渲染循环（替代每个消息一个 interval）
let lastFrameTime = 0;
const TARGET_FPS = 30; // 流式渲染30fps足够
const FRAME_INTERVAL = 1000 / TARGET_FPS;

function startGlobalRenderLoop() {
    if (globalRenderLoopRunning) return;

    globalRenderLoopRunning = true;
    lastFrameTime = 0; // 重置时间戳

    function renderLoop(currentTime) {
        if (streamingTimers.size === 0) {
            globalRenderLoopRunning = false;
            return;
        }

        // 🟢 帧率限制
        if (!currentTime) { // Fallback for browsers that don't pass currentTime
            currentTime = performance.now();
        }
        if (!lastFrameTime) {
            lastFrameTime = currentTime;
        }
        const elapsed = currentTime - lastFrameTime;
        if (elapsed < FRAME_INTERVAL) {
            requestAnimationFrame(renderLoop);
            return;
        }

        lastFrameTime = currentTime - (elapsed % FRAME_INTERVAL); // More accurate timing

        // 处理所有活动的流式消息
        for (const [messageId, _] of streamingTimers) {
            processAndRenderSmoothChunk(messageId);

            const currentQueue = streamingChunkQueues.get(messageId);
            if ((!currentQueue || currentQueue.length === 0) && messageIsFinalized(messageId)) {
                streamingTimers.delete(messageId);

                const storedContext = messageContextMap.get(messageId);
                const isForCurrentView = viewContextCache.get(messageId) ?? isMessageForCurrentView(storedContext);

                if (isForCurrentView) {
                    const finalMessageItem = getCachedMessageDom(messageId)?.messageItem;
                    if (finalMessageItem) finalMessageItem.classList.remove('streaming');
                }

                streamingChunkQueues.delete(messageId);
            }
        }

        requestAnimationFrame(renderLoop);
    }

    requestAnimationFrame(renderLoop);
}

/**
 * 🟢 智能分块策略：按语义单位（词/短语）拆分，而非字符
 */
function intelligentChunkSplit(text) {
    const MIN_SPLIT_SIZE = 20;
    const MAX_CHUNK_SIZE = 10; // 每个语义块最大字符数

    if (text.length < MIN_SPLIT_SIZE) {
        return [text];
    }

    // 使用 matchAll 更快
    const regex = /[\u4e00-\u9fa5]+|[a-zA-Z0-9]+|[^\u4e00-\u9fa5a-zA-Z0-9\s]+|\s+/g;
    const semanticUnits = [...text.matchAll(regex)].map(m => m[0]);

    // 将语义单元合并为合理大小的chunk
    const chunks = [];
    let currentChunk = '';

    for (const unit of semanticUnits) {
        if (currentChunk.length + unit.length > MAX_CHUNK_SIZE) {
            if (currentChunk) { // Avoid pushing empty strings
                chunks.push(currentChunk);
            }
            currentChunk = unit;
        } else {
            currentChunk += unit;
        }
    }

    if (currentChunk) chunks.push(currentChunk);

    return chunks;
}

/**
 * VCPdesktop 流式推送处理器
 * 在token流中拦截 <<<[DESKTOP_PUSH]>>> 语法，实时转发到桌面画布
 *
 * 注意：工具调用结果块 ([[VCP调用结果信息汇总:...VCP调用结果结束]]) 内部的
 * DESKTOP_PUSH 语法不需要在这里保护，因为：
 * 1. 工具调用结果是后端一次性拼接到消息中的，不是AI逐token流式生成的
 * 2. preprocessFullContent 中已经通过 toolResultMap 保护了工具结果块
 * 3. 在逐字符级别做工具结果块检测会与推送标签检测产生字符竞争bug
 */
function processDesktopPushToken(messageId, textToAppend) {
    let state = desktopPushStates.get(messageId);
    if (!state) {
        state = { active: false, widgetId: null, buffer: '', tagBuffer: '', created: false, validated: false, pushTimer: null, lastPushedLength: 0, lastTokenTime: null, backtickContext: false };
        desktopPushStates.set(messageId, state);
    }

    const electronAPI = refs.electronAPI;
    const canPush = desktopWindowAvailable && electronAPI?.desktopPush;

    let remainingText = textToAppend;
    let outputText = '';

    for (let i = 0; i < remainingText.length; i++) {
        const char = remainingText[i];

        if (!state.active) {
            state.tagBuffer += char;

            if (DESKTOP_PUSH_START_TAG.startsWith(state.tagBuffer)) {
                if (state.tagBuffer === DESKTOP_PUSH_START_TAG) {
                    // 🟢 加固：检查开始标签前是否有反引号包裹
                    // 检查 outputText 末尾是否刚输出了一个反引号
                    const precedingChar = outputText.length > 0 ? outputText[outputText.length - 1] : '';
                    if (precedingChar === '`') {
                        // 被反引号包裹，不视为推送标签，直接输出原文
                        state.backtickContext = true;
                        outputText += state.tagBuffer;
                        state.tagBuffer = '';
                        continue;
                    }
                    
                    // 匹配到开始标签，进入active状态但延迟创建挂件
                    state.active = true;
                    state.backtickContext = false;
                    state.widgetId = 'dw-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
                    state.buffer = '';
                    state.created = false;
                    state.validated = false; // 二级验证：等待内容前缀确认
                    state.tagBuffer = '';
                    state.lastPushedLength = 0;
                }
            } else {
                outputText += state.tagBuffer;
                state.tagBuffer = '';
            }
        } else {
            // 在推送块内
            state.tagBuffer += char;

            if (DESKTOP_PUSH_END_TAG.startsWith(state.tagBuffer)) {
                if (state.tagBuffer === DESKTOP_PUSH_END_TAG) {
                    // 结束标签
                    if (state.pushTimer) { clearInterval(state.pushTimer); state.pushTimer = null; }

                    if (canPush && state.created) {
                        if (state.isReplaceMode) {
                            // 替换模式：解析 target/replace 的「始ESCAPE」「末ESCAPE」或旧版「始」「末」
                            const targetMatch = state.buffer.match(/target:(?:「始ESCAPE」([\s\S]*?)「末ESCAPE」|「始」([\s\S]*?)「末」)/);
                            const replaceMatch = state.buffer.match(/replace:(?:「始ESCAPE」([\s\S]*?)「末ESCAPE」|「始」([\s\S]*?)「末」)/);
                            
                            if (targetMatch && replaceMatch) {
                                const targetSelector = (targetMatch[1] || targetMatch[2] || '').trim();
                                const replaceContent = (replaceMatch[1] || replaceMatch[2] || '').trim();
                                electronAPI.desktopPush({
                                    action: 'replace',
                                    targetSelector: targetSelector,
                                    content: replaceContent
                                });
                                console.log(`[DesktopPush] Replace: "${targetSelector}" → ${replaceContent.substring(0, 50)}...`);
                            } else {
                                console.warn(`[DesktopPush] Replace mode but couldn't parse target/replace fields from buffer:`, state.buffer.substring(0, 100));
                            }
                        } else {
                            // 创建模式：最终推送 + finalize
                            electronAPI.desktopPush({ action: 'append', widgetId: state.widgetId, content: state.buffer });
                            electronAPI.desktopPush({ action: 'finalize', widgetId: state.widgetId });
                            console.log(`[DesktopPush] Widget finalized: ${state.widgetId}`);
                        }
                    }

                    state.active = false; state.tagBuffer = ''; state.buffer = '';
                    state.widgetId = null; state.created = false; state.validated = false;
                    state.isReplaceMode = false; state.lastPushedLength = 0;
                }
            } else {
                // 不是结束标签，内容追加到buffer
                state.buffer += state.tagBuffer;
                state.tagBuffer = '';

                // 🟢 性能优化：仅更新时间戳，超时检查由 pushTimer interval 负责
                // 这样每个 token 只需一次赋值操作，避免频繁 clearTimeout/setTimeout
                state.lastTokenTime = Date.now();

                // 二级验证：buffer积累到一定量后检查前缀是否合法
                // 只在前30个有效字符内做验证，避免延迟过大
                if (!state.validated && state.buffer.trim().length >= 5) {
                    const trimmedBuffer = state.buffer.trim().toLowerCase();
                    const isValid = DESKTOP_PUSH_VALID_PREFIXES.some(prefix => trimmedBuffer.startsWith(prefix));
                    
                    if (isValid) {
                        state.validated = true;
                        
                        // 判断是否为替换模式（target:「始」...「末」开头）
                        const isReplaceMode = trimmedBuffer.startsWith('target:');
                        state.isReplaceMode = isReplaceMode;
                        
                        if (isReplaceMode) {
                            console.log(`[DesktopPush] Replace mode detected, waiting for target and replace fields...`);
                            state.created = true; // 标记为已处理，但不创建新挂件
                            // 替换模式不需要定时推送，等到结束标签时一次性解析并替换
                        } else {
                            console.log(`[DesktopPush] Content validated with prefix: ${trimmedBuffer.substring(0, 15)}...`);
                            
                            // 创建模式：验证通过后才创建挂件
                            if (canPush) {
                                electronAPI.desktopPush({
                                    action: 'create', widgetId: state.widgetId,
                                    options: { x: 200, y: 150, width: 400, height: 300 }
                                });
                                state.created = true;
                                
                                // 启动定时推送 + 内置空闲超时检测
                                state.lastTokenTime = Date.now();
                                state.pushTimer = setInterval(() => {
                                    // 推送新内容
                                    if (state.buffer.length > state.lastPushedLength) {
                                        electronAPI.desktopPush({
                                            action: 'append', widgetId: state.widgetId, content: state.buffer
                                        });
                                        state.lastPushedLength = state.buffer.length;
                                    }
                                    
                                    // 🟢 空闲超时检测：如果距离上次token超过150秒，自动finalize
                                    // 不需要单独的setTimeout，复用已有的interval，零额外开销
                                    if (state.lastTokenTime && (Date.now() - state.lastTokenTime > DESKTOP_PUSH_TIMEOUT_MS)) {
                                        console.warn(`[DesktopPush] Widget ${state.widgetId} idle timeout (no new tokens for ${DESKTOP_PUSH_TIMEOUT_MS / 1000}s), auto-finalizing`);
                                        clearInterval(state.pushTimer); state.pushTimer = null;
                                        if (state.created && !state.isReplaceMode && electronAPI?.desktopPush) {
                                            electronAPI.desktopPush({ action: 'append', widgetId: state.widgetId, content: state.buffer });
                                            electronAPI.desktopPush({ action: 'finalize', widgetId: state.widgetId });
                                        }
                                        state.active = false; state.tagBuffer = ''; state.buffer = '';
                                        state.widgetId = null; state.created = false; state.validated = false;
                                        state.isReplaceMode = false; state.lastPushedLength = 0; state.lastTokenTime = null;
                                    }
                                }, DESKTOP_PUSH_THROTTLE_MS);
                            }
                        }

                        // 🟢 替换模式也需要空闲超时保护
                        // 替换模式没有 pushTimer，需要单独的超时机制
                        if (state.isReplaceMode && canPush) {
                            state.lastTokenTime = Date.now();
                            // 替换模式用一个轻量级的检查 interval
                            state.pushTimer = setInterval(() => {
                                if (state.lastTokenTime && (Date.now() - state.lastTokenTime > DESKTOP_PUSH_TIMEOUT_MS)) {
                                    console.warn(`[DesktopPush] Replace mode idle timeout, discarding`);
                                    clearInterval(state.pushTimer); state.pushTimer = null;
                                    state.active = false; state.tagBuffer = ''; state.buffer = '';
                                    state.widgetId = null; state.created = false; state.validated = false;
                                    state.isReplaceMode = false; state.lastPushedLength = 0; state.lastTokenTime = null;
                                }
                            }, 5000); // 替换模式检查频率低一些：5秒一次
                        }
                    } else if (state.buffer.trim().length >= 30) {
                        // 验证失败：30字符内未匹配到合法前缀，丢弃该推送块
                        console.warn(`[DesktopPush] Invalid content prefix, discarding push block: "${trimmedBuffer.substring(0, 30)}..."`);
                        state.active = false; state.tagBuffer = ''; state.buffer = '';
                        state.widgetId = null; state.created = false; state.validated = false; state.lastPushedLength = 0;
                    }
                    // 5-30字符之间继续等待更多内容
                }
            }
        }
    }

    return outputText;
}
/**
 * 清理消息的桌面推送状态
 */
function cleanupDesktopPushState(messageId) {
    const state = desktopPushStates.get(messageId);
    if (state?.pushTimer) {
        clearInterval(state.pushTimer);
        state.pushTimer = null;
    }
    desktopPushStates.delete(messageId);
}

export function appendStreamChunk(messageId, chunkData, context) {
    const initStatus = messageInitializationStatus.get(messageId);
    
    if (!initStatus || initStatus === 'pending') {
        if (!preBufferedChunks.has(messageId)) {
            preBufferedChunks.set(messageId, []);
            // 只在第一次创建缓冲区时打印日志
            console.debug(`[StreamManager] Started pre-buffering for message ${messageId}`);
        }
        const buffer = preBufferedChunks.get(messageId);
        buffer.push({ chunk: chunkData, context });
        
        // 防止缓冲区无限增长 - 如果超过1000个chunks，可能有问题
        if (buffer.length > 1000) {
            console.warn(`[StreamManager] Pre-buffer overflow for ${messageId}, discarding old chunks.`);
            buffer.splice(0, buffer.length - 1000); // 只保留最新1000个
            return;
        }
        return;
    }
    
    if (initStatus === 'finalized') {
        console.warn(`[StreamManager] Received chunk for already finalized message ${messageId}. Ignoring.`);
        return;
    }
    
    // Extract text from chunk
    // 如果检测到 JSON 解析错误，直接过滤掉，不显示给用户
    if (chunkData?.error === 'json_parse_error') {
        console.warn(`[StreamManager] 过滤掉 JSON 解析错误的 chunk for messageId: ${messageId}`, chunkData.raw);
        return;
    }
    
    let textToAppend = "";
    if (chunkData?.choices?.[0]?.delta?.content) {
        textToAppend = chunkData.choices[0].delta.content;
    } else if (chunkData?.delta?.content) {
        textToAppend = chunkData.delta.content;
    } else if (typeof chunkData?.content === 'string') {
        textToAppend = chunkData.content;
    } else if (typeof chunkData === 'string') {
        textToAppend = chunkData;
    } else if (chunkData?.raw && !chunkData?.error) {
        // 只有在没有错误标记时才显示 raw 数据
        textToAppend = chunkData.raw;
    }
    
    if (!textToAppend) return;

    // --- VCPdesktop 流式推送拦截 ---
    // 在累积到 accumulatedStreamText 之前，先过滤桌面推送语法
    // 返回不属于推送块的正常文本（推送块内容被拦截转发到桌面画布）
    const normalText = processDesktopPushToken(messageId, textToAppend);
    
    // Always maintain accumulated text（只累积正常文本，推送块内容不进入聊天气泡）
    // 但开始/结束标签本身会被累积（用于transformSpecialBlocks的转义封印显示占位符）
    let currentAccumulated = accumulatedStreamText.get(messageId) || "";
    currentAccumulated += textToAppend; // 保留完整文本用于最终渲染
    accumulatedStreamText.set(messageId, currentAccumulated);
    
    // Update context if provided
    if (context) {
        const storedContext = messageContextMap.get(messageId);
        if (storedContext) {
            if (context.agentName) storedContext.agentName = context.agentName;
            if (context.agentId) storedContext.agentId = context.agentId;
            messageContextMap.set(messageId, storedContext);
        }
    }
    
    if (shouldEnableSmoothStreaming()) {
        const queue = streamingChunkQueues.get(messageId);
        if (queue) {
            // 🟢 新代码：智能分块
            const semanticChunks = intelligentChunkSplit(textToAppend);
            for (const chunk of semanticChunks) {
                queue.push(chunk);
            }
        } else {
            renderChunkDirectlyToDOM(messageId, textToAppend);
            return;
        }
        
        // 🟢 使用全局循环替代单独的定时器
        if (!streamingTimers.has(messageId)) {
            streamingTimers.set(messageId, true); // 只是标记，不存储实际的 timerId
            startGlobalRenderLoop(); // 启动或确保全局循环正在运行
        }
    } else {
        renderChunkDirectlyToDOM(messageId, textToAppend);
    }
}

export async function finalizeStreamedMessage(messageId, finishReason, context, finalPayload = null) {
    const initStatusAtFinalize = messageInitializationStatus.get(messageId);
    if (!initStatusAtFinalize || initStatusAtFinalize === 'pending') {
        console.warn(`[StreamManager] Finalization arrived before message initialization completed for ${messageId}. Deferring. status=${initStatusAtFinalize || 'missing'}`);
        pendingFinalizationEvents.set(messageId, { finishReason, context, finalPayload });
        return;
    }

    // With the global render loop, we no longer need to manually drain the queue here or clear timers.
    // The loop will continue to process chunks until the queue is empty and the message is finalized, then clean itself up.
    if (activeStreamingMessageId === messageId) {
        activeStreamingMessageId = null;
    }
    
    // 🟢 清理节流定时器
    const scrollTimer = scrollThrottleTimers.get(messageId);
    if (scrollTimer) {
        clearTimeout(scrollTimer);
        scrollThrottleTimers.delete(messageId);
    }
    
    messageInitializationStatus.set(messageId, 'finalized');
    
    // Get the stored context for this message
    const storedContext = messageContextMap.get(messageId) || context;
    if (!storedContext) {
        console.error(`[StreamManager] No context available for message ${messageId}`);
        return;
    }
    
    const { chatMessagesDiv, uiHelper } = refs;
    const isForCurrentView = isMessageForCurrentView(storedContext);
    
    // Get the correct history
    let historyForThisMessage;
    // For assistant chat, always use the in-memory history from the ref
    if (storedContext.topicId === 'assistant_chat' || storedContext.topicId?.startsWith('voicechat_')) {
        historyForThisMessage = refs.currentChatHistoryRef.get();
    } else {
        // For all other chats, always fetch the latest history from the source of truth
        // to avoid race conditions with the UI state (currentChatHistoryRef).
        historyForThisMessage = await getHistoryForContext(storedContext);
        if (!historyForThisMessage) {
            console.error(`[StreamManager] Could not load history for finalization`, storedContext);
            return;
        }
    }
    
    // Find and update the message
    const accumulatedText = accumulatedStreamText.get(messageId) || "";
    const payloadFullResponse = typeof finalPayload?.fullResponse === 'string' ? finalPayload.fullResponse : "";
    const payloadError = typeof finalPayload?.error === 'string' ? finalPayload.error.trim() : "";
    const streamedTextIsUsable = accumulatedText.trim() !== "" && !isThinkingPlaceholderText(accumulatedText);
    const payloadResponseIsUsable = payloadFullResponse.trim() !== "" && !isThinkingPlaceholderText(payloadFullResponse);

    let finalFullText = accumulatedText;
    
    // --- Consistency Logic: Choose the most complete text available ---
    // If the main process payload has more content (as in error recovery) or is explicitly marked as recovery, prefer it.
    if (payloadResponseIsUsable && (payloadFullResponse.length > accumulatedText.length || payloadFullResponse.includes('[!WARNING]'))) {
        finalFullText = payloadFullResponse;
    }

    if (!finalFullText || isThinkingPlaceholderText(finalFullText)) {
        if (payloadError) {
            finalFullText = `[系统错误] ${payloadError}`;
        } else {
            finalFullText = "";
        }
    }
    const messageIndex = historyForThisMessage.findIndex(msg => msg.id === messageId);
    
    if (messageIndex === -1) {
        // If it's an assistant chat and the message is not found,
        // it's likely the window was reset. Ignore gracefully.
        if (storedContext && storedContext.topicId === 'assistant_chat') {
            console.warn(`[StreamManager] Message ${messageId} not found in assistant history, likely due to reset. Ignoring.`);
            // Clean up just in case
            streamingChunkQueues.delete(messageId);
            accumulatedStreamText.delete(messageId);
            return;
        }
        console.error(`[StreamManager] Message ${messageId} not found in history`, storedContext);
        return;
    }
    
    const message = historyForThisMessage[messageIndex];
    message.content = finalFullText;
    message.finishReason = finishReason;
    message.isThinking = false;
    if (message.isGroupMessage && storedContext) {
        message.name = storedContext.agentName || message.name;
        message.agentId = storedContext.agentId || message.agentId;
    }
    
    // Update UI if it's the current view
    if (isForCurrentView) {
        refs.currentChatHistoryRef.set([...historyForThisMessage]);

        const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (messageItem) {
            messageItem.classList.remove('streaming', 'thinking');

            const contentDiv = messageItem.querySelector('.md-content');
            if (contentDiv) {
                contentDiv.querySelectorAll('.vcp-stream-stable-root, .vcp-stream-tail-root').forEach((el) => el.remove());

                const preparedFinal = typeof refs.prepareFinalTextForRender === 'function'
                    ? refs.prepareFinalTextForRender(messageId, finalFullText, message.role || 'assistant', historyForThisMessage)
                    : { text: finalFullText, role: message.role || 'assistant', depth: 0 };
                const rawHtml = parseFullStreamContent(preparedFinal.text, {
                    messageRole: preparedFinal.role,
                    depth: preparedFinal.depth
                });
                
                if (typeof refs.renderPostProcessedHtml === 'function') {
                    await refs.renderPostProcessedHtml(contentDiv, rawHtml, {
                        messageId,
                        message,
                        settings: refs.globalSettingsRef?.get?.(),
                        renderSessionId: null,
                        runHeavy: true,
                        includeAttachments: true
                    });
                } else {
                    // Perform the final, high-quality render using the original global refresh method.
                    // This ensures images, KaTeX, code highlighting, etc., are all processed correctly.
                    refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
                    
                    // Step 1: Run synchronous processors (KaTeX, hljs, etc.)
                    refs.processRenderedContent(contentDiv);

                    if (typeof refs.renderMermaidDiagrams === 'function') {
                        await refs.renderMermaidDiagrams(contentDiv);
                    }

                    // Step 2: Defer TreeWalker-based highlighters to ensure DOM is stable
                    setTimeout(() => {
                        if (contentDiv && contentDiv.isConnected) {
                            refs.runTextHighlights(contentDiv);
                        }
                    }, 0);

                    // Step 3: Process animations, scripts, and 3D scenes
                    if (refs.processAnimationsInContent) {
                        refs.processAnimationsInContent(contentDiv);
                    }
                }
            }
            
            const nameTimeBlock = messageItem.querySelector('.name-time-block');
            if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
                const timestampDiv = document.createElement('div');
                timestampDiv.classList.add('message-timestamp');
                timestampDiv.textContent = formatMessageTimestamp(message.timestamp || Date.now());
                nameTimeBlock.appendChild(timestampDiv);
            }

            uiHelper.scrollToBottom();
        }

        window.updateSendButtonState?.();
    }
    
    // 🟢 使用防抖保存
    if (storedContext.topicId !== 'assistant_chat') {
        debouncedSaveHistory(storedContext, historyForThisMessage);
    }
    
    // Cleanup
        streamingChunkQueues.delete(messageId);
        pendingDirectRenderMessages.delete(messageId);
        accumulatedStreamText.delete(messageId);
        streamSegmentStates.delete(messageId);
        cleanupDesktopPushState(messageId);
        
        // Delayed cleanup
        const existingCleanupTimer = delayedCleanupTimers.get(messageId);
        if (existingCleanupTimer) {
            clearTimeout(existingCleanupTimer);
        }
        const cleanupTimerId = setTimeout(() => {
            messageDomCache.delete(messageId);
            messageInitializationStatus.delete(messageId);
            preBufferedChunks.delete(messageId);
            messageContextMap.delete(messageId);
            viewContextCache.delete(messageId);
            delayedCleanupTimers.delete(messageId);
        }, 5000);
        delayedCleanupTimers.set(messageId, cleanupTimerId);
    }
    
    export function cleanupTransientState() {
        // 清理所有流式消息相关状态
        for (const timerId of scrollThrottleTimers.values()) {
            clearTimeout(timerId);
        }
        scrollThrottleTimers.clear();
    
        for (const state of desktopPushStates.values()) {
            if (state?.pushTimer) {
                clearInterval(state.pushTimer);
            }
        }
        desktopPushStates.clear();
    
        for (const timerId of delayedCleanupTimers.values()) {
            clearTimeout(timerId);
        }
        delayedCleanupTimers.clear();
    
        for (const timerId of historySaveQueue.values()) {
            if (timerId?.timerId) {
                clearTimeout(timerId.timerId);
            }
        }
        historySaveQueue.clear();
    
        streamingChunkQueues.clear();
        streamingTimers.clear();
        pendingDirectRenderMessages.clear();
        accumulatedStreamText.clear();
        streamSegmentStates.clear();
        messageDomCache.clear();
        preBufferedChunks.clear();
        messageInitializationStatus.clear();
        pendingFinalizationEvents.clear();
        messageContextMap.clear();
        viewContextCache.clear();
    
        activeStreamingMessageId = null;
        currentViewSignature = null;
        globalRenderLoopRunning = false;
    
        console.debug('[StreamManager] Transient state cleared');
    }

// Expose to global scope for classic scripts
window.streamManager = {
    initStreamManager,
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage,
    cleanupTransientState,
    getActiveStreamingMessageId: () => activeStreamingMessageId,
    getActiveStreamingContext: () => {
        if (!activeStreamingMessageId) return null;
        return messageContextMap.get(activeStreamingMessageId) || null;
    },
    isMessageInitialized: (messageId) => {
        // Check if message is being tracked by streamManager
        return messageInitializationStatus.has(messageId);
    }
};
