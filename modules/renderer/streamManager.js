// modules/renderer/streamManager.js
import { formatMessageTimestamp } from './domBuilder.js';
import { createContentPipeline, PIPELINE_MODES } from './contentPipeline.js';
import { createContentRuntime } from '../chat/contentRuntime.js';
import { createDesktopPushConsumer } from './desktopPushConsumer.js';
import { createStreamProjectionRuntime } from './streamProjectionRuntime.js';

/** Creates one DOM stream projection owner for one renderer Surface. */
export function createStreamProjection() {
const runtime = createStreamProjectionRuntime();
const {
    messageRuntimeKeys, streamingChunkQueues, streamingTimers, accumulatedStreamText,
    streamSegmentStates, activeStreamingMessages, elementContentLengthCache,
} = runtime;
// Renderer-local active stream facts. This is not durable history.
const streamMessageModels = new Map();
const STREAM_CODE_LINE_SWEEP_DURATION_MS = 2400;
const STREAM_CODE_MAX_ACTIVE_SWEEPS = 3;

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
const THOUGHT_CHAIN_START_LINE_REGEX = /^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*(?:\r?\n|$)/gm;
const THOUGHT_CHAIN_END_LINE_REGEX = /^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm;
const THINK_START_REGEX = /^[ \t]*<think(?:ing)?>[ \t]*(?:\r?\n|$)/gim;
const THINK_END_REGEX = /^[ \t]*<\/think(?:ing)?>[ \t]*(?:\r?\n|$)/gim;
const DAILY_NOTE_START = '<<<DailyNoteStart>>>';
const DAILY_NOTE_END = '<<<DailyNoteEnd>>>';
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
    'vcp-html-preview-container',
    'vcp-flowlock-bubble'
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

    // 已完成且只高亮过一次的流式代码行是稳定子树。
    // 保留 Highlight.js 生成的 span，避免下一帧被流式预览中的纯文本覆盖。
    if (
        fromEl.classList.contains('vcp-stream-code-line') &&
        fromEl.dataset.vcpStreamCodeHighlighted === 'true' &&
        toEl?.dataset?.vcpStreamCodeCompleted === 'true'
    ) {
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

    if (fromEl.dataset.vcpStreamCodeAnimated === 'true') {
        toEl.dataset.vcpStreamCodeAnimated = 'true';
    }

    if (fromEl.dataset.vcpStreamCodeHighlighted === 'true') {
        toEl.dataset.vcpStreamCodeHighlighted = 'true';
    }
}

// --- Surface-owned runtime projections ---
const {
    messageDomCache, scrollThrottleTimers, viewContextCache,
    pendingDirectRenderMessages, preBufferedChunks, messageInitializationStatus,
    messageInitializationWaiters, messageContextMap,
} = runtime;
const SCROLL_THROTTLE_MS = 100; // 100ms 节流
let currentViewSignature = null; // 当前视图的签名
let globalRenderLoopRunning = false;

// --- Local Reference Store ---
let refs = {};
let contentPipeline = null;
let contentRuntime = null;
let transientCleanupRegistered = false;
let transientCleanupWindow = null;
let desktopPushConsumer = null;
let disposed = false;
const pendingAsyncOperations = new Set();
const ownedTimeouts = new Set();
const scheduledAnimationFrames = new Set();

function trackAsyncOperation(operation) {
    const promise = Promise.resolve(operation);
    pendingAsyncOperations.add(promise);
    promise.finally(() => pendingAsyncOperations.delete(promise)).catch(() => {});
    return promise;
}

function scheduleOwnedTimeout(callback, delay = 0) {
    const environment = ownerWindow?.() || globalThis;
    const set = environment.setTimeout?.bind(environment) || setTimeout;
    const clear = environment.clearTimeout?.bind(environment) || clearTimeout;
    const record = { id: null, clear };
    record.id = set(() => {
        ownedTimeouts.delete(record);
        if (!disposed) callback();
    }, delay);
    ownedTimeouts.add(record);
    return record;
}

function clearOwnedTimeout(record) {
    if (!record) return;
    record.clear(record.id);
    ownedTimeouts.delete(record);
}

const ownerDocument = () => refs.document || refs.chatMessagesDiv?.ownerDocument || null;
const ownerWindow = () => refs.window || ownerDocument()?.defaultView || null;

function scheduleAnimationFrame(callback) {
    if (disposed) return null;
    const environment = ownerWindow();
    if (!environment) return null;
    const entry = { handle: null };
    const invoke = timestamp => {
        scheduledAnimationFrames.delete(entry);
        if (!disposed) callback(timestamp);
    };
    if (typeof environment.requestAnimationFrame === 'function') {
        entry.handle = environment.requestAnimationFrame(invoke);
        entry.cancel = () => environment.cancelAnimationFrame?.(entry.handle);
    } else {
        entry.handle = environment.setTimeout(() => invoke(Date.now()), 0);
        entry.cancel = () => environment.clearTimeout?.(entry.handle);
    }
    scheduledAnimationFrames.add(entry);
    return entry.handle;
}

function cancelScheduledAnimationFrames() {
    for (const entry of scheduledAnimationFrames) entry.cancel?.();
    scheduledAnimationFrames.clear();
}

// --- Pre-compiled Regular Expressions for Performance ---

/**
 * Initializes the Stream Manager with necessary dependencies from the main renderer.
 * @param {object} dependencies - An object containing all required functions and references.
 */
function attachStreamProjection(dependencies) {
    if (disposed) throw new Error('StreamProjection is disposed');
    refs = dependencies;
    if (!dependencies?.chatMessagesDiv?.querySelector) {
        throw new TypeError('StreamProjection requires an owning Surface root');
    }
    if (typeof dependencies?.viewAuthority?.isCurrent !== 'function') {
        throw new TypeError('StreamProjection requires an explicit view authority');
    }
    if (!dependencies.transientStreamHistory || typeof dependencies.transientStreamHistory.prepare !== 'function' || typeof dependencies.transientStreamHistory.finalize !== 'function') {
        throw new TypeError('StreamProjection requires an explicit transient history capability');
    }

    // App 级兜底扫帚：页面卸载时释放孤儿流的预缓冲、上下文映射、桌面推送 interval 等 transient 状态。
    // 不挂到 clearChat，避免切换话题时误伤同窗口内其他 agent 的后台流式聊天。
    if (!transientCleanupRegistered) {
        transientCleanupWindow = dependencies.window || dependencies.chatMessagesDiv?.ownerDocument?.defaultView || null;
        if (!transientCleanupWindow) throw new TypeError('StreamProjection requires an owning window capability');
        transientCleanupWindow.addEventListener('beforeunload', dispose);
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
    contentRuntime = typeof createContentRuntime === 'function'
        ? createContentRuntime({ pipeline: contentPipeline })
        : {
            processStream: (text, options = {}) => contentPipeline.process(text, { ...options, mode: PIPELINE_MODES.STREAM_FAST }),
            extractChunkText: (chunk) => {
                if (chunk?.error === 'json_parse_error') return '';
                return chunk?.choices?.[0]?.delta?.content || chunk?.delta?.content || chunk?.content || (typeof chunk === 'string' ? chunk : '') || (chunk?.raw && !chunk?.error ? chunk.raw : '');
            }
        };

    // Assume morphdom is passed in dependencies, warn if not present.
    if (!refs.morphdom) {
        console.warn('[StreamManager] `morphdom` not provided. Streaming rendering will fall back to inefficient innerHTML updates.');
    }

    desktopPushConsumer?.dispose();
    desktopPushConsumer = createDesktopPushConsumer({ electronAPI: refs.electronAPI });
    desktopPushConsumer.start();
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

/**
 * 判断请求是否仍处于等待首块或流式处理中。
 * 该 Map 是跨 Agent/话题异步请求的运行态真源，不能只依赖单一的 activeStreamingMessageId。
 */
function isMessageActive(messageId) {
    const initStatus = messageInitializationStatus.get(messageId);
    return initStatus === 'pending' || initStatus === 'ready';
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
    return refs.viewAuthority.isCurrent(context) === true;
}

/**
 * 批量应用流式渲染所需的轻量级预处理。
 * P0-1 后仅作为 parseTail 缺失时的兜底；正常路径由 messageRenderer 注入的 parseTail 统一处理。
 */
function applyStreamingPreprocessors(text) {
    if (!text) return '';
    if (!contentRuntime) return text;
    return contentRuntime.createRenderModel({ content: text, role: 'assistant' }, { mode: PIPELINE_MODES.STREAM_FAST }).text;
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
        stableRoot = ownerDocument().createElement('div');
        stableRoot.className = 'vcp-stream-stable-root';
        stableBlocksRoot = ownerDocument().createElement('div');
        stableBlocksRoot.className = 'vcp-stream-stable-blocks-root';
        stableRoot.appendChild(stableBlocksRoot);
        tailRoot = ownerDocument().createElement('div');
        tailRoot.className = 'vcp-stream-tail-root';
        contentDiv.appendChild(stableRoot);
        contentDiv.appendChild(tailRoot);
    } else if (!stableBlocksRoot) {
        // 兼容旧的 stableRoot 结构：后续追加式固化只写入 stableBlocksRoot。
        // 如果 stableRoot 已有旧内容，先原样搬入 blocksRoot，避免切换实现时丢失已渲染 DOM。
        stableBlocksRoot = ownerDocument().createElement('div');
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
            lastParagraphBoundary: 0
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

    const blockEl = ownerDocument().createElement('div');
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

    const sourceText = textForRendering.slice(segmentState.stableRenderedCutoff, nextStableCutoff);
    if (!sourceText) return [];

    const renderSourceText = typeof refs.processAssistantScopedHtmlContent === 'function'
        ? refs.processAssistantScopedHtmlContent(
            sourceText,
            options.scopeId || null,
            options.messageItem || null
        )
        : sourceText;
    const html = parseFullStreamContent(renderSourceText);
    const blockRecord = appendStableBlockFragment(stableBlocksRoot, segmentState, sourceText, html, options);
    return blockRecord ? [blockRecord] : [];
}

/**
 * 切换 Agent/话题会重建消息 DOM，但 streamSegmentStates 会继续保留后台流的稳定区状态。
 * 此时不能重新解析稳定源码，也不能把 stableRenderedCutoff 误当作“新 DOM 已经渲染”；
 * 直接从每个 block 缓存的 raw HTML 恢复即可，Markdown/AST 解析次数保持不变。
 */
function restoreStableBlocksForRecreatedDom(stableBlocksRoot, segmentState, options = {}) {
    if (!stableBlocksRoot || segmentState.stableBlocks.length === 0) return false;

    const recordsAreMountedHere = segmentState.stableBlocks.every((record) => {
        return record.element?.isConnected && record.element.parentNode === stableBlocksRoot;
    });
    if (recordsAreMountedHere) return false;

    // 当前 root 属于新视图。先一次性清空，避免历史批量渲染与首个流式帧交错时留下半恢复结构。
    stableBlocksRoot.replaceChildren();

    for (const record of segmentState.stableBlocks) {
    const blockEl = ownerDocument().createElement('div');
        blockEl.className = 'vcp-stream-stable-block';
        blockEl.dataset.vcpStreamStableBlock = 'true';
        blockEl.dataset.vcpBlockKey = record.id;
        blockEl.dataset.vcpStableStart = String(record.start);
        blockEl.dataset.vcpStableEnd = String(record.end);
        stableBlocksRoot.appendChild(blockEl);
        record.element = blockEl;

        if (typeof refs.renderPostProcessedHtml === 'function') {
            const enrichResult = refs.renderPostProcessedHtml(blockEl, record.html, {
                messageId: options.messageId || null,
                settings: options.settings || null,
                renderSessionId: null,
                runHeavy: true,
                includeAttachments: false
            });
            if (enrichResult && typeof enrichResult.catch === 'function') {
                enrichResult.catch(error => console.error('[StreamManager] Restored stable block enrichment failed:', error));
            }
        } else {
            blockEl.innerHTML = record.html;
        }
    }

    return true;
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

function findLineDelimitedBlockEnd(text, startIndex, endRegex) {
    endRegex.lastIndex = startIndex;
    const match = endRegex.exec(text);
    endRegex.lastIndex = 0;
    return match ? match.index + match[0].length : -1;
}

function findLineDelimitedBlockStart(text, startIndex, startRegex) {
    startRegex.lastIndex = startIndex;
    const match = startRegex.exec(text);
    startRegex.lastIndex = 0;
    return match ? match.index : -1;
}

function findConventionalThinkEnd(text, startIndex) {
    return findLineDelimitedBlockEnd(text, startIndex, THINK_END_REGEX);
}

function findConventionalThinkStart(text, startIndex) {
    return findLineDelimitedBlockStart(text, startIndex, THINK_START_REGEX);
}

function findThoughtChainEnd(text, startIndex) {
    return findLineDelimitedBlockEnd(text, startIndex, THOUGHT_CHAIN_END_LINE_REGEX);
}

function findThoughtChainStart(text, startIndex) {
    return findLineDelimitedBlockStart(text, startIndex, THOUGHT_CHAIN_START_LINE_REGEX);
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

function findToolRequestBlockEnd(text, startIndex) {
    const contentStart = startIndex + TOOL_REQUEST_START.length;

    // 与完整渲染共享 ESCAPE 感知扫描器：工具参数中的「始ESCAPE」...「末ESCAPE」
    // 可能包含结束标记文本，不能用简单 indexOf 提前截断请求。
    if (typeof refs.findToolRequestEnd === 'function') {
        return refs.findToolRequestEnd(text, contentStart);
    }

    const endIndex = text.indexOf(TOOL_REQUEST_END, contentStart);
    return endIndex === -1 ? -1 : endIndex + TOOL_REQUEST_END.length;
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
            const requestEnd = findToolRequestBlockEnd(text, index);
            if (requestEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = requestEnd;
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

        const thoughtChainStart = findThoughtChainStart(text, index);
        if (thoughtChainStart === index) {
            const thoughtChainEnd = findThoughtChainEnd(text, index);
            if (thoughtChainEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = thoughtChainEnd;
            paragraphFloor = thoughtChainEnd;
            index = thoughtChainEnd;
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
    const messageItem = refs.chatMessagesDiv?.querySelector?.(`.message-item[data-message-id="${messageId}"]`);
    
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

function highlightCompletedStreamingCodeLine(lineElement) {
    if (!lineElement || lineElement.dataset.vcpStreamCodeHighlighted === 'true') return;
    const syntaxHighlighter = refs.hljs || ownerWindow()?.hljs;
    if (!syntaxHighlighter) return;

    const codeElement = lineElement.closest('code');
    const languageClass = codeElement
        ? Array.from(codeElement.classList).find(className => className.startsWith('language-'))
        : '';
    const language = languageClass ? languageClass.slice('language-'.length) : '';
    const lineText = lineElement.textContent === '\u200b'
        ? ''
        : (lineElement.textContent || '');

    try {
        let highlightedHtml = '';

        if (lineText && language && syntaxHighlighter.getLanguage?.(language)) {
            highlightedHtml = syntaxHighlighter.highlight(lineText, {
                language,
                ignoreIllegals: true
            }).value;
        } else if (lineText) {
            // 没有语言标记时也只在该行完成时自动检测一次，而不是每帧重复检测。
            highlightedHtml = syntaxHighlighter.highlightAuto(lineText).value;
        }

        if (highlightedHtml) {
            lineElement.innerHTML = highlightedHtml;
        }

        lineElement.dataset.vcpStreamCodeHighlighted = 'true';
    } catch (error) {
        // 高亮失败不影响流式显示；仍标记为已尝试，避免每帧重复抛错。
        lineElement.dataset.vcpStreamCodeHighlighted = 'true';
    }
}

function playStreamingCodeLineSweep(lineElement, delayMs = 0) {
    if (!lineElement || typeof lineElement.animate !== 'function') return;
    if (ownerWindow()?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const isLightTheme = ownerDocument()?.body?.classList.contains('light-theme');
    const baseColor = isLightTheme ? '#333333' : '#abb2bf';
    const colorSweep = isLightTheme
        ? `linear-gradient(90deg, transparent 0%, transparent 24%, #0077b6 37%, #6f42c1 46%, #d63384 54%, #b26a00 63%, #238636 70%, transparent 82%, transparent 100%)`
        : `linear-gradient(90deg, transparent 0%, transparent 24%, #61dafb 37%, #c678dd 46%, #ff79c6 54%, #e5c07b 63%, #98c379 70%, transparent 82%, transparent 100%)`;
    const baseLayer = `linear-gradient(${baseColor}, ${baseColor})`;

    // 双层文字背景：彩色层移动，基色层始终铺满文字。
    // 不使用 background-color，避免 Chromium 在嵌套 hljs span 上短暂绘制矩形色块。
    lineElement.style.backgroundImage = `${colorSweep}, ${baseLayer}`;
    lineElement.style.backgroundSize = '210% 100%, 100% 100%';
    lineElement.style.backgroundRepeat = 'no-repeat, no-repeat';
    lineElement.classList.add('vcp-stream-code-line--sweeping');
    lineElement.style.webkitBackgroundClip = 'text';
    lineElement.style.backgroundClip = 'text';
    lineElement.style.webkitTextFillColor = 'transparent';
    lineElement.style.color = 'transparent';

    const animation = lineElement.animate([
        { backgroundPosition: '110% 50%, 0 0' },
        { backgroundPosition: '78% 50%, 0 0', offset: 0.16 },
        { backgroundPosition: '52% 50%, 0 0', offset: 0.36 },
        { backgroundPosition: '18% 50%, 0 0', offset: 0.64 },
        { backgroundPosition: '-12% 50%, 0 0', offset: 0.84 },
        { backgroundPosition: '-45% 50%, 0 0' }
    ], {
        duration: STREAM_CODE_LINE_SWEEP_DURATION_MS,
        delay: delayMs,
        easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
        fill: 'both'
    });

    animation.addEventListener('finish', () => {
        if (!lineElement.isConnected) return;
        lineElement.style.removeProperty('background-image');
        lineElement.style.removeProperty('background-size');
        lineElement.style.removeProperty('background-repeat');
        lineElement.style.removeProperty('-webkit-background-clip');
        lineElement.style.removeProperty('background-clip');
        lineElement.style.removeProperty('-webkit-text-fill-color');
        lineElement.style.removeProperty('color');
        lineElement.classList.remove('vcp-stream-code-line--sweeping');
    }, { once: true });
}

/**
 * 只处理刚由“输入中”变为“已完成”的稳定行节点。
 * 行 DOM 已由 parseStreamTailMarkdown 生成并由 morphdom 按 key 复用，这里不再重建 DOM 或运行 hljs。
 */
function decorateStreamingCodeLines(container) {
    if (!container) return;

    const newCompletedLines = Array.from(container.querySelectorAll(
        '.vcp-stream-code-line[data-vcp-stream-code-completed="true"]:not([data-vcp-stream-code-animated="true"])'
    ));

    if (newCompletedLines.length === 0) return;

    // 每条新完成行只执行一次语法高亮，并保留其高亮子树。
    // 所有行立即标记为已处理；突发大块只动画最新几行，避免同时创建大量长动画。
    newCompletedLines.forEach(lineElement => {
        highlightCompletedStreamingCodeLine(lineElement);
        lineElement.dataset.vcpStreamCodeAnimated = 'true';
    });

    const linesToAnimate = newCompletedLines.slice(-STREAM_CODE_MAX_ACTIVE_SWEEPS);

    // 输出速度很快时，结束更旧的扫光并立即露出其语法色，避免动画队列落后于代码。
    const activeSweeps = Array.from(container.querySelectorAll('.vcp-stream-code-line--sweeping'));
    const excessActiveCount = Math.max(
        0,
        activeSweeps.length + linesToAnimate.length - STREAM_CODE_MAX_ACTIVE_SWEEPS
    );
    activeSweeps.slice(0, excessActiveCount).forEach(lineElement => {
        lineElement.getAnimations().forEach(animation => animation.finish());
    });

    // 不再逐行延迟；所有本帧新完成行立即开始，最多并发三条。
    linesToAnimate.forEach(lineElement => {
        playStreamingCodeLineSweep(lineElement, 0);
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
    const streamRenderOptions = {
        messageId,
        settings: refs.globalSettingsRef?.get?.(),
        scopeId: messageItem.id || null,
        messageItem
    };

    // 切回仍在流式输出的会话时，消息 DOM 已重建而稳定区状态仍在。
    // 在计算/追加新稳定范围前恢复旧 blocks，避免只看得到新的 tail。
    restoreStableBlocksForRecreatedDom(stableBlocksRoot, segmentState, streamRenderOptions);

    const textForRendering = accumulatedStreamText.get(messageId) || "";
    const nextStableCutoff = findExplicitStablePrefix(textForRendering, segmentState.stableCutoff);

    // 移除思考指示器
    const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
    if (streamingIndicator) streamingIndicator.remove();

    if (nextStableCutoff > segmentState.stableCutoff) {
        segmentState.stableCutoff = nextStableCutoff;
        appendNewStableRange(
            stableBlocksRoot,
            segmentState,
            textForRendering,
            nextStableCutoff,
            streamRenderOptions
        );
    }

    const tailText = textForRendering.slice(segmentState.stableCutoff);
    const renderTailText = typeof refs.processAssistantScopedHtmlContent === 'function'
        ? refs.processAssistantScopedHtmlContent(
            tailText,
            streamRenderOptions.scopeId,
            streamRenderOptions.messageItem
        )
        : tailText;
    const rawHtml = parseStreamTail(renderTailText);

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
                        scheduleOwnedTimeout(() => {
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
                if (fromEl === ownerDocument()?.activeElement) {
                    scheduleAnimationFrame(() => toEl.focus());
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
                    scheduleOwnedTimeout(() => {
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
    decorateStreamingCodeLines(tailRoot);
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
    
    const timerId = scheduleOwnedTimeout(() => {
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

function conversationIdentityMatches(context, identity = {}) {
    if (!context || !identity) return false;
    const itemType = context.isGroupMessage ? 'group' : 'agent';
    const itemId = context.isGroupMessage ? context.groupId : context.agentId;
    return itemType === identity.itemType
        && itemId === identity.itemId
        && context.topicId === identity.topicId;
}

async function startStreamingMessage(message, passedMessageItem = null) {
    if (disposed) return null;
    const messageId = message.id;
    const streamOperationId = message.streamOperationId || message.context?.streamOperationId || null;
    const previousRuntimeKey = messageRuntimeKeys.get(String(messageId));
    const nextRuntimeKey = streamOperationId ? `${streamOperationId}::${messageId}` : String(messageId);
    if (previousRuntimeKey && previousRuntimeKey !== nextRuntimeKey) {
        // Keep the old key active while discardStreamingMessage clears every
        // operation-owned map; only then publish the retry's new owner key.
        discardStreamingMessage(messageId);
    }
    messageRuntimeKeys.set(String(messageId), nextRuntimeKey);
    
    // 🟢 修复：如果消息已在处理中，且 isThinking 状态没变，直接返回现有状态
    const currentStatus = messageInitializationStatus.get(messageId);
    const cached = getCachedMessageDom(messageId);
    const isCurrentlyThinking = cached?.messageItem?.classList.contains('thinking');

    if ((currentStatus === 'pending' || currentStatus === 'ready') && cached
        && (isCurrentlyThinking === !!message.isThinking)) {
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
        streamOperationId,
    };
    
    // Validate context
    if (!context.topicId || (!context.agentId && !context.groupId)) {
        console.error(`[StreamManager] Invalid context for message ${messageId}`, context);
        return null;
    }
    
    messageContextMap.set(messageId, context);
    streamMessageModels.set(messageId, {
        ...message,
        id: messageId,
        agentId: context.agentId,
        groupId: context.groupId,
        topicId: context.topicId,
        isGroupMessage: context.isGroupMessage,
        streamOperationId,
    });
    
    // 🟢 关键修复：如果消息已经初始化过，不要重新设为 pending，避免阻塞后续 chunk
    if (!currentStatus || currentStatus === 'finalized') {
        messageInitializationStatus.set(messageId, 'pending');
    }
    
    activeStreamingMessages.set(messageId, context);
    
    const { chatMessagesDiv, electronAPI, uiHelper } = refs;
    const isForCurrentView = isMessageForCurrentView(context);
    const shouldProjectToDom = isForCurrentView;
    // 🟢 缓存视图检查结果
    viewContextCache.set(messageId, shouldProjectToDom);
    
    try {
        await refs.transientStreamHistory.prepare(message, context, { visible: isForCurrentView });
    } catch (error) {
        console.error(`[StreamManager] Could not prepare transient history for ${messageId}`, context, error);
        discardStreamingMessage(messageId);
        return null;
    }
    
    // Only manipulate DOM for current view
    let messageItem = null;
    if (shouldProjectToDom) {
        messageItem = passedMessageItem || chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
        if (!messageItem) {
            const placeholderMessage = { 
                ...message, 
                content: message.content || '思考中...', // Show thinking text initially
                isThinking: true, // Mark as thinking
                timestamp: message.timestamp || Date.now(), 
                isGroupMessage: message.isGroupMessage || false 
            };
            messageItem = refs.chatDomRenderer
                ? await refs.chatDomRenderer.renderMessage(placeholderMessage, false)
                : refs.renderMessage(placeholderMessage, false);
            if (!messageItem) {
                console.error(`[StreamManager] Failed to render message item for ${message.id}`);
                discardStreamingMessage(messageId);
                return null;
            }
        }
        // Add streaming class and remove thinking class when we have a valid messageItem
        if (messageItem && messageItem.classList) {
            messageItem.classList.add('streaming');
            messageItem.classList.remove('thinking');
            const contentDiv = messageItem.querySelector('.md-content');
            if (contentDiv) messageDomCache.set(messageId, { messageItem, contentDiv });
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
            appendStreamChunk(messageId, chunkData.chunk, chunkData.context, chunkData.streamOperationId);
        }
        preBufferedChunks.delete(messageId);
    }
    
    const initializationWaiters = messageInitializationWaiters.get(messageId) || [];
    messageInitializationWaiters.delete(messageId);
    initializationWaiters.forEach(resolve => resolve(true));
    
    if (shouldProjectToDom) {
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
            scheduleAnimationFrame(renderLoop);
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

        scheduleAnimationFrame(renderLoop);
    }

    scheduleAnimationFrame(renderLoop);
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
    return desktopPushConsumer?.processToken(messageId, textToAppend) ?? textToAppend;
}

/** Releases the Desktop canvas state owned by one stream message. */
function cleanupDesktopPushState(messageId) {
    desktopPushConsumer?.cleanupMessage(messageId);
}

function appendStreamChunk(messageId, chunkData, context, streamOperationId = null) {
    if (disposed) return false;
    const initStatus = messageInitializationStatus.get(messageId);
    
    if (!initStatus || initStatus === 'pending') {
        if (!preBufferedChunks.has(messageId)) {
            preBufferedChunks.set(messageId, []);
            // 只在第一次创建缓冲区时打印日志
            console.debug(`[StreamManager] Started pre-buffering for message ${messageId}`);
        }
        const buffer = preBufferedChunks.get(messageId);
        buffer.push({ chunk: chunkData, context, streamOperationId });
        
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
    
    const activeContext = messageContextMap.get(messageId);
    if (streamOperationId && activeContext?.streamOperationId && activeContext.streamOperationId !== streamOperationId) return false;
    // Extract text from chunk
    // 如果检测到 JSON 解析错误，直接过滤掉，不显示给用户
    if (chunkData?.error === 'json_parse_error') {
        console.warn(`[StreamManager] 过滤掉 JSON 解析错误的 chunk for messageId: ${messageId}`, chunkData.raw);
        return;
    }
    
    const textToAppend = contentRuntime
        ? contentRuntime.extractChunkText(chunkData)
        : '';
    
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

/**
 * Applies the terminal message model and DOM projection without writing durable history.
 * The StreamCoordinator owns the production commit point.
 */
async function projectStreamTerminal(messageId, finishReason, context, finalPayload = null) {
    if (disposed) return null;
    const expectedOperationId = finalPayload?.streamOperationId || context?.streamOperationId || null;
    const activeContext = messageContextMap.get(messageId);
    if (expectedOperationId && activeContext?.streamOperationId && activeContext.streamOperationId !== expectedOperationId) return null;
    let initStatusAtFinalize = messageInitializationStatus.get(messageId);
    if (initStatusAtFinalize === 'pending') {
        console.warn(`[StreamManager] Finalization is waiting for message initialization: ${messageId}`);
        const initialized = await new Promise(resolve => {
            const waiters = messageInitializationWaiters.get(messageId) || [];
            waiters.push(resolve);
            messageInitializationWaiters.set(messageId, waiters);
        });
        if (!initialized) return null;
        initStatusAtFinalize = messageInitializationStatus.get(messageId);
    }
    if (!initStatusAtFinalize) {
        console.warn(`[StreamManager] Finalization ignored because message initialization is absent: ${messageId}`);
        discardStreamingMessage(messageId);
        return null;
    }

    // With the global render loop, we no longer need to manually drain the queue here or clear timers.
    // The loop will continue to process chunks until the queue is empty and the message is finalized, then clean itself up.
    activeStreamingMessages.delete(messageId);
    
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
        discardStreamingMessage(messageId);
        return;
    }
    
    const { chatMessagesDiv, uiHelper } = refs;
    const isForCurrentView = isMessageForCurrentView(storedContext);
    const shouldProjectToDom = isForCurrentView;
    
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
    let transientModel;
    try {
        transientModel = await refs.transientStreamHistory.finalize({
            messageId,
            context: storedContext,
            content: finalFullText,
            finishReason,
            visible: isForCurrentView,
        });
    } catch (error) {
        console.error(`[StreamManager] Could not finalize transient history for ${messageId}`, storedContext, error);
        discardStreamingMessage(messageId);
        return null;
    }
    if (!transientModel) {
        // If it's an assistant chat and the message is not found,
        // it's likely the window was reset. Ignore gracefully.
        if (storedContext && storedContext.topicId === 'assistant_chat') {
            console.warn(`[StreamManager] Message ${messageId} not found in assistant history, likely due to reset. Ignoring.`);
            discardStreamingMessage(messageId);
            return;
        }
        console.error(`[StreamManager] Message ${messageId} not found in history`, storedContext);
        discardStreamingMessage(messageId);
        return;
    }
    
    const { message, history: historyForThisMessage } = transientModel;
    
    // Update UI if it's the current view
    if (shouldProjectToDom) {
        const messageItem = messageDomCache.get(messageId)?.messageItem
            || chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
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
                    scheduleOwnedTimeout(() => {
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
                const timestampDiv = ownerDocument().createElement('div');
                timestampDiv.classList.add('message-timestamp');
                timestampDiv.textContent = formatMessageTimestamp(message.timestamp || Date.now());
                nameTimeBlock.appendChild(timestampDiv);
            }

            uiHelper.scrollToBottom();
        }

    }
    
    // Cleanup
    streamingChunkQueues.delete(messageId);
    pendingDirectRenderMessages.delete(messageId);
    accumulatedStreamText.delete(messageId);
    streamSegmentStates.delete(messageId);
    refs.transientStreamHistory.discard?.(messageId);
    cleanupDesktopPushState(messageId);

    // Terminal means ownership has ended; no delayed cache lease survives `done`.
    messageDomCache.delete(messageId);
    messageInitializationStatus.delete(messageId);
    preBufferedChunks.delete(messageId);
    messageContextMap.delete(messageId);
    viewContextCache.delete(messageId);
    messageRuntimeKeys.delete(String(messageId));
    streamMessageModels.delete(messageId);

    // 调用方（例如 Flowlock）需要基于真正落盘的完整文本解析最终控制协议。
    return {
        messageId,
        context: storedContext,
        content: finalFullText,
        finishReason,
        history: historyForThisMessage,
    };
}

function discardStreamingMessage(messageId) {
    if (disposed) return false;
    const scrollTimer = scrollThrottleTimers.get(messageId);
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollThrottleTimers.delete(messageId);
    streamingChunkQueues.delete(messageId);
    streamingTimers.delete(messageId);
    pendingDirectRenderMessages.delete(messageId);
    accumulatedStreamText.delete(messageId);
    streamSegmentStates.delete(messageId);
    messageDomCache.delete(messageId);
    preBufferedChunks.delete(messageId);
    messageInitializationStatus.delete(messageId);
    const initializationWaiters = messageInitializationWaiters.get(messageId) || [];
    messageInitializationWaiters.delete(messageId);
    initializationWaiters.forEach(resolve => resolve(false));
    refs.transientStreamHistory.discard?.(messageId);
    messageContextMap.delete(messageId);
    viewContextCache.delete(messageId);
    cleanupDesktopPushState(messageId);
    activeStreamingMessages.delete(messageId);
    messageRuntimeKeys.delete(String(messageId));
}

async function dispose() {
        if (disposed) return;
        disposed = true;
        if (transientCleanupRegistered) {
            transientCleanupWindow?.removeEventListener('beforeunload', dispose);
            transientCleanupRegistered = false;
            transientCleanupWindow = null;
        }
        cancelScheduledAnimationFrames();
        // 清理所有流式消息相关状态
        for (const timerId of scrollThrottleTimers.values()) {
            clearOwnedTimeout(timerId);
        }
        scrollThrottleTimers.clear();
        for (const timeout of ownedTimeouts) clearOwnedTimeout(timeout);
        cancelScheduledAnimationFrames();
    
        desktopPushConsumer?.dispose();
        desktopPushConsumer = null;
    
    
        streamingChunkQueues.clear();
        streamingTimers.clear();
        pendingDirectRenderMessages.clear();
        accumulatedStreamText.clear();
        streamSegmentStates.clear();
        messageDomCache.clear();
        preBufferedChunks.clear();
        messageInitializationStatus.clear();
        for (const waiters of messageInitializationWaiters.values()) waiters.forEach(resolve => resolve(false));
        messageInitializationWaiters.clear();
        refs.transientStreamHistory.dispose?.();
        messageContextMap.clear();
        viewContextCache.clear();
        streamMessageModels.clear();
    
        activeStreamingMessages.clear();
        messageRuntimeKeys.clear();
        currentViewSignature = null;
        globalRenderLoopRunning = false;
        await Promise.allSettled([...pendingAsyncOperations]);
    
        console.debug('[StreamManager] Transient state cleared');
    }

function getActiveStreamingMessageId() {
    const active = [...activeStreamingMessages.entries()];
    for (let index = active.length - 1; index >= 0; index -= 1) {
        const [messageId, context] = active[index];
        if (isMessageForCurrentView(context)) return messageId;
    }
    return null;
}

function getActiveStreamingContext() {
    const messageId = getActiveStreamingMessageId();
    return messageId ? activeStreamingMessages.get(messageId) || null : null;
}

function snapshotConversation(identity) {
    if (disposed) return Object.freeze([]);
    const snapshots = [];
    for (const [messageId, context] of activeStreamingMessages.entries()) {
        if (!conversationIdentityMatches(context, identity)) continue;
        snapshots.push(Object.freeze({
            conversation: Object.freeze({
                itemType: context.isGroupMessage ? 'group' : 'agent',
                itemId: context.isGroupMessage ? context.groupId : context.agentId,
                topicId: context.topicId,
            }),
            message: Object.freeze({ ...(streamMessageModels.get(messageId) || { id: messageId }) }),
            messageId,
            streamOperationId: context.streamOperationId || null,
            context: Object.freeze({ ...context }),
            phase: messageInitializationStatus.get(messageId) || 'active',
            accumulatedText: accumulatedStreamText.get(messageId) || '',
        }));
    }
    return Object.freeze(snapshots);
}

async function reconcileConversation(identity) {
    if (disposed) return Object.freeze([]);
    const snapshots = snapshotConversation(identity);
    for (const snapshot of snapshots) {
        const context = messageContextMap.get(snapshot.messageId) || snapshot.context;
        viewContextCache.set(snapshot.messageId, isMessageForCurrentView(context));
        await startStreamingMessage({ ...snapshot.message, ...context, content: snapshot.message.content || '' });
        if (isMessageForCurrentView(context)) {
            renderStreamFrame(snapshot.messageId);
        }
    }
    return snapshots;
}

function getStreamDiagnostics() {
    const activeMessageId = getActiveStreamingMessageId();
    return Object.freeze({
        activeMessageId,
        activeMessageIds: Object.freeze(activeStreamingMessages.displayKeys()),
        initialization: messageInitializationStatus.size,
        activeInitializations: [...messageInitializationStatus.values()]
            .filter(status => status === 'pending' || status === 'ready').length,
        contexts: messageContextMap.size,
        pendingHistory: refs.transientStreamHistory?.pendingCount || 0,
        prebuffered: preBufferedChunks.size,
        pendingFinalizations: messageInitializationWaiters.size,
        chunkQueues: streamingChunkQueues.size,
        renderTimers: streamingTimers.size,
        delayedCleanupTimers: ownedTimeouts.size + scheduledAnimationFrames.size,
        desktopPushStates: desktopPushConsumer?.getStateCount() || 0,
    });
}

return Object.freeze({
    attachStreamProjection,
    dispose,
    startStreamingMessage: (...args) => trackAsyncOperation(startStreamingMessage(...args)),
    appendStreamChunk,
    projectStreamTerminal: (...args) => trackAsyncOperation(projectStreamTerminal(...args)),
    discardStreamingMessage,
    getDiagnostics: getStreamDiagnostics,
    isMessageActive,
    getActiveStreamingMessageId,
    getActiveStreamingContext,
    snapshotConversation,
    reconcileConversation: (...args) => trackAsyncOperation(reconcileConversation(...args)),
    isMessageInitialized: (messageId) => {
        // Check if message is being tracked by streamManager
        return messageInitializationStatus.has(messageId);
    }
});
}
