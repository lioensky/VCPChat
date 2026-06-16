// modules/renderer/contentPipeline.js

/**
 * 统一内容预处理流水线
 *
 * 设计目标：
 * 1. 显式化顺序协议，避免预处理逻辑分散后顺序漂移
 * 2. 区分 full-render 与 stream-fast 两种模式
 * 3. 让“保护 -> 结构修正 -> 恢复”成为固定流程
 *
 * 注意：
 * - 本模块当前以“集中调度”为主，不强行重写既有处理器实现
 * - 业务细节（特殊块转换、HTML fenced 等）通过依赖注入提供
 */

const PIPELINE_MODES = {
    FULL_RENDER: 'full-render',
    STREAM_FAST: 'stream-fast'
};

function noop(value) {
    return value;
}

// OpenHerPersona 回填注释（persona_delta / persona_expression）需要从渲染中剥离。
// 不能简单"从开标记删到文末"——VCP 工具循环会把工具调用等后续内容追加在同一条
// 消息里，贪婪剥离会把回填之后的工具调用块一并吞掉。这里用与插件服务端同款的
// 字符串感知括号配平扫描，精确删除每个回填块（即使 reason 里出现 "-->" 也不会
// 提前截断泄漏），并保留其后的全部内容；流式半截回填则剥到文末。
const PERSONA_BACKFILL_OPEN_REGEX = /<!--\s*persona_(?:delta|expression)\s*:/g;

