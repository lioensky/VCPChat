// modules/renderer/contentProcessor.js
import * as cssTree from '../../node_modules/css-tree/dist/csstree.esm.js';

/** Creates one rendered-content interaction owner for one MessageRenderer instance. */
export function createContentProcessor() {
let mainRefs = {};

function scheduleOwnedTimeout(owner, callback, delay) {
    if (!owner) return setTimeout(callback, delay);
    if (!owner._vcpOwnedTimeouts) owner._vcpOwnedTimeouts = new Set();
    const timerId = setTimeout(() => {
        owner._vcpOwnedTimeouts?.delete(timerId);
        callback();
    }, delay);
    owner._vcpOwnedTimeouts.add(timerId);
    return timerId;
}

function clearOwnedTimeouts(owner) {
    if (!owner?._vcpOwnedTimeouts) return;
    for (const timerId of owner._vcpOwnedTimeouts) clearTimeout(timerId);
    owner._vcpOwnedTimeouts.clear();
    delete owner._vcpOwnedTimeouts;
}

/**
 * Initializes the content processor with necessary references.
 * @param {object} refs - References to main modules and utilities.
 */
function initializeContentProcessor(refs) {
    mainRefs = refs;
}

/**
 * A helper function to escape HTML special characters.
 * @param {string} text The text to escape.
 * @returns {string} The escaped text.
 */
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/&/g, '\x26amp;')    // & -> &
        .replace(/</g, '\x26lt;')     // < -> <
        .replace(/>/g, '\x26gt;')     // > -> >
        .replace(/"/g, '\x26quot;')   // " -> "
        .replace(/'/g, '\x26#039;');  // ' -> &#039;
}

/**
 * 处理「始」/「末」与「始ESCAPE」/「末ESCAPE」之间的内容，将其视为纯文本并转义。
 * 支持流式传输中未闭合的情况。
 * @param {string} text 输入文本
 * @returns {string} 处理后的文本
 */
function processStartEndMarkers(text) {
    if (typeof text !== 'string' || (!text.includes('始') && !text.includes('{') && !text.includes('「'))) {
        return text;
    }

    const isLikelyLiteralMention = (source, markerIndex, marker) => {
        const prevChar = markerIndex > 0 ? source[markerIndex - 1] : '';
        const nextChar = source[markerIndex + marker.length] || '';

        // 跳过正文中“提到语法名”的场景，例如：
        // [「始ESCAPE」]、`「始」`、"「始ESCAPE」"
        if (['[', '【', '(', '（', '`', '"', "'", '“', '‘'].includes(prevChar)) {
            return true;
        }
        if ([']', '】', ')', '）', '`', '"', "'", '”', '’'].includes(nextChar)) {
            return true;
        }

        return false;
    };

    // 1. 识别并保护 ESCAPE 区域
    const escapeStartRegex = /([「{]始[Ee][Ss][Cc][Aa][Pp][Ee][」}])/gi;
    const escapeEndRegex = /([「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}])/gi;

    const escapeBlocks = [];
    let processedText = text;
    let searchCursor = 0;

    while (true) {
        escapeStartRegex.lastIndex = searchCursor;
        const startMatch = escapeStartRegex.exec(processedText);
        if (!startMatch) break;

        const startIdx = startMatch.index;
        const startMarker = startMatch[0];

        if (isLikelyLiteralMention(processedText, startIdx, startMarker)) {
            searchCursor = startIdx + startMarker.length;
            continue;
        }

        const contentStart = startIdx + startMarker.length;
        escapeEndRegex.lastIndex = contentStart;
        const endMatch = escapeEndRegex.exec(processedText);

        let endIdx;
        let endMarker = '';
        if (!endMatch) {
            // 未闭合的 ESCAPE 区域（流式传输场景）
            endIdx = processedText.length;
        } else {
            endIdx = endMatch.index;
            endMarker = endMatch[0];
        }

        const rawContent = processedText.slice(contentStart, endIdx);
        const placeholder = `___VCP_ESCAPE_BLOCK_PLACEHOLDER_${escapeBlocks.length}___`;

        escapeBlocks.push({
            placeholder,
            startMarker,
            endMarker,
            rawContent
        });

        // 用占位符替换整个 ESCAPE 区域
        processedText = processedText.slice(0, startIdx) + placeholder + processedText.slice(endIdx + endMarker.length);
        searchCursor = startIdx + placeholder.length;
    }

    // 2. 处理普通的「始」「末」区域
    const normalStartRegex = /([「{]始[」}])/g;
    const normalEndRegex = /([「{]末[」}])/g;
    let normalCursor = 0;

    while (normalCursor < processedText.length) {
        normalStartRegex.lastIndex = normalCursor;
        const startMatch = normalStartRegex.exec(processedText);
        if (!startMatch) break;

        const startIdx = startMatch.index;
        const startMarker = startMatch[0];

        if (isLikelyLiteralMention(processedText, startIdx, startMarker)) {
            normalCursor = startIdx + startMarker.length;
            continue;
        }

        const contentStart = startIdx + startMarker.length;
        normalEndRegex.lastIndex = contentStart;
        const endMatch = normalEndRegex.exec(processedText);

        if (!endMatch) {
            // 未闭合的普通区域
            const content = processedText.slice(contentStart);
            processedText = processedText.slice(0, startIdx) + startMarker + escapeHtml(content);
            break;
        }

        const endIdx = endMatch.index;
        const endMarker = endMatch[0];
        const content = processedText.slice(contentStart, endIdx);

        const processedContent = startMarker + escapeHtml(content) + endMarker;
        processedText = processedText.slice(0, startIdx) + processedContent + processedText.slice(endIdx + endMarker.length);
        normalCursor = startIdx + processedContent.length;
    }

    // 3. 恢复并转义 ESCAPE 区域
    for (let i = 0; i < escapeBlocks.length; i++) {
        const block = escapeBlocks[i];
        // ESCAPE 区域内部的内容直接进行 HTML 转义
        const escapedContent = block.startMarker + escapeHtml(block.rawContent) + block.endMarker;
        processedText = processedText.split(block.placeholder).join(escapedContent);
    }

    return processedText;
}

/**
 * Ensures that triple backticks for code blocks are followed by a newline.
 * @param {string} text The input string.
 * @returns {string} The processed string with newlines after ``` if they were missing.
 */
