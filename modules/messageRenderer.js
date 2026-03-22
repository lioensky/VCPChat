// modules/messageRenderer.js

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls

import { avatarColorCache, getDominantAvatarColor } from './renderer/colorUtils.js';
import { initializeImageHandler, setContentAndProcessImages } from './renderer/imageHandler.js';
import { processAnimationsInContent, cleanupAnimationsInContent } from './renderer/animation.js';
import * as visibilityOptimizer from './renderer/visibilityOptimizer.js';
import { createMessageSkeleton } from './renderer/domBuilder.js';
import * as streamManager from './renderer/streamManager.js';
import * as emoticonUrlFixer from './renderer/emoticonUrlFixer.js';

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


// --- Pre-compiled Regular Expressions for Performance ---
const TOOL_REGEX = /<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>/gs;
const NOTE_REGEX = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/gs;
const TOOL_RESULT_REGEX = /\[\[VCP调用结果信息汇总:(.*?)VCP调用结果结束\]\]/gs;
const BUTTON_CLICK_REGEX = /\[\[点击按钮:(.*?)\]\]/gs;
const CANVAS_PLACEHOLDER_REGEX = /\{\{VCPChatCanvas\}\}/g;
const STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const HTML_FENCE_CHECK_REGEX = /```\w*\n<!DOCTYPE html>/i;
const MERMAID_CODE_REGEX = /<code.*?>\s*(flowchart|graph|mermaid)\s+([\s\S]*?)<\/code>/gi;
const MERMAID_FENCE_REGEX = /```(mermaid|flowchart|graph)\n([\s\S]*?)```/g;
const CODE_FENCE_REGEX = /```\w*([\s\S]*?)```/g;
const THOUGHT_CHAIN_REGEX = /\[--- VCP元思考链(?::\s*"([^"]*)")?\s*---\]([\s\S]*?)\[--- 元思考链结束 ---\]/gs;
const CONVENTIONAL_THOUGHT_REGEX = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
const ROLE_DIVIDER_REGEX = /<<<\[(END_)?ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;
const DESKTOP_PUSH_REGEX = /<<<\[DESKTOP_PUSH\]>>>([\s\S]*?)<<<\[DESKTOP_PUSH_END\]>>>/gs;
const DESKTOP_PUSH_PARTIAL_REGEX = /<<<\[DESKTOP_PUSH\]>>>([\s\S]*)$/s; // 流式传输中未闭合的情况


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

    // Process VCP Tool Results
    processed = processed.replace(TOOL_RESULT_REGEX, (match, rawContent) => {
        const content = rawContent.trim();
        const lines = content.split('\n');

        let toolName = 'Unknown Tool';
        let status = 'Unknown Status';
        const details = [];
        let otherContent = [];

        let currentKey = null;
        let currentValue = [];

        lines.forEach(line => {
            const kvMatch = line.match(/^-\s*([^:]+):\s*(.*)/);
            if (kvMatch) {
                if (currentKey) {
                    const val = currentValue.join('\n').trim();
                    if (currentKey === '工具名称') {
                        toolName = val;
                    } else if (currentKey === '执行状态') {
                        status = val;
                    } else {
                        details.push({ key: currentKey, value: val });
                    }
                }
                currentKey = kvMatch[1].trim();
                currentValue = [kvMatch[2].trim()];
            } else if (currentKey) {
                currentValue.push(line);
            } else if (line.trim() !== '') {
                otherContent.push(line);
            }
        });

        if (currentKey) {
            const val = currentValue.join('\n').trim();
            if (currentKey === '工具名称') {
                toolName = val;
            } else if (currentKey === '执行状态') {
                status = val;
            } else {
                details.push({ key: currentKey, value: val });
            }
        }

        // Add 'collapsible' class for the new functionality, default to collapsed
        let html = `<div class="vcp-tool-result-bubble collapsible">`;
        html += `<div class="vcp-tool-result-header">`;
        html += `<span class="vcp-tool-result-label">VCP-ToolResult</span>`;
        html += `<span class="vcp-tool-result-name">${escapeHtml(toolName)}</span>`;
        html += `<span class="vcp-tool-result-status">${escapeHtml(status)}</span>`;
        html += `<span class="vcp-result-toggle-icon"></span>`; // Toggle icon
        html += `</div>`;

        // Wrap details and footer in a new collapsible container
        html += `<div class="vcp-tool-result-collapsible-content">`;

        html += `<div class="vcp-tool-result-details">`;
        details.forEach(({ key, value }) => {
            const isMarkdownField = (key === '返回内容' || key === '内容' || key === 'Result' || key === '返回结果' || key === 'output');
            const isImageUrl = typeof value === 'string' && value.match(/^https?:\/\/[^\s]+\.(jpeg|jpg|png|gif|webp)$/i);
            let processedValue;

            if (isImageUrl && (key === '可访问URL' || key === '返回内容' || key === 'url' || key === 'image')) {
                processedValue = `<a href="${value}" target="_blank" rel="noopener noreferrer" title="点击预览"><img src="${value}" class="vcp-tool-result-image" alt="Generated Image"></a>`;
            } else if (isMarkdownField && mainRendererReferences.markedInstance) {
                try {
                    // Use marked for markdown fields
                    processedValue = mainRendererReferences.markedInstance.parse(restoreBlocks(value));
                } catch (e) {
                    console.error('Failed to parse markdown in tool result', e);
                    processedValue = escapeHtml(restoreBlocks(value));
                }
            } else {
                const urlRegex = /(https?:\/\/[^\s]+)/g;
                processedValue = escapeHtml(restoreBlocks(value));
                processedValue = processedValue.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

                if (key === '返回内容') {
                    processedValue = processedValue.replace(/###(.*?)###/g, '<strong>$1</strong>');
                }
            }

            html += `<div class="vcp-tool-result-item">`;
            html += `<span class="vcp-tool-result-item-key">${escapeHtml(key)}:</span> `;
            const valueTag = (isMarkdownField && !isImageUrl) ? 'div' : 'span';
            html += `<${valueTag} class="vcp-tool-result-item-value">${processedValue}</${valueTag}>`;
            html += `</div>`;
        });
        html += `</div>`; // End of vcp-tool-result-details

        if (otherContent.length > 0) {
            const footerText = otherContent.join('\n');
            let processedFooter;
            if (mainRendererReferences.markedInstance) {
                try {
                    processedFooter = mainRendererReferences.markedInstance.parse(restoreBlocks(footerText));
                } catch (e) {
                    console.error('Failed to parse markdown in tool result footer', e);
                    processedFooter = `<pre>${escapeHtml(restoreBlocks(footerText))}</pre>`;
                }
            } else {
                processedFooter = `<pre>${escapeHtml(restoreBlocks(footerText))}</pre>`;
            }
            html += `<div class="vcp-tool-result-footer">${processedFooter}</div>`;
        }

        html += `</div>`; // End of vcp-tool-result-collapsible-content
        html += `</div>`; // End of vcp-tool-result-bubble

        return html;
    });

    // Process Tool Requests
    processed = processed.replace(TOOL_REGEX, (match, content) => {
        // Check if this is a DailyNote tool call with the 'create' command
        const isDailyNoteCreate = /tool_name:\s*「始」\s*DailyNote\s*「末」/.test(content) &&
            /command:\s*「始」\s*create\s*「末」/.test(content);

        if (isDailyNoteCreate) {
            // --- It's a DailyNote Tool, render it as a diary bubble ---
            const maidRegex = /(?:maid|maidName):\s*「始」([^「」]*)「末」/;
            const dateRegex = /Date:\s*「始」([^「」]*)「末」/;
            const contentRegex = /Content:\s*「始」([\s\S]*?)「末」/;

            const maidMatch = content.match(maidRegex);
            const dateMatch = content.match(dateRegex);
            const contentMatch = content.match(contentRegex);

            const maid = maidMatch ? maidMatch[1].trim() : '';
            const date = dateMatch ? dateMatch[1].trim() : '';
            const diaryContent = contentMatch ? contentMatch[1].trim() : '[日记内容解析失败]';

            let html = `<div class="maid-diary-bubble">`;
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

            return html;
        } else {
            // --- It's a regular tool call, render it normally ---
            const toolNameRegex = /<tool_name>([\s\S]*?)<\/tool_name>|tool_name:\s*「始」([^「」]*)「末」/;
            const toolNameMatch = content.match(toolNameRegex);

            let toolName = 'Processing...';
            if (toolNameMatch) {
                let extractedName = (toolNameMatch[1] || toolNameMatch[2] || '').trim();
                if (extractedName) {
                    extractedName = extractedName.replace(/「始」|「末」/g, '').replace(/,$/, '').trim();
                }
                if (extractedName) {
                    toolName = extractedName;
                }
            }

            const escapedFullContent = escapeHtml(restoreBlocks(content));
            return `<div class="vcp-tool-use-bubble">` +
                `<div class="vcp-tool-summary">` +
                `<span class="vcp-tool-label">VCP-ToolUse:</span> ` +
                `<span class="vcp-tool-name-highlight">${escapeHtml(toolName)}</span>` +
                `</div>` +
                `<div class="vcp-tool-details"><pre>${escapedFullContent}</pre></div>` +
                `</div>`;
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

        let html = `<div class="maid-diary-bubble">`;
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

        return html;
    });

    // Process VCP Thought Chains
    const renderThoughtChain = (theme, rawContent) => {
        const displayTheme = theme ? theme.trim() : "元思考链";
        const content = rawContent.trim();
        const escapedContent = escapeHtml(restoreBlocks(content));

        let html = `<div class="vcp-thought-chain-bubble collapsible">`;
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

        return html;
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

        return `<div class="vcp-role-divider role-${roleLower} type-${isEndMarker ? 'end' : 'start'}"><span class="divider-text">角色分界: ${label} [${actionText}]</span></div>`;
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

    // 🟢 构建「始」「末」保护区域
    const protectedRanges = [];
    const START_MARKER = '「始」';
    const END_MARKER = '「末」';
    let searchStart = 0;

    while (true) {
        const startPos = text.indexOf(START_MARKER, searchStart);
        if (startPos === -1) break;

        const endPos = text.indexOf(END_MARKER, startPos + START_MARKER.length);
        if (endPos === -1) {
            // 未闭合的「始」，保护到文本末尾（流式传输场景）
            protectedRanges.push({ start: startPos, end: text.length });
            break;
        }

        protectedRanges.push({ start: startPos, end: endPos + END_MARKER.length });
        searchStart = endPos + END_MARKER.length;
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
function calculateDepthByTurns(messageId, history) {
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

    const turnIndex = turns.findIndex(t =>
        (t.assistant?.id === messageId) || (t.user?.id === messageId)
    );
    return turnIndex !== -1 ? (turns.length - 1 - turnIndex) : 0;
}


/**
 * A helper function to preprocess the full message content string before parsing.
 * @param {string} text The raw text content.
 * @returns {string} The processed text.
 */
function preprocessFullContent(text, settings = {}, messageRole = 'assistant', depth = 0) {
    //  新增：第一层修复 - Markdown 图片语法修复
    text = fixEmoticonUrlsInMarkdown(text);

    // 🔴 关键安全修复：将「始」和「末」之间的内容视为纯文本并进行 HTML 转义
    // 这样可以防止工具调用参数中的 HTML 被执行。
    // 注意：这里我们只处理不在工具请求块（<<<[TOOL_REQUEST]>>>）内的标记，
    // 因为 transformSpecialBlocks 会处理工具块内的转义，避免双重转义。
    // 但为了简单起见，我们先注释掉这一行，让 transformSpecialBlocks 统一处理，
    // 或者确保 transformSpecialBlocks 能够处理未转义的原始文本。
    // 实际上，processStartEndMarkers 在流式传输中非常重要。
    // 我们将其移动到 transformSpecialBlocks 之后，或者只对非工具块内容应用。

    // 暂时保留，但我们需要意识到双重转义风险。
    text = contentProcessor.processStartEndMarkers(text);

    // 一次性处理 Mermaid（合并两种情况）
    text = text.replace(MERMAID_CODE_REGEX, (match, lang, code) => {
        const tempEl = document.createElement('textarea');
        tempEl.innerHTML = code;
        const encodedCode = encodeURIComponent(tempEl.value.trim());
        return `<div class="mermaid-placeholder" data-mermaid-code="${encodedCode}"></div>`;
    });

    text = text.replace(MERMAID_FENCE_REGEX, (match, lang, code) => {
        const encodedCode = encodeURIComponent(code.trim());
        return `<div class="mermaid-placeholder" data-mermaid-code="${encodedCode}"></div>`;
    });

    // 🔴 关键修复：在提取代码块之前先处理缩进
    // 这样 deIndentMisinterpretedCodeBlocks 才能正确识别代码围栏
    text = contentProcessor.deIndentMisinterpretedCodeBlocks(text);
    text = deIndentHtml(text);

    // 保护代码块（优化：只在需要时创建 Map）
    let codeBlockMap = null;
    let placeholderId = 0;

    // Use a lookahead to test without consuming the match
    const hasCodeBlocks = /```/.test(text);

    if (hasCodeBlocks) {
        codeBlockMap = new Map();
        text = text.replace(CODE_FENCE_REGEX, (match) => {
            const placeholder = `__VCP_CODE_BLOCK_PLACEHOLDER_${placeholderId}__`;
            codeBlockMap.set(placeholder, match);
            placeholderId++;
            return placeholder;
        });
    }

    // The order of the remaining operations is critical.
    text = contentProcessor.deIndentToolRequestBlocks(text);

    // 🔴 VCPdesktop 转义封印：在代码块保护之后执行（代码块内的语法不会被误匹配）
    // 但在 transformSpecialBlocks 和 ensureHtmlFenced 之前（防止推送块内HTML泄露）
    DESKTOP_PUSH_REGEX.lastIndex = 0;
    DESKTOP_PUSH_PARTIAL_REGEX.lastIndex = 0;
    text = text.replace(DESKTOP_PUSH_REGEX, (match, rawContent) => {
        const content = rawContent.trim();
        const escapedPreview = escapeHtml(content.length > 120 ? content.substring(0, 120) + '...' : content);
        return `<div class="vcp-desktop-push-placeholder">` +
            `<div class="vcp-desktop-push-header">` +
            `<span class="vcp-desktop-push-icon">🖥️</span>` +
            `<span class="vcp-desktop-push-label">已推送到桌面画布</span>` +
            `</div>` +
            `<div class="vcp-desktop-push-preview"><pre>${escapedPreview}</pre></div>` +
            `</div>`;
    });
    text = text.replace(DESKTOP_PUSH_PARTIAL_REGEX, (match, partialContent) => {
        const content = partialContent.trim();
        const escapedPreview = escapeHtml(content.length > 80 ? content.substring(0, 80) + '...' : content);
        return `<div class="vcp-desktop-push-placeholder constructing">` +
            `<div class="vcp-desktop-push-header">` +
            `<span class="vcp-desktop-push-icon">🖥️</span>` +
            `<span class="vcp-desktop-push-label">正在向桌面推送<span class="thinking-indicator-dots">...</span></span>` +
            `</div>` +
            `<div class="vcp-desktop-push-preview"><pre>${escapedPreview}</pre></div>` +
            `</div>`;
    });

    text = transformSpecialBlocks(text, codeBlockMap);
    text = ensureHtmlFenced(text);

    // 批量应用内容处理器（减少函数调用）
    text = contentProcessor.applyContentProcessors(text);

    // 恢复代码块
    if (codeBlockMap) {
        for (const [placeholder, block] of codeBlockMap.entries()) {
            // Use a function for replacement to handle special characters in the block
            text = text.replace(placeholder, () => block);
        }
    }

    return text;
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


