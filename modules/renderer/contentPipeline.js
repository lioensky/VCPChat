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
                codeBlockMap: null,
                toolResultPlaceholderId: 0,
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
            const placeholder = `__VCP_TOOL_RESULT_PLACEHOLDER_${ctx.state.toolResultPlaceholderId}__`;
            ctx.state.toolResultMap.set(placeholder, match);
            ctx.state.toolResultPlaceholderId += 1;
            return placeholder;
        });
        toolResultRegex.lastIndex = 0;
        return result;
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

    function restoreToolResults(text, ctx) {
        return createMapPlaceholderReplacer(ctx.state.toolResultMap)(text);
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

        step(ctx, 'normalize-emoticon-urls', (text) => fixEmoticonUrlsInMarkdown(text));
        step(ctx, 'escape-start-end-markers', (text) => processStartEndMarkers(text));
        step(ctx, 'transform-mermaid-placeholders', (text) => transformMermaidPlaceholders(text));

        // 顺序协议：
        // 1. 先做结构保护
        step(ctx, 'protect-tool-results', protectToolResults);
        step(ctx, 'protect-code-blocks', protectCodeBlocks);

        // 2. 再做会改变行首语义/结构边界的修正
        step(ctx, 'deindent-misinterpreted-code-blocks', (text) => deIndentMisinterpretedCodeBlocks(text));
        step(ctx, 'deindent-html', (text) => deIndentHtml(text));
        step(ctx, 'deindent-tool-request-blocks', (text) => deIndentToolRequestBlocks(text));

        // 3. 再做结构转换
        step(ctx, 'transform-desktop-push', transformDesktopPush);

        // 4. 恢复一部分被保护的结构，以便特殊块转换能够识别
        step(ctx, 'restore-tool-results', restoreToolResults);

        // 5. 特殊块转换、HTML 文档 fenced、通用处理
        step(ctx, 'transform-special-blocks', (text) => transformSpecialBlocks(text, ctx.state.codeBlockMap));
        step(ctx, 'ensure-html-fenced', (text) => ensureHtmlFenced(text));
        step(ctx, 'apply-common-content-processors', (text) => applyContentProcessors(text));

        // 6. 最后恢复代码块
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
        step(ctx, 'normalize-emoticon-urls', (text) => fixEmoticonUrlsInMarkdown(text));
        step(ctx, 'deindent-misinterpreted-code-blocks', (text) => deIndentMisinterpretedCodeBlocks(text));
        step(ctx, 'escape-start-end-markers', (text) => processStartEndMarkers(text));
        step(ctx, 'apply-common-content-processors', (text) => applyContentProcessors(text));

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