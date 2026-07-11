// Flowlockmodules/flowlock-protocol.js
// Flowlock 内嵌控制协议：安全解析 AI 最终输出，并为消息渲染生成状态气泡。

(function initializeFlowlockProtocol(global) {
    'use strict';

    const TOKENS = Object.freeze({
        toolRequestStart: '<<<[TOOL_REQUEST]>>>',
        toolRequestEnd: '<<<[END_TOOL_REQUEST]>>>',
        toolResultStart: '[[VCP调用结果信息汇总:',
        toolResultEnd: 'VCP调用结果结束]]',
        desktopStart: '<<<[DESKTOP_PUSH]>>>',
        desktopEnd: '<<<[DESKTOP_PUSH_END]>>>',
        thoughtStart: '[--- VCP元思考链',
        thoughtEnd: '[--- 元思考链结束 ---]'
    });

    const CONTROL_LINE_REGEX = /^[ \t]*\[\[Flowlock::(Start|Stop|Complete|Fail|NextHeartbeat)(?:::(\d+))?\]\][ \t]*$/gim;
    // 块命令允许两种模型常见输出：
    // 1) 起止标记各自独占一行；
    // 2) [[Flowlock::NextPrompt]]内容[[/Flowlock::NextPrompt]] 同行输出。
    // 不使用 ^/$ 限制块标记，但仍由 createSafeScanText() 排除代码、工具结果和思维链中的伪指令。
    const NEXT_PROMPT_START_REGEX = /\[\[Flowlock::NextPrompt\]\]/gi;
    const NEXT_PROMPT_END_REGEX = /\[\[\/Flowlock::NextPrompt\]\]/gi;
    const FAIL_START_REGEX = /\[\[Flowlock::Fail\]\]/gi;
    const FAIL_END_REGEX = /\[\[\/Flowlock::Fail\]\]/gi;

    function maskRange(chars, start, end) {
        const safeStart = Math.max(0, start);
        const safeEnd = Math.min(chars.length, end);
        for (let index = safeStart; index < safeEnd; index++) {
            if (chars[index] !== '\n' && chars[index] !== '\r') {
                chars[index] = ' ';
            }
        }
    }

    function findToolRequestEnd(text, contentStart) {
        let cursor = contentStart;

        while (cursor < text.length) {
            const requestEnd = text.indexOf(TOKENS.toolRequestEnd, cursor);
            const normalFieldStart = text.indexOf('「始」', cursor);
            const escapeFieldStart = text.indexOf('「始ESCAPE」', cursor);

            const fieldCandidates = [
                normalFieldStart === -1 ? Infinity : normalFieldStart,
                escapeFieldStart === -1 ? Infinity : escapeFieldStart
            ];
            const nearestFieldStart = Math.min(...fieldCandidates);

            if (requestEnd !== -1 && requestEnd < nearestFieldStart) {
                return requestEnd + TOKENS.toolRequestEnd.length;
            }

            if (!Number.isFinite(nearestFieldStart)) {
                return requestEnd === -1 ? text.length : requestEnd + TOKENS.toolRequestEnd.length;
            }

            const isEscape = nearestFieldStart === escapeFieldStart;
            const startMarker = isEscape ? '「始ESCAPE」' : '「始」';
            const endMarker = isEscape ? '「末ESCAPE」' : '「末」';
            const fieldEnd = text.indexOf(endMarker, nearestFieldStart + startMarker.length);

            if (fieldEnd === -1) {
                return text.length;
            }

            cursor = fieldEnd + endMarker.length;
        }

        return text.length;
    }

    function maskDelimitedBlocks(text, chars, startToken, endToken, endResolver = null) {
        let cursor = 0;
        while (cursor < text.length) {
            const start = text.indexOf(startToken, cursor);
            if (start === -1) break;

            let end;
            if (typeof endResolver === 'function') {
                end = endResolver(text, start + startToken.length);
            } else {
                const endIndex = text.indexOf(endToken, start + startToken.length);
                end = endIndex === -1 ? text.length : endIndex + endToken.length;
            }

            maskRange(chars, start, end);
            cursor = Math.max(end, start + startToken.length);
        }
    }

    function maskCodeFences(text, chars) {
        const lines = text.split(/(?<=\n)/);
        let offset = 0;
        let fence = null;
        let fenceStart = -1;

        for (const line of lines) {
            const lineWithoutEnding = line.replace(/\r?\n$/, '');
            const match = lineWithoutEnding.match(/^[ \t]*(`{3,}|~{3,})/);

            if (!fence && match) {
                fence = { char: match[1][0], length: match[1].length };
                fenceStart = offset;
            } else if (fence && match && match[1][0] === fence.char && match[1].length >= fence.length) {
                maskRange(chars, fenceStart, offset + line.length);
                fence = null;
                fenceStart = -1;
            }

            offset += line.length;
        }

        if (fence && fenceStart !== -1) {
            maskRange(chars, fenceStart, text.length);
        }
    }

    function maskInlineCode(text, chars) {
        const regex = /`+[^`\r\n]*`+/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            maskRange(chars, match.index, match.index + match[0].length);
        }
    }

    function maskConventionalThoughts(text, chars) {
        const regex = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi;
        let match;
        while ((match = regex.exec(text)) !== null) {
            maskRange(chars, match.index, match.index + match[0].length);
        }
    }

    function maskToolCallSummaries(text, chars) {
        maskDelimitedBlocks(
            text,
            chars,
            '[本轮工具调用摘要:]',
            '[本轮工具调用摘要结束]'
        );
    }

    function createSafeScanText(text) {
        const chars = text.split('');

        // 工具结果优先级最高：其内部允许包含任意协议、代码和标记。
        maskDelimitedBlocks(text, chars, TOKENS.toolResultStart, TOKENS.toolResultEnd);
        maskDelimitedBlocks(text, chars, TOKENS.toolRequestStart, TOKENS.toolRequestEnd, findToolRequestEnd);
        maskToolCallSummaries(text, chars);
        maskDelimitedBlocks(text, chars, TOKENS.desktopStart, TOKENS.desktopEnd);
        maskDelimitedBlocks(text, chars, TOKENS.thoughtStart, TOKENS.thoughtEnd);
        maskConventionalThoughts(text, chars);
        maskCodeFences(text, chars);
        maskInlineCode(text, chars);

        return chars.join('');
    }

    function collectBlockCommand(text, safeText, startRegex, endRegex, type) {
        startRegex.lastIndex = 0;
        const startMatch = startRegex.exec(safeText);
        startRegex.lastIndex = 0;
        if (!startMatch) return null;

        endRegex.lastIndex = startMatch.index + startMatch[0].length;
        const endMatch = endRegex.exec(safeText);
        endRegex.lastIndex = 0;

        const contentStart = startMatch.index + startMatch[0].length;
        const contentEnd = endMatch ? endMatch.index : text.length;
        const rangeEnd = endMatch ? endMatch.index + endMatch[0].length : text.length;

        return {
            type,
            value: text.slice(contentStart, contentEnd).trim(),
            start: startMatch.index,
            end: rangeEnd
        };
    }

    function normalizeDelaySeconds(rawValue, limits = {}) {
        const minimum = Number.isFinite(limits.minDelaySeconds) ? limits.minDelaySeconds : 1;
        const maximum = Number.isFinite(limits.maxDelaySeconds) ? limits.maxDelaySeconds : 86400;
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed)) return null;
        return Math.min(maximum, Math.max(minimum, parsed));
    }

    function parse(rawText, options = {}) {
        const text = typeof rawText === 'string' ? rawText : '';
        const safeText = createSafeScanText(text);
        const commands = [];
        const ranges = [];

        CONTROL_LINE_REGEX.lastIndex = 0;
        let match;
        while ((match = CONTROL_LINE_REGEX.exec(safeText)) !== null) {
            const normalizedType = match[1].toLowerCase();
            const command = {
                type: normalizedType,
                start: match.index,
                end: match.index + match[0].length
            };

            if (normalizedType === 'nextheartbeat') {
                const delaySeconds = normalizeDelaySeconds(match[2], options);
                if (delaySeconds === null) continue;
                command.delaySeconds = delaySeconds;
            }

            commands.push(command);
            ranges.push({ start: command.start, end: command.end });
        }
        CONTROL_LINE_REGEX.lastIndex = 0;

        const nextPrompt = collectBlockCommand(
            text,
            safeText,
            NEXT_PROMPT_START_REGEX,
            NEXT_PROMPT_END_REGEX,
            'nextprompt'
        );
        if (nextPrompt) {
            commands.push(nextPrompt);
            ranges.push({ start: nextPrompt.start, end: nextPrompt.end });
        }

        const failBlock = collectBlockCommand(
            text,
            safeText,
            FAIL_START_REGEX,
            FAIL_END_REGEX,
            'fail'
        );
        if (failBlock) {
            // 单行 Fail 已由 CONTROL_LINE_REGEX 识别；只有闭合块或包含原因时才追加块命令。
            if (failBlock.value || failBlock.end < text.length) {
                commands.push(failBlock);
                ranges.push({ start: failBlock.start, end: failBlock.end });
            }
        }

        commands.sort((left, right) => left.start - right.start);

        const commandTypes = new Set(commands.map(command => command.type));
        const terminalType = commandTypes.has('fail')
            ? 'fail'
            : commandTypes.has('complete')
                ? 'complete'
                : commandTypes.has('stop')
                    ? 'stop'
                    : null;

        return {
            text,
            safeText,
            commands,
            ranges,
            hasCommands: commands.length > 0,
            terminalType,
            shouldStart: !terminalType && commandTypes.has('start'),
            nextHeartbeatSeconds: commands
                .filter(command => command.type === 'nextheartbeat')
                .at(-1)?.delaySeconds ?? null,
            nextPrompt: commands
                .filter(command => command.type === 'nextprompt')
                .at(-1)?.value ?? null,
            failReason: commands
                .filter(command => command.type === 'fail' && command.value)
                .at(-1)?.value ?? null
        };
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function getCommandPresentation(command) {
        switch (command.type) {
            case 'start':
                return { state: 'start', icon: '▶', title: '进入心流', detail: '当前话题已申请持续自主工作' };
            case 'stop':
                return { state: 'stop', icon: '■', title: '退出心流', detail: '当前 Agent 已申请停止心流周期' };
            case 'complete':
                return { state: 'complete', icon: '✓', title: '心流任务完成', detail: '当前 Agent 已完成持续任务' };
            case 'fail':
                return { state: 'fail', icon: '!', title: '心流任务中止', detail: command.value || '当前 Agent 报告任务无法继续' };
            case 'nextheartbeat':
                return { state: 'heartbeat', icon: '↻', title: '安排下次心跳', detail: `${command.delaySeconds} 秒后再次唤醒` };
            case 'nextprompt':
                return { state: 'prompt', icon: '✦', title: '设置下轮目标', detail: command.value || '已设置下一轮提示词' };
            default:
                return { state: 'unknown', icon: '◇', title: '心流状态', detail: '' };
        }
    }

    function renderBubble(command) {
        const presentation = getCommandPresentation(command);
        const detail = presentation.detail
            ? `<span class="vcp-flowlock-detail">${escapeHtml(presentation.detail)}</span>`
            : '';

        return `\n\n<div class="vcp-flowlock-bubble state-${presentation.state}" data-vcp-block-type="flowlock" data-vcp-preserve-children="true">` +
            `<span class="vcp-flowlock-icon" aria-hidden="true">${escapeHtml(presentation.icon)}</span>` +
            `<span class="vcp-flowlock-copy">` +
            `<span class="vcp-flowlock-title">${escapeHtml(presentation.title)}</span>` +
            detail +
            `</span>` +
            `</div>\n\n`;
    }

    function transformForRender(rawText, options = {}) {
        const parsed = parse(rawText, options);
        if (!parsed.hasCommands) return parsed.text;

        const replacements = parsed.commands
            .map(command => ({
                start: command.start,
                end: command.end,
                html: renderBubble(command)
            }))
            .sort((left, right) => {
                if (left.start !== right.start) return left.start - right.start;
                return right.end - left.end;
            });

        // 去除重叠范围（例如 Fail 块和其中的单行 Fail 起始标记）。
        const nonOverlapping = [];
        for (const replacement of replacements) {
            const previous = nonOverlapping[nonOverlapping.length - 1];
            if (previous && replacement.start < previous.end) {
                if (replacement.end > previous.end) {
                    previous.end = replacement.end;
                }
                continue;
            }
            nonOverlapping.push({ ...replacement });
        }

        let result = '';
        let cursor = 0;
        for (const replacement of nonOverlapping) {
            result += parsed.text.slice(cursor, replacement.start);
            result += replacement.html;
            cursor = replacement.end;
        }
        result += parsed.text.slice(cursor);

        return result;
    }

    global.flowlockProtocol = Object.freeze({
        parse,
        transformForRender,
        createSafeScanText
    });

    console.log('[Flowlock Protocol] Safe parser initialized.');
})(window);