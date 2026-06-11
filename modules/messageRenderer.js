// modules/messageRenderer.js

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls

// 🟢 大内容截断阈值与缓存
const TOOL_RESULT_TRUNCATE_THRESHOLD = 50000; // 50KB 以上触发截断
const TOOL_RESULT_TRUNCATE_LINES = 80; // 截断后只显示前80行
const toolResultFullContentMap = new Map(); // placeholderId -> { raw: string, fieldKey: string }
let toolResultContentIdCounter = 0;

// 🟢 完整 Markdown → HTML 渲染缓存：只缓存 raw HTML 字符串，不缓存 DOM / 后处理结果 / message 对象。
const RENDER_PIPELINE_VERSION = '2026-06-11-render-cache-v1';
const RENDER_HTML_CACHE_MAX_BYTES = 20 * 1024 * 1024;
const RENDER_HTML_CACHE_MAX_ENTRIES = 500;
const RENDER_HTML_CACHE_MAX_SINGLE_BYTES = 1024 * 1024;
const RENDER_HTML_CACHE_MIN_TEXT_LENGTH = 512;
const RENDER_HTML_CACHE_MAX_TEXT_LENGTH = 512 * 1024;
const renderHtmlCache = new Map();
let renderHtmlCacheBytes = 0;
const renderHtmlCacheStats = {
    hits: 0,
    misses: 0,
    skips: 0,
    evictions: 0
};

import { avatarColorCache, getDominantAvatarColor } from './renderer/colorUtils.js';
import { initializeImageHandler, setContentAndProcessImages } from './renderer/imageHandler.js';
import { processAnimationsInContent, cleanupAnimationsInContent } from './renderer/animation.js';
import * as visibilityOptimizer from './renderer/visibilityOptimizer.js';
import { createMessageSkeleton, formatMessageTimestamp } from './renderer/domBuilder.js';
import * as streamManager from './renderer/streamManager.js';
import * as emoticonUrlFixer from './renderer/emoticonUrlFixer.js';
import { createContentPipeline, PIPELINE_MODES } from './renderer/contentPipeline.js';

const colorExtractionPromises = new Map();

async function getDominantAvatarColorCached(url) {
    if (!colorExtractionPromises.has(url)) {
        colorExtractionPromises.set(url, getDominantAvatarColor(url));
    }
    return colorExtractionPromises.get(url);
}

import * as contentProcessor from './renderer/contentProcessor.js';
import * as contextMenu from './renderer/messageContextMenu.js';


import * as middleClickHandler from './renderer/middleClickHandler.js';


// --- LaTeX Protection ---
// 用于在 marked 解析前保护 LaTeX 块，防止 Markdown 解析器破坏 LaTeX 语法
// （如 \\ 被当作转义、_ 被当作斜体等）

/**
 * 在 marked 解析前保护 LaTeX 块，用占位符替换。
 * 必须在 preprocessFullContent 之后、markedInstance.parse 之前调用。
 * @param {string} text 预处理后的文本
 * @returns {{text: string, map: Map<string, string>}} 替换后的文本和映射表
 */
function protectLatexBlocks(text) {
    const map = new Map();
    let id = 0;

    const createLatexPlaceholder = (latexSource) => {
        const placeholder = `%%LATEX_BLOCK_${id}%%`;
        map.set(placeholder, latexSource);
        id++;
        return placeholder;
    };

    const looksLikeSafeSingleDollarMath = (content) => {
        const trimmedContent = (content || '').trim();
        if (!trimmedContent) return false;

        // 跳过价格、价格单位、Shell 变量、模板字符串与 Markdown 表格跨列误匹配。
        if (/^\d/.test(trimmedContent)) return false;
        if (trimmedContent.startsWith('/')) return false;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedContent)) return false;
        if (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) return false;
        if (trimmedContent.includes('|')) return false;

        // 只放行带有明确数学信号的单美元公式。
        return /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(trimmedContent);
    };

    // 🟢 关键修复：先保护代码围栏，防止代码块内的 $ / $$ 被误匹配为 LaTeX
    // 例如 Python 代码 `b'$$' in data` 中的 $$ 会与文档后面的 $$ 数学公式匹配，
    // 导致 LaTeX 占位符跨越并吞噬中间的代码围栏标记
    const codeFenceMap = new Map();
    let codeFenceId = 0;

    // 使用逐行状态机识别代码围栏（比正则更可靠）
    const lines = text.split('\n');
    const resultLines = [];
    let fenceStartLine = -1;
    let fenceBacktickCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();

        if (fenceStartLine === -1) {
            // 不在代码块内：检测开始围栏
            const openMatch = trimmed.match(/^(`{3,})/);
            if (openMatch) {
                fenceStartLine = resultLines.length;
                fenceBacktickCount = openMatch[1].length;
                resultLines.push(lines[i]);
            } else {
                resultLines.push(lines[i]);
            }
        } else {
            // 在代码块内：检测关闭围栏
            const closeMatch = trimmed.match(/^(`{3,})\s*$/);
            if (closeMatch && closeMatch[1].length >= fenceBacktickCount) {
                // 找到关闭围栏，将整个代码块替换为占位符
                resultLines.push(lines[i]);
                const blockLines = resultLines.splice(fenceStartLine);
                const blockContent = blockLines.join('\n');
                const placeholder = `%%CODEFENCE_FOR_LATEX_${codeFenceId}%%`;
                codeFenceMap.set(placeholder, blockContent);
                codeFenceId++;
                resultLines.push(placeholder);
                fenceStartLine = -1;
                fenceBacktickCount = 0;
            } else {
                resultLines.push(lines[i]);
            }
        }
    }

    // 如果有未关闭的代码围栏（流式传输场景），也保护起来
    if (fenceStartLine !== -1) {
        const blockLines = resultLines.splice(fenceStartLine);
        const blockContent = blockLines.join('\n');
        const placeholder = `%%CODEFENCE_FOR_LATEX_${codeFenceId}%%`;
        codeFenceMap.set(placeholder, blockContent);
        codeFenceId++;
        resultLines.push(placeholder);
    }

    let processed = resultLines.join('\n');

    // 保护顺序很重要：先保护 display math ($$...$$)，再保护 inline math。
    // 块级 $$ 只接受“独占一行”的定界符，避免把 `$10`、`$$` 字符串或表格内容误贪成跨段公式。
    // 同时保护 \[...\] 和 \(...\)。

    // 1. 保护 $$...$$ (display math) - 支持多行，定界符必须独占一行
    processed = processed.replace(/(^|\n)([ \t]*)\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/g, (match, linePrefix) => {
        return `${linePrefix}${createLatexPlaceholder(match.slice(linePrefix.length))}`;
    });

    // 2. 保护 \[...\] (display math) - 支持多行
    processed = processed.replace(/(^|\n)([ \t]*)\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\][ \t]*(?=\n|$)/g, (match, linePrefix) => {
        return `${linePrefix}${createLatexPlaceholder(match.slice(linePrefix.length))}`;
    });

    // 3. 保护 \(...\) (inline math)
    processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (match) => {
        return createLatexPlaceholder(match);
    });

    // 4. 保护安全的 $...$ (inline math)。
    // 为避免 KaTeX auto-render 的单美元误触发，这里把安全单美元公式转换为 \( ... \) 形式交给后处理渲染。
    // 例如 $O(L^2) \to O(1)$ 会渲染；$10、$PATH、${value}、表格跨列 $...|...$ 不会触发。
    processed = processed.replace(/(^|[^\w\\$])\$([^\$\n]{1,1200}?)\$(?![\w])/g, (match, prefix, content) => {
        if (!looksLikeSafeSingleDollarMath(content)) return match;
        return `${prefix}${createLatexPlaceholder(`\\(${content.trim()}\\)`)}`;
    });

    // 如果安全单美元公式原本是缩进独立行，Markdown 会把它当作缩进代码块。
    // 这里仅对“整行只有 LaTeX 占位符”的行去缩进，不影响列表项、引用块或普通缩进文本。
    processed = processed.replace(/(^|\n)[ \t]{4,}(%%LATEX_BLOCK_\d+%%)(?=[ \t]*(?:\n|$))/g, (match, linePrefix, placeholder) => {
        return `${linePrefix}${placeholder}`;
    });

    // 🟢 恢复代码围栏（占位符 → 原始代码块）
    for (const [placeholder, original] of codeFenceMap.entries()) {
        processed = processed.split(placeholder).join(original);
    }

    return { text: processed, map };
}

/**
 * 在 marked 解析后恢复被保护的 LaTeX 块。
 * @param {string} html marked 解析后的 HTML
 * @param {Map<string, string>} map 占位符到原始 LaTeX 的映射
 * @returns {string} 恢复后的 HTML
 */
function restoreLatexBlocks(html, map) {
    if (!map || map.size === 0 || typeof html !== 'string') return html;

    // P1-5：单遍恢复 LaTeX 占位符，避免公式数量较多时按占位符多次全 HTML 扫描。
    return html.replace(/%%LATEX_BLOCK_(\d+)%%/g, (placeholder) => {
        return map.get(placeholder) ?? placeholder;
    });
}

// --- Pre-compiled Regular Expressions for Performance ---
const TOOL_REGEX = /(?<!`)<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>(?!`)/gs;
const TOOL_START_MARKER = '<<<[TOOL_REQUEST]>>>';
const TOOL_END_MARKER = '<<<[END_TOOL_REQUEST]>>>';
const NOTE_REGEX = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/gs;
const TOOL_RESULT_REGEX = /\[\[VCP调用结果信息汇总:(.*?)VCP调用结果结束\]\]/gs;
const BUTTON_CLICK_REGEX = /\[\[点击按钮:(.*?)\]\]/gs;
const CANVAS_PLACEHOLDER_REGEX = /\{\{VCPChatCanvas\}\}/g;
const STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const HTML_FENCE_CHECK_REGEX = /```\w*\n<!DOCTYPE html>/i;
const MERMAID_CODE_REGEX = /<code.*?>\s*(flowchart|graph|mermaid)\s+([\s\S]*?)<\/code>/gi;
const MERMAID_FENCE_REGEX = /```(mermaid|flowchart|graph)[^\S\n]*\n([\s\S]*?)```/g;
const CODE_FENCE_REGEX = /```[^\n]*([\s\S]*?)```/g;
const THOUGHT_CHAIN_REGEX = /\[--- VCP元思考链(?::\s*"([^"]*)")?\s*---\]([\s\S]*?)\[--- 元思考链结束 ---\]/gs;
const CONVENTIONAL_THOUGHT_REGEX = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
const ROLE_DIVIDER_REGEX = /<<<\[(END_)?ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;
const DESKTOP_PUSH_REGEX = /(?<!`)<<<\[DESKTOP_PUSH\]>>>([\s\S]*?)<<<\[DESKTOP_PUSH_END\]>>>(?!`)/gs;
const DESKTOP_PUSH_PARTIAL_REGEX = /(?<!`)<<<\[DESKTOP_PUSH\]>>>([\s\S]*)$/s; // 流式传输中未闭合的情况


function isBacktickWrappedMarker(text, index, marker) {
    return text[index - 1] === '`' || text[index + marker.length] === '`';
}

