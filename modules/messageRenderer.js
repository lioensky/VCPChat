import { createOffscreenDomWindow } from './renderer/offscreenDomWindow.js';
import { createRenderWorkerClient } from './renderer/renderWorkerClient.js';
import { createRenderTemplateCompiler } from './renderer/renderTemplateCompiler.js';
import { tokenizeVcpDocument } from './renderer/vcpDocumentScanner.js';
import { sanitizeToolDataHtml } from './renderer/toolDataHtml.js';
import { stripToolBatches, collectToolBatchRanges } from './renderer/toolBatchRegions.js';
import { splitToolBatchDomains, transformToolBatchText, composeToolBatchHtml } from './renderer/toolBatchDomains.js';
import { isContextCheckpoint } from './chat/contextCompactionState.js';
import { createProjectForgeTopicSurface } from './renderer/projectForgeTopicSurface.js';
import { avatarColorCache, getDominantAvatarColor } from './renderer/colorUtils.js';
import { createImageHandler } from './renderer/imageHandler.js';
import { prepareChatMediaHtml, cleanupChatMedia } from './renderer/mediaLifecycle.js';
import { processAnimationsInContent as processOwnedAnimations, cleanupAnimationsInContent as cleanupOwnedAnimations } from './renderer/animation.js';
import { createVisibilityOptimizer } from './renderer/visibilityOptimizer.js';

import { createMessageSkeleton, formatMessageTimestamp } from './renderer/domBuilder.js';
import { createEmoticonUrlFixer } from './renderer/emoticonUrlFixer.js';
import { createContentPipeline, PIPELINE_MODES } from './renderer/contentPipeline.js';
import { createContentRuntime } from './chat/contentRuntime.js';
import { createMermaidPlaceholderTransform } from './chat/contentTransforms.js';
import { transformChartReferences } from './chat/chartEmbedTransform.js';
import { createChartEmbedHost } from './renderer/chartEmbedHost.js';
import { createChatDomRenderer } from './chat/chatDomRenderer.js';
import { createRenderDependencies } from './renderer/renderDependencies.js';
import { createRenderSessionAuthority } from './renderer/renderSessionAuthority.js';
import { createSurfaceTaskOwner } from './renderer/surfaceTaskOwner.js';
import {
    findEarliestUnclosedToolBlock,
    findToolRequestEnd,
    replaceToolRequestBlocks,
    readToolRequestField
} from './renderer/toolRequestScanner.js';
import { replaceMarkdownCodeDomains } from './renderer/markdownCodeDomainScanner.js';
import {
    collectToolResultRanges,
    collectClosedToolResultRanges,
    isToolResultHidden,
    setToolResultHidden,
} from './renderer/toolResultRegions.js';
import { createToolPresentation } from './renderer/toolPresentation.js';
import { parseJevToolUse } from './renderer/jevToolUse.js';
import {
    findMalformedToolFields,
    describeToolRequestMarkerProblem
} from './renderer/toolRequestMarkers.js';

import { createContentProcessor } from './renderer/contentProcessor.js';
import { createMessageContextMenu } from './renderer/messageContextMenu.js';


import { createMiddleClickHandler } from './renderer/middleClickHandler.js';

// modules/messageRenderer.js

export function createMessageRenderer(options = {}) {
const surfaceId = String(options.surfaceId || `surface-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
const features = Object.freeze({
    contextMenu: options.enableContextMenu !== false,
    middleClick: options.enableMiddleClick !== false,
    streamProjection: options.initializeStreamProjection !== false,
    globalCommands: options.exposeGlobalCommands !== false,
});
const visibilityOptimizer = options.visibilityOptimizer || createVisibilityOptimizer();

const streamManager = options.streamManager;
if (!streamManager) throw new TypeError('MessageRenderer requires an owned StreamProjection');
const emoticonUrlFixer = options.emoticonUrlFixer || createEmoticonUrlFixer();
const contentProcessor = options.contentProcessor || createContentProcessor();
const contextMenu = options.contextMenu || createMessageContextMenu();
const middleClickHandler = options.middleClickHandler || createMiddleClickHandler();
const imageHandler = options.imageHandler || createImageHandler({ fixUrl: emoticonUrlFixer.fixEmoticonUrl });
const colorExtractionPromises = new Map();
const ownedStyleElements = new Set();
const persistedAvatarColorKeys = new Set();
const scopedCssCache = new Map();
const ownedAnimationContents = new Set();
function processAnimationsInContent(content, optimizer) {
    if (rendererDisposed) return;
    const controller = processOwnedAnimations(content, optimizer);
    if (controller && !ownedAnimationContents.has(content)) {
        ownedAnimationContents.add(content);
        controller.own(() => ownedAnimationContents.delete(content));
    }
    return controller;
}
function cleanupAnimationsInContent(content) {
    ownedAnimationContents.delete(content);
    cleanupOwnedAnimations(content);
}

function scopeCssCached(source, scopeId) {
    let cache = scopedCssCache.get(scopeId);
    if (!cache) scopedCssCache.set(scopeId, cache = new Map());
    if (cache.has(source)) return cache.get(source);
    const css = contentProcessor.scopeCss(source, scopeId);
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(source, css);
    return css;
}
const projectForgeTopicSurface = createProjectForgeTopicSurface();

async function getDominantAvatarColorCached(url) {
    if (!colorExtractionPromises.has(url)) {
        colorExtractionPromises.set(url, getDominantAvatarColor(url));
    }
    return colorExtractionPromises.get(url);
}

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls

// 🟢 大内容截断阈值与缓存
const TOOL_RESULT_TRUNCATE_THRESHOLD = 50000; // 50KB 以上触发截断
const TOOL_RESULT_TRUNCATE_LINES = 80; // 截断后只显示前80行
const toolResultFullContentMap = new Map(); // placeholderId -> { raw: string, fieldKey: string }
let toolResultContentIdCounter = 0;
const lazyToolContents = new Map();
let lazyToolSequence = 0;
// Only the synchronous template build owns this collector. Cached descriptors never
// contain DOM, owner callbacks or runtime IDs; each projection gets fresh bindings.
let lazyToolTemplate = null;

function registerLazyTool(entry) {
    if (lazyToolTemplate) {
        const id = `template-${lazyToolTemplate.length}-${hashStringFNV1a(entry.raw)}`;
        lazyToolTemplate.push({ id, ...entry });
        return id;
    }
    const id = `${surfaceId}-${++lazyToolSequence}`;
    lazyToolContents.set(id, entry);
    return id;
}

function buildRenderTemplate(text, options) {
    const previous = lazyToolTemplate;
    const tools = [];
    lazyToolTemplate = tools;
    try {
        return { html: renderMarkdownToHtmlUncached(text, options), tools };
    } finally {
        lazyToolTemplate = previous;
    }
}

function hydrateRenderTemplate(template) {
    // Allocate only IDs present in the final HTML (a malformed Markdown domain may
    // have swallowed a placeholder). Never register data for an unmounted token.
    const tools = new Map(template.tools.map(entry => [entry.id, entry]));
    const ids = new Map();
    return template.html.replace(/data-vcp-lazy-tool-id="([^"]+)"/g, (attribute, id) => {
        const entry = tools.get(id);
        if (!entry) return attribute;
        if (!ids.has(id)) ids.set(id, registerLazyTool(entry));
        return `data-vcp-lazy-tool-id="${ids.get(id)}"`;
    });
}

const deferToolRequest = (...args) => templateCompiler.deferToolRequest(...args);

function bindLazyTools(root) {
    root?.querySelectorAll?.('[data-vcp-lazy-tool-id]').forEach(block => {
        const entry = lazyToolContents.get(block.dataset.vcpLazyToolId);
        if (!entry) return;
        block._vcpLazyMeta = entry.meta;
        block._vcpMountTool = expanded => mountLazyTool(block, expanded);
    });
}

function mountLazyTool(block, expanded) {
    const entry = lazyToolContents.get(block.dataset.vcpLazyToolId);
    const body = block.querySelector(':scope > .vcp-tool-details, :scope > .vcp-tool-result-collapsible-content');
    if (!entry || !body) return;
    if (!expanded) {
        imageHandler.cleanupContent?.(body);
        cleanupToolResultFullContentForRoot(body);
        cleanupChatMedia(body);
        contentProcessor.cleanupPreviewsInContent(body);
        body.replaceChildren();
        delete body.dataset.vcpLazyMounted;
        return;
    }
    if (body.dataset.vcpLazyMounted === 'true') return;
    if (entry.type === 'request') {
        const pre = body.ownerDocument.createElement('pre');
        pre.textContent = entry.raw;
        body.appendChild(pre);
    } else {
        const template = body.ownerDocument.createElement('template');
        template.innerHTML = renderToolResultBlock(entry.raw, entry.ordinal, false);
        const rendered = template.content.querySelector('.vcp-tool-result-collapsible-content');
        imageHandler.setContentAndProcessImages(body, rendered?.innerHTML || '', block.closest('.message-item')?.dataset.messageId);
        contentProcessor.processRenderedContent(body, mainRendererReferences.globalSettingsRef.get());
    }
    body.dataset.vcpLazyMounted = 'true';
}

function releaseLazyTools(root, incomingHtml = '') {
    const keep = new Set();
    for (const match of incomingHtml.matchAll(/data-vcp-lazy-tool-id="([^"]+)"/g)) keep.add(match[1]);
    root?.querySelectorAll?.('[data-vcp-lazy-tool-id]').forEach(block => {
        mountLazyTool(block, false);
        if (!keep.has(block.dataset.vcpLazyToolId)) lazyToolContents.delete(block.dataset.vcpLazyToolId);
    });
}

// Cache inert HTML templates + lazy tool descriptors, never DOM / postprocessing /
// message objects. Runtime registrations are regenerated on every cache hit.
const RENDER_PIPELINE_VERSION = '2026-11-15-parse-registration-v3';
const RENDER_HTML_CACHE_MAX_BYTES = 20 * 1024 * 1024;
const RENDER_HTML_CACHE_MAX_ENTRIES = 500;
const RENDER_HTML_CACHE_MAX_SINGLE_BYTES = 1024 * 1024;
const RENDER_HTML_CACHE_MAX_TEXT_LENGTH = 512 * 1024;
const renderHtmlCache = new Map();
let renderHtmlCacheBytes = 0;
const renderHtmlCacheStats = {
    hits: 0,
    misses: 0,
    skips: 0,
    evictions: 0
};


// --- LaTeX Protection ---
// 用于在 marked 解析前保护 LaTeX 块，防止 Markdown 解析器破坏 LaTeX 语法
// （如 \\ 被当作转义、_ 被当作斜体等）

/**
 * 在 marked 解析前保护 LaTeX 块，用占位符替换。
 * 必须在 preprocessFullContent 之后、markedInstance.parse 之前调用。
 * @param {string} text 预处理后的文本
 * @returns {{text: string, map: Map<string, string>}} 替换后的文本和映射表
 */
const protectLatexBlocks = (...args) => templateCompiler.protectLatexBlocks(...args);

/**
 * 在 marked 解析后恢复被保护的 LaTeX 块。
 * @param {string} html marked 解析后的 HTML
 * @param {Map<string, string>} map 占位符到原始 LaTeX 的映射
 * @returns {string} 恢复后的 HTML
 */
const restoreLatexBlocks = (...args) => templateCompiler.restoreLatexBlocks(...args);

// --- Pre-compiled Regular Expressions for Performance ---
const TOOL_REGEX = /(?<!`)<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>(?!`)/gs;
const NOTE_REGEX = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/gs;
const TOOL_RESULT_REGEX = /\[\[VCP调用结果信息汇总:(.*?)VCP调用结果结束\]\]/gs;
const TOOL_CALL_SUMMARY_REGEX = /\[本轮工具调用摘要:\]([\s\S]*?)\[本轮工具调用摘要结束\]/g;
const BUTTON_CLICK_REGEX = /\[\[点击按钮:(.*?)\]\]/gs;
const CANVAS_PLACEHOLDER_REGEX = /\{\{VCPChatCanvas\}\}/g;
const STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const HTML_FENCE_CHECK_REGEX = /```\w*\n<!DOCTYPE html>/i;
const MERMAID_CODE_REGEX = /<code.*?>\s*(flowchart|graph|mermaid)\s+([\s\S]*?)<\/code>/gi;
const MERMAID_FENCE_REGEX = /```(mermaid|flowchart|graph)[^\S\n]*\n([\s\S]*?)```/g;
const CODE_FENCE_REGEX = /```[^\n]*([\s\S]*?)```/g;
const THOUGHT_CHAIN_REGEX = /^[ \t]*\[--- VCP元思考链(?::\s*"([^"]*)")?\s*---\][ \t]*\r?\n([\s\S]*?)^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm;
const CONVENTIONAL_THOUGHT_REGEX = /^[ \t]*<(think(?:ing)?|thought(?:s)?)>[ \t]*(?:\r?\n)?([\s\S]*?)<\/(?:think(?:ing)?|thought(?:s)?)>[ \t]*(?:\r?\n|$)/gim;
const ROLE_DIVIDER_REGEX = /<<<\[(END_)?ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;
const DESKTOP_PUSH_REGEX = /(?<!`)<<<\[DESKTOP_PUSH\]>>>([\s\S]*?)<<<\[DESKTOP_PUSH_END\]>>>(?!`)/gs;
const DESKTOP_PUSH_PARTIAL_REGEX = /(?<!`)<<<\[DESKTOP_PUSH\]>>>([\s\S]*)$/s; // 流式传输中未闭合的情况


// --- Enhanced Rendering Styles (from UserScript) ---
function injectEnhancedStyles() {
    // The stylesheet is imported through style.css in the legacy cascade layer.
    // Keeping it there lets the next-UI system override only its own message surface.
}

// --- Core Logic ---

/**
 * A helper function to escape HTML special characters.
 * @param {string} text The text to escape.
 * @returns {string} The escaped text.
 */
function escapeHtml(text) {
    return contentProcessor.escapeHtml(text);
}

const ASSISTANT_HTML_SCOPE_TRIGGER_REGEX = /<\s*(?:style|html|head|body|main|section|article|header|footer|nav|aside|div|span|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|p|h[1-6]|form|button|input|textarea|select|option|label|svg|canvas|iframe|object|embed|video|audio|img|a)\b|style\s*=/i;
const TOOL_RESULT_RAW_HTML_LINE_REGEX = /<!doctype\b|<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s>/])|<!--|<\?xml\b/i;
const TOOL_RESULT_DANGEROUS_HTML_REGEX = /<\s*\/?\s*(?:style|script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math|canvas|video|audio|source|track|frame|frameset|html|head|body)\b/i;
const TOOL_RESULT_COMPLETE_HTML_REGEX = /<!doctype\s+html\b|<\s*html\b|<\s*head\b|<\s*body\b/i;
const HTML_STYLE_TAG_REGEX = /<style\b/i;
const FENCE_LINE_REGEX = /^\s*(`{3,}|~{3,})/;
const FENCE_LANG_LINE_REGEX = /^\s*(`{3,}|~{3,})(.*)$/;
const TOOL_RESULT_SAFE_MARKDOWN_OPTIONS = Object.freeze({
    mangle: false,
    headerIds: false
});

/** 按区间替换工具结果；replacer 返回替换文本。区间须按源码顺序且互不重叠。 */
function replaceToolResultRanges(text, ranges, replacer) {
    let result = '';
    let cursor = 0;
    for (const range of ranges) {
        result += text.slice(cursor, range.start) + replacer(text.slice(range.start, range.end), range);
        cursor = range.end;
    }
    return result + text.slice(cursor);
}

function containsAssistantHtmlNeedingScope(text) {
    return typeof text === 'string' && ASSISTANT_HTML_SCOPE_TRIGGER_REGEX.test(text);
}

function containsStyleTag(text) {
    return typeof text === 'string' && HTML_STYLE_TAG_REGEX.test(text);
}

const escapeRawHtmlOutsideCodeFences = (...args) => templateCompiler.escapeRawHtmlOutsideCodeFences(...args);

const fenceCompleteHtmlToolResult = (...args) => templateCompiler.fenceCompleteHtmlToolResult(...args);

const sealToolResultMarkdownSource = (...args) => templateCompiler.sealToolResultMarkdownSource(...args);

const renderSafeToolResultMarkdown = (...args) => templateCompiler.renderSafeToolResultMarkdown(...args);

/**
 * Generates a unique ID for scoping CSS.
 * @returns {string} A unique ID string (e.g., 'vcp-bubble-1a2b3c4d').
 */
function generateUniqueId() {
    // Use a combination of timestamp and random string for uniqueness
    const timestampPart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).substring(2, 9);
    return `vcp-bubble-${timestampPart}${randomPart}`;
}

/**
 * Renders Mermaid diagrams found within a given container.
 * Finds placeholders, replaces them with the actual Mermaid code,
 * and then calls the Mermaid API to render them.
 * @param {HTMLElement} container The container element to search within.
 */
async function renderMermaidDiagrams(container) {
    const placeholders = Array.from(container.querySelectorAll('.mermaid-placeholder'));
    if (placeholders.length === 0) return;

    // Prepare elements for rendering
    placeholders.forEach(placeholder => {
        const code = placeholder.dataset.mermaidCode;
        if (code) {
            try {
                // The placeholder div itself will become the mermaid container
                let decodedCode = decodeURIComponent(code);
                // 修复 AI 常用的“智能字符”导致的 Mermaid 语法错误
                decodedCode = decodedCode.replace(/[—–－]/g, '--');

                placeholder.textContent = decodedCode;
                placeholder.classList.remove('mermaid-placeholder');
                placeholder.classList.add('mermaid');
                placeholder.dataset.mermaidSource = decodedCode;
            } catch (e) {
                console.error('Failed to decode mermaid code', e);
                placeholder.textContent = '[Mermaid code decoding error]';
            }
        }
    });

    // Get the list of actual .mermaid elements to render
    const elementsToRender = placeholders.filter(el => el.classList.contains('mermaid'));

    for (const el of elementsToRender) {
        el.classList.add('pele-diagram');
        const originalCode = el.dataset.mermaidSource || el.textContent;
        try {
            if (typeof window.pele === 'undefined' || typeof window.pele.render !== 'function') {
                throw new Error('本地 Pele 渲染依赖未加载。');
            }
            if (originalCode.length > 100000) {
                throw new Error('图表源码超过 100,000 字符限制。');
            }
            const { svg } = window.pele.render(originalCode);
            el.innerHTML = svg;
            enhanceMermaidDiagram(el);
        } catch (error) {
            console.error("Error rendering diagram with Pele:", error);
            el.classList.add('mermaid-error');
            el.innerHTML = `<div class="mermaid-error">Pele 图表渲染失败: ${error.message}</div><pre>${escapeHtml(originalCode)}</pre>`;
        }
    }
}

function enhanceMermaidDiagram(mermaidElement) {
    if (!mermaidElement || mermaidElement.dataset.vcpMermaidEnhanced === 'true') return;

    const svg = mermaidElement.querySelector('svg');
    if (!svg) return;

    mermaidElement.dataset.vcpMermaidEnhanced = 'true';

    const ownerDocument = mermaidElement.ownerDocument;
    if (!ownerDocument) return;
    const wrapper = ownerDocument.createElement('div');
    wrapper.className = 'mermaid-viewer';
    wrapper.dataset.scale = '1';
    wrapper.dataset.translateX = '0';
    wrapper.dataset.translateY = '0';
    const disposers = [];
    const listen = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        disposers.push(() => target.removeEventListener(type, handler, options));
    };
    wrapper._vcpDisposers = disposers;

    const toolbar = ownerDocument.createElement('div');
    toolbar.className = 'mermaid-viewer-toolbar';
    toolbar.innerHTML = `
        <button type="button" class="mermaid-viewer-btn" data-mermaid-action="zoom-out" title="缩小">−</button>
        <button type="button" class="mermaid-viewer-btn" data-mermaid-action="reset" title="重置视图">100%</button>
        <button type="button" class="mermaid-viewer-btn" data-mermaid-action="zoom-in" title="放大">＋</button>
        <button type="button" class="mermaid-viewer-btn" data-mermaid-action="fit" title="自动适应宽高，完整显示图表">适应</button>
    `;

    const viewport = ownerDocument.createElement('div');
    viewport.className = 'mermaid-viewer-viewport';
    viewport.title = '滚轮缩放，按住鼠标左键拖拽平移，双击重置';

    const canvas = ownerDocument.createElement('div');
    canvas.className = 'mermaid-viewer-canvas';

    // 保留 Pele 在 svg.style 中内联的 CSS 变量映射（如 --_s, --_b, --_fg），仅覆盖尺寸以便在视口中自由平移缩放
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    canvas.appendChild(svg);
    viewport.appendChild(canvas);

    mermaidElement.textContent = '';
    wrapper.appendChild(toolbar);
    wrapper.appendChild(viewport);
    mermaidElement.appendChild(wrapper);

    const clampScale = (scale) => Math.min(5, Math.max(0.2, scale));
    const getState = () => ({
        scale: parseFloat(wrapper.dataset.scale) || 1,
        translateX: parseFloat(wrapper.dataset.translateX) || 0,
        translateY: parseFloat(wrapper.dataset.translateY) || 0
    });
    const setState = (nextState, minimumScale = 0.2) => {
        const scale = Math.min(5, Math.max(minimumScale, nextState.scale));
        wrapper.dataset.scale = String(scale);
        wrapper.dataset.translateX = String(nextState.translateX || 0);
        wrapper.dataset.translateY = String(nextState.translateY || 0);
        canvas.style.transform = `translate(${nextState.translateX || 0}px, ${nextState.translateY || 0}px) scale(${scale})`;
        const resetButton = toolbar.querySelector('[data-mermaid-action="reset"]');
        if (resetButton) resetButton.textContent = `${Math.round(scale * 100)}%`;
    };
    const zoomAt = (targetScale, originX = viewport.clientWidth / 2, originY = viewport.clientHeight / 2) => {
        const current = getState();
        const scale = clampScale(targetScale);
        const ratio = scale / current.scale;
        setState({
            scale,
            translateX: originX - (originX - current.translateX) * ratio,
            translateY: originY - (originY - current.translateY) * ratio
        });
    };
    const resetView = () => setState({ scale: 1, translateX: 0, translateY: 0 });
    const fitToViewport = () => {
        // 按最终 DOM 的实际显示尺寸测量，而非 SVG 内部坐标；
        // 通过画布实际缩放消除当前缩放（包括过渡动画）的影响。
        const canvasRect = canvas.getBoundingClientRect();
        const svgRect = svg.getBoundingClientRect();
        const renderedScale = canvas.offsetWidth > 0 ? canvasRect.width / canvas.offsetWidth : 0;
        if (!(renderedScale > 0) || !(svgRect.width > 0) || !(svgRect.height > 0)
            || !(viewport.clientWidth > 0) || !(viewport.clientHeight > 0)) return;

        const svgWidth = svgRect.width / renderedScale;
        const svgHeight = svgRect.height / renderedScale;
        const offsetX = (svgRect.left - canvasRect.left) / renderedScale;
        const offsetY = (svgRect.top - canvasRect.top) / renderedScale;
        const availableWidth = Math.max(1, viewport.clientWidth - 32);
        const availableHeight = Math.max(1, viewport.clientHeight - 32);
        // 较小的比例自动决定适应宽度还是高度，超长图不受手动缩放的 20% 下限限制。
        const scale = Math.min(1.8, availableWidth / svgWidth, availableHeight / svgHeight);
        setState({
            scale,
            translateX: (viewport.clientWidth - svgWidth * scale) / 2 - offsetX * scale,
            translateY: (viewport.clientHeight - svgHeight * scale) / 2 - offsetY * scale
        }, Math.min(0.2, scale));
    };


    listen(toolbar, 'click', (event) => {
        const button = event.target.closest('[data-mermaid-action]');
        if (!button) return;

        event.preventDefault();
        event.stopPropagation();

        const { scale } = getState();
        const action = button.dataset.mermaidAction;
        if (action === 'zoom-in') zoomAt(scale * 1.2);
        else if (action === 'zoom-out') zoomAt(scale / 1.2);
        else if (action === 'reset') resetView();
        else if (action === 'fit') fitToViewport();
    });

    listen(viewport, 'wheel', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const rect = viewport.getBoundingClientRect();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        zoomAt(getState().scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    let dragState = null;
    listen(viewport, 'pointerdown', (event) => {
        if (event.button !== 0) return;

        const state = getState();
        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: state.translateX,
            originY: state.translateY
        };
        wrapper._vcpPointerId = event.pointerId;
        viewport.classList.add('dragging');
        viewport.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    listen(viewport, 'pointermove', (event) => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;

        setState({
            scale: getState().scale,
            translateX: dragState.originX + event.clientX - dragState.startX,
            translateY: dragState.originY + event.clientY - dragState.startY
        });
    });

    const endDrag = (event) => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        dragState = null;
        delete wrapper._vcpPointerId;
        viewport.classList.remove('dragging');
        viewport.releasePointerCapture?.(event.pointerId);
    };
    listen(viewport, 'pointerup', endDrag);
    listen(viewport, 'pointercancel', endDrag);
    listen(viewport, 'dblclick', (event) => {
        event.preventDefault();
        resetView();
    });

    // 初始视图固定为 100%，仅在用户点击“适应”时自动匹配视口宽高。
    // 历史加载期间容器可能尚未完成布局，不应据此覆盖默认缩放。
    resetView();
}

function cleanupMermaidViewers(contentDiv) {
    contentDiv?.querySelectorAll?.('.mermaid-viewer').forEach(wrapper => {
        wrapper._vcpDisposers?.splice(0).forEach(dispose => {
            try { dispose(); } catch { /* listener already removed */ }
        });
        const viewport = wrapper.querySelector('.mermaid-viewer-viewport');
        const pointerId = wrapper._vcpPointerId;
        if (pointerId !== undefined && viewport?.hasPointerCapture?.(pointerId)) {
            try { viewport.releasePointerCapture(pointerId); } catch { /* pointer already released */ }
        }
        wrapper.replaceChildren();
        delete wrapper._vcpPointerId;
    });
}

function getCompiledRegex(rule) {
    if (!rule?.findPattern) {
        return null;
    }

    if (mainRendererReferences?.uiHelper?.getCompiledRegex) {
        const compiled = mainRendererReferences.uiHelper.getCompiledRegex(rule.findPattern);
        return compiled?.regex || null;
    }

    if (mainRendererReferences?.uiHelper?.regexFromString) {
        return mainRendererReferences.uiHelper.regexFromString(rule.findPattern);
    }

    const regexMatch = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
    if (regexMatch) {
        return new RegExp(regexMatch[1], regexMatch[2]);
    }
    return new RegExp(rule.findPattern, 'g');
}

/**
 * 应用单个正则规则到文本
 * @param {string} text - 输入文本
 * @param {Object} rule - 正则规则对象
 * @returns {string} 处理后的文本
 */
function applyRegexRule(text, rule) {
    if (!rule || !rule.findPattern || typeof text !== 'string') {
        return text;
    }

    try {
        const regex = getCompiledRegex(rule);

        if (!regex) {
            console.error('无法解析正则表达式:', rule.findPattern);
            return text;
        }

        regex.lastIndex = 0;

        // 应用替换（如果没有替换内容，则默认替换为空字符串）
        return text.replace(regex, rule.replaceWith || '');
    } catch (error) {
        console.error('应用正则规则时出错:', rule.findPattern, error);
        return text;
    }
}

function getActiveFrontendRegexRules(rules, role, depth) {
    if (!rules || !Array.isArray(rules)) {
        return [];
    }

    return rules.filter(rule => {
        if (!rule || rule.enabled === false || !rule.findPattern || !rule.applyToFrontend) return false;

        const shouldApplyToRole = rule.applyToRoles && rule.applyToRoles.includes(role);
        if (!shouldApplyToRole) return false;

        const minDepthOk = rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth;
        const maxDepthOk = rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth;
        return minDepthOk && maxDepthOk;
    });
}

/**
 * 应用所有匹配的正则规则到文本（前端版本）
 * @param {string} text - 输入文本
 * @param {Array} rules - 正则规则数组
 * @param {string} role - 消息角色 ('user' 或 'assistant')
 * @param {number} depth - 消息深度（0 = 最新消息）
 * @returns {string} 处理后的文本
 */
function applyFrontendRegexRules(text, rules, role, depth) {
    if (!rules || !Array.isArray(rules) || typeof text !== 'string') {
        return text;
    }

    const activeRules = getActiveFrontendRegexRules(rules, role, depth);
    if (activeRules.length === 0) {
        return text;
    }

    return transformToolBatchText(text, source => {
        let processedText = source;
        activeRules.forEach(rule => {
            processedText = applyRegexRule(processedText, rule);
        });
        return processedText;
    });
}

/**
 * Finds special VCP blocks (Tool Requests, Daily Notes) and transforms them
 * directly into styled HTML divs, bypassing the need for markdown code fences.
 * @param {string} text The text content.
 * @param {Map} [codeBlockMap] Map of code block placeholders to their original content.
 * @returns {string} The processed text with special blocks as HTML.
 */
const transformSpecialBlocks = (...args) => templateCompiler.transformSpecialBlocks(...args);

/**
 * Transforms user's "clicked button" indicators into styled bubbles.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
function transformUserButtonClick(text) {
    return text.replace(BUTTON_CLICK_REGEX, (match, content) => {
        const escapedContent = escapeHtml(content.trim());
        return `<span class="user-clicked-button-bubble">${escapedContent}</span>`;
    });
}

function transformVCPChatCanvas(text) {
    return text.replace(CANVAS_PLACEHOLDER_REGEX, () => {
        // Use a div for better block-level layout and margin behavior
        return `<div class="vcp-chat-canvas-placeholder">Canvas协同中<span class="thinking-indicator-dots">...</span></div>`;
    });
}

function extractSpeakableTextFromContentElement(contentElement) {
    if (!contentElement) return '';

    const contentClone = contentElement.cloneNode(true);

    // data-vcp-block-type 是特殊协议渲染块的统一边界。保留显式类名作为
    // 旧历史 DOM / 第三方渲染结果的兼容兜底；@tag 是路由提示而非正文，
    // 无论后处理高亮是否已经完成，都不应进入 TTS。
    contentClone.querySelectorAll(
        '[data-vcp-block-type], .vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, .vcp-flowlock-bubble, .maid-diary-bubble, .maid-diary-update-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, .vcp-desktop-push-placeholder, .highlighted-tag, .highlighted-alert-tag, style, script'
    ).forEach(el => el.remove());

    let speakableText = stripToolBatches(contentClone.innerText || contentClone.textContent || '');

    // DOM 块删除是主路径；下面是协议文本残留的防御性兜底。
    // 工具结果优先级最高且嵌套感知，最先整体剥离；其内部的工具请求/推送标记随之移除。
    // 工具请求扫描器不依赖换行，支持“前文<<<[TOOL_REQUEST]>>>tool_name...结束标记后文”。
    // 因此即使 Markdown 没有生成独立气泡，也不会把完整工具载荷送入 TTS。
    // Speech is conservative: DOM text may concatenate line-oriented protocol
    // closers with prose. Match nested receipt literals without requiring lines.
    const speakableToolResultRanges = [];
    const receiptMarkers = /\[\[VCP调用结果信息汇总:|VCP调用结果结束\]\]/g;
    let receiptDepth = 0;
    let receiptStart = 0;
    let receiptMarker;
    while ((receiptMarker = receiptMarkers.exec(speakableText))) {
        if (receiptMarker[0].startsWith('[[')) {
            if (receiptDepth++ === 0) receiptStart = receiptMarker.index;
        } else if (receiptDepth > 0 && --receiptDepth === 0) {
            speakableToolResultRanges.push({ start: receiptStart, end: receiptMarkers.lastIndex });
        }
    }
    if (receiptDepth > 0) speakableToolResultRanges.push({ start: receiptStart, end: speakableText.length });
    if (speakableToolResultRanges.length > 0) {
        speakableText = replaceToolResultRanges(speakableText, speakableToolResultRanges, () => '');
    }
    speakableText = replaceToolRequestBlocks(speakableText, () => '');
    speakableText = speakableText
        .replace(TOOL_CALL_SUMMARY_REGEX, '')
        .replace(ROLE_DIVIDER_REGEX, '')
        .replace(DESKTOP_PUSH_REGEX, '');

    // 上述正则是带 global 状态的共享常量，显式复位，避免后续渲染调用受影响。
    TOOL_CALL_SUMMARY_REGEX.lastIndex = 0;
    ROLE_DIVIDER_REGEX.lastIndex = 0;
    DESKTOP_PUSH_REGEX.lastIndex = 0;

    return speakableText
        // 提取可能早于异步 @tag 高亮完成，因此还需清理纯文本形式。
        // 与前端高亮语法保持一致，支持 @name 和 @!name。
        .replace(/@!?[\u4e00-\u9fa5A-Za-z0-9_]+/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Extracts <style> tags from content, scopes the CSS, and injects it into the document head.
 * @param {string} content - The raw message content string.
 * @param {string} scopeId - The unique ID for scoping.
 * @returns {{processedContent: string, styleInjected: boolean}} The content with <style> tags removed, and a flag indicating if styles were injected.
 */
function processAndInjectScopedCss(content, scopeId, options = {}) {
    let cssContent = '';
    let styleInjected = false;
    const injectStyles = options.injectStyles !== false;

    const processedContent = content.replace(STYLE_REGEX, (match, css) => {
        cssContent += css.trim() + '\n';
        // style 位于 DIV 动画岛内部时不能替换为空字符串：空行会终止
        // CommonMark raw HTML block，导致岛内后续节点被重新分段。保留不可见
        // 注释作为硬边界，既移除可执行 style，又维持 HTML 岛结构连续。
        return '<!-- VCP-SCOPED-STYLE-EXTRACTED -->';
    });

    if (options.cssChunks) {
        if (cssContent.trim()) {
            try {
                options.cssChunks.push(scopeCssCached(cssContent, scopeId));
            } catch (error) {
                console.warn('[ScopedCSS] Rejected invalid domain CSS:', error);
            }
        }
        return { processedContent, styleInjected };
    }
    if (injectStyles && (cssContent.length > 0 || options.scopedCssOverride)) {
        try {
            const scopedCss = options.scopedCssOverride ?? scopeCssCached(cssContent, scopeId);
            if (!scopedCss.trim()) {
                if (options.messageItem) {
                    options.messageItem.dataset.vcpScopedStyleState = 'rejected';
                }
                throw new SyntaxError('Scoped CSS transform returned no safe rules');
            }
            // Scope IDs are generated per message, but include the surface namespace
            // in the lookup as a hard boundary when two renderers share a document.
            const styleSelector = `style[data-vcp-scope-id="${escapeCssAttributeValue(scopeId)}"][data-vcp-surface-id="${escapeCssAttributeValue(surfaceId)}"]`;
            const ownerDocument = mainRendererReferences?.document || mainRendererReferences?.chatMessagesDiv?.ownerDocument;
            if (!ownerDocument?.head) throw new Error('MessageRenderer has no owning document head');
            let styleElement = [...ownedStyleElements].find((element) => element.matches?.(styleSelector));

            if (!styleElement) {
                styleElement = ownerDocument.createElement('style');
                styleElement.type = 'text/css';
                styleElement.setAttribute('data-vcp-scope-id', scopeId);
                styleElement.setAttribute('data-vcp-surface-id', surfaceId);
                ownerDocument.head.appendChild(styleElement);
                ownedStyleElements.add(styleElement);
            }

            // 流式渲染会多次经过此函数：复用节点并原子替换文本，
            // 避免同一消息累积多个样式节点或出现旧规则覆盖新规则。
            if (styleElement.textContent !== scopedCss) styleElement.textContent = scopedCss;
            styleInjected = true;
            if (options.messageItem) {
                options.messageItem.dataset.vcpScopedStyleState = 'active';
            }

            console.debug(`[ScopedCSS] Updated scoped styles for ID: #${scopeId}`, {
                sourceLength: cssContent.length,
                scopedLength: scopedCss.length
            });
        } catch (error) {
            if (options.messageItem) {
                options.messageItem.dataset.vcpScopedStyleState = 'rejected';
            }
            console.error(`[ScopedCSS] Failed to scope or inject CSS for ID: ${scopeId}`, error);
        }
    }

    return { processedContent, styleInjected };
}


