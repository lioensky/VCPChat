/**
 * Parses the display metadata of the experimental natural-language JEV field.
 *
 * This module only affects presentation. It does not translate JEV into legacy
 * plugin fields and does not replace the existing tool_name rendering path.
 *
 * Display priority:
 * 1. Explicit tool name enclosed in quotes or backticks, for example
 *    'GPT生图' or `GPT生图`
 * 2. Capability enclosed in braces, for example {联网搜索}
 *
 * @param {string} value Raw value inside JEV:「始」...「末」
 * @returns {{
 *   raw: string,
 *   displayName: string,
 *   explicitToolName: string,
 *   capability: string
 * }|null}
 */
function parseJevToolUse(value) {
    if (typeof value !== 'string' || !value.trim()) return null;

    const raw = value.trim();
    // 工具请求在进入展示转换前会经过字段内容 HTML 转义，ASCII 单引号通常
    // 已成为 &#039;（也兼容 ' / '）。仅规范化引号实体用于语法识别，
    // 原始 raw 仍保持原值，避免在此模块承担通用 HTML 解码职责。
    const parseSource = raw.replace(/(?:&#0*39;|')/gi, "'");
    const capability = (parseSource.match(/\{([^{}\r\n]+)\}/u)?.[1] || '').trim();
    const explicitToolName = (
        parseSource.match(/'([^'\r\n]+)'/u)?.[1]
        || parseSource.match(/`([^`\r\n]+)`/u)?.[1]
        || parseSource.match(/‘([^’\r\n]+)’/u)?.[1]
        || parseSource.match(/“([^”\r\n]+)”/u)?.[1]
        || ''
    ).trim();

    // JEV 本身就是协议身份。即使内容是完全自由的自然语言，没有能力花括号
    // 或显式工具名，也仍应生成 JEVToolUse；此时 displayName 留空即可。
    return Object.freeze({
        raw,
        displayName: explicitToolName || capability,
        explicitToolName,
        capability
    });
}

export {
    parseJevToolUse
};