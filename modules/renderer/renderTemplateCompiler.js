import { createContentPipeline, PIPELINE_MODES } from './contentPipeline.js';
import { createContentRuntime } from '../chat/contentRuntime.js';
import { createMermaidPlaceholderTransform } from '../chat/contentTransforms.js';
import { transformChartReferences } from '../chat/chartEmbedTransform.js';
import { replaceToolRequestBlocks, readToolRequestField } from './toolRequestScanner.js';
import { replaceMarkdownCodeDomains } from './markdownCodeDomainScanner.js';
import { collectToolBatchRanges } from './toolBatchRegions.js';
import { splitToolBatchDomains, composeToolBatchHtml } from './toolBatchDomains.js';
import { collectClosedToolResultRanges, isToolResultHidden } from './toolResultRegions.js';
import { sanitizeToolDataHtml } from './toolDataHtml.js';
import { parseJevToolUse } from './jevToolUse.js';
import { findMalformedToolFields, describeToolRequestMarkerProblem } from './toolRequestMarkers.js';

// Shared synchronous text compiler. No DOM initialization or script execution.
export function createRenderTemplateCompiler({ mainRendererReferences, contentProcessor, fixEmoticonUrlsInMarkdown = text => text, registerLazyTool, toolResultFullContentMap = new Map() }) {
function deferToolRequest(_block, source) {
    const field = key => readToolRequestField(source, key);
    const name = field('tool_name') || source.match(/<tool_name>([\s\S]*?)<\/tool_name>/i)?.[1]?.trim() || '';
    if (name.toLowerCase() === 'dailynote') return null;
    const jev = parseJevToolUse(field('JEV'));
    const problem = describeToolRequestMarkerProblem({
        toolName: name,
        malformedFields: findMalformedToolFields(source),
        isJev: Boolean(jev),
        content: source
    });
    const displayName = jev?.displayName || problem.displayName;
    const summarySource = ['command', 'command1', 'path', 'filePath', 'powershell', 'text', 'keys', 'paths', 'file', 'glob', 'query', 'url', 'prompt']
        .map(key => {
            const value = field(key);
            return value ? `${key}:「始」${value.slice(0, 240)}「末」` : '';
        }).filter(Boolean).join('\n');
    const id = registerLazyTool({ type: 'request', raw: source, meta: { summarySource, fingerprint: hashStringFNV1a(source) } });
    const kind = jev ? 'jev-tool-use' : 'tool-use';
    const hint = problem.hint ? ` <span class="vcp-tool-malformed-hint">${escapeHtml(problem.hint)}</span>` : '';
    const label = jev ? (displayName ? 'JEVToolUse:' : 'JEVToolUse') : 'VCP-ToolUse:';
    const nameHtml = displayName ? ` <span class="vcp-tool-name-highlight">${escapeHtml(displayName)}</span>` : '';
    const bubbleClass = `vcp-tool-use-bubble${jev ? ' vcp-jev-tool-use-bubble' : ''}${problem.isMalformed ? ' is-malformed' : ''}`;
    return `<div class="${bubbleClass}" data-vcp-block-type="${kind}" data-vcp-preserve-children="true" data-vcp-lazy-tool-id="${id}"><div class="vcp-tool-summary"><span class="vcp-tool-label">${label}</span>${nameHtml}${hint}</div><div class="vcp-tool-details"></div></div>`;
}
let contentPipeline, contentRuntime;
let toolResultContentIdCounter = 0;
const TOOL_RESULT_TRUNCATE_THRESHOLD = 50000;
const TOOL_RESULT_TRUNCATE_LINES = 80;
const escapeHtml = text => contentProcessor.escapeHtml(text);
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

const TOOL_RESULT_HIDE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

// 显示/恢复图标（Eye：当前已被隐藏，点击后恢复注入上下文）
const TOOL_RESULT_SHOW_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;


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

        const hasExplicitMathSignal = /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(trimmedContent);
        const isSimpleNumericMath = /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:%|\\%|‰|°))?$/.test(trimmedContent);
        const isSimpleIdentifierMath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedContent);

        // 数字开头的候选仍需严格检查，避免把价格与价格单位误当作公式。
        // `$1$`、`$20\%$`、`$2^n$`、`$1/2$` 等明确闭合数学保持放行；
        // 真正的价格通常是 `$123` 后接普通文本而没有闭合 `$`。
        if (/^\d/.test(trimmedContent) && !hasExplicitMathSignal && !isSimpleNumericMath) return false;

        // 路径、模板表达式与 Markdown 表格跨列候选继续排除。
        // 闭合的 `$x$`、`$n$`、`$abc$` 视为标准行内数学；
        // 不闭合的 `$PATH` 不会被扫描器选为候选，因此无需按标识符统一拒绝。
        if (trimmedContent.startsWith('/')) return false;
        if (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) return false;
        if (trimmedContent.includes('|')) return false;

        return hasExplicitMathSignal || isSimpleNumericMath || isSimpleIdentifierMath;
    };

    const protectInlineDollarMathInText = (source) => {
        let result = '';
        let index = 0;

        while (index < source.length) {
            const openIndex = source.indexOf('$', index);
            if (openIndex === -1) {
                result += source.slice(index);
                break;
            }

            result += source.slice(index, openIndex);

            const previousChar = source[openIndex - 1] || '';
            const nextOpenChar = source[openIndex + 1] || '';

            // 开始符不能是转义美元、双美元、单词内部美元。
            if (previousChar === '\\' || previousChar === '$' || nextOpenChar === '$' || /\w/.test(previousChar)) {
                result += '$';
                index = openIndex + 1;
                continue;
            }

            let closeIndex = -1;
            let cursor = openIndex + 1;
            const newline = source.indexOf('\n', openIndex + 1);
            const limit = Math.min(source.length, newline < 0 ? source.length : newline, openIndex + 1202);
            while (cursor < limit) {
                let dollarIndex = cursor;
                while (dollarIndex < limit && source[dollarIndex] !== '$') dollarIndex++;
                if (dollarIndex >= limit) break;

                if (source[dollarIndex - 1] === '\\') {
                    cursor = dollarIndex + 1;
                    continue;
                }

                const nextCloseChar = source[dollarIndex + 1] || '';
                if (!/\w/.test(nextCloseChar)) {
                    closeIndex = dollarIndex;
                    break;
                }

                cursor = dollarIndex + 1;
            }

            if (closeIndex === -1) {
                result += '$';
                index = openIndex + 1;
                continue;
            }

            const content = source.slice(openIndex + 1, closeIndex);
            if (content.length > 1200 || content.includes('\n') || !looksLikeSafeSingleDollarMath(content)) {
                // 不安全候选只释放开头 $，不吞掉到下一个 $ 的整段文本；
                // 这样 "$12.5 ... $2.49 ... $\Delta...$" 不会因价格误配而跳过后续真公式。
                result += '$';
                index = openIndex + 1;
                continue;
            }

            result += createLatexPlaceholder(`\\(${content.trim()}\\)`);
            index = closeIndex + 1;
        }

        return result;
    };

    const protectInlineDollarMath = (source) => {
        // HTML 标签是硬边界：美元定界符只能在同一个纯文本片段内闭合。
        // 这既避免读取 style/data 属性中的 `$`，也避免把
        // `<strong>$35.50</strong> ... <span>$12.25</span>` 跨元素配成公式。
        // 仅识别形似真实标签的片段，数学表达式中的比较运算符 `<`、`>` 仍留在文本中。
        const htmlTagRegex = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'"<>])*)?\s*\/?>/g;
        let result = '';
        let cursor = 0;
        let tagMatch;

        while ((tagMatch = htmlTagRegex.exec(source)) !== null) {
            result += protectInlineDollarMathInText(source.slice(cursor, tagMatch.index));
            result += tagMatch[0];
            cursor = tagMatch.index + tagMatch[0].length;
        }

        result += protectInlineDollarMathInText(source.slice(cursor));
        return result;
    };

    // 公式保护与结构修正共享代码域规则，包含行内代码、可变长围栏和波浪号。
    // 保留此处保护：特殊块转换可能生成新内容，不能假定流水线早期的代码占位符仍覆盖全部输入。
    const codeFenceMap = new Map();
    let processed = replaceMarkdownCodeDomains(text, block => {
        const placeholder = `%%CODEFENCE_FOR_LATEX_${codeFenceMap.size}%%`;
        codeFenceMap.set(placeholder, block);
        return placeholder;
    });

    // 保护顺序很重要：先保护 display math ($$...$$)，再保护 inline math。
    // 块级 $$ 只接受“独占一行”的定界符，避免把 `$10`、`$$` 字符串或表格内容误贪成跨段公式。
    // 同时保护 \[...\] 和 \(...\)。

    // 1. 保护 $$...$$ (display math)。
    // 支持两种常见模型输出：
    //   A) 定界符独占行：
    //      $$
    //      ...
    //      $$
    //   B) 整个块压在同一独立行：
    //      $$...$$
    // 同时保持“定界符所在行必须独立”，避免把 `$10`、代码字符串或表格内容误吞成跨段公式。
    processed = processed.replace(/(^|\n)([ \t]*)\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/g, (match, linePrefix) => {
        return `${linePrefix}${createLatexPlaceholder(match.slice(linePrefix.length))}`;
    });
    processed = processed.replace(/(^|\n)([ \t]*)\$\$([^\n]*?\S[^\n]*?)\$\$[ \t]*(?=\n|$)/g, (match, linePrefix) => {
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
    // 闭合的 $x$、$n$、$abc$ 与 $O(L^2) \to O(1)$ 会渲染；
    // 不闭合的 $10、$PATH、模板 ${value}、表格跨列 $...|...$ 不会触发。
    // 行内公式内部允许出现转义美元 \$，并且不安全价格候选不会吞掉后续真实公式。
    processed = protectInlineDollarMath(processed);

    // 如果安全单美元公式原本是缩进独立行，Markdown 会把它当作缩进代码块。
    // 这里仅对“整行只有 LaTeX 占位符”的行去缩进，不影响列表项、引用块或普通缩进文本。
    processed = processed.replace(/(^|\n)[ \t]{4,}(%%LATEX_BLOCK_\d+%%)(?=[ \t]*(?:\n|$))/g, (match, linePrefix, placeholder) => {
        return `${linePrefix}${placeholder}`;
    });

    // 🟢 恢复代码围栏（占位符 → 原始代码块）
    processed = processed.replace(/%%CODEFENCE_FOR_LATEX_\d+%%/g, token => codeFenceMap.get(token) ?? token);

    return { text: processed, map };
}

function restoreLatexBlocks(html, map) {
    if (!map || map.size === 0 || typeof html !== 'string') return html;

    // P1-5：单遍恢复 LaTeX 占位符，避免公式数量较多时按占位符多次全 HTML 扫描。
    return html.replace(/%%LATEX_BLOCK_(\d+)%%/g, (placeholder) => {
        return map.get(placeholder) ?? placeholder;
    });
}

function escapeRawHtmlOutsideCodeFences(markdownText) {
    if (typeof markdownText !== 'string' || !TOOL_RESULT_RAW_HTML_LINE_REGEX.test(markdownText)) {
        return markdownText;
    }

    const lines = markdownText.split('\n');
    let inFence = false;
    let fenceMarker = '';

    return lines.map((line) => {
        const fenceMatch = line.match(FENCE_LINE_REGEX);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (!inFence) {
                inFence = true;
                fenceMarker = marker[0];
            } else if (marker[0] === fenceMarker) {
                inFence = false;
                fenceMarker = '';
            }
            return line;
        }

        if (inFence) {
            return line;
        }

        if (!TOOL_RESULT_RAW_HTML_LINE_REGEX.test(line)) {
            return line;
        }

        return line.replace(/&/g, '\x26amp;').replace(/</g, '\x26lt;').replace(/>/g, '\x26gt;');
    }).join('\n');
}

