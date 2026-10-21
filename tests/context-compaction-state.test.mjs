import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCompactionState, effectiveContextHistory } from '../modules/chat/contextCompactionState.js';
import { createCheckpointMessage, buildCompactionMessages } from '../modules/chat/contextCompactionPrompts.js';

const field = (name, value) => `${name}:「始ESCAPE」${value}「末ESCAPE」`;
const request = fields => `<<<[TOOL_REQUEST]>>>\n${field('tool_name', 'DailyNote')},\n${fields.join(',\n')}\n<<<[END_TOOL_REQUEST]>>>`;
const create = (content, name = 'a.txt') => request([
    field('command', 'create'), field('fileName', name), field('Content', content),
]);
const update = (target, replacement, name = 'a.txt') => request([
    field('command', 'update'), field('fileName', name),
    field('target', target), field('replace', replacement),
]);
const message = content => ({ role: 'assistant', content });
const checkpoint = '<context_checkpoint>\n状态快照\n</context_checkpoint>';

test('replay A -> B -> C -> D against the immediately preceding diary state', () => {
    const state = prepareCompactionState([
        message(create('  日记A\r\n原始段落\n  ')),
        message(update('原始段落', '更新B')),
        message(update('更新B', '更新C')),
        message(update('更新C', '更新D')),
    ]);
    assert.equal(state.diaries[0].content, '  日记A\r\n更新D\n  ');
    assert.deepEqual(state.warnings, []);
    assert.ok(state.messages.every(item => !item.content.includes('DailyNote')));
});

test('updates inside one message are replayed in source order, not matched in advance', () => {
    const state = prepareCompactionState([
        message([create('A'), update('A', 'B'), update('B', 'C'), update('C', 'D')].join('\n')),
    ]);
    assert.equal(state.diaries[0].content, 'D');
    assert.deepEqual(state.warnings, []);
});

test('a failed intermediate update preserves actual state for subsequent updates', () => {
    const state = prepareCompactionState([
        message(create('A')),
        message(update('A', 'B')),
        message(update('不存在', 'C')),
        message(update('B', 'D')),
    ]);
    assert.equal(state.diaries[0].content, 'D');
    assert.equal(state.warnings.length, 1);
});

test('multiple diaries retain independent ordered update chains', () => {
    const state = prepareCompactionState([
        message(create('A', 'a.txt')),
        message(create('A', 'b.txt')),
        message(update('A', 'B', 'a.txt')),
        message(update('A', 'X', 'b.txt')),
        message(update('B', 'C', 'a.txt')),
        message(update('X', 'Y', 'b.txt')),
    ]);
    assert.deepEqual(state.diaries.map(item => item.content), ['C', 'Y']);
    assert.deepEqual(state.warnings, []);
});

test('subsequent compaction inherits latest diary state without leaking it to compression model', () => {
    const first = prepareCompactionState([message(create('SECRET_A')), message(update('SECRET_A', 'SECRET_B'))]);
    const saved = createCheckpointMessage(first, checkpoint, {}, { id: 'checkpoint-1', timestamp: 1 });
    const history = [message('old conversation'), saved, message(update('SECRET_B', 'SECRET_C')), { role: 'user', content: '继续' }];
    const second = prepareCompactionState(history);
    assert.equal(second.diaries[0].content, 'SECRET_C');
    assert.equal(saved.contextCompaction.diaries[0].content, 'SECRET_B');
    assert.equal(second.messages[0].content, checkpoint);
    assert.equal(effectiveContextHistory(history).length, 3);
    const outgoing = buildCompactionMessages(second);
    assert.ok(!JSON.stringify(outgoing).includes('SECRET_'));
    assert.equal(outgoing[1].content, checkpoint);
    assert.equal(outgoing.at(-2).content, '继续');
    assert.match(outgoing.at(-1).content, /禁止续写/);
});

test('replacement metacharacters and body whitespace are preserved verbatim', () => {
    const state = prepareCompactionState([
        message(create('\n  A  \n')),
        message(update('A', "$& $$ $'")),
    ]);
    assert.equal(state.diaries[0].content, "\n  $& $$ $'  \n");
});

test('protocol examples in fenced code are not interpreted as diary actions', () => {
    const example = `\`\`\`text\n${create('example')}\n\`\`\``;
    const state = prepareCompactionState([message(example), message(create('real'))]);
    assert.deepEqual(state.diaries.map(item => item.content), ['real']);
    assert.equal(state.messages[0].content, example);
});

test('any nonempty report is preserved verbatim without format validation', async () => {
    const { validateCheckpoint } = await import('../modules/chat/contextCompactionState.js');
    for (const value of [
        `以下是快照：\n${checkpoint}\n已完成。`,
        `\`\`\`xml\n${checkpoint}\n\`\`\``,
        '<context_checkpoint>未闭合的报告',
        checkpoint + checkpoint,
        '  普通 Markdown 报告，无标签\n',
        '<context_checkpoint> </context_checkpoint>',
    ]) assert.equal(validateCheckpoint(value), value);
    assert.equal(validateCheckpoint([
        { type: 'text', text: '报告第一段\n' },
        { type: 'output_text', text: '第二段' },
    ]), '报告第一段\n第二段');
});

test('untagged report remains the next compaction boundary through metadata', () => {
    const report = '无标签压缩报告：保留任务与下一步';
    const saved = createCheckpointMessage(
        { diaries: [], warnings: [], sourceCount: 1 }, report, {}, { id: 'report' }
    );
    const history = [message('旧历史'), saved, message('新增动作')];
    assert.equal(effectiveContextHistory(history)[0].id, 'report');
    assert.equal(prepareCompactionState(history).messages[0].content, report);
});

test('missing or nontext report cannot create an empty checkpoint', async () => {
    const { validateCheckpoint } = await import('../modules/chat/contextCompactionState.js');
    for (const value of ['', ' \n', null, undefined, [], [{ type: 'tool_use', text: checkpoint }]]) {
        assert.throws(() => validateCheckpoint(value));
    }
});