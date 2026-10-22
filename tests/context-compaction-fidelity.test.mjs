import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCheckpointFidelity } from '../modules/chat/contextCompactionFidelity.js';
import { createCheckpointMessage } from '../modules/chat/contextCompactionPrompts.js';
import { prepareCompactionState } from '../modules/chat/contextCompactionState.js';

test('preserved identifiers count as covered anchors', () => {
    const messages = [{ role: 'user', content: '改动 src/core/kbm.rs，commit 45cb31a，文档 https://github.com/x/y/pull/512' }];
    const result = auditCheckpointFidelity(messages,
        '快照保留 src/core/kbm.rs、45cb31a 与 https://github.com/x/y/pull/512 的状态。');
    assert.equal(result.total, 3);
    assert.equal(result.preserved, 3);
    assert.deepEqual(result.missing, { path: [], hash: [], url: [] });
    assert.deepEqual(result.capped, []);
});

test('paraphrased identifiers are named in a bounded sample', () => {
    const messages = [{ role: 'assistant', content: '修改了 src/core/kbm.rs，错误码 Eab12cd34 和 https://docs.example.com/api 均已确认' }];
    const result = auditCheckpointFidelity(messages, '改了核心文件，链接与错误码已处理。');
    assert.equal(result.preserved, 0);
    assert.ok(result.missing.path.includes('src/core/kbm.rs'));
    assert.ok(result.missing.hash.includes('eab12cd34'));
    assert.ok(result.missing.url.includes('https://docs.example.com/api'));
    assert.ok(typeof result.note === 'string' && result.note.length > 0);
});

test('previous checkpoint identifiers stay in the audited source', () => {
    const previous = {
        id: 'old', role: 'user', timestamp: 1, content: '旧快照正文',
        contextCompaction: { kind: 'vchat-context-checkpoint', version: 1,
            checkpoint: '旧快照维护 docs/OLD.md 的约束。', diaries: [], warnings: [] },
    };
    const history = [previous, { id: 'm', role: 'user', content: '新增 docs/NEW.md', timestamp: 2 }];
    const state = prepareCompactionState(history);
    const result = auditCheckpointFidelity(state.messages, '新快照仅保留 docs/NEW.md。');
    assert.ok(result.missing.path.includes('docs/OLD.md'));
    assert.ok(!result.missing.path.includes('docs/NEW.md'));
});

test('plain Chinese chat produces zero anchors, zero false positives', () => {
    const result = auditCheckpointFidelity(
        [{ role: 'user', content: '中文闲聊没有任何锚点，今天天气不错。' }], '闲聊快照。');
    assert.equal(result.total, 0);
    assert.equal(result.preserved, 0);
    assert.deepEqual(result.missing, { path: [], hash: [], url: [] });
});

test('numbers, short hex and six-digit colors are not anchors', () => {
    const result = auditCheckpointFidelity(
        [{ role: 'user', content: '颜色 #ff0000 与数字 1234567 与短串 abcdef' }], '全部无关。');
    assert.equal(result.total, 0);
    assert.deepEqual(result.missing.hash, []);
});

test('parts-array and object content are flattened for extraction', () => {
    const parts = [{ role: 'user', content: [
        { type: 'text', text: '第一段 commit 45cb31a' },
        { type: 'image_url', image_url: { url: 'x' } },
        { type: 'text', text: '第二段 docs/a.md' },
    ] }];
    const object = { role: 'user', content: { text: '对象正文 docs/b.md' } };
    const result = auditCheckpointFidelity([...parts, object],
        '保留 45cb31a、docs/a.md、docs/b.md');
    assert.equal(result.total, 3);
    assert.equal(result.preserved, 3);
});

test('duplicate anchors are deduplicated before counting', () => {
    const messages = [
        { role: 'user', content: 'hash 45cb31a 出现' },
        { role: 'assistant', content: 'hash 45cb31a 再现' },
    ];
    const result = auditCheckpointFidelity(messages, '45cb31a 已保留');
    assert.equal(result.total, 1);
});

test('url segments do not donate pseudo path anchors', () => {
    const result = auditCheckpointFidelity(
        [{ role: 'user', content: '访问 https://api.example.com/v1/endpoint 获取数据' }],
        '接口是核心文件。');
    assert.deepEqual(result.missing.path, []);
    assert.deepEqual(result.missing.url, ['https://api.example.com/v1/endpoint']);
});

test('overlong anchor families are capped and flagged', () => {
    const names = Array.from({ length: 70 }, (_, i) => 'sub/dir/file-' + String(i).padStart(3, '0') + '.md');
    const text = names.join(' ');
    const result = auditCheckpointFidelity([{ role: 'user', content: text }], '全部省略。');
    assert.ok(result.capped.includes('path'));
    assert.equal(result.total, 64);
    assert.equal(result.missing.path.length, 8);
});

test('createCheckpointMessage carries structured fidelity metadata', () => {
    const message = createCheckpointMessage(
        { messages: [{ role: 'user', content: '改动 src/core/kbm.rs' }], diaries: [], warnings: [], sourceCount: 1 },
        '<context_checkpoint>保留 src/core/kbm.rs</context_checkpoint>',
        {}, { id: 'cp', timestamp: 1 });
    assert.equal(message.contextCompaction.fidelity.total, 1);
    assert.equal(message.contextCompaction.fidelity.preserved, 1);
    assert.deepEqual(message.contextCompaction.fidelity.missing, { path: [], hash: [], url: [] });
});