function fenceCompleteHtmlToolResult(markdownText) {
    if (typeof markdownText !== 'string' || !TOOL_RESULT_COMPLETE_HTML_REGEX.test(markdownText)) {
        return markdownText;
    }

    const lines = markdownText.split('\n');
    const result = [];
    let inFence = false;
    let fenceMarker = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = line.match(FENCE_LANG_LINE_REGEX);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (!inFence) {
                inFence = true;
                fenceMarker = marker[0];
            } else if (marker[0] === fenceMarker) {
                inFence = false;
                fenceMarker = '';
            }
            result.push(line);
            continue;
        }

        if (inFence || !TOOL_RESULT_COMPLETE_HTML_REGEX.test(line)) {
            result.push(line);
            continue;
        }

        const blockLines = [line];
        let cursor = i + 1;
        while (cursor < lines.length) {
            blockLines.push(lines[cursor]);
            if (/<\s*\/\s*html\s*>/i.test(lines[cursor])) {
                break;
            }
            cursor++;
        }

        result.push('```html');
        result.push(blockLines.join('\n'));
        result.push('```');
        i = cursor;
    }

    return result.join('\n');
}

function sealToolResultMarkdownSource(markdownText) {
    if (typeof markdownText !== 'string') return '';
    const fencedHtml = fenceCompleteHtmlToolResult(markdownText);
    return escapeRawHtmlOutsideCodeFences(fencedHtml);
}