function ensureNewlineAfterCodeBlock(text) {
    if (typeof text !== 'string') return text;
    // Replace ``` (possibly with leading spaces) not followed by \n or \r\n with the same ``` (and spaces) followed by \n
    return text.replace(/^(\s*```)(?![\r\n])/gm, '$1\n');
}

/**
 * Ensures that a tilde (~) is followed by a space, to prevent accidental strikethrough.
 * It avoids doing this for tildes inside URLs or file paths.
 * @param {string} text The input string.
 * @returns {string} The processed string with spaces after tildes where they were missing.
 */
function ensureSpaceAfterTilde(text) {
    if (typeof text !== 'string') return text;
    // Replace a single tilde `~` with `~ ` to prevent it from being interpreted as a strikethrough marker.
    // This should not affect tildes in URLs (e.g., `.../~user/`), home paths (`~/file`), or common code operators (`~=`, `~=`).
    // The previous rule excluded tildes preceded by ASCII word chars, so the closing marker in `~text~`
    // remained untouched (`~ text~`) and marked could still treat the pair as strikethrough in the main chat.
    // Keep only the URL/path/operator exclusions and protect both the opening and closing single tilde.
    return text.replace(/(^|[^/\\=~])~(?![\s~=/])/g, '$1~ ');
}

/**
 * Removes leading whitespace from lines starting with ``` (code block markers).
 * This only removes indentation from the fence markers themselves, NOT the code content.
 * @param {string} text The input string.
 * @returns {string} The processed string.
 */
function removeIndentationFromCodeBlockMarkers(text) {
    if (typeof text !== 'string') return text;
    // Only remove indentation from the opening and closing fence markers.
    // Do not touch any other line; this helper does not need to track fence state.
    const lines = text.split('\n');

    return lines.map(line => {
        const trimmedLine = line.trim();

        // Check if this is a fence marker
        if (trimmedLine.startsWith('```')) {
            return trimmedLine; // Remove indentation from fence markers
        }

        // Keep original formatting for code content
        return line;
    }).join('\n');
}

/**
 * Removes speaker tags like "[Sender's speech]: " from the beginning of a string.
 * @param {string} text The input string.
 * @returns {string} The processed string without the leading speaker tag.
 */
function removeSpeakerTags(text) {
    if (typeof text !== 'string') return text;
    const speakerTagRegex = /^\[(?:(?!\]:\s).)*的发言\]:\s*/;
    let newText = text;
    // Loop to remove all occurrences of the speaker tag at the beginning of the string
    while (speakerTagRegex.test(newText)) {
        newText = newText.replace(speakerTagRegex, '');
    }
    return newText;
}

/**
* Ensures there is a separator between an <img> tag and a subsequent code block fence (```).
* This prevents the markdown parser from failing to recognize the code block.
* It inserts a double newline and an HTML comment. The comment acts as a "hard" separator
* for the markdown parser, forcing it to reset its state after the raw HTML img tag.
* @param {string} text The input string.
* @returns {string} The processed string.
*/
function ensureSeparatorBetweenImgAndCode(text) {
    if (typeof text !== 'string') return text;
    // Looks for an <img> tag, optional whitespace, and then a ```.
    // Inserts a double newline and an HTML comment.
    return text.replace(/(<img[^>]+>)\s*(```)/g, '$1\n\n<!-- VCP-Renderer-Separator -->\n\n$2');
}


/**
 * Removes leading whitespace from special VCP blocks like Tool Requests.
 * This prevents the markdown parser from misinterpreting the entire indented
 * block as a single code block before it can be transformed into a bubble.
 * @param {string} text The input string.
 * @returns {string} The processed string.
 */
function deIndentToolRequestBlocks(text) {
    if (typeof text !== 'string') return text;

    const lines = text.split('\n');
    let inToolBlock = false;

    return lines.map(line => {
        // 🟢 加固：排除被反引号包裹的占位符（如 `<<<[TOOL_REQUEST]>>>`）
        const isBacktickWrapped = /`[^`]*<<<\[TOOL_REQUEST\]>>>[^`]*`/.test(line) ||
                                   /`[^`]*<<<\[END_TOOL_REQUEST\]>>>[^`]*`/.test(line);

        const isStart = !isBacktickWrapped && line.includes('<<<[TOOL_REQUEST]>>>');
        const isEnd = !isBacktickWrapped && line.includes('<<<[END_TOOL_REQUEST]>>>');

        let needsTrim = false;
        // If a line contains the start marker, we begin trimming.
        if (isStart) {
            needsTrim = true;
            inToolBlock = true;
        }
        // If we are already in a block, we continue trimming.
        else if (inToolBlock) {
            needsTrim = true;
        }

        const processedLine = needsTrim ? line.trimStart() : line;

        // If a line contains the end marker, we stop trimming from the *next* line.
        if (isEnd) {
            inToolBlock = false;
        }

        return processedLine;
    }).join('\n');
}


/**
 * Parses VCP tool_name from content.
 * @param {string} toolContent - The raw string content of the tool request.
 * @returns {string|null} The extracted tool name or null.
 */
function extractVcpToolName(toolContent) {
    const match = toolContent.match(/tool_name:\s*(?:[「{]始(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}])\s*([^「」{}]+?)\s*(?:[「{]末(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}])/i);
    return match ? match[1].trim() : null;
}

/**
 * Prettifies a single <pre> code block for DailyNote or VCP ToolUse.
 * @param {HTMLElement} preElement - The <pre> element to prettify.
 * @param {'dailynote' | 'vcptool'} type - The type of block.
 * @param {string} relevantContent - The relevant text content for the block.
 */
function prettifySinglePreElement(preElement, type, relevantContent) {
    if (!preElement || preElement.dataset.vcpPrettified === "true" || preElement.dataset.maidDiaryPrettified === "true") {
        return;
    }
    const ownerDocument = preElement.ownerDocument;
    if (!ownerDocument) return;

    // Remove the <code> element to prevent Turndown's default code block rule from matching
    // This ensures our custom Turndown rule can handle these special blocks
    const codeElement = preElement.querySelector('code');
    if (codeElement) {
        // Move any copy buttons or other elements before removing
        const copyButton = codeElement.querySelector('.code-copy, .fa-copy');
        if (copyButton) {
            copyButton.remove();
        }
        // Remove the code wrapper, we'll set content directly on pre
        preElement.innerHTML = '';
    }

    if (type === 'vcptool') {
        preElement.classList.add('vcp-tool-use-bubble');
        const toolName = extractVcpToolName(relevantContent);

        const label = ownerDocument.createElement('span');
        label.className = 'vcp-tool-label';
        label.textContent = 'ToolUse:';
        const name = ownerDocument.createElement('span');
        name.className = 'vcp-tool-name-highlight';
        name.textContent = toolName || 'UnknownTool';
        preElement.replaceChildren(label, name);
        preElement.dataset.vcpPrettified = "true";

    } else if (type === 'dailynote') {
        preElement.classList.add('maid-diary-bubble');
        const actualNoteContent = relevantContent.trim();
        const lines = actualNoteContent.split('\n');
        const firstLineTrimmed = lines[0] ? lines[0].trim() : "";
        const fragment = ownerDocument.createDocumentFragment();

        if (firstLineTrimmed.startsWith('Maid:') || firstLineTrimmed.startsWith('Maid')) {
            const maidLabel = ownerDocument.createElement('span');
            maidLabel.className = 'maid-label';
            maidLabel.textContent = lines.shift().trim();
            fragment.appendChild(maidLabel);
            if (lines.length > 0) fragment.appendChild(ownerDocument.createTextNode('\n'));
        }

        const bodyLines = (firstLineTrimmed.startsWith('Maid:') || firstLineTrimmed.startsWith('Maid'))
            ? lines
            : actualNoteContent.split('\n');
        bodyLines.forEach((line, index) => {
            if (index > 0) fragment.appendChild(ownerDocument.createElement('br'));
            fragment.appendChild(ownerDocument.createTextNode(line));
        });
        preElement.replaceChildren(fragment);
        preElement.dataset.maidDiaryPrettified = "true";
    }
}

const TAG_REGEX = /@([\u4e00-\u9fa5A-Za-z0-9_]+)/g;
const ALERT_TAG_REGEX = /@!([\u4e00-\u9fa5A-Za-z0-9_]+)/g;
const QUOTE_REGEX = /(?:"([^"]*)"|“([^”]*)”)/g; // Matches English "..." and Chinese “...”

/**
 * 一次性高亮所有文本模式（标签、引号），替换旧的多次遍历方法。
 * Markdown 加粗必须先由 marked 解析成 <strong>/<b>，这里不再二次解析 **...**，
 * 避免后处理拆分文本节点后破坏 Markdown 粗体边界。
 * @param {HTMLElement} messageElement The message content element.
 */
function highlightAllPatternsInMessage(messageElement) {
    if (!messageElement) return;
    const ownerDocument = messageElement.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const NodeFilterRef = ownerWindow?.NodeFilter;
    if (!ownerDocument || !NodeFilterRef) return;

    const walker = ownerDocument.createTreeWalker(
        messageElement,
        NodeFilterRef.SHOW_TEXT,
        (node) => {
            let parent = node.parentElement;
            while (parent && parent !== messageElement) {
                // 只跳过不应改写的技术内容和已高亮节点；不要跳过 STRONG/B。
                // 这样 Markdown 先完成加粗后，引号高亮仍可进入加粗文本内部执行。
                if (['PRE', 'CODE', 'STYLE', 'SCRIPT'].includes(parent.tagName) ||
                    parent.classList.contains('highlighted-tag') ||
                    parent.classList.contains('highlighted-alert-tag') ||
                    parent.classList.contains('highlighted-quote')) {
                    return NodeFilterRef.FILTER_REJECT;
                }
                parent = parent.parentElement;
            }
            return NodeFilterRef.FILTER_ACCEPT;
        },
        false
    );

    const nodesToProcess = [];
    let node;

    try {
        while ((node = walker.nextNode())) {
            const text = node.nodeValue || '';
            if (!text) continue;
            const matches = [];

            // 收集所有匹配
            let match;
            while ((match = TAG_REGEX.exec(text)) !== null) {
                matches.push({ type: 'tag', index: match.index, length: match[0].length, content: match[0] });
            }
            while ((match = ALERT_TAG_REGEX.exec(text)) !== null) {
                matches.push({ type: 'alert-tag', index: match.index, length: match[0].length, content: match[0] });
            }
            while ((match = QUOTE_REGEX.exec(text)) !== null) {
                // 确保引号内有内容
                if (match[1] || match[2]) {
                    matches.push({ type: 'quote', index: match.index, length: match[0].length, content: match[0] });
                }
            }

            if (matches.length > 0) {
                // 按位置排序
                matches.sort((a, b) => a.index - b.index);
                nodesToProcess.push({ node, matches });
            }
        }
    } catch (error) {
        if (!error.message.includes("no longer runnable")) {
            console.error("highlightAllPatterns: TreeWalker error", error);
        }
    }

    // 逆序处理节点
    for (let i = nodesToProcess.length - 1; i >= 0; i--) {
        const { node, matches } = nodesToProcess[i];
        if (!node.parentNode) continue;

        // 健壮的重叠匹配过滤逻辑
        const filteredMatches = [];
        let lastIndexProcessed = -1;
        for (const currentMatch of matches) {
            if (currentMatch.index >= lastIndexProcessed) {
                filteredMatches.push(currentMatch);
                lastIndexProcessed = currentMatch.index + currentMatch.length;
            }
        }

        if (filteredMatches.length === 0) continue;

        const fragment = ownerDocument.createDocumentFragment();
        let lastIndex = 0;

        // 构建新的节点结构
        filteredMatches.forEach(match => {
            // 添加匹配前的文本
            if (match.index > lastIndex) {
                fragment.appendChild(ownerDocument.createTextNode(node.nodeValue.substring(lastIndex, match.index)));
            }

            // 创建高亮元素
            const span = ownerDocument.createElement('span');
            if (match.type === 'tag') {
                span.className = 'highlighted-tag';
                span.textContent = match.content;
            } else if (match.type === 'alert-tag') {
                span.className = 'highlighted-alert-tag';
                span.textContent = match.content;
            } else if (match.type === 'quote') {
                span.className = 'highlighted-quote';
                span.textContent = match.content;
            }
            fragment.appendChild(span);

            lastIndex = match.index + match.length;
        });

        // 添加剩余文本
        if (lastIndex < node.nodeValue.length) {
            fragment.appendChild(ownerDocument.createTextNode(node.nodeValue.substring(lastIndex)));
        }

        node.parentNode.replaceChild(fragment, node);
    }
}

function countCodeBlockLines(text) {
    if (typeof text !== 'string') return 0;
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    if (!normalized) return 0;
    return normalized.split('\n').length;
}

async function writeTextToClipboard(text, ownerDocument = mainRefs.chatMessagesDiv?.ownerDocument) {
    const ownerWindow = ownerDocument?.defaultView;
    if (ownerWindow?.navigator?.clipboard?.writeText) {
        await ownerWindow.navigator.clipboard.writeText(text);
        return;
    }
    if (!ownerDocument?.body) throw new Error('Clipboard requires an owning document');

    const textarea = ownerDocument.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    ownerDocument.body.appendChild(textarea);
    textarea.select();

    try {
        ownerDocument.execCommand('copy');
    } finally {
        textarea.remove();
    }
}

function setupSingleCodeCopyButton(preElement, rawText) {
    if (!preElement || !preElement.parentElement || preElement.dataset.vcpCodeCopy === 'true') return;
    if (preElement.dataset.vcpPrettified === "true" ||
        preElement.dataset.maidDiaryPrettified === "true" ||
        preElement.dataset.vcpHtmlPreview === "blocked") {
        return;
    }

    const isInsideVcpBubble = preElement.closest('.vcp-tool-use-bubble, .vcp-tool-result-bubble, .maid-diary-bubble');
    if (isInsideVcpBubble) return;

    const codeText = typeof rawText === 'string'
        ? rawText
        : (preElement.getAttribute('data-raw-content') || preElement.textContent || '');
    if (countCodeBlockLines(codeText) <= 4) return;

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'vcp-code-copy-button';
    copyButton.dataset.vcpInteractive = 'true';
    copyButton.title = '复制代码';
    copyButton.setAttribute('aria-label', '复制代码');
    copyButton.innerHTML = '<span class="vcp-code-copy-icon">📋</span><span class="vcp-code-copy-text">复制</span>';

    copyButton.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const originalHtml = copyButton.innerHTML;
        copyButton.disabled = true;

        try {
            await writeTextToClipboard(codeText, preElement.ownerDocument);
            copyButton.classList.add('copied');
            copyButton.innerHTML = '<span class="vcp-code-copy-icon">✅</span><span class="vcp-code-copy-text">已复制</span>';
        } catch (error) {
            console.error('[ContentProcessor] Copy code failed:', error);
            copyButton.classList.add('failed');
            copyButton.innerHTML = '<span class="vcp-code-copy-icon">⚠️</span><span class="vcp-code-copy-text">失败</span>';
        }

        scheduleOwnedTimeout(copyButton, () => {
            if (!copyButton.isConnected) return;
            copyButton.disabled = false;
            copyButton.classList.remove('copied', 'failed');
            copyButton.innerHTML = originalHtml;
        }, 1400);
    });

    const previewContainer = preElement.closest('.vcp-html-preview-container');
    if (previewContainer) {
        let actions = previewContainer.querySelector(':scope > .vcp-codeblock-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'vcp-codeblock-actions';
            previewContainer.appendChild(actions);
        }
        actions.insertBefore(copyButton, actions.firstChild);
        previewContainer.classList.add('has-code-copy');
    } else {
        preElement.classList.add('vcp-codeblock-with-copy');
        preElement.appendChild(copyButton);
    }

    preElement.dataset.vcpCodeCopy = 'true';
}

function setupCodeCopyButtons(contentDiv) {
    if (!contentDiv) return;

    contentDiv.querySelectorAll('pre').forEach(preElement => {
        if (!preElement || !preElement.parentElement) return;
        const codeElement = preElement.querySelector('code');
        const blockText = preElement.getAttribute('data-raw-content') ||
            (codeElement ? (codeElement.textContent || '') : (preElement.textContent || ''));
        setupSingleCodeCopyButton(preElement, blockText);
    });
}

/**
 * Processes all relevant <pre> blocks within a message's contentDiv AFTER marked.parse().
 * @param {HTMLElement} contentDiv - The div containing the parsed Markdown.
 */
function processAllPreBlocksInContentDiv(contentDiv) {
    if (!contentDiv) return;

    const allPreElements = contentDiv.querySelectorAll('pre');
    allPreElements.forEach(preElement => {
        // 🟢 增加防御性检查：确保 preElement 仍在 DOM 中
        // 在嵌套的 pre 场景下，外层 pre 的处理可能会导致内层 pre 被移出 DOM
        if (!preElement || !preElement.parentElement) return;

        if (preElement.dataset.vcpPrettified === "true" ||
            preElement.dataset.maidDiaryPrettified === "true" ||
            preElement.dataset.vcpHtmlPreview === "true" ||
            preElement.dataset.vcpHtmlPreview === "blocked") {
            return; // Already processed or blocked
        }

        // 🟢 首先检查是否在 VCP 气泡内
        const isInsideVcpBubble = preElement.closest('.vcp-tool-use-bubble, .vcp-tool-result-bubble, .maid-diary-bubble');
        if (isInsideVcpBubble) {
            // 在气泡内的 pre 不应该被处理为可预览的 HTML
            preElement.dataset.vcpHtmlPreview = "blocked";
            return;
        }

        const codeElement = preElement.querySelector('code');
        const blockText = codeElement ? (codeElement.textContent || "") : (preElement.textContent || "");
        // 在美化前，将原始文本内容存储到 data-* 属性中
        // 这是为了在后续的上下文净化过程中，能够恢复原始内容，避免特殊字符被转义
        preElement.setAttribute('data-raw-content', blockText);

        // Check for VCP Tool Request
        if (blockText.includes('<<<[TOOL_REQUEST]>>>') && blockText.includes('<<<[END_TOOL_REQUEST]>>>')) {
            const vcpContentMatch = blockText.match(/<<<\[TOOL_REQUEST\]>>>([\s\S]*?)<<<\[END_TOOL_REQUEST\]>>>/);
            const actualVcpText = vcpContentMatch ? vcpContentMatch[1].trim() : "";
            prettifySinglePreElement(preElement, 'vcptool', actualVcpText);
        }
        // Check for DailyNote
        else if (blockText.includes('<<<DailyNoteStart>>>') && blockText.includes('<<<DailyNoteEnd>>>')) {
            const dailyNoteContentMatch = blockText.match(/<<<DailyNoteStart>>>([\s\S]*?)<<<DailyNoteEnd>>>/);
            const actualDailyNoteText = dailyNoteContentMatch ? dailyNoteContentMatch[1].trim() : "";
            prettifySinglePreElement(preElement, 'dailynote', actualDailyNoteText);
        }
        // Check for HTML code block
        else if (codeElement && (codeElement.classList.contains('language-html') || blockText.trim().startsWith('<!DOCTYPE html>') || blockText.trim().startsWith('<html'))) {
            setupHtmlPreview(preElement, blockText);
        }
    });
}

/**
 * Sets up a play/return toggle for HTML code blocks.
 * @param {HTMLElement} preElement - The pre element containing the code.
 * @param {string} htmlContent - The raw HTML content.
 */
function setupHtmlPreview(preElement, htmlContent) {
    if (preElement.dataset.vcpHtmlPreview === "true" ||
        preElement.dataset.vcpHtmlPreview === "blocked") return;
    const ownerDocument = preElement.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!ownerDocument || !ownerWindow) return;

    // 🟢 核心修复：检查是否在 VCP 气泡内
    const isInsideVcpBubble = preElement.closest('.vcp-tool-use-bubble, .vcp-tool-result-bubble, .maid-diary-bubble');
    if (isInsideVcpBubble) {
        console.log('[ContentProcessor] Skipping HTML preview: inside VCP bubble');
        preElement.dataset.vcpHtmlPreview = "blocked";
        return;
    }

    // 🟢 额外检查：内容是否包含「始」「末」标记及其变体
    const hasToolMarkers = /[「{][始末](?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/i.test(htmlContent);
    if (hasToolMarkers) {
        console.log('[ContentProcessor] Skipping HTML preview: contains tool markers');
        preElement.dataset.vcpHtmlPreview = "blocked";
        return;
    }

    preElement.dataset.vcpHtmlPreview = "true";

    // Create container for the whole block to manage positioning
    const container = ownerDocument.createElement('div');
    container.className = 'vcp-html-preview-container';
    preElement.parentNode.insertBefore(container, preElement);
    container.appendChild(preElement);

    const actions = ownerDocument.createElement('div');
    actions.className = 'vcp-codeblock-actions';
    container.appendChild(actions);

    // Create the toggle button
    const actionBtn = ownerDocument.createElement('button');
    actionBtn.className = 'vcp-html-preview-toggle';
    actionBtn.innerHTML = '<span>▶️ 播放</span>';
    actionBtn.title = '在气泡内预览 HTML';
    actionBtn.dataset.vcpInteractive = 'true';
    actionBtn.type = 'button';
    actions.appendChild(actionBtn);

    let previewFrame = null;
    let messageHandler = null;
    const frameId = `vcp-frame-${Math.random().toString(36).substr(2, 9)}`;

    const destroyPreview = () => {
        if (messageHandler) {
            ownerWindow.removeEventListener('message', messageHandler);
            messageHandler = null;
        }
        if (previewFrame) {
            // 🔴 关键修复：彻底切断 iframe 内部进程
            try {
                previewFrame.srcdoc = '';
                previewFrame.src = 'about:blank';
                previewFrame.contentWindow?.stop?.();
            } catch (e) { /* ignore */ }
            previewFrame.remove();
            previewFrame = null;
        }
    };

    // 将清理函数绑定到容器，以便外部（如 messageRenderer）调用
    container._vcpCleanup = destroyPreview;

    actionBtn.addEventListener('click', (e) => {
        // 🔴 彻底阻止事件传播，防止触发任何父级监听器
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const isPreviewing = container.classList.contains('preview-mode');

        if (!isPreviewing) {
            // 🟢 核心修复：先获取当前高度，避免高度塌陷导致的滚动跳动
            const currentHeight = preElement.offsetHeight;

            // 为容器设置固定高度，防止高度塌陷
            container.style.minHeight = currentHeight + 'px';

            container.classList.add('preview-mode');
            actionBtn.innerHTML = '<span>🔙 返回</span>';

            if (!previewFrame) {
                previewFrame = ownerDocument.createElement('iframe');
                previewFrame.className = 'vcp-html-preview-frame';
                previewFrame.dataset.frameId = frameId;
                // 允许预览自身脚本运行，但不给同源权限；srcdoc 因此不能访问父应用 DOM、
                // localStorage 或 Electron 页面中的同源能力。
                previewFrame.setAttribute('sandbox', 'allow-scripts');
                previewFrame.setAttribute('referrerpolicy', 'no-referrer');

                // 🟢 先设置iframe的初始高度为当前代码块高度
                previewFrame.style.height = currentHeight + 'px';

                previewFrame.srcdoc = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            html, body { margin: 0; padding: 0; overflow: hidden; height: auto; }
                            body {
                                padding: 20px;
                                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                                background: white;
                                color: black;
                                line-height: 1.5;
                                box-sizing: border-box;
                                min-height: 100px;
                            }
                            * { box-sizing: border-box; }
                            img { max-width: 100%; height: auto; }
                        </style>
                    </head>
                    <body>
                        <div id="vcp-wrapper">${htmlContent}</div>
                        <script>
                            function updateHeight() {
                                const wrapper = document.getElementById('vcp-wrapper');
                                if (!wrapper) return;
                                const height = Math.max(wrapper.scrollHeight + 40, document.body.scrollHeight);
                                window.parent.postMessage({
                                    type: 'vcp-html-resize',
                                    height: height,
                                    frameId: '${frameId}'
                                }, '*');
                            }
                            window.onload = () => {
                                setTimeout(updateHeight, 50);
                                setTimeout(updateHeight, 500);
                            };
                            new ResizeObserver(updateHeight).observe(document.body);
                        </script>
                    </body>
                    </html>
                `;

                messageHandler = (msg) => {
                    if (
                        !previewFrame ||
                        msg.source !== previewFrame.contentWindow ||
                        !msg.data ||
                        msg.data.type !== 'vcp-html-resize' ||
                        msg.data.frameId !== frameId
                    ) return;
                    const requestedHeight = Number(msg.data.height);
                    if (!Number.isFinite(requestedHeight)) return;
                    const safeHeight = Math.min(12000, Math.max(100, Math.round(requestedHeight)));
                    // 🟢 平滑过渡到新高度
                    previewFrame.style.transition = 'height 0.3s ease';
                    previewFrame.style.height = safeHeight + 'px';
                    container.style.minHeight = safeHeight + 'px';
                };
                ownerWindow.addEventListener('message', messageHandler);

                container.appendChild(previewFrame);
            }

            // 🟢 延迟隐藏代码块，确保iframe先显示
            scheduleOwnedTimeout(preElement, () => {
                preElement.style.display = 'none';
            }, 50);

        } else {
            // 返回代码模式
            container.classList.remove('preview-mode');
            actionBtn.innerHTML = '<span>▶️ 播放</span>';

            // 🟢 先显示代码块
            preElement.style.display = 'block';

            // 🔴 关键修复：点击返回时销毁预览产生的资源，停止 JS 运行
            destroyPreview();

            // 清除固定高度限制
            container.style.minHeight = '';
        }
    });
}

