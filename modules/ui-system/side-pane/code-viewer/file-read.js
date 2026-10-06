/**
 * 代码查看器按路径读文件。结果统一成三种：
 *   { ok: true, text }      可以显示（空字符串是合法的空文件）
 *   { ok: false, error }    读取失败，按错误显示
 *   { ok: false, notice }   读到了但不适合预览（二进制、过大），按普通提示显示
 * 界面只看 ok，不再从各个接口的返回值里猜。
 */

'use strict';

import { toWorkspaceRelative } from '../../git-file-diff.js';

const UNREADABLE = '读取文件失败：文件不存在、无法访问，或不是可预览的文本文件';

export async function readFileForViewer(api, filePath) {
    const fromWorkspace = await readThroughWorkspace(api, filePath);
    if (fromWorkspace) return fromWorkspace;
    if (typeof api?.getTextContent !== 'function') return { ok: false, error: '当前窗口不支持读取文件' };
    const res = await api.getTextContent(filePath);
    if (typeof res === 'string') return { ok: true, text: res };
    // 附件读取在文件不存在、读失败或类型不支持时都返回 { text: null }
    if (typeof res?.text === 'string') return { ok: true, text: res.text };
    if (typeof res?.data === 'string') return { ok: true, text: res.data };
    return { ok: false, error: UNREADABLE };
}

// 已登记工作区里的文件走源码服务：能分清不存在、二进制和过大，并且读取有上限
async function readThroughWorkspace(api, filePath) {
    if (typeof api?.gitListWorkspaces !== 'function' || typeof api?.sourceReadFile !== 'function') return null;
    let match = null;
    try {
        const res = await api.gitListWorkspaces();
        match = res?.success ? toWorkspaceRelative(filePath, res.data?.workspaces) : null;
    } catch (_error) {
        return null;
    }
    if (!match) return null;
    const res = await api.sourceReadFile(match.workspace.id, match.relPath);
    if (!res?.success) return { ok: false, error: res?.error || '读取文件失败' };
    const file = res.data || {};
    if (file.binary) return { ok: false, notice: '二进制文件，无法预览' };
    if (file.tooLarge) {
        return { ok: false, notice: `文件过大（${Math.round((file.size || 0) / 1024)} KB），无法预览，请在外部编辑器中打开` };
    }
    // 不是 UTF-8（比如 GBK）时交给附件读取，它会按 GB18030 解码
    if (file.encodingError) return null;
    return { ok: true, text: typeof file.text === 'string' ? file.text : '' };
}
