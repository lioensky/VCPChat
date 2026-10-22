import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOpenIssueWindows, auditCheckpointContinuity } from '../modules/chat/contextCompactionContinuity.js';
import { extractAnchors } from '../modules/chat/contextCompactionFidelity.js';
import { createCheckpointMessage } from '../modules/chat/contextCompactionPrompts.js';
import { prepareCompactionState } from '../modules/chat/contextCompactionState.js';

const previousWithOpenIssues = [
    '<context_checkpoint>',
    '### 4. 尾部高保真接续快照',
    '- **❓ 悬而未决的提问**：是否采用 docs/plan-a.md 中的迁移方案？',
    '  备选是 docs/plan-b.md。',
    '- **⏭️ 承诺的下一步动作**：等待用户在 45cb31a 提交验证后合并。',
    '</context_checkpoint>',
].join('\n');

test('windows split on marked lines and stop at blank lines or headings', () => {
    const windows = extractOpenIssueWindows(previousWithOpenIssues);
    assert.equal(windows.length, 2);
    assert.ok(windows[0].includes('docs/plan-a.md'));
    assert.ok(windows[0].includes('docs/plan-b.md'));
    assert.ok(windows[1].includes('45cb31a'));
    assert.equal(extractOpenIssueWindows('').length, 0);
    assert.equal(extractOpenIssueWindows(null).length, 0);
});

test('keyword-only markers without emoji still open windows', () => {
    const windows = extractOpenIssueWindows('下一步：合并 PR\n然后收工。');
    assert.equal(windows.length, 1);
    assert.ok(windows[0].includes('合并 PR'));
});

test('audit is not applicable without a previous checkpoint', () => {
    const result = auditCheckpointContinuity(null, '<context_checkpoint>新快照</context_checkpoint>');
    assert.equal(result.applicable, false);
    assert.equal(result.windows, 0);
    assert.deepEqual(result.anchors, { total: 0, preserved: 0, missing: [] });
});

test('previous checkpoint without open issues reports zero windows', () => {
    const result = auditCheckpointContinuity('<context_checkpoint>没有未决内容。</context_checkpoint>',
        '<context_checkpoint>新快照</context_checkpoint>');
    assert.equal(result.applicable, true);
    assert.equal(result.windows, 0);
    assert.equal(result.openIssuesDropped, false);
});

test('continuing anchors are preserved and missing ones are named', () => {
    const next = '新快照：迁移方案已定为 docs/plan-b.md；❓ 是否合并 45cb31a 仍在等待确认。';
    const result = auditCheckpointContinuity(previousWithOpenIssues, next);
    assert.equal(result.applicable, true);
    assert.equal(result.windows, 2);
    assert.equal(result.openIssuesDropped, false);
    assert.equal(result.anchors.total, 3);
    assert.equal(result.anchors.preserved, 2);
    assert.ok(result.anchors.missing.includes('docs/plan-a.md'));
});

test('hash continuity matching is case-insensitive like fidelity', () => {
    const result = auditCheckpointContinuity(
        '- ⏭️ 下一步：等待 commit E80E970 的验证结果。',
        '❓ 下一步是等 e80e970 验证。');
    assert.equal(result.anchors.total, 1);
    assert.equal(result.anchors.preserved, 1);
});

test('structural signal fires when the new checkpoint has no open markers', () => {
    const result = auditCheckpointContinuity(previousWithOpenIssues,
        '<context_checkpoint>一切已完成，没有任何未决内容。</context_checkpoint>');
    assert.equal(result.openIssuesDropped, true);
    assert.equal(result.anchors.preserved, 0);
});

test('extractAnchors is exported and URL-first for reuse', () => {
    const anchors = extractAnchors('看 https://api.example.com/v1 和 src/core/kbm.rs');
    assert.deepEqual([...anchors.get('url')], ['https://api.example.com/v1']);
    assert.deepEqual([...anchors.get('path')], ['src/core/kbm.rs']);
    assert.deepEqual([...extractAnchors('')?.get('path') || []], []);
});