function removeOwnedMessageScopeStyle(scopeId) {
    if (!scopeId) return;
    for (const styleElement of ownedStyleElements) {
        if (
            styleElement.getAttribute('data-vcp-surface-id') === surfaceId
            && styleElement.getAttribute('data-vcp-scope-id') === scopeId
        ) {
            styleElement.remove();
            ownedStyleElements.delete(styleElement);
        }
    }
}

function processAssistantScopedHtmlContent(content, scopeId, messageItem = null, options = {}) {
    // This path also receives authoritative visible stream source before CSS extraction.
    if (options.injectStyles !== false && messageItem) {
        const root = messageItem.closest('[data-vcp-projectforge-root]') || mainRendererReferences?.chatMessagesDiv;
        projectForgeTopicSurface.observe(root, { id: messageItem.dataset.messageId, role: 'assistant', content });
    }
    if (scopeId && collectToolBatchRanges(content).length) {
        const cssChunks = [];
        const processed = transformToolBatchText(content, source =>
            processAssistantScopedHtmlContent(source, scopeId, null, {
                ...options, injectStyles: false, cssChunks,
            }));
        if (options.cssChunks) options.cssChunks.push(...cssChunks);
        if (options.injectStyles !== false) {
            removeOwnedMessageScopeStyle(scopeId);
            if (cssChunks.length) {
                processAndInjectScopedCss('', scopeId, {
                    ...options, messageItem, scopedCssOverride: cssChunks.join('\n'),
                });
            }
        }
        if (messageItem) {
            messageItem.dataset.vcpHtmlScopeCandidate = 'true';
            if (cssChunks.length) delete messageItem.dataset.vcpInlineHtmlScoped;
            else messageItem.dataset.vcpInlineHtmlScoped = 'true';
        }
        return processed;
    }
    if (!scopeId || !containsAssistantHtmlNeedingScope(content)) {
        // 规范终稿可能移除了流式预览阶段出现过的 style；此时必须撤销旧消息级样式。
        if (options.injectStyles !== false && messageItem?.dataset?.vcpHtmlScopeCandidate === 'true') {
            removeOwnedMessageScopeStyle(scopeId);
            delete messageItem.dataset.vcpHtmlScopeCandidate;
            delete messageItem.dataset.vcpInlineHtmlScoped;
        }
        return content;
    }

    if (messageItem) {
        messageItem.dataset.vcpHtmlScopeCandidate = 'true';
        if (!containsStyleTag(content)) {
            messageItem.dataset.vcpInlineHtmlScoped = 'true';
        }
    }

    if (!containsStyleTag(content)) {
        if (options.injectStyles !== false && messageItem) {
            removeOwnedMessageScopeStyle(scopeId);
            delete messageItem.dataset.vcpScopedStyleState;
        }
        return content;
    }

    const styles = [];
    const restoredContent = tokenizeVcpDocument(content, { mode: options.mode || 'final' }).map(region => {
        const raw = content.slice(region.start, region.end);
        if (region.kind !== 'style' || !region.closed) return raw;
        styles.push(raw);
        return '<!-- VCP-SCOPED-STYLE-EXTRACTED -->';
    }).join('');
    processAndInjectScopedCss(styles.join('\n'), scopeId, { ...options, messageItem });

    return restoredContent;
}


/**
 * Wraps raw HTML documents in markdown code fences if they aren't already.
 * An HTML document is identified by the `<!DOCTYPE html>` declaration.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
/**
 * Wraps raw HTML documents in markdown code fences if they aren't already.
 * 🟢 跳过「始」「末」标记内的 HTML，防止工具调用参数被错误封装
 */
const ensureHtmlFenced = (...args) => templateCompiler.ensureHtmlFenced(...args);


/**
 * Removes leading whitespace from lines that appear to be HTML tags,
 * as long as they are not inside a fenced code block. This prevents
 * the markdown parser from misinterpreting indented HTML as an indented code block.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
const deIndentHtml = (...args) => templateCompiler.deIndentHtml(...args);


/**
 * 根据对话轮次计算消息的深度。
 * @param {string} messageId - 目标消息的ID。
 * @param {Array<Message>} history - 完整的聊天记录数组。
 * @returns {number} - 计算出的深度（0代表最新一轮）。
 */
function buildTurnDepthMap(history = []) {
    const turns = [];
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant') {
            const turn = { assistant: history[i], user: null };
            if (i > 0 && history[i - 1].role === 'user') {
                turn.user = history[i - 1];
                i--;
            }
            turns.push(turn); // ✅ 使用 push
        } else if (history[i].role === 'user') {
            turns.push({ assistant: null, user: history[i] });
        }
    }
    turns.reverse(); // ✅ 最后反转一次

    const depthMap = new Map();
    turns.forEach((turn, turnIndex) => {
        const depth = turns.length - 1 - turnIndex;
        if (turn.assistant?.id) {
            depthMap.set(turn.assistant.id, depth);
        }
        if (turn.user?.id) {
            depthMap.set(turn.user.id, depth);
        }
    });
    return depthMap;
}

function calculateDepthByTurns(messageId, history) {
    return buildTurnDepthMap(history).get(messageId) ?? 0;
}


/**
 * A helper function to preprocess the full message content string before parsing.
 * @param {string} text The raw text content.
 * @returns {string} The processed text.
 */
const preprocessFullContent = (...args) => templateCompiler.preprocessFullContent(...args);

function preprocessStreamTailContent(text) {
    if (!contentPipeline) {
        console.warn('[MessageRenderer] contentPipeline not initialized for stream tail, falling back to raw text');
        return text;
    }

    return templateCompiler.processStream(text);
}

function estimateStringBytes(str) {
    return typeof str === 'string' ? str.length * 2 : 0;
}

const hashStringFNV1a = (...args) => templateCompiler.hashStringFNV1a(...args);

function buildRenderSettingsFingerprint(settings = {}) {
    // 仅纳入会影响 Markdown → raw HTML 或按钮标记处理的稳定设置；后续新增渲染相关设置时可 bump RENDER_PIPELINE_VERSION。
    return JSON.stringify({
        enableAiMessageButtons: settings.enableAiMessageButtons !== false
    });
}

function shouldBypassRenderHtmlCache(text) {
    return typeof text !== 'string' || !text || text.length > RENDER_HTML_CACHE_MAX_TEXT_LENGTH;
}

function buildRenderSourceFingerprint(text) {
    // Two 32-bit accumulators in one traversal. This is a probabilistic cache
    // fingerprint, not a cryptographic identity or a proof of source equality.
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        first = Math.imul(first ^ char, 0x01000193);
        second = Math.imul(second ^ char, 0x5bd1e995);
        second ^= second >>> 13;
    }
    return JSON.stringify([
        first >>> 0, second >>> 0, text.length, text.slice(0, 64), text.slice(-64)
    ]);
}

function buildRenderHtmlCacheKey(text, options = {}) {
    const settings = options.settings || mainRendererReferences.globalSettingsRef.get();
    const messageRole = options.messageRole || 'assistant';
    const depth = options.depth ?? 0;

    return [
        RENDER_PIPELINE_VERSION,
        messageRole,
        depth,
        buildRenderSettingsFingerprint(settings),
        options.resultOrdinal || 0,
        Boolean(options.batchDomain),
        buildRenderSourceFingerprint(text)
    ].join('|');
}

function getRenderHtmlCache(key) {
    const entry = renderHtmlCache.get(key);
    if (!entry) return null;

    renderHtmlCache.delete(key);
    entry.lastUsed = Date.now();
    entry.hits += 1;
    renderHtmlCache.set(key, entry);
    renderHtmlCacheStats.hits += 1;

    return entry.template;
}

function trimRenderHtmlCache() {
    while (
        renderHtmlCacheBytes > RENDER_HTML_CACHE_MAX_BYTES ||
        renderHtmlCache.size > RENDER_HTML_CACHE_MAX_ENTRIES
    ) {
        const oldestKey = renderHtmlCache.keys().next().value;
        if (oldestKey === undefined) break;

        const oldest = renderHtmlCache.get(oldestKey);
        renderHtmlCacheBytes -= oldest?.size || 0;
        renderHtmlCache.delete(oldestKey);
        renderHtmlCacheStats.evictions += 1;
    }
}

