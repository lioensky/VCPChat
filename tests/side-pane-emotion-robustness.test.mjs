// 情绪标签和情绪源在不规整输入下的表现：模型写歪的标签、讲格式时的行内代码、逐字流式、
// 同一个助手两路回复并发、群聊里同一个助手的回复，以及重新生成时的表情标记说明
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stripEmotionTags, createEmotionTagScanner } from '../modules/emotion/emotionTags.js';
import { createEmotionDirector } from '../modules/emotion/emotionDirector.js';
import { EMOTION_TAG_PROMPT, resolveEmotionTagPrompt } from '../modules/emotion/emotionPrompt.js';
import { createAgentEmotionFeed } from '../modules/renderer/agentEmotionFeed.js';

function scanAll(text, { chunk = text.length } = {}) {
    const scanner = createEmotionTagScanner();
    const events = [];
    for (let at = 0; at < text.length; at += chunk) events.push(...scanner.push(text.slice(at, at + chunk)));
    events.push(...scanner.finish());
    return {
        tags: events.filter(event => event.type === 'tag').map(event => event.emotion),
        text: events.filter(event => event.type === 'text').map(event => event.text).join(''),
    };
}

test('a tag the model closed with > instead of --> is still a tag and hides nothing after it', () => {
    // 没处理时：要么一路吞到正文里的 "A --> B"，要么作为没闭合的注释把后面整段回复藏掉
    const reply = '<!--emo:happy 0.8>好的！流程是 A --> B，然后结束。';
    assert.equal(stripEmotionTags(reply), '好的！流程是 A --> B，然后结束。');
    assert.deepEqual(scanAll(reply), { tags: ['happy'], text: '好的！流程是 A --> B，然后结束。' });

    for (const [variant, after] of [
        ['<!--emo:shy 0.5 -- >后文', '后文'],
        ['<!--emo:sad --!>后文', '后文'],
        ['<!--emo:angry->后文', '后文'],
    ]) {
        assert.equal(stripEmotionTags(variant), after, variant);
        assert.deepEqual(scanAll(variant).tags.length, 1, variant);
    }
});

test('a tag with no end at all loses only the tag, never the reply', () => {
    const reply = '<!--emo:happy 0.8好的！整段回答都在这里\n第二行';
    assert.equal(stripEmotionTags(reply), '好的！整段回答都在这里\n第二行');
    assert.deepEqual(scanAll(reply), { tags: ['happy'], text: '好的！整段回答都在这里\n第二行' });
    // 认不出情绪词时只去掉标签开头，正文照样看得见
    assert.ok(!stripEmotionTags('<!--emo:看起来\n正文').includes('<!--'));
    assert.match(stripEmotionTags('<!--emo:看起来\n正文'), /正文/);
});

test('a tag mentioned in inline code or a ~~~ fence is shown as written', () => {
    assert.equal(stripEmotionTags('用 `<!--emo:happy 0.8-->` 这个标记'), '用 `<!--emo:happy 0.8-->` 这个标记');
    assert.equal(stripEmotionTags('~~~\n<!--emo:sad-->\n~~~\n正文'), '~~~\n<!--emo:sad-->\n~~~\n正文');
    assert.deepEqual(scanAll('~~~\n<!--emo:sad-->\n~~~\n正文').tags, []);
});

test('streamed one character at a time, no prefix shows tag text and the final text is complete', () => {
    const replies = [
        '<!--emo:happy 0.8-->你好！<!--emo:sad>唉。A --> B',
        '<!--emo:happy 0.8好的\n第二行',
        '前文<!--emo:shy 0.5 -- >后文',
    ];
    for (const reply of replies) {
        for (let length = 1; length <= reply.length; length += 1) {
            const shown = stripEmotionTags(reply.slice(0, length), { streaming: true });
            assert.ok(!/<!|emo:/.test(shown), `${JSON.stringify(reply.slice(0, length))} -> ${JSON.stringify(shown)}`);
        }
        assert.equal(scanAll(reply, { chunk: 1 }).text, stripEmotionTags(reply));
    }
});