/**
 * Processes interactive buttons in AI messages
 * @param {HTMLElement} contentDiv The message content element.
 */
function processInteractiveButtons(contentDiv, settings = {}) {
    if (!contentDiv) return;

    // 设置热切换为关闭时，立即撤销当前内容树中既有按钮能力，而不只是停止绑定新按钮。
    if (settings.enableAiMessageButtons === false) {
        contentDiv.querySelectorAll('button[data-vcp-interactive="true"]').forEach(button => {
            clearOwnedTimeouts(button);
            button._vcpInteractiveCleanup?.();
            delete button._vcpInteractiveCleanup;
            delete button.dataset.vcpInteractive;
            if (button.dataset.originalText) restoreButton(button);
        });
        return;
    }

    // Find all button elements
    const buttons = contentDiv.querySelectorAll('button');

    buttons.forEach(button => {
        // Skip if already processed
        if (button.dataset.vcpInteractive === 'true') return;

        // Mark as processed
        button.dataset.vcpInteractive = 'true';

        // Set up button styling
        setupButtonStyle(button);

        // Add click event listener
        button.addEventListener('click', handleAIButtonClick);
        button._vcpInteractiveCleanup = () => button.removeEventListener('click', handleAIButtonClick);

        console.log('[ContentProcessor] Processed interactive button:', button.textContent.trim());
    });
}