function setRenderHtmlCache(key, template) {
    // Lazy payloads are necessary to restore tools after DOM cleanup; include them
    // and metadata in the budget rather than hiding them in an unbounded side map.
    const size = estimateStringBytes(key) + estimateStringBytes(template.html)
        + template.tools.reduce((bytes, entry) => bytes
            + estimateStringBytes(entry.id) + estimateStringBytes(entry.type)
            + estimateStringBytes(entry.raw) + estimateStringBytes(JSON.stringify(entry.meta)) + 8, 0);
    if (size <= 0 || size > RENDER_HTML_CACHE_MAX_SINGLE_BYTES) {
        return;
    }

    if (renderHtmlCache.has(key)) {
        const old = renderHtmlCache.get(key);
        renderHtmlCacheBytes -= old?.size || 0;
        renderHtmlCache.delete(key);
    }

    renderHtmlCache.set(key, {
        template,
        size,
        hits: 0,
        lastUsed: Date.now()
    });
    renderHtmlCacheBytes += size;

    trimRenderHtmlCache();
}

function clearRenderHtmlCache() {
    renderHtmlCache.clear();
    renderHtmlCacheBytes = 0;
}

const renderMarkdownToHtmlUncached = (...args) => templateCompiler.renderMarkdownToHtmlUncached(...args);

function renderMarkdownToHtml(text, options = {}) {
    if (isContextCheckpoint(options.message)) {
        const meta = options.message.contextCompaction;
        const fidelity = meta.fidelity;
        const fidelityBadge = fidelity && Number.isFinite(fidelity.total) && fidelity.total > 0
            ? ` · 标识符 ${fidelity.preserved}/${fidelity.total}${fidelity.total > fidelity.preserved ? ' ⚠' : ''}`
            : '';
        const continuity = meta.continuity;
        const continuityBadge = continuity?.applicable && continuity.windows > 0
            ? ` · 未决 ${continuity.anchors.preserved}/${continuity.anchors.total}${continuity.openIssuesDropped || continuity.anchors.preserved < continuity.anchors.total ? ' ⚠' : ''}`
            : '';
        const summary = `上下文智能压缩 · ${meta.sourceCount || 0} 条历史 · ${meta.diaries?.length || 0} 篇日记${fidelityBadge}${continuityBadge}`;
        const auditLines = [];
        if (fidelity && Number.isFinite(fidelity.total) && fidelity.total > fidelity.preserved) {
            const samples = [
                ...(fidelity.missing?.path || []),
                ...(fidelity.missing?.hash || []),
                ...(fidelity.missing?.url || []),
            ];
            auditLines.push(`标识符缺失 ${fidelity.total - fidelity.preserved}/${fidelity.total}：${samples.slice(0, 8).join('、')}${samples.length > 8 ? ' …' : ''}`);
        }
        if (continuity?.applicable && continuity.windows > 0) {
            if (continuity.openIssuesDropped) {
                auditLines.push(`旧快照有 ${continuity.windows} 个未决窗口，新快照未再出现未决标记（可能已解决或被丢弃）`);
            }
            if (continuity.anchors.total > continuity.anchors.preserved) {
                auditLines.push(`未决项标识符未承接：${continuity.anchors.missing.slice(0, 8).join('、')}`);
            }
        }
        const auditHtml = auditLines.length
            ? `<div class="vcp-context-checkpoint-audit">${auditLines.map(line => `<div class="vcp-context-checkpoint-audit-line">${escapeHtml(line)}</div>`).join('')}</div>`
            : '';
        const body = escapeHtml(String(options.message.content || '')).replace(/\r\n?|\n/g, '&#10;');
        return `<details class="vcp-context-checkpoint" data-vcp-block-type="context-checkpoint" data-vcp-preserve-children="true"><summary data-vcp-system-control="true">${escapeHtml(summary)}</summary><div class="vcp-context-checkpoint-body">${auditHtml}${body}</div></details>`;
    }
    const markedInstance = mainRendererReferences.markedInstance;
    if (!markedInstance) return escapeHtml(text);

    if (shouldBypassRenderHtmlCache(text)) {
        renderHtmlCacheStats.skips += 1;
        return renderMarkdownToHtmlUncached(text, options);
    }

    const cacheKey = buildRenderHtmlCacheKey(text, options);
    const cachedTemplate = getRenderHtmlCache(cacheKey);
    if (cachedTemplate !== null) {
        return hydrateRenderTemplate(cachedTemplate);
    }

    renderHtmlCacheStats.misses += 1;
    // Scoped CSS extraction/injection happens at the caller before this pure
    // template stage. Media, events and scripts are still processed after mount.
    const template = buildRenderTemplate(text, options);
    setRenderHtmlCache(cacheKey, template);
    return hydrateRenderTemplate(template);
}

function parseFullMarkdown(text, options = {}) {
    return renderMarkdownToHtml(text, options);
}

/**
 * 查找流式文本中最后一个尚未闭合的代码围栏。
 * 返回围栏前正文、语言名和原始代码，使流式渲染不再依赖 marked 对残缺围栏的容错行为。
 */
function findUnclosedStreamCodeFence(text) {
    if (typeof text !== 'string' || (!text.includes('```') && !text.includes('~~~'))) {
        return null;
    }

    const normalizedText = text.replace(/\r\n?/g, '\n');
    const lines = normalizedText.split('\n');
    let activeFence = null;
    let offset = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);

        if (match) {
            const marker = match[1];
            const markerChar = marker[0];
            const trailingText = match[2] || '';

            if (!activeFence) {
                const infoString = trailingText.trim();
                const language = (infoString.split(/\s+/)[0] || '')
                    .replace(/[^\w#+.-]/g, '');

                activeFence = {
                    char: markerChar,
                    length: marker.length,
                    startOffset: offset,
                    contentOffset: offset + line.length + (lineIndex < lines.length - 1 ? 1 : 0),
                    language
                };
            } else if (
                markerChar === activeFence.char &&
                marker.length >= activeFence.length &&
                trailingText.trim() === ''
            ) {
                activeFence = null;
            }
        }

        offset += line.length;
        if (lineIndex < lines.length - 1) offset += 1;
    }

    if (!activeFence) return null;

    return {
        prefix: normalizedText.slice(0, activeFence.startOffset),
        code: normalizedText.slice(activeFence.contentOffset),
        language: activeFence.language
    };
}

function findUnclosedStreamThoughtChain(text) {
    if (
        typeof text !== 'string' ||
        (!text.includes('[--- VCP元思考链') && !/<(?:think(?:ing)?|thought(?:s)?)>/i.test(text))
    ) {
        return null;
    }

    const normalizedText = text.replace(/\r\n?/g, '\n');
    const lines = normalizedText.split('\n');
    let activeFence = null;
    let activeThought = null;
    let offset = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);

        if (fenceMatch) {
            const marker = fenceMatch[1];
            const trailingText = fenceMatch[2] || '';

            if (!activeFence) {
                activeFence = { char: marker[0], length: marker.length };
            } else if (
                marker[0] === activeFence.char &&
                marker.length >= activeFence.length &&
                trailingText.trim() === ''
            ) {
                activeFence = null;
            }
        } else if (!activeFence) {
            if (!activeThought) {
                const customStart = line.match(
                    /^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*$/
                );
                const conventionalStart = line.match(
                    /^[ \t]*<(think(?:ing)?|thought(?:s)?)>[ \t]*(.*)$/i
                );

                if (customStart) {
                    activeThought = { startIndex: offset, type: 'custom' };
                } else if (conventionalStart) {
                    const type = conventionalStart[1].toLowerCase();
                    const trailingContent = conventionalStart[2] || '';
                    const sameLineEndRegex = /<\/(?:think(?:ing)?|thought(?:s)?)>[ \t]*$/i;
                    if (!sameLineEndRegex.test(trailingContent)) {
                        activeThought = { startIndex: offset, type };
                    }
                }
            } else {
                const isEnd = activeThought.type === 'custom'
                    ? /^[ \t]*\[--- 元思考链结束 ---\][ \t]*$/.test(line)
                    : /<\/(?:think(?:ing)?|thought(?:s)?)>[ \t]*$/i.test(line);

                if (isEnd) {
                    activeThought = null;
                }
            }
        }

        offset += line.length;
        if (lineIndex < lines.length - 1) offset += 1;
    }

    if (!activeThought) return null;

    return {
        prefix: normalizedText.slice(0, activeThought.startIndex),
        thought: normalizedText.slice(activeThought.startIndex),
        startIndex: activeThought.startIndex,
        type: activeThought.type
    };
}

function parseStreamTailMarkdown(text) {
    if (collectToolBatchRanges(text).length) {
        return composeToolBatchHtml(splitToolBatchDomains(text), domain =>
            domain.type === 'text'
                ? parseStreamTailMarkdown(domain.source)
                : renderMarkdownToHtmlUncached(domain.source, { batchDomain: true }),
            mainRendererReferences.document || mainRendererReferences.chatMessagesDiv?.ownerDocument);
    }
    const markedInstance = mainRendererReferences.markedInstance;
    if (!markedInstance) return escapeHtml(text);

    // 工具结果优先级最高：完整工具结果先于任何流式预处理与协议扫描封存为占位符，
    // 其内部的 DESKTOP_PUSH / TOOL_REQUEST / <think> / 围栏等不能开启流尾隔离域，
    // 也不会被 marked 按原始 Markdown/HTML 解释。流尾只做安全的转义预览；
    // 规范气泡由稳定区或终态完整渲染生成（避免每帧登记大内容懒加载条目）。
    const streamToolResults = new Map();
    const closedToolResultRanges = collectClosedToolResultRanges(text);
    const sourceText = closedToolResultRanges.length > 0
        ? replaceToolResultRanges(text, closedToolResultRanges, (match) => {
            const placeholder = `<!--VCP_STREAM_TOOL_RESULT_${streamToolResults.size}-->`;
            streamToolResults.set(placeholder, match);
            return `\n\n${placeholder}\n\n`;
        })
        : text;
    const STREAM_TOOL_RESULT_PLACEHOLDER_REGEX = /<!--VCP_STREAM_TOOL_RESULT_\d+-->/g;
    // HTML 输出：占位符 → 转义后的封印预览。
    const restoreToolResultHtml = (html) => streamToolResults.size === 0 ? html : html.replace(
        STREAM_TOOL_RESULT_PLACEHOLDER_REGEX,
        (placeholder) => {
            const raw = streamToolResults.get(placeholder);
            return raw === undefined
                ? placeholder
                : `<pre class="vcp-stream-tool-result-sealed"><code>${escapeHtml(raw)}</code></pre>`;
        }
    );
    // 将要被整体转义显示的源码：占位符 → 原文，避免把占位符本身显示给用户。
    const restoreToolResultSource = (source) => streamToolResults.size === 0 ? source : source.replace(
        STREAM_TOOL_RESULT_PLACEHOLDER_REGEX,
        (placeholder) => streamToolResults.get(placeholder) ?? placeholder
    );

    const processedText = preprocessStreamTailContent(sourceText);

    // 工具请求、工具结果、桌面推送和思维链都属于流式隔离域。按源码中最早出现的入口决定
    // 封印边界，禁止后续协议扫描或 Markdown 原始 HTML 解释进入其不可信载荷。
    const unclosedToolBlock = findEarliestUnclosedToolBlock(processedText);
    const unclosedThoughtChain = findUnclosedStreamThoughtChain(processedText);
    const sealedBlock = [unclosedToolBlock, unclosedThoughtChain]
        .filter(Boolean)
        .sort((a, b) => a.startIndex - b.startIndex)[0];

    if (sealedBlock) {
        const prefixHtml = sealedBlock.prefix
            ? restoreToolResultHtml(markedInstance.parse(sealedBlock.prefix))
            : '';
        const isThoughtChain = sealedBlock === unclosedThoughtChain;
        const sealedText = restoreToolResultSource(isThoughtChain ? sealedBlock.thought : sealedBlock.content);
        let sealClass = 'vcp-stream-tool-request-sealed';
        if (isThoughtChain) {
            sealClass = 'vcp-stream-thought-chain-sealed';
        } else if (sealedBlock.type === 'tool-result') {
            sealClass = 'vcp-stream-tool-result-sealed';
        } else if (sealedBlock.type === 'desktop-push') {
            sealClass = 'vcp-stream-desktop-push-sealed';
        }
        return `${prefixHtml}<pre class="${sealClass}"><code>${escapeHtml(sealedText)}</code></pre>`;
    }

    const unclosedFence = findUnclosedStreamCodeFence(processedText);

    if (!unclosedFence) {
        return restoreToolResultHtml(markedInstance.parse(processedText));
    }

    const prefixHtml = unclosedFence.prefix
        ? restoreToolResultHtml(markedInstance.parse(unclosedFence.prefix))
        : '';
    const languageClass = unclosedFence.language
        ? ` language-${escapeHtml(unclosedFence.language)}`
        : '';
    const codeLines = restoreToolResultSource(unclosedFence.code).replace(/\r\n?/g, '\n').split('\n');
    const completedLineCount = Math.max(0, codeLines.length - 1);
    const lineHtml = codeLines.map((lineText, lineIndex) => {
        const escapedLine = lineText ? escapeHtml(lineText) : '&#8203;';
        const completedAttribute = lineIndex < completedLineCount
            ? ' data-vcp-stream-code-completed="true"'
            : '';
        return `<span class="vcp-stream-code-line" data-vcp-key="stream-code-line-${lineIndex}" data-vcp-stream-code-line="${lineIndex}"${completedAttribute}>${escapedLine}</span>`;
    }).join('');

    // 流式解析阶段直接输出稳定的逐行 DOM，避免每帧在 streamManager 中重建全部代码行。
    return `${prefixHtml}<pre class="vcp-stream-code-block"><code class="vcp-stream-code-lines${languageClass}">${lineHtml}</code></pre>`;
}

function prepareFinalTextForRender(messageId, rawText, role = 'assistant', historyOverride = null) {
    let textToRender = (typeof rawText === 'string') ? rawText : (rawText?.text || "[内容格式异常]");
    const history = Array.isArray(historyOverride) ? historyOverride : mainRendererReferences.currentChatHistoryRef.get();
    const messageInHistory = history.find(m => m.id === messageId);

    if ((messageInHistory?.role || role) === 'user') {
        textToRender = prepareUserMessageText(textToRender);
    }

    const depth = calculateDepthByTurns(messageId, history);
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
    const effectiveRole = messageInHistory?.role || role;

    if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes)) {
        textToRender = applyFrontendRegexRules(textToRender, agentConfigForRegex.stripRegexes, effectiveRole, depth);
    }

    return { text: textToRender, depth, role: effectiveRole };
}

/**
 * 🟢 独立渲染单个工具结果块为 HTML
 * 从 transformSpecialBlocks 中提取出来，支持工具结果内部的完整 Markdown 渲染
 * （表格、代码围栏等），同时避免与外部 Markdown 解析器产生冲突。
 * @param {string} fullMatch - 完整的工具结果文本（含 [[VCP调用结果信息汇总: ... VCP调用结果结束]] 标记）
 * @returns {string} 渲染后的 HTML
 */
const renderToolResultBlock = (...args) => templateCompiler.renderToolResultBlock(...args);

/**
 * 🟢 在 Markdown 解析后恢复工具结果占位符为渲染好的 HTML
 * @param {string} html - marked.parse() 输出的 HTML
 * @param {Map|null} toolResultMap - 占位符到原始工具结果文本的映射
 * @returns {string} 恢复后的 HTML
 */
const renderToolCallSummaryHtml = (...args) => templateCompiler.renderToolCallSummaryHtml(...args);

const renderToolBatchBody = (...args) => templateCompiler.renderToolBatchBody(...args);

const restoreRenderedToolResults = (...args) => templateCompiler.restoreRenderedToolResults(...args);

// 隐藏图标（Eye-Off：当前正常注入，点击后在上下文中隐藏）
const TOOL_RESULT_HIDE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

// 显示/恢复图标（Eye：当前已被隐藏，点击后恢复注入上下文）
const TOOL_RESULT_SHOW_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;

const TOOL_RESULT_DELETE_ICON = TOOL_RESULT_HIDE_ICON; // 兼容旧引用

/**
 * 切换工具结果的显隐状态（从上下文中隐藏或恢复）。
 */
function handleToolResultDeleteClick(button) {
    const bubble = button.closest('.vcp-tool-result-bubble');
    const messageItem = button.closest('.message-item');
    if (!bubble || !messageItem) return;

    const ordinal = Number.parseInt(bubble.dataset.vcpToolResultIndex, 10);
    const isCurrentlyHidden = button.dataset.vcpHidden === 'true';
    const targetHidden = !isCurrentlyHidden;

    toggleToolResultVisibilityInMessage(
        messageItem,
        Number.isInteger(ordinal) ? ordinal : -1,
        bubble.dataset.vcpToolResultHash || '',
        targetHidden
    );
}

/**
 * 在消息原始内容中切换工具结果的隐藏状态并持久化。
 * 隐藏后其效果与原先垃圾桶删除一致（在发给 AI 的上下文中完全剔除，节省 Token 且不干扰对话），
 * 且具备完全无损性，用户随时可以再次点击恢复注入。
 */
function toggleToolResultVisibilityInMessage(messageItem, ordinal, hash, targetHidden) {
    const notify = (text, type = 'info') => mainRendererReferences.uiHelper?.showToastNotification?.(text, type);
    const messageId = messageItem?.dataset?.messageId;
    if (!messageId) return false;

    if (
        messageItem.classList.contains('streaming')
        || messageItem.classList.contains('thinking')
        || streamManager.isMessageActive?.(messageId)
    ) {
        notify('消息仍在生成中，暂时无法修改工具结果状态', 'warning');
        return false;
    }

    const history = [...mainRendererReferences.currentChatHistoryRef.get()];
    const messageIndex = history.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
        notify('未在历史记录中找到该消息', 'error');
        return false;
    }

    const message = history[messageIndex];
    const isTextObject = !!message.content && typeof message.content === 'object' && typeof message.content.text === 'string';
    const content = typeof message.content === 'string' ? message.content : (isTextObject ? message.content.text : null);
    if (typeof content !== 'string') {
        notify('消息内容格式异常，无法修改工具结果状态', 'error');
        return false;
    }

    const matches = collectClosedToolResultRanges(content).map((range, index) => {
        const raw = content.slice(range.start, range.end);
        return {
            start: range.start,
            end: range.end,
            ordinal: index,
            hash: hashStringFNV1a(raw),
            raw
        };
    });

    let target = null;
    const hashMatches = hash ? matches.filter(item => item.hash === hash) : [];
    if (hashMatches.length > 0) {
        target = hashMatches.reduce((best, cur) =>
            Math.abs(cur.ordinal - ordinal) < Math.abs(best.ordinal - ordinal) ? cur : best);
    } else if (ordinal >= 0 && ordinal < matches.length) {
        target = matches[ordinal];
    }

    if (!target) {
        notify('未能在原始内容中定位该工具结果', 'error');
        return false;
    }

    const updatedRawBlock = setToolResultHidden(target.raw, targetHidden);
    const newText = content.slice(0, target.start) + updatedRawBlock + content.slice(target.end);

    const updatedMessage = {
        ...message,
        content: isTextObject ? { ...message.content, text: newText } : newText
    };
    history[messageIndex] = updatedMessage;
    mainRendererReferences.currentChatHistoryRef.set(history);
    messageItem._vcpMessageModel = updatedMessage;

    const selectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const topicId = mainRendererReferences.currentTopicIdRef.get();
    if (selectedItem?.id && topicId && mainRendererReferences.historyMutationAuthority) {
        void mainRendererReferences.historyMutationAuthority.mutate({
            itemId: selectedItem.id,
            itemType: selectedItem.type,
            topicId,
            category: targetHidden ? 'tool-result-hide' : 'tool-result-show',
        }, latest => {
            const index = latest.findIndex(item => item.id === messageId);
            if (index < 0) throw new Error('消息已删除，请刷新');
            if (JSON.stringify(latest[index].content) !== JSON.stringify(message.content)) {
                throw new Error('消息内容已变化，请刷新后重试');
            }
            latest[index] = { ...latest[index], content: updatedMessage.content };
            return latest;
        }).catch(error => {
            console.error('[MessageRenderer] Failed to persist tool result visibility state:', error);
            notify('工具结果状态已更新，但保存历史失败', 'error');
        });
    }

    updateMessageContent(messageId, updatedMessage.content);
    if (targetHidden) {
        notify('已在上下文中隐藏此工具结果（不会注入给后续AI）', 'success');
    } else {
        notify('已恢复此工具结果，后续对话将重新包含此上下文', 'success');
    }
    return true;
}

// 保留旧函数名作为兼容别名
function removeToolResultFromMessage(messageItem, ordinal, hash) {
    return toggleToolResultVisibilityInMessage(messageItem, ordinal, hash, true);
}

/**
 * 🟢 在 Markdown 文本中修复表情包URL
 * 处理 ![alt](url) 和 <img src="url"> 两种形式
 */
function fixEmoticonUrlsInMarkdown(text) {
    if (!text || typeof text !== 'string') return text;

    // 1. 修复 Markdown 图片语法: ![alt](url)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        if (emoticonUrlFixer && emoticonUrlFixer.fixEmoticonUrl) {
            const fixedUrl = emoticonUrlFixer.fixEmoticonUrl(url);
            if (fixedUrl !== url) {
                console.debug(`[PreprocessFix] Markdown图片: ${url} → ${fixedUrl}`);
            }
            return `![${alt}](${fixedUrl})`;
        }
        return match;
    });

    // 2. 修复 HTML img 标签: <img src="url" ...>
    text = text.replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, before, url, after) => {
        if (emoticonUrlFixer && emoticonUrlFixer.fixEmoticonUrl) {
            const fixedUrl = emoticonUrlFixer.fixEmoticonUrl(url);
            if (fixedUrl !== url) {
                console.debug(`[PreprocessFix] HTML图片: ${url} → ${fixedUrl}`);
            }
            return `<img${before}src="${fixedUrl}"${after}>`;
        }
        return match;
    });

    return text;
}

/**
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 * @property {number} timestamp
 * @property {string} [id]
 * @property {boolean} [isThinking]
 * @property {Array<{type: string, src: string, name: string}>} [attachments]
 * @property {string} [finishReason]
 * @property {boolean} [isGroupMessage] // New: Indicates if it's a group message
 * @property {string} [agentId] // New: ID of the speaking agent in a group
 * @property {string} [name] // New: Name of the speaking agent in a group (can override default role name)
 * @property {string} [avatarUrl] // New: Specific avatar for this message (e.g. group member)
 * @property {string} [avatarColor] // New: Specific avatar color for this message
 */


/**
 * @typedef {Object} CurrentSelectedItem
 * @property {string|null} id - Can be agentId or groupId
 * @property {'agent'|'group'|null} type
 * @property {string|null} name
 * @property {string|null} avatarUrl
 * @property {object|null} config - Full config of the selected item
 */


let mainRendererReferences = null;


