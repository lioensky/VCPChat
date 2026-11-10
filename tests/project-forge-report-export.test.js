'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, reportFilename } = require('../VCPDistributedServer/Plugin/ProjectForge/exportReport');

test('完整报告按时间正序且保留责任人与原始验收文本', () => {
    const report = '## 用户手动验收\n署名：莱恩 · 时间：2026-11-10T06:00:00.123Z\n```js\nok\n```';
    const data = {
        project: { id: 'p1', name: '报告', status: 'accepted', created_by: 'Kerr', created_at: '2026-11-01T00:00:00.000Z', report_by: 'Nova', report },
        todos: [{ seq: 1, title: 'a|b\n<script>', status: 'done', updated_by: '小克', updated_at: '2026-11-02T00:00:00Z' }],
        batches: Array.from({ length: 205 }, (_, i) => ({
            id: i + 1, kind: i ? 'edit' : 'external', maid: i ? 'Kerr' : null,
            created_at: `2026-11-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.123Z`,
            nodes: [{ id: i + 1, file_path: `f${i}.js`, op: 'edit', created_at: '2026-11-01T00:00:00.456Z' }],
        })).reverse(),
    };
    const markdown = buildReport(data, '2026-11-10T06:00:01Z');
    assert.equal((markdown.match(/^### b/gm) || []).length, 205);
    assert.ok(markdown.indexOf('### b1 ·') < markdown.indexOf('### b205 ·'));
    assert.match(markdown, /外部改动（未署名）/);
    assert.match(markdown, /a&#124;b<br>&lt;script&gt;/);
    assert.ok(markdown.includes(report));
    assert.match(markdown, /````markdown/);
    assert.match(markdown, /创建者：Kerr/);
    assert.match(markdown, /报告提交者：Nova/);
    assert.match(markdown, /最后更新者不等于任务负责人/);
});

test('无报告和未署名不会伪造验收或操作者，文件名无Windows非法字符', () => {
    const project = { id: 'p1', name: '../坏:名*?"<x>|\\', status: 'active' };
    assert.doesNotMatch(reportFilename(project), /[<>:"/\\|?*\u0000-\u001f]/);
    const md = buildReport({ project });
    assert.match(md, /尚未提交验收报告/);
    assert.match(md, /创建时间：未记录/);
    assert.match(md, /创建者：未记录/);
    assert.match(md, /暂无施工记录/);
});