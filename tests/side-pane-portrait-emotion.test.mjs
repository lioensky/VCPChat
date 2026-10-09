// 差分立绘的情绪源：回复里的情绪标签、规则兜底、状态、最短停留，以及按情绪挑立绘
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEmotion, emotionFallbacks } from '../modules/emotion/emotionVocabulary.js';
import { stripEmotionTags, createEmotionTagScanner, parseEmotionTagBody } from '../modules/emotion/emotionTags.js';
import { classifyReplyText } from '../modules/emotion/emotionRules.js';
import { createEmotionDirector } from '../modules/emotion/emotionDirector.js';
import { resolvePortrait, hasPortraitVariants, listPortraitVariants } from '../modules/emotion/portraitVariants.js';

function createClock() {
    let time = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => time,
        setTimer(callback, delay) {
            const id = nextId++;
            timers.set(id, { at: time + Math.max(0, delay), callback });
            return id;
        },
        clearTimer(id) { timers.delete(id); },
        advance(ms) {
            const until = time + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                time = due[1].at;
                due[1].callback();
            }
            time = until;
        },
    };
}

function createDirector(options = {}) {
    const clock = createClock();
    const frames = [];
    const director = createEmotionDirector({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        onFrame: frame => frames.push(frame),
        ...options,
    });
    const looks = () => frames.map(frame => frame.state || frame.emotion);
    return { clock, frames, director, looks };
}

test('emotion words in any of the usual spellings map to the shared keys', () => {
    assert.equal(normalizeEmotion('Happy'), 'happy');
    assert.equal(normalizeEmotion('开心'), 'happy');
    assert.equal(normalizeEmotion('sleepy'), 'tired');
    assert.equal(normalizeEmotion('annoyed'), 'angry');
    assert.equal(normalizeEmotion('担心'), 'concerned');
    assert.equal(normalizeEmotion('whatever'), null);
    assert.deepEqual(emotionFallbacks('neutral'), []);
    // 负面情绪缺图时不会退到笑脸
    assert.ok(!emotionFallbacks('sad').includes('happy'));
    assert.equal(emotionFallbacks('excited')[1], 'happy');
});

test('emotion tags are stripped from what people see, but not from code that explains them', () => {
    assert.equal(stripEmotionTags('<!--emo:happy 0.8-->你好呀！'), '你好呀！');
    assert.equal(stripEmotionTags('先说<!-- emo: 开心 -->再说<!--emo:sad/teary 1-->'), '先说再说');
    assert.equal(stripEmotionTags('普通注释<!-- keep -->留着'), '普通注释<!-- keep -->留着');
    assert.equal(stripEmotionTags('```html\n<!--emo:happy-->\n```'), '```html\n<!--emo:happy-->\n```');
    // 流式尾巴上的半个标签先藏起来
    assert.equal(stripEmotionTags('好的<!--emo:hap', { streaming: true }), '好的');
    assert.equal(stripEmotionTags('好的<!-', { streaming: true }), '好的');
    // 回复停在半个标签上（中断、截断）：标签本身去掉，不留给浏览器当成没闭合的注释
    assert.equal(stripEmotionTags('好的<!--emo:happy'), '好的');
    assert.deepEqual(parseEmotionTagBody('emo:happy/bright_smile 0.8'), { emotion: 'happy', variant: 'bright_smile', intensity: 0.8 });
    assert.equal(parseEmotionTagBody('emo:unknownfeeling'), null);
});

test('the scanner finds tags split across chunks and ignores tags inside code, thoughts and tool calls', () => {
    const scanner = createEmotionTagScanner();
    const events = [];
    const reply = '<!--em|o:happy 0.9-->你好！<think>想想<!--emo:sad--></think>```\n<!--emo:angry-->\n```'
        + '<<<[TOOL_REQUEST]>>>\ntool_name:「始」X「末」<!--emo:tired-->\n<<<[END_TOOL_REQUEST]>>>后面<!--emo:shy-->好';
    for (const chunk of reply.split('|').flatMap(part => part.match(/[\s\S]{1,3}/g))) events.push(...scanner.push(chunk));
    events.push(...scanner.finish());
    const tags = events.filter(event => event.type === 'tag').map(event => event.emotion);
    assert.deepEqual(tags, ['happy', 'shy']);
    const text = events.filter(event => event.type === 'text').map(event => event.text).join('');
    assert.equal(text, '你好！后面好');
    const regions = events.filter(event => event.type === 'enter').map(event => event.region);
    assert.deepEqual(regions, ['thought', 'code', 'tool']);
});