test('createCheckpointMessage carries continuity metadata end to end', () => {
    const previousMessage = {
        id: 'old', role: 'user', timestamp: 1, content: '旧正文',
        contextCompaction: { kind: 'vchat-context-checkpoint', version: 1,
            checkpoint: previousWithOpenIssues, diaries: [], warnings: [] },
    };
    const state = prepareCompactionState([previousMessage,
        { id: 'm', role: 'user', content: '新增讨论 docs/plan-c.md', timestamp: 2 }]);
    assert.equal(state.previousCheckpoint, previousWithOpenIssues);
    const message = createCheckpointMessage(state,
        '<context_checkpoint>新快照只保留了 docs/plan-c.md。</context_checkpoint>',
        {}, { id: 'cp2', timestamp: 2 });
    assert.equal(message.contextCompaction.continuity.applicable, true);
    assert.equal(message.contextCompaction.continuity.windows, 2);
    assert.ok(message.contextCompaction.continuity.anchors.missing.includes('docs/plan-a.md'));
    assert.ok(message.contextCompaction.fidelity.missing.path.includes('docs/plan-b.md'));
});


test('previous audit misses are collected for the closed loop', () => {
    const previousMessage = {
        id: 'old', role: 'user', timestamp: 1, content: '旧正文',
        contextCompaction: { kind: 'vchat-context-checkpoint', version: 1,
            checkpoint: '旧快照', diaries: [], warnings: [],
            fidelity: { total: 3, preserved: 1,
                missing: { path: ['docs/a.md'], hash: ['45cb31a'], url: ['https://x.example.com/y'] } },
            continuity: { applicable: true, windows: 1, openIssuesDropped: false,
                anchors: { total: 1, preserved: 0, missing: ['docs/b.md'] } } },
    };
    const state = prepareCompactionState([previousMessage,
        { id: 'm', role: 'user', content: '继续', timestamp: 2 }]);
    assert.deepEqual(state.previousAuditMissing,
        ['docs/a.md', '45cb31a', 'https://x.example.com/y', 'docs/b.md']);
    const fresh = prepareCompactionState([{ id: 'm', role: 'user', content: '继续', timestamp: 2 }]);
    assert.deepEqual(fresh.previousAuditMissing, []);
});

test('compaction request names previously missed identifiers', async () => {
    const { buildCompactionMessages } = await import('../modules/chat/contextCompactionPrompts.js');
    const state = {
        messages: [{ role: 'user', content: '任务继续' }],
        diaries: [], warnings: [], sourceCount: 1,
        previousAuditMissing: ['docs/a.md', '45cb31a'],
    };
    const messages = buildCompactionMessages(state, {});
    const final = messages[messages.length - 1];
    assert.ok(final.content.includes('宿主审计回执：上一次快照未保留以下标识符'));
    assert.ok(final.content.includes('docs/a.md、45cb31a'));
    const clean = buildCompactionMessages({ ...state, previousAuditMissing: [] }, {});
    assert.ok(!clean[clean.length - 1].content.includes('宿主审计回执'));
});

test('summarizeCompactionInput reports scale without judging quality', async () => {
    const { summarizeCompactionInput } = await import('../modules/chat/contextCompactionState.js');
    const previousMessage = {
        id: 'old', role: 'user', timestamp: 1, content: '旧正文',
        contextCompaction: { kind: 'vchat-context-checkpoint', version: 1,
            checkpoint: '- ❓ 待确认：是否合并 docs/plan.md？', diaries: [], warnings: [] },
    };
    const digest = summarizeCompactionInput([previousMessage,
        { id: 'm', role: 'user', content: '改动 src/core/kbm.rs 与 45cb31a', timestamp: 2 }]);
    assert.equal(digest.sourceCount, 2);
    assert.equal(digest.anchors, 2);
    assert.equal(digest.openWindows, 1);
    assert.deepEqual(summarizeCompactionInput([]), { sourceCount: 0, anchors: 0, openWindows: 0 });
});
