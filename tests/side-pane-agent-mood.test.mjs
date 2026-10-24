// 助手的长期心情：回复和用户的话推动它、随时间回落，立绘和桌宠在回复的情绪过去以后回到它
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import * as moodState from '../modules/emotion/moodState.js';
import { createEmotionDirector } from '../modules/emotion/emotionDirector.js';

const {
    createMood, normalizeMood, decayMood, applyMoodEvent, moodEmotion, moodSnapshot,
    userMessageMoodEvent, replyMoodEvent, MOOD_DEFAULTS,
} = moodState;
const require = createRequire(import.meta.url);
const { createAgentMoodStore, teeCall } = require('../modules/agentMood.js');

const HOUR = 60 * 60 * 1000;
const norm = vad => Math.hypot(vad.valence, vad.arousal, vad.dominance);
// 固定在某天中午，跨不跨天由测试自己决定
const NOON = new Date(2026, 9, 8, 12, 0, 0).getTime();

function createClock(start = 0) {
    let time = start;
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
        get pending() { return timers.size; },
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
    return { clock, frames, director, last: () => frames[frames.length - 1] };
}

const happy = at => ({ emotion: 'happy', intensity: 0.9, source: 'tag', at });

test('one cheerful reply leaves a light mood, a few in a row make it clearly happy', () => {
    let mood = createMood(NOON);
    assert.deepEqual(moodEmotion(mood), { emotion: 'neutral', intensity: 0 });
    mood = applyMoodEvent(mood, happy(NOON));
    assert.equal(moodEmotion(mood).emotion, 'happy');
    const once = moodEmotion(mood).intensity;
    mood = applyMoodEvent(mood, happy(NOON + 1000));
    mood = applyMoodEvent(mood, happy(NOON + 2000));
    assert.equal(moodEmotion(mood).emotion, 'happy');
    assert.ok(moodEmotion(mood).intensity > once);
    // 一条推测出来的（没有标签）比标签推得轻
    const ruled = applyMoodEvent(createMood(NOON), { ...happy(NOON), source: 'rule' });
    assert.ok(Math.abs(ruled.vad.valence) < Math.abs(applyMoodEvent(createMood(NOON), happy(NOON)).vad.valence));
});

test('surprise and curiosity change the face for a moment but not the mood', () => {
    let mood = createMood(NOON);
    for (let i = 0; i < 4; i += 1) mood = applyMoodEvent(mood, { emotion: 'curious', intensity: 0.9, source: 'tag', at: NOON });
    mood = applyMoodEvent(mood, { emotion: 'surprised', intensity: 0.9, source: 'tag', at: NOON });
    assert.deepEqual(moodEmotion(mood), { emotion: 'neutral', intensity: 0 });
    // 开心了一阵又听到坏消息：剩下的只是有点激动，显示成平静而不是兴奋或惊讶
    assert.deepEqual(moodEmotion({ vad: { valence: 0.07, arousal: 0.24, dominance: 0 } }), { emotion: 'neutral', intensity: 0 });
});

test('a different emotion moves the mood over instead of flipping it at once', () => {
    let mood = createMood(NOON);
    for (let i = 0; i < 4; i += 1) mood = applyMoodEvent(mood, happy(NOON + i));
    mood = applyMoodEvent(mood, { emotion: 'sad', intensity: 0.8, source: 'tag', at: NOON + 10 });
    assert.notEqual(moodEmotion(mood).emotion, 'sad');
    for (let i = 0; i < 6; i += 1) mood = applyMoodEvent(mood, { emotion: 'sad', intensity: 0.8, source: 'tag', at: NOON + 20 + i });
    assert.equal(moodEmotion(mood).emotion, 'sad');
});

test('the mood eases back over hours and mostly resets on a new day', () => {
    let mood = createMood(NOON - 6 * HOUR);
    for (let i = 0; i < 4; i += 1) mood = applyMoodEvent(mood, happy(NOON - 6 * HOUR));
    const start = Math.abs(mood.vad.valence);
    const later = decayMood(mood, NOON - 6 * HOUR + MOOD_DEFAULTS.halfLifeMs);
    assert.ok(Math.abs(Math.abs(later.vad.valence) - start / 2) < 1e-9, 'one half-life halves it');
    assert.equal(moodSnapshot(mood, NOON + 4 * HOUR).emotion, 'neutral', 'by evening it has settled');
    // 半夜十一点很开心，第二天早上已经回到平静
    let night = createMood(NOON + 11 * HOUR);
    for (let i = 0; i < 5; i += 1) night = applyMoodEvent(night, happy(NOON + 11 * HOUR));
    assert.equal(moodEmotion(night).emotion, 'happy');
    assert.equal(moodSnapshot(night, NOON + 20 * HOUR).emotion, 'neutral');
    // 时间倒退（改了系统时间）心情不变，但从现在重新计时
    const rewound = decayMood(night, NOON);
    assert.deepEqual(rewound.vad, night.vad);
    assert.equal(rewound.updatedAt, NOON);
    assert.ok(norm(decayMood(rewound, NOON + 4 * HOUR).vad) < norm(night.vad) * 0.6, 'and keeps easing after the clock went back');
});

