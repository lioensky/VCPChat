import test from 'node:test';
import assert from 'node:assert/strict';
import { collectStrictAnimationIslands } from '../modules/renderer/strictAnimationIsland.js';

const script = '<script>const x = "<div>"; if (1 < 2) { /* </div> */ }</script>';
const island = '<div><span title="a > b">ok</span>' + script + '</div>';

test('strict islands require the complete outer close at every split', () => {
    for (let end = 0; end < island.length; end++) {
        assert.deepEqual(collectStrictAnimationIslands(island.slice(0, end)), [], `split ${end}`);
    }
    assert.deepEqual(collectStrictAnimationIslands(island), [
        { start: 0, end: island.length, hasScript: true },
    ]);
});

test('comments, quoted attributes and raw script/style bodies do not close the island', () => {
    const source = '<div title="</div>"><!-- </div> --><style>.x::after { content: "</div>"; }</style>'
        + script + '</div>';
    assert.equal(collectStrictAnimationIslands(source).length, 1);
});

test('ambiguous structures never promote nested children into executable islands', () => {
    for (const source of [
        '<div><span>' + script + '</div>',
        '<div><div/>' + script + '</div>',
        '<div><unknown>' + script + '</unknown></div>',
        '<div><pre>' + island + '</pre></div>',
        '<section>\n' + island + '\n</section>',
        '<div onclick="run()">' + script + '</div>',
        '<div><!-- unfinished\n' + island,
    ]) assert.deepEqual(collectStrictAnimationIslands(source), [], source);
});

test('Markdown and protocol payloads are never executable islands', () => {
    for (const source of [
        '```html\n' + island + '\n```\n',
        '`' + island + '`',
        '[[VCP调用结果信息汇总:\n' + island + '\nVCP调用结果结束]]',
        '<<<[TOOL_REQUEST]>>>\n' + island + '\n<<<[END_TOOL_REQUEST]>>>',
        '<think>\n' + island + '\n</think>',
    ]) assert.deepEqual(collectStrictAnimationIslands(source), [], source);
});

test('multiple independent islands have distinct source extents', () => {
    const source = island + '\n\n' + island;
    assert.deepEqual(collectStrictAnimationIslands(source).map(r => source.slice(r.start, r.end)), [island, island]);
});

test('resource limits fail closed', () => {
    assert.deepEqual(collectStrictAnimationIslands('<div>'.repeat(130) + script + '</div>'.repeat(130)), []);
    assert.deepEqual(collectStrictAnimationIslands('<div>' + 'x'.repeat(256 * 1024) + script + '</div>'), []);
});