function renderSafeToolResultMarkdown(markdownText) {
    const sealedMarkdown = sealToolResultMarkdownSource(markdownText);

    if (!mainRendererReferences.markedInstance) {
        return `<pre class="vcp-tool-result-raw-content">${escapeHtml(sealedMarkdown)}</pre>`;
    }

    try {
        return sanitizeToolDataHtml(
            mainRendererReferences.markedInstance.parse(sealedMarkdown, TOOL_RESULT_SAFE_MARKDOWN_OPTIONS),
            mainRendererReferences.document || mainRendererReferences.chatMessagesDiv?.ownerDocument
        );
    } catch (e) {
        return `<pre class="vcp-tool-result-raw-content">${escapeHtml(sealedMarkdown)}</pre>`;
    }
}

function transformSpecialBlocks(text, codeBlockMap, thoughtChainMap = null, toolRequestSourceMap = null, placeholders = null) {
    let processed = text;

    const restoreBlocks = (textStr) => {
        if (!textStr || !codeBlockMap) return textStr;
        if (placeholders) return placeholders.replace(textStr, 'code');
        return textStr.replace(/__VCP_CODE_BLOCK_PLACEHOLDER_\d+__/g, token => codeBlockMap.get(token) ?? token);
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

    // Process Tool Call Summaries
    const renderToolCallSummaryBlock = (rawContent) => renderToolCallSummaryHtml(restoreBlocks(rawContent || ''));


    const transformToolCallSummariesInRoleSections = (source) => {
        if (typeof source !== 'string' || !source.includes('[本轮工具调用摘要:]') || !source.includes('<<<[ROLE_DIVIDE_')) {
            return source;
        }

        let result = '';
        let cursor = 0;
        const roleStartRegex = /<<<\[ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;

        while (cursor < source.length) {
            roleStartRegex.lastIndex = cursor;
            const startMatch = roleStartRegex.exec(source);
            if (!startMatch) {
                result += source.slice(cursor);
                break;
            }

            result += source.slice(cursor, startMatch.index);

            const role = startMatch[1];
            const endToken = `<<<[END_ROLE_DIVIDE_${role}]>>>`;
            const sectionContentStart = startMatch.index + startMatch[0].length;
            const endIndex = source.indexOf(endToken, sectionContentStart);

            if (endIndex === -1) {
                result += source.slice(startMatch.index);
                break;
            }

            const sectionContent = source.slice(sectionContentStart, endIndex);
            const transformedSectionContent = sectionContent.replace(TOOL_CALL_SUMMARY_REGEX, (match, rawContent) => {
                return renderToolCallSummaryBlock(rawContent);
            });
            TOOL_CALL_SUMMARY_REGEX.lastIndex = 0;

            result += startMatch[0] + transformedSectionContent + endToken;
            cursor = endIndex + endToken.length;
        }

        return result;
    };

    processed = transformToolCallSummariesInRoleSections(processed);

    // Process Tool Requests
    processed = replaceToolRequestBlocks(processed, (match, content) => {
        // 保护阶段已把「始」「末」字段值转义过一次（日记分支仍按这份交给 Markdown）。
        // 工具气泡在输出处自己转义，必须用原文，否则引号等会显示成 &#039;。
        const source = toolRequestSourceMap?.get(match) ?? content;
        const detectedToolName = extractMarkedField(content, /tool_name:\s*/i);
        const detectedCommand = extractMarkedField(content, /command:\s*/i);
        const detectedJev = parseJevToolUse(extractMarkedField(source, /JEV:\s*/i));
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
        } else if (detectedJev) {
            // JEV 是自然语言工具入口的兼容展示分支，不替代既有 tool_name/XML 协议。
            // 显式单引号工具名优先；未显式指定时才展示能力名称。
            const escapedFullContent = escapeHtml(restoreBlocks(source))
                .replace(/\r\n?|\n/g, '&#10;');
            const jevLabel = detectedJev.displayName ? 'JEVToolUse:' : 'JEVToolUse';
            const jevNameHtml = detectedJev.displayName
                ? ` <span class="vcp-tool-name-highlight">${escapeHtml(detectedJev.displayName)}</span>`
                : '';
            return `\n\n<div class="vcp-tool-use-bubble vcp-jev-tool-use-bubble" data-vcp-block-type="jev-tool-use" data-vcp-preserve-children="true">` +
                `<div class="vcp-tool-summary">` +
                `<span class="vcp-tool-label">${jevLabel}</span>` +
                jevNameHtml +
                `</div>` +
                `<div class="vcp-tool-details"></div>` +
                `<template class="vcp-tool-details-template"><pre>${escapedFullContent}</pre></template>` +
                `</div>\n\n`;
        } else {
            // --- It's a regular tool call, render it normally ---
            const xmlToolNameMatch = source.match(/<tool_name>([\s\S]*?)<\/tool_name>/i);

            let toolName = '';
            let extractedName = (xmlToolNameMatch?.[1] || extractMarkedField(source, /tool_name:\s*/i) || '').trim();
            if (extractedName) {
                extractedName = extractedName.replace(/[「{](?:始|末)(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi, '').replace(/,$/, '').trim();
            }
            if (extractedName) {
                toolName = extractedName;
            }

            const malformedFields = findMalformedToolFields(source);
            const markerProblem = describeToolRequestMarkerProblem({ toolName, malformedFields, content: source });
            toolName = markerProblem.displayName;
            const malformedClass = markerProblem.isMalformed ? ' is-malformed' : '';
            const malformedHintHtml = markerProblem.hint
                ? ` <span class="vcp-tool-malformed-hint">${escapeHtml(markerProblem.hint)}</span>`
                : '';

            // 工具气泡会在外层继续经过 marked.parse()。如果把参数中的真实换行直接放进
            // <pre>，空行会终止 CommonMark raw HTML block，导致后续 Markdown 被浏览器
            // 收进尚未闭合的 <pre>，表现为“后续渲染被吞”。用字符实体保存换行，使整个
            // 气泡对 Markdown 解析器保持为单行、不可拆分 HTML；写入 DOM 后仍显示为换行。
            const escapedFullContent = escapeHtml(restoreBlocks(source))
                .replace(/\r\n?|\n/g, '&#10;');
            /*
             * ToolUse 载荷可能包含超长单行 JSON / JavaScript。折叠时若仍把
             * <pre> 放在活动 DOM 中，展开会同时触发内在宽度、换行、高度与
             * 祖先 backdrop-filter 表面的重新计算。
             *
             * <template> 的 DocumentFragment 不参与样式、布局、绘制与合成；
             * 点击展开时才将其克隆到 .vcp-tool-details，收起时再次释放。
             */
            return `\n\n<div class="vcp-tool-use-bubble${malformedClass}" data-vcp-block-type="tool-use" data-vcp-preserve-children="true">` +
                `<div class="vcp-tool-summary">` +
                `<span class="vcp-tool-label">VCP-ToolUse:</span> ` +
                `<span class="vcp-tool-name-highlight">${escapeHtml(toolName)}</span>` +
                malformedHintHtml +
                `</div>` +
                `<div class="vcp-tool-details"></div>` +
                `<template class="vcp-tool-details-template"><pre>${escapedFullContent}</pre></template>` +
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

    // Process Role Dividers before restoring thought chains.
    // 思维链内部的角色分隔标记必须保持普通 Markdown 文本，不能生成外层角色分隔组件。
    processed = processed.replace(ROLE_DIVIDER_REGEX, (match, isEnd, role) => {
        const isEndMarker = !!isEnd;
        const roleLower = role.toLowerCase();

        let label = '';
        if (roleLower === 'system') label = 'System';
        else if (roleLower === 'assistant') label = 'Assistant';
        else if (roleLower === 'user') label = 'User';

        const actionText = isEndMarker ? '末' : '始';

        return `\n\n<div class="vcp-role-divider role-${roleLower} type-${isEndMarker ? 'end' : 'start'}" data-vcp-block-type="role-divider" data-vcp-preserve-children="true"><span class="divider-text">${label} 分界之${actionText}</span></div>\n\n`;
    });

    // 所有外层特殊协议转换完成后才恢复思维链。
    // 从这里开始只执行思维链专用 Markdown/LaTeX 渲染，不再运行任何 VCP 特殊规则。
    if (thoughtChainMap && thoughtChainMap.size > 0) {
        processed = placeholders
            ? placeholders.replace(processed, 'thought')
            : processed.replace(/<!--VCP_THOUGHT_CHAIN_\d+-->/g, token => thoughtChainMap.get(token) ?? token);
    }

    // Process VCP Thought Chains
    const renderThoughtChainMarkdown = (rawText) => {
        const restoredText = restoreBlocks(rawText || '');

        if (!mainRendererReferences.markedInstance) {
            return `<pre>${escapeHtml(restoredText)}</pre>`;
        }

        try {
            // 思维链是隔离渲染域：只解释 Markdown、普通代码围栏与 LaTeX。
            // 先保护公式，再封印代码围栏外的原始 HTML；工具、Mermaid、Flowlock、
            // 桌面推送、日记等 VCP 特殊协议均不会再次进入完整内容流水线。
            const { text: latexProtectedText, map: latexMap } = protectLatexBlocks(restoredText);
            const sealedMarkdown = escapeRawHtmlOutsideCodeFences(latexProtectedText);
            const renderedMarkdown = mainRendererReferences.markedInstance.parse(
                sealedMarkdown,
                TOOL_RESULT_SAFE_MARKDOWN_OPTIONS
            );
            return restoreLatexBlocks(renderedMarkdown, latexMap);
        } catch (e) {
            return `<pre>${escapeHtml(restoredText)}</pre>`;
        }
    };

    const renderThoughtChain = (theme, rawContent) => {
        const displayTheme = theme ? theme.trim() : "元思考链";
        const content = rawContent.trim();

        let html = `<div class="vcp-thought-chain-bubble collapsible" data-vcp-block-type="thought-chain" data-vcp-preserve-children="true">`;
        html += `<div class="vcp-thought-chain-header">`;
        html += `<span class="vcp-thought-chain-icon">🧠</span>`;
        html += `<span class="vcp-thought-chain-label">${escapeHtml(displayTheme)}</span>`;
        html += `<span class="vcp-result-toggle-icon"></span>`;
        html += `</div>`;

        html += `<div class="vcp-thought-chain-collapsible-content">`;

        const processedContent = renderThoughtChainMarkdown(content);
        html += `<div class="vcp-thought-chain-body">${processedContent}</div>`;
        html += `</div>`; // End of vcp-thought-chain-collapsible-content
        html += `</div>`; // End of vcp-thought-chain-bubble

        return `\n\n${html}\n\n`;
    };

    processed = processed.replace(THOUGHT_CHAIN_REGEX, (match, theme, rawContent) => {
        return renderThoughtChain(theme, rawContent);
    });

    // Process Conventional Thought Chains (<think>...</think> / <thinking>...</thinking>)
    // 同时兼容单行与多行格式；正则反向引用确保开始、结束标签一致。
    processed = processed.replace(CONVENTIONAL_THOUGHT_REGEX, (match, tagName, rawContent) => {
        return renderThoughtChain("思维链", rawContent);
    });

    // Desktop Push blocks 已在 preprocessFullContent 中于代码块保护之后统一处理
    // 这里不再重复处理，避免与代码块内的语法冲突

    return processed;
}

function ensureHtmlFenced(text, options = {}) {
    const doctypeTag = '<!DOCTYPE html>';
    const htmlCloseTag = '</html>';
    const lowerText = text.toLowerCase();

    // 已在代码块中，不处理
    if (!options.codeDomainsProtected && HTML_FENCE_CHECK_REGEX.test(text)) {
        return text;
    }

    // 快速检查：没有 doctype 直接返回
    if (!lowerText.includes(doctypeTag.toLowerCase())) {
        return text;
    }

    // 🟢 只保护工具请求围栏区域内的 HTML。
    // 「始」「末」标记不再作为全局保护区入口，避免普通正文提及该语法时导致 HTML fenced 边界误判。
    const protectedRanges = [];
    replaceToolRequestBlocks(text, (match, content, startIndex, endIndex) => {
        protectedRanges.push({ start: startIndex, end: endIndex });
        return match;
    });

    // 🟢 检查位置是否在保护区域内
    const isProtected = (index) => {
        return protectedRanges.some(range => index >= range.start && index < range.end);
    };

    let result = '';
    let lastIndex = 0;

    while (true) {
        const startIndex = lowerText.indexOf(doctypeTag.toLowerCase(), lastIndex);

        result += text.substring(lastIndex, startIndex === -1 ? text.length : startIndex);

        if (startIndex === -1) break;

        const endIndex = lowerText.indexOf(htmlCloseTag.toLowerCase(), startIndex + doctypeTag.length);

        if (endIndex === -1) {
            result += text.substring(startIndex);
            break;
        }

        const block = text.substring(startIndex, endIndex + htmlCloseTag.length);

        // 🔴 核心修复：如果在工具请求保护区内，直接添加不封装
        if (isProtected(startIndex)) {
            result += block;
            lastIndex = endIndex + htmlCloseTag.length;
            continue;
        }

        // 正常逻辑：检查是否已在代码块内
        const fencesInResult = options.codeDomainsProtected ? 0 : (result.match(/```/g) || []).length;

        if (fencesInResult % 2 === 0) {
            result += `\n\`\`\`html\n${block}\n\`\`\`\n`;
        } else {
            result += block;
        }

        lastIndex = endIndex + htmlCloseTag.length;
    }

    return result;
}

function deIndentHtml(text, options = {}) {
    const lines = text.split('\n');
    let inFence = false;
    return lines.map(line => {
        if (!options.codeDomainsProtected && line.trim().startsWith('```')) {
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

function preprocessFullContent(text, settings = {}, messageRole = 'assistant', depth = 0) {
    if (!contentPipeline) {
        console.warn('[MessageRenderer] contentPipeline not initialized, falling back to raw text');
        return { text, toolResultMap: null };
    }

    const result = contentRuntime.processFull(text, {
        mode: PIPELINE_MODES.FULL_RENDER,
        settings,
        messageRole,
        depth
    });

    return {
        text: result.text,
        toolResultMap: result.state.toolResultMap || null,
        rawScriptMap: result.state.rawScriptMap || null,
        placeholders: result.state.placeholders,
    };
}

function hashStringFNV1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}

function renderMarkdownToHtmlUncached(text, options = {}) {
    const markedInstance = mainRendererReferences.markedInstance;
    if (!markedInstance) return escapeHtml(text);

    if (!options.batchDomain && collectToolBatchRanges(text).length) {
        let ordinal = 0;
        return composeToolBatchHtml(splitToolBatchDomains(text), domain => {
            const html = renderMarkdownToHtmlUncached(domain.source, {
                ...options, batchDomain: true, resultOrdinal: ordinal,
            });
            ordinal += collectClosedToolResultRanges(domain.source).length;
            return html;
        }, mainRendererReferences.document || mainRendererReferences.chatMessagesDiv?.ownerDocument);
    }
    const globalSettings = options.settings || mainRendererReferences.globalSettingsRef.get();
    const {
        messageRole = 'assistant',
        depth = 0
    } = options;

    const { text: processedText, toolResultMap, rawScriptMap, placeholders } = preprocessFullContent(text, globalSettings, messageRole, depth);
    try {
        const { text: protectedText, map: latexMap } = protectLatexBlocks(processedText);
        let html = markedInstance.parse(protectedText);
        html = restoreLatexBlocks(html, latexMap);
        html = restoreRenderedToolResults(html, toolResultMap, options.resultOrdinal || 0, placeholders);
        if (rawScriptMap?.size) {
            html = placeholders
                ? placeholders.replace(html, 'script')
                : html.replace(/<!--VCP_RAW_SCRIPT_\d+-->/g, token => rawScriptMap.get(token) ?? token);
        }
        return html;
    } finally {
        // Templates keep only HTML/descriptors, never a parse-local registry or its
        // cached reference text. Recovery stages remain in their original order.
        placeholders?.releaseReferences();
    }
}

function renderToolResultBlock(fullMatch, ordinal = -1, deferred = true) {
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

    // 序号 + 原文哈希用于在消息原始内容中精确定位该工具结果块（删除功能使用）。
    const toolResultHash = hashStringFNV1a(fullMatch);
    const isHidden = isToolResultHidden(fullMatch);
    const previewSource = (details.find(item => markdownFieldKeys.has(item.key))?.value || otherContent.join('\n')).slice(0, 600);
    const preview = previewSource.split('\n').map(line => line.trim()).find(line => line && !/^(```|~~~)/.test(line))?.replace(/^[#>*\s]+|[*`]/g, '').slice(0, 160) || '';
    const rich = details.some(({ key, value }) =>
        /^(?:可访问URL|返回内容|url|image)$/.test(key) && /^https?:\/\/[^\s]+$/i.test(value) && /\.(jpeg|jpg|png|gif|webp)([?&#]|$)/i.test(value)
        || markdownFieldKeys.has(key) && /!\[[^\]]*\]\([^)\n]+\)/.test(value));
    const lazyId = deferred ? registerLazyTool({ type: 'result', raw: fullMatch, ordinal, meta: { preview, rich } }) : null;
    let html = `<div class="vcp-tool-result-bubble collapsible${isHidden ? ' vcp-tool-result-bubble--hidden' : ''}" data-vcp-block-type="tool-result" data-vcp-preserve-children="true"${lazyId ? ` data-vcp-lazy-tool-id="${lazyId}"` : ''} data-vcp-tool-result-index="${Number.isInteger(ordinal) ? ordinal : -1}" data-vcp-tool-result-hash="${toolResultHash}">`;
    html += `<div class="vcp-tool-result-header">`;
    html += `<span class="vcp-tool-result-label">VCP-ToolResult</span>`;
    html += `<span class="vcp-tool-result-name">${escapeHtml(toolName)}</span>`;
    html += `<span class="vcp-tool-result-status">${escapeHtml(status.replace(/[✅❌⚠⏳\uFE0F]/gu, '').trim())}</span>`;
    if (isHidden) {
        html += `<span class="vcp-tool-result-hidden-badge" title="当前工具结果已排除，后续对话不会注入到AI上下文中">已隐藏</span>`;
    }
    html += `<span class="vcp-result-toggle-icon"></span>`;
    const btnTitle = isHidden ? '当前已从上下文中隐藏（点击恢复注入）' : '当前已注入上下文（点击在上下文中隐藏）';
    // 视觉语义：可见时为单纯睁眼图标；不可见时为带斜杠划掉的眼睛图标
    const btnIcon = isHidden ? TOOL_RESULT_HIDE_ICON : TOOL_RESULT_SHOW_ICON;
    html += `<button type="button" class="vcp-tool-result-delete-btn vcp-tool-result-toggle-btn${isHidden ? ' is-hidden' : ''}" data-vcp-hidden="${isHidden ? 'true' : 'false'}" title="${btnTitle}" aria-label="${btnTitle}">${btnIcon}</button>`;
    html += `</div>`;
    html += `<div class="vcp-tool-result-collapsible-content">`;
    if (deferred) return html + `</div></div>`;
    html += `<div class="vcp-tool-result-details">`;

    details.forEach(({ key, value }) => {
        const isMarkdownField = markdownFieldKeys.has(key);
        const isImageUrl = typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value) && /\.(jpeg|jpg|png|gif|webp)([?&#]|$)/i.test(value);
        let processedValue;

        if (isImageUrl && (key === '可访问URL' || key === '返回内容' || key === 'url' || key === 'image')) {
            processedValue = `<a href="${escapeHtml(value)}" target="_blank" rel="noopener noreferrer" title="点击预览"><img src="${escapeHtml(value)}" class="vcp-tool-result-image" alt="Generated Image"></a>`;
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

            const renderedMarkdown = renderSafeToolResultMarkdown(valueToRender);
            const sealClass = TOOL_RESULT_DANGEROUS_HTML_REGEX.test(valueToRender)
                ? ' vcp-tool-result-markdown-content--sealed-html'
                : '';
            processedValue = `<div class="vcp-tool-result-markdown-content${sealClass}">${renderedMarkdown}</div>${truncationNotice}`;
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

function renderToolCallSummaryHtml(rawContent) {
    const statuses = [
        [/拒绝|被拒|denied|rejected|refused/i, 'rejected', '拒绝'],
        [/失败|错误|异常|error|failed/i, 'failure', '失败'],
        [/超时|timeout/i, 'timeout', '超时'],
        [/成功|完成|success|succeeded|ok/i, 'success', '成功'],
        [/取消|中止|cancel/i, 'cancelled', '取消'],
        [/跳过|skip/i, 'skipped', '跳过'],
    ];
    const entries = String(rawContent || '').trim().split(/[；;。]\s*/u).map(value => value.trim()).filter(Boolean);
    const chips = entries.map(entry => {
        const [, key, label] = statuses.find(([pattern]) => pattern.test(entry)) || [null, 'unknown', '未知'];
        const name = (entry.match(/^(.+?)\s*调用/u)?.[1] || entry.replace(/调用.*/u, '') || 'Tool').trim();
        return `<span class="vcp-tool-call-summary-chip status-${key}"><span class="vcp-tool-call-summary-tool">${escapeHtml(name)}</span><span class="vcp-tool-call-summary-status">${label}</span></span>`;
    }).join('');
    return `<div class="vcp-tool-call-summary-bubble" data-vcp-block-type="tool-call-summary" data-vcp-preserve-children="true"><div class="vcp-tool-call-summary-header"><span class="vcp-tool-call-summary-icon">🧾</span><span class="vcp-tool-call-summary-title">本轮工具调用摘要</span></div>${chips ? `<div class="vcp-tool-call-summary-list">${chips}</div>` : '<div class="vcp-tool-call-summary-raw">无摘要内容</div>'}</div>`;
}

function renderToolBatchBody(body, ranges, firstOrdinal = 0) {
    let cursor = 0;
    let html = '';
    const plain = source => {
        let result = '';
        let offset = 0;
        for (const match of source.matchAll(new RegExp(TOOL_CALL_SUMMARY_REGEX.source, 'g'))) {
            const preceding = source.slice(offset, match.index);
            if (preceding.trim()) result += `<pre>${escapeHtml(preceding)}</pre>`;
            result += renderToolCallSummaryHtml(match[1]);
            offset = match.index + match[0].length;
        }
        const tail = source.slice(offset);
        return result + (tail.trim() ? `<pre>${escapeHtml(tail)}</pre>` : '');
    };
    let ordinal = firstOrdinal;
    for (const range of ranges) {
        html += plain(body.slice(cursor, range.start));
        html += renderToolResultBlock(body.slice(range.start, range.end), ordinal++);
        cursor = range.end;
    }
    html += plain(body.slice(cursor));
    return `<div data-vcp-block-type="tool-batch" data-vcp-preserve-children="true">${html}</div>`;
}

function restoreRenderedToolResults(html, toolResultMap, firstOrdinal = 0, placeholders = null) {
    if (!toolResultMap || toolResultMap.size === 0 || typeof html !== 'string') return html;

    let resultOrdinal = firstOrdinal;
    const render = rawMatch => {
        if (rawMatch.type === 'batch') {
            const result = renderToolBatchBody(rawMatch.body, rawMatch.results, resultOrdinal);
            resultOrdinal += rawMatch.results.length;
            return result;
        }
        return `\n\n${renderToolResultBlock(rawMatch, resultOrdinal++)}\n\n`;
    };
    if (placeholders) {
        return placeholders.replace(html, 'result', render, { unwrapParagraph: true });
    }
    // Compatibility for callers supplying legacy maps without a parse registry.
    // P1-5：工具结果占位符使用 HTML 注释格式，单遍匹配即可恢复。
    // 同时兼容 marked 将注释占位符包裹成 <p><!--VCP_TOOL_RESULT_n--></p> 的情况。
    return html.replace(/<p>\s*(<!--VCP_TOOL_RESULT_(\d+)-->)\s*<\/p>|<!--VCP_TOOL_RESULT_(\d+)-->/g, (match, wrappedPlaceholder, wrappedId, bareId) => {
        const placeholder = wrappedPlaceholder || `<!--VCP_TOOL_RESULT_${bareId}-->`;
        const rawMatch = toolResultMap.get(placeholder);
        if (!rawMatch) return match;
        return render(rawMatch);
    });
}
    contentPipeline = createContentPipeline({
        escapeHtml,
        processStartEndMarkers: contentProcessor.processStartEndMarkers,
        fixEmoticonUrlsInMarkdown,
        deIndentMisinterpretedCodeBlocks: contentProcessor.deIndentMisinterpretedCodeBlocks,
        deIndentHtml,
        normalizeRenderLines: text => contentProcessor.deIndentMisinterpretedCodeBlocks(text, {
            codeDomainsProtected: true, normalizeHtml: true,
        }),
        deIndentToolRequestBlocks: contentProcessor.deIndentToolRequestBlocks,
        applyContentProcessors: contentProcessor.applyContentProcessors,
        transformSpecialBlocks: (text, codeBlockMap, thoughtChainMap, toolRequestSourceMap, placeholders) =>
            transformSpecialBlocks(text, codeBlockMap, thoughtChainMap, toolRequestSourceMap, placeholders),
        ensureHtmlFenced,
        transformFlowlockBlocks: (text) => {
            if (!mainRendererReferences.flowlockProtocol || typeof mainRendererReferences.flowlockProtocol.transformForRender !== 'function') {
                return text;
            }
            return mainRendererReferences.flowlockProtocol.transformForRender(text);
        },
        transformMermaidPlaceholders: text =>
            createMermaidPlaceholderTransform({ escapeHtml })(transformChartReferences(text)),
        getToolResultRegex: () => TOOL_RESULT_REGEX,
        getToolRequestRegex: () => TOOL_REGEX,
        replaceToolRequestBlocks,
        deferToolRequest,
        getCodeFenceRegex: () => CODE_FENCE_REGEX,
        getDesktopPushRegex: () => DESKTOP_PUSH_REGEX,
        getDesktopPushPartialRegex: () => DESKTOP_PUSH_PARTIAL_REGEX,
    });
    contentRuntime = typeof createContentRuntime === 'function'
        ? createContentRuntime({ pipeline: contentPipeline })
        : {
            normalizeMessage: (message) => ({ ...(message || {}), id: message?.id || `msg_${Date.now()}`, role: message?.role || 'assistant', content: message?.content ?? '' }),
            processFull: (text, options = {}) => contentPipeline.process(text, { ...options, mode: PIPELINE_MODES.FULL_RENDER }),
            processStream: (text, options = {}) => contentPipeline.process(text, { ...options, mode: PIPELINE_MODES.STREAM_FAST })
        };

return Object.freeze({ deferToolRequest, protectLatexBlocks, restoreLatexBlocks, escapeRawHtmlOutsideCodeFences, fenceCompleteHtmlToolResult, sealToolResultMarkdownSource, renderSafeToolResultMarkdown, transformSpecialBlocks, ensureHtmlFenced, deIndentHtml, preprocessFullContent, renderMarkdownToHtmlUncached, renderToolResultBlock, renderToolCallSummaryHtml, renderToolBatchBody, restoreRenderedToolResults, hashStringFNV1a, processStream: text => contentRuntime.processStream(text).text });
}