function findPersonaJsonEnd(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

function stripPersonaBackfillTail(text) {
    if (!text || text.indexOf('persona_') === -1) return text;
    let result = '';
    let cursor = 0;
    let strippedAny = false;
    PERSONA_BACKFILL_OPEN_REGEX.lastIndex = 0;
    let match;
    while ((match = PERSONA_BACKFILL_OPEN_REGEX.exec(text)) !== null) {
        if (match.index < cursor) continue;
        result += text.slice(cursor, match.index);
        const jsonStart = text.indexOf('{', match.index + match[0].length);
        if (jsonStart === -1) { cursor = text.length; strippedAny = true; break; }
        const jsonEnd = findPersonaJsonEnd(text, jsonStart);
        if (jsonEnd === -1) { cursor = text.length; strippedAny = true; break; }
        let end = jsonEnd;
        const closer = text.indexOf('-->', jsonEnd);
        if (closer !== -1 && text.slice(jsonEnd, closer).trim() === '') {
            end = closer + 3;
        }
        cursor = end;
        strippedAny = true;
        PERSONA_BACKFILL_OPEN_REGEX.lastIndex = end;
    }

    if (!strippedAny) {
        return text;
    }

    result += text.slice(cursor);
    return result;
}

function normalizeAdjacentBoldBoundaries(text) {
    if (typeof text !== 'string' || !text.includes('**')) return text;

    // marked/CommonMark 的 emphasis 边界算法在中文/引号无空格相邻时会把
    // **“文字a”**文字b**""文字c""**
    // 解析成嵌套 strong。HTML 注释是 Markdown 认可的不可见边界，
    // 可强制结束前一个粗体并重新开始后一个粗体，不改变可见文本。
    const separator = '<!-- -->';
    let result = '';
    let cursor = 0;
    let inBold = false;

    const needsSeparatorAfter = (char) => !!char && !/\s/.test(char) && char !== '<' && char !== '*';
    const needsSeparatorBefore = (char) => !!char && !/\s/.test(char) && char !== '>' && char !== '*';

    while (cursor < text.length) {
        const markerIndex = text.indexOf('**', cursor);
        if (markerIndex === -1) {
            result += text.slice(cursor);
            break;
        }

        const previousChar = markerIndex > 0 ? text[markerIndex - 1] : '';

        result += text.slice(cursor, markerIndex);

        if (!inBold && result && !result.endsWith(separator) && needsSeparatorBefore(previousChar)) {
            result += separator;
        }

        result += '**';
        cursor = markerIndex + 2;
        inBold = !inBold;

        if (!inBold) {
            const nextChar = text[cursor] || '';
            if (needsSeparatorAfter(nextChar)) {
                result += separator;
            }
        }
    }

    return result;
}

function createMapPlaceholderReplacer(map) {
    if (!map || map.size === 0) {
        return noop;
    }

    return (text) => {
        let result = text;
        for (const [placeholder, original] of map.entries()) {
            if (result.includes(placeholder)) {
                result = result.replace(placeholder, () => original);
            }
        }
        return result;
    };
}

function createContentPipeline(deps = {}) {
    const {
        escapeHtml = (text) => text,
        processStartEndMarkers = (text) => text,
        fixEmoticonUrlsInMarkdown = (text) => text,
        deIndentMisinterpretedCodeBlocks = (text) => text,
        deIndentHtml = (text) => text,
        deIndentToolRequestBlocks = (text) => text,
        applyContentProcessors = (text) => text,
        transformSpecialBlocks = (text) => text,
        ensureHtmlFenced = (text) => text,
        transformMermaidPlaceholders = (text) => text,
        getToolResultRegex = null,
        getToolRequestRegex = null,
        replaceToolRequestBlocks = null,
        getCodeFenceRegex = null,
        getDesktopPushRegex = null,
        getDesktopPushPartialRegex = null,
    } = deps;

    function createContext(inputText, options = {}) {
        return {
            mode: options.mode || PIPELINE_MODES.FULL_RENDER,
            text: typeof inputText === 'string' ? inputText : '',
            options,
            meta: {
                stepsApplied: []
            },
            state: {
                toolResultMap: null,
                toolRequestMap: null,
                codeBlockMap: null,
                toolResultPlaceholderId: 0,
                toolRequestPlaceholderId: 0,
                codeBlockPlaceholderId: 0
            }
        };
    }

    function step(ctx, name, handler) {
        ctx.text = handler(ctx.text, ctx) ?? ctx.text;
        ctx.meta.stepsApplied.push(name);
        return ctx;
    }

    function protectToolResults(text, ctx) {
        const toolResultRegex = typeof getToolResultRegex === 'function' ? getToolResultRegex() : null;
        if (!toolResultRegex) return text;

        toolResultRegex.lastIndex = 0;
        const hasToolResults = toolResultRegex.test(text);
        toolResultRegex.lastIndex = 0;

        if (!hasToolResults) return text;

        ctx.state.toolResultMap = new Map();
        const result = text.replace(toolResultRegex, (match) => {
            // 🟢 架构级修复：工具结果块保持原始内容不做任何转义
            // 占位符将贯穿整个 Markdown 解析过程，在 parse() 之后才恢复为渲染好的 HTML
            // 🔴 关键：使用 HTML 注释格式，避免 __ 被 Markdown 解释为粗体
            const placeholder = `<!--VCP_TOOL_RESULT_${ctx.state.toolResultPlaceholderId}-->`;
            ctx.state.toolResultMap.set(placeholder, match);
            ctx.state.toolResultPlaceholderId += 1;
            return placeholder;
        });
        toolResultRegex.lastIndex = 0;
        return result;
    }

    function protectToolRequests(text, ctx) {
        const toolRequestRegex = typeof getToolRequestRegex === 'function' ? getToolRequestRegex() : null;
        if (!toolRequestRegex && typeof replaceToolRequestBlocks !== 'function') return text;

        const hasToolRequests = text.includes('<<<[TOOL_REQUEST]>>>');
        if (!hasToolRequests) return text;

        ctx.state.toolRequestMap = new Map();

        const protectMatch = (match) => {
            // 工具请求块必须在通用「始/末」转义前整体保护。
            // 否则 ESCAPE 参数内的 Markdown / HTML / 普通标记会被提前转义，
            // transformSpecialBlocks 后只能得到一个退化的工具调用气泡。
            const placeholder = `<!--VCP_TOOL_REQUEST_${ctx.state.toolRequestPlaceholderId}-->`;
            ctx.state.toolRequestMap.set(placeholder, match);
            ctx.state.toolRequestPlaceholderId += 1;
            return placeholder;
        };

        if (typeof replaceToolRequestBlocks === 'function') {
            return replaceToolRequestBlocks(text, protectMatch);
        }

        toolRequestRegex.lastIndex = 0;
        const result = text.replace(toolRequestRegex, protectMatch);
        toolRequestRegex.lastIndex = 0;
        return result;
    }

    function restoreToolRequests(text, ctx) {
        return createMapPlaceholderReplacer(ctx.state.toolRequestMap)(text);
    }

    function protectCodeBlocks(text, ctx) {
        const codeFenceRegex = typeof getCodeFenceRegex === 'function' ? getCodeFenceRegex() : null;
        if (!codeFenceRegex || !/```/.test(text)) return text;

        ctx.state.codeBlockMap = new Map();
        return text.replace(codeFenceRegex, (match) => {
            const placeholder = `__VCP_CODE_BLOCK_PLACEHOLDER_${ctx.state.codeBlockPlaceholderId}__`;
            ctx.state.codeBlockMap.set(placeholder, match);
            ctx.state.codeBlockPlaceholderId += 1;
            return placeholder;
        });
    }

    function restoreCodeBlocks(text, ctx) {
        return createMapPlaceholderReplacer(ctx.state.codeBlockMap)(text);
    }

    function transformDesktopPush(text, ctx) {
        const desktopPushRegex = typeof getDesktopPushRegex === 'function' ? getDesktopPushRegex() : null;
        const desktopPushPartialRegex = typeof getDesktopPushPartialRegex === 'function' ? getDesktopPushPartialRegex() : null;
        if (!desktopPushRegex || !desktopPushPartialRegex) return text;

        desktopPushRegex.lastIndex = 0;
        desktopPushPartialRegex.lastIndex = 0;

        let result = text.replace(desktopPushRegex, (match, rawContent) => {
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

        result = result.replace(desktopPushPartialRegex, (match, partialContent) => {
            const content = partialContent.trim();
            const lines = content.split('\n');
            const totalLines = lines.length;
            const tailLines = lines.slice(-3).join('\n');
            const escapedPreview = escapeHtml(tailLines.length > 120 ? tailLines.substring(tailLines.length - 120) : tailLines);
            const lineCountInfo = totalLines > 3 ? `(${totalLines} 行)` : '';
            return `<div class="vcp-desktop-push-placeholder constructing">` +
                `<div class="vcp-desktop-push-header">` +
                `<span class="vcp-desktop-push-icon">🖥️</span>` +
                `<span class="vcp-desktop-push-label">正在向桌面推送 ${escapeHtml(lineCountInfo)}<span class="thinking-indicator-dots">...</span></span>` +
                `</div>` +
                `<div class="vcp-desktop-push-preview"><pre>${escapedPreview}</pre></div>` +
                `</div>`;
        });

        desktopPushRegex.lastIndex = 0;
        desktopPushPartialRegex.lastIndex = 0;

        return result;
    }

    function runFullRenderPipeline(inputText, options = {}) {
        const ctx = createContext(inputText, { ...options, mode: PIPELINE_MODES.FULL_RENDER });

        if ((options.messageRole || 'assistant') === 'assistant') {
            step(ctx, 'strip-persona-backfill-tail', (text) => stripPersonaBackfillTail(text));
        }
        step(ctx, 'normalize-emoticon-urls', (text) => fixEmoticonUrlsInMarkdown(text));

        // 顺序协议：
        // 🔴 关键修复：工具结果与工具请求都必须在「始」/「末」标记转义之前被保护
        // 否则 processStartEndMarkers 会错误地转义工具块内部的标记，
        // 导致后续 transformSpecialBlocks 处理时产生双重转义、内容泄漏或工具气泡退化。
        // 1. 最先做工具结果保护（它们可能包含任意内容，包括代码块、标记等）
        step(ctx, 'protect-tool-results', protectToolResults);

        // 2. 再保护工具请求：工具请求稍后需要恢复给 transformSpecialBlocks 做结构化渲染
        step(ctx, 'protect-tool-requests', protectToolRequests);

        // 3. 然后安全地处理标记转义（此时只处理工具块外部的标记）
        step(ctx, 'escape-start-end-markers', (text) => processStartEndMarkers(text));
        step(ctx, 'transform-mermaid-placeholders', (text) => transformMermaidPlaceholders(text));

        // 4. 保护代码块
        step(ctx, 'protect-code-blocks', protectCodeBlocks);

        // 5. 再做会改变行首语义/结构边界的修正
        step(ctx, 'deindent-misinterpreted-code-blocks', (text) => deIndentMisinterpretedCodeBlocks(text));
        step(ctx, 'deindent-html', (text) => deIndentHtml(text));
        step(ctx, 'deindent-tool-request-blocks', (text) => deIndentToolRequestBlocks(text));

        // 6. 再做结构转换
        step(ctx, 'transform-desktop-push', transformDesktopPush);

        // 7. 🟢 架构级修复：不再恢复工具结果
        // 工具结果占位符将贯穿 Markdown 解析，在 parse() 之后才由调用方替换为渲染好的 HTML
        // 这彻底避免了工具结果内部的 Markdown 语法（表格、代码围栏等）干扰外部解析

        // 8. 恢复工具请求，再交给特殊块转换；工具结果仍保持占位符
        step(ctx, 'restore-tool-requests', restoreToolRequests);

        // 9. 特殊块转换（此时工具结果仍为占位符，transformSpecialBlocks 中的 TOOL_RESULT_REGEX 不会匹配到任何内容）
        step(ctx, 'transform-special-blocks', (text) => transformSpecialBlocks(text, ctx.state.codeBlockMap));
        step(ctx, 'ensure-html-fenced', (text) => ensureHtmlFenced(text));
        step(ctx, 'apply-common-content-processors', (text) => applyContentProcessors(text));

        // 10. Markdown 解析前修复相邻粗体边界；此时代码块仍是占位符，避免污染代码内容。
        step(ctx, 'normalize-adjacent-bold-boundaries', normalizeAdjacentBoldBoundaries);

        // 11. 最后恢复代码块
        step(ctx, 'restore-code-blocks', restoreCodeBlocks);

        return {
            text: ctx.text,
            meta: ctx.meta,
            state: ctx.state
        };
    }

    function runStreamFastPipeline(inputText, options = {}) {
        const ctx = createContext(inputText, { ...options, mode: PIPELINE_MODES.STREAM_FAST });

        // 流式快路径只保留轻量、幂等、低风险修正
        step(ctx, 'strip-persona-backfill-tail', (text) => stripPersonaBackfillTail(text));
        step(ctx, 'normalize-emoticon-urls', (text) => fixEmoticonUrlsInMarkdown(text));
        step(ctx, 'deindent-misinterpreted-code-blocks', (text) => deIndentMisinterpretedCodeBlocks(text));
        step(ctx, 'escape-start-end-markers', (text) => processStartEndMarkers(text));
        step(ctx, 'apply-common-content-processors', (text) => applyContentProcessors(text));
        step(ctx, 'normalize-adjacent-bold-boundaries', normalizeAdjacentBoldBoundaries);

        return {
            text: ctx.text,
            meta: ctx.meta,
            state: ctx.state
        };
    }

    function process(inputText, options = {}) {
        const mode = options.mode || PIPELINE_MODES.FULL_RENDER;
        if (mode === PIPELINE_MODES.STREAM_FAST) {
            return runStreamFastPipeline(inputText, options);
        }
        return runFullRenderPipeline(inputText, options);
    }

    return {
        process,
        runFullRenderPipeline,
        runStreamFastPipeline
    };
}

export {
    PIPELINE_MODES,
    createContentPipeline
};