/**
 * Sets up functional properties for interactive buttons (no styling)
 * @param {HTMLElement} button The button element
 */
function setupButtonStyle(button) {
    // Ensure button looks clickable
    button.style.cursor = 'pointer';

    // Prevent any form submission or default behavior
    button.type = 'button';
    button.setAttribute('type', 'button');

    // Note: Visual styling is left to AI-defined CSS classes and styles
}

/**
 * Handles click events on AI-generated buttons
 * @param {Event} event The click event
 */
function handleAIButtonClick(event) {
    const button = event.currentTarget;
    if (!button || button.tagName !== 'BUTTON') return false;

    // Completely prevent any default behavior
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    // Check if button is disabled
    if (button.disabled) {
        return false;
    }

    // Get text to send (priority: data-send attribute > button text)
    const sendText = button.dataset.send || button.textContent.trim();

    // Validate text
    if (!sendText || sendText.length === 0) {
        console.warn('[ContentProcessor] Button has no text to send');
        return false;
    }

    // Format the text to be sent
    let finalSendText = `[[点击按钮:${sendText}]]`;

    // Truncate if the final text is too long
    if (finalSendText.length > 500) {
        console.warn('[ContentProcessor] Button text too long, truncating');
        const maxTextLength = 500 - '[[点击按钮:]]'.length; // Account for '[[点击按钮:' and ']]'
        const truncatedText = sendText.substring(0, maxTextLength);
        finalSendText = `[[点击按钮:${truncatedText}]]`;
    }

    // Disable button to prevent double-click
    disableButton(button);

    // Send the message asynchronously to avoid blocking
    scheduleOwnedTimeout(button, () => {
        void sendButtonMessage(finalSendText, button);
    }, 10);

    return false;
}