function removeMessageById(messageId, saveHistory = false) {
    const item = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (item) {
        // --- NEW: Cleanup dynamic content before removing from DOM ---
        const contentDiv = item.querySelector('.md-content');
        if (contentDiv) {
            cleanupAnimationsInContent(contentDiv);
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
    if (mainRendererReferences.chatMessagesDiv) {
        // --- NEW: Cleanup all messages before clearing the container ---
        const allMessages = mainRendererReferences.chatMessagesDiv.querySelectorAll('.message-item');
        allMessages.forEach(item => {
            const contentDiv = item.querySelector('.md-content');
            if (contentDiv) {
                cleanupAnimationsInContent(contentDiv);
            }
            visibilityOptimizer.unobserveMessage(item);
        });

        // 🟢 清理所有注入的 scoped CSS
        document.querySelectorAll('style[data-vcp-scope-id]').forEach(el => el.remove());
        document.querySelectorAll('style[data-chat-scope-id]').forEach(el => el.remove());

        mainRendererReferences.chatMessagesDiv.innerHTML = '';
    }
    mainRendererReferences.currentChatHistoryRef.set([]); // Clear the history array via its ref
}


function initializeMessageRenderer(refs) {
    Object.assign(mainRendererReferences, refs);

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

        // 2. Avatar 点击停止 TTS（也使用委托）
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

    // Create a new marked instance wrapper specifically for the stream manager.
    const originalMarkedParse = mainRendererReferences.markedInstance.parse.bind(mainRendererReferences.markedInstance);
    const streamingMarkedInstance = {
        ...mainRendererReferences.markedInstance,
        parse: (text) => {
            const globalSettings = mainRendererReferences.globalSettingsRef.get();
            const processedText = preprocessFullContent(text, globalSettings);
            return originalMarkedParse(processedText);
        }
    };

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
        markedInstance: streamingMarkedInstance,
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
        emoticonUrlFixer: emoticonUrlFixer, // 🟢 Pass emoticon fixer for live updates
        enhancedRenderDebounceTimers: enhancedRenderDebounceTimers,
        ENHANCED_RENDER_DEBOUNCE_DELAY: ENHANCED_RENDER_DEBOUNCE_DELAY,
        DIARY_RENDER_DEBOUNCE_DELAY: DIARY_RENDER_DEBOUNCE_DELAY,
    });

    middleClickHandler.initialize(mainRendererReferences, {
        removeMessageById: removeMessageById,
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


async function renderAttachments(message, contentDiv) {
    const { electronAPI } = mainRendererReferences;
    if (message.attachments && message.attachments.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.classList.add('message-attachments');
        message.attachments.forEach(att => {
            let attachmentElement;
            if (att.type.startsWith('image/')) {
                attachmentElement = document.createElement('img');
                attachmentElement.src = att.src; // This src should be usable (e.g., file:// or data:)
                attachmentElement.alt = `附件图片: ${att.name}`;
                attachmentElement.title = `点击在新窗口预览: ${att.name}`;
                attachmentElement.classList.add('message-attachment-image-thumbnail');
                attachmentElement.onclick = (e) => {
                    e.stopPropagation();
                    const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
                    electronAPI.openImageViewer({ src: att.src, title: att.name, theme: currentTheme });
                };
                attachmentElement.addEventListener('contextmenu', (e) => { // Use attachmentElement here
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
            } else { // Generic file
                attachmentElement = document.createElement('a');
                attachmentElement.href = att.src;
                attachmentElement.textContent = `📄 ${att.name}`;
                attachmentElement.title = `点击打开文件: ${att.name}`;
                attachmentElement.onclick = (e) => {
                    e.preventDefault();
                    if (electronAPI.sendOpenExternalLink && att.src.startsWith('file://')) {
                        electronAPI.sendOpenExternalLink(att.src);
                    } else {
                        console.warn("Cannot open local file attachment, API missing or path not a file URI:", att.src);
                    }
                };
            }
            if (attachmentElement) attachmentsContainer.appendChild(attachmentElement);
        });
        contentDiv.appendChild(attachmentsContainer);
    }
}

async function renderMessage(message, isInitialLoad = false, appendToDom = true) {
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

        // Apply special formatting for user button clicks
        if (message.role === 'user') {
            textToRender = transformUserButtonClick(textToRender);
            textToRender = transformVCPChatCanvas(textToRender);
        } else if (message.role === 'assistant' && scopeId) {
            // --- 🟢 关键修复：先保护所有可能包含 <style> 的特殊区域，再提取样式 ---
            // 这样可以避免代码块、推送块、工具请求块和「始」「末」标记内的 <style> 被误当作真正的样式注入
            const protectedBlocks = [];
            
            // 🔴 保护工具请求块（<<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>>）
            // 工具请求参数中可能包含完整的HTML文档（如壁纸HTML），其中的 <style> 不应被注入
            let textWithProtectedBlocks = textToRender.replace(TOOL_REGEX, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
                protectedBlocks.push(match);
                return placeholder;
            });
            
            // 🔴 保护「始」「末」标记区域
            // 这些标记内的内容是工具参数，可能包含任意HTML（含<style>），不应被提取
            textWithProtectedBlocks = textWithProtectedBlocks.replace(/「始」[\s\S]*?(「末」|$)/g, (match) => {
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
            textToRender = contentWithoutStyles;
            protectedBlocks.forEach((block, i) => {
                const placeholder = `__VCP_STYLE_PROTECT_${i}__`;
                textToRender = textToRender.replace(placeholder, block);
            });
            // --- 修复结束 ---
        }

        // --- 按“对话轮次”计算深度 ---
        // 如果是新消息，它此时还不在 history 数组里，先临时加进去计算
        const historyForDepthCalc = currentChatHistory.some(m => m.id === message.id)
            ? [...currentChatHistory]
            : [...currentChatHistory, message];
        const depth = calculateDepthByTurns(message.id, historyForDepthCalc);
        // --- 深度计算结束 ---

        // --- 应用前端正则规则 ---
        // 核心修复：将正则规则应用移出 preprocessFullContent，以避免在流式传输的块上执行
        // 这样可以确保正则表达式在完整的消息内容上运行
        const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
        if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes)) {
            textToRender = applyFrontendRegexRules(textToRender, agentConfigForRegex.stripRegexes, message.role, depth);
        }
        // --- 正则规则应用结束 ---

        const processedContent = preprocessFullContent(textToRender, globalSettings, message.role, depth);
        let rawHtml = markedInstance.parse(processedContent);

        // 修复：清理 Markdown 解析器可能生成的损坏的 SVG viewBox 属性
        // 错误 "Unexpected end of attribute" 表明 viewBox 的值不完整, 例如 "0 "
        rawHtml = rawHtml.replace(/viewBox="0 "/g, 'viewBox="0 0 24 24"');

        // Synchronously set the base HTML content
        const finalHtml = rawHtml;
        contentDiv.innerHTML = finalHtml;

        // Define the post-processing logic as a function.
        // This allows us to control WHEN it gets executed.
        const runPostRenderProcessing = async () => {
            // This function should only be called when messageItem is connected to the DOM.

            // Process images, attachments, and synchronous content first.
            setContentAndProcessImages(contentDiv, finalHtml, message.id);
            renderAttachments(message, contentDiv);
            contentProcessor.processRenderedContent(contentDiv, globalSettings);
            await renderMermaidDiagrams(contentDiv); // Render mermaid diagrams

            // Defer TreeWalker-based highlighters with a hardcoded delay to ensure the DOM is stable.
            setTimeout(() => {
                if (contentDiv && contentDiv.isConnected) {
                    contentProcessor.highlightAllPatternsInMessage(contentDiv);
                }
            }, 0);

            // Finally, process any animations and execute scripts/3D scenes.
            processAnimationsInContent(contentDiv);
        };

        // If we are appending directly to the DOM, schedule the processing immediately.
        if (appendToDom) {
            // We still use requestAnimationFrame to ensure the element is painted before we process it.
            requestAnimationFrame(() => runPostRenderProcessing());
        } else {
            // If not, attach the processing function to the element itself.
            // The caller (e.g., a batch renderer) will be responsible for executing it
            // AFTER the element has been attached to the DOM.
            messageItem._vcp_process = () => runPostRenderProcessing();
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
    // 责任完全在 streamManager 内部，它应该使用自己拼接好的文本。
    // 我们现在只传递必要的元数据。
    await streamManager.finalizeStreamedMessage(messageId, finishReason, context, finalPayload);

    // --- 核心修复：流式结束后，对完整内容重新应用前端正则 ---
    // 这是为了解决流式传输导致正则表达式（如元思考链）被分割而无法匹配的问题
    const finalMessage = mainRendererReferences.currentChatHistoryRef.get().find(m => m.id === messageId);
    if (finalMessage) {
        // 使用 updateMessageContent 来安全地重新渲染消息，这将触发我们之前添加的正则逻辑
        updateMessageContent(messageId, finalMessage.content);

        // --- VCPdesktop：从完整内容中提取桌面推送块，一次性推送到桌面画布 ---
        extractAndPushDesktopBlocks(finalMessage.content);
    }
    // --- 修复结束 ---

    // After the stream is finalized in the DOM, find the message and render any mermaid blocks.
    const messageItem = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (messageItem) {
        const contentDiv = messageItem.querySelector('.md-content');
        if (contentDiv) {
            await renderMermaidDiagrams(contentDiv);
        }
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
        timestampDiv.textContent = new Date(messageFromHistory?.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        nameTimeBlock.appendChild(timestampDiv);
    }

    // --- Update DOM ---
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    // --- 应用前端正则规则 (修复流式处理问题) ---
    const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
    const messageFromHistoryForRegex = currentChatHistoryArray.find(msg => msg.id === messageId);
    if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes) && messageFromHistoryForRegex) {
        const depth = calculateDepthByTurns(messageId, currentChatHistoryArray);
        fullContent = applyFrontendRegexRules(fullContent, agentConfigForRegex.stripRegexes, messageFromHistoryForRegex.role, depth);
    }
    // --- 正则规则应用结束 ---
    const processedFinalText = preprocessFullContent(fullContent, globalSettings, 'assistant');
    let rawHtml = markedInstance.parse(processedFinalText);

    setContentAndProcessImages(contentDiv, rawHtml, messageId);

    // Apply post-processing in two steps
    // Step 1: Synchronous processing
    contentProcessor.processRenderedContent(contentDiv, globalSettings);
    await renderMermaidDiagrams(contentDiv);

    // Step 2: Asynchronous, deferred highlighting for DOM stability with a hardcoded delay
    setTimeout(() => {
        if (contentDiv && contentDiv.isConnected) {
            contentProcessor.highlightAllPatternsInMessage(contentDiv);
        }
    }, 0);

    // After content is rendered, run animations/scripts/3D scenes
    processAnimationsInContent(contentDiv);

    mainRendererReferences.uiHelper.scrollToBottom();
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
    const processedContent = preprocessFullContent(textToRender, globalSettings, messageInHistory?.role || 'assistant', depthForUpdate);
    let rawHtml = markedInstance.parse(processedContent);

    // --- Post-Render Processing (aligned with renderMessage logic) ---

    // 1. Set content and process images
    setContentAndProcessImages(contentDiv, rawHtml, messageId);

    // 2. Re-render attachments if they exist
    if (messageInHistory) {
        const existingAttachments = contentDiv.querySelector('.message-attachments');
        if (existingAttachments) existingAttachments.remove();
        renderAttachments({ ...messageInHistory, content: newContent }, contentDiv);
    }

    // 3. Synchronous processing (KaTeX, buttons, etc.)
    contentProcessor.processRenderedContent(contentDiv, globalSettings);
    renderMermaidDiagrams(contentDiv); // Fire-and-forget async rendering

    // 4. Asynchronous, deferred highlighting for DOM stability
    setTimeout(() => {
        if (contentDiv && contentDiv.isConnected) {
            contentProcessor.highlightAllPatternsInMessage(contentDiv);
        }
    }, 0);

    // 5. Re-run animations/scripts/3D scenes
    processAnimationsInContent(contentDiv);
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

    // 如果消息数量很少，直接使用原来的方式渲染
    if (history.length <= initialBatch) {
        return renderHistoryLegacy(history);
    }

    console.debug(`[MessageRenderer] 开始分批渲染 ${history.length} 条消息，首批 ${initialBatch} 条，后续每批 ${batchSize} 条`);

    // 分离最新的消息和历史消息
    const latestMessages = history.slice(-initialBatch);
    const olderMessages = history.slice(0, -initialBatch);

    // 第一阶段：立即渲染最新的消息
    await renderMessageBatch(latestMessages, true);
    console.debug(`[MessageRenderer] 首批 ${latestMessages.length} 条最新消息已渲染`);

    // 第二阶段：分批渲染历史消息（从旧到新）
    if (olderMessages.length > 0) {
        await renderOlderMessagesInBatches(olderMessages, batchSize, batchDelay);
    }

    // 最终滚动到底部
    mainRendererReferences.uiHelper.scrollToBottom();
    console.debug(`[MessageRenderer] 所有 ${history.length} 条消息渲染完成`);
}

/**
 * 渲染一批消息
 * @param {Array<Message>} messages 要渲染的消息数组
 * @param {boolean} scrollToBottom 是否滚动到底部
 */
async function renderMessageBatch(messages, scrollToBottom = false) {
    const fragment = document.createDocumentFragment();
    const messageElements = [];

    // 使用 Promise.allSettled 避免单个失败影响整体
    const results = await Promise.allSettled(
        messages.map(msg => renderMessage(msg, true, false))
    );

    results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
            messageElements.push(result.value);
        } else {
            console.error(`Failed to render message ${messages[index].id}:`,
                result.reason);
        }
    });

    // 一次性添加到 fragment
    messageElements.forEach(el => fragment.appendChild(el));

    // 使用 requestAnimationFrame 确保 DOM 更新不阻塞 UI
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            // Step 1: Append all elements to the DOM at once.
            mainRendererReferences.chatMessagesDiv.appendChild(fragment);

            // Step 2: Now that they are in the DOM, run the deferred processing for each.
            messageElements.forEach(el => {
                // 观察批量渲染的消息
                visibilityOptimizer.observeMessage(el);

                if (typeof el._vcp_process === 'function') {
                    el._vcp_process();
                    delete el._vcp_process; // Clean up to avoid memory leaks
                }
            });

            if (scrollToBottom) {
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
async function renderOlderMessagesInBatches(olderMessages, batchSize, batchDelay) {
    const totalBatches = Math.ceil(olderMessages.length / batchSize);

    for (let i = totalBatches - 1; i >= 0; i--) {
        const startIndex = i * batchSize;
        const endIndex = Math.min(startIndex + batchSize, olderMessages.length);
        const batch = olderMessages.slice(startIndex, endIndex);

        // 创建批次 fragment
        const batchFragment = document.createDocumentFragment();
        const elementsForProcessing = [];

        for (const msg of batch) {
            const messageElement = await renderMessage(msg, true, false);
            if (messageElement) {
                batchFragment.appendChild(messageElement);
                elementsForProcessing.push(messageElement);
            }
        }

        // 🟢 使用 requestIdleCallback 在空闲时插入（降级到 requestAnimationFrame）
        await new Promise(resolve => {
            const insertBatch = () => {
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

                elementsForProcessing.forEach(el => {
                    // 观察批量渲染的历史消息
                    visibilityOptimizer.observeMessage(el);

                    if (typeof el._vcp_process === 'function') {
                        el._vcp_process();
                        delete el._vcp_process;
                    }
                });

                resolve();
            };

            // 优先使用 requestIdleCallback，不支持时降级到 rAF
            if ('requestIdleCallback' in window) {
                requestIdleCallback(insertBatch, { timeout: 1000 });
            } else {
                requestAnimationFrame(insertBatch);
            }
        });

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
async function renderHistoryLegacy(history) {
    const fragment = document.createDocumentFragment();
    const allMessageElements = [];

    // Phase 1: Create all message elements in memory without appending to DOM
    for (const msg of history) {
        const messageElement = await renderMessage(msg, true, false);
        if (messageElement) {
            allMessageElements.push(messageElement);
        }
    }

    // Phase 2: Append all created elements at once using a DocumentFragment
    allMessageElements.forEach(el => fragment.appendChild(el));

    return new Promise(resolve => {
        requestAnimationFrame(() => {
            // Step 1: Append all elements to the DOM.
            mainRendererReferences.chatMessagesDiv.appendChild(fragment);

            // Step 2: Run the deferred processing for each element now that it's attached.
            allMessageElements.forEach(el => {
                // 观察历史消息
                visibilityOptimizer.observeMessage(el);

                if (typeof el._vcp_process === 'function') {
                    el._vcp_process();
                    delete el._vcp_process; // Clean up
                }
            });

            mainRendererReferences.uiHelper.scrollToBottom();
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