test('chatting on past midnight is not a new day; a night of sleep is', () => {
    let mood = createMood(NOON + 11.5 * HOUR);
    for (let i = 0; i < 5; i += 1) mood = applyMoodEvent(mood, happy(NOON + 11.5 * HOUR));
    const start = norm(mood.vad);
    const halfHour = Math.pow(0.5, 0.5 * HOUR / MOOD_DEFAULTS.halfLifeMs);
    assert.ok(Math.abs(norm(decayMood(mood, NOON + 12 * HOUR).vad) - start * halfHour) < 1e-9, 'half an hour across midnight is only the half-life');
    const hours = 9;
    const slept = norm(decayMood(mood, NOON + (11.5 + hours) * HOUR).vad);
    assert.ok(Math.abs(slept - start * Math.pow(0.5, hours * HOUR / MOOD_DEFAULTS.halfLifeMs) * MOOD_DEFAULTS.newDayKeep) < 1e-9);
});

test('what the user says reaches the mood the way a companion would feel it', () => {
    assert.equal(userMessageMoodEvent('今天好难过，考试没过')?.emotion, 'concerned');
    assert.equal(userMessageMoodEvent('哈哈太好了，成功了！')?.emotion, 'happy');
    assert.equal(userMessageMoodEvent('最喜欢你了')?.emotion, 'shy');
    assert.equal(userMessageMoodEvent('帮我看看这段代码'), null);
    assert.equal(userMessageMoodEvent(''), null);
    // 「还没好」不往哪边推，「好多了」「好一点了」拉回平静
    assert.equal(userMessageMoodEvent('还是没好，心里很难过'), null);
    assert.equal(userMessageMoodEvent('谢谢你，我已经好多了')?.settle, 0.6);
    assert.equal(userMessageMoodEvent('好一点了')?.settle, 0.35);
    let mood = createMood(NOON);
    for (let i = 0; i < 4; i += 1) mood = applyMoodEvent(mood, { emotion: 'concerned', intensity: 0.9, source: 'user', at: NOON });
    assert.equal(moodEmotion(mood).emotion, 'concerned');
    mood = applyMoodEvent(mood, userMessageMoodEvent('我没事了', NOON));
    assert.ok(moodEmotion(mood).intensity < 0.3);
});

test('only the user\'s own words count: not attachments, code, quotes, long pastes or remarks about programs', () => {
    const log = 'ERROR 气死了 failed，难过，sad sad sad 😭😭';
    assert.equal(userMessageMoodEvent(`帮我看看这个日志\n\n[附加文件: C:/logs/app.log]\n${log}\n[/附加文件结束: app.log]`), null);
    assert.equal(userMessageMoodEvent('```js\nconsole.log("太好了哈哈哈！！")\n```\n这段为什么不输出'), null);
    assert.equal(userMessageMoodEvent('报错是 `难过.js not found`'), null);
    assert.equal(userMessageMoodEvent('> 他说：我好难过，气死了\n这句话怎么翻译'), null);
    assert.equal(userMessageMoodEvent(`请总结这篇文章：${'今天天气很好，大家都很开心。'.repeat(60)}`), null);
    // 引用之外自己说的话照样算
    assert.equal(userMessageMoodEvent('> 考试成绩出来了\n呜呜我好难过')?.emotion, 'concerned');
    assert.equal(userMessageMoodEvent('我不开心')?.emotion, 'concerned');
    // 「好多了」「恢复了」说的是程序时不算心情好转
    assert.equal(userMessageMoodEvent('新版本好多了，加载快了很多'), null);
    assert.equal(userMessageMoodEvent('服务恢复了'), null);
    assert.equal(userMessageMoodEvent('我觉得这个方案好多了'), null);
    assert.equal(userMessageMoodEvent('嗯，好多了！')?.settle, 0.6);
    assert.equal(userMessageMoodEvent('现在感觉稍微好一点了')?.settle, 0.35);
    assert.equal(userMessageMoodEvent('I feel better now')?.settle, 0.6);
});