let rendererDisposed = false;
let offscreenWindow = null;
function releaseUnMountedHtml(html) {
    if (typeof html !== 'string') return;
    for (const match of html.matchAll(/data-vcp-lazy-tool-id="([^"]+)"/g)) lazyToolContents.delete(match[1]);
}
let renderWorkerClient = null;

function observeRenderedMessage(item) {
    visibilityOptimizer.observeMessage(item);
    offscreenWindow?.observe(item);
}
function canEvictMessage(item) {
    const id = item.dataset.messageId;
    const content = item.querySelector('.md-content');
    const model = mainRendererReferences.currentChatHistoryRef.get().find(message => message.id === id);
    if (!model || model.isThinking || streamManager.isMessageActive?.(id)
        || item.matches('.streaming, .thinking, .editing')
        || !content || content.dataset.vcpOffscreenReady !== 'true'
        || item.dataset.vcpHeavyActivating === 'true'
        || item.querySelector('textarea, input, select, [contenteditable]:not([contenteditable="false"]), iframe, canvas, video, audio, script, details[open], .preview-mode, .vcp-thought-chain-bubble.expanded, .mermaid-viewer[data-scale]:not([data-scale="1"])')
        || /<\s*(?:script|canvas|iframe|video|audio)\b/i.test(typeof model.content === 'string' ? model.content : model.content?.text || '')
        || item.contains(item.ownerDocument.activeElement)) return false;
    const source = typeof model.content === 'string' ? model.content : model.content?.text || '';
    if (/\son[a-z]+\s*=/i.test(source)) return false;
    if ([content, ...content.querySelectorAll('pre, .mermaid-viewer-viewport')].some(node => node.scrollTop || node.scrollLeft)) return false;
    // Legacy disclosures have no persisted presentation keys. Preserve their state.
    if (content.dataset.vcpToolPresentation === 'legacy' && content.querySelector('.expanded')) return false;
    const selection = item.ownerDocument.defaultView.getSelection?.();
    if (selection && !selection.isCollapsed) {
        for (let i = 0; i < selection.rangeCount; i++) {
            if (selection.getRangeAt(i).intersectsNode(item)) return false;
        }
    }
    return true;
}
function evictMessageContent(item) {
    const content = item.querySelector('.md-content');
    toolPresentation?.capture(content);
    content._vcpRenderRevision = (Number(content._vcpRenderRevision) || 0) + 1;
    delete content.dataset.vcpOffscreenReady;
    delete item._vcp_activateHeavy;
    delete item._vcp_process;
    cleanupMessageDomResources(item, item.dataset.messageId, { preserveShell: true });
}
async function restoreMessageContent(item, isValid) {
    const content = item.querySelector('.md-content');
    const root = item.closest('[data-vcp-projectforge-root]');
    const session = getActiveRenderSessionId(root);
    const revision = content._vcpRenderRevision;
    const model = mainRendererReferences.currentChatHistoryRef.get().find(message => message.id === item.dataset.messageId);
    if (!model) throw new Error('Message no longer belongs to the current projection');
    const prepared = prepareFinalTextForRender(model.id, model.content, model.role);
    let text = prepared.text;
    if (model.role === 'assistant') text = processAssistantScopedHtmlContent(text, item.id, item);
    const valid = () => isValid() && content._vcpRenderRevision === revision && isRenderSessionActive(session);
    const html = await renderHistoryTemplate(text, {
        message: model, settings: mainRendererReferences.globalSettingsRef.get(),
        messageRole: prepared.role, depth: prepared.depth,
    }, root, session, model, valid);
    if (!valid()) { releaseUnMountedHtml(html); return; }
    if (html === null) throw new Error('Render settings changed during offscreen restoration');
    delete item.dataset.vcpHeavyActivated;
    delete content.dataset.vcpHeavyActivated;
    visibilityOptimizer.observeMessage(item);
    await renderPostProcessedHtml(content, html, {
        messageId: model.id, message: model, renderSessionId: session,
        includeAttachments: true, runHeavy: true,
    });
    if (isValid()) visibilityOptimizer.recheckVisibility?.();
}
let templateCompiler = null;