/**
 * Disables a button and provides visual feedback
 * @param {HTMLElement} button The button to disable
 */
function disableButton(button) {
    button.disabled = true;
    button.style.opacity = '0.6';
    button.style.cursor = 'not-allowed';

    // Add checkmark to indicate it was clicked
    const originalText = button.textContent;
    button.textContent = originalText + ' ✓';

    // Store original text for potential restoration
    button.dataset.originalText = originalText;
}

/**
 * Restores a button to its original state
 * @param {HTMLElement} button The button to restore
 */
function restoreButton(button) {
    button.disabled = false;
    button.style.opacity = '1';
    button.style.cursor = 'pointer';

    // Restore original text if available
    if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
    }
}

/**
 * Sends a message triggered by button click
 * @param {string} text The text to send
 * @param {HTMLElement} button The button that triggered the send
 */
async function sendButtonMessage(text, button) {
    try {
        // Check if chatManager is available
        if (mainRefs.messageCommands && typeof mainRefs.messageCommands.handleSendMessage === 'function') {
            // 等待 owner 的异步发送结果；拒绝时恢复按钮而不是留下未处理 Promise。
            await sendMessageViaMainChat(text);
        } else {
            throw new Error('No message sending function available');
        }

        console.log('[ContentProcessor] Button message sent:', text);

    } catch (error) {
        console.error('[ContentProcessor] Failed to send button message:', error);

        // Restore button on error
        restoreButton(button);

        // Show error notification
        showErrorNotification('发送失败，请重试');
    }
}