function createClock() {
    let time = 0;
    const timers = [];
    return {
        now: () => time,
        setTimer(callback, delay) { const timer = { at: time + delay, callback }; timers.push(timer); return timer; },
        clearTimer(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
        advance(ms) {
            const until = time + ms;
            for (;;) {
                timers.sort((a, b) => a.at - b.at);
                const timer = timers[0];
                if (!timer || timer.at > until) break;
                timers.shift();
                time = timer.at;
                timer.callback();
            }
            time = until;
        },
    };
}

test('two replies of the same agent streaming at once: the newer one leads and the portrait does not flicker', () => {
    const clock = createClock();
    const frames = [];
    const director = createEmotionDirector({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        onFrame: frame => frames.push(`${frame.state || frame.emotion}:${frame.messageId}`),
    });
    director.begin('main');
    director.append('main', '<!--emo:happy 0.9-->好的呀，');
    clock.advance(2000);
    director.begin('side');
    director.append('side', '<!--emo:sad 0.9-->唉，');
    clock.advance(2000);
    for (let round = 0; round < 6; round += 1) {
        director.append('main', '继续说');
        clock.advance(800);
        director.append('side', '又一句');
        clock.advance(800);
    }
    director.end('side');
    director.append('main', '主聊天还在说');
    clock.advance(4000);
    assert.deepEqual(frames, ['thinking:main', 'happy:main', 'sad:side']);
});

test('the feed ignores group chat turns of the agent being viewed', () => {
    let listener = null;
    const calls = [];
    const director = {
        begin: id => calls.push(`begin:${id}`),
        append: (id, text) => calls.push(`append:${id}:${text}`),
        end: id => calls.push(`end:${id}`),
        fail: id => calls.push(`fail:${id}`),
        activeMessageId: null,
    };
    const feed = createAgentEmotionFeed({
        chatAPI: { onVCPStreamEvent: (callback) => { listener = callback; return () => { listener = null; }; } },
        director,
        getAgentId: () => 'Nova',
    });
    listener({ type: 'start', messageId: 'g1', context: { agentId: 'Nova', groupId: 'G', isGroupMessage: true } });
    listener({ type: 'data', messageId: 'g1', chunk: '大家好', context: { agentId: 'Nova', groupId: 'G', isGroupMessage: true } });
    listener({ type: 'start', messageId: 'm1', context: { agentId: 'Nova', topicId: 't' } });
    listener({ type: 'end', messageId: 'm1', context: { agentId: 'Nova', topicId: 't' } });
    assert.deepEqual(calls, ['begin:m1', 'end:m1']);
    feed.dispose();
    assert.equal(listener, null);
});

test('the emotion tag prompt is decided in one place and regenerate uses it too', async () => {
    const api = (portraits) => ({ getAgentPortraits: async () => portraits });
    const withVariants = { default: 'file:///p.png', happy: 'file:///h.png' };
    assert.equal(await resolveEmotionTagPrompt(api(withVariants), 'Nova', { systemPrompt: '你是 Nova' }), EMOTION_TAG_PROMPT);
    assert.equal(await resolveEmotionTagPrompt(api({ default: 'file:///p.png' }), 'Nova', {}), '');
    assert.equal(await resolveEmotionTagPrompt(api(withVariants), 'Nova', { emotionTagPrompt: false }), '');
    assert.equal(await resolveEmotionTagPrompt(api(withVariants), 'Nova', { systemPrompt: '自己写了 <!--emo:x-->' }), '');
    assert.equal(await resolveEmotionTagPrompt({ getAgentPortraits: async () => { throw new Error('gone'); } }, 'Nova', {}), '');

    // 重新生成自己拼系统提示词：它也得经过同一个函数，不然重新生成的回复没有情绪标签
    const source = fs.readFileSync(new URL('../modules/renderer/messageContextMenu.js', import.meta.url), 'utf8');
    const regenerate = source.slice(source.indexOf('async function handleRegenerateResponse'));
    assert.match(regenerate, /resolveEmotionTagPrompt\(electronAPI, currentSelectedItemVal\.id, agentConfig\)/);
    assert.match(regenerate, /systemPromptContent = `\$\{systemPromptContent\.trim\(\)\}\\n\\n\$\{emotionTagPrompt\}`/);
});