test('the rule fallback reads the reply and stays quiet on weak signals', () => {
    assert.equal(classifyReplyText('太好了，终于修好了！真开心')?.emotion, 'happy');
    assert.equal(classifyReplyText('好耶好耶！！太棒了！！')?.emotion, 'excited');
    assert.equal(classifyReplyText('呜呜，我好难过……')?.emotion, 'sad');
    assert.equal(classifyReplyText('你没事吧？我有点担心你。')?.emotion, 'concerned');
    assert.equal(classifyReplyText('哼！你太过分了，我生气了！')?.emotion, 'angry');
    assert.equal(classifyReplyText('人家才不是害羞呢……')?.emotion, 'shy');
    assert.equal(classifyReplyText('这是第三步的参数说明。'), null);
    assert.equal(classifyReplyText('我不难过。'), null);
});

test('a reply moves from thinking to its tagged emotion without flicker, then settles back to neutral', () => {
    const { clock, director, frames, looks } = createDirector({ settleHoldMs: 60_000 });
    director.begin('m1');
    assert.deepEqual(looks(), ['thinking']);
    clock.advance(200);
    director.append('m1', '<!--emo:happy 0.8-->今天天气');
    // 停留不足 1.5 秒：先不换
    assert.deepEqual(looks(), ['thinking']);
    director.append('m1', '真好呀<!--emo:excited-->');
    clock.advance(1300);
    // 中途的 happy 被后来的 excited 合并掉，只切一次
    assert.deepEqual(looks(), ['thinking', 'excited']);
    director.append('m1', '一起出去玩吧<!--emo:excited 1-->');
    clock.advance(2000);
    assert.equal(frames.length, 2, 'same emotion does not re-emit');
    director.end('m1');
    clock.advance(59_000);
    assert.deepEqual(looks(), ['thinking', 'excited']);
    clock.advance(2000);
    assert.deepEqual(looks(), ['thinking', 'excited', 'neutral']);
    assert.equal(frames.at(-1).source, 'settle');
});

test('a reply without tags gets its emotion from the rules; tool calls and errors show as states', () => {
    const { clock, director, looks } = createDirector();
    director.begin('m1');
    director.append('m1', '呜呜，我真的好难过。');
    clock.advance(1600);
    assert.deepEqual(looks(), ['thinking', 'sad']);
    director.append('m1', '\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」Search「末」\n');
    clock.advance(1600);
    assert.deepEqual(looks(), ['thinking', 'sad', 'tool']);
    director.append('m1', '<<<[END_TOOL_REQUEST]>>>\n');
    clock.advance(1600);
    assert.deepEqual(looks(), ['thinking', 'sad', 'tool', 'sad']);
    director.fail('m1');
    clock.advance(1600);
    assert.deepEqual(looks(), ['thinking', 'sad', 'tool', 'sad', 'error']);
    clock.advance(4000);
    assert.deepEqual(looks(), ['thinking', 'sad', 'tool', 'sad', 'error', 'sad']);
});

test('late chunks of a finished reply are ignored and reset clears everything at once', () => {
    const { clock, director, looks } = createDirector();
    director.begin('m1');
    director.append('m1', '<!--emo:happy-->好的');
    director.end('m1');
    clock.advance(1600);
    director.append('m1', '<!--emo:angry-->迟到的片段');
    clock.advance(1600);
    assert.deepEqual(looks(), ['thinking', 'happy']);
    director.reset();
    assert.deepEqual(looks(), ['thinking', 'happy', 'neutral']);
    assert.equal(director.activeMessageId, null);
});