test('a reply counts by its last tag, skips code, thoughts and tool calls, and falls back to rules', () => {
    assert.deepEqual(
        replyMoodEvent('<!--emo:sad 0.6-->唉。<!--emo:happy 0.9-->不过最后成功了！', 1),
        { emotion: 'happy', intensity: 0.9, source: 'tag', at: 1 },
    );
    assert.equal(replyMoodEvent('```html\n<!--emo:angry-->\n```\n好的', 1), null);
    assert.equal(replyMoodEvent('<think>好难过</think>结果在这里。', 1), null);
    assert.equal(replyMoodEvent('<<<[TOOL_REQUEST]>>>生气<<<[END_TOOL_REQUEST]>>>好的', 1), null);
    assert.equal(replyMoodEvent('太好了，修好了！嘿嘿', 1)?.source, 'rule');
});

test('stored moods are cleaned up when read back', () => {
    const fresh = normalizeMood(null, NOON);
    assert.deepEqual(fresh.vad, { valence: 0, arousal: 0, dominance: 0 });
    const odd = normalizeMood({ vad: { valence: 9, arousal: 'x', dominance: -3 }, updatedAt: NOON + HOUR, last: { emotion: 'nope' } }, NOON);
    assert.deepEqual(odd.vad, { valence: 1, arousal: 0, dominance: -1 });
    assert.equal(odd.updatedAt, NOON, 'a timestamp from the future is clamped to now');
    assert.equal(odd.last, null);
});

test('the director rests on the mood, and settles back to it instead of neutral after a reply', () => {
    const { clock, director, last } = createDirector({ settleHoldMs: 10_000 });
    director.setBaseline({ emotion: 'calm', intensity: 0.4 });
    assert.equal(last().emotion, 'calm');
    assert.equal(last().source, 'mood');
    director.append('m1', '<!--emo:excited 0.9-->好耶！');
    director.end('m1');
    clock.advance(2000);
    assert.equal(last().emotion, 'excited');
    clock.advance(10_000);
    assert.equal(last().emotion, 'calm', 'back to the mood, not to neutral');
    assert.equal(director.baseline.emotion, 'calm');
});

test('a new mood waits for the reply emotion to finish, and a reset clears it', () => {
    const { clock, director, last } = createDirector({ settleHoldMs: 10_000 });
    director.append('m1', '<!--emo:sad 0.8-->对不起。');
    director.end('m1');
    clock.advance(2000);
    director.setBaseline({ emotion: 'happy', intensity: 0.5 });
    assert.equal(last().emotion, 'sad', 'the reply emotion still holds');
    clock.advance(10_000);
    assert.equal(last().emotion, 'happy');
    // 显示着底色时换底色立刻跟上；null 回到 neutral
    clock.advance(2000);
    director.setBaseline(null);
    assert.equal(last().emotion, 'neutral');
    director.setBaseline({ emotion: 'tired', intensity: 0.5 });
    clock.advance(2000);
    assert.equal(last().emotion, 'tired');
    director.reset();
    assert.equal(last().emotion, 'neutral');
    assert.equal(director.baseline.emotion, 'neutral');
});

test('a reply whose emotion is the mood itself has nothing to settle', () => {
    const { clock, director, frames } = createDirector({ settleHoldMs: 10_000 });
    director.setBaseline({ emotion: 'happy', intensity: 0.5 });
    director.append('m1', '<!--emo:happy 0.8-->嗯嗯！');
    director.end('m1');
    clock.advance(2000);
    const count = frames.length;
    clock.advance(20_000);
    assert.equal(frames.length, count);
    assert.equal(clock.pending, 0);
});

test('a tap reaction also settles back to the mood', () => {
    const { clock, director, last } = createDirector({ settleHoldMs: 10_000 });
    director.setBaseline({ emotion: 'calm', intensity: 0.4 });
    clock.advance(2000);
    director.nudge({ emotion: 'happy', source: 'tap' });
    assert.equal(last().emotion, 'happy');
    clock.advance(10_000);
    assert.equal(last().emotion, 'calm');
});

