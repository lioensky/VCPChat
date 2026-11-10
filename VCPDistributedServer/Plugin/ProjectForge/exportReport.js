'use strict';

// 不读快照 BLOB、不推断缺失署名；输入必须是完整历史而非 GUI 分页。
const text = value => String(value ?? '');
const cell = value => text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
const who = value => text(value).trim() || '未记录';
const time = value => text(value).trim() || '未记录';
const table = (headers, rows) => [
    `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
].join('\n');
function verbatim(value) {
    const source = text(value);
    const runs = source.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return `${fence}markdown\n${source}\n${fence}`;
}
function reportFilename(project) {
    const clean = value => text(value).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
        .replace(/[. ]+$/g, '').slice(0, 90);
    return `工程履历-${clean(project.id)}-${clean(project.name) || '未命名'}.md`;
}
function buildReport({ project: p, todos = [], contributors = [], batches = [] }, exportedAt = new Date().toISOString()) {
    const ordered = [...batches].sort((a, b) =>
        text(a.created_at).localeCompare(text(b.created_at)) || Number(a.id) - Number(b.id));
    const parts = [
        `# 工程履历：${cell(p.name)}`,
        '',
        `- 工程 ID：${cell(p.id)}`,
        `- 当前状态：${cell(p.status)}`,
        `- 导出时间：${cell(exportedAt)}`,
        '- 时间按数据库原始时间戳输出（ISO 时间戳中的 Z 表示 UTC）；未记录的信息不推断。',
        '',
        '## 一、工程起点',
        '',
        `- 创建时间：${cell(time(p.created_at))}`,
        `- 创建者：${cell(who(p.created_by))}`,
        `- 工作区：${cell(p.workspace_alias || p.workspace_id || '未记录')}`,
        `- 根目录：${cell(p.root)}`,
        '- 起点以工程创建记录为准；原始需求全文与初始 Todo 快照未单独存档，不能从当前计划反推。',
        ...(p.deleted_at ? [`- 删除时间：${cell(p.deleted_at)}；操作者：${cell(who(p.deleted_by))}`] : []),
        '',
        '## 二、当前计划与责任记录',
        '',
        '> 以下为导出时的 Todo 状态，不是全部 Todo 变更历史；最后更新者不等于任务负责人。',
        '',
        todos.length ? table(['序号', '任务', '状态', '最后更新者', '更新时间', '备注'],
            todos.map(t => [t.seq, t.title, t.status, who(t.updated_by), time(t.updated_at), t.note])) : '无 Todo。',
        '',
        '## 三、完整施工脉络',
        '',
        `共 ${ordered.length} 个批次，按记录时间正序排列；责任署名取自施工批次，不由工程创建者代填。`,
    ];
    for (const b of ordered) {
        parts.push('', `### b${b.id} · ${cell(time(b.created_at))}`, '',
            `- 类型：${cell(b.kind)}`,
            `- 操作者：${cell(b.maid || (b.kind === 'external' ? '外部改动（未署名）' : '未记录'))}`,
            `- 原因：${cell(b.reason || '未记录')}`,
            ...(b.summary ? [`- 批次摘要：${cell(b.summary)}`] : []),
            '',
            b.nodes?.length ? table(['节点', '时间', '操作', '文件', '关联 Todo ID', '原因 / 摘要', '增 / 删'],
                b.nodes.map(n => [`n${n.id}`, time(n.created_at), n.op, n.file_path,
                    n.todo_id ?? '', n.reason || n.summary || b.reason || '未记录',
                    `+${n.added || 0} / -${n.removed || 0}`])) : '此批次未产生文件节点。');
    }
    if (!ordered.length) parts.push('', '暂无施工记录。');
    parts.push('', '## 四、参与者统计', '',
        contributors.length ? table(['施工署名', '批次', '增加行', '删除行', '最近施工时间'],
            contributors.map(c => [who(c.maid), c.batches, c.added, c.removed, time(c.last_at)])) : '暂无施工参与者。',
        '', '## 五、最终验收报告（存档原文）', '',
        `- 报告提交者：${cell(who(p.report_by))}`,
        `- 当前工程状态：${cell(p.status)}`,
        '> 提交时间与用户手动验收的署名、时间以报告原文为准。accepted 状态本身不证明发生过用户手动验收；导出不会执行验收。',
        '> 原文以 Markdown 代码块封存，避免内部标题与外层履历混淆。原报告中的脉络可能截断，完整历史见第三节。',
        '', p.report ? verbatim(p.report) : '尚未提交验收报告。',
        '', '---', '记录范围：工程元数据、当前 Todo、全部施工批次与节点、当前存档验收报告；不包含源码快照全文或未存档的对话。', '');
    return parts.join('\n');
}
module.exports = { buildReport, reportFilename };