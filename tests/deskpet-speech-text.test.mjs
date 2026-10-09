import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechChunker, toSpeechText } from '../DeskPetmodules/speechText.js';

// 模拟流式：一次来几个字
function streamThrough(chunker, text, step = 3) {
    const out = [];
    for (let i = step; i < text.length + step; i += step) out.push(...chunker.push(text.slice(0, i)));
    return out;
}

test('a streamed reply is cut into sentences at the punctuation, the tail on finish', () => {
    const raw = '你好呀！今天想聊点什么？我刚刚看完一本书，觉得很有意思。还没说完';
    const chunker = createSpeechChunker();
    const cut = streamThrough(chunker, raw);
    assert.deepEqual(cut.map((s) => s.text), ['你好呀！', '今天想聊点什么？', '我刚刚看完一本书，觉得很有意思。']);
    const rest = chunker.finish(raw);
    assert.deepEqual(rest.map((s) => s.text), ['还没说完']);
    // 位置首尾相接、覆盖整条原文，气泡按 end 显示不会漏字
    const all = [...cut, ...rest];
    assert.equal(all[0].start, 0);
    for (let i = 1; i < all.length; i += 1) assert.equal(all[i].start, all[i - 1].end);
    assert.equal(all.at(-1).end, raw.length);
    assert.deepEqual(all.map((s) => s.index), [0, 1, 2, 3]);
});

test('closing quotes and repeated marks stay with their sentence, even across stream chunks', () => {
    const chunker = createSpeechChunker();
    assert.deepEqual(chunker.push('她说：“真的吗！'), [], '句末标点在最后，还不知道后面有没有引号');
    const [first] = chunker.push('她说：“真的吗！！”然后');
    assert.equal(first.text, '她说：“真的吗！！”');
});

test('tiny sentences are merged into the next one; the first one may be short', () => {
    const chunker = createSpeechChunker();
    const cut = chunker.finish('嗯。好。那我们开始吧，先看第一部分。');
    assert.deepEqual(cut.map((s) => s.text), ['嗯。好。', '那我们开始吧，先看第一部分。']);
});

test('english periods split only before whitespace, so numbers and links stay whole', () => {
    const chunker = createSpeechChunker();
    const cut = chunker.finish('Version 3.5 is out. See [docs](https://a.b/c.html) for more. Bye now.');
    assert.deepEqual(cut.map((s) => s.text), ['Version 3.5 is out.', 'See docs for more.', 'Bye now.']);
});

test('a long run without sentence marks is split at a comma', () => {
    const long = `${'这是一段很长很长的话'.repeat(6)}，${'后面还有很多很多字'.repeat(6)}`;
    const chunker = createSpeechChunker({ maxChars: 70 });
    const cut = chunker.push(long);
    assert.equal(cut.length, 1);
    assert.ok(cut[0].text.endsWith('，'), cut[0].text);
});

test('markdown, code and image placeholders are not read aloud', () => {
    assert.equal(toSpeechText('**重点**是这个 `x`：\n- 第一项\n[代码]\n![图](a.png)'), '重点是这个 x： 第一项');
    assert.equal(toSpeechText('\n[代码]\n'), '');
    assert.equal(toSpeechText('……！！'), '');
    const chunker = createSpeechChunker();
    const cut = chunker.finish('看这段：\n[代码]\n就这样。');
    assert.deepEqual(cut.map((s) => s.text), ['看这段：', '', '就这样。'], '空句子留着位置，调用方跳过');
});

test('emotion tags and control markers are never read aloud', () => {
    assert.equal(toSpeechText('<!--emo:happy 0.8-->[[Flowlock::Start]]我们开个新话题吧！'), '我们开个新话题吧！');
});