async function renderHistoryTemplate(text, renderOptions, root, session, message, isValid = () => true) {
    const parser = mainRendererReferences.markedInstance;
    // Custom injected parsers/extensions have no cross-thread equivalence contract.
    if (!renderWorkerClient || options.contentProcessor || options.emoticonUrlFixer
        || (mainRendererReferences.flowlockProtocol
            && mainRendererReferences.flowlockProtocol !== mainRendererReferences.realm.flowlockProtocol)
        || parser?.constructor?.name !== 'Marked'
        || parser.defaults?.renderer || parser.defaults?.tokenizer || parser.defaults?.hooks
        || parser.defaults?.walkTokens || parser.defaults?.extensions
        || isContextCheckpoint(message)
        || shouldBypassRenderHtmlCache(text)) {
        return renderMarkdownToHtml(text, renderOptions);
    }
    const key = buildRenderHtmlCacheKey(text, renderOptions);
    const cached = getRenderHtmlCache(key);
    if (cached) {
        renderOptions.workerCompiled = true;
        return hydrateRenderTemplate(cached);
    }
    const settingsIdentity = JSON.stringify(mainRendererReferences.globalSettingsRef.get());
    const selectionIdentity = JSON.stringify(mainRendererReferences.currentSelectedItemRef.get());
    const wasPresent = mainRendererReferences.currentChatHistoryRef.get().some(item => item.id === message.id);
    const originalContent = JSON.stringify(message.content);
    const bridge = mainRendererReferences.pretextBridge;
    const width = root.clientWidth;
    const measure = width > 0 ? bridge?.getMeasurementOptions?.('body', width) || null : null;
    const result = await renderWorkerClient.submit(root, {
        text, settings: { enableAiMessageButtons: renderOptions.settings?.enableAiMessageButtons },
        role: renderOptions.messageRole,
        depth: renderOptions.depth, markdown: parser.defaults,
        flowlock: Boolean(mainRendererReferences.flowlockProtocol),
        emoticons: /!\[|<img\b/i.test(text) ? emoticonUrlFixer.snapshot?.() || [] : [],
        measure,
    });
    const latest = mainRendererReferences.currentChatHistoryRef.get().find(item => item.id === message.id);
    if (rendererDisposed || !isValid() || !isRenderSessionActive(session)
        || settingsIdentity !== JSON.stringify(mainRendererReferences.globalSettingsRef.get())
        || selectionIdentity !== JSON.stringify(mainRendererReferences.currentSelectedItemRef.get())
        || (wasPresent && !latest)
        || (latest && JSON.stringify(latest.content) !== originalContent)) return null;
    if (!result) return renderMarkdownToHtml(text, renderOptions);
    const html = result.isolatedDomains
        ? composeToolBatchHtml(result.parts, part => part, root.ownerDocument)
        : result.parts[0] || '';
    const template = { html, tools: result.tools };
    renderOptions.workerCompiled = true;
    renderOptions.estimatedHeight = result.estimatedHeight;
    renderHtmlCacheStats.misses++;
    setRenderHtmlCache(key, template);
    return hydrateRenderTemplate(template);
}
let contentPipeline = null;
let contentRuntime = null;
let rendererListenerDisposers = [];
let toolPresentation = null;
let chartEmbedHost = null;
function disposeRendererListeners() {
    chartEmbedHost?.dispose();
    chartEmbedHost = null;
    toolPresentation?.dispose();
    toolPresentation = null;
    rendererListenerDisposers.splice(0).reverse().forEach(dispose => { try { dispose(); } catch (error) { console.warn('[MessageRenderer] listener dispose failed:', error); } });
}
function disposeRendererResources() {
    rendererDisposed = true;
    invalidateRenderSession();
    for (const content of [...ownedAnimationContents]) {
        try { cleanupAnimationsInContent(content); } catch (error) { console.warn('[Animation] renderer cleanup failed:', error); }
    }
    offscreenWindow?.destroy();
    renderWorkerClient?.dispose();
    disposeRendererListeners();
    projectForgeTopicSurface.dispose();
    if (mainRendererReferences?.chatMessagesDiv) releaseLazyTools(mainRendererReferences.chatMessagesDiv);
    clearRenderHtmlCache();
    lazyToolContents.clear();
    contentProcessor.dispose?.();
    middleClickHandler.dispose?.();
    contextMenu.dispose?.();
    imageHandler.dispose?.();
    visibilityOptimizer.destroyVisibilityOptimizer?.();

    for (const styleElement of ownedStyleElements) {
        styleElement.remove();
    }
    ownedStyleElements.clear();
    scopedCssCache.clear();
    persistedAvatarColorKeys.clear();
}
async function disposeRootResources(root) {
    if (!root?.querySelectorAll) return;
    projectForgeTopicSurface.clear(root);
    invalidateRenderSession(root);
    await renderTaskOwner.dispose(root);
    root.querySelectorAll('.message-item').forEach(item => cleanupMessageDomResources(item, item.dataset?.messageId || null));
    root.replaceChildren();
}
function ownRendererListener(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    rendererListenerDisposers.push(() => target.removeEventListener(type, handler, options));
}

const renderSessionAuthority = createRenderSessionAuthority({
    resolveDefaultRoot: () => mainRendererReferences?.chatMessagesDiv || null,
});
const renderTaskOwner = createSurfaceTaskOwner();

function invalidateRenderSession(root = null) {
    const ownerRoot = root || mainRendererReferences?.chatMessagesDiv || null;
    if (ownerRoot) {
        // Navigation/teardown must never leave a retained root visually hidden.
        delete ownerRoot.dataset.vcpHistoryPresentation;
        renderWorkerClient?.cancel(ownerRoot);
        renderTaskOwner.revoke(ownerRoot);
    }
    return renderSessionAuthority.invalidate(ownerRoot);
}

function getActiveRenderSessionId(root = null) {
    return renderSessionAuthority.capture(root);
}

function isRenderSessionActive(session) {
    return renderSessionAuthority.isActive(session);
}

function escapeCssAttributeValue(value) {
    const str = String(value);
    const ownerWindow = mainRendererReferences?.window || mainRendererReferences?.chatMessagesDiv?.ownerDocument?.defaultView;
    if (ownerWindow?.CSS && typeof ownerWindow.CSS.escape === 'function') {
        return ownerWindow.CSS.escape(str);
    }
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cleanupScopedStylesForMessage(messageItem, messageId = null) {
    if (!messageItem && !messageId) return;
    const scopeId = messageItem?.id;
    const chatScopeId = messageItem?.getAttribute?.('data-chat-scope') || (messageId ? `vcp-${surfaceId}-chat-${messageId}` : null);
    scopedCssCache.delete(scopeId);
    for (const styleElement of ownedStyleElements) {
        if ((styleElement.getAttribute('data-vcp-surface-id') === surfaceId)
            && ((scopeId && styleElement.getAttribute('data-vcp-scope-id') === scopeId)
                || (chatScopeId && styleElement.getAttribute('data-chat-scope-id') === chatScopeId))) {
            styleElement.remove();
            ownedStyleElements.delete(styleElement);
        }
    }
}

function cleanupToolResultFullContentForRoot(root) {
    root?.querySelectorAll?.('.vcp-tool-result-truncated-notice[data-content-id]').forEach(notice => {
        const contentId = Number.parseInt(notice.dataset.contentId, 10);
        if (Number.isInteger(contentId)) toolResultFullContentMap.delete(contentId);
    });
}

function cleanupMessageDomResources(messageItem, messageId = null, cleanupOptions = {}) {
    if (!messageItem) return;
    const release = action => {
        try { action(); } catch (error) { console.warn('[MessageRenderer] resource cleanup failed:', error); }
    };
    const contentDiv = messageItem.querySelector('.md-content');
    release(() => cleanupAnimationsInContent(contentDiv));
    if (!cleanupOptions.preserveShell) release(() => offscreenWindow?.unobserve(messageItem));
    release(() => releaseLazyTools(messageItem));
    release(() => cleanupToolResultFullContentForRoot(messageItem));
    if (contentDiv) {
        release(() => chartEmbedHost?.beforeReplace(contentDiv));
        release(() => imageHandler.cleanupContent?.(contentDiv));
        if (contentDiv._vcpDeferredHighlightTimer) {
            contentDiv.ownerDocument.defaultView.clearTimeout(contentDiv._vcpDeferredHighlightTimer);
            delete contentDiv._vcpDeferredHighlightTimer;
        }
        release(() => cancelPretextEstimate(contentDiv));
        release(() => cleanupMermaidViewers(contentDiv));
        release(() => contentProcessor.cleanupPreviewsInContent(contentDiv));
        contentDiv.querySelectorAll('[data-vcp-attachment-cleanup], .message-attachment-wrapper *').forEach(node => {
            release(() => node._vcpAttachmentCleanup?.());
            delete node._vcpAttachmentCleanup;
        });
        release(() => cleanupChatMedia(contentDiv));
    }
    if (!cleanupOptions.preserveShell) release(() => cleanupScopedStylesForMessage(messageItem, messageId || messageItem.dataset?.messageId || null));
    const ownedMessageId = messageId || messageItem.dataset?.messageId || null;
    if (ownedMessageId) release(() => mainRendererReferences?.pretextBridge?.evict?.(ownedMessageId));
    release(() => visibilityOptimizer.unobserveMessage(messageItem));
}

function removeMessageById(messageId, saveHistory = false, root = mainRendererReferences.chatMessagesDiv) {
    projectForgeTopicSurface.remove(root, messageId);
    const item = root?.querySelector?.(`.message-item[data-message-id="${messageId}"]`);
    if (item) {
        // --- NEW: Cleanup dynamic content before removing from DOM ---
        cleanupMessageDomResources(item, messageId);
        // [Pretext集成] 释放高度缓存，防止内存泄漏
        if (mainRendererReferences.pretextBridge?.evict) {
            mainRendererReferences.pretextBridge.evict(messageId);
        }
        item.remove();
    }

    const currentChatHistoryArray = [...mainRendererReferences.currentChatHistoryRef.get()];
    const index = currentChatHistoryArray.findIndex(m => m.id === messageId);

    if (index > -1) {
        currentChatHistoryArray.splice(index, 1);
        mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray);
        mainRendererReferences.messageCommands.updateSendButtonState?.();

        if (saveHistory) {
            const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
            const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();
            if (currentSelectedItemVal.id && currentTopicIdVal) {
                void mainRendererReferences.historyMutationAuthority?.mutate({
                    itemId: currentSelectedItemVal.id,
                    itemType: currentSelectedItemVal.type,
                    topicId: currentTopicIdVal,
                    category: 'message-remove',
                }, latest => latest.filter(message => message.id !== messageId))
                    .catch(error => {
                        console.error('[MessageRenderer] history mutation failed:', error);
                        mainRendererReferences.uiHelper?.showToastNotification?.('消息删除未保存，请刷新后重试', 'error');
                    });
            }
        }
    }
}

function clearChat(root = mainRendererReferences.chatMessagesDiv) {
    projectForgeTopicSurface.clear(root);
    invalidateRenderSession(root);
    chartEmbedHost?.clear();
    mainRendererReferences.uiHelper.resetChatScrollFollow?.();

    // Topic switches revoke mounted resources, not reusable templates. The bounded
    // cache survives navigation and is cleared explicitly or on renderer disposal.

    // 只清理当前视图的 DOM/渲染相关内容，不触碰底层异步流状态
    // 这样可避免切换话题时误伤同窗口内其他 agent 的后台流式聊天
    lazyToolContents.clear();
    toolResultFullContentMap.clear();
    toolResultContentIdCounter = 0;

    if (root) {
        // --- NEW: Cleanup all messages before clearing the container ---
        const allMessages = root.querySelectorAll('.message-item');
        allMessages.forEach(item => {
            cleanupMessageDomResources(item, item.dataset?.messageId || null);
        });

        root.innerHTML = '';
    }
    mainRendererReferences.currentChatHistoryRef.set([]); // Clear the history array via its ref
    mainRendererReferences.messageCommands.updateSendButtonState?.();
}


function initializeMessageRenderer(refs) {
    rendererDisposed = false;
    disposeRendererListeners();
    // Re-injection may replace Markdown/Flowlock dependencies.
    clearRenderHtmlCache();
    mainRendererReferences = createRenderDependencies(refs);
    renderWorkerClient?.dispose();
    const WorkerClass = mainRendererReferences.realm.Worker;
    renderWorkerClient = options.enableRenderWorker === false ? null : createRenderWorkerClient({
        createWorker: options.createRenderWorker || (WorkerClass
            ? () => new WorkerClass(new URL('./renderer/renderWorker.js', import.meta.url), { type: 'module' })
            : null),
    });
    chartEmbedHost = createChartEmbedHost({
        root: mainRendererReferences.chatMessagesDiv,
        api: mainRendererReferences.electronAPI,
    });
    mainRendererReferences.chatMessagesDiv.setAttribute('data-vcp-projectforge-root', '');
    projectForgeTopicSurface.replaceHistory(mainRendererReferences.chatMessagesDiv, mainRendererReferences.currentChatHistoryRef.get());

    templateCompiler = createRenderTemplateCompiler({ mainRendererReferences, contentProcessor, fixEmoticonUrlsInMarkdown, deferToolRequest, registerLazyTool, toolResultFullContentMap });
    contentPipeline = templateCompiler;
    contentRuntime = createContentRuntime({ pipeline: { process: (text, options) => ({ text: templateCompiler.processStream(text), state: {} }) } });

    imageHandler.initialize({
        electronAPI: mainRendererReferences.electronAPI,
        uiHelper: mainRendererReferences.uiHelper,
        chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
         document: mainRendererReferences.document || mainRendererReferences.chatMessagesDiv?.ownerDocument,
         window: mainRendererReferences.window || mainRendererReferences.chatMessagesDiv?.ownerDocument?.defaultView,
         hljs: mainRendererReferences.hljs,
    });

    // Start the emoticon fixer initialization, but don't wait for it here.
    // The await will happen inside renderMessage to ensure it's ready before rendering.
    emoticonUrlFixer.initialize(mainRendererReferences.electronAPI);

    // 初始化可见性优化器
    // 🟢 关键修复：IntersectionObserver 的 root 必须是产生滚动条的那个父容器
    const scrollContainer = mainRendererReferences.chatMessagesDiv.closest('.chat-messages-container');
    visibilityOptimizer.initializeVisibilityOptimizer(scrollContainer || mainRendererReferences.chatMessagesDiv);
    offscreenWindow?.destroy();
    offscreenWindow = options.enableOffscreenEviction === false ? null : createOffscreenDomWindow({
        canEvict: canEvictMessage, evict: evictMessageContent, restore: restoreMessageContent,
    });
    offscreenWindow?.initialize(scrollContainer || mainRendererReferences.chatMessagesDiv);


    toolPresentation = createToolPresentation({
        root: mainRendererReferences.chatMessagesDiv,
        getLocalConfig: () => {
            const item = mainRendererReferences.currentSelectedItemRef.get();
            return item?.config || item;
        },
        getProfile: () => {
            const appearance = mainRendererReferences.realm?.VCPAppearance;
            return appearance?.getCurrent?.()
                || appearance?.normalize?.(mainRendererReferences.globalSettingsRef.get().appearanceProfile, 'next');
        }
    });

    // --- Event Delegation ---
    ownRendererListener(mainRendererReferences.chatMessagesDiv, 'click', (e) => {
        // 0. 工具结果删除按钮（位于 header 内，必须先于折叠逻辑处理）
        const toolResultDeleteBtn = e.target.closest('.vcp-tool-result-delete-btn');
        if (toolResultDeleteBtn) {
            e.preventDefault();
            e.stopPropagation();
            handleToolResultDeleteClick(toolResultDeleteBtn);
            return;
        }

        // 1. Handle collapsible tool calls, tool results and thought chains
        const toolSummary = e.target.closest('.vcp-tool-summary');
        if (toolSummary) {
            const bubble = toolSummary.closest('.vcp-tool-use-bubble');
            if (bubble) {
                if (bubble._vcpMountTool) {
                    const expanded = !bubble.classList.contains('expanded');
                    bubble.classList.toggle('expanded', expanded);
                    bubble._vcpMountTool(expanded);
                    return;
                }
                const details = bubble.querySelector(':scope > .vcp-tool-details');
                const template = bubble.querySelector(':scope > .vcp-tool-details-template');
                const willExpand = !bubble.classList.contains('expanded');

                if (willExpand) {
                    // 真正的懒挂载：折叠态不让完整工具载荷进入活动布局树。
                    if (details && template?.content && details.childNodes.length === 0) {
                        details.appendChild(template.content.cloneNode(true));
                    }
                    bubble.classList.add('expanded');
                } else {
                    bubble.classList.remove('expanded');
                    // 收起后释放活动 DOM；原始载荷仍安全保存在 inert template 中。
                    details?.replaceChildren();
                }
            }
            return;
        }

        const toolHeader = e.target.closest('.vcp-tool-result-header');
        if (toolHeader) {
            const bubble = toolHeader.closest('.vcp-tool-result-bubble.collapsible');
            if (bubble) {
                bubble.classList.toggle('expanded');
                bubble._vcpMountTool?.(bubble.classList.contains('expanded'));
            }
            return;
        }

        const thoughtHeader = e.target.closest('.vcp-thought-chain-header');
        if (thoughtHeader) {
            const bubble = thoughtHeader.closest('.vcp-thought-chain-bubble.collapsible');
            if (bubble) {
                bubble.classList.toggle('expanded');
            }
            return;
        }

        // 🟢 3. Handle "展开全部" button for truncated tool results
        const truncatedNotice = e.target.closest('.vcp-tool-result-truncated-notice');
        if (truncatedNotice) {
            const contentId = parseInt(truncatedNotice.dataset.contentId, 10);
            const fullData = toolResultFullContentMap.get(contentId);
            if (fullData) {
                // 找到对应的 markdown-content 容器（紧邻的前一个兄弟元素）
                const markdownContainer = truncatedNotice.previousElementSibling;
                if (markdownContainer && markdownContainer.classList.contains('vcp-tool-result-markdown-content')) {
                    // 渲染完整内容
                    const fullHtml = renderSafeToolResultMarkdown(fullData.raw);
                    if (TOOL_RESULT_DANGEROUS_HTML_REGEX.test(fullData.raw)) {
                        markdownContainer.classList.add('vcp-tool-result-markdown-content--sealed-html');
                    }
                    markdownContainer.innerHTML = fullHtml;
                    // 移除按钮
                    truncatedNotice.remove();
                    // 释放缓存
                    toolResultFullContentMap.delete(contentId);
                }
            }
            return;
        }

        // 4. Avatar 点击停止 TTS（也使用委托）。
        // createMessageSkeleton 当前使用 .chat-avatar；保留 .message-avatar
        // 兼容旧 DOM，避免出现头像动画正常但点击无法停止的情况。
        const avatar = e.target.closest('.chat-avatar, .message-avatar');
        if (avatar) {
            const messageItem = avatar.closest('.message-item');
            if (
                messageItem?.dataset.role === 'assistant'
                || messageItem?.classList.contains('assistant')
                || messageItem?.classList.contains('agent')
            ) {
                mainRendererReferences.electronAPI.sovitsStop();
            }
        }
    });

    // Delegated context menu
    if (features.contextMenu) ownRendererListener(mainRendererReferences.chatMessagesDiv, 'contextmenu', (e) => {
        const messageItem = e.target.closest('.message-item');
        if (!messageItem) return;

        const messageId = messageItem.dataset.messageId;
        // 历史数组可能正被 JEV 文件同步原子替换。气泡自身保存其渲染模型，
        // 使右键交互不依赖某一瞬间的外部状态命中；历史仍是菜单修改操作的权威。
        const message = mainRendererReferences.currentChatHistoryRef.get()
            .find(m => m.id === messageId)
            || messageItem._vcpMessageModel;

        if (message && (message.role === 'assistant' || message.role === 'user')) {
            e.preventDefault();
            contextMenu.showContextMenu(e, messageItem, message);
        }
    });

    // Delegated middle mouse button click
    if (features.middleClick) ownRendererListener(mainRendererReferences.chatMessagesDiv, 'mousedown', (e) => {
        if (e.button !== 1) return; // 只处理中键

        const messageItem = e.target.closest('.message-item');
        if (!messageItem) return;

        const messageId = messageItem.dataset.messageId;
        const message = mainRendererReferences.currentChatHistoryRef.get()
            .find(m => m.id === messageId);

        if (message && (message.role === 'assistant' || message.role === 'user')) {
            e.preventDefault();
            e.stopPropagation();

            const globalSettings = mainRendererReferences.globalSettingsRef.get();
            if (globalSettings.enableMiddleClickQuickAction) {
                middleClickHandler.startMiddleClickTimer(e, messageItem, message, globalSettings.middleClickQuickAction);

                if (globalSettings.enableMiddleClickAdvanced) {
                    const delay = Math.max(1000, globalSettings.middleClickAdvancedDelay || 1000);
                    middleClickHandler.startAdvancedMiddleClickTimer(e, messageItem, message, globalSettings);
                }
            }
        }
    });
    // --- End Event Delegation ---

    contentProcessor.initializeContentProcessor(mainRendererReferences);

    const wrappedProcessRenderedContent = (contentDiv) => {
        const globalSettings = mainRendererReferences.globalSettingsRef.get();
        contentProcessor.processRenderedContent(contentDiv, globalSettings);
    };

    if (features.contextMenu) contextMenu.initializeContextMenu(mainRendererReferences, {
        removeMessageById: removeMessageById,
        renderMessage: renderMessage,
        startStreamingMessage: mainRendererReferences.streamStartCapability || streamManager.startStreamingMessage,
        startStream: mainRendererReferences.streamStartCapability,
        cancelStream: mainRendererReferences.cancelStreamCapability,
        cancelStreamAdmissionRelay: mainRendererReferences.cancelStreamAdmissionRelay,
        discardStreamingMessage: streamManager.discardStreamingMessage,
        setContentAndProcessImages: imageHandler.setContentAndProcessImages,
        processRenderedContent: wrappedProcessRenderedContent,
        runTextHighlights: contentProcessor.highlightAllPatternsInMessage,
        preprocessFullContent: preprocessFullContent,
        renderAttachments: renderAttachments,
        interruptHandler: mainRendererReferences.interruptHandler,
        showForwardModal: mainRendererReferences.showForwardModal,
        ensureAudioContext: mainRendererReferences.ensureAudioContext,
        updateMessageContent: updateMessageContent, // 🟢 新增：传递 updateMessageContent
        extractSpeakableTextFromContentElement: extractSpeakableTextFromContentElement,
    });

    if (features.streamProjection) streamManager.attachStreamProjection({
        chatDomRenderer: mainRendererReferences.chatDomRenderer,
        globalSettingsRef: mainRendererReferences.globalSettingsRef,
        currentChatHistoryRef: mainRendererReferences.currentChatHistoryRef,
        currentSelectedItemRef: mainRendererReferences.currentSelectedItemRef,
        currentTopicIdRef: mainRendererReferences.currentTopicIdRef,
        transientStreamHistory: mainRendererReferences.transientStreamHistory,
        viewAuthority: {
            isCurrent: context => {
                const selected = mainRendererReferences.currentSelectedItemRef.get();
                const topicId = mainRendererReferences.currentTopicIdRef.get();
                const itemId = context?.groupId || context?.agentId;
                return Boolean(selected?.id && topicId && itemId === selected.id && context?.topicId === topicId);
            }
        },
        chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
        parseTail: parseStreamTailMarkdown,
        parseFull: parseFullMarkdown,
        prepareFinalTextForRender: prepareFinalTextForRender,
        renderMermaidDiagrams: renderMermaidDiagrams,
        electronAPI: mainRendererReferences.electronAPI,
        uiHelper: mainRendererReferences.uiHelper,
        morphdom: mainRendererReferences.morphdom,
        renderMessage: renderMessage,
        showContextMenu: contextMenu.showContextMenu,
        setContentAndProcessImages: imageHandler.setContentAndProcessImages,
        processRenderedContent: wrappedProcessRenderedContent,
        runTextHighlights: contentProcessor.highlightAllPatternsInMessage,
        preprocessFullContent: preprocessFullContent,
        processAssistantScopedHtmlContent,
        cleanupStreamContent: contentDiv => {
            cleanupAnimationsInContent(contentDiv);
            releaseLazyTools(contentDiv);
            cleanupToolResultFullContentForRoot(contentDiv);
            contentProcessor.cleanupPreviewsInContent(contentDiv);
            imageHandler.cleanupContent?.(contentDiv);
        },
        observeStreamSource: (content, messageItem) => {
            const root = messageItem.closest('[data-vcp-projectforge-root]') || mainRendererReferences.chatMessagesDiv;
            projectForgeTopicSurface.observe(root, { id: messageItem.dataset.messageId, role: 'assistant', content });
        },
        updateStreamScopedCss: (chunks, scopeId, messageItem) => {
            const css = chunks.filter(Boolean).join('\n');
            if (css) processAndInjectScopedCss('', scopeId, { scopedCssOverride: css, messageItem });
            else removeOwnedMessageScopeStyle(scopeId);
        },
        findToolRequestEnd: (text, startIndex) => findToolRequestEnd(text, startIndex),
        removeSpeakerTags: contentProcessor.removeSpeakerTags,
        ensureNewlineAfterCodeBlock: contentProcessor.ensureNewlineAfterCodeBlock,
        ensureSpaceAfterTilde: contentProcessor.ensureSpaceAfterTilde,
        removeIndentationFromCodeBlockMarkers: contentProcessor.removeIndentationFromCodeBlockMarkers,
        deIndentMisinterpretedCodeBlocks: contentProcessor.deIndentMisinterpretedCodeBlocks, // 🟢 传递新函数
        processStartEndMarkers: contentProcessor.processStartEndMarkers, // 🟢 传递安全处理函数
        ensureSeparatorBetweenImgAndCode: contentProcessor.ensureSeparatorBetweenImgAndCode,
        processAnimationsInContent: contentDiv => processAnimationsInContent(contentDiv, visibilityOptimizer),
        renderPostProcessedHtml: renderPostProcessedHtml,
        emoticonUrlFixer: emoticonUrlFixer, // 🟢 Pass emoticon fixer for live updates
        enhancedRenderDebounceTimers: enhancedRenderDebounceTimers,
        ENHANCED_RENDER_DEBOUNCE_DELAY: ENHANCED_RENDER_DEBOUNCE_DELAY,
        DIARY_RENDER_DEBOUNCE_DELAY: DIARY_RENDER_DEBOUNCE_DELAY,
    });

    if (features.middleClick) middleClickHandler.initialize(mainRendererReferences, {
        removeMessageById: removeMessageById,
        streamManager,
        toggleEditMode: contextMenu.toggleEditMode,
        handleRegenerateResponse: contextMenu.handleRegenerateResponse,
        showForwardModal: mainRendererReferences.showForwardModal,
        ensureAudioContext: mainRendererReferences.ensureAudioContext,
        extractSpeakableTextFromContentElement,
    });

    // --- 用户气泡文件拖拽支持 ---
    ownRendererListener(mainRendererReferences.chatMessagesDiv, 'dragover', (e) => {
        const messageItem = e.target.closest('.message-item.user');
        if (!messageItem) return;

        const mdContent = messageItem.querySelector('.md-content');
        if (!mdContent) return;

        e.preventDefault();
        e.stopPropagation();

        // 关键修复：显式设置 dropEffect 允许外部文件放置
        e.dataTransfer.dropEffect = 'copy';

        if (!mdContent.classList.contains('drag-over')) {
            console.debug(`[MessageRenderer] Dragover detected on message ${messageItem.dataset.messageId}`);
            mdContent.classList.add('drag-over');
        }
    });

    ownRendererListener(mainRendererReferences.chatMessagesDiv, 'dragleave', (e) => {
        const messageItem = e.target.closest('.message-item.user');
        if (!messageItem) return;

        const mdContent = messageItem.querySelector('.md-content');
        if (!mdContent) return;

        // 仅当鼠标真正离开该容器（而不是进入了它的子元素）时才移除类
        const rect = mdContent.getBoundingClientRect();
        if (e.clientX <= rect.left || e.clientX >= rect.right || e.clientY <= rect.top || e.clientY >= rect.bottom) {
            mdContent.classList.remove('drag-over');
        }
    });

    ownRendererListener(mainRendererReferences.chatMessagesDiv, 'drop', async (e) => {
        const messageItem = e.target.closest('.message-item.user');
        if (!messageItem) return;

        const mdContent = messageItem.querySelector('.md-content');
        if (!mdContent) return;

        e.preventDefault();
        e.stopPropagation();
        mdContent.classList.remove('drag-over');

        const messageId = messageItem.dataset.messageId;
        const files = e.dataTransfer.files;

        console.log(`[MessageRenderer] Drop detected on message ${messageId}. Files count: ${files?.length || 0}`);

        if (files && files.length > 0) {
            if (mainRendererReferences.messageCommands.processFilesData) {
                // 使用通用的文件读取管线
                const processedFiles = await mainRendererReferences.messageCommands.processFilesData(files);
                const successfulFiles = processedFiles.filter(f => !f.error);

                if (successfulFiles.length > 0) {
                    mainRendererReferences.messageCommands.addAttachmentsToMessage(messageId, successfulFiles);
                } else if (processedFiles.length > 0) {
                    const firstError = processedFiles.find(f => f.error)?.error;
                    console.error(`[MessageRenderer] All files failed to process: ${firstError}`);
                    if (mainRendererReferences.uiHelper?.showToastNotification) {
                        mainRendererReferences.uiHelper.showToastNotification(`读取文件失败: ${firstError}`, 'error');
                    }
                }
            } else {
                console.error('[MessageRenderer] chat manager file capability is unavailable.');
            }
        }
    });

    injectEnhancedStyles();
    console.log("[MessageRenderer] Initialized. Current selected item type on init:", mainRendererReferences.currentSelectedItemRef.get()?.type);
}


function setCurrentSelectedItem(item) {
    // This function is mainly for renderer.js to update the shared state.
    // messageRenderer will read from currentSelectedItemRef.get() when rendering.
    // console.log("[MessageRenderer] setCurrentSelectedItem called with:", item);
}

function setCurrentTopicId(topicId) {
    // console.log("[MessageRenderer] setCurrentTopicId called with:", topicId);
}

// These are for specific avatar of the current *context* (agent or user), not for individual group member messages
function setCurrentItemAvatar(avatarUrl) { // Renamed from setCurrentAgentAvatar
    // This updates the avatar for the main selected agent/group, not individual group members in a message.
    // The currentSelectedItemRef should hold the correct avatar for the overall context.
}

function setUserAvatar(avatarUrl) { // For the user's global avatar
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const oldUrl = globalSettings.userAvatarUrl;
    if (oldUrl && oldUrl !== (avatarUrl || 'assets/default_user_avatar.png')) {
        avatarColorCache.delete(oldUrl.split('?')[0]);
    }
    mainRendererReferences.globalSettingsRef.set({ ...globalSettings, userAvatarUrl: avatarUrl || 'assets/default_user_avatar.png' });
}

function setCurrentItemAvatarColor(color) { // Renamed from setCurrentAgentAvatarColor
    // For the main selected agent/group
}

function setUserAvatarColor(color) { // For the user's global avatar
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    mainRendererReferences.globalSettingsRef.set({ ...globalSettings, userAvatarCalculatedColor: color });
}
function formatAudioTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
        : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function getAudioDisplayName(audio) {
    if (audio.dataset.audioTitle) return audio.dataset.audioTitle;

    const source = audio.currentSrc || audio.getAttribute('src') || audio.querySelector('source')?.src || '';
    if (!source) return '音频';

    try {
        const ownerWindow = audio.ownerDocument?.defaultView;
        const url = new URL(source, ownerWindow?.location?.href || 'about:blank');
        const fileName = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
        return fileName || '音频';
    } catch (error) {
        return source.split(/[\\/]/).pop()?.split('?')[0] || '音频';
    }
}

function createAudioControlButton(ownerDocument, className, label, iconMarkup) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.className = `vcp-audio-button ${className}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = iconMarkup;
    return button;
}

function enhanceAudioPlayers(container) {
    if (!container) return;
    const ownerDocument = container.ownerDocument;
    if (!ownerDocument) return;

    const playIcon = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.7v12.6a1 1 0 0 0 1.53.85l9.2-6.3a1 1 0 0 0 0-1.7l-9.2-6.3A1 1 0 0 0 8 5.7Z"></path>
        </svg>`;
    const pauseIcon = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 5.5A1.5 1.5 0 0 1 8.5 4h1A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-1A1.5 1.5 0 0 1 7 18.5v-13Zm6 0A1.5 1.5 0 0 1 14.5 4h1A1.5 1.5 0 0 1 17 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-1a1.5 1.5 0 0 1-1.5-1.5v-13Z"></path>
        </svg>`;
    const volumeIcon = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9.5v5A1.5 1.5 0 0 0 5.5 16H8l4.2 3.15A.5.5 0 0 0 13 18.75V5.25a.5.5 0 0 0-.8-.4L8 8H5.5A1.5 1.5 0 0 0 4 9.5Zm12.2-.7a1 1 0 0 1 1.4 0 4.5 4.5 0 0 1 0 6.4 1 1 0 1 1-1.4-1.4 2.5 2.5 0 0 0 0-3.6 1 1 0 0 1 0-1.4Zm2.65-2.65a1 1 0 0 1 1.4 0 8.25 8.25 0 0 1 0 11.7 1 1 0 0 1-1.4-1.4 6.25 6.25 0 0 0 0-8.9 1 1 0 0 1 0-1.4Z"></path>
        </svg>`;
    const mutedIcon = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9.5v5A1.5 1.5 0 0 0 5.5 16H8l4.2 3.15a.5.5 0 0 0 .8-.4V5.25a.5.5 0 0 0-.8-.4L8 8H5.5A1.5 1.5 0 0 0 4 9.5Zm12.3.1a1 1 0 0 1 1.4 0l1.3 1.3 1.3-1.3a1 1 0 1 1 1.4 1.4l-1.3 1.3 1.3 1.3a1 1 0 0 1-1.4 1.4L19 13.7 17.7 15a1 1 0 0 1-1.4-1.4l1.3-1.3-1.3-1.3a1 1 0 0 1 0-1.4Z"></path>
        </svg>`;
    const downloadIcon = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.4l2.3 2.3V4a1 1 0 0 1 1-1ZM5 18a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v1.5A1.5 1.5 0 0 1 18.5 22h-13A1.5 1.5 0 0 1 4 20.5V19a1 1 0 0 1 1-1Z"></path>
        </svg>`;

    container.querySelectorAll('audio[controls]:not([data-vcp-audio-enhanced])').forEach((audio) => {
        audio.dataset.vcpAudioEnhanced = 'true';
        audio.classList.add('vcp-audio-native');

        const player = ownerDocument.createElement('div');
        player.className = 'vcp-audio-player';
        player.setAttribute('role', 'group');
        player.setAttribute('aria-label', `音频播放器：${getAudioDisplayName(audio)}`);

        const playButton = createAudioControlButton(ownerDocument, 'vcp-audio-play', '播放', playIcon);
        const content = ownerDocument.createElement('div');
        content.className = 'vcp-audio-content';

        const header = ownerDocument.createElement('div');
        header.className = 'vcp-audio-header';
        const title = ownerDocument.createElement('span');
        title.className = 'vcp-audio-title';
        title.textContent = getAudioDisplayName(audio);
        title.title = title.textContent;
        const time = ownerDocument.createElement('span');
        time.className = 'vcp-audio-time';
        time.textContent = '0:00 / 0:00';
        header.append(title, time);

        const progress = ownerDocument.createElement('input');
        progress.type = 'range';
        progress.className = 'vcp-audio-range vcp-audio-progress';
        progress.min = '0';
        progress.max = '100';
        progress.step = 'any';
        progress.value = '0';
        progress.setAttribute('aria-label', '播放进度');

        const actions = ownerDocument.createElement('div');
        actions.className = 'vcp-audio-actions';
        const muteButton = createAudioControlButton(ownerDocument, 'vcp-audio-mute', '静音', volumeIcon);
        const volume = ownerDocument.createElement('input');
        volume.type = 'range';
        volume.className = 'vcp-audio-range vcp-audio-volume';
        volume.min = '0';
        volume.max = '1';
        volume.step = '0.05';
        volume.value = String(audio.volume);
        volume.setAttribute('aria-label', '音量');

        const download = ownerDocument.createElement('a');
        download.className = 'vcp-audio-button vcp-audio-download';
        download.href = audio.currentSrc || audio.getAttribute('src') || audio.querySelector('source')?.src || '#';
        download.download = title.textContent;
        download.target = '_blank';
        download.rel = 'noopener noreferrer';
        download.setAttribute('aria-label', '下载音频');
        download.title = '下载音频';
        download.innerHTML = downloadIcon;

        actions.append(muteButton, volume, download);
        content.append(header, progress, actions);

        const parent = audio.parentNode;
        parent.insertBefore(player, audio);
        player.append(audio, playButton, content);
        audio.controls = false;
        audio.preload = audio.preload || 'metadata';

        const setRangeFill = (range, value) => {
            range.style.setProperty('--vcp-range-value', `${Math.max(0, Math.min(100, value))}%`);
        };
        const updateProgress = () => {
            const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
            const ratio = duration > 0 ? (audio.currentTime / duration) * 100 : 0;
            progress.value = String(ratio);
            progress.setAttribute('aria-valuetext', `${formatAudioTime(audio.currentTime)} / ${formatAudioTime(duration)}`);
            time.textContent = `${formatAudioTime(audio.currentTime)} / ${formatAudioTime(duration)}`;
            setRangeFill(progress, ratio);
        };

        let progressAnimationFrame = null;
        const stopSmoothProgress = () => {
            if (progressAnimationFrame !== null) {
                if (ownerDocument.defaultView?.cancelAnimationFrame) {
                    ownerDocument.defaultView.cancelAnimationFrame(progressAnimationFrame);
                } else {
                    ownerDocument.defaultView?.clearTimeout?.(progressAnimationFrame);
                }
                progressAnimationFrame = null;
            }
        };
        const animateSmoothProgress = () => {
            updateProgress();
            if (!audio.paused && !audio.ended && player.isConnected) {
                progressAnimationFrame = ownerDocument.defaultView?.requestAnimationFrame?.(animateSmoothProgress)
                    ?? ownerDocument.defaultView?.setTimeout?.(() => animateSmoothProgress(Date.now()), 0);
            } else {
                progressAnimationFrame = null;
            }
        };
        const startSmoothProgress = () => {
            if (progressAnimationFrame === null) {
                progressAnimationFrame = ownerDocument.defaultView?.requestAnimationFrame?.(animateSmoothProgress)
                    ?? ownerDocument.defaultView?.setTimeout?.(() => animateSmoothProgress(Date.now()), 0);
            }
        };

        const updateVolume = () => {
            const effectiveVolume = audio.muted ? 0 : audio.volume;
            volume.value = String(effectiveVolume);
            setRangeFill(volume, effectiveVolume * 100);
            muteButton.innerHTML = effectiveVolume === 0 ? mutedIcon : volumeIcon;
            muteButton.setAttribute('aria-label', effectiveVolume === 0 ? '取消静音' : '静音');
            muteButton.title = effectiveVolume === 0 ? '取消静音' : '静音';
        };
        const updatePlaybackState = () => {
            const isPlaying = !audio.paused && !audio.ended;
            player.classList.toggle('is-playing', isPlaying);
            playButton.innerHTML = isPlaying ? pauseIcon : playIcon;
            playButton.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
            playButton.title = isPlaying ? '暂停' : '播放';

            if (isPlaying) {
                startSmoothProgress();
            } else {
                stopSmoothProgress();
                updateProgress();
            }
        };

        const listenerDisposers = [];
        const listen = (target, type, handler, options) => {
            target.addEventListener(type, handler, options);
            listenerDisposers.push(() => target.removeEventListener(type, handler, options));
        };
        const onPlayControl = () => {
            if (audio.paused || audio.ended) {
                const audioRoot = mainRendererReferences?.chatMessagesDiv || audio.ownerDocument;
                audioRoot?.querySelectorAll?.('audio.vcp-audio-native').forEach((otherAudio) => {
                    if (otherAudio !== audio && !otherAudio.paused) otherAudio.pause();
                });
                audio.play().catch(() => player.classList.add('has-error'));
            } else {
                audio.pause();
            }
        };
        const onProgressInput = () => {
            if (Number.isFinite(audio.duration) && audio.duration > 0) {
                audio.currentTime = (Number(progress.value) / 100) * audio.duration;
            }
        };
        const onMute = () => {
            audio.muted = !audio.muted;
            if (!audio.muted && audio.volume === 0) audio.volume = 0.7;
            updateVolume();
        };
        const onVolumeInput = () => {
            audio.volume = Number(volume.value);
            audio.muted = audio.volume === 0;
            updateVolume();
        };
        const onWaiting = () => player.classList.add('is-buffering');
        const onPlaying = () => player.classList.remove('is-buffering', 'has-error');
        const onCanPlay = () => player.classList.remove('is-buffering');
        const onError = () => {
            player.classList.remove('is-buffering');
            player.classList.add('has-error');
            title.textContent = '音频加载失败';
        };
        player._vcpAudioCleanup = () => {
            stopSmoothProgress();
            listenerDisposers.splice(0).reverse().forEach(dispose => dispose());
            try { audio.pause(); } catch { /* detached media may already be closed */ }
            audio.removeAttribute('src');
            audio.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
            try { audio.load(); } catch { /* detached media may already be closed */ }
        };

        listen(playButton, 'click', onPlayControl);
        listen(progress, 'input', onProgressInput);
        listen(muteButton, 'click', onMute);
        listen(volume, 'input', onVolumeInput);
        listen(audio, 'loadedmetadata', updateProgress);
        listen(audio, 'durationchange', updateProgress);
        listen(audio, 'timeupdate', updateProgress);
        listen(audio, 'play', updatePlaybackState);
        listen(audio, 'pause', updatePlaybackState);
        listen(audio, 'ended', updatePlaybackState);
        listen(audio, 'volumechange', updateVolume);
        listen(audio, 'waiting', onWaiting);
        listen(audio, 'playing', onPlaying);
        listen(audio, 'canplay', onCanPlay);
        listen(audio, 'error', onError);

        updateProgress();
        updateVolume();
        updatePlaybackState();
    });
}

