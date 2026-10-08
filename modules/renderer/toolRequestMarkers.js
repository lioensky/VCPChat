// modules/renderer/toolRequestMarkers.js

/**
 * 扫描工具请求内容，查找使用了格式错误标记的字段（如「始»）
 * 会先剥离正规的 ESCAPE 区段和普通「始」「末」区段，避免对字段值内部的示例文本产生误报。
 * @param {string} content - 工具请求块的内部文本
 * @returns {string[]} 损坏的字段名列表（去重）
 */
export function findMalformedToolFields(content) {
    if (!content || typeof content !== 'string') return [];

    // 先剥离格式正确的 ESCAPE 区段和普通「始」「末」区段
    const sanitized = content
        .replace(/[「{]始[Ee][Ss][Cc][Aa][Pp][Ee][」}][\s\S]*?[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}]/gi, '')
        .replace(/[「{]始[」}][\s\S]*?[「{]末[」}]/g, '');

    const malformedFields = [];
    const malformedMarkerRegex = /(?:^|[\s,;])([a-zA-Z0-9_-]+)\s*:\s*[「{]始(?![」}]|[Ee][Ss][Cc][Aa][Pp][Ee])/g;
    let match;
    while ((match = malformedMarkerRegex.exec(sanitized)) !== null) {
        const fieldName = match[1];
        if (!malformedFields.includes(fieldName)) {
            malformedFields.push(fieldName);
        }
    }

    return malformedFields;
}

/**
 * 根据解析出的工具名和损坏字段列表，描述工具调用标记的问题
 * @param {{ toolName?: string, malformedFields?: string[] }} params
 * @returns {{ isMalformed: boolean, displayName: string, hint: string }}
 */
export function describeToolRequestMarkerProblem({ toolName = '', malformedFields = [] } = {}) {
    const rawName = typeof toolName === 'string' ? toolName.trim() : '';
    const fields = Array.isArray(malformedFields) ? malformedFields : [];
    const isMalformed = !rawName || fields.length > 0;

    let displayName = rawName;
    let hint = '';

    if (!rawName) {
        displayName = '格式错误';
        if (fields.length > 0) {
            hint = `未识别 tool_name，服务器不会执行这次调用（以下字段标记写法有误，服务器会忽略：${fields.join(', ')}）`;
        } else {
            hint = '未识别 tool_name，服务器不会执行这次调用';
        }
    } else if (fields.length > 0) {
        hint = `以下字段标记写法有误，服务器会忽略：${fields.join(', ')}`;
    }

    return {
        isMalformed,
        displayName,
        hint
    };
}