/**
 * Sends message via main chat interface
 * @param {string} text The text to send
 */
function sendMessageViaMainChat(text) {
    const send = mainRefs.messageCommands?.handleSendMessage;
    if (typeof send !== 'function') throw new Error('This Surface does not provide message sending');
    // The owner supplies the send capability. Never discover #messageInput
    // from the document: that would route an internal Surface to main chat.
    return send(text);
}

/**
 * Shows an error notification to the user
 * @param {string} message The error message
 */
function showErrorNotification(message) {
    // Try to use existing notification system
    if (mainRefs.uiHelper && typeof mainRefs.uiHelper.showToastNotification === 'function') {
        mainRefs.uiHelper.showToastNotification(message, 'error');
        return;
    }

    // Fallback: create a simple notification
    const ownerDocument = mainRefs.chatMessagesDiv?.ownerDocument;
    if (!ownerDocument) return;
    const notification = ownerDocument.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ff4444;
        color: white;
        padding: 12px 20px;
        border-radius: 4px;
        z-index: 10000;
        font-size: 14px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    `;

    ownerDocument.body.appendChild(notification);

    // Auto remove after 3 seconds
    scheduleOwnedTimeout(notification, () => {
        if (notification.parentNode) {
            notification.remove();
        }
    }, 3000);
}

function looksLikeSafeSingleDollarMath(content) {
    const trimmedContent = (content || '').trim();
    if (!trimmedContent) return false;

    const hasExplicitMathSignal = /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|text|mathrm|mathbf|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(trimmedContent);
    const isSimpleNumericMath = /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:%|\\%|‰|°))?$/.test(trimmedContent);
    const isSimpleIdentifierMath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedContent);

    // 数字开头的候选仍需严格检查，避免把价格与价格单位误当作公式。
    // 此函数只处理单个 DOM 文本节点，不会跨 HTML 元素配对美元符号。
    if (/^\d/.test(trimmedContent) && !hasExplicitMathSignal && !isSimpleNumericMath) return false;

    // 路径、模板表达式与 Markdown 表格跨列候选继续排除。
    // 闭合的 `$x$`、`$n$`、`$abc$` 是标准行内数学；不闭合的 `$PATH` 不会匹配。
    if (trimmedContent.startsWith('/')) return false;
    if (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) return false;
    if (trimmedContent.includes('|')) return false;

    return hasExplicitMathSignal || isSimpleNumericMath || isSimpleIdentifierMath;
}

function normalizeSafeSingleDollarMathInTextNodes(root) {
    if (!root) return;
    const ownerDocument = root.ownerDocument;
    const NodeFilterRef = ownerDocument?.defaultView?.NodeFilter;
    if (!ownerDocument || !NodeFilterRef) return;

    const walker = ownerDocument.createTreeWalker(
        root,
        NodeFilterRef.SHOW_TEXT,
        (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;

            if (parent.closest('pre, code, script, style, textarea, .katex')) {
                return NodeFilterRef.FILTER_REJECT;
            }

            return node.nodeValue && node.nodeValue.includes('$')
                ? NodeFilterRef.FILTER_ACCEPT
                : NodeFilterRef.FILTER_REJECT;
        },
        false
    );

    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
        nodes.push(node);
    }

    nodes.forEach((textNode) => {
        textNode.nodeValue = textNode.nodeValue.replace(/(^|[^\w\\$])\$([^\$\n]{1,1200}?)\$(?![\w])/g, (match, prefix, content) => {
            if (!looksLikeSafeSingleDollarMath(content)) return match;
            return `${prefix}\\(${content.trim()}\\)`;
        });
    });
}

/**
 * Applies synchronous post-render processing to the message content.
 * This handles tasks like KaTeX, code highlighting, and button processing
 * that do not depend on a fully stable DOM tree from complex innerHTML.
 * @param {HTMLElement} contentDiv The message content element.
 */
function processRenderedContent(contentDiv, settings = {}) {
    if (!contentDiv) return;
    const ownerWindow = contentDiv.ownerDocument?.defaultView;

    // 将经严格判定的单美元公式转换为 \(...\)；普通价格保持原始 `$` 文本。
    normalizeSafeSingleDollarMathInTextNodes(contentDiv);

    // KaTeX rendering
    if (ownerWindow?.renderMathInElement) {
        ownerWindow.renderMathInElement(contentDiv, {
            delimiters: [
                {left: "$$", right: "$$", display: true},
                // 不在此处注册宽松的 `$...$`：否则两个价格会绕过上面的安全判断被强制配对。
                // 合法单美元公式已经由预解析保护器或 DOM 文本节点规范器转换为 \(...\)。
                {left: "\\(", right: "\\)", display: false},
                {left: "\\[", right: "\\]", display: true}
            ],
            ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
            throwOnError: false
        });
    }

    // Special block formatting (VCP/Diary)
    processAllPreBlocksInContentDiv(contentDiv);

    // 为超过 4 行的普通代码块添加复制按钮；HTML 预览块会与播放/返回按钮共用右上角工具栏
    setupCodeCopyButtons(contentDiv);

    // Process interactive buttons, passing settings
    processInteractiveButtons(contentDiv, settings);

    // Apply syntax highlighting to code blocks
    if (ownerWindow?.hljs) {
        contentDiv.querySelectorAll('pre code').forEach((block) => {
            // 🟢 增加防御性检查：确保 block 及其父元素存在
            // 在嵌套的 code block 场景下，外层 block 的高亮可能会导致内层 block 被移出 DOM
            if (block && block.parentElement) {
                // Only highlight if the block hasn't been specially prettified (e.g., DailyNote or VCP ToolUse)
                if (!block.parentElement.dataset.vcpPrettified && !block.parentElement.dataset.maidDiaryPrettified) {
                    ownerWindow.hljs.highlightElement(block);
                }
            }
        });
    }
}



/**
 * 为 CSS 字符串中的所有选择器添加作用域 ID 前缀。
 * @param {string} cssString - 原始 CSS 文本。
 * @param {string} scopeId - 唯一的作用域 ID (不带 #)。
 * @returns {string} 处理后的 CSS 文本。
 */
function escapeCssIdentifier(value) {
    // scopeId 来自渲染器生成值，但仍按 CSS identifier 规则转义，避免未来调用方扩大后形成注入面。
    return String(value).replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match, leadingDigit) => {
        if (leadingDigit) return `\\3${leadingDigit} `;
        return `\\${match}`;
    });
}

function scopeSelector(selector, scopeId) {
    const scopeSelectorText = `#${escapeCssIdentifier(scopeId)}`;
    const normalized = selector.trim();
    if (!normalized) throw new SyntaxError('Empty selector is not allowed');

    // assistant HTML 中的 document 根选择器应映射到消息根，而不是成为其后代。
    // 根标记后可能直接跟组合符、class、id、属性或伪类，不能只处理空白边界。
    const rootSelectorRegex = /^(?::root|html|body)(?=$|[\s>+~.#[:])/i;
    if (rootSelectorRegex.test(normalized)) {
        return normalized.replace(rootSelectorRegex, scopeSelectorText);
    }
    if (/^::?[\w-]+$/.test(normalized)) return `${scopeSelectorText}${normalized}`;
    return `${scopeSelectorText} ${normalized}`;
}

function scopeCss(cssString, scopeId) {
    if (typeof cssString !== 'string' || !cssString.trim() || !scopeId) return '';

    try {
        const ast = cssTree.parse(cssString, {
            context: 'stylesheet',
            positions: false,
            parseCustomProperty: true
        });

        // 外部 stylesheet 导入会绕过当前消息源码的审查与缓存边界，直接拒绝整段 CSS。
        const forbiddenAtRules = new Set(['import', 'namespace', 'charset']);
        let forbiddenReason = '';
        cssTree.walk(ast, {
            visit: 'Atrule',
            enter(node) {
                if (!forbiddenReason && forbiddenAtRules.has(String(node.name || '').toLowerCase())) {
                    forbiddenReason = `forbidden @${node.name}`;
                }
            }
        });
        if (forbiddenReason) throw new SyntaxError(forbiddenReason);

        // css-tree 会递归访问 @media/@supports/@container/@layer 内的 Rule。
        // keyframes 内的 from/to/百分比步骤不是 DOM 选择器，必须保持原样。
        cssTree.walk(ast, {
            visit: 'Rule',
            enter(node) {
                const ownerAtRule = this.atrule;
                if (ownerAtRule && /(?:^|-)keyframes$/i.test(ownerAtRule.name || '')) return;
                if (!node.prelude || node.prelude.type !== 'SelectorList') {
                    throw new SyntaxError('Unsupported CSS rule prelude');
                }

                const scopedSelectors = [];
                node.prelude.children.forEach(selectorNode => {
                    scopedSelectors.push(scopeSelector(cssTree.generate(selectorNode), scopeId));
                });
                node.prelude = cssTree.parse(scopedSelectors.join(','), {
                    context: 'selectorList',
                    positions: false
                });
            }
        });

        const generated = cssTree.generate(ast);
        // 二次解析保证生成结果完整，避免不完整流式 CSS 被部分注入。
        cssTree.parse(generated, { context: 'stylesheet', positions: false });
        return generated;
    } catch (error) {
        console.warn('[ContentProcessor] Scoped CSS rejected:', error?.message || error);
        return '';
    }
}


/**
 * Applies a series of common text processing rules in a single pass.
 * @param {string} text The input string.
 * @returns {string} The processed string.
 */
function applyContentProcessors(text) {
    if (typeof text !== 'string') return text;

    // Apply processors that need special handling first
    let processedText = text;

    // Use the proper function for code block markers (preserves content formatting)
    processedText = removeIndentationFromCodeBlockMarkers(processedText);

    // Then apply simple regex replacements
    return processedText
        // ensureNewlineAfterCodeBlock
        .replace(/^(\s*```)(?![\r\n])/gm, '$1\n')
        // ensureSpaceAfterTilde
        .replace(/(^|[^/\\=~])~(?![\s~=/])/g, '$1~ ')
        // removeSpeakerTags - Simplified regex to remove all occurrences at the start
        .replace(/^(\[(?:(?!\]:\s).)*的发言\]:\s*)+/g, '')
        // ensureSeparatorBetweenImgAndCode
        .replace(/(<img[^>]+>)\s*(```)/g, '$1\n\n<!-- VCP-Renderer-Separator -->\n\n$2');
}


/**
 * 智能地移除被错误解析为代码块的行首缩进。
 * 它会跳过代码围栏 (```) 内部的内容和 Markdown 列表项。
 * @param {string} text 输入文本。
 * @returns {string} 处理后的文本。
 */
/**
 * 智能地移除被错误解析为代码块的行首缩进。
 * 只处理HTML标签的缩进，完全保护代码块和普通文本的格式。
 * @param {string} text 输入文本。
 * @returns {string} 处理后的文本。
 */
function deIndentMisinterpretedCodeBlocks(text) {
    if (typeof text !== 'string') return text;

    const lines = text.split('\n');
    let inFence = false;

    // 匹配 Markdown 列表标记，例如 *, -, 1.
    const listRegex = /^\s*([-*]|\d+\.)\s+/;

    // 匹配可能导致 Markdown 解析问题的 HTML/XML 标签行。
    // 不再维护固定白名单：AI 常输出 SVG/MathML/自定义元素片段（如 </g>、<path>、<linearGradient>），
    // 4+ 空格或 tab 缩进会触发 Markdown indented code block，导致这些标签被渲染成代码块。
    // 这里只接受“行首缩进后立即是合法标签起始”的行，避免误处理普通缩进文本。
    const htmlTagRegex = /^\s*<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s>\/])/;

    // 匹配缩进的 HTML 注释行。流式渲染 div 动画块时，AI 常输出缩进注释作为分段标记；
    // 4+ 空格 / tab 会触发 Markdown indented code block，导致注释短暂闪成代码块。
    // 允许未闭合注释，覆盖 token 尚未流完的中间态；代码围栏内由 inFence 保护。
    const indentedHtmlCommentRegex = /^(?: {4,}|\t+)<!--/;

    // 匹配中文字符开头，用于识别首行缩进的段落
    const chineseParagraphRegex = /^[\u4e00-\u9fa5]/;

    return lines.map(line => {
        // 检测代码围栏
        if (line.trim().startsWith('```')) {
            inFence = !inFence;
            // 移除代码围栏标记本身的缩进
            return line.trimStart();
        }

        // 如果在代码块内，完全不处理
        if (inFence) {
            return line;
        }

        const trimmedStartLine = line.trimStart();
        const hasIndentation = line.length > trimmedStartLine.length;

        // 只处理有缩进的行
        if (hasIndentation) {
            // 如果是列表项，则不处理
            if (listRegex.test(line)) {
                return line;
            }

            // 🟢 如果是HTML标签、HTML注释或中文段落，则移除会触发 Markdown 缩进代码块的缩进
            if (htmlTagRegex.test(line) || indentedHtmlCommentRegex.test(line) || chineseParagraphRegex.test(trimmedStartLine)) {
                return trimmedStartLine;
            }
        }

        // 其他所有情况，保持原样
        return line;
    }).join('\n');
}