function getAttachmentFileVisualDescriptor(name = '', type = '') {
    const resolver = mainRendererReferences.uiHelper?.resolveAttachmentFileVisual;
    if (typeof resolver === 'function') {
        return resolver(name, type);
    }
    return {
        kind: 'file',
        iconMarkup: `
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path>
    <path d="M14 2v5a1 1 0 0 0 1 1h5"></path>
</svg>`
    };
}

async function renderAttachments(message, contentDiv) {
    const { electronAPI } = mainRendererReferences;
    if (message.attachments && message.attachments.length > 0) {
        const ownerDocument = contentDiv?.ownerDocument || mainRendererReferences.document;
        if (!ownerDocument) throw new TypeError('MessageRenderer attachment projection requires an owning document');
        const attachmentsContainer = ownerDocument.createElement('div');
        attachmentsContainer.classList.add('message-attachments');
        message.attachments.forEach((att, index) => {
            const wrapper = ownerDocument.createElement('div');
            wrapper.classList.add('message-attachment-wrapper');

            let attachmentElement;
            if (att.type.startsWith('image/')) {
                attachmentElement = ownerDocument.createElement('img');
                attachmentElement.src = att.src;
                attachmentElement.alt = `附件图片: ${att.name}`;
                attachmentElement.title = `点击在新窗口预览: ${att.name}`;
                attachmentElement.classList.add('message-attachment-image-thumbnail');
                const onImageClick = (e) => {
                    e.stopPropagation();
                    const currentTheme = ownerDocument.body?.classList.contains('light-theme') ? 'light' : 'dark';
                    electronAPI.openImageViewer({ src: att.src, title: att.name, theme: currentTheme });
                };
                const onImageContextMenu = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    electronAPI.showImageContextMenu(att.src);
                };
                attachmentElement.addEventListener('click', onImageClick);
                attachmentElement.addEventListener('contextmenu', onImageContextMenu);
                attachmentElement._vcpAttachmentCleanup = () => {
                    attachmentElement.removeEventListener('click', onImageClick);
                    attachmentElement.removeEventListener('contextmenu', onImageContextMenu);
                };
            } else if (att.type.startsWith('audio/')) {
                attachmentElement = ownerDocument.createElement('audio');
                attachmentElement.src = att.src;
                attachmentElement.controls = true;
                attachmentElement.dataset.audioTitle = att.name || '音频附件';
            } else if (att.type.startsWith('video/')) {
                attachmentElement = ownerDocument.createElement('video');
                attachmentElement.src = att.src;
                attachmentElement.controls = true;
                attachmentElement.style.maxWidth = '300px';
            } else {
                attachmentElement = ownerDocument.createElement('a');
                attachmentElement.href = att.src;
                const fileVisual = getAttachmentFileVisualDescriptor(att.name, att.type);
                const isPythonAttachment = /\.py$/i.test((att.name || '').trim())
                    || (() => {
                        try {
                            return /\.py$/i.test(decodeURIComponent(new URL(att.src).pathname));
                        } catch (error) {
                            return false;
                        }
                    })();
                attachmentElement.classList.add('message-attachment-file', `message-attachment-file--${fileVisual.kind}`);
                attachmentElement.title = isPythonAttachment
                    ? `使用记事本打开（不会执行）: ${att.name}`
                    : `点击打开文件: ${att.name}`;
                const onFileClick = async (e) => {
                    e.preventDefault();
                    // 阻止聊天区的全局链接委托再次按系统文件关联打开同一个附件。
                    // 对 .py 而言，二次打开可能直接触发 Python 解释器执行。
                    e.stopPropagation();

                    if (!att.src.startsWith('file://')) {
                        console.warn("Cannot open local file attachment", att.src);
                        return;
                    }

                    if (isPythonAttachment) {
                        try {
                            const result = await electronAPI.openPythonAttachmentInTextEditor?.(att.src);
                            if (!result?.success) {
                                const errorMessage = result?.error || '安全文本编辑器接口不可用';
                                console.error('[MessageRenderer] Failed to open Python attachment safely:', errorMessage);
                                mainRendererReferences.uiHelper?.showToastNotification?.(`无法用记事本打开 Python 附件: ${errorMessage}`, 'error');
                            }
                        } catch (error) {
                            console.error('[MessageRenderer] Failed to open Python attachment safely:', error);
                                mainRendererReferences.uiHelper?.showToastNotification?.(`无法用记事本打开 Python 附件: ${error.message}`, 'error');
                        }
                    } else if (electronAPI.sendOpenExternalLink) {
                        electronAPI.sendOpenExternalLink(att.src);
                    }
                };
                attachmentElement.addEventListener('click', onFileClick);
                attachmentElement._vcpAttachmentCleanup = () => attachmentElement.removeEventListener('click', onFileClick);
                const iconSpan = ownerDocument.createElement('span');
                iconSpan.className = 'message-attachment-file-icon';
                iconSpan.innerHTML = fileVisual.iconMarkup;
                const nameSpan = ownerDocument.createElement('span');
                nameSpan.className = 'message-attachment-file-name';
                let displayName = att.name;
                const pdfMeta = att.pdfMeta || att._fileManagerData?.pdfMeta;
                const isPdf = fileVisual.kind === 'pdf' || /\.pdf$/i.test(att.name || '');
                const hasImageFrames = (Array.isArray(att.imageFrames) && att.imageFrames.length > 0)
                    || (Array.isArray(att._fileManagerData?.imageFrames) && att._fileManagerData.imageFrames.length > 0);
                const isScannedPdf = isPdf && (pdfMeta?.isScanned === true || hasImageFrames);

                if (isScannedPdf) {
                    const pages = pdfMeta?.totalPages || att.imageFrames?.length || att._fileManagerData?.imageFrames?.length;
                    displayName += pages ? ` [扫描件·${pages}页]` : ` [扫描件]`;
                    attachmentElement.title = `点击打开文件: ${att.name} (扫描版·已提供多模态图像)`;
                } else if (isPdf && pdfMeta?.totalPages) {
                    displayName += ` [${pdfMeta.totalPages}页]`;
                }
                nameSpan.textContent = displayName;
                attachmentElement.appendChild(iconSpan);
                attachmentElement.appendChild(nameSpan);
            }
            if (attachmentElement) {
                wrapper.appendChild(attachmentElement);
                // 添加删除按钮
                const removeBtn = ownerDocument.createElement('div');
                removeBtn.className = 'message-attachment-remove-btn';
                removeBtn.innerHTML = '&times;';
                removeBtn.title = '移除此附件';
                const onRemoveClick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (mainRendererReferences.messageCommands.removeAttachmentFromMessage) {
                        mainRendererReferences.messageCommands.removeAttachmentFromMessage(message.id, index);
                    }
                };
                removeBtn.addEventListener('click', onRemoveClick);
                removeBtn._vcpAttachmentCleanup = () => removeBtn.removeEventListener('click', onRemoveClick);
                wrapper.appendChild(removeBtn);
                attachmentsContainer.appendChild(wrapper);
            }
        });
        contentDiv.appendChild(attachmentsContainer);
    }
}

async function renderPostProcessedHtml(contentDiv, rawHtml, options = {}) {
    if (!contentDiv) return;

    // 每次替换原始 HTML 都发布一个新的内容版本。任何较旧的异步 Mermaid、
    // 高亮或动画任务恢复后都必须失效，不能继续处理同一节点上的新内容。
    delete contentDiv.dataset.vcpOffscreenReady;
    const replacesContent = typeof rawHtml === 'string';
    const renderRevision = replacesContent
        ? (Number(contentDiv._vcpRenderRevision) || 0) + 1
        : (Number(contentDiv._vcpRenderRevision) || 0);
    contentDiv._vcpRenderRevision = renderRevision;

    const {
        messageId = null,
        message = null,
        settings = mainRendererReferences.globalSettingsRef.get(),
        renderSessionId = getActiveRenderSessionId(contentDiv.closest?.('[data-vcp-projectforge-root]')),
        runHeavy = true,
        includeAttachments = true,
        deferHighlights = true,
        processScripts = true
    } = options;

    const messageItem = contentDiv.closest?.('.message-item');

    const isStillValid = () => {
        if (rendererDisposed) return false;
        if (renderSessionId !== null && !isRenderSessionActive(renderSessionId)) return false;
        if (Number(contentDiv._vcpRenderRevision) !== renderRevision) return false;
        if (!contentDiv.isConnected) return false;
        if (messageItem && !messageItem.isConnected) return false;
        return true;
    };

    if (typeof rawHtml === 'string') {
        cleanupAnimationsInContent(contentDiv);
        chartEmbedHost?.beforeReplace(contentDiv);
        toolPresentation?.capture(contentDiv);
        // 替换 innerHTML 前必须释放旧子树上的预览 iframe、window message 监听器、
        // 动画/WebGL 资源及大工具结果完整文本。
        releaseLazyTools(contentDiv, rawHtml);
        cleanupChatMedia(contentDiv);
        cleanupToolResultFullContentForRoot(contentDiv);
        contentProcessor.cleanupPreviewsInContent(contentDiv);
        imageHandler.setContentAndProcessImages(contentDiv, rawHtml, messageId);
    }

    if (!isStillValid()) return;

    if (includeAttachments && message) {
        const existingAttachments = contentDiv.querySelector('.message-attachments');
        if (existingAttachments) {
            cleanupChatMedia(existingAttachments);
            existingAttachments.querySelectorAll('*').forEach(node => {
                node._vcpAttachmentCleanup?.();
                delete node._vcpAttachmentCleanup;
            });
            existingAttachments.remove();
        }
        await renderAttachments(message, contentDiv);
        // 不在旧任务中扫描删除附件：同一节点可能已被新 revision 重新挂载。
        // 新渲染开始时的统一 DOM 资源清理负责释放旧附件。
        if (!isStillValid()) return;
        contentDiv.dataset.vcpAttachmentsProcessed = 'true';
    }

    if (!isStillValid()) return;

    bindLazyTools(contentDiv);
    toolPresentation?.apply(contentDiv);

    // 原生 audio 负责媒体播放，自定义控件层负责一致的主题与交互。
    // 放在附件渲染之后，可同时覆盖 Markdown HTML 音频和消息附件音频。
    enhanceAudioPlayers(contentDiv);

    chartEmbedHost?.scan(contentDiv, { auto: processScripts });

    if (!runHeavy) {
        contentDiv.dataset.vcpOffscreenReady = 'true';
        if (messageItem) offscreenWindow?.observe(messageItem);
        if (messageItem) {
            messageItem.dataset.vcpHeavyPending = 'true';
        }
        contentDiv.dataset.vcpHeavyPending = 'true';
        return;
    }

    contentProcessor.processRenderedContent(contentDiv, settings);
    if (!isStillValid()) return;
    await renderMermaidDiagrams(contentDiv);

    if (!isStillValid()) return;

    if (deferHighlights) {
        if (contentDiv._vcpDeferredHighlightTimer) {
            const ownerWindow = contentDiv.ownerDocument?.defaultView;
            ownerWindow?.clearTimeout?.(contentDiv._vcpDeferredHighlightTimer);
            contentDiv._vcpDeferredHighlightTimer = null;
        }
        const ownerWindow = contentDiv.ownerDocument?.defaultView;
        contentDiv._vcpDeferredHighlightTimer = ownerWindow?.setTimeout?.(() => {
            delete contentDiv._vcpDeferredHighlightTimer;
            if (isStillValid()) {
                contentProcessor.highlightAllPatternsInMessage(contentDiv);
            }
        }, 0);
    } else {
        contentProcessor.highlightAllPatternsInMessage(contentDiv);
    }

    if (!isStillValid()) return;
    // stable block 会在终态被规范整树替换；提前执行脚本会把 rAF、timer 和事件
    // 绑定到即将销毁的局部 DOM。CSS 动画不依赖此处理器，可继续即时播放。
    if (processScripts) {
        processAnimationsInContent(contentDiv, visibilityOptimizer);
        if (!isStillValid()) {
            cleanupAnimationsInContent(contentDiv);
            return;
        }
    }
    if (messageItem) {
        messageItem.dataset.vcpHeavyActivated = 'true';
        delete messageItem.dataset.vcpHeavyPending;
    }
    contentDiv.dataset.vcpHeavyActivated = 'true';
    contentDiv.dataset.vcpOffscreenReady = 'true';
    if (messageItem) offscreenWindow?.observe(messageItem);
    delete contentDiv.dataset.vcpHeavyPending;
}

