/**
 * 代码查看器按路径读文件。结果统一成三种：
 *   { ok: true, text }      可以显示（空字符串是合法的空文件）
 *   { ok: false, error }    读取失败，按错误显示
 *   { ok: false, notice }   读到了但不适合预览（二进制、过大），按普通提示显示；reason 标明是哪一种
 * 界面只看 ok，不再从各个接口的返回值里猜。
 */

'use strict';

import { toWorkspaceRelative } from '../../git-file-diff.js';

const UNREADABLE = '读取文件失败：文件不存在、无法访问，或不是可预览的文本文件';

/**
 * allowOutsideWorkspace：已登记工作区以外的路径要用户点过「读取」才读。路径可能来自模型的工具调用参数，
 * 不先问就能把任意本地文件（SSH 私钥、配置里的密钥）显示出来再被「插入引用」送回模型。
 * 常见做法是预览只认工作区内的路径（"outside the workspace" 直接拒绝），这里留一次确认给附件之类的文件。
 */
export async function readFileForViewer(api, filePath, { allowOutsideWorkspace = false } = {}) {
    const fromWorkspace = await readThroughWorkspace(api, filePath);
    if (fromWorkspace?.result) return fromWorkspace.result;
    // 没有工作区服务的窗口分不清内外，照旧读
    if (fromWorkspace && !fromWorkspace.inWorkspace && !allowOutsideWorkspace) {
        return { ok: false, reason: 'outside-workspace', needsConsent: true, notice: `这个文件不在任何已登记的工作区里：\n${filePath}` };
    }
    if (typeof api?.getTextContent !== 'function') return { ok: false, error: '当前窗口不支持读取文件' };
    const res = await api.getTextContent(filePath);
    if (typeof res === 'string') return { ok: true, text: res };
    // 附件读取在文件不存在、读失败或类型不支持时都返回 { text: null }
    if (typeof res?.text === 'string') return { ok: true, text: res.text };
    if (typeof res?.data === 'string') return { ok: true, text: res.data };
    return { ok: false, error: UNREADABLE };
}

// 已登记工作区里的文件走源码服务：能分清不存在、二进制和过大，并且读取有上限。
// 返回 { inWorkspace, result }：result 为空表示要交给附件读取（不在工作区，或不是 UTF-8）；读不到工作区列表时返回 null
async function readThroughWorkspace(api, filePath) {
    if (typeof api?.gitListWorkspaces !== 'function' || typeof api?.sourceReadFile !== 'function') return null;
    let match = null;
    try {
        const res = await api.gitListWorkspaces();
        if (!res?.success) return null;
        match = toWorkspaceRelative(filePath, res.data?.workspaces);
    } catch (_error) {
        return null;
    }
    if (!match) return { inWorkspace: false, result: null };
    const res = await api.sourceReadFile(match.workspace.id, match.relPath);
    if (!res?.success) return { inWorkspace: true, result: { ok: false, error: res?.error || '读取文件失败' } };
    const file = res.data || {};
    if (file.binary) return { inWorkspace: true, result: { ok: false, reason: 'binary', notice: '二进制文件，无法预览' } };
    if (file.tooLarge) {
        return { inWorkspace: true, result: { ok: false, reason: 'too-large', notice: `文件过大（${Math.round((file.size || 0) / 1024)} KB），无法预览，请在外部编辑器中打开` } };
    }
    // 不是 UTF-8（比如 GBK）时交给附件读取，它会按 GB18030 解码
    if (file.encodingError) return { inWorkspace: true, result: null };
    return { inWorkspace: true, result: { ok: true, text: typeof file.text === 'string' ? file.text : '' } };
}
