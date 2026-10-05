/**
 * modules/ui-system/side-pane/git/diff-model.js
 * V工程 计划标签里的 Git 页（git-view.js）的一部分
 *
 * 照 ZCode `GitPane` / `GitPaneChangeCard`（zai-org/ZCode，Apache-2.0）复刻，只保留它有的东西：
 * 1. 顶栏：来源下拉（未暂存 / 已暂存 / 上一轮）+ 幽灵「刷新」按钮。
 * 2. 平铺的变更列表，每行一张卡片：文件名 + 暗色目录、`+N -N`、展开时翻转 180° 的箭头。
 * 3. 右键菜单：在文件管理器中打开 / 复制绝对路径 / 复制相对路径。
 * 4. 展开后显示 diff（加载中 / 文本 diff / 无法预览的说明）。
 * 5. 空状态：居中图标 + 标题 + 描述。
 *
 * 和 ZCode 的差别只有数据来源：「上一轮」在 VCPChat 里是 V工程 最近一批施工触碰过的文件。
 * 暂存、提交、推送、分支切换、提交图都留在 ProjectForge 和对话状态面板里，这里不重复做。
 */

'use strict';

const normalizePath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

const DIFF_CONTEXT_LINES = 3;

/** Match the latest construction paths against repository-relative status paths. */
export function filterAiTouched(items, batchFiles) {
    const wanted = (batchFiles || []).map(normalizePath).filter(Boolean);
    if (!wanted.length) return [];
    return (items || []).filter((item) => {
        const path = normalizePath(item.path);
        return wanted.some((file) => file === path || file.endsWith('/' + path) || path.endsWith('/' + file));
    });
}

/** Return the newest construction batch from the project timeline. */
export function latestAiBatch(detail) {
    const timeline = Array.isArray(detail?.timeline) ? detail.timeline : [];
    const batch = timeline.reduce((best, row) => (!best || Number(row.id) > Number(best.id) ? row : best), null);
    if (!batch) return null;
    return {
        id: batch.id,
        kind: batch.kind,
        reason: batch.reason || '',
        maid: batch.maid || '',
        createdAt: batch.created_at || '',
        files: Array.isArray(batch.files) ? batch.files : [],
        projectName: detail?.project?.name || ''
    };
}

/** Keep changed lines and their context, separating omitted runs with hunk rows. */
export function buildHunkRows(rows, contextLines = DIFF_CONTEXT_LINES) {
    const keep = new Array(rows.length).fill(false);
    rows.forEach((row, index) => {
        if (row.type === 'same') return;
        for (let i = Math.max(0, index - contextLines); i <= Math.min(rows.length - 1, index + contextLines); i++) keep[i] = true;
    });
    const out = [];
    let skipped = false;
    rows.forEach((row, index) => {
        if (!keep[index]) {
            skipped = true;
            return;
        }
        if (skipped && out.length) out.push({ type: 'hunk', text: '···' });
        skipped = false;
        out.push(row);
    });
    return out;
}