async function renderMessage(message, isInitialLoad = false, appendToDom = true, renderSessionId = null, renderContext = {}) {
    if (rendererDisposed) return null;
    renderSessionId ||= getActiveRenderSessionId(renderContext.root || mainRendererReferences.chatMessagesDiv);
    if (renderSessionId !== null && !isRenderSessionActive(renderSessionId)) {
        return null;
    }

    message = contentRuntime.normalizeMessage(message);
    // console.debug('[MessageRenderer renderMessage] Received message:', JSON.parse(JSON.stringify(message)));
    const { chatMessagesDiv, electronAPI, markedInstance, uiHelper } = mainRendererReferences;
    const renderRoot = renderContext.root || chatMessagesDiv;
    renderRoot.setAttribute('data-vcp-projectforge-root', '');
    projectForgeTopicSurface.observe(renderRoot, message);
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentChatHistory = mainRendererReferences.currentChatHistoryRef.get();

    // 同一个 Surface 内，message id 是外层气泡的唯一身份。历史批次、活动流补建
    // 和文件同步可能并发请求渲染；默认复用已挂载节点，禁止生成第二个气泡。
    // 只有显式的离屏 UI 替换流程可以请求创建新节点。
    const existingMessageDom = renderRoot.querySelector(`.message-item[data-message-id="${message.id}"]`);
    if (existingMessageDom && renderContext.replaceExisting !== true) {
        return existingMessageDom;
    }

    if (!chatMessagesDiv || !electronAPI || !markedInstance) {
        console.error("MessageRenderer: Missing critical references for rendering.");
        return null;
    }

    if (!message.id) {
        message.id = `msg_${message.timestamp}_${Math.random().toString(36).substring(2, 9)}`;
    }

    const { messageItem, contentDiv, avatarImg, senderNameDiv } = createMessageSkeleton(
        message,
        globalSettings,
        currentSelectedItem,
        { document: mainRendererReferences.document, window: mainRendererReferences.window }
    );
    // DOM 气泡拥有只用于交互解析的消息快照。JEV 的历史同步可能在右键事件
    // 到达时正处于替换窗口，不能因此让一个仍可见的气泡失去上下文菜单。
    messageItem._vcpMessageModel = message;
    messageItem.dataset.vcpInitialLoad = isInitialLoad ? 'true' : 'false';

    // --- NEW: Scoped CSS Implementation ---
    let scopeId = null;
    if (message.role === 'assistant') {
        scopeId = generateUniqueId();
        messageItem.id = scopeId; // Assign the unique ID to the message container
    }
    // --- END Scoped CSS Implementation ---


    // 先确定颜色值（但不应用）
    let avatarColorToUse;
    let avatarUrlToUse; // This was the missing variable
    let customBorderColor = null; // 自定义边框颜色
    let customNameColor = null; // 自定义名称颜色
    let shouldApplyColorToName = false; // 是否应该将头像颜色也应用到名称
    let useThemeColors = false; // 是否使用主题颜色

    if (message.role === 'user') {
        avatarColorToUse = globalSettings.userAvatarCalculatedColor;
        avatarUrlToUse = globalSettings.userAvatarUrl;
        // 检查用户是否启用了"会话中使用主题颜色"
        useThemeColors = globalSettings.userUseThemeColorsInChat || false;

        if (!useThemeColors) {
            // 用户消息：获取自定义颜色（仅在未启用主题颜色时应用）
            customBorderColor = globalSettings.userAvatarBorderColor;
            customNameColor = globalSettings.userNameTextColor;
        }
        // 用户消息：头像颜色也应用到名称
        shouldApplyColorToName = true;
    } else if (message.role === 'assistant') {
        if (message.isGroupMessage) {
            avatarColorToUse = message.avatarColor || null;
            avatarUrlToUse = message.avatarUrl || null;

            // 群组消息中的 Agent：从全局已加载列表或兼容配置中动态解析真实头像、计算主色与自定义边框/名称色
            const ownerWindow = mainRendererReferences.window || mainRendererReferences.document?.defaultView;
            const loadedItems = typeof ownerWindow?.itemListManager?.getLoadedItems === 'function'
                ? ownerWindow.itemListManager.getLoadedItems()
                : (typeof window !== 'undefined' && typeof window.itemListManager?.getLoadedItems === 'function'
                    ? window.itemListManager.getLoadedItems()
                    : []);
            const senderLower = message.name ? String(message.name).toLowerCase() : '';
            const matchedItem = loadedItems.find(it => {
                if (!it || it.type !== 'agent') return false;
                if (message.agentId && it.id === message.agentId) return true;
                return !message.agentId && senderLower && String(it.name || '').toLowerCase() === senderLower;
            });
            const agentConfig = matchedItem?.config
                || matchedItem
                || currentSelectedItem?.config?.agents?.find(a => a.id === message.agentId)
                || null;

            const isMissingOrGroupAvatar = !avatarUrlToUse
                || avatarUrlToUse === 'assets/default_avatar.png'
                || (currentSelectedItem?.avatarUrl && avatarUrlToUse === currentSelectedItem.avatarUrl);
            if (isMissingOrGroupAvatar && matchedItem?.avatarUrl) {
                avatarUrlToUse = matchedItem.avatarUrl;
                if (avatarImg) {
                    avatarImg.src = avatarUrlToUse;
                }
            }
            if (!avatarColorToUse && matchedItem) {
                avatarColorToUse = matchedItem.avatarColor
                    || matchedItem.avatarCalculatedColor
                    || matchedItem.config?.avatarCalculatedColor
                    || matchedItem.config?.avatarColor
                    || null;
            }
            if (agentConfig) {
                useThemeColors = agentConfig.useThemeColorsInChat || false;
                if (!useThemeColors) {
                    customBorderColor = agentConfig.avatarBorderColor || null;
                    customNameColor = agentConfig.nameTextColor || null;
                }
            }
        } else if (currentSelectedItem) {
            const hostName = currentSelectedItem.name || currentSelectedItem.config?.name || '';
            const senderName = message.name || message._metadata?.sender_name || '';
            const isCrossAgentMessage = message._metadata?.isPluginReply === true
                || (Boolean(message.agentId) && message.agentId !== currentSelectedItem.id)
                || (Boolean(senderName) && Boolean(hostName) && senderName !== hostName);

            if (isCrossAgentMessage) {
                // 跨 Agent 发言：基础采用消息自带的属性
                avatarColorToUse = message.avatarColor || null;
                avatarUrlToUse = message.avatarUrl || null;

                // 历史旧错/空头像动态自愈机制 (三级降级防线)
                const isBadAvatar = !avatarUrlToUse || (typeof avatarUrlToUse === 'string' && avatarUrlToUse.includes(currentSelectedItem.id));
                if (isBadAvatar && senderName && senderName !== hostName) {
                    const senderLower = senderName.toLowerCase();
                    // 防线 1: 从 window.itemListManager 的缓存快照自愈查表 (三级匹配: 精确 > 前缀 > 双向包含)
                    const loadedItems = typeof window !== 'undefined' && window.itemListManager?.getLoadedItems
                        ? window.itemListManager.getLoadedItems()
                        : [];

                    const matchedItem = loadedItems.find(it => {
                        if (it.type !== 'agent' || !it.name) return false;
                        const itLower = it.name.toLowerCase();
                        return message.agentId && message.agentId !== currentSelectedItem.id
                            ? it.id === message.agentId
                            : itLower === senderLower;
                    });

                    if (matchedItem && matchedItem.avatarUrl) {
                        avatarUrlToUse = matchedItem.avatarUrl;
                        avatarColorToUse = matchedItem.avatarColor || matchedItem.avatarCalculatedColor || avatarColorToUse;
                    }
                }

                // 无法解析的发送者保留中性占位，绝不冒用话题主人的头像。
                avatarColorToUse ||= 'rgb(96,106,116)';
            } else {
                avatarColorToUse = currentSelectedItem.config?.avatarCalculatedColor
                    || currentSelectedItem.avatarCalculatedColor
                    || currentSelectedItem.config?.avatarColor
                    || currentSelectedItem.avatarColor
                    || message.avatarColor;
                avatarUrlToUse = message.avatarUrl || currentSelectedItem.avatarUrl;
            }

            // 非群组消息，获取当前Agent的设置
            const agentConfig = currentSelectedItem.config || currentSelectedItem;
            if (agentConfig) {
                useThemeColors = agentConfig.useThemeColorsInChat || false;
                if (!useThemeColors) {
                    customBorderColor = agentConfig.avatarBorderColor;
                    customNameColor = agentConfig.nameTextColor;
                }
            }
        }
    }

    // 先添加到DOM
    if (appendToDom) {
        if (renderSessionId !== null && !isRenderSessionActive(renderSessionId)) {
            return null;
        }
        renderRoot.appendChild(messageItem);
        mainRendererReferences.messageCommands.syncNextUiEmptyStateWithMessages?.();
        // 观察新消息的可见性
        observeRenderedMessage(messageItem);
    }

    const isActiveStreamRequest = message.role === 'assistant'
        && typeof streamManager.isMessageActive === 'function'
        && streamManager.isMessageActive(message.id);
    const messageTextIsEmpty = message.content === null
        || message.content === undefined
        || (typeof message.content === 'string' && message.content.trim() === '');

    if (message.isThinking || (isActiveStreamRequest && messageTextIsEmpty)) {
        contentDiv.innerHTML = `<span class="thinking-indicator">${message.content || '思考中'}<span class="thinking-indicator-dots">...</span></span>`;
        messageItem.classList.add(message.isThinking ? 'thinking' : 'streaming');
    } else {
        // 切回仍在后台运行且已经产生内容的会话时，恢复可中止的流式状态。
        if (isActiveStreamRequest) {
            messageItem.classList.add('streaming');
        }
        let textToRender = "";
        if (typeof message.content === 'string') {
            textToRender = message.content;
        } else if (message.content && typeof message.content.text === 'string') {
            // This case handles objects like { text: "..." }, common for group messages before history saving
            textToRender = message.content.text;
        } else if (message.content === null || message.content === undefined) {
            textToRender = ""; // Handle null or undefined content gracefully
            console.warn('[MessageRenderer] message.content is null or undefined for message ID:', message.id);
        } else {
            // Fallback for other unexpected object structures, log and use a placeholder
            console.warn('[MessageRenderer] Unexpected message.content type. Message ID:', message.id, 'Content:', JSON.stringify(message.content));
            textToRender = "[消息内容格式异常]";
        }

        if (message.role === 'user') {
            textToRender = prepareUserMessageText(textToRender);
        } else if (message.role === 'assistant') {
            textToRender = processAssistantScopedHtmlContent(textToRender, scopeId, messageItem);
        }

        // --- 按“对话轮次”计算深度 ---
        // 历史批量渲染时优先使用预计算 depthMap，避免每条消息重复扫描完整 history。
        // 如果是实时新消息，它此时可能还不在 history 数组里，则保留原有临时追加兜底逻辑。
        const precomputedDepth = renderContext.depthMap?.get?.(message.id);
        const depth = precomputedDepth !== undefined
            ? precomputedDepth
            : calculateDepthByTurns(
                message.id,
                currentChatHistory.some(m => m.id === message.id)
                    ? [...currentChatHistory]
                    : [...currentChatHistory, message]
            );
        // --- 深度计算结束 ---

        // --- 应用前端正则规则 ---
        // 核心修复：将正则规则应用移出 preprocessFullContent，以避免在流式传输的块上执行
        // 这样可以确保正则表达式在完整的消息内容上运行
        const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
        if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes)) {
            textToRender = applyFrontendRegexRules(textToRender, agentConfigForRegex.stripRegexes, message.role, depth);
        }
        // --- 正则规则应用结束 ---

        const templateOptions = { message, settings: globalSettings, messageRole: message.role, depth };
        let rawHtml = isInitialLoad && !appendToDom && !renderContext.forceSyncTemplate
            ? await renderHistoryTemplate(textToRender, templateOptions, renderRoot, renderSessionId, message)
            : renderMarkdownToHtml(textToRender, templateOptions);
        if (rawHtml === null || rendererDisposed || !isRenderSessionActive(renderSessionId)) {
            releaseUnMountedHtml(rawHtml);
            cleanupMessageDomResources(messageItem);
            if (!rendererDisposed && isRenderSessionActive(renderSessionId) && !renderContext.forceSyncTemplate) {
                const latest = mainRendererReferences.currentChatHistoryRef.get().find(item => item.id === message.id);
                if (latest) return renderMessage(latest, isInitialLoad, appendToDom, renderSessionId,
                    { ...renderContext, forceSyncTemplate: true });
            }
            return null;
        }

        // 修复：清理 Markdown 解析器可能生成的损坏的 SVG viewBox 属性
        // 错误 "Unexpected end of attribute" 表明 viewBox 的值不完整, 例如 "0 "
        rawHtml = rawHtml.replace(/viewBox="0 "/g, 'viewBox="0 0 24 24"');

        // Synchronously set the base HTML content
        imageHandler.setContentAndProcessImages(contentDiv, rawHtml, message.id);
        contentDiv._vcpRenderRevision = 1;
        bindLazyTools(contentDiv);

        // [Pretext集成] 延后填充文本高度缓存，避免阻塞首屏与批量历史渲染。
        // 必须传入当前消息自己的内容节点；传聊天根会令 querySelector 始终命中
        // 第一条 .md-content，导致所有消息争用同一个 idle handle。
        if (!templateOptions.workerCompiled) scheduleMessagePretextEstimate(message.id, textToRender, contentDiv);
        if (templateOptions.estimatedHeight > 0) contentDiv.dataset.vcpEstimatedHeight = String(templateOptions.estimatedHeight);

        const initialRevision = contentDiv._vcpRenderRevision;
        // Define the post-processing logic as a function.
        // This allows us to control WHEN it gets executed.
        const runPostRenderProcessing = async (postOptions = {}) => {
            if (!isRenderSessionActive(renderSessionId) || !messageItem.isConnected || !contentDiv.isConnected
                || contentDiv._vcpRenderRevision !== initialRevision
                || isActiveStreamRequest) {
                return;
            }

            return renderPostProcessedHtml(contentDiv, null, {
                messageId: message.id,
                message,
                settings: globalSettings,
                renderSessionId,
                runHeavy: postOptions.runHeavy !== false,
                includeAttachments: contentDiv.dataset.vcpAttachmentsProcessed !== 'true'
            });
        };

        messageItem._vcp_activateHeavy = () => {
            if (messageItem.dataset.vcpHeavyActivated === 'true') return;
            return runPostRenderProcessing({ runHeavy: true });
        };

        // If we are appending directly to the DOM, schedule the processing immediately.
        if (appendToDom) {
            // We still use requestAnimationFrame to ensure the element is painted before we process it.
            void renderTaskOwner.animationFrame(renderRoot, () => {
                if (!isRenderSessionActive(renderSessionId) || !messageItem.isConnected) return;
                return runPostRenderProcessing();
            }).catch(error => console.warn('[MessageRenderer] deferred post-processing failed:', error));
        } else {
            // If not, attach the processing function to the element itself.
            // The caller (e.g., a batch renderer) will be responsible for executing it
            // AFTER the element has been attached to the DOM.
            messageItem._vcp_process = (postOptions = {}) => {
                if (!isRenderSessionActive(renderSessionId) || !messageItem.isConnected) return;
                return runPostRenderProcessing(postOptions);
            };
            messageItem._vcp_renderSessionId = renderSessionId;
        }
    }

    // 然后应用颜色（现在 messageItem.isConnected 是 true）
    if ((message.role === 'user' || message.role === 'assistant') && avatarImg && senderNameDiv) {
        const applyColorToElements = (colorStr) => {
            if (colorStr) {
                console.debug(`[DEBUG] Applying color ${colorStr} to message item ${messageItem.dataset.messageId}`);
                messageItem.style.setProperty('--dynamic-avatar-color', colorStr);

                // 后备方案：直接应用到avatarImg
                if (avatarImg) {
                    avatarImg.style.borderColor = colorStr;
                    avatarImg.style.borderWidth = '2px';
                    avatarImg.style.borderStyle = 'solid';
                }

                // 如果需要，也应用到名称
                if (shouldApplyColorToName && senderNameDiv) {
                    senderNameDiv.style.color = colorStr;
                }
            } else {
                console.debug(`[DEBUG] No color to apply, using default`);
                messageItem.style.removeProperty('--dynamic-avatar-color');
            }
        };

        // 如果启用了主题颜色模式，不应用任何自定义颜色，让CSS主题接管
        if (useThemeColors) {
            console.debug(`[DEBUG] Using theme colors for message ${messageItem.dataset.messageId}`);
            messageItem.style.removeProperty('--dynamic-avatar-color');
            if (avatarImg) {
                avatarImg.style.removeProperty('border-color');
            }
            if (senderNameDiv) {
                senderNameDiv.style.removeProperty('color');
            }
        } else if (customBorderColor && avatarImg) {
            // 优先应用自定义颜色（如果启用且未启用主题颜色）
            console.debug(`[DEBUG] Applying custom border color ${customBorderColor} to avatar`);
            avatarImg.style.borderColor = customBorderColor;
            avatarImg.style.borderWidth = '2px';
            avatarImg.style.borderStyle = 'solid';
            if (customNameColor && senderNameDiv) {
                senderNameDiv.style.color = customNameColor;
            }
        } else if (avatarColorToUse) {
            // 没有自定义颜色或禁用时，使用计算的颜色
            applyColorToElements(avatarColorToUse);
            if (customNameColor && senderNameDiv) {
                senderNameDiv.style.color = customNameColor;
            }
        } else if (customNameColor && senderNameDiv) {
            senderNameDiv.style.color = customNameColor;
        } else if (avatarUrlToUse && !avatarUrlToUse.includes('default_')) { // No persisted color, try to extract
            // 🟢 Non-blocking color calculation
            // Immediately apply a default border, which will be overridden if color extraction succeeds.
            if (avatarImg) {
                avatarImg.style.borderColor = 'var(--border-color)';
            }

            getDominantAvatarColorCached(avatarUrlToUse).then(dominantColor => {
                if (dominantColor && messageItem.isConnected) {
                    // 只有在没有自定义边框颜色时才应用提取的颜色到边框
                    if (!customBorderColor) {
                        applyColorToElements(dominantColor);
                    } else if (shouldApplyColorToName && senderNameDiv) {
                        // 如果有自定义边框颜色但需要应用颜色到名称，单独处理
                        senderNameDiv.style.color = dominantColor;
                    }

                    // Persist the extracted color
                    let typeToSave, idToSaveFor;
                    if (message.role === 'user') {
                        typeToSave = 'user'; idToSaveFor = 'user_global';
                    } else if (message.agentId) {
                        typeToSave = 'agent'; idToSaveFor = message.agentId;
                    } else if (currentSelectedItem && currentSelectedItem.type === 'agent') {
                        typeToSave = 'agent'; idToSaveFor = currentSelectedItem.id;
                    }

                    const persistKey = `${typeToSave}:${idToSaveFor}:${avatarUrlToUse}:${dominantColor}`;
                    if (typeToSave && idToSaveFor && !persistedAvatarColorKeys.has(persistKey)) {
                        persistedAvatarColorKeys.add(persistKey);
                        electronAPI.saveAvatarColor({ type: typeToSave, id: idToSaveFor, color: dominantColor })
                            .then(result => {
                                if (result.success) {
                                    if (typeToSave === 'user') {
                                        const latestSettings = mainRendererReferences.globalSettingsRef.get();
                                        if (latestSettings.userAvatarUrl !== avatarUrlToUse) return;
                                        mainRendererReferences.globalSettingsRef.set({ ...latestSettings, userAvatarCalculatedColor: dominantColor });
                                    } else if (typeToSave === 'agent') {
                                        const liveSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
                                        if (liveSelectedItem?.id !== idToSaveFor || liveSelectedItem.type !== 'agent') return;
                                        const nextSelectedItem = liveSelectedItem.config
                                            ? { ...liveSelectedItem, config: { ...liveSelectedItem.config, avatarCalculatedColor: dominantColor } }
                                            : { ...liveSelectedItem, avatarCalculatedColor: dominantColor };
                                        mainRendererReferences.currentSelectedItemRef.set(nextSelectedItem);
                                    }
                                } else {
                                    persistedAvatarColorKeys.delete(persistKey);
                                }
                            }).catch(error => {
                                persistedAvatarColorKeys.delete(persistKey);
                                console.warn('[Color] Failed to persist avatar color:', error);
                            });
                    }
                }
            }).catch(err => {
                console.warn(`[Color] Failed to extract dominant color for ${avatarUrlToUse}:`, err);
                // The default border is already applied, so no further action is needed on error.
            });
        } else if (!customBorderColor) { // Default avatar or no URL, reset to theme defaults (only if no custom color)
            // Remove the custom property. The CSS will automatically use its fallback values.
            messageItem.style.removeProperty('--dynamic-avatar-color');
        }

        // 应用自定义名称文字颜色
        if (customNameColor && senderNameDiv) {
            console.debug(`[DEBUG] Applying custom name color ${customNameColor} to sender name`);
            senderNameDiv.style.color = customNameColor;
        }

        // 应用会话样式CSS到聊天消息
        if (message.role === 'assistant') {
            let chatCss = '';

            if (message.isGroupMessage && message.agentId) {
                // 群组消息中的Agent
                const agentConfig = currentSelectedItem?.config?.agents?.find(a => a.id === message.agentId);
                chatCss = agentConfig?.chatCss || '';
            } else if (currentSelectedItem) {
                // 非群组消息
                const agentConfig = currentSelectedItem.config || currentSelectedItem;
                chatCss = agentConfig?.chatCss || '';
            }

            // 通过动态注入<style>标签应用会话CSS
            if (chatCss && chatCss.trim()) {
                console.debug(`[DEBUG] Applying chat CSS to message ${message.id}:`, chatCss);

                // 为此消息创建唯一的scope ID
                const chatScopeId = `vcp-${surfaceId}-chat-${message.id}-${messageItem.id}`;
                messageItem.setAttribute('data-chat-scope', chatScopeId);

                // 检查是否已存在相同的style标签
                const ownerDocument = mainRendererReferences?.document || messageItem.ownerDocument;
                let existingStyle = [...ownedStyleElements].find((element) => element.getAttribute('data-chat-scope-id') === chatScopeId);
                if (existingStyle) {
                    existingStyle.remove();
                    ownedStyleElements.delete(existingStyle);
                }

                // 创建scoped CSS（为当前消息添加作用域）
                const scopedChatCss = `[data-chat-scope="${chatScopeId}"] ${chatCss}`;

                // 注入到<head>
                const styleElement = ownerDocument.createElement('style');
                styleElement.type = 'text/css';
                styleElement.setAttribute('data-chat-scope-id', chatScopeId);
                styleElement.setAttribute('data-vcp-surface-id', surfaceId);
                styleElement.textContent = scopedChatCss;
                ownerDocument.head.appendChild(styleElement);
                ownedStyleElements.add(styleElement);
            }
        }
    }


    // Attachments and content processing are now deferred within a requestAnimationFrame
    // to prevent race conditions during history loading. See the block above.

    // History mutation belongs to the caller's mutation authority. This renderer
    // only projects the message and updates the in-memory view when requested.
    if (isInitialLoad && message.isThinking && !isActiveStreamRequest) {
        // 仅清理没有对应活动请求的陈旧思考占位。
        // 活动异步请求可能在用户切换 Agent/话题后重新加载，不能在这里误删。
        const currentChatHistoryArray = [...mainRendererReferences.currentChatHistoryRef.get()];
        const thinkingMsgIndex = currentChatHistoryArray.findIndex(m => m.id === message.id && m.isThinking);
        if (thinkingMsgIndex > -1) {
            currentChatHistoryArray.splice(thinkingMsgIndex, 1);
            mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray);
        }
        messageItem.remove();
        return null;
    }

    // Highlighting is now part of processRenderedContent

    if (appendToDom) {
        // 主动发送用户消息代表一次明确的“回到底部继续对话”意图。
        // 强制请求仍受滚动代际保护：若用户在下一帧执行前立即上滚，
        // uiHelper 会取消该请求，不会把用户重新拉回底部。
        const shouldReengageBottomFollow = message.role === 'user' && !isInitialLoad;
        mainRendererReferences.uiHelper.scrollToBottom({
            force: shouldReengageBottomFollow
        });
    }
    return messageItem;
}

function startStreamingMessage(message, messageItem = null) {
    const item = messageItem || mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
    if (item) offscreenWindow?.unobserve(item);
    return streamManager.startStreamingMessage(message, messageItem);
}

function discardStreamingMessage(messageId) {
    return streamManager.discardStreamingMessage(messageId);
}


function appendStreamChunk(messageId, chunkData, context) {
    streamManager.appendStreamChunk(messageId, chunkData, context);
}

function projectStreamTerminal(messageId, finishReason, context, finalPayload = null) {
    return streamManager.projectStreamTerminal(messageId, finishReason, context, finalPayload);
}

/**
 * Renders a full, non-streamed message, replacing a 'thinking' placeholder.
 * @param {string} messageId - The ID of the message to update.
 * @param {string} fullContent - The full HTML or text content of the message.
 * @param {string} agentName - The name of the agent sending the message.
 * @param {string} agentId - The ID of the agent sending the message.
 */
async function renderFullMessage(messageId, fullContent, agentName, agentId, options = {}) {
    console.debug(`[MessageRenderer renderFullMessage] Rendering full message for ID: ${messageId}`);
    const { chatMessagesDiv: defaultChatMessagesDiv, electronAPI, uiHelper, markedInstance } = mainRendererReferences;
    const chatMessagesDiv = options.root || defaultChatMessagesDiv;
    const coldItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (coldItem) offscreenWindow?.unobserve(coldItem);
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();

    // --- Update History First ---
    const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    if (messageIndex > -1) {
        const message = currentChatHistoryArray[messageIndex];
        message.content = fullContent;
        message.isThinking = false;
        message.finishReason = 'completed_non_streamed';
        message.name = agentName || message.name;
        message.agentId = agentId || message.agentId;
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);

        // Save history
        if (options.persistHistory !== false && currentSelectedItem && currentSelectedItem.id && currentTopicIdVal && currentSelectedItem.type === 'group') {
            if (mainRendererReferences.chatRepository) {
                try {
                    await mainRendererReferences.historyMutationAuthority.replace({
                        itemId: currentSelectedItem.id,
                        itemType: currentSelectedItem.type,
                        topicId: currentTopicIdVal,
                        category: 'non-stream-terminal',
                    }, currentChatHistoryArray.filter(m => !m.isThinking));
                } catch (error) {
                    console.error(`[MR renderFullMessage] FAILED to save GROUP history for ${currentSelectedItem.id}, topic ${currentTopicIdVal}:`, error);
                }
            }
        }
    } else {
        console.warn(`[renderFullMessage] Message ID ${messageId} not found in history. UI will be updated, but history may be inconsistent.`);
        // Even if not in history, we might still want to render it if the DOM element exists (e.g., from a 'thinking' state)
    }

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) {
        console.debug(`[renderFullMessage] No DOM element for ${messageId}. History updated, UI skipped.`);
        return; // No UI to update, but history is now consistent.
    }
    const projectedMessage = currentChatHistoryArray.find(msg => msg.id === messageId);
    if (projectedMessage) messageItem._vcpMessageModel = projectedMessage;

    messageItem.classList.remove('thinking', 'streaming');
    mainRendererReferences.messageCommands.updateSendButtonState?.();

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) {
        console.error(`[renderFullMessage] Could not find .md-content div for message ID ${messageId}.`);
        return;
    }

    // Update timestamp display if it was missing
    const nameTimeBlock = messageItem.querySelector('.name-time-block');
    if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
        const timestampDiv = messageItem.ownerDocument.createElement('div');
        timestampDiv.classList.add('message-timestamp');
        const messageFromHistory = currentChatHistoryArray.find(m => m.id === messageId);
        timestampDiv.textContent = formatMessageTimestamp(messageFromHistory?.timestamp || Date.now());
        nameTimeBlock.appendChild(timestampDiv);
    }

    // --- Update DOM ---
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    // --- 应用前端正则规则 (修复流式处理问题) ---
    const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
    const messageFromHistoryForRegex = currentChatHistoryArray.find(msg => msg.id === messageId);
    const messageRoleForRender = messageFromHistoryForRegex?.role || 'assistant';
    let depth = 0;
    if (messageFromHistoryForRegex) {
        depth = calculateDepthByTurns(messageId, currentChatHistoryArray);
        if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes)) {
            fullContent = applyFrontendRegexRules(fullContent, agentConfigForRegex.stripRegexes, messageRoleForRender, depth);
        }
    }
    // --- 正则规则应用结束 ---
    if (messageRoleForRender === 'assistant') {
        let scopedMessageId = messageItem.id;
        if (!scopedMessageId) {
            scopedMessageId = generateUniqueId();
            messageItem.id = scopedMessageId;
        }
        fullContent = processAssistantScopedHtmlContent(fullContent, scopedMessageId, messageItem);
    }

    const rawHtml = renderMarkdownToHtml(fullContent, {
        settings: globalSettings,
        messageRole: messageRoleForRender,
        depth
    });

    await renderPostProcessedHtml(contentDiv, rawHtml, {
        messageId,
        message: messageFromHistoryForRegex ? { ...messageFromHistoryForRegex, content: fullContent } : null,
        settings: globalSettings,
        renderSessionId: getActiveRenderSessionId(chatMessagesDiv),
        runHeavy: true,
        includeAttachments: !!messageFromHistoryForRegex
    });

    mainRendererReferences.uiHelper.scrollToBottom();
}

