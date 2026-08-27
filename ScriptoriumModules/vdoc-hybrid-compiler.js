'use strict';

((global) => {
    const COMPILER_VERSION = 'vdoc-hybrid-compiler/3';
    const ISLAND_ATTRIBUTE = 'data-vdoc-island';
    const TOKEN_PREFIX = 'VDOC_PROTECTED_BLOCK_';
    const PARAGRAPH_BREAK_PLACEHOLDER = '↵';

    function lineEndingOf(source) {
        const text = String(source || '');
        if (text.includes('\r\n')) return 'crlf';
        if (text.includes('\r')) return 'cr';
        return 'lf';
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
    }

    function encodeSource(value) {
        return encodeURIComponent(String(value || ''));
    }

    function simpleHash(value) {
        const source = String(value || '');
        let hash = 0x811c9dc5;
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function lineAndColumnAt(source, offset) {
        const prefix = String(source || '').slice(0, Math.max(0, offset));
        const lines = prefix.split(/\r\n?|\n/);
        return {
            line: lines.length,
            column: (lines.at(-1) || '').length + 1,
        };
    }

    function diagnostic(level, ruleId, message, source, offset = 0, extra = {}) {
        return {
            level,
            ruleId,
            message,
            offset,
            ...lineAndColumnAt(source, offset),
            ...extra,
        };
    }

    function findFenceEnd(source, start, marker) {
        const openingLineEnd = source.indexOf('\n', start);
        if (openingLineEnd < 0) return source.length;
        const pattern = new RegExp(
            `^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`,
            'gm'
        );
        pattern.lastIndex = openingLineEnd + 1;
        const match = pattern.exec(source);
        return match ? match.index + match[0].length : source.length;
    }

    function scanFences(source) {
        const regions = [];
        const pattern = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
        let match;
        while ((match = pattern.exec(source))) {
            if (regions.some((region) =>
                match.index >= region.start && match.index < region.end
            )) {
                continue;
            }
            const end = findFenceEnd(source, match.index, match[1]);
            regions.push({
                type: String(match[2] || '').trim().split(/\s+/, 1)[0]
                    .toLowerCase() === 'mermaid'
                    ? 'mermaid'
                    : 'code',
                start: match.index,
                end,
                source: source.slice(match.index, end),
                closed: end < source.length || new RegExp(
                    `^ {0,3}${match[1][0]}{${match[1].length},}[ \\t]*$`,
                    'm'
                ).test(source.slice(match.index + match[0].length)),
                info: String(match[2] || '').trim(),
            });
            pattern.lastIndex = end;
        }
        return regions;
    }

    function scanInlineCodeRegions(source, excludedRegions = []) {
        const regions = [];
        let cursor = 0;

        while (cursor < source.length) {
            const start = source.indexOf('`', cursor);
            if (start < 0) break;
            const excluded = excludedRegions.find((region) =>
                start >= region.start && start < region.end
            );
            if (excluded) {
                cursor = excluded.end;
                continue;
            }

            let openingLength = 1;
            while (source[start + openingLength] === '`') openingLength += 1;
            let search = start + openingLength;
            let end = -1;
            while (search < source.length) {
                const candidate = source.indexOf('`', search);
                if (candidate < 0) break;
                let closingLength = 1;
                while (source[candidate + closingLength] === '`') {
                    closingLength += 1;
                }
                if (closingLength === openingLength) {
                    end = candidate + closingLength;
                    break;
                }
                search = candidate + closingLength;
            }

            if (end < 0) {
                // 静态文档中的孤立反引号按普通 Markdown 文本处理，不能保护到
                // 文档末尾并屏蔽后续真实 style/island。
                cursor = start + openingLength;
                continue;
            }
            regions.push({
                type: 'inline-code',
                start,
                end,
                source: source.slice(start, end),
                closed: true,
            });
            cursor = end;
        }

        return regions;
    }

    function containingRegion(offset, regions) {
        return regions.find((region) =>
            offset >= region.start && offset < region.end
        ) || null;
    }

    function scanHtmlCommentRegions(source, excludedRegions = []) {
        const regions = [];
        const pattern = /<!--[\s\S]*?(?:-->|$)/g;
        let match;
        while ((match = pattern.exec(source))) {
            const start = match.index;
            const end = start + match[0].length;
            if (!overlapsRegion(start, end, excludedRegions)) {
                regions.push({
                    type: 'html-comment',
                    start,
                    end,
                    source: match[0],
                    closed: match[0].endsWith('-->'),
                });
            }
            if (match[0].length === 0) pattern.lastIndex += 1;
        }
        return regions;
    }

    function islandIdFromOpeningTag(tag) {
        const match = String(tag || '').match(
            /\bdata-vdoc-island\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
        );
        return String(match?.[1] || match?.[2] || match?.[3] || '').trim();
    }

    function findIslandEnd(source, start, openingTagEnd, excludedRegions = []) {
        let depth = 1;
        let cursor = openingTagEnd;
        const tagPattern = /<\/?div\b[^>]*>|<(script|style)\b[^>]*>/gi;
        while (cursor < source.length) {
            tagPattern.lastIndex = cursor;
            const match = tagPattern.exec(source);
            if (!match) return -1;
            const excluded = containingRegion(match.index, excludedRegions);
            if (excluded) {
                // HTML 注释中的 div/style/script 都是说明文字，不能改变岛栈，
                // 也不能让伪 style 开始标签跨越寻找后续真实闭合标签。
                cursor = excluded.end;
                continue;
            }
            const tag = match[0];
            if (/^<(?:script|style)\b/i.test(tag)) {
                const name = match[1].toLowerCase();
                const close = new RegExp(`</${name}\\s*>`, 'ig');
                close.lastIndex = tagPattern.lastIndex;
                const closeMatch = close.exec(source);
                if (!closeMatch) return -1;
                cursor = close.lastIndex;
                continue;
            }
            if (/^<\/div\b/i.test(tag)) depth -= 1;
            else depth += 1;
            cursor = tagPattern.lastIndex;
            if (depth === 0) return cursor;
        }
        return -1;
    }

    function scanStyleBlocks(source, excludedRegions = []) {
        const regions = [];
        const openingPattern = /<style\b[^>]*>/gi;
        let match;
        while ((match = openingPattern.exec(source))) {
            const excluded = containingRegion(match.index, excludedRegions);
            if (excluded) {
                // 代码域里的 `<style>` 只是 Markdown 字面量。必须在寻找
                // </style> 之前跳过，否则会跨越吞掉后续真实样式块。
                openingPattern.lastIndex = excluded.end;
                continue;
            }

            const closePattern = /<\/style\s*>/gi;
            closePattern.lastIndex = openingPattern.lastIndex;
            const closeMatch = closePattern.exec(source);
            if (!closeMatch) continue;
            const start = match.index;
            const end = closePattern.lastIndex;
            if (overlapsRegion(start, end, excludedRegions)) {
                openingPattern.lastIndex = end;
                continue;
            }
            regions.push({
                type: 'style',
                start,
                end,
                source: source.slice(start, end),
                closed: true,
            });
            openingPattern.lastIndex = end;
        }
        return regions;
    }

    function scanIslands(source, excludedRegions, diagnostics) {
        const islands = [];
        const seenIds = new Set();
        const pattern = /<div\b[^>]*\bdata-vdoc-island(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>/gi;
        let match;
        while ((match = pattern.exec(source))) {
            if (excludedRegions.some((region) =>
                match.index >= region.start && match.index < region.end
            )) {
                continue;
            }
            const id = islandIdFromOpeningTag(match[0]);
            const end = findIslandEnd(
                source,
                match.index,
                pattern.lastIndex,
                excludedRegions
            );
            if (!id) {
                diagnostics.push(diagnostic(
                    'refuse',
                    'island-id-missing',
                    '可编程 HTML 岛必须声明非空 data-vdoc-island。',
                    source,
                    match.index
                ));
            } else if (seenIds.has(id)) {
                diagnostics.push(diagnostic(
                    'refuse',
                    'island-id-duplicate',
                    `可编程 HTML 岛 ID 重复：${id}`,
                    source,
                    match.index,
                    { islandId: id }
                ));
            } else {
                seenIds.add(id);
            }
            if (end < 0) {
                diagnostics.push(diagnostic(
                    'refuse',
                    'island-unclosed',
                    `HTML 岛${id ? `“${id}”` : ''}没有匹配的根 </div>。`,
                    source,
                    match.index,
                    { islandId: id || null }
                ));
                islands.push({
                    type: 'island',
                    id,
                    start: match.index,
                    end: source.length,
                    source: source.slice(match.index),
                    closed: false,
                });
                break;
            }
            islands.push({
                type: 'island',
                id,
                start: match.index,
                end,
                source: source.slice(match.index, end),
                closed: true,
            });
            pattern.lastIndex = end;
        }
        return islands;
    }

    function reserve(registry, item, html) {
        const token = `${TOKEN_PREFIX}${registry.length}_END`;
        registry.push({ ...item, token, html });
        return token;
    }

    function fencedBody(region) {
        const openingEnd = region.source.search(/\r?\n/);
        const bodyWithClosing = openingEnd < 0
            ? ''
            : region.source.slice(
                openingEnd + (region.source[openingEnd] === '\r' ? 2 : 1)
            );
        return bodyWithClosing.replace(
            /(?:\r?\n)? {0,3}(?:`{3,}|~{3,})[ \t]*(?:\r?\n)?$/,
            ''
        );
    }

    function mermaidMarkup(region) {
        const body = fencedBody(region);
        return `<figure class="vdoc-mermaid" data-vdoc-mermaid="${encodeSource(body)}">
    <pre class="vdoc-mermaid-source">${escapeHtml(body)}</pre>
</figure>`;
    }

    function codeMarkup(region) {
        const language = String(region.info || '')
            .split(/\s+/, 1)[0]
            .replace(/[^\w.+-]/g, '');
        const languageAttribute = language
            ? ` class="language-${escapeHtml(language)}"`
            : '';
        return `<pre class="vdoc-code-block"><code${languageAttribute}>${
            escapeHtml(fencedBody(region))
        }</code></pre>`;
    }

    function mathMarkup(latex, display) {
        const tag = display ? 'div' : 'span';
        const className = display
            ? 'vdoc-math vdoc-math-display'
            : 'vdoc-math vdoc-math-inline';
        return `<${tag} class="${className}" data-vdoc-math="${encodeSource(
            latex.trim()
        )}" data-vdoc-display="${display}">${escapeHtml(latex.trim())}</${tag}>`;
    }

    function overlapsRegion(start, end, regions) {
        return regions.some((region) => start < region.end && end > region.start);
    }

    function markdownLiveMarkerRanges(raw) {
        const source = String(raw || '');
        const markers = [];
        const markerRegions = [];
        const codeContentRegions = [];
        const add = (start, end, kind) => {
            if (end <= start || overlapsRegion(start, end, markerRegions)) return false;
            markers.push({
                start,
                end,
                kind,
                delimiter: source.slice(start, end),
            });
            markerRegions.push({ start, end });
            return true;
        };

        // 独占一行的 ↵ 是 Scriptorium 显式回车占位符。它在编辑 DOM 中
        // 保留真实源码字符和光标映射，但由专用样式压缩为透明零宽节点。
        const paragraphBreakPattern = /^[ \t]*(↵)[ \t]*$/gm;
        let match;
        while ((match = paragraphBreakPattern.exec(source))) {
            const start = match.index + match[0].indexOf(match[1]);
            add(start, start + match[1].length, 'paragraph-break');
        }

        // 块级前缀保持源码字符本身，只附加编辑态着色信息。
        const linePattern = /^(?: {0,3})(#{1,6}(?=\s)|>\s?|(?:[-+*]|\d+\.)\s+(?:\[[ xX]\]\s*)?)/gm;
        while ((match = linePattern.exec(source))) {
            const delimiter = match[1];
            const start = match.index + match[0].indexOf(delimiter);
            const kind = delimiter.trimStart().startsWith('#')
                ? 'heading'
                : delimiter.trimStart().startsWith('>')
                    ? 'quote'
                    : /\[[ xX]\]/.test(delimiter)
                        ? 'task-list'
                        : 'list';
            add(start, start + delimiter.length, kind);
        }

        // 代码跨度优先于其它行内语法。只装饰两端反引号，并保护中间内容，
        // 因此 `**literal**` 中的星号不会被误标为粗体分隔符。
        const codeOpenPattern = /(`+)/g;
        while ((match = codeOpenPattern.exec(source))) {
            const delimiter = match[1];
            const start = match.index;
            if (start > 0 && source[start - 1] === '\\') continue;
            let closeStart = source.indexOf(
                delimiter,
                start + delimiter.length
            );
            while (closeStart >= 0 && (
                source[closeStart - 1] === '`'
                || source[closeStart + delimiter.length] === '`'
                || source[closeStart - 1] === '\\'
            )) {
                closeStart = source.indexOf(
                    delimiter,
                    closeStart + delimiter.length
                );
            }
            if (closeStart < 0) {
                add(start, start + delimiter.length, 'code');
                continue;
            }
            add(start, start + delimiter.length, 'code');
            add(closeStart, closeStart + delimiter.length, 'code');
            codeContentRegions.push({
                start: start + delimiter.length,
                end: closeStart,
            });
            codeOpenPattern.lastIndex = closeStart + delimiter.length;
        }

        const delimiterPattern = /(\*\*|__|~~|\*|_)/g;
        const stacks = new Map();
        const inline = [];
        while ((match = delimiterPattern.exec(source))) {
            const delimiter = match[0];
            const start = match.index;
            const end = start + delimiter.length;
            if ((start > 0 && source[start - 1] === '\\')
                || overlapsRegion(start, end, markerRegions)
                || overlapsRegion(start, end, codeContentRegions)) {
                continue;
            }
            const record = {
                start,
                end,
                kind: delimiter === '~~'
                    ? 'strikethrough'
                    : delimiter.length === 2
                        ? 'strong'
                        : 'emphasis',
            };
            const stack = stacks.get(delimiter) || [];
            if (stack.length) inline.push(stack.pop(), record);
            else stack.push(record);
            stacks.set(delimiter, stack);
        }
        stacks.forEach((stack) => inline.push(...stack));
        inline.sort((left, right) => left.start - right.start)
            .forEach((record) => add(record.start, record.end, record.kind));

        return markers.sort((left, right) => left.start - right.start);
    }

    function scanMathRegions(source, excludedRegions = []) {
        const regions = [];
        const inlineCodeRegions = [];
        const codePattern = /(`+)([\s\S]*?)\1/g;
        let codeMatch;
        while ((codeMatch = codePattern.exec(source))) {
            const start = codeMatch.index;
            const end = start + codeMatch[0].length;
            if (!overlapsRegion(start, end, excludedRegions)) {
                inlineCodeRegions.push({ start, end });
            }
        }
        const excluded = [...excludedRegions, ...inlineCodeRegions];
        const add = (full, latex, display, start) => {
            const end = start + full.length;
            if (overlapsRegion(start, end, [...excluded, ...regions])) return;
            regions.push({
                type: display ? 'math-display' : 'math-inline',
                start,
                end,
                source: full,
                latex,
                display,
            });
        };

        const displayPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
        let displayMatch;
        while ((displayMatch = displayPattern.exec(source))) {
            add(
                displayMatch[0],
                displayMatch[1] ?? displayMatch[2],
                true,
                displayMatch.index
            );
        }

        const inlinePattern = /\\\(([\s\S]+?)\\\)|(^|[^\\$])\$([^\r\n$]+?)\$/gm;
        let inlineMatch;
        while ((inlineMatch = inlinePattern.exec(source))) {
            if (inlineMatch[1] !== undefined) {
                add(inlineMatch[0], inlineMatch[1], false, inlineMatch.index);
                continue;
            }
            const prefix = inlineMatch[2] || '';
            const marker = inlineMatch[0].slice(prefix.length);
            add(
                marker,
                inlineMatch[3],
                false,
                inlineMatch.index + prefix.length
            );
        }
        return regions.sort((left, right) => left.start - right.start);
    }

    function protectStructuralRegions(source, regions, registry) {
        let output = '';
        let cursor = 0;
        [...regions].sort((left, right) => left.start - right.start).forEach((region) => {
            if (region.start < cursor) return;
            output += source.slice(cursor, region.start);
            if (region.type === 'island' || region.type === 'style') {
                output += `\n\n${reserve(registry, region, region.source)}\n\n`;
            } else if (region.type === 'mermaid') {
                output += `\n\n${reserve(registry, region, mermaidMarkup(region))}\n\n`;
            } else if (region.type === 'code') {
                output += `\n\n${reserve(registry, region, codeMarkup(region))}\n\n`;
            } else if (region.type === 'math-display') {
                output += `\n\n${reserve(
                    registry,
                    region,
                    mathMarkup(region.latex, true)
                )}\n\n`;
            } else if (region.type === 'math-inline') {
                output += reserve(
                    registry,
                    region,
                    mathMarkup(region.latex, false)
                );
            } else {
                output += region.source;
            }
            cursor = region.end;
        });
        output += source.slice(cursor);
        return output;
    }

    function protectParagraphBreakPlaceholders(source) {
        return String(source || '').replace(
            /^([ \t]*)↵[ \t]*$/gm,
            '$1<span class="vdoc-paragraph-break-placeholder" '
                + 'data-vdoc-paragraph-break-placeholder="true" '
                + 'aria-label="空白行">↵</span>'
        );
    }

    function markedApi() {
        const candidate = global.marked;
        if (typeof candidate === 'function') return candidate;
        if (typeof candidate?.parse === 'function') return candidate.parse.bind(candidate);
        if (typeof candidate?.marked === 'function') return candidate.marked.bind(candidate);
        return null;
    }

    function markedLexerApi() {
        const candidate = global.marked;
        if (typeof candidate?.lexer === 'function') {
            return candidate.lexer.bind(candidate);
        }
        if (typeof candidate?.Lexer?.lex === 'function') {
            return candidate.Lexer.lex.bind(candidate.Lexer);
        }
        return null;
    }

    function restoreProtectedHtml(html, registry) {
        let restored = String(html || '');
        registry.forEach((entry) => {
            const wrappedParagraph = new RegExp(
                `<p>\\s*${entry.token}\\s*</p>`,
                'g'
            );
            restored = restored.replace(wrappedParagraph, () => entry.html);
            restored = restored.replaceAll(entry.token, () => entry.html);
        });
        return restored;
    }

    function dependenciesFromHtml(html) {
        const dependencies = new Set();
        String(html || '').replace(/<script\b([^>]*)>/gi, (_match, attributes) => {
            const declared = attributes.match(
                /\bdata-vdoc-library\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i
            );
            const library = String(
                declared?.[1] || declared?.[2] || declared?.[3] || ''
            ).toLowerCase();
            if (library) dependencies.add(library);
            const source = attributes.match(
                /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i
            );
            const url = String(source?.[1] || source?.[2] || source?.[3] || '');
            if (/anime(?:js)?(?:@|\/|\.min\.js)/i.test(url)) dependencies.add('anime');
            if (/three(?:@|\/|\.min\.js)/i.test(url)) dependencies.add('three');
            return _match;
        });
        return [...dependencies];
    }

    function fallbackMarkdownEditRegions(source, start, end) {
        const regions = [];
        const segment = source.slice(start, end);
        const separator = /(?:\r?\n){2,}/g;
        let cursor = 0;
        let match;
        const add = (from, to) => {
            if (to <= from) return;
            const raw = segment.slice(from, to);
            if (!raw.trim()) return;
            const type = /^\s*</.test(raw) ? 'html' : 'markdown';
            regions.push({
                type,
                flowKind: type === 'html'
                    ? htmlEditFlowKind(raw)
                    : 'text-flow',
                start: start + from,
                end: start + to,
                source: raw,
            });
        };
        while ((match = separator.exec(segment))) {
            add(cursor, match.index);
            cursor = match.index + match[0].length;
        }
        add(cursor, segment.length);
        return regions;
    }

    function tokenEditType(token, raw) {
        return token?.type === 'html' || /^\s*</.test(raw)
            ? 'html'
            : 'markdown';
    }

    function htmlEditFlowKind(raw) {
        const source = String(raw || '').trim();
        if (!source) return 'text-flow';

        // 这些标签建立独立块级布局，不能因为源码以 “<” 开头就冒充
        // Markdown 行内文字；但它们仍与拥有脚本生命周期的 stable 岛不同。
        // HTML 标题同样拥有独立盒模型。若遗漏 h1-h6，文档开头的特效标题
        // 会被错误聚合进后续 Markdown，并在点击正文时一并展开。
        const blockTag = source.match(
            /^<\/?(address|article|aside|blockquote|details|dialog|div|dl|fieldset|figure|footer|form|h[1-6]|header|hgroup|hr|main|menu|nav|ol|p|pre|section|summary|table|ul)\b/i
        );
        return blockTag ? 'html-block' : 'text-flow';
    }

    function editFlowKind(region) {
        if (region?.flowKind) return region.flowKind;
        if (region?.type === 'markdown') return 'text-flow';
        if (region?.type === 'html') return htmlEditFlowKind(region.source);
        if (region?.type === 'island'
            || region?.type === 'style'
            || region?.type === 'code'
            || region?.type === 'mermaid'
            || region?.type === 'math-display') {
            return 'stable-atomic';
        }
        return 'stable-atomic';
    }

    function splitMarkdownEditRegions(
        source,
        start,
        end,
        lexer = markedLexerApi(),
        diagnostics = []
    ) {
        const segment = source.slice(start, end);
        if (!segment.trim()) return [];
        if (!lexer) {
            return fallbackMarkdownEditRegions(source, start, end);
        }

        try {
            const tokens = lexer(segment, {
                gfm: true,
                breaks: false,
                async: false,
            });
            const regions = [];
            let cursor = 0;
            const add = (from, to, token = null) => {
                if (to <= from) return;
                let regionEnd = to;
                let raw = segment.slice(from, regionEnd);

                // Marked 会把块后的空白分隔（通常 \n\n）纳入 token.raw。
                // 分隔空行不是前一个块的可编辑内容；若保留在 region 内，
                // 段尾 Enter 或 HTML 边界插入会改变下次编译的区域范围，
                // 造成活动会话、光标及后续 shell key 全部失配。
                //
                // 这里只剥离两个及以上的普通尾换行。由编辑器创建的空白行
                // 含有显式 ↵，不会进入该分支，也不会再被归一化吞掉。
                const separator = raw.match(/(?:\r?\n){2,}$/)?.[0] || '';
                if (separator) {
                    regionEnd -= separator.length;
                    raw = segment.slice(from, regionEnd);
                }
                if (regionEnd <= from || !raw.trim()) return;
                const type = tokenEditType(token, raw);
                regions.push({
                    type,
                    flowKind: type === 'html'
                        ? htmlEditFlowKind(raw)
                        : 'text-flow',
                    start: start + from,
                    end: start + regionEnd,
                    source: raw,
                    markdownTokenType: token?.type || null,
                });
            };

            for (const token of tokens || []) {
                const raw = typeof token?.raw === 'string' ? token.raw : '';
                if (!raw) continue;
                let tokenStart = cursor;
                if (!segment.startsWith(raw, tokenStart)) {
                    tokenStart = segment.indexOf(raw, cursor);
                    if (tokenStart < 0) {
                        throw new Error(`无法定位 ${token.type || 'unknown'} token 的原始范围`);
                    }
                }
                add(cursor, tokenStart);
                add(tokenStart, tokenStart + raw.length, token);
                cursor = tokenStart + raw.length;
            }
            add(cursor, segment.length);
            return regions;
        } catch (error) {
            diagnostics.push(diagnostic(
                'warn',
                'markdown-edit-region-lex-failed',
                `Markdown 编辑块索引失败，已降级为段落边界：${error.message}`,
                source,
                start
            ));
            return fallbackMarkdownEditRegions(source, start, end);
        }
    }

    function buildEditRegions(
        source,
        structuralRegions,
        mathRegions,
        lexer,
        diagnostics
    ) {
        const atomic = [
            ...structuralRegions,
            ...mathRegions.filter((region) => region.type === 'math-display'),
        ].sort((left, right) => left.start - right.start);
        const regions = [];
        let cursor = 0;
        atomic.forEach((region) => {
            if (region.start < cursor) return;
            regions.push(...splitMarkdownEditRegions(
                source,
                cursor,
                region.start,
                lexer,
                diagnostics
            ));
            regions.push({
                type: region.type,
                flowKind: 'stable-atomic',
                start: region.start,
                end: region.end,
                source: region.source,
                islandId: region.id || null,
            });
            cursor = region.end;
        });
        regions.push(...splitMarkdownEditRegions(
            source,
            cursor,
            source.length,
            lexer,
            diagnostics
        ));
        return regions.map((region, ordinal) => ({
            key: `edit-${ordinal + 1}-${simpleHash(region.source)}`,
            ordinal,
            type: region.type,
            flowKind: editFlowKind(region),
            markdownTokenType: region.markdownTokenType || null,
            sourceRange: { start: region.start, end: region.end },
            sourceHash: simpleHash(region.source),
            islandId: region.islandId || null,
        }));
    }

    function renderEditRegion(source, region, parse, diagnostics) {
        const raw = source.slice(region.sourceRange.start, region.sourceRange.end);
        if (region.type === 'island' || region.type === 'style') return raw;
        if (region.type === 'mermaid' || region.type === 'code') {
            const fence = scanFences(raw)[0];
            return fence
                ? (region.type === 'mermaid'
                    ? mermaidMarkup(fence)
                    : codeMarkup(fence))
                : `<pre class="vdoc-source-fallback">${escapeHtml(raw)}</pre>`;
        }
        if (region.type === 'math-display') {
            const math = scanMathRegions(raw)
                .find((candidate) => candidate.type === 'math-display');
            return math
                ? mathMarkup(math.latex, true)
                : `<pre class="vdoc-source-fallback">${escapeHtml(raw)}</pre>`;
        }
        if (!parse) return `<pre class="vdoc-source-fallback">${escapeHtml(raw)}</pre>`;

        const registry = [];
        const mathRegions = scanMathRegions(raw);
        const structuralSource = protectStructuralRegions(
            raw,
            mathRegions,
            registry
        );
        const protectedSource =
            protectParagraphBreakPlaceholders(structuralSource);
        try {
            return restoreProtectedHtml(parse(protectedSource, {
                gfm: true,
                // Scriptorium 是所见即所得的文稿编辑器：源码中的单换行
                // 必须在静态渲染和展开编辑态中拥有一致的可见语义。
                breaks: true,
                async: false,
            }), registry);
        } catch (error) {
            diagnostics.push(diagnostic(
                'warn',
                'edit-region-compile-failed',
                `编辑区块编译失败：${error.message}`,
                source,
                region.sourceRange.start,
                { editRegionKey: region.key }
            ));
            return `<pre class="vdoc-source-fallback">${escapeHtml(raw)}</pre>`;
        }
    }

    function decodeHeadingText(value) {
        return String(value || '')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/[`*_~]/g, '')
            .replace(/&nbsp;|&#160;/gi, ' ')
            .replace(/&|&#38;/gi, '&')
            .replace(/<|&#60;/gi, '<')
            .replace(/>|&#62;/gi, '>')
            .replace(/"|&#34;/gi, '"')
            .replace(/'|'/gi, "'")
            .replace(/&#(\d+);/g, (_match, code) =>
                String.fromCodePoint(Number(code))
            )
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildHeadingIndex(source, editRegions, lexer) {
        const headings = [];
        const add = (level, text, start, headingEnd, editRegionOrdinal) => {
            const normalizedText = decodeHeadingText(text);
            if (!normalizedText || level < 1 || level > 6) return;
            headings.push({
                id: `heading-${start}-${simpleHash(normalizedText)}`,
                index: headings.length,
                kind: 'heading',
                level,
                text: normalizedText,
                start,
                headingEnd,
                editRegionOrdinal,
            });
        };

        editRegions.forEach((region) => {
            const regionStart = region.sourceRange.start;
            const raw = source.slice(regionStart, region.sourceRange.end);

            if (region.markdownTokenType === 'heading' && lexer) {
                try {
                    const token = lexer(raw, {
                        gfm: true,
                        breaks: false,
                        async: false,
                    })?.find((candidate) => candidate?.type === 'heading');
                    if (token) {
                        const tokenStart = Math.max(0, raw.indexOf(token.raw));
                        add(
                            Number(token.depth),
                            token.text,
                            regionStart + tokenStart,
                            regionStart + tokenStart + token.raw.length,
                            region.ordinal
                        );
                    }
                } catch {}
            }

            if (!['html', 'island'].includes(region.type)) return;
            const headingFences = scanFences(raw);
            const headingComments = scanHtmlCommentRegions(raw, headingFences);
            const excluded = [
                ...headingFences,
                ...headingComments,
                ...scanStyleBlocks(raw, [
                    ...headingFences,
                    ...headingComments,
                ]),
            ];
            const scriptPattern = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
            let scriptMatch;
            while ((scriptMatch = scriptPattern.exec(raw))) {
                excluded.push({
                    start: scriptMatch.index,
                    end: scriptMatch.index + scriptMatch[0].length,
                });
            }

            const headingPattern =
                /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
            let match;
            while ((match = headingPattern.exec(raw))) {
                const start = match.index;
                const end = start + match[0].length;
                if (overlapsRegion(start, end, excluded)) continue;
                add(
                    Number(match[1]),
                    match[2],
                    regionStart + start,
                    regionStart + end,
                    region.ordinal
                );
            }
        });

        headings.sort((left, right) => left.start - right.start);
        headings.forEach((heading, index) => {
            heading.index = index;
            const next = headings.slice(index + 1).find((candidate) =>
                candidate.level <= heading.level
            );
            heading.end = next ? next.start : source.length;
            const startPosition = lineAndColumnAt(source, heading.start);
            const headingEndPosition = lineAndColumnAt(
                source,
                heading.headingEnd
            );
            const endPosition = lineAndColumnAt(source, heading.end);
            heading.startLine = startPosition.line;
            heading.headingEndLine = headingEndPosition.line;
            heading.endLine = endPosition.column === 1 && heading.end > 0
                ? Math.max(heading.startLine, endPosition.line - 1)
                : endPosition.line;
            heading.characterCount = heading.end - heading.start;
            heading.contentCharacterCount = Math.max(
                0,
                heading.end - heading.headingEnd
            );
            heading.headingRange = {
                start: heading.start,
                end: heading.headingEnd,
            };
            heading.sourceRange = {
                start: heading.start,
                end: heading.end,
            };
            delete heading.start;
            delete heading.headingEnd;
            delete heading.end;
        });
        return headings;
    }

    function buildPreviewHtml(source, editRegions, parse, diagnostics) {
        return editRegions.map((region) => {
            const content = renderEditRegion(source, region, parse, diagnostics);
            return `<div class="vdoc-edit-region" data-vdoc-edit-key="${
                escapeHtml(region.key)
            }" data-vdoc-edit-type="${escapeHtml(region.type)}" data-vdoc-flow-kind="${
                escapeHtml(region.flowKind || 'stable-atomic')
            }">${content}</div>`;
        }).join('\n');
    }

    function buildBlockIndex(source, protectedRegions, html) {
        const blocks = [];
        let ordinal = 0;
        const add = (type, start, end, raw, extra = {}) => {
            blocks.push({
                key: `block-${ordinal += 1}-${simpleHash(raw)}`,
                ordinal: ordinal - 1,
                type,
                sourceRange: { start, end },
                sourceHash: simpleHash(raw),
                ...extra,
            });
        };

        let cursor = 0;
        [...protectedRegions].sort((left, right) => left.start - right.start)
            .forEach((region) => {
                if (region.start > cursor) {
                    const plain = source.slice(cursor, region.start);
                    if (plain.trim()) add('markdown', cursor, region.start, plain);
                }
                add(region.type, region.start, region.end, region.source, {
                    islandId: region.id || null,
                });
                cursor = Math.max(cursor, region.end);
            });
        if (cursor < source.length && source.slice(cursor).trim()) {
            add('markdown', cursor, source.length, source.slice(cursor));
        }
        if (!blocks.length && source.length) add('markdown', 0, source.length, source);
        return blocks.map((block) => ({
            ...block,
            compilerVersion: COMPILER_VERSION,
            semanticHtmlHash: simpleHash(html),
        }));
    }

    function compile(input, options = {}) {
        const source = String(input ?? '');
        const diagnostics = [];
        const fences = scanFences(source);
        const inlineCodeRegions = scanInlineCodeRegions(source, fences);
        const codeDomains = [...fences, ...inlineCodeRegions]
            .sort((left, right) => left.start - right.start);
        const htmlCommentRegions = scanHtmlCommentRegions(source, codeDomains);
        fences.filter((region) => !region.closed).forEach((region) => {
            diagnostics.push(diagnostic(
                'warn',
                'fence-unclosed',
                '代码或 Mermaid 围栏未闭合，已保护到文档末尾。',
                source,
                region.start
            ));
        });
        const islands = scanIslands(source, [
            ...codeDomains,
            ...htmlCommentRegions,
        ], diagnostics);
        const styleBlocks = scanStyleBlocks(source, [
            ...codeDomains,
            ...htmlCommentRegions,
            ...islands,
        ]);
        const structuralRegions = [
            ...islands,
            ...styleBlocks,
            ...fences,
        ].sort((left, right) => left.start - right.start);
        const mathRegions = scanMathRegions(source, structuralRegions);
        const protectedRegions = [
            ...structuralRegions,
            ...mathRegions,
        ].sort((left, right) => left.start - right.start);

        const registry = [];
        const structuralSource = protectStructuralRegions(
            source,
            protectedRegions,
            registry
        );
        const protectedSource =
            protectParagraphBreakPlaceholders(structuralSource);

        const parse = markedApi();
        const lexer = markedLexerApi();
        let html = '';
        if (!parse) {
            diagnostics.push(diagnostic(
                'refuse',
                'markdown-compiler-unavailable',
                'Marked 编译器未加载，无法编译 Markdown-first 文档。',
                source
            ));
            html = `<pre class="vdoc-source-fallback">${escapeHtml(source)}</pre>`;
        } else {
            try {
                html = parse(protectedSource, {
                    gfm: true,
                    // 与渲染态编辑器统一：单个源码换行编译为 <br>，
                    // 避免收起编辑区后被 Markdown 折叠成普通空格。
                    breaks: true,
                    async: false,
                });
            } catch (error) {
                diagnostics.push(diagnostic(
                    'refuse',
                    'markdown-compile-failed',
                    `Markdown 编译失败：${error.message}`,
                    source
                ));
                html = `<pre class="vdoc-source-fallback">${escapeHtml(source)}</pre>`;
            }
        }
        html = restoreProtectedHtml(html, registry);
        if (typeof options.sanitizeHtml === 'function') {
            html = options.sanitizeHtml(html);
        }

        const dependencies = dependenciesFromHtml(html);
        const blocks = buildBlockIndex(source, protectedRegions, html);
        const editRegions = buildEditRegions(
            source,
            structuralRegions,
            mathRegions,
            lexer,
            diagnostics
        );
        const headings = buildHeadingIndex(source, editRegions, lexer);
        let previewHtml = buildPreviewHtml(
            source,
            editRegions,
            parse,
            diagnostics
        );
        if (typeof options.sanitizeHtml === 'function') {
            previewHtml = options.sanitizeHtml(previewHtml);
        }
        return {
            format: 'markdown-hybrid',
            compilerVersion: COMPILER_VERSION,
            source,
            sourceHash: simpleHash(source),
            lineEnding: lineEndingOf(source),
            html,
            previewHtml,
            blocks,
            editRegions,
            headings,
            islands: islands.map((island) => ({
                id: island.id,
                sourceRange: { start: island.start, end: island.end },
                sourceHash: simpleHash(island.source),
                closed: island.closed,
            })),
            dependencies,
            diagnostics,
        };
    }

    function validate(source) {
        const result = compile(source);
        return {
            valid: !result.diagnostics.some((item) => item.level === 'refuse'),
            diagnostics: result.diagnostics,
            islands: result.islands,
            dependencies: result.dependencies,
        };
    }

    global.VDocHybridCompiler = Object.freeze({
        COMPILER_VERSION,
        ISLAND_ATTRIBUTE,
        PARAGRAPH_BREAK_PLACEHOLDER,
        compile,
        lineEndingOf,
        markdownLiveMarkerRanges,
        scanFences,
        scanInlineCodeRegions,
        simpleHash,
        validate,
    });

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = global.VDocHybridCompiler;
    }
})(typeof window !== 'undefined' ? window : globalThis);