test('the portrait follows the emotion with theme, nearest-emotion and default fallbacks', () => {
    const portraits = {
        default: 'p.png', light: 'p.light.png',
        happy: 'p.happy.png', 'happy-light': 'p.happy-light.png',
        sad: 'p.sad.png', thinking: 'p.thinking.png',
    };
    assert.equal(hasPortraitVariants(portraits), true);
    assert.equal(hasPortraitVariants({ default: 'p.png', light: 'p.light.png', smile: 'x.png' }), false);
    assert.deepEqual(listPortraitVariants(portraits).sort(), ['happy', 'sad', 'thinking']);
    assert.equal(resolvePortrait(portraits, { emotion: 'happy' }).url, 'p.happy.png');
    assert.equal(resolvePortrait(portraits, { emotion: 'happy', theme: 'light' }).url, 'p.happy-light.png');
    assert.equal(resolvePortrait(portraits, { emotion: 'sad', theme: 'light' }).url, 'p.sad.png');
    assert.equal(resolvePortrait(portraits, { emotion: 'excited' }).url, 'p.happy.png');
    assert.equal(resolvePortrait(portraits, { emotion: 'angry' }).url, 'p.png');
    assert.equal(resolvePortrait(portraits, { emotion: 'angry', theme: 'light' }).url, 'p.light.png');
    assert.equal(resolvePortrait(portraits, { state: 'thinking', emotion: 'sad' }).url, 'p.thinking.png');
    assert.equal(resolvePortrait(portraits, { state: 'tool', emotion: 'sad' }).url, 'p.sad.png');
    assert.equal(resolvePortrait(null, { emotion: 'happy' }), null);
});

test('the agent settings form offers one upload row per variant only while expression variants are on', async () => {
    const { JSDOM } = await import('jsdom');
    const { renderAgentSettingsSurface } = await import('../modules/settings/schema/sidebar-surfaces.js');
    const { EMOTIONS, STATES } = await import('../modules/emotion/emotionVocabulary.js');
    const { PORTRAIT_EXPRESSIONS_ENABLED } = await import('../modules/ui-system/side-pane/portrait-features.js');
    const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
    const form = renderAgentSettingsSurface(dom.window.document.getElementById('host'), dom.window.document);
    const variants = form.querySelector('[data-portrait-variants-slot]');
    const keys = [...form.querySelectorAll('[data-portrait-variant]')].map(row => row.getAttribute('data-portrait-variant'));
    if (PORTRAIT_EXPRESSIONS_ENABLED) {
        assert.equal(variants.hidden, false);
        assert.deepEqual(keys, ['default', 'light', ...EMOTIONS, ...STATES]);
    } else {
        assert.equal(variants, null, '差分关着时不出现差分上传');
        assert.deepEqual(keys, ['default', 'light']);
    }
    const ids = [...form.querySelectorAll('[data-portrait-variant] input[type="file"]')].map(input => input.id);
    assert.equal(new Set(ids).size, ids.length, 'file inputs keep unique ids');
    dom.window.close();
});

test('with expression variants off the side pane only uses the default and light portraits', async () => {
    const { PORTRAIT_EXPRESSIONS_ENABLED, visiblePortraits } = await import('../modules/ui-system/side-pane/portrait-features.js');
    const portraits = { default: 'p.png', light: 'p.light.png', happy: 'p.happy.png', 'sad-light': 'p.sad-light.png' };
    if (PORTRAIT_EXPRESSIONS_ENABLED) {
        assert.equal(visiblePortraits(portraits), portraits);
        return;
    }
    assert.deepEqual(visiblePortraits(portraits), { default: 'p.png', light: 'p.light.png' });
    assert.deepEqual(visiblePortraits({ default: 'p.png', happy: 'p.happy.png' }), { default: 'p.png' });
    assert.equal(visiblePortraits({ light: 'p.light.png', happy: 'p.happy.png' }), null);
    assert.equal(visiblePortraits(null), null);
});