function scheduleMessagePretextEstimate(messageId, text, contentDiv) {
    if (!mainRendererReferences.pretextBridge || !mainRendererReferences.pretextBridge.isReady() || !messageId || !text) return;
    if (isContextCheckpoint(mainRendererReferences.currentChatHistoryRef.get().find(message => message.id === messageId))) return;

    /*
     * Pretext 只能估算纯文本换行，无法复现 ToolUse 折叠态、角色分隔器、
     * 图片、表格和任意 HTML 的真实 DOM 高度。把这类结果写进墓碑缓存，
     * 会在 content-visibility 切换时以错误高度替换真实消息，反而造成跳动。
     * 结构化消息由 visibilityOptimizer 的实测高度路径负责。
     */
    const containsStructuredLayout =
        /<<<\[(?:TOOL_REQUEST|ROLE_DIVIDE_|END_ROLE_DIVIDE_|DESKTOP_PUSH)|\[\[VCP调用结果信息汇总:|<\s*(?:img|table|audio|video|canvas|svg|iframe|style|script)\b|```|!\[[^\]]*\]\(/i.test(text);
    if (containsStructuredLayout) return;

    const run = () => {
        try {
            const messageItem = contentDiv?.closest?.('.message-item');
            const widthSource = contentDiv || messageItem?.parentElement;
            const containerWidth = widthSource?.clientWidth || 800;
            mainRendererReferences.pretextBridge.estimateHeight(messageId, text, 'body', containerWidth);
        } catch (e) {
            // Pretext 失败不影响正常渲染
        }
    };

    const ownerWindow = contentDiv?.ownerDocument?.defaultView;
    enqueuePretextEstimate(ownerWindow, contentDiv || messageId, run);
}

/*
 * 每条消息各占一个 requestIdleCallback 时，40 条历史就是 40 个排在前面的回调，
 * 历史分批插入的 idle 回调只能等它们逐个跑完（每个还要读一次 clientWidth 触发布局），
 * 大话题打开因此慢约 0.4s。这里每个窗口只挂一个 idle 回调，按 deadline 分片消费队列，
 * 没做完就重新排队，让已经排着的分批插入先执行。同一节点重复渲染时覆盖旧任务。
 */
const pretextEstimateQueues = new WeakMap();

function getPretextQueueOwner(ownerWindow) {
    return typeof ownerWindow?.requestIdleCallback === 'function' ? ownerWindow : globalThis;
}

function enqueuePretextEstimate(ownerWindow, key, run) {
    const queueOwner = getPretextQueueOwner(ownerWindow);
    let state = pretextEstimateQueues.get(queueOwner);
    if (!state) {
        state = { jobs: new Map(), scheduled: false };
        pretextEstimateQueues.set(queueOwner, state);
    }
    state.jobs.delete(key);
    state.jobs.set(key, run);
    if (state.scheduled) return;

    const schedule = () => {
        state.scheduled = true;
        if (queueOwner !== globalThis) queueOwner.requestIdleCallback(drain, { timeout: 300 });
        else setTimeout(drain, 0);
    };
    const drain = (deadline) => {
        state.scheduled = false;
        for (const [jobKey, job] of state.jobs) {
            state.jobs.delete(jobKey);
            job();
            if (!deadline || deadline.didTimeout || deadline.timeRemaining() <= 1) break;
        }
        if (state.jobs.size > 0) schedule();
    };
    schedule();
}

function cancelPretextEstimate(contentDiv) {
    const queueOwner = getPretextQueueOwner(contentDiv?.ownerDocument?.defaultView);
    pretextEstimateQueues.get(queueOwner)?.jobs.delete(contentDiv);
}

async function renderFullMessageProjection(messageId, fullContent, agentName, agentId, root = mainRendererReferences.chatMessagesDiv) {
    return renderFullMessage(messageId, fullContent, agentName, agentId, { persistHistory: false, root });
}

function updateMessageContent(messageId, newContent) {
    const coldItem = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (coldItem) offscreenWindow?.unobserve(coldItem);
    const { chatMessagesDiv, markedInstance, globalSettingsRef } = mainRendererReferences;
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) return;

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    const globalSettings = globalSettingsRef.get();
    let textToRender = (typeof newContent === 'string') ? newContent : (newContent?.text || "[内容格式异常]");

    // --- 深度计算 (用于历史消息渲染) ---
    const currentChatHistoryForUpdate = mainRendererReferences.currentChatHistoryRef.get();
    const messageInHistory = currentChatHistoryForUpdate.find(m => m.id === messageId);

    if (messageInHistory && messageInHistory.role === 'user') {
        textToRender = prepareUserMessageText(textToRender);
    }

    // --- 按“对话轮次”计算深度 ---
    const depthForUpdate = calculateDepthByTurns(messageId, currentChatHistoryForUpdate);
    // --- 深度计算结束 ---
    // --- 应用前端正则规则 (修复流式处理问题) ---
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
    if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes) && messageInHistory) {
        textToRender = applyFrontendRegexRules(textToRender, agentConfigForRegex.stripRegexes, messageInHistory.role, depthForUpdate);
    }
    // --- 正则规则应用结束 ---
    if ((messageInHistory?.role || 'assistant') === 'assistant') {
        let scopedMessageId = messageItem.id;
        if (!scopedMessageId) {
            scopedMessageId = generateUniqueId();
            messageItem.id = scopedMessageId;
        }
        textToRender = processAssistantScopedHtmlContent(textToRender, scopedMessageId, messageItem);
    }

    const rawHtml = renderMarkdownToHtml(textToRender, {
        message: messageInHistory,
        settings: globalSettings,
        messageRole: messageInHistory?.role || 'assistant',
        depth: depthForUpdate
    });

    // --- Post-Render Processing (aligned with renderMessage logic) ---

    void renderPostProcessedHtml(contentDiv, rawHtml, {
        messageId,
        message: messageInHistory ? { ...messageInHistory, content: newContent } : null,
        settings: globalSettings,
        renderSessionId: getActiveRenderSessionId(contentDiv.closest('[data-vcp-projectforge-root]')),
        runHeavy: true,
        includeAttachments: !!messageInHistory
    }).catch(error => {
        console.error(`[MessageRenderer] Failed to post-process updated message ${messageId}:`, error);
    });
}

function prepareUserMessageText(text) {
    let processedText = text;

    // 🔴 关键安全修复：用户输入属于不可信内容，必须先行进行 HTML 转义以防 XSS
    // 🟢 改进：允许用户发送 <img> 标签（表情包），但需排除包含事件处理器的恶意标签
    const userImgBlocks = [];
    processedText = processedText.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, (match) => {
        if (/on\w+\s*=/i.test(match) || /src\s*=\s*["']\s*javascript:/i.test(match)) {
            return match;
        }
        const placeholder = `__VCP_USER_IMG_${userImgBlocks.length}__`;
        userImgBlocks.push(match);
        return placeholder;
    });

    processedText = escapeHtml(processedText);

    userImgBlocks.forEach((img, i) => {
        processedText = processedText.replace(`__VCP_USER_IMG_${i}__`, img);
    });

    processedText = transformUserButtonClick(processedText);
    processedText = transformVCPChatCanvas(processedText);

    return processedText;
}

// Expose methods to renderer.js
/**
 * Renders a complete chat history with progressive loading for better UX.
 * First shows the latest 5 messages, then loads older messages in batches of 10.
 * @param {Array<Message>} history The chat history to render.
 * @param {Object} options Rendering options
 * @param {number} options.initialBatch - Number of latest messages to show first (default: 5)
 * @param {number} options.batchSize - Size of subsequent batches (default: 10)
 * @param {number} options.batchDelay - Delay between batches in ms (default: 100)
 */
async function renderHistory(history, options = {}) {
    const renderRoot = options.root || mainRendererReferences.chatMessagesDiv;
    renderRoot.setAttribute('data-vcp-projectforge-root', '');
    projectForgeTopicSurface.replaceHistory(renderRoot, history || []);
    const renderSessionId = invalidateRenderSession(renderRoot);
    mainRendererReferences.uiHelper.resetChatScrollFollow?.();
    // One presentation boundary per history load, not one animation per card.
    // Keep layout available for postprocessing and the existing scroll scheduler.
    renderRoot.dataset.vcpHistoryPresentation = 'preparing';
    const revealFirstBatch = async () => {
        await renderTaskOwner.animationFrame(renderRoot, () => {
            if (!isRenderSessionActive(renderSessionId)) return;
            renderRoot.dataset.vcpHistoryPresentation = 'ready';
        });
    };

    try {
        const {
            initialBatch = 5,
            batchSize = 10,
            batchDelay = 100
        } = options;

        // 核心修复：在开始批量渲染前，只等待一次依赖项。
        await emoticonUrlFixer.initialize(mainRendererReferences.electronAPI);
        if (!isRenderSessionActive(renderSessionId)) return;

        if (!history || history.length === 0) {
            return Promise.resolve();
        }

        const renderContext = {
            depthMap: buildTurnDepthMap(history),
            root: options.root || null
        };

        // 如果消息数量很少，直接使用原来的方式渲染
        if (history.length <= initialBatch) {
            const result = await renderHistoryLegacy(history, renderSessionId, renderContext);
            if (isRenderSessionActive(renderSessionId)) await revealFirstBatch();
            return result;
        }

        console.debug(`[MessageRenderer] 开始分批渲染 ${history.length} 条消息，首批 ${initialBatch} 条，后续每批 ${batchSize} 条`);

        // 分离最新的消息和历史消息
        const latestMessages = history.slice(-initialBatch);
        const olderMessages = history.slice(0, -initialBatch);

        // 第一阶段：立即渲染最新的消息
        await renderMessageBatch(latestMessages, true, renderSessionId, renderContext);
        if (!isRenderSessionActive(renderSessionId)) return;
        await revealFirstBatch();
        if (!isRenderSessionActive(renderSessionId)) return;
        console.debug(`[MessageRenderer] 首批 ${latestMessages.length} 条最新消息已渲染`);

        // 第二阶段：分批渲染历史消息（从旧到新）
        if (olderMessages.length > 0) {
            await renderOlderMessagesInBatches(olderMessages, batchSize, batchDelay, renderSessionId, renderContext);
        }

        if (!isRenderSessionActive(renderSessionId)) return;

        // 最终滚动到底部
        mainRendererReferences.uiHelper.scrollToBottom();
        console.debug(`[MessageRenderer] 所有 ${history.length} 条消息渲染完成`);
    } finally {
        // Empty/error paths fail open; a stale load cannot reveal a newer load.
        if (isRenderSessionActive(renderSessionId)
            && renderRoot.dataset.vcpHistoryPresentation === 'preparing') {
            delete renderRoot.dataset.vcpHistoryPresentation;
        }
    }
}

/**
 * 渲染一批消息
 * @param {Array<Message>} messages 要渲染的消息数组
 * @param {boolean} scrollToBottom 是否滚动到底部
 */
function shouldRunHeavyForMessage(messageItem, renderContext = {}) {
    if (renderContext.forceHeavy === true) return true;
    if (renderContext.deferHeavy === true) {
        return visibilityOptimizer.isMessageInHotZone?.(messageItem) === true;
    }
    return true;
}

function processDeferredMessageElement(el, renderSessionId, renderContext = {}) {
    if (!isRenderSessionActive(renderSessionId) || !el.isConnected) {
        if (typeof el._vcp_process === 'function') {
            delete el._vcp_process;
        }
        delete el._vcp_renderSessionId;
        return;
    }

    observeRenderedMessage(el);

    if (typeof el._vcp_process === 'function') {
        const runHeavy = shouldRunHeavyForMessage(el, renderContext);
        el._vcp_process({ runHeavy });
        delete el._vcp_process;
    }
    delete el._vcp_renderSessionId;
}

async function renderMessageBatch(messages, scrollToBottom = false, renderSessionId = null, renderContext = {}) {
    renderSessionId ||= getActiveRenderSessionId(renderContext.root || mainRendererReferences.chatMessagesDiv);
    if (!isRenderSessionActive(renderSessionId)) return;

    const renderRoot = renderContext.root || mainRendererReferences.chatMessagesDiv;
    const fragment = renderRoot.ownerDocument.createDocumentFragment();
    const messageElements = [];

    // 使用 Promise.allSettled 避免单个失败影响整体
    const results = await Promise.allSettled(
        messages.map(msg => renderMessage(msg, true, false, renderSessionId, renderContext))
    );

    results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
            messageElements.push(result.value);
        } else {
            console.error(`Failed to render message ${messages[index].id}:`,
                result.reason);
        }
    });

    if (!isRenderSessionActive(renderSessionId)) return;

    // 一次性添加到 fragment
    messageElements.forEach(el => fragment.appendChild(el));

    // 使用 owner-managed animation frame，Surface teardown 会取消并等待它。
    return renderTaskOwner.animationFrame(renderRoot, () => {
            if (!isRenderSessionActive(renderSessionId)) return;

            // 在异步批次构建期间，活动流恢复可能已经挂载了相同 message id。
            // 不能只删除 fragment 中的历史快照，否则实时节点会留在旧位置并被
            // 随后追加的历史消息压到顶部。把实时节点移动到快照槽位，才能同时
            // 保持唯一身份和 history 数组定义的最终楼层。
            messageElements.forEach((el, index) => {
                const messageId = el.dataset?.messageId;
                if (!messageId) return;
                const mounted = renderRoot.querySelector(`.message-item[data-message-id="${messageId}"]`);
                if (mounted && mounted !== el) {
                    cleanupMessageDomResources(el);
                    el.replaceWith(mounted);
                    messageElements[index] = mounted;
                }
            });

            // Step 1: Append all elements to the DOM at once.
            renderRoot.appendChild(fragment);
            mainRendererReferences.messageCommands.syncNextUiEmptyStateWithMessages?.();

            // Step 2: Now that they are in the DOM, run the deferred processing for each.
            messageElements.forEach(el => processDeferredMessageElement(el, renderSessionId, renderContext));

            if (scrollToBottom && isRenderSessionActive(renderSessionId)) {
                mainRendererReferences.uiHelper.scrollToBottom();
            }
            return messageElements;
    });
}

/**
 * 分批渲染历史消息
 * @param {Array<Message>} olderMessages 历史消息数组
 * @param {number} batchSize 每批大小
 * @param {number} batchDelay 批次间延迟
 */
/**
 * 智能批量渲染：使用 requestIdleCallback 在浏览器空闲时渲染
 */
async function renderOlderMessagesInBatches(olderMessages, batchSize, batchDelay, renderSessionId = null, renderContext = {}) {
    renderSessionId ||= getActiveRenderSessionId(renderContext.root || mainRendererReferences.chatMessagesDiv);
    const totalBatches = Math.ceil(olderMessages.length / batchSize);

    for (let i = totalBatches - 1; i >= 0; i--) {
        if (!isRenderSessionActive(renderSessionId)) return;

        const startIndex = i * batchSize;
        const endIndex = Math.min(startIndex + batchSize, olderMessages.length);
        const batch = olderMessages.slice(startIndex, endIndex);

        // 创建批次 fragment
        const renderRoot = renderContext.root || mainRendererReferences.chatMessagesDiv;
        const batchFragment = renderRoot.ownerDocument.createDocumentFragment();
        const elementsForProcessing = [];

        for (const msg of batch) {
            if (!isRenderSessionActive(renderSessionId)) return;

            const messageElement = await renderMessage(msg, true, false, renderSessionId, renderContext);
            if (messageElement) {
                batchFragment.appendChild(messageElement);
                elementsForProcessing.push(messageElement);
            }
        }

        // 🟢 owner-managed idle work，当前 root revoke/dispose 时会被取消。
        await renderTaskOwner.idle(renderRoot, () => {
                if (!isRenderSessionActive(renderSessionId)) return;

                // idle 等待期间流式恢复可能已建立同 ID 节点。用实时节点替换
                // fragment 中的快照槽位，使节点随该批次进入准确的历史位置。
                elementsForProcessing.forEach((el, index) => {
                    const messageId = el.dataset?.messageId;
                    if (!messageId) return;
                    const mounted = renderRoot.querySelector(`.message-item[data-message-id="${messageId}"]`);
                    if (mounted && mounted !== el) {
                        cleanupMessageDomResources(el);
                        el.replaceWith(mounted);
                        elementsForProcessing[index] = mounted;
                    }
                });

                let insertPoint = renderRoot.firstChild;
                while (insertPoint?.classList?.contains('topic-timestamp-bubble')) {
                    insertPoint = insertPoint.nextSibling;
                }

                if (insertPoint) {
                    renderRoot.insertBefore(batchFragment, insertPoint);
                } else {
                    renderRoot.appendChild(batchFragment);
                }
                mainRendererReferences.messageCommands.syncNextUiEmptyStateWithMessages?.();

                elementsForProcessing.forEach(el => processDeferredMessageElement(el, renderSessionId, {
                    ...renderContext,
                    deferHeavy: true
                }));
        }, { timeout: 1000 });

        if (!isRenderSessionActive(renderSessionId)) return;

        // 动态调整延迟：如果批次小，减少延迟
        if (i > 0 && batchDelay > 0) {
            const actualDelay = batch.length < batchSize / 2 ? batchDelay / 2 : batchDelay;
            const ownerWindow = renderRoot.ownerDocument?.defaultView;
            if (typeof ownerWindow?.setTimeout !== 'function') return;
            await new Promise(resolve => ownerWindow.setTimeout(resolve, actualDelay));
        }
    }
}

/**
 * 原始的历史渲染方法（用于少量消息的情况）
 * @param {Array<Message>} history 聊天历史
 */
async function renderHistoryLegacy(history, renderSessionId = null, renderContext = {}) {
    renderSessionId ||= getActiveRenderSessionId(renderContext.root || mainRendererReferences.chatMessagesDiv);
    if (!isRenderSessionActive(renderSessionId)) return;

    const renderRoot = renderContext.root || mainRendererReferences.chatMessagesDiv;
    const fragment = renderRoot.ownerDocument.createDocumentFragment();
    const allMessageElements = [];

    // Phase 1: Create all message elements in memory without appending to DOM
    for (const msg of history) {
        if (!isRenderSessionActive(renderSessionId)) return;

        const messageElement = await renderMessage(msg, true, false, renderSessionId, renderContext);
        if (messageElement) {
            allMessageElements.push(messageElement);
        }
    }

    if (!isRenderSessionActive(renderSessionId)) return;

    // Phase 2: Append all created elements at once using a DocumentFragment
    allMessageElements.forEach(el => fragment.appendChild(el));

    return renderTaskOwner.animationFrame(renderRoot, () => {
            if (!isRenderSessionActive(renderSessionId)) return;

            // 构建 fragment 后到本帧挂载前，活动流补建可能已经恢复同 ID 节点。
            // 将实时节点移入对应快照槽位，避免它停留在历史队列顶部。
            allMessageElements.forEach((el, index) => {
                const messageId = el.dataset?.messageId;
                if (!messageId) return;
                const mounted = renderRoot.querySelector(`.message-item[data-message-id="${messageId}"]`);
                if (mounted && mounted !== el) {
                    cleanupMessageDomResources(el);
                    el.replaceWith(mounted);
                    allMessageElements[index] = mounted;
                }
            });

            // Step 1: Append all elements to the DOM.
            renderRoot.appendChild(fragment);
                mainRendererReferences.messageCommands.syncNextUiEmptyStateWithMessages?.();

            // Step 2: Run the deferred processing for each element now that it's attached.
            allMessageElements.forEach(el => processDeferredMessageElement(el, renderSessionId, renderContext));

            if (isRenderSessionActive(renderSessionId)) {
                mainRendererReferences.uiHelper.scrollToBottom();
            }
            return allMessageElements;
    });
}

function refreshLayoutDependentState() {
    offscreenWindow?.invalidateLayout();
    const chatMessagesDiv = mainRendererReferences.chatMessagesDiv;
    if (!chatMessagesDiv) return;

    chatMessagesDiv.querySelectorAll('.message-item').forEach((messageItem) => {
        delete messageItem.dataset.vcpMeasuredHeight;
        messageItem.style.containIntrinsicSize = 'auto 100px';
    });

    void renderTaskOwner.animationFrame(chatMessagesDiv, () => {
        if (!chatMessagesDiv.isConnected) return;
        visibilityOptimizer.recheckVisibility();
    }).catch(error => console.warn('[MessageRenderer] layout refresh failed:', error));
}

const messageRenderer = {
    initializeMessageRenderer,
    setCurrentSelectedItem, // Keep for renderer.js to call
    setCurrentTopicId,      // Keep for renderer.js to call
    setCurrentItemAvatar,   // Renamed for clarity
    setUserAvatar,
    setCurrentItemAvatarColor, // Renamed
    setUserAvatarColor,
    renderMessage,
    renderHistory, // Expose the new progressive batch rendering function
    renderHistoryLegacy, // Expose the legacy rendering for compatibility
    renderMessageBatch, // Expose batch rendering utility
    startStreamingMessage,
    discardStreamingMessage,
    appendStreamChunk,
    projectStreamTerminal,
    renderFullMessage,
    renderFullMessageProjection,
    clearChat,
    removeMessageById,
    updateMessageContent, // Expose the new function
    refreshLayoutDependentState,
    extractSpeakableTextFromContentElement,
    clearRenderHtmlCache,
    disposeRendererListeners,
    disposeRendererResources,
    disposeRootResources,
    createDomRenderer: (root = mainRendererReferences.chatMessagesDiv) => createChatDomRenderer({ root, renderer: messageRenderer }),
    restoreOffscreenMessages: () => offscreenWindow?.restoreAll(),
    getOffscreenStats: () => offscreenWindow?.getStats() || null,
    getRenderWorkerStats: () => renderWorkerClient?.getStats() || null,
    getLazyToolStats: () => ({ entries: lazyToolContents.size }),
    getRenderHtmlCacheStats: () => ({
        entries: renderHtmlCache.size,
        bytes: renderHtmlCacheBytes,
        ...renderHtmlCacheStats
    }),
    updateMessageUI: async (messageId, updatedMessage, root = mainRendererReferences.chatMessagesDiv) => {
        const existingMessageDom = root?.querySelector?.(`.message-item[data-message-id="${messageId}"]`);
        if (!existingMessageDom) return;
        const newMessageDom = await renderMessage(
            updatedMessage,
            true,
            false,
            null,
            { root, replaceExisting: true }
        );
        if (newMessageDom) {
            cleanupMessageDomResources(existingMessageDom, messageId);
            existingMessageDom.replaceWith(newMessageDom);
            // 重新观察
            observeRenderedMessage(newMessageDom);
            // 运行后续处理 logic
            if (typeof newMessageDom._vcp_process === 'function') {
                newMessageDom._vcp_process();
                delete newMessageDom._vcp_process;
            }
        }
    },
    isMessageInitialized: (messageId, root = mainRendererReferences.chatMessagesDiv) => {
        // Check if message exists in DOM or is being tracked by streamManager
        const messageInDom = root?.querySelector?.(`.message-item[data-message-id="${messageId}"]`);
        if (messageInDom) return true;

        // Also check if streamManager is tracking this message
        if (streamManager && typeof streamManager.isMessageInitialized === 'function') {
            return streamManager.isMessageInitialized(messageId);
        }

        return false;
    },
    summarizeTopicFromMessages: async (history, agentName) => { // Example: Keep this if it's generic enough
        // This function was passed in, so it's likely defined in renderer.js or another module.
        // If it's meant to be internal to messageRenderer, its logic would go here.
        // For now, assume it's an external utility.
        if (mainRendererReferences.summarizeTopicFromMessages) {
            return mainRendererReferences.summarizeTopicFromMessages(history, agentName);
        }
        return null;
    },
    setContextMenuDependencies: (deps) => {
        if (contextMenu && typeof contextMenu.setContextMenuDependencies === 'function') {
            contextMenu.setContextMenuDependencies(deps);
        } else {
            console.error("contextMenu or setContextMenuDependencies not available.");
        }
    }
};

return Object.freeze(messageRenderer);
}
