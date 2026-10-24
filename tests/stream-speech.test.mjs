import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createStableSpeechStream, speechSourceToText } from '../modules/renderer/streamSpeech.js';
import { createStreamSpeechOwner } from '../modules/renderer/streamSpeechOwner.js';

const document = new JSDOM('').window.document;
function readStream(raw, step = 1) {
    const stream = createStableSpeechStream({ document });
    const blocks = [];
    for (let i = 0; i < raw.length; i += step) blocks.push(...stream.push(raw.slice(i, i + step)));
    blocks.push(...stream.finish());
    assert.deepEqual(stream.finish(), []);
    return blocks.filter(block => block.text).map(block => block.text).join('\n');
}

test('paragraph stable text is emitted before EOF, with a single final tail', () => {
    const stream = createStableSpeechStream({ document });
    assert.deepEqual(stream.push('第一段。\n\n'), []);
    assert.equal(stream.push('第二段。\n\n第三段。')[0].text, '第一段。');
    assert.equal(stream.finish()[0].text, '第二段。\n\n第三段。');
    assert.deepEqual(stream.finish(), []);
    assert.deepEqual(stream.push('迟到'), []);
});

test('raw style and script contents never escape through internal paragraph boundaries', () => {
    const raw = '你好。\n\n<style>\n.secret { color: red; }\n\n.hidden { display: none; }\n\n</style>\n'
        + '<script>secret();\n\nmore();\n\n</script>\n\n这是正文。\n\n最后一句。';
    for (const step of [1, 3, 17, raw.length]) {
        const spoken = readStream(raw, step);
        assert.doesNotMatch(spoken, /secret|hidden|display|color|more|style|script/);
        assert.match(spoken, /你好/);
        assert.match(spoken, /这是正文/);
        assert.match(spoken, /最后一句/);
    }
});

test('tools, nested tool receipts, role sections and thoughts are excluded', () => {
    const raw = '开始。\n\n<<<[TOOL_REQUEST]>>>tool_name:「始」Secret「末」<<<[END_TOOL_REQUEST]>>>'
        + '<<<[ROLE_DIVIDE_USER]>>>\n[[VCP调用结果信息汇总: outer [[VCP调用结果信息汇总: inner VCP调用结果结束]] secret VCP调用结果结束]]\n<<<[END_ROLE_DIVIDE_USER]>>>\n'
        + '<think>\nsecret thought\n</think>\n\n结束。\n\n尾部。';
    const text = readStream(raw);
    assert.doesNotMatch(text, /Secret|secret|inner|outer|ROLE|TOOL|think/);
    assert.match(text, /开始/);
    assert.match(text, /结束/);
    assert.match(text, /尾部/);
});

test('fenced code, incomplete hidden structures and markdown are cleaned before speech', () => {
    assert.equal(speechSourceToText('**你好** [世界](https://example.com)', document), '你好 世界');
    assert.doesNotMatch(readStream('正文。\n\n```css\nsecret { color: red; }\n```\n\n后文。'), /secret|color/);
    for (const tail of ['<style>secret', '<script>secret', '<think>secret', '<<<[TOOL_REQUEST]>>>secret']) {
        assert.doesNotMatch(readStream('正文。\n\n' + tail), /secret/);
    }
});

test('speech owner appends in one session and ignores replay, stale operations and stop tails', () => {
    const said = [];
    let stopped;
    const owner = createStreamSpeechOwner({
        document, speak: (...args) => said.push(args),
        subscribeStop: callback => { stopped = callback; return () => {}; },
    });
    owner.begin({ id: 'm', streamOperationId: 'op' });
    owner.append('m', '第一段。\n\n第二段。\n\n尾部。', 'op');
    owner.begin({ id: 'm', streamOperationId: 'op' });
    owner.append('m', '错误内容', 'old');
    owner.finish('m', 'completed');
    assert.equal(said.length, 2);
    assert.equal(said[0][2].speechStreamFirst, true);
    assert.equal(said[1][2].speechStreamFirst, false);
    assert.equal(said[0][2].speechStreamId, said[1][2].speechStreamId);
    owner.begin({ id: 'next', streamOperationId: 'next-op' });
    owner.append('next', '第一段。\n\n第二段。\n\n尾部。', 'next-op');
    stopped();
    owner.append('next', '不应该重启。\n\n后文。\n\n', 'next-op');
    owner.finish('next', 'completed');
    assert.equal(said.length, 3);
    owner.dispose();
});

test('pet wiring consumes stable cleaned paragraphs and preserves emotion positions', async () => {
    const fs = await import('node:fs');
    const url = new URL('../DeskPetmodules/petStream.js', import.meta.url);
    let source = fs.readFileSync(url, 'utf8');
    source = source.replace(/vcp-deskpet:\/\/pet\/emotion\//g, new URL('../modules/emotion/', import.meta.url).href)
        .replace(/vcp-deskpet:\/\/pet\/app\//g, new URL('../DeskPetmodules/', import.meta.url).href)
        .replace(/vcp-deskpet:\/\/pet\/renderer\//g, new URL('../modules/renderer/', import.meta.url).href);
    const { createPetStream } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const oldDocument = globalThis.document;
    globalThis.document = document;
    try {
        let receive;
        const spoken = [];
        const ctx = {
            api: { onStream: callback => { receive = callback; } },
            director: { begin() {}, append() {}, end() {}, frame: { emotion: 'neutral' } },
            bubble: {}, composer: {}, life: { hold() {} },
            clearMissed() {}, isQuiet: () => false, queueRenderBubble() {}, renderBubble() {},
            scheduleReplyHide() {}, replyHoldMs: () => 0, hasPendingProactive: () => false,
            speech: { begin() {}, update: raw => spoken.push(raw), finish: raw => spoken.push(raw) },
        };
        createPetStream(ctx).bindStream();
        receive({ type: 'start', messageId: 'pet' });
        const raw = '<style>.secret {color:red;}\n\n.hidden {display:none;}\n\n</style>\n'
            + '<!--emo:happy 0.8-->你好呀！\n\n第二段。\n\n最后一句。';
        for (const text of raw) receive({ type: 'data', messageId: 'pet', text });
        receive({ type: 'end', messageId: 'pet' });
        assert.doesNotMatch(spoken.join(''), /secret|hidden|color|display/);
        assert.match(spoken.at(-1), /最后一句/);
        assert.equal(ctx.bubble.tags[0].emotion, 'happy');
        assert.ok(ctx.bubble.tags[0].at < ctx.bubble.reply.indexOf('你好呀'));
    } finally {
        globalThis.document = oldDocument;
    }
});

test('closed standalone styles resume stable speech before the response ends', () => {
    const stream = createStableSpeechStream({ document });
    assert.deepEqual(stream.push('<style>\na {color:red;}\n\nb {color:blue;}\n\n'), []);
    const blocks = stream.push('</style>\n\n第一段。\n\n第二段。\n\n第三段。');
    assert.match(blocks.map(block => block.text).join(''), /第一段/);
    assert.doesNotMatch(blocks.map(block => block.text).join(''), /color/);
    const tail = stream.finish();
    assert.match(tail.map(block => block.text).join(''), /第三段/);
});