async function createStoreFixture(options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mood-'));
    await fs.mkdir(path.join(root, 'Nova'));
    const clock = createClock(NOON);
    const sent = [];
    const store = createAgentMoodStore({
        agentDir: root,
        mood: moodState,
        broadcast: payload => sent.push({ payload }),
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        writeDelayMs: 0,
        ...options,
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    return { root, clock, sent, store, settle };
}

// 写盘是计时器触发后异步完成的；Windows 上可能比固定等待慢，所以等到文件出现为止
async function readWhenWritten(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return await fs.readFile(file, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
}

const chunk = text => ({ choices: [{ delta: { content: text } }] });

test('the main-process store reads the user message and the finished reply, then saves and broadcasts', async () => {
    const { root, clock, sent, store, settle } = await createStoreFixture();
    const context = { agentId: 'Nova', topicId: 't1' };
    const call = store.observe({ context, messageId: 'm1', messages: [{ role: 'system', content: 'x' }, { role: 'user', content: [{ type: 'text', text: '哈哈太好了，成功了！' }] }] });
    call.chunk(chunk('<!--emo:excited 0.9-->'));
    call.chunk(chunk('恭喜恭喜！'));
    call.finish();
    await settle();
    assert.deepEqual(sent.map(item => item.payload.last.source), ['user', 'tag']);
    assert.equal(sent[1].payload.agentId, 'Nova');
    clock.advance(0);
    const saved = JSON.parse(await readWhenWritten(path.join(root, 'Nova', 'mood.json')));
    assert.equal(saved.last.emotion, 'excited');
    assert.ok(saved.vad.valence > 0);
    const snapshot = await store.get('Nova');
    assert.equal(snapshot.agentId, 'Nova');
    assert.ok(['happy', 'excited'].includes(snapshot.emotion));
    // 下次启动从文件接着来
    const { store: reopened } = await createStoreFixture({ agentDir: root });
    assert.equal((await reopened.get('Nova')).last.emotion, 'excited');
});

test('regenerating, aborted or failed replies, group turns and bad ids do not move the mood', async () => {
    const { root, sent, store, settle } = await createStoreFixture();
    const messages = [{ role: 'user', content: '我好难过' }];
    store.observe({ context: { agentId: 'Nova' }, messages, messageId: 'a' }).finish({ aborted: true });
    store.observe({ context: { agentId: 'Nova' }, messages, messageId: 'b' }).finish({ error: { message: 'x' } });
    await settle();
    assert.equal(sent.length, 1, 'the same user message sent again counts once; failed replies not at all');
    const reply = store.observe({ context: { agentId: 'Nova' }, messages: [], messageId: 'c' });
    reply.chunk(chunk('<!--emo:concerned-->抱抱你'));
    reply.finish();
    reply.finish();
    await settle();
    assert.equal(sent.length, 2);
    assert.equal(store.observe({ context: { agentId: 'Nova', isGroupMessage: true }, messages }).chunk, store.observe({}).chunk);
    assert.equal(await store.get('../etc'), null);
    // 非流式回复
    store.observe({ context: { agentId: 'Nova' }, messages: [], messageId: 'd' })
        .finish({ response: { choices: [{ message: { content: '<!--emo:happy-->好耶' } }] } });
    await settle();
    assert.equal(sent.at(-1).payload.last.emotion, 'happy');
    await fs.rm(root, { recursive: true, force: true });
});

test('regenerating a reply replaces what the old reply did instead of pushing twice; continuing adds on', async () => {
    const { sent, store, settle } = await createStoreFixture();
    const context = { agentId: 'Nova' };
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: '讲个故事吧' }];
    const reply = (id, text, history = messages) => {
        const call = store.observe({ context, messages: history, messageId: id });
        call.chunk(chunk(text));
        call.finish();
    };
    reply('r1', '<!--emo:sad 1-->这是一个悲伤的故事');
    await settle();
    const once = (await store.get('Nova')).vad;
    reply('r2', '<!--emo:sad 1-->这是一个悲伤的故事');
    reply('r3', '<!--emo:sad 1-->这是一个悲伤的故事');
    await settle();
    assert.deepEqual((await store.get('Nova')).vad, once, 'three tries at the same message leave the mood of one');
    // 重新生成成没有情绪的回复：旧回复的影响也撤掉
    reply('r4', '从前有座山。');
    await settle();
    assert.deepEqual((await store.get('Nova')).vad, { valence: 0, arousal: 0, dominance: 0 });
    assert.equal(sent.at(-1).payload.emotion, 'neutral');
    // 续写：最后一条是助手的，同一句用户话不重复算，但续出来的回复照常算
    reply('r5', '<!--emo:happy 1-->后来大家都很开心', [...messages, { role: 'assistant', content: '从前有座山。' }]);
    await settle();
    assert.equal(sent.at(-1).payload.last.emotion, 'happy');
    assert.ok((await store.get('Nova')).vad.valence > 0);
});

test('writes for one assistant never overlap, leave no temp files, and seq orders the broadcasts', async () => {
    const { root, clock, sent, store, settle } = await createStoreFixture();
    const writes = [];
    for (let i = 0; i < 20; i += 1) {
        writes.push(store.record('Nova', { emotion: i % 2 ? 'happy' : 'sad', intensity: 0.8, source: 'tag' }));
        clock.advance(0);
    }
    await Promise.all(writes);
    await store.flush();
    const files = await fs.readdir(path.join(root, 'Nova'));
    assert.deepEqual(files, ['mood.json']);
    const saved = JSON.parse(await fs.readFile(path.join(root, 'Nova', 'mood.json'), 'utf8'));
    assert.deepEqual(saved.vad, (await store.get('Nova')).vad);
    const seqs = sent.map(item => item.payload.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    assert.ok((await store.get('Nova')).seq >= seqs.at(-1));
    await settle();
    await fs.rm(root, { recursive: true, force: true });
});

test('a broken or empty mood file starts calm and is replaced by the next write', async () => {
    const { root, clock, store, settle } = await createStoreFixture();
    await fs.writeFile(path.join(root, 'Nova', 'mood.json'), '{"version":1,"vad":{"valence":0.5');
    assert.equal((await store.get('Nova')).emotion, 'neutral');
    await store.record('Nova', { emotion: 'happy', intensity: 0.9, source: 'tag' });
    clock.advance(0);
    await store.flush();
    await settle();
    const saved = JSON.parse(await fs.readFile(path.join(root, 'Nova', 'mood.json'), 'utf8'));
    assert.ok(saved.vad.valence > 0);
    await fs.rm(root, { recursive: true, force: true });
});

test('forgetting an assistant before deleting it drops pending writes and later events', async () => {
    const { root, clock, sent, store, settle } = await createStoreFixture({ writeDelayMs: 1000 });
    await store.record('Nova', { emotion: 'happy', intensity: 0.9, source: 'tag' });
    const call = store.observe({ context: { agentId: 'Nova' }, messages: [{ role: 'user', content: '你好' }], messageId: 'late' });
    await store.forget('Nova');
    await fs.rm(path.join(root, 'Nova'), { recursive: true, force: true });
    const count = sent.length;
    call.chunk(chunk('<!--emo:sad-->'));
    call.finish();
    clock.advance(5000);
    await settle();
    await assert.rejects(fs.stat(path.join(root, 'Nova')));
    assert.equal(sent.length, count, 'a reply that ends after the delete is not recorded');
    store.dispose();
});

test('a deleted assistant is not brought back by a late mood write', async () => {
    const { root, clock, store, settle } = await createStoreFixture({ writeDelayMs: 1000 });
    store.observe({ context: { agentId: 'Nova' }, messages: [{ role: 'user', content: '太好了！哈哈' }] });
    await settle();
    await fs.rm(path.join(root, 'Nova'), { recursive: true, force: true });
    clock.advance(1000);
    await settle();
    await assert.rejects(fs.stat(path.join(root, 'Nova')));
});

test('the mood is re-announced when it has faded enough to look different', async () => {
    const { clock, sent, store, settle } = await createStoreFixture({ recheckMs: HOUR });
    for (let i = 0; i < 4; i += 1) await store.record('Nova', { emotion: 'happy', intensity: 0.9, source: 'tag' });
    await settle();
    const count = sent.length;
    assert.equal(sent.at(-1).payload.emotion, 'happy');
    clock.advance(12 * HOUR);
    assert.ok(sent.length > count);
    assert.equal(sent.at(-1).payload.emotion, 'neutral');
    store.dispose();
});

test('the chat handler hands one call to both the trajectory recorder and the mood', () => {
    const seen = [];
    const call = teeCall(
        { id: 'call_1', chunk: value => seen.push(['a', value]), finish: value => seen.push(['a-end', value]) },
        { chunk: value => seen.push(['b', value]), finish: value => seen.push(['b-end', value]) },
    );
    call.chunk(1);
    call.finish({ aborted: true });
    assert.equal(call.id, 'call_1');
    assert.deepEqual(seen, [['a', 1], ['b', 1], ['a-end', { aborted: true }], ['b-end', { aborted: true }]]);
});