function findMarkedFieldEnd(text, contentStart, isEscape) {
    const endRegex = isEscape
        ? /[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}]/gi
        : /[「{]末[」}]/g;
    endRegex.lastIndex = contentStart;
    const endMatch = endRegex.exec(text);
    return endMatch ? endMatch.index + endMatch[0].length : text.length;
}

function findToolRequestEnd(text, contentStart) {
    const markerRegex = /<<<\[END_TOOL_REQUEST\]>>>|[「{]始(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi;
    markerRegex.lastIndex = contentStart;

    while (true) {
        const match = markerRegex.exec(text);
        if (!match) return -1;

        const marker = match[0];
        if (marker === TOOL_END_MARKER) {
            if (isBacktickWrappedMarker(text, match.index, marker)) {
                markerRegex.lastIndex = match.index + marker.length;
                continue;
            }
            return match.index + marker.length;
        }

        const isEscape = /escape/i.test(marker);
        markerRegex.lastIndex = findMarkedFieldEnd(text, match.index + marker.length, isEscape);
    }
}

function replaceToolRequestBlocks(text, replacer) {
    if (typeof text !== 'string' || !text.includes(TOOL_START_MARKER)) {
        return text;
    }

    let result = '';
    let cursor = 0;

    while (cursor < text.length) {
        const startIndex = text.indexOf(TOOL_START_MARKER, cursor);
        if (startIndex === -1) {
            result += text.slice(cursor);
            break;
        }

        if (isBacktickWrappedMarker(text, startIndex, TOOL_START_MARKER)) {
            result += text.slice(cursor, startIndex + TOOL_START_MARKER.length);
            cursor = startIndex + TOOL_START_MARKER.length;
            continue;
        }

        const contentStart = startIndex + TOOL_START_MARKER.length;
        const endIndex = findToolRequestEnd(text, contentStart);
        if (endIndex === -1) {
            result += text.slice(cursor);
            break;
        }

        const fullMatch = text.slice(startIndex, endIndex);
        const content = text.slice(contentStart, endIndex - TOOL_END_MARKER.length);
        result += text.slice(cursor, startIndex);
        result += replacer(fullMatch, content);
        cursor = endIndex;
    }

    return result;
}

// --- Enhanced Rendering Styles (from UserScript) ---
function injectEnhancedStyles() {
    try {
        // 检查是否已经通过 ID 或 href 引入了该样式表
        const existingStyleElement = document.getElementById('vcp-enhanced-ui-styles');
        if (existingStyleElement) return;

        const links = document.getElementsByTagName('link');
        for (let i = 0; i < links.length; i++) {
            if (links[i].href && links[i].href.includes('messageRenderer.css')) {
                return;
            }
        }

        // 如果没有引入，则尝试从根路径引入（仅对根目录 HTML 有效）
        const linkElement = document.createElement('link');
        linkElement.id = 'vcp-enhanced-ui-styles';
        linkElement.rel = 'stylesheet';
        linkElement.type = 'text/css';
        linkElement.href = 'styles/messageRenderer.css';
        document.head.appendChild(linkElement);
    } catch (error) {
        console.error('VCPSub Enhanced UI: Failed to load external styles:', error);
    }
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
            } catch (e) {
                console.error('Failed to decode mermaid code', e);
                placeholder.textContent = '[Mermaid code decoding error]';
            }
        }
    });

    // Get the list of actual .mermaid elements to render
    const elementsToRender = placeholders.filter(el => el.classList.contains('mermaid'));

    if (elementsToRender.length > 0 && typeof mermaid !== 'undefined') {
        // Initialize mermaid if it hasn't been already
        mermaid.initialize({ startOnLoad: false });

        // 逐个渲染以防止单个图表错误导致所有图表显示错误
        for (const el of elementsToRender) {
            try {
                await mermaid.run({ nodes: [el] });
            } catch (error) {
                console.error("Error rendering Mermaid diagram:", error);
                const originalCode = el.textContent;
                el.innerHTML = `<div class="mermaid-error">Mermaid 渲染错误: ${error.message}</div><pre>${escapeHtml(originalCode)}</pre>`;
            }
        }
    }
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
        // 使用 uiHelperFunctions.regexFromString 来解析正则表达式
        let regex = null;
        if (window.uiHelperFunctions && window.uiHelperFunctions.regexFromString) {
            regex = window.uiHelperFunctions.regexFromString(rule.findPattern);
        } else {
            // 后备方案：手动解析
            const regexMatch = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
            if (regexMatch) {
                regex = new RegExp(regexMatch[1], regexMatch[2]);
            } else {
                regex = new RegExp(rule.findPattern, 'g');
            }
        }

        if (!regex) {
            console.error('无法解析正则表达式:', rule.findPattern);
            return text;
        }

        // 应用替换（如果没有替换内容，则默认替换为空字符串）
        return text.replace(regex, rule.replaceWith || '');
    } catch (error) {
        console.error('应用正则规则时出错:', rule.findPattern, error);
        return text;
    }
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

    let processedText = text;

    rules.forEach(rule => {
        // 检查是否应该应用此规则

        // 1. 检查是否应用于前端
        if (!rule.applyToFrontend) return;

        // 2. 检查角色
        const shouldApplyToRole = rule.applyToRoles && rule.applyToRoles.includes(role);
        if (!shouldApplyToRole) return;

        // 3. 检查深度（-1 表示无限制）
        const minDepthOk = rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth;
        const maxDepthOk = rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth;

        if (!minDepthOk || !maxDepthOk) return;

        // 应用规则
        processedText = applyRegexRule(processedText, rule);
    });

    return processedText;
}

/**
 * Finds special VCP blocks (Tool Requests, Daily Notes) and transforms them
 * directly into styled HTML divs, bypassing the need for markdown code fences.
 * @param {string} text The text content.
 * @param {Map} [codeBlockMap] Map of code block placeholders to their original content.
 * @returns {string} The processed text with special blocks as HTML.
 */
