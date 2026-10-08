/* HTML text escaping shared by the code viewer and auxiliary conversation.
 * Each adapter preserves its caller's original non-string handling.
 */
'use strict';

export function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function escapeHtmlValue(value) {
    return value ? escapeHtml(String(value)) : '';
}
