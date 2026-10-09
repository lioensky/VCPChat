/* side-chat/note-exporter.js
 * 把一条分支的探讨固化为自包含 Markdown 笔记。
 * 纯字符串构建，无 DOM / IPC；深链接跳板指向侧聊对话现场。
 */
'use strict';

function messageText(message) {
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    if (message.content && typeof message.content === 'object') {
        if (typeof message.content.text === 'string') return message.content.text;
        if (Array.isArray(message.content.parts)) return message.content.parts.join('');
    }
    if (typeof message.text === 'string') return message.text;
    return '';
}

function stableQa(history = []) {
    return (Array.isArray(history) ? history : [])
        .filter(m => m && !m.transient && !m.isStreaming && !m.pending && !m.isThinking && !m.isPendingStream
            && (m.role === 'user' || m.role === 'assistant'))
        .map(m => ({ role: m.role, text: messageText(m), id: m.id || null, timestamp: m.timestamp || null }))
        .filter(m => m.text.trim());
}

function formatTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
}

function deepLink(descriptor, focusMessageId = null) {
    const agent = encodeURIComponent(descriptor?.child?.itemId || '');
    const branch = encodeURIComponent(descriptor?.child?.topicId || '');
    const focus = focusMessageId ? `&focus=${encodeURIComponent(focusMessageId)}` : '';
    return `vcp://sidechat/open?agent=${agent}&branch=${branch}${focus}`;
}

/**
 * 构建单分支的 Markdown 笔记。
 * @param {Object} options
 * @param {Object} options.descriptor 当前分支 descriptor（含分支拓扑字段）
 * @param {Array}  options.ownHistory 当前分支自己的消息（不含祖先快照）
 * @param {number} [options.maxAnswerChars=1200] 每条回答保留的最大长度
 */
export function buildBranchNote({ descriptor, ownHistory = [], maxAnswerChars = 1200 } = {}) {
    const label = descriptor?.forkLabel || descriptor?.branchTitle || descriptor?.title || '分支探讨';
    const qa = stableQa(ownHistory);
    const now = new Date();
    const lines = [];

    lines.push(`# 📓 知识结晶 · ${label}`);
    lines.push('');
    lines.push(`> **固化时间**：${now.toLocaleString()}`);
    if (descriptor?.forkFromTopicId) {
        lines.push(`> **分支层级**：第 ${Number.isFinite(descriptor.depth) ? descriptor.depth : '?'} 层支线`);
        lines.push(`> **分叉盲点**：${descriptor.forkLabel || descriptor.branchTitle || '（未命名）'}`);
    }
    lines.push(`> **来源助手**：${descriptor?.parent?.name || descriptor?.child?.itemId || ''}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    if (qa.length === 0) {
        lines.push('（这条分支还没有可固化的问答。）');
    } else {
        let index = 0;
        for (const msg of qa) {
            if (msg.role === 'user') {
                index += 1;
                lines.push(`## ${index}. 🙋 提问`);
                lines.push('');
                lines.push(msg.text.trim());
                lines.push('');
            } else {
                lines.push(`### 🤖 解答${msg.timestamp ? ` · ${formatTime(msg.timestamp)}` : ''}`);
                lines.push('');
                const answer = msg.text.trim();
                lines.push(answer.length > maxAnswerChars ? `${answer.slice(0, maxAnswerChars)}\n\n…（完整内容见对话现场）` : answer);
                lines.push('');
                lines.push(`[🔗 回到这条解答的对话现场](${deepLink(descriptor, msg.id)})`);
                lines.push('');
            }
        }
    }

    lines.push('---');
    lines.push('');
    lines.push(`**拓扑入口**：[🔗 打开本分支完整对话](${deepLink(descriptor)})`);
    lines.push('');
    lines.push(`*Tag: #知识结晶 #辅助对话分支 #${String(label).replace(/\s+/g, '_')}*`);
    lines.push('');

    return lines.join('\n');
}

export { deepLink as branchDeepLink, stableQa, messageText };