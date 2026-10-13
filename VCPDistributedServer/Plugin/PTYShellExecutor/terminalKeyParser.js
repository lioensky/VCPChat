"use strict";

const INTERACTIVE_SEQUENCE_LIMITS = Object.freeze({
    maxSteps: 100,
    maxWaitMs: 60000,
    maxTotalWaitMs: 300000,
    maxTextLength: 100000,
    maxQueryLines: 2000,
    responseTimeoutMs: 5000
});

const TERMINAL_KEY_SEQUENCES = Object.freeze({
    enter: '\r',
    return: '\r',
    up: '\x1b[A',
    arrowup: '\x1b[A',
    down: '\x1b[B',
    arrowdown: '\x1b[B',
    right: '\x1b[C',
    arrowright: '\x1b[C',
    left: '\x1b[D',
    arrowleft: '\x1b[D',
    esc: '\x1b',
    escape: '\x1b',
    tab: '\t',
    backtab: '\x1b[Z',
    'shift+tab': '\x1b[Z',
    backspace: '\x7f',
    delete: '\x1b[3~',
    home: '\x1b[H',
    end: '\x1b[F',
    pageup: '\x1b[5~',
    pagedown: '\x1b[6~',
    space: ' ',
    'ctrl+c': '\x03',
    'ctrl+d': '\x04',
    'ctrl+z': '\x1a',
    'ctrl+l': '\x0c',
    'ctrl+a': '\x01',
    'ctrl+e': '\x05',
    'ctrl+u': '\x15',
    'ctrl+k': '\x0b',
    'ctrl+w': '\x17'
});

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseWaitDuration(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.round(value);
    }

    const match = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/);
    if (!match) {
        throw new Error(`无效 wait 时长 "${value}"；请使用 50ms、1s 或毫秒数字。`);
    }

    const milliseconds = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
    return Math.round(milliseconds);
}

function parseTerminalKey(value) {
    const raw = String(value).trim().toLowerCase();
    const match = raw.match(/^(.+?)(?:\s*\*\s*(\d+))?$/);
    const keyName = match ? match[1].trim() : raw;
    const repeat = match && match[2] ? Number.parseInt(match[2], 10) : 1;
    const sequence = TERMINAL_KEY_SEQUENCES[keyName];

    if (!sequence) {
        throw new Error(`不支持的终端按键 "${value}"。`);
    }
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
        throw new Error(`按键重复次数必须在 1 到 10 之间："${value}"。`);
    }

    return { keyName, repeat, data: sequence.repeat(repeat) };
}

function parseInteractiveSequence(args) {
    const steps = [];

    for (const [key, value] of Object.entries(args)) {
        const match = key.match(/^(command|wait|key|paste|queryVisible)(\d+)$/i);
        if (!match) {
            continue;
        }

        const typeLookup = {
            command: 'command',
            wait: 'wait',
            key: 'key',
            paste: 'paste',
            queryvisible: 'queryVisible'
        };
        steps.push({
            key,
            type: typeLookup[match[1].toLowerCase()],
            index: Number.parseInt(match[2], 10),
            value
        });
    }

    if (steps.length === 0) {
        throw new Error('RunInteractiveSequence 至少需要一个带全局序号的步骤，例如 command1、wait2、key3、paste4、queryVisible5。');
    }
    if (steps.length > INTERACTIVE_SEQUENCE_LIMITS.maxSteps) {
        throw new Error(`交互序列最多允许 ${INTERACTIVE_SEQUENCE_LIMITS.maxSteps} 个步骤。`);
    }

    steps.sort((a, b) => a.index - b.index);
    const usedIndexes = new Set();
    let totalWaitMs = 0;

    for (const step of steps) {
        if (!Number.isInteger(step.index) || step.index < 1) {
            throw new Error(`步骤编号必须是从 1 开始的正整数：${step.key}。`);
        }
        if (usedIndexes.has(step.index)) {
            throw new Error(`步骤编号 ${step.index} 重复；不同类型步骤必须共用唯一的全局序号。`);
        }
        usedIndexes.add(step.index);

        if (step.type === 'wait') {
            step.durationMs = parseWaitDuration(step.value);
            if (step.durationMs < 0 || step.durationMs > INTERACTIVE_SEQUENCE_LIMITS.maxWaitMs) {
                throw new Error(`单个 wait 步骤必须在 0 到 ${INTERACTIVE_SEQUENCE_LIMITS.maxWaitMs}ms 之间。`);
            }
            totalWaitMs += step.durationMs;
        } else if (step.type === 'key') {
            step.keySpec = parseTerminalKey(step.value);
        } else if (step.type === 'queryVisible') {
            const parsedLines = Number.parseInt(step.value, 10);
            step.maxLines = Number.isInteger(parsedLines) && parsedLines > 0
                ? Math.min(parsedLines, INTERACTIVE_SEQUENCE_LIMITS.maxQueryLines)
                : null;
        } else {
            if (typeof step.value !== 'string' || !step.value.length) {
                throw new Error(`${step.key} 必须是非空字符串。`);
            }
            if (step.value.length > INTERACTIVE_SEQUENCE_LIMITS.maxTextLength) {
                throw new Error(`${step.key} 超过 ${INTERACTIVE_SEQUENCE_LIMITS.maxTextLength} 字符限制。`);
            }
        }
    }

    if (totalWaitMs > INTERACTIVE_SEQUENCE_LIMITS.maxTotalWaitMs) {
        throw new Error(`序列累计等待不能超过 ${INTERACTIVE_SEQUENCE_LIMITS.maxTotalWaitMs}ms。`);
    }
    if (steps.every(step => step.type === 'wait')) {
        throw new Error('交互序列不能只包含 wait；请至少加入 command、key、paste 或 queryVisible 步骤。');
    }

    return steps;
}

module.exports = {
    INTERACTIVE_SEQUENCE_LIMITS,
    TERMINAL_KEY_SEQUENCES,
    delay,
    parseWaitDuration,
    parseTerminalKey,
    parseInteractiveSequence
};