/**
 * 清理指定容器及其子元素中所有的 HTML 预览资源（iframe、事件监听器等）。
 * @param {HTMLElement} contentDiv - 存储消息内容的容器。
 */
function cleanupPreviewsInContent(contentDiv) {
    if (!contentDiv) return;
    clearOwnedTimeouts(contentDiv);
    contentDiv.querySelectorAll('*').forEach(clearOwnedTimeouts);
    contentDiv.querySelectorAll('button[data-vcp-interactive="true"]').forEach(button => {
        button._vcpInteractiveCleanup?.();
        delete button._vcpInteractiveCleanup;
        delete button.dataset.vcpInteractive;
    });
    const containers = contentDiv.querySelectorAll('.vcp-html-preview-container');
    containers.forEach(container => {
        if (typeof container._vcpCleanup === 'function') {
            try {
                container._vcpCleanup();
            } catch (e) {
                console.error('[ContentProcessor] Error during preview cleanup:', e);
            }
            delete container._vcpCleanup;
        }
    });
}


const contentProcessor = Object.freeze({
    initializeContentProcessor,
    ensureNewlineAfterCodeBlock,
    ensureSpaceAfterTilde,
    removeIndentationFromCodeBlockMarkers,
    removeSpeakerTags,
    ensureSeparatorBetweenImgAndCode,
    deIndentToolRequestBlocks,
    deIndentMisinterpretedCodeBlocks,
    processAllPreBlocksInContentDiv,
    processRenderedContent,
    processInteractiveButtons,
    handleAIButtonClick,
    highlightAllPatternsInMessage, // Export the new async highlighter
    sendButtonMessage,
    scopeCss, // Export the new CSS scoping function
    applyContentProcessors, // Export the new batch processor
    escapeHtml,
    processStartEndMarkers,
    cleanupPreviewsInContent,
    dispose() {
        if (mainRefs.chatMessagesDiv) cleanupPreviewsInContent(mainRefs.chatMessagesDiv);
        mainRefs = {};
    },
});
return contentProcessor;
}

// CSS scoping is a pure transform and does not consume renderer state.
const pureContentProcessor = createContentProcessor();
export const scopeCss = pureContentProcessor.scopeCss;