function transformSpecialBlocks(text, codeBlockMap) {
    let processed = text;

    const restoreBlocks = (textStr) => {
        if (!textStr || !codeBlockMap) return textStr;
        let res = textStr;
        for (const [placeholder, block] of codeBlockMap.entries()) {
            if (res.includes(placeholder)) {
                res = res.replace(placeholder, () => block);
            }
        }
        return res;
    };

    // 🟢 架构级修复：VCP Tool Results 不再在此处理
    // 工具结果块在 contentPipeline 中被提取为占位符，贯穿 Markdown 解析后
    // 由 restoreRenderedToolResults() 独立渲染并恢复，彻底避免内部语法干扰

    const createVcpEndMarkerRegex = (isEscape) => {
        return isEscape
            ? /[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}]/gi
            : /[「{]末[」}]/g;
    };

    const extractMarkedField = (source, labelRegex) => {
        if (!source || typeof source !== 'string') return null;

        const labelMatch = labelRegex.exec(source);
        if (!labelMatch) return null;

        const startRegex = /[「{]始(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi;
        startRegex.lastIndex = labelMatch.index + labelMatch[0].length;
        const startMatch = startRegex.exec(source);
        if (!startMatch) return null;

        // 字段名和起始标记之间只允许空白，避免误吞到后续字段
        if (source.slice(labelMatch.index + labelMatch[0].length, startMatch.index).trim() !== '') {
            return null;
        }

        const startMarker = startMatch[0];
        const isEscape = /escape/i.test(startMarker);
        const contentStart = startMatch.index + startMarker.length;
        const endRegex = createVcpEndMarkerRegex(isEscape);
        endRegex.lastIndex = contentStart;
        const endMatch = endRegex.exec(source);

        if (!endMatch) {
            return source.slice(contentStart).trim();
        }

        return source.slice(contentStart, endMatch.index).trim();
    };

    const renderMarkdownField = (rawText) => {
        const restoredText = restoreBlocks(rawText || '');
        if (mainRendererReferences.markedInstance) {
            try {
                return mainRendererReferences.markedInstance.parse(restoredText);
            } catch (e) {
                return escapeHtml(restoredText);
            }
        }
        return escapeHtml(restoredText);
    };

    const getDailyNoteAgentInfo = (source) => {
        const maid = extractMarkedField(source, /(?:maid|maidName):\s*/i) || '';
        const valet = extractMarkedField(source, /(?:valet|valetName):\s*/i) || '';

        if (valet) {
            return {
                name: valet,
                type: 'valet',
                gender: 'male',
                label: 'Valet',
                title: "Valet's Diary"
            };
        }

        return {
            name: maid,
            type: 'maid',
            gender: 'female',
            label: 'Maid',
            title: "Maid's Diary"
        };
    };

    const renderDailyNoteCreate = ({ agentName, agentType = 'maid', agentGender = 'female', agentLabel = 'Maid', defaultTitle = "Maid's Diary", date, fileName, folder, diaryContent, diaryTag }) => {
        let html = `<div class="maid-diary-bubble ${agentType}-diary-bubble" data-vcp-block-type="maid-diary" data-agent-gender="${escapeHtml(agentGender)}" data-vcp-preserve-children="true">`;
        html += `<div class="diary-header">`;
        html += `<span class="diary-title">${fileName ? escapeHtml(fileName) : escapeHtml(defaultTitle)}</span>`;
        if (date) {
            html += `<span class="diary-date">${escapeHtml(date)}</span>`;
        }
        html += `</div>`;

        if (agentName || folder) {
            html += `<div class="diary-maid-info">`;
            if (agentName) {
                html += `<span class="diary-maid-label">${escapeHtml(agentLabel)}:</span> `;
                html += `<span class="diary-maid-name">${escapeHtml(agentName)}</span>`;
            }
            if (folder) {
                if (agentName) html += ` <span class="diary-meta-separator">·</span> `;
                html += `<span class="diary-folder-label">Folder:</span> `;
                html += `<span class="diary-folder-name">${escapeHtml(folder)}</span>`;
            }
            html += `</div>`;
        }

        let diaryBody = diaryContent || '[日记内容解析失败]';
        if (diaryTag) {
            diaryBody += `\n\nTag:${diaryTag}`;
        }

        html += `<div class="diary-content">${renderMarkdownField(diaryBody)}</div>`;
        html += `</div>`;

        return `\n\n${html}\n\n`;
    };

    const renderDailyNoteUpdate = ({ agentName, agentType = 'maid', agentGender = 'female', folder, target, replace }) => {
        const hasTarget = target && target.trim();
        const hasReplace = replace && replace.trim();

        let html = `<div class="maid-diary-update-bubble ${agentType}-diary-update-bubble" data-vcp-block-type="maid-diary-update" data-agent-gender="${escapeHtml(agentGender)}" data-vcp-preserve-children="true">`;
        html += `<div class="diary-update-header">`;
        html += `<span class="diary-update-title">DailyNote Update</span>`;
        if (agentName || folder) {
            html += `<span class="diary-update-meta">`;
            if (agentName) html += `<span class="diary-maid-name">${escapeHtml(agentName)}</span>`;
            if (agentName && folder) html += ` <span class="diary-meta-separator">·</span> `;
            if (folder) html += `<span class="diary-folder-name">${escapeHtml(folder)}</span>`;
            html += `</span>`;
        }
        html += `</div>`;

        html += `<div class="diary-update-body">`;
        html += `<div class="diary-update-side diary-update-before">`;
        html += `<div class="diary-update-label">A</div>`;
        html += `<div class="diary-update-content">${hasTarget ? renderMarkdownField(target) : '<em>原文解析失败</em>'}</div>`;
        html += `</div>`;
        html += `<div class="diary-update-arrow" aria-hidden="true">→</div>`;
        html += `<div class="diary-update-side diary-update-after">`;
        html += `<div class="diary-update-label">B</div>`;
        html += `<div class="diary-update-content">${hasReplace ? renderMarkdownField(replace) : '<em>替换内容解析失败</em>'}</div>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;

        return `\n\n${html}\n\n`;
    };

    // Process Tool Requests
    processed = replaceToolRequestBlocks(processed, (match, content) => {
        const detectedToolName = extractMarkedField(content, /tool_name:\s*/i);
        const detectedCommand = extractMarkedField(content, /command:\s*/i);
        const normalizedToolName = (detectedToolName || '').trim().toLowerCase();
        const normalizedCommand = (detectedCommand || '').trim().toLowerCase();

        // DailyNote 新版 Tool Request:
        // 1) tool_name 为 DailyNote 且 command 为 update 时渲染为 A → B 替换预览；
        // 2) 如果没有 create/update 指令，但同时存在 target 和 replace 字段，也按 update 渲染；
        // 3) tool_name 为 DailyNote 且 command 为 create 时渲染为日记创建；
        // 4) 如果没有 create/update 指令，但存在 content 字段，也按 create 渲染。
        const dailyNoteContent = extractMarkedField(content, /Content:\s*/i);
        const dailyNoteTarget = extractMarkedField(content, /target:\s*/i);
        const dailyNoteReplace = extractMarkedField(content, /replace:\s*/i);
        const isDailyNoteTool = normalizedToolName === 'dailynote';
        const isDailyNoteUpdate = isDailyNoteTool && (normalizedCommand === 'update' || (!normalizedCommand && dailyNoteTarget && dailyNoteReplace));
        const isDailyNoteCreate = isDailyNoteTool && !isDailyNoteUpdate && (normalizedCommand === 'create' || (!normalizedCommand && dailyNoteContent));

        if (isDailyNoteCreate) {
            const dailyNoteAgent = getDailyNoteAgentInfo(content);
            return renderDailyNoteCreate({
                agentName: dailyNoteAgent.name,
                agentType: dailyNoteAgent.type,
                agentGender: dailyNoteAgent.gender,
                agentLabel: dailyNoteAgent.label,
                defaultTitle: dailyNoteAgent.title,
                date: extractMarkedField(content, /Date:\s*/i) || '',
                fileName: extractMarkedField(content, /fileName:\s*/i) || '',
                folder: extractMarkedField(content, /folder:\s*/i) || '',
                diaryContent: dailyNoteContent || '[日记内容解析失败]',
                diaryTag: extractMarkedField(content, /Tag:\s*/i) || ''
            });
        } else if (isDailyNoteUpdate) {
            const dailyNoteAgent = getDailyNoteAgentInfo(content);
            return renderDailyNoteUpdate({
                agentName: dailyNoteAgent.name,
                agentType: dailyNoteAgent.type,
                agentGender: dailyNoteAgent.gender,
                folder: extractMarkedField(content, /folder:\s*/i) || '',
                target: dailyNoteTarget || '',
                replace: dailyNoteReplace || ''
            });
        } else {
            // --- It's a regular tool call, render it normally ---
            const xmlToolNameMatch = content.match(/<tool_name>([\s\S]*?)<\/tool_name>/i);

            let toolName = 'Processing...';
            let extractedName = (xmlToolNameMatch?.[1] || detectedToolName || '').trim();
            if (extractedName) {
                extractedName = extractedName.replace(/[「{](?:始|末)(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi, '').replace(/,$/, '').trim();
            }
            if (extractedName) {
                toolName = extractedName;
            }

            const escapedFullContent = escapeHtml(restoreBlocks(content));
            return `\n\n<div class="vcp-tool-use-bubble" data-vcp-block-type="tool-use" data-vcp-preserve-children="true">` +
                `<div class="vcp-tool-summary">` +
                `<span class="vcp-tool-label">VCP-ToolUse:</span> ` +
                `<span class="vcp-tool-name-highlight">${escapeHtml(toolName)}</span>` +
                `</div>` +
                `<div class="vcp-tool-details"><pre>${escapedFullContent}</pre></div>` +
                `</div>\n\n`;
        }
    });

    // Process Daily Notes
    processed = processed.replace(NOTE_REGEX, (match, rawContent) => {
        const content = rawContent.trim();
        const maidRegex = /Maid:\s*([^\n\r]*)/;
        const dateRegex = /Date:\s*([^\n\r]*)/;
        const contentRegex = /Content:\s*([\s\S]*)/;

        const maidMatch = content.match(maidRegex);
        const dateMatch = content.match(dateRegex);
        const contentMatch = content.match(contentRegex);

        const maid = maidMatch ? maidMatch[1].trim() : '';
        const date = dateMatch ? dateMatch[1].trim() : '';
        // The rest of the text after "Content:", or the full text if "Content:" is not found
        const diaryContent = contentMatch ? contentMatch[1].trim() : content;

        let html = `<div class="maid-diary-bubble" data-vcp-block-type="maid-diary" data-vcp-preserve-children="true">`;
        html += `<div class="diary-header">`;
        html += `<span class="diary-title">Maid's Diary</span>`;
        if (date) {
            html += `<span class="diary-date">${escapeHtml(date)}</span>`;
        }
        html += `</div>`;

        if (maid) {
            html += `<div class="diary-maid-info">`;
            html += `<span class="diary-maid-label">Maid:</span> `;
            html += `<span class="diary-maid-name">${escapeHtml(maid)}</span>`;
            html += `</div>`;
        }

        let processedDiaryContent;
        if (mainRendererReferences.markedInstance) {
            try {
                processedDiaryContent = mainRendererReferences.markedInstance.parse(restoreBlocks(diaryContent));
            } catch (e) {
                processedDiaryContent = escapeHtml(restoreBlocks(diaryContent));
            }
        } else {
            processedDiaryContent = escapeHtml(restoreBlocks(diaryContent));
        }
        html += `<div class="diary-content">${processedDiaryContent}</div>`;
        html += `</div>`;

        return `\n\n${html}\n\n`;
    });

    // Process VCP Thought Chains
    const renderThoughtChain = (theme, rawContent) => {
        const displayTheme = theme ? theme.trim() : "元思考链";
        const content = rawContent.trim();
        const escapedContent = escapeHtml(restoreBlocks(content));

        let html = `<div class="vcp-thought-chain-bubble collapsible" data-vcp-block-type="thought-chain" data-vcp-preserve-children="true">`;
        html += `<div class="vcp-thought-chain-header">`;
        html += `<span class="vcp-thought-chain-icon">🧠</span>`;
        html += `<span class="vcp-thought-chain-label">${escapeHtml(displayTheme)}</span>`;
        html += `<span class="vcp-result-toggle-icon"></span>`;
        html += `</div>`;

        html += `<div class="vcp-thought-chain-collapsible-content">`;

        let processedContent;
        if (mainRendererReferences.markedInstance) {
            try {
                processedContent = mainRendererReferences.markedInstance.parse(restoreBlocks(content));
            } catch (e) {
                processedContent = `<pre>${escapedContent}</pre>`;
            }
        } else {
            processedContent = `<pre>${escapedContent}</pre>`;
        }

        html += `<div class="vcp-thought-chain-body">${processedContent}</div>`;
        html += `</div>`; // End of vcp-thought-chain-collapsible-content
        html += `</div>`; // End of vcp-thought-chain-bubble

        return `\n\n${html}\n\n`;
    };

    processed = processed.replace(THOUGHT_CHAIN_REGEX, (match, theme, rawContent) => {
        return renderThoughtChain(theme, rawContent);
    });

    // Process Conventional Thought Chains (<think>...</think>)
    processed = processed.replace(CONVENTIONAL_THOUGHT_REGEX, (match, rawContent) => {
        return renderThoughtChain("思维链", rawContent);
    });

    // Desktop Push blocks 已在 preprocessFullContent 中于代码块保护之后统一处理
    // 这里不再重复处理，避免与代码块内的语法冲突

    // Process Role Dividers
    processed = processed.replace(ROLE_DIVIDER_REGEX, (match, isEnd, role) => {
        const isEndMarker = !!isEnd;
        const roleLower = role.toLowerCase();

        let label = '';
        if (roleLower === 'system') label = 'System';
        else if (roleLower === 'assistant') label = 'Assistant';
        else if (roleLower === 'user') label = 'User';

        const actionText = isEndMarker ? '结束' : '起始';

        return `\n\n<div class="vcp-role-divider role-${roleLower} type-${isEndMarker ? 'end' : 'start'}" data-vcp-block-type="role-divider" data-vcp-preserve-children="true"><span class="divider-text">角色分界: ${label} [${actionText}]</span></div>\n\n`;
    });

    return processed;
}

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
    contentClone.querySelectorAll(
        '.vcp-tool-use-bubble, .vcp-tool-result-bubble, .maid-diary-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, style, script'
    ).forEach(el => el.remove());

    return (contentClone.innerText || '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Extracts <style> tags from content, scopes the CSS, and injects it into the document head.
 * @param {string} content - The raw message content string.
 * @param {string} scopeId - The unique ID for scoping.
 * @returns {{processedContent: string, styleInjected: boolean}} The content with <style> tags removed, and a flag indicating if styles were injected.
 */
function processAndInjectScopedCss(content, scopeId) {
    let cssContent = '';
    let styleInjected = false;

    const processedContent = content.replace(STYLE_REGEX, (match, css) => {
        cssContent += css.trim() + '\n';
        return ''; // Remove style tags from the content
    });

    if (cssContent.length > 0) {
        try {
            const scopedCss = contentProcessor.scopeCss(cssContent, scopeId);

            const styleElement = document.createElement('style');
            styleElement.type = 'text/css';
            styleElement.setAttribute('data-vcp-scope-id', scopeId);
            styleElement.textContent = scopedCss;
            document.head.appendChild(styleElement);
            styleInjected = true;

            console.debug(`[ScopedCSS] Injected scoped styles for ID: #${scopeId}`);
        } catch (error) {
            console.error(`[ScopedCSS] Failed to scope or inject CSS for ID: ${scopeId}`, error);
        }
    }

    return { processedContent, styleInjected };
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
function ensureHtmlFenced(text) {
    const doctypeTag = '<!DOCTYPE html>';
    const htmlCloseTag = '</html>';
    const lowerText = text.toLowerCase();

    // 已在代码块中，不处理
    if (HTML_FENCE_CHECK_REGEX.test(text)) {
        return text;
    }

    // 快速检查：没有 doctype 直接返回
    if (!lowerText.includes(doctypeTag.toLowerCase())) {
        return text;
    }

    // 🟢 构建「始」「末」与「始ESCAPE」「末ESCAPE」及其变体保护区域
    const protectedRanges = [];
    const startRegex = /([「{]始(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}])/gi;
    let searchStart = 0;

    while (true) {
        startRegex.lastIndex = searchStart;
        const startMatch = startRegex.exec(text);
        if (!startMatch) break;

        const startPos = startMatch.index;
        const startMarker = startMatch[0];

        const isEscape = /escape/i.test(startMarker);
        let endRegex;
        if (isEscape) {
            endRegex = /[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}]/gi;
        } else {
            endRegex = /[「{]末[」}]/g;
        }

        const contentStart = startPos + startMarker.length;
        endRegex.lastIndex = contentStart;
        const endMatch = endRegex.exec(text);

        if (!endMatch) {
            // 未闭合的开始标记，保护到文本末尾（流式传输场景）
            protectedRanges.push({ start: startPos, end: text.length });
            break;
        }

        const endPos = endMatch.index;
        const endMarker = endMatch[0];

        protectedRanges.push({ start: startPos, end: endPos + endMarker.length });
        searchStart = endPos + endMarker.length;
    }

    // 🟢 检查位置是否在保护区域内
    const isProtected = (index) => {
        return protectedRanges.some(range => index >= range.start && index < range.end);
    };

    let result = '';
    let lastIndex = 0;

    while (true) {
        const startIndex = text.toLowerCase().indexOf(doctypeTag.toLowerCase(), lastIndex);

        result += text.substring(lastIndex, startIndex === -1 ? text.length : startIndex);

        if (startIndex === -1) break;

        const endIndex = text.toLowerCase().indexOf(htmlCloseTag.toLowerCase(), startIndex + doctypeTag.length);

        if (endIndex === -1) {
            result += text.substring(startIndex);
            break;
        }

        const block = text.substring(startIndex, endIndex + htmlCloseTag.length);

        // 🔴 核心修复：如果在「始」「末」保护区内，直接添加不封装
        if (isProtected(startIndex)) {
            result += block;
            lastIndex = endIndex + htmlCloseTag.length;
            continue;
        }

        // 正常逻辑：检查是否已在代码块内
        const fencesInResult = (result.match(/```/g) || []).length;

        if (fencesInResult % 2 === 0) {
            result += `\n\`\`\`html\n${block}\n\`\`\`\n`;
        } else {
            result += block;
        }

        lastIndex = endIndex + htmlCloseTag.length;
    }

    return result;
}


/**
 * Removes leading whitespace from lines that appear to be HTML tags,
 * as long as they are not inside a fenced code block. This prevents
 * the markdown parser from misinterpreting indented HTML as an indented code block.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
function deIndentHtml(text) {
    const lines = text.split('\n');
    let inFence = false;
    return lines.map(line => {
        if (line.trim().startsWith('```')) {
            inFence = !inFence;
            return line;
        }

        // 🟢 新增：如果行内包含 <img>，不要拆分它
        if (!inFence && line.includes('<img')) {
            return line; // 保持原样
        }

        if (!inFence && /^\s+<(!|[a-zA-Z])/.test(line)) {
            return line.trimStart();
        }
        return line;
    }).join('\n');
}


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
function preprocessFullContent(text, settings = {}, messageRole = 'assistant', depth = 0) {
    if (!contentPipeline) {
        console.warn('[MessageRenderer] contentPipeline not initialized, falling back to raw text');
        return { text, toolResultMap: null };
    }

    const result = contentPipeline.process(text, {
        mode: PIPELINE_MODES.FULL_RENDER,
        settings,
        messageRole,
        depth
    });

    return { text: result.text, toolResultMap: result.state.toolResultMap || null };
}

function preprocessStreamTailContent(text) {
    if (!contentPipeline) {
        console.warn('[MessageRenderer] contentPipeline not initialized for stream tail, falling back to raw text');
        return text;
    }

    return contentPipeline.process(text, {
        mode: PIPELINE_MODES.STREAM_FAST
    }).text;
}

function estimateStringBytes(str) {
    return typeof str === 'string' ? str.length * 2 : 0;
}

function hashStringFNV1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}

function buildRenderSettingsFingerprint(settings = {}) {
    // 仅纳入会影响 Markdown → raw HTML 或按钮标记处理的稳定设置；后续新增渲染相关设置时可 bump RENDER_PIPELINE_VERSION。
    return JSON.stringify({
        enableAiMessageButtons: settings.enableAiMessageButtons !== false
    });
}

function shouldBypassRenderHtmlCache(text, options = {}) {
    if (typeof text !== 'string' || !text) return true;
    if (text.length < RENDER_HTML_CACHE_MIN_TEXT_LENGTH) return true;
    if (text.length > RENDER_HTML_CACHE_MAX_TEXT_LENGTH) return true;

    // scoped CSS 有 scopeId 与 document.head 注入副作用，第一版保守跳过。
    if ((options.messageRole || 'assistant') === 'assistant' && text.includes('<style')) return true;

    return false;
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
        text.length,
        hashStringFNV1a(text)
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

    return entry.html;
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

function setRenderHtmlCache(key, html) {
    const size = estimateStringBytes(html);
    if (size <= 0 || size > RENDER_HTML_CACHE_MAX_SINGLE_BYTES) {
        return;
    }

    if (renderHtmlCache.has(key)) {
        const old = renderHtmlCache.get(key);
        renderHtmlCacheBytes -= old?.size || 0;
        renderHtmlCache.delete(key);
    }

    renderHtmlCache.set(key, {
        html,
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

function renderMarkdownToHtmlUncached(text, options = {}) {
    const markedInstance = mainRendererReferences.markedInstance;
    if (!markedInstance) return escapeHtml(text);

    const globalSettings = options.settings || mainRendererReferences.globalSettingsRef.get();
    const {
        messageRole = 'assistant',
        depth = 0
    } = options;

    const { text: processedText, toolResultMap } = preprocessFullContent(text, globalSettings, messageRole, depth);
    const { text: protectedText, map: latexMap } = protectLatexBlocks(processedText);
    let html = markedInstance.parse(protectedText);
    html = restoreLatexBlocks(html, latexMap);
    html = restoreRenderedToolResults(html, toolResultMap);
    return html;
}

function renderMarkdownToHtml(text, options = {}) {
    const markedInstance = mainRendererReferences.markedInstance;
    if (!markedInstance) return escapeHtml(text);

    if (shouldBypassRenderHtmlCache(text, options)) {
        renderHtmlCacheStats.skips += 1;
        return renderMarkdownToHtmlUncached(text, options);
    }

    const cacheKey = buildRenderHtmlCacheKey(text, options);
    const cachedHtml = getRenderHtmlCache(cacheKey);
    if (cachedHtml !== null) {
        return cachedHtml;
    }

    renderHtmlCacheStats.misses += 1;
    const html = renderMarkdownToHtmlUncached(text, options);
    setRenderHtmlCache(cacheKey, html);
    return html;
}

function parseFullMarkdown(text, options = {}) {
    return renderMarkdownToHtml(text, options);
}

function parseStreamTailMarkdown(text) {
    const markedInstance = mainRendererReferences.markedInstance;
    if (!markedInstance) return escapeHtml(text);

    const processedText = preprocessStreamTailContent(text);
    return markedInstance.parse(processedText);
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
function renderToolResultBlock(fullMatch) {
    const startMarker = '[[VCP调用结果信息汇总:';
    const endMarker = 'VCP调用结果结束]]';
    const markdownFieldKeys = new Set(['返回内容', '内容', 'Result', '返回结果', 'output']);
    const knownFieldKeys = new Set(['工具名称', '执行状态', '命令', '参数', '返回内容', '内容', 'Result', '返回结果', 'output', '可访问URL', 'url', 'image']);
    let content = fullMatch;
    if (content.startsWith(startMarker)) {
        content = content.slice(startMarker.length);
    }
    if (content.endsWith(endMarker)) {
        content = content.slice(0, -endMarker.length);
    }
    content = content.trim();

    const lines = content.split('\n');
    let toolName = 'Unknown Tool';
    let status = 'Unknown Status';
    const details = [];
    let otherContent = [];
    let currentKey = null;
    let currentValue = [];

    lines.forEach(line => {
        const kvMatch = line.match(/^-\s*([^:]+):\s*(.*)/);
        const matchedKey = kvMatch?.[1]?.trim();
        const isKnownField = matchedKey && knownFieldKeys.has(matchedKey);
        const shouldStartNewField = isKnownField && !markdownFieldKeys.has(currentKey);

        if (shouldStartNewField) {
            if (currentKey) {
                const val = currentValue.join('\n').trim();
                if (currentKey === '工具名称') toolName = val;
                else if (currentKey === '执行状态') status = val;
                else details.push({ key: currentKey, value: val });
            }
            currentKey = matchedKey;
            currentValue = [kvMatch[2].trim()];
        } else if (currentKey) {
            currentValue.push(line);
        } else if (line.trim() !== '') {
            otherContent.push(line);
        }
    });

    if (currentKey) {
        const val = currentValue.join('\n').trim();
        if (currentKey === '工具名称') toolName = val;
        else if (currentKey === '执行状态') status = val;
        else details.push({ key: currentKey, value: val });
    }

    let html = `<div class="vcp-tool-result-bubble collapsible" data-vcp-block-type="tool-result" data-vcp-preserve-children="true">`;
    html += `<div class="vcp-tool-result-header">`;
    html += `<span class="vcp-tool-result-label">VCP-ToolResult</span>`;
    html += `<span class="vcp-tool-result-name">${escapeHtml(toolName)}</span>`;
    html += `<span class="vcp-tool-result-status">${escapeHtml(status)}</span>`;
    html += `<span class="vcp-result-toggle-icon"></span>`;
    html += `</div>`;

    html += `<div class="vcp-tool-result-collapsible-content">`;
    html += `<div class="vcp-tool-result-details">`;

    details.forEach(({ key, value }) => {
        const isMarkdownField = markdownFieldKeys.has(key);
        const isImageUrl = typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value) && /\.(jpeg|jpg|png|gif|webp)([?&#]|$)/i.test(value);
        let processedValue;

        if (isImageUrl && (key === '可访问URL' || key === '返回内容' || key === 'url' || key === 'image')) {
            processedValue = `<a href="${value}" target="_blank" rel="noopener noreferrer" title="点击预览"><img src="${value}" class="vcp-tool-result-image" alt="Generated Image"></a>`;
        } else if (isMarkdownField) {
            // 🟢 架构级修复：工具结果内容使用独立的 Markdown 渲染
            // 由于工具结果块已经从外部文本中完全隔离，这里可以安全地使用 Markdown 解析器
            // 支持表格、代码围栏、列表等完整 Markdown 语法，不再需要 escapeHtml + <pre> 的妥协方案

            // 🟢 性能优化：大内容二级截断
            const isLargeContent = value.length > TOOL_RESULT_TRUNCATE_THRESHOLD;
            let valueToRender = value;
            let truncationNotice = '';

            if (isLargeContent) {
                // 截断到前 N 行
                const allLines = value.split('\n');
                const truncatedLines = allLines.slice(0, TOOL_RESULT_TRUNCATE_LINES);
                valueToRender = truncatedLines.join('\n');

                // 存储完整内容供懒加载
                const contentId = toolResultContentIdCounter++;
                toolResultFullContentMap.set(contentId, { raw: value, fieldKey: key });

                const remainingLines = allLines.length - TOOL_RESULT_TRUNCATE_LINES;
                const sizeKB = Math.round(value.length / 1024);
                truncationNotice = `<div class="vcp-tool-result-truncated-notice" data-content-id="${contentId}">` +
                    `<span>📄 内容已截断（共 ${allLines.length} 行 / ${sizeKB}KB），当前显示前 ${TOOL_RESULT_TRUNCATE_LINES} 行</span>` +
                    `<span style="font-weight:600;">点击展开全部</span>` +
                    `</div>`;
            }

            let renderedMarkdown;
            if (mainRendererReferences.markedInstance) {
                try {
                    renderedMarkdown = mainRendererReferences.markedInstance.parse(valueToRender);
                } catch (e) {
                    renderedMarkdown = `<pre class="vcp-tool-result-raw-content">${escapeHtml(valueToRender)}</pre>`;
                }
            } else {
                renderedMarkdown = `<pre class="vcp-tool-result-raw-content">${escapeHtml(valueToRender)}</pre>`;
            }
            processedValue = `<div class="vcp-tool-result-markdown-content">${renderedMarkdown}</div>${truncationNotice}`;
        } else {
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            processedValue = escapeHtml(value);
            processedValue = processedValue.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

            if (key === '返回内容') {
                processedValue = processedValue.replace(/###(.*?)###/g, '<strong>$1</strong>');
            }
        }

        const itemClass = (isMarkdownField && !isImageUrl)
            ? 'vcp-tool-result-item vcp-tool-result-item-markdown'
            : 'vcp-tool-result-item';
        html += `<div class="${itemClass}">`;
        html += `<span class="vcp-tool-result-item-key">${escapeHtml(key)}:</span> `;
        const valueTag = (isMarkdownField && !isImageUrl) ? 'div' : 'span';
        html += `<${valueTag} class="vcp-tool-result-item-value">${processedValue}</${valueTag}>`;
        html += `</div>`;
    });
    html += `</div>`;

    if (otherContent.length > 0) {
        const footerText = otherContent.join('\n');
        const processedFooter = `<pre class="vcp-tool-result-raw-content">${escapeHtml(footerText)}</pre>`;
        html += `<div class="vcp-tool-result-footer">${processedFooter}</div>`;
    }

    html += `</div>`;
    html += `</div>`;

    return html;
}

/**
 * 🟢 在 Markdown 解析后恢复工具结果占位符为渲染好的 HTML
 * @param {string} html - marked.parse() 输出的 HTML
 * @param {Map|null} toolResultMap - 占位符到原始工具结果文本的映射
 * @returns {string} 恢复后的 HTML
 */
function restoreRenderedToolResults(html, toolResultMap) {
    if (!toolResultMap || toolResultMap.size === 0 || typeof html !== 'string') return html;

    // P1-5：工具结果占位符使用 HTML 注释格式，单遍匹配即可恢复。
    // 同时兼容 marked 将注释占位符包裹成 <p><!--VCP_TOOL_RESULT_n--></p> 的情况。
    return html.replace(/<p>\s*(<!--VCP_TOOL_RESULT_(\d+)-->)\s*<\/p>|<!--VCP_TOOL_RESULT_(\d+)-->/g, (match, wrappedPlaceholder, wrappedId, bareId) => {
        const placeholder = wrappedPlaceholder || `<!--VCP_TOOL_RESULT_${bareId}-->`;
        const rawMatch = toolResultMap.get(placeholder);
        if (!rawMatch) return match;
        return `\n\n${renderToolResultBlock(rawMatch)}\n\n`;
    });
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


let mainRendererReferences = {
    currentChatHistoryRef: { get: () => [], set: () => { } }, // Ref to array
    currentSelectedItemRef: { get: () => ({ id: null, type: null, name: null, avatarUrl: null, config: null }), set: () => { } }, // Ref to object
    currentTopicIdRef: { get: () => null, set: () => { } }, // Ref to string/null
    globalSettingsRef: { get: () => ({ userName: '用户', userAvatarUrl: 'assets/default_user_avatar.png', userAvatarCalculatedColor: null }), set: () => { } }, // Ref to object

    chatMessagesDiv: null,
    electronAPI: null,
    markedInstance: null,
    uiHelper: {
        scrollToBottom: () => { },
        openModal: () => { },
        autoResizeTextarea: () => { },
        // ... other uiHelper functions ...
    },
    summarizeTopicFromMessages: async () => "",
    handleCreateBranch: () => { },
    // activeStreamingMessageId: null, // ID of the message currently being streamed - REMOVED
};


let contentPipeline = null;

let activeRenderSessionId = 0;

function invalidateRenderSession() {
    activeRenderSessionId += 1;
    return activeRenderSessionId;
}

function getActiveRenderSessionId() {
    return activeRenderSessionId;
}

function isRenderSessionActive(sessionId) {
    return sessionId === activeRenderSessionId;
}

function removeMessageById(messageId, saveHistory = false) {
    const item = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (item) {
        // --- NEW: Cleanup dynamic content before removing from DOM ---
        const contentDiv = item.querySelector('.md-content');
        if (contentDiv) {
            contentProcessor.cleanupPreviewsInContent(contentDiv);
            cleanupAnimationsInContent(contentDiv);
        }
        // [Pretext集成] 释放高度缓存，防止内存泄漏
        if (window.pretextBridge && window.pretextBridge.evict) {
            window.pretextBridge.evict(messageId);
        }
        // 停止观察消息可见性
        visibilityOptimizer.unobserveMessage(item);
        item.remove();
    }

    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const index = currentChatHistoryArray.findIndex(m => m.id === messageId);

    if (index > -1) {
        currentChatHistoryArray.splice(index, 1);
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);
        window.updateSendButtonState?.();

        if (saveHistory) {
            const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
            const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();
            if (currentSelectedItemVal.id && currentTopicIdVal) {
                if (currentSelectedItemVal.type === 'agent') {
                    mainRendererReferences.electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                } else if (currentSelectedItemVal.type === 'group' && mainRendererReferences.electronAPI.saveGroupChatHistory) {
                    mainRendererReferences.electronAPI.saveGroupChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                }
            }
        }
    }
}

function clearChat() {
    invalidateRenderSession();

    // 清空聊天通常意味着用户希望释放当前渲染上下文占用；HTML 字符串缓存不持有 DOM，但这里主动释放更保守。
    clearRenderHtmlCache();

    // 只清理当前视图的 DOM/渲染相关内容，不触碰底层异步流状态
    // 这样可避免切换话题时误伤同窗口内其他 agent 的后台流式聊天
    toolResultFullContentMap.clear();
    toolResultContentIdCounter = 0;

    if (mainRendererReferences.chatMessagesDiv) {
        // --- NEW: Cleanup all messages before clearing the container ---
        const allMessages = mainRendererReferences.chatMessagesDiv.querySelectorAll('.message-item');
        allMessages.forEach(item => {
            const contentDiv = item.querySelector('.md-content');
            if (contentDiv) {
                contentProcessor.cleanupPreviewsInContent(contentDiv);
                cleanupAnimationsInContent(contentDiv);
            }
            visibilityOptimizer.unobserveMessage(item);
        });

        // 🟢 清理所有注入的 scoped CSS
        document.querySelectorAll('style[data-vcp-scope-id]').forEach(el => el.remove());
        document.querySelectorAll('style[data-chat-scope-id]').forEach(el => el.remove());

        // [Pretext集成] 清空所有高度缓存
        if (window.pretextBridge && window.pretextBridge.clearAll) {
            window.pretextBridge.clearAll();
        }

        mainRendererReferences.chatMessagesDiv.innerHTML = '';
    }
    mainRendererReferences.currentChatHistoryRef.set([]); // Clear the history array via its ref
    window.updateSendButtonState?.();
}


function initializeMessageRenderer(refs) {
    Object.assign(mainRendererReferences, refs);

    contentPipeline = createContentPipeline({
        escapeHtml,
        processStartEndMarkers: contentProcessor.processStartEndMarkers,
        fixEmoticonUrlsInMarkdown,
        deIndentMisinterpretedCodeBlocks: contentProcessor.deIndentMisinterpretedCodeBlocks,
        deIndentHtml,
        deIndentToolRequestBlocks: contentProcessor.deIndentToolRequestBlocks,
        applyContentProcessors: contentProcessor.applyContentProcessors,
        transformSpecialBlocks,
        ensureHtmlFenced,
        transformMermaidPlaceholders: (text) => {
            let transformed = text.replace(MERMAID_CODE_REGEX, (match, lang, code) => {
                const tempEl = document.createElement('textarea');
                tempEl.innerHTML = code;
                const encodedCode = encodeURIComponent(tempEl.value.trim());
                return `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodedCode}"></div>`;
            });

            transformed = transformed.replace(MERMAID_FENCE_REGEX, (match, lang, code) => {
                const encodedCode = encodeURIComponent(code.trim());
                return `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodedCode}"></div>`;
            });

            return transformed;
        },
        getToolResultRegex: () => TOOL_RESULT_REGEX,
        getToolRequestRegex: () => TOOL_REGEX,
        replaceToolRequestBlocks,
        getCodeFenceRegex: () => CODE_FENCE_REGEX,
        getDesktopPushRegex: () => DESKTOP_PUSH_REGEX,
        getDesktopPushPartialRegex: () => DESKTOP_PUSH_PARTIAL_REGEX,
    });

    initializeImageHandler({
        electronAPI: mainRendererReferences.electronAPI,
        uiHelper: mainRendererReferences.uiHelper,
        chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
    });

    // Start the emoticon fixer initialization, but don't wait for it here.
    // The await will happen inside renderMessage to ensure it's ready before rendering.
    emoticonUrlFixer.initialize(mainRendererReferences.electronAPI);

    // 初始化可见性优化器
    // 🟢 关键修复：IntersectionObserver 的 root 必须是产生滚动条的那个父容器
    const scrollContainer = mainRendererReferences.chatMessagesDiv.closest('.chat-messages-container');
    visibilityOptimizer.initializeVisibilityOptimizer(scrollContainer || mainRendererReferences.chatMessagesDiv);

    // --- Event Delegation ---
    mainRendererReferences.chatMessagesDiv.addEventListener('click', (e) => {
        // 1. Handle collapsible tool results and thought chains
        const toolHeader = e.target.closest('.vcp-tool-result-header');
        if (toolHeader) {
            const bubble = toolHeader.closest('.vcp-tool-result-bubble.collapsible');
            if (bubble) {
                bubble.classList.toggle('expanded');
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
                    let fullHtml;
                    if (mainRendererReferences.markedInstance) {
                        try {
                            fullHtml = mainRendererReferences.markedInstance.parse(fullData.raw);
                        } catch (err) {
                            fullHtml = `<pre class="vcp-tool-result-raw-content">${escapeHtml(fullData.raw)}</pre>`;
                        }
                    } else {
                        fullHtml = `<pre class="vcp-tool-result-raw-content">${escapeHtml(fullData.raw)}</pre>`;
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

        // 4. Avatar 点击停止 TTS（也使用委托）
        const avatar = e.target.closest('.message-avatar');
        if (avatar) {
            const messageItem = avatar.closest('.message-item');
            if (messageItem?.dataset.role === 'assistant') {
                mainRendererReferences.electronAPI.sovitsStop();
            }
        }
    });

    // Delegated context menu
    mainRendererReferences.chatMessagesDiv.addEventListener('contextmenu', (e) => {
        const messageItem = e.target.closest('.message-item');
        if (!messageItem) return;

        const messageId = messageItem.dataset.messageId;
        const message = mainRendererReferences.currentChatHistoryRef.get()
            .find(m => m.id === messageId);

        if (message && (message.role === 'assistant' || message.role === 'user')) {
            e.preventDefault();
            contextMenu.showContextMenu(e, messageItem, message);
        }
    });

    // Delegated middle mouse button click
    mainRendererReferences.chatMessagesDiv.addEventListener('mousedown', (e) => {
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

    contextMenu.initializeContextMenu(mainRendererReferences, {
        removeMessageById: removeMessageById,
        finalizeStreamedMessage: finalizeStreamedMessage,
        renderMessage: renderMessage,
        startStreamingMessage: startStreamingMessage,
        setContentAndProcessImages: setContentAndProcessImages,
        processRenderedContent: wrappedProcessRenderedContent,
        runTextHighlights: contentProcessor.highlightAllPatternsInMessage,
        preprocessFullContent: preprocessFullContent,
        renderAttachments: renderAttachments,
        interruptHandler: mainRendererReferences.interruptHandler,
        updateMessageContent: updateMessageContent, // 🟢 新增：传递 updateMessageContent
        extractSpeakableTextFromContentElement: extractSpeakableTextFromContentElement,
    });

    if (typeof contextMenu.toggleEditMode === 'function') {
        window.toggleEditMode = contextMenu.toggleEditMode;
        window.messageContextMenu = contextMenu;
    }

    streamManager.initStreamManager({
        globalSettingsRef: mainRendererReferences.globalSettingsRef,
        currentChatHistoryRef: mainRendererReferences.currentChatHistoryRef,
        currentSelectedItemRef: mainRendererReferences.currentSelectedItemRef,
        currentTopicIdRef: mainRendererReferences.currentTopicIdRef,
        chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
        parseTail: parseStreamTailMarkdown,
        parseFull: parseFullMarkdown,
        prepareFinalTextForRender: prepareFinalTextForRender,
        renderMermaidDiagrams: renderMermaidDiagrams,
        electronAPI: mainRendererReferences.electronAPI,
        uiHelper: mainRendererReferences.uiHelper,
        morphdom: window.morphdom,
        renderMessage: renderMessage,
        showContextMenu: contextMenu.showContextMenu,
        setContentAndProcessImages: setContentAndProcessImages,
        processRenderedContent: wrappedProcessRenderedContent,
        runTextHighlights: contentProcessor.highlightAllPatternsInMessage,
        preprocessFullContent: preprocessFullContent,
        removeSpeakerTags: contentProcessor.removeSpeakerTags,
        ensureNewlineAfterCodeBlock: contentProcessor.ensureNewlineAfterCodeBlock,
        ensureSpaceAfterTilde: contentProcessor.ensureSpaceAfterTilde,
        removeIndentationFromCodeBlockMarkers: contentProcessor.removeIndentationFromCodeBlockMarkers,
        deIndentMisinterpretedCodeBlocks: contentProcessor.deIndentMisinterpretedCodeBlocks, // 🟢 传递新函数
        processStartEndMarkers: contentProcessor.processStartEndMarkers, // 🟢 传递安全处理函数
        ensureSeparatorBetweenImgAndCode: contentProcessor.ensureSeparatorBetweenImgAndCode,
        processAnimationsInContent: processAnimationsInContent,
        renderPostProcessedHtml: renderPostProcessedHtml,
        emoticonUrlFixer: emoticonUrlFixer, // 🟢 Pass emoticon fixer for live updates
        enhancedRenderDebounceTimers: enhancedRenderDebounceTimers,
        ENHANCED_RENDER_DEBOUNCE_DELAY: ENHANCED_RENDER_DEBOUNCE_DELAY,
        DIARY_RENDER_DEBOUNCE_DELAY: DIARY_RENDER_DEBOUNCE_DELAY,
    });

    middleClickHandler.initialize(mainRendererReferences, {
        removeMessageById: removeMessageById,
    });

    // --- 用户气泡文件拖拽支持 ---
    mainRendererReferences.chatMessagesDiv.addEventListener('dragover', (e) => {
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

    mainRendererReferences.chatMessagesDiv.addEventListener('dragleave', (e) => {
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

    mainRendererReferences.chatMessagesDiv.addEventListener('drop', async (e) => {
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
            if (window.chatManager && window.chatManager.processFilesData) {
                // 使用通用的文件读取管线
                const processedFiles = await window.chatManager.processFilesData(files);
                const successfulFiles = processedFiles.filter(f => !f.error);
                
                if (successfulFiles.length > 0) {
                    window.chatManager.addAttachmentsToMessage(messageId, successfulFiles);
                } else if (processedFiles.length > 0) {
                    const firstError = processedFiles.find(f => f.error)?.error;
                    console.error(`[MessageRenderer] All files failed to process: ${firstError}`);
                    if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                        window.uiHelperFunctions.showToastNotification(`读取文件失败: ${firstError}`, 'error');
                    }
                }
            } else {
                console.error('[MessageRenderer] window.chatManager.processFilesData not available!');
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
function getAttachmentFileVisualDescriptor(name = '', type = '') {
    const resolver = window.uiHelperFunctions?.resolveAttachmentFileVisual;
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
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.classList.add('message-attachments');
        message.attachments.forEach((att, index) => {
            const wrapper = document.createElement('div');
            wrapper.classList.add('message-attachment-wrapper');
            
            let attachmentElement;
            if (att.type.startsWith('image/')) {
                attachmentElement = document.createElement('img');
                attachmentElement.src = att.src;
                attachmentElement.alt = `附件图片: ${att.name}`;
                attachmentElement.title = `点击在新窗口预览: ${att.name}`;
                attachmentElement.classList.add('message-attachment-image-thumbnail');
                attachmentElement.onclick = (e) => {
                    e.stopPropagation();
                    const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
                    electronAPI.openImageViewer({ src: att.src, title: att.name, theme: currentTheme });
                };
                attachmentElement.addEventListener('contextmenu', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    electronAPI.showImageContextMenu(att.src);
                });
            } else if (att.type.startsWith('audio/')) {
                attachmentElement = document.createElement('audio');
                attachmentElement.src = att.src;
                attachmentElement.controls = true;
            } else if (att.type.startsWith('video/')) {
                attachmentElement = document.createElement('video');
                attachmentElement.src = att.src;
                attachmentElement.controls = true;
                attachmentElement.style.maxWidth = '300px';
            } else {
                attachmentElement = document.createElement('a');
                attachmentElement.href = att.src;
                const fileVisual = getAttachmentFileVisualDescriptor(att.name, att.type);
                attachmentElement.classList.add('message-attachment-file', `message-attachment-file--${fileVisual.kind}`);
                attachmentElement.title = `点击打开文件: ${att.name}`;
                attachmentElement.onclick = (e) => {
                    e.preventDefault();
                    if (electronAPI.sendOpenExternalLink && att.src.startsWith('file://')) {
                        electronAPI.sendOpenExternalLink(att.src);
                    } else {
                        console.warn("Cannot open local file attachment", att.src);
                    }
                };
                const iconSpan = document.createElement('span');
                iconSpan.className = 'message-attachment-file-icon';
                iconSpan.innerHTML = fileVisual.iconMarkup;
                const nameSpan = document.createElement('span');
                nameSpan.className = 'message-attachment-file-name';
                nameSpan.textContent = att.name;
                attachmentElement.appendChild(iconSpan);
                attachmentElement.appendChild(nameSpan);
            }
            if (attachmentElement) {
                wrapper.appendChild(attachmentElement);
                // 添加删除按钮
                const removeBtn = document.createElement('div');
                removeBtn.className = 'message-attachment-remove-btn';
                removeBtn.innerHTML = '&times;';
                removeBtn.title = '移除此附件';
                removeBtn.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (window.chatManager && window.chatManager.removeAttachmentFromMessage) {
                        window.chatManager.removeAttachmentFromMessage(message.id, index);
                    }
                };
                wrapper.appendChild(removeBtn);
                attachmentsContainer.appendChild(wrapper);
            }
        });
        contentDiv.appendChild(attachmentsContainer);
    }
}

async function renderPostProcessedHtml(contentDiv, rawHtml, options = {}) {
    if (!contentDiv) return;

    const {
        messageId = null,
        message = null,
        settings = mainRendererReferences.globalSettingsRef.get(),
        renderSessionId = getActiveRenderSessionId(),
        runHeavy = true,
        includeAttachments = true,
        deferHighlights = true
    } = options;

    const messageItem = contentDiv.closest?.('.message-item');

    const isStillValid = () => {
        if (renderSessionId !== null && !isRenderSessionActive(renderSessionId)) return false;
        if (!contentDiv.isConnected) return false;
        if (messageItem && !messageItem.isConnected) return false;
        return true;
    };

    if (typeof rawHtml === 'string') {
        setContentAndProcessImages(contentDiv, rawHtml, messageId);
    }

    if (!isStillValid()) return;

    if (includeAttachments && message) {
        const existingAttachments = contentDiv.querySelector('.message-attachments');
        if (existingAttachments) existingAttachments.remove();
        await renderAttachments(message, contentDiv);
    }

    if (!isStillValid()) return;

    if (!runHeavy) {
        if (messageItem) {
            messageItem.dataset.vcpHeavyPending = 'true';
        }
        contentDiv.dataset.vcpHeavyPending = 'true';
        return;
    }

    contentProcessor.processRenderedContent(contentDiv, settings);
    await renderMermaidDiagrams(contentDiv);

    if (!isStillValid()) return;

    if (deferHighlights) {
        setTimeout(() => {
            if (isStillValid()) {
                contentProcessor.highlightAllPatternsInMessage(contentDiv);
            }
        }, 0);
    } else {
        contentProcessor.highlightAllPatternsInMessage(contentDiv);
    }

    processAnimationsInContent(contentDiv);
    if (messageItem) {
        messageItem.dataset.vcpHeavyActivated = 'true';
        delete messageItem.dataset.vcpHeavyPending;
    }
    contentDiv.dataset.vcpHeavyActivated = 'true';
    delete contentDiv.dataset.vcpHeavyPending;
}

async function renderMessage(message, isInitialLoad = false, appendToDom = true, renderSessionId = getActiveRenderSessionId(), renderContext = {}) {
    // console.debug('[MessageRenderer renderMessage] Received message:', JSON.parse(JSON.stringify(message)));
    const { chatMessagesDiv, electronAPI, markedInstance, uiHelper } = mainRendererReferences;
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentChatHistory = mainRendererReferences.currentChatHistoryRef.get();

    // Prevent re-rendering if the message already exists in the DOM, unless it's a thinking message being replaced.
    const existingMessageDom = chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
    if (existingMessageDom && !existingMessageDom.classList.contains('thinking')) {
        // console.log(`[MessageRenderer] Message ${message.id} already in DOM. Skipping render.`);
        // return existingMessageDom;
    }

    if (!chatMessagesDiv || !electronAPI || !markedInstance) {
        console.error("MessageRenderer: Missing critical references for rendering.");
        return null;
    }

    if (!message.id) {
        message.id = `msg_${message.timestamp}_${Math.random().toString(36).substring(2, 9)}`;
    }

    const { messageItem, contentDiv, avatarImg, senderNameDiv } = createMessageSkeleton(message, globalSettings, currentSelectedItem);

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
            avatarColorToUse = message.avatarColor;
            avatarUrlToUse = message.avatarUrl;
            // 群组消息中的Agent，获取其自定义颜色
            if (message.agentId) {
                const agentConfig = currentSelectedItem?.config?.agents?.find(a => a.id === message.agentId);
                if (agentConfig) {
                    useThemeColors = agentConfig.useThemeColorsInChat || false;
                    if (!useThemeColors) {
                        customBorderColor = agentConfig.avatarBorderColor;
                        customNameColor = agentConfig.nameTextColor;
                    }
                }
            }
        } else if (currentSelectedItem) {
            avatarColorToUse = currentSelectedItem.config?.avatarCalculatedColor
                || currentSelectedItem.avatarCalculatedColor
                || currentSelectedItem.config?.avatarColor
                || currentSelectedItem.avatarColor;
            avatarUrlToUse = currentSelectedItem.avatarUrl;

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
        chatMessagesDiv.appendChild(messageItem);
        // 观察新消息的可见性
        visibilityOptimizer.observeMessage(messageItem);
    }

    if (message.isThinking) {
        contentDiv.innerHTML = `<span class="thinking-indicator">${message.content || '思考中'}<span class="thinking-indicator-dots">...</span></span>`;
        messageItem.classList.add('thinking');
    } else {
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
        } else if (message.role === 'assistant' && scopeId && textToRender.includes('<style')) {
            // --- 🟢 关键修复：先保护所有可能包含 <style> 的特殊区域，再提取样式 ---
            // 这样可以避免代码块、推送块、工具请求块、工具结果块和「始」「末」标记内的 <style> 被误当作真正的样式注入
            // 性能快路径：绝大多数消息不含 <style>，入口已用 includes('<style') 跳过保护扫描。
            const protectedBlocks = [];

            // 🔴 最高优先级：保护工具结果块（[[VCP调用结果信息汇总:...VCP调用结果结束]]）
            // 工具结果可能包含任意内容（大型 markdown 文件、代码、「始」「末」标记等）
            // 必须在「始」「末」标记保护之前运行，否则结果内部的标记会被错误匹配
            TOOL_RESULT_REGEX.lastIndex = 0;
            let textWithProtectedBlocks = textToRender.replace(TOOL_RESULT_REGEX, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
                protectedBlocks.push(match);
                return placeholder;
            });
            TOOL_RESULT_REGEX.lastIndex = 0;
            
            // 🔴 保护工具请求块（<<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>>）
            // 工具请求参数中可能包含完整的HTML文档（如壁纸HTML），其中的 <style> 不应被注入
            // 使用 ESCAPE 感知的扫描器，避免参数内容里的 END 标记导致工具块提前闭合
            textWithProtectedBlocks = replaceToolRequestBlocks(textWithProtectedBlocks, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
                protectedBlocks.push(match);
                return placeholder;
            });
            
            // 🔴 保护「始」「末」与「始ESCAPE」「末ESCAPE」标记区域及其变体
            // 这些标记内的内容是工具参数，可能包含任意HTML（含<style>），不应被提取
            // 注意：ESCAPE 必须优先按「末ESCAPE」闭合，不能被内部普通「末」打断
            textWithProtectedBlocks = textWithProtectedBlocks.replace(/(?:[「{]始[Ee][Ss][Cc][Aa][Pp][Ee][」}])[\s\S]*?(?:(?:[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}])|$)/gi, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
                protectedBlocks.push(match);
                return placeholder;
            });
            textWithProtectedBlocks = textWithProtectedBlocks.replace(/(?:[「{]始[」}])[\s\S]*?(?:(?:[「{]末[」}])|$)/g, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
                protectedBlocks.push(match);
                return placeholder;
            });
            
            // 保护桌面推送块（必须在代码块之前，因为推送块可能包含代码围栏）
            textWithProtectedBlocks = textWithProtectedBlocks.replace(DESKTOP_PUSH_REGEX, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
                protectedBlocks.push(match);
                return placeholder;
            });
            // 也保护未闭合的推送块
            textWithProtectedBlocks = textWithProtectedBlocks.replace(DESKTOP_PUSH_PARTIAL_REGEX, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
                protectedBlocks.push(match);
                return placeholder;
            });
            
            // 保护代码块
            textWithProtectedBlocks = textWithProtectedBlocks.replace(CODE_FENCE_REGEX, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
                protectedBlocks.push(match);
                return placeholder;
            });

            // 现在只会匹配不在保护区域内的 <style> 标签
            const { processedContent: contentWithoutStyles } = processAndInjectScopedCss(textWithProtectedBlocks, scopeId);

            // 恢复所有被保护的块
            // 🟢 关键修复：使用函数回调替换，避免代码块中的 $ 字符
            // （如 $'、$$、$&）被 String.replace() 误解释为特殊替换模式
            textToRender = contentWithoutStyles;
            protectedBlocks.forEach((block, i) => {
                const placeholder = `__VCP_STYLE_PROTECT_${i}__`;
                textToRender = textToRender.split(placeholder).join(block);
            });
            // --- 修复结束 ---
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

        let rawHtml = renderMarkdownToHtml(textToRender, {
            settings: globalSettings,
            messageRole: message.role,
            depth
        });

        // 修复：清理 Markdown 解析器可能生成的损坏的 SVG viewBox 属性
        // 错误 "Unexpected end of attribute" 表明 viewBox 的值不完整, 例如 "0 "
        rawHtml = rawHtml.replace(/viewBox="0 "/g, 'viewBox="0 0 24 24"');

        // Synchronously set the base HTML content
        const finalHtml = rawHtml;
        contentDiv.innerHTML = finalHtml;

        // [Pretext集成] 延后填充文本高度缓存，避免阻塞首屏与批量历史渲染
        scheduleMessagePretextEstimate(message.id, textToRender, chatMessagesDiv);

        // Define the post-processing logic as a function.
        // This allows us to control WHEN it gets executed.
        const runPostRenderProcessing = async (postOptions = {}) => {
            if (!isRenderSessionActive(renderSessionId) || !messageItem.isConnected || !contentDiv.isConnected) {
                return;
            }

            return renderPostProcessedHtml(contentDiv, finalHtml, {
                messageId: message.id,
                message,
                settings: globalSettings,
                renderSessionId,
                runHeavy: postOptions.runHeavy !== false,
                includeAttachments: true
            });
        };

        messageItem._vcp_activateHeavy = () => {
            if (messageItem.dataset.vcpHeavyActivated === 'true') return;
            return runPostRenderProcessing({ runHeavy: true });
        };

        // If we are appending directly to the DOM, schedule the processing immediately.
        if (appendToDom) {
            // We still use requestAnimationFrame to ensure the element is painted before we process it.
            requestAnimationFrame(() => {
                if (!isRenderSessionActive(renderSessionId) || !messageItem.isConnected) return;
                runPostRenderProcessing();
            });
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
        } else if (avatarColorToUse) {
            // 没有自定义颜色或禁用时，使用计算的颜色
            applyColorToElements(avatarColorToUse);
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
                    } else if (message.isGroupMessage && message.agentId) {
                        typeToSave = 'agent'; idToSaveFor = message.agentId;
                    } else if (currentSelectedItem && currentSelectedItem.type === 'agent') {
                        typeToSave = 'agent'; idToSaveFor = currentSelectedItem.id;
                    }

                    if (typeToSave && idToSaveFor) {
                        electronAPI.saveAvatarColor({ type: typeToSave, id: idToSaveFor, color: dominantColor })
                            .then(result => {
                                if (result.success) {
                                    if (typeToSave === 'user') {
                                        mainRendererReferences.globalSettingsRef.set({ ...globalSettings, userAvatarCalculatedColor: dominantColor });
                                    } else if (typeToSave === 'agent' && idToSaveFor === currentSelectedItem.id) {
                                        if (currentSelectedItem.config) {
                                            currentSelectedItem.config.avatarCalculatedColor = dominantColor;
                                        } else {
                                            currentSelectedItem.avatarCalculatedColor = dominantColor;
                                        }
                                    }
                                }
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
                const chatScopeId = `vcp-chat-${message.id}`;
                messageItem.setAttribute('data-chat-scope', chatScopeId);

                // 检查是否已存在相同的style标签
                let existingStyle = document.head.querySelector(`style[data-chat-scope-id="${chatScopeId}"]`);
                if (existingStyle) {
                    existingStyle.remove();
                }

                // 创建scoped CSS（为当前消息添加作用域）
                const scopedChatCss = `[data-chat-scope="${chatScopeId}"] ${chatCss}`;

                // 注入到<head>
                const styleElement = document.createElement('style');
                styleElement.type = 'text/css';
                styleElement.setAttribute('data-chat-scope-id', chatScopeId);
                styleElement.textContent = scopedChatCss;
                document.head.appendChild(styleElement);
            }
        }
    }


    // Attachments and content processing are now deferred within a requestAnimationFrame
    // to prevent race conditions during history loading. See the block above.

    // The responsibility of updating the history array is now moved to the caller (e.g., chatManager.handleSendMessage)
    // to ensure a single source of truth and prevent race conditions.
    /*
    if (!isInitialLoad && !message.isThinking) {
         const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
         currentChatHistoryArray.push(message);
         mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray); // Update the ref
 
         if (currentSelectedItem.id && mainRendererReferences.currentTopicIdRef.get()) {
              if (currentSelectedItem.type === 'agent') {
                 electronAPI.saveChatHistory(currentSelectedItem.id, mainRendererReferences.currentTopicIdRef.get(), currentChatHistoryArray);
              } else if (currentSelectedItem.type === 'group') {
                 // Group history is usually saved by groupchat.js in main process after AI response
              }
         }
     }
     */
    if (isInitialLoad && message.isThinking) {
        // This case should ideally not happen if thinking messages aren't persisted.
        // If it does, remove the transient thinking message.
        const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
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
        mainRendererReferences.uiHelper.scrollToBottom();
    }
    return messageItem;
}

function startStreamingMessage(message, messageItem = null) {
    return streamManager.startStreamingMessage(message, messageItem);
}


function appendStreamChunk(messageId, chunkData, context) {
    streamManager.appendStreamChunk(messageId, chunkData, context);
}

/**
 * 从完整的消息内容中提取桌面推送块，一次性推送到桌面画布
 * 仅作为兜底机制：当流式推送不可用时（如桌面窗口在流式过程中不存在），
 * 在finalize时补充推送。如果流式推送已经成功处理过，这里不会重复推送。
 */
function extractAndPushDesktopBlocks(content) {
    // 此函数已被流式推送（processDesktopPushToken + setInterval）取代
    // 仅在非流式场景（如历史消息重新渲染）中作为兜底
    // 流式场景下，streamManager已经在token流中完成了推送，不需要重复
    //
    // 判断依据：如果桌面画布已存在挂件，说明流式推送已成功，跳过兜底
    // 目前简单处理：完全禁用兜底推送，因为流式推送已经工作
    // 未来可以加更智能的去重逻辑（基于widgetId映射）
}

async function finalizeStreamedMessage(messageId, finishReason, context, finalPayload = null) {
    // 完整最终渲染现在由 streamManager 单次完成：
    // 1) prepareFinalTextForRender() 在 streamManager 内对完整文本应用前端正则与深度；
    // 2) parseFull() 只执行一次完整管线；
    // 3) mermaid 也只在该最终渲染路径中执行一次。
    await streamManager.finalizeStreamedMessage(messageId, finishReason, context, finalPayload);

    const finalMessage = mainRendererReferences.currentChatHistoryRef.get().find(m => m.id === messageId);
    if (finalMessage) {
        extractAndPushDesktopBlocks(finalMessage.content);
    }
}



/**
 * Renders a full, non-streamed message, replacing a 'thinking' placeholder.
 * @param {string} messageId - The ID of the message to update.
 * @param {string} fullContent - The full HTML or text content of the message.
 * @param {string} agentName - The name of the agent sending the message.
 * @param {string} agentId - The ID of the agent sending the message.
 */
async function renderFullMessage(messageId, fullContent, agentName, agentId) {
    console.debug(`[MessageRenderer renderFullMessage] Rendering full message for ID: ${messageId}`);
    const { chatMessagesDiv, electronAPI, uiHelper, markedInstance } = mainRendererReferences;
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
        if (currentSelectedItem && currentSelectedItem.id && currentTopicIdVal && currentSelectedItem.type === 'group') {
            if (electronAPI.saveGroupChatHistory) {
                try {
                    await electronAPI.saveGroupChatHistory(currentSelectedItem.id, currentTopicIdVal, currentChatHistoryArray.filter(m => !m.isThinking));
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

    messageItem.classList.remove('thinking', 'streaming');
    window.updateSendButtonState?.();

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) {
        console.error(`[renderFullMessage] Could not find .md-content div for message ID ${messageId}.`);
        return;
    }

    // Update timestamp display if it was missing
    const nameTimeBlock = messageItem.querySelector('.name-time-block');
    if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
        const timestampDiv = document.createElement('div');
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
    const rawHtml = renderMarkdownToHtml(fullContent, {
        settings: globalSettings,
        messageRole: messageRoleForRender,
        depth
    });

    await renderPostProcessedHtml(contentDiv, rawHtml, {
        messageId,
        message: messageFromHistoryForRegex ? { ...messageFromHistoryForRegex, content: fullContent } : null,
        settings: globalSettings,
        renderSessionId: null,
        runHeavy: true,
        includeAttachments: !!messageFromHistoryForRegex
    });

    mainRendererReferences.uiHelper.scrollToBottom();
}

function scheduleMessagePretextEstimate(messageId, text, container) {
    if (!window.pretextBridge || !window.pretextBridge.isReady() || !messageId || !text) return;

    const run = () => {
        try {
            const containerWidth = container ? container.clientWidth : 800;
            window.pretextBridge.estimateHeight(messageId, text, 'body', containerWidth);
        } catch (e) {
            // Pretext 失败不影响正常渲染
        }
    };

    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 300 });
    } else {
        setTimeout(run, 0);
    }
}

function updateMessageContent(messageId, newContent) {
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
    const rawHtml = renderMarkdownToHtml(textToRender, {
        settings: globalSettings,
        messageRole: messageInHistory?.role || 'assistant',
        depth: depthForUpdate
    });

    // --- Post-Render Processing (aligned with renderMessage logic) ---

    renderPostProcessedHtml(contentDiv, rawHtml, {
        messageId,
        message: messageInHistory ? { ...messageInHistory, content: newContent } : null,
        settings: globalSettings,
        renderSessionId: null,
        runHeavy: true,
        includeAttachments: !!messageInHistory
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
    const renderSessionId = invalidateRenderSession();

    const {
        initialBatch = 5,
        batchSize = 10,
        batchDelay = 100
    } = options;

    // 核心修复：在开始批量渲染前，只等待一次依赖项。
    await emoticonUrlFixer.initialize(mainRendererReferences.electronAPI);

    if (!history || history.length === 0) {
        return Promise.resolve();
    }

    const renderContext = {
        depthMap: buildTurnDepthMap(history)
    };

    // 如果消息数量很少，直接使用原来的方式渲染
    if (history.length <= initialBatch) {
        return renderHistoryLegacy(history, renderSessionId, renderContext);
    }

    console.debug(`[MessageRenderer] 开始分批渲染 ${history.length} 条消息，首批 ${initialBatch} 条，后续每批 ${batchSize} 条`);

    // 分离最新的消息和历史消息
    const latestMessages = history.slice(-initialBatch);
    const olderMessages = history.slice(0, -initialBatch);

    // 第一阶段：立即渲染最新的消息
    await renderMessageBatch(latestMessages, true, renderSessionId, renderContext);
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

    visibilityOptimizer.observeMessage(el);

    if (typeof el._vcp_process === 'function') {
        const runHeavy = shouldRunHeavyForMessage(el, renderContext);
        el._vcp_process({ runHeavy });
        delete el._vcp_process;
    }
    delete el._vcp_renderSessionId;
}

async function renderMessageBatch(messages, scrollToBottom = false, renderSessionId = getActiveRenderSessionId(), renderContext = {}) {
    if (!isRenderSessionActive(renderSessionId)) return;

    const fragment = document.createDocumentFragment();
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

    // 使用 requestAnimationFrame 确保 DOM 更新不阻塞 UI
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            if (!isRenderSessionActive(renderSessionId)) {
                resolve();
                return;
            }

            // Step 1: Append all elements to the DOM at once.
            mainRendererReferences.chatMessagesDiv.appendChild(fragment);

            // Step 2: Now that they are in the DOM, run the deferred processing for each.
            messageElements.forEach(el => processDeferredMessageElement(el, renderSessionId, renderContext));

            if (scrollToBottom && isRenderSessionActive(renderSessionId)) {
                mainRendererReferences.uiHelper.scrollToBottom();
            }
            resolve();
        });
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
async function renderOlderMessagesInBatches(olderMessages, batchSize, batchDelay, renderSessionId = getActiveRenderSessionId(), renderContext = {}) {
    const totalBatches = Math.ceil(olderMessages.length / batchSize);

    for (let i = totalBatches - 1; i >= 0; i--) {
        if (!isRenderSessionActive(renderSessionId)) return;

        const startIndex = i * batchSize;
        const endIndex = Math.min(startIndex + batchSize, olderMessages.length);
        const batch = olderMessages.slice(startIndex, endIndex);

        // 创建批次 fragment
        const batchFragment = document.createDocumentFragment();
        const elementsForProcessing = [];

        for (const msg of batch) {
            if (!isRenderSessionActive(renderSessionId)) return;

            const messageElement = await renderMessage(msg, true, false, renderSessionId, renderContext);
            if (messageElement) {
                batchFragment.appendChild(messageElement);
                elementsForProcessing.push(messageElement);
            }
        }

        // 🟢 使用 requestIdleCallback 在空闲时插入（降级到 requestAnimationFrame）
        await new Promise(resolve => {
            const insertBatch = () => {
                if (!isRenderSessionActive(renderSessionId)) {
                    resolve();
                    return;
                }

                const chatMessagesDiv = mainRendererReferences.chatMessagesDiv;
                let insertPoint = chatMessagesDiv.firstChild;
                while (insertPoint?.classList?.contains('topic-timestamp-bubble')) {
                    insertPoint = insertPoint.nextSibling;
                }

                if (insertPoint) {
                    chatMessagesDiv.insertBefore(batchFragment, insertPoint);
                } else {
                    chatMessagesDiv.appendChild(batchFragment);
                }

                elementsForProcessing.forEach(el => processDeferredMessageElement(el, renderSessionId, {
                    ...renderContext,
                    deferHeavy: true
                }));

                resolve();
            };

            // 优先使用 requestIdleCallback，不支持时降级到 rAF
            if ('requestIdleCallback' in window) {
                requestIdleCallback(insertBatch, { timeout: 1000 });
            } else {
                requestAnimationFrame(insertBatch);
            }
        });

        if (!isRenderSessionActive(renderSessionId)) return;

        // 动态调整延迟：如果批次小，减少延迟
        if (i > 0 && batchDelay > 0) {
            const actualDelay = batch.length < batchSize / 2 ? batchDelay / 2 : batchDelay;
            await new Promise(resolve => setTimeout(resolve, actualDelay));
        }
    }
}

/**
 * 原始的历史渲染方法（用于少量消息的情况）
 * @param {Array<Message>} history 聊天历史
 */
async function renderHistoryLegacy(history, renderSessionId = getActiveRenderSessionId(), renderContext = {}) {
    if (!isRenderSessionActive(renderSessionId)) return;

    const fragment = document.createDocumentFragment();
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

    return new Promise(resolve => {
        requestAnimationFrame(() => {
            if (!isRenderSessionActive(renderSessionId)) {
                resolve();
                return;
            }

            // Step 1: Append all elements to the DOM.
            mainRendererReferences.chatMessagesDiv.appendChild(fragment);

            // Step 2: Run the deferred processing for each element now that it's attached.
            allMessageElements.forEach(el => processDeferredMessageElement(el, renderSessionId, renderContext));

            if (isRenderSessionActive(renderSessionId)) {
                mainRendererReferences.uiHelper.scrollToBottom();
            }
            resolve();
        });
    });
}

window.messageRenderer = {
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
    appendStreamChunk,
    finalizeStreamedMessage,
    renderFullMessage,
    clearChat,
    removeMessageById,
    updateMessageContent, // Expose the new function
    extractSpeakableTextFromContentElement,
    clearRenderHtmlCache,
    getRenderHtmlCacheStats: () => ({
        entries: renderHtmlCache.size,
        bytes: renderHtmlCacheBytes,
        ...renderHtmlCacheStats
    }),
    updateMessageUI: async (messageId, updatedMessage) => {
        const { chatMessagesDiv } = mainRendererReferences;
        const existingMessageDom = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (!existingMessageDom) return;
        const newMessageDom = await renderMessage(updatedMessage, true, false);
        if (newMessageDom) {
            existingMessageDom.replaceWith(newMessageDom);
            // 重新观察
            visibilityOptimizer.observeMessage(newMessageDom);
            // 运行后续处理 logic
            if (typeof newMessageDom._vcp_process === 'function') {
                newMessageDom._vcp_process();
                delete newMessageDom._vcp_process;
            }
        }
    },
    isMessageInitialized: (messageId) => {
        // Check if message exists in DOM or is being tracked by streamManager
        const messageInDom = mainRendererReferences.chatMessagesDiv?.querySelector(`.message-item[data-message-id="${messageId}"]